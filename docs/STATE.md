# STATE.md — 项目现状（数字的唯一真源；有变动顺手改这里）

> 读数字先读本文件，别信记忆和旧文档。历史的逐批读数在 `docs/archive/IMPLEMENTATION-LOG.md`（冻结）。

## 一、基线（2026-10-14，E10 教程文本批之后本机实测）

| 项 | 读数 |
|---|---|
| 全量测试 | **1883 passed / 14 skipped（1897）**；108 文件过 / 8 跳（116） |
| typecheck | root + app **双跑 exit 0**（`pnpm typecheck` + `pnpm --filter @kojo/app typecheck`） |
| 审计 | `pnpm audit:decoupling` ✅（16 插件；A–D 四项全绿） |
| Rust | `cargo test --lib` **18 项全绿**（改了 Rust 才跑；必须经 node 起，见 PITFALLS） |
| app build | ✓ 38.71s（§5.112 读数，此后未改构建面） |

⚠ skipped 跨主机不必相等：存档 / 语料在位与否会让 corpus 用例在 passed / skipped 间移动。

## 二、语料读数（真实工程）

- 索引：**99,104 函数 / 2,285 文件**，全量索引 2.9s（历史口径）；家族覆盖率 **98.91%**。
- 性能（§5.128/§5.130）：**热开三段 0.63 / 1.57 / 1.60s**（原 2.66 / 3.43 / 3.45s，逐文件 stat 已折进目录遍历）；全冷三段＝索引 7.5s / 条件 26.3s / 校验 21.0s。抽取段剖面（抽冷、索引/校验热）：**读盘 45.1s 累加 ÷ 并发 8 占本轮 9.0s 一半以上**；扫描 2,285 次全走 worker（内联/回退 0）；主线程抽取循环仅 1.0s。
- 条件抽取：95,504 函数中 31,609 含状态依赖；未解析 0.04%。
- 状态回放（save03 × K49）：未知率 **32.0%**（3,741 谓词；exact 836 函数），基线不变式钉在测试里。
- 结构闸门（§5.109）：3,818 文件 / 4,115,009 行**零误报**，最慢单文件体检 30.0ms；"删 `ENDIF` → 💡 补回 → 复检为零"闭环过。
- 编码：utf-8-bom / utf-8 / shift_jis / utf-16 读写往返；golden 六档存档 roundtrip 全等。

## 三、环境与路径（本机 = haruki 主机）

- 工作目录：`C:\DSH\kojo-editor-project`（本 clone）；同机另有 `C:\DSH\kojo-editor` / `C:\DSH\master-kojo-editor` 等其他工作树（共享主机，**动别人的树前先问**）。
- 真实语料：`C:\game\eratw-sub-modding-eratw4.980`（2026-10-13 晚盘上实测名——旧 `…-260326-SANYOUSEI(PC)` 后缀名已不在盘上；**整体只读，零写入是硬约束**）。
- 存档库：`C:\game\eratw-save\sav\`（语料同级）与语料内 `sav\` **六档逐字节同容**（两处均只读；**面板读语料内 `sav\`**——adapter 固定 `<游戏目录>\sav`；注入前须去 R，见 PITFALLS §二）。
- 代理：github 直连时通时断 ⇒ 本 clone 已配 repo 本地代理 `http.proxy=127.0.0.1:7890`（新 clone 配一次；**永不改全局配置**）。
- 桌面壳：`pnpm --filter @kojo/app tauri dev`；CDP 9222；**同一工作树只能一个桌面实例**。

## 四、剩余欠账（数字/方向性的；认领的活在 BOARD.md）

- 纪要 §5 清单余项：**直连模式开关 · 多剧本编号上树 · 中日对照**。
- ERB 波浪线只做**结构类**（三类可证明错误）；词法 / 表达式级校验留给 condition-extractor 的表达式解析器复用，另一批。
- 糖视图：**不走虚拟文档（原三问废止）**；现效果已封存（设置页「显示已封存功能」总开关可临时恢复）；新方向＝升糖语法写进编辑器原生显示（不写盘），未立项。

## 五、版图速览（代码地图）

插件 16：`erb-parser` / `eratw-adapter` / `convention-linter` / `condition-extractor` / `sav-parser` / `state-replay` / `kojo-sugar` / `ui-convention-report` / `ui-kojo-navigator` / `ui-state-replay` / `ui-archive-browser` / `ui-snapshot-injector` / `ui-plugin-status` / `ui-sugar-preview` / `ui-sugar-editor` / `ui-sugar-lift`。
目录结构与关键文件注释见 `docs/ARCHITECTURE.md`；批次明细在 `docs/log/`。
