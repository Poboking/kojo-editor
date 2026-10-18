/**
 * 注入面板用到的**最小 DOM 形状**与两个环境桥（本包 typecheck 跑在无 DOM lib 的
 * root 配置下，DOM 成员名在那一侧不可见；照 `ui-condition-matrix` 的同一口径自备）。
 *
 * 只声明面板真正用到的能力（滚动位置 / 按选择器找行 / 量高 / 落焦），不 import DOM 类型：
 * React 合成事件与真 DOM 节点都天然满足这些形状，SSR 与 node 测试里也拿得到同样的判据。
 */

/** 列表容器（自带滚动条的那一层）的最小形状 */
export type ListHost = {
  scrollTop: number;
  clientHeight: number;
  querySelector(sel: string): ListRow | null;
};

/**
 * 列表里的一行（量高 / 落焦 / 判可达 / 存光标选区）。
 *
 * 除量高与落焦外，还要读得到**禁用态**（回收行的键盘漫游必须跳过禁用行）与
 * 文本选区（行被摘掉前把光标位置带走）——真 DOM 的 `HTMLButtonElement` /
 * `HTMLInputElement` 天然满足，测试替身按用到的项给。
 */
export type ListRow = {
  getBoundingClientRect(): { height: number; top: number };
  focus(): void;
  /** 原生 `disabled` 属性（React 的 `disabled={true}` 会同时落到属性与 DOM 成员上） */
  disabled?: boolean;
  getAttribute?(name: string): string | null;
  /** 文本类行内元素的光标锚点（按钮没有 ⇒ `undefined`） */
  selectionStart?: number | null;
  selectionEnd?: number | null;
  setSelectionRange?(start: number, end: number): void;
};

/** 列表容器的键盘事件最小形状（React 合成键盘事件满足） */
export type ListKeyEvent = {
  key: string;
  target: unknown;
  preventDefault(): void;
};

/** 列表容器的焦点事件最小形状（React 的 `onFocus` 由原生 `focusin` 委托 ⇒ 行内元素落焦也会冒泡） */
export type ListFocusEvent = {
  target: unknown;
};

/** 列表容器的失焦事件最小形状（React 的 `onBlur` 由原生 `focusout` 委托；行被摘掉时 relatedTarget 为 null） */
export type ListFocusOutEvent = {
  target: unknown;
  relatedTarget?: unknown;
};

/** 可被尺寸观察器观察的节点（本包无 DOM lib ⇒ 只声明"能被观察"这一事实） */
export type Observable = object;

/** ResizeObserver 的最小形状（回调不读 entries：重量走自己的一次读数） */
export type SizeWatcher = { observe(target: Observable): void; disconnect(): void };

type SizeWatcherCtor = new (callback: () => void) => SizeWatcher;

/**
 * 挂一枚尺寸观察器（容器改尺寸 / 行高变化 → 重量一次）。
 * 环境没有 `ResizeObserver`（SSR / 测试 / 老 WebView）→ `null`：调用方回落到
 * 「每次渲染 + 每次滚动重量」，几何变了仍跟得上，只是少了一条免费路径。
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
  request(callback: () => void): FrameHandle;
  cancel(handle: FrameHandle): void;
}

/** 取当前环境的逐帧调度器：有 rAF 用它，否则退到 16ms 定时器（node 测试仍可跑） */
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
