# 交接文档：eraFL 适配层（v1 已交付 · v2 全缺）

> 上一份交接件 `docs/HANDOFF-kojo2-sdk-packages.md` 讲的是**横向**问题（语言面怎么包化，所有游戏共用）；
> 本份讲**纵向**问题（eraFL 这一个游戏怎么真正接上 2.0）。两份不互相阻塞，可以并行开工。

---

## 0. 一句话背景

eraFL 的 **v1 适配层已经做完**，而且是三个 adapter 里功能最全的一个（**3,958 行 / 19 件**，
口上 XML 服务是它独有的，另两作没有），但它的 **2.0 面一行代码都没有**：`src/kojo2/` 目录不存在，
没有 `ERAFL_GAME_ADAPTER`，没有 `KojoEmitBackend`，没有 `library-table`。

更糟的是：宿主把 2.0 的 adapter **写死成 eraTW**（`packages/app/src/ui/editor-pane/use-monaco-instance.ts:280`）。
所以今天打开一个 eraFL 工程，2.0 语言面（补全 / 悬停 / 签名 / 行内提示 / 转定义 / 文档符号）
拿到的是 **eraTW 的游戏事实** —— eraTW 的九事件、eraTW 的代词落点、eraTW 的 `@巡` 集合。

**这不是"还没做"，这是"做错了"。** 而且它比"没做"更危险：错误的事实不会报错，
只会给出**看起来对、其实属于另一个游戏**的提示。

---

## 1. 用户的硬指令（原话，照办，别讨价还价）

1. > 「你能不能不要这么死板？日文直接翻译成中文不就行了？去你妈的权威来源。我们要做得就是适配更多的era类游戏，
   > 而不是目前没有适应的功能就直接不做了？！请你直接提供解决方案，在符合当前架构设计、一切皆插件、
   > 语言支持思路的前提下！ERB要提供最基本的编辑器体验（函数跳转等等等），对于kojo2，则根据目前最新提出的
   > SDK的概念和规范，设计成对应的包，为kojo2提供功能。记住，你的任务就是让本编辑器适配erafl。」

2. > 「按你说的来，但包名别用kojo2，kojo2之后将彻底取代kojo1的语法，是kojo1版本的超集，没必要标识kojo2在包上。」

3. > 「开始下一阶段，并且把你的erafl游戏知识也给补全」

**读法（三条都要落地）：**

- **不许拿"官方没资料 / 没有权威来源"当不做的理由。** 日文名直接按语境译；证据用**真盘语料**
  （`D:/Game/erafl`，本机可访问），不用外部词表，不要求逐字对齐某个标准译名。
- **v1 该有的编辑器体验（跳转、索引、诊断、面板）必须有**；v2 要按 SDK 规范**做成包**。
- **包名不出现 `kojo2`**：eraFL 的 2.0 面就是 `@kojo/plugin-erafl-adapter` 的一部分，
  目录叫 `src/kojo2/` 只是**内部分层**（照 eraTW 的既有约定），不新增包。

---

## 2. eraFL 是什么：四处结构差异（照抄 eraTW 会写废）

这一节是本交接件最重要的部分。**eraTW 的 `src/kojo2/`（16 件 / 2,666 行）是模板，不是答案** ——
它的每一件都编码了 eraTW 的引擎事实，而 eraFL 在这四件事上与它不同。

### 2.1 口上主形态是 XML，ERB 侧只剩注册壳

eraFL 的口上内容写在 `ERB/口上/{编号}_{名称}/*.xml` 里（`<command com="300" name="会話" kojoPlace="TOP">`），
ERB 里只有一个壳函数把 XML 挂进引擎：

```erb
@KOJO_DEFINE_K1099
#DIMS CONST XML_PATH_COM
#DIM CONST 汎用口上番号
XML_PATH_COM = "ERB/口上/1099_うふふお姉さん/KOJO_K1099_COM.xml"
汎用口上番号 = 1099
CALL KOJO_XML_REGISTER(XML_PATH_COM, 汎用口上番号, XMLID_KOJO_CLASS_COM)
```

而引擎 `@FL_INIT_LOADER` 会逐个 `CALL` `KOJO_DEFINE_K0..5999`
（`ERB/SYSTEM/FL_INIT_LOADER.ERB`）。**没被任何 define 注册的 XML，引擎连打开都不会打开。**

**后果（对 2.0 的直接含义）：**

- eraTW 的 `# 机` / `@织` / `# 表` / `# 池` / `选项` 那一整套 2.0 语法，**在 eraFL 的编辑主战场（XML）里没有落点**。
  照抄 16 件写完，作者打开一个口上 XML 会发现"什么也没变"。
- eraFL 真正需要 2.0 的地方有**两块**：ERB 壳函数（少量、结构固定）和 **XML 本身**（大量、属性驱动）。
  后者没有先例 —— 见 §5 入口 E。

### 2.2 目录命名是下划线，5xxx 段是主角

| | 分隔符 | 形态 | 主角段 |
| --- | --- | --- | --- |
| eraTW | 空格 | `{编号} {名称}` | 1–999 |
| eraFL | **下划线** | `{编号}_{名称}` | **5xxx**（`5192_主人公口上_汎用_流され人妻`） |

编号 1–4 位；**名称段本身可含下划线**，所以只切**第一个**下划线
（`ERAFL.kojoDirPattern = /^(\d+)_(.+)$/`，`packages/plugins/erafl-adapter/src/constants.ts:53`）。

