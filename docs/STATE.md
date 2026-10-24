# STATE.md — 项目现状（数字的唯一真源；有变动顺手改这里）

> 读数字先读本文件，别信记忆和旧文档。历史逐批读数在 `docs/archive/IMPLEMENTATION-LOG.md`（冻结，不再追加）；2026-10-13 起批次回执一律写进提交信息，不在本文堆历史。

## 一、基线（2026-10-24，eraFL 适配批并入视觉批十一第二波，合树实测于 `origin/dev` `fd1d1b5b` 之上）

| 项 | 读数 |
|---|---|
| 全量测试 | 功能池 **16,577 passed / 0 failed / 64 skipped（16,641）· 808 文件过 + 21 跳（829）**（分段：app 388 文件 / 7,728；plugins 301 过 + 17 跳（318）/ 6,189 + 55 跳；其余 119 过 + 4 跳（123）/ 2,660 + 9 跳；整池本机仍会偶发 `Worker exited unexpectedly`，按假红复跑再判）；计时池 **285 passed / 17 skipped（303）· 1 failed · 30 文件过 + 4 跳**（唯一红＝`kojo2-project-index.perf` 暖机后三次取最快 <8ms：本机空闲单跑 11.2–18.06ms，用例与唯一依赖 `kojo2-project-index.ts` 两侧 `git diff` 均空、远端同树该池 286 全绿 ⇒ 判本机算力低于立闸时，待快机复测，不判回归）；root + app 双 typecheck rc=0；`release-gate --skip-tests` 4/4 PASS（conformance 3/3）；真实语料闸未跑（`C:\game` 不在位） |
| 全量测试（挂语料 `KOJO_SMOKE_PROJECT`） | 功能池 **10,516 passed / 8 skipped（10,524）· 0 failed · 595 文件全过**；计时池 **221 passed / 12 skipped（233）· 0 failed**（2026-10-20 冻结值，空闲独跑）。`[idx-state]` 自证：2 根 / 2,325 方言文件 / 名录 99,218 名 / 未读入 0。语料以 `node tools/corpus.mjs --print` 为准（不在 `C:/game` 时用 `KOJO_CORPUS_SCAN_DIRS` 指定扫描根，正斜杠经变量传递）。纪律：挂语料全量必须空闲独跑；计时池若红先按负载假红复跑再判（PITFALLS 146） |
| typecheck | root + app **双跑 exit 0**（`pnpm typecheck` + `pnpm --filter @kojo/app typecheck`） |
| 审计 | `pnpm audit:decoupling` ✅（**22** 插件；A–D 四项全绿。`ADAPTER_PLUGIN_DIRS` 豁免：`eratw-adapter` / `eraakumamaid-adapter` / `erafl-adapter`。2026-10-24 eraFL 批把 `erafl` 补进 A/D 词表并做变异实测——通用插件插一行 `'eraFL'` 字面量 D 项即红，还原即全绿） |
| Rust | `cargo test --lib` **194 passed / 0 failed / 5 ignored**（2026-10-20 W8-E 批实测；+11 环境代理用例，`src/updater_proxy.rs`。改了 Rust 才跑；必须经 node 起，见 PITFALLS） |
| app build | ✓ **eraFL 合树实测（2026-10-24）：dist 80 件 / 10.21 MiB / 入口块 1,121 kB**（44.46s，rc=0）。⚠ **入口块已超批次七阈值 1,100 kB 共 21 kB**，`--release` 的 artifact-audit 会判红（平时 4 项标准闸不含它）。归因已查：XML 语言面不在入口块（`grep -c kojo-xml dist/assets/index-*.js` 命中 0），超限为此前批次累积漂移、非本批引入；待决策：拆包挪出首屏，或单独一批按现树重基线（改阈值须单独一批，不顺手抬） |

⚠ skipped 跨主机不必相等：存档 / 语料在位与否会让 corpus 用例在 passed / skipped 间移动。

## 二、语料读数（真实工程，工具只读；以下为各口径最后一次实测冻结值）

