// @vitest-environment happy-dom
/**
 * 函数树面板的行键盘（kw8a 1102 行键盘批 · 第二步之二）。
 *
 * 判据是**行为级**（真挂载、真派发 KeyboardEvent、看焦点落在哪一行）：
 * - 行级漫游：↑↓ 在**可见节点**之间移焦点（家族 → 面 → 函数，DOM 序即所见）；
 * - F4/F8 移过去并当场敲那一枚按钮——函数行 = 走它既有的 reveal 通路
 *   （`editor.revealLocation`），家族/面行 = 它自己的展开收起 `onClick`，零第二条通道；
 * - 没画出来的行不参与名单：没展开的面里的函数、窗口外的函数都不在名单上；
 * - `<select>`（角色下拉）里的方向键一律让位；单行检索框不让（↓ 直接进列表第一行）；
 * - 输入法合成期一律放行；Right/Left 本批明确不接（折叠真源住 `openFamilies/openFaces`，
 *   另造层级判据就是第二套折叠状态——见面板内注释与提交信息）。
 *
 * 判据真源在契约层（`plugin-api/tests/panel-row-nav.test.ts`）；本文件钉面板接线。
 * 为什么住 app 侧：react-dom 与 happy-dom 只有 app 包依赖（同 `face-list-render.test.ts`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NavigatorStore } from '../../plugins/ui-kojo-navigator/src/navigator-store';
import {
  NO_FAMILY_MATCH,
  type FunctionNode,
  type NavigatorTree,
} from '../../plugins/ui-kojo-navigator/src/tree';
import { createNavigatorPanel } from '../../plugins/ui-kojo-navigator/src/navigator-panel';
import type { PluginContext, UIPanelProps } from '@kojo/plugin-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fn = (name: string, line: number): FunctionNode => ({
  name,
  normalizedName: name.toUpperCase(),
  filePath: 'work/demo.src',
  startLine: line,
  endLine: line + 4,
  match: NO_FAMILY_MATCH,
});

const tree: NavigatorTree = {
  charas: [
    {
      no: 1,
      label: 'K1',
      functionCount: 3,
      families: [
        {
          family: '',
          faces: [
            { face: '', functions: [fn('FUNC_A', 10), fn('FUNC_B', 20)] },
            { face: 'MSG', functions: [fn('FUNC_C', 30)] },
          ],
        },
      ],
    },
  ],
  orphanCount: 0,
  hasFamilyIndex: true,
  totalFunctions: 3,
  attribution: 'dir',
  scopeKey: '',
  filesScanned: 1,
};

let container: HTMLDivElement;
let root: Root;
let emitSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  emitSpy = vi.fn();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

async function mount(): Promise<void> {
  const store = {
    tree,
    indexReady: true,
    index: null,
    scope: null,
    loadError: null,
    indexState: null,
    treeListeners: new Set<() => void>(),
    refresh: () => undefined,
  } as unknown as NavigatorStore;
  const ctx = {
    bus: { emit: emitSpy, on: () => () => undefined },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  } as unknown as PluginContext;
  const conditionExtractor = {
    subscribe: () => () => undefined,
    functionConditions: () => null,
  };
  const Panel = createNavigatorPanel({
    ctx,
    parser: {} as never,
    conditionExtractor: conditionExtractor as never,
    store,
    currentFamilyIndex: () => null,
    currentFaceLabels: () => undefined,
  });
  const Comp = Panel as unknown as (props: UIPanelProps) => ReactElement;
  await act(async () => {
    root.render(h(Comp, {}));
  });
}

/** 名单（契约层行标记）按 DOM 序 */
function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-panel-row]'));
}

async function selectChara(): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>('select.nav-chara-select')!;
  await act(async () => {
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function focusOn(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.focus();
  });
}

