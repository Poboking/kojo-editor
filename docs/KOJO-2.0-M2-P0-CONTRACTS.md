# Kojo 2.0 M2-P0 契约

- 日期：2026-11-03
- 状态：已接受（M2-P0 契约定稿；P1–P6 已实现，见 docs/KOJO-2.0-M2-IMPLEMENTATION.md）
- 上位决策：docs/adr/0011-kojo2-m2-project-ir-target-registry.md
- 范围：表达 ADR-0011 的 D1 到 D10；不新增运行时地点/时间语义，不启动 P1。
- 目标：为 eraTW 多文件 Theater 编译提供稳定架构；不建设适用于所有游戏、所有脚本语言、所有运行时的万能平台。

## 0. 决策与澄清

| 编号 | 决策 | 本契约落点 |
|---|---|---|
| D1 | TargetRegistry 首版覆盖 eventCatalog 九个事件；初见、指令 supported，其余七个 unsupported；区分登记状态与编译支持状态 | TargetRegistry、TargetDescriptor、TargetResolution |
| D2 | exact duplicate 使用 canonicalTargetId 加 parser 既有 location.kind/raw 加 time.kind/raw；不引入地点别名或时间区间语义 | ExactTheaterKey、DuplicateKey |
| D3 | charNo、familySegment 由 Host 注入为文件级 Project IR 事实；segments 由 Adapter 显式规则/默认声明；缺失必需上下文明确诊断，不静默默认 | FunctionNameContext、ProjectFileIR、FunctionNameResolution |
| D4 | SourceMapData 必须是可序列化纯数据投影；运行时 SourceMap 不改 | SourceMapData、ProjectTheaterIR |
| D5 | legacy-machine 纳入项目级目标解析和跨文件重复检查；保留 origin；M1 legacy 单文件输出不变 | ProjectTheaterIR、ResolvedTheater、LinkedProject |
| D6 | 项目分析非短路，保留其他文件诊断和 IR；任何解析失败或链接错误使整体构建失败，不发布部分产物 | ProjectIR.analysisStatus、ProjectBuildResult.buildStatus |
| D7 | 模板参数分为 Host 文件事实、Adapter 游戏规则事实、Core 编译派生事实 | FunctionNameParameterSource、FunctionNameParameterRule |
| D8 | 每个模板参数显式声明 required、空串、默认值、缺失与非法值语义 | FunctionNameParameterRule、FunctionNameResolution |
| D9 | compileSupport supported 表示目标描述完整，不保证每个文件都能解析 | TargetResolution、needs-context、invalid-context |
| D10 | 文件身份使用 pathKey，ProjectFileId 可包含 layerId，contentHash 分离 | ProjectFileIR、TheaterId |

## 1. 公共标识与 provenance

    type ProjectFileId = string;
    type TheaterId = string;
    type CanonicalTargetId = string;
    type RegistryId = string;

    interface ProjectBuildProvenance {
      adapterId: string;
      adapterVersion: string;
      adapterFactsVersion: string;
      gameFingerprint: string;
      targetRegistryId: RegistryId;
      targetRegistryVersion: string;
      backendId: string;
      backendVersion: string | null;
      coreVersion: string;
      sourceMapPolicy: SourceMapPolicy;
      capability: Capability;
    }

职责与不变量：

1. ProjectFileId 由项目层生成，必须在同一项目构建内稳定；具体字符串格式由实现决定，但内容 hash 不得与显示路径混为同一身份。
2. TheaterId 由项目层生成并在项目内稳定指认 Theater；具体字符串格式由实现决定；ordinal 只用于身份，不是运行时排序。
3. adapterVersion、targetRegistryVersion、backendVersion 缺失或不匹配不得静默回落；产生版本诊断并阻断构建。
4. gameFingerprint 与 adapterVersion 是不同轴：前者描述游戏输入，后者描述 adapter 契约。
5. provenance 进入项目缓存键；任一字段变化使 Project IR 与 LinkedProject 失效。

