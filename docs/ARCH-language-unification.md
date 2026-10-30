# 语言面统一架构（LAU）· 设计方案与契约

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.1（设计稿；§8 的七路前置批已落 dev，逐枚落点见下行「状态」）。v1.0 → v1.1 = **LAU-0 事实修订批**：11 处读数 / 出处 / 节点名改正，§4.1 保留差集通道，§5.2 由「新造 `dialect.ts`」改为「既有 2.0 `GameAdapter` 的只读投影」，§5.3 真源改为已上线的 `detect()` 链，§8 增五枚批（LAU-0 / 1a / 2a / 3b / 6a），§9 判据改成 audit 同形态。**逐条对照见附录 A**；设计主张（§2 决策表 / §3 六纪律）未变，只增 D13。**七路交付批的落点与实测改口见 §8.1 + 附录 B（8 条）** |
| 日期 | 2026-10-25（v1.0）· 2026-10-25（v1.1 修订，逐条带 file:line 取证） |
| 状态 | **v1.1 交付状态（2026-10-25 七路批已落 dev）**：LAU-0 `ebf8e03c` · GATE `6ca3c4c3` · 2a `f006547c` · D1a `875b05d3` · 1a `4c1487c4` · 6a `45d18791` · SYNTAX `3a76d857`＋`87b7e26c` · FIXTURE `b9e87b2e`（交付回执在各提交信息，基线读数见 `STATE.md` §一）。设计主张仍是设计稿——未落地的批次按 §8 推进。用户 2026-10-25 已拍板：§6.1 采用方案 A（`.kojo` 让给 2.0）、断言关键字定为 `# 方言`（**词位已入表并过 wasm 棘轮，消费方已接线**——`# 方言` 由词法 / 文法 / Monarch 三面认出，解析链按 D11 只做断言：与解析结果不一致 ⇒ `core/dialect/mismatch`，不再等 LAU-D1b）。**LAU-1 / LAU-D1b 的两个前置已解**：① 契约落点由用户 **2026-10-27 裁定 = `@kojo/kojo-core`**（BOARD K2-CONTRACT 已结，不再镜像 plugin-api）；② LAU-4 仍与 **ERB-PARITY**、SDK **B4/B5** 同文件，须串行合流（§8）。已做完的是 LAU-0（＝v1.1 文档批）/ LAU-1a / LAU-2a / LAU-6a + GATE / SYNTAX / FIXTURE / D1a；**LAU-3 框架批已交付（2026-10-27，分支 `b/qoder/1027-lau-framework`）**——§6 的 id 二选一已按用户口径定案＝改名 `kojo-legacy`（插件 id / 包名不动），缺省档翻 `2.0-default`，封存层连语义分析一起停；**LAU-3b 解耦批（同分支）已落前半**：kojo1 插件族按切流阶段装配（缺省档不实例化）、ERB / kojo2 / 宿主共用词表迁至 `@kojo/kojo-vocab`、v1 转译包整体离开开机静态图。**LAU-3b 收尾批（2026-10-27，同分支）已交付**：`.kojo → .kojo1` 改名工具（内容指纹只挑 v1 写法、清单先过目、逐文件写权限闸 + 写前备份 + 只改名不改内容；只读域拒绝）与封存档首开说明（一次性台账 + 直达设置页）。**扩展名翻转（`.kojo` 让给 2.0）已随本批最终落地（2026-10-27，用户口径「现在就让」）**：路由只认扩展名——`.kojo` / `.kojo2` → 2.0，`.kojo1` → kojo1；内容指纹退居迁移与改名工具的提示面（不再参与路由/归属）；迁移是原地改写（候选恒 `.kojo`），`resolveSugarTarget` 只认封存层 `.kojo1`。**LAU-4（ERB 进槽、与 kojo2 同一条供方路径）方案未变，仍等 SDK B4/B5** |
| 范围 | ① ERB / kojo v1（封存）/ kojo2 三条并行结构栈收成一套：**一份协议、一份角色表、一个槽位契约**；② 多 era 适配收进**方言层**（§5），语法不分叉 |
| 前置 | `KOJO-2.0-LANGUAGE-SPEC.md` §0.2（单一模式）/ §5.3 / §12.1（旧拼写 error+迁移）/ §10（adapter 契约，**§10.1 十五格就是本方案的事实面**）；**BOARD 在办批次**：`K2-CONTRACT`（契约落点待 D0 裁决）、`ERB-PARITY`（同文件，串行）、`POS-UTIL`（坐标换算收口，§4.6 的 `includedRanges` 归它管） |
| 不做 | 不改 2.0 语法；不动 `EDITOR_SEMANTIC_TOKEN_TYPES`；不新增 workspace 包；**不为任何 era 分叉语法** |

---

## 0. 一句话

**宿主不该认识任何一门具体语言。** 它只做三件事：按路径选 descriptor、把协议消息搬运、把捕获翻成 Monaco 区间。
今天这三件事里混进了语言知识（两套协议、四套 token 名＝三套 Monarch 各 15 名 + 名字层 legend 3 值、
**两处** `if (languageId === ERB_LANGUAGE_ID)`——`tree-sitter/providers.ts:378,385`），
LAU 就是把它们逐条剥出去。

判据只有一条，后面每一节都可以拿它复核：

> **新增一门语言，宿主目录下应当零改动**（`packages/app/src/monaco/` 一个字不改，只加一个 descriptor 与一个插件包）。
> 今天做不到；LAU 做完之后，封存层（§6）就是第一个验证者。

同理，多 era 适配的判据也只有一条：

> **新增一个 era，宿主与语法零改动**，只加一个方言包（数据）。反例今天仍在，只是**位置变了**——
> 2.0 主入口那处 eraTW 写死已于 2026-10-24（`ab1c5146`，入口 A）改成按当前项目现取、取不到给 `null`；
> ~~但**迁移向导的事件目录、存储注入的指纹、项目扫描的默认装载器**三处仍无条件取 eraTW 事实，
> 另有 `bootstrap.ts` 用 `'erafl'` 字面量挑包~~ ⇒ ✅ **这四处已由 LAU-1a `4c1487c4` 全部收掉**
> （三处改按当前项目取、字面量分支泛化成对 `adapter-manifest.ts` 的循环）。
> **"加一个 era 要改宿主"仍然成立，但原因换了**：方言级**数据**（事件目录内容、载体归属、变量族清单）
> 还写在各适配器包里，宿主侧不再认得具体 era≠数据侧已收成包 ⇒ 判据真要在 LAU-D4「方言包」落地那天才闭合
> （清单见 §5.1，§9-10 已按此改写）。

---

## 1. 现状：不是"乱"，是三条各自正确的路并行

| 层 | ERB | kojo v1 | kojo2 |
|---|---|---|---|
| 词法（Monarch） | `erb-language.ts`（**15 个 token 名**：6 个对象式 `:150-283` + 9 个简写式 `:129,132,134,136,138,161,163,171,284`） | `kojo-language.ts`（`KOJO_TOKEN_TIERS` `:137-151`，13 档 / 15 名：`sugar.*` ×12 + `keyword.erb` / `keyword.erb.family` / `keyword.raw`） | `kojo2-language.ts`（转出口 `:56,77`；`KOJO2_TOKEN` 定义在 `kojo-theme-rules.ts:94-125`，15 名，全 `kojo2.*`） |
| 名字层（语义） | 插件槽 `ui.editor.languageService`（`erb-parser/src/plugin.ts:1512-1517`），legend = 契约 3 值 `['function','variable','parameter']`（`plugin-api/src/slots.ts:758`） | 同左（`kojo-sugar/src/index.ts:584`；宿主装配 `monaco/kojo-semantic-tokens.ts:50-53`） | **无**（`languages.ts:104-111` 只有 `slotServices`+`capabilities`，未声明 `languageServices`，理由见 `:85-87`） |
| 结构层 | `StructureClient`（`tree-sitter/client.ts:127`）+ `erb-ts.worker`，协议 v2 = `KOJO_STRUCTURE_PROTOCOL = 2`（`types.ts:33`，握手校验 `worker-bootstrap.ts:59-65`） | 同一条路（`kojo-ts.worker`，共用 `startStructureWorker`） | `Kojo2WorkerClient`（`kojo2-worker-runtime.ts:91`）+ `kojo2-ts.worker`（`kojo2-worker-protocol.ts`，**无协议常量、无握手**） |
| 捕获→颜色 | `ERB_SEMANTIC_CAPTURE_TIERS`（`erb-tiers.ts:31-41`，**9 支**） | `KOJO_STRUCTURE_CAPTURE_TIERS`（`types.ts:230-234`，3 支）+ 节点级 `KOJO_STRUCTURE_NODE_TIERS`（`:261-280`） | `KOJO2_CAPTURE_TOKEN_TYPES`（`kojo2-semantic.ts:85-101`，15 支） |
| 主题 | 并进 `kojo-dark/light/mint-dark`（`theme.ts:48,601-613`） | 同左 | 并进同一批（带开关，`kojo2-theme.ts:8-9`、`theme.ts:295`）+ 三套独立 `kojo2-dark/light/mint-dark`（`kojo2-theme.ts:50-56`） |
| 文法 wasm（字节 / MiB） | 1,030,545 B（0.98 MiB）＝`erb-syntax-tree/tree-sitter-erb.wasm` | 821,724 B（0.78 MiB）＝`kojo-syntax-tree/tree-sitter-kojo.wasm` | **48,057 B**（0.046 MiB）＝`kojo-syntax-tree/tree-sitter-kojo2.wasm`（LAU-SYNTAX 加 `# 方言` 词位后；v1.1 取证时 47,116 B） |

> ⚠ **单位口径（PITFALLS 204 的同一课）**：v1.0 写 ERB「0.98 MB」、§4.6 写「1.03 MB」，指的是**同一枚文件**
> （0.98 MiB = 1.03 MB 十进制）。本稿一律给**字节数**，不再用 MB。

四条具体代价（都是可验证的事实，不是感觉）：

1. **加一档颜色要改三处**：捕获表 + 主题规则 + legend 校验，漏一处就是"这枚捕获悄悄没色"。
   （对账纪律今天只在 kojo2 那侧成机制：`kojo2-theme.ts:135-168` 双向抛、import 期即评 `:176-178`；
   ERB / v1 那两侧靠人手，这正是 R4 要收的。）
2. **两套超时策略**：v1 单档 4s（`client.ts:72`），kojo2 8s 引导 / 2s 稳态（`kojo2-worker-protocol.ts:33,40`）。
   ⚠ v1 的"判死"**分两档，不是一律整档**（v1.0 说过头了）：**ready 之前**超时才 `fatal()` → 整档 `dead`、
   worker 终止、provider 摘除，且只能靠切 tree-sitter 设置项恢复（`client.ts:318-332,351-363`、
   `providers.ts:370-375,507-511`）；**ready 之后**超时只死当前文档的那一面（`client.ts:326-329`，
   文案「下一份文档再试」，每文档一张新 `dead` 表 `:238`）。D8 的账本仍值得做（确无失败计数，
   `fallback.ts` 只有去重 `Set` `:59,74`），但收益面是"ready 前那一档"，别按"每次超时整档消失"估收益。
   （"ERB 首帧慢的根因就是超时策略"这句 v1.0 未取证，改为待测：LAU-1 的 DoD 要出 `open→ready` 与
   `ready→首屏着色` 两个数，见 §9-3。）
3. **两套失败词表**：v1 由 worker 决定 `capability`（谁该降级），kojo2 由 worker 报 `reason`（发生了什么）。职责放错了地方。
4. **首帧往返次数差 3 倍**（v1.0 写 4 倍）：kojo2 开一份文件 = `captures` + `folds` + `indents` **三条**请求，
   每条都带全文（`kojo2-semantic.ts:348` / `kojo2-folding.ts:180` / `kojo2-indent.ts:656`）；协议与 client 里
   虽然都有 `parse`（`kojo2-worker-protocol.ts:42`、`kojo2-worker-runtime.ts:160`），但**宿主无生产调用方**。
   v1 是一条 `parse`（`client.ts:248`）推四条回复（`engine.ts:724,731,736,745`）。
   ⇒ 统一方向应是**kojo2 学 v1**（一条请求、四面回复），而不是反过来把 v1 的差集通道拆掉（§4.1）。

`kojo2-*.ts` 在 `packages/app/src` 下共 **42 个文件 / 19,383 行**（`monaco/` 21 个 7,634 行、
`ui/` 21 个 11,749 行），另有 4 个 `.tsx` 共 1,853 行。B3c–B3j 已把补全 / 悬停 / 签名 / 格式化 /
引用 / 改名 / 同符号高亮 / 扩选 / 行上注解（codeLens）/ 折叠区间 / 一键迁移 code action 搬进
`@kojo/kojo-lang` 包与插件，B3i 把缩进 / 回车判据搬进
`@kojo/kojo-lang/indent`（宿主 `monaco/kojo2-indent.ts` 只剩 on-type 装配与 Monaco 翻译），
B4（语言面进槽）与 B5a（`@kojo/kojo-sdk` 立包）已交付；
剩下的宿主直装语言面（诊断 / 语义着色 / 缩进装配）已随 B3 余项收口——语义着色与文档级诊断的判据都进了 `@kojo/kojo-lang`、供方在插件（诊断走专用槽 `ui.editor.decorator`），宿主只剩装配与翻译；B5b（删宿主残留）随后。LAU 沿着这条既有路线走，不另起炉灶（§8）。

---

## 2. 决策表（本方案的全部主张，逐条可反对）

| # | 决策 | 替代方案与否决理由 |
|---|---|---|
| **D1** | **协议只有一份**，`structure-protocol.ts`，`id` 配对 + 带版本协商 | 保留两套：任何跨语言能力（折叠统一、诊断统一）都要写两遍 |
| **D2** | **worker 报事实（`reason`），宿主定代价（`capability`）** | v1 让 worker 决定降级面：worker 要懂"宿主有几面"，职责倒挂 |
| **D3** | **一条请求一条回复**：`parse` 带回全部面；**差集通道保留**（`parse` 走 `text` 或 `edit` 二选一） | kojo2 的三条请求各带全文；Monaco 开文件时本来就同时要四面，"按需拉"没有真实场景。但"并成一条消息"≠"每次传全文"——v1 今天的 `commonEdit` 差集是真实优化（§4.1） |
| **D4** | **捕获以扁平数组过线**（`number[]` + 字符串字典），档位翻译留在主线程 | 传对象数组：5 万捕获 ≈ 3 MB JSON，且主线程要重建对象 |
| **D5** | **颜色只有一份**：`role.*` 角色表；Monarch 与结构层都发角色名 | 保留四套名字 + 别名永久化：等于没统一，只是加了一层 |
| **D6** | **名字层（`function/variable/parameter`）与语法角色正交，不合并** | 合并成 20 值 legend：插件作者写不动，Monaco"先注册者胜"更难推理 |
| **D7** | **封存层是另一门语言**（`availability: 'legacy'`），不是版本开关 | 在 2.0 编译器里留旧分支：违反 spec §0.2「单一模式、无版本声明」 |
| **D8** | **降级是账本，不是开关**：连续 3 次失败才判死一面 | 今天一次超时永久 `dead`：慢一次 = 这一门语言的结构层整档消失 |
| **D9** | **适配的单元是方言（dialect），不是语言**：语法 / 载体 / 方言三条轴正交 | 每来一个 era 就"再适配一遍语言"：语法层被游戏事实污染，N 个 era = N 份分支 |
| **D10** | **方言不进 wasm、不进 worker、不改语法**：只进"事实类"服务（补全 / 悬停 / 诊断 / 符号 / 跳转） | 让方言影响 tree-sitter 查询：每个 era 一份文法或一份查询，回归面乘 N |
| **D11** | **方言的真源是已上线的识别链**：`detect()` 轮询 → `project.adapterId`（带 `ProjectDetectionError` / `AdapterConflictError` 双闸）；工程清单（**作者工作区** `workspace.json` 的 `meta`，additive）只做**覆盖**，文件里的 `# 方言` 只做**断言**，三者不一致即 error | v1.0 定的「工程根 `kojo.project.json` 为唯一真源」**无落点**：游戏目录整体只读（铁律 5），`detect()` 打开的盘上不会有也不该有编辑器写的清单；而另立一份真源会与 `detect()` 结论漂移（§5.3） |
| **D12** | **未绑定方言 = 明确降级，绝不回落到某个默认方言** | 2.0 面今天**已经是这个语义**（`kojo2AdapterForProject` 取不到给 `null`，`bootstrap.ts:52-58`）；~~还差的是三处无项目门的惰性装载~~（✅ **已由 LAU-1a `4c1487c4` 补齐项目门**，见 §5.1 第 1 条的改口表）⇒ 这条决策**今天全线成立**，剩下的活是 LAU-D2 接线时**别把它弄回去** |
| **D13**<br>（v1.1 新增） | **方言契约 = 既有 2.0 `GameAdapter`（`kojo-core/src/adapter.ts:40`）的只读投影，不新造第三套**。真正新增的只有 `carrier` 归属一格与 `EditorDocumentIdentity.dialect?` 的传递；事实面的字段名、结构、fail-closed 旋钮一律沿用 spec §10.1 那十五格 | 新造独立 `DialectFacts`：与 `kojo-core` 的 2.0 `GameAdapter`、`plugin-api/src/game.ts:755` 的 v1 `GameAdapter` 并存成**三套**，且是前者的**有损**重投影——丢 `domainSymbols.unknown:'error'\|'raw'`（`:239`，`checkSymbol` `:1325-1338` 读的正是它，即"错事实必须报错"的旋钮）、丢四枚 presentation 结构、丢 `encodingPolicy`/`layerPolicy`/`capability`/`sourceMap`/`conformanceSuite`/`diagnosticNamespace`，对 v1 十二个可选槽**零覆盖**（§5.2 逐格对照） |
| **D14** | **`@原生` 体内注入子语言**：descriptor 声明 `injections`，宿主按声明转发（`includedRanges`，坐标天然对齐） | 文法内嵌 ERB：kojo2 文法从 48,057 B 涨到 MB 级，且 kojo1 退役期两边一起改。⚠ "MB 级"是**推算不是读数**（`# 方言` 一枚词位实测 +941 B，内嵌整门 ERB 未实测）；LAU-6a `45d18791` 给出的实证更硬——注入路**零文法改动**就能跑通四面，内嵌路要先造一具新 wasm |

---

## 3. 目标架构

