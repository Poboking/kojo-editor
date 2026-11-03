/**
 * M3 Runtime Matcher（第一阶段）：location/time 静态候选选择。
 *
 * 边界：
 * - 输入是 M2 `LinkedProject` + 运行时已规范化的 canonical target / location / time；
 * - 只做原始字面匹配与特异性比较，不做地点/时间别名、区间、继承或文本猜测；
 * - 不生成最终 dispatch ERB，不回写 canonical target / registry 版本 / exact duplicate 键；
 * - 不拿文件枚举顺序或源文件顺序当运行时优先级。
 *
 * 匹配规则（ADR-0012）：
 * - location.kind = unrestricted：任意运行时地点都匹配；
 * - location.kind = exact：运行时地点必须非 null 且与 raw 逐字相等；
 * - time.kind = unrestricted：任意运行时时间都匹配；
 * - time.kind = named：运行时时间必须非 null 且与 raw 逐字相等。
 *
 * 特异性是总序：exact location (2) > unrestricted location (0)；
 * named time (1) > unrestricted time (0)。总分 0–3，分数相同只能来自同一种
 * kind 组合；M2 exact duplicate 已保证同 raw 同组合不会重复，因此正常项目只会在
 * 防御性脏输入上出现 ambiguous。
 */
import type { KojoSpan } from '../ast.js';
import type { LinkedProject, ResolvedTheater } from './ir.js';
import type { ProjectFileId, TheaterId } from './identity.js';
import { compareNullableSpan, compareText } from './ordering.js';
import {
  runtimeLocationMatches,
  runtimeTimeMatches,
  type RuntimeMatchPolicy,
} from '../runtime-policy.js';

export type RuntimeSelectionStatus = 'selected' | 'no-match' | 'ambiguous' | 'not-linked';

export type RuntimeSelectionDiagnosticCode =
  | 'runtime/not-linked'
  | 'runtime/duplicate-group'
  | 'runtime/no-match'
  | 'runtime/ambiguous';

export interface RuntimeSelectionRequest {
  readonly linkedProject: LinkedProject;
  readonly canonicalId: string;
  readonly location: string | null;
  readonly time: string | null;
  /** 可选：Host 提供的地点层级/别名 tags。 */
  readonly locationTags?: readonly string[];
  /** 可选：Host 提供的时间别名 tags。 */
  readonly timeTags?: readonly string[];
  /** 可选：运行时时辰数值（eraTW: TIME:2）。 */
  readonly timeValue?: number | null;
  /** 可选覆盖；缺省读 LinkedProject.runtimeMatchPolicy。 */
  readonly runtimeMatchPolicy?: RuntimeMatchPolicy | null;
}

export interface RuntimeMatchCandidate {
  readonly theaterId: TheaterId;
  readonly fileId: ProjectFileId;
  readonly ordinal: number;
  readonly locationKind: 'unrestricted' | 'exact';
  readonly locationRaw: string;
  readonly timeKind: 'unrestricted' | 'named';
  readonly timeRaw: string;
  readonly specificity: number;
  readonly sourceSpan: KojoSpan;
}

export interface RuntimeSelectionDiagnostic {
  readonly code: RuntimeSelectionDiagnosticCode;
  readonly message: string;
  readonly canonicalId: string;
  readonly candidateTheaterIds: readonly TheaterId[];
}

export interface RuntimeSelection {
  readonly status: RuntimeSelectionStatus;
  readonly canonicalId: string;
  readonly selected: ResolvedTheater | null;
  readonly candidates: readonly RuntimeMatchCandidate[];
  readonly diagnostics: readonly RuntimeSelectionDiagnostic[];
}

const LOCATION_SCORE = { unrestricted: 0, exact: 2 } as const;
const TIME_SCORE = { unrestricted: 0, named: 1 } as const;

function locationMatches(
  policy: RuntimeMatchPolicy | null,
  theater: ResolvedTheater,
  request: RuntimeSelectionRequest,
): boolean {
  if (theater.location.kind === 'unrestricted') return true;
  return runtimeLocationMatches(policy, theater.location.raw, {
    raw: request.location,
    tags: request.locationTags,
  });
}

function timeMatches(
  policy: RuntimeMatchPolicy | null,
  theater: ResolvedTheater,
  request: RuntimeSelectionRequest,
): boolean {
  if (theater.time.kind === 'unrestricted') return true;
  return runtimeTimeMatches(policy, theater.time.raw, {
    raw: request.time,
    tags: request.timeTags,
    value: request.timeValue,
  });
}

