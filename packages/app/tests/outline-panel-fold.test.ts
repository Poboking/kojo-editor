// @vitest-environment happy-dom
/**
 * 侧栏大纲面板的**折叠视图**判据（1023 缺口批）。
 *
 * 纯逻辑（`outline-model` 的 `visibleOutlineRows` / `outlineHasChildren`）已在
 * `outline-model.test.ts` 钉住；这里钉的是**组件这一侧接得对不对**：
 * - 折了父行 ⇒ 子行真的从 DOM 里消失，`aria-expanded` 跟着翻；
 * - 折叠指示是**独立 hit target**：点它只折/展，不跳源（点行主体才跳）；
 * - 换文档 ⇒ 折叠状态复位（旧 id 不许折新文件的行）；
 * - 空树 / 单层树 ⇒ 不摆折叠入口（铁律 4：能力不存在就不摆）。
 *
 * 环境用 happy-dom + `react-dom/client`（与 `file-tree-memo` / `search-panel` 同款）：
 * 面板抓的是模块级位点探针（`setJumpProbe`），宿主事件走 `kernel.bus`，两者都能在
 * 测试里直接摆好 ⇒ 不需要真的挂编辑器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { OutlinePanel } from '../src/ui/OutlinePanel';
import { setJumpProbe } from '../src/ui/jump-to-state';
import {
  OUTLINE_MENU_IDS,
  OUTLINE_ROW_ATTR,
  OUTLINE_ROW_ID_ATTR,
  buildOutlineSurfaceMenu,
  setOutlineMenuContext,
} from '../src/ui/outline-menu';
import type { ContextMenuItem } from '../src/ui/context-menu-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sym = (
  name: string,
  startLine: number,
  endLine: number,
  children?: EditorDocumentSymbol[],
): EditorDocumentSymbol => ({
  name,
  kind: 'block',
  startLine,
  endLine,
  ...(children ? { children } : {}),
});

/** 嵌套树（`.kojo` 形状）：父 → 子甲 / 子乙 → 孙，另有一枚顶层叶子 */
const NESTED: readonly EditorDocumentSymbol[] = [
  sym('父甲', 1, 20, [sym('子一', 2, 5), sym('子二', 6, 9, [sym('孙', 7, 8)])]),
  sym('叶乙', 21, 30),
];

/** 单层树（ERB 平铺）：一支都折不了 */
const FLAT: readonly EditorDocumentSymbol[] = [sym('ALPHA', 2, 9), sym('BETA', 12, 30)];

const DOC_A = 'C:/koa/001/A.KOJO';
const DOC_B = 'C:/koa/001/B.KOJO';

/** 假 kernel：只实现面板用到的那一条 `bus.on`，并把处理器留住供测试触发 */
function fakeKernel(): { kernel: Kernel; fire: (event: string) => void } {
  const handlers = new Map<string, Set<() => void>>();
  const kernel = {
    bus: {
      on: (event: string, cb: () => void) => {
        const set = handlers.get(event) ?? new Set<() => void>();
        set.add(cb);
        handlers.set(event, set);
        return () => set.delete(cb);
      },
    },
  } as unknown as Kernel;
  return {
    kernel,
    fire: (event) => {
      for (const cb of [...(handlers.get(event) ?? [])]) cb();
    },
  };
}

let container: HTMLElement;
let root: Root | null = null;
const revealed: Array<[string, number]> = [];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  revealed.length = 0;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  setJumpProbe(null);
  setOutlineMenuContext(null);
});

async function mount(kernel: Kernel): Promise<Root> {
  const r = createRoot(container);
  await act(async () => {
    r.render(h(OutlinePanel, { kernel, onReveal: (path: string, line: number) => revealed.push([path, line]) }));
  });
  root = r;
  return r;
}

/** 屏上的行名（按 DOM 序；不含折叠箭头那枚按钮） */
function rowNames(): string[] {
  return Array.from(container.querySelectorAll(`[${OUTLINE_ROW_ATTR}]`)).map(
    (row) => row.querySelector('[role="treeitem"]')?.textContent ?? '',
  );
}