```
┌─ L3 宿主 packages/app ──────────────────────────────────────────────┐
│  language-registry   选语言（按 availability 门控）                  │
│  structure-overlay   建线程 / 搬运消息 / 把捕获翻成 Monaco 区间       │
│  theme               把角色表铺成 IThemeRule[]（零色值，只引用）      │
│  dialect-resolver  从项目识别链解析方言，随请求下传（零事实、零默认） │
└───────────────▲──────────────────────────────▲─────────────────────┘
                │ 只认契约                      │ 只认角色名
┌───────────────┴──────────────┐  ┌────────────┴─────────────────────┐
│ L1 契约 @kojo/plugin-api     │  │ L1' 角色表 kojo-theme-rules      │
│  structure-protocol.ts       │  │  SEMANTIC_ROLES / 别名 / 规则形状 │
│  language-descriptor 类型    │  └──────────────────────────────────┘
│  slot: ui.editor.languageService │
└───────────────▲──────────────┘
                │ 实现
┌───────────────┴──────────────────────────────────────────────────┐
│ L2 语言插件（每门语言一个包）                                      │
│  grammar.wasm + queries/*.scm + tokenizer（捕获→角色）+ Monarch    │
│  ERB / kojo2 / 封存 kojo v1 —— 三者地位完全相同                    │
└──────────────────────────────────────────────────────────────────┘
```

六条纪律（每批 DoD 都拿它们复核；编号 R 以免与 §2 的决策号 D 混淆）：

- **R1 宿主零语言知识**：宿主里不许出现 `ERB_LANGUAGE_ID` / `KOJO2_LANGUAGE_ID` 分支，也不许出现具体 token 名。
  ⚠ **存量比 v1.0 假设的多**：除 `tree-sitter/providers.ts:378,385` 那两处 ERB 分支（v1.0 写"一处"）外，
  还有 `erb-completion-members.ts:404`、`erb-completion-words.ts:25`、`kojo-format.ts:63`、
  `suggest-context-trigger.ts:190,226,495`、`ui/editor-global-providers.ts:238,1768,1772`、
  `ui/editor-pane/use-breadcrumb.ts:248`、`pane-helpers.ts:104`、`use-editor-preferences.ts:130`、
  `ui/kojo2-model-language.ts:60`。⇒ R1 是**终态**判据（LAU-4 + SDK B4/B5 之后才成立），
  **不得当任何单批的 DoD**；逐批的 DoD 见 §8，§9-1 的 grep 已按此改写。
  ⚠ 别与另一族混：上面列的全是**语言 id 分支**（审计的 M2），宿主里还有一族是**游戏名/引擎词汇**（M1）——
  那三处按 eraTW 硬装载的惰性点（`App.tsx:237-249,406,421`、`kojo2-project-scan-adapter.ts:48-51`）
  **已由 LAU-1a `4c1487c4` 改成按当前项目取、取不到给 `null`**，不在本条的存量里。
- **R2 一门语言 = 一枚 descriptor**：加语言不改 model 池、EditorPane、provider 接线（今天已基本做到，LAU 补完 `syntaxPresenter` 与 `availability` 两个缺口）。
- **R3 协议一份、带版本、失败即数据**：worker 永不 reject，也永不"半吊子继续答"。
- **R4 颜色一份**：屏幕上有几档由角色表说，色值由主题规则说，两者一一对应且在模块加载期对账。
- **R5 降级一份台账**：`fallback.ts` 是唯一出口，每种 `reason` 有且只有一句人话。
- **R6 方言只进事实面**：语法 / 载体 / 方言三轴正交；**方言数据**不进 wasm、不进 worker、不改查询。
  ⚠ 精确口径（v1.1）：`# 方言` 这个**词位**是一次性语法增补，且**必须重生成 `tree-sitter-kojo2.wasm`**
  （词被烧进文法 token，见 §5.3）——它是所有方言共用的断言记号，不是某个方言的知识。
  此后任何方言差异都不得再动语法，这条才是 D10 的原意。

---

# 第二部分 契约接口方案

> 下列签名是**目标形状**，不新增 workspace 包（遵循 spec §12.3「不先改名现有包」）。
> 现有 `KojoStructure*` 类型在 LAU-1 期间保留为**类型别名**，LAU-1 收尾时删除。
>
> ✅ **落点已定（用户 2026-10-27 裁定）＝ `packages/kojo-core/src/`**。v1.0 写的"落 `packages/plugin-api/src/`"
> 已被否决：2.0 契约住在 `kojo-core/src/adapter.ts`（`validateGameAdapter` 同处），**不**再 additive 镜像到
> plugin-api（BOARD K2-CONTRACT 已结）。本节类型仍按"落 `kojo-core`"阅读；LAU-1 / LAU-D1 据此开实现批。
> 结构协议（§4.1）与角色表（§4.2）本来就是宿主↔worker 与宿主↔主题的边界，与游戏事实无关，可按 LAU-1 / LAU-2 先行。

## 4.1 协议 `structure-protocol.ts`

```ts
/** 协议版本：形状一变就抬号；`open` 那一步比对，不符即拒（不拿旧形状硬解）
 *  v4（LAU-5 抬号）：只加 `ready.docBase` —— 一条线程多台引擎时的 `doc` 号段起点 */
export const STRUCTURE_PROTOCOL_VERSION = 4;

/** 一条回复最多带回多少捕获（超了截断 + `truncated`，不静默丢） */
export const STRUCTURE_MAX_CAPTURES = 50_000;

export type StructureFacet = 'semantic' | 'folds' | 'indent' | 'syntax';

/** 失败原因：**闭集**。worker 只报发生了什么，代价由宿主决定（D2） */
export type StructureFailureReason =
  | 'unavailable'        // 本进程建不出 worker
  | 'disposed'           // 客户端已释放
  | 'protocol-mismatch'  // open 那一步版本不符
  | 'invalid-input'      // 请求形状不合法
  | 'wasm-load-failed'   // runtime / grammar wasm 装不上
  | 'parse-failed'
  | 'query-failed'       // 查询编译或执行失败
  | 'crashed'            // 线程未捕获异常
  | 'timeout';           // 仅主线程产生

/* ------------------------------ → worker ------------------------------ */

export interface StructureOpenRequest {
  readonly id: number;
  readonly kind: 'open';
  readonly protocol: number;
  /** 语言 id 原样带过去，只用于 worker 侧的日志与自证，worker 不据此分支 */
  readonly languageId: string;
  readonly runtimeWasmUrl: string;
  readonly grammarWasmUrl: string;
}

/**
 * 内容**二选一**（v1.1 改口，见下面"为什么保留差集"）：
 * - `{ text }`：整篇（开文件、换轨、worker 说 `baseTreeId` 不认识时的兜底）；
 * - `{ edit }`：基线 + 差集，基线文本由 worker 自己留着（主线程不再重发）。
 * 两者都给 ⇒ `invalid-input`（不猜哪个算数）；`edit` 的形态沿用既有 `StructureEdit`（`tree-sitter/edit.ts`）。
 */
export type StructureContent =
  | { readonly text: string }
  | { readonly edit: StructureEdit };

/**
 * 绝对区间（`@原生` 注入用，§4.6）：索引与行列**都要给**，直接对齐 web-tree-sitter 的 `Range`
 * ——只给行列会让 worker 再做一次全文扫描。坐标换算归 BOARD 的 **POS-UTIL** 那条口径。
 */
export interface StructureRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
}

export interface StructureParseRequest extends StructureContent {
  readonly id: number;
  readonly kind: 'parse';
  /** 文档身份（跨文档隔离；换轨后旧回复据此丢弃） */
  readonly doc: number;
  /** 内容版本（同文档内判陈旧） */
  readonly version: number;
  /** 增量基准：上一次回复交出的树；缺省 / 不认识 ⇒ 整篇重解 */
  readonly baseTreeId?: string;
  /** 只要这几面（缺省 = 全部）。大文件门控用，不改变"一条请求一条回复" */
  readonly want?: readonly StructureFacet[];
  /** `@原生` 注入用（§4.6 / LAU-6）：缺省 = 全文档 */
  readonly includedRanges?: readonly StructureRange[];
}

export type StructureRequest = StructureOpenRequest | StructureParseRequest;

/* ------------------------------ → 主线程 ------------------------------ */

export interface StructureReadyReply {
  readonly ok: true;
  readonly id: number;
  readonly kind: 'ready';
  readonly protocol: number;
  /** 引导期读数：`Parser.init` + `Language.load` + 查询编译（池里复用同一台引擎时是 0） */
  readonly loadMs: number;
  /**
   * **这条通道的 `doc` 号段起点**（v4 / LAU-5）：第 k 台引擎 = `k × 1,000,000`；
   * 宿主的 `doc` 一律写成 `docBase + 本客户端自己的序号`，worker 按 `docBase ≤ doc`
   * 的最大那台路由。单引擎 worker（kojo2 自有线）恒回 0。
   */
  readonly docBase: number;
}

/**
 * 捕获的**扁平投影**（D4）：`spans` 每 6 个数字一条
 * `[startRow, startCol, endRow, endCol, nameIndex, nodeIndex]`，行 / 列 0 基。
 * `names` / `nodes` 是字典（去重后），`nameIndex` / `nodeIndex` 指向它们。
 */
export interface StructureCaptureTable {
  readonly names: readonly string[];
  readonly nodes: readonly string[];
  readonly spans: readonly number[];
}

export interface StructureFoldTable {
  /** 每 2 个数字一条 `[startRow, endRow]`（0 基，`endRow > startRow` 才算折叠） */
  readonly spans: readonly number[];
}

export interface StructureIndentRules {
  readonly increasePatterns: readonly string[];
  readonly decreasePatterns: readonly string[];
  readonly enterPatterns: readonly string[];
}

/** 结构残缺**事实**（无文案、无诊断码：说人话是表现层的事） */
export interface StructureSyntaxFault {
  readonly row: number;
  readonly endRow: number;
  readonly column: number;
  readonly endColumn: number;
  readonly kind: StructureSyntaxKind;
  readonly faultRow: number;
  readonly blockHeadText?: string;
  readonly blockHeadRow?: number;
  readonly expectedToken?: string;
}

export interface StructureParseReply {
  readonly ok: true;
  readonly id: number;
  readonly kind: 'parse';
  readonly doc: number;
  readonly version: number;
  readonly treeId: string;
  readonly incremental: boolean;
  /** 只带 `want` 里点名的面（缺省 = 全带）；缺的键 = 这一面这次没算 */
  readonly facets: {
    readonly semantic?: StructureCaptureTable;
    readonly folds?: StructureFoldTable;
    readonly indent?: StructureIndentRules;
    readonly syntax?: { readonly faults: readonly StructureSyntaxFault[]; readonly truncated: boolean };
  };
  readonly metrics: { readonly parseMs: number; readonly queryMs: number; readonly textLength: number };
}

export interface StructureFailureReply {
  readonly ok: false;
  readonly id: number;
  readonly kind?: 'open' | 'parse';
  readonly reason: StructureFailureReason;
  readonly message: string;
  /** 查询失败但树已解出：交回主线程，下一版还能增量 */
  readonly treeId?: string;
}

export type StructureReply = StructureReadyReply | StructureParseReply | StructureFailureReply;
```

**两档预算（D8 的一半）**

```ts
/** 稳态：一条 `parse` 最多等多久 */
export const STRUCTURE_TIMEOUT_MS = 4_000;
/** 引导期（worker 还没回过任何一条）：线程 + 两枚 wasm + 文法装载都在这个窗口里 */
export const STRUCTURE_BOOTSTRAP_TIMEOUT_MS = 8_000;
/** 连续几次失败才判死一面（判死 = 这一面不再等，但换文档重计） */
export const STRUCTURE_DEAD_AFTER_FAILURES = 3;
```

取档依据是"worker 回过话没有"，与 kojo2 同口径。**4s 而非 kojo2 的 2s**：稳态的代价函数不对称——
多等两秒只让作者晚看到颜色，错判一次却让这一面消失到换文档为止（ready 之前错判更重：整档 `dead`
到切设置项才恢复，见 §1 代价 2）。

**抬协议号必须双跑一批（v1.1 补）**：v1 侧现值是 `KOJO_STRUCTURE_PROTOCOL = 2`（`types.ts:33`，
握手校验在 `worker-bootstrap.ts:59-65`），kojo2 侧**根本没有协议常量与握手**——所以"3"对 kojo2 是
从零建，对 v1 是抬号。§4 抬头说的"旧类型保留为别名"只保证**编译期**兼容，运行期两侧形状不同就必须
在同一个 commit 周期内让新旧 worker 并存（`open` 拒掉不符的一侧、宿主按 `reason='protocol-mismatch'`
降级到旧路），否则 LAU-1 落地那一刻所有语言的结构层同时哑火。这是 LAU-1 回滚点的真实含义。

**与两套旧协议的映射**（LAU-1 的迁移表，逐条对拍用）

| 旧 | 新 | 说明 |
|---|---|---|
| v1 `init{protocol,wasmUrl,runtimeWasmUrl}` | `open{protocol,languageId,runtimeWasmUrl,grammarWasmUrl}` | 字段名统一为 `grammarWasmUrl` |
| v1 `parse{doc,version,text}` | `parse{doc,version,text}` | 同形 |
| v1 `change{doc,version,start,oldEnd,newEnd,newText}`（`types.ts:166`，发送点 `client.ts:295-303`） | `parse{doc,version,edit,baseTreeId}` | **并消息类型，不并差集**（v1.1 改口）：`commonEdit` 求最小编辑、`applyEdit` 自检对得上才发差集、对不上自动退回整篇（`edit.ts:38`、`client.ts:289-303`）——这套逻辑原样保留，只是从"另一种消息"变成"`parse` 的一种内容形态" |
| v1 四条推送 `semantic/folds/indent/syntax` | 一条 `parse.facets` | D3 |
| v1 `error{stage,capability,message}` | `ok:false{reason,message}` | D2：代价由宿主定 |
| kojo2 `captures/folds/indents` 三条查询 | 并入 `parse.facets` | D3（往返 3 → 1） |
| kojo2 每条请求带全文（`kojo2-worker-runtime.ts:160-173`） | `parse{edit}` 差集 | 对 kojo2 是**新增能力**（今天没有差集路）；接上之后它的每键成本才与 v1 齐平 |
| kojo2 `oldTreeId` | `baseTreeId` | 改名统一 |
| kojo2 无版本协商 | `open.protocol` | 补上，否则两侧版本漂移只能靠形状闸兜 |

> **为什么保留差集（v1.1 改口，原稿这里主张取消 `change`）**：`baseTreeId` 只解决 worker 内的**树复用**，
> 解决不了传输与取字符的复制成本。原稿的实测口径保留——传整串时 web-tree-sitter 内部取字符会
> `text.slice(index)` 复制文档尾巴，p95 抬到 30ms 级；但原稿那句「文本传输本身在结构化克隆里是
> **零拷贝转移**」是错的：structured clone 对字符串是**复制**，只有 `ArrayBuffer` / `MessagePort` 一类
> 才是可转移对象。6,003 行档每敲一键整篇复制一遍，方向与刚落地的性能批（`483098b7`「落档只发差集」）
> 相反。⇒ 消息类型从 5 种收到 3 种（`open` / `parse` / 回复），D3 的收益全保留；差集走 `parse.edit`。
> 顺带一条实现纪律：`text` 与 `edit` **二选一**，两个都给判 `invalid-input`——不给"哪个算数"留猜的余地。

## 4.2 角色表 `semantic-roles.ts`（D5 / D6）

```ts
/**
 * 屏幕上要分出的**语义角色**（不是"语法类别"，也不是"颜色"）。
 * 名字空间 `role.` 前缀：既避免与 Monaco 基线 token 意外撞名，也让"这一档是本仓定义的"
 * 一眼可辨。
 */
export const SEMANTIC_ROLES = [
  'role.comment',        // 注释
  'role.keyword',        // 语言骨架（中文关键字 / 保留词）
  'role.keyword.control',// 收束 / 流转 / 裸块头：整行就是那个词
  'role.directive',      // 外来指令：预处理行、标签行、未中文化的引擎骨架
  'role.operator',       // 运算符（含改判定的中文运算符）
  'role.number',         // 字面量
  'role.speaker',        // 说话人
  'role.speech',         // 台词 / 正文
  'role.punctuation',    // 结构性标点：台词引号、块头冒号、插值定界
  'role.interp',         // 插值记号与其中的表达式
  'role.label',          // 标签 / 跳转目标
  'role.call',           // 调用位（被调名）
  'role.decl',           // 声明名（函数名 / 声明行的名字）
  'role.slot',           // 名字层：作者还得记住的原名、代词、变量
  'role.alias',          // 英文隐藏别名：生效但弱化一档
  'role.anchor',         // 旁白锚点（`>`）
  'role.raw',            // 不透明整块（原生直通 / 停用区）
  'role.hint',           // 行尾提示（`续` 之类）
] as const;

export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

/** 主题规则的**形状**（色值住在主题包，不在契约里） */
export interface SemanticRoleStyle {
  readonly role: SemanticRole;
  readonly foreground: string;
  readonly fontStyle?: 'italic' | 'bold' | 'underline';
}

/** 旧名 → 角色（LAU-2 的过渡桥；LAU-4 收尾时删除） */
export const LEGACY_ROLE_ALIASES: Readonly<Record<string, SemanticRole>> = {
  'sugar.keyword': 'role.keyword',
  'sugar.keyword.alias': 'role.alias',
  'sugar.operator': 'role.operator',
  'sugar.system-function': 'role.call',
  'sugar.pronoun': 'role.slot',
  'sugar.cont': 'role.hint',
  'sugar.speech': 'role.speech',
  'sugar.speech.delimiter': 'role.punctuation',
  'sugar.colon': 'role.punctuation',
  'sugar.interp': 'role.interp',
  'sugar.interp.delimiter': 'role.punctuation',
  'sugar.slot': 'role.slot',
  'keyword.erb': 'role.directive',
  'keyword.erb.family': 'role.directive',
  'keyword.preprocessor': 'role.directive',
  'keyword.raw': 'role.raw',
  'label': 'role.label',
  'entity.name.function': 'role.decl',
  'variable': 'role.slot',
  'string': 'role.speech',
  'string.quote': 'role.punctuation',
  'string.escape': 'role.interp',
  'number': 'role.number',
  'comment': 'role.comment',
  // kojo2.* 一律去前缀落到同名角色（kojo2.speaker → role.speaker …）
};
```

> **交付实测（LAU-2 `b/qoder/1027-lau-roles`，2026-10-27；v1.2 改口）**：实表是 **34 档**、
> 别名表 **47 条**，不是上面草图的 18 档 / 45 名。差在硬约束：**六套主题一个色值都不许改**——
> 18 档必须合并"今天不同色的档"（那就是改色）；34 档才是"每套主题每个角色只占一枚色"的最小划分
> （上界由 adapter 的 dark 25 枚独立色决定）。本章列表按方案草图标示，**以
> `packages/kojo-sdk/src/semantic-roles.ts` 为准**（SDK B5a 起角色表住 SDK，宿主与 `kojo-lang`
> 只留指针）。零改色由 `packages/app/tests/fixtures/legacy-token-colors.json`（九套主题 × 48/16 档
> 逐档 fg + fontStyle）钉住。

