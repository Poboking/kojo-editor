import {
  cancelSearch,
  searchInFiles,
  type SearchFilesBatch,
  type SearchFileResult,
  type SearchMatch,
  type SearchProgress,
  type SearchRequest,
  type SearchResult,
} from '../bridge/search';
import { errorText, pathKey, type ScopedStorage } from '@kojo/plugin-api';
import {
  DEFAULT_EXTENSION_TEXT,
  folderScopeLabel,
  getGlobFilterText,
  isValidSearchQuery,
  normalizeSearchHistory,
  parseExcludePatterns,
  parseExtensions,
  parseFileFilter,
  pushSearchHistory,
  replaceSummaryText,
  setGlobFilterText,
} from './search-query';
import {
  acceptFilesBatch,
  DEFAULT_SEARCH_SORT,
  reconcileStreamFiles,
  sortSearchFiles,
  type SearchSortMode,
} from './search-stream';
import {
  describeAppliedScope,
  narrowRoots,
  scopeUnreachableText,
  type AppliedSearchScope,
  type SearchScopeItem,
} from './search-scope';

/**
 * 全文检索面板的状态（壳层私有，2026-10-15 全文检索批）。
 *
 * 为什么状态住模块级而不是面板内 `useState`：侧栏切走就卸载面板
 * （`ShellLayout` 只渲染当前活动视图），检索结果与查询条件必须**活得比面板久**——
 * 回来时结果还在，重跑不是我按一下"搜索"就能接受的代价（一次全量检索是秒级 IO）。
 * 这与 `problem-store.ts` 同族：数据判据独立成模块，渲染层只订阅。
 *
 * 这里只做状态机与单飞/过期丢弃（同 key 只允许一条在跑，迟到结果不许覆盖新结果），
 * IPC 与后端语义全在 `bridge/search.ts` 与 Rust 侧。
 */

export type SearchPhase = 'idle' | 'running' | 'done' | 'error';

