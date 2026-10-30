/**
 * 调试面 · 语言面读数（1029 批）的判据。
 *
 * 面上的事：
 * 1. **纯函数**（`mapSupportedActions` / `slimHoverText` / `mapSuggestRows`）：
 *    读数进 JSON 之前唯一的一道整形，边界（缺 alias / 缺 enabled / 缺 label / 缺 detail）
 *    必须定死——否则同一份面板在两次读数里形态不同，脚本无从断言；
 * 2. **源形状守门**（读源码字符串，形态照 `debug-surface.test.ts` 先例）：PITFALLS 247 的
 *    手工绕法（`import('/src/monaco/entry.ts')` + DOM 猜）必须真的被收编进
 *    `install-debug.ts`，且每条腿都在 `try/catch` + 安全返回下——读数器抛错就是调试面自己
 *    把调试会话打断。
 *
 * 这一层刻意不碰 DOM / Monaco 运行时：真实链路由 `tools/debug-web-smoke.mjs` 在浏览器里对拍。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mapSuggestRows,
  mapSupportedActions,
  slimHoverText,
  type SuggestRowLike,
  type SupportedActionLike,
} from '../src/debug/install-debug';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/* ----------------------------- 动作表映射 ----------------------------- */

describe('语言面 · mapSupportedActions（动作表读数）', () => {
  it('完整动作照原样出：id / label / alias / enabled 齐全', () => {
    const actions: SupportedActionLike[] = [
      { id: 'editor.action.formatDocument', label: '格式化文档', alias: 'Format Document', isSupported: () => true },
    ];
    expect(mapSupportedActions(actions)).toEqual([
      { id: 'editor.action.formatDocument', label: '格式化文档', alias: 'Format Document', enabled: true },
    ]);
  });

  it('缺 alias ⇒ 结果里**不挂 alias 键**（空值不挂键，JSON 形态稳定）', () => {
    const [only] = mapSupportedActions([{ id: 'x.y', label: 'Y' }]);
    expect(only).toEqual({ id: 'x.y', label: 'Y', enabled: true });
    expect(only && 'alias' in only).toBe(false);
  });

  it('缺 isSupported / 抛错 ⇒ enabled 当 true（表里存在即视为可用，不谎报不可用）', () => {
    expect(mapSupportedActions([{ id: 'a', label: 'A' }])[0]?.enabled).toBe(true);
    expect(
      mapSupportedActions([
        {
          id: 'b',
          label: 'B',
          isSupported: () => {
            throw new Error('贡献点已销毁');
          },
        },
      ])[0]?.enabled,
    ).toBe(true);
    expect(mapSupportedActions([{ id: 'c', label: 'C', isSupported: () => false }])[0]?.enabled).toBe(false);
  });

  it('label 缺 ⇒ 退 alias ⇒ 退 id；id 空 / 非对象一律丢弃', () => {
    expect(mapSupportedActions([{ id: 'only.id' }])).toEqual([{ id: 'only.id', label: 'only.id', enabled: true }]);
    expect(mapSupportedActions([{ id: 'with.alias', alias: 'Alias Only' }])).toEqual([
      { id: 'with.alias', label: 'Alias Only', alias: 'Alias Only', enabled: true },
    ]);
    expect(mapSupportedActions([{ id: '', label: '空 id' }, { id: '   ' }])).toEqual([]);
    expect(mapSupportedActions([null as unknown as SupportedActionLike, 42 as unknown as SupportedActionLike])).toEqual([]);
  });

  it('空白与换行在 id / label 上归一（读数一律单行）', () => {
    expect(mapSupportedActions([{ id: ' a.b ', label: '多行\n标签' }])[0]).toEqual({
      id: 'a.b',
      label: '多行 标签',
      enabled: true,
    });
  });
});

/* ----------------------------- 悬停文本裁剪 ----------------------------- */

