# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## B. 本组任务（本组）

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| HK-28 | **真机两闸在默认机器状态下恒红：`smoke-tauri-ipc` 的 b1（打字→解锁弹窗）与 `ui-measure` 的 `04-打开ERB…` 之后**（UX 批落地时撞上；归 tools / 本组） | **不是本批引入**——三态 A/B 同红：`origin/master`、UX-1 树、UX-2 树各跑 `node tools/smoke-tauri-ipc.mjs`，同为 `waitFor timeout: !!document.querySelector('.modal')`，而 a / a2 / b0 三项照旧（a2 SKIP＝「该目录已有批准记录」）。**疑因**：本机 `store/_global/approved-writable.json` 已含该语料目录 ⇒ 探针「轴二解锁」前置的只读态可能早已不成立；或合成按键 `Input.dispatchKeyEvent` 在当前 WebView 下不再产生 Monaco 的 `onDidAttemptReadOnlyEdit`。**`ui-measure` 侧**：前 7 个状态量得且全绿（对比度 **0 条/状态**、字号 3–5 档、圆角 2–5 档、小目标 1–4），到 `04-打开ERB的.kojo预览` 起 `Runtime.evaluate` 25s 超时，重跑两次同点，而页面 `1+1` 可评 ⇒ 不是死锁，疑为开大 ERB 时的级联（STATE §二：索引 2.9s / 条件 26.3s / 校验 21.0s）占满主线程。**判据**：两闸各给出**可复跑的绿态配方**（例如探针前先清 `approved-writable` / 用 `--corpus` 指未批准目录；`ui-measure` 等级联水位归零再量或放宽那条 evaluate 上限），并把「红是环境还是代码」变成一眼可分的读数；**只改工具，不改产品语义，不为凑绿放宽判据** | 待认领 |
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

## I. 首屏白屏优化线（L1，2026-10-14 立项；根因已定位到代码行，**但至今无一个读数**）

> **白屏定性**（用户 2026-10-14 确认时机＝「窗口刚出现就全白」，非开项目级联）：三段成本串成一队且**前面没有任何像素**——
> ①`packages/app/index.html` 只有空 `#root`、无内联样式（dev 下 `styles.css` 由 JS 注入，`main.tsx:4`），而主题底色是深色 `--bg: #1e2227`（`styles.css:2`）⇒ 空窗期是 **WebView 默认白**；
> ②静态 import 链 `App.tsx:10 → ProjectView.tsx:6 → EditorPane.tsx:15 import * as monaco from 'monaco-editor'`，**全仓零 `React.lazy`** ⇒ 0.57 根入口（`esm/vs/index.js`＝84 门语言 + 4 门重型 feature + lsp client + 全部 contrib）进首屏关键路径，入口块实测 **4.6 MB**；
> ③`bootstrapKernel()` 一次性 `kernel.start()` 激活 **17 个插件** + `project.recent()` IPC 之后才 `setPhase('welcome')`，而「内核装配中…」这句本身也要等 React 挂载才画得出。
> **保留面依据**＝§D「文件类型保留面（用户 2026-10-14 拍板）」四档 A/B/C/D。**顺序定死：L1-0 → L1-A → L1-B**，L1-C 视 L1-0 读数决定做不做。