Chara CSV 文件名三种分隔并存（实测）：`Chara10_ティア.csv` / `Chara0 あなた.csv` / `chara25_リナ.csv`
⇒ 前缀大小写不敏感、编号后**不强制分隔符**（`charaCsvPattern = /^chara(\d+)/i`）。

### 2.3 编码是 **UTF-8 BOM + CRLF**（eraTW 是 UTF-16LE）

实测（2026-10-24，`od -An -tx1` 取头 8 字节）：

- `ERB/口上/1099_うふふお姉さん/KOJO_DEFINE_K1099.ERB` → `ef bb bf 3b 2d …` = **UTF-8 BOM**
- `ERB/口上/1000_汎用キャラテスト/KOJO_K1000_COM.xml` → `ef bb bf 3c 3f …` = **UTF-8 BOM**

而 eraTW 的 `ERATW_ENCODING_POLICY.defaultEncoding = 'utf-16le-bom'`。
**这一格照抄必错，而且错得很安静**：UTF-16 解码器读 UTF-8 文件会得到乱码，
反过来会把整个文件判成"不可读"。

### 2.4 九事件里只有 **4 个**是引擎事件，其余五个 eraFL 自己包了一层

eraTW 的 `eventCatalog` 是九事件全量（`EVENTFIRST` / `EVENTTRAIN` / `EVENTLOAD` / `EVENTSHOP` /
`EVENTBUY` / `EVENTCOM` / `EVENTEND` / `EVENTTURNEND` / `EVENTCOMEND`，见
`eratw-adapter/src/kojo2/event-catalog.ts`）。

eraFL 真盘实测（`^@EVENT(…)\b` 精确匹配函数**定义**，不是调用点）：

| 引擎事件 | eraFL 真盘 | 说明 |
| --- | --- | --- |
| `EVENTFIRST` | ✅ `ERB/SYSTEM/NEWGAME.ERB:76` | 真定义 |
| `EVENTLOAD` | ✅ `ERB/SYSTEM/SAVELOAD.ERB:441` | 真定义 |
| `EVENTSHOP` | ✅ `ERB/SHOP/SHOP.ERB:6` | 真定义 |
| `EVENTBUY` | ✅ `ERB/SHOP/SHOP.ERB:113` | 真定义 |
| `EVENTTRAIN` | ❌ 无定义 | eraFL 用 `@FL_*` / 自己的流程函数代替 |
| `EVENTCOM` | ❌ 无定义 | 同上 |
| `EVENTEND` | ❌ 无定义 | 同上 |
| `EVENTTURNEND` | ❌ 无定义 | `ERB/SYSTEM/TURNEND.ERB:4` 是 **`@FL_EVENTTURNEND`**（eraFL 自己的回合末流程），第 9 行的 `@EVENTTURNEND` 只是 `DEBUGPRINTFORML` 的字符串 |
| `EVENTCOMEND` | ❌ 无定义 | `ERB/QUEST/QUEST_MAIN.ERB:218` 是 **`@QST_EVENTCOMEND`**，第 216 行注释说明它「从 `@EVENTCOMEND` 被调用」——但那个 `@EVENTCOMEND` 在树里不存在 |

**更坑的一点**：树里有**几十个**以 `EVENTTRAIN_` / `EVENTEND_` 开头的**作者助手函数**：

```
@EVENTTRAIN_K28_COMFORT          @EVENTEND_K28_COMFORT
@EVENTTRAIN_RELATION_DAILY_恋慕ルート   @EVENTEND_IAN
@EVENTTRAIN_EVENT_QUEST_57_INTRO_SET_FLAG
```

它们**不是引擎事件**，只是名字以事件名打头。任何按「前缀匹配事件函数」的判据都会把它们全收进来。

⇒ **`eventCatalog` 与 `# 机` 的 `wrapMachine` 都不能照抄 eraTW。** 要先把三个口径定下来：

1. **声明几条**：4 条（只声明真定义）还是 9 条（声明引擎语义、即使本作没用）？
2. **`forced` 怎么给**：eraTW 给 `EVENTFIRST` / `EVENTEND` / `EVENTTURNEND` 标 `forced: true`
   （引擎保证触发）。eraFL 的 `EVENTEND` / `EVENTTURNEND` 根本没有引擎事件 —— 标 `forced` 是撒谎。
3. **`# 机` 落成什么形状**：eraTW 落 `@EVENTxxx` + `#PRI/#LATER/#ONLY`。eraFL 没有引擎事件函数，
   `# 机` 要么落成「CALL 到自己的流程函数」的壳，要么这一版直接不支持（报 `core/feature/unsupported`，
   fail-visible，不静默造一个假函数）。**这一条建议先不做，等入口 D 有真语料再定。**

---

## 3. v1 已交付（3,958 行 / 19 件）

```
packages/plugins/erafl-adapter/src/
├── index.ts                 33   导出面
├── constants.ts             54   领域常量（detect 三件套 / 路径 / 两个正则）
├── plugin.ts               387   插件装配 + v1 GameAdapter 对象 + 口上 XML 服务
├── chara-csv.ts            107   Chara CSV / 口上目录名解析
├── family-index.ts         126   函数家族识别（固定五族，后缀式）
├── conventions.ts          539   口上约定规则集（五条，全真盘读数）
├── variable-schema.ts      602   变量字典（CSV 名表 + ERH 声明 + 市场字典包）
├── instruction-table.ts    277   方言指令表（差集产物：127 词）
├── name-glossary.ts        192   日文名 → 中文名对照（125 + 36 + ~15 条）
├── state-lines.ts           55   剧情线预设（五条，按真盘命中数筛）
├── scaffold.ts             154   口上脚手架（纯函数、不写盘）
├── kojo-xml/
│   ├── parse.ts            609   手写扫描解析器（不抛 / 要坐标 / 要容错）
│   ├── service.ts          197   口上 XML 服务（`WellKnownServices.KojoXml`）
│   ├── schema.ts           140   游戏侧规格（属性 / com / place）
│   ├── encoding.ts          76   字节 → 文本（BOM 判定）
│   └── index-build.ts       65   确定排序的索引构建
└── preview/
    ├── conditions.ts       134   条件抽取（白名单判据）
    ├── interpolate.ts      160   记号替换（`%CALLNAME:…%` / `[$MNAME]` …）
    └── index.ts             51   预览总装
```

