/**
 * 性能探针的 DOM 接线（2026-10-25 调试模式批 · UI 卡顿体检）。
 *
 * 工厂形态（`createPerfProbe`）：`install-debug` 实例化后挂到 `__kojoDebug.perf`。
 * **探针关着就是零开销**——observer / rAF 循环 / 定时器只在 start↔stop 窗口内存在。
 *
 * 采集四路（口径见 `perf-probe-core.ts` 头注）：
 * 1. `PerformanceObserver('longtask')`——主线程 ≥50ms 阻塞（全 Chromium 支持）；
 * 2. `PerformanceObserver('event')`——交互到下一帧的延迟（含 target 元素）；
 * 3. `PerformanceObserver('long-animation-frame')`——逐帧 script/style/layout 拆账与
 *    sourceURL 归因（Chrome/Edge ≥123；不支持时报告里如实标注 capability=false）；
 * 4. rAF 间隔采样（帧率/掉帧分档）＋ 定时器到期延迟（主线程被占的粗采样）。
 *
 * 内存有界：原始条目各自封顶（长帧 300 / 长任务 300 / 事件 500 / 帧间隔 200k），
 * 超限丢最旧并计数——探针自己不许成为卡顿源。
 */
import {
  buildReport,
  type BusEventLike,
  type EventLike,
  type LongFrameLike,
  type ProbeReport,
  type TaskLike,
} from './perf-probe-core';

const CAP_LONG_FRAMES = 300;
const CAP_LONG_TASKS = 300;
const CAP_EVENTS = 500;
const CAP_FRAME_DELTAS = 200_000;

export interface PerfProbe {
  start(opts?: { blockingSampleMs?: number }): { started: true; note: string };
  stop(): ProbeReport;
  isRunning(): boolean;
  lastReport(): ProbeReport | null;
}

interface RawCollected {
  frameDeltas: number[];
  longTasks: TaskLike[];
  events: EventLike[];
  longFrames: LongFrameLike[];
  blocking: { samples: number; over50: number; worstMs: number };
  dropped: { longFrames: number; longTasks: number; events: number; frameDeltas: number };
}

