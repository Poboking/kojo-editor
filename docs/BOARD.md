# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

> ⚠️ **分支模型变更（2026-10-19 生效，全组必读）**：`master` 已停用并从远端删除。
> **日常落地分支＝`dev`**（一切功能 / 修复 / 文档批的窄门出口），**`main`＝发行版分支**（只在用户点头发版时并入并打 tag）。远端默认分支＝`main`。
> 在途批次立刻执行：① `git fetch origin --prune`（不 prune 会在已死的 `origin/master` 坐标上开工）；② 新批次分支一律从 `origin/dev` 起；③ 在途分支换底 `git rebase --onto origin/dev <旧 base>`；④ 落地命令改成 `git push origin HEAD:dev`（`tools/git-push.mjs` 与 `tools/tauri-dev-fresh.mjs` 默认值已同步）。
> **禁止** `git push … :master`——GitHub 会把它当新分支**创建**，提交会漂进一条没人复审的平行主线（详 PITFALLS §133）。`gh pr create` 默认 base 现为 `main`，日常批须显式 `--base dev`。

## 批次十二 · eraFL 适配（2026-10-24，已交付）

> **批次十二 12 路全部交付**（FL-ADAPTER / FL-XML-PARSE / FL-VARSCHEMA / FL-CONV / FL-XML-LANG /
> FL-XML-PROV / FL-XML-DIAG / FL-UI-PANEL / FL-PREVIEW / FL-CORPUS / FL-ERB-DIALECT / FL-DOCS）
> + 5 处组长接线（`bootstrap` 两枚插件接线与 app 依赖 / `ProjectView` 注入 `kojo.xml` 规格源 /
> `ps10-boot-order` 与 `kojo2-surface`·`kojo2-wire` 三处名单随批 / `audit:decoupling` 补 `erafl` 词表
> 并做变异实测 / `ERB_BODY_PRIMARY_EXTENSION` 收口 `.erb` 字面副本）；完成行已删，回执进提交正文。
>
> **实盘读数**（`D:\Game\erafl`，只读、零写入）：`CSV/` 33 项；`ERB/` 2,013 `.ERB` + 112 `.ERH` + 2 `.ERD`；
> 口上 **293 份 XML / 61,345 条 `<contents>`**（旧 `<kojodef>` 格式 3 份）；**9 份是 UTF-16LE 却声明
> `encoding="utf-8"`**（按声明解全灭，只有 BOM 优先才读得对）；`@KOJO_XML_REGISTER` 8 处 ⇒
> **未被注册的 XML 引擎不加载**（可校验）。

