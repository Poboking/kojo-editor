/**
 * `# 模` 引用点展开（§7.2）：编译期文本模板 —— 参数替换 + `[插槽]` 填入 + 双向 source map。
 *
 * 口径（写死）：
 * - 参数只接受**字面量或简单标识符**（parser 保证）；替换分两个位面：
 *   * 文本位（`{原因}` 整段是参数名）：字符串/整数字面量直接落**纯文本**（打印值），
 *     标识符/表达式落**插值表达式**；
 *   * 表达式位（条件、赋值、实参…）：按名字位置替换成实参**源文本**；
 * - `[插槽]` 最多一个（parser 已报 multi-slot）；模板有槽但调用无缩进块 → `core/template/missing-slot`，
 *   调用有块但模板无槽 → `core/template/unexpected-slot`；两者都 fail-closed（不产字节）；
 * - 循环/深度检测复用 `core/pool/cycle`（池/模板共用码）；
 * - 展开体的每行 source map = 模板定义处的精确源 span + origins（调用处 + 模板定义处）；
 *   插槽内容来自调用处，其 source 即调用处节点的 span。
 */
import type {
  KojoAssignStmt,
  KojoCallStmt,
  KojoColorBlock,
  KojoConditionBranch,
  KojoConditionChain,
  KojoDispatchCondition,
  KojoDispatchNode,
  KojoExprCallStmt,
  KojoExprText,
  KojoFaceLine,
  KojoForEachLoop,
  KojoJumpStmt,
  KojoLabelStmt,
  KojoLoopJumpStmt,
  KojoNarrativeNode,
  KojoNativeBlock,
  KojoOptionItem,
  KojoOptionsBlock,
  KojoRandomBlock,
  KojoRandomCandidate,
  KojoRepeatLoop,
  KojoReturnStmt,
  KojoSandboxBlock,
  KojoTemplateDecl,
  KojoTextLine,
  KojoWhileLoop,
} from '../../ast.js';
import { decodeIntegerLiteral, decodeQuotedLiteral, isIdentifier } from '../../lexer.js';
import type { LowerState } from '../state.js';
import { expansionFrame, lowerWithFrame } from './frame.js';
import { collectTableRefs, ensureTables, tableLookup } from './tables.js';
import { reportAt } from './context.js';
import type { ExpandContext, WalkNarrative } from './context.js';
import { replaceIdentifiers, rewriteExpr } from './expr.js';
import type { NameNeighbors } from './expr.js';

/** 一个模板实参的两种位面形态 */
interface TemplateArg {
  /** 表达式位：实参源文本（原样带引号/标识符） */
  readonly expr: KojoExprText;
  /** 文本位：实参是字面量时的"打印值"；标识符/表达式为 null */
  readonly literalText: string | null;
}

/** 解析实参：字符串字面量 → 解码值；整数字面量 → 十进制源文本；其余 → 表达式 */
function toTemplateArg(expr: KojoExprText, ctx: ExpandContext): TemplateArg {
  const trimmed = expr.text.trim();
  const quoted = decodeQuotedLiteral(trimmed);
  if (quoted !== null) return { expr, literalText: quoted };
  const int = decodeIntegerLiteral(trimmed);
  if (int !== null) return { expr, literalText: String(int) };
  const refs = collectTableRefs(expr, ctx);
  return { expr: refs.length === 0 ? expr : rewriteExpr(expr, tableLookup(ctx)).expr, literalText: null };
}

function paramLookup(subs: ReadonlyMap<string, TemplateArg>): (name: string, neighbors: NameNeighbors) => string | undefined {
  return (name, neighbors) => {
    if (neighbors.after === '(' || neighbors.before === '.') return undefined;
    return subs.get(name)?.expr.text;
  };
}

/** 文本位替换：整段插值恰是参数名时，字面量直接变纯文本（打印值） */
function substituteParts(parts: KojoTextLine['parts'], subs: ReadonlyMap<string, TemplateArg>): KojoTextLine['parts'] {
  const lookup = paramLookup(subs);
  let changed = false;
  const next = parts.map((part): KojoTextLine['parts'][number] => {
    if (part.kind === 'text') return part;
    if (part.cond === undefined) {
      const name = part.expr.text.trim();
      if (isIdentifier(name)) {
        const arg = subs.get(name);
        if (arg !== undefined) {
          changed = true;
          if (arg.literalText !== null) return { kind: 'text', text: arg.literalText };
          return { kind: 'interp', expr: arg.expr };
        }
      }
      const expr = replaceIdentifiers(part.expr.text, lookup);
      if (!expr.changed) return part;
      changed = true;
      return { kind: 'interp', expr: { text: expr.text, span: part.expr.span } };
    }
    const cond = replaceIdentifiers(part.cond.cond.text, lookup);
    const then = replaceIdentifiers(part.cond.then.text, lookup);
    const els = replaceIdentifiers(part.cond.else.text, lookup);
    if (!cond.changed && !then.changed && !els.changed) return part;
    changed = true;
    return {
      kind: 'interp',
      expr: part.expr,
      cond: {
        cond: { text: cond.text, span: part.cond.cond.span },
        then: { text: then.text, span: part.cond.then.span },
        else: { text: els.text, span: part.cond.else.span },
      },
    };
  });
  return changed ? next : parts;
}

