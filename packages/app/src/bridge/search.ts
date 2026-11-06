import { invoke, isTauri } from './invoke';

/**
 * 项目内全文检索的 IPC 封装（宿主内建能力）。
 *
 * 与 `register_write_domain` 同形：这是**宿主专属**的原生命令（`search_text` /
 * `cancel_search`，见 `src-tauri/src/lib.rs`），不经过内核与插件，因此不改
 * `PlatformBridge` 契约——那条契约有四个实现（tauri / node / 各测试桩），
 * 为一个宿主能力去动它等于让所有实现跟着改。
 *
 * 为什么在 Rust 侧检索（而不是内核 `kernel.compute` 时间片池）：语料 3.8k 文件 /
 * 4.1M 行，索引阶段单是读盘就 45.1s（并发 8 摊到 ~9.0s 墙钟）。检索每次都要全量
 * 重读——把这份字节搬过 IPC 再在 JS 里逐行匹配，等于把最贵的一段压在最热的路径上，
 * 还会把 4M 行的副本留在 WebView 内存里。原生多线程在同一份字节上匹配，只有命中行过界。
 */

export interface SearchMatch {
  /** 1 基行号 */
  line: number;
  /** 1 基列号（UTF-16 code unit，与 Monaco 同口径） */
  column: number;
  /** 命中行文本（超长行以命中为中心开窗，省略号已含在串里） */
  preview: string;
  /** 命中区间在 `preview` 内的起止（UTF-16 code unit，半开） */
  start: number;
  end: number;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

/** 没参与检索的文件计数（跳过的理由逐项可见，不静默） */
export interface SearchSkipped {
  binary: number;
  tooLarge: number;
  unreadable: number;
  filtered: number;
  /**
   * 被排除模式（`excludeGlobs`）挡下的文件数（WS-10）。**可选**：老宿主 / 老调试宿
   * 的载荷没有这个键 ⇒ 读数侧按 0 处理，不谎报也不炸。
   */
  excluded?: number;
}

export interface SearchResult {
  files: SearchFileResult[];
  totalMatches: number;
  /** 结果不完整（命中上限 / 单文件上限 / 取消）——界面必须显式说明 */
  truncated: boolean;
  cancelled: boolean;
  filesScanned: number;
  skipped: SearchSkipped;
  elapsedMs: number;
  /**
   * **续取回显**（B18，additive）：本次因 `options.resumeAfterMatches` 实际丢掉的命中条数
   * （逐文件求和）。不带凭据时恒 0；老宿主 / 调试宿 Node 镜像没这个键 ⇒ 读取侧按
   * 「这台宿主不认续取凭据」处理，绝不把「没回显」当成「续上了」。
   */
  resumeAppliedMatches?: number;
  /**
   * 软时限账（MCP-PERF-S1，additive）：结果不完整是因为 `options.deadlineMs` 到点
   * （与 `truncated`（命中上限）/ `cancelled`（取消）三账分立）。老宿主没这个键
   * ⇒ 读取侧按 false 处理，不谎报也不炸。
   */
  partial?: boolean;
  /** `partial` 的原因码：partial=false 恒缺席；当前唯一取值 "deadline"。 */
  partialReason?: string;
}

export interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** 限定扩展名（小写、不含点；空数组 = 不限） */
  extensions: string[];
  maxResults?: number;
  /**
   * include glob（P2-15 已落地、W7-A 接线）：按**路径形态**过滤候选文件
   * （`*.kojo` / `src/**`/`*.erb` / `?`），与 `extensions` 是**且**的关系（两者都满足才扫），
   * 大小写**敏感**（显式路径模式显式匹配，与扩展名"折小写再比"刻意不同）。
   * 匹配基准 = 相对检索根的路径；翻译与判据见 Rust `glob_to_regex` / `collect_files`
   * （TS 对拍镜像在 `tests/search-glob.test.ts`，`parseFileFilter` 是装配腿）。
   * 空 / 缺省 = **不带这个键** = 不按形态过滤（老请求体逐字一致，与 Rust DTO 的 `None` 同义）。
   * 被它挡下的文件计入 `skipped.filtered`（glob 也是类型过滤的一种形态，同一行读数、不静默）。
   * （本注释里 `**` 与 `/` 刻意分写：块注释中 `*` 紧跟 `/` 会提前终止注释。）
   */
  globs?: readonly string[];
  /**
   * 排除模式（WS-10）：gitignore-lite 语义（`**` 跨目录、`*`/`?` 不跨、
   * 不含 `/` 的模式按文件名匹配任意深度、前导 `!` 取反、后写的规则赢）。
   * 与 `globs`（include）是**先 include 后 exclude** 的关系：include 筛出的候选里，
   * 命中任一未被取反回捞的排除模式的文件不进检索，计入 `skipped.excluded`。
   * 空 / 缺省 = 不排除（老请求体逐字一致）。匹配基准与翻译规则见 Rust
   * `compile_exclude_rules`（对拍口径见 `search-query.parseExcludePatterns`）。
   */
  excludeGlobs?: readonly string[];
  /**
   * **逐文件续取凭据**（B18，additive）：对**每个**候选文件先丢掉前 N 条命中，再按原有三闸
   * （单文件 500 / `maxResults` / 单次 5,000）收口。缺省不传 ⇒ 请求体与旧面逐字相同。
   * 单位是「该文件内的命中条数」，不是字节 / 行号；回显见 `SearchResult.resumeAppliedMatches`。
   * 现在只有 MCP 分片腿（`resumeBySlice`）用它——界面检索面板不传，行为零变化。
   */
  resumeAfterMatches?: number;
  /**
   * 软时限（MCP-PERF-S1，additive）：自检索起点起算的毫秒预算。到点后不再领取新文件，
   * 回 `partial:true` + `partialReason:"deadline"` 的部分结果。缺省不传 ⇒ 无时限，
   * 请求体与旧面逐字相同。软保证：粒度是单文件，停在文件边界上。
   */
  deadlineMs?: number;
}

