# 糖提升建议器（lift-suggester）设计稿 —— v0.3 批 S5

> **状态**：S5 实现前置设计稿（2026-10-11）。**表层语法权威** = `docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（v1.2）。
> 路线出处：`docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §1.5 / §8.2（S5 = 升糖建议器，**建议式 + 逐字节一致**）。
> 本文只做**设计**（识别算法 / 判据 / 边界），实施记录见 `docs/IMPLEMENTATION-LOG.md` §5.31。

---

## 0. 一句话

**方向与 S2 相反**：S2 是「糖源码 → 原生 ERB」（降糖）；S5 是「原生 ERB → 糖候选」（升糖）。

升糖的**安全前提不是"看起来像"，而是"转回去逐字节一样"**——每个候选都必须把它建议的糖片段
交给 S2 的转译器跑一遍，产物与**原文本该区间逐字节一致**才算候选成立。不一致 → 降级为不建议。
**宁可漏报，不可错报**（规范/设计稿 §八：误升糖不易察觉，风险不对称）。

---

## 1. 为什么不"可信识别"，而"自证"

社区 ERB 的多样性（历史遗留写法、个人风格、移植代码）使任何启发式识别都有误判空间：

- `PRINTFORMW 「你好，%NAME:TARGET%。」` 可能来自糖，也可能手写；
- 同一 `IF` 块在不同上下文中对应不同糖写法；
- 逆向**不唯一**（同一个 ERB 片段可能有多种合理糖写法）。

因此识别只负责**找候选**（尽量不漏），**是否成立由 round-trip 决定**：

```
候选区间 [a,b]  →  生成建议糖片段 S  →  S2 transpile(S)  →  取产物区间  →  与原文本 [a,b] 逐字节比对
                                                                              ├─ 一致   → 候选成立（保留）
                                                                              └─ 不一致 → 降级（丢弃，记 skip 原因）
```

这条自证让"误报"在结构上不可能发生：**没通过 round-trip 的候选根本不会出现在结果里**。
代价是"漏报"——某些本来是糖写法、但因生成器口径（缩进 / 变体选择 / 别名展开）对不上的片段会被丢掉。
这是**有意为之**的取舍。

---

## 2. v1 覆盖的四类糖（按 spec §3）

S5 任务书划定四类（比审阅 §1.5 的"高置信三模式"多一类 `别名`，因为 §3.1 的头部声明是**零风险**的纯文本重构）：

| # | 糖类型（`SugarLiftKind`） | spec 出处 | 识别的原生 ERB 形态 |
|---|---|---|---|
| 1 | `print-message` | §3.3 / §5.1 | `PRINTFORM{W,L,DW,DL} <文本>` 单行 → 糖文本行（含 `续` 的判定） |
| 2 | `if-block` | §3.5 | `IF <cond>` … `ELSEIF` … `ELSE` … `ENDIF` 块 → `如果 / 否则如果 / 否则` 缩进块 |
| 3 | `selectcase` | §3.6 | `SELECTCASE <subj>` / `CASE v` / `CASEELSE` / `ENDSELECT` → `当 / 是 / 否则` 块 |
| 4 | `alias` | §3.1 / §5.0 | 作者私有变量的**重复使用**（同一 `CFLAG:TARGET:N` 多次出现）→ **v1 无候选落点**（见 §2.2） |

### 2.1 每类的"保守"边界

- **print-message**：
  - 只认 `PRINTFORM` 家族**四个变体**（`W/L/DW/DL`）。`PRINTFORM` 与 `PRINTFORMD`（无 `L/W` 后缀 = **不换行不等待**）**没有糖形态**（§3.3 能力边界）→ 跳过；
  - `PRINTL` / `PRINT` / `PRINTD` 系（无 `FORM`，不做插值展开）→ 跳过（糖产物恒为 `PRINTFORM*`）；
  - `PRINTDATA*` / `PRINTS` 系 → 跳过；
  - **变体与引号性必须一致（实测定案）**：糖层把「台词」（有引号）映射到带 `D` 的**要**变体、旁白（无引号）映射到不带 `D` 的变体，且换行/等待由 `W`/`L` 决定：

    | 糖写法 | 产物 |
    |---|---|
    | `「台词」` | `PRINTFORMW` |
    | `「台词」 续` | `PRINTFORML` |
    | `旁白` | `PRINTFORMW` |
    | `旁白 续` | `PRINTFORML` |

    > 实测更正：D 后缀由**引号性**（即"是否台词"）决定，而非由 `旁白` 单独决定。因此
    > `PRINTFORMDW 旁白` / `PRINTFORMDL 旁白` 这类"旁白 + D"**无法 round-trip**，自动降级
    > （这正是自证机制的价值：写法看着像糖，转回去对不上就不报）。
  - 文本体含 `%…%` / `{…}` / `\@…\@` 的**原生记号**时，需要在糖里改写成 `{…}`——交付的糖片段用 **`{}` 统一记号**（§3.4），round-trip 由 S2 把它降回去；能对上才成立（`%CALLNAME:MASTER%` → `{你}`，`%CALLNAME:n%` → `{角色n的名字}`）。