export interface SearchOptionsState {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchState {
  query: string;
  options: SearchOptionsState;
  /**
   * 出结果那次检索的查询原文（`null` = 还没有完成态结果）。
   * 逐项导航只在"查询没改过"时成立：作者改了查询却按回车，应该重搜而不是
   * 拿着旧结果跳——屏幕上的结果与查询对不上时，跳转就是另一种撒谎。
   */
  resultQuery: string | null;
  /** 当前命中游标（0 基，按**显示序**数；`-1` = 还没导航过。计数文案见 `searchMatchCounterText`） */
  matchCursor: number;
  /** 类型过滤框的原始文本（解析成扩展名列表在发请求那一刻做） */
  extensionText: string;
  /**
   * 「排除」框的原始文本（WS-10）：gitignore-lite 模式，发请求那一刻经
   * `parseExcludePatterns` 现解析；空 = 不排除（老请求体逐字一致）。
   */
  excludeText: string;
  /**
   * 「在此文件夹中搜索」的一次性范围根（WS-10；`null` = 不限）。
   * 与选择器的 `scopeKey` 各管一头：这一格来自树右键/入口调用，**不持久化**
   * （"这次只看这个文件夹"是一次性意图，重启后不该还钉着上次的角落）。
   */
  folderScopeRoot: string | null;
  /**
   * 打开搜索视图的请求计数（`openFolderSearchScope` 自增；壳层订阅后激活搜索视图）。
   * 与 `focusNonce` 分开：聚焦输入框与"把面板翻上屏"是两件事，树右键入口两个都要。
   */
  folderScopeNonce: number;
  phase: SearchPhase;
  /** 检索中的实时进度（非 running 态恒为 null，避免展示过期读数） */
  progress: SearchProgress | null;
  result: SearchResult | null;
  error: string | null;
  /** 最近一次检索的 id：进度与取消都按它认领（多条检索并发时不许串线） */
  searchId: number;
  /**
   * 流式在途累积的命中文件（P2-11：批次随到随进，面板随到随画）。
   * `null` = 当前没有在途检索；完成态收口后清空（完成态的文件由 `result` 提供）。
   */
  streamFiles: readonly SearchFileResult[] | null;
  /**
   * 结果排序档位（P2-11：路径 / 命中数 / 文件名，**默认路径**）。
   * 纯客户端投影（`search-stream.sortSearchFiles`）——切换不重发检索，在途流式
   * 结果也当场重排。
   */
  sortMode: SearchSortMode;
  /** 焦点请求计数：快捷键再次命中时让输入框重新聚焦（`autoFocus` 只管首次挂载） */
  focusNonce: number;
  /**
   * 选定的检索范围（C3 领域限定检索批；`''` = 不限 = 今天的形状）。
   * 这里只存**候选的 key**：候选本身（标签、目录）由提供方给，宿主不复制一份判据。
   */
  scopeKey: string;
  /**
   * 出结果那次检索**实际用的**范围快照（与 `scopeKey` 刻意分开：改选择器不改结果，
   * 屏幕上的"只扫了这些"必须说结果的实话，而不是说选择器现在的样子）。
   */
  appliedScope: AppliedSearchScope | null;
  /** 替换内容（`$1` 等捕获组引用在落地时展开；**允许为空** = 删除命中，与 VSCode 同语义） */
  replaceText: string;
  /** 替换框焦点请求计数（「在文件中替换」命令入口命中时自增，面板据此聚焦替换框） */
  replaceFocusNonce: number;
  /** 替换在途（替换是写盘操作：在途时替换入口一律锁住，不许并发写） */
  replaceRunning: boolean;
  /** 最近一次替换的汇总（纯展示；`null` = 没替换过 / 已随结果清空） */
  replaceSummary: string | null;
  /**
   * 最近检索（W7-E）：有效查询，最新在前、去重、上限 `SEARCH_HISTORY_LIMIT`。
   * 跨会话保留（localStorage，与三开关同一份存法）；检索框 ↑/↓ 据此回溯。
   */
  queryHistory: readonly string[];
  /** 回溯游标（`-1` = 没在回溯；`0` = 历史最新一条） */
  historyCursor: number;
  /** 开始回溯前输入框里的草稿（↓ 退到最新一条再按一次 = 还原它并退出回溯） */
  historyDraft: string;
}

/** 检索执行者（注入 seam：缺省 = Tauri 桥；单测注入假实现）。
 *
 * `onFiles`（P2-11 流式）可选：命中文件增量批次（与进度同一节流点）。不传 =
 * 退回"一把 await 等全量"的老行为（既有单测注入的假实现逐字兼容）。 */
export type SearchRunner = (
  request: SearchRequest,
  onProgress: (p: SearchProgress) => void,
  onFiles?: (batch: SearchFilesBatch) => void,
) => Promise<SearchResult>;

/** 单条替换的目标：检索结果里那一处命中（1 基行列，与 `SearchMatch` 同口径） */
export interface MatchTarget {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/** 逐项导航的目标：文件路径 + 那一条命中（区间/预览都在 `match` 里，面板不必再查） */
export interface SearchMatchTarget {
  readonly path: string;
  readonly match: SearchMatch;
}

/** 替换模式：全部替换 = 结果里每个文件逐个落；单条 = 只落点中的那一处 */
export type ReplaceMode = { readonly kind: 'all' } | { readonly kind: 'one'; readonly target: MatchTarget };

/** 替换落点读数（执行器如实回报；stale = 文本已变化而跳过的处数） */
export interface ReplaceOutcome {
  readonly applied: number;
  readonly filesChanged: number;
  readonly stale: number;
  readonly readOnlyFiles: number;
  readonly errors: readonly string[];
}

/** 替换执行者（注入 seam：缺省 = `createFileReplaceRunner` 装配的内核 io + Monaco 通道） */
export type ReplaceRunner = (request: ReplaceRequest) => Promise<ReplaceOutcome>;

/** 发给执行者的请求：条件快照 + 结果文件清单（执行者现场重匹配，不信任行列） */
export interface ReplaceRequest {
  readonly query: string;
  readonly options: SearchOptionsState;
  readonly replaceText: string;
  readonly mode: ReplaceMode;
  readonly files: readonly { readonly path: string; readonly matches: readonly SearchMatch[] }[];
}

/* ---------------------- 三个检索开关的跨会话保留（查找替换体验批） ---------------------- */

/**
 * 全字 / 大小写 / 正则三开关住 localStorage（与 `search-query.ts` 的
 * 「替换保留大小写」同一存法，不新造第二套偏好机制）。
 *
 * 为什么必须跨会话：这三个开关改变的是**命中判据**。作者上一轮用正则找完
 * `^口上`，关掉程序再打开，面板悄悄回到"全关"——下一次检索结果与上一轮
 * 完全不同，而屏幕上没有任何一处说条件变了（铁律 4）。
 *
 * 失败方向：读写异常（隐私模式 / 配额 / 手改坏 JSON）一律回"三关"——
 * 与缺省同形，不猜、不半开。开关本身照常可切（存储只影响下次启动）。
 */
const SEARCH_OPTIONS_PREF_KEY = 'kojo.ui.search.options.v1';

/** 缺省三关（与 `INITIAL` 的旧口径逐字一致） */
function defaultSearchOptions(): SearchOptionsState {
  return { isRegex: false, caseSensitive: false, wholeWord: false };
}

/** localStorage 访问器（node 测试环境无 localStorage；隐私模式可能抛错——都不该影响检索） */
function searchStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读开关（坏值 / 缺键 / 非布尔一律当关；只认显式的 `true`） */
function loadSearchOptionsPref(): SearchOptionsState {
  const storage = searchStorage();
  if (storage === null) return defaultSearchOptions();
  let raw: string | null;
  try {
    raw = storage.getItem(SEARCH_OPTIONS_PREF_KEY);
  } catch {
    return defaultSearchOptions();
  }
  if (raw === null) return defaultSearchOptions();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultSearchOptions();
    const rec = parsed as Record<string, unknown>;
    return {
      isRegex: rec.isRegex === true,
      caseSensitive: rec.caseSensitive === true,
      wholeWord: rec.wholeWord === true,
    };
  } catch {
    return defaultSearchOptions();
  }
}

/** 写开关（写不进去不算错：只影响下次启动，不影响本次） */
function saveSearchOptionsPref(options: SearchOptionsState): void {
  const storage = searchStorage();
  if (storage === null) return;
  try {
    storage.setItem(SEARCH_OPTIONS_PREF_KEY, JSON.stringify(options));
  } catch {
    /* 隐私模式 / 配额满：本次会话照常 */
  }
}

/* ---------------------- 最近检索（W7-E：↑/↓ 回溯 + 跨会话） ---------------------- */

/**
 * 最近检索住 localStorage——与三开关**同一份存法、同一套键风格**（`kojo.ui.search.<域>.v1`），
 * 不新造第二套偏好机制。值是一份字符串数组（最新在前），最多 `SEARCH_HISTORY_LIMIT` 条。
 *
 * 为什么值得跨会话：检索词是作者的**工作记忆**（某个函数名、某句台词、某个正则），
 * 关掉程序再打开还要重新敲一遍；而历史只是回放清单，不参与命中判据，
 * 读不到 / 坏值 ⇒ 回空列表，与"没搜过"同形，绝不把面板炸掉（铁律 4 的失败方向）。
 *
 * 隐私面：查询原文会落到本机 localStorage（只在本机、不随项目走、不进日志）；
 * 这里刻意不调用任何日志接口——"搜了什么"不该出现在诊断输出里。
 */
const SEARCH_HISTORY_KEY = 'kojo.ui.search.history.v1';

/** 读历史（坏 JSON / 非数组 / 坏元素一律丢弃，清洗口径在 `normalizeSearchHistory`） */
function loadSearchHistoryPref(): readonly string[] {
  const storage = searchStorage();
  if (storage === null) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(SEARCH_HISTORY_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeSearchHistory(parsed) : [];
  } catch {
    return [];
  }
}

/** 写历史（写不进去不算错：只影响下次启动，本次会话照常可回溯） */
function saveSearchHistoryPref(history: readonly string[]): void {
  const storage = searchStorage();
  if (storage === null) return;
  try {
    storage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* 隐私模式 / 配额满：历史留在内存里，本次会话照常 */
  }
}

/* ---------------------- 检索条件按项目跨重启恢复（WS-10） ---------------------- */

/**
 * 检索条件住 kernel **全局存储**（与 `session-store.ts` 同一条 KV 通道，按项目根
 * `pathKey` 归档）：query / 类型 / glob / 排除 / 三开关随项目走，重启回同一个项目
 * 条件还在——作者的工作现场本来就是这样（上一轮搜到一半、重启后从头敲条件不是
 * 恢复，是失忆）。
 *
 * 门风照 `session-store.ts`：**读不到就用缺省，绝不炸启动**——
 * - kv 缺席 / get 抛错 / JSON 坏 / 键形不对 ⇒ 缺省值，一条不猜；
 * - 单条字段坏了只丢那一条（其余字段照常恢复）；
 * - 写失败静默（只影响下次启动，本次会话照常，与 localStorage 那几格同口径）。
 *
 * 与 `queryHistory`（localStorage、跨项目）刻意两存：历史是"搜过什么"的回放清单，
 * 条件是"这个项目正在查什么"的工作现场——后者按项目分家才有意义。
 */
export const SEARCH_PREFS_KEY = 'search-prefs-v1';
/** 记录里最多保留的项目数（超出按写入序丢最旧；一项目一小格 JSON，32 格压在几 KB） */
export const SEARCH_PREFS_PROJECT_LIMIT = 32;
/** 落盘防抖（与 SESSION_FLUSH_DEBOUNCE_MS 同族节奏：打字停下 0.6s 才写） */
export const SEARCH_PREFS_FLUSH_DEBOUNCE_MS = 600;
/** 单格文本上限（防手改坏/异常巨型值把存储撑爆；超限那一条按缺省，不截断硬用） */
const SEARCH_PREFS_TEXT_MAX = 1000;

/** 一个项目的检索条件快照（纯数据，可 JSON 化） */
export interface SearchPrefsEntry {
  query: string;
  extensionText: string;
  globText: string;
  excludeText: string;
  options: SearchOptionsState;
}

/** 全局记录形状（键 = pathKey(rootDir)，与 session 记录同构） */
export interface SearchPrefsRecord {
  v: 1;
  projects: Record<string, SearchPrefsEntry>;
}

/** 检索条件存取的最小存取面（ScopedStorage 的 get/set 子集；node 测试给内存替身） */
export type SearchPrefsKv = Pick<ScopedStorage, 'get' | 'set'>;

export function emptySearchPrefsRecord(): SearchPrefsRecord {
  return { v: 1, projects: {} };
}

/** 文本字段清洗：非字符串 / 超长一律回落调用方给的缺省（不猜、不截断硬用） */
function cleanPrefsText(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length > SEARCH_PREFS_TEXT_MAX) return fallback;
  return raw;
}

