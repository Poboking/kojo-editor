# Kojo 2.0 的包化方案（SDK 口径）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-24 |
| 状态 | **B0 已落地**（契约 + 取数腿 + 单测）；B1–B5 仍是设计稿，只定包归属与迁移顺序 |
| 依据 | `docs/KOJO-2.0-LANGUAGE-SPEC.md` §1 分层 / §10 Adapter 契约 / 附录 C.1 SDK 契约补充；`docs/BOARD.md` 的 `K2-D0` / `K2-CONTRACT` / `K2-CORE-PKG` |
| 一句话 | **语言核心已经是包（`@kojo/kojo-core` 11,060 行）；缺的是「编辑器面」——它现在整块住在宿主里（29 文件 / 17,718 行）。本方案把编辑器面按 SDK 分层切成三个包，并先补契约缺口。** |

---

## 1. 现状（实测，2026-10-24）

| 层 | 位置 | 规模 | 归属判断 |
|---|---|---|---|
| 语言核心（词法/语法/语义/lowering/迁移/项目级分析） | `packages/kojo-core` | 11,060 行 | ✅ 已是包，且 `audit:decoupling` 放行（非插件库） |
| 语法树 / 一致性套件 | `packages/kojo-syntax-tree`、`packages/kojo-conformance` | — | ✅ 已是包 |
| **编辑器面**（补全 / 悬停 / 定义 / 引用 / 重命名 / 诊断 / 折叠 / 缩进 / 格式化 / inlay / codeLens / codeAction / 语义高亮 / Monarch / 主题 / 调用层级 / 展开视图 / 项目索引） | `packages/app/src/monaco/kojo2-*.ts` | **29 文件 / 17,718 行** | ❌ **全在宿主**，违反「一切皆插件」 |

宿主里 29 个文件的分布（行数降序，前 10）：`code-actions 1713` / `callhierarchy 1599` / `references 1390` / `rename 1363` / `completion 862` / `providers 828` / `indent 806` / `format 777` / `signature 752` / `project-index 677`。

这 17.7k 行**不是**"该不该挪"的问题——宿主不认识任何游戏名词（审计 A 项过），但它是**一门语言的完整编辑器实现**，与「内核 + 插件」的分层直接冲突：任何一门新语言（或同一门语言的方言）都只能改宿主源码，而不能新增一个包。

---

## 2. 目标包布局（三个包 + 一条契约）

> 包名口径：**不出现 `kojo2`**。2.0 语法是 1.0 的**超集**，将来彻底取代 1.0；
> 在包名上标版本号，等于把"这是另一门语言"写进依赖图——而它其实是同一门语言的
> 下一版。包名沿用既有 `@kojo/kojo-*`（库）/ `@kojo/plugin-*`（插件）两条线。

```
@kojo/kojo-lang          语言面库（非插件）：纯函数 + 纯数据，不碰 Monaco、不碰 IO
@kojo/plugin-kojo-lang   编辑器面插件：把 lang 的实现接到 ui.editor.languageService / ui.monaco.*
@kojo/kojo-sdk           adapter 面向的口上 profile 契约（profile / domainSymbols / eventCatalog /
                         storageClasses / programFeatures / diagnosticNamespace）
```

与既有包的相邻关系：`@kojo/plugin-kojo-sugar` 是 **1.0 的糖层**（升糖 / 反糖 / 格式化规则），
`@kojo/plugin-kojo-lang` 是 **2.0 的整门语言面**；两者并存到 B5 收尾，届时 sugar 的
`computeFormatEdits` 归 `kojo-lang`。

### 2.1 `@kojo/kojo-lang`（库，不是插件）——**B1 已建**

放**与编辑器无关**的判据：符号表、声明表、project-index、sourcemap-model、expand-view、diagnostics 的纯函数部分、indent/format 的纯算法。判据标准：**能不能在 node 里 import 就跑**。

