# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

> ⚠️ **分支模型变更（2026-10-19 生效，全组必读）**：`master` 已停用并从远端删除。
> **日常落地分支＝`dev`**（一切功能 / 修复 / 文档批的窄门出口），**`main`＝发行版分支**（只在用户点头发版时并入并打 tag）。远端默认分支＝`main`。
> 在途批次立刻执行：① `git fetch origin --prune`（不 prune 会在已死的 `origin/master` 坐标上开工）；② 新批次分支一律从 `origin/dev` 起；③ 在途分支换底 `git rebase --onto origin/dev <旧 base>`；④ 落地命令改成 `git push origin HEAD:dev`（`tools/git-push.mjs` 与 `tools/tauri-dev-fresh.mjs` 默认值已同步）。
> **禁止** `git push … :master`——GitHub 会把它当新分支**创建**，提交会漂进一条没人复审的平行主线（详 PITFALLS §133）。`gh pr create` 默认 base 现为 `main`，日常批须显式 `--base dev`。

## 在办

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| REFS-PROVENANCE | refs 只记「当时已知名」的引用（`scanFileRefs(text, hasName)`），名录一变就要全树重扫：新增/改名一个函数会触发 ~7.4s（`namesFp` 不符 ⇒ 逐条目溯源巡检） | 判据：按文件持久化**不依赖当前名录**的候选记号（或等价溯源位），名录变更只重扫受影响文件；新旧路径 `bySymbol` / 快照 / 查找引用 / 重命名逐字等价；先写一条能红的用例（改一个名字只应扫少量文件）；`SNAPSHOT_VERSION` 换代与迁移可见，不许靠放宽判据凑绿 | 进行中 · 认领：chief 2026-10-22（接 workbuddy 退回，判据原样）· 来源：Symbol DB 建议审阅 2026-10-20 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |

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
| K2-MIGRATION-CORPUS | 真实语料迁移 + 行为 differential；本机无真语料（`tools/corpus.mjs` rc=1），以仓内 fixtures + 语料机补测 | 迁移率可量化；编码/EOL 不变；壳冒烟 | 待认领 · 阻塞：语料不在位 |
| K2-CUTOVER | 单批切换：app 接线/主题合并/`.kojo` 扩展名/退役旧解析器；**批次三先做预演（feature flag）** | 仓内无旧 golden/旧分支；全量测试不回退；发布态单一模式 | 批次三认领：lead（`K2-CUTOVER-PRE` 拆出） |
| K2-PRE-REUSE | 旧后端复用面缺陷：①字面量编码器（心形 `@"…"`）②空产物守门被注释穿透 ③写后回读失败不回滚 ④诊断列折回物理行 ⑤CJK 函数头自证 | 每条红→绿用例；只修复用面；全量不回退 | 批次三认领：lead · 来源：语言实现审阅（workbuddy 注 2026-10-22：**②③⑤ 已由本组落 dev**＝`c11cb3d4` 注释穿透 / `08ac046d` 回读回滚 / `51eef191` CJK 函数头，回执与读数在各提交信息；**① 字面量编码器本组认领后遇 429 未开工**，④ 与 POS-UTIL 合流——①④ 留给 lead 批次三收口时定派） |
| K2-RELEASE | R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真实工程人工验收 | P0 全完成；eraTW 完整体验；反向回滚可用 | 待认领 |
| K2-EDITOR-MOUNT | 宿主挂载残项（批次三/四已交付组件与接线，**预览面板仍未挂载**）：①预览面板挂到 ProjectView/底部面板（复用诊断那次编译的缓存，禁二次编译）；②诊断真壳验收（只出现 2.0 来源、切标签撤条、失败 toast）；③`controller.retarget()` 接到另存为/改名链路；④存储账本接 kernel storage（水合镜像 + 串行队列，见 K2-STORAGE-HOST） | 每项 flag 关 ⇒ v1 逐字不变；真壳读数；不抢 v1 marker owner | 待认领 · 认领：lead 2026-10-22 |
| K2-STORAGE-HOST | 槽位持久化**宿主接线**：注册表（22 tests）+ 账本两阶段提交模块（34 tests）已交付；**未做**：kernel.storage 异步端口适配（镜像+队列）、`previousSnapshot` 持久化（P0：本账本无 valueType/arraySize，不能反哺 registry）、`recycled` 落账拦截、失败上屏映射 | 崩溃不留半批；换盘 error 上屏；改型跨构建可检测 | 部分交付 · 认领：lead 2026-10-22 |
| K2-SEMA-WIRING | 语义层接主链：`sema/checkKojoFile`（63 tests）与 `expr/**`（147 tests）已交付并进公共面；**未接线**：编译主链/宿主诊断调用点（与 lowering 同码同 span 按 `(code, span)` 去重）、`missing-return` 归属（避免项目层二次报）、外部变量数组面（`名[下标]`/`.长度`） | 不双报；错误不产字节；外部变量零假阳 | 待认领 · 认领：lead 2026-10-22 |
| K2-INCR-HOLES | 增量编译器已知洞：结构化模型自检失败即 `degraded` 永久全量（任意行位置插入任意结构行可复现）；多行替换/全文替换仍整份重建（263–368ms）；`选项`/BOM 文件永久全量；槽族正则需随新槽族同步 | 每次退化可见（`degradedReason`）；与全量逐字节等价不破 | 待认领 · 认领：lead 2026-10-22 |
| K2-NATIVE-DEDENT | `@原生`/原生块残项：core `lower/native.ts` 的去缩进诊断列折回物理行（v1 折行面已由 `foldPositionToPhysical` 收口，核心面未接）；raw 块行 sourceMap 仍整块挂块首行；`@`/`[SKIPSTART]` 块边界仍按逻辑行 | 折行/CRLF/CJK 列回映；字节级透传不回退 | 待认领 · 认领：lead 2026-10-22 |

> **批次三并行说明（2026-10-21/22）**：17 路子 agent 按互不重叠写域推进（FOREACH/OPTIONS/EDITOR-WIRE/EDITOR-SEMANTIC/EDITOR-MIGRATE-UI/MIGRATE-SEMANTIC/CONFORMANCE/PERF-INCR/TS-RUNTIME/SOURCEMAP-HOST/STORAGE-HOST/CUTOVER-PRE，加接线 OPTIONS-WIRE/FOREACH-WIRE/EDITOR-HOOKUP，加 parser 健壮性修复）。组长统一收口、跑门、提交。完成行按协议删行，回执进提交信息。

## 批次四（2026-10-22，已交付）

> **批次四 17 路全部交付并接主链**（EXPR-AST/SEMA-TYPES/TABLE-SELECTCASE/POOL-SELECTCASE/PROGRAM-RECURSION/FEATURE-GATE-UNIFY/WEAVE-LAYER/SOURCEMAP-SEGMENTS/PERF-INCR-FALLBACK/CONFORMANCE-CLI/STORAGE-PERSIST/EDITOR-PROVIDERS/EDITOR-OPEN-PATHS/MIGRATE-MOUNT/PREVIEW-PANEL/TS-WORKER/CUTOVER-THEME）+ 3 路收口（raw 块字节透传 + lift 回滚、递归闸单源 + domainSymbols.variables、表/池 SELECTCASE 落点契约化）。完成行已删，回执进提交正文。

