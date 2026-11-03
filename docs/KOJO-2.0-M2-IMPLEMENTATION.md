# Kojo 2.0 M2 实施说明（P1–P6）

- 日期：2026-11-03
- 状态：已实现（M2 项目级编译基础设施）
- 上位契约：`docs/adr/0011-kojo2-m2-project-ir-target-registry.md`、`docs/KOJO-2.0-M2-P0-CONTRACTS.md`
- 可运行示例：`examples/m2-project/`；用例：`packages/plugins/eratw-adapter/tests/kojo2/example-project.test.ts`

本文是 M2 的开发者入口：说明公开 API、TargetRegistry 语义、链接/重复规则、失败边界，以及 M1/M3 的分界。M2 **不生成最终 dispatch ERB**；运行时地点/时间匹配与唯一选择属于 M3。

## 1. 已实现范围

| 阶段 | 能力 | 主要代码 |
|---|---|---|
| P1 | Project IR、文件/Theater 身份、SourceMapData、局部失败状态 | `packages/kojo-core/src/project/ir.ts`、`identity.ts`、`packages/kojo-core/src/source-map-data.ts` |
| P2 | TargetRegistry 契约、装载期校验、参数规则 | `packages/kojo-core/src/project/target-registry.ts`、`packages/plugins/eratw-adapter/src/kojo2/target-registry.ts` |
| P3 | TargetResolution / 函数名解析 | `target-registry.ts`、`packages/kojo-core/src/project/linker.ts` |
| P4 | 静态 Linker、候选分组、exact duplicate | `linker.ts` |
| P5 | Backend 消费统一函数名、单 Theater ERB | `packages/kojo-core/src/project/compile-project.ts`、`packages/plugins/eratw-adapter/src/kojo2/backend.ts` |
| P6 | Host 装配与示例 | `packages/app/src/ui/kojo2-project-file-identity.ts`、`kojo2-file-context.ts`、`kojo2-project-compile.ts`、`examples/m2-project/` |

## 2. Quickstart

### 2.1 Core：`compileProject`

`compileProject` 接收**已解析 AST + 源文本 + 注入事实**，不读盘、不重新解析、不生成最终 dispatch：

```ts
import {
  compileProject,
  createProjectFileIdentity,
  parseSource,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import {
  createEratwEmitBackend,
  ERATW_CAPABILITY,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '@kojo/plugin-eratw-adapter';

const source = '【剧场：初见｜神社】\n# 视角 灵梦\n> 你好\n';
const path = 'D:/project/01-shrine.kojo2';

const file: ProjectCompileFileInput = {
  identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(source)),
  file: parseSource(source),
  sourceText: source,
  // 标准版显式空串；没有 family 事实时不要伪造 ''
  functionNameContext: { charNo: '12', familySegment: '' },
};

const provenance: ProjectBuildProvenance = {
  adapterId: ERATW_GAME_ADAPTER.id,
  adapterVersion: ERATW_GAME_ADAPTER.version,
  adapterFactsVersion: '1',
  gameFingerprint: ERATW_GAME_ADAPTER.gameFingerprint.digest,
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

const result = compileProject({
  projectId: 'demo-project',
  provenance,
  files: [file],
  registry: ERATW_TARGET_REGISTRY,
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
});

if (!result.complete) {
  console.error(result.build.diagnostics.map((d) => `${d.kind}: ${d.message}`));
} else {
  for (const unit of result.theaterErb) console.log(unit.theaterId, unit.erb);
}
```

完整可运行版本见 `examples/m2-project/compile-project.example.ts`。它读取同目录两份 `.kojo2`，使用 eraTW adapter/registry/backend，并打印每个 Theater 的单 Theater ERB。

### 2.2 Host：`compileKojo2Project`

宿主入口在 `packages/app/src/ui/kojo2-project-compile.ts`（app 内部模块，不是独立 npm 包入口）：

```ts
import type { GameProject } from '@kojo/plugin-api';
import { ERATW_GAME_ADAPTER, ERATW_TARGET_REGISTRY, createEratwEmitBackend } from '@kojo/plugin-eratw-adapter';
import { compileKojo2Project } from './ui/kojo2-project-compile';
import { charNoForProjectPath } from './ui/kojo2-file-context';

const project: GameProject = {
  rootDir: 'D:/game',
  adapterId: 'eratw',
  kojoPaths: ['D:/game/kojo'],
  writablePaths: [],
  charaIndex: new Map([[12, { no: 12, name: '角色', kojoDir: 'D:/game/kojo/12' }]]),
};

const result = compileKojo2Project({
  projectId: 'demo-project',
  provenance,
  project,
  documents: [
    { path: 'D:/game/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 你好\n' },
  ],
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
  registry: ERATW_TARGET_REGISTRY,
  // 统一 Host 上下文注入；只有确实有家族事实时才写 familySegment
  contextOf: ({ path }) => ({
    charNo: charNoForProjectPath(project, path),
    familySegment: '',
  }),
});
```

