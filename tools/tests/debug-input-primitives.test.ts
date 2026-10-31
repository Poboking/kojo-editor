/**
 * 指针原语（hover / 双击 / 拖拽 / 滚轮）的判据守卫（1030 调试批，第一波：只到 lib 层）。
 *
 * 这些原语本波不进 CLI（下一波统一接），所以判据只能钉在**事件序列**上：
 * ① `mousePath` 的取点形状——拖拽成不成立全看中间帧发得对不对，而中间帧的算法是纯函数，
 *    可以脱开浏览器逐格对拍（steps 退化、同点、小数、负坐标夹取）。
 * ② 伪 cdp 收 `Input.dispatchMouseEvent` 的参数：双击必须是 clickCount 1、2 两轮；
 *    拖拽必须是 pressed → N 帧 buttons:1 移动 → released，且首尾坐标正好落在起终点；
 *    滚轮必须把 deltaX/deltaY 原样带给 `mouseWheel`。
 * ③ 选择器打不中时必须抛**带选择器原文**的错——调试工具最怕的是"静默点在空白处"，
 *    调用方拿不到原文就没法从日志反推是哪一处选择器坏了。
 */
import { describe, expect, it } from 'vitest';
import { cdpDoubleClick, cdpDrag, cdpHover, cdpWheel, mousePath } from '../debug-lib.mjs';

type Call = [string, Record<string, any>];

interface FakeOpts {
  /** 页内取中心的返回值；null 表示选择器打不中 */
  point?: { x: number; y: number } | null;
  /** elementFromPoint 自证结果 */
  hit?: boolean;
}

/** 伪 cdp：只收 send 的参数序列，evalJs 按表达式形状给两种固定答案（中心 / 自证） */
function makeFakeCdp({ point = { x: 100, y: 60 }, hit = true }: FakeOpts = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async send(method: string, params: Record<string, any> = {}) {
      calls.push([method, params]);
      return {};
    },
    async evalJs(expr: string) {
      if (expr.includes('elementFromPoint')) return hit;
      return point;
    },
  };
}

const points = (calls: Call[]) => calls.map(([, p]) => ({ x: p.x, y: p.y }));
const ofType = (calls: Call[], type: string) => calls.filter(([, p]) => p.type === type);
const types = (calls: Call[]) => calls.map(([, p]) => p.type);

describe('mousePath · 拖拽中间帧的取点', () => {
  it('steps=1 ⇒ 只有终点一步（按下后立刻到位）', () => {
    const path = mousePath({ x: 10, y: 20 }, { x: 110, y: 120 }, 1);
    expect(path).toHaveLength(1);
    expect(path[0]).toEqual({ x: 110, y: 120 });
  });

  it('steps=8 ⇒ 8 帧，首帧是 1/8 位移、末帧精确落在终点', () => {
    const path = mousePath({ x: 0, y: 0 }, { x: 80, y: 160 }, 8);
    expect(path).toHaveLength(8);
    expect(path[0]).toEqual({ x: 10, y: 20 });
    expect(path[path.length - 1]).toEqual({ x: 80, y: 160 });
    // 单调推进，不回头（回头的中间帧会被页面当成抖动，drop 判定可能放弃）
    for (let i = 1; i < path.length; i++) expect(path[i].x).toBeGreaterThan(path[i - 1].x);
  });

  it('steps=0 / -3 / 非整数 ⇒ 退化为终点一步或四舍五入，绝不返回空数组', () => {
    expect(mousePath({ x: 0, y: 0 }, { x: 40, y: 40 }, 0)).toEqual([{ x: 40, y: 40 }]);
    expect(mousePath({ x: 0, y: 0 }, { x: 40, y: 40 }, -3)).toEqual([{ x: 40, y: 40 }]);
    expect(mousePath({ x: 0, y: 0 }, { x: 40, y: 40 }, 2.4)).toHaveLength(2);
  });

  it('起终点重合 ⇒ 每一帧都在原地（长度仍等于 steps）', () => {
    const path = mousePath({ x: 50, y: 50 }, { x: 50, y: 50 }, 4);
    expect(path).toHaveLength(4);
    for (const p of path) expect(p).toEqual({ x: 50, y: 50 });
  });

  it('小数坐标 ⇒ 中间帧保留小数，末帧等于终点原值', () => {
    const path = mousePath({ x: 10.5, y: 20.5 }, { x: 20.5, y: 40.5 }, 2);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ x: 15.5, y: 30.5 });
    expect(path[1]).toEqual({ x: 20.5, y: 40.5 });
  });

  it('负坐标 ⇒ 逐帧夹到 0（CDP 不认负的视口点）', () => {
    const path = mousePath({ x: -40, y: -10 }, { x: 40, y: 10 }, 2);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ x: 0, y: 0 }); // 插值出的 -20 / -5 被夹平
    expect(path[1]).toEqual({ x: 40, y: 10 });
  });
});

