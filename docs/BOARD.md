# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## AA. P1 编辑器肌肉记忆批（lead 2026-10-18 立项；用户点名清单，三 agent 并行）

> 五条缺陷全部落在 `packages/app/**` 宿主层（零内核 / 零插件 / 零 Rust）。热点文件单主：
> `App.tsx` 按 hunk 区划给三线（commitOpenFile/close 区归 nav；recent/session 区归 quicknav 与 split；restore/write 归 split），
> `ProjectView.tsx` extraCommands 区归 nav 与 quicknav、groups 渲染区归 split，`EditorPane.tsx` 归 quicknav。
> 分支 `b/<agent>/1018-*`，落地由 lead 逐条过 master 窄门。

| ID | 任务 | 关键判据 | 认领 |
|---|---|---|---|
| MM-6 | 前进/后退导航历史（Alt+←/→） | 所有打开/定位路径（文件树 / Ctrl+P / 问题面板 / 转到定义 / 引用 / 函数树）统一入栈；同 path 同行不重复入栈；到栈底/顶可见拒绝（人话，不静默）；跨项目自动清空；纯逻辑栈单测（含越界/去重/清空） | nav-memory 2026-10-18 |
| MM-7 | 跳转到行接线（contrib 已 import、宿主无命令） | 命令面板可搜到「转到行」；落点走既有 `editor.action.request` 通道（EditorPane ACTION_IDS additive）；无活动文件/糖视图下可见拒绝；action id 取证 monaco 0.57 esm 源码 | quicknav 2026-10-18 |
| MM-8 | 最近文件（欢迎页仅 recent projects） | 新持久层与 session 同通道（additive 可选字段 / 新 key，旧记录零改动容忍）；欢迎页新区（文件名 + 路径 + 所属项目 + 失效标记）；点击 = 项目根不同先开项目再开文件；上限 + 去重 + 损坏容忍 | quicknav 2026-10-18 |
| MM-9 | 编辑器组布局持久化 + 上下分屏 | `editor-groups.ts` 加向下拆分与横竖取向（纯函数 + 单测）；组态随 session 记录落盘/恢复（additive）；欢迎页「继续上次会话」还原组态；分隔条按取向拖拽；CSS 两种取向 | split 2026-10-18 |
| MM-10 | 恢复关闭 tab（Ctrl+Shift+T） | 全部关闭落地路径（单关 / 批量 / 脏确认后丢弃 / 关组）统一入栈；恢复 pop 栈顶开进焦点组并激活；栈有上限；跨项目清空；空栈可见拒绝 | nav-memory 2026-10-18 |

## B. 本组任务（本组）

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|

