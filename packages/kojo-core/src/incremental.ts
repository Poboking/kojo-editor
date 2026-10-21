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
 * - 普通叙事单元内部可以改（含块体行、`@着色` / `@随机` 体、`?` 分支体）——只要编辑后
 *   该行的**结构等价类**不变（见 `safeLineTransition`），单元边界就不会移动；
 * - **声明单元内可以改**（`# 表` / `# 池` / `# 模` / `# 函` / `# 机` / `# 幕`）：只重建该单元，
 *   再按"名字引用闭包"重算依赖它的展开点（池/模体里引用的表、数组长度引用的常量都在闭包里）；
 *   视点（`# 视` target）变了会改所有 `{我}`/池内裸引号 ⇒ 回退全量；
 * - **行数变化**只要形状能证明就只做平移：`插入/删除恰好一行`（换行 + 该行内容，或内容 + 换行）
 *   ⇒ 窗口之外的字逐字不变，所有单元缓存原样复用，只平移 span / 槽名（`__kojo_rand_<行>` /
 *   `__kojo_foreach_<行>` 的行号部分按"那一行落在窗口哪一侧"逐行重算），并把被新行/删行碰到
 *   的几个单元（halo）重算；
 * - 仍然证不出等价（跨行替换、窗口落在声明上又无法重解析、单元边界对不上、源里出现
 *   `__kojo_` 字面量…）⇒ 回退全量；
 * - 文件含 `选项`（全局计数诊断）、BOM、或模型自检失败：`degraded` 置位，之后永远全量。
 *
 * ── 回退判定的保险：**构建期自检** ─────────────────────────────────────────
 * 每次全量重建缓存后，会把"单元拼接"的结果与真正的全量结果逐字对比
 * （ok / erb / 每行 source map（含列级分段）/ 诊断顺序 / 隐藏槽 / AST）。不一致就
 * `degraded = true` 并永久走全量——宁可慢，不可错。结构化增量本身不跑全量对拍（跑一次
 * 就等于放弃增量），它对每一条编辑都要**在函数内证明**：单元边界用"外圈各扩一个单元切片
 * lex + partition 逐段重现"验证，声明语义用"去掉 span 后逐项对拍 + 名字闭包"验证。
 * `tests/incremental.test.ts` 的 golden 断言（随机编辑增量 === 全量）钉住同一条契约。
 *
 * ── 性能口径（实测见 tests/incremental.test.ts） ──────────────────────────
 * 5000+ 行 / ~5500 单元的源文本：全量 compile 中位数 25–40ms 量级，整份缓存重建（旧回退路径）
 *   200–350ms；单字符编辑的增量路径只做 O(脏单元行数) 的 lex/parse/lower + O(总产物行数) 的
 *   拼接与 source map 重登记 + 一次 `wrapMachine`，实测 4–6ms。回退路径的增量版
 *   （K2-PERF-INCR-FALLBACK）实测：**纯换行插入/删除 14–21ms**、**单个声明单元内编辑
 *   55–75ms**（该 fixture 每 7 行调用一次被改的池 ⇒ 重算 ~13% 的单元），都远低于旧的整份重建。
 *   构建期（首帧）是 O(单元数) 的探针 + 一次全量自检，属冷路径：编辑器在文档打开时付一次。
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
import { checkKojoFile } from './sema/check.js';
import { featureDiagnosticKey } from './lower/feature-gate.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import type { PositionIndex } from './positions.js';
import { createSourceMapBuilder, segmentSpecsOf } from './source-map.js';
import type {
  SourceMap,
  SourceMapBuilder,
  SourceMapLineKind,
  SourceMapOrigin,
  SourceMapSegmentSpec,
} from './source-map.js';
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
import { KOJO_RESERVED_PREFIX } from './tokens.js';

/* ============================== 公共形状 ============================== */

/** 一次文本编辑：相对**上一轮文本**的半开区间替换（Monaco `applyEdits` 同口径） */
export interface IncrementalEdit {
  /** 上一轮文本里的 0 基 UTF-16 偏移 */
  readonly offset: number;
  /** 上一轮文本里被删掉的码元数 */
  readonly removedLength: number;
  /** 新插入的文本（含换行时走"行号平移"增量：只要它是"插一行"的形状，否则回退全量） */
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
  /** 本轮重新 parse 的单元数（行内单行编辑 = 1；平移/声明重建 = halo 单元 + 重解析的展开点） */
  readonly reparsedUnits: number;
  /** 本轮重新 lower 的单元数（行内单行编辑 = 1；声明变更时 = 被改单元 + 依赖它的展开点） */
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
  /** 单元源文本切片（复用判定的唯一依据；行号平移不碰它） */
  readonly text: string;
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
  /** IR：逐产物行的列级分段（列相对该产物行；undefined = 该行没有列级事实） */
  mapSegments: readonly (readonly SourceMapSegmentSpec[] | undefined)[];
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
  weaveSegments: readonly (readonly SourceMapSegmentSpec[] | undefined)[];
  baseCtx: ExpandContext;
  totalNodes: number;
  /** 声明下标 → 所属单元下标（-1 = 映射不到；结构化增量据此只重建受影响的声明块） */
  declUnitOfDecl: readonly number[];
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
      // 结构化增量：行号平移（纯换行增删）+ 只重建受影响单元（含声明单元与其展开点）。
      const structural = tryStructuralIncremental(current, text, edit, adapter, backend, options.view);
      if (structural.kind === 'ok') {
        state = structural.state;
        return { result: structural.result, stats: { ...structural.stats, ms: clockNow() - startedAt } };
      }
      return rebuildAll(text, structural.reason, startedAt);
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
  const starts = lineStartsOf(text);
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
      text: sliceLines(text, starts, range.start, range.end),
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
      mapSegments: [],
      slots: [],
      walkDiags: [],
    });
  }

  const decls: readonly KojoDecl[] = parsed.decls;
  const machines = decls.filter((decl): decl is KojoMachineDecl => decl.kind === 'machine');
  // 声明 → 所属单元（结构化增量只重建"改动声明 + 依赖它的展开点"；-1 = 映射不到，宿主改走全量）
  const declUnitOfDecl: number[] = [];
  for (const decl of decls) {
    const unitIndex = unitOfLine[decl.span.start.line - 1];
    declUnitOfDecl.push(unitIndex === undefined ? -1 : unitIndex);
  }

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
  // 能力闸单源（K2-FEATURE-GATE-UNIFY）：双源不一致的 error 进 validation 面，
  // 位置与 full compile（`lower/expand/index.ts`：校验之后、机/正文之前）逐项对齐。
  for (const diagnostic of baseCtx.featureGate.diagnostics) validationSink.report(diagnostic);
  const validationDiags = validationSink.all.slice();

  const machineSink = createDiagnosticSink();
  validateMachines(machines, adapter, machineSink);
  const machineDiags = machineSink.all.slice();

  const weaveSink = createDiagnosticSink();
  const weaveCtx = forkExpandContext(baseCtx, weaveSink, text);
  const weaveBuffer = createEmitBuffer(32);
  const weaveState = createLowerState({ backend, buffer: weaveBuffer, sink: weaveSink, view, featureGate: weaveCtx.featureGate });
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
    unit.mapSegments = lowered.mapSegments;
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
    weaveSegments: weaveMap.segments,
    baseCtx,
    totalNodes,
    declUnitOfDecl,
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
    text: newUnitText,
    meta: newMeta,
    nodes: unitParse.nodes,
    lexDiags: unitParse.lexDiags,
    sourceDiags: unitParse.sourceDiags,
    postDiags: unitParse.postDiags,
    lines: lowered.lines,
    mapKinds: lowered.mapKinds,
    mapSources: lowered.mapSources,
    mapOrigins: lowered.mapOrigins,
    mapSegments: lowered.mapSegments,
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

