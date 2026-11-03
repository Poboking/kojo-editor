# ADR-0012：Kojo 2.0 M3 Runtime Matcher 第一阶段

- 状态：已接受（2026-11-03）
- 范围：location/time 原始字面匹配、特异性比较、唯一选择、NoMatch/Ambiguous/NotLinked
- 不包含：地点/时间别名、区间、继承、最终 dispatch ERB

## 决策

1. `selectRuntimeTheater` 输入 `linkedProject`、`canonicalId`、`location`、`time`。
2. 只读取 `LinkedProject.groups` 中 `canonicalId` 完全相同的组；duplicate 组拒绝选择。
3. `unrestricted` 地点/时间匹配任意运行时值；`exact` / `named` 必须非 null 且与 raw 逐字相等。
4. 不做 trim、大小写折叠、别名、区间或继承。
5. 特异性固定：exact location = 2，unrestricted location = 0；named time = 1，unrestricted time = 0。
6. 最高分唯一才 selected；并列 ambiguous，不按 fileId / 源文件顺序 / ordinal 决胜；无匹配 no-match。
7. 候选列表只用于诊断排序，不表示运行时优先级。
8. 不生成最终 dispatch ERB；不回写 canonical target、Registry 版本或 exact duplicate 键。

## Additive 事实

M2 `ResolvedTheater` 增加只读 `location` / `time`，由 linker 从 `ProjectTheaterIR.theater` 原样复制。
这是 M3 读取 parser facts 所需的最小 additive 变更；M2 匹配语义与 exact duplicate 键不变。

## 第二阶段扩展（2026-11-03）

- 新增可选 `renderDispatch` 端口；core 只给结构请求，不写 ERB 关键字。
- `DispatchTargetPlan` 按 `canonicalId + functionName` 拆分，避免跨角色合并。
- eraTW selector 由 Host 显式注入；缺失时 fail-closed。
- `requireDispatch` 控制最终 dispatch 是否为构建必需；缺省保持 M2 兼容。

## 第三阶段扩展：Host selector 注入

- selector 从 backend 实例 deps 上提到 `ProjectCompileInput.dispatchSelectors`，Host 成为唯一来源。
- `compileKojo2Project` 提供同一入口；`requireDispatch` 继续控制是否阻断构建。
- 没有证据的 eraTW selector 不写入默认值；缺失时 fail-closed。

## 第四阶段扩展：真实语料 selector

- 以 `eraTW4.981-261017-EAGLOV3` 取证：地点 `NAME_FROM_PLACE(CFLAG:MASTER:現在位置)`，时辰 `TIME:2`。
- `DIM.ERH:182` 的七个时辰带成为 adapter 的显式 `ERATW_TIME_BAND_VALUES`；未登记名字 fail-closed。
- Host 直接注入 `ERATW_DISPATCH_SELECTORS`；不再使用测试占位表达式。

## 第五阶段扩展：RuntimeMatchPolicy

- adapter 声明 `ERATW_RUNTIME_MATCH_POLICY`，registry 携带；matcher 与 dispatch plan 共用别名/继承/区间展开。
- `runtimeProtocol.metadata.matchPolicyId` 指向策略 id。
- Host 通过 `kojo2RuntimeSelectionProblems` 暴露 Ambiguous / NoMatch / NotLinked。

## 第六阶段扩展：P1 修复（2026-11-03）

> 阶段号说明：实施记录把 RuntimeMatchPolicy 记为第六阶段、本 ADR 记为第五阶段；本轮 P1 修复按实施记录记作第七阶段，历史小节不做改写。

- **Matcher/Dispatch 歧义一致（P1-1）**：`buildProjectDispatchPlan` 按 `canonicalId + functionName` 分组后，在同一 specificity 内检测 policy 展开后的条件重叠（location 集合相交 ∧ time 集合相交）；命中即把该 target 标 `status='blocked'` 并产 error 级 `dispatch/ambiguous-branches`，渲染器只接收 ready target，不得按 fileId / 文件顺序静默决胜。不同 specificity 的重叠不阻断：matcher 取唯一最高分，dispatch 按 specificity 降序 first-match，两者一致。
- **Legacy 与 dispatch 边界（P1-2）**：legacy-machine 分支不进入 dispatch target（其 ERB 由 M1 单文件路径负责），plan 只产 warning `dispatch/legacy-machine-skipped`；不拖空其它 target 的 `dispatchErb`；legacy-only 项目 + `requireDispatch` 不再静默失败。所有渲染失败路径（缺 lowering unit / backend 无 `renderDispatch` / `EmitFailure`）必须显式诊断，单个 target 失败只跳过自身。
- **多角色（P1-4）**：`ProjectDispatchErb` additive 携带 `functionName`（同 canonical 多角色产多份）；`RuntimeSelectionRequest.engineFunctionName?` 与 `RuntimeMatchCandidate.engineFunctionName` 让 Host 按角色/函数身份唯一选择，不传时跨角色同条件仍按 ambiguous 处理（matcher 语义不变）。
