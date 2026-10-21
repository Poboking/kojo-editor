/**
 * 编辑器 keystroke 场景的**增量编译骨架**（K2-PERF-INCR）。
 *
 * 定位：本文件只在全量编译之上增加"缓存 + 脏区间重算"，**不替 compile 做语义决策**：
 * 任何无法证明与全量逐字等价的编辑都回退到全量编译（`fallbackFull: true`）。
 * 纯函数风格、零 IO、零 Monaco、零游戏名词；不 import 任何插件包。
 *
 * ── 模型（为什么可以只重算一段） ─────────────────────────────────────────────
 * 文本按**顶层语句单元**（unit）切分：行首不缩进的一条语句 / 一个块头（连同缩进的体）。
 * `?` 链按 parser 的规则（连续同缩进 `?` 行 + 缩进体 + 之间注释）合并成一个单元；
 * 空行断链（parser §5 同口径）。每个单元缓存三层：
 *   1. **LexedDocument 片段**：只对该单元的行重新 `lex`（切片从行首开始，列号天然对齐）；
 *   2. **AST 节点**：该单元源码单独 `parse` 出来的节点（局部行号 + 单元起始行 = 全文件坐标）；
 *   3. **IR**：该单元节点单独走 `walkNarrative` 得到的产物行 + source map 行 + 隐藏槽 + 诊断。
 * 编辑落在某个单元里时，只重算这一个单元的三层；其余单元的行/节点/IR 原样复用，
 * 最后按单元顺序拼接（声明索引、表/池校验、`@织` 装配、`# 机` 包装在文件级做一次）。
 *
 * ── 安全切分点（safe split points） ─────────────────────────────────────────
 * - **顶层声明 / `@函` / `@织` 块头行是硬边界**：单元内任何改动都可能改变别处的展开
 *   （池 / 模板在引用点展开、`# 视` 改默认说话人），所以编辑这些单元一律回退全量；
 * - 单元的**首行若是 `#` / `@` 锚点**（声明或块头）：同样回退；
 * - 普通叙事单元内部可以改（含块体行、`@着色` / `@随机` 体、`?` 分支体）——只要编辑后
 *   该行的**结构等价类**不变（见 `safeLineTransition`），单元边界就不会移动；
 * - 行数变化（插入/删除换行）、跨行删除、全文替换、非法编辑区间：天然改变单元边界 → 全量；
 * - 文件含 `选项`（全局计数诊断）、BOM、或模型自检失败：`degraded` 置位，之后永远全量。
 *
 * ── 回退判定的保险：**构建期自检** ─────────────────────────────────────────
 * 每次全量重建缓存后，会把"单元拼接"的结果与真正的全量结果逐字对比
 * （ok / erb / 每行 source map / 诊断顺序 / 隐藏槽 / AST）。不一致就 `degraded = true`
 * 并永久走全量——宁可慢，不可错。`tests/incremental.test.ts` 的 golden 断言（随机编辑
 * 增量 === 全量）钉住同一条契约。
 *
 * ── 性能口径（实测见 tests/incremental.test.ts） ──────────────────────────
 * 5000+ 行 / ~5500 单元的源文本：全量 compile 中位数 40ms 量级；单字符编辑的增量路径只做
 *   O(脏单元行数) 的 lex/parse/lower + O(总产物行数) 的拼接与 source map 重登记 + 一次
 *   `wrapMachine`，实测显著低于全量的 25%。构建期（首帧）是 O(单元数) 的探针 + 一次全量
 *   自检，属冷路径：编辑器在文档打开时付一次。
 */
import type {
  KojoCallStmt,
  KojoDecl,
  KojoDispatchNode,
  KojoFile,
  KojoMachineDecl,
  KojoNarrativeNode,
  KojoPosition,
  KojoSceneNode,
  KojoSpan,
} from './ast.js';
import { checkEvent, checkEventArgs } from './adapter.js';
import type { GameAdapter } from './adapter.js';
import { compileKojoFile } from './compile.js';
import type { CompileKojoSourceResult } from './compile.js';
import { createDiagnosticSink, severityOf } from './diagnostics.js';
import type { DiagnosticSink, KojoDiagnostic } from './diagnostics.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import type { PositionIndex } from './positions.js';
import { createSourceMapBuilder } from './source-map.js';
import type { SourceMap, SourceMapLineKind, SourceMapOrigin } from './source-map.js';
import type { EmitResult, KojoEmitBackend, KojoHiddenSlot } from './lower/backend.js';
import { isEmitFailure } from './lower/backend.js';
import { createEmitBuffer } from './lower/buffer.js';
import type { ExpandContext } from './lower/expand/context.js';
import { createExpandContext, hiddenSlots, indexDeclarations } from './lower/expand/context.js';
import { validateAllPools } from './lower/expand/pool.js';
import { validateAllTables } from './lower/expand/tables.js';
import { walkNarrative } from './lower/expand/walk.js';
import { assembleWeave } from './lower/expand/weave.js';
import { createLowerState } from './lower/state.js';
import type { KojoLexLine } from './tokens.js';

/* ============================== 公共形状 ============================== */

/** 一次文本编辑：相对**上一轮文本**的半开区间替换（Monaco `applyEdits` 同口径） */
export interface IncrementalEdit {
  /** 上一轮文本里的 0 基 UTF-16 偏移 */
  readonly offset: number;
  /** 上一轮文本里被删掉的码元数 */
  readonly removedLength: number;
  /** 新插入的文本（可含换行；含换行会回退全量） */
  readonly insertedText: string;
}

/** 一轮 `update` 的可测读数（性能护栏与退化路径都靠它） */
export interface IncrementalStats {
  /** 本轮直接复用的 AST 节点数（未重算单元里的节点总数） */
  readonly reusedNodes: number;
  /** 本轮重新 parse 出来的节点数 */
  readonly rebuiltNodes: number;
  /** 本轮重新 lex 的源行数（只算脏单元） */
  readonly relexedLines: number;
  /** 本轮重新 parse 的单元数（成功走增量时为 1） */
  readonly reparsedUnits: number;
  /** 本轮重新 lower 的单元数（成功走增量时为 1） */
  readonly reloweredUnits: number;
  /** 是否回退到全量编译（非法编辑 / 跨块大改 / 模型不支持 / 首次构建） */
  readonly fallbackFull: boolean;
  /** 回退原因（走增量时为 null） */
  readonly fallbackReason: string | null;
  /** `update` 的墙钟耗时（ms，`performance.now()` 口径） */
  readonly ms: number;
}

