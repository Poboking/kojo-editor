# Kojo 2.0 编辑器接入指南（Host 接线段）

> 面向对象：在 `packages/app`（App / 宿主组合根 / 面板）做 2.0 接线与维护的人。
> 目标：照着本文件即可把「编辑器里的项目 + 文档」接到「可发布的最终 ERB」，**不需要再翻 core 代码**。
> 依据（均已落盘）：`packages/kojo-core/src/project/{compile-project,dispatch-plan,runtime-matcher,erb-assembly,ir,version-check}.ts`、
> `packages/app/src/ui/{kojo2-project-compile,kojo2-project-provenance,kojo2-file-context,kojo2-runtime-diagnostics}.ts`、
> `packages/app/src/ui/{kojo2-project-service-contract,kojo2-project-service,kojo2-project-workflow,kojo2-project-problems}.ts`、
> `docs/KOJO-2.0-M2-P0-CONTRACTS.md` §1.3 / `docs/KOJO-2.0-M3-IMPLEMENTATION.md` / `docs/KOJO-2.0-ARTIFACT-ASSEMBLY.md`。
> 本文只描述**现有接口与接线事实**，不含实现改动。
>
> **本批已接线（2026-11-03，Editor Integration 收尾）**：§0.1 的一屏事实已经落地——项目级 Application Service +
> 3 条命令 + `kojo2:build` 问题桶 + App 动态 `import()` 挂载。§6 里打勾的项即本批交付，未打勾的仍是下一阶段。
> 真机 E2E（调试宿 Web/headless）的实测回执、问题面板原文与截图路径见 §6.6。

---

## 0. 一屏结论

```
编辑器项目 + .kojo2 文档文本
  → compileKojo2Project(...)            // 项目级编译（身份 / 上下文 / 链接 / theaterErb / dispatchErb）
  → result.build.linkedProject          // 运行时选择的唯一输入
  → selectRuntimeTheater(...)           // 运行期唯一选择（location / time / 可选 engineFunctionName）
  → planProjectErbAssembly(result)      // 发布计划：哪些 dispatch unit、哪些 legacy 文件要 Host 供给
  → Host 用 M1 单文件路径编译 legacy 文件 → legacyErb[]
  → assembleProjectErb({ result, legacyErb })
  → status === 'complete' 才允许发布 / 预览上屏
```

一句话原则：**dispatchErb 是最终调度产物，theaterErb 只是预览视图，legacy 字节必须由 Host 用 M1 路径补上，缺一份就不算完整。**

### 0.1 本批已接线（一屏事实）

**分层红线：UI 只展示 / 交互；九步流程在 Service。**

```
命令 / 问题面板 / 通知（UI 层：App.tsx、palette、面板）
  │  只消费 Kojo2ProjectService 状态；不碰 Project IR / LinkedProject / Matcher / assembly
  ▼
kojo2-project-workflow.ts        Host 工作流（mountKojo2ProjectWorkflow）
  │  ① 快照端口 load()：项目 → 允许根 → .kojo2 文档 → 组合根事实包 → contextOf → M1 legacy 端口
  │  ② 生命周期：project.opened（重编译）/ project.closed（复位+清问题）/ file.changed（只标脏）
  │  ③ 问题面板上账 + exportFile 发布端口（对话框即授权）
  ▼
kojo2-project-service.ts         Application Service（createKojo2ProjectService）
  │  九步流程：身份 → contextOf → 编译 → linkedProject → matcher → plan → legacy 补齐 → assemble → 发布门禁
  │  单快照缓存 / 世代号 / 诊断汇总（Kojo2ProjectProblem）/ lastGood / publishable
  ▼
@kojo/kojo-core（compileProject / runtime-matcher / erb-assembly）+ bootstrap 登记的游戏事实包
```

**文件清单**（全部在 `packages/app/src/`）：

| 文件 | 角色 |
| --- | --- |
| `ui/kojo2-project-service-contract.ts` | 纯类型 + 常量：`Kojo2CompileBundle`、`Kojo2ProjectSnapshot`、`Kojo2ProjectService`、`Kojo2ProjectProblem`、workflow deps/handle。零实现、零 IO。 |
| `ui/kojo2-project-service.ts` | 契约默认实现 `createKojo2ProjectService`：编译协调、缓存、诊断汇总、组装、发布门禁。不 import 插件、不读盘、不碰 React/Monaco。 |
| `ui/kojo2-project-workflow.ts` | `mountKojo2ProjectWorkflow`：快照加载（`kernel.io`）、生命周期订阅、3 条命令、问题上账、`kernel.io.exportFile` 发布端口。 |
| `ui/kojo2-project-problems.ts` | 诊断 → 问题面板：`publishKojo2ProjectProblems` / `clearKojo2ProjectProblems`；桶键 `KOJO2_BUILD_PROBLEM_PATH='kojo2:build'`、来源 `KOJO2_BUILD_PROBLEM_SOURCE='Kojo 2.0'`。 |
| `bootstrap.ts` | `registerKojo2CompileBundle` / `kojo2CompileBundleForProject`：按 `project.adapterId` 现取游戏事实包（eraTW 已登记：adapter / registry / backend 工厂 / selectors / capability / sourceMap / fingerprint）。 |
| `ui/App.tsx` | `useEffect`（约 L1017–1063）**动态 `import('./kojo2-project-workflow')`**，挂载后把 `handle.commands` 塞进命令表、卸载 `dispose()`；App 不承载九步流程。 |

**3 条命令**（category `Kojo 2.0`，真实注册可查）：

| id | 标题 | 行为 | 实测回执（见 §6.6） |
| --- | --- | --- | --- |
| `kojo2.project.compile` | 构建 Kojo 2.0 项目 | `service.refresh('manual')` → 人话汇总（文档/Theater/目标组/错误/告警/耗时）；失败给首因 + 「详见问题面板」。 | `Kojo 2.0 项目构建完成：2 份文档 / 2 个 Theater / 1 个目标组；错误 0 · 告警 0；耗时 1ms。` |
| `kojo2.project.previewDispatch` | 预览 Kojo 2.0 调度计划 | 汇总 plan + assembly：ready/blocked target、函数名、组装单元数、`theaterErb` 仅预览份数、legacy 文件数。 | 多行 info（目标/函数/组装/预览），见 §6.6。 |
| `kojo2.project.publish` | 发布 Kojo 2.0 项目 ERB | `refresh('publish')` + `assemble()` → `publish()`；`publishBlockReason` 非空即错误回执；成功只走 `kernel.io.exportFile`，回执带落点与单元数 + 表达式恒等透传的已知缺口提示。 | `已导出：…\sandbox\exports\kojo2-project.ERB（2 个单元）…`，见 §6.6。 |

