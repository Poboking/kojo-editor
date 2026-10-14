import { dragRect, resizeRect, type Rect, type ResizeHandle, type Viewport } from './float-geometry';

/**
 * 浮窗拖拽 / 缩放的**帧合并 + 原子交接**（2026-10-14 UI 浮动批 · 拖拽卡顿根治）。
 *
 * ## 为什么会有这个模块
 *
 * 修复前：标题栏 mousedown → 全局 mousemove，**每个 mousemove 直写 `left/top`**。
 * `left/top` 是布局属性——每次写都让整棵浮窗子树（浮窗内可能是几百行的表格/大列表）
 * 重新 layout + paint；加上 mousemove 可能快于帧率（一帧多次写），拖起来就卡。
 *
 * 修复后两条：
 * ① **合成层移动**：拖拽期只写 `transform: translate3d(...)`（合成器属性，零 layout）+
 *    `will-change: transform`；几何换算仍是每 mousemove 一次（纯算），但**写样式合并到 rAF**，
 *    一帧最多落一次、且只落最新值。
 * ② **松手原子交接**：在同一个同步块里写最终 inline `left/top`（= 基准 left/top + 累积
 *    transform 位移）、清掉 transform，再把同一组几何 commit 给 React。React 落地的值与本
 *    模块写的 inline 值**同坐标系、逐字相同** ⇒ 视觉零 delta。**「松手零抖动」是硬不变量，
 *    不可回退**（见下方 finish 注释与 float-geometry.test.ts 的交接断言）。
 *
 * 本模块零 React、零 DOM API 依赖（只要一个"样式面"接口），故可用假元素在 node 环境单测。
 */

/** 一帧调度器：真环境用 rAF，测试注入手动驱动器 */
export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(id: number): void;
}

/** 缺省 rAF 调度器（非浏览器环境回落 setTimeout，仅兜底、测试一律注入假调度器） */
export const RAF_SCHEDULER: FrameScheduler = {
  request(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb());
    return setTimeout(cb, 16) as unknown as number;
  },
  cancel(id) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  },
};

/**
 * 帧合并写：把任意频繁的 `write` 收敛成「每帧最多一次」，且总是写**最新**值。
 * - `write(v)`：记录 v 并安排一帧（已有待写帧则只覆盖值，不重复安排）。
 * - `flush()`：取消待写帧并**同步**落定 v（松手前用——必须与后续 DOM 写在同一个同步块）。
 * - `cancel()`：丢弃待写值（交互被打断时用）。
 */
export interface FrameWriter<T> {
  write(v: T): void;
  flush(): void;
  cancel(): void;
}

export function createFrameWriter<T>(apply: (v: T) => void, sched: FrameScheduler = RAF_SCHEDULER): FrameWriter<T> {
  let pending: T | undefined;
  let has = false;
  let handle = 0;
  const run = (): void => {
    handle = 0;
    if (!has) return;
    const v = pending as T;
    has = false;
    pending = undefined;
    apply(v);
  };
  return {
    write(v) {
      pending = v;
      has = true;
      if (handle === 0) handle = sched.request(run);
    },
    flush() {
      if (handle !== 0) {
        sched.cancel(handle);
        handle = 0;
      }
      if (has) {
        const v = pending as T;
        has = false;
        pending = undefined;
        apply(v);
      }
    },
    cancel() {
      if (handle !== 0) {
        sched.cancel(handle);
        handle = 0;
      }
      has = false;
      pending = undefined;
    },
  };
}

/**
 * 浮窗根元素所需的**最小样式面**：拖拽/缩放期间只碰这些属性。
 * 真 DOM 的 `HTMLElement` 天然满足；单测用假元素只需实现这几个字段 + classList。
 */
export interface FloatElLike {
  style: {
    transform: string;
    left: string;
    top: string;
    width: string;
    height: string;
    willChange: string;
  };
  classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
  };
}

/** 拖拽进行中的抬升态类名（样式表 `.floating-panel--dragging` 读它） */
export const FLOAT_DRAGGING_CLASS = 'floating-panel--dragging';

