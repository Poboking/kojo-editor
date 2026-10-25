/**
 * 性能探针的纯逻辑核（2026-10-25 调试模式批 · UI 卡顿体检）。
 *
 * 本文件**零 DOM**：分档 / 百分位 / 长任务与内核事件的相关性 / 逐源码文件的帧耗时
 * 归因 / 报告拼装全在这里，node 池直接单测；DOM 侧的采集接线在 `perf-probe.ts`。
 *
 * 口径（写死在常量里，报告同时回显，判读不带猜）：
 * - 帧间隔（rAF 采样）：>32ms＝掉 1 帧（60Hz 档）、>50ms＝明显卡、>100ms＝严重卡；
 * - 长任务：PerformanceObserver `longtask`（规范下限 50ms）；
 * - 交互延迟：`event` 条目的 duration（输入处理到下一帧渲染，INP 同轴），
 *   >100ms 记「值得看」，>200ms 记「卡」；
 * - 逐源码归因：`long-animation-frame` 条目的 scripts[].sourceURL 聚合到文件名——
 *   「哪个组件在吃帧」按代码文件回答（dev 形态 URL 带源码路径，最精确）。
 */

/** 帧间隔分档阈值（ms）——与 60Hz 对齐；判读口径随报告回显 */
export const FRAME_JANK_MS = { dropped: 32, jank: 50, severe: 100 } as const;
/** 交互延迟分档阈值（ms）——INP 同轴 */
export const EVENT_LATENCY_MS = { notable: 100, bad: 200 } as const;

export interface FrameStats {
  readonly total: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly over32: number;
  readonly over50: number;
  readonly over100: number;
}

export interface LongTaskReading {
  readonly t: number;
  readonly durationMs: number;
  /** 卡顿窗口内正在/刚发生的内核事件（相关性提示，不是因果断言） */
  readonly hint: string | null;
}

export interface EventLatencyReading {
  readonly t: number;
  readonly type: string;
  readonly durationMs: number;
  readonly target: string;
}

export interface SourceCostReading {
  readonly source: string;
  readonly scriptMs: number;
  readonly frames: number;
}

export interface LongFrameReading {
  readonly t: number;
  readonly durationMs: number;
  readonly scriptMs: number;
  readonly renderMs: number;
  readonly sources: readonly string[];
}

export interface BusEventLike {
  readonly t: number;
  readonly name: string;
}

export interface ProbeReport {
  readonly kind: 'perf-probe';
  readonly startedAt: number;
  readonly durationMs: number;
  readonly frames: FrameStats;
  readonly longTasks: readonly LongTaskReading[];
  readonly eventLatency: readonly EventLatencyReading[];
  readonly bySource: readonly SourceCostReading[];
  readonly longFrames: readonly LongFrameReading[];
  /** 阻塞采样（定时器到期延迟 ⇒ 主线程被占）：样本数 / 超阈数 / 最坏一次 */
  readonly blocking: { samples: number; over50: number; worstMs: number };
  readonly capabilities: { longAnimationFrame: boolean };
  readonly thresholds: { frame: typeof FRAME_JANK_MS; event: typeof EVENT_LATENCY_MS };
}

/** 百分位（输入未排序会先排；空数组 ⇒ NaN 由调用方避免） */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]! * 10) / 10;
}

export function frameStats(deltas: readonly number[]): FrameStats {
  const over = (limit: number): number => deltas.reduce((acc, d) => acc + (d > limit ? 1 : 0), 0);
  return {
    total: deltas.length,
    p50: percentile(deltas, 50),
    p95: percentile(deltas, 95),
    p99: percentile(deltas, 99),
    max: deltas.length ? Math.round(Math.max(...deltas) * 10) / 10 : 0,
    over32: over(FRAME_JANK_MS.dropped),
    over50: over(FRAME_JANK_MS.jank),
    over100: over(FRAME_JANK_MS.severe),
  };
}

/**
 * 长任务 ↔ 内核事件相关性：取与任务窗口 [t, t+dur] 相交的**最近一条**总线事件名做 hint。
 * 空环 / 无相交 ⇒ null。这是「卡的那 200ms 里在跑什么」的线索，不是因果证明。
 */
export function hintForTask(taskT: number, taskDur: number, bus: readonly BusEventLike[], probeStart: number): string | null {
  const absT = probeStart + taskT;
  let best: BusEventLike | null = null;
  for (const ev of bus) {
    if (ev.t <= absT + taskDur && ev.t >= absT - 200) {
      if (best === null || Math.abs(ev.t - absT) < Math.abs(best.t - absT)) best = ev;
    }
  }
  return best ? best.name : null;
}

/** sourceURL → 人读源名：URL 取路径最后一段（dev 的 …/src/ui/ShellLayout.tsx?t=123 → ShellLayout.tsx）；裸串截断 */
export function sourceName(url: string): string {
  if (!url) return '(inline)';
  // 非绝对路径/URL 的裸串别走 URL 解析（会被当相对路径整段编码）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('/')) return url.slice(0, 60);
  try {
    const u = new URL(url, 'http://local.invalid');
    const last = u.pathname.split('/').filter(Boolean).pop() ?? u.pathname;
    return last || '(inline)';
  } catch {
    return url.slice(0, 60);
  }
}

export interface LongFrameLike {
  startTime: number;
  duration: number;
  script?: { duration?: number; sourceURL?: string }[];
  renderStart?: number;
  styleAndLayoutStart?: number;
}

/**
 * 逐源码文件的帧耗时归因：long-animation-frame 条目 × 其 scripts[].sourceURL 聚合。
 * scriptMs 用脚本 duration 合计（条目自身 duration 含渲染），frames＝该文件出现的长帧数。
 */