export interface IncrementalUpdate {
  /** 与 `compileKojoSource({ source: text, ... })` 逐字等价（含 `file` AST） */
  readonly result: CompileKojoSourceResult;
  readonly stats: IncrementalStats;
}

export interface IncrementalCompilerOptions {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  /** 与 `CompileKojoSourceInput.view` 同义；缺省从声明里的 `# 视` 取 */
  readonly view?: string | null;
}

export interface IncrementalCompiler {
  /**
   * 编译新文本。
   *
   * - 首次调用（或 `edit` 缺省）：全量构建缓存，结果与 `compileKojoSource` 一致；
   * - 之后传 `edit`（相对上一轮文本）：走增量；不能证明安全时自动回退全量，
   *   结果**始终**与全量一致。
   */
  update(text: string, edit?: IncrementalEdit | null): IncrementalUpdate;
  /** 模型自检失败 → 之后永远走全量（只读读数，便于宿主提示/观测） */
  readonly degraded: boolean;
  /** 最近一次降级原因（未降级时为 null） */
  readonly degradedReason: string | null;
}

/* ============================== 行 / 单元模型 ============================== */

type LineClass = 'decl' | 'options' | 'trivia' | 'condition' | 'native' | 'leaf' | `dispatch:${string}`;

interface LineMeta {
  readonly cls: LineClass;
  readonly indent: number;
}

interface SceneHeaderUnit {
  readonly title: string | null;
  readonly headerSpan: KojoSpan;
}

interface Unit {
  /** 0 基行号（含） */
  readonly startLine: number;
  /** 0 基行号（不含） */
  readonly endLine: number;
  readonly headCls: LineClass;
  readonly headIndent: number;
  /** 每行结构等价类（长度 = endLine - startLine） */
  meta: LineMeta[];
  /** `# 幕` 开的场景头；普通单元为 null */
  scene: SceneHeaderUnit | null;
  /** 单元内 AST 节点（声明单元恒为空：声明被提升） */
  nodes: readonly KojoNarrativeNode[];
  /** 词法阶段诊断（lexer 先于 parse 汇总：拼接时排在最前） */
  lexDiags: readonly KojoDiagnostic[];
  /** parser 源序诊断 */
  sourceDiags: readonly KojoDiagnostic[];
  /** parser 收尾阶段诊断（`core/template/unexpected-slot`） */
  postDiags: readonly KojoDiagnostic[];
  /** IR：单元产物行 */
  lines: readonly string[];
  /** IR：逐产物行的 source map 行级映射 */
  mapKinds: readonly SourceMapLineKind[];
  mapSources: readonly (KojoSpan | null)[];
  mapOrigins: readonly (readonly SourceMapOrigin[])[];
  /** 单元级隐藏槽（拼接时按名字去重、先到先得） */
  slots: readonly KojoHiddenSlot[];
  /** 单元级 lower 诊断 */
  walkDiags: readonly KojoDiagnostic[];
}

interface CacheState {
  text: string;
  lineStarts: number[];
  units: Unit[];
  /** 0 基行号 → 单元下标 */
  unitOfLine: number[];
  decls: readonly KojoDecl[];
  machines: readonly KojoMachineDecl[];
  view: string | null;
  validationDiags: readonly KojoDiagnostic[];
  machineDiags: readonly KojoDiagnostic[];
  weaveDiags: readonly KojoDiagnostic[];
  weaveLines: readonly string[];
  weaveKinds: readonly SourceMapLineKind[];
  weaveSources: readonly (KojoSpan | null)[];
  weaveOrigins: readonly (readonly SourceMapOrigin[])[];
  baseCtx: ExpandContext;
  totalNodes: number;
}

interface UnitParse {
  readonly nodes: KojoNarrativeNode[];
  readonly lexDiags: KojoDiagnostic[];
  readonly sourceDiags: KojoDiagnostic[];
  readonly postDiags: KojoDiagnostic[];
}

const MISSING_MACHINE = 'core/decl/missing-machine';
/** parser 收尾阶段（`validateCallBodies`）唯一会发的码：顺序上必须排在所有源序诊断之后 */
const CALL_BODY_CODES: ReadonlySet<string> = new Set<string>(['core/template/unexpected-slot']);

/* ============================== 时钟（零 import） ============================== */

interface HighResolutionClock {
  now(): number;
}

const clockNow: () => number = (() => {
  const host = globalThis as unknown as { performance?: HighResolutionClock };
  if (typeof host.performance?.now === 'function') return () => host.performance!.now();
  return () => Date.now();
})();

/* ============================== 入口 ============================== */

/**
 * 建一个增量编译器。`update(text)` 首次全量建缓存；之后 `update(text, edit)` 走增量。
 *
 * 纯函数语义：编译器只持有缓存，不读盘、不写盘、不碰宿主；两个实例互不影响。
 */
export function createIncrementalCompiler(options: IncrementalCompilerOptions): IncrementalCompiler {
  const { adapter, backend } = options;
  let state: CacheState | null = null;
  let degraded = false;
  let degradeReason: string | null = null;

  const fullResult = (text: string): CompileKojoSourceResult => {
    const file = parse(lex(text));
    return {
      ...compileKojoFile(file, {
        adapter,
        backend,
        sourceText: text,
        ...(options.view === undefined ? {} : { view: options.view }),
      }),
      file,
    };
  };

  const rebuildAll = (text: string, reason: string, startedAt: number): IncrementalUpdate => {
    state = null;
    const built = tryBuild(text, adapter, backend, options.view);
    if (built.kind === 'ok') {
      state = built.state;
      return {
        result: built.result,
        stats: {
          reusedNodes: 0,
          rebuiltNodes: built.state.totalNodes,
          relexedLines: lineCount(text),
          reparsedUnits: built.state.units.length,
          reloweredUnits: built.state.units.length,
          fallbackFull: true,
          fallbackReason: reason,
          ms: clockNow() - startedAt,
        },
      };
    }
    degraded = true;
    degradeReason = built.reason;
    return {
      result: fullResult(text),
      stats: {
        reusedNodes: 0,
        rebuiltNodes: 0,
        relexedLines: lineCount(text),
        reparsedUnits: 0,
        reloweredUnits: 0,
        fallbackFull: true,
        fallbackReason: reason,
        ms: clockNow() - startedAt,
      },
    };
  };

  return {
    get degraded() {
      return degraded;
    },
    get degradedReason() {
      return degradeReason;
    },
    update(text: string, edit?: IncrementalEdit | null): IncrementalUpdate {
      const startedAt = clockNow();
      if (degraded) {
        return {
          result: fullResult(text),
          stats: {
            reusedNodes: 0,
            rebuiltNodes: 0,
            relexedLines: lineCount(text),
            reparsedUnits: 0,
            reloweredUnits: 0,
            fallbackFull: true,
            fallbackReason: degradeReason ?? 'degraded',
            ms: clockNow() - startedAt,
          },
        };
      }
      if (state === null || edit === undefined || edit === null) {
        return rebuildAll(text, state === null ? 'initial-build' : 'full-rebuild', startedAt);
      }
      const current = state;
      if (!isConsistentEdit(current.text, text, edit)) return rebuildAll(text, 'invalid-edit', startedAt);
      if (text === current.text) {
        return {
          result: compose(current, adapter, backend),
          stats: {
            reusedNodes: current.totalNodes,
            rebuiltNodes: 0,
            relexedLines: 0,
            reparsedUnits: 0,
            reloweredUnits: 0,
            fallbackFull: false,
            fallbackReason: null,
            ms: clockNow() - startedAt,
          },
        };
      }
      const fast = tryIncremental(current, text, edit, adapter, backend);
      if (fast.kind === 'ok') {
        state = fast.state;
        return { result: fast.result, stats: { ...fast.stats, ms: clockNow() - startedAt } };
      }
      return rebuildAll(text, fast.reason, startedAt);
    },
  };
}

