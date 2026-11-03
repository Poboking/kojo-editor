# Kojo 2.0 M3 实施记录（第一~七阶段）

> 状态：M3 全部阶段已落地——Runtime Matcher、Dispatch Plan、最终 dispatch ERB、Host selector、真实 selector、RuntimeMatchPolicy，以及 P1 修复（matcher/dispatch 歧义一致、legacy 边界、多角色身份）。

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

## 边界（第一阶段时点；后续阶段已扩展）

- 不生成最终 dispatch ERB。
- 不做地点/时间别名、trim、大小写折叠、区间、继承或 raw 文本猜测。
- 不回写 M2 canonical target、Registry 版本或 exact duplicate 键。
- `runtimeProtocol` 本阶段只保留为描述符事实，尚未执行 adapter 专用策略。

## 测试

- `packages/kojo-core/tests/runtime-matcher.test.ts`：纯选择矩阵 + dispatch plan 的歧义/legacy 边界。
- `packages/plugins/eratw-adapter/tests/kojo2/m3-runtime-matcher.test.ts`：与 `compileProject` 的端到端接缝 + P1-1/P1-2 回归。
- `packages/kojo-core/tests/multi-role.test.ts` / `packages/plugins/eratw-adapter/tests/kojo2/multi-role.test.ts`：多角色（P1-4）。
- `packages/kojo-core/tests/version-check.test.ts`：Adapter/Backend 版本轴（P1-3）。
- `packages/kojo-core/tests/duplicate-isolation.test.ts` / `packages/plugins/eratw-adapter/tests/kojo2/duplicate-isolation.test.ts`：多角色重复隔离（K12 红 / K13 绿）。
- `packages/kojo-core/tests/erb-assembly.test.ts` / `packages/plugins/eratw-adapter/tests/kojo2/erb-assembly.test.ts`：最终产物组装（dispatch 进 / theaterErb 不进 / legacy 显式传入）。

## Dispatch Plan（第二阶段）

- `buildProjectDispatchPlan(linkedProject)`：把候选组转成确定性纯数据计划。
- `DispatchTargetPlan`：每个 canonical target 的分支表；`branches` 按 specificity 降序，再按 fileId/span/theaterId 稳定排序。
- `DispatchBranch`：携带 theaterId、functionName、location/time kind/raw、specificity、sourceSpan。
- duplicate 组阻断计划（`dispatch/duplicate-group`）；无 supported 分支也阻断（`dispatch/no-supported-theater`）。
- `dispatchTargetPlanOf(plan, canonicalId)`：按目标取计划。
- 本阶段仍不生成 ERB；adapter 运行时变量与最终 dispatch 渲染属于下一批。

## 当前边界（P1 修复后）

- **legacy-machine**：不参与 M3 dispatch（其 ERB 由 M1 单文件路径负责，字节不变），plan 只给 warning `dispatch/legacy-machine-skipped`；matcher 仍可返回 legacy 选择结果，Host 需按 origin 走 M1 产物。
- **多角色**：同 canonical 不同 `engineFunctionName` 合法共存；matcher 需 Host 传 `engineFunctionName` 才能唯一选择，否则跨角色同条件按 ambiguous；dispatch 按 functionName 拆 target，`ProjectDispatchErb.functionName` 标识产物。
- 地点/时间别名、区间、继承由 `RuntimeMatchPolicy` 统一展开；未登记时辰名在 dispatch 侧 fail-closed。
- core 不写 ERB 关键字；最终字节归 adapter `renderDispatch`。

## 第七阶段：P1-1 / P1-2 一致性修复（2026-11-03）

### P1-1 Matcher 与 Dispatch 歧义一致