- **if-block**：
  - 只认**完整闭合**的 `IF … ENDIF`（孤儿闭合 / 缺 `ENDIF` → 跳过，不猜）；
  - 含 `SIF` / `TRY` 系 / `FOR` / `WHILE` / `REPEAT` 等**糖未覆盖的控制流**在块内 → 跳过（糖片段无法逐字节还原）；
  - 块体含**原生直通行**（如 `SETCOLOR` / `CALL X` 非 HPH）→ 该行可作原生直通嵌入，能对上即保留；含 `$标签` / `GOTO` → 跳过（糖产物无标签）；
  - 条件表达式**必须能被 `condition-extractor` 的表达式解析器解析**（`opaque` → 跳过）；
  - **`IF LOCAL` 信封必须透传，不得作为候选**（实测定案）：转译器为每个 `时机` 块**自动**生成 `IF LOCAL` … `ENDIF` 骨架，故真实语料里作者正文总被它包着。识别时用 `envelopeDepth(stmts)` 探测"顶层恰为一个 `IF <裸 LOCAL>` 开块"，命中则**只在其内部识别**、绝不把信封本身当候选。
    - 与 S4 预览的 `isEnvelopeChain` 同源（那条谓词不可判定 + 产物行无糖源归属）；
    - 另一个硬原因：转译器的 **expression 层字典解析不到 `LOCAL`**（报 `unknown-identifier`），所以 `IF LOCAL` 的糖片段根本过不了自证——双重保险。
  - **缩进归一化（实测定案）**：原文块可能嵌在任意深度（`IF LOCAL` 体内即 1 级），而自证用的最小壳恒把候选放在 1 级；两者**绝对缩进不可比** → 自证时双侧做 `normalizeIndent`（去掉**公共最小缩进**，空行不参与）后比对。同时 `extractBody` 取的是区间原文（**不**逐行剥缩进）。
  - **比对区间须含 `ENDIF`**：糖块产物**必然补回** `ENDIF`，故原文本比对区间取 `[fromLine, toLine]`（含闭合行），否则生成体多一行而误判失败。

- **selectcase**：
  - 只认 `CASE v` / `CASE a TO b` / `CASE a, b` 与 `CASEELSE`；块内须有 `ENDSELECT`；
  - `CASE` 值含**函数调用**或**变量**（非字面量）→ 跳过（糖 `是` 的值形态限数字 / 字符串字面量，但实现上走 `lowerExpression` 兜底，能 round-trip 才保留）；
  - **随机块（`LOCAL = RAND:n` + `SELECTCASE LOCAL`）单独识别**为首选形态（§3.6）：若匹配 `LOCAL[:N] = RAND:n` 紧跟 `SELECTCASE LOCAL[:N]` 且 `CASE 0..n-1` 完全覆盖 → 建议 `随机` 块；否则退化为普通 `当` 块建议。

### 2.2 `alias` 的最终定案：v1 **不出候选**（只报 `not-covered`）

任务书把 `alias` 列为第四类，但**实测证明原生 ERB 侧没有可验证的别名落点**：

1. `别名`（§5.0）是**糖源码层预处理**——作者在 `.kojo` 里写裸标识符，糖层才把它展开成目标；
2. 糖层对原生 ERB 的 `%…%` 与**全大写直通行**做**原样透传**，别名替换**不介入**；
3. 故"把原生片段套上 `别名` 声明再转译"永远得到**多了声明行、正文未变**的产物 → round-trip 必不成立。

