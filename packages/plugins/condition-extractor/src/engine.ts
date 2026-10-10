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
  ConditionExtractorService,
  ConditionIndex,
  ControlFlowStatement,
  ErbIndex,
  FunctionConditions,
  FunctionPredicates,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { extractFunctionConditions, extractFunctionPredicates, type SchemaLookup } from './extract';

export interface ConditionEngineDeps {
  log: Logger;
  /** 当前打开的项目（未打开时 null） */
  getProject(): GameProject | null;
  /** 当前已构建的 ERB 索引（未就绪时 null） */
  getIndex(): ErbIndex | null;
  /** 读文件纯文本（内核 io，自动编码探测） */
  readFile(path: string): Promise<string>;
  /** 控制流骨架扫描（erb.parser 服务） */
  scanControlFlow(text: string): ControlFlowStatement[];
  /** 当前适配器的变量语义查询（无适配器 / 无 schema 时 undefined） */
  getSchemaLookup(): SchemaLookup | undefined;
}

/** 并发受限的批量任务（控制内存峰值：文本读一批、处理一批、释放一批） */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

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
      stmts = this.deps.scanControlFlow(text);
    } catch (err) {
      this.deps.log.warn(`Predicate detail scan failed: ${ref.filePath} — ${String(err)}`);
      return null;
    }

    // 函数区间切片（骨架按行升序；与全量抽取同一边界语义 [startLine, endLine]）
    const slice = stmts.filter((s) => s.line >= ref.startLine && s.line <= ref.endLine);
    const detail = extractFunctionPredicates(
      { normalizedName: key, filePath: ref.filePath, startLine: ref.startLine },
      slice,
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

  /** 全量抽取一次（覆盖缓存并通知订阅者） */
  async run(): Promise<ConditionIndex> {
    const project = this.deps.getProject();
    const index = this.deps.getIndex();
    if (!project || !index) {
      const empty = emptyIndex();
      this.last = empty;
      this.notify();
      return empty;
    }

    const t0 = Date.now();
    const lookup = this.deps.getSchemaLookup();
    const extractOpts = lookup ? { lookup } : {};

    const byFunction = new Map<string, FunctionConditions>();
    const stats = { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 };

    const entries = [...index.files.entries()];
    await mapLimit(entries, 8, async ([path, file]) => {
      let text: string;
      try {
        text = await this.deps.readFile(path);
      } catch (err) {
        this.deps.log.warn(`Condition extract skipped (read failed): ${path} — ${String(err)}`);
        return;
      }
      let stmts: ControlFlowStatement[];
      try {
        stmts = this.deps.scanControlFlow(text);
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
    });

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
    return result;
  }
}
