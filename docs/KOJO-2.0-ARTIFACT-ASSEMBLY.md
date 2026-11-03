# Kojo 2.0 最终 ERB 产物组装（Assembly Contract）

> 实现：`packages/kojo-core/src/project/erb-assembly.ts`
> 入口：`planProjectErbAssembly(result)` / `assembleProjectErb({ result, legacyErb })`
> 导出：`@kojo/kojo-core`（经 `project/index.ts` 汇总）
> 测试：`packages/kojo-core/tests/erb-assembly.test.ts`（协议单测）、
> `packages/plugins/eratw-adapter/tests/kojo2/erb-assembly.test.ts`（eraTW 真实链路）

本文是「哪些字节能拼成可发布产物」的唯一权威口径。`compileProject` 负责产出候选事实，
组装层负责回答最后一个问题：**这份项目的结果到底能不能发布**。

## 1. 两条产物线，只有一条进最终产物

| 产物 | 来源 | 是否进最终 units | 用途 |
| --- | --- | --- | --- |
| `dispatchErb` | M3 `renderDispatch`，每个 canonical target × `functionName` 一份 | ✅ 是 | **最终运行时调度产物** |
| `theaterErb` | M1 `wrapMachine`，每个单 Theater 一份 | ❌ 否 | 单 Theater 编译 / 兼容 / 预览视图 |
| legacy `# 机` 的 ERB | M1 单文件路径（Host 跑） | ✅ 由 Host 显式传入 | legacy 口上字节，与 2.0 产物同权 |

规则 1（硬约束）：**`dispatchErb` 是最终运行时调度产物。** 同一 canonical target 的多个
地点/时间分支已经被合成唯一主函数 + 若干 `__D{n}` 分支函数，直接按顺序拼接不会重复定义
运行时函数。

规则 2（硬约束）：**`theaterErb` 绝不进入最终组装。** 多份单 Theater 产物可以产生同名
`@函数`（同角色不同地点都落到 `@M_KOJO_ENCOUNTER_K12`），把它们和 dispatch 产物拼在一起
= 重复定义运行时函数。组装计划只用 `previewOnlyTheaterCount` 报份数，供 UI 预览/诊断；
**这个数量不代表可发布内容**。

## 2. `planProjectErbAssembly(result)`：先算计划，再谈字节

纯数据计划，任何构建结果都可读（构建失败时给编辑器诊断视图用）：

```ts
interface ProjectErbAssemblyPlan {
  status: 'ready' | 'incomplete';
  dispatchUnits: readonly { canonicalId: string; functionName: string }[];
  legacyFiles: readonly { fileId: string; path: string; theaterIds: string[] }[];
  previewOnlyTheaterCount: number;
  diagnostics: readonly ProjectAssemblyDiagnostic[];
}
```

- `dispatchUnits` = `result.dispatchPlan.targets` 中 `status === 'ready'` 的 target。
  **plan 是组装的唯一依据**：被 `blocked` 的 target（duplicate / 同特异性歧义 /
  无可分派 Theater）一律不进计划，绝不会被当成"应发布"的产物。
- `legacyFiles` = `result.build.projectIR.theaters` 里 `origin === 'legacy-machine'` 的
  Theater，按 `fileId` 聚合，`path` 从 `projectIR.files` 取，按 `fileId` 码元序排序
  （与文件注入顺序无关）。
- `previewOnlyTheaterCount` = `result.theaterErb.length`（只报数量）。
- `status === 'ready'` 仅当 `diagnostics` 为空。

计划层诊断（全部 error，见 §5）：

- `build.buildStatus !== 'succeeded'` → `assembly/build-failed`；
- `dispatchPlan` 的每条 error 级诊断 → 一条可下钻的 `assembly/dispatch-incomplete`
  （携带 `canonicalId` / `functionName`，不把"哪个 target 被阻断"糊成一句）；
- `dispatchPlan.status !== 'ready'` 却没有任何 error 诊断 → 兜底 `assembly/dispatch-incomplete`；
- 构建成功但 `dispatchErb.length !== dispatchUnits.length` → `assembly/dispatch-incomplete`
  （数量对账）。

