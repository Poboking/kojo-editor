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
| ST-CONSUMERS | **索引三态接给其余读索引的通道**：`Ctrl+T` 工作区符号 / 悬停 / 改名台账 / 调用层级，四条都还只问"有没有索引" | 已实测：三态判据已在 `erb-parser/src/index-state.ts`（`phaseOf()`/`coverageOf()` 两枚纯函数），函数树那侧按 `phase` **查表**接好了（`ui-kojo-navigator/src/panel-copy.ts`）；但 `app/src/ui/workspace-symbols.ts:301` 对 `fileCount === 0` 一律答「当前项目还没有可用的函数索引」⇒ "没地方可扫"与"扫了什么都没有"仍是同一句假话。**硬约束**：消费方零形状比较（判据单源守门 `ui-kojo-navigator/tests/index-state-single-source.test.ts` 已按处数钉死，新接的四条不许扩大豁免）；`EditorPane.tsx` / `editor-global-providers.ts`（面包屑与补全那两格）**不归本行**，与 FMT-TOAST 同文件 ⇒ 另单 | 认领：e19erb 2026-10-20 |
| FMT-TOAST | **格式化"这次没做"要看得见**：`onDegraded` 出口已备好但宿主没接线，作者只看到"按了没反应" | 已实测：五处让路点在 `app/src/monaco/kojo-format-range.ts:141`（`resolve`/`compute`/`resolveRange`/`windowCompute`/`anchor`），现在只 `console.warn`；壳层早有 `NotificationCenter.tsx` 的 `useNotify()` + `notice-queue.ts:32 pushNotice`（max 5，纯函数可单测），`App.tsx:728` 已在用它播报索引构建失败 ⇒ 缺的不是通道是去重。用户 2026-10-20 定的形状＝**①一次性 toast**（同 where + 同行区间一次会话只说一遍，键的算法照 `monaco/tree-sitter/fallback.ts` 的一次性去重）。on-type 每敲一键都可能命中 ⇒ 不去重就是刷屏 | 认领：e19erb 2026-10-20 |
| NEW-ERB | **纯 ERB 起手项目**（用户最初那条反馈）：新建口上项目没有纯 ERB 这条路 | 码上现状已实测：`eratw-adapter/src/scaffold.ts:15-20` 的设计注释说"脚手架一律给 `.kojo`（超集，原生可逐行直通）"——该理由对"要不要糖"成立，对"我就想写原生 ERB"不成立；`packages/kojo-project-kit` 全文不出现 `.ERB` 起手形态（grep 零命中）⇒ 作者没有语言档、也没有一句人话说明直写原生是合法的。**先取证再动手**：纯 `.ERB` 起手文件是否被索引/校验/导出链接受（索引面已由 IDX-ROOT 扩到工作区根），取证不过就只交报告，不硬做 | 认领：e19erb 2026-10-20 |