三条硬约束（由测试钉住）：

1. **每个 `SEMANTIC_ROLES` 成员在每套主题里必须有且只有一条规则**，缺一条在模块加载期抛（沿用
   `kojo2-theme.ts:135-168` 的既有纪律：双向抛——token 缺规则 `:148,152`、规则没登记的 token `:157-165`，
   import 期即评 `:176-178`；ERB / v1 那两侧今天还没有这枚闸，LAU-2 顺手补齐）；
2. **任意两档 ΔE ≥ 12、对底色对比度 ≥ 4.5**（沿用 `kojo2-theme.test.ts:238,249-253,260-269` 的现有指标，
   换成角色表跑）。✅ **可行性已由 LAU-2a `f006547c` 算过（读数全表见 §8）**：18 档在 6 套主题（实为
   `#1e2227` / `#f6f8fa` / `#0f1713` 三个底色）上**全部可解**，最严格底色下的最大可解档数下界 233 档
   ⇒ **档数不是限制项，LAU-2 不必在"降阈值"与"减档"之间二选一**。但两条留给实现批：
   ① 现役 12 唯一色在这两个阈值上的**余量本来就薄**（min 两两 ΔE 余量 1.8/2.7，min 对比度暗底只剩
   **0.08**）——铺到 18 档时"数学可解"的见证色组未经可读性/语义联想评审，**定稿色卡要人工看过**，
   探针只否掉了"档数不够"这一条；② "跨底色同档同色"是比现闸更强的约束（现口径只要求**同主题内**两两
   ΔE），本批未验，若 LAU-2 采纳它须自己重跑 `tools/color-feasibility.mjs` 出数；
3. **`LEGACY_ROLE_ALIASES` 的每个值都必须是 `SEMANTIC_ROLES` 成员**，且别名表只允许出现在一个文件里
   （断言走 `tools/audit-language.mjs`，不用裸 grep，见 §9 抬头）。

> **别名表覆盖度自检（v1.1 补）**：`LEGACY_ROLE_ALIASES` 必须覆盖三侧的**全部**现役 token 名，
> 一个不漏——ERB 15 个、v1 15 个、kojo2 15 个（读数见 §1 表）。LAU-2 的测试就用这三份清单做对账：
> 「现役 token 名集合 ⊆ 别名表键集合」，多一个少一个都红。原稿的表里 kojo2 那侧写的是
> 「一律去前缀落到同名角色」，这是**规则不是表**——按本节第 3 条，规则也要落成可枚举的字面量，
> 否则"别名表只允许出现在一个文件里"这条断言查不到它。

**为什么不动 `EDITOR_SEMANTIC_TOKEN_TYPES`（D6）**：那 3 个值是**名字层**语义（这枚标识符是函数、变量还是参数），
与"这段语法是什么角色"是两个正交维度。合并成一份 20 值 legend 的真实后果：
插件作者要为一枚变量选一个"语法角色"，而它同时是"参数"——两个维度压进一个枚举，
必然有一半是错的；且 Monaco 的多 provider 合并是"重叠时先注册者胜"，维度混淆后无法推理谁该赢。

## 4.3 描述符 v2 `language-descriptor.ts`（D2 / D7）

```ts
/**
 * 可用性：**只影响"能不能被认领"与"选择器里出不出现"**，不影响注册。
 * 注册表是进程级只增表，开关若去增删注册项，两个入口就会打架（kojo2 那一课）。
 */
export type LanguageAvailability = 'default' | 'opt-in' | 'legacy';

export interface LanguageDescriptor {
  readonly id: string;
  readonly label: string;
  /** 缺省 `default` */
  readonly availability?: LanguageAvailability;
  /** 设置项键名（`opt-in` / `legacy` 必填；`default` 忽略） */
  readonly settingKey?: string;
  readonly matchesPath: (filePath: string) => boolean;
  readonly register: (monaco: typeof Monaco) => void;
  readonly services?: {
    /** 只挂这几条槽腿（原 `slotServices`） */
    readonly slot?: readonly SlotServiceKind[];
    /** 旧路：v1 语义的 11 枚 provider 全铺（仅 ERB 与封存层用，LAU-4 后应清零） */
    readonly legacyBridge?: boolean;
  };
  readonly structure?: { readonly load: () => Promise<StructureRuntime> };
  readonly capabilities?: readonly LanguageCapability[];
}
```

> **与今日形状的差量（v1.1 补，落地前必读）**：现役 `LanguageDescriptor` 在
> `monaco/language-registry.ts:37-85`，字段是 `id / label / matchesPath / register / languageServices? /
> slotServices?（SlotServiceKind[]，:30-35）/ structure?{load} / capabilities?`；
> `StructureLanguageRuntime` 在 `monaco/structure-runtime.ts:36-43`，已有
> `runtimeWasmUrl / grammarWasmUrl / createWorker / semantic? / baseIndentPatterns?`。所以本节的真差量只有
> **三格新增**（`availability` / `settingKey` / `presentSyntax`+`clearSyntax`）与**一格改名**
> （`slotServices` → `services.slot`）。⚠ 那格改名是 breaking 的：`languages.ts` 与
> `tests/language-parity.test.ts`（含 `tools/lang-ux-matrix.mjs` 的取证表）都按 `slotServices` 读。
> 两条路选一：① **additive**——`slotServices` 留在原位，`services` 只装新腿（`legacyBridge`）；
> ② 改名与 `language-parity` 取证表**同批**改完。默认走 ①（AGENTS §六：跨模块需求走 additive 契约，
> 旧消费方零改动）；走 ② 必须先与 ERB-PARITY（lead 在办）对齐，那是同一批文件。
> `languageServices?` 这一格本节没画出来但**不能删**：v1 / ERB 的名字层还挂在它上面（§1 表第二行）。

```ts
/** 结构层运行时：**宿主唯一的按语言注入点**，也是"宿主零语言知识"的边界 */
export interface StructureRuntime {
  readonly runtimeWasmUrl: string;
  readonly grammarWasmUrl: string;
  readonly createWorker: () => Worker;
  /** 捕获 → 角色 → Monaco 区间；缺省 = 这门语言不做结构着色 */
  readonly semantic?: {
    readonly legend: Monaco.languages.SemanticTokensLegend;
    encode(captures: StructureCaptureTable, geometry: StructureGeometry): StructureEncodeResult;
  };
  /** 与既有回车规则合并的基底（只做加法） */
  readonly baseIndentPatterns?: () => BaseIndentPatterns;
  /**
   * 结构残缺的上屏方式。**补掉 `tree-sitter/providers.ts:378`（onSyntax）与 `:385`（onSyntaxClear）
   * 那两处 `if (languageId === ERB_LANGUAGE_ID)`**（v1.0 写"一处"，实为两处）：
   * 宿主不再知道"哪门语言用哪套文案"，只调用运行时给的这一枚。
   */
  readonly presentSyntax?: (faults: readonly StructureSyntaxFault[], truncated: boolean) => void;
  readonly clearSyntax?: () => void;
}
```

## 4.4 门控 `language-availability.ts`

> **落地偏离（2026-10-27，LAU-3 框架批）**：门没有独立成文件，而是住在 `monaco/language-registry.ts`
> 里。理由是一条实测闸：开机静态图 194 文件**顶格零余量**（`ps10-eager-graph.test.ts`），而门必须在
> 第一次认领之前装好 ⇒ 它天然属于开机图，新增一个文件就要抬一格上限。**语义与本节逐条一致**
> （纯谓词、门开关不重注册、`plaintext` 兜底、已认领 model 不回头改语言），只是住址不同：
> `installAvailabilityGate` / `isAvailable` / `availableLanguageDescriptors` /
> `keepClaimedLanguageWhenGated` 都在注册表那一枚里，缺省谓词读切流三档
> （`kojo2StageAllowsLegacy`）。`App.tsx` 装门那一版实测 195 文件 / 2,913 KB（越闸），已撤。

```ts
/** 由设置页注入（纯谓词，注册表不读设置、不订阅） */
export type AvailabilityGate = (descriptor: LanguageDescriptor) => boolean;

export function installAvailabilityGate(gate: AvailabilityGate): void;
export function isAvailable(descriptor: LanguageDescriptor): boolean;   // 缺省 = 全部可用
```

- `descriptorForPath` / `languageIdForPath`（今日在 `monaco/language-registry.ts:98-113`，按注册序首次匹配、
  `plaintext` 兜底）与选择器列表统一走 `isAvailable`；
- 门关着 ⇒ 认不出 ⇒ `plaintext` 兜底（与今天认不出的文件完全同一条路，不会半死不活）；
- 门开 / 关**不重注册**，只影响下一次认领；
- **已打开的 model 不回头改语言**（v1.1 补）：门一关就把在编文件刷成 `plaintext` 会让作者当场丢高亮与
  四面，比"这一层暂时不可用"严重得多。口径＝已认领的 model 保持原语言、只是结构层按降级台账停用；
  下一次打开才走门。这条要写成测试（关门 → 在编文件语言 id 不变、新开的落 `plaintext`）。

## 4.5 槽位契约（不变）

`ui.editor.languageService` 保持"单槽 + `kind` 判别 + `EditorDocumentIdentity`"的形状，`EDITOR_SEMANTIC_TOKEN_TYPES` 三值不动（legend 在 `plugin-api/src/slots.ts:758`）。
ERB 与 kojo2 的差别只在**供方住在哪**：LAU-4 把 ERB 的 11 枚 provider 从宿主搬成插件供方
（**第一步已落 `cca040fb`**：同符号高亮 / 扩选两条腿——判据住 `@kojo/erb-lang`、供方是
`@kojo/plugin-erb-lang`，两门语言已同用一条槽、同一份契约），彻底收口后宿主只剩"注册一次 provider"。

**与 SDK B0–B5 的实际进度对账（v1.1 补，决定 LAU-4 能不能排）**：B0 已把该槽扩出 4 个 `kind` + 4 条数据腿
（`8f74dae5`）；B1 已建 `@kojo/kojo-lang` 并搬走 symbols / declarations / sourcemap / expand-view / constants
（`e4477343`）；B2 接线 5 项**已全部接上**（`references` 由 B3e、`foldingRange` 由 B3h）；B3a–B3j 已落（B3d 起
签名帮助 / 格式化也由插件应答；B3g 行上注解、B3h 折叠区间（宿主预取结构快照随请求递下去）、B3j 一键迁移
code action 的判据也进包；B3i 起缩进 / 回车判据住 `@kojo/kojo-lang/indent`，宿主只装配）；
**B4（`ui.monaco.language`：Monarch / 主题 / 缩进 / 回车进插件）与 B5 已按两段推进**：B4 done
（`7f02ff73` / `f0be5efb`，变基后 `5f70b9ae`）——2.0 的 Monarch / 语言配置 / 主题声明进 `@kojo/kojo-lang`，
宿主只剩唯一落点 `monaco/monaco-language-surface.ts`；B5a done（`9fd1e700` / `d0761751` / `a221954d`）
——`@kojo/kojo-sdk` 立包 + 角色表搬家 + conformance 三列共享 golden；**B5b（删宿主直装残留）仍阻塞
于 B3 余项**：宿主直装语言面已收窄（B3c–B3j 后未逐文件重数）、装配点 13 条 `installKojo2*` 调用
（逐条见 `d0761751` 的回执表；B3g–B3j 后其中四条只剩装配与翻译）。
今天这 11 枚是 `registerForLanguageServices`（`register-dialects.ts:32-53`）按 descriptor 的
`languageServices: true` 或点名的 `slotServices` 铺下去的**通用** provider；ERB 在此之外还有一批
自己的宿主内 provider（`monaco/erb-*.ts` 共 26 个文件：补全 12 个分面 / 重命名 / 调用层级 / 实现 /
指令 / `#DIM` 与标签导航 / 回车规则；高亮与扩选的判据已搬进 `@kojo/erb-lang`，这两枚只剩翻译），
kojo2 侧同理（`monaco/kojo2-*.ts`，实测 21 文件 / 7,634 行）。
⇒ **LAU-4 的前置是 B4/B5，不是 LAU-3**；在 B4/B5 落地前谈"宿主只剩注册一次 provider"是空的。

## 4.6 `injection`：`@原生` 体内不再是黑块（D14 / LAU-6）

**问题**：`@原生` 是逃生舱（spec §8.5），体内是底层 ERB。今天整块不透明——注释不变灰、`#DIM` 不高亮、
控制流块不折叠、`@函数` 不跳转。作者用得越多，编辑器在这块越"瞎"，而这恰好是最需要导航的代码。

**为什么以前判"不做"**：web-tree-sitter 不支持 tree-sitter CLI 的 `injections.scm`（那是高亮工具的能力，
不是 runtime 的）。但 **runtime 有等效能力**——`ParseOptions.includedRanges`，文档原话是
"parse only a *portion* of a document but still return a syntax tree whose ranges match up with the
document as a whole"。**坐标天然对齐，不需要任何平移**。

**机制（三步，宿主零语言知识）**：

1. descriptor 声明注入关系——**是数据，不是 `if`**：

```ts
interface InjectionSpec {
  /**
   * 主树里触发注入的节点名。kojo2 的**真名是 `native_body`**（`kojo-syntax-tree/grammar.v2.js:167`；
   * 头是 `native_head` `:254`、外置行记号 `native_line` `:113`，整个构造是带 `field('open')/field('body')`
   * 的通用 `block` `:133`，节点类型见 `src/node-types.v2.json:45,87,331,722,726`）。
   * ⚠ v1.0 写的 `native_block` **全仓零命中**——按那个名字写 DoD 里的 grep 会假绿。
   */
  readonly hostNode: string;
  /** 子语言 id，如 'erb' */
  readonly languageId: string;
}
// LanguageDescriptor 新增：
readonly injections?: readonly InjectionSpec[];
```

> **v1.2 收口（2026-10-28）**：v1.1 草图里的 `bodyPath?: string`（"取哪个子节点作为注入体"）
> **已删**——实现从未接过它，也没有任何语言需要它（宿主节点本身就是纯净的体容器）。
> 按"零消费方不留形状"的口径（同 `KojoSlotSemantics.chara`），等真有"宿主节点里夹着别的东西"
> 的语言再加，不加一条没人走的可选路径。

2. 主树返回后，宿主按 `injections` 找到 `native_body`，取其 body 的**绝对区间**，
   向 `erb` 的 runtime 发一次 parse（带 `includedRanges`）。
3. 子树 tokens 在区间内**覆盖**主树的 `role.raw`；区间外一个字节都不动。

**为什么不用"截取子串再 parse"**：那要手工加 offset，且换行与 UTF-16 折算会出错。`includedRanges`
用的是同一份文本的绝对偏移，返回的 tree 坐标就是主文档坐标——这是选它的全部理由。
（API 可用性已核：`web-tree-sitter@0.27.1`，`node_modules/web-tree-sitter/web-tree-sitter.d.ts:93,111,193`
的 `ParseOptions.includedRanges?: Range[]`。）

**✅ 探针已跑（LAU-6a 已交付，`tools/inject-probe.mjs`，dev `45d18791`）——判决：LAU-6 可排，但区间口径必须写死**：
`includedRanges` 可用不等于"任意字节区间都能解"。ERB 侧三条事实决定子区间的取法——
① `_newline` 是**结构 token**（`erb-syntax-tree/src/grammar.js:207`），函数体必须以 `_newline` 开头（`:213-219`）；
② `[SKIPSTART]` / `[SKIPEND]` 只被 external scanner 在**行首**整行吞掉（`src/scanner.c:15,52-68,100-142`、`skip-marker.h`）；
③ 注释行与指令行的规则按 `[^\r\n]*` 限定（`grammar.js:311,313`）。

实测 8 个语境 × 5 种取法 = **40 组**（语料不在位 ⇒ 6 份夹具 + 仓内真 ERB 2 份：`valid-structure.erb` 62 行、
`eratw-adapter/src/scaffold` 里的 `日常指令.erb`），合格线 = ERROR / 坐标错位 / 越界 / 与"去缩进当纯 .erb 解析"基准的
MISSING·类型计数·缩进面偏差**全为 0**：

| 取法 | 结果 | 现象 |
|---|---|---|
| ① body 节点原始字节区间 | **✗** | kojo2 的 `native_body` **恒不含末行换行** ⇒ 末行收束词（`ENDIF`）落 MISSING，三个语境各中一处 |
| ② 同一区间、仅在末行换行后收口 | **✗** | 起点不在第 0 列，行首假设仍破 |
| ③ 整行对齐（体首行第 0 列 → 末行行尾含换行） | **✗（差一口气）** | 唯一不过的是"body 直达 EOF 且文件无末行换行"那一枚用例 |
| ④ **整行对齐 ＋ EOF 无换行时补虚拟换行** | **✓ 全绿** | 与基准逐项相等（ERROR 0 / MISSING 偏差 0 / 类型差 0 / 缩进面偏差 0） |
| ⑤ 任意字节切（首行正文 +2 / 末行正文 −3） | **✗** | 结构塌陷：`skip_block` 解体、区内 `@` 行被当 `function_block`，类型计数差 **52** |

⇒ **写死成规格**：注入区间 = `native_body` 体首行第 0 列 → 体末行行尾**含换行**；体直达文档尾且无末行换行时，
按宿主 `parseStructureText` 的既有口径**补一枚虚拟换行**（④ 就是③ ＋ 这一步，缺它就不是全绿）。
其余四条读数：坐标 **40 组全 0 错位、0 越界** ⇒ 子树坐标天然等于主文档绝对坐标、**不平移**（D14 的核心主张证真）；
含代理对的语境 UTF-16=26 / UTF-8=54 仍 0 错位 ⇒ **`StructureRange` 用 UTF-16 码元口径**（与 Monaco 一致，不许按字节换算）；
`[SKIPSTART]` 嵌套与深缩进（8/12 列）两个风险用例**证真**（体内照常成 `skip_block`；extras 吃空白后与基准相等）；
着色/折叠/缩进/残缺**四面**都在注入子树上跑通（一枚语境 highlights 57 / folds 22 / indents 37）。
另核掉一条悬案：**出货 `tree-sitter-erb.wasm` 与 `grammar.js` 是同步的**（现算 wasm/parser.c/grammar.json 同指
`5b509736`；`5b509736..HEAD` 只有 `237c62c9` 动过 `grammar.js`，那 7 行**全为注释**；97 条可见规则 0 缺失于 wasm 类型表，
三条行为探针各 ✓）⇒ 没有重生成欠账。工具本身退出会撞 V8 Zone OOM（固定 rc=3，判读以 stdout 为准），见 PITFALLS 209。

