/**
 * C2 端到端编译管道（`compileKojoFile` 的实现体）。
 *
 * 流程：解析诊断并入 → **语义检查（K2-SEMA-WIRING）** → 声明索引 → 按 `scenes` 顺序展开感知降糖
 * → `@织` 事件头装配 → `# 机` 包装（backend.wrapMachine）→ 产物/诊断/source map 成形。
 *
 * fail-closed 口径（写死）：
 * - 任何 error ⇒ `ok:false`、`erb:''`、**sourceMap 也清空**（`lineCount===0`，不产半成品）；
 * - 成功 ⇒ `erb = lines.join('\n') + '\n'`（空产物 = `''`），`sourceMap.lineCount === erb 行数`；
 * - 有 `# 机` 而 backend 没实现 `wrapMachine` ⇒ `core/feature/unsupported` error。
 *
 * ## 语义检查的接线与去重（写死；不双报、不静默）
 *
 * 1. **位置**：`parse` 之后、`lower` 之前调用 `checkKojoFile`（同一棵只读 AST，零 IO）；
 * 2. **能力闸不重复**：sema 以 `reporting: 'with-lowering'` 跑——主链的能力闸是**单源**（adapter 声明 ∧
 *    backend 落点，`lower/feature-gate.ts`），比 sema 的 adapter-only 判定更知情；若让 sema 也报，
 *    "adapter 与 backend 不一致"时会同时出现主链的声明面冲突（span=null）与 sema 的 use-site
 *    "未开启"（同码不同 span，键去重管不到），既双报又把作者指向错的修法；
 * 3. **同码同 span 只留一条**：键 = `featureDiagnosticKey`（`code@span`，全 null span 用 `-`）。
 *    **主链胜出**：同一 `(code, span)` = 同一事实，主链的文案含两侧信息与逃生舱、且是既有测试
 *    与作者预期的口径 ⇒ 保留主链那条，sema 的重复项被抑制（后到者更知情者胜）；
 * 4. **不静默**：sema 独有的事实（类型 / 名字链 / 数组越界 / `missing-return` …）全部照报，
 *    位置在主链诊断之后（诊断序列稳定：主链 → sema 补差）；
 * 5. sema 的 error 与主链 error 同等对待：`ok:false` + 0 字节 + 空 source map + 空 slots。
 */
import type { KojoFile, KojoMachineDecl, KojoSpan } from '../../ast.js';
import type { TheaterLoweringUnit, TheaterUnitsStatus } from '../theater-unit.js';
import { checkEventArgs, checkEvent } from '../../adapter.js';
import type { GameAdapter } from '../../adapter.js';
import type { DiagnosticSink, KojoDiagnostic } from '../../diagnostics.js';
import { createDiagnosticSink } from '../../diagnostics.js';
import { checkKojoFile } from '../../sema/check.js';
import type { KojoSemaResult } from '../../sema/check.js';
import type { EmitResult, KojoEmitBackend } from '../backend.js';
import { isEmitFailure } from '../backend.js';
import type { KojoHiddenSlot } from '../backend.js';
import { createEmitBuffer } from '../buffer.js';
import { createLowerState } from '../state.js';
import type { SourceMap, SourceMapLine } from '../../source-map.js';
import { copySourceMapLine, createSourceMapBuilder } from '../../source-map.js';
import { createExpandContext, createTheaterContext, estimateLines, hiddenSlots, indexDeclarations, isTheaterContextQuiescent, reportAt, reportDiagnostic } from './context.js';
import { validateAllTables } from './tables.js';
import { validateAllPools } from './pool.js';
import { assembleWeave } from './weave.js';
import { walkDispatch, walkNarrative } from './walk.js';
import { analyzeFunctions } from './recursion.js';
import type { RecursionAnalysis } from './recursion.js';
import { featureDiagnosticKey } from '../feature-gate.js';

export interface RunCompileOptions {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly view?: string | null;
  readonly sourceText: string;
  readonly estimatedLines?: number;
  readonly sink?: DiagnosticSink;
  /** P5 项目级编译：只收集 TheaterLoweringUnit，不尝试 M1 单文件 ERB 装配。 */
  readonly theaterUnitsOnly?: boolean;
}

