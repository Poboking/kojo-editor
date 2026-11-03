/**
 * Kojo 2.0 M2-P1：Project IR 的事实形状与构造器。
 *
 * 本模块只做**项目事实层**：
 * - 从已有 `KojoFile` / lowering unit 构造 Project IR，不重新解析源文件、不改写 AST；
 * - 保留文件顺序、Theater 的源文件归属 / ordinal / 原始 span；
 * - legacy-machine 的 origin 原样保留；
 * - 解析失败不阻断其他文件，`analysisStatus` 与 `buildStatus` 分离；
 * - 输出确定性诊断排序。
 *
 * 目标解析与链接由 `target-registry.ts` / `linker.ts` 在 Project IR 之上完成；
 * `buildProjectIR` 只产出未解析的源事实，`ProjectTheaterIR.targetResolution` 初始为 null。
 */
import type { Capability, SourceMapPolicy } from '../adapter.js';
import type { KojoFile, KojoSpan, KojoTheater, KojoTheaterLocation, KojoTheaterTime } from '../ast.js';
import type { KojoDiagnostic } from '../diagnostics.js';
import type { TheaterLoweringUnit, TheaterUnitsStatus } from '../lower/theater-unit.js';
import type { SourceMapData } from '../source-map-data.js';
import { toSourceMapData } from '../source-map-data.js';
import type { ProjectFileId, ProjectFileIdentity, TheaterId } from './identity.js';
import { projectFileId, projectTheaterId } from './identity.js';
import type { TargetResolution } from './target-registry.js';
import type { RuntimeMatchPolicy } from '../runtime-policy.js';
import { compareNullableSpan, compareText, sortDiagnostics } from './ordering.js';

export type CanonicalTargetId = string;
export type RegistryId = string;

/* ============================== 契约类型 ============================== */

/** 版本 / 缓存相关事实；P1 只携带，不据此做版本匹配。 */
export interface ProjectBuildProvenance {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterFactsVersion: string;
  readonly gameFingerprint: string;
  readonly targetRegistryId: RegistryId;
  readonly targetRegistryVersion: string;
  readonly backendId: string;
  readonly backendVersion: string | null;
  readonly coreVersion: string;
  readonly sourceMapPolicy: SourceMapPolicy;
  readonly capability: Capability;
}

/**
 * Host 注入的文件级函数名上下文。
 *
 * 缺席 ≠ 空串：`familySegment: ''` 是标准版家族的显式事实；`{}` 表示 Host 没有给。
 * 本类型不带任何默认值或推断逻辑。
 */
export interface FunctionNameContext {
  readonly charNo?: string;
  readonly familySegment?: string;
}

export type FunctionNameIndexOrigin = 'machine-args' | 'theater-target' | 'none';

/** Core 编译派生事实：`# 机` 的 args[0] 可来自 parser；Theater 目标当前不猜参数。 */
export interface FunctionNameSourceArgs {
  readonly index: string | null;
  readonly indexOrigin: FunctionNameIndexOrigin;
  readonly span: KojoSpan | null;
}

export type ProjectDiagnosticKind =
  | 'target-unknown'
  | 'target-unsupported'
  | 'registry-binding'
  | 'function-name-context-missing'
  | 'function-name-context-invalid'
  | 'duplicate-theater'
  | 'version-mismatch'
  | 'project-incomplete';

export type ProjectLocationRole =
  | 'declaration'
  | 'definition'
  | 'conflict'
  | 'reference'
  | 'project';

export interface ProjectLocation {
  readonly fileId: string;
  readonly path: string;
  readonly span: KojoSpan | null;
  readonly role: ProjectLocationRole;
}

export interface ProjectDiagnostic {
  readonly kind: ProjectDiagnosticKind;
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly primary: ProjectLocation;
  readonly related: readonly ProjectLocation[];
}

export type ProjectAnalysisStatus = 'complete' | 'partial';
export type ProjectBuildStatus = 'succeeded' | 'failed';

export type ProjectTheaterLinkStatus =
  | 'unlinked'
  | 'grouped'
  | 'duplicate'
  | 'unsupported'
  | 'unknown'
  | 'needs-context'
  | 'invalid-context'
  | 'version-mismatch';

export interface ProjectFileIR {
  readonly fileId: ProjectFileId;
  readonly path: string;
  readonly pathKey: string;
  readonly layerId: string | null;
  readonly contentHash: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly file: KojoFile | null;
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly parseStatus: 'ok' | 'failed';
  readonly functionNameContext: FunctionNameContext;
}