Host 入口负责：一次 `parseSource`、`pathKey` + `stableHash` 身份、`charNoForProjectPath` 最长目录前缀、显式 `familySegment` 注入；它不读盘、不猜家族。

## 3. 公开名称与 import 路径

### 3.1 `@kojo/kojo-core`

| 名称 | 说明 |
|---|---|
| `compileProject` / `ProjectCompileInput` / `ProjectCompileFileInput` / `ProjectCompileResult` / `ProjectTheaterErb` | 项目级编译编排与单 Theater ERB 结果 |
| `buildProjectIR` / `buildProjectBuildResult` | 从文件事实构造 Project IR；派生构建状态 |
| `linkProject` / `resolveProjectTargets` / `exactTheaterKeyOf` | 目标解析、静态分组、exact duplicate |
| `validateTargetRegistry` / `assertValidTargetRegistry` | Registry 装载期校验 |
| `resolveTarget` / `resolveFunctionName` / `findTargetDescriptor` | 纯目标/函数名解析 |
| `createProjectFileIdentity` / `projectFileId` / `projectTheaterId` | 文件/Theater 身份组合 |
| `toSourceMapData` / `SOURCE_MAP_DATA_VERSION` | 运行时 SourceMap 的纯数据投影 |
| `parseSource` / `compileKojoSource` / `compileKojoFile` | 单文件前端与 M1 兼容入口 |
| `ProjectIR` / `ProjectFileIR` / `ProjectTheaterIR` / `ProjectBuildResult` / `LinkedProject` / `TargetRegistry` / `TargetDescriptor` / `TargetResolution` | 公共事实类型 |

### 3.2 `@kojo/plugin-eratw-adapter`

- `ERATW_GAME_ADAPTER`：eraTW 的 `GameAdapter` 数据。
- `ERATW_TARGET_REGISTRY`：九事件 TargetRegistry（模块装载时自校验）。
- `createEratwEmitBackend`：eraTW `KojoEmitBackend`；项目路径消费 `MachineWrapRequest.resolvedFunctionName`。
- `ERATW_CAPABILITY` / `ERATW_SOURCE_MAP`：provenance 所需能力与 source map 策略。
- `ERATW_EVENT_CATALOG` / `ERATW_EVENT_NAMES`：九事件目录事实。

### 3.3 Host（`packages/app/src/ui/`）

- `kojo2ProjectFileIdentity(path, text, layerId?)`：`pathKey` + `stableHash`。
- `charNoForProjectPath(project, filePath)`：`charaIndex[].kojoDir` 最长前缀。
- `kojo2FunctionNameContextForFile(project, file, familySegmentOf?)`：文件级 `FunctionNameContext`。
- `compileKojo2Project(input)`：文档数组 → core `compileProject`。
- `compileKojo2Project` 还接受 `contextOf`；注入时统一走 `resolveKojo2FunctionNameContext`（见 §7）。

## 4. Project IR

`buildProjectIR` 输入：`projectId`、`provenance`、`files`。每个 `ProjectFileInput` 已有：

- `identity`：`path`、平台感知 `pathKey`、`layerId`、`fileId`、`contentHash`；
- `file: KojoFile | null`；`null` 表示该文件解析失败；
- 可选 `diagnostics`、`functionNameContext`、`lowering`。

不变量：

- 文件数组保留调用方顺序；Theater 数组按文件顺序展开，文件内保留源顺序与 `ordinal`。
- `legacy-machine` 的 `origin` 原样保留；`targetResolution` 不覆盖原始 target/location/time。
- 解析失败文件仍留在 `files`，进入 `failedFiles`，其他文件继续分析；`analysisStatus` 为 `partial`。
- `familySegment` 缺失 ≠ 空串；显式 `''` 必须保留为 own property。
- `sourceMapData` 是可序列化纯数据；运行时 `SourceMap` 不进入 IR。
- `ProjectFileId` 由 `pathKey` + `layerId` 组成；`contentHash` 只用于变化检测，不参与身份。

## 5. TargetRegistry：eraTW 九事件



`TargetRegistry` 由 Adapter 提供，Core 只校验/解析。`registrationStatus` 与 `compileSupport` 是两个轴：前者回答是否登记，后者回答当前是否可编译。