## 2. TargetRegistry

    type TargetRegistrationStatus = 'registered' | 'unregistered';
    type TargetCompileSupport = 'supported' | 'unsupported';

    interface TargetRegistry {
      registryId: RegistryId;
      version: string;
      adapterId: string;
      adapterVersion: string;
      targets: readonly TargetDescriptor[];
    }

    interface TargetDescriptor {
      registrationStatus: 'registered';
      compileSupport: TargetCompileSupport;
      canonicalId: CanonicalTargetId;
      surface: string;
      aliases: readonly string[];
      eventBinding: string;
      sourceArgs: readonly EventArgumentSpec[];
      unsupportedReason: string | null;
      functionName: FunctionNameTemplate | null;
      callSignature: CallSignature | null;
      runtimeProtocol: RuntimeProtocolDescriptor | null;
      parameterRules: readonly FunctionNameParameterRule[];
      segmentDefaults: Readonly<Record<string, string>>;
    }

    interface TargetResolution {
      registrationStatus: TargetRegistrationStatus;
      status: 'supported' | 'unsupported' | 'unknown' | 'needs-context' | 'invalid-context';
      rawTarget: string;
      canonicalId: CanonicalTargetId | null;
      descriptor: TargetDescriptor | null;
      functionName: FunctionNameResolution;
      diagnostics: readonly ProjectDiagnostic[];
    }

九个事件的状态：

| eventCatalog 事件 | registrationStatus | compileSupport | functionName/callSignature |
|---|---|---|---|
| 初见 | registered | supported | 非 null |
| 指令 | registered | supported | 非 null |
| 训练 | registered | unsupported | null |
| 读档 | registered | unsupported | null |
| 商店 | registered | unsupported | null |
| 购买 | registered | unsupported | null |
| 训练结束 | registered | unsupported | null |
| 回合末 | registered | unsupported | null |
| 指令结束 | registered | unsupported | null |

职责与不变量：

1. 九个 eventCatalog 事件必须有 descriptor；缺一个是 registry-binding error，不是 unknown。
2. registrationStatus 回答目标是否在 registry；compileSupport 回答已登记目标当前能否编译。两者不得混用。
3. 不在 registry 的名字为 TargetResolution.status 为 unknown，registrationStatus 为 unregistered。
4. 已登记但 compileSupport 为 unsupported 时，status 为 unsupported，unsupportedReason 必须非 null；functionName、callSignature、runtimeProtocol 必须为 null。
5. supported 时 functionName 与 callSignature 必须非 null，parameterRules 必须覆盖模板中的全部参数；unsupported 不进入函数名解析、链接分组或产物生成。
6. eventBinding 必须指向存在的 EventSpec.event；eventCatalog 继续负责事件分发、@织 可织性和优先级。
7. surface 与 aliases 只做作者面解析和展示；canonicalId 是稳定身份。canonicalId 唯一；surface 与 alias 不得歧义。
8. TargetRegistry 装载期校验失败是不可链接错误；不能靠运行时取第一条或同名推断。
9. runtimeProtocol 只供 M3 消费；M2 不据此选择 Theater。
10. compileSupport = supported 只表示 Adapter 已提供完整、合法、可验证的编译描述；文件事实缺失是实例级 needs-context 或 invalid-context，不得把 TargetRegistry 的全局支持状态降级。
11. 参数规则由 TargetDescriptor.parameterRules 显式声明；Adapter 默认值只能通过 segmentDefaults 显式声明，不能使用对象首键。

