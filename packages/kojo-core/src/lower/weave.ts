/**
 * `@织` 监听 lowering 骨架（§8.6 / §16.2 C2.10）。
 *
 * core 只做形状与能力闸：
 * - 修饰词冲突（重复 / `接管` 与 `之前|之后` 并用）→ `core/weave/modifier-conflict`；
 * - 修饰词需要 `priorityModel = emuera-buckets`，未声明 → `core/weave/unsupported`，**不产字节**；
 * - 事件目录（事件名/参数形状/未知事件）是 adapter 的 `eventCatalog`，不在这里枚举。
 *
 * 项目级判定（同事件同层多个 `接管`、被压监听 warning）属于项目分析层，不在单文件降糖里做。
 */
import type { KojoWeaveDecl } from '../ast.js';
import type { LowerNarrativeBody, LowerState } from './state.js';
import { emit, report } from './state.js';

export function lowerWeave(decl: KojoWeaveDecl, state: LowerState, lowerBody: LowerNarrativeBody): void {
  const seen = new Set<string>();
  let conflict = false;
  for (const modifier of decl.modifiers) {
    if (seen.has(modifier)) {
      report(
        state,
        'core/weave/modifier-conflict',
        `\`@织 ${decl.event}\` 的修饰词重复（${modifier}）：每个修饰词最多写一次。`,
        decl.span,
      );
      conflict = true;
    }
    seen.add(modifier);
  }
  if (seen.has('only') && seen.size > 1) {
    report(
      state,
      'core/weave/modifier-conflict',
      `\`@织 ${decl.event}\`：\`接管\` 不能与 \`之前\` / \`之后\` 并用。`,
      decl.span,
    );
    conflict = true;
  }

  const needsPriorityBuckets = decl.modifiers.length > 0;
  if (needsPriorityBuckets && state.backend.profile.priorityModel !== 'emuera-buckets') {
    report(
      state,
      'core/weave/unsupported',
      `当前 adapter（${state.backend.id}）没有声明事件优先级模型（profile.priorityModel = emuera-buckets）：\`之前\` / \`之后\` / \`接管\` 不可用。请去掉修饰词或用 \`@原生\`。`,
      decl.span,
    );
    return;
  }
  if (conflict) return;

  emit(
    state,
    state.backend.weave.weaveHeader({
      event: decl.event,
      args: decl.args,
      modifiers: decl.modifiers,
      span: decl.span,
      // 单文件 lower 入口不做展开，不知道监听体内的隐藏槽；展开感知入口（compile）会传真实清单。
      slots: [],
    }),
    decl.span,
  );
  state.weaveDepth++;
  lowerBody(decl.body);
  state.weaveDepth--;
  emit(state, state.backend.weave.weaveFooter(), decl.span);
}
