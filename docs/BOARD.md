# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## 在办

> W-2 / W-3 来自夜间自主批：先修**通**（一条链路端到端可走），再谈打磨；判据以本机实机（编辑器 + 语料）为准。

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| TSIT | **`.kojo` 语法层接 tree-sitter**：新包 `packages/kojo-syntax-tree`（grammar.js + 生成的 WASM + highlights/folds/indents.scm）；宿主独立 Web Worker 持 parser，接高亮/折叠/缩进/语法错误恢复；设置项 `editor.treeSitter` 默认关（关=完全走原 Monarch，行为零变化）；CST 分类 vs `classifyLine` 语料对照一致率闸；WASM 加载失败/worker 超时 ⇒ 静默回退但**告警一次**。**范围**：不重构 DSL / 不替换转译器 / 不改 classifyLine 语义 / 不重做升糖 / 不建第二套函数名表 / 不为原生 ERB 写第二套 parser / 不做写回 | spike 三闸实测通过（generate→build --wasm→web-tree-sitter Node 加载全绿；wasi-sdk+binaryen 经本机代理缓存于 AppData；仓库内 `.kojo` 夹具实测 **19** 个非「285」）；判据：合法夹具零 ERROR、token 区间一致率 ≥98%、折叠一致 100%、增量 p95 实测、全量/双 typecheck/审计不回退 | 进行中 · 认领：sitter 2026-10-19 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| W-2 | ERB 语言服务补齐·剩余面（用户点名「ERB 支持偏弱」） | 已交付：`#DIM` 悬停 + 转定义 + 查找引用（本文件口径，fail-open）。剩余：`$` 标签引用/重命名；补全触发字符覆盖 `@`/`$`；函数名大小写显示口径 | W 2026-10-19 |
| W-3 | 糖投影未投影行分诊 | 语料直方图按行首 token 排序取前 3 族，逐族给「能投影 / 不该投影」判定与理由；红线（verbatim native 计数 0）一字不动 | W 2026-10-19 |