export interface RunCompileResult {
  readonly ok: boolean;
  readonly erb: string;
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 本文件用到的隐藏槽（去重、稳定序；adapter 据此发 `#DIM` 等声明） */
  readonly slots: readonly KojoHiddenSlot[];
  /**
   * 函数图 / 递归环 / 返回证明 / 着色泄漏事实（K2-PROGRAM-RECURSION，additive）。
   *
   * 只在成功路径给（error ⇒ 0 字节，与产品形状无关的事实也一并丢弃，保持"失败不产半成品"）。
   * 诊断已并入 `diagnostics`，本字段只供 UI / 项目层消费。
   */
  readonly recursion?: RecursionAnalysis;
  /**
   * 新语法中间产物。**不是成功标志**：`ok:false` 时也可能存在
   * （约束 / 临时桥不安全 / 多剧场等 assembly 限制）。
   * 旧路径为 `undefined`。
   */
  readonly theaterUnits?: readonly TheaterLoweringUnit[];
  /** theaterUnits 的完整性状态；见 `TheaterUnitsStatus`。 */
  readonly theaterUnitsStatus?: TheaterUnitsStatus;
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

function failed(
  sink: DiagnosticSink,
  from: number,
  extra?: Pick<RunCompileResult, 'theaterUnits' | 'theaterUnitsStatus'>,
): RunCompileResult {
  return {
    ok: false,
    erb: '',
    sourceMap: emptyMap(),
    diagnostics: sink.all.slice(from),
    slots: [],
    ...(extra === undefined ? {} : extra),
  };
}

/** 文件里的 `# 视角 <目标>`（池内裸引号默认说话人） */
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

/** 把一条已有映射登记到新 builder（行级 + 列级整体复制；缺失行按 generated 落） */
function appendMapped(builder: ReturnType<typeof createSourceMapBuilder>, generatedLine: number, mapped: SourceMapLine | null): void {
  copySourceMapLine(builder, generatedLine, mapped);
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
    appendMapped(builder, generatedLine++, bodyMap.lineAt(i + 1));
  }
  for (let i = bodyStart + body.length; i < wrapped.length; i++) {
    builder.appendLine({ generatedLine: generatedLine++, kind: 'source', source: machineSpan });
  }
  return builder.build();
}

/**
 * 语义诊断并入主链结果（**唯一**去重点；口径见文件头 3/4）。
 *
 * - 键 = `featureDiagnosticKey`（`code@span`）：同键 ⇒ 同一事实 ⇒ 主链那条胜出，sema 的丢弃；
 * - 剩下的 sema 诊断**全部**并入（不静默），排在主链诊断之后（序列稳定）；
 * - 补差项同时写回 `sink`：共享 sink 时 `sink.all` 与本次返回的 `diagnostics` 保持同一口径
 *   （都是"这一轮真实报出去的全部诊断"）；
 * - sema 带 error 与主链 error 同权：`ok:false` + 0 字节 + 空 source map + 空 slots。
 */
function mergeSema(result: RunCompileResult, sema: readonly KojoDiagnostic[], sink: DiagnosticSink): RunCompileResult {
  if (sema.length === 0) return result;
  const seen = new Set(result.diagnostics.map(featureDiagnosticKey));
  const extra: KojoDiagnostic[] = [];
  for (const diagnostic of sema) {
    const key = featureDiagnosticKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(diagnostic);
  }
  if (extra.length === 0) return result;
  for (const diagnostic of extra) sink.report(diagnostic);
  const diagnostics = [...result.diagnostics, ...extra];
  const semaHasError = extra.some((diagnostic) => diagnostic.severity === 'error');
  if (result.ok && !semaHasError) return { ...result, diagnostics };
  if (semaHasError && result.theaterUnitsStatus === 'complete') {
    return {
      ...result,
      ok: false,
      erb: '',
      sourceMap: emptyMap(),
      diagnostics,
      slots: [],
      theaterUnits: [],
      theaterUnitsStatus: 'discarded-lowering',
    };
  }
  return { ...result, ok: false, erb: '', sourceMap: emptyMap(), diagnostics, slots: [] };
}

/**
 * 编译入口：解析诊断 → **语义检查** → 主链降糖 → 语义诊断并表（去重口径见文件头）。
 *
 * 语义检查放在 `parse` 之后、`lower` 之前的理由：它只读同一棵 AST（不产字节、不改 AST），
 * 越早拿到"类型/结构已证不成立"的事实越能避免主链把 error 文件继续降糖；但**落表**在主链之后，
 * 以便同码同 span 的重复项按"主链胜出"合并（见 `mergeSema`）。
 */
