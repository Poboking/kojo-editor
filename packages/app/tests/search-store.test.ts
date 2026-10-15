import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchRequest, SearchResult } from '../src/bridge/search';
import {
  clearSearchResult,
  requestSearchFocus,
  resetSearch,
  runSearch,
  setExtensionText,
  setQuery,
  setSearchCanceller,
  setSearchRunner,
  snapshot,
  stopSearch,
  subscribe,
  toggleOption,
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