export interface ProjectTheaterIR {
  readonly theaterId: TheaterId;
  readonly fileId: ProjectFileId;
  readonly ordinal: number;
  readonly origin: 'theater' | 'legacy-machine';
  readonly theater: KojoTheater;
  readonly unit: TheaterLoweringUnit | null;
  readonly unitStatus: TheaterUnitsStatus;
  readonly sourceMapData: SourceMapData | null;
  readonly sourceArgs: FunctionNameSourceArgs;
  readonly targetResolution: TargetResolution | null;
  readonly linkStatus: ProjectTheaterLinkStatus;
}

export interface ProjectIR {
  readonly projectId: string;
  readonly provenance: ProjectBuildProvenance;
  readonly analysisStatus: ProjectAnalysisStatus;
  readonly files: readonly ProjectFileIR[];
  readonly theaters: readonly ProjectTheaterIR[];
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly failedFiles: readonly ProjectFileId[];
}

export interface ResolvedTheater {
  readonly theaterId: TheaterId;
  readonly fileId: ProjectFileId;
  readonly ordinal: number;
  readonly origin: 'theater' | 'legacy-machine';
  readonly rawTarget: string;
  /** M3 additive: parser location fact carried through so matcher needs no re-parse. */
  readonly location: KojoTheaterLocation;
  /** M3 additive: parser time fact carried through so matcher needs no re-parse. */
  readonly time: KojoTheaterTime;
  readonly canonicalId: string | null;
  readonly resolution: TargetResolution;
  readonly sourceArgs: FunctionNameSourceArgs;
  readonly engineFunctionName: import('./target-registry.js').FunctionNameResolution;
  readonly callSignature: import('./target-registry.js').CallSignature | null;
  readonly sourceSpan: KojoSpan;
  /**
   * P1-4 收尾（多角色重复隔离）：本 Theater 是否是 exact duplicate 的重复项。
   *
   * 重复是**按函数名 + 五字段键**判的；同 canonical 下 K12 重复不影响 K13。
   * Matcher 必须过滤 duplicate 候选、dispatch plan 必须只阻断重复的那个 functionName。
   */
  readonly duplicate: boolean;
}

export interface LinkedTheaterGroup {
  readonly canonicalId: string;
  readonly theaters: readonly ResolvedTheater[];
  /** 组内是否存在任一 duplicate（兼容视图；不得再拿它阻断整组）。 */
  readonly duplicate: boolean;
  /**
   * 有重复定义的引擎函数名（K12 重复 → ['M_KOJO_ENCOUNTER_K12']）。
   *
   * Matcher / Dispatch Plan 按这份名单做**函数级**隔离：K13 不被 K12 污染。
   */
  readonly duplicateFunctionNames: readonly string[];
}

export interface LinkedProject {
  readonly projectId: string;
  readonly provenance: ProjectBuildProvenance;
  /** M3 additive：registry 携带的运行时匹配策略；缺省 = 无策略。 */
  readonly runtimeMatchPolicy?: RuntimeMatchPolicy | null;
  readonly groups: readonly LinkedTheaterGroup[];
  readonly theaters: readonly ResolvedTheater[];
  readonly diagnostics: readonly ProjectDiagnostic[];
}

export interface ProjectBuildResult {
  readonly projectId: string;
  readonly analysisStatus: ProjectAnalysisStatus;
  readonly buildStatus: ProjectBuildStatus;
  readonly projectIR: ProjectIR;
  readonly linkedProject: LinkedProject | null;
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly failedFiles: readonly ProjectFileId[];
}
/* ============================== 构造输入 ============================== */

export interface ProjectTheaterLoweringInput {
  readonly units: readonly TheaterLoweringUnit[];
  readonly status: TheaterUnitsStatus;
  readonly diagnostics?: readonly KojoDiagnostic[];
}

export interface ProjectFileInput {
  /** 宿主已用 `pathKey` / `stableHash` 算好的身份事实 */
  readonly identity: ProjectFileIdentity;
  /** 已解析 AST；null = 这份文件解析失败（不阻断其他文件） */
  readonly file: KojoFile | null;
  /**
   * 文件级诊断。给出时按原样收下；缺省 = AST 自带诊断 + lowering 诊断。
   * 不把解析失败的异常文本塞进这里；失败本身由 builder 生成 ProjectDiagnostic。
   */
  readonly diagnostics?: readonly KojoDiagnostic[];
  readonly functionNameContext?: FunctionNameContext;
  /** 可选：已跑过的单文件 lowering 结果；不重新解析、不重新编译。 */
  readonly lowering?: ProjectTheaterLoweringInput;
}

