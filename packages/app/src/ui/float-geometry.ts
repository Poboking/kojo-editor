import { MIN_FLOAT } from './layout';

/**
 * 浮窗几何（2026-10-14 UI 浮动批 · 性能/四角缩放修复）：零 React 纯函数，可单测。
 *
 * 拖拽 / 缩放的**全部数学**住在这里——把方向向量、增量换算、钳制从 JSX 里搬出来，
 * 好让「四角都能缩放」「不越出视口到不可见」这两件事有唯一来源、有尺子。
 * 帝层（`ShellLayout`）只负责把指针位移喂进来、把结果写进样式。
 *
 * 与 `layout.ts` 的分工：`layout.ts` 管几何的**持久化与 reducer 维度**（FloatingState）；
 * 本模块管拖拽期**每帧的连续换算**。两者共同的下界是 `MIN_FLOAT`。
 */

/** 视口尺寸（px；宿主从 `window` 取，测试直接喂常量） */
export interface Viewport {
  w: number;
  h: number;
}

/** 几何（与 `layout.ts` 的 `FloatingState` 同形——用结构子集避免循环依赖） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 八个缩放把手：四角（nw/ne/sw/se）+ 四边（n/e/s/w） */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 把手顺序（渲染遍历用；先四角后四边） */
export const RESIZE_HANDLES = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
] as const satisfies readonly ResizeHandle[];

/**
 * 把手方向向量：x/y 各取 -1（上 / 左）、0（该轴不动）、+1（下 / 右）。
 * 即「拖此把手时，指针沿该方向移动会放大浮窗」；前缘把手（-1）同时移动 x/y。
 */
const HANDLE_VECTOR = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
} as const satisfies Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }>;

/** 把手的方向向量（供光标/边框等 UI 消费，避免各处硬编码方向语义） */
export function handleVector(h: ResizeHandle): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  return HANDLE_VECTOR[h];
}

/**
 * 拖拽可见性口径（沿用修复前既有常量）：浮窗横向至少留 80px、纵向至少留 32px
 * （32 ≈ 标题栏高度）在视口内，保证「永远不会被拖到完全点不到」。
 */
export const DRAG_KEEP = { x: 80, y: 32 } as const;

/**
 * 拖拽位移 → 新位置。
 *
 * 与 `resize` 共用「钳到视口内」的精神，但拖拽只挪位置、不改尺寸，故只钳 x/y：
 * x ∈ [DRAG_KEEP.x - w, vw - DRAG_KEEP.x]，y ∈ [0, vh - DRAG_KEEP.y]。
 */
export function dragRect(base: Rect, dx: number, dy: number, viewport: Viewport): { x: number; y: number } {
  const x = Math.min(viewport.w - DRAG_KEEP.x, Math.max(DRAG_KEEP.x - base.w, base.x + dx));
  const y = Math.min(viewport.h - DRAG_KEEP.y, Math.max(0, base.y + dy));
  return { x, y };
}

/**
 * 单轴缩放：`dir` = -1 表示前缘（左/上）随指针、后缘钉住；+1 表示后缘（右/下）随指针、
 * 前缘钉住；0 表示该轴不变。返回 `[start, size]`。
 *
 * 钳制两条：① size 不小于 `min`（后缘钳制下界、前缘钳制上界）；② 指针所及的边不越出
 * 视口 `[0, max]`——「不越出到不可见」。当两者冲突（视口太小时）以 `min` 为先。
 */
function resizeAxis(start: number, size: number, delta: number, dir: -1 | 0 | 1, min: number, max: number): [number, number] {
  if (dir === 0) return [start, size];
  const end = start + size; // 钉住的那条边
  if (dir < 0) {
    // 前缘移动：先按 min 收口（不能越过 end-min），再收回视口内
    let s = Math.min(start + delta, end - min);
    s = Math.max(s, 0);
    if (end - s < min) s = end - min; // 视口太小 → min 优先
    return [s, end - s];
  }
  // 后缘移动：先收回视口（不超 max），再保证不小于 start+min
  let e = Math.min(end + delta, max);
  e = Math.max(e, start + min);
  if (e - start < min) e = start + min;
  return [start, e - start];
}

/**
 * 缩放位移 → 新几何（x/y/w/h 一起变）。前后缘共用同一套钳制：下界 `MIN_FLOAT`、
 * 上界视口；四角会同时动一个 x 轴与一个 y 轴把手。
 */
export function resizeRect(base: Rect, handle: ResizeHandle, dx: number, dy: number, viewport: Viewport): Rect {
  const v = HANDLE_VECTOR[handle];
  const [x, w] = resizeAxis(base.x, base.w, dx, v.x, MIN_FLOAT.w, viewport.w);
  const [y, h] = resizeAxis(base.y, base.h, dy, v.y, MIN_FLOAT.h, viewport.h);
  return { x, y, w, h };
}

/**
 * 键盘缩放步长（px）：把手获焦后按方向键每次移动的像素。
 * 与拖拽同一套 `resizeRect`——键盘与指针走同一条几何，不另开口径。
 */
export const KEY_RESIZE_STEP = 8;

/**
 * 方向键增量（px）：换算成拖拽语义的 `dx/dy`——让「→ 放大 / ← 缩小」这类直觉成立，
 * 即把按键方向映射成本把手方向向量的正方向。返回 null 表示该键与此把手无关。
 */
export function keyResizeDelta(handle: ResizeHandle, key: string): { dx: number; dy: number } | null {
  switch (key) {
    case 'ArrowRight':
      return { dx: (HANDLE_VECTOR[handle].x || 1) * KEY_RESIZE_STEP, dy: 0 };
    case 'ArrowLeft':
      return { dx: -(HANDLE_VECTOR[handle].x || 1) * KEY_RESIZE_STEP, dy: 0 };
    case 'ArrowDown':
      return { dx: 0, dy: (HANDLE_VECTOR[handle].y || 1) * KEY_RESIZE_STEP };
    case 'ArrowUp':
      return { dx: 0, dy: -(HANDLE_VECTOR[handle].y || 1) * KEY_RESIZE_STEP };
    default:
      return null;
  }
}
