/**
 * eraTW 的 `# 池` 等值分派落点（K2-POOL-SELECTCASE / §7.1 / §16.2 C2.6）：
 * **纯函数**，结构计划 → 产物行 / `EmitFailure`。
 *
 * 产物形状（分支正文来自 core 已降糖的行，**原样嵌入、只加缩进**）：
 *
 * ```erb
 * __kojo_pool_等级问候 = 好感      ← core 在请求之前发（只求值一次）
 * SELECTCASE __kojo_pool_等级问候
 *     CASE 0
 *         PRINTFORMW ……嗯。
 *     CASE 1
 *         PRINTFORMW 早上好。
 *     CASE ELSE
 *         PRINTFORMW ……？
 * ENDSELECT
 * ```
 *
 * 分工（与 `选项` / `# 对照表` / `@巡` 同一口径）：
 * - core 的 `pool-plan.ts` 只判"能不能**可证等值**"（同一主语 + 整数等值、分支数 ≥ 3、
 *   `? 否` 必填）；本文件只落**形状**，不重新判等值、不改档位顺序；
 * - 主语求值（`subjectSlot = <主语>`）由 core 在请求之前发完：adapter 不重复求值；
 * - 每档正文（`caseLines`）与 `? 否` 正文（`elseLines`）由 core 在子缓冲里降糖：
 *   adapter **不改写 / 不删除 / 不插入 / 不排序**；
 * - 块关键字与缩进**不在本文件**：全部读 `kojo2/presentation.ts` 的
 *   `ERATW_POOL_DISPATCH`（唯一数据源；本文件是它唯一的使用方）。
 *
 * 本模块无状态、零 IO：同输入同输出；计划不自洽（`style` 不是 selectcase / 缺主语 /
 * 档数 < 2 / 档位与正文错位 / 等值键重复 / `? 否` 正文为空 / 数据关键字缺失）
 * 一律 `EmitFailure`（`unit/*` 诊断），**不产半成品字节**。
 */
import type { EmitFailure, EmitResult, KojoDiagnostic, KojoSpan } from '@kojo/kojo-core';

import { ERATW_POOL_DISPATCH } from './presentation.js';
import type { PoolDispatchPresentation } from './presentation.js';

/* ============================== 输入契约（core 计划的结构子集） ============================== */

/**
 * core `PoolDispatchCase` 的结构子集：adapter 只读键、源下标与 span。
 * core 的计划对象可直接传入（结构化类型），不在 adapter 里复制一份 plan 类型。
 */
export interface PoolDispatchCaseFact {
  /** 等值键（core 已静态解析；这里仍按 fail-closed 再验一次安全整数） */
  readonly value: number;
  /** 源 `pool.branches` 下标（诊断指回原分支） */
  readonly branchIndex: number;
  readonly span: KojoSpan;
}

/**
 * core `PoolDispatchPlan` 的结构子集（`cases` 顺序 = 源书写顺序）。
 *
 * `style` 收三态是为了让"传错计划"可测：只有 `selectcase` 能落等值分派，
 * `if-chain` / `error` 传进来一律 fail-closed（不猜、不硬转）。
 */
export interface PoolDispatchPlanFact {
  readonly style: 'selectcase' | 'if-chain' | 'error';
  readonly cases: readonly PoolDispatchCaseFact[];
  readonly hasDefault: boolean;
  /** 同一主语（core 可证等值时必非 null；adapter 不信"没有主语的分派"） */
  readonly subject: { readonly text: string; readonly span: KojoSpan } | null;
  /** core 的判定理由（可选；失败消息里带上，便于定位"为什么不可证"） */
  readonly reason?: string;
  readonly span: KojoSpan;
}

/** 一次池等值分派落点请求（与 core `PoolDispatchEmitRequest` 结构兼容） */
export interface EratwPoolDispatchEmitInput {
  readonly plan: PoolDispatchPlanFact;
  /** 主语隐藏槽（只求值一次；core 已发过求值行） */
  readonly subjectSlot: string;
  /** 每档正文（已降糖、无缩进；`caseLines[i]` ↔ `plan.cases[i]`） */
  readonly caseLines: readonly (readonly string[])[];
  /** `? 否` 分支正文（已降糖、无缩进；池的 `? 否` 必填，恒非空） */
  readonly elseLines: readonly string[];
  /**
   * 块形状数据；缺省读 `ERATW_POOL_DISPATCH`。
   * 显式传 `null` = adapter 未声明该落点 → fail-closed（测试与后续 profile 切换用）。
   */
  readonly presentation?: PoolDispatchPresentation | null;
}