async function clickRow(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? container;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('函数树面板 · 行键盘', () => {
  it('未选角色没有名单（空集合不吞键）；选角色后家族行进名单', async () => {
    await mount();
    expect(rows()).toHaveLength(0);
    const panel = container.querySelector<HTMLElement>('.panel-kojo-nav')!;
    await focusOn(panel);
    const e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(false); // 空集合 = 原样让位

    await selectChara();
    const list = rows();
    expect(list).toHaveLength(1); // 家族行（面与函数还没画出来 ⇒ 不在名单）
    expect(list[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('单行检索框里 ↓ 不让位、直接进列表第一行；角色下拉里 ↓ 一律让位', async () => {
    await mount();
    await selectChara();
    const list = rows();
    const search = container.querySelector<HTMLInputElement>('input.nav-search')!;
    await focusOn(search);
    let e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]); // 从检索框 ↓ = 进第一行

    const select = container.querySelector<HTMLSelectElement>('select.nav-chara-select')!;
    await focusOn(select);
    e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(false); // 下拉框的方向键归下拉框
    expect(document.activeElement).toBe(select);
  });

  it('↑↓ 按可见节点走（家族→面→函数），没展开的面里的函数不参与名单', async () => {
    await mount();
    await selectChara();
    await clickRow(rows()[0]!); // 展开家族（行的 onClick，同一通道）
    expect(rows().map((r) => r.className)).toEqual(['nav-family-btn', 'nav-face-btn', 'nav-face-btn']);

    await clickRow(rows()[1]!); // 展开第一个面
    const list = rows();
    expect(list.map((r) => r.className)).toEqual([
      'nav-family-btn',
      'nav-face-btn',
      'nav-func-btn', // FUNC_A
      'nav-func-btn', // FUNC_B
      'nav-face-btn', // MSG——它的 FUNC_C 没画出来 ⇒ 不在名单
    ]);
    expect(container.textContent).not.toContain('FUNC_C');

    await focusOn(list[2]!);
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[3]);
    await press('ArrowDown'); // 再往下 = 收起的 MSG 面行（它自己就是名单里的一行）
    expect(document.activeElement).toBe(list[4]);
    await press('ArrowDown'); // 末行再往下 = 回绕到家族行（同一把尺子）
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('F8 移过去并当场打开：函数行走既有 reveal 通路；Shift 反向', async () => {
    await mount();
    await selectChara();
    await clickRow(rows()[0]!);
    await clickRow(rows()[1]!);
    const list = rows();
    await focusOn(list[1]!); // 焦点在第一个面行
    const e = await press('F8');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[2]); // 走到 FUNC_A
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('editor.revealLocation', {
      filePath: 'work/demo.src',
      line: 10,
      source: 'FUNC_A',
    });

    await focusOn(list[3]!); // FUNC_B
    await press('F8', { shiftKey: true });
    expect(document.activeElement).toBe(list[2]);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls[1]).toEqual([
      'editor.revealLocation',
      { filePath: 'work/demo.src', line: 10, source: 'FUNC_A' },
    ]);
  });

  it('输入法合成期一律放行；Right/Left 与 Enter 不被行导航接管', async () => {
    await mount();
    await selectChara();
    const list = rows();
    await focusOn(list[0]!);

    const e1 = await press('ArrowDown', { isComposing: true });
    expect(e1.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(list[0]);
    const e2 = await press('ArrowDown', { keyCode: 229 });
    expect(e2.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(list[0]);

    for (const key of ['ArrowRight', 'ArrowLeft', 'Enter', 'Tab']) {
      const e = await press(key);
      expect(e.defaultPrevented, key).toBe(false);
    }
  });

  it('roving tabindex：整段名单只留一枚 0（tree/treeitem + aria-level 已挂上）', async () => {
    await mount();
    await selectChara();
    await clickRow(rows()[0]!);
    await clickRow(rows()[1]!);
    const list = rows();
    expect(list.every((r) => r.getAttribute('role') === 'treeitem')).toBe(true);
    expect(list[2]!.getAttribute('aria-level')).toBe('3');
    expect(list.filter((r) => r.tabIndex === 0)).toHaveLength(1);

    await focusOn(list[3]!); // 鼠标/编程式聚焦 ⇒ focus 腿对齐
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rows()[3]]);
  });
});
