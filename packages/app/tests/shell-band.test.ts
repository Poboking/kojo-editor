/**
 * 车道 D 第一批的静态 + 纯逻辑判据（VIS-10 身份带 / VIS-23 进度轨 / VIS-24 脏计数 /
 * VIS-17 窄档降级）。
 *
 * 口径：几何与"两处渲染同一份 JSX"这类事实在这里钉死；真壳读数（40px 带的实际占位、
 * overlay 侧栏的落点）另由组长用 `node tools/debug-cli.mjs shell` 复验。
 * 待在默认 node 环境：本文件按文本读源码，happy-dom 下 `import.meta.url` 不是 file: 协议
 * （见 window-drag 那类 DOM 判据不读源文件的原因）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  registerIdentityBandSlot,
  resetIdentityBandSlotForTest,
  setIdentityBandFilled,
  useIdentityBandFilled,
  useIdentityBandSlot,
} from '../src/ui/identity-band';
import { bandTitleOf } from '../src/ui/WindowChrome';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe('bandTitleOf · 同一行同一个名字只说一遍（D-8 的一半）', () => {
  it('工具条并进带后只留破折号后的产品名', () => {
    expect(bandTitleOf('口上语料 — kojo-editor')).toBe('kojo-editor');
  });
  it('没有破折号（无项目）原样返回', () => {
    expect(bandTitleOf('kojo-editor')).toBe('kojo-editor');
  });
  it('目录名里再带一个破折号也只切最后一段', () => {
    expect(bandTitleOf('a — b — kojo-editor')).toBe('kojo-editor');
  });
});

/** 插槽 store：WindowChrome 与 ShellLayout 分属两棵树，靠这一份真源对上话 */
function Probe(): ReactElement {
  const slot = useIdentityBandSlot();
  const filled = useIdentityBandFilled();
  return createElement('i', null, `${slot === null ? 'empty' : 'slot'}:${filled ? '1' : '0'}`);
}

describe('identity-band store', () => {
  beforeEach(() => {
    resetIdentityBandSlotForTest();
  });

  it('没登记 ⇒ 插槽为 null（浏览器 dev / node：工具条必须留在原位，不许消失）', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain('empty:0');
  });

  it('登记插槽与占用位各自独立可读', () => {
    // store 只存引用，不碰元素内部 ⇒ 一个哨兵对象足够
    registerIdentityBandSlot({ tagName: 'SENTINEL' } as unknown as HTMLElement);
    setIdentityBandFilled(true);
    expect(renderToStaticMarkup(createElement(Probe))).toContain('slot:1');
  });

  it('注销 ⇒ 回到空带', () => {
    registerIdentityBandSlot({ tagName: 'SENTINEL' } as unknown as HTMLElement);
    setIdentityBandFilled(true);
    registerIdentityBandSlot(null);
    setIdentityBandFilled(false);
    expect(renderToStaticMarkup(createElement(Probe))).toContain('empty:0');
  });
});