/* ============================== 结构化增量：行号平移 + 受影响单元重建 ============================== */

/**
 * 行号平移事实：**0 基**行下标 `>= at` 的行整体平移 `delta` 行（delta = 0 即恒等映射）。
 *
 * 为什么只有一段：编辑窗口之外的字**逐字不变**（`isConsistentEdit` 已钉住前后缀），
 * 所以窗口之前的行号原样、之后的每一行都挪 `delta`——这就是"纯换行插入/删除"的全部代价。
 */
interface LineShift {
  readonly at: number;
  readonly delta: number;
}

const NO_SHIFT: LineShift = { at: Number.POSITIVE_INFINITY, delta: 0 };
/** 编译器保留前缀：源里出现它就说明作者手写了 `__kojo_*` 字面量（`@原生` 里），槽名平移会误改 → 全量 */
const RESERVED_PREFIX = KOJO_RESERVED_PREFIX;

/** 1 基行号 → 平移后的行号（span / 诊断 / 槽名里的行号都用这一份口径） */
function mapSpanLine(line: number, shift: LineShift): number {
  return line > shift.at ? line + shift.delta : line;
}

/** 0 基行**边界**（单元起止）→ 平移后的边界；与 `mapSpanLine` 同一分段点（边界 i=at 对应行号 at+1） */
function mapLineBoundary(boundary: number, shift: LineShift): number {
  return boundary >= shift.at ? boundary + shift.delta : boundary;
}

function shiftSpan(span: KojoSpan, shift: LineShift): KojoSpan {
  const start = mapSpanLine(span.start.line, shift);
  const end = mapSpanLine(span.end.line, shift);
  if (start === span.start.line && end === span.end.line) return span;
  return {
    start: { line: start, column: span.start.column },
    end: { line: end, column: span.end.column },
  };
}

/**
 * 把任意 AST / 诊断 / source map 结构里的 span 按 `shift` 平移。
 *
 * 结构共享：子树里没有任何 span 需要动时**返回原引用**（前缀单元常常整棵不动 ⇒ 零拷贝）。
 */
function shiftSpans<T>(value: T, shift: LineShift): T {
  if (shift.delta === 0) return value;
  if (isSpan(value)) return shiftSpan(value, shift) as unknown as T;
  if (Array.isArray(value)) {
    const length = value.length;
    const next: unknown[] = new Array(length);
    let changed = false;
    for (let i = 0; i < length; i++) {
      const child = shiftSpans(value[i], shift);
      next[i] = child;
      if (child !== value[i]) changed = true;
    }
    return changed ? (next as unknown as T) : value;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    const next: unknown[] = new Array(keys.length);
    let changed = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const child = shiftSpans(source[key], shift);
      next[i] = child;
      if (child !== source[key]) changed = true;
    }
    if (!changed) return value;
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) out[keys[i]!] = next[i];
    return out as T;
  }
  return value;
}

/** 槽名里的行号后缀：`__kojo_rand_<行>` / `__kojo_foreach_<行>[_i|_e|_k|_n]` */
const SLOT_NAME_RE = /^(__kojo_(?:rand|foreach)_)(\d+)(.*)$/;
/** 产物行里对隐藏槽的引用（core 只发引用，声明交 adapter） */
const SLOT_REF_RE = /(__kojo_(?:rand|foreach)_)(\d+)/g;

function shiftSlotName(name: string, shift: LineShift): string {
  if (shift.delta === 0) return name;
  const match = SLOT_NAME_RE.exec(name);
  if (match === null) return name;
  const line = Number(match[2]);
  const next = mapSpanLine(line, shift);
  return next === line ? name : `${match[1]!}${next}${match[3]!}`;
}

function shiftSlotRefs(line: string, shift: LineShift): string {
  if (shift.delta === 0 || line.indexOf(RESERVED_PREFIX) < 0) return line;
  return line.replace(SLOT_REF_RE, (whole: string, prefix: string, digits: string) => {
    const line0 = Number(digits);
    const next = mapSpanLine(line0, shift);
    return next === line0 ? whole : `${prefix}${next}`;
  });
}

/**
 * 复用单元的整体平移：span（节点 / 诊断 / source map 行与锚点）按 `shift` 走，
 * 隐藏槽名里的行号按同一口径重算，产物行里对这些槽的引用同步改名。
 *
 * 一条硬约束：槽名里的行号是**源行**（池 / 模体里的 `@随机`、`@巡` 用声明行号命名），
 * 所以平移必须按"那一行落在窗口哪一侧"逐行判断，不能整单元加 delta。
 */
function shiftUnit(unit: Unit, shift: LineShift): Unit {
  if (shift.delta === 0) return unit;
  const startLine = mapLineBoundary(unit.startLine, shift);
  const endLine = mapLineBoundary(unit.endLine, shift);
  const nodes = shiftSpans(unit.nodes, shift);
  let scene = unit.scene;
  if (unit.scene !== null) {
    const headerSpan = shiftSpan(unit.scene.headerSpan, shift);
    if (headerSpan !== unit.scene.headerSpan) scene = { title: unit.scene.title, headerSpan };
  }
  const lexDiags = shiftSpans(unit.lexDiags, shift);
  const sourceDiags = shiftSpans(unit.sourceDiags, shift);
  const postDiags = shiftSpans(unit.postDiags, shift);
  const walkDiags = shiftSpans(unit.walkDiags, shift);
  const mapSources = shiftSpans(unit.mapSources, shift);
  const mapOrigins = shiftSpans(unit.mapOrigins, shift);
  const mapSegments = shiftSpans(unit.mapSegments, shift);
  let slots = unit.slots;
  if (unit.slots.length > 0) {
    let renamed = false;
    const nextSlots: KojoHiddenSlot[] = new Array(unit.slots.length);
    for (let i = 0; i < unit.slots.length; i++) {
      const slot = unit.slots[i]!;
      const name = shiftSlotName(slot.name, shift);
      if (name === slot.name) nextSlots[i] = slot;
      else {
        nextSlots[i] = { ...slot, name };
        renamed = true;
      }
    }
    if (renamed) slots = nextSlots;
  }
  // 槽名变了才需要重写产物行（否则 O(1) 复用，keystroke / 平移都别为它付费）
  const lines = slots === unit.slots ? unit.lines : unit.lines.map((line) => shiftSlotRefs(line, shift));
  if (
    startLine === unit.startLine &&
    endLine === unit.endLine &&
    nodes === unit.nodes &&
    scene === unit.scene &&
    lexDiags === unit.lexDiags &&
    sourceDiags === unit.sourceDiags &&
    postDiags === unit.postDiags &&
    walkDiags === unit.walkDiags &&
    mapSources === unit.mapSources &&
    mapOrigins === unit.mapOrigins &&
    mapSegments === unit.mapSegments &&
    lines === unit.lines
  ) {
    return unit;
  }
  return {
    ...unit,
    startLine,
    endLine,
    scene,
    nodes,
    lexDiags,
    sourceDiags,
    postDiags,
    walkDiags,
    mapSources,
    mapOrigins,
    mapSegments,
    slots,
    lines,
  };
}