/* ============================== 全量缓存构建 ============================== */

type BuildOutcome = { kind: 'ok'; state: CacheState; result: CompileKojoSourceResult } | { kind: 'fail'; reason: string };

function tryBuild(
  text: string,
  adapter: GameAdapter,
  backend: KojoEmitBackend,
  viewOption: string | null | undefined,
): BuildOutcome {
  if (text.charCodeAt(0) === 0xfeff) return { kind: 'fail', reason: 'bom-source' };
  const lexed = lex(text);
  const parsed = parse(lexed);
  const view = resolveView(parsed.decls, viewOption);

  const ranges = partitionLines(lexed.lines);
  const unitOfLine = new Array<number>(lexed.lines.length).fill(-1);
  const units: Unit[] = [];
  const declOfUnit: boolean[] = [];
  const declKindLabels = collectDeclKindLabels(parsed.decls);

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]!;
    const meta: LineMeta[] = [];
    for (let line = range.start; line < range.end; line++) {
      const record = lexed.lines[line]!;
      const cls = classOf(record);
      if (cls === 'options') return { kind: 'fail', reason: 'options-block' };
      meta.push({ cls, indent: record.indent });
      unitOfLine[line] = i;
    }
    const head = meta[0]!;
    const isDecl = head.cls === 'decl' && head.indent === 0;
    declOfUnit.push(isDecl);
    units.push({
      startLine: range.start,
      endLine: range.end,
      headCls: head.cls,
      headIndent: head.indent,
      meta,
      scene: null,
      nodes: [],
      lexDiags: [],
      sourceDiags: [],
      postDiags: [],
      lines: [],
      mapKinds: [],
      mapSources: [],
      mapOrigins: [],
      slots: [],
      walkDiags: [],
    });
  }

  const decls: readonly KojoDecl[] = parsed.decls;
  const machines = decls.filter((decl): decl is KojoMachineDecl => decl.kind === 'machine');

  // `# 幕` 场景头：标题 + 头行 span 挂到单元上，拼接场景时零 parse。
  for (const scene of parsed.scenes) {
    if (scene.title === null) continue;
    const lineIndex = scene.span.start.line - 1;
    const unitIndex = unitOfLine[lineIndex];
    if (unitIndex === undefined || unitIndex < 0) return { kind: 'fail', reason: 'scene-header-unmapped' };
    const unit = units[unitIndex]!;
    const header = lexed.lines[lineIndex];
    if (header === undefined) return { kind: 'fail', reason: 'scene-header-missing' };
    unit.scene = { title: scene.title, headerSpan: spanOfLine(header, lexed.positions) };
  }

  // 每个非声明单元单独 parse（局部坐标 → 抬行号）；节点与 parse 诊断都来自这一步。
  const starts = lineStartsOf(text);
  for (let i = 0; i < units.length; i++) {
    if (declOfUnit[i] === true) continue;
    const unit = units[i]!;
    const unitText = sliceLines(text, starts, unit.startLine, unit.endLine);
    const unitParse = parseUnitSlice(unitText, unit.startLine, declKindLabels);
    unit.nodes = unitParse.nodes;
    unit.lexDiags = unitParse.lexDiags;
    unit.sourceDiags = unitParse.sourceDiags;
    unit.postDiags = unitParse.postDiags;
  }

  // 声明单元的诊断来自全量 parse 的归属（声明不被增量重算，顺序由全量钉死）。
  // 全量 parse 的输出 = 词法诊断（lex 阶段，全文件源序）在前，parse 诊断在后；
  // 声明单元的 lex 诊断从 `lexed.diagnostics` 按行归属，parse 诊断从后半段归属。
  for (const diagnostic of lexed.diagnostics) {
    if (diagnostic.span === null) return { kind: 'fail', reason: 'unpositioned-diagnostic' };
    const unitIndex = unitOfLine[diagnostic.span.start.line - 1];
    if (unitIndex === undefined || unitIndex < 0) return { kind: 'fail', reason: 'diagnostic-unmapped' };
    if (declOfUnit[unitIndex] !== true) continue; // 非声明单元的词法诊断由该单元 lex 复现
    const unit = units[unitIndex]!;
    unit.lexDiags = [...unit.lexDiags, diagnostic];
  }
  const parseDiagsInput = parsed.diagnostics.slice(lexed.diagnostics.length);
  for (const diagnostic of parseDiagsInput) {
    if (diagnostic.code === MISSING_MACHINE) continue; // 由 compose 按当前首个正文节点重算（跨编辑会移动）
    if (diagnostic.code === 'core/options/pending') return { kind: 'fail', reason: 'options-block' };
    if (diagnostic.span === null) return { kind: 'fail', reason: 'unpositioned-diagnostic' };
    const unitIndex = unitOfLine[diagnostic.span.start.line - 1];
    if (unitIndex === undefined || unitIndex < 0) return { kind: 'fail', reason: 'diagnostic-unmapped' };
    if (declOfUnit[unitIndex] !== true) continue; // 非声明单元的 parse 诊断由该单元 parse 复现
    const unit = units[unitIndex]!;
    if (CALL_BODY_CODES.has(diagnostic.code)) unit.postDiags = [...unit.postDiags, diagnostic];
    else unit.sourceDiags = [...unit.sourceDiags, diagnostic];
  }

  // 文件级：表/池校验、`# 机` 校验、`@织` 装配（只依赖声明；声明不变就复用）。
  const validationSink = createDiagnosticSink();
  const baseCtx = createExpandContext({ adapter, backend, sourceText: text, sink: validationSink, view });
  indexDeclarations(baseCtx, decls);
  validateAllTables(baseCtx);
  validateAllPools(baseCtx);
  const validationDiags = validationSink.all.slice();

  const machineSink = createDiagnosticSink();
  validateMachines(machines, adapter, machineSink);
  const machineDiags = machineSink.all.slice();

  const weaveSink = createDiagnosticSink();
  const weaveCtx = forkExpandContext(baseCtx, weaveSink, text);
  const weaveBuffer = createEmitBuffer(32);
  const weaveState = createLowerState({ backend, buffer: weaveBuffer, sink: weaveSink, view });
  for (const decl of decls) if (decl.kind === 'weave') assembleWeave(decl, weaveCtx, weaveState, walkNarrative);
  const woven = weaveBuffer.finish();
  const weaveDiags = weaveSink.all.slice();
  const weaveMap = extractMap(woven.sourceMap);

  // IR：每个非声明单元单独走 walkNarrative（声明索引/校验结果通过 fork 共享只读面）。
  for (let i = 0; i < units.length; i++) {
    if (declOfUnit[i] === true) continue;
    const unit = units[i]!;
    if (unit.nodes.length === 0) continue;
    const lowered = lowerUnit(unit.nodes, baseCtx, backend, view, text);
    unit.lines = lowered.lines;
    unit.mapKinds = lowered.mapKinds;
    unit.mapSources = lowered.mapSources;
    unit.mapOrigins = lowered.mapOrigins;
    unit.slots = lowered.slots;
    unit.walkDiags = lowered.walkDiags;
  }

  let totalNodes = 0;
  for (const unit of units) totalNodes += unit.nodes.length;

  const candidate: CacheState = {
    text,
    lineStarts: starts,
    units,
    unitOfLine,
    decls,
    machines,
    view,
    validationDiags,
    machineDiags,
    weaveDiags,
    weaveLines: woven.lines,
    weaveKinds: weaveMap.kinds,
    weaveSources: weaveMap.sources,
    weaveOrigins: weaveMap.origins,
    baseCtx,
    totalNodes,
  };

  // 自检：拼接结果必须与真正的全量结果逐字一致（含 AST / 诊断序 / source map / 隐藏槽）。
  const composed = compose(candidate, adapter, backend);
  const expected = compileKojoFile(parsed, {
    adapter,
    backend,
    sourceText: text,
    ...(viewOption === undefined ? {} : { view: viewOption }),
  });
  if (!sameCompiled(composed, { ...expected, file: parsed })) {
    return { kind: 'fail', reason: 'self-check-compile-mismatch' };
  }
  return { kind: 'ok', state: candidate, result: composed };
}

