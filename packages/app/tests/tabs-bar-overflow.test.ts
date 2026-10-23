// @vitest-environment happy-dom
/**
 * 标签栏溢出 affordance 的行为面（L16）——SSR 形状锁在 `tabs-bar.test.ts`，这里钉的是
 * **真溢出**那一帧：
 *  ① ResizeObserver 在位：测得 `scrollWidth > clientWidth` ⇒ 左/右箭头 + 「列出全部标签」▾
 *     进 DOM（普通 button ⇒ Tab 可达、Enter/Space 原生触发；无障碍名是成人话）；
 *  ② **没有** ResizeObserver 的环境走回退腿（window resize + 标签变化重测），不许静默不渲染；
 *  ③ ▾ 不新造业务路径：开的是既有 `tab-bar-blank` 组的「标签列表」（点选即 `onActivateTab`），
 *     走根宿主固定层（`context-menu-host` 的模块 store 就是判据）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabBar } from '../src/ui/tabs-bar';
import { closeContextMenu, getContextMenuState } from '../src/ui/context-menu-host';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABS = ['C:/koa/p.ERB', 'C:/koa/q.ERB', 'C:/koa/r.ERB'];
const EMPTY_SET: ReadonlySet<string> = new Set();

const barProps = {
  openTabs: TABS,
  activeFile: 'C:/koa/q.ERB' as string | null,
  dirtyPaths: EMPTY_SET,
  pinnedPaths: EMPTY_SET,
  onActivateTab: () => {},
  onRequestCloseTab: () => {},
  onReorderTab: () => {},
  onTogglePin: () => {},
  onBatchCloseTab: () => {},
  onSaveAllClick: () => {},
  hasDirty: false,
};

/** 把滚动口测成"内容 500 / 可视 100"（happy-dom 无布局，宽度只能按实例钉） */
function forceOverflow(el: HTMLElement): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => 500 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 100 });
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  closeContextMenu();
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLElement> {
  root = createRoot(container);
  await act(async () => {
    root.render(h(TabBar, barProps));
  });
  return container.querySelector('.editor-tabs') as HTMLElement;
}

describe('TabBar · 溢出工具族（ResizeObserver 在位）', () => {
  it('测得溢出 ⇒ 三枚按钮进 DOM；未溢出 ⇒ 零节点', async () => {
    const roCallbacks: Array<() => void> = [];
    class FakeRO {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
    try {
      const el = await mount();
      // 首帧（宽度 0/0）不溢出：DOM 里一枚都没有
      expect(container.querySelector('.tab-overflow-tools')).toBeNull();
      forceOverflow(el);
      await act(async () => {
        for (const cb of roCallbacks) cb();
      });
      const tools = container.querySelector('.tab-overflow-tools');
      expect(tools).not.toBeNull();
      const labels = [...container.querySelectorAll('button[aria-label]')].map((b) =>
        b.getAttribute('aria-label'),
      );
      expect(labels).toContain('向左滚动标签页');
      expect(labels).toContain('向右滚动标签页');
      expect(labels).toContain('列出全部标签');
      // 键盘可达：三枚都是原生 button（Tab 停得住、Enter/Space 浏览器自己触发）
      for (const b of tools!.querySelectorAll('button')) expect(b.tagName).toBe('BUTTON');
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  it('右箭头点击：scrollBy 缺席的环境退化直写 scrollLeft（不许按了没反应）', async () => {
    const roCallbacks: Array<() => void> = [];
    class FakeRO {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
    try {
      const el = await mount();
      forceOverflow(el);
      await act(async () => {
        for (const cb of roCallbacks) cb();
      });
      // 显式造出"无 scrollBy"的退化环境（真实 WebView2 走平滑分支）
      (el as { scrollBy?: unknown }).scrollBy = undefined;
      const right = container.querySelector('button[aria-label="向右滚动标签页"]') as HTMLElement;
      await act(async () => {
        right.click();
      });
      expect(el.scrollLeft).toBe(80); // clientWidth(100) * 0.8
      const left = container.querySelector('button[aria-label="向左滚动标签页"]') as HTMLElement;
      await act(async () => {
        left.click();
      });
      expect(el.scrollLeft).toBe(0);
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  it('▾ 列出全部标签：开的是既有「标签列表」（根宿主固定层），点项走激活', async () => {
    const roCallbacks: Array<() => void> = [];
    class FakeRO {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
    try {
      const el = await mount();
      forceOverflow(el);
      await act(async () => {
        for (const cb of roCallbacks) cb();
      });
      const list = container.querySelector('button[aria-label="列出全部标签"]') as HTMLElement;
      await act(async () => {
        list.click();
      });
      const request = getContextMenuState().request;
      expect(request).not.toBeNull();
      expect(request!.ariaLabel).toBe('标签列表');
      expect(request!.items.map((i) => i.id)).toEqual(['tab-list:0', 'tab-list:1', 'tab-list:2']);
      expect(request!.items.map((i) => i.label)).toContain('切换到 q.ERB');
      // 选中一项 = 既有激活通道（onActivateTab），不新造第二条腿
      const activate = vi.fn();
      await act(async () => {
        root.render(h(TabBar, { ...barProps, onActivateTab: activate }));
      });
      await act(async () => {
        container.querySelector('button[aria-label="列出全部标签"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const opened = getContextMenuState().request;
      expect(opened).not.toBeNull();
      await act(async () => {
        opened!.onSelect('tab-list:1');
      });
      expect(activate).toHaveBeenCalledWith('C:/koa/q.ERB');
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });
});

describe('TabBar · 无 ResizeObserver 的回退腿', () => {
  it('RO 缺席时窗口 resize 也要把箭头测出来（不许静默不渲染）', async () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const el = await mount();
    expect(container.querySelector('.tab-overflow-tools')).toBeNull();
    forceOverflow(el);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(container.querySelector('.tab-overflow-tools')).not.toBeNull();
  });
});