## 在办

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |
| TUT-UGUIDE | 内置教程已按 Kojo 2.0 设计稿补齐（1177b417 / f1554004 / 98c2b044 / cad84d27），但 **`docs/USER-GUIDE.md` 全文 0 处提 2.0**：手册只讲 v1 那条路，而编辑器里已经有第四张教程卡与「文件格式」那一档 ⇒ 两处口径不一致（唯一交叉引用 `USER-GUIDE.md:404` 指的「.kojo 语言教程」第⑪节仍对得上，未受影响） | 判据：手册把「默认档＝只认 v1／切档才认 2.0／`.kojo2` 无落盘产物」三件事写清，**只改冲突行、一行算一行**（§五 文档纪律），不许顺手重写整本；教程那四本已按实现写，手册以它们为准 | 待认领 · 来源：chief 教程批收口 2026-10-22 |
| CMD-NUL-BYTE | `packages/app/src/ui/commands.ts` 是**全仓 1591 个文本文件里唯一带裸 NUL 字节的**（第 275 行缓存键 `` `${nonce}<NUL>${roots.join('\n')}` ``，偏移 12293/12806）⇒ 文件被 `file` 判成二进制、**NUL 之后的行对基于文本扫描的工具失明**（grep/ripgrep/review 脚本一类）；TypeScript 与运行都不受影响，纯卫生与可审性问题 | 判据：一行改动把裸 NUL 换成转义形态（语义逐字节等价，运行期分隔符仍是同一个 `\u0000`）；改完 `node -e "fs.readFileSync(p).includes(0)"` 必须 false，且 `grep -c nonce` 仍数得出 6 处、`ps14-source-cache.test.ts` 全绿。**⚠ 别用 Edit/Write 硬试**：本会话两次尝试都被参数层的 JSON 转义吃掉（一次把 `${nonce}<NUL>` 写成 `${nonce}\u{0}U0000`＝分隔符从 1 字节变 6 字节，一次 0 occurrences），已 `git checkout --` 逐字还原；请用脚本落这一格（见 MEMORY「Edit 工具转义坑」） | 待认领 · 来源：chief 0.4.2-beta.2 实机测试 2026-10-22 |
| MK-SMOKE-RECAL | `smoke-tauri-market.mjs` 本机 4 红（2026-10-22 发行前实测）：f2/g/h 三条 = **锚点过期**（`ANCHOR_BYTES=1612` / `ANCHOR_SHA256=f1b72c01…` / 期望 2 条包，线上实测 4,141 B / sha `e100bb76ea79` / 6 条包——社区投稿已进注册表，钉的是**会变的外部内容**）；k 一条 = **判据踩在自己的采样噪声面上**（`intervalMs=300` 却判「行消失 ≤ 目录消失 + 300ms」，实测 469ms / 2,013ms 两跑皆红，功能面逐字节与记账全对） | 判据：f2/g/h 改成「schema 合规 + 远程与盘上逐字节自洽」为准、锚点只钉**本仓可控**内容（外部注册表内容不钉 sha，或按 `fetchedAt` 分档）；k 的容差须 > 2×采样间隔，或改钉「同一轮内行消失前无二次轮询」这类与粒度无关的判据——**不许**为凑绿把功能断言写松 | 待认领 · 来源：chief 发行前实机测试 2026-10-22 |



## 在办 · Kojo 2.0（设计基线 v0.9 · 批次三 2026-10-21）

> **依据**：`docs/KOJO-2.0-LANGUAGE-SPEC.md`（v0.9 设计稿+任务清单合并入库版）。
> **已定**：开发期双前端并存、发布态单一模式（CUTOVER 单批收口）；旧前端只修会被 2.0 复用的后端面；看板按包/文件粒度拆行。
> **批次一/二已落 `dev`＝`58f86e7c`**：core 包/前端/降糖/端到端/迁移引擎/适配层/项目层/eraTW backend/Monaco 2.0 语言面/tree-sitter v2。对应行已销，回执在提交正文。批次三 12 路并行（见文末新行）。

