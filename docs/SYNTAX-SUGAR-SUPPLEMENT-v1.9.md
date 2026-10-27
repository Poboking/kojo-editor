# kojo1 语法补充稿（v1.9 · 草案）

> **定位**：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（v1.8）的增量补充稿。本文只做**语法设计与面口径**，不涉及实现。
>
> **基线**：`dev@52a4ddec`（2026-10-27）。ERB 侧以三份真源为准：`packages/app/src/monaco/erb-directives.ts`（206 枚词形，P0-2 / P1-1 / K5 三批；口径 = **口上高频子集，非 Emuera 全集**）、`packages/plugin-api/src/erb.ts`（预处理三正则 / `{}` 行连接 / 停用区）、`packages/plugins/erb-parser/src/{scanner,structure,instructions}.ts`（控制词全集 / 301 指令 / 声明面）。
>
> **结论**：kojo1 目前只有 **3 类 ERB 构造写不出来**（预处理条件块被误诊成规则池标签、行连接与 `#` 声明族兜底成台词）：预处理条件块、行连接块、`#` 声明族；其余缺口都是"显示形 / 写形 / 面"的不对称。本稿按 P0（结构三件）→ P1（显示词升写形）→ P2（面接线）分批补齐，**不新增诊断码、不改既有 golden**。

---

## 0. 摘要

1. **硬缺口只有三类**：预处理条件块 `[IF]` 族、行连接 `{` / `}`、`#` 声明族 8 枚（含 `#FUNCTION` / `#FUNCTIONS`）。其中预处理行今天落两种误判：`[IF <宏>]` / `[ELSEIF <宏>]` 被 `matchRuleTag` 当成规则池分支标签、报 `rule-pool-branch-outside-pool`（错诊断且阻止编译）；`[ELSE]` / `[ENDIF]` / `[IF_DEBUG]` / `[IF_NDEBUG]`（纯大写 ASCII 被排除在标签外）与 `{` / `}`、`#` 声明族一起兜底成**台词**。这是铁律 4（不静默）唯一还会漏的形态。
2. **软缺口是读写不同形**：`DATALIST` / `ENDLIST` / `STRDATA`、`NOSKIP`、`置位 / 清位 / 翻位`、`多行语句开始 / 结束` 在显示层已有中文词，但写层没登记（`native-display/control.ts` 头注把这类词标为"显示形不承诺可写"）。本稿把这批**显示词升为写形**，满足"写读同形"。
3. **面缺口集中在 `.kojo` 的糖区**：补全在原生区（全大写指令行 / `@` 块）已整轮路由 `ERB_COMPLETION_ASSEMBLY`，但糖区行首、`#` 位、`[` 位没有 ERB 候选；折叠 / 语义 / 诊断也没有预处理 / 括号块；词法只严格认 `[SKIPSTART]` / `[SKIPEND]`。P2 给逐面落点表，不新造词。

---

## 1. 基线对账

### 1.1 ERB 侧（最新完成面）

| 面 | 真源 | 规模 / 形态 |
| --- | --- | --- |
| 控制流 | `erb-parser/src/scanner.ts` 的 `CONTROL_SHAPES` | IF / SELECTCASE / FOR / WHILE / REPEAT / DO / TRY 九枚 / DATALIST / STRDATA / NOSKIP / PRINTDATA 族；开 / 分支 / 闭三类 |
| 语句词表 | `erb-directives.ts` 的 `ERB_DIRECTIVES` | 控制词从 `ERB_CONTROL_STATEMENTS` 派生 + 手写高频语句；显示词表已认 **206 枚** |
| 预处理 | `plugin-api/src/erb.ts` 的 `ERB_PREPROC_PATTERNS` | `[IF …]` / `[IF_DEBUG]` / `[IF_NDEBUG]` 开；`[ELSEIF …]` / `[ELSE]` 分支；`[ENDIF]` 收；**整行严格等值、大小写不敏感** |
| 行连接 | 同文件的 `ERB_CONTINUATION_MARKERS` | 整行 `{` 开、整行 `}` 收；行间补一个半角空格（`ERB_CONTINUATION_SEPARATOR`） |
| 声明面 | `erb-parser/src/scanner.ts` + `kojo-sugar/src/native-display/control.ts` | `#DIM / #DIMS / #DIMSTR / #DIMCHAR / #DIMF / #DEFINE`（`DIM_RE`）；另有显示层已认的 8 枚文件级 / 函数标记声明（§3.3） |
| 指令 / 内建函数 | `erb-parser/src/instructions.ts` + 签名表 | 301 指令 / 170 内建函数 |

### 1.2 kojo1 侧现状

