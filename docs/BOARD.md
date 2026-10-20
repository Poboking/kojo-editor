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
| FIND-STATE-PERSIST | Monaco 内置查找框的搜索词 / 三开关**不能按文件跨会话保持**：`IEditorFindOptions` 不含搜索词，find controller 是私有贡献（id 与 `FindReplaceState` 均未公开）；`saveViewState` 只带 widget 可见性与 scrollTop；standalone 的 storage 是内存态。现状：同会话按编辑器实例（切标签共用一词），重启全丢 | 取证（W7-F 2026-10-20，monaco 0.57）：零 monkey-patch 不可实现。可选路线：①公开命令 `editor.actions.findWithArgs` 近似恢复（切文件会短暂弹出查找框、污染查找历史、需防选区覆盖搜索词）；②等上游公开 API；③vendor 补丁（现禁用）。需产品取舍后再认领 | 待决策 · 发现：W7-F 2026-10-20 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| CASE-MULTILINE-VALUES | CASE 多行值列表未拼（STATE 行 32）：拼接估 +311 谓词，需基线取舍 | 先取证：现状归类 / +311 构成 / 误报风险面，证据齐再定实现或缓做。**引擎取证已到位**（e19erb 2026-10-20，Emuera `MinorShift.Emuera.Sub/EraStreamReader.cs:96 ReadEnabledLine`）：行連結**只有**孤行 `{`…`}` 一种，块内物理行以 `Config.ReplaceContinuationBR`（默认一个空格）拼接，引擎侧不存在「行尾运算符⇒续行」⇒ 判据取**块成员**、不取尾逗号（盘上两形并存：块内 `ERB/fromEN/_TR Lib.ERB:2104-2107` 的 CASE 列表该拼，非块的 `ERB/SHOP関連/ITEMDATA.ERB:15` 尾逗号 CASE 拼了会吃掉下一行的内层 `SELECTCASE`）；反例与读数详 PITFALLS 156（按尾逗号粘＝基线盘凭空 +285 条 opaque） | 认领：lead·W8-C 2026-10-20 |
| SNAPSHOT-MISS-ATTR | 派生快照未命中（索引可用 16.8s vs 命中 3.05s）触发未归因（STATE 行 28）：立项「受控作废」复现 + read+parse 6.9s / refs scan 7.4s 分段 | 判据：每类失效输入位有受控复现读数；定位到「不该失效却失效」的判据则取证留认领 | 认领：lead·W8-D 2026-10-20 |
| UPDATER-ENV-PROXY | 自动更新跟随环境代理（STATE 行 45 下批待办）：Rust 侧读 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 经 check 的 proxy 参数传入，未设置零改动 | 判据：cargo 单测覆盖优先序 / 畸形值忽略 / 未设置不传；audit ✅ | 认领：lead·W8-E 2026-10-20 |
| BETA1-INSTALL-DOCS | v0.4.0-beta.1 发版余项（STATE 行 49）：面向用户的安装/使用文档——USER-GUIDE 补安装 / 首启 / 自动更新 / 常见问题，术语照「.kojo 语言/预览/校验」口径 | 纯文档批豁免测试面；签名状态以仓库/CI 工作流事实为准，不编造 | 认领：lead·W8-G 2026-10-20 |
| REFS-WORKER | `scanFileRefs` 仍在主线程同步跑（`erb-parser/plugin.ts` 的 `compute.runSliced` 回调），而单文件解析已 `compute.offload`；快照未命中轮 refs scan 实测 7.4s（`read+parse 6.9s` 之外的第二段大头） | 判据：把 `scanFileRefs` 搬进 compute worker 后主线程长任务/让路读数下降；`references` / find-references / rename 全量对拍逐字不变；**先量文本克隆税**，净收益不达标就报红留数、不硬搬；refs 判据与快照格式零放宽 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20 |
| REFS-PROVENANCE | refs 只记「当时已知名」的引用（`scanFileRefs(text, hasName)`），名录一变就要全树重扫：新增/改名一个函数会触发 ~7.4s（`namesFp` 不符 ⇒ 逐条目溯源巡检） | 判据：按文件持久化**不依赖当前名录**的候选记号（或等价溯源位），名录变更只重扫受影响文件；新旧路径 `bySymbol` / 快照 / 查找引用 / 重命名逐字等价；先写一条能红的用例（改一个名字只应扫少量文件）；`SNAPSHOT_VERSION` 换代与迁移可见，不许靠放宽判据凑绿 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层待 grammar 质量闸） |
| ERB-TS-STRUCTURE | **ERB 结构专用 tree-sitter 以正式包/分支推进，不做临时目录特例**：只覆盖 `@` 函数头 / `#` 指令 / `$` 标签 / 控制流配对 / 注释与字符串 / `[SKIPSTART]` 块 / 通用语句行；不做完整 Emuera 关键字语法，不做 semantic tokens，不把 CST 喂索引。首版目标：折叠（优先 5k–50k 大文件）与可去重的残缺提示；ERB / Kojo 共用同一套叠层基础设施 | 判据：真语料全量解析，合法文件 ERROR/MISSING 为 0（或白名单钉住不支持构造）；52k 行文件首解 / 每击键 p95 / 内存有读数；折叠区间与服务逐项对拍；**质量阈值只决定默认开启时机，不决定 ERB 是否一等支持**；正式包、测试与构建链进仓；宿主无单语言分支；未达阈值报红留数、不默认开启 | 进行中 · 认领：lead 2026-10-20 |
