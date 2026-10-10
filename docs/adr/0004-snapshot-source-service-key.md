# ADR-0004: 快照来源服务键命名 —— `snapshot.source`（而非 `sav.parser`）

- **日期**：2026-10-10
- **状态**：已接受（v0.2 第四批落地）

## 背景

定位"存档二进制解析"服务时，早前文档分别出现过 `sav.parser`（§6 目录草图）与
`StateSnapshotSource`（§5.3 三来源）两种措辞。实现前碰到解耦审计 A 项的硬约束：

- `tools/audit-decoupling.mjs` 的黑名单含**裸 `sav` 词**（`\bsav\b`）——"内核 / 契约层零游戏与格式名词"；
- 服务键 `'sav.parser'` 的字面量出现在 `plugin-api/src/services.ts`，必然违反 A 项。

## 决策

1. 服务键用 **`snapshot.source`**（常量 `WellKnownServices.SnapshotSource`）；
2. 契约文件命名 `plugin-api/src/snapshot.ts`（类型 `SnapshotArchive` / `SnapshotSourceService` 等）；
3. 插件目录 / 包名照旧 **`sav-parser`**（`@kojo/plugin-sav-parser`）——插件层不受审计词汇约束，
   存档格式名放在插件名里最直观（同理 `GameProject.savDir` 字段保留：架构 §5.7 钦定形状，
   且 `savDir` 带后缀不触发黑名单）；
4. 语义理由（不止于审计规避）：该服务在架构上就是"**快照来源**"（§5.3 三来源：
   真实存档 / CliDebug 活会话 / 手工构造），读存档只是第一个落地的来源。
   `snapshot.source` 把服务的通用语义说对，也能自然承接写侧（v1.1 状态注入器）。

## 后果

- 审计 A 项持续全绿；契约层术语统一为 snapshot / archive；
- 文档中历史提到的 `sav.parser` 均指本服务的早期草拟名，实际接口以 `snapshot.source` 为准；
- 未来接入新来源（CliDebug / 手工）时按同一服务键扩展或新增配套服务，不改名（兼容性承诺）。
