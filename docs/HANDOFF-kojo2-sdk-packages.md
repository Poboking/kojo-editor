# 交接文档：Kojo 2.0 语言面「包化」五批（B0–B5）

> 写给接手的人。读完这一份就能接着干，不必翻对话记录。
> 最后更新：2026-10-24 · 分支 `b/workbuddy/1024-erafl` · HEAD `697bf9ba`

---

## 0. 一句话背景

这是个 Tauri + Monaco 的 **era 游戏编辑器**（pnpm monorepo，33 个 workspace 项目）。
内核是「一切皆插件」：**零游戏名词**。Kojo 2.0 是新语法（`.kojo2`，口上文件），
它的语言服务判据目前有 1.5 万行散在宿主 `packages/app/src/monaco/kojo2-*.ts` 里。

正在做的事：**把这些判据按「包」重新切**，让插件能接管，最终宿主归零。

---

## 1. 用户的三条硬指令（照办，别讨价还价）

1. **任务是"适配更多 era 游戏"，尤其 eraFL。**
   原话：「你能不能不要这么死板？日文直接翻译成中文不就行了？去你妈的权威来源。
   我们要做得就是适配更多的 era 类游戏，而不是目前没有适应的功能就直接不做了。」
   ⇒ **不许拿"没有权威来源"当不做的理由**。日文名直接译，译完记进对照表。
2. **包名不许带 `kojo2`。**
   原话：「包名别用 kojo2……没必要标识 kojo2 在包上。」
   ⇒ kojo2 之后会彻底取代 kojo1（是超集），包名是 `@kojo/kojo-lang`、`@kojo/plugin-kojo-lang`。
3. **在既有架构内解决**：一切皆插件 + 语言支持思路。
   不许为了赶工在宿主里留第二份判据。

---

## 2. 五批方案与现状

| 批 | 内容 | 状态 |
|---|---|---|
| **B0** | 契约：`ui.editor.languageService` 扩 4 个 kind + 四条取数腿 | ✅ `8f74dae5` |
| **B1** | 建 `@kojo/kojo-lang`：搬 symbols / declarations / sourcemap / expand-view / constants（约 1.9k 行纯函数） | ✅ `e4477343` |
| **B2** | 建 `@kojo/plugin-kojo-lang`：接槽位已支持的 5 项 | 🟡 **4/5**（references / foldingRange 未接） |
| **B3** | 接 B0 新扩的 4 项 + diagnostics / codeAction 改注册既有槽 | 🟡 **第一步已做**（B3a / B3b） |
| **B4** | `ui.monaco.language`：Monarch 词法 / 主题 / 缩进 / 回车搬进插件 | ✅ `7f02ff73` + `f0be5efb`（变基后 `5f70b9ae`） |
| **B5a** | 建 `@kojo/kojo-sdk`（契约 / 结构协议 v4 / 角色表）+ conformance 三列共享 golden | ✅ `9fd1e700` + `d0761751` + `a221954d`（2026-10-28） |
| **B5b** | 删宿主直装残留（`kojo2-*.ts` 归零） | ⬜ 阻塞：B3 余项未收口——宿主直装 **21 文件 / 15,055 行**、**13 条** `installKojo2*` 调用 |

**当前宿主残留**：`packages/app/src` 下 `*kojo2*` = **60 个文件 / 32,941 行**（其中 B5b 点名要清的语言面直装 21 文件 / 15,055 行；结构层 `tree-sitter/kojo2-*` 8 文件不算残留）。
B5b 的目标是 `grep kojo2- packages/app/src` 为空——**不为 grep 改名、不删夹具**。
（套件口径：conformance 的判定逻辑 `language.ts` 零改动；CLI 只在固定注册表 `LANGUAGE_ADAPTER_ENTRIES` + `runLanguage` 各加一条。）

### 已完成的提交（按时间）

