/**
 * 叙事节点分发器（叙事区的"脸"在这里汇合；各脸的实现各自成模块，避免 god file）。
 *
 * 依赖方向是单向的：`narrative` → `text / condition / native / presentation / program`；
 * 需要往回收体的模块（`@着色` / `@随机` / `?` / 循环 / `@织`）一律**收回调**，
 * 谁也不 import 谁，杜绝循环 import。
 */
import type { KojoNarrativeNode, KojoRandomCandidate } from '../ast.js';
import { isSingleLineNarrativeNode, lowerConditionChain } from './condition.js';
import { lowerNativeBlock } from './native.js';
import { lowerBlankLine, lowerTextLine } from './text.js';
import { lowerColorBlock, lowerFaceLine, lowerOptionsBlock, lowerRandomBlock } from './presentation.js';
import { lowerDispatchNodes, lowerSandboxBlock } from './program.js';
import type { LowerState } from './state.js';

/** 叙事节点序列降糖（顶层正文 / 块体 / 分支体 / 候选体共用） */
export function lowerNarrativeNodes(nodes: readonly KojoNarrativeNode[], state: LowerState): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'textLine':
        lowerTextLine(node, state);
        break;
      case 'blankLine':
        lowerBlankLine(node, state);
        break;
      case 'conditionChain':
        // §5.4：链在程序块里按同一规则收束；first-match + SIF 只对"至多一行"的节点开放
        lowerConditionChain(
          node.branches,
          state,
          (body) => lowerNarrativeNodes(body, state),
          (body) => body.length === 1 && isSingleLineNarrativeNode(body[0]!),
        );
        break;
      case 'colorBlock':
        lowerColorBlock(node, state, (body) => lowerNarrativeNodes(body, state));
        break;
      case 'randomBlock':
        lowerRandomBlock(node, state, (child, candidate) => lowerRandomCandidate(candidate, child));
        break;
      case 'nativeBlock':
        lowerNativeBlock(node, state);
        break;
      case 'sandboxBlock':
        lowerSandboxBlock(node, state, (body) => lowerDispatchNodes(body, state, (inner) => lowerNarrativeNodes(inner, state)));
        break;
      case 'faceLine':
        lowerFaceLine(node, state);
        break;
      case 'optionsBlock':
        lowerOptionsBlock(node, state, (child, item) => lowerNarrativeNodes(item.body, child));
        break;
      /* 叙事区可直接写 `! 池名 / ! 模名(...) / ! 函名(...)`（§4.9）与 program 控制块（§9）：
         形状全部复用调度区分发器（它已含显式打印节点），不复制第二份判据 */
      case 'call':
      case 'whileLoop':
      case 'repeatLoop':
      case 'forEachLoop':
      case 'loopJump':
      case 'label':
      case 'jump':
        lowerDispatchNodes([node], state, (body) => lowerNarrativeNodes(body, state));
        break;
    }
  }
}

/** `@随机` 候选：单行文本 / `@组`（组内按叙事规则继续降糖） */
function lowerRandomCandidate(candidate: KojoRandomCandidate, state: LowerState): void {
  if (candidate.kind === 'randomGroup') {
    lowerNarrativeNodes(candidate.body, state);
    return;
  }
  const line = candidate.line;
  if (line.kind === 'textLine') lowerTextLine(line, state);
  else lowerBlankLine(line, state);
}