## 3. `assembleProjectErb({ result, legacyErb })`：拿字节，给出结论

```ts
interface ProjectErbAssembly {
  status: 'complete' | 'incomplete';
  units: readonly ProjectErbUnit[];   // kind: 'dispatch' | 'legacy-m1'
  plan: ProjectErbAssemblyPlan;
  diagnostics: readonly ProjectAssemblyDiagnostic[];  // plan 诊断 + 组装阶段诊断
}

interface ProjectErbUnit {
  kind: 'dispatch' | 'legacy-m1';
  canonicalId: string | null;  // dispatch 有；legacy 为 null
  functionName: string | null; // dispatch 有；legacy 为 null
  fileId: string | null;       // legacy 有；dispatch 为 null
  erb: string;
}
```

组装顺序：**dispatch units 在前（按 plan 顺序），legacy-m1 units 在后（按 `legacyFiles`
顺序）**。

理由：dispatch 是最终运行时调度产物，legacy 是 M1 单文件路径的既有字节；两者都不重编译、
不改写、不排序内部行。

补充规则：

- 组装层的**函数名级对账**只在 `plan.status === 'ready'` 时执行：
  `dispatchErb` 缺计划 target / 含计划外 target 都给 `assembly/dispatch-incomplete`。
  plan 已经 `incomplete` 时缺失首因已报过，不再逐 target 重复报（避免淹没首因）。
- 构建失败但 Host 打开 `emitDiagnosticArtifacts` 时，`dispatchErb` 是**诊断预览**：
  units 可以有内容，但 `status` 恒为 `incomplete`，消费方不得发布。
- 消费方**发布前必须检查 `status === 'complete'`**；`incomplete` 时 `units` 只是诊断材料。

## 4. legacy-machine：M1 产出，Host 显式传入

- legacy `# 机` 的 ERB **必须**由 M1 单文件路径（`compileKojoFile`，非
  `theaterUnitsOnly`）产出；组装层不重跑编译、不读盘、不猜函数名。
- Host 通过 `legacyErb: [{ fileId, erb }]` 显式传入，`fileId` 必须来自 Project IR。
- **跳过 legacy ≠ 项目完整**：期望的 legacy 文件缺一份就 `assembly/legacy-missing` +
  `status === 'incomplete'`；传了项目里没有的 `fileId` 就 `assembly/legacy-unknown`
  （不产出 unit）。
- 同一 legacy `fileId` 传多份 ERB = Host 契约违规，按「同一运行时函数只能输出一次」
  处理：保留第一份 + `assembly/duplicate-runtime-function`。
- legacy 在 dispatch plan 中只产生 warning `dispatch/legacy-machine-skipped`
  （M1 负责其字节），不参与 M3 dispatch；混合项目里 legacy 不会拖空显式 target 的
  dispatch 产物。

## 5. 同一运行时函数不得重复输出

- dispatch units 按 `functionName` 查重：同一运行时函数名出现在多份 `dispatchErb` 里
  → `assembly/duplicate-runtime-function`，只保留第一份（units 里绝不出现两次）。
- 原因：Emuera 的 `@函数` 是全局命名空间，重复定义会让引擎行为不可预期；组装层宁可
  判 `incomplete`，也不交付"看起来完整"的重复产物。

## 6. 多角色：按 `functionName` 组织产物

- 同一 canonical target 下，不同角色/家族的 `engineFunctionName` 是**不同实现**，合法共存。
- `dispatchErb` 每份自带 `canonicalId` + `functionName`，多角色 = 多份 unit。
- exact duplicate（同 canonical + 同五字段 + 同 `engineFunctionName`）才是真重复：
  plan 只阻断**该 functionName**（K12 blocked、K13 仍 ready），组装计划相应只收 K13。

## 7. status 语义