- 索引：**99,228 函数 / 2,325 文件**（含 `.ERH` 声明 31 份——0 个 `@` 定义，函数计数不变，`erh-index.corpus.test.ts` 钉死）；全量索引剖面 **walk 183ms · snapshot 510ms · aggregate 63ms**；家族覆盖率 **98.91%**。
- 性能（真语料桌面壳、空闲机、`node tools/boot-watermarks.mjs`，点击「最近项目」后的页内墙钟）：稳态冷 / 热＝让位 1.41 / 1.21s、索引可用 2.71 / 2.45s、点开文件→Monaco 挂载 198–675ms（自点文件算）、编辑器可用 4.01–4.63 / 3.03s、校验有结果 3.38 / 3.21s；对比修复前（让位 / 索引可用 / Monaco 挂载均 ~26–28s）**进项目到能用 −84%（约 7×）**。冷≈热；旧「冷开级联」口径已废弃（系一次性快照重建，非热点）。根因与守门见 PITFALLS 73。
- 首屏（1016 实测）：dev `htmlParsed 99.9 / firstPaint 444.0 / welcomeInteractive 3740.4ms`；release 终验冷开 `65.9 / 399.5 / 220.9ms`、白屏段 Δ=8.9ms；硬断言只认 **CDP Network 域**（WebView2 页内 `resource` 数不全）。复跑：`node tools/boot-marks.mjs --exe <release exe>` / `node tools/smoke-tauri-dom.mjs`。
- 批量读（合成 2,000 文件 / 160.9 MB）：正文单文件读 **8,000 → 2,000**、IPC **≈16,000 → 48 趟批**；交替开项目不再互踩（修复后首轮冷、此后 200/200）。
- 交互（合成 6,000 行 ERB + 2,000 行 `.kojo`）：装饰同步轮主线程 **0.48 / 0.41ms**、切回未改动标签 **0 次重算**；99,975 函数单扫 3.88ms、六连击搜索串 0.002ms、文件树 3,000 命中一帧行构造 1.06ms。
- 快照两态（口径务必写命中 / 未命中，PITFALLS 80）：**命中**轮索引可用 ~3s；**未命中**轮 ~17s（read+parse + refs 全量重扫）。未命中触发已归因（`tools/snapshot-invalidate.mjs` 受控复现）：失效输入位共 8 处，均为**该失效**而非误判；优化面＝冷启动 fire-and-forget 保存链会被窗口关闭 / 切项目静默丢掉（丢了下次冷进必全量重扫）。
- 校验分区复用（PERF-12b/13 落地面，`fe84c44` / 后续止血）：跨文件规则按 `ConventionProjectPartition` 逐文件缓存——合成盘「改一棵 ÷ 全量」校验段比值 **200 棵 0.308 / 2,000 棵 0.459**（改前破 1）；真壳热轮校验段 delta **+37.7ms**（回到位）、预取 4,058ms→1ms、主快照载荷 5.95→1.43MB；体感判据钉「**校验段 delta ≤500ms**」，余下两趟 IPC 合并立项 PERF-14（内核 storage）。等价对拍：`convention-linter/tests/partition.test.ts` 等三份。
- 快照 salvage（PERF-12a，`eeeb631`，`SNAPSHOT_VERSION` 7）：条目级 salvage——rootDir 写法不符 / 单条目损坏 / 条目级差集三面 ≤命中轮 ×3 达成；真·冷与换代面按等价判据须一次全树补扫（非回退）。对拍 15 例 `erb-parser/tests/snapshot-salvage.test.ts`。
- 条件抽取（W8-B/C2 收口）：**99,228 函数中 31,632 含状态依赖**、依赖 165,148、单轮扫描 22–23ms；`1pN` 位字面量、顶层行尾逗号、CASE `{`…`}` 行连接均已按引擎语义收口，opaque **89 → 31**；对账闸 `case-values.corpus.test.ts` + `expr-false-positive.corpus.test.ts`。
- ERB 结构语法（2026-10-20 真语料全量）：**3,980 份 / 4,128,250 行**，ERROR / MISSING / 崩溃 **0 / 0 / 0**（p95 17.94ms）；52,603 行档首解 295ms、击键增量重解 p95 4.54ms。
- 状态回放（save03 × K49）：未知率 **31.9%**；HK-23 口径拆分＝不可约真随机剥离后**可判定率 83.6%** ＋ **能力覆盖率 80.6%**，基线不变式钉在测试里。
- 结构闸门：**3,971 文件（正文 3,818 + 声明 153）/ 4,126,929 行**零误报；「删 `ENDIF` → 💡 补回 → 复检为零」闭环过。
- 编码：utf-8-bom / utf-8 / shift_jis / utf-16 读写往返；golden 六档存档 roundtrip 全等。