**协议改动（additive，不改形状）**：

- `StructureParseRequest` 加 `includedRanges?: readonly StructureRange[]`（缺省 = 全文档）——
  **已并入 §4.1 的签名**，不在本批之外另开一处；`StructureRange` 的定义也在那里（索引与行列都要给，
  只给行列会让 worker 再做一次全文扫描）。
- 结果不变：`tokens` 一律绝对坐标，宿主不需要知道"这是子树的"。
- 降级：子树失败 ⇒ 保留主树的 `role.raw`，报 `injection/child-failed`，**主树四面照常**。
  ⚠ `injection/*` 不在今日 `DiagnosticCode` 的闭集里（既不是 `core/<area>/<name>`，也不在适配器命名空间
  `unit|event|symbol|text|variant|overlay|raw` 之内），要先按 §5.5 的口径扩闭集，别直接字面量上屏。

**成本与边界**：

| 项 | 读数 / 口径 |
|---|---|
| ERB wasm（1,030,545 B） | **只在文件真出现 `@原生` 时懒加载**（`injections` 非空 + 主树命中 `native_body`），无 `@原生` 的文件零请求 |
| 额外 parse | 只解析 body 区间（通常几十行），比主树小一个量级 |
| 合并 | 区间覆盖，O(tokens)；子树优先，主树 `role.raw` 兜底 |
| 只影响编辑器面 | 着色 / 折叠 / 缩进 / 残缺。**编译产物仍按 spec §8.5（`:1045-1073`）的五条去缩进规则走，injection 不参与 codegen** |
| 缩进 | `@原生` 体内的前导空白**实测**被 ERB 文法的 extras 吃掉、行节点与"去缩进基准"逐项相等（深缩进 8/12 列两例皆 ✓，LAU-6a）⇒ **不需要先去缩进** |
| `[SKIPSTART]` | ERB 文法内部已有 `skip_block`（external scanner 一次吞掉，`scanner.c:52-68,100-142`）；**实测**嵌套在 `@原生` 里同样生效（LAU-6a 用例 D/G），前提是区间整行对齐——按任意字节切会解体（用例⑤） |
| 不做递归注入 | `@原生` 里不再出现 kojo——逃生舱里不该有逃生舱 |

**验收**（LAU-6 的 DoD）：

1. 含 `@原生` 的文件：体内 `;` 注释有 `role.comment`、`#DIM` 有 `role.directive`、`IF/ENDIF` 可折叠、`@函数` 可跳转。
2. 删掉 `@原生` 后 ERB wasm 不再被请求（网络面板断言）。
3. 子树 parse 失败时，主树四面全绿 + 一条 `injection/child-failed`，不整档停用。
4. `grep -rn "native_body\|native_head" packages/app/src/monaco/` 只命中 descriptor 的 `injections` 数据，
   宿主无节点名硬编码（v1.0 写的是 `native_block`，那个名字不存在，grep 恒绿无意义）。
5. **LAU-6a 探针先行且出读数**：整行对齐的 `includedRanges` parse 出四面；`[SKIPSTART]` 嵌套与深缩进
   两个用例各有结论（过 / 不过 + 现象）。探针不过 ⇒ LAU-6 退回设计，不进实现批。

---

# 第三部分 多 era 方言层（DIALECT）

## 5. 根因：适配的单元选成了「语言」

四条实测事实（v1.1：出处逐条标注——第 1 条是 `ab1c5146` 的**修前**状态与当时**现存**的三处同类点
（**该三处已由 LAU-1a `4c1487c4` 收掉，改口见其下**），
第 2、3 条出自 `packages/plugins/erafl-adapter` 实现盘点，第 4 条是适配器清单），
一个都不是"还没做"，而是"做错了"或"只做了一半"：

1. **宿主把 2.0 的 adapter 写死成 eraTW** —— **这一条已于 2026-10-24 修掉**（`ab1c5146`；修前"写死"为当时现状）。
   今天 `ui/editor-pane/use-monaco-instance.ts:283` 是
   `ensureGlobalProviders({ kojo2Adapter: () => kojo2AdapterForProject(kernel.project.current()) })`：
   按**当前项目**的 v1 `adapterId` 从组合根登记簿现取，取不到 ⇒ `null`
   （`bootstrap.ts:45-58`，注释原话"不猜：宁可零候选，不借别游戏的事实"）；
   `plugins/kojo-lang/src/plugin.ts:73-77` 还会再按 `adapter.id === request.project.adapterId` 复核一次。
   ~~**但同一类 bug 还剩三处**~~ ⇒ ✅ **三处已由 LAU-1a `4c1487c4` 收掉**，形态统一成
   "组合根按当前项目取 2.0 事实的端口，取不到给 `null`/`undefined`，绝不回落 eraTW"：

   | 位置 | v1.1 记的行为 → **今天的实现** | 后果（已消） |
   |---|---|---|
   | `ui/App.tsx:406` / `:421`（迁移向导） | 无条件 `import('@kojo/plugin-eratw-adapter')` 取 eraTW 九事件 ⇒ **改调 `kojo2MigrateEventNames(project)` / `kojo2MigrateEventArgs(project)`**（`App.tsx:2384-2385`，键＝当前项目的 `adapterId`） | 给 eraFL 工程做 v1→2.0 迁移时用的是 eraTW 词白名单与参数形状 |
   | `ui/App.tsx:237-249`（存储注入） | 无条件 `ERATW_GAME_ADAPTER.storageClasses` 与 `gameFingerprint.digest` ⇒ **改调 `kojo2StorageFacts(project)`**（`App.tsx:250`） | 存储注入的槽位与指纹与所开项目无关 |
   | `ui/kojo2-project-scan-adapter.ts:48-51`（默认装载器） | 无条件 `loadEratwGameAdapter` ⇒ **改走 `loadAdapter: () => kojo2AdapterForProject(kernel.project.current()) ?? undefined`**；另新增 additive 的 `kojo2ProjectFactory`，扫描器按项目重组而非按模块单例 | 2.0 项目扫描对**所有盘**都用 eraTW 事实 |

   ✅ `bootstrap.ts` 的 `'erafl'` **字面量**也已泛化：改成对 `adapter-manifest.ts` 的循环（条目自带
   `load()` / `auditWord` + 导出存在性卫语句），"宁缺勿错"的语义逐字保留，游戏名从此只住在清单
   （`tools/audit-decoupling.mjs:69,78-85` 的法定落点）。⚠ **这条从来不是错事实**（v1.1 的判断照旧成立：
   它是"加一个 era 要改宿主"的形态问题，不是"给错事实不报错"的语义问题），别把它记成 bug 修复。
   无 2.0 面的四家适配器在这三个端口上**拿到 `null`/`undefined`**（不借 eraTW），各有一条测试钉住。
   错误的事实**不报错**、只给出"看起来对、其实属于另一个游戏"的提示——这句判断仍然对，只是
   **今天已经没有这样的落点**；下一批要防的是 LAU-D2 接线时把它重新引进来。

   （v1.1 原文如下，保留作对照：`ui/App.tsx:406` / `:421` 无条件 `import('@kojo/plugin-eratw-adapter')` 取
   `ERATW_EVENT_NAMES` / `projectEventArgs(ERATW_EVENT_CATALOG)`；`ui/App.tsx:237-249` 无条件取
   `ERATW_GAME_ADAPTER.storageClasses` 与 `gameFingerprint.digest`；
   `ui/kojo2-project-scan-adapter.ts:48-51` 默认装载器 `loadEratwGameAdapter` 无条件 eraTW。）
2. **eraFL 的口上主战场是 XML**（`<command com="300" name="会話" kojoPlace="TOP">`，出处
   `packages/plugins/erafl-adapter/src`），ERB 侧只剩一个注册壳。于是 2.0 的 `# 机` / `@织` / `# 对照表` / `# 池` / `选项`
   在作者真正写东西的地方**没有落点**；照抄 eraTW 那 16 件，作者打开口上 XML 会发现"什么也没变"。
   （适配器实现里还有一条更硬的事实：eraFL 的九事件里**只有 4 个是引擎事件**，其余五个是
   eraFL 自己包的一层——这正是"事件目录必须是数据"的直接证据。）
3. **事件架构因 era 而异**：eraTW-family 唯一函数 / eraSQN 共享 `EVENTTRAIN` / eraFL `RESULTS` 元数据 /
   eraKoumakan `KOJO_MESSAGE_*`。这是**同一个概念的不同落点**，不是几种语法。
   ⚠ v1.0 这条有两处失真，已改：① 说"四种"却列了五项；② 末项 `eraNTR 无口上层` **在本仓无据**——
   `eraNTR` 全仓除本文件外零命中，六个适配器是 eratw / erafl / eraakumamaid / erakoumakan / erasqc / eratohok
   （`adapter-manifest.ts:49-103`），而"eraSQN 共享 `EVENTTRAIN`"也只是 spec §10.5 里的举例、不是已适配事实。
   早期交接件里**没有**跨 era 事件架构分类（只有 eraFL 四处结构差异）。
   结论（同一概念、不同落点 ⇒ 归事实面而非语法）不变，但论据只保留已适配的四个 era，
   跨 era 分类要立论得另做取证（属 RESEARCH，不属本稿）。
4. **六个适配器里四个没有 2.0 面**（v1.1 新增，直接决定 §5.6 / §8 的排期）：

   | 适配器 | v1 行数 | `src/kojo2/` | 2.0 状态 |
   |---|---|---|---|
   | eratw | 11,167 | 16 文件 / 2,666 行 | 全量（事件目录 / 领域符号 / 演出 / profile+resolve / 存储 / 程序特性 / 集合 / 表·池·选项·foreach 落点 / backend / capabilities），静态注册 `bootstrap.ts:61,138` |
   | erafl | 2,858 | 9 文件 / **1,211** 行（v1.1 取证时 1,205；`e196d384` 改 `kojo2/capabilities.ts` +6） | 刻意最小（backend / capabilities / domain-symbols / event-catalog / presentation / profile / program / storage）；**无**集合·表·池·选项·foreach 落点；~~无 conformance 夹具~~ **已由 LAU-FIXTURE `b9e87b2e` 补上**（38 例 / 128 断言 + 43 份夹具，见 §5.6 判据 2；handoff `:275-281` 那行已销） |
   | eraakumamaid | 4,160 | **无** | 仅 v1 |
   | erakoumakan | 1,611 | **无** | 仅 v1 |
   | erasqc | 1,432 | **无** | 仅 v1 |
   | eratohok | 1,610 | **无** | 仅 v1 |

   ⇒ 「强制绑定 + 无回落」（D12）对 2.0 面**已经是现状**（`kojo2AdapterForProject` 给 `null`），
   不是新风险；新风险是把**事实面整体**改吃方言契约后，这四家连 v1 槽今天还在供的
   补全 / 悬停 / 规约 / 条件矩阵 / 糖一起丢掉。§5.6 与 §8 因此明确：**LAU-D2 只动 2.0 语言面，
   v1 的十二个可选槽一行不改**。

一句话：**每来一个 era 就"再适配一遍语言"，是因为把适配单元选成了语言。**
语言只有一门；该被适配的是**方言**。

### 5.1 三条正交轴（本节地基）

| 轴 | 决定什么 | 谁提供 | 变了改什么 | 变多贵 |
|---|---|---|---|---|
| **语法** | 这串字符是不是合法 kojo2 | 语言包（grammar + queries + Monarch） | 改语言（罕见，且只增不改） | 高（回归面全仓） |
| **载体** | 这段文字写在哪（ERB 内联 / XML / 将来的别的） | descriptor（每载体一枚，已有 `languages.ts`） | 加一枚 descriptor | 低 |
| **方言** | 这些名字 / 事件 / 演出在这个游戏里是什么意思 | 方言包 ＝ 既有 2.0 `GameAdapter` 的**数据取值**（D13 / §5.2，不新造契约） | 加一个方言包 | **目标是零**（不动宿主、不动语法）。⚠ **今天不为零**：`bootstrap.ts:250-263` 用 `'erafl'` 字面量挑包 ⇒ 加一个 era 仍要改宿主一行；LAU-1a 把它泛化成对 `adapter-manifest.ts` 的循环之后，这一格才真是"零" |

**关键推论（D10）：方言不进 wasm、不进 worker、不改语法。**
着色 / 折叠 / 缩进 / 残缺只认语法，与方言完全正交；方言只影响"事实类"服务（补全、悬停、签名、
诊断、符号、跳转）。所以"适配 N 个 era"永远是**加数据**，不是加分支、不是分叉语言——
这就是"根源性解决"的全部含义。反过来，一旦让方言影响 tree-sitter 查询，N 个 era 就有 N 份
查询与 N 倍回归面，那是把问题从"配置"升级成"代码"。

### 5.2 契约：不新造 `dialect.ts`，只给既有 `GameAdapter` 补一格

**v1.1 全节改写（D13）。** v1.0 在这里新造了一套 `DialectManifest` / `DialectFacts` / `DialectEvent` /
`DialectSymbol` / `DialectPresentation` / `DialectProfile`。逐格取证后的结论是：**它不是新层，
是既有契约的有损重投影**——2.0 的 `GameAdapter`（`kojo-core/src/adapter.ts:40`，1,410 行，自带
`validateGameAdapter` `:659` 与 `ADAPTER_VALIDATION_CODES` `:576-593`）已经把事件目录、领域符号、演出、
profile、存储类、程序特性、编码策略、分层策略、能力、源映射、conformance 套件全表达过了，
也正是 spec §10.1（`:1394-1412`）那十五格的实现。按 v1.0 落地，仓里会同时存在**三套**游戏事实契约
（v1 `plugin-api/src/game.ts:755`、2.0 `kojo-core/src/adapter.ts:40`、新 `dialect.ts`），
而信息量最少的是新的那套。所以本节改成三条。

#### ① 事实面 = 既有 `GameAdapter`，沿用不改名

语言服务读的就是 `kojo2AdapterForProject(...)` 交出的那枚（`bootstrap.ts:45-58`），不另立 `DialectFacts`。
**下面这些格在 v1.0 的投影里丢了，而它们恰好是本方案自己主张的东西**——LAU-D1 的契约评审逐格对账：

| 既有字段 | 位置 | 为什么不能丢 |
|---|---|---|
| `domainSymbols.unknown: 'error' \| 'raw'` | `adapter.ts:239` | `checkSymbol`（`:1325-1338`）读的正是它——**「错事实必须报错」的 fail-closed 旋钮**。丢了它，§5.4 第 2 行那条解法就没有执行点 |
| `PronounSymbol{role,engineRef,requiresView,viewBound,family}` / `AttributeSymbol{family,index,valueKind,readonly}` / `NameFunctionSymbol{engine,args,returns}` / `DomainVariableSymbol{valueKind,arraySize,elementKind}` / `speakers: SpeakerSource` | `:146-160` / `:163-170` / `:209-214` / `:196-206` / `:221` | 代词落点、属性族、名字函数各有各的结构；塌成 `{name,kind,target}` 之后「`{她}` 落到哪」「这个族有没有索引位」都答不出来 |
| `HeartPresentation` / `ColorPresentation` / `FacePresentation`（含 `calls: FaceCall[]`、`maxArgs`、`placeholder`）/ `OptionsPresentation` / `faceTemplates` / `hintNames` | `:284-293` / `:295-302` / `:304-323` / `:325-337` / `:348-357` / `:378` | v1.0 的 `DialectPresentation.target: string` **一格装不下**这四种结构（心形分对白/旁白 × wait/continue，颜绘带调用表与占位，选项带 status/button/input/result/maxPerScene） |
| `StorageClasses{classes: StorageClassSpec[], slotStability}` | `:56,384-405` | 值集与 v1.0 提案相同（`scene/save/session`，见 `ast.ts:35`），但 `engine/init/persisted/slotPrefix/description` 与 `slotStability` 全丢——`App.tsx` 的存储注入今天就在读它（LAU-1a 后走 `kojo2StorageFacts(project)`，`App.tsx:247-262`；宿主只保留 adapter 真声明过的存储期，没声明的**绝不替它补**） |
| `GameFingerprint{digest, entries: FingerprintEntry[]{kind,value}}` | `:84-99` | v1.0 塌成 `string` 之后，「换盘 / 换汉化检测」（v1.0 自己写的用途）失去依据；`App.tsx` 的存储注入读的是 `.gameFingerprint`（LAU-1a 后经 `kojo2StorageFacts(project)` 交出，`App.tsx:260`） |
| `encodingPolicy` / `layerPolicy` / `diagnosticNamespace` / `capability` / `sourceMap` / `conformanceSuite` / `foreachCollections` / `AdapterProfile.features` | `:68` / `:70` / `:72` / `:74` / `:76` / `:78` / `:66` / `:275` | 整块丢失。其中 `encodingPolicy`（eraFL 是 UTF-8 BOM）与 `layerPolicy` 正是 eraFL 能接进来的前提 |
| `EventSpec` 的 `engine` / `priority` / `forced` / `weavable`、`EventCatalog.defaultEvent`、`EventArgumentSpec.required` | `:125,128,132,134` / `:140` / `:110-114` | v1.0 的 `DialectEvent` 只留了 `name/carrier/dispatch/params/guards`，把优先级模型与"必填实参"这类校验依据一起丢了 |

#### ② 两处命名 / 轴混淆必须按既有口径写

- `presentation` 的第四枚是 **`'options'`**，不是 `'choice'`：`PresentationFeature = 'heart' | 'color' | 'face' |
  'options'`（`adapter.ts:281`，键用在 `:359-363`），两个 frozen Record `PRESENTATION_UNSUPPORTED_CODES`
  （`:566-575`）与 `PRESENTATION_LABELS`（`:1355-1360`）都以它为键——改名会直接挂这两处。
  作者面名字是 `选项`（spec §10.2 `:1424`），三个层面对齐即可，不需要第四个词。
- **`dispatch` 不许把两条轴压成一条。** 既有契约里这是两件事：
  `EventDispatchModel = 'engine-dispatch' | 'label-dispatch' | 'hook'`（`:104`，挂在 `EventSpec.dispatch` `:127`）
  与 `LayerMode = 'unique' | 'shared-hook' | 'overlay'`（`:436`，挂在 `LayerRule.mode` `:441`，
  配 `LayerTarget = 'function' | 'event-hook' | 'kojo-overlay'` `:437`，汇总在 `LayerPolicy` `:444-447`）。
  v1.0 的 `dispatch: 'unique' | 'shared-hook' | 'overlay' | 'metadata'` 取了 `LayerMode` 的值、
  冠了 `EventSpec.dispatch` 的名、挪到事件粒度、丢了 `LayerTarget`、并删掉 `EventDispatchModel`——
  正好撞上 spec §10.5（`:1459-1470`）的明令：「事件监听的多定义、函数的同名、口上的覆盖层，
  三者不要混为一谈」。eraFL 的 `RESULTS` 元数据要表达的是**dispatch 模型**多一种取值 ⇒
  additive 扩 `EventDispatchModel`（`| 'metadata'`），`LayerMode` 一个字不动。

