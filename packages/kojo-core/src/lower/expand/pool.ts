/**
 * `# 池` 引用点展开（§7.1）：编译期条件展开，落 **IF / ELSEIF / ELSE**（不是随机族）。
 *
 * - `? 否` 必填、必须最后、分支不能为空且必须可打印（`core/pool/*`）；
 * - 池内禁止副作用由 parser 收口；这里再做一次"空分支/缺否/否位置"的结构校验，
 *   因为展开器是最后一道闸（parser 结构错误不应变成静默空产物）；
 * - 每个分支体先降糖进子缓冲，再按帧（调用处 + 池定义处）搬进父缓冲 —— 双向 origins；
 * - 环检测复用 `core/pool/cycle`（池/模板共用码）。
 */
import type { KojoCallStmt, KojoConditionBranch, KojoPoolDecl } from '../../ast.js';
import { narrativeHasOutput } from '../presentation.js';
import type { LowerState } from '../state.js';
import { expansionFrame, lowerWithFrame } from './frame.js';
import { reportAt } from './context.js';
import type { ExpandContext, WalkNarrative } from './context.js';

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
  ctx.poolStack.push(pool.name);
  try {
    for (let i = 0; i < pool.branches.length; i++) {
      const branch = pool.branches[i]!;
      const mapping = { kind: 'pool' as const, source: branch.span, origins: frame.origins };
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
      state.buffer.pushEmitted(
        ctx.backend.control.ifFooter(),
        { kind: 'pool', source: pool.span, origins: frame.origins },
        ctx.sink,
      );
    }
  } finally {
    ctx.poolStack.pop();
  }
}

/** 静态校验全部池（编译前置；未引用的池也报结构 error） */
export function validateAllPools(ctx: ExpandContext): void {
  for (const pool of ctx.pools.values()) checkPool(pool, ctx);
}

