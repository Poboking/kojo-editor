# docs/archive —— 历史文档冻结区（⚠️ 全部已过时）

> **本目录内所有文档均为「已过时 / 历史冻结」状态**：内容按归档当时的事实封存，
> 不再更新、不再维护；与现状冲突时一律以 `docs/` 根下的活文档为准
> （权威序：`HANDOFF.md` → `IMPLEMENTATION-LOG.md` → `ARCHITECTURE.md` → 各活规范）。
> 引用本目录文档时请标注「历史记录，仅供追溯」。

## 归档清单（16 份，其中 2 份已取回活文档 → 实存 14 份）

| 文档 | 性质 | 状态 / 备注 |
|---|---|---|
| `BUG-REPORT-2026-10-10.md` | 缺陷报告 | 十八批 BUG-1/2/3/4 已修复（§5.23 线）；BUG-5 延后 v1.1 设计 |
| `CODE-REVIEW-2026-10-10.md` | 代码审阅 | 十二批审阅修复（§5.23 线）已回执落地 |
| `CODE-REVIEW-2026-10-11.md` | 代码审阅 | UI 重设计线审阅，发现已由后续批回执（§5.45–§5.47） |
| `REVIEW-EXTERNAL-2026-10-11.md` | 外部审阅 | 一次性外部意见，相关项已消化 |
| `REVIEW-OPTIMIZATION-2026-10-10.md` | 方案审阅 | 13 项分级：A1/D12 已落地、C7 排 v0.3（已交付），其余按其 §5 追踪 |
| `REVIEW-SUGAR-DECOUPLING-2026-10-11.md` | 解耦审阅 | 解耦补齐批审阅（§5.33），发现已全部回执 |
| `REVIEW-UI-P1-P3-2026-10-12.md` | 代码审阅 | UI P1–P3 审阅（§5.45），发现已回执 |
| `DECOUPLING-REVIEW-2026-10-11.md` | 解耦审阅 | **M1–M4 已全量修复入库**（§5.48，`9df5d79`）；实施中 M1 方案有修正，见 §5.48 |
| `PERF-ANALYSIS-2026-10-11.md` | 性能分析 | **已取回** `docs/PERF-ANALYSIS-2026-10-11.md`（2026-10-12 开工，按 HANDOFF §三 指示复活为活文档） |
| `PERF-REVIEW-2026-10-11.md` | 性能评审 | **已取回** `docs/PERF-REVIEW-2026-10-11.md`（同上；L0–L4 路线权威 + L0 实测记录） |
| `SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` | 提案审阅 | 框架采纳+三调整已全部落地（S1–S7 完成）；§八批次路线已执行完毕 |
| `SYNTAX-SUGAR-DESIGN.md` | 设计讨论稿 | 被 `SYNTAX-SUGAR-SURFACE-SPEC.md`（v1.2 冻结）取代，仅存设计脉络 |
| `LIFT-SUGGESTER-DESIGN.md` | 设计文档 | S5 / S5-UI 已实现（§5.31/§5.32）；代码注释中的 §号引用以本文件为准 |
| `NEXT-SESSION-PROMPTS-2026-10-11.md` | 会话接力 prompt | 已消费完毕（S1/S2 + 并行线均交付） |
| `UI-REDESIGN-HANDOFF-2026-10-11.md` | UI 批实施交接 | P0–P3 已交付；P4 待开工信息以 `UI-REDESIGN-2026-10-11.md`（活）为准 |
| `UI-REDESIGN-NEW-SESSION-PROMPT.md` | 会话接力 prompt | 已消费完毕 |

## 与活文档的关系

- `docs/` 根下保留的活文档：`ARCHITECTURE.md`（架构权威）/ `HANDOFF.md`（交接+进度）/
  `IMPLEMENTATION-LOG.md`（批次记录权威）/ `BASELINES.md`（实测基线）/
  `SYNTAX-SUGAR-SURFACE-SPEC.md`（糖表层规范 v1.2 冻结权威）/ `UI-REDESIGN-2026-10-11.md`
  （UI 定稿 v1.0，P4 待开工）/ `USER-GUIDE.md` / `MANUAL-CHECKLIST-v0.4.0-beta.1.md`（发版手工清单）/
  `RESEARCH.md` / `adr/`（架构决策记录）/ **`PERF-REVIEW-2026-10-11.md`（性能/内核优化路线权威，
  2026-10-12 从本归档取回）** / `PERF-ANALYSIS-2026-10-11.md`（同批取回的分析稿）。
- 历史正文中的 `docs/<旧路径>` 引用已统一改写为 `docs/archive/<新路径>`；只有
  **归档文档之间**的互引未改写（冻结区内部自洽即可）。
- 2026-10-11 整理批：本次搬迁为一次性动作，后续同类报告（审阅/分析/接力 prompt）
  交付即归档，不常驻 `docs/` 根。
