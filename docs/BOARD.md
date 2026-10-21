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
| REFS-WORKER | `scanFileRefs` 仍在主线程同步跑（`erb-parser/plugin.ts` 的 `compute.runSliced` 回调），而单文件解析已 `compute.offload`；快照未命中轮 refs scan 实测 7.4s（`read+parse 6.9s` 之外的第二段大头） | 判据：把 `scanFileRefs` 搬进 compute worker 后主线程长任务/让路读数下降；`references` / find-references / rename 全量对拍逐字不变；**先量文本克隆税**，净收益不达标就报红留数、不硬搬；refs 判据与快照格式零放宽 | 进行中（**计时读数作废**）· 认领：chief 2026-10-21（代码与等价用例在 `b/chief/1021-refs-worker`＝WIP `f3332595`；同机并发把 A/B 全污染 ⇒ 必须空闲机**独占**重测文本克隆税再判搬／不搬） |
| REFS-PROVENANCE | refs 只记「当时已知名」的引用（`scanFileRefs(text, hasName)`），名录一变就要全树重扫：新增/改名一个函数会触发 ~7.4s（`namesFp` 不符 ⇒ 逐条目溯源巡检） | 判据：按文件持久化**不依赖当前名录**的候选记号（或等价溯源位），名录变更只重扫受影响文件；新旧路径 `bySymbol` / 快照 / 查找引用 / 重命名逐字等价；先写一条能红的用例（改一个名字只应扫少量文件）；`SNAPSHOT_VERSION` 换代与迁移可见，不许靠放宽判据凑绿 | 待认领 · 来源：Symbol DB 建议审阅 2026-10-20 |
| FIX-UNDO-RESIDUAL | 停点口径已被证了三次（重载腿 / merge 腿 / 全角替换腿都改成 `applyDiskText`），但同类口子还剩**三处程序化编辑没有前后停点**：①`runFixAll` 一键修复（`EditorPane.tsx:2131` → `applyTextEdits` → `editor-global-providers.ts:348` 的 `executeEdits`）；②保存前整理（`EditorPane.tsx:1212` 的 `pushEditOperations` 无前后停点）；③💡 code-action（同 `:348` 那条通道） | 判据：逐处补 `pushStackElement` 前后封口（照 `ui/disk-text-sync.ts::applyDiskText` 已证口径，**不许发明第二套**），每处一条「作者打字与机器改动分两次撤」的用例 + 一处「摘前停点必红」的反向自证；写盘闸门与弹窗语义零改动；`EditorPane.tsx` 热点串行（同波有真壳补量单） | 待认领 · 发现：chief 2026-10-21（FIX-ALL-UNDO-STACK 交付正文⑤记名） |
| SHELL-UNDO-FIND-CHECK | 本波四批（RELOAD-MERGE-UNDO / RELOAD-EOL-PIN / FIX-ALL-UNDO-STACK / FIND-STATE-PERSIST B）全部**只到单测与静态取证，真壳零覆盖**——我为防并发抢 9222 明令它们不许起壳，这笔账不能算已经交付给作者 | 判据：空闲机独占起一轮真壳，量四件：①merge 腿合并后一次 Ctrl+Z 回到作者打字；②混合行尾文件重载后**不再凭空多空行**（`getLineCount` 与改前 setValue 同值）；③点「替换为半角空格并保存」后第一次 Ctrl+Z 只撤替换、作者打字仍在屏上；④查找三档各按一次 Ctrl+F：仅选中档下光标压词不劫持恢复词、真选中仍即选即查、重启后词与三开关回来。复跑 `.local/reload-state-keep-probe.mjs` 与 `tools/smoke-tauri-manual.md` 对应格，读数进 `MANUAL-CHECKLIST` §2 d–g 与 D12 | 待认领 · 发现：chief 2026-10-21 |
| DISK-SYNC-EOL-EDGE | 差量落地改按行分段后还剩两个行尾边角没钉：**无行尾单行文件**的档位选择（`setValue` 用创建时 defaultEOL，本模块保持现档）与**孤 CR**（旧 Mac 行尾）的分段口径差 | 判据：两条各一条用例先取证「改前后同果」再决定要不要动 `detectMajorityEol`；不放宽写域、不碰热点；若实测等价就只补用例并在头注记明，别为了改码而改码 | 待认领 · 发现：chief 2026-10-21 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |
