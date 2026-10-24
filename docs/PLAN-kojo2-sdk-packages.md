# Kojo 2.0 的包化方案（SDK 口径）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-24 |
| 状态 | **设计稿**：只定包归属与迁移顺序，不动代码 |
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

```
@kojo/kojo2-lang        语言面库（非插件）：纯函数 + 纯数据，不碰 Monaco、不碰 IO
@kojo/plugin-kojo2      编辑器面插件：把 lang 的实现接到 ui.editor.languageService / ui.monaco.*
@kojo/kojo2-sdk         adapter 面向的口上 profile 契约（profile / domainSymbols / eventCatalog /
                        storageClasses / programFeatures / diagnosticNamespace）
```

### 2.1 `@kojo/kojo2-lang`（库，不是插件）

放**与编辑器无关**的判据：符号表、声明表、project-index、sourcemap-model、expand-view、diagnostics 的纯函数部分、indent/format 的纯算法。判据标准：**能不能在 node 里 import 就跑**。

- 依赖：`@kojo/kojo-core`（唯一真源）、`@kojo/plugin-api`（只取类型）。
- 不依赖：`monaco-editor`、`react`、`kernel`。
- 与 `kojo-core` 的界线：core 管"这段文本是什么"（AST/诊断码/编译），lang 管"编辑器要知道什么"（符号树怎么摆、缩进阶梯怎么算、格式化后长什么样）。core 里已有 `incremental.ts`，增量重建留在 core。

### 2.2 `@kojo/plugin-kojo2`（插件）

把 lang 的产出接到既有槽位。**能接的立刻接，接不上的先扩契约**（见 §3）。

- 提供：`ui.editor.languageService` 贡献（`languageId: 'kojo2'`）+ `ui.monaco.language` 贡献（Monarch 词法 / 主题 / 缩进规则 / 回车规则）。
- 依赖：`@kojo/plugin-api`、`@kojo/kojo2-lang`、`@kojo/kojo-core`。
- 铁律：**不 import 任何 adapter**，游戏事实经 `game.adapter` 槽取（现状已如此）。

### 2.3 `@kojo/kojo2-sdk`（adapter 契约）

规范附录 C.1 的八项（`gameFingerprint` / `encodingPolicy` / `layerPolicy` / `storageClasses` / `programFeatures` / `diagnosticNamespace` / `conformanceSuite` / `capability` / `sourceMap`）目前只有 `kojo-core/src/adapter.ts` 一份**内部形状**，没有任何槽位承载它——`grep KojoAdapter` 在 `kojo-core` 之外**零命中**。

这就是「eraFL 想接 kojo2 却无处可接」的根因：不是 eraFL 没写，是**编辑器根本没开这个口**。

> 注：`BOARD.md` 的 `K2-D0`（设计冻结与结构裁决）与 `K2-CONTRACT`（2.0 契约面落点）正卡在这里 —— 包归属要等这两行拍板，否则做完要拆。本方案给的是**可裁决的候选**，不是既成事实。

---

## 3. 契约缺口（这是真正的拦路石，先解决它）

`ui.editor.languageService` 今天能表达的能力只有 9 种：
`definition` / `references` / `rename` / `documentSymbol` / `foldingRange` / `workspaceSymbol` / `codeLens` / `semanticToken` / `inlayHint`。

kojo2 编辑器面需要、而槽位**没有**的：

| 缺的能力 | 宿主现有实现 | 后果 |
|---|---|---|
| `completion` | `kojo2-completion.ts` 862 行 + snippets 154 | 补全只能留在宿主 |
| `hover` | `kojo2-hover.ts` 198 | 悬停只能留在宿主 |
| `diagnostics` | `kojo2-diagnostics.ts` 409 | 诊断只能留在宿主（**最伤**：诊断是语言包的核心价值） |
| `codeAction` | `kojo2-code-actions.ts` 1713 | 快速修复只能留在宿主 |
| `formatting` / `onTypeFormatting` | `kojo2-format.ts` 777 | 格式化只能留在宿主 |
| `signatureHelp` | `kojo2-signature.ts` 752 | 实参提示只能留在宿主 |

