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
|PERF-R6|快照链：关窗/关项目等 `storage.set` 落地（42.7M 码元，写实测 0.6s 起）|两条退出路径共用屏障；等不完也放行且明说；常态关闭不多等|已交付余项 · 2026-10-31（欠真壳关窗取证；强杀丢整轮）|
|PERF-R7C|冷开 `read+parse` 段的 decode+EOL：**已量清是约 1.0s（19%），不是 2.35s（43%）**——旧分项用 `readFileSync`+`Promise.all` 量的，同步 API 放进 Promise.all 只是排队（PITFALLS 301）|裁决：**不做**。理论收益 `index_ms` −10%，代价是 io 交字节 + 解析腿/引用腿各自解码 + 文本缓存换形态（跨 5 插件）。要重启得先答一句：为 10% 换 5 个插件的契约值不值|已量清 · 裁决不做 · R7C 2026-10-31|
|MK-PUB|市场发布：zip → Worker 校验 → R2 `pending/` → 自动开 PR（merge=放行）；客户端意图/进度 + Rust 命令 + 主机闸|全链 curl 可验证 + 全量不回退 + 双 typecheck + audit + cargo；不动 `MARKET_DEFAULT_INDEX_URL` 与 ADR-0007|进行中 · 认领：claude 2026-10-16|
|POS-UTIL|位置换算收口（tree-sitter 0-based/UTF-16 vs Monaco、plugin-api 1-based）；否决 CST↔AST `PositionMapper`|换算走同一模块；覆盖 CJK/emoji/CRLF/折叠行；不新增第三套坐标系|进行中 · 认领：lead 2026-10-20|
|ERB-PARITY|ERB 一等语言：注册/服务/树叠层/能力矩阵不得只给 Kojo；审计 G1–G9 **已全修**（G2＝第七波：排版整篇+区间两腿进槽、契约 `options`、降级接 FMT-TOAST 台账），G5 裁决豁免|同 descriptor/registry/engine；ERB 直写不依赖 `.kojo`；一个 kind 只一枚 provider（双挂收敛见 LAU-DUALLEG）|进行中 · 认领：lead 2026-10-31（G1–G9 收口，转入 DUALLEG）|
|MK-SMOKE-RECAL|`smoke-tauri-market.mjs` 本机 4 红：f2/g/h 锚点钉外部注册表内容；k 容差 300ms 踩采样噪声|f2/g/h 改「schema 合规 + 远程与盘上自洽」；k 容差 > 2×采样间隔|待认领 · chief 2026-10-22|
|K2-CORE-PKG|`packages/kojo-core` 布局与 audit 放行（非插件库，B/C 不拦）；§15.2 复用清单核对|audit A–D ✅；单文件转译纯函数|进行中 · 认领：lead 2026-10-21|
|K2-PRE-REUSE|旧后端复用面余项：①心形字面量编码器 ④诊断列折回物理行（与 POS-UTIL 合流）；②③⑤ 已落 dev|每条红→绿用例；只修复用面|待派 · 语言实现审阅|
|K2-RELEASE|R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真机验收|eraTW 完整体验；反向回滚可用|待认领|
|K2-CORPUS-SOURCE|语料机无输入：eraTW 4.980 基线盘 `.kojo` 0 份；须 `KOJO_CORPUS_DIR` 指向含 v1 作者源工程或迁移快照盘，重生成 golden|发现 ≥1 份 `.kojo` 且状态/原因分类可读|待认领|
|LAU-BLOCKED|LAU-1/D2/6/D3/2/5 已交付；LAU-4 各腿 + SDK B4/B5、B5b 车 1–6 + C 类两车 + **第七波（G2 排版进槽）**已落|LAU-D4 未开工，**方案已定**＝两车（① 方言包骨架 + 声明数据：eraTW 补 `carriers`、`new-dialect` 产物过形态闸、`packages/app` 零改动；② 表层↔原生双向映射表：纯数据只住方言包、core 一份 additive 读表函数、错配必红），backend 不动（吃 backend 的第三档与 D2/D3 重叠，判不派）；LAU-5 余 kojo2 worker 不进池|已交付余项 · 2026-10-31|
|LAU-DUALLEG|ERB 旧桥双挂收敛：`languageServices: true` 使共享槽腿与宿主纯翻译腿同挂一枚 model，同一次请求问两趟、「谁在答」由注册顺序判|**车 1 已落**：`documentHighlight`/`selectionRange`/`codeLens` 三格按 descriptor 点名、宿主腿改 `undefined, { excludeNamed: kind }`（第三参给 kind 就前功尽弃），一个 kind 恰一枚；连带改判 `kojo2-highlight-selection` 的语言门（ERB 点名后同一条腿**要**服务它，未登记语言 id 仍弃权）与 `language-ux-matrix` 的 expand 取证；**补全已判**（`495c6dce`）：双挂在 LAU-4 第三批随宿主 `installErbCompletion` 调用点删除就没了 ⇒ 只把矩阵 `completion` 档 self→shared + 钉「ERB 恰一枚」，**不点名**（那一格没有消费者）；**definition+implementation 实测不双挂**（`4608f3de`）：`SLOT_SERVICE_LEGS` 里没有这两枚腿、全仓各只一处注册点 ⇒ 无物可让，改判「不收敛 + 障碍钉成可红判据」（6+1 枚台账，四类宿主事实留账）；**signatureHelp 实测不双挂**（`0617237a`）：旧桥 `installSignatureHelp` 恰给 ERB+kojo1 各一枚、槽腿只答点名的 kojo2 ⇒ 收敛要「判据叶 + `erb-signatureHelp` 供方 + descriptor 点名 + 旧桥 excludeNamed」**同批四件齐落**，缺任一件就是静默没有，前置条件已由 `kojo-signature.test.ts` 那组钉成闸；**rename 实测不收敛（注册面双、应答面单）**（`260cbfbf`）：`SLOT_SERVICE_LEGS` 里**有** rename 腿，但槽腿 prepare 只有 kojo2 那把尺子（`kojo2PrepareRename`）＋闭文件回写通道 `applyToClosedFile` 只在宿主腿上 ⇒ 让位不是少功能而是**答错 + 未打开文件不落盘**，6+9 枚判据把两因与前置条件钉住（`DOUBLE-LEG-1032C` + `rename-dualleg.test.ts`）；**余一格**＝references 闭文件通道分离（第九波车触顶/请求失败，中途态封存为 `1f97ce90`，第十波接手车在跑）；铁律＝**供方不答的格子一律不许让位**（让位＝静默没有）|进行中 · 认领：lead 2026-10-31|
|LAU-KOJO2-INLINE|`.kojo2` 无行内续写：**能力没做**，不是注册缺口|唯一供方 `plugin-inline-completion-local` 的三条名字槽（行首 `@`/`CALL`/`#`）与名录全是 ERB 专属，`codeViewAt` 对未知语言恒假；要开得先出 descriptor 声明位 + 2.0 代码位判据进包 + 按 2.0 语法重写"几乎唯一才给"；ps10 闸已顶格（200 文件 · 余量约 404 B，见 STATE）⇒ 走已图内文件或懒边|待派 · 2026-10-31 核查|
|LAUNCH-L7B|core 插件源码项目 `PluginProjectService`：工作区项目、`buildZip` 打包、`launcher_project_hash`、drift 报告|同内容两次打包逐字节相同；源码/产物分离；三条写边界；`launcher_*` 宿主命令须先补|待派（依赖 L7A）|
|LAUNCH-P0-RESIDUE|P0 真壳验收余项：② ~10 MB fixture 复制进度；③ 二次 `start` 报 `LAUNCHER_INSTANCE_BUSY`；⑤ 信任框后启动、篡改报 `TRUST_CHANGED`；⑥ 退出杀树 + 下次 `app-exit`；① shared 实例仅夹具播种|全部在真壳（`debug-cli shell`）取证；⑤ 无人值守 ⇒ 宿主侧命令取证|待派|
|SDK-B5b|删宿主语言面残留（原 51 枚/23,797 行，语言面 24/9,672 行；结构层 8 不算）；车 1–6 与 C 类两车已落，M2 142→126；**第七波再出宿主 7 枚**（拆 `kojo2-lexicon`/`erb-completion-context` 两壳、退役 `erb-directives`、`kojo-hover-native`+`kojo-native-marks` 上提 `@kojo/kojo-vocab`、`kojo-xml-dialect`+`kojo-xml-event-sites` 落懒插件 `ui-kojo-xml`），M2 随 `--update-baseline` **126→125**|宿主不再直装语言面；现尺 `find packages/app/src -name 'kojo2-*.ts'` = **34 枚/16,610 行**（monaco 14/4,772），含 tsx 的 `*kojo2*` = 39 枚/19,547 行/809,533 B；余 5 枚留宿主事实（project-index / project-analysis / model-language / problem-sync / scan-adapter），仅 diagnostics-gate 的扩展名常量与 `isKojo2Path` 可择机下沉|进行中 · 认领：lead 2026-10-31|
|AE-GHOST|`button.ghost` 悬停吃基类实心灰（全站 90+ 处）；改法会压掉三处自写标定|先给自写悬停档让位（`@layer` 或 `:where()` 低特异），再收这一档；不许直接压特异性|待认领 · shiori 2026-10-27|
|AE-SPLIT4|六条把手热态色不齐：`.editor-divider` 的 `:hover`/`:active` 共用中性灰；`.dock-cell-resizer` 悬停零反馈|先让 `styles-wash-token-discipline.test.ts` 口径迁到「落点在册」，再拆块接 `--split-hot`|待认领 · shiori 2026-10-27|

> 已裁定/已交付行（K2-D0、K2-CONTRACT、SDK-B5a、多游戏适配 P0/P1、编辑器对标 A–E、PS 系列）已删，回执在 git 提交信息。
