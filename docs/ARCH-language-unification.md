# 语言面统一架构（LAU）· 设计方案与契约

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0（设计稿，未实现；实现按 §6 批次推进） |
| 日期 | 2026-10-25 |
| 状态 | 设计稿。用户 2026-10-25 已拍板：§6.1 采用方案 A（`.kojo` 让给 2.0）、断言关键字定为 `# 方言` ⇒ 可开 LAU-1 / LAU-D1 |
| 范围 | ① ERB / kojo v1（封存）/ kojo2 三条并行结构栈收成一套：**一份协议、一份角色表、一个槽位契约**；② 多 era 适配收进**方言层**（§5），语法不分叉 |
| 前置 | `KOJO-2.0-LANGUAGE-SPEC.md` §0.2（单一模式）/ §5.3 / §12.1（旧拼写 error+迁移）/ §10（adapter 契约）；`HANDOFF-kojo2-sdk-packages.md` B0–B5；`HANDOFF-erafl-adapter.md`（多 era 事实） |
| 不做 | 不改 2.0 语法；不动 `EDITOR_SEMANTIC_TOKEN_TYPES`；不新增 workspace 包；**不为任何 era 分叉语法** |

---

## 0. 一句话

**宿主不该认识任何一门具体语言。** 它只做三件事：按路径选 descriptor、把协议消息搬运、把捕获翻成 Monaco 区间。
今天这三件事里混进了语言知识（两套协议、四套 token 名、一处 `if (languageId === ERB_LANGUAGE_ID)`），
LAU 就是把它们逐条剥出去。

判据只有一条，后面每一节都可以拿它复核：

> **新增一门语言，宿主目录下应当零改动**（`packages/app/src/monaco/` 一个字不改，只加一个 descriptor 与一个插件包）。
> 今天做不到；LAU 做完之后，封存层（§6）就是第一个验证者。

同理，多 era 适配的判据也只有一条：

> **新增一个 era，宿主与语法零改动**，只加一个方言包（数据）。今天的反例很具体——
> 宿主把 2.0 的 adapter 写死成 eraTW，于是打开 eraFL 工程拿到的是 eraTW 的九事件与代词落点（§5.1）。

---

## 1. 现状：不是"乱"，是三条各自正确的路并行

| 层 | ERB | kojo v1 | kojo2 |
|---|---|---|---|
| 词法（Monarch） | `erb-language.ts`（6 个 token 名） | `kojo-language.ts`（`KOJO_TOKEN_TIERS`，`sugar.*` / `keyword.erb*`） | `kojo2-language.ts`（`KOJO2_TOKEN.*`，`kojo2.*`） |
| 名字层（语义） | 插件槽 `ui.editor.languageService`，legend = 契约 3 值 | 同左（`kojo-semantic-tokens.ts`） | **无**（未声明 `languageServices`） |
| 结构层 | `StructureClient` + `erb-ts.worker`（`types.ts` 协议 v2） | 同一条路（`kojo-ts.worker`） | `Kojo2WorkerClient` + `kojo2-ts.worker`（`kojo2-worker-protocol.ts`） |
| 捕获→颜色 | `ERB_SEMANTIC_CAPTURE_TIERS`（9 支） | `KOJO_STRUCTURE_CAPTURE_TIERS` + 节点级表 | `KOJO2_CAPTURE_TOKEN_TYPES` |
| 主题 | 并进 `kojo-dark/light/mint-dark` | 同左 | 并进同一批 + 三套独立 `kojo2-*` |
| 文法 wasm | 0.98 MB | 0.78 MB | 0.04 MB |

四条具体代价（都是可验证的事实，不是感觉）：

1. **加一档颜色要改三处**：捕获表 + 主题规则 + legend 校验，漏一处就是"这枚捕获悄悄没色"。
2. **两套超时策略**：v1 4s 单档（超时即整档判死），kojo2 8s 引导 / 2s 稳态。ERB 首帧慢的根因就是前者。
3. **两套失败词表**：v1 由 worker 决定 `capability`（谁该降级），kojo2 由 worker 报 `reason`（发生了什么）。职责放错了地方。
4. **首帧往返次数差 4 倍**：kojo2 开一份文件 = `parse` + `captures` + `folds` + `indents` 四条请求，**每条都带全文**；v1 是一条 `parse` 推四条回复。

`kojo2-*.ts` 目前 **25 个文件 / 31,599 行**，全部住在宿主。B0–B5 已计划把它们搬进插件包，LAU 沿着这条既有路线走，不另起炉灶。

---

## 2. 决策表（本方案的全部主张，逐条可反对）

