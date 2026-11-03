import { describe, expect, it } from "vitest";
import type { RuntimeSelection } from "@kojo/kojo-core";
import { kojo2RuntimeSelectionProblems } from "../src/ui/kojo2-runtime-diagnostics";

describe("kojo2RuntimeSelectionProblems", () => {
  it("selected 不产问题", () => {
    const selection = {
      status: "selected",
      canonicalId: "eratw.event.初见",
      selected: null,
      candidates: [],
      diagnostics: [],
    } as unknown as RuntimeSelection;
    expect(kojo2RuntimeSelectionProblems(selection)).toEqual([]);
  });

  it("ambiguous/no-match/not-linked 都映射为可见 error", () => {
    const selection = {
      status: "ambiguous",
      canonicalId: "eratw.event.初见",
      selected: null,
      candidates: [],
      diagnostics: [
        { code: "runtime/ambiguous", message: "两个候选同特异性", canonicalId: "eratw.event.初见", candidateTheaterIds: ["t1", "t2"] },
        { code: "runtime/no-match", message: "没有候选", canonicalId: "eratw.event.初见", candidateTheaterIds: [] },
        { code: "runtime/not-linked", message: "未链接", canonicalId: "eratw.event.初见", candidateTheaterIds: [] },
      ],
    } as unknown as RuntimeSelection;
    const problems = kojo2RuntimeSelectionProblems(selection);
    expect(problems.map((problem) => problem.code)).toEqual(["runtime/ambiguous", "runtime/no-match", "runtime/not-linked"]);
    expect(problems.every((problem) => problem.severity === "error")).toBe(true);
    expect(problems[0]?.candidateTheaterIds).toEqual(["t1", "t2"]);
  });
});
