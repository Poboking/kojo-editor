/**
 * Conformance kit 入口：给一个 adapter + backend + 一组验收用例，产出**结构化报告**。
 *
 * 定位（设计稿 §10.9 / §16.2）：
 * - 这是 adapter 作者可复用的纯函数套件，不 import 宿主 / Monaco / kernel，也不认识任何具体游戏；
 * - 五类读数：契约自检（`validateGameAdapter` + backend 读数一致性）、golden（逐字节）、
 *   differential（旧产物 vs 2.0 产物的行为序列）、encoding/EOL 保留、事件/取色/等待读数；
 * - **失败不静默**：每条失败都带稳定 code + 定位（用例名 / 字段 / 源行列 / 产物行），
 *   golden 与 differential 另附逐行 diff。
 *
 * 观测方式：把调用方给的 `KojoEmitBackend` 包一层**录音器**（不改产物），从发射请求读取
 * 事件 / 等待 / 取色；因此读数与 backend 的 token 拼写无关，也不需要 kit 认识任何游戏指令。
 */
import type {
  AdapterProfile,
  CompileKojoSourceResult,
  ConformanceCase,
  DiagnosticCode,
  EventSpec,
  GameAdapter,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoLoweringProfile,
  KojoPresentationCapabilities,
  KojoProgramFeatures,
  ProgramFeatureKey,
  ProgramFeatures,
  TextEncoding,
} from '@kojo/kojo-core';
import {
  compileKojoSource,
  findEvent,
  PROGRAM_FEATURE_KEYS,
  validateGameAdapter,
} from '@kojo/kojo-core';

import type { ArtifactLineDiff, ArtifactNormalizationOptions, DifferentialResult, LineDiffSummary } from './differential.js';
import { compareArtifacts, diffArtifactLines, summarizeLineDiff } from './differential.js';
import type { ConformanceEol, DecodedConformanceText } from './encoding.js';
import {
  decodeConformanceText,
  encodeConformanceText,
  encodeConformanceTextPreservingEol,
  eolPolicyAccepts,
  hasTrailingEol,
  normalizeEolToLf,
} from './encoding.js';

/* ============================== 1. 报告形状 ============================== */

/** 验收面；`smoke` 需要真实壳，kit 只登记 skip（不伪造 pass） */
export type ConformanceCheck = 'contract' | 'golden' | 'differential' | 'encoding' | 'readings' | 'smoke';

/** 失败项 code：契约自检复用 core/adapter 码，其余是本 kit 的 `conformance/*` */
export type ConformanceFailureCode =
  | DiagnosticCode
  | 'conformance/contract'
  | 'conformance/backend'
  | 'conformance/golden'
  | 'conformance/differential'
  | 'conformance/encoding'
  | 'conformance/readings'
  | 'conformance/diagnostics'
  | 'conformance/input';

type FailureCheck = Exclude<ConformanceCheck, 'smoke'>;

/** 失败定位：用例 + 字段 + 源 1 基行列 + 产物 1 基行；没有的维度显式 null */
export interface ConformanceLocation {
  readonly case: string;
  readonly field: string;
  readonly sourceLine: number | null;
  readonly sourceColumn: number | null;
  readonly artifactLine: number | null;
}

/** 一条失败：code + 定位是硬要求；diff/diagnostics 是附加证据 */
export interface ConformanceFailure {
  readonly code: ConformanceFailureCode;
  readonly check: FailureCheck;
  readonly case: string;
  readonly message: string;
  readonly location: ConformanceLocation;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly diff: readonly ArtifactLineDiff[];
  readonly diagnostics: readonly KojoDiagnostic[];
}

/** 事件读数（来自 `wrapMachine` / `weaveHeader` 请求；与产物 token 无关） */
export type EventReadingSource = 'machine' | 'weave';

export interface EventReading {
  readonly source: EventReadingSource;
  readonly event: string;
  readonly args: readonly string[];
  readonly guard: string | null;
  readonly line: number;
}

export type WaitReadingKind = 'text' | 'blank';

export interface WaitReading {
  readonly kind: WaitReadingKind;
  readonly wait: 'wait' | 'continue';
  readonly line: number;
}

export type ColorReadingSource = 'block-enter' | 'block-exit' | 'text';

export interface ColorReading {
  readonly source: ColorReadingSource;
  readonly value: string | null;
  readonly line: number | null;
}

/** backend profile 读数（contract 自检把它与 adapter 契约逐字段对拍） */
export interface PresentationReading {
  readonly heart: boolean;
  readonly color: boolean;
  readonly face: boolean;
  readonly options: boolean;
}

export interface ProfileReading {
  readonly waitDefault: 'wait' | 'continue' | null;
  readonly narrationColor: 'author' | 'default' | 'auto' | null;
  readonly dialogueColor: 'author' | 'default' | null;
  readonly colorMode: 'D' | 'plain' | null;
  readonly poolStyle: 'if' | 'selectcase' | null;
  readonly randStyle: 'printdata' | 'printdatal' | 'rand-selectcase' | null;
  readonly priorityModel: 'emuera-buckets' | 'none' | null;
  readonly presentations: PresentationReading;
  readonly programFeatures: Readonly<Record<ProgramFeatureKey, boolean>>;
}

/** adapter 事件目录读数（事件名 / 守卫 / 参数形状；守卫只读，不解释） */
export interface EventCatalogReading {
  readonly event: string;
  readonly engine: string;
  readonly args: readonly string[];
  readonly dispatch: string;
  readonly priority: string;
  readonly guard: string | null;
  readonly forced: boolean;
  readonly weavable: boolean;
}

export interface ContractCheckReport {
  readonly ok: boolean;
  readonly adapterId: string;
  readonly backendId: string;
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly profile: ProfileReading;
  readonly events: readonly EventCatalogReading[];
  readonly failures: readonly ConformanceFailure[];
}

/** 单用例的实测读数（即使通过也保留，便于 adapter 作者看"套件到底测了什么"） */
export interface CaseReadings {
  readonly events: readonly EventReading[];
  readonly waits: readonly WaitReading[];
  readonly colors: readonly ColorReading[];
  readonly slots: readonly string[];
  readonly sourceMapLines: number;
  readonly artifactLines: number;
  readonly diagnostics: readonly KojoDiagnostic[];
}

