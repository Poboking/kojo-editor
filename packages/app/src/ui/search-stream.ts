import type { SearchFilesBatch, SearchFileResult, SearchResult } from '../bridge/search';

/**
 * 全文检索的**流式与排序纯逻辑**（P2-11；无 React、无 IPC，node 可单测）。
 *
 * 三件事，都与"完成态还在路上"这件事打交道：
 *   ① `acceptFilesBatch`——命中文件批次的在途累积（过期丢弃口径与进度事件逐字一致）；
 *   ② `reconcileStreamFiles`——在途累积 × 完成态的收口（**以完成态为准**）；
 *   ③ `sortSearchFiles`——结果排序投影（路径 / 命中数 / 文件名），对在途流式结果
 *      与完成态一视同仁（放在投影层，不依赖完成态存在）。
 *
 * 为什么独立成模块：这是数据判据不是渲染细节（与 `search-query.ts` 同族）——
 * "迟到批次不许覆盖新读数"这种口径只有在 node 里钉得住，渲染层跑不了。
 */

/* ------------------------------ 在途累积 ------------------------------ */

/**
 * 流式批次 → 在途累积。
 *
 * 过期丢弃口径与进度事件**逐字一致**：`batch.searchId !== expectedSearchId` 的
 * 迟到批次原样退回旧累积——旧检索的批次不许覆盖新检索的读数（store 还会在
 * `phase !== 'running'` 上再守一道，双保险）。
 *
 * `done` 批次不特殊处理：它只是"最后一批"（残留文件），完成态由 `search_text`
 * 的返回值收口（见 `reconcileStreamFiles`）。同路径只可能落在一个批次里——
 * 后端每个文件只由一个线程扫一次、只 drain 一次——所以直接追加，不猜哪份新。
 */
export function acceptFilesBatch(
  accumulated: readonly SearchFileResult[],
  expectedSearchId: number,
  batch: SearchFilesBatch,
): readonly SearchFileResult[] {
  if (batch.searchId !== expectedSearchId) return accumulated;
  if (batch.files.length === 0) return accumulated;
  return [...accumulated, ...batch.files];
}

/* ------------------------------ 收口校正 ------------------------------ */

/**
 * 在途累积的收口：**以完成态为准**——返回值就是 `final.files` 原样。
 *
 * 为什么不把累积里完成态没有的文件并回来：
 * ① 后端契约保证「最终结果 = 已 emit 批次 ∪ 收口残留批次」（Rust 侧
 *    `run_search_with_files` 的 accumulator + 末批，见 `SearchFilesPayload`
 *    的文档），即完成态必是事件流的超集——对齐时"并"与"不并"逐字相同；
 * ② 一旦真对不齐（后端缺陷），并集就会造出"**事件说三条、最终态说两条**"——
 *    列表比摘要多一个文件，读数撒谎。宁可少画，不可少说。
 *
 * 同路径冲突同样以完成态为准：完成态是后端按路径排序 + 上限裁决后的权威形态，
 * 且摘要读数（`searchSummaryText`）由它出——列表与摘要必须同源。
 */
export function reconcileStreamFiles(final: SearchResult): SearchFileResult[] {
  return final.files;
}

/* ------------------------------ 排序投影 ------------------------------ */

/** 结果排序档位（P2-11）：三选一，**默认路径**（与今天逐字一致） */
export type SearchSortMode = 'path' | 'matches' | 'name';

/** 默认排序 = 路径（Rust 侧完成态本来就是这个序；在途流式批次靠它归一） */
export const DEFAULT_SEARCH_SORT: SearchSortMode = 'path';

/** 排序档位的界面选项（顺序即下拉里的顺序） */
export const SEARCH_SORT_OPTIONS: ReadonlyArray<{ readonly mode: SearchSortMode; readonly label: string }> = [
  { mode: 'path', label: '按路径' },
  { mode: 'matches', label: '按命中数' },
  { mode: 'name', label: '按文件名' },
];

/** 整路径字典序（UTF-16 码元序；与 Rust 侧 `out_files.sort_by(|a, b| a.path.cmp(&b.path))` 同口径） */
function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 文件名（路径末段）：两种分隔符都认（Windows / POSIX 路径混排时要稳） */
export function searchFileNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * 结果文件清单排序（纯函数；**对在途流式结果同样成立**——它只看清单本身，
 * 不依赖完成态存在，所以流式批次随到随排、完成态到达即排）。
 *
 * - `path`：整路径升序 = 今天的缺省序（完成态本来就是这个序，重排是幂等的）；
 * - `matches`：命中数降序——屏幕上一眼先看到"撞得最狠的文件"；同数按路径升序，
 *   读数确定，不随批次到达顺序漂；
 * - `name`：文件名（末段）升序；同名（不同目录）按整路径升序。
 *
 * 排序是稳定序（ES2019 起 `Array.prototype.sort` 保证），且输入数组不被修改
 * （面板的 memo 依赖引用稳定性）。
 */
export function sortSearchFiles(
  files: readonly SearchFileResult[],
  mode: SearchSortMode,
): SearchFileResult[] {
  const out = files.slice();
  switch (mode) {
    case 'path':
      out.sort((a, b) => comparePath(a.path, b.path));
      return out;
    case 'matches':
      out.sort((a, b) => b.matches.length - a.matches.length || comparePath(a.path, b.path));
      return out;
    case 'name':
      out.sort(
        (a, b) =>
          comparePath(searchFileNameOf(a.path), searchFileNameOf(b.path)) || comparePath(a.path, b.path),
      );
      return out;
  }
}