| ID | 任务（落点） | 关键判据 / 已实测事实 | 状态 |
| K2-D0 | **设计冻结与结构裁决**：D0.1–D0.11 + 4 项结构前置落字；定包归属/审计放行、项目级分析层、存储期分配器、多时机拆文件；定旧前端退役时点 | 决策逐条落字；C1 开工前无悬空结构问题（C1 已按 §4.8/§4.13/§10.3/§10.7 约束实现，待追认） | 进行中 · 认领：lead 2026-10-21 |
| K2-CONTRACT | 2.0 契约面：现落 `@kojo/kojo-core`（AST/诊断码/source-map/GameAdapter），**与设计稿 C1.2「扩 plugin-api」的落点偏离**待 D0 裁决；需评估是否 additive 镜像到 plugin-api | additive、旧消费方零改动；双 typecheck；core 零游戏名词；fixture adapter 仅依赖契约编译 | 进行中 · 认领：lead 2026-10-21 |
| K2-CORE-PKG | core 包布局与 audit 放行：`packages/kojo-core` 已建（非插件库，B/C 项不拦）；§15.2 复用清单核对与偏离记账 | audit A–D ✅；复用点可核对；单文件转译纯函数 | 进行中 · 认领：lead 2026-10-21 |
| K2-PROGRAM | 程序层补齐：`@巡` 绑定数据（数组/角色集合/长度机制）、递归深度事实、feature gate 落社区；`@复/@循/@标/@跳` 已 golden | 关闭 feature error 不静默；`@巡 {值}/{下标}` 可落 ERB；越界可证 error；golden | 批次三认领：lead（`K2-FOREACH` 拆出并行） |
| K2-STORAGE | 存储期分配器 core 已交付（11 类失败接诊断、稳定槽/回收/换盘）；**宿主持久化与接线未做** | 槽位跨构建稳定；换盘 error；写坏存档防御；app 侧注册表端口落地 | 批次三认领：lead（`K2-STORAGE-HOST` 拆出） |
| K2-PROJECT | 项目级分析 core 已交付（重名/Layer/接管，13.5ms）；**未接入宿主与插件消费面** | 项目级冲突编译期可见；与 convention-linter/condition-extractor 边界写清 | 批次三认领：lead |
| K2-SEM | 语义与诊断：类型检查、符号解析（表达式 AST 化）、展开视图、迁移码并表 | 诊断快照稳定；错误不产字节；adapter 码 additive | 批次三认领：lead（`K2-SEMANTIC-CORE` 拆出） |
| K2-MIGRATOR | 迁移引擎机械层已交付（42 tests）；**语义升级（当→#表/分支→#池/初回→@原生）未做** | 不可迁移项经 PITFALLS 双证后转可迁移或维持 fail-closed | 批次三认领：lead（`K2-MIGRATE-SEMANTIC` 拆出） |
| K2-CUTOVER | 单批切换：app 接线/主题合并/`.kojo` 扩展名/退役旧解析器；**批次三先做预演（feature flag）** | 仓内无旧 golden/旧分支；全量测试不回退；发布态单一模式 | 批次三认领：lead（`K2-CUTOVER-PRE` 拆出） |
| K2-PRE-REUSE | 旧后端复用面缺陷：①字面量编码器（心形 `@"…"`）②空产物守门被注释穿透 ③写后回读失败不回滚 ④诊断列折回物理行 ⑤CJK 函数头自证 | 每条红→绿用例；只修复用面；全量不回退 | 批次三认领：lead · 来源：语言实现审阅（workbuddy 注 2026-10-22：**②③⑤ 已由本组落 dev**＝`c11cb3d4` 注释穿透 / `08ac046d` 回读回滚 / `51eef191` CJK 函数头，回执与读数在各提交信息；**① 字面量编码器本组认领后遇 429 未开工**，④ 与 POS-UTIL 合流——①④ 留给 lead 批次三收口时定派） |
| K2-RELEASE | R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真实工程人工验收 | P0 全完成；eraTW 完整体验；反向回滚可用 | 待认领 |
| K2-INCR-HOLES | 增量已知洞（收口后仍余）：`选项`/BOM 粘性永久全量；整份替换/改 `# 视` 仍整份重建（~200–300ms）；声明单元内编辑 55–75ms；槽族正则只覆盖 `rand/foreach`；构建期自检冷路径 ~300ms。已收口：结构行插入不再永久 degraded（退化判据细分 `lastUnmodelledReason`，25,200 步 fuzz 0 mismatch）、粘贴多行 185→20ms / 跨行删 195→19ms | 每次退化可见；与全量逐字节等价不破 | 待认领 · 认领：lead 2026-10-22 |

> **批次三并行说明（2026-10-21/22）**：17 路子 agent 按互不重叠写域推进（FOREACH/OPTIONS/EDITOR-WIRE/EDITOR-SEMANTIC/EDITOR-MIGRATE-UI/MIGRATE-SEMANTIC/CONFORMANCE/PERF-INCR/TS-RUNTIME/SOURCEMAP-HOST/STORAGE-HOST/CUTOVER-PRE，加接线 OPTIONS-WIRE/FOREACH-WIRE/EDITOR-HOOKUP，加 parser 健壮性修复）。组长统一收口、跑门、提交。完成行按协议删行，回执进提交信息。

## 批次四（2026-10-22，已交付）

> **批次四 17 路全部交付并接主链**（EXPR-AST/SEMA-TYPES/TABLE-SELECTCASE/POOL-SELECTCASE/PROGRAM-RECURSION/FEATURE-GATE-UNIFY/WEAVE-LAYER/SOURCEMAP-SEGMENTS/PERF-INCR-FALLBACK/CONFORMANCE-CLI/STORAGE-PERSIST/EDITOR-PROVIDERS/EDITOR-OPEN-PATHS/MIGRATE-MOUNT/PREVIEW-PANEL/TS-WORKER/CUTOVER-THEME）+ 3 路收口（raw 块字节透传 + lift 回滚、递归闸单源 + domainSymbols.variables、表/池 SELECTCASE 落点契约化）。完成行已删，回执进提交正文。