export interface DifferentialReading {
  readonly equal: boolean;
  readonly summary: LineDiffSummary;
  readonly diff: readonly ArtifactLineDiff[];
  readonly baselineLines: number;
  readonly candidateLines: number;
  readonly firstDifferenceLine: number | null;
}

export interface EncodingSideReading {
  readonly encoding: TextEncoding;
  readonly eol: ConformanceEol;
  readonly bom: boolean;
  readonly bytes: number;
}

export interface EncodingReading {
  readonly source: EncodingSideReading;
  readonly output: EncodingSideReading;
  readonly roundTrip: boolean;
  readonly eolInvariant: boolean;
  readonly bomInvariant: boolean;
  readonly preservedBom: boolean;
  readonly preservedEol: boolean;
}

export interface CaseObservations {
  /** 产物字节数；编译抛错/输入解码失败时为 null */
  readonly erbBytes: number | null;
  readonly readings: CaseReadings | null;
  readonly differential: DifferentialReading | null;
  readonly encoding: EncodingReading | null;
}

export interface ConformanceCaseReport {
  readonly name: string;
  readonly kind: AdapterConformanceCase['kind'];
  readonly ok: boolean;
  readonly observations: CaseObservations;
  readonly failures: readonly ConformanceFailure[];
}

export interface ConformanceSkip {
  readonly check: ConformanceCheck;
  readonly reason: string;
}

