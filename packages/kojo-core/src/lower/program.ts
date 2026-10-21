/**
 * 调度区 / program 层 lowering 骨架（§8.1 / §9 / §16.2 C2.8）。
 *
 * 本阶段（C2）只做"形状与顺序"：`@算` 视觉分组、赋值/调用、`?` 调度链、
 * 循环/跳转/返回的**能力闸**与 `@着色` 控制转移清理。真正的 ERB 语句由 adapter
 * 的 `KojoProgramEmitter` 一发一条给出（core 不写死任何关键字）。
 *
 * 控制转移与颜色（§9.7）：`@断`/`@续`/`@返`/`@跳` 离开 `@着色` 块时自动插 RESETCOLOR，
 * 作者不用手工补；已收口的不重复补（`state.colorClosed`）。
 */
import type {
  KojoDispatchNode,
  KojoExprText,
  KojoForEachLoop,
  KojoRepeatLoop,
  KojoSandboxBlock,
  KojoSpan,
  KojoWhileLoop,
} from '../ast.js';
import { lowerConditionChain } from './condition.js';
import type { ProgramFeatureKey } from '../adapter.js';
import { checkFeature } from './feature-gate.js';
import { lowerNativeBlock } from './native.js';
import { lowerFaceLine } from './presentation.js';
import { lowerBlankLine, lowerTextLine } from './text.js';
import type { LowerDispatchBody, LowerNarrativeBody, LowerState } from './state.js';
import { emit, report, reportFeature } from './state.js';

const DECIMAL_INT_RE = /^-?\d+$/;

/** 控制转移前收口颜色（不重复 RESETCOLOR） */
function closeColorOnTransfer(state: LowerState, span: KojoSpan): void {
  if (state.color !== null && !state.colorClosed) {
    emit(state, state.backend.presentation.colorExit(), span);
    state.colorClosed = true;
  }
}

/**
 * 能力闸（K2-FEATURE-GATE-UNIFY）：判定 / 码 / 文案都来自统一入口 `feature-gate.ts`。
 *
 * 主链不再自己读 `profile.programFeatures`——本函数与 `expand/walk.ts` 的
 * `programFeatureEnabled` 读的是**同一份** `state.featureGate`，产物面与诊断面不可能分叉。
 */
function featureFlag(state: LowerState, key: ProgramFeatureKey, span: KojoSpan): boolean {
  const check = checkFeature(state.featureGate, key, span);
  reportFeature(state, check);
  return check.enabled;
}

/** `@算` 块：视觉分组（无运行时表示时 adapter 返回 null），体是调度节点 */
export function lowerSandboxBlock(node: KojoSandboxBlock, state: LowerState, lowerBody: LowerDispatchBody): void {
  emit(state, state.backend.program.sandboxEnter(), node.span);
  const savedRegion = state.region;
  state.region = 'dispatch';
  lowerBody(node.body);
  state.region = savedRegion;
  emit(state, state.backend.program.sandboxExit(), node.span);
}