| HK-4 | UI 打磨（常任；目标「专业 · 克制 · 流畅 · 高效 · 耐看」，VSCode 为基准） | 自拟六项按序推进：UI-1 字号尺度 ✅§5.121 / UI-2 圆角·边框·阴影 ✅§5.122 / **UI-3 图标 emoji→单色 SVG ✅**（`docs/log/2026-10-13-ui-icons.md`；宿主层渲染面归零；插件自绘面板符号＝跨包图标通道**已交付 ✅** `renderIcon` 桥，3299bd7） → **UI-4 焦点环与键盘可达 ✅**（roving tabindex 漫游 + `:focus-visible` 焦点环） → **UI-5 动效可关 ✅**（设置项 + `<html data-motion>`） → **UI-6 底部问题面板 ✅**（ERB 结构/表达式两层波浪线汇总、点击跳源行；状态栏 ✕/⚠/ℹ 计数经 `kojo.problems` 展开，Ctrl+Shift+M）；每项带可复跑量化判据 | 进行中 · 认领：hk4ui 2026-10-14 |
| LSRV-1 | **erb-parser 语言服务批：未定义 CALL 目标 warning 波浪线 + `$` 标签转定义** | 判据：①CALL 直系族名字槽里的裸标识符不在 `ErbIndex.byName` ⇒ warning 行级装饰；fail-open 全集（索引缺席零误报 / FORM 动态拼接 / CALLFORM 全族 / 字符串·注释·SKIP 区 / `$` 标签一律不报），判据与 `scanFileRefs` 单源共用不抄第二份正则；②scanner 收集函数内 `$LABEL`（`ErbFile.labels`，strictly additive + 快照 v5→v6），`JUMP`/`GOTO` 系裸标识符 → 本函数同名标签转定义，找不到 = 空数组不猜、不落函数名尺子 | 进行中 · 认领：erb-refs 2026-10-16 |
| REN-1 | ERB 函数重命名（Monaco RenameProvider，纯宿主侧；`erb.parser` 反向索引 `referencesTo` 为唯一数据源，索引外名字一律拒绝） | 只读文件剔除并在 reject 理由明示「n 个文件只读未纳入」；monaco 0.57 standalone 见 `rejectReason` 丢弃全部编辑 ⇒ **全或无**；未打开文件走内核 io 读改写（standalone bulk edit 对无 live model 的 resource 抛错，WorkspaceEdit 通道只达已开标签） | 进行中 · 认领：erb-rename 2026-10-16 |
| T2/T5/T6 | 编辑器能力三件：T2 ERB 函数 docComment 悬停（`erbIndex` 通道进 `HoverTables`，定义行与调用点同命中）/ T5 Monarch directive 词表同源化（adapter 指令表可用时派生、重设 dispose 旧、项目切换不残留）/ T6 补全位置门（CALL 系名字位只给函数名候选、字符串内零候选，门=过滤不重排） | 纯逻辑（悬停解析 / 词表合并 / 门判定）各带假表单测，不依赖 Monaco/内核；`packages/app/**` 边界内动手 | 认领：erb-app 2026-10-16 |
| T13 | ERB 选区格式化 + 打字规范化（Range Formatting + on-type，纯宿主侧） | 区间层不抄第二份规则：复用 `computeFormatEdits` 整篇核心 + 行裁剪（新模块 `monaco/kojo-format-range.ts`）；编辑绝不越选区；on-type 触发字符宁缺毋滥（`;` / 全角空格）；`packages/app/**` 边界内动手 | 认领：erb-fmt 2026-10-16 |
| T10 | ERB 调用层级（宿主自建 overlay 面板——Monaco standalone **无** CallHierarchy API，取证 PITFALLS §83，原 Monaco Provider 方案缺席即弃） | 数据源零第二判据：入边 = `referencesTo` 反向索引逐点反查所属函数（`functionAt` 通道优先、缺席退化索引自扫、反查不了 fail-open 跳过）；出边 = `bySymbol` 全表 `kind==='call'` 且落在本函数定义区间的子集（"什么算 CALL 引用"单源在 erb-parser/references.ts）；入口 = 命令面板 `editor.command` + `ui.overlay`（App.tsx，diff/history 同款），位点现取 `readJumpProbe()`，跳转走既有 `editor.revealLocation`；数据层纯函数假索引单测 + overlay 静态渲染 | 认领：erb-hier 2026-10-16 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| AM-1 | **eraAkumaMaid 适配器批**（组长制；方案 `docs/PLAN-eraAkumaMaid-adapter.md`；批次分支 `b/lead/eraakumamaid-adapter`；9 子 agent 并行，文件集互不相交） | 判据：detect 只认 AM 且不与 eraTW 互认 / loadProject 绑 75 编号口上目录 / 后缀式 family-index 全量覆盖率读数（未命中逐类有理由）/ 变量字典三层 / `TRAIN.csv` 指令表 / `EVENT_K.ERB` 调用协议 / 约定首批零误报门槛 / 糖面主链路可转译且缺面 fail-closed / 全量测试不回退 + typecheck + `audit:decoupling` ✅。已拍板：糖语言只服务中文社区；向导族抽取共享骨架（不复制 eratw 向导代码） | **P0–P4 全部交付并 rebase 到 `1022a19`**（detect/loadProject/family-index/变量字典/指令表/调用协议/约定 3 规则/糖面 10 面；P4＝`plugin-api/src/scaffold.ts` 共享骨架 + AM 脚手架 + 角色表 CSV + 品牌文案「era 口上编辑器」）。**P4-2（向导族共享骨架）已落地，余项清零**：新建共享包 `packages/kojo-project-kit`（~3.7k 行，原 11 个模块实测零 eraTW 知识 ⇒ 整体上移：attribution / artifact / licenses / new-item / deploy / package-actions / publish-pack / 四个向导 / 项目面板）；adapter 侧只剩「数据 + 委派」薄层与 `overlay-ids.ts`；`GameAdapter.scaffold?()` 契约位由**两个 adapter 同时兑现**（eraTW 落角色口上目录、AM 落游戏根子树），此前双方皆空实现；**AM 首次接上面板 + 四个向导**（此前只有 `game.adapter` 一条贡献，现在与 eratw 能力对齐，`openTutorial` 改可选 ⇒ 无教程的游戏不渲染教程区）。读数：合流树全量 **8208/49（8257）· 0 failed · 471 文件** · 双 typecheck 0 · audit **20** 插件 ✅（`kojo-project-kit/src` 已进 A 项零游戏名词区）· PS-10 项目级名单 18 已同步冻结名单。**未做**：sav 接入不做（本游戏无 `sav/`）。认领：lead 2026-10-18，收口 2026-10-19 |
> **已交付不再立行**（本批核账；P 提案 = `docs/SUGAR-INTIMATE-EXPANSION-PROPOSAL.md`，R 提案 = `docs/SUGAR-RANDOM-CANDIDATE-PROPOSAL.md`）：P-10① 裸引擎全局白名单（`d2ab0a3` + `engine-globals.ts`）、P-10② 全角拉丁字母进标识符集（`d2ab0a3` + `identifier-chars.ts`）、P-10③ 族头具名核对（`6018c50`）、P-1 段块（`4392ccf`）、P-2 NOWEX 字典接入（`5f23e6b`，`index.ts` `NOWEX: ['NOWEX','EX']`）、P-5 指令名 CASE 值（`fca34bb`）；R 提案 E17（`f49a4b4`）/ E18（`e8501c0`）已交付。**本批新交付**：P-3 初回段（保留段名 `段 首次：` ⇒ `LOCAL:1` + `FIRSTTIME(SELECTCOM)` 整串硬编译）、P-4 随机直出形（文件头 `随机形: 直出`）、P-6 绝顶子面 B2/C/F（`时机 绝顶恶作剧：`/`调教后：`/`寸止：`）——读数见提交信息。**仍开放**：P-10③后续/P-9 不做清单、R 提案 E19。
> **关联**（勿重复认领）：`named-index` 337（未知的 9.0%）已由 **ALS** 行承载（v34hand 2026-10-14 认领）——回放线不再单独立项。

