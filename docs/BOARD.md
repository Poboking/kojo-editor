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
| MK-1 | **市场面板的「已装」态刷新明显滞后于盘上真相**（真壳 k 项读数；归口：市场线。原报文本写得比真相重，已随探针修好一并纠正）。<br>实测（master `708f79d`，真出网真解压，同轮三次复跑）：装成功后「已装」行出现 = **537 / 1178 / 1209ms**；点卸载并确认后 **落点目录消失 = 498ms**（盘上一句话就干净了），而**屏上那一行消失 = 3710ms**。⇒ 不是「装不上 / 卸不掉」（逐字节 + sha256 + 记账核对码全对平、暂存区零残壳、目录与行最终都消失），而是**面板刷新慢一拍**：卸载后作者会看见一条「已经不存在却还挂着」的行 3.7 秒——正是要不要接即时重取的那个决定。<br>复现：`HTTPS_PROXY=http://127.0.0.1:7890 node tools/smoke-tauri-market.mjs "<语料根>"`（k 项现在**每次把三个毫秒数打进读数**）。<br>**探针侧的教训一并记在这里**（组长自己踩的，两条都是 `tools/smoke-tauri-market.mjs` 已修的形态）：①`waitFor` 认「表达式返回真值」为就绪，而探针就绪前返回字符串 `no-installed-row`——**字符串是真值** ⇒ 第一次就"等到"，60s 等待形同虚设，把「滞后 1.2s」读成「永远不出现」；②卸载后固定 `sleep(800)` 一次性判读，把「慢一点」读成「没做完」。⇒ 判「有没有出现/消失」一律用**带耗时的轮询**，别让布尔型 waitFor 去接一个返回字符串的表达式。<br>判据：卸载确认后行消失 ≤ 目录消失 +300ms（同一轮内）；**不许把 k 摘成 SKIP，也不许靠拉长等待把滞后掩盖掉**——数字每次都要上读数。 | 待认领（市场线） |
| CR-2 | **族归属 R2 在未知指纹盘上断言形状不成立**（`packages/plugins/kojo-sugar/tests/family-name-source-tier.corpus.test.ts`）。现象：屏上原样 `判表外逐族：[["FLAG",4],["NOWEX",3],["TEQUIP",1]]`，断言在未知指纹盘走 else 分支只允许 `[NOWEX×3, TEQUIP×1]`。复现：同前置跑该文件。期望 vs 实际：期望八张族里只有 NOWEX/TEQUIP 残余；实际本盘 `FLAG` 另有 **4 处判表外**。两条分岔要先判：①**真覆盖缺口**——本盘的 FLAG 名未被 `.als`/主表收录（`KC-1b` 位表展开刚落，名表覆盖面需复测），该补数据；②**断言过窄**——R2 对未知盘应改断不变量（NOWEX 动态索引残余 + `TEQUIP:震动棒` 真阳性必在，其余族数只作读数不参与判绿），而不是复用已知盘的逐族计数。**PERF-8 复跑证伪了一条岔路**（master dda9e75 后本条读数逐字不变：名表只读 153 份 .ERH、收录 5,755 名，FLAG 判表外仍是 4）⇒ 与「.ERB 正文误入名表」无关，两条分岔照旧待判。先判因再动手，**不许直接放宽成恒真** | 待认领（糖线 / ALS） |
| ENC-1 | **`packages/kernel/tests/encoding-roundtrip.test.ts` 口上钉值随盘漂：本盘 2,285 ≠ 钉 2,294**（`:166` `expect(kojoTotal).toBe(2294)`）。现象：挂语料跑全量时该文件红 `AssertionError: expected 2285 to be 2294`；同轮另两条＝`sugar-projection`（本表 CR-1）与 `marker-hotpath`（负载形，PITFALLS 72，单跑 7/7 绿）。复现：`KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)"` 今日解析＝`C:\game\eratw-画蛇添足版eratw4.980`（口上 2,285）。归因：钉值 2,294 按 `sub-modding 4.980-260326-SANYOUSEI` 盘校准（本表 §R 前言那批），**该盘今日不在位** ⇒ 与文件计数/转译语义无关，非中文欠账清扫批（`d27fd4f..e9edbde`）引入。**两条路待判，不许直接改钉值凑绿**：①钉值改按盘指纹取值、或改断不变量（`diffs==[]` 照旧 + 口上数落在已知两盘读数集合内）；②`tools/corpus.mjs` 判据把该盘列优先，并在 STATE 记明当前盘读数 | 待认领（语料基线口径） |
| CO-1 | **挂语料轮功能池 7 条超时形红（三文件，判据根本没走到）**（CI-1 分池批复测时所见；归口：adapter 名表线 / 糖投影线 / 结构闸线各一条）。屏上原样：`Error: Test timed out in 20000ms.` ×5（`packages/plugins/eratw-adapter/tests/variable-schema.erh.corpus.test.ts`「真实语料 .ERH 作者自定名表：盘上自证」五条）与 `Error: Test timed out in 180000ms.` ×2（`packages/kernel/tests/sugar-projection.corpus.test.ts`「真实工程全量：行覆盖率 + 分段不变量 + 分因读数」、`packages/plugins/erb-parser/tests/structure.corpus.test.ts`「全量语料零误报（且判据确实在工作）」）。复现：本表前置 + `KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" pnpm test:unit`（本机 8 核满载轮）。期望 vs 实际：期望三条文件跑完并给出历史同口径读数（名表 5/5 绿、台词行覆盖 99.2%、3,971 文件零误报）；实际全部死在超时线上 ⇒ 这三组读数本轮**空缺**。归因线索：CI-1 把 20 个墙钟文件挪出并行池之后**仍超时** ⇒ 不是同池饿死，是挂语料轮的盘 IO 挤兑；`a3e7532` 只给清理钩子补 60s、`it` 本体没 timeout（同族 `kojo-market/commit-pack-ipc` 20s 本体超时见 STATE §一）。正解＝给这三条 `it` 末参补显式 timeout（或按盘分批 / 降规模），**不许放宽判据**；CI 不受影响（CI 无盘 ⇒ 语料用例整批 skip） | 待认领（三线各一） |