**结论**：`alias` 类保留在 `SugarLiftKind` 契约里（类型完备、便于未来重开），但实现只做**扫描 + 计数**（`ALIAS_MIN_OCCURRENCES = 3`），命中时产出 `not-covered` 跳过项，**不出候选**。宁可整类漏报，也不产一个靠猜的别名建议。

---

## 3. round-trip 的坐标与形态

### 3.1 归一化：糖片段必须能"独立转译"

S2 的 `transpile` 输入是**完整 `.kojo` 文件**（需要 `角色:` 头部 + `时机 …：` 块头才会产出正文）。

因此候选自证的糖片段必须是**可独立转译的最小文件**：

```
角色: {从产物反推的 K{n}；推不出 → 用占位 0}
时机 指令 {index}：
    {候选糖语句，按缩进一级}
```

于是产物形态是 `@M_KOJO_MESSAGE_COM_K{n}_{i}` + 骨架 + `IF LOCAL` + 候选正文 + `ENDIF` + `RETURN 1`。
**比对时只取正文区间**（`IF LOCAL` 之后到配对 `ENDIF` 之前），双侧 `normalizeIndent` 后比对
（见 §2.1 if-block 的缩进归一化说明）。

### 3.2 逐字节比对的确切定义

```
原文区间行  raw[a..b]              （含行首缩进，不含行尾换行；EOL 已归一为 \n）
产物区间行  gen[c..d]              （`IF LOCAL` 与配对 `ENDIF` **之间**的行）
verified = normalizeIndent(raw[a..b]) === normalizeIndent(gen[c..d])
```

其中 `normalizeIndent` = 去除**公共最小前导缩进**（空行不参与计算，也不被裁剪）。

**只有 `true` 才产出候选。** `false` 时记入 `skipped`（附 `roundtrip-mismatch`），不出候选。

### 3.3 为什么不做"语义等价"退让

不写"正则归一后相等也算"这类宽松判据：那会把"差一个空格"放过，而作者点「应用」后文件就变了——
正是设计稿 §八说的"误升糖不易察觉"。**逐字节或不算。**

---

## 4. 数据结构

### 4.1 契约（`plugin-api/src/sugar.ts`，全部 additive）

```ts
export type SugarLiftKind = 'print-message' | 'if-block' | 'selectcase' | 'alias';

export interface SugarLiftCandidate {
  kind: SugarLiftKind;
  /** 源 ERB 区间（1 基行号，闭区间）——原文里被建议替换的整段 */
  fromLine: number;
  toLine: number;
  /** 建议的糖源码片段（可含缩进；与 `fromLine..toLine` 同宽语义） */
  sugarSource: string;
  /** 置信度：'verified'（round-trip 逐字节一致）——v1 只产这一档 */
  confidence: SugarLiftConfidence;
  /** round-trip 证据（审计/UI 提示用） */
  roundTrip: SugarLiftRoundTrip;
  /** 人读说明（中文；面向作者） */
  reason: string;
}

export type SugarLiftConfidence = 'verified';   // v1 闭集只有一档（未通过者不入结果）
```

置信度闭集只有 `'verified'` 是有意的：**契约上不允许出现"可能对"的候选**。若未来要加低置信档，
须先改这条注释与测试（"宁可漏报"的默认不可被悄悄放宽）。

### 4.2 round-trip 证据

```ts
export interface SugarLiftRoundTrip {
  /** 是否逐字节一致（v1 恒 true——不一致的候选已被丢弃） */
  verified: boolean;
  /** 原文本区间（去行尾换行后，按 \n join） */
  originalText: string;
  /** 转译回来的文本（去基准缩进后） */
  generatedText: string;
  /** 差异首个行列（verified=false 时有值；v1 结果里不会出现，留作调试/未来低置信档） */
  firstDiff?: SugarPosition;
}
```

保留 `verified` 字段而非"有候选=已验证"的隐含约定：**让消费方不必读实现就知道"为什么它能被信任"**。

### 4.3 请求 / 结果 / 服务

