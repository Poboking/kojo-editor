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
import { applySchemaLookup, extractFunctionPredicates, type SchemaLookup } from './extract';
import { parseExpression } from './expr';
import { CONDITION_EXTRACT_FILE_TASK, decodeBucket, type ExtractFileWire } from './offload';
import { mergeBuckets, planReuse, type ExtractExpect, type FileBucket } from './snapshot';

/**
 * 明细 / 正文缓存上限（2026-10-18 性能批）。
 *
 * 两条都只在**按需解析路径**（`functionPredicates`）里增长，旧形态只在全量索引重建时整体清空
 * ⇒ 判定面板走完 99,228 个函数就把「明细 + 整棵正文」各留一份常驻，其中正文是**第三份**
 * （内核 io 会话缓存已有一份、ERB 索引 walk 期间还有一份），真实语料口径 ~144 MB 级。
 *
 * 形状照 `kernel/src/io.ts:313-317`：重读=重新入队尾，超尺从队首削，尺子＝条数 + 字符数。
 * 逐出永不改变结果——明细是按 (索引位, 盘上正文) 的纯函数，重问只是重算一遍。
 */
const DETAIL_CACHE_MAX = 512;
const TEXT_CACHE_MAX_FILES = 128;
const TEXT_CACHE_MAX_CHARS = 6 * 1024 * 1024;

/** 函数体正文缓存（FIFO + 字符数上限；与 `kernel/src/io.ts` 的文本缓存同形状） */
class TextFifoCache {
  private readonly map = new Map<string, string>();
  private chars = 0;
  constructor(
    private readonly maxFiles: number,
    private readonly maxChars: number,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get totalChars(): number {
    return this.chars;
  }

  get(path: string): string | undefined {
    const v = this.map.get(path);
    if (v !== undefined) {
      this.map.delete(path); // 命中=重新入队尾
      this.map.set(path, v);
    }
    return v;
  }

  set(path: string, text: string): void {
    const prev = this.map.get(path);
    if (prev !== undefined) {
      this.map.delete(path);
      this.chars -= prev.length;
    }
    this.map.set(path, text);
    this.chars += text.length;
    while (this.map.size > this.maxFiles || this.chars > this.maxChars) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      if (evicted !== undefined) this.chars -= evicted.length;
    }
  }

  clear(): void {
    this.map.clear();
    this.chars = 0;
  }
}

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
   * **异步**：调用方传 `scanControlFlowOffloaded`（走并行通道）、无通道时自动内联。
   * 2026-10-18 PS-11 起**全量抽取主循环不再走它**——整条单文件抽取链（扫描 + 谓词抽取）
   * 已合成 `condition.extractFile` 任务搬进 worker；本依赖只剩**按需明细**
   * （`functionPredicates`：读单文件 → 扫 → 逐条解析）这条交互路径在用。
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
   * 全量抽取在真实语料上是 ~6.2 s / 49.3 万谓词的**背景 CPU 洪水**。PS-11 起这段 CPU
   * 经 `offload('condition.extractFile')` 搬上并行通道（无通道/通道失败自动内联同一份实现），
   * 池同时保留分窗 + 窗口间让路语义（"开项目后十几秒内打字卡"的两半都由它管）。
   */
  compute: ComputePool;
  /**
   * 按需明细 / 正文缓存上限（2026-10-18 性能批；可选，缺省＝上面三个常数）。
   * 给 `Infinity` = 不设限（＝本批之前的无上限形态），A/B 对照与量例用。
   */
  detailCacheCaps?: {
    maxDetails?: number;
    maxFiles?: number;
    maxChars?: number;
  };
}