## 3. 函数名上下文与调用签名

    interface FunctionNameContext {
      charNo?: string;
      familySegment?: string;
    }

    interface FunctionNameTemplate {
      template: string;
      requiredSegments: readonly string[];
    }

    interface FunctionNameResolution {
      kind: 'resolved' | 'needs-context' | 'invalid-context' | 'unresolved' | 'unsupported';
      name: string | null;
      requiredContext: readonly ('charNo' | 'familySegment' | 'index')[];
      reason: string | null;
    }

    type FunctionNameParameterSource = 'host-file' | 'adapter-rule' | 'core-derived';
    type FunctionNameParameterToken = 't' | 'n' | 'i' | 'segment';

    interface FunctionNameParameterRule {
      token: FunctionNameParameterToken;
      segmentName: string | null;
      source: FunctionNameParameterSource;
      required: boolean;
      allowExplicitEmpty: boolean;
      adapterMayDeclareDefault: boolean;
      valueKind: 'family-segment' | 'char-no' | 'segment' | 'index';
      valuePattern: string | null;
    }

    interface FunctionNameSourceArgs {
      index: string | null;
      indexOrigin: 'machine-args' | 'theater-target' | 'none';
      span: KojoSpan | null;
    }

    interface FunctionNameRequest {
      descriptor: TargetDescriptor;
      context: FunctionNameContext;
      sourceArgs: FunctionNameSourceArgs;
    }
    interface CallSignature {
      sourceArgs: readonly EventArgumentSpec[];
      wrapperFormals: readonly string[];
      companionFormals: readonly string[];
      returnProtocol: 'RETURN RESULT' | 'RETURN 1' | 'none';
      localPolicy: 'LOCAL_1_IF_BODY' | 'LOCAL_0_EMPTY' | 'none';
    }

职责与不变量：

1. FunctionNameContext 由 Host 注入，作为 ProjectFileIR 的文件级事实；TargetRegistry 与 Linker 不得补 Host 文件事实的默认值。Adapter 规则默认只允许来自 TargetDescriptor.segmentDefaults。
2. 缺 charNo、familySegment 或 index 且模板需要时，FunctionNameResolution.kind 为 needs-context，requiredContext 指明缺项，ProjectDiagnostic.kind 为 function-name-context-missing；值不合法时为 invalid-context。com 的 Adapter 默认缺失是 registry-binding，不是文件 context。
2a. 参数来源分类：charNo 与 familySegment 是 Host 文件事实；segments 是 Adapter 规则事实；index i 是 Core 编译派生事实。
2b. Adapter 默认值只能补 Adapter 规则事实；不得为 charNo、familySegment 或 index 声明默认值。
3. 显式空串是合法值；Host 表达标准版家族段时必须显式给空串，不能用字段缺席表达空串。
4. 缺失 segments 时不得取 adapter 表首键；只有在 TargetDescriptor.segmentDefaults 显式声明的段默认值才可用。缺失 familySegment 不得自动补空串；缺失 charNo 不得生成残名。
5. supported 目标必须函数名 resolved 且 callSignature 非 null；unsupported 目标 FunctionNameResolution.kind 为 unsupported，name 为 null。
6. Backend 与 Linker 消费同一个 FunctionNameResolution；Backend 不得保留第二套 renderMachineName 与 applySegments 语义。
7. @织 的函数头继续使用 EventSpec.engine，不经过 FunctionNameContext 或 TargetDescriptor.functionName。
8. CallSignature 只做元数据；M2 不执行运行时协议，不生成最终 dispatch ERB。

## 4. Project IR

    type ProjectAnalysisStatus = 'complete' | 'partial';

    interface ProjectFileIR {
      fileId: ProjectFileId;
      path: string;
      pathKey: string;
      layerId: string | null;
      contentHash: string;
      adapterId: string;
      adapterVersion: string;
      file: KojoFile | null;
      diagnostics: readonly KojoDiagnostic[];
      parseStatus: 'ok' | 'failed';
      functionNameContext: FunctionNameContext;
    }

    interface ProjectTheaterIR {
      theaterId: TheaterId;
      fileId: ProjectFileId;
      ordinal: number;
      origin: 'theater' | 'legacy-machine';
      theater: KojoTheater;
      unit: TheaterLoweringUnit | null;
      unitStatus: TheaterUnitsStatus;
      sourceMapData: SourceMapData | null;
      sourceArgs: FunctionNameSourceArgs;
      targetResolution: TargetResolution | null;
      linkStatus: 'unlinked' | 'grouped' | 'duplicate' | 'unsupported' | 'unknown' | 'needs-context' | 'invalid-context' | 'version-mismatch';
    }

    interface ProjectIR {
      projectId: string;
      provenance: ProjectBuildProvenance;
      analysisStatus: ProjectAnalysisStatus;
      files: readonly ProjectFileIR[];
      theaters: readonly ProjectTheaterIR[];
      diagnostics: readonly ProjectDiagnostic[];
      failedFiles: readonly ProjectFileId[];
    }

