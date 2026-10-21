/**
 * 展开感知的体走法（compile 专用；不替换 lower 的通用分发器，只在需要展开处拦截）。
 *
 * 为什么需要第二层走法：`# 表`/`# 池`/`# 模` 的引用点可能出现在任意体里，而 lower 的
 * 通用分发器只认"已定位好的 AST"。这里做三件事：
 * 1. **拦截**：`! 池名` / `! 模名(…)` 走展开器，不产运行期调用；
 * 2. **提升**：当前节点表达式里引用的表，先在节点前求值进隐藏槽（`table.ts` 计划），
 *    再把表达式里的表名换成值槽；
 * 3. **递归**：所有子体（分支/循环/候选/插槽）都走本走法——容器节点的头/尾仍由
 *    backend 的 `control` / `program` 发射器出，叶子节点仍交给 lower 的发射器（不抄）。
 *
 * SIF 判据在本层收紧：展开会往体里插多行（隐藏槽求值），所以"单行体"必须同时满足
 * "无表引用、不是池/模板调用"才允许 `SIF`，否则回落完整 IF 链。
 */
import type {
  KojoConditionBranch,
  KojoDispatchCondition,
  KojoDispatchNode,
  KojoExprText,
  KojoNarrativeNode,
  KojoPoolDecl,
  KojoTemplateDecl,
  KojoTextPart,
} from '../../ast.js';
import { isSingleLineNarrativeNode, lowerConditionChain } from '../condition.js';
import { lowerDispatchNodes, lowerSandboxBlock } from '../program.js';
import { lowerNarrativeNodes } from '../narrative.js';
import { lowerColorBlock, lowerRandomBlock, randomCandidatePurity } from '../presentation.js';
import type { LowerState } from '../state.js';
import { emit } from '../state.js';
import { lowerOptionsBlockExpanded } from './options.js';
import { collectTableRefs, ensureTables } from './tables.js';
import { recordSlot } from './context.js';
import { expandPoolCall } from './pool.js';
import { expandTemplateCall } from './template.js';
import { lowerExpandedForEachLoop } from './foreach-walk.js';
import { expandLookup, rewriteExpandExpr } from './lookup.js';
import { rewriteTextParts } from './expr.js';
import type { ExpandContext, WalkDispatch, WalkNarrative } from './context.js';

/* ============================== 表引用收集（只收当前节点直接表达式） ============================== */

function refsOfExprs(exprs: readonly KojoExprText[], ctx: ExpandContext): readonly string[] {
  const out: string[] = [];
  for (const expr of exprs) for (const name of collectTableRefs(expr, ctx)) if (!out.includes(name)) out.push(name);
  return out;
}

function refsOfParts(parts: readonly KojoTextPart[], ctx: ExpandContext): readonly string[] {
  const exprs: KojoExprText[] = [];
  for (const part of parts) {
    if (part.kind === 'text') continue;
    exprs.push(part.expr);
    if (part.cond !== undefined) exprs.push(part.cond.cond, part.cond.then, part.cond.else);
  }
  return refsOfExprs(exprs, ctx);
}

function hoist(refs: readonly string[], ctx: ExpandContext, state: LowerState): void {
  if (refs.length > 0) ensureTables(refs, ctx, state);
}

/**
 * 这一段是否需要走表达式改写：表引用（要提升）或 `@巡` 绑定名（要换槽）任一命中即可。
 * 绑定改写不产额外行，所以 SIF 判据仍只看表引用（见 `narrativeSifBody`）。
 */
function needsRewrite(refs: readonly string[], ctx: ExpandContext): boolean {
  return refs.length > 0 || ctx.foreachFrames.length > 0;
}

function rewriteParts(parts: readonly KojoTextPart[], ctx: ExpandContext): readonly KojoTextPart[] {
  return rewriteTextParts(parts, expandLookup(ctx)).parts;
}