**逐件一句话：**

- **`constants.ts`** —— 唯一的常量出口。`ERAFL.detect` 是**三件同时成立**才算 eraFL 工程：
  `FLconfig.xml`（eraFL 独有外部服务配置）+ `ERB/口上` 是**目录** + `CSV/CFLAG.CSV`（证明可玩，不是空壳）。
- **`family-index.ts`** —— eraFL 没有「面」这一层，家族**固定五族**、head 本身就是家族：
  `KOJO_DEFINE_K{n}`（135）/ `KOJO_DEFINE_NAME_K{n}`（96）/ `KOJO_FOR_MALE_K{n}`（26）/
  `KOJO_FOR_FEMALE_K{n}`（26）/ `KOJO_DEFINE_KOJO_INFO_K{n}`（96）。无 `_KX{n}` 占位符、
  无指令号尾槽 ⇒ `instructionFaces` 显式声明为空数组。
- **`conventions.ts`** —— 五条规则，**每条都由引擎事实推出**，不是风格建议。最关键的一条：
  `unregistered`（孤儿 XML）的硬后果是「引擎根本不会打开它」。注册点按**全 ERB 树的 `.xml` 字面量**收集
  （不是只认 `XML_PATH*` 常量），因为立绘 XML 走的是 `CALL LOAD_UNIQUE_XML_PORTRAIT("…xml", …)` 的字面实参。
  代价是每轮读全树 ERB（2,016 份 / 20.7 MB），换来零误报。
- **`variable-schema.ts`** —— 三层数据源：`CSV/{变量名}.csv` 名表（20 份有条目 / 5 份 0 条照样建空表）+
  市场字典包追加 + 全树 `.ERH` 的 `#DIM/#DIMS` 声明（112 份 / **3,507 个唯一声明名**）。
  引擎把 `.ERH` 声明装进**全局**标识符字典 ⇒ `CFLAG:衣装部位_頭` 与 `CFLAG:0` 是同一个槽位。
- **`instruction-table.ts`** —— 差集产物。分母是宿主两份词表并集 148 词，语料是 2,016 份 `.ERB` / 601,586 行。
  `@函数名` 面 17,750 种**进表 0**（`@名字` 本身就是游戏侧定义）；行首语句词 213 种 → **进表 127**（+人工补录 2）。
- **`name-glossary.ts`** —— 数据来源**不是拍脑袋翻的**：125 条取自 `@KOJO_DEFINE_NAME_K{n}` 的返回值
  （游戏自己的显示名，已是中文）、36 条取自 `CSV/CHARA/Chara{n}_{日文名}.csv` 的 `名前` 行、
  约 15 条是游戏自己没译干净的残留（由本表补译）。消费方按**键长降序**匹配。
- **`state-lines.ts`** —— 五条线，判据是**真盘当条件用的次数**（好感度 45 / 面識 16 / 依存度 27 /
  従属度 11 / 支配度 11），不是"CSV 里有这个名字"。CFLAG 是二维的（`CFLAG:{角色}:{索引}`），
  同一状态在不同函数里三种拼写 = 三条不同依赖键 ⇒ 一条线必须列全。
- **`scaffold.ts`** —— 纯函数、不写盘。**必须成对产出两个文件**（XML + define 壳），只给 XML 等于没写。
  形态照真盘 `1099`，编码 UTF-8 BOM + CRLF。
- **`kojo-xml/parse.ts`** —— 手写扫描器（不用通用 XML 库）的三条理由：不抛异常（要收集诊断）、
  要坐标（面板要跳行）、要容错（作者手写 XML 常有未闭合标签）。
- **`kojo-xml/service.ts`** —— 索引生命周期 + 订阅。**批量读盘**（`readBytesMany` 每批 64 份，
  一次进项目读 293 份；逐份读会变成 293 趟 IPC）。
- **`preview/conditions.ts`** —— 「哪些属性算条件」的判据是**被调用后是否命中**，用**白名单**而非黑名单
  （语料里有拼错的属性 `ikojoPlace` / `sExclusive` / `ust`，黑名单会把它们当成新条件）。

**测试：13 个文件 / 约 189 项**（顶层 11 件 + `preview/` 2 件；`tests/kojo-xml/` 目录是空的，
`kojo-xml` 的用例全在 `tests/kojo-xml.test.ts` 里，30 项）。

**宿主侧接线（只有三处，都是 v1）：**

| 位置 | 干什么 |
| --- | --- |
| `packages/app/src/bootstrap.ts:68,90,115` | 装载插件（`createEraflAdapterPlugin()`，排在清单首位） |
| `packages/app/src/monaco/languages.ts:120` | 注册 `kojo-xml` 语言面（口上 XML 的高亮/诊断） |
| `packages/app/src/monaco/kojo-xml-diagnostics.ts` | 口上 XML 诊断接线 |

---

## 4. v2 完全缺失（本交接的主战场）