function candidateOf(theater: ResolvedTheater): RuntimeMatchCandidate {
  return {
    theaterId: theater.theaterId,
    fileId: theater.fileId,
    ordinal: theater.ordinal,
    locationKind: theater.location.kind,
    locationRaw: theater.location.raw,
    timeKind: theater.time.kind,
    timeRaw: theater.time.raw,
    specificity: LOCATION_SCORE[theater.location.kind] + TIME_SCORE[theater.time.kind],
    sourceSpan: theater.sourceSpan,
  };
}

function diagnostic(
  code: RuntimeSelectionDiagnosticCode,
  message: string,
  canonicalId: string,
  candidateTheaterIds: readonly TheaterId[],
): RuntimeSelectionDiagnostic {
  return { code, message, canonicalId, candidateTheaterIds };
}

function compareCandidates(a: RuntimeMatchCandidate, b: RuntimeMatchCandidate): number {
  return (
    b.specificity - a.specificity ||
    compareText(a.fileId, b.fileId) ||
    compareNullableSpan(a.sourceSpan, b.sourceSpan) ||
    compareText(a.theaterId, b.theaterId)
  );
}

function emptySelection(
  status: Exclude<RuntimeSelectionStatus, 'selected'>,
  canonicalId: string,
  candidates: readonly RuntimeMatchCandidate[],
  diagnostics: readonly RuntimeSelectionDiagnostic[],
): RuntimeSelection {
  return { status, canonicalId, selected: null, candidates, diagnostics };
}

/**
 * 从 LinkedProject 的静态候选组里选唯一 Theater。
 *
 * 返回值只是 M3 选择结果，不是最终 dispatch ERB；调用方仍需自行把 selected 编排成
 * backend 可消费的 dispatch plan。selected 不按文件顺序决胜，只允许唯一最高特异性。
 */
export function selectRuntimeTheater(request: RuntimeSelectionRequest): RuntimeSelection {
  const group = request.linkedProject.groups.find(
    (candidate) => candidate.canonicalId === request.canonicalId,
  );
  if (group === undefined) {
    return emptySelection('not-linked', request.canonicalId, [], [
      diagnostic(
        'runtime/not-linked',
        `canonical target ${request.canonicalId} 不在 LinkedProject.groups 中（未链接或不支持）。`,
        request.canonicalId,
        [],
      ),
    ]);
  }
  if (group.duplicate) {
    return emptySelection('not-linked', request.canonicalId, [], [
      diagnostic(
        'runtime/duplicate-group',
        `canonical target ${request.canonicalId} 的候选组被标记为 exact duplicate，拒绝从失败链接结果选择。`,
        request.canonicalId,
        group.theaters.map((theater) => theater.theaterId),
      ),
    ]);
  }

  const policy = request.runtimeMatchPolicy ?? request.linkedProject.runtimeMatchPolicy ?? null;
  const matched = group.theaters
    .filter((theater) => theater.resolution.status === 'supported')
    .filter((theater) => theater.engineFunctionName.kind === 'resolved')
    .filter((theater) => locationMatches(policy, theater, request))
    .filter((theater) => timeMatches(policy, theater, request))
    .map(candidateOf)
    .sort(compareCandidates);

  if (matched.length === 0) {
    return emptySelection('no-match', request.canonicalId, [], [
      diagnostic(
        'runtime/no-match',
        `canonical target ${request.canonicalId} 没有匹配 location=${String(request.location)} / time=${String(request.time)} 的 Theater。`,
        request.canonicalId,
        [],
      ),
    ]);
  }

  const top = matched[0];
  if (top === undefined) {
    return emptySelection('no-match', request.canonicalId, [], [
      diagnostic('runtime/no-match', '候选列表非空但无法取出最高特异性。', request.canonicalId, []),
    ]);
  }
  const best = matched.filter((candidate) => candidate.specificity === top.specificity);
  if (best.length > 1) {
    return emptySelection('ambiguous', request.canonicalId, matched, [
      diagnostic(
        'runtime/ambiguous',
        `canonical target ${request.canonicalId} 有 ${best.length} 个同特异性候选，拒绝按文件顺序决胜。`,
        request.canonicalId,
        best.map((candidate) => candidate.theaterId),
      ),
    ]);
  }

  const selected = group.theaters.find((theater) => theater.theaterId === top.theaterId) ?? null;
  if (selected === null) {
    return emptySelection('no-match', request.canonicalId, matched, [
      diagnostic('runtime/no-match', '最高特异性候选在 LinkedProject 中无法重新定位。', request.canonicalId, []),
    ]);
  }
  return {
    status: 'selected',
    canonicalId: request.canonicalId,
    selected,
    candidates: matched,
    diagnostics: [],
  };
}