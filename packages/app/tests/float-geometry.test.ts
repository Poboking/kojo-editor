import { describe, expect, it } from 'vitest';
import {
  DRAG_KEEP,
  RESIZE_HANDLES,
  dragRect,
  handleVector,
  keyResizeDelta,
  resizeRect,
  type Rect,
  type ResizeHandle,
  type Viewport,
} from '../src/ui/float-geometry';
import {
  createFrameWriter,
  beginFloatDrag,
  beginFloatResize,
  type FloatElLike,
  type FrameScheduler,
} from '../src/ui/float-drag';
import { MIN_FLOAT } from '../src/ui/layout';

/**
 * 浮窗几何 / 帧合并 / 松手交接单测（2026-10-14 浮窗性能 + 四角缩放批）。
 *
 * 这个文件是那两条改动的**客观护栏**——没有它，"拖拽不再每帧 layout""松手零抖动"
 * 都只是嘴上的话。盯三类会静默回归的判据：
 * ① 四角/四边缩放的方向与钳制（下界 MIN_FLOAT、边界不越出视口）；
 * ② rAF 帧合并：一帧最多写一次样式、只写最新值；
 * ③ **松手原子交接**：拖拽期只写 transform、**绝不写 left/top**（写 left/top = 每帧 layout，
 *    正是被根治的卡顿源头）；松手落定的 inline left/top 与返回的几何**逐字一致**。
 *
 * 下面用假元素 + 手动手写调度器，在 node 环境里把 DOM 写盘次数**数出来**。
 */

/* ------------------------------- 测试脚手架 ------------------------------- */

const VIEWPORT: Viewport = { w: 1200, h: 800 };

/** 可计数的样式面：每个属性记一次写入次数 */
interface CountedStyle {
  transforms: number;
  lefts: number;
  tops: number;
  widths: number;
  heights: number;
  willChanges: number;
  style: FloatElLike['style'];
}

function countedStyle(init: Partial<Record<'left' | 'top' | 'width' | 'height', string>> = {}): CountedStyle {
  const vals: Record<string, string> = {
    transform: '',
    left: init.left ?? '',
    top: init.top ?? '',
    width: init.width ?? '',
    height: init.height ?? '',
    willChange: '',
  };
  const c: CountedStyle = { transforms: 0, lefts: 0, tops: 0, widths: 0, heights: 0, willChanges: 0, style: {} as FloatElLike['style'] };
  const bump: Record<string, () => void> = {
    transform: () => (c.transforms += 1),
    left: () => (c.lefts += 1),
    top: () => (c.tops += 1),
    width: () => (c.widths += 1),
    height: () => (c.heights += 1),
    willChange: () => (c.willChanges += 1),
  };
  for (const key of Object.keys(vals)) {
    Object.defineProperty(c.style, key, {
      get: () => vals[key],
      set: (v: string) => {
        vals[key] = v;
        bump[key]?.();
      },
      enumerable: true,
    });
  }
  return c;
}

function makeEl(init: Parameters<typeof countedStyle>[0] = {}): { el: FloatElLike; c: CountedStyle } {
  const c = countedStyle(init);
  const classes = new Set<string>();
  const el: FloatElLike = {
    style: c.style,
    classList: {
      add: (...t: string[]) => t.forEach((x) => classes.add(x)),
      remove: (...t: string[]) => t.forEach((x) => classes.delete(x)),
    },
  };
  return { el, c };
}

/** 手动帧调度器：`flushFrame` 才真正跑排队的回调（模拟 rAF 到点） */
function makeScheduler(): { sched: FrameScheduler; flushFrame: () => void; pending: () => number } {
  let next = 1;
  const jobs = new Map<number, () => void>();
  return {
    sched: {
      request: (cb) => {
        const id = next++;
        jobs.set(id, cb);
        return id;
      },
      cancel: (id) => {
        jobs.delete(id);
      },
    },
    flushFrame: () => {
      const run = [...jobs.values()];
      jobs.clear();
      for (const cb of run) cb();
    },
    pending: () => jobs.size,
  };
}