/** `eol + 其余内容`（其余内容里不许再有换行）= 一次"插一行"；不是这个形状返回 null */
function splitSingleEol(text: string): { readonly eol: string; readonly rest: string } | null {
  const eol = text.startsWith('\r\n') ? '\r\n' : text.startsWith('\n') ? '\n' : text.startsWith('\r') ? '\r' : null;
  if (eol === null) return null;
  const rest = text.slice(eol.length);
  if (rest.indexOf('\n') >= 0 || rest.indexOf('\r') >= 0) return null;
  return { eol, rest };
}

/** `新行内容 + eol`（内容里不许有换行）＝ 插在行首的那一种形状；不是这个形状返回 null */
function splitTrailingEol(text: string): { readonly eol: string; readonly head: string } | null {
  const eol = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : text.endsWith('\r') ? '\r' : null;
  if (eol === null) return null;
  const head = text.slice(0, text.length - eol.length);
  if (head.indexOf('\n') >= 0 || head.indexOf('\r') >= 0) return null;
  return { eol, head };
}

function lineStartOf(lineStarts: readonly number[], line0: number): number {
  return lineStarts[line0] ?? 0;
}

/** 一行的行尾符长度（LF / CRLF / 裸 CR / 无行尾） */
function eolLengthOf(text: string, lineStart: number, lineEnd: number): number {
  if (lineEnd <= lineStart) return 0;
  const last = text.charCodeAt(lineEnd - 1);
  if (last === 10) return lineEnd - 1 > lineStart && text.charCodeAt(lineEnd - 2) === 13 ? 2 : 1;
  if (last === 13) return 1;
  return 0;
}

function unitIndexAtLine(state: CacheState, line0: number): number {
  const unitIndex = state.unitOfLine[line0];
  return unitIndex === undefined ? -1 : unitIndex;
}

function declNameOf(decl: KojoDecl): string | null {
  switch (decl.kind) {
    case 'var':
    case 'const':
    case 'table':
    case 'pool':
    case 'template':
    case 'function':
      return decl.name;
    default:
      return null;
  }
}

function hasDuplicateDeclNames(decls: readonly KojoDecl[]): boolean {
  const seen = new Set<string>();
  for (const decl of decls) {
    const name = declNameOf(decl);
    if (name === null) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/** 去掉一切 `span` 后的稳定序列化：判"声明**语义**变没变"（纯行号平移不算变） */
function stripSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSpans(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (key === 'span') continue;
      out[key] = stripSpans(source[key]);
    }
    return out;
  }
  return value;
}

function declSignatureOf(decl: KojoDecl): string {
  return JSON.stringify(stripSpans(decl));
}

const IDENTIFIER_TOKEN_RE = /[\p{L}_][\p{L}\p{N}_]*/gu;

/** 文本里是否出现这些名字（按标识符整词判；宁可多算，不可漏算） */
function mentionsAny(text: string, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  IDENTIFIER_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = IDENTIFIER_TOKEN_RE.exec(text);
  while (match !== null) {
    if (names.has(match[0])) return true;
    match = IDENTIFIER_TOKEN_RE.exec(text);
  }
  return false;
}

function sameDeclKindLabels(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, label] of a) if (b.get(name) !== label) return false;
  return true;
}

function collectNamedDeclSignatures(decls: readonly KojoDecl[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of decls) {
    const name = declNameOf(decl);
    if (name !== null) out.set(name, declSignatureOf(decl));
  }
  return out;
}

function collectUnnamedDeclSignatures(decls: readonly KojoDecl[]): string[] {
  const out: string[] = [];
  for (const decl of decls) if (declNameOf(decl) === null) out.push(declSignatureOf(decl));
  return out;
}

function declsGroupedByUnit(state: CacheState): Map<number, KojoDecl[]> {
  const out = new Map<number, KojoDecl[]>();
  for (let i = 0; i < state.decls.length; i++) {
    const unitIndex = state.declUnitOfDecl[i]!;
    const bucket = out.get(unitIndex);
    if (bucket === undefined) out.set(unitIndex, [state.decls[i]!]);
    else bucket.push(state.decls[i]!);
  }
  return out;
}

function unsafeStructural(reason: string): FastOutcome {
  return { kind: 'unsafe', reason };
}

/**
 * 结构化增量（回退路径的增量版）：**行号平移 + 只重建受影响单元**。
 *
 * 能证明安全的两类编辑：
 * 1. **纯换行**（插入/删除恰好一个换行序列，另一侧没有内容改动；`delta = ±1`）：
 *    其余行逐字不变，所有单元缓存原样复用，只做 span / 槽名平移；被新行/合并行碰到的那几个
 *    单元（halo）重算。
 * 2. **行内改动**（单行内替换，`delta = 0`）：halo 内的单元重算——声明单元就走"重解析该单元
 *    + 依赖它的展开点重算"。
 *
 * 证明方式（都在本函数内、O(halo 行数) 的局部校验，不 lex 全文件）：
 * - **单元边界**：把 halo 前后各扩一个单元一起切片 `lex + partitionLines`，要求外圈两段的
 *   行范围与旧缓存逐段重现、中间段连续覆盖——边界成立才继续；任何不一致 → 回退全量；
 * - **声明语义**：`decls` 去掉 span 后逐项对拍，变了就按名字算依赖闭包（池/模体里引用的名字、
 *   `# 变量` 数组长度引用的 `# 常量`），只重算提到这些名字的单元；
 * - **跨单元 parse 上下文**：重解析声明单元时，同一单元内重复声明名 / 视点变化 → 回退全量。
 */
