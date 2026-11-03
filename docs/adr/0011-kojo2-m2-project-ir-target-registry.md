# ADR-0011: Kojo 2.0 M2 — Project IR、Target Registry 与 Theater Linker 契约

- 日期：2026-11-03
- 状态：已接受（M2-P0 契约定稿；P1–P6 已实现，见 docs/KOJO-2.0-M2-IMPLEMENTATION.md）
- 批准范围：D1 到 D6 决策及 D7 到 D10 澄清
- 范围：M2 的 Project IR、Target Registry、Theater 收集与静态链接；M3 的地点与时间运行时匹配、特异性、唯一选择、Ambiguous/NoMatch 与最终 dispatch ERB 不在本决策内。
- 相关：docs/KOJO-2.0-M2-P0-CONTRACTS.md；docs/KOJO-2.0-LANGUAGE-SPEC.md 附录 D

## 背景

M1 已经把多剧场语法、AST、逐 Theater lowering unit 和新旧路径分流落到单文件编译层。当前关键事实是：

- compileKojoSource / compileKojoFile 只接受一份源码；CompileKojoSourceInput.filePath 只给宿主做身份与日志，core 不读盘且诊断不带文件身份（packages/kojo-core/src/compile.ts:78-89）。
- KojoTheaterTarget 只有 raw 与 span，地点与时间只有原始 kind/raw/span；canonical target、函数名和调用签名未进入 AST（packages/kojo-core/src/ast.ts:443-465）。
- TheaterLoweringUnit 只有 theater/body/sourceMap/slots，不携带 canonical ID、最终引擎函数名或运行时分发结果（packages/kojo-core/src/lower/theater-unit.ts:1-18）。
- 项目级已有跨文件函数、监听和声明分析，但没有 Theater 事实：collectFileFacts 只遍历 file.decls（packages/kojo-core/src/project/analysis.ts:685-714）。
- Target 合法性已经分裂：eventCatalog 与 backend 内部 FACE_TABLE 各自决定不同事实；eraTW 九个事件与 33 个 face 只有初见、指令两个交集（packages/plugins/eratw-adapter/src/kojo2/event-catalog.ts:34-61、face-templates.ts:57+、backend.ts:514-521）。

M2 必须先建立项目事实层和唯一 Target 解析层，否则跨文件重复、函数名、诊断和版本治理都无法可靠实现。本 ADR 关闭 D1 到 D10 的决策与澄清，不扩展为通用编译平台。

## 已批准决策

### D1 TargetRegistry 首版范围与两种状态

- TargetRegistry 首版只覆盖 eventCatalog 定义的事件 target。eraTW 为九个事件。
- 初见、指令为 supported；训练、读档、商店、购买、训练结束、回合末、指令结束明确为 unsupported。
- 必须区分目标登记状态与编译支持状态（TargetDescriptor.registrationStatus 与 TargetDescriptor.compileSupport）：
  - 登记状态回答目标是否存在于 TargetRegistry；所有九个事件都必须登记。
  - 编译支持状态回答该已登记目标当前能否编译；只有初见、指令为 supported。
  - 不在 TargetRegistry 的名字是 unknown，不是 unsupported。
- 未登记或未支持都不得静默回落；不得用 eventCatalog 通过来暗示编译支持，也不得用 face 同名来推断登记关系。
- TargetRegistry 是 Core 定义、Adapter 提供的数据契约；不是 GameAdapter 上的巨大可选配置字段。
- eventCatalog 继续负责事件分发、@织 可织性和优先级事实；TargetRegistry 负责 Theater 与 # 机 的 target 登记、解析和编译支持。
- 全部九个事件都必须有 eventBinding；unsupported 目标仍保留 eventBinding、sourceArgs 与 unsupportedReason，但 functionName、callSignature、runtimeProtocol 为 null。
- TargetRegistry 装载期必须校验：九个 eventCatalog 事件都有 descriptor；canonicalId 唯一；surface 与 aliases 不歧义；eventBinding 存在；supported 目标的函数名模板与签名完整。
- unsupported 目标的诊断策略：解析状态为 unsupported，产生 error 级 ProjectDiagnostic，kind 为 target-unsupported，并携带 unsupportedReason；不得进入函数名解析、链接分组或产物生成。

### D2 Exact duplicate 的唯一键