describe('cdpDoubleClick · 两轮 pressed/released，clickCount 递进', () => {
  it('事件序列是 pressed(1) released(1) pressed(2) released(2)，同一坐标', () => {
    const cdp = makeFakeCdp();
    return cdpDoubleClick(cdp, '.monaco-editor').then(() => {
      expect(cdp.calls.map(([m]) => m)).toEqual(Array(4).fill('Input.dispatchMouseEvent'));
      expect(types(cdp.calls)).toEqual(['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
      expect(cdp.calls.map(([, p]) => p.clickCount)).toEqual([1, 1, 2, 2]);
      expect(points(cdp.calls)).toEqual(Array(4).fill({ x: 100, y: 60 }));
    });
  });

  it('选择器打不中 ⇒ 抛错并带选择器原文（不静默点在空白处）', async () => {
    const cdp = makeFakeCdp({ point: null });
    await expect(cdpDoubleClick(cdp, '.ghost-row')).rejects.toThrow(/页面上没有 \.ghost-row/);
    expect(cdp.calls).toHaveLength(0); // 没解析到点就一个事件都不该发
  });

  it('坐标对象里出现非有限数 ⇒ 抛错，同样不发事件', async () => {
    const cdp = makeFakeCdp();
    await expect(cdpWheel(cdp, { x: Number.NaN, y: 10 })).rejects.toThrow(/坐标必须是有限数/);
    expect(cdp.calls).toHaveLength(0);
  });
});

describe('cdpDrag · 按下 → 中间帧 → 抬起', () => {
  it('steps=4 时 4 帧移动，首帧推进 1/4，末帧与 released 同落终点', async () => {
    const cdp = makeFakeCdp(); // 选择器解析成 (100, 60)
    const r = await cdpDrag(cdp, '.tree-file', { x: 180, y: 60 }, { steps: 4 });

    expect(types(cdp.calls)).toEqual([
      'mousePressed',
      'mouseMoved',
      'mouseMoved',
      'mouseMoved',
      'mouseMoved',
      'mouseReleased',
    ]);

    const pressed = cdp.calls[0][1];
    expect([pressed.x, pressed.y, pressed.buttons]).toEqual([100, 60, 1]);

    const moves = points(ofType(cdp.calls, 'mouseMoved'));
    expect(moves).toHaveLength(4);
    expect(moves[0]).toEqual({ x: 120, y: 60 }); // 100 + 80/4
    expect(moves[moves.length - 1]).toEqual({ x: 180, y: 60 });
    // 中间帧必须都带 buttons:1，否则页面只看到「悬停」而不是「按住拖」
    for (const [, p] of ofType(cdp.calls, 'mouseMoved')) expect(p.buttons).toBe(1);

    const released = cdp.calls[cdp.calls.length - 1][1];
    expect([released.x, released.y, released.buttons]).toEqual([180, 60, 0]);
    expect(r).toEqual({ from: { x: 100, y: 60 }, to: { x: 180, y: 60 }, moves: 4 });
  });

  it('起终点都支持坐标对象（不碰 DOM 也能拖）', async () => {
    const cdp = makeFakeCdp();
    await cdpDrag(cdp, { x: 0, y: 0 }, { x: 24, y: 0 }, { steps: 3 });
    expect(points(ofType(cdp.calls, 'mouseMoved'))).toEqual([
      { x: 8, y: 0 },
      { x: 16, y: 0 },
      { x: 24, y: 0 },
    ]);
    expect(cdp.calls[0][1]).toMatchObject({ type: 'mousePressed', x: 0, y: 0 });
    expect(cdp.calls[cdp.calls.length - 1][1]).toMatchObject({ type: 'mouseReleased', x: 24, y: 0 });
  });
});

describe('cdpHover / cdpWheel · 落点与载荷', () => {
  it('hover 只发一次 mouseMoved 并停在目标中心（settleMs:0 不等待）', async () => {
    const cdp = makeFakeCdp();
    await cdpHover(cdp, '.hover-target', { settleMs: 0 });
    expect(types(cdp.calls)).toEqual(['mouseMoved']);
    expect(points(cdp.calls)).toEqual([{ x: 100, y: 60 }]);
  });

  it('wheel 先移动再滚，dx/dy 原样进 deltaX/deltaY', async () => {
    const cdp = makeFakeCdp();
    await cdpWheel(cdp, { x: 30, y: 40 }, { dx: 5, dy: 120 });
    expect(types(cdp.calls)).toEqual(['mouseMoved', 'mouseWheel']);
    expect(points(cdp.calls)).toEqual([
      { x: 30, y: 40 },
      { x: 30, y: 40 },
    ]);
    const wheel = cdp.calls[1][1];
    expect(wheel).toMatchObject({ type: 'mouseWheel', deltaX: 5, deltaY: 120 });
  });
});
