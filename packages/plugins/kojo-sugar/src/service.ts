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
  FileIO,
  KojoFaceTable,
  Logger,
  SugarCompileOptions,
  SugarCompileResult,
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
import { compileToFile as runCompileToFile } from './compile';
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

/** 由 front-matter 的 `AliasDecl[]` 建别名表（只读性用契约守卫判定） */
function buildAliasTable(aliases: readonly AliasDecl[]): AliasTable {
  const map = new Map<string, AliasEntry>();
  for (const decl of aliases) {
    if (map.has(decl.name)) continue; // 重复已在 AST 段报诊断
    map.set(decl.name, {
      value: decl.value,
      readonly: isReadonlyAlias(decl.value),
      line: decl.loc.start.line,
    });
  }
  return map;
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

    const aliases = buildAliasTable(doc.frontMatter.aliases);
    const { erb, sourceMap } = codegen(doc.topLevel as TopNode[], {
      frontMatter: doc.frontMatter,
      aliases,
      dictionary,
      faceTable,
      sink,
      options,
    });

    return { erb, sourceMap, diagnostics: sink.all() };
  }

  function sourceOf(result: SugarTranspileResult, generatedLine: number): SugarPosition | null {
    const entry = result.sourceMap.find((e) => e.generatedLine === generatedLine);
    if (!entry || entry.sourceLine === null) return null;
    return { line: entry.sourceLine, column: entry.span?.start.column ?? 1 };
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

  return { parse, transpile, sourceOf, compileToFile, planSave };
}