#### ③ 真正新增的只有「载体归属」一格

这是 eraFL 的 XML 面今天缺的东西，值得新造；作为 `GameAdapter` 的 **additive 可选格** `carriers?` 落地，
不新开契约文件：

```ts
export type DialectId = string; // 取值 = v1 `GameAdapter.gameId`（`plugin-api/src/game.ts:40`），不另立一套 id

/**
 * 载体绑定：**eraFL 的 XML 就是靠它进语言面**。
 * 宿主只用它做"这个文件属于哪个载体"的归属，不解释内容。归属规则是数据，住在方言包里。
 */
export interface CarrierBinding {
  readonly carrier: 'erb' | 'xml' | 'inline';
  /** 相对**项目根**（= `detect()` 认下的那个目录）的 glob */
  readonly glob: string;
  /** 该载体上哪些面由方言校验（缺省 = 全部事实类） */
  readonly validates?: readonly DialectFactKind[];
}

export type DialectFactKind = 'event' | 'symbol' | 'presentation' | 'storage';

/**
 * 一次语言服务请求的方言上下文：**宿主解析，供方只读**。
 * 没有 `fallbackDialect`——**没有默认方言这回事**（D12）。
 * `facts` 就是既有 2.0 `GameAdapter`（投影成只读类型，不重定义字段）。
 */
export interface DialectBinding {
  readonly dialect: DialectId;
  readonly facts: Readonly<Kojo2GameAdapter>;
  /** 事实版本：方言包升级 ⇒ 缓存失效，不必重启编辑器（沿用 `GameAdapter.version`，`adapter.ts:44`） */
  readonly factsVersion: string;
  /** 这份文件属于哪个载体（决定"事件名在哪校验"） */
  readonly carrier: 'erb' | 'xml' | 'inline';
}
```

`EditorDocumentIdentity`（今日在 `plugin-api/src/slots.ts:431-434`，只有 `languageId?` / `version?`）
增一格（additive，旧供方零改动）：

```ts
export interface EditorDocumentIdentity {
  readonly languageId?: string;
  readonly version?: number;
  /**
   * 这份文档的方言上下文。**缺省 = 未绑定**：供方必须按"无事实"降级
   * （返回空 + 一条 `core/dialect/unbound`），**不许回落到任何默认方言**（D12）。
   * ⚠ 这一格是**便利**，不是新真源：13 处语言服务请求今天就已经带
   * `readonly project: GameProject | null`（`slots.ts:453,469,595,648,698,788,827,891,935,984,1035,1079,1108,1276`），
   * `request.project.adapterId` 就是方言 id，`plugins/kojo-lang/src/plugin.ts:73-77` 已在按它失败关闭。
   * `dialect` 只是把"宿主解析一次、供方只读"这件事显式化，**不得**与 `project.adapterId` 分叉
   * （两者不一致即 `core/dialect/response-mismatch`，见 §5.4 第 2 行）。
   */
  readonly dialect?: DialectBinding;
}
```

> **v1 的十二个可选槽不在本节范围内**（`plugin-api/src/game.ts:782-831`：`functionFamilyIndex` / `variableSchema` /
> `conventions` / `conventionPolicy` / `kojoCallProtocol` / `kojoFaceTemplates` / `kojoInstructionTable` /
> `kojoLibraryTable` / `kojoMutatorTable` / `kojoCounterTable` / `nameGlossary` / `stateLinePresets`）。
> 它们服务的是 v1 糖与 ERB 面，**LAU 一行不改**；v1.0 的 `DialectFacts` 对它们零覆盖，
> 若按 v1.0 把事实面整体切过去，四个只有 v1 面的适配器（§5.1 事实 4）会连补全/悬停/规约/条件矩阵一起丢掉。
> 唯一例外是 `nameGlossary`（`:826`）——它与 2.0 侧的"日文原名走 aliases"是同一件事，
> 收敛方向记在 §8 的 LAU-D4，不在本批动。

### 5.3 解析链：方言从哪来（v1.1 改口：真源是已上线的识别链，不是新清单）

**为什么换真源**：v1.0 定的是「工程根 `kojo.project.json`」，但**这个文件在本仓不存在**（全仓除本稿外零命中），
而且它**没有落点**——`detect()` 认下的是**游戏目录**，游戏目录整体只读（AGENTS 铁律 5），
编辑器不会也不该往那里写清单；玩家/作者从别处拷来的盘上更不会有它。反过来，仓库里已经有一条
**带双闸、已持久化、且每次请求都在场**的识别链：

1. **真源 = `detect()` → `project.adapterId`**（`kernel/src/project.ts:44-108`）：内核轮询**全部**
   `game.adapter` 候选 → 逐个 `adapter.detect(rootDir)`（带证据，`adapter-contract.ts:17-22`）→
   0 命中报 `ProjectDetectionError`、>1 命中报 `AdapterConflictError`、恰 1 命中才 `loadProject`，
   并强制 `project.adapterId === gameId`（`:93-97`）。结果存进 `GameProject.adapterId`
   （`plugin-api/src/game.ts:40`）与 `RecentProject{rootDir,adapterId}`（`project.ts:5-9`），
   单一消费口径是 `activeGameAdapter()`（`plugin-api/src/active-adapter.ts:52-61`）。
   这不是"按内容嗅探"（§10 明确不做的那件事）——它是**已上线、有冲突闸、有证据链**的项目识别，
   架构见 `ARCHITECTURE.md:333-360 §5.7`。
2. **覆盖 = 作者工作区 `workspace.json` 的 `meta`**（additive）：真清单是
   `WORKSPACE_MANIFEST_FILE = 'workspace.json'`（`plugin-api/src/workspace.ts:22`，schema `:38-46`，
   写入 `kernel/src/workspace.ts:155,169,185`，向导 `kojo-project-kit/src/new-project-wizard.ts:215`），
   住在 `<workspaceRoot>/<projectId>/`，`meta: Record<string, unknown>` 天生可加格；
   `LAUNCHER-ARCHITECTURE.md:1951` 已经提议把 `adapterId` / `gameId` 放这里（设计态，未实现）。
   语义＝**显式覆盖**（作者说"这个工程按 eraFL 对待"），不是真源；与 `detect()` 结论不一致 ⇒
   `core/dialect/mismatch`（error），并且**以覆盖为准但同时报冲突**——冲突可见，才符合铁律 4「内核不静默」。
3. **文件里的 `# 方言 erafl`** —— **只是一条断言**：与解析结果不一致 ⇒ `core/dialect/mismatch`（error）。
   它不产生第三真源，作用是"这份文件自证我属于哪个方言"，孤立打开一个文件时也能一眼看出错配；
   **读数口径（v1.2 收口，2026-10-28）**：宿主**逐行扫描**取断言（`app/src/ui/dialect-binding.ts`），
   不走 tree-sitter CST——本层要被**同步**语言服务请求与诊断节拍调用，而 CST 在 worker 里异步往返，
   等一次 parse 等于把每次悬停排进解析队列；扫描只认文法 `decl('方言')` 的同一形状（行首 + 水平空白）。
   一份文件写出**多条互不相容**的断言时，宿主把全部断言交给 core，由 core 发
   `core/dialect/mismatch` 且**谁也不算自证**（不设"取首条"的静默裁决；同值重复＝与一条等价）；
4. **都拿不到 ⇒ 未绑定**：事实类服务全部降级（空结果 + 一条 `core/dialect/unbound`），**绝不猜**。
   对 2.0 面这就是今天的现状（`kojo2AdapterForProject` 返回 `null`，`bootstrap.ts:45-58`）；
5. **状态栏常显当前方言**（`eratw` / `erafl` / `未绑定`）——作者不必猜，评审也不必问。

> **`# 方言` 是本方案唯一新增的语法**（用户 2026-10-25 定名）。三个约束写进 spec §3：
> ① 可选；② **只断言不赋值**（不产生第二真源）；③ 与解析结果不一致是 **error**，不是 warning。
> 其余一切方言差异**都不进语法**——这是"根源性"与"又分叉一次"的分界线。
>
> ⚠ **它的代价要说清（v1.1 补，与 D10 / R6 的措辞直接相关；✅ 已由 LAU-SYNTAX `3a76d857` 照此兑现）**：
> `方言` 这个词位确实未被占用
> （core 侧 `kojo-core/src/tokens.ts:31 KOJO_DECL_WORDS = ['幕','视','机','变量','常量','表','池','模']`，
> 未登记的 `#` 词今天会报 `core/decl/unknown`，`diagnostics.ts:32`），但它在 kojo2 侧是**编译进文法**的：
> `kojo-syntax-tree/grammar.v2.js:218-229` 逐词生成 `decl(word)`，词被烧进 RegExp token（`:70`）⇒
> 加它**必须重跑 `packages/kojo-syntax-tree/tools/build-v2.mjs` 重生成 `tree-sitter-kojo2.wasm`**
> （改前 47,116 B ⇒ **改后 48,057 B，棘轮随组长点头抬到该值**，＋941 B＝一条 `dialect_decl` 规则 + 词表；
> 归因写在 `v2-wasm-size.test.ts` 注释与提交信息里，照的是该测试自己定的规矩）。
> 第三个消费方是 Monarch 词表（`app/src/monaco/kojo2-lexicon.ts:37` →
> `kojo2-language.ts:308 declWords`）；另注意 `kojo2-format.ts:55,77` 按**位置**解构这个数组
> （`[, , , , , TABLE_WORD, POOL_WORD, TEMPLATE_WORD]` 与 `.slice(0,5)`）⇒ **只能追加在尾部**，
> 插队会静默改格式化行为——落地按此办理（`方言`＝下标 8，`DIALECT_WORD = KOJO2_DECL_WORDS[8]`，
> 前五格与 `slice(0,5)` 一字未动）。重跑还顺手抓出一处**产物陈旧**：`src/grammar.v2.json` 的词表顺序
> 落后于 `grammar.v2.js`，`wasm` / `parser.v2.c` / `node-types.v2.json` 三件则逐字节可复现（`87b7e26c`）。
> spec §12.3（`:1837`）另有「不在六部语料没有证据时引入语法方言」这条边界——
> `# 方言` 是**跨方言共用的断言记号**、不是某个方言的语法，需要在 spec 里把这句区分写明，否则会被这条挡住
> （**这句区分仍未写进 spec，属 LAU-D1b 的前置**）。

### 5.4 五个根因 → 五条语言层解法

| # | 问题 | 根因 | 语言层解法 | 落点 |
|---|---|---|---|---|
| 1 | 宿主按 eraTW 取事实（**主入口 `ab1c5146` 已修；三处惰性装载 + `'erafl'` 字面量也已由 LAU-1a `4c1487c4` 收掉**） | 方言没被当成"工程属性"下传，装载点各自 `import` 了一枚具体适配器 | 方言由识别链解析（`detect()` → `project.adapterId`）、随每次请求下传（请求今天已带 `project`）；`dialect` 缺省即未绑定 | ✅ `App.tsx:237-249,406,421` 与 `kojo2-project-scan-adapter.ts:48-51` 改按当前项目取（端口：`kojo2StorageFacts` / `kojo2MigrateEventNames` / `kojo2MigrateEventArgs` / `kojo2AdapterForProject`）；`bootstrap.ts` 的 `'erafl'` 字面量泛化成对 `adapter-manifest.ts` 的循环。**未做**：`dialect-resolver.ts` 已存在（D1a `875b05d3`）但**还没有消费方**——解析链上屏＝LAU-D1b |
| 2 | 错事实不报错 | 供方拿不到"该用哪套事实"，也无从自证 | 每个事实类响应带 `dialect` + `factsVersion`；宿主对账，不一致即诊断。**并把 `domainSymbols.unknown='error'` 当默认**（`adapter.ts:239`，`checkSymbol` `:1325-1338` 已实现）——这枚 fail-closed 旋钮是"错事实必报错"的执行点，v1.0 的投影把它丢了 | `core/dialect/response-mismatch`（诊断码需先扩闭集，见 §5.5） |
| 3 | eraFL 主战场是 XML，2.0 无落点 | 叙事面被绑死在"ERB 内联" | `carriers` 声明 + XML 载体的**等价面**：`command` / `name` / `kojoPlace` 由方言的事件目录校验 | `GameAdapter.carriers?`（additive）；`kojo-xml` descriptor 接 `dialect`；XML 面今天的事实源是 `plugin-api/src/kojo-xml.ts` + `WellKnownServices.KojoXml`，接线要对齐它 |
| 4 | 事件架构因 era 而异 | 事件目录是 adapter 内部实现，不是语言面 | `eventCatalog` 进语言面：`# 机` / `@织` 的名字由方言校验，未知即 error；同名多定义是否合法由**分层**决定 | `EventCatalog`（`adapter.ts:137-141`，已有）+ `EventDispatchModel` additive 扩 `'metadata'`（`:104`）；**不要**动 `LayerMode` / `LayerTarget`（`:436-437`，spec §10.5 明令三者不混） |
| 5 | 每加一个 era 就再适配一遍语言 | 适配单元选成了语言 | 语法 / 载体 / 方言三轴正交，方言是纯数据 | 本方案全部 |

### 5.5 方言一致性体检（`dialect lint`）

打开工程跑一次，把"看起来对其实属于另一个游戏"的提示变成**可执行清单**：

**先对齐既有的诊断码纪律（v1.1 补，否则这一节的码一半落不了地）**：今天是两族、两套命名——
**core 族** = `core/<area>/<name>`，**闭集**（`kojo-core/src/diagnostics.ts:20-224`，"只增不改" `:14`；
严重度走 `CORE_WARNING_CODES` `:227-236`，判定 `isCoreCode` `:251`）；**适配器族** = `${ns}/${string}`，
`ns ∈ unit|event|symbol|text|variant|overlay|raw`（`:238-247`），具体清单是 `ADAPTER_VALIDATION_CODES`
（`adapter.ts:576-593`，spec §10.6 `:1472-1485`）——**这一族是"适配器数据自己不合格"的自检码，
不是"作者写错了"的码**。v1.0 把两族混用了，逐条改正如下：

| 检查 | 判据 | v1.0 写的码 | 改正后 | 理由 |
|---|---|---|---|---|
| 事件名 | 工程里出现的 `# 机` / `@织` / XML `command` 是否都在 `eventCatalog` 里 | `event/unknown` | **`core/event/unknown`**（新增进 core 闭集） | `event/unknown` **已被占用**：`adapter.ts:590` 是 `validateGameAdapter` 的自检码，语义是"适配器没声明事件目录"，与"作者写了不存在的事件"完全不同；同码两义会让 §5.5 的聚合与 §9-8 的错配断言都失真 |
| 事件落点 | `carrier` 与文件实际载体是否一致（eraFL 的 `会話` 写在 ERB 里就是错） | `event/wrong-carrier` | **`core/event/wrong-carrier`**（新增） | 作者面错误 ⇒ core 族；`event/*` 命名空间留给适配器自检 |
| 符号 | 出现的名字是否都在 `domainSymbols` 里（含日文原名别名） | `symbol/unknown` | **复用既有 `core/expr/unknown-symbol`**（`diagnostics.ts:48`，发射点 `adapter.ts:1325-1338`） | 已有同义码；再造一个 = 同一件事两处报，聚合纪律（下面）当场失效 |
| 只读别名 | `readonly` 符号出现在赋值左值 | `symbol/readonly-assign` | **复用 `core/expr/readonly-target`（`:43`）/ `core/expr/assign-to-constant`（`:42`）** | 同上 |
| 演出 | 用了 `@颜绘` 而 `presentation` 没声明 | `core/feature/unsupported` | **保留**（`diagnostics.ts:224`，`checkPresentation` `:1340` 已在发） | v1.0 这条本来就对；注意 core 是闭集 ⇒ 不能按方言扩，方言差异只能走 `AdapterProfile.features`（`adapter.ts:258-266`）表达 |
| 载体归属 | `carriers[].glob` 覆盖不到的口上文件 | `unit/unowned` | **`core/carrier/unowned`**（新增） | `unit/*` 今天 9 枚全是"适配器不完整"式自检码，把作者面错误塞进去会污染那一族的含义 |
| 等待 | 缺 `waitDefault` 且出现无 `续` 的台词 | `text/missing-wait-default` | **复用 `core/wait/no-profile`（`:94`）/ `core/profile/missing`（`:223`）** | 已有同义码；spec §10.2（`:1413-1432`）「缺 profile 报错、不静默选」的执行点就是它们 |
| 方言未绑定 / 错配 / 响应错配 | §5.3 第 2、4 级 | 无 `core/` 前缀的 `dialect/unbound`、`dialect/mismatch`、`dialect/response-mismatch`（v1.0 原文） | **`core/dialect/unbound`、`core/dialect/mismatch`、`core/dialect/response-mismatch`**（三枚新增进 core 闭集） | `dialect` 既不是 core 的 area、也不在适配器命名空间里，按今日 `DiagnosticCode`（`:249`）**根本过不了类型**；要么扩闭集（推荐，因为这是语言级事实），要么挂到 `variant/*` 名下（语义偏） |
| 注入子树失败 | §4.6 | `injection/child-failed` | **`core/injection/child-failed`**（新增） | 同上 |

⇒ LAU-D2 的第一步不是写检查，是**给 core 闭集加 6 枚码**（`core/event/unknown`、`core/event/wrong-carrier`、
`core/carrier/unowned`、`core/dialect/unbound`、`core/dialect/mismatch`、`core/dialect/response-mismatch`）
并同步 `isCoreCode` 与严重度表；第 7 枚 `core/injection/child-failed` 归 LAU-6。
「只增不改」意味着一旦加进去就不能改名，所以这一批要先过 D0 的契约裁决（§4 抬头）。
✅ **这六枚已随 LAU-D1a `875b05d3` 加进闭集**（`diagnostics.ts:246-307`，逐枚在声明处写清生产者与
同义既有码的分工，`core/event/unknown` 与自检码 `event/unknown` **并存、语义不同**；
`isCoreCode` 与严重度表同步：`core/dialect/unbound` 与 `core/carrier/unowned` 进 `CORE_WARNING_CODES`
（`:312-325`，降级面不阻断但必须可见），其余四枚（方言冲突 / 响应错配 / 未知事件 / 事件落点错）刻意留在 error 档）。**这是本批唯一抢在 D0 之前的落点选择**，
理由与代价见 §8.1 的偏差 1；改名窗口已关闭，后续批只能在这六枚的语义上写检查。

