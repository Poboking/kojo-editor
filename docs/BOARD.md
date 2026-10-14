# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## B. 本组任务（haruki 线）

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| HK-4 | UI 打磨（常任；目标「专业 · 克制 · 流畅 · 高效 · 耐看」，VSCode 为基准） | 自拟六项按序推进：UI-1 字号尺度 ✅§5.121 / UI-2 圆角·边框·阴影 ✅§5.122 / **UI-3 图标 emoji→单色 SVG ✅**（`docs/log/2026-10-13-ui-icons.md`；宿主层渲染面归零；插件自绘面板符号＝跨包图标通道**已交付 ✅** `renderIcon` 桥，3299bd7） → **UI-4 焦点环与键盘可达 ✅**（roving tabindex 漫游 + `:focus-visible` 焦点环） → **UI-5 动效可关 ✅**（设置项 + `<html data-motion>`） → **UI-6 底部问题面板 ✅**（ERB 结构/表达式两层波浪线汇总、点击跳源行；状态栏 ✕/⚠/ℹ 计数经 `kojo.problems` 展开，Ctrl+Shift+M）；每项带可复跑量化判据 | 进行中 · 认领：hk4ui 2026-10-14 |
| SV-1 | **糖视图 · 原生显示**（新方向：升糖语法**就地**写进编辑器原生显示、替代原 ERB 代码块；只读、不落盘、不改原文件、不上虚拟 model、不加 `lineMap`） | **病根（反馈 #4 已定性）**：现效果＝ViewZone `<pre>` 贴覆，字号 `12.5px`／行高 `1.6`／`padding-left:12px` **硬编码**，而编辑器本体 `fontSize:14`＋`wordWrap:'on'`＋行号槽 ⇒ **必然不对齐**。**方向**：糖行按**编辑器实测**字体／字号／行高／内容左边距（对齐行号槽后文本列）渲染，与相邻代码行严格同 rhythm；糖覆盖的行**就地替代**其原 ERB（`setHiddenAreas`），展开即还原。**不动**：`sugarViewAllowed` 门与 `sealed.ts` 封存默认语义、`kojo-sugar`/`eratw-adapter` 投影语义。**判据**：全量不回退 + 双 typecheck + `audit:decoupling` ✅；真机半边待用户目视（对齐／换行／长段不裁） | 进行中 · 认领：haruki 2026-10-14 |
| HK-19 | **回放未知率 · `pseudo` 桶归因与拆分**（1,886 = 未知的 50.4%） | **先量后改**：`pseudo` 的 message 已含变量名 ⇒ 先出逐名直方图，实测 `CHARANUM`/`RAND`/`__LINE__`/`__INT_MAX__` 各占多少（**归因前不动手**）。再按四档落地：①**回放上下文可得**——`__FILE__`/`__FUNCTION__`/`__LINE__`（谓词原文与来源行就在 `PredicateReplay` 里）、`__INT_MAX__`/`__INT_MIN__`（常量）、`CHARANUM`（= 快照角色块数）；②**快照本可读、现被误分类**——`MONEYLABEL`（字符串全局）、`LASTLOAD_*`，应走 `readTopVar`；③**RAND 经 RANDDATA 复现**——快照已带 RANDDATA 625 格，RAND 依 `Config.CompatiRAND`（`var-model.ts:125`），**单独批次、深水区**；④真·运行期量（`LINECOUNT`/`ISTIMEOUT`/`WINDOW_TITLE`/`DRAWLINESTR`/`EMUERA_VERSION`）判不可约 → 归 HK-23 口径。**顺带核**：`RESULT`/`COUNT` 同时在 `LANGUAGE_LOCAL` 与 `GLOBAL_INT_1D`，而 `read()`（`state-view.ts:131`）先判 language-local ⇒ 裸引用被误判 unknown（改次序前先核 CALL 覆写语义）。判据：全量不回退 ＋ `unknown/predTotal` 与 BASELINES §6 逐项分解**同步收紧并钉死**（现守门 `integration-plugins.test.ts:368` 仅 `<0.4`，注释记 62.9→48.5→32.0） | 待认领 |
| HK-20 | **回放未知率 · `call-context`**（858 = 22.9%） | 入口回放未注入 `ReplayCallContext`（契约 `plugin-api/src/replay.ts:162-173` 已支持 `ints`/`strs`）。**名编码实参**：口上函数名内嵌指令号（`…_K49_88_1` ⇒ ARG 槽 0 = 88，E13 已踩）——**游戏知识 ⇒ 必须落 eratw-adapter**，对内核只出 **additive** 呼叫上下文提示契约（§六 分工纪律）。可复用既有「签名槽 vs 路由转发」实测（`call-slot-coverage.corpus.test.ts`，25,398 函数名）。真·场景输入（约会对象编号）推断不了 ⇒ UI 手输 ARG（计数不降、体验等价）。判据：`call-context` 计数下降 ＋ 全量不回退 ＋ 双 typecheck | 待认领 |
| HK-21 | **回放未知率 · `call` 内联扩面**（368 = 9.8%） | 对主流「`LOCAL` 信封 ＋ 委托 `_1`」**纯转发形态**做**浅内联**（现有有界内联为 v0.2 第七批，`evaluate.ts:80-92`；残余 368 = 索引域外/不可内联）。与 E13/P-1 同族知识 ⇒ **跨线沟通后动**。判据：`call` 计数下降 | 待认领 |
| HK-22 | **回放未知率 · `local-no-write` / `missing-var` 补面**（196 ＋ 80） | `local-no-write`＝`assignments` 未覆盖的赋值形态（分支内赋值 / `ARG`→`LOCAL` 转发 / 循环内赋值）⇒ 扩抽取面；`missing-var` 补 `variableSchema` / 引擎变量清单（注意 `JVEL`/`Juel` 笔误线索，**别在 ALS 批顺手改**）。判据：两项计数下降 ＋ 全量不回退 | 待认领 |
| HK-23 | **回放未知率 · 口径拆分（架构层，小）** | 把**真随机**（RAND 类，不可约）与**能力缺口**（可补）拆成两个读数：`可判定率`（排除真随机）＋ `能力覆盖率`；ARCHITECTURE §5.3「unknown 是能力边界的诚实呈现」的自然延伸。判据：STATE/BASELINES 各记两数，且保留历史水位可比（62.9→48.5→32.0） | 待认领 |