```ts
export interface SugarLiftRequest {
  /** 待分析的原生 ERB 文本（内存态；本服务**不读盘**） */
  source: string;
  /** 源文件路径（诊断元信息；不触发 IO） */
  filePath?: string;
  /** 角色号（可选）——用于拼装自证用的最小 `.kojo`；缺省从产物 `K{n}` 反推 */
  characterNo?: number;
  /** 时机分野/编号（可选）——同上；缺省用 `指令 1` 占位（自证只需形态一致，不需真实分野） */
  timingFace?: string;
  timingIndex?: string;
}

export interface SugarLiftResult {
  candidates: SugarLiftCandidate[];
  /** 被跳过的区间（**显式**——不静默） */
  skipped: SugarLiftSkip[];
  /** 本次分析用的解析信号（condition-extractor 不可用/失败时如实标出） */
  degraded: boolean;
}

export interface SugarLiftSkip {
  fromLine: number;
  toLine: number;
  reason: SugarLiftSkipReason;
}

export type SugarLiftSkipReason =
  | 'unsupported-print-variant'   // PRINT 变体无糖形态（PRINTFORM / PRINTFORMD / PRINTL …）
  | 'unparsable-condition'        // 条件表达式 opaque（condition-extractor 解析失败信号）
  | 'unsupported-control-flow'    // 块内含糖未覆盖的控制流（SIF/FOR/WHILE/REPEAT/TRY 系/PRINTDATA 系）
  | 'label-or-goto'               // 含 `$标签` / `GOTO`（糖产物无标签）
  | 'macro-or-directive'          // 含 `#` 预处理 / `@` 函数边界穿越
  | 'mixed-domain-line'           // W: 文本域与 L: 逻辑域混行（同缩进层既有文本又有逻辑）
  | 'comment-interference'        // 块内注释/空行打断连段（无法构成单一糖节点）
  | 'roundtrip-mismatch'          // round-trip 逐字节不一致（**降级**）
  | 'transpile-error'             // 糖片段转译自身出错（生成了非法糖）→ 丢弃
  | 'not-covered';                // 形态不在 v1 四类之内

export interface SugarLiftService {
  liftSuggest(request: SugarLiftRequest): SugarLiftResult;
}
```

---

## 5. 边界识别从严（任务书第 3 条）

下列情形**直接跳过，不产出候选**（复用 `condition-extractor` 的解析失败信号 + 结构扫描）：

| 情形 | 判据 | skip 原因 |
|---|---|---|
| 条件抽取层解析不了 | `parseExpression(cond).kind === 'opaque'` | `unparsable-condition` |
| 注释/宏干扰 | 块内含 `;` 注释行、`#`/`@` 行、`[SKIPSTART]…[SKIPEND]` | `comment-interference` / `macro-or-directive` |
| W: 文本域与 L: 逻辑域混行 | 同一缩进层的相邻行里既有可糖化文本行、又有逻辑语句（赋值/控制流），且**无法整段构成单一糖节点** | `mixed-domain-line` |
| 块内糖未覆盖的控制流 | `scanControlFlow` 报出 `SIF/FOR/WHILE/REPEAT/DO/TRY*/PRINTDATA*/DATALIST/STRDATA/NOSKIP` | `unsupported-control-flow` |
| 含标签/跳转 | `^\$` 或 `\bGOTO\b` | `label-or-goto` |
| PRINT 变体无糖形态 | `PRINTFORM` / `PRINTFORMD` / `PRINTL` / `PRINT` / `PRINTD` … | `unsupported-print-variant` |
| round-trip 不一致 | 见 §3.2 | `roundtrip-mismatch` |
| 糖片段转译出错 | S2 返回 `severity: 'error'` 诊断 | `transpile-error` |
| 四类之外（含 `alias`） | 形态不在 v1 可自证范围内 | `not-covered` |

**"混行"的准确语义**（任务书原文）：糖的每个节点要么是"文本节点"要么是"逻辑节点"，
而 ERB 允许同一缩进层随意混排。若某段里文本行与逻辑行**交错**且无法拆成两个独立的糖节点
（例如 `IF` 的 then 体里第一行是文本、第二行是 `SETCOLOR`、第三行又是文本），
则**整块**跳过——因为糖片段里这三行不可能既有缩进语义又逐字节对上。

反之，**清一色**的文本行连段（≥1 行）或**清一色**的逻辑块是安全的。

---

## 6. 已知取舍（"漏报"清单，写进 §5.31 边界未做）

