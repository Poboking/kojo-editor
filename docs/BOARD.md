# BOARD.md — 在办看板

> **协议**：认领 = 写「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）写进提交信息。
> 报红格式：现象 + 复现 + 期望 vs 实际 + **屏上原样文案**；跨主机靠此表。
> **认领前先核实**（2026-10-31 立）：先 `node tools/board-audit.mjs` 过结构与引用，再**手动核两件机器核不了的事**——
> ① 判据现在还跑得出吗？（僵尸卡：判据早已全绿、行还挂着，CMD-NUL-BYTE 即如此）
> ② 判据依赖的架构事实还在吗？（过期判据：TUT-UGUIDE 写"默认档只认 v1"，而 LAU-3b-FLIP 已把 `.kojo` 让给 2.0）
> 不符就**先改卡再开工**，别照着过期判据做。
> **分支模型**：`dev`＝日常落地窄门，`main`＝发行版（发版才并入并打 tag）；批次分支从 `origin/dev` 起，落地 `git push origin HEAD:dev`；**永不** force 到 `dev`/`main`。

## 在办

|ID|任务|关键判据|状态|
|---|---|---|---|
|KW-14|台词可见性内联上屏：逐行写口上时在编辑器里直接看见「会说 / 不会说 / 看情况 / 判不出（带机器码）」，走既有槽 `ui.editor.decorator`|四档口径 + 三道失效闸（未存盘 / 文本已变 / 未证明同源 ⇒ 整档撤标并出声）；单测面已绿：`ui-state-replay` 150 例 · 定向 9 文件 171 例 0 红 · 双 typecheck · 审计 ✅31 · 开机图零进图|实现完成 · **待真机取证** 2026-11-03 · 分支 `b/qoder/1103-kw14-inline`（尖 `03ecf541`，已推远端）。**扣住点**：回放面板推演走不完（save03×K1 点「判定」后 `editor.markers()` 仍 `{}`）⇒ 下一步先分判「链没通」vs「驱动姿势不对」，别拿单测绿当能用|
|KW-35|表达式字符串槽加撇：`LOCAL'`/`LOCALS'`/`ARG'` 被 `ASSIGN_RE` 整族拒收 ⇒ 台词链上的字符串写读不进赋值表，可见性只能落 `unknown`|先用真语料量清带撇写法的条数与分布（对拍 `'=` 923 条）再定扩契约还是另开一族；硬红线＝逐码改前必须＝改后|WIP 封存（额度中断，未自证）· qoder 2026-11-03 · 快照 `a3110d72` · 分支 `b/qoder/1103-kw35-strslot`（已推远端）|
|KW-38|变量表悬停/复制：状态面板变量名一键复制 + 悬停显示取值来源|硬红线＝复制出去的内容与表里字面逐字相等（不许多空格 / 换行 / 引号）；判据先钉成会红的对拍再动实现|WIP 封存（未自证）· qoder 2026-11-03 · 快照 `1e2fe54d` · 分支 `b/qoder/1103-kw38-varcopy`（已推远端；车上临时探针已删，勿把探针读数当交付）|
|K2-RELEASE|R9 发布闸：core / eraTW / program / UI gate + STATE/BOARD 落账 + 双 typecheck / audit + 真机验收|eraTW 完整体验；反向回滚可用|待认领|
|K2-CORPUS-SOURCE|语料机无真实作者源：eraTW 4.980 基线盘 `.kojo` 0 份|发现 ≥1 份 `.kojo` 且状态 / 原因分类可读|可控夹具已接通（`fixtures/corpus-v1`：4 份 `.kojo1`，1 normalized-equal + 3 migration-unsupported）· 余真实作者语料 · qoder 2026-11-01|
|LAUNCH-P0-RESIDUE|P0 真壳验收余项：~10 MB fixture 复制进度 / 二次 `start` 报 `LAUNCHER_INSTANCE_BUSY` / 信任框后启动与篡改报 `TRUST_CHANGED` / 退出杀树 + 下次 `app-exit` / shared 实例夹具播种|全部在真壳（`debug-cli shell`）取证；⑤ 无人值守 ⇒ 宿主侧命令取证|待派|
|PERF-R6|快照链：关窗 / 关项目等 `storage.set` 落地|两条退出路径共用屏障；等不完也放行且明说；常态关闭不多等|余项：**真壳关窗取证**未跑 · 2026-10-31（强杀仍丢整轮）|
|PERF-R7C|冷开 `read+parse` 的 decode + EOL 分项|已量清约 1.0s（19%），不是 2.35s（43%）；**裁决不做**（理论收益 `index_ms` −10%，代价跨 5 插件）|已裁决 · 勿重复认领 · 2026-10-31|
|MCP-WAVE4-DELIVERED|2026-11-06 MCP 第四/五波写口收口：LaneE 审批 UI 回归钉（轮换真换 token / 批准真落 approvedTools / 三态 / denied）、LaneF 两处截断账目 + 11 条 cheap-read 逐条判性后登记 6 枚只读具名工具、LaneG `fileTree.remove`/`rename` 特权写腿（第四张表 approvedRoots × 内核 writablePaths 双闸 + `file.changed` 广播）、LaneH Wave4 #4 判性＝打开/定位无诚实真源故刻意不登记 + `editor.cursor` 只读加法、主 agent 订正旧断言与全量唯一真红|双 typecheck rc=0 · audit A/B/C/D（32 插件）· 定向 6 文件 220 例 · ps10 197 文件 / 3395 KB · conformance 54 PASS / 0 FAIL；盘点 `tools 40`（read 35 / edit 3 / privileged 2）、`writeLegs` wired 4 / NOT_WIRED 1（仅 `problems.quickFix`）、wiredGaps 30 / deferredGaps 150、orphanedWires 0 / missingSources 0|**已交付** · 2026-11-06 · `f9ac7293` / `14a1c56c` / `5cdb2b98` / `91ab79a3` / `a64a0e36` / `1061df6b`（回执全文在各提交信息；能力面落账见 `docs/mcp/README.md` §5 / §5.4 / §10.5，基线见 `docs/STATE.md`）|
|MCP-WAVE4-RESIDUE-A|⑥ `TIER_DENIED` 口径差已收口（Lane I）：端点 `check_tool_call_permission` 补 `tools/call` 的 tier 纵深闸 `E_TIER_DENIED`，判定与 `filter_tools_list` 严格同源，harness 同码；③ 外部写盘感知（file watch → MCP 资源失效信号；现 resources 按请求现算、能力面 `subscribe:false`/`listChanged:false`）|⑥ 判据实测＝收口前 read 会话猜名直调 Edit 工具端点返回 Ok（「`tools/list` 看不见 ≠ `tools/call` 被拒」才是口径差真身）；批准语义零放宽（精确名 + `前缀*` 通配照旧放行）；③ 判据＝失效信号可见且**不得新建写通道**，能力面不许抬成真值除非证明传输层真能推；铁律不变：写双闸 / privileged 默认不进 `tools/list` / 缺席＝`NOT_WIRED` / 真源不存在＝不登记 / MCP 运行时零字节进开机图|⑥ **已交付** · 2026-11-06 · `b77b248f`（cargo `mcp::tests` 86→88 · 全量 cargo 402/0/7ign · conformance 54/0 · 双 typecheck rc=0 · audit ✅32）+ docs 收口 `4fc20201`；③ **已交付** · 2026-11-06 · `b90d79bb`（判性＝on-request 标注档，传输层推不出去 ⇒ 能力面继续说真话；resources 8→**9**、tools 40 零增；定向 6 文件 209 例 + `mcp-host` 43 例 · conformance 54/0 · audit ✅32 · ps10 197 文件/3395 KB 未放宽；**在册不足**：自写 5s 回声窗内同路径的真实外部写并条不推序号＝假阴性，另批「按需 mtime 复核」）|
|MCP-WAVE4-RESIDUE-B|① `problems.quickFix` 真执行 **已交付**（Lane K＝`b8ff59d4`：不新造 id，复用宿主 `provideCodeActionsFor` 既有签发 `pane-N:贡献id#seq` + 有界台账 ≤300 条/10min TTL；apply＝模型内单次 `executeEdits` 一个撤销步、不落盘、零 io/invoke/bus；文档一变旧 id 显式 `E_QUICKFIX_DOC_CHANGED`）· ⑤ 长任务 progress `kojo://tasks`（Lane L 在跑）|① 判据达成：`writeLegs` wired 4→**5** / NOT_WIRED 1→**0**（首次全清）；**同批堵掉一处既有洞**——`fileTree.create`/`fileTree.update` 因点号名不命中 `EDIT_TOOL_PREFIXES`、也不在 `PRIVILEGED_EXACT`，`host_required_tier()` 一直判 Read（读会话看得见且可直调这两枚写腿），现新增具名 Edit 表 `EDIT_TOOLS_EXACT` 点名三枚并补端点级回归；⑤ 判据＝只接「进度+取消+可查询」三件套有真源那档，additive 为限，进度只能轮询（无状态单请求 HTTP）；**后续每批固定验收项**：新登记名字不同批进档位真源表＝后门|① **已交付** · 2026-11-06 · `b8ff59d4`（cargo `mcp::tests` 88→89 · conformance 54/0 · 双 typecheck rc=0 · audit ✅32 · ps10 197 文件/3395 KB 不变 · 定向 4 文件 197 例）；⑤ **在跑（收残）** · 2026-11-06 · 前一路到 150 轮上限只留未提交 WIP（7 文件 / ≈1938 行：`real-sources-tasks.ts` 758 + `mcp-tasks.test.ts` 771 + 5 处局部加行），LaneN 认领同树 `D:/DSH/kojo-lane-b` 分支 `b/laneL/1106-mcp-tasks` 收编验证，判据不变（三件套齐备才登记 / 进度只能轮询 / null≠0% / cancel 是请求不是确认）|
|MCP-QUEUE-A|认领：**B1 分页游标**（`tools/mcp-pagination` 主线：截断面改可续读，让 AI 能完整枚举 8 项 resource / `fs.tree` / `search.all` / `problems.diagnostics` / `semantic.documentSymbols` 一族）· 树 `D:/DSH/kojo-lane-f` 分支 `b/laneM/1106-mcp-pagination`；认领：**B3 编辑器写腿 5 枚**（`debug:setValue` / `type` / `setCursor` / `setSelection` / `revealLine` 真源在 `install-debug.ts`:2249/:2253/:2258/:2361/:2378，回读核对与只读如实拒绝都是既有语义；按 `paneId` 反查、**禁用 `focusedCtx()`**）· 树 `D:/DSH/kojo-lane-a` 分支 `b/laneO/1106-mcp-editor-writes`|B1 判据＝游标可续读且**不放宽任何上限**、越界/失效游标显式报错；B3 判据＝模型内编辑不落盘（磁盘写仍只走 `fileTree.update` 双闸 / `exportFile` 对话框）、`applied` 必回读核对、`dirty:true / saved:false` 如实回报、5 枚同批进 Rust `EDIT_TOOLS_EXACT` + 端点级回归；两批都不许放宽 ps10 闸（余量仅 5 KB，MCP 运行时字节零进开机图）|**在跑** · 2026-11-06 · 主 agent 落账（现读数 tools 40 · writeLegs 5/0 · wiredGaps 30 · deferredGaps 150 · resources 9）|


> 已交付 / 已收口行（K2-D0、K2-CONTRACT、SDK-B5a、多游戏适配 P0/P1、编辑器对标 A–E、PS 系列、LAU-FACE-ORDER、LAU-B11、DIAG-GATE-1033、LAU-DUALLEG）已删，回执在 git 提交信息。
> MCP 批次已交付四波（2026-11-04，回执在各提交信息）：`c5c5591d` Rust endpoint+第四张授权表+审计 · `35e31ef0` 只读能力覆盖+Codex/DeepSeek Harness 样例 · `928d9ca8` Rust 协议一致性硬化 · `cad0fd11` WebView 端到端链路+设置页「AI 接入」节（另有三波前置 `704a9158`/`a31a360d`/`f08045b3`）。

