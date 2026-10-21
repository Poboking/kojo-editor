/**
 * `# 池` 引用点展开（§7.1）：编译期条件展开，落 **IF / ELSEIF / ELSE**（不是随机族）。
 *
 * - `? 否` 必填、必须最后、分支不能为空且必须可打印（`core/pool/*`）；
 * - 池内禁止副作用由 parser 收口；这里再做一次"空分支/缺否/否位置"的结构校验，
 *   因为展开器是最后一道闸（parser 结构错误不应变成静默空产物）；
 * - 每个分支体先降糖进子缓冲，再按帧（调用处 + 池定义处）搬进父缓冲 —— 双向 origins；
 * - 环检测复用 `core/pool/cycle`（池/模板共用码）。
 *
 * 落点（C2.6）：默认仍是 `IF / ELSEIF / ELSE`；`pool-plan.ts` 判定**同一主语 + 整数
 * 等值可证**且 adapter 实现了 `presentation.poolDispatch` 时，改发**结构请求**
 * （每档正文先在子缓冲降糖，关键词/缩进由 adapter 定）。其余情况（不可证 / 无该能力）
 * 走原来的 IF 链，产物逐字节不变；计划不自洽（如等值键重复）则 fail-closed、不产字节。
 */
import type { KojoCallStmt, KojoConditionBranch, KojoPoolDecl, KojoSpan } from '../../ast.js';
import { isEmitFailure } from '../backend.js';
import type { EmitResult } from '../backend.js';
import { narrativeHasOutput } from '../presentation.js';
import { lowerIntoChildLines } from '../state.js';
import type { LowerState } from '../state.js';
import { expansionFrame, lowerWithFrame } from './frame.js';
import type { ExpansionFrame } from './frame.js';
import { recordSlot, reportAt } from './context.js';
import type { ExpandContext, WalkNarrative } from './context.js';
import { rewriteExpandExpr } from './lookup.js';
import { collectTableRefs, ensureTables } from './tables.js';
import { planPoolDispatch, poolDispatchOf, poolSubjectSlot } from './pool-plan.js';
import type { PoolDispatchEmitRequest, PoolDispatchPlan } from './pool-plan.js';

interface PoolShape {
  readonly ok: boolean;
}

/** 结构校验（每池一次；有 error 的池不产字节，后续引用只跳过） */
function checkPool(pool: KojoPoolDecl, ctx: ExpandContext): PoolShape {
  if (ctx.invalidPools.has(pool.name)) return { ok: false };
  let ok = true;
  const branches = pool.branches;
  if (branches.length === 0) {
    reportAt(ctx, 'core/pool/no-default', `池「${pool.name}」没有条件分支：池体必须是一条 ` + '`?` 链并以 `? 否` 收束（§7.1）。', pool.span);
    ctx.invalidPools.add(pool.name);
    return { ok: false };
  }
  let defaultIndex = -1;
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!;
    if (branch.test === null) {
      if (defaultIndex >= 0) {
        reportAt(ctx, 'core/pool/default-not-last', `池「${pool.name}」出现第二个「? 否」：只能有一个且必须最后。`, branch.span);
        ok = false;
      } else {
        defaultIndex = i;
        if (i !== branches.length - 1) {
          reportAt(ctx, 'core/pool/default-not-last', `池「${pool.name}」的「? 否」不在最后：兜底分支必须贴在池尾。`, branch.span);
          ok = false;
        }
      }
    }
    if (!branchIsPrintable(branch)) {
      reportAt(
        ctx,
        'core/pool/empty-branch',
        `池「${pool.name}」有一个空分支（不可打印）：每个分支至少要有一行文本（嵌套 ? 也要最终能打印）。`,
        branch.span,
      );
      ok = false;
    }
  }
  if (defaultIndex < 0) {
    reportAt(ctx, 'core/pool/no-default', `池「${pool.name}」缺 ` + '`? 否`：玩家看到的分支必须有兜底（§7.1）。', pool.span);
    ok = false;
  }
  if (!ok) ctx.invalidPools.add(pool.name);
  return { ok };
}