/* ============================== 增量更新 ============================== */

type FastOutcome =
  | { kind: 'ok'; state: CacheState; result: CompileKojoSourceResult; stats: IncrementalStats }
  | { kind: 'unsafe'; reason: string };

function tryIncremental(
  current: CacheState,
  text: string,
  edit: IncrementalEdit,
  adapter: GameAdapter,
  backend: KojoEmitBackend,
): FastOutcome {
  const oldText = current.text;
  const offset = edit.offset;
  const removed = oldText.slice(offset, offset + edit.removedLength);
  if (edit.insertedText.indexOf('\n') >= 0 || edit.insertedText.indexOf('\r') >= 0) {
    return { kind: 'unsafe', reason: 'multiline-insert' };
  }
  if (removed.indexOf('\n') >= 0 || removed.indexOf('\r') >= 0) {
    return { kind: 'unsafe', reason: 'multiline-delete' };
  }
  const lineIdx = lineIndexAt(current.lineStarts, offset);
  if (lineIndexAt(current.lineStarts, offset + edit.removedLength) !== lineIdx) {
    return { kind: 'unsafe', reason: 'multiline-edit-range' };
  }
  const unitIndex = current.unitOfLine[lineIdx];
  if (unitIndex === undefined || unitIndex < 0) return { kind: 'unsafe', reason: 'unit-unmapped' };
  const unit = current.units[unitIndex]!;
  if (unit.headCls === 'decl') return { kind: 'unsafe', reason: 'declaration-unit-edit' };
  if (unit.headIndent !== 0) return { kind: 'unsafe', reason: 'orphan-unit' };

  const newLineStarts = lineStartsOf(text);
  if (newLineStarts.length !== current.lineStarts.length) return { kind: 'unsafe', reason: 'line-count-changed' };
  const newUnitText = sliceLines(text, newLineStarts, unit.startLine, unit.endLine);
  const expectedLines = unit.endLine - unit.startLine;
  const newLexed = lex(newUnitText);
  if (newLexed.lines.length !== expectedLines) return { kind: 'unsafe', reason: 'unit-line-count-changed' };
  const oldMeta = unit.meta[lineIdx - unit.startLine]!;
  const editedRecord = newLexed.lines[lineIdx - unit.startLine];
  if (editedRecord === undefined) return { kind: 'unsafe', reason: 'edited-line-missing' };
  if (!safeLineTransition(oldMeta, classOf(editedRecord), editedRecord.indent)) {
    return { kind: 'unsafe', reason: 'line-structure-changed' };
  }

  const newMeta: LineMeta[] = [];
  for (const record of newLexed.lines) {
    const cls = classOf(record);
    if (cls === 'options') return { kind: 'unsafe', reason: 'options-block' };
    newMeta.push({ cls, indent: record.indent });
  }

  const declKindLabels = collectDeclKindLabels(current.decls);
  const unitParse = parseUnitSlice(newUnitText, unit.startLine, declKindLabels);
  const lowered =
    unitParse.nodes.length === 0 ? emptyLowered() : lowerUnit(unitParse.nodes, current.baseCtx, backend, current.view, text);

  const nextUnit: Unit = {
    ...unit,
    meta: newMeta,
    nodes: unitParse.nodes,
    lexDiags: unitParse.lexDiags,
    sourceDiags: unitParse.sourceDiags,
    postDiags: unitParse.postDiags,
    lines: lowered.lines,
    mapKinds: lowered.mapKinds,
    mapSources: lowered.mapSources,
    mapOrigins: lowered.mapOrigins,
    slots: lowered.slots,
    walkDiags: lowered.walkDiags,
  };
  const units = current.units.slice();
  units[unitIndex] = nextUnit;
  const next: CacheState = {
    ...current,
    text,
    lineStarts: newLineStarts,
    units,
    totalNodes: current.totalNodes - unit.nodes.length + unitParse.nodes.length,
  };
  const result = compose(next, adapter, backend);
  return {
    kind: 'ok',
    state: next,
    result,
    stats: {
      reusedNodes: current.totalNodes - unit.nodes.length,
      rebuiltNodes: unitParse.nodes.length,
      relexedLines: expectedLines,
      reparsedUnits: 1,
      reloweredUnits: 1,
      fallbackFull: false,
      fallbackReason: null,
      ms: 0, // 由入口回填（统一在 update 的计时窗口里）
    },
  };
}