## D. 已拍板（用户 2026-10-13 反馈批）

- **糖视图**：**已交付（2026-10-14）**。落法＝**把升糖文本写进编辑器的只读内存 model**（inmemory://sugar/…，语言 kojo-sugar），d.setModel() 换成它、由 Monaco **原生渲染**（字号 / 行高 / 折行 / 行号槽 / 搜索 / 复制全原生），磁盘文件零改动。**原 ViewZone 自绘（.sugar-zone / --sugar-* / 折叠柄 sugar-fold）整套删除**；「虚拟文档三问」按此落法得解（a 原文行随糖文本一并进 model、b 无需 lineMap、c 状态栏即显示糖文本行号）。
- **文件类型保留面（用户 2026-10-14 拍板 · 依据 §G FT-3 调研，全盘 16,121 文件 / 41 种扩展名实测）**：Monaco 语言面按四档定稿——**A 保留**内置轻量 definition `markdown` / `ini`（`.config` 是 `KEY:VALUE` ini 风格）/ `xml`（每门 `register.js` ≈1 KB、**不带 worker**）；**B 四门重型 feature 全砍**（`json` 400 KB / `html` 704 KB / `css` 1.1 MB / `typescript` **6.8 MB** worker；语料实际命中 `.json` 1 · `.html` 2 · `.css` 0），`.json` 高亮改**自写微型 Monarch**，随保留面实现一起做，**不引 worker**；**C 其余 ~79 门内置语言砍**（语料 0 命中）；**D 档 `.xlsx` / `.xls` / `.docx`**（ZIP/OLE 复合二进制，Monaco 原理上显示不了）**＝未来新功能，仅立项不排期＝§G FT-4**。ERB 方言族 `.erb` / `.erh` / `.erd` + `.kojo` 由**自备一套 tokenizer** 覆盖（与 FT-1 / FT-2 同线，非 Monaco 内置语言问题）。