| ID | 任务 | 关键判据 / 已实测事实 | 认领 |
|---|---|---|---|
| L1-0 | **先取基线数（本线一切改动的分母，没数不许动手）** | **现状没有任何读数**——"白屏几秒"是体感，违反本仓「任何改好了必须带数」。**要量的四段**：`htmlParsed`（引导层可见）/ `firstPaint` / `bootInteractive`（欢迎页可点）/ `editorInteractive`（进项目后编辑器可输入）。**接法**：现成探针 `packages/app/src/perf.ts`（`perf.install()` / `perf.record()`，`bootstrap.ts` 已在用）补这四个标记，**不另起一套度量**；`tools/verify.mjs` 的 `dom` 条目加两条硬断言——①开机 ≤500 ms 内 `#root` 非空**或** `getComputedStyle(body).backgroundColor` 已是深色 ②欢迎页阶段网络请求里**不得出现 monaco**。**dev 与 build 各测一组**（`node tools/smoke-tauri-dom.mjs` 形态）。**⚠ 一条容易算错的账**：`ts.worker` 6.8 MB / `css.worker` 1.1 MB 等是 `?worker` **独立 chunk，躺在 `dist/assets` ≠ 开机加载**；先分清"入口块 4.6 MB"与"worker 总量"谁进首屏，否则会出现"瘦了 6.8 MB 白屏没变"的假结论。 | 认领：lead 2026-10-16（⇒ §P PERF-1） |
| L1-A | **引导层 + 首屏分割（白屏归零，低风险先做）** | **A1 内联引导层**：`index.html` 内联 `<style>` 写底色 + `.boot-splash`（品牌字 + 骨架），React 挂载后被 `#root` 内容替换。判据：**内联底色必须等于 `styles.css` 的 `--bg` 现值**，且由 L1-0 的断言①钉住「内联底色 == 挂载后计算底色」——否则内联那份就是第二真相源，迟早漂移。**A2 代码分割**：`ProjectView` 改 `React.lazy` + `Suspense`（fallback 用现成骨架）。可达性已核：Monaco 只经 `EditorPane` 与 `monaco/{erb,kojo}-language.ts`、`sugar-render.ts` 进入，而这些**只有 `ProjectView` 一条路**（`ProjectView.tsx:6`）⇒ lazy 边界干净、不会漏拽。**验收**：`htmlParsed`→`firstPaint` 白屏段 ≈0；`bootInteractive` 显著下降；欢迎页零 monaco 请求。**已决不做并记由**：`tauri.conf.json` 加 `visible:false` + 就绪 `show()`——做了 A1 后收益趋零，而它引入"前端崩在挂载前 ⇒ 窗口永远不显示"的新失效模式，违铁律 4「内核不静默」；**若将来一定要用，必须配无条件超时兜底**。 | 认领：lead 2026-10-16（⇒ §P PERF-1） |
| L1-B | **Monaco 自装配瘦身（按 §D 四档定稿执行）** | **不能简单换成 `editor.api`**（本行第一判据）：实测 `esm/vs/editor/editor.api.js` **只有 API 面、不含 contrib**，而补全弹窗（`contrib/suggest/browser/suggestController`）、💡 代码操作（`contrib/codeAction/browser/codeActionContributions`）、查找（`contrib/find/browser/findController`）、`editor.tokenize` 的实现（`contrib/tokenization`）全在 `editor.main.js` 的 contrib 段；0.57 的 `esm/vs/editor/` 下**只有** `editor.api.js` / `editor.main.js` / 两个 worker，**没有"要贡献不要语言"的现成入口** ⇒ 必须自装配。**接法**：新建 `packages/app/src/monaco/entry.ts`，逐条 import `editor.main.js` 的非语言 import 段（contrib + `codeEditorWidget` + `coreCommands`）+ `export * from 'monaco-editor/editor/editor.api'`；**不引** `languages/definitions/**`、`languages/features/**`、`external/monaco-lsp-client`；`EditorPane.tsx` 与 `monaco/*.ts` 全部改从 `entry.ts` 取（**单一装配点，禁第二份**）；worker 只留 `editor.worker`。**保留面照 §D**：A 档 `markdown`/`ini`/`xml` 三门轻量 definition 保留、B 档四门 feature 全砍且 `.json` 改自写微型 Monarch、C 档其余 ~79 门砍。**⚠ 交付判据必须是功能级不是体积级**（体积绿证明不了功能在）：逐条实机/CDP 断言——补全弹窗真弹、💡 真出、查找替换、撤销重做、括号匹配、行注释、粘滞滚动、**Unicode 高亮**（与「全角标点误用检测」直接相关，砍错即自毁功能）、marker 波浪线、折叠、主题、`editor.tokenize`。**⚠ 手抄清单会漂**：`entry.ts` 头注写明「清单抄自 monaco-editor 0.57 `editor.main.js` 的非语言 import 段」，并把 `monaco-editor` 从 `^0.57.0` 收成**精确钉版**。**顺带**：`vite.config.ts` 的 `chunkSizeWarningLimit: 4096` 恢复默认——那个数量级是"把告警调到能吞下问题"的形状，留着等于取消守门人。**与 FT-2 的关系**：`monaco/erb-language.ts` 是两线共同热点 ⇒ **串行认领、后到 rebase**，勿并发改同一文件。 | 认领：lead 2026-10-16（⇒ §P PERF-3） |
| L1-C | **插件激活错峰（视 L1-0 读数再决定做不做；属内核生命周期语义变更）** | **动机读数**：`bootstrap.ts` 现在一次性 `kernel.start()` 激活 **17 个插件**才进 welcome，而欢迎页实际只需要 `kernel.*` + `project.recent()`。**⚠ 前置**：只有 L1-0 量出 `bootInteractive` 的大头确实落在 `kernel.start()` 段才做；**若 A1+A2 已把白屏归零，本行大概率不该做**（别为已消失的成本改生命周期）。**要做必须同时满足**：①错峰期间每个插件在状态面板如实显示 `pending`（铁律 4：inactive 必须可见，不许静默延后）；②`installPerfProbe`/`cascade-watermarks` 的三个级联水位依赖 `condition.extractor` / `convention.linter` 的 `subscribe` 已在位 ⇒ 接线要重排且不产生假水位；③`audit:decoupling` 与双 typecheck 全绿。**判据**：`bootInteractive` 前后对比 + 级联三水位不回退。**跨线**：动 `kernel/src/runtime.ts` 属内核面，开工前 `git log --oneline -- packages/kernel/src` 看最近一批口径。 | 待认领（**先评审后开工**） |