describe('D-1 · 三条 36px 横带收成两条', () => {
  const shell = read('ui/ShellLayout.tsx');
  const chrome = read('ui/WindowChrome.tsx');
  const chromeCss = read('window-chrome.css');

  it('标题栏挂出身份带插槽，且空白处仍可拖窗', () => {
    expect(chrome).toContain('ref={registerIdentityBandSlot}');
    expect(chrome).toContain('data-identity-band=""');
    expect(chrome).toContain('canStartWindowDragFrom(');
  });

  it('壳层两条腿都在：有插槽就 portal，没插槽原位渲染', () => {
    expect(shell).toContain('createPortal(toolbar, identityBand)');
    expect(shell).toContain(': toolbar}');
  });

  it('带高 40px，工具条进带后不再自带一条底边', () => {
    expect(chromeCss).toMatch(/\.window-chrome\s*\{[\s\S]*?height: 40px;/);
    expect(chromeCss).toContain('.window-chrome .toolbar');
    expect(chromeCss).toMatch(/\.window-chrome \.toolbar\s*\{[\s\S]*?border-bottom: 0;/);
  });

  it('三枚重复视图开关从带里摘掉，命令一条不删', () => {
    expect(shell).not.toContain('切换主侧栏 (Ctrl+B)');
    expect(shell).not.toContain('切换底部区 (Ctrl+J)');
    expect(shell).not.toContain('切换副侧栏 (Ctrl+Alt+B)');
    expect(shell).not.toMatch(/className="toolbar-right"/);
    // 鼠标入口搬到活动栏下缘的容器开关组
    expect(shell).toContain('className="ab-containers"');
    expect(shell).toContain('title="底部面板 (Ctrl+J)"');
    expect(shell).toContain('title="副侧栏 (Ctrl+Alt+B)"');
  });
});

describe('D-7 · 提示只说"是什么"', () => {
  it('八枚活动栏入口与面板 tab 的 title 不再带实现细节后缀', () => {
    expect(read('ui/ShellLayout.tsx')).not.toContain('（可拖拽到其他容器）');
  });
});

describe('D-5 / D-6 · 状态栏三档注意力预算', () => {
  const shell = read('ui/ShellLayout.tsx');
  const css = read('shell-band.css');

  it('索引读数升成 2px 进度轨 + 百分比读数，且没有基线时绝不编一个假分数', () => {
    expect(shell).toContain('className="idx-rail"');
    expect(shell).toContain("索引构建中 ${indexPct}%");
    expect(shell).toContain("indexPct === null ? '索引构建中…'");
    expect(css).toMatch(/\.idx-rail\s*\{[\s\S]*?height: 2px;/);
    // 三档里"元信息不许再叠边框"：轨之外的文字档保持 dim
    expect(css).toMatch(/\.statusbar \.sb-idx\s*\{[\s\S]*?gap: 6px;/);
  });

  it('不定态扫掠受两把减弱动效闸管辖', () => {
    expect(css).toContain('@keyframes sb-idx-sweep');
    expect(css).toContain(":root[data-motion='reduced']");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('脏读数从"当前文件"改成可点的整窗计数（主信号 = accent + 字重）', () => {
    expect(shell).toContain('未保存 {dirtyCount} 个文件');
    expect(shell).toContain("runToolbarCommand('workbench.saveAll')");
    // 旧那颗 9px circle-filled + amber 文字从状态栏摘掉（主信号留标签条那一份）
    expect(shell).not.toContain('<Icon name="circle-filled" size={9} /> 未保存');
    const project = read('ui/ProjectView.tsx');
    expect(project).toContain('dirtyCount={dirtyPaths.size}');
    expect(css).toMatch(/\.statusbar button\.sb-dirty\.on\s*\{[\s\S]*?font-weight: 600;/);
  });

  it('装饰子件不占 `sb-` 前缀（状态栏每格一个 data-status-cell 的守门口径）', () => {
    for (const cls of ['sb-idx-rail', 'sb-idx-text', 'sb-idx-fill']) {
      expect(shell, `${cls} 会被当成新的一格`).not.toContain(`className="${cls}"`);
    }
  });
});

describe('D-4 · 壳层窄档降级', () => {
  const css = read('shell-band.css');
  it('两档断点各一条，且都只落在壳层自己的区', () => {
    expect(css).toContain('@media (max-width: 1179px)');
    expect(css).toContain('@media (max-width: 1023px)');
    expect(css).toMatch(/@media \(max-width: 1179px\)[\s\S]*?\.shell \.activitybar\s*\{[\s\S]*?width: 40px;/);
    expect(css).toMatch(/@media \(max-width: 1023px\)[\s\S]*?\.shell \.sidebar\s*\{[\s\S]*?position: absolute;/);
  });
  it('窗口下限不跟着抬（960 已落在第二档内）', () => {
    expect(read('ui/window-fullscreen.ts')).toContain(
      'EDITOR_MIN_SIZE: WindowSize = { width: 960, height: 620 }',
    );
  });
});
