/**
 * 编辑器热区右键归属的**静态护栏**（1023 覆盖面批 · WP1.2）。
 *
 * 这一路不新增拦截，只补外框；所以本文件不渲染任何东西，只读源码文本钉三条：
 *
 * ① 根路由（`App.tsx` 的 window `contextmenu` 处理器）对 `.monaco-editor` **整片放行**，
 *    且放行发生在 `preventDefault` **之前**（顺序错了 = Monaco 的原生中文菜单永远出不来）；
 * ② 编辑区**没有被我们拦截**：`EditorPane.tsx` 不挂 JSX 的 `onContextMenu`、两个文件都
 *    没有 DOM 级 `contextmenu` 监听、也没有关掉 Monaco 自带的 `contextmenu` 选项
 *    ——行号槽 / 折叠槽 / 小地图 / 概览标尺 / 滚动条 / 编辑区空白 / 内联提示 / 悬浮卡
 *    全在 `.monaco-editor` 里，它们的右键必须继续归 Monaco 的原生菜单。
 *    **允许**的是 Monaco 自己的 `ed.onContextMenu(...)` 通知（拿不到抑制默认行为的能力，
 *   1023 批用它做"右键落点跟随光标、不动选区"），只钉它不许 `preventDefault`；
 * ③ 外框确实带面属性：工具条 `data-context-surface="editor"`、预览横幅
 *    `sugar-preview`（且只在预览在屏时挂），而 Monaco 的宿主节点（`.editor-body`）
 *    **不带**任何面属性。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const app = source('../src/ui/App.tsx');
const pane = source('../src/ui/EditorPane.tsx');
const instance = source('../src/ui/editor-pane/use-monaco-instance.ts');
const previewMenu = source('../src/ui/editor-pane/preview-menu.ts');

/** 取每个标记之后的定长窗口（回调体的近似边界）：只看"这一段里有没有拦截"，不做解析 */
function windowsAfter(text: string, marker: string, size = 1200): string[] {
  const out: string[] = [];
  let from = text.indexOf(marker);
  while (from !== -1) {
    out.push(text.slice(from, from + size));
    from = text.indexOf(marker, from + marker.length);
  }
  return out;
}

describe('根路由：.monaco-editor 整片放行', () => {
  it('放行判据用的是 closest(\'.monaco-editor\')', () => {
    expect(app).toContain("closest('.monaco-editor')");
  });

  it('放行发生在 preventDefault 之前（否则 Monaco 的原生菜单被吞掉）', () => {
    const handler = app.indexOf('const onContextMenu');
    expect(handler).toBeGreaterThan(-1);
    const guard = app.indexOf("closest('.monaco-editor')", handler);
    const prevent = app.indexOf('e.preventDefault()', handler);
    expect(guard).toBeGreaterThan(handler);
    expect(prevent).toBeGreaterThan(guard);
  });

  it('放行是无条件的单条判据（新增热区不必逐个补选择器）', () => {
    const handler = app.indexOf('const onContextMenu');
    const guardLine = app.slice(handler, app.indexOf('\n', app.indexOf("closest('.monaco-editor')", handler)));
    // 形如 `if (e.target.closest('.monaco-editor') !== null) return;`：只有一条条件，没有
    // 「行号槽/小地图/滚动条」这类逐热区枚举（枚举必然会漏，漏掉的那个就再也弹不出原生菜单）
    expect(guardLine.includes('&&')).toBe(false);
    expect(guardLine).not.toContain('.margin');
    expect(guardLine).not.toContain('.minimap');
    expect(guardLine).not.toContain('.scrollbar');
  });
});

describe('编辑器组件：不抢 Monaco 的右键', () => {
  it('EditorPane.tsx 没有给编辑区挂 JSX 的 onContextMenu（那才是"自定义拦截"）', () => {
    expect(pane).not.toMatch(/\bonContextMenu\s*=/);
  });

  it('EditorPane.tsx 没有 DOM 级 contextmenu 监听 / 内联属性', () => {
    expect(pane).not.toMatch(/addEventListener\(\s*['"]contextmenu/);
    expect(pane).not.toMatch(/oncontextmenu\s*=/i);
  });

  it('use-monaco-instance.ts 没有 DOM 级 contextmenu 监听（右键归 Monaco 自己的贡献）', () => {
    expect(instance).not.toMatch(/addEventListener\(\s*['"]contextmenu/);
    expect(instance).not.toMatch(/oncontextmenu\s*=/i);
  });

  it('Monaco 的 `ed.onContextMenu(...)`（若有）只做位置语义，不拦截菜单', () => {
    // 这条**允许**监听本身：`ICodeEditor.onContextMenu` 是 Monaco 自己的右键通知，拿不到
    // 抑制默认行为的能力（原生菜单照出），1023 批用它做"右键落点跟随光标 / 不动选区"。
    // 要钉的是**拦截**：那段回调里不许出现 preventDefault / stopPropagation。
    for (const body of windowsAfter(instance, 'onContextMenu(')) {
      expect(body).not.toContain('preventDefault');
      expect(body).not.toContain('stopPropagation');
    }
  });

  it('没有把 Monaco 自带的右键菜单关掉（contextmenu: false 等于砍功能）', () => {
    expect(pane).not.toMatch(/contextmenu\s*:\s*false/);
    expect(instance).not.toMatch(/contextmenu\s*:\s*false/);
  });

  it('没有给编辑区加 preventDefault 兜掉右键', () => {
    expect(pane).not.toMatch(/preventDefault\(\)[^\n]*contextmenu/i);
  });
});

describe('外框：面属性挂在对的节点上', () => {
  it('工具条是 editor 面的根元素', () => {
    expect(pane).toContain('className="editor-toolbar" data-context-surface="editor"');
  });

  it('预览横幅是 sugar-preview 面的根元素，且只在预览在屏时挂属性', () => {
    expect(pane).toContain("data-context-surface={sugarPreviewing ? 'sugar-preview' : undefined}");
    expect(pane).toContain('const sugarPreviewing = sugarView && sugarStats !== null;');
  });

  it('编辑器组带 data-editor-group（分屏两实例各自认领自己的菜单上下文）', () => {
    expect(pane).toContain('data-editor-group={groupId}');
    expect(previewMenu).toContain("closest<HTMLElement>('[data-editor-group]')");
  });

  it('Monaco 的宿主节点（.editor-body）不带面属性（热区归 Monaco，不由我们接管）', () => {
    const body = pane.match(/<div className="editor-body"[^>]*>/);
    expect(body).not.toBeNull();
    expect(body?.[0] ?? '').not.toContain('data-context-surface');
  });
});