- M2 的 exact duplicate 唯一键只由以下字段组成：
  - canonicalTargetId
  - parser 既有 location.kind
  - parser 既有 location.raw
  - parser 既有 time.kind
  - parser 既有 time.raw
- 不引入地点别名、地点继承、时间别名、时间区间重叠、区间包含或任何运行时匹配语义。
- 不对 location.raw 或 time.raw 做额外 trim、大小写折叠、别名替换或默认补全；只使用 parser 已产出的事实。
- 省略字段与显式不限是否同键，完全由 parser 既有 raw 决定，M2 不追加第二套归一化。
- 只有全部五个字段相同的 Theater 才是 exact duplicate；同 canonicalTargetId 但 location/time 不同，只形成同一 target 的候选组，不是 M2 重复错误。
- exact duplicate 检查覆盖显式 Theater 与 legacy-machine Theater；origin 只用于标注，不作为重复键的一部分。
- unknown 或 unsupported target 不参与 exact duplicate 检查；它们先各自产生 target 诊断。
- exact duplicate 的 ProjectDiagnostic 必须同时携带 primary 与 related 文件位置，并 error 级阻断项目构建。

#### D2 修订（2026-11-03 P1-4）

- 唯一键增加 `engineFunctionName`（取自 `TargetResolution.functionName.name`），即 D2 原五字段 + 函数名共六字段；D5 中「同一五字段键」按本修订一并理解。
- 支持多角色项目：同一 canonical target、同 location/time 下，不同引擎函数名（不同角色 / 家族）是各自合法的定义，**不判 exact duplicate**，仍形成同一 target 的候选组。
- 只有 canonicalTargetId + location.kind/raw + time.kind/raw + engineFunctionName 全部相同才是 exact duplicate；origin 仍不进键，不 trim、不做别名/区间语义的口径不变。
- 实现落点：`ExactTheaterKey.engineFunctionName`、`linker.ts` 的重复键与诊断；M3 Runtime Matcher 增加可选 `engineFunctionName` 请求字段与候选带出，未点名时维持跨角色 ambiguous（不按顺序决胜）。
- 多角色重复隔离（2026-11-03 收尾，additive）：`ResolvedTheater` 增加 `duplicate` 标记，`LinkedTheaterGroup` 增加 `duplicateFunctionNames`；`group.duplicate` 保留为聚合兼容视图。Matcher / Dispatch Plan 必须按函数名隔离——K12 的重复只阻断 K12，K13 仍可独立匹配并生成 dispatch target；不得再用 canonical 级 `group.duplicate` 拒绝整个候选组。

### P1-3 版本校验落地（2026-11-03）

- 新增 `validateProjectProvenanceVersions(projectIR, { registry, backend })`（`packages/kojo-core/src/project/version-check.ts`，由 `project/index.ts` 导出）；`compileProject` 在链接前调用。
- 四轴逐字校验：`adapterId` / `adapterVersion` 对 `TargetRegistry.adapterId` / `adapterVersion`；`backendId` / `backendVersion` 对 `backend.id` / `backend.version`。
- 缺失即 fail-closed：provenance 任一轴为空串或 null → `version-mismatch` error；backend 未声明版本（`KojoEmitBackend.version?` 可选）同样阻断，不静默放过。
- 诊断 `kind = version-mismatch`、`code = core/project/version-mismatch`，并入 Project IR 诊断，使 `buildStatus = failed` 且不发布任何产物。
- `targetRegistryId` / `targetRegistryVersion` 的比对仍由 linker 负责，既有 version-mismatch 口径不变。

### D3 Host 注入函数名上下文

- charNo、familySegment 由 Host 注入，作为文件级 Project IR 事实，放入 ProjectFileIR.functionNameContext；segments 不在 FunctionNameContext，它由 Adapter 通过 TargetDescriptor.parameterRules/segmentDefaults 声明（见 D7、D8）。
- FunctionNameContext 只承载 Host 文件事实；TargetRegistry 与 Linker 不得为它补默认值。
- 缺失必需 Host 上下文时必须产生 error 级 ProjectDiagnostic，kind 为 function-name-context-missing；状态为 needs-context，不得静默默认。
- 特别禁止：缺失 familySegment 时自动补空串；缺失 charNo 时生成残名或跳过函数名解析；Adapter 的 segment 默认值必须显式声明，禁止取对象首键。
- 显式空串是合法事实；Host 要表达标准版家族段时必须显式给空串，不能用缺席表达同一个意思。
- supported 目标必须有完整函数名模板与调用签名；unsupported 目标不做函数名解析，也不需要上下文完整。
- Backend 与 Linker 必须消费同一个 FunctionNameResolution；Backend 不得保留第二套 renderMachineName 与 applySegments 的独立语义。
- @织 的函数头继续使用 EventSpec.engine，不经过 FunctionNameContext 或 TargetDescriptor.functionName。