- `buildProjectDispatchPlan` 对同一 `canonicalId + functionName` 的分支按 specificity 分组；同组内任意两条经 policy 展开后 location 集合相交且 time 集合相交 ⇒ 该 target `status='blocked'`，产 error 级 `dispatch/ambiguous-branches`（携带 candidateTheaterIds、functionName、specificity）。
- 渲染端只接收 `status==='ready'` 的 target，因此不会按 fileId / 文件顺序静默决胜。`requireDispatch=true` 时 build failed 且不发布 theaterErb / dispatchErb 半成品；false 时其余 target 正常产出，该 target 无产物且诊断在 `dispatchDiagnostics` 可见。
- 不同 specificity 的条件重叠不阻断：matcher 取唯一最高分、dispatch 按 specificity 降序 first-match，两侧一致。
- 覆盖时间维度：`白天` 2–4 与 `全天` 1–7 区间重叠、`夜`/`夜晚` 展开后同条件等都会触发阻断。

### P1-2 Legacy 与 dispatch 边界

- `buildProjectDispatchPlan` 排除 `origin==='legacy-machine'` 的分支，只产 warning `dispatch/legacy-machine-skipped`；legacy 的 ERB 仍归 M1 单文件路径。
- 混合项目中 legacy 不会清空显式 target 的 `dispatchErb`；legacy-only 项目 + `requireDispatch=true` 不再静默 failed（没有可分派 target 即无 M3 dispatch 要求）。
- 渲染失败路径（缺 lowering unit / backend 无 `renderDispatch` / `EmitFailure`）都有显式诊断；单个 target 失败只跳过自身，不影响其它 target。

### P1-4 多角色身份（与 M2 D2 修订配套）

- `ProjectDispatchErb` 增加 `functionName`：同 canonical 多角色产出多份（K12/K13 各自可寻址）。
- `RuntimeSelectionRequest.engineFunctionName?` + `RuntimeMatchCandidate.engineFunctionName`：Host 有角色/函数身份时唯一选择；不传时行为不变（跨角色同条件 ambiguous）。

## 第八阶段：多角色重复隔离、产物组装与 Legacy 边界（2026-11-03 收尾）

### 多角色重复隔离（函数级，不再整组污染）

- additive：`ResolvedTheater.duplicate: boolean`（该 Theater 是否 exact duplicate 重复项）；`LinkedTheaterGroup.duplicateFunctionNames: readonly string[]`（有重复定义的引擎函数名；`group.duplicate` 保留为聚合兼容视图）。
- Matcher：候选过滤掉 duplicate；点名 `engineFunctionName` 时若该函数在 `duplicateFunctionNames` 中 → `not-linked` + `runtime/duplicate-group`（只拒绝该函数）；不点名时 K13 等合法函数正常参与唯一/ambiguous 选择；只有重复定义命中时给 duplicate 诊断而非 no-match。
- Dispatch plan：duplicate 只阻断**同 functionName** 的 target（`dispatch/duplicate-group` 携带 functionName）；K12 target blocked、K13 target ready；plan.status 仍因 error 为 blocked。
- `ProjectCompileResult.dispatchPlan` additive：构建失败时也可读（编辑器诊断视图）；`ProjectCompileInput.emitDiagnosticArtifacts?: boolean`（缺省 false）：构建失败时仍为 ready target 产出**诊断用** dispatchErb（不可发布，assembly 会判 incomplete）。
- 回归：`packages/kojo-core/tests/duplicate-isolation.test.ts`、`packages/plugins/eratw-adapter/tests/kojo2/duplicate-isolation.test.ts`。

### 最终产物组装（权威规则见 `docs/KOJO-2.0-ARTIFACT-ASSEMBLY.md`）

- 实现：`packages/kojo-core/src/project/erb-assembly.ts` 的 `planProjectErbAssembly(result)` / `assembleProjectErb({ result, legacyErb })`。
- `dispatchErb` = 最终运行时调度产物；`theaterErb` = 单 Theater 预览/兼容视图，**不进入最终组装**（直接拼接会重复定义运行时函数）。
- legacy-machine 的 ERB 由 M1 单文件路径产出，Host 必须显式传入 `legacyErb`；缺一条即 `assembly/legacy-missing`。
- 组装 `status==='complete'` 才可发布：build failed / plan error / dispatch 缺 target / legacy 缺失或未知 / 同一运行时函数重复 → `incomplete` + 诊断。

### Legacy 边界