| 面 | 现状 |
| --- | --- |
| 写形 | `keywords.ts` 共 **80 枚中文词形** = `KEYWORDS` 67 枚（头部 14 / 块 24 / 行内 29）+ 运算符 13 枚；另有 3 枚语句形函数 |
| 原生直通 | `lexer.ts` 的 `RAW_INSTR_RE`（全大写指令）/ `$` 标签 / `DIM_DIRECTIVE_RE`（`#DIM` 族 6 枚） |
| 显示形 | `native-display/` 两层：`statement.ts`（单行）/ `control.ts`（控制 / 预处理 / 分组 / 括号）；另有 `project.ts`（工程级） |
| 回读 | `lift.ts` + `lift-apply.ts`；显示词可写才允许回读 |
| 面 | `kojo-*` 系列 provider + `kojo-sugar/src/{folding,formatter,enter,semantic-tokens,document-symbols,definition,rename,preview}.ts` |

### 1.3 差集（本稿要补的）

| 档 | 构造 | `.kojo` 现状 | 证据 |
| --- | --- | --- | --- |
| **硬** | `[IF] / [ELSEIF] / [ELSE] / [ENDIF]`、`[IF_DEBUG]`、`[IF_NDEBUG]` | `[IF <宏>]` / `[ELSEIF <宏>]` 落入 `matchRuleTag`（整行方括号且内容非纯大写 ASCII）⇒ 误报 `rule-pool-branch-outside-pool`；其余四枚因内容纯大写被排除在标签外 ⇒ 兜底台词 | `lexer.ts::matchRuleTag`（`^[A-Z0-9_]+$` 排除）+ `parser.ts` 的 ruleTag 分支 |
| **硬** | `{` / `}` 行连接 | 同上；显示层有 `多行语句开始 / 结束`，写层零分支 | `control.ts` 的 `BRACE_NEUTRAL` |
| **硬** | `#FUNCTION` / `#FUNCTIONS` / `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY` | `#` 起手且非 `#DIM` 族 ⇒ 台词 | `DIM_DIRECTIVE_RE` 只收 6 枚 |
| 软 | `DATALIST` / `ENDLIST` / `STRDATA` | 可大写直通；显示有中性形（`分组 原形 …` / `数据表 原形 STRDATA …`），写形未登记 | `control.ts` 的 `DATA_GROUPING_NEUTRAL` |
| 软 | `NOSKIP` / `ENDNOSKIP` | 可大写直通；显示 / 写形都没有 | `CONTROL_SHAPES` 有、显示层无 |
| 软 | `SETBIT` / `CLEARBIT` / `INVERTBIT` | 写形 `设置标记 / 清除标记 / 反转标记`，显示形 `置位 / 清位 / 翻位` | `statement-functions.ts` vs `statement.ts` |
| 软 | `TIMES` / `++` / `--` / `CALLF` | 显示有、写形无；写侧靠原生大写直通 | `statement.ts` 的动词表 |
| 面 | `#` / `[` / `{}` 的着色 / 补全 / 悬停 / 折叠 / 语义 / 缩进 / 诊断 | `.kojo` 词法只严格认 `[SKIPSTART]` / `[SKIPEND]` 两枚；`[IF]` 无分支；糖区行首 / `#` 位 / `[` 位无 ERB 候选（原生区已路由 ERB 册） | `lexer.ts` / `kojo-native-zone.ts` / `kojo-completion.ts` |
| 面 | 206 枚词在 `.kojo` 的补全 / 悬停 | 高亮已派生 `ERB_COMMANDS`；原生区补全已路由 `ERB_COMPLETION_ASSEMBLY`，糖区无；悬停有 ERB 函数 / 位号路，无指令词分类 | `kojo-completion.ts` / `kojo-hover.ts` |
| 面 | 预处理结构诊断 | `.kojo` 无 | `service.ts` |

---

## 2. 档位模型（补充的总规则）

沿用 v1.8 的"写读同形"原则，但把"写不出来"这一类显式分档：

| 档 | 定义 | 面义务 |
| --- | --- | --- |
| **T1 糖形** | 有中文写形，产物可逆，回读必然回到同一写形 | 全 20 面 + 转译 / 回读 / 显示 |
| **T2 中性读形** | 只有显示形（中文名只用于"看懂"），写侧用原生记号 | 显示 / 着色 / 悬停 / 折叠；**不承诺写形** |
| **T3 原生直通** | 整行逐字节透传（大写指令 / `$` / `#DIM` 族） | 着色 / 补全 / 悬停 / 结构诊断；不承诺糖 |
| **T4 排除** | 不承诺语法面，但仍可 T3 直通 | 同 T3，不得静默 |

**硬判据（本稿新增一条）**：任何 ERB 构造在 `.kojo` 里至少要有 T2 / T3 的**可写通路**；只落 T1 才算"对齐"。凡是会兜底成台词、或误诊成别的构造的形态，一律视为缺陷，不得用"作者不该这么写"解释。