### 4.1 `src/kojo2/` 目录不存在

```
$ ls packages/plugins/erafl-adapter/src/
chara-csv.ts  constants.ts  conventions.ts  family-index.ts  index.ts
instruction-table.ts  kojo-xml/  name-glossary.ts  plugin.ts  preview/
scaffold.ts  state-lines.ts  variable-schema.ts
```

没有 `index.ts` 里的 `ERAFL_GAME_ADAPTER`，没有 `freezeAdapter` 调用，没有任何 2.0 契约字段。

### 4.2 宿主把 2.0 adapter 写死成 eraTW（这是 bug，不是缺功能）

```ts
// packages/app/src/ui/editor-pane/use-monaco-instance.ts:280
ensureGlobalProviders({ kojo2Adapter: () => ERATW_GAME_ADAPTER });
```

同一个 getter 喂了**所有** adapter 驱动的 2.0 腿：

| 消费点 | 位置 |
| --- | --- |
| 补全 / 悬停（+ 转定义，B3b 后已移走） | `editor-global-providers.ts:1653` → `installKojo2LanguageProviders({ adapter })` |
| 签名帮助 | `editor-global-providers.ts:1702` → `installKojo2SignatureHelpProvider({ adapter })` |
| 行内提示 / 转定义 / 文档符号（B2c + B3b 之后由插件应答） | `editor-global-providers.ts:1445` → `registerKojo2AdapterSource(() => kojo2Adapter())` |

⇒ **改这一个 getter，六条腿同时换盘。** 这是本交接件里性价比最高的一件事（见 §5 入口 A）。

### 4.3 没有 `library-table`

eraTW 有 `packages/plugins/eratw-adapter/src/library-table.ts`（**600 行**，基础库函数中文别名表，
ADICT-1 批后基础库档覆盖 100%、合并覆盖 99.98%）。eraFL **一件都没有**：

```
$ grep -rn "LIBRARY_FUNCTIONS\|library" packages/plugins/erafl-adapter/src/
（零命中）
```

后果：eraFL 作者**不能用中文函数名写基础库调用**（`角色文本(她的名字)` 这种）。
这是「ERB 要提供最基本的编辑器体验」那条指令里**还没兑现的一块**。

### 4.4 没有 `KojoEmitBackend`

2.0 的编译落点（`packages/kojo-core/src/lower/backend.ts:438`）是：

```ts
export interface KojoEmitBackend {
  readonly id: string;
  readonly profile: KojoLoweringProfile;
  hintSupport(hint: string): HintSupport;
  readonly text: KojoTextEmitter;      // 叙事三正交
  readonly blank: KojoBlankEmitter;
  readonly control: KojoControlEmitter;
  readonly presentation: KojoPresentationEmitter;
  readonly weave: KojoWeaveEmitter;    // @织
  readonly program: KojoProgramEmitter;
  readonly wrapMachine?: (req: MachineWrapRequest) => EmitResult;  // # 机，有 # 机 时必须实现
}
```

eraFL 没有实现。⇒ **eraFL 工程的 `# 机` 一旦编译就会报 `core/feature/unsupported`**
（这是"不静默降级"的正确行为，但对 eraFL 用户就是"用不了"）。

### 4.5 没有 conformance 产物

`ERATW_CONFORMANCE_SUITE` 声明了 golden / differential / smoke / encoding 四面，
fixture 是**符号引用**（`kojo2/golden/message-com` 等）。eraFL 一份 fixture 都没有，
新 adapter 的 `conformanceSuite` 只能先声明 required 四面、fixture 后续批搭。

---

## 5. 五个入口（按依赖顺序；A 必须先做，且能独立交付）

### 入口 A —— 宿主接线：按 `project.adapterId` 选 2.0 adapter（前置，改动小，收益最大）

**现状**：写死 `ERATW_GAME_ADAPTER`。

**目标**：与 v1 完全同一条判据 —— v1 是这么选的：

```ts
// packages/plugin-api/src/game.ts:845
export function activeGameAdapter(contributions, adapterId) {
  if (!adapterId) return undefined;
  for (const c of contributions) if (c.adapter.gameId === adapterId) return c.adapter;
  return undefined;
}
```

**改法（两处，不要更多）：**

1. `use-monaco-instance.ts:280` 的 getter 改成按当前项目解析：

   ```ts
   ensureGlobalProviders({
     kojo2Adapter: () => {
       const id = kernel.project.current()?.adapterId;
       return id === null || id === undefined ? null : (KOJO2_ADAPTERS[id] ?? null);
     },
   });
   ```

2. 组合根建一张 `id → GameAdapter` 的表。表放在 `bootstrap.ts`（已经是宿主组合根、
   已经在 A 项审计里豁免），**不要**放在 `ui/` 里散着写 —— `packages/app/src/ui` 在
   `tools/audit-decoupling.mjs` 的 `NEUTRAL_DIRS` 里，写 `erafl` 字面量必须带
   `// audit-allow: <理由>`（现有两处就是这么写的，见 `use-monaco-instance.ts:102`、
   `kojo2-problem-wiring.ts:53`）。

**验收（必须做，不然改了也不知道对不对）**：

- 开 eraTW 工程 → 2.0 补全仍出 eraTW 的候选（回归不能掉）；
- 开 eraFL 工程 → 2.0 面拿到的是 eraFL 的事实（**在入口 B 做完之前，这里应该是"零候选 + 不崩"**，
  因为 eraFL 还没有 2.0 adapter；这一步的验收点是"**不再串到 eraTW**"）。

