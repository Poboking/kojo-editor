import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchRequest, SearchResult } from '../src/bridge/search';
import {
  clearSearchResult,
  requestReplaceFocus,
  requestSearchFocus,
  resetSearch,
  runReplace,
  runSearch,
  setExtensionText,
  setQuery,
  setReplaceRunner,
  setReplaceText,
  setSearchCanceller,
  setSearchRunner,
  snapshot,
  stopSearch,
  subscribe,
  toggleOption,
  type ReplaceOutcome,
  type ReplaceRunner,
  type SearchRunner,
} from '../src/ui/search-store';

/**
 * 检索状态机单测（2026-10-15 检索批）。
 *
 * 钉的是状态迁移而不是渲染：①前置校验失败就地落 error 且**不发请求**；
 * ②请求体由当前条件快照拼出（查询原文、三个开关、过滤框解析出的扩展名）；
 * ③单飞 + 迟到结果丢弃（旧检索的进度与返回值都不许覆盖新状态）；
 * ④停止只发取消意图、状态留 running 直到后端如实回报——提前说"搜完了"就是撒谎。
 */

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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ROOTS = ['C:\\game'];

describe('search-store', () => {
  beforeEach(() => {
    resetSearch();
    setSearchCanceller(null);
    setSearchRunner(null);
  });
  afterEach(() => {
    setSearchRunner(null);
    setSearchCanceller(null);
    resetSearch();
  });

  it('初始态：idle、条件有缺省值、无结果无错误', () => {
    const s = snapshot();
    expect(s.phase).toBe('idle');
    expect(s.result).toBeNull();
    expect(s.error).toBeNull();
    expect(s.progress).toBeNull();
    expect(s.options).toEqual({ isRegex: false, caseSensitive: false, wholeWord: false });
    expect(s.extensionText.length).toBeGreaterThan(0);
  });

  it('空查询：落 error、不发请求', async () => {
    const runner = vi.fn<SearchRunner>();
    setSearchRunner(runner);
    setQuery('   ');
    await runSearch(ROOTS);
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot().phase).toBe('error');
    expect(snapshot().error).toContain('检索词');
  });

  it('无根目录：落 error、不发请求（检索范围为空不是"零结果"）', async () => {
    const runner = vi.fn<SearchRunner>();
    setSearchRunner(runner);
    setQuery('abc');
    await runSearch([]);
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot().error).toContain('根目录');
  });

  it('请求体由当前条件拼出：查询原文 + 三个开关 + 过滤框解析出的扩展名', async () => {
    const runner = vi.fn<SearchRunner>(async () => result({ totalMatches: 1 }));
    setSearchRunner(runner);
    setQuery('口上');
    toggleOption('isRegex');
    toggleOption('wholeWord');
    setExtensionText('.ERB, csv erb');
    await runSearch(ROOTS);
    expect(runner).toHaveBeenCalledTimes(1);
    const req = runner.mock.calls[0]![0] as SearchRequest;
    expect(req.query).toBe('口上');
    expect(req.roots).toEqual(ROOTS);
    expect(req.options).toEqual({
      isRegex: true,
      caseSensitive: false,
      wholeWord: true,
      extensions: ['csv', 'erb'],
    });
    expect(req.searchId).toBeGreaterThan(0);
  });

  it('成功路径：running → done，进度在途中可见、收尾清空', async () => {
    const d = deferred<SearchResult>();
    let seen: string[] = [];
    const un = subscribe(() => seen.push(snapshot().phase));
    setSearchRunner((_req, onProgress) => {
      onProgress({ searchId: snapshot().searchId, filesScanned: 50, totalFiles: 200, matchCount: 3 });
      return d.promise;
    });
    setQuery('abc');
    const p = runSearch(ROOTS);
    expect(snapshot().phase).toBe('running');
    expect(snapshot().progress?.filesScanned).toBe(50);
    expect(snapshot().result).toBeNull();

    d.resolve(result({ totalMatches: 3, filesScanned: 200 }));
    await p;
    expect(snapshot().phase).toBe('done');
    expect(snapshot().result?.totalMatches).toBe(3);
    expect(snapshot().progress).toBeNull();
    expect(seen).toContain('running');
    un();
  });

  it('失败路径：error 态带原因，旧结果不留', async () => {
    setSearchRunner(async () => {
      throw new Error('正则无效：unclosed group');
    });
    setQuery('a(');
    await runSearch(ROOTS);
    expect(snapshot().phase).toBe('error');
    expect(snapshot().error).toContain('正则无效');
    expect(snapshot().result).toBeNull();
  });

  it('单飞：正在跑时重复发起直接忽略', async () => {
    const d = deferred<SearchResult>();
    const runner = vi.fn<SearchRunner>(() => d.promise);
    setSearchRunner(runner);
    setQuery('abc');
    const first = runSearch(ROOTS);
    await runSearch(ROOTS);
    expect(runner).toHaveBeenCalledTimes(1);
    d.resolve(result());
    await first;
    expect(snapshot().phase).toBe('done');
  });

  it('迟到结果丢弃：期间面板被重置，旧检索的返回值不许写回', async () => {
    const d = deferred<SearchResult>();
    setSearchRunner(() => d.promise);
    setQuery('abc');
    const p = runSearch(ROOTS);
    resetSearch();
    d.resolve(result({ totalMatches: 9 }));
    await p;
    expect(snapshot().phase).toBe('idle');
    expect(snapshot().result).toBeNull();
  });

  it('停止：只发取消意图，状态留 running 直到后端如实回报 cancelled', async () => {
    const d = deferred<SearchResult>();
    const cancelled: number[] = [];
    setSearchCanceller(async (id) => {
      cancelled.push(id);
    });
    setSearchRunner(() => d.promise);
    setQuery('abc');
    const p = runSearch(ROOTS);
    const id = snapshot().searchId;
    await stopSearch();
    expect(cancelled).toEqual([id]);
    expect(snapshot().phase).toBe('running');

    d.resolve(result({ cancelled: true, totalMatches: 1 }));
    await p;
    expect(snapshot().phase).toBe('done');
    expect(snapshot().result?.cancelled).toBe(true);
  });

  it('非 running 态调停止：什么都不做（不产生取消请求）', async () => {
    const canceller = vi.fn(async () => {});
    setSearchCanceller(canceller);
    await stopSearch();
    expect(canceller).not.toHaveBeenCalled();
  });

  it('清空结果：非运行态清掉结果与错误、保留条件，运行态不动', async () => {
    const d = deferred<SearchResult>();
    setSearchRunner(() => d.promise);
    setQuery('abc');
    const p = runSearch(ROOTS);
    clearSearchResult();
    // 运行中不许清：后端还在算，清掉的结果位会被随后的返回值重新填上，白闪一次
    expect(snapshot().phase).toBe('running');
    d.resolve(result({ totalMatches: 1 }));
    await p;
    clearSearchResult();
    expect(snapshot().result).toBeNull();
    expect(snapshot().phase).toBe('idle');
    expect(snapshot().query).toBe('abc');
  });

  it('焦点请求：每次命令入口命中都自增（面板据此重新聚焦）', () => {
    const before = snapshot().focusNonce;
    requestSearchFocus();
    requestSearchFocus();
    expect(snapshot().focusNonce).toBe(before + 2);
  });

  it('重置：回到初始条件（焦点计数保留，不影响输入框行为）', () => {
    setQuery('abc');
    toggleOption('caseSensitive');
    const nonce = snapshot().focusNonce;
    resetSearch();
    expect(snapshot().query).toBe('');
    expect(snapshot().options.caseSensitive).toBe(false);
    expect(snapshot().phase).toBe('idle');
    expect(snapshot().focusNonce).toBe(nonce);
  });
});