/** 单条记录清洗（损坏容忍：任何不合法形态回缺省条目；布尔只认显式 true） */
export function sanitizeSearchPrefsEntry(
  raw: unknown,
  fallback?: Partial<SearchPrefsEntry>,
): SearchPrefsEntry {
  const base: SearchPrefsEntry = {
    query: '',
    extensionText: DEFAULT_EXTENSION_TEXT,
    globText: '',
    excludeText: '',
    options: defaultSearchOptions(),
    ...fallback,
  };
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const options = defaultSearchOptions();
  if (typeof r.options === 'object' && r.options !== null) {
    const o = r.options as Record<string, unknown>;
    options.isRegex = o.isRegex === true;
    options.caseSensitive = o.caseSensitive === true;
    options.wholeWord = o.wholeWord === true;
  }
  return {
    query: cleanPrefsText(r.query, base.query),
    extensionText: cleanPrefsText(r.extensionText, base.extensionText),
    globText: cleanPrefsText(r.globText, base.globText),
    excludeText: cleanPrefsText(r.excludeText, base.excludeText),
    options,
  };
}

/** 整份记录清洗：v 不对 / projects 不是对象 ⇒ 空记录；坏条目逐条丢 */
export function sanitizeSearchPrefsRecord(raw: unknown): SearchPrefsRecord {
  if (typeof raw !== 'object' || raw === null) return emptySearchPrefsRecord();
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.projects !== 'object' || r.projects === null) {
    return emptySearchPrefsRecord();
  }
  const projects: Record<string, SearchPrefsEntry> = {};
  for (const [k, v] of Object.entries(r.projects as Record<string, unknown>)) {
    if (k === '' || typeof k !== 'string') continue;
    if (typeof v !== 'object' || v === null) continue;
    projects[k] = sanitizeSearchPrefsEntry(v);
  }
  return { v: 1, projects };
}

