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
| P-1R | **段级吸收残余：K101 的三类混杂形态**（E13/P-1 交付后剩下的墙；归 `kojo-sugar` 线。P-1 已入 ⇒ **P-3「初回段」的硬前置解除**，`段 首次：` 可直接开工） | **复现根**（读数必须连根一起报，改版同名文件内容不等价）：`C:\game\eratw-画蛇添足版eratw4.980\ERB\口上・メッセージ関連\個人口上\101 Tokiko [朱鷺子]\朱鷺子\M_KOJO_K101_絶頂 .ERB :: @M_KOJO_MESSAGE_PALAMCNG_B_K101`（函数起于语料 **13 行**）。**harness**＝照抄投影 → 转译的 error 条数：A（origin/master）**200 / 0 段头** → B（E13 批后）**191 / 3 段头**（190 `indent-mismatch` + 1 `section-mixed`）。**三面残余**（行号皆该根语料原行）：① **缩进层子段 + `LOCAL:1` 命名槽**——第 4 个 0 列信封是 `LOCAL = 1`(44) + `IF LOCAL`(46) 的**纯信封**，其内**缩进 1 层**再套 4 个 `LOCAL:1 = 1` + `IF NOWEX:<名>`（**50/52、64/66、102、167**）；现判据只认「0 列 + 精确 `LOCAL = n`」⇒ 一条不折，而 `LOCAL:1` 这种**槽位写法糖里根本没有形态**（G1 的另一半）。② **`IF/ELSEIF` 分叉链头**（**237/239、250/252** 一类）——裸条件链头当段折掉后 `ELSEIF` 失去块头 ⇒ `indent-mismatch` 成串；本批实测过「死开关裸条件」放宽 + 链护栏 = **197 / 1 段头**（护栏连合法折叠一起挡），**净负已回退，别再走同一条 route**。③ **段与普通正文同顶层 ⇒ `section-mixed`**——3 段折完，未折的第 4 段正文仍是普通语句落在同一个「时机」顶层，报 `section-mixed` @语料 **13**（就是 B 态 191 里唯一非 indent 的那条）。**附带陷阱**：`C:\game\eratw魔王改版` 同名文件 26 行是 `LOCAL = 1 ;custom code`（4.980 该处是 `LOCAL = 0`，已折成 `段 … 关：`）——行尾注释让精确匹配落空，**并且连带**把下一段（35 行）的 `funcHeadAbove` 打断 ⇒ 该根上 3 段只折 1 段（200 → 197）；「行尾注释的容限」与「要不要放开缩进层」是 ① 的第一道判断题。**判据**：每面按 `packages/plugins/kojo-sugar/tests/section-block.test.ts` 的闭环口径（投影 → 转译零 error）钉测试 + 负自证；全量不回退 + 双 typecheck + `audit:decoupling` ✅ | 待认领 |


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
| ZH-P | **投影集成 + RETURN 行归零**：`project.ts` 的 `native()` 全部接 `localizeNativeLine`，认不出走显式兜底；函数尾 / 包装三联里的 `RETURN …` **永不上屏** | 只准动 `project.ts`（+ 其测试）；红线判据＝本文件产出的糖文本零整行原样 ERB；`RETURN` 吸收判据从「紧随 ENDIF」扩到「函数体内任何单独成行的 RETURN」，吸收 = 只读视图不显示，磁盘一字不动；既有闭环测试（投影→转译零 error）不许回退 | 认领：zhpp 2026-10-17 |
| ZH-L | **编辑器可见面**：高亮/补全/悬停认得上述所有中文形；`kojo-language.ts` 停止重抄 `CONT_MARKS`/`NOTIN_MARKS`（改 import 词表真源，`~`/`⏎` 必须着色）；糖视图里 `.ERB` 记号着色分级，让「残留英文」一眼可辨 | 只准动 `packages/app/src/monaco/*` + `packages/app/tests/*`；词表单一真源，宿主零硬编码中文词形；Monaco 功能级判据（补全真弹 / 高亮真出）不许只给体积读数 | 认领：zhl 2026-10-17 |