职责与不变量：

1. ProjectIR 是项目事实源；theaters 数组保留全部 Theater，Map 只能作为派生索引。
2. 每个 ProjectTheaterIR 保留 theater.raw target、location.raw、time.raw 与全部 span；canonical 结果只放 targetResolution，不覆盖原始事实。
3. file 为 null 只在 parseStatus 为 failed 时允许；该文件仍保留在 files 与 failedFiles 中，其他文件继续分析。
4. unit 可以为 null；unitStatus 必须如实反映 discarded 或 not-applicable，不得把失败伪装成空成功。
5. sourceMapData 为 SourceMapData 或 null；不得把带方法的 SourceMap 直接作为可序列化 IR。
6. legacy-machine 与显式 theater 必须按 origin 区分；两者都保留在 ProjectTheaterIR 中。
7. functionNameContext 是 Host 注入的文件级事实；缺失必需字段时进入 needs-context，不在 Linker 中补默认。
8. analysisStatus 为 partial 表示至少一份文件没有完成解析或 IR 生成，但其他文件仍被保留；它不等于 buildStatus。
9. 文件身份使用平台感知的 pathKey；同一 layer 内 pathKey 唯一，layer 允许同路径时 ProjectFileId 必须包含 layerId。
10. contentHash 与 ProjectFileId 分离；TheaterId 使用 ProjectFileId 加 ordinal；不修改 KojoFile、KojoTheater、TheaterLoweringUnit 的 M1 形状。

## 5. Exact duplicate 契约

    interface ExactTheaterKey {
      canonicalTargetId: CanonicalTargetId;
      locationKind: 'unrestricted' | 'exact';
      locationRaw: string;
      timeKind: 'unrestricted' | 'named';
      timeRaw: string;
    }

    interface TheaterDuplicateFact {
      key: ExactTheaterKey;
      primary: ProjectTheaterIR;
      related: readonly ProjectTheaterIR[];
    }

职责与不变量：

1. ExactTheaterKey 的五个字段必须逐字来自 TargetResolution.canonicalId 与 parser 既有 KojoTheater.location/time；不得追加地点别名、继承、时间别名或区间关系。
2. locationRaw 与 timeRaw 不做 trim、大小写折叠、默认补全或别名替换。
3. 省略字段与显式不限是否同键，完全由 parser 既有 raw 决定；M2 不增加第二套归一化。
4. 只有五个字段全部相同的 Theater 才是 exact duplicate；同 canonicalTargetId 但 location/time 不同只形成同一 target 的候选组。
5. exact duplicate 检查覆盖显式 Theater 与 legacy-machine Theater；origin 只用于诊断标注，不是键的一部分。
6. unknown 或 unsupported target 不进入 ExactTheaterKey 检查；先各自产生 target 诊断。
7. exact duplicate 产生 error 级 ProjectDiagnostic，kind 为 duplicate-theater；primary 与 related 必须指认全部重复 Theater。

## 6. SourceMapData 边界

    interface SourceMapData {
      version: number;
      lineCount: number;
      lines: readonly SourceMapLineData[];
    }

    interface SourceMapLineData {
      generatedLine: number;
      kind: SourceMapLineKind;
      source: KojoSpan | null;
      origins: readonly SourceMapOrigin[];
      segments: readonly SourceMapSegment[];
    }