export interface SearchRequest {
  /** 调用方自增 id：进度事件按它过滤，取消按它认领 */
  searchId: number;
  roots: string[];
  query: string;
  options: SearchOptions;
}

export interface SearchProgress {
  searchId: number;
  filesScanned: number;
  totalFiles: number;
  matchCount: number;
}

/** 与 `src-tauri/src/lib.rs` 的 `SEARCH_PROGRESS_EVENT` 成对 */
const PROGRESS_EVENT = 'kojo:search-progress';

/** 与 `src-tauri/src/lib.rs` 的 `SEARCH_FILES_EVENT` 成对（P2-11 流式增量） */
const FILES_EVENT = 'kojo:search-files';

/**
 * 流式批次载荷（P2-11）：命中文件随扫随到。
 *
 * 对齐契约（与 Rust 侧 `SearchFilesPayload` 逐字同形）：**完成态是事件流的超集**
 * （最终结果 = 已 emit 批次 ∪ 收口残留批次），`done: true` 只有最后一批；
 * 中途批次的 `truncated` / `cancelled` 只是当时所知，壳层不作准——以 `search_text`
 * 的返回值收口。批次按 `searchId` 过滤：旧检索的迟到批次不许覆盖新检索的读数。
 */
export interface SearchFilesBatch {
  searchId: number;
  files: SearchFileResult[];
  done: boolean;
  truncated: boolean;
  cancelled: boolean;
}

/**
 * 执行一次检索。`onProgress` 收逐文件进度（由 Rust 侧节流后上报）；
 * `onFiles` 收命中文件增量批次（同一节流点，P2-11）——完成态仍由返回值收口。
 * 非 Tauri 环境**显式失败**（浏览器开发壳没有原生检索能力），不静默返回空结果；
 * 例外：选入 web 调试模式（`?kojo-debug=1`）时改走调试宿——完成态同样由返回值收口，
 * 进度 / 增量批次事件不订阅（调试宿 v1 不发这两条，检索 UI 一次到位）。
 */
export async function searchInFiles(
  request: SearchRequest,
  onProgress?: (p: SearchProgress) => void,
  onFiles?: (batch: SearchFilesBatch) => void,
): Promise<SearchResult> {
  if (!isTauri()) {
    const { webHostInvokeIfActive } = await import('../debug/web-host-transport');
    const route = await webHostInvokeIfActive('search_text', { request });
    if (route.active) return route.value as SearchResult;
    throw new Error('全文搜索需要桌面壳（浏览器开发壳没有原生检索命令）');
  }
  let unlistenProgress: (() => void) | null = null;
  let unlistenFiles: (() => void) | null = null;
  if (onProgress) {
    const { listen } = await import('@tauri-apps/api/event');
    unlistenProgress = await listen<SearchProgress>(PROGRESS_EVENT, (e) => {
      // 多条检索并发时按 id 过滤（旧检索的迟到进度不许覆盖新检索的读数）
      if (e.payload.searchId === request.searchId) onProgress(e.payload);
    });
  }
  if (onFiles) {
    const { listen } = await import('@tauri-apps/api/event');
    unlistenFiles = await listen<SearchFilesBatch>(FILES_EVENT, (e) => {
      // 同 progress：迟到批次按 searchId 过滤（过期丢弃口径不变）
      if (e.payload.searchId === request.searchId) onFiles(e.payload);
    });
  }
  try {
    return await invoke<SearchResult>('search_text', { request });
  } finally {
    unlistenProgress?.();
    unlistenFiles?.();
  }
}

/** 请求取消某条检索（检索线程逐文件检查，命中即提前收尾并如实回报 `cancelled`） */
export async function cancelSearch(searchId: number): Promise<void> {
  if (!isTauri()) {
    // 调试模式下转发给调试宿（宿侧同步取消标记）；未选入则保持既有静默返回
    const { webHostInvokeIfActive } = await import('../debug/web-host-transport');
    await webHostInvokeIfActive('cancel_search', { searchId });
    return;
  }
  await invoke('cancel_search', { searchId });
}
