# 实施记录（v0.2 批次日志）

> 自 `ARCHITECTURE.md` §5.8–§5.19 迁移（2026-10-10，审阅 D12）。批次实施细节、金样本发现、踩坑记录在此追加；ARCHITECTURE 仅保留设计决策与接口契约。

---

### 5.8 约定校验器与索引所有权（v0.2 实施记录）

**索引所有权收敛到解析器**（落实 §5.7 的"响应式而非中心式流水线"）：

- `erb-parser` 订阅 `project.opened` → 自动 `buildIndex` → 缓存 → 发 `kojo.functionChanged`；`project.closed` 清空。
- 服务扩展：`ErbParserService.currentIndex(): ErbIndex | null`、`ensureIndex(): Promise<ErbIndex>`（与在途构建共享；无项目时显式报错）。
- 宿主（app）不再自己建索引，只订阅事件同步展示——消除了"每个消费者各建一次索引"的重复。

**约定校验器（`convention.linter`）——三层分离**：

| 层  | 归属                                  | 内容                                                                                                                                              |
| -- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约 | `plugin-api/conventions.ts`         | `ConventionRule{id,severity,description,source,check?}`、`ConventionIssue`、`ConventionCheckContext`、`ConventionReport`、`ConventionLinterService` |
| 引擎 | 插件 `convention-linter`              | 装配规则 → 顺序执行 → 去重/排序/汇总 → 广播；**单规则抛错进入 `failedRules`，绝不静默**；一次运行内 `readFile` 记忆化                                                                 |
| 规则 | 引擎内置（通用）+ `adapter.conventions`（游戏） | 通用：函数重名（零游戏知识）；游戏：KX 残留 / 四件套 / FORM 三连符号 / MESSAGECHECK 结构                                                                                     |


- **运行上下文零游戏知识**：只暴露 `project / index / readFile / log`；游戏规则住在 adapter 包内、自带私有工具，不经上下文下发游戏常量。
- **适配器规则按 `project.adapterId` 精确匹配**（多适配器共存天然正确，复用 ADR-0002 的槽位查询通道）。
- **自动运行**：订阅 `kojo.functionChanged` 串行调度；面板另可手动重跑。

**通用导航事件 `editor.revealLocation`**（内核事件表新增，游戏无关）：

- 语义："打开某文件并定位到某行"的**意图**；由宿主（编辑器壳）消费。
- 发起方可为任意插件（校验面板点击问题、函数树点击函数、未来引用跳转），彼此不感知——避免 UI 插件反向依赖 app 壳。

**规则误报治理原则（实战教训）**：FORM 三连符号规则初版对全部 5 个符号逐行报错，实测 239 条中大量是**有意**用法（`+++` 在 43 个文件里作为 CALLNAME:MASTER 的正文占位）。按"宁可漏报不可误报"收窄为：**排除 `+++`**、**每文件每符号聚合为一条**（含出现次数 + 首次行号）→ 239 → 8 条真实事故。规则实现前必须回引擎源码核验语义（`LexicalAnalyzer.cs:1207` + `CharStream.TripleSymbol():158` + `StrForm.cs:65`）。

### 5.9 条件谓词抽取（v0.2 第三批实施记录）

**目的**：把 20 万 IF / 4.5 万 SELECTCASE 背后的"状态依赖"结构化，服务导航徽章 / 条件矩阵（v1.x）/ 快照回放（v1.0）。

**三层分离（"一切皆插件"的又一次落地）**：

| 层    | 归属                                                       | 内容                                                                                                                                                                                    |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构骨架 | `plugin-api/erb.ts` 契约 + `erb-parser`（`scanControlFlow`） | 线性 `ControlFlowStatement[]`：kind / 条件原文 / 块深度 / 行号；配对表以引擎 `FunctionIdentifier.cs funcMatch` 为准（IF→ENDIF / REPEAT→REND / TRY系→CATCH→ENDCATCH / PRINTDATA→ENDDATA…）；宽容：孤儿闭合向栈内查最近匹配，不中断 |
| 谓词化  | `plugin-api/conditions.ts` 契约 + `condition-extractor` 插件 | ERB 表达式子集 → AST（Pratt，优先级以 `OperatorCode.cs` 为准：`* / %`(90)…`&& \|\|`(40)）；**包容降级**：无法解析片段为 `opaque`，绝不抛错；CASE 展开（`==值` / `IS >= n` / `a TO b` / 逗号列表）                                |
| 语义标注 | `eratw-adapter`（`variableSchema`）                        | **CSV 驱动**：扫描游戏 `CSV/*.csv` 名称表（CFLAG/Talent/ABL/Base…）建"编号↔名称"双向字典；引擎经槽位查询 `project.adapterId` 精确匹配后**透传标注**，不解释内容                                                                   |

- **服务** `condition.extractor`：`ensureIndex()`（全量，与在途共享）/ `currentIndex()` / `functionConditions(name)` / `subscribe(cb)`；订阅 `kojo.functionChanged` 串行调度（convention-linter 同款）；项目关闭清空。
- **聚合模型**：函数级 `StateDependency`（key / count / 阈值比较 / firstLine / schema 标签）——不存全量谓词对象（真实数据 49 万谓词，必须聚合控制内存）。
- **语言级局部量排除**（通用知识，非游戏知识）：`LOCAL/LOCALS/LOCALSS/ARG/ARGS/RESULT/RESULTS/COUNT` 系不构成"状态依赖"。
- **真实工程实测（2026-10-10）**：95,504 函数 / 493,712 谓词 / 未解析 **0.04%**（补 `[[词]]`/括号索引后；此前 0.69%）/ 含依赖函数 31,609 / 依赖条目 164,910 / schema 标注 109,742（恋慕 17,993 / 好感度 480）/ 全量耗时 ~6.2s。变量字典 33 张名称表。
- **“先测量再定语义”**（与 §5.8 同源的教训）：解析器初版 dump 真实 opaque 样本发现两大系统性缺口——`[[词]]`（引擎 rename 语法，读取期按 `_Rename.csv` 替换；编辑器保留原文）与**括号索引段**（`YOGORE:(GET_CHARAHOME(TARGET))`）——补齐后引擎侧未解析谓词 3,383 → 187（剩余为个例形态，保持 opaque 降级不猜测）。

### 5.10 存档快照源（v0.2 第四批实施记录：sav-parser 先行）

**目的**：v1.0 快照回放的**读侧地基**——把引擎二进制存档（"1808" 格式）解码为结构化模型，并响应式扫描项目存档目录。真实六档字节级回归零残余；与逆向阶段 CJS 解析器逐字段对拍一致（16,000 变量/档、cells 抽样 3 万+、六档全部 ✅）。

**分层（"一切皆插件"）**：

| 层  | 归属                                 | 内容                                                                                                                                                    |
| -- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约 | `plugin-api/snapshot.ts`           | `SnapshotArchive`（元数据 + 角色区 + 变量区 + 扩展区）/ 变量模型（标量 / 稀疏数组 / Map / Xml / DataTable）/ 扫描结果 / `SnapshotSourceService`（scan / current / parse / subscribe） |
| 引擎 | `sav-parser` 插件                    | 字节原语（7-bit **字节数**前缀字符串 / 整数编码）、六种数组游程解码、顶层 / 角色块 / 变量流 / 扩展区解析、gzip 解压（`DecompressionStream`，跨 Node / WebView 一致）                                    |
| 来源 | game adapter（`GameProject.savDir`） | 存档目录由适配器填充；项目无该字段 → 扫描得空结果（显式呈现，不报错）                                                                                                                  |

- **服务键命名决策**：早期草拟 `sav.parser`，落地为 **`snapshot.source`**——解耦审计 A 项要求"契约层零游戏 / 格式名词"（裸 `sav` 词在黑名单内），且该服务的通用语义是"快照来源"（§5.3 三来源：存档 / CliDebug / 手工），读存档只是首个实现。插件目录名 `sav-parser` 保留（插件层不受审计词汇限制）。
- **纯读先行**：写 / 注入（§5.5 状态注入器）随 v1.1 扩展；本轮不落任何写路径，游戏目录再次全只读。
- **真实六档实测（2026-10-10）**：168 角色 × 6 档 / 每档 16,005 变量（save00 为 16,000）/ `#DIM` 恒 65 / MASTERNAME 7/168 / RANDDATA（saveLen 625；save00 nonEmpty=0 全零剪枝实证，save01+ 全量）/ MONEY 51 亿（Int64 路径）/ EM 区 2 张 DT 表；扫描 6 档 27ms。
- **稳健性**：单档失败进条目 `error`（不中断扫描）；Int64 超安全整数范围记 `warnings`（不静默）；残余字节 `remaining` 显式呈现（六档全 0）；代际保护（项目切换作废在途扫描，与 condition-extractor 同款）。
- **内存控制**：数组变量支持 `keepArrayCells`（省略）/ `maxCellsPerArray`（截断）——49 万级 cell 的归档必须给消费者截断开关；`cursor` / `nonEmpty` 在省略时仍完整准确。
- **测试**：58 项单测（合成字节 round-trip 覆盖全变量类型 + 错误路径 + 插件编排）；集成冒烟新增六档断言（元数据 / #DIM 分隔 / MASTERNAME / RANDDATA / MONEY / EM 表 / 零残余）；与逆向 CJS 解析器的逐字段交叉对拍为一次性验证（不引外部依赖进测试链）。

