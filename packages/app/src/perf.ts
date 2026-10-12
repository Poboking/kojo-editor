/**
 * 宿主性能探针（2026-10-12「内核优化 L0 批」配套）。
 *
 * 目的：把"体感卡顿"换成**可复现的数字**。文档口径见
 * `docs/PERF-REVIEW-2026-10-11.md` §六/§7.4 的实机测量清单。
 *
 * 设计原则：
 * - **常驻但极轻**：只做 `Map<string, number[]>` 的 push（环形截断），
 *   不做聚合、不打日志——汇总按需触发，不干扰被测对象；
 * - **零依赖**：不 import 任何包，可在宿主任意层使用（编辑器 / 引导层）；
 * - **不静默**：探针就绪时打印一行用法提示，避免"加了埋点却没人知道"。
 *
 * 用法（真实终端 `pnpm tauri dev` → F12 打开 DevTools Console）：
 * ```
 * __kojoPerf.summary()            // 全部计时点的 count/last/avg/p95/max 表
 * __kojoPerf.detail('markers.total')  // 单点全部样本（按序）
 * __kojoPerf.reset()              // 清空全部（重测用）
 * ```
 */

/** 单个计时点的汇总（`summary()` 的行） */
export interface PerfStat {
  name: string;
  count: number;
  last: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
  /** 最近一次记录的附注（如"6080 行 / 1436 KB"），无则空串 */
  note: string;
}

/** 每个计时点保留的样本上限（环形截断，防长会话无限增长） */
const MAX_SAMPLES = 500;

export class PerfProbe {
  private readonly samples = new Map<string, number[]>();
  private readonly notes = new Map<string, string>();

  /** 记录一次耗时样本（毫秒） */
  record(name: string, ms: number, note?: string): void {
    let arr = this.samples.get(name);
    if (!arr) {
      arr = [];
      this.samples.set(name, arr);
    }
    arr.push(ms);
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
    if (note !== undefined) this.notes.set(name, note);
  }

  /** 包住一段**同步**代码并记录其耗时（异常照常上抛，耗时仍记录） */
  time<T>(name: string, fn: () => T, note?: string): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.record(name, performance.now() - t0, note);
    }
  }

  /**
   * 取一个手动打点器（适合跨 await 的异步段）：
   * `const stop = perf.start('switch.readText'); await ...; stop();`
   *
   * 打点器**幂等**：重复调用只记录一次（便于在正常路径与 catch 路径各写一次
   * `stop()` 而不产生重复样本）。
   */
  start(name: string, note?: string): () => number {
    const t0 = performance.now();
    let done = false;
    return () => {
      const d = performance.now() - t0;
      if (!done) {
        done = true;
        this.record(name, d, note);
      }
      return d;
    };
  }

  /** 给某个计时点补一条附注（不影响样本） */
  note(name: string, note: string): void {
    this.notes.set(name, note);
  }

  /** 汇总（按名称字典序；无样本的点不出现在结果里） */
  stats(): PerfStat[] {
    const out: PerfStat[] = [];
    for (const [name, arr] of this.samples) {
      if (arr.length === 0) continue;
      const sorted = [...arr].sort((a, b) => a - b);
      const sum = arr.reduce((s, v) => s + v, 0);
      const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
      out.push({
        name,
        count: arr.length,
        last: arr[arr.length - 1]!,
        avg: sum / arr.length,
        p50: pick(0.5),
        p95: pick(0.95),
        max: sorted[sorted.length - 1]!,
        note: this.notes.get(name) ?? '',
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** 打印汇总表（数值保留 1 位小数） */
  summary(): PerfStat[] {
    const stats = this.stats();
    const rows = stats.map((s) => ({
      计时点: s.name,
      count: s.count,
      last: Number(s.last.toFixed(1)),
      avg: Number(s.avg.toFixed(1)),
      p50: Number(s.p50.toFixed(1)),
      p95: Number(s.p95.toFixed(1)),
      max: Number(s.max.toFixed(1)),
      附注: s.note,
    }));
    // eslint-disable-next-line no-console
    console.table(rows);
    return stats;
  }

  /** 打印单个计时点的全部样本（按记录顺序） */
  detail(name: string): number[] {
    const arr = this.samples.get(name) ?? [];
    // eslint-disable-next-line no-console
    console.log(`[perf] ${name} ×${arr.length}`, arr.map((v) => Number(v.toFixed(1))));
    return arr;
  }

  /** 清空（传 name 只清该点） */
  reset(name?: string): void {
    if (name === undefined) {
      this.samples.clear();
      this.notes.clear();
      return;
    }
    this.samples.delete(name);
    this.notes.delete(name);
  }

  /** 挂到 `globalThis.__kojoPerf` 并提示用法（引导层调用一次） */
  install(): void {
    (globalThis as unknown as { __kojoPerf?: PerfProbe }).__kojoPerf = this;
    // eslint-disable-next-line no-console
    console.info(
      '[perf] 性能探针就绪：__kojoPerf.summary() 打印汇总 / __kojoPerf.detail(name) 看单点 / __kojoPerf.reset() 清空',
    );
  }
}

/** 宿主全局单例（编辑器与引导层共用） */
export const perf = new PerfProbe();
