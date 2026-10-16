# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## B. 本组任务（本组）

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| HK-4 | UI 打磨（常任；目标「专业 · 克制 · 流畅 · 高效 · 耐看」，VSCode 为基准） | 自拟六项按序推进：UI-1 字号尺度 ✅§5.121 / UI-2 圆角·边框·阴影 ✅§5.122 / **UI-3 图标 emoji→单色 SVG ✅**（`docs/log/2026-10-13-ui-icons.md`；宿主层渲染面归零；插件自绘面板符号＝跨包图标通道**已交付 ✅** `renderIcon` 桥，3299bd7） → **UI-4 焦点环与键盘可达 ✅**（roving tabindex 漫游 + `:focus-visible` 焦点环） → **UI-5 动效可关 ✅**（设置项 + `<html data-motion>`） → **UI-6 底部问题面板 ✅**（ERB 结构/表达式两层波浪线汇总、点击跳源行；状态栏 ✕/⚠/ℹ 计数经 `kojo.problems` 展开，Ctrl+Shift+M）；每项带可复跑量化判据 | 进行中 · 认领：hk4ui 2026-10-14 |
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
| MK-1 | **装完包之后「已安装」行不即时出现 ⇒ 卸载入口点不到**（真壳冒烟 `k` 项红；归口：市场线，非性能批）。现象：`node tools/smoke-tauri-market.mjs "<语料根>"`（带 `HTTPS_PROXY`）在 master `d2fd618` 上 **共 9 项 / FAIL 1**，k 项报 `卸载没走完：no-installed-row；卸载后目录还在；屏上那条还在`。复现：真装 `kojo-pack/demo.era-tw 1.0.1` → 盘上 2 条目逐字节 + sha256 + 记账容器核对码**全部对平、零残壳**（这些探针项都没报），随后探针在 60s 内等 `.panel-market .mk-list .mk-row` 里含「版本 1.0.1」的行 ⇒ 一直 `no-installed-row`；而**收尾时同一行又在了**。⇒ 装完那一刻「已装」面没刷新，过一会儿/再过一次数据才出现（要么缺一次 `installed()` 重取，要么取到但面板不重绘）。期望 vs 实际：期望「装成功后卸载入口即时可点（同一轮内）」；实际「要点一次刷新才有」。**PERF-10 已排除自身**：该批 `service.ts` 的 diff 只碰 `commitPack` 的批量读与那句校验锚文案（`readBytesMany` + 暂存区重读算哈希，语义未变），记账写入与 `installed()` 一行未动；`market_extract` 改 async 后解压照样落盘对平（就是上面那组对平读数）。旁证：市场批自己的编排判据写明「注入假桥……**不证明解压**」（`452b243`），k 项是第一次真解压真卸载跑通到哪一步的实测 ⇒ 这条红的价值在于**首次真链路暴露**，不是回归。**判据**：装成功后同一轮内卸载行即可点（不许靠再来一次刷新掩盖）；复跑口径就是这条 k 项，**不许把 60s 等待拉长或把 k 摘成 SKIP 凑绿** | 待认领（市场线） |
| CR-2 | **族归属 R2 在未知指纹盘上断言形状不成立**（`packages/plugins/kojo-sugar/tests/family-name-source-tier.corpus.test.ts`）。现象：屏上原样 `判表外逐族：[["FLAG",4],["NOWEX",3],["TEQUIP",1]]`，断言在未知指纹盘走 else 分支只允许 `[NOWEX×3, TEQUIP×1]`。复现：同前置跑该文件。期望 vs 实际：期望八张族里只有 NOWEX/TEQUIP 残余；实际本盘 `FLAG` 另有 **4 处判表外**。两条分岔要先判：①**真覆盖缺口**——本盘的 FLAG 名未被 `.als`/主表收录（`KC-1b` 位表展开刚落，名表覆盖面需复测），该补数据；②**断言过窄**——R2 对未知盘应改断不变量（NOWEX 动态索引残余 + `TEQUIP:震动棒` 真阳性必在，其余族数只作读数不参与判绿），而不是复用已知盘的逐族计数。**PERF-8 复跑证伪了一条岔路**（master dda9e75 后本条读数逐字不变：名表只读 153 份 .ERH、收录 5,755 名，FLAG 判表外仍是 4）⇒ 与「.ERB 正文误入名表」无关，两条分岔照旧待判。先判因再动手，**不许直接放宽成恒真** | 待认领（糖线 / ALS） |
| ENC-1 | **`packages/kernel/tests/encoding-roundtrip.test.ts` 口上钉值随盘漂：本盘 2,285 ≠ 钉 2,294**（`:166` `expect(kojoTotal).toBe(2294)`）。现象：挂语料跑全量时该文件红 `AssertionError: expected 2285 to be 2294`；同轮另两条＝`sugar-projection`（本表 CR-1）与 `marker-hotpath`（负载形，PITFALLS 72，单跑 7/7 绿）。复现：`KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)"` 今日解析＝`C:\game\eratw-画蛇添足版eratw4.980`（口上 2,285）。归因：钉值 2,294 按 `sub-modding 4.980-260326-SANYOUSEI` 盘校准（本表 §R 前言那批），**该盘今日不在位** ⇒ 与文件计数/转译语义无关，非中文欠账清扫批（`d27fd4f..e9edbde`）引入。**两条路待判，不许直接改钉值凑绿**：①钉值改按盘指纹取值、或改断不变量（`diffs==[]` 照旧 + 口上数落在已知两盘读数集合内）；②`tools/corpus.mjs` 判据把该盘列优先，并在 STATE 记明当前盘读数 | 待认领（语料基线口径） |