/**
 * 抽取的窗口并发度与片预算：保证窗口之间让出主线程（背景档 → 交互优先）。
 * 2026-10-16 批量 IO 批起，文本读取改为循环外的批量预取（见 `run()` 的 `readFiles` 段）。
 *
 * 2026-10-18 PS-11 起，窗口内每项**只做装配**（取文本 + 组载荷 + `offload`），真正的
 * 扫描与谓词抽取在 worker 槽上跑（真实并行度 = 宿主槽数，见 `bootstrap.ts`）。这里的
 * `concurrency` 仍是窗口宽度（保住 IPC 重叠与"窗口间让路"的确定性），不承诺槽数。
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
  /**
   * 谓词明细缓存（按需解析产物；索引重建时失效 + FIFO 超尺逐出）。
   * 插入序＝FIFO 序：命中即重新入队尾，超 `maxDetails` 从队首削。
   */
  private readonly detailCache = new Map<string, FunctionPredicates>();
  private readonly detailCacheMax: number;
  /** 明细解析的文件正文缓存（同批多个函数共享文件时避免重复读取；索引重建时失效 + 上限逐出） */
  private readonly fileTextCache: TextFifoCache;
  private readonly textCacheMaxFiles: number;
  private readonly textCacheMaxChars: number;

  constructor(private readonly deps: ConditionEngineDeps) {
    this.detailCacheMax = deps.detailCacheCaps?.maxDetails ?? DETAIL_CACHE_MAX;
    this.textCacheMaxFiles = deps.detailCacheCaps?.maxFiles ?? TEXT_CACHE_MAX_FILES;
    this.textCacheMaxChars = deps.detailCacheCaps?.maxChars ?? TEXT_CACHE_MAX_CHARS;
    this.fileTextCache = new TextFifoCache(this.textCacheMaxFiles, this.textCacheMaxChars);
  }

  /** 缓存读数（上限是否真在收口；面板自证与量例用） */
  cacheStats(): {
    readonly details: number;
    readonly maxDetails: number;
    readonly textFiles: number;
    readonly textChars: number;
    readonly maxTextFiles: number;
    readonly maxTextChars: number;
  } {
    return {
      details: this.detailCache.size,
      maxDetails: this.detailCacheMax,
      textFiles: this.fileTextCache.size,
      textChars: this.fileTextCache.totalChars,
      maxTextFiles: this.textCacheMaxFiles,
      maxTextChars: this.textCacheMaxChars,
    };
  }

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
   * 不入全量索引（49 万谓词常驻内存不划算）；结果缓存至下一次索引重建，
   * 期间超出上限按 FIFO 逐出（逐出只意味着"下次重算"，不改产出）。
   */
  async functionPredicates(normalizedName: string): Promise<FunctionPredicates | null> {
    const key = normalizedName.toUpperCase();
    const cached = this.detailCache.get(key);
    if (cached) {
      this.detailCache.delete(key); // 命中=重新入队尾
      this.detailCache.set(key, cached);
      return cached;
    }

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
    while (this.detailCache.size > this.detailCacheMax) {
      const oldest = this.detailCache.keys().next().value;
      if (oldest === undefined) break;
      this.detailCache.delete(oldest); // 超尺从队首削（正文那条尺子由 TextFifoCache 自己收口）
    }
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

  /**
   * 离线抽取（additive，2026-10-19 性能批）：对传入的任意索引跑一次 `run()`，
   * 但**全部可变状态都落在子 engine 上**——父 engine 的 `last` / 订阅者 /
   * 明细与正文缓存一概不碰（消费方拿到的是独立结果，不是"替换当前索引"）。
   *
   * 实现口径：
   * - deps 沿用父 engine（log / readFile / readFiles / scanControlFlow /
   *   getSchemaLookup / compute）⇒ 批量读与 worker 分发路径和全量抽取**同一份实现**；
   * - `getIndex` 覆盖为传入索引；`getProject` 仍问当前项目（`run()` 只用它做项目
   *   切换检查与结果 `projectRoot`）；
   * - `snapshot` 置空：离线抽取**不读也不写**快照，否则工作区包结果会混进当前项目缓存。
   *
   * 空索引 / 无当前项目 ⇒ `run()` 自然返回形状稳定的空结果（不抛）。
   *
   * `texts`（additive）：路径 → 正文覆盖表。工作区 `.kojo` 的产物 ERB 从不落盘，
   * 读盘路径对它必然失败；覆盖表让批量读与逐文件兜底两条路都先查表（缺项才读盘），
   * 其余语义（mtime/size 判据、不触父状态）不变。
   */
  async extractIndex(index: ErbIndex, texts?: ReadonlyMap<string, string>): Promise<ConditionIndex> {
    const { snapshot: _snapshot, ...deps } = this.deps;
    const readFile = deps.readFile;
    const readFiles = deps.readFiles;
    const child = new ConditionEngine({
      ...deps,
      getIndex: () => index,
      getProject: () => this.deps.getProject(),
      ...(texts
        ? {
            readFile: async (path: string): Promise<string> => {
              const text = texts.get(path);
              if (text === undefined) return readFile(path);
              return text;
            },
            ...(readFiles
              ? {
                  readFiles: async (paths: readonly string[]): Promise<Array<string | null>> => {
                    const missing: string[] = [];
                    for (const path of paths) if (!texts.has(path)) missing.push(path);
                    const fetched = missing.length > 0 ? await readFiles(missing) : [];
                    const byPath = new Map<string, string | null>();
                    for (let i = 0; i < missing.length; i++) byPath.set(missing[i]!, fetched[i] ?? null);
                    return paths.map((path) => texts.get(path) ?? byPath.get(path) ?? null);
                  },
                }
              : {}),
          }
        : {}),
    });
    return child.run();
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
    const mtimeOf = new Map(stamps.map((s) => [s.path, s.mtimeMs]));
    const sizeOf = new Map(stamps.map((s) => [s.path, s.size]));
    const computed = new Map<string, FileBucket>();
    /** 只算没命中的文件（作者改 3 个文件 ⇒ 只重抽这 3 个，不是 2,285 个） */
    const pending = files.filter(([path]) => !plan.reusable.has(path));

    /**
     * 分段墙钟。⚠ 三段是叠着计时的（窗口内 8 个文件同时在跑），用来**看形状**不是算占比。
     * 2026-10-18 PS-11 起 `扫描` / `抽取循环` 两段是 **worker 回传的净 CPU**（任务内
     * `performance.now` 计时，见 `./offload.ts` 的 `ExtractFileResult`）——主线程再量
     * 只能量到通道往返，量不到"扫描本身多慢"，而读数要区分的正是这两条。无通道（内联）
     * 时同一形状照样成立（任务在本线程跑，计时含义不变）。
     */
    let readMs = 0;
    let scanMs = 0;
    let extractMs = 0;
    const runT0 = nowMs();
    const offBefore = this.deps.compute.stats().offload;

    /**
     * 批量预取（2026-10-16 批量 IO 批）：pending 文件先一次性取回文本。
     * 读取挪到抽取循环之外 ⇒ 循环里只做装配与分发；批量通道失败（整体抛）⇒ 退回
     * 逐文件 readFile，不把整轮打成空转。
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

    /**
     * 分窗并发 + 窗口间让路（内核计算池，background 档），窗口内每项把**单文件抽取整条链**
     * `offload` 出去（2026-10-18 PS-11）：扫描与谓词抽取在 worker 槽上真并行，主线程只剩
     * 文本装配与 schema 补标。`runSliced` 的 async 窗口整窗 `Promise.all` ⇒ 并行度不退化；
     * 通道失败由池自动回退本地实现（同一份任务表，产出等价），这里只兜"本地实现也抛"的
     * 理论残余（warn 跳过、不留桶——与读失败同语义面）。
     */
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

        let result: ExtractFileWire;
        try {
          result = await this.deps.compute.offload<ExtractFileWire>(CONDITION_EXTRACT_FILE_TASK, {
            path,
            text,
            mtimeMs: mtimeOf.get(path) ?? null,
            size: sizeOf.get(path) ?? null,
            functions: file.functions.map((fn) => ({
              normalizedName: fn.normalizedName,
              startLine: fn.startLine,
              endLine: fn.endLine,
            })),
          });
        } catch (err) {
          this.deps.log.warn(`Condition extract skipped (extract failed): ${path} — ${String(err)}`);
          return;
        }

        /**
         * 通道形态 → 内存桶：`JSON.parse` 就在这一步（P0-2 的 A 块，见 `./offload.ts`
         * `ExtractFileWire` 头注）。解码失败与抽取失败**同语义**：跳过不留桶——
         * 否则坏一次就永久缓存坏结果。
         */
        let bucket: FileBucket;
        try {
          bucket = decodeBucket(result);
        } catch (err) {
          this.deps.log.warn(`Condition extract skipped (decode failed): ${path} — ${String(err)}`);
          return;
        }

        // schema 语义标注（lookup 是函数、跨不过结构化克隆 ⇒ 主线程补；
        // 口径与任务内实现共用 `applySchemaLookup`，两条路不可能给出两种标注）
        if (lookup) {
          for (const cond of bucket.conds) applySchemaLookup(cond.dependencies, lookup);
        }
        computed.set(path, bucket);
        scanMs += result.scanMs;
        extractMs += result.extractMs;
      },
    );

    /**
     * 抽取段的**通道归属**（并行 vs 内联）：光看墙钟分不清"抽取本身慢"还是"根本没走 worker"，
     * 而这两条要动的东西完全不同。计数是池级累计值，取本次运行前后的**差**；同一时间窗里
     * 若别的消费方（校验段）也在 offload，差值会把它们算进来——所以这条读数是"量级尺"，
     * 不是精确归属。PS-11 起这个差值覆盖的是 `condition.extractFile` 整链（扫描 + 谓词抽取）。
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