| # | 决策 | 替代方案与否决理由 |
|---|---|---|
| **D1** | **协议只有一份**，`structure-protocol.ts`，`id` 配对 + 带版本协商 | 保留两套：任何跨语言能力（折叠统一、诊断统一）都要写两遍 |
| **D2** | **worker 报事实（`reason`），宿主定代价（`capability`）** | v1 让 worker 决定降级面：worker 要懂"宿主有几面"，职责倒挂 |
| **D3** | **一条请求一条回复**：`parse` 带回全部面 | kojo2 的四条请求各带全文；Monaco 开文件时本来就同时要四面，"按需拉"没有真实场景 |
| **D4** | **捕获以扁平数组过线**（`number[]` + 字符串字典），档位翻译留在主线程 | 传对象数组：5 万捕获 ≈ 3 MB JSON，且主线程要重建对象 |
| **D5** | **颜色只有一份**：`role.*` 角色表；Monarch 与结构层都发角色名 | 保留四套名字 + 别名永久化：等于没统一，只是加了一层 |
| **D6** | **名字层（`function/variable/parameter`）与语法角色正交，不合并** | 合并成 20 值 legend：插件作者写不动，Monaco"先注册者胜"更难推理 |
| **D7** | **封存层是另一门语言**（`availability: 'legacy'`），不是版本开关 | 在 2.0 编译器里留旧分支：违反 spec §0.2「单一模式、无版本声明」 |
| **D8** | **降级是账本，不是开关**：连续 3 次失败才判死一面 | 今天一次超时永久 `dead`：慢一次 = 这一门语言的结构层整档消失 |
| **D9** | **适配的单元是方言（dialect），不是语言**：语法 / 载体 / 方言三条轴正交 | 每来一个 era 就"再适配一遍语言"：语法层被游戏事实污染，N 个 era = N 份分支 |
| **D10** | **方言不进 wasm、不进 worker、不改语法**：只进"事实类"服务（补全 / 悬停 / 诊断 / 符号 / 跳转） | 让方言影响 tree-sitter 查询：每个 era 一份文法或一份查询，回归面乘 N |
| **D11** | **方言的唯一真源是工程清单**（`kojo.project.json`）；文件里的 `# 方言` 只是**断言**，不一致即 error | 让文件自己声明方言：同一工程里两份真源，必然漂移 |
| **D12** | **未绑定方言 = 明确降级，绝不回落到某个默认方言** | 今天回落到 eraTW：错误事实不报错，只给"看起来对、其实属于另一个游戏"的提示 |
| **D14** | **`@原生` 体内注入子语言**：descriptor 声明 `injections`，宿主按声明转发（`includedRanges`，坐标天然对齐） | 文法内嵌 ERB：kojo2 文法从 40KB 涨到 MB 级，且 kojo1 退役期两边一起改 |

---

## 3. 目标架构

```
┌─ L3 宿主 packages/app ──────────────────────────────────────────────┐
│  language-registry   选语言（按 availability 门控）                  │
│  structure-overlay   建线程 / 搬运消息 / 把捕获翻成 Monaco 区间       │
│  theme               把角色表铺成 IThemeRule[]（零色值，只引用）      │
│  dialect-resolver    从工程清单解析方言，随请求下传（零事实、零默认） │
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
- **R2 一门语言 = 一枚 descriptor**：加语言不改 model 池、EditorPane、provider 接线（今天已基本做到，LAU 补完 `syntaxPresenter` 与 `availability` 两个缺口）。
- **R3 协议一份、带版本、失败即数据**：worker 永不 reject，也永不"半吊子继续答"。
- **R4 颜色一份**：屏幕上有几档由角色表说，色值由主题规则说，两者一一对应且在模块加载期对账。
- **R5 降级一份台账**：`fallback.ts` 是唯一出口，每种 `reason` 有且只有一句人话。
- **R6 方言只进事实面**：语法 / 载体 / 方言三轴正交；方言不进 wasm、不进 worker、不改查询。

---

# 第二部分 契约接口方案

> 下列签名是**目标形状**，落在 `packages/plugin-api/src/`（不新增包，遵循 spec §12.3「不先改名现有包」）。
> 现有 `KojoStructure*` 类型在 LAU-1 期间保留为**类型别名**，LAU-1 收尾时删除。

## 4.1 协议 `structure-protocol.ts`

```ts
/** 协议版本：形状一变就抬号；`open` 那一步比对，不符即拒（不拿旧形状硬解） */
export const STRUCTURE_PROTOCOL_VERSION = 3;

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

export interface StructureParseRequest {
  readonly id: number;
  readonly kind: 'parse';
  /** 文档身份（跨文档隔离；换轨后旧回复据此丢弃） */
  readonly doc: number;
  /** 内容版本（同文档内判陈旧） */
  readonly version: number;
  readonly text: string;
  /** 增量基准：上一次回复交出的树；缺省 / 不认识 ⇒ 整篇重解 */
  readonly baseTreeId?: string;
  /** 只要这几面（缺省 = 全部）。大文件门控用，不改变"一条请求一条回复" */
  readonly want?: readonly StructureFacet[];
}

export type StructureRequest = StructureOpenRequest | StructureParseRequest;

/* ------------------------------ → 主线程 ------------------------------ */

