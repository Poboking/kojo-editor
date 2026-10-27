# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

> ⚠️ **分支模型（2026-10-19 生效，全组必读）**：`master` 已停用并从远端删除。
> **日常落地分支＝`dev`**（一切功能 / 修复 / 文档批的窄门出口），**`main`＝发行版分支**（只在用户点头发版时并入并打 tag）。远端默认分支＝`main`。
> 新批次分支一律从 `origin/dev` 起（先 `git fetch origin --prune`）；落地命令 `git push origin HEAD:dev`。**禁止** `git push … :master`——GitHub 会把它当新分支**创建**（详 PITFALLS §133）。`gh pr create` 日常批须显式 `--base dev`。

## 在办

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入且 `TREE_SITTER_DEFAULT = true`，与 kojo2 同为一等默认开） |
| TUT-UGUIDE | 内置教程已按 Kojo 2.0 设计稿补齐（1177b417 / f1554004 / 98c2b044 / cad84d27），但 **`docs/USER-GUIDE.md` 全文 0 处提 2.0**：手册只讲 v1 那条路，而编辑器里已经有第四张教程卡与「文件格式」那一档 ⇒ 两处口径不一致（唯一交叉引用 `USER-GUIDE.md:404` 指的「.kojo 语言教程」第⑪节仍对得上，未受影响） | 判据：手册把「默认档＝只认 v1／切档才认 2.0／`.kojo2` 无落盘产物」三件事写清，**只改冲突行、一行算一行**（§五 文档纪律），不许顺手重写整本；教程那四本已按实现写，手册以它们为准 | 待认领 · 来源：chief 教程批收口 2026-10-22 |
| CMD-NUL-BYTE | `packages/app/src/ui/commands.ts` 是**全仓 1591 个文本文件里唯一带裸 NUL 字节的**（第 275 行缓存键 `` `${nonce}<NUL>${roots.join('\n')}` ``，偏移 12293/12806）⇒ 文件被 `file` 判成二进制、**NUL 之后的行对基于文本扫描的工具失明**（grep/ripgrep/review 脚本一类）；TypeScript 与运行都不受影响，纯卫生与可审性问题 | 判据：一行改动把裸 NUL 换成转义形态（语义逐字节等价，运行期分隔符仍是同一个 `\u0000`）；改完 `node -e "fs.readFileSync(p).includes(0)"` 必须 false，且 `grep -c nonce` 仍数得出 6 处、`ps14-source-cache.test.ts` 全绿。**⚠ 别用 Edit/Write 硬试**：本会话两次尝试都被参数层的 JSON 转义吃掉（一次把 `${nonce}<NUL>` 写成 `${nonce}\u{0}U0000`＝分隔符从 1 字节变 6 字节，一次 0 occurrences），已 `git checkout --` 逐字还原；请用脚本落这一格（见 MEMORY「Edit 工具转义坑」） | 待认领 · 来源：chief 0.4.2-beta.2 实机测试 2026-10-22 |
| MK-SMOKE-RECAL | `smoke-tauri-market.mjs` 本机 4 红（2026-10-22 发行前实测）：f2/g/h 三条 = **锚点过期**（`ANCHOR_BYTES=1612` / `ANCHOR_SHA256=f1b72c01…` / 期望 2 条包，线上实测 4,141 B / sha `e100bb76ea79` / 6 条包——社区投稿已进注册表，钉的是**会变的外部内容**）；k 一条 = **判据踩在自己的采样噪声面上**（`intervalMs=300` 却判「行消失 ≤ 目录消失 + 300ms」，实测 469ms / 2,013ms 两跑皆红，功能面逐字节与记账全对） | 判据：f2/g/h 改成「schema 合规 + 远程与盘上逐字节自洽」为准、锚点只钉**本仓可控**内容（外部注册表内容不钉 sha，或按 `fetchedAt` 分档）；k 的容差须 > 2×采样间隔，或改钉「同一轮内行消失前无二次轮询」这类与粒度无关的判据——**不许**为凑绿把功能断言写松 | 待认领 · 来源：chief 发行前实机测试 2026-10-22 |

## 在办 · 多游戏适配（eraAV + eratohoReverse · 2026-10-26，chief）

