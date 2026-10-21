/**
 * `@巡` 的 2.0 主链降糖（展开感知；K2-FOREACH 接线）。
 *
 * 分工（与 `# 表` / `@随机` / `选项` 同一口径）：
 * 1. **计划**：`planForEachLoop` 校验 adapter 集合声明 + 本文件数组事实，失败 ⇒ 原样收诊断、
 *    **零字节**（不退回 `forEachHeader/Footer` 猜绑定）；
 * 2. **能力闸**：backend 没实现 `program.forEachLoop` ⇒ `core/feature/unsupported` + 零字节
 *    （老 backend 是 additive 兼容面，不是静默降级口）；
 * 3. **绑定作用域**：用**帧栈**把绑定名（`{值}`/`{下标}`/`{角}`/`{名}`/`{项}`/`{键}`）
 *    指向 plan 的隐藏槽——只在循环体内生效，内层遮蔽外层，出体即失效；
 * 4. **体**：在子缓冲里降糖（`state.loopDepth` 已生效，`@断`/`@续` 合法），行数组交回本层；
 * 5. **落点**：整个请求（plan + 已降糖 body）交给 adapter 的 `program.forEachLoop`——
 *    索引循环关键字/元素取法是 adapter 事实，core 一个都不写死。
 *
 * 本模块只做编排与作用域：不拼引擎关键字、不读盘、不缓存。
 */
import type { KojoForEachLoop } from '../../ast.js';
import type { ExpandContext, WalkNarrative } from './context.js';
import {
  foreachArrayFacts,
  popForeachFrame,
  pushForeachFrame,
  recordSlot,
  reportAt,
  reportDiagnostic,
} from './context.js';
import { planForEachLoop } from './foreach.js';
import { rewriteExpandExpr } from './lookup.js';
import { collectTableRefs, ensureTables } from './tables.js';
import { FOREACH_HIDDEN_SLOT_ROLES } from '../backend.js';
import type { LowerState } from '../state.js';
import { emit, lowerIntoChildLines } from '../state.js';

/**
 * 一个 `@巡` 节点的降糖（**成功才产字节**）。
 *
 * @param enabled `programFeatures.foreach`（能力闸事实；false 时 plan 直接报
 *                `core/control/unsupported`，只报一条、不产字节）
 */
export function lowerExpandedForEachLoop(
  node: KojoForEachLoop,
  ctx: ExpandContext,
  state: LowerState,
  walkNarrative: WalkNarrative,
  enabled: boolean,
): void {
  const result = planForEachLoop(node, ctx.adapter.foreachCollections ?? null, {
    enabled,
    arrays: foreachArrayFacts(ctx),
  });
  if (!result.ok) {
    for (const diagnostic of result.diagnostics) reportDiagnostic(ctx, diagnostic);
    return; // fail-closed：诊断已收，零字节
  }
  const plan = result.plan;

  // 能力闸先于一切副作用：老 backend（没有 plan 落点）不能退回 `forEachHeader/Footer` 猜绑定
  const program = state.backend.program;
  if (program.forEachLoop === undefined) {
    reportAt(
      ctx,
      'core/feature/unsupported',
      `本文件有 \`@巡 ${plan.collection}\`，但当前 backend（${state.backend.id}）没有实现 \`program.forEachLoop\`：不能生成索引循环（fail-closed，不产半成品字节）。`,
      node.span,
    );
    return;
  }

  // 集合表达式里的表引用先求值（与其它表达式展开点同口径）；改写后的源切片交给 emitter 编译
  const refs = collectTableRefs(node.collection, ctx);
  if (refs.length > 0) ensureTables(refs, ctx, state);
  const collectionExpr = rewriteExpandExpr(node.collection, ctx);
  const requestPlan = collectionExpr === plan.collectionExpr ? plan : { ...plan, collectionExpr };

  // 隐藏槽事实：core 只发引用，`#DIM`/`#DIMS` 由 adapter 按 valueType 落
  for (const slot of plan.slots) {
    recordSlot(ctx, slot.name, 'foreach', slot.valueType, FOREACH_HIDDEN_SLOT_ROLES[slot.role]);
  }

  const slots = new Map<string, string>();
  for (const binding of plan.bindings) slots.set(binding.name, binding.slot);

  pushForeachFrame(ctx, slots);
  state.loopDepth++;
  let body: readonly string[];
  try {
    body = lowerIntoChildLines(state, (child) => walkNarrative(node.body, ctx, child));
  } finally {
    state.loopDepth--;
    popForeachFrame(ctx);
  }

  emit(state, program.forEachLoop({ plan: requestPlan, body, span: node.span }), node.span);
}