```
697bf9ba  B3b：2.0 的转定义真正归插件（含展开体两条落点）
1e0e91f4  B3a：展开视图的编译成品登记表搬进语言面库
46820399  B2c：2.0 行内提示改由插件应答，新增 adapter 来源登记表
d701c530  chore(lock): 补 @kojo/plugin-kojo-lang 的 workspace 链接
a7aaa33b  B2 建语言面插件，2.0 大纲改走槽腿（宿主不再自建）
0b6f8520  fix(erafl): 名字对照的覆盖率判据纠正（相等 → includes），补 5 条真缺口
e4477343  B1 建语言面库，1.9k 行判据搬出宿主（行为逐字不变）
8f74dae5  LS-B0 语言服务扩 4 个 kind + 四条取数腿；包名去 kojo2
```

### B2 已接的 4 项

| 能力 | 包内判据 | 插件供方 | 宿主装配 |
|---|---|---|---|
| `documentSymbol` | `symbols.ts` | `src/symbols.ts` | 共享收口（`slotServices: ['documentSymbol']`） |
| `inlayHint` | `inlay.ts`（412 行） | `src/inlay.ts` | 共享收口（`slotServices: ['inlayHint']`） |
| `definition`（声明落点） | `definition.ts` | `src/definition.ts` | 共享收口（`slotServices: ['definition']`） |
| `definition`（展开体两条落点） | `expand-view.ts` + `expand-compile.ts` | 同上 | 同上 |

---

## 3. 三个必须先搞懂的机制

### 3.1 `slotServices` 点名机制（B2 新增）

`packages/app/src/monaco/language-registry.ts` 的 `LanguageDescriptor` 上有一格：

```ts
slotServices?: readonly SlotServiceKind[];   // 'documentSymbol' | 'inlayHint' | 'definition' | ...
```

kojo2 的 descriptor（`monaco/languages.ts`）声明：
```ts
slotServices: ['documentSymbol', 'inlayHint', 'definition'],
```

共享收口 `registerForLanguageServices(monaco, register, kind?)` 的**第三个参数**带能力名，
于是这些腿会被挂到 descriptor 点名的所有语言上。

**为什么不用 `languageServices: true`**：那 11 枚 v1 provider 里有几枚的空结果会**顶掉 Monaco
内建行为**，最典型是折叠（一旦注册了 `FoldingRangeProvider`，Monaco 就不再兜底缩进折叠）。
点名机制就是"只挂确实已由插件接管的那几格"。

**红线**：往 `slotServices` 里加一格之前，必须确认**那枚原生 provider 已经删掉**。
否则就是两个 provider 并存 → Monaco 合并顺序不可控 → F12 到底跳哪一条不可断言。

### 3.2 桶 vs 叶子（PS-10 体积闸）

- 包桶 `@kojo/kojo-lang` re-export 整包（约 85 KB）；
- **能进首屏的文件只许引叶子**（`@kojo/kojo-lang/inlay` 这种）；
- `vite.config.ts` / `vitest.config.ts` 的 alias 里**叶子必须排在桶之前**。

守卫：`packages/app/tests/ps10-eager-graph.test.ts`（8 项，基线 3,110 KB / 210 文件）。

### 3.3 三处接线必须同步

新增一个包内模块（例如 `expand-compile.ts`），这四处都要改，缺一处就是运行时炸：

1. `packages/kojo-lang/package.json` 的 `exports`
2. `packages/kojo-lang/src/index.ts` 的 `export *`
3. `packages/app/vite.config.ts` + 根 `vitest.config.ts` 的 `alias`
4. `packages/kojo-lang/tests/purity.test.ts` 的**文件数**（现在是 12，加一个就改一个）

`tsconfig` 的 `paths` 用的是通配 `@kojo/kojo-lang/*`，不用逐条加。

---

## 4. 两条「取数缝」（宿主与插件共用的地面）

插件看不见宿主模块。要拿宿主才有的运行时事实，走**模块级登记表**，范式是既有的
`ui/kojo2-expand-compile.ts`：`registerXxx(getter)` + `xxxFor(key)` + `xxxSourceCount()`。

