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

## Dispatch ERB（第三阶段）

- core `KojoEmitBackend` additive `renderDispatch?(request: DispatchRenderRequest)`。
- `DispatchRenderRequest` 携带 canonicalId、已解析主函数名、事件绑定、实参、按 specificity 排序的 branches；每个 branch 带已降糖 body/slots 与 location/time facts。
- `compileProject` 新增 `dispatchErb` / `dispatchDiagnostics` / `dispatchBackendDiagnostics` / `dispatchComplete`。
- `requireDispatch?: boolean`：缺省 false 保持 M2 后端兼容；true 时 dispatch 渲染失败令 build failed，且不发布 theaterErb / dispatchErb 半成品。
- eraTW `renderDispatch` 由 Host 显式注入 `dispatchSelectors: { locationExpr, timeExpr }`；缺 selector 且存在 exact/named 分支即 fail-closed，不猜引擎变量名。
- 同一 canonical target 按 **functionName** 拆分 dispatch target，避免不同角色/家族函数被错误合并。

## Host selector 注入（第四阶段）

- `ProjectCompileInput.dispatchSelectors?: DispatchSelectors`：Host 统一注入 `locationExpr` / `timeExpr`。
- `compileKojo2Project` 同样接受 `dispatchSelectors` / `requireDispatch` 并原样转给 core。
- `DispatchRenderRequest.selectors` 是 Host 事实；adapter 只能消费，不得自己补默认变量名。
- 旧 `createEratwEmitBackend({ dispatchSelectors })` 仅保留为兼容回退；新调用应走项目编译输入。
- 真实 eraTW selector 仍未被仓内证据证明；生产调用必须先显式配置，缺失时 M3 dispatch 保持 fail-closed。
