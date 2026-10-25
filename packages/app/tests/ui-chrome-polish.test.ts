/**
 * 视觉批十三的三条「说过的话要能重被抓到」：
 *
 * ① 只读是**常态**（游戏目录默认只读）⇒ 不许再长出一条常驻全宽横幅；入口只在状态栏那枚
 *    可点的「只读」徽标，保存被拒时由回执通知带「去授权」。
 * ② 函数树的角色下拉是**最后一个原生控件**（真机实测 `appearance: auto` + 13.33px 系统字）：
 *    它必须走 kit 井面 + `currentColor` 双渐变箭头，换主题时箭头跟着 `--fg` 走。
 * ③ 侧栏/检索/导航三个滚动列表滚到底不许把最后一行切成半个字：底部留白 ≥ 渐隐高度。
 *
 * 这些是**样式与装配位的判据**（真机读数见提交信息），住在默认 node 环境里按文本读源码，
 * 不开 DOM。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** 取一条规则的声明体（选择器按**行首**精确匹配，避免 `.nav-search` 误命中 `.nav-search-x`） */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `找不到规则 ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('\n}', open);
  expect(close, `规则 ${selector} 没有闭合`).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe('视觉批十三 · 壳层打磨的防回退判据', () => {
  it('只读常态不再占整条横幅：ProjectView 里没有 `.ro-banner` 的装配位', () => {
    const src = read('ui/ProjectView.tsx');
    expect(src).not.toContain('className="ro-banner"');
    // 权限入口仍在：状态栏那枚只读徽标接 `onReauth`
    expect(src).toContain('onReauth={onReauth}');
  });

  it('函数树角色下拉走 kit：appearance:none + currentColor 箭头（跟随三档主题）', () => {
    const body = ruleBody(read('styles-project.css'), '.nav-chara-select');
    expect(body).toContain('appearance: none');
    expect(body).toContain('currentColor 50%');
    expect(body).toContain('var(--surface-sunken)');
    // 原生档的系统字（13.3333px）不再出现：字号只认 token
    expect(body).toContain('font-size: var(--fs-2)');
  });

  it('三个滚动列表都是「底部留白 + 渐隐」，且留白不小于渐隐带（到底整行可见）', () => {
    const project = read('styles-project.css');
    const trees = webkit(ruleBody(project, '.tree-groups'));
    expect(trees.pad).toBeGreaterThanOrEqual(trees.fade);
    const nav = ruleBody(project, '.nav-tree,\n.nav-hits');
    expect(nav).toContain('mask-image');
    expect(nav).toContain('padding: 6px 0 20px');
    const search = read('search-panel.css');
    const results = ruleBody(search, '.panel-search.ksp > .ksp-results');
    expect(results).toContain('mask-image');
    expect(results).toContain('20px');
  });

  it('浮层退场覆盖设置面：壳层保活 + 两处渲染都挂 `.ov-exiting`', () => {
    const shell = read('ui/ShellLayout.tsx');
    expect(shell).toContain('useOverlayPresence(settingsOpen)');
    expect(shell).toContain('exiting={settingsPresence.exiting}');
    // 设置面板自带 backdrop/host，两处返回都要能挂类（防御性空壳 + 正常面）
    const settings = read('ui/SettingsPanel.tsx');
    expect(settings.match(/ov-exiting/g)?.length).toBe(2);
    expect(settings.match(/ov-closing/g)?.length).toBe(2);
    expect(settings).toContain('exiting?: boolean');
  });

  it('窗口标题限宽：长目录名省略、完整标题进 title', () => {
    const chrome = read('ui/WindowChrome.tsx');
    expect(chrome).toContain('title={title}');
    const css = readFileSync(fileURLToPath(new URL('../src/window-chrome.css', import.meta.url)), 'utf8');
    expect(css).toContain('max-width: min(42vw, 520px)');
    expect(css).toContain('text-overflow: ellipsis');
  });
  it('窗口标题三处同源：自绘标题栏 / document.title / Tauri 系统标题都读同一个算法', () => {
    const app = read('ui/App.tsx');
    // 算法住在 window-title.ts（纯函数另有一份真值测试）；这里只钉"三条出口都接上了"
    expect(app).toContain("from './window-title'");
    expect(app).toContain('windowTitleFor(project?.rootDir');
    expect(app).toContain('document.title = windowTitle');
    expect(app).toContain('getCurrentWindow().setTitle(windowTitle)');
    expect(app).toContain('<WindowChrome title={windowTitle} />');
  });
});

/** 从 `.tree-groups` 的声明体里读留白与渐隐带（数值比较，避免"写了 mask 但留白不够"的假绿） */
function webkit(body: string): { pad: number; fade: number } {
  const pad = Number(/padding:\s*0 0 (\d+)px/.exec(body)?.[1] ?? -1);
  const fade = Number(/calc\(100% - (\d+)px\)/.exec(body)?.[1] ?? -1);
  expect(pad, '树列表缺底部留白').toBeGreaterThan(0);
  expect(fade, '树列表缺渐隐带').toBeGreaterThan(0);
  return { pad, fade };
}
