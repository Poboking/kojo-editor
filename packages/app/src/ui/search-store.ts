import {
  cancelSearch,
  searchInFiles,
  type SearchMatch,
  type SearchProgress,
  type SearchRequest,
  type SearchResult,
} from '../bridge/search';
import { errorText } from '@kojo/plugin-api';
import { DEFAULT_EXTENSION_TEXT, isValidSearchQuery, parseExtensions, replaceSummaryText } from './search-query';
import { scopeUnreachableText, type AppliedSearchScope } from './search-scope';

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
  /** 类型过滤框的原始文本（解析成扩展名列表在发请求那一刻做） */
  extensionText: string;
  phase: SearchPhase;
  /** 检索中的实时进度（非 running 态恒为 null，避免展示过期读数） */
  progress: SearchProgress | null;
  result: SearchResult | null;
  error: string | null;
  /** 最近一次检索的 id：进度与取消都按它认领（多条检索并发时不许串线） */
  searchId: number;
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
}

/** 检索执行者（注入 seam：缺省 = Tauri 桥；单测注入假实现） */
export type SearchRunner = (
  request: SearchRequest,
  onProgress: (p: SearchProgress) => void,
) => Promise<SearchResult>;

/** 单条替换的目标：检索结果里那一处命中（1 基行列，与 `SearchMatch` 同口径） */
export interface MatchTarget {
  readonly path: string;
  readonly line: number;
  readonly column: number;
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

const INITIAL: SearchState = {
  query: '',
  options: { isRegex: false, caseSensitive: false, wholeWord: false },
  extensionText: DEFAULT_EXTENSION_TEXT,
  phase: 'idle',
  progress: null,
  result: null,
  error: null,
  searchId: 0,
  focusNonce: 0,
  scopeKey: '',
  appliedScope: null,
  replaceText: '',
  replaceFocusNonce: 0,
  replaceRunning: false,
  replaceSummary: null,
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

export function setQuery(query: string): void {
  set({ query });
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
}

/**
 * 选定检索范围（`''` = 不限）。切换**不改已有结果**（与三个开关同语义：下次检索才生效），
 * 所以这里只动 `scopeKey`，不动 `appliedScope`——后者是"出这份结果时用的范围"。
 */
export function setSearchScope(key: string): void {
  set({ scopeKey: key });
}

/** 三个开关（正则 / 大小写 / 全词）——切换不改结果，下次检索才生效 */
export function toggleOption(key: keyof SearchOptionsState): void {
  set({ options: { ...state.options, [key]: !state.options[key] } });
}

/** 快捷键 / 命令入口：请求面板聚焦（面板订阅 `focusNonce` 落地） */
export function requestSearchFocus(): void {
  set({ focusNonce: state.focusNonce + 1 });
}

/** 清空结果与错误（保留查询条件与开关——"清空结果"不是"重置面板"） */
export function clearSearchResult(): void {
  if (state.phase === 'running') return;
  set({ result: null, error: null, phase: 'idle', progress: null, appliedScope: null, replaceSummary: null });
}

/**
 * 发起一次检索。前置校验失败就地落 error 态（不静默：空查询 / 无根目录都不发请求）。
 * 单飞：正在跑时重复调用直接返回（想打断请走 `stopSearch`）。
 *
 * `applied`（C3 检索范围批，**additive**）：调用方已经把检索根按范围收窄好了，这里只
 * 带上新增的两件事——①收窄后可能一个根都不剩（此时报错文案要说清"是范围没落进项目"，
 * 不是"没打开项目"）；②结果要能说出"这轮只扫了哪个范围"。
 * **不传 ⇒ 行为与今天逐字一致**（老调用方零改动）。
 */
export async function runSearch(
  roots: readonly string[],
  applied?: AppliedSearchScope | null,
): Promise<void> {
  if (!isValidSearchQuery(state.query)) {
    set({ phase: 'error', error: '请输入检索词', result: null, progress: null, appliedScope: null });
    return;
  }
  if (roots.length === 0) {
    set({
      phase: 'error',
      error: applied ? scopeUnreachableText(applied) : '没有可检索的根目录（请先打开项目）',
      result: null,
      progress: null,
      appliedScope: null,
    });
    return;
  }
  if (state.phase === 'running') return;

  const searchId = nextId++;
  const request: SearchRequest = {
    searchId,
    roots: [...roots],
    query: state.query,
    options: { ...state.options, extensions: parseExtensions(state.extensionText) },
  };
  set({
    searchId,
    phase: 'running',
    error: null,
    result: null,
    progress: null,
    appliedScope: applied ?? null,
  });

  try {
    const result = await runner(request, (p) => {
      // 迟到进度不许覆盖新检索的读数
      if (state.searchId === searchId && state.phase === 'running') set({ progress: p });
    });
    if (state.searchId !== searchId) return; // 期间又发起过一次：这一份直接丢
    set({ phase: 'done', result, progress: null });
  } catch (e: unknown) {
    if (state.searchId !== searchId) return;
    set({
      phase: 'error',
      error: errorText(e),
      result: null,
      progress: null,
      appliedScope: null,
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

/** 整体回到初始态（项目关闭时调：检索根没了，旧结果留着只会误导） */
export function resetSearch(): void {
  state = { ...INITIAL, focusNonce: state.focusNonce, replaceFocusNonce: state.replaceFocusNonce };
  notify();
}
