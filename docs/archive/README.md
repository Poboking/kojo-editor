# docs/archive —— 历史文档冻结区（⚠️ 全部已过时）

> **本目录内所有文档均为「已过时 / 历史冻结」状态**：内容按归档当时的事实封存，
> 不再更新、不再维护；与现状冲突时一律以活文档为准。
> **权威序（2026-10-13 重构后）**：`AGENTS.md`（协作总入口）→ `docs/STATE.md`（现状/基线）→
> `docs/BOARD.md`（在办）→ `docs/ARCHITECTURE.md`（设计决策）→ 各活规范。
> 引用本目录文档时请标注「历史记录，仅供追溯」。

## 2026-10-13 文档重构：本目录接收的整批迁移

| 文档 | 性质 | 去向 / 状态 |
|---|---|---|
| `HANDOFF.md` | 交接 + 全量历史 | 冻结。活内容拆入 `AGENTS.md` / `STATE.md` / `BOARD.md` / `PITFALLS.md` |
| `IMPLEMENTATION-LOG.md` | 批次记录全量（§5.1–§5.128） | 冻结。新批次改写 `docs/log/YYYY-MM-DD-<slug>.md` |
| `UI-FEEDBACK-2026-10-13.md` | 跨组协作件（含待拍板三问） | 冻结。待拍板事项转记 `docs/BOARD.md` §D |
| `KOJO_PROJECT_AND_KOJO_TREE_DISCUSSION_MINUTES.md` | 讨论纪要 | 冻结；未落地余项（直连模式开关等）转记 `docs/STATE.md` §四 |
| `UI-REDESIGN-2026-10-11.md` | UI 重设计定稿 | 冻结（P0–P4 已全部入库） |
| `PERF-REVIEW-2026-10-11.md` / `PERF-ANALYSIS-2026-10-11.md` | 性能路线与分析 | 冻结（性能线已由 §5.128 收口到热开 1.60s） |
| `LIFT-REMEASURE-2026-10-12.md` / `LIFT-REPOSITION-2026-10-12.md` | 升糖重定位测量与需求 | 冻结（升糖已降为纯预览并交付） |
| `REVIEW-HEART-PROJECTION-2026-10-12.md` | 演出行投影外部审阅回执 | 冻结（"只记读数，不改判据"已执行） |

## 更早的归档（2026-10-11 / 10-12 整理批）

| 文档 | 状态 / 备注 |
|---|---|
| `BUG-REPORT-2026-10-10.md` | BUG-1/2/3/4 已修复；BUG-5 已交付 |
| `CODE-REVIEW-2026-10-10.md` / `CODE-REVIEW-2026-10-11.md` | 审阅发现均已回执落地 |
| `REVIEW-EXTERNAL-2026-10-11.md` / `REVIEW-OPTIMIZATION-2026-10-10.md` | 一次性外部意见，已消化 |
| `REVIEW-SUGAR-DECOUPLING-2026-10-11.md` / `DECOUPLING-REVIEW-2026-10-11.md` | 解耦审阅，M1–M4 已全量修复 |
| `REVIEW-UI-P1-P3-2026-10-12.md` | UI P1–P3 审阅，发现已回执 |
| `SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` | S1–S7 已全部落地 |
| `SYNTAX-SUGAR-DESIGN.md` | 被 `SYNTAX-SUGAR-SURFACE-SPEC.md` 取代 |
| `LIFT-SUGGESTER-DESIGN.md` | S5 / S5-UI 已实现 |
| `NEXT-SESSION-PROMPTS-2026-10-11.md` / `UI-REDESIGN-NEW-SESSION-PROMPT.md` | 会话接力 prompt，已消费 |
| `UI-REDESIGN-HANDOFF-2026-10-11.md` | UI 批实施交接，已交付 |

## 说明

- 冻结区内部互引未改写（自洽即可）；正文中的 `docs/<旧路径>` 与 `§5.x` 均按归档**当时**的布局理解。
- **不要再往本目录追加任何东西**；一次性报告交付即归档，新记录写 `docs/log/`。