export interface ProjectIRInput {
  readonly projectId: string;
  readonly provenance: ProjectBuildProvenance;
  readonly files: readonly ProjectFileInput[];
}

/* ============================== 构造器 ============================== */

const PROJECT_PARSE_FAILED_CODE = 'core/project/parse-failed';

function locationOf(
  fileId: ProjectFileId,
  path: string,
  span: KojoSpan | null,
  role: ProjectLocationRole,
): ProjectLocation {
  return { fileId, path, span, role };
}

function parseFailureDiagnostic(identity: ProjectFileIdentity): ProjectDiagnostic {
  return {
    kind: 'project-incomplete',
    code: PROJECT_PARSE_FAILED_CODE,
    severity: 'error',
    message: `文件无法解析，Project IR 未生成该文件的 AST：${identity.path}`,
    primary: locationOf(identity.fileId, identity.path, null, 'declaration'),
    related: [],
  };
}

function sourceArgsOfTheater(theater: KojoTheater): FunctionNameSourceArgs {
  const machine = theater.legacyMachine;
  if (machine === null) {
    // 显式 Theater 的 target 只有 raw；不拆 raw、不猜 i（Contracts D7 / P1 硬约束）。
    return { index: null, indexOrigin: 'none', span: null };
  }

  const firstArg = machine.args[0];
  if (firstArg === undefined) {
    return { index: null, indexOrigin: 'none', span: machine.span };
  }
  return { index: firstArg, indexOrigin: 'machine-args', span: machine.span };
}

function sortProjectDiagnostics(diagnostics: readonly ProjectDiagnostic[]): readonly ProjectDiagnostic[] {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort(
      (a, b) =>
        compareText(a.diagnostic.primary.fileId, b.diagnostic.primary.fileId) ||
        compareNullableSpan(a.diagnostic.primary.span, b.diagnostic.primary.span) ||
        compareText(a.diagnostic.kind, b.diagnostic.kind) ||
        compareText(a.diagnostic.code, b.diagnostic.code) ||
        compareText(a.diagnostic.message, b.diagnostic.message) ||
        a.index - b.index,
    )
    .map((entry) => entry.diagnostic);
}

function diagnosticsOfFile(input: ProjectFileInput): readonly KojoDiagnostic[] {
  const merged =
    input.diagnostics !== undefined
      ? input.diagnostics
      : [
          ...(input.file?.diagnostics ?? []),
          ...(input.lowering?.diagnostics ?? []),
        ];
  return sortDiagnostics(merged);
}

function unitsByTheater(
  lowering: ProjectTheaterLoweringInput | undefined,
  theaters: readonly KojoTheater[],
  identity: ProjectFileIdentity,
): readonly (TheaterLoweringUnit | null)[] {
  if (lowering === undefined) return theaters.map(() => null);

  if (lowering.status !== 'complete') {
    if (lowering.units.length > 0) {
      throw new Error(
        `[project-ir] ${identity.path} 的 lowering 状态为 ${lowering.status}，但携带了 ${lowering.units.length} 个 unit`,
      );
    }
    return theaters.map(() => null);
  }

  return theaters.map((theater) => {
    const unit = lowering.units.find((candidate) => candidate.theater === theater);
    if (unit === undefined) {
      throw new Error(
        `[project-ir] ${identity.path} 的 lowering 状态为 complete，但 Theater ordinal 缺少对应 unit`,
      );
    }
    return unit;
  });
}

/**
 * 从已有解析 / lowering 结果构造 Project IR。
 *
 * 文件数组顺序 = 调用方给的源文件顺序（P1 显式要求保留）；Theater 数组按文件顺序
 * 展开，文件内按 `file.theaters` 源顺序。诊断单独按 fileId → span → kind → code →
 * message 排序，不依赖输入枚举顺序。
 */