/* ============================== 拼接（compose） ============================== */

function compose(state: CacheState, adapter: GameAdapter, backend: KojoEmitBackend): CompileKojoSourceResult {
  void adapter;
  const parseDiags: KojoDiagnostic[] = [];
  for (const unit of state.units) for (const diagnostic of unit.lexDiags) parseDiags.push(diagnostic);
  for (const unit of state.units) for (const diagnostic of unit.sourceDiags) parseDiags.push(diagnostic);
  for (const unit of state.units) {
    if (unit.headCls !== 'decl') continue;
    for (const diagnostic of unit.postDiags) parseDiags.push(diagnostic);
  }
  for (const unit of state.units) {
    if (unit.headCls === 'decl') continue;
    for (const diagnostic of unit.postDiags) parseDiags.push(diagnostic);
  }
  const scenes = composeScenes(state.units);
  const missingMachine = missingMachineDiagnostic(state.machines.length > 0, scenes);
  if (missingMachine !== null) parseDiags.push(missingMachine);

  const file: KojoFile = { decls: state.decls, scenes, diagnostics: parseDiags };
  const empty = (): SourceMap => createSourceMapBuilder().build();
  if (hasError(parseDiags)) {
    return { ok: false, erb: '', sourceMap: empty(), diagnostics: parseDiags, slots: [], file };
  }

  const diags: KojoDiagnostic[] = [];
  for (const diagnostic of parseDiags) diags.push(diagnostic);
  for (const diagnostic of state.validationDiags) diags.push(diagnostic);
  for (const diagnostic of state.machineDiags) diags.push(diagnostic);
  for (const unit of state.units) for (const diagnostic of unit.walkDiags) diags.push(diagnostic);
  for (const diagnostic of state.weaveDiags) diags.push(diagnostic);
  if (hasError(diags)) {
    return { ok: false, erb: '', sourceMap: empty(), diagnostics: diags, slots: [], file };
  }

  const bodyLines: string[] = [];
  for (const unit of state.units) for (const line of unit.lines) bodyLines.push(line);
  const slots = composeSlots(state.units);

  const machine = state.machines[0];
  let lines: readonly string[] = bodyLines;
  let prefix = 0;
  let suffix = 0;
  if (machine !== undefined) {
    const wrap = backend.wrapMachine;
    if (wrap === undefined) {
      diags.push({
        code: 'core/feature/unsupported',
        severity: severityOf('core/feature/unsupported'),
        message: `本文件有 \`# 机 ${machine.event}\`，但当前 backend（${backend.id}）没有实现 \`wrapMachine\`：不能装配事件头（不产半成品字节）。`,
        span: machine.span,
      });
      return { ok: false, erb: '', sourceMap: empty(), diagnostics: diags, slots: [], file };
    }
    const wrappedRaw = wrap({ machine, body: bodyLines, view: state.view, slots });
    const wrapped = materializeWrapped(wrappedRaw, (reported) => {
      for (const diagnostic of reported) diags.push(diagnostic);
    });
    if (wrapped === null || hasError(diags)) {
      return { ok: false, erb: '', sourceMap: empty(), diagnostics: diags, slots: [], file };
    }
    const bodyStart = findBodyBlock(wrapped, bodyLines);
    if (bodyStart < 0) {
      diags.push({
        code: 'event/wrap-contract',
        severity: 'error',
        message: `backend（${backend.id}）的 wrapMachine 没有按契约原样嵌入 body 行（顺序/内容被改写），source map 无法登记：不产半成品字节。`,
        span: machine.span,
      });
      return { ok: false, erb: '', sourceMap: empty(), diagnostics: diags, slots: [], file };
    }
    lines = wrapped;
    prefix = bodyStart;
    suffix = wrapped.length - bodyStart - bodyLines.length;
  }

  const weaveLines = state.weaveLines;
  if (weaveLines.length > 0) {
    const joined: string[] = [];
    for (const line of lines) joined.push(line);
    for (const line of weaveLines) joined.push(line);
    lines = joined;
  }

  const builder = createSourceMapBuilder();
  let generated = 1;
  const machineSpan = machine === undefined ? null : machine.span;
  if (machineSpan !== null) {
    for (let i = 0; i < prefix; i++) {
      builder.appendLine({ generatedLine: generated++, kind: 'source', source: machineSpan });
    }
  }
  for (const unit of state.units) {
    for (let i = 0; i < unit.lines.length; i++) {
      builder.appendLine({
        generatedLine: generated++,
        kind: unit.mapKinds[i]!,
        source: unit.mapSources[i]!,
        ...(unit.mapOrigins[i]!.length === 0 ? {} : { origins: unit.mapOrigins[i]! }),
      });
    }
  }
  if (machineSpan !== null) {
    for (let i = 0; i < suffix; i++) {
      builder.appendLine({ generatedLine: generated++, kind: 'source', source: machineSpan });
    }
  }
  for (let i = 0; i < weaveLines.length; i++) {
    const source = state.weaveSources[i]!;
    const origins = state.weaveOrigins[i]!;
    if (source === null) {
      builder.appendLine({ generatedLine: generated++, kind: 'generated', source: null });
    } else {
      builder.appendLine({
        generatedLine: generated++,
        kind: state.weaveKinds[i]!,
        source,
        ...(origins.length === 0 ? {} : { origins }),
      });
    }
  }

  const erb = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return { ok: true, erb, sourceMap: builder.build(), diagnostics: diags, slots, file };
}