### 5.11 状态回放（v0.2 第五批实施记录：state-replay 引擎先行）

**目的**：架构 §5.3「近似回放」的求值侧落地——把口上函数中的条件谓词在**快照状态**上求值，输出"该状态下每条谓词是否成立"与函数级置信度。**不做完整 EraBasic 解释器**：能力边界全部降级为显式 `unknown`（附原因分类），这是"输入任意快照、毫秒级回答"这一产品定位的必然取舍。

**分层（"一切皆插件"）**：

| 层    | 归属                                             | 内容                                                                                                                                                 |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约   | `plugin-api/replay.ts`                         | `ReplayStateView`（状态视图）/ `ReplayValue`、`ReplayOutcome`（三值）/ `ReplayUnknown`（原因分类）/ `FunctionReplay` / `StateReplayService`（服务键 **`state.replay`**） |
| 引擎   | `state-replay` 插件（第 9 个插件）                     | Emuera **变量寻址语义**（TARGET 补位 / 稀疏数组取值 / 指针读取）+ **三值求值器**（Kleene 逻辑）+ 编排。零游戏知识                                                                       |
| 谓词明细 | `condition.extractor` 扩展（`functionPredicates`） | 按需重解析单函数（读文件 → `scanControlFlow` → 逐条 AST），**不入全量索引**——49 万谓词常驻内存不划算；文件文本缓存与明细缓存同生命周期（索引重建即失效）                                                     |
| 存档模型 | `snapshot.source`（sav-parser）                  | 视图创建时深解析档案（默认保留全部 cells——求值需要精确值）                                                                                                                  |
| 语义字典 | game adapter `variableSchema`                  | 具名索引转编号（`TALENT:恋慕` → 3）。契约扩展 `VariableInfo.resolvedIndex`（引擎关键字字典语义）                                                                              |

- **变量寻址语义（引擎语言层，跨游戏一致；依据 `VariableParser.cs`）**：角色 1D 数组 `X:i` ≡ `X[TARGET,i]`、`X` ≡ `X[TARGET,0]`（:112-116）；全局 1D `X` ≡ `X:0`（:157-163）；TARGET = 被回放角色的注册号（块序），MASTER/ASSI/PLAYER = 快照顶层指针值；`#DIM` 用户变量**数据驱动**识别（存在性 + 维度从存档变量类型推断）。
- **取值边界（不静默）**：稀疏 cells 缺失 = 0/''（引擎读档 reset 语义）；索引越界 / 单元截断 / 变量既不在快照也不在引擎清单 → `unknown` 且原因分类明确（`index-oob` / `truncated` / `missing-var`）。
- **三值求值（Kleene）设计理由**：置信度直接来自"未知能否被确定子式消解"——`false && unknown = false`（确定假）、`true || unknown = true`（确定真）；逻辑运算全确定时输出 0/1。未知来源分类：`opaque`（未解析）/ `call`（函数调用）/ `rename`（`[[词]]`）/ `pseudo`（伪变量与语言局部量）/ `dynamic-index` / `named-index` / `type` / `divide-by-zero` / `string-compare` / `non-numeric` 等。
- **64 位语义对齐**：整数除法截断（C# long 语义，非 floor）；位运算经 BigInt（JS 位运算符 32 位会截断——`1 << 40` 的正确值是 2^40，必须绕开）；字符串仅 `== / !=`（Ordinal），序比较不支持 → `unknown`。
- **拒绝语义**：`createView` 失败（档案解析失败 / 角色不在快照）**抛错**（显式）；`replayFunction` 函数不存在 → `null`；绝不伪造空结果。
- **真实回归（2026-10-10）**：save03 × 古明地觉（K49）全量回放 1,356 个含谓词函数 / 11,685 谓词：命中 773 / 未命中 3,561 / 未知 7,351；置信度 exact 230 / partial 755 / unknown 371。**未知主要来源 = 语言局部量 `ARG:*`/`ARGS`**（口上路由协议的高频形态）——回放没有"调用上下文"，这是诚实的能力边界；消解它需要 adapter 提供口上调用协议（游戏知识），列为 v1.0 收口项。
- **测试**：62 项单测（三值逻辑 Kleene / 变量寻址全类别 / 错误路径 / 编排）+ condition-extractor 明细 API 4 项 + 集成冒烟新增回放断言（真实角色 × 真实函数 × 真实快照）。

### 5.12 回放求值器扩展（v0.2 第六批实施记录：本地量数据流 + 内置函数 + 调用上下文）

**目的**：把 §5.11 回放的最大未知来源逐类消解。**先测量再动手**（§5.9 教训再次应验）：对 save03 × K49 的 7,351 个未知谓词做构成分析，发现第五批"主因 = `ARG:*`"的假设**不成立**——真实构成：

| 未知原因（第五批口径）                    | 谓词数    | 占比  | 消解手段（第六批）                                                  |
| ------------------------------ | ------ | --- | ---------------------------------------------------------- |
| pseudo（**LOCAL 系为主** + RAND）   | 4,439  | 60% | **本地量数据流**（LOCAL 族 ≈ 2,150；RAND 属诚实边界保留）                   |
| call（引擎 / 游戏函数调用）              | 2,485  | 34% | **内置纯函数子集**（直接 ≈ 400）；游戏助手函数（陷落状态 / FIRSTTIME…）→ 未来"纯函数内联" |
| ARG/ARGS（调用上下文缺失）              | ≈1,005 | 14% | **调用上下文注入**（默认仍 unknown——转发值是场景输入，不猜测）                     |
| named-index / missing-var / 其他 | ≈430   | 6%  | 本批不动                                                       |

实测教训：批五把 `ARG:*` 判定为主因是把"回放无调用上下文"当成了第一未知源，而真实语料中 **LOCAL 族（`LOCAL:1 && ARG == n` 形态）才是大头**——口上作者大量使用"直线赋值的局部开关"。假设必须让位于测量。

**三层改动（"一切皆插件"）**：

| 层  | 归属                                       | 内容                                                                                                                                                                                                                    |
| -- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约 | `plugin-api/conditions.ts` + `replay.ts` | `FunctionAssignment`（本地量赋值结构事实）+ `FunctionPredicates.assignments` + `FunctionPredicate.context`（分支上下文路径）；`ReplayCallContext` / `ReplayFunctionOptions` + 三个新 unknown 码（`local-no-write` / `call-context` / `builtin`） |
| 抽取 | `condition-extractor` 插件                 | `buildContextLookup`（语句序列 → 段栈 → 行级分支上下文）+ `collectAssignments`（直线赋值收集：裸名 ≡ 0 号下标、`==` 不误匹配、`+=` 等复合赋值记为 opaque 失效点、注释 / `@#$` / SKIP 块跳过）；**仅明细路径收集**（聚合路径零开销）                                                       |
| 求值 | `state-replay` 插件                        | `locals.ts` 叠加层（数据流 + 调用上下文；视图之上、只读）+ `builtins.ts`（8 个纯函数）；`evaluate.ts` 的 call 分支先查内置表                                                                                                                              |

**本地量数据流语义**（引擎依据：`ConvertArg` / `IntoFunction`，Process.CalledFunction.cs:162-239 + Process.State.cs:495-515）：

- 引擎事实：签名声明的参数槽在调用时**必有值**（实参或默认 0/''）；LOCAL/ARG 在函数调用间持久、读档时重置——回放取"函数自顶部直线执行至该行"的近似。
- **可达性规则**：赋值 A 对使用点 U 可得 ⇔ `A.context` 是 `U.context` 的**前缀**（段路径同源或为祖先）——兄弟分支互不可达（THEN 的赋值吃不进 ELSE 的使用点）、闭合块外的使用点不吃块内赋值。段栈折叠与 erb-parser `scanControlFlow` 的配对表逐条同源。
- **取值**：last-write-wins（行序最后一个可达赋值）；RHS 递归求值（可引用更早的本地量 / 视图变量 / 内置函数），带 `(槽位@行)` 记忆化。
- **已知近似（显式记录，不静默）**：if/else 两侧对同槽位赋值 + 使用点在另一分支 → 可能吃到对方分支的值（段 span 不区分分支子段；真实语料罕见，方向为"宁少勿错"由前缀规则兜住大多数）；FOR 循环变量不建模（循环内读取 → `local-no-write`，语义上本就是多值）；`+=` 复合赋值 = 失效点（旧值不可知 → unknown）。

**内置纯函数子集**（`Creator.Method.cs` 逐条对齐，类名行号注明）：GETBIT(:3706，BigInt 移位、越界 0-63 → unknown)/ GROUPMATCH(:3454，计数语义、类型混合拒绝)/ MAX·MIN(:3024)/ ABS(:3082，Int64.MinValue 拒绝)/ SIGN(:3232)/ LIMIT(:3248，先 min 后 max 顺序即语义)/ POWER(:3100，截断 long、NaN/无穷/越界拒绝)。**明确不收录**：数组区间族（SUMARRAY/MATCH/FINDELEMENT——单点读取原语无数组长度语义）、关键字字典族（GETNUM——等 adapter schema 通道）、字符串形态族（TOSTR 带格式/TOINT 全角判定）、RAND（运行期计算值）。