function tryStructuralIncremental(
  current: CacheState,
  text: string,
  edit: IncrementalEdit,
  adapter: GameAdapter,
  backend: KojoEmitBackend,
  viewOption: string | null | undefined,
): FastOutcome {
  const oldText = current.text;
  const oldStarts = current.lineStarts;
  const oldLineCount = oldStarts.length;
  if (oldLineCount === 0) return unsafeStructural('empty-source');
  if (text.indexOf(RESERVED_PREFIX) >= 0) return unsafeStructural('reserved-prefix-in-source');

  const newStarts = lineStartsOf(text);
  const newLineCount = newStarts.length;
  const deltaLines = newLineCount - oldLineCount;
  const removed = oldText.slice(edit.offset, edit.offset + edit.removedLength);
  const inserted = edit.insertedText;

  let shift: LineShift;
  let windowStart: number;
  let windowEnd: number;
  if (deltaLines === 0) {
    // 行内改动：行数不变，且删/插里都不含换行。
    if (inserted.indexOf('\n') >= 0 || inserted.indexOf('\r') >= 0) return unsafeStructural('multiline-insert');
    if (removed.indexOf('\n') >= 0 || removed.indexOf('\r') >= 0) return unsafeStructural('multiline-delete');
    const lineA = lineIndexAt(oldStarts, edit.offset);
    const lineB = lineIndexAt(oldStarts, edit.offset + edit.removedLength);
    if (lineA !== lineB) return unsafeStructural('multiline-edit-range');
    shift = NO_SHIFT;
    windowStart = lineA;
    windowEnd = lineB;
  } else if (deltaLines === 1) {
    // 插一行：插入文本 = `行尾符 + 新行内容`（落在行内容末尾）或 `新行内容 + 行尾符`（落在行首）。
    // 两种形状都只允许**恰好一个**行尾符，且新行内容里不许再带换行。
    if (edit.removedLength !== 0) return unsafeStructural('multiline-insert');
    const at = lineIndexAt(oldStarts, edit.offset);
    const lineStartOffset = oldStarts[at] ?? 0;
    const lineEndOffset = at + 1 < oldLineCount ? oldStarts[at + 1]! : oldText.length;
    const contentEndOffset = lineEndOffset - eolLengthOf(oldText, lineStartOffset, lineEndOffset);
    let insertedBefore: number;
    if (edit.offset === contentEndOffset) {
      if (splitSingleEol(inserted) === null) return unsafeStructural('multiline-insert');
      insertedBefore = at + 1;
    } else if (edit.offset === lineStartOffset) {
      if (splitTrailingEol(inserted) === null) return unsafeStructural('multiline-insert');
      insertedBefore = at;
    } else {
      return unsafeStructural('multiline-insert');
    }
    if (insertedBefore <= 0 || insertedBefore > oldLineCount) return unsafeStructural('multiline-insert');
    shift = { at: insertedBefore, delta: 1 };
    windowStart = Math.max(0, insertedBefore - 1);
    windowEnd = Math.min(oldLineCount - 1, insertedBefore + 1);
  } else if (deltaLines === -1) {
    // 删一行：被删区间 = 行 L 的行尾符 + 行 L+1 的**全部内容**（行 L 内容逐字不动、行 L+1 整行消失）。
    if (inserted !== '') return unsafeStructural('multiline-delete');
    const at = lineIndexAt(oldStarts, edit.offset);
    if (at + 1 >= oldLineCount) return unsafeStructural('multiline-delete');
    const lineEndOffset = at + 1 < oldLineCount ? oldStarts[at + 1]! : oldText.length;
    const nextStartOffset = oldStarts[at + 1]!;
    const nextEndOffset = at + 2 < oldLineCount ? oldStarts[at + 2]! : oldText.length;
    const contentEndOffset = lineEndOffset - eolLengthOf(oldText, lineStartOf(oldStarts, at), lineEndOffset);
    const nextContentEndOffset = nextEndOffset - eolLengthOf(oldText, nextStartOffset, nextEndOffset);
    if (edit.offset !== contentEndOffset) return unsafeStructural('multiline-delete');
    if (edit.offset + edit.removedLength !== nextContentEndOffset) return unsafeStructural('multiline-delete');
    const removedLine = at + 1;
    shift = { at: removedLine, delta: -1 };
    windowStart = Math.max(0, removedLine - 1);
    windowEnd = Math.min(oldLineCount - 1, removedLine + 1);
  } else {
    return unsafeStructural(deltaLines > 0 ? 'multiline-insert' : 'multiline-delete');
  }

  const oldUnits = current.units;
  const firstHalo = unitIndexAtLine(current, windowStart);
  const lastHalo = unitIndexAtLine(current, windowEnd);
  if (firstHalo < 0 || lastHalo < firstHalo || lastHalo >= oldUnits.length) {
    return unsafeStructural('unit-unmapped');
  }
  for (const unitIndex of current.declUnitOfDecl) {
    if (unitIndex < 0) return unsafeStructural('decl-unit-unmapped');
  }
  let previousDeclUnit = -1;
  for (const unitIndex of current.declUnitOfDecl) {
    if (unitIndex < previousDeclUnit) return unsafeStructural('decl-unit-order');
    previousDeclUnit = unitIndex;
  }
  // 声明只允许挂在"首行是 `#` / `@函` / `@织` 且不缩进"的单元上：否则"按单元拼声明"的模型不成立
  for (const unitIndex of current.declUnitOfDecl) {
    const owner = oldUnits[unitIndex];
    if (owner === undefined || owner.headCls !== 'decl' || owner.headIndent !== 0) {
      return unsafeStructural('decl-unit-shape');
    }
  }

  const extraFirst = firstHalo > 0 ? firstHalo - 1 : -1;
  const extraLast = lastHalo + 1 < oldUnits.length ? lastHalo + 1 : -1;
  const haloStartOld = oldUnits[firstHalo]!.startLine;
  const haloEndOld = oldUnits[lastHalo]!.endLine;
  const extStartOld = extraFirst >= 0 ? oldUnits[extraFirst]!.startLine : haloStartOld;
  const extEndOld = extraLast >= 0 ? oldUnits[extraLast]!.endLine : haloEndOld;
  const haloStartNew = mapLineBoundary(haloStartOld, shift);
  const haloEndNew = mapLineBoundary(haloEndOld, shift);
  const extStartNew = mapLineBoundary(extStartOld, shift);
  const extEndNew = mapLineBoundary(extEndOld, shift);
  if (extEndNew <= extStartNew || haloEndNew <= haloStartNew) return unsafeStructural('unit-boundary-mismatch');

  // ── 单元边界局部校验：外圈各扩一个单元，切片 lex + partition 必须逐段重现 ──
  const extLexed = lex(sliceLines(text, newStarts, extStartNew, extEndNew));
  for (const record of extLexed.lines) {
    if (classOf(record) === 'options') return unsafeStructural('options-block');
  }
  const extRanges = partitionLines(extLexed.lines);
  let lowerBound = 0;
  let upperBound = extRanges.length;
  if (extraFirst >= 0) {
    const extra = oldUnits[extraFirst]!;
    const got = extRanges[0];
    if (got === undefined || got.start !== 0 || got.end !== extra.endLine - extStartNew) {
      return unsafeStructural('unit-boundary-mismatch');
    }
    lowerBound = 1;
  } else if (extStartNew !== 0) {
    return unsafeStructural('unit-boundary-mismatch');
  }
  if (extraLast >= 0) {
    const extra = oldUnits[extraLast]!;
    const got = extRanges[extRanges.length - 1];
    const wantStart = mapLineBoundary(extra.startLine, shift) - extStartNew;
    const wantEnd = mapLineBoundary(extra.endLine, shift) - extStartNew;
    if (got === undefined || got.start !== wantStart || got.end !== wantEnd) {
      return unsafeStructural('unit-boundary-mismatch');
    }
    upperBound = extRanges.length - 1;
  }
  if (upperBound <= lowerBound) return unsafeStructural('unit-boundary-mismatch');

  const haloParses: SliceParse[] = [];
  let cursor = haloStartNew;
  for (let i = lowerBound; i < upperBound; i++) {
    const range = extRanges[i]!;
    const absStart = range.start + extStartNew;
    const absEnd = range.end + extStartNew;
    if (absStart !== cursor) return unsafeStructural('unit-boundary-mismatch');
    cursor = absEnd;
    const slice = parseSliceInto(sliceLines(text, newStarts, absStart, absEnd), absStart);
    for (const meta of slice.meta) if (meta.cls === 'options') return unsafeStructural('options-block');
    haloParses.push(slice);
  }
  if (cursor !== haloEndNew) return unsafeStructural('unit-boundary-mismatch');
  // 重建出来的单元里如果出现"声明头但缩进不为 0"这种畸形，交给全量（本模型不解释它）
  for (const slice of haloParses) {
    if (slice.headCls === 'decl' && slice.headIndent !== 0) return unsafeStructural('orphan-unit');
    if (slice.strayDecls) return unsafeStructural('stray-declaration');
  }

  const haloCount = haloParses.length;
  const oldDeclsByUnit = declsGroupedByUnit(current);
  const suffixShift = (oldIndex: number): number => firstHalo + haloCount + (oldIndex - (lastHalo + 1));

  // ── 声明表：复用单元取旧声明平移，重建单元取切片 parse 结果（按单元顺序）──
  const newDecls: KojoDecl[] = [];
  const declUnitOfDecl: number[] = [];
  for (let i = 0; i < firstHalo; i++) {
    for (const decl of oldDeclsByUnit.get(i) ?? []) {
      newDecls.push(shiftSpans(decl, shift));
      declUnitOfDecl.push(i);
    }
  }
  for (let j = 0; j < haloParses.length; j++) {
    for (const decl of haloParses[j]!.decls) {
      newDecls.push(decl);
      declUnitOfDecl.push(firstHalo + j);
    }
  }
  for (let i = lastHalo + 1; i < oldUnits.length; i++) {
    for (const decl of oldDeclsByUnit.get(i) ?? []) {
      newDecls.push(shiftSpans(decl, shift));
      declUnitOfDecl.push(suffixShift(i));
    }
  }

  const machines = newDecls.filter((decl): decl is KojoMachineDecl => decl.kind === 'machine');
  const view = resolveView(newDecls, viewOption);
  if (view !== current.view) return unsafeStructural('view-changed');
  if (hasDuplicateDeclNames(newDecls)) return unsafeStructural('duplicate-decl-names');
  const rebuiltDeclUnit = haloParses.some((slice) => slice.headCls === 'decl' && slice.headIndent === 0);
  // 重复声明名的诊断来自"全量 parse 的跨单元上下文"：重建声明单元时切片复现不了，退回全量。
  if (rebuiltDeclUnit && hasDuplicateDeclNames(current.decls)) return unsafeStructural('duplicate-decl-names');

  // ── 文件级：声明索引 / 表池校验 / 机校验（O(声明数)，与全量同一份判据）──
  const validationSink = createDiagnosticSink();
  const baseCtx = createExpandContext({ adapter, backend, sourceText: text, sink: validationSink, view });
  indexDeclarations(baseCtx, newDecls);
  validateAllTables(baseCtx);
  validateAllPools(baseCtx);
  for (const diagnostic of baseCtx.featureGate.diagnostics) validationSink.report(diagnostic);
  const validationDiags = validationSink.all.slice();

  const machineSink = createDiagnosticSink();
  validateMachines(machines, adapter, machineSink);
  const machineDiags = machineSink.all.slice();

  const declKinds = collectDeclKindLabels(newDecls);
  const prefixUnits: Unit[] = [];
  for (let i = 0; i < firstHalo; i++) prefixUnits.push(shiftUnit(oldUnits[i]!, shift));
  const haloUnits: Unit[] = [];
  for (const slice of haloParses) haloUnits.push(finishSliceUnit(slice, declKinds, baseCtx, backend, view, text));
  const suffixUnits: Unit[] = [];
  for (let i = lastHalo + 1; i < oldUnits.length; i++) suffixUnits.push(shiftUnit(oldUnits[i]!, shift));
  const units: Unit[] = [...prefixUnits, ...haloUnits, ...suffixUnits];

  // ── 受影响的展开点：声明语义变了就按名字算闭包（池/模体、数组长度常量都是"按名字引用"）──
  const changedNames = new Set<string>();
  const oldSignatures = collectNamedDeclSignatures(current.decls);
  const newSignatures = collectNamedDeclSignatures(newDecls);
  for (const [name, signature] of oldSignatures) if (newSignatures.get(name) !== signature) changedNames.add(name);
  for (const [name, signature] of newSignatures) if (oldSignatures.get(name) !== signature) changedNames.add(name);
  // 重建过的声明单元：行号落在窗口里、映射不可证 ⇒ 它的展开点必须重算（拿新 span 重新 lower）
  for (let i = 0; i < newDecls.length; i++) {
    const unitIndex = declUnitOfDecl[i]!;
    if (unitIndex < firstHalo || unitIndex >= firstHalo + haloCount) continue;
    const name = declNameOf(newDecls[i]!);
    if (name !== null) changedNames.add(name);
  }
  for (const [unitIndex, decls] of oldDeclsByUnit) {
    if (unitIndex < firstHalo || unitIndex > lastHalo) continue;
    for (const decl of decls) {
      const name = declNameOf(decl);
      if (name !== null) changedNames.add(name);
    }
  }

  let grew = changedNames.size > 0;
  while (grew) {
    grew = false;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]!;
      if (unit.headCls !== 'decl' || unit.headIndent !== 0) continue;
      const names: string[] = [];
      let pending = false;
      for (let d = 0; d < newDecls.length; d++) {
        if (declUnitOfDecl[d] !== i) continue;
        const name = declNameOf(newDecls[d]!);
        if (name === null) continue;
        names.push(name);
        if (!changedNames.has(name)) pending = true;
      }
      if (!pending || !mentionsAny(unit.text, changedNames)) continue;
      for (const name of names) {
        if (changedNames.has(name)) continue;
        changedNames.add(name);
        grew = true;
      }
    }
  }

  const dependents: number[] = [];
  // 声明名 / 种类没变 ⇒ 依赖者的 AST 与 parse 诊断原样有效，只需重 lower；变了才重解析
  const declKindsUnchanged = sameDeclKindLabels(collectDeclKindLabels(current.decls), declKinds);
  if (changedNames.size > 0) {
    for (let i = 0; i < units.length; i++) {
      if (i >= firstHalo && i < firstHalo + haloCount) continue;
      const unit = units[i]!;
      if (unit.headCls === 'decl' && unit.headIndent === 0) continue;
      if (mentionsAny(unit.text, changedNames)) dependents.push(i);
    }
    for (const index of dependents) {
      const unit = units[index]!;
      if (declKindsUnchanged) {
        units[index] = relowerUnit(unit, baseCtx, backend, view, text);
        continue;
      }
      const slice = parseSliceInto(unit.text, unit.startLine);
      if (slice.endLine !== unit.endLine) return unsafeStructural('dependent-unit-line-count');
      if (slice.strayDecls) return unsafeStructural('stray-declaration');
      units[index] = finishSliceUnit(slice, declKinds, baseCtx, backend, view, text);
    }
  }

  // 声明是否只是"整块平移"：是就平移 `@织` 产物（含槽名引用），否则重装（体积随 @织 体，冷路径）
  const declKindsChanged = !declKindsUnchanged;
  const oldUnnamed = collectUnnamedDeclSignatures(current.decls);
  const newUnnamed = collectUnnamedDeclSignatures(newDecls);
  const unnamedChanged =
    oldUnnamed.length !== newUnnamed.length || oldUnnamed.some((signature, i) => signature !== newUnnamed[i]);
  const declWindowHit = current.decls.some((decl) => {
    const line = decl.span.start.line - 1;
    return line >= windowStart && line <= windowEnd;
  });
  let weaveLines: readonly string[] = current.weaveLines;
  let weaveKinds: readonly SourceMapLineKind[] = current.weaveKinds;
  let weaveSources: readonly (KojoSpan | null)[] = current.weaveSources;
  let weaveOrigins: readonly (readonly SourceMapOrigin[])[] = current.weaveOrigins;
  let weaveSegments: readonly (readonly SourceMapSegmentSpec[] | undefined)[] = current.weaveSegments;
  let weaveDiags: readonly KojoDiagnostic[] = current.weaveDiags;
  const weaveShiftable =
    changedNames.size === 0 && !unnamedChanged && !declKindsChanged && !declWindowHit && !rebuiltDeclUnit;
  if (!weaveShiftable) {
    const weaveSink = createDiagnosticSink();
    const weaveCtx = forkExpandContext(baseCtx, weaveSink, text);
    const weaveBuffer = createEmitBuffer(32);
    const weaveState = createLowerState({
      backend,
      buffer: weaveBuffer,
      sink: weaveSink,
      view,
      featureGate: weaveCtx.featureGate,
    });
    for (const decl of newDecls) if (decl.kind === 'weave') assembleWeave(decl, weaveCtx, weaveState, walkNarrative);
    const woven = weaveBuffer.finish();
    const weaveMap = extractMap(woven.sourceMap);
    weaveLines = woven.lines;
    weaveKinds = weaveMap.kinds;
    weaveSources = weaveMap.sources;
    weaveOrigins = weaveMap.origins;
    weaveSegments = weaveMap.segments;
    weaveDiags = weaveSink.all.slice();
  } else if (shift.delta !== 0) {
    weaveLines = current.weaveLines.map((line) => shiftSlotRefs(line, shift));
    weaveSources = shiftSpans(current.weaveSources, shift);
    weaveOrigins = shiftSpans(current.weaveOrigins, shift);
    weaveSegments = shiftSpans(current.weaveSegments, shift);
    weaveDiags = shiftSpans(current.weaveDiags, shift);
  }

  // ── 行号 → 单元反查表（O(行数)）+ 覆盖自检 ──
  const unitOfLine = new Array<number>(newLineCount).fill(-1);
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    for (let line = unit.startLine; line < unit.endLine; line++) unitOfLine[line] = i;
  }
  for (let line = 0; line < newLineCount; line++) {
    if (unitOfLine[line] === -1) return unsafeStructural('unit-coverage-hole');
  }

  let totalNodes = 0;
  for (const unit of units) totalNodes += unit.nodes.length;

  const next: CacheState = {
    text,
    lineStarts: newStarts,
    units,
    unitOfLine,
    decls: newDecls,
    machines,
    view,
    validationDiags,
    machineDiags,
    weaveDiags,
    weaveLines,
    weaveKinds,
    weaveSources,
    weaveOrigins,
    weaveSegments,
    baseCtx,
    totalNodes,
    declUnitOfDecl,
  };

  let rebuiltNodes = 0;
  let relexedLines = 0;
  let reparsedUnits = 0;
  let reloweredUnits = 0;
  const accountHalo = (unit: Unit): void => {
    rebuiltNodes += unit.nodes.length;
    relexedLines += unit.endLine - unit.startLine;
    reparsedUnits += 1;
    if (unit.headCls !== 'decl' && unit.nodes.length > 0) reloweredUnits += 1;
  };
  for (const unit of haloUnits) accountHalo(unit);
  for (const index of dependents) {
    const unit = units[index]!;
    if (!declKindsUnchanged) {
      rebuiltNodes += unit.nodes.length;
      relexedLines += unit.endLine - unit.startLine;
      reparsedUnits += 1;
    }
    if (unit.headCls !== 'decl' && unit.nodes.length > 0) reloweredUnits += 1;
  }

  return {
    kind: 'ok',
    state: next,
    result: compose(next, adapter, backend),
    stats: {
      reusedNodes: totalNodes - rebuiltNodes,
      rebuiltNodes,
      relexedLines,
      reparsedUnits,
      reloweredUnits,
      fallbackFull: false,
      fallbackReason: null,
      ms: 0, // 由入口回填（统一在 update 的计时窗口里）
    },
  };
}