/**
 * 并入一个项目的条目并回到队尾（写入序即新旧序）；超过上限按最旧丢弃。
 * 返回新对象，不改入参（与 `upsertSessionProject` 同形态）。
 */
export function upsertSearchPrefsEntry(
  rec: SearchPrefsRecord,
  rootDir: string,
  entry: SearchPrefsEntry,
  limit: number = SEARCH_PREFS_PROJECT_LIMIT,
): SearchPrefsRecord {
  const projects: Record<string, SearchPrefsEntry> = {};
  const key = sessionKeyOf(rootDir);
  if (limit <= 0) return { v: 1, projects };
  // 写入序 = 队列序（队头最旧）：给新条目腾一格 ⇒ 留**队尾** limit-1 条，
  // 从队头开始丢。反过来留队头等于每写一次就丢刚写进来的那条，限额形同虚设。
  const older = Object.keys(rec.projects).filter((k) => k !== key);
  const cap = limit - 1;
  for (const k of older.slice(Math.max(0, older.length - cap))) {
    projects[k] = rec.projects[k]!;
  }
  projects[key] = entry;
  return { v: 1, projects };
}

function sessionKeyOf(rootDir: string): string {
  return pathKey(rootDir);
}

/* ---- 运行期绑定（模块级；与状态机同生命周期，缺省 = 没绑 = 不持久化） ---- */

let prefsKv: SearchPrefsKv | null = null;
let prefsRoot: string | null = null;
let prefsPending: SearchPrefsEntry | null = null;
let prefsTimer: ReturnType<typeof setTimeout> | null = null;

/** 现场条件 → 快照（glob 文本住 `search-query` 模块级，这里一并收） */
function captureSearchPrefs(): SearchPrefsEntry {
  return {
    query: state.query,
    extensionText: state.extensionText,
    globText: getGlobFilterText(),
    excludeText: state.excludeText,
    options: { ...state.options },
  };
}

function writePrefsNow(): void {
  const kv = prefsKv;
  const root = prefsRoot;
  const entry = prefsPending;
  prefsPending = null;
  if (prefsTimer !== null) {
    clearTimeout(prefsTimer);
    prefsTimer = null;
  }
  if (kv === null || root === null || entry === null) return;
  void (async () => {
    try {
      const raw = await kv.get<unknown>(SEARCH_PREFS_KEY);
      const next = upsertSearchPrefsEntry(sanitizeSearchPrefsRecord(raw), root, entry);
      await kv.set(SEARCH_PREFS_KEY, next);
    } catch {
      /* 写失败只影响下次启动（门风与 localStorage 那几格一致） */
    }
  })();
}

/** 条件变了：拍快照 + 防抖落盘（快照即调度——关项目那一拍现场可能已被清） */
function markPrefsDirty(): void {
  if (prefsKv === null || prefsRoot === null) return;
  prefsPending = captureSearchPrefs();
  if (prefsTimer !== null) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(writePrefsNow, SEARCH_PREFS_FLUSH_DEBOUNCE_MS);
}

/** 强制落盘（项目切换 / 卸载收尾；与 session 的 flushNow 同语义，幂等） */
export function flushSearchPrefs(): void {
  writePrefsNow();
}

/**
 * 绑定当前项目并恢复它的检索条件（宿主接线点：开项目后调）。
 * - 读不到记录 / 该项目没有条目 ⇒ 保持现状（缺省或 localStorage 三开关），不猜；
 * - 恢复本身**不再触发落盘**（快照没变，写一遍只是白 IO）。
 */
export async function bindSearchPrefs(kv: SearchPrefsKv, rootDir: string): Promise<void> {
  // 换绑先把上一个项目的待写落掉（脏确认前数据先归位）
  if (prefsRoot !== null && prefsRoot !== rootDir) writePrefsNow();
  prefsKv = kv;
  prefsRoot = rootDir;
  try {
    const raw = await kv.get<unknown>(SEARCH_PREFS_KEY);
    const rec = sanitizeSearchPrefsRecord(raw);
    const entry = rec.projects[sessionKeyOf(rootDir)];
    if (entry === undefined) return;
    setGlobFilterText(entry.globText);
    set({
      query: entry.query,
      extensionText: entry.extensionText,
      excludeText: entry.excludeText,
      options: entry.options,
      historyCursor: -1,
      historyDraft: '',
    });
  } catch {
    /* 存储读不到 = 没有记录（缺省照常），绝不把启动/开项目炸掉 */
  }
}

