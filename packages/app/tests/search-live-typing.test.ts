// @vitest-environment happy-dom
/**
 * 打字即搜（P2-11）的**落定补搜**（2026-10-20 修复用户反馈"第二次打字搜不出来"）。
 *
 * 缺陷形态：单飞把"运行中改词"那次防抖静默丢掉、且永不补发。结果随到随画
 * （`phase` 仍是 running 时首批命中已经在画），作者看到命中就改词时，新词的那次
 * 防抖正撞在 running 上被丢——屏幕停在旧词的结果（看着像"一条都搜不出来"），
 * 只有再点搜索钮（那时早已 done）才动。
 *
 * 判据（happy-dom 挂真面板，`vi.useFakeTimers` 走防抖）：
 *   ① 顺序（前一次已完成）：改词后照旧触发；
 *   ② **重叠（前一次仍在跑）：改词不丢，跑完自动补搜**——本文件的核心回归；
 *   ③ 补搜不自我循环：一次落定后不再无端重发（稳定）；
 *   ④ 关掉"打字即搜"开关：既不触发、也不补搜（设置不被 store 绕开）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SearchResult } from '../src/bridge/search';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, setQuery, setSearchRunner } from '../src/ui/search-store';

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
  vi.useRealTimers();
});

async function mount(): Promise<HTMLInputElement> {
  root = createRoot(container);
  await act(async () => {
    root!.render(h(SearchPanel, { roots: ROOTS, onReveal: () => {} }));
  });
  const input = container.querySelector<HTMLInputElement>('input.search-input');
  expect(input, '检索输入框必须在场').not.toBeNull();
  return input!;
}

/** 键入一项（直接走 store 的 `setQuery`，与输入框 onChange 同一条数据面）并等过防抖窗 */
async function type(query: string): Promise<void> {
  await act(async () => {
    setQuery(query);
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

/** 记录每次检索用的查询原文；`release` 用于控制"这一次检索何时收口" */
function recordingRunner(): { queries: string[]; release: () => void } {
  const queries: string[] = [];
  let release: () => void = () => {};
  setSearchRunner(
    (req) =>
      new Promise<SearchResult>((resolve) => {
        queries.push(req.query);
        release = () => resolve(result({ totalMatches: 1 }));
      }),
  );
  return { queries, release: () => release() };
}

describe('检索面板「打字即搜」', () => {
  it('顺序（前一次已完成）：改词后照旧触发', async () => {
    vi.useFakeTimers();
    const { queries, release } = recordingRunner();
    await mount();

    await type('abc');
    expect(queries, '第一次已发起').toEqual(['abc']);
    await act(async () => {
      release();
    });

    await type('abcd');
    expect(queries, '第二次（顺序）已发起').toEqual(['abc', 'abcd']);
  });

  it('重叠（前一次仍在跑）：改词不丢，跑完自动补搜一次', async () => {
    vi.useFakeTimers();
    const { queries, release } = recordingRunner();
    await mount();

    await type('abc');
    expect(queries).toEqual(['abc']);

    // 第一次仍在跑时改词：这一次防抖被单飞挡下（不发），但**不许丢**
    await type('abcd');
    expect(queries, '运行中不重发（单飞）').toEqual(['abc']);

    // 第一次收口 ⇒ 补搜把当前词补上
    await act(async () => {
      release();
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(queries, '落定后应补搜当前词').toEqual(['abc', 'abcd']);
  });

  it('补搜不自我循环：落定且结果已对应当前词后，不再无端重发', async () => {
    vi.useFakeTimers();
    const { queries, release } = recordingRunner();
    await mount();

    await type('abc');
    await act(async () => {
      release();
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(queries, '只搜过一次，不因相位落定反复重发').toEqual(['abc']);
  });

  it('关掉「打字即搜」：既不触发、也不补搜', async () => {
    vi.useFakeTimers();
    const { queries, release } = recordingRunner();
    await mount();
    const box = container.querySelector<HTMLInputElement>('input.search-live');
    expect(box, '「打字即搜」开关必须在场').not.toBeNull();
    await act(async () => {
      box!.click();
    });
    expect(box!.checked).toBe(false);

    await type('abc');
    expect(queries, '开关关掉后打字不检索').toEqual([]);

    // 手动发起一次（模拟回车），运行中改词也不该自动补搜
    await act(async () => {
      setQuery('abc');
    });
    expect(queries).toEqual([]);
    await act(async () => {
      release();
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(queries, '关掉开关后补搜也不发生').toEqual([]);
  });
});