> 为什么这一步能先做：`kojo2Adapter` 返回 `null` 是**合法**的（`editor-global-providers.ts:359`
> 的类型就是 `() => Kojo2GameAdapter | null | undefined`），语义是"当前项目没有 2.0 adapter"，
> 各腿会零候选、不抛。**先把错误事实掐掉，再补正确事实** —— 顺序不能反。

### 入口 B —— eraFL 的最小 2.0 数据面（`src/kojo2/`）

照 eraTW 的 16 件**裁剪**，不是照抄。逐字段裁决表（**"照抄"一列是结论，不是建议**）：

| 契约字段 | eraFL 怎么办 | 依据 |
| --- | --- | --- |
| `id` / `version` | `'erafl'` / `'2.0.0'` | 与 `ERAFL.gameId` 一致 |
| `gameFingerprint` | 四段：engine / csv / erh / locale。**换盘或换汉化包 digest 必须变** | 契约 §10.4 |
| `eventCatalog` | ⚠️ **不能照抄**：九事件里只有 4 个是真定义，另五个被 eraFL 自己的流程函数取代（见 §2.4） | 真盘 `^@EVENT…` 精确匹配 |
| `domainSymbols` | ⚠️ **口径要重新想**：eraFL 的代词在 XML 里（`%CALLNAME:…%` / `[$MNAME]`），不在 ERB 表达式里。2.0 的 `{我}`/`{你}` 只对 ERB 壳函数有意义 | `preview/interpolate.ts` 的记号表 |
| `profile` | 可按 Emuera 缺省（取色/等待在 XML 属性里，不在 ERB 语句里） | 需真盘核 `SETCOLOR` 在壳函数里的出现率 |
| `presentation` | 大面积声明"不支持"：心形/着色/颜绘/选项都是 ERB 指令面，eraFL 的演出在 XML 属性（`kojoPlace`/`priority`/`emotion`） | `preview/conditions.ts` 的属性白名单 |
| `storageClasses` | 场景 / 存档 / 会话 —— 引擎能力，可用 | Emuera 通用 |
| `programFeatures` | 六项，需逐项核。`#DIMS` 已确认在用（scaffold 就产出它）；`FOR`/`WHILE` 待核 | 真盘 + scaffold |
| `foreachCollections` | `null`（无 `@巡` 语料）或只声明作者数组规则 | 无 2.0 语料 |
| `encodingPolicy` | **`defaultEncoding: 'utf-8-bom'`，`eol: 'crlf'`，`preserveBom: true`，`normalizeOnSave: false`** | §2.3 实测 `ef bb bf` |
| `layerPolicy` | `unique`（同层同名 = error），与 eraTW 同 | 无共享钩子语义 |
| `diagnosticNamespace` | 要与 v1 约定规则的命名空间对齐（现有码形如 `erafl.kojo-xml.unregistered`） | `conventions.ts` |
| `capability` | 纯数据 adapter：`executesCode: false` / `fileAccess: 'read-project'` / `networkAccess: 'none'` | 架构铁律 |
| `sourceMap` | `granularity: 'line'` | 契约 §10.7 |
| `conformanceSuite` | 先声明 required 四面，fixture 后续批搭 | §4.5 |

**建议文件切分（照 eraTW 的名字，按 eraFL 需要留）：**

```
src/kojo2/
├── index.ts            ERAFL_GAME_ADAPTER + ERAFL_GAME_FINGERPRINT
├── capabilities.ts     encoding / layer / diagnostic / capability / sourceMap / conformance
├── event-catalog.ts    6 条（或 9 条 + 3 条空声明，看口径）
├── domain-symbols.ts   从 name-glossary / interpolate 的记号表派生，不抄第二份词表
├── profile.ts          Emuera 缺省
├── presentation.ts     大部分 unsupported
├── storage.ts          三存储期
├── program.ts          六项开关
└── collections.ts      可先 null
```

**不建**：`backend.ts` / `*-emit.ts` / `profile-resolve.ts` / `table-data.ts` —— 那是入口 D 的事。

**红线**：`erafl-adapter` 的 `package.json` 要加 `"@kojo/kojo-core": "workspace:*"`
（eraTW 有，eraFL 现在没有）。eraTW 的 `kojo2/*.ts` 用的是相对路径
`import ... from '../../../../kojo-core/src/adapter.js'`；新代码建议直接用包名
`@kojo/kojo-core`（`vite.config.ts` / `vitest.config.ts` / `tsconfig` 三处 alias 都有）。
**别为了统一去改 eraTW 那 16 个 import** —— 那是无收益的噪声改动。

### 入口 C —— `library-table`（函数中文化）

eraFL 的 `instruction-table.ts` 解决的是「**引擎指令**中文词」，`library-table` 解决的是
「**游戏基础库函数**中文名」。两者消费方不同（前者进高亮/补全词表，后者进糖层降糖）。

**做法**：照 eraTW 的 `library-table.ts` 的**收录判据**，但语料换成 eraFL：

- **收**：eraFL 基础库（`ERB/` 根层的 `COMMON*.ERB` / `SYSTEM/` 下的公共定义）里 `@` 定义的
  高频助手函数；
- **不收**：① 引擎内建（`GETBIT` / `FIRSTTIME` / `CHK_*` …，那是跨游戏语言层，
  住 kojo-sugar 的 `SYSTEM_FUNCTION_ALIASES`）；② 作者私有 `@函数`（`KOJO_*_K{n}` / 项目内自定义名）。

**必须先做的普查**（否则就是拍脑袋）：