- 依赖：`@kojo/kojo-core`（唯一真源）、`@kojo/plugin-api`（只取类型）。
- 不依赖：`monaco-editor`、`react`、`kernel`。
- 与 `kojo-core` 的界线：core 管"这段文本是什么"（AST/诊断码/编译），lang 管"编辑器要知道什么"（符号树怎么摆、缩进阶梯怎么算、格式化后长什么样）。core 里已有 `incremental.ts`，增量重建留在 core。

**B1 实际建成的样子**（`packages/kojo-lang/src/`，7 个模块）：

| 模块 | 行数 | 来自 |
|---|---|---|
| `constants.ts` | 23 | `monaco/kojo2-constants.ts`（整搬，零依赖叶子） |
| `name-chars.ts` | 78 | 从 `monaco/kojo-completion-position.ts` 抽出（`isNameChar` / `isCjk` / 字符类） |
| `declarations.ts` | 383 | `monaco/kojo2-declarations.ts`（整搬） |
| `sourcemap.ts` | 392 | `monaco/kojo2-sourcemap-model.ts`（整搬） |
| `expand-view.ts` | 583 | `monaco/kojo2-expand-view.ts`（整搬） |
| `symbols.ts` | 532 | `monaco/kojo2-symbols.ts` 的**纯半边** |
| `index.ts` | — | 桶 |

**`symbols` 被切成两半**：判据进包（`kojo2DocumentSymbols` / `kojo2SymbolPathAt` + 事实类型），
Monaco 翻译留宿主（`app/src/monaco/kojo2-symbols.ts`，164 行）。切法不是按行数，是按
"谁能被插件复用"——插件拿不到 Monaco 实例，不该被迫认识 `SymbolKind`。

**包怎么进构建**（三处必须同步，漂一处就红）：
`packages/kojo-lang/package.json` 的 `exports`、`tsconfig.json` + `packages/app/tsconfig.json`
的 `paths`、`vite.config.ts` + `vitest.config.ts` 的 `alias`。**叶子必须排在桶之前**
（alias 的匹配口径是「等于 find」或「以 `find + /` 开头」，桶在前会把 `/constants` 吃掉）。

**⚠ 一条纪律（B1 踩出来的）**：`kojo-lang` 的桶 re-export 整个语言面（约 85 KB），
**进首屏的代码只许引叶子**。第一版只给桶，PS-10 读数当场 3,110 → 3,192；
改叶子后回到 3,110（净 +0.3 KB）。守卫在 `app/tests/ps10-eager-graph.test.ts`
的「开机图里对语言面库的引用必须是叶子」。

### 2.2 `@kojo/plugin-kojo-lang`（插件）

把 lang 的产出接到既有槽位。**能接的立刻接，接不上的先扩契约**（见 §3）。

- 提供：`ui.editor.languageService` 贡献（`languageId: 'kojo2'`）+ `ui.monaco.language` 贡献（Monarch 词法 / 主题 / 缩进规则 / 回车规则）。
- 依赖：`@kojo/plugin-api`、`@kojo/kojo-lang`、`@kojo/kojo-core`。
- 铁律：**不 import 任何 adapter**，游戏事实经 `game.adapter` 槽取（现状已如此）。

### 2.3 `@kojo/kojo-sdk`（adapter 契约）

规范附录 C.1 的八项（`gameFingerprint` / `encodingPolicy` / `layerPolicy` / `storageClasses` / `programFeatures` / `diagnosticNamespace` / `conformanceSuite` / `capability` / `sourceMap`）目前只有 `kojo-core/src/adapter.ts` 一份**内部形状**，没有任何槽位承载它——`grep KojoAdapter` 在 `kojo-core` 之外**零命中**。

这就是「eraFL 想接 kojo2 却无处可接」的根因：不是 eraFL 没写，是**编辑器根本没开这个口**。

> 注：`BOARD.md` 的 `K2-D0`（设计冻结与结构裁决）与 `K2-CONTRACT`（2.0 契约面落点）正卡在这里 —— 包归属要等这两行拍板，否则做完要拆。本方案给的是**可裁决的候选**，不是既成事实。