function rowEl(id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[${OUTLINE_ROW_ID_ATTR}="${id}"]`);
  if (row === null) throw new Error(`行 ${id} 不在屏上`);
  return row;
}

function treeitemOf(id: string): HTMLElement {
  const item = rowEl(id).querySelector<HTMLElement>('[role="treeitem"]');
  if (item === null) throw new Error(`行 ${id} 没有 treeitem`);
  return item;
}

function foldButtonOf(id: string): HTMLElement | null {
  return rowEl(id).querySelector<HTMLElement>('[data-outline-fold]');
}

async function click(node: HTMLElement | null): Promise<void> {
  if (node === null) throw new Error('要点的东西不在屏上');
  await act(async () => {
    node.click();
  });
}

/** 面板此刻报给菜单的现场（面从模块级上下文读，这里模拟"右键某一行"） */
function menuIdsOf(id: string): string[] {
  const result = buildOutlineSurfaceMenu(rowEl(id));
  if (result === null || Array.isArray(result)) throw new Error('面没有给出完整菜单');
  const menu = result as { readonly items: readonly ContextMenuItem[] };
  return menu.items.map((item) => item.id);
}

describe('大纲面板 · 折叠一支', () => {
  it('折父行 ⇒ 整支从 DOM 消失，aria-expanded 翻 false，别的行不动', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    expect(rowNames()).toEqual(['父甲', '子一', '子二', '孙', '叶乙']);
    expect(treeitemOf('r0').getAttribute('aria-expanded')).toBe('true');

    await click(foldButtonOf('r0'));

    expect(rowNames()).toEqual(['父甲', '叶乙']);
    expect(treeitemOf('r0').getAttribute('aria-expanded')).toBe('false');
    // 折叠是纯视图状态：行身份与行号锚点都没变（右键认人同一条）
    expect(rowEl('r0').getAttribute(OUTLINE_ROW_ID_ATTR)).toBe('r0');
  });

  it('点折叠指示不跳源；点行主体才跳', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    await click(foldButtonOf('r0'));
    expect(revealed).toEqual([]);

    await click(treeitemOf('r0'));
    expect(revealed).toEqual([[DOC_A, 1]]);
  });

  it('再点一次 ⇒ 展开回来（箭头方向跟着状态走）', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    expect(foldButtonOf('r0')?.textContent).toBe('▾');
    await click(foldButtonOf('r0'));
    expect(foldButtonOf('r0')?.textContent).toBe('▸');
    await click(foldButtonOf('r0'));
    expect(foldButtonOf('r0')?.textContent).toBe('▾');
    expect(rowNames()).toEqual(['父甲', '子一', '子二', '孙', '叶乙']);
  });

  it('折中间那层 ⇒ 只掉它名下的孙', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    await click(foldButtonOf('r2'));
    expect(rowNames()).toEqual(['父甲', '子一', '子二', '叶乙']);
    // 父仍标着"展开"，因为它名下还有看得见的子一
    expect(treeitemOf('r0').getAttribute('aria-expanded')).toBe('true');
  });

  it('叶子行没有折叠指示（折了什么都不变 ⇒ 不摆入口）', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    expect(foldButtonOf('r1')).toBeNull();
    expect(foldButtonOf('r4')).toBeNull();
    expect(treeitemOf('r1').hasAttribute('aria-expanded')).toBe(false);
  });
});

describe('大纲面板 · 换文档即复位', () => {
  it('折过父行后切到另一份文件 ⇒ 新文件的行全出（旧 id 不许折新文件的行）', async () => {
    let probe = { path: DOC_A, line: 3, symbols: NESTED, derivedView: false };
    setJumpProbe(() => probe);
    const { kernel, fire } = fakeKernel();
    await mount(kernel);

    await click(foldButtonOf('r0'));
    expect(rowNames()).toEqual(['父甲', '叶乙']);

    // 换文件：同形 id（r0 仍是有子节点的那一行），只有名字换了
    probe = { path: DOC_B, line: 3, symbols: [sym('另一父', 1, 20, [sym('另一子', 2, 5)]), sym('另一叶', 21, 30)], derivedView: false };
    await act(async () => {
      fire('editor.activeFileChanged');
    });

    expect(rowNames()).toEqual(['另一父', '另一子', '另一叶']);
    expect(treeitemOf('r0').getAttribute('aria-expanded')).toBe('true');
  });

  it('同一份文件里光标走动 ⇒ 折叠保持（别把作者刚折好的掀开）', async () => {
    let probe = { path: DOC_A, line: 3, symbols: NESTED, derivedView: false };
    setJumpProbe(() => probe);
    const { kernel, fire } = fakeKernel();
    await mount(kernel);

    await click(foldButtonOf('r0'));
    probe = { ...probe, line: 22 };
    await act(async () => {
      fire('editor.cursorMoved');
    });

    expect(rowNames()).toEqual(['父甲', '叶乙']);
    // 光标落在叶乙上 ⇒ 高亮跟着走（折叠不挡定位）
    expect(treeitemOf('r4').getAttribute('aria-selected')).toBe('true');
  });
});

describe('大纲面板 · 没有可折的东西时不摆入口', () => {
  it('单层树（ERB 平铺）⇒ 一枚折叠指示都没有', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: FLAT, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    expect(rowNames()).toEqual(['ALPHA', 'BETA']);
    expect(container.querySelectorAll('[data-outline-fold]')).toHaveLength(0);
  });

  it('空树 ⇒ 空态那句照旧可见，也没有折叠指示', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: [], derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    expect(container.querySelector('[data-outline-empty]')?.textContent).toContain('还没有可列出的符号');
    expect(container.querySelectorAll('[data-outline-fold]')).toHaveLength(0);
  });
});

describe('大纲面板 · 折叠状态报给菜单', () => {
  it('折上之后行菜单给「展开这一支」，再展开又回到「折叠这一支」', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    expect(menuIdsOf('r0')).toContain(OUTLINE_MENU_IDS.foldBranch);

    await click(foldButtonOf('r0'));
    expect(menuIdsOf('r0')).toContain(OUTLINE_MENU_IDS.expandBranch);
    expect(menuIdsOf('r0')).not.toContain(OUTLINE_MENU_IDS.foldBranch);

    await click(foldButtonOf('r0'));
    expect(menuIdsOf('r0')).toContain(OUTLINE_MENU_IDS.foldBranch);
  });

  it('叶子行的菜单里两个折叠项都没有', async () => {
    setJumpProbe(() => ({ path: DOC_A, line: 3, symbols: NESTED, derivedView: false }));
    const { kernel } = fakeKernel();
    await mount(kernel);

    const ids = menuIdsOf('r4');
    expect(ids).not.toContain(OUTLINE_MENU_IDS.foldBranch);
    expect(ids).not.toContain(OUTLINE_MENU_IDS.expandBranch);
  });
});