## P. 性能攻坚批（lead 2026-10-16 统一认领；两波多 agent 并行；交付删行、回执进提交信息）

> 依据＝lead 本机实测（2026-10-16，`90d69d0` 基线）：dev 首屏 15.1s（白屏段 5.7s＝monaco 模块瀑布）/ release 2.4s；入口块 4,995 kB 中 monaco 占 4,487 kB（92%）；开项目级联读盘 ~9,000 次单文件 IPC（2 次/文件）为 P1 最大头。
> **L1-C 不做**（实测内核装配仅 ~0.2–0.5s，A1+A2 后无剩余成本可省）；**增量索引**归设计级后置（与 extract/lint 增量为一体，单开必造"保存→全量级联"）。

| ID | 批次 | 工作树 / 分支 | 状态 |
|---|---|---|---|
| PERF-1 | 首屏：L1-0 探针四标记 + verify 断言 + 内联引导层 + ProjectView lazy + idle 预取（承接 §I L1-0/L1-A） | kojo-boot / b/lead/1016-boot | 认领：lead 2026-10-16 |
| PERF-2 | P1 级联：批量读 IPC（Rust 二进制帧批量命令）+ 会话级文本缓存 + refs 重复读消除 + 抽取/校验共读一次 | kojo-io / b/lead/1016-batch-io | 认领：lead 2026-10-16 |
| PERF-3 | Monaco 自装配瘦身（§I L1-B 全量 + chunk 告警恢复 + 功能级验收） | kojo-monaco / b/lead/1016-monaco-slim | 认领：lead 2026-10-16 |
| PERF-4 | 装饰器池化（interactive 档）+ (path,versionId) 缓存 + 切文件减负 | kojo-hot / b/lead/1016-hotpath | 认领：lead 2026-10-16 |
| PERF-5 | 糖线：转译器/结果共享缓存 + 补全静态表 + 保存链单次转译 | kojo-sugar / b/lead/1016-sugar-cache | 认领：lead 2026-10-16 |
| PERF-6 | 树与面板：函数树 deferred+增量渲染 + 文件树即时化 + PanelBody memo | kojo-ui / b/lead/1016-ui-panels | 认领：lead 2026-10-16 |
| PERF-7 | 快照热载瘦身：size 判据 + 懒还原 + 交替开项目核实 | kojo-snap / b/lead/1016-snapshot | 认领：lead 2026-10-16 |
