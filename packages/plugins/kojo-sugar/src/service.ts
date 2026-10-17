/**
 * 语法糖转译服务实现（`sugar.transpile`）。
 *
 * 三段式（照抄规范 §5，不自由发挥）：
 * 1. 行式词法（`lexer.ts`）：物理行 → 逻辑行（折行合并）→ 行分类；
 * 2. AST（`parser.ts`）：缩进配对 → `SugarNode` 联合（含时机 / 别名 / 原生块）；
 * 3. codegen（`codegen.ts`）：AST → ERB 产物 + 行级源映射。
 *
 * **纯函数语义**（契约要求）：不读文件、不写文件、不触达工程状态。
 * `dictionary` 由调用方注入（adapter 知识），缺省时属性/裸标识符一律报
 * `unknown-identifier`（宽容但不静默）。
 */

import type {
  AliasDecl,
  ConstDecl,
  FileIO,
  KojoCounterTable,
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  KojoMutatorTable,
  Logger,
  SugarCompileOptions,
  SugarCompileResult,
  SugarCompiledBytes,
  SugarDiagnostic,
  SugarDoc,
  SugarPosition,
  SugarSaveBlockReason,
  SugarSavePlan,
  SugarSavePlanRequest,
  SugarTranspileOptions,
  SugarTranspileResult,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { fullwidthSpaceLines, isReadonlyAlias, resolveSugarTarget, SugarCompileError } from '@kojo/plugin-api';
import { buildDoc, type TopNode } from './parser';
import { codegen } from './codegen';
import { generatedPositionOf, sourceColumnOfEntry, sourceMapIndex } from './column-map';
import { sourceLineViews } from './lexer';
import { compileToBytes as runCompileToBytes, compileToFile as runCompileToFile } from './compile';
import type { AliasEntry, AliasTable, DiagnosticSink, DictionaryLookup } from './types';

/** 诊断收集器（保持插入顺序；`sortDiagnostics` 在 parse 末尾排序） */
class Sink implements DiagnosticSink {
  private readonly items: SugarDiagnostic[] = [];
  report(diag: SugarDiagnostic): void {
    this.items.push(diag);
  }
  all(): SugarDiagnostic[] {
    return this.items;
  }
}

/* ====================== 转译结果共享缓存（L2 批） ====================== */

/**
 * 缓存读数（`transpileCacheStats()`；**命中 = 一次真实被跳过的重转译**）。
 *
 * 用途：
 * - 证据面——"三消费者同一版本各转各的 3 次 → 1 次"、"保存链 planSave +
 *   重编译 2 次 → 1 次"都能用 `hits/misses` 直接断言（不依赖墙钟）；
 * - debug 水位——`log.debug` 周期行带上同一组计数（生产里可读）。
 */
export interface SugarTranspileCacheStats {
  /** 命中次数（跳过了一次真实转译） */
  readonly hits: number;
  /** 未命中次数（真实转译并写入缓存） */
  readonly misses: number;
  /** 淘汰条目数（超过条数 / 字符上限时按最近最少使用序剔除） */
  readonly evictions: number;
  /** 当前条目数 */
  readonly entries: number;
  /** 当前缓存的源文本总字符数（内存上界的可用读数） */
  readonly sourceChars: number;
}

/** 缓存容量（也可经 `CreateSugarServiceOptions.cache` 覆盖；单测用小容量验证淘汰） */
export interface SugarTranspileCacheOptions {
  /** 路径桶上限（按 `filePath` 分桶；跨项目/跨文件互不挤占）。缺省 8 */
  readonly maxBuckets?: number;
  /** 单桶条目上限（同一文件的不同文本版本）。缺省 4 */
  readonly maxEntriesPerBucket?: number;
  /** 全缓存源文本字符数上限（UTF-16 码元）。缺省 1,000,000（约 2MB 文本） */
  readonly maxSourceChars?: number;
}

const CACHE_DEFAULTS = { maxBuckets: 8, maxEntriesPerBucket: 4, maxSourceChars: 1_000_000 } as const;

interface TranspileCacheEntry {
  readonly source: string;
  readonly result: SugarTranspileResult;
}

/**
 * 转译结果 LRU（按 `filePath` 分桶，桶内按最近使用序）。
 *
 * **键为什么是 (源文本, filePath)**：转译是纯函数，输出只随这两者变化——
 * `fileName` 在 kojo-sugar 内部**从不参与产物**（只可能进诊断/命名检查，
 * 而它由 `filePath` 推导），故不入键。Generation（adapterId / 项目 / 变量字典代际）
 * **不在这里**：每个转译器服务实例自带一份缓存，插件装配层按代际 memo 转译器
 * 实例 ⇒ 换代即换实例即换缓存（见 `index.ts` 的适配器视图 memo）。
 *
 * **共享语义**：同一实例的 `transpile` 调用方（波浪线装饰器 / 糖判定面板 /
 * 预览 / 保存链）拿到的是**同一个结果对象**——它们只读（契约语义），不得就地改写。
 */
class TranspileResultCache {
  private readonly buckets = new Map<string, TranspileCacheEntry[]>(); // Map 序 = 桶的最近使用序
  private sourceChars = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly limits: Required<SugarTranspileCacheOptions>) {}

  get(source: string, filePath: string): SugarTranspileResult | undefined {
    const bucket = this.buckets.get(filePath);
    if (bucket !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i]!.source === source) {
          const entry = bucket.splice(i, 1)[0]!;
          bucket.unshift(entry); // 最近使用置前
          this.buckets.delete(filePath);
          this.buckets.set(filePath, bucket); // 桶也置最近使用位
          this.hits++;
          return entry.result;
        }
      }
    }
    this.misses++;
    return undefined;
  }

  set(source: string, filePath: string, result: SugarTranspileResult): void {
    // 超大文本不进缓存（否则单条就能挤空全表，命中率反而更差）
    if (source.length > this.limits.maxSourceChars) return;

    let bucket = this.buckets.get(filePath);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(filePath, bucket);
    }
    const existing = bucket.findIndex((e) => e.source === source);
    if (existing >= 0) {
      const old = bucket.splice(existing, 1)[0]!;
      this.sourceChars -= old.source.length;
    }
    bucket.unshift({ source, result });
    this.sourceChars += source.length;
    this.buckets.delete(filePath);
    this.buckets.set(filePath, bucket);

    while (bucket.length > this.limits.maxEntriesPerBucket) {
      this.sourceChars -= bucket.pop()!.source.length;
      this.evictions++;
    }
    while (this.buckets.size > this.limits.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value as string;
      const oldest = this.buckets.get(oldestKey)!;
      for (const e of oldest) this.sourceChars -= e.source.length;
      this.evictions += oldest.length;
      this.buckets.delete(oldestKey);
    }
    while (this.sourceChars > this.limits.maxSourceChars) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.buckets.get(oldestKey)!;
      const entry = oldest.pop();
      if (entry === undefined) {
        this.buckets.delete(oldestKey);
        continue;
      }
      this.sourceChars -= entry.source.length;
      this.evictions++;
      if (oldest.length === 0) this.buckets.delete(oldestKey);
    }
  }

  stats(): SugarTranspileCacheStats {
    let entries = 0;
    for (const bucket of this.buckets.values()) entries += bucket.length;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entries,
      sourceChars: this.sourceChars,
    };
  }
}