export interface StructureReadyReply {
  readonly ok: true;
  readonly id: number;
  readonly kind: 'ready';
  readonly protocol: number;
  /** 引导期读数：`Parser.init` + `Language.load` + 查询编译 */
  readonly loadMs: number;
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
多等两秒只让作者晚看到颜色，错判一次却让整面消失到换文档为止。

**与两套旧协议的映射**（LAU-1 的迁移表，逐条对拍用）

| 旧 | 新 | 说明 |
|---|---|---|
| v1 `init{protocol,wasmUrl,runtimeWasmUrl}` | `open{protocol,languageId,runtimeWasmUrl,grammarWasmUrl}` | 字段名统一为 `grammarWasmUrl` |
| v1 `parse{doc,version,text}` | `parse{doc,version,text}` | 同形 |
| v1 `change{doc,version,start,oldEnd,newEnd,newText}` | `parse{...,text}`（增量由 `baseTreeId` 决定） | **取消 `change`**：主线程已留快照，整篇交出去由 worker 增量；少一条消息类型、少一处缝合口径漂移 |
| v1 四条推送 `semantic/folds/indent/syntax` | 一条 `parse.facets` | D3 |
| v1 `error{stage,capability,message}` | `ok:false{reason,message}` | D2：代价由宿主定 |
| kojo2 `captures/folds/indents` 三条查询 | 并入 `parse.facets` | D3 |
| kojo2 `oldTreeId` | `baseTreeId` | 改名统一 |
| kojo2 无版本协商 | `open.protocol` | 补上，否则两侧版本漂移只能靠形状闸兜 |

> **取消 `change` 的代价**：每版都传全文。实测口径：传整串时 web-tree-sitter 内部取字符会
> `text.slice(index)` 复制文档尾巴，p95 抬到 30ms 级——所以**增量必须靠 `baseTreeId`**，
> 而不是靠"少传文本"。文本传输本身在结构化克隆里是零拷贝转移，不是瓶颈。

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

三条硬约束（由测试钉住）：

1. **每个 `SEMANTIC_ROLES` 成员在每套主题里必须有且只有一条规则**，缺一条在模块加载期抛（沿用 `buildTokenMap` 的既有纪律）；
2. **任意两档 ΔE ≥ 12、对底色对比度 ≥ 4.5**（沿用 `kojo2-theme.test.ts` 的现有指标，换成角色表跑）；
3. **`LEGACY_ROLE_ALIASES` 的每个值都必须是 `SEMANTIC_ROLES` 成员**，且别名表只允许出现在一个文件里（`grep` 断言）。

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
   * 结构残缺的上屏方式。**补掉 `providers.ts` 里那处 `if (languageId === ERB_LANGUAGE_ID)`**：
   * 宿主不再知道"哪门语言用哪套文案"，只调用运行时给的这一枚。
   */
  readonly presentSyntax?: (faults: readonly StructureSyntaxFault[], truncated: boolean) => void;
  readonly clearSyntax?: () => void;
}
```

## 4.4 门控 `language-availability.ts`

```ts
/** 由设置页注入（纯谓词，注册表不读设置、不订阅） */
export type AvailabilityGate = (descriptor: LanguageDescriptor) => boolean;

export function installAvailabilityGate(gate: AvailabilityGate): void;
export function isAvailable(descriptor: LanguageDescriptor): boolean;   // 缺省 = 全部可用
```

- `descriptorForPath` / `languageIdForPath` / 选择器列表统一走 `isAvailable`；
- 门关着 ⇒ 认不出 ⇒ `plaintext` 兜底（与今天认不出的文件完全同一条路，不会半死不活）；
- 门开 / 关**不重注册**，只影响下一次认领。

## 4.5 槽位契约（不变）

`ui.editor.languageService` 保持"单槽 + `kind` 判别 + `EditorDocumentIdentity`"的形状，`EDITOR_SEMANTIC_TOKEN_TYPES` 三值不动。
ERB 与 kojo2 的差别只在**供方住在哪**：LAU-4 把 ERB 的 11 枚 provider 从宿主搬成插件供方，
届时两门语言用同一条槽、同一份契约，宿主只剩"注册一次 provider"。

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
  /** 主树里触发注入的节点名，如 'native_block' */
  readonly hostNode: string;
  /** 子语言 id，如 'erb' */
  readonly languageId: string;
  /** 取哪个子节点作为注入体；缺省取整个 hostNode */
  readonly bodyPath?: string;
}
// LanguageDescriptor 新增：
readonly injections?: readonly InjectionSpec[];
```

2. 主树返回后，宿主按 `injections` 找到 `native_block`，取其 body 的**绝对区间**，
   向 `erb` 的 runtime 发一次 parse（带 `includedRanges`）。
3. 子树 tokens 在区间内**覆盖**主树的 `role.raw`；区间外一个字节都不动。

**为什么不用"截取子串再 parse"**：那要手工加 offset，且换行与 UTF-16 折算会出错。`includedRanges`
用的是同一份文本的绝对偏移，返回的 tree 坐标就是主文档坐标——这是选它的全部理由。

**协议改动（additive，不改形状）**：

- `StructureRequest` 加 `includedRanges?: StructureRange[]`（缺省 = 全文档）。
  `StructureRange` 直接对齐 web-tree-sitter 的 `Range`：`{ startIndex, endIndex, startPosition, endPosition }`
  ——**索引与行列都要给**，只给行列会让 worker 再做一次全文扫描。
- 结果不变：`tokens` 一律绝对坐标，宿主不需要知道"这是子树的"。
- 降级：子树失败 ⇒ 保留主树的 `role.raw`，报 `injection/child-failed`，**主树四面照常**。

**成本与边界**：

