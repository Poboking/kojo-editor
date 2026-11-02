/**
 * 口上 XML 面板 · 命中列表（NavHitsList）窗口化 DOM 行数上界证据（2026-11-02 规模批 KW-9）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖；断言对象是 ui-kojo-xml
 * 插件的模块级 `NavHitsList`（相对导入其 src——照 `panel-window-convention-report.test.ts` 口径）。
 *
 * 真盘参照读数（eraFL `ERB/口上`，2026-11-02 实扫）：293 份 XML / 61,562 条口上 /
 * 单文件最大 2,445 条。窗口化前这里没有上界：搜索「全展开」一次挂六万行、点开一个
 * 大文件一次挂两千四百行。口径：初开 ≤ NAV_WINDOW_INITIAL / 触底每步 +STEP /
 * 窗口 ≥ total 哨兵消失。**无计时硬断言**（规模钉只数 DOM 行数，读数写注释）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KojoXmlCommand, KojoXmlFile, KojoXmlIndex } from '@kojo/plugin-api';
import { NavHitsList } from '../../plugins/ui-kojo-xml/src/panel';
import { buildPanelTree, type PanelTree } from '../../plugins/ui-kojo-xml/src/panel-tree';
import {
  flattenPanelRows,
  NAV_WINDOW_INITIAL,
  NAV_WINDOW_STEP,
  type PanelRow,
} from '../../plugins/ui-kojo-xml/src/panel-rows';

/* ------------------------------ 夹具 ------------------------------ */

const noop = (): void => undefined;
const count = (markup: string, sub: string): number => markup.split(sub).length - 1;

function cmd(com: string, text: string, line: number, index: number): KojoXmlCommand {
  return {
    index,
    span: { start: { line, column: 3 }, end: { line: line + 2, column: 12 } },
    contentSpan: null,
    attrs: { com, name: `条目${com}`, kojoPlace: 'TOP' },
    text,
  };
}

/** n 条口上堆在同一个角色的同一份文件里（真盘最大单文件 2,445 条，这里往大了造） */
function bigTree(n: number): PanelTree {
  const commands = Array.from({ length: n }, (_, i) => cmd(String(i + 1), `台词 ${i + 1}`, i + 2, i));
  const f: KojoXmlFile = {
    path: 'root/1001_a/KOJO_K1001_COM.xml',
    format: 'data',
    encoding: 'utf-8',
    eol: 'crlf',
    charaNo: 1001,
    commands,
    diagnostics: [],
  };
  const index: KojoXmlIndex = {
    files: [f],
    commandCount: n,
    byChara: new Map([[1001, [f]]]),
    byCom: new Map(),
    diagnostics: [],
    scannedAt: 1,
  };
  return buildPanelTree(index, new Map([[1001, '阿莉丝']]));
}

/** 搜索态摊平（全展开）——这正是窗口化前一次挂满的那条路径 */
function searchRows(tree: PanelTree): PanelRow[] {
  return flattenPanelRows(tree, { searching: true, openCharas: new Set(), openFiles: new Set(), previewId: null });
}

function render(
  rows: readonly PanelRow[],
  limit: number | undefined,
  options: { mustInclude?: number; previewId?: string | null } = {},
): string {
  return renderToStaticMarkup(
    h(NavHitsList, {
      rows,
      limit,
      ...(options.mustInclude === undefined ? {} : { mustInclude: options.mustInclude }),
      previewId: options.previewId ?? null,
      onToggleChara: noop,
      onToggleFile: noop,
      onReveal: noop,
      onPreviewToggle: noop,
      renderPreview: (row) => h('span', { className: 'stub-preview' }, `PREVIEW:${row.command.name}`),
      onGrow: noop,
    }),
  );
}

/* ------------------------------ 判据 ------------------------------ */

describe('NavHitsList · 命中列表窗口的 DOM 行数上界', () => {
  it('5,000 条（搜索全展开）：初开只挂 INITIAL 行 + 一个哨兵，其余按步长可达', () => {
    const rows = searchRows(bigTree(5_000));
    // 摊平后总行数 = 1 角色行 + 1 文件行 + 5,000 条目行
    expect(rows.length).toBe(5_002);
    const html = render(rows, undefined);
    expect(count(html, 'nav-hit-btn')).toBe(NAV_WINDOW_INITIAL);
    expect(count(html, 'nav-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${5_002 - NAV_WINDOW_INITIAL}）`);
    // 窗口外的条目没有进 DOM（"实际建出的行数 ≤ 初值"——判据只数 DOM，不数内存）
    expect(html).not.toContain('条目121');
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 行；到 total 后哨兵消失', () => {
    const rows = searchRows(bigTree(5_000));
    const htmlStep = render(rows, NAV_WINDOW_INITIAL + NAV_WINDOW_STEP);
    expect(count(htmlStep, 'nav-hit-btn')).toBe(NAV_WINDOW_INITIAL + NAV_WINDOW_STEP);
    expect(htmlStep).toContain(`显示更多（还剩 ${5_002 - NAV_WINDOW_INITIAL - NAV_WINDOW_STEP}）`);

    const htmlFull = render(rows, 5_002);
    expect(count(htmlFull, 'nav-hit-btn')).toBe(5_002);
    expect(count(htmlFull, 'nav-more-btn')).toBe(0);
  });

  it('mustInclude 定位：点名第 2,445 行（真盘最大单文件的量级）被折进窗口，不是"跳过去但看不见"', () => {
    const rows = searchRows(bigTree(5_000));
    const locate = 2_445;
    expect(render(rows, undefined)).not.toContain('条目2443');
    const html = render(rows, undefined, { mustInclude: locate });
    expect(count(html, 'nav-hit-btn')).toBe(locate);
    // 第 locate 行（rows[locate-1]，即第 2,443 条 command）恰在窗口末行；再下一行不在
    expect(html).toContain('条目2443');
    expect(html).not.toContain('条目2444');
  });

  it('行 DOM 形态不回归：角色钮带徽标计数、文件行缩进 14、条目行缩进 28 + 预览钮', () => {
    const rows = searchRows(bigTree(3));
    const html = render(rows, undefined);
    expect(count(html, 'nav-hit-btn')).toBe(5); // 1 角色 + 1 文件 + 3 条目
    expect(html).toContain('▾ 阿莉丝'); // 搜索态 = 展开
    expect(html).toContain('1 份 / 3 条');
    expect(html).toContain('padding-left:14px');
    expect(html).toContain('padding-left:28px');
    expect(count(html, 'nav-preview-btn')).toBe(3);
    expect(html).toContain('TOP'); // 副标题（kojoPlace）原样上屏
    expect(count(html, 'nav-more-btn')).toBe(0);
  });

  it('预览行为渲染闭包留槽：renderPreview 的节点插在命中的那条下面，按钮翻成「收起」', () => {
    const tree = bigTree(3);
    const previewId = 'root/1001_a/KOJO_K1001_COM.xml:2:3:0'; // 第 1 条 command 的稳定 key
    const rows = flattenPanelRows(tree, {
      searching: true,
      openCharas: new Set(),
      openFiles: new Set(),
      previewId,
    });
    expect(rows.length).toBe(2 + 3 + 1); // 多出的一行 preview
    const html = render(rows, undefined, { previewId });
    expect(html).toContain('stub-preview');
    expect(html).toContain('PREVIEW:条目1');
    expect(html).toContain('收起');
    expect(html).toContain('预览台词与命中条件'); // 其余两条仍是「预览」态悬停文案
  });
});