export function aggregateBySource(frames: readonly LongFrameLike[]): SourceCostReading[] {
  const map = new Map<string, SourceCostReading & { scriptMs: number; frames: number }>();
  for (const f of frames) {
    const scripts = Array.isArray(f.script) ? f.script : [];
    const perFrame = new Map<string, number>();
    for (const s of scripts) {
      const name = sourceName(s?.sourceURL ?? '');
      perFrame.set(name, (perFrame.get(name) ?? 0) + (s?.duration ?? 0));
    }
    for (const [name, ms] of perFrame) {
      const cur = map.get(name) ?? { source: name, scriptMs: 0, frames: 0 };
      cur.scriptMs += ms;
      cur.frames += 1;
      map.set(name, cur);
    }
  }
  return [...map.values()]
    .map((r) => ({ source: r.source, scriptMs: Math.round(r.scriptMs), frames: r.frames }))
    .sort((a, b) => b.scriptMs - a.scriptMs);
}

export function longFrameReadings(frames: readonly LongFrameLike[], limit = 20): LongFrameReading[] {
  return [...frames]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit)
    .map((f) => {
      const scripts = Array.isArray(f.script) ? f.script : [];
      const scriptMs = scripts.reduce((acc, s) => acc + (s?.duration ?? 0), 0);
      const sources = [...new Set(scripts.map((s) => sourceName(s?.sourceURL ?? '')))].slice(0, 6);
      return {
        t: Math.round(f.startTime),
        durationMs: Math.round(f.duration),
        scriptMs: Math.round(scriptMs),
        renderMs: Math.round(Math.max(0, f.duration - scriptMs)),
        sources,
      };
    });
}

export interface TaskLike {
  startTime: number;
  duration: number;
}

export interface EventLike {
  startTime: number;
  duration: number;
  name?: string;
  target?: { tagName?: string; className?: unknown } | null;
}

export function targetLabel(target: EventLike['target']): string {
  if (!target) return '(no-target)';
  const tag = target.tagName ?? '?';
  // 只取首个类名：标签定位够用，长类串会让摘要行爆炸
  const cls = typeof target.className === 'string' ? target.className.split(/\s+/)[0] : '';
  return cls ? `${tag}.${cls}` : tag;
}

/** 报告拼装（DOM 侧只喂原始数组，口径全部在这层钉死） */
export function buildReport(input: {
  startedAt: number;
  endedAt: number;
  frameDeltas: readonly number[];
  longTasks: readonly TaskLike[];
  events: readonly EventLike[];
  longFrames: readonly LongFrameLike[];
  blocking: { samples: number; over50: number; worstMs: number };
  bus: readonly BusEventLike[];
  hasLongAnimationFrame: boolean;
}): ProbeReport {
  const longTasks: LongTaskReading[] = [...input.longTasks]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 30)
    .map((task) => ({
      t: Math.round(task.startTime),
      durationMs: Math.round(task.duration),
      hint: hintForTask(task.startTime, task.duration, input.bus, input.startedAt),
    }));
  const eventLatency: EventLatencyReading[] = [...input.events]
    .filter((e) => e.duration > EVENT_LATENCY_MS.notable)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 30)
    .map((e) => ({
      t: Math.round(e.startTime),
      type: e.name ?? 'event',
      durationMs: Math.round(e.duration),
      target: targetLabel(e.target),
    }));
  return {
    kind: 'perf-probe',
    startedAt: input.startedAt,
    durationMs: Math.max(0, Math.round(input.endedAt - input.startedAt)),
    frames: frameStats(input.frameDeltas),
    longTasks,
    eventLatency,
    bySource: aggregateBySource(input.longFrames),
    longFrames: longFrameReadings(input.longFrames),
    blocking: input.blocking,
    capabilities: { longAnimationFrame: input.hasLongAnimationFrame },
    thresholds: { frame: FRAME_JANK_MS, event: EVENT_LATENCY_MS },
  };
}

/** 报告的一段人读摘要（CLI 打印用；判读口径随行回显） */
export function summarizeReport(r: ProbeReport): string[] {
  const lines: string[] = [];
  lines.push(
    `帧采样 ${r.frames.total} 帧（${(r.durationMs / 1000).toFixed(1)}s）：p50=${r.frames.p50}ms p95=${r.frames.p95}ms p99=${r.frames.p99}ms max=${r.frames.max}ms；` +
      `掉帧>32ms ${r.frames.over32} · 卡>50ms ${r.frames.over50} · 重卡>100ms ${r.frames.over100}`,
  );
  lines.push(
    `长任务(≥50ms) ${r.longTasks.length} 条${r.longTasks[0] ? `，最坏 ${r.longTasks[0].durationMs}ms${r.longTasks[0].hint ? `（窗口内事件：${r.longTasks[0].hint}）` : ''}` : ''}；` +
      `交互延迟>100ms ${r.eventLatency.length} 条${r.eventLatency[0] ? `，最坏 ${r.eventLatency[0].durationMs}ms @ ${r.eventLatency[0].target}` : ''}`,
  );
  if (r.bySource.length > 0) {
    lines.push(`逐源码帧耗时 Top：${r.bySource.slice(0, 5).map((s) => `${s.source} ${s.scriptMs}ms×${s.frames}帧`).join(' · ')}`);
  } else {
    lines.push(
      r.capabilities.longAnimationFrame
        ? '逐源码帧耗时：本窗口无长帧（没有 >50ms 的动画帧）'
        : '逐源码帧耗时：本运行时不支持 long-animation-frame（换新版 Chrome/Edge 可得逐文件归因）',
    );
  }
  lines.push(
    `阻塞采样：${r.blocking.samples} 样本，超 50ms ${r.blocking.over50} 次，最坏 ${r.blocking.worstMs}ms`,
  );
  return lines;
}
