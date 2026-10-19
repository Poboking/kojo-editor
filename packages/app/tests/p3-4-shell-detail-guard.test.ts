/**
 * P3-4 壳层细节守门（源码形状判据，口径同 `ps5-editor-pane-wiring.test.ts` /
 * `shell-info-design.test.ts`：node 无 DOM、EditorPane 挂不动 ⇒ 钉「接线在不在」）。
 *
 * 三组各钉一件事：
 *  ① 保存三段式：只读态那颗实心主按钮**整颗不渲染**（说明只留底部状态栏一处，
 *     2026-10-14 去重口径）；可写无改动 = `.idle` 弱化档；有改动才回实心主按钮；
 *     `kernel.io.isWritable` 仍是唯一可写真源，`保存 (Ctrl+S)` 与 onClick save 接线零改动。
 *  ② 激活标签：底色 + 顶部 accent 线之外补左右 `--border-strong` 描边、字重 600，
 *     且全部 token、无裸 hex（三主题由 token 层跟随，本仓themes/不许组件写死颜色）。
 *  ③ 品牌记号（欢迎页侧）：与标题栏同一枚「口上/对话框」气泡，走 mask + `--accent`
 *     token；欢迎页两处品牌（大标题 / 关闭卡）都挂上，无图片资源。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const pane = read('../src/ui/EditorPane.tsx');
const css = read('../src/styles-project.css');
const welcome = read('../src/ui/welcome.css');

/** 截 `sel { ... }` 的第一段规则体（粗略但足够钉形状；同 ps5 的 sliceFn 口径） */
function cssBlock(source: string, selector: string): string {
  const at = source.indexOf(selector);
  expect(at, `CSS 里找不到 ${selector}`).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf('}', at));
}

describe('P3-4 ① 保存按钮三段式（EditorPane 渲染处）', () => {
  it('只读（不可写）态整颗不渲染：按钮被 isWritable 三元包住，else 分支是 null', () => {
    expect(pane).toContain('{kernel.io.isWritable(filePath) ? (');
    // 旧的「disabled 的醒目主按钮」形状不许回来
    expect(pane).not.toContain('disabled={!dirty || !kernel.io.isWritable(filePath)}');
  });

  it('可写态：无改动挂 .idle 弱化、有改动回实心；disabled 只看 dirty；接线（onClick save）不丢', () => {
    expect(pane).toContain('className={`primary small${dirty ? \'\' : \' idle\'}`}');
    expect(pane).toContain('disabled={!dirty}');
    expect(pane).toContain('onClick={() => void save()}');
    expect(pane).toContain('保存 (Ctrl+S)');
  });

  it('.idle 弱化档样式在 styles-project.css，且只吃 token', () => {
    const block = cssBlock(css, '.editor-toolbar button.primary.idle {');
    expect(block).toContain('background: transparent');
    expect(block).toContain('var(--border)');
    expect(block).toContain('var(--fg-dim)');
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('P3-4 ② 激活标签对比（styles-project.css）', () => {
  it('.editor-tab.active：顶部 accent 线保留 + 左右 --border-strong 描边（inset 阴影，不占布局）', () => {
    const block = cssBlock(css, '.editor-tab.active {');
    expect(block).toContain('inset 0 2px 0 var(--accent)');
    expect(block).toContain('inset 1px 0 0 var(--border-strong)');
    expect(block).toContain('inset -1px 0 0 var(--border-strong)');
    expect(block).toContain('background: var(--bg)');
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('活动标签字重升到 600（第三档辨识：底色 · 描边 · 字重）', () => {
    const block = cssBlock(css, '.editor-tab.active .tab-label {');
    expect(block).toContain('font-weight: 600');
  });

  it('拖拽落点与激活态叠加时仍保留另一侧描边（box-shadow 覆盖不许漏档）', () => {
    expect(cssBlock(css, '.editor-tab.active.drop-before {')).toContain('inset -1px 0 0 var(--border-strong)');
    expect(cssBlock(css, '.editor-tab.active.drop-after {')).toContain('inset 1px 0 0 var(--border-strong)');
  });
});

describe('P3-4 ③ 品牌记号（欢迎页，welcome.css 品牌区）', () => {
  it('记号形状是内联 SVG data-URI 的 mask（无图片资源），上色吃 --accent token', () => {
    expect(welcome).toContain('--kojo-brand-glyph: url("data:image/svg+xml,');
    expect(welcome).not.toMatch(/url\([^)]*\.(png|jpg|jpeg|svg|webp)["')]/i); // 不许外链图片文件
    // 形状 token 定义在 `.welcome-screen` 作用域里（关闭卡与主欢迎页共用该根类）
    expect(welcome).toMatch(/\.welcome-screen \{\s*\n\s*--kojo-brand-glyph: url\("data:image\/svg\+xml,/);
  });

  it('两处品牌都挂上：大标题 `.welcome-brand h1::before` 与关闭卡 `.welcome-closed-brand::before`', () => {
    for (const sel of ['.welcome-screen .welcome-brand h1::before {', '.welcome-screen .welcome-closed-brand::before {']) {
      const block = cssBlock(welcome, sel);
      expect(block).toContain('background: var(--accent)');
      expect(block).toContain('mask: var(--kojo-brand-glyph) center / contain no-repeat');
    }
  });

  it('尺寸走 em（跟随标题字号，含界面字号档位），不新增全局字号 token', () => {
    expect(welcome.slice(0, welcome.indexOf('.welcome-brand {'))).toMatch(/width: 0\.8em;/);
    expect(welcome).not.toMatch(/--fs-[a-z0-9-]+:\s*\d/);
  });
});