describe('search-store 替换状态机（R7 搜索替换批）', () => {
  beforeEach(() => {
    resetSearch();
    setSearchRunner(null);
    setReplaceRunner(null);
  });
  afterEach(() => {
    setSearchRunner(null);
    setReplaceRunner(null);
    resetSearch();
  });

  const outcome = (over: Partial<ReplaceOutcome> = {}): ReplaceOutcome => ({
    applied: 0,
    filesChanged: 0,
    stale: 0,
    readOnlyFiles: 0,
    errors: [],
    ...over,
  });

  it('没有完成态结果时拒绝并明示', async () => {
    const runner = vi.fn<ReplaceRunner>();
    setReplaceRunner(runner);
    setQuery('abc');
    const o = await runReplace({ kind: 'all' });
    expect(o).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot().replaceSummary).toContain('没有可替换的检索结果');
  });

  it('截断/被停止的结果拒绝全部替换（对看不见的命中动手 = 替换面失真）', async () => {
    setSearchRunner(async () => result({ truncated: true, totalMatches: 1 }));
    setQuery('abc');
    await runSearch(ROOTS);
    const runner = vi.fn<ReplaceRunner>();
    setReplaceRunner(runner);
    const o = await runReplace({ kind: 'all' });
    expect(o).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot().replaceSummary).toContain('结果不完整');
  });

  it('成功路径：请求体带条件快照与结果文件，返回读数、汇总上屏', async () => {
    setSearchRunner(async () =>
      result({ totalMatches: 2, files: [{ path: 'C:\\game\\a.erb', matches: [] }] }),
    );
    setQuery('口上');
    toggleOption('wholeWord');
    setReplaceText('新词');
    await runSearch(ROOTS);
    let seenReq: unknown = null;
    setReplaceRunner(async (req) => {
      seenReq = req;
      return outcome({ applied: 3, filesChanged: 1 });
    });
    const o = await runReplace({ kind: 'all' });
    expect(o).toEqual({ applied: 3, filesChanged: 1, stale: 0, readOnlyFiles: 0, errors: [] });
    expect(snapshot().replaceRunning).toBe(false);
    expect(snapshot().replaceSummary).toContain('已替换 3 处');
    const req = seenReq as Parameters<ReplaceRunner>[0];
    expect(req.query).toBe('口上');
    expect(req.options.wholeWord).toBe(true);
    expect(req.replaceText).toBe('新词');
    expect(req.files).toEqual([{ path: 'C:\\game\\a.erb', matches: [] }]);
  });

  it('在途锁：替换中重复发起直接忽略', async () => {
    setSearchRunner(async () => result({ totalMatches: 1 }));
    setQuery('abc');
    await runSearch(ROOTS);
    const d = deferred<ReplaceOutcome>();
    setReplaceRunner(() => d.promise);
    const first = runReplace({ kind: 'all' });
    const second = await runReplace({ kind: 'all' });
    expect(second).toBeNull();
    d.resolve(outcome());
    expect(await first).toEqual(outcome());
  });

  it('执行者抛错：失败原因上屏，在途态解除', async () => {
    setSearchRunner(async () => result({ totalMatches: 1 }));
    setQuery('abc');
    await runSearch(ROOTS);
    setReplaceRunner(async () => {
      throw new Error('写允许域拒绝');
    });
    await runReplace({ kind: 'all' });
    expect(snapshot().replaceSummary).toContain('替换失败');
    expect(snapshot().replaceRunning).toBe(false);
  });

  it('替换框焦点请求：命令入口命中即自增', () => {
    const before = snapshot().replaceFocusNonce;
    requestReplaceFocus();
    expect(snapshot().replaceFocusNonce).toBe(before + 1);
  });
});
