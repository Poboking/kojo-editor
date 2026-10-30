# docs/archive/ —— 冻结历史（只读，不再追加）

一次性审阅报告、UI 重设计方案、会话接力件已于 2026-10-30 瘦身删除（全文仍在 git 历史里，`git log -- docs/archive/<file>` 可取）。本目录只保留**仍被活代码或活文档引用**的几份：

| 文件 | 用途 | 被谁引用 |
|---|---|---|
| `IMPLEMENTATION-LOG.md` | 批次记录全量（§5.1–§5.128） | 代码注释里的 `§5.x` 历史依据 |
| `PERF-REVIEW-2026-10-11.md` | 性能路线 | `app/src/perf.ts` / `kernel/src/compute.ts` / `plugin-api/src/slots.ts` / `erb-parser/src/offload.ts` |
| `LIFT-REMEASURE-2026-10-12.md` | 升糖重定位读数 | `adr/0006` / `plugin-api/src/sugar.ts` / `kojo-sugar/src/project.ts` |
| `LIFT-REPOSITION-2026-10-12.md` | 升糖降为纯预览的裁决 | `kernel/tests/sugar-projection.corpus.test.ts` |
| `LIFT-SUGGESTER-DESIGN.md` | 💡 建议器设计 | `plugin-api/src/sugar.ts` / `kojo-sugar/src/lift.ts` |
| `SYNTAX-SUGAR-DESIGN.md` | 语法糖设计纪要 | `plugin-api/src/sugar.ts` |
| `SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` | 糖实现审阅 | `plugin-api/src/sugar.ts` / `SYNTAX-SUGAR-SURFACE-SPEC.md` |
| `REVIEW-SUGAR-DECOUPLING-2026-10-11.md` | 解耦审阅 | `tools/audit-decoupling.mjs` |
| `KOJO_PROJECT_AND_KOJO_TREE_DISCUSSION_MINUTES.md` | 项目/树讨论纪要 | `adr/0005` |

**不要再往本目录追加任何东西。**