export interface ConformanceCheckSummary {
  readonly check: ConformanceCheck;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ConformanceSummary {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly failures: number;
  readonly byCheck: readonly ConformanceCheckSummary[];
}

export interface AdapterConformanceReport {
  readonly adapterId: string;
  readonly backendId: string;
  readonly ok: boolean;
  readonly contract: ContractCheckReport;
  readonly cases: readonly ConformanceCaseReport[];
  readonly failures: readonly ConformanceFailure[];
  readonly skips: readonly ConformanceSkip[];
  readonly summary: ConformanceSummary;
}

/* ============================== 2. 用例形状 ============================== */

export interface ExpectedDiagnostic {
  readonly code: string;
  readonly severity?: 'error' | 'warning';
  /** 只比较给了的维度：1 基源行 */
  readonly line?: number;
  /** 1 基源列（UTF-16 码元） */
  readonly column?: number;
}

export interface ExpectedEventReading {
  readonly source?: EventReadingSource;
  readonly event: string;
  readonly args?: readonly string[];
  readonly guard?: string | null;
}

export interface ExpectedWaitReading {
  readonly kind?: WaitReadingKind;
  readonly wait: 'wait' | 'continue';
}

export interface ExpectedColorReading {
  readonly source?: ColorReadingSource;
  readonly value?: string | null;
}

/** 用例里声明的读数期望：只比较出现的字段；数组按顺序逐项比较 */
export interface ReadingsExpectation {
  readonly events?: readonly ExpectedEventReading[];
  readonly waits?: readonly ExpectedWaitReading[];
  readonly colors?: readonly ExpectedColorReading[];
  readonly slots?: readonly string[];
  readonly sourceMapLines?: number;
  readonly artifactLines?: number;
}

export interface EncodingExpectation {
  /** 源字节的实际编码（kit 会先探测再对拍） */
  readonly sourceEncoding: TextEncoding;
  readonly sourceEol: ConformanceEol;
  /** 产物编码；缺省 = 源编码（保留） */
  readonly outputEncoding?: TextEncoding;
  /** 产物 EOL；缺省 = 源 EOL 为 crlf/lf 时保留，否则按 adapter 策略/`lf` */
  readonly outputEol?: 'lf' | 'crlf';
  /** 是否要求 BOM 与源一致（默认 true） */
  readonly preserveBom?: boolean;
  /** 是否要求产物 EOL 与源一致（默认 true；显式换 EOL 时置 false） */
  readonly preserveEol?: boolean;
}

interface CaseBase {
  readonly name: string;
  readonly view?: string | null;
  readonly expectedDiagnostics?: readonly ExpectedDiagnostic[];
  readonly readings?: ReadingsExpectation;
}

export interface GoldenCase extends CaseBase {
  readonly kind: 'golden';
  readonly source: string;
  /** 期望产物（逐字节比较，含末尾换行） */
  readonly expectedErb: string;
}

export interface DifferentialCase extends CaseBase {
  readonly kind: 'differential';
  readonly source: string;
  /** 旧产物（原 ERB）；BOM/EOL/整行注释由 kit 归一化 */
  readonly baseline: string;
  readonly normalization?: ArtifactNormalizationOptions;
}

export interface ReadingsCase extends CaseBase {
  readonly kind: 'readings';
  readonly source: string;
  readonly readings: ReadingsExpectation;
}

export interface EncodingCase {
  readonly kind: 'encoding';
  readonly name: string;
  /** 源文件真实字节（含 BOM / EOL） */
  readonly bytes: Uint8Array;
  readonly encoding: EncodingExpectation;
  readonly view?: string | null;
  readonly expectedDiagnostics?: readonly ExpectedDiagnostic[];
  readonly readings?: ReadingsExpectation;
}

export type AdapterConformanceCase = GoldenCase | DifferentialCase | ReadingsCase | EncodingCase;

export interface AdapterConformanceInput {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly cases: readonly AdapterConformanceCase[];
}

/* ============================== 3. 内部工具 ============================== */

const EMPTY_DIFF: readonly ArtifactLineDiff[] = Object.freeze([]);
const EMPTY_DIAGNOSTICS: readonly KojoDiagnostic[] = Object.freeze([]);
const CONTRACT_CASE = '(contract)';

interface FailureInput {
  readonly code: ConformanceFailureCode;
  readonly check: FailureCheck;
  readonly caseName: string;
  readonly field: string;
  readonly message: string;
  readonly sourceLine?: number | null;
  readonly sourceColumn?: number | null;
  readonly artifactLine?: number | null;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly diff?: readonly ArtifactLineDiff[];
  readonly diagnostics?: readonly KojoDiagnostic[];
}

function makeFailure(input: FailureInput): ConformanceFailure {
  return {
    code: input.code,
    check: input.check,
    case: input.caseName,
    message: input.message,
    location: {
      case: input.caseName,
      field: input.field,
      sourceLine: input.sourceLine ?? null,
      sourceColumn: input.sourceColumn ?? null,
      artifactLine: input.artifactLine ?? null,
    },
    expected: input.expected ?? null,
    actual: input.actual ?? null,
    diff: input.diff ?? EMPTY_DIFF,
    diagnostics: input.diagnostics ?? EMPTY_DIAGNOSTICS,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? '(missing)' : JSON.stringify(value);
}

function describeDiagnostic(diagnostic: KojoDiagnostic): string {
  const line = diagnostic.span?.start.line;
  const column = diagnostic.span?.start.column;
  const at = line === undefined ? '' : ` @${line}:${column ?? '?'}`;
  return `${diagnostic.code}${at}`;
}

function diagnosticLine(diagnostic: KojoDiagnostic): number | null {
  return diagnostic.span?.start.line ?? null;
}

function artifactLineCount(erb: string): number {
  if (erb.length === 0) return 0;
  if (erb.endsWith('\n')) return erb.split('\n').length - 1;
  return erb.split('\n').length;
}

function artifactSourceLine(result: CompileKojoSourceResult, artifactLine: number | null): number | null {
  if (artifactLine === null || artifactLine < 1) return null;
  return result.sourceMap.lineAt(artifactLine)?.source?.start.line ?? null;
}

function jsonLines(lines: readonly string[]): string {
  return lines.length === 0 ? '[]' : JSON.stringify(lines);
}

/** 失败定位优先用 candidate 行；首个差异是 removed 时回退到同一处的新增行 */
function firstCandidateArtifactLine(
  diff: readonly ArtifactLineDiff[],
  first: ArtifactLineDiff | null,
): number | null {
  if (first?.artifactLine !== null && first?.artifactLine !== undefined) return first.artifactLine;
  return diff.find((item) => item.kind !== 'same' && item.artifactLine !== null)?.artifactLine ?? null;
}

/** golden diff 用：按"产物行"切分（末尾换行不再多算一个空行） */
function splitArtifactLines(text: string): readonly string[] {
  if (text.length === 0) return Object.freeze([]);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/* ============================== 4. 契约 + 读数 ============================== */

function readPresentations(
  presentations: Partial<KojoPresentationCapabilities> | undefined,
): PresentationReading {
  return {
    heart: presentations?.heart === true,
    color: presentations?.color === true,
    face: presentations?.face === true,
    options: presentations?.options === true,
  };
}

function readProgramFeatures(
  features: Partial<KojoProgramFeatures> | undefined,
): Readonly<Record<ProgramFeatureKey, boolean>> {
  return {
    arrays: features?.arrays === true,
    while: features?.while === true,
    goto: features?.goto === true,
    recursion: features?.recursion === true,
    foreach: features?.foreach === true,
    repeat: features?.repeat === true,
  };
}

function readProfile(profile: Partial<KojoLoweringProfile> | undefined): ProfileReading {
  return {
    waitDefault: profile?.waitDefault ?? null,
    narrationColor: profile?.narrationColor ?? null,
    dialogueColor: profile?.dialogueColor ?? null,
    colorMode: profile?.colorMode ?? null,
    poolStyle: profile?.poolStyle ?? null,
    randStyle: profile?.randStyle ?? null,
    priorityModel: profile?.priorityModel ?? null,
    presentations: readPresentations(profile?.presentations),
    programFeatures: readProgramFeatures(profile?.programFeatures),
  };
}

function readEventCatalog(adapter: GameAdapter): readonly EventCatalogReading[] {
  const events = adapter.eventCatalog?.events;
  if (!Array.isArray(events)) return Object.freeze([]);
  const specs = events as readonly (EventSpec | null | undefined)[];
  return Object.freeze(
    specs.map((spec) => {
      const args = Array.isArray(spec?.args) ? spec.args : [];
      return {
        event: typeof spec?.event === 'string' ? spec.event : '',
        engine: typeof spec?.engine === 'string' ? spec.engine : '',
        args: Object.freeze(args.map((arg) => (typeof arg?.name === 'string' ? arg.name : ''))),
        dispatch: typeof spec?.dispatch === 'string' ? spec.dispatch : '',
        priority: typeof spec?.priority === 'string' ? spec.priority : '',
        guard: typeof spec?.guard?.text === 'string' ? spec.guard.text : null,
        forced: spec?.forced === true,
        weavable: spec?.weavable === true,
      };
    }),
  );
}

function expectedPriorityModel(adapter: GameAdapter): 'emuera-buckets' | 'none' {
  const events = adapter.eventCatalog?.events;
  if (!Array.isArray(events)) return 'none';
  const specs = events as readonly (EventSpec | null | undefined)[];
  return specs.some((event) => event?.priority === 'emuera-buckets') ? 'emuera-buckets' : 'none';
}

interface ContractFailureInput {
  readonly code: ConformanceFailureCode;
  readonly field: string;
  readonly message: string;
  readonly sourceLine?: number | null;
  readonly sourceColumn?: number | null;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly diagnostics?: readonly KojoDiagnostic[];
}

function checkContract(adapter: GameAdapter, backend: KojoEmitBackend): ContractCheckReport {
  const failures: ConformanceFailure[] = [];
  const add = (input: ContractFailureInput): void => {
    failures.push(makeFailure({ ...input, check: 'contract', caseName: CONTRACT_CASE }));
  };

  /* --- 契约自检：core 的 validateGameAdapter 是唯一真源 --- */
  let diagnostics: readonly KojoDiagnostic[] = EMPTY_DIAGNOSTICS;
  try {
    diagnostics = validateGameAdapter(adapter);
  } catch (error: unknown) {
    add({
      code: 'conformance/contract',
      field: 'adapter',
      message: `validateGameAdapter 抛错：${errorMessage(error)}`,
    });
  }
  for (const diagnostic of diagnostics) {
    add({
      code: diagnostic.code,
      field: 'adapter',
      message: diagnostic.message,
      sourceLine: diagnosticLine(diagnostic),
      sourceColumn: diagnostic.span?.start.column ?? null,
      diagnostics,
    });
  }

  /* --- 事件目录：守卫必须非空（core validate 不查这一格） --- */
  const events = adapter.eventCatalog?.events;
  if (Array.isArray(events)) {
    const specs = events as readonly (EventSpec | null | undefined)[];
    for (const spec of specs) {
      const guard = spec?.guard;
      if (guard !== null && guard !== undefined && typeof guard.text === 'string' && guard.text.trim().length === 0) {
        add({
          code: 'conformance/contract',
          field: `eventCatalog.events.${spec?.event ?? '(?)'}.guard`,
          message: `事件“${spec?.event ?? '(?)'}”声明了守卫但 guard.text 为空：core 不解释守卫，但空守卫无法落产物。`,
        });
      }
    }
    const seen = new Set<string>();
    const suite = adapter.conformanceSuite;
    if (suite !== undefined && Array.isArray(suite.cases)) {
      const cases = suite.cases as readonly (ConformanceCase | null | undefined)[];
      for (const item of cases) {
        const name = typeof item?.name === 'string' ? item.name : '';
        if (seen.has(name)) {
          add({
            code: 'conformance/contract',
            field: 'adapter.conformanceSuite.cases',
            message: `conformanceSuite 用例名重复：“${name}”。`,
          });
        } else {
          seen.add(name);
        }
      }
    }
  }

  /* --- backend 与 adapter 的读数必须同源 --- */
  if (backend.id !== adapter.id) {
    add({
      code: 'conformance/backend',
      field: 'backend.id',
      message: 'backend.id 必须等于 adapter.id：产物装配与 diagnostic 归属按同一 id 记账。',
      expected: describe(adapter.id),
      actual: describe(backend.id),
    });
  }

  const adapterProfile: Partial<AdapterProfile> | undefined = adapter.profile;
  const backendProfile: Partial<KojoLoweringProfile> | undefined = backend.profile;
  if (backendProfile === undefined) {
    add({
      code: 'conformance/backend',
      field: 'backend.profile',
      message: 'backend 缺少 profile：等待/取色/池与随机落点没有读数。',
    });
  } else if (adapterProfile !== undefined) {
    const checkField = (field: string, expected: string | undefined, actual: string | undefined): void => {
      if (expected === undefined) return;
      if (actual === expected) return;
      add({
        code: 'conformance/backend',
        field: `backend.profile.${field}`,
        message: `backend.profile.${field} 与 adapter.profile.${field} 不一致：读数不同源会让同一份源码在不同入口产出不同行为。`,
        expected: describe(expected),
        actual: describe(actual),
      });
    };
    checkField('waitDefault', adapterProfile.waitDefault, backendProfile.waitDefault);
    checkField('narrationColor', adapterProfile.narrationColor, backendProfile.narrationColor);
    checkField('dialogueColor', adapterProfile.dialogueColor, backendProfile.dialogueColor);
    checkField('colorMode', adapterProfile.colorMode, backendProfile.colorMode);
    checkField('poolStyle', adapterProfile.poolStyle, backendProfile.poolStyle);
    checkField('randStyle', adapterProfile.randStyle, backendProfile.randStyle);

    const priority = backendProfile.priorityModel;
    const expectedPriority = expectedPriorityModel(adapter);
    if (priority !== expectedPriority) {
      add({
        code: 'conformance/backend',
        field: 'backend.profile.priorityModel',
        message: `backend.profile.priorityModel 应为 ${expectedPriority}（由 adapter 事件目录的 priority 模型推出）。`,
        expected: describe(expectedPriority),
        actual: describe(priority),
      });
    }

    const presentations: Partial<KojoPresentationCapabilities> | undefined = backendProfile.presentations;
    const featureKeys = ['heart', 'color', 'face', 'options'] as const;
    for (const feature of featureKeys) {
      const expected = adapter.presentation?.[feature] !== null && adapter.presentation?.[feature] !== undefined;
      const actual = presentations?.[feature] === true;
      if (expected !== actual) {
        add({
          code: 'conformance/backend',
          field: `backend.profile.presentations.${feature}`,
          message: `adapter.presentation.${feature} 与 backend.profile.presentations.${feature} 不一致（声明了能力但没有落点，或反之）。`,
          expected: describe(expected),
          actual: describe(actual),
        });
      }
    }

    const adapterFeatures: Partial<ProgramFeatures> | undefined = adapter.programFeatures;
    const backendFeatures: Partial<KojoProgramFeatures> | undefined = backendProfile.programFeatures;
    if (adapterFeatures !== undefined) {
      for (const key of PROGRAM_FEATURE_KEYS) {
        const expected = adapterFeatures[key] === true;
        const actual = backendFeatures?.[key] === true;
        if (expected !== actual) {
          add({
            code: 'conformance/backend',
            field: `backend.profile.programFeatures.${key}`,
            message: `adapter.programFeatures.${key} 与 backend.profile.programFeatures.${key} 不一致：feature gate 会与产物能力错位。`,
            expected: describe(expected),
            actual: describe(actual),
          });
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    adapterId: adapter.id,
    backendId: backend.id,
    diagnostics,
    profile: readProfile(backendProfile),
    events: readEventCatalog(adapter),
    failures: Object.freeze(failures),
  };
}

/* ============================== 5. backend 录音器 ============================== */

interface ReadingsRecorder {
  readonly events: EventReading[];
  readonly waits: WaitReading[];
  readonly colors: ColorReading[];
}

function createRecorder(): ReadingsRecorder {
  return { events: [], waits: [], colors: [] };
}

function guardOf(adapter: GameAdapter, event: string): string | null {
  return findEvent(adapter, event)?.guard?.text ?? null;
}

function instrumentBackend(
  adapter: GameAdapter,
  backend: KojoEmitBackend,
  recorder: ReadingsRecorder,
): KojoEmitBackend {
  const wrapMachine = backend.wrapMachine;
  return {
    id: backend.id,
    profile: backend.profile,
    hintSupport: (hint) => backend.hintSupport(hint),
    text: {
      line: (request) => {
        recorder.waits.push({ kind: 'text', wait: request.wait, line: request.span.start.line });
        if (request.color.kind === 'block') {
          recorder.colors.push({
            source: 'text',
            value: request.color.color.text,
            line: request.span.start.line,
          });
        }
        return backend.text.line(request);
      },
    },
    blank: {
      line: (request) => {
        recorder.waits.push({ kind: 'blank', wait: request.wait, line: request.span.start.line });
        return backend.blank.line(request);
      },
    },
    control: { ...backend.control },
    presentation: {
      colorEnter: (color) => {
        recorder.colors.push({ source: 'block-enter', value: color.text, line: color.span.start.line });
        return backend.presentation.colorEnter(color);
      },
      colorExit: () => {
        recorder.colors.push({ source: 'block-exit', value: null, line: null });
        return backend.presentation.colorExit();
      },
      face: (request) => backend.presentation.face(request),
      randomBlock: (request, lowerCandidate) => backend.presentation.randomBlock(request, lowerCandidate),
      optionsBlock: (request, lowerItem) => backend.presentation.optionsBlock(request, lowerItem),
    },
    weave: {
      weaveHeader: (request) => {
        recorder.events.push({
          source: 'weave',
          event: request.event,
          args: Object.freeze([...request.args]),
          guard: guardOf(adapter, request.event),
          line: request.span.start.line,
        });
        return backend.weave.weaveHeader(request);
      },
      weaveFooter: () => backend.weave.weaveFooter(),
    },
    program: { ...backend.program },
    wrapMachine:
      wrapMachine === undefined
        ? undefined
        : (request) => {
            recorder.events.push({
              source: 'machine',
              event: request.machine.event,
              args: Object.freeze([...request.machine.args]),
              guard: guardOf(adapter, request.machine.event),
              line: request.machine.span.start.line,
            });
            return wrapMachine(request);
          },
  };
}

/* ============================== 6. 各项检查 ============================== */

interface CaseFailureInput {
  readonly code: ConformanceFailureCode;
  readonly field: string;
  readonly message: string;
  readonly sourceLine?: number | null;
  readonly sourceColumn?: number | null;
  readonly artifactLine?: number | null;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly diff?: readonly ArtifactLineDiff[];
  readonly diagnostics?: readonly KojoDiagnostic[];
}

type CaseFailureAdder = (input: CaseFailureInput) => void;

function checkDiagnostics(
  expected: readonly ExpectedDiagnostic[] | undefined,
  actual: readonly KojoDiagnostic[],
  add: CaseFailureAdder,
): void {
  if (expected === undefined) {
    const errors = actual.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length === 0) return;
    const firstError = errors[0];
    add({
      code: 'conformance/diagnostics',
      field: 'diagnostics',
      message: `编译产生 ${errors.length} 条 error（用例没有声明 expectedDiagnostics）。`,
      actual: errors.map(describeDiagnostic).join(' | '),
      sourceLine: firstError === undefined ? null : diagnosticLine(firstError),
      diagnostics: actual,
    });
    return;
  }

  if (expected.length !== actual.length) {
    const firstActual = actual[0];
    add({
      code: 'conformance/diagnostics',
      field: 'diagnostics',
      message: `诊断条数不一致：期望 ${expected.length} 条，实际 ${actual.length} 条。`,
      expected: expected.map((item) => item.code).join(' | '),
      actual: actual.map(describeDiagnostic).join(' | '),
      sourceLine: firstActual === undefined ? null : diagnosticLine(firstActual),
      diagnostics: actual,
    });
  }

  const count = Math.min(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined || got === undefined) continue;
    const mismatch: string[] = [];
    if (want.code !== got.code) mismatch.push(`code：期望 ${want.code}，实际 ${got.code}`);
    if (want.severity !== undefined && want.severity !== got.severity) {
      mismatch.push(`severity：期望 ${want.severity}，实际 ${got.severity}`);
    }
    if (want.line !== undefined && want.line !== diagnosticLine(got)) {
      mismatch.push(`line：期望 ${want.line}，实际 ${String(diagnosticLine(got))}`);
    }
    if (want.column !== undefined && want.column !== (got.span?.start.column ?? null)) {
      mismatch.push(`column：期望 ${want.column}，实际 ${String(got.span?.start.column ?? null)}`);
    }
    if (mismatch.length === 0) continue;
    add({
      code: 'conformance/diagnostics',
      field: `diagnostics[${i}]`,
      message: `诊断不匹配：${mismatch.join('；')}。`,
      expected: want.code,
      actual: describeDiagnostic(got),
      sourceLine: diagnosticLine(got),
      diagnostics: actual,
    });
  }
}

function checkGolden(
  testCase: GoldenCase,
  result: CompileKojoSourceResult,
  add: CaseFailureAdder,
): void {
  if (result.erb === testCase.expectedErb) return;
  const expectedLines = splitArtifactLines(testCase.expectedErb);
  const actualLines = splitArtifactLines(result.erb);
  const diff = diffArtifactLines(expectedLines, actualLines);
  const first = diff.find((item) => item.kind !== 'same') ?? null;
  const artifactLine = firstCandidateArtifactLine(diff, first);
  const expectedBytes = new TextEncoder().encode(testCase.expectedErb);
  const actualBytes = new TextEncoder().encode(result.erb);
  let offset = 0;
  while (offset < expectedBytes.length && offset < actualBytes.length && expectedBytes[offset] === actualBytes[offset]) {
    offset++;
  }
  add({
    code: 'conformance/golden',
    field: 'expectedErb',
    message:
      `golden 逐字节不一致：首个差异在字节 ${offset}` +
      `（期望 ${expectedBytes.length} 字节 / 实际 ${actualBytes.length} 字节，产物第 ${String(artifactLine ?? '?')} 行）。`,
    expected: testCase.expectedErb,
    actual: result.erb,
    diff,
    artifactLine,
    sourceLine: artifactSourceLine(result, artifactLine),
  });
}

function checkDifferential(
  testCase: DifferentialCase,
  result: CompileKojoSourceResult,
  add: CaseFailureAdder,
): DifferentialResult {
  const comparison = compareArtifacts(testCase.baseline, result.erb, testCase.normalization);
  if (!comparison.equal) {
    const artifactLine = firstCandidateArtifactLine(comparison.diff, comparison.firstDifference);
    add({
      code: 'conformance/differential',
      field: 'baseline',
      message:
        `行为序列不一致：baseline ${comparison.baseline.lines.length} 行 vs 2.0 ${comparison.candidate.lines.length} 行；` +
        `同 ${comparison.summary.same} / 缺 ${comparison.summary.removed} / 多 ${comparison.summary.added}。`,
      expected: jsonLines(comparison.baseline.lines),
      actual: jsonLines(comparison.candidate.lines),
      diff: comparison.diff,
      artifactLine,
      sourceLine: artifactSourceLine(result, artifactLine),
    });
  }
  return comparison;
}

function checkEvents(
  expected: readonly ExpectedEventReading[],
  actual: readonly EventReading[],
  add: CaseFailureAdder,
): void {
  if (expected.length !== actual.length) {
    add({
      code: 'conformance/readings',
      field: 'readings.events',
      message: `事件读数条数不一致：期望 ${expected.length} 条，实际 ${actual.length} 条。`,
      expected: expected.map((item) => item.event).join(' | '),
      actual: actual.map((item) => `${item.source}:${item.event}`).join(' | '),
    });
  }
  const count = Math.min(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined || got === undefined) continue;
    const mismatch: string[] = [];
    if (want.source !== undefined && want.source !== got.source) mismatch.push(`source：期望 ${want.source}，实际 ${got.source}`);
    if (want.event !== got.event) mismatch.push(`event：期望 ${want.event}，实际 ${got.event}`);
    if (want.args !== undefined && want.args.join('\u0000') !== got.args.join('\u0000')) {
      mismatch.push(`args：期望 ${describe(want.args.join(' '))}，实际 ${describe(got.args.join(' '))}`);
    }
    if (want.guard !== undefined && want.guard !== got.guard) {
      mismatch.push(`guard：期望 ${describe(want.guard)}，实际 ${describe(got.guard)}`);
    }
    if (mismatch.length === 0) continue;
    add({
      code: 'conformance/readings',
      field: `readings.events[${i}]`,
      message: `事件读数不匹配：${mismatch.join('；')}。`,
      expected: want.event,
      actual: `${got.source}:${got.event}`,
      sourceLine: got.line,
    });
  }
}

function checkWaits(
  expected: readonly ExpectedWaitReading[],
  actual: readonly WaitReading[],
  add: CaseFailureAdder,
): void {
  if (expected.length !== actual.length) {
    add({
      code: 'conformance/readings',
      field: 'readings.waits',
      message: `等待读数条数不一致：期望 ${expected.length} 条，实际 ${actual.length} 条。`,
      expected: expected.map((item) => item.wait).join(' | '),
      actual: actual.map((item) => `${item.kind}:${item.wait}`).join(' | '),
    });
  }
  const count = Math.min(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined || got === undefined) continue;
    const mismatch: string[] = [];
    if (want.kind !== undefined && want.kind !== got.kind) mismatch.push(`kind：期望 ${want.kind}，实际 ${got.kind}`);
    if (want.wait !== got.wait) mismatch.push(`wait：期望 ${want.wait}，实际 ${got.wait}`);
    if (mismatch.length === 0) continue;
    add({
      code: 'conformance/readings',
      field: `readings.waits[${i}]`,
      message: `等待读数不匹配：${mismatch.join('；')}。`,
      expected: want.wait,
      actual: `${got.kind}:${got.wait}`,
      sourceLine: got.line,
    });
  }
}

function checkColors(
  expected: readonly ExpectedColorReading[],
  actual: readonly ColorReading[],
  add: CaseFailureAdder,
): void {
  if (expected.length !== actual.length) {
    add({
      code: 'conformance/readings',
      field: 'readings.colors',
      message: `取色读数条数不一致：期望 ${expected.length} 条，实际 ${actual.length} 条。`,
      expected: expected.map((item) => item.source ?? 'any').join(' | '),
      actual: actual.map((item) => item.source).join(' | '),
    });
  }
  const count = Math.min(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined || got === undefined) continue;
    const mismatch: string[] = [];
    if (want.source !== undefined && want.source !== got.source) mismatch.push(`source：期望 ${want.source}，实际 ${got.source}`);
    if (want.value !== undefined && want.value !== got.value) {
      mismatch.push(`value：期望 ${describe(want.value)}，实际 ${describe(got.value)}`);
    }
    if (mismatch.length === 0) continue;
    add({
      code: 'conformance/readings',
      field: `readings.colors[${i}]`,
      message: `取色读数不匹配：${mismatch.join('；')}。`,
      expected: want.value ?? want.source ?? '(any)',
      actual: `${got.source}:${String(got.value)}`,
      sourceLine: got.line,
    });
  }
}

function checkReadings(
  expected: ReadingsExpectation,
  observed: CaseReadings,
  add: CaseFailureAdder,
): void {
  if (expected.events !== undefined) checkEvents(expected.events, observed.events, add);
  if (expected.waits !== undefined) checkWaits(expected.waits, observed.waits, add);
  if (expected.colors !== undefined) checkColors(expected.colors, observed.colors, add);

  if (expected.slots !== undefined) {
    const same =
      expected.slots.length === observed.slots.length &&
      expected.slots.every((slot, index) => slot === observed.slots[index]);
    if (!same) {
      add({
        code: 'conformance/readings',
        field: 'readings.slots',
        message: `隐藏槽清单不一致：期望 ${expected.slots.length} 个，实际 ${observed.slots.length} 个。`,
        expected: jsonLines(expected.slots),
        actual: jsonLines(observed.slots),
      });
    }
  }
  if (expected.sourceMapLines !== undefined && expected.sourceMapLines !== observed.sourceMapLines) {
    add({
      code: 'conformance/readings',
      field: 'readings.sourceMapLines',
      message: 'source map 行数与期望不一致。',
      expected: String(expected.sourceMapLines),
      actual: String(observed.sourceMapLines),
    });
  }
  if (expected.artifactLines !== undefined && expected.artifactLines !== observed.artifactLines) {
    add({
      code: 'conformance/readings',
      field: 'readings.artifactLines',
      message: '产物行数与期望不一致。',
      expected: String(expected.artifactLines),
      actual: String(observed.artifactLines),
    });
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function outputEolFor(decoded: DecodedConformanceText, expectation: EncodingExpectation): 'lf' | 'crlf' {
  if (expectation.outputEol !== undefined) return expectation.outputEol;
  if (decoded.eol === 'crlf' || decoded.eol === 'lf') return decoded.eol;
  return 'lf';
}

function checkEncoding(
  testCase: EncodingCase,
  decoded: DecodedConformanceText,
  adapter: GameAdapter,
  backend: KojoEmitBackend,
  result: CompileKojoSourceResult,
  add: CaseFailureAdder,
): EncodingReading {
  const expectation = testCase.encoding;

  if (decoded.encoding !== expectation.sourceEncoding) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.sourceEncoding',
      message: '源字节的实际编码与声明不一致。',
      expected: expectation.sourceEncoding,
      actual: decoded.encoding,
      sourceLine: 1,
    });
  }
  if (decoded.eol !== expectation.sourceEol) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.sourceEol',
      message: '源字节的实际 EOL 与声明不一致。',
      expected: expectation.sourceEol,
      actual: decoded.eol,
      sourceLine: 1,
    });
  }

  const allowedEncodings = adapter.encodingPolicy?.allowedEncodings ?? [];
  if (!allowedEncodings.includes(decoded.encoding)) {
    add({
      code: 'conformance/encoding',
      field: 'adapter.encodingPolicy.allowedEncodings',
      message: `adapter 的 allowedEncodings 不包含源编码 ${decoded.encoding}：该编码无法通过 adapter 自己的策略。`,
      expected: allowedEncodings.join(' | '),
      actual: decoded.encoding,
      sourceLine: 1,
    });
  }
  if (!eolPolicyAccepts(adapter.encodingPolicy?.eol ?? 'mixed', decoded.eol)) {
    add({
      code: 'conformance/encoding',
      field: 'adapter.encodingPolicy.eol',
      message: `adapter 的 EOL 策略不接受源文件的 ${decoded.eol}。`,
      expected: String(adapter.encodingPolicy?.eol),
      actual: decoded.eol,
      sourceLine: 1,
    });
  }

  const roundTripBytes = encodeConformanceTextPreservingEol(decoded.text, decoded.encoding);
  const roundTrip = bytesEqual(roundTripBytes, testCase.bytes);
  if (!roundTrip) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.roundTrip',
      message: '源字节 decode → encode 后与原字节不一致（编码换算不是可逆的）。',
      expected: `${testCase.bytes.length} 字节`,
      actual: `${roundTripBytes.length} 字节`,
      sourceLine: 1,
    });
  }

  /* EOL 不得改变产物语义：LF 版与源文件版必须逐字节同产物 */
  let eolInvariant = true;
  const lfSource = normalizeEolToLf(decoded.text);
  if (lfSource !== decoded.text) {
    const lfResult = compileKojoSource({
      source: lfSource,
      adapter,
      backend,
      view: testCase.view,
    });
    eolInvariant = lfResult.erb === result.erb;
    if (!eolInvariant) {
      add({
        code: 'conformance/encoding',
        field: 'encoding.eolInvariant',
        message: '同一源文本换成 LF 后产物不同：EOL 泄漏进了编译结果。',
        expected: `${artifactLineCount(result.erb)} 行`,
        actual: `${artifactLineCount(lfResult.erb)} 行`,
        sourceLine: 1,
      });
    }
  }

  /* BOM 不得改变产物语义：带/不带 BOM 必须同产物 */
  let bomInvariant = true;
  if (decoded.bom) {
    const bomResult = compileKojoSource({
      source: `\uFEFF${decoded.text}`,
      adapter,
      backend,
      view: testCase.view,
    });
    bomInvariant = bomResult.erb === result.erb;
    if (!bomInvariant) {
      add({
        code: 'conformance/encoding',
        field: 'encoding.bomInvariant',
        message: '带 BOM 的源文本产物不同：BOM 泄漏进了编译结果。',
        expected: `${artifactLineCount(result.erb)} 行`,
        actual: `${artifactLineCount(bomResult.erb)} 行`,
        sourceLine: 1,
      });
    }
  }

  const outputEncoding = expectation.outputEncoding ?? decoded.encoding;
  const outputEol = outputEolFor(decoded, expectation);
  const outputBytes = encodeConformanceText(result.erb, {
    encoding: outputEncoding,
    eol: outputEol,
    trailingNewline: hasTrailingEol(result.erb),
  });
  const outputDecoded = decodeConformanceText(outputBytes);
  if (outputDecoded.encoding !== outputEncoding) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.outputEncoding',
      message: '产物重新编码后的实际编码与期望不一致。',
      expected: outputEncoding,
      actual: outputDecoded.encoding,
      sourceLine: 1,
    });
  }
  if (normalizeEolToLf(outputDecoded.text) !== normalizeEolToLf(result.erb)) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.outputText',
      message: '产物字节 decode 回来与编译结果文本不一致（EOL 之外的内容被改写）。',
      expected: result.erb,
      actual: outputDecoded.text,
      sourceLine: 1,
    });
  }
  const expectedOutputEol: ConformanceEol = result.erb.length === 0 ? 'none' : outputEol;
  if (outputDecoded.eol !== expectedOutputEol) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.outputEol',
      message: '产物 EOL 与保留目标不一致。',
      expected: expectedOutputEol,
      actual: outputDecoded.eol,
      sourceLine: 1,
    });
  }

  const preserveBom = expectation.preserveBom ?? true;
  const preservedBom = outputDecoded.bom === decoded.bom;
  if (preserveBom && !preservedBom) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.preservedBom',
      message: '源的 BOM 存在性与产物不一致（preserveBom 要求保留）。',
      expected: String(decoded.bom),
      actual: String(outputDecoded.bom),
      sourceLine: 1,
    });
  }
  if (decoded.bom && adapter.encodingPolicy?.preserveBom !== true) {
    add({
      code: 'conformance/encoding',
      field: 'adapter.encodingPolicy.preserveBom',
      message: '源文件带 BOM，但 adapter 的 preserveBom 不是 true：策略与源形状冲突。',
      expected: 'true',
      actual: String(adapter.encodingPolicy?.preserveBom),
      sourceLine: 1,
    });
  }
  const preservedEol =
    decoded.eol === 'none' ||
    decoded.eol === 'mixed' ||
    result.erb.length === 0 ||
    outputDecoded.eol === decoded.eol;
  if ((expectation.preserveEol ?? true) && !preservedEol) {
    add({
      code: 'conformance/encoding',
      field: 'encoding.preservedEol',
      message: '产物 EOL 与源文件不一致（preserveEol 要求保留）。',
      expected: decoded.eol,
      actual: outputDecoded.eol,
      sourceLine: 1,
    });
  }

  return {
    source: {
      encoding: decoded.encoding,
      eol: decoded.eol,
      bom: decoded.bom,
      bytes: testCase.bytes.length,
    },
    output: {
      encoding: outputDecoded.encoding,
      eol: outputDecoded.eol,
      bom: outputDecoded.bom,
      bytes: outputBytes.length,
    },
    roundTrip,
    eolInvariant,
    bomInvariant,
    preservedBom,
    preservedEol,
  };
}

