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
| SAVE-BUTTON-IO-SEAM | 出路① 只收了**项目级**可写态，**每个文件那颗保存**仍按另一套判定 `kernel.io.isWritable(path)`（`EditorPane.tsx:529` / `:1160` / `:1597` / `:2188`，读的是 TS 批准记录 = `writablePaths`）⇒ 宿主准入门拒过的目录里：只读横幅、状态栏「只读」胶囊、带「重新选择这个文件夹」的常驻错误条都已到位，但按「仍要直接编辑」解锁之后**保存按钮物理上仍可点**、按下仍吃一句 `可写范围拒绝（write）：… 不在可写范围内` | 真壳读数（2026-10-21，未交付语料 `C:\game\eratw-画蛇添足版eratw4.980`）：`a / a3 / b0 / b1 PASS`（a3＝新落的出路门：错误条常驻 + 按钮在屏）、`b 域内写 FAIL`＝本行残留；同一棵树换到已在册的 `C:\game\eraAkumaMaid` ⇒ 全绿。两条修法都**跨线**、要点头才动：① 宿主拒过 ⇒ `kernel.io.setWritableRoots([])`（重新交付成功后按记录放回；作者工作区与常驻可写根不受影响）；② 保存前先看宿主那份事实、把这颗按钮直接置灰并把焦点交给错误条。判据：**不得放宽写域、不得靠清 TS 批准记录来"消红"**；`EditorPane.tsx` 是冲突热点（在飞三条 `b/lead/1020-preview-lift` / `b/veto/1020-write-exit` / `b/w8-a-eol-save` 都改它，动手前先看清）；新增上屏句子要同步守卫用例与手测文档 | 待决策 · 发现：e19erb3 2026-10-21（WRITE-ADMIT-SPLIT 出路① 交付时暴露） |
| FIND-STATE-PERSIST | Monaco 内置查找框的搜索词 / 三开关**不能按文件跨会话保持**：`IEditorFindOptions` 不含搜索词，find controller 是私有贡献（id 与 `FindReplaceState` 均未公开）；`saveViewState` 只带 widget 可见性与 scrollTop；standalone 的 storage 是内存态。现状：同会话按编辑器实例（切标签共用一词），重启全丢 | 取证（W7-F 2026-10-20，monaco 0.57）：零 monkey-patch 不可实现。可选路线：①公开命令 `editor.actions.findWithArgs` 近似恢复（切文件会短暂弹出查找框、污染查找历史、需防选区覆盖搜索词）；②等上游公开 API；③vendor 补丁（现禁用）。需产品取舍后再认领 | 待决策 · 发现：W7-F 2026-10-20 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| REFS-WORKER | `scanFileRefs` 仍在主线程同步跑（`erb-parser/plugin.ts` 的 `compute.runSliced` 回调），而单文件解析已 `compute.offload`；快照未命中轮 refs scan 实测 7.4s（`read+parse 6.9s` 之外的第二段大头） | 判据：把 `scanFileRefs` 搬进 compute worker 后主线程长任务/让路读数下降；`references` / find-references / rename 全量对拍逐字不变；**先量文本克隆税**，净收益不达标就报红留数、不硬搬；refs 判据与快照格式零放宽 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20 |
| REFS-PROVENANCE | refs 只记「当时已知名」的引用（`scanFileRefs(text, hasName)`），名录一变就要全树重扫：新增/改名一个函数会触发 ~7.4s（`namesFp` 不符 ⇒ 逐条目溯源巡检） | 判据：按文件持久化**不依赖当前名录**的候选记号（或等价溯源位），名录变更只重扫受影响文件；新旧路径 `bySymbol` / 快照 / 查找引用 / 重命名逐字等价；先写一条能红的用例（改一个名字只应扫少量文件）；`SNAPSHOT_VERSION` 换代与迁移可见，不许靠放宽判据凑绿 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |
