/**
 * 列表的**视口窗口**（回收行；PS-7）。
 *
 * ## 为什么要有这一层
 *
 * 变量目录与数组单元清单原本是「追加式」窗口：初始 80 / 60 行，触底或点「显示更多」
 * 每次再加 160 / 120 行，**已经画出去的节点永不回收**——点四下就是一千行 DOM，
 * 滚动条越长越卡（浏览器要为整棵子树保持布局与失效面）。
 * VSCode 那侧的对照物是 workbench 的虚拟列表：只渲染视口 ± 缓冲，行渲染器复用、
 * 量出来的行高进缓存。本模块把同一件事在一层里做掉，且**每块面板自带一份**
 * （插件之间不许交叉 import，契约层没有这把尺，也不为它新开包）。
 *
 * ## 回落口径（不许静默降级）
 *
 * 两种回落，都不是静默的：
 * - **开关回落**：回收是宿主下传的容器偏好（`uiPrefs.panelVirtualize`，缺省关）。
 *   没开 ⇒ 沿用追加式窗口 + 「显示更多」哨兵 = 改动前行为，逐字不变；
 * - **几何回落**：量不到几何（SSR / 首帧 / 没有 ResizeObserver 的环境 / 容器没滚动）
 *   ⇒ `useRowWindow` 返回 `window: null` ⇒ 同样走追加式路径。
 * 窗口一旦启用，全部行都靠滚动到达（哨兵消失，因为不再需要"追加"才能看全）。
 *
 * ## 键盘可达（回收行的**硬约束**：窗口化不许改变"哪些行能被键盘点到"）
 *
 * 窗口外的行不在 DOM 里 ⇒ Tab 够不着 ⇒ ↑↓ 是跨窗的唯一通道，它必须做到：
 * 1. **只把焦点交给真能接受焦点的行**——`disabled` 的行（变量目录里的 `other` 行）
 *    跳过，绝不"落焦一个禁用按钮"然后原地不动；
 * 2. 目标行在窗口外 ⇒ 先滚进视野、记一笔账，等窗口重排后落焦（禁用判定推迟到行
 *    真的渲染出来之后，因此账上那一行如果是禁用的就继续往前找）；
 * 3. 那个方向**没有任何可达行** ⇒ 原样交给浏览器（不 `preventDefault`），
 *    焦点留在原处，不做"按了键却没动"的假动作；
 * 4. ↑↓ = 列表漫游（本层接管）；Tab / Shift+Tab = 浏览器原生焦点顺序，只在已渲染
 *    行间移动，本层不碰；←→ = 留给输入框光标。
 *
 * 口径与条件矩阵的网格导航同一条。
 *
 * ## 正在输入的行不许被摘（IME）
 *
 * 面板是**数据录入面**：单元格里打的是日文，输入法有一串尚未上屏的合成文字。
 * 合成期间窗口一缩，`<input>` 被卸载 ⇒ 合成串被静默丢弃，这是不可恢复的数据丢失
 * （草稿只有上屏后的值）。三层处理，对齐 VSCode 的 `WorkbenchList`：它复用 DOM 但
 * 只维持一个托管焦点，且**正在编辑的那一行不会从编辑器底下被回收掉**。
 * - **合成冻结**（`compositionstart` → `compositionend`）：这期间不按滚动重算窗口，
 *   正在输入的行必然留在 DOM 里 ⇒ 合成串必然活到上屏；代价只是"少回收一窗"，
 *   合成结束一次性补算滚动位置；
 * - **焦点行钉窗**（`anchorWindowToRow`）：没在合成但焦点在某行里时，扩窗把这一行
 *   留在窗口内，扩窗代价有上限（`PIN_MAX_EXTRA_ROWS`），不为了钉一行就把窗口撑爆；
 * - **摘前记账 + 回窗落焦**（`captureCellCaret`）：真要摘掉焦点行时，先带走该行
 *   输入框的光标选区，等它重新进窗就把焦点与选区放回去。
 * 三层都只管"焦点行"这一行，所以行数上界仍是视口 ± 缓冲 + 常数。
 */

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  createSizeWatcher,
  getFrameScheduler,
  isFramePending,
  type FrameHandle,
  type ListFocusEvent,
  type ListFocusOutEvent,
  type ListHost,
  type ListKeyEvent,
  type ListRow,
  type Observable,
} from './dom-lite';