职责与不变量：

1. SourceMapData 是可序列化纯数据，只能包含数组、普通对象、数字、字符串、布尔和 null。
2. SourceMapData 不得含函数、方法、闭包、类实例、循环引用或运行时缓存。
3. 运行时 SourceMap 的接口、实现与语义完全不变；M2 不要求也不允许改 SourceMap。
4. lineCount 必须等于 lines.length；generatedLine 为 1 基且严格递增。
5. source 与 origins 的 span 语义沿用 SourceMap；显式不可映射仍用 null，不伪造。
6. ProjectTheaterIR.sourceMapData 使用该类型；不得放入带方法的 SourceMap 实例。
7. 序列化边界之外如何构建运行时 SourceMap 是后续实现细节，不是本契约的新架构决策。

## 7. 项目诊断

    type ProjectDiagnosticKind =
      | 'target-unknown'
      | 'target-unsupported'
      | 'registry-binding'
      | 'function-name-context-missing'
      | 'function-name-context-invalid'
      | 'duplicate-theater'
      | 'version-mismatch'
      | 'project-incomplete';

    interface ProjectLocation {
      fileId: string;
      path: string;
      span: KojoSpan | null;
      role: 'declaration' | 'definition' | 'conflict' | 'reference' | 'project';
    }

    interface ProjectDiagnostic {
      kind: ProjectDiagnosticKind;
      code: string;
      severity: 'error' | 'warning';
      message: string;
      primary: ProjectLocation;
      related: readonly ProjectLocation[];
    }

职责与不变量：

1. 跨文件诊断必须有 primary 与 related；related 可以为空，但不能靠消息里的路径或注入顺序猜文件。
2. target unknown、target unsupported、缺上下文、非法上下文、exact duplicate、registry-binding、version-mismatch 都是 error 级，并阻断项目构建。
3. target-unsupported 的 message 必须包含 unsupportedReason；target-unknown 的 message 必须列出可用 target 或指向 registry。
4. 项目级无具体文件结论使用 role 为 project 的虚拟位置；不得伪造到第一份文件。
5. ProjectDiagnostic 不修改单文件 KojoDiagnostic 形状；项目层包装。
6. code 是稳定诊断码，由诊断码表评审后填入；kind 是本文档的语义分类，不代替码表。

## 8. LinkedProject

    interface RuntimeProtocolDescriptor {
      protocolId: string;
      version: string;
      metadata: Readonly<Record<string, unknown>>;
    }

    interface ResolvedTheater {
      theaterId: TheaterId;
      fileId: ProjectFileId;
      ordinal: number;
      origin: 'theater' | 'legacy-machine';
      rawTarget: string;
      canonicalId: CanonicalTargetId | null;
      resolution: TargetResolution;
      sourceArgs: FunctionNameSourceArgs;
      engineFunctionName: FunctionNameResolution;
      callSignature: CallSignature | null;
      sourceSpan: KojoSpan;
    }

    interface LinkedTheaterGroup {
      canonicalId: CanonicalTargetId;
      theaters: readonly ResolvedTheater[];
      duplicate: boolean;
    }

    interface LinkedProject {
      projectId: string;
      provenance: ProjectBuildProvenance;
      groups: readonly LinkedTheaterGroup[];
      theaters: readonly ResolvedTheater[];
      diagnostics: readonly ProjectDiagnostic[];
    }

职责与不变量：

1. LinkedProject 是静态链接结果，不包含最终 dispatch ERB；M2 不生成 ERB。
2. groups 按 canonicalId 做索引；每个 group 保留全部 theater；不是运行时 selected Theater。
3. ResolvedTheater 保留 origin；legacy-machine 不得被改成 theater。
4. unsupported 与 unknown theater 不进入 groups；它们保留在 theaters 与 diagnostics 中。
5. exact duplicate 的 group 标记 duplicate 为 true，并产生 primary/related 诊断。
6. @织 不进入 groups；继续由 analyzeWeaveLayers 处理。
7. 排序键为 canonicalId、fileId、span；不得以文件枚举顺序或源文件顺序表达运行时优先级。
8. M3 才消费 gates 与 runtimeProtocol 做 location/time matcher、specificity、唯一选择、Ambiguous/NoMatch 和最终 dispatch。