export function createPerfProbe(deps: { getBusRecent: (n: number) => readonly BusEventLike[] }): PerfProbe {
  let running = false;
  let startedAt = 0;
  let raw: RawCollected | null = null;
  let observers: PerformanceObserver[] = [];
  let rafId = 0;
  let blockingTimer: ReturnType<typeof setInterval> | null = null;
  let lastFrameT = 0;
  let last: ProbeReport | null = null;

  const cappedPush = <T,>(arr: T[], item: T, cap: number, dropCounterKey: keyof RawCollected['dropped']): void => {
    arr.push(item);
    if (arr.length > cap) {
      arr.shift();
      if (raw) raw.dropped[dropCounterKey] += 1;
    }
  };

  return {
    start(opts) {
      if (running) {
        return { started: true, note: '探针已在跑——先 stop() 再开新一轮（lastReport 会保留上一轮）' };
      }
      running = true;
      startedAt = performance.now();
      lastFrameT = startedAt;
      raw = {
        frameDeltas: [],
        longTasks: [],
        events: [],
        longFrames: [],
        blocking: { samples: 0, over50: 0, worstMs: 0 },
        dropped: { longFrames: 0, longTasks: 0, events: 0, frameDeltas: 0 },
      };
      observers = [];

      const collect = new Map<string, (list: PerformanceObserverEntryList) => void>();
      collect.set('longtask', (list) => {
        for (const e of list.getEntries()) {
          cappedPush(raw!.longTasks, { startTime: e.startTime, duration: e.duration }, CAP_LONG_TASKS, 'longTasks');
        }
      });
      collect.set('event', (list) => {
        for (const e of list.getEntries()) {
          const ev = e as PerformanceEntry & { target?: EventLike['target'] };
          // 只记真实交互类（click/keydown/pointer*），不记 hover 流量
          if (!/^(click|keydown|keyup|pointerdown|pointerup)$/.test(e.name)) continue;
          cappedPush(
            raw!.events,
            { startTime: e.startTime, duration: e.duration, name: e.name, target: ev.target ?? null },
            CAP_EVENTS,
            'events',
          );
        }
      });
      // long-animation-frame 支持性探测（单源在 capabilitiesLongAnimationFrame）：
      // 不支持的运行时这一路静默缺位（报告 capabilities 如实回）
      if (capabilitiesLongAnimationFrame()) {
        collect.set('long-animation-frame', (list) => {
          for (const e of list.getEntries()) {
            const f = e as unknown as LongFrameLike & { duration: number };
            cappedPush(raw!.longFrames, f, CAP_LONG_FRAMES, 'longFrames');
          }
        });
      }
      for (const [type, cb] of collect) {
        try {
          const ob = new PerformanceObserver(cb);
          // buffered:false（口径修①，2026-10-25 反馈）：buffered:true 会把 start 之前
          // 的历史条目整包补发（实测把页面加载期的 485ms 长任务算进新窗口）——探针
          // 只量自己窗口内发生的事。buildReport 侧另有 startedAt 过滤兜底（双保险）。
          ob.observe({ type, buffered: false } as PerformanceObserverInit);
          observers.push(ob);
        } catch {
          /* 单路缺位不拦整轮采集 */
        }
      }

      // rAF 帧间隔采样
      const onFrame = (): void => {
        if (!running || !raw) return;
        const now = performance.now();
        const delta = now - lastFrameT;
        lastFrameT = now;
        if (delta > 0 && delta < 60_000) {
          cappedPush(raw.frameDeltas, Math.round(delta * 10) / 10, CAP_FRAME_DELTAS, 'frameDeltas');
        }
        rafId = requestAnimationFrame(onFrame);
      };
      rafId = requestAnimationFrame(onFrame);

      // 阻塞采样：setTimeout(0) 的实际到期延迟（钳制后仍应 ~1ms；大幅偏迟 = 主线程被占）
      const blockingSampleMs = opts?.blockingSampleMs ?? 100;
      const blockingTick = (): void => {
        if (!running) return;
        const scheduled = performance.now();
        setTimeout(() => {
          if (!running || !raw) return;
          const late = performance.now() - scheduled - blockingSampleMs;
          const ms = Math.max(0, Math.round(late));
          raw.blocking.samples += 1;
          if (ms > raw.blocking.worstMs) raw.blocking.worstMs = ms;
          if (ms > 50) raw.blocking.over50 += 1;
        }, blockingSampleMs);
      };
      blockingTimer = setInterval(blockingTick, blockingSampleMs);

      return { started: true, note: `探针已开（采集四路：longtask / event / long-animation-frame / rAF+阻塞采样）` };
    },

    stop() {
      if (!running || !raw) {
        throw new Error('探针没在跑——先 perf start');
      }
      running = false;
      cancelAnimationFrame(rafId);
      if (blockingTimer !== null) clearInterval(blockingTimer);
      blockingTimer = null;
      for (const ob of observers) {
        try {
          ob.disconnect();
        } catch {}
      }
      observers = [];
      const bus = deps.getBusRecent(300).map((e) => ({ t: e.t, name: e.name }));
      const report = buildReport({
        startedAt,
        endedAt: performance.now(),
        frameDeltas: raw.frameDeltas,
        longTasks: raw.longTasks,
        events: raw.events,
        longFrames: raw.longFrames,
        blocking: raw.blocking,
        bus,
        hasLongAnimationFrame: raw.longFrames.length > 0 || capabilitiesLongAnimationFrame(),
      });
      last = report;
      raw = null;
      return report;
    },

    isRunning() {
      return running;
    },

    lastReport() {
      return last;
    },
  };
}

let lafCapability: boolean | null = null;
function capabilitiesLongAnimationFrame(): boolean {
  if (lafCapability === null) {
    try {
      const ob = new PerformanceObserver(() => {});
      ob.observe({ type: 'long-animation-frame', buffered: false } as PerformanceObserverInit);
      ob.disconnect();
      lafCapability = true;
    } catch {
      lafCapability = false;
    }
  }
  return lafCapability;
}