/* ============================== 常量 ============================== */

/** adapter 的 fail-closed 诊断码（与 `kojo2/backend.ts` / `options-emit.ts` 同一命名空间口径） */
const BACKEND_INCOMPLETE = 'unit/backend-incomplete' as const;

/** 等值分派至少两档（core 的 `分支数 ≥ 3` 含 `? 否`；adapter 再验一次自己这一侧的契约） */
const MIN_CASES = 2;

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
function pushBody(lines: string[], body: readonly string[], indent: string): void {
  for (const line of body) {
    lines.push(line.length === 0 ? '' : `${indent}${indent}${line}`);
  }
}

/** 档内正文必须至少有一行非空产物（`? 否` / 普通分支都要求可打印） */
function hasPrintableLine(body: readonly string[]): boolean {
  return body.some((line) => line.trim().length > 0);
}

/* ============================== 落点 ============================== */

/**
 * 池等值分派计划 → eraTW 产物行。
 *
 * 顺序契约：块头（主语槽）→ 按**源书写顺序**逐档（档头 + 正文）→ `CASE ELSE` + 兜底正文
 * → 块尾。档数 = `plan.cases.length` = `caseLines.length`，一行不丢、一档不并。
 */
export function emitPoolDispatch(input: EratwPoolDispatchEmitInput): EmitResult {
  const presentation = input.presentation === undefined ? ERATW_POOL_DISPATCH : input.presentation;
  const plan = input.plan;
  if (presentation === null) {
    return incomplete(
      '当前 eraTW adapter 没有声明 `# 池` 等值分派落点（pool dispatch data）：不能生成分派块（fail-closed，不产半成品字节）。',
      plan.span,
    );
  }
  if (
    presentation.selectCase.length === 0 ||
    presentation.case.length === 0 ||
    presentation.caseElse.length === 0 ||
    presentation.endSelect.length === 0
  ) {
    return incomplete('等值分派数据不完整（块头/档头/兜底/块尾为空）：不能生成分派块。', plan.span);
  }

  if (plan.style !== 'selectcase') {
    const reason = plan.reason === undefined || plan.reason.length === 0 ? '' : `（core：${plan.reason}）`;
    return incomplete(
      `计划 style=“${plan.style}” 不是可证等值（selectcase）：不能落等值分派${reason}；core 应退回 IF 链。`,
      plan.span,
    );
  }

  const subjectSlot = input.subjectSlot.trim();
  if (subjectSlot.length === 0 || /\s/.test(subjectSlot)) {
    return incomplete('等值分派缺少合法的主语槽（`subjectSlot` 为空或含空白）：源表达式没法只求值一次。', plan.span);
  }
  if (plan.subject === null || plan.subject.text.trim().length === 0) {
    return incomplete('计划没有主语（`subject` 为空）：不能生成无主分派块（计划不自洽）。', plan.span);
  }
  if (!plan.hasDefault) {
    return incomplete('计划没有 `? 否` 兜底分支：池必须写兜底（§7.1），不生成无兜底的分派块。', plan.span);
  }
  if (plan.cases.length < MIN_CASES) {
    return incomplete(`计划只有 ${plan.cases.length} 个等值档（< ${MIN_CASES}）：不生成等值分派块。`, plan.span);
  }
  if (input.caseLines.length !== plan.cases.length) {
    return incomplete(
      `计划不自洽：等值档 ${plan.cases.length} 个、正文 ${input.caseLines.length} 组（应一一对应）。`,
      plan.span,
    );
  }
  if (!hasPrintableLine(input.elseLines)) {
    return incomplete('计划不自洽：`? 否` 的正文为空（池兜底必须可打印，§7.1）。', plan.span);
  }

  const seen = new Set<number>();
  for (let i = 0; i < plan.cases.length; i++) {
    const item = plan.cases[i]!;
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
    if (!hasPrintableLine(input.caseLines[i]!)) {
      return incomplete(
        `第 ${i + 1} 档的正文为空（池分支必须可打印，§7.1）：不生成空档。`,
        item.span,
      );
    }
  }

  const lines: string[] = [`${presentation.selectCase} ${subjectSlot}`];
  for (let i = 0; i < plan.cases.length; i++) {
    const item = plan.cases[i]!;
    lines.push(`${presentation.indent}${presentation.case} ${String(item.value)}`);
    pushBody(lines, input.caseLines[i]!, presentation.indent);
  }
  lines.push(`${presentation.indent}${presentation.caseElse}`);
  pushBody(lines, input.elseLines, presentation.indent);
  lines.push(presentation.endSelect);
  return lines;
}