## 9. 项目构建结果

    type ProjectBuildStatus = 'succeeded' | 'failed';

    interface ProjectBuildResult {
      projectId: string;
      analysisStatus: ProjectAnalysisStatus;
      buildStatus: ProjectBuildStatus;
      projectIR: ProjectIR;
      linkedProject: LinkedProject | null;
      diagnostics: readonly ProjectDiagnostic[];
      failedFiles: readonly ProjectFileId[];
    }

职责与不变量：

1. 项目分析非短路：单文件解析失败只使该文件进入 failedFiles，其他文件继续解析、保留诊断和 IR。
2. analysisStatus 是分析覆盖状态；partial 不等于整体失败，但会阻断成功构建。
3. buildStatus 是整体构建结果；只有 analysisStatus 为 complete、failedFiles 为空且无阻断 error 诊断时才为 succeeded。
4. 任一解析失败、target unknown、target unsupported、缺必需上下文、exact duplicate、registry-binding 或版本不匹配，buildStatus 必须为 failed。
5. buildStatus 为 failed 时不得发布部分产物；LinkedProject 可以作为诊断视图存在，但不是可发布结果。
6. M2 不产最终 dispatch ERB；ProjectBuildResult 不提供可发布 ERB 字段。
7. linkedProject 为 null 只表示链接阶段无法形成结果；不得用 null 掩盖已有文件诊断。

## 10. 跨契约不变量

1. M2 是 additive：不改变 M1 AST 语义、wrapper 协议、SourceMap 语义或增量编译 fallback。
2. Project IR 是项目事实源；Map 只能作为派生索引，不能替代 ProjectFileIR 与 ProjectTheaterIR 数组。
3. LinkedProject 独立于最终 ERB 生成；M2 不生成最终 dispatch ERB。
4. M3 负责 location/time matcher、specificity、唯一选择、Ambiguous/NoMatch 和最终 dispatch。
5. 版本不匹配、缺失必需上下文、不支持目标、未登记目标等情况不得静默降级。
6. 文件与 Theater 顺序只作为源事实和诊断排序输入，不作为运行时优先级。
7. ProjectBuildResult.diagnostics 是 ProjectIR.diagnostics 与 LinkedProject.diagnostics 的合并视图；不得在合并时丢 primary/related。
8. 所有 error 级阻断诊断必须使 buildStatus 为 failed；warning 不得被提升为静默成功或静默失败。

## 11. M1 兼容性约束

以下必须保持不变：

1. KojoTheaterTarget、KojoTheaterLocation、KojoTheaterTime 的 raw/span 与 kind 口径。
2. KojoTheater 的 origin、legacyMachine、scenes、headerSpan、bodySpan、span。
3. KojoFile 的 theaters、hasTheaterSyntax、扁平 scenes 兼容语义。
4. TheaterLoweringUnit 的 theater/body/sourceMap/slots 语义。
5. TheaterUnitsStatus 的四个状态；theaterUnits 不是成功标志。
6. wrapMachine 的 ERB wrapper 字节协议：@name、CALL name_1、RETURN RESULT、RETURN 1、LOCAL、#DIM/#DIMS。
7. @织 的文件级装配与 EventSpec.engine 事件头。
8. SourceMap 的 1 基行列、显式 null、模板和池 origins 语义。
9. incremental.ts 的完整文本 Theater 预筛与 rebuildAll 回退。
10. legacy # 机的 lowerLegacyFile 与 wrapMachine 输出字节完全不变。

## 12. M3 边界

M2 不实现：