> **关联**（勿重复认领）：`named-index` 337（未知的 9.0%）已由 **ALS** 行承载（v34hand 2026-10-14 认领）——回放线不再单独立项。
## D. 已拍板（用户 2026-10-13 反馈批）

- **糖视图**：**不走虚拟文档**（原三问废止）；封存现效果（设置页「显示已封存功能」总开关可临时恢复）；新方向＝「升糖语法直接写进编辑器原生显示、替代原 ERB 代码块」（不保存 / 不改原文件）——**已立项＝§B SV-1**。

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
| FT-1 | **`.ERH` 未进变量字典 ⇒ 作者自定义具名查无**（接 `5f23e6b` ALS 批**点名未治**的残余；归 `eratw-adapter` 线） | **出处原句**：ALS 批交付信息点名「`CFLAG`(576)/`TCVAR`(68)/`ABL`(5) = 作者自定义名（住在角色目录/各自 `#DIM`），**要治得加「每角色自定名表」这路数据源**」——本行给出那路数据源。**实锤读数**（eraTW 盘 **157 份 `.ERH`** 全文统计）：**8,097 `#DIM` + 350 `#DIMS` + 28 `#DEFINE`，函数定义 0 个**；分布 `ERB/Headers` 26（`AutoConst_*.ERH` ＝ 游戏自带 `tool/Generate_ERH.py` 生成的「编号→符号名」头）· `fromEN` 34 · `ERB/口上・メッセージ関連` 31 · `魔改内容` 11 · `コマンド関連` 11；作者侧样本 `M_KOJO_K11_2_DIM.ERH`、`一些变量.ERH`、`K15C_SAKUYADIM.ERH`。**引擎合法性**：`ConstantData.cs:1065-1083` 用户自定义变量（`.erd` + 同名 `.als`）写入 `erdNameToIntDics` ⇒ `#DIM` 出来的名字**引擎真认**；而 `variable-schema.ts` 现只扫 `.csv`/`.als` ⇒ 照游戏界面或照自己声明抄进 `.kojo` 必报 `unknown-identifier`。**⚠ 必修口径陷阱**：`#DIM` 是**作用域相关**声明（角色目录内的 DIM 只在进入该角色函数时有效）⇒ **不得拍平成全局一张表**，否则跨角色误判；与 HK-20 `call-context` 是相邻面，动前先 `git log --oneline -- packages/plugins/state-replay/src` 对齐口径。**落点**：`variable-schema.ts`（与 `.als` 并入同一函数族，「每角色自定名表」另立来源）。**扩族判据照抄 ALS 批**：真语料 warn 面打到 0 或只剩真阳性才入库，残余里有一条系统性假阳性类就不入库。**验收**：语料门控测试（照 `variable-schema.als.corpus.test.ts` 形态）+ 全量不回退 + 双 typecheck + `audit:decoupling` ✅（`.ERH` 属游戏侧数据，只进 adapter，勿漏内核/契约） | 待认领 |
| FT-2 | **`.ERH` 打不开 · 不进索引 · 无高亮无闸门；ERB 方言扩展名口径三处分裂（含双副本）** | **现象**：157 份 `.ERH` 在编辑器里既拖不开、也不进索引、也没有高亮与结构闸门——准确说是**认文件名、不认内容**（`eratw-adapter/src/plugin.ts:447` 已用 `M_KOJO_K{no}.ERH` 反推角色编号，勿重复造）。**三处口径**：①`OPENABLE_EXT = ['.kojo','.erb','.erm','.md','.txt']`（`app/src/ui/drag-drop.ts:13`，无 `.erh`）②`ERB_EXT = /\.er[bm]$/i`（`erb-parser/src/plugin.ts:49`，索引 + 结构闸门 + 诊断共用）③`isErbLike = /\.er[bm]$/i`（`app/src/ui/lift-preview.ts:11`）。**⚠ ②③ 是同一条口径的两份副本、分处两个包**——与 E16 刚收口的 `isIdentPart` 双副本同族；扩面必须一起改，否则出「索引里有、面上开不了」的分裂（PITFALLS 42 同族）。**低风险面**：`.ERH` 内容只有 `#DIM/#DIMS/#DEFINE`、**0 函数定义**（实测）⇒ 进索引**不改变函数树**，可先补「能打开 + 走高亮 + 闸门覆盖」，**与 FT-1 解耦、可并行**。**`.ERD`**：引擎支持（`Preload.cs:92`）但本语料 **0 份** ⇒ 只登记为覆盖面决议项，不立工作量。**验收**：单一口径源收成一处（`plugin-api/paths.ts` 或 erb-parser 导出纯函数）+ 三处消费改指它 + 一条「拖开 `.ERH` 能看能存、产物不回退」的自证 | 待认领 |
| FT-3 | **文件类型保留面决议**（用户 2026-10-14 意见：`.erb/.erh/.erd/.kojo` + `.txt/.md/.xlsx/.xls/.docx/.xml/.config/.json` 都要实现并保留；本行把该意见对到**实测成本**上，供拍板） | **分档读数（Monaco 0.57 目录实测）**：**A 轻量 definition**（每门 `register.js` ≈1 KB，不带 worker）＝`markdown` ✓ `ini` ✓（`.config` 是 `KEY:VALUE` ini 风格）`xml` ✓ ⇒ 用户点名的 `.md/.config/.xml` **几乎免费，照办**；**B 重型 feature**（各拖一个 worker chunk）＝`json` 400 KB / `html` 704 KB / `css` 1.1 MB / `typescript` **6.8 MB**，而语料实际命中 `.json` 1 · `.html` 2 · `.css` **0** ⇒ 建议**砍 B**，`.json/.html` 走纯文本或自写微型 Monarch；**C 其余 ~79 门内置语言**（abap/cobol/solidity/wgsl…）语料 **0 命中** ⇒ 砍；**D 用户点名但 Monaco 原理上显示不了的**＝`.xlsx` 7 / `.xls` 1 / `.docx` 2 ＋ 只读资源 `.webp` 2,548 / `.png` 642 / `.mp3` 33 —— 前三种是 **ZIP/OLE 复合二进制文档**，Monaco 只能显示文本，**「保留一门语言」解决不了**，要"实现"只能另立**解析能力**（读出表格/正文成只读视图），属新功能、需单独估工与单独一行；不在 A–D 的 `.txt` **7,867 份＝语料数量第一**，已可开但无高亮。**待拍板两点**：①B 档砍不砍（省 ≈9 MB / 换 `.json` 无高亮）②D 档要不要立解析功能行。**关联**：本行只定"保留面"，实际瘦身动作在首屏白屏线（L1，尚未上板）的 Stage B | 待认领 |
