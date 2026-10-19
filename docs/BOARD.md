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
| F12-TOKEN | **中文函数名的 F12 一直是瞎的**：把记号尺拉平到 Unicode，并定清「函数索引路 vs 库表反查路」的优先序 | 实测：`plugin-api/src/symbol-token.ts:23` 缺省字符集 `[A-Za-z0-9_]`，`:10-11` 明写「刻意不收 `:` / `.` / CJK」⇒ `definitionTargetsAt`（`erb-parser/src/references.ts:423` 同用这把尺）对 `@好感度检查` 取词 `undefined` ⇒ 命中 **0** 处；而语料 `@` 定义 128,736 行里 **27,171 个名字含非 ASCII = 21.1%**（DRIFT-APP 批实测）。DRIFT-APP 已把**悬停**那一路接上 `unicodeTokenAt`（`semantic-locate.ts:26`），故现状是**悬停查得到、F12 仍跳不动**的不对称——本行收的就是这个口。硬约束：反查路不许一起放宽（eraTW 库表 471 条中 **13 条原生名本身是中文**，如 `充填率`；一起放宽会让库表路抢掉函数索引路的 docComment 与定义位）；放宽须带 **A/B 命中率**读数，并交代"光标停在中文散文里"的误命中面（`symbol-token.ts` 头注里"宁可窄"的理由要推翻必须带数）；牵动 `references` / `definition` / `label` 三条腿 + `erb-parser`，**与 ERB 粒度批同文件 ⇒ 串行，等其落地** | 待认领（本会话冻住） |