1. 地点与时间的运行时匹配。
2. 地点别名、时间别名、时间区间重叠、包含或特异性比较。
3. 唯一 Theater 选择。
4. Ambiguous 或 NoMatch 结果。
5. 最终 dispatch ERB。

M3 的输入是 LinkedProject 与 TargetDescriptor.runtimeProtocol；M3 不得反向修改 canonicalTargetId、TargetRegistry 版本或 M2 的 exact duplicate 键。

## 13. 验收矩阵

| 用例 | 预期 |
|---|---|
| 同一项目输入文件顺序置换 | ProjectIR、groups、diagnostics 逐条相同 |
| 初见 target | registrationStatus registered，compileSupport supported，函数名与签名非 null |
| 指令 target | registrationStatus registered，compileSupport supported，函数名与签名非 null |
| 训练、读档、商店、购买、训练结束、回合末、指令结束 | registrationStatus registered，compileSupport unsupported，functionName 与 callSignature 为 null，target-unsupported error |
| 不在 eventCatalog 或 registry 的名字 | registrationStatus unregistered，status unknown，target-unknown error |
| 两个文件同 canonical target 同 parser location.kind/raw 和 time.kind/raw | exact duplicate error，primary/related 指向两文件 |
| 同 canonical target 不同 location/time | 只形成一个候选 group，不报 duplicate；M2 不选择 |
| 缺 charNo 且模板需要 n | function-name-context-missing error，requiredContext 含 charNo |
| 缺 Adapter segment default 且模板需要段 | registry-binding error，不得取 adapter 首键 |
| adapterVersion 或 targetRegistryVersion 不匹配 | version-mismatch error，构建 failed |
| legacy-machine 与显式 Theater 同五字段键 | duplicate-theater error，origin 保留 |
| 单文件解析失败，其他文件正常 | ProjectIR.analysisStatus partial，其他文件 IR 与诊断保留，buildStatus failed |
| 所有文件解析成功但 target unsupported | analysisStatus complete，buildStatus failed，无部分产物 |
| M1 单文件 golden | ERB 逐字节不变 |
| SourceMapData 序列化再读取 | lineCount、generatedLine、source、origins、segments 保持纯数据一致 |
| familySegment 缺失但模板含 t | function-name-context-missing error；不得自动补空串 |
| com 默认缺失但模板含 com | registry-binding error；不得取对象首键 |
| Theater 指令的 i 缺失 | needs-context error；不得从 raw target 猜参数 |
| Windows 大小写变体 / POSIX 大小写不同路径 | 使用 pathKey；ProjectFileId 与 contentHash 分离 |

## 14. 明确不做的抽象

1. 不建立适用于所有游戏、所有语言、所有运行时的通用编译平台。
2. 不把 TargetRegistry 做成 GameAdapter 的万能配置字段。
3. 不提前做地点与时间语言、地点与时间继承、运行时 dispatch、M3 选择模型。
4. 不把 v1 sugar 的 face table 直接升级成 2.0 通用注册系统。
5. 不为没有真实差异的未来 adapter 预留空接口；只从 eraTW 九事件与既有 v1 face 数据的真实差异抽象。

## 15. 定稿验收

1. ADR-0011 与本文档对 D1 到 D10 的描述一致。
2. 每个正式类型都有字段、职责、可空性和不变量。
3. unsupported target 有明确数据表达与诊断策略。
4. legacy-machine 的 origin 和重复检查范围明确。
5. Project IR 的 partial 分析状态与整体 failed 构建状态明确区分。
6. SourceMap 与 SourceMapData 的边界明确。
7. M1 兼容性约束明确。
8. 未引入 D1 到 D10 批准范围之外的新架构决策。

## 16. D7-D10 澄清

### 16.1 模板参数来源