## S. 1016 真语料复测新发现（lead 报数；性能归口）

| ID | 任务（现象 / 已实测事实 / 判据） | 认领 |
|---|---|---|
| PERF-12 | **派生快照未命中的那一次，才是「进项目还要十几秒」的剩余头号成本**（归口：性能 / erb-parser + convention-lint + condition-extractor；由 PERF-9 规模读数与真壳两态实测合出来，不是猜）。已实测的两块：①未命中轮 `read+parse 6,889ms` + `refs scan 7,388ms（rescan 2,325）`——快照没捡到就整棵重读重扫，命中轮这两项是 **0ms / 0ms（rescan 0）**；②「改一棵」的重扫**不随盘收敛**：比值 0.315→0.289、斜率 ≈0.91 ⇒ 每棵约 **1.2ms 的 O(N) 固定税**，其中**校验段唯一破 1**（1.540→1.809），机理线索＝跨文件规则 **0/7 复用**（整包重算）。⇒ 动作顺序：先做「受控作废」把①复现成可复跑用例（现在归因未定：`SNAPSHOT_VERSION` 仍是 5、语料 mtime 未变、市场冒烟不碰快照），再切校验段跨文件规则的复用面；`walk 233ms · snapshot get 471ms` 这类地板暂不动。**判据**：①作废后首开的 `read+parse` 与 `refs scan` 各给出「按 mtime/size 分段复用」后的新数（目标 ≤ 命中轮 ×3；现状是从 0ms 涨到 6.9s / 7.4s）；②「改一棵 ÷ 全量」比值随盘**下降**而不是持平；③跨文件规则复用数 >0 且给出正确性等价证据（同输入同输出，**不许**靠跳过规则省时间）；④**不许**缩盘、不许放宽 `boot-watermarks` 等待上限、不许把计时断言改成恒真。复跑：`node tools/boot-watermarks.mjs`（空闲机两态各一轮）＋ `KOJO_PERF_HEAVY=1` 量例盘 | 认领：本机 2026-10-16，组长拆两线并行下发——**12a** 快照段（`b/perf12a/1016-snapshot-reuse`，独占真壳）／**12b** 校验段跨文件规则复用（`b/perf12b/1016-lint-reuse`，禁起壳）；组长集中落地。**12a 已落地 `eeeb631`**（快照段逐条目 salvage，判据①③④达成、②部分达成：真·冷与 v6→v7 换代面无溯源位数据、×3 字面不可达；读数见 STATE §二）；**12b 在办**（校验段跨文件规则 0/7 复用） |

## T. 数据安全批遗留（lead 2026-10-16 收口时记录）

| ID | 任务（现象 / 复现 / 期望 vs 实际） | 认领 |
|---|---|---|

## U. safe2 落地对照新发现（lead 2026-10-16）

| ID | 任务（现象 / 复现 / 期望 vs 实际） | 认领 |
|---|---|---|
| LS-KB1 | **`workspace-symbols` 计时池红：LS-R8 键位注册表重构后断言形态失配**（`packages/app/tests/workspace-symbols.test.ts`「命令注册表里有 `workbench.workspaceSymbols` 且绑 `ctrl+t`」）。现象：断言源码含 `keybinding: 'ctrl+t' 字面量，LS-R8（`d13db29` 集中键位注册表）改了注册形态 ⇒ 逐字复现于纯基线游离检出对照（与 safe2 批无关）。期望＝断言对齐新注册表真源（读 LS-R8 后的注册结构改判据，不许删断言凑绿）；实际＝恒红。归口：LS/键位线 | 待认领 |