| 项 | 读数 / 口径 |
|---|---|
| ERB wasm（1.03MB） | **只在文件真出现 `@原生` 时懒加载**（`injections` 非空 + 主树命中 `native_block`），无 `@原生` 的文件零请求 |
| 额外 parse | 只解析 body 区间（通常几十行），比主树小一个量级 |
| 合并 | 区间覆盖，O(tokens)；子树优先，主树 `role.raw` 兜底 |
| 只影响编辑器面 | 着色 / 折叠 / 缩进 / 残缺。**编译产物仍按 §8.5 去缩进，injection 不参与 codegen** |
| 缩进 | `@原生` 体内的前导空白被 ERB 文法的 extras 吃掉，行节点照常匹配，不需要先去缩进 |
| `[SKIPSTART]` | ERB 文法内部已有 `skip_block`（external scanner 一次吞掉），嵌套在 `@原生` 里同样生效 |
| 不做递归注入 | `@原生` 里不再出现 kojo——逃生舱里不该有逃生舱 |

**验收**（LAU-6 的 DoD）：

1. 含 `@原生` 的文件：体内 `;` 注释有 `role.comment`、`#DIM` 有 `role.directive`、`IF/ENDIF` 可折叠、`@函数` 可跳转。
2. 删掉 `@原生` 后 ERB wasm 不再被请求（网络面板断言）。
3. 子树 parse 失败时，主树四面全绿 + 一条 `injection/child-failed`，不整档停用。
4. `grep -rn "native_block" packages/app/src/monaco/*.ts` 只命中 descriptor，宿主无节点名硬编码。

---

# 第三部分 多 era 方言层（DIALECT）

## 5. 根因：适配的单元选成了「语言」

三个来自 `HANDOFF-erafl-adapter.md` 的实测事实，一个都不是"还没做"，而是"做错了"：

1. **宿主把 2.0 的 adapter 写死成 eraTW**（`packages/app/src/ui/editor-pane/use-monaco-instance.ts:280`）。
   打开一个 eraFL 工程，补全 / 悬停 / 签名 / 行内提示 / 转定义 / 大纲拿到的是 **eraTW 的九事件、
   eraTW 的代词落点、eraTW 的 `@巡` 集合**。错误的事实**不报错**，只给出"看起来对、其实属于
   另一个游戏"的提示——比"没做"危险。
2. **eraFL 的口上主战场是 XML**（`<command com="300" name="会話" kojoPlace="TOP">`），ERB 侧只剩
   一个注册壳。于是 2.0 的 `# 机` / `@织` / `# 表` / `# 池` / `选项` 在作者真正写东西的地方
   **没有落点**；照抄 eraTW 那 16 件，作者打开口上 XML 会发现"什么也没变"。
3. **事件架构有四种**：eraTW-family 唯一函数 / eraSQN 共享 `EVENTTRAIN` / eraFL `RESULTS` 元数据 /
   eraKoumakan `KOJO_MESSAGE_*` / eraNTR 无口上层。这是**同一个概念的不同落点**，不是四种语法。

一句话：**每来一个 era 就"再适配一遍语言"，是因为把适配单元选成了语言。**
语言只有一门；该被适配的是**方言**。

### 5.1 三条正交轴（本节地基）

| 轴 | 决定什么 | 谁提供 | 变了改什么 | 变多贵 |
|---|---|---|---|---|
| **语法** | 这串字符是不是合法 kojo2 | 语言包（grammar + queries + Monarch） | 改语言（罕见，且只增不改） | 高（回归面全仓） |
| **载体** | 这段文字写在哪（ERB 内联 / XML / 将来的别的） | descriptor（每载体一枚，已有 `languages.ts`） | 加一枚 descriptor | 低 |
| **方言** | 这些名字 / 事件 / 演出在这个游戏里是什么意思 | 方言包（adapter，纯数据） | 加一个方言包 | **零**（不动宿主、不动语法） |

**关键推论（D10）：方言不进 wasm、不进 worker、不改语法。**
着色 / 折叠 / 缩进 / 残缺只认语法，与方言完全正交；方言只影响"事实类"服务（补全、悬停、签名、
诊断、符号、跳转）。所以"适配 N 个 era"永远是**加数据**，不是加分支、不是分叉语言——
这就是"根源性解决"的全部含义。反过来，一旦让方言影响 tree-sitter 查询，N 个 era 就有 N 份
查询与 N 倍回归面，那是把问题从"配置"升级成"代码"。

### 5.2 契约 `dialect.ts`