export interface DragSession {
  /** 每次 pointermove：换算并合并到下一帧；不触发布局、不进 reducer */
  onMove(clientX: number, clientY: number): void;
  /** pointerup：原子交接（落定 inline left/top + 清 transform），返回最终几何；未移动 → null */
  finish(): { x: number; y: number } | null;
}

/**
 * 开一次拖拽会话。`origin` = pointerdown 时的指针坐标，`base` = 浮窗当时的几何。
 *
 * 拖拽期**绝不**改 `left/top`（那是松手才落定的），只写 transform 位移——
 * 故浮窗子树的几何在拖拽全程纹丝不动，没有 layout、没有重绘（合成器搬运）。
 */
export function beginFloatDrag(opts: {
  el: FloatElLike;
  base: Rect;
  origin: { x: number; y: number };
  viewport: () => Viewport;
  scheduler?: FrameScheduler;
}): DragSession {
  const { el, base, origin } = opts;
  let target = { x: base.x, y: base.y };
  const writer = createFrameWriter<{ x: number; y: number }>((p) => {
    el.style.transform = `translate3d(${p.x - base.x}px, ${p.y - base.y}px, 0)`;
  }, opts.scheduler);
  el.style.willChange = 'transform';
  el.classList.add(FLOAT_DRAGGING_CLASS);
  return {
    onMove(cx, cy) {
      target = dragRect(base, cx - origin.x, cy - origin.y, opts.viewport());
      writer.write(target);
    },
    finish() {
      const moved = target.x !== base.x || target.y !== base.y;
      writer.flush(); // 落定最后一帧 transform（若未移动则无待写，空转）
      // —— 原子交接（硬不变量：松手零抖动）——
      // 同一同步块里写最终 inline left/top（= base.left/top 坐标系下的最终值）+ 清 transform；
      // commit 给 React 的几何与之逐字相同，React 重渲染写的仍是同一字符串 ⇒ 无跳变。
      el.style.left = `${target.x}px`;
      el.style.top = `${target.y}px`;
      el.style.transform = '';
      el.style.willChange = '';
      el.classList.remove(FLOAT_DRAGGING_CLASS);
      return moved ? { x: target.x, y: target.y } : null;
    },
  };
}

export interface ResizeSession {
  onMove(clientX: number, clientY: number): void;
  /** pointerup：落定 inline left/top/width/height，返回最终几何；未变化 → null */
  finish(): Rect | null;
}

/**
 * 开一次缩放会话（四角 + 四边共用）。缩放本就改尺寸（width/height 是布局属性，避不开
 * layout），但同样**合并到 rAF**、同样**松手才 commit**——不进 reducer、不每帧重渲染。
 * x/y 变化（左/上系把手）在拖拽期直接写 inline，松手值与 React 落地值逐字一致。
 */
export function beginFloatResize(opts: {
  el: FloatElLike;
  base: Rect;
  handle: ResizeHandle;
  origin: { x: number; y: number };
  viewport: () => Viewport;
  scheduler?: FrameScheduler;
}): ResizeSession {
  const { el, base, handle, origin } = opts;
  let target: Rect = base;
  const writer = createFrameWriter<Rect>((p) => {
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.width = `${p.w}px`;
    el.style.height = `${p.h}px`;
  }, opts.scheduler);
  return {
    onMove(cx, cy) {
      target = resizeRect(base, handle, cx - origin.x, cy - origin.y, opts.viewport());
      writer.write(target);
    },
    finish() {
      const changed = target.x !== base.x || target.y !== base.y || target.w !== base.w || target.h !== base.h;
      writer.flush();
      // 与 React 落地的内联几何逐字相同 ⇒ 无归一化步骤、无跳变
      el.style.left = `${target.x}px`;
      el.style.top = `${target.y}px`;
      el.style.width = `${target.w}px`;
      el.style.height = `${target.h}px`;
      return changed ? target : null;
    },
  };
}