**问题桶**：项目级（无单文件落点）条目统一落 `kojo2:build` 虚拟组；**带真实 path 的条目保留自身 path**（点开即跳文件）。通道前缀 `[构建]` / `[调度]` / `[调度渲染]` / `[组装]` / `[运行时]`。与 `kojo2:project`（存储/项目分析簇）是不同 bucket key，**互不覆盖**。

**Service 口径**（实现决定，照这里读代码）：

- 相位：`idle` / `loading` / `ready` / `failed` / `stale`；失败/标脏都保留 `result` 作诊断视图。
- 缓存：单条「当前快照」缓存（非 LRU），键 = provenance 身份 + 文档有序 `(pathKey, stableHash, layerId)` + selectors + 编译模式 + projectId；键相同 ⇒ `cacheHit=true` 不重编译。
- 编译模式：固定 `requireDispatch:true` + `emitDiagnosticArtifacts:true`（多角色场景构建失败时仍能看到 ready target 的 dispatch 诊断材料）。
- 组装时机：`refresh` 在 `buildStatus==='succeeded'` 时自动 `planProjectErbAssembly` + `assembleProjectErb`；构建失败不组装（plan 诊断可见）。
- `publishable` = `phase==='ready'` ∧ build succeeded ∧ `assembly.status==='complete'` ∧ 已注入 `exportArtifact`；`publish()` 不隐式重编译（`stale` / `failed` 一律拒绝）。
- `lastGood`：上一次 `complete` 快照，只读展示、**永不可发布**；`reset()`（换项目/关项目）连 `lastGood` 一起清。
- Service 内部直接调 core `compileProject`（自己算文件身份与 `contextOf`）；`compileKojo2Project`（§1.1）仍是更轻的 Host 编排入口（测试 / 单项目复用）。

---

## 1. 公开入口清单

包名 / 落点、签名与用途。所有类型都能从对应包的 **barrel** 取（`@kojo/kojo-core` 的 `project/index.ts` 已转出 project 层全部模块，含 `erb-assembly.ts`）。

### 1.1 Host 编译编排（app 层）

| 入口 | 落点 | 签名要点 | 用途 / 边界 |
| --- | --- | --- | --- |
| `compileKojo2Project` | `packages/app/src/ui/kojo2-project-compile.ts` | `(input: Kojo2CompileProjectInput) => ProjectCompileResult` | **Host 项目编译编排入口**。Web 侧负责：文档文本只 `parseSource` 一次、复用 `pathKey`/`stableHash` 生成身份、把 `contextOf`（或缺省旧推法）注入每文件 `functionNameContext`，然后原样交给 core `compileProject`。不读盘、不造默认 familySegment。 |
| `createKojo2ProjectProvenance` | `packages/app/src/ui/kojo2-project-provenance.ts` | `(input: Kojo2ProjectProvenanceInput) => ProjectBuildProvenance` | **provenance 的单一入口**：从 adapter / registry / backend 对象派生四轴身份；缺 backend.version、任意必填 id/version 空串当场 `TypeError`；返回冻结纯数据，不 import 插件。Service 内部也用它。 |
| `kojo2ProjectFileIdentity` | `packages/app/src/ui/kojo2-project-file-identity.ts` | `(path, text, layerId?) => ProjectFileIdentity` | 文件身份（`pathKey` + `stableHash(text)`）；`compileKojo2Project` / Service 内部已用，无需外部再算。 |
| `kojo2FunctionNameContextForFile` | `packages/app/src/ui/kojo2-file-context.ts` | `(project, file, familySegmentOf?) => FunctionNameContext` | 旧推法：从 `GameProject.charaIndex[].kojoDir` 最长前缀推 charNo + Host 注入 familySegment。workflow 的 `contextOf` 复用它。 |
| `resolveKojo2FunctionNameContext` | `packages/app/src/ui/kojo2-project-analysis.ts` | `(contextOf \| undefined, { path, layerId }) => FunctionNameContext` | 新推法（D3）：一份文档同步求值一次，显式空串保留。 |

`Kojo2CompileProjectInput` 的关键字段：

```ts
{
  projectId: string;
  provenance: ProjectBuildProvenance;      // 用 createKojo2ProjectProvenance()，别手抄
  project: GameProject | null;             // 旧推法用；contextOf 给定时不参与
  documents: readonly { path: string; text: string; layerId?: string }[];
  adapter: GameAdapter;                    // eraTW: ERATW_GAME_ADAPTER
  backend: KojoEmitBackend;                // eraTW: createEratwEmitBackend(...)
  registry: TargetRegistry;                // eraTW: ERATW_TARGET_REGISTRY
  familySegmentOf?: (file) => string | undefined;   // 旧推法；缺席 = 没有事实
  contextOf?: (file: { path; layerId }) => FunctionNameContext;  // 新推法（取代 project+familySegmentOf）
  dispatchSelectors?: DispatchSelectors;   // eraTW: ERATW_DISPATCH_SELECTORS
  requireDispatch?: boolean;               // 发布模式 true；预览模式可 false
  runtimeMatchPolicy?: RuntimeMatchPolicy | null;  // 缺省读 registry
  emitDiagnosticArtifacts?: boolean;       // true = 构建失败时也产出诊断用 dispatchErb（不可发布）
  parse?: (text) => KojoFile;              // 测试/复用口，缺省 core parseSource
}
```

### 1.2 运行时选择（core + app 诊断包装）

| 入口 | 落点 | 签名要点 | 用途 / 边界 |
| --- | --- | --- | --- |
| `selectRuntimeTheater` | `packages/kojo-core/src/project/runtime-matcher.ts` | `(request: RuntimeSelectionRequest) => RuntimeSelection` | 从 `LinkedProject.groups` 选唯一 Theater。**只读 parser 带来的 location/time facts，不重解析源文本、不看文件顺序**。状态：`selected` / `no-match` / `ambiguous` / `not-linked`。 |
| `resolveKojo2RuntimeSelection` | `packages/app/src/ui/kojo2-runtime-diagnostics.ts` | `(request) => { selection; problems }` | Host 运行时入口：选择 + 可见问题一次返回，避免只拿 `selected` 吞掉失败。Service 的 `previewRuntime()` 内部调它。 |
| `kojo2RuntimeSelectionProblems` | 同上 | `(selection) => readonly Kojo2RuntimeProblem[]` | 把诊断映射成 `severity:'error'` 的问题行（`code/message/canonicalId/candidateTheaterIds`）。 |

`RuntimeSelectionRequest` 字段：`linkedProject`、`canonicalId`、`location`、`time`、`locationTags?`、`timeTags?`、`timeValue?`（eraTW 时辰数值，如 `TIME:2`）、`runtimeMatchPolicy?`、`engineFunctionName?`（多角色时点名函数名才唯一）。

匹配语义（ADR-0012）：`unrestricted` 任意命中；`exact`/`named` 必须逐字命中（policy 展开的 alias/parent/range 由 `RuntimeMatchPolicy` 统一做，未登记名字 fail-closed）；特异性 exact location=2、named time=1，**最高分唯一才 selected**。