### 4.1 `@kojo/kojo-lang/adapter-source`

拿 **2.0 `GameAdapter`**（`@kojo/kojo-core` 的形状：`id` / `eventCatalog` /
`kojo2.foreachCollections`）。

**为什么不能走 `game.adapter` 服务键**（两个独立原因，都致命）：
1. 全仓**没有任何插件 provide 过**它——v1 adapter 只往**槽**注册，插件读不到槽；
2. 即使拿到，类型也不是一个：`@kojo/plugin-api` 的 `GameAdapter` 是 v1 形状
   （`gameId` / `displayName`）。混用是**编译错误**，不是"差不多能用"。

宿主在 `ui/editor-global-providers.ts` 的 `ensureGlobalProviders` 里登记（与
`options.kojo2Adapter` 注入面**同源**，两条腿拿同一枚实例）；插件在**请求时**现取
（不在 `activate` 时缓存——adapter 可能比插件晚激活，项目开闭会换人），并校验
`adapter.id === request.project?.adapterId`。

### 4.2 `@kojo/kojo-lang/expand-compile`

拿**那一次编译的成品**（`{ compiled: { erb }, sourceMapModel }`），给
`expandViewAt` 算展开体落点。B3a 从宿主整张搬进包，宿主只剩 re-export。

---

## 5. 红线（违反会被门禁抓，或者更糟——抓不住但会烂）

1. **判据只有一份**。判据搬进包之后，宿主那侧**必须删掉**，不许留"兜底实现"。
   典型反例：B3b 把 `kojo2DefinitionLinksOf` 整个删了，`kojo2-providers.test.ts` 里那组
   六条断言也整组删了——原位留了一段"判据去哪了"的指路注释。
2. **门禁改动只能因为"取证点变了"**，不能因为"测试红了就改期望"。
   每次改门禁都要在注释里写清**为什么这仍是同一个判据**（甚至更紧）。
3. **包的三条硬约束**（`packages/kojo-lang/tests/purity.test.ts` 钉死）：
   零 Monaco / 零 React / 零 DOM / 零 node IO、零游戏名词、只依赖 `@kojo/kojo-core`。
   **连 `import type` 也算**——它运行时被擦除、单测永远绿，等真要交给插件那天才发现完蛋。
4. **插件零游戏知识**（`packages/plugins/kojo-lang/tests/purity.test.ts` 钉死，白名单式）。
5. **additive 优先**。给契约加可选字段时，缺省行为必须与加之前**逐字相同**，
   既有贡献方零改动。例：`EditorInlayHint.kind?` 缺省 `parameter`。
6. **不猜**。取不到事实就给空 / `undefined`，不编一个"看起来合理"的值。
   例：`@巡` 没有 adapter 时只给本文件能证明的数组绑定，命名集合那一路留空。

---

## 6. 校验命令与基线读数

```bash
# 双 typecheck（根 + app，两个都要过）
npx tsc -p tsconfig.json --noEmit ; echo "ROOT=$?"
npx tsc -p packages/app/tsconfig.json --noEmit ; echo "APP=$?"

# 解耦审计（A–D 四项，插件 23 个）
npm run audit:decoupling

# 包 / 插件 / 契约（快，10 秒）
npx vitest run packages/kojo-lang/tests packages/plugins/kojo-lang/tests packages/plugin-api/tests

# 宿主全量（慢，7–9 分钟，建议后台跑）
npx vitest run packages/app/tests
```

**B3b 时的基线**：双 typecheck `0/0`；audit A–D 全过；`packages/app/tests` **7749 项全绿**
（389 文件）；包 / 插件 / 契约 **303 项全绿**。

> 已知抖动：`packages/app/tests/kojo2-project-analysis.test.ts` 的性能闸
> （10000 个 `@函` 判定中位数 ≤ 100ms）在**并行跑别的测试时**会飘到 120–130ms 假红。
> 单跑通过即视为通过。

---

## 7. 下一批：三个入口（按建议顺序）

