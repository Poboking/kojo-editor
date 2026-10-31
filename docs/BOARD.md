# BOARD.md — 在办看板

> **协议**：认领 = 写「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）写进提交信息。
> 报红格式：现象 + 复现 + 期望 vs 实际 + **屏上原样文案**；跨主机靠此表。
> **分支模型**：`dev`＝日常落地窄门，`main`＝发行版（发版才并入并打 tag）；批次分支从 `origin/dev` 起，落地 `git push origin HEAD:dev`；**永不** force 到 `dev`/`main`。

## 在办

|ID|任务|关键判据|状态|
|---|---|---|---|
|PERF-R6|快照链：关窗/关项目等 `storage.set` 落地（42.7M 码元，写实测 0.6s 起）|两条退出路径共用屏障；等不完也放行且明说；常态关闭不多等|已交付余项 · 2026-10-31（欠真壳关窗取证；强杀丢整轮）|
|PERF-R7B|冷开两遍全量扫描合并：`read+parse` 5,632ms / `refs scan` 3,011ms 各扫 42.7M 码元|一遍产出 `ErbFile` 与候选；11.5s 再降 1.5–2.5s；`bySymbol` 逐字节相等|待认领 · F 批归因 2026-10-31|
|MK-PUB|市场发布：zip → Worker 校验 → R2 `pending/` → 自动开 PR（merge=放行）；客户端意图/进度 + Rust 命令 + 主机闸|全链 curl 可验证 + 全量不回退 + 双 typecheck + audit + cargo；不动 `MARKET_DEFAULT_INDEX_URL` 与 ADR-0007|进行中 · 认领：claude 2026-10-16|
|POS-UTIL|位置换算收口（tree-sitter 0-based/UTF-16 vs Monaco、plugin-api 1-based）；否决 CST↔AST `PositionMapper`|换算走同一模块；覆盖 CJK/emoji/CRLF/折叠行；不新增第三套坐标系|进行中 · 认领：lead 2026-10-20|
|ERB-PARITY|ERB 一等语言：注册/服务/树叠层/能力矩阵不得只给 Kojo；审计差 G1–G9，已修 G1/3/4/6/7/8/9|同 descriptor/registry/engine；ERB 直写不依赖 `.kojo`；余 G2 欠语言身份前置，G5 豁免|进行中 · 认领：lead 2026-10-20|
|TUT-UGUIDE|`docs/USER-GUIDE.md` 全文 0 处提 2.0 ⇒ 只讲 v1|写清默认档只认 v1 / 切档才认 2.0 / `.kojo2` 无落盘产物；只改冲突行|待认领 · chief 2026-10-22|
|CMD-NUL-BYTE|`ui/commands.ts` 唯一带裸 NUL ⇒ 判二进制、NUL 后行失明|换 `\u0000`；`includes(0)` 为 false、`grep -c nonce` 得 6、`ps14-source-cache.test.ts` 绿|待认领 · chief 2026-10-22|
|MK-SMOKE-RECAL|`smoke-tauri-market.mjs` 本机 4 红：f2/g/h 锚点钉外部注册表内容；k 容差 300ms 踩采样噪声|f2/g/h 改「schema 合规 + 远程与盘上自洽」；k 容差 > 2×采样间隔|待认领 · chief 2026-10-22|
|PERF-KOJO2-ANALYSIS|「万级 @函 ≤100ms」反复贴阈值；p95 红绿跟机器占用走|先看「退回整篇的击键」有无内容，再同机对拍两棵树；空闲独跑读数入回执|进行中 · 多游戏批 2026-10-26|
|K2-CORE-PKG|`packages/kojo-core` 布局与 audit 放行（非插件库，B/C 不拦）；§15.2 复用清单核对|audit A–D ✅；单文件转译纯函数|进行中 · 认领：lead 2026-10-21|
|K2-PRE-REUSE|旧后端复用面余项：①心形字面量编码器 ④诊断列折回物理行（与 POS-UTIL 合流）；②③⑤ 已落 dev|每条红→绿用例；只修复用面|待派 · 语言实现审阅|
|K2-RELEASE|R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真机验收|eraTW 完整体验；反向回滚可用|待认领|
|K2-INCR-HOLES|增量洞：`选项`/BOM 全量；整份替换/改 `# 视角` 仍重建（~200–300ms）；声明单元内编辑 55–75ms；槽族只盖 `rand/foreach`|每次退化可见；与全量逐字节等价不破|待认领 · lead 2026-10-22|
|K2-CORPUS-SOURCE|语料机无输入：eraTW 4.980 基线盘 `.kojo` 0 份；须 `KOJO_CORPUS_DIR` 指向含 v1 作者源工程或迁移快照盘，重生成 golden|发现 ≥1 份 `.kojo` 且状态/原因分类可读|待认领|
|LAU-BLOCKED|LAU-1/D2/6/D3/2/5 已交付；LAU-4 各腿 + SDK B4/B5、B5b 车 1–6 已落|余 ERB 排版注册面 G2（判据在 `@kojo/kojo-vocab/formatter`；方案：`formatting` 槽腿 + 契约 `options` + 删 v1 区间）；LAU-D4 未开工；LAU-5 余 kojo2 worker 不进池|已交付余项 · 2026-10-31|
|LAUNCH-L7B|core 插件源码项目 `PluginProjectService`：工作区项目、`buildZip` 打包、`launcher_project_hash`、drift 报告|同内容两次打包逐字节相同；源码/产物分离；三条写边界；`launcher_*` 宿主命令须先补|待派（依赖 L7A）|
|LAUNCH-P0-RESIDUE|P0 真壳验收余项：② ~10 MB fixture 复制进度；③ 二次 `start` 报 `LAUNCHER_INSTANCE_BUSY`；⑤ 信任框后启动、篡改报 `TRUST_CHANGED`；⑥ 退出杀树 + 下次 `app-exit`；① shared 实例仅夹具播种|全部在真壳（`debug-cli shell`）取证；⑤ 无人值守 ⇒ 宿主侧命令取证|待派|
|SDK-B5b|删宿主语言面残留（原 51 枚/23,797 行，语言面 24/9,672 行；结构层 8 不算）；车 1–6 与 C 类两车已落，M2 142→126|宿主不再直装语言面；余 6 枚＝留宿主事实/编排；仅 diagnostics-gate 常量与 `isKojo2Path` 可下沉|进行中 · 认领：lead 2026-10-31|
|AE-GHOST|`button.ghost` 悬停吃基类实心灰（全站 90+ 处）；改法会压掉三处自写标定|先给自写悬停档让位（`@layer` 或 `:where()` 低特异），再收这一档；不许直接压特异性|待认领 · shiori 2026-10-27|
|AE-SPLIT4|六条把手热态色不齐：`.editor-divider` 的 `:hover`/`:active` 共用中性灰；`.dock-cell-resizer` 悬停零反馈|先让 `styles-wash-token-discipline.test.ts` 口径迁到「落点在册」，再拆块接 `--split-hot`|待认领 · shiori 2026-10-27|
|AE-SCROLLFADE|滚动区边缘渐隐同一份配方抄四遍（editor-tabs/tree-groups/nav-tree/ksp-results）|由 `ui-chrome-polish.test.ts` owner 把判据迁到「读类名在册」，再落 `--scroll-fade` 单源|待认领 · shiori 2026-10-27|

> 已裁定/已交付行（K2-D0、K2-CONTRACT、SDK-B5a、多游戏适配 P0/P1、编辑器对标 A–E、PS 系列）已删，回执在 git 提交信息。