function composeScenes(units: readonly Unit[]): KojoSceneNode[] {
  const scenes: KojoSceneNode[] = [];
  let title: string | null = null;
  let explicit = false;
  let headerSpan: KojoSpan | null = null;
  let items: KojoNarrativeNode[] = [];
  let startSpan: KojoSpan | null = null;
  let endSpan: KojoSpan | null = null;

  const flush = (): void => {
    const start = startSpan ?? headerSpan;
    if ((!explicit && items.length === 0) || start === null) {
      title = null;
      headerSpan = null;
      startSpan = null;
      endSpan = null;
      items = [];
      return;
    }
    const end = endSpan ?? headerSpan ?? start;
    scenes.push({
      kind: 'sceneNode',
      title,
      items,
      span: { start: explicit && headerSpan !== null ? headerSpan.start : start.start, end: end.end },
    });
    title = null;
    headerSpan = null;
    startSpan = null;
    endSpan = null;
    items = [];
  };

  for (const unit of units) {
    if (unit.scene !== null) {
      flush();
      title = unit.scene.title;
      explicit = true;
      headerSpan = unit.scene.headerSpan;
    }
    for (const node of unit.nodes) {
      items.push(node);
      if (startSpan === null) startSpan = node.span;
      endSpan = node.span;
    }
  }
  flush();
  return scenes;
}

function composeSlots(units: readonly Unit[]): readonly KojoHiddenSlot[] {
  const slots: KojoHiddenSlot[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    for (const slot of unit.slots) {
      if (seen.has(slot.name)) continue;
      seen.add(slot.name);
      slots.push(slot);
    }
  }
  return slots;
}

/**
 * 文件级 `core/decl/missing-machine`：parser 在**所有** parse 诊断之后才发它，落点是
 * "第一条正文节点"——这个落点会随叙事编辑移动，所以每轮从当前场景重算，不缓存。
 */
function missingMachineDiagnostic(hasMachine: boolean, scenes: readonly KojoSceneNode[]): KojoDiagnostic | null {
  if (hasMachine) return null;
  let first: KojoNarrativeNode | null = null;
  for (const scene of scenes) {
    if (scene.items.length === 0) continue;
    first = scene.items[0]!;
    break;
  }
  if (first === null) return null;
  return {
    code: MISSING_MACHINE,
    severity: severityOf(MISSING_MACHINE),
    message: '这个文件有正文却没有 `# 机`：正文要挂到哪个事件上？先写 `# 机 指令 310` 这类声明（§3.7）。',
    span: first.span,
  };
}

/* ============================== 单元 parse / lower ============================== */

function parseUnitSlice(unitText: string, startLine: number, declKinds: ReadonlyMap<string, string>): UnitParse {
  const lexed = lex(unitText);
  const parsed = parse(lexed);
  const nodes: KojoNarrativeNode[] = [];
  for (const scene of parsed.scenes) for (const node of scene.items) nodes.push(rebaseLines(node, startLine));
  const lexDiags: KojoDiagnostic[] = [];
  for (const diagnostic of lexed.diagnostics) lexDiags.push(rebaseLines(diagnostic, startLine));
  const sourceDiags: KojoDiagnostic[] = [];
  const postDiags: KojoDiagnostic[] = [];
  for (let i = lexed.diagnostics.length; i < parsed.diagnostics.length; i++) {
    const diagnostic = parsed.diagnostics[i]!;
    if (diagnostic.code === MISSING_MACHINE) continue;
    const shifted = rebaseLines(diagnostic, startLine);
    if (CALL_BODY_CODES.has(diagnostic.code)) postDiags.push(shifted);
    else sourceDiags.push(shifted);
  }
  collectCallBodyDiags(nodes, declKinds, postDiags);
  return { nodes, lexDiags, sourceDiags, postDiags };
}

interface Lowered {
  readonly lines: readonly string[];
  readonly mapKinds: readonly SourceMapLineKind[];
  readonly mapSources: readonly (KojoSpan | null)[];
  readonly mapOrigins: readonly (readonly SourceMapOrigin[])[];
  readonly slots: readonly KojoHiddenSlot[];
  readonly walkDiags: readonly KojoDiagnostic[];
}

function emptyLowered(): Lowered {
  return { lines: [], mapKinds: [], mapSources: [], mapOrigins: [], slots: [], walkDiags: [] };
}

function lowerUnit(
  nodes: readonly KojoNarrativeNode[],
  baseCtx: ExpandContext,
  backend: KojoEmitBackend,
  view: string | null,
  sourceText: string,
): Lowered {
  const sink = createDiagnosticSink();
  const ctx = forkExpandContext(baseCtx, sink, sourceText);
  const buffer = createEmitBuffer(Math.max(8, nodes.length * 4));
  const state = createLowerState({ backend, buffer, sink, view });
  walkNarrative(nodes, ctx, state);
  const finished = buffer.finish();
  const map = extractMap(finished.sourceMap);
  return {
    lines: finished.lines,
    mapKinds: map.kinds,
    mapSources: map.sources,
    mapOrigins: map.origins,
    slots: hiddenSlots(ctx),
    walkDiags: sink.all.slice(),
  };
}

interface ExtractedMap {
  readonly kinds: readonly SourceMapLineKind[];
  readonly sources: readonly (KojoSpan | null)[];
  readonly origins: readonly (readonly SourceMapOrigin[])[];
}

function extractMap(map: SourceMap): ExtractedMap {
  const kinds: SourceMapLineKind[] = [];
  const sources: (KojoSpan | null)[] = [];
  const origins: (readonly SourceMapOrigin[])[] = [];
  for (let line = 1; line <= map.lineCount; line++) {
    const mapped = map.lineAt(line);
    if (mapped === null) {
      kinds.push('generated');
      sources.push(null);
      origins.push([]);
    } else {
      kinds.push(mapped.kind);
      sources.push(mapped.source);
      origins.push(mapped.origins);
    }
  }
  return { kinds, sources, origins };
}

function forkExpandContext(base: ExpandContext, sink: DiagnosticSink, sourceText: string): ExpandContext {
  return {
    adapter: base.adapter,
    backend: base.backend,
    sourceText,
    sink,
    view: base.view,
    tables: base.tables,
    pools: base.pools,
    templates: base.templates,
    functions: base.functions,
    constants: base.constants,
    arrays: base.arrays,
    foreachFrames: [],
    tablePlans: base.tablePlans,
    tableStack: [],
    poolStack: [],
    templateStack: [],
    invalidPools: base.invalidPools,
    slots: new Map(),
    slotOrder: [],
    activeSlotScope: null,
    maxDepth: base.maxDepth,
  };
}

