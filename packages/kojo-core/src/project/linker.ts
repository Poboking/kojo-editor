/**
 * M2 Project Linker（P3/P4）：项目级目标解析、静态分组与 exact duplicate。
 *
 * 边界：
 * - 只消费 Project IR + TargetRegistry；不读盘、不生成 ERB；
 * - 不做 location/time matcher、specificity、唯一选择或最终 dispatch（M3）；
 * - exact duplicate 按 Contracts D2 的五字段 + engineFunctionName 逐字比较，不引入地点/时间
 *   别名或区间语义；不同函数名（多角色 / 多家族）同组不是重复，是合法的多定义；
 * - 输出确定性排序，但 ProjectIR.files / ProjectIR.theaters 的源事实顺序保留。
 */
import type { KojoSpan } from '../ast.js';
import type {
  LinkedProject,
  LinkedTheaterGroup,
  ProjectDiagnostic,
  ProjectIR,
  ProjectLocation,
  ProjectTheaterIR,
  ResolvedTheater,
} from './ir.js';
import { compareNullableSpan, compareText } from './ordering.js';
import type { TargetRegistry, TargetResolution } from './target-registry.js';
import { resolveTarget } from './target-registry.js';

export interface ExactTheaterKey {
  readonly canonicalTargetId: string;
  readonly locationKind: 'unrestricted' | 'exact';
  readonly locationRaw: string;
  readonly timeKind: 'unrestricted' | 'named';
  readonly timeRaw: string;
  /**
   * P1-4：引擎函数名身份也进键。
   *
   * 同一 canonical target 下，不同角色/家族的函数名（如 `M_KOJO_ENCOUNTER_K12` /
   * `M_KOJO_ENCOUNTER_K13`）是不同实现，不构成 exact duplicate；只有函数名也相同才是
   * 真正的重复定义。null = 解析未给出函数名（non-supported 不进键，正常不会走到这里）。
   */
  readonly engineFunctionName: string | null;
}

export interface TheaterDuplicateFact {
  readonly key: ExactTheaterKey;
  readonly primary: ProjectTheaterIR;
  readonly related: readonly ProjectTheaterIR[];
}

export interface ProjectLinkResult {
  readonly projectIR: ProjectIR;
  readonly linkedProject: LinkedProject;
}

function locationOf(
  theater: ProjectTheaterIR,
  path: string,
  span: KojoSpan | null,
  role: ProjectLocation['role'],
): ProjectLocation {
  return { fileId: theater.fileId, path, span, role };
}