/* ------------------------------ 窗口数学（纯函数） ------------------------------ */

/** 行高合法域（px）：低于下限 = 还没布局出来，高于上限 = 量到的不是一行 */
export const LIST_ROW_H_MIN = 8;
export const LIST_ROW_H_MAX = 200;

/** 视口上下各留的缓冲行数（滚出即撤、滚入即建） */
export const LIST_OVERSCAN = 6;

/** 视口窗口：渲染区间 + 上下占位高（撑出与全量渲染一致的滚动条） */
export interface ListWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
}

/** 实测行高收敛：没量到 / 量坏了 → null（调用方走回落路径，不猜一个数） */
export function resolveMeasuredRowHeight(measured: number | null | undefined): number | null {
  if (measured === null || measured === undefined) return null;
  if (!Number.isFinite(measured) || measured < LIST_ROW_H_MIN) return null;
  return Math.min(LIST_ROW_H_MAX, measured);
}

/** 行高是否变了（0.5px 阈值：亚像素抖动不惊动整表重渲） */
export function rowHeightChanged(prev: number | null, next: number, threshold = 0.5): boolean {
  if (prev === null) return true;
  return Math.abs(prev - next) > threshold;
}

/**
 * 由滚动位置算视口窗口（纯函数，单测钉住）。
 *
 * 两端钳制：`start ∈ [0, total]`、`end ∈ [start, total]`；滚到顶 `topPad = 0`、
 * 滚到底 `bottomPad = 0`；总数 / 行高非法 → 空窗口。占位按行高等比还原，
 * 于是滚动条长度与「全量渲染」逐字一致（用户的滚动位置不该因为换实现而跳）。
 */
export function computeListWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  totalRows: number,
  overscan: number = LIST_OVERSCAN,
): ListWindow {
  if (!(totalRows > 0) || !(rowHeight > 0)) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const scroll = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const view = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  const over = Number.isFinite(overscan) && overscan > 0 ? Math.floor(overscan) : 0;
  const firstVisible = Math.floor(scroll / rowHeight);
  const visibleCount = Math.ceil(view / rowHeight);
  let start = firstVisible - over;
  let end = firstVisible + visibleCount + over;
  if (start < 0) start = 0;
  if (start > totalRows) start = totalRows;
  if (end > totalRows) end = totalRows;
  if (end < start) end = start;
  return { start, end, topPad: start * rowHeight, bottomPad: (totalRows - end) * rowHeight };
}

/** 滚动位置落在哪一行（实测行高下的"顶行"判据；键盘导航与测试都按它对表） */
export function firstVisibleRowIndex(scrollTop: number, rowHeight: number): number {
  if (!(rowHeight > 0)) return 0;
  const scroll = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  return Math.floor(scroll / rowHeight);
}

/** 把第 `index` 行顶到视口上沿需要的 scrollTop（键盘跨窗跳转与窗口同一把尺） */
export function rowScrollTop(rowHeight: number, index: number): number {
  return index * rowHeight;
}

/** 回收生效的最小倍数：行数不足一屏的 1.5 倍就不必回收（省一层占位与测量） */
export const RECYCLE_MIN_SCREENS = 1.5;

/** 该不该走回收路径（纯函数，单测钉住）：几何量到了、而且确实超过一屏 */
export function shouldRecycle(total: number, rowHeight: number | null, viewportH: number): boolean {
  if (rowHeight === null || viewportH <= 0 || total <= 0) return false;
  return total * rowHeight > viewportH * RECYCLE_MIN_SCREENS;
}

/** 占位块：一行高的空 div（`aria-hidden`：它不是内容，只是滚动条的替身） */
export const listSpacer = (height: number, key: string): ReactNode =>
  height > 0
    ? createElement('div', {
        key,
        'aria-hidden': 'true',
        className: 'inj-win-spacer',
        style: { height: `${height}px`, flex: 'none' },
      })
    : null;