function rewriteBranchesTests(branches: readonly KojoConditionBranch[], ctx: ExpandContext): readonly KojoConditionBranch[] {
  return branches.map((branch) => ({
    test: branch.test === null ? null : rewriteExpandExpr(branch.test, ctx),
    body: branch.body,
    span: branch.span,
  }));
}

/* ============================== SIF 判据（展开感知） ============================== */

function narrativeSifBody(body: readonly KojoNarrativeNode[], ctx: ExpandContext): boolean {
  if (body.length !== 1) return false;
  const node = body[0]!;
  if (!isSingleLineNarrativeNode(node)) return false;
  if (node.kind === 'textLine') return refsOfParts(node.parts, ctx).length === 0;
  return true;
}

function dispatchSifBody(body: readonly KojoDispatchNode[], ctx: ExpandContext): boolean {
  if (body.length !== 1) return false;
  const node = body[0]!;
  // 白名单与 lower/program 的 SIF 判据一致（assign / call / exprCall）；这里只额外收紧
  // "展开会产多行"与"含表引用"的两种体。
  if (node.kind !== 'assign' && node.kind !== 'call' && node.kind !== 'exprCall') return false;
  if (node.kind === 'assign') return refsOfExprs([node.value], ctx).length === 0;
  if (node.kind === 'exprCall') return refsOfExprs([node.call], ctx).length === 0;
  // call：池/模板展开是多行；函数调用还带实参引用
  if (ctx.pools.has(node.name) || ctx.templates.has(node.name)) return false;
  return refsOfExprs(node.args, ctx).length === 0;
}

/* ============================== 调用拦截（池 / 模板 / 函数） ============================== */

function expandOrDelegateCall(
  name: string,
  args: readonly KojoExprText[],
  owner: { readonly kind: 'call'; readonly span: import('../../ast.js').KojoSpan; readonly body?: readonly KojoNarrativeNode[] },
  ctx: ExpandContext,
  state: LowerState,
  walkNarrative: WalkNarrative,
): void {
  const pool: KojoPoolDecl | undefined = ctx.pools.get(name);
  if (pool !== undefined) {
    expandPoolCall(
      { kind: 'call', name, args, span: owner.span, ...(owner.body === undefined ? {} : { body: owner.body }) },
      pool,
      ctx,
      state,
      walkNarrative,
    );
    return;
  }
  const template: KojoTemplateDecl | undefined = ctx.templates.get(name);
  if (template !== undefined) {
    expandTemplateCall(
      { kind: 'call', name, args, span: owner.span, ...(owner.body === undefined ? {} : { body: owner.body }) },
      template,
      ctx,
      state,
      walkNarrative,
    );
    return;
  }
  // 普通函数 / adapter 基础库函数：实参里的表引用先求值，再把调用交给 lower 的发射器
  hoist(refsOfExprs(args, ctx), ctx, state);
  const rewritten = args.map((arg) => rewriteExpandExpr(arg, ctx));
  const callNode = { kind: 'call' as const, name, args: rewritten, span: owner.span };
  lowerDispatchNodes([callNode], state, (body) => walkNarrative(body, ctx, state));
}

/* ============================== 叙事体走法 ============================== */

export const walkNarrative: WalkNarrative = (nodes, ctx, state) => {
  for (const node of nodes) walkNarrativeNode(node, ctx, state);
};