> **任务**：把编辑器适配到两款新 era 游戏，验证「加一个 era 只加数据」这条路（`adapter-manifest.ts` 单一清单 + 内核零改动）。
> **P0 布线 + P1 识别与导航**为一批；2.0 事实面（`kojo2/`）、发射面（backend）、conventions、糖面留给后续批。

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
| PERF-KOJO2-ANALYSIS | **先行红（非多游戏批引入）**：`packages/app/tests/kojo2-project-analysis.test.ts`「10000 个 @函（解析桩）判定中位数 ≤ 100ms」在本机反复贴阈值。复现：`node node_modules/vitest/vitest.mjs run packages/app/tests/kojo2-project-analysis.test.ts`（空闲独跑，无别的重活）。期望 vs 实际：屏上原样 `AssertionError: expected 103.19970000000012 to be less than or equal to 100`；同一棵树枝四次读数 = 两绿（<100）+ 119.99 + 141.69。定责：该文件 import 面只有 `@kojo/kojo-core` 与 `app/src/ui`（`:17`、`:38`），与适配器/清单零交集；多游戏批两轮全量都撞上它。**同族第二条（2026-10-27 美学收口批补读数，不另立行）**：`packages/app/tests/tree-sitter-parse.perf.test.ts`「32 次单击键增量 p95 ≤ 16 ms」在**同一台机器**上给出过 21.56（红·池内）/ 89.78（红·独跑）/ 9.77（绿·独跑）三种读数，而**同机 A/B 对拍会翻转**：先跑的那棵 p50 6.19 / p95 9.77 绿，后跑的 `origin/dev` 游离树（`git worktree add --detach`，本批代码不在里面）反成 p50 10.55 / **p95 19.64 红**——红绿跟着"谁先占满机器"走，不跟着改动走。同池 `kojo-core/incremental` 同状（池内红、独跑 62/62 绿＝PITFALLS 72 饿死族）。⇒ 判它红的口径：先看断言消息里"退回整篇的击键"那行有没有内容（有＝真回归），再**同机对拍两棵树的先后顺序各跑一次**；本批改动手是 CSS 切片 + 两枚 UI tsx，与该文件 import 面（`src/monaco/tree-sitter/{engine,edit,types}` + perf 夹具）零交集。同日功能池总墙钟 332 s vs 基线 174 s＝本机慢 1.9×，n=32 的 p95 取第 31 小，一枚后台进程就够一票否决 |

## 在办 · Kojo 2.0（设计基线 v0.9）

> **依据**：`docs/KOJO-2.0-LANGUAGE-SPEC.md`（v0.9 设计稿+任务清单合并入库版）。
> **已定**：开发期双前端并存、发布态单一模式（CUTOVER 单批收口）；旧前端只修会被 2.0 复用的后端面。
> **批次一~九已全部落 `dev`**（core 包/程序层/存储·项目·语义接线/迁移引擎含语义升级/切流阶段/编辑器 provider 全量/项目索引/真实语料机/体感验收矩阵），完成行已删、回执在提交信息。

| ID | 任务（落点） | 关键判据 / 已实测事实 | 状态 |
| K2-D0 | **设计冻结与结构裁决**：D0.1–D0.11 + 4 项结构前置落字；定包归属/审计放行、项目级分析层、存储期分配器、多时机拆文件；定旧前端退役时点 | 用户 2026-10-27 裁定：D0 全部按「通过」执行（`选项` 保持 2.0 待定 UI 的 warning 口径）；4 项结构前置随 C1 已实现 | 已裁定 · 2026-10-27 |
| K2-CONTRACT | 2.0 契约面：落 **`@kojo/kojo-core`**（AST/诊断码/source-map/GameAdapter） | 用户 2026-10-27 裁定：维持 `kojo-core`，**不** additive 镜像到 plugin-api；LAU 的方言/协议批据此开实现 | 已裁定 · 2026-10-27 |
| K2-CORE-PKG | core 包布局与 audit 放行：`packages/kojo-core` 已建（非插件库，B/C 项不拦）；§15.2 复用清单核对与偏离记账 | audit A–D ✅；复用点可核对；单文件转译纯函数 | 进行中 · 认领：lead 2026-10-21 |
| K2-PRE-REUSE | 旧后端复用面缺陷余项：**①字面量编码器（心形 `@"…"`）④诊断列折回物理行（与 POS-UTIL 合流）**。②③⑤ 已落 dev（`c11cb3d4` 注释穿透 / `08ac046d` 回读回滚 / `51eef191` CJK 函数头） | 每条红→绿用例；只修复用面；全量不回退；①④ 由 lead 定派 | 待派 · 来源：语言实现审阅（① 本组认领后遇 429 未开工） |
| K2-RELEASE | R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真实工程人工验收 | P0 全完成；eraTW 完整体验；反向回滚可用 | 待认领 |
| K2-INCR-HOLES | 增量已知洞：`选项`/BOM 粘性永久全量；整份替换/改 `# 视` 仍整份重建（~200–300ms）；声明单元内编辑 55–75ms；槽族正则只覆盖 `rand/foreach`；构建期自检冷路径 ~300ms | 每次退化可见；与全量逐字节等价不破 | 待认领 · 认领：lead 2026-10-22 |
| K2-CORPUS-SOURCE | 真实语料机**没有输入**：本机 eraTW 4.980 基线是纯游戏盘（无 `.kojo`，递归发现 0 份）；`corpus` 工具已就绪（缺席 rc=2 / 0 份 rc=1 不当绿），需把 `KOJO_CORPUS_DIR` 指向含 v1 作者源的工程或迁移快照盘后再重生成 golden | 发现 ≥1 份 `.kojo` 且状态/原因分类可读 | 待认领 |

