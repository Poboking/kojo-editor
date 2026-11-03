/**
 * M3 Dispatch Plan（第二阶段）：把 M2 候选组转成确定性的运行时分派计划。
 *
 * 边界：
 * - 输入是 M2 `LinkedProject`；只输出纯数据计划，不生成最终 ERB；
 * - 分支顺序只按 specificity + 稳定诊断键排序，不把文件枚举顺序当运行时优先级；
 * - duplicate / 无可用 Theater 的组产生阻断诊断，不静默丢弃；
 * - **P1-1**：同特异性分支若在 policy 展开后可能同时命中，matcher 会判 ambiguous，
 *   plan 必须同样拒绝该 target（`dispatch/ambiguous-branches`），不得让渲染器按
 *   fileId/文件顺序静默决胜；
 * - **P1-2**：legacy-machine 的 ERB 由 M1 单文件路径负责，不进入需要 lowering unit 的
 *   dispatch 渲染；只产生 warning 级 `dispatch/legacy-machine-skipped`，不拖垮其它 target。
 * - adapter 专用运行时变量、地点/时间别名与最终 ERB 渲染由渲染端口负责。
 */
import type { KojoSpan } from '../ast.js';
import type { LinkedProject, ResolvedTheater } from './ir.js';
import type { ProjectFileId, TheaterId } from './identity.js';
import { compareNullableSpan, compareText } from './ordering.js';
import {
  runtimeBranchConditions,
  type RuntimeBranchConditions,
  type RuntimeCondition,
  type RuntimeMatchPolicy,
  type RuntimeTimeRange,
} from '../runtime-policy.js';

export type DispatchPlanStatus = 'ready' | 'blocked';

export type DispatchPlanDiagnosticCode =
  | 'dispatch/duplicate-group'
  | 'dispatch/no-supported-theater'
  | 'dispatch/ambiguous-branches'
  | 'dispatch/legacy-machine-skipped';

export interface DispatchBranch {
  readonly theaterId: TheaterId;
  readonly fileId: ProjectFileId;
  readonly ordinal: number;
  readonly origin: 'theater' | 'legacy-machine';
  readonly functionName: string;
  /** P1-4 收尾：该分支来自 exact duplicate 定义（只阻断同 functionName，不连带整组）。 */
  readonly duplicate: boolean;
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
  /**
   * `blocked` 的 target 不得渲染：它的分支会产生歧义或来源不可发布
   * （duplicate / 同特异性条件重叠）。诊断在 plan.diagnostics 里，不静默。
   */
  readonly status: 'ready' | 'blocked';
  readonly branches: readonly DispatchBranch[];
}

