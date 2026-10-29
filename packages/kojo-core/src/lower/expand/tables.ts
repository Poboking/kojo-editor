/**
 * `# 对照表` 引用点展开（§6.3）：隐藏槽 + 分支链，**源表达式只求值一次**。
 *
 * 保守口径（本批可证解）：
 * - 用已有 backend 的 `program.assign` + `control.if/elseIf/else/endif` 发**完整 IF 链**；
 *   `plan.landing === 'selectcase'` 只是计划建议（adapter 若提供 SELECTCASE 钩子可后续优化），
 *   语义与 SELECTCASE 等价（静态非重叠 + 必有 `否`），不改变求值次数/顺序；
 *   K2-TABLE-SELECTCASE 起：可证等值（`table-plan.ts` 判据）且 adapter 实现了
 *   `program.tableDispatch` 时改发**结构请求**（等值分派落点由 adapter 定）；
 *   其余情况（不可证 / 无该能力）仍走这条 IF 链，产物逐字节不变；
 * - 隐藏槽两名：`__kojo_table_<名>`（判别值，只求值一次）与 `__kojo_table_<名>__value`
 *   （分档结果）；都属 `__kojo_` 保留前缀，作者不可声明；
 * - 值的 `KojoExprText` 由 core 从静态字面量构造（字符串按 Kojo 双引号规则转义），
 *   交给 adapter 的表达式管线落地；
 * - 表可以引用别的表：`依据` 表达式里的表名先按依赖顺序求值（栈检测环 → `core/table/cycle`）；
 * - 校验诊断（重叠/缺否/类型…）每张表只报一次（plan 缓存），引用两次不会刷屏。
 */
import type { KojoExprText, KojoSpan, KojoTableDecl } from '../../ast.js';
import { validateTable } from '../../table.js';
import type { TableLoweringPlan, TablePlanRow } from '../../table.js';
import { isEmitFailure } from '../backend.js';
import type { EmitResult } from '../backend.js';
import type { LowerState } from '../state.js';
import { emit } from '../state.js';
import { literalToExpr, rewriteExpr, scanIdentifiers } from './expr.js';
import type { NameNeighbors } from './expr.js';
import { recordSlot, reportAt } from './context.js';
import type { ExpandContext } from './context.js';
import { foreachSlotInScope } from './context.js';
import { planTableDispatch, tableDispatchOf } from './table-plan.js';
import type { TableDispatchEmitRequest, TableDispatchPlan } from './table-plan.js';

/** 判别值隐藏槽（只求值一次） */
export function tableSubjectSlot(tableName: string): string {
  return `__kojo_table_${tableName}`;
}

/** 分档结果隐藏槽（供文本/表达式引用） */
export function tableValueSlot(tableName: string): string {
  return `__kojo_table_${tableName}__value`;
}

/** 名字位置判定：调用位 `名字(` 不是表引用（表不是函数）；属性位 `名字.xxx` 也不是 */
export function isNamePosition(neighbors: NameNeighbors): boolean {
  return neighbors.after !== '(' && neighbors.before !== '.';
}

/**
 * 一层表引用替换（表达式/文本插值共用）：表名 → 值隐藏槽。
 *
 * `@巡` 绑定名**遮蔽**同名表：`{值}` 在循环体内始终指元素槽（与语言层名字解析优先级一致）。
 */
export function tableLookup(ctx: ExpandContext): (name: string, neighbors: NameNeighbors) => string | undefined {
  return (name, neighbors) => {
    if (!isNamePosition(neighbors)) return undefined;
    if (foreachSlotInScope(ctx, name) !== null) return undefined;
    return ctx.tables.has(name) ? tableValueSlot(name) : undefined;
  };
}

/** 表达式里引用了哪些表（按出现顺序去重；循环体内的绑定名不算表引用） */
export function collectTableRefs(expr: KojoExprText, ctx: ExpandContext): readonly string[] {
  return scanIdentifiers(
    expr.text,
    (name, neighbors) =>
      isNamePosition(neighbors) && foreachSlotInScope(ctx, name) === null && ctx.tables.has(name),
  );
}