```ts
export type DialectId = string; // 'eratw' | 'erafl' | …

/** 工程清单：方言的**唯一真源**（工程根 `kojo.project.json`） */
export interface DialectManifest {
  readonly dialect: DialectId;
  readonly adapterVersion: string;
  /** 换盘 / 换汉化检测（变量表、位表错位） */
  readonly gameFingerprint?: string;
  /** 工程级覆盖（文件级覆盖住在文件里，见 §5.3） */
  readonly profile?: Partial<DialectProfile>;
  readonly carriers?: readonly CarrierBinding[];
}

/**
 * 载体绑定：**eraFL 的 XML 就是靠它进语言面**。
 * 宿主只用它做"这个文件属于哪个载体"的归属，不解释内容。
 */
export interface CarrierBinding {
  readonly carrier: 'erb' | 'xml' | 'inline';
  /** 相对工程根的 glob */
  readonly glob: string;
  /** 该载体上哪些面由方言校验（缺省 = 全部事实类） */
  readonly validates?: readonly DialectFactKind[];
}

export type DialectFactKind = 'event' | 'symbol' | 'presentation' | 'storage';

export interface DialectProfile {
  readonly narrationColor: 'author' | 'default' | 'auto';
  readonly dialogueColor: 'author' | 'default';
  /** **没有全局默认**：缺 profile 必须报错，不许静默选（spec §10.2） */
  readonly waitDefault: 'wait' | 'continue';
  readonly colorMode: 'D' | 'plain';
  readonly poolStyle: 'if' | 'selectcase';
  readonly randStyle: 'printdata' | 'printdatal' | 'rand-selectcase';
  readonly presentation: readonly ('heart' | 'color' | 'face' | 'choice')[];
  readonly programFeatures: readonly ('arrays' | 'while' | 'goto' | 'recursion' | 'foreach' | 'repeat')[];
}

/** 方言的**事实目录**：语言服务唯一的事实来源 */
export interface DialectFacts {
  readonly id: DialectId;
  /** 事实版本：方言包升级 ⇒ 缓存失效，不必重启编辑器 */
  readonly version: string;
  readonly events: readonly DialectEvent[];
  readonly symbols: readonly DialectSymbol[];
  readonly presentation: readonly DialectPresentation[];
  readonly storageClasses: readonly ('scene' | 'save' | 'session')[];
  readonly profile: DialectProfile;
}

export interface DialectEvent {
  /** 作者面名字（`会話` / `EVENTTRAIN`）：**方言包里是数据，不是代码** */
  readonly name: string;
  /** 这条事件在哪一类载体上被声明（eraFL 的 `会話` 在 xml，eraTW 的九事件在 erb） */
  readonly carrier: 'erb' | 'xml';
  /** 决定"同名多定义"是 error 还是合法（spec §10.5 的 layerPolicy 落到事件粒度） */
  readonly dispatch: 'unique' | 'shared-hook' | 'overlay' | 'metadata';
  readonly params?: readonly { readonly name: string; readonly type: 'int' | 'string' | 'ref' }[];
  readonly guards?: readonly string[];
}

export interface DialectSymbol {
  /** 作者面名字（中文）；日文原文走 `aliases`，**翻译是数据不是代码** */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly kind: 'variable' | 'function' | 'constant' | 'pronoun';
  /** 落点：**引擎词汇只允许出现在这里**（`TALENT` / `CFLAG:目标:1088` …），语言面不认它们 */
  readonly target: string;
  readonly storage?: 'scene' | 'save' | 'session';
  readonly readonly?: boolean;
}

export interface DialectPresentation {
  readonly kind: 'heart' | 'color' | 'face' | 'choice';
  /** 该方言下这一演出的落点（`SETCOLOR` / `PRINTL` / 颜绘指令…），同样是数据 */
  readonly target: string;
  readonly note?: string;
}

/**
 * 一次语言服务请求的方言上下文：**宿主解析，供方只读**。
 * 注意这里没有 `fallbackDialect`——**没有默认方言这回事**（D12）。
 */
export interface DialectBinding {
  readonly dialect: DialectId;
  readonly facts: DialectFacts;
  /** 这份文件属于哪个载体（决定"事件名在哪校验"） */
  readonly carrier: 'erb' | 'xml' | 'inline';
}
```

`EditorDocumentIdentity` 增一格（additive，旧供方零改动）：

```ts
export interface EditorDocumentIdentity {
  readonly languageId?: string;
  readonly version?: number;
  /**
   * 这份文档的方言上下文。**缺省 = 未绑定**：供方必须按"无事实"降级
   * （返回空 + 一条 `dialect/unbound`），**不许回落到任何默认方言**。
   * 这一行是 eraTW 写死那类 bug 的契约级封堵（D12）。
   */
  readonly dialect?: DialectBinding;
}
```

### 5.3 解析链：方言从哪来（四级，唯一真源）

1. **工程根 `kojo.project.json` 的 `dialect`** —— 唯一真源；
2. 文件里的 `# 方言 erafl` —— **只是一条断言**：与清单不一致 ⇒ `dialect/mismatch`（error）。
   它不产生第二真源，作用是"这份文件自证我属于哪个方言"，孤立打开一个文件时也能一眼看出错配；
3. 都没有 ⇒ **未绑定**：事实类服务全部降级（空结果 + 一条提示），**绝不猜**；
4. **状态栏常显当前方言**（`eratw` / `erafl` / `未绑定`）——作者不必猜，评审也不必问。

> **`# 方言` 是本方案唯一新增的语法**（`#` 词表里 `方言` 未被占用；用户 2026-10-25 定名）。它有三个约束，写进 spec §3：
> ① 可选；② **只断言不赋值**（不产生第二真源）；③ 与清单不一致是 **error**，不是 warning。
> 其余一切方言差异**都不进语法**——这是"根源性"与"又分叉一次"的分界线。

### 5.4 五个根因 → 五条语言层解法