### 入口 A — `references`（B2 剩余最大一块）

| 件 | 行数 | 位置 |
|---|---|---|
| `kojo2-references.ts` | 1390 | `packages/app/src/monaco/` |
| `kojo2-project-index.ts` | 677 | `packages/app/src/monaco/` |

**拦路的是什么**：`kojo2-references.ts` 运行期 import 宿主的 `ui/kojo2-flag`（cutover 开关）。
把开关变成参数 = **改行为**，不是搬运。

**两条正解**（择一，别走第三条）：
1. 把开关随 `programFeatures` 一起进 SDK（开关语义变成 adapter 事实）；
2. 把开关降级成**调用方注入的参数**，判据函数本身不认识"自己是第几版语法"。

**注意**：这两个文件**互为类型引用**，必须一起搬，不能只搬一个。

### 入口 B — `foldingRange`

判据要 worker 客户端（`tree-sitter/kojo2-worker-runtime.ts` 的 `folds` 查询），
而包**不许有 IO / worker**。

**正解**：把"折叠区间"变成 worker 的**纯数据回复**，包只做后处理。
与 B4 的 Monarch 一起做（都动 worker 边界）。

### 入口 C — eraFL 的 2.0 adapter 从未接上（真实缺口）

`packages/app/src/ui/editor-pane/use-monaco-instance.ts:280`：

```ts
ensureGlobalProviders({ kojo2Adapter: () => ERATW_GAME_ADAPTER });
```

**只喂了 eraTW**。eraFL 的 `packages/plugins/erafl-adapter/src/plugin.ts:196` 那枚
`GameAdapter` 是 **v1 契约对象**（`@kojo/plugin-api`），不是 2.0 形状。

⇒ 今天打开 eraFL 项目，2.0 语言面拿到的 adapter 事实其实是 eraTW 的（或为空）。

**归 B5a**（eraFL 写自己的 2.0 profile；2026-10-28 已落地，见 `packages/plugins/erafl-adapter/src/kojo2/` 与 `adapter-manifest.ts` 的 `kojo2AdapterExport`）。用户的核心诉求就是 eraFL，这条**优先级实际很高**。

---

## 8. 踩过的坑（每条都是真花过时间的）

1. **`GameAdapter` 有两个同名不同形状的类型**。
   2.0 的在 `@kojo/kojo-core`，v1 的在 `@kojo/plugin-api`。混用是编译错误。
2. **`game.adapter` 服务键是死的**。全仓无人 provide，别在插件里 `tryInject` 它。
3. **`() => void` 不是 `IDisposable`**。登记表的注销函数要包成 `{ dispose: unregister }`
   才能进 `globalDisposers`。
4. **`registerForLanguageServices` 不带第三参 = 只覆盖 v1 两门方言**，2.0 没人应答。
   B3b 之前 `kojo-definition.ts` 就是这样，`slotServices` 加了 `'definition'` 也不生效。
5. **`LocationLink` 的 `range` 与 `targetSelectionRange` 是两件事**。
   跨行段落点若把整段当选区，编辑器一进去就选中几百行。
6. **去重键要带上 range 的终点行**。`collectDefinitionLocations` 只按
   `文件+行+列` 去重，会把"整段落点"与"起点那一行"合并成一条。
7. **`endColumnOf` 是 1 基**，`'# 设 队伍 整数[3]'` 是 13 个字符 ⇒ 提示压在第 14 列。
   手数会错，直接跑测试看实际值。
8. **门禁正则别钉死整条数组**。`language-ux-matrix` 的 `slotServices: ['documentSymbol']`
   在加了 `'inlayHint'` 之后就红了——而"多接管一条腿"正是方案方向。
   改成"数组里含 `documentSymbol`"才是对的判据。
9. **eraFL 名字对照的覆盖率判据是「名字里还有没有假名」，不是「表里有没有这个字符串」**。
   用相等去比 `includes` 语义会得出"129/129 全缺"的假警报（真缺口只有 4 个）。