## S. 1016 真语料复测新发现（lead 报数；性能归口）

| ID | 任务（现象 / 已实测事实 / 判据） | 认领 |
|---|---|---|
| PERF-9 | **（本行已被组长自己纠正，口径见 STATE §二 性能行的 ⚠ 段）** 冷开「条件可用 / 校验有结果」稳态 **3.06–3.38s / 3.20–3.38s**（热轮 2.97 / 3.03s，**冷≈热**）——当晚那组 10.6 / 8.4s 是 `Condition index … 复用 0 / 重扫` 的**一次性快照重建**（PERF-8 换了 `inputDigest` 覆盖面，重算一次属正确行为），不是常态热点。⇒ 剩下的真问题只有一条：**保存一棵文件后的重抽/重校成本是否随盘涨**（旧 bug 时代会话缓存被整根预热，掩盖了这条；现在缓存规模回归正常后必须重新量）。判据：①「改 1 棵 vs 全量重算」的比值读数（现在没有这条数）；②改一棵不得触发全盘重扫（`watcher` 已有目录事件，`kernel.compute` 有时间片与 `runLatest` 背压可复用）；③**语料只读 ⇒ 这条量测必须用可写量例盘**（常驻可写根下的副本，或 `tools/` 合成盘），不许打写语料的主意；④不许靠放宽 `boot-watermarks` 等待上限或缩盘凑绿。复跑：`node tools/boot-watermarks.mjs`（机器空闲；PITFALLS 74 两条探针自害务必照做） | 待认领（性能线，优先级已从「头号」下调） |
| PERF-10b | **只剩 PERF-10 的 ④**（①②③ 已交付，回执与读数在 master `bf48873` 的提交信息里）：`packages/plugins/kojo-market/src/service.ts` 的 `readIndexState` 一次 `refreshIndex` 里最多被叫 5 次（每次 `exists`+`readText`+`JSON.parse`+查重），`installed()` 对每条已装记录单独 `await io.exists(...)`（该用现成批量 `statFiles`）。个位数往返、量级小，安全相关的 ①②③ 不与之夹带。判据：一次刷新的 `readIndexState` 调用数与已装记录 `exists` 趟数各给前后读数；**别把它做成缓存**——`readIndexState` 同时是失效判据的来源，要动就只合并「同一刷新周期内」的重复读，并写清什么情况下会读到旧值。 | 待认领（性能线，低优先） |
| PERF-11 | **糖转译里新增的无条件全文扫（归口：糖线 / kojo-sugar）** `packages/plugins/kojo-sugar/src/codegen.ts:348` 在每次转译**无条件**先跑 `buildAutoIndexPools:628-658`：对 47 张面过滤后，每个 autoFace 再遍历整个 `topLevel`，raw 块逐行 `headerRe.exec(line.trim())`（640-645），而该正则由模板现推、含 `.*`（`faceHeaderRegex:598-626`）**每次转译新建**；同码另有第二遍同形全文扫 `collectOccupiedCustomIndices:1230-1248`。触发频率：`.kojo` 的转译**就是装饰器本体**（`ui-sugar-editor/src/index.ts:97`，该 kind 不在 worker 表 ⇒ 主线程就地跑，`marker-pool.ts:210`），兜底是 250ms 防抖 + `runLatest` 尾缘合并 + 同版本缓存（`EditorPane.tsx:105,542`、`marker-pool.ts:233`）⇒ 实为「每停手一次」，**且与本文件有没有省略编号无关**。判定：**先量再动**——读 `__kojoPerf` 的 `markers.decorate:sugar-diagnostics` p95（喂一份带大 `erb` 围栏的 `.kojo`，打字停手数轮），或复跑 `packages/app/tests/marker-hotpath.test.ts`。若确属热点：①先判本文件是否真含省略编号再决定建不建池；②`faceHeaderRegex` 提到模块期一次构建；③与该 kind 是否该进 worker 表一并判（注意字典/时机表是项目态，硬搬会造假错——见 STATE §二 交互行的既有取舍）。<br>**同批顺带两条小账（不单独立项）**：教程行内解析在 render 体内零 memo（`eratw-adapter/src/tutorial-overlay.ts:46-47,90-92` → `tutorial-inline.ts:35-56` 逐字符 `text += ch`；两段正文 ≈2 万字符 / 220 段标记每次渲染全扫）——被「渲染稀少」兜住（滚动纯 CSS、脏位同值不重渲染 `App.tsx:100-106`），加一层 `useMemo` 即永久归零；家族头中文别名 4→23 与计数器 84 条值域表都已是装载期建表、查表 O(1)（`variable-schema.ts:689/698`、`counter-table.ts:146-157`，实例只造一次 ⇒ 不打穿 `kojo-sugar/src/index.ts:207-216 sameView` 代际判据），**无性能问题**，唯一小账是反向命中每次 `toUpperCase()` 分配。 | 待认领（糖线；组长已给复跑口径） |