**调用上下文**：`ReplayCallContext{ints, strs}`（槽 0 起；裸 `ARG` ≡ `ARG:0`，1D 裸引用 = 0 号下标的引擎语义）；未提供 / 未覆盖槽位 → unknown('call-context')，**不猜测 0**——转发自路由层的值（约会对象编号等）是场景输入。adapter 的"口上调用协议"（家族 → 转发实参映射，来自 KOJO_MESSAGE.ERB 路由表）为后续 UI 场景选择器的地基，本批未落（默认流收益实测 ≈ 0，见下）。

**真实回归（2026-10-10）**：save03 × K49 全量 1,356 函数 / 11,685 谓词——命中 773→**1,522** / 未命中 3,561→**4,495** / 未知 7,351→**5,668**（**62.9%→48.5%**）；置信度 exact 230→**786** / partial 755→500 / 全未知函数 371→**70**。第六批后构成：call 2,297（游戏助手函数为主）/ pseudo 1,886（RAND 等）/ call-context 858 / named-index 335 / local-no-write 196 / 其余 <100。下一杠杆 = **纯函数内联求值**（陷落状态 1,803 + FIRSTTIME 450 ≈ 2,500 谓词，依赖本批的赋值/语句/内置函数地基）。

### 5.13 有界内联求值（v0.2 第七批实施记录：用户函数顺序解释）

**目的**：消解 §5.12 回放的最大未知来源 `call` 桶。**先测量再动手**（§5.9 教训第四次应验）：对 save03 × K49 的 call unknown 做**被调函数形态分析**（临时 dump 测试，跑完即删），发现与批六预估**大相径庭**——

| 事实（实测 2026-10-10）                                    | 数据                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| call 谓词覆盖的被调函数名                                  | 26 名 / 2,805 条谓词                                      |
| **有定义且在口上索引域内**                                 | **3 名 / 1,991 条（71%）**——`陷落状态`×1830 + `关系_310`×160 + `陥落状態`×1 |
| 定义在口上索引域外（COMMON.ERB 等 kojoPaths 之外）         | 23 名 / 814 条（29%）——FIRSTTIME（写 CSTR 副作用）/ GET_TARGETNUM / 素質計算… |
| 可内联函数的体形态                                         | 100% 为 IF/ELSEIF/SIF/RETURNF + **ARG 补位赋值**（`SIF !ARG / ARG = TARGET`） |

测量纠正了两个预判：①HANDOFF 批六预估的"陷落状态 1,803 + FIRSTTIME 450"中，**FIRSTTIME 其实不在索引域**（也不可内联——副作用）；②唯一拦住"陷落状态"的不是复杂语句，而是 **ARG 参数槽直线赋值**不在批六的收集名单（LOCAL 族）里。

**三层改动（"一切皆插件"）**：

| 层    | 归属                                       | 内容                                                                                                                                                                                            |
| ----- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约  | `plugin-api/conditions.ts`                 | `FunctionAssignment.name` 扩展 `'ARG'\|'ARGS'`（参数槽直线赋值是结构事实；**静态叠加层不消费**——ARG 读取仍走调用上下文注入优先，只有内联解释器按顺序语义消费）；`FunctionPredicates` +`endLine` / `returns: FunctionReturn[]`（内联需要行区间与返回点 AST） |
| 抽取  | `condition-extractor`                      | `ASSIGN_RE` 扩 ARG/ARGS；`collectReturns`（RETURNF 收集）；明细路径产出 endLine / returns（聚合路径零开销）                                                                                      |
| 求值  | `state-replay`                             | `inline.ts`（**预编译 + PC 顺序解释器**）+ `evaluate.ts` 求值通道重构（`EvalContext{read, resolveCall}`）；`engine.ts` 集成 `InlineManager`（analyze 缓存 + preanalyze 预热）；`index.ts` 增依赖 `kernel.io` |

**内联解释器语义**（引擎依据：`Process.GetValue`（Process.cs:407-437）+ `ReturnF`（Process.State.cs:540-563）+ `BuiltInFunctionCode.cs:103-104`）：

- **触发**：被调函数在口上索引域内 + 明细可得 + `#FUNCTION` 头 + 体语句全为可解释形态（IF/ELSEIF/ELSE/ENDIF/SIF/RETURNF/直线赋值）。任一不满足 → reject（`log.warn` 记录原因）→ 调用回落 `unknown('call')`。
- **顺序解释而非静态数据流**：参数补位赋值在 SIF 条件为真时才生效——静态"前缀可达 + last-write-wins"会算错（非零 ARG 也吃到 `ARG = TARGET`）。PC 逐行：`SIF cond` 真 → 执行下一 op；IF/ELSEIF 链按求值走分支；`RETURNF expr` → 返回。
- **分支双语义消解**（实现中最微妙的坑）：ELSEIF/ELSE 的 op 有两种到达方式——**条件假跳转到达**（需进入：求值 / 进 ELSE 体）与**分支体自然掉落到达**（需跳过：`endAfter`）。PC 无法区分来源 → 编译期把"假跳转到 ELSE"改写为**直接进体**（`elseIdx+1`），运行期用 `pendingEval` 标记区分"跳转到达 ELSEIF（求值）"与"自然掉落（跳 endAfter）"。
- **实参绑定**：调用点实参 AST 在**调用方上下文**求值（外层 overlay / 视图）→ 按声明槽序绑定（`ARG:0..n`）；多余实参 → ARG 后续槽（引擎数组语义）；未提供的声明槽 = **默认 0/''**（`ConvertArg` 语义——与顶层 callContext 的 unknown('call-context') 不冲突：内联的实参在源码里，不是场景输入）。
- **环境读**：本地量族（LOCAL/LOCALS/RESULT/RESULTS/ARG/ARGS）→ 环境查；ARG/ARGS 未命中 = 引擎默认槽值 0/''；LOCAL 族未命中 = `unknown('local-no-write')`。**索引段替换**：`TALENT:ARG:恋人` 的 `ARG` 段 → 环境数值（这是陷落状态的主形态）。
- **拒绝传播**：条件 unknown → 控制流未知 → 整个内联失败（保留内层原因，如 `missing-var`）；RHS unknown → 不写环境；函数尾无 RETURNF → `unknown('call')`（引擎 MethodReturnValue 残留语义，不可信）；`#FUNCTIONS` / `#DIM` / SELECTCASE / 循环 / 复合赋值 / CALL / 标签 → reject。
- **深度界**：8（引擎 100；语料无深递归，保守小界防循环自引用）。
- **缓存与预热**：analyze 结果按函数名缓存（纯静态）；`preanalyze(detail)` 从谓词/赋值/返回的 AST **BFS 收集 call 名递归 analyze**（visited 防环）→ 执行期 `resolveCall` 同步缓存必命中（resolveCall 契约是同步的，预热解决异步矛盾）；`resetCaches()` 在 `project.closed` / `kojo.functionChanged` 时清空（装配层订阅）。
- **插件依赖变化**：state-replay `requires` 增 `kernel.io`（内联需要函数体行文本——此前只需存档与明细）。

**真实回归（2026-10-10，save03 × K49 全量 1,356 函数 / 11,685 谓词）**：命中 1,522→**1,549** / 未命中 4,495→**6,395**（大量原 unknown 判定为假）/ 未知 5,668→**3,741**（**48.5%→32.0%**）；置信度 exact 786→**836** / 全未知函数 70→**38**。call 桶 2,297→**368**（消解 84%，超过测量预估的 71%——嵌套内联递归消解了额外部分）。剩余构成：pseudo 1,886（RAND）/ call-context 858 / call 368（索引域外）/ named-index 337 / local-no-write 196。

**测试**：+26 单测（analyze 拒绝路径 9 项 / 执行语义 11 项 / manager 编排 4 项 / evaluate 集成 2 项）+ ARG 赋值收集 1 项 + 集成冒烟守门 0.55→0.40 + 陷落状态内联专项断言。

### 5.14 状态回放面板（v0.2 第八批实施记录：把回放引擎带上 UI）

**目的**：三批成熟的回放引擎（§5.11–§5.13：三值求值 → 数据流/内置函数 → 有界内联，实测未知率 32.0%）第一次落地 UI——**选档 → 选角色 → 选函数 → 逐条谓词三值结果**。

**分层（"一切皆插件"）**：

| 层     | 归属                                 | 内容                                                                                                                                                                                        |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 呈现   | 新插件 `ui-state-replay`（第 10 个） | `ui.panel` 贡献（React createElement，与 navigator/report 同款）：档案下拉（saveMes 摘要）+ 角色下拉（`project.charaIndex`）+ 函数名输入（条件索引子串提示）+ 调用上下文输入 + 结果渲染 |
| 纯逻辑 | `ui-state-replay/panel-logic.ts`     | 零 React 可单测：调用上下文文本解析（`0=36, 1="约会"` → `ReplayCallContext`）/ 未知原因分组 / 函数名提示过滤                                                                            |
| 服务   | `state.replay` / `snapshot.source` / `condition.extractor` | 消费既有契约，零新服务；视图代际保护（换档/换角色使在途 `createView` 作废）                                                                                             |