---

## 3. 契约缺口（这是真正的拦路石，先解决它）

`ui.editor.languageService` 原来能表达的能力只有 9 种：
`definition` / `references` / `rename` / `documentSymbol` / `foldingRange` / `workspaceSymbol` / `codeLens` / `semanticToken` / `inlayHint`。

kojo2 编辑器面需要、而槽位**没有**的，实测是 **4 个**（初版方案写的 6 个里有两个是误判，见下）：

| 缺的能力 | 宿主现有实现 | 后果 |
|---|---|---|
| `completion` | `kojo2-completion.ts` 862 行 + snippets 154 | 补全只能留在宿主 |
| `hover` | `kojo2-hover.ts` 198 | 悬停只能留在宿主 |
| `formatting` | `kojo2-format.ts` 777 | 格式化只能留在宿主 |
| `signatureHelp` | `kojo2-signature.ts` 752 | 实参提示只能留在宿主 |

### 3.1 被排除的两个（**已各有专用槽，不是缺口**）

初版把 `diagnostics` 与 `codeAction` 也列成缺口，核对后是**误判**：

| 能力 | 既有槽 | 形状 |
|---|---|---|
| 诊断 | `ui.editor.decorator` | `LineDecoration` 就是 LSP 诊断的形状（行 / 列区间 / `severity` / `message` / `code` / `source`），供方 `decorate()` 直接产出；`offloadKind` 还能把它挪进计算池 |
| 快速修复 | `ui.editor.codeAction` | `provideActions({ path, text, project, line, scope, diagnostics })` 已收齐三个位置判据，`edits` / `run` 两条落地通道都在 |

再给这两件事开 `languageService` 判别成员 = **同一能力两条路径**：两处各算一份判据，
必然漂移，且漂移表现为"有时候对、有时候不对"，没人会想到去查契约。

kojo2 现在确实**绕过**了这两个槽（`kojo2-diagnostics.ts` 直接 `setModelMarkers`、
`kojo2-code-actions.ts` 自带一条 command 通道），但要改的是**让它们改注册这两个槽**，
不是给它们开新路。这一步归 B3。

### 3.2 做法

按 `ui.editor.languageService` 已有的「单槽 + `kind` 判别」形态**additive 扩 4 个 kind**，
每个 kind 的形状照既有 `definition` 的三态约定（`undefined` = 不认这个请求 /
空结果 = 认但没有 / 有结果 = 结果）。旧贡献方零改动。

多源口径分两组（写进契约头注）：
- **集合型**（`completion`）：各家并集 + 按契约字段去重；
- **单答型**（`hover` / `formatting` / `signatureHelp`）：第一家作答的说了算，
  **给出空结果也算作答**（`''` / `[]` 不再问下一家），弃权只有 `undefined` 一种写法。

这一步做完，17.7k 行里 **约 2.6k 行**（completion / hover / format / signature）有了去处；
diagnostics 与 codeAction 那 2.1k 行改走两个既有槽。

---

## 4. 迁移分批（每批可独立合入、可独立回滚）

| 批 | 内容 | 判据（DoD） | 状态 |
|---|---|---|---|
| **B0** | 契约：`ui.editor.languageService` 扩 **4** 个 kind + 四条取数腿（纯合并函数，不装 provider） | 双 typecheck；既有贡献方零改动；新增 kind 各有一条"不认就跳过"的单测 | ✅ 2026-10-24 |
| **B1** | 建 `@kojo/kojo-lang`：搬 `symbols` / `declarations` / `sourcemap-model` / `expand-view` / `constants` + 抽出 `name-chars`（约 1.9k 行，纯函数） | 宿主改为从包 import，**行为逐字不变**（既有 kojo2 测试全绿）；包内零 monaco / 零 react | ✅ 2026-10-24 |
| **B2** | 建 `@kojo/plugin-kojo-lang`：接**槽位已支持**的 5 项。**本批完成 3 项**（definition / documentSymbol / inlayHint）——definition 已写但**未挂**，另 2 项的判据还在宿主（见下「B2 的实际交付」） | 宿主对应 `registerXxxProvider` 删除；插件未加载时这几项**无人应答**（可见退化，不静默） | 🟡 部分完成（3/5）2026-10-24 |
| **B3** | 接 B0 新扩的 4 项 + 把 diagnostics / codeAction 改注册**既有槽** | 同上；诊断码命名空间走 `diagnosticNamespace`（adapter 可 additive 追加） | |
| **B4** | `ui.monaco.language`：Monarch 词法 / 主题 / 缩进 / 回车搬进插件 | 主题 token 名不变（`theme-contrast` 三档门禁不破） | |
| **B5** | 删宿主残留（`kojo2-*.ts` 归零）+ 建 `@kojo/kojo-sdk`，eraTW / eraFL 各写一份 profile | `grep kojo2- packages/app/src` 为空；两个 adapter 的 profile 都能编出同一份 golden | |