/** 调度节点序列降糖（`@算` / `@函` / 循环体共用一个分发器） */
export function lowerDispatchNodes(nodes: readonly KojoDispatchNode[], state: LowerState, lowerNarrativeBody: LowerNarrativeBody): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'assign':
        emit(state, state.backend.program.assign({ target: node.target, op: node.op, value: node.value, span: node.span }), node.span);
        break;
      case 'call':
        emit(state, state.backend.program.call({ name: node.name, args: node.args, span: node.span }), node.span);
        break;
      case 'exprCall':
        emit(state, state.backend.program.exprCall({ call: node.call, span: node.span }), node.span);
        break;
      case 'loopJump':
        if (state.loopDepth === 0) {
          report(
            state,
            node.mode === 'break' ? 'core/control/break-outside' : 'core/control/continue-outside',
            `\`@${node.mode === 'break' ? '断' : '续'}\` 只能出现在 \`@循\` / \`@巡\` / \`@复\` 体内（这里是循环外）。`,
            node.span,
          );
          break;
        }
        closeColorOnTransfer(state, node.span);
        emit(state, state.backend.program.loopJump(node.mode), node.span);
        break;
      case 'return':
        if (state.functionDepth === 0) {
          report(state, 'core/func/return-outside', '`@返` 只能在 `@函` 体内使用；场景/监听体用缩进收口结束，不写 `@返`。', node.span);
          break;
        }
        closeColorOnTransfer(state, node.span);
        emit(state, state.backend.program.returnValue(node.value ?? null), node.span);
        break;
      case 'label':
        emit(state, state.backend.program.label(node.name), node.span);
        break;
      case 'jump':
        if (!featureFlag(state, 'goto', node.span)) break;
        closeColorOnTransfer(state, node.span);
        emit(state, state.backend.program.jump(node.target), node.span);
        break;
      case 'dispatchCondition':
        lowerConditionChain(
          node.branches,
          state,
          (body) => lowerDispatchNodes(body, state, lowerNarrativeBody),
          (body) => body.length === 1 && isSingleLineDispatchNode(body[0]!),
        );
        break;
      case 'whileLoop':
        lowerWhileLoop(node, state, lowerNarrativeBody);
        break;
      case 'repeatLoop':
        lowerRepeatLoop(node, state, lowerNarrativeBody);
        break;
      case 'forEachLoop':
        lowerForEachLoop(node, state, lowerNarrativeBody);
        break;
      case 'sandboxBlock':
        lowerSandboxBlock(node, state, (body) => lowerDispatchNodes(body, state, lowerNarrativeBody));
        break;
      case 'nativeBlock':
        lowerNativeBlock(node, state);
        break;
      /* 调度区允许显式打印（§4.1：`@函` / 循环体内可写 `>` / `角色：`） */
      case 'textLine':
        lowerTextLine(node, state);
        break;
      case 'blankLine':
        lowerBlankLine(node, state);
        break;
      case 'faceLine':
        lowerFaceLine(node, state);
        break;
    }
  }
}

/** `SIF` 只对"至多产一行"的调度节点开放（契约见 backend.ts 第 1 条） */
function isSingleLineDispatchNode(node: KojoDispatchNode): boolean {
  return node.kind === 'assign' || node.kind === 'call' || node.kind === 'exprCall';
}

function lowerWhileLoop(node: KojoWhileLoop, state: LowerState, lowerNarrativeBody: LowerNarrativeBody): void {
  if (!featureFlag(state, 'while', node.span)) return;
  emit(state, state.backend.program.whileHeader(node.test), node.span);
  state.loopDepth++;
  lowerDispatchNodes(node.body, state, lowerNarrativeBody);
  state.loopDepth--;
  emit(state, state.backend.program.whileFooter(), node.span);
}

function repeatCountOf(count: KojoExprText): number | null {
  return DECIMAL_INT_RE.test(count.text.trim()) ? Number(count.text.trim()) : null;
}

function lowerRepeatLoop(node: KojoRepeatLoop, state: LowerState, lowerNarrativeBody: LowerNarrativeBody): void {
  if (!featureFlag(state, 'repeat', node.span)) return;
  const count = repeatCountOf(node.count);
  if (count !== null && !(Number.isSafeInteger(count) && count > 0)) {
    report(state, 'core/control/bad-repeat', `\`@复\` 的次数必须是正整数字面量或整数常量（这里静态可证为 ${count}）。`, node.span);
    return;
  }
  emit(state, state.backend.program.repeatHeader(node.count), node.span);
  state.loopDepth++;
  lowerDispatchNodes(node.body, state, lowerNarrativeBody);
  state.loopDepth--;
  emit(state, state.backend.program.repeatFooter(), node.span);
}

function lowerForEachLoop(node: KojoForEachLoop, state: LowerState, lowerNarrativeBody: LowerNarrativeBody): void {
  if (!featureFlag(state, 'foreach', node.span)) return;
  emit(state, state.backend.program.forEachHeader(node.collection), node.span);
  state.loopDepth++;
  lowerNarrativeBody(node.body);
  state.loopDepth--;
  emit(state, state.backend.program.forEachFooter(), node.span);
}
