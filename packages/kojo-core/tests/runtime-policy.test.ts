import { describe, expect, it } from "vitest";
import {
  expandRuntimeTokens,
  runtimeBranchConditions,
  runtimeLocationMatches,
  runtimeTimeMatches,
  validateRuntimeMatchPolicy,
  type RuntimeMatchPolicy,
} from "../src/runtime-policy.js";

const POLICY: RuntimeMatchPolicy = {
  id: "test.policy",
  locationAliases: { "博麗神社": ["神社"] },
  locationParents: { 大図書館: ["紅魔館"] },
  timeParents: { 夜晚: ["夜"], 清晨: ["早朝"] },
  timeValues: { 早朝: [1], 夜: [6] },
  timeRanges: { 白天: [{ min: 2, max: 4 }] },
};

describe("runtime match policy", () => {
  it("地点别名双向、父级继承", () => {
    expect(expandRuntimeTokens("神社", POLICY.locationAliases, POLICY.locationParents)).toEqual(["博麗神社", "神社"]);
    expect(runtimeLocationMatches(POLICY, "博麗神社", { raw: "神社" })).toBe(true);
    expect(runtimeLocationMatches(POLICY, "紅魔館", { raw: "大図書館", tags: ["紅魔館"] })).toBe(true);
  });

  it("时间别名、继承、数值与区间", () => {
    expect(runtimeTimeMatches(POLICY, "夜", { raw: "夜晚" })).toBe(true);
    expect(runtimeTimeMatches(POLICY, "早朝", { raw: "清晨" })).toBe(true);
    expect(runtimeTimeMatches(POLICY, "白天", { raw: null, value: 3 })).toBe(true);
    expect(runtimeTimeMatches(POLICY, "夜", { raw: null, value: 3 })).toBe(false);
  });

  it("dispatch 条件与 matcher 共用展开", () => {
    const conditions = runtimeBranchConditions(POLICY, { kind: "exact", raw: "神社" }, { kind: "named", raw: "夜晚" });
    expect(conditions.location).toEqual([
      { kind: "location-equals", value: "博麗神社" },
      { kind: "location-equals", value: "神社" },
    ]);
    expect(conditions.time).toEqual([{ kind: "time-equals", value: 6 }]);
  });

  it("策略结构校验 fail-closed", () => {
    expect(validateRuntimeMatchPolicy(POLICY)).toEqual([]);
    const issues = validateRuntimeMatchPolicy({
      id: "bad",
      timeValues: { 夜: [] },
      timeRanges: { 白天: [{ min: 5, max: 2 }] },
    });
    expect(issues.some((issue) => issue.includes("timeValues.夜"))).toBe(true);
    expect(issues.some((issue) => issue.includes("min > max"))).toBe(true);
  });
});