| # | 问题 | 根因 | 语言层解法 | 落点 |
|---|---|---|---|---|
| 1 | 宿主写死 eraTW | 方言是"全局默认"，不是"工程属性" | 方言由清单解析、随每次请求下传；`dialect` 缺省即未绑定 | `dialect-resolver.ts`；删 `use-monaco-instance.ts:280` |
| 2 | 错事实不报错 | 供方拿不到"该用哪套事实"，也无从自证 | 每个事实类响应带 `dialect` + `facts.version`；宿主对账，不一致即诊断 | `dialect/response-mismatch` |
| 3 | eraFL 主战场是 XML，2.0 无落点 | 叙事面被绑死在"ERB 内联" | `carriers` 声明 + XML 载体的**等价面**：`command` / `name` / `kojoPlace` 由方言的事件目录校验 | `kojo-xml` descriptor 接 `dialect` |
| 4 | 事件四种架构 | 事件目录是 adapter 内部实现，不是语言面 | `eventCatalog` 进语言面：`# 机` / `@织` 的名字由方言校验，未知即 error；`dispatch` 决定同名多定义是 error 还是合法 | `DialectEvent.dispatch` |
| 5 | 每加一个 era 就再适配一遍语言 | 适配单元选成了语言 | 语法 / 载体 / 方言三轴正交，方言是纯数据 | 本方案全部 |

### 5.5 方言一致性体检（`dialect lint`）

打开工程跑一次，把"看起来对其实属于另一个游戏"的提示变成**可执行清单**：

| 检查 | 判据 | 诊断码 |
|---|---|---|
| 事件名 | 工程里出现的 `# 机` / `@织` / XML `command` 是否都在 `events` 里 | `event/unknown` |
| 事件落点 | `carrier` 与文件实际载体是否一致（eraFL 的 `会話` 写在 ERB 里就是错） | `event/wrong-carrier` |
| 符号 | 出现的名字是否都在 `symbols` 里（含 `aliases`） | `symbol/unknown` |
| 只读别名 | `readonly` 符号出现在赋值左值 | `symbol/readonly-assign` |
| 演出 | 用了 `@颜绘` 而 `presentation` 没声明 | `core/feature/unsupported` |
| 载体归属 | `carriers.glob` 覆盖不到的口上文件 | `unit/unowned` |
| 等待 | 缺 `waitDefault` 且出现无 `续` 的台词 | `text/missing-wait-default` |

**呈现纪律**：按 `(诊断码, 方言)` **聚合**成一条 + 可展开明细，不是把 400 条同类波浪线糊满屏幕。
这条纪律与 `fallback.ts` 的去重键同一思路（数字归一），只是粒度按方言事实。

### 5.6 多 era 验收：方言矩阵

`tests/dialect-matrix.test.ts`：每个方言一枚 fixture 工程，**同一组断言跑 N 遍**（语法面 / 事实面 /
降级面 / 编码面）。三条判据：

1. **宿主里出现具体方言名或引擎词汇 ⇒ 红**（`grep` 断言，与 `audit:decoupling` 同形态）；
2. **方言 A 的 facts 喂给方言 B 的夹具 ⇒ 必须给出诊断，不许静默通过**（这是 eraTW 写死那类 bug 的回归测试）；
3. **未绑定 ⇒ 事实类服务全空 + 一条提示**，且**不得**回落到任何默认方言。

这条闸就是"适配 N 个 era 不改语言"的守门人；它红的方式与 `language-parity.test.ts` 同构，
不需要新的测试范式。

---

# 第四部分 封存层与 SDK

## 6. 封存层：命令式 Kojo（D7）

**不是版本开关，是另一门语言。** 理由：spec §0.2 明令"无版本声明、旧写法一律 error"，
在 2.0 里留 `if (version === 1)` 就等于把双模式装回去。

| 项 | 取值 |
|---|---|
| 语言 id | `kojo-legacy` |
| 扩展名 | `.kojo1`（见 §6.1） |
| `availability` | `legacy` |
| `settingKey` | `ui.legacy-kojo-syntax`，**默认 false** |
| 设置页文案 | 「命令式 Kojo 语法（封存）—— 不再演进，仅保证旧文件可打开」 |
| 复用 | v1 的 `registerKojoLanguage`（Monarch / 配置 / 括号 / 回车规则）**一个字不删** |
| 结构层 | 复用 `kojo-runtime`（`tree-sitter-kojo.wasm` 0.78MB，**只在这门语言被打开时才装**） |

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
| B | `.kojo` 按内容嗅探（有无 `?` / `# 表` 等 2.0 锚点） | 判据可重叠，违反 `languageIdForPath` 的"判据不重叠"纪律；半成品文件永远猜错 |
| C | `.kojo` 归 v1 不变，2.0 只用 `.kojo2` | 封存层变成"主扩展名的主人"，与"kojo2 取代 kojo1"直接矛盾 |

> **已定：A。** 于是 K2-CUTOVER 的动作是"让出扩展名"，不是"删掉 v1"：
> `KOJO_SOURCE_EXTENSION` 改指 2.0；v1 descriptor 改认 `.kojo1`；随附一键改扩展名工具（只改名、不改内容）。
> 封存层因此天然是"另一个扩展名的另一门语言"，2.0 编译器里一行旧分支都不需要（D7）。

## 7. 与 SDK 的关系：不冲突，SDK 是上游

B0–B5 的目标就是"把语言层做成 SDK"。LAU 只是把 SDK 的**契约面**提前定下来，因此有四条约束：

