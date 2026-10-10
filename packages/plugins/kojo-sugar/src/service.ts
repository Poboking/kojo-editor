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
  SugarDiagnostic,
  SugarDoc,
  SugarPosition,
  SugarTranspileOptions,
  SugarTranspileResult,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { isReadonlyAlias } from '@kojo/plugin-api';
import { buildDoc, type TopNode } from './parser';
import { codegen } from './codegen';
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
}

/** 创建转译服务实例（纯函数；可安全并发调用） */
export function createSugarTranspileService(opts: CreateSugarServiceOptions = {}): SugarTranspileService {
  const dictionary = opts.dictionary;

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

  return { parse, transpile, sourceOf };
}