function linkStatusOf(resolution: TargetResolution): ProjectTheaterIR['linkStatus'] {
  if (resolution.status === 'supported') return 'unlinked';
  return resolution.status;
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

function versionMismatchDiagnostic(projectIR: ProjectIR, registry: TargetRegistry): ProjectDiagnostic {
  return {
    kind: 'version-mismatch',
    code: 'core/target/version-mismatch',
    severity: 'error',
    message:
      `Project IR 使用 Registry ${projectIR.provenance.targetRegistryId}@${projectIR.provenance.targetRegistryVersion}，` +
      `当前 Registry 为 ${registry.registryId}@${registry.version}：拒绝静默回落。`,
    primary: {
      fileId: '',
      path: projectIR.projectId,
      span: null,
      role: 'project',
    },
    related: [],
  };
}

/**
 * P3：把每个 ProjectTheaterIR 的 target 解析成 TargetResolution。
 *
 * 版本不匹配时不做目标解析：每个 Theater 保持 targetResolution=null、
 * linkStatus='version-mismatch'，并产生 version-mismatch error。
 */
export function resolveProjectTargets(projectIR: ProjectIR, registry: TargetRegistry): ProjectIR {
  const versionMatches =
    projectIR.provenance.targetRegistryId === registry.registryId &&
    projectIR.provenance.targetRegistryVersion === registry.version;
  if (!versionMatches) {
    const diagnostic = versionMismatchDiagnostic(projectIR, registry);
    return {
      ...projectIR,
      theaters: projectIR.theaters.map((theater) => ({
        ...theater,
        targetResolution: null,
        linkStatus: 'version-mismatch' as const,
      })),
      diagnostics: sortProjectDiagnostics([...projectIR.diagnostics, diagnostic]),
    };
  }

  const filePathById = new Map(projectIR.files.map((file) => [file.fileId, file.path]));
  const diagnostics: ProjectDiagnostic[] = [...projectIR.diagnostics];
  const theaters = projectIR.theaters.map((theater) => {
    const path = filePathById.get(theater.fileId) ?? '';
    const resolution = resolveTarget({
      registry,
      rawTarget: theater.theater.target.raw,
      context: projectIR.files.find((file) => file.fileId === theater.fileId)?.functionNameContext ?? {},
      sourceArgs: theater.sourceArgs,
      location: locationOf(theater, path, theater.theater.target.span, 'definition'),
    });
    diagnostics.push(...resolution.diagnostics);
    return {
      ...theater,
      targetResolution: resolution,
      linkStatus: linkStatusOf(resolution),
    };
  });

  return {
    ...projectIR,
    theaters,
    diagnostics: sortProjectDiagnostics(diagnostics),
  };
}

/**
 * D2 + P1-4：exact duplicate 唯一键。
 *
 * 五字段（canonicalId + parser 既有 location/time）来自既有事实，`engineFunctionName`
 * 来自 `resolution.functionName.name`（adapter 声明、core 求值的函数名身份）。
 */
export function exactTheaterKeyOf(theater: ProjectTheaterIR): ExactTheaterKey | null {
  const resolution = theater.targetResolution;
  if (resolution === null || resolution.canonicalId === null) return null;
  if (resolution.status === 'unknown' || resolution.status === 'unsupported') return null;
  return {
    canonicalTargetId: resolution.canonicalId,
    locationKind: theater.theater.location.kind,
    locationRaw: theater.theater.location.raw,
    timeKind: theater.theater.time.kind,
    timeRaw: theater.theater.time.raw,
    engineFunctionName: resolution.functionName.name,
  };
}

function exactKeyText(key: ExactTheaterKey): string {
  return [
    key.canonicalTargetId,
    key.locationKind,
    key.locationRaw,
    key.timeKind,
    key.timeRaw,
    key.engineFunctionName,
  ].join('\u0000');
}

function sourceSpanOf(theater: ProjectTheaterIR): KojoSpan {
  return theater.theater.target.span;
}

function compareTheaters(a: ProjectTheaterIR, b: ProjectTheaterIR): number {
  const aCanonical = a.targetResolution?.canonicalId ?? '';
  const bCanonical = b.targetResolution?.canonicalId ?? '';
  return (
    compareText(aCanonical, bCanonical) ||
    compareText(a.fileId, b.fileId) ||
    compareNullableSpan(sourceSpanOf(a), sourceSpanOf(b)) ||
    a.ordinal - b.ordinal
  );
}

function resolvedTheaterOf(
  theater: ProjectTheaterIR,
  path: string,
  duplicate: boolean,
): ResolvedTheater | null {
  const resolution = theater.targetResolution;
  if (resolution === null) return null;
  return {
    theaterId: theater.theaterId,
    fileId: theater.fileId,
    ordinal: theater.ordinal,
    origin: theater.origin,
    rawTarget: theater.theater.target.raw,
    location: theater.theater.location,
    time: theater.theater.time,
    canonicalId: resolution.canonicalId,
    resolution,
    sourceArgs: theater.sourceArgs,
    engineFunctionName: resolution.functionName,
    callSignature: resolution.descriptor?.callSignature ?? null,
    sourceSpan: theater.theater.target.span,
    duplicate,
  };
}

function duplicateDiagnosticsOf(
  duplicateFacts: readonly TheaterDuplicateFact[],
  pathById: ReadonlyMap<string, string>,
): readonly ProjectDiagnostic[] {
  return duplicateFacts.map((fact) => {
    const primaryPath = pathById.get(fact.primary.fileId) ?? '';
    return {
      kind: 'duplicate-theater',
      code: 'core/target/duplicate-theater',
      severity: 'error',
      message:
        `exact duplicate：目标 ${fact.key.canonicalTargetId} 在相同地点/时间键上出现 ` +
        `${fact.related.length + 1} 次。` +
        `（engineFunctionName=${fact.key.engineFunctionName ?? 'null'}）`,
      primary: locationOf(fact.primary, primaryPath, sourceSpanOf(fact.primary), 'conflict'),
      related: fact.related.map((theater) =>
        locationOf(theater, pathById.get(theater.fileId) ?? '', sourceSpanOf(theater), 'conflict'),
      ),
    };
  });
}

/**
 * P4：静态链接。
 *
 * 先解析目标，再按 canonicalId 分组；exact duplicate 产生 primary/related 诊断；
 * unknown/unsupported 不进 groups，但仍保留在 linkedProject.theaters 中。
 */
export function linkProject(projectIR: ProjectIR, registry: TargetRegistry): ProjectLinkResult {
  const resolvedIR = resolveProjectTargets(projectIR, registry);
  const pathById = new Map(resolvedIR.files.map((file) => [file.fileId, file.path]));

  // P1-4 收尾：先算 duplicate 事实（按 canonical + 五字段 + engineFunctionName），
  // 再把「是否重复」标到每个 ResolvedTheater 上；K12 重复不影响 K13 的状态。
  const duplicateBuckets = new Map<string, ProjectTheaterIR[]>();
  for (const theater of resolvedIR.theaters) {
    const key = exactTheaterKeyOf(theater);
    if (key === null) continue;
    const text = exactKeyText(key);
    const bucket = duplicateBuckets.get(text) ?? [];
    bucket.push(theater);
    duplicateBuckets.set(text, bucket);
  }

  const duplicateFacts: TheaterDuplicateFact[] = [];
  for (const bucket of duplicateBuckets.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort(compareTheaters);
    const primary = sorted[0];
    if (primary === undefined) continue;
    const related = sorted.slice(1);
    const key = exactTheaterKeyOf(primary);
    if (key === null) continue;
    duplicateFacts.push({ key, primary, related });
  }
  duplicateFacts.sort((a, b) => compareText(exactKeyText(a.key), exactKeyText(b.key)));

  const duplicateTheaterIds = new Set<string>();
  for (const fact of duplicateFacts) {
    duplicateTheaterIds.add(fact.primary.theaterId);
    for (const theater of fact.related) duplicateTheaterIds.add(theater.theaterId);
  }

  const resolvedTheaters: ResolvedTheater[] = [];
  for (const theater of [...resolvedIR.theaters].sort(compareTheaters)) {
    const resolved = resolvedTheaterOf(
      theater,
      pathById.get(theater.fileId) ?? '',
      duplicateTheaterIds.has(theater.theaterId),
    );
    if (resolved !== null) resolvedTheaters.push(resolved);
  }

  const groupMap = new Map<string, ResolvedTheater[]>();
  for (const theater of resolvedTheaters) {
    if (theater.canonicalId === null) continue;
    const status = theater.resolution.status;
    if (status !== 'supported') continue;
    const group = groupMap.get(theater.canonicalId) ?? [];
    group.push(theater);
    groupMap.set(theater.canonicalId, group);
  }
  const groups: LinkedTheaterGroup[] = [...groupMap.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([canonicalId, theaters]) => {
      const duplicateFunctionNames = [
        ...new Set(
          theaters
            .filter((theater) => theater.duplicate)
            .map((theater) => theater.engineFunctionName.name)
            .filter((name): name is string => name !== null && name.length > 0),
        ),
      ].sort(compareText);
      return {
        canonicalId,
        theaters,
        duplicate: duplicateFunctionNames.length > 0,
        duplicateFunctionNames,
      };
    });

  const groupedTheaterIds = new Set<string>();
  for (const group of groups) {
    for (const theater of group.theaters) groupedTheaterIds.add(theater.theaterId);
  }
  const linkedIR: ProjectIR = {
    ...resolvedIR,
    theaters: resolvedIR.theaters.map((theater) => {
      if (duplicateTheaterIds.has(theater.theaterId)) {
        return { ...theater, linkStatus: 'duplicate' as const };
      }
      if (groupedTheaterIds.has(theater.theaterId)) {
        return { ...theater, linkStatus: 'grouped' as const };
      }
      return theater;
    }),
  };

  const diagnostics = sortProjectDiagnostics(duplicateDiagnosticsOf(duplicateFacts, pathById));
  return {
    projectIR: linkedIR,
    linkedProject: {
      projectId: resolvedIR.projectId,
      provenance: resolvedIR.provenance,
      runtimeMatchPolicy: registry.runtimeMatchPolicy ?? null,
      groups,
      theaters: resolvedTheaters,
      diagnostics,
    },
  };
}