function branchIsPrintable(branch: KojoConditionBranch): boolean {
  return branch.body.length > 0 && narrativeHasOutput(branch.body);
}

/**
 * 链头/尾行的映射：行级照旧（`kind: 'pool'` + `source` + 帧 origins）；
 * 列级 additive = 整行一段（这个文件的发射物没有更细的列粒度，起点恒为 1，
 * 终点由 buffer 按行宽补成 `行宽 + 1`），锚点同样是"调用处 + 池定义处"。
 */
function controlMappingOf(frame: ExpansionFrame) {
  return (source: KojoSpan) => ({
    kind: 'pool' as const,
    source,
    origins: frame.origins,
    segments: [{ startColumn: 1, source, kind: 'pool' as const, origins: frame.origins }],
  });
}

/**
 * 等值分派落点（C2.6；`selectcase` 计划）：
 * 1. 主语只求值一次（隐藏槽 `__kojo_pool_<名>`；表引用先按依赖求值、`@巡` 绑定名改写）；
 * 2. 每档正文与 `? 否` 正文在**子缓冲**里降糖（不先落父缓冲，顺序由 adapter 的块定）；
 * 3. 纯结构请求交给 adapter（core 只发请求，零引擎关键字）。
 *
 * 返回语义：
 * - `true`：已发射，或已 fail-closed（错误诊断已进 sink，不产字节）——调用方别再发 IF 链；
 * - `false`：没有该 backend 能力 / 计划下标对不上——调用方保持既有 IF 链（产物不变）。
 */
function emitPoolSelectCase(
  pool: KojoPoolDecl,
  plan: PoolDispatchPlan,
  ctx: ExpandContext,
  state: LowerState,
  frame: ExpansionFrame,
  walk: WalkNarrative,
  controlMapping: ReturnType<typeof controlMappingOf>,
): boolean {
  const emitter = poolDispatchOf(ctx.backend);
  if (emitter === null) return false; // adapter 没有等值分派能力：保持现状

  const subject = plan.subject;
  if (subject === null || plan.defaultIndex === null) return false; // 计划自洽时必有；防御

  // 每档正文：先降糖到子缓冲（带帧 origins；诊断进 sink，行不占父缓冲）
  const caseLines: (readonly string[])[] = [];
  for (const item of plan.cases) {
    const branch = pool.branches[item.branchIndex];
    if (branch === undefined) return false; // 计划下标越界 = 不自洽，退回 IF 链（不静默丢档）
    caseLines.push(lowerIntoChildLines(state, (child) => lowerWithFrame(branch.body, ctx, child, frame, walk)));
  }
  const defaultBranch = pool.branches[plan.defaultIndex];
  if (defaultBranch === undefined) return false;
  const elseLines = lowerIntoChildLines(state, (child) => lowerWithFrame(defaultBranch.body, ctx, child, frame, walk));

  // 主语求值行（先算好；发射失败就不写半成品）
  const rewrittenSubject = rewriteExpandExpr(subject, ctx);
  const assign: EmitResult = ctx.backend.program.assign({
    target: { text: poolSubjectSlot(pool.name), span: subject.span },
    op: '=',
    value: rewrittenSubject,
    span: subject.span,
  });
  if (isEmitFailure(assign)) {
    for (const diagnostic of assign.diagnostics) ctx.sink.report(diagnostic);
    return true; // 主语求值表达不了：不产半成品字节
  }
  if (assign === null) return false;

  const request: PoolDispatchEmitRequest = { plan, subjectSlot: poolSubjectSlot(pool.name), caseLines, elseLines };
  const block = emitter(request);
  if (isEmitFailure(block)) {
    for (const diagnostic of block.diagnostics) ctx.sink.report(diagnostic);
    return true;
  }
  if (block === null || (Array.isArray(block) && block.length === 0)) {
    reportAt(ctx, 'core/feature/unsupported', `backend（${ctx.backend.id}）没有为池「${pool.name}」生成等值分派块（返回空）：不产半成品字节。`, pool.span);
    return true;
  }

  // 主语里的表引用：先按依赖求值（在分派块之前、只算一次）
  const deps = collectTableRefs(subject, ctx);
  if (deps.length > 0) ensureTables(deps, ctx, state);
  // 槽必须在本函数内声明（隐藏槽清单由 adapter 落 `#DIM`）：kind/role 用池自己的事实，
  // 不再借用 `template/template-slot`（声明形态仍只由 valueType 决定 = `#DIM`）。
  recordSlot(ctx, poolSubjectSlot(pool.name), 'pool', 'int', 'pool-subject');
  state.buffer.pushEmitted(assign, controlMapping(subject.span), ctx.sink);
  state.buffer.pushEmitted(block, controlMapping(pool.span), ctx.sink);
  return true;
}