### D4 SourceMapData 的序列化边界

- SourceMapData 必须是可序列化的纯数据投影，只包含行、段、origin、span 与版本号等纯对象和数组。
- SourceMapData 不得包含函数、方法、闭包、类实例、循环引用或运行时缓存。
- 运行时 SourceMap 的接口与实现保持不变；M2 只增加 SourceMapData，不要求也不允许改写现有 SourceMap 行为。
- ProjectTheaterIR.sourceMapData 为 SourceMapData 或 null；它不是运行时 SourceMap 的替代品，而是项目 IR 的可序列化事实。
- 运行时需要查询时，由边界适配器从 SourceMapData 构建或复用 SourceMap；该构建不属于本 ADR 的接口改动。
- SourceMap 原有 1 基行列、显式 null、模板与池 origins 语义全部保持。

### D5 legacy-machine 的纳入范围

- legacy-machine 纳入项目级目标解析和跨文件 exact duplicate 检查。
- ProjectTheaterIR 与 ResolvedTheater 必须保留 origin 为 legacy-machine，不得伪装成显式 theater。
- legacy-machine 的目标同样经过 TargetRegistry：登记状态、编译支持状态、unsupported 诊断与显式 Theater 一致。
- legacy-machine 与显式 Theater 使用同一 exact duplicate 五字段键；origin 只用于诊断标注，不作为键的一部分，也不作为运行时优先级。
- M1 legacy 单文件输出必须完全不变：legacy # 机 仍走既有 lowerLegacyFile 与 wrapMachine 路径，M2 只新增项目级事实和诊断，不改字节。
- legacy-machine 的 target 若 unsupported，项目级构建失败；M1 单文件现有行为不被 M2 重写。

### D6 部分分析状态与整体构建失败

- 项目分析尽可能非短路：单个文件解析失败时，其他文件继续解析、收集诊断和生成 IR。
- ProjectIR.analysisStatus 表示项目分析覆盖状态，只能是 complete 或 partial。
- ProjectBuildResult.buildStatus 表示整体构建结果，只能是 succeeded 或 failed。
- 只要存在任一解析失败、target unknown、target unsupported、缺必需上下文、exact duplicate、registry 绑定错误或版本不匹配，buildStatus 必须为 failed。
- buildStatus 为 succeeded 的必要条件：analysisStatus 为 complete，failedFiles 为空，且没有上述阻断诊断。
- buildStatus 为 failed 时不得发布部分产物；LinkedProject 可作为诊断视图存在，但不是可发布结果。
- M2 不生成最终 dispatch ERB；LinkedProject 存在也不代表项目构建成功。
- 项目级失败不得退化成把第一份文件报错后停止；其他文件的诊断与 IR 必须保留。

### D7 模板参数来源分类

| 参数 | 来源类别 | 具体来源 | 说明 |
|---|---|---|---|
| charNo | Host 文件事实 | GameProject.charaIndex[].kojoDir 与 no，经 longest prefix 计算 | 不是 Adapter 规则，也不能由 TargetRegistry 代替 |
| familySegment | Host 文件事实 | 文件或项目所属家族事实；Adapter 只声明编码规则与允许形态 | 标准 eraTW 的空串是模板约定，但 2.0 当前没有 family producer；缺席不能自动当标准版 |
| segments.com | Adapter 游戏规则事实 | Adapter 的 TargetDescriptor.segmentDefaults 与候选表 | 只允许 Adapter 显式声明默认值；禁止从对象首键推断 |
| i | Core 编译派生事实 | # 机 的 KojoMachineDecl.args[0] 由 parser 产出 | Theater 的 KojoTheaterTarget 只有 raw，没有 typed args；该来源当前未闭合 |

补充说明：