1. **封存层只能当 SDK 的普通消费者，不许进契约。** 若 `sugar.*`、`如果` 块渗进 provider 契约，SDK 就被历史绑住。反过来，封存层是最好的 SDK 压力测试：一门完全不同的语法只靠公开契约接进来——接不进来就是 SDK 缺面（见 §9 验收 2）。
2. **角色表住 SDK，不住 app。** 第三方插件最需要的扩展性就是"给我的语言上色"；角色表 + 主题规则形状必须是导出面。
3. **协议是 SDK 面且带版本号。** 第三方要一条"我的文法 → 捕获 → 角色"的通道，那就是 `structure-protocol.ts` + `StructureRuntime`。
4. **封存层的状态写死 sealed。** SDK 一公开，一定有人要求"我的旧文件也要能编译"；边界不写死就会被推着走。

### 7.1 SDK 是三层，不是一层

| 层 | 谁消费 | 形态 | kojo 的对应物 |
|---|---|---|---|
| **契约层** | 方言作者、插件作者 | 类型 / 接口（编译期可查） | `GameAdapter` / `DialectFacts` / `StructureRuntime` |
| **数据层** | 方言作者 | 纯数据，零代码 | 方言包的 `events` / `symbols` / `storageClasses` |
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
  `# 视` 的代词表、名字函数全要跟着进 core——**这一条会把整个方言层拆掉**。
- 若 `角色` 改由方言定义，那它不是通用概念，`角色.恋慕` 退化成 `方言.方言知识`，前缀零信息量。
- 更根本：**点号是"归属"记号，不是"来源"记号。** 作者写 `角色.恋慕` 想说的是"这是角色的属性"，
  不是"这个知识来自 eraTW 包"。后者才是适配问题，而它已经在别处解决了——**工程清单绑定方言**（D11）。
  "来源"不需要在每一行代码里重复一次。

所以这个形状在架构上自相矛盾：它想用语法表达一件**已经在数据层表达过**的事，代价是把游戏名词塞回 core。

### 7.4 结论：prelude 是默认，限定名只在冲突时出现

| 需求 | 解法 | 新增语法 |
|---|---|---|
| 日常调用方言知识 | **prelude**：方言把名字注入文件作用域，作者写 `恋慕`（今天已经如此） | **零** |
| 补全只显示本方言的名字 | 事实面按 `DialectFacts` 过滤（LAU-D2） | 零 |
| 两个方言包同时可见且重名 | **限定名** `erafl.口上番号`，`erafl` 是方言 id、不是游戏名词 | 零（与 `数组.长度` 同族，不是新概念） |
| 表达"这个能力可选" | `DialectFacts.capabilities` + 诊断，不给作者语法 | 零 |

**你想要的"自然调用"，今天的 spec 已经是了**：`恋慕`、`{她}`、`# 机 初见` 全是裸名字，作者从不写前缀。
真正缺的不是语法，是两件工程事——**工程有没有绑定方言**（LAU-D1）、**编辑器有没有按方言过滤**（LAU-D2）。
两件都在 LAU 里。

这也解释了为什么"加语法"这条路走不通：**适配问题不在语法层，在事实层。** 语法只要一门，事实要 N 套；
所以变化必须发生在数据里，不能发生在名字的形状里。

# 第五部分 落地

## 8. 批次与 DoD

