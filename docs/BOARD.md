# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## 在办

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| IDX-ROOT | **ERB 索引根并入作者工作区根**：索引根由「只有 `project.kojoPaths`（游戏口上目录）」扩成 `project.kojoPaths ∪ workspaces.roots()`（默认根 ∪ 已授权自选根），让「我的口上项目」里作者自己写的 `.ERB/.ERM/.ERH` 第一次进入定义/引用/工作区符号/用量注解/实参提示这五条腿；根集合变化 ⇒ 记签名、作废在途构建、异步重扫并广播（今天没有"根变更"的总线事件，`roots()` 是同步零 IO 活读，不许缓存） | 已实测：`plugins/erb-parser/src/plugin.ts:608-630` 只在 `project.opened` 设根、`project.closed` 清空，`ensureIndex()` `:593-599` 无根即抛 `No project is open`，五枚腿 `:744/:810/:834/:860/:907` 无 index 一律 `return undefined`（静默）；插件侧法定通道 = `ctx.inject<WorkspaceService>(KernelServices.Workspaces)`（用法见 `eratw-adapter/src/plugin.ts:97`）；`WorkspaceService.roots()` 契约注释即"恒默认根在首位 + 对话框授权根"（`plugin-api/src/workspace.ts:70-78`）。边界：`candidateRank` 桶序不动（工作区命中与游戏目录命中**并列给出不猜优先**）、索引只读绝不因扩根动写允许域（铁律 5/6）、会话级附加根（D1，`planAddExtraRoot`）不进索引、`.kojo` 不进索引（糖线自有 name-ledger）、服务不可用退化成"只有 kojoPaths"且可见（沿用 `App.tsx:726-728` → 状态栏那条通道，不新开） | 进行中 · 认领：e19erb 2026-10-19 |
| DRIFT-APP | **app 侧三条判据漂移收口**：①`ui/diff-view.ts:52-57` 自写 `/\.(erb\|erh)$/` 缺 `.erm` ⇒ 改接契约单一真源 `erb-ext`（`plugin-api/src/erb-ext.ts:64-72`）；②`monaco/kojo-hover.ts:85` 的 ASCII `isIdentChar` 在函数取词路（`:222`）换成契约层 Unicode 尺 `MODEL_TOKEN_CLASS`（`plugin-api/src/semantic-locate.ts:26`，注释明写"别在本文件另写字符集"）⇒ 含 CJK 的函数名悬停与同行 F12 一致；③`monaco/kojo-language.ts:156` 只注册小写 `['.kojo']`，与 ERB 侧 `erbMonacoExtensions()` 双写法（`erb-language.ts:198`）统一 | 已实测症状：同一份 `X.ERM` 在编辑器里 ERB 高亮、在差异视图里 plaintext；含 CJK 的函数名悬停查不到而同行 F12 能跳（语料里约 21% 函数名含 CJK）。交付要求：三条各配一条**回退即红**的钉值用例（①要写成"同一份文件在编辑器与差异视图里 languageId 必须相同"的对拍，不许只断言新正则） | 进行中 · 认领：e19erb 2026-10-19 |
