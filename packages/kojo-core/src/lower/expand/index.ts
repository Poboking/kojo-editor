/**
 * C2 端到端编译管道（`compileKojoFile` 的实现体）。
 *
 * 流程：解析诊断并入 → 声明索引 → 按 `scenes` 顺序展开感知降糖 → `@织` 事件头装配 →
 * `# 机` 包装（backend.wrapMachine）→ 产物/诊断/source map 成形。
 *
 * fail-closed 口径（写死）：
 * - 任何 error ⇒ `ok:false`、`erb:''`、**sourceMap 也清空**（`lineCount===0`，不产半成品）；
 * - 成功 ⇒ `erb = lines.join('\n') + '\n'`（空产物 = `''`），`sourceMap.lineCount === erb 行数`；
 * - 有 `# 机` 而 backend 没实现 `wrapMachine` ⇒ `core/feature/unsupported` error。
 */
import type { KojoFile, KojoMachineDecl, KojoSpan } from '../../ast.js';
import { checkEventArgs, checkEvent } from '../../adapter.js';
import type { GameAdapter } from '../../adapter.js';
import type { DiagnosticSink, KojoDiagnostic } from '../../diagnostics.js';
import { createDiagnosticSink } from '../../diagnostics.js';
import type { EmitResult, KojoEmitBackend } from '../backend.js';
import { isEmitFailure } from '../backend.js';
import type { KojoHiddenSlot } from '../backend.js';
import { createEmitBuffer } from '../buffer.js';
import { createLowerState } from '../state.js';
import type { SourceMap, SourceMapLine } from '../../source-map.js';
import { createSourceMapBuilder } from '../../source-map.js';
import { createExpandContext, estimateLines, hiddenSlots, indexDeclarations, reportAt, reportDiagnostic } from './context.js';
import { validateAllTables } from './tables.js';
import { validateAllPools } from './pool.js';
import { assembleWeave } from './weave.js';
import { walkDispatch, walkNarrative } from './walk.js';

export interface RunCompileOptions {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly view?: string | null;
  readonly sourceText: string;
  readonly estimatedLines?: number;
  readonly sink?: DiagnosticSink;
}

export interface RunCompileResult {
  readonly ok: boolean;
  readonly erb: string;
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 本文件用到的隐藏槽（去重、稳定序；adapter 据此发 `#DIM` 等声明） */
  readonly slots: readonly KojoHiddenSlot[];
}

function emptyMap(): SourceMap {
  return createSourceMapBuilder().build();
}

/** 本次调用新增的 error 数（共享 sink 时不能看全局 hasError：别的文件的 error 不该让本文件也 0 字节） */
function countErrors(all: readonly KojoDiagnostic[], from: number): number {
  let count = 0;
  for (let i = from; i < all.length; i++) if (all[i]!.severity === 'error') count++;
  return count;
}

function failed(sink: DiagnosticSink, from: number): RunCompileResult {
  return { ok: false, erb: '', sourceMap: emptyMap(), diagnostics: sink.all.slice(from), slots: [] };
}

/** 文件里的 `# 视 <目标>`（池内裸引号默认说话人） */
function viewOf(file: KojoFile): string | null {
  for (const decl of file.decls) if (decl.kind === 'view') return decl.target;
  return null;
}

function materializeWrapped(result: EmitResult, sink: DiagnosticSink): readonly string[] | null {
  if (result === null) return [];
  if (typeof result === 'string') return [result];
  if (isEmitFailure(result)) {
    for (const diagnostic of result.diagnostics) sink.report(diagnostic);
    return null;
  }
  return result;
}

/**
 * 在 wrapper 产物里找回 body 子序列（允许 adapter 给 body 加缩进，`trimStart()` 后逐字相等；
 * 顺序/内容不得改写）。找不到 = adapter 违约 → 不静默（error + 0 字节）。
 */
function findBodyBlock(wrapped: readonly string[], body: readonly string[]): number {
  if (body.length === 0) return wrapped.length;
  const limit = wrapped.length - body.length;
  outer: for (let start = 0; start <= limit; start++) {
    for (let i = 0; i < body.length; i++) {
      if (wrapped[start + i]!.trimStart() !== body[i]!.trimStart()) continue outer;
    }
    return start;
  }
  return -1;
}

/** 把一条已有映射登记到新 builder（保留 kind/source/origins；缺失 = generated） */
function appendMapped(builder: ReturnType<typeof createSourceMapBuilder>, generatedLine: number, mapped: SourceMapLine | null): void {
  if (mapped === null || mapped.source === null) {
    builder.appendLine({ generatedLine, kind: 'generated', source: null });
    return;
  }
  builder.appendLine({ generatedLine, kind: mapped.kind, source: mapped.source, origins: mapped.origins });
}

/** 重建包装后的 source map：wrapper 行 → `# 机` 声明（事件头 origin），body 行沿用原映射 */
function rebuildWrappedMap(
  wrapped: readonly string[],
  bodyStart: number,
  body: readonly string[],
  bodyMap: SourceMap,
  machineSpan: KojoSpan,
): SourceMap {
  const builder = createSourceMapBuilder();
  let generatedLine = 1;
  for (let i = 0; i < bodyStart; i++) {
    builder.appendLine({ generatedLine: generatedLine++, kind: 'source', source: machineSpan });
  }
  for (let i = 0; i < body.length; i++) {
    const mapped = bodyMap.lineAt(i + 1);
    if (mapped === null || mapped.source === null) {
      builder.appendLine({ generatedLine: generatedLine++, kind: 'generated', source: null });
    } else {
      builder.appendLine({
        generatedLine: generatedLine++,
        kind: mapped.kind,
        source: mapped.source,
        origins: mapped.origins,
      });
    }
  }
  for (let i = bodyStart + body.length; i < wrapped.length; i++) {
    builder.appendLine({ generatedLine: generatedLine++, kind: 'source', source: machineSpan });
  }
  return builder.build();
}