| 批 | 内容 | DoD（可执行） | 回滚点 |
|---|---|---|---|
| **LAU-1** 协议 v3 | `structure-protocol.ts` 落 `plugin-api`；`StructureClient` 按 v3 重写成薄壳；`erb-ts.worker` / `kojo-ts.worker` / `worker-bootstrap` / `engine` 跟着改；两档预算 + 连续失败判死 | 协议表测试（形状 / `reason` 闭集 / 版本不符即拒）全绿；ERB 首帧 `ready` 后首屏着色有读数；`tree-sitter-*` 五个测试文件全过 | 单批一个 commit，`types.ts` 的旧类型保留为别名，随时可切回 |
| **LAU-2** 角色表 | `semantic-roles.ts` + 别名表；三份捕获表翻到角色；三套主题规则改 `token: role.*`；Monarch 的 token 名换一遍 | `grep -r "sugar\.\|kojo2\." packages/app/src` 只命中别名表一处；主题对账测试（每档有且只有一条规则 / ΔE / 对比度）全绿 | 别名表在，旧名仍能取色 |
| **LAU-3** 描述符 v2 + 封存层 | `availability` / `settingKey` / `presentSyntax`；新增 `kojo-legacy` descriptor 与设置项；`providers.ts` 里那处 `if (ERB)` 删除 | 封存层默认关：`.kojo1` → `plaintext`；开启后四面齐全；`grep -r "ERB_LANGUAGE_ID" packages/app/src/monaco/*.ts` 只剩 descriptor 自身 | 设置项默认 false，等价于没有这一层 |
| **LAU-4** ERB 进槽 | ERB 的 11 枚 provider 搬成插件供方（依赖 B0–B5 的槽位契约） | ERB 与 kojo2 走同一条 `ui.editor.languageService`；宿主 `monaco/` 下不再有 ERB 判据 | 插件可卸载，回落到 `legacyBridge` |
| **LAU-5** 单 worker 池（可选） | 一个 structure worker 池共用 `Parser.init`，语言懒 `Language.load` | 冷启动省一次 runtime 初始化（实测 15.7ms）+ 少两条线程；内存峰值不升 | 池关掉即回到"每语言一条线程" |
| **LAU-6** `@原生` 注入 | descriptor 加 `injections`；协议加 `includedRanges`；宿主按声明转发子 parse；子树 tokens 区间覆盖主树 `role.raw` | §4.6 四条 DoD 全绿；无 `@原生` 的文件零 wasm 请求；子树失败不拖垮主树 | `injections` 置空即回到"整块不透明" |
| **LAU-D1** 方言契约与解析链<br>（可与 LAU-1/2 并行） | `dialect.ts`（`DialectManifest` / `DialectFacts` / `DialectBinding`）；`EditorDocumentIdentity.dialect`；`dialect-resolver`（工程清单 → binding）；**删掉 `use-monaco-instance.ts:280` 的 eraTW 硬编码**；状态栏显示方言 | 打开 eraFL 工程，状态栏显示 `erafl`；未绑定方言时事实类服务返回空 + 一条 `dialect/unbound`，**不出现任何 eraTW 事实**；`grep -rn "eratw" packages/app/src` 零命中 | 硬编码删掉即回滚（adapter 本来就从插件取） |
| **LAU-D2** 事实面接线 + `dialect lint` | 补全 / 悬停 / 签名 / 符号 / 跳转 / 诊断改吃 `DialectFacts`；`# 机` / `@织` 的事件名按 `events` 校验；`dialect lint` 七项 | 方言矩阵（eraTW + eraFL 两枚夹具）同一组断言全绿；把 eraTW 的 facts 喂给 eraFL 夹具 ⇒ **必红** | 每类事实一个 commit，逐个可回 |
| **LAU-D3** 多载体（eraFL 的 XML 面） | `carriers` 归属；`kojo-xml` descriptor 接方言：`command` / `name` / `kojoPlace` 由 `events` 校验；ERB 壳函数得到"这条事件在 xml"的提示 | 打开 eraFL 口上 XML：`command` 有补全、未登记 `command` 报 `event/unknown`；ERB 壳函数不再被当成"没实现的口上" | 载体绑定是数据，删掉即回到"XML 只是数据格式面" |
| **LAU-D4** 方言包 + 翻译表 | eraTW / eraFL 两枚方言包（**纯数据**）；日文原名走 `symbols[].aliases`；`conformance` 夹具 | 新增第三个 era 只加一个包：宿主零改动、语法零改动，矩阵自动跑第三列 | 包可卸载 |

## 9. 验收线

1. **零语言知识**：`grep -rn "ERB_LANGUAGE_ID\|KOJO2_LANGUAGE_ID\|sugar\.\|kojo2\." packages/app/src/monaco/` 只命中 `languages.ts`、各自 `*-language.ts`、别名表。
2. **一门假语言**（`tests/fixtures/language-probe/`）：只靠公开契约接入（descriptor + runtime + 一份小 wasm），四面（着色 / 折叠 / 缩进 / 残缺）全绿，宿主零改动。**这是 SDK 与 LAU 的共同验收**。
3. **首帧读数**：ERB 冷启动 `open→ready` 与 `ready→首屏着色` 各一个数，写进 `BASELINES.md`。
4. **降级台账对账**：`StructureFailureReason` 每一个成员都有文案（`diagnostic-copy.test.ts` 形态），多一个少一个都红。
5. **协议闸**：形状不符 / 版本不符 / 迟到回复 / 换轨串号，四类各一条测试。
6. **封存层边界**：默认关闭时不产生任何 wasm 请求（网络面板断言），开启后不参与 `language-parity` 矩阵。
7. **方言零硬编码**：`grep -rn "eratw\|erafl\|TALENT\|CFLAG" packages/app/src` 零命中（方言包与夹具除外）。
8. **错配必红**：方言 A 的 facts 喂给方言 B 的夹具，必须给出诊断，不许静默通过——这是 eraTW 写死那类 bug 的回归测试。
9. **未绑定不猜**：`dialect` 缺省时事实类服务全空 + 一条提示，且不得回落到任何默认方言。
10. **加 era 只加数据**：新增第三个方言包时，`git diff --stat packages/app` 应为空。

## 10. 明确不做

- 不改 2.0 语法（`?` 链、`# 表`、程序层一个字不动）；表达式条件只做诊断（选项 ①）。
- **`@原生` 体内要做注入**（§4.6 / LAU-6）：从"整块不透明"改为按 descriptor 声明注入 ERB。
- 不把叙事层从 tree-sitter 上摘下来（极端解 ③ 已搁置）。
- 不合并 `EDITOR_SEMANTIC_TOKEN_TYPES`。
- 不新增 workspace 包（先落 `plugin-api`；是否拆 `@kojo/language-sdk` 由 B5 决定）。
- 不改 Monarch 的**解析逻辑**，只改它吐的 token 名。
- **不为任何 era 分叉语法或 tree-sitter 查询**（方言只进事实类服务，D10）。
- **不在 core / 宿主里出现游戏名词**：引擎词汇只允许出现在方言包的 `target` 字段里（`audit:decoupling` 的延伸断言）。
- 不做"自动推断方言"（按内容嗅探、按文件名猜）：推断错一次 = 整套错误事实，比"未绑定"危险得多。
- **不新增任何语法**：本方案只加 `# 方言`（一条断言，D11）。
