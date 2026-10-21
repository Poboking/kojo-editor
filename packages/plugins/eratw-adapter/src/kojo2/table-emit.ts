/**
 * eraTW 的 `# 表` 等值分派落点（K2-TABLE-SELECTCASE / §6.3 / §16.2 C2.5）：
 * **纯函数**，结构计划 → 产物行 / `EmitFailure`。
 *
 * 产物形状（正文来自 core 已降糖的臂行，**原样嵌入、只加缩进**）：
 *
 * ```erb
 * SELECTCASE __kojo_table_心情
 *     CASE 0
 *         __kojo_table_心情__value = "疏远"
 *     CASE 5
 *         __kojo_table_心情__value = "亲近"
 *     CASE ELSE
 *         __kojo_table_心情__value = "未知"
 * ENDSELECT
 * ```
 *
 * 分工（与 `选项` / `@巡` 同一口径）：
 * - core 的 `table-plan.ts` 只判"能不能**可证等值**"（全精确整数键、臂数 ≥ 3、判别式纯整数）；
 *   本文件只落**形状**，不重新判等值、不改档位顺序；
 * - 判别式求值（`__kojo_table_* = <表达式>`）与每档赋值行（`armLines` / `elseLines`）
 *   由 core 算好交来：adapter **不改写 / 不删除 / 不插入 / 不排序**；
 * - `否` 臂：`plan.hasDefault` 为真才出兜底档；没有 `否` 时按数据
 *   `ERATW_TABLE_DISPATCH.missingDefault` 决定"省略"或"留空档"（eraTW = 省略）。
 *
 * 引擎关键字字面量**不在本文件**：全部读 `kojo2/table-data.ts` 的
 * `ERATW_TABLE_DISPATCH`（唯一数据源；本文件是它唯一的使用方）。
 *
 * 本模块无状态、零 IO：同输入同输出；计划不自洽（臂值重复 / 非整数 / 缺判别槽 /
 * 档位与正文行数错位 / 与 `否` 事实矛盾）一律 `EmitFailure`（`unit/*` 诊断），
 * **不产半成品字节**。
 */
import type { EmitFailure, EmitResult, KojoDiagnostic, KojoSpan } from '@kojo/kojo-core';

import { ERATW_TABLE_DISPATCH } from './table-data.js';
import type { TableDispatchPresentation } from './table-data.js';

/* ============================== 输入契约（core 计划的结构子集） ============================== */

/**
 * core `TableDispatchCase` 的结构子集：adapter 只读键与 span。
 * core 的计划对象可直接传入（结构化类型），不在 adapter 里复制一份 plan 类型。
 */
export interface TableDispatchCaseFact {
  /** 等值键（core 已静态求值；这里仍按 fail-closed 再验一次安全整数） */
  readonly value: number;
  readonly span: KojoSpan;
}

/**
 * core `TableDispatchPlan` 的结构子集（`cases` 顺序 = 源书写顺序）。
 *
 * `style` 收三态是为了让"传错计划"可测：只有 `selectcase` 能落等值分派，
 * `if-chain` / `error` 传进来一律 fail-closed（不猜、不硬转）。
 */
export interface TableDispatchPlanFact {
  readonly style: 'selectcase' | 'if-chain' | 'error';
  readonly cases: readonly TableDispatchCaseFact[];
  readonly hasDefault: boolean;
  readonly span: KojoSpan;
}

/** 一次等值分派落点请求 */
export interface EratwTableEmitInput {
  readonly plan: TableDispatchPlanFact;
  /** 判别值隐藏槽（只求值一次；core 已发过求值行） */
  readonly subjectSlot: string;
  /** 分档结果隐藏槽（臂正文里已在用；这里只做契约自洽校验） */
  readonly valueSlot: string;
  /** 每档正文（已降糖、无缩进；`armLines[i]` ↔ `plan.cases[i]`） */
  readonly armLines: readonly (readonly string[])[];
  /** `否` 臂正文（已降糖、无缩进；没有 `否` 时为空数组） */
  readonly elseLines: readonly string[];
  /**
   * 块形状数据；缺省读 `ERATW_TABLE_DISPATCH`。
   * 显式传 `null` = adapter 未声明该落点 → fail-closed（测试与后续 profile 切换用）。
   */
  readonly presentation?: TableDispatchPresentation | null;
}

/* ============================== 常量 ============================== */