## E. 用户反馈批（2026-10-13 试用反馈，决议性入册）

> 来源：用户对 0.4.0-beta.1 试用后的 13 条反馈（要点摘进各行，关键短语保留原话）。
> **当务之急 = E1**；E5–E8 为修复 / 新增。已拍板的总纲见 §D。

| ID | 任务 | 关键判据 / 口径（含原话摘引） | 认领 |
|---|---|---|---|

## G. 文件类型覆盖调研批（2026-10-14 · eraTW 全盘 16,121 文件 / 41 种扩展名实测；**语料目录名会变 ⇒ 认内容不认名**）

> 引擎侧权威白名单实锤：`Emuera/Runtime/Utils/Preload.cs:88-93` 预载只过滤 **`.csv` `.erb` `.erh` `.erd` `.als`** 五种。
> 下面两行都是「编辑器覆盖面 ≠ 引擎覆盖面」的缺口，与 E16「该能写却写不了」同族。
> 关联：**缺口「`.als` 未进字典」已由 `5f23e6b` 交付并删行**（只并集不覆盖 + 冲突原句实锤），本批不重复立行。

| ID | 任务 | 关键判据 / 已实测事实 | 认领 |
|---|---|---|---|
| FT-4 | **OOXML / OLE 二进制文档只读解析**（用户 2026-10-14 令：**仅立项、属未来新功能开发，不排期**） | **为什么不是"保留一门语言"能解决的**：`.xlsx` 7 / `.xls` 1 / `.docx` 2（语料实测）是 **ZIP / OLE 复合二进制**，Monaco 只能显示文本 ⇒ 给它配语言＝一屏乱码。**范围**：读出表格 / 正文成**只读视图**（不编辑、不写回），落点＝新插件或既有 `ui.panel` / `export.target` 槽位，**禁改内核**；`xlsx`（ZIP+OOXML）与 `xls`（OLE 老格式）是**两条解码路**，`docx` 取正文。**价值定位**：这批文件集中在 `README集` 与「原版+前人整合等各种readme（口上模板及口上教程在内）」资料目录 ⇒ 是让作者**读得见前人说明**，不是编辑对象（同族只读资源还有 `.webp` 2,548 / `.png` 642 / `.mp3` 33，本行不含）。**开工前先补齐的判据**：三类格式的最小可验样本集 + "读得出 / 读不出"的人话拒绝口径（照 `app/src/ui/drag-drop.ts` 现有未知类型聚合通知的**同一形态**，不许静默丢弃）。**优先级最低，勿与 FT-1 / FT-2 抢道** | 待认领（**仅立项**） |

## H. ALS 复验批发现（v34hand 2026-10-14 对 `5f23e6b` 复验；三盘＝画蛇添足 4.980 / 魔王改版 / 原生官方 4.842，`ERB/口上・メッセージ関連` 2,317 / 2,370 / 1,280 份 `.ERB`）

> 复验通过的（不再立行）：并入读数 **757 名 / 26 编号**（魔王 973/27、官方 0/0 且 `inputDigest` 与改前逐字一致）；三盘 **0 份孤儿 `.als`**（无 `.csv` 同名表 ⇒ 不会凭空造出新表键）；19/20 份 `.als` 全 UTF-8（画蛇添足 19 份带 BOM、魔王 20 份里 3 份不带 ⇒ `trim()` 与不带 BOM 两路都走得通）；`variable-schema.als.corpus.test.ts:133` 的 `>= 757` 门槛三盘为 757 / 973 / 跳过 ⇒ **不会在别的盘上假失败**；`DAY.als` 行内 `;` 尾巴已是**钉死的决定**（`variable-schema.test.ts:232`），非缺陷。

| ID | 任务 | 现象 / 复现 / 期望 vs 实际（报红格式） | 认领 |
|---|---|---|---|

## R. 语料换版后遗留红项（lead 2026-10-16 报红；归口对应线，性能批已排除自身）

