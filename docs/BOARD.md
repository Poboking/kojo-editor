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
| TSIT4-A | **语法层三形覆盖补齐**：`heartHead` / `statementCall` / `controlMalformed` 三枚 kind 在 19 文件语料里**一次都没出现过**（覆盖面读数 53/56），等于这三条判据从没被对账过 | 判据＝新增夹具把覆盖推到 **56/56**，且三形都要进 CST↔`classifyLine` 逐行对账、`真冲突` 仍 **0**、一致率仍 **100.00%**；分母会随夹具变大是**允许方向**但必须重算并报新数（9,102 行 / 19 文件是现值）。**不许动 grammar 语义与 `classifyLine`**，只加夹具与覆盖面断言；`wasm-size` 棘轮与 `word-forms-single-source` 七条守卫不许碰 | 进行中 · 认领：qoder 2026-10-20 |
| TSIT4-B | **结构层 vs 词法层的逐格差异归因表**（"能不能把默认打开"的决策材料）：token A/B 现在只报一个总数 99.58%（分母 97,143 格），那 0.42% ≈ **408 格**从没归因过 | 判据＝把每一格不同按 **(kind × tier 对)** 分类计数，逐类给出「结构层更对 / 词法层更对 / 说不清」三桶 + 每桶样例行号，并落一条**按桶计的棘轮**（说不清的桶只降不升）。**纯只读归因，不许改生产代码、不许动四块地板读数**（终点一致 100.00% / 起点精确 97.19% / 召回 97.20% / token 99.58%）；结论用人话写进提交信息，不上屏 | 进行中 · 认领：qoder 2026-10-20 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
