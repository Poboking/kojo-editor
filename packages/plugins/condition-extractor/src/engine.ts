/**
 * 条件抽取引擎（游戏无关）。
 *
 * 职责：消费 erb.parser 的索引 + 控制流扫描服务 → 逐文件抽取 → 汇总 `ConditionIndex`
 * → 通知订阅者。语义标注经 `getSchemaLookup` 注入（来自当前 game.adapter 的
 * `variableSchema`；引擎不解释任何游戏常量）。
 *
 * 稳健性：
 * - 单文件读失败 → 记日志跳过（不伪造结果）；
 * - 运行结束时项目已切换 → **不提交**（拿到过期索引比拿不到更糟）；
 * - 无项目 / 无索引 → 返回空索引（形状稳定，UI 无需分支判空）。
 */

import type {
  ComputePool,
  ConditionExtractorService,
  ConditionExpr,
  ConditionIndex,
  ControlFlowStatement,
  ErbIndex,
  FunctionConditions,
  FunctionPredicates,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { extractFunctionConditions, extractFunctionPredicates, type SchemaLookup } from './extract';
import { parseExpression } from './expr';
import { mergeBuckets, planReuse, type ExtractExpect, type FileBucket, type FileStats } from './snapshot';

export interface ConditionEngineDeps {
  log: Logger;
  /** 当前打开的项目（未打开时 null） */
  getProject(): GameProject | null;
  /** 当前已构建的 ERB 索引（未就绪时 null） */
  getIndex(): ErbIndex | null;
  /** 读文件纯文本（内核 io，自动编码探测） */
  readFile(path: string): Promise<string>;
  /**
   * 批量读文件纯文本（2026-10-16 批量 IO 批；可选）。
   *
   * 提供时：`run()` 先把 pending 文件一次性批量取回（内核 `io.readTexts`——
   * 批内一趟 IPC、可命中会话缓存），抽取循环里零单文件读盘；返回数组与入参
   * 一一对应，失败位为 `null`（与 `readFile` 抛错同语义：该文件不留桶）。
   * 缺省 / 批量通道整体失败 ⇒ 逐文件 `readFile` 兜底（旧行为，语义不变）。
   */
  readFiles?(paths: readonly string[]): Promise<Array<string | null>>;
  /**
   * 控制流骨架扫描（erb.parser 服务）。
   *
   * **异步**：调用方传 `scanControlFlowOffloaded`（走并行通道）——扫描是纯文本变换、
   * 无外部依赖，是全量抽取里最贵的一段 CPU（真实语料约 40% 的 6.2 s），
   * 必须搬出主线程（2026-10-12「内核优化」批）。无通道时它自动内联。
   */
  scanControlFlow(text: string): Promise<ControlFlowStatement[]>;
  /** 当前适配器的变量语义查询（无适配器 / 无 schema 时 undefined） */
  getSchemaLookup(): SchemaLookup | undefined;
  /**
   * 结果快照端口（2026-10-12「体感丝滑」批 →「按文件增量」批；缺省 = 不缓存）。
   *
   * 全量抽取在真实语料上实测 11.3 s（瘦身编码后仍需 4 s），而它在开项目级联里是自动催动的。
   * 抽取是**逐文件**的纯函数 ⇒ 快照按文件分桶，判据分两层：全局层（项目根 / 适配器 /
   * `inputDigest` / 格式版本）与逐文件层（桶里的 mtime vs 索引的 `fileMtimes`）。
   * 作者改一个文件 ⇒ 只重算那一个，不再重算全库。
   *
   * 引擎只负责"判据齐就复用能复用的桶"；键、存储、fail-closed 由插件侧实现（见 `./snapshot.ts`）。
   * `save` 收到的是**本次实际得到的桶集合**（含复用的），判据同源，不存在
   * "抽取途中索引又变了 → 把旧结果存成新判据"的污染路径。
   */
  snapshot?: {
    /** 组装全局判据；返回 null = 判据不全 ⇒ 既不还原也不落盘 */
    expectFor(args: { project: GameProject; index: ErbIndex }): ExtractExpect | null;
    /** 取回过了全局判据的按文件桶（全局判据或结构不符 ⇒ null） */
    load(expect: ExtractExpect): Promise<Record<string, FileBucket> | null>;
    /** 落盘本次的全部桶（复用 + 新算），迭代顺序 = 本次 walk 顺序 */
    save(buckets: ReadonlyMap<string, FileBucket>, expect: ExtractExpect): void;
  };
  /**
   * 计算池（内核 `kernel.compute`，2026-10-12 内核优化批）。
   *
   * 全量抽取在真实语料上是 ~6.2 s / 49.3 万谓词的**背景 CPU 洪水**——必须分窗并发
   * 并**窗口间让出主线程**，否则"开项目后十几秒内打字卡"。
   */
  compute: ComputePool;
}

/**
 * 抽取的窗口并发度与片预算：保证窗口之间让出主线程（背景档 → 交互优先）。
 * 2026-10-16 批量 IO 批起，文本读取改为循环外的批量预取（见 `run()` 的 `readFiles` 段），
 * 这两个常数现在只约束扫描/抽取段——档位语义一字未动。
 */
const EXTRACT_CONCURRENCY = 8;
const EXTRACT_SLICE_MS = 8;

/**
 * 毫秒表针：`performance.now()` 有亚毫秒分辨率（`Date.now()` 在逐文件计时上会全读成 0），
 * 老环境/无 performance 的宿主退回 `Date.now()`。
 */
const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

function emptyIndex(projectRoot = ''): ConditionIndex {
  const now = Date.now();
  return {
    projectRoot,
    finishedAt: now,
    durationMs: 0,
    byFunction: new Map(),
    stats: { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 },
  };
}

export class ConditionEngine implements ConditionExtractorService {
  private last: ConditionIndex | null = null;
  private inFlight: Promise<ConditionIndex> | null = null;
  private readonly listeners = new Set<(index: ConditionIndex | null) => void>();
  /** 谓词明细缓存（按需解析产物；索引重建时失效——最多缓存被查看过的函数，规模可控） */
  private readonly detailCache = new Map<string, FunctionPredicates>();
  /** 明细解析的文件文本缓存（同批多个函数共享文件时避免重复读取；索引重建时失效） */
  private readonly fileTextCache = new Map<string, string>();

  constructor(private readonly deps: ConditionEngineDeps) {}

  currentIndex(): ConditionIndex | null {
    return this.last;
  }

  /**
   * 解析单个表达式文本（无状态纯函数；失败 → `opaque`）。
   *
   * 契约新增于 v0.3 批 S5，唯一使用方是 `@kojo/plugin-kojo-sugar` 的
   * `sugar.lift`（提升建议器）——它要判断 IF / SELECTCASE 的条件表达式能否被
   * 糖层原样重写。转出为服务方法（而非包导出）是为了让消费方**经服务槽**
   * 依赖，遵守"插件不得交叉 import"（解耦审计 C 项）。
   */
  parseExpression(text: string): ConditionExpr {
    return parseExpression(text);
  }

  functionConditions(normalizedName: string): FunctionConditions | undefined {
    return this.last?.byFunction.get(normalizedName);
  }

  /**
   * 按需解析单函数谓词明细（读文件 → 控制流扫描 → 逐条解析）。
   * 不入全量索引（49 万谓词常驻内存不划算）；结果缓存至下一次索引重建。
   */
  async functionPredicates(normalizedName: string): Promise<FunctionPredicates | null> {
    const key = normalizedName.toUpperCase();
    const cached = this.detailCache.get(key);
    if (cached) return cached;

    const index = this.deps.getIndex();
    if (!index) return null;
    const refs = index.byName.get(key);
    if (!refs || refs.length === 0) return null;
    const ref = refs[0]!;

    let text = this.fileTextCache.get(ref.filePath);
    if (text === undefined) {
      try {
        text = await this.deps.readFile(ref.filePath);
      } catch (err) {
        this.deps.log.warn(`Predicate detail read failed: ${ref.filePath} — ${String(err)}`);
        return null;
      }
      this.fileTextCache.set(ref.filePath, text);
    }
    let stmts: ControlFlowStatement[];
    try {
      stmts = await this.deps.scanControlFlow(text);
    } catch (err) {
      this.deps.log.warn(`Predicate detail scan failed: ${ref.filePath} — ${String(err)}`);
      return null;
    }

    // 函数区间切片（骨架按行升序；与全量抽取同一边界语义 [startLine, endLine]）
    const slice = stmts.filter((s) => s.line >= ref.startLine && s.line <= ref.endLine);
    // 明细视图同时收集本地量赋值 + 分支上下文（回放数据流资料；聚合路径不收集）
    const sourceLines = text.replace(/\r\n?/g, '\n').split('\n');
    const detail = extractFunctionPredicates(
      { normalizedName: key, filePath: ref.filePath, startLine: ref.startLine },
      slice,
      { endLine: ref.endLine, lines: sourceLines },
    );
    this.detailCache.set(key, detail);
    return detail;
  }

  subscribe(cb: (index: ConditionIndex | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.last);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb(this.last);
  }

  /** 项目关闭 / 重置：清空并通知订阅者 */
  clear(): void {
    this.last = null;
    this.detailCache.clear();
    this.fileTextCache.clear();
    this.notify();
  }

  ensureIndex(): Promise<ConditionIndex> {
    if (this.inFlight) return this.inFlight;
    const p = this.run().finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  /** 全量抽取一次（覆盖缓存并通知订阅者）；判据相符时优先还原结果快照 */
  async run(): Promise<ConditionIndex> {
    const project = this.deps.getProject();
    const index = this.deps.getIndex();
    if (!project || !index) {
      const empty = emptyIndex();
      this.last = empty;
      this.notify();
      return empty;
    }

    /**
     * 全局判据（插件组装：项目根 / 适配器 / `inputDigest`）。
     * null = 判据不全 ⇒ 不读也不写快照，保守回退全量（判据不可信的缓存比没有缓存更危险）。
     */
    const expect = this.deps.snapshot ? this.deps.snapshot.expectFor({ project, index }) : null;

    /**
     * 本次文件清单 + 逐文件 mtime/size（顺序 = 本次 walk 顺序 = 结果顺序）。
     * 索引没给 mtime 或该文件取不到 stat ⇒ null ⇒ 该文件判过期，保守重算；
     * size（additive，2026-10-16 PERF-7）与 mtime 同源，两侧都有数时逐文件判据多一层
     * "mtime 同值替换"防线（索引没提供 `fileSizes` ⇒ 退回纯 mtime 判据，见 `planReuse`）。
     */
    const files = [...index.files.entries()];
    const stamps = files.map(([path]) => ({
      path,
      mtimeMs: index.fileMtimes?.get(path) ?? null,
      size: index.fileSizes?.get(path) ?? null,
    }));
    const loadT0 = nowMs();
    const stored = this.deps.snapshot && expect ? await this.deps.snapshot.load(expect) : null;
    const plan = planReuse(stored, stamps);
    /**
     * **热载第一段**（PERF-7 两段拆分）：读快照 + 全局判据 + 逐桶校验 + 建桶壳 + 逐文件判据。
     * 与**第二段**（下面真正要用的时候还原依赖对象 / 重算 stale 文件）分开计时——
     * v5 的懒还原把第二段从"每次开项目都付"改成"谁问谁付"，没有这条读数就看不出挪到哪去了。
     * 缺快照 / 判据不全时这一段等于白跑一趟读盘，照样打点（形状本身就是要看的）。
     */
    const loadMs = nowMs() - loadT0;

    const t0 = Date.now();
    const lookup = this.deps.getSchemaLookup();
    const extractOpts = lookup ? { lookup } : {};
    const mtimeOf = new Map(stamps.map((s) => [s.path, s.mtimeMs]));
    const sizeOf = new Map(stamps.map((s) => [s.path, s.size]));
    const computed = new Map<string, FileBucket>();
    /** 只算没命中的文件（作者改 3 个文件 ⇒ 只重抽这 3 个，不是 2,285 个） */
    const pending = files.filter(([path]) => !plan.reusable.has(path));

    /**
     * 分段墙钟。⚠ **读盘/扫描/循环这三段之和会大于本轮总时长**：窗口里 8 个文件同时在读，
     * 三段是叠着计时的。所以这条读数用来**看形状**（哪一段是秒级、哪一段是百毫秒级），
     * 不能当占比读。`装载` 不在这个重叠里——它发生在分窗并发之前，是纯串行的一段。
     */
    let readMs = 0;
    let scanMs = 0;
    let extractMs = 0;
    const runT0 = nowMs();
    const offBefore = this.deps.compute.stats().offload;

    /**
     * 批量预取（2026-10-16 批量 IO 批）：pending 文件先一次性取回文本。
     * 读取挪到抽取循环之外 ⇒ 循环里只做扫描与抽取；窗口并发/片预算/背景档
     * 全部保持原样（读取本来就是"等 IPC"，不再是本段墙钟的主要形状）。
     * 批量通道失败（整体抛）⇒ 退回逐文件 readFile，不把整轮打成空转。
     */
    let batchTexts: Map<string, string> | null = null;
    {
      const readAll = this.deps.readFiles;
      const r0 = nowMs();
      if (readAll) {
        const paths = pending.map(([path]) => path);
        try {
          const fetched = await readAll(paths);
          batchTexts = new Map();
          for (let i = 0; i < paths.length; i++) {
            const t = fetched[i];
            if (typeof t === 'string') batchTexts.set(paths[i]!, t);
          }
        } catch (err) {
          batchTexts = null;
          this.deps.log.warn(`Condition extract batch read failed; falling back to per-file reads: ${String(err)}`);
        }
      }
      readMs += nowMs() - r0;
    }

    // 分窗并发 + 窗口间让路（内核计算池，background 档）：抽取是"开项目级联"的第二段，
    // 4~11 s 的 CPU 洪水不能连续占住主线程（内核优化批）
    await this.deps.compute.runSliced(
      pending,
      {
        concurrency: EXTRACT_CONCURRENCY,
        sliceMs: EXTRACT_SLICE_MS,
        priority: 'background',
        label: 'condition.extract',
      },
      async ([path, file]) => {
        let text: string;
        const r0 = nowMs();
        try {
          if (batchTexts) {
            const t = batchTexts.get(path);
            if (t === undefined) throw new Error('batch read failed for this file');
            text = t;
          } else {
            text = await this.deps.readFile(path);
          }
        } catch (err) {
          // 读失败**不留桶**：下次开项目必须重试，否则坏一次就永久缓存坏结果
          this.deps.log.warn(`Condition extract skipped (read failed): ${path} — ${String(err)}`);
          return;
        } finally {
          readMs += nowMs() - r0;
        }
        let stmts: ControlFlowStatement[];
        const s0 = nowMs();
        try {
          stmts = await this.deps.scanControlFlow(text);
        } catch (err) {
          this.deps.log.warn(`Condition extract skipped (scan failed): ${path} — ${String(err)}`);
          return;
        } finally {
          scanMs += nowMs() - s0;
        }

        const e0 = nowMs();
        const st: FileStats = { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 };
        const conds: FunctionConditions[] = [];
        // 两指针切片：stmts 与 functions 均按行号升序；stmts 为空时循环自然不执行，
        // 但仍要留一个空桶 —— 否则这个文件每次开项目都被判"没缓存"而白读白扫一遍
        let cursor = 0;
        for (const fn of file.functions) {
          while (cursor < stmts.length && stmts[cursor]!.line < fn.startLine) cursor++;
          const slice: ControlFlowStatement[] = [];
          for (let j = cursor; j < stmts.length && stmts[j]!.line <= fn.endLine; j++) {
            slice.push(stmts[j]!);
          }
          st.functions++;
          const cond = extractFunctionConditions(fn, slice, extractOpts);
          if (cond) {
            conds.push(cond);
            st.predicates += cond.predicateCount;
            st.unparsed += cond.unparsedCount;
            st.dependencies += cond.dependencies.length;
            if (cond.dependencies.length > 0) st.functionsWithDeps++;
          }
        }
        computed.set(path, { mtimeMs: mtimeOf.get(path) ?? null, size: sizeOf.get(path) ?? null, stats: st, conds });
        extractMs += nowMs() - e0;
      },
    );

    /**
     * 扫描段的**通道归属**（并行 vs 内联）：光看 `scan` 墙钟分不清"扫描本身慢"还是"根本没走 worker"，
     * 而这两条要动的东西完全不同（运输层在 §5.52 落地，回退路径至今没人实测过占比）。
     * 计数是池级累计值，取本次运行前后的**差**；同一时间窗里若别的消费方（校验段）也在 offload，
     * 差值会把它们算进来——所以这条读数是"量级尺"，不是精确归属。
     */
    const offAfter = this.deps.compute.stats().offload;
    const dispatched = offAfter.dispatched - offBefore.dispatched;
    const inline = offAfter.inline - offBefore.inline;
    const fellBack = offAfter.fellBack - offBefore.fellBack;
    this.deps.log.info(
      `  extract breakdown: 装载 ${loadMs.toFixed(0)}ms · 读盘 ${readMs.toFixed(0)}ms · 扫描 ${scanMs.toFixed(0)}ms` +
        `（worker ${dispatched} · 内联 ${inline} · 回退 ${fellBack}）· 抽取循环 ${extractMs.toFixed(0)}ms` +
        ` ｜ 处理 ${computed.size} 文件（复用 ${plan.reusable.size}）· 本轮 ${(nowMs() - runT0).toFixed(0)}ms`,
    );

    // 运行结束时项目已切换 → 不提交（避免过期结果覆盖）
    const projectAtEnd = this.deps.getProject();
    if (!projectAtEnd || projectAtEnd.rootDir !== project.rootDir) {
      this.deps.log.info('Condition extract finished after project switch; result discarded');
      return emptyIndex(project.rootDir);
    }

    // 合并：按本次 walk 顺序拼「复用的桶」与「新算的桶」——与全量重建同一份合并代码
    const order = stamps.map((s) => s.path);
    const merged = mergeBuckets(order, plan.reusable, computed);
    const result: ConditionIndex = {
      projectRoot: project.rootDir,
      finishedAt: Date.now(),
      durationMs: Date.now() - t0,
      byFunction: merged.byFunction,
      stats: merged.stats,
    };
    this.last = result;
    this.detailCache.clear(); // 索引重建 → 行号/定义可能变化，明细缓存失效
    this.fileTextCache.clear();
    this.notify();
    this.deps.log.info(
      `Condition index: ${result.stats.functions} functions scanned, ${result.stats.predicates} predicates ` +
        `(${result.stats.unparsed} unparsed), ${result.stats.functionsWithDeps} functions with deps, ` +
        `${result.stats.dependencies} dependencies in ${result.durationMs}ms` +
        `（复用 ${plan.reusable.size} / 重算 ${computed.size} 文件）`,
    );
    // 只在真重算过东西时回写：全命中再写一遍 12 MB 是纯浪费（序列化 + 磁盘）
    if (computed.size > 0 && this.deps.snapshot && expect) {
      // 保存"本次实际得到"的桶（复用 + 新算），顺序同上：
      // 途中索引换过的文件其 mtime 也是本次这份索引的 ⇒ 不会把旧结果存成新判据
      const toSave = new Map<string, FileBucket>();
      for (const path of order) {
        const b = computed.get(path) ?? plan.reusable.get(path);
        if (b) toSave.set(path, b);
      }
      this.deps.snapshot.save(toSave, expect);
    }
    return result;
  }
}