> 复现前置：语料在本机（扫描根路径只在本地记忆，不入仓库）——`export KOJO_CORPUS_SCAN_DIRS=<语料扫描根>` 后
> `node tools/corpus.mjs --print` 应 rc=0；再 `KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" node node_modules/vitest/vitest.mjs run <file>`。
> **归因**：CR-2 在 `4303cf6`（1016 性能批落地**之前**）用同一份语料跑同一条命令**逐字复现** ⇒ 非 1016 引入；
> CR-1 已于 10-16 根治（回退单位从「函数」降到「段折叠」，台词行覆盖 69.7%→99.2%，回执在提交信息里）；
> ENC-1 为 10-16 中文欠账批复跑时新查（校准盘 `sub-modding` 不在位所致，判据逐条写在本行）。
> 1016 期间唯一受影响的 `encoding-roundtrip` 钉值已随换版重校（2,285→2,294，字节差异 0 复跑 7/7 绿）。

| ID | 任务（现象 / 复现 / 期望 vs 实际） | 认领 |
|---|---|---|
| MK-1 | **市场面板的「已装」态刷新明显滞后于盘上真相**（真壳 k 项读数；归口：市场线。原报文本写得比真相重，已随探针修好一并纠正）。<br>实测（master `708f79d`，真出网真解压，同轮三次复跑）：装成功后「已装」行出现 = **537 / 1178 / 1209ms**；点卸载并确认后 **落点目录消失 = 498ms**（盘上一句话就干净了），而**屏上那一行消失 = 3710ms**。⇒ 不是「装不上 / 卸不掉」（逐字节 + sha256 + 记账核对码全对平、暂存区零残壳、目录与行最终都消失），而是**面板刷新慢一拍**：卸载后作者会看见一条「已经不存在却还挂着」的行 3.7 秒——正是要不要接即时重取的那个决定。<br>复现：`HTTPS_PROXY=http://127.0.0.1:7890 node tools/smoke-tauri-market.mjs "<语料根>"`（k 项现在**每次把三个毫秒数打进读数**）。<br>**探针侧的教训一并记在这里**（组长自己踩的，两条都是 `tools/smoke-tauri-market.mjs` 已修的形态）：①`waitFor` 认「表达式返回真值」为就绪，而探针就绪前返回字符串 `no-installed-row`——**字符串是真值** ⇒ 第一次就"等到"，60s 等待形同虚设，把「滞后 1.2s」读成「永远不出现」；②卸载后固定 `sleep(800)` 一次性判读，把「慢一点」读成「没做完」。⇒ 判「有没有出现/消失」一律用**带耗时的轮询**，别让布尔型 waitFor 去接一个返回字符串的表达式。<br>判据：卸载确认后行消失 ≤ 目录消失 +300ms（同一轮内）；**不许把 k 摘成 SKIP，也不许靠拉长等待把滞后掩盖掉**——数字每次都要上读数。 | 已修 · 待真壳复验（W15b 落地，单元 231 绿；真壳探针因 1420 被另一 checkout 的 vite dev 占用、按 §70 未抢清端口） |

## S. 1016 真语料复测新发现（lead 报数；性能归口）

| ID | 任务（现象 / 已实测事实 / 判据） | 认领 |
|---|---|---|
| PERF-14 | **内核 storage 读一份快照要走 `exists` + `readFileBytes` 两趟 IPC，且排在忙的事件循环后面**（归口：内核 / `packages/kernel/src/storage.ts`；由 PERF-13 的装载归因给出：盘上主快照已瘦到 1.43MB、node 侧 read+parse 实测 **19.6ms**，壳侧同一次装载 await **1,406ms**——多出来的是两趟 IPC 的排队等待）。今天它不痛（与抽取段并行、没进用户体感：热轮校验段 delta 只有 37.7ms），但它是**装载读数的全部虚高来源**，也会在「快照变大 / 循环更忙」时变成真痛。**判据**：①合并成一次 IPC（或命中缓存直接返回），给出真壳装载行改前→改后；②不许糊掉失败语义（不存在 ≠ 读失败，`droppedUnits` / fail-closed 判死跟删照旧）；③两桥同形（Tauri vs node 桥）加守卫，别重演 PITFALLS 73；④不许为了读数好看改计时口径。**复跑**：`node tools/boot-watermarks.mjs`（冷+热，看 `lint reuse` 与 `index breakdown`） | 待认领（内核线；性能线供读数） |