/* ============================== 拼接（compose） ============================== */

function compose(state: CacheState, adapter: GameAdapter, backend: KojoEmitBackend): CompileKojoSourceResult {
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
  // 语义层并表（K2-SEMA-WIRING 的 wiring 请求；与 `runCompile` 同口径）：sema 先算，主链胜出
  // （同 `(code, span)` = 同一事实 ⇒ 丢弃 sema 那条），sema 独有的追加在后——增量结果必须与
  // `compileKojoFile` 逐字相等，否则构建期自检会判 degraded、把增量提速永久关掉。
  {
    const sema = checkKojoFile(file, { adapter, reporting: 'with-lowering' });
    const seen = new Set(diags.map(featureDiagnosticKey));
    for (const diagnostic of sema.diagnostics) {
      const key = featureDiagnosticKey(diagnostic);
      if (seen.has(key)) continue;
      seen.add(key);
      diags.push(diagnostic);
    }
  }
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
      appendMappedLine(
        builder,
        generated++,
        unit.mapKinds[i]!,
        unit.mapSources[i]!,
        unit.mapOrigins[i]!,
        unit.mapSegments[i],
      );
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
      appendMappedLine(builder, generated++, state.weaveKinds[i]!, source, origins, state.weaveSegments[i]);
    }
  }

  const erb = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return { ok: true, erb, sourceMap: builder.build(), diagnostics: diags, slots, file };
}