/* ============================== 7. 单用例执行 ============================== */

function emptyObservations(): CaseObservations {
  return { erbBytes: null, readings: null, differential: null, encoding: null };
}

function runCase(
  adapter: GameAdapter,
  backend: KojoEmitBackend,
  testCase: AdapterConformanceCase,
): ConformanceCaseReport {
  const failures: ConformanceFailure[] = [];
  const add: CaseFailureAdder = (input) => {
    failures.push(makeFailure({ ...input, check: testCase.kind, caseName: testCase.name }));
  };

  let decoded: DecodedConformanceText | null = null;
  let source: string | null;
  if (testCase.kind === 'encoding') {
    try {
      decoded = decodeConformanceText(testCase.bytes);
      source = decoded.text;
    } catch (error: unknown) {
      add({
        code: 'conformance/input',
        field: 'bytes',
        message: `源字节无法按契约编码解码：${errorMessage(error)}`,
      });
      source = null;
    }
  } else {
    source = testCase.source;
  }

  if (source === null) {
    return {
      name: testCase.name,
      kind: testCase.kind,
      ok: failures.length === 0,
      observations: emptyObservations(),
      failures: Object.freeze(failures),
    };
  }

  const recorder = createRecorder();
  const instrumented = instrumentBackend(adapter, backend, recorder);
  let result: CompileKojoSourceResult;
  try {
    result = compileKojoSource({
      source,
      adapter,
      backend: instrumented,
      view: testCase.view,
    });
  } catch (error: unknown) {
    add({
      code: 'conformance/input',
      field: 'source',
      message: `compileKojoSource 抛错：${errorMessage(error)}`,
    });
    return {
      name: testCase.name,
      kind: testCase.kind,
      ok: false,
      observations: emptyObservations(),
      failures: Object.freeze(failures),
    };
  }

  const observed: CaseReadings = {
    events: Object.freeze([...recorder.events]),
    waits: Object.freeze([...recorder.waits]),
    colors: Object.freeze([...recorder.colors]),
    slots: Object.freeze(result.slots.map((slot) => slot.name)),
    sourceMapLines: result.sourceMap.lineCount,
    artifactLines: artifactLineCount(result.erb),
    diagnostics: result.diagnostics,
  };

  let differentialReading: DifferentialReading | null = null;
  let encodingReading: EncodingReading | null = null;

  if (testCase.kind === 'golden') checkGolden(testCase, result, add);
  if (testCase.kind === 'differential') {
    const comparison = checkDifferential(testCase, result, add);
    differentialReading = {
      equal: comparison.equal,
      summary: comparison.summary,
      diff: comparison.diff,
      baselineLines: comparison.baseline.lines.length,
      candidateLines: comparison.candidate.lines.length,
      firstDifferenceLine: firstCandidateArtifactLine(comparison.diff, comparison.firstDifference),
    };
  }
  if (testCase.kind === 'encoding' && decoded !== null) {
    try {
      encodingReading = checkEncoding(testCase, decoded, adapter, backend, result, add);
    } catch (error: unknown) {
      add({
        code: 'conformance/input',
        field: 'encoding',
        message: `encoding 取证抛错：${errorMessage(error)}`,
      });
    }
  }
  if (testCase.kind === 'readings' && testCase.readings === undefined) {
    add({
      code: 'conformance/input',
      field: 'readings',
      message: 'readings 用例必须声明 readings 期望。',
    });
  }
  if (testCase.readings !== undefined) checkReadings(testCase.readings, observed, add);
  checkDiagnostics(testCase.expectedDiagnostics, result.diagnostics, add);

  return {
    name: testCase.name,
    kind: testCase.kind,
    ok: failures.length === 0,
    observations: {
      erbBytes: new TextEncoder().encode(result.erb).length,
      readings: observed,
      differential: differentialReading,
      encoding: encodingReading,
    },
    failures: Object.freeze(failures),
  };
}

