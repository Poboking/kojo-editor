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
  CacheExpect,
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

export interface ConditionEngineDeps {
  log: Logger;
  /** 当前打开的项目（未打开时 null） */
  getProject(): GameProject | null;
  /** 当前已构建的 ERB 索引（未就绪时 null） */
  getIndex(): ErbIndex | null;
  /** 读文件纯文本（内核 io，自动编码探测） */
  readFile(path: string): Promise<string>;
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
   * 结果快照端口（2026-10-12「体感丝滑」批；缺省 = 不缓存）。
   *
   * 全量抽取在真实语料上实测 **11.3 s**，而它在开项目级联里是自动催动的。抽取是
   * 整项目粒度的纯函数：`CacheExpect`（项目根 / 适配器 / 体量指纹）没变 ⇒ 产出必相同，
   * 于是直接还原、一个字都不算。
   *
   * 引擎只负责"命中就跳过计算"；键、存储、fail-closed 判据由插件侧实现（见
   * `./snapshot.ts`）。`save` 收到的是**本次计算实际使用的判据**，因此不存在
   * "抽取途中索引又变了 → 把旧结果存成新判据"的污染路径。
   */
  snapshot?: {
    load(expect: CacheExpect): Promise<ConditionIndex | null>;
    save(index: ConditionIndex, expect: CacheExpect): void;
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
 * 抽取的窗口并发度与片预算：控制内存峰值（读一批、处理一批、释放一批），
 * 并保证窗口之间让出主线程（背景档 → 交互优先）。
 */
const EXTRACT_CONCURRENCY = 8;
const EXTRACT_SLICE_MS = 8;

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

  /**
   * 从结果快照还原（不重算）。明细缓存与文件文本缓存必须清空——
   * 它们是"上一次计算"的进程内派生态，跨项目/跨快照复用会串味。
   */
  restore(index: ConditionIndex): void {
    this.last = index;
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
     * 本次计算实际使用的判据。指纹为 null（有文件取不到 stat）⇒ 不缓存也不还原，
     * 保守回退全量（判据不可信的缓存比没有缓存更危险）。
     */
    const expect: CacheExpect | null = index.fingerprint
      ? { projectRoot: project.rootDir, adapterId: project.adapterId, fingerprint: index.fingerprint }
      : null;

    if (this.deps.snapshot && expect) {
      const cached = await this.deps.snapshot.load(expect);
      if (cached) {
        this.restore(cached);
        this.deps.log.info(
          `Condition index restored from snapshot: ${cached.stats.functions} functions scanned, ` +
            `${cached.stats.predicates} predicates (originally ${cached.durationMs}ms, load skipped all compute)`,
        );
        return cached;
      }
    }

    const t0 = Date.now();
    const lookup = this.deps.getSchemaLookup();
    const extractOpts = lookup ? { lookup } : {};

    const byFunction = new Map<string, FunctionConditions>();
    const stats = { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 };

    const entries = [...index.files.entries()];
    // 分窗并发 + 窗口间让路（内核计算池，background 档）：抽取是"开项目级联"的第二段，
    // 6.2 s 的 CPU 洪水不能连续占住主线程（内核优化批）
    await this.deps.compute.runSliced(
      entries,
      {
        concurrency: EXTRACT_CONCURRENCY,
        sliceMs: EXTRACT_SLICE_MS,
        priority: 'background',
        label: 'condition.extract',
      },
      async ([path, file]) => {
      let text: string;
      try {
        text = await this.deps.readFile(path);
      } catch (err) {
        this.deps.log.warn(`Condition extract skipped (read failed): ${path} — ${String(err)}`);
        return;
      }
      let stmts: ControlFlowStatement[];
      try {
        stmts = await this.deps.scanControlFlow(text);
      } catch (err) {
        this.deps.log.warn(`Condition extract skipped (scan failed): ${path} — ${String(err)}`);
        return;
      }
      if (stmts.length === 0) return;

      // 两指针切片：stmts 与 functions 均按行号升序
      let cursor = 0;
      for (const fn of file.functions) {
        while (cursor < stmts.length && stmts[cursor]!.line < fn.startLine) cursor++;
        const slice: ControlFlowStatement[] = [];
        for (let j = cursor; j < stmts.length && stmts[j]!.line <= fn.endLine; j++) {
          slice.push(stmts[j]!);
        }
        stats.functions++;
        const cond = extractFunctionConditions(fn, slice, extractOpts);
        if (cond) {
          byFunction.set(cond.normalizedName, cond);
          stats.predicates += cond.predicateCount;
          stats.unparsed += cond.unparsedCount;
          stats.dependencies += cond.dependencies.length;
          if (cond.dependencies.length > 0) stats.functionsWithDeps++;
        }
      }
      },
    );

    // 运行结束时项目已切换 → 不提交（避免过期结果覆盖）
    const projectAtEnd = this.deps.getProject();
    if (!projectAtEnd || projectAtEnd.rootDir !== project.rootDir) {
      this.deps.log.info('Condition extract finished after project switch; result discarded');
      return emptyIndex(project.rootDir);
    }

    const result: ConditionIndex = {
      projectRoot: project.rootDir,
      finishedAt: Date.now(),
      durationMs: Date.now() - t0,
      byFunction,
      stats,
    };
    this.last = result;
    this.detailCache.clear(); // 索引重建 → 行号/定义可能变化，明细缓存失效
    this.fileTextCache.clear();
    this.notify();
    this.deps.log.info(
      `Condition index: ${stats.functions} functions scanned, ${stats.predicates} predicates ` +
        `(${stats.unparsed} unparsed), ${stats.functionsWithDeps} functions with deps, ` +
        `${stats.dependencies} dependencies in ${result.durationMs}ms`,
    );
    if (this.deps.snapshot && expect) this.deps.snapshot.save(result, expect);
    return result;
  }
}