| eventCatalog 事件 | canonicalId | eventBinding | compileSupport | 函数名 / 说明 |
|---|---|---|---|---|
| 初见 | `eratw.event.初见` | `EVENTFIRST` | supported | `M_KOJO{t}_ENCOUNTER_K{n}` |
| 指令 | `eratw.event.指令` | `EVENTCOM` | supported | `M_KOJO{t}_MESSAGE_${com}_K{n}_{i}`；`com` 显式默认 `COM` |
| 训练 | `eratw.event.训练` | `EVENTTRAIN` | unsupported | 无 functionName/callSignature/runtimeProtocol |
| 读档 | `eratw.event.读档` | `EVENTLOAD` | unsupported | 同上 |
| 商店 | `eratw.event.商店` | `EVENTSHOP` | unsupported | 同上 |
| 购买 | `eratw.event.购买` | `EVENTBUY` | unsupported | 同上 |
| 训练结束 | `eratw.event.训练结束` | `EVENTEND` | unsupported | 同上 |
| 回合末 | `eratw.event.回合末` | `EVENTTURNEND` | unsupported | 同上 |
| 指令结束 | `eratw.event.指令结束` | `EVENTCOMEND` | unsupported | 同上 |

语义：

- 已登记 + supported：目标描述完整；**不保证**每个文件都有足够 Host 上下文。文件缺 `charNo` / `familySegment` / `index` 时是实例级 `needs-context`，不会把 Registry 的全局 supported 降级。
- 已登记 + unsupported：目标可被识别，但明确没有 M2 编译落点；产生 `target-unsupported` error，不进入函数名解析、分组或产物生成。
- 未登记：`registrationStatus = unregistered`、`status = unknown`，产生 `target-unknown` error。
- 匹配 surface/alias 只做**精确字符串匹配**；不 trim、不折叠大小写、不做别名推断。

装载期校验（`validateTargetRegistry` / `assertValidTargetRegistry`）：

- eventCatalog 的九个事件各恰好一个 descriptor；
- `canonicalId` 唯一，`surface` / `aliases` 非空且不歧义；
- `eventBinding` 必须存在于 eventCatalog；
- supported 必须有 `functionName` / `callSignature` / `runtimeProtocol`，且 `parameterRules` 覆盖模板中的全部 `{t}` / `{n}` / `{i}` / ${seg}；
- ${seg} 必须列入 `requiredSegments`，并有显式 `segmentDefaults`；
- unsupported 必须有非空 `unsupportedReason`，且 `functionName` / `callSignature` / `runtimeProtocol` 为 `null`。

`compileProject` 不重复做装载期校验；Adapter 应在模块装载时调用 `assertValidTargetRegistry`（eraTW 已这样做），自定义 Registry 由宿主自行校验。

## 6. 函数名解析

`resolveFunctionName` 只消费显式事实：

| 占位符 | 来源 | 缺失/空串语义 |
|---|---|---|
| `{t}` / familySegment | Host 文件事实 | 缺失 = `needs-context`；显式空串合法 |
| `{n}` / charNo | Host 文件事实 | 缺失 = `needs-context`；空串/非数字 = `invalid-context` |
| `{i}` / index | Core 派生 | `# 机` 从 `args[0]` 取；显式 Theater 不拆 raw，缺失 = `needs-context` |
| ${seg} / segment | Adapter 规则事实 | 只用 `segmentDefaults`；无显式默认 = `registry-binding`，不取对象首键 |

`FunctionNameResolution.kind` 与 `TargetResolution.status` 分开：

- `resolved` / `supported`：函数名可拼接且调用签名可用。
- `needs-context` / `needs-context`：缺少 Host/Core 事实，产生 `function-name-context-missing`。
- `invalid-context` / `invalid-context`：值不合法，产生 `function-name-context-invalid`。
- `unsupported` / `unsupported`：Adapter 明确声明无落点，产生 `target-unsupported`。
- `unresolved`（Registry 描述缺规则/缺默认）：产生 `registry-binding`，不是文件上下文问题。

版本核对：`linkProject` 目前硬校验 `provenance.targetRegistryId` + `targetRegistryVersion` 与传入 Registry 是否一致；不一致产生 `version-mismatch`，所有 Theater 保持 `targetResolution = null` 且 `linkStatus = 'version-mismatch'`，不做静默回落。`adapterVersion` / `backendVersion` 作为 provenance 事实保留，尚未做跨包版本硬校验（见已知限制）。

## 7. Host 接线：`contextOf` 与函数名上下文

Host 侧现在有统一的文件级上下文注入器：

```ts
type Kojo2FunctionNameContextResolver = (file: {
  path: string;
  layerId: string | null;
}) => FunctionNameContext;
```