/* ============================== 8. 报告 ============================== */

const CHECK_ORDER: readonly ConformanceCheck[] = Object.freeze([
  'contract',
  'golden',
  'differential',
  'encoding',
  'readings',
  'smoke',
]);

function buildSummary(
  contract: ContractCheckReport,
  cases: readonly ConformanceCaseReport[],
): ConformanceSummary {
  const passedCases = cases.filter((item) => item.ok).length;
  const byCheck: ConformanceCheckSummary[] = [];
  for (const check of CHECK_ORDER) {
    if (check === 'contract') {
      byCheck.push({
        check,
        passed: contract.ok ? 1 : 0,
        failed: contract.ok ? 0 : 1,
        skipped: 0,
      });
      continue;
    }
    if (check === 'smoke') {
      byCheck.push({ check, passed: 0, failed: 0, skipped: 1 });
      continue;
    }
    const selected = cases.filter((item) => item.kind === check);
    const passed = selected.filter((item) => item.ok).length;
    byCheck.push({ check, passed, failed: selected.length - passed, skipped: 0 });
  }
  return {
    cases: cases.length,
    passed: passedCases,
    failed: cases.length - passedCases + (contract.ok ? 0 : 1),
    failures: contract.failures.length + cases.reduce((sum, item) => sum + item.failures.length, 0),
    byCheck,
  };
}