## 三、环境与路径（按主机而定；路径类细节不在本文存档）

- 工作树：本 clone 路径按主机而定；同一台机器上可能并存多个工作树——**动别人的树前先问**。
- 真实语料：**认内容不认名**——目录名会被反复重排，且**可能整目录暂离**（不在位 ⇒ 挂语料用例自动 skip，回位后按同口径重测）。一律经 `tools/corpus.mjs` 解析（`--corpus` > `KOJO_CORPUS_DIR` > 扫 `C:\game\*` 筛 `ERB/`+`CSV/`）；**整体只读，零写入是硬约束**。本机语料现于 `D:/Game`（非 `C:/game`），ipc 冒烟须显式传在册语料目录——自动发现会选中未在册盘而 fail-close 拒写，那是设计不是红。
- 语料盘面（ERB 数 = `ERB/` 下 `.erb` 递归计数）：基线盘（4.980）3,818 / CSV 33 / `.als` 19 / `sav` 6 ＝ **本项目全部基线所依据的那份**；改版盘 3,931 / 38 / 20 / `sav` 0；官方盘 4,842 2,223 / 25。
- 存档库：与语料同级的 `eratw-save\sav\` 与语料内 `sav\` 六档逐字节同容（两处均只读；面板读语料内 `sav\`；注入前须去 R，见 PITFALLS §二）。
- 代理：github 直连不稳的环境，给本 clone 配 repo 本地代理（`git config http.proxy <本机代理>`；**永不改全局配置**）；引擎类工具的代理经 `KOJO_GIT_PROXY`。
- 桌面壳：`pnpm --filter @kojo/app tauri dev`；CDP 9222；**同一工作树只能一个桌面实例**。
- 自动更新（REL-1）：签名密钥在构建机 `%USERPROFILE%\.tauri\kojo-editor.key`（**永不入库**；CI Secret = 密钥文件原样单行 base64，再包一层会报 `Missing encoded key`）；`check` 的 `timeout` 单位是**毫秒**、可选 `proxy` 参数；环境代理透传已落地（Rust 读 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 经 `updater_env_proxy` 交前端）；端到端 v0.0.1 已验证，真实 release 待首次发版。

## 四、剩余欠账（数字/方向性的；认领的活在 BOARD.md）

- **v0.4.0-beta.1 发版余项**：真实终端手工勾验（保存闭环 §2.J / 文件监视）+ NSIS **干净目录人工安装勾验**（产物已构建并审计，2026-10-22 `33c02392`；逐步清单在 `MANUAL-CHECKLIST-v0.4.0-beta.1`）；自动更新链路代码侧已闭环，端到端待首次真实 release。
- ERB 波浪线：结构类与表达式级均已落地（结构 error / 表达式 warning，code `erb.expr-*`）；**CASE/PRINTDATA 条件保守排除**，仍是已知盲区。
- `.kojo 预览`：已交付为常态功能（只读内存 model 原生渲染，默认不开启）；作者-facing 术语统一 `.kojo 语言 / .kojo 预览 / .kojo 校验 / .kojo 转译检查`，口径靠 review 维持。
- **启动器设计稿**：`docs/LAUNCHER-ARCHITECTURE.md`（**v0.3，2026-10-24**）＝**现行设计提案、待评审**——不是过时存档，评审与落地以此稿为准；落地前须按其文首建议立 ADR-0008/0009/0010，并把「编辑器不静默改；启动器只做显式、可回滚的插件安装」写进上位文档铁律。

## 五、版图速览（代码地图）

插件 22：`erb-parser` / `eratw-adapter` / `eraakumamaid-adapter` / `erafl-adapter` / `convention-linter` / `condition-extractor` / `sav-parser` / `state-replay` / `kojo-market` / `kojo-sugar` / `ui-convention-report` / `ui-kojo-navigator` / `ui-kojo-xml` / `ui-market` / `ui-condition-matrix` / `ui-state-replay` / `ui-archive-browser` / `ui-snapshot-injector` / `ui-plugin-status` / `ui-sugar-preview` / `ui-sugar-editor` / `ui-sugar-lift`。
目录结构与关键文件注释见 `docs/ARCHITECTURE.md`；批次回执在 git 提交信息（`docs/log/` 为旧制存档，不再新增）。