/* ============================== 声明 / 机 / 织 ============================== */

function resolveView(decls: readonly KojoDecl[], viewOption: string | null | undefined): string | null {
  if (viewOption !== undefined) return viewOption;
  for (const decl of decls) if (decl.kind === 'view') return decl.target;
  return null;
}

function collectDeclKindLabels(decls: readonly KojoDecl[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const decl of decls) {
    if (decl.kind === 'view' || decl.kind === 'machine' || decl.kind === 'weave') continue;
    const label =
      decl.kind === 'var'
        ? '变量'
        : decl.kind === 'const'
          ? '常量'
          : decl.kind === 'table'
            ? '表'
            : decl.kind === 'pool'
              ? '池'
              : decl.kind === 'template'
                ? '模板'
                : '函数';
    if (decl.name.startsWith('__kojo_')) continue;
    if (labels.has(decl.name)) continue;
    labels.set(decl.name, label);
  }
  return labels;
}

function validateMachines(machines: readonly KojoMachineDecl[], adapter: GameAdapter, sink: DiagnosticSink): void {
  for (let i = 1; i < machines.length; i++) {
    sink.report({
      code: 'core/decl/duplicate-name',
      severity: severityOf('core/decl/duplicate-name'),
      message: '一个 2.0 文件最多挂一个 `# 机` 事件（多时机请拆文件，§3.5）。',
      span: machines[i]!.span,
    });
  }
  const machine = machines[0];
  if (machine === undefined) return;
  const unknown = checkEvent(adapter, machine.event, machine.span);
  if (unknown !== null) {
    sink.report(unknown);
    return;
  }
  for (const diagnostic of checkEventArgs(adapter, machine.event, machine.args, machine.span)) sink.report(diagnostic);
}

/**
 * parser `validateCallBodies` 的唯一 decl 依赖检查（池 / 函数调用不带缩进块）。
 *
 * 为什么在这里复刻：增量单元是"脱离声明"单独 parse 的（声明不重算），parser 的
 * `validateCallBodies` 需要 `declKinds` 才能发 `core/template/unexpected-slot`；
 * 这里用声明索引补跑同一份判据（码 / 级别 / 文案 / span 与 parser 逐字一致），
 * 结果放在单元 parse 诊断之后 —— 与 parser "源序诊断 → 收尾诊断" 的相位一致。
 */
function collectCallBodyDiags(
  nodes: readonly KojoNarrativeNode[],
  declKinds: ReadonlyMap<string, string>,
  out: KojoDiagnostic[],
): void {
  const walkNodeList = (list: readonly KojoNarrativeNode[]): void => {
    for (const node of list) walkNode(node);
  };
  const walkDispatchList = (list: readonly KojoDispatchNode[]): void => {
    for (const node of list) walkDispatch(node);
  };
  const checkCallBody = (call: KojoCallStmt): void => {
    if (call.body === undefined) return;
    const kind = declKinds.get(call.name);
    if (kind !== '池' && kind !== '函数') return;
    out.push({
      code: 'core/template/unexpected-slot',
      severity: severityOf('core/template/unexpected-slot'),
      message: `\`! ${call.name}\` 是${kind === '池' ? '池' : '函数'}调用，不带缩进块：缩进块只用来给 \`# 模\` 的 \`[插槽]\` 填内容（§7.2）。`,
      span: call.span,
    });
  };
  const walkDispatch = (node: KojoDispatchNode): void => {
    switch (node.kind) {
      case 'assign':
      case 'exprCall':
      case 'label':
      case 'jump':
      case 'loopJump':
      case 'return':
      case 'nativeBlock':
      case 'textLine':
      case 'blankLine':
      case 'faceLine':
        return;
      case 'call':
        checkCallBody(node);
        if (node.body !== undefined) walkNodeList(node.body);
        return;
      case 'dispatchCondition':
        for (const branch of node.branches) walkDispatchList(branch.body);
        return;
      case 'sandboxBlock':
      case 'whileLoop':
      case 'repeatLoop':
        walkDispatchList(node.body);
        return;
      case 'forEachLoop':
        walkNodeList(node.body);
        return;
      default:
        return;
    }
  };
  const walkNode = (node: KojoNarrativeNode): void => {
    switch (node.kind) {
      case 'textLine':
      case 'blankLine':
      case 'faceLine':
      case 'nativeBlock':
      case 'label':
      case 'jump':
      case 'loopJump':
        return;
      case 'call':
        checkCallBody(node);
        if (node.body !== undefined) walkNodeList(node.body);
        return;
      case 'conditionChain':
        for (const branch of node.branches) walkNodeList(branch.body);
        return;
      case 'colorBlock':
        walkNodeList(node.body);
        return;
      case 'optionsBlock':
        for (const item of node.items) walkNodeList(item.body);
        return;
      case 'randomBlock':
        for (const candidate of node.candidates) {
          if (candidate.kind === 'randomGroup') walkNodeList(candidate.body);
        }
        return;
      case 'sandboxBlock':
        for (const child of node.body) walkDispatch(child);
        return;
      case 'whileLoop':
      case 'repeatLoop':
        for (const child of node.body) walkDispatch(child);
        return;
      case 'forEachLoop':
        walkNodeList(node.body);
        return;
      default:
        return;
    }
  };
  walkNodeList(nodes);
}

/* ============================== 行切分 / 编辑安全 ============================== */

interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 顶层语句单元切分（安全切分点）：
 * - 行首不缩进的非空/非注释行开始一个新单元；
 * - 缩进行（块体）、注释、空行并入当前单元；`@原生` 体行（含缩进为 0 的空行）一律并入；
 * - `?` 链：连续同缩进 `?` 行 + 缩进体 + 之间注释算一个单元；**空行断链**（parser §5 同口径）；
 * - 文件开头的空行/注释自成一个 trivia 单元。
 */
function partitionLines(lines: readonly KojoLexLine[]): LineRange[] {
  const ranges: LineRange[] = [];
  let start = -1;
  let chainOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const record = lines[i]!;
    const cls = classOf(record);
    if (start < 0) {
      start = i;
      chainOpen = cls === 'condition';
      continue;
    }
    if (record.kind === 'native') continue; // `@原生` 体（含空行）不切分
    if (record.kind === 'blank') {
      chainOpen = false;
      continue;
    }
    if (record.kind === 'comment') continue;
    if (record.indent !== 0) continue;
    if (cls === 'condition' && chainOpen) continue;
    ranges.push({ start, end: i });
    start = i;
    chainOpen = cls === 'condition';
  }
  if (start >= 0) ranges.push({ start, end: lines.length });
  return ranges;
}