describe('语言面 · slimHoverText（悬停正文）', () => {
  it('多行保留、空行丢弃、行内空白归一（含制表与不换行空格）', () => {
    const { text, rows } = slimHoverText('  第一行\t有制表\u00a0空格  \n\n\n第二行   \n   \n第三行');
    expect(rows).toEqual(['第一行 有制表 空格', '第二行', '第三行']);
    expect(text).toBe('第一行 有制表 空格\n第二行\n第三行');
  });

  it('单行超 300 字符截断并加省略号；总长超 2000 再兜一层', () => {
    const longLine = 'x'.repeat(400);
    const { rows, text } = slimHoverText(longLine);
    expect(rows[0]?.endsWith('…')).toBe(true);
    expect(rows[0]?.length).toBe(301);
    expect(text.length).toBeLessThanOrEqual(2001);

    const many = Array.from({ length: 40 }, () => 'y'.repeat(299)).join('\n');
    expect(slimHoverText(many).text.endsWith('…')).toBe(true);
  });

  it('最多 40 行（面板里塞整篇文档也不原样搬）', () => {
    const source = Array.from({ length: 100 }, (_v, i) => `第 ${i + 1} 行`).join('\n');
    expect(slimHoverText(source).rows).toHaveLength(40);
  });

  it('非字符串入参 ⇒ 空读数（eval 里手敲什么都别抛）', () => {
    expect(slimHoverText(null as unknown as string)).toEqual({ text: '', rows: [] });
    expect(slimHoverText(undefined as unknown as string)).toEqual({ text: '', rows: [] });
    expect(slimHoverText('   \n\t\n ')).toEqual({ text: '', rows: [] });
  });
});

/* ----------------------------- 补全行映射 ----------------------------- */

describe('语言面 · mapSuggestRows（补全候选）', () => {
  it('label-name 优先、details-label 作 detail、class 里的 kind-* 作 kind', () => {
    const rows: SuggestRowLike[] = [
      { labelName: 'KOJO_DEFINE', detailsLabel: '口上常量', className: 'monaco-list-row kind-constant' },
    ];
    expect(mapSuggestRows(rows)).toEqual([{ label: 'KOJO_DEFINE', detail: '口上常量', kind: 'constant' }]);
  });

  it('缺 label-name ⇒ 回退 aria-label（两者都缺 ⇒ 丢弃，不让 count 虚高）', () => {
    expect(mapSuggestRows([{ ariaLabel: 'aria 来的名字', detailsLabel: '' }])).toEqual([
      { label: 'aria 来的名字', detail: '', kind: 'aria 来的名字' },
    ]);
    expect(mapSuggestRows([{ labelName: '   ', ariaLabel: '' }, {}])).toEqual([]);
  });

  it('detail 缺失 ⇒ 空串（不是 null：调用方不必判两种空值）', () => {
    const [only] = mapSuggestRows([{ labelName: 'CALL', ariaLabel: 'CALL Variable' }]);
    expect(only?.detail).toBe('');
    // 没有 kind-* class 时 kind 交回 aria-label 原文，不编造种类
    expect(only?.kind).toBe('CALL Variable');
  });

  it('空白 / 换行归一；非对象行跳过（DOM 读出来的脏行不许炸读数）', () => {
    expect(mapSuggestRows([{ labelName: ' 多\n行 ', detailsLabel: '\t细节  ' }])[0]).toEqual({
      label: '多 行',
      detail: '细节',
      kind: '',
    });
    expect(mapSuggestRows([null as unknown as SuggestRowLike])).toEqual([]);
  });
});

/* ----------------------------- 源形状守门 ----------------------------- */

