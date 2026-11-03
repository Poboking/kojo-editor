/**
 * M3 运行时选择 → Host 可见问题行。
 *
 * 只做纯映射：Ambiguous / NoMatch / NotLinked 必须出现在宿主问题面，不能被静默吞掉。
 */
import {
  selectRuntimeTheater,
  type RuntimeSelection,
  type RuntimeSelectionRequest,
} from '@kojo/kojo-core';

export interface Kojo2RuntimeProblem {
  readonly severity: "error";
  readonly code: string;
  readonly message: string;
  readonly canonicalId: string;
  readonly candidateTheaterIds: readonly string[];
}

export function kojo2RuntimeSelectionProblems(
  selection: RuntimeSelection,
): readonly Kojo2RuntimeProblem[] {
  return selection.diagnostics.map((diagnostic) => ({
    severity: "error" as const,
    code: diagnostic.code,
    message: diagnostic.message,
    canonicalId: diagnostic.canonicalId,
    candidateTheaterIds: diagnostic.candidateTheaterIds,
  }));
}
export interface Kojo2RuntimeResolution {
  readonly selection: RuntimeSelection;
  readonly problems: readonly Kojo2RuntimeProblem[];
}

/** Host 运行时选择入口：选择与可见诊断一次返回，避免调用方只拿 selected 吞掉失败。 */
export function resolveKojo2RuntimeSelection(
  request: RuntimeSelectionRequest,
): Kojo2RuntimeResolution {
  const selection = selectRuntimeTheater(request);
  return { selection, problems: kojo2RuntimeSelectionProblems(selection) };
}
