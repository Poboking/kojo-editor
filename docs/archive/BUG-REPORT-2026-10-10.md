# BUG-REPORT-2026-10-10 — 代码审阅遗留缺陷（待修复）

- 来源：`docs/CODE-REVIEW-2026-10-10.md`（第二轮代码审阅）
- 生成日期：2026-10-10
- **2026-10-11 处置结果**：BUG-1（方案 A 级联）/ BUG-2（引擎 funcMatch 精确集合，scanner + extract 同源修）/ BUG-3（锚点语义显式化 + 边界单测，行为不变）/ BUG-4（model 版本号脏判定）已在第十八批修复（见 IMPLEMENTATION-LOG §5.25）；**BUG-5 判定延后**至 v1.1 注入器批次（payload 契约需与注入器写链路一并设计，避免契约先行实现滞后）。附带修（retry docstring 陈旧）已一并完成。
- 状态口径：本文所有条目均已在**当前工作区代码**上逐条复核，确认**仍未修复**（处置结果行除外）
- 外部审阅版本核对：见 §0.3（第三轮审阅基于落后 32 提交的旧版本，净新增可执行项为零）
- 目标读者：接手修复的 Agent。请先读 §0，避免重复处理已关闭项

---

## 0. 交付约定（务必先读）

### 0.1 已关闭项——**不要重复处理**

第二轮审阅共 1 高 + 5 中 + 若干轻微。以下条目**已修复**，修复单里不再列出，请勿再改：

| 编号 | 问题 | 修复提交 |
|---|---|---|
| H1 | `CASE a TO b` 被 OR 语义展开（区间应为 AND） | batch 12 `9adae53` |
| M2 | Rust 宿主忽略 `had_errors`，Shift-JIS 保存静默写成 HTML 实体 | batch 12 `9adae53` |
| M3 | Rust 命令无路径约束（纵深防御第二道闸缺失） | batch 14 `a8e22e6`（注意：batch 12 提交消息称"M3 deferred"，实际已在 batch 14 落地） |
| M4 | 切换文件不检查未保存更改 | batch 12 `9adae53` |
| M5 | 回放面板跨面板联动闭包陈旧 | batch 12 `9adae53` |
| L1 | storage 对损坏 JSON 不宽容 | batch 12 `9adae53` |
| L3 | `POWER` 语义 | batch 12 `9adae53` |
| L4 | `resolveModel` | batch 12 `9adae53` |
| L2 | — | 复核为误报，无需处理 |

> 校验方式：`git log --oneline -1 a8e22e6`、`git log --oneline -1 9adae53`

### 0.2 复核基线（当前实测）

- 测试：**509 passed / 4 skipped**（`npx vitest run`，37 文件通过）
- 类型检查：**exit 0**（`npx tsc -p tsconfig.json --noEmit`）
- 解耦审计：**11 个插件全过**（`pnpm audit:decoupling`）
- 工作区可能含其他 Agent 进行中的 sav 写侧改动；**不要动 sav-parser 相关代码**，只做本文列出的改动

### 0.3 第三轮审阅：版本落后核对记录（2026-10-11）

收到一份新的审阅意见，其自称 head 为 `61722ec`（第十三批）。**实测该版本已落后 32 个提交**（当时 HEAD 为 `5b86b7f`）。其三条"高优先级"判定如下，均已对照当前代码坐实，**未产生任何净新增可执行项**：

| 审阅条目 | 判定 | 依据 |
|---|---|---|
| scopedBus 违规时静默丢弃 | ❌ 已修复 | 当前 `bus.ts` L96–L103：`onViolation?.(message); throw new Error(message)`；修复提交 `49997f4`。审阅"建议补丁"与现有实现语义完全相同，应用即空操作 |
| `FileStorageBackend.list` 空目录抛错 | ⚠️ 前提不成立，**不采纳** | 见上轮结论：契约 `platform.ts` L46 保证"不存在→空数组"，Tauri（`Err(_)=>Ok(vec![])`）与 NodeBridge（try/catch→[]）均遵守，且有真文件系统回归测试实证；加 `exists()` 只会多一次 IPC 并把契约语义下移 |
| `ScopedStorageImpl.get` 损坏 JSON 不容错 | ❌ 已修复 | 当前 `storage.ts` L87–L92：`try{JSON.parse}catch{warn; return undefined}`；修复批次 12 `9adae53`（即 L1） |

另：其提到的 `detectCycles` 中 `j >= 0` 冗余条件（`runtime.ts` L109）属实但纯可读性，审阅人自评"非功能性 bug"，未纳入修复范围；sav-parser / `slots.register` 观察项分别属旧版本语境与理论边界，均无需处理。

> 复核方法：`git rev-list --count 61722ec..HEAD`（非零即落后）；并核对 `git log --oneline -1 49997f4`、`git log --oneline -1 9adae53`。
> **交接提醒**：外部审阅意见引用旧 SHA 时，先做上述版本核对再评估，避免对已修代码重复提改。