### 1.3 Dispatch 计划（core）

| 入口 | 落点 | 签名要点 | 用途 / 边界 |
| --- | --- | --- | --- |
| `buildProjectDispatchPlan` | `packages/kojo-core/src/project/dispatch-plan.ts` | `(linkedProject, policy?) => ProjectDispatchPlan` | 纯数据计划。`targets[]` 按 `canonicalId + functionName` 拆分；`status:'ready' \| 'blocked'`；`branches[]` 按 specificity 降序。**plan 是最终组装的唯一依据**。`compileProject` 内部已算好一份（`result.dispatchPlan`），编辑器一般直接用结果里的，无需重算。 |
| `dispatchTargetPlanOf` | 同上 | `(plan, canonicalId, functionName?) => DispatchTargetPlan \| null` | 按目标取计划；**多个同 canonical 且未点名 functionName 时返回 null（不猜）**。 |

plan 级诊断码：`dispatch/duplicate-group`（error）、`dispatch/no-supported-theater`（error）、`dispatch/ambiguous-branches`（error）、`dispatch/legacy-machine-skipped`（warning）。

### 1.4 最终产物组装（core，`erb-assembly.ts`）

| 入口 | 签名 | 用途 / 边界 |
| --- | --- | --- |
| `planProjectErbAssembly` | `(result: ProjectCompileResult) => ProjectErbAssemblyPlan` | 纯计划：`dispatchUnits`（`dispatchPlan.targets` 中 `status==='ready'` 的 `canonicalId+functionName`）、`legacyFiles`（Project IR 中 `origin==='legacy-machine'` 按 fileId 聚合，带 `path` 供 Host 定位）、`previewOnlyTheaterCount`（只报数量，**theaterErb 不进组装**）、`diagnostics`。任何构建结果都可读（构建失败也给，供诊断视图）。 |
| `assembleProjectErb` | `({ result, legacyErb? }) => ProjectErbAssembly` | 产物：`units`（`kind:'dispatch' \| 'legacy-m1'`）、`plan`、`diagnostics`。`status==='complete'` **仅当诊断为空**；`incomplete` 只是诊断材料，不是可发布产物。 |

组装诊断码（全部 error）：`assembly/build-failed`、`assembly/dispatch-incomplete`、`assembly/legacy-missing`、`assembly/legacy-unknown`、`assembly/duplicate-runtime-function`。语义细节见 `docs/KOJO-2.0-ARTIFACT-ASSEMBLY.md`。

### 1.5 M1 legacy 单文件入口（core）

| 入口 | 签名要点 | 用途 / 边界 |
| --- | --- | --- |
| `compileKojoSource` | `({ source, filePath?, adapter, backend, view?, ... }) => CompileKojoSourceResult` | 源码文本 → `ok/erb/sourceMap/diagnostics/slots/file`。内部 = lex → parse → `compileKojoFile`。workflow 的 `compileLegacy` 端口用它。 |
| `compileKojoFile` | `(file: KojoFile, options: CompileKojoFileOptions) => CompileKojoResult` | 已解析 AST → 产物。**legacy `# 机` 文件的 ERB 只能走这条路径**（项目编译不产它的字节，plan 里只给 warning）。 |

口径：`ok === false ⇒ erb === ''`（fail-closed，不产半成品字节）；成功产物 = `lines.join('\n') + '\n'`。

### 1.6 eraTW adapter 事实（Host 注入用，`@kojo/plugin-eratw-adapter`）

| 导出 | 用途 |
| --- | --- |
| `ERATW_GAME_ADAPTER` | `GameAdapter`，纯数据、深冻结。 |
| `ERATW_TARGET_REGISTRY` | `TargetRegistry`（含 `runtimeMatchPolicy`）。 |
| `ERATW_CAPABILITY` / `ERATW_SOURCE_MAP` | provenance 的 `capability` / `sourceMapPolicy`。 |
| `createEratwEmitBackend({ compileExpression, charNo?, familySegment?, segments?, profile?, adapterProfile? })` | `KojoEmitBackend`；**`compileExpression` 必填**（2.0 表达式 → ERB 表达式的 Host 管线）。 |
| `ERATW_DISPATCH_SELECTORS` | `{ locationExpr: 'NAME_FROM_PLACE(CFLAG:MASTER:現在位置)', timeExpr: 'TIME:2' }`（语料取证）。 |
| `ERATW_TIME_BAND_VALUES` / `ERATW_RUNTIME_MATCH_POLICY` | 时辰数值 / 别名-父子-区间策略（matcher 与 dispatch 共用同一份）。 |

> 注意：`createEratwEmitBackend` 的 `version` 已声明为 `'1'`，provenance 的 `backendVersion` 必须与之一致；helper 会从 backend 对象取，不要手写。

### 1.7 Application Service 面（app 层，本批）

| 入口 | 落点 | 用途 |
| --- | --- | --- |
| `createKojo2ProjectService(deps)` | `ui/kojo2-project-service.ts` | 契约默认实现：`refresh` / `markStale` / `previewRuntime` / `assemble` / `publish` / `publishBundle` / `reset` / `dispose` / `state` / `subscribe`。 |
| `mountKojo2ProjectWorkflow(deps)` | `ui/kojo2-project-workflow.ts` | 返回 `{ commands, service, dispose }`；`enabled()===false` 时零动作（不注册命令、不订阅、不 refresh）。 |
| `publishKojo2ProjectProblems` / `clearKojo2ProjectProblems` | `ui/kojo2-project-problems.ts` | 项目问题整份替换 / 清空 `kojo2:build` bucket。 |
| `registerKojo2CompileBundle` / `kojo2CompileBundleForProject` | `bootstrap.ts` | 组合根登记 / 现取游戏事实包；查不到 = 该游戏暂无 2.0 编译面（明确降级，不回落到默认 adapter）。 |

---

## 2. 数据流（有序步骤）

**① 项目 + 文档清单**（Host）
从项目口上根 / 会话附加根 / `ErbIndex` 清单里取 `.kojo2` 文档（`path + text + layerId?`）。未打开文件走内核只读通道读文本；已打开且脏的文档以 Monaco model 文本为准（现有 `editor-global-providers` 2.0 装配段同口径）。workflow 里 = `load()` 端口（`listSourceFiles` + `collectKojo2ProjectDocuments`）。

**② 文件身份**（core / app）
每份文档：`kojo2ProjectFileIdentity(path, text, layerId)` = `pathKey`（平台感知：Windows 折叠大小写）+ `stableHash(text)` + layerId。`fileId` / `theaterId` 的组合归 core，Host 不手拼。

**③ 函数名上下文**（Host 事实注入）
`contextOf({ path, layerId })` 返回 `{ charNo?, familySegment? }`：
- `charNo`：角色号（eraTW 从 `charaIndex.kojoDir` 最长前缀推，或 Host 直接知道）；
- `familySegment`：**显式 `''` = 标准版**；**缺键 = 没有事实**（两者绝不等价）。

