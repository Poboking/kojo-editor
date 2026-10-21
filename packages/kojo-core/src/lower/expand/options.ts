/**
 * `选项`（2.0 待定 UI，§7.5）的展开计划与降糖。
 *
 * 分层（与 `@随机` 同一口径）：
 * - core 只产出**结构计划**（ETB = Expanded Text Block：按钮顺序 / 回传值分配 / 一次输入 /
 *   分支骨架）；`PRINTBUTTON`、`INPUTS`、`SELECTCASE` 一类引擎关键字是 adapter 的落点事实，
 *   core 一个都不写死；
 * - 块体（每个按钮的正文）仍走 **2.0 叙事 lower**（`lowerItemBody` 回调，由调用方注入
 *   `walkNarrative`），按钮正文一行都不丢；
 * - `core/options/pending` 是码表固定的 warning：同一块只报一次（parser 已在同一行报过时
 *   不再重复刷屏）；
 * - adapter 未声明 `presentation.options`（或 backend profile 未开启）→
 *   `core/feature/unsupported` error，**fail-closed**：不调用 adapter、不产半成品字节。
 *
 * 计划是纯数据、可离线断言（迁移预览 / conformance 可直接复用），降糖只做能力闸与编排。
 */
import type { KojoOptionItem, KojoOptionsBlock, KojoSpan } from '../../ast.js';
import type { GameAdapter } from '../../adapter.js';
import type { DiagnosticSink } from '../../diagnostics.js';
import type { OptionsEmitRequest } from '../backend.js';
import type { LowerState } from '../state.js';
import { emit, lowerIntoChildLines, report } from '../state.js';

/* ============================== ETB 计划（结构事实） ============================== */

/** 一个按钮的落点事实：顺序 + 按钮文字 + 回传值（值按书写顺序分配，`1` 起） */
export interface OptionsEtbButton {
  /** 1 基书写顺序 */
  readonly order: number;
  /** 按钮回传值（字符串形态；与输入步读回的键同形） */
  readonly value: string;
  /** 按钮文字（`「标签」：` 的标签，已去掉引号；引擎字面量编码由 adapter 负责） */
  readonly label: string;
  readonly span: KojoSpan;
}

/** 一个分支的落点事实：回传值 + 该按钮的正文 AST（2.0 叙事 lower 的输入） */
export interface OptionsEtbBranch {
  readonly order: number;
  readonly value: string;
  readonly item: KojoOptionItem;
  readonly span: KojoSpan;
}

/**
 * 输入步事实：`选项` 是「先摆按钮、再读一次回传值、按值分派」的 UI。
 * core 只声明"需要一次按钮输入、分派键是按钮回传值"，读回变量名/输入指令由 adapter 定。
 */
export interface OptionsEtbInput {
  readonly kind: 'button-input';
  /** 分派键 = 按钮回传值（不是自由文本 / 不是编号输入） */
  readonly dispatch: 'button-value';
  /** 全部按钮回传值（顺序 = 书写顺序） */
  readonly values: readonly string[];
}

/**
 * `选项` 的 ETB 计划。
 *
 * `buttons` 与 `branches` 一一对应（同序、同回传值）；adapter 按 `buttons` 摆按钮，
 * 按 `branches` 生成分派骨架，并把每档正文交给 core 的 `lowerItem` 回调降糖。
 */
export interface OptionsEtbPlan {
  readonly buttons: readonly OptionsEtbButton[];
  readonly input: OptionsEtbInput;
  readonly branches: readonly OptionsEtbBranch[];
  readonly span: KojoSpan;
}

/**
 * 纯结构：把一个 `选项` 块算成 ETB 计划（不读 adapter、不发诊断）。
 *
 * 回传值按书写顺序分配为 `"1"`、`"2"`…（与 v1 `emitChoiceBlock` 的编号口径一致），
 * 按钮顺序即作者书写顺序——两件事都不交给 adapter 猜。
 */
export function planOptionsBlock(node: KojoOptionsBlock): OptionsEtbPlan {
  const buttons: OptionsEtbButton[] = [];
  const branches: OptionsEtbBranch[] = [];
  const values: string[] = [];
  for (let i = 0; i < node.items.length; i++) {
    const item = node.items[i]!;
    const order = i + 1;
    const value = String(order);
    values.push(value);
    buttons.push(Object.freeze({ order, value, label: item.label, span: item.span }));
    branches.push(Object.freeze({ order, value, item, span: item.span }));
  }
  return Object.freeze({
    buttons: Object.freeze(buttons),
    input: Object.freeze({
      kind: 'button-input' as const,
      dispatch: 'button-value' as const,
      values: Object.freeze(values),
    }),
    branches: Object.freeze(branches),
    span: node.span,
  });
}

/* ============================== 降糖（能力闸 + 编排） ============================== */

/** 展开环境：只依赖 adapter 契约里的 UI 声明（不需要整份 ExpandContext） */
export interface OptionsExpandEnv {
  readonly adapter: GameAdapter;
}

/** `core/options/pending` 的固定文案（warning 级由码表决定，调用方不改级别） */
const PENDING_MESSAGE = '`选项` 是 2.0 待定 UI：形态与 API 未来可能变化（不是旧语法例外）。迁移期请知悉；需要稳定交互时用 `@原生`。';

/** 同一块（同一源行）的 pending warning 是否已经报过（parser 阶段可能已报） */
function pendingReported(sink: DiagnosticSink, span: KojoSpan): boolean {
  for (const diagnostic of sink.all) {
    if (diagnostic.code !== 'core/options/pending') continue;
    if (diagnostic.span !== null && diagnostic.span.start.line === span.start.line) return true;
  }
  return false;
}

/**
 * `选项` 块的 2.0 展开降糖：待定 warning（只一次）→ 能力闸 → ETB 计划 → adapter 落点。
 *
 * `lowerItemBody` 必须是 2.0 叙事走法（`walkNarrative` / `lowerNarrativeNodes`）：
 * 每个按钮正文都经子缓冲降糖后交给 adapter 组装，保证"块体不丢"。
 */
export function lowerOptionsBlockExpanded(
  node: KojoOptionsBlock,
  env: OptionsExpandEnv,
  state: LowerState,
  lowerItemBody: (child: LowerState, item: KojoOptionItem) => void,
): void {
  if (!pendingReported(state.sink, node.span)) {
    report(state, 'core/options/pending', PENDING_MESSAGE, node.span);
  }

  // fail-closed：adapter 没有声明 UI 能力就不生成任何按钮/分派字节（也不吞掉 body 诊断之外的东西）。
  if (env.adapter.presentation.options === null) {
    report(
      state,
      'core/feature/unsupported',
      `当前 adapter（${env.adapter.id}）没有声明「选项」UI（presentation.options）：不能生成按钮落点（fail-closed，不产半成品字节）。`,
      node.span,
    );
    return;
  }
  if (!state.backend.profile.presentations.options) {
    report(
      state,
      'core/feature/unsupported',
      `当前 backend（${state.backend.id}）的 profile 没有开启「选项」UI（presentations.options）：不能生成按钮落点（fail-closed，不产半成品字节）。`,
      node.span,
    );
    return;
  }

  const plan = planOptionsBlock(node);
  // 单一真相：计划字段直接进 backend 契约的 additive 槽位（不再有过渡子类型）
  const request: OptionsEmitRequest = { items: node.items, span: node.span, plan };
  emit(
    state,
    state.backend.presentation.optionsBlock(request, (item) =>
      lowerIntoChildLines(state, (child) => lowerItemBody(child, item)),
    ),
    node.span,
  );
}