**为什么这个顺序**：B1 是纯搬（零语义变化，风险最低，先拿掉 3.2k 行）；B2 用**现成槽位**证明"插件接得上"；B3 才动契约扩出来的新面；B4 碰主题（有门禁，放后）；B5 才删宿主。

**B0 的实际交付**（2026-10-24）：
- 契约：`packages/plugin-api/src/slots.ts` 四个新判别成员 + `EditorRangeEdit`（列级编辑，与整行的 `EditorTextEdit` 分工写明）；
- 取数腿：`packages/app/src/monaco/kojo-language-service-legs.ts` 四条纯合并函数 + `formattingRequestOf`；
- 单测：`packages/app/tests/kojo-language-service-legs.test.ts`（19 项）、
  `packages/plugin-api/tests/language-service-kinds.test.ts`（4 项，钉住"diagnostics / codeAction 不许加回来"）。

**B0 刻意不装 provider**：四个能力的宿主原生实现还在跑，此刻再挂一枚 provider，补全会翻倍、
悬停会出两段、格式化会按注册顺序抢答——那是**改既有行为**，与 B0 的"零改动"判据冲突。
`install*Provider` 与 `kojo2-*.ts` 的删除必须是**同一步**（B2/B3）。

**B1 的实际交付**（2026-10-24）：
- 新包 `packages/kojo-lang`（7 模块 / 约 1.9k 行），宿主 61 个文件的 import 改指包；
- `kojo2-symbols.ts` 切成两半（判据进包 / Monaco 翻译留宿主，164 行）；
- 新守卫 `packages/kojo-lang/tests/purity.test.ts`（4 项）：零运行时依赖、零 monaco/react/DOM/IO、
  零游戏名词、文件数钉死（防走空匹配）；
- PS-10 新增「开机图里对语言面库的引用必须是叶子」（做过变异实测：改回桶即红，读数 3,110 → 3,192）；
- 三个 `.kojo2` 单源守卫改指新地址（不变量不变，只是那处换了地方）。

**B2 的实际交付**（2026-10-24）：
- 新包 `packages/plugins/kojo-lang`（`@kojo/plugin-kojo-lang`，6 模块）：
  `request.ts`（语言分派）/ `definition.ts` / `symbols.ts` / `inlay.ts` / `plugin.ts` / `index.ts`；
- 语言面库新增 4 模块：`interpolation.ts`（`insideInterpolation` / `insideStringOrComment`，
  从宿主 `kojo-completion-position.ts` 搬出后原样 re-export）+ `definition.ts`（`kojo2DefinitionAt`）
  + `inlay.ts`（`kojo2InlayHints` 全量纯函数段，412 行）+ `adapter-source.ts`（见下）；
- **宿主侧「只挂点名的槽腿」新机制**：`LanguageDescriptor.slotServices`（additive）+
  `registerForLanguageServices(monaco, register, kind?)` 的第三个参数。kojo2 声明
  `slotServices: ['documentSymbol', 'inlayHint']` ⇒ 那两枚 provider 由共享收口挂上，供方是插件；