function planOf(name: string, ctx: ExpandContext): TableLoweringPlan | null {
  const cached = ctx.tablePlans.get(name);
  if (cached !== undefined) return cached;
  const decl = ctx.tables.get(name);
  if (decl === undefined) return null;
  const result = validateTable(decl, { integerConstants: ctx.constants });
  for (const diagnostic of result.diagnostics) ctx.sink.report(diagnostic);
  ctx.tablePlans.set(name, result.plan);
  return result.plan;
}

/** 分支条件表达式（判别槽已只求值一次；这里只做静态端点比较） */
function rowTest(row: TablePlanRow, subjectSlot: string, span: KojoSpan): KojoExprText {
  let text: string;
  switch (row.shape) {
    case 'exact':
      text = `${subjectSlot} == ${String(row.from)}`;
      break;
    case 'closed':
      text = `${subjectSlot} >= ${String(row.from)} && ${subjectSlot} <= ${String(row.to)}`;
      break;
    case 'at-least':
      text = `${subjectSlot} >= ${String(row.from)}`;
      break;
    case 'at-most':
      text = `${subjectSlot} <= ${String(row.to)}`;
      break;
    case 'default':
      text = '1';
      break;
  }
  return { text, span };
}

/**
 * 把 backend 的一次发射物化成"已降糖行"（子缓冲口径的轻量版：只取行、不占父缓冲）。
 *
 * 失败（`EmitFailure`）时诊断原样进 sink、返回 null：调用方**不产字节**；
 * `[]` 视为"这一发没有产物行"（同样不产字节，不生成空档骨架）。
 */
function materializeEmit(result: EmitResult, ctx: ExpandContext): readonly string[] | null {
  if (result === null) return null;
  if (typeof result === 'string') return [result];
  if (isEmitFailure(result)) {
    for (const diagnostic of result.diagnostics) ctx.sink.report(diagnostic);
    return null;
  }
  return result.length === 0 ? null : result;
}

/** 一条表行的值赋值（`<值槽> = <字面量>`）→ 已降糖行；失败时诊断已进 sink、返回 null */
function lowerArmValue(row: TablePlanRow, valueSlot: string, ctx: ExpandContext): readonly string[] | null {
  return materializeEmit(
    ctx.backend.program.assign({
      target: { text: valueSlot, span: row.span },
      op: '=',
      value: literalToExpr(row.value, row.span),
      span: row.span,
    }),
    ctx,
  );
}

/**
 * 等值分派落点（K2-TABLE-SELECTCASE；`selectcase` 计划）：每臂的赋值行在这里**预先降糖**，
 * 再把纯结构请求交给 adapter（core 只发请求，零引擎关键字）。
 *
 * 返回语义：
 * - `true`：已发射，或已 fail-closed（错误诊断已进 sink，不产字节）——调用方别再发 IF 链；
 * - `false`：没有该 backend 能力 / 计划行号对不上——调用方保持既有 IF 链（产物不变）。
 *
 * source map 口径：整块（含各档赋值行）归到表 decl 的 span——与 `@随机` / `选项` 的
 * 块级映射同一口径（§10.7"展开块映射到块头"）；逐个 CASE 的精确列映射不在本批范围。
 */
function emitTableDispatch(
  dispatch: TableDispatchPlan,
  subjectSlot: string,
  valueSlot: string,
  plan: TableLoweringPlan,
  ctx: ExpandContext,
  state: LowerState,
): boolean {
  const emitter = tableDispatchOf(ctx.backend);
  if (emitter === null) return false; // adapter 没有等值分派能力：保持现状

  const armLines: (readonly string[])[] = [];
  for (const item of dispatch.cases) {
    const row = plan.rows[item.rowIndex];
    if (row === undefined) return false; // 计划行号越界 = 不自洽，退回 IF 链（不静默丢档）
    const lines = lowerArmValue(row, valueSlot, ctx);
    if (lines === null) return true; // 赋值行表达不了：诊断已报，不产半成品
    armLines.push(lines);
  }

  let elseLines: readonly string[] = [];
  if (dispatch.hasDefault) {
    const row = plan.rows[plan.defaultRow];
    if (row === undefined) return false;
    const lines = lowerArmValue(row, valueSlot, ctx);
    if (lines === null) return true;
    elseLines = lines;
  }

  const request: TableDispatchEmitRequest = { plan: dispatch, subjectSlot, valueSlot, armLines, elseLines };
  emit(state, emitter(request), plan.span);
  return true;
}