export function buildProjectIR(input: ProjectIRInput): ProjectIR {
  const files: ProjectFileIR[] = [];
  const theaters: ProjectTheaterIR[] = [];
  const projectDiagnostics: ProjectDiagnostic[] = [];
  const failedFiles: ProjectFileId[] = [];
  const seenFileIds = new Set<ProjectFileId>();

  for (const inputFile of input.files) {
    const { identity } = inputFile;
    const expectedFileId = projectFileId(identity.pathKey, identity.layerId);
    if (identity.fileId !== expectedFileId) {
      throw new Error(
        `[project-ir] 文件身份不一致：identity.fileId=${identity.fileId}，期望 ${expectedFileId}`,
      );
    }
    if (seenFileIds.has(identity.fileId)) {
      throw new Error(`[project-ir] 同一 layer 内 ProjectFileId 重复：${identity.fileId}`);
    }
    seenFileIds.add(identity.fileId);

    const parseStatus = inputFile.file === null ? 'failed' : 'ok';
    const fileIR: ProjectFileIR = {
      fileId: identity.fileId,
      path: identity.path,
      pathKey: identity.pathKey,
      layerId: identity.layerId,
      contentHash: identity.contentHash,
      adapterId: input.provenance.adapterId,
      adapterVersion: input.provenance.adapterVersion,
      file: inputFile.file,
      diagnostics: diagnosticsOfFile(inputFile),
      parseStatus,
      functionNameContext: inputFile.functionNameContext ?? {},
    };
    files.push(fileIR);

    if (parseStatus === 'failed') {
      failedFiles.push(identity.fileId);
      projectDiagnostics.push(parseFailureDiagnostic(identity));
      continue;
    }

    const sourceTheaters = inputFile.file?.theaters ?? [];
    const units = unitsByTheater(inputFile.lowering, sourceTheaters, identity);
    for (let ordinal = 0; ordinal < sourceTheaters.length; ordinal++) {
      const theater = sourceTheaters[ordinal];
      if (theater === undefined) continue;
      const unit = units[ordinal] ?? null;
      theaters.push({
        theaterId: projectTheaterId(identity.fileId, ordinal),
        fileId: identity.fileId,
        ordinal,
        origin: theater.origin,
        theater,
        unit,
        unitStatus: inputFile.lowering?.status ?? 'not-applicable',
        sourceMapData: unit === null ? null : toSourceMapData(unit.sourceMap),
        sourceArgs: sourceArgsOfTheater(theater),
        targetResolution: null,
        linkStatus: 'unlinked',
      });
    }
  }

  const analysisStatus: ProjectAnalysisStatus =
    failedFiles.length > 0 ? 'partial' : 'complete';

  return {
    projectId: input.projectId,
    provenance: input.provenance,
    analysisStatus,
    files,
    theaters,
    diagnostics: sortProjectDiagnostics(projectDiagnostics),
    failedFiles,
  };
}

/**
 * 由 Project IR 派生构建结果。
 *
 * P1 没有 Linker，因此 `linkedProject` 恒为 null；`buildStatus` 仍遵守 Contracts D6：
 * 解析失败、部分分析、阻断诊断、丢弃的 theater unit、或尚未跑 lowering 的 Theater 都
 * 使构建失败——不把"有一份 IR"误报成"可以发布"。
 */
export function buildProjectBuildResult(
  projectIR: ProjectIR,
  linkedProject: LinkedProject | null = null,
): ProjectBuildResult {
  const diagnostics =
    linkedProject === null
      ? projectIR.diagnostics
      : sortProjectDiagnostics([...projectIR.diagnostics, ...linkedProject.diagnostics]);
  const hasBlockingProjectDiagnostic = diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error',
  );
  const hasBlockingFileDiagnostic = projectIR.files.some((file) =>
    file.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  );
  const hasDiscardedTheaterUnits = projectIR.theaters.some(
    (theater) => theater.unitStatus === 'discarded-syntax' || theater.unitStatus === 'discarded-lowering',
  );
  const hasUncompiledTheater = projectIR.theaters.some(
    (theater) => theater.origin === 'theater' && theater.unitStatus === 'not-applicable',
  );
  const hasUnresolvedTheater = projectIR.theaters.some(
    (theater) => theater.targetResolution === null,
  );

  const buildStatus: ProjectBuildStatus =
    projectIR.analysisStatus === 'complete' &&
    projectIR.failedFiles.length === 0 &&
    !hasBlockingProjectDiagnostic &&
    !hasBlockingFileDiagnostic &&
    !hasDiscardedTheaterUnits &&
    !hasUncompiledTheater &&
    !hasUnresolvedTheater
      ? 'succeeded'
      : 'failed';

  return {
    projectId: projectIR.projectId,
    analysisStatus: projectIR.analysisStatus,
    buildStatus,
    projectIR,
    linkedProject,
    diagnostics,
    failedFiles: projectIR.failedFiles,
  };
}