---

## 3. P0 · 结构三件（硬缺口）

### 3.1 预处理条件块（`[IF]` 族）

#### 现状（为什么这是硬缺口）

`.kojo` 的 `classifyLine` 在 `[SKIPSTART]` / `[SKIPEND]` 之后才是 `matchRuleTag`，而 `matchRuleTag` 只把**纯全大写 ASCII / 纯数字**的方括号内容排除在规则池标签外：

- `[IF <宏>]` / `[ELSEIF <宏>]` 内容含空格或小写 ⇒ 被认成规则池分支标签 ⇒ 报 `rule-pool-branch-outside-pool`（错诊断，且按"阻止编译"口径不产出半成品 ERB）；
- `[ELSE]` / `[ENDIF]` / `[IF_DEBUG]` / `[IF_NDEBUG]` 内容纯全大写 ⇒ 被排除在标签外 ⇒ 一路兜底成**台词**。

两种都不是"作者写错了"：`.erb` 侧同一批行是合法预处理标记（`ERB_PREPROC_PATTERNS`）。

#### 语法

```kojo
预处理 如果 恋慕开关：
    台词 「……」
预处理 否则如果 嫉妒开关：
    台词 「哼。」
预处理 否则：
    空行
预处理结束
```

调试二形（共用 `预处理结束`，与引擎"三个开块形共用 `[ENDIF]`"同构）：

```kojo
预处理 调试：
    台词 「调试可见」
预处理结束

预处理 非调试：
    台词 「正式版可见」
预处理结束
```

#### 产物

| 表层 | 产物 |
| --- | --- |
| `预处理 如果 <宏>：` | `[IF <宏>]` |
| `预处理 否则如果 <宏>：` | `[ELSEIF <宏>]` |
| `预处理 否则：` | `[ELSE]` |
| `预处理 调试：` | `[IF_DEBUG]` |
| `预处理 非调试：` | `[IF_NDEBUG]` |
| `预处理结束` | `[ENDIF]` |

#### 判据

0. **`预处理` 不是随便吃词**：后随必须是闭集子词（`如果` / `否则如果` / `否则` / `调试` / `非调试`），且形制匹配（块头带全角冒号）。否则按台词处理——与 `试探` 必须带 `原形`、`若` 必须带条件同一判据，防止日常中文"预处理 一下"被误读成指令。
1. `<宏>` 是**一个宏名**（裸标识符，含中文宏名——`structure.ts::macroOf` 的黑表只拒符号 / 空白 / 数字开头；也可以是 `常量` 声明解析出的宏名），不是任意表达式——引擎的预处理只读宏名（`macroArgOf` 对 `IF|ELSEIF` 取出后整词校验，`[IF A B]` 在引擎侧就是写法错误）。写表达式 ⇒ 复用 `statement-shape` / `unknown-identifier`，不新增码。
2. **可嵌套**：`structure.ts::checkPreprocStructure` 用独立栈，嵌套是合法形态；糖块按同样层级展开。
3. **位置自由**：预处理是文件级裁剪，可出现在任何语句位置（含 `时机` 体内）；`@` 原生块内部仍逐字节透传（糖层不进去），块内预处理行不参与糖块配对。
4. **产物必须整行严格等值**：`[IF X]` 后不得带空格以外的任何字符。作者在糖行写行内 `;` 注释时，由结构化行统一的注释剥离吃掉，**不随产物输出**；糖层绝不在标记行尾追加注释。
5. `;!;` / `;#;` 代码前缀**不适用于**糖形预处理行（引擎判的是整行等值，前缀会让标记失效）。需要前缀的写法走原生直通。
6. **原生直通是 T3 通路，且必须排在 `matchRuleTag` 之前**：`[IF …]` / `[IF_DEBUG]` / `[IF_NDEBUG]` / `[ELSEIF …]` / `[ELSE]` / `[ENDIF]` 整行严格等值（判据单源 `ERB_PREPROC_PATTERNS`）⇒ 逐字节透传。否则 `[IF <宏>]` 仍会被规则池标签判定吃掉（§3.1 现状）。糖形与原生直通产出同一字节。

#### 面