## T. 数据安全批遗留（lead 2026-10-16 收口时记录）

| ID | 任务（现象 / 复现 / 期望 vs 实际） | 认领 |
|---|---|---|

## Z. kojo 全中文化系列（lead 2026-10-17 立项并全权推进；七线并行，文件族互不相交）

> **系列总目标（用户 2026-10-17 令）**：`.kojo 预览`（升糖显示）**屏上一整行原样 ERB 归零**——行内允许残留英文记号（引擎函数名、槽位原名），
> 但「这一行就是源文件那一行逐字抄来」必须 = 0 行。口径澄清：**升糖是只读理解面**（糖 model `readOnly`，磁盘零改动），
> **不存在**「原文转糖再编译」这条链路，因此本系列一切判据只看「作者读到什么」，不看产物可逆性；原 `.ERB` 逻辑由「投影不改盘」天然保持。
> **两条尺子分开记**：红线 = `isVerbatimNativeLine` 命中数（契约 `kojo-sugar/src/native-display/types.ts`，必须 0）；
> 质量线 = 未识别兜底行数（允许非零，但必须可数、逐线下降）。历史基线 = 整篇行覆盖 60.8%（STATE §一 CR-1）。
> **并行纪律**：一条线一个工作树 + 一条短命分支（`b/<agent>/1017-zh-*`）；**热点文件单主**——`project.ts` 只归 ZH-P、
> `expression.ts`+`keywords.ts` 只归 ZH-E、`variable-schema.ts`+`plugin-api/game.ts` 只归 ZH-N、`app/src/monaco/*` 只归 ZH-L；
> 落地由 lead 逐条过 master 窄门（fetch → rebase → 门槛全绿 → `push HEAD:master`，永不 force），agent 只推自己的分支。

| ID | 任务 | 关键判据 / 已实测事实 | 认领 |
|---|---|---|---|

## V. 补全体验批（2026-10-17 用户反馈 · 自动补全优化）

> 缺陷清单来自上游只读审阅（.erb 指令表缺口 / 名字槽候选源混装 / .kojo 变量触发链断 / `：` 无条件弹词表 / 族头与 `#DIM` 无补全 / 标签不按函数作用域 / 位三段式失效 / 落字形态与空白口径）。判据：各槽位一轮候选"只出自己的源"+ 真实 CompletionModel 过滤链自证。

| ID | 任务 | 认领 |
|---|---|---|

## W. 1018 性能对标批（lead 2026-10-18 立项；六路体检实锤驱动，10 包并行）

> **尺子（本机实测，性能判据一律按此）**：真实语料最大单文件 **52,601 行 / 2.35 MB**；全盘 16,121 文件 / 603 MB；99.5% UTF-8；主快照 **19.48 MB**（fns 57% / refs 41%）；索引 99,104 函数 / 2,316 文件。
> **基线闸门（`2f35155` 本机实测）**：功能池 **7278 passed / 49 skipped（7327）· 0 failed**（391 过 / 17 跳 = 408 文件）；计时池 **183 / 17（200）· 0 failed**；双 typecheck 0；`audit:decoupling` ✅ 19 插件；cargo 见落地当轮复跑。
> **独占文件集＝硬约束**：一个包一个主，越界一律不改；热点 `EditorPane.tsx` / `styles.css` 单主。落地由 lead 逐条过窄门。
> **本批不立项（明确留后，别在包里顺手做）**：①watcher 批量 emit（要动 `plugin-api/platform.ts` 事件载荷）②糖诊断/整条 linter 进 worker（要动 `plugin-api/slots.ts` 的 `EditorDecoratePayload`）③EOL 保真换格式（SNAPSHOT/写盘格式改动）④`styles.css` 240KB 分档拆分。
> **各包自报欠账（本批未做，待认领时先读归属）**：⑤inlay 文本按区间取＝需 `plugin-api` 给请求加字段 + erb-parser 起点判据（PS-4）；⑥refs 进 worker 需「prime/broadcast」传输原语，且实测克隆税 38.2ms/名单 + ≈385ms/全文本趟，收益 1–2s 不值当单做（PS-3，已量过再否）；⑦parse 与 scanControlFlow 载荷合并以杀重复克隆、`plugin-api/fingerprint.ts` 行拼（PS-3）；⑩`ps2` 快照装载真壳侧读数仍待 `tools/boot-watermarks.mjs` 空闲机复跑（PS-2）。〔⑧market-panel render 期建订阅、⑨CallHierarchyOverlay `RENDER_CAP=300` 死顶——已由 ps13 批（2026-10-18）交付摘账〕