- **删掉的宿主装配行**：`installKojo2DocumentSymbolProvider` 与 `installKojo2InlayHintsProvider`。
  2.0 大纲与行内提示从此都没有宿主原生实现；
- **契约 additive 一格**：`EditorInlayHint.kind?: 'type' | 'parameter' | 'text'`，缺省 = `parameter`
  （与补这一格之前**逐字相同**，既有贡献方零改动）；
- **`@kojo/kojo-lang/adapter-source`**（B2 期发现的死结，见下「adapter 为什么不能走 `game.adapter`」）；
- 门禁改动（都是"接线变了、取证点跟着变"，不是放宽）：`language-ux-matrix.test.ts` 的
  `shared` 档位判据从"descriptor 全铺"改成"全铺 **或** 点名了这一格"（`sharedReachable`）；
  `kojo2-structure-gate.test.ts` 反向钉住"装配层不再出现 `installKojo2DocumentSymbolProvider`"；
  `kojo-symbols.test.ts` 的装配断言从两门改三门（ERB / `.kojo` / kojo2）。

**adapter 为什么不能走 `game.adapter`**（B2c 的设计发现，别改回去）：

`@巡` 的命名集合绑定名只住在 2.0 `GameAdapter` 里。插件想拿它，最自然的路是
`ctx.tryInject('game.adapter')`——但那条路是断的，两个原因各自独立、都致命：

1. **全仓没有任何插件 provide 过 `game.adapter`**。v1 adapter 只往**槽**（`ui.game.adapter`）
   里注册，而插件读不到槽里的东西（槽是"给宿主装配用的"，不是服务）；
2. **即使拿到，类型也不是一个**。`@kojo/plugin-api` 的 `GameAdapter` 是 v1 形状
   （`gameId` / `displayName`），2.0 的 `GameAdapter` 住 `@kojo/kojo-core`
   （`id` / `eventCatalog` / `kojo2.foreachCollections`）。混用是编译错误，不是"差不多能用"。

于是新增 `@kojo/kojo-lang/adapter-source`：一张模块级登记表
（`registerKojo2AdapterSource(getter)` / `kojo2AdapterNow()` / `kojo2AdapterSourceCount()`），
范式照抄既有的 `ui/kojo2-expand-compile.ts`。宿主组合根在 `ensureGlobalProviders` 里登记，
插件在**请求时**现取（不在 `activate` 时缓存——adapter 可能比插件晚激活，且项目开闭会换人）。

三条口径写进文件头注：零登记零行为（不猜）/ 请求时现取 / 后登记优先、注销只撤自己。
测试 `packages/kojo-lang/tests/adapter-source.test.ts`（7 项）钉住这几条。

**B2 为什么只做了 3/5**（诚实记账，别当成做完了）：
| 没接 | 拦路的是什么 | 归哪批 |
|---|---|---|
| `references` | 判据在 `kojo2-references.ts`（1390 行），运行期依赖 `kojo2-project-index`（677 行），后者 import 宿主的 `ui/kojo2-flag` | B3（开关随 `programFeatures` 进 SDK 时一起搬） |
| `foldingRange` | 判据要 worker 客户端（`tree-sitter/kojo2-worker-runtime` 的 `folds` 查询），而包**不许有 IO / worker**。正解是把"折叠区间"变成 worker 的**纯数据回复**、包只做后处理 | B3（与 B4 的 Monarch 一起，因为都动 worker 边界） |
| `definition`（已写但**未挂**） | 判据已搬、插件已贡献，但宿主还没把 kojo2 的 definition 腿切到槽上——2.0 的转定义带**展开视图**（`expand-view.ts` 的 `via === 'definition'` 两条追加落点），而编译成品住在宿主的模块级登记表 `ui/kojo2-expand-compile.ts` 里。正解是把它做成一个服务（`kojo2.expandCompile`）让插件 `optionalRequires`，**不能**让插件去 import 宿主模块 | B3 第一步 |

**B2c 补记：inlayHint 那条腿怎么走通的**（2026-10-24）：