function substituteExpr(expr: KojoExprText, subs: ReadonlyMap<string, TemplateArg>): KojoExprText {
  const rewrite = replaceIdentifiers(expr.text, paramLookup(subs));
  return rewrite.changed ? { text: rewrite.text, span: expr.span } : expr;
}

function substituteBranches(branches: readonly KojoConditionBranch[], subs: ReadonlyMap<string, TemplateArg>): readonly KojoConditionBranch[] {
  return branches.map((branch) => ({
    test: branch.test === null ? null : substituteExpr(branch.test, subs),
    body: substituteNarrativeNodes(branch.body, subs),
    span: branch.span,
  }));
}

function substituteCandidates(candidates: readonly KojoRandomCandidate[], subs: ReadonlyMap<string, TemplateArg>): readonly KojoRandomCandidate[] {
  return candidates.map((candidate): KojoRandomCandidate => {
    if (candidate.kind === 'randomGroup') {
      return { kind: 'randomGroup', body: substituteNarrativeNodes(candidate.body, subs), span: candidate.span };
    }
    const line = candidate.line;
    const nextLine: KojoTextLine | typeof line =
      line.kind === 'textLine' ? { ...line, parts: substituteParts(line.parts, subs) } : line;
    return { kind: 'randomLine', line: nextLine, span: candidate.span };
  });
}

function substituteOptions(items: readonly KojoOptionItem[], subs: ReadonlyMap<string, TemplateArg>): readonly KojoOptionItem[] {
  return items.map((item) => ({ label: item.label, body: substituteNarrativeNodes(item.body, subs), span: item.span }));
}

function substituteDispatchNodes(nodes: readonly KojoDispatchNode[], subs: ReadonlyMap<string, TemplateArg>): readonly KojoDispatchNode[] {
  return nodes.map((node): KojoDispatchNode => substituteDispatchNode(node, subs));
}

function substituteDispatchNode(node: KojoDispatchNode, subs: ReadonlyMap<string, TemplateArg>): KojoDispatchNode {
  switch (node.kind) {
    case 'assign': {
      const next: KojoAssignStmt = {
        kind: 'assign',
        target: { text: replaceIdentifiers(node.target.text, paramLookup(subs)).text, span: node.target.span },
        op: node.op,
        value: substituteExpr(node.value, subs),
        span: node.span,
      };
      return next;
    }
    case 'call':
      return {
        kind: 'call',
        name: node.name,
        args: node.args.map((arg) => substituteExpr(arg, subs)),
        ...(node.body === undefined ? {} : { body: substituteNarrativeNodes(node.body, subs) }),
        span: node.span,
      } satisfies KojoCallStmt;
    case 'exprCall':
      return { kind: 'exprCall', call: substituteExpr(node.call, subs), span: node.span } satisfies KojoExprCallStmt;
    case 'return':
      return {
        kind: 'return',
        ...(node.value === undefined ? {} : { value: substituteExpr(node.value, subs) }),
        span: node.span,
      } satisfies KojoReturnStmt;
    case 'whileLoop':
      return {
        kind: 'whileLoop',
        test: substituteExpr(node.test, subs),
        body: substituteDispatchNodes(node.body, subs),
        span: node.span,
      } satisfies KojoWhileLoop;
    case 'repeatLoop':
      return {
        kind: 'repeatLoop',
        count: substituteExpr(node.count, subs),
        body: substituteDispatchNodes(node.body, subs),
        span: node.span,
      } satisfies KojoRepeatLoop;
    case 'forEachLoop':
      return {
        kind: 'forEachLoop',
        collection: substituteExpr(node.collection, subs),
        body: substituteNarrativeNodes(node.body, subs),
        span: node.span,
      } satisfies KojoForEachLoop;
    case 'dispatchCondition': {
      const next: KojoDispatchCondition = {
        kind: 'dispatchCondition',
        branches: node.branches.map((branch) => ({
          test: branch.test === null ? null : substituteExpr(branch.test, subs),
          body: substituteDispatchNodes(branch.body, subs),
          span: branch.span,
        })),
        span: node.span,
      };
      return next;
    }
    case 'sandboxBlock':
      return {
        kind: 'sandboxBlock',
        body: substituteDispatchNodes(node.body, subs),
        span: node.span,
      } satisfies KojoSandboxBlock;
    case 'textLine':
      return { ...node, parts: substituteParts(node.parts, subs) };
    case 'blankLine':
    case 'faceLine':
    case 'nativeBlock':
    case 'loopJump':
    case 'label':
    case 'jump':
      return node;
  }
}