/* --------------------------------- 几何 --------------------------------- */

const BASE: Rect = { x: 100, y: 100, w: 400, h: 300 };

describe('dragRect：拖拽位置与可见性钳制', () => {
  it('自由位移：dx/dy 原样加到 x/y', () => {
    expect(dragRect(BASE, 30, -20, VIEWPORT)).toEqual({ x: 130, y: 80 });
  });

  it('右/下越界：钳在「至少 DRAG_KEEP 可见」的口径内', () => {
    expect(dragRect(BASE, 9999, 9999, VIEWPORT)).toEqual({ x: VIEWPORT.w - DRAG_KEEP.x, y: VIEWPORT.h - DRAG_KEEP.y });
  });

  it('左/上越界：横向可负但要留 DRAG_KEEP.x 可见，纵向不越 0', () => {
    const r = dragRect(BASE, -9999, -9999, VIEWPORT);
    expect(r.x).toBe(DRAG_KEEP.x - BASE.w); // 80 - 400
    expect(r.y).toBe(0);
  });
});

describe('resizeRect：四角 + 四边', () => {
  it('后缘把手（se / e / s）：只放大，x/y 不动', () => {
    expect(resizeRect(BASE, 'se', 50, 40, VIEWPORT)).toEqual({ x: 100, y: 100, w: 450, h: 340 });
    expect(resizeRect(BASE, 'e', 50, 40, VIEWPORT)).toEqual({ x: 100, y: 100, w: 450, h: 300 });
    expect(resizeRect(BASE, 's', 50, 40, VIEWPORT)).toEqual({ x: 100, y: 100, w: 400, h: 340 });
  });

  it('四角：前缘把手同时挪 x/y 与 w/h', () => {
    expect(resizeRect(BASE, 'nw', -30, -20, VIEWPORT)).toEqual({ x: 70, y: 80, w: 430, h: 320 });
    expect(resizeRect(BASE, 'ne', 30, -20, VIEWPORT)).toEqual({ x: 100, y: 80, w: 430, h: 320 });
    expect(resizeRect(BASE, 'sw', -30, 20, VIEWPORT)).toEqual({ x: 70, y: 100, w: 430, h: 320 });
  });

  it('前缘单边（w / n）：只挪一个轴', () => {
    expect(resizeRect(BASE, 'w', -30, 40, VIEWPORT)).toEqual({ x: 70, y: 100, w: 430, h: 300 });
    expect(resizeRect(BASE, 'n', 30, -20, VIEWPORT)).toEqual({ x: 100, y: 80, w: 400, h: 320 });
  });

  it('下界 MIN_FLOAT：后缘收过头、前缘顶过头都停在最小尺寸', () => {
    expect(resizeRect(BASE, 'se', -9999, -9999, VIEWPORT)).toEqual({ x: 100, y: 100, w: MIN_FLOAT.w, h: MIN_FLOAT.h });
    // 前缘把手往内顶过头：右/下边钉住，尺寸收到 MIN
    const r = resizeRect(BASE, 'nw', 9999, 9999, VIEWPORT);
    expect(r.w).toBe(MIN_FLOAT.w);
    expect(r.h).toBe(MIN_FLOAT.h);
    expect(r.x + r.w).toBe(BASE.x + BASE.w); // 钉住的右边不动
    expect(r.y + r.h).toBe(BASE.y + BASE.h);
  });

  it('上/左边不越出视口到不可见：前缘拖到负区钳在 0', () => {
    const r = resizeRect(BASE, 'nw', -9999, -9999, VIEWPORT);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('右/下边不越出视口：后缘拖出视口钳在视口尺寸', () => {
    const r = resizeRect(BASE, 'se', 9999, 9999, VIEWPORT);
    expect(r).toEqual({ x: 100, y: 100, w: VIEWPORT.w - 100, h: VIEWPORT.h - 100 });
  });

  it('每个把手都有方向向量，且恰为八向', () => {
    expect(RESIZE_HANDLES).toHaveLength(8);
    expect(handleVector('se')).toEqual({ x: 1, y: 1 });
    expect(handleVector('nw')).toEqual({ x: -1, y: -1 });
    expect(handleVector('n')).toEqual({ x: 0, y: -1 });
    for (const h of RESIZE_HANDLES) {
      const v = handleVector(h);
      expect([-1, 0, 1]).toContain(v.x);
      expect([-1, 0, 1]).toContain(v.y);
    }
  });

  it('keyResizeDelta：方向键映射为把手方向的放大/缩小', () => {
    expect(keyResizeDelta('se', 'ArrowRight')).toEqual({ dx: 8, dy: 0 });
    expect(keyResizeDelta('se', 'ArrowUp')).toEqual({ dx: 0, dy: -8 });
    expect(keyResizeDelta('nw', 'ArrowRight')).toEqual({ dx: -8, dy: 0 }); // 前缘把手向左为放大 → 右键是缩小
    expect(keyResizeDelta('se', 'Enter')).toBeNull();
  });
});

/* ------------------------------ 帧合并 writer ------------------------------ */

describe('createFrameWriter：一帧最多写一次、只写最新值', () => {
  it('同一帧多次 write → 只 apply 一次，且是最新值', () => {
    const { sched, flushFrame, pending } = makeScheduler();
    const got: number[] = [];
    const w = createFrameWriter<number>((v) => got.push(v), sched);
    w.write(1);
    w.write(2);
    w.write(3);
    expect(got).toEqual([]); // 未到帧：一次没写
    expect(pending()).toBe(1); // 只排了一个帧
    flushFrame();
    expect(got).toEqual([3]);
  });

  it('跨帧各自落一次', () => {
    const { sched, flushFrame } = makeScheduler();
    const got: number[] = [];
    const w = createFrameWriter<number>((v) => got.push(v), sched);
    w.write(1);
    flushFrame();
    w.write(2);
    flushFrame();
    expect(got).toEqual([1, 2]);
  });

  it('flush 同步落定待写值并取消排帧（松手用）', () => {
    const { sched, flushFrame, pending } = makeScheduler();
    const got: number[] = [];
    const w = createFrameWriter<number>((v) => got.push(v), sched);
    w.write(7);
    w.flush();
    expect(got).toEqual([7]);
    flushFrame(); // 已取消 → 不重复
    expect(got).toEqual([7]);
    expect(pending()).toBe(0);
  });

  it('cancel 丢弃待写值', () => {
    const { sched, flushFrame } = makeScheduler();
    const got: number[] = [];
    const w = createFrameWriter<number>((v) => got.push(v), sched);
    w.write(7);
    w.cancel();
    flushFrame();
    expect(got).toEqual([]);
  });
});

/* --------------------------- 拖拽会话：原子交接 --------------------------- */

describe('beginFloatDrag：拖拽期零 left/top 写（性能护栏）+ 松手零 delta 交接', () => {
  it('拖拽期只写 transform；left/top 纹丝不动（回退到每帧写 left/top 会红）', () => {
    const { el, c } = makeEl({ left: '100px', top: '100px' }); // 模拟 React 已落地的基准内联
    c.lefts = 0;
    c.tops = 0;
    const { sched, flushFrame } = makeScheduler();
    const s = beginFloatDrag({ el, base: BASE, origin: { x: 1000, y: 1000 }, viewport: () => VIEWPORT, scheduler: sched });

    s.onMove(1030, 1010); // dx=30 dy=10
    s.onMove(1060, 1060); // 同帧再动，最新位移 dx=60 dy=60
    expect(c.lefts).toBe(0); // 关键断言：拖拽期一个 left 都没写
    expect(c.tops).toBe(0);
    expect(c.transforms).toBe(0); // 未到帧：transform 也还没写

    flushFrame();
    expect(c.transforms).toBe(1); // 一帧恰好一次
    expect(c.lefts).toBe(0); // 仍不写 left
    expect(el.style.transform).toBe('translate3d(60px, 60px, 0)');

    const g = s.finish();
    expect(g).toEqual({ x: 160, y: 160 });
    // —— 交接不变量：落定的 inline left/top 与返回几何逐字一致 ⇒ React 写相同值无跳变 ——
    expect(el.style.left).toBe(`${g?.x}px`);
    expect(el.style.top).toBe(`${g?.y}px`);
    expect(el.style.transform).toBe(''); // transform 已清
    expect(el.style.willChange).toBe('');
  });

  it('未移动就松手：finish 返回 null（不触发多余 commit）', () => {
    const { el } = makeEl({ left: '100px', top: '100px' });
    const { sched } = makeScheduler();
    const s = beginFloatDrag({ el, base: BASE, origin: { x: 1000, y: 1000 }, viewport: () => VIEWPORT, scheduler: sched });
    expect(s.finish()).toBeNull();
  });

  it('钳制在会话内生效（拖出视口 → 收敛到边界）', () => {
    const { el } = makeEl({ left: '100px', top: '100px' });
    const { sched } = makeScheduler();
    const s = beginFloatDrag({ el, base: BASE, origin: { x: 0, y: 0 }, viewport: () => VIEWPORT, scheduler: sched });
    s.onMove(99999, 99999);
    expect(s.finish()).toEqual({ x: VIEWPORT.w - DRAG_KEEP.x, y: VIEWPORT.h - DRAG_KEEP.y });
  });
});

/* --------------------------- 缩放会话：四角提交 --------------------------- */

describe('beginFloatResize：四角缩放同一套性能口径', () => {
  it('nw 一角：一帧合并成一次写，松手 inline 与几何逐字一致', () => {
    const { el, c } = makeEl({ left: '100px', top: '100px', width: '400px', height: '300px' });
    c.lefts = 0;
    c.tops = 0;
    c.widths = 0;
    c.heights = 0;
    const { sched, flushFrame } = makeScheduler();
    const s = beginFloatResize({ el, base: BASE, handle: 'nw', origin: { x: 500, y: 500 }, viewport: () => VIEWPORT, scheduler: sched });

    s.onMove(480, 490); // dx=-20 dy=-10
    s.onMove(470, 480); // 同帧最新 dx=-30 dy=-20
    expect(c.lefts).toBe(0);
    expect(c.widths).toBe(0); // 拖拽期一次没写
    flushFrame();
    expect(c.lefts).toBe(1); // 一帧一次
    expect(c.widths).toBe(1);
    expect(el.style.left).toBe('70px');
    expect(el.style.top).toBe('80px');
    expect(el.style.width).toBe('430px');
    expect(el.style.height).toBe('320px');

    const g = s.finish();
    expect(g).toEqual({ x: 70, y: 80, w: 430, h: 320 });
    expect(el.style.left).toBe(`${g?.x}px`);
    expect(el.style.top).toBe(`${g?.y}px`);
    expect(el.style.width).toBe(`${g?.w}px`);
    expect(el.style.height).toBe(`${g?.h}px`);
  });

  it('se 一角：只放大，x/y 维持基准', () => {
    const { el } = makeEl({ left: '100px', top: '100px', width: '400px', height: '300px' });
    const { sched } = makeScheduler();
    const s = beginFloatResize({ el, base: BASE, handle: 'se', origin: { x: 500, y: 500 }, viewport: () => VIEWPORT, scheduler: sched });
    s.onMove(560, 550);
    const g = s.finish();
    expect(g).toEqual({ x: 100, y: 100, w: 460, h: 350 });
  });

  it('未变化就松手：finish 返回 null', () => {
    const { el } = makeEl({ left: '100px', top: '100px', width: '400px', height: '300px' });
    const { sched } = makeScheduler();
    const s = beginFloatResize({ el, base: BASE, handle: 'se', origin: { x: 500, y: 500 }, viewport: () => VIEWPORT, scheduler: sched });
    expect(s.finish()).toBeNull();
  });
});