**关键设计决策**：

- **调用上下文是场景输入**：ARG/ARGS 槽位文本（`0=36, 1=15`，带引号 → 字符串槽）由用户填写，解析失败红字提示不阻塞输入；空 → 不注入（走 `unknown('call-context')`）。编辑器绝不猜测转发值。
- **回放意图事件 `kojo.replayFunction`**（内核事件表新增，与 `editor.revealLocation` 同款模式）：任意插件可发起"请求解释该函数"，回放面板响应——导航面板函数行的 ⟲ 徽章（阻止冒泡，外层仍是跳转）即首个发起方。UI 插件间零直接依赖。
- **错误显式呈现**：视图建立失败（角色不在档）/ 函数不在条件索引（返回 null）/ 上下文解析失败——全部红字呈现，不静默。
- **未知原因分组**：面板把 unknown 按 code 分组统计（`伪变量 1886`、`调用上下文未提供 858`…）+ 悬停中文提示——能力边界一目了然，这是"近似回放"的产品化表达。
- **性能防线**：函数名提示空查询不刷全量列表（9.5 万名）；谓词渲染上限 300 行；视图按（档 × 角色）惰性重建。

**测试**：+11 单测（上下文解析全路径 / ReplayCallContext 组装 / 未知分组 / 函数名提示）；集成冒烟确认服务链路无回归；audit 10 插件全绿（新插件自动纳入 A/B/C 三项）。

**已知边界（记录不静默）**：桌面壳深度冒烟（`smoke-tauri-dom.mjs`）在沙箱会话因 tauri CLI 的 `BeforeDevCommand` 走 `cmd /S /C` 触发宿主管道耗尽（os error 231）——环境级限制而非项目问题（app vite build 已验证），需在正常终端执行。

### 5.15 分支走向（v0.2 第九批实施记录：从谓词列表到作者视角）

**目的**：回放面板从"逐条谓词真假"升级为"**该状态会走哪个分支**"——作者写的是分支，不是谓词列表。谓词三值结果已经存在于 `FunctionReplay.predicates`，本批只做**折叠**：把谓词按控制流骨架配对成链，输出每条链的走向。

**分层（"一切皆插件"）**：

| 层    | 归属                              | 内容                                                                                                                                                                                              |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约  | `plugin-api/replay.ts`            | `BranchChainOutcome`（kind: `if-chain`/`select-chain`；outcome: `taken`/`no-match`/`unknown`/`unreachable`；members + takenLine + depth）+ `FunctionReplay.branches`                                  |
| 引擎  | `state-replay/branches.ts`        | 纯函数折叠：链栈配对（与 scanner 配对表同源：IF/ELSEIF/ELSE/ENDIF + SELECTCASE/CASE/CASEELSE/ENDSELECT）→ 逐链求值 → 可达性传播；宽容（孤儿分支跳过不抛）                                            |
| 呈现  | `ui-state-replay` 面板            | 结果区顶部"分支走向"区：按 depth 缩进的链行（✓ 命中 / ∅ 落空 / ? 未知 / · 不可达），命中链显示条件原文 + 跳转行号，点击 → `editor.revealLocation`                                                  |

**折叠语义**（引擎语言层，跨游戏一致）：

- **IF 链**：IF → (ELSEIF)* → (ELSE)? → ENDIF；走首个真谓词，全假 → ELSE，全假无 ELSE → `no-match`（落空——口上域少见但合法，作者视角里有用的信号）。
- **SELECTCASE 链**：CASE 谓词由抽取层展开（逗号列表 → 同行多条谓词，**任一为真即命中**——引擎 CASE 语义）；CASEELSE = 兜底。
- **unknown 立即阻断**：链上某成员条件未知时整链走向未知——**后续成员为真也不能救回**（前序未知可能为真），这与 Kleene 逻辑"后续无法救回"同构。前真后未知 → 已 taken（unknown 被短路）。
- **可达性传播（简单版）**：链头若位于某条外层链"未进入分支"的行区间内 → `unreachable`（内层条件即使为真也不会执行——否则会把不可达分支误显示为"命中"，误导作者）。判定 = 最直接外层链（包含链头且深度最小）的命中分支行区间。**已知近似（显式记录）**：循环体内链的多次执行不建模（单遍语义）；unknown 不向内层传播（内层保留自身结果，UI 缩进已表达嵌套）。
- **宽容**：孤儿 ELSEIF / 类型不匹配入栈 / 未闭合链——一律跳过或保留已收成员，绝不抛错（与 scanner 的宽容扫描同韧性）。

**测试**：+14 单测（IF 链三态 / unknown 阻断与短路 / CASE 同行任一真 / CASEELSE / 嵌套可达性四态 / 宽容三例）；集成冒烟新增分支断言（真实数据 `IF LOCAL / ELSEIF…` 链折叠出 taken）；414 项全绿 / audit 10 插件 / app build ✅。

### 5.16 口上调用协议（v0.2 第十批实施记录：路由表 → 槽位语义表）

**目的**：把口上函数参数槽的**来源与含义**显式化——回放面板的调用上下文从裸文本（`0=36, 1=15`）升级为结构化场景参数输入。

**先测量再动手（候选清单的过度承诺被实测纠正）**：dump save03 × K49 的 call-context 构成——引用 ARG 的 K49 函数 ≈200 个（ARG:0×158 / ARG:1×53），谓词形态 `LOCAL:1 && ARG == 1`（子事件选择器）；对照路由源码（`KOJO_MESSAGE.ERB`）确认：口上函数的 `(ARG, ARG:1)` = 路由层 `ARG:3/ARG:4` **透传缓冲 = 纯场景输入，值不可推导**。§6.8 候选清单里"call-context 858 条自动消解"是写清单时想当然——**协议能消解的是"默认场景"子集（全槽 0 是引擎转发链未设置槽的确定事实，非猜测），不是全部**。

**分层（"一切皆插件"）**：

| 层          | 归属                              | 内容                                                                                                                                                                                              |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约        | `plugin-api/game.ts`              | `KojoCallSlot { index, kind: 'int'\|'str', label }` + `KojoCallProtocol.slotsFor(functionName)` + `GameAdapter.kojoCallProtocol?`（游戏知识只住 adapter；可选声明，协议不可用优雅降级）           |
| 适配器      | `eratw-adapter/call-protocol.ts`  | 解析 `KOJO_MESSAGE.ERB` 路由表（`(?:TRY)?CALLFORM M_KOJO…(实参表)`）→ 家族模板正则 + 槽位表；loadProject 时加载（getter 同 variableSchema 模式）；文件缺失 → undefined                            |
| 呈现        | `ui-state-replay` 面板            | 函数名有协议 → 结构化"场景参数"输入区（每槽一个输入框 + `ARG:n` 标签 + 转发来源 tooltip；int 预填 0）；无协议 → 回退裸文本框；回放引擎零改动                                                        |

**路由表解析语义**（源码核验：`KOJO_MESSAGE_SEND` 头注释 + `ConvertArg` 签名槽按序绑定）：

- 模板 → 正则：`%…%`（变量插值：口上名 / 字符串时机）→ `.+`；`{…}`（引擎内嵌表达式）→ 中段 `.+`、**尾部 `\d+`**（数值时机号——函数名后缀为纯数字）。
- **数值/字符串时机消歧**：同家族两个模板（`_{ARG:1}` 2 槽 / `_%ARGS:1%` 3 槽）都可能匹配同一函数名——**数值尾部模板优先**（数值函数名的真实转发结构是 2 槽；字符串后缀名匹配不上 `\d+` 自然落到 3 槽版）。
- 槽位构造：转发实参 token `ARG:n` → 数值槽 / `ARGS:n` → 字符串槽（**按序绑定** ARG:0.. / ARGS:0..，与签名声明顺序一致）；非平凡 token（如 `OVERRIDE_TARGET`）跳过；无括号 CALLFORM → 空槽位表。
- **诚实呈现**：槽位 label =「转发自路由 ARG:3」——面板直观显示"这个参数是路由层透传的"；空输入 = 未提供该槽（unknown，不猜测）；预填 0 = "默认场景"（转发链未设置的引擎事实）。

**测试**：+5 单测（模板匹配 / 多模板消歧 / 无实参 / 协议外 null / 缺文件降级）；集成冒烟协议断言（真实 KOJO_MESSAGE.ERB → SPEVENT 2 槽 / 家族外 null）；419 项全绿 / audit 10 插件 / app build ✅。

---


### 5.17 存档写侧预研（v0.2 第十一批实施记录：金样本原样写回）

**目的**：v1.1 注入器（改槽 → 重序列化 → 重压缩）的地基验证——**读 → 原样写回 → 逐字节对比**（金样本回归，写侧 PoC 而非完整注入器）。