/* ------------------------------ 键盘可达（纯判据） ------------------------------ */

/**
 * 一行在"能不能被键盘落到"这件事上的三态。
 *
 * - `focusable`：节点在 DOM 里，而且真的能接受焦点；
 * - `blocked`：节点在 DOM 里，但被禁用（变量目录里 `kind === 'other'` 的行）⇒ **跳过它继续找**；
 * - `unrendered`：节点不在 DOM 里（窗口外）⇒ 禁用与否还不知道，得先把它滚进来。
 */
export type RowReach = 'focusable' | 'blocked' | 'unrendered';

/** 逐行可达性探针（钩子按选择器问真 DOM；测试按同一签名喂假表） */
export type RowProbe = (row: number) => RowReach;

/** 导航结论：`focus` = 立刻落焦；`scroll` = 先把该行滚进窗口，渲染出来后重试 */
export interface RowNav {
  readonly kind: 'focus' | 'scroll';
  readonly row: number;
}

/**
 * 从 `from` 行朝 `dir` 方向找**下一个真能落焦的行**（纯函数，单测钉住）。
 *
 * 关键在 `blocked` 那一支：回收批最早的实现是"目标行的选择器查到节点就
 * `preventDefault()` + `focus()`"，而禁用按钮拿不到焦点 ⇒ 焦点原地不动 ⇒
 * 再按一次还是同一行 ⇒ **一个禁用行就把它下面的整段列表变成键盘死角**
 * （窗口化后 Tab 也够不着窗口外的行）。这里改成逐行探到能落焦为止。
 *
 * 走到数据边界仍没有可达行 ⇒ 返回 `null`：调用方**不许** `preventDefault`，
 * 让按键回到浏览器默认行为，绝不制造"按了键却没反应"的假动作。
 */
export function planRowReach(
  from: number,
  dir: 1 | -1,
  total: number,
  probe: RowProbe,
): RowNav | null {
  if (!Number.isInteger(from) || !(total > 0)) return null;
  if (dir !== 1 && dir !== -1) return null;
  let row = from + dir;
  while (row >= 0 && row < total) {
    const reach = probe(row);
    if (reach === 'focusable') return { kind: 'focus', row };
    if (reach === 'unrendered') return { kind: 'scroll', row };
    row += dir; // 'blocked'：禁用行，跳过继续找
  }
  return null;
}

/** 节点是否真能接受焦点（禁用 / `aria-disabled` / `tabindex="-1"` 都不算能） */
export function isNodeFocusable(node: ListRow | null | undefined): boolean {
  if (!node) return false;
  if (node.disabled === true) return false;
  const attr = node.getAttribute?.('disabled');
  if (attr !== undefined && attr !== null) return false;
  if (node.getAttribute?.('aria-disabled') === 'true') return false;
  if (node.getAttribute?.('tabindex') === '-1') return false;
  return true;
}