/** 解绑（关项目 / 卸载）：先强刷待写，再断通道——断后条件变化不再落盘 */
export function unbindSearchPrefs(): void {
  writePrefsNow();
  prefsKv = null;
  prefsRoot = null;
  prefsPending = null;
}

/** 单测/调试注入：当前是否绑定了持久化通道 */
export function isSearchPrefsBound(): boolean {
  return prefsKv !== null;
}

/** 结果的**显示序**摊平（与面板的 `sortSearchFiles` 同一条排序真源，导航与所见不漂） */
function searchMatchTargets(files: readonly SearchFileResult[], mode: SearchSortMode): SearchMatchTarget[] {
  const out: SearchMatchTarget[] = [];
  for (const file of sortSearchFiles(files, mode)) {
    for (const match of file.matches) out.push({ path: file.path, match });
  }
  return out;
}

const INITIAL: SearchState = {
  query: '',
  options: loadSearchOptionsPref(),
  resultQuery: null,
  matchCursor: -1,
  extensionText: DEFAULT_EXTENSION_TEXT,
  excludeText: '',
  folderScopeRoot: null,
  folderScopeNonce: 0,
  phase: 'idle',
  progress: null,
  result: null,
  error: null,
  searchId: 0,
  streamFiles: null,
  sortMode: DEFAULT_SEARCH_SORT,
  focusNonce: 0,
  scopeKey: '',
  appliedScope: null,
  replaceText: '',
  replaceFocusNonce: 0,
  replaceRunning: false,
  replaceSummary: null,
  queryHistory: loadSearchHistoryPref(),
  historyCursor: -1,
  historyDraft: '',
};

let state: SearchState = INITIAL;
let runner: SearchRunner = searchInFiles;
let canceller: (searchId: number) => Promise<void> = cancelSearch;
let replaceRunner: ReplaceRunner | null = null;
let nextId = 1;

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function set(patch: Partial<SearchState>): void {
  state = { ...state, ...patch };
  notify();
}

/** 只读快照（引用随每次变更整体替换 ⇒ React 侧可安全用于依赖比对） */
export function snapshot(): SearchState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 单测注入检索执行者 / 取消入口（传 null 回落真实桥） */
export function setSearchRunner(next: SearchRunner | null): void {
  runner = next ?? searchInFiles;
}

export function setSearchCanceller(next: ((searchId: number) => Promise<void>) | null): void {
  canceller = next ?? cancelSearch;
}

/** 注入替换执行者（宿主装配点：内核 io + Monaco 通道；传 null = 未装配，替换入口锁住） */
export function setReplaceRunner(next: ReplaceRunner | null): void {
  replaceRunner = next;
}

/**
 * 写检索词（输入框的每一下键入走这里）。
 *
 * 手工编辑即**退出历史回溯**（游标复位）：否则"↑ 取回旧词 → 接着打字 → 再按 ↑"
 * 会从旧词的位置继续往更旧走，而屏幕上的文本早已不是历史里的那一条。
 */
export function setQuery(query: string): void {
  set({ query, historyCursor: -1 });
  markPrefsDirty();
}

/**
 * ↑/↓ 回溯最近检索（检索框的键盘数据面；`delta = -1` 向更旧、`+1` 向更新）。
 *
 * 状态机（与主流编辑器同款手感）：
 * - 第一次 ↑ = 把**当前草稿**记下、取回历史最新一条；继续 ↑ 往更旧走，到最旧为止；
 * - ↓ 往更新走；已在最新一条时再按 ↓ = **还原草稿**并退出回溯；
 * - 返回 `false` = 这一下不归历史管（没有历史 / 还没进入回溯就按 ↓）——
 *   面板据此把 ↑↓ 原样让给既有的结果行导航（`panel-row-nav`），老手感不丢。
 *
 * 只在真的消费时改状态：没有历史时 `query` 一个字都不动。
 */
export function stepSearchHistory(delta: -1 | 1): boolean {
  const history = state.queryHistory;
  if (history.length === 0) return false;
  if (delta === 1 && state.historyCursor < 0) return false;
  if (delta === -1) {
    // 首次 ↑：草稿 = 现在输入框里的文本（↓ 回到最新一条后再按时还原它）
    const draft = state.historyCursor < 0 ? state.query : state.historyDraft;
    const next = state.historyCursor < 0 ? 0 : Math.min(state.historyCursor + 1, history.length - 1);
    set({ query: history[next]!, historyCursor: next, historyDraft: draft });
    return true;
  }
  if (state.historyCursor > 0) {
    const next = state.historyCursor - 1;
    set({ query: history[next]!, historyCursor: next });
    return true;
  }
  // 已在最新一条：↓ 还原草稿并退出回溯
  set({ query: state.historyDraft, historyCursor: -1, historyDraft: '' });
  return true;
}

export function setReplaceText(text: string): void {
  set({ replaceText: text });
}

/** 「在文件中替换」命令入口：打开搜索视图后请求替换框聚焦 */
export function requestReplaceFocus(): void {
  set({ replaceFocusNonce: state.replaceFocusNonce + 1 });
}

export function setExtensionText(text: string): void {
  set({ extensionText: text });
  markPrefsDirty();
}

/** 「排除」框（WS-10）：文本 → 存状态，解析成模式列表在发请求那一刻做 */
export function setExcludeText(text: string): void {
  set({ excludeText: text });
  markPrefsDirty();
}

