# Kojo 2.0 M3 实施记录（第一阶段）

> 状态：Runtime Matcher 纯选择核心已落地；最终 dispatch ERB、地点/时间别名与区间尚未实现。

## 已实现

- `packages/kojo-core/src/project/runtime-matcher.ts`
- `selectRuntimeTheater(request)`：从 `LinkedProject.groups` 选择唯一 Theater。
- 结果状态：`selected` / `no-match` / `ambiguous` / `not-linked`。
- 匹配只读 parser facts：`location.kind/raw` 与 `time.kind/raw`。
- 特异性：exact location = 2，named time = 1；最高分唯一才 selected。
- Ambiguous 不按 fileId / 源文件顺序 / ordinal 决胜。
- `ResolvedTheater` additive 携带 `location` / `time`，M3 不重新解析 `rawTarget`。

## 公开入口

```ts
import { selectRuntimeTheater } from "@kojo/kojo-core";

const result = selectRuntimeTheater({
  linkedProject,
  canonicalId: "eratw.event.初见",
  location: "神社",
  time: "夜晚",
});
```

## 边界

- 不生成最终 dispatch ERB。
- 不做地点/时间别名、trim、大小写折叠、区间、继承或 raw 文本猜测。
- 不回写 M2 canonical target、Registry 版本或 exact duplicate 键。
- `runtimeProtocol` 本阶段只保留为描述符事实，尚未执行 adapter 专用策略。

## 测试

- `packages/kojo-core/tests/runtime-matcher.test.ts`：纯选择矩阵。
- `packages/plugins/eratw-adapter/tests/kojo2/m3-runtime-matcher.test.ts`：与 `compileProject` 的端到端接缝。

## Dispatch Plan（第二阶段）

- `buildProjectDispatchPlan(linkedProject)`：把候选组转成确定性纯数据计划。
- `DispatchTargetPlan`：每个 canonical target 的分支表；`branches` 按 specificity 降序，再按 fileId/span/theaterId 稳定排序。
- `DispatchBranch`：携带 theaterId、functionName、location/time kind/raw、specificity、sourceSpan。
- duplicate 组阻断计划（`dispatch/duplicate-group`）；无 supported 分支也阻断（`dispatch/no-supported-theater`）。
- `dispatchTargetPlanOf(plan, canonicalId)`：按目标取计划。
- 本阶段仍不生成 ERB；adapter 运行时变量与最终 dispatch 渲染属于下一批。

## 当前未实现

- 最终 dispatch ERB 与 adapter 专用运行时变量绑定。
- 地点/时间别名、区间、继承。
- `runtimeProtocol.metadata` 的专用匹配策略。