10. **性能闸在并行负载下会假红**。单跑复验再判断。

---

## 9. 文件地图

```
packages/
├─ kojo-lang/                     ← 语言面库（纯函数，零 Monaco/IO/游戏名词）
│  ├─ src/
│  │  ├─ constants.ts             词表 / 扩展名 / 语言 id
│  │  ├─ declarations.ts          声明事实
│  │  ├─ symbols.ts               大纲判据
│  │  ├─ definition.ts            同文件落点判据
│  │  ├─ inlay.ts                 行内提示判据（412 行）
│  │  ├─ interpolation.ts         插值 / 字符串注释判据
│  │  ├─ sourcemap.ts             source map 模型
│  │  ├─ expand-view.ts           展开视图判据（模板 / 池 / 随机）
│  │  ├─ expand-compile.ts        ★ 编译成品登记表（B3a 搬入）
│  │  ├─ adapter-source.ts        ★ 2.0 adapter 登记表（B2c 新建）
│  │  ├─ name-chars.ts
│  │  └─ index.ts                 桶（**首屏禁引**）
│  └─ tests/                      purity（文件数 12）+ adapter-source + expand-compile
├─ plugins/
│  └─ kojo-lang/                  ← 插件侧（供方）
│     ├─ src/
│     │  ├─ request.ts            语言分派（languageId 优先，退回扩展名）
│     │  ├─ definition.ts         三条落点（声明 + 展开体两条）
│     │  ├─ symbols.ts            符号树 + 类别映射
│     │  ├─ inlay.ts              提示 + 类别映射（HINT_KIND）
│     │  ├─ plugin.ts             三枚贡献，order = 10
│     │  └─ index.ts
│     └─ tests/                   plugin.test.ts（21 项）+ purity.test.ts
├─ plugin-api/                    ← 契约
│  ├─ src/slots.ts                EditorSymbolLocation.range? / EditorInlayHint.kind?
│  └─ src/events.ts               RevealSpan / RevealRange
└─ app/                           ← 宿主
   ├─ src/monaco/
   │  ├─ language-registry.ts     LanguageDescriptor.slotServices?
   │  ├─ register-dialects.ts     registerForLanguageServices(monaco, cb, kind?)
   │  ├─ languages.ts             kojo2 descriptor（三格 slotServices）
   │  ├─ kojo-definition.ts       共享收口（带 'definition'）+ toDefinitionLinks
   │  ├─ kojo2-*.ts               ← 60 文件 / 32,941 行；B5b 目标＝语言面直装 21 文件归零
   │  └─ reveal-position.ts       全仓唯一落点判据 clampRevealPosition
   ├─ src/ui/
   │  ├─ editor-global-providers.ts  ★ 装配总入口（登记 adapter 来源在这里）
   │  ├─ kojo2-expand-compile.ts     现在只剩 re-export
   │  └─ kojo2-flag.ts               cutover 开关（入口 A 的拦路虎）
   └─ tests/                       389 文件 / 7749 项
```

★ = 本批新增或大改的关键件。

---

## 10. 接手后第一件事

```bash
git log --oneline -3          # 确认在 697bf9ba
npm run audit:decoupling      # 应该 A–D 全过
npx vitest run packages/kojo-lang/tests packages/plugins/kojo-lang/tests   # 应该 46 项全绿
```

三条都过 ⇒ 环境是干净的，可以直接开入口 A（`references`）。

如果只有性能闸红、别的都绿 ⇒ 先单跑那条确认是抖动，别当成回归去改判据。

---

## 11. 文档索引

- `docs/PLAN-kojo2-sdk-packages.md` —— 方案本体。**每批做完都要更新这张表**，
  包括「为什么只做了 N/M」的诚实记账和「门禁为什么这么改」的对照表。
- `.workbuddy-ai/memory/2026-10-24.md` —— 逐批的工作日志（含更细的取舍理由）。
- 各源文件的**头注**是第一手资料：为什么这么分、否决了哪几条替代路，都写在那里。
