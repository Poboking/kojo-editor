/**
 * 条件矩阵面板用到的**最小 DOM 形状**（从 `index.ts` 原样迁出）。
 *
 * 为什么存在：本包的 typecheck 跑在**无 DOM lib** 的 root 配置下（root `tsc` 与 app
 * 那套都算数），DOM 成员名在那一侧不可见。这里只声明面板真正用到的那几项能力
 * （滚动位置、按选择器找节点、指针捕获、量列宽），不 import DOM 类型，
 * React 合成事件与真 DOM 节点都天然满足这些形状。
 */
/** 分隔线指针事件的最小形状（React 合成事件满足它；插件 tsconfig 无 DOM lib） */
export type SplitterPointer = {
  pointerId: number;
  clientY: number;
  preventDefault(): void;
  currentTarget: { setPointerCapture(pointerId: number): void };
};

/** 首列列宽拖拽指针事件的最小形状（水平方向，读 clientX；事件在 .cm-scroll 上委派 ⇒ 读 target） */
export type ColResizePointer = {
  pointerId: number;
  clientX: number;
  target: { closest?: (selector: string) => unknown } | null;
  preventDefault(): void;
  currentTarget: { setPointerCapture(pointerId: number): void };
};

/** 网格键盘事件的最小形状 */
export type GridKeyEvent = {
  key: string;
  target: unknown;
  preventDefault(): void;
};

/** 元素几何最小形状（量列宽 / 量行高用；插件 tsconfig 无 DOM lib ⇒ 自备） */
export type Rect = { left: number; right: number; width: number; height: number };
/** 首列列宽拖拽：已快照的列宽 + 表宽（`key` = 快照时的 matrixKey，换角色 / 依赖版本即失效） */
export type ColSnap = { key: string; widths: number[]; tableW: number };

/** 滚动容器的最小形状（视口化路径读滚动位置 / 可视高、按属性选择器聚焦格子；
 *  首列列宽拖拽另需量列边界（querySelector / querySelectorAll）） */
export type ScrollBox = {
  scrollTop: number;
  clientHeight: number;
  querySelector(sel: string): {
    focus(): void;
    getBoundingClientRect(): Rect;
    /** C1 反向联动：光标高亮格的最小滚动跟随（真 DOM 必然有；测试替身可不给） */
    scrollIntoView?(arg: { block: string }): void;
  } | null;
  querySelectorAll(sel: string): ArrayLike<{
    getBoundingClientRect(): Rect;
    classList: { add(c: string): void; remove(c: string): void };
  }>;
};

/** 滚动事件的最小形状 */
export type ScrollEvent = {
  currentTarget: { scrollTop: number; clientHeight: number };
};

/* ------------------------------ 尺寸观察 / 逐帧调度（视口化重量） ------------------------------ */

/** 可被观察的节点（本包 typecheck 无 DOM lib ⇒ 只声明"能被观察"这一事实） */
export type Observable = object;

/** ResizeObserver 的最小形状（回调不读 entries——重量走自己的一次读数，够用且不进 DOM 类型） */
export type SizeWatcher = { observe(target: Observable): void; disconnect(): void };

type SizeWatcherCtor = new (callback: () => void) => SizeWatcher;

/**
 * 挂一枚尺寸观察器（视口化路径的重量钩子；PS-7 行高实测的载体）。
 *
 * 环境没有 `ResizeObserver`（SSR / 测试 / 老 WebView）→ 返回 `null`：调用方回落到
 * 「每次渲染 + 每次滚动重量」，尺寸变了仍然跟得上，只是不再由浏览器主动通知——
 * 呈现不降级，只是少了一条免费的路径（内核铁律 4 的不静默针对的是数据可见性）。
 */
export function createSizeWatcher(callback: () => void): SizeWatcher | null {
  const ctor = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  if (typeof ctor !== 'function') return null;
  return new (ctor as SizeWatcherCtor)(() => callback());
}

/** 逐帧调度的句柄（不透明：rAF 给数字、定时器给 Timeout 对象；`null` = 没排上） */
export type FrameHandle = number | { readonly _brand?: never } | null;

/** 逐帧调度器（一帧只干一次活） */
export interface FrameScheduler {
  /** 排一帧，返回句柄（`null` = 环境连定时器都没有） */
  request(callback: () => void): FrameHandle;
  cancel(handle: FrameHandle): void;
}

/**
 * 取当前环境的逐帧调度器：有 `requestAnimationFrame` 用它（与浏览器合成节奏对齐，
 * 滚动事件按帧合并就靠它），否则退到 16ms 定时器（node 测试 / 无 rAF 环境仍可跑）。
 * 每次调用现取全局（不在模块装载时冻结），测试里补上 rAF 也能被看见。
 */
export function getFrameScheduler(): FrameScheduler {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (id: number) => void;
    setTimeout?: (cb: () => void, ms: number) => FrameHandle;
    clearTimeout?: (id: FrameHandle) => void;
  };
  if (typeof g.requestAnimationFrame === 'function') {
    return {
      request: (cb) => g.requestAnimationFrame!(cb),
      cancel: (id) => {
        if (typeof g.cancelAnimationFrame === 'function' && typeof id === 'number') g.cancelAnimationFrame(id);
      },
    };
  }
  return {
    request: (cb) => (typeof g.setTimeout === 'function' ? g.setTimeout!(cb, 16) : null),
    cancel: (id) => {
      if (typeof g.clearTimeout === 'function' && id !== null) g.clearTimeout(id);
    },
  };
}

/** 句柄是否已排上一帧（`null` 与 rAF 可能返回的 0 都算"没排上"） */
export const isFramePending = (handle: FrameHandle): boolean => handle !== null && handle !== 0;