**实现**（sav-parser，游戏无关）：

- `writer.ts`：ByteWriter（ByteReader 逐原语对称）——整数 m_ReadInt 逆编码（≤0xCF 单字节 / 0xD0-0xD2 定宽）、7-bit 前缀（UTF-16LE 字节数）+ UTF-16LE 正文；
- `serialize.ts`：serializePayload（载荷层重序列化，parse 逐结构对称）——标量 / map / xml / datatable 直接写，**数组游程重编码为行驱动结构**；
- `golden-roundtrip.test.ts`：六档金样本——字节级对比（近似档跳过）+ 语义级 round-trip 恒等（JSON 串对比定位）。

**行驱动编码（金样本考古的关键发现）**：2D/3D 数组的游程不是扁平的 cell 流，而是**行驱动结构**——每行内容后必写 0xE0（换行）、每面内容后必写 0xE1（换面），**含最后一行/面**（cursor 证据：GMF_MAPNAME cursor=[12,0] = 最后行 11 写完仍推进）；行间跳跃 dx=1 → 0xE0、dx>1 → 0xF1+n；**首行（dx=0）不写行标记**（初版实现误写 F1+0，12 行 × 2 字节 = 24 字节差异定位后修正）。调试方法：从 parse 产物的 offset 起，用 ByteReader 逐 token 打印原始流（对比重编码 token 序列）。

**金样本结果**：

| 档 | 结果 |
| --- | --- |
| save00（571,185B 载荷） | **字节级完全一致（差异 0）**——编码器同构成功：游程行驱动 / 整数宽度选择 / 7-bit 前缀 / 流控制（EOF/EOC/Separator）全部正确 |
| save01-03 | 序列化不可行——**Int64 大数**（RANDDATA 的 SFMT 625 状态 ≈2.8e16 等）被读侧 int64AsNumber 近似为 double，写回必损坏（serialize 显式抛错拒绝，宁抛错不写坏档） |

**v1.1 注入器的硬性前置 = Int64 精度策略**，候选方案：

- **方案 B（倾向）**：`ArchiveArrayVariable.rawBytes?`——保留各变量原始字节区间；注入器默认原样复制未修改变量（99%+），只重编码被修改的变量；被修改变量含 Int64 大数 → 拒绝注入（显式边界）。
- 方案 A：契约 int 值升级 number|bigint——侵入全部消费方（回放求值等），成本高。

**测试**：金样本回归（守门 KOJO_SMOKE_PROJECT）+ save00 字节级 = 0 断言；419 项全绿 / audit 10 插件。

---

### 5.18 审阅修复批次（v0.2 第十二批实施记录：CASE TO 语义 + 数据安全收口）

> 依据：`docs/CODE-REVIEW-2026-10-10.md`（只读审阅报告）。本批 = 审阅修复清单落地。

#### H1（高）：CASE `a TO b` 区间被 OR 展开 —— 系统性分支误判

- **原缺陷**：`expandCase` 把 TO 区间拆成两条同行谓词（`>=a`、`<=b`），branches.ts 折叠时同行取"任一真即命中"（OR）——区间语义实为 **AND**（`a <= v && v <= b`）。语料 3,136 处，失真方向"多命中"且不以 unknown 暴露。
- **修复**（三处，向后兼容）：
  1. 契约：`FunctionPredicate.conjunction?: 'and'`（缺省 = 同行 OR）+ `PredicateReplay.conjunction` 透传；
  2. 抽取：`expandCase` TO 展开的两条半边谓词打 `'and'` 标记；
  3. 折叠（branches.ts）：同行谓词先分组——连续 `'and'` 谓词成 AND 组（Kleene：false 主导 → 组假；否则含 unknown → 组未知），组间再 OR（`CASE 1, 240 TO 359, 5` ≡ `v==1 || (240<=v && v<=359) || v==5`）。
- **测试**：+7（单边真不命中 / 两端真命中 / Kleene 假主导走 CASEELSE / 混排双向 / 向后兼容 OR）；回放基线不变（3741 未知 / exact 836——本修复改的是分支折叠语义，不触碰谓词统计）。

#### M4（中）：切换文件丢未保存内容

- App 层守卫：`openFile` 与 `editor.revealLocation` 统一经 `requestOpenFile`；当前 dirty 且目标不同 → `UnsavedConfirmDialog`（保存并前往 / 丢弃 / 取消）。EditorPane 新增 `onDirtyChange`（脏状态上抛）与 `registerSave`（保存句柄，供"保存并前往"）；保存失败停留当前文件。

#### M5（中）：回放面板联动闭包陈旧

- `kojo.replayFunction` 监听 effect 原依赖不含 `view`，视图就绪后闭包仍是旧值 → 误报"请先选择存档与角色"。改为 `runReplayRef` 持有最新 runReplay（每次渲染赋值），监听 effect 依赖 `[]`。

#### M2（中）：Rust 编码静默数据损坏

- `encode_string`：`had_errors` 一律拒绝（encoding_rs 对不可映射字符默认写 HTML numeric entity `&#NNNN;`，引擎读为字面乱码）——报错提示"内容含该编码无法表示的字符"。
- `decode_bytes`：`had_errors` 记 stderr（不静默），文本仍返回供只读浏览——写回时由 encode 侧兜底（U+FFFD 无法再编码 → 拒绝保存，损坏不落盘）。

#### 轻微项

- **L1**：`storage.ts` JSON.parse 容错（损坏文件 → warn + 视为缺失，不再炸整个存储域）。
- **L2**：核实为误报——比较两侧均已经 `pathKey`（win32 大小写折叠），未改动。
- **L3**：POWER 先判超 2^53 → unknown（旧实现用失真中间值判 Int64，2^62 曾被当作合法值返回）。
- **L4**：`resolveModel` 的"已知名但快照缺失 → null"分支实为**死代码**（`builtinVarModel` 与 `isKnown*Variable` 检查同一批集合，已知名在函数开头即返回 model）——清理并修正注释。
- L5（TRY 系开块规则）/ L6（家族编号锚点）/ L7 杂项：记录在案，本批不动。

#### 遗留（审阅 M1 / M3）

- M1（`runtime.stop()` 不级联停用依赖方）、M3（Rust 命令无路径约束）为架构级补强，随 v0.3 规划处理。

**验证**：426 项全绿（+7）/ typecheck root+app / audit 10 插件 / 真实工程冒烟通过（基线不变）/ cargo check 通过。

---

### 5.19 存档注入器地基（v0.2 第十三批实施记录：Int64 精度方案 B）

> 依据：第十一批遗留前置条件（v1.1 注入器需 Int64 精度）。本批 = 方案 B（rawBytes passthrough）落地。

#### 设计：未修变量原样透传，修改变量重编码 + 守卫

- **读侧**（`plugin-api` 契约 + sav-parser 实现）：
  - 5 个变量接口全部新增 `raw?: Uint8Array`（`keepRaw` 选项打开时，指向**原始载荷中该变量的完整字节段**，含类型 token + key + 值域，`span()` 以 subarray 视图零拷贝）；
  - `ArchiveParseOptions.keepRaw?: boolean`（与 `keepArrayCells` 正交）。
- **写侧**（serialize.ts `writeVar` 三路分支）：
  1. **passthrough 捷径**（先于 token/key 写出）：无覆盖且有 `raw` → `w.bytes(v.raw)` 原样复制——Int64 近似值**永不写回**；
  2. **覆盖路径**：标量替换（int 须 number / str·xml 须 string，类型不符即抛）；数组走 `ArchiveCellPatch[]` 按下标合并（`mergedCells`：同下标替换、新下标插入、排序合并），**Int64 精度守卫**——任一单元值超出安全整数域即抛 `ArchiveParseError`（读侧已近似，重编码必损坏，绝不静默）；
  3. **legacy 重编码**：无 raw 的变量维持第十一批路径。
- **契约**：`ArchiveCellPatch { index: number[]; value: number | string }`、`ArchiveOverrideValue = number | string | readonly ArchiveCellPatch[]`、`ArchiveOverrides { vars?: Map<string, ArchiveOverrideValue>; chars?: Map<number, Map<string, ArchiveOverrideValue>> }`、`serializePayload(archive, { overrides? })`——三类型经 plugin-api index 导出。

#### 金样本关键发现（纠正第十一批结论）

- **RANDDATA 本身全档无不安全单元**：SFMT 状态是 u32 序列，逐值均 < 2^53（"≈2.8e16"是 625 个值整体规模的误读，非单值量级）。save00 全零（cells 空，初始未用态）。
- 真正读侧近似（不安全整数）分布在 save01+ 的**顶层 `RESULT`** 与**角色块 `CFLAG` / `GIFT_GOT` / `TCVAR`**（GIFT 系统大数标记等）——守卫测试改为逐档动态扫描不安全单元，不再硬编码 RANDDATA。
- **六档 passthrough 全部字节级一致**（含此前因 Int64 被显式拒绝的 save01-05）——方案 B 消除了第十一批的写侧禁区。

#### 测试

