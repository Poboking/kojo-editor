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
|KW-36|调试宿 DOM 驱动面补全：`click`/`type`/`key` 对虚拟化树、命令面板、模态框的选择器命中不稳；`open-file` 遇折叠行要靠 `tree-filter` 绕路|P0＝`setCursor` 两种形状同义、脏值一律 `false` 不捅 Monaco（**已落 dev `d471aa70`**）；P1/P2＝选择器改坐标兜底 + 命中失败把候选集原样报出，不静默空点|P0 已交付 2026-11-03；P1/P2 WIP 封存（未自证）· 快照 `fc5e8af1` · 分支 `b/qoder/1103-kw36-dbgtui`（已推远端）|
|KW-38|变量表悬停/复制：状态面板变量名一键复制 + 悬停显示取值来源|硬红线＝复制出去的内容与表里字面逐字相等（不许多空格 / 换行 / 引号）；判据先钉成会红的对拍再动实现|WIP 封存（未自证）· qoder 2026-11-03 · 快照 `1e2fe54d` · 分支 `b/qoder/1103-kw38-varcopy`（已推远端；车上临时探针已删，勿把探针读数当交付）|
|K2-RELEASE|R9 发布闸：core / eraTW / program / UI gate + STATE/BOARD 落账 + 双 typecheck / audit + 真机验收|eraTW 完整体验；反向回滚可用|待认领|
|K2-CORPUS-SOURCE|语料机无真实作者源：eraTW 4.980 基线盘 `.kojo` 0 份|发现 ≥1 份 `.kojo` 且状态 / 原因分类可读|可控夹具已接通（`fixtures/corpus-v1`：4 份 `.kojo1`，1 normalized-equal + 3 migration-unsupported）· 余真实作者语料 · qoder 2026-11-01|
|LAUNCH-P0-RESIDUE|P0 真壳验收余项：~10 MB fixture 复制进度 / 二次 `start` 报 `LAUNCHER_INSTANCE_BUSY` / 信任框后启动与篡改报 `TRUST_CHANGED` / 退出杀树 + 下次 `app-exit` / shared 实例夹具播种|全部在真壳（`debug-cli shell`）取证；⑤ 无人值守 ⇒ 宿主侧命令取证|待派|
|PERF-R6|快照链：关窗 / 关项目等 `storage.set` 落地|两条退出路径共用屏障；等不完也放行且明说；常态关闭不多等|余项：**真壳关窗取证**未跑 · 2026-10-31（强杀仍丢整轮）|
|PERF-R7C|冷开 `read+parse` 的 decode + EOL 分项|已量清约 1.0s（19%），不是 2.35s（43%）；**裁决不做**（理论收益 `index_ms` −10%，代价跨 5 插件）|已裁决 · 勿重复认领 · 2026-10-31|
|MCP-A3|MCP 真源腿接满：semantic 8 腿 / kernelIo 3 腿 / 8 个 `kojo://project/*` resource / runSupplemental 只读腿 / promptSlots（消灭 NOT_WIRED，只接真源、不造假实现）|接线点 `ShellLayout.tsx` `registerMcpWiringSources` 唯一生产调用点已就位；判据＝定向 vitest 全绿（mcp-wiring 14 例 + mcp-real-sources 新建）· 双 typecheck · audit ✅31 · 开机图 MCP 模块 0 命中且字节增量入台账 · 回执逐条写明「已接 / 仍 NOT_WIRED 及缺什么」|**待开工** · 分支 `b/mcpa/1104-real-sources`（工作树 `D:/DSH/kojo-mcp-pool-a`，尖 `cad0fd11`，干净）· 完整任务书 `docs/mcp/POOL-HANDOFF.md` §3.1 · 2026-11-04|
|MCP-B3|MCP 端到端协议一致性 harness：新建零依赖回环 mock endpoint + 真实 stdio shim 对拍（initialize / tier 过滤 / batch / notification / 错误帧 / Bearer / Origin / SSE）|harness `--self-test` exit 0 且 token 不进日志（文件名与命令以 `docs/mcp/POOL-HANDOFF.md` §3.2 为准）；vitest 新用例绿；`docs/mcp/README.md` 补「协议一致性自检」与「P5 演进边界」|**待开工** · 分支 `b/mcpb/1104-conformance`（工作树 `D:/DSH/kojo-mcp-pool-b`，尖 `cad0fd11`，干净）· 2026-11-04|
|MCP-C3|Rust 真实 TCP/HTTP 端点集成测试：起真 listener + 裸 `TcpStream` 打全协议面（Bearer/Origin/initialize/tools-list 过滤/batch/notification/SSE/token 轮换/审计 denied）|`cargo test --lib mcp::tests` 全绿且例数上涨（现 60）；rustfmt --check 绿；全量 cargo 仅既有 launcher_probe 2 红；不改 lib.rs / Cargo.*|**待开工** · 分支 `b/mcpc/1104-http-e2e`（工作树 `D:/DSH/kojo-mcp-pool-c`，尖 `cad0fd11`，干净）· 任务书 §3.3 · 2026-11-04|
|MCP-INT|MCP 批次集成收尾：ps10 体积闸台账（现读数 196 文件 / 3,554 KB · 3,638,818 B，超闸 550 B，**零新进图文件**；归因 bootstrap.ts +440 / plugin-api index +28 / slots +32 / commands +13）+ `pnpm-lock.yaml` 补 `@kojo/mcp-host` workspace importer 条目 + 全量测试复跑 + `docs/STATE.md` 落账|ps10-eager-graph 恢复绿（按台账流程逐字节记账抬 KB 闸，文件闸 196 与成员断言**不许放宽**）；`pnpm install --frozen-lockfile` 过；全量 unit 0 failed（launcher_probe 2 红为既有）|**待开工**（主 agent 或接手者）· 归因明细 `docs/mcp/POOL-HANDOFF.md` §4 · 2026-11-04|

> 已交付 / 已收口行（K2-D0、K2-CONTRACT、SDK-B5a、多游戏适配 P0/P1、编辑器对标 A–E、PS 系列、LAU-FACE-ORDER、LAU-B11、DIAG-GATE-1033、LAU-DUALLEG）已删，回执在 git 提交信息。
> MCP 批次已交付四波（2026-11-04，回执在各提交信息）：`c5c5591d` Rust endpoint+第四张授权表+审计 · `35e31ef0` 只读能力覆盖+Codex/DeepSeek Harness 样例 · `928d9ca8` Rust 协议一致性硬化 · `cad0fd11` WebView 端到端链路+设置页「AI 接入」节（另有三波前置 `704a9158`/`a31a360d`/`f08045b3`）。

认领：mcp-pool 2026-11-04（三路轮流池；2026-11-04 22:17 起 agent 派发额度 429，约 2026-11-05 13:03 UTC+8 恢复；恢复前接手者可按 `docs/mcp/POOL-HANDOFF.md` 单线程顺序做）
