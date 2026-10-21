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
|---|---|---|---|
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| REFS-WORKER | `scanFileRefs` 仍在主线程同步跑（`erb-parser/plugin.ts` 的 `compute.runSliced` 回调），而单文件解析已 `compute.offload`；快照未命中轮 refs scan 实测 7.4s（`read+parse 6.9s` 之外的第二段大头） | 判据：把 `scanFileRefs` 搬进 compute worker 后主线程长任务/让路读数下降；`references` / find-references / rename 全量对拍逐字不变；**先量文本克隆税**，净收益不达标就报红留数、不硬搬；refs 判据与快照格式零放宽 | 进行中（**计时读数作废**）· 认领：chief 2026-10-21（代码与等价用例在 `b/chief/1021-refs-worker`＝WIP `f3332595`；同机并发把 A/B 全污染 ⇒ 必须空闲机**独占**重测文本克隆税再判搬／不搬） |
| REFS-PROVENANCE | refs 只记「当时已知名」的引用（`scanFileRefs(text, hasName)`），名录一变就要全树重扫：新增/改名一个函数会触发 ~7.4s（`namesFp` 不符 ⇒ 逐条目溯源巡检） | 判据：按文件持久化**不依赖当前名录**的候选记号（或等价溯源位），名录变更只重扫受影响文件；新旧路径 `bySymbol` / 快照 / 查找引用 / 重命名逐字等价；先写一条能红的用例（改一个名字只应扫少量文件）；`SNAPSHOT_VERSION` 换代与迁移可见，不许靠放宽判据凑绿 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20（workbuddy 2026-10-22 认领后因配额中断**零开工**、退回；判据原样有效） |
| FIND-REPLACE-SEED | **替换框与查找框同病**：`_state.replaceString` 在 widget 懒创建时也进不了替换输入框（本波只交付了查找词那一格，`monaco-find-patch-behavior` 未钉替换格）。现在重启后恢复的是"词"，替换框第一次打开是空的——而 `SerializedFind` 里 `replaceString` 明明存着 | 判据：照 FIND-STATE-CLOBBER 第二层的同一条路补替换框回填（同一补丁区域），用例必须在真 widget 的 DOM 上取替换框实际值；改补丁 ⇒ **同笔提交 `pnpm-lock.yaml` 的 `patchedDependencies` 哈希**；三档 seed 与查找格既有 12 条读数零回退 | 待认领 · 发现：chief 2026-10-21（widget-seed 单自陈「我故意没改的口子」①） |
| EOL-OVERRIDE-NOEOL | **显式切档与"无行尾⇒落创建档"相互抵消**：`applyEolToModel`/`eolOverride`（保存面）与本波 `disk-text-sync` 的"整篇无行尾时落 `model.getOptions().defaultEOL`"两条规则叠加后——作者显式选 CRLF、而盘在该刻被压成单行 ⇒ 档位被打回创建档，**与旧 `setValue` 通道同错**（这条"同错"是刻意保持的等果，不等于对作者是对的）。取证边界一并记：BOM 与 `\u2028/\u2029` 异常行尾对 `_getEOL` 计数的影响未查；档位翻转对脏判定（`alternativeVersionId`）的上层影响属调用方口径 | 判据：先量清"作者显式覆盖位"与"创建档"谁优先（读 `eolOverride` 置位时机与保存链 `writeText({eol})` 的实际落盘字节），再决定是否让覆盖位压过创建档；**不得动**本波刚钉的 25 条同果对拍（那是与旧通道的等果基线），要破等果必须先带读数说明为什么作者面更对；只读取证单优先，实现单等组长定口径 | 待决策 · 发现：chief 2026-10-21（eol-edge 单自陈「我故意没查的口子」①） |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |

## 在办 · Kojo 2.0（设计基线 v0.9 · 批次三 2026-10-21）

> **依据**：`docs/KOJO-2.0-LANGUAGE-SPEC.md`（v0.9 设计稿+任务清单合并入库版）。
> **已定**：开发期双前端并存、发布态单一模式（CUTOVER 单批收口）；旧前端只修会被 2.0 复用的后端面；看板按包/文件粒度拆行。
> **批次一/二已落 `dev`＝`58f86e7c`**：core 包/前端/降糖/端到端/迁移引擎/适配层/项目层/eraTW backend/Monaco 2.0 语言面/tree-sitter v2。对应行已销，回执在提交正文。批次三 12 路并行（见文末新行）。

| ID | 任务（落点） | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
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
| K2-EDITOR-MOUNT | 宿主挂载残项（批次三已交付纯模型/组件，入口未接）：①completion/hover/definition 翻 Monaco provider 并注入当前 `GameAdapter`；②预览面板渲染 `kojo2-preview-model` 行/滚动/诊断气泡；③迁移向导挂 App 入口（`kernel.io` + `onApplied` 刷新）；④打开路径认 `.kojo2`（drag-drop/save 扩展清单/quick-open/欢迎页最近文件/Ctrl+N 向导）；⑤诊断真壳验收（只出现 2.0 来源、切标签撤条、失败 toast） | 每项 flag 关 ⇒ v1 逐字不变；真壳读数；不抢 v1 marker owner | 待认领 · 认领：lead 2026-10-22 |
| K2-STORAGE-HOST | 存储期分配器**宿主侧持久化**：注册表（`ui/kojo2-storage-registry.ts`，22 tests）已交付；**未做**：落 kernel storage 域、两阶段提交、换盘检测接线、`declarationKey` 真账本 | 崩溃不留半批；同键幂等；换盘 error 上屏；跨文件符号可跳 | 部分交付 · 认领：lead 2026-10-22 |
| K2-SOURCEMAP-HOST | source map 消费面：双向模型 + 预览模型已交付（33 tests，1 基 UTF-16 口径）；**未做**：预览面板/高亮/跳转的 UI 接线 | 逐行映射；不可映射显式 null；还原等价 | 部分交付 · 认领：lead 2026-10-22 |
| K2-SEMANTIC-CORE | 表达式 AST 化（可选）：把 ExprText 升级为 core 表达式语法树，供类型检查/悬停；保持与既有表达式降糖对拍 | 全量对拍等价；golden 不回退；性能不回退（或仅语义服务用） | 批次三认领：lead |

> **批次三并行说明（2026-10-21/22）**：17 路子 agent 按互不重叠写域推进（FOREACH/OPTIONS/EDITOR-WIRE/EDITOR-SEMANTIC/EDITOR-MIGRATE-UI/MIGRATE-SEMANTIC/CONFORMANCE/PERF-INCR/TS-RUNTIME/SOURCEMAP-HOST/STORAGE-HOST/CUTOVER-PRE，加接线 OPTIONS-WIRE/FOREACH-WIRE/EDITOR-HOOKUP，加 parser 健壮性修复）。组长统一收口、跑门、提交。完成行按协议删行，回执进提交信息。
