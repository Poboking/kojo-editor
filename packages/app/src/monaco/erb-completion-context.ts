/**
 * T6 · `.erb` 补全的**位置门**（纯逻辑，零 Monaco 依赖）。
 *
 * 位置语义三态：
 * - `'call-target'`：`CALL` / `CALLL` / `CALLF` 语句名**之后**、同一行第一个**顶层逗号**之前
 *   （逗号 = 实参列表起点，过了逗号就是实参位，不是函数名位）⇒ 只留函数名候选；
 * - `'in-string'`：光标在字符串字面量内部（引号配平为奇；FORM 串同形）⇒ 不给代码补全；
 * - `'default'`：其余位置 ⇒ 维持现行为（六路 source 照旧）。
 *
 * 分工纪律：
 * - 逗号 / 字符串扫描**复用** `erb-completion-bits` 既有的解析件（`topLevelComma`）——
 *   位号 source 的先例件（括号配平 + 跳字符串），禁止抄第二份；
 * - 门是**过滤**不是重排：消费方（`erb-completion.ts`）在合并前按门类过滤各 source 的候选，
 *   各 source 自带的排序语义原样不动；
 * - 过滤按**候选 kind**（Function / Method）而非 source 名单——`ERB_COMPLETION_SOURCES`
 *   可扩展数组的结构不破坏（新 source 出函数名候选即自动进门）。
 */

import { topLevelComma } from './erb-completion-bits';

/** 补全位置门三态（见模块头注） */
export type ErbCompletionGate = 'call-target' | 'in-string' | 'default';

/** `CALL` 系语句（行首可选空白；`\b` 挡住 `CALLFORM` 这类长词——只认 CALL/CALLL/CALLF） */
const CALL_STMT_RE = /^[ \t]*(?:CALLL|CALLF|CALL)\b[ \t]*/i;

/**
 * 判定光标处的补全门类（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * - `CALL` 系语句后：光标在语句名之后（含紧贴语句名尾）、且在第一个顶层逗号之前（无逗号
 *   = 到行尾都是名字位）。`CALL(表达式)` 的括号形态里光标越过名字段（`(` 已出现）⇒ 不是
 *   名字段，回 `default`（括号里是表达式，不是函数名槽）。
 * - 字符串内判定先行：引号配平为奇 ⇒ `in-string`（此时不再看 CALL 前缀——字符串里没有语句）。
 */
export function erbCompletionGate(lineText: string, column: number): ErbCompletionGate {
  if (!Number.isFinite(column) || column < 1) return 'default';
  const col0 = Math.min(column - 1, lineText.length);

  // 字符串 / FORM 串内：光标前引号数为奇 ⇒ 串内（与 `findBitSlot` 同口径，不加转义猜测）
  let quotes = 0;
  for (let i = 0; i < col0; i++) {
    if (lineText[i] === '"') quotes++;
  }
  if (quotes % 2 === 1) return 'in-string';

  const m = CALL_STMT_RE.exec(lineText);
  if (m === null || col0 < m[0].length) return 'default';

  const kwEnd = m[0].length;
  // 名字段之后已出现 `(`（`CALL(...)` / `CALLF FOO(...)` 的实参括号）⇒ 光标在表达式里，
  // 不是函数名槽 ⇒ 回现行为
  const openParen = lineText.indexOf('(', kwEnd);
  if (openParen >= 0 && openParen < col0) return 'default';
  // 顶层逗号 = 实参列表起点；光标越过它 ⇒ 实参位，回现行为
  const comma = topLevelComma(lineText, kwEnd, lineText.length);
  if (comma >= 0 && col0 > comma) return 'default';
  return 'call-target';
}