**呈现纪律**：按 `(诊断码, 方言)` **聚合**成一条 + 可展开明细，不是把 400 条同类波浪线糊满屏幕。
这条纪律与 `fallback.ts` 的去重键同一思路（数字归一），只是粒度按方言事实。

### 5.6 多 era 验收：方言矩阵

`tests/dialect-matrix.test.ts`：每个方言一枚 fixture 工程，**同一组断言跑 N 遍**（语法面 / 事实面 /
降级面 / 编码面）。四条判据：

1. **宿主里出现具体方言名或引擎词汇 ⇒ 红**。⚠ 断言走 `tools/audit-language.mjs`（新增），
   **不用裸 grep**，且必须继承 `tools/audit-decoupling.mjs` 的三条既有豁免口径：
   ① 行尾 `// audit-allow: <理由>` 豁免（`:133`）；② **注释行豁免**（`:37-47`）；
   ③ 组合根 / 适配器清单豁免（`:69,78-85`，本仓即 `adapter-manifest.ts` 与 `bootstrap.ts` 的装载点）。
   不豁免就永远红——**闸已落地（LAU-GATE `6ca3c4c3`+`7540b9ed`），基线现值＝M1 游戏名·引擎词汇 6 行 /
   M2 语言 id 分支 162 行 / M3 旧 token 名 254 行**（钉在 `tools/audit-language-baseline.json`，只降不升；
   LAU-3 框架批把 M2 从 164 收敛到 162——`tree-sitter/providers.ts` 的两处 `ERB_LANGUAGE_ID` 分支清零后重钉；
   M3 的 163 ⇒ 254 是 2026-10-27 六档主题批的 48 条 `kojo2.*` 配色规则，不是 LAU-3 的钱）。
   v1.1 草稿那句"裸 grep 命中 62 行（`eratw` 16 行 / 10 文件）"是**计数口径不同**：棘轮只数**代码行**，
   注释与 `audit-allow` 行不进账（`TALENT`/`CFLAG` 的命中几乎全在注释与补全说明里，如
   `erb-completion-bits.ts:25`、`erb-completion-families.ts:6-14`）。
   LAU-1a `4c1487c4` 已把 M1 打到 7 行——剩下的都在组合根装载点与 `erb-*` 语言面里。
   另一条真正的漏点没收（仍留给 LAU-D2）：`monaco/erb-language.ts:159` 的 Monarch 正则**硬写了整串 era 变量族**
   （`CFLAG|CDFLAG|…|MASTER|…|JUEL|CUP|…`），`plugins/erb-parser/src/undefined-name.ts:148-240`
   还有一份同族白名单——这两处是"引擎词汇住在语言面"的实证，要把它们外提到方言数据
   （`domainSymbols` / `variableSchema`），审计才谈得上零命中。
2. **方言 A 的 facts 喂给方言 B 的夹具 ⇒ 必须给出诊断，不许静默通过**（这是"错事实不报错"那类 bug 的
   回归测试）。**N 起步只能是 2**：有 2.0 面的只有 eraTW（全量）与 eraFL（最小面）——
   ✅ **eraFL 那列的夹具已由 LAU-FIXTURE `b9e87b2e` 补上**（`packages/plugins/erafl-adapter/tests/kojo2-conformance.test.ts`
   38 例 / 128 断言 + 43 份夹具，事实源取 eraFL 自己声明的 `eventCatalog` / `domainSymbols` / `storageClasses`，
   不是抄 eraTW；handoff `:275-281` 记的"缺夹具"已销）。⚠ 交付口径按本节要求＝
   **"eraFL 真支持的子集全绿 + 明确红名单"，不是全绿**；四枚真盘用例走环境变量 `KOJO_ERAFL_DIR`，
   未设时跳过（仓库不写死本机游戏目录）。第二列有了可比对象 ⇒ 矩阵可以排批，`tests/dialect-matrix.test.ts`
   本身仍属 LAU-D2。
3. **未绑定 ⇒ 事实类服务全空 + 一条 `core/dialect/unbound`**，且**不得**回落到任何默认方言。
4. **v1 十二个可选槽不退化（v1.1 新增）**：eraakumamaid / erakoumakan / erasqc / eratohok 四家**没有 2.0 面**，
   它们的补全 / 悬停 / 规约 / 条件矩阵 / 糖今天全靠 v1 槽（`plugin-api/src/game.ts:782-831`）经
   `activeGameAdapter()` 供。矩阵必须为这四家各跑一列**v1 面读数**，LAU-D2 前后逐格相等——
   否则"强制绑定 + 无回落"会把它们从"有全套 v1 事实"打成"什么都没有"，与"兼容更多 era"的目标相反。

这条闸就是"适配 N 个 era 不改语言"的守门人；它红的方式与 `language-parity.test.ts` 同构
（该测试确实在 `packages/app/tests/language-parity.test.ts`，取证方式是读文件、含"豁免不过期"判据），
不需要新的测试范式。

---

# 第四部分 封存层与 SDK

## 6. 封存层：命令式 Kojo（D7）

**不是版本开关，是另一门语言。** 理由：spec §0.2 明令"无版本声明、旧写法一律 error"，
在 2.0 里留 `if (version === 1)` 就等于把双模式装回去。

| 项 | 取值 |
|---|---|
| 语言 id | `kojo-legacy`。⚠ v1 **改名前**（LAU-3 之前）的 id 是 **`kojo-sugar`**（`monaco/kojo-language.ts KOJO_LANGUAGE_ID`），改 id 与改扩展名是**两笔独立代价**：所有按 id 注册 provider / 分支 / 存设置项的地方都要跟着走（§9-1 的闸基线＝M2「语言 id 分支」162 行，里面大部分就是这类 id 引用）。若只为封存，**保留 `kojo-sugar` 这个 id、只加 `availability:'legacy'`** 是更便宜的一条路，LAU-3 开工前二选一定案。**✅ 2026-10-27 定案（用户口径）＝改名**：语言 id 改 `kojo-legacy`，label 改「kojo1（封存）」；**插件 id / 包名 `kojo-sugar` 不动**。~~2.0 侧仍 import 它的词表~~ ⇒ **LAU-3b 解耦批已断**：ERB / kojo2 / 宿主共用的词表、词法、格式化全部迁到 `@kojo/kojo-vocab`（非插件包），本包只剩 v1 转译管线与它自己的宿主面，可随 kojo1 整体删除。旧 id 的兼容读在 `ui/language-mode-pref.ts`（存量覆盖表读时别名） |
| 扩展名 | `.kojo1`（见 §6.1；**2026-10-27 起封存层只剩这一枚**：`.kojo` 已让给 2.0。单一真源 `plugin-api/src/sugar.ts` 的 `KOJO_LEGACY_SOURCE_EXTENSION` / `KOJO_V1_SOURCE_EXTENSIONS`，2.0 是 `KOJO_SOURCE_EXTENSION` + `kojo-lang/src/constants.ts:23` 的旧名 `.kojo2`） |
| `availability` | `legacy` |
| `settingKey` | `ui.legacy-kojo-syntax`，**默认 false** |
| 设置页文案 | 「命令式 Kojo 语法（封存）—— 不再演进，仅保证旧文件可打开」 |
| 复用 | v1 的 `registerKojoLanguage`（Monarch / 配置 / 括号 / 回车规则）**一个字不删** |
| 结构层 | 复用 `kojo-runtime`（`tree-sitter-kojo.wasm` 821,724 B，**只在这门语言被打开时才装**） |

**sealed 的四条纪律**（写进设置页与诊断文案，不靠自觉）：

1. **不进 conformance 主线**，不参与 `language-parity` 矩阵的"必须全绿"；
2. **只修崩溃，不修行为**：语义冻结在切换日那个 commit；
3. **迁移提示单向**：封存层永远提示"迁移到 2.0"，不提示"2.0 怎么写回旧语法"；
4. **不新增语法**：`如果/否则` 不再演进，也不接受"给封存层也加个功能"的提案。

### 6.1 扩展名交接（已拍板：方案 A）

今天 `.kojo` 归 v1（`KOJO_SOURCE_EXTENSION`）。kojo2 接管后必须有一个让位方案：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | `.kojo` 归 2.0；v1 搬 `.kojo1`；提供一键改扩展名工具 | 老工程要跑一次改名；但"扩展名 = 语言"这条判据保持干净 |
| B | `.kojo` 按内容嗅探（有无 `?` / `# 对照表` 等 2.0 锚点） | 判据可重叠，违反 `languageIdForPath` 的"判据不重叠"纪律；半成品文件永远猜错 |
| C | `.kojo` 归 v1 不变，2.0 只用 `.kojo2` | 封存层变成"主扩展名的主人"，与"kojo2 取代 kojo1"直接矛盾 |

> **已定：A。** 于是 K2-CUTOVER 的动作是"让出扩展名"，不是"删掉 v1"：
> `KOJO_SOURCE_EXTENSION` 改指 2.0；v1 descriptor 改认 `.kojo1`；随附一键改扩展名工具（只改名、不改内容）。
>
> **落地（LAU-3b + LAU-3b-FLIP，2026-10-27）**：第一步交付——`.kojo1` 成为封存层显式扩展名（语言面 / 路由 / 快速打开 / 拖放 / 引用台账 / 产物目标 / 迁移入口全认），改名工具上线（`ui/kojo1-rename-model.ts` + `ui/kojo1-rename.tsx`，命令 `workbench.legacyRename`，设置页「Kojo 2.0 切流」也有入口）。第二步翻转按用户 2026-10-27 口径**当场落地**：`KOJO_SOURCE_EXTENSION`（`.kojo`）归 2.0、v1 descriptor 只认 `.kojo1`；路由/诊断归属只认扩展名（内容指纹退居迁移与改名工具的提示面），`.kojo` 的迁移是原地改写。四笔代价的具体兑现见 `docs/STATE.md` §一与提交回执。
> 封存层因此天然是"另一个扩展名的另一门语言"，2.0 编译器里一行旧分支都不需要（D7）。

**方案 A 的四笔实际代价（v1.1 补，取证后再排批）**：

1. **改常量的波及面**：`KOJO_SOURCE_EXTENSION = '.kojo'`（`plugin-api/src/sugar.ts:1214`，
   派生 `kojoMonacoExtensions` `:1226`、转出口 `index.ts:466`）今天有 **50 处引用 / 18 个文件**。
   生产侧 9 个文件（`plugin-api/src/sugar.ts`、`plugin-api/src/index.ts`、`kojo-project-kit/src/lang-doc.ts`、
   `plugins/eratw-adapter/src/scaffold.ts`（含 `FACE_STUB_EXT` `:104`）、`app/src/monaco/languages.ts`
   （`matchesPath` `:66`）、`app/src/monaco/kojo-language.ts`、`app/src/ui/kojo2-cutover.ts`、
   `kojo2-migrate-entry.ts`、`reference-utils.ts`、`editor-global-providers.ts`、`drag-drop.ts`、`commands.ts`），
   测试侧 8 个文件 25 处，其中两枚是**专闸**：`app/tests/kojo-extension-single-source.test.ts`、
   `kojo2-open-paths.test.ts:101,119`。
2. **会反转既有判据**：`app/src/ui/kojo2-cutover.ts:361-390` 的路由靠
   `ambiguous.fallback === 'kojo-v1'`（`:389`，另见 `KOJO_V1_FILE_EXTENSION` `:162`）判"歧义时落哪一侧"。
   扩展名重指之后这条判据的含义**正好翻面**，必须同批改写并补测试——不是"改个常量"。
3. **常量之外还有字面量**：`kojo-conformance/src/corpus.ts:66 V1_SOURCE_SUFFIX = '.kojo'`，
   以及 `drag-drop.test.ts:46,93`、`erh-open-surface.test.ts:32,35`、`file-tree.test.ts:545`、
   `kojo-rename.test.ts:216`、`kojo2-cutover.test.ts:424` 与四个语料遍历器。
   ⇒ 单一真源那一闸（第 1 条）要先扩到把这些字面量也纳入，否则改完还是双口径。
4. **"一键改扩展名工具"今天不存在，而且它要写只读域**：`kojo-core/src/migrate/*` 只迁**内容**
   （纯函数、零 IO、`ok=false` 拒写），现有的两枚改名机制（`erb-rename` / `kojo-rename`）
   **明确拒绝 `.kojo` 源**。而作者盘上的 `.kojo` 住在游戏目录的口上根内——那是**默认只读**的域
   （AGENTS 铁律 5：写入仅限用户批准的 `writablePaths`）。所以这个工具必须：
   ① 逐目录走批准（不得默认写）；② 写前自动备份到 `{userData}/backup/`（内核既有行为）；
   ③ 只改名、不改内容，且改名清单先给作者过目再落；
   ④ **不得**走 `exportFile`（那条通道的语义是"导出到域外"，不是"原地改名"）。
   这一枚工具本身就是一个独立批（LAU-3b），不能塞进 descriptor 那一批里。

## 7. 与 SDK 的关系：不冲突，SDK 是上游

B0–B5 的目标就是"把语言层做成 SDK"。LAU 只是把 SDK 的**契约面**提前定下来，因此有四条约束：

1. **封存层只能当 SDK 的普通消费者，不许进契约。** 若 `sugar.*`、`如果` 块渗进 provider 契约，SDK 就被历史绑住。反过来，封存层是最好的 SDK 压力测试：一门完全不同的语法只靠公开契约接进来——接不进来就是 SDK 缺面（见 §9 验收 2）。
2. **角色表住 SDK，不住 app。** 第三方插件最需要的扩展性就是"给我的语言上色"；角色表 + 主题规则形状必须是导出面。
3. **协议是 SDK 面且带版本号。** 第三方要一条"我的文法 → 捕获 → 角色"的通道，那就是 `structure-protocol.ts` + `StructureRuntime`。
4. **封存层的状态写死 sealed。** SDK 一公开，一定有人要求"我的旧文件也要能编译"；边界不写死就会被推着走。

### 7.1 SDK 是三层，不是一层

| 层 | 谁消费 | 形态 | kojo 的对应物 |
|---|---|---|---|
| **契约层** | 方言作者、插件作者 | 类型 / 接口（编译期可查） | `GameAdapter`（2.0，`kojo-core/src/adapter.ts:40`）/ `CarrierBinding` / `StructureRuntime` |
| **数据层** | 方言作者 | 纯数据，零代码 | 方言包的 `eventCatalog` / `domainSymbols` / `storageClasses`（＝spec §10.1 十五格的取值） |
| **名字层** | **口上作者** | **扁平名字，零前缀** | `恋慕`、`{她}`、`# 机 初见` |

关键事实：**成熟 SDK 的"好用"全部发生在名字层，而名字层的唯一设计目标是——让使用者看不见下面两层。**
C 的 `<stdio.h>` 里叫 `printf`，不叫 `libc_stdio_printf`；Java 里写 `List`，不写 `java.util.List`；
Python 里写 `len()`，不写 `builtins.len`。没有一个成熟 SDK 要求使用者用点号拼出"来源"。

### 7.2 成熟语言的四种封装模型

| 模型 | 代表 | 机制 | 解决什么 | 代价 |
|---|---|---|---|---|
| **扁平 prelude**（自动进作用域） | C 头文件 / Python builtins / Java `java.lang` / Rust prelude | 常用名字默认可见，不用 import | 日常调用零前缀 | 名字多了靠约定；重名要遮蔽规则 |
| **命名空间 + 导入** | Java `import` / C# `using` / Go `pkg.Name` / Python `from x import y` | 全名永远可达，导入后用短名 | 同名冲突、来源可追溯 | 多一层概念；作者得理解 import |
| **能力查询** | OpenGL `GL_ARB_*` / Vulkan extension / Web feature detection | 问"支持吗"，不支持则降级 | 同一份代码跨实现 | 能力名本身要词表 |
| **目标特化命名空间** | LLVM `llvm.x86.*` intrinsic / SQL 方言函数 | 通用层零 target 知识，特化知识住命名空间、由 target 声明 | 通用性与特化共存 | 使用者要知道自己在用特化 |

其中两个与 kojo 处境最像：

- **LLVM**：通用 IR 里没有任何 x86 知识；x86 的 intrinsic 叫 `llvm.x86.sse2.*`，**由 target 声明**。
  这就是 LAU 的 D9/D10——core 零游戏名词，游戏知识住方言包。
- **SQL 方言**：标准写法在所有方言下语义一致；方言扩展只出现在需要它的地方。作者写标准 SQL 就能跑，
  写方言函数就要接受"这份文件绑定这个方言"。

### 7.3 为什么 `通用概念.方言知识` 这个形状不成立

直觉是 `角色.恋慕`：`角色` = 通用概念，`恋慕` = 方言知识。它要求**"通用概念"由语言层拥有**。但：

- core 零游戏名词是地基（D9/D10，`audit:decoupling` 会红）。`角色` 一旦进 core，`{她}` 的落点、
  `# 视角` 的代词表、名字函数全要跟着进 core——**这一条会把整个方言层拆掉**。
- 若 `角色` 改由方言定义，那它不是通用概念，`角色.恋慕` 退化成 `方言.方言知识`，前缀零信息量。
- 更根本：**点号是"归属"记号，不是"来源"记号。** 作者写 `角色.恋慕` 想说的是"这是角色的属性"，
  不是"这个知识来自 eraTW 包"。后者才是适配问题，而它已经在别处解决了——**工程识别链绑定方言**
  （D11：`detect()` → `project.adapterId`，清单只做覆盖）。
  "来源"不需要在每一行代码里重复一次。

所以这个形状在架构上自相矛盾：它想用语法表达一件**已经在数据层表达过**的事，代价是把游戏名词塞回 core。

### 7.4 结论：prelude 是默认，限定名只在冲突时出现

| 需求 | 解法 | 新增语法 |
|---|---|---|
| 日常调用方言知识 | **prelude**：方言把名字注入文件作用域，作者写 `恋慕`（今天已经如此） | **零** |
| 补全只显示本方言的名字 | 事实面按当前项目的 `GameAdapter`（`domainSymbols` / `eventCatalog`）过滤（LAU-D2） | 零 |
| 两个方言包同时可见且重名 | **限定名** `erafl.口上番号`，`erafl` 是方言 id、不是游戏名词 | 零（与 `数组.长度` 同族，不是新概念） |
| 表达"这个能力可选" | 既有 `GameAdapter.capability`（`adapter.ts:460-468`）+ `AdapterProfile.features`（`:258-266`）+ 诊断，不给作者语法 | 零 |

**你想要的"自然调用"，今天的 spec 已经是了**：`恋慕`、`{她}`、`# 机 初见` 全是裸名字，作者从不写前缀。
真正缺的不是语法，是两件工程事——**工程有没有绑定方言**（LAU-D1）、**编辑器有没有按方言过滤**（LAU-D2）。
两件都在 LAU 里。