- 初见只使用 t、n；指令使用 t、n、com、i。
- 标准 eraTW 的 familySegment 按模板约定为空串，但 M2 不得把没有 family 事实推断成标准版；Host 必须显式提供空串。
- 指令的 com 默认值有既有规范与 v1 代码证据（默认 COM），但必须由 Adapter 显式声明 segmentDefaults.com，不能继续依赖 FACE_TABLE 对象首键。
- # 机 的 i 来自 parser 的 KojoMachineDecl.args；Theater 当前没有目标参数数组，因此 Theater 指令的 i 仍是未决来源，不能猜。

### D8 模板参数语义

| 参数 | required / optional | 允许显式空串 | Adapter 可声明默认值 | 缺失诊断 | 非法值诊断 |
|---|---|---|---|---|---|
| t | 模板含 t 即 required | 允许；标准版必须显式空串 | 不允许 | function-name-context-missing | function-name-context-invalid |
| n | 模板含 n 即 required | 不允许 | 不允许 | function-name-context-missing | function-name-context-invalid |
| com | 模板含 com 即 required | 不允许 | 允许，但必须是显式 segmentDefaults，且有规范或 adapter 数据依据 | 无默认时 registry-binding | function-name-context-invalid |
| i | 模板含 i 即 required | 不允许 | 不允许 | function-name-context-missing | function-name-context-invalid |

约束：

- required 只在模板实际包含该参数时成立；Adapter 必须在 TargetDescriptor 的参数规则中显式声明。
- t 的合法形态、n 的数字形态、com 的候选集合、i 的整数形态都由 Adapter 参数规则声明；Core 只执行规则，不猜。
- 非法值不得回落成空串、首键、默认编号或跳过参数；必须产生 invalid-context 诊断。
- Adapter 默认值只能补 Adapter 规则事实，不能补 Host 文件事实 t、n 或 Core 实例事实 i。

### D9 Target supported 的定义

- compileSupport = supported 表示 Adapter 已提供完整、合法、可验证的目标编译描述：函数名模板、参数规则、必要的 Adapter 默认值、调用签名。
- 它不表示每个文件都必然能完成函数名解析；Host 文件事实缺失时，TargetResolution 可以是 needs-context，非法值时是 invalid-context。
- 文件级 missing/invalid context 不得把 TargetRegistry 中的 target 从 supported 改成 unsupported，也不得改变全局 registry 状态。
- 文件级诊断必须是独立的 ProjectDiagnostic，且阻断项目构建；不能静默降级为通用 backend 错误。

### D10 文件身份

- 文件身份使用平台感知的 pathKey；Windows 折叠大小写，POSIX 保留大小写。
- 同一 layer 内 pathKey 唯一；如果 layer 允许同路径，ProjectFileId 必须包含 layerId。
- contentHash 与文件身份分离；contentHash 只用于变化检测或缓存，不参与 ProjectFileId 的相等判定。
- TheaterId 使用 ProjectFileId 加 ordinal；ordinal 只用于项目内指认，不是运行时排序。
- 不修改 KojoFile、KojoTheater、TheaterLoweringUnit 的 M1 形状；身份由项目层包装。
### D7-D10 证据与理由

- charNo：现有 Host 算法在 packages/app/src/ui/kojo2-problem-wiring.ts:386-407，按 GameProject.charaIndex[].kojoDir 最长前缀返回 no；编辑器在 packages/app/src/ui/editor-pane/use-monaco-instance.ts:325-331 注入，bootstrap.ts:132-139 把它作为 Kojo2BackendDeps.charNo。项目分析输入尚未接这条事实。
- familySegment：backend 只声明可选 deps.familySegment（packages/plugins/eratw-adapter/src/kojo2/backend.ts:98-108）并使用 ?? ''（:539）；2.0 Host 工厂只有 charNo（bootstrap.ts:132-139, 276-281）。现有 familySegment 计算在 v1 sugar 的 front matter（kojo-sugar/src/codegen.ts:580-584），2.0 parser 不产生该事实（parser.ts:672 已明确旧头声明退场）。
- segments：face 表有 LOCALS_SEGMENTS 与指令模板的 com 段（face-templates.ts:34-48, 87-92）；backend 缺省取对象首键（backend.ts:546-570）；2.0 Host 没有 segments 端口（bootstrap.ts:132-139）。v1 规范与 codegen 有默认 COM 的明确证据（kojo-sugar/src/codegen.ts:1078-1088；faces-reverse.ts:32-35），因此允许 Adapter 显式声明 segmentDefaults.com = COM，但不能继续靠对象首键。
- i：Theater 头只保存 target.raw 与 span（parser.ts:510-513）；# 机 的 args 由 parser 产生（parser.ts:964-966），backend 用 args[0] 填 {i}（backend.ts:532-537）。Theater 当前没有 typed target args，因此 Theater 指令的 i 仍未决。
- 文件身份：平台感知的 pathKey 在 packages/plugin-api/src/paths.ts:198-202；应用文件树另有恒小写 pkey（file-tree-ops.ts:365-367），不能作为 ProjectFileId 的唯一口径。项目文档已有 path/text/layerId（kojo2-project-analysis.ts:133-138），contentHash 可用 stableHash 但尚未接线。
## 跨决策不变量

