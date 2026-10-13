# 2026-10-13 文档重构批 —— 项目管理优化（活文件 4 件 + 每批一 log + 历史冻结）

> 本批起**废止全局小节编号与共享追加**；本文即新格式的第一条记录（≤60 行、无编号）。
> 本批也是新 Git 流程（短命分支 `b/lead/1013-docs-restructure` → 本地过目 → 过 master 窄门）的首次自用。

## 一、动机（先测量）

- `docs/` 活文件合计 **~15.5k 行**（HANDOFF.md 2,064 + IMPLEMENTATION-LOG.md 8,409 为最大两件）；
- 提交史：**88 feat vs 97 docs**（约 37% 的提交面是文档）；
- 多 agent 并行下共享追加 + 取号：一夜撞 5 次号（§5.117→§5.121→§5.123→§5.125→§5.127→§5.128 让位链），
  每次都要 fetch/rebase/行多重集核对；零代码批（如 §5.125）也要写 ~42 行叙事。

## 二、新结构

| 件 | 职责 | 预算 |
|---|---|---|
| `AGENTS.md`（根） | 协作总入口：铁律 / 命令 / Git 纪律（方案 B）/ 文档纪律 / 分工 / 版本 | ≤120 行（现 70） |
| `docs/STATE.md` | 现状唯一真源：基线数字 / 环境路径 / 剩余欠账 | ≤100 行（现 45） |
| `docs/BOARD.md` | 在办看板：认领制；**完成即删行**（历史由 git 保留） | 只活在办 |
| `docs/PITFALLS.md` | 安全模型 + 环境坑表 + 会话坑（一行制） | 追加一行/条 |
| `docs/log/YYYY-MM-DD-<slug>.md` | 每批一条、无编号、**零代码零新事实可不写** | ≤60 行 |

## 三、迁移映射（旧 → 新）

- `docs/HANDOFF.md` → `docs/archive/HANDOFF.md`（活内容拆入上述 4 件；旧路径留 **stub 重定向**）
- `docs/IMPLEMENTATION-LOG.md`（§5.1–§5.128 全量）→ `docs/archive/`（stub 重定向；`§5.x` 引用继续有效=去 archive 查）
- `docs/UI-FEEDBACK-2026-10-13.md` → archive（待拍板三问转记 `BOARD.md` §D）
- `docs/KOJO_PROJECT_AND_KOJO_TREE_DISCUSSION_MINUTES.md` → archive（余项转记 `STATE.md` §四）
- `docs/UI-REDESIGN-2026-10-11.md` / `PERF-REVIEW` / `PERF-ANALYSIS` / `LIFT-REMEASURE` / `LIFT-REPOSITION` / `REVIEW-HEART-PROJECTION` → archive（P0–P4 已入库 / 性能已收口 / 升糖已降纯预览）

## 四、引用清整与删除件

- 10 处**代码注释/夹具**中的旧路径改写为 `docs/archive/...`（9 个文件，纯注释改动）；
  `fixtures/README.md` 的 `§五` 指 `AGENTS.md §三`；
- 活文档更新：README（判据链 + 测试数指向 STATE）、MANUAL-CHECKLIST（头部基线指引）、
  ARCHITECTURE（现状指向 STATE/BOARD）、BASELINES（运行方式指 AGENTS）、SYNTAX-SUGAR-SPEC、ADR-0005/0006（路径前缀）；
- 删除 `tools/_doc-handoff-s1.mjs`（一次性文档改写脚本，目标文件已冻结）；
- **保留** `tools/git-push.mjs`（上游 §5.98 刚改造为"直连/代理交替"，降级为兜底并在 AGENTS §四 文档化）。

## 五、验证

| 项 | 读数 |
|---|---|
| 体积 | 活文档（docs 根 + AGENTS）**15.5k → 2.9k 行**；操作面 4 件合计 **251 行**；archive 冻结 25 份 |
| 路径残留 | `git grep docs/<旧名>` 仅剩 archive 前缀与历史 `§5.x` 引用（stub 已声明去向） |
| 门禁 | 注释级改动 + 文档 ⇒ 按纪律豁免全量测试；`audit:decoupling` 复跑 ✅（见提交前读数） |
| 冲突标记 | 全仓扫 0 命中 |

## 六、边界 / 下一步

- `docs/log/` 空目录不建占位（本文件即首条）；
- 本批不含任何语义改动；历史冻结区（archive）此后**只读**。

## 七、落库记录（2026-10-13 晚）

- rebase 到 `origin/master 000ecff`（两组落地批 §5.127–§5.130 之上）：HANDOFF / IMPLEMENTATION-LOG 的正文改动与冻结冲突按「**archive 取新版全文、旧路径留 stub**」解——§5.127–§5.130 随冻结进 archive，旧文件到此完整（此后不再追加）。
- 整合：BOARD 收 HK-8（裁决＝不改保存行为、`notice-queue` 溢出先丢 info，+6 项测试）、HK-4 登记 UI-3 图标在制（`kojo-fb3` 树）；STATE 校准 **1852/14（1866）· 105 文件/8 跳（113）**；#21「抽取上并行通道」判死 ⇒ 新靶 #36 批量读盘原语。
- 门槛（rebase 后全量复跑）：`pnpm test` 1852/14 · 双 typecheck 0 · `audit:decoupling` A–D 绿。
- 补校准（同晚）：语料盘面名实为 `C:\game\eratw-sub-modding-eratw4.980`（旧 `-SANYOUSEI(PC)` 后缀不在盘上）⇒ STATE / AGENTS（含两处冒烟命令）/ MANUAL-CHECKLIST / BASELINES 路径口径对齐；两处 sav 六档逐字节同容且全只读（注入 rename EPERM）入 PITFALLS §二。
