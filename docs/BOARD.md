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
| SMOKE-FEATURES-RED | `tools/smoke-editor-features.mjs` 在 daemon-free 端口上三项功能断言红：`KOJO_SMOKE_VITE_PORT=1445 node tools/smoke-editor-features.mjs` ⇒ 15 PASS / 3 FAIL / 1 SKIP，屏上原样：`❌ f4 💡 灯…未见 lightbulb`、`❌ f3 补全弹窗…未见补全弹窗`、`❌ f10 Unicode 高亮…8s 内未见 .unicode-highlight`（f4b/f3c 连带 SKIP）。期望三项 PASS | 判据：先在**基线树**（同 commit 不带宽端口收口）跑同一命令复现 ⇒ 分清「既有红 / 本批回归」；本批只改端口解析与 store 还原，未动任何断言。1420 属另一活会话，未触碰 | 待认领（发现：e19erb 2026-10-20） |
| COND-MULTILINE-OPAQUE | 条件抽取对 `{`…`}` + 行尾 `&&` 的**多行 IF 表达式**判 opaque、不进谓词：魔王改版 18 函数 / 36 谓词、官方 4.842 7 函数 / 19 谓词；三盘未解析谓词 36 / 19 / 41（样例 `K17_性交系コマンド.ERB` 多行 IF、`EVENT_K2_DAILY.ERB:224` 的 `DEVENT(@"%TEXTS("…")%…")` 嵌套引号） | 判据：修后 `unresolved` 计数下降且不新增假谓词；opaque 仍必须可查（现状不静默）；不许放宽既有谓词判据 | 待认领（发现：e19erb 2026-10-20） |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| REF-FRONT-PERF | 前端壳层少错化 + Rust 宿主性能批：①项目态错误可见（含写域失败/关闭失败）与外壳错误边界 ②App 项目生命周期抽 hook ③EditorPane 的 Monaco 实例与偏好订阅抽 hook ④Rust 阻塞 FS 命令下放 `spawn_blocking` 并优化明显热路径 | 判据：前端行为不变 + 新增错误路径测试；`@kojo/app typecheck` 0；相关 vitest 全绿；Rust `cargo test --lib` 不回退（基线 166 passed / 5 ignored）；两池、双 typecheck、`audit:decoupling`、真壳 DOM 冒烟全绿；性能读数带「改前/改后」同机同口径 | 进行中 · 认领：lead 2026-10-20 |