export interface DispatchPlanDiagnostic {
  readonly code: DispatchPlanDiagnosticCode;
  /** error 使 plan.status=blocked；warning 只作可见提示（如 legacy 跳过），不阻断。 */
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly canonicalId: string;
  /** 与 target 同口径的函数名；组级诊断（legacy 跳过）为 null。 */
  readonly functionName: string | null;
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
    duplicate: theater.duplicate,
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

/* ============================== 歧义检测（P1-1） ============================== */

interface TimeConditionFacts {
  readonly unrestricted: boolean;
  /** 无法数值化的时辰名条件：渲染端会 fail-closed；检测端保守视为可能与任何时间重叠。 */
  readonly raw: boolean;
  readonly values: ReadonlySet<number>;
  readonly ranges: readonly RuntimeTimeRange[];
}

function timeFacts(conditions: readonly RuntimeCondition[]): TimeConditionFacts {
  if (conditions.length === 0) {
    return { unrestricted: true, raw: false, values: new Set(), ranges: [] };
  }
  const values = new Set<number>();
  const ranges: RuntimeTimeRange[] = [];
  let raw = false;
  for (const condition of conditions) {
    if (condition.kind === 'time-equals') values.add(condition.value);
    else if (condition.kind === 'time-range') ranges.push({ min: condition.min, max: condition.max });
    else raw = true;
  }
  return { unrestricted: false, raw, values, ranges };
}

function locationValues(conditions: readonly RuntimeCondition[]): ReadonlySet<string> | null {
  if (conditions.length === 0) return null; // null = 不限，任意地点都命中
  const values = new Set<string>();
  for (const condition of conditions) {
    if (condition.kind === 'location-equals') values.add(condition.value);
  }
  return values;
}

function locationsOverlap(a: RuntimeBranchConditions, b: RuntimeBranchConditions): boolean {
  const left = locationValues(a.location);
  const right = locationValues(b.location);
  if (left === null || right === null) return true;
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function timesOverlap(a: RuntimeBranchConditions, b: RuntimeBranchConditions): boolean {
  const left = timeFacts(a.time);
  const right = timeFacts(b.time);
  if (left.unrestricted || right.unrestricted) return true;
  // 未登记为数值的时辰名由渲染端 fail-closed；这里保守判重叠，不替作者猜数值。
  if (left.raw || right.raw) return true;
  for (const value of left.values) {
    if (right.values.has(value)) return true;
    if (right.ranges.some((range) => value >= range.min && value <= range.max)) return true;
  }
  for (const value of right.values) {
    if (left.ranges.some((range) => value >= range.min && value <= range.max)) return true;
  }
  for (const first of left.ranges) {
    for (const second of right.ranges) {
      if (first.max >= second.min && second.max >= first.min) return true;
    }
  }
  return false;
}

/** 两条分支在 policy 展开后是否可能对同一个运行时 (location, time) 同时命中。 */
export function dispatchBranchesOverlap(a: DispatchBranch, b: DispatchBranch): boolean {
  return locationsOverlap(a.conditions, b.conditions) && timesOverlap(a.conditions, b.conditions);
}

interface AmbiguousPair {
  readonly specificity: number;
  readonly branches: readonly [DispatchBranch, DispatchBranch];
}

/** 同特异性内任意两条可能同时命中的分支 = Ambiguous。 */
function ambiguousPairsOf(branches: readonly DispatchBranch[]): readonly AmbiguousPair[] {
  const bySpecificity = new Map<number, DispatchBranch[]>();
  for (const branch of branches) {
    const bucket = bySpecificity.get(branch.specificity);
    if (bucket === undefined) bySpecificity.set(branch.specificity, [branch]);
    else bucket.push(branch);
  }
  const pairs: AmbiguousPair[] = [];
  for (const [specificity, bucket] of [...bySpecificity.entries()].sort((a, b) => a[0] - b[0])) {
    for (let left = 0; left < bucket.length; left++) {
      for (let right = left + 1; right < bucket.length; right++) {
        const first = bucket[left];
        const second = bucket[right];
        if (first === undefined || second === undefined) continue;
        if (dispatchBranchesOverlap(first, second)) {
          pairs.push({ specificity, branches: [first, second] });
        }
      }
    }
  }
  return pairs;
}

/* ============================== 计划构造 ============================== */

function diagnostic(
  code: DispatchPlanDiagnosticCode,
  severity: 'error' | 'warning',
  message: string,
  canonicalId: string,
  functionName: string | null,
  candidateTheaterIds: readonly TheaterId[],
): DispatchPlanDiagnostic {
  return { code, severity, message, canonicalId, functionName, candidateTheaterIds };
}

/**
 * 由 LinkedProject 生成项目级 dispatch plan。
 *
 * `targets` 按 canonicalId 排序；每个 target 的 branches 按 specificity 降序，
 * 再按 fileId/span/theaterId 稳定排序。该排序是计划枚举顺序，不是运行时优先级：
 * 同特异性歧义在 plan 层就被 `dispatch/ambiguous-branches` 阻断，渲染器不会拿到
 * 可以让它按顺序决胜的 target。
 *
 * legacy-machine 分支不进入 targets（M1 单文件路径负责其 ERB），只产生 warning；
 * 因此混合项目里显式 Theater 的 dispatch 产物不会被 legacy 整体拖空。
 */
export function buildProjectDispatchPlan(
  linkedProject: LinkedProject,
  policy: RuntimeMatchPolicy | null = linkedProject.runtimeMatchPolicy ?? null,
): ProjectDispatchPlan {
  const targets: DispatchTargetPlan[] = [];
  const diagnostics: DispatchPlanDiagnostic[] = [];

  for (const group of linkedProject.groups) {
    const legacyTheaters = group.theaters.filter((theater) => theater.origin === 'legacy-machine');
    if (legacyTheaters.length > 0) {
      diagnostics.push(
        diagnostic(
          'dispatch/legacy-machine-skipped',
          'warning',
          `canonical target ${group.canonicalId} 的 ${legacyTheaters.length} 个 legacy-machine Theater 由 M1 单文件路径负责，不参与 M3 dispatch。`,
          group.canonicalId,
          null,
          legacyTheaters.map((theater) => theater.theaterId),
        ),
      );
    }

    const allBranches = group.theaters
      .filter((theater) => theater.origin === 'theater')
      .map((theater) => branchOf(policy, theater))
      .filter((branch): branch is DispatchBranch => branch !== null);
    const byFunction = new Map<string, DispatchBranch[]>();
    for (const branch of allBranches) {
      const bucket = byFunction.get(branch.functionName);
      if (bucket === undefined) byFunction.set(branch.functionName, [branch]);
      else bucket.push(branch);
    }

    for (const [functionName, branches] of byFunction) {
      const sorted = branches.sort(compareBranches);
      // P1-4 收尾：重复是函数级的——只有同 functionName 的 target 被阻断，K13 保持 ready。
      const duplicateBranches = sorted.filter((branch) => branch.duplicate);
      const hasDuplicate = duplicateBranches.length > 0;
      if (hasDuplicate) {
        diagnostics.push(
          diagnostic(
            'dispatch/duplicate-group',
            'error',
            `canonical target ${group.canonicalId}（函数 ${functionName}）存在 ${duplicateBranches.length} 个 exact duplicate 定义：该函数拒绝生成 dispatch，其它函数不受影响。`,
            group.canonicalId,
            functionName,
            duplicateBranches.map((branch) => branch.theaterId),
          ),
        );
      }
      // 已因 duplicate 阻断的 target 不再叠加歧义诊断（避免噪声与诊断顺序漂移）。
      const pairs = hasDuplicate ? [] : ambiguousPairsOf(sorted);
      if (pairs.length > 0) {
        const ids = new Set<TheaterId>();
        for (const pair of pairs) {
          ids.add(pair.branches[0].theaterId);
          ids.add(pair.branches[1].theaterId);
        }
        const specificities = [...new Set(pairs.map((pair) => pair.specificity))].sort((a, b) => a - b);
        diagnostics.push(
          diagnostic(
            'dispatch/ambiguous-branches',
            'error',
            `canonical target ${group.canonicalId}（函数 ${functionName}）有 ${pairs.length} 组同特异性（specificity=${specificities.join('/')}）且条件可能同时命中的分支：拒绝按 fileId / 文件顺序静默决胜。请消歧或改用更具体的 location/time。`,
            group.canonicalId,
            functionName,
            [...ids],
          ),
        );
      }
      targets.push({
        dispatchKey: group.canonicalId + '\u0000' + functionName,
        canonicalId: group.canonicalId,
        functionName,
        duplicate: hasDuplicate,
        status: hasDuplicate || pairs.length > 0 ? 'blocked' : 'ready',
        branches: sorted,
      });
    }

    if (!group.duplicate && allBranches.length === 0 && legacyTheaters.length === 0) {
      diagnostics.push(
        diagnostic(
          'dispatch/no-supported-theater',
          'error',
          `canonical target ${group.canonicalId} 没有可分派的 supported Theater。`,
          group.canonicalId,
          null,
          group.theaters.map((theater) => theater.theaterId),
        ),
      );
    }
  }

  targets.sort((a, b) => compareText(a.dispatchKey, b.dispatchKey));
  return {
    projectId: linkedProject.projectId,
    status: diagnostics.some((entry) => entry.severity === 'error') ? 'blocked' : 'ready',
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