/** 缓存水位行的日志间隔（transpile 调用数；64 ≈ 编辑器停顿节奏下半分钟一行） */
const CACHE_LOG_EVERY = 64;

/**
 * 由 front-matter 的 `AliasDecl[]` 建别名表（只读性用契约守卫判定）。
 *
 * `consts`（7 号批）：**文件级常量**以"只读数字别名"并入同一张表——这样
 * `CFLAG:11:<常量名>`、裸 `<常量名>` 都在既有的别名替换通路（`expression.ts` 的
 * §5.0 第 1 步）里解析为数值字面量，与"产物不再发射任何声明"的宏化口径同源；
 * **不另起一层字典**（既有 FT-1 分层字典建在 adapter/项目级 `.ERH` 上，
 * 无法容纳"本 `.kojo` 尚未编译就声明的常量"）。
 * 同名时别名优先（`map.has` 守卫）——冲突已在 AST 段报 `alias-name-conflict`。
 */
function buildAliasTable(aliases: readonly AliasDecl[], consts: readonly ConstDecl[] = []): AliasTable {
  const map = new Map<string, AliasEntry>();
  for (const decl of aliases) {
    if (map.has(decl.name)) continue; // 重复已在 AST 段报诊断
    map.set(decl.name, {
      value: decl.value,
      readonly: isReadonlyAlias(decl.value),
      line: decl.loc.start.line,
    });
  }
  for (const decl of consts) {
    if (map.has(decl.name)) continue;
    map.set(decl.name, {
      value: { kind: 'number', text: decl.value },
      readonly: true,
      line: decl.loc.start.line,
    });
  }
  return map;
}

