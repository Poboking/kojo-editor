/**
 * 视觉批十一 L12-overlays 立论钉。
 *
 * 环境注：本文件**待在默认 node 环境**——它在模块顶层 `readFileSync(fileURLToPath(...))`
 * 读源文件，而 happy-dom 下 `import.meta.url` 是 http URL，会当场「The URL must be of
 * scheme file」把整份打成收集失败（PITFALLS 183）。`renderToStaticMarkup` 是服务端渲染，
 * 不需要 DOM，声明 happy-dom 纯属多余。
 *
 * 本路的论点全部是**呈现层事实**，每条都配一把尺（源文本 + 真实渲染各占一半）：
 * ① 预览编辑器井不许零高塌陷（`.qfp-editor` 必须有可解析的高度声明）；
 * ② 浮层档宽收回宿主三档（560/920/:has(.ov-xl) 1160），宿主类不许再自写 `min(1180px…)`
 *    这类越档字面；注册侧五家全部带 `size`；
 * ③ `.kd-banner` / `.kd-error` 零 hex 字面（三主题翻色的前提）；
 * ④ 浮层有退场动画（`overlay-out` keyframes + `.ov-exiting` 吃 `--dur-2`，
 *    类名常量由 `overlay-chrome` 供给、壳层接线单在批次回执）；
 * ⑤ 五家确实走 `overlayFrame` 统一外框、diff/预览两家确实消费 `overlayEditorAppearance`、
 *    ✕ 用内置 `close` SVG 而不是字符；
 * ⑥ 换壳不许掉批次十的菜单面——`data-context-surface` 与 `data-ch-*` 面级事实
 *    必须原样落在外框根上（右键菜单的 `build` 只认 DOM，不认闭包）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OVERLAY_EXIT_CLASS, overlayFrame } from '../src/ui/overlay-chrome';
import { createCallHierarchyOverlay } from '../src/ui/CallHierarchyOverlay';

const css = readFileSync(fileURLToPath(new URL('../src/styles-project.css', import.meta.url)), 'utf8');
const shellSrc = readFileSync(fileURLToPath(new URL('../src/ui/shell-overlays.ts', import.meta.url)), 'utf8');
const chromeSrc = readFileSync(fileURLToPath(new URL('../src/ui/overlay-chrome.tsx', import.meta.url)), 'utf8');

/**
 * 取某选择器**最后一条**声明块（后写覆盖先写，判终态就看最后一条）。
 *
 * 两处必须做对，否则尺本身会造假红（本批实测四条红全是它带的）：
 * ① 选择器列表按逗号拆开逐个比——`.a,\n.b { }` 是一条规则，拿整串字面量去匹配永远找不到；
 * ② **注释要先剥**——规则块里常写着「原 #7ad39a 已改吃 --success」这类交代，
 *    不剥就会把"已删掉的字面色"当成现存违规判红。
 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function lastBlock(selector: string): string {
  const want = norm(selector);
  const re = /([^{}]*)\{([^}]*)\}/g;
  let last: string | null = null;
  for (const m of css.matchAll(re)) {
    const parts = norm(stripComments(m[1] ?? ''))
      .split(',')
      .map(norm)
      .filter(Boolean);
    if (parts.includes(want)) last = stripComments(m[2] ?? '');
  }
  expect(last, `styles-project.css 里找不到选择器 ${selector}`).not.toBeNull();
  return last as string;
}

describe('L12-1 预览编辑器井不许零高塌陷', () => {
  it('.qfp-editor 有可解析的高度声明（min-height 在位，P2-14 建类没建样式的雷已填）', () => {
    const block = lastBlock('.qfp-editor');
    expect(block).toMatch(/min-height:\s*\d+px/);
    expect(block).toMatch(/height:\s*\d+v?h|height:\s*auto/);
  });
  it('fill 面里 .qfp-editor 与 .kd-editor 同一条 flex 吃满规则', () => {
    const block = lastBlock('.wizard.ov.ov-fill .qfp-editor');
    expect(block).toMatch(/flex:\s*1/);
    expect(block).toMatch(/height:\s*auto/);
  });
});

describe('L12-2 浮层档宽收回宿主三档', () => {
  for (const host of ['.kd-host', '.dd-host', '.fh-host', '.oh-host']) {
    it(`${host} 不再自写越档宽度（只许 auto/100%，档宽归 .overlay-host*）`, () => {
      const block = lastBlock(host);
      expect(block).not.toMatch(/min\(\s*(1[01]\d\d|\d{4})px/);
      expect(block).toMatch(/width:\s*(auto|100%)/);
    });
  }
  it('宿主侧 :has(.ov-xl) 的第四档在位（1160，与教程同格——比对/预览的 Monaco 井要的就是这道视野）', () => {
    const block = lastBlock('.overlay-host-wide:has(.ov-xl)');
    expect(block).toMatch(/min\(\s*1160px/);
  });
  it('遮罩纵深合一档：只读查询面的遮罩单独一档（比确认面减淡）', () => {
    expect(css).toMatch(/\.overlay-backdrop:has\(\.ov-query\)\s*\{/);
  });
  it('注册侧五家 ui.overlay 全部带 size（内层档位不许反撑外层）', () => {
    const overlayRegs = [...shellSrc.matchAll(/register\('ui\.overlay',\s*\{([\s\S]*?)\n\s*\}\)/g)];
    expect(overlayRegs.length).toBeGreaterThanOrEqual(4);
    for (const [, body] of overlayRegs) expect(body).toMatch(/size:\s*'wide'/);
  });
});

describe('L12-3 语义色归一', () => {
  it('.kd-banner.ok 与 .kd-error 零 hex / 零 rgba 字面，改吃 --success / --danger', () => {
    for (const sel of ['.kd-banner.ok', '.kd-error']) {
      const block = lastBlock(sel);
      expect(block, sel).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(block, sel).not.toMatch(/rgba?\(/);
    }
    expect(lastBlock('.kd-banner.ok')).toMatch(/var\(--success\)/);
    expect(lastBlock('.kd-error')).toMatch(/var\(--danger\)/);
  });
  it('.dd-* 残留字面色同批转正（--warn / --fg-dim）', () => {
    expect(lastBlock('.dd-modified .dd-path')).toMatch(/var\(--warn\)/);
    expect(lastBlock('.dd-workspace-only .dd-path')).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe('L12-4 退场动画备好（--dur-2 一档）', () => {
  it('keyframes overlay-out 与 .ov-exiting 规则在位，动画吃 --dur-2', () => {
    expect(css).toMatch(/@keyframes overlay-out\s*\{/);
    expect(lastBlock(`.overlay-host.${OVERLAY_EXIT_CLASS}`)).toMatch(/var\(--dur-2\)/);
  });
  it('类名由 overlay-chrome 以常量供给（壳层接线不许各抄字面）', () => {
    expect(OVERLAY_EXIT_CLASS).toBe('ov-exiting');
    expect(chromeSrc).toContain("export const OVERLAY_EXIT_CLASS = 'ov-exiting'");
  });
});

describe('L12-5 五家共用外框与编辑器外观', () => {
  const family: Array<[string, string]> = [
    ['DiffViewOverlay.tsx', 'diff/比对'],
    ['FileHistoryOverlay.tsx', '文件时间线'],
    ['OpsHistoryOverlay.tsx', '操作历史'],
    ['CallHierarchyOverlay.tsx', '调用层级'],
    ['QuickFixPreviewOverlay.tsx', '快速修复预览'],
  ];
  for (const [file, label] of family) {
    it(`${label} 经 overlayFrame 收口`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../src/ui/${file}`, import.meta.url)), 'utf8');
      expect(src).toMatch(/from '\.\/overlay-chrome'/);
      expect(src).toMatch(/overlayFrame\(/);
    });
  }
  it('diff 与 quick-fix 两处消费 overlayEditorAppearance（并入主编辑器外观）', () => {
    for (const file of ['DiffViewOverlay.tsx', 'QuickFixPreviewOverlay.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(`../src/ui/${file}`, import.meta.url)), 'utf8');
      expect(src, file).toMatch(/from '\.\/overlay-editor-appearance'/);
      expect(src, file).toMatch(/\.\.\.appearance/);
    }
  });
  it('✕ 用内置 close SVG（L10 四档刻度里的 sm），不留字符图标', () => {
    expect(chromeSrc).not.toContain("'✕'");
    expect(chromeSrc).toMatch(/h\(Icon,\s*\{\s*name:\s*'close',\s*size:\s*'sm'/);
  });
});

describe('L12-6 换壳不掉批次十的菜单面', () => {
  it('overlayFrame 把 contextSurface / surfaceData 原样钉在外框根 div 上', () => {
    const markup = renderToStaticMarkup(
      overlayFrame({
        hostClass: 'ch-host',
        title: 't',
        onClose: () => undefined,
        contextSurface: 'call-hierarchy',
        surfaceData: { 'data-ch-total-in': '3' },
        children: h('p', null, 'body'),
      }) as ReturnType<typeof h>,
    );
    expect(markup).toContain('data-context-surface="call-hierarchy"');
    expect(markup).toContain('data-ch-total-in="3"');
    expect(markup).toContain('ov-close');
  });
  it('调用层级空态真实渲染：外框根上仍能 closest 到面与 ✕（同一 deps.close）', () => {
    // createCallHierarchyOverlay 的公共签名是 `() => unknown`（批次九遗留的松声明，非本批改）。
    // 本批纪律是行为零改动，不动公共签名，测试侧定点收窄成 React 组件形态。
    const Overlay = createCallHierarchyOverlay({
      currentIndex: () => null,
      functionAt: () => null,
      reveal: () => undefined,
      close: () => undefined,
    }) as () => ReactElement;
    const markup = renderToStaticMarkup(h(Overlay));
    expect(markup).toContain('data-context-surface="call-hierarchy"');
    expect(markup).toContain('ov-head');
    expect(markup).toContain('ov-close');
  });
});
