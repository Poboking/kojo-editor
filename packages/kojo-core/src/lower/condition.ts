/**
 * `?` 条件链 lowering（§5 / §16.2 C2.4）。
 *
 * 语义写死：
 * - **first-match**：按源顺序发 `IF / ELSEIF / ELSE`，不排序、不合并、不常量折叠；
 * - 普通链可省略 `? 否`；`? 否` 落 `ELSE`；链形（`否` 是否最后/是否孤儿）由 parser 收口，
 *   这里只防御性处理"首个分支就是 `否`"（无条件执行体，不发空 `IF`）；
 * - **SIF 降级**：整条链只有一个真分支、分支体恰一个"至多产一行"的节点、
 *   adapter 声明支持 `SIF` 时，发 `SIF 条件` + 那一行（§5.2：`? 否` 与嵌套块仍走完整链）。
 *
 * 泛型化：叙事链（分支体是叙事节点）与调度链（分支体是调度节点）共用同一套 first-match 逻辑，
 * 体怎么降糖由调用方回调传入——**不复制第二份链代码**。
 */
import type { KojoExprText, KojoSpan } from '../ast.js';
import type { LowerState } from './state.js';
import { emit } from './state.js';

/** 分支体"至多一行"候选（SIF 判据由各区域自己给白名单） */
export type SifBodyTest<T> = (nodes: readonly T[]) => boolean;

interface BranchLike<T> {
  readonly test: KojoExprText | null;
  readonly body: readonly T[];
  readonly span: KojoSpan;
}

function branchSpan(branch: BranchLike<unknown>): KojoSpan {
  return branch.span;
}

/**
 * 一条条件链：first-match + 可选 SIF 降级。
 *
 * @param emitBody 分支体降糖回调（映射由体内部逐节点完成）
 * @param canSif   当前区域允许 SIF 的体形状判据；null = 本区域不支持 SIF
 */
export function lowerConditionChain<T>(
  branches: readonly BranchLike<T>[],
  state: LowerState,
  emitBody: (body: readonly T[]) => void,
  canSif: SifBodyTest<T> | null,
): void {
  if (branches.length === 0) return;
  const first = branches[0]!;
  // 防御：链首就是 `? 否` ⇒ 无条件执行（parser 正常不会产这种形状）
  if (first.test === null) {
    emitBody(first.body);
    return;
  }

  // SIF：单真分支 + 单行体 + adapter 支持 ⇒ `SIF 条件` + 一行
  if (
    branches.length === 1 &&
    canSif !== null &&
    canSif(first.body) &&
    state.backend.control.sifSupported
  ) {
    emit(state, state.backend.control.sifHeader(first.test), first.span);
    emitBody(first.body);
    return;
  }

  emit(state, state.backend.control.ifHeader(first.test), first.span);
  emitBody(first.body);
  for (let i = 1; i < branches.length; i++) {
    const branch = branches[i]!;
    if (branch.test === null) emit(state, state.backend.control.elseHeader(), branch.span);
    else emit(state, state.backend.control.elseIfHeader(branch.test), branch.span);
    emitBody(branch.body);
  }
  emit(state, state.backend.control.ifFooter(), branchSpan(first));
}

/** `SIF` 只对"至多产一行"的叙事节点开放（§5.2；契约见 backend.ts 第 1 条） */
export function isSingleLineNarrativeNode(node: { readonly kind: string }): boolean {
  return node.kind === 'textLine' || node.kind === 'blankLine' || node.kind === 'faceLine';
}