export function runCompile(file: KojoFile, options: RunCompileOptions): RunCompileResult {
  const sink = options.sink ?? createDiagnosticSink();
  const startIndex = sink.all.length;

  // 1) 解析诊断先并入；解析期已有 error ⇒ 不进入语义检查/展开（避免级联，且不产字节）
  for (const diagnostic of file.diagnostics) {
    sink.report({
      code: diagnostic.code as KojoDiagnostic['code'],
      severity: diagnostic.severity,
      message: diagnostic.message,
      span: diagnostic.span,
    });
  }
  if (countErrors(sink.all, startIndex) > 0) {
    return failed(
      sink,
      startIndex,
      file.hasTheaterSyntax === true
        ? { theaterUnits: [], theaterUnitsStatus: 'discarded-syntax' }
        : undefined,
    );
  }

  // 2) 语义检查（K2-SEMA-WIRING）：类型/结构/名字链/外部数组越界；能力落点闸交主链（reporting: 'with-lowering'）
  const sema: KojoSemaResult = checkKojoFile(file, { adapter: options.adapter, reporting: 'with-lowering' });

  // 3) 旧语法判定**只看 hasTheaterSyntax**：false / 缺省一律走原有路径。
  const lowered =
    file.hasTheaterSyntax !== true
      ? lowerLegacyFile(file, options, sink, startIndex)
      : lowerTheaterFile(file, options, sink, startIndex);

  // 4) 语义诊断并表
  return mergeSema(lowered, sema.diagnostics, sink);
}

/** 旧路径（原 `runCompile` 的实现体，逐字保留；仅改名）。 */
function lowerLegacyFile(
  file: KojoFile,
  options: RunCompileOptions,
  sink: DiagnosticSink,
  startIndex: number,
): RunCompileResult {
  // 4) 声明索引 + 状态
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
  // 能力闸单源（K2-FEATURE-GATE-UNIFY）：adapter 声明 × backend 落点不一致在编译入口报**一次**
  // （span = null：声明面事实；use-site 不再重复喊"未开启"）。位置与 incremental 的 compose 对齐。
  for (const diagnostic of ctx.featureGate.diagnostics) reportDiagnostic(ctx, diagnostic);
  // 递归/返回静态分析（K2-PROGRAM-RECURSION）：只产事实 + 既有码诊断（证不出不报 missing-return）。
  // 放在 walk 之前：诊断先并入，error 时后面照常 0 字节（不靠 lowering 触发才报）。
  const recursion = analyzeFunctions(file, ctx);
  for (const diagnostic of recursion.diagnostics) reportDiagnostic(ctx, diagnostic);
  const buffer = createEmitBuffer(estimateLines(options.sourceText, options.estimatedLines));
  const state = createLowerState({ backend: options.backend, buffer, sink, view: ctx.view, featureGate: ctx.featureGate });
  // 5) `# 机`：事件目录/参数校验（一个文件最多一个事件）
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

  // 6) 正文（进入 `# 机` 体）与 `@织` 监听（顶层独立监听单元：必须在主事件体之外，
  //    否则会生成"函数套函数"的无效 ERB）
  for (const scene of file.scenes) walkNarrative(scene.items, ctx, state);
  const mainFinished = buffer.finish();

  const weaveBuffer = createEmitBuffer(32);
  const weaveState = createLowerState({ backend: options.backend, buffer: weaveBuffer, sink, view: ctx.view, featureGate: ctx.featureGate });
  for (const decl of file.decls) {
    if (decl.kind === 'weave') assembleWeave(decl, ctx, weaveState, walkNarrative);
  }
  const weaveFinished = weaveBuffer.finish();
  const slots = hiddenSlots(ctx);

  if (countErrors(sink.all, startIndex) > 0) return failed(sink, startIndex);

  let lines: readonly string[] = mainFinished.lines;
  let sourceMap: SourceMap = mainFinished.sourceMap;

  // 7) `# 机` 事件包装（adapter 模板事实；core 只负责找到 body 子序列并重映射）
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

  // 8) 监听单元追加在主事件体之后（顶层 `@函数`，不嵌进事件体）
  if (weaveFinished.lines.length > 0) {
    const builder = createSourceMapBuilder();
    const offset = lines.length;
    for (let i = 1; i <= lines.length; i++) appendMapped(builder, i, sourceMap.lineAt(i));
    for (let j = 1; j <= weaveFinished.lines.length; j++) appendMapped(builder, offset + j, weaveFinished.sourceMap.lineAt(j));
    sourceMap = builder.build();
    lines = [...lines, ...weaveFinished.lines];
  }

  const erb = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return { ok: true, erb, sourceMap, diagnostics: sink.all.slice(startIndex), slots, recursion };
}

