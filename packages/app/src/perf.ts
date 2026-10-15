/**
 * 宿主性能探针（2026-10-12「内核优化 L0 批」配套）。
 *
 * 目的：把"体感卡顿"换成**可复现的数字**。文档口径见
 * `docs/archive/PERF-REVIEW-2026-10-11.md` §六/§7.4 的实机测量清单。
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
 *
 * 引导四标记（L1-0，2026-10-16 首屏批）：`boot.htmlParsed` / `boot.firstPaint` /
 * `boot.welcomeInteractive` / `boot.editorInteractive`——**值为自导航起点的绝对时刻
 * （ms），不是耗时**；口径、幂等性与近似性见 `bootMark` 注释。
 */

/** 引导四标记名（口径见 `bootMark`） */
export type BootMarkName =
  | 'boot.htmlParsed'
  | 'boot.firstPaint'
  | 'boot.welcomeInteractive'
  | 'boot.editorInteractive';

/** `index.html` 内联引导脚本落下的原始标记（parse 期；`performance.now()` 绝对毫秒） */
export interface InlineBootMarks {
  /** 内联引导层标记解析到位时刻（≈引导层可见） */
  htmlParsed?: number;
  /** 首帧 rAF 回调时刻（firstPaint 的近似回退用；rAF 回调在首次绘制前触发） */
  raf1?: number;
  /** parse 期 body 计算底色（tools 断言①的样本：内联底色 == 挂载后计算底色） */
  bgAtParse?: string;
  /** t+500ms 采样（断言①备选支：『≤500ms 内 #root 非空』） */
  t500?: { at: number; rootChildren: number; bg: string; splash: boolean };
}

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

  /**
   * 记录一个**引导标记**（L1-0 首屏批的四标记）。
   *
   * 口径（与其余计时点不同，读法务必按此）：
   * - 值是**自导航起点的绝对时刻（ms）**，不是耗时——相互做差即得段：
   *   白屏段 = `boot.firstPaint` − `boot.htmlParsed`（≈0 即引导层无白屏空窗）；
   *   `boot.welcomeInteractive` / `boot.editorInteractive` 本身就等于「窗口起来后多久可用」。
   * - **幂等**：同名只记首样本（编辑器重建 / 项目重开 / effect 重跑不会把读数污染成后一次）。
   * - 样本随页面导航重置；跨运行对比看 `last`（每枚标记每次导航只一个样本）。
   * - 采集点：`htmlParsed` / `firstPaint` 由 index.html 内联脚本落盘、main.tsx 收编
   *   （firstPaint 优先 PerformancePaintTiming，缺失回退首帧 rAF → 近似）；`welcomeInteractive`
   *   在 App 内核就绪 effect（欢迎页主按钮提交后可点）；`editorInteractive` 在 EditorPane
   *   的 Monaco 实例创建处（近似：实例已挂载，尚不含"首次按键"的最坏路径）。
   */
  bootMark(name: BootMarkName, at?: number, note?: string): void {
    if (this.samples.has(name)) return;
    this.record(name, at ?? performance.now(), note);
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

/**
 * 收编 `index.html` 内联引导脚本的标记（main.tsx 在 createRoot 之前调一次）：
 * - `boot.htmlParsed` = 内联脚本执行时刻（引导层标记已进 DOM，≈可见）；
 * - `boot.firstPaint` = 浏览器首个 paint（`PerformancePaintTiming`，WebView2/Chromium 支持）；
 *   不可得时回退内联脚本记的首帧 rAF（**近似**：rAF 回调在首次绘制前触发，通常略早于真首绘）。
 *
 * ⚠ release 形态实测（2026-10-16）：入口块瘦身后 main.tsx 在**首绘之前**就执行——
 * 当场读 `getEntriesByType('paint')` 是空的、rAF 也还没轮到，若此刻放弃就永远丢这枚标记。
 * 故本条做成**迟到收编**：优先缓冲 PerformanceObserver 等首绘条目到账；等不来就
 * 退到"两帧后 performance.now()"近似。
 * 回退值的口径是**上界、不是误差有界的近似**：主线程被入口块的解析/执行堵死时，两帧本身
 * 就会排到几百毫秒之后（冷开机实测 `boot.firstPaint=487.7 > boot.welcomeInteractive=225.3`，
 * 即"提交已完成、像素还没上过屏"）。读法：拿它当"首绘不晚于此"看，别拿它减 `htmlParsed`
 * 当成白屏耗时的下界；真值优先由 `first-paint` / `first-contentful-paint` 计时条目给出。
 */
export function ingestInlineBootMarks(): void {
  const raw = (globalThis as { __kojoBootMarks?: InlineBootMarks }).__kojoBootMarks;
  if (!raw) return;
  if (typeof raw.htmlParsed === 'number') {
    perf.bootMark('boot.htmlParsed', raw.htmlParsed, '自导航起点 ms；引导层标记解析到位（≈可见）');
  }

  const paintAt = (name: string): number | undefined =>
    performance.getEntriesByType('paint').find((e) => e.name === name)?.startTime;
  const record = (at: number, how: string): void => {
    const white =
      typeof raw.htmlParsed === 'number' ? `；白屏段 Δ=${(at - raw.htmlParsed).toFixed(1)}ms` : '';
    const fcp = paintAt('first-contentful-paint');
    const contentful = fcp !== undefined ? `；首内容绘 FCP=${fcp.toFixed(1)}ms` : '';
    perf.bootMark('boot.firstPaint', at, `自导航起点 ms（${how}${white}${contentful}）`);
  };

  const fp = paintAt('first-paint');
  if (fp !== undefined) return record(fp, 'first-paint 计时');
  if (typeof raw.raf1 === 'number') return record(raw.raf1, '首帧 rAF 近似');

  // 首绘尚未发生（release 形态）：缓冲 observer 等首绘条目到账；两帧后端不出来就用帧后近似兜底。
  let recorded = false;
  const fallback = (): void => {
    if (recorded) return;
    recorded = true;
    observer?.disconnect();
    record(performance.now(), '帧后近似（首绘前收编，条目未到账）');
  };
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-paint' && !recorded) {
          recorded = true;
          observer?.disconnect();
          record(e.startTime, 'first-paint 计时');
        }
      }
    });
    observer.observe({ type: 'paint', buffered: true });
    requestAnimationFrame(() => requestAnimationFrame(fallback));
  } catch {
    requestAnimationFrame(() => requestAnimationFrame(fallback));
  }
}
