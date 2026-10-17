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

/** 元素几何最小形状（量列宽用；插件 tsconfig 无 DOM lib ⇒ 自备） */
export type Rect = { left: number; right: number; width: number };
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