export function runCompile(file: KojoFile, options: RunCompileOptions): RunCompileResult {
  const sink = options.sink ?? createDiagnosticSink();
  const startIndex = sink.all.length;

  // 1) 解析诊断先并入；解析期已有 error ⇒ 不进入展开（避免级联，且不产字节）
  for (const diagnostic of file.diagnostics) {
    sink.report({
      code: diagnostic.code as KojoDiagnostic['code'],
      severity: diagnostic.severity,
      message: diagnostic.message,
      span: diagnostic.span,
    });
  }
  if (countErrors(sink.all, startIndex) > 0) return failed(sink, startIndex);

  // 2) 声明索引 + 状态
  const ctx = createExpandContext({
    adapter: options.adapter,
    backend: options.backend,
    sourceText: options.sourceText,
    sink,
    view: options.view !== undefined ? options.view : viewOf(file),
  });
  indexDeclarations(ctx, file.decls);
  // 静态校验前置：未引用的表/池也要报重叠/缺否/空分支等 error（不靠引用触发）
  validateAllTables(ctx);
  validateAllPools(ctx);
  const buffer = createEmitBuffer(estimateLines(options.sourceText, options.estimatedLines));
  const state = createLowerState({ backend: options.backend, buffer, sink, view: ctx.view });
  // 3) `# 机`：事件目录/参数校验（一个文件最多一个事件）
  const machines = file.decls.filter((decl): decl is KojoMachineDecl => decl.kind === 'machine');
  for (let i = 1; i < machines.length; i++) {
    reportAt(ctx, 'core/decl/duplicate-name', `一个 2.0 文件最多挂一个 \`# 机\` 事件（多时机请拆文件，§3.5）。`, machines[i]!.span);
  }
  const machine = machines[0];
  if (machine !== undefined) {
    const unknown = checkEvent(options.adapter, machine.event, machine.span);
    if (unknown !== null) reportDiagnostic(ctx, unknown);
    else for (const diagnostic of checkEventArgs(options.adapter, machine.event, machine.args, machine.span)) reportDiagnostic(ctx, diagnostic);
  }

  // 4) 正文（进入 `# 机` 体）与 `@织` 监听（顶层独立监听单元：必须在主事件体之外，
  //    否则会生成"函数套函数"的无效 ERB）
  for (const scene of file.scenes) walkNarrative(scene.items, ctx, state);
  const mainFinished = buffer.finish();

  const weaveBuffer = createEmitBuffer(32);
  const weaveState = createLowerState({ backend: options.backend, buffer: weaveBuffer, sink, view: ctx.view });
  for (const decl of file.decls) {
    if (decl.kind === 'weave') assembleWeave(decl, ctx, weaveState, walkNarrative);
  }
  const weaveFinished = weaveBuffer.finish();
  const slots = hiddenSlots(ctx);

  if (countErrors(sink.all, startIndex) > 0) return failed(sink, startIndex);

  let lines: readonly string[] = mainFinished.lines;
  let sourceMap: SourceMap = mainFinished.sourceMap;

  // 5) `# 机` 事件包装（adapter 模板事实；core 只负责找到 body 子序列并重映射）
  if (machine !== undefined) {
    const wrap = options.backend.wrapMachine;
    if (wrap === undefined) {
      reportAt(
        ctx,
        'core/feature/unsupported',
        `本文件有 \`# 机 ${machine.event}\`，但当前 backend（${options.backend.id}）没有实现 \`wrapMachine\`：不能装配事件头（不产半成品字节）。`,
        machine.span,
      );
      return failed(sink, startIndex);
    }
    const body = mainFinished.lines;
    const wrappedResult = wrap({ machine, body, view: ctx.view, slots });
    const wrapped = materializeWrapped(wrappedResult, sink);
    if (wrapped === null || countErrors(sink.all, startIndex) > 0) return failed(sink, startIndex);
    const bodyStart = findBodyBlock(wrapped, body);
    if (bodyStart < 0) {
      sink.report({
        code: 'event/wrap-contract',
        severity: 'error',
        message: `backend（${options.backend.id}）的 wrapMachine 没有按契约原样嵌入 body 行（顺序/内容被改写），source map 无法登记：不产半成品字节。`,
        span: machine.span,
      });
      return failed(sink, startIndex);
    }
    sourceMap = rebuildWrappedMap(wrapped, bodyStart, body, mainFinished.sourceMap, machine.span);
    lines = wrapped;
  }

  // 6) 监听单元追加在主事件体之后（顶层 `@函数`，不嵌进事件体）
  if (weaveFinished.lines.length > 0) {
    const builder = createSourceMapBuilder();
    const offset = lines.length;
    for (let i = 1; i <= lines.length; i++) appendMapped(builder, i, sourceMap.lineAt(i));
    for (let j = 1; j <= weaveFinished.lines.length; j++) appendMapped(builder, offset + j, weaveFinished.sourceMap.lineAt(j));
    sourceMap = builder.build();
    lines = [...lines, ...weaveFinished.lines];
  }

  const erb = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return { ok: true, erb, sourceMap, diagnostics: sink.all.slice(startIndex), slots };
}

/** 让 expand 目录的走法在别处复用（compile.ts 只走 runCompile；这里保留类型收口） */
export { walkDispatch, walkNarrative };

/**
 * 展开模块的公共面（顺序按数据流：`展开器走法` → `选项` 的 ETB 计划与降糖 →
 * `@巡` 的集合计划）。别处只许从这里/`lower/index.ts`/`src/index.ts` 取，禁止深路径 import。
 */
export * from './options.js';
export * from './foreach.js';