它同时出现在：

- `Kojo2ProjectAnalysisInput.contextOf?: Kojo2FunctionNameContextResolver`
- `Kojo2ProjectPassOptions.contextOf?: Kojo2FunctionNameContextResolver`
- `compileKojo2Project(input)` 的 `contextOf?: Kojo2FunctionNameContextResolver`

语义：

- 注入 `contextOf` 时，`charNo` 与 `familySegment` 都归 Host 注入；`compileKojo2Project` 不再用 `project` + `familySegmentOf` 二次猜，走与分析装配面同一个 `resolveKojo2FunctionNameContext` 边界。
- `compileKojo2Project` 未注入 `contextOf` 时，旧 API 逐字不变：`charNoForProjectPath` + 显式 `familySegmentOf`。
- `contextOf` 缺席（或返回 `undefined`）⇒ `{}`：没有事实，绝不补默认 `familySegment`。
- 只透传字符串字段；**显式 `familySegment: ''` 作为 own property 保留**，与字段缺席严格区分。
- 标准版家族段必须由 Host 显式给空串；缺失时 eraTW 目标会以 `function-name-context-missing` 阻断构建。

示例：

```ts
const result = compileKojo2Project({
  projectId: 'demo-project',
  provenance,
  project,
  documents,
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
  registry: ERATW_TARGET_REGISTRY,
  contextOf: ({ path, layerId }) => ({
    charNo: charNoForProjectPath(project, path),
    // 有标准版事实时显式空串；没有事实时不要写这个键
    familySegment: '',
  }),
});
```

## 8. Linker、候选组与 exact duplicate

流程：`resolveProjectTargets` → 按 `canonicalId` 分组 → exact duplicate 检查 → 输出确定性排序。

- `LinkedProject.groups` 是静态候选组，不是运行时选择结果；每个 group 只保留 `TargetResolution.status = supported` 且函数名已解析的 Theater。
- unknown / unsupported / needs-context / invalid-context Theater 不进入 groups，但仍保留在 `linkedProject.theaters` 与诊断中；`ProjectTheaterIR.linkStatus` 保留对应状态，不会被覆盖成 `grouped`。
- exact duplicate 键恰好五字段：
  1. `canonicalTargetId`
  2. `location.kind`
  3. `location.raw`
  4. `time.kind`
  5. `time.raw`
- 五字段逐字比较：不 trim、不折叠大小写、不做地点/时间别名、不做区间/包含语义。
- 同 `canonicalId` 但 location/time 不同：只形成同一 target 的候选组，不报 duplicate；M2 不选择。
- exact duplicate 产生 `duplicate-theater` error，`primary` / `related` 指认全部重复 Theater；origin 只用于诊断标注，不是键的一部分。
- legacy-machine 与显式 Theater 都参与目标解析和重复检查。
- `@织` 不进入 groups；继续由既有 `@织` 层分析处理。
- groups 按 canonicalId 排序；theaters 按 canonicalId、fileId、source span 排序。Project IR 的 files/theaters 源顺序保持不变。

## 9. `compileProject` 与 Backend

`compileProject` 的流程：

1. 对显式 Theater 文件调用 `compileKojoFile(..., { theaterUnitsOnly: true })` 收集 `TheaterLoweringUnit`；
2. 构造 Project IR；
3. `linkProject` 做目标解析/分组/重复检查；
4. `buildProjectBuildResult` 判定整体状态；
5. 仅当构建 `succeeded` 时，用 Backend 为每个已解析且有 unit 的 Theater 生成单 Theater ERB。

结果字段：

- `build: ProjectBuildResult`：项目事实、链接结果、诊断、failedFiles。
- `theaterErb: readonly ProjectTheaterErb[]`：按源顺序的单 Theater ERB；**不是最终 dispatch ERB**。
- `backendDiagnostics: readonly KojoDiagnostic[]`：Backend 拒绝/缺失 `wrapMachine` 时的可见诊断。
- `complete: boolean`：构建 succeeded 且所有应产出的 Theater 都成功产出。

Backend 通过 `MachineWrapRequest.resolvedFunctionName` 接收统一解析结果；M1 旧路径不传该字段，继续走原单文件渲染，字节行为不变。项目构建失败或 Backend 失败时 `theaterErb` 返回空数组，不发布部分产物。

## 10. 失败与无部分产物

Project IR 分析非短路：单个文件解析失败只把该文件放入 `failedFiles`，其他文件继续保留 IR 与诊断。`analysisStatus = partial` 不等于 `buildStatus`；但 partial 必然阻断成功构建。