1. M2 是 additive：不改变 M1 AST 语义、wrapper 协议、SourceMap 语义或增量编译 fallback。
2. Project IR 是项目事实源；Map 只能作为派生索引，不能替代 ProjectFileIR 与 ProjectTheaterIR 数组。
3. LinkedProject 独立于最终 ERB 生成；M2 不生成最终 dispatch ERB。
4. M3 负责 location/time matcher、specificity、唯一选择、Ambiguous/NoMatch 和最终 dispatch。
5. 版本不匹配、缺失必需上下文、不支持目标、未登记目标等情况不得静默降级。
6. 跨文件诊断必须具有 primary 与 related 文件身份；禁止靠消息里的路径或注入顺序猜归属。
7. 文件与 Theater 顺序只作为源事实和诊断排序输入，不作为运行时优先级。

## 分层职责

| 层 | 职责 | 禁止 |
|---|---|---|
| Core | 定义 TargetRegistry 契约、验证规则、通用解析算法、Project IR 类型 | 游戏名词、读盘、ERB 生成 |
| Adapter | 提供 TargetRegistry 数据、事件绑定、函数名模板、签名事实 | 链接、文件排序、运行时选择 |
| Backend | 消费统一解析结果并生成引擎代码 | 第二套 target 合法性、第二套函数名解析 |
| Project Linker | 消费 Project IR 与 Registry，做分组、静态重复检查和诊断 | 地点与时间匹配、最终 dispatch ERB |
| M3 Runtime Matcher | 消费 LinkedProject 与 runtimeProtocol | 反向修改 M2 canonical target |

TargetRegistry 是 Core 定义的独立契约，由 Adapter 提供数据，由 Backend 与 Linker 共同消费；它不是 GameAdapter 上的巨大可选字段。

## 否决方案

1. 用 Map 直接做链接结果：丢失文件身份、原始 target、unsupported 状态、诊断关系和 legacy origin。
2. 直接复用 v1 kojoFaceTemplates 作为 2.0 TargetRegistry：v1 表是 33 face 的 UI 与 sugar 数据，没有 eventCatalog 绑定、2.0 signature 和 version。
3. 保留 backend 内部 renderMachineName，再由 linker 实现一份：会出现第三份函数名解析，且缺编号行为已经与 v1 buildFunctionName 不同。
4. 只使用 eventCatalog 作为 target 合法性：它没有函数名模板和调用签名。
5. 在 M2 做地点或时间规范化：与 M3 范围冲突。
6. 把 TargetRegistry 做成 GameAdapter 的巨大配置字段：会让 core、linker、backend 的职责重新糊在一起。

## 后果

- 新增 Project IR、TargetRegistry、ProjectDiagnostic、SourceMapData、LinkedProject 等契约；均为 additive，不改 M1 单文件入口。
- Backend 需要改为消费统一函数名解析器；Adapter 需要为九个事件提供 registry descriptor，其中七个为显式 unsupported。
- 项目级缓存、版本治理和跨文件诊断成为后续实现的前置条件。
- 本 ADR 不产生任何代码、测试或生成文件变更，也不启动 P1。

## 验收

1. ADR 与 docs/KOJO-2.0-M2-P0-CONTRACTS.md 对 D1 到 D10 的描述一致。
2. 每个正式类型都有字段、职责、可空性和不变量。
3. unsupported target 有明确数据表达与诊断策略。
4. legacy-machine 的 origin 和重复检查范围明确。
5. Project IR 的 partial 分析状态与整体 failed 构建状态明确区分。
6. SourceMap 与 SourceMapData 的边界明确。
7. M1 兼容性约束明确。
8. 未引入 D1 到 D10 批准范围之外的新架构决策。