```bash
# 基础库档的函数定义（排除口上域与作者私有）
grep -rn "^@" D:/Game/erafl/ERB --include=*.ERB | grep -v "ERB/口上"
# 调用点频次（决定收录顺序）
```

**坑**：eraTW 的覆盖率闸在 `packages/plugins/eratw-adapter/tests/library-coverage.corpus.test.ts`。
eraFL 照它建闸时，**判据要写清是"基础库档覆盖"还是"合并覆盖"** —— 两者差 0.02% 但口径差很远。

### 入口 D —— `KojoEmitBackend`

eraFL 的 backend 有一半可以照 eraTW，另一半要重写：

- **可照**：`text` / `blank` / `control`（Emuera 通用）、`program`、`profile` 的合成方式；
- **要重写**：`wrapMachine`（`# 机` 包装）—— eraFL **没有引擎事件函数**（§2.4），
  eraTW 那套「落 `@EVENTxxx` + `#PRI/#LATER/#ONLY`」直接不成立。
  eraFL 的壳有固定形态（`#DIMS CONST XML_PATH_COM` + `CALL KOJO_XML_REGISTER(...)`），
  `# 机` 要落成什么形状得**从真盘流程函数反推**，不能套 eraTW；
- **可先不实现**：`presentation`（eraFL 的演出在 XML 里）、`weave`（`@织`）。

**注意 `wrapMachine` 是可选的，但一旦作者写了 `# 机` 就必须有**，否则 compile 报
`core/feature/unsupported`（见 `backend.ts:456` 的注释）。这是"fail-visible"的正确行为，
不要为了"不报错"而返回空产物。

### 入口 E —— XML 侧的 2.0 化（eraFL 独有，**没有先例**）

这是本交接件里**唯一需要做设计决策**的一块，也是最有价值的一块。

**现状**：`kojo-xml` 已经是独立语言面（`languages.ts:120`），有解析器、索引、服务、条件抽取、
记号替换、面板（`@kojo/plugin-ui-kojo-xml`，877 行）。但它是**v1 形态**：宿主给面板喂
`KojoXmlService`，面板自己渲染。

**问题**：eraFL 作者 90% 的时间在 XML 里，而 2.0 的所有能力（补全/悬停/跳转/诊断/重构）
目前只服务 `kojo2` 语言 id。⇒ **eraFL 作者享受不到 2.0 的任何收益。**

**方向（建议，不是定论）**：

1. **先量**：把 `KojoXmlService` 已有的能力（索引/条件/记号）与 2.0 语言面的能力逐项对齐，
   看哪些**只差一层接线**（比如"XML 里的 `%CALLNAME:K%` 跳转到角色 CSV"其实 `charaIndex` 已有）。
2. **再决定**：是给 `kojo-xml` 语言 id 挂 Monaco provider（走 `slotServices` 那套点名机制，
   见 `HANDOFF-kojo2-sdk-packages.md` §3.1），还是把 XML 也编译成 kojo2 的一种视图。
   **前者便宜、后者正确**；在没量之前不要选。
3. **绝对不要**把 XML 的语义硬塞进 `@kojo/plugin-kojo-lang`（那是语言面库，
   它的 `purity.test.ts` 白名单里没有、也不该有 XML 相关依赖）。

---

## 6. 三个必须先搞懂的机制

### 6.1 两枚 `GameAdapter` 不是一回事

| | v1 `GameAdapter` | 2.0 `GameAdapter` |
| --- | --- | --- |
| 住哪 | `@kojo/plugin-api`（`game.ts`） | `@kojo/kojo-core`（`adapter.ts:40`） |
| 怎么到消费方 | **槽** `game.adapter`（`ctx.slots.register`） | **宿主组合根注入的 getter**（没有槽、没有服务键） |
| 关键字段 | `gameId` / `displayName` / `functionFamilyIndex` / `conventions` / `variableSchema` / `kojoInstructionTable` / `nameGlossary` / `stateLinePresets` / `detect` / `loadProject` | `id` / `version` / `gameFingerprint` / `eventCatalog` / `domainSymbols` / `profile` / `presentation` / `storageClasses` / `programFeatures` / `foreachCollections` / `encodingPolicy` / `layerPolicy` / `diagnosticNamespace` / `capability` / `sourceMap` / `conformanceSuite` |
| 形状 | 带方法、带 getter（`get variableSchema()`） | **纯数据、零 IO、深冻结**（`freezeAdapter`） |

**混用是编译错误，不会静默。** eraFL 的 `plugin.ts:196` 那枚是 **v1**；
`ERAFL_GAME_ADAPTER`（待建）是 **2.0**。两者**必须同时存在**，不是替换关系。

> `ctx.slots.register('game.adapter', …)` 这条**只喂 v1 消费方**。
> 2.0 的 adapter 从来不进槽 —— 这就是为什么 `plugin.ts` 里注册了 adapter 却对 2.0 面毫无影响。

### 6.2 2.0 语言面的两条取数缝

插件（`@kojo/plugin-kojo-lang`）**不能 import 宿主**，所以 adapter 事实走两张**模块级登记表**：

| 缝 | 谁登记 | 谁读 | 现状 |
| --- | --- | --- | --- |
| `@kojo/kojo-lang/adapter-source` | `editor-global-providers.ts:1445`（一处） | 插件各腿（inlay / definition / symbols） | ✅ 已接，但喂的是 eraTW |
| `@kojo/kojo-lang/expand-compile` | `packages/app/src/ui/kojo2-expand-compile.ts`（现只剩 re-export） | 展开视图 | ✅ 已接 |