/**
 * 追加一行产物 + 它的列级分段（行号可重编）。
 *
 * 为什么必须逐字搬分段：模板 / 池展开的"调用处锚点"只登记在列级分段里；只搬行级字段会让
 * 拼接结果与全量 compile 的 `source map 每行` 不等价（自检会直接判退）。
 */
function appendMappedLine(
  builder: SourceMapBuilder,
  generatedLine: number,
  kind: SourceMapLineKind,
  source: KojoSpan | null,
  origins: readonly SourceMapOrigin[],
  segments: readonly SourceMapSegmentSpec[] | undefined,
): void {
  builder.appendLine({
    generatedLine,
    kind,
    source,
    ...(origins.length === 0 ? {} : { origins }),
  });
  if (segments === undefined) return;
  for (const spec of segments) {
    builder.appendSegment({
      generatedLine,
      generatedColumn: spec.startColumn,
      source: spec.source,
      ...(spec.endColumn === undefined ? {} : { endColumn: spec.endColumn }),
      ...(spec.kind === undefined ? {} : { kind: spec.kind }),
      ...(spec.origins === undefined ? {} : { origins: spec.origins }),
    });
  }
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

/**
 * 一个单元切片的三层解析结果（**不含** lower：IR 依赖声明索引，要先拼好声明表才 lower）。
 *
 * `sliceCallBodyDiags` 是切片自己 parse 出来的收尾诊断（`core/template/unexpected-slot`）：
 * 切片内的 `declKinds` 只含切片自己的声明，所以叙事单元切片里恒为空；声明单元切片里是
 * "调用同一切片内池/函"的那部分。调用方按自己的口径决定保留还是用文件级 declKinds 复算。
 */
interface SliceParse {
  readonly unitText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly headCls: LineClass;
  readonly headIndent: number;
  readonly meta: LineMeta[];
  readonly scene: SceneHeaderUnit | null;
  readonly nodes: readonly KojoNarrativeNode[];
  readonly decls: readonly KojoDecl[];
  readonly lexDiags: readonly KojoDiagnostic[];
  readonly sourceDiags: readonly KojoDiagnostic[];
  readonly sliceCallBodyDiags: readonly KojoDiagnostic[];
  /** 非声明单元里 parse 出了声明（形状超出本模型）⇒ 结构化增量必须回退全量 */
  readonly strayDecls: boolean;
}

/** 切片 parse（局部坐标 → 全文件坐标；列不变，只平移行号） */
function parseSliceInto(unitText: string, startLine: number): SliceParse {
  const lexed = lex(unitText);
  const parsed = parse(lexed);
  const meta: LineMeta[] = [];
  for (const record of lexed.lines) meta.push({ cls: classOf(record), indent: record.indent });
  const head = meta[0] ?? { cls: 'leaf' as LineClass, indent: 0 };
  const isDecl = head.cls === 'decl' && head.indent === 0;

  const nodes: KojoNarrativeNode[] = [];
  const decls: KojoDecl[] = [];
  let scene: SceneHeaderUnit | null = null;
  if (isDecl) {
    for (const decl of parsed.decls) decls.push(rebaseLines(decl, startLine));
    for (const header of parsed.scenes) {
      if (header.title === null) continue;
      const record = lexed.lines[header.span.start.line - 1];
      if (record === undefined) continue;
      scene = { title: header.title, headerSpan: rebaseSpan(spanOfLine(record, lexed.positions), startLine) };
      break;
    }
  } else {
    for (const header of parsed.scenes) {
      for (const node of header.items) nodes.push(rebaseLines(node, startLine));
    }
  }

  const lexDiags: KojoDiagnostic[] = [];
  for (const diagnostic of lexed.diagnostics) lexDiags.push(rebaseLines(diagnostic, startLine));
  const sourceDiags: KojoDiagnostic[] = [];
  const sliceCallBodyDiags: KojoDiagnostic[] = [];
  for (let i = lexed.diagnostics.length; i < parsed.diagnostics.length; i++) {
    const diagnostic = parsed.diagnostics[i]!;
    if (diagnostic.code === MISSING_MACHINE) continue;
    const shifted = rebaseLines(diagnostic, startLine);
    if (CALL_BODY_CODES.has(diagnostic.code)) sliceCallBodyDiags.push(shifted);
    else sourceDiags.push(shifted);
  }
  return {
    unitText,
    startLine,
    endLine: startLine + lexed.lines.length,
    headCls: head.cls,
    headIndent: head.indent,
    meta,
    scene,
    nodes,
    decls,
    lexDiags,
    sourceDiags,
    sliceCallBodyDiags,
    strayDecls: !isDecl && decls.length > 0,
  };
}

function parseUnitSlice(unitText: string, startLine: number, declKinds: ReadonlyMap<string, string>): UnitParse {
  const slice = parseSliceInto(unitText, startLine);
  const postDiags: KojoDiagnostic[] = [];
  for (const diagnostic of slice.sliceCallBodyDiags) postDiags.push(diagnostic);
  collectCallBodyDiags(slice.nodes, declKinds, postDiags);
  return { nodes: [...slice.nodes], lexDiags: [...slice.lexDiags], sourceDiags: [...slice.sourceDiags], postDiags };
}

/** 切片 → 完整单元（收尾诊断按**文件级** declKinds 复算；声明单元额外走声明体） */
function finishSliceUnit(
  slice: SliceParse,
  declKinds: ReadonlyMap<string, string>,
  baseCtx: ExpandContext,
  backend: KojoEmitBackend,
  view: string | null,
  sourceText: string,
): Unit {
  const isDecl = slice.headCls === 'decl' && slice.headIndent === 0;
  const postDiags: KojoDiagnostic[] = [];
  if (isDecl) {
    // 声明单元的收尾诊断来自「声明体里的池/函调用」：切片自带的那些只认识切片内声明，丢掉重算。
    collectDeclCallBodyDiags(slice.decls, declKinds, postDiags);
    collectCallBodyDiags(slice.nodes, declKinds, postDiags);
  } else {
    for (const diagnostic of slice.sliceCallBodyDiags) postDiags.push(diagnostic);
    collectCallBodyDiags(slice.nodes, declKinds, postDiags);
  }
  const lowered: Lowered =
    isDecl || slice.nodes.length === 0 ? emptyLowered() : lowerUnit(slice.nodes, baseCtx, backend, view, sourceText);
  return {
    startLine: slice.startLine,
    endLine: slice.endLine,
    text: slice.unitText,
    headCls: slice.headCls,
    headIndent: slice.headIndent,
    meta: slice.meta,
    scene: slice.scene,
    nodes: slice.nodes,
    lexDiags: slice.lexDiags,
    sourceDiags: slice.sourceDiags,
    postDiags,
    lines: lowered.lines,
    mapKinds: lowered.mapKinds,
    mapSources: lowered.mapSources,
    mapOrigins: lowered.mapOrigins,
    mapSegments: lowered.mapSegments,
    slots: lowered.slots,
    walkDiags: lowered.walkDiags,
  };
}

/** 只重算 IR（AST / 诊断原样复用）：声明语义变了但**声明名与种类没变**时，依赖者只需重 lower */
function relowerUnit(
  unit: Unit,
  baseCtx: ExpandContext,
  backend: KojoEmitBackend,
  view: string | null,
  sourceText: string,
): Unit {
  const lowered: Lowered =
    unit.nodes.length === 0 ? emptyLowered() : lowerUnit(unit.nodes, baseCtx, backend, view, sourceText);
  return {
    ...unit,
    lines: lowered.lines,
    mapKinds: lowered.mapKinds,
    mapSources: lowered.mapSources,
    mapOrigins: lowered.mapOrigins,
    mapSegments: lowered.mapSegments,
    slots: lowered.slots,
    walkDiags: lowered.walkDiags,
  };
}

interface Lowered {
  readonly lines: readonly string[];
  readonly mapKinds: readonly SourceMapLineKind[];
  readonly mapSources: readonly (KojoSpan | null)[];
  readonly mapOrigins: readonly (readonly SourceMapOrigin[])[];
  readonly mapSegments: readonly (readonly SourceMapSegmentSpec[] | undefined)[];
  readonly slots: readonly KojoHiddenSlot[];
  readonly walkDiags: readonly KojoDiagnostic[];
}

function emptyLowered(): Lowered {
  return { lines: [], mapKinds: [], mapSources: [], mapOrigins: [], mapSegments: [], slots: [], walkDiags: [] };
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
  const state = createLowerState({ backend, buffer, sink, view, featureGate: ctx.featureGate });
  walkNarrative(nodes, ctx, state);
  const finished = buffer.finish();
  const map = extractMap(finished.sourceMap);
  return {
    lines: finished.lines,
    mapKinds: map.kinds,
    mapSources: map.sources,
    mapOrigins: map.origins,
    mapSegments: map.segments,
    slots: hiddenSlots(ctx),
    walkDiags: sink.all.slice(),
  };
}

interface ExtractedMap {
  readonly kinds: readonly SourceMapLineKind[];
  readonly sources: readonly (KojoSpan | null)[];
  readonly origins: readonly (readonly SourceMapOrigin[])[];
  readonly segments: readonly (readonly SourceMapSegmentSpec[] | undefined)[];
}

function extractMap(map: SourceMap): ExtractedMap {
  const kinds: SourceMapLineKind[] = [];
  const sources: (KojoSpan | null)[] = [];
  const origins: (readonly SourceMapOrigin[])[] = [];
  // 列级分段必须一起搬（模板/池展开的调用处锚点在分段里）：缺了它拼接结果与全量不等价。
  const segments: (readonly SourceMapSegmentSpec[] | undefined)[] = [];
  for (let line = 1; line <= map.lineCount; line++) {
    const mapped = map.lineAt(line);
    if (mapped === null) {
      kinds.push('generated');
      sources.push(null);
      origins.push([]);
      segments.push(undefined);
    } else {
      kinds.push(mapped.kind);
      sources.push(mapped.source);
      origins.push(mapped.origins);
      segments.push(segmentSpecsOf(mapped));
    }
  }
  return { kinds, sources, origins, segments };
}

function forkExpandContext(base: ExpandContext, sink: DiagnosticSink, sourceText: string): ExpandContext {
  return {
    adapter: base.adapter,
    backend: base.backend,
    featureGate: base.featureGate,
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
  walkCallBodyNarrative(nodes, declKinds, out);
}

/**
 * 声明体里的同一判据（`validateCallBodies` 的全量口径：先声明、后场景）。
 *
 * 为什么需要：增量只重建声明单元时，该单元的 AST 是**切片 parse** 出来的，切片自带的
 * `declKinds` 只认识切片内的声明；调用别处的池/函时判据会漏。这里用文件级 declKinds 复算，
 * 于是结果与全量 parse 的"声明体收尾诊断"逐字一致。
 */
function collectDeclCallBodyDiags(
  decls: readonly KojoDecl[],
  declKinds: ReadonlyMap<string, string>,
  out: KojoDiagnostic[],
): void {
  for (const decl of decls) {
    switch (decl.kind) {
      case 'function':
        walkCallBodyDispatch(decl.body, declKinds, out);
        break;
      case 'weave':
      case 'template':
        walkCallBodyNarrative(decl.body, declKinds, out);
        break;
      case 'pool':
        for (const branch of decl.branches) walkCallBodyNarrative(branch.body, declKinds, out);
        break;
      default:
        break;
    }
  }
}

function checkCallBody(call: KojoCallStmt, declKinds: ReadonlyMap<string, string>, out: KojoDiagnostic[]): void {
  if (call.body === undefined) return;
  const kind = declKinds.get(call.name);
  if (kind !== '池' && kind !== '函数') return;
  out.push({
    code: 'core/template/unexpected-slot',
    severity: severityOf('core/template/unexpected-slot'),
    message: `\`! ${call.name}\` 是${kind === '池' ? '池' : '函数'}调用，不带缩进块：缩进块只用来给 \`# 模\` 的 \`[插槽]\` 填内容（§7.2）。`,
    span: call.span,
  });
}

function walkCallBodyNarrative(
  nodes: readonly KojoNarrativeNode[],
  declKinds: ReadonlyMap<string, string>,
  out: KojoDiagnostic[],
): void {
  for (const node of nodes) walkCallBodyNarrativeNode(node, declKinds, out);
}

function walkCallBodyDispatch(
  nodes: readonly KojoDispatchNode[],
  declKinds: ReadonlyMap<string, string>,
  out: KojoDiagnostic[],
): void {
  for (const node of nodes) walkCallBodyDispatchNode(node, declKinds, out);
}

function walkCallBodyDispatchNode(
  node: KojoDispatchNode,
  declKinds: ReadonlyMap<string, string>,
  out: KojoDiagnostic[],
): void {
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
      checkCallBody(node, declKinds, out);
      if (node.body !== undefined) walkCallBodyNarrative(node.body, declKinds, out);
      return;
    case 'dispatchCondition':
      for (const branch of node.branches) walkCallBodyDispatch(branch.body, declKinds, out);
      return;
    case 'sandboxBlock':
    case 'whileLoop':
    case 'repeatLoop':
      walkCallBodyDispatch(node.body, declKinds, out);
      return;
    case 'forEachLoop':
      walkCallBodyNarrative(node.body, declKinds, out);
      return;
    default:
      return;
  }
}

function walkCallBodyNarrativeNode(
  node: KojoNarrativeNode,
  declKinds: ReadonlyMap<string, string>,
  out: KojoDiagnostic[],
): void {
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
      checkCallBody(node, declKinds, out);
      if (node.body !== undefined) walkCallBodyNarrative(node.body, declKinds, out);
      return;
    case 'conditionChain':
      for (const branch of node.branches) walkCallBodyNarrative(branch.body, declKinds, out);
      return;
    case 'colorBlock':
      walkCallBodyNarrative(node.body, declKinds, out);
      return;
    case 'optionsBlock':
      for (const item of node.items) walkCallBodyNarrative(item.body, declKinds, out);
      return;
    case 'randomBlock':
      for (const candidate of node.candidates) {
        if (candidate.kind === 'randomGroup') walkCallBodyNarrative(candidate.body, declKinds, out);
      }
      return;
    case 'sandboxBlock':
      walkCallBodyDispatch(node.body, declKinds, out);
      return;
    case 'whileLoop':
    case 'repeatLoop':
      walkCallBodyDispatch(node.body, declKinds, out);
      return;
    case 'forEachLoop':
      walkCallBodyNarrative(node.body, declKinds, out);
      return;
    default:
      return;
  }
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
 * 只改 span（AST / 诊断 / source map 锚点的落点都在这里；表达式同理）。
 */
function rebaseLines<T>(value: T, lineDelta: number): T {
  if (lineDelta === 0) return value;
  return shiftSpans(value, { at: Number.NEGATIVE_INFINITY, delta: lineDelta });
}

function rebaseSpan(span: KojoSpan, lineDelta: number): KojoSpan {
  if (lineDelta === 0) return span;
  return shiftSpan(span, { at: Number.NEGATIVE_INFINITY, delta: lineDelta });
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