function substituteNarrativeNodes(nodes: readonly KojoNarrativeNode[], subs: ReadonlyMap<string, TemplateArg>): readonly KojoNarrativeNode[] {
  return nodes.map((node): KojoNarrativeNode => substituteNarrativeNode(node, subs));
}

function substituteNarrativeNode(node: KojoNarrativeNode, subs: ReadonlyMap<string, TemplateArg>): KojoNarrativeNode {
  switch (node.kind) {
    case 'textLine':
      return { ...node, parts: substituteParts(node.parts, subs) };
    case 'blankLine':
    case 'nativeBlock':
    case 'faceLine':
    case 'loopJump':
    case 'label':
    case 'jump':
      return node;
    case 'conditionChain': {
      const next: KojoConditionChain = { kind: 'conditionChain', branches: substituteBranches(node.branches, subs), span: node.span };
      return next;
    }
    case 'colorBlock': {
      const next: KojoColorBlock = {
        kind: 'colorBlock',
        color: substituteExpr(node.color, subs),
        body: substituteNarrativeNodes(node.body, subs),
        span: node.span,
      };
      return next;
    }
    case 'randomBlock': {
      const next: KojoRandomBlock = {
        kind: 'randomBlock',
        candidates: substituteCandidates(node.candidates, subs),
        span: node.span,
      };
      return next;
    }
    case 'optionsBlock': {
      const next: KojoOptionsBlock = { kind: 'optionsBlock', items: substituteOptions(node.items, subs), span: node.span };
      return next;
    }
    case 'sandboxBlock':
      return {
        kind: 'sandboxBlock',
        body: substituteDispatchNodes(node.body, subs),
        span: node.span,
      } satisfies KojoSandboxBlock;
    case 'call':
      return substituteDispatchNode(node, subs) as KojoNarrativeNode;
    case 'whileLoop':
    case 'repeatLoop':
    case 'forEachLoop':
      return substituteDispatchNode(node, subs) as KojoNarrativeNode;
  }
}

/** 模板调用展开 */
export function expandTemplateCall(call: KojoCallStmt, template: KojoTemplateDecl, ctx: ExpandContext, state: LowerState, walk: WalkNarrative): void {
  const slotContent = call.body;
  if (template.slotIndex !== null && (slotContent === undefined || slotContent.length === 0)) {
    reportAt(ctx, 'core/template/missing-slot', `模板「${template.name}」有 [插槽]，但调用处没有缩进块：请把插槽内容缩进写在 \`! ${template.name}(…)\` 下面（§7.2）。`, call.span);
    return;
  }
  if (template.slotIndex === null && slotContent !== undefined && slotContent.length > 0) {
    reportAt(ctx, 'core/template/unexpected-slot', `模板「${template.name}」没有 [插槽]，但调用处写了缩进块：缩进块只用来填 [插槽]（§7.2）。`, call.span);
    return;
  }
  if (call.args.length !== template.params.length) {
    reportAt(
      ctx,
      'core/template/arg-count',
      `模板「${template.name}」声明了 ${template.params.length} 个参数，调用处给了 ${call.args.length} 个。`,
      call.span,
    );
    return;
  }
  if (ctx.templateStack.includes(template.name)) {
    reportAt(ctx, 'core/pool/cycle', `模板「${template.name}」直接或间接调用了自己：编译期展开会无限循环（§7.2）。`, call.span);
    return;
  }
  if (ctx.templateStack.length >= ctx.maxDepth) {
    reportAt(ctx, 'core/pool/cycle', `模板「${template.name}」展开深度超过 ${ctx.maxDepth} 层：疑似循环调用。`, call.span);
    return;
  }

  // 实参里的表引用：先在调用点求值（隐藏槽），再把"已替换源文本"交给模板
  const args: TemplateArg[] = [];
  for (let i = 0; i < call.args.length; i++) {
    const raw = call.args[i]!;
    const refs = collectTableRefs(raw, ctx);
    if (refs.length > 0) ensureTables(refs, ctx, state);
    args.push(toTemplateArg(refs.length === 0 ? raw : rewriteExpr(raw, tableLookup(ctx)).expr, ctx));
  }
  const subs = new Map<string, TemplateArg>();
  for (let i = 0; i < template.params.length; i++) subs.set(template.params[i]!.name, args[i]!);

  const expanded: KojoNarrativeNode[] = [];
  for (let i = 0; i < template.body.length; i++) {
    if (template.slotIndex === i) {
      for (const node of slotContent ?? []) expanded.push(node);
    }
    expanded.push(substituteNarrativeNode(template.body[i]!, subs));
  }
  // 插槽在模板体末尾（slotIndex === body.length）
  if (template.slotIndex === template.body.length) {
    for (const node of slotContent ?? []) expanded.push(node);
  }

  const frame = expansionFrame('template', call.span, template.span);
  ctx.templateStack.push(template.name);
  try {
    lowerWithFrame(expanded, ctx, state, frame, walk);
  } finally {
    ctx.templateStack.pop();
  }
}