## 批次五（2026-10-22，已交付）

> **批次五 10 路全部交付**（STORAGE-HOST-FULL / SEMA-WIRING / EDITOR-MOUNT / NATIVE-DEDENT / CUTOVER-STAGE / MIGRATION-DIFFERENTIAL / PROJECT-HOST / CODES / CODE-ACTIONS / RELEASE-GATE）；完成行已删，回执进提交正文。

## 批次六（2026-10-22，已交付）

> **批次六 10 路全部交付**（STORAGE-WIRE / PROJECT-WIRE / NATIVE-COLUMNS / ADAPTER-PROFILE / MIGRATE-SEMANTICS-2 / FOLD-INDENT / INCR-HOLES / CUTOVER-ROUTE / RELEASE-CI / CORPUS-EXPAND）+ 3 处组长接线（App 项目级分析装配、事件面词 `eventNames` 进 app、`@原生` 物理列口径翻转）；完成行已删，回执进提交正文。

## 批次七（2026-10-22，已交付）

> **批次七 8 路全部交付**（MIGRATE-SHAPE / STORAGE-RECYCLED-UI / EXPAND-VIEW / FORMAT-2 / LANG-CONFORMANCE / RELEASE-AUTOMATION / SEMA-QUICKFIX / EDITOR-SYMBOLS）+ 5 处组长接线（大纲/格式化 provider 注册、展开视图编译来源、`eventArgs` 进 app、面包屑 2.0 分支、artifact 阈值重基线）；完成行已删，回执进提交正文。


## 编辑器体感对齐（ERB / kojo2 同权 · 2026-10-22）

> **依据**：2026-10-22 体感评审（对标 VS Code 的 LSP 面逐项补齐）。**原则**：ERB 与 kojo2 同为一级语言，能力矩阵由 descriptor 声明 + `LANG-PARITY-GATE` 钉住；禁止"某 provider 只挂一门语言"。来源：组长评审，待认领。

| ID | 任务（落点） | 关键判据 | 状态 |
|---|---|---|---|
| LANG-UX-MATRIX | 真壳体感验收矩阵：两语言逐项（折叠/跳转/引用/重命名/补全/格式化/诊断/预览/大纲/面包屑/展开/peek）读数进 STATE；壳冒烟纳入 `release-gate --shell` | 每项有实测读数；不回退 | 批次九认领：lead 2026-10-22 |

> **批次八（2026-10-22，已交付）**：12 路并行——ERB 树层全量 facets（indents/brackets/diagnostics/semantic）、ERB 成员补全、kojo2 引用/重命名/签名/inlay/code lens/高亮扩选/调用层级、缩进括号、补全补位、能力矩阵闸；组长接线 8 枚 provider + 补全注入 + ERB 结构诊断上屏。完成行已删，回执进提交正文。

> **批次九（2026-10-22，在办）**：9 路并行——ERB 两枚 provider 补齐、kojo2 跨文件引用/重命名/调用层级、项目索引、indents 规则消费、补全数据源、真实语料机、体感验收矩阵。provider 注册与矩阵改口由组长统一接线。


| K2-CORPUS-SOURCE | 真实语料机**没有输入**：本机 eraTW 4.980 基线是纯游戏盘（无 `.kojo`，递归发现 0 份）；`corpus` 工具已就绪（缺席 rc=2 / 0 份 rc=1 不当绿），需把 `KOJO_CORPUS_DIR` 指向含 v1 作者源的工程或迁移快照盘后再重生成 golden | 发现 ≥1 份 `.kojo` 且状态/原因分类可读 | 待认领 |

> **批次九（2026-10-22，已交付）**：9 路并行——ERB 高亮/扩选、ERB 调用层级 provider、kojo2 项目索引+跨文件引用、跨文件重命名/调用层级纯 API、indents 规则消费、补全数据源（adapter 契约 + eraTW 真源）、真实语料机（`corpus` 子命令）、体感验收矩阵；组长接线（ERB 两枚 provider 注册、项目级引用面 + 打开中 model 喂索引、能力矩阵改口、矩阵/单源闸跟随）。完成行已删，回执进提交正文。