| 面 | 口径 |
| --- | --- |
| 转译 | 糖形按上表逐行发射，缩进不参与产物；原生标记行（`[` 位）逐字节透传 |
| 回读 | `[IF X]` … `[ENDIF]` → `预处理 如果 X：` … `预处理结束`；`[IF_DEBUG]` / `[IF_NDEBUG]` 同名回读 |
| 显示 | **新增**：`预处理 如果 X：` / `预处理 否则如果 X：` / `预处理 否则：` / `预处理结束`（今天 `[IF]` 行没有任何糖显示；`#` 声明族另有显示：`声明数组 …` / `声明值函数 …` / `预处理 SFUNCTION …`） |
| 着色 / 语义 | 块头 / 分支 / 收束一律 `keyword.preprocessor` 档（与 `.erb` 同色） |
| 补全 | `预处理 如果 ` / `预处理 否则如果 ` / `预处理 否则：` / `预处理 调试：` / `预处理 非调试：` / `预处理结束` 六枚骨架 |
| 折叠 / 大纲 | 折叠区间；大纲不立节点（预处理不是命名结构） |
| 缩进 / 格式化 | 块头后 +1 级；分支回退再进；收束回退；空行不参与 |
| 诊断 | `unclosed-block`（未收）/ `statement-shape`（分支错位、宏位为空、收束不配）/ `unknown-identifier`（宏名认不出） |
| 预览 | 糖视图显示同一写形 |

### 3.2 行连接块（`{` / `}`）

#### 语法

```kojo
多行语句开始
PRINTFORM 这是一条很长的
    需要拆成多行写的语句
多行语句结束
```

> 块体是**原生逐行**，不能写 `台词 …` 这类糖语句——否则 `台词` 两个字会被原样拼进产物。

**词形直接沿用显示层的 `多行语句开始` / `多行语句结束`**（`control.ts` 的 `MULTILINE_START_W` / `MULTILINE_END_W`），不另造 `续行开始`——写读同形优先于词短。

#### 判据

1. 两枚词**独占一行**（前后只允许缩进）；产物为整行 `{` / `}`，逐字节。
2. **块体是原生逐行**：糖层不解析块体内的糖语句。原因：引擎把块内物理行拼成**一条逻辑行**，块内再出现糖块头会改变行语义。
3. **禁止嵌套**：`多行语句开始` 体内再出现 `多行语句开始` ⇒ `statement-shape`（引擎侧没有嵌套语义）。
4. **不重排缩进**：块体逐行原文透传，格式化器不得改块体缩进（改了就是改产物字节）。
5. 块体里的 `;` 注释按原生直通保留（与 `@` 块同口径），不剥。
6. **原生直通是 T3 通路**：整行恰为 `{` / `}`（判据单源 `ERB_CONTINUATION_MARKERS`，允许行首缩进）⇒ 逐字节透传，先于文本兜底。糖形两枚词与原生记号产出同一字节。

#### 面

| 面 | 口径 |
| --- | --- |
| 转译 | `{` + 块体原行 + `}`；原生 `{` / `}` 行逐字节透传 |
| 回读 | 完整成对的 `{` / `}` → 两枚中文词；块体原样 |
| 显示 | 同写形；块体按原生行显示 |
| 着色 / 语义 | 两枚标记 `keyword.raw` / `keyword`；块体按原生 ERB 着色 |
| 补全 | `多行语句开始` / `多行语句结束` 两枚骨架 |
| 折叠 | 区间折叠 |
| 缩进 / 格式化 | 标记行不缩进块体；**格式化器跳过块体** |
| 诊断 | `unclosed-block`（未收）/ `statement-shape`（嵌套、体内糖块头、标记行带尾注） |
| 预览 | 同写形 |

### 3.3 `#` 声明族直通（闭集，补 8 枚）

`#DIM` 族 6 枚已有直通。显示层还认另外 8 枚文件级声明（`control.ts` 头注列出）：`#FUNCTION` / `#FUNCTIONS` / `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY`。它们在 `.kojo` 里**全部没有写形**——`#` 起手且非 `#DIM` 族 ⇒ 台词。

**最小修法**：原生直通谓词扩成**闭集**，不做 `/^#\w/` 的泛化：

```ts
// 现：/^#(?:DIMSTR|DIMCHAR|DIMF|DIMS|DIM|DEFINE)\s+\S/i
// 增：/^#(?:FUNCTION|FUNCTIONS|GLOBAL|LOCALSIZE|LOCALSSIZE|SFUNCTION|XFUNCTION)\b/i
//     /^#TESTMEMORY\b/i   （无余文，单独一支）
```

- **不拆中文糖**：这 8 枚是文件级 / 返回类型声明，中文写形会诱使作者把它们当"时机块内语句"；保持"作者写原生记号、显示层翻中文"的 T3 形态（与 `#DIM` 族同待遇）。
- 合法性仍归上游：糖层只保证**不吞成台词**；`#GLOBAL` 之类在 `.ERB` 是否合法由 ERB 侧诊断判，糖层不另立口径。
- 面：着色 `keyword.preprocessor`；补全 8 枚 + `#DIM` 族；悬停复用预处理档；不折叠、不大纲。
- 回归钉：改前 8 枚逐行进台词，改后逐行进原生直通行。

> 说明：`#FUNCTION` / `#FUNCTIONS` 是函数返回类型标记（正常在 `@` 行后，`scanner.ts` 也宽容写在 `@` 行前）；其余 6 枚是文件级规模 / 系统函数声明。