function walkNarrativeNode(node: KojoNarrativeNode, ctx: ExpandContext, state: LowerState): void {
  switch (node.kind) {
    case 'textLine': {
      const refs = refsOfParts(node.parts, ctx);
      if (!needsRewrite(refs, ctx)) {
        lowerNarrativeNodes([node], state);
        return;
      }
      hoist(refs, ctx, state);
      lowerNarrativeNodes([{ ...node, parts: rewriteParts(node.parts, ctx) }], state);
      return;
    }
    case 'blankLine':
    case 'nativeBlock':
    case 'faceLine':
      lowerNarrativeNodes([node], state);
      return;
    case 'conditionChain': {
      const tests: KojoExprText[] = [];
      for (const branch of node.branches) if (branch.test !== null) tests.push(branch.test);
      hoist(refsOfExprs(tests, ctx), ctx, state);
      lowerConditionChain(
        rewriteBranchesTests(node.branches, ctx),
        state,
        (body) => walkNarrative(body, ctx, state),
        (body) => narrativeSifBody(body, ctx),
      );
      return;
    }
    case 'colorBlock': {
      hoist(refsOfExprs([node.color], ctx), ctx, state);
      const rewritten = { ...node, color: rewriteExpandExpr(node.color, ctx) };
      lowerColorBlock(rewritten, state, (body) => walkNarrative(body, ctx, state));
      return;
    }
    case 'randomBlock': {
      // 隐藏槽名与 lower/presentation.ts 的公式一致：`__kojo_rand_<块头源行>`（core 只发引用，声明交 adapter）。
      // valueType 必须匹配**该 backend 实际会落哪个点**（§8.4）：只有真能落文本变体族时槽才是文本
      // （PRINTDATA/DATALIST，槽其实不引用）；其余（含 printdata 不支持 @组 时的 RAND+SELECTCASE 回落）
      // 槽是候选下标 → int。只看纯度会把 "group-text + randStyle=printdata" 误声明成 #DIMS。
      const purity = randomCandidatePurity(node.candidates, state);
      const randStyle = state.backend.profile.randStyle;
      const textLanding =
        (purity === 'single-line-text' && randStyle === 'printdata') ||
        (purity === 'group-text' && randStyle === 'printdatal');
      recordSlot(
        ctx,
        `__kojo_rand_${node.span.start.line}`,
        'random',
        textLanding ? 'string' : 'int',
        'random-slot',
      );
      lowerRandomBlock(node, state, (child, candidate) => {
        if (candidate.kind === 'randomGroup') {
          walkNarrative(candidate.body, ctx, child);
          return;
        }
        walkNarrative([candidate.line], ctx, child);
      });
      return;
    }
    case 'optionsBlock':
      // 2.0 主链：adapter 能力闸（fail-closed）+ ETB 计划；块体仍走 2.0 叙事 lower
      lowerOptionsBlockExpanded(node, { adapter: ctx.adapter }, state, (child, item) =>
        walkNarrative(item.body, ctx, child),
      );
      return;
    case 'sandboxBlock':
      lowerSandboxBlock(node, state, (body) => walkDispatch(body, ctx, state));
      return;
    case 'call':
      expandOrDelegateCall(node.name, node.args, node, ctx, state, walkNarrative);
      return;
    case 'whileLoop':
    case 'repeatLoop':
    case 'forEachLoop':
    case 'label':
    case 'jump':
    case 'loopJump':
      walkDispatch([node], ctx, state);
      return;
  }
}

/* ============================== 调度体走法 ============================== */

export const walkDispatch: WalkDispatch = (nodes, ctx, state) => {
  for (const node of nodes) walkDispatchNode(node, ctx, state);
};

function programFeatureEnabled(state: LowerState, key: 'while' | 'repeat' | 'foreach' | 'goto'): boolean {
  return state.backend.profile.programFeatures?.[key] === true;
}

function delegateLeaf(node: KojoDispatchNode, ctx: ExpandContext, state: LowerState): void {
  lowerDispatchNodes([node], state, (body) => walkNarrative(body, ctx, state));
}

