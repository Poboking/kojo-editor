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
}

export interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** 限定扩展名（小写、不含点；空数组 = 不限） */
  extensions: string[];
  maxResults?: number;
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

/**
 * 执行一次检索。`onProgress` 收逐文件进度（由 Rust 侧节流后上报）。
 * 非 Tauri 环境**显式失败**（浏览器开发壳没有原生检索能力），不静默返回空结果。
 */
export async function searchInFiles(
  request: SearchRequest,
  onProgress?: (p: SearchProgress) => void,
): Promise<SearchResult> {
  if (!isTauri()) {
    throw new Error('全文搜索需要桌面壳（浏览器开发壳没有原生检索命令）');
  }
  let unlisten: (() => void) | null = null;
  if (onProgress) {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<SearchProgress>(PROGRESS_EVENT, (e) => {
      // 多条检索并发时按 id 过滤（旧检索的迟到进度不许覆盖新检索的读数）
      if (e.payload.searchId === request.searchId) onProgress(e.payload);
    });
  }
  try {
    return await invoke<SearchResult>('search_text', { request });
  } finally {
    unlisten?.();
  }
}

/** 请求取消某条检索（检索线程逐文件检查，命中即提前收尾并如实回报 `cancelled`） */
export async function cancelSearch(searchId: number): Promise<void> {
  if (!isTauri()) return;
  await invoke('cancel_search', { searchId });
}