---

## 4. P1 · 显示词升写形（软缺口）

原则：**显示层已经写好的中文词，写层直接登记为同字写形**；产物与回读用同一张表，禁止显示 / 写层各拼一份。

### 4.1 数据表分组 / 字符串数据表

| 表层 | 产物 | 说明 |
| --- | --- | --- |
| `分组：` | `DATALIST` | 无名字 |
| `分组结束` | `ENDLIST` | 与 `数据表结束`（`ENDDATA`）区分 |
| `字符串数据表 <名>：` | `STRDATA <名>` | 带名字形态 |
| `字符串数据表：` | `STRDATA` | 裸形（语料 2 例）；与 `PRINTDATA` 走同一条 `renderDataOpen` 通路 |

- `分组` / `分组结束` 是**显示词升写形**：今天显示为 `分组 原形 DATALIST：` / `分组结束 原形 ENDLIST`，升 T1 后去掉 `原形`。
- `字符串数据表` 是**新增词**：今天 `STRDATA` 与 `PRINTDATA` 共用 `数据表` 前缀（`数据表 原形 STRDATA <名>：`），形义混淆；本稿给它独立词形，显示随之改为 `字符串数据表 <名>：` / `字符串数据表：`。
- 缩进 / 折叠 / 大纲：与 `数据表` 块同型；大纲不立节点。

### 4.2 不跳过块

| 表层 | 产物 |
| --- | --- |
| `不跳过：` | `NOSKIP` |
| `不跳过结束` | `ENDNOSKIP` |

- 显示层新增同字两枚（此前没有中文显示形）。
- 缩进 / 折叠 / 诊断与普通块一致。

### 4.3 位原语词形统一

现状：写形 `设置标记 / 清除标记 / 反转标记`，显示形 `置位 / 清位 / 翻位`，同一产物两种叫法。

本稿把显示词登记为**隐藏别名**（不抢主词形）：

| 写形 | 隐藏别名 | 产物 |
| --- | --- | --- |
| `设置标记 X, n` | `置位 X, n` | `SETBIT X, n` |
| `清除标记 X, n` | `清位 X, n` | `CLEARBIT X, n` |
| `反转标记 X, n` | `翻位 X, n` | `INVERTBIT X, n` |

- `获取标记(X, n)` 表达式形不动。
- 颜色语义的 `置位` 与位原语同名不是冲突：`.kojo` 里没有别的 `置位` 词形；若将来冲突，再用 `第 n 位` 限定。

### 4.4 本稿不升 T1 的显示词（有意留 T2）

| 显示词 | 原生写形 | 理由 |
| --- | --- | --- |
| `乘算` | `TIMES` | 原生大写已可写；糖形会与 `增减` 的语感混 |
| `自增` / `自减` | `X++` / `X--` | 自增是表达式级记号，拆成中文词反而丢位置感 |
| `调用F` / `调用形` | `CALLF` / `CALLFORMF` | 与 `调用` 的实参规则不同，单独立词会诱导混用 |
| `赋值`（数据行） | `X = …` | 赋值左值不翻（显示层既有判据），写形就是 ERB 原生赋值 |
| 输出 / 排版族（`清空本行` / `重绘` / `HTML打印` / `强制等待` / `进度条` / `分隔线` / 字体族） | 原生指令 | 台词 / 空行 / 心形已覆盖口上高频；其余低频，糖形只稀释补全 |

---

## 5. P2 · 词表与面接线（对齐已完成 ERB 词表）

### 5.1 206 枚词在 `.kojo` 的对齐口径

| 面 | 今天 | 本稿要求 |
| --- | --- | --- |
| 高亮 | `kojo-language.ts` 已从 `ERB_DIRECTIVES` 派生 `ERB_COMMANDS` | 保持；新增 `#` 声明族 / 预处理 / 括号三类规则 |
| 补全 | 原生区（全大写指令行 / `@` 块）由 `kojo-native-zone.ts` 整轮路由 `ERB_COMPLETION_ASSEMBLY`；糖区行首 / `#` 位 / `[` 位无 ERB 候选 | 糖区行首补全追加 `ERB_DIRECTIVES` 全表；`#` 位追加 `#DIM` 族 6 枚 + 声明族 8 枚；`[` 位追加 `ERB_PREPROC_CANDIDATES` + SKIP 两枚 |
| 悬停 | `kojo-hover.ts` 有 ERB 函数 / 位号路；`kojo-hover-native.ts` 只做中文 → 原生反查，无指令词分类 | 原生词悬停：至少给"这是 ERB 语句 / 预处理 / 族头"分类；**不承诺逐词文档**（当前无文档真源，不新造） |
| 语义着色 | 只有糖 token | 原生直通行发 `keyword.erb` / `keyword.erb.family`；`#` 行发 `keyword.preprocessor` |
| 折叠 | 只有糖块 | 追加预处理块 / 括号块 / 停用区（停用区 `.erb` 已有，`.kojo` 仅着色） |
| 缩进 | 糖块规则 | 预处理块 / 括号块各行一套 enter 规则 |
| 诊断 | 只有糖诊断 | 预处理结构 / 括号成对（复用既有码）；`#` 声明族位置本层不判（归 ERB 侧） |
| 大纲 / 定义 / 引用 / 改名 | 糖符号 | 预处理宏名不立符号；`#` 声明族不立符号；**本稿不扩** |

