# STATE.md — 项目现状（数字的唯一真源；有变动顺手改这里）

> 读数字先读本文件，别信记忆和旧文档。历史的逐批读数在 `docs/archive/IMPLEMENTATION-LOG.md`（冻结）。

## 一、基线（2026-10-14 深夜，E14 拖拽打开 + E15 亲密面方案 + HK-4 UI-4/5/6 + 糖复杂场景审计修复 + 条件矩阵时机细化 · 中日对照 · 多剧本编号上树 · 直连模式开关 + E16 拆解析墙 + HK-17 多版本口上识别 + 语料认内容不认名 + 159 先代占位文件名回退 + SV-1 糖视图原生对齐 + E13/P-1 段块糖与段级吸收 + L1 首屏白屏批 + HK-19 回放伪变量回收 + FT-2 方言口径收口 + FT-1 `.ERH` 作者自定名表 + 亲密面扩糖 P-3/P-4/P-6 + P-7 HPH 连续块 / P-8 MESSAGECHECK 数字返回投影 + HK-20 call-context 推导 + ALS-R3 验收产物落点外搬 + HK-23 未知率口径拆分 + UX 术语清扫（`.kojo 语言` / `.kojo 预览`）与预览默认关 + ALS-R1 字典来源分层 / ALS-R2 SOURCE 入库 合流后本机实测）

| 项 | 读数 |
|---|---|
| 全量测试 | **2459 passed / 34 skipped（2493）**；139 文件过 / 12 跳（151） |
| 全量测试（挂语料 `KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)"`） | **2492 passed / 1 skipped（2493）**；151 文件全过（151）——语料面零红 |
| typecheck | root + app **双跑 exit 0**（`pnpm typecheck` + `pnpm --filter @kojo/app typecheck`） |
| 审计 | `pnpm audit:decoupling` ✅（17 插件；A–D 四项全绿） |
| Rust | `cargo test --lib` **24 项全绿**（E7 写允许域批 +18→22；E14 拖放事件映射 +2；改了 Rust 才跑；必须经 node 起，见 PITFALLS） |
| app build | ✓ 38.71s（§5.112 读数，此后未改构建面） |

⚠ skipped 跨主机不必相等：存档 / 语料在位与否会让 corpus 用例在 passed / skipped 间移动。

## 二、语料读数（真实工程）

- 索引：**99,104 函数 / 2,316 文件**（FT-2 起 `.ERH` 声明文件进面：+31 份，函数计数不变——声明文件 0 个 `@` 定义，由 `erh-index.corpus.test.ts` 钉死），全量索引 2.9s（历史口径，扩面后未重测）；家族覆盖率 **98.91%**。
- 性能（§5.128/§5.130）：**热开三段 0.63 / 1.57 / 1.60s**（原 2.66 / 3.43 / 3.45s，逐文件 stat 已折进目录遍历）；全冷三段＝索引 7.5s / 条件 26.3s / 校验 21.0s。抽取段剖面（抽冷、索引/校验热）：**读盘 45.1s 累加 ÷ 并发 8 占本轮 9.0s 一半以上**；扫描 2,285 次全走 worker（内联/回退 0）；主线程抽取循环仅 1.0s。
- 条件抽取：95,504 函数中 31,609 含状态依赖；未解析 0.04%。
- 状态回放（save03 × K49）：未知率 **31.9%**（3,732 谓词；exact 837 函数）；**口径拆分（HK-23）**：不可约真随机（RAND）**1,820** ⇒ **可判定率 83.6%**（同分母、可比历史 62.9→48.5→32.0）＋ **能力覆盖率 80.6%**，基线不变式钉在测试里。
- 结构闸门（§5.109）：**3,971 文件（正文 3,818 + 声明 153）/ 4,126,929 行**零误报（FT-2 扩面后本机复跑），最慢单文件体检 30.0ms（历史读数，本轮冷跑见过 50.7ms 未采信）；"删 `ENDIF` → 💡 补回 → 复检为零"闭环过。
- 编码：utf-8-bom / utf-8 / shift_jis / utf-16 读写往返；golden 六档存档 roundtrip 全等。

## 三、环境与路径（本机 = haruki 主机）

- 工作目录：`C:\DSH\kojo-editor-project`（本 clone）；同机另有 `C:\DSH\kojo-editor` / `C:\DSH\master-kojo-editor` 等其他工作树（共享主机，**动别人的树前先问**）。
- 真实语料：**认内容不认名**——目录名 2026-10-14 起被反复重排（同一份 4.980 同日两度改名），故一律经 `tools/corpus.mjs` 解析（`--corpus` > `KOJO_CORPUS_DIR` > 扫 `C:\game\*` 筛 `ERB/`+`CSV/`；多命中判据 ①`sav/` 非空 ②`.ERB` 数 ③目录名）；**整体只读，零写入是硬约束**。
- 盘上三份指纹（ERB 数 = `ERB/` 下 `.erb` 递归计数，工具打印同口径）：`eratw-画蛇添足版eratw4.980` 3,818 / CSV 33 / `.als` 19 / `sav` **6** / 有 `erb_check.py` ＝ **本项目全部基线所依据的那份**；`eratw魔王改版` 3,931 / 38 / 20 / `sav` 0 / 有；`eratw原生官方版4.842` 2,223 / 25 / 0 / 0 / 无。
- 存档库：`C:\game\eratw-save\sav\`（语料同级）与语料内 `sav\` **六档逐字节同容**（两处均只读；**面板读语料内 `sav\`**——adapter 固定 `<游戏目录>\sav`；注入前须去 R，见 PITFALLS §二）。
- 代理：github 直连时通时断 ⇒ 本 clone 已配 repo 本地代理 `http.proxy=127.0.0.1:7890`（新 clone 配一次；**永不改全局配置**）。
- 桌面壳：`pnpm --filter @kojo/app tauri dev`；CDP 9222；**同一工作树只能一个桌面实例**。

## 四、剩余欠账（数字/方向性的；认领的活在 BOARD.md）

- ERB 波浪线两层：**结构类**（三类可证明错误，erb-parser，error）；**表达式级**已落地（E8，condition-extractor 复用自研表达式解析器，IF/ELSEIF/SIF/WHILE/SELECTCASE 条件表达式的词法/语法错，warning，code `erb.expr-*`；保守排除 CASE/PRINTDATA）。
- `.kojo 预览`（旧称"糖视图"）：**不走虚拟文档**（原三问废止）；已交付为常态功能——只读内存 model 原生渲染（2026-10-14 SV-1），**默认不开启**且不再受「显示已封存功能」总闸管辖（同日 UX-2；总闸现只管 `.kojo 转译检查` 与归档浏览器两只面板）；作者-facing 术语已去「语法糖」一族，统一 `.kojo 语言 / .kojo 预览 / .kojo 校验 / .kojo 转译检查`（守卫 `packages/app/tests/no-sugar-jargon.test.ts`）。

## 五、版图速览（代码地图）

插件 17：`erb-parser` / `eratw-adapter` / `convention-linter` / `condition-extractor` / `sav-parser` / `state-replay` / `kojo-sugar` / `ui-convention-report` / `ui-kojo-navigator` / `ui-condition-matrix` / `ui-state-replay` / `ui-archive-browser` / `ui-snapshot-injector` / `ui-plugin-status` / `ui-sugar-preview` / `ui-sugar-editor` / `ui-sugar-lift`。
目录结构与关键文件注释见 `docs/ARCHITECTURE.md`；批次明细在 `docs/log/`。