---

## BUG-1（中 / 功能性）`runtime.stop()` 不级联停用依赖方，留下悬空服务引用

### 位置

- `packages/kernel/src/runtime.ts` → `Runtime.stop(id)`，当前实现 **L235–L249**
- 相关：`Runtime.stopAll()` L251–L258；契约 `packages/plugin-api/src/services.ts`（`PluginRegistry.retry` / `stop`）；接线 `packages/kernel/src/kernel.ts` L127 `stop: (id) => runtime.stop(id)`

### 现象

单个插件被 `stop(id)` 停用后，**依赖它的插件仍保持 `active` 状态**，但其 `ctx.inject()` 拿到的服务对象已被停用方释放——形成悬空引用。依赖方后续调用该引用时行为未定义（可能报错、可能读到已失效状态），而插件状态面板仍显示它"运行中"。

### 当前代码

```ts
async stop(id: string): Promise<void> {
  const state = this.states.get(id);
  if (!state || state.record.status !== 'active') return;
  try {
    await state.plugin.deactivate?.();
  } catch (err) {
    this.deps.kernelLog.warn(`Plugin '${id}' deactivate() threw: ${errorSummary(err)}`);
  }
  await this.runDisposers(state.disposers, id);
  state.disposers = [];
  state.ctx = null;
  state.provided.clear();          // ← 只清自己
  this.deps.slots.removeAllFor(id);
  this.setStatus(id, 'stopped');   // ← 不检查、不联动依赖方
}
```

对照：`stopAll()` 用**逆注册序**停用（L252 注释"后启动的可能是先启动者的消费者"），说明内核已意识到依赖顺序问题，但 `stop(id)` 单点路径没有对应处理。

### 影响与可达性（重要修正）

- **可达性**：`kernel.plugins.stop(id)` 是 `PluginRegistry` 公开契约的一部分，任何插件/宿主均可调用；但**当前仓库内没有任何生产代码调用单插件 stop**（`stopAll` 除外）。
- **修正审阅报告的说法**：报告称"插件状态面板可触发"，实测**不成立**——`packages/plugins/ui-plugin-status/src/index.ts` 面板是**只读**的（仅渲染状态列表，无 stop/retry 按钮，见 L53–L84）。
- 结论：这是**潜在的契约正确性缺陷**（API 已对外承诺、语义不完整），不是当前用户可触发的路径。优先级可低于报告原本的评估，但既然 API 已公开，应在本轮补齐语义。

### 根因

`stop(id)` 未计算"依赖闭包"：既未按逆拓扑序先停依赖方，也未在存在 active 依赖方时拒绝停机。`provided` 集合可支撑依赖图计算（`tryActivateAll` 已用 `requires`/`provided` 做环检测，见 L79–L124），但**没有现成的 `dependentsOf()` 辅助函数**。

### 修复方向（二选一，建议 A）

- **方案 A（推荐）**：`stop(id)` 先求**传递依赖闭包**（所有 active 且 `requires` 命中 `id` 的 `provided` 键的插件，递归），按**逆拓扑序**逐个停用，最后停 `id`；每步照常发 `plugin.statusChanged`。与 `stopAll()` 的逆序哲学一致，避免悬挂。
- **方案 B（保守）**：若存在 active 依赖方，`stop(id)` **拒绝执行**（保持原状态 + 记录明确日志/错误），提示调用方先停依赖方。语义更安全但需调用方配合。

实现提示：
- 依赖关系来自 `requires` × `provides` 图；**slot 消费关系（`ctx.slots`）当前不在该图内**，若 SlotRegistry 未记录"谁消费了某 slot 项"，第一版可只覆盖服务键依赖，并在代码注释/文档中写明该边界。
- 注意与 `retry(id)`（L159）交互：`retry` 会触发全量重扫 `tryActivateAll`。
- **附带修**：`retry` 的 docstring（L158）写"状态面板的'重试'按钮"，但该面板并无此按钮，属陈旧注释，一并更正或补上按钮（若补按钮，需与本次改动一起评审）。

### 验收标准

1. 新增测试（建议放 `packages/kernel/tests/runtime.test.ts`）：
   - A `provide('x')`，B `requires:['x']`；`await stop('A')` 后——
     - 方案 A：B 不再为 `active`（已随之停用），且 B 的 `deactivate()` 被调用过；
     - 方案 B：B 仍 `active`，`stop('A')` 返回冲突/记录错误日志。
   - 链式：A→B→C 三级依赖，验证闭包与顺序。
   - 回归：`stopAll()` 行为不变。
2. `npx vitest run packages/kernel/tests/runtime.test.ts` 全绿；`npx vitest run` 不少于改动前的 509 passed / 4 skipped（不得引入回归）。
3. `npx tsc -p tsconfig.json --noEmit` exit 0。

---

## BUG-2（低 / 代码卫生）erb-parser 扫描器 `TRY` 规则过宽

