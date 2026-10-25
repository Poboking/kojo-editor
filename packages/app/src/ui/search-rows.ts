import type { SearchMatch } from '../bridge/search';

/**
 * 检索结果的**扁平行投影 + 虚拟列表几何**（PERF 搜索批）。
 *
 * 为什么单独一枚叶子模块，而不是塞回 `search-query.ts`：
 * `search-query` 是**开机图**里的（`search-store` 静态引它拿查询构造 / 历史 / 摘要），
 * 而这份几何只有检索面板用，面板是懒加载的。混在一起的代价是开机包多背几 KB
 * （`ps10-eager-graph` 的量尺：搬到本文件后开机图 3,124 → 3,100 上下），
 * 而它换来的东西开机时一行都用不到。判据仍是一条：**谁真用，谁才付钱**。
 *
 * 本文件只做纯函数（无 DOM、无 React）：账本、窗口、折叠裁剪都能在单测里零环境跑。
 */

/** 扁平化后的结果行：文件头 + 其下各命中（渲染层按此列表画，不需再懂结构） */
export type SearchRow =
  | { kind: 'file'; path: string; count: number }
  | { kind: 'match'; path: string; match: SearchMatch };

/**
 * 结果 → 扁平行列表（**全量**，不做渲染截断）。
 *
 * `folded`（折叠的文件集合）在**投影层**就裁掉命中行：虚拟列表按"这份扁平行"算偏移，
 * 折叠若只在渲染时跳过，行高账本会多出一整块空白。文件头一律保留（折叠态要能点开），
 * 计数仍取后端给的文件级总数（截断只裁渲染行，不许把计数裁小）。
 */
export function searchRowsOf(
  files: readonly { path: string; matches: readonly SearchMatch[] }[],
  folded: ReadonlySet<string> = new Set<string>(),
): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const f of files) {
    rows.push({ kind: 'file', path: f.path, count: f.matches.length });
    if (folded.has(f.path)) continue;
    for (const m of f.matches) rows.push({ kind: 'match', path: f.path, match: m });
  }
  return rows;
}

/**
 * 结果 → 扁平行列表（`cap` 是渲染上限：上万行 DOM 会拖垮面板，与问题面板同精神）。
 * 文件头也算一行——被裁掉的可能是整块的命中，界面要能说清"还有多少没显示"。
 *
 * 面板自 PERF 批起改走虚拟列表（`searchRowsOf` + `searchRowWindow`），这里保留给
 * 调用方与既有判据：它就是 `searchRowsOf` 的前 `cap` 行，口径不分叉。
 */
export function flattenSearchResults(
  files: readonly { path: string; matches: readonly SearchMatch[] }[],
  cap: number,
): { rows: SearchRow[]; hidden: number } {
  const rows = searchRowsOf(files);
  if (rows.length <= cap) return { rows, hidden: 0 };
  return { rows: rows.slice(0, cap), hidden: rows.length - cap };
}

/* ------------------------------ 虚拟列表几何 ------------------------------ */

/**
 * 两档行高（**实测的自然高度**，不写死 px）：
 * 文件头（`min-height: 22px` + padding + 顶线）与命中行（`--fs-1` 字号下的单行）
 * 高度不同，且都随界面字号缩放（`--fs-*` 由设置页写在根上行内）而变——
 * 所以真源是"量"，不是常量；这里只给**量到之前**的缺省（12px 字号下的实测值）。
 */
export interface SearchRowHeights {
  readonly file: number;
  readonly match: number;
}

/** 还没量到真行高时的缺省（12px 字号实测：文件头 23 / 命中行 25.6） */
export const SEARCH_ROW_HEIGHTS_FALLBACK: SearchRowHeights = { file: 23, match: 25.6 };

/** 扁平行 → 前缀和账本（`offsets[i]` = 第 i 行的顶边，末位 = 总高） */
export interface SearchRowLedger {
  readonly offsets: number[];
  readonly total: number;
}

/**
 * 扁平行 → 行顶边前缀和（虚拟列表的全部几何都从这一份账本读）。
 *
 * 为什么不用 `index * 行高`：一份结果里混着两档行高（文件头 / 命中行），
 * 用单一常量算出来的偏移会从第一个文件头之后就开始漂——滚到第 2,000 行时
 * 差出几十行，视口里画的是别的行（"点这条跳到那条"）。
 */
export function searchRowOffsets(rows: readonly SearchRow[], h: SearchRowHeights): SearchRowLedger {
  const offsets = new Array<number>(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i += 1) {
    offsets[i] = y;
    y += rows[i]!.kind === 'file' ? h.file : h.match;
  }
  offsets[rows.length] = y;
  return { offsets, total: y };
}

/** 一次渲染窗口：`[start, end)` 内的行进 DOM，两侧用留白顶起滚动高度 */
export interface SearchRowWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
  readonly total: number;
}

/** 空窗口（没有结果时用它，避免调用方各写一份零值字面量） */
export const EMPTY_ROW_WINDOW: SearchRowWindow = { start: 0, end: 0, topPad: 0, bottomPad: 0, total: 0 };

/** 包含纵坐标 `y` 的行下标（`y` 越界 ⇒ 夹到首/末行；纯二分，O(log n)） */
function rowIndexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  if (y <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 视口 → 渲染窗口（**纯函数**，虚拟列表的判据全在这里，渲染层只照着画）。
 *
 * `viewTop` = 视口顶边在结果内容里的坐标（调用方按"结果区 × 最近可滚动祖先 × sticky 控制区"
 * 算出来；减掉容器自身的 padding），`viewHeight` = 视口高度，`overscan` = 上下各多画多少像素
 * （滚动时新行已经在位，不至于滚出一片空白）。
 *
 * 三条不变式（`search-virtual-rows.test.ts` 钉住）：
 *  ① `topPad + Σ窗口内行高 + bottomPad === total`（滚动高度不缩水，滚动条不说谎）；
 *  ② 窗口**必定**覆盖 `[viewTop, viewTop + viewHeight)`（不掉行）；
 *  ③ 窗口长度 ≤ 可见行数 + 2×overscan 折算的行数 + 2（上界可算，DOM 不随命中数长）。
 */
export function searchRowWindow(
  offsets: readonly number[],
  viewTop: number,
  viewHeight: number,
  overscan: number,
): SearchRowWindow {
  const n = offsets.length - 1;
  if (n <= 0) return EMPTY_ROW_WINDOW;
  const total = offsets[n]!;
  const top = Math.max(0, Math.min(viewTop, total));
  const height = Math.max(0, Math.min(viewHeight, total - top));
  const start = rowIndexAt(offsets, Math.max(0, top - overscan));
  // 底边贴着内容末尾时 `rowIndexAt` 会落到末行，+1 越界 ⇒ 由 `min` 收口
  const end = Math.min(n, rowIndexAt(offsets, Math.min(total, top + height + overscan)) + 1);
  return {
    start,
    end: Math.max(start, end),
    topPad: offsets[start]!,
    bottomPad: total - offsets[Math.max(start, end)]!,
    total,
  };
}

/** 两个窗口是否同形（渲染层据此跳过一次 setState：滚动时大量帧的窗口不变） */
export function sameRowWindow(a: SearchRowWindow, b: SearchRowWindow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.topPad === b.topPad &&
    a.bottomPad === b.bottomPad &&
    a.total === b.total
  );
}
