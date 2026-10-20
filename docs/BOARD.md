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
| FOLD-REST | 大纲/折叠收尾：登记 `数据表` / `出错处理`（AST 侧）与 ask / choice / head_decl 那几族（先判能不能登记，不能就写清为什么） | 判据：`kojo-ts-vs-monarch-ab.test.ts` 三块地板与判据文件**一字不许动**（现测 98.57 / 地板 97）；「仅 CST」清单里 `data_head 1 / catch_head 1 / ask_m_head 2 / ask_yn_head 2 / choice_item 8 / head_decl 2` 逐行交代去向；每条新断言先证红 | 进行中 · 认领：e19erb 2026-10-20 |
| DOM-SMOKE-PORT | `smoke-tauri-dom.mjs` 认 `KOJO_SMOKE_VITE_PORT`（与 ipc/market 同口径），1420 被占时也能跑通并交回读数 | 判据：改后 `KOJO_SMOKE_VITE_PORT=1432 node tools/smoke-tauri-dom.mjs` 在本机（1420 被隔壁活会话占）真跑出结论；两条 L1-0 硬断言不得放宽；端口覆盖走 `smoke-lib` 既有 `devTarget`，不碰别人的 vite | 进行中 · 认领：e19erb 2026-10-20 |
| MULTI-CORPUS | 多语料盘只读普查：`C:/game` 下 eraFL / eratw 原生 4.842 / 魔王改版 / eraAkumaMaid / 画蛇添足 五盘各走一遍索引，报适配器识别、文件数、名录数、解析失败与编码分布 | 判据：**全程只读**（临时 storage）＋ 结论带数；发现硬失败就落成看板欠账，不许当场放宽判据；若可稳定复现则补一条 skipIf 语料门测试 | 进行中 · 认领：e19erb 2026-10-20 |
| ENCODE-SS | 落盘编码口径单源：编译产物 / 脚手架 `writeBytes` / `exportFile` 三条路径各自写什么 BOM/EOL，把判据收口到一处并加守卫 | 判据：先用真实字节取证（现成测试里的 golden 与 `artifact.ts` 跳过逻辑）再决定要不要改；默认档金样逐字节不许变；**不写游戏目录**（MemoryStorage / 临时目录） | 进行中 · 认领：e19erb 2026-10-20 |
| UI-COPY | 宿主 UI 文案里机器名泄漏扫描：`erb.` / `sugar.` / `compute.` 一类 kind 串、camelCase 英文标识符是否直接上屏；只做客观泄漏的机械修正 | 判据：逐条列出「文件:行 + 屏上原文 + 应改成什么」，不确定语气的一律不动（产品语气归用户）；修一处留一处对照；豁免表按 文件+处数 钉死 | 进行中 · 认领：e19erb 2026-10-20 |
| EMUERA-CLI | 真引擎 CLI 取证（#19）：用 `tools/engine-loadtest.mjs` / `C:/DSH/vendor/clidbg-probe` 的 `--CliDebug`，在 `%TEMP%` 硬链接镜像里加载**无 BOM UTF-8** 的原生起手包与中文打印样例，判引擎到底解码对不对 | 判据：游戏目录**只读**（镜像走 `%TEMP%`、跑完删）；必须给出引擎 stdout 原文（中文是否乱码）与警告集读数；不得以「看起来正常」结案；跑不了就交清缺哪个前置 | 进行中 · 认领：e19erb 2026-10-20 |
<<<<<<< HEAD
=======
>>>>>>> 34e5fec (docs(state,pitfalls,board): TSIT-5 落账（9218/60·9278）+ PITFALLS 142 记"台词串成规则牵动四条口径" + 看板删两行)
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
