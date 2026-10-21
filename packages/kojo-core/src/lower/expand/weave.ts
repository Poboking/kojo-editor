/**
 * `@织` 监听装配（展开感知版，§8.6）：
 * - 事件目录/参数形状走 adapter 的 `eventCatalog`（未知事件不产事件头）；
 * - **每个监听是独立 ERB 函数**：先把监听体降糖进子缓冲（这样 head 能带上"该监听体实际
 *   用到的隐藏槽"），再发 `weaveHeader({….slots})` + body 行 + `weaveFooter()`；
 * - 监听体的槽**只进自己的清单**，不并进主 `# 机` 的 `wrapMachine.slots`（局部槽跨函数不可见）；
 * - 修饰词冲突/优先级模型闸与 `lower/weave.ts` 同判据同文案（那边是单文件 lower 入口，
 *   这里是展开感知入口；两处都保留是为了不让任一路径静默降级）。
 */
import type { KojoWeaveDecl } from '../../ast.js';
import { checkEventArgs, checkEvent } from '../../adapter.js';
import { createEmitBuffer } from '../buffer.js';
import type { LowerState } from '../state.js';
import { segmentSpecsOf } from '../../source-map.js';
import { captureSlots, reportAt, reportDiagnostic } from './context.js';
import type { ExpandContext, WalkNarrative } from './context.js';

export function assembleWeave(decl: KojoWeaveDecl, ctx: ExpandContext, state: LowerState, walk: WalkNarrative): void {
  const unknown = checkEvent(ctx.adapter, decl.event, decl.span);
  if (unknown !== null) {
    reportDiagnostic(ctx, unknown);
    return; // 事件不在目录里：不产无效事件头字节
  }
  for (const diagnostic of checkEventArgs(ctx.adapter, decl.event, decl.args, decl.span)) {
    reportDiagnostic(ctx, diagnostic);
  }

  // 修饰词判定（与 lower/weave.ts 同文案）
  const seen = new Set<string>();
  let conflict = false;
  for (const modifier of decl.modifiers) {
    if (seen.has(modifier)) {
      reportAt(ctx, 'core/weave/modifier-conflict', `\`@织 ${decl.event}\` 的修饰词重复（${modifier}）：每个修饰词最多写一次。`, decl.span);
      conflict = true;
    }
    seen.add(modifier);
  }
  if (seen.has('only') && seen.size > 1) {
    reportAt(ctx, 'core/weave/modifier-conflict', `\`@织 ${decl.event}\`：\`接管\` 不能与 \`之前\` / \`之后\` 并用。`, decl.span);
    conflict = true;
  }
  const needsPriorityBuckets = decl.modifiers.length > 0;
  if (needsPriorityBuckets && state.backend.profile.priorityModel !== 'emuera-buckets') {
    reportAt(
      ctx,
      'core/weave/unsupported',
      `当前 adapter（${state.backend.id}）没有声明事件优先级模型（profile.priorityModel = emuera-buckets）：\`之前\` / \`之后\` / \`接管\` 不可用。请去掉修饰词或用 \`@原生\`。`,
      decl.span,
    );
    return;
  }
  if (conflict) return;

  // 先降 body（独立槽作用域 + 子缓冲），再发 head/body/footer
  const bodyBuffer = createEmitBuffer(Math.max(8, decl.body.length * 2));
  const bodyState: LowerState = {
    ...state,
    buffer: bodyBuffer,
    region: 'narrative',
    color: null,
    colorClosed: false,
    loopDepth: 0,
    weaveDepth: state.weaveDepth + 1,
  };
  const slots = captureSlots(ctx, () => walk(decl.body, ctx, bodyState));
  const bodyFinished = bodyBuffer.finish();

  state.buffer.pushEmitted(
    state.backend.weave.weaveHeader({
      event: decl.event,
      args: decl.args,
      modifiers: decl.modifiers,
      span: decl.span,
      slots,
    }),
    { source: decl.span },
    ctx.sink,
  );
  for (let i = 0; i < bodyFinished.lines.length; i++) {
    const line = bodyFinished.lines[i]!;
    const mapped = bodyFinished.sourceMap.lineAt(i + 1);
    if (mapped === null || mapped.source === null) {
      state.buffer.push(line, { kind: 'generated', source: null });
    } else {
      // 列级事实随行搬（additive）：监听体里的模板/池展开分段不能在装配时丢掉
      const segments = segmentSpecsOf(mapped);
      state.buffer.push(line, {
        kind: mapped.kind,
        source: mapped.source,
        origins: mapped.origins,
        ...(segments === undefined ? {} : { segments }),
      });
    }
  }
  state.buffer.pushEmitted(state.backend.weave.weaveFooter(), { source: decl.span }, ctx.sink);
}