### 5.2 K5 十一枚（2026-10-25 第三批）

`TONEINPUTS / XML_GET / MAP_SET / GDRAWG / TOOLTIP_SETDELAY / MAP_CREATE / XML_ADDNODE / AWAIT / PRINT_RECT / GETCOLOR / BINPUT`

- **一律 T3 直通，不造中文糖**：它们是系统级指令（XML / Map / 图形 / 气泡 / 按钮输入），不是口上叙事语法；`GETCOLOR` 已有表达式别名 `取当前颜色`，保持。
- 面上只做：高亮（已自动）、补全（P2 接线）、分类悬停（P2）、诊断不新增。

### 5.3 面接线落点

| 面 | 落点 |
| --- | --- |
| 高亮 | `kojo-language.ts`（新增 `#` / `[` / `{}` 规则） |
| 补全 | `kojo-completion.ts` + `kojo-native-zone.ts`（糖区扩展）+ `erb-completion*.ts`（复用 ERB 册） |
| 悬停 | `kojo-hover.ts`（分类档；可选） |
| 折叠 | `kojo-sugar/src/folding.ts` + `kojo-folding.ts` |
| 大纲 | `kojo-sugar/src/document-symbols.ts`（本稿不扩） |
| 语义 | `kojo-sugar/src/semantic-tokens.ts` + `kojo-semantic-tokens.ts` |
| 缩进 / 格式化 | `kojo-sugar/src/enter.ts` + `formatter.ts` + `kojo-format*.ts` |
| 诊断 | `kojo-sugar/src/service.ts` + `kojo-xml-diagnostics`（仅复用码） |
| 预览 / 回读 | `native-display/control.ts` + `lift.ts` + `preview.ts` |

---

## 6. 应用面矩阵

### 6.1 面全集

口径 = `language-capabilities.ts` 的 **20 项**（folding / outline / format / semantic / indent / brackets / refs / rename / signature / inlay / codelens / implementation / highlight / selection / callhierarchy / completion / hover / definition / diagnostics / preview）+ v1 专属 **3 面**（转译 / 回读 / 糖视图）。

### 6.2 面型

| 型 | 适用构造 | 自动获得的面 | 必须手工接的面 |
| --- | --- | --- | --- |
| **S1 块** | 预处理块 / 括号块 / 分组 / 不跳过 | 转译、回读、折叠、缩进、语义、高亮、补全、诊断、预览 | 大纲（不立）、悬停（分类）、括号（可选）、扩选（可选） |
| **S2 单行** | 位别名 | 转译、回读、语义、高亮、补全、悬停（分类）、诊断 | 无 |
| **S3 直通** | `#` 声明族 8 枚、K5 十一枚、原生指令 | 转译、高亮、补全、语义 | 折叠（不）、大纲（不）、回读（原样） |
| **S4 表达式** | 既有别名 / 位名 | 全部既有面 | 本稿不扩 |

### 6.3 构造 × 面矩阵

| 构造 | 转译 | 回读 | 显示 | 折叠 | 大纲 | 格式 / 缩进 | 语义 | 高亮 | 补全 | 悬停 | 诊断 | 引用 / 改名 | 签名 / 行内 / 行上 | 预览 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 预处理块 | 新增 | 新增 | 新增 | 新增 | 不立 | 新增 | 新增 | 新增 | 新增 | 分类 | 复用码 | 不适用 | 不适用 | 新增 |
| 多行语句括号 | 新增 | 新增 | 升写形 | 新增 | 不立 | **跳过块体** | 新增 | 新增 | 新增 | 分类 | 复用码 | 不适用 | 不适用 | 新增 |
| 分组 / 字符串数据表 | 新增 | 新增 | 升写形 / 新增词 | 继承 | 不立 | 继承 | 新增 | 新增 | 新增 | 分类 | 复用码 | 不适用 | 不适用 | 新增 |
| 不跳过 | 新增 | 新增 | 新增 | 继承 | 不立 | 继承 | 新增 | 新增 | 新增 | 分类 | 复用码 | 不适用 | 不适用 | 新增 |
| 位别名 | 新增 | 新增 | 已有 | 不适用 | 不适用 | 不适用 | 新增 | 新增 | 新增 | 分类 | 已有 | 不适用 | 不适用 | 已有 |
| `#` 声明族直通（8 枚） | 修复 | 原样 | 已有 | 不适用 | 不立 | 已有 | 新增 | 新增 | 新增 | 分类 | 不判 | 不适用 | 不适用 | 已有 |
| K5 十一枚 | 已有 | 原样 | 原样 | 不适用 | 不立 | 已有 | 已有 | 已有 | 新增 | 分类 | 不新增 | 不适用 | 不适用 | 已有 |

