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

### 5.26 语法糖契约 + golden 固化（v0.3 批 S1 实施记录：先立契约与基准，不碰转译器）

> 依据：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（表层语法 v1.2 冻结版，只读输入）+ `docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §8.2（S1 = 契约 + golden 固化；S1 的测量项已由规范 §1.1 提前完成）。
> 边界：仅 `packages/plugin-api/**` + `packages/plugins/kojo-sugar/tests/goldens/**`；未碰 erb-parser / condition-extractor / state-replay 任何现有文件；未改规范文档（冻结输入）；无新插件（`kojo-sugar` 插件 S2 建）。

#### 交付物

1. **契约 `packages/plugin-api/src/sugar.ts`**（新文件，约 700 行）：
   - `SugarDoc`（`filePath` + `frontMatter` + `topLevel` + `diagnostics`）；
   - `SugarFrontMatter`（角色/口上/显示名/简介/口上色/旁白色/开关/别名，对应规范 §3.1）；
   - **SugarNode 联合**（判别式统一为 `kind`）：`TextLine`（speech/wait/interpolations）/ `HeartLine` / `IfBlock` / `IfExpr` / `WhenBlock` / `WhenExpr` / `RandomBlock` / `RandomInline` / `ChoiceBlock` / `ColorBlock` / `RawLine` / `RawFunctionBlock` / `AliasDecl` / `TimingBlock` / `Interpolation`；
   - 语句位置与表达式位置**在类型层分离**：`SugarStatement`（可进块体）∪ `SugarExprNode`（仅赋值位置）= `SugarNode`；`SugarTopLevelNode` = `AliasDecl` | `TimingBlock`；
   - **`AliasValue` 四右值**（规范 §3.1 表）：`variable`（可读写）/ `character` / `number` / `string`（后三只读）；
   - `SugarDiagnostic` + `SugarDiagnosticCode`（23 码**闭集**，按「结构 / 表达式 / 插值 / 别名 / 时机 / 选项 / 文本 / 直通 / 兜底」分组）；
   - `SugarSourceMapEntry`（行级：generatedLine → sourceLine|null + span）/ `SugarTranspileResult` / `SugarTranspileService`（parse / transpile / sourceOf）。
2. **服务键**：`WellKnownServices.SugarTranspile = 'sugar.transpile'`（services.ts）——实现插件 `kojo-sugar` 在 S2 提供；本批**同时**交了 golden 基准与类型测试（不是空承诺）。
3. **golden fixture**（`packages/plugins/kojo-sugar/tests/goldens/`，4 文件）：
   - `spec-6.1-lumia-310.kojo` / `spec-6.1-lumia-310.expected.erb.todo`
   - `spec-6.2-choice-heart-random.kojo` / `spec-6.2-choice-heart-random.expected.erb.todo`
   - 两份源与两份期望产物**逐字节等于规范 §6.1/§6.2 原文**（含 TAB 缩进、全角「」、`;` 記入チェック 注释行）——测试**直接按规范行号切片比对**，不做本地副本，fixture 被误改即刻变红。
   - 期望产物以 `.erb.todo` 后缀暂存 + `describe.skip` 断言位（S2 转正式后启用）。

#### 关键设计决策（这些是"冻结"项，S2 实现不得擅自改）

- **源位置第一天带上**（审阅 §1.2）：每节点 `loc: { start, end }`，1 基行列、列按 UTF-16 码元（与 Monaco 一致）。
- **源映射粒度 = 行级**（本批明确决策，写进契约 docstring）：规范 §6 的 golden 验收是逐字节文本一致，行级足以支撑"每一产物行回溯到源位置"；**列级留到 S6 编辑体验批**（规范 §9 待实测第 3 条要求定位到列）。折行反斜杠合并时 `sourceLine` 取首行、`span` 覆盖多行；纯生成行（`ENDIF` / `ENDSELECT` / 包装骨架）`sourceLine` 为 `null`（不伪造）。
- **分野 → 函数名模板不进契约**：`TimingBlock.face` 只存分野关键字原文；模板（37 调用面）属 adapter 侧游戏知识——否则游戏知识漏进契约、违铁律。契约只承载"跨游戏语言层"（中文关键字、别名机制、插值/条件结构）。
- **`别名` 属契约层**：它是**文件级 front-matter 机制**（规范 §3.8「别名优先于 L0 查表」），不是某游戏的领域知识，故 `AliasDecl` / `AliasValue` 住 plugin-api。
- **只读性单一真源**：`isReadonlyAlias` / `isWritableAlias` 是唯一判定入口——15 个显式类型守卫（`isTextLine` / `isVariableAlias` / …）替代判别式 narrow，因为 TS7 对"联合字面量属性"的 narrow 不可靠（§九-10 教训又一次应用）。
- **`选择` 返回值不手写**：`ChoiceBlock` 只存 `label`（不含返回值）——"工具按书写顺序分配 1..n"是消灭参数顺序陷阱的设计（规范 §3.7），契约从类型上就不给作者写返回值的口子。

#### 验证

- vitest 全量 **555 passed / 7 skipped**（基线 520 → +35：`packages/plugin-api/tests/sugar.test.ts`；+2 项为本批 `describe.skip` 的 S2 断言位）。
- typecheck **root + app 双跑 ✅**（首次提交前修了 6 处测试文件的 `noUncheckedIndexedAccess` 严格报错）。
- `audit:decoupling` ✅（12 插件）——新契约零游戏名词（裸格式名词亦未出现），`kojo` 属钦定跨游戏术语。
- 真实工程集成冒烟 ✅（临时 stash 归位——见下"并行线冲突"）：**回放基线逐字不变**（K49 1356 函数 / 11685 谓词 / 未知 **3741** / exact **836**）。

#### 并行线冲突记录（重要，给验收者）

- 本批执行期间，**并行线（TRAE）正在同工作区改 `packages/plugins/eratw-adapter/**`**（v1.0 收口余项：协议覆盖校验规则，见 NEXT-SESSION-PROMPTS-2026-10-11 线 B）：新增第 5 条 adapter 规则 `CALL_SLOT_RULE`（`call-protocol.ts` 路由表 × 函数声明槽一致性）。
- 影响：集成冒烟断言 `report.ruleCount === 5`（引擎内置 1 + adapter 4）**因其 WIP 变为 6 而红**，且该行断言归 adapter 线维护。**已用 `git stash` 归位其改动复跑，确认本批无回归**（回放基线逐字不变、其余断言全过），随后 `stash pop` 还原，未触碰其文件。
- 本批交付**只提交自己边界内的文件**（plugin-api + kojo-sugar goldens + docs）；`packages/plugins/eratw-adapter/**` 与 `tests/_measure.tmp.test.ts` 属并行线，未纳入本批 commit。
- **待办（S2 开工前）**：adapter 线落地后需同步 `integration-plugins.test.ts:148` 的 `ruleCount` 期望值（5 → 6）——顺手核对 `[smoke]` 输出的 `across N rule(s)`。

---

### 5.27 协议覆盖校验规则（v1.0 收口实施记录：签名槽 vs 路由转发一致性）

> 依据：`docs/HANDOFF.md` §6.11「v1.0 收口余项」+ §十-4；契约输入 `plugin-api/src/game.ts`（`KojoCallSlot`/`KojoCallProtocol`）。
> 边界：仅 `packages/plugins/eratw-adapter/**`（含测试）+ kernel 集成断言 + `docs`；**未碰** `plugin-api/src/sugar.ts`、`plugins/kojo-sugar/**`（v0.3 主线 S1/S2 并行，零文件交集）；未新增插件（复用 convention-linter 既有规则注册通道）；`ui-convention-report` 未改动（面板自然消费）。

#### 校验目标与语义

- **目标**：对 `call-protocol.ts` 解析出的每个家族槽位，核对某家族**实际函数**（erb-parser 函数签名解析 `ErbFunction.params`）的**声明槽**是否被 `KOJO_MESSAGE.ERB` 路由表的**转发实参**覆盖。
- **不一致定义**：声明槽 > 转发槽 ⇒ 多出的槽在调用时**永远**收引擎默认值（数值 0 / 字符串空串），声明无效——产出结构化 `warning`（`ConventionIssue`，ruleId = `eratw.kojo-call-slot-coverage`）。
- **覆盖语义 = 存在性**（关键决策，见下）：**任一**匹配模板转发了该槽即不算「永远」——逐类取所有匹配模板的 int/str 槽数**最大值**（`maxForwardedSlotsFor`）。

#### 交付物

1. **`call-protocol.ts`**：
   - `ROUTE_LINE_RE` 修复 TRYC 系关键字：`\b(?:TRYC?)?CALLFORM`（原 `(?:TRY)?CALLFORM` 漏 `TRYCCALLFORM`）。引擎确证：`ERB_EXCOM.khp` line 175 声明 `TRYCJUMP,TRYCCALL,TRYCGOTO,TRYCJUMPFORM,TRYCCALLFORM,TRYCGOTOFORM,CATCH,ENDCATCH`；实测整合版 214 处 `TRYCCALLFORM`（缺函数时兜底惯用法，配套 CATCH/ENDCATCH）。
   - 新增导出接口 `EratwCallProtocol extends KojoCallProtocol`，方法 `maxForwardedSlotsFor(functionName): { int: number; str: number } | null`（无匹配 → null）。
   - `loadEratwCallProtocol` 返回类型改为 `Promise<EratwCallProtocol | undefined>`；`slotsFor`（字面最长优先排序）**保留给 UI 展示**，覆盖判定不复用它。
2. **`conventions.ts`**：新增规则 5 `createCallSlotCoverageRule(getProtocol?)`；`declaredSlotCounts(params)`（`ARGS` 前缀 → str，`ARG` → int，兼容 `ARG`/`ARG:n` 两形态）；`createEratwConventions` 由 4 条扩为 5 条。
   - 依赖注入：`ConventionCheckContext` **刻意不暴露 adapter**（架构铁律），故以闭包注入 `getProtocol?: () => EratwCallProtocol | undefined`；协议不可用 → 规则返回 `[]`（降级，不误报）。
3. **`plugin.ts`**：`currentProtocol` 类型换 `EratwCallProtocol`；`conventions: createEratwConventions(() => currentProtocol)`。

#### 关键设计决策

- **存在性覆盖语义（非字面最长优先）**：TRYC 修复后曾误用 `slotsFor`（字面最长优先）判定，导致 `_CHILD_%ARGS:1%`（0 槽、literalLen 21）抢占通用 `_EVENT_` 模板（literalLen 15）→ 156 条误报（CHILD_RAISING 声明 2int+1str 被判「转发 0」）。用户任务措辞「**永远**收引擎默认值」锁定**存在性**语义：只要有一条匹配模板转发了槽，该槽在部分调用路径上就**不是永远**默认。改用 `maxForwardedSlotsFor`（max-over-all-matching）后误报归零，issues 193→36。
- **`slotsFor` 保留字面最长优先**：那是「UI 展示一条最可能命中」的语义（面板场景参数输入的默认来源），与覆盖判定是两个问题——一个问「实际走哪条」，一个问「是否存在任一转发」。两者不复用同一排序。
- **不碰 plugin-api**：`KojoCallProtocol` 是跨游戏契约；`maxForwardedSlotsFor` 是 adapter 侧实现细节 → 在 eratw-adapter 内 `extends` 扩展（`EratwCallProtocol`），conventions 从同包导入扩展类型。
- **`ui-convention-report` 零改动**：新规则经既有 `ConventionRule[]` 通道注册，面板按 ruleId 自然消费（本次只新增一条规则，未动面板）。

#### 测试

- **单测** `tests/conventions.test.ts`（+4）：声明槽多于转发 → warning（message 含「数值槽 声明 3 / 转发 2」）+ characterNo 归属；不超过 → 无问题；协议不可用（`() => undefined`）→ 降级 `[]`；协议不认识该函数 → 跳过。
- **单测** `tests/call-protocol.test.ts`（+5，「模板具体性与覆盖语义」）：DAILY_EVENT 字面最长优先（7 槽 = 5int+2str）；`_26_1` 取字面（1 str）；TRYCCALLFORM 同模板多行取 4 int；`maxForwardedSlotsFor` 逐类最大（CHILD_DAILY={1,0} / CHILD_FOO={0,0} / DAILY_EVENT={5,2} / ONABARE={4,0} / `_26_1`={2,1}）；协议不认识 → null。
- **真实语料** `tests/call-slot-coverage.corpus.test.ts`（`describe.skipIf(!KOJO_SMOKE_PROJECT)`）：真实工程 issues **36** 条，全 warning，全为「数值槽 声明 1 / 转发 0」，含官方模板 `M_KOJO_ORTHODOX_MESSAGE_PALAMCNG_F_K49`。
  - 36 = `MESSAGE_PALAMCNG_{D,F}`（33+2）+ `COLOR`（1）家族上多声明的 1 个 ARG；路由表对这些家族**无参转发**（如 `TRYCALLFORM M_KOJO%KOJO_NAME%_MESSAGE_PALAMCNG_F_K{NO:TARGET}` 无括号）。
- **真阳性核验**（抽样逐个查路由表）：`M_KOJO_少女之梦_MESSAGE_PALAMCNG_F_K1(ARG)` / `M_KOJO_別人変身版_COLOR_K69(ARG)` / `M_KOJO_不坠之月_MESSAGE_PALAMCNG_D_K15(ARG)` / `M_KOJO_ENG01_MESSAGE_PALAMCNG_D_K36(ARG)` 均只声明未获转发 → 按定义成立（「宁可漏报不可误报」原则下亦为确定真阳性）。
- **集成冒烟** `kernel/tests/integration-plugins.test.ts`：`ruleCount` 期望 5 → **6**（引擎内置 1 + adapter 5）；新增 `byRule.get('eratw.kojo-call-slot-coverage') === 36`。

#### 验证

- vitest 全量 **564 passed / 7 skipped**（无 smoke）；带 `KOJO_SMOKE_PROJECT` 全量 **569 passed / 2 skipped**。
- typecheck **root + app 双跑 ✅**；`audit:decoupling` ✅（13 插件）。
- 真实工程集成冒烟 ✅：**回放基线逐字不变**（K49 1356 函数 / 11685 谓词 / 未知 **3741** / exact **836**）。

#### 并行线冲突记录

- 同期 v0.3 主线（S1，本文件 §5.26）已在 `plugin-api/src/sugar.ts` + `kojo-sugar/tests/goldens/**` 落地，本线**零文件交集**。
- §5.26 遗留待办「adapter 线落地后需同步 `integration-plugins.test.ts:148` 的 `ruleCount`（5 → 6）」由本线**已完成**。
- 本线只提交自己边界内文件（`packages/plugins/eratw-adapter/**` + kernel 集成 `ruleCount` 断言 + docs）。

---

### 5.28 语法糖 S2 批 · `kojo-sugar` 转译内核（v0.3 批 S2 实施记录：三段式转译 + 糖侧 lint）

> 依据：`docs/HANDOFF.md` §6.19；输入冻结：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（v1.2）+ S1 契约 `plugin-api/src/sugar.ts`。
> 边界：新增 `packages/plugins/kojo-sugar/**`；改动 `convention-linter`（新增 1 条内置规则）+ `erb-parser`（公开导出 `scanControlFlow`）+ kernel 集成 `ruleCount` 断言（1→2 内置）+ docs。**未碰**写盘（S3）、UI/预览（S4）、升糖（S5）；**未动 spec**。

#### 交付物

1. **新插件 `packages/plugins/kojo-sugar/`**（服务 `sugar.transpile`，纯函数语义，无 IO）：
   - `keywords.ts`：中文关键字表（`Map<词, KeywordId>`）+ 保留代词 + `续` 标记 + 运算符表（按长度降序）。
   - `lexer.ts`：行式词法。判定顺序 = 空行 → 注释 → `@` 原生块起 → 原生指令/`$标签` → 块头（全角冒号收尾）→ 单行块头（`如果 条件： 内容`）→ 行内随机（`随机 「甲」,「乙」`）→ 头部声明 → `别名 X = 目标` → 表达式头（`左值 = 如果/当 …：`）→ 赋值 → `心形` → 文本。
   - `parser.ts`：缩进配对 → `SugarNode` 联合（TextLine / HeartLine / IfBlock / IfExpr / WhenBlock / WhenExpr / RandomBlock / RandomInline / ChoiceBlock / ColorBlock / RawLine / RawFunctionBlock / AliasDecl / TimingBlock）。块体缩进必须比块头深；`ifExpr`/`whenExpr` 校验"分支体恰为单表达式"+"必须含 `否则`"。
   - `expression.ts`：表达式降糖（别名替换 §5.0 → 属性访问 §3.8 → 运算符中文→英文 → 字符串族判定）+ 字符串字面量切片。
   - `codegen.ts`：产物生成（TAB 缩进统一）。
   - `service.ts`：`transpile`（源 → `{ erb, sourceMap, diagnostics }`）+ `parse` + `sourceOf`；诊断排序。
2. **四处登记**：`package.json`（workspace 包）+ root `tsconfig.json` paths + `vitest.config.ts` aliases + `app/vite.config.ts` aliases + `app/package.json` deps + `app/src/bootstrap.ts` 注册。devDeps 增 `erb-parser` / `condition-extractor`（**仅测试**用，解耦审计规则 C 豁免测试文件）。
3. **糖侧静态规则** `convention-linter/src/rules/sugar-conventions.ts`：内置规则 `sugar.static-conventions`（零游戏知识、纯文本扫描、**仅对 `.kojo` 生效**），含 4 条子规则：
   - `sugar.cont-inside-quotes`（§3.3）：`续`/`~`/`cont` 等标记紧贴右引号内侧 → error。
   - `sugar.multiple-choice-blocks`（§3.7）：同一时机块体内 ≥2 个 `选项`/`choice` 块头 → error（嵌套同现）。
   - `sugar.expr-missing-else`（§3.5/§3.6）：表达式 `如果`/`当` 块体内无 `否则` → error。
   - `sugar.readonly-alias-assign`（§5.0）：同文件内声明的只读别名（数字/字符串/`角色:` 右值）作赋值左值 → error。
4. **`erb-parser` 公开导出 `scanControlFlow`**（与既有 `parseErbText` 等同列纯函数）：可回放性验收测试需要，非新能力。
5. **新增测试**：`kojo-sugar/tests/golden.test.ts`（§6.1/§6.2 逐字节）、`transpile.test.ts`（97 项，覆盖 §3 每条糖 + §5 算法 + 错误路径）、`replayable.test.ts`（3 项，零 opaque）；`convention-linter/tests/engine.test.ts` +11 项。

#### 关键设计决策

- **§5.2 纯条件行前置判定**：整行只含 `{cond ? X : ""}`（假分支空/省略）→ 编译为 `IF … / PRINTFORM… / ENDIF`，而非行内 `\@…\@`（后者假分支输出空串 + `W` 无条件换行 = 玩家看到"莫名停一下"）。
- **`else` 分支 `condition` 归一为空串**（契约 §`IfBranch`）：`parseIfBlock` 同时服务语句级 `ifBlock`（头是 `ifHead`）与表达式 `ifExpr`（头是 `exprHead`）——两者的条件原文分别在 `condition` / `rest` 上，统一抽取，避免 `else` 分支 `undefined` 导致下游 `lowerExpression` 崩溃。
- **表达式分支体承载形态**：行式词法把裸表达式行（`"热情"`）归为 `textLine`（正文在 `_raw`），故 `renderExprValue` 同时接受 `rawLine.text` 与 `textLine._raw`。
- **单行块头正则用贪婪回溯**：`^([^\s:：]+)\s+(.+)[:：]\s+(\S.*)$`——条件段自身可能含冒号（`FLAG:70`/`CFLAG:2`），懒匹配会在那里截断（曾把 `FLAG:70` 切成 `FLAG` + `70`）。
- **CJK 后 `\b` 不成立**：`/^(当|如果)\b/` 对中文失效（`\w` 默认不含 CJK），插值保护改用 `(\s|$)`。
- **糖规则合成一条 `ConventionRule`**：四项都属"糖侧静态约定"，归为一个语义单元便于报告/UI 计数；每条 issue 仍带细分 `ruleId`，UI 可按 `ruleId` 再分组。
- **§6.2 golden 是摘录**：从 `IF LOCAL` 起、到 `ENDIF` 止（排除尾随 `RETURN 1`），且规范呈现时整体 +1 TAB 缩进——比对时去掉一级 TAB 后切片。

#### 验证

- vitest 全量 **679 passed / 5 skipped**（无 smoke；相对 §5.27 的 564 增 +115）。
- typecheck **root + app 双跑 ✅**；`audit:decoupling` ✅（13 插件）；app `vite build` ✅。
- 真实工程集成冒烟 ✅：**回放基线逐字不变**（K49 1356 函数 / 11685 谓词 / 命中 1549 / 未命中 6395 / 未知 **3741** / exact **836** / partial 482 / unknown 38）。
- **产物过 condition-extractor 零 opaque** ✅（两份 golden + 覆盖 §3 全形态的合成样例）。

#### 并行线冲突记录

- §5.27 遗留待办「adapter 线 `ruleCount` 6」由本线**延用为 7**（内置 1→2：新增糖侧静态规则）—— `integration-plugins.test.ts:148` 已同步为本批边界内的正确值。
- S1（§5.26）的 `describe.skip('S2 待启用…')` 占位块已删除（逐字节断言正式落到 `kojo-sugar/tests/golden.test.ts`）；`.expected.erb.todo` 文件名保持冻结口径（S2 起参与比较）。

---

### 5.29 语法糖 S3 批 · 编译产物写链路（v0.3 批 S3 实施记录：`.kojo` → 合规 `.erb` 落盘）

**目标**：把 S2 的纯转译内核接上磁盘——转译 + 编码组装 + 双闸写 + 备份 + 回读验证一体（`compileToFile`），并确立产物落盘的**编码口径**。

#### 交付物

**契约扩展**（`packages/plugin-api/src/sugar.ts`，零游戏名词）：

| 新增 | 形状 | 说明 |
|---|---|---|
| `SugarCompileEncoding` | `{ bom, eol: 'lf'\|'crlf', trailingNewline }` | 编码口径（**字节层**，不是 `EolStyle` 文本语义） |
| `SugarCompileOptions` | `extends SugarTranspileOptions` + `encoding?` + `writeSourceMap?` | 编译选项 |
| `SugarCompileResult` | `{ erbPath, byteSize, backupPath, sourceMapPath?, diagnostics }` | 落盘结果（回读通过才返回） |
| `SugarCompileError` | `Error` 子类 + `targetPath` / `backupPath` / `diagnostics` | 编译域失败（**携带上下文**，fail-closed） |
| `SugarCompilerDeps` | `{ io, transpile, log? }` | 编译依赖（让写盘顺序可被替身精确驱动） |
| `SugarTranspileService.compileToFile` | `(source, targetPath, options?) => Promise<SugarCompileResult>` | **唯一含 IO** 的方法 |

契约头注同步改写（原"本契约不含任何 IO"→ 分层说明：纯函数面 + 唯一含 IO 入口）。

**IO 契约扩展**（`packages/plugin-api/src/io.ts` + `packages/kernel/src/io.ts`）：

- `FileIO.ensureDir(path)` 新增——**与 `writeBytes` 同闸**（`assertWritable` 后走 `bridge.ensureDir`）。
  - 用户决策：原任务写"经 kernel io `ensure_dir` 创建"，但 `FileIO` 契约本无此方法（只有 `PlatformBridge` 有）；选择**补契约 + 内核实现**（而非依赖平台桥隐式 mkdir 或编译前检查），语义最清晰。
  - 关键安全点：**目录创建同样不能越权**——否则会先在域外造出目录，违反"游戏目录整体只读"。

**写链路实现**（`packages/plugins/kojo-sugar/src/compile.ts`，新文件）：

```
1. 转译 + 守卫   → error 诊断 → 抛 SugarCompileError（不产半成品、不建目录、不备份、不写盘）
2. 编码组装      → encodeErbBytes(text, encoding)（BOM + 换行 + 末尾换行）
3. 目录          → 父目录不存在 → io.ensureDir（域内才建）
4. 备份          → io.backup(target)（目标已存在才做；不存在返回 null）
5. 写盘          → io.writeBytes（第一道闸；越权 WriteNotAllowedError 原样传播）
6. 回读验证      → io.readBytes → 字节级比对 → 不一致抛 SugarCompileError（携带备份路径）
7. （可选）旁挂  → writeSourceMap: true 时写 .map.json（同样备份 + 回读）
```

顺序即安全语义（复刻 §5.23 注入器范式）：**守卫先于一切副作用**；越权写抛出时备份已做、原文件未覆盖；回读失败报错消息必带备份位置。

`service.ts`：`compileToFile` 接 `SugarCompilerDeps`（未注入 `io` 的实例调用即显式抛错，绝不静默假装成功）。
`index.ts`：`requires` 增 `KernelServices.IO`；服务实例注入 `io` + `ctx.log`；头注改写（写盘已属本插件）。

#### 关键设计决策

1. **编码口径（重大——与规范 §8 的 CRLF 断言冲突，以语料为准）**：
   全语料实测（2026-10-11，一次性 node 探针跑完即删）：

   | 范围 | 文件数 | BOM | LF-only | CRLF-only |
   |---|---|---|---|---|
   | `ERB/口上・メッセージ関連/**`（口上域） | 2,317 | 2,312 | **2,316** | **0** |
   | `ERB/**`（全树） | 3,818 | 3,776 (98.90%) | **3,787** | 3 |

   规范 §8 写"保存强制 UTF-8（带 BOM）**、CRLF**、文件末尾保留换行"——**CRLF 与语料不符**（游戏自带文件几乎全是 LF）。
   实现取 **BOM + LF + 末尾换行**：产物必须与同目录既有文件**逐字节同构**，否则作者每次保存都在 git 里产生整文件 diff（这正是"一次保存毁半库"的现代变体）。
   末尾换行：语料"有 2,564 / 无 1,254"无硬性约定，本项目统一**保留**（POSIX 惯例 + 规范 §8 明文）。
   `CRLF` 仍作为**可选项**保留（显式传 `encoding.eol:'crlf'` 时按规范字面），默认不启用。
   **用户已于开工前拍板采此口径**。

2. **编码走 `writeBytes` 而非 `writeText`**：产物是**新建/全量重写**的生成物，不存在 kernel `writeText` 的"保编码保换行"（`preserve`）语义——保谁的？自组装字节（BOM + LF + 末尾换行）语义明确且可断言。

3. **`compileToFile` 并入 `sugar.transpile` 而非另立服务键**：编译器本就是"产物流向磁盘"的单一动作；拆分只会让消费方（S4 保存 UI）承担两步编排 + 状态传递。与 §5.23 注入器"读写职责分离"不矛盾——那里分离的是**只读消费者**（回放不必依赖写权限），本处糖服务的只读面（`parse`/`transpile`/`sourceOf`）仍是纯函数，只有显式调用 `compileToFile` 才触达 IO。

4. **目录与命名的职责边界**：`compileToFile(source, targetPath)` **严格按调用方给定的绝对路径写**；`.kojo` → `M_KOJO_K{No}_{分野}.ERB` 的命名/目录推导留给 S4 保存 UI（或新建向导）。依据：真实产物布局为 `個人口上/012 Rumia [ルーミア]/ルーミア/M_KOJO_K12_イベント.ERB`（角色目录下再套一层口上名子目录），该层级由 adapter 的 `charaIndex[no].kojoDir` 给出，属编辑体验而非转译语义。
   用户决策：**由调用方给定 targetPath**。

5. **回读验证 = 字节级比对**（不是"重新 parse 生成结果确认结构无损"那样更弱的形态）：与 §5.23 注入器口径一致——落盘字节必须**逐字节等于**产物字节，这是"写入确实发生且未被中间层篡改"的最强断言。

#### 验证

- vitest 全量 **717 passed / 6 skipped**（无 smoke）。
  - **纯本批净增 = 714 − 679 = +35**（`git stash` 隔离工作区并行遗留后实测 714 passed；679 = §5.28 已提交基线）。
  - 含并行遗留的合并态 = **717**（= 714 + 并行 state-replay 多区间修复 3 项 + 其 extract 用例）。
  - `kojo-sugar/tests/compile.test.ts` 新增 **23 项**（替身层 20 + 真实磁盘端到端 3）；
  - `kernel/tests/io.test.ts` 新增 **3 项**（ensureDir 域内/域外/空白名单）；
  - `plugin-api/tests/sugar.test.ts` 新增 **2 项**（`SugarCompileError` 形状）。
- typecheck **root + app 双跑 ✅**；`audit:decoupling` ✅（13 插件）。
- 真实工程集成冒烟 ✅（**新增第 10 节**）：
  - 回放基线**逐字不变**（K49 1356 函数 / 11685 谓词 / 命中 1549 / 未命中 6395 / 未知 **3741** / exact **836** / partial 482 / unknown 38）；
  - §10 语法糖编译落盘：副本端到端 **360B（BOM+LF+末尾换行）** + 回读一致 + 备份已建 + 越权拒绝 1 项 + 编译拒绝零副作用 1 项；
  - **绝不写真实游戏目录**（目标恒为 `mkdtemp` 的 appData 临时域）。
- **golden §6.1/§6.2 逐字节断言保持通过**（kojo-sugar 现有测试零回退）。

#### 关键坑与发现

1. **任务要求的 CRLF 与语料实测冲突**（本批最重要的发现，详见决策 1）：**验收标准要回引擎/语料源码核验，不能凭规范文字**（§九-1 的又一次应验）。规范 §8 的"CRLF"极可能是从"Windows 平台 + 编辑器默认"想当然推导，而整合版实际文件全部 LF。
2. **`FileIO` 无 `ensureDir`**：契约层只有 `writeBytes`/`backup` 等；目录创建此前只能靠 `PlatformBridge`（Node 侧 `writeFileBytes` 内置 `fs.mkdir(recursive)`）。本批补契约 + 内核实现（同闸），使"先建目录再写文件"的链路在**契约层**也受第一道闸约束。
3. **TS7 的赋值窄化不可靠（复发）**：`let persisted: Uint8Array | null = null;` 后在 `try` 里赋值、`catch` 里 `throw`，TS7 仍报 `possibly null`——改为 `let persisted: Uint8Array;` 且在 `catch` 中必 `throw`（控制流保证有值）。
4. **越权在"目录创建"点即拒**：`ensureDir` 先于 `backup` 执行，故"父目录不存在 + 越权"时**备份都不会做**（更早失败 = 更少副作用，正是安全顺序要的效果）；而"父目录已存在 + 越权"时备份已做、未写盘。两种路径各有单测固守。
5. **测试替身的 `exists` 需覆盖目录语义**：真实内核 `exists` 对目录返回 true，但内存替身若只认文件，会把"父目录已存在"误判为不存在而多调一次 `ensureDir`——fixture 须显式给出目录项语义。

#### 并行线冲突记录

- 工作区存在**未提交的 state-replay 多区间修复**（`extract.test.ts` / `branches.ts` / `branches.test.ts`）：把 `CASE 1 TO 3, 5 TO 7` 多个 TO 区间的半边谓词按**成对**消费（旧实现把整段 `'and'` 并成一组 → 两个区间被 AND 成恒假）。该改动**不在 S3 边界内**、本会话未记录归属；本批的 `kojo-sugar`/`plugin-api`/`kernel` 改动与之**零文件交集**。提交时只 add 本批边界文件，**绝不 add state-replay 三文件**（留待其提交者处置）。
- 边界未做（属后续批）：UI 保存/预览（S4）、升糖（S5）、Monarch 高亮（S6）；规范 §8 的**全角空格检测告警**亦未实现（属保存期 lint，随 S4）。

---

### 5.30 语法糖 S4 批 · 糖预览三向映射（v0.3 批 S4 实施记录：糖源码行 ↔ 生成 ERB 行 ↔ 回放消息块）

**目标**：给"作者写的这一行，在这份存档状态下会走到哪、说什么"提供**数据层**答案——输入糖源码 → 转译 → **复用 `state.replay`**（不新建模拟器）→ 输出三向映射。UI 留给后续批次。

**边界（用户明确划定）**：只做数据层；**禁止改动** `kojo-sugar` 的 transpile 内核（`lexer` / `parser` / `codegen` / `expression`）与 golden；契约扩展**只允许 additive**；preview **只消费不发射**事件。

#### 交付物

**契约扩展**（`packages/plugin-api/src/sugar.ts`，零游戏名词；`services.ts` 增服务键）：

| 新增 | 形状 | 说明 |
|---|---|---|
| `WellKnownServices.SugarPreview` | `'sugar.preview'` | 新服务键（旧键 `sugar.transpile` 未动） |
| `SugarPreviewRequest` | `{ source, filePath?, fileName?, archivePath?, characterNo?, callContext? }` | 预览请求（可序列化纯数据） |
| `SugarPreviewLine` | `{ sourceLine, sourceText, generatedLines[], messageBlocks[] }` | 三向映射的一行（**糖源行为主键**） |
| `SugarPreviewMessageBlock` | `{ fromLine, toLine, text, functionName?, branches[], reachability, unknown? }` | 消息块（产物语句块粒度） |
| `PreviewReachability` | `'reachable' \| 'unreachable' \| 'unknown'` | 块可达性三档 |
| `SugarPreviewResult` | `{ transpile, lines[], structuralLines[], archive \| null }` | 预览结果（含完整转译产物，**未落盘**） |
| `SugarPreviewArchive` | `{ archivePath, characterNo, characterName, functions[] }` | 回放侧上下文 |
| `SugarPreviewFunctionReplay` | `{ functionName, fromLine, toLine, replay \| null }` | 单函数回放摘要 |
| `SugarPreviewDegradeReason` | 5 值闭集（见下） | 降级原因分类 |
| `SugarPreviewService.preview` | `(request) => Promise<SugarPreviewResult>` | 唯一方法 |
| 守卫 | `isReachableBlock` / `hasGenerated` / `hasArchive` | additive 显式类型守卫（TS7 教训 §九-10） |

**新增实现**（`packages/plugins/kojo-sugar/src/preview.ts`，新文件，零内核改动）：

```
1. 转译       → 复用注入的 transpile（与本插件 sugar.transpile 逐字节同源）
2. 产物索引   → scanProductFunctions(@名字 → 行区间) + foldMessageBlocks(非结构行连段合一)
3. 源映射反查 → sourceMap 的 generatedLine → sourceLine 建反向表（纯生成行不归属任何糖行）
4. 回放       → 逐产物函数 replayFunctions（state.replay）；失败一律**结构化降级**
5. 组装       → 糖源行 × 产物行 × 消息块（分支链按行区间几何折叠出可达性）
```

`index.ts`：`provides` 增 `SugarPreview`；**`state.replay` 是软依赖**（`try inject`，缺席则降级）——不写进 `requires`，否则回放插件未激活会让整个 `kojo-sugar` 静默 inactive（本末倒置）。`preview` 不注册任何 `ctx.bus.on`。

#### 关键设计决策

1. **"糖源行为主键"而非产物行为主键**：编辑器的锚点在糖源码（作者看的就是它），跳转/高亮/悬浮都以糖行为主键；产物行与消息块是**附着信息**。
   - 反面案例（明确拒绝）：以产物行为主键后，UI 每次点糖源码都要做一次反查，且纯糖语法行（`时机 …：` 块头）**没有产物行对应**——反查会返回空，无法定位。

2. **纯生成行不给糖行"硬塞"产物行**（反伪造映射）：`sourceMap` 里 `sourceLine === null` 的产物行（`ENDIF` / `ENDSELECT` / 包装函数骨架 / `LOCAL = 1`）**不属于任何糖行**，`generatedLines` 为空数组。
   这是"三向映射"可信度的地基：若把骨架行硬挂到最近的糖行上，作者点某行会看到一堆不属于它的产物，**映射比没有更糟**。

3. **信封链（envelope chain）不参与可达性折叠**（本批最重要的发现）：
   `codegen` 为每个时机生成 `IF LOCAL` 包装守卫；`LOCAL` 是**语言局部量**（快照里不存在），回放器只能报 `unknown('pseudo')`。若让它参与折叠，**每个块都被污染成 unknown**——预览信息量归零。
   判据（**纯源映射，零游戏/引擎知识**）：链头产物行**无糖源归属**（`sourceLine === null`）且链走向 `unknown` → 信封。
   `branches` 里**仍然照列**信封链（作者可见性优先），只是不算进 `reachability`。

4. **可达性折叠必须"所有覆盖链都通过"而非"任一通过"**：
   外层信封链的 `takenLine` 是它自己的头行，其体涵盖整个函数——用"某一条 taken 链命中即可达"会**恒真**，内层 `SELECTCASE` 的分支归属就白算了（实现中途踩到，测试用 `TFLAG:193 = 1/2/9` 三档把这条钉死）。
   正确判据：块须落在**每一条**覆盖链的 taken 分支体内（`memberOwningLine(chain, blk.fromLine) === chain.takenLine`）。

5. **链覆盖判定用"线性嵌套"几何**（无 goto 跨块）：
   `C` 覆盖行 `L` ⟺ `C.headLine < L` 且 `(C.headLine, L)` 之间**没有同深度或更浅**的链开起（有 = C 的体已闭合）。这样不必知道块尾行（契约未给）也能算对嵌套。

6. **降级是"分类"而非"布尔"**（5 值闭集）：`no-archive-requested`（正常路径：纯糖预览）/ `no-character`（糖源码无 `角色:` 且请求未给）/ `replay-service-unavailable` / `archive-unreadable` / `replay-failed`。
   UI 需要区分"作者没给存档"（常态，不提示）与"存档坏了/回放没装"（要提示）——一个布尔会让这两种处置混在一起。**转译 error 也不抛错**：诊断原样带出、骨架照给，策略留给调用方。

7. **坐标契约（写进契约头注，本批已知边界）**：三向映射以**本次产物的行号**为共同坐标系——`FunctionReplay.branches[].headLine` / `PredicateReplay.line` 必须与产物同源。
   生产现实：`state.replay` 是**从磁盘读函数体**的（行号 = 该 `.erb` 文件行号），而预览跑的是**未落盘**的内存产物。S4 只做数据层与折叠逻辑，**不替这一层做决定**；契约与测试里显式固化该前提，未来接真实"保存后 .erb"的批次据此装配。

#### 测试（`packages/plugins/kojo-sugar/tests/preview.test.ts`，28 项）

| 组 | 覆盖 |
|---|---|
| 纯逻辑 | `scanProductFunctions` 行区间（闭区间）/ `isStructuralLine`（含 `CASEELSE` 必须在 `CASE` 前判、`CALL X_1` 骨架 vs `CALL HPH_PRINT(…)` 文本）/ `foldMessageBlocks` 连段合一 |
| 三向映射 | 每糖源行一条目；`generatedLines` 并集 == `sourceMap` 非空归属集；**纯生成行绝不出现在任何糖行的 `generatedLines` 里**；纯糖语法行 `generatedLines: []`；结构行清单 |
| **S1 golden 回放** | §6.1 走**真实 `StateReplayEngine`**（mock `parseArchive`/`functionPredicates`，不新建模拟器）：`TFLAG:193 = 1` → CASE 1 可达、CASE 2,3 CASEELSE 不可达；`=2` 翻转；`=9` 走兜底。§6.2 选项/心形/随机块定位 |
| 信封链 | `isEnvelopeChain` 单测；§6.1 上 `IF LOCAL` 不污染块，而 `IF TALENT:TARGET:胆怯`（具名索引不可解析）**如实报 unknown 且带原因**（不掩盖） |
| 降级 | 无存档 / 无回放服务 / 存档坏 / 回放抛错 / 角色号不可得 / 显式 `characterNo` 优先 —— 全部不抛错 |
| 边界 | 转译 error 仍出骨架；非字符串输入抛 `TypeError`；并发调用互不干扰 |
| 装配 | 服务键值；插件 `provides` 两项且 `requires` **不含** `state.replay`；无回放服务时插件仍激活且预览降级可用 |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **745 passed / 6 skipped**（S4 新增 **28** 项；717 → 745，**零回归**） |
| `pnpm typecheck`（root） | ✅ exit 0 |
| `pnpm typecheck`（app / `packages/app`） | ✅ exit 0 |
| `pnpm audit:decoupling` | ✅ A/B/C 全绿（13 插件；新增 `preview.ts` 零游戏名词、零交叉 import） |
| golden §6.1 / §6.2 逐字节断言 | ✅ 未触碰，原样通过（`kojo-sugar` 既有测试零回退） |

#### 关键坑与发现

1. **`TFLAG` 是全局变量，不是角色变量**：`state-replay/src/var-model.ts` 的 `GLOBAL_INT_1D` 含 `TFLAG` —— mock 存档若把 `TFLAG` 放进 `chars[0].vars`，回放器**静默读到 0**（`readTopVar` 找不到顶层变量时，已知名回默认值 0，不报错）。测试夹具必须放顶层 `vars`。
   → 教训：**"读不到就默认 0"这类引擎语义会让夹具写错变成"看起来对但走向错"**；测试必须用"不同状态 → 不同走向"的对照（本批用 `TFLAG:193 = 1/2/9` 三档）才能钉死。
2. **分支链由 `statements` 构造，不由 `predicates`**：`buildBranchOutcomes(detail.statements, predicates)` —— 只平移 `predicates[].line` 时 `branches[].headLine` **纹丝不动**（排查耗时最久的一处）。测试的坐标还原必须同时平移 `statements` / `predicates` / `assignments` / `returns`。
3. **信封链的 `outcome` 会随坐标对齐而变**：坐标错位时 `IF LOCAL` 报 `unknown('opaque')`，对齐后报 `taken`。故信封判据不能只写"`unknown`"，还须叠加"链头无糖源归属"（本批实现即如此，两侧都覆盖）。
4. **`CASEELSE` 的前缀匹配顺序**：`startsWith('CASE ')` 不会吞 `CASEELSE`（后者无空格），但若写成 `startsWith('CASE')` 就会——结构行前缀表**有序**，注释里明确标注了这条。
5. **§6.2 golden 无 `角色:` 头**：预览的角色号反推（产物 `_K{n}`）在该 fixture 上取不到 `K` 段以外的信息——测试用显式 `characterNo` 覆盖"无 `角色:` 也能回放"这条路径。

#### 边界未做（属后续批）

- 预览 UI（Monaco 高亮/悬浮/跳转、消息块气泡、可达性着色）——S4 只交数据层；
- 逐字符最终渲染串（FORM 展开 `%…%` / `{}` / `\@…\@`）——需 FORM 求值器，与规范 §9 待实测第 4 条同批；
- 保存期全角空格告警（规范 §8）——仍待后续批次；
- 糖源码 `角色:` 的**直接从 AST 取**（当前 preview 由产物 `_K{n}` 反推，依赖产物形态）。

---

### 5.31 语法糖 S5 批 · 糖提升建议器（v0.3 批 S5 实施记录：原生 ERB → 糖候选，round-trip 自证）

> **方向与 S2 相反**：S2 = 糖源码 → 原生 ERB（降糖）；S5 = 原生 ERB → 糖候选（升糖）。
> 设计稿：`docs/LIFT-SUGGESTER-DESIGN.md`。表层语法权威：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugins/kojo-sugar/src/lift.ts` | **新增**（~1200 行） | 识别器 + round-trip 自证 + 四类糖装配 |
| `packages/plugins/kojo-sugar/src/index.ts` | 修改 | `provides` 追加 `sugar.lift`；装配 `createSugarLiftService`；新增软取助手 `scanFlowOf()` / `parseExprOf()`；导出 lift API |
| `packages/plugins/kojo-sugar/tests/lift.test.ts` | **新增**（38 项） | 四类糖三路验证 + 降级分支 + mini-game / fixtures/sugar 集成 |
| `packages/plugin-api/src/sugar.ts` | 修改（additive） | S5 契约块：`SugarLiftKind/Confidence/RoundTrip/Candidate/SkipReason(11)/Skip/Request/Result/Service` + `isVerifiedCandidate` / `hasCandidates` |
| `packages/plugin-api/src/conditions.ts` | 修改（additive） | `ConditionExtractorService` 新增 `parseExpression(text)`（无状态纯函数，不依赖索引） |
| `packages/plugins/condition-extractor/src/engine.ts` | 修改 | `ConditionEngine` 实现 `parseExpression`（转出为**服务方法**，便于消费方经服务槽依赖） |
| `packages/plugins/condition-extractor/src/index.ts` | 修改 | 去掉已无用的 `parseExpression` 导入（插件不再直接导出给交叉 import 用） |
| `packages/plugins/kojo-sugar/tests/preview.test.ts` | 修改（1 项） | S4 装配断言更新为 `provides` 三项（additive，既有两键顺序不变） |

#### 关键设计决策

1. **自证机制（round-trip or nothing）**：候选的成立**不由形态决定，由转译决定**。对每个候选的糖片段包一个最小 `.kojo` 壳（`角色: {n}` + `时机 指令 {i}：` + tab 缩进的体）→ 调 **本插件的 S2 `transpile`** → 取 `IF LOCAL` 与配对 `ENDIF` **之间**的正文 → 双侧 `normalizeIndent` → 逐字节比对。不一致 → `roundtrip-mismatch` 降级，**不入 `candidates`**。
   → 误报在结构上不可能发生；代价是有意为之的漏报。`SugarLiftConfidence` 闭集只留 `'verified'` 一档，**契约层面就不允许"可能对"的候选**。
2. **缩进归一化（`normalizeIndent`）**：原文块可能嵌在任意深度（真实语料的 `IF LOCAL` 体内即 1 级），而自证壳恒把候选放在 1 级 → 绝对缩进不可比。故自证时必须双侧去**公共最小前导缩进**（空行不参与计算）；`extractBody` 取区间**原文**，不逐行剥缩进。
3. **`IF LOCAL` 信封透传（`envelopeDepth`）**：转译器为每个 `时机` 块**自动**生成 `IF LOCAL … ENDIF`，真实语料里作者正文总被它包着。识别时探测"顶层恰为一个 `IF <裸 LOCAL>` 开块"，命中则**只在其内部识别**，绝不把信封当候选。
   - 与 S4 `isEnvelopeChain` 同源（谓词不可判定 + 产物行无糖源归属）；
   - 双重保险：转译器 expression 层**字典解析不到 `LOCAL`**（报 `unknown-identifier`），信封的糖片段本来就过不了自证。
4. **PRINT 变体映射（实测更正）**：D 后缀由**引号性**（是否台词）决定，非由 `旁白` 决定：

   | 糖写法 | 产物 |
   |---|---|
   | `「台词」` | `PRINTFORMW` |
   | `「台词」 续` | `PRINTFORML` |
   | `旁白` | `PRINTFORMW` |
   | `旁白 续` | `PRINTFORML` |

   → `PRINTFORMDW 旁白` / `PRINTFORMDL 旁白` **无法 round-trip**，自动被拒（正是自证的价值）。`PRINTFORM` / `PRINTFORMD` / `PRINTL` 系无糖形态 → `unsupported-print-variant`。
5. **IF 比对区间含 `ENDIF`**：糖块产物**必然补回** `ENDIF`，故原文比对区间取 `[fromLine, toLine]`（含闭行），否则生成体多一行而误判失败。
6. **块级跳过同时 `markConsumed`（`skipBlock`）**：块级跳过若只标 `skipped` 不标 `consumed`，其成员行会被后续单行扫描逐个"提升"，产生碎片化建议（形态像糖但整块对不上）——本批让跳过区间**同时** `consumed`。
7. **`alias` 类定案：v1 不出候选**（只报 `not-covered`）。实测证明原生 ERB 侧**没有可验证的别名落点**：`别名` 是**糖源码层预处理**（作者写裸标识符 → 糖层展开）；糖层对原生 ERB 的 `%…%` 与全大写直通行**原样透传**，别名替换不介入 → 套上声明再转译必得"多一行声明、正文未变"的产物，round-trip 必不成立。保留类型与扫描（`ALIAS_MIN_OCCURRENCES = 3`）以备将来重开。
8. **零交叉 import（解耦审计 C 项）**：`kojo-sugar` **不得** import `@kojo/plugin-erb-parser` / `@kojo/plugin-condition-extractor`。两者改为**软取服务槽**（`try { ctx.inject(...) } catch { return undefined }`）：`scanControlFlow` 缺席 → 退回**内置兜底扫描**（`builtinScanControlFlow`）；`parseExpression` 缺席 → 保守跳过所有带条件的块。为此在 `ConditionExtractorService` 上 **additive** 新增 `parseExpression`（无状态、不依赖索引），**既有签名零改动**。

#### 测试（`packages/plugins/kojo-sugar/tests/lift.test.ts`，38 项）

- **每类糖三路**：① 正例命中（断言 `kind` / 行区间 / `confidence === 'verified'` / `roundTrip.verified`）；② 干扰反例跳过（`unsupported-print-variant` / `unparsable-condition` / `label-or-goto` / `macro-or-directive` / `mixed-domain-line` / `comment-interference`）；③ **round-trip 降级**（构造"看着像糖但转回去对不上"的样例 —— 如 `PRINTFORMDL 旁白`、块内非糖控制流 —— 断言它**不在** `candidates` 里，`skipped` 带对应原因）。
- **`IF LOCAL` 信封**：正文被信封包着时不把信封当候选，且内部块正常提升。
- **随机块**：`LOCAL = RAND:n` + `SELECTCASE LOCAL` + `CASE 0..n-1` 全覆盖 → `随机` 块；否则退化 `当` 块。
- **alias**：断言"只提示、不出候选"（`not-covered`）。
- **集成**：`fixtures/mini-game` 真实形态口上 ERB 上跑，断言产出的候选集合；`fixtures/sugar/sample-310.kojo` 做**降糖 → 升糖闭环**（S2 产物喂回 S5，断言能识别回来）。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **783 passed / 6 skipped**（S5 新增 **38** 项 + preview 装配断言 1 项更新；745 → 783，**零回归**） |
| `pnpm typecheck`（root） | ✅ exit 0 |
| `pnpm typecheck`（`@kojo/app`） | ✅ exit 0 |
| `pnpm audit:decoupling` | ✅ A/B/C 全绿（13 插件） |
| 真实游戏目录冒烟（`KOJO_SMOKE_PROJECT=<eraTW>`） | ✅ 1 passed（含语法糖编译落盘回读一致 / 越权拒绝 / 编译拒绝零副作用） |
| golden 逐字节断言 / S2 内核 / `preview` · `compileToFile` 行为 | ✅ 未触碰，零改动 |

#### 关键坑与发现

1. **`LOCAL` 标识符不对称**：codegen 产出 `LOCAL = 1` / `IF LOCAL` / `SELECTCASE LOCAL`，但 expression 层**字典解析不到 `LOCAL`**（`unknown-identifier`）→ 故 `IF LOCAL` 的糖片段**永不**能通过自证。这既是信封必须透传的原因，也是"自证"给出的额外护栏。
2. **缩进不可比是隐形炸弹**：最初用"产物逐行剥一个 tab"再比对，在"原文块嵌在 1 级"时系统性失败。改为**双侧去公共最小缩进**后，深度无关。
3. **`node -e` 探测脚本的引号地狱**：反复用临时 `_probe.test.ts` 探测转译器行为（每次用完删除），比在 `node -e` 里堆多层引号可靠得多；且模板串里绝不能写 Markdown 反引号。
4. **契约扩展的最小面**：`parseExpression` 做成**服务方法**而不是包导出，是"插件不得交叉 import"的直接推论——**导出面的形状由审计规则决定，不由方便决定**。
5. **S4 装配断言会因 additive 而失败**：`preview.test.ts` 用 `toEqual` 断言了 `provides` 数组的**精确内容与顺序**，S5 追加 `sugar.lift` 必然打破它。这是"故意的严格断言"——更新时同步在断言里注明 additive 语义，保持顺序不变。

#### 边界未做（属后续批）

- **升糖 UI**（候选列表 / 高亮 / 「应用」按钮 / diff 预览）——S5 只交数据层（`sugar.lift` 纯函数服务）；
- **`选项` 块**（`PRINTBUTTON` + `INPUTS` + `SELECTCASE RESULTS` 三段合并）——形态明确但跨块区间合并风险高，留 v1.1；
- **`心形` 块**（`CALL HPH_PRINT(@"…","w")`）——四类之外，留 v1.1；
- **`别名` 的自动建议**——受糖层透传语义限制（见 5.31.7），重开条件 = 糖层将来对原生 ERB 的别名展开介入；
- **列级定位**——候选只报行区间（行级），列级留 S6；
- **带信封的整函数升糖**（产出 `时机` 块建议）——留 S5-UI 批。

### 5.32a 语法糖 S5 增强批 · 旁白口径 D 归属（v0.3 批扩展实施记录：不加新语法，改自证口径）

> **方向**：修正 S5 期「D 后缀由引号性决定」的**结论错误**——D 归属由**两个维度**决定：
> `d = (旁白色 == 默认) 且 (not speech)`。`旁白色:` 是**糖表层早已存在**的头部开关（spec §3.1），
> 本批**不新增任何语法**，只把 lift 的自证壳从「单口径」扩成「依次试两种口径」。
> 设计稿：`docs/LIFT-SUGGESTER-DESIGN.md` §2.1（修正）/ §2.3（新增）。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugins/kojo-sugar/src/lift.ts` | 修改 | 新增 `NarrationColorMode`（`'默认' \| '作者色'`）+ `NARRATION_COLOR_MODES`；`wrapForVerification` 增参 `narrationColor`（**仅非默认时写声明行**，保既有行为逐字节不变）；`verifyRoundTrip` 改为**依次试两种口径**并返回命中口径；三处 `candidates.push`（`if-block` / `selectcase` / `print-message`）补 `narrationColor` |
| `packages/plugin-api/src/sugar.ts` | 修改（additive） | `SugarLiftCandidate` 新增可选字段 `narrationColor?: '默认' \| '作者色'`（含消费方语义长注释：**`作者色` 时必须把 `旁白色: 作者色` 写入文件头**，否则落盘产物与原文不一致；`kind === 'alias'` 可缺省） |
| `packages/plugins/kojo-sugar/tests/lift.test.ts` | 修改（38 → 44 项） | 2 个原「降级」用例改「正例」（`PRINTFORML 她红着脸，小声嘟囔着。` → `作者色`；`PRINTFORMW 她看起来很高兴。` → `作者色`）；`PRINTFORMDW 「你好。」` **维持降级**；`PRINTFORMDL 她什么也没说。` → `默认`（口径最小化）；首个正例加 `narrationColor === '默认'`；**新增 `describe('S5 / 旁白口径 …')` 6 项**（两种口径各自命中 / 默认优先 / 块级带径 / 分派块带径 / 默认口径下不误报作者色） |
| `packages/plugins/kojo-sugar/tests/goldens/spec-3.3-narration-default.kojo` + `.expected.erb.todo` | **新增** | 无 `旁白色` 声明 → `PRINTFORMDW 她点了点头。` / `PRINTFORMDL 她叹了口气。` / `PRINTFORMW 「今天也来训练了？」`（**台词行不受旁白色影响**，在同一张 golden 里就是活证据） |
| `packages/plugins/kojo-sugar/tests/goldens/spec-3.3-narration-author-color.kojo` + `.expected.erb.todo` | **新增** | `旁白色: 作者色` → `PRINTFORMW 她点了点头。` / `PRINTFORML 她叹了口气。` / `PRINTFORMW 「今天也来训练了？」` |
| `packages/plugins/kojo-sugar/tests/golden.test.ts` | 修改（3 → 7 项） | 新增 `describe('golden §3.3 · 旁白口径（旁白色:）对 D 归属的作用（逐字节成对）')` 3 项：默认口径断言 / 作者色口径断言 / **两张 golden 差异仅在 D 后缀**（`unD = s => s.replace(/PRINTFORMD([WL])/g,'PRINTFORM$1')` 后二者相等） |
| `packages/plugin-api/tests/sugar.test.ts` | 修改 | golden 命名冻结断言计数 `2` → `4`（`// §6.1 / §6.2（规范原文）+ §3.3 旁白口径成对两张`） |
| `docs/LIFT-SUGGESTER-DESIGN.md` | 修改 | §2.1 映射表**修正**（原表错写 `旁白` → `PRINTFORMW`，漏了头部开关这一维）；**新增 §2.3**（2×2 语料矩阵 + 三条推论 + 引擎语义实证 + 「本批不加任何新语法」）；§4.1 契约片段加 `narrationColor?`；§5 `roundtrip-mismatch` 行注明"两种口径依次试"；§6 已知取舍 +2 条 |

#### 关键设计决策

1. **不加新语法（决定性）**：解法不在"给糖表层加行级强制 D 标记"，而在**发现 `旁白色:` 头部开关本来就能产出 `PRINTFORMW 无引号`**。lift 的自证壳原本**没写该声明** → 缺省口径下 `无引号` 必然产 `PRINTFORMDW` → 与原文对不上 → 误判降级。**修自证壳，不修语法**。
2. **口径最小化（默认优先 + 仅非默认才写声明行）**：`NARRATION_COLOR_MODES = ['默认', '作者色']` 按序试，先命中先返回。`默认` 时不写任何声明行 → **既有全部正例的壳与产物逐字节不变**（S5 的 38 项断言零改动）。这既是最小化，也是保回归的手段。
3. **口径是候选的属性，必须回写消费方**：`narrationColor: '作者色'` 的候选，**应用落盘时必须写文件头**，否则产出 ERB 与原文不一致。故契约上把它做成**必读字段**（`print-message` / `if-block` / `selectcase` 三类恒带），而不是内部诊断。
4. **引擎语义以 `_emuera_src` 为准（不按语料表面规律改）**：`D` = `ISPRINTDFUNC` → `EmueraConsole.Print.cs:81` 置 `UseSetColorStyle = false`，即**忽略 `SETCOLOR` 强制默认色**（保留 userStyle 的 FontStyle/Fontname）；`FunctionIdentifier.cs:581` 定义该标志。**`D` 与引号无任何引擎关联**——"引号决定 D"是语料的偶然相关，不是机制。
5. **缺省推导方向不能反（语料实证反证）**：全局 869,572 行 `PRINTFORM*`；无引号 D = 271,843（67.88%），有引号 D = 1,889（0.41%）。**口上域（真实目标域）无引号 D 占 70.32%**。故"无引号 → D"是缺省正解，"反着改"会为修 11.4 万行而坏 27 万行。
6. **有引号 + D 维持拒绝（`roundtrip-mismatch`）**：`PRINTFORMDW/DL 「台词」` 的唯一出路是行级强制 D，而 `旁白色` 只改旁白、改不动台词（`speech` 为真时 `d` 恒假）。量级 **1,583 行 / 有引号行的 0.35%** —— 低于"新增语法要配得上的覆盖收益"线 → 维持拒绝并在 §2.3/§6 写论证（符合用户"残余 <2% 允许维持拒绝写论证"的口径）。

#### 语料实证（eraTW 4.980 全树 3,818 ERB）

| 域 | 无引号 非D | 无引号 D | 有引号 非D | 有引号 D | 无引号 D 占比 |
|---|---|---|---|---|---|
| 全局 | 128,627 | 271,843 | 455,109 | 1,889 | 67.88% |
| **口上域** | 113,863 | 269,814 | 452,812 | 1,583 | **70.32%** |

补充：**无引号非 D 行中 79.55%（102,321 行）不在任何 `SETCOLOR` 内** → 渲染上与 D 等价但**语义上仍非 D**，恰好是本批扩出来的覆盖面；其余 26,306 行（20.4%）落在色域内，属真实语义差，可被本批正确覆盖（因为它们本来就该是 `作者色` 口径）。

#### 测试

- `lift.test.ts` **44 项**（38 → 44，+6）；`golden.test.ts` **7 项**（3 → 7，+4：3 项新用例 + 1 项由 golden 名单扩张带来的既有用例重跑）。
- 关键新断言：`PRINTFORMW 「你好。」`（引号 + 非 D，**两口径都能命中**）必须返回 `默认` —— 这是"口径最小化"的直接检验。
- golden 成对性断言：两张 golden 去掉 `D` 后**完全相等**，把"差异只在 D 后缀"变成机器可验证的不变量。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **792 passed / 6 skipped**（783 → 792，**+9**，零回归；13 插件） |
| `pnpm typecheck`（root） | ✅ exit 0 |
| `pnpm typecheck`（`@kojo/app`） | ✅ exit 0 |
| `pnpm audit:decoupling` | ✅ A/B/C 全绿 |
| 真实游戏目录冒烟（`KOJO_SMOKE_PROJECT=<eraTW>`） | ✅ 1 passed（23.2s） |
| golden 逐字节断言 | ✅ 全部 byte-identical（含新增两对） |

#### 关键坑与发现

1. **S5 的历史记录不追改，只在下游更正**：§5.31 决策 4 的表格把 `旁白` 写成 `PRINTFORMW`（应为 `PRINTFORMDW`），本批**不修改 §5.31 正文**（历史记录的可追溯性优先），改在 `LIFT-SUGGESTER-DESIGN.md` §2.1 修正，并在本段留档。**这是本批的更正对象。**
2. **`旁白色` 只作用于旁白，不作用于台词**：一度以为"加 `旁白色` 就能救有引号 + D"，实测 `speech` 为真时 `d` 恒假 → 台词行的 D 完全由写法决定。这条直接决定了决策 6。
3. **口径最小化救回整个回归面**：如果无条件写 `旁白色: 默认` 声明行，S5 的 38 项断言会大面积失败（产物多一行）。"仅非默认才写"是"零回归"的关键。
4. **`_emuera_src` 是唯一裁判**：语料统计只能给出**分布**，不能给出**语义**。先有引擎源码结论（D = 强制默认色、与引号无关），才敢断定 `无引号 + D` 只是"该处没设色"而非"作者想强制默认色"。

#### 边界未做（属后续批）

- **`alias` 类的原生落点验证（用户任务一第 2 点）**：本批**维持 `not-covered`，不出候选**。论证见 §5.31 决策 7 与设计稿 §2.2 —— 糖层的别名展开是**糖源码层预处理**，对原生 ERB 的 `%…%` / 全大写直通行**原样透传**，故任何"套声明再转译"的产物必然是"多一行声明、正文未变"，round-trip 必不成立。
  → 重开条件 = 糖层将来对原生 ERB 的别名展开介入；届时本批的"多口径自证"框架可直接复用。
- **`PRINTFORMDW/DL 「台词」`（有引号 + D，1,583 行）**：见决策 6，维持拒绝。
- **升糖 UI**：见 §5.32b。

### 5.32b 语法糖 S5-UI 批 · 升糖候选面板 + 应用链路（v0.3 批 S5-UI 实施记录：round-trip 自证的候选终于能落盘）

> **定位**：S5 只交了**数据层**（`sugar.lift` 纯函数），本批把它接成端到端可用的闭环：
> 扫描 → 候选列表 → diff → **应用**（写回 `.kojo` 源文件）。
> 写链路**逐条对齐** S3 的 `compileToFile`（编码守卫 → 备份 → `writablePaths` 第一道闸
> → 回读验证），一闸不少；落盘成功后发 `file.changed`——**这就是 BUG-5 的收尾**。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugins/kojo-sugar/src/lift-apply.ts` | **新增**（~330 行） | 升糖应用：`applyLift`（纯函数：倒序替换 + 缩进平移 + 文件头补声明，含三类 fail-closed 校验）+ `applyLiftToFile`（与 `compileToFile` 同款写链路）+ `createSugarLiftApplyService`（`onApplied` 事件发口由装配层注入） |
| `packages/plugins/kojo-sugar/src/index.ts` | 修改 | `provides` 追加 `sugar.liftApply`；装配 `createSugarLiftApplyService` 并**在此处**发 `file.changed`；导出 apply API |
| `packages/plugin-api/src/sugar.ts` | 修改（additive） | 升糖应用契约块：`SugarLiftApplyPreview` / `SugarLiftDiffHunk` / `SugarLiftApplyRequest` / `SugarLiftApplyResult` / `SugarLiftApplyService` + `SugarApplyError`（与 `SugarCompileError` 同形状） |
| `packages/plugin-api/src/services.ts` | 修改（additive） | `WellKnownServices.SugarLiftApply = 'sugar.liftApply'`（含"能力面 = 服务键面"的设计说明） |
| `packages/plugin-api/src/events.ts` | 修改（additive） | 新增 `editor.activeFileChanged: { filePath: string \| null }`——"当前打开哪个文件"是**宿主状态**，做成事件避免面板持有宿主引用 |
| `packages/plugin-api/src/index.ts` | 修改 | 导出面追加上述类型与 `SugarApplyError` |
| `packages/plugins/ui-sugar-lift/` | **新增插件** | 升糖建议面板（`ui.panel` 槽贡献；`src/panel-logic.ts` 纯逻辑 + `src/index.ts` 面板） |
| `packages/plugins/ui-sugar-lift/package.json` | **新增** | 依赖仅 `@kojo/plugin-api`（+ react peer） |
| `packages/app/src/ui/App.tsx` | 修改 | `activeFile` 变化时广播 `editor.activeFileChanged`（宿主是"当前文件"的唯一权威） |
| `packages/app/src/bootstrap.ts` | 修改 | 注册 `createUiSugarLiftPlugin()`（排在 kojo-sugar 之后） |
| `packages/plugins/kojo-sugar/tests/lift-apply.test.ts` | **新增**（23 项） | 纯函数替换/缩进/文件头 + 三类校验 + 写链路四路径（成功/备份/越权/回读失败）+ 事件发口 |
| `packages/plugins/ui-sugar-lift/tests/panel-logic.test.ts` | **新增**（25 项） | 候选列表排序 / 三态勾选 / diff 行 / 跳过项标签闭集 / 降级文案闭集 |
| `packages/plugins/ui-sugar-lift/tests/integration.test.ts` | **新增**（10 项） | 跨插件接线（服务槽顺序）+ 端到端扫描→应用→落盘→事件 + 事件纪律 |
| `packages/plugins/kojo-sugar/tests/preview.test.ts` | 修改（1 项） | 装配断言 `provides` 三键 → 四键（additive） |
| `packages/kernel/tests/integration-plugins.test.ts` | 修改（冒烟 §11 新增） | **真实口上语料**升糖应用：3,265 行 → 15 候选 → 落盘 155KB → 回读 == 预览 + 备份 + 越权拒绝 |
| 四处登记 | 修改 | `tsconfig.json` paths / `vitest.config.ts` aliases / `packages/app/vite.config.ts` aliases + `packages/app/package.json` deps |

#### 关键设计决策

1. **应用是"源文本 → 源文本"，不是"ERB → ERB"**：升糖的产物是**糖源码**（`.kojo`）。候选只在糖层成立，所以"应用" = 把源 `.kojo` 里对应那段原生 ERB 换成糖写法；**产物 ERB 由后续 `compileToFile` 负责**。这保证 round-trip 不变量在应用后仍成立（应用后重编译，产物应与应用前 ERB 语义等价）。
2. **倒序替换 + 显式重叠断言**：候选行号是**替换前**的；按升序替换会让后一个候选错位。故必须从最大行号开始。整个模块唯一的顺序敏感点 → 不靠直觉，而是**先排序再断言两两不重叠**（合法输入下不可能重叠；一旦发生就是调用方数据有问题，静默继续会写出错乱文件）。
3. **三类 fail-closed 校验**（任一不过即抛，绝不静默跳过——"应用错行"的代价远高于"拒绝"）：① 区间越界；② 候选两两重叠；③ **候选区间原文必须与 `roundTrip.originalText` 逐行一致**（这是"候选来自本份 source"的直接证据，行号漂移会在此被抓到）。
4. **文件头：只在需要时补，绝不删既有声明**：`narrationColor === '作者色'` 的候选，自证前提是文件头有 `旁白色: 作者色`——应用时必须补上，否则应用后再编译产物会与原文不一致。反之，本次没应用 `作者色` 候选而文件头已有该声明 → **不动它**（零侵入：那是作者的既有选择）。
   - 插入点必须**在所有声明行之后**：`角色:` 也是声明行且通常在第一行，若只认 `旁白色:` 就会把新声明插到 `角色:` **上面**，破坏语料惯例（`DECL_LINE_RE` 通用声明识别）。
5. **写能力 = 独立服务键**（`sugar.liftApply`，不塞进 `sugar.lift`）：`sugar.lift` 是**只读观察面**（契约明文：不读盘不写盘不发事件）。写能力必须显式声明，否则"哪些插件能写盘"就不再可审计。
   - **事件纪律不冲突**：S4 预览"只消费 `file.changed`、绝不发射"是因为它不写盘；本服务**确实改了盘**，不发事件反而是"内核不静默"铁律的破坏（编辑器不会知道文件变了）。**谁改盘谁发事件**，职责不重叠。
6. **事件发口在装配层**（`createSugarLiftApplyService({ onApplied })`）：实现层（`lift-apply.ts`）**零内核依赖**——"应用成功后要发 `file.changed`"是**接线决策**（谁有 bus 谁发）。这让实现层可单测，也让"直接调 `applyLiftToFile` 不发事件"变成可断言的事实（本批有专门用例）。
7. **UI 只做呈现 + 意图**：面板**不自建任何写逻辑**——它的"应用"就是调 `sugar.liftApply`。故写盘闸门、备份、回读一个都不少（越权同一个 `WriteNotAllowedError`）。
8. **diff 不引入通用 diff 库**：升糖的差量**结构已知**（每条候选替换一个已知闭区间），不需要"求最短编辑脚本"；把已知的东西再猜一遍只会引入不确定性。故 hunk 由**替换参数直接构造**（`removed` / `added`），逐 hunk 先 `-` 后 `+`，行数不等时**不强行对齐**（整段换整段，对齐只会制造不存在的"上下文行"）。
9. **"预览 = 落盘结果"是同一性而非相似性**：面板的 diff 预览复用后端 `apply`（dry-run），所以预览与真正应用**必然一致**；冒烟里就有这条断言（回读 == 预览）。
10. **忽略是持续意图**（两集合而非三值 Map）：`SelectState = { selected, ignored }`，忽略**免疫全选**——否则全选会把"我不想再看到这条"覆盖掉。忽略优先于选中。
11. **应用后立即重扫**：行号已变，旧候选一律作废。不重扫就会出现"用旧行号对新文本"的错行应用。
12. **当前文件走事件而非服务查询**：新增 `editor.activeFileChanged`。做成事件的理由：面板只想"知道变了"，不想"查询宿主"——查询式接口会逼面板持有宿主引用，破坏"插件不得依赖宿主实现"的分层。

#### 测试

- `lift-apply.test.ts` **23 项**：单条/多条（倒序）/缩进平移/多行糖片段/文件头三态（补声明、就地改写、零侵入）/头注横幅/alias 过滤/空候选；校验三路（越界、重叠、行号漂移）；写链路五路（成功字节级、备份、无原文件不备份、越权原样传播、回读不一致、写盘异常）；事件发口三路（成功发一次、失败不发、纯函数不发）。
- `panel-logic.test.ts` **25 项**：列表排序（乱序规整、同起点短区间在前、真实 lift 结果直接建行）、三态勾选（单选/全选/忽略免疫全选/忽略优先/一键恢复/全不选不清忽略）、diff（多 hunk、行数不等不对齐、`diffToText`）、跳过项标签**闭集覆盖**（10 个 reason 全有中文标签）、降级文案闭集。
- `integration.test.ts` **10 项**：`requires` 三键且 `provides` 为空（纯消费者）；激活后注册 `ui.panel`；**反序装配必失败**（服务槽顺序）；端到端（扫描→应用→落盘文本→事件 payload 合契约）；回读闭环（落盘后再扫描，候选为 0 = 已糖化）；越权（同闸、不发事件）；只读预览不落盘不发事件；`作者色` 自动写文件头；直接调实现层不发事件。
- `preview.test.ts` 装配断言更新为四键（additive，既有顺序不变）。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **850 passed / 6 skipped**（792 → 850，**+58**；52 个测试文件，14 插件，零回归） |
| `pnpm typecheck`（root） | 通过，exit 0 |
| `pnpm typecheck`（`@kojo/app`） | 通过，exit 0 |
| `pnpm audit:decoupling` | A/B/C 全绿（**14 插件**，新增 ui-sugar-lift 未引入交叉 import） |
| 真实游戏目录冒烟（`KOJO_SMOKE_PROJECT=<eraTW>`） | 通过。新增 §11：真实口上 `M_KOJO_K49_日常系コマンド.ERB` **3,265 行 → 15 条候选（全部 verified）→ 未建议 93 条显式列出 → 落盘 155,449B → 回读 == 预览 → 备份已建 → 越权 `WriteNotAllowedError` 拒绝** |
| golden / S2 内核 / `compileToFile` 行为 | 未触碰，零改动 |

#### 关键坑与发现

1. **文件头插入点不是"首个非空非注释行之前"**：`角色: 1` 也是声明行且在第一行——最初只认 `旁白色:`，导致新声明被插到 `角色:` **上面**。改为通用声明行识别（`键: 值`），插入点 = **最后一个声明行之后**。这条错误是单测抓出来的（"应用作者色候选"用例直接失败）。
2. **末尾换行的归一化**：`encodeErbBytes` 会"先剥已有尾换行、再补一个"。真实语料源文件本身可能已带尾换行（`preview.text` 保留了尾空行），此时 `preview.text + '\n'` 会多一个。断言必须**归一化后比对**（`norm()`），不是简单字符串拼接。
3. **真实语料不能随手挑文件**：第一版选了 `M_KOJO_K49_日記.ERB`（名字像口上），实为**日记系统**（`@DIARY_*`，几乎没有 `PRINTFORM`）→ 0 候选，冒烟失去证明力。改为按 `PRINTFORM` 数量挑（`日常系コマンド.ERB`，1,266 个），并在测试里**硬断言候选数 > 0**（否则冒烟形同虚设）。
4. **测试里的类型名要核对**：`SlotContribution` / `SlotsRegistryLike` 并不存在（正确是 `UIPanelContribution`）。vitest 不报（TS 类型被擦除），**只有 `tsc` 会报**——双跑 typecheck 的价值again。
5. **新插件必须 `pnpm install`**：四处登记只是"路径别名"，`packages/app/node_modules/@kojo/*` 的软链要 `pnpm install` 才建；否则 app 侧 `Cannot find module`。
6. **`navigator.clipboard` 在 node lib 下不存在**：面板的"复制 diff"做了安全降级（`typeof navigator === 'undefined'` 判断 + try/catch 静默）——环境限制不是错误，不该弹提示。

#### 边界未做（属后续批）

- **列级定位 / 高亮**：候选与 diff 只报行区间（行级），列级留 S6。
- **在编辑器内联显示建议**（`ui.editor.decorator` 槽）：本批只做侧栏面板，内联装饰留后续。
- **`别名` 类候选的应用**：受糖层透传语义限制（同 §5.31 边界未做 / §5.32a），维持不出候选。
- **带信封的整函数升糖**（产出 `时机` 块建议、产物直接替整个函数）：本批的候选仍是函数体内片段。
- **撤销（undo）**：应用后有备份路径，但没有"一键回滚"按钮——留 v1.1（可复用 `backupPath`）。
- **虚拟滚动**：候选列表上限 200 条、diff 上限 400 行（防 DOM 爆炸）；超大文件需要虚拟滚动才谈得上"全量可浏览"。

### 5.33 解耦补齐批 · 时机分野模板归位 adapter（v0.3 S2 遗留承诺兑现：游戏知识只进 adapter）

> 起因：`docs/REVIEW-SUGAR-DECOUPLING-2026-10-11.md` 审阅发现 B-1——`kojo-sugar/codegen.ts`
> 硬编码了 eraTW 的 10 个分野模板 + `M_KOJO`/`DIARY` 字面量 + `TFLAG:192` 位协议 + `SETBIT RESULT`
> 原语，与已批准方案（`SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §8.1-3「37 调用面模板表为
> adapter 新增」）及 6 处契约/代码头注自相矛盾；且 audit A 项只覆盖内核层，插件层门禁盲区。
> 本批兑现承诺 + 补上门禁，**不改任何产物行为**（golden 逐字节零回退）。

**契约（`plugin-api/src/game.ts`，游戏无关、零游戏名词）**
- 新增 `KojoFaceTemplate`（`template` + 可选 `success` + 可选 `segments`）与 `KojoFaceTable`
  （`faces` 表 + 可选 `registration` 三件套 + 可选 `successFlag` 位协议 + 可选 `messageCheck`
  位协议）；
- `GameAdapter` 新增可选字段 `kojoFaceTemplates?: KojoFaceTable`（与 `kojoCallProtocol` 同形 seam）；
- 诊断码闭集新增 `face-table-missing`（适配器缺表/缺某类模板时的显式降级，绝不静默）。

**adapter（`eratw-adapter/src/face-templates.ts`，新文件）**
- `createEratwFaceTable()`：按规范 §3.2 / 附录 C 全量登记（v1 有糖形态的 11 个入口 +
  其余入口的模板），三件套 / `TFLAG:192` 四档取值 / MESSAGECHECK 位协议全部入表；
- 上下文段设计：`${com}` 段的取值映射（`类型:` → `COM/SCOM/CUSTOM_COM/CUSTOM_SCOM`）由
  adapter 声明候选，**命名参数名映射**（`com` ← `类型:`）留在转译器（那是语法层语义）；
- `plugin.ts` 挂上 `kojoFaceTemplates`（纯数据无 IO，不依赖 loadProject）。

**转译器（`kojo-sugar`）**
- `codegen.resolveFace` 重写为**查表**：适配器缺表或关键字未登记 → `timing-face-unknown`
  **fail-closed，绝不回退内建模板**（回退 = 把游戏知识搬回通用插件）；
- `emitRegistration` / 配色 / `successFlag` / `emitMessageCheck` 全部改由 face table 提供
  模板与位协议；缺件时报 `face-table-missing`（warning，显式降级）；
- 装配层新增 `faceTableOf()`（与 `dictionaryOf` 同源：按 `adapterId` 匹配 `game.adapter`
  槽位），三条 transpile 路径（parse/transpile/compileToFile + preview + lift）统一经
  `makeTranspiler()` 注入，保证行为一致；
- **产物零变化**：golden §6.1/§6.2 逐字节断言未动且全绿。

**审计门禁（`tools/audit-decoupling.mjs` 新增 D 项）**
- **D(通用插件零游戏知识)**：非 adapter、非 tests 的插件源码代码行出现 `M_KOJO` /
  `DIARY{` / `TFLAG:192` / 具体游戏名 / `個人口上` → 违规（`audit-allow:` 行尾豁免保留）；
- `sav` **不在** D 项黑名单——它是 emuera 通用存档容器（`sav-parser` 是引擎级跨游戏插件），
  误列会伤及正牌通用插件（首跑实-warning 后修正）；
- 顺手清理：`ui-state-replay` 输入框占位符的 `M_KOJO_ORTHODOX_EVENT_K49_1` 示例改为游戏
  无关形态（`MESSAGE_COM_K12_310_1`）——正是 D 项设计要拦的那类泄漏；
- **门禁自证**：临时在 codegen 插入 `M_KOJO{t}_PROBE_K{n}` → D 项报违规；还原后全绿。

**测试（851 → 868，+17）**
- `eratw-adapter/tests/face-templates.test.ts`（新，7 项）：模板逐字对附录 C / 三件套无
  家族段 / 成否四档 / MESSAGECHECK 位号 / `类型:` 段映射 / `成功` 与 `指令` 的 success 形态；
- `kojo-sugar/tests/support.ts`（新）：测试共享夹具（`stubDict` + `stubFaceTable()`）——
  测试直接用 adapter 真实表（C 项对 `tests/` 豁免），贴近生产装配；
- 8 个既有测试文件全部改经夹具注入 face table；新增「装配口径」组 4 项（11 分野函数名
  逐字 / 别人版家族段单下划线 / 未登记分野 fail-closed / 成否+MESSAGECHECK 组合）；
  新增「无分野表 → timing-face-unknown」fail-closed 断言；
- `ui-sugar-lift` 集成测试的假内核槽位改为返回真实 eraTW face table（模拟生产装配）。

**验收（2026-10-11 实测）**
- `vitest`：**868 tests / 862 passed + 6 skipped**，50 文件全绿（golden 逐字节零回退）；
- typecheck root ✅ + app ✅；`audit:decoupling` **A/B/C/D 四项全绿（14 插件）**；
- 真实语料集成冒烟（`integration-plugins.test.ts`，KOJO_SMOKE_PROJECT）：见 HANDOFF §6.24。

### 5.34 语法糖 S4-UI 批 · 糖预览面板（v0.3 批 S4-UI 实施记录：数据层的三向映射第一次带上 UI）

> **定位**：S4 只交了**数据层**（`sugar.preview` 纯服务），本批把它接成可浏览的面板：
> 当前 `.kojo` 文件 → `sugar.preview`（转译 + 源映射 + 诊断；有存档时附状态回放）→
> 面板呈现「糖源码行 ↔ 生成产物行 ↔ 消息块可达性」。
> **新插件 `ui-sugar-preview`**（第 15 插件，`ui.panel` 槽 order 74）。
> 本批**只做呈现 + 导航意图**：转译 / 源映射 / 回放折叠一个都不自建——
> 这就是"一切皆插件"对 UI 的要求（能力缺席要"退化可见"，不能静默）。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugins/ui-sugar-preview/` | **新增插件** | 糖预览面板（`ui.panel` 槽贡献） |
| `packages/plugins/ui-sugar-preview/src/panel-logic.ts` | **新增**（~420 行） | 纯逻辑（零 React 可单测）：全角空格行检测 / 诊断行 / 可达性折叠 / 产物行区间标签 / 逐行映射 / 概要 / 降级文案 / 存档选项 / 可达性门控 |
| `packages/plugins/ui-sugar-preview/src/index.ts` | **新增** | 面板组件（`createElement`，非 JSX）：工具栏（存档下拉 + 刷新）/ 概要条 / 诊断区 / 逐行映射区；跳转复用宿主既有通道 `editor.revealLocation` |
| `packages/plugins/ui-sugar-preview/package.json` | **新增** | 依赖仅 `@kojo/plugin-api`（+ react peer） |
| `packages/plugins/ui-sugar-preview/tests/panel-logic.test.ts` | **新增**（39 项） | 九节：全角空格 / 诊断行 / 可达性折叠 / 产物行区间标签 / 逐行映射 / 概要+行数 / 降级+文件判定 / 真实 sugar.preview 结果建行 / 存档选择+可达性门控 |
| `packages/plugins/ui-sugar-preview/tests/integration.test.ts` | **新增**（8 项） | 跨插件接线（服务槽顺序）+ 端到端只读闭环 + 事件纪律 |
| `packages/app/src/styles.css` | 修改（additive） | 文件尾追加 `pv-*` 整节（工具栏 / 概要 chip / 诊断 / 逐行映射 / 全角空格 / 产物行标签 / 可达性徽章四态） |
| 四处登记 | 修改 | `tsconfig.json` paths / `vitest.config.ts` aliases / `packages/app/vite.config.ts` aliases + `packages/app/package.json` deps |
| `packages/app/src/bootstrap.ts` | 修改 | 注册 `createUiSugarPreviewPlugin()`（排在 kojo-sugar 之后：它 require `sugar.preview` 服务槽） |

#### 关键设计决策

1. **面板只做呈现，语义一律来自数据层**：`id: 'ui-sugar-preview'` 的 `requires` 只有两个硬槽（`sugar.preview` + `kernel.io`），`provides` 为空——它是**纯消费者**。逐行映射 / 诊断 / 可达性折叠全在 `panel-logic.ts`（零 React），面板组件只负责把纯逻辑结果画成 DOM。这保证"呈现逻辑"可脱离 React 单测。
2. **存档扫描是软依赖，不是硬依赖**：`snapshot.source` 用 `try { ctx.inject } catch { undefined }` 取——存档能力没装时，面板退化为**两向映射**（糖源码行 ↔ 产物行），而不是整个面板 inactive。**硬依赖只留给"面板存在的前提"**（没有 `sugar.preview` 就没有这个面板）；其余能力缺席一律"退化可见"。这正是 DSH 解耦哲学对软依赖的定义。
3. **未接存档 → 不显示可达徽章（本批最重要的一条正确性决策）**：数据层在**无回放**时 `fnBranches=[]` → `foldReachability` 会把每个消息块折成 `reachable`。那是"**不可判定**"而非"可达"。若原样呈现，作者会以为"这些块一定会走到"——**这是误导**。故 UI 层用 `withReach = arch.connected` **门控**：未接存档 → 连可达性折叠都不调用（传 `ZERO_REACH`），并显示降级提示条「未接入存档回放——可达性不可判定（下方不显示可达徽章）」。**能力缺席 ≠ 全绿。**
4. **存档选择走内核事件，UI 插件间零直接依赖**：`kojo.snapshotSelected` 由归档浏览器（或任何插件）广播，本面板订阅后**预填**下拉；下拉选项用 `snapshots.current()` 同步读扫描结果（与 `ui-snapshot-injector` 同款范式）。面板**不 import 任何 UI 插件**。
5. **角色号不在 UI 层推导**：`.kojo` 声明 `角色: N`，但面板**不解析语义**——它只把 `archivePath` 交给 `sugar.preview`，由后者从产物骨架 `_K(\d+)` 反推角色号。**同一条推导只有一处实现**，UI 层不复制（否则两处会漂移）。
6. **跳转复用宿主既有通道**：点击诊断行 / 映射行 → `ctx.bus.emit('editor.revealLocation', { filePath, line })`（与校验面板 / 函数树同款）。面板**不持有宿主引用**，当前文件来自宿主广播事件 `editor.activeFileChanged`。
7. **事件纪律：只消费不发**（除导航意图）：面板**只读**当前文件（`kernel.io.readText`），**绝不改盘**，故**不发 `file.changed`**（谁改盘谁发）；`sugar.preview` 自身亦只读不发事件 —— 整条链路无变更源，闭环成立。它只发 `editor.revealLocation`（导航意图，不是状态变更）。
8. **降级是分类不是布尔**：沿用数据侧的 `PreviewDegrade` 五值闭集（`no-project` / `not-kojo` / `reading` / `read-error` / `previewing`），面板逐值给中文文案；**转译 error 不抛错**（诊断原样带出，骨架照给）。
9. **行数口径必须与数据层同源（本批抓出的真 bug）**：`buildPreviewRows` 起初对以 `\n` 结尾的源 `split('\n')` 得到**多一条幻影空行**，与 `countLines` 及数据层 `buildLines`（剥离尾部空行）口径不一致 → 概要"源行"与列表行数对不上。修法：`buildPreviewRows` split 后**剥离尾部空元素**（与另两处同口径）。**这是单测抓出的真实 off-by-one**（见关键坑 1）。

#### 测试

- `panel-logic.test.ts` **39 项**：全角空格行定位；诊断行（severity → 样式类 + 可跳转判定）；可达性折叠（可达/不可达/未知三档计数 + 门控）；产物行区间标签（单行 / 区间 / 无产物）；逐行映射（含**尾部空行剥离**对照、纯生成行 `sourceLine:null` 不归糖行、结构行标注）；概要 + 行数（**与 `countLines` 同口径**）；降级文案 + `.kojo` 文件判定闭集；**真实 `sugar.preview` 结果建行**（`createSugarTranspileService({faceTable})` + `createSugarPreviewService` 走一遍）；存档选项（`formatSize` 三档 + 过滤 error/meta-null 项）+ 可达性门控（未接存档 → 徽章不显示）。
- `integration.test.ts` **8 项**：`requires` 两槽且 `provides` 为空（纯消费者）；激活后注册 `ui.panel id=sugar-preview`；**反序装配必失败**（服务槽顺序）；`WellKnownServices.SugarPreview === 'sugar.preview'` 契约钉死；端到端只读闭环（读源 → 预览 → 建行）；**无存档请求 → `archive === null`**；磁盘字节不变 + 零事件发出；转译 error 不抛错。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **909 passed / 6 skipped**（915）（868 → 909，**+47**，52 passed / 3 skipped 文件，15 插件，零回归） |
| `pnpm typecheck`（root） | 通过，exit 0 |
| `pnpm typecheck`（`@kojo/app`） | 通过，exit 0 |
| `node tools/audit-decoupling.mjs` | **A/B/C/D 四项全绿（15 插件）**（新插件未引入交叉 import / 未依赖 kernel / 零游戏知识） |
| golden / S2 内核 / 数据层 | 未触碰，零改动 |

#### 关键坑与发现

1. **off-by-one 被单测抓出（真实 bug）**：`buildPreviewRows` 对以 `\n` 结尾的源返回 5 行，而 `countLines` / 数据层 `buildLines` 返回 4 行。`split('\n')` 会在末尾多产出一个空元素——**那不是行**。修法：`buildPreviewRows` split 后剥离尾部空元素（与另两处同口径）。**"同一份数据在两处按不同口径计数"是本批唯一逻辑错误**，靠"概要源行 vs 列表行数"对照断言钉死。
2. **TS2769：helper 返回 `unknown` 不能赋给 `ReactNode`**：面板用 `createElement`（非 JSX），初版 helper 与 `shell(children: unknown[])` 都写 `unknown` → 展开进 `createElement` 时报 JSX 类型不兼容。修法：helper 与 `shell` 全部改用 `ReactNode`（`import type { ReactNode } from 'react'`）。**vitest 不报（类型被擦除），只有 `tsc` 会报**——双跑 typecheck 的价值再现（§九-7）。
3. **软取服务槽必须进 `try/catch` 且不留半初始化状态**：`snapshots` 声明为 `SnapshotSourceService | undefined`，catch 里显式置 `undefined`（不靠外层 `let` 的隐式 undefined）——否则 TS 严格模式下的"可能未赋值"与运行时的半态都不好排查。
4. **存档下拉"无档"与"不接档"是两种语义**：`archiveOpts.length === 0`（能力未装 / 未扫描到档）→ 下拉 `disabled` + 文案「无可用存档」；有档但选空 → 文案「（不接存档）」。两者都走 `archivePath === ''` 的分支（不发存档参数），但**用户看到的语义不同**——不区分会让作者误以为"选了空档 = 接了空档"。
5. **新插件必须 `pnpm install --no-frozen-lockfile`**（§八同款，再次应验）：四处登记只是路径别名，`packages/app/node_modules/@kojo/*` 的软链要 install 才建；且新增插件 package.json 会让 frozen-lockfile 校验失败（`ERR_PNPM_OUTDATED_LOCKFILE`）→ 必须 `--no-frozen-lockfile`。

#### 边界未做（属后续批）

- **Monaco 内联高亮 / 悬浮 / 装饰**：本批只做侧栏面板（逐行映射列表），编辑器内联装饰（`ui.editor.decorator` 槽 / Monaco hover provider）留 S6。
- **消息块气泡逐条渲染**：本批把消息块折叠为**行区间标签 + 可达性徽章**，逐块气泡（含逐字符 FORM 展开渲染串）留后续。
- **保存期全角空格告警的"阻断"语义**：本批面板**告警显示**全角空格行数（概要 chip），但保存路径的**阻断 / 一键修复**要与"保存路径推导"批一起做（当前 `compileToFile` 严格按给定路径写，`.kojo` → 目标 `.erb` 路径推导尚未接）。
- **虚拟滚动**：逐行映射上限 400 行、诊断上限 100 条（防 DOM 爆炸），超出部分显式计数；超大文件需虚拟滚动才谈得上"全量可浏览"。
- **`.kojo` 角色号直接取自糖 AST**：当前由产物 `_K{n}` 反推（同 S4 数据层边界），糖 `角色:` 声明直读留后续。

### 5.35 语法糖 S6 批 · 编辑体验（v0.3 批 S6 实施记录：Monarch 高亮 + 中文/别名补全 + 危险波浪线 + 糖判定面板）

> **定位**：S6 把糖体验从"侧栏面板"推进到"**编辑器内**"。四件事：
> ① `.kojo` 语法高亮（Monaco Monarch）；② 中文关键字 / 别名补全；
> ③ 危险波浪线（转译诊断 → `ui.editor.decorator` 槽 → Monaco markers）；
> ④ 糖判定面板（当前 `.kojo` 的编译判定 + 逐条诊断）。
> **新插件 `ui-sugar-editor`**（第 16 插件）；**`ui.editor.decorator` 槽首次落地消费**
> （ARCHITECTURE 早定的设计：装饰由插件注册、app 壳消费）。
> 高亮 / 补全 / markers 翻译住 **app 宿主层**（Monaco 不属插件，对齐既有
> `erb-language.ts` 先例）；词表**单一真源**从 `kojo-sugar` 派生，
> 避免高亮/补全与转译器词法脱节。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugin-api/src/slots.ts` | 修改 | `LineDecoration` 增 `startColumn?`/`endColumn?`（1 基 UTF-16，半开区间）/`code?`——波浪线可画列级下划线；缺省即整行（v0.2 行级形态完全兼容） |
| `packages/plugins/kojo-sugar/src/keywords.ts` | 修改 | 新增**编辑器词表单一真源**：`SugarKeywordRole` / `SUGAR_KEYWORD_ROLE_LABEL` / `SUGAR_LEXICON_WORDS`（由 `KEYWORDS` 派生）/ `SUGAR_LEXICON_OPERATORS`（由 `OPERATORS` 派生）/ `sugarEditorLexicon()` |
| `packages/app/src/monaco/kojo-language.ts` | **新增** | `.kojo` Monarch 分词器（状态 root/rawFence/speech/speechAlt/speechIn/interp）+ 语言配置 + `KOJO_SUGAR_THEME_RULES`（糖专属 token 配色）+ 补全 provider（别名/代词/中文关键字/运算符；英文别名输入生效但不进补全——规范 §4.1）+ `decorationsToMarkers`（列级 marker，越界夹到行内） |
| `packages/app/src/monaco/erb-language.ts` | 修改 | `kojo-dark` 主题 `rules` 末尾 `...KOJO_SUGAR_THEME_RULES`（同一处 `defineTheme`，避免二次定义覆盖 ERB token 配色） |
| `packages/app/src/ui/EditorPane.tsx` | 修改 | 按扩展名选语言（`.kojo`→糖，其余→ERB）；消费 `ui.editor.decorator` 槽全部贡献 → `setModelMarkers`（open 即算、编辑停顿 250ms 去抖；装饰器抛错逐个隔离，不崩编辑器） |
| `packages/plugins/ui-sugar-editor/` | **新增插件** | 糖编辑体验（第 16 插件）：`ui.editor.decorator` 贡献（id `sugar-diagnostics`，order 10）+ `ui.panel` 贡献（id `sugar-verdict`，order 76，标题「糖判定」） |
| `.../src/panel-logic.ts` | 新增 | 纯逻辑（零 React）：文件判定 / 判定归类（error>warning>ok）/ 判定行排序（位置升序、同级保原序、文件级殿后）/ 装饰列区间翻译 / 概要 / 降级文案 |
| `.../tests/panel-logic.test.ts` | 新增（13 项） | 六节：`isKojoFile` / 判定归类 / 判定行排序 / 装饰翻译 / 概要 / 降级文案 |
| `.../tests/integration.test.ts` | 新增（9 项） | 跨插件接线 + 反序必失败 + `.kojo` 装饰带行列 / `.ERB` 空 + 纯函数纪律 |
| `packages/app/src/styles.css` | 修改（additive） | 文件尾追加 `sv-*` 整节（判定徽章 / 错误警告提示计数 / 诊断行 / 定位） |
| 五处登记 | 修改 | root `tsconfig.json` paths / `vitest.config.ts` aliases / `packages/app/vite.config.ts` aliases + `packages/app/package.json` deps / `packages/app/src/bootstrap.ts` |
| `packages/app/src/bootstrap.ts` | 修改 | 注册 `createUiSugarEditorPlugin()`（排 kojo-sugar 之后：它 require `sugar.transpile` 服务槽） |

#### 关键设计决策

1. **高亮/补全住 app 宿主层，词表单一真源来自插件**：Monaco 不是插件（与 `erb-language.ts` 同款），故 Monarch 分词器、语言配置、补全 provider、markers 翻译全在 `packages/app/src/monaco/kojo-language.ts`。但**词表不手抄**——`SUGAR_LEXICON_WORDS`/`SUGAR_LEXICON_OPERATORS` 从转译器自身的 `KEYWORDS`/`OPERATORS` **派生导出**（`kojo-sugar`），app 组合根 import 它（bootstrap 本已 import 各插件，无审计违规）。**高亮/补全与词法永不脱节**。
2. **波浪线经 `ui.editor.decorator` 槽，宿主消费为 markers**：这是 ARCHITECTURE 早定的槽（装饰由插件注册、app 壳消费），S6 首次落地。插件贡献 `decorate(file)` **纯函数** → 宿主 `setModelMarkers(owner='kojo-decorators')`。**装饰器抛错被逐个隔离**（能力出错要"退化可见"而非崩编辑器）。列级区间（`startColumn/endColumn`）让诊断画下划线而非整行标红。
3. **危险波浪线的语义来源 = 转译器诊断**：`ui-sugar-editor` 只把 `sugar.transpile` 的 `SugarDiagnostic[]`（带 `loc`/`span`）翻译成 `LineDecoration[]`——**不自建 lint**。§8 静态清单（`续` 写进引号 / 多选项块 / 表达式缺否则 / 只读别名赋值）已在 S2 批落在 `convention-linter` 的 `sugar.static-conventions` 规则（§5.28），本批不重复实现。
4. **判定面板 = 当前 `.kojo` 的编译判定**：可编译 / 可编译（有警告）/ 不可编译 + 错误·警告·提示计数 + 逐条诊断（点击 → `editor.revealLocation` 定位源行）。与 `ui-sugar-preview`（回放预览）、`ui-convention-report`（全项目约定校验）**语义不重叠**：本面板是**单文件转译判定**。
5. **补全遵循规范 §4.1 中英双收但不对等展示**：中文主形进补全列表；英文隐藏别名**输入生效但不出现在补全里**（避免噪音）。排序：别名(1) > 保留代词(2) > 关键字(3) > 运算符(4)。
6. **`.kojo` 判定/装饰只作用于糖源**：`isKojoFile` 门控——原生 `.ERB` 一律返回空装饰、面板显式给降级文案（**不是静默什么都不显示**）。判定面板四值降级闭集（`no-project`/`not-kojo`/`reading`/`read-error`）逐一给中文文案。
7. **纯函数 + 只读纪律**：`decorate()` 只吃宿主给的 `{path,text,project}`（不读盘不写盘不发事件）；面板读盘走内核 io（**只读**）。整批只发 `editor.revealLocation`（导航意图，非状态变更）。

#### 测试

- `panel-logic.test.ts` **13 项**：`isKojoFile`（大小写不敏感）；判定归类（`countBySeverity` 分项 + `verdictStatus` error 压倒 warning 压倒 ok + 中文标签）；判定行排序稳定（有位置在前、位置升序、同位置保原序、文件级殿后、key 唯一）；装饰列区间翻译（同 span 画区间 / 多行 span 省 endColumn / 无 span 从 `loc.column` 起 / 文件级不产装饰 / startColumn 至少 1）；概要行数（去尾换行）；降级文案非空。
- `integration.test.ts` **9 项**：插件声明（`requires` 两槽、`provides` 空）；注册 1 个 `ui.editor.decorator`（sugar-diagnostics）+ 1 个 `ui.panel`（sugar-verdict）；**反序装配必失败**（服务槽顺序）；`sugar.transpile` 键钉死；坏源（`「你好。续」` → `cont-inside-quotes`）装饰带行列且与 loc 非空诊断一一对应；良构源无 error 装饰；`.ERB` 返回空；纯函数（两次调用一致 + 磁盘字节不变 + 零事件）；装饰形状合法（行号 ≥1 / severity 在闭集）。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **931 passed / 6 skipped（937）**（909 → 931，**+22**；54 passed / 3 skipped 文件，**16 插件**，零回归） |
| `pnpm typecheck`（root） | 通过，exit 0 |
| `pnpm typecheck`（`@kojo/app`） | 通过，exit 0 |
| `node tools/audit-decoupling.mjs` | **A/B/C/D 四项全绿（16 插件）** |
| `pnpm -C packages/app build` | 通过（vite build，exit 0） |
| golden / S2 内核 / S4 数据层 | 未触碰，零改动 |

#### 手工清单（S6 交付判据："app build + 手工清单"）

`pnpm tauri dev`（正常终端）打开含 `.kojo` 的工程，逐项勾验：

| # | 操作 | 预期 |
|---|---|---|
| a | 打开一个 `.kojo` 文件 | 中文关键字（时机/如果/当/是/选项…）按角色着色（糖 token 配色，非 ERB 配色） |
| b | 输入 `如`（或头部有 `别名 好感 = CFLAG:…` 时输入别名首字） | 补全列表弹出：`如果`（关键字，detail 含角色）/ 别名（排最前，detail「别名（本文件）」）/ 代词 |
| c | 输入英文别名（如 `if`） | 高亮生效，但**补全列表不出现**（规范 §4.1 不对等展示） |
| d | 写 `「你好。续」`（`续` 在引号内） | 该行出现**红色波浪线 + 悬浮提示**（列级下划线，非整行） |
| e | 打开侧栏「糖判定」面板 | 显示判定徽章（可编译 / 可编译（有警告）/ 不可编译）+ 错误/警告/提示计数 + 逐条诊断 |
| f | 点击判定面板中带位置的诊断行 | 编辑器滚动并定位到该源行 |
| g | 打开一个原生 `.ERB` 文件 | 无糖波浪线；判定面板显示「当前文件不是 .kojo 糖源」降级文案 |

（本批手工清单为"交付判据"的一部分；真实终端 `pnpm tauri dev` 下的实机勾验由验收者执行——沙箱不跑 GUI。）

#### 关键坑与发现

1. **主题二次 `defineTheme` 会覆盖**：若在 `kojo-language.ts` 里再调 `defineTheme('kojo-dark')`，ERB token 配色会丢失。修法：糖配色导出为 `KOJO_SUGAR_THEME_RULES`，由 `erb-language.ts` **同一处** `defineTheme` 的 `rules` 末尾 spread 合并——**一个主题只定义一次**。
2. **只注册一次的 Monaco 回调闭包会过时**：`onDidChangeModelContent` 只在创建时注册一次；用 `filePathRef`/`refreshMarkersRef`/`markerTimerRef` ref 化取最新值（§九-21 同款闭包陷阱）。
3. **列越界必须夹到行内**：装饰是**外部数据**（插件贡献），不能假定它算准了列——`decorationsToMarkers` 对 line/startColumn/endColumn 一律 `clamp` 到 `[1, getLineMaxColumn]`。
4. **测试夹具的 `code` 是示意串**：`panel-logic` 单测用 `'a'`/`'L2a'` 之类占位 code，而 `SugarDiagnosticCode` 是**闭集**——helper 参数用 `Omit<Partial<SugarDiagnostic>,'code'> & { code: string }` 再在内部 `as` 收窄（纯逻辑只按 severity/loc/span 归类，code 原样透传）。**vitest 不报类型，只有 `tsc` 会报**（双跑价值再现，§九-7）。

#### 边界未做（属后续批）

- **编辑器内三向映射装饰**：本批波浪线只画诊断；"糖行 ↔ 产物行 ↔ 消息块"的**内联装饰 / hover** 留后续（数据层已具备）。
- **消息块逐条气泡**：含逐字符 FORM 展开渲染串，留后续。
- **保存路径推导 + 保存期全角空格阻断**：`.kojo` → 目标 `.erb` 路径推导尚未接（S6 之外的候选批）。
- **虚拟滚动**：判定面板诊断上限 200 条（超出显式计数）。