/**
 * 常量遮蔽守门（7 号批的宏化修订；只读**查字典**，零 IO）。
 *
 * 背景：常量已**不再发射** `#DIM CONST`（函数外的该声明是游戏级全局，跨文件同名 =
 * 加载期整体失败）。宏化后只剩一个残余坑——**文件内静默遮蔽**：`常量 好感度 = 5`
 * 会把本文件里所有 `好感度`（含 `CFLAG:…:好感度` 的第三段）都换成 `5`，代码照跑、
 * 语义已变。字典已知的标识符 ⇒ 拦下（复用闭集码 `alias-name-conflict`，**不新增码**）。
 *
 * 口径：`resolveFamily(name)` 即"引擎/CSV 变量名"（`source:'const'` 的 `.ERH` 具名
 * 常量不参与族归属，故只有"同时是变量名"的 `.ERH` 名会被抓到；纯编号起名式的
 * `.ERH` 常量名**不在本守门面内**——字典没有"这个名字是不是全局常量"的反查能力，
 * 那类同名会在本文件内取值一致或不一致，属作者命名口径，不在本批）。字典未注入
 * （未打开工程 / 无适配器）⇒ 一律放行，与既有"字典可选注入、不误伤"的口径一致。
 */
function guardConstShadowing(
  consts: readonly ConstDecl[],
  dictionary: DictionaryLookup | undefined,
  sink: DiagnosticSink,
): void {
  if (dictionary === undefined) return;
  for (const decl of consts) {
    if (dictionary.resolveFamily(decl.name) === undefined) continue;
    sink.report({
      code: 'alias-name-conflict',
      severity: 'error',
      message: `常量「${decl.name}」与引擎变量同名——编译期展开会把本文件里所有「${decl.name}」改写成常量值（CFLAG:…:${decl.name} 这类写法也会取到它），请改名。`,
      loc: { line: decl.loc.start.line, column: decl.loc.start.column },
    });
  }
}

/**
 * 前缀模板 → 等价的**完整命名模板**（B4-fp；纯函数）。
 *
 * 语法（零游戏知识）：占位符只认 `{n}`（角色号）/ `{name}`（作者函数名）。
 * - 已含 `{name}` → 按位置代入（作者可把名字放任意处）；
 * - **未含 `{name}`** → 视为**前缀**、末尾补 `{name}`（对齐真语料 `@K11_ZE` /
 *   `@Music_INSTRUMENT`：「前缀 + 名」形态）。
 * 非法（空模板 / 含未知占位符——剥掉 `{n}`/`{name}` 后仍残留花括号）→ `undefined`
 * （调用方据此 fail-closed：不产半成品）。
 */
function normalizeFunctionPrefix(prefix: string): string | undefined {
  if (prefix.trim().length === 0) return undefined;
  const stripped = prefix.replace(/\{n\}/g, '').replace(/\{name\}/g, '');
  if (stripped.includes('{') || stripped.includes('}')) return undefined;
  return prefix.includes('{name}') ? prefix : `${prefix}{name}`;
}