| 参数 | 来源分类 | 具体来源 | 说明 |
|---|---|---|---|
| t / familySegment | Host 文件事实 | 文件或项目所属家族事实 | 标准 eraTW 的空串是模板约定，但 2.0 当前没有 family producer；缺席不等于标准版 |
| n / charNo | Host 文件事实 | GameProject.charaIndex[].kojoDir 与 no，经 longest prefix 计算 | 现有 charNoForProjectPath 可复用；当前项目分析输入尚未接线 |
| com / segments | Adapter 游戏规则事实 | TargetDescriptor.segmentDefaults 与候选表 | 只接受 Adapter 显式默认值；既有默认 COM 有 v1 规范与代码证据，但不得从对象首键推断 |
| i | Core 编译派生事实 | # 机 的 KojoMachineDecl.args[0] | Theater 的 KojoTheaterTarget 只有 raw，没有 typed args；Theater 指令的 i 仍未决 |

### 16.2 模板参数语义

| 参数 | required / optional | 显式空串 | Adapter 默认值 | 缺失诊断 | 非法值诊断 |
|---|---|---|---|---|---|
| t | 模板含 t 即 required | 允许 | 不允许 | function-name-context-missing | function-name-context-invalid |
| n | 模板含 n 即 required | 不允许 | 不允许 | function-name-context-missing | function-name-context-invalid |
| com | 模板含 com 即 required | 不允许 | 允许，但必须显式声明并有规范或数据依据 | 无默认时 registry-binding | function-name-context-invalid |
| i | 模板含 i 即 required | 不允许 | 不允许 | function-name-context-missing | function-name-context-invalid |

规则：

1. TargetDescriptor.parameterRules 是唯一参数规则表；不再根据模板字符串隐式猜 required 或默认值。
2. TargetDescriptor.segmentDefaults 只能声明 Adapter 规则事实；不得用来补 Host 文件事实或 Core 实例事实。
3. FunctionNameContext 只承载 Host 文件事实；FunctionNameSourceArgs 只承载 Core 派生实例事实。
4. FunctionNameResolution.kind 必须区分 resolved、needs-context、invalid-context、unresolved、unsupported。
5. 缺失或非法值不得回落成空串、对象首键、默认编号或跳过参数。
6. ProjectTheaterIR.sourceArgs 保存 i 的来源；无法从 parser 或明确 Target 规则取得时为 index null、origin none。

### 16.3 Target supported

- compileSupport = supported 只表示目标描述完整、合法、可验证，不表示每个文件都能解析函数名。
- 文件级 context 缺失或非法产生 needs-context 或 invalid-context，并阻断项目构建；不得改变 TargetRegistry 中 target 的全局 supported 状态。
- target unsupported 是 Adapter 明确声明无编译落点；target unknown 是名字不在 registry；二者与 needs-context 分开。

### 16.4 文件身份

- ProjectFileIR.pathKey 是平台感知的路径键；Windows 折叠大小写，POSIX 保留大小写。
- ProjectFileId 在同一 layer 内由 pathKey 决定；若 layer 允许同路径，fileId 必须包含 layerId。
- ProjectFileIR.contentHash 只用于变化检测或缓存，不参与 ProjectFileId 相等判定。
- TheaterId = ProjectFileId 加 ordinal；ordinal 不是运行时排序。
- M1 的 KojoFile、KojoTheater、TheaterLoweringUnit 形状不变；身份只存在于项目层。

### 16.5 尚未由代码证据闭合的事项

1. 标准 eraTW familySegment 是否确实恒为空：模板与 v1 sugar 有标准版空串证据，但 2.0 没有 family producer；本契约只允许 Host 显式给空串，不把缺席当空串。
2. 指令的 com 是否确实恒为 COM：v1 规范与 codegen 有默认 COM 证据；本契约要求 Adapter 显式声明 segmentDefaults.com，不能依赖对象首键。
3. Theater 指令的 i 来源：当前 KojoTheaterTarget 只有 raw，没有 typed args；在 Target 实例参数规则未定义前，Theater 指令只能是 needs-context，不能猜。
