/**
 * 展开帧：模板/池展开出的行要**同时**指向调用处与定义处（§10.7 双向）。
 *
 * 做法：把展开出来的体先降糖进**子缓冲**（复用既有 lower 发射器），再把子缓冲的行
 * 逐行搬进父缓冲，source map 用"子行的精确源 span + 帧 origins"重新登记：
 * - 不抄第二份降糖逻辑；
 * - 嵌套展开（模板里再调模板/池）的 origins 逐层合并；
 * - 纯生成行（子 map 里 source=null）保持 `generated`，不伪造源。
 */
import type { KojoNarrativeNode } from '../../ast.js';
import { comparePositions } from '../../positions.js';
import type { SourceMapLineKind, SourceMapOrigin } from '../../source-map.js';
import { createEmitBuffer } from '../buffer.js';
import type { LowerState } from '../state.js';
import type { ExpandContext, WalkNarrative } from './context.js';

export type ExpansionFrameKind = 'pool' | 'template';

export interface ExpansionFrame {
  readonly kind: ExpansionFrameKind;
  readonly origins: readonly SourceMapOrigin[];
}

/** 构造一个展开帧（调用处 + 定义处；两个 origin 都是 source map 双向跳转的锚点） */
export function expansionFrame(kind: ExpansionFrameKind, callSite: SourceMapOrigin['span'], definition: SourceMapOrigin['span']): ExpansionFrame {
  return {
    kind,
    origins:
      kind === 'template'
        ? [
            { kind: 'call-site', span: callSite },
            { kind: 'template-definition', span: definition },
          ]
        : [
            { kind: 'call-site', span: callSite },
            { kind: 'pool-definition', span: definition },
          ],
  };
}

function sameOrigin(a: SourceMapOrigin, b: SourceMapOrigin): boolean {
  return (
    a.kind === b.kind &&
    comparePositions(a.span.start, b.span.start) === 0 &&
    comparePositions(a.span.end, b.span.end) === 0
  );
}

/** 合并 origins（去重；顺序 = 外层帧在前、子层在后，稳定可断言） */
export function mergeOrigins(outer: readonly SourceMapOrigin[], inner: readonly SourceMapOrigin[]): readonly SourceMapOrigin[] {
  if (inner.length === 0) return outer;
  const merged = outer.slice();
  for (const origin of inner) if (!merged.some((existing) => sameOrigin(existing, origin))) merged.push(origin);
  return merged;
}

/**
 * 在子缓冲里降糖 `nodes`，再把结果按帧重新登记进父缓冲。
 *
 * 子状态复制父状态（颜色/循环深度等），子体里的状态变化不泄漏回父体——展开体是
 * 自足的一段（池/模板内部状态不影响调用点后面的降糖）。
 *
 * 列级（additive）：搬进父缓冲的每条展开行**整行一段**列级分段——`source` = 子行的精确
 * 源 span（模板/池定义处那一行），`origins` = 帧锚点 + 子行锚点（调用处在最前）。这样
 * 宿主按列点进展开行也能拿到"调用处 + 定义处"两个锚点，而不用先猜这一行属于哪个块。
 */
export function lowerWithFrame(
  nodes: readonly KojoNarrativeNode[],
  ctx: ExpandContext,
  state: LowerState,
  frame: ExpansionFrame,
  walk: WalkNarrative,
): void {
  const childBuffer = createEmitBuffer(Math.max(8, nodes.length * 2));
  const childState: LowerState = { ...state, buffer: childBuffer };
  walk(nodes, ctx, childState);
  const finished = childBuffer.finish();
  const kind: SourceMapLineKind = frame.kind;
  for (let i = 0; i < finished.lines.length; i++) {
    const line = finished.lines[i]!;
    const mapped = finished.sourceMap.lineAt(i + 1);
    if (mapped === null || mapped.source === null) {
      state.buffer.push(line, { kind: 'generated', source: null });
      continue;
    }
    const origins = mergeOrigins(frame.origins, mapped.origins);
    state.buffer.push(line, {
      kind,
      source: mapped.source,
      origins,
      // 整行一段：起点 1、终点由 buffer 按行宽补成 `行宽 + 1`（排他）
      segments: [{ startColumn: 1, source: mapped.source, kind, origins }],
    });
  }
}
