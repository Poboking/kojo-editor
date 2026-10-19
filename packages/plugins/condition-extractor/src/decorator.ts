/**
 * 编辑器波浪线：条件表达式语法诊断（E8）。
 *
 * 只对**承载单条条件的控制流语句**跑表达式诊断（`IF` / `ELSEIF` / `SIF` /
 * `WHILE` / `SELECTCASE`），产出行级波浪线条目交给 `ui.editor.decorator` 槽。
 *
 * 口径（保守：错标比不标危险）：
 * - 排除 `CASE` / `PRINTDATA` 等——它们承载的是逗号列表 / 范围写法，表达式诊断器
 *   对其（合理地）误报，标出来的会是"假错"；
 * - `expression` 为空 / 只有空白 → 不诊断（无内容可判）；
 * - 同一行若命中多条，只留第一条（按行去重）；
 * - 文本为空 → 返回 `[]`；本函数**不得抛错**（扫描 / 诊断任一异常都当"无发现"）。
 *
 * 纯函数：文本进、装饰出，不读盘不写盘（`ui.editor.decorator` 契约）。
 */

import type { ControlFlowStatement } from '@kojo/plugin-api';
import { diagnoseExpression } from './expr';

export interface ExprSyntaxDecoration {
  line: number;
  message: string;
  code: string;
  /** 1 基起始列（UTF-16 码元；additive，缺省 = 整行） */
  startColumn?: number;
  /** 1 基结束列（半开区间；与 `startColumn` 同给同缺） */
  endColumn?: number;
}

/** 承载单条（可解析）条件的控制流语句关键字。 */
const CONDITION_KINDS: ReadonlySet<string> = new Set(['IF', 'ELSEIF', 'SIF', 'WHILE', 'SELECTCASE']);

/**
 * 在行原文里定位表达式起点（0 基）。语句形如 `IF <expression>`：跳过行首缩进与关键字后
 * 再找表达式原文（trim 过的切片一定是行内子串；找不到就放弃列号，退回整行）。
 */
function expressionStartInLine(lineText: string | undefined, expression: string): number | undefined {
  if (lineText === undefined) return undefined;
  const head = /^[\s\u3000\u00a0]*[A-Za-z_]+/.exec(lineText);
  const from = head ? head[0].length : 0;
  const at = lineText.indexOf(expression, from);
  if (at >= 0) return at;
  const loose = lineText.indexOf(expression);
  return loose >= 0 ? loose : undefined;
}

/** 单字符宽度（UTF-16 码元；代理对 = 2） */
function charWidth(text: string, at: number): number {
  const cp = text.codePointAt(at);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/** 对"承载条件的控制流语句"跑表达式诊断；返回波浪线条目（按行号升序，同一行只留第一条）。 */
export function collectExprSyntaxDecorations(
  text: string,
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): ExprSyntaxDecoration[] {
  if (text.length === 0) return [];

  let statements: readonly ControlFlowStatement[];
  try {
    statements = scanControlFlow(text);
  } catch {
    return []; // 扫描异常：按"无发现"处理（保守，绝不把异常当成一条错）
  }

  const lines = text.split(/\r\n|\r|\n/);
  // 按行去重：同一行只保留第一条命中的装饰（Map 插入序 = 语句扫描序）
  const byLine = new Map<number, ExprSyntaxDecoration>();
  for (const stmt of statements) {
    if (!CONDITION_KINDS.has(stmt.kind)) continue;
    if (stmt.expression.trim() === '') continue;
    let diag: ReturnType<typeof diagnoseExpression>;
    try {
      diag = diagnoseExpression(stmt.expression);
    } catch {
      diag = null; // 诊断器异常同样按"无发现"处理
    }
    if (diag === null) continue;
    if (byLine.has(stmt.line)) continue;
    const entry: ExprSyntaxDecoration = {
      line: stmt.line,
      message: diag.message,
      code: `erb.expr-${diag.kind}`,
    };
    // 列区间（1 基、UTF-16、半开）：定位不到字符（如 EOF 处）就不给，退回整行
    const base = expressionStartInLine(lines[stmt.line - 1], stmt.expression);
    const pos = diag.pos;
    if (base !== undefined && pos !== undefined && pos >= 0 && pos < stmt.expression.length) {
      entry.startColumn = base + pos + 1;
      entry.endColumn = entry.startColumn + charWidth(stmt.expression, pos);
    }
    byLine.set(stmt.line, entry);
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}
