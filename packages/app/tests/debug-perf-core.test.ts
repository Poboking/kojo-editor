// @vitest-environment happy-dom
/**
 * 性能探针纯逻辑核的判据（2026-10-25 调试模式批 · UI 卡顿体检）。
 * `perf-probe-core.ts` 零 DOM，分档 / 百分位 / 相关性 / 逐源码归因 / 报告口径全在这钉；
 * DOM 采集接线由 `debug-web-smoke` 的真机断言与 CLI 真跑兜（本文件不碰浏览器 API）。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateBySource,
  buildReport,
  frameStats,
  hintForTask,
  longFrameReadings,
  percentile,
  sourceName,
  summarizeReport,
  type LongFrameLike,
} from '../src/debug/perf-probe-core';

describe('perf-probe · 帧分档与百分位', () => {
  it('常规 60Hz 混一帧 120ms 尖刺：分档计数与 p95/p99/max 各就各位', () => {
    const deltas = [...Array(60).fill(16.7), 34, 51, 120];
    const s = frameStats(deltas);
    expect(s.total).toBe(63);
    expect(s.over32).toBe(3);
    expect(s.over50).toBe(2);
    expect(s.over100).toBe(1);
    expect(s.max).toBe(120);
    expect(s.p50).toBe(16.7);
    // nearest-rank：63 样本的 p95 落在第 60 位＝16.7（尾部占比由 over* 计数承担），p99 命中尖刺
    expect(s.p95).toBe(16.7);
    expect(s.p99).toBe(120);
  });

  it('空采样不炸：全零读数（探针窗口极短时的诚实形态）', () => {
    const s = frameStats([]);
    expect(s).toMatchObject({ total: 0, over32: 0, over50: 0, over100: 0, max: 0 });
  });

  it('percentile 有界：永不越界、空数组归零', () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('perf-probe · 长任务 × 总线事件相关性', () => {
  const probeStart = 1000;
  it('窗口相交的最近事件作 hint；不相交 ⇒ null', () => {
    const bus = [
      { t: 1050, name: 'kojo.functionChanged' }, // 任务窗口 [1060,1260] 之前 10ms ⇒ 相交（-200 容差内）
      { t: 2000, name: 'editor.activeFileChanged' }, // 远处不相交
    ];
    expect(hintForTask(60, 200, bus, probeStart)).toBe('kojo.functionChanged');
    expect(hintForTask(900, 50, [], probeStart)).toBeNull();
  });
});

describe('perf-probe · 逐源码文件的帧耗时归因', () => {
  const frame = (dur: number, scripts: [string, number][]): LongFrameLike => ({
    startTime: 1,
    duration: dur,
    script: scripts.map(([sourceURL, duration]) => ({ sourceURL, duration })),
  });

  it('同文件跨帧聚合、按 scriptMs 降序；query 串剥掉、inline 有名有姓', () => {
    const out = aggregateBySource([
      frame(120, [['http://127.0.0.1:4173/src/ui/ShellLayout.tsx?t=3', 80], ['http://127.0.0.1:4173/src/ui/FileTree.tsx', 20]]),
      frame(90, [['http://127.0.0.1:4173/src/ui/ShellLayout.tsx?t=3', 40]]),
      frame(70, [['', 30]]),
    ]);
    expect(out[0]).toEqual({ source: 'ShellLayout.tsx', scriptMs: 120, frames: 2 });
    expect(out.find((s) => s.source === 'FileTree.tsx')).toEqual({ source: 'FileTree.tsx', scriptMs: 20, frames: 1 });
    expect(out.find((s) => s.source === '(inline)')).toEqual({ source: '(inline)', scriptMs: 30, frames: 1 });
  });

  it('sourceName：URL 取末段、裸串截断、空串=inline', () => {
    expect(sourceName('http://x/src/ui/Palette.tsx?t=1')).toBe('Palette.tsx');
    expect(sourceName('')).toBe('(inline)');
    expect(sourceName('not a url but long enough text over sixty characters to be cut')).toHaveLength(60);
  });

  it('longFrameReadings：按 duration 取最坏 Top-N，script/render 拆账带 sources', () => {
    const out = longFrameReadings([frame(80, [['a.tsx', 60]]), frame(150, [['b.tsx', 100], ['c.tsx', 20]])], 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ durationMs: 150, scriptMs: 120, renderMs: 30 });
    expect(out[0]!.sources).toEqual(['b.tsx', 'c.tsx']);
  });
});

describe('perf-probe · 报告拼装与摘要', () => {
  it('全量字段 + 阈值随报告回显 + 事件延迟只记 >100ms 且按最坏排序', () => {
    const r = buildReport({
      startedAt: 1000,
      endedAt: 4000,
      frameDeltas: [...Array(60).fill(16.7), 120],
      longTasks: [{ startTime: 200, duration: 300 }],
      events: [
        { startTime: 10, duration: 40, name: 'click', target: { tagName: 'BUTTON' } },
        { startTime: 20, duration: 210, name: 'pointerdown', target: { tagName: 'INPUT', className: 'picker-input x' } },
      ],
      longFrames: [],
      blocking: { samples: 30, over50: 2, worstMs: 90 },
      bus: [{ t: 1200, name: 'project.opened' }],
      hasLongAnimationFrame: true,
    });
    expect(r.durationMs).toBe(3000);
    expect(r.frames.over100).toBe(1);
    expect(r.longTasks[0]).toMatchObject({ durationMs: 300, hint: 'project.opened' });
    expect(r.eventLatency).toHaveLength(1); // 40ms 的 click 不进 notable 档
    expect(r.eventLatency[0]).toMatchObject({ durationMs: 210, type: 'pointerdown', target: 'INPUT.picker-input' });
    expect(r.capabilities).toEqual({ longAnimationFrame: true });
    expect(r.thresholds.frame).toEqual({ dropped: 32, jank: 50, severe: 100 });
    const lines = summarizeReport(r);
    expect(lines.some((l) => l.includes('p95='))).toBe(true);
    expect(lines.some((l) => l.includes('逐源码帧耗时'))).toBe(true);
  });

  it('无 long-animation-frame 支持时摘要如实说明（不是静默缺数）', () => {
    const r = buildReport({
      startedAt: 0,
      endedAt: 100,
      frameDeltas: [16, 17],
      longTasks: [],
      events: [],
      longFrames: [],
      blocking: { samples: 1, over50: 0, worstMs: 0 },
      bus: [],
      hasLongAnimationFrame: false,
    });
    expect(summarizeReport(r).some((l) => l.includes('不支持 long-animation-frame'))).toBe(true);
  });
});