describe('语言面 · 源形状守门（绕法真的被收编进 API，且不抛）', () => {
  const source = read('packages/app/src/debug/install-debug.ts');

  /** 从某个锚点切一段源码：断言"这条腿在哪、里面有没有 catch / 安全返回" */
  const sliceFrom = (anchor: string, length = 2600): string => {
    const at = source.indexOf(anchor);
    expect(at, `install-debug.ts 里找不到锚点：${anchor}`).toBeGreaterThanOrEqual(0);
    return source.slice(at, at + length);
  };

  it('四条语言面腿都在：hoverAt / suggestAt / foldingRanges / formatDocument 动作 id', () => {
    expect(source).toContain('hoverAt(line, column, opts)');
    expect(source).toContain('suggestAt(line, column, opts)');
    expect(source).toContain('foldingRanges()');
    expect(source).toContain("'editor.action.formatDocument'");
    // 动作表读数与词法读数同样在场
    expect(source).toContain('getSupportedActions()');
    expect(source).toContain('monaco.editor.tokenize(');
  });

  it('hoverAt：走真 hover provider 链、轮询 .monaco-hover，失败/超时都回 null', () => {
    const body = sliceFrom('hoverAt(line, column, opts)');
    expect(body).toContain("getAction('editor.action.showHover')");
    expect(body).toContain('waitForHoverNode(');
    expect(body).toContain('return null');
    expect(body).toContain('catch');
    expect(body).toContain('finally');
    // 收起动作在 finally 里（读数完必须收面板，否则盖住下一次点击）
    expect(body).toContain('hideHoverNow(ed)');
    // 选择器住在取数腿里（面板容器类名与"可见性"判据同一处）
    expect(sliceFrom('function visibleHoverNode(')).toContain("'.monaco-hover'");
  });

  it('suggestAt：triggerSuggest → 读 .suggest-widget.visible 行 → hideSuggestWidget，空读数不抛', () => {
    const body = sliceFrom('suggestAt(line, column, opts)');
    expect(body).toContain("'editor.action.triggerSuggest'");
    expect(body).toContain('waitForSuggestRows(');
    expect(body).toContain("'hideSuggestWidget'");
    expect(body).toContain('items: []');
    expect(body).toContain('catch');
    expect(sliceFrom('function visibleSuggestRows(')).toContain("'.suggest-widget.visible'");
  });

  it('format：前后长度都取 getValueLength，且两条失败路都回 ok=false', () => {
    const body = sliceFrom('async format()');
    expect(body).toContain('getValueLength()');
    expect(body).toContain('changed: after !== before');
    expect(body).toContain('catch');
    expect(body).toContain('return finish(false)');
    expect(body).toContain('before: 0, after: 0, elapsedMs: 0');
  });

  it('setSelection / revealLine / tokens：无焦点编辑器时回 false / []，不抛', () => {
    expect(sliceFrom('setSelection(startLine, startColumn, endLine, endColumn)')).toContain('return false');
    expect(sliceFrom('revealLine(line, reveal)')).toContain('return false');
    const tokensBody = sliceFrom('async tokens(lineFrom, lineTo)');
    expect(tokensBody).toContain('return []');
    expect(tokensBody).toContain('catch');
  });

  it('foldingRanges：只在 try 里摸贡献点，探不到（含 Promise 形态）诚实回 null', () => {
    const body = sliceFrom('function foldingRangesOf(');
    expect(body).toContain("getContribution('editor.contrib.folding')");
    expect(body).toContain('catch');
    expect(body).toContain('return null');
    // Promise 形态不许被当成"有数据"（同步 API 不能等）
    expect(body).toContain("typeof (model as { then?: unknown }).then === 'function'");
  });

  it('公开接口真的声明了这些读数（KojoDebugApi.editor 的形态是契约面）', () => {
    const apiSlice = sliceFrom('export interface KojoDebugApi {', 3200);
    for (const member of [
      'actions(): DebugEditorAction[]',
      'hoverAt(line: number, column: number',
      'suggestAt(',
      'format(): Promise<DebugFormatReading>',
      'setSelection(startLine: number',
      'revealLine(line: number',
      'foldingRanges(): DebugFoldingRange[] | null',
      'tokens(lineFrom: number, lineTo: number)',
    ]) {
      expect(apiSlice, `KojoDebugApi.editor 缺 ${member}`).toContain(member);
    }
  });
});