两条缝的五条口径（零登记零行为 / 请求时现取 / getter 抛错 = 这一轮没有 / 后登记优先 / 注销只撤自己）
写在 `packages/kojo-lang/src/adapter-source.ts` 的头注里。**入口 A 改的就是这条缝上游的 getter。**

### 6.3 `activeGameAdapter` 的判据是 `gameId === adapterId`

`project.adapterId` 存的是 **v1 的 `gameId`**（`'erafl'` / `'eratw'` / `'erakuma…'`），
不是 2.0 的 `id`。所以入口 A 的表**键必须用 v1 的 `gameId`**，值才是 2.0 的 adapter 对象。
写错的话表现是"打开项目后 2.0 面全部零候选"，而且**不报错**。

---

## 7. 红线（违反会被门禁抓，或者更糟——抓不住但会烂）

1. **游戏名词只准住 adapter 包。** `tools/audit-decoupling.mjs` 的 A 项管内核/契约/Rust，
   **D 项管通用插件**。`packages/app/src/ui`、`packages/app/src/monaco`、`bootstrap.ts`
   都在 `NEUTRAL_DIRS` 里 ⇒ 里面出现 `erafl` / `eratw` / `個人口上` 必须带
   `// audit-allow: <理由>`，且**理由要写清为什么非此处不可**。
2. **不许在通用插件里判断"是不是 eraFL"**。要区分游戏就查 adapter 的契约字段。
3. **编码不许归一化。** `preserveBom: true` + `normalizeOnSave: false` 是契约要求：
   作者用别的编辑器改一行，本编辑器不许整文件重排。
4. **`fail-visible`，不许静默降级。** 拿不到 adapter / 缺 backend / 未知事件 —— 一律报诊断，
   不许"返回空产物让它过"。
5. **游戏事实必须有真盘读数。** 每个新文件头注都要写清"这条规则从哪条引擎事实推出 / 命中数多少"
   （照 `conventions.ts` / `instruction-table.ts` 的写法）。**"照抄 eraTW"不是依据。**
6. **测试里的真盘用例要 `skipIf` 守卫**（`D:/Game/erafl` 不存在时跳过），合成用例必须独立成立。

---

## 8. 校验命令与基线读数

```bash
# 双 typecheck（两个都要过）
pnpm -w exec tsc -p tsconfig.json --noEmit          # ROOT=0
pnpm -w exec tsc -p packages/app/tsconfig.json --noEmit  # APP=0

# 解耦审计（A–D 四项）
pnpm audit:decoupling

# 全量单测（本机 7–9 分钟，建议后台跑；这是**唯一**可信的跑法）
pnpm test:unit
```

> **别用位置参数过滤单包**（`vitest run <目录>`）—— 本机会整体报 `reading 'config'`，
> 见下方"两个已知的假红"。

**基线读数（2026-10-24，本交接件写作时实测）：**

| 项 | 读数 |
| --- | --- |
| eraFL adapter src | **19 文件 / 3,958 行** |
| eraFL adapter 测试 | **13 文件 / 约 189 项** |
| eraTW `src/kojo2/` | 16 文件 / 2,666 行（模板） |
| eraTW `library-table.ts` | 600 行（eraFL 为 0） |
| 全量 `pnpm test:unit` | **837 文件 / 16,731 项**（16,667 过 + 64 skip），EXIT=0 |
| 双 typecheck | ROOT=0 / APP=0 |
| 解耦审计插件数 | 23 个（A–D 全过） |
| 宿主残留 `monaco/kojo2-*.ts` | 25 文件 / 15,305 行（包化 B5 的目标是归零） |
| 宿主残留 `ui/kojo2-*` | 25 文件 / 13,195 行 |

**两个已知的"假红"（都不是代码问题，别去改代码）：**

1. **用位置参数过滤单包跑**（`npx vitest run <某个目录>`）会整体炸：
   每个用例文件都在 `describe(` 处报 `TypeError: Cannot read properties of undefined (reading 'config')`，
   报 `0 test`。eraTW 的同名测试同样复现 ⇒ 是 vitest 4 在本机的过滤路径问题，
   与 eraFL、与任何代码都无关。**改用全量 `pnpm test:unit`。**
2. **满载并行时会超时假红。** 同一份代码连跑两次：一次 3 红
   （`kojo-conformance/tests/corpus.test.ts` 的 corpus CLI 被 SIGTERM、
   `app/tests/kojo2-format.test.ts` 20s 超时、另 1 项未取证），
   另一次 **全绿 16,667 项**。判据：单独看那几条时机器是否同时在跑别的重活。
   遇到就重跑，别改代码。

---

## 9. 踩过的坑（每条都是真花过时间的）

1. **别把 v1 的 adapter 对象塞给 2.0。** 字段名不同（`gameId` vs `id`），
   `TS` 会拦住；但如果用 `as any` 绕过去，运行期表现是"每条腿都零候选"，极难查。
2. **`ctx.slots.register('game.adapter', …)` 不会让 2.0 面生效。** 这是本交接件 §4.2 的根因，
   第一眼看上去"注册了就该能用"，其实 2.0 根本不走槽。
3. **`game.adapter` 服务键是死的**：全仓没有插件 `provide` 它，插件 `ctx.tryInject('game.adapter')`
   拿到的是 `undefined`。插件要 adapter 事实只能走登记表（§6.2）。
4. **CFLAG 是二维的。** `CFLAG:{角色}:{索引}`，同一个语义在不同函数里三种拼写 = 三条依赖键。
   状态线少列一种，那条线在那些函数里就不亮（`state-lines.ts` 头注）。
