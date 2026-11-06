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
|MCP-WAVE4-RESIDUE-C|③ 余项：自写后 5s 回声窗内、同路径的**真实外部写**被并条不推序号 ⇒ `fsFreshness` 假阴性（`fs-freshness.ts` ~:405-416）；出路＝读路径上**按需 mtime 复核**，只在窗内且路径命中时多一趟 `fs.stat`|判据＝假阴性用例先红后绿、窗外语义与账本有界（2000/2000/512）一字不放宽、不可用时继续 `stale:null` + `staleReason` 绝不乐观 `false`；不改能力面真值（`subscribe:false`/`listChanged:false` 除非证明传输层真能推）|**在跑（LaneW）** · 2026-11-06 · 树 `D:/DSH/kojo-lane-a` 分支 `b/laneW/1106-mcp-freshness-mtime`（③ 主体＝`b90d79bb` 已交付，此为已判性的在册不足）|
|MCP-QUEUE-A|认领：**B10「打开文档 / 定位」诚实收口**（旧判性＝`real-sources.ts:1430-1436` 说 `editor.revealLocation` 是 fire-and-forget 无 ack ⇒ 不登记；新砖＝B3 落地的 `livePanes` 按 `paneId` 反查登记簿（`editor-write-legs.ts:15/:35/:79/:335`，仍动态 import）⇒ 「开没开成」第一次可观测）· 树 `D:/DSH/kojo-lane-f` 分支 `b/laneV/1106-mcp-open-document`；认领：**B8 `fsFreshness` 假阴性收口＝按需 mtime 复核**（5s 回声窗内同路径的真实外部写被并条不推序号，真源 `fs-freshness.ts:48/:405-416`）· 树 `D:/DSH/kojo-lane-a` 分支 `b/laneW/1106-mcp-freshness-mtime`；**B5 吞吐与延迟收口**（半成品已固化为 `37322522`：逐请求耗时台账模块 + `mcp_latency_query` 宿主命令 + `run_envelopes` 拆分 + `sanitize_untrusted_inplace`/`CountingWrite`，+447 行 Rust 用例**从未跑过**；台账文件名以该车落地时为准，此刻尚不在 `dev` 树上）· 树 `D:/DSH/kojo-lane-d` 分支 `b/laneP/1106-mcp-throughput`|B10 判据＝只用既有界面通道打开（不新造第二套跳转）＋**回执必须可观测**（轮询登记簿 + 有界超时，超时显式失败绝不 `opened:true` 冒充）＋路径只收根内相对＋同批进 Rust `EDIT_TOOLS_EXACT` 与端点回归＋`editor.revealPosition` 逐条判性（被 `revealLine`/`setCursor` 覆盖就写明不重复登记）；B8 判据＝窗内命中才多付一趟 stat（窗外**必须 0 次**，用假桥计数断言）、多条命中走 `statFiles` 一趟批量、判不了继续 `stale:null`+`staleReason` 绝不乐观、两张账容量与溢出可见性不动、`subscribe`/`listChanged` 不抬；B5 判据＝先出实测数（假 bridge 端点开销 + 真壳端到端两张表，缺一格就点名「真壳未取到」）再动手、`Limits::*` 既有五格一字不动、并发化必须带全局在途预算与逐条可见拒绝、线字节序契约要用例钉住；三批共同红线：新登记名字不同批进档位真源表＝后门、不许放宽 ps10 闸（余量约 5 KB，MCP 运行时字节零进开机图）、缺席＝`NOT_WIRED` / 真源不存在＝不登记、**开工第一条命令＝树独占校验**（见 PITFALLS 350）|**在跑** · 2026-11-06 · 主 agent 落账（B2＝`e5406978`、B4＝`e1e9de71` 已交付删行；现读数 tools **76**（read 37 / edit 10 / privileged 29）· resources 10 · writeLegs 39/0 · wiredGaps 64 · deferredGaps 116 · cargo `mcp::tests` 94 · 合并树 MCP 面 20 文件 562 passed）|


> 已交付 / 已收口行（K2-D0、K2-CONTRACT、SDK-B5a、多游戏适配 P0/P1、编辑器对标 A–E、PS 系列、LAU-FACE-ORDER、LAU-B11、DIAG-GATE-1033、LAU-DUALLEG、MCP-WAVE4-DELIVERED、MCP-WAVE4-RESIDUE-A、MCP-WAVE4-RESIDUE-B）已删，回执在 git 提交信息。
> MCP 批次已交付四波（2026-11-04，回执在各提交信息）：`c5c5591d` Rust endpoint+第四张授权表+审计 · `35e31ef0` 只读能力覆盖+Codex/DeepSeek Harness 样例 · `928d9ca8` Rust 协议一致性硬化 · `cad0fd11` WebView 端到端链路+设置页「AI 接入」节（另有三波前置 `704a9158`/`a31a360d`/`f08045b3`）。

