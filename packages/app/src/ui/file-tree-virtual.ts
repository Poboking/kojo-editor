/**
 * 树行的**虚拟化窗口**判据（WS-12 规模能力批；零 React，可单测）。
 *
 * 与 `file-tree-filter-window` 的分工：那张纸管"过滤态一帧最多给看多少命中"（**预算**，
 * 点「继续显示」逐批追加），这张纸管"滚动到哪就该挂哪几行"（**视口**，跟着 scrollTop 走）。
 * 两者叠用：先按预算裁掉不给的行，再按视口裁掉看不见的行 ⇒ 计划说多少、DOM 就挂多少，
 * 不会出现"计划与挂载各算各的"那种账（本仓的老口径）。
 *
 * ## 为什么按像素而不是按行数算窗口
 *
 * 行模型（`file-tree-flat`）给每一行算了 `top`，其中已经含了各级 `<ul>` 的下边距。
 * 只按"第 n 行 = n × 22px"推的位置，在真实语料上会累积几百像素的偏差——
 * 表现为滚到底时下面露出一段空白、或视口里的行根本没挂上。
 */
import { TREE_ROW_H, type FlatRow, type LeafBlock } from './file-tree-flat';

/** 视口上下各多挂的行数（滚动时不至于先看见空白再等 React 挂行） */
export const VIRTUAL_OVERSCAN_ROWS = 10;

/**
 * 容器高度量不出来时的兜底视口（30 行）。
 *
 * 为什么要有这一档而不是"量不到就全挂"：SSR、happy-dom 单测、面板还没布局好的第一帧
 * 都会读到 0 —— 全挂就是把本次批要修的"两千行同帧挂载"请回来；挂 0 行则屏幕上什么都没有。
 * 兜底一帧之后就有真实的 `clientHeight`（挂载时量一次，滚动时再量一次）。
 */
export const FALLBACK_VIEWPORT_H = 660;

/** 视口对应的行区间 `[start,end)` */
export interface VisibleRange {
  readonly start: number;
  readonly end: number;
}

const FULL: VisibleRange = { start: 0, end: 0 };

/** 行数组按 `top` 升序 ⇒ 二分找"最后一个 top <= y 的行"（空数组 = -1） */
function lastRowAtOrAbove(rows: readonly FlatRow[], y: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid] as FlatRow).top <= y) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit;
}

/** 第一个 `top >= y` 的行下标（= 全部都比 y 矮时的插入位） */
function firstRowAtOrBelow(rows: readonly FlatRow[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid] as FlatRow).top < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 视口 `[scrollTop, scrollTop+viewportH)` 覆盖到的行区间（含 overscan，端点夹进数组内） */
export function visibleRange(
  rows: readonly FlatRow[],
  scrollTop: number,
  viewportH: number,
  overscanRows: number = VIRTUAL_OVERSCAN_ROWS,
): VisibleRange {
  if (rows.length === 0) return FULL;
  const top = Math.max(0, scrollTop);
  const height = viewportH > 0 ? viewportH : FALLBACK_VIEWPORT_H;
  const start = Math.max(0, lastRowAtOrAbove(rows, top) - overscanRows);
  const end = Math.min(rows.length, firstRowAtOrBelow(rows, top + height) + overscanRows);
  return { start, end };
}

/** 整段都挂（文件系统视图用的那档：行模型照建，但一行都不裁） */
export function fullRange(total: number): VisibleRange {
  return { start: 0, end: total };
}

/** 一个叶子块的挂载结果：渲染 `[from,to)` 行，前后各垫 `leadPx` / `trailPx` 像素 */
export interface BlockSlice {
  readonly from: number;
  readonly to: number;
  readonly leadPx: number;
  readonly trailPx: number;
}

const NO_ROWS: BlockSlice = { from: 0, to: 0, leadPx: 0, trailPx: 0 };

