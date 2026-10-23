// @vitest-environment happy-dom
/**
 * PS-16 memo 判据（渲染计数，零墙钟断言 ⇒ 留在功能池）。
 *
 * 计数法与 `file-tree-memo.test.ts` 同款：mock 计数透传层，count++ 只在 memo 放行后发生。
 * 判据 = "壳层无关重渲停在标签栏门口"（TabBar 组件级）+ "菜单/活动切换只重画命中行"
 * （TabRow 行级）。对照组钉住语义边界：宿主每帧传新回调 ⇒ memo 必失效——
 * ProjectView 装配处的 callbacksFor 稳定化因此是**必要条件**，不是锦上添花。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement as h, memo, useMemo, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabBar, type TabBarProps } from '../src/ui/tabs-bar';
import type { TabRowProps } from '../src/ui/tab-row';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';

const counts = vi.hoisted(() => ({ tabBar: 0, tabRow: 0 }));

vi.mock('../src/ui/tabs-bar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/tabs-bar')>();
  return {
    ...actual,
    TabBar: memo((props: TabBarProps): ReactElement => {
      counts.tabBar++;
      // memo 包装产物是组件对象不是函数 ⇒ 元素化交回 React（内层 memo 比较照跑）
      return h(actual.TabBar, props);
    }),
  };
});
vi.mock('../src/ui/tab-row', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/tab-row')>();
  return {
    ...actual,
    TabRow: memo((props: TabRowProps): ReactElement => {
      counts.tabRow++;
      return h(actual.TabRow, props);
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABS = ['C:/koa/p.ERB', 'C:/koa/q.ERB', 'C:/koa/r.ERB'];
const EMPTY_SET: ReadonlySet<string> = new Set();
/** 模块级恒定（ onSaveAllClick 也是 memo 比较面的一环，引用必须钉死） */
const SAVE_ALL = (): void => {};
const CLOSE_BATCH = (): void => {};
const CLOSE_TAB = (_p: string): void => {};
const REORDER = (_p: string, _to: number): void => {};
const TOGGLE_PIN = (_p: string): void => {};

/** 恒定回调集（ProjectView `callbacksFor` 的等价形态：useMemo 一次造、引用不换） */
function useStableCbs() {
  return useMemo(
    () => ({
      onActivateTab: (_p: string) => {},
      onRequestCloseTab: CLOSE_TAB,
      onReorderTab: REORDER,
      onTogglePin: TOGGLE_PIN,
      onBatchCloseTab: CLOSE_BATCH,
    }),
    [],
  );
}

const barProps = (activeFile: string | null) => ({
  openTabs: TABS,
  activeFile,
  dirtyPaths: EMPTY_SET,
  pinnedPaths: EMPTY_SET,
  onSaveAllClick: SAVE_ALL,
  hasDirty: false,
});

/** 壳层无关 state 的等价形态：harness 自持一个与 TabBar 无关的 state，翻转它 */
function FlipHarness({ active }: { active: string | null }) {
  const cbs = useStableCbs();
  const [n, setN] = useState(0);
  return h(
    'div',
    null,
    h(TabBar, { ...barProps(active), ...cbs }),
    h('button', { 'data-flip': '1', onClick: () => setN(n + 1) }, `flip ${n}`),
  );
}

describe('TabBar · PS-16 memo（渲染计数）', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    counts.tabBar = 0;
    counts.tabRow = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it('壳层无关 state 翻转 N 次 ⇒ TabBar 执行次数不变（恒定回调 = 生效前提）', async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(h(FlipHarness, { active: 'C:/koa/q.ERB' }));
    });
    const base = counts.tabBar;
    expect(base).toBeGreaterThan(0);
    const flipBtn = () => container.querySelector('[data-flip="1"]') as HTMLElement;
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        flipBtn().click();
      });
    }
    expect(counts.tabBar).toBe(base);
    expect(counts.tabRow).toBe(3); // 仅首挂渲染过 3 枚行，翻转帧一枚都不重画
  });

  it('右键 ⇒ 标签栏内部一次都不重渲（1023：菜单改由根宿主渲染，行上不再有本地 state）', async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(h(FlipHarness, { active: 'C:/koa/q.ERB' }));
    });
    const base = { ...counts };
    const row = container.querySelector('[role="tab"]') as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    // 旧实现：右键写本地菜单 state ⇒ TabBar 重渲、行不重画；本批起菜单走根宿主，
    // TabBar 连自己重渲都不需要了——两枚计数都不动，等于「右键对标签栏零影响」。
    expect(counts.tabBar).toBe(base.tabBar);
    expect(counts.tabRow).toBe(base.tabRow);
    // 防假绿：这条右键确实能被根路由接走（不是"事件没人管"）
    const route = buildContextMenuRoute(row, new MouseEvent('contextmenu', { bubbles: true }));
    expect(route?.items.length ?? 0).toBeGreaterThan(0);
  });

  it('activeFile 切换 ⇒ 只有新旧两枚标签重画', async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(h(FlipHarness, { active: 'C:/koa/p.ERB' }));
    });
    const base = counts.tabRow;
    await act(async () => {
      root.render(h(FlipHarness, { active: 'C:/koa/r.ERB' }));
    });
    expect(counts.tabRow - base).toBe(2);
  });

  it('对照组：宿主每帧传新回调（旧装配形态）⇒ TabBar memo 失效——钉住父侧稳定化是必要条件', async () => {
    root = createRoot(container);
    // 除 onActivateTab 外全部恒定 ⇒ 放行与否只归因于这一条回调的引用
    const once = { ...barProps('C:/koa/q.ERB'), onRequestCloseTab: CLOSE_TAB, onReorderTab: REORDER, onTogglePin: TOGGLE_PIN, onBatchCloseTab: CLOSE_BATCH };
    await act(async () => {
      root.render(h(TabBar, { ...once, onActivateTab: (p: string) => void p }));
    });
    const base = counts.tabBar;
    await act(async () => {
      root.render(h(TabBar, { ...once, onActivateTab: (p: string) => void p }));
    });
    expect(counts.tabBar).toBe(base + 1); // 回调引用变了 ⇒ memo 正确地放行
  });
});