**④ 项目编译**（core `compileProject`）
`compileKojo2Project({ provenance, documents, adapter, backend, registry, contextOf, dispatchSelectors: ERATW_DISPATCH_SELECTORS, requireDispatch })`：
- 每个文件 `parseSource` 一次（失败不阻断其它文件，`analysisStatus:'partial'`）；
- Project IR → 版本校验（四轴逐字）→ TargetRegistry 解析 → 跨文件链接（含 exact duplicate / 多角色拆分）；
- 显式 Theater 产 `theaterErb`（预览/兼容视图）；plan → `dispatchErb`（最终调度）；legacy `# 机` 不进 dispatch。

产物：`ProjectCompileResult`，关键字段：

| 字段 | 说明 |
| --- | --- |
| `build.buildStatus` | `succeeded` / `failed`（版本错配、链接失败、`requireDispatch` 下 dispatch 失败等都会 failed） |
| `build.analysisStatus` | `complete` / `partial`（解析失败文件数与 build 分离） |
| `build.projectIR` | 文件 / Theater 事实（`origin`、`fileId`、`path`、`sourceSpan`），组装与诊断下钻用 |
| `build.linkedProject` | `LinkedProject \| null`，**运行时选择的唯一输入** |
| `build.diagnostics` | `ProjectDiagnostic[]`（带 `primary.fileId/path/span`，可上到问题面板） |
| `theaterErb` | 单 Theater 产物（预览/兼容；**不发布**） |
| `dispatchErb` | 最终 dispatch 产物（`canonicalId + functionName + erb`；多角色拆多份） |
| `dispatchPlan` / `dispatchDiagnostics` | 计划本体 / 计划级诊断（任何构建结果都可读） |
| `dispatchBackendDiagnostics` | dispatch 渲染失败诊断（`KojoDiagnostic`，见 §4 的坐标处理） |
| `complete` | 所有应产出的 Theater 都成，且 build succeeded（**预览口径**） |
| `dispatchComplete` | 所有可分派 target 都渲染成，且 build succeeded（没有可分派 target 的 legacy-only 项目也算 true） |

**⑤ 运行时选择**（core matcher）
`result.build.linkedProject === null` ⇒ 构建失败，不做运行时选择（直接上诊断）。否则：
`selectRuntimeTheater({ linkedProject, canonicalId, location, time, timeValue?, engineFunctionName? })`。
Host 多角色场景必须传 `engineFunctionName`（如 `M_KOJO_ENCOUNTER_K12`）才唯一；否则跨角色同条件判 `ambiguous`（不按文件顺序决胜）。诊断统一走 `resolveKojo2RuntimeSelection` 拿 `problems`。Service 侧封装为 `previewRuntime(request)`（当前无 GUI，见 §6）。

**⑥ 组装计划**（core assembly）
`planProjectErbAssembly(result)`：得到 `dispatchUnits`（应发布的 dispatch 单元）+ `legacyFiles`（**Host 必须供给的 legacy 文件，含 fileId 与 path**）+ `previewOnlyTheaterCount` + 诊断。

**⑦ Host 用 M1 路径补 legacy 字节**
对 `plan.legacyFiles` 逐一：读该文件原文 → `compileKojoSource`（或 `parseSource` + `compileKojoFile`）→ `{ fileId, erb }` 放进 `legacyErb[]`。`ok:false` 说明这份 legacy 文件本身编不过：把它的 `diagnostics` 上问题面板，并且**不要**把它塞进 `legacyErb`（assembly 会以 `legacy-missing` 判定不完整）。Service 里 = `snapshot.compileLegacy(document)` 端口，找不到正文/返回 null 会追加可见的 `assembly/legacy-missing` 问题。

**⑧ 组装**（core assembly）
`assembleProjectErb({ result, legacyErb })`：`units = dispatch units + legacy units`；同一运行时函数名重复会被丢弃并给 `duplicate-runtime-function`；未知 legacy fileId 给 `legacy-unknown`；缺期望文件给 `legacy-missing`。

**⑨ 发布 / 预览**
- 发布：`assembly.status === 'complete'` 才允许写盘；写盘只能走既有 `exportFile` 通道（对话框即授权，铁律 6），**不得**自己拼任意目标路径。Service 的 `publish()` 先把 `publishBundle()` 的 `fileName + utf8 bytes` 交给 `deps.exportArtifact`，`null` = 用户取消（明确回执，不静默）。
- 预览：可以直接用 `assembly.units`（按 `kind` 分组渲染）；`theaterErb` 只用于「单 Theater 预览」，同时把 `previewOnlyTheaterCount` 报给用户看，避免误以为已发布。
- 构建失败 / 不完整：保留上一次成功产物（`lastGood`）并标「已过期」，贯穿 UI 显式提示，不静默替换成空。

---

## 3. Host 必须注入的事实

| 事实 | 从哪来 | 注入口 | 漏了会怎样 |
| --- | --- | --- | --- |
| `provenance` | `createKojo2ProjectProvenance({ adapter, registry, backend, capability, sourceMapPolicy })` | `compileKojo2Project.provenance`；本批由 Service 从 `Kojo2CompileBundle` 派生 | 手抄字段极易错配 ⇒ `buildStatus:'failed'` + `version-mismatch`，且离接入点很远 |
| 每文件 `functionNameContext` | `contextOf`（或旧 `project` + `familySegmentOf`） | `compileKojo2Project.contextOf`；workflow 的 `contextOf` | 缺 `familySegment` ⇒ `function-name-context-missing`，build failed；缺 charNo ⇒ 函数名无法解析 |
| `dispatchSelectors` | `ERATW_DISPATCH_SELECTORS`（本批经 bundle `dispatchSelectors`） | `compileKojo2Project.dispatchSelectors` | `requireDispatch:true` 时 fail-closed（`dispatchBackendDiagnostics` 有诊断，无 theaterErb/dispatchErb）；`false` 时 `dispatchErb` 为空、`dispatchComplete:false` |
| `requireDispatch` | 模式选择：发布 = `true`，预览 = `false` | `compileKojo2Project.requireDispatch`；Service 固定 `true` | 发布模式下漏了它 ⇒ 半成品 dispatch 不会阻断构建（构建 succeeded 但 assembly 仍会判 `dispatch-incomplete`，不如提前拦） |
| legacy ERB | Host 用 M1 路径编译 `plan.legacyFiles`（本批 = workflow 的 `compileLegacy`） | `assembleProjectErb.legacyErb` | `assembly/legacy-missing` ⇒ 永远 `incomplete`，发布被拒 |
| `compileExpression` | 生产：v1 表达式管线；测试/当前：恒等透传（`kojo2IdentityCompileExpression`） | `Kojo2CompileBundle.createBackend` 的 deps | 缺省不填会编译报错；恒等透传只保证结构/诊断成立，产物表达式形状不等于最终发布口径（已知缺口） |
| `timeValue` / `locationTags` / `timeTags` | 运行时引擎状态（eraTW：`TIME:2`、地点名） | `selectRuntimeTheater` / `service.previewRuntime` | 只影响运行时选择精度；missing = 只按 raw 名匹配 |