这也解释了为什么"加语法"这条路走不通：**适配问题不在语法层，在事实层。** 语法只要一门，事实要 N 套；
所以变化必须发生在数据里，不能发生在名字的形状里。

# 第五部分 落地

## 8. 批次与 DoD

**排期纪律（v1.1）**：三枚前置批（LAU-0 / LAU-1a / LAU-2a / LAU-6a）不依赖任何未决裁决——**已按此开工并落 dev**（逐枚落点见本表与 §8.1）；
**LAU-1 与 LAU-D1b 必须等 §4 抬头的两个前置**（K2-CONTRACT / D0 的契约落点裁决）——
**D1a 契约片按 §8.1 偏差 1 的理由先行**（additive、零消费方、不落进待裁决的那两个文件）；
**LAU-3 / LAU-4 必须与 ERB-PARITY（lead 在办）和 SDK B4 / B5 串行**，不得并行改
`tree-sitter/providers.ts` / `language-registry.ts` / `languages.ts`（AGENTS §六 冲突热点纪律）。
每批的验收口径照 §三：测试数不回退 + 双 typecheck + `audit:decoupling` ✅；纯文档批豁免测试面。

| 批 | 内容 | DoD（可执行） | 回滚点 |
|---|---|---|---|
| **LAU-0** 事实修订<br>（= v1.1 本批，纯文档）**✅ `ebf8e03c`** | §1 / §4 / §5 的读数、出处、节点名逐条改正并带 `file:line`；§9 判据改成 audit 同形态；§8 增前置批 | 本文档每条事实主张都有 `file:line`；无实现改动（`git diff --stat packages` 为空） | 文档批，`git revert` 即可 |
| **LAU-1a** 宿主去 eraTW 化<br>（**✅ `4c1487c4`**） | ① `App.tsx:406,421`（迁移向导事件目录 / 参数形状）、`App.tsx:237-249`（存储注入的 `storageClasses` + 指纹）、`kojo2-project-scan-adapter.ts:48-51`（默认装载器）三处改成**按当前项目取**，取不到给 `null`／`undefined`（沿用 `kojo2AdapterForProject` 的"宁缺勿错"语义）；② `bootstrap.ts:250-263` 的 `'erafl'` 字面量分支泛化成对 `adapter-manifest.ts` 的循环（用条目自带的 `load()` + 导出存在性卫语句）；③ 新增 `tools/audit-language.mjs`（继承 `audit-decoupling` 的三条豁免口径） | `pnpm audit:language` ✅：`packages/app/src` 里游戏名只出现在 `adapter-manifest.ts` 与带 `audit-allow` 的组合根装载点；eraFL 工程下迁移向导 / 存储注入 / 项目扫描拿到的是 eraFL 事实或 `null`，**绝不出现 eraTW 事实**（各一条测试）；六适配器注册行为不变（`plugin.statusChanged` 与既有注册测试全绿）；全量测试数不回退 + 双 typecheck | 每处一个 commit，逐个可回；三处都是"动态 import 换目标"，不动契约 |
| **LAU-2a** 色彩可行性探针<br>（**✅ `f006547c`，读数见下**） | 一枚离线脚本：给定 `SEMANTIC_ROLES` 的档数与 6 套主题的底色，求"两两 ΔE ≥ 12 且对底色 ≥ 4.5"是否可解，并给出可行档数上限与一组候选色 | 出一份读数：18 档可解 / 不可解（不可解则给最大可解档数）；**LAU-2 的档数按这份读数控**，不靠会上拍。**实测（N=18／ΔE≥12／对比≥4.5／RGB 步长 8 网格 35,937 候选，度量逐字复用 `kojo2-theme.test.ts:71-113`，全程无随机）＝6 套主题（实为 3 个不同底色）全部 18 档可解**；每底色最大可解档数 `#1e2227` 316 / `#f6f8fa` 233 / `#0f1713` 354（下界，DFS 预算内未穷尽），全局上限取最严格底色 ≥233 档 ⇒ **18 档远未触顶，不构成开工障碍**。参照系＝现役 12 唯一色：min 两两 ΔE 13.8/14.7（闸 12 ⇒ 余量 1.8/2.7），min 对比度 4.58/4.62/5.21（闸 4.5 ⇒ **暗底余量只剩 0.08**）。⚠ 「数学可解」≠「可用」：探针输的三组 18 档见证色组未经可读性/语义评审，**LAU-2 定稿色卡仍需人工评审**，本读数只否掉"档数不够"这一条 | 纯脚本，不进产品码 |
| **LAU-1** 协议 v3<br>（**等 D0 落点裁决**） | `structure-protocol.ts`（落点随 D0）；`StructureClient` 按 v3 重写成薄壳；`erb-ts.worker` / `kojo-ts.worker` / `worker-bootstrap` / `engine` 跟着改；**保留差集**（`parse` 走 `text` \| `edit` 二选一）；两档预算 + **连续 3 次失败判死**的账本（D8）；kojo2 侧补 `open` 握手与协议常量 | 协议表测试（形状 / `reason` 闭集 / 版本不符即拒 / `text` 与 `edit` 同给即 `invalid-input`）全绿；**新旧 worker 双跑一批**（`protocol-mismatch` 能降级到旧路，不整档哑火）；ERB 首帧 `open→ready` 与 `ready→首屏着色` 两个数写进 `BASELINES.md`；`tree-sitter-*` 五个测试文件全过；**差集路不退化**：6,003 行档每键的 worker 侧文本量与改前同量级（一条读数） | 单批一个 commit；`types.ts` 旧类型保留为别名 + 双跑窗口内可随时切回 |
| **LAU-2** 角色表 | `semantic-roles.ts` + 别名表（**覆盖三侧全部 45 个现役 token 名**）；三份捕获表翻到角色；三套主题规则改 `token: role.*`；Monarch 的 token 名换一遍 | `pnpm audit:language` 的角色项 ✅（旧 token 名只出现在别名表一处，判定排除注释与 `audit-allow`）；主题对账测试全绿（每档有且只有一条规则 / ΔE / 对比度，指标沿用 `kojo2-theme.test.ts`）；**档数按 LAU-2a 的读数定**。**交付实测（2026-10-27）＝34 档 / 别名表 47 条**（18 档要合并今天不同色的档 ⇒ 违反"零改色"硬约束；34 是每套主题每角色一枚色的最小划分，理由与逐档比对见 §4.2 交付注） | 别名表在，旧名仍能取色 |
| **LAU-3** 描述符 v2 + 封存层<br>（**与 ERB-PARITY 串行**；**✅ 2026-10-27 框架批，分支 `b/qoder/1027-lau-framework`**；本批仍认 `.kojo`，`.kojo1` 交接在 LAU-3b） | `availability` / `settingKey` / `presentSyntax`+`clearSyntax`；`services` 那格按 §4.3 的 ① 走 additive（`slotServices` 原位保留）；新增 `kojo-legacy` descriptor 与设置项；删 `tree-sitter/providers.ts:378,385` 两处 `if (ERB)`；**门开关不重认领已打开的 model** | 封存层默认关：`.kojo1` → `plaintext`；开启后四面齐全；关设置项时在编文件语言 id 不变、新开的落 `plaintext`（一条测试）；`providers.ts` 里零 `ERB_LANGUAGE_ID`；`language-parity` 取证表同批更新且全绿 | 设置项默认 false，等价于没有这一层 |
| **LAU-3b** 扩展名交接工具<br>（**✅ 2026-10-27 同分支交付；翻转随后落地**） | 一键 `.kojo` → `.kojo1` 改名工具：扫描口上域 `.kojo` → 内容指纹只挑 v1 写法 → 清单先过目 → 逐文件写权限闸 + 写前备份 + 只改名不改内容；`.kojo1` 全链路认领（descriptor / 路由 `extension-kojo1` / 快速打开 / 拖放 / 引用台账 / 产物 / 迁移）；封存档首开说明。`kojo-extension-single-source` 闸扩到 `.kojo1` 字面量 | 只读域拒绝（`not-writable` 逐条回执）；备份失败不改名；清单之后正文变成 2.0 写法 ⇒ 写前再判一次并跳过；新增钉子 24 例（模型 9 / 扩展名跨面 11 / 首开 4）；`audit:language` 与开机图不回退 | 不改名即无影响（封存层默认关）；扩展名翻转已由 LAU-3b-FLIP 落地 |
| **LAU-4** ERB 进槽<br>（**依赖 SDK B4/B5，与 ERB-PARITY 合流**） | ERB 的 11 枚 provider 搬成插件供方（依赖 B0–B5 的槽位契约） | ERB 与 kojo2 走同一条 `ui.editor.languageService`；宿主 `monaco/` 下不再有 ERB 判据（§9-1 的终态判据在此批才成立） | 插件可卸载，回落到 `legacyBridge` |
| **LAU-5** 单 worker 池（可选）**✅ 2026-10-27（`b/qoder/1027-lau-roles`）** | 一个 structure worker 池共用 `Parser.init`，语言懒 `Language.load`。落法：协议抬到 **v4**（只加 `ready.docBase`；`parse` 仍只带 `doc`，worker 按 `docBase ≤ doc` 的最大那台路由）；`structure.worker.ts` 一条入口登记两门语言的资源包；`structure-pool.ts` 按 `runtimeWasmUrl` 借还线程；`client.ts` / `injection.ts` 把 `doc` 写成 `docBase + 序号`；kojo2 自有 worker 不进池（回 `docBase: 0`） | 冷启动省一次 runtime 初始化 + 少两条线程；内存峰值不升。⚠ v1.0 写的"实测 15.7ms"**在本仓无出处**（`STATE.md` / `BASELINES.md` 零命中）⇒ 这批自己出读数：`tools/structure-pool-readings.mjs`（一条线程，ERB + `.kojo`）：冷 ERB `open→ready` **96.8 ms**（`loadMs` 95.3）/ 热复用中位 **11.1 ms**（`loadMs` 0，3/3）；换语言冷启动 `loadMs` **12.8 ms**（比第一门少 **82.5 ms** 的运行时 init）；热轮次 JS 堆 17.9 → 18.3 MB（RSS 涨的是第二门文法的 native 段，不是泄漏） | 池关掉即回到"每语言一条线程"（`runtime.createWorker` 注入点仍在；`structure-pool.ts` 换回 `createWorker()` 一行） |
| **LAU-6a** 注入探针<br>（**已交付，dev `45d18791`**） | 一份 `@原生` 语境 ×8（含 `[SKIPSTART]` 嵌套与深缩进两用例）× 五种区间取法，用 `includedRanges` 向 ERB runtime 发子 parse，读四面 | ✅ 判决 **可排**，但区间必须「整行对齐 ＋ 末行换行收口 ＋ EOF 无换行补虚拟换行」（④ 唯一全绿，③差那一口气）；坐标 40 组 0 错位 ⇒ Range 用 UTF-16 码元；顺带证清 erb wasm 与 grammar.js 同步、无重生成欠账 | 纯探针，不进产品码（`tools/inject-probe.mjs`） |
| **LAU-6** `@原生` 注入 | descriptor 加 `injections`（`hostNode: 'native_body'`）；协议加 `includedRanges`（已在 §4.1）；宿主按声明转发子 parse；子树 tokens 区间覆盖主树 `role.raw`；`core/injection/child-failed` 进 core 闭集 | §4.6 五条 DoD 全绿（区间口径按 LAU-6a 写死：整行对齐 ＋ 末行换行 ＋ EOF 补虚拟换行）；无 `@原生` 的文件零 wasm 请求；子树失败不拖垮主树；`tools/inject-probe.mjs` 的 ④ 口径转为回归用例 | `injections` 置空即回到"整块不透明" |
| **LAU-D1** 方言解析链<br>（**契约片 ✅ `875b05d3`＝LAU-D1a；上屏片 D1b 等 D0 落点裁决**；可与 LAU-1/2 并行） | **不新造 `dialect.ts`**（D13）：`GameAdapter` additive 加 `carriers?`；`EditorDocumentIdentity.dialect?`；`dialect-resolver`（识别链 → binding，`workspace.json` 的 `meta` 只做覆盖）；状态栏显示方言。**注意 LAU-1a 已经把三处错事实点收掉了，这批不再包含它们** | 打开 eraFL 工程，状态栏显示 `erafl`；未绑定时事实类服务返回空 + 一条 `core/dialect/unbound`，**不出现任何 eraTW 事实**；覆盖与 `detect()` 不一致 ⇒ `core/dialect/mismatch`（error）且以覆盖为准；`pnpm audit:language` ✅ | `carriers` 与 `dialect?` 都是可选格，删掉即回滚（adapter 本来就从插件取） |
| **LAU-D2** 事实面接线 + `dialect lint` | **只动 2.0 语言面**（v1 十二个可选槽一行不改，见 §5.2 尾注）：补全 / 悬停 / 签名 / 符号 / 跳转 / 诊断改吃当前项目的 `GameAdapter`；`# 机` / `@织` 的事件名按 `eventCatalog` 校验；`dialect lint` 七项；~~先给 core 闭集加 6 枚码~~（**已由 LAU-D1a `875b05d3` 加好**，§5.5 尾注，本批直接从"发码"起步）；把 `erb-language.ts:159` 与 `erb-parser/src/undefined-name.ts:148-240` 的引擎变量族外提到方言数据 | 方言矩阵（eraTW + eraFL，**夹具已就位 `b9e87b2e`**，见 §5.6 判据 2）同一组断言全绿；把 eraTW 的事实喂给 eraFL 夹具 ⇒ **必红**；**四个只有 v1 面的适配器读数列不变**（§5.6 判据 4） | 每类事实一个 commit，逐个可回 |
| **LAU-D3** 多载体（eraFL 的 XML 面） | `carriers` 归属；`kojo-xml` descriptor 接方言：`command` / `name` / `kojoPlace` 由 `eventCatalog` 校验（对齐既有 `plugin-api/src/kojo-xml.ts` + `WellKnownServices.KojoXml`）；ERB 壳函数得到"这条事件在 xml"的提示 | 打开 eraFL 口上 XML：`command` 有补全、未登记 `command` 报 `core/event/unknown`；`event/wrong-carrier` 能把"eraFL 的 `会話` 写在 ERB 里"判出来；ERB 壳函数不再被当成"没实现的口上" | 载体绑定是数据，删掉即回到"XML 只是数据格式面" |
| **LAU-D4** 方言包 + 翻译表<br>（**与 SDK B5 合并派工**） | eraTW / eraFL 两枚方言数据（**纯数据**，即 spec §10.1 十五格的取值）；日文原名走 aliases；`conformance` 夹具。⚠ 「eraFL 写自己的 2.0 profile」当年已把分给 B5——**同一件事不要派两次**，两批合并 | 新增第三个 era 只加一个包：宿主零改动、语法零改动，矩阵自动跑第三列 | 包可卸载 |

**七路批的落点与偏差（2026-10-25，组长 krosama；逐枚回执在各自提交信息里）**

三枚批是派工时从本表里**拆出来先做**的，不在 v1.1 的编号里：

- **LAU-GATE** `6ca3c4c3`+`7540b9ed`＝§9 的判据可执行化（本表 LAU-1a 的 ③ 独立成批）。
  `tools/audit-language.mjs` + `audit:language`，M1 游戏名·引擎词汇 **7** 行 / M2 语言 id 分支 **134** 行 /
  M3 旧 token 名 **163** 行——
  **注意这与本表 LAU-1a DoD 里"游戏名只出现在 manifest"不矛盾**：终态是零命中，但棘轮只认真能红，
  基线钉当日实测、只降不升。三族各注入一条违规的变异实测在 `tools/tests/audit-language.test.ts`。
- **LAU-SYNTAX** `3a76d857`+`87b7e26c`＝`# 方言` 词位（§5.3 的"断言"那一路）。
  **`KOJO_DECL_WORDS` 尾部追加**（位置是公开契约：`kojo2-format.ts` 按 `slice` 取段，插中间就翻面）；
  v2 文法 + 四件产物重生成，**wasm 棘轮由 47,116 抬到 48,057 B**（＋941 B，涨幅＝一条 `dialect_decl`
  规则 + 词表，归因写在 `v2-wasm-size.test.ts`）。⚠ §5.3 预估的"这一条要重跑 `build-v2.mjs` 并动棘轮"
  已兑现，但**体积代价只有 +2%**——真正的成本在"产物四件套必须同源"（`grammar.v2.json` 本轮就发现过
  顺序陈旧，重跑 `build-v2.mjs` 才对齐），不在字节数。**消费方未接线**（词位只被三面认出）。
- **LAU-FIXTURE** `e196d384`+`b9e87b2e`+`743e5558`＝§5.6 判据要求的方言矩阵第二列（本表挂在 LAU-D2 的
  括号里）。eraFL 的 2.0 面 38 例 / 128 断言 + 43 份夹具，事实源取 eraFL 自己声明的数据。
  **真盘根走环境变量 `KOJO_ERAFL_DIR`**，未设时 4 枚真盘用例跳过——仓库里不写死本机游戏目录（AGENTS §五）。

两处与本表文字不符的**实现侧改口**（实现是对的，按 §五 文档纪律算一行）：

1. **LAU-D1a 落到了 `kojo-core`，没等 D0**。裁决是"契约片可以先行"：**additive 且零消费方**的
   `CarrierBinding` / `carriers?` / `EditorDocumentIdentity.dialect?` 不落进任何要 D0 裁决的既有文件，
   就抢不了裁——`plugin-api` 那侧只加了一格可选 `dialect?`，`structure-protocol.ts` / `semantic-roles.ts`
   **一件未动**。⚠ 但有一处确实**先于裁决选了边**：六枚诊断码进了 `kojo-core/src/diagnostics.ts`
   （§5.5 说的"要先过 D0"就是针对这一步）。选它的理由是 **core 族码表（`CoreDiagnosticCode` +
   `CORE_WARNING_CODES` + `isCoreCode`）今天只住在 `kojo-core/src/diagnostics.ts`**——`plugin-api` 侧只有
   糖层自己的 `SugarDiagnosticCode` / `DiagnosticCodeKey`（`plugin-api/src/diagnostic-copy.ts`），
   没有 core 码的家可搬；而 core 码是**闭集、只增不改**的公共名词表，加一半再搬比不加更难收拾。
   代价是**改名窗口从此关闭**——若 D0 最终判
   "语言级事实不落 `kojo-core`"，这六枚要跟着契约一起搬。D1b（解析链上屏 + 状态栏）仍等 D0。
   **✅ 已关闭（2026-10-28 核）**：D0 于 2026-10-27 裁定「维持 `kojo-core`、不 additive 镜像到
   `plugin-api`」（BOARD `K2-CONTRACT`），且 `@kojo/kojo-sdk`（B5a）从 `kojo-core` 再导出同一份码表
   ⇒ **六枚码不搬、本偏差不成立**；D1b 亦已于 2026-10-27 交付（状态栏「方言 eratw」真机取证）。
