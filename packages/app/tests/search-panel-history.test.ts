// @vitest-environment happy-dom
/**
 * 检索框「最近检索」的键盘回溯（W7-E）。
 *
 * 静态渲染判据（`search-panel-render.test.ts`）够不到键盘：↑/↓ 的回溯、消费后
 * 不许再冒泡给行导航、以及"回车逐项跳的老路一个不少"都只在真实 DOM 事件上成立。
 * 本文件用 happy-dom 挂真面板，按真 `KeyboardEvent` 钉这四件：
 *   ① ↑ 从草稿进入历史最新一条，继续 ↑ 往更旧走；
 *   ② ↓ 往回走，退到最新一条再按 = 还原草稿（不是停在旧词上）；
 *   ③ 消费掉的 ↑↓ 不再触发面板根上的结果行导航（焦点仍留在输入框）；
 *   ④ 没有历史 / 还没进入回溯时的 ↓ 原样让给行导航（焦点进第一行）；
 *   ⑤ 回溯后按回车仍走既有的「逐项跳」（不是重搜）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SearchMatch, SearchResult } from '../src/bridge/search';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, runSearch, setQuery, setSearchRunner } from '../src/ui/search-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  files: [],
  totalMatches: 0,
  truncated: false,
  cancelled: false,
  filesScanned: 0,
  skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
  elapsedMs: 0,
  ...over,
});

const hit = (line: number): SearchMatch => ({ line, column: 1, preview: 'ABC', start: 0, end: 3 });

const ROOTS = ['C:\\game'];

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  resetSearch();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  setSearchRunner(null);
  resetSearch();
  localStorage.clear();
});

/** 走一遍完整检索（历史只在真发起检索时记），最后把输入框清空/换成草稿 */
async function primeHistory(queries: readonly string[], res: SearchResult = result()): Promise<void> {
  setSearchRunner(async () => res);
  for (const q of queries) {
    setQuery(q);
    await runSearch(ROOTS);
  }
}

async function mountPanel(
  onReveal: (path: string, line: number, span?: unknown) => void = () => {},
): Promise<HTMLInputElement> {
  root = createRoot(container);
  await act(async () => {
    root!.render(h(SearchPanel, { roots: ROOTS, onReveal }));
  });
  const input = container.querySelector<HTMLInputElement>('input.search-input');
  expect(input).not.toBeNull();
  return input!;
}

async function press(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('SearchPanel 检索框 ↑/↓ 回溯最近检索', () => {
  it('↑ 从草稿进最新、继续往更旧；↓ 往回走，退到最新再按还原草稿', async () => {
    await primeHistory(['alpha', 'beta']);
    setQuery('草稿');
    const input = await mountPanel();
    expect(input.value).toBe('草稿');

    await press(input, 'ArrowUp');
    expect(input.value).toBe('beta');
    await press(input, 'ArrowUp');
    expect(input.value).toBe('alpha');
    // 最旧一条：再 ↑ 停在原地
    await press(input, 'ArrowUp');
    expect(input.value).toBe('alpha');

    await press(input, 'ArrowDown');
    expect(input.value).toBe('beta');
    await press(input, 'ArrowDown');
    expect(input.value).toBe('草稿');
  });

  it('消费掉的 ↑ 不触发结果行导航：焦点仍留在输入框', async () => {
    await primeHistory(['alpha'], result({ totalMatches: 1, files: [{ path: 'C:\\game\\a.erb', matches: [hit(2)] }] }));
    setQuery('');
    const input = await mountPanel();
    input.focus();
    await press(input, 'ArrowUp');
    expect(input.value).toBe('alpha');
    // 若 ↑ 冒泡到面板根，`panel-row-nav` 会把焦点挪到结果行上
    expect(document.activeElement).toBe(input);
  });

  it('没有历史时的 ↑ / 还没进入回溯时的 ↓ 不消费：文本不动', async () => {
    const input = await mountPanel();
    await press(input, 'ArrowUp');
    expect(input.value).toBe('');
    await press(input, 'ArrowDown');
    expect(input.value).toBe('');
  });

  it('未进入回溯时的 ↓ 仍走既有行导航（焦点进结果第一行）', async () => {
    await primeHistory(['alpha'], result({ totalMatches: 1, files: [{ path: 'C:\\game\\a.erb', matches: [hit(2)] }] }));
    setQuery('');
    const input = await mountPanel();
    input.focus();
    await press(input, 'ArrowDown');
    // 历史在，但还没按过 ↑ ⇒ ↓ 不归历史管，行导航照旧
    expect(input.value).toBe('');
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement?.getAttribute('data-panel-row')).toBe('');
  });

  it('回溯后回车仍走既有「逐项跳」，不重搜', async () => {
    const seen = vi.fn();
    await primeHistory(['alpha'], result({ totalMatches: 1, files: [{ path: 'C:\\game\\a.erb', matches: [hit(2)] }] }));
    setQuery('');
    const input = await mountPanel(seen);
    await press(input, 'ArrowUp');
    expect(input.value).toBe('alpha');
    await press(input, 'Enter');
    expect(seen).toHaveBeenCalledTimes(1);
    // 第三条是落点区间（`searchMatchSpan` 的既有口径）；这里只钉"跳到了那一条"
    expect(seen.mock.calls[0]?.[0]).toBe('C:\\game\\a.erb');
    expect(seen.mock.calls[0]?.[1]).toBe(2);
  });
});
