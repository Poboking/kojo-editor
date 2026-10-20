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
| EOL-OVERRIDE-SAVE | 状态栏 EOL 切换的**保存面未闭环**：`model.setEOL` 只改缓冲；保存走 `writeText` 缺省 `preserveEol`，纯换行切换会被 `isUnmodifiedAgainst` 零改动快道原样回写，混改时 `reconstructEol` 也按原多数派归一 ⇒ 切换看似生效、落盘仍是旧换行；autosave 还可能清掉脏标记 | 已交付分支 `b/w7-h-eol-switch`（73a5378：UI + 模型切换 + 13 条测试，**未合 dev**）。闭环方案：`ModelEntry` 加"仅显式切换才置位"的 eol 覆盖位 → 保存仅当覆盖位存在时 `writeText(path, text, { eol })` → 成功后清位；重载 / 外部冲突 / 放弃修改时复位；`.kojo` 保存接管与 autosave 同语义 | 认领：lead·W8-A 2026-10-20 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| COND-RESIDUAL-13 | 条件抽取残余未解析 **13**（STATE 行 32）：11 条 `1pN` 位字面量 + 2 条 SIF 尾逗号。修法：表达式词法收 `1pN`；SIF 尾逗号先取证再修 | 判据：真语料未解析下降且不加假谓词；opaque 仍可查；快照格式换代按需 | 认领：lead·W8-B 2026-10-20 |
| CASE-MULTILINE-VALUES | CASE 多行值列表未拼（STATE 行 32）：拼接估 +311 谓词，需基线取舍 | 先取证：现状归类 / +311 构成 / 误报风险面，证据齐再定实现或缓做 | 认领：lead·W8-C 2026-10-20 |
| SNAPSHOT-MISS-ATTR | 派生快照未命中（索引可用 16.8s vs 命中 3.05s）触发未归因（STATE 行 28）：立项「受控作废」复现 + read+parse 6.9s / refs scan 7.4s 分段 | 判据：每类失效输入位有受控复现读数；定位到「不该失效却失效」的判据则取证留认领 | 认领：lead·W8-D 2026-10-20 |
| UPDATER-ENV-PROXY | 自动更新跟随环境代理（STATE 行 45 下批待办）：Rust 侧读 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 经 check 的 proxy 参数传入，未设置零改动 | 判据：cargo 单测覆盖优先序 / 畸形值忽略 / 未设置不传；audit ✅ | 认领：lead·W8-E 2026-10-20 |
| PERF-14-IPC-MERGE | 内核 storage 两趟 IPC 合并（STATE 行 30 PERF-13 尾）：lint 复用轮 `exists` + `readFileBytes` 两趟 → additive 单趟 | 判据：同输入对拍一致（不存在/存在/读失败）；既有契约语义不动 | 认领：lead·W8-F 2026-10-20 |
| BETA1-INSTALL-DOCS | v0.4.0-beta.1 发版余项（STATE 行 49）：面向用户的安装/使用文档——USER-GUIDE 补安装 / 首启 / 自动更新 / 常见问题，术语照「.kojo 语言/预览/校验」口径 | 纯文档批豁免测试面；签名状态以仓库/CI 工作流事实为准，不编造 | 认领：lead·W8-G 2026-10-20 |