function classOf(record: KojoLexLine): LineClass {
  switch (record.kind) {
    case 'decl':
      return 'decl';
    case 'options':
      return 'options';
    case 'condition':
      return 'condition';
    case 'native':
      return 'native';
    case 'blank':
    case 'comment':
      return 'trivia';
    case 'dispatch':
      return record.word === '函' || record.word === '织' ? 'decl' : `dispatch:${record.word}`;
    default:
      return 'leaf';
  }
}

/**
 * 单行编辑后的结构等价类判定（单元边界会不会动）。
 *
 * 允许：同一锚点词内编辑（`@颜绘` 参数、`@着色` 颜色…）、普通文本/叙事行互转、
 * 空白 ↔ 普通行、`?` 行改成普通行（链拆分完全落在本单元行范围内）。
 * 禁止：声明/锚点词变化（块种类变了）、普通行变成 `?`（可能把后面的链并进来）、
 * 进/出 `@原生` 围栏、缩进变化（行可能投到相邻单元所属的块里）。
 */
function safeLineTransition(oldMeta: LineMeta, nextCls: LineClass, nextIndent: number): boolean {
  if (oldMeta.indent !== nextIndent) return false;
  const oldCls = oldMeta.cls;
  if (oldCls === nextCls) return true;
  if (oldCls === 'decl' || nextCls === 'decl') return false;
  if (oldCls === 'options' || nextCls === 'options') return false;
  if (oldCls === 'native' || nextCls === 'native') return false;
  if (oldCls.startsWith('dispatch:') || nextCls.startsWith('dispatch:')) return false;
  if (nextCls === 'condition') return false;
  return true;
}

function isConsistentEdit(oldText: string, text: string, edit: IncrementalEdit): boolean {
  const offset = edit.offset;
  const removedLength = edit.removedLength;
  if (!Number.isInteger(offset) || offset < 0 || offset > oldText.length) return false;
  if (!Number.isInteger(removedLength) || removedLength < 0 || offset + removedLength > oldText.length) return false;
  if (typeof edit.insertedText !== 'string') return false;
  if (text.length !== oldText.length - removedLength + edit.insertedText.length) return false;
  if (!text.startsWith(oldText.slice(0, offset))) return false;
  if (!text.endsWith(oldText.slice(offset + removedLength))) return false;
  return true;
}

/* ============================== 工具 ============================== */

/** 行首表（LF / CRLF / 裸 CR 都按一个物理行处理；末行无换行也算一行；空文本 = 0 行） */
function lineStartsOf(text: string): number[] {
  if (text.length === 0) return [];
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 /* \r */) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  if (starts.length > 1 && starts[starts.length - 1] === text.length) starts.pop();
  return starts;
}

function lineCount(text: string): number {
  return lineStartsOf(text).length;
}

function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function offsetOfLine(lineStarts: readonly number[], text: string, lineIndex: number): number {
  return lineIndex < lineStarts.length ? lineStarts[lineIndex]! : text.length;
}

function sliceLines(text: string, lineStarts: readonly number[], startLine: number, endLine: number): string {
  return text.slice(offsetOfLine(lineStarts, text, startLine), offsetOfLine(lineStarts, text, endLine));
}

function spanOfLine(record: KojoLexLine, positions: PositionIndex): KojoSpan {
  return { start: positions.at(record.contentOffset), end: positions.at(record.contentEnd) };
}

function hasError(diagnostics: readonly KojoDiagnostic[]): boolean {
  for (const diagnostic of diagnostics) if (diagnostic.severity === 'error') return true;
  return false;
}

function materializeWrapped(
  result: EmitResult,
  report: (diagnostics: readonly KojoDiagnostic[]) => void,
): readonly string[] | null {
  if (result === null) return [];
  if (typeof result === 'string') return [result];
  if (isEmitFailure(result)) {
    report(result.diagnostics);
    return null;
  }
  return result;
}

/** 在 wrapper 产物里找回 body 子序列（与 `runCompile` 同判据：trimStart 后逐字相等） */
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

/* ============================== 行号平移（局部 parse → 全文件坐标） ============================== */

function isPosition(value: unknown): value is KojoPosition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { line?: unknown; column?: unknown };
  return typeof candidate.line === 'number' && typeof candidate.column === 'number';
}

function isSpan(value: unknown): value is KojoSpan {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { start?: unknown; end?: unknown };
  return isPosition(candidate.start) && isPosition(candidate.end);
}

/**
 * 局部坐标 → 全文件坐标：单元切片从整行行首开始，所以**列不变、只有行号平移**。
 * 只改 `span` 字段（AST 与诊断的落点都在这里；表达式同理）。
 */
function rebaseLines<T>(value: T, lineDelta: number): T {
  if (Array.isArray(value)) return value.map((item) => rebaseLines(item, lineDelta)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const child = source[key];
      if (key === 'span' && isSpan(child)) {
        out[key] = {
          start: { line: child.start.line + lineDelta, column: child.start.column },
          end: { line: child.end.line + lineDelta, column: child.end.column },
        };
        continue;
      }
      out[key] = rebaseLines(child, lineDelta);
    }
    return out as T;
  }
  return value;
}

/* ============================== 深比较（自检用） ============================== */

function sameCompiled(a: CompileKojoSourceResult, b: CompileKojoSourceResult): boolean {
  return (
    a.ok === b.ok &&
    a.erb === b.erb &&
    sameSourceMap(a.sourceMap, b.sourceMap) &&
    deepEqual(a.diagnostics, b.diagnostics) &&
    deepEqual(a.slots, b.slots) &&
    deepEqual(a.file, b.file)
  );
}

function sameSourceMap(a: SourceMap, b: SourceMap): boolean {
  if (a.lineCount !== b.lineCount || a.segmentCount !== b.segmentCount) return false;
  for (let line = 1; line <= a.lineCount; line++) {
    if (!deepEqual(a.lineAt(line), b.lineAt(line))) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const lv = left[key];
      const rv = right[key];
      if (lv === undefined && rv === undefined) continue;
      if (!deepEqual(lv, rv)) return false;
    }
    return true;
  }
  return false;
}