/**
 * 新语法路径：每个 Theater 独立 lowering；unit 与最终 ERB 解耦。
 *
 * 规则见 `docs/KOJO-2.0-LANGUAGE-SPEC.md` M1 段与 `TheaterUnitsStatus`：
 * - unit 阶段任何 error ⇒ units 全部丢弃；
 * - unit 完整但 M1 装配限制（约束 / 临时桥不支持 / 多剧场）⇒ 保留 units、ok:false、erb:''。
 */
function lowerTheaterFile(
  file: KojoFile,
  options: RunCompileOptions,
  sink: DiagnosticSink,
  startIndex: number,
): RunCompileResult {
  const baseCtx = createExpandContext({
    adapter: options.adapter,
    backend: options.backend,
    sourceText: options.sourceText,
    sink,
    view: options.view !== undefined ? options.view : viewOf(file),
  });

  if (file.theaters === undefined || file.theaters.length === 0) {
    reportAt(baseCtx, 'core/theater/syntax', '文件标记了剧场语法，但没有可用的 Theater AST（AST 不自洽）。', null);
    return failed(sink, startIndex, { theaterUnits: [], theaterUnitsStatus: 'discarded-syntax' });
  }

  indexDeclarations(baseCtx, file.decls);
  validateAllTables(baseCtx);
  validateAllPools(baseCtx);
  for (const diagnostic of baseCtx.featureGate.diagnostics) reportDiagnostic(baseCtx, diagnostic);
  const recursion = analyzeFunctions(file, baseCtx);
  for (const diagnostic of recursion.diagnostics) reportDiagnostic(baseCtx, diagnostic);

  if (countErrors(sink.all, startIndex) > 0) {
    return failed(sink, startIndex, { theaterUnits: [], theaterUnitsStatus: 'discarded-lowering' });
  }

  const units: TheaterLoweringUnit[] = [];
  let isolationFailed = false;
  for (const theater of file.theaters) {
    const theaterCtx = createTheaterContext(baseCtx);
    const buffer = createEmitBuffer(estimateLines(options.sourceText, options.estimatedLines));
    const state = createLowerState({
      backend: options.backend,
      buffer,
      sink,
      view: theaterCtx.view,
      featureGate: theaterCtx.featureGate,
    });
    for (const scene of theater.scenes) walkNarrative(scene.items, theaterCtx, state);
    if (!isTheaterContextQuiescent(theaterCtx)) {
      isolationFailed = true;
      reportAt(
        baseCtx,
        'core/theater/isolation',
        `Theater「${theater.target.raw}」lowering 后展开上下文未收敛（疑似状态泄漏）；本轮 unit 全部丢弃。`,
        theater.headerSpan,
      );
      break;
    }
    const finished = buffer.finish();
    units.push({
      theater,
      body: finished.lines,
      sourceMap: finished.sourceMap,
      slots: hiddenSlots(theaterCtx),
    });
  }

  // `@织` 是文件级监听单元：只在 baseCtx 上装配一次，不进入任何 theater body。
  const weaveBuffer = createEmitBuffer(32);
  const weaveState = createLowerState({
    backend: options.backend,
    buffer: weaveBuffer,
    sink,
    view: baseCtx.view,
    featureGate: baseCtx.featureGate,
  });
  for (const decl of file.decls) {
    if (decl.kind === 'weave') assembleWeave(decl, baseCtx, weaveState, walkNarrative);
  }
  const weaveFinished = weaveBuffer.finish();

  if (isolationFailed || countErrors(sink.all, startIndex) > 0) {
    return failed(sink, startIndex, { theaterUnits: [], theaterUnitsStatus: 'discarded-lowering' });
  }

  // 单剧场：只有 location/time 都 unrestricted，且 backend 临时桥明确支持时才生成 ERB。
  if (options.theaterUnitsOnly === true) {
    return {
      ok: false,
      erb: '',
      sourceMap: emptyMap(),
      diagnostics: sink.all.slice(startIndex),
      slots: [],
      recursion,
      theaterUnits: units,
      theaterUnitsStatus: 'complete',
    };
  }
  if (units.length === 1) {
    const unit = units[0]!;
    const theater = unit.theater;
    if (theater.location.kind !== 'unrestricted' || theater.time.kind !== 'unrestricted') {
      reportAt(
        baseCtx,
        'core/feature/unsupported',
        'M1 尚未实现运行时地点/时间分发：这个 Theater 有场景约束，只产出 TheaterLoweringUnit，不生成 ERB。',
        theater.headerSpan,
      );
      return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
    }

    const bridge = options.backend.temporarySingleTheaterBridge;
    if (bridge === undefined) {
      reportAt(
        baseCtx,
        'core/feature/unsupported',
        `backend（${options.backend.id}）没有实现 M1 临时单剧场桥：不能确认 target「${theater.target.raw}」的调用签名，不生成 ERB。`,
        theater.headerSpan,
      );
      return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
    }
    const bridged = bridge({
      theater,
      body: unit.body,
      view: baseCtx.view,
      slots: unit.slots,
    });
    if (bridged.kind === 'unsupported') {
      reportAt(
        baseCtx,
        'core/feature/unsupported',
        `M1 临时单剧场桥不支持 target「${theater.target.raw}」：${bridged.reason}（只产出 unit，不生成 ERB）。`,
        theater.headerSpan,
      );
      return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
    }

    const wrap = options.backend.wrapMachine;
    if (wrap === undefined) {
      reportAt(
        baseCtx,
        'core/feature/unsupported',
        `backend（${options.backend.id}）没有实现 wrapMachine：不能为临时桥 target「${theater.target.raw}」装配事件头。`,
        theater.headerSpan,
      );
      return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
    }

    const body = unit.body;
    const wrappedResult = wrap({
      machine: bridged.machine,
      body,
      view: baseCtx.view,
      slots: unit.slots,
    });
    const wrapped = materializeWrapped(wrappedResult, sink);
    if (wrapped === null || countErrors(sink.all, startIndex) > 0) {
      return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
    }
    const bodyStart = findBodyBlock(wrapped, body);
    if (bodyStart < 0) {
      sink.report({
        code: 'event/wrap-contract',
        severity: 'error',
        message: `backend（${options.backend.id}）的 wrapMachine 没有按契约原样嵌入 body 行（顺序/内容被改写），source map 无法登记：不产半成品字节。`,
        span: bridged.machine.span,
      });
      return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
    }

    let lines: readonly string[] = wrapped;
    let sourceMap = rebuildWrappedMap(wrapped, bodyStart, body, unit.sourceMap, bridged.machine.span);

    if (weaveFinished.lines.length > 0) {
      const builder = createSourceMapBuilder();
      const offset = lines.length;
      for (let i = 1; i <= lines.length; i++) appendMapped(builder, i, sourceMap.lineAt(i));
      for (let j = 1; j <= weaveFinished.lines.length; j++) {
        appendMapped(builder, offset + j, weaveFinished.sourceMap.lineAt(j));
      }
      sourceMap = builder.build();
      lines = [...lines, ...weaveFinished.lines];
    }

    const erb = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    return {
      ok: true,
      erb,
      sourceMap,
      diagnostics: sink.all.slice(startIndex),
      slots: unit.slots,
      recursion,
      theaterUnits: units,
      theaterUnitsStatus: 'complete',
    };
  }

  // 多剧场：所有 unit 保留，但 M1 不做 dispatch 装配。
  reportAt(
    baseCtx,
    'core/feature/unsupported',
    `M1 尚未实现多剧场运行时分发：本文件有 ${units.length} 个 Theater，只产出 TheaterLoweringUnit，不生成 ERB。`,
    units[1]?.theater.headerSpan ?? units[0]?.theater.headerSpan ?? null,
  );
  return failed(sink, startIndex, { theaterUnits: units, theaterUnitsStatus: 'complete' });
}
/** 让 expand 目录的走法在别处复用（compile.ts 只走 runCompile；这里保留类型收口） */
export { walkDispatch, walkNarrative };

/**
 * 展开模块的公共面（顺序按数据流：`展开器走法` → `选项` 的 ETB 计划与降糖 →
 * `@巡` 的集合计划 → `# 对照表` / `# 池` 的等值分派计划）。别处只许从这里/`lower/index.ts`/
 * `src/index.ts` 取，禁止深路径 import。
 */
export * from './options.js';
export * from './foreach.js';
export * from './table-plan.js';
export * from './pool-plan.js';