function walkDispatchNode(node: KojoDispatchNode, ctx: ExpandContext, state: LowerState): void {
  switch (node.kind) {
    case 'assign': {
      hoist(refsOfExprs([node.value], ctx), ctx, state);
      delegateLeaf({ ...node, value: rewriteExpandExpr(node.value, ctx) }, ctx, state);
      return;
    }
    case 'call':
      expandOrDelegateCall(node.name, node.args, node, ctx, state, walkNarrative);
      return;
    case 'exprCall': {
      hoist(refsOfExprs([node.call], ctx), ctx, state);
      delegateLeaf({ ...node, call: rewriteExpandExpr(node.call, ctx) }, ctx, state);
      return;
    }
    case 'return': {
      const exprs = node.value === undefined ? [] : [node.value];
      hoist(refsOfExprs(exprs, ctx), ctx, state);
      delegateLeaf(
        node.value === undefined ? node : { ...node, value: rewriteExpandExpr(node.value, ctx) },
        ctx,
        state,
      );
      return;
    }
    case 'textLine': {
      const refs = refsOfParts(node.parts, ctx);
      if (!needsRewrite(refs, ctx)) {
        delegateLeaf(node, ctx, state);
        return;
      }
      hoist(refs, ctx, state);
      delegateLeaf({ ...node, parts: rewriteParts(node.parts, ctx) }, ctx, state);
      return;
    }
    case 'blankLine':
    case 'faceLine':
    case 'nativeBlock':
    case 'label':
    case 'jump':
    case 'loopJump':
      delegateLeaf(node, ctx, state);
      return;
    case 'dispatchCondition': {
      const tests: KojoExprText[] = [];
      for (const branch of node.branches) if (branch.test !== null) tests.push(branch.test);
      hoist(refsOfExprs(tests, ctx), ctx, state);
      const rewritten: KojoDispatchCondition = {
        kind: 'dispatchCondition',
        branches: node.branches.map((branch) => ({
          test: branch.test === null ? null : rewriteExpandExpr(branch.test, ctx),
          body: branch.body,
          span: branch.span,
        })),
        span: node.span,
      };
      lowerConditionChain(
        rewritten.branches,
        state,
        (body) => walkDispatch(body, ctx, state),
        (body) => dispatchSifBody(body, ctx),
      );
      return;
    }
    case 'whileLoop': {
      // 能力闸交给 lower 的发射器（诊断文案只有一份），未开启时它报完即返回
      if (!programFeatureEnabled(state, 'while')) {
        delegateLeaf(node, ctx, state);
        return;
      }
      hoist(refsOfExprs([node.test], ctx), ctx, state);
      emit(state, state.backend.program.whileHeader(rewriteExpandExpr(node.test, ctx)), node.span);
      state.loopDepth++;
      walkDispatch(node.body, ctx, state);
      state.loopDepth--;
      emit(state, state.backend.program.whileFooter(), node.span);
      return;
    }
    case 'repeatLoop': {
      if (!programFeatureEnabled(state, 'repeat')) {
        delegateLeaf(node, ctx, state);
        return;
      }
      const trimmed = node.count.text.trim();
      if (/^-?\d+$/.test(trimmed) && !(Number(trimmed) > 0 && Number.isSafeInteger(Number(trimmed)))) {
        // 静态非正次数由 lower 的发射器报 core/control/bad-repeat（同一份判据）
        delegateLeaf(node, ctx, state);
        return;
      }
      hoist(refsOfExprs([node.count], ctx), ctx, state);
      emit(state, state.backend.program.repeatHeader(rewriteExpandExpr(node.count, ctx)), node.span);
      state.loopDepth++;
      walkDispatch(node.body, ctx, state);
      state.loopDepth--;
      emit(state, state.backend.program.repeatFooter(), node.span);
      return;
    }
    case 'forEachLoop': {
      // 2.0 主链：adapter 集合声明 + 本文件数组事实 → 计划（失败零字节）→ `program.forEachLoop`
      // 落点（引擎关键字全在 adapter）。绑定名改写走帧作用域，出体即失效。
      lowerExpandedForEachLoop(node, ctx, state, walkNarrative, programFeatureEnabled(state, 'foreach'));
      return;
    }
    case 'sandboxBlock':
      lowerSandboxBlock(node, state, (body) => walkDispatch(body, ctx, state));
      return;
  }
}