/**
 * 解出「用户函数命名」所用的分野表（B4-fp；additive）。
 *
 * - **未声明** `函数前缀:` → 原样返回（既有 adapter 模板路径逐字节不变）；
 * - 声明且合法 → 浅拷贝分野表、以作者前缀覆盖 `userFunction.template`（其余字段零改动）；
 * - 声明但非法 → 报既有码 `face-table-missing`（error，**不新增诊断码**），并**摘掉**
 *   `userFunction`——令下游 `emitFunction` 的既有守卫（`!ctx.template` → 报错 + 跳过）
 *   fail-closed，不产半成品。
 */
function resolveFaceTableForPrefix(
  faceTable: KojoFaceTable | undefined,
  prefix: string | undefined,
  prefixLoc: SugarPosition | undefined,
  sink: DiagnosticSink,
): KojoFaceTable | undefined {
  if (prefix === undefined) return faceTable;
  const template = normalizeFunctionPrefix(prefix);
  if (template === undefined) {
    sink.report({
      code: 'face-table-missing',
      severity: 'error',
      // 注意：本码也用于"适配器未声明模板"，两成因**靠文案区分**（不新增诊断码）——
      // 本处说的是"你写的那行非法"，**不提适配器**，作者据此知道该改文件头这一行。
      message: `文件头「函数前缀: ${prefix}」的命名模板非法——命名模板只认「{n}」（角色编号）与「{name}」（函数名）两个占位，且不能留空。请改文件头这一行；在改好之前，本文件的「函数」块都不会生成。`,
      loc: prefixLoc ?? null,
    });
    return { ...(faceTable ?? { faces: {} }), userFunction: undefined };
  }
  return { ...(faceTable ?? { faces: {} }), userFunction: { template } };
}

export interface CreateSugarServiceOptions {
  /** 变量字典（adapter 提供；缺省 = 无字典） */
  dictionary?: DictionaryLookup;
  /**
   * 时机分野模板表（adapter 提供；游戏知识）。
   * **缺省 = 无法生成时机函数名** —— 含 `时机` 块的文档会报 `timing-face-unknown`
   * （fail-closed；绝不回退到内建模板）。
   */
  faceTable?: KojoFaceTable;
  /**
   * 指令名表（adapter 提供；游戏知识；HK-11②）。
   * **缺省 = 无法解析中文指令名** —— `时机 指令 <中文名>：` 会报
   * `timing-instruction-unknown`（fail-closed；数字编号路径不受影响）。
   * **P-5**：`当 …： 是 <中文名>：` 的 `CASE` 值同表同码——命中查编号，
   * 查不到保留原文并报 `timing-instruction-unknown`。
   */
  instructionTable?: KojoInstructionTable;
  /**
   * 基础库 / 常用函数名表（adapter 提供；游戏知识；ZH-F1）。
   * **缺省 = 该适配器未声明** → 表达式里的中文函数名调用形态只认系统函数表，
   * 未收录的仍报 `function-name-unknown`（warning，产物原样）。
   */
  libraryTable?: KojoLibraryTable;
  /**
   * 数值增减族表（adapter 提供；游戏知识；1016 批）。
   * **缺省 = 该适配器未声明** → `增减 <族>:<对象>:<槽> <op> <增量>` 查不到族头，
   * 报既有码 `unknown-identifier`（error，fail-closed；不降糖、不产半成品）。
   */
  mutatorTable?: KojoMutatorTable;
  /**
   * 计数器值域表（adapter 提供；游戏知识；1016 批）。
   * **缺省 = 该适配器未声明** → `时机 计数器 <中文名>：` 的名换算不成编号，
   * 报 `timing-counter-unknown`（error，fail-closed；不猜编号、不产半成品）。
   * 纯数字令牌（`时机 计数器 20：`）不查表、逐字节直通。
   */
  counterTable?: KojoCounterTable;
  /**
   * 编译落盘所需的内核文件 IO（S3 批）。
   * **缺省 = 本服务不支持 `compileToFile`**（调用即抛错，绝不静默假装成功）——
   * 纯转译（`parse`/`transpile`/`sourceOf`）不需要它，故可选。
   */
  io?: FileIO;
  /** 可选日志（编译摘要 + 缓存水位行） */
  log?: Logger;
  /**
   * 转译结果共享缓存容量（additive；缺省 = 生产口径 8 桶 × 4 条 / 1M 字符）。
   * 单测用小容量验证淘汰而无需造大文本。
   */
  cache?: SugarTranspileCacheOptions;
}

