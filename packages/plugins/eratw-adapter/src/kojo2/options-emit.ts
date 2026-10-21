/**
 * eraTW 的 `选项`（2.0 待定 UI，§7.5）落点：纯函数，计划 → 产物行 / `EmitFailure`。
 *
 * 产物形状（与 v1 `emitChoiceBlock` 的按钮形同口径，沿用既有语料主流写法）：
 *
 * ```erb
 * PRINTBUTTON "标签", "1"     ← 按书写顺序；回传值由 core 计划分配
 * PRINTBUTTON "标签", "2"
 * INPUTS
 * SELECTCASE RESULTS
 *     CASE "1"
 *         …按钮正文（2.0 叙事 lower 产物，core 的 lowerItem 回调给）
 *     CASE "2"
 *         …
 * ENDSELECT
 * ```
 *
 * 数据来源（不手抄第二份词表）：
 * - 按钮指令 / 输入指令 / **输入读回槽**来自 `kojo2/presentation.ts` 的
 *   `ERATW_PRESENTATION.options`（`result`）；产物里的分派键一律读数据，不写死；
 * - `SELECTCASE` / `CASE` / `ENDSELECT` 是 Emuera **引擎块语法**（不是 eraTW 数据）；
 * - 输入指令与回传槽的配对是 Emuera 引擎约定（`INPUTS` → `RESULTS`，`INPUT` → `RESULT`），
 *   本文件只用它做**数据自洽校验**（声明与引擎约定不符 ⇒ fail-closed）；未声明的输入指令
 *   一律不猜。
 *
 * 本模块无状态、零 IO：同输入同输出；任何表达不了的输入返回 `EmitFailure`
 * （诊断命名空间 `unit/*`），**不产半成品字节**。
 */
import type {
  EmitFailure,
  EmitResult,
  KojoDiagnostic,
  KojoOptionItem,
  KojoSpan,
  OptionsPresentation,
} from '@kojo/kojo-core';
import { encodeEngineLiteral, isEmitFailure } from '@kojo/kojo-core';
import { ERATW_PRESENTATION } from './presentation.js';

/* ============================== 输入契约（core ETB 计划的结构子集） ============================== */

/**
 * core `OptionsEtbButton` 的结构子集：adapter 只读它需要的字段。
 * core 的计划对象（`OptionsEtbPlan`）可直接传入（结构化类型），不在 adapter 里复制一份类型。
 */
export interface OptionsButtonFact {
  /** 1 基书写顺序 */
  readonly order: number;
  /** 按钮回传值（字符串形态） */
  readonly value: string;
  readonly label: string;
  readonly span: KojoSpan;
}

/** core `OptionsEtbBranch` 的结构子集：`item` 是 2.0 叙事 AST，正文由 `lowerItem` 降糖 */
export interface OptionsBranchFact {
  readonly order: number;
  readonly value: string;
  readonly item: KojoOptionItem;
  readonly span: KojoSpan;
}

/** core `OptionsEtbPlan` 的结构子集（按钮顺序 / 回传值 / 分支骨架） */
export interface OptionsPlanFact {
  readonly buttons: readonly OptionsButtonFact[];
  readonly branches: readonly OptionsBranchFact[];
  readonly span: KojoSpan;
}

/** 一次 `选项` 落点请求 */
export interface EratwOptionsEmitInput {
  readonly plan: OptionsPlanFact;
  /** 该按钮正文的已降糖行（core 的 `lowerItem` 回调；顺序与计划一致） */
  readonly lowerItem: (item: KojoOptionItem, index: number) => readonly string[];
  /**
   * 演出数据；缺省读 `ERATW_PRESENTATION.options`。
   * 显式传 `null` = adapter 未声明 UI → fail-closed（测试与后续 profile 切换用）。
   */
  readonly presentation?: OptionsPresentation | null;
}

/* ============================== 常量（引擎语法，不是 eraTW 数据） ============================== */

/** adapter 的 fail-closed 诊断码（与 `kojo2/backend.ts` 同一命名空间口径） */
const BACKEND_INCOMPLETE = 'unit/backend-incomplete' as const;

/** 函数体缩进（1 级 = 4 空格；wrapper 负责外层缩进） */
const INDENT = '    ';

/** Emuera 分支骨架关键字（引擎块语法） */
const BRANCH_KEYWORDS = Object.freeze({
  selectCase: 'SELECTCASE',
  case: 'CASE',
  endSelect: 'ENDSELECT',
});

