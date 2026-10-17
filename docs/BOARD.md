# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

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

| ID | 任务 | 关键判据 / 已实测事实 | 独占文件集 · 认领 |
|---|---|---|---|
| PS-1 | **Rust 宿主 IO/搜索/下载热路径** | ①非 `async` 命令冻主线程：`lib.rs:759 read_files_raw`、`:776 stat_files`、`:1259 encode_string`、`:470/480/527/617/622` 一律改 `async`+`spawn_blocking`（既有范式 `lib.rs:2119`）；`stat_files` 复用 `read_files_frame` 的 `thread::scope` 扇出（6,855 路径=14 趟串行 stat）。②搜索：`collect_files` 每次比较重建两次小写串（`:1943`，12,657 文件≈35万 String）⇒ 预计算排序键；`byte_prefilter` 只认 ASCII（`:1704`）而产品默认查询是中文 ⇒ `from_utf8` 成功后仍走字节预筛；`scan_text` 每行重建迭代器且每个命中重 Walk 行首（`:1807-1816`）⇒ 单次 `find_iter` + 增量计数换行；`preview_window` 未截断时整份拷贝（`:1645`）⇒ 返切片。③`read_one_file` read 后再 metadata（`:676/679`）、`scan_file` 重复 stat walk 已有元数据（`:1845`）⇒ `File::open`+`file.metadata()`。④`:741 Vec::new()` 承载 21MB ⇒ `with_capacity`。⑤**搜索解码与编辑器不同源**：活路径 `decode_with_policy`（`:1217`）只 BOM/UTF-8/shift_jis，而 GBK/Big5 实现 `decode_legacy_family`（`:1785`）是只被 `search_tests.rs:10` 引用的死码 ⇒ 接进回退分支，语料 60 份非 UTF-8 文件预览不再乱码。⑥`market.rs:1007/930` 同步建目录与逐 chunk 无缓冲写 ⇒ `spawn_blocking`+`BufWriter`。⑦`ensure_in_write_domain`（`lib.rs:320`）每次写逐根 canonicalize ⇒ 缓存规范根。**判据**：`cargo test --lib` 不回退并新增用例；搜索侧必须给「同一份真语料，改前→改后」耗时；**不许改计时口径**；两桥同形（node 桥不得因 Rust 改动而语义漂移）。 | `packages/app/src-tauri/**` 独占 · 认领：ps1host 2026-10-18 |
| PS-2 | **内核快照装载/文本缓存/计算配额**（含 BOARD §S `PERF-14` 收口） | ①**PERF-14**：`storage.ts:49 exists` + `:50 readFileBytes` 合成一次 `bridge.readFilesRaw([path])`（三态 `RawFileRead` 契约 `plugin-api/platform.ts:103-112` 与 Rust `FRAME_STATUS_*` 已在，**零契约新增**）；级联一轮付 ~7 次≈14 趟 IPC / 34MB，真计算只有 decode 23.5ms + parse ≤280ms。候选探测（`erb-parser/plugin.ts:255`、`condition-extractor/index.ts:80`、`convention-linter/index.ts:110/159×4`）改走一次 `storage.keys()`。**语义必须活下来**：不存在≠读失败（undefined=首跑不删）、读失败→warn+重建、且 `storage.ts:94-99` 现在把坏 JSON 吞成 undefined、使 `plugin.ts:272` 的 fail-closed 跟删永不触发 ⇒ 第三态 `corrupt` 必须显式上抛。②`io.ts:234-258 readTexts` 为证明自己的缓存再 stat 一趟（批 64 vs `STAT_CHUNK_SIZE` 512 ⇒ 全命中轮白付 37 趟）⇒ 新鲜度令牌或 `peekTexts`。③**内存**：`splitPreserveEol`（`encoding.ts:205-230`）逐字符 `cur += c`，实测 **29.2ms / 12.7MB 驻留 vs `split(/(\r\n|\r|\n)/)` 的 3.9ms / 0.6MB（7.5×、20×）**，且每次读都跑（`io.ts:239-241/286-289`），冷开指纹 55–70M 字符 ⇒ 改正则分段、EolMap 延迟到「保 EOL 写盘」时才建。④`io.ts:69-88` 三缓存设计上限≈500MB，`:321-328` 按 `raw.length` 记账**低估驻留约 20×** ⇒ 按字节计；`encodingCache/eolCache`（`:152-153`）无界；**`io.ts` 没有 `project.closed` 钩子**（12 个插件都清，内核不清）⇒ 切项目 A 的三份正文仍常驻。⑤只读文件（游戏目录整体只读）不该存 EolMap/rawBytes ⇒ 按 `isWritable(path)` 闸。⑥`compute.ts:173-188` 的 `sliceMs` 预算对同步工作是谎：一个窗口 32 个同步扫描跑完才查预算≈100ms 不让路，background 只在 `interactiveDepth>0` 让 ⇒ 窗口内检预算或按工作量封顶。**判据**：两桥同形守卫（PITFALLS 73）；给「一次快照装载 await 墙钟 改前→改后」与「冷开常驻堆 MB 改前→改后」；不许为读数好看改计时口径。 | `packages/kernel/src/{storage,io,compute,encoding}.ts` + `packages/kernel/tests/**` · 认领：ps2kernel 2026-10-18 |
| PS-3 | **erb-parser 级联：refs 重扫、读盘/CPU 重叠、溯源连坐** | ①`refs scan` 全树重扫 **7.4s 同步占主线程**（`plugin.ts:391-406` → `references.ts:189`），且把 parse 已走过的行**再走一遍**（`scanner.ts:210-328` vs `references.ts:136-174` 两遍 normalizeEol+split+trim+skip 块）；单文件微基准 4.5ms 里 `codeViewOf` 逐字符循环（`references.ts:63-82`，`:211` 无条件调）+ `\p{L}` 正则占大头 ⇒ 无 `"`/`;` 的行直接返回、`charCodeAt` 取代逐行 `exec`；正解＝注册 `erb.scanRefs` 进 `offload.ts`、每次构建只下发一份 `byName.keys()`。②`plugin.ts:301-330/391-406` 先 await `readTexts` 再做切片活 ⇒ 盘与 CPU 从不重叠，37 趟串行 ⇒ 双缓冲预取。③**溯源洞**：`refsAreReusable` 只在 `salvaged !== null` 时咨询（`plugin.ts:384`），`attachRefs` 只给「有新 refs」的条目盖章（`snapshot.ts:739-749`）⇒ 新增/改名一个函数让 `namesFp` 变，2,324 条带着旧指纹留 stale refs，下一轮 salvage 白付整树 7.4s ⇒ `namesFp` 进信封、按差集补扫。④`PARSE_CONCURRENCY=12`（`plugin.ts:102`）对着 `bootstrap.ts:105 size=min(4, cores−1)` 的池 ⇒ 6/12 排队且每份文本 structured-clone 进出两趟（`:313-320`、`:538` 又克隆一次）⇒ 并发≈2×池容量。⑤minor：`plugin.ts:262/459/468` 用 `Object.keys().length` 只为数数；`fingerprint.ts:101-111` 每次构建拼排 2,325 行串。**判据**：真语料「read+parse / refs scan / 索引可用」改前→改后（`node tools/boot-watermarks.mjs`，空闲机）；等价对拍必须证明 refs 逐条同产出（照 `snapshot-salvage.test.ts` 15 例口径）。 | `packages/plugins/erb-parser/src/**` + 其 tests · 认领：ps3erb 2026-10-18 |
| PS-4 | **Monaco provider 接缝：每次调用复制整篇文本** | `editor-global-providers.ts` 有 12 处 `getValue()`（`:398/448/487/505/531/569/599/676/741/769/793/826`）。①**折叠**（`:524-536`→`erb-parser/plugin.ts:744`→`folding.ts:116-121`）无档位闸（该文件头明写「超大文件不降级」），而 vendor `folding.js:215-217` 每次内容变化≥200ms 重触发 ⇒ 52,601 行＝每停顿一次 40MB 串拷贝 + 全量解析；照 `kojo-code-lens.ts:94` 的 5k 闸补一份，并加 versionId memo。②**CodeAction**（`:383-418`）被 `codeActionModel.js:31`（光标）与 `:39`（每次 `setModelMarkers`，即 `EditorPane.tsx:566`）双路触发 ⇒ `context.markers` 为空时**先返空再复制文本**（一行闸）+ 按 lineCount 判可负担。③**on-type 格式化**（`kojo-format-range.ts:52-58/112-121`）为一个行结果算整篇；仓里 `kojo-format-range.test.ts` 已钉「整篇算+裁剪 ≡ 区间单独算」⇒ 直接只算那一行。④inlay（`kojo-inlay-hints.ts:122-127`）与签名（`:505`）**无视 Monaco 传来的 range**，改 `getValueInRange`/行窗口。⑤选区字数（`selection-status.ts:41-53`）每行一次 `getLineContent`，由每次光标事件触发（`EditorPane.tsx:1441`）⇒ 超 N 行只报行数。**判据**：`app/tests/**` 不回退，`completion-perf` / `semantic-tokens.perf` 单跑带改前→改后；provider 行为等价必须有对拍（不许把降级做成静默失效——内核铁律 4「不静默」）。 | `packages/app/src/monaco/{editor-global-providers,kojo-format-range,selection-status,kojo-inlay-hints,kojo-code-lens}.ts` + `packages/app/tests/**`（本包新增文件以 `ps4-` 前缀） · 认领：ps4prov 2026-10-18 |
| PS-5 | **编辑器档位、标记轮与模型内存**（`EditorPane.tsx` 单主） | ①`TIER_HUGE` 不覆盖 `wordWrap:'on'`/minimap（`EditorPane.tsx:1312-1313`、`editor-options.ts:127` 的 formatOnType 只在 ≥5k 关，而语料仅 6% 文件过 5k）。②标记轮每停顿两次整篇拷贝（`:591 getValue` + `marker-pool.ts:281/304` structured-clone）⇒ 按字节设闸，且**必须可见**（状态栏「校验暂停」，禁静默降级）。③面包屑按 versionId 全重解析（`:1392-1439`，`collectDocumentSymbols` + 整篇 getValue `:1427`）⇒ 复用 `erbIndex` 通道而非重解析。④内存复制面：每标签 model + `savedBase` 整份（`editor-model-pool.ts:76-95`）、广播账本 32 份全文（`document-broadcast.ts:73`）、`.kojo` 预览 model 每次切换/解锁/directMode 重建且逐行循环（`EditorPane.tsx:701-762`，`:735` O(N)）⇒ 给上界与复用，切标签不重建。⑤`DiffViewOverlay.tsx:162-178` 无尺寸闸（只靠 vendor 5s/50MB 兜）。⑥overview ruler 与 find `matchesCount` 全文档。**判据**：DOM 冒烟 `node tools/smoke-tauri-dom.mjs` 过；档位改动必须真壳取证（大文件开→滚动→敲键的页内墙钟改前→改后）；**不得改 `EditorPane` 对外 props 签名**（PS-6 在调用点 memo，靠稳定回调）。 | `packages/app/src/ui/EditorPane.tsx` · `packages/app/src/ui/marker-pool.ts` · `packages/app/src/ui/DiffViewOverlay.tsx` · `packages/app/src/monaco/{editor-options,editor-model-pool,document-broadcast}.ts` + `packages/app/tests/**`（`ps5-` 前缀） · 认领：ps5tier 2026-10-18 |
| PS-6 | **工作台外壳渲染：每帧提交与「性能赢过正确性」** | ①`ShellLayout.tsx:926-943 startDrag` 每次 mousemove 派发 `resize` ⇒ 新 `LayoutState` ⇒ 全壳重渲染 + `:277` 一次 JSON.stringify+localStorage 写（≈60 次/秒）；`:1166-1194` 分节拖拽同形；而浮动窗拖拽（`:950-1070`）**早就**用内联样式避开 ⇒ 照它改，pointerup 才落一次。②每次光标移动 `ProjectView.tsx:207-212 setEditorStatus` ⇒ ProjectView→ShellLayout→EditorPane（无 memo、2,010 行体、~40 hooks）+ `SettingsPanel`（`:1573` 35 个全是新闭包）全量重跑；`:265-272` 每次渲染数 2,325 条 `index.files`；四处路径规范化可写性判定（`:1466`、`EditorPane.tsx:1888/1909/1963/1965` → `io.ts:615` 每次分配根数组）。③**结构性静默失效**：`ProjectView.tsx:549-596/621-644` 经可变 ref 桥接 props，`PanelHost.tsx:53-66` 的 memo 只比 `contribution|floating|uiPrefs`（`layout.ts:183-226` 恒等）⇒ memo 的 `PanelBody` **永远 bail**，`FileTree` 收不到新 `index/activeFile/refreshNonce`（B4 定位、HK-5 relist、冷快照→索引切换在重挂前全是死的）——这是把性能红利吃穿了正确性；正解＝host 版本计数进 `PanelBodyProps`。④文件树churn：`FileTree.tsx:220-239` 每个目录响应一次 `setDirCache` ⇒ K 次全树重渲染；`file-tree-dir-rows.tsx:74-80` 每次渲染 `localeCompare` 重排 + 逐行正则；`:643 scrollLocate` `querySelectorAll` 扫所有挂载行；`dirCache` 仅删除/改名时剪枝（无界）。⑤监听卫生：`market-panel.ts:94-113` **在 render 里**建订阅（丢弃的 render 泄一个句柄）、`ShellLayout.tsx:935-941` mousemove/mouseup 在窗口外抬起时残留、`tabs-bar.tsx:82-96` 每次 dragover `setTabDropAt(new object)`、`ProjectView.tsx:706-727` pointermove 只在 pointerup 解绑。⑥快开：`commands.ts:151-166` 每键小写并重排 2,325+ 路径；`Palette.tsx:149-153` 每行三次 `dirLabelParts`。**判据**：拖一次分栏的 React 提交次数与 localStorage 写次数必须可数（改前/改后）；`PanelBody` 修复要有「外部改一个文件后树真的更新」的用例钉住。 | `packages/app/src/ui/{ShellLayout,ProjectView,FileTree,SearchPanel,ProblemPanel,tabs-bar,Palette,PanelHost,layout,commands}.{ts,tsx}` + `packages/app/tests/**`（`ps6-` 前缀） · 认领：ps6shell 2026-10-18 |
| PS-7 | **插件面板渲染与长列表回收** | 全线只有一处真窗口化：`ui-condition-matrix/matrix-logic.ts:523-553`，且 `panel-prefs.ts:41` 默认**关**。其余是死顶（`SearchPanel.tsx:68`、`ProblemPanel.tsx:38`、`CallHierarchyOverlay.tsx:50` = 300 行，真语料实测 2,870 命中 ⇒ 2,570 条点不到）或只增不还行的「显示更多」切片（`tree.ts:511` 80/160、`file-tree-filter-window.ts:20`、`panel-logic.ts:800`）。①矩阵窗口化本身对本 App 不成立：`MATRIX_ROW_H=22`（`:497`）硬编码不实测，与字号/缩放偏好冲突 ⇒ 滚动≠内容；`viewportH` 在空依赖 effect 里量（`index.ts:329-333`）、另一个空依赖 effect 每次 render `querySelector`（`:345-353`）、`onScroll→setScrollTop` 每个原生事件一次（`:321`）、`charas` 每次 render 重建+排序+~250 个 `<option>` 重建（`:467-491`）。②`ui-state-replay/index.ts:373-377` 每次 render 物化 `[...condIndex.byFunction.keys()]`（≈31,630 名）并对每键 substring 扫（`panel-logic.ts:131`），无 `useDeferredValue`（对照 `navigator-panel.ts:73` 有）；`renderReplayPreview` 每键重算 `groupUnknowns`+`summarizeAssumptions`（3,732 谓词，递归 `exprArgSlots`）。③`ui-snapshot-injector/injector-panel.ts:155` 每 render 调 `listVars`，`panel-logic.ts:128` 深拷贝**每个数组单元**，`:313-315` 每个 option 调两次 `scopeLabel`（各含 `archive.chars.find` + 两次 `charaLabel` 扫描）。**判据**：给出「1,000/3,000 行列表挂载 DOM 行数」与「每键面板计算耗时」改前→改后；新窗口化不得把行变成点不到（键盘可达 UI-4 焦点环不许退化）。 | `packages/plugins/ui-{condition-matrix,state-replay,snapshot-injector,kojo-navigator,archive-browser}/src/**` + 其 tests · 认领：ps7panel 2026-10-18 |
| PS-8 | **糖层热路径** | ①**词法器每行动态 `new RegExp`**：`kojo-sugar/src/lexer.ts:798 wordTail` 在 `:942-960` 每行调 6 次，另 `:845/864/892/994`、`stripCont:1580`（≤3/行）、`detectContInsideQuotes:1604`（3/行且无条件）、`parseLoopCountHead:875`、`parseStepStatement:975`；实测动态建+exec **0.57µs vs 预编译 0.016µs（36×）**，每糖行 9–12 次 ⇒ 模块级 `Map<string,RegExp>`（词名/标记都来自定表）或 `startsWith(word+' ')` 前置门。②**每次滚动重算全文**：`langsvc.ts:111-113 foldGeneratedLine` 在 `:150/:196` 循环内 split+sort 整篇产物，`sourceOf/sourceColumnOf`（`service.ts:531/542`）逐项 `find`；3,000 行产物实测 17µs/条 ⇒ 200 条 hint ≈5ms，而 Monaco **每次滚动**都请求 inlay ⇒ 每结果提一次 `lines`+有序表（WeakMap）。③`langsvc.ts:256-259 countLines` 为算尺寸分配整篇数组（`ui-sugar-lift/src/large-file.ts:63` 已有 O(1) 版本）。④`project.ts:308` 每次 `liftProject` 重编所有族头正则（`faces-reverse.ts:166`），`:247-262` 的 `Object.entries`+`new Set`+`sort` 在每个 MESSAGECHECK 体内行跑（`:502`），`liftProject` 共 8 趟全量 ⇒ 按 `faceTable` 身份 memo、把位集提进闭包。⑤`codegen.ts:633/640-670` autoIndex 白扫（实测占转译 11.9%）⇒ 表头正则缓存。**判据**：`hotpath-bench` / `sugar-autoidx.perf` 改前→改后；**产物与投影必须逐字节对拍**（语料 `sugar-projection.corpus` 覆盖率读数不许掉）。 | `packages/plugins/kojo-sugar/src/**` + 其 tests · 认领：ps8sugar 2026-10-18 |
| PS-9 | **存档回放/预览的每键成本与无界缓存** | ①**本批最大的无界每键成本**：选中归档时，`.kojo` 预览每次缓冲编辑（`ui-sugar-preview/src/index.ts:243 liveTick`）都走 `preview.ts:409` → `state-replay/engine.ts:133` → `sav-parser/engine.ts:190` **重解析整个 `.sav`**（10–40MB gunzip+逐单元）并顺序 `replayFunctions` 重放全部产物函数，全在主线程、`parse()` 零记忆化 ⇒ 按 `(path, mtimeMs, size)` memo。②`condition-extractor/src/snapshot.ts:167` 在保存时对 164,910 条依赖逐条 `JSON.stringify`（实测 123ms vs 拼接键 89ms），`:195` `dependencyKey` 再算一遍 ⇒ 模板键或身份 intern。③无界文本缓存：`condition-extractor/engine.ts:117-119` 与 `state-replay/engine.ts:109` 持整份正文/行数组，只在索引整体重建时清 ⇒ 任何走全 99,228 函数的面板把 144MB 文本第四次拉进常驻 ⇒ 照 `io.ts:313-317` 的 FIFO 上界。**判据**：真归档 + 5,000 行 `.kojo` 的「每键预览墙钟」改前→改后；归档失效判定必须与 PS-2 的 mtime+size 口径同源，**不许出现读脏归档**（改档后必须重解析）。 | `packages/plugins/{sav-parser,state-replay,condition-extractor,ui-sugar-preview}/src/**` + 其 tests · 认领：ps9replay 2026-10-18 |
| PS-10 | **引导图与激活：77% 入口块是欢迎页用不到的插件** | ①`bootstrap.ts:4-22` 静态 import 全部 19 个插件工厂 ⇒ 快开图 **283 文件 / 3,824 KB 源码**（插件 2,940 KB）全在 `boot.welcomeInteractive`（220.9ms）之前 parse+eval；`kernel/src/kernel.ts:193-196` 的 `registerPlugin()` 已支持启动后注册 ⇒ 核心插件 eager、其余进项目时 dynamic import。②**223 KB 教程文案在 `kernel.start()` 里被构建**（`eratw-adapter/src/plugin.ts:823-851` 用 `TUTORIALS.*` 调 `createTutorialOverlay`，字面量住 `tutorial-content.ts:913` + 3 份 `tutorial-reference-*`）⇒ 改懒组件或首次 `ui.tutorial.open` 才注册（性价比最高的一条）。③`App.tsx:302-316` 的 idle 预取拉 `ProjectView`，其静态依赖含 ~4MB monaco 块 ⇒ 首屏后 rIC/4s 在**主线程求值**整幅编辑器图，与「继续上次会话」快点争抢（字节搬了、eval 没省）⇒ 与首次指针交互对闸，或自动开项目时撤。④`vite.config.ts` 除 `target:'es2022'` 零构建旋钮：`reportCompressedSize:false`（5.5MB 的 gzip 纯烧构建循环）、`modulePreload`、无 `sideEffects:false`。**判据**：`node tools/boot-marks.mjs` 与 `smoke-tauri-dom.mjs` 两条硬断言（内联底色==挂载底色、可点前零 monaco 请求）必须仍真——**这条是本批的红线，预取改坏就假绿**；给出 `welcomeInteractive` 与入口块字节改前→改后。 | `packages/app/src/bootstrap.ts` · `packages/app/src/main.tsx` · `packages/app/src/ui/App.tsx` · `packages/app/vite.config.ts` · `packages/plugins/eratw-adapter/src/{plugin,tutorial*}.ts` + 相关 tests · 认领：ps10boot 2026-10-18 |

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