5. **XML 属性已经解过实体。** `KojoXmlCommand.attrs` 的约定是"值已解实体"，
   `preview/conditions.ts` 里再 `decode` 一次会把 `&amp;quot;` 错变成 `"`。
6. **口上 XML 必须成对注册。** 只给 XML 不给 define 壳 = 引擎永远不加载（`scaffold.ts` 头注）。
7. **`ERB/口上` 的散文件不是工程。** `detect` 要求它是**目录**（`io.stat().isDirectory`），
   否则半截工程会被误判成 eraFL。
8. **孤儿 XML 的误报代价很高。** 宁可漏报也不能把一整个批量注册目录（`KOJO_XML_REGISTER_FROM_SPLIT_FILES`）
   报成孤儿 —— 误报会让作者去删真正在用的口上。
9. **`@函数名` 不是指令。** `@名字` 本身就是游戏侧定义，所以 `instruction-table` 的 `@` 面进表 0。
   把 `@` 面当指令收进去会让词表爆炸且全是噪声。
10. **文件名大小写混用是常态。** `CFLAG.CSV` / `Talent.csv` / `chara25_リナ.csv` 同时存在
    ⇒ 建表一律按文件名去扩展名后**大写**，正则一律 `i`。
11. **别在测试里写死真盘路径当唯一依据。** 真盘用例 `skipIf`，合成用例必须能独立跑通。
12. **`@EVENTTRAIN_xxx` / `@EVENTEND_xxx` 不是引擎事件。** eraFL 树里几十个这种作者助手函数，
    按前缀匹配会把它们全收进"事件目录"。判据必须是 `^@EVENT(名字)\b` 的**精确**匹配，
    而且要人眼过一遍 —— 我第一次就是按前缀扫的，结论错了（见 §2.4）。
13. **eraFL 的流程函数前缀是 `FL_` / `QST_`。** `@FL_EVENTTURNEND`（回合末）、`@QST_EVENTCOMEND`
    （任务指令结束）—— 引擎事件在 eraFL 是被**包了一层**的，别拿 eraTW 的分发模型套。

---

## 10. 文件地图

**本包（要改的地方）：**

| 路径 | 状态 |
| --- | --- |
| `packages/plugins/erafl-adapter/src/plugin.ts:196` | v1 adapter 对象（**不动**，2.0 是并列新增） |
| `packages/plugins/erafl-adapter/src/plugin.ts:384` | `slots.register('game.adapter', …)`（不动） |
| `packages/plugins/erafl-adapter/src/index.ts` | 要加 `export * from './kojo2/index'` |
| `packages/plugins/erafl-adapter/package.json` | 要加 `@kojo/kojo-core` 依赖 |
| `packages/plugins/erafl-adapter/src/kojo2/` | **待建**（入口 B） |
| `packages/plugins/erafl-adapter/src/library-table.ts` | **待建**（入口 C） |
| `packages/plugins/erafl-adapter/src/kojo2/backend.ts` | **待建**（入口 D） |

**宿主（要改的地方）：**

| 路径 | 干什么 |
| --- | --- |
| `packages/app/src/ui/editor-pane/use-monaco-instance.ts:280` | 写死 eraTW 的 getter（**入口 A 的主战场**） |
| `packages/app/src/bootstrap.ts` | 插件装载清单 + 组合根（`id → 2.0 adapter` 表放这） |
| `packages/app/src/ui/editor-global-providers.ts:359,1433,1445,1653,1702` | getter 的类型与全部消费点 |
| `packages/app/src/ui/kojo2-problem-wiring.ts:53,136` | 诊断接线（也写死了 eraTW backend） |

**模板（照它裁，别照抄）：**

| 路径 | 内容 |
| --- | --- |
| `packages/plugins/eratw-adapter/src/kojo2/index.ts` | `freezeAdapter({…})` 总装 + 全部 re-export |
| `packages/plugins/eratw-adapter/src/kojo2/capabilities.ts` | 非功能性面（**eraFL 的 encoding 完全不同**） |
| `packages/plugins/eratw-adapter/src/library-table.ts` | 基础库中文别名表（600 行，判据在头注） |
| `packages/kojo-core/src/adapter.ts:40` | 2.0 契约总表（字段顺序 = 设计稿 §10.1） |
| `packages/kojo-core/src/lower/backend.ts:438` | `KojoEmitBackend` 形状 |
| `docs/KOJO-2.0-LANGUAGE-SPEC.md` | 设计稿（§10 是 adapter 契约，附录 B 是 eraTW 的具体取值） |
| `docs/PLAN-eraAkumaMaid-adapter.md` | 另一个 adapter 的落地计划（结构可参考） |

---

## 11. 接手后第一件事

**不要先写 `src/kojo2/`。先做入口 A，跑一遍，确认打开 eraFL 工程时 2.0 面不再吐 eraTW 的候选。**

理由：入口 A 是**唯一一个"做完就能验证对不对"**的改动（改前/改后的 2.0 补全候选不同），
而且它是入口 B 的**验收前提** —— 没有它，你写完 eraFL 的 adapter 也不知道有没有生效
（会以为生效了，其实宿主还在喂 eraTW）。

顺序：

1. 入口 A + 验收（半天内可完成）；
2. 入口 B 的最小面（先只做 `encodingPolicy` / `capability` / `layerPolicy` / `sourceMap` 这些
   **纯声明、零争议**的字段，让 adapter 能 `freezeAdapter` 通过、能被 getter 拿到）；
3. 再逐个字段补（`eventCatalog` 要先解决 §2.4 的口径问题）；
4. 然后才是 C / D / E。

**每次提交前跑 §8 的四条命令。**
