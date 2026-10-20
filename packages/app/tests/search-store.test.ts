import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchMatch, SearchRequest, SearchResult } from '../src/bridge/search';
import { SEARCH_HISTORY_LIMIT, setGlobFilterText } from '../src/ui/search-query';
import {
  clearSearchResult,
  requestReplaceFocus,
  requestSearchFocus,
  resetSearch,
  runReplace,
  runSearch,
  selectSearchMatch,
  setExtensionText,
  setQuery,
  setReplaceRunner,
  setReplaceText,
  setSearchCanceller,
  setSearchRunner,
  setSearchSortMode,
  snapshot,
  stepSearchHistory,
  stepSearchMatch,
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

const hit = (line: number, column = 1): SearchMatch => ({
  line,
  column,
  preview: 'ABC',
  start: 0,
  end: 3,
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

/** 内存版 Storage：node 测试环境没有 localStorage，stub 一份即可验证读写与坏值回落 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('search-store', () => {
  beforeEach(() => {
    resetSearch();
    setSearchCanceller(null);
    setSearchRunner(null);
    // glob 文本住 `search-query` 模块级（跨面板存活）：逐测清空，别让上一条的 glob 漏进来
    setGlobFilterText('');
  });
  afterEach(() => {
    setSearchRunner(null);
    setSearchCanceller(null);
    resetSearch();
    setGlobFilterText('');
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

  it('glob 框非空：请求 options.globs 带上解析后的 glob（与 extensions 各自一维）', async () => {
    const runner = vi.fn<SearchRunner>(async () => result());
    setSearchRunner(runner);
    setQuery('abc');
    setExtensionText('erb');
    // 混进一个非 glob 词（`.kojo` 不含 * ? /）：它属于「类型」框，不该进 globs，
    // 也不该从 glob 框倒灌进 extensions（extensions 仍只认「类型」框）
    setGlobFilterText('*.kojo, src/**/*.erb, .kojo');
    await runSearch(ROOTS);
    const req = runner.mock.calls[0]![0] as SearchRequest;
    expect(req.options.globs).toEqual(['*.kojo', 'src/**/*.erb']);
    expect(req.options.extensions).toEqual(['erb']);
  });

  it('glob 框为空：请求里不出现 globs 键（老请求体逐字一致）', async () => {
    const runner = vi.fn<SearchRunner>(async () => result());
    setSearchRunner(runner);
    setQuery('abc');
    setExtensionText('erb, csv');
    await runSearch(ROOTS);
    const req = runner.mock.calls[0]![0] as SearchRequest;
    expect('globs' in req.options).toBe(false);
    expect(req.options).toEqual({
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      extensions: ['csv', 'erb'],
    });
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

describe('search-store 检索开关跨会话（VS Code 同款：选项不是一次性的）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetSearch();
    setSearchRunner(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSearchRunner(null);
    resetSearch();
  });

  it('三个开关写入 localStorage，重开后读回（大小写 / 全词 / 正则）', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    toggleOption('caseSensitive');
    toggleOption('wholeWord');
    // 真源是一份逐字可读的 JSON；关掉的开关也写 false，坏值不会凭"缺键"猜成开
    expect(JSON.parse(storage.getItem('kojo.ui.search.options.v1')!)).toEqual({
      isRegex: false,
      caseSensitive: true,
      wholeWord: true,
    });
    // 模拟下次启动：模块级 INITIAL 不在测试里重跑，走 resetSearch 的现读路径
    resetSearch();
    expect(snapshot().options).toEqual({ isRegex: false, caseSensitive: true, wholeWord: true });
  });

  it('存储值坏掉 / 形状不对 ⇒ 回默认全关（不静默把开关留在半开）', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('kojo.ui.search.options.v1', '{bad json');
    resetSearch();
    expect(snapshot().options).toEqual({ isRegex: false, caseSensitive: false, wholeWord: false });
    storage.setItem('kojo.ui.search.options.v1', JSON.stringify({ isRegex: 'yes', caseSensitive: 1 }));
    resetSearch();
    expect(snapshot().options).toEqual({ isRegex: false, caseSensitive: false, wholeWord: false });
  });

  it('localStorage 不可用（隐私模式 / 抛错）⇒ 开关照常工作，只是不落盘', () => {
    vi.stubGlobal('localStorage', {
      getItem(): string | null {
        throw new Error('SecurityError');
      },
      setItem(): void {
        throw new Error('SecurityError');
      },
    });
    resetSearch();
    expect(() => toggleOption('isRegex')).not.toThrow();
    expect(snapshot().options.isRegex).toBe(true);
  });
});

