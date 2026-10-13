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
}

/** 承载单条（可解析）条件的控制流语句关键字。 */
const CONDITION_KINDS: ReadonlySet<string> = new Set(['IF', 'ELSEIF', 'SIF', 'WHILE', 'SELECTCASE']);

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
    byLine.set(stmt.line, {
      line: stmt.line,
      message: diag.message,
      code: `erb.expr-${diag.kind}`,
    });
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}