/**
 * glob 框的变更回执（`SearchFilterBar` 在 `setGlobFilterText` 之后调）：
 * glob 文本住 `search-query` 的模块级、不经过本 store 的 `set`，持久化搭不上车——
 * 这里给它补一脚（同样进防抖落盘）。
 */
export function notifySearchPrefsChanged(): void {
  markPrefsDirty();
}

/* ---------------------- 「在此文件夹中搜索」（WS-10 落地面） ---------------------- */

/** 文件夹范围在窄化判据里的固定 key（与提供方候选的命名空间 key 不撞：带前缀） */
export const FOLDER_SCOPE_KEY = 'folder-scope';

/**
 * 一次性范围根 → 现成的范围候选（**纯装配**，宿主不理解这个目录是什么）：
 * label 取末段目录名、detail 给全路径进悬停；roots 就一条。
 * 装出来的形状与提供方候选逐字同构 ⇒ `narrowRoots` / `describeAppliedScope`
 * 一条判据共用，不为文件夹范围另开第二条收窄腿（"只允许收窄不许扩权"照旧成立）。
 */
export function makeFolderScopeItem(dir: string): SearchScopeItem {
  return { key: FOLDER_SCOPE_KEY, label: folderScopeLabel(dir), detail: dir, roots: [dir] };
}

/** 设置/清除一次性文件夹范围（不改已有结果——与选择器同语义，下次检索才生效） */
export function setFolderSearchScope(dir: string | null): void {
  set({ folderScopeRoot: dir !== null && dir.trim() !== '' ? dir : null });
}

/**
 * 「在此文件夹中搜索」的稳定入口（树右键那一枚菜单项由组长在合流时接线，签名如下）：
 *
 * ```ts
 * import { openFolderSearchScope } from './search-store';
 * openFolderSearchScope(rootDir: string): void
 * ```
 *
 * 一步到位：①写入一次性范围根；②`folderScopeNonce` 自增——壳层订阅后把
 * 「搜索」视图翻上屏；③`focusNonce` 自增——检索框聚焦。范围生效 / "范围：xxx"
 * 上屏 / 清除回退全在 `search-store` + `SearchPanel` 本侧闭环，调用方一行接线。
 */
export function openFolderSearchScope(rootDir: string): void {
  const dir = rootDir.trim();
  if (dir === '') return;
  set({
    folderScopeRoot: dir,
    folderScopeNonce: state.folderScopeNonce + 1,
    focusNonce: state.focusNonce + 1,
  });
}

/**
 * 选定检索范围（`''` = 不限）。切换**不改已有结果**（与三个开关同语义：下次检索才生效），
 * 所以这里只动 `scopeKey`，不动 `appliedScope`——后者是"出这份结果时用的范围"。
 */
export function setSearchScope(key: string): void {
  set({ scopeKey: key });
}

/** 三个开关（正则 / 大小写 / 全词）——切换不改结果，下次检索才生效；同时落 localStorage 跨会话保留 */
export function toggleOption(key: keyof SearchOptionsState): void {
  const options = { ...state.options, [key]: !state.options[key] };
  saveSearchOptionsPref(options);
  set({ options });
  // 三开关也是"这个项目的检索条件"（WS-10）：只存 localStorage 的话，换项目
  // 沿用上一条判据、重启回不到判过的那一行——与 query/类型/排除同一份快照落盘
  markPrefsDirty();
}

/** 快捷键 / 命令入口：请求面板聚焦（面板订阅 `focusNonce` 落地） */
export function requestSearchFocus(): void {
  set({ focusNonce: state.focusNonce + 1 });
}

/**
 * 切换结果排序（P2-11：路径 / 命中数 / 文件名）。与三个开关、范围选择同语义：
 * 只改投影序，**不重发检索**——在途流式结果也当场重排（排序是纯函数，
 * 见 `search-stream.sortSearchFiles`）。
 *
 * 当前项游标跟着排序一起复位：0 基游标说的是**旧显示序**里的第几个，
 * 换了序还留着它就是指向另一条命中（"第 3 项"突然变成别处，读数撒谎）。
 */
export function setSearchSortMode(mode: SearchSortMode): void {
  set({ sortMode: mode, matchCursor: -1 });
}

/** 清空结果与错误（保留查询条件与开关——"清空结果"不是"重置面板"） */
export function clearSearchResult(): void {
  if (state.phase === 'running') return;
  set({
    result: null,
    error: null,
    phase: 'idle',
    progress: null,
    appliedScope: null,
    replaceSummary: null,
    resultQuery: null,
    matchCursor: -1,
  });
}

/**
 * 发起一次检索。前置校验失败就地落 error 态（不静默：空查询 / 无根目录都不发请求）。
 * 单飞：正在跑时重复调用直接返回（想打断请走 `stopSearch`）。
 *
 * `applied`（C3 检索范围批，**additive**）：调用方已经把检索根按范围收窄好了，这里只
 * 带上新增的两件事——①收窄后可能一个根都不剩（此时报错文案要说清"是范围没落进项目"，
 * 不是"没打开项目"）；②结果要能说出"这轮只扫了哪个范围"。
 * **不传 ⇒ 行为与今天逐字一致**（老调用方零改动）。
 *
 * P2-11 流式：从"一把 await 等全量"改为"**增量累积 + 完成态收口**"——命中文件
 * 批次（`onFiles`）随到随进 `streamFiles`，面板随到随画；完成态仍由 `search_text`
 * 的返回值收口，且**以完成态为准**（见 `reconcileStreamFiles`：完成态是事件流的
 * 超集，对不齐时以完成态为准，绝不许"事件说三条、最终态说两条"）。
 * `searchId` 过期丢弃口径不变：迟到进度 / 迟到批次都按 searchId 过滤，旧检索的
 * 读数不许覆盖新检索。
 *
 * glob 过滤（W7-A）：装配请求时现读 `getGlobFilterText()` 解析成 `options.globs`——
 * 与「类型」框是两个独立维度（且的关系），**空 globs 不带这个键**（老请求体逐字一致）。
 */