function emitTable(name: string, plan: TableLoweringPlan, ctx: ExpandContext, state: LowerState): void {
  const subjectSlot = tableSubjectSlot(name);
  const valueSlot = tableValueSlot(name);
  recordSlot(ctx, subjectSlot, 'table', 'int', 'table-subject');
  recordSlot(ctx, valueSlot, 'table', plan.valueType, 'table-value');

  // 依赖：`依据` 表达式里可能引用别的表（先求依赖，再求自己；环由栈检测）
  const deps = collectTableRefs(plan.subject, ctx);
  ensureTables(deps, ctx, state);
  const subject = rewriteExpr(plan.subject, tableLookup(ctx)).expr;

  emit(
    state,
    ctx.backend.program.assign({ target: { text: subjectSlot, span: plan.subject.span }, op: '=', value: subject, span: plan.subject.span }),
    plan.subject.span,
  );

  // 落点判定（C2.5 / §6.3）：可证等值 + adapter 有等值分派能力 → 发结构请求（additive）；
  // 其余情况（不可证 / 计划不自洽 / 无该能力）保持下面的既有 IF 链，产物逐字节不变。
  const dispatch = planTableDispatch(plan);
  if (dispatch.style === 'error') {
    for (const diagnostic of dispatch.diagnostics) ctx.sink.report(diagnostic);
    return; // 计划不自洽：不产字节（fail-closed）
  }
  if (dispatch.style === 'selectcase' && emitTableDispatch(dispatch, subjectSlot, valueSlot, plan, ctx, state)) return;

  let emittedHeader = false;
  for (const row of plan.rows) {
    if (row.shape === 'default') {
      if (emittedHeader) emit(state, ctx.backend.control.elseHeader(), row.span);
      emit(
        state,
        ctx.backend.program.assign({ target: { text: valueSlot, span: row.span }, op: '=', value: literalToExpr(row.value, row.span), span: row.span }),
        row.span,
      );
      continue;
    }
    const test = rowTest(row, subjectSlot, row.span);
    emit(state, emittedHeader ? ctx.backend.control.elseIfHeader(test) : ctx.backend.control.ifHeader(test), row.span);
    emittedHeader = true;
    emit(
      state,
      ctx.backend.program.assign({ target: { text: valueSlot, span: row.span }, op: '=', value: literalToExpr(row.value, row.span), span: row.span }),
      row.span,
    );
  }
  if (emittedHeader) emit(state, ctx.backend.control.ifFooter(), plan.span);
}

/** 确保这些表在当前位置之前算好（去重；依赖递归；环 → `core/table/cycle`） */
export function ensureTables(names: readonly string[], ctx: ExpandContext, state: LowerState): void {
  if (names.length === 0) return;
  for (const name of names) ensureTable(name, ctx, state);
}

function ensureTable(name: string, ctx: ExpandContext, state: LowerState): void {
  if (ctx.tableStack.includes(name)) {
    reportAt(ctx, 'core/table/cycle', `表「${name}」通过「依据」表达式互相引用成环：无法确定求值顺序（§6.2 要求循环检测）。`, ctx.tables.get(name)?.span ?? null);
    return;
  }
  if (ctx.tableStack.length >= ctx.maxDepth) {
    reportAt(ctx, 'core/table/cycle', `表「${name}」展开深度超过 ${ctx.maxDepth} 层：疑似循环引用。`, ctx.tables.get(name)?.span ?? null);
    return;
  }
  const plan = planOf(name, ctx);
  if (plan === null) return; // 校验已报 error；不产字节
  ctx.tableStack.push(name);
  try {
    emitTable(name, plan, ctx, state);
  } finally {
    ctx.tableStack.pop();
  }
}

/** 供展开层判断"这个 emit 返回值是不是失败"（保持 fail-closed 语义单一） */
export function reportEmitFailure(ctx: ExpandContext, result: import('../backend.js').EmitResult): boolean {
  if (!isEmitFailure(result)) return false;
  for (const diagnostic of result.diagnostics) ctx.sink.report(diagnostic);
  return true;
}

/** 表声明（诊断/预览用） */
export type TableDecl = KojoTableDecl;

/** 静态校验全部表（编译前置；未引用的表也要报重叠/缺否等 error） */
export function validateAllTables(ctx: ExpandContext): void {
  for (const name of ctx.tables.keys()) planOf(name, ctx);
}