**`contextOf` 的语义红线**（`kojo2-project-analysis.ts` 同款）：

```ts
// 标准版：显式空串（不是缺键）
contextOf: () => ({ charNo: '12', familySegment: '' })
// 别的家族：真实家族段
contextOf: (file) => ({ charNo: charNoOf(file.path), familySegment: familyOf(file.path) })
// 推不出来：不要编，给 {}
contextOf: () => ({})
```

**本批已由 workflow 自动完成的部分**：`mountKojo2ProjectWorkflow` 从 `bootstrap.kojo2CompileBundleForProject(project)` 现取事实包（adapter / registry / backend 工厂 / selectors / capability / sourceMap / fingerprint）；Service 内部用 `createKojo2ProjectProvenance` 派生 provenance；`contextOf` 复用 `kojo2FunctionNameContextForFile` 推 charNo，并在没有家族事实时**显式兜底标准版 `familySegment: ''`**（`deps.familySegmentOf` 可覆盖）；legacy 字节由 `compileLegacy` 端口用 `compileKojoSource` 补；发布模式固定 `requireDispatch:true` + `emitDiagnosticArtifacts:true`。

---

## 4. 诊断通道 → UI 落点

| 通道 | 形状 | 典型码 | 当前落点（本批已接） |
| --- | --- | --- | --- |
| `result.build.diagnostics` | `ProjectDiagnostic`（`kind/severity/message/primary{fileId,path,span,role}/related[]`） | `target-unknown`、`target-unsupported`、`registry-binding`、`function-name-context-missing`、`function-name-context-invalid`、`duplicate-theater`、`version-mismatch`、`project-incomplete`、`core/project/parse-failed` | `channel:'build'`；`primary.role==='project'` ⇒ 无 path ⇒ `kojo2:build` 组；否则保留 `path/line/column` 进**对应文件**组 |
| `result.dispatchDiagnostics` | `DispatchPlanDiagnostic`（`code/severity/message/canonicalId/functionName/candidateTheaterIds`） | `dispatch/duplicate-group`(error)、`dispatch/no-supported-theater`(error)、`dispatch/ambiguous-branches`(error)、`dispatch/legacy-machine-skipped`(warning) | `channel:'dispatch'`；用 `candidateTheaterIds` 找第一个 theater → fileId → path 上到文件（不冒充单行），找不到落 `kojo2:build` |
| `result.dispatchBackendDiagnostics` + `result.backendDiagnostics` | `KojoDiagnostic`（`code/severity/message/span`，**无 path**） | `unit/backend-incomplete`、`unit/*` | `channel:'dispatch-backend'`；Service `locateSpan()` 用 `dispatchPlan` branch `sourceSpan+fileId` / `linkedProject.theaters` 反查文件与行列，**查不到落项目级（不猜文件）** |
| runtime `problems`（`resolveKojo2RuntimeSelection`） | `Kojo2RuntimeProblem`（`code/message/canonicalId/candidateTheaterIds`） | `runtime/not-linked`、`runtime/duplicate-group`、`runtime/no-match`、`runtime/ambiguous` | `channel:'runtime'`；当前无 GUI，留待下一阶段选择器；触发时建议 toast + 项目级 |
| `plan.diagnostics` / `assembly.diagnostics` | `ProjectAssemblyDiagnostic`（`code/severity/message/fileId/canonicalId/functionName`，全 error） | `assembly/build-failed`、`assembly/dispatch-incomplete`、`assembly/legacy-missing`、`assembly/legacy-unknown`、`assembly/duplicate-runtime-function` | `channel:'assembly'`；带 fileId 的上文件组，否则 `kojo2:build`；**阻止发布**（`publishBlockReason` 取第一条） |

当前接线面（接入时复用，别另造第二套）：

- `packages/app/src/ui/kojo2-project-problems.ts`：`publishKojo2ProjectProblems(problems)` 整份替换 `kojo2:build` bucket；`clearKojo2ProjectProblems()` 只清本簇。`EditorProblem` 映射口径：项目级 → 虚拟路径 + 行 1 + 通道前缀；有 path → 保留 path + `shortPath(path):line`；有 column → 零宽 `span`。
- `packages/app/src/ui/kojo2-project-service.ts`：四类 core 诊断 → `Kojo2ProjectProblem` 的**唯一映射**（`problemOfBuildDiagnostic` / `problemOfDispatchDiagnostic` / `problemOfBackendDiagnostic` / `problemOfAssemblyDiagnostic` / `problemOfRuntimeProblem`），含 `locateSpan()` 的无 path 反查。
- `packages/app/src/ui/kojo2-problem-wiring.ts`（既有）与 `ui/problem-store.ts`：`KOJO2_PROJECT_PROBLEM_PATH`、`KOJO2_DIAGNOSTICS_SOURCE`、按文件编译缓存、`setProjectScanProblems` —— 继续服务 v1 / 2.0 编辑期诊断；与 `kojo2:build` 是不同 bucket key，**互不覆盖**。
- `App.tsx` 的 `notify({ kind, message })`：命令回执通道（一次性 toast）。
- 清账时机：`project.closed` 与 workflow `dispose()` → `clearKojo2ProjectProblems()`；不碰 `kojo2:project` 等其它簇。

**总结口径**：单文件可定位的 → 文件行（保留 path）；跨文件 / 目标级 / 组装级 / 反查不到 → `kojo2:build` 虚拟组；用户主动触发的命令失败 → toast + 问题面板。任何一条都**不得静默吞掉**（铁律 4）。

---

## 5. 职责边界

| 产物 | 内容 | 是否发布 | 谁负责 |
| --- | --- | --- | --- |
| `theaterErb` | 每个已解析 Theater 的单体 ERB（可含同名 `@函数`） | **不发布**；预览 / 兼容 / 调试 | `compileProject` |
| `dispatchErb` | 每个 `canonical target × functionName` 一份的最终调度 ERB（含条件与 `CALL`） | **是最终调度产物**，经 assembly 进 units | adapter `renderDispatch`（core 编排） |
| legacy `# 机` ERB | 旧文件的原始字节 | 发布，但**必须由 Host 用 M1 单文件路径产出并显式传入** | Host + `compileKojoSource` / `compileKojoFile` |
| `assembly.units` | dispatch units + legacy units | 发布/预览的唯一字节来源 | `assembleProjectErb` |
| `assembly.status` | `complete` / `incomplete` | **判据**：只有 `complete` 可发布 | `assembleProjectErb`（Service 门禁） |

坑位清单：

