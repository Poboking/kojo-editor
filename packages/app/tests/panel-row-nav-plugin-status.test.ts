// @vitest-environment happy-dom
/**
 * 插件状态面板的行键盘（kw8b 1102 行键盘批 · 四只懒边面板之一）。
 *
 * 判据是**行为级**（真挂载、真派发 KeyboardEvent、看焦点落在哪一行），照
 * `panel-row-nav-convention-report.test.ts` 的接线范式：
 * - ↑↓ 只在可见行之间移焦点（边界回绕），什么都不打开；
 * - F4/F8 移过去并当场敲这一行——**本面板的行没有左键动作**（重试/停用/复制全住行级
 *   右键菜单），所以"敲一行"必须一个字节都不动：`registry.retry` / `registry.stop` /
 *   总线一条都不许多出来，即"不许新开第二条通路"在本面板的钉子；
 * - 没画出来的东西不在名单：错误行的 `details` 两件（summary 与收起的详情体）不是行，
 *   插件清单为空时（`registry.list()` 没读数）名单为空、一个键都不吞；
 * - 输入法合成期一律放行、非导航键（Enter/Tab/Escape/←）一律不吞；
 * - roving tabindex：整段名单只留一枚 0。
 *
 * 判据真源在契约层（`plugin-api/tests/panel-row-nav.test.ts` 钉键位语义与
 * `<select>`/`<textarea>` 让位）；本文件钉的是**面板接线**。
 * **本面板没有 `select`/`textarea`**（一处单行输入框都没有）⇒ "字段里方向键让位"那条腿
 * 在这里无从真挂，由契约层判据与函数树面板（真挂 `select`）钉；这里钉的是它的补集
 * （焦点在行外时 ↓ 进第一行）与"行外控件不另立名单"。
 * 为什么住 app 侧：react-dom 与 happy-dom 只有 app 包依赖（同 `panel-row-nav-convention-report.test.ts`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Plugin, PluginContext, PluginStateRecord, UIPanelProps } from '@kojo/plugin-api';
import { createUiStatusPlugin } from '../../plugins/ui-plugin-status/src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rec = (
  id: string,
  status: PluginStateRecord['status'],
  extra: Partial<PluginStateRecord> = {},
): PluginStateRecord => ({ id, version: '0.1.0', status, ...extra });

let container: HTMLDivElement;
let root: Root;
let Panel: ((props: UIPanelProps) => unknown) | null;
let listSpy: ReturnType<typeof vi.fn>;
let retrySpy: ReturnType<typeof vi.fn>;
let stopSpy: ReturnType<typeof vi.fn>;
let emitSpy: ReturnType<typeof vi.fn>;

/** 挂一只面板；`records` = `kernel.plugins.list()` 的读数 */
async function activateWith(records: PluginStateRecord[]): Promise<void> {
  listSpy = vi.fn(() => records);
  retrySpy = vi.fn(() => Promise.resolve());
  stopSpy = vi.fn(() => Promise.resolve());
  emitSpy = vi.fn();
  Panel = null;
  const registry = {
    list: listSpy,
    get: (id: string) => records.find((r) => r.id === id),
    retry: retrySpy,
    stop: stopSpy,
    register: () => Promise.resolve(),
  };
  const slots = {
    register: (kind: string, def: { id: string; component?: (props: UIPanelProps) => unknown }) => {
      if (kind === 'ui.panel' && def.id === 'plugin-status') Panel = def.component ?? null;
    },
    query: () => [],
  };
  const ctx = {
    inject: (key: string) => (key === 'kernel.plugins' ? registry : undefined),
    tryInject: () => undefined, // 没有 `kernel.ops` ⇒ 维护记录那一行整条不渲染
    slots,
    bus: { emit: emitSpy, on: () => () => undefined },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
    onDispose: () => undefined,
  };
  (createUiStatusPlugin() as Plugin).activate(ctx as unknown as PluginContext);
  expect(Panel, 'ui.panel 槽必须注册出面板组件').toBeTruthy();
  const Comp = Panel as unknown as (props: UIPanelProps) => ReactElement;
  await act(async () => {
    root.render(h(Comp, {}));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

/** 名单（契约层行标记）按 DOM 序 */
function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-panel-row]'));
}

/** 行上屏的插件 id（名单顺序的证据，也是"焦点落在第几行"的读数口径） */
function rowIds(list: HTMLElement[]): string[] {
  return list.map((r) => r.querySelector('.plugin-id')?.textContent ?? '');
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? container;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function focusOn(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.focus();
  });
}

