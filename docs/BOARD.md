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
<<<<<<< HEAD
=======
| ⚑ 报红（非本组批次） | **挂语料全量有一条红，归 e19erb 线**：`分支` 词形进了词表但发版样例没跟上 | 现象：`pnpm test` 在**不挂语料**时全绿，**挂语料**时 1 条红。复现：`env KOJO_SMOKE_PROJECT='<语料盘路径>' pnpm test`（或 `node node_modules/vitest/vitest.mjs run packages/kernel/tests/sugar-releasecheck.transpile.test.ts` 同条）。期望 vs 实际：期望发版样例真用满每个写法（红项清单为空），实际报 2 项。屏上原样文案：`AssertionError: 发版样例里没用到的关键字：分支（block.branch）、branch（block.branch）: expected [ '分支（block.branch）', …(1) ] to deeply equal []`。取证：`packages/kernel` 与 `packages/plugins` 对 `origin/dev` 逐字节相同（`git diff --stat origin/dev HEAD -- packages/kernel packages/plugins` 为空），引入点＝`de6f52c feat(sugar): 分支：规则池`（给 `keywords.ts` 加 8 行、含 `block.branch` 的中文词形「分支」），而 `release-check.kojo` 最后一次被改是 `b597d5a` ⇒ 修法＝往发版样例补一条 `分支：` 用法（**不要**反过来把词形从覆盖率判据里摘掉） | 报红 · 待 e19erb 线认领（发现：qoder 2026-10-20，TSIT-4 收口轮） |
>>>>>>> 34e5fec (docs(state,pitfalls,board): TSIT-5 落账（9218/60·9278）+ PITFALLS 142 记"台词串成规则牵动四条口径" + 看板删两行)
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