1. **theaterErb 绝不拼接进最终产物**：多个 Theater 可产生同名 `@函数`，拼起来就是重复定义运行时函数；`plan.previewOnlyTheaterCount` 只报数量。
2. **跳过 legacy ≠ 完成**：plan 的 `dispatch/legacy-machine-skipped` 只是 warning（不拖累 dispatch 产物），但 assembly 仍要求 Host 补齐 legacy 字节，缺一份就是 `incomplete`。
3. **构建失败 / plan 有 error / dispatchErb 与 ready target 对不上 / legacy 缺文件**，任何一条都 ⇒ `incomplete`。
4. **同一运行时函数名在最终 units 只能出现一次**：出现重复由 assembly 丢弃并报 `duplicate-runtime-function`（不发布"看似完整"的重复定义）。
5. 多角色按 `functionName` 组织：K12/K13 各自一份 dispatch unit；matcher 不传 `engineFunctionName` 时跨角色同条件为 `ambiguous`（这是正确行为，不是 bug）。

---

## 6. 接线 TODO（本批已落地项 + 下一阶段）

打勾 = **本批（2026-11-03）已落地**，注明落点；未打勾 = 下一阶段。

### 6.1 编译入口挂载

- [x] **Application Service 承载九步流程**（替代原计划的 `kojo2-project-compile-pass.ts`）：`ui/kojo2-project-service-contract.ts`（契约）+ `ui/kojo2-project-service.ts`（`createKojo2ProjectService`）。身份、`contextOf`、编译、plan、legacy 补齐、assemble、发布门禁全在 Service 内；缓存键 = provenance 身份 + 文档有序身份 + 模式。
- [x] **组合根提供游戏事实包**：`bootstrap.ts` 的 `registerKojo2CompileBundle` / `kojo2CompileBundleForProject`；eraTW 已登记（与 `registerKojo2Backend` 同源）。UI/Service 不静态 import 插件。
- [x] **App 挂载**：`ui/App.tsx` 的 `useEffect`（约 L1017–1063）**动态 `import('./kojo2-project-workflow')`** → `mountKojo2ProjectWorkflow({ kernel, extraRoots, notify })` → `setKojo2ProjectCommands(handle.commands)`；卸载 `dispose()`。未走 `mountProjectScan` 选项（扫描不承载编译）。
- [x] **分析与编译共享同一注入面**：workflow 的 `contextOf` 复用 `kojo2FunctionNameContextForFile`（与 `Kojo2ProjectAnalysisResult.functionNameContexts` 同一条 Host 边界）。
- [ ] 后续可选：若希望扫描轮次与编译严格同拍（复用同一份文档清单，省一次列文件/读文本），再在 `project-diagnostics.ts` 的 deps 上加 additive 出口；当前是两趟各自取快照（正确性优先）。

### 6.2 project session 生命周期

- [x] `project.opened` → `refresh('open')` 重编译；`project.closed` → `service.reset()` + `clearKojo2ProjectProblems()`（`ui/kojo2-project-workflow.ts` 生命周期段）。
- [x] 世代号：Service `generation` 递增，换项目/重入后迟到的 `load()`/编译结果被丢弃（`reset()` 也 `generation += 1`）。
- [x] 编辑器内容变更：`file.changed` → `service.markStale([path])`，**只标脏不重编译**；下一次「构建」/发布前 refresh 才重跑。
- [x] 自动触发：workflow 挂载即 `refreshQuietly('open')` 一次 + `project.opened` 再触发；失败走人话通知（`catch` 包装，不留 unhandled rejection）。
- [ ] 索引就绪后再触发一轮（当前挂载即取快照，可能与首轮索引完成有秒级错位；错位只会导致一次多余编译，不影响正确性）。

### 6.3 问题面板消费

- [x] **诊断 → 问题面板**：`ui/kojo2-project-problems.ts` 把 Service 的 `Kojo2ProjectProblem[]` 整份上账到 `kojo2:build` bucket；`onState` 每次状态变化都刷新；`project.closed` / `dispose` 清账。
- [x] **四类 core 诊断形状 → 单一领域形状**：`ui/kojo2-project-service.ts` 的 `collectProblems`（build / dispatch / dispatch-backend / assembly / runtime 五通道）。
- [x] **无 path 的 `KojoDiagnostic` 反查**：`locateSpan()` 用 `dispatchPlan` branch `sourceSpan+fileId` / `linkedProject.theaters` 找文件与行列；查不到落项目级（不猜文件）。
- [x] 下钻信息随行携带：`fileId` / `canonicalId` / `functionName` / `candidateTheaterIds` 都在 `Kojo2ProjectProblem` 上。
- [ ] 面板里对 `kojo2:build` 组的点击跳转（当前有 path 的条目才可跳文件；项目级组暂无"点开看原因"的详情页）。

### 6.4 命令 / 预览入口

- [x] **3 条命令注册**：`kojo2.project.compile` / `kojo2.project.previewDispatch` / `kojo2.project.publish`（category `Kojo 2.0`，`ui/kojo2-project-workflow.ts`）。全部给人话回执；失败带首因 +「详见问题面板」。
- [x] **发布门禁**：`publishBlockReason` 优先于人话；`publish()` 只写 `exportFile`，取消/失败都有明确回执；成功回执带落点 + 单元数 + 表达式恒等透传的已知缺口提示。
- [x] 命令前置检查：没项目 / 该游戏没 2.0 编译面 ⇒ info 人话，不报错（`preflight()`）。
- [ ] 预览面板 GUI：`kojo2-preview-entry.ts` 尚未接 `assembly.units`（当前「预览调度计划」只发通知）；下一阶段接面板并按 `kind` 分组显示 + `previewOnlyTheaterCount` 提示。
- [ ] 发布落点 UI：当前只用 `exportFile`（原生对话框），没有"最近发布位置/覆盖确认"等产品化交互。
- [ ] 运行时选择 GUI：`service.previewRuntime()` 已备好（含 problems），Host 还没有 location/time 引擎状态来源，选择器面板留待下一阶段。

### 6.5 增量与失败回退

- [x] **快照缓存**：Service 单条快照缓存（键含 provenance + 文档有序 `(pathKey, stableHash, layerId)`），未变则 `cacheHit=true` 复用 `result/plan/assembly`。
- [x] **失败回退**：`lastGood` 保留上一次 `complete` 的 `plan/assembly`（只读展示、永不可发布）；`reset()` 连 `lastGood` 一起清，不跨项目复用。
- [x] `requireDispatch` 发布模式固定 `true`；`emitDiagnosticArtifacts:true` 让失败构建仍能展示 ready target 的 dispatch 诊断材料。
- [ ] 按文件增量：core 无增量 API，`markStale(paths)` 的 `paths` 目前只是预留（整项目重编）；未来若做，需要 core 侧增量契约。
- [ ] 编译下放 worker / `kernel.compute`：当前同步编译跑在命令调用栈（测试项目 1–2ms 可接受；大项目需评估）。
- [x] **P2 观察（见 §6.6）已修复**：失败重建时 Service 新编译分支已清空 `assembly/assemblyProblems/assemblyMs`（2026-11-03 收尾，含回归用例「成功后再构建失败：旧 assembly 立即清空，失败首帧即给 assembly/build-failed」）。