const panelRoot = (): HTMLElement => container.querySelector<HTMLElement>('.panel-plugin-status')!;

describe('插件状态面板 · 行键盘', () => {
  it('↑↓ 在可见行之间走（边界回绕），不打开任何东西', async () => {
    await activateWith([
      rec('ui-kojo-navigator', 'active'),
      rec('ui-market', 'inactive', { missing: ['kernel.ops'] }),
      rec('erb-parser', 'error', { error: 'activate 失败：service "x" not found' }),
    ]);
    const list = rows();
    expect(list).toHaveLength(3);
    expect(rowIds(list)).toEqual(['ui-kojo-navigator', 'ui-market', 'erb-parser']);
    expect(list.every((r) => r.classList.contains('plugin-row'))).toBe(true);

    await focusOn(panelRoot());
    let e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]); // 焦点不在行上 ⇒ ↓ 从第一行走
    e = await press('ArrowUp');
    expect(document.activeElement).toBe(list[2]); // ↑ 从第一行回绕到最后一行
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[0]);

    expect(retrySpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('F8/Shift+F4 只移动焦点并敲这一行：行上没有左键动作 ⇒ 一条新通路都不许多出来', async () => {
    await activateWith([rec('a-plugin', 'active'), rec('b-plugin', 'error', { error: '炸了' })]);
    const list = rows();
    await focusOn(list[0]!);

    const e = await press('F8');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[1]); // 走到下一行
    // 重试/停用/复制仍是行级右键菜单的既有通路：键盘导航不许替它们发第二次动作
    expect(retrySpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    // 也没顺手展开那一条错误详情（`details` 的开合归它自己的 summary，行导航不碰）
    expect(container.querySelector('details.plugin-error-details')?.hasAttribute('open')).toBe(false);

    await press('F4', { shiftKey: true });
    expect(document.activeElement).toBe(list[0]);
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it('没画出来的东西不在名单：错误行的 summary 与详情体都不是行；空清单不吞键', async () => {
    await activateWith([rec('only-plugin', 'error', { error: 'activate 失败\n第二行上下文' })]);
    const list = rows();
    expect(list).toHaveLength(1);
    expect(list[0]!.getAttribute('data-panel-row')).toBe('');
    // 错误行有 `details` 两件（summary 与详情体，默认收起）——它们不是行，
    // 混进名单就会让 ↑↓ 在同一条上原地打转
    expect(container.querySelector('.plugin-error-details')).toBeTruthy();
    expect(container.querySelector('summary.plugin-error')?.getAttribute('data-panel-row')).toBeNull();
    expect(container.querySelector('.plugin-error-full')?.getAttribute('data-panel-row')).toBeNull();

    await activateWith([]);
    expect(rows()).toHaveLength(0);
    await focusOn(panelRoot());
    const e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(false); // 空集合 = 原样让位（空清单那句降级文案不是行）
  });

  it('合成期（isComposing / keyCode 229）一律放行；Enter/Tab/Escape/← 不被行导航吞掉', async () => {
    await activateWith([rec('a-plugin', 'active'), rec('b-plugin', 'active')]);
    const list = rows();
    await focusOn(list[1]!);

    const e1 = await press('ArrowDown', { isComposing: true });
    expect(e1.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(list[1]);
    const e2 = await press('ArrowDown', { keyCode: 229 });
    expect(e2.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(list[1]);

    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowLeft']) {
      const e = await press(key);
      expect(e.defaultPrevented, key).toBe(false);
      expect(document.activeElement, key).toBe(list[1]);
    }
    expect(retrySpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('roving tabindex：整段名单只留一枚 0，鼠标式编程聚焦也对齐（焦点可见走全局 --focus-ring，零新色）', async () => {
    await activateWith([rec('a-plugin', 'active'), rec('b-plugin', 'inactive'), rec('c-plugin', 'active')]);
    const tabbable = () => rows().filter((r) => r.tabIndex === 0);
    expect(tabbable()).toHaveLength(1); // 挂载后兜底第一行

    await focusOn(rows()[2]!); // 编程式聚焦 ⇒ 容器 focus 腿对齐
    expect(tabbable()).toEqual([rows()[2]]);

    await press('ArrowUp'); // 键盘移动焦点 ⇒ 判据层就地办结
    expect(tabbable()).toEqual([rows()[1]]);
    expect(rows()[0]!.tabIndex).toBe(-1);
    expect(rows()[2]!.tabIndex).toBe(-1);
  });
});