export async function runSearch(
  roots: readonly string[],
  applied?: AppliedSearchScope | null,
): Promise<void> {
  if (!isValidSearchQuery(state.query)) {
    set({
      phase: 'error',
      error: '请输入检索词',
      result: null,
      progress: null,
      appliedScope: null,
      resultQuery: null,
      matchCursor: -1,
    });
    return;
  }
  if (roots.length === 0) {
    set({
      phase: 'error',
      error: applied ? scopeUnreachableText(applied) : '没有可检索的根目录（请先打开项目）',
      result: null,
      progress: null,
      appliedScope: null,
      resultQuery: null,
      matchCursor: -1,
    });
    return;
  }
  if (state.phase === 'running') return;

  // 最近检索（W7-E）：过了「有效查询 + 有根 + 不在跑」三道闸才记——没真的发起检索的词
  // 不进历史（半截输入 / 空白不算"有效查询"）。去重与截断在纯函数里，写盘只在真变时。
  const queryHistory = pushSearchHistory(state.queryHistory, state.query);
  if (queryHistory !== state.queryHistory) saveSearchHistoryPref(queryHistory);

  const searchId = nextId++;
  // glob 过滤（W7-A 接线）：文本住 `search-query` 的模块级（与 `extensionText` 隔离，
  // 两个框各管一维），发请求那一刻现解析——与扩展名同一条"用发请求时的条件"口径。
  // **只填不改义**：`extensions` 仍是 `extensionText` 的后缀清单（glob 词不进这个框，
  // 见 `SearchFilterBar`），`globs` 是**追加**的第二个维度，Rust 侧按且执行。
  // 空 globs **不带这个键**（老请求体逐字一致：缺键 = 不过滤，与 Rust DTO 的 `None` 同义）。
  const globs = parseFileFilter(getGlobFilterText()).globs;
  // 排除模式（WS-10）：同款"发请求那一刻现解析"；**空不带键**（老请求体逐字一致）。
  // 语义 = 先 include 后 exclude，gitignore-lite（后写的规则赢），判据见 Rust
  // `compile_exclude_rules`；挡下的文件计入 `skipped.excluded` 上屏（铁律 4）。
  const excludeGlobs = parseExcludePatterns(state.excludeText);
  const request: SearchRequest = {
    searchId,
    roots: [...roots],
    query: state.query,
    options: {
      ...state.options,
      extensions: parseExtensions(state.extensionText),
      ...(globs.length ? { globs } : {}),
      ...(excludeGlobs.length ? { excludeGlobs } : {}),
    },
  };
  set({
    searchId,
    phase: 'running',
    error: null,
    result: null,
    progress: null,
    appliedScope: applied ?? null,
    streamFiles: [],
    resultQuery: null,
    matchCursor: -1,
    // 检索已落地 = 这一轮回溯结束（下一次 ↑ 从"现在搜的词"重新开始）
    queryHistory,
    historyCursor: -1,
    historyDraft: '',
  });

  try {
    const result = await runner(
      request,
      (p) => {
        // 迟到进度不许覆盖新检索的读数
        if (state.searchId === searchId && state.phase === 'running') set({ progress: p });
      },
      (batch) => {
        // 迟到批次按 searchId 丢弃（旧检索的批次不许覆盖新检索读数；reset 后
        // phase 也守一道，与进度口径逐字一致）。done 批只是"最后一批"，
        // 完成态以返回值收口。
        if (state.searchId !== searchId || state.phase !== 'running') return;
        set({ streamFiles: acceptFilesBatch(state.streamFiles ?? [], searchId, batch) });
      },
    );
    if (state.searchId !== searchId) return; // 期间又发起过一次：这一份直接丢
    set({
      phase: 'done',
      // 收口：以完成态为准（累积只是在途视图）——列表必须与摘要同源，
      // 理由见 reconcileStreamFiles
      result: { ...result, files: reconcileStreamFiles(result) },
      progress: null,
      streamFiles: null,
      // 查询快照取**发请求那一刻**的 `request.query`（= 这份结果的判据）；
      // 完成前作者又改过输入框时，Enter 应重搜而不是拿旧结果跳（见 `stepSearchMatch`）
      resultQuery: request.query,
      matchCursor: -1,
    });
  } catch (e: unknown) {
    if (state.searchId !== searchId) return;
    set({
      phase: 'error',
      error: errorText(e),
      result: null,
      progress: null,
      appliedScope: null,
      streamFiles: null,
      resultQuery: null,
      matchCursor: -1,
    });
  }
}