/**
 * 把一个叶子块（一个包的 ERB 列表 / 一段根散文件）裁进视口。
 *
 * 三条不变量（都由 `file-tree-virtual.test.ts` 钉住）：
 * 1. `leadPx + (to-from)*档 + trailPx` 恒等于整块的真实高度 ⇒ 裁行不让滚动高度变化；
 * 2. 整块在视口之上 ⇒ 只垫高不挂行；整块在视口之下同理；
 * 3. 块空 / 行缺失 ⇒ 全零（不渲染占位，也不撒谎说垫了高）。
 */
export function sliceBlock(block: LeafBlock, rows: readonly FlatRow[], range: VisibleRange): BlockSlice {
  const total = block.end - block.start;
  if (total <= 0 || rows.length === 0) return NO_ROWS;
  const first = rows[block.start] as FlatRow;
  const last = rows[block.end - 1] as FlatRow;
  const blockTop = first.top;
  const blockBottom = last.top + TREE_ROW_H;
  const keptPx = Math.max(0, blockBottom - blockTop);
  // 整块在视口之外：一律不挂行，只在**块的那一侧**垫高（判据比的是区间端点，不看裁剪结果）
  if (range.start >= block.end) return { from: block.end, to: block.end, leadPx: keptPx, trailPx: 0 };
  if (range.end <= block.start) return { from: block.start, to: block.start, leadPx: 0, trailPx: keptPx };
  const from = Math.max(block.start, range.start);
  const to = Math.min(block.end, range.end);
  if (from >= to) return { from: block.start, to: block.start, leadPx: keptPx, trailPx: 0 };
  const leadRow = rows[from] as FlatRow;
  const trailRow = rows[to] as FlatRow | undefined;
  return {
    from,
    to,
    leadPx: Math.max(0, leadRow.top - blockTop),
    trailPx: trailRow === undefined ? 0 : Math.max(0, blockBottom - trailRow.top),
  };
}

/** 垫高样式（0 高不落 DOM）；行数由调用侧给，这里只做 px 串 */
export function spacerStyle(px: number): { height: string } | null {
  return px > 0 ? { height: `${px}px` } : null;
}

/**
 * 锚点保持：展开 / 收起之后把锚点行顶回它原来在视口里的位置（WS-12「视口不跳」）。
 *
 * 浏览器只会保持 `scrollTop` 不变——而展开一个上面的组会把内容整体下推，
 * `scrollTop` 不变就意味着作者盯着的那一行跑掉了。这里改成保持**锚点行的视口内偏移**：
 * 新 `scrollTop = 原 scrollTop + (锚点新位置 − 锚点旧位置)`，再夹进内容范围。
 */
export function anchorScrollTop(prevTopPx: number, newTopPx: number, prevScrollTop: number, maxScroll: number): number {
  const next = prevScrollTop + (newTopPx - prevTopPx);
  return Math.min(Math.max(0, next), Math.max(0, maxScroll));
}

/**
 * 滚到"刚好可见"（键盘导航用；与 DOM 的 `scrollIntoView({block:'nearest'})` 同语义，
 * 但按行模型算 ⇒ 焦点行还没挂载时也能先滚、后挂、再聚焦）。
 */
export function scrollToShow(rowTopPx: number, scrollTop: number, viewportH: number, maxScroll: number): number {
  const height = viewportH > 0 ? viewportH : FALLBACK_VIEWPORT_H;
  if (rowTopPx < scrollTop) return Math.max(0, rowTopPx);
  if (rowTopPx + TREE_ROW_H > scrollTop + height) return Math.min(Math.max(0, maxScroll), rowTopPx + TREE_ROW_H - height);
  return Math.min(Math.max(0, scrollTop), Math.max(0, maxScroll));
}

/** 滚动事件里读出的现场（`viewportH <= 0` 视为没量到，走兜底档） */
export function scrollViewportH(clientHeight: number): number {
  return clientHeight > 0 ? clientHeight : FALLBACK_VIEWPORT_H;
}