### 位置
`packages/plugins/erb-parser/src/scanner.ts` **L343**：`} else if (kind.startsWith('TRY')) {`

### 现象
用 `startsWith('TRY')` 匹配 TRY 系关键字（设计意图见同文件 L227–L228 注释：`TRY 系 → CATCH → ENDCATCH`），会连带命中任何以 `TRY` 开头的 token，而非仅 `TRY`/`TRYCALL` 等精确集合。

### 修复方向
改为精确枚举集合匹配（如 `TRY_KINDS.has(kind)`），并保留注释中的映射关系。

### 验收标准
- 补一条 scanner 单测：`TRY` 家族精确命中、`TRYX`/`TRY_foo` 等非成员不误判。
- 审阅实测该规则对现有语料**影响为零**，属预防性收紧；不得改变现有正确用例的解析结果。

---

## BUG-3（低 / 理论边界）family-index 的 `_K` 正则贪婪

### 位置
`packages/plugins/eratw-adapter/src/family-index.ts` **L137** 与 **L147**：
`/^(.*)_K(\d+)(_.+)?$/`（L103 另有严格版 `/^M_KOJO_K(\d+)(?:_(\d+))?$/`）

### 现象
贪婪 `(.*)` 前缀在名称含多个 `_K<数字>` 段时可能吞掉靠前的段，取到靠后的编号；且 `(\d+)` 未做左右边界约束，理论上可匹配到非预期的编号切分。

### 修复方向
- 明确取"最后一个 `_K\d+`"还是"第一个"语义，改用非贪婪或显式 `lastIndexOf` + 精确校验的解析，替代贪婪点星。
- 数字后加边界约束，避免 `_K12x` 类误切。

### 验收标准
- 补单测覆盖：`A_K1`、`A_K1_B_K2`、`A_K1B`、无 `_K` 段等，断言归属解析与预期一致。
- 保持现有索引结果不变（对既有语料为纯加固）。

---

## BUG-4（低 / 性能）编辑器 dirty 判定每击键 O(n)

### 位置
`packages/app/src/ui/EditorPane.tsx` **L108–L110**：

```ts
ed.onDidChangeModelContent(() => {
  setDirty(ed.getValue() !== originalRef.current);   // 每次内容变化做全量字符串比较 + 分配
});
```

### 现象
每次内容变化都取全文并与 `originalRef` 全量比较。对 MB 级口上文件，属每击键 O(n) 且有临时字符串分配。

### 修复方向
改用**版本号/脏标记**而非全量比较：保存成功时将当前 model 版本号（`ed.getModel()?.getAlternativeVersionId()`）记入 `originalRef`，内容变化时只比版本号；或直接置脏、保存后清零。

### 验收标准
- 语义不变：保存后 dirty=false；保存后有编辑 dirty=true；撤销回原始内容的行为与现状一致（若依赖内容相等，需在方案中明确取舍）。
- 补/保留 EditorPane 相关单测全绿。

---

## BUG-5（前瞻缺口 / v1.1 前置）文件保存后无缓存失效事件链

### 位置
- 契约中已声明事件：`packages/plugin-api/src/events.ts` 的 `file.changed`
- 生产代码**无任何 emit**；`EditorPane.save()` 保存成功后不发事件

### 现象
写盘成功后没有事件广播，解析/索引/回放缓存无法感知文件已变更，存在读到陈旧解析结果的风险。

### 说明
审阅将其列为**前瞻备注**（v1.1 实时编辑时必须补），当前 v1.0 语义下影响有限。本轮是否修由排期决定；若修：

### 修复方向
- `EditorPane.save()` 成功后 emit `file.changed`（payload 含路径等）；由需要方（erb-parser 索引 / state-replay 缓存）订阅并失效。
- 建议明确事件的 payload 契约后再实现，避免又一次契约先行、实现滞后的债。

### 验收标准
- 保存 → 触发一次 `file.changed`；订阅方缓存被正确失效（补集成测试）。

---

## 附：审阅报告自身需修正的两处（供交接说明，非代码任务）

1. **M1 可达性**：报告称"插件状态面板可触发 stop"，实测面板只读，无 stop/retry 按钮。修复者不要假设存在 UI 触发路径（详见 BUG-1 影响段）。
2. **环境描述已过时**：报告成文时"测试 420/421、解耦审计 10 插件、typecheck 受他人 sav 工作区影响"均为当时快照；当前为 509 passed / 4 skipped、11 插件、typecheck exit 0。引用报告时以代码现状为准。

---

## 回归与验收命令（统一）

```powershell
npx vitest run                                   # 期望：≥509 passed / 4 skipped，无新增失败
npx tsc -p tsconfig.json --noEmit                 # 期望：exit 0
pnpm audit:decoupling                            # 若改动触及插件边界/内核边界
```

> 完成后请同步更新 `docs/HANDOFF.md` 的批次记录与 `docs/CODE-REVIEW-2026-10-10.md` 中对应条目的状态标注。