/**
 * 发起一次替换（R7 搜索替换批）。写盘操作的前置闸全部就地明示，不静默：
 *
 * - 执行者未装配 / 没有完成态结果 / 已在替换中 ⇒ 拒绝（各自给一条汇总文案）；
 * - 结果**不完整**（截断 / 被取消）⇒ 拒绝全部替换——对看不见的命中动手 = 替换面
 *   与屏幕上说的不是同一件事，宁可让作者先缩小范围（铁律 4）；
 * - 单条替换不做截断闸：那条命中就在屏幕上，截断与否与它无关。
 *
 * 落地后的刷新联动由面板负责（替换改变了盘上事实 ⇒ 用同一组条件重跑一次检索，
 * 结果行 / 计数当场说新真相；打开的标签是 Monaco live model，原生更新，无需另刷）。
 * 返回本次落点读数（前置闸拦下 = `null`，面板据此决定要不要刷新结果）。
 */
export async function runReplace(mode: ReplaceMode): Promise<ReplaceOutcome | null> {
  if (state.replaceRunning) return null;
  if (state.phase !== 'done' || state.result === null) {
    set({ replaceSummary: '没有可替换的检索结果' });
    return null;
  }
  if (replaceRunner === null) {
    set({ replaceSummary: '替换能力未装配（宿主层缺内核 io 通道）' });
    return null;
  }
  if (mode.kind === 'all' && (state.result.truncated || state.result.cancelled)) {
    set({
      replaceSummary: '结果不完整（已截断或被停止）——全部替换拒绝执行，请先缩小检索范围',
    });
    return null;
  }
  const request: ReplaceRequest = {
    query: state.query,
    options: { ...state.options },
    replaceText: state.replaceText,
    mode,
    files: state.result.files,
  };
  set({ replaceRunning: true, replaceSummary: null });
  try {
    const o = await replaceRunner(request);
    set({ replaceRunning: false, replaceSummary: replaceSummaryText(o) });
    return o;
  } catch (e: unknown) {
    set({
      replaceRunning: false,
      replaceSummary: `替换失败：${errorText(e)}`,
    });
    return null;
  }
}

/**
 * 请求停止当前检索：只发取消意图，**状态仍留 running** 直到后端如实回一份
 * `cancelled: true` 的结果——提前改成 done 会让界面说"搜完了"，而实际是被截断的。
 */
export async function stopSearch(): Promise<void> {
  if (state.phase !== 'running') return;
  const id = state.searchId;
  try {
    await canceller(id);
  } catch (e: unknown) {
    set({ error: errorText(e) });
  }
}

/**
 * 逐项导航（回车 / Shift+回车、F4 / Shift+F4 的数据面；`delta` = +1 下一项 / -1 上一项）。
 *
 * 顺序 = **面板显示序**（`sortSearchFiles` 同一把尺子），首尾回绕（与行导航
 * `rowNavDecision` 的 `nextRovingIndex` 同一条回绕口径）。
 *
 * 返回 `null` 的三种情形都由调用方转成"重搜"：
 * - 没有完成态结果（还在搜 / 从未搜过）；
 * - 查询改过（结果不是当前查询的，跳过去 = 拿旧读数骗人）；
 * - 结果里一条命中都没有。
 *
 * 游标只在**真的导航**时写：面板首次出结果不自动跳第一处（全项目检索不抢编辑器焦点），
 * 此时计数文案把第 1 项当"下一站"（见 `search-query.searchMatchCounterText`）。
 */
export function stepSearchMatch(delta: 1 | -1): SearchMatchTarget | null {
  if (state.phase !== 'done' || state.result === null) return null;
  if (state.query !== state.resultQuery) return null;
  const targets = searchMatchTargets(state.result.files, state.sortMode);
  if (targets.length === 0) return null;
  const current = state.matchCursor >= 0 && state.matchCursor < targets.length ? state.matchCursor : -1;
  const next =
    current < 0 ? (delta > 0 ? 0 : targets.length - 1) : (current + delta + targets.length) % targets.length;
  set({ matchCursor: next });
  return targets[next]!;
}

/**
 * 点中结果行（鼠标或 F4 的 `click()` 同一条路）⇒ 当前项落在那一行。
 * 按 `path + 行 + 列` 在**显示序**里找；找不到（结果已换 / 行列陈旧）就不动游标——
 * 不猜"大概是第几个"。
 */
export function selectSearchMatch(path: string, line: number, column: number): void {
  if (state.result === null) return;
  const targets = searchMatchTargets(state.result.files, state.sortMode);
  const index = targets.findIndex(
    (t) => t.path === path && t.match.line === line && t.match.column === column,
  );
  if (index >= 0 && index !== state.matchCursor) set({ matchCursor: index });
}

/** 整体回到初始态（项目关闭时调：检索根没了，旧结果留着只会误导） */
export function resetSearch(): void {
  state = {
    ...INITIAL,
    // 开关跨会话：现读一次存储（不是复用模块载入时的快照）——项目关开不该把
    // 作者刚切的判据悄悄翻回全关
    options: loadSearchOptionsPref(),
    // 最近检索同理：项目关闭不清历史（那是作者的工作记忆，不属于某个项目）
    queryHistory: loadSearchHistoryPref(),
    historyCursor: -1,
    historyDraft: '',
    focusNonce: state.focusNonce,
    replaceFocusNonce: state.replaceFocusNonce,
    // 「在此文件夹中搜索」的 nonce 与一次性范围根：范围根本属项目态（关项目即失效），
    // nonce 是"请翻上屏"的单调计数（复位会让壳层的"已服务过"判据把新请求吞掉）
    folderScopeNonce: state.folderScopeNonce,
  };
  notify();
}