### 6.6 验证

**单测（本批，真实读数）**：

| 文件 | 用例数 | 读数 |
| --- | --- | --- |
| `packages/app/tests/kojo2-project-service.test.ts` | 21 | passed（含 P2 修复回归用例） |
| `packages/app/tests/kojo2-project-workflow.test.ts` | 9 | passed |
| `packages/app/tests/kojo2-project-problems.test.ts` | 9 | passed |

合计 **39 passed**（`node node_modules/vitest/vitest.mjs run packages/app/tests/kojo2-project-{service,workflow,problems}.test.ts --maxWorkers=2`）。

**真机 E2E（2026-11-03，调试宿 Web/headless）**：

- 环境：`node tools/debug-cli.mjs serve --headless`（调试宿 :17777 / vite :4173 / 无头 CDP :9335，会话 `7e2510c7`）；`open-project C:\tmp\kojo-e2e\project`（只读）。
- 工程：`fixtures/mini-game` 的副本 + 两份 `.kojo2`：
  - `ERB/口上・メッセージ関連/個人口上/001 Remu/K1_shrine.kojo2` = `【剧场：初见｜神社】`（charaIndex 推出 charNo=1）；
  - `ERB/口上・メッセージ関連/個人口上/002 Nigo/K2_school.kojo2` = `【剧场：初见｜学校】`（charNo=2）。
- `commands` 断言：三条命令全部在命令表（`kojo2.project.compile` / `previewDispatch` / `publish`）。
- `kojo2.project.compile` 真实回执：**`Kojo 2.0 项目构建完成：2 份文档 / 2 个 Theater / 1 个目标组；错误 0 · 告警 0；耗时 1ms。`**
- `kojo2.project.previewDispatch` 真实回执（多行）：
  ```
  Kojo 2.0 调度计划（阶段 ready）
  dispatch target：2 个 ready / 0 个 blocked
  函数：M_KOJO_ENCOUNTER_K1、M_KOJO_ENCOUNTER_K2
  组装：2 个单元（dispatch 2 / legacy 0），状态 complete
  theaterErb：2 份仅预览（不进入最终产物）
  ```
- `kojo2.project.publish` 真实回执：**`已导出：C:\Users\123\AppData\Local\Temp\kojo-debug\sessions\7e2510c7\sandbox\exports\kojo2-project.ERB（2 个单元）（已知缺口：表达式端口当前为恒等透传，v1 表达式管线尚未接入，产物适合结构/联调预览；正式发布前请接入真实表达式管线后复验。）`**
  - 落点验证：调试宿沙盒 exports 目录真实文件 619 bytes；首行 `;kojo2: M3 dispatch eratw.event.初见`，随后 `@M_KOJO_ENCOUNTER_K1` + `IF (… == "博麗神社" || … == "神社")` → `CALL M_KOJO_ENCOUNTER_K1__D1`。**全程没有写任意路径**（Workflow 只经 `kernel.io.exportFile`）。
- 失败路径（额外加一份 `K1_broken.kojo2` = `【剧场：不存在的目标｜神社】`）：
  - compile 回执：`Kojo 2.0 项目构建失败：未知 Theater 目标「不存在的目标」。可用目标：初见、训练、读档、商店、购买、指令、训练结束、回合末、指令结束（core/target/unknown）——详见问题面板。`
  - 问题面板真实行（`workbench.problems`）：`001 Remu/K1_broken.kojo2:1`，来源 `Kojo 2.0`，文案 `[构建] 001 Remu/K1_broken.kojo2:1 未知 Theater 目标…`，码 `core/target/unknown`（状态栏 `✕1 ⚠2 ℹ6`）。
  - publish 回执：`无法发布 Kojo 2.0 项目 ERB：未知 Theater 目标「不存在的目标」…（详见问题面板）`；随后问题面板出现 `kojo2:build` 组：`[组装] 项目构建状态为 failed（analysisStatus=complete）：构建成功是发布前提，拒绝组装最终 ERB。`（码 `assembly/build-failed`）。此时 exports 目录**没有新增写入**（仍只有上一次成功那份 619B）。
