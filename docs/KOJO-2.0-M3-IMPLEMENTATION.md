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
- `kojo2RuntimeSelectionProblems` 把 `ambiguous` / `no-match` / `not-linked` 映射为宿主可见 error。
- 未登记策略名字仍 fail-closed；runtime 值与 dispatch 条件由同一展开函数产生。