> "复用码" = 不新增 `SugarDiagnosticCode`，用 `unclosed-block` / `statement-shape` / `unknown-identifier` 三枚既有码，消息文本按构造写清。

---

## 7. 诊断码

**本稿新增 0 枚**（`SugarDiagnosticCode` 闭集不动）。

| 场景 | 复用码 | 严重度 | 消息要点 |
| --- | --- | --- | --- |
| 预处理块未收 / 括号块未收 / 分组未收 | `unclosed-block` | error | 指出开块行，要求补 `预处理结束` / `多行语句结束` / `分组结束` |
| `预处理` 分支错位、`<宏>` 空、收束不配 | `statement-shape` | error | 指明该位置合法的三种分支 |
| 括号块嵌套 / 体内糖块头 / 标记行带尾注 | `statement-shape` | error | 括号体内只允许原生逐行 |
| 宏名 / 别名认不出 | `unknown-identifier` | error | 同既有消息 |
| `#` 声明族出现在非法位置 | 本层不判 | — | 直通行原样透传，位置合法性归 ERB 侧结构诊断；糖层不另立口径 |

---

## 8. 兼容性与验收

### 8.1 兼容

- 新增语法全部 **additive**：现有 `.kojo` 文件不含这些词形者，产物逐字节不变。
- **行为变更（均为修复，且只触及今天本来就编译不出正确产物的行）**：
  - 顶层 `#` 声明族 8 枚（含 `#FUNCTION` / `#FUNCTIONS`）从"台词"变为"原生直通"；
  - `[IF <宏>]` / `[ELSEIF <宏>]` 从"误报规则池标签"变为"预处理块头"；
  - `[ELSE]` / `[ENDIF]` / `[IF_DEBUG]` / `[IF_NDEBUG]` 从"台词"变为预处理分支 / 收束。
  现有文件若真写了这些行，原本就是错编译，修复不视为破坏。
- **显示文本变更**：`分组` / `分组结束` / `多行语句` 去掉 `原形` 回显；`STRDATA` 由 `数据表 原形 STRDATA …` 改为 `字符串数据表 …`；预处理块新增显示。只影响糖视图快照，不影响转译 golden。
- `KEYWORDS` 新增词形必须同步发版覆盖率样例（每个中文词形至少真写一次）。

### 8.2 验收门槛

```bash
pnpm test
pnpm typecheck
pnpm --filter @kojo/app typecheck
pnpm audit:decoupling
# 改 Rust 才跑：node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
# 语料在位时：
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts
```

**DoD**：
1. 新增构造逐条有转译 fixture + 回读 fixture + golden 不变证明；
2. 显示快照变更只含本稿点名的四处（`分组` / `分组结束` / `多行语句` / `STRDATA`）；预处理块显示为新增快照，不改既有快照；
3. 20 面矩阵逐行有测试取证（或明确 `exempt` 理由）；
4. 覆盖率闸绿；`#` 声明族直通有回归钉（改前是台词）；
5. 双 typecheck + 审计 ✅。

---

## 9. 分批实施

| 批 | 内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| **P0-A** | `#` 声明族 8 枚直通谓词 + 回归钉 | 无 | 最低；先修静默错编译 |
| **P0-B** | 多行语句括号（糖词 + 原生 `{` / `}` 直通 + 块 + 回读 + 折叠 / 缩进 / 诊断） | 无 | 中；块体原生透传与格式化冲突 |
| **P0-C** | 预处理条件块（糖词 + 原生 `[` 位直通先于 `matchRuleTag` + 块 + 回读 + 折叠 / 缩进 / 诊断 / 宏名解析） | P0-B 的块骨架 | 中；严格等值产物 |
| **P1-A** | 分组 / 字符串数据表写形 + 显示去 `原形` | P0 的块骨架 | 低 |
| **P1-B** | 不跳过块 + 位原语别名 | 无 | 低 |
| **P2-A** | `.kojo` 高亮 / 补全 / 语义 / 折叠接线（206 词 + 预处理候选） | P0/P1 | 中；补全噪声（按前缀过滤） |
| **P2-B** | 悬停分类、诊断落点、预览 / 回读收口 | P2-A | 低 |

---

## 附录 A · 新增词形总表