- `raw-inject.test.ts`（+8 合成用例）：Int64 透传 / 混合 raw / 标量覆盖重解析读回 / 单元补丁合并排序 / 类型不符拒绝 / 守卫拒绝 / 截断 cells 不可写 / map 变量不支持覆盖。
- `golden-roundtrip.test.ts` 第二用例重写：六档 keepRaw passthrough 差异 0 + save00 角色块标量注入（`ISASSI=123456789`）重解析读回一致 + save01 动态定位不安全单元注入被守卫拒绝。

**验证**：456 项全绿（+30）/ typecheck root+app / audit 11 插件（含 TRAE 的 ui-archive-browser）。

---

### 5.20 回放面板信任闭环（v1.0 收口实施记录：C9 假设值标注 + A3 预览职责）

> 依据：`docs/REVIEW-OPTIMIZATION-2026-10-10.md` §3 C9（"默认场景全 0"被当确定事实）与 A3（预览职责两处说法未对齐）、§5 "v1.0 收口（信任闭环）"第 4、5 项。本批为 **v1.0 收口 UI 线**（另一条线并行做 C7 Rust 写保护，互不越界）。

#### C9：把"预填 0"从确定值降格为假设值

- **问题（审阅已核实）**：`ui-state-replay/src/index.ts` 把协议槽的默认场景预填值（int=0 / str=''）当作**已提供值**参与分支判定——未改动的 0 并不必然等于引擎真实默认，存在**假命中**风险；只有空串才按 unknown 处理。
- **修复**：新增**槽位来源三态**（纯逻辑 `panel-logic.ts`，零 React）：
  - `manual`：作者手输（含把预填 0 显式改写）→ 确定值；
  - `assumption`：**未手改且等于预填默认**（int 的 `'0'`）→ 默认场景**假设值**；
  - `unset`：空值 → 未提供，求值走 `unknown('call-context')`——**语义不变**。
- **UI 落地**：
  1. **场景参数区**：假设槽以虚线边框 + 「假设」前缀徽章呈现（视觉上区别于手输确定值；内联样式自持，不改 app 样式表）；
  2. **谓词结果**：读取了假设槽的谓词旁标注「基于假设」（AST 扫描 `ARG` / `ARGS` 引用，裸名 ≡ `:0`）；
  3. **分支折叠结果区汇总**：「本结果含 N 个假设参数」（N = 被谓词实际消费的假设槽去重计数——未被任何谓词读取的槽不影响可信度）。
- **附带必要修正**：槽位输入改以 `slotKey(kind,index)` 为键——此前以裸下标为键，当签名同时含 `ARG:0` 与 `ARGS:0`（如路由模板 `(ARGS:2, ARG:3, ARG:4)`）时两槽互相覆盖（str 槽被 int 的预填 0 污染）。
- **假设值快照**：假设槽集合在**回放时刻**随结果一并保存（`resultAssumed`）——之后改槽不会改写已出结果的"基于假设"标注（不产生新旧错配）。

#### A3：预览职责分层与归属注记

- 面板代码内部分层（**不改设计**，只明确归属）：
  - **预览层** = `renderReplayPreview` + `branchRow`：把 `FunctionReplay` 渲染为"状态 → 分支 / 文本预览"；参数显式传入，与壳层解耦；
  - **壳层** = `ReplayPanel` 其余部分：`ui.panel` 的选档 / 选角 / 选函数 / 场景参数输入 / 错误提示；
  - **纯逻辑** = `panel-logic.ts`（零 React，判定与统计可复用）。
- `ARCHITECTURE.md` §5.4 追加一行职责分工注记：回放面板负责"状态 → 分支 / 文本预览"；糖预览（若做）复用 `preview.renderer` 产出的 `PreviewLines[]` 渲染，**不自建渲染逻辑**。

#### 边界与不变式

- **未改**回放引擎（`state-replay`）语义与 `condition-extractor` 契约。
- 真实工程基线**实测不变**（集成冒烟逐字复现）：K49 全量 **1,356 个含谓词函数 / 11,685 谓词**——命中 1,549 / 未命中 6,395 / **未知 3,741**；置信度 **exact 836** / partial 482 / unknown 38。

#### 测试

- +14 单测（`panel-logic.test.ts`）：来源三态（含容忍空白 / 显式改写为 0 / 清空 / str 不假设）/ 全默认 / 全手输 / 混合 / 清空；AST 槽位扫描（裸 `ARG` ≡ `:0`、`ARG:n`·`ARGS:n` 归类、call 参数与一元·三元递归、动态索引与 opaque 不归因）；汇总标注逐位对齐 + 计数去重 + 未被读取不计 + int/str 不串味。
- **470 项全绿**（456 → 470）/ typecheck root+app 通过 / 真实工程冒烟通过。

#### 回归说明（不静默）

`pnpm audit:decoupling` 本批在**并行线 C7 的未提交改动**上报红——`packages/app/src-tauri/src/lib.rs:484` 出现裸 `sav` 词（`v1.sav`）触发 A 项黑名单。该文件属另一条线（Rust 写保护），**不在本批边界内、未改动**；本批新增代码（`ui-state-replay`）零审计违规。

### 5.21 Rust 侧写路径纵深防御（v0.2 第十四批实施记录：写允许域第二道闸）