describe('search-store 结果逐项导航（第 X 项 / 共 Y 项 的数据面）', () => {
  beforeEach(() => {
    resetSearch();
    setSearchRunner(null);
  });
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  /** 两个文件按显示序（默认路径序）排：a.erb 两条、b.erb 一条 */
  async function primeThree(): Promise<void> {
    setSearchRunner(async () =>
      result({
        totalMatches: 3,
        files: [
          { path: 'C:\\game\\b.erb', matches: [hit(7)] },
          { path: 'C:\\game\\a.erb', matches: [hit(2), hit(5)] },
        ],
      }),
    );
    setQuery('ABC');
    await runSearch(ROOTS);
  }

  it('回车前进 / Shift+回车后退，按显示序且首尾回绕', async () => {
    await primeThree();
    // 还没导航：第一个 Enter 落在显示序第一项
    expect(stepSearchMatch(1)).toMatchObject({ path: 'C:\\game\\a.erb', match: { line: 2 } });
    expect(snapshot().matchCursor).toBe(0);
    expect(stepSearchMatch(1)).toMatchObject({ path: 'C:\\game\\a.erb', match: { line: 5 } });
    expect(stepSearchMatch(1)).toMatchObject({ path: 'C:\\game\\b.erb', match: { line: 7 } });
    // 末项再前进 ⇒ 回第一项；第一项后退 ⇒ 回末项
    expect(stepSearchMatch(1)).toMatchObject({ path: 'C:\\game\\a.erb', match: { line: 2 } });
    expect(stepSearchMatch(-1)).toMatchObject({ path: 'C:\\game\\b.erb', match: { line: 7 } });
  });

  it('首次 Shift+回车从末项开始（与行导航的 ↑ 同一条回绕尺子）', async () => {
    await primeThree();
    expect(stepSearchMatch(-1)).toMatchObject({ path: 'C:\\game\\b.erb', match: { line: 7 } });
    expect(snapshot().matchCursor).toBe(2);
  });

  it('查询改过 / 没有完成态结果 ⇒ 不拿陈旧结果导航（交给重搜）', async () => {
    await primeThree();
    setQuery('ABCD');
    expect(stepSearchMatch(1)).toBeNull();
    clearSearchResult();
    setQuery('ABC');
    expect(stepSearchMatch(1)).toBeNull();
  });

  it('重新检索与切换排序都复位当前项（旧游标不套到新序上）', async () => {
    await primeThree();
    stepSearchMatch(1);
    stepSearchMatch(1);
    expect(snapshot().matchCursor).toBe(1);
    setSearchSortMode('matches');
    expect(snapshot().matchCursor).toBe(-1);
    await runSearch(ROOTS);
    expect(snapshot().matchCursor).toBe(-1);
  });

  it('点中某一行（F4 / 鼠标同一条路）⇒ 当前项落在那一行', async () => {
    await primeThree();
    selectSearchMatch('C:\\game\\b.erb', 7, 1);
    expect(snapshot().matchCursor).toBe(2);
    selectSearchMatch('C:\\game\\a.erb', 5, 1);
    expect(snapshot().matchCursor).toBe(1);
    // 结果里没有的位置不猜
    selectSearchMatch('C:\\game\\a.erb', 99, 1);
    expect(snapshot().matchCursor).toBe(1);
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

describe('search-store 最近检索（W7-E：有效查询 / 去重 / 上限 / 跨会话）', () => {
  const HISTORY_KEY = 'kojo.ui.search.history.v1';

  beforeEach(() => {
    vi.unstubAllGlobals();
    resetSearch();
    setSearchRunner(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSearchRunner(null);
    resetSearch();
  });

  /** 走一遍完整检索（历史只在真发起检索时记） */
  async function search(query: string): Promise<void> {
    setQuery(query);
    await runSearch(ROOTS);
  }

  it('有效查询入史：最新在前、原文照存', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    setSearchRunner(async () => result({ totalMatches: 1 }));
    await search('口上');
    await search('口上 接吻');
    expect(snapshot().queryHistory).toEqual(['口上 接吻', '口上']);
    // 真源是一份逐字可读的 JSON 数组（与三开关同一套存法与键风格）
    expect(JSON.parse(storage.getItem(HISTORY_KEY)!)).toEqual(['口上 接吻', '口上']);
  });

  it('去重：同一条只留最新位置（再搜旧词 ⇒ 回到队首、不增条）', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    setSearchRunner(async () => result());
    await search('a');
    await search('b');
    await search('a');
    expect(snapshot().queryHistory).toEqual(['a', 'b']);
    expect(JSON.parse(storage.getItem(HISTORY_KEY)!)).toEqual(['a', 'b']);
  });

  it('上限：只留最近 N 条，更旧的被挤掉（存储同样只有 N 条）', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    setSearchRunner(async () => result());
    for (let i = 1; i <= SEARCH_HISTORY_LIMIT + 3; i++) await search(`q${i}`);
    expect(snapshot().queryHistory).toHaveLength(SEARCH_HISTORY_LIMIT);
    expect(snapshot().queryHistory[0]).toBe(`q${SEARCH_HISTORY_LIMIT + 3}`);
    expect(snapshot().queryHistory).not.toContain('q3');
    expect(snapshot().queryHistory.at(-1)).toBe('q4');
    expect(JSON.parse(storage.getItem(HISTORY_KEY)!)).toHaveLength(SEARCH_HISTORY_LIMIT);
  });

  it('没真的发起检索的不入史：空白查询 / 无根目录都不算有效检索', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    const runner = vi.fn<SearchRunner>();
    setSearchRunner(runner);
    setQuery('   ');
    await runSearch(ROOTS);
    setQuery('abc');
    await runSearch([]);
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot().queryHistory).toEqual([]);
    expect(storage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('持久化读回：下次启动（resetSearch 现读）历史还在', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(HISTORY_KEY, JSON.stringify(['beta', 'alpha']));
    resetSearch();
    expect(snapshot().queryHistory).toEqual(['beta', 'alpha']);
  });

  it('存储坏值：坏 JSON / 非数组 / 坏元素一律丢弃，不炸面板', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(HISTORY_KEY, '{bad json');
    resetSearch();
    expect(snapshot().queryHistory).toEqual([]);
    storage.setItem(HISTORY_KEY, JSON.stringify({ entries: ['a'] }));
    resetSearch();
    expect(snapshot().queryHistory).toEqual([]);
    // 坏元素（数字 / null / 空白）跳过、重复只留第一次出现的
    storage.setItem(HISTORY_KEY, JSON.stringify(['ok', 1, null, '  ', 'ok', 'b']));
    resetSearch();
    expect(snapshot().queryHistory).toEqual(['ok', 'b']);
  });

  it('localStorage 不可用（隐私模式 / 抛错）⇒ 历史照常记在内存里，只是不落盘', async () => {
    vi.stubGlobal('localStorage', {
      getItem(): string | null {
        throw new Error('SecurityError');
      },
      setItem(): void {
        throw new Error('SecurityError');
      },
    });
    resetSearch();
    setSearchRunner(async () => result());
    await search('abc');
    expect(snapshot().queryHistory).toEqual(['abc']);
    expect(stepSearchHistory(-1)).toBe(true);
    expect(snapshot().query).toBe('abc');
  });

  it('↑/↓ 回溯：↑ 从草稿进最新、继续往更旧；↓ 往回走，退到最新再按还原草稿', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    setSearchRunner(async () => result());
    await search('a');
    await search('b');
    setQuery('草稿');
    expect(stepSearchHistory(-1)).toBe(true);
    expect(snapshot().query).toBe('b');
    expect(snapshot().historyCursor).toBe(0);
    expect(stepSearchHistory(-1)).toBe(true);
    expect(snapshot().query).toBe('a');
    expect(snapshot().historyCursor).toBe(1);
    // 到最旧一条停住（不越过、也不退出回溯）
    expect(stepSearchHistory(-1)).toBe(true);
    expect(snapshot().query).toBe('a');
    expect(snapshot().historyCursor).toBe(1);
    expect(stepSearchHistory(1)).toBe(true);
    expect(snapshot().query).toBe('b');
    expect(snapshot().queryHistory).toEqual(['b', 'a']);
    // 最新一条再 ↓ = 还原草稿并退出回溯
    expect(stepSearchHistory(1)).toBe(true);
    expect(snapshot().query).toBe('草稿');
    expect(snapshot().historyCursor).toBe(-1);
  });

  it('回溯中打字 ⇒ 退出回溯；下一次 ↑ 从最新重新开始，草稿取当前文本', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    setSearchRunner(async () => result());
    await search('a');
    await search('b');
    setQuery('');
    stepSearchHistory(-1);
    expect(snapshot().query).toBe('b');
    setQuery('b2');
    expect(snapshot().historyCursor).toBe(-1);
    expect(stepSearchHistory(-1)).toBe(true);
    expect(snapshot().query).toBe('b');
    expect(stepSearchHistory(1)).toBe(true);
    expect(snapshot().query).toBe('b2');
  });

  it('没有历史 / 还没进入回溯的 ↓ ⇒ 不消费（↑↓ 让给结果行导航），文本一个字不动', () => {
    resetSearch();
    setQuery('abc');
    expect(stepSearchHistory(-1)).toBe(false);
    expect(stepSearchHistory(1)).toBe(false);
    expect(snapshot().query).toBe('abc');
  });

  it('发起检索即结束回溯：下一次 ↑ 从最新一条重新开始', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    resetSearch();
    setSearchRunner(async () => result());
    await search('a');
    await search('b');
    setQuery('');
    stepSearchHistory(-1);
    expect(snapshot().historyCursor).toBe(0);
    await runSearch(ROOTS);
    expect(snapshot().historyCursor).toBe(-1);
    stepSearchHistory(-1);
    expect(snapshot().query).toBe('b');
  });
});