| 词形 | 类型 | 产物 | 档 |
| --- | --- | --- | --- |
| `预处理` | 复合块头前缀 | `[IF …]` / `[IF_DEBUG]` / `[IF_NDEBUG]` | T1 |
| `预处理结束` | 块收束 | `[ENDIF]` | T1 |
| `多行语句开始` | 块开 | `{` | T1 |
| `多行语句结束` | 块收 | `}` | T1 |
| `分组` | 块开 | `DATALIST` | T1 |
| `分组结束` | 块收 | `ENDLIST` | T1 |
| `字符串数据表` | 块开（可带名） | `STRDATA [名]` | T1 |
| `不跳过` | 块开 | `NOSKIP` | T1 |
| `不跳过结束` | 块收 | `ENDNOSKIP` | T1 |
| `置位` / `清位` / `翻位` | 隐藏别名 | `SETBIT` / `CLEARBIT` / `INVERTBIT` | T1 别名 |
| `#FUNCTION` / `#FUNCTIONS` / `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY` | 原生记号（不新增中文词） | 同字 | T3 |

> 位置式子词（`如果` / `否则如果` / `否则` / `调试` / `非调试`）复用既有词形，不重复登记。

## 附录 B · 与 v1.8 的差异

| 项 | v1.8 | v1.9 草案 |
| --- | --- | --- |
| 预处理块 | `.erb` 有，`.kojo` 无写形（`[IF <宏>]` 误报标签、其余台词） | 新增 `预处理 …：` 块 + 原生 `[` 位直通 |
| 行连接 | 显示层有 `多行语句开始 / 结束`，写层无（原生 `{` / `}` 走台词） | 升为 T1 写形 + 原生记号直通 |
| 分组 / STRDATA | 显示层有词、写层无 | 升为 T1 写形 |
| 位原语 | 写读不同形 | 显示词登记为隐藏别名 |
| `#` 声明族 | 仅 `#DIM` 族 6 枚直通；其余 8 枚会变台词 | 闭集直通（仍不造糖形） |
| 诊断码 | 闭集 | **不增**（复用三枚） |
| golden | 逐字节 | 逐字节不变（仅显示快照四处） |

## 附录 C · 不做清单与理由

| 不做 | 理由 |
| --- | --- |
| `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY` 的**中文糖形** | 只做闭集直通（§3.3）；当前 `erb-parser` 无语义建模，不造中文词、不猜作用域 |
| K5 十一枚中文糖 | 系统级指令；口上叙事不用；T3 已可写 |
| `乘算` / `自增` / `自减` / `调用F` 糖形 | 原生大写 / `++` 已可写；糖形与既有语感混 |
| 存档 / 读档 / 角色 / 数组家族糖 | 已在 206 词表内、T3 可写；它们是系统面而非叙事面，糖形取舍留给单批（不以"完整"为名一次收完） |
| 图形 / 声音 / 背景 / 精灵 / HTML / XML / Map / Tooltip 糖 | T4；系统级 |
| 小写 / 混合大小写原生指令直通 | v1.8 既有口径：原生直通行须**全大写**（`RAW_INSTR_RE`）；本稿不改——小写 `call` / `return` 已是糖别名，放开大小写会与糖词边界冲突。需要原生写形时按大写写 |
| `.ERH` 三形 | `.kojo` 目标是 `.ERB`，不做 `.ERH` 载体 |
| 预处理宏名的定义 / 引用 / 改名 | 宏跨文件，`.kojo` 单文件解析不出全图；本稿不扩 |
| 在糖形预处理行使用 `;!;` / `;#;` | 引擎整行严格等值；前缀会失效 |

## 附录 D · 取证命令

```bash
# 真源规模
rg -n "ERB_CONTROL_STATEMENTS|ERB_PREPROC_PATTERNS|ERB_CONTINUATION_MARKERS" packages/plugin-api/src/erb.ts
rg -n "RAW_INSTR_RE|DIM_DIRECTIVE_RE|classifyLine" packages/plugins/kojo-sugar/src/{lexer,keywords}.ts
rg -n "DATA_GROUPING_NEUTRAL|MULTILINE_START_W|TRY_NEUTRAL_OPEN" packages/plugins/kojo-sugar/src/native-display/control.ts

# 现状回归：以下四行今天在 .kojo 里都与预期不符
#   #FUNCTION 测试(形参)   ⇒ 兜底为台词
#   [IF 某个宏]            ⇒ 误报 rule-pool-branch-outside-pool（标签判定 `^[A-Z0-9_]+$` 把非纯大写内容放进来）
#   [ENDIF]                ⇒ 兜底为台词（内容纯大写 → 被排除在标签外）
#   {                      ⇒ 兜底为台词
# 与 `@` 原生块内的同形对照：`@` 块内四行本来就逐字节透传 ⇒ 缺口只在糖层。
```