> 依据：docs/CODE-REVIEW-2026-10-10.md L68-70（M3 遗留）+ docs/REVIEW-OPTIMIZATION-2026-10-10.md §5 C7——「M3 必须优先于 v1.1 注入器：注入器本身是写路径，无第二道闸不能开写」。本批只动 packages/app/src-tauri/**、kernel io 契约注释、docs/**。

#### 允许域语义

- **允许 = 项目根目录整体（含游戏目录，与 kernel writablePaths 的判定域一致）+ appDataDir（备份/配置/存储，常驻允许）**；其余路径一律拒绝并返回明确错误（不静默、fail-closed）。
- 与 JS 层第一道闸的关系：kernel io 的 writablePaths 是项目根的**用户批准子集**；Rust 闸判定域更宽（项目根整体）但独立生效——双闸并存，语义以更严者为准。kernel io.ts 契约与行为零改动（仅头注释补双闸说明）。
- 域生命周期：project.opened 时前端 invoke register_write_domain 注册项目根；project.closed 时 invoke clear_write_domain 回到「仅 appDataDir」。注册失败 fail-closed（仍只允许 appDataDir）并显式 setError。

#### 实现（packages/app/src-tauri/src/lib.rs）

- WriteDomainState（Mutex<Option<PathBuf>>）经 tauri .manage 托管；register_write_domain / clear_write_domain 两个新命令。
- 判定核心为纯函数（不依赖 Tauri 类型，可单测）：canonicalize_deep（最深已存在祖先 canonicalize 解析 .. 与符号链接 + 追加不存在尾部——待建的原子写目标同样可判定）→ is_within（组件级前缀比较，Windows 大小写折叠，projec/project 这类字符串前缀兄弟目录不误判）→ ensure_in_write_domain。
- 上闸命令（六处）：write_file_bytes（目标）/ ensure_dir / rename_path（from+to 双端）/ copy_file（仅 to，from 是读）/ remove_file。读路径（read_file_bytes/list_dir/walk_dir/stat_file/path_exists）不受允许域限制——「游戏目录整体只读假设」的读侧本就开放。
- 已知边界：检查与写入之间存在 TOCTOU 窗口（check-then-write 非原子）；纵深防御语境下可接受（JS 闸 + 用户批准仍在），如后续需要可改 fd 级锁定。

#### 测试（cargo test，9 项全绿）

域内放行（含深层不存在文件）/ appDataDir 常驻放行 / 域外拒绝 / 未注册项目时仅 appDataDir 放行 / 字符串以项目根开头但 .. 穿越到域外拒绝 / 目标已存在的 .. 穿越拒绝 / 符号链接逃逸拒绝（Windows symlink_dir 权限不足时跳过）/ 组件级前缀不误判 / canonicalize_deep 保留不存在尾部。

#### 验证

- cargo test 9/9 ✅；cargo check ✅；pnpm test 470 项全绿（基线 456 + 归档浏览器后续 +14）；typecheck root+app ✅；audit:decoupling ✅（11 插件；本批曾被裸 sav 词抓出一次——单测文件名字符串，改 v1.dat 后全绿，A 项黑名单连测试字符串都查，好样的）；真实工程集成冒烟（游戏目录读不受影响）✅。
- 桌面壳端到端（Rust 闸在真实 IPC 下的表现）沙箱不可跑（os error 231 欠账），需正常终端跑 pnpm tauri dev 手工冒烟：开项目后向域外写应被拒、域内写正常。
- 前端接线（App.tsx）：openProject 注册 / closeProject 清除，均在 isTauri() 守卫内（浏览器 dev 模式无 Rust 宿主）。

---

### 5.22 回放面板场景预设（v1.0 收口线一实施记录：调用上下文可保存复用）

> 依据：`docs/REVIEW-OPTIMIZATION-2026-10-10.md` §5「v1.0 收口」第 4 项的后续阶梯 + `HANDOFF.md` §6.11 候选「回放面板协议深化（场景预设）」。承接 §5.20 的 C9 信任闭环：场景值是**作者的场景假设**，不是引擎事实——UI 文案不得写死「正确值」。本批只动 `packages/plugins/ui-state-replay/**` + docs；回放引擎（`state-replay`）与 `condition-extractor` 契约**零改动**。

#### 数据模型（`panel-logic.ts`，纯逻辑零 React）

- `ReplayScene{ id, name, slots }`；`slots` 键 = `slotKey(kind,index)`（`int:0` / `str:0` 同号互不冲突，沿用 §5.20 的键修正），值恒为 `{ value: string, kind: 'manual' }`——场景值一律记为 manual（作者显式提供的场景输入）。
- 持久化走 `ctx.storage`（域 = 插件 id `ui-state-replay`，键 `replay-scenes`）：内核按 pluginId 隔离，**不复用他人域**。内置默认场景（`DEFAULT_SCENE_ID`）为虚拟项，不入存储、不可删除。
- `sanitizeScenes`：反序列化容错（非数组 → 空；逐条丢弃缺 id/name、内置 id、重复 id、非法槽位键、非 `manual`、空值项；名字去空白 + 截断；`MAX_SCENES=50` 上限截断）——与内核存储 L1 容错同向，**绝不抛错**。

#### 应用语义与合并冲突（`applyScene`，显式上报不静默）

- 场景命中的槽 → 取场景值 + `edited=true`（来源 **manual**＝作者假设）；签名内未被场景覆盖的槽 → 回到默认（int `0` = 假设 / str 空 = 未提供），此前已填的记入 `reset`；场景里当前函数签名没有的槽（换家族 / 协议不同）→ 丢弃并记入 `dropped`。
- 产出 `texts` / `edited` 直接落面板状态——**§5.20 的假设徽章语义不变**：未被场景覆盖的 int 槽仍是 `assumption`（虚线 + 「假设」徽章），只有场景显式覆盖过的槽才是 manual（无徽章）。
- 「手工场景值也是作者假设」由文案承载（应用提示 + 建议名输入 tooltip），不引入第四种来源态。

#### 面板交互（`index.ts` 壳层）

1. 场景下拉（内置「默认场景（全 0，全部假设）」+ 用户自建）→ **一键应用**（默认场景 = 一键清空回全 0 假设 / 未提供）；
2. **保存当前输入为场景**（输入名；留空取建议名）；同名保存 = 覆盖（保留原 id，槽位整体替换）；
3. **删除场景**（内置默认场景按钮禁用 + 提示不可删）；
4. 冲突消息行显式呈现（忽略 N 个 / 重置 N 个 / 覆盖同名）。

#### 协议降级与建议名

- 协议（`kojoCallProtocol`）可用 → 场景建议名由槽位 label 拼接（如「对话对象=觉/时机=SP_EVENT」，跳过空槽、label 空回退 `ARG:n`），输入框留空即用（placeholder 展示）；
- 协议不可用（无协议或函数名未确定）→ 建议名为空串（**纯手填，不猜**）；此时场景改为作用于裸调用上下文文本框：`sceneSlotsToContextText` / `contextTextToSceneSlots` 双向转换（复用 §5.20 的 `parseCallContextText`，解析失败 → `null` + 提示，**绝不抛错**）。

#### 边界与不变式

- **未改**回放引擎（`state-replay`）与 `condition-extractor` 契约；未碰 kernel / plugin-api / src-tauri / ui-archive-browser。
- 真实工程冒烟基线**逐字复现**（K49：1,356 函数 / 11,685 谓词 / 未知 3,741 / exact 836）。

#### 测试

- +15 单测（`panel-logic.test.ts`）：`sanitizeScenes` 反序列化容错与数量上限 / `captureSceneSlots` 空值过滤 / `applyScene` 应用 + `dropped`·`reset` 合并冲突 / 内置默认场景回默认 / int·str 同号不串味 / `sceneSuggestionName` label 拼接与降级 / 槽位↔裸文本 round-trip 与非法输入 `null` / `upsertSceneByName` 同名覆盖 / `removeScene` / `newSceneId` 碰撞重试。
- **485 项全绿**（470 → 485）/ typecheck root+app ✅ / `audit:decoupling` ✅（11 插件）/ 真实工程集成冒烟 ✅。

---

### 5.23 存档注入器用户面（v1.1 实施记录：写链路端到端）

> 承接 §5.19（Int64 方案 B）与 §5.21（Rust 写允许域第二道闸）：把「改槽注入」从引擎能力做成
> 用户可用的端到端写链路。批次编号顺延为第十六批（第十五批已被 §5.22 场景预设占用）。
> 边界：未动 kernel/Rust 源码（仅测试）；未碰 `ui-state-replay/**`。

#### 契约（plugin-api，读写职责分离）

- `SnapshotWriteService { inject(path, overrides): Promise<SnapshotInjectionResult> }`，服务键
  `snapshot.writer`（`WellKnownServices` 新增）。只读消费者继续只依赖 `snapshot.source`，不必感知写权限。
- `SnapshotInjectionResult { path, backupPath, byteSize, verifiedCount }`——回读验证通过后返回，
  `backupPath` 供失败时提示用户备份位置。

#### sav-parser 写侧（0.3.0）

- **`container.ts`**：`assembleArchiveFile(payload, format)` 按 16 字节明文头（magic 8B + version u32 +
  保留 u32）+ 正文组装容器；`gzipBytes` 用 Web 标准 `CompressionStream`（不引 node:zlib）；
  `magicFor(format)`：原档 gzip 正文沿用 GZIP 魔数、raw 正文沿用 RAW 魔数（**踩坑 1**：gunzip 后
  的载荷再用 GZIP 魔数重打包会让 parse 二次解压报 Z_DATA_ERROR——裸载荷必须配 RAW 魔数）。
- **`verify.ts`**：`verifyOverrides(archive, overrides)` 逐条比对——标量值相等 / 数组 CellPatch 按
  全维度下标（`index.join(',')`）；vars 作用域按 vars→globalVars→emVars 首个命中；chars 按 block
  index。返回 `{ checked, mismatches }`，mismatch 含变量名/下标/期望/实际。
- **`engine.inject`** 编排顺序即安全顺序：读原档 → parse（keepRaw + 全量 cells）→
  `serializePayload`（**Int64 守卫在备份之前抛**——损坏输入零副作用）→ 容器组装 → `deps.backup`
  （先复制备份）→ `deps.writeBytes` → **回读验证**（重新 parse + verifyOverrides；mismatch 非空抛错
  且错误信息携带备份路径）。越权抛错时备份已存在但未覆盖原档。

#### 真实缺口修复：eratw-adapter writablePaths

- 原提议只含 personalKojo，sav 目录写入会被 kernel 第一道闸拒绝。补上
  `join(rootDir, ...ERATW.savDir)` 提议（用户批准弹窗流程已存在，内核/Rust 零改动）。

#### 第 12 插件 `ui-snapshot-injector`

- **`panel-logic.ts`**（零 React，+16 单测）：作用域枚举（top/em/char）、变量目录、标量/单元输入
  解析（int 安全校验 / 维度+范围校验）、`buildOverrides`（cell 补丁按 last-write-wins 追加合并）、
  `diffRows` / `dedupePending`（同键去重 + `supersededCount`）。
- **面板流程**：档位下拉（复用 ui-archive-browser 已有列档数据流 `scan.entries`，不重复扫描）→
  `kojo.snapshotSelected` 事件预填 → 深解析（keepRaw）→ 作用域/变量过滤列表（cap 200；cells 超
  120 截断标「不可注入」）→ 编辑 → diff 清单 → armed 两步确认（不用 `window.confirm`）→
  `writer.inject` → 成功后重新深解析显示落盘新值。
- 登记四处 + bootstrap：package.json / root tsconfig paths / vitest aliases / vite aliases +
  app package.json deps + `bootstrap.ts` 注册（order 71）。

#### 集成与金样本回归

- kernel 集成测试新增第 9 节：9.1 真实游戏档路径**越权拒绝**（不在 writable roots）；9.2 appData
  副本端到端注入（`setWritableRoots([appData])` → 注入 424242 → backupPath 存在 → 回读验证通过）；
  9.3 Int64 守卫拒绝且副本值不变。**绝不写真实游戏档**。
- golden-roundtrip 新增「容器级注入链路」用例：save00 keepRaw 解析 → 动态定位标量 →
  serialize+assemble gzip → parse 容器 → verifyOverrides `checked=1 mismatches=[]`。

#### 验证

- `pnpm test` **509 passed**（基线 470 + 39）/ typecheck root+app ✅ / `audit:decoupling` 12 插件 ✅。
- 真实工程冒烟（KOJO_SMOKE_PROJECT）：注入链路副本验证通过（56744B，备份已建）；越权拒绝与
  Int64 守卫各 1 项；回放基线不变（未知 3741 / exact 836）。app vite build ✅。

#### 其他踩坑

- **踩坑 2**：synth 合成档 `simpleCharBlock` 的 CFLAG cells 实际下标 `[0]=1`、`[3]=3`（非 [1]=3），
  「缺失下标」用例需用不存在的下标。
- **踩坑 3**：回读验证失败用例写全零字节会先命中「未知存档魔数」而非 verify mismatch——测试
  harness 增加 `writeMode: 'stale'`（原档写回模拟回滚）才能命中真正的回读验证失败路径。

---

### 5.24 桌面壳端到端冒烟（第十七批实施记录：Rust 双闸真实 IPC 验证 + 自动化探针）

> 编号沿用交接口径「第十七批」。承接 §5.21（Rust 写允许域第二道闸 M3）的**端到端欠账**：此前
> 沙箱会话跑不了 `tauri dev`（`BeforeDevCommand` 经 windows shell 触发宿主管道耗尽 `os error 231`），
> 真实 IPC 下的域外写拒绝从未实测。本批在正常终端闭环，并把清单固化为可重复的自动化探针。

#### 关键洞察：CDP 直调 = 真实 IPC（非伪造）

Tauri dev 下 WebView2 可用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 开远程调试；
Node 经 CDP `Runtime.evaluate` 在页面执行 `window.__TAURI_INTERNALS__.invoke(cmd, args)`——与 app 的
bridge（`packages/app/src/bridge/tauri-bridge.ts`）走**同一条** `__TAURI_INTERNALS__` 通道，落到真实 Rust
命令处理器。据此 a–e 清单可全自动化。

#### 环境（§八补记）

- 本会话 Trae 终端（PowerShell）直接 `node tools/smoke-tauri-dom.mjs 130` **可跑**：vite 1420 ✓ /
  cargo 增量编译 ~21s / `target\debug\kojo-editor.exe` ✓ / CDP 9222 ✓ / DOM 渲染 ✓。
  **`os error 231` 未复现**——原为沙箱会话特有，非项目问题。
- Node 24.14 · pnpm 11.22 · cargo/rustc 1.99。

#### 交付

1. **`tools/smoke-tauri-ipc.mjs`**（自动化探针，真实 IPC）：a 开项目 → a2 批准写权限 → b 编辑+保存
   +落盘+备份 → c 域外写拒 → e appDataDir 写 → d 关项目后写游戏目录拒。自带 store（recent +
   approved-writable）与文件原字节还原、`.bak`/临时文件清场、端口预检。
2. **`tools/smoke-tauri-manual.md`**：可勾选手工清单（a–f，每项步骤 + 预期结果）+ 本批实测结论表 +
   安全不变量 + 已知抖动。

#### 实测结论（全 PASS）

- **a** rootDir = 游戏目录；stats `角色 168 / 文件 2285 / 函数 99104`。
- **a2** 首次弹「写权限确认」→ 点「允许写入」→ 关闭（批准持久化；探针结束时还原 store）。
- **b** 改 `…\個人口上\001 Reimu [霊夢]\of_new_kojo_api_TEST.ERB` → 磁盘含 marker ✓
  + `{appData}\backup\of_new_kojo_api_TEST.ERB-dafcdd60\<ts>.bak` 新增 1 个（原字节已还原）。
- **c** `C:\Windows\Temp\kojo-smoke-outside.txt` → 抛
  「写允许域拒绝（write）：… 不在允许域内（允许 = 项目根目录 / appDataDir；未打开项目时仅 appDataDir）」。
- **d** 关闭项目后写游戏目录 `_kojo_smoke_after_close.txt` → 同样「写允许域拒绝」（`project_root` 已清）。
- **e** appDataDir `ensure_dir` + `write_file_bytes` 成功并可读回。
- **双闸语义实测成立**：项目根 + appDataDir 放行、域外 **fail-closed**、关闭项目后回落仅 appDataDir。

#### 边界与不变式

- 仅 `tools/**` + `docs/**`；**零源码改动**（未动 Rust / TS；测试计数不受影响）。未碰
  `packages/plugins/**`（并行线战场）与 kernel / plugin-api / src-tauri。
- 安全不变量未放宽：允许域 = 项目根整体 + appDataDir，双闸以更严者为准。

#### 教训（§九 补）

- **CDP `returnByValue` 返回 DOM 节点会报 `Object reference chain is too long`**：等待条件必须
  `!!document.querySelector(...)` 归一为布尔（曾致 d 步骤假超时）。
- **tauri dev 首轮冷启动 HMR 重载**：vite `Re-optimizing dependencies because lockfile has changed`
  会在项目打开后重载页面 → 回欢迎页（探针 `.proj-stats` 一度为空）。属首次 dev 的已知抖动，
  二次运行稳定；探针已加端口预检 + 180s 等待缓解。

---

### 5.25 审阅缺陷修复（v0.2 第十八批实施记录：BUG-REPORT-2026-10-10 落地）

> 依据：docs/BUG-REPORT-2026-10-10.md（第二轮审阅遗留，逐条代码复核属实）。边界：不碰 sav-parser / 注入器线（并行 WIP）。

#### BUG-1（=审阅 M1，中）：runtime.stop() 级联停用依赖方

- **修复（方案 A）**：新增 dependentsClosure(rootId)——requires × provides 服务键依赖图的 BFS 闭包（slot 消费关系不在图内，代码注释写明边界）；stop(id) 先按 BFS 发现序的**逆序**（最深依赖方先停）逐个 stopDirect，最后停自身；每步照常广播 plugin.statusChanged。stopAll 逐个调 stop，依赖方已被先停的路径自然 no-op——逆序哲学一致，行为兼容。
- 附带修：retry() docstring 去掉「状态面板的重试按钮」陈旧说法（实测面板只读，BUG-REPORT 影响段已修正审阅原话）。
- 测试 +3：双插件级联（依赖方先停、deactivate 均被调）/ 三级链 A→B→C 逆拓扑序 / 无关旁观插件不受影响；stopAll 既有回归不变。

#### BUG-2（=审阅 L5，低→实际修正）：scanner TRY/PRINTDATA 精确配对

- **复核发现比报告更严重**：报告写「实测影响为零」，但引擎 funcMatch（FunctionIdentifier.cs :460-487）明确 TRYCALL/TRYCALLFORM/TRYGOTO/TRYJUMP 是**单行语句不开块**——旧 startsWith('TRY') 把它们当开块，正是此前记录的「TRYCALLFORM 幻影开块」根因；TRY*LIST 三者也与 TRYC 家族混在同一个配对类里。
- **修复（按引擎原文逐条对齐）**：配 CATCH 恰为 6 个（TRYCGOTO/TRYCJUMP/TRYCCALL ±FORM）；配 ENDFUNC 恰为 3 个（TRYCALLLIST/TRYGOTOLIST/TRYJUMPLIST，独立配对类 funclist）；PRINTDATA 系恰为 9 个精确枚举。extract.ts 的 buildContextLookup 同源镜像修（插件间禁 import，就地复制常量 + 同源注释）。
- **基线实测无涟漪**：真实工程冒烟回放基线逐字不变（1356 函数 / 11685 谓词 / 未知 3741 / exact 836）——语料中这些语句的误开块恰好未改变可达性判定，与审阅 L5「实测影响为零」的结论在语料层面一致；但结构正确性修正依然值得（防御未来语料）。
- 测试 +4 组：TRYC 六成员逐个配对 / TRYCALL 等单行不开块 / TRY*LIST 独立配对 / PRINTDATA 九成员精确命中 + 非成员不误判；**旧测试更正**——原「TRY 系 → CATCH」用例把 TRYCALLFORM 误开块固化成了断言，改为 TRYCGOTOFORM + 断言 TRYCALLFORM 不出现。

#### BUG-3（=审阅 L6，低）：family-index 锚点语义显式化

- 贪婪 (.*) 即「取最后一个 _K{no} 为编号锚」（最靠近槽位的 K 编号是家族编号），与引擎家族命名一致——行为正确，缺的是文档与测试。补锚点语义注释（含数字边界说明：\d+ 后必须是 _ 或串尾，K1B 不误切）+ 4 项单测（单锚 / 多 _K 段取末 / K1B null / 无锚 null）。行为零改动。

#### BUG-4（=审阅 L7 杂项，低·性能）：编辑器脏判定 O(1)

- EditorPane 脏判定从每击键 ed.getValue() !== originalRef.current（O(n) 全量比较+分配）改为 model.getAlternativeVersionId() 版本号比较；打开/保存成功时记录基线版本号。**取舍**：撤销回原始内容后版本号仍不同 → 显示脏（内容相等不再视为已保存）——版本号方案标准行为，注释写明。

#### BUG-5：判定延后（v1.1 注入器批次一并做）

- file.changed 事件链是 v1.1 实时编辑的硬前置，但 payload 契约（路径/编码/是否外部变更）应与注入器写链路（kernel io 写盘 → 事件广播 → 索引/回放缓存失效）一并设计——现在单方面 emit 只是又一次「契约先行、实现滞后」。已记入 HANDOFF 下一批清单。

**验证**：vitest 全量 **520 passed / 4 skipped**（+16：runtime +3 / scanner +7 / family-index +4 / 更正旧用例 1 + 注入器线并行转绿）；typecheck root+app ✅；audit:decoupling ✅（12 插件）；真实工程集成冒烟 ✅（回放基线逐字不变）。

---
