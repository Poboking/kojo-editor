/**
 * M3 运行时选择 → Host 可见问题行。
 *
 * 只做纯映射：Ambiguous / NoMatch / NotLinked 必须出现在宿主问题面，不能被静默吞掉。
 */
import type { RuntimeSelection } from "@kojo/kojo-core";

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