1. **`_1` 正文函数的 `IF LOCAL` 信封**：真实语料里作者正文总被 `IF LOCAL` 包着。
   本批**不把该信封作为糖的一部分**（糖的 `时机` 块会自己生成它），故识别时的原文区间
   落在 `IF LOCAL` **内部**——但区间行号仍报原文行号（消费方按区间替换即可）。
   *未做*：把"带信封的整个函数体"作为一次升糖（会产生 `时机` 块建议）——留待 S5-UI 批。
2. **工具函数 / `@` 原生块**：`@M_KOJO_COLOR_K12` 这类骨架函数不产出候选。
3. **`PRINTBUTTON` + `INPUTS` + `SELECTCASE RESULTS` → `选项` 块**：识别逻辑明确，
   但本批**未做**（任务书四类不含 `选项`；且 `选项` 需要跨块（按钮列表 + INPUTS + SELECTCASE 三段）
   的区间合并，风险高于收益）。留待 v1.1。
4. **`CALL HPH_PRINT(@"…","w")` → `心形`**：形态明确，本批未做（同上，四类之外）。
5. **列级定位**：候选只报行区间（行级，与 S1 源映射粒度一致）；列级留 S6。
6. **`别名` 类无候选**（§2.2 定案）：保留类型与扫描（`ALIAS_MIN_OCCURRENCES = 3`），
   但**只报 `not-covered`**。重开条件 = 糖层将来对原生 ERB 的别名展开介入（当前是原样透传）。
7. **跳过块的成员行不再单独提升**：块级跳过时，`skipBlock` 会把整个区间**同时** `markConsumed`，
   否则成员行会被后续单行扫描逐个"提升"，产生碎片化建议（形态上像糖但整块对不上，属噪音）。

---

## 7. 复用清单（不新建能力，全部经**服务槽**软取）

| 复用 | 来自 | 用途 | 取法 |
|---|---|---|---|
| `transpile` | **本插件** `sugar.transpile`（S2） | round-trip 自证 | 同插件内直接调用 |
| `scanControlFlow` | `erb.parser` 服务 | 块配对 / 深度 / 识别糖未覆盖的控制流 | `scanFlowOf()` 软取（缺席则退回内置兜底扫描） |
| `parseExpression` | `condition.extractor` 服务 | 条件可解析性（`opaque` = 跳过信号） | `parseExprOf()` 软取（缺席则保守跳过所有带条件的块） |
| `SugarDiagnostic` | `plugin-api/sugar.ts` | 转译错误的判定口径 | 类型导入 |
| 产物 `K{n}` 反推 | 无需 adapter（v1 只用产物反推） | 自证用的角色号 | 正则 |

**零新增解析器**：S5 只做"扫描 → 组装糖片段 → 调 S2 → 比对"。

**零交叉 import 约束**（解耦审计 C 项）：本插件**不得** `import @kojo/plugin-erb-parser` 或
`@kojo/plugin-condition-extractor`。两者改为**软取服务槽**：

```ts
const scanFlowOf = (): ((text: string) => ControlFlowStatement[]) | undefined => {
  try { return ctx.inject<ErbParserService>(WellKnownServices.ErbParser).scanControlFlow; }
  catch { return undefined; }              // 服务缺席 → 不 inactive，退回内置兜底
};
```

为此在 `ConditionExtractorService` 上 **additive** 新增了 `parseExpression(text)`（无状态纯函数，
不依赖索引），**不改动任何既有签名**；既有消费方零影响。

---

## 8. 验收（对应任务书）

1. **每类糖三路测试**：正例命中 / 干扰反例跳过 / round-trip 降级（构造一个"看起来像但转回去对不上"的样例，
   断言它**不出现在** `candidates`）。
2. **集成断言**：`fixtures/mini-game`（真实形态的合成口上）+ `fixtures/sugar` 的 .kojo 转译产物反向喂回。
3. **零回归**：`transpile` / `compileToFile` / `preview` 行为与 golden 断言不变；
   `pnpm audit:decoupling` 全绿（13 插件）。

---

## 9. 不做清单（明确排除，防范围蔓延）

- ❌ 全自动升糖（设计稿 §八：**永不**）；
- ❌ 修改磁盘上的 ERB（本服务**纯函数**，只出建议；应用由 UI 批做）；
- ❌ 改动 S2 内核（`lexer`/`parser`/`codegen`/`expression`）与 golden；
- ❌ 新增解析器 / 引擎知识进契约（中文关键字是跨游戏语言层，游戏知识归 adapter）。