| status | 含义 |
| --- | --- |
| plan `ready` | 发布所需事实齐了（build succeeded、plan 无 error、dispatch 数量对得上、无未决 legacy） |
| plan `incomplete` | 不能按该计划组装；见 `diagnostics` |
| assembly `complete` | **可发布**：诊断为空，units 覆盖全部 dispatch target + 全部 legacy 文件 |
| assembly `incomplete` | **不可发布**；units 仅供诊断/预览 |

诊断码（全部 `severity: 'error'`，`fileId` / `canonicalId` / `functionName` 按场景填）：

| code | 触发条件 |
| --- | --- |
| `assembly/build-failed` | `build.buildStatus !== 'succeeded'`（解析失败 / 版本失配 / duplicate / 降糖失败…） |
| `assembly/dispatch-incomplete` | plan 有 error、plan status blocked、dispatchErb 缺/多 target、数量对不上 |
| `assembly/legacy-missing` | 计划要求的 legacy-machine 文件没有传入 ERB |
| `assembly/legacy-unknown` | 传入的 legacy `fileId` 在项目里没有对应 legacy-machine theater |
| `assembly/duplicate-runtime-function` | dispatch `functionName` 重复；或同一 legacy 文件传入多份 |

## 8. 最小调用示例

```ts
import {
  assembleProjectErb,
  compileKojoFile,
  compileProject,
  parseSource,
} from '@kojo/kojo-core';
import {
  createEratwEmitBackend,
  ERATW_DISPATCH_SELECTORS,
  ERATW_GAME_ADAPTER,
  ERATW_TARGET_REGISTRY,
} from '@kojo/plugin-eratw-adapter';

// 1) 项目编译：dispatchErb 是最终调度产物；theaterErb 只是预览。
const result = compileProject({
  projectId: 'proj',
  provenance,
  files,
  registry: ERATW_TARGET_REGISTRY,
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
  dispatchSelectors: ERATW_DISPATCH_SELECTORS,
  requireDispatch: true,
});

// 2) 先看计划：要不要发布、还缺什么。
const plan = planProjectErbAssembly(result);
if (plan.status === 'incomplete') {
  report(plan.diagnostics); // 逐条 code + canonical/function/file 定位
}

// 3) Host 负责 legacy：用 M1 单文件路径产出字节，再显式传入。
const legacyErb = plan.legacyFiles.map((file) => {
  const source = readSource(file.path);          // Host 自己的读盘
  const parsed = parseSource(source);
  const m1 = compileKojoFile(parsed, {
    adapter: ERATW_GAME_ADAPTER,
    backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo }),
    sourceText: source,
  });
  if (!m1.ok) throw new Error('M1 legacy 编译失败');
  return { fileId: file.fileId, erb: m1.erb };
});

const assembly = assembleProjectErb({ result, legacyErb });
if (assembly.status !== 'complete') {
  report(assembly.diagnostics); // 不可发布
} else {
  publish(assembly.units);      // dispatch units + legacy-m1 units
}
```

## 9. baseline（发布判据）

**只有 `assembleProjectErb(...).status === 'complete'` 才可发布。** 以下任一情况都
**不算完整**，必须 `incomplete` + 具体诊断：

- 构建失败（`buildStatus !== 'succeeded'`），包括解析失败 / 版本失配 / duplicate /
  同特异性歧义 / 降糖失败；
- dispatch plan 有 error（K12 duplicate、`dispatch/ambiguous-branches`、
  `dispatch/no-supported-theater`）；
- `dispatchErb` 与 plan 的 ready target 数量或函数名对不上（含后端未实现
  `renderDispatch`、缺 selector 导致 target 未渲染）；
- 期望的 legacy-machine 文件没由 Host 传入 M1 字节；
- 同一运行时函数名在最终 units 中重复。

## 10. 非目标（边界）

- 不重跑编译、不重新解析、不生成第二套 AST / source map；
- 不读写盘、不碰 Monaco、零游戏名词（legacy 字节完全由 Host/M1 提供）；
- 不替 Host 决定 legacy 文件怎么读；`path` 只用于 Host 定位；
- 不发布半成品：`incomplete` 时 `units` 是诊断材料，不是产物。