2. **LAU-1a 的三处错事实点收成了"按当前项目取"的端口**，另外多修一处：
   `ps10-boot-order.test.ts` 里那枚逐字钉 App 侧 bootstrap 进口的测试会随任何合法新增进口变红，
   改成对**进口形状**取证（只留一枚 `../bootstrap` 进口、名单含 `bootstrapKernel`/`prefetchProjectPlugins`、
   不含 `ensureProjectPlugins`）。判据没搬家，只是不再钉拼写。

## 9. 验收线

> **判据形态（v1.1 统一）**：本节凡"grep 零命中 / 只命中 X"的判据，一律实现为
> `tools/audit-language.mjs`（与 `tools/audit-decoupling.mjs` 同族、同豁免口径：
> ① 行尾 `// audit-allow: <理由>`；② **注释行**；③ 组合根与 `adapter-manifest.ts`）。
> 裸 grep 会被注释与法定落点顶死，写了也守不住。**每条判据都标了今日基线**，
> 这样"红"是相对基线收敛，而不是一句永远达不到的口号。

1. **零语言知识（终态，LAU-4 之后才成立）**：`packages/app/src/monaco/` 里按具体语言 id 分支的代码
   只允许出现在 descriptor 自身与别名表。**闸已落地（LAU-GATE `6ca3c4c3`），基线＝M2「语言 id 分支」
   代码行命中 134 行 / 38 文件**（v1.1 草稿写的 257 行是**裸 grep 计数**，含注释与 `audit-allow` 行，
   棘轮口径不数——差在口径不在代码），所以这条**不得当 LAU-1/2/3 的 DoD**。
2. **一门假语言**（`tests/fixtures/language-probe/`）：只靠公开契约接入（descriptor + runtime + 一份小 wasm），四面（着色 / 折叠 / 缩进 / 残缺）全绿，宿主零改动。**这是 SDK 与 LAU 的共同验收**。
3. **首帧读数**：ERB 冷启动 `open→ready` 与 `ready→首屏着色` 各一个数，写进 `BASELINES.md`。
   ⚠ 顺手把 §1 代价 2 那句"ERB 首帧慢的根因是超时策略"证真或证伪——v1.0 未取证。
4. **降级台账对账**：`StructureFailureReason` 每一个成员都有文案（`diagnostic-copy.test.ts` 形态），多一个少一个都红。
5. **协议闸**：形状不符 / 版本不符 / 迟到回复 / 换轨串号 / `text` 与 `edit` 同给，五类各一条测试。
6. **封存层边界**：默认关闭时不产生任何 wasm 请求（网络面板断言），开启后不参与 `language-parity` 矩阵。
7. **方言零硬编码**：`packages/app/src` 里游戏名与引擎变量族只出现在法定落点。
   **基线（LAU-GATE，`tools/audit-language-baseline.json` 现值）＝M1「游戏名·引擎词汇」代码行命中
   **7 行**（`bootstrap.ts` 2 行＝组合根装载点 + 清单循环，`monaco/erb-*` 4 行，`WelcomeView.tsx` 1 行），
   另有 **M3「旧 token 名」163 行**（三侧现役 Monarch/主题 token 字面量，LAU-2 的别名表就是冲它去的）；
   v1.1 草稿的"62 行"同样是裸 grep 口径（`eratw` 16 行 / 10 文件，其余多为注释）。
   LAU-1a 之后 M1 已收敛到 `adapter-manifest.ts` + 带 `audit-allow` 的组合根行；LAU-D2 之后
   `erb-language.ts:159` 与 `erb-parser/src/undefined-name.ts:148-240` 那两份引擎变量族清单外提，才算真零。
8. **错配必红**：方言 A 的事实喂给方言 B 的夹具，必须给出诊断，不许静默通过——这是"错事实不报错"那类 bug 的回归测试。
9. **未绑定不猜**：`dialect` 缺省时事实类服务全空 + 一条 `core/dialect/unbound`，且不得回落到任何默认方言。
10. **加 era 只加数据**：新增第三个方言包时，`git diff --stat packages/app` 应为空。
    ⚠ v1.1 写的"这条今天不成立（`bootstrap.ts:250-263` 用 `'erafl'` 字面量挑包）"**已由 LAU-1a `4c1487c4` 解掉**：
    那段泛化成了对 `adapter-manifest.ts` 的循环（条目自带 `load()` / `auditWord` / 导出存在性卫语句），
    `packages/app/src` 里除清单与 `audit-allow` 组合根行之外零游戏名。剩下一格没解：
    **2.0 事实面**现在按当前项目取（取不到给 `null`），但**方言级数据**（`carriers` 的取值、事件目录
    的 eraFL 内容）仍写在各自适配器包里——那正是 LAU-D4「方言包」要做的事，做完这条才是真判据。
11. **v1 面不退化（v1.1 新增）**：eraakumamaid / erakoumakan / erasqc / eratohok 四家没有 2.0 面，
    LAU-D2 前后它们在 v1 十二个可选槽上的读数（补全候选数 / 悬停命中 / 规约条数 / 条件矩阵格数）**逐格相等**。
    这条是"兼容更多 era"不被架构统一反噬的唯一硬保证。

## 10. 明确不做

- 不改 2.0 语法（`?` 链、`# 对照表`、程序层一个字不动）；表达式条件只做诊断（选项 ①）。
  **唯一例外**是 `# 方言` 一枚词位（§5.3）——它是一次性、跨方言共用的**断言记号**，
  代价是必须重生成 `tree-sitter-kojo2.wasm` 且只能追加在 `KOJO_DECL_WORDS` 尾部（`kojo2-format.ts` 按位置解构）。
- **`@原生` 体内要做注入**（§4.6 / LAU-6）：从"整块不透明"改为按 descriptor 声明注入 ERB
  （**LAU-6a 探针已过 `45d18791`**：判决可排，区间口径按 §4.6 写死）。
- 不把叙事层从 tree-sitter 上摘下来（极端解 ③ 已搁置）。
- 不合并 `EDITOR_SEMANTIC_TOKEN_TYPES`。
- **不新增第三套游戏事实契约（D13，v1.1 新增）**：不写 `DialectFacts` / `DialectEvent` / `DialectSymbol` /
  `DialectPresentation` / `DialectProfile` 这些与 `kojo-core/src/adapter.ts` 同义而信息更少的类型；
  事实面沿用既有 2.0 `GameAdapter`，新增只有 `carriers?` 一格。
- **不动 v1 的十二个可选槽**（`plugin-api/src/game.ts:782-831`）：LAU 只统一 2.0 语言面；
  四个只有 v1 面的适配器靠它们供事实，动一格就是四家一起退化（§9-11）。
- **不把 `LayerMode` 与 `EventDispatchModel` 合并**（spec §10.5 明令三者不混）；
  eraFL 的元数据派发走 `EventDispatchModel` 的 additive 扩值。
- 不新增 workspace 包（**落点待 BOARD 的 K2-CONTRACT / D0 裁决**：`plugin-api` 还是 `kojo-core`；
  是否拆 `@kojo/language-sdk` 由 B5 决定）。
- 不改 Monarch 的**解析逻辑**，只改它吐的 token 名。
- **不为任何 era 分叉语法或 tree-sitter 查询**（方言只进事实类服务，D10）。
- **不在 core / 宿主里出现游戏名词**：引擎词汇只允许出现在方言包的**落点字段**里
  （既有形态：`AttributeSymbol.family/index`、`NameFunctionSymbol.engine`、`PronounSymbol.engineRef`、
  `StorageClassSpec.engine`、`ColorPresentation.setColor`…），并由 `audit:language` 钉住。
  今天还住在语言面的两份引擎变量族清单（`erb-language.ts:159`、`erb-parser/src/undefined-name.ts:148-240`）
  是这条的**存量欠账**，LAU-D2 外提。
- 不做"自动推断方言"（按内容嗅探、按文件名猜）：推断错一次 = 整套错误事实，比"未绑定"危险得多。
  ⚠ 但 **`detect()` 不在此列**——它是带证据、带 `ProjectDetectionError` / `AdapterConflictError` 双闸、
  已上线且已持久化的**项目识别**，不是内容嗅探；D11 用它当真源（§5.3）。
- **不新增任何语法**：本方案只加 `# 方言`（一条断言，D11）。

---

## 附录 A · v1.0 → v1.1 修订对照（LAU-0，逐条带取证）

> 设计主张（§2 决策表、§3 六纪律、§7 的 SDK 论断）**未变**，只增 D13。下面两类改动：
> **A 类＝事实/读数错**（改的是"今天是什么样"），**B 类＝设计改口**（改的是"要做什么"，各条都在正文里有理由）。

| # | 类 | v1.0 | v1.1 | 取证 |
|---|---|---|---|---|
| 1 | A | ERB Monarch「6 个 token 名」 | **15 个**（6 对象式 + 9 简写式） | `erb-language.ts:129,132,134,136,138,150-284` |
| 2 | A | kojo2 首帧「4 条请求（含 `parse`）」 | **3 条**（`parse` 宿主无生产调用方） | `kojo2-semantic.ts:348`、`kojo2-folding.ts:180`、`kojo2-indent.ts:656`；`kojo2-worker-runtime.ts:160` |
| 3 | A | `kojo2-*.ts`「25 文件 / 31,599 行」 | **54 文件 / 28,755 行**（另 4 个 `.tsx` 1,770 行） | `find packages/app/src -name 'kojo2-*.ts'` |
| 4 | A | ERB wasm「0.98 MB」与「1.03 MB」两处 | 一律给字节：**1,030,545 B**（=0.98 MiB=1.03 MB），kojo 821,724 B、kojo2 47,116 B | `packages/*-syntax-tree/*.wasm` |
| 5 | A | v1「一次超时即整档判死」 | 分两档：**ready 前**整档 `dead`（须切设置项恢复）、**ready 后**只死当前文档那一面 | `client.ts:72,238,318-332,351-363`、`providers.ts:370-375,507-511` |
| 6 | A | `providers.ts` 里「那处」`if (ERB)` | **两处**（onSyntax / onSyntaxClear）；另有九处按具体语言 id 分支 | `tree-sitter/providers.ts:378,385`；清单见 §3-R1 |
| 7 | A | 注入节点名 `native_block` | **`native_body`**（`native_block` 全仓零命中） | `grammar.v2.js:133,167,254`、`node-types.v2.json:45,87,331` |
| 8 | A | 「宿主把 2.0 adapter 写死成 eraTW（`use-monaco-instance.ts:280`）」 | **已于 2026-10-24 修掉**（`ab1c5146`，入口 A）；现存同类点是另外三处 + 一枚 `'erafl'` 字面量分支 | `use-monaco-instance.ts:283`、`bootstrap.ts:45-58,250-263`、`App.tsx:237-249,406,421`、`kojo2-project-scan-adapter.ts:48-51` |
| 9 | A | 「事件架构有四种」并列五项、含 `eraNTR` | 改为「因 era 而异」，删 `eraNTR`（本仓无据）；补 eraFL 九事件里 4 引擎 / 5 自包的真事实 | `adapter-manifest.ts:49-103`、`erafl-adapter` 实现 |
| 10 | A | 工程根 `kojo.project.json` | **该文件不存在**；真清单是作者工作区的 `workspace.json`（`meta` 可 additive） | `plugin-api/src/workspace.ts:22,38-46`、`kernel/src/workspace.ts:155,169,185` |
| 11 | A | LAU-5「实测 15.7ms」 | **本仓无出处**，改为该批自己出读数 | `STATE.md` / `BASELINES.md` 零命中 |
| 12 | B | D3：取消 `change`，每版传全文 | **保留差集**，`parse` 走 `text` \| `edit` 二选一；「结构化克隆零拷贝」的说法纠正 | `edit.ts:38`、`client.ts:285-303`；性能批 `483098b7` |
| 13 | B | 新造 `dialect.ts`（`DialectFacts` 一族） | **D13**：事实面沿用既有 2.0 `GameAdapter`，只 additive 加 `carriers?`；列出七组不可丢字段与两处命名/轴混淆 | `kojo-core/src/adapter.ts:40,84-99,146-240,284-357,384-405,436-447,460-497,576-593` |
| 14 | B | D11 真源＝工程清单 | 真源＝`detect()` → `project.adapterId`（带双闸、已持久化）；清单只做覆盖，`# 方言` 只做断言 | `kernel/src/project.ts:44-108`、`active-adapter.ts:52-61`、`slots.ts` 13 处 `project` 腿 |
| 15 | B | §5.5 七个诊断码 | 四行**复用既有 core 码**、六枚**新增进 core 闭集**（第 7 枚 `core/injection/child-failed` 归 LAU-6）；`dialect/*`、`injection/*` 按今日 `DiagnosticCode` 过不了类型 | `kojo-core/src/diagnostics.ts:14,20-247,249,251`、`adapter.ts:576-593,590` |
| 16 | B | §5.3「`# 方言` 零语法改动」 | 必须**重生成 `tree-sitter-kojo2.wasm`**，且只能追加在 `KOJO_DECL_WORDS` 尾部 | `grammar.v2.js:70,218-229`、`tools/build-v2.mjs`、`kojo2-format.ts:55,77` |
| 17 | B | §9 判据用裸 grep「零命中」 | 改走 `tools/audit-language.mjs`，继承 `audit-decoupling` 三条豁免，并标注**今日基线**（257 行 / 62 行） | `tools/audit-decoupling.mjs:37-47,69,78-85,133` |
| 18 | B | §8 批次表 | 增 **LAU-0 / LAU-1a / LAU-2a / LAU-3b / LAU-6a** 五枚；标注 LAU-1/D1 等 D0 裁决、LAU-3/4 与 ERB-PARITY + SDK B4/B5 串行、LAU-D4 与 B5 合并 | §8 排期纪律段 |
| 19 | B | §6.1 方案 A 只写"一键改名工具" | 补四笔代价：50 处引用 / 18 文件、cutover 判据**翻面**、常量外字面量、工具不存在且要写**只读域**（须走 `writablePaths` 批准） | `sugar.ts:1214`、`kojo2-cutover.ts:162,361-390`、`corpus.ts:66`、`migrate/*` |
| 20 | B | §6 语言 id 直接改 `kojo-legacy` | 指出改 id 与改扩展名是两笔代价，给出"保留 `kojo-sugar` + `availability:'legacy'`"的更便宜选项，LAU-3 前定案 | `kojo-language.ts:35` |
| 21 | B | §5.6 矩阵三条判据 | 增第 4 条「**v1 面不退化**」：四个只有 v1 面的适配器读数逐格相等（§9-11 同源） | §5.1 事实 4 的适配器盘点表 |

## 附录 B · v1.1 → 七路交付批的文档改口（逐条带取证）

> 本节只记**文档与实测不符**处——按 AGENTS §五 的口径"实现与文档冲突且实现是对的，改一行算一行"。
> v1.1 的 21 条修订是**纸上取证**，下面 8 条是**跑出来的**；两类都算数，但只有后者能钉住。

| # | 落点 | v1.1 写的 | 交付批实测 | 取证 |
|---|---|---|---|---|
| 1 | §1 表 / §2 D14 / §5.3 | kojo2 出货 wasm **47,116 B** | **48,057 B**（`# 方言` 一条 `dialect_decl` 规则 + 词表＝＋941 B，约 +2%）；棘轮随组长点头同抬 | `packages/kojo-syntax-tree/tree-sitter-kojo2.wasm`、`tests/v2-wasm-size.test.ts`、`3a76d857`+`87b7e26c` |
| 2 | §9-1 / §9-7 / §5.6-1 / §6 表 | 今日基线"裸 grep **257** 行 / **62** 行" | 棘轮口径只数**代码行**（注释与 `audit-allow` 不进账）⇒ **M1 7 / M2 134 / M3 163**。差在口径不在代码，两处都已在原文标注 | `tools/audit-language-baseline.json`、`tools/audit-language.mjs` |
| 3 | §5.1 事实 4 / §5.6-2 / §8 LAU-D2 | eraFL「**无** conformance 夹具」⇒ 矩阵第二列没有可比对象 | 已补：**38 例 / 128 断言 / 43 份夹具**，事实源取 eraFL 自己的声明；erafl `src/kojo2/` 由 1,205 → **1,211** 行（`e196d384` 改 `capabilities.ts` 一致性套件声明） | `packages/plugins/erafl-adapter/tests/kojo2-conformance.test.ts`、`b9e87b2e` |
| 4 | §5.5 尾 / §8 LAU-D2 | 6 枚 core 码「一旦加进去就不能改名 ⇒ **要先过 D0**」 | **已先于 D0 加进闭集**（本批唯一一次选边）。理由：core 码表只住在 `kojo-core`，`plugin-api` 侧只有糖层自己的码表；代价与回滚难度见 §8.1 偏差 1 | `kojo-core/src/diagnostics.ts:246-325`、`875b05d3` |
| 5 | §9-10 | 「加 era 只加数据」今天**不成立**（`bootstrap.ts` 用 `'erafl'` 字面量挑包） | 字面量分支已泛化成对 `adapter-manifest.ts` 的循环 ⇒ 该缺口**换了位置**：2.0 事实按项目取已通，方言级**数据**仍在各适配器包内，真判据要等 LAU-D4 | `packages/app/src/bootstrap.ts`、`adapter-manifest.ts`、`4c1487c4` |
| 6 | §4.2 硬约束 2 | 18 档 × ΔE≥12 × 对比≥4.5 能否解"**未验**" | 6 套主题（3 个底色）**全可解**，最大可解档数下界 233/316/354 ⇒ 档数不是限制项。⚠ 现役 12 色的对比度余量只有 **0.08–0.12**；"可解"≠"可用"，色卡仍需人工评审；"跨底色同档同色"这一更强约束**未验** | `tools/color-feasibility.mjs`、`f006547c` |
| 7 | §4.6 | ERB 对行边界的三条硬依赖是**推断、未实测** | 8 语境 × 5 取法 **40 组**实测：只有「整行对齐＋末行换行＋EOF 补虚拟换行」全绿，按字节切的四路全解体；坐标口径＝UTF-16 码元；`[SKIPSTART]` 嵌套与深缩进**证真**；erb wasm 与 `grammar.js` **同步**（`237c62c9` 那 7 行全是注释，无重生成欠账） | `tools/inject-probe.mjs`、§4.6 判决表、`45d18791` |
| 8 | §8 批次表 | 只有 LAU-0…D4 编号 | 派工时另拆出三枚不在编号里的批：**GATE / SYNTAX / FIXTURE**；两处实现侧改口（D1a 落点、PS-10 次序钉改形状取证）见 §8.1 | §8.1 全段 |