| ID | 任务 | 关键判据 / 已实测事实 | 独占文件集 · 认领 |
|---|---|---|---|

## U. 1017 中文化收官后的工程收尾（lead 2026-10-17 立项；用户点名清单）

> 这批不是语言面欠账，是**账面一致性、编辑器动作闭环、CI 盲区**三件事。
> **ZH-F5 让位**：本组 agent 已写完计数器补全源（新源 + 分野门 + `names?()` 契约），窄门 rebase 时撞上上游
> `ce76371`（IX-1 索引槽口径统一）——对方把同一件事做得更彻底：契约新增 `plugin-api/src/index-slot.ts` 单源
> （转译 / 悬停 / 补全三消费者只准调它），按面 `indexKind` 让 `kojo-counter` 与 `kojo-instruction` **互斥**，
> 从构造上消掉同名异号 8 条。故**本组 F5 与顺带的 F5b 一并撤销**（`git rebase --skip` 两笔），计数器面编号槽
> 混指令名的噪音由 IX-1 收掉；读数与取舍以对方提交信息为准。
> **判**不立项**一条**：`bootstrap.ts:35` 的「插件运行时动态加载」——19 插件全为编译期内建，作者侧无需求，
> 换 loader 只引入加载序与信任面（游戏目录整体只读 ⇒ 没有任何合法来源可扫）；**YAGNI，不做**，接口预留注释保持原样。

| ID | 任务（现象 / 复现 / 判据） | 认领 |
|---|---|---|

## Y. 夜间自主批（W先生 2026-10-19 立项；用户授予全权，实机驱动）

> 立项依据：用户点名三处痛点——「`.kojo` 语言仍是半成品」「ERB 语言支持偏弱」「状态注入一次实机测试都没通过」。
> 排序原则：先修**通**（一条链路端到端可走），再谈打磨；判据一律以本机实机（编辑器 + `D:/Game/eratw` 语料）为准，
> 数值型长跑只当回归闸，不做无实机反馈的算力消耗。
> **已交付（行已删，回执在提交信息）**：状态注入面板订阅修复（`useSyncExternalStore`，根因＝记忆化容器里只读一次 `current()`）
> + 命令面板「打开状态注入器」入口 + 语料集成测试补注册计算任务（PS-11 卸载后测试台漏注册）；ERB `#DIM` 悬停；
> 预处理器指令词表按真语料计数校正（去掉不存在的 `#DIMSA`/`#DIMF`）。

| ID | 任务 | 关键判据 | 认领 |
|---|---|---|---|
| W-1 | 状态注入面板可用性收口 | 空态按真实成因四分（无项目 / 项目无存档目录 / 扫描中 / 零档 / 全解析失败）且文案给下一步动作；工具条常驻「重新扫描」（引擎 inFlight 去重，连点不并发）；切项目零残留；扫描失败显式呈现不吞 | W 2026-10-19 |
| W-2 | ERB 语言服务补齐（用户点名「ERB 支持偏弱」） | `#DIM` 转定义（本文件声明优先、跨文件 `ErbIndex` 次之）；`$` 标签引用/重命名；补全触发字符覆盖 `@`/`$`；一律 fail-open（索引缺席零误报，不猜） | W 2026-10-19 |
| W-3 | 糖投影未投影行分诊 | 语料直方图按行首 token 排序取前 3 族，逐族给「能投影 / 不该投影」判定与理由；红线（verbatim native 计数 0）一字不动 | W 2026-10-19 |