**做法**：按 `ui.editor.languageService` 已有的「单槽 + `kind` 判别」形态**additive 扩 6 个 kind**，每个 kind 的形状照既有 `definition` 的三态约定（`undefined` = 不认这个请求 / `{items: []}` = 认但没有 / `{items: [...]}` = 结果）。旧贡献方零改动。

这一步做完，17.7k 行里 **约 5.5k 行**（completion / hover / diagnostics / codeAction / format / signature）才有地方可去。

---

## 4. 迁移分批（每批可独立合入、可独立回滚）

| 批 | 内容 | 判据（DoD） |
|---|---|---|
| **B0** | 契约：`ui.editor.languageService` 扩 6 个 kind（只加类型与宿主转发，无实现搬动） | 双 typecheck；既有贡献方零改动；新增 kind 各有一条"不认就跳过"的宿主单测 |
| **B1** | 建 `@kojo/kojo2-lang`：搬 `symbols` / `declarations` / `project-index` / `sourcemap-model` / `expand-view` / `lexicon` / `constants`（约 3.2k 行，纯函数） | 宿主改为从包 import，**行为逐字不变**（既有 kojo2 测试全绿）；包内零 monaco / 零 react |
| **B2** | 建 `@kojo/plugin-kojo2`：先接**槽位已支持**的 5 项（definition / references / documentSymbol / foldingRange / inlayHint） | 宿主对应 `registerXxxProvider` 删除；插件未加载时这 5 项**无人应答**（可见退化，不静默） |
| **B3** | 接 B0 新扩的 6 项（diagnostics 先做，价值最高） | 同上；诊断码命名空间走 `diagnosticNamespace`（adapter 可 additive 追加） |
| **B4** | `ui.monaco.language`：Monarch 词法 / 主题 / 缩进 / 回车搬进插件 | 主题 token 名不变（`theme-contrast` 三档门禁不破） |
| **B5** | 删宿主残留（`kojo2-*.ts` 归零）+ 建 `@kojo/kojo2-sdk`，eraTW / eraFL 各写一份 profile | `grep kojo2- packages/app/src` 为空；两个 adapter 的 profile 都能编出同一份 golden |

**为什么这个顺序**：B1 是纯搬（零语义变化，风险最低，先拿掉 3.2k 行）；B2 用**现成槽位**证明"插件接得上"；B3 才动契约扩出来的新面；B4 碰主题（有门禁，放后）；B5 才删宿主。

---

## 5. 与 eraFL 的关系（本方案的落地理由）

eraFL 今天**没有** `.kojo` 文件，所以 B1–B4 对它的直接收益是零。那为什么还要做：

1. 规范附录 C 把 **eraFL 列为第四个 adapter**（验证字符串值 / `RESULTS` 元数据 / `PRINTDATA` 路线）——它**是** kojo2 的验证目标之一，不是"用不上"。
2. eraFL 的 ERB 侧已经吃到「一切皆插件」的红利（家族索引 / 变量字典 / 指令表 / 约定规则 / 口上 XML 服务全是 adapter 提供的）；kojo2 侧若继续留在宿主，就会出现**同一部游戏两种归属**的分裂。
3. B5 的 `@kojo/kojo2-sdk` 一旦存在，eraFL 只要写一份 profile 就能让 kojo2 的语法在 eraFL 工程里可用——**这才是"适配更多 era 类游戏"的机制**，而不是给某一部游戏打补丁。

---

## 6. 明确不做

- **不在 D0 裁决前建包**：`K2-D0` / `K2-CONTRACT` 未拍板时建包，等于把待裁决项做成既成事实。
- **不把 Monaco 类型塞进 `kojo2-lang`**：包一旦 import `monaco-editor`，它就只能被宿主用，插件化立刻倒退。
- **不为 kojo2 单独发明一套插件机制**：复用 `ui.editor.languageService` 的单槽 + `kind` 判别，只加成员、不加新槽。
- **不在 B1 顺手"优化"算法**：搬迁批的唯一判据是"行为逐字不变"，优化另开批。