/** 池调用展开（编译期条件展开；调用点可以是叙事区或调度区） */
export function expandPoolCall(call: KojoCallStmt, pool: KojoPoolDecl, ctx: ExpandContext, state: LowerState, walk: WalkNarrative): void {
  if (ctx.poolStack.includes(pool.name)) {
    reportAt(ctx, 'core/pool/cycle', `池「${pool.name}」直接或间接调用了自己：编译期展开会无限循环（§7.1）。`, call.span);
    return;
  }
  if (ctx.poolStack.length >= ctx.maxDepth) {
    reportAt(ctx, 'core/pool/cycle', `池「${pool.name}」展开深度超过 ${ctx.maxDepth} 层：疑似循环调用。`, call.span);
    return;
  }
  if (!checkPool(pool, ctx).ok) return;

  const frame = expansionFrame('pool', call.span, pool.span);
  const controlMapping = controlMappingOf(frame);

  // 落点判定（C2.6 / §7.1）：可证等值 + adapter 有等值分派能力 → 发结构请求（additive）；
  // 其余情况（不可证 / 无该能力）保持下面的既有 IF 链，产物逐字节不变。
  const dispatch = planPoolDispatch(pool);
  if (dispatch.style === 'error') {
    for (const diagnostic of dispatch.diagnostics) ctx.sink.report(diagnostic);
    ctx.invalidPools.add(pool.name); // 同一池的后续引用不再重复报同一批诊断
    return; // 计划不自洽：不产字节（fail-closed）
  }

  ctx.poolStack.push(pool.name);
  try {
    if (dispatch.style === 'selectcase' && emitPoolSelectCase(pool, dispatch, ctx, state, frame, walk, controlMapping)) {
      return;
    }
    for (let i = 0; i < pool.branches.length; i++) {
      const branch = pool.branches[i]!;
      const mapping = controlMapping(branch.span);
      if (i === 0) {
        // 链首就是 `? 否`：无条件执行（parser 通常不会产这种形状；防御性处理）
        if (branch.test !== null) state.buffer.pushEmitted(ctx.backend.control.ifHeader(branch.test), mapping, ctx.sink);
      } else if (branch.test === null) {
        state.buffer.pushEmitted(ctx.backend.control.elseHeader(), mapping, ctx.sink);
      } else {
        state.buffer.pushEmitted(ctx.backend.control.elseIfHeader(branch.test), mapping, ctx.sink);
      }
      lowerWithFrame(branch.body, ctx, state, frame, walk);
    }
    if (pool.branches[0]!.test !== null) {
      state.buffer.pushEmitted(ctx.backend.control.ifFooter(), controlMapping(pool.span), ctx.sink);
    }
  } finally {
    ctx.poolStack.pop();
  }
}

/** 静态校验全部池（编译前置；未引用的池也报结构 error） */
export function validateAllPools(ctx: ExpandContext): void {
  for (const pool of ctx.pools.values()) checkPool(pool, ctx);
}

