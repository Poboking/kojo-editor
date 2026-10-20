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
| COND-MULTILINE-OPAQUE | 条件抽取对 `{`…`}` + 行尾 `&&` 的**多行 IF 表达式**判 opaque、不进谓词：魔王改版 18 函数 / 36 谓词、官方 4.842 7 函数 / 19 谓词；三盘未解析谓词 36 / 19 / 41（样例 `K17_性交系コマンド.ERB` 多行 IF、`EVENT_K2_DAILY.ERB:224` 的 `DEVENT(@"%TEXTS("…")%…")` 嵌套引号） | 判据：修后 `unresolved` 计数下降且不新增假谓词；opaque 仍必须可查（现状不静默）；不许放宽既有谓词判据 | 待认领（发现：e19erb 2026-10-20） |
| SEARCH-GLOB-WIRE | 检索面板的 glob 过滤**假生效**：`SearchFilterBar` 显示「glob 生效」、Rust `SearchOptionsDto.globs` 也已支持，但 `search-store.runSearch` 只发 `extensions`，`parseFileFilter(getGlobFilterText()).globs` 从未进入请求 | 复现：在检索框输入 `*.ERB` 类 glob 再检索，结果不被过滤。修法（W6-G 已给一行草案）：`options: { ...state.options, extensions, ...(globs.length ? { globs } : {}) }`；补一条「请求里带 globs」的用例；不得放宽既有 extensions 判据 | 待认领 · 发现：W6-G 2026-10-20 |
| SEARCH-REVEAL-NOFOCUS | 检索面板**连续回车逐项跳失焦**：`editor.revealLocation` 的落点腿会 `ed.focus()`（`EditorPane.applyReveal`），从检索框按第二次回车时焦点已在编辑器 ⇒ 只能跳一项 | 期望：键盘导航在检索框内连续跳（VS Code 行为）。修法：契约 `editor.revealLocation` 加 additive `focus?: boolean`（缺省 true），SearchPanel 键盘导航传 false，`applyReveal` 据此决定是否 `ed.focus()`；补两条用例（同文件 / 跨文件） | 待认领 · 发现：W6-G 2026-10-20 |
| FIND-STATE-PERSIST | Monaco 内置查找框的搜索词 / 三开关**不能按文件跨会话保持**：`IEditorFindOptions` 不含搜索词，find controller 是私有贡献（id 与 `FindReplaceState` 均未公开）；`saveViewState` 只带 widget 可见性与 scrollTop；standalone 的 storage 是内存态。现状：同会话按编辑器实例（切标签共用一词），重启全丢 | 取证（W7-F 2026-10-20，monaco 0.57）：零 monkey-patch 不可实现。可选路线：①公开命令 `editor.actions.findWithArgs` 近似恢复（切文件会短暂弹出查找框、污染查找历史、需防选区覆盖搜索词）；②等上游公开 API；③vendor 补丁（现禁用）。需产品取舍后再认领 | 待决策 · 发现：W7-F 2026-10-20 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