/** `data-row` 的**显式**解析：拿不到 / 非自然数一律 `null`（旧实现 `Number(null) === 0` ⇒ 哨兵上按 ↓ 会跳到第 1 行） */
export function parseRowIndex(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '' || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** 事件携带体上最小的"能问出 data-row"的形状（真 DOM 节点 / React 合成事件的 target 都满足） */
type RowCarrier = {
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
};

/**
 * 从按键 / 落焦事件的 target 问出它所在的行号（`rowSelector` = "任意一行"的选择器）。
 *
 * 问不到就返回 `null`（焦点在「显示更多」哨兵、下拉、面板空白处都属这一类），
 * 调用方据此**完全不接管这次按键**——这正是旧实现读成 0 的那一处。
 */
export function readRowIndexFromTarget(target: unknown, rowSelector: string): number | null {
  if (!target || typeof target !== 'object') return null;
  const t = target as RowCarrier;
  const found = typeof t.closest === 'function' ? t.closest(rowSelector) : null;
  const node = (found ?? target) as RowCarrier;
  if (typeof node.getAttribute !== 'function') return null;
  return parseRowIndex(node.getAttribute('data-row'));
}

/* ------------------------------ 焦点行留在窗口内 ------------------------------ */

/** 钉住焦点行的**最大扩窗代价**（行）：超过这个代价就不硬留，改记"回窗再落焦"的账 */
export const PIN_MAX_EXTRA_ROWS = 12;

/** 钉窗结果：`pinned = false` 表示焦点行不在这次渲染的窗口里 ⇒ 它会被摘掉 */
export interface FocusAnchor {
  readonly win: ListWindow;
  readonly pinned: boolean;
}

/** 窗口是否覆盖第 `row` 行（空窗口不算覆盖） */
export function windowHoldsRow(win: ListWindow | null, row: number | null): boolean {
  if (!win || row === null) return false;
  return row >= win.start && row < win.end && win.end > win.start;
}

/**
 * 把焦点行**留在窗口内**（纯函数，单测钉住）：只在扩窗代价不超过
 * `PIN_MAX_EXTRA_ROWS` 时扩，扩完仍按同一把实测行高摆占位 ⇒ 滚动条不许因为
 * 钉了一行就跳。代价超限就原样返回并如实报告 `pinned: false`。
 *
 * 这是 VSCode `WorkbenchList` 那条"正在编辑的行不从编辑器底下被回收走"的
 * 有界版本：它靠渲染器的 sticky 元素，这里靠窗口区间多含一行，都是**至多多一行**
 * 的恒定代价，不会把窗口撑成视口到焦点行的整段。
 */
export function anchorWindowToRow(
  win: ListWindow,
  row: number | null,
  rowHeight: number,
  total: number,
): FocusAnchor {
  if (row === null || row < 0 || row >= total || !(rowHeight > 0)) return { win, pinned: win.end > win.start };
  if (windowHoldsRow(win, row)) return { win, pinned: true };
  const extra = row < win.start ? win.start - row : row - win.end + 1;
  if (extra > PIN_MAX_EXTRA_ROWS) return { win, pinned: false };
  const start = Math.min(win.start, row);
  const end = Math.max(win.end, row + 1);
  return { win: { start, end, topPad: start * rowHeight, bottomPad: (total - end) * rowHeight }, pinned: true };
}

/** 摘走焦点行之前带走的**行内光标选区**（合成中的文本无法程序化重建，选区可以） */
export interface CellCaret {
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

/** 读一行里可聚焦元素的光标选区（按钮这类没有选区的元素 → null） */
export function captureCellCaret(node: ListRow | null | undefined, row: number): CellCaret | null {
  if (!node) return null;
  const start = node.selectionStart;
  const end = node.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { row, start: Math.min(start, end), end: Math.max(start, end) };
}

/** 回窗后把焦点与选区放回该行（放得了返回 true；没有选区 API 的元素只落焦） */
export function applyCellCaret(node: ListRow | null | undefined, caret: CellCaret | null): boolean {
  if (!node) return false;
  node.focus();
  if (caret && typeof node.setSelectionRange === 'function') {
    try {
      node.setSelectionRange(caret.start, caret.end);
    } catch {
      /* 元素不接受选区（类型不符）：焦点已落，选区放弃——不影响"行可达"这条判据 */
    }
  }
  return true;
}

/* ------------------------------ 跨窗导航的挂账 ------------------------------ */

/** 同一个目标行连续滚不动的次数上限（防止底部钳制后无限挂账） */
export const PENDING_MAX_STALLS = 3;

/** 一笔跨窗落焦的账：从哪一行出发、朝哪个方向、上次滚到哪、停滞几次 */
export interface PendingFocus {
  readonly from: number;
  readonly dir: 1 | -1;
  readonly at: number;
  readonly stalls: number;
}

/**
 * 挂账推进（纯函数，单测钉住）：窗口重排后重试同一个方向的查找。
 *
 * - 找到能落焦的行 ⇒ `focus`，账清；
 * - 还要滚 ⇒ `scroll`，账带着新的滚动位置续着；连续 `PENDING_MAX_STALLS` 次
 *   滚动位置没动（到底 / 到顶被钳制、而目标行仍不在窗口里）⇒ `giveup`，
 *   不再空转，也绝不把焦点留在 `document.body`；
 * - 该方向没有可达行 ⇒ `giveup`（焦点回到起跳行，如果它还在窗口里）。
 */
export function advancePendingFocus(
  led: PendingFocus,
  scrollTop: number,
  nav: RowNav | null,
): { readonly action: 'focus' | 'scroll' | 'giveup'; readonly row: number; readonly next: PendingFocus | null } {
  const moved = Math.abs(scrollTop - led.at) >= 1;
  const stalls = moved ? 0 : led.stalls + 1;
  if (nav?.kind === 'focus') return { action: 'focus', row: nav.row, next: null };
  if (nav?.kind === 'scroll') {
    if (!moved && stalls >= PENDING_MAX_STALLS) return { action: 'giveup', row: led.from, next: null };
    return { action: 'scroll', row: nav.row, next: { from: led.from, dir: led.dir, at: scrollTop, stalls } };
  }
  return { action: 'giveup', row: led.from, next: null };
}

/* ------------------------------ 窗口钩子 ------------------------------ */

export interface RowWindowApi {
  /** 挂到列表容器上的 ref 回调 */
  setHost(node: unknown): void;
  /** 挂到列表容器上的滚动处理（按帧合并；输入法合成中冻结） */
  onScroll(): void;
  /** 挂到容器上的键盘处理：↑↓ 漫游（跳过禁用行；无可达行就不接管） */
  onKeyDown(e: ListKeyEvent): void;
  /** 挂到容器上的 `onFocus`（React 由原生 focusin 委托 ⇒ 行内元素落焦也会到这儿） */
  onFocusIn(e: ListFocusEvent): void;
  /** 挂到容器上的 `onBlur`：用户把焦点挪走就清"回焦"的账；`relatedTarget` 为空视为行被摘掉 */
  onFocusOut(e: ListFocusOutEvent): void;
  /** 挂到容器上的 `onCompositionStart`：输入法合成期间冻结窗口（正在输入的行绝不被摘） */
  onCompositionStart(): void;
  /** 挂到容器上的 `onCompositionEnd`：解冻，把冻结期间攒下的滚动位置一次性补算 */
  onCompositionEnd(): void;
  /**
   * 当前视口窗口；`null` = **回落路径**（追加式窗口 + 显示更多哨兵）：
   * 回收开关没开、几何还没量到，或短到不必回收。
   */
  win: ListWindow | null;
  /** 量到的真实行高（null = 未量到） */
  rowHeight: number | null;
}

/**
 * 一列的视口窗口钩子（容器自带滚动条的那种：`.inj-vars` / `.inj-cells`）。
 *
 * @param total       当前总行数（过滤后）
 * @param rowClass    行选择器（量首行与落焦都用它，如 `.inj-var-row`）
 * @param resetKey    数据集标识（换档 / 换作用域 / 换变量）：变了就回顶部并重新重量
 * @param focusInside 行内才是可聚焦元素时的后缀（单元行的输入框；留空 = 行壳自己可聚焦）
 * @param virtualize  是否允许回收行（宿主偏好 `uiPrefs.panelVirtualize`；**缺省关** =
 *                    改动前的追加式路径。本面板是数据录入面，窗口化会改键盘语义，
 *                    按契约「缺省 = 最保守值」必须由用户显式开起来）
 *
 * 回调一律**每次渲染现建**（不用 `useCallback`）：这些函数只挂在自己那层容器上，
 * 容器重渲时本来就要换处理器，包一层 memo 反而把 `rowClass` 之类派生值拖进依赖表。
 */
export function useRowWindow(
  total: number,
  rowClass: string,
  resetKey: unknown,
  focusInside = '',
  virtualize = false,
): RowWindowApi {
  const hostRef = useRef<ListHost | null>(null);
  const frameRef = useRef<FrameHandle>(null);
  const scrollFrameRef = useRef<FrameHandle>(null);
  const scrollTopRef = useRef(0);
  const unmountedRef = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowH, setRowH] = useState<number | null>(null);
  /** 最近一次落在本列表里的行（行被摘掉后仍保留：既是钉窗的依据，也是回焦的目标） */
  const [focusRow, setFocusRow] = useState<number | null>(null);
  /** 跨窗键盘导航的账：目标行滚进视野、窗口重排后才落焦 */
  const pendingFocus = useRef<PendingFocus | null>(null);
  const [focusPending, setFocusPending] = useState(false);
  /** 输入法合成中（`compositionstart` ↔ `compositionend`）：这段时间不按滚动重算窗口 */
  const composingRef = useRef(false);
  /**
   * 「焦点行被摘掉」的账（行号 + 摘走前读到的光标选区）：行重新进窗时由 effect 把
   * 焦点放回去。只在 render 里**记**（同一批输入算出同一个值 ⇒ 重复渲染幂等）；
   * 清的地方有三处：回焦成功、用户把焦点挪到别处（`onFocusOut` 带 relatedTarget）、换数据集。
   */
  const rescueRef = useRef<{ row: number; caret: CellCaret | null } | null>(null);
  /** 本次渲染的窗口（含钉窗）镜像：`onKeyDown` 要先于它的定义拿到"这次到底有没有回收" */
  const winRef = useRef<ListWindow | null>(null);

  /** 一行的选择器：量高用"任意一行"，落焦用"第 N 行里真正可聚焦的那个" */
  const anyRow = `${rowClass}[data-row]`;
  const focusableRow = (index: number): string => `${rowClass}[data-row="${index}"]${focusInside}`;

  /** 逐行可达性探针：不在 DOM 里 = 还不知道（先滚进来再说）；在但禁用 = 跳过 */
  const probeRow = (host: ListHost): RowProbe => (row) => {
    const node = host.querySelector(focusableRow(row));
    if (!node) return 'unrendered';
    return isNodeFocusable(node) ? 'focusable' : 'blocked';
  };

  const readGeometry = (): void => {
    const host = hostRef.current;
    if (!host) return;
    const h = host.clientHeight;
    setViewportH((prev) => (prev === h ? prev : h));
    const row = host.querySelector(anyRow);
    if (!row) return;
    const rh = resolveMeasuredRowHeight(row.getBoundingClientRect().height);
    if (rh === null) return;
    setRowH((prev) => (rowHeightChanged(prev, rh) ? rh : prev));
  };

  /** 排一帧重量（同帧多次触发只读一次） */
  const scheduleGeometry = (): void => {
    if (isFramePending(frameRef.current)) return;
    const frame = getFrameScheduler();
    frameRef.current = frame.request(() => {
      frameRef.current = null;
      if (!unmountedRef.current) readGeometry();
    });
  };

  /** 发布一个滚动位置（程序化 reveal 用：不等 scroll 事件回流） */
  const publishScrollTop = (host: ListHost): void => {
    scrollTopRef.current = host.scrollTop;
    setScrollTop(host.scrollTop);
  };

  /** 把第 `row` 行顶进视野（跨窗导航与回窗落焦共用同一把尺） */
  const revealRow = (row: number): void => {
    const host = hostRef.current;
    if (!host || rowH === null) return;
    host.scrollTop = rowScrollTop(rowH, row);
    publishScrollTop(host);
  };

  /** 落焦某行的可聚焦元素并放光标（拿不到焦点的节点一律不落，返回 false） */
  const focusRowAt = (host: ListHost, row: number, caret: CellCaret | null): boolean => {
    const node = host.querySelector(focusableRow(row));
    if (!node || !isNodeFocusable(node)) return false;
    return applyCellCaret(node, caret);
  };

  /** 滚动按帧合并：一帧多次 scroll 事件只重算一次窗口；**合成期间冻结**（正在输入的行不许被摘） */
  const onScroll = (): void => {
    const host = hostRef.current;
    if (!host) return;
    scrollTopRef.current = host.scrollTop;
    if (composingRef.current) return;
    if (isFramePending(scrollFrameRef.current)) return;
    const frame = getFrameScheduler();
    scrollFrameRef.current = frame.request(() => {
      scrollFrameRef.current = null;
      if (unmountedRef.current || composingRef.current) return;
      const next = scrollTopRef.current;
      setScrollTop((prev) => (prev === next ? prev : next));
      readGeometry();
    });
  };

  /**
   * ↑↓ 漫游 —— 回收行之后**唯一**能跨窗的键盘通道（Tab 归浏览器原生焦点顺序，
   * 只在已渲染的行之间移动；←→ 留给输入框光标，本层一律不碰）。
   *
   * 四条出口，逐条都不许出现"按了键却没动"：
   * 1. 下一个可达行已在 DOM 里 ⇒ `preventDefault` + 落焦；
   * 2. 目标行还没渲染（或后面才撞上禁用行）⇒ `preventDefault` + 滚进来 + 记账，
   *    账由下面的 effect 在窗口重排后接着走（禁用判定推迟到行真的渲染出来之后）；
   * 3. 那个方向**没有可达行** ⇒ 什么都不做（不 `preventDefault`），按键交回浏览器；
   * 4. 事件根本不在行里（「显示更多」哨兵 / 空白处）⇒ 同上，什么都不做。
   */
  const onKeyDown = (e: ListKeyEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const host = hostRef.current;
    if (!host || rowH === null) return;
    const cur = readRowIndexFromTarget(e.target, anyRow);
    if (cur === null) return;
    const dir: 1 | -1 = e.key === 'ArrowDown' ? 1 : -1;
    const nav = planRowReach(cur, dir, total, probeRow(host));
    if (!nav) return;
    // 回落路径（没开回收 / 几何没量到）：窗口外的行不会靠滚动出现，别接管这一按
    if (winRef.current === null && nav.kind === 'scroll') return;
    e.preventDefault();
    if (nav.kind === 'focus') {
      focusRowAt(host, nav.row, null);
      return;
    }
    pendingFocus.current = { from: cur, dir, at: host.scrollTop, stalls: 0 };
    setFocusPending(true);
    revealRow(nav.row);
  };

  /** 行内任何元素落焦都记下行号（钉窗与回焦只看这一格） */
  const onFocusIn = (e: ListFocusEvent): void => {
    const row = readRowIndexFromTarget(e.target, anyRow);
    if (row === null) return;
    rescueRef.current = null;
    setFocusRow((prev) => (prev === row ? prev : row));
  };

  /** 焦点被用户挪走（relatedTarget 有值且不在本列表里）就别再想着回焦；为 null 视为行被摘掉，账留着 */
  const onFocusOut = (e: ListFocusOutEvent): void => {
    if (e.relatedTarget === null || e.relatedTarget === undefined) return;
    if (readRowIndexFromTarget(e.relatedTarget, anyRow) !== null) return; // 列表内部移动，交给 onFocusIn
    rescueRef.current = null;
    setFocusRow(null);
  };

  const onCompositionStart = (): void => {
    composingRef.current = true;
  };

  const onCompositionEnd = (): void => {
    if (!composingRef.current) return;
    composingRef.current = false;
    const host = hostRef.current;
    if (!host) return;
    // 解冻：把合成期间滚过却没结算的位置一次性补上（窗口该缩就缩，焦点行仍被钉住）
    scrollTopRef.current = host.scrollTop;
    setScrollTop((prev) => (prev === host.scrollTop ? prev : host.scrollTop));
    readGeometry();
  };

  // 数据集换了：回顶部、清账、重量（`total` 进依赖 = 过滤后行数变化也要重新判回收）
  useEffect(() => {
    unmountedRef.current = false;
    const host = hostRef.current;
    if (host && host.scrollTop !== 0) host.scrollTop = 0;
    scrollTopRef.current = 0;
    setScrollTop(0);
    setFocusRow(null);
    setFocusPending(false);
    composingRef.current = false;
    pendingFocus.current = null;
    rescueRef.current = null;
    scheduleGeometry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, total, rowClass]);

  // 只有"确实超过一屏"才回收；否则维持追加式路径（短列表不必多一层占位与测量）
  const rawWin =
    virtualize && rowH !== null && viewportH > 0 && shouldRecycle(total, rowH, viewportH)
      ? computeListWindow(scrollTop, viewportH, rowH, total)
      : null;
  /**
   * 钉窗：焦点行必须留在渲染区间里（扩窗代价有上限，见 `anchorWindowToRow`）。
   * 摘不掉的那一行就是"正在输入的那一行"——钉窗是常规路径，下面那笔 rescue 账是
   * 超限时的兜底（先带走光标选区，等行回窗再放回去）。
   */
  const anchored = rawWin !== null && rowH !== null ? anchorWindowToRow(rawWin, focusRow, rowH, total) : null;
  const win = anchored !== null ? anchored.win : rawWin;
  winRef.current = win;
  if (anchored !== null && !anchored.pinned && focusRow !== null) {
    const leaving = hostRef.current?.querySelector(focusableRow(focusRow)) ?? null;
    if (leaving) rescueRef.current = { row: focusRow, caret: captureCellCaret(leaving, focusRow) };
  }

  // 尺寸观察：容器改尺寸（面板分栏拖动）重量一次——容器不被回收，是这条路径的常驻锚
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    const watcher = createSizeWatcher(() => {
      if (!cancelled) scheduleGeometry();
    });
    if (watcher && host) watcher.observe(host as unknown as Observable);
    scheduleGeometry();
    return () => {
      cancelled = true;
      unmountedRef.current = true;
      watcher?.disconnect();
      const frame = getFrameScheduler();
      if (isFramePending(frameRef.current)) frame.cancel(frameRef.current);
      if (isFramePending(scrollFrameRef.current)) frame.cancel(scrollFrameRef.current);
      frameRef.current = null;
      scrollFrameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, rowClass]);

  /**
   * 行高观察：回收会销毁首帧那一批行节点，老实现只观察"第一次挂上来的首行"，
   * 窗口一挪这条免费路径就断了。这里**每次窗口起点变了就重挂一次**，
   * 观察当下在 DOM 里的首行（字号 / 缩放偏好改行高仍能被量到）。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const watcher = createSizeWatcher(() => scheduleGeometry());
    if (!watcher) return;
    const row = host.querySelector(anyRow);
    if (row) watcher.observe(row as unknown as Observable);
    return () => watcher.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, rowClass, win?.start ?? -1, total]);

  // 账上那一行渲染出来了就接着找能落焦的行（禁用行到这儿才看得见），绝不聚焦不存在的节点
  useEffect(() => {
    if (!focusPending) return;
    const led = pendingFocus.current;
    const host = hostRef.current;
    if (!led || !host) {
      pendingFocus.current = null;
      setFocusPending(false);
      return;
    }
    const step = advancePendingFocus(led, host.scrollTop, planRowReach(led.from, led.dir, total, probeRow(host)));
    if (step.action === 'scroll') {
      pendingFocus.current = step.next;
      revealRow(step.row);
      return;
    }
    pendingFocus.current = null;
    setFocusPending(false);
    // focus：落到找到的那一行；giveup：放回起跳行（还在窗内就放）——都不留焦点在 body
    if (!focusRowAt(host, step.row, null) && step.action === 'focus') revealRow(step.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPending, scrollTop, viewportH, rowH, total, rowClass, focusInside]);

  // 被摘掉的焦点行重新进窗：把焦点与光标选区放回去（合成串救不回来，故有上面的冻结）
  useEffect(() => {
    const want = rescueRef.current;
    if (want === null || win === null || composingRef.current) return;
    if (!windowHoldsRow(win, want.row)) return;
    const host = hostRef.current;
    if (!host) return;
    if (!focusRowAt(host, want.row, want.caret)) return;
    rescueRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, viewportH, rowH, total, focusRow, win?.start ?? -1, win?.end ?? -1]);

  const setHost = (node: unknown): void => {
    hostRef.current = (node as ListHost | null) ?? null;
  };

  return {
    setHost,
    onScroll,
    onKeyDown,
    onFocusIn,
    onFocusOut,
    onCompositionStart,
    onCompositionEnd,
    win,
    rowHeight: rowH,
  };
}