/**
 * 跑完整 conformance 套件（同步、纯函数）。
 *
 * 顺序：先契约自检（adapter 的 `validateGameAdapter` + backend 读数对拍），再逐用例编译。
 * 即使契约失败也继续跑用例——作者需要一次看到全部失败，而不是修一条跑一条。
 */
export function runAdapterConformance(input: AdapterConformanceInput): AdapterConformanceReport {
  const contract = checkContract(input.adapter, input.backend);
  const cases = input.cases.map((testCase) => runCase(input.adapter, input.backend, testCase));
  const failures = Object.freeze([...contract.failures, ...cases.flatMap((item) => item.failures)]);
  const skips: readonly ConformanceSkip[] = Object.freeze([
    {
      check: 'smoke',
      reason: 'smoke 需要真实壳（kit 不 import 宿主 / Monaco / kernel），本套件只做纯函数验收面。',
    },
  ]);
  return {
    adapterId: input.adapter.id,
    backendId: input.backend.id,
    ok: failures.length === 0,
    contract,
    cases: Object.freeze(cases),
    failures,
    skips,
    summary: buildSummary(contract, cases),
  };
}

/** 便捷入口：把一条 golden 用例的产物行数按 kit 口径数出来（报告/断言共用） */
export function countArtifactLines(erb: string): number {
  return artifactLineCount(erb);
}

/** 便捷入口：kit 口径的归一化读数（differential 报告字段与单测共用） */
export function summarizeDifferential(diff: readonly ArtifactLineDiff[]): LineDiffSummary {
  return summarizeLineDiff(diff);
}