## 在办 · 编辑器体感对齐（ERB / kojo2 同权 · 2026-10-22）

> **原则**：ERB 与 kojo2 同为一级语言，能力矩阵由 descriptor 声明 + `LANG-PARITY-GATE` 钉住；禁止"某 provider 只挂一门语言"。

（本区暂无在办行：同权矩阵已由 `LANG-PARITY-GATE` 钉住，启动器相关批次统一在下方「启动器落地」区管理。）

## 在办 · 语言面统一（LAU · 2026-10-25，组长 krosama）

> 规格来源 `docs/ARCH-language-unification.md` **v1.1**（附录 A 有 v1.0→v1.1 的 21 条逐项对照）。
> 七路批（LAU-0/1a/GATE/2a/6a/SYNTAX/FIXTURE/D1a）已落 dev，交付回执在各提交信息里，本表行已删。
> **LAU-3 框架批（2026-10-27）已交付**：分支 `b/qoder/1027-lau-framework`，回执在该提交信息里；本表行已删，余项拆成下面的 LAU-3b。
>
> **LAU-3b 解耦批（2026-10-27，同分支）已交付**：`kojo-sugar` 插件族（转译 + `ui-sugar-lift/preview/editor`）只在显式启用 kojo1 时装配（`ui/legacy-plugin-gate.ts`；缺省档连模块字节都不取，真壳双档实测 0 枚 / 4 枚 active）；ERB / kojo2 / 宿主共用的词表、词法、格式化全部迁到 `@kojo/kojo-vocab`，`kojo-sugar` 只剩 v1 转译管线与它自己的宿主面，**已整体离开开机静态图**。用户口径：kojo1 的地位就是"即将删除"，封存服务于彻底删除。

| ID | 任务（落点） | 关键判据 | 状态 |
| LAU-BLOCKED | **LAU-1（协议 v3）已交付**（`b/qoder/1027-lau-d2a`，回执在提交信息：v3 落 `kojo-core`、双跑降级、差集 1 码元/键、ERB 首帧进 BASELINES）；**LAU-D2a/D2b 已交付**（方言事实接线 + `dialect lint` 七项；引擎词表收成单一真源，M1 6⇒5）；LAU-4 仍与 ERB-PARITY、SDK B4/B5 同文件，须串行 | LAU-4 等 B4/B5；LAU-2（角色表）/ LAU-5（单池）/ LAU-D3（XML 载体）未开工 | LAU-1 / D2 已交付 · 2026-10-27 |

## 在办 · 启动器落地（2026-10-26，组长 qoder）

> 规格来源 `docs/LAUNCHER-ARCHITECTURE.md` **v0.4**（对照实树修订批，已落 dev `55c0e60b`）。
> 分批顺序见该稿 §15 / §17；**本表由组长统一管理**——车道不直接改 BOARD（五路并发同文件必撞），
> 交付仍按 §五 删行、回执写进各车道提交信息。

| ID | 任务（落点） | 关键判据 | 状态 |
|---|---|---|---|
| LAUNCH-L7B | core 插件源码项目 `PluginProjectService`：工作区项目、`buildZip` 确定性打包、`launcher_project_hash` 摘要、drift 报告 | 同内容两次打包逐字节相同；源码/产物分离；三条写边界；`launcher_project_hash` / `launcher_runtime_*` 两条宿主命令目前**不在** Rust 侧，须先补；插件面板的「打开源码」已接 `plugins.openSource`，源码项目本体仍只能读、不能建 | 待派（依赖 L7A 的清单类型，已落） |
| LAUNCH-P0-RESIDUE | P0 真壳验收余项（L9 已覆盖判据④孙进程 + ①的地基）：② ~10 MB fixture 的 `copy` 实例 + 复制进度可见；③ 同实例二次 `start` 报 `LAUNCHER_INSTANCE_BUSY`；⑤ 原生信任框确认后启动成功、篡改 exe 报 `TRUST_CHANGED`；⑥ 应用退出杀树 + 下次启动显示 `app-exit`；① 的「经 UI 建 shared 实例」现只由夹具播种覆盖 | 全部在真壳（`debug-cli shell` / `launcher-smoke`）取证；不碰真游戏目录；⑤ 的原生框无人值守点不了 ⇒ 须改由宿主侧命令面取证或在报告里如实标 SKIP | 待派 |