/** adapter 的 fail-closed 诊断码（与 `kojo2/backend.ts` / `options-emit.ts` 同一命名空间口径） */
const BACKEND_INCOMPLETE = 'unit/backend-incomplete' as const;

/* ============================== 小工具 ============================== */

function incomplete(message: string, span: KojoSpan): EmitFailure {
  const diagnostic: KojoDiagnostic = Object.freeze({
    code: BACKEND_INCOMPLETE,
    severity: 'error',
    message,
    span,
  });
  return Object.freeze({ diagnostics: Object.freeze([diagnostic]) });
}

/** 把已降糖行缩进成档内正文（空行保持空行，不加尾随空白） */
function pushBody(lines: string[], body: readonly string[], presentation: TableDispatchPresentation): void {
  for (const line of body) {
    lines.push(line.length === 0 ? '' : `${presentation.indent}${presentation.indent}${line}`);
  }
}

/* ============================== 落点 ============================== */

/**
 * 等值分派计划 → eraTW 产物行。
 *
 * 顺序契约：块头（判别槽）→ 按**源书写顺序**逐档（档头 + 正文）→ 兜底档（有 `否` 才出）
 * → 块尾。档数 = `plan.cases.length` = `armLines.length`，一行不丢、一档不并。
 */
export function emitTableDispatch(input: EratwTableEmitInput): EmitResult {
  const presentation = input.presentation === undefined ? ERATW_TABLE_DISPATCH : input.presentation;
  const plan = input.plan;
  if (presentation === null) {
    return incomplete(
      '当前 eraTW adapter 没有声明 `# 表` 等值分派落点（table dispatch data）：不能生成分派块（fail-closed，不产半成品字节）。',
      plan.span,
    );
  }
  if (presentation.selectCase.length === 0 || presentation.case.length === 0 || presentation.endSelect.length === 0) {
    return incomplete('等值分派数据不完整（块头/档头/块尾为空）：不能生成分派块。', plan.span);
  }

  const subject = input.subjectSlot.trim();
  if (subject.length === 0) {
    return incomplete('等值分派缺少判别槽（`subjectSlot` 为空）：源表达式没法只求值一次。', plan.span);
  }
  if (input.valueSlot.trim().length === 0) {
    return incomplete('等值分派缺少值槽（`valueSlot` 为空）：各档的赋值行指向哪里不明确。', plan.span);
  }
  if (plan.style !== 'selectcase') {
    return incomplete(
      `计划 style=“${plan.style}” 不是可证等值（selectcase）：不能落等值分派（core 应退回 IF 链）。`,
      plan.span,
    );
  }
  if (plan.cases.length === 0) {
    return incomplete('计划没有任何等值臂：不生成空分派块。', plan.span);
  }
  if (input.armLines.length !== plan.cases.length) {
    return incomplete(
      `计划不自洽：等值臂 ${plan.cases.length} 个、正文 ${input.armLines.length} 组（应一一对应）。`,
      plan.span,
    );
  }
  if (!plan.hasDefault && input.elseLines.length > 0) {
    return incomplete(
      '计划没有 `否` 臂，却给了兜底正文：会生成来源不明的兜底档（计划不自洽）。',
      plan.span,
    );
  }

  const seen = new Set<number>();
  for (const item of plan.cases) {
    if (!Number.isSafeInteger(item.value)) {
      return incomplete(`等值键 ${String(item.value)} 不是安全整数：不能落等值档。`, item.span);
    }
    if (seen.has(item.value)) {
      return incomplete(
        `等值键 ${item.value} 重复出现：两档同值不可区分，会静默取第一个（计划不自洽）。`,
        item.span,
      );
    }
    seen.add(item.value);
  }

  const lines: string[] = [`${presentation.selectCase} ${subject}`];
  for (let i = 0; i < plan.cases.length; i++) {
    const item = plan.cases[i]!;
    lines.push(`${presentation.indent}${presentation.case} ${String(item.value)}`);
    pushBody(lines, input.armLines[i]!, presentation);
  }
  if (plan.hasDefault) {
    lines.push(`${presentation.indent}${presentation.caseElse}`);
    pushBody(lines, input.elseLines, presentation);
  } else if (presentation.missingDefault === 'empty') {
    // 显式留位（数据选择）：空兜底档，正文由作者/工具后补
    lines.push(`${presentation.indent}${presentation.caseElse}`);
  }
  lines.push(presentation.endSelect);
  return lines;
}
