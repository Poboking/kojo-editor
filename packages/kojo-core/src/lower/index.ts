/**
 * `@kojo/kojo-core` 降糖层公共入口。
 *
 * 分层（单一职责，逐文件）：
 * - `backend.ts`  —— `KojoEmitBackend`：core 与 adapter 的**唯一**外注边界；
 * - `buffer.ts`   —— 产物缓冲：每行 O(1) 追加、预分配、source map 同步登记；
 * - `state.ts`    —— 单次 lowering 的局部状态与发射助手（唯一的可变点）；
 * - `text.ts`     —— 文本三正交（speech × color × wait）+ 空行三态；
 * - `condition.ts`—— `?` 链 first-match + SIF 降级；
 * - `native.ts`   —— `@原生` 逐行透传（折回物理行）；
 * - `presentation.ts` —— `@着色` / `@颜绘` / `@随机` 骨架；
 * - `expand/options.ts` —— `选项` 的 ETB 计划 + 2.0 主链降糖（adapter UI 能力闸）；
 * - `program.ts`  —— 调度区 / program 形状（`@算`、循环、跳转、返回、颜色清理）；
 * - `weave.ts`    —— `@织` 监听骨架；
 * - `narrative.ts`—— 叙事节点分发器（唯一的"汇合点"）。
 *
 * 本文件只做装配：`lowerFile` / `lowerNarrative`。**纯函数、零 IO**：
 * 不读盘、不认识 Monaco、不认识任何具体游戏。
 */
import type { KojoDecl, KojoFile, KojoNarrativeNode } from '../ast.js';
import type { DiagnosticCode, DiagnosticSink, KojoDiagnostic } from '../diagnostics.js';
import { createDiagnosticSink } from '../diagnostics.js';
import type { SourceMap } from '../source-map.js';
import type { KojoEmitBackend } from './backend.js';
import { createEmitBuffer } from './buffer.js';
import { lowerNarrativeNodes } from './narrative.js';
import { createLowerState } from './state.js';
import { lowerWeave } from './weave.js';

export interface LowerOptions {
  readonly backend: KojoEmitBackend;
  /** 当前 `# 视` 目标（池内裸引号默认说话人）；缺省 null */
  readonly view?: string | null;
  /** 预分配行数（大文件传入估算值，省一次数组扩容） */
  readonly estimatedLines?: number;
  /** 外部诊断收集器（增量/多文件共用一个 sink 时传入） */
  readonly sink?: DiagnosticSink;
}

export interface LowerResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly KojoDiagnostic[];
}

function lowerInto(
  state: ReturnType<typeof createLowerState>,
  scenes: KojoFile['scenes'],
  decls: readonly KojoDecl[],
): void {
  // `# 幕` 是演出顺序标记、不产字节；包装函数/事件头由 adapter 装配层负责（§10.7 映射事件头）。
  for (const scene of scenes) lowerNarrativeNodes(scene.items, state);
  for (const decl of decls) {
    if (decl.kind === 'weave') {
      lowerWeave(decl, state, (body) => lowerNarrativeNodes(body, state));
    }
    // 其余声明是数据（表 plan / 池 / 模板 / 函数）：各自模块或 adapter 装配层消费，这里不产正文。
  }
}

function finishLowering(
  state: ReturnType<typeof createLowerState>,
  sink: DiagnosticSink,
): LowerResult {
  const finished = state.buffer.finish();
  return {
    ok: !sink.hasError(),
    lines: finished.lines,
    sourceMap: finished.sourceMap,
    diagnostics: sink.all,
  };
}

function makeState(options: LowerOptions, sink: DiagnosticSink) {
  const buffer = createEmitBuffer(options.estimatedLines ?? 256);
  const state = createLowerState({ backend: options.backend, buffer, sink, view: options.view ?? null });
  return { state, sink };
}

/** 解析器阶段诊断 → core 诊断（C1 契约：`KojoFile.diagnostics.code` 是 core 码字符串） */
function adoptFileDiagnostic(diagnostic: KojoFile['diagnostics'][number]): KojoDiagnostic {
  return {
    code: diagnostic.code as DiagnosticCode,
    severity: diagnostic.severity,
    message: diagnostic.message,
    span: diagnostic.span,
  };
}

/** 文件里的 `# 视 <目标>`（池内裸引号默认说话人）；没有则 null */
function viewOf(file: KojoFile): string | null {
  for (const decl of file.decls) if (decl.kind === 'view') return decl.target;
  return null;
}

/** 降糖一个文件的正文 + `@织` 监听（声明提升的 `decls` 里只消费 `@织`；其余是数据/其它阶段） */
export function lowerFile(file: KojoFile, options: LowerOptions): LowerResult {
  const sink = options.sink ?? createDiagnosticSink();
  for (const diagnostic of file.diagnostics) sink.report(adoptFileDiagnostic(diagnostic));
  const { state } = makeState(
    { ...options, view: options.view !== undefined ? options.view : viewOf(file) },
    sink,
  );
  lowerInto(state, file.scenes, file.decls);
  return finishLowering(state, sink);
}

/** 降糖一段叙事节点（微基准 / 块级预览用；不消费声明） */
export function lowerNarrative(nodes: readonly KojoNarrativeNode[], options: LowerOptions): LowerResult {
  const sink = options.sink ?? createDiagnosticSink();
  const { state } = makeState(options, sink);
  lowerNarrativeNodes(nodes, state);
  return finishLowering(state, sink);
}

export * from './backend.js';
export * from './buffer.js';
export * from './condition.js';
export * from './narrative.js';
export * from './native.js';
export * from './presentation.js';
/* 展开降糖（`选项` 的 ETB 计划是 adapter 契约的 additive 字段，归公共面） */
export * from './expand/options.js';
export * from './program.js';
export * from './state.js';
export * from './text.js';
export * from './weave.js';