## 在办 · 美学收口（1027，shiori）

| ID | 任务（落点） | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| AE-GHOST | **本批实测后刻意没改的口子**（不是漏，是撞别人标定）：`button.ghost` 的悬停吃基类 `button:hover` 那枚**实心灰** `--btn-bg-hover`，落在透明底上读作"突然贴了块胶布"（全站 90+ 处 `ghost small`）。改法本身一行，但 `button.ghost:hover:not(:disabled)` 特异性 (0,3,1) 会连带压掉三处组件自写的标定——`.toolbar-btn:hover` / `.ksp-clear:hover` 的 `border-color: transparent`、`.prob-copy:hover` 的 `--hover-strong`；且重档 `styles-project.css` 比 `problem-panel.css` **晚到**，平局也是它赢 | 判据：先给"组件自写的悬停档"让位的机制（`@layer` 基座档 / 或统一 `.kit-btn` 带 `:where()` 的低特异形态），再收这一档；不许直接压特异性。落点已写进 `styles.css` / `styles-project.css` 那条 ⚠ 注释 | 待认领 · 来源：shiori 美学收口批 2026-10-27 |
| AE-SPLIT4 | **本批实测后刻意没改的第二道口子**：把手全仓**六条**（壳层 `.resizer` / 教程树底 `.kp-splitter` / 命令矩阵行分隔 `.cm-split` / 命令矩阵列把手 `.cm-corner-resize` / 底栏 `.dock-cell-resizer` / 编辑器组 `.editor-divider`），本批把热态收到 `--split-hot`＝accent **五条**，唯独 `.editor-divider` 的 `:hover` 与 `:active` **共用一条规则**转**中性灰** `--wash-gray-strong`——同一个"可以拉"的声明给出两种反馈。撞车点：B-5 迁移批的 `styles-wash-token-discipline.test.ts:267` 把这一格（`:active` 的**终值** `rgba(128,128,128,.35)`）逐字钉成"零视觉变化"对拍台账，而 `:hover` 与 `:active` 同块——动色＝替别人的批次改写判据。另两处实测到的家丑本批也**没收**：命令矩阵 `.cm-split::after` 静息吃 `--border-subtle`（比教程那条的 `--border` 淡一档，收齐是**可见变化**，不在"零视觉改档"授权内）；底栏 `.dock-cell-resizer` 只写了 `:active`，**悬停零反馈**（补 `:hover` 同样是新反馈，留给该面 owner 定夺） | 判据：先由该闸 owner 把口径从"终值对拍"迁到"落点在册"（或明确同意抬这一格），再把 `:hover` / `:active` 拆块、热态接 `--split-hot`。本批已在 `styles-project.css:8155` 留注释、并在 `aesthetic-ladder.test.ts`「两处本批故意没收的口子」里**反向钉住**（谁真收口而判据没跟上就红） | 待认领 · 来源：shiori 美学收口批 2026-10-27 |
| AE-SCROLLFADE | **本批实测后刻意没改的第三道口子**：滚动区**边缘渐隐**（mask，与滚动条几何族无关）同一份配方抄了四遍——`.editor-tabs`（`styles-project.css:844`，16px）＋ `.tree-groups`:1044 / `.nav-tree,.nav-hits`:2010 / `.ksp-results`（`search-panel.css:56`，各 18px）。收口成一条 `.u-scroll-fade-*` 原语会撞 `ui-chrome-polish.test.ts:47`「三个滚动列表都是『底部留白 + 渐隐』」——那条判据 `ruleBody()` **逐元素读自己那一格**的 `mask-image` 与 `padding`，声明换成挂类就判空 | 判据：由该闸 owner 把三条判据从"读自己那格"迁到"读类名在册"（或加消费方白名单），再落 `--scroll-fade` 单源。本批已在 `tokens.css:360-362` 把两族划清并留标记，`aesthetic-ladder.test.ts` 反向钉住 mask 抄写者名册 = `styles-project.css` + `search-panel.css` | 待认领 · 来源：shiori 美学收口批 2026-10-27 |
