/**
 * M3 Dispatch Plan（第二阶段）：把 M2 候选组转成确定性的运行时分派计划。
 *
 * 边界：
 * - 输入是 M2 `LinkedProject`；只输出纯数据计划，不生成最终 ERB；
 * - 分支顺序只按 specificity + 稳定诊断键排序，不把文件枚举顺序当运行时优先级；
 * - duplicate / 无可用 Theater 的组产生阻断诊断，不静默丢弃；
 * - adapter 专用运行时变量、地点/时间别名与最终 ERB 渲染仍属于后续 M3 批次。
 */
import type { KojoSpan } from '../ast.js';
import type { LinkedProject, ResolvedTheater } from './ir.js';
import type { ProjectFileId, TheaterId } from './identity.js';
import { compareNullableSpan, compareText } from './ordering.js';
import {
  runtimeBranchConditions,
  type RuntimeBranchConditions,
  type RuntimeMatchPolicy,
} from '../runtime-policy.js';

export type DispatchPlanStatus = 'ready' | 'blocked';

export type DispatchPlanDiagnosticCode =
  | 'dispatch/duplicate-group'
  | 'dispatch/no-supported-theater';

export interface DispatchBranch {
  readonly theaterId: TheaterId;
  readonly fileId: ProjectFileId;
  readonly ordinal: number;
  readonly origin: 'theater' | 'legacy-machine';
  readonly functionName: string;
  readonly locationKind: 'unrestricted' | 'exact';
  readonly locationRaw: string;
  readonly timeKind: 'unrestricted' | 'named';
  readonly timeRaw: string;
  readonly specificity: number;
  /** M3：由 runtimeMatchPolicy 展开的 OR 条件组；renderer 直接用。 */
  readonly conditions: RuntimeBranchConditions;
  readonly sourceSpan: KojoSpan;
}

export interface DispatchTargetPlan {
  /** canonicalId + functionName；同一 canonical target 可按角色/家族函数名拆成多个计划。 */
  readonly dispatchKey: string;
  readonly canonicalId: string;
  readonly functionName: string;
  readonly duplicate: boolean;
  readonly branches: readonly DispatchBranch[];
}

export interface DispatchPlanDiagnostic {
  readonly code: DispatchPlanDiagnosticCode;
  readonly message: string;
  readonly canonicalId: string;
  readonly candidateTheaterIds: readonly TheaterId[];
}

export interface ProjectDispatchPlan {
  readonly projectId: string;
  readonly status: DispatchPlanStatus;
  readonly targets: readonly DispatchTargetPlan[];
  readonly diagnostics: readonly DispatchPlanDiagnostic[];
}

const LOCATION_SCORE = { unrestricted: 0, exact: 2 } as const;
const TIME_SCORE = { unrestricted: 0, named: 1 } as const;

function branchOf(policy: RuntimeMatchPolicy | null, theater: ResolvedTheater): DispatchBranch | null {
  if (theater.resolution.status !== 'supported') return null;
  if (theater.engineFunctionName.kind !== 'resolved') return null;
  const name = theater.engineFunctionName.name;
  if (name === null) return null;
  return {
    theaterId: theater.theaterId,
    fileId: theater.fileId,
    ordinal: theater.ordinal,
    origin: theater.origin,
    functionName: name,
    locationKind: theater.location.kind,
    locationRaw: theater.location.raw,
    timeKind: theater.time.kind,
    timeRaw: theater.time.raw,
    specificity: LOCATION_SCORE[theater.location.kind] + TIME_SCORE[theater.time.kind],
    conditions: runtimeBranchConditions(policy, theater.location, theater.time),
    sourceSpan: theater.sourceSpan,
  };
}

function compareBranches(a: DispatchBranch, b: DispatchBranch): number {
  return (
    b.specificity - a.specificity ||
    compareText(a.fileId, b.fileId) ||
    compareNullableSpan(a.sourceSpan, b.sourceSpan) ||
    compareText(a.theaterId, b.theaterId)
  );
}

function diagnostic(
  code: DispatchPlanDiagnosticCode,
  message: string,
  canonicalId: string,
  candidateTheaterIds: readonly TheaterId[],
): DispatchPlanDiagnostic {
  return { code, message, canonicalId, candidateTheaterIds };
}

/**
 * 由 LinkedProject 生成项目级 dispatch plan。
 *
 * `targets` 按 canonicalId 排序；每个 target 的 branches 按 specificity 降序，
 * 再按 fileId/span/theaterId 稳定排序。该排序是计划枚举顺序，不是运行时优先级。
 */
export function buildProjectDispatchPlan(
  linkedProject: LinkedProject,
  policy: RuntimeMatchPolicy | null = linkedProject.runtimeMatchPolicy ?? null,
): ProjectDispatchPlan {
  const targets: DispatchTargetPlan[] = [];
  const diagnostics: DispatchPlanDiagnostic[] = [];

  for (const group of linkedProject.groups) {
    const allBranches = group.theaters
      .map((theater) => branchOf(policy, theater))
      .filter((branch): branch is DispatchBranch => branch !== null);
    const byFunction = new Map<string, DispatchBranch[]>();
    for (const branch of allBranches) {
      const bucket = byFunction.get(branch.functionName);
      if (bucket === undefined) byFunction.set(branch.functionName, [branch]);
      else bucket.push(branch);
    }
    for (const [functionName, branches] of byFunction) {
      targets.push({
        dispatchKey: group.canonicalId + '\u0000' + functionName,
        canonicalId: group.canonicalId,
        functionName,
        duplicate: group.duplicate,
        branches: branches.sort(compareBranches),
      });
    }
    if (group.duplicate) {
      diagnostics.push(
        diagnostic(
          'dispatch/duplicate-group',
          `canonical target ${group.canonicalId} 的候选组是 exact duplicate，拒绝生成 dispatch 计划。`,
          group.canonicalId,
          group.theaters.map((theater) => theater.theaterId),
        ),
      );
    } else if (allBranches.length === 0) {
      diagnostics.push(
        diagnostic(
          'dispatch/no-supported-theater',
          `canonical target ${group.canonicalId} 没有可分派的 supported Theater。`,
          group.canonicalId,
          group.theaters.map((theater) => theater.theaterId),
        ),
      );
    }
  }

  targets.sort((a, b) => compareText(a.dispatchKey, b.dispatchKey));
  return {
    projectId: linkedProject.projectId,
    status: diagnostics.length === 0 ? 'ready' : 'blocked',
    targets,
    diagnostics,
  };
}

/** 按 canonical target + 可选 functionName 取计划；多个同 canonical 计划且未点名函数名时不猜。 */
export function dispatchTargetPlanOf(
  plan: ProjectDispatchPlan,
  canonicalId: string,
  functionName?: string,
): DispatchTargetPlan | null {
  const matches = plan.targets.filter(
    (target) =>
      target.canonicalId === canonicalId &&
      (functionName === undefined || target.functionName === functionName),
  );
  const only = matches[0];
  return matches.length === 1 && only !== undefined ? only : null;
}
