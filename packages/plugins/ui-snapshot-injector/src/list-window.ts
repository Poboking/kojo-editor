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
 * 几何量不到时（SSR / 首帧 / 没有 ResizeObserver 的环境 / 容器根本没滚动）
 * `useRowWindow` 返回 `window: null` ⇒ 调用方**沿用追加式窗口 + 「显示更多」哨兵**，
 * 也就是改动前的行为，一行不少、一行不多。窗口一旦量到就切回收路径，
 * 此时全部行都靠滚动到达（哨兵消失，因为不再需要"追加"才能看全）。
 *
 * ## 键盘可达
 *
 * 窗口外的行不在 DOM 里 ⇒ Tab 够不着。于是容器接 ↑↓ 漫游：窗口内直接落焦，
 * 越界先把目标行滚进视野、记一笔账，等窗口重排后落焦（绝不聚焦不存在的节点）。
 * 口径与条件矩阵的网格导航同一条。
 */

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  createSizeWatcher,
  getFrameScheduler,
  isFramePending,
  type FrameHandle,
  type ListHost,
  type ListKeyEvent,
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

/* ------------------------------ 窗口钩子 ------------------------------ */

export interface RowWindowApi {
  /** 挂到列表容器上的 ref 回调 */
  setHost(node: unknown): void;
  /** 挂到列表容器上的滚动处理（按帧合并） */
  onScroll(): void;
  /** 挂到列表容器上的键盘处理（↑↓ 漫游 + 越界先滚再落焦） */
  onKeyDown(e: ListKeyEvent): void;
  /**
   * 当前视口窗口；`null` = 几何还没量到（或短到不必回收）⇒
   * 调用方走「追加式窗口 + 显示更多」回落路径。
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
 *
 * 回调一律**每次渲染现建**（不用 `useCallback`）：这些函数只挂在自己那层容器上，
 * 容器重渲时本来就要换处理器，包一层 memo 反而把 `rowClass` 之类派生值拖进依赖表。
 */
export function useRowWindow(
  total: number,
  rowClass: string,
  resetKey: unknown,
  focusInside = '',
): RowWindowApi {
  const hostRef = useRef<ListHost | null>(null);
  const frameRef = useRef<FrameHandle>(null);
  const scrollFrameRef = useRef<FrameHandle>(null);
  const scrollTopRef = useRef(0);
  const unmountedRef = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowH, setRowH] = useState<number | null>(null);
  /** 跨窗键盘导航的账：目标行滚进视野、窗口重排后才落焦 */
  const pendingRow = useRef<number | null>(null);
  const [focusPending, setFocusPending] = useState(false);

  /** 一行的选择器：量高用"任意一行"，落焦用"第 N 行里真正可聚焦的那个" */
  const anyRow = `${rowClass}[data-row]`;
  const focusableRow = (index: number): string => `${rowClass}[data-row="${index}"]${focusInside}`;

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

  /** 滚动按帧合并：一帧多次 scroll 事件只重算一次窗口 */
  const onScroll = (): void => {
    const host = hostRef.current;
    if (!host) return;
    scrollTopRef.current = host.scrollTop;
    if (isFramePending(scrollFrameRef.current)) return;
    const frame = getFrameScheduler();
    scrollFrameRef.current = frame.request(() => {
      scrollFrameRef.current = null;
      if (unmountedRef.current) return;
      const next = scrollTopRef.current;
      setScrollTop((prev) => (prev === next ? prev : next));
      readGeometry();
    });
  };

  // ↑↓ 漫游：窗口内直接落焦；越界先把目标行顶进视野，记账等窗口重排
  const onKeyDown = (e: ListKeyEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const host = hostRef.current;
    if (!host || rowH === null) return;
    const t = e.target as { getAttribute?: (n: string) => string | null; closest?: (s: string) => unknown } | null;
    if (!t) return;
    // 焦点可能落在行内的按钮 / 输入上：向上找带 data-row 的行壳
    const holder = (typeof t.closest === 'function' ? t.closest(anyRow) : null) ?? t;
    const get = (holder as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (!get) return;
    const cur = Number(get.call(holder, 'data-row'));
    if (!Number.isFinite(cur)) return;
    const next = cur + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= total) return;
    const target = host.querySelector(focusableRow(next));
    if (target) {
      e.preventDefault();
      target.focus();
      return;
    }
    // 目标行在窗口外：滚进来再落焦（两步，绝不聚焦不存在的节点）
    e.preventDefault();
    const step = rowH ?? 0;
    host.scrollTop = rowScrollTop(step, next);
    scrollTopRef.current = host.scrollTop;
    setScrollTop(host.scrollTop);
    pendingRow.current = next;
    setFocusPending(true);
  };

  // 数据集换了：回顶部、清账、重量（`total` 进依赖 = 过滤后行数变化也要重新判回收）
  useEffect(() => {
    unmountedRef.current = false;
    const host = hostRef.current;
    if (host && host.scrollTop !== 0) host.scrollTop = 0;
    scrollTopRef.current = 0;
    setScrollTop(0);
    pendingRow.current = null;
    setFocusPending(false);
    scheduleGeometry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, total, rowClass]);

  // 尺寸观察：容器改尺寸（面板分栏拖动）与行高变化（字号 / 缩放偏好）都重量一次
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    const watcher = createSizeWatcher(() => {
      if (!cancelled) scheduleGeometry();
    });
    if (watcher && host) {
      watcher.observe(host);
      const firstRow = host.querySelector(anyRow);
      if (firstRow) watcher.observe(firstRow);
    }
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

  // 账上那行渲染出来了就落焦（没渲染出来就一直挂着，绝不聚焦不存在的节点）
  useEffect(() => {
    if (!focusPending) return;
    const want = pendingRow.current;
    if (want === null) {
      setFocusPending(false);
      return;
    }
    const cell = hostRef.current?.querySelector(focusableRow(want));
    if (!cell) return;
    cell.focus();
    pendingRow.current = null;
    setFocusPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPending, scrollTop, viewportH, rowH, rowClass, focusInside]);

  const setHost = (node: unknown): void => {
    hostRef.current = (node as ListHost | null) ?? null;
  };

  // 只有"确实超过一屏"才回收；否则维持追加式路径（短列表不必多一层占位与测量）
  const win = shouldRecycle(total, rowH, viewportH)
    ? computeListWindow(scrollTop, viewportH, rowH as number, total)
    : null;
  return { setHost, onScroll, onKeyDown, win, rowHeight: rowH };
}