`buildStatus` 只有同时满足以下条件才为 `succeeded`：

- `analysisStatus === 'complete'` 且 `failedFiles.length === 0`；
- 没有 error 级 ProjectDiagnostic（unknown/unsupported/缺上下文/非法上下文/duplicate/registry-binding/version-mismatch/parse-failed）；
- 没有文件级 error 诊断；
- 没有 `discarded-syntax` / `discarded-lowering` unit；
- 没有未跑 lowering 的显式 Theater（`not-applicable`）；
- 所有 Theater 都有 `targetResolution`。

失败时：

- `LinkedProject` 可以作为诊断视图存在，但不是可发布结果；
- `compileProject.theaterErb === []`；
- `complete === false`；
- Backend 失败会保留 `backendDiagnostics`，并把最终 `buildStatus` 置为 `failed`。

## 11. M1 兼容性

M2 是 additive：

- `KojoTheaterTarget` / `KojoTheaterLocation` / `KojoTheaterTime` 的 raw/span/kind 不变；
- `KojoTheater.origin` / `legacyMachine` / scenes / spans 不变；
- `KojoFile.theaters` / `hasTheaterSyntax` / 扁平 scenes 兼容语义不变；
- `TheaterLoweringUnit` 的 theater/body/sourceMap/slots 不变；
- `TheaterUnitsStatus` 四状态不变；
- `wrapMachine` 的 M1 ERB 字节协议不变；
- `@织` 文件级装配与 `EventSpec.engine` 事件头不变；
- SourceMap 1 基行列、显式 null、模板/池 origins 不变；
- incremental 的 Theater 预筛与 `rebuildAll` 回退不变；
- legacy `# 机` 的单文件 M1 输出字节不变。

`compileProject` 只对显式 Theater 走项目级 `theaterUnitsOnly`；legacy `# 机` 的最终 ERB 仍由 M1 单文件路径负责。Project IR 仍会为 legacy Theater 保留 origin 并做目标解析/重复检查。

## 12. M3 边界

M2 不做：

- 地点/时间的运行时匹配；
- 地点别名、时间别名、区间重叠/包含、特异性比较；
- 唯一 Theater 选择；
- Ambiguous / NoMatch；
- 最终 dispatch ERB。

M3 的输入是 `LinkedProject` 与 `TargetDescriptor.runtimeProtocol`；M3 不得反向修改 canonicalTargetId、TargetRegistry 版本或 M2 的 exact duplicate 键。

## 13. 已知限制

1. **没有 familySegment producer**：2.0 当前没有从文件/家族自动产出 `familySegment` 的机制。Host 必须显式注入；标准版应显式给 `''`，缺失时构建以 `function-name-context-missing` 失败，这是预期行为。
2. **显式 Theater 的 `指令` 缺 `i`**：`KojoTheaterTarget` 只有 raw，没有 typed args；M2 不从 raw target 猜参数，因此显式 Theater `指令` 在需要 `{i}` 时为 `needs-context`。legacy `# 机 指令 310` 可从 `args[0]` 取得 `i`。
3. **没有最终 dispatch ERB**：`theaterErb` 只是每个 Theater 的单 Theater ERB；M3 才做 location/time matcher、specificity、唯一选择和 dispatch 产物。
4. **Registry 装载校验是调用方责任**：`compileProject` 不重复校验 Registry；自定义 Registry 必须先 `assertValidTargetRegistry`。
5. **版本核对范围**：当前 linker 只硬校验 `targetRegistryId` / `targetRegistryVersion`；`adapterVersion` / `backendVersion` 尚未做跨包硬校验。
6. **无持久化项目缓存/版本治理**：M2 只有 provenance 事实与内存级编译结果，没有全项目缓存持久化。

## 14. 验证

```powershell
pnpm typecheck
node node_modules/vitest/vitest.mjs run `
  packages/kojo-core/tests/project-ir.test.ts `
  packages/kojo-core/tests/source-map-data.test.ts `
  packages/app/tests/kojo2-project-identity-context.test.ts `
  packages/plugins/eratw-adapter/tests/kojo2/target-registry.test.ts `
  packages/plugins/eratw-adapter/tests/kojo2/project-linker.test.ts `
  packages/plugins/eratw-adapter/tests/kojo2/project-compile.test.ts `
  packages/app/tests/kojo2-project-compile-host.test.ts `
  packages/plugins/eratw-adapter/tests/kojo2/example-project.test.ts
```

示例专用命令：

```powershell
node node_modules/vitest/vitest.mjs run packages/plugins/eratw-adapter/tests/kojo2/example-project.test.ts --reporter=dot
```
