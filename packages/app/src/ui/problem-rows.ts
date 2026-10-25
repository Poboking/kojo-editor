import type { EditorProblem } from './problem-store';
import type { ProblemGroup } from './problem-filter';

/**
 * 问题列表的**扁平行投影 + 虚拟列表几何**（1025 性能批 A 线：问题面板真窗口化）。
 *
 * 为什么单独一枚叶子：这份几何只有问题面板用（面板是底部容器的一个视图），
 * 而它是纯函数（无 DOM、无 React）——账本、窗口都能在单测里零环境跑。
 * 与检索面板的 `search-rows.ts` 同一套判据（那边 2026-10-25 先落地，模板照抄，
 * 不自己发明第二套几何）：两档行高（组头 / 问题行）逐行累加，绝不假设"行高相等"。
 *
 * ## 为什么必须扁平
 *
 * 旧结构是 `ul.prob-list > li.prob-group > (组头 + ul.prob-group-rows > li.prob-item)`，
 * 虚拟化后窗口可以从**任意一行**开始——它可能是一个组的中段，也可能是一个组头；
 * 嵌套结构一旦跨窗口截断，`<ul>` 里就会挂着半截组。所以把"组头 + 行"拍平成一维：
 * 组头也是列表的一项（`kind: 'group'`），行是另一项（`kind: 'item'`）。
 * 代价是分组语义不再由 DOM 嵌套表达（组头仍带 `aria-expanded`，行仍带路径身份），
 * 换来的是一条恒定的 DOM：**滚到哪画到哪，行数与总诊断数解耦**。
 *
 * ## 折叠在投影层减行
 *
 * 折叠组的行**不进这份清单**：账本按这份清单算偏移，折叠若只在渲染时跳过，
 * 行高账本会多出一整块空白（滚到后面全是空气）。组头一律保留（折叠态要能点开）。
 */

/** 扁平后的列表项：组头（可折叠）或一条问题 */
export type ProblemRow =
  | { readonly kind: 'group'; readonly group: ProblemGroup }
  | {
      readonly kind: 'item';
      readonly group: ProblemGroup;
      readonly problem: EditorProblem;
      /** 这条问题在**过滤后全序**里的下标（渲染 key 与行内回执键的一部分） */
      readonly itemIndex: number;
    };

/**
 * 分组 + 折叠集 → 扁平行清单（**全量**，不做渲染截断）。
 *
 * 组头在前、组内行随后，组序 = `groupProblems` 给的首次出现序（本函数不重排）。
 */
export function problemRowsOf(
  groups: readonly ProblemGroup[],
  collapsed: ReadonlySet<string> = new Set<string>(),
): ProblemRow[] {
  const rows: ProblemRow[] = [];
  for (const g of groups) {
    rows.push({ kind: 'group', group: g });
    if (collapsed.has(g.path)) continue;
    for (let i = 0; i < g.items.length; i += 1) {
      rows.push({
        kind: 'item',
        group: g,
        problem: g.items[i]!,
        itemIndex: g.indices[i]!,
      });
    }
  }
  return rows;
}

/**
 * 两档行高（**实测的自然高度**，不写死 px 意义上的"设计值"）：
 * 组头（`min-height: 24px` + 组分隔线）与问题行（`.prob-row` 的 `min-height: 22px`）
 * 高度不同，且都随界面字号缩放（`--fs-*` 由设置页写在根上行内）而变——
 * 真源是"量"，不是常量；这里只给**量到之前**的缺省（12px 字号下的实测值）。
 */
export interface ProblemRowHeights {
  readonly group: number;
  readonly item: number;
}

/** 还没量到真行高时的缺省（12px 字号实测：组头 25（24 + 1px 分隔线）/ 问题行 22） */
export const PROBLEM_ROW_HEIGHTS_FALLBACK: ProblemRowHeights = { group: 25, item: 22 };

/** 扁平行 → 前缀和账本（`offsets[i]` = 第 i 行的顶边，末位 = 总高） */
export interface ProblemRowLedger {
  readonly offsets: number[];
  readonly total: number;
}

/**
 * 扁平行 → 行顶边前缀和（虚拟列表的全部几何都从这一份账本读）。
 *
 * 为什么不用 `index * 行高`：一份清单里混着两档行高（组头 / 问题行），用单一常量
 * 算出来的偏移会从第一个组头之后就开始漂——滚到第 2,000 行时差出几十行，
 * 视口里画的是别的行（"点这条跳到那条"）。
 */
export function problemRowOffsets(
  rows: readonly ProblemRow[],
  h: ProblemRowHeights,
): ProblemRowLedger {
  const offsets = new Array<number>(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i += 1) {
    offsets[i] = y;
    y += rows[i]!.kind === 'group' ? h.group : h.item;
  }
  offsets[rows.length] = y;
  return { offsets, total: y };
}

/** 一次渲染窗口：`[start, end)` 内的行进 DOM，两侧用留白顶起滚动高度 */
export interface ProblemRowWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
  readonly total: number;
}

/** 空窗口（没有诊断时用它，避免调用方各写一份零值字面量） */
export const EMPTY_PROBLEM_ROW_WINDOW: ProblemRowWindow = {
  start: 0,
  end: 0,
  topPad: 0,
  bottomPad: 0,
  total: 0,
};

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
 * `viewTop` = 视口顶边在列表内容里的坐标（调用方按"列表区 × 最近可滚动祖先 × sticky
 * 控制区"算出来），`viewHeight` = 视口高度，`overscan` = 上下各多画多少像素
 * （滚动时新行已经在位，不至于滚出一片空白）。
 *
 * 三条不变式（`problem-virtual-rows.test.ts` 钉住）：
 *  ① `topPad + Σ窗口内行高 + bottomPad === total`（滚动高度不缩水，滚动条不说谎）；
 *  ② 窗口**必定**覆盖 `[viewTop, viewTop + viewHeight)`（不掉行）；
 *  ③ 窗口长度 ≤ 可见行数 + 2×overscan 折算的行数 + 2（上界可算，DOM 不随总数长）。
 */
export function problemRowWindow(
  offsets: readonly number[],
  viewTop: number,
  viewHeight: number,
  overscan: number,
): ProblemRowWindow {
  const n = offsets.length - 1;
  if (n <= 0) return EMPTY_PROBLEM_ROW_WINDOW;
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
export function sameProblemRowWindow(a: ProblemRowWindow, b: ProblemRowWindow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.topPad === b.topPad &&
    a.bottomPad === b.bottomPad &&
    a.total === b.total
  );
}

/**
 * 问题行在扁平清单里的位置（行导航按**绝对序号**走：DOM 序只覆盖窗口）。
 * 组头不参与行导航（它自己就是按钮，但 ↑↓ 只漫游问题行，与窗口化前一致）。
 */
export function problemItemRowIndex(rows: readonly ProblemRow[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i += 1) if (rows[i]!.kind === 'item') out.push(i);
  return out;
}

/** 扁平行下标 → 该行是第几条问题（-1 = 组头）；渲染时给每行贴号 */
export function problemOrdinalMap(rows: readonly ProblemRow[]): Int32Array {
  const out = new Int32Array(rows.length).fill(-1);
  let ordinal = 0;
  for (let i = 0; i < rows.length; i += 1) if (rows[i]!.kind === 'item') out[i] = ordinal++;
  return out;
}