/**
 * Emuera 输入指令 → 回传槽（引擎约定）：只做**校验**，产物里的槽关键字一律取
 * `presentation.result` 数据（`INPUTS` 读回 `RESULTS`；`INPUT` 读回 `RESULT`）。
 * 其它输入指令不猜（返回 undefined → fail-closed）。
 */
const ENGINE_INPUT_SLOTS: Readonly<Record<string, string>> = Object.freeze({
  INPUTS: 'RESULTS',
  INPUT: 'RESULT',
});

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

/** 作者文本 → 引擎普通字面量（唯一编码器：core `literal.ts`；失败原样返回诊断） */
function literalOrFailure(text: string, span: KojoSpan): string | EmitFailure {
  const encoded = encodeEngineLiteral(text, { form: 'plain', span });
  if (!encoded.ok) return Object.freeze({ diagnostics: encoded.diagnostics });
  return encoded.literal;
}

/* ============================== 落点 ============================== */

/**
 * `选项` 计划 → eraTW 产物行。
 *
 * 顺序契约：先按书写顺序摆全部按钮，再一次输入，再按**同一顺序**生成 `CASE` 档位；
 * 每档正文来自 `lowerItem`（已按 2.0 叙事 lower），逐行缩进进档内，一行不丢。
 */
export function emitOptions(input: EratwOptionsEmitInput): EmitResult {
  const plan = input.plan;
  const presentation = input.presentation === undefined ? ERATW_PRESENTATION.options : input.presentation;
  if (presentation === null) {
    return incomplete(
      '当前 eraTW adapter 没有声明「选项」UI（presentation.options）：不能生成按钮落点（fail-closed，不产半成品字节）。',
      plan.span,
    );
  }

  const engineSlot = ENGINE_INPUT_SLOTS[presentation.input];
  if (engineSlot === undefined) {
    return incomplete(
      `presentation.options.input “${presentation.input}” 不是已知的引擎输入指令（INPUT / INPUTS）：不能确定按钮结果的读回槽。`,
      plan.span,
    );
  }
  if (presentation.result.length === 0) {
    return incomplete('presentation.options.result 为空：不能生成分支骨架的分派键。', plan.span);
  }
  if (presentation.result !== engineSlot) {
    return incomplete(
      `presentation.options 数据不自洽：输入指令 “${presentation.input}” 的引擎回传槽是 “${engineSlot}”，但声明了 result=“${presentation.result}”。`,
      plan.span,
    );
  }
  // 产物里的分派键只从数据来（不在 emitter 里写死 RESULTS/RESULT）
  const resultSlot = presentation.result;
  if (plan.buttons.length === 0) {
    return incomplete('`选项` 块没有任何按钮：`INPUTS` 之前至少要有一个按钮。', plan.span);
  }
  if (plan.branches.length !== plan.buttons.length) {
    return incomplete(
      `选项计划不一致：按钮 ${plan.buttons.length} 个、分支 ${plan.branches.length} 个（core 计划应一一对应）。`,
      plan.span,
    );
  }

  const lines: string[] = [];
  for (let i = 0; i < plan.buttons.length; i++) {
    const button = plan.buttons[i]!;
    const branch = plan.branches[i]!;
    if (button.order !== branch.order || button.value !== branch.value) {
      return incomplete(
        `选项计划不一致：第 ${i + 1} 个按钮（顺序 ${button.order}、值 “${button.value}”）与分支（顺序 ${branch.order}、值 “${branch.value}”）不对应。`,
        button.span,
      );
    }
    const label = literalOrFailure(button.label, button.span);
    if (isEmitFailure(label)) return label;
    const value = literalOrFailure(button.value, button.span);
    if (isEmitFailure(value)) return value;
    lines.push(`${presentation.button} ${label}, ${value}`);
  }

  lines.push(presentation.input);
  lines.push(`${BRANCH_KEYWORDS.selectCase} ${resultSlot}`);
  for (let i = 0; i < plan.branches.length; i++) {
    const branch = plan.branches[i]!;
    const value = literalOrFailure(branch.value, branch.span);
    if (isEmitFailure(value)) return value;
    lines.push(`${INDENT}${BRANCH_KEYWORDS.case} ${value}`);
    for (const line of input.lowerItem(branch.item, i)) {
      lines.push(line.length === 0 ? '' : `${INDENT}${INDENT}${line}`);
    }
  }
  lines.push(BRANCH_KEYWORDS.endSelect);
  return lines;
}