- legacy-machine 不进入 M3 dispatch（plan warning `dispatch/legacy-machine-skipped`），其字节归 M1 单文件路径；matcher 仍可返回 legacy 选择结果，Host 应按 origin 走 M1 产物。
- 组装接口把「M1 供 legacy 文件 / M3 供显式 Theater」两条产物线合并；跳过 legacy ≠ 项目完整（assembly 判据兜底）。

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
- 真实 eraTW selector 已在第五阶段用语料取证；Host 应直接注入 `ERATW_DISPATCH_SELECTORS`，缺失时 M3 dispatch 仍保持 fail-closed。

## 真实语料 selector 取证（第五阶段）

语料：`D:\Game\eraTW4.981-261017-EAGLOV3`。

- 地点：`CFLAG:MASTER:現在位置` 是玩家地点 ID（`ANOTHER_TALK.ERB` / `COMMON.ERB` 大量使用）；
  `NAME_FROM_PLACE(PLACE_ID)` 是既有地点 ID → 地点名函数（`fromEN/LOCATIONS/LOCATION_PRINT.ERB`）。
  因此地点 selector 写为 `NAME_FROM_PLACE(CFLAG:MASTER:現在位置)`。
- 时间：`TIME:2` 是时辰带；`ERB/DIM.ERH:182` 明确 1=早朝(4-6)、2=正午前(6-12)、3=昼(12-15)、
  4=昼下がり(15-18)、5=夕(18-20)、6=夜(20-23)、7=深夜(23-4)。
- adapter 导出：`ERATW_DISPATCH_SELECTORS` 与 `ERATW_TIME_BAND_VALUES`。
- 七个 canonical 时辰带仍只认 `DIM.ERH:182`；`夜晚` 等别名由 RuntimeMatchPolicy 的父子表映射到 `夜`，未登记名字（如 `黄昏`）fail-closed。

Host 用法：

```ts
import { ERATW_DISPATCH_SELECTORS } from '@kojo/plugin-eratw-adapter';

compileKojo2Project({
  // ...
  dispatchSelectors: ERATW_DISPATCH_SELECTORS,
  requireDispatch: true,
});
```

产物形状：

```erb
IF NAME_FROM_PLACE(CFLAG:MASTER:現在位置) == "神社"
    IF TIME:2 == 6
        CALL M_KOJO_ENCOUNTER_K12__D1
        RETURN RESULT
    ENDIF
ENDIF
```

## RuntimeMatchPolicy 收口（第六阶段）

- core 新增纯数据 `RuntimeMatchPolicy`：location/time 的 aliases、parents、timeValues、timeRanges。
- `TargetRegistry.runtimeMatchPolicy` 由 adapter 声明；linker 原样带到 `LinkedProject`；
  `selectRuntimeTheater` 与 `buildProjectDispatchPlan` 读同一份策略。
- `DispatchBranch.conditions` 由 policy 统一展开：location OR 等值、time OR `==` / 闭区间；
  最终 dispatch ERB 直接消费该条件组，不再由 adapter 二次猜别名。
- eraTW `ERATW_RUNTIME_MATCH_POLICY`：
  - location alias：`博麗神社`/`神社`、`紅魔館`/`红魔馆`、`人間の里`/`人里`、`魔法の森`/`魔法森林`；
  - time parent：`夜晚`→`夜`、`清晨`→`早朝`、`傍晚`→`夕`、`凌晨`→`深夜`、`上午`→`正午前`、`中午`→`昼`、`下午`→`昼下がり`；
  - time range：`白天` 2–4、`晚上` 5–6、`夜间` 6–7、`全天` 1–7。
- `runtimeProtocol.metadata.matchPolicyId` 指向策略 id，Host 可审计。
- `resolveKojo2RuntimeSelection` 一次返回 selection + problems；`kojo2RuntimeSelectionProblems` 把 `ambiguous` / `no-match` / `not-linked` 映射为宿主可见 error。
- 未登记策略名字仍 fail-closed；runtime 值与 dispatch 条件由同一展开函数产生。