- 恢复路径：删掉 broken 文件 → 再 compile：`Kojo 2.0 项目构建完成：2 份文档 / 2 个 Theater / 1 个目标组；错误 0 · 告警 0；耗时 2ms。`，`kojo2:build` 组消失（空数组销账，不留幽灵组）。
- 截图（`C:\tmp\kojo-e2e\`）：`01-compile-success.png`、`02-preview-dispatch.png`、`03-publish.png`、`03b-publish-toast.png`（调度计划 + 已导出 toast）、`04b-problems-panel.png`（失败构建的问题面板：`[构建]` 行 + 失败 toast）、`05-publish-blocked-problems.png`（`kojo2:build` 的 `[组装]` 行）、`06-recovered.png`。
- 收工：`node tools/debug-cli.mjs stop`（`[clean]` 已收；会话目录已删，无常驻调试进程）。

**E2E 观察（只报告，不改代码）**：

1. **P2 · 失败重建不清旧 `assembly`（已修复）**：`ui/kojo2-project-service.ts` 的 `refresh()` 新编译分支现在在 `buildStatus:'failed'` 时清空 `assembly/assemblyProblems/assemblyMs`，失败首帧即出现 `[组装] assembly/build-failed`；`lastGood` 仍只读保留。回归用例已加在 `packages/app/tests/kojo2-project-service.test.ts`。
2. **P2 · 调试 CLI 首次 `open-project` 误报**：首次打开（冷启动，欢迎页 → 项目相位 >1.5s）时 `classifyOpenFailure` 的"回流欢迎页"宽限判死，命令 exit 1；实际项目已开（`state().phase='project'`、待写权限弹窗）。属调试工具判据时序问题，不影响产品；重跑 `open-project` 幂等即通过。
3. **P3 · fixture 缺 v1 辅助文件**：调试宿日志出现 `read_file_bytes_raw: 文件不存在：C:\tmp\kojo-e2e\project\plugins\tw_csv_chs.xml`。`fixtures/mini-game` 没有该文件，属 v1 侧（非 3 条新命令）的可见降级；不影响本次编译/预览/发布。

**已知缺口（保留，下一阶段处理）**：

- **表达式端口恒等透传**：`kojo2IdentityCompileExpression` 只保证结构/诊断成立；发布成功回执已显式提示。接真实 v1 `lowerExpression` 后需复验产物表达式形状。
- **运行时预览无 GUI**：`previewRuntime` 已实现，缺引擎 location/time 状态来源与选择器面板。
- **`KojoDiagnostic` 无 path**：已在 Service 内用 `locateSpan()` 尽可能反查；反查不到即项目级（不猜文件），仍无法覆盖全部渲染失败场景。
- **发布落点无产品化 UI**：目前只走原生保存对话框。

---

## 7. 最小可运行示例

> **生产接线不要再手拼九步**：用 §0.1 的 `mountKojo2ProjectWorkflow` / `createKojo2ProjectService`（本批已接）。
> 本节保留为**底层拼装形态**（理解九步、测试、或无 Service 的宿主复用）。

以下代码可直接内联进宿主模块（已按真实导出名核对；`compileKojo2Project` 与 helper 在 app 层，其余来自 core / adapter barrel）。

```ts
import {
  assembleProjectErb,
  compileKojoFile,
  parseSource,
  planProjectErbAssembly,
  resolveKojo2RuntimeSelection,
  type KojoFile,
  type ProjectCompileResult,
  type ProjectLegacyErbInput,
} from '@kojo/kojo-core';
import {
  createEratwEmitBackend,
  ERATW_CAPABILITY,
  ERATW_DISPATCH_SELECTORS,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '@kojo/plugin-eratw-adapter';
import { compileKojo2Project } from './kojo2-project-compile';
import { createKojo2ProjectProvenance } from './kojo2-project-provenance';

export interface EditorProjectDocument {
  readonly path: string;
  readonly text: string;
  readonly layerId?: string;
}

/** 编辑器侧的一次「构建 + 组装」（发布前调用；预览可传 requireDispatch:false） */
export function buildEditorProject(input: {
  readonly documents: readonly EditorProjectDocument[];
  readonly legacyDocuments: readonly EditorProjectDocument[]; // 可从 plan.legacyFiles 筛出来
  readonly requireDispatch: boolean;
  readonly readText: (path: string) => string; // 宿主只读通道（内核 io 同步包装）
}): {
  readonly result: ProjectCompileResult;
  readonly plan: ReturnType<typeof planProjectErbAssembly>;
  readonly assembly: ReturnType<typeof assembleProjectErb>;
} {
  // 1) 一个 backend 服务全部编译（theaterErb + legacy M1 共用同一实例）
  const backend = createEratwEmitBackend({
    // 生产：接 v1 expression 管线；这里恒等透传只保证结构/诊断成立
    compileExpression: (expr) => expr.text,
  });

  // 2) provenance 一律从对象派生（别手抄版本号）
  const provenance = createKojo2ProjectProvenance({
    adapter: ERATW_GAME_ADAPTER,
    registry: ERATW_TARGET_REGISTRY,
    backend,
    capability: ERATW_CAPABILITY,
    sourceMapPolicy: ERATW_SOURCE_MAP,
  });

  // 3) 项目级编译
  const result = compileKojo2Project({
    projectId: 'editor-project',
    provenance,
    project: null,
    documents: input.documents,
    adapter: ERATW_GAME_ADAPTER,
    backend,
    registry: ERATW_TARGET_REGISTRY,
    // D3：每文件 Host 事实（标准版显式空串；缺席 = 没有事实）
    contextOf: (file) => ({ charNo: charaNoOf(file.path), familySegment: familySegmentOf(file.path) }),
    dispatchSelectors: ERATW_DISPATCH_SELECTORS,
    requireDispatch: input.requireDispatch,
  });

  // 4) 组装计划（任何构建结果都可读，供诊断）
  const plan = planProjectErbAssembly(result);

  // 5) Host 用 M1 单文件路径补齐 legacy 字节（只补 plan 要求的那几份）
  const legacyErb: ProjectLegacyErbInput[] = [];
  for (const expectation of plan.legacyFiles) {
    const text = input.readText(expectation.path);
    const file: KojoFile = parseSource(text);
    const compiled = compileKojoFile(file, {
      adapter: ERATW_GAME_ADAPTER,
      backend,
      sourceText: text,
    });
    if (!compiled.ok) continue; // 诊断经 build/plan 与本文 §4 通道上屏；缺它 assembly 会报 legacy-missing
    legacyErb.push({ fileId: expectation.fileId, erb: compiled.erb });
  }

  // 6) 最终组装：status === 'complete' 才是可发布产物
  const assembly = assembleProjectErb({ result, legacyErb });
  return { result, plan, assembly };
}

/** 运行时选择：不重新编译、不重解析，只读 linkedProject 的静态候选 */
export function pickRuntimeTheater(
  result: ProjectCompileResult,
  request: {
    readonly canonicalId: string;
    readonly location: string | null;
    readonly time: string | null;
    readonly timeValue?: number | null;
    readonly engineFunctionName?: string; // 多角色项目必须点名
  },
) {
  const linkedProject = result.build.linkedProject;
  if (linkedProject === null) return null; // 构建失败：先处理诊断，不做运行时选择
  return resolveKojo2RuntimeSelection({ linkedProject, ...request });
}
```

发布门禁：

```ts
const { assembly } = buildEditorProject({ /* ... */ });
if (assembly.status !== 'complete') {
  // 把 assembly.diagnostics 上项目级一格；发布按钮禁用
  throw new Error(assembly.diagnostics[0]?.message ?? '项目不完整');
}
// 逐 unit 写出：dispatch 在前、legacy 在后；写盘只能走 exportFile 对话框通道
```

---

## 8. 核对清单

本批已接线（对照 §0.1 / §6 打勾项）：

- [x] provenance 由 `createKojo2ProjectProvenance` 生成（Service 内从 bundle 派生），四轴与 adapter/registry/backend 对象一致（含 `backend.version`）。
- [x] `contextOf` 区分「显式空串」与「没有事实」；workflow 无家族事实时显式给标准版 `''`。
- [x] 真实 eraTW 注入 `ERATW_DISPATCH_SELECTORS`（经 bundle）；发布模式 `requireDispatch:true`。
- [x] `plan.legacyFiles` 全部由 M1 路径补齐（workflow `compileLegacy`）；补齐失败有可见 `assembly/legacy-missing`。
- [x] 发布只看 `assembly.status === 'complete'`（Service `publishable`）；theaterErb 绝不拼进最终产物。
- [x] 所有诊断通道都有 UI 去路（文件行 / `kojo2:build` 项目级一格 / toast），没有静默吞。
- [x] 换项目 / 关项目会清空缓存与项目级问题格；迟到结果被世代号丢弃。
- [x] 三条命令在真机调试宿（Web/headless）真实跑通：构建 / 预览 / 发布 + 失败与恢复路径（§6.6）。

仍待下一阶段：

- [ ] 运行时选择 GUI（引擎 location/time 事实来源 + 选择器面板）。
- [ ] 真实 v1 expression 管线接入（当前恒等透传）。
- [ ] 发布落点产品化 UI（最近位置 / 覆盖确认）。
- [ ] 按文件增量编译（core 无增量契约）。
- [x] 修 §6.6 的 P2：失败重建时清空旧 `assembly`（已加回归用例）。