原方案说 inlay 的拦路虎是"混着 Monaco 类型 + `LARGE_FILE_LINES` + cutover 开关"。实际切了之后
发现三者都能干净分开，而且分开**本来就是对的**：

| 混在一起的东西 | 拆成什么 | 为什么这么归 |
|---|---|---|
| Monaco 的 `InlayHint` / `InlayHintKind` 枚举 | 契约的 `EditorInlayHint` / `EditorInlayHintKind` | 语言包不该认识 Monaco；翻译是宿主的活 |
| `LARGE_FILE_LINES` 的体量降级 | **留在宿主**，包与插件都不看 | "多少行以上不给提示"是产品决策（同一条线还管粘性滚动 / 面包屑 / codeLens），不是语言事实 |
| cutover 开关（`ui/kojo2-flag`） | **不搬**——开关决定"挂不挂这枚 provider"，属于装配层 | 判据函数本身不需要知道自己是第几版语法 |
| adapter 事实 | 经 `adapter` 参数由调用方注入 | 保持 `kojo2InlayHints` 是纯函数（同输入必同输出） |

宿主 `kojo2-inlay.ts` 因此从 551 行降到 175 行（只剩 `toMonacoInlayHints` +
`installKojo2InlayHintsProvider`，判据 re-export 回包）。包侧新增 412 行，插件侧 100 行。

**B1 刻意没搬的三块**（初版方案列了 7 个文件 / 3.2k 行，实测只有 5 个能干净搬走）：

| 没搬 | 行数 | 拦路的是什么 | 归哪批 |
|---|---|---|---|
| `project-index` | 677 | 运行期依赖 `kojo2-references`（1390 行），而后者 import 宿主的 `ui/kojo2-flag`（cutover 开关）。把开关变成参数＝改行为，不是搬运 | B2/B3（开关随 `programFeatures` 一起进 SDK） |
| `kojo2-references` | 1390 | 同上 + 与 `project-index` 互为类型引用 | B2/B3 |
| `kojo2-lexicon` | 98 | 转发 `@kojo/plugin-kojo-sugar` 的中文运算符表。**库依赖插件**是反向分层；正解是让 core 自持运算符表（规范 §5.1 说"沿用现有中文表"，CUTOVER 时迁） | 单独一批（迁运算符表） |

这三块加起来 2,165 行，是 B1 之后宿主里最厚的语言面残留。

---

## 5. 与 eraFL 的关系（本方案的落地理由）

eraFL 今天**没有** `.kojo` 文件，所以 B1–B4 对它的直接收益是零。那为什么还要做：

1. 规范附录 C 把 **eraFL 列为第四个 adapter**（验证字符串值 / `RESULTS` 元数据 / `PRINTDATA` 路线）——它**是** kojo2 的验证目标之一，不是"用不上"。
2. eraFL 的 ERB 侧已经吃到「一切皆插件」的红利（家族索引 / 变量字典 / 指令表 / 约定规则 / 口上 XML 服务全是 adapter 提供的）；kojo2 侧若继续留在宿主，就会出现**同一部游戏两种归属**的分裂。
3. B5 的 `@kojo/kojo-sdk` 一旦存在，eraFL 只要写一份 profile 就能让 kojo2 的语法在 eraFL 工程里可用——**这才是"适配更多 era 类游戏"的机制**，而不是给某一部游戏打补丁。

---

## 6. 明确不做

- **不在 D0 裁决前建包**：`K2-D0` / `K2-CONTRACT` 未拍板时建包，等于把待裁决项做成既成事实。
- **不把 Monaco 类型塞进 `kojo-lang`**：包一旦 import `monaco-editor`，它就只能被宿主用，插件化立刻倒退。
- **不为 kojo2 单独发明一套插件机制**：复用 `ui.editor.languageService` 的单槽 + `kind` 判别，只加成员、不加新槽。
- **不在 B1 顺手"优化"算法**：搬迁批的唯一判据是"行为逐字不变"，优化另开批。
