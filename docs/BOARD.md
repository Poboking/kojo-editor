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
| FIND-STATE-PERSIST | Monaco 内置查找框的搜索词 / 三开关**不能按文件跨会话保持**：`IEditorFindOptions` 不含搜索词，find controller 是私有贡献（id 与 `FindReplaceState` 均未公开）；`saveViewState` 只带 widget 可见性与 scrollTop；standalone 的 storage 是内存态。现状：同会话按编辑器实例（切标签共用一词），重启全丢 | 取证（W7-F 2026-10-20，monaco 0.57）：零 monkey-patch 不可实现。可选路线：①公开命令 `editor.actions.findWithArgs` 近似恢复（切文件会短暂弹出查找框、污染查找历史、需防选区覆盖搜索词）；②等上游公开 API；③vendor 补丁（现禁用）。需产品取舍后再认领 | 已定路线 · 认领：chief 2026-10-21（用户 2026-10-21 点头走 **③ vendor 补丁**根治，另在设置页加「查找词优先：选区 / 上次使用」作者开关；取证读数与三路线成本表在 `b/chief/1021-find-persist-probe`＝`779bcb36`；实现单排在 RELOAD-STATE-KEEP 之后——两单都碰 `EditorPane.tsx`，必须串行） |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| REFS-WORKER | `scanFileRefs` 仍在主线程同步跑（`erb-parser/plugin.ts` 的 `compute.runSliced` 回调），而单文件解析已 `compute.offload`；快照未命中轮 refs scan 实测 7.4s（`read+parse 6.9s` 之外的第二段大头） | 判据：把 `scanFileRefs` 搬进 compute worker 后主线程长任务/让路读数下降；`references` / find-references / rename 全量对拍逐字不变；**先量文本克隆税**，净收益不达标就报红留数、不硬搬；refs 判据与快照格式零放宽 | 进行中（**计时读数作废**）· 认领：chief 2026-10-21（代码与等价用例在 `b/chief/1021-refs-worker`＝WIP `f3332595`；同机并发把 A/B 全污染 ⇒ 必须空闲机**独占**重测文本克隆税再判搬／不搬） |
| REFS-PROVENANCE | refs 只记「当时已知名」的引用（`scanFileRefs(text, hasName)`），名录一变就要全树重扫：新增/改名一个函数会触发 ~7.4s（`namesFp` 不符 ⇒ 逐条目溯源巡检） | 判据：按文件持久化**不依赖当前名录**的候选记号（或等价溯源位），名录变更只重扫受影响文件；新旧路径 `bySymbol` / 快照 / 查找引用 / 重命名逐字等价；先写一条能红的用例（改一个名字只应扫少量文件）；`SNAPSHOT_VERSION` 换代与迁移可见，不许靠放宽判据凑绿 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |
| RELOAD-STATE-KEEP | 外挂工具改了盘之后，**光标 / 撤销栈 / 会话内解锁**三样留不留得住全是未验：手测清单 j2 明写"未验的一小条：光标位置与撤销栈是否保留，需真人真壳 Ctrl+Z 确认"，§六 口径事实①"关最后一个标签 ⇒ 组件卸载 ⇒ 会话内解锁失效"，j3「重新加载（放弃我的修改）」那颗按钮从未被点过 | 判据：本行**先出真壳读数再谈实现**——同文件改前记行列与撤销步数，外部写盘后断言两者不变且 Ctrl+Z 一次回到作者上次改动；脏冲突通知按钮可点、点后屏上＝盘上内容。顺带钉一条事实：非作者意图变更（保存前整理 / 全角空格修复 / 格式化）现状**全占 Ctrl+Z**（`ISilentModelEditStackAnnotation` 与 `transient` 在 dev 功能面 0 命中）——是否豁免由读数决定，不许顺手改 | 取证完成 · 认领：chief 2026-10-21（真壳读数：**A 外部写盘后光标保住 4:22、撤销栈被清空**（连按 5 次 Ctrl+Z 屏上零变化，作者未保存编辑再也回不去）＝数据丢失级 ⇒ **实现单排波三最前**；B 全角替换占 Ctrl+Z（撤掉的是整篇替换）；(a) 整理 / (c) 格式化 触发选点失败，未定论） |