/** 缓存读数访问器（返回对象上的**附加**能力；纯读数，零副作用） */
export interface SugarTranspileServiceWithCache extends SugarTranspileService {
  /** 本实例（= 一个 adapter 代际）的共享缓存读数 */
  transpileCacheStats(): SugarTranspileCacheStats;
}

/** 创建转译服务实例（纯函数；可安全并发调用） */
export function createSugarTranspileService(opts: CreateSugarServiceOptions = {}): SugarTranspileServiceWithCache {
  const dictionary = opts.dictionary;
  const faceTable = opts.faceTable;
  const instructionTable = opts.instructionTable;
  const libraryTable = opts.libraryTable;
  const mutatorTable = opts.mutatorTable;
  const counterTable = opts.counterTable;
  const cache = new TranspileResultCache({
    maxBuckets: opts.cache?.maxBuckets ?? CACHE_DEFAULTS.maxBuckets,
    maxEntriesPerBucket: opts.cache?.maxEntriesPerBucket ?? CACHE_DEFAULTS.maxEntriesPerBucket,
    maxSourceChars: opts.cache?.maxSourceChars ?? CACHE_DEFAULTS.maxSourceChars,
  });
  let callsSinceLog = 0;

  /** 缓存水位行（每 `CACHE_LOG_EVERY` 次 transpile 一行；不静默、不刷屏） */
  function maybeLogCache(): void {
    callsSinceLog++;
    if (callsSinceLog < CACHE_LOG_EVERY) return;
    callsSinceLog = 0;
    const s = cache.stats();
    opts.log?.debug(
      `sugar.transpile 缓存：命中 ${s.hits} · 未命中 ${s.misses} · 淘汰 ${s.evictions} · 条目 ${s.entries} · ${s.sourceChars} 字符`,
    );
  }


  function parse(source: string, options: SugarTranspileOptions = {}): SugarDoc {
    const sink = new Sink();
    const filePath = options.filePath ?? '';
    try {
      return buildDoc(source, filePath, sink);
    } catch (err) {
      // 转译器自身异常**绝不静默**（契约 `internal` 码）
      sink.report({
        code: 'internal',
        severity: 'error',
        message: `转译器内部错误：${err instanceof Error ? err.message : String(err)}`,
        loc: null,
      });
      return { filePath, frontMatter: { switches: [], aliases: [] }, topLevel: [], diagnostics: sink.all() };
    }
  }

  /**
   * 转译本体（不做缓存）。
   *
   * 产物只随 `(source, filePath)` 变化：`fileName` 在本包内**从不参与产物**
   * （只可能进诊断，且它本就从 `filePath` 推导），故缓存键取 `(source, filePath)`。
   */
  function transpileUncached(source: string, options: SugarTranspileOptions = {}): SugarTranspileResult {
    const sink = new Sink();
    const filePath = options.filePath ?? '';
    let doc: SugarDoc;
    try {
      doc = buildDoc(source, filePath, sink);
    } catch (err) {
      sink.report({
        code: 'internal',
        severity: 'error',
        message: `转译器内部错误：${err instanceof Error ? err.message : String(err)}`,
        loc: null,
      });
      return { erb: '', sourceMap: [], diagnostics: sink.all() };
    }

    // ---- 角色号守门（fail-closed，先于 codegen）----
    // 一切引擎函数名都带 `_K{角色号}`：缺号时 codegen 会拼出 `…_K` / `…_K_1` 这种
    // 残缺名（登记函数甚至整段静默跳过），仅靠产物层撞名检查抓不到。故在出码前
    // 只要文档里出现"需要角色号才算得出函数名"的内容，就报 error——写盘链路
    // （planSave / compileToFile）据此整体拒绝，绝不落残缺函数名。
    const charNo = doc.frontMatter.charNo?.trim();
    const needsCharNo =
      doc.topLevel.some(
        (n) => n.kind === 'timingBlock' || n.kind === 'custom-command' || n.kind === 'functionBlock',
      ) ||
      Boolean(doc.frontMatter.color) ||
      doc.frontMatter.switches.length > 0 ||
      Boolean(doc.frontMatter.family) ||
      Boolean(doc.frontMatter.displayName) ||
      Boolean(doc.frontMatter.description);
    if (needsCharNo && (charNo === undefined || charNo.length === 0)) {
      sink.report({
        code: 'missing-charno',
        severity: 'error',
        message:
          '文件头缺少 `角色:` 编号（或编号为空）——「时机」/「自定指令」/「函数」/「开关」/「口上色」等都按角色号命名函数，缺号只能拼出残缺的函数名。请在文件头第一行写 `角色: <编号>`。',
        loc: null,
      });
    }

    const consts = doc.topLevel.filter((n): n is ConstDecl => n.kind === 'constDecl');
    guardConstShadowing(consts, dictionary, sink);
    const aliases = buildAliasTable(doc.frontMatter.aliases, consts);
    // B4-fp：作者私有命名前缀（`函数前缀:`）优先于 adapter 模板；未声明 → 原表原样。
    const namedFaceTable = resolveFaceTableForPrefix(
      faceTable,
      doc.frontMatter.functionPrefix,
      doc.frontMatter.functionPrefixLoc,
      sink,
    );
    const { erb, sourceMap } = codegen(doc.topLevel as TopNode[], {
      frontMatter: doc.frontMatter,
      aliases,
      dictionary,
      faceTable: namedFaceTable,
      instructionTable,
      libraryTable,
      mutatorTable,
      counterTable,
      sink,
      options,
      // 列级映射（S6）：与源文本同一次切分出的逻辑行视图（含折行段）——
      // codegen 用它就地校验「产物这段 == 源这段」，不过校验的段一律不记。
      views: sourceLineViews(source),
    });

    // ---- 空产物守门（fail-closed）----
    // 纯文件头（或只有别名声明）的 `.kojo` 合法但**没有任何可落盘的内容**：
    // 旧行为会把它写成只有 BOM 的 `.ERB`，覆盖掉目标位置的既有产物。源文件
    // 非空却零产物 ⇒ 这是"看起来成功了、实际什么都没生成"的静默失败，必须拦下。
    // 已有 error 时不再补这一条：那些文件本就已被 fail-closed 拦下，空产物是
    // 预期结果，重复报错只会稀释真正的成因。
    const hasError = sink.all().some((d) => d.severity === 'error');
    if (
      !hasError &&
      erb.trim().length === 0 &&
      source.split('\n').some((line) => line.trim().length > 0)
    ) {
      sink.report({
        code: 'block-empty',
        severity: 'error',
        message:
          '这份源文件非空，却没有产出任何函数或正文——已拒绝生成空产物（避免用空文件覆盖既有产物）。请补上「时机」块等正文，或确认文件头声明完整。',
        loc: null,
      });
    }

    return {
      erb,
      sourceMap,
      diagnostics: sink.all(),
      ...(charNo !== undefined && charNo.length > 0 ? { charNo } : {}),
    };
  }

  /**
   * 转译（带共享缓存；L2 批）——**同实例的多个消费者（波浪线 / 糖判定面板 /
   * 预览 / 保存链）在同一 (文本, filePath) 上只做一次真实转译**。
   *
   * 结果对象被多个消费者共享 ⇒ 消费方只读（本来就只读：装饰/面板/编译都只读它）。
   * generation（adapterId / 项目 / 变量字典代际）不在键里——换代由装配层
   * 换服务实例承担（`index.ts` 的适配器视图 memo），换代即缓存整体作废。
   */
  function transpile(source: string, options: SugarTranspileOptions = {}): SugarTranspileResult {
    const filePath = options.filePath ?? '';
    const hit = cache.get(source, filePath);
    if (hit !== undefined) {
      maybeLogCache();
      return hit;
    }
    const result = transpileUncached(source, options);
    cache.set(source, filePath, result);
    maybeLogCache();
    return result;
  }

  function sourceOf(result: SugarTranspileResult, generatedLine: number): SugarPosition | null {
    // PS-8：`find` 线性扫 → 按结果记忆的 `exact` 索引（同语义：首条匹配）
    const entry = sourceMapIndex(result).exact.get(generatedLine);
    if (!entry || entry.sourceLine === null) return null;
    return { line: entry.sourceLine, column: entry.span?.start.column ?? 1 };
  }

  /** 产物列 → 源位置（S6；行级 `sourceOf` 的逐字超集，纯查询零 IO） */
  function sourceColumnOf(
    result: SugarTranspileResult,
    generatedLine: number,
    generatedColumn: number,
  ): SugarPosition | null {
    const entry = sourceMapIndex(result).exact.get(generatedLine);
    if (!entry) return null;
    return sourceColumnOfEntry(entry, generatedColumn);
  }

  /** 源位置 → 产物位置（S6 正向索引；改写区无区段可依 ⇒ null，不猜） */
  function generatedOf(result: SugarTranspileResult, source: SugarPosition): SugarPosition | null {
    return generatedPositionOf(result, source);
  }

  /**
   * 保存前置检查（S7 批；纯函数）。
   *
   * 顺序：先推目标路径（无目标即 blocked，省去一次转译），再转译取诊断，
   * 最后取全角空格告警行。`filePath` 缺省取 `sourcePath`——保证产物诊断里的
   * 文件名与目标推导同源（否则 UI 会看到两套文件名）。
   */
  function planSave(request: SugarSavePlanRequest): SugarSavePlan {
    const { source, sourcePath } = request;
    const erbPath = resolveSugarTarget(sourcePath);
    const options: SugarTranspileOptions = { filePath: sourcePath, ...(request.options ?? {}) };
    const transpileResult = transpile(source, options);
    const hasError = transpileResult.diagnostics.some((d) => d.severity === 'error');

    let blockedReason: SugarSaveBlockReason | undefined;
    if (erbPath === null) blockedReason = 'source-not-kojo';
    else if (hasError) blockedReason = 'transpile-error';

    return {
      sourcePath,
      erbPath,
      transpile: transpileResult,
      fullwidthSpaceLines: fullwidthSpaceLines(source),
      blocked: blockedReason !== undefined,
      ...(blockedReason ? { blockedReason } : {}),
    };
  }

  async function compileToFile(
    source: string,
    targetPath: string,
    options?: SugarCompileOptions,
  ): Promise<SugarCompileResult> {
    const io = opts.io;
    if (!io) {
      // 未注入内核 io 的实例不支持落盘——显式报错，绝不静默假装成功
      throw new SugarCompileError('本服务实例未注入内核文件 IO，无法编译落盘（compileToFile 不可用）', {
        targetPath,
        backupPath: null,
      });
    }
    return runCompileToFile({ io, transpile, ...(opts.log ? { log: opts.log } : {}) }, source, targetPath, options);
  }

  // 内存编译（导出 ZIP 用）：**不需要 io**，所以任何实例都可调用——包括未注入 io 的
  // 纯逻辑实例（单测、worker 侧）。守卫与编码组装与 compileToFile 走同一函数。
  function compileToBytes(
    source: string,
    options?: SugarCompileOptions,
    targetLabel?: string,
  ): SugarCompiledBytes {
    return runCompileToBytes(transpile, source, options, targetLabel);
  }

  return {
    parse,
    transpile,
    sourceOf,
    sourceColumnOf,
    generatedOf,
    compileToFile,
    compileToBytes,
    planSave,
    // 缓存读数（附加能力；契约 `SugarTranspileService` 的消费方零改动）
    transpileCacheStats: () => cache.stats(),
  };
}
