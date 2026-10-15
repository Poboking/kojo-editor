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
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
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
import { generatedPositionOf, sourceColumnOfEntry } from './column-map';
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

/**
 * 由 front-matter 的 `AliasDecl[]` 建别名表（只读性用契约守卫判定）。
 *
 * `consts`（7 号批）：**文件级常量**以"只读数字别名"并入同一张表——这样
 * `CFLAG:11:<常量名>`、裸 `<常量名>` 都在既有的别名替换通路（`expression.ts` 的
 * §5.0 第 1 步）里解析为数值字面量，与 `常量 → #DIM CONST` 的产物同源；
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
  sink: DiagnosticSink,
): KojoFaceTable | undefined {
  if (prefix === undefined) return faceTable;
  const template = normalizeFunctionPrefix(prefix);
  if (template === undefined) {
    sink.report({
      code: 'face-table-missing',
      severity: 'error',
      message: `文件头「函数前缀: ${prefix}」的命名模板非法（只认「{n}」角色号与「{name}」函数名占位、且不能是空模板）——已停止编译本文件的「函数」块（不产半成品）。`,
      loc: null,
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
   * 编译落盘所需的内核文件 IO（S3 批）。
   * **缺省 = 本服务不支持 `compileToFile`**（调用即抛错，绝不静默假装成功）——
   * 纯转译（`parse`/`transpile`/`sourceOf`）不需要它，故可选。
   */
  io?: FileIO;
  /** 可选日志（编译摘要） */
  log?: Logger;
}

/** 创建转译服务实例（纯函数；可安全并发调用） */
export function createSugarTranspileService(opts: CreateSugarServiceOptions = {}): SugarTranspileService {
  const dictionary = opts.dictionary;
  const faceTable = opts.faceTable;
  const instructionTable = opts.instructionTable;
  const libraryTable = opts.libraryTable;

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

  function transpile(source: string, options: SugarTranspileOptions = {}): SugarTranspileResult {
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

    const consts = doc.topLevel.filter((n): n is ConstDecl => n.kind === 'constDecl');
    const aliases = buildAliasTable(doc.frontMatter.aliases, consts);
    // B4-fp：作者私有命名前缀（`函数前缀:`）优先于 adapter 模板；未声明 → 原表原样。
    const namedFaceTable = resolveFaceTableForPrefix(faceTable, doc.frontMatter.functionPrefix, sink);
    const { erb, sourceMap } = codegen(doc.topLevel as TopNode[], {
      frontMatter: doc.frontMatter,
      aliases,
      dictionary,
      faceTable: namedFaceTable,
      instructionTable,
      libraryTable,
      sink,
      options,
      // 列级映射（S6）：与源文本同一次切分出的逻辑行视图（含折行段）——
      // codegen 用它就地校验「产物这段 == 源这段」，不过校验的段一律不记。
      views: sourceLineViews(source),
    });

    return { erb, sourceMap, diagnostics: sink.all() };
  }

  function sourceOf(result: SugarTranspileResult, generatedLine: number): SugarPosition | null {
    const entry = result.sourceMap.find((e) => e.generatedLine === generatedLine);
    if (!entry || entry.sourceLine === null) return null;
    return { line: entry.sourceLine, column: entry.span?.start.column ?? 1 };
  }

  /** 产物列 → 源位置（S6；行级 `sourceOf` 的逐字超集，纯查询零 IO） */
  function sourceColumnOf(
    result: SugarTranspileResult,
    generatedLine: number,
    generatedColumn: number,
  ): SugarPosition | null {
    const entry = result.sourceMap.find((e) => e.generatedLine === generatedLine);
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

  return { parse, transpile, sourceOf, sourceColumnOf, generatedOf, compileToFile, compileToBytes, planSave };
}
