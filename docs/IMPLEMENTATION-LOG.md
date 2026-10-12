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

> 依据：`docs/archive/CODE-REVIEW-2026-10-10.md`（只读审阅报告）。本批 = 审阅修复清单落地。

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

> 依据：`docs/archive/REVIEW-OPTIMIZATION-2026-10-10.md` §3 C9（"默认场景全 0"被当确定事实）与 A3（预览职责两处说法未对齐）、§5 "v1.0 收口（信任闭环）"第 4、5 项。本批为 **v1.0 收口 UI 线**（另一条线并行做 C7 Rust 写保护，互不越界）。

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

> 依据：docs/archive/CODE-REVIEW-2026-10-10.md L68-70（M3 遗留）+ docs/archive/REVIEW-OPTIMIZATION-2026-10-10.md §5 C7——「M3 必须优先于 v1.1 注入器：注入器本身是写路径，无第二道闸不能开写」。本批只动 packages/app/src-tauri/**、kernel io 契约注释、docs/**。

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

> 依据：`docs/archive/REVIEW-OPTIMIZATION-2026-10-10.md` §5「v1.0 收口」第 4 项的后续阶梯 + `HANDOFF.md` §6.11 候选「回放面板协议深化（场景预设）」。承接 §5.20 的 C9 信任闭环：场景值是**作者的场景假设**，不是引擎事实——UI 文案不得写死「正确值」。本批只动 `packages/plugins/ui-state-replay/**` + docs；回放引擎（`state-replay`）与 `condition-extractor` 契约**零改动**。

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

> 依据：docs/archive/BUG-REPORT-2026-10-10.md（第二轮审阅遗留，逐条代码复核属实）。边界：不碰 sav-parser / 注入器线（并行 WIP）。

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

> 依据：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（表层语法 v1.2 冻结版，只读输入）+ `docs/archive/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §8.2（S1 = 契约 + golden 固化；S1 的测量项已由规范 §1.1 提前完成）。
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
> 设计稿：`docs/archive/LIFT-SUGGESTER-DESIGN.md`。表层语法权威：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`。

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
> 设计稿：`docs/archive/LIFT-SUGGESTER-DESIGN.md` §2.1（修正）/ §2.3（新增）。

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
| `docs/archive/LIFT-SUGGESTER-DESIGN.md` | 修改 | §2.1 映射表**修正**（原表错写 `旁白` → `PRINTFORMW`，漏了头部开关这一维）；**新增 §2.3**（2×2 语料矩阵 + 三条推论 + 引擎语义实证 + 「本批不加任何新语法」）；§4.1 契约片段加 `narrationColor?`；§5 `roundtrip-mismatch` 行注明"两种口径依次试"；§6 已知取舍 +2 条 |

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

> 起因：`docs/archive/REVIEW-SUGAR-DECOUPLING-2026-10-11.md` 审阅发现 B-1——`kojo-sugar/codegen.ts`
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

### 5.36 保存路径推导 + 前置检查（2026-10-11 批；路线 S7 数据层：`.kojo` → 目标 `.ERB` 推导 + `planSave` 前置检查）

> **定位**：S6 之后，"编辑 → 保存"闭环缺的最后一块**数据层**。本批**只做数据层**，
> 交付两件纯能力：① **目标产物路径推导**（`.kojo` → 同目录同基名 `.ERB`）；
> ② **保存前置检查** `planSave`（推导目标 + 转译 + 全角空格告警一次算齐，给 UI
> 一个 `blocked` 判据）。落盘仍复用 S3 的 `compileToFile`（写链路零改动）；
> UI 接线（保存触发 `planSave` → 阻断对话框 / 全角空格提示）留 S7-UI。
>
> **单一真源收敛**：全角空格 `U+3000` 的判据从 `ui-sugar-preview` 本地定义**上收
> 契约层**（`plugin-api/sugar.ts`），预览面板改为转出——保存前置检查与预览面板
> **共用同一函数**，杜绝"什么算全角空格"悄悄分叉。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugin-api/src/sugar.ts` | 修改 | 新增「保存目标推导与前置检查（S7 批）」节：`FULLWIDTH_SPACE`（`U+3000` 常量，含语料证据注）/ `fullwidthSpaceLines(source): number[]`（1 基行号，升序）/ `resolveSugarTarget(sourcePath): string \| null`（`.kojo` → `.ERB` 纯函数）/ `SugarSaveBlockReason`（`'source-not-kojo' \| 'transpile-error'` 闭集）/ `SugarSavePlanRequest` / `SugarSavePlan`；`SugarTranspileService` 接口新增 `planSave` 声明 |
| `packages/plugin-api/src/index.ts` | 修改 | 值导出新增 `FULLWIDTH_SPACE` / `fullwidthSpaceLines` / `resolveSugarTarget`；类型导出新增 `SugarSaveBlockReason` / `SugarSavePlan` / `SugarSavePlanRequest` |
| `packages/plugins/kojo-sugar/src/service.ts` | 修改 | 实现 `planSave(request)`：先推目标（无目标即 `blocked`，省一次转译）→ 转译取诊断（`filePath` 缺省取 `sourcePath`）→ 取全角空格告警行；`blockedReason` 优先级 `source-not-kojo` > `transpile-error` |
| `packages/plugins/kojo-sugar/src/index.ts` | 修改 | 装配层 `service` 字面量补 `planSave`（复用同一 `makeTranspiler()`，与 adapter 字典 + 分野表同源） |
| `packages/plugins/ui-sugar-preview/src/panel-logic.ts` | 修改 | 删除本地 `FULLWIDTH_SPACE` / `fullwidthSpaceLines` 定义，改从 `@kojo/plugin-api` 导入并原样转出（对外 import 面不变，测试零改动） |
| `packages/plugins/kojo-sugar/tests/save-plan.test.ts` | **新增（19 项）** | 三节：目标推导 / 全角空格 / 前置检查 |

#### 关键设计决策

1. **目标推导 = "同目录换扩展名"，不是 `charaIndex[no].kojoDir` 拼接**。既有交接稿（§十-4）写的候选是 `charaIndex[no].kojoDir` + `M_KOJO_K{No}_{分野}.ERB`，但那需要**游戏知识**（角色编号 → 目录的映射属 adapter 域），且要读盘。实测语料：源 `.kojo` 由"新建向导"与产物**同目录**生成、并沿用产物基名（`K{No}` + 分野都已在源文件名里，见 `M_KOJO_K49_指令.kojo` 惯例）——故 `resolveSugarTarget` 只需 `.kojo` → `.ERB` 换扩展名，**纯函数、零游戏知识、住契约层**（可被任何游戏复用）。跨目录/改名属新建向导与命名校验的职责（后者才需要 adapter 的命名知识），不在本通用函数内。
2. **全角空格：只告警不阻断**。规范 §8 明文"保存期**告警**"；语料证据同样支持——口上语料 3,599,696 行中含 `U+3000` 者 55,565 行（1.54%），**全部为行中用途**（注释分隔 `;【TARGET】　欲情の珠`、编译器生成的台词缩进 `PRINTFORMW 　「…」`），**行首出现 0 次**。即它是"正常但极易与半角空格混看"的字符，故 `planSave` 单独给 `fullwidthSpaceLines`（告警行），**不并入 `blocked`**；阻断/一键修复留 UI 批。
3. **`planSave` 是只读前置，落盘仍是 `compileToFile` 的职责**。契约层 `SugarTranspileService` 的"纯函数方法"（`parse`/`transpile`/`sourceOf`）与"唯一含 IO 方法"（`compileToFile`）分工不变——`planSave` 明确归入**纯函数**侧（不读盘不写盘不发事件）：把守卫前置，让 UI 拿到 `blocked` 而无需先触发 IO 副作用。**能力面 = 服务键面**，写盘能力不外溢。
4. **`blocked` 是闭集两值 + 明确优先级**。`source-not-kojo`（源路径非 `.kojo`，无对应产物目标——如误对原生 `.ERB` 触发保存流程）> `transpile-error`（转译产 `error` 诊断，fail-closed 不落盘半成品，同 `compileToFile` 守卫）。两者同时成立时取前者：**无目标即无落盘**，比"半成品"更根本。命名零游戏名词（审计 A 项）。
5. **不新增诊断码**。全角空格是"源文本的排版事实"而非"转译诊断"——`SugarDiagnosticCode` 是转译语义闭集，混入排版告警会污染语义。故它作为 `SugarSavePlan` 的独立字段，与既有预览面板的 `fullwidthLines` 计数**同源同义**（同一函数、同一判据）。

#### 测试

- `save-plan.test.ts` **19 项**，三节：
  - **目标推导**（7 项）：基本形式（基名/目录保留、扩展名归一 `.ERB`）；扩展名大小写不敏感（`.KOJO`/`.Kojo`）；分隔符保留原样（Windows 反斜杠不改写）；相对路径可用；非 `.kojo`（原生 `.ERB` / `.kojo.bak` / 无扩展名）→ `null`；空路径 → `null`；纯函数一致性。
  - **全角空格**（5 项）：契约常量即 `U+3000`；行内任一位置即计入（非仅行首）；一行多个只记一次；全角标点（、。！）不算；空串 → `[]`。
  - **前置检查**（7 项）：合法文档（目标正确 / 未阻断 / 产物非空 / 无告警）；全角空格**只告警不阻断**（`blocked=false` 且告警行照出）；目标推导与源路径同源（等于 `resolveSugarTarget(sourcePath)`）；源非 `.kojo` → `source-not-kojo`；转译 error → `transpile-error`（目标仍照常推导）；两者并发时优先 `source-not-kojo`；纯函数（同源同路径两次调用一致）。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **950 passed / 6 skipped（956）**（931 → 950，**+19**；55 passed / 3 skipped 文件，**16 插件**，零回归） |
| `pnpm typecheck`（root） | 通过，exit 0 |
| `pnpm typecheck`（`@kojo/app`） | 通过，exit 0 |
| `node tools/audit-decoupling.mjs` | **A/B/C/D 四项全绿（16 插件）** |
| golden / S2 内核 / S4 数据层 / S5 / S6 | 未触碰，零回归（ui-sugar-preview 测试零改动即绿，证明转出后 import 面不变） |

#### 边界未做（属 S7-UI 或后续批）

- **保存 UI 接线**：`Ctrl+S`（`.kojo`）触发 `planSave` → `blocked` 时弹阻断原因（非 `.kojo` / 转译错误），否则 `compileToFile` 落盘；全角空格告警在保存前提示。本批只给数据层，UI 留 S7-UI。
- **保存期全角空格"阻断/一键修复"**：当前只**告警**（决策 2）；真正的"阻断开关"与"一键替换 `U+3000` → 空格"是 UI 交互，留 S7-UI。
- **新建向导的跨目录目标命名**：`M_KOJO_K{No}_{分野}.ERB` 的**命名校验**需 adapter 的命名知识，本通用函数不做（决策 1）。

### 5.37 语法糖 S7-UI 批 · `.kojo` 保存接线（2026-10-12 批：发版判据 ① 的最后一环）

> **定位**：S7 数据层（§5.36 `planSave` + `resolveSugarTarget`）与本批（UI 接线）合起来，
> 打通**"`.kojo` 编辑 → Ctrl+S → 源保存 + 产物 `.ERB` 编译落盘 → 真实游戏可跑"**闭环——
> 即发版判据 ① 的最后一环。本批**只接 UI**：落盘能力（`compileToFile`）与前置检查
> （`planSave`）**一行未改**，全部复用。
>
> **架构关键**：保存接**不**做成宿主硬编码 `.kojo`（那会让 app 壳认得糖格式，破坏
> "宿主零格式知识"），而是新增**通用槽 `ui.editor.saveHandler`**——宿主在保存一个文件前按
> `matches(path)` 就近征询接管者，命中即把落盘完全交给它；`.kojo` 的"转译 + 编译落盘"
> 逻辑住在 `ui-sugar-editor` 插件。**无新插件（插件数仍 16）**，`ui-sugar-editor` 从
> "两处贡献"扩为"三处贡献"。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugin-api/src/slots.ts` | 修改 | 新增槽 `ui.editor.saveHandler`：`EditorSaveWarning`（`kind: 'fullwidth-space'` + 消息 + 行号）/ `EditorSaveChoices`（`acknowledgeFullwidthSpace?`）/ `EditorSaveRequest`（`{path,text,project,choices?}`）/ `EditorSaveOutcome`（`saved` / `needs-choice` / `error` 三态联合）/ `EditorSaveHandlerContribution`（`title` + `matches` + `save`）；`SlotMap` 登记该槽 |
| `packages/plugin-api/src/index.ts` | 修改 | 类型导出新增 `EditorSaveChoices` / `EditorSaveHandlerContribution` / `EditorSaveOutcome` / `EditorSaveRequest` / `EditorSaveWarning` |
| `packages/plugins/ui-sugar-editor/src/save-handler.ts` | **新增** | 保存编排**纯逻辑**（零 React、零内核，依赖入参注入可单测）：`performSugarSave(deps, request)` —— `planSave` 前置 → 全角空格未确认返 `needs-choice` → **写源**（始终）→ `blocked` 则产 `note` 不编译 → 否则 `compileToFile` 落盘；失败一律转 `error`（**不抛**） |
| `packages/plugins/ui-sugar-editor/src/index.ts` | 修改 | 注册第三处贡献 `ui.editor.saveHandler`（id `sugar-save`，order 10，`matches: isKojoFile`，`save: performSugarSave({sugar, io}, …)`）；模块头注释更新为"三处贡献" |
| `packages/app/src/ui/SaveWarningDialog.tsx` | **新增** | 保存告警确认框（全角空格）：三按钮「取消 / 仍然保存 / 替换为半角空格并保存」；列出行号（`LINE_CAP=12`，超出显式计数）。**复用既有 `modal-mask`/`modal`/`modal-actions` 样式，无新增 CSS** |
| `packages/app/src/ui/EditorPane.tsx` | 修改 | 保存接线：`pickSaveHandler(kernel, path)` 征询槽（命中者 `order` 最小、`matches` 抛错隔离）→ 委托 `handler.save` → `needs-choice` 弹 `SaveWarningDialog`（**本次不落盘**）、`error` 置状态、`saved` 记基线 + 状态栏（`message` + `note`）；无命中 → 内核 io `writeText` 缺省保存；`decideSaveWarning` 三路处置（含"一键修复"用 `executeEdits` 做**可撤销**的全文替换）；**修掉 Ctrl+S 回调闭包过时**（改用 `filePathRef.current`，`save` 只依赖 `kernel`/`markSaved`，身份稳定） |
| `packages/plugins/ui-sugar-editor/tests/save-handler.test.ts` | **新增（8 项）** | 多路径：良构落盘 / 全角空格未确认(不落盘) / 已确认放行 / 转译 error(源存产不产) / 源非 `.kojo` / 源写失败 / 编译失败 |
| `packages/plugins/ui-sugar-editor/tests/integration.test.ts` | 修改（仍 9 项） | 假内核新增 `saveHandlers` 收集 + `ui.editor.saveHandler` 注册分支；断言新增：注册 1 个 `sugar-save`、`matches('.kojo')===true`、`matches('.ERB')===false` |

#### 关键设计决策

1. **保存接管做成通用槽，不做宿主硬编码**：`.kojo` 的"保存 = 转译 + 编译落盘"属糖域逻辑，宿主不该认得它。做成 `ui.editor.saveHandler` 通用槽后，**任何文件类型都能自带保存语义**（如未来的格式化 / 生成物），宿主保持零具体格式知识；能力缺席（`ui-sugar-editor` 未激活）时**自动退化为缺省保存**（内核 io `writeText`，保编码保换行）——不静默、不报错、不阻塞浏览。这正是 DSH 解耦哲学对"可选能力"的要求（对照 §5.34 决策 2 的软依赖）。
2. **源文件始终保存；`blocked` 只拦产物**：`.kojo` 源是作者成果，**任何情况都落盘**——转译含 `error` 时只**不生成**产物 `.ERB`（fail-closed，规范 §5.3"阻止编译，不生成半成品"），并在状态栏 `note` 说明「产物未生成：转译含 N 项错误」。若"有编译错误就不让存"，作者会丢工作——与"不丢数据"背离。失败（源写 / 编译落盘）一律转 `error` 结果（**不抛**），宿主统一呈现。
3. **全角空格 = "告警 + 决策点"，不强制阻断**（本批最重要的语义取舍）：规范 §8 明文"保存期**告警**"，§5.36 决策 2 亦有语料证据（口上语料 3,599,696 行含 `U+3000` 者 55,565 行 = 1.54%，**全部行中用途、行首 0 次**）——故**不阻断**。实现为 `needs-choice`：未确认时**尚未落盘**（避免"取消"留下副作用），宿主弹 `SaveWarningDialog` 让用户三选——**取消 / 仍然保存 / 替换为半角空格并保存**。这既保住"告警 + 阻断决策点"的防误语义，又给出一键修复，避免强制阻断对 1.54% 正常用法的作者造成困扰。
4. **"一键修复"是可撤销编辑，不是静默改写**：`fix-and-save` 走 `ed.executeEdits('kojo-fix-fullwidth', …)` + `pushUndoStop()` 把编辑器内 `U+3000` 换成半角——作者可 Ctrl+Z 撤回；随后以修复后文本重新保存。**绝不静默改盘**。
5. **唯一接管，不做链式级联**：同一文件多个命中贡献时宿主取 `order` 最小者（同 `order` 按注册顺序），语义同 `game.adapter` 的单激活；`matches` 抛错的贡献被隔离（该文件退化缺省保存），不影响其余。
6. **`needs-choice` 不改动磁盘是硬约束**：`save-handler.ts` 在返 `needs-choice` 前**只**跑 `planSave`（纯函数，不读盘不写盘），**先判告警再写源**——顺序反了（先写源再问）会让"取消"变成"其实存了一半"。单测以"`writes` 为空"钉死。
7. **宿主保存路径经 `filePathRef.current` 取，不用闭包变量**：Monaco 的 `addCommand(Ctrl+S)` 只在挂载时注册一次，原闭包捕获 `save`（旧版 deps 含 `filePath`）→ 换文件后 Ctrl+S 会**存到旧文件**（潜在缺陷，本批修复）。修法：`save` 改用 `filePathRef.current` 读最新路径，deps 收为 `[kernel, markSaved]`（二者身份稳定）→ mount 闭包即最新，隐患消除（§九-21 闭包陷阱同款）。

#### 测试

- `save-handler.test.ts` **8 项**（fake `sugar` + fake `io` 精确驱动）：良构源 → 写源 + 编译，`saved` 含产物基名与字节数、无 `note`；全角空格未确认 → `needs-choice` 带行号且 **`writes`/`compiles` 均为空**；已确认（`acknowledgeFullwidthSpace`）→ 照常保存；`FULLWIDTH_SPACE` 常量即 `U+3000`；转译 error（`blocked`）→ `saved`，源已落盘、**产物不编译**、`note` 含错误数；源非 `.kojo` → `note` 归因路径；源写失败 → `error` 含「保存源文件失败」且不触碰编译；编译失败 → `error` 含「源已保存」。
- `integration.test.ts`（仍 9 项）更新：假内核收集 `ui.editor.saveHandler`；断言注册 1 个 `sugar-save`、`matches` 对 `.kojo`/`.ERB` 的真假、`save` 为函数。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **958 passed / 6 skipped（964）**（950 → 958，**+8**；56 passed / 3 skipped 文件，**16 插件**，零回归） |
| `pnpm typecheck`（root） | 通过，exit 0 |
| `pnpm typecheck`（`@kojo/app`） | 通过，exit 0 |
| `node tools/audit-decoupling.mjs` | **A/B/C/D 四项全绿（16 插件）**（新槽 / 新逻辑未引入交叉 import / 未依赖 kernel / 零游戏知识） |
| golden / S2 内核 / S3 写链路 / S4 数据层 / S5 / S6 | 未触碰，零改动 |

#### 手工清单（S7-UI 交付判据："真实终端 `pnpm tauri dev` 下 `Ctrl+S` 闭环"）

在含 `.kojo` 的工程里，逐项勾验（沙箱不跑 GUI，实机勾验由验收者执行）：

| # | 操作 | 预期 |
|---|---|---|
| a | 打开一个 `.kojo`，改一行后 `Ctrl+S` | 状态栏显示「已保存并编译 → M_KOJO_K…ERB（N B）」；同目录出现/更新产物 |
| b | 检查产物目录 | 产物 `.ERB` 与同目录既有文件同构（UTF-8 BOM + LF）；原产物若存在已进 `{appData}/backup/` |
| c | 故意写 `「你好。续」` 后 `Ctrl+S` | **源文件已保存**（磁盘可查）；状态栏「已保存源文件 · 产物未生成：转译含 1 项错误」；产物**未生成** |
| d | 在源里输入全角空格 `　` 后 `Ctrl+S` | 弹「保存告警」框（列出行号）；**此刻磁盘未变** |
| e | 在告警框点「取消」 | 关闭框，无落盘，脏标记保留 |
| f | 再 `Ctrl+S` → 点「仍然保存」 | 落盘成功（全角空格原样保留） |
| g | 再 `Ctrl+S` → 点「替换为半角空格并保存」 | 编辑器内 `U+3000` → 半角（可 Ctrl+Z 撤回）；落盘成功 |
| h | 打开原生 `.ERB` 改后 `Ctrl+S` | 走缺省保存（内核 io `writeText`）；不弹糖告警、不产 `.kojo` 产物 |
| i | 把编译成功的产物 `.ERB` 放进游戏口上目录 | 真实游戏可加载运行（发版判据 ① 终验） |

#### 关键坑与发现

1. **`needs-choice` 之前绝不能有副作用**：初版直觉是"先存源再问全角空格"，但那样"取消"会留下已改的源——**告警就不是告警了**。修法：`planSave`（纯函数）先算，**未确认即返回、不写盘**。单测用"`writes` 长度为 0"把这条不变式钉死。
2. **Ctrl+S 闭包过时是真实隐患，不是理论风险**：`addCommand` 只注册一次、捕获旧 `save`（旧 deps 含 `filePath`）。换文件后按 Ctrl+S 会存到**上一个文件**——静默数据错误。改用 `filePathRef.current` + 稳定 deps 修掉。教训沿用 §九-21：**只注册一次的回调一律读 ref**。
3. **槽注册在假内核里会被静默忽略**：`integration.test.ts` 的 `slots.register` 只收集已知槽名——新增 `ui.editor.saveHandler` 后若不补分支，注册被吞、测试仍绿（**假绿**）。故同步补 `saveHandlers` 收集 + 断言。**"测试替身要随契约一起长大"**（与 §5.34 关键坑 4 同源教训）。
4. **`executeEdits` 的"一键修复"要配 `pushUndoStop`**：否则全文替换与上一次编辑合并成一步撤销，作者按 Ctrl+Z 会一次撤掉过多。加 `pushUndoStop()` 明确切分撤销栈。

#### 边界未做（属后续批）

- **保存失败的结构化定位**：当前 `error` 只给消息串（含备份路径仅在 `SugarCompileError.message` 内）；"原文件已备份于 X，点击打开"的富交互留后续。
- **产物 diff 预览**：保存前显示"本次将改动产物哪些行"（源映射已具备）留后续。
- **新建向导**：从零新建 `.kojo` 并落位到正确口上目录（含 `M_KOJO_K{No}_{分野}` 命名校验，需 adapter 知识）留后续。
- **多接管者链式**：当前唯一接管（取 `order` 最小）；"格式化 → 编译"这类多步管线待有真实需求再设计（避免过早抽象）。

### 5.38 UI 重设计 P0 · 写权限闭环批（2026-10-11 批：静默只读修复 + 状态栏徽章 + 通知中心）

> 对应需求：`docs/UI-REDESIGN-2026-10-11.md` §九（F1/F2）；任务卡：`docs/archive/UI-REDESIGN-HANDOFF-2026-10-11.md` §五 P0。beta.1 判据 ⑥ 的第一期。

#### 范围

1. **静默只读修复**：kernel `applyApprovedWritable` 检测到「持久化批准 ≠ 适配器本次提议」时，除 `log.warn` 外经**新内核事件 `project.writableApprovalMismatch`**（additive 进 `KernelEventMap`）通知宿主；App 在 `open()` 期间局部订阅，命中即**重弹 `WritableApprovalDialog`** 并把写权限状态置为只读。修复前：旧批准记录场景宿主只查 `approvedWritableFor != null`，永远不重弹 → 静默永久只读（F1/F2 根因）。
2. **状态栏写权限徽章（P0 简化形态）**：`ProjectView` 底部新增 `.statusbar`——`可写`（绿，非交互）/ `只读`（琥珀按钮，点击 → 重授权对话框）。P1 换五区骨架、P3 槽位化（`ui.statusbar`）。
3. **通知中心**：壳层私有 `NotificationCenter`（Provider + toast 渲染；不经内核事件表）——info 6s 自动消失、error 常驻到关闭/点击 action、同屏上限 5 条；`useNotify()` 供壳层任意组件发通知。
4. **保存前置拦截**：`writable === false` 时 `save()` 不征询保存接管者、不写盘——直接 toast「保存被拒绝：项目当前为只读」+「去授权」action（**不等到写盘才报错**）；保存按钮同步置灰 + tooltip 指路状态栏徽章。
5. **竞态兜底**：保存途中批准被收回等场景抛出的 `WriteNotAllowedError` 被显式捕获 → 中文人话 toast +「去授权」action（裸英文堆栈只进日志，定稿 §九-3）。

#### 文件变更

| 文件 | 变更 | 说明 |
|---|---|---|
| `packages/plugin-api/src/events.ts` | 修改 | `KernelEventMap` additive 新增 `project.writableApprovalMismatch { rootDir }`（不改名不删除，兼容性承诺不破） |
| `packages/kernel/src/project.ts` | 修改 | 不一致分支补 `bus.emit` |
| `packages/kernel/tests/kernel.test.ts` | 修改（+1 项） | 「不一致 → 不放行 + 恰好一次事件 → 重批准恢复 → 再重开自动放行且不再发事件」全路径 |
| `packages/app/src/ui/NotificationCenter.tsx` | **新增** | 通知中心（Provider + toast + `useNotify`；info TTL 6s / error 常驻 / 同屏上限 5） |
| `packages/app/src/ui/App.tsx` | 修改 | `writable` 状态（null/boolean）；`openProject` 局部订阅不一致事件（消竞态）；`decideApproval` 同步徽章；`requestReauth` 双入口落地；整体包进 `NotificationCenter` |
| `packages/app/src/ui/ProjectView.tsx` | 修改 | 底部 `.statusbar` + 写权限徽章（只读可点击）；`writable`/`onReauth` 透传 EditorPane |
| `packages/app/src/ui/EditorPane.tsx` | 修改 | `writable`/`onReauth` props + ref 化（只注册一次的回调读最新值）；保存前置拦截 + `WriteNotAllowedError` 竞态映射；按钮置灰 + tooltip |
| `packages/app/src/styles.css` | 修改 | `.statusbar`/`.sb-writable`/`.notification-center`/`.toast` 样式（沿用既有 token） |

#### 关键设计决策

1. **不一致事件只在 `open()` 期间被局部订阅**：`applyApprovedWritable` 仅由 `project.open` 调用，事件必然同步发出——`openProject` 内 `bus.on` → `open()` → `un()` 的局部订阅既拿到事件，又不引入「常驻监听 setState 与 openProject 自身 setState 交错」的竞态。
2. **事件不进 `KERNEL_EVENT_NAMES` 白名单**：该集合的实际语义是「允许插件 emit 的内核事件」（scopedBus 据此拦截）——`project.writableApprovalMismatch` 只应由内核发出（插件伪造它等于伪造安全提示），照 `editor.activeFileChanged`（宿主专属）先例不收录；插件可 `on` 不可 `emit`。
3. **通知中心是壳层私有，不进内核事件表**：插件侧写错误（如升糖面板）暂仍由面板自行呈现；是否开放「插件 → 通知」通道留待 P3 💡 迁移时按真实需求定（避免过早设计）。
4. **只读拦截放保存链最前**：在征询 `ui.editor.saveHandler` 之前拦截——插件接管者（`.kojo` 保存 = 写源 + 编译产物）在只读态连「写源」都不该发生。

#### 测试

- `kernel.test.ts` **+1 项**：不一致 → `isWritable === false`（连旧批准内路径也不放行）+ 事件恰好一次且 payload rootDir 正确 → `approveWritablePaths` 重批准即恢复 → 第三次重开（记录已更新一致）自动放行、不再发事件。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（958 → 959，+1；56 passed / 3 skipped 文件，16 插件，零回归） |
| `pnpm typecheck`（root） | 通过，exit 0 |
| `pnpm typecheck`（`@kojo/app`） | 通过，exit 0 |
| `node tools/audit-decoupling.mjs` | **A/B/C/D 四项全绿（16 插件）**（壳层仅容器/动作语义，零业务词） |

#### 手工清单（真实终端 `pnpm tauri dev` 勾验；沙箱不跑 GUI）

| # | 操作 | 预期 |
|---|---|---|
| a | 用旧版批准过写权限的工程，人为让批准记录与提议不一致（如改动提议目录后重开） | 打开项目即**重弹**写权限确认框（修复前：静默只读） |
| b | 首次打开工程选「只读浏览」 | 底部状态栏左侧出现琥珀「只读」徽章；保存按钮置灰（悬停见 tooltip） |
| c | 只读态按 `Ctrl+S` | 不写盘；右下 toast「保存被拒绝：项目当前为只读…」+「去授权」按钮 |
| d | 点 toast「去授权」/ 点状态栏「只读」徽章 | 均弹出写权限确认框；选「允许写入」后徽章变绿「可写」、保存恢复可用 |
| e | error toast 常驻不自动消失；× 可关 | 符合 |
| f | 关闭项目再重开（已批准） | 徽章直接为「可写」，不弹框 |

#### 边界未做（属后续批）

- **状态栏槽位化**：P0 徽章为壳层硬编码简化形态；P1 换五区骨架、P3 以 `ui.statusbar` 槽承载（诊断计数等入驻）。
- **插件侧写错误的通知接入**：`ui-sugar-lift` 等插件内的写盘报错暂由面板自呈现；插件 → 通知中心的通道（是否开放、以何形态）留待 P3 💡 迁移时按真实需求定。
- **重授权对话框文案差异化**：不一致重弹与首弹目前同文案（未区分「首次批准 / 批准失效」）；如需区分可给 dialog 加 reason 字段，留后续。

### 5.39 UI 重设计 P0 实机反馈修复（2026-10-11 批：取消授权后重授权入口可见化 + 失败不再静默）

> 触发：P0 实机勾验反馈——「误点『只读浏览』后无法重新选择权限」；b（琥珀只读徽章 + 保存置灰 tooltip）、f（已批准工程重开直接可写、不弹框）两项通过。

#### 静态结论（先证实再修）

读路径**完全没有**写权限门控，可逐条取证：

- 内核 `io.readText`（`io.ts:59`）无 `isWritable` 检查；`isWritable` 只被 `writeText`/`remove`（`io.ts:153`）调用。
- `packages/app/src` 全量 grep `writable|isWritable|setWritable`：28 处命中的全部是本次新增的保存链与徽章代码，FileTree / EditorPane 的**读取**路径零命中。
- Rust 宿主仅 `ensure_in_write_domain`（写/删第二道闸，`lib.rs:78`），**不存在读域**。

因此「取消授权 → 无法读取项目」在权限语义上不成立，只可能来自三种机制：① 遮罩遮挡（`.modal-mask` `position:fixed;inset:0`）；② `openProject` 抛错回落 welcome；③ React 树崩溃白屏。第 ② 条此前**只在 WelcomeView 显示错误**，在项目阶段不可见；第 ①/③ 条沙箱无 GUI 不可复现 → 需用户侧 console 证据定位（已列入待办）。

#### 本次修复（针对可确证的两个缺陷）

1. **重授权入口可见化**（直击「无法重新选择权限」）：只读时在编辑器区顶部新增常驻 `.ro-banner`——「当前为只读：写权限未批准，保存不可用」+「去授权」按钮。原入口只有底部 24px 高的窄徽章，极易被忽略；现为**第三个入口**（编辑器横幅 + 状态栏徽章 + 通知 action），与定稿 Q9 不冲突。
2. **失败不再静默**：`decideApproval` 的 `allow=true` 分支此前先 `setPendingApproval(null)` 再 `await approveWritablePaths`，失败时只 `setError`——而 `error` **只在 WelcomeView 渲染**，项目阶段完全不可见。表现为：对话框关闭、徽章仍是「只读」、无任何提示 = 用户认知里的「点了没反应」。现在失败 → 中文错误 toast + 徽章维持只读。
3. **打开失败可见化**：`openProject` 的 catch 补 error toast（原来只落 welcome 错误区），避免「项目读不了却不知原因」。
4. **通知中心提升到入口层**：`main.tsx` 装配 `<NotificationCenter>`，App 自身成为消费者（此前 App 在 Provider 之外，无法发通知）。toast 渲染逻辑不变，仍为壳层私有。

#### 文件变更

| 文件 | 变更 |
|---|---|
| `packages/app/src/main.tsx` | 入口层装配 `NotificationCenter` |
| `packages/app/src/ui/App.tsx` | `useNotify()`；打开失败 / 授权失败 → error toast；授权失败显式 `setWritable(false)`；移除内层 Provider |
| `packages/app/src/ui/ProjectView.tsx` | 编辑器区只读横幅 +「去授权」（新增第三个入口）；`.editor-body` 包裹层 |
| `packages/app/src/styles.css` | `.editor-host` 改列向；新增 `.editor-body` / `.ro-banner` |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（零回归） |
| `pnpm typecheck`（root / `@kojo/app`） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 待用户补齐的证据（未能静态定位的部分）

「取消授权后无法读取项目」需区分三选一，才能对症修：

| 需确认 | 方式 |
|---|---|
| 是否回落 welcome | 取消后是否看到「选择 eraTW 游戏目录」卡片（而非编辑器） |
| 是否遮罩未关 | 取消后画面是否仍被灰罩覆盖、点任何处无反应 |
| 是否白屏/崩溃 | DevTools（WebView2 右键「检查」）Console 有无红色报错；有则贴原文 |

### 5.40 UI 重设计 P0 实机反馈修复之二（2026-10-11 批：索引阶段可见化）

> 触发：实机反馈第 2 轮——「取消后进入，无法点开 erb 文件框（无法加载），无法加载函数树」。

#### 取证与归因（先证伪再动手）

- **读路径与写权限无关**（§5.39 已证）：`io.readText` 无 `isWritable` 检查；Rust 仅 `ensure_in_write_domain`。
- **索引构建全程不写盘**：`erb-parser/src/plugin.ts` 的 `build()` 只用 `io.walkDir` + `io.readText`，无任何 `writeText`/缓存写入。故「索引缓存在无写权限下失败」的假设**证伪**。
- **两棵树同源**：`ProjectView` 的「口上文件」树吃壳层 `index` prop，「函数树」是 `ui-kojo-navigator` 面板、经 `ensureIndex()` 取同一个索引。两者同时为空 ⇒ `index` 为 null／为空，而非两个独立故障。
- **取消只是时间巧合**：写权限对话框在 `setPendingApproval` 时弹出，**早于** `await parser.ensureIndex()`（约 3s 窗口），用户的取消动作落在这个窗口内；但取消本身不改动索引链路（仅 `setWritable(false)`）。

结论：症状真正的原因是**索引阶段的失败/未完成被静默吞掉**，用户无从区分「还在构建」与「已失败」。

#### 本次修复

1. **索引失败不再回退欢迎页**：`openProject` 内 `ensureIndex()` 单独 try/catch——失败时保留项目视图（维持可浏览），置 `indexError` 并发 error toast。原先失败会走外层 catch → 回 welcome，用户只看到「项目打不开」，无法定位到索引。
2. **状态栏索引诊断**（`ProjectView`）：新增 `indexError` prop 与状态栏中段——「索引构建中…」／「N 文件 · M 函数」／红色「索引失败：原因」。两个树同时为空时，一眼可辨是构建中还是失败。

#### 文件变更

| 文件 | 变更 |
|---|---|
| `packages/app/src/ui/App.tsx` | `indexError` 状态；索引阶段独立 try/catch（不回退欢迎页）；失败 error toast；关闭项目时清理 |
| `packages/app/src/ui/ProjectView.tsx` | `indexError` prop + 状态栏索引诊断三元显示 |
| `packages/app/src/styles.css` | `.sb-idx` / `.sb-idx.err` |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（零回归） |
| `pnpm typecheck`（root / `@kojo/app`） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 待用户回传的判别信息

| 需确认 | 判别含义 |
|---|---|
| 状态栏显示「索引构建中…」一直不变 | `ensureIndex()` 未 settled（索引在途卡住） |
| 状态栏显示「0 文件 · 0 函数」 | 索引构建成功但为空（适配器 `kojoPaths` 未解析出目录） |
| 状态栏显示「N 文件 · M 函数」但两树仍空 | 壳层索引正常，问题在面板侧（导航器 `refresh()` 静默失败） |
| 状态栏红色「索引失败：…」 | 已拿到根因文本，按文本直接修 |

### 5.41 UI 重设计 P0 实机反馈修复之三（2026-10-11 批：函数树失败态可见 + 头部自救按钮）

> 触发：实机反馈第 3 轮——「打开此前未授权的项目，函数树停在『打开项目后自动构建函数索引…』占位；没有按钮重新授权，也没有按钮清理缓存后重开项目」。

#### 根因定位（第 3 轮取证）

- 导航器空态条件已查明：`ui-kojo-navigator/src/index.ts` 中 `if (!indexReady)` → 占位文案。`indexReady` 仅在 `rebuild(index)` 成功路径置 true。
- **`refresh()` 的失败路径被静默吞掉**：`parser.ensureIndex().then((index) => rebuild(index)).catch((err) => ctx.log.warn(...))`——注意 `.then` 里的 **`buildNavigatorTree(...)` 抛错也落入同一个 `.catch`**，于是 `tree` 未被赋值、`indexReady = true` 永不执行、`loadError` 不存在 → **面板永久停在占位，用户既看不到失败原因，也没有任何重试入口**。
- 排除项（逐条证伪）：读路径无写权限门控（§5.39）；Rust `walk_dir` 用 `filter_map(|e| e.ok())`，目录不存在只返回空数组而非报错，故「路径不存在导致 build 整体失败」不成立；索引构建全程不写盘（§5.40）。
- 巧合因素：写权限对话框弹出早于 `await parser.ensureIndex()`（约 3s 窗口），用户动作落在此窗口内，但取消只写 `setWritable(false)`，与索引链路无因果。

#### 本次修复

1. **导航器失败态可见 + 可重试**（插件侧，零契约变更）：新增 `loadError` 状态，`refresh()` 的 catch 记录原因（`ctx.log.error`），面板渲染优先级改为 **失败态 → 构建中态 → 正常树**；失败态显示「函数索引加载失败：<原因>」+「重试」按钮（点击重新 `refresh()`）。占位文案改为「正在构建函数索引…（首次打开项目需要数秒）」，与失败态可区分。
2. **项目头部两个自救按钮**（用户明确诉求，放在用户视线所在的头部而非编辑器区）：
   - 「重新授权」：仅在只读时显示（与状态栏徽章、编辑器横幅共同构成入口）；
   - 「重载项目」：`close` → 同目录 `open`，重建口上域索引（内存索引全部丢弃重算；磁盘文件不动）。重载走 `keepView` 选项，不切回欢迎页，避免「项目被关掉」的错觉。

#### 文件变更（仅本批作者改动）

| 文件 | 变更 |
|---|---|
| `packages/plugins/ui-kojo-navigator/src/index.ts` | `loadError` 状态；catch 记录原因；失败态 + 重试按钮；占位文案区分 |
| `packages/app/src/ui/ProjectView.tsx` | 头部 `.proj-actions`：「重新授权」（只读时）+「重载项目」+「关闭项目」 |
| `packages/app/src/ui/App.tsx` | `openProject(dir, { keepView })`；`onReload` 接线 |
| `packages/app/src/styles.css` | `.proj-actions` / `.nav-empty.err` |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（零回归） |
| `pnpm typecheck`（root） | 通过 |
| `pnpm typecheck`（`@kojo/app`） | **未通过，但错误全部落在 `src/ui/layout.ts`（5 处 `noUncheckedIndexedAccess`，行 112/117）** —— 该文件为**未跟踪、无任何 import 引用**的并行 P1 WIP（五区布局骨架：视图分组 / aux / bottom / zen），非本批产物；本批 4 个文件自身无类型错误 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 工作区中非本批作者的在途改动（未提交，勿混入本批）

| 文件 | 内容 |
|---|---|
| `packages/plugin-api/src/slots.ts` | P1/P2 契约草案：`PanelLocation`、`ui.toolbar` / `ui.statusbar` / `ui.overlay` / `ui.editor.codeAction` 槽、`keybinding`（全部 additive） |
| `packages/plugin-api/src/index.ts`、`events.ts` | 同上批次的类型导出与 `ui.overlay.open` 事件 |
| `packages/app/src/ui/layout.ts` | 未跟踪的 P1 布局骨架（5 处类型错误） |
| `packages/app/src/ui/EditorPane.tsx` | `pickSaveHandler` 单贡献抛错隔离（行为改进，非本批） |

### 5.42 UI 重设计 P1 · 壳层骨架批（2026-10-12 批：五区布局 + 活动栏 + 三容器 + 10 面板迁移）

> **定位**：把壳层从「单一左侧栏堆 10 块面板」重造为 VSCode 式五区布局
> （工具栏 / 活动栏+主侧栏 / 编辑器区 / 副侧栏 / 底部区 / 状态栏）的**骨架批**（定稿 §四）。
> 契约**全部 additive**：所有新字段 optional，缺省行为 = 现状（任一中间态可运行）。
> 宿主保持**零业务知识**——壳层只提供容器/动作语义，业务面板仍全部驻留插件。
> commit `4ae9366`。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/plugin-api/src/slots.ts` | 修改 | `ui.panel` 贡献 additive 扩展：`location?: PanelLocation`（`'sidebar'\|'aux'\|'bottom'`，缺省回落 `sidebar`）/ `defaultActive?: boolean`（缺省 true；false = 低频）/ `group?: string`（同 group 合并为单视图）；新增槽 `ui.toolbar` / `ui.statusbar` / `ui.overlay` / `ui.editor.codeAction`；`editor.command` 贡献 `keybinding?`；`SlotMap` 登记全部新槽 |
| `packages/plugin-api/src/index.ts` | 修改 | 导出 `PanelLocation` / `ToolbarContribution` / `StatusbarContribution` / `OverlayContribution` / `EditorCodeAction` / `EditorCodeActionContribution` 等 |
| `packages/plugin-api/src/events.ts` | 修改 | `KernelEventMap` additive 新增 `'ui.overlay.open': { id: string; payload?: unknown; source?: string }` |
| `packages/app/src/ui/layout.ts` | **新增（222 行）** | 布局**纯逻辑**（零 React）：`effectiveLocation` / `organizePanels` / `defaultActiveOf` / `defaultLayout` / `loadLayout` / `saveLayout` / `resetLayout` / `sanitizeContainer` / `reconcileLayout`；常量 `DEFAULT_SIDEBAR_SIZE=260` / `DEFAULT_AUX_SIZE=360` / `DEFAULT_BOTTOM_SIZE=200` / `SIZE_LIMITS` |
| `packages/app/src/ui/ShellLayout.tsx` | **新增（539 行）** | 五区渲染 + reducer + 命令注册表桥接 + 全局键盘（Ctrl+B/J、Alt+B、Ctrl+K Z 和弦、Esc 优先级 picker>overlay>zen、F1）+ `startDrag` 尺寸拖拽 + `WorkbenchApi` 注册出口 + 全禅形态渲染分支 |
| `packages/app/src/ui/PanelHost.tsx` | 修改 | `PanelBody`（按 location 分派容器）/ `StatusbarItem` |
| `packages/app/src/ui/ProjectView.tsx` / `App.tsx` / `EditorPane.tsx` | 修改 | 接入五区骨架；EditorPane 顺带合入并行线的 save-handler 匹配错误可见化（`console.warn`） |
| `packages/app/src/styles.css` | 修改（+317/−…） | 滚动条全局主题化 + 容器级滚动；token 扩展（spacing/radius/z/字号）；`:focus-visible` 描边 |
| `packages/plugins/*/src/index.ts`（10 面板） | 修改 | 按定稿 §四迁移表归位（见下表） |

**10 面板迁移参数**（定稿 §四迁移表原样落地）：

| 面板（插件） | location | 其他 |
|---|---|---|
| 归档浏览器（`ui-archive-browser`） | aux | `defaultActive:false` |
| 状态注入器（`ui-snapshot-injector`） | aux | `defaultActive:false` |
| 状态回放（`ui-state-replay`） | aux | `defaultActive:false` |
| 升糖（`ui-sugar-lift`） | aux | `defaultActive:false` |
| 糖预览（`ui-sugar-preview`） | aux | —（默认激活） |
| 约定校验（`ui-convention-report`） | bottom | Problems 形态；`defaultActive` 未改 |
| 糖判定（`ui-sugar-editor`） | bottom | `defaultActive:false` |
| 函数树（`ui-kojo-navigator`） | sidebar | `group:'explorer'`（与内建口上文件树合并） |
| 插件状态（`ui-plugin-status`） | sidebar | `defaultActive:false`（活动栏底部齿轮位） |
| （内建）口上文件树 | sidebar | `group:'explorer'` |

#### 关键设计决策

1. **契约 additive、缺省即现状**：`location`/`defaultActive`/`group` 全 optional；未声明 `location` 的面板回落 `sidebar`——10 面板之外的第三方面板**零改动仍可用**。这是定稿「任一中间态可运行」的硬要求，避免出现「必须同步改所有插件才能启动」的窗口期。
2. **布局状态住壳层私有域**：持久化 key `kojo.ui.layout.v1` 写在 WebView `localStorage`（壳层私有），**不进内核存储域**——布局是宿主形态而非业务数据，符合「宿主容器/动作语义、业务驻留插件」的分工。
3. **函数树与文件树合并成 Explorer 组**：`group:'explorer'` 使两个 `ui.panel` 贡献合成**单视图**（VSCode Explorer 形态），视图内切换而非占两个活动栏位；图标取 group 内最小 order 者。
4. **低频面板 = 活动栏底部齿轮位**：`defaultActive:false` 的面板不占常规活动栏图标，收进底部「更多」入口，减少常驻视觉噪声（归档/注入/回放/升糖/糖判定/插件状态均属此类）。
5. **抽屉尺寸可拖拽、可重置**：三容器各有默认尺寸与 `SIZE_LIMITS`；拖拽 `startDrag` 改内联尺寸并持久化；「重置布局」调 `resetLayout` 回默认。
6. **`reconcileLayout` 兜底脏数据**：持久化布局加载时清洗——失效激活项回落（面板被移除/改名）、非法 `override` 丢弃、尺寸非法回落默认、`zen` 仅显式 `true` 才生效。避免篡改/降级后的 localStorage 卡死界面。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（零回归；本批为纯壳层/契约改动，未新增单测） |
| `pnpm typecheck`（root / `@kojo/app`） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 手工清单（P1 实机勾验）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 打开工程 | 五区布局呈现：顶部工具栏 / 左活动栏+主侧栏 / 中编辑器 / 右副侧栏 / 底部区 / 状态栏 |
| 2 | 点活动栏图标 | 主侧栏切换到对应面板；再点收起 |
| 3 | 打开「函数树」与「口上文件」 | 合并进同一 Explorer 组，组内切换 |
| 4 | 底部区 | 显示「约定校验」；「糖判定」在底部区低频入口 |
| 5 | 低频面板（归档/注入/回放/升糖/插件状态） | 收在活动栏底部齿轮位，不占常规图标 |
| 6 | 拖拽容器边界 | 主侧栏 / 副侧栏 / 底部区尺寸可调 |
| 7 | 关掉重开应用 | 面板归位与尺寸**保持不变**（localStorage 持久化） |
| 8 | 点「重置布局」 | 回到默认五区布局 |

#### 边界未做（属 P4）

- **三容器间拖拽移动面板** + `override` 持久化（P4）
- **全禅细化**（隐藏五区仅留编辑器 + 迷你状态栏；居中限宽设置项）（P4；P1 已具 `zen` 渲染分支与 Ctrl+K Z 入口）
- **设置 overlay（限宽开关）** 与**可选面包屑槽**（P4）

### 5.43 UI 重设计 P2 · 命令与工具栏批（2026-10-12 批：命令体系 + overlay 宿主 + 新建口上文件向导）

> **定位**：定稿 §五/§六落地。把散落的快捷键收敛为**统一命令注册表**，补全
> overlay 宿主与「新建口上文件」向导。commit `e4663aa`（主体）+ `0bf2eb9`（事件白名单补全）。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/app/src/ui/commands.ts` | **新增（144 行）** | 壳层**纯逻辑**：`parseKeybinding`/`formatKeybinding`/`chordFromEvent`/`keybindingMatches`；`buildCommandRegistry`（壳层布局命令 + `editor.command` 槽贡献合并为**单一真源**）；`commandEnabled`（`when` 判定，抛错隔离为不可用）；`filterCommands` / `filterFileCandidates`（命令面板与快速打开过滤） |
| `packages/app/src/ui/Palette.tsx` | **新增（177 行）** | 命令面板（Ctrl+Shift+P / F1）+ 快速打开（Ctrl+P）**共用**模态选择器 `Picker`：↑↓/Enter/Esc 键盘导航、`stopPropagation` 防误穿透 |
| `packages/app/src/ui/ShellLayout.tsx` | 修改（+139） | 全局快捷键改由注册表驱动（Ctrl+B/J、Alt+B 迁入注册表；Ctrl+K Z 和弦保留特例）；Esc 优先级 picker > overlay > zen；**`ui.overlay` 宿主**——订阅 `ui.overlay.open`（P1 事件）/ `ui.overlay.close`（本批 additive 新增），遮罩 + Esc/点击遮罩关闭语义由宿主提供 |
| `packages/app/src/ui/ProjectView.tsx` | 修改（+5） | 快速打开候选 = 索引**全量文件路径**（泛型路径列表，壳层零业务） |
| `packages/plugins/ui-sugar-editor/src/new-file-wizard.ts` | **新增（238 行）** | 新建口上文件向导**纯逻辑**：`previewFileName`（`{n}` 代入 / 家族段拼接 / 非法字符与空白剔除）/ `buildTemplate`（生成含 `;` 注释 + `角色:` + `口上:` + 时机块的 `.kojo` 骨架） |
| `packages/plugins/ui-sugar-editor/src/index.ts` | 修改（+54） | 新建命令 `kojo.newKojoFile`（Ctrl+N / category「文件」/ `when: project!==null`）；`ui.toolbar` 贡献（只引用命令 id）；`ui.overlay` 贡献「新建口上文件」向导（选角色 → 家族 → 起始时机/编号 → 文件名实时预览 → 落盘 → 打开定位） |
| `packages/plugin-api/src/events.ts` | 修改（+6） | `ui.overlay.close` additive 新增 |
| `packages/kernel/src/bus.ts` | 修改（+7/−1） | **`KERNEL_EVENT_NAMES` 补全** `ui.overlay.open` / `ui.overlay.close` / `editor.activeFileChanged`（见决策 6） |
| `packages/plugins/ui-sugar-editor/tests/integration.test.ts` | 修改 | 假内核新增硬依赖（`kernel.project` / `kernel.slots`）与两新槽收集 | 

#### 关键设计决策

1. **命令单一真源**：快捷键、命令面板、工具栏按钮**都指向同一份命令注册表**——`buildCommandRegistry` 把壳层布局命令与 `editor.command` 槽贡献合并，发射与展示同源，杜绝「按钮能用、快捷键失效」类漂移。工具栏按钮**只引用命令 id**，不携带行为。
2. **壳层零业务**：快速打开的候选是索引的**全量路径列表**（泛型字符串），壳层不认识「口上」概念；「新建口上文件」的全部命名知识住在 `ui-sugar-editor`。
3. **命名知识经 adapter 推导，fail-closed**：向导的「角色/家族/时机」下拉与文件名模板取自 `game.adapter` 的 `kojoFaceTemplates.registration.declare`（如 `M_KOJO_K{n}`）；**模板缺省即显式不可用**（不猜、不回退内建模板），与 §5.33 的解耦补齐同口径。
4. **写权限首屏预检**：向导在**打开时**即调 `io.isWritable` 预判，不等到落盘才失败（定稿 §6.1）；不可写时给出提示而非「填完才炸」。
5. **overlay 宿主只提供容器语义**：遮罩、Esc/点击关闭、层级全部由壳层提供；具体表单由插件贡献。宿主仍不知道 overlay 里是什么。
6. **事件白名单必须随契约同步**（`0bf2eb9` 的教训）：P1/P2 新增的 `ui.overlay.open`/`ui.overlay.close`/`editor.activeFileChanged` **未同步进 `KERNEL_EVENT_NAMES`**，插件经 `scopedBus.emit` 会被命名空间纪律拦截**抛错**——向导命令链因此断裂。补白名单后恢复。**新增内核事件时，白名单是契约的一部分，必须同批更新**。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（零回归；向导纯逻辑随后在 §5.45 补测） |
| `pnpm typecheck`（root / `@kojo/app`） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 手工清单（P2 实机勾验）

| # | 操作 | 预期 |
|---|---|---|
| 1 | `Ctrl+Shift+P` 或 `F1` | 命令面板弹出，可搜命令并执行 |
| 2 | `Ctrl+P` | 快速打开弹出；输入文件名命中**优先于**路径命中 |
| 3 | 工具栏「新建口上文件」按钮 | 打开向导 overlay（与 `Ctrl+N` 等价） |
| 4 | 向导选角色/家族/起始时机与编号 | 文件名**实时预览**，含家族段与编号 |
| 5 | 向导点「创建」 | 落盘 `.kojo` 骨架（含 `;` 注释、`角色:`、`口上:`、时机块）并打开定位 |
| 6 | 在只读态打开向导 | 首屏即提示不可写（不等落盘才报错） |
| 7 | 按 `Esc` | 关闭 overlay（不改动文件） |

#### 边界未做

- **overlay 富交互**（拖拽定位 / 多步向导回退）留后续；本批为表单式单页向导。
- **工具栏图标体系**：按钮暂用文本/简单图标，完整图标集待设计资源。

### 5.44 UI 重设计 P3 · 编辑器深化批（2026-10-12 批：多标签 + 💡 CodeAction + 状态栏诊断计数）

> **定位**：定稿 §6.4（多标签）与 §五/§六（💡 升糖、诊断聚合）落地。
> commit `63f362e`（P3a 多标签）+ `9e72af0`（P3b 💡 + 诊断计数）。

#### 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/app/src/ui/App.tsx` | 修改（+119） | **tabs 模型**：`openTabs` / `dirtyPaths` / `pendingClose`；`commitOpenFile` / `doCloseTab`（激活邻居：优先右侧、末尾取左侧）/ `requestCloseTab` / `decideClose` / `saveAll` |
| `packages/app/src/ui/EditorPane.tsx` | 修改（P3a +309 / P3b +62） | **多 model 重构**：每标签一个 model，切换 `saveViewState → setModel → restoreViewState`；逐 model **版本号 O(1) 脏判定**（BUG-4 方案延伸到后台标签）；`openPaths` 差集 `dispose` 防泄漏；`save`/`savePath`/`saveAll` 动作句柄注册（保存接管链对后台标签同样生效，`needs-choice` 跳过并通知）。**P3b**：适配 `ui.editor.codeAction` 槽——`registerCodeActionProvider` 只做 Monaco 协议转换，执行经 `registerCommand` 落地（参数以 id 反查 `pendingActionsRef`，避免闭包捕获过时文本）；单贡献抛错隔离记日志 |
| `packages/app/src/ui/ProjectView.tsx` | 修改（P3a +131） | 标签栏（中键 / × 关闭、脏点 ●、溢出横向滚动）+ 空态三动作（快速打开 / 新建口上文件 / 命令面板，经 `WorkbenchApi` 反向触发） |
| `packages/app/src/ui/ShellLayout.tsx` | 修改（+44） | `extraCommands` 并入统一命令注册表（Ctrl+W 关闭标签、Ctrl+Shift+S 全部保存）；`WorkbenchApi`（`openQuickOpen`/`openPalette`/`hasCommand`/`runCommand`）注册出口 |
| `packages/app/src/ui/UnsavedConfirmDialog.tsx` | 修改（+26） | `context` 扩展（`close`/`switch` 文案分野） |
| `packages/plugins/ui-sugar-lift/src/index.ts` | 修改（+41） | 新增 `ui.editor.codeAction` 贡献「升糖：全部应用」（`kind:'refactor'`）：`provideActions` 按文本 memo（Monaco 反复调用），`run` 时**重读盘 + 重扫**再经 applier `applyToFile` 应用；aux 兜底面板保留 |
| `packages/plugins/ui-convention-report/src/index.ts` | 修改（+26） | 新增 `ui.statusbar` 贡献：错误/警告/提示**聚合计数**（颜色同面板 `SEVERITY_COLOR`）；点击落地为 title 提示 `Ctrl+J` |
| `packages/app/src/styles.css` | 修改（P3a +69 / P3b +5） | 标签栏 / 脏点 / 空态动作 / `.sb-diag` |

#### 关键设计决策

1. **切换标签零丢失**：model 常驻内存（不随切换 dispose），切换用 `saveViewState`/`restoreViewState` 保留滚动与光标；未保存确认**只发生在关闭脏标签**时，切来切去不打扰。
2. **脏判定 O(1)**：用 Monaco `getAlternativeVersionId()` 记基线版本号，**O(1)** 判定脏态，避免每次全文本 diff（BUG-4 方案延伸到每个后台标签）。
3. **供给与执行分离（防闭包过时）**：`codeAction` 的 `provideActions` 与 `run` 可能间隔用户编辑——`provideActions` 只产「标题 + 种类 + id」，`run` 时以 id 反查最新 pending 动作并**重读盘 + 重扫**再应用，**以最新盘态为准**（沿用 §5.37 的「执行前重读」纪律）。
4. **P0 临时徽章保持宿主渲染**：`writable`/`onReauth` 状态在 App 层，槽位化收益不足，本批**不**迁移（明确记录，避免"似乎可槽位化"的误判）。
5. **诊断计数不假装可点**：壳层暂无「打开指定容器」通用事件，`ui.statusbar` 贡献点击落地为 title 提示 `Ctrl+J`——**不静默、不假装可点**（可点却无反应是最差的交互）。
6. **💡 与 aux 面板并存**：升糖从「专用面板」升格为编辑器内 💡（`refactor`），但 aux 兜底面板**保留**（`defaultActive:false`）——避免"面板迁移即功能消失"。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **959 passed / 6 skipped（965）**（零回归） |
| `pnpm typecheck`（root / `@kojo/app`） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 手工清单（P3 实机勾验）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 依次打开多个文件 | 标签栏累积标签；点击切换，滚动/光标位置保留 |
| 2 | 改一个标签不保存 → 切走再切回 | 内容不丢（后台 model 常驻） |
| 3 | 关闭**未修改**标签 | 直接关闭；激活邻居（优先右侧，末尾取左侧） |
| 4 | 关闭**脏**标签 | 弹未保存确认（关闭文案分野） |
| 5 | 中键点标签 / 点 × | 均可关闭 |
| 6 | `Ctrl+W` / `Ctrl+Shift+S` | 关闭当前标签 / 全部保存 |
| 7 | 在 ERB 候选函数处看 💡 | 出现「升糖：全部应用」动作，可一键应用 |
| 8 | 应用升糖后观察 | 源文件按最新盘态变化（与 aux 面板语义一致） |
| 9 | 状态栏诊断计数 | 显示错误/警告/提示聚合数，悬停给出 `Ctrl+J` 提示 |

#### 边界未做（明确记录）

- **codeAction 应用后编辑器 model 不自动重载**：与升糖面板既有语义一致；由 `file.changed` 驱动的 model 自动刷新（避免脏 model 再 Ctrl+S 用旧文本覆盖升糖结果）**留待后续专项**。
- **诊断计数点击直达容器**：待壳层新增「打开指定 `ui.panel` 容器」通用事件后接线。

### 5.45 UI 重设计审阅修复与补测批（2026-10-12 批：P1–P3 代码审阅 + 3 处修复 + app 层补测 48 项）

> **触发**：用户切换至审阅模型（DeepSeek）接管「审阅代码 + 测试 + 撰写文档」环节。
> 本批为**只读审阅 + 精准修复 + 补测**，不改动 P1–P3 已交付的行为契约。
> 审阅报告见 `docs/archive/REVIEW-UI-P1-P3-2026-10-12.md`。

#### 审阅范围

对 P0–P3 全部代码做静态审阅（重点：P1 壳层骨架 / `layout.ts` 纯逻辑、P2 命令体系与向导、
P3 多标签与 codeAction 适配），逐点核对「一切皆插件」解耦纪律与 additive 契约；
并针对**缺乏测试覆盖的壳层纯逻辑**补测。

#### 修复项（3 处）

| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| F1 | `packages/app/src/ui/commands.ts` | 快速打开「文件名优先」在 **Windows `\` 路径**上失效——`baseNameOf` 只认 `/`，`D:\...\M_KOJO_K1_日常.ERB` 取不到末段，文件名命中退化为子串命中 | 抽出 `baseNameOf(lowerPath)`（同时认 `/` 与 `\`），`filterFileCandidates` 改用它 |
| F2 | `packages/app/src/ui/commands.ts` | `formatKeybinding` **功能键不大写**——`f1` 原样回显为 `f1`（命令面板展示不统一） | 单字符键与 `/^f\d+$/` 功能键一律 `toUpperCase()`（`f1`→`F1`） |
| F3 | `packages/app/src/ui/EditorPane.tsx` | codeAction id 用 `#${pending.size}`——**Monaco 可能持有上一轮列表**，id 复用会解析到别的动作；且 `pending.clear()` 每次供给即清，无界增长防护缺失 | 新增 `actionSeqRef`（**单调递增不复用**）产 id；`pending.clear()` 改为阈值清理（`size > 500` 才清） |

#### 补测项（新增 3 文件，共 **48 项**）

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `packages/app/tests/commands.test.ts` | 21 | keybinding 解析（修饰键顺序无关 / 别名 `control`·`cmd`·`super` / 非法→null）、`chordFromEvent`（修饰键本身不产 chord / Shift 大写归一 / 多按修饰键不等）、`formatKeybinding`（`shift+ctrl+p`→`Ctrl+Shift+P` / `f1`→`F1` / 无法解析原样回显）、`buildCommandRegistry`（壳层归「布局」类目 / 同 id 槽贡献覆盖壳层 / 覆盖后原 keybinding 不保留 / 壳层 `run` 不接 `ctx`）、`commandEnabled`（无 when 恒可用 / when 抛错→false）、`filterCommands`（空查询首项 / id 参与匹配 / 无匹配空数组）、`filterFileCandidates`（`\` 路径文件名优先 / 目录命中不丢项 / cap / 大小写不敏感） |
| `packages/app/tests/layout.test.ts` | 17 | `effectiveLocation`、`organizePanels`（未迁移回落 sidebar / group 合并 + order 升序 + 图标取最小 order 者 / override 改变归属）、`defaultLayout`+`defaultActiveOf`（低频跳过）、持久化（round-trip / 重置 / 坏数据→null）、`reconcileLayout`（失效激活项回落 / 非法 override 丢弃 / override 后重编排 / 尺寸非法回落默认 / `zen` 仅显式 true） |
| `packages/plugins/ui-sugar-editor/tests/new-file-wizard.test.ts` | 10 | `previewFileName`（`{n}` 代入 / 家族段 `_` 拼接 / 空白剔除 / 非法字符剔除 / 多处占位）、`buildTemplate`（无家族 `; 露米娅（12）\n角色: 12\n` / 家族同步进注释与 `口上:` / 时机块 4 空格缩进 + 编号 / 编号空白剔除 / 非法字符同步剔除） |

配套改动：`packages/app/tsconfig.json` 的 `include` 增加 `"tests/**/*.ts"`（使新增 app 层测试进 `@kojo/app` typecheck）。

#### 关键坑与发现

1. **`filterFileCandidates` 的断言要按真实语义写**：初版断言 `'M_KOJO_K1_'` 期望 2 项，实际 1 项——`M_KOJO_K12_` **不含** `K1_` 子串，是**测试写错**而非实现错；应改断言（顺带验证大小写不敏感），**不放宽实现去迁就错测试**。
2. **功能键展示是真实（轻微）缺陷**：`formatKeybinding('f1')` 期望 `F1` 实得 `f1`——判断为真实缺陷 → **改实现**（与 F1 同类，一次性补齐功能键大写）。
3. **Node 22+ 可能自带实验性 `localStorage`**：`layout.test.ts` 若用 `delete globalThis.localStorage` 复位，可能因属性不可删在严格模式抛 `TypeError`。改用 `Object.defineProperty(globalThis,'localStorage',{value,configurable:true,writable:true})` 注入替身，并在 `afterEach` 装空替身。
4. **测试替身要随契约一起长大**（§5.37 关键坑 3 的同源复发）：假内核 `slots.register` 若只收集已知槽名，新增槽会被**静默吞掉**、测试仍绿（假绿）；P3b 已按槽名过滤修过一次，本批补测沿用。

#### 审阅发现（未修，记录为边界）

| # | 位置 | 观察 | 处置 |
|---|---|---|---|
| B1 | `packages/app/src/ui/EditorPane.tsx`（codeAction 应用路径） | 应用后编辑器 model 不自动重载，脏 model 再 Ctrl+S 会用旧文本覆盖升糖结果 | 数据丢失风险；**留待后续专项**（`file.changed` 驱动 model 刷新），原 P3b 提交信息已声明 |
| B2 | `packages/app/src/ui/layout.ts`（`sanitizeContainer`） | 持久化尺寸未按 `SIZE_LIMITS` 钳制 | 仅被**篡改**的 localStorage 触发；`reconcileLayout` 已兜底非法尺寸回落默认，低危 |
| B3 | `packages/app/src/ui/App.tsx`（`openProject({keepView:true})`） | 重载项目不清 `openTabs`/`dirtyPaths` | 同目录重载、设计上保留标签；如需"重载即清"再议 |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **1007 passed / 6 skipped（1013）**（959 → 1007，**+48**；零回归） |
| `pnpm typecheck`（root / `@kojo/app`，含新增 `tests` 目录） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 边界未做

- B1/B2/B3 三项审阅发现**不在本批修复**（B1 优先级最高，列为后续专项）。
- 本轮为只读审阅 + 精准修复，**不重构** P1–P3 已交付实现。

### 5.46 B1 修复 · 外部写盘后重载编辑器 model（2026-10-12 批：修 §5.45 审阅发现 B1）

> **触发**：§5.45 审阅发现 **B1**（高优先级）——codeAction（💡 升糖）应用后编辑器
> model 不自动重载，脏 model 再 `Ctrl+S` 会用旧文本**覆盖**磁盘上的升糖结果（数据丢失）。
> 用户拍板「现在就修」。

#### 根因与修法

- **根因**：`💡 升糖` 经 `sugar.liftApply` **写盘**并在成功路径发内核事件 `file.changed`
  （谁改盘谁发），但**宿主从未订阅该事件**——编辑器 model 停留在旧内容，随后保存即覆盖。
- **修法（generic，宿主零业务知识）**：宿主订阅内核 `file.changed`，据此把**打开中的对应
  model** 与磁盘重新同步。**不改** codeAction 契约、**不**让宿主认得"升糖"——纯粹消费既有
  通用事件（⚠️ 刻意**不**在 `action.run()` 之后无条件重读盘：那样在「model 脏但 codeAction
  未改盘」时会因 `磁盘 ≠ model` 误报冲突，见下）。

#### 关键设计决策

1. **三态决策 `decideExternalChange(modelText, diskText, dirty)`**（`packages/app/src/ui/external-change.ts`，纯函数可单测）：
   - `noop`（磁盘 == model，多为**自身保存回声**）→ 不动，避免无谓重置撤销栈/光标；
   - `reload`（磁盘变了、model **干净**）→ 静默替换并立为新基线（保留视图状态）；
   - `conflict`（磁盘变了、model **脏**）→ **绝不静默覆盖**：弹常驻通知「保存会覆盖磁盘
     内容」+ 动作「重新加载（放弃我的修改）」，把两条都有损的路径交给用户选。
2. **触发必须来自"确实发生了写盘"的事件，不能靠无条件重读**：若在 `action.run()` 后无条件
   重读盘比对，则「model 脏 + codeAction 未改盘」场景下 `磁盘 ≠ model` 恒成立 → 会**误报冲突**。
   `file.changed` 天然只在写盘成功时触发，语义精确。
3. **重载不是用户编辑**：以 `reloadingRef` 抑制 `onDidChangeContent` 里的脏上报（避免
   「重载 → 短暂标脏 → 再置干净」的抖动）；读盘期间若 model 已被关闭/替换（标签关闭竞态）
   则放弃（比对同一 `entry` 身份）。
4. **ViewState 保留**：活动标签重载前 `saveViewState`、`setValue` 后 `restoreViewState`，
   光标/滚动不跳（内容已变，尽力保留视口）。

#### 文件变更

| 文件 | 变更 |
|---|---|
| `packages/app/src/ui/external-change.ts` | **新增**：`ExternalChangeDecision` + `decideExternalChange`（纯函数） |
| `packages/app/src/ui/EditorPane.tsx` | 新增 `reloadFromDisk`（读盘 → 决策 → 重载/通知）+ 订阅 `kernel.bus.on('file.changed')`；`reloadingRef` 抑制重载期脏上报；`onStatusInfoRef`；model 监听加抑制守卫 |
| `packages/app/tests/external-change.test.ts` | **新增（5 项）**：noop / reload / conflict 三分支 + 状态与内容无关 + 空文本边界 |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `pnpm test` | **1012 passed / 6 skipped（1018）**（1007 → 1012，**+5**；零回归） |
| `pnpm typecheck`（root / `@kojo/app`） | 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A/B/C/D 四项全绿（16 插件） |

#### 手工清单（B1 实机勾验）

| # | 操作 | 预期 |
|---|---|---|
| 1 | model **干净**时执行 💡「升糖：全部应用」 | 编辑器内容**立即变为**升糖结果（自动重载），状态栏提示「已从磁盘重新加载」 |
| 2 | 紧接步骤 1 按 `Ctrl+S` | 保存的是**升糖后**的内容（不再覆盖回旧文本） |
| 3 | model **脏**时执行 💡 升糖 | 弹常驻通知「已在磁盘上被修改，但你有未保存的修改——保存会覆盖磁盘内容」+ 按钮「重新加载（放弃我的修改）」；不静默改动编辑器 |
| 4 | 步骤 3 点「重新加载」 | 编辑器载入磁盘（升糖后）内容，脏标记清除 |
| 5 | 步骤 3 不点、直接 `Ctrl+S` | 保存用户当前（未保存）内容——即覆盖磁盘（**已明确告知**，非静默） |

#### 边界未做

- 重载采用 `model.setValue`，**撤销栈会重置**（内容已来自磁盘，属预期）；如需保留撤销历史另议。
- `file.changed` 的 `add`/`unlink` 未在编辑器侧重载（`unlink` 的「文件已删除」提示留后续）。

### 5.47 审阅回执修复 · `pickSaveHandler` 的 `matches()` 抛错不再静默（2026-10-11 批）

> **触发**：外部审阅（针对 `ed68f231`，S7-UI `.kojo` 保存接线）第 2 条——宿主
> `pickSaveHandler` 循环内 `catch {}` **空吞**贡献者的 `matches()` 异常，把有 bug 的贡献
> **静默降级**为「未命中」，非常难诊断；且与 `plugin-api/conventions.ts`「绝不静默」约定相抵。
> 用户拍板「修第 2 条」。
>
> 同批审阅的其余判定：第 1 条（`filePathRef` 未声明 → Ctrl+S 抛 ReferenceError）为**误读**——
> 该 ref 在 `ed68f231` 即已声明并在 `useEffect([filePath])` 同步（见 HANDOFF §二 S7-UI 条目第 4 点），
> 其「建议补丁」与现有代码逐字相同，故**不采纳**；第 3 条（sort 稳定性）**不成立**（下详）。

#### 变更

| 文件 | 变更 |
|---|---|
| `packages/app/src/ui/EditorPane.tsx` | `pickSaveHandler` 的 catch 由空吞改为 `console.warn`（含贡献 `id`、路径、错误消息） |

#### 关键设计决策

1. **只加可观测性，不改语义**：异常仍**不中断**选取流程，仍退化为内核缺省保存——避免单个坏贡献
   让用户**完全无法保存**（可用性优先于严格性）。
2. **日志落 `console.warn`**：`pickSaveHandler` 是**模块级纯函数**，拿不到组件内的 `useNotify`；
   `console.warn` 是本包既有惯例（`bridge/tauri-bridge.ts` 同款）。
3. **不引入 logger 抽象**：为一行日志改构造签名 / 新增依赖注入属过度设计。
4. **不改专项排序**：`Array.prototype.sort` 自 **ES2019 起由规范保证稳定**，`matches.sort((a,b)=>…)`
   处「同 order 保持注册顺序」的注释**准确**，无需追加注册序号（驳回审阅第 3 条）。

#### 测试

- **未新增测试**，属**已知测试缺口**：`packages/app` 零 JS 测试基建（vitest `include` =
  `packages/**/tests/**/*.test.ts`，`environment: 'node'`），而 `pickSaveHandler` **模块私有**且
  `EditorPane.tsx` 顶层 `import * as monaco`（node 环境下 import 即需 DOM/jsdom + Monaco mock）。
  覆盖它须先**导出私有函数 + 为 app 引入 jsdom**，对「catch 内加一行日志」属基建级过重改动。
  该改动风险面由 app typecheck 兜住。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **1012 passed / 6 skipped（1018）**（零回归） |
| `tsc -p tsconfig.json`（root） | exit 0 |
| `tsc -p packages/app/tsconfig.json` | exit 0（⚠️ 根 tsconfig `include` **不含** `packages/app`，故必须单跑 app 的） |
| `node tools/audit-decoupling.mjs` | A–D 四项全绿（16 插件） |

#### 入库说明（并行线，重要）

- 本改动**无独立提交**：它以未提交状态留在工作区期间，被并行 UI 线 **P1 壳层骨架批 `4ae9366`**
  一并入库（`git log -S "matches('\${path}') 抛错"` 首次出现即 `4ae9366`；其父提交无该文本）。
- 故**勿**在 P1 批范围内追溯其来源，**以本节为权威记录**。

#### 边界未做

- 审阅第 4 条（错误消息归一化 / i18n）/ 第 5 条（撤销分割点跨平台验收）/ 第 6 条（Ctrl+S 集成测试
  与假 kernel 一致性）均为**建议**，非缺陷，未改。其中「Ctrl+S 端到端」已由 §5.37 手工清单判据覆盖。

### 5.48 解耦修复批 · 审阅发现 M1–M4 全量修复（2026-10-11 批）

> **触发**：`docs/archive/DECOUPLING-REVIEW-2026-10-11.md`（人工解耦审阅：audit A–D 全绿但
> 探针不扫宿主 UI 层，本轮人工复审发现 4 项）。用户指令「全部修复并推送」。

#### M1（核心）· 内核事件 emit 权限单一真源 + 编译期防漂移断言

1. **问题定性修正**：`KERNEL_EVENT_NAMES` 的语义**不是**「全部内核事件」而是
   「**插件可经 scopedBus emit 的内核事件**」（§5.36 定案：`project.writableApprovalMismatch`
   内核专属，插件伪造它 = 伪造安全提示）——故单一真源不能简单取 `keyof KernelEventMap`，
   必须做**全量 emit 权限分类**。
2. **落地**（`plugin-api/src/events.ts`，与 `KernelEventMap` 同文件）：
   - `PLUGIN_EMITTABLE_EVENT_NAMES`（12 项）+ `KERNEL_ONLY_EVENT_NAMES`（1 项：
     `project.writableApprovalMismatch`）两张字面量表，均 `satisfies readonly (keyof KernelEventMap)[]`；
   - `KernelEventName` 类型与 `KERNEL_EVENT_NAMES` 集合**由表派生**（不再手工抄两份）；
   - **`KERNEL_EVENT_CLASSIFICATION_GUARD`**：编译期断言——Map 中每一键必须被两表之一
     收录且两表不重叠，任一不满足即编译失败。**机制化根治 `0bf2eb9`**（该事故 = 契约
     加类型而 kernel 白名单漏同步，只在运行时暴露；当时修复未加防再犯）。
   - **行为零变化**：白名单内容与修复前逐字一致（12 项，快照测试守门）。
3. **kernel 侧**（`kernel/src/bus.ts`）：删除本地手工清单，改 import + re-export
   （既有导入路径 `kernel/src/index.ts` 不变）；`scopedBus` 的 `has()` 随强类型化补
   `as KernelEventName` 收窄。**意外收益**：白名单强类型化后，插件 emit 未收录事件名
   在编译期即红（测试里 `has('project.writableApprovalMismatch')` 直接被类型拒绝，
   印证防线升级）。
4. **测试**：新增 `plugin-api/tests/events.test.ts` 4 项（守卫镜像 / 12 项快照守门 /
   内核专属不在白名单 / 无重复）。

#### M2 · 宿主功能文案去游戏化 + 审计 A 项扩覆盖

1. `App.tsx` 对话框标题 / `WelcomeView` 按钮文案：「选择 eraTW 游戏目录」→「选择游戏目录」；
   「個人口上」目录描述 →「游戏可写目录」（写权限语义来自 adapter 的 writablePaths，
   宿主不该复述 adapter 的具体目录名）。
2. `WelcomeView` tagline「eraTW 口上编辑器」属**产品品牌位**（产品定位本身），提为
   `TAGLINE` 常量并以行级 `audit-allow: 品牌位文案` 豁免——功能文案继续受探针监视。
3. **审计 A 项扩覆盖**（`tools/audit-decoupling.mjs`）：`NEUTRAL_DIRS` 收编
   `packages/app/src/ui` + `packages/app/src/monaco`——本次审阅的盲区（宿主 UI 层
   游戏词绑死无门禁可拦）从此成为常驻探针。

#### M3 · `WellKnownCommands` 知名命令 id 单一真源

- `plugin-api/src/slots.ts` 新增 `WellKnownCommands`（与 `WellKnownServices` 同款模式，
  additive）：`NewKojoFile = 'kojo.newKojoFile'`。
- 接线三处：注册方 `ui-sugar-editor`（`editor.command` id + `ui.toolbar` command 引用）、
  引用方宿主 `ProjectView` 空态按钮（`hasCommand`/`runCommand`）——字符串不再两份手抄。
- 阈值纪律（审阅 M3 原案）：硬引用 ≥3 处再扩充本表，当前 1 项够用。

#### M4 · 工作区卫生

- `.gitignore` 收编 `preview/`（构建产物 exe 不进库）；三份未入库 docs
  （`CODE-REVIEW-2026-10-11.md` / `PERF-ANALYSIS-2026-10-11.md` / `PERF-REVIEW-2026-10-11.md`）
  与本批修复随本批一并入库。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **1016 passed / 6 skipped（1022）**（基线 1012 + 新增 4，零回归） |
| `tsc -p tsconfig.json`（root） | exit 0 |
| `tsc -p packages/app/tsconfig.json` | exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（A 已含宿主 UI·Monaco 层；16 插件） |

#### 边界未做

- 审阅 M1 附带观察「`project.opened`/`file.changed` 等也可被插件 emit（伪造项目打开）」
  ——现状语义如此（`file.changed` 是插件写盘后的**法定**发口，见 §5.32a 事件纪律），
  本批**只归一不收紧**；收紧属语义变更，另立批讨论。
- 审阅「UI 插件 import react」「宿主内建视图槽同构」两项为既定取舍，重申记录、不动。

### 5.49 口上项目批 P-A…P-E · 作者工作区与「新建→编辑→导入→导出→部署」全链路（2026-10-12 批）

> **触发**：`docs/KOJO_PROJECT_AND_KOJO_TREE_DISCUSSION_MINUTES.md`（`b1f260e` 归档）定调
> 「引入口上项目，与 GameProject 对偶 + 引用；项目权威、游戏目录 = 部署目标」。
> 用户指令：继续实现该愿景，界面与文案一律中文化。
> **本批跨两个会话**：P-A/P-B0/P-B/P-C/P-F 由前一会话完成，P-D/P-E 由本会话接手并完成。

#### 三条硬约束的落地核验（全批零违例）

| 约束 | 落地证据 |
| :-- | :-- |
| 新概念不进 `eratw-adapter` | workspace 服务住 `kernel/src/workspace.ts`，模型只有 `project/artifact` |
| 内核零游戏知识 | 面板只消费 `kernel.workspaces` 通用模型；「包 = 作者口上包」的解释只住 adapter。审计 A 项扩到宿主 UI 层后仍全绿 |
| 游戏目录写保护不破 | 部署写入仍过 `io.writeBytes` 双闸；导出是唯一刻意绕闸的口子，绕的理由见下 |

#### 核心设计决定（三条，值得留档）

1. **导出 = 对话框即授权**（P-D，`7dbe58f`）。新桥能力 `exportDirectory(srcDir, opts?)`，
   Rust 侧把「系统目录对话框选落点」与「整目录复制」**绑在同一个命令内**。落点刻意
   **不过**写允许域第二道闸——导出的意义正是落到白名单之外（桌面/发布目录），
   用户在对话框里的显式选择本身就是授权。**越权面为零**：JS 只能传源目录与标题，
   拿不到落点决定权。取消对话框返回 `null`（正常路径，UI 侧不留消息、不算失败）。
2. **部署的三道前置判定全部放在动盘之前**（P-E，`712a9f5`）。源必须是目录 /
   目标不得已存在（报错不覆盖——游戏目录里可能是别人已部署的包）/
   目标必须在写白名单内（未授权时**连目录都不建**，不给引擎留半成品）。
   复制走字节级 `walkDir`+`readBytes`/`writeBytes`，刻意不转码。方向唯一：
   工作区（权威）──▶ 游戏目录，永不回写；反向改动属导入。
3. **异步动作的「时序与交代」抽成控制器**（`eratw-adapter/src/package-actions.ts`）。
   忙碌态即时上脸 → 成功报出落点完整路径并 8s 自动收起 → **失败常驻**等用户读完原因
   → 新动作顶掉旧反馈并取消旧定时器。插件只接线，逻辑无需渲染面板即可单测。

#### 真机验证（本批方法学变化，重要）

任务书原写「本机无 cargo，未编译验证」——**实测该前提不成立**：`cargo 1.99.0` 在 PATH 上，
`src-tauri/target/` 依赖已预热。故本批 Rust 与 UI **全部实机验证**：

- `cargo test --lib` → 12 项全绿（含新增 3 项 `export_copy_tests`：嵌套+空子目录保留、
  **非 UTF-8 字节逐字节保真**、空源目录）。顺带把 P-A 悬着的 `remove_dir` 命令编译验证掉。
- `pnpm tauri dev` 真起壳 + `C:\game` 真实语料（141 角色 / 2,285 ERB / 99,104 函数）：
  部署 3 文件进 `001 Reimu [霊夢]` 下**逐字节一致**、嵌套未拍平、源未动；
  重开向导 → 「目标已存在」琥珀提示 + 按钮禁用；导出原生对话框标题正是传入的中文标题、
  整包连目录名复制到域外；二次导出触发 Rust 守卫 → 面板常驻红条、× 可关。
  验证后**清理全部测试痕迹**，并确认同级真实作者包未被动过。
- **顺手修掉一处只看代码和单测发现不了的缺陷**：单视图下滚动容器是 `.sidebar-views`
  而非面板自身，长树会把反馈条推出视野 → 状态条改 `sticky` 贴住视口下缘。

> **结论固化**：本机 Rust/UI 改动**不得**再以「无法本机验证」为由降级验证标准。

#### 给语法糖组留下的冲突面（已定口径，见 ADR-0005）

按 merge-base `b1f260e` 实测真冲突热点 7 文件。其中 6 处机械性，唯 `EditorPane.tsx` 是
**语义分叉**：本组 P-B0 按目录分野定只读，糖组 `3d1f8d0` 按 `ErbUnlockDialog` 显式解锁定只读，
两模型落在同一个 `readOnly` 表达式上，且糖分支尚未引入「工作区」概念。
用户已拍板正交模型（分野定默认写性 / 解锁只管游戏目录那一份这一次 / 工作区恒可编辑 ⟹ 默认禁用糖视图），
写入 **`docs/adr/0005-erb-write-permission-and-sugar-view.md`** 作为两组合并时的共同依据。
另 `plugin-api/src/events.ts` 双方各自新增事件并各自 bump 白名单计数快照，
属 `0bf2eb9` 记录过的双源漂移类型——必冲突但好修。

#### 基线与提交

| 项 | 值 |
| :-- | :-- |
| 测试 | **1080 passed / 8 skipped**（§5.46 基线 1012 → P-A…P-F 后 1064 → 本会话 P-D +13、P-E +16） |
| Rust | `cargo test --lib` 12 项全绿 |
| typecheck | root + app 双跑 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |

提交：`592f1da`(P-A) · `7012dd9`(P-B0) · `ba31916`(快照补齐) · `eaffaf6`(P-B) ·
`de029b5`(P-C) · `30ad2d8`(P-F) · `7dbe58f`(P-D) · `712a9f5`(P-E)。已推 `origin/master`。

#### 边界未做（口上项目 §5 清单剩余）

- **署名/授权一等公民**：只有 P-C 的可选 LICENSE 占位文件。纪要 §1 实测「署名在 README
  正文（`作者 holy / 最終更新 2023/10/07`），不在目录名」——抽取与展示都还没做，
  这是国内作者二次创作/汉化最容易踩的合规点，**下一批首选**。→ **已由 §5.50 完成**。
- **导出 ZIP**：Rust 无压缩依赖（`Cargo.toml` 无 zip crate），需独立一批。
- **直连模式**：P-B0 已让已授权的游戏目录 ERB 可编辑，但没有显式模式开关（纪要 §4-2 半通）。
- **多剧本编号 UI 表达**：`scriptNo` 进了 meta 与 README 文本，口上树上不显示。
- **导入日文包的「中日对照」**：纪要 §6-2 开口子，未做。

### 5.50 口上项目批 T2 · 署名 / 授权一等公民（2026-10-12 批）

> **触发**：§5.49 遗留清单首选项。纪要 §1 实测「署名在 README 正文，不在目录名」——
> 二次创作 / 汉化最容易丢的就是原作者，而它**只存在于一段自由文本里**。

#### 先测真实语料，再定语义（本批最大价值不在代码）

按 §九-1/-15 铁律，动手前 dump 了 `個人口上` 全树（155 角色目录 / 214 作者包）的真实形态。
**三次实测推翻了三次直觉**：

1. **文件名远比想象野**：首轮分类器只认 65.9%。dump 漏网包后发现真存在的形态有
   `read me.txt`（带空格）/ `read_me.txt` / `readme(2023.2.1).txt` /
   平假名谐音 `れあどめ` `れあどみ` `りどみ` `りーどみすちー`（**长音与 め/み 两写**，
   只能 `[れり]ー?あ?ど[めみ]` 一条通吃，枚举必漏）/ 中文 `读我读我读我` `讀我2` `口上说明` /
   异体字 `更新履歴`（歴）与 `更新履历`（履）并存。修后 **69.6%**。
2. **`ライセンステンプレ(ート).txt` 是空模板，全语料 66 包在用**，比真声明 `ライセンス.txt`
   （54 包）还多。**若混为一谈，"已标注授权"会从实测 25% 虚报成 55%** —— 等于替作者
   做出他没做过的声明。故 `license` / `license-template` 分两类，界面只报形态不判条款。
3. **"以 `＜＞` 开头即模板占位"这条直觉是错的**：`作者：＜猫のごろごろ＞（…他人と被らないものを）`
   确是未填模板，但 `作者：＜さもま＞` 是**作者把真名填进了模板括号**——只按尖括号判会连带漏掉真署名。
   正确判据是**「待填说明语句」在不在**；且汉化版模板把那句说明也翻译了
   （`＜猫呼噜＞(“XX条目>>123”等也OK，请不要和别人的方式相重合)`），
   故另加三个**语言无关**指纹：`>>数字`（论坛回帖号）/ `XXスレ|XX条目` / `等でもOK|等也OK`。

#### 口径：高精度、宁缺勿滥、**给证据不给结论**

- 作者标签**必须带冒号**：`作者は本口上が処女口上です` 这类散文里的「作者」一律不猜；
  无冒号的中文散文署名（`这里是国人作者破空（5419yf）`）**明确放弃**——宁可漏，不可错。
- 每个抽到的字段带**出处（文件名 + 1 基行号）**，面板悬停即看原文；
  出处行号**不进 meta**（meta 是持久档案，行号会随作者改 README 失效）。
- 装饰该清不该拒：`作者：\t-> 全人類ノ天空録` 是真署名，`->` 与 README 表格的 `│` 尾巴是排版噪声。
- 实测抽取率 **26/214 包（12%）**——低是**设计结果不是缺陷**：语料里带标签的署名本就稀少，
  而假阳性会让人把别人的作品当无主作品改。

#### 语料基线测试常驻（防假阳性悄悄涨回来）

新增 `attribution.corpus.test.ts`（`KOJO_SMOKE_PROJECT` 守门，无该环境变量自动跳过），
把 214 包 / 148 有 readme / 26 抽到作者 / 真声明 54 vs 仅模板 66 冻成基线，并断言
**抽出的"作者"里不得出现任何模板指纹**。它在本批就逮住过一次真假阳性（上面第 3 条的汉化版模板）
—— 单测只能证明"想到的形态能处理"，这一条证明的是"真实语料的精度没有退化"。

> ⚠ **与纪要 §1 的出入（保留记录，未抹平）**：纪要称「85.5% 的包含 README 类文档」，
> 本批在**包级口径**下实测只到 **69.6%**（214 包里 16 包根本没有任何附属文件，理论上限 92.5%）。
> 纪要那个数应是更宽口径（把授权文件/杂记也算"文档"）或不同粒度所得。
> **保留实测值，不为凑那个数放宽分类器。**

#### 落地

- 纯函数层 `eratw-adapter/src/attribution.ts`：`classifyAuxFile` / `parseAttributionText` /
  `readPackageAttribution`（只读链路，走 `io.readText` 的编码探测——README 可能是 Shift-JIS）/
  `attributionSummary` / `attributionMeta`。
- 面板：包**展开时**才出一行署名摘要（默认折叠的简洁约束不变），惰性读取 + 按目录缓存，
  与 `wsDirCache` 同生命周期、变更动作一并失效；中性色 + 左边细线，比提示条更轻一档。
- 导入向导：源包署名摆在「源目录」下面，并**随制品 meta 带走**
  （`originalAuthor` / `originalUpdated` / `licenseKind` / `licenseFile`）——
  文案直说「导入后请以自己的署名命名；原作者信息随包保留，不要删」。
- **真机验证**（`pnpm tauri dev` + 种两个对照包）：未填模板的包如实显示「原作者未标注 ·
  有授权声明文件（ライセンス.txt）」，**没有把 `猫のごろごろ` 当作者报出去**；
  有真署名的包显示「原作者 淑佳 · 更新 2026-10-12 · 未见授权…」。验证后清理种子。

#### 基线

**1109 passed / 9 skipped**（本批 +29：署名单测 26 + 语料基线 1 + 归一/携带 3 项并入；
另 1 项 corpus 在无 `KOJO_SMOKE_PROJECT` 时计入 skipped）；typecheck root 干净；
审计 A–D 全绿（16 插件）。

> 跑法提醒：**不要**给全量 `pnpm test` 设 `KOJO_SMOKE_PROJECT` —— 那会放行依赖 `sav`
> 存档的注入链路测试，而本机语料**零存档**，必红两条。正确姿势是全量跑不带变量，
> 语料基线单独带变量跑那一个文件。
### 5.51 内核优化批 · L0 实测 + 超长文件丝滑 + 索引快照（2026-10-12 批）

> 背景：用户定调「内核优化 = 体感丝滑」（例 1：加载快、**二次打开项目不用再等**；
> 例 2：**超长 ERB 打开/编辑不卡**）。路线权威 `docs/PERF-REVIEW-2026-10-11.md`
> （本批按 HANDOFF §三 指示从归档取回为活文档），全部实测记录在其 §七。

#### A · L0 测量（先测量再动手）

1. **纯函数微基准**（Node v22.22.2，临时探针按惯例建→跑→删）：
   `parseErbText` 0.2ms(284行)/8.7ms(22k)/12.5ms(52k)；`scanControlFlow` 0.3/18.1/38.2ms；
   `transpile` 3.8ms(213行)/19.1ms(3k)/35ms(6k)。详表见 PERF-REVIEW §7.2。
2. **语料扫描**：口上域 **2,317 ERB / 3,618,834 行 / 144 MB**；最大单文件 52,601 行（2.35 MB）；
   分布 p50=893 / p90=3,619 / p99=12,441 行，≥5,000 行占 6.0%。
3. **三条修正性发现**（PERF-REVIEW §7.3）：① 装饰器 `isKojoFile` 短路——击键路径的全文转译
   **只作用于 `.kojo`**，2,317 个 ERB 零转译；② 最坏文件是 ERB 而非 `.kojo`；
   ③ Monaco `occurrencesHighlight`/`wordBasedSuggestions`/`matchBrackets`/`stickyScroll` 全未设。
4. **实机探针常驻化**：`app/src/perf.ts`（`PerfProbe`，暴露 `__kojoPerf.summary()/detail()/reset()`）
   + EditorPane 六计时点（`input.handler` / `markers.total` / `markers.decorate:<id>` /
   `switch.readText` / `switch.createModel` / `switch.apply`）+ bootstrap 开项目级联时间线
   + erb-parser 索引日志补耗时。实机操作单见 PERF-REVIEW §7.5（待真实终端跑）。

#### B · 超长文件丝滑（例 2）

1. **真凶 = 我们自己的折叠链**（PERF-REVIEW §7.6）：Monaco 打开文件即要整篇 folding ranges
   → 宿主 `provideFoldingRanges` → 槽 `ui.editor.liftPreview` → `sugar.lift.liftSuggest(全文)`，
   52,601 行实测 **231 ms**（21,967 行 70 ms）；💡 可用性探测与面板自动扫描共用同一条链
   （memo 只缓存 1 个文件）。用户"什么都没做"就被卡一次。
2. **契约 additive**（`plugin-api/slots.ts`）：`ui.editor.liftPreview` / `ui.editor.codeAction`
   请求新增可选 `lineCount` —— 宿主提供**中性事实**，降级策略留给贡献方；
   缺省 = 体量未知 → **不降级**（与旧版行为一致）。
3. **插件降级**（`ui-sugar-lift/src/large-file.ts`，纯函数，`LIFT_MAX_LINES = 5000`）：
   自动路径超限跳过整篇扫描 + **每文件告警一次**（高频 provider 不刷屏）；
   面板「重新扫描」保留**显式出口**；`panel-logic.ts` 新增降级态 `'too-large'`。
4. **Monaco 按体量分级**（`app/src/ui/editor-options.ts`，纯函数）：≥5,000 行关
   `occurrencesHighlight` / `bracketPairColorization` / `minimap`，`matchBrackets` 降 `near`、
   `renderLineHighlight` 降 `'line'`；两档都关 `wordBasedSuggestions` 与 `stickyScroll`。
   宿主在 `setModel` **之前** `updateOptions`（不让大文件先按默认渲染一帧）。

#### C · 索引快照 + 增量复扫（例 1 之「二次打开不等」）

1. **纯函数层**（`erb-parser/src/snapshot.ts`）：`snapshotKeyFor`（FNV-1a 项目根 → 安全存储键）、
   `aggregateIndex`（**与全量重建同源同序**——两条路径共用同一份聚合代码）、
   `diffSnapshot`（mtime 保守失效：任一侧为 null = 过期）、
   `coerceSnapshot`（**fail-closed**：版本/结构/项目根任一不符 → 整体弃用并删除，绝不"修"）、
   `mergeEntries`（已消失的文件收尸，快照不越攒越大）。
2. **插件接线**（`plugin.ts`）：`project.opened` → walkDir → **并发 stat 全部文件**（与
   `readText` 的 `mtimeMs` 同源口径）→ 快照比对 → 只重扫 stale 文件 → 按 walk 顺序聚合
   → 广播 `kojo.functionChanged`（消费方无感）→ **异步**落盘新快照。
   `service.buildIndex`（显式调用）**不走快照** = 强制重建语义。
3. **体量实测**：52,601 行 ERB 的 `ErbFile` JSON 仅 43 KB（索引只存函数边界，不存正文）
   → 全量快照估 10–20 MB，`JSON.parse` 约 100–200 ms，满足 "<500 ms" 门槛。
4. **落点**：`{appData}/store/erb-parser/index-v1-<hash>.json`（既有存储域，零新增权限面）。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **1043 passed / 8 skipped（1051）**（基线 1012 + 超长文件批 16 + 快照批 15，零回归） |
| `tsc -p tsconfig.json`（root） | exit 0 |
| `tsc -p packages/app/tsconfig.json` | exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 既有测试适配 | `erb-parser/tests/plugin.test.ts` 假 ctx 补内存存储域（新依赖 `ctx.storage`） |

#### 边界未做（下批）

- **开项目级联的大头还在**：条件抽取 ~6.2s / 约定校验 ~9s 既没持久化也没下池 ——
  本批只消掉了级联里 2.9s 的索引段。候选方案：linter 结果快照（产物小、收益 9s→0）
  与 `kernel.compute` 计算池（T1，根治主线程阻塞）。
- `walkDir` 条目未带 mtime/size（现按 stat 逐文件补，2,317 次 IPC；后续可在 io 契约
  additive 补齐以省掉）。
- `kernel.compute`（T1）/ L2 共享缓存 / L4 增量转译未动。

### 5.52 计算池批 · kernel.compute 时间片调度 + 级联过池 + 并行运输层（2026-10-12 批）

> 用户定调：**「即点即现」，让用户感受不出明显停顿**。本批 = 路线文档 §三 L1 的落地，
> 分两段：**调度**（时间片/优先级/单飞尾缘）与**运输**（多线程真并行）。

#### A · 先测量（两处，均建→跑→删）

1. **导航树建树成本**：`buildNavigatorTree` 在 99,397 函数上 **258 ms**（连续三次 258/267/259，
   稳定）；产出 141 角色 / 349 家族 / 3,017 面 / orphans 1,976。
   → 结论：**不值得为它做累积/装配两阶段切片**（收益 < 300 ms，重构风险不划算）；
   改为**去重**（见 B）。
2. **索引构建成本**：真实语料 2,317 文件，`readFileSync`（串行）+ `parseErbText` 合计 **4,290 ms**。
   → 结论：索引墙钟时间由**纯 CPU 解析**主导，**切片让路改变不了"要等多久"**——
   要真提速必须多线程。这是本批 C 段的立项依据。

#### B · 消除"开项目建两遍树"

`ui-kojo-navigator` 的 `refresh()` 被 `project.opened` 与 `kojo.functionChanged`
**双双触发**，两者最终拿到**同一个 `ErbIndex` 实例** → `buildNavigatorTree` 白跑第二遍
（258 ms × 2）。新增纯函数 `shouldRebuildIndex(prev, next)`（引用比较，可单测）在 `rebuild`
入口去重；索引真正替换（新实例）时照常重建。

#### C · 计算池（服务键 `kernel.compute`）

契约住 `plugin-api/src/compute.ts`（插件不能 import kernel，故类型必须在公共包），
实现住 `kernel/src/compute.ts`；`createKernel` 以 `'kernel'` 名义注册，并在 `Kernel` 上
暴露 `compute` 字段。

| 能力 | 语义 |
|---|---|
| `yieldToMain()` | `MessageChannel` 宏任务让路（Node/WebView 通吃；**避开 `setTimeout` 的 4 ms 嵌套钳制**）。`addEventListener` 而非 `onmessage`：node/DOM 两套 lib 对 `MessagePort` 声明不同（老坑再现） |
| `runSliced(items, opts, fn)` | 时间片预算（默认 8 ms ≈ 半帧）；`concurrency` 支持**窗口内并发**（IO/CPU 混合循环的正确形态：保住 IPC 并行度，只在**窗口之间**让路） |
| 优先级 | `interactive` > `background`：背景档在片间发现交互档在跑**主动让路**（合作式，不抢占同步片） |
| `runLatest(key, ...)` | 单飞 + **尾缘合并**（中间版本跳过，等待者共用最新结果）——高频 provider 的背压 |
| `offload(kind, payload)` | 可搬运任务：有通道 → 分发；无通道/通道失败 → **回退本地实现**（连续失败 3 次停发） |
| `stats()` | 片数 / 让路 / 耗时 / 分发 / 回退计数（供性能探针与状态面板） |

**运输层（`plugin-api/src/compute-worker.ts`）**：协议 `{id,kind,payload}` ↔ `{id,result|error}`；
`createWorkerTransport(factory, {size})` + `handleComputeRequest(tasks, data)`。
关键决策：**单槽不减少总 CPU**（只是换个线程跑），故支持**多槽轮转**，
装配层按 `hardwareConcurrency - 1`（封顶 4）取值。

#### D · 级联过池（三处）

| 位置 | 标签 | 并发 | 说明 |
|---|---|---|---|
| `erb-parser` stat | `index.stat` | 32 | 与 `readText` 的 mtime 同源 |
| `erb-parser` parse | `index.parse` | 12 | **IO 留主线程**（Tauri IPC 不搬进 worker），只把纯解析 `offload('erb.parseFile')` |
| `condition-extractor` | `condition.extract` | 8 | 原 `mapLimit(8)` 换成池（窗口间让路） |
| `condition-extractor` 的扫描段 | `erb.scanControlFlow` | — | 见下：**扫描是纯文本变换、无外部依赖**，故由服务所有者搬上空 |

**`scanControlFlow` 也搬上并行通道**（分层：CPU 函数的所有者负责搬运）：
`ErbParserService` 新增 additive 方法 `scanControlFlowOffloaded(text): Promise<...>`
（语义与同步版一致；无通道自动内联），erb-parser 内部用 `offload('erb.scanControlFlow')` 实现，
抽取器把它当 `deps.scanControlFlow` 传进引擎（引擎侧该依赖改为异步 + `await`）。
收益依据：真实语料 `scanControlFlow` 约 1.1 ms/千行 → 全量约 **2.5 s**，
占抽取总时长（6.2 s）约 **40%**。
（**未做**：`extractFunctionConditions` 仍留主线程——它的入参含 adapter 的 `SchemaLookup`
**闭包**，跨不过结构化克隆；正解是 `VariableSchema` 导出原始表、worker 侧重建成闭包
〔路线文档 §三 L1 已有设计〕，属独立一批。）

**可搬运任务表单一真源**：`erb-parser/src/offload.ts` 导出 `erbParserTasks`，
宿主侧 `registerTask`（回退路径）与 worker 入口（`app/src/compute-tasks.ts` → `computeTasks`）
**引用同一份**——kind 不会两侧漂移。

#### E · 并行运输层的验证（不启动应用）

1. `kernel/tests/compute-transport.test.ts`（15 项）：用 `node:worker_threads`（eval 模式）
   造**真线程**，验证协议往返 / id 不错配 / 任务抛错传播 / 未知 kind / **多槽轮转 size=2 → [0,1,0,1]** /
   池侧分发与**连续失败回退**（`fellBack` + 停发）。
2. `pnpm --filter @kojo/app build` **通过**（41.87 s）→ `?worker` 打包链成立，
   产物 `dist/assets/compute-worker-*.js` 独立成块（3.2 KB）。
3. **构建产物端到端**：用 `vm` 加载该产物 + 假 `self`，发真实请求
   → 夹具 ERB 得 3 函数 / 22 行；52,601 行真实 ERB 得 124 函数 / 52,602 行；
   `erb.scanControlFlow` 在同一文件上得 **4,662** 条控制流语句。**协议与任务表都活。**

#### 验收结果

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **1081 passed / 8 skipped（1089）**（基线 1043 + compute 19 + transport 15 + 建树去重 3 + 可搬运任务 1） |
| `tsc`（root + `packages/app` 双跑） | exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| `pnpm --filter @kojo/app build` | ✅（含 worker 打包） |
| 构建产物协议验证 | ✅（真实 ERB 端到端） |

#### 边界未做（下批候选）

- **条件抽取 / 约定校验仍无持久化**：抽取 49.3 万谓词不适合 JSON 快照；
  校验规则是整项目粒度、无法按文件缓存。二者的下一步是**把 CPU 整段搬上并行通道**
  （抽取的 `scanControlFlow` + 表达式解析、校验的规则扫描），本批只搬了 `parseErbText`。
- **Monaco 大文件 createModel 成本未测**（52k 行切文件时 `switch.createModel`/`switch.apply`
  由实机探针给出）。
- `markers` 走 interactive 档未接（当前价值有限：preemption 不可能，收益只是"最多等窗口"，
  已由 8 ms 窗口自动满足）。
- L2 转译共享缓存 / L4 增量转译未动。

### 5.53 本批自审与验收记录（2026-10-12，审阅后推送前）

> 范围：§5.51 / §5.52 两批（7 个提交）+ 审修补丁。审阅标准：①「一切皆插件」解耦哲学；
> ②真 bug。结论：**哲学合规；发现 1 个真 bug（已修）+ 1 处死代码（已清）**。

#### 一、解耦哲学核对（逐项）

| 检查点 | 结论 |
|---|---|
| 计算池**契约**住 `plugin-api/compute.ts`、**实现**住 `kernel/src/compute.ts` | ✅ 与 `FileIO` / `StorageService` / `SlotRegistry` 同款"类型在公共包、实现在内核"（插件不可 import kernel 的硬约束） |
| 内核零插件/零游戏知识：`kernel/src/compute.ts` 只接受"项数组 + 纯函数 + kind 字符串" | ✅ 审计 A 项脚本验证通过 |
| 运输层 `compute-worker.ts` 零平台依赖（`WorkerLike` 是结构化类型） | ✅ 因此才能用 `node:worker_threads` 做真线程测试 |
| **"CPU 函数的所有者负责搬运"**：erb-parser 导出任务表 + activate 注册本地实现；消费方（condition-extractor）只调 `scanControlFlowOffloaded`，不认识 kind/worker/回退 | ✅ 分层正确 |
| app 是组合根：`compute-tasks.ts` 合并插件任务表、worker 入口、bootstrap 接线 | ✅ 与 bootstrap 装配 16 插件的既有模式一致 |
| 槽位请求新增 `lineCount`：宿主只传**中性事实**，"多少行算大"的降级策略留在贡献方 | ✅ 宿主无业务知识 |
| 审计 A–D 四项 | ✅ 全绿（16 插件） |

#### 二、发现的 bug 与处置

1. **`createWorkerTransport.dispose()` 清空在途表但不 reject** → 在途 `invoke` 的 Promise
   **永久挂起**（调用方 `await` 永不返回）。修复：dispose 时显式 reject 全部 pending
   （池侧记 `fellBack` 并回退本地实现，语义安全）。**回归测试 2 条**：transport 级
   （慢任务在途时 dispose → reject）+ 池级（`attachTransport` 换通道时在途任务回退本地）。
2. `kernel/src/compute.ts` 的 `drain` 带有未使用参数 + `void opts` 死代码 → 已清理。

#### 三、重点核查过但确认无问题的点（留档防回归）

- `runLatest` 的 drain 窗口竞态：`finally` 的删除判定与入队之间**无 await**（同步区间），
  不可能交错；槽位删除条件（`next===null && waiters 空`）与循环退出条件自洽。
- `runSliced` 窗口内单项超预算不切分：by design（契约已注明），单文件最坏一个窗口的时长。
- 快照保存的代际守卫：`gen !== generation` 时不落盘，项目快速切换不会写脏快照。
- 抽取器 `stats` 累加在并发回调中：所有 `++` 位于每个回调的**同步段**（两次 await 之后），
  JS 单线程下无竞态。
- 多槽轮转的死槽跳过 + `cursor` 推进：逻辑正确（测试 `[0,1,0,1]` 钉死）。
- `dispose` 后槽位**复活语义**（下次 invoke 懒重建 worker）：测试钉死，权衡后保留。
- `perf.ts` 的 `console.log`：是 `__kojoPerf.detail()` 的**刻意用户输出**，非调试残留。

#### 四、终验（推送前）

| 检查 | 结果 |
|---|---|
| `npx vitest run` | **1083 passed / 8 skipped（1091）**（+2 条审修回归） |
| `tsc`（root + `packages/app` 双跑） | exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| `pnpm --filter @kojo/app build` | ✅（`dfd3a65` 批已验；审修只动 transport dispose，不涉及打包路径） |

### 5.54 UI 重设计 P4 补记（`d871878`）与两组文档的合流

> **性质**：入库后回填（P4 落地时没有日志条目）。
>
> **合流声明（重要）**：本节原本还包含一整块「口上项目批 P-A…P-F 补记」，与 §5.49 / §5.50
> 是同一批事实的两份记录。合流时**整块删除**，权威记录只留工作区组自己写的
> **§5.49（P-A…P-E + P-F，含提交清单、三条硬约束、cargo 12 项、ADR-0005 冲突面预告）**
> 与 **§5.50（T2 署名/授权）**——它们含本组没有的实测细节。本组对这条线的贡献仅剩
> §5.55 的 git 收口核验。**同一事实不写两份**，这是本仓库双真相源纪律在文档侧的延伸。

#### UI 重设计 P4（`d871878`，2026-10-11 入库，本组此前无记录）

三容器面板**拖拽停靠**（自定义 MIME，活动栏 / section 头 / tab 均可作拖拽源，落点高亮）+
全禅**限宽设置项**（`zenLimitWidth`，默认 true）+ **设置 overlay**（活动栏底部齿轮 + 命令「打开设置」，
Esc 优先级链 picker > overlay > settings > zen）。改动 3 文件 +200/−10
（`ShellLayout.tsx` / `layout.ts` / `styles.css`），**无新增测试**——发版判据 ⑥ 的「真实终端勾验」
仍是欠账；`docs/UI-REDESIGN-2026-10-11.md` 与 HANDOFF 曾长期标注「P4 待开工」，一并更正。


### 5.55 分支收口批 · `feat/kernel-optimization` 两轮 rebase 进 master 的冲突处置与核验（2026-10-12）

> 背景：§5.51–§5.53 的 8 个提交建立在 `b1f260e` 上，并已 push 到 `origin/feat/kernel-optimization`；
> 期间 `origin/master` 推进了**两轮**（先是口上项目批 P-A…P-F = `712a9f5`，再是 T2 / T2.1 + 文档收口 = `11e5ac3`）。
> 收口方式 = **分支 rebase 到 origin/master，再回 master 做 fast-forward**——本仓库历史里 **0 个 merge 提交**，
> 不用反向合并。**同一条链因此经历了两轮 rebase，SHA 每轮都在变**：引用本节时**优先用批次名**，SHA 只作时点快照。

#### 一、过程（reflog 还原）

| 事件 | 结果 |
|---|---|
| 分支 8 提交（`3d17e2b`…`74603c5`）push 到 origin | 远端分支 = rebase 前旧链 |
| 第一轮 `rebase origin/master`（→ `712a9f5`） | `rebase (continue)` ×2 = 两次**手工解冲突**（`perf(ui)`、`perf(sched)`） |
| 漏网 | `perf(sched)` 的 `kernel/src/index.ts` 被 git 判「自动合并」，3 行冲突标记内嵌在正文里，`git add -A` 连它一起提交 → 靠 typecheck **TS1185** 才逮到，补一个 `fix(merge)` 善后 |
| master FF ×2（到 `712a9f5`，再 FF 分支） | master tip = `fix(merge)` |
| **推送前历史折叠** | 在 `perf(sched)` 上就地删标记 `--amend` → `git rebase --onto` 重放其后 3 提交 → `fix(merge)` 独立提交消失；**`git diff` 折叠前后 tip 为空 = 内容零变化** |
| 首次推送被拒 | `! [rejected] master -> master (fetch first)` —— 远端这时有 3 个新提交（`2dc414f` 文档收口 + `1114c35` T2 + `11e5ac3` T2.1） |
| 第二轮 `git rebase --onto origin/master 712a9f5 master` | 9 个提交重放；**代码零冲突面**（两侧非 docs 文件求交为空），冲突全落在 `IMPLEMENTATION-LOG.md` / `HANDOFF.md` |

#### 二、当前链（第二轮后；`origin/master..master` = 9 提交）

| 提交 | 批次 | 备注 |
|---|---|---|
| `0b80cbb` | docs(perf) 路线取回 | 折叠点之前，两轮均纯重放 |
| `a09da12` | 内核优化 L0 埋点批 | 同上 |
| `6b55e43` | 超长文件丝滑批 | **手工解冲突点 1**（EditorPane 只读分野 × 大文件降级） |
| `3648d92` | 索引快照批 | 本轮文档冲突取远端版 |
| `151367a` | 计算池批 | **手工解冲突点 2 + 冲突标记折叠点** |
| `d7f0359` | 并行运输层批 | |
| `bbeb730` | 扫描段上通道批 | |
| `c5bebb8` | 审修补丁 | 代码链 tip |
| 本批（文档批） | 文档欠账补齐 + 编号消冲 | §5.54 / §5.55 所属 |

折叠前的旧 SHA 演进：`0a97f91` → `686687d` → `151367a`；`5fb6d19` → `b06a4da` → `d7f0359`；
`cb0938a` → `eb12c81` → `bbeb730`；`49aac9a` → `41de425` → `c5bebb8`；`fix(merge)`（`e560fe2`）已消失。
退路（用户拍板后收口）：本地 `backup/pre-surgery-20261012`（折叠前链 + 首个文档批）、
本地 `backup/pre-rebase2-20261012`（第二轮 rebase 前）、本地 `backup/remote-feat-kernel-74603c5`
（= 原 `origin/feat/kernel-optimization` tip）。**远端那条分支已于本批删除**——它的 8 个提交已
全部进 master，留着只会诱使后来者基于 rebase 前的旧链开工（本轮乱局的起因正是两条线并行）。

#### 三、第二轮的文档消冲（本轮真正的工作量）

| 冲突面 | 处置 |
|---|---|
| 代码文件 | **零交集**（两侧非 docs 改动求交为空）→ 全部自动应用，无一次代码冲突 |
| `IMPLEMENTATION-LOG` 编号撞车 | 远端已用 **§5.49 / §5.50** 记口上项目批与 T2；本链的 §5.49/§5.50/§5.51（内核优化三批）**顺延为 §5.51 / §5.52 / §5.53**，内部交叉引用同步改写。**远端编号不动**——已公开的历史不重写 |
| 双写补记 | 本批原有一份「口上项目批 P-A…P-F 补记」与远端 §5.49/§5.50 同题 → **整块删除**，只留 §5.54 的 UI P4 与合流声明 |
| `HANDOFF` §一 / §六 / §十 | 三处**均取远端版**（对方已把 §十 重写为「两条主线 + cargo 提醒 + §十二 索引」，§六 新增口上项目线小节），本批只把仍属本组的差异重新贴上：基线数字、阅读范围、rebase 纪律、分支现状 |
| 远端把仓库路径写成 `C:\DSH\kojo-editor`（§二 / §十 两处，本机 base 是 `D:`） | **已确认：那是口上项目组 agent 所在主机的目录，不是笔误**。两机并存 ⇒ 文档里的绝对路径**按主机而属正常**；本批在 HANDOFF §十-1 加括注说明，避免照抄错盘符 |

#### 四、收口核验（两轮各自实测）

| 检查 | 方法 | 结果 |
|---|---|---|
| 逐提交冲突标记 | 对 `origin/master..master` 的 9 个提交逐个扫行首标记（代码扩展名） | **0 个提交带标记**——折叠在第二轮重放后依然成立 |
| 第一轮改写程度 | 逐对 `git patch-id --stable` | **6 对逐字节相同**，只有两次手工解冲突不同 → 无第三个暗改点 |
| 双方内容丢行 | 6 个双改文件（`EditorPane.tsx`、`kernel/{index,kernel}.ts`、`plugin-api/{index,services}.ts`、`ui-sugar-lift/tests/integration.test.ts`）各自新增行归一化后与 tip 求差集 | 全部存活；唯一「消失」的是被**有意合并**的 5 行（见五） |
| 是否回退过 origin/master | `git diff --name-status` 第一轮 base→tip | 17 A / 23 M / 2 R，**0 个 D**；`kernel/src/workspace.ts` 未被内核优化批改动 |
| 折叠等价性 | `git diff` 折叠前后 tip | **输出为空** |
| 合流后三绿 + 打包 | `pnpm test` / 双 typecheck / 审计 / `pnpm --filter @kojo/app build` | **1183 passed / 9 skipped（1192）**，74 文件过 / 4 跳；root 与 `@kojo/app` 双跑 exit 0；审计 A–D 全绿（16 插件）；构建 ✓ |

**数字闭合**：`b1f260e` 基线 1012 + 内核优化批 71 + 口上项目批 68 + T2 29 + T2.1 3 = **1183**。
**读历史时的两个坑**：① 8 个提交信息里写的「§5.49 / §5.50 / §5.51」是**改号前**的编号（现 = §5.51 /
§5.52 / §5.53），已推送的提交信息**不回改**，映射以本节为准——所以引用一律**用批次名不用编号**；
② SHA 每轮 rebase 都在变，本节「二」的表只是时点快照。
**结论：不需要回滚**——两轮收口都没有丢任何一侧的功能，代码层面零冲突面，文档层面已消冲去重。

#### 五、两处解冲突的裁定（都是取并集，不是二选一）

1. **`EditorPane.tsx` 换文件时的 `updateOptions`**：origin 侧把「ERB 默认只读」改成**按工作区分野**
   （`isErbLike && !inWorkspace`），分支侧在同一位置插入**按行数分级降级**。合并结果两义并存——
   `readOnly: isErbLike(filePath) && !inWorkspace(filePath)` 与 `...editorOptionsForLineCount(...)`
   同一次 `updateOptions` 给出，且仍在 `setModel` **之前**落选项（大文件不先按默认渲染一帧）。
2. **`kernel/src/index.ts` + `kernel.ts` + `plugin-api/{index,services}.ts`**：`workspaces`
   （`WorkspaceServiceImpl` / `WellKnownServices.Workspaces`）与 `compute`
   （`createComputePool` / `kernel.compute`）两套导出、服务键、`Kernel` 字段**双份保留**。

#### 六、纪律（同步写入 HANDOFF §八 与 §十）

1. **rebase / 解冲突之后，必须在同一批内跑 root + app 双 typecheck + 全仓冲突标记扫描**：
   TS1185 是这次唯一逮住问题的关口，而 `git add -A` 恰恰会在 typecheck 之前把标记提交进历史。
   解冲突批**逐文件 add**，add 后 `git diff --cached` 亲眼过一遍。
2. **tip 干净 ≠ 历史干净**：推送前对 `origin/master..master` 逐提交扫标记，才是可 bisect 性的保证。
3. **未推送的历史可以修，已推送的不改**：本轮编号消冲以远端为准，就是这条的延伸。
4. **动手前先 `git fetch`**：本轮第一次 push 被 `(fetch first)` 拒，才发现远端已推进三个提交——
   在旧认知上做长手术，代价就是两轮消冲。
5. **同一事实不写两份文档**：两组各自补记同一批 = 第二真相源；合流时删较粗的一份并留指针。

### 5.56 口上项目批 T3 · 作者包真实文件夹视图 + 抖动 bug 根除（2026-10-12 批，用户反馈 6/7/5）

> **触发**：用户反馈清单第一批。反馈 7 报的是**线上 bug**——来回点击作者包，整个口上
> 文件树抖动，且当初要求的动效「并没有生效」。反馈 6 要求作者包展开成真实文件夹
> （所有文件类型 + 可下钻子目录），但**不改当前布局**。反馈 5 顺手。

#### 抖动的根因不是动画参数，而是「替换式展开」这个结构

旧模型是「平铺态 ↔ 文件夹态」二选一：
- `styles.css` 用 `.pkg-flat-wrap.closed{grid-template-rows:0fr;opacity:0}` 把 ERB 列表压成 0 高；
- 另挂一棵 `.pkg-folder` 子树替代，且带 `pkg-folder-in` 的 `translateY(-3px)` 入场动画；
- **两棵 `<ul>` 里 `key={f}` 是同一批值** → React 判定为不同子树，整体卸载重挂。

三者叠加 + `ensureDir` 异步 resolve 引起的第三次 reflow = 用户看到的抖动。
调动画时长或加 `will-change` 都治不了，因为根因是**结构**。

**改法 = 把「替换」换成「追加」**：ERB 列表始终原地不动、同一批 DOM 节点、同一套 key、
零动画；真实目录内容插在它上面。这样既满足反馈 6（看到真实文件夹），又让反馈 7 的
「平级 ERB 消失」从设计上不存在——没有东西需要消失，也就没有东西会抖。

#### 本批自己引入并被真机逮住的一个 bug（重要，别略过）

第一版把「包层已平铺的 ERB」去重应用到了**整棵递归**，结果
`灵梦-少女之梦/没写的`（实有 10 个 ERB）在 UI 里渲染成**空目录**。
这不是不好看，是**对文件系统撒谎**：用户会以为这个包没写完。
真机点进去才发现——单测抓不到，因为我一开始没给它写单测。

修法精确到位：**去重只在包根那一层（depth 0）生效**，那里确实与平铺列表同级重复；
嵌套目录必须原样显示。并把这个判定抽成纯函数 `visibleEntries(entries, depth, skip)`
+ 5 项单测，其中一项直接拿这次的真实事故当用例（「极端情形：嵌套目录里每个文件都在
skip 里，仍然必须全部显示」）。

> **教训重申（§九-1/-15 第四次应验）**：结构改动必须真机点一遍。这次是「先看代码觉得
> 对 → 真机一点就谎报空目录」。同时**像素验不到的不变量，就抽成纯函数用测试锁死**，
> 比再截十张图可靠。

#### 附带（反馈 5）

「🔒 只读预览 · 升糖不写原文件」→「🔒 只读预览」：细节移入悬停 title，
「升糖」这类行话不该出现在常驻标签上。样式从自造度量（11px / radius-1 / 1px 6px）
对齐全站徽章族（10px / radius 3px / 0 3px），色走 `--amber` 变量。
**记一笔债**：全站现有 4 套徽章样式（`nav-badge`/`rp-badge`/`ab-badge`/`sv-verdict-badge`）
本就重复，合并为单一 `.badge` 基类属 UI P4 范围，本条不顺手改（会波及 4 个插件）。

#### 真机验证

`pnpm tauri dev` + 真实语料 #1 博丽 灵梦 → 灵梦-少女之梦（20 文件）：
展开后子目录 `没写的` / `一些胡思乱想的东西`（带 ▸ 可下钻）与
`灵梦-《少女之梦》eradme.txt` 追加在上方，**ERB 列表原地不动、无消失、无动画** ✓
右键菜单文案随语义改为「显示所有文件和文件夹」（不再有「隐藏」可言）。
T2.1 的包事实行也一并看到：「目标 你 · 剧本1 · 原作者未标注 · 有授权声…」✓

⚠→✅ **一处曾待验、已由用户补图结掉**：`没写的` 修复后的嵌套 ERB 显示，我自己在
这个会话里没拿到截图（窗口反复被外部最小化，批量点击 0 步即失败），当时只能靠
`visibleEntries` 单测锁死该不变量，并如实记为「未竟」。**用户随后提供的实机图确认修复生效**：
`没写的` 下如实列出 10 个 `M_KOJO_K1_2_*.ERB`、`一些胡思乱想的东西` 下 2 个 `.txt`、
包根 `灵梦-《少女之梦》eradme.txt` 在位，其下平铺 ERB 列表纹丝不动、无消失无抖动。
→ 谎报空目录的 bug 确认根除。留这段是为了说明**「未竟」要写下来、而不是含糊掉**：
写下来，别人才能替你验完。

#### 基线与改动面

**1188 passed / 9 skipped**（本批 +5 `visibleEntries`；§5.51–§5.55 内核优化批 +71 已在
链上，与 §5.55「1012 + 71 + 68 + 29 + 3」的闭合推算一致）· typecheck root+app ·
审计 A–D · 16 插件 · `pnpm --filter @kojo/app build` ✅（`compute-worker-*.js` 独立成块
仍在，本批未破坏并行运输层）。

> **入库时与内核优化批消冲**：本节原编号 §5.51，与「§5.51 内核优化批」撞车，
> 按 §5.55 三「编号消冲以远端为准」的既定口径**顺延为 §5.56**。
> `EditorPane.tsx` 本批徽章改动与其 §5.55 裁定五的并集（`readOnly` 目录分野 +
> `editorOptionsForLineCount` 大文件分级）自动合并，两侧内容均未丢失（已逐行核）。

改动面：`FileTree.tsx`（结构重做 + 导出纯函数）+ `styles.css`（删 3 处动画与孤儿 `.tree-extra-icon`，
加 `.tree-dir` / `.tree-note` / `.pkg-real` / `.tree-extra-file`）+ `EditorPane.tsx`（文案与徽章）
+ 新增 `packages/app/tests/file-tree.test.ts`。

### 5.57 口上项目批 T4 · 函数树悬停显示作者注释（2026-10-12 批，用户反馈 9）

> **痛点原文**：「函数树的函数名几乎都是大写，辨识度太弱，又有长长的前缀，初看难以
> 理解该函数的作用。」并给出注释形态实例（`;===` 画框 / `;660,読書` / `;TFLAG:193(…)`）。

#### 先测量：这件事到底值多少（§九-1/-15 第五次应验）

改动前先在真实语料口上域（2,285 ERB）统计紧邻 `@` 声明上方的 `;` 块：

| 指标 | 实测 |
|---|---|
| 函数总数 | 100,532 |
| **带紧邻注释块** | **51,757（51.5%）** |
| 注释总字符 | 3,913,539 ≈ 3.73 MB |
| 平均每函数 | 76 字符 |
| 最长单块 | 2,120 字符（英文长文档离群值） |

结论：**一半函数能直接读出人类可读的名字与说明**，值得为它付索引体积。
同时这组数决定了两个设计参数——`DOC_MAX_CHARS = 600`（截断离群长文，
平均 76 字符意味着截断几乎不影响真实内容），以及必须 bump 快照版本。

#### 与内核优化批的交互（这条是本批最需要判断的地方）

性能组 §5.51 刚把索引**快照持久化**，并明确记录「52,601 行 ERB 的 `ErbFile` JSON 仅
43 KB（**索引只存函数边界，不存正文**）」。给每个函数加注释，等于**在索引里存正文**——
全量快照因此增大约 3.7 MB（JSON 转义后约 4 MB），相对其 10–20 MB 估算约 **+20~40%**。

处置：
- **`SNAPSHOT_VERSION` 1 → 2**。旧快照没有这个字段，若继续复用会让函数树悬停
  **静默空白且无从察觉**；按 `coerceSnapshot` 的 fail-closed 语义整体弃用、一次重建。
  代价是升级后首次开项目多等一段索引时间，此后照常走快照。
- 截断是**显式降级不是丢数据**：原文仍在文件里，悬停看到前缀即可定位。
- 未做「按需读取注释」（点开函数才读文件取注释）——那会让悬停提示变成异步闪烁，
  而悬停恰恰要求即时。体积换即时性，这里判断是值得的。

#### 归属规则（不猜作者意图，取一条确定规则）

注释块只属于**紧邻其下的那个声明**：
- 遇到任何语句行 / `#DIM` / `$标签` → 立即清空缓冲（`#DIM` 上方的注释是说明变量的，
  挂到后面的函数上就是张冠李戴）；
- 允许注释与 `@` 行之间留 1 个空行（作者惯例），但连续 >2 空行视为断开
  （防文件头的注释块跨越半张纸粘到后面的函数上）；
- `[SKIPSTART]` 块内不参与收集；
- 纯装饰线（`;====` / `;----`）丢弃——对读代码的人零信息量；
- 无注释 → **字段缺省**而非空串（不在索引里堆 4.8 万个无意义空字段）。

函数体尾部的注释归下一个函数：作者意图本就模糊，这里取「紧邻」这条**可预测**规则，
不做二次猜测（已用测试钉住该行为，见「归属规则是紧邻」）。

#### 呈现

`functionTooltip(fn, shortPath)`（纯函数）：**注释放最前，路径与行号垫在末尾**。
理由——全大写长前缀的函数名，作者写的说明才是人要读的东西；但定位信息不能丢，
注释不该取代「这函数在哪个文件哪几行」。无注释时退回原形态，不硬凑空行。
函数树行与搜索结果行两处消费点统一走这一个函数。

#### 链路（additive 契约，一处构造点）

`plugin-api/erb.ts`（`ErbFunction.docComment` + `ErbFunctionRef.docComment`，均 optional）
→ `erb-parser/scanner.ts`（`cleanDocBlock` 纯函数 + 缓冲逻辑）
→ `erb-parser/snapshot.ts`（`aggregateIndex` 透传 + 版本 bump）
→ `ui-kojo-navigator/tree.ts`（`FunctionNode` 携带 + `makeNode` + `functionTooltip`）
→ `ui-kojo-navigator/index.ts`（两处 `title`）。
性能组的 `aggregateIndex` 单一构造点在这里帮了忙——ref 只需改一处。

#### 验收

**1200 passed / 9 skipped**（+12：`cleanDocBlock` 4 + `docComment` 归属 5 + tooltip 3）
· typecheck root+app · 审计 A–D · 16 插件。

#### 边界未做

- 快照体积 +4 MB 的实际加载耗时无本机实测（需真实终端跑一次开项目并读 `__kojoPerf`）；
  若实测超出 §5.51 的「<500 ms」门槛，退路是把 `docComment` 从快照里剔除、
  改为点开函数时按需读文件（代价：悬停首次有延迟）。
- 注释里的 `TFLAG:193(…)` 这类位协议说明**原样呈现**，未做语义化（不接 variableSchema，
  避免把导航面板做成回放面板）。
- 函数树**行内**仍只显示原名；注释只在悬停里。要不要在行内给一个短名摘要，
  属"界面清爽 vs 辨识度"的取舍，留给用户看实物后定。

### 5.58 体感丝滑批 · 开项目级联三段全持久化（2026-10-12 批）

> **触发**：用户报「已经导入过一次的游戏目录，开项目还是要等近 10 秒，为什么不能把结果存到本地磁盘」。
> 排查后发现：索引段确实有快照（§5.51），但级联另外两段**从来没落过盘**；而用户那次体感
> 来自 10-11 的旧构建（appData 里最新文件时间 = 10-11 18:43），新代码当时一次都没跑过。
>
> 分支 `feat/smoothness-2026-10-12`，四个提交：分段计时 → 抽取快照 → 判据修正 → 校验快照。

#### 一、先测量（又一次推翻文档口径，§九-1/-15 铁律第 N 次应验）

真实语料 = 本机 eraTW 整合包（2,285 ERB / 99,101 函数 / 168 角色 / 33 张变量名称表）。
**复现"二次开项目"必须用两个独立 kernel 共用同一 appData**——第一次我用同进程 close/open，
让 39 MB 的异步落盘和下一次读盘抢跑，量出「热启动 7646ms 比冷启动还慢」的**假结论**（已作废，
见下条）。

| 段 | 全量耗时 | 产出体量 | 改造前有无持久化 |
|---|---|---|---|
| ERB 索引 | 1.9 s（walk 131 / stat 75 / read+parse 1590） | 快照 37.5 MB | **有**（§5.51，命中后 read+parse → 0） |
| 条件抽取 | **11.3 s**（95,333 函数 / 493,712 谓词 / 164,910 依赖） | 摘要快照 **45.9 MB** | **无** |
| 约定校验 | **3.1–5.5 s**（793 条问题） | 报告快照 **0.42 MB** | **无** |

两条被推翻的既有判断：

1. §5.52 边界记录写「抽取 49.3 万谓词**不适合 JSON 快照**」——实测摘要级快照 45.9 MB、
   还原约 500 ms，换掉 6.9–11.3 s 的计算。**不是不适合，是没人量过。**
   （注意可缓存的是**摘要级** `ConditionIndex`；49 万谓词明细仍是按需算 + 进程内缓存，不入快照。）
2. 同处写「校验规则是整项目粒度、**无法按文件缓存**」——前提对（家族完整性跨文件），
   结论错：产出只有 307 KB，用**整项目判据**缓存即可，根本不用按文件切。

顺带纠正一次「stat 段热启动 75ms→872ms 的反常」：不是调度问题，是**计时标签错位**——
stat 的计时窗口把「快照读盘 + JSON.parse + coerce」整段包进去了。拆段后真值 42–46 ms。

#### 二、实现：三段各自的快照与判据

| 段 | 判据（缺一即不缓存） | 存储键 | 命中效果 |
|---|---|---|---|
| 索引 | 逐文件 mtime + textLength（增量复扫，非整块） | `index-v2-<rootHash>` | read+parse 1590ms → 0 |
| 抽取 | ERB 指纹 + `project.inputDigest` + `EXTRACT_SNAPSHOT_FORMAT` | 固定 `extract-snapshot-v1` | 6.9–11.3s → 还原 |
| 校验 | 上面两路 + `LINT_SNAPSHOT_FORMAT` + **规则清单摘要**（id+severity+description） | 固定 `lint-report-v1` | 3.1–5.5s → 还原 |

- **基建 `plugin-api/fingerprint.ts`（新）**：`projectFingerprintOf`（路径+mtime+size，排序后
  折叠 ⇒ 与遍历顺序无关；任一项取不到 stat ⇒ null = 不缓存）、`combineDigests`（多路合并，
  任一路缺失 ⇒ null）、`foldDigest`（顺序无关折叠；空集合给确定值，区别于「没有判据」）、
  `stableHash`（cyrb53，14 位十六进制）。
- **判据复用索引已有的 stat** ⇒ 增量复扫不额外读一次盘（2,285 次 stat 只要 42–75 ms）。
- **契约 additive**：`ErbIndex.fingerprint` + `GameProject.inputDigest` + `VariableSchema.inputDigest`。
- **分层**：判据组装在**插件端口**（`snapshot.expectFor`），引擎只懂「有判据且命中就跳过计算」——
  引擎保持游戏无关，不知道指纹从哪来。快照逻辑不挂在插件的自动触发路径上，
  否则消费方显式 `ensureIndex()` / `run()` 会绕过缓存留下暗道。
- **手动「重新校验」= `run({ force: true })`**：用户的显式意图不该被缓存糊住（但仍刷新快照）。
- **带 `failedRules` 的历史报告拒绝命中**：某条规则抛过错，就该让用户看到重算结果，
  而不是缓存里那份"看起来干净"的旧象（对齐「内核不静默」铁律）。

#### 三、自查抓到并修掉的两个缺陷

1. **并发重复全量**（本批修）：抽取的自动路径调 `engine.run()`、显式路径调 `ensureIndex()`，
   两者不共享在途 Promise ⇒ 冷启动实测**白跑两遍**（8457ms + 8789ms）。自动路径改走
   `ensureIndex()`；校验同理补了 `inFlight` 去重。修完冷启动抽取 11.3s → 6.2s（不用缓存就降了）。
2. **判据漏掉非 ERB 输入**（我上一提交引入、下一个提交堵掉）：`VariableSchema` 是
   **由游戏 CSV 驱动**的（`variable-schema.ts` 头注写明"不硬编码索引表"），抽取结果里存着
   它给的 `StateDependency.schema` 标签；校验规则还直接遍历 `charaIndex`。只用 ERB 指纹时，
   **改一行 `CFLAG.csv` 描述会让快照继续吐旧标签**。修法：adapter 在 `loadProject` 现场
   把它吃进的非 ERB 输入（CHARA 正文 / 角色目录名 / 变量名称表正文）折成 `inputDigest`
   交出去，下游判据必须含它，**缺则一律不缓存**。零额外 IO（读的时候顺手算）。

#### 四、水位实测（两个独立 kernel 共用同一 appData = 真·二次开项目）

| 水位 | 冷（首次） | 热（快照命中） |
|---|---|---|
| 函数树可交互 | 2068 ms | **623 ms** |
| 条件徽章可用 | 9890 ms | **1175 ms** |
| 校验面板有结果 | 9900 ms | **1178 ms** |

**用户那十秒的主体（抽取 + 校验）从 9.9 s 降到 1.18 s。** 落盘 37.5 + 45.9 + 0.42 ≈ 84 MB/项目。

#### 五、纪律（已同步进 HANDOFF）

1. 改**规则或抽取口径**必须 bump 对应的 `*_SNAPSHOT_FORMAT`：规则是闭包，哈希不出行为，
   只有版本号能救；判据里的规则清单摘要只能检出增删改级别/描述。
2. 派生缓存判据必须覆盖**所有实际输入**：ERB 正文之外，凡 adapter 读过的东西（CSV、目录名）
   都要有声明通道（`inputDigest`）。**判据不全 ⇒ 不缓存**，不许"大概一样"。
3. 快照一律 **fail-closed**：版本/项目根/适配器/指纹/结构任一不符 ⇒ 删除并全量重算，绝不"修"。
4. 测量二次启动必须**换新 kernel 共用同一 appData**；同进程 close/open 会让异步落盘污染计时
   （本批就栽过一次，量出"缓存反而更慢"的假结论）。
5. `npx vitest` 在本机 Git-Bash 下会**吞掉环境变量**（`KOJO_SMOKE_PROJECT` 传不进去，整组测试
   静默 skip）；带环境变量跑必须用 `node node_modules/vitest/vitest.mjs run …`。

#### 六、边界未做（下批候选，按收益排序）

- **索引快照无淘汰机制**（本批新发现的真实问题）：键按项目根哈希 ⇒ 开过 N 个项目就攒
  N 份 37–45 MB，永不回收。抽取/校验用固定键（覆盖式）不受影响。要做 LRU 上限 + 清理。
- **快照瘦身**：索引快照里 `filePath`（14.5 MB）与 `normalizedName`（4.7 MB）都是可派生字段
  ——条目键已是路径、归一化名 = `name.toUpperCase()`。剥掉可省约 51%，热启动 get 253ms →
  预计 <120ms；抽取快照 45.9 MB 同理可列式化。
- **抽取仍是主线程在算**：本批只是让它不必每次算。`extractFunctionConditions` 还没搬上
  并行通道（卡在 adapter 的 `SchemaLookup` 闭包跨不过结构化克隆；正解 = `VariableSchema`
  导出原始表，路线文档 §三 L1 的设计仍未开工）。
- `inputDigest` 目前只有 eraTW 提供；换别的适配器 ⇒ 这两段自动不缓存（保守，不是错）。
- 体感指标 `ui.navigator.interactive` 还没进 `__kojoPerf`（本批的水位是靠临时探针量的，
  跑完即删；应固化成常驻计时点，免得下次又要临时搭）。
- 索引快照的 `doc` 字段是口上项目组后加的（`SNAPSHOT_VERSION` 已被他们提到 2），
  它让快照继续变大——瘦身要连它一起算（上限 600 字符/函数）。

---

### 5.59 语法糖视图批 · 升糖投影落地（2026-10-12 批：B 层「整份 ERB 显示为糖」端到端）

> 依据：`docs/LIFT-REMEASURE-2026-10-12.md` §7.1（逐行局部映射 + 单行降级）。
> 需求口径（用户 2026-10-12）：**打开别人写的 ERB 口上，不熟悉 EraBasic 也能像看剧本一样读懂它**。

#### 为什么

升糖此前只有"逐条候选"一条路（`liftSuggest`，判据是 round-trip 逐字节自证），真实语料
行覆盖 **6.5%**、块级候选每文件 1.4 个 —— 作者实测反馈"废物功能"。REMEASURE 已量化定位：
问题不在解析器（只失败 5 次），而在**判据用错了层**（把为"写盘安全"设计的强判据用在纯显示上）。

本批把 B 层（显示口径）做成端到端可用：**逐行局部映射 + 单行降级 + 少部分留原代码**。

#### 做了什么

1. **契约定死**（`plugin-api/sugar.ts`）：新增 `SugarProjectSegment`（区间 + 糖文本 + 行数），
   `SugarProjectResult` 定为 `{ segments, stats }`（段数组是区间与文本的唯一真源——宿主
   要的正是"区间+替换文本"这一对）。修掉此前契约写 `text`、实现返回 `segments` 的**半成品断链**。
   统计口径补齐为**完整口径**：`projected + passthrough + native === totalLines`（不变量，
   收束行 `ENDIF`/`ENDSELECT` 计入 projected，不再有行"凭空消失"）。
2. **可读化**（`project.ts`）：文本体内反糖代词 `%CALLNAME:MASTER%` → `{你}`、`%CALLNAME:TARGET%` → `{她}`。
   反向表由 `expression.ts` 的 `PRONOUN_MAP` **派生**（`PRONOUN_REVERSE`），正反对称是构造事实。
   属性反糖（`TALENT:TARGET:X`）**不做**：需要"索引是真名而非编号"的反向字典，猜错即误导。
3. **空行输出并入投影**（本批最大的单项收益）：作者用裸指令打空行（`PRINTFORMW` /
   `PRINTFORMDL␠`），400 文件实测 **35,425 行**、形态 100% 是"指令后为空"。此前归
   `empty-text` 原样保留 → **把每一段糖都切断**（段数 187/文件、最多 4,804）。现投影为
   一行空行（读者看到的正是游戏里的节奏），`empty-text` 成因随之从契约中删除。
   结构判据同时前移到内容判据之前（数据表体内的行无论空否都不投影）。
4. **供给层**（`ui-sugar-lift`）：实现 `provideLiftProject`（此前**零实现者**），与逐条候选
   分用两个 memo（触发面不同，避免"只要投影"的文件白跑一遍最贵的自证）。
5. **宿主闭环**（`EditorPane` + `sugar-view.ts` + `sugar-render.ts`）：
   - 工具条按钮 / 命令面板 `Ctrl+Alt+T` / 插件意图事件 `editor.sugarView.set`（`on` 省略 = 反转；
     状态所有者是宿主，新增事件已按 §5.48 机制登记进 `PLUGIN_EMITTABLE_EVENT_NAMES`）；
   - 偏好持久化 `kojo.ui.sugarView.v1`，**默认开启**（本功能的存在理由就是"打开就能读懂"；
     ERB 恒只读，默认显示成糖不干扰任何写工作流），关掉后记住；
   - 渲染 = 段上插 ViewZone（糖文本）+ `setHiddenAreas` 隐藏源区间（**原子、可整体撤销**；
     不用 `editor.fold` 命令——那是"一次一条、与折叠层级耦合"的语义）。
     该方法在 Monaco 0.57 运行时存在但未进 d.ts，故做**能力探测**并降级可见（拿不到就只插糖不隐藏）；
   - **着色复用 `.kojo` 的 Monarch 配色**（`KOJO_SUGAR_THEME_RULES` 派生 token→色），
     糖视图里的糖与 `.kojo` 文件里的糖同色；配色映射纯函数 10 项单测；
   - **分帧填充**：先建空壳（O(1)/段）再按帧填内容（≤120 段/帧，可见优先）——
     真实语料最大 **9,569 段/文件**，一次性渲染会卡首屏。
6. **面板改口径**（`ui-sugar-lift` 面板 →「糖视图」）：从"候选列表 + 九万条未建议区间"
   改为读者真正会问的两句话——**"读懂了百分之多少"** 与 **"剩下的为什么是原代码"**（分因中文标签）。
7. **量化验收固化为常驻守门**（`packages/kernel/tests/sugar-projection.corpus.test.ts`）：
   把 REMEASURE 的临时探针换成**测真实实现**的语料测试（含样本读数 + 不变量硬断言 + 覆盖率下限），
   兑现 REPOSITION 验收口径 4「必须有量化提升，不接受跑通就行」。原两个临时探针删除。

#### 真实语料读数（2285 个 ERB，全量 3,598,297 行）

| 指标 | 读数 |
|---|---|
| **台词行覆盖**（读者要读的那类行） | **98.6%**（985,559 / 999,114） |
| 文件覆盖（打开能看到人话） | 96.4%（2,202 / 2,285） |
| 行覆盖（全部行，含骨架/赋值/注释） | 51.7% |
| 单文件段数 | 79% 的文件 ≤200；最大 9,569 |
| 不变量违例 | 计数不平 **0**｜段重叠/逆序 **0** |

改造前后对照（同口径，段数/覆盖）：段 74,800 → 54,147（400 文件样本）；行覆盖 49.5% → 54.7%。
**未投影的行是什么**（token 实测，前五）：`RETURN` 206,835 / `CALL` 135,477 / `LOCAL` 87,822 /
`PRINTL` 23,086 / `SETCOLOR` 22,487 —— 即函数骨架、调用与赋值、以及规范 §3.3 明确划为
能力边界的非 FORM 输出指令。**它是"少部分留原代码"，不是漏掉。**

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run` | **1043 passed / 9 skipped（1052）**（基线 1016/6） |
| `tsc -p tsconfig.json`（root） | exit 0 |
| `tsc -p packages/app/tsconfig.json` | exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件；内核零游戏词） |
| 真实语料守门 | 台词行覆盖 98.6% / 文件覆盖 96.4% / 不变量违例 0 |

#### 边界未做（明确记录）

- **函数骨架未合并**：`@M_KOJO_…` + `CALL …_1` + `RETURN RESULT` + `LOCAL = 1` + `RETURN 1`
  每组约 5 行，是"行覆盖 51.7%"与"段数 9,569"的主因。合并/折叠骨架是**下一杠杆**（需识别
  口上骨架模式，误判会藏真实逻辑，故单独立项）。
- **属性反糖**未做（需 adapter 提供"编号→真名"反向字典，属 adapter 边界）。
- **`SETCOLOR` → `着色` 块**未做（需块级重构 + 配对 `RESETCOLOR`）。
- **桌面壳实机勾验未做**：本机 `src-tauri/target` 不存在（首次 cargo 编译 20–30 分钟且需 GUI 会话），
  Monaco 交互（ViewZone / 隐藏区间 / 分帧填充）**已由纯逻辑单测与语料读数覆盖，但未经真机目视**。
  手工清单：打开一个真实口上 ERB → 应默认显示为语法糖 → 切换按钮/Ctrl+Alt+T 往返 →
  滚动大文件不卡 → 关项目再打开偏好被记住。

---

### 5.60 语法糖批 A/C/D/E · 口径修正与三轮投影增强（2026-10-12 批：用户十条口径全量落地）

> 用户 2026-10-12 逐条口径（10 条）→ 分四批实施：**A 交互口径** / **C 投影增强** /
> **D 骨架合并** / **E 注释保留**。第 4 条（tree-sitter）明确「后续再看」；第 10 条
> （口上项目/口上树线）划归**其他小组**；第 9 条 `.workbuddy/` 不入库；第 11 条每步推送。

#### 批 A · 交互口径修正

| 用户口径 | 落地 |
|---|---|
| 删掉「升糖预览」面板、停止其后续开发 | `ui-sugar-lift` 移除 `ui.panel` 贡献 + 删除 `panel-logic.ts` 与测试；逐条候选预览（`provideLiftPreview`）一并停用（契约成员保留以守兼容承诺、标注已停用，宿主不再调用，单段打字机/折叠供给整段删除） |
| `.kojo` 要**升糖建议**：💡 把 ERB 写法改成糖（可 Ctrl+Z） | 契约新增 `EditorTextEdit` + `EditorCodeAction.edits`；宿主 `applyTextEdits`（降序应用 + 坐标夹取 + **单次 executeEdits = 一个撤销步**）；新纯逻辑模块 `lift-action.ts`（挑候选 / 补回原缩进 / 标题）+ 9 项单测 |
| `.erb` 的糖视图**不是面板**，是编辑器内直接前端改动 | 保留 `provideLiftProject` 供段 + 宿主 ViewZone/隐藏区间；面板路径彻底移除 |
| ERB 编辑出口：默认只读锁，检测到编辑动作再弹窗二选 | `onDidAttemptReadOnlyEdit` → `ErbUnlockDialog`（保持只读 / 允许编辑）；解锁**按文件按会话**（不落盘）、解锁即关闭该文件糖视图；工具条给「恢复只读」；**不做** ERB→`.kojo` 转换（用户明确） |
| 糖视图默认开 + 首次打开 ERB 弹窗询问 + 设置页可关 | `SugarViewIntroDialog`（只问一次：偏好与「问过」分开存两个 key）；设置页新增「语法糖视图」开关（开面板读当前值 → 改动写偏好 + 发意图事件，**状态所有者仍是编辑器**） |

**顺带修一个真 bug**（`lift.ts` `normalizeIndent`）：旧实现用 `indentOf` 算**层级**、
却在剥离循环里按**字符**扣（空格 1 / 全角 2 / TAB 1）——两把尺子。后果：4 空格缩进的源
只剥 1 个空格，与壳产物判成"不一致"→ **凡空格缩进的 `.kojo`（规范 §6 示例与新建向导
骨架的写法）识别不到任何升糖候选，💡 根本不出现**。改为"先算层级、再按层级重排"，
并加 4 种缩进风格（1 TAB / 4 空格 / 8 空格 / 2 TAB）的回归测试。

#### 批 C · 属性反糖 + `SETCOLOR`→`着色` 块（用户第 7、8 条）

- **属性反糖**：`{CFLAG:TARGET:1088}` → `{她的好感度}`。**无需改 adapter**——
  `VariableSchema.lookup(族, 编号).description` 本就是名称（adapter 早已建好 `byIndex`
  反向表），只需在字典装配层暴露 `DictionaryLookup.nameAt`（可选能力）。
  三条判据一条不放宽：族必须**角色作用域**（`FLAG`/`TFLAG` 是全局族，写 `她的FLAG` 是错的）、
  角色必须 TARGET/MASTER、名称必须查得到（查不到留数字，**绝不编名字**）。
  两种作用面判据不同：插值只替换"整支恰是一个引用"（`{X + 1}` 不碰），
  控制流表达式做**词级**替换（`CFLAG:TARGET:1088 >= 500` → `她的好感度 >= 500`），
  双引号字面量内不碰。
- **`着色` 块**：`SETCOLOR …` 与**同深度**的 `RESETCOLOR` 配对 → `着色 …：` 块，体内 +1 层、
  配对的 `RESETCOLOR` 被吸收。三重守卫：**不跨函数边界**（`@` 行清栈——否则"本函数只
  SETCOLOR 不收尾 + 下个函数 RESETCOLOR"会把下个函数整段缩进进着色块）、**不跨停用区**、
  同深度才配。配不上的一律原样保留（真实语料 SETCOLOR 22,487 对 RESETCOLOR 6,312，
  **多数没有配对收尾**）。

#### 批 D · 函数骨架合并（用户第 2 条）

两类骨架，判据都要求**可证明**，配不上就整段不动（用户定的底线：**宁可漏**）：

1. **包装三联**（400 文件实测 1,612 处）：保留 `@A`，吸收 `CALL A_1` / `RETURN …` / `@A_1`
   ——`CALL A_1` 证明了它只是转发。判据：四行**连续** + `CALL` 目标恰是 `@A_1`。
2. **記入チェック信封**（400 文件实测 3,824 处，**全部可闭合**，99.9% 在函数体最外层）：
   吸收 `LOCAL = 0/1` / `IF LOCAL` / 配对 `ENDIF` / 紧随的 `RETURN …`，并把正文**整体减一层缩进**
   （信封拆了，缩进必须跟着拆，否则会出现"没有块头的缩进"）。判据：字面形态 + 向下紧邻
   `IF LOCAL` + 缩进 0 + 能配对同缩进 `ENDIF` + **向上能找到函数头 `@…`**。

顺带修一个真机上看得见的 artifact：纯吸收段会产生 `sugarText === ''`、`lineCount === 0` 的段
——宿主据此**跳过 ViewZone**（否则留下一条空的彩色横条），但**仍参与隐藏**。

**我此前对收益的估算是错的**（把 `CALL`/`RETURN` 大多当成了骨架，实测它们多数是真逻辑：
提前返回、`CALL ASK_M(...)` 等）。修正后的真实读数见下表。

#### 批 E · 注释保留到产物（用户第 3 条）

- 契约新增 `CommentLine`（并入 `SugarStatement` 与 `SugarTopLevelNode`）；
  parser 三处丢弃点改为保留；codegen 随所在层级缩进落进产物，文件头注释排在产物最前。
- **空行仍不保留**（§3.10）；**`随机` 块候选之间的注释不保留**（那里每行都是随机候选，
  塞注释会改变 `RAND:n` 的 n——宁可不保留，也不改语义）。
- **规范同步修订**（用户拍板）：文首加修订说明；§3.10 注释/空行两行口径改写；
  §6.1 期望产物首行前补一条头部注释；`plugin-api/tests/sugar.test.ts` 的四处规范行号锚点
  同步（+1/+2，golden 与规范文档**互相守门**是既定机制，故必须一起动）。

#### 真实语料读数（2285 个 ERB / 3,598,297 行，逐批累计）

| 指标 | 批 A 前 | 批 C 后 | 批 D 后 |
|---|---|---|---|
| **台词行覆盖**（读者要读的那类行） | 98.6% | 98.6% | **98.6%** |
| 文件覆盖 | 96.4% | 96.4% | **97.4%** |
| 行覆盖（全部行） | 51.7% | 52.0% | **54.5%** |
| 未投影的 `RETURN` / `LOCAL` / `CALL` | 20.7 万 / 8.8 万 / 13.5 万 | — | **16.7 万 / 5.4 万 / 12.7 万** |
| 不变量违例（计数不平 / 段重叠） | 0 / 0 | 0 / 0 | **0 / 0** |

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run` | **1071 passed / 9 skipped（1080）**（批 A 前 1043/9） |
| `tsc -p tsconfig.json`（root） | exit 0 |
| `tsc -p packages/app/tsconfig.json` | exit 0 |
| 真实语料守门 | 台词行 98.6% / 文件 97.4% / 行 54.5% / 不变量 0 |
| 真实文件目视复核 | K49 `M_KOJO_K49_310_派生.ERB`：糖覆盖 292 → 354 行，骨架收起、注释保留、正文减一层缩进 |

#### 边界未做（明确记录）

- **桌面壳实机勾验仍未做**（本机 `src-tauri/target` 不存在，首次 cargo 编译 20–30 分钟且需
  GUI 会话）。批 A 新增的交互（只读锁弹窗 / 首次引导 / 设置开关 / `.kojo` 💡 改写）
  **已由纯逻辑单测与语料读数覆盖，但未经真机目视**。手工清单：打开 `.erb` → 首次引导弹窗 →
  尝试输入 → 解锁弹窗二选 → 解锁后糖视图关闭 → 恢复只读；打开 `.kojo` → 光标停在 ERB 直通行 →
  💡 改为语法糖写法 → `Ctrl+Z` 撤回；设置页开关语法糖视图。
- **tree-sitter 增量解析**：用户明确「后续再看」（第 4 条）。
- **口上项目 / 口上树线**：用户明确划归其他小组（第 10 条）。

---

### 5.61 语法糖教学样例批 · 全语法面样例 + 真实链路转译守门（2026-10-12）

> 依据：用户「参考真实口上文件，提供覆盖语法糖用法足够多的示例 .kojo 用于教学，并测试能否顺利转译为 .erb」。

#### 交付

1. **`fixtures/sugar/teaching-full.kojo`**（教学样例，全语法面）：头部声明七项 + 开关块 +
   别名四种形态 + 六个时机分野（初见/指令 310 带成否/指令 311 带隐藏子句/绝顶/计数器/日记）+
   台词/旁白/续、插值三形态、行内条件、如果（块/单行/表达式）、`不在…到`、
   当（块/表达式）、随机（块/行内）、心形、着色块、注释三落点、源折行、
   原生直通行/块——每式旁边的中文注释逐条讲规则与产物。变量名全部取自真实
   eratw CSV（好感度/恋慕/思慕/反発刻印/诶嘿嘿/欲情）。
2. **`fixtures/sugar/teaching-full.expected.erb`**：同目录 golden，真实链路转译产物，
   供「剧本 ↔ ERB」对照阅读。
3. **`packages/kernel/tests/sugar-teaching.transpile.test.ts`**（常驻守门）：生产链路
   （内核 + eratw-adapter 真实 CSV 字典 + kojo-sugar 转译服务）断言**零 error 诊断** +
   golden 逐字节比对 + 12 项结构冒烟。`TEACHING_GOLDEN_WRITE=1` 重锚；
   无 `KOJO_SMOKE_PROJECT` 跳过。

#### 样例首跑即实证的三处转译器缺陷（全部修复）

| # | 缺陷 | 症状 | 修复 |
|---|---|---|---|
| 1 | 行内条件分支整段当代码降糖（`expandFragment`） | 规范 §3.4 **自己的示例** `「{她的恋慕 ? "只有你，我不讨厌。" : "别靠太近。"}」`逐词报 `unknown-identifier`；与变量同名的汉字被静默改写 | 分支按 FORM 字面量处理：仅 `%…%` 内表达式降糖，其余原样 |
| 2 | 头部声明/别名的行内注释未剥离（`classifyLine`） | 规范 §3.1 **全部示例**带注释：`角色: 12 ; 必填…` → 函数名里嵌注释文本，**零诊断静默坏产物**（引擎调不到函数）；别名值吞注释 → 引用别名逐词报错 | 结构化行（头声明/别名/赋值/块头/子句）先剥引号外 `;` 注释；文本行与原生直通**不剥**（台词里的 `;` 是要打印的字符） |
| 3 | 字符串字面量别名在插值内展开错（`renderInterpolation`） | `别名 昵称 = "小露"` 的 `{昵称}` → 产物 `{"小露"}`（非法 FORM） | 整支恰是带引号字面量时展开为**裸文本**（无引号无括号） |

回归测试 8 项（`transpile.test.ts` 末「回归（教学样例批）」三组）。

#### 顺带发现的两条边界（记录在案，未动）

- **表达式 `当`/`如果` 的左值识别不认原生写法**（`TFLAG:193 = 当 …：` → indent-mismatch）；
  只认糖标识符/别名左值。作者侧规避：给原生变量起别名。是否放宽识别待拍板。
- **`@` 原生直通块在时机正文内不支持**（只能顶层，且吞到下一个 `@`/EOF——必须放文件末尾）。
  这是规范 §3.10 语义的自然结果，教学样例已写明。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run` | **1079 passed / 10 skipped**（批前 1071/9） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `audit:decoupling` | A–D 全绿 |
| 语料守门 | 不变（54.5% / 98.6% / 不变量 0） |
| 教学守门（含 golden） | 通过 |

---

### 5.62 语法糖批 F/G · 输出家族与行内条件投影（2026-10-12 批：真实语料回放暴露的投影边界）

> 触发：全量守门读数里"未投影行按行首 token"前 15 名中有 **5 个是 PRINT 家族**
> （`PRINTL` 23,086 / `PRINTW` 16,840 / `PRINTDW` 14,532 / `PRINTDL` 7,236 / `PRINTFORM` 5,996），
> 样本 `PRINTDW 只是狂舔灵梦的脚而已。` —— 这正是读者要读的旁白本体，却因"无糖形态"被留成原代码。
> 需求口径不变：**打开别人写的 ERB 口上，不熟悉 EraBasic 也能像看剧本一样读懂**。

#### 探针先行（第五次应验"先 dump 真实形态再定语义"）

| 实测（2,285 文件 / 3,599,696 行） | 读数 | 由此定的语义 |
|---|---|---|
| 非 FORM 输出行 `PRINTL/W/DL/DW/PRINT/PRINTD` | 62,651 行；空体占比 48.0% / 97.4% / 57.1% / 99.1% / 10.8% / 0% | 空体 = 打空行（并入既有空行口径）；有体 = 文本行 |
| 非 FORM 行含 `%…%` | **5 / 62,651 行** | 非 FORM **不展开** FORM 记号 → **逐字符原样，绝不反糖** |
| `PRINTDL` 含 `\@` | 518 行，**全是 ASCII 图形文字**（`"@@O\` [O\. =@@@\`,\^ …"`） | 同上：`\@` 在非 FORM 行是字面字符，不得当行内条件 |
| 裸 FORM `PRINTFORM` / `PRINTFORMD` | 7,750 行，空体仅 0.9% / 0.6% | 是"拼句片段"→ 投影为文本行，但**不加**「续」（`续` = `L`；无后缀是"不换行"，糖无等价标记，规范 §3.3） |
| `\@` 每行出现次数 | ×2 = 7,997 行｜×4 = 340｜×1 = 202｜×3/×5 = 18 | 只对**成对**的 span 动手；奇数 = 断串 → 整行放弃 |
| 首个 span 形态 | FORM 行里几乎全部**同时含 `?` 与 `#`** | 只认三元 `\@cond?A#B\@`；省略假分支的形态语料无 → 不猜 |
| 表外变体合计 | `PRINTBUTTON` 264 / `PRINTLC` 39 / `PRINTS` 8 / `PRINTPLAIN*` 17 / `PRINTV` 2… ≈ 350 行 | **不投影**（按钮 / 排版输出不是"读者要读的文本"，误映射风险 > 收益） |

#### 一条被证伪的猜测（记录过程，避免下次再猜）

零段文件读数里出现 `Lilystory2.ERB`（`PRINTFORMDW` 1,822 行却 **0 段**）→ 第一反应是
"未闭合的数据块吞掉整文件"。**查证结果：不是缺陷** —— 该文件第 1 行 `[SKIPSTART]`、
第 2,706 行 `[SKIPEND]`，整份口上被作者整体废弃，投影判它"停用区"是正确行为。
（教训：探针的分桶口径要先确认 —— 本探针的行首 token 正则把 `[` 排除在外，SKIP 标记
没进直方图，差点把我带上错路。）

#### 批 F · PRINT 输出家族投影（`project.ts`）

- **显示口径表**换成三判据（全部由指令名本身决定，一条不猜）：`form`（是否展开 FORM 记号）、
  `newline`（是否产生一行 = `L`/`W` 后缀）、`wait`（`W` 等待 / `L` 不等待）。
- **可读化只对 FORM 行做**（文件头纪律新增第 2 条）：非 FORM 行逐字符原样。
- 空体并入"打空行"：`newline` 变体的空体 → 一行空行；`PRINT` / `PRINTFORM` 无后缀空体
  既不输出也不换行 → 原样保留（没有可显示的东西）。
- `续` 判据 = `newline && !wait`（无换行的片段不能谎称续行）。
- 指令后紧跟 `;` 的写法原样保留（那是注释，不是要打印的字；语料 1 行，判据为不误导而设）。
- 契约 `SugarProjectNativeReason` 两码的**口径注释**随实现改写（闭集未变、零结构改动）。

#### 批 G · 行内条件 → 糖三元（`project.ts`）

- `inlineConditionsToSugar`：按 `\@` 切段，**体外**段走 `readableText`，**span** 段
  → `{条件 ? "A" : "B"}`；三条判据（成对 / `?` 与 `#` 齐备 / 条件非空）任一条不满足
  → **整行**保留原生。理由：把条件猜错显示成"读者以为看懂了"，比留一行原代码危险得多。
- 条件段走**表达式反糖**（与控制流同一个 `reverseExprAttributes`：词级替换、双引号内不碰）；
  空分支显式 `""`；分支含 `%` `"` `{` `}` 时**原样照抄** —— 规范 §3.4 明确"嵌套插值不出现"，
  给变量引用套引号是把它当字面量，给它反糖又会产生嵌套 `{…}`，两头都造出读者写不出来的假语法。
- 顺带修一处真机上看得见的瑕疵：`toSegment` 里**空行不再带缩进制表符**
  （否则段内空行是一条无内容的彩色横条）。

#### 守门口径升级（`sugar-projection.corpus.test.ts`）

- 旧尺子 `LIFTABLE_PRINT_RE`（只数 4 个 FORM 变体）拆成两把：`FORM_PRINT_RE`（同口径，
  与 §5.59/§5.60 历史读数可比）+ 新增 `OUTPUT_PRINT_RE`（12 个变体 = 全部"会被打印出文本"的行）。
  **只用窄尺子则"少认一类 `PRINTL`"永远不会红** —— 新能力必须被度量到。
- 覆盖率下限 0.95 → **0.99**，并写明三个"退化落点"测算：退回批 F 前输出行 92.1%
  （985,559/1,069,516）、退回批 G 前输出行 98.7% / 台词行 98.6%，都会被这条线拦住。

#### 真实语料读数（2,285 文件 / 3,598,297 行，逐批累计）

| 指标 | 批 F 前 | 批 F 后 | 批 G 后 |
|---|---|---|---|
| 台词行覆盖（4 个 FORM 变体） | 98.6%（985,559/999,114） | 98.6% | **99.2%**（990,914/999,114） |
| 输出行覆盖（12 个变体，新尺子） | 92.1%（推算：985,559/1,069,516） | 98.7%（1,055,147/1,069,516） | **99.2%**（1,060,647/1,069,516） |
| 行覆盖（全部行） | 54.5% | 56.4% | **56.5%** |
| 未投影成因 | print-variant 70,276｜inline-condition 5,357 | print-variant 503｜inline-condition 5,500 | print-variant 503｜**inline-condition 0** |
| 段数（宿主 ViewZone 数） | 364,507（最多 9,489） | 329,095（最多 9,495） | **325,302（最多 9,016）** |
| 不变量违例（计数不平 / 段重叠） | 0 / 0 | 0 / 0 | **0 / 0** |

（"批 F 前 92.1%"是按同一把新尺子对旧实现的推算（旧实现只认 4 个 FORM 变体），不是实测。）

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run` | **1097 passed / 10 skipped**（批前 1079/10；`project.test.ts` 41→59） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 真实语料守门（全量，含收紧后的 0.99 下限） | 通过 |
| 真实文件投影文本目视 | `M_KOJO_K1_コマンド.ERB`：`%CALLNAME:MASTER%…侵犯着灵梦的\@ TEQUIP:50 == MASTER ? 膣 # 菊穴 \@` → `{你}…侵犯着灵梦的{她的Ｖ性交 == MASTER ? "阴道" : "直肠"}` |

#### 边界未做（明确记录）

- **着色层不区分"字面记号"**：非 FORM 行投影后逐字符原样，但 `.kojo` Monarch 配色会把其中的
  `{…}` / `%…%` 按插值着色（真实语料里主要是 ASCII 图形文字与日记排版）。要消掉需给段文本带
  "此行不展开 FORM"的元信息 → 契约级改动，另立批。
- **`SIF` 单行条件**（9,516 行：`SIF cond:CMD` 7,417 + 裸 `SIF cond` 2,099）未投影为
  规范 §3.5 的单行「如果」——**下一杠杆**。
- **`@` 函数头时机反糖**（15,761 行 `@M_KOJO_*`）未做：需要 adapter 的 37 面表**反向**查询
  （函数名 → 时机中文），属契约 / adapter 边界，收益最大但须单独立项。
- **桌面壳实机目视仍未做**（本机无 `src-tauri/target`）。批 F/G 新增的显示形态（非 FORM 文本行、
  空行、三元插值）已由**真实文件投影文本目视**复核，但未经真机 Monaco 渲染确认。

---

### 5.63 语法糖批 H · `SIF` 投影（2026-10-12 批：单行条件成「如果 …：」+ 正文缩进）

> 触发：§5.62 的读数里 `SIF` 仍有 9,516 行留原代码（未投影 token 榜第 7）。用户拍板下一批做它。

#### 探针先纠正我自己的一次误判（值得记下来）

第一版 SIF 探针把 `LOCAL` / `RESULT` / `STR` 放进了"指令关键字表"，用来判 `SIF 条件:命令`
的冒号边界。结果 **17,499 行裸 `SIF 条件`**（条件里本来就带**变量索引冒号**，如
`SIF !CFLAG:ARG:诶嘿嘿`）被误判成"有冒号形态"，读数彻底失真。修正关键字表后重测
（2,885 个口上 ERB / 18,130 行 SIF）：

| 形态 | 行数 | 结论 |
|---|---|---|
| `SIF 条件:命令`（冒号后紧跟真指令） | **0** | 语料里不存在这个写法 |
| `SIF 条件`（条件独占一行） | 18,130（100%） | 被管的语句在**下一行** |
| 下一行 = 简单语句 / 输出行 / 连写 `SIF` / 开块或闭合行 | 13,137 / 4,987 / 6 / **0** | 配对判据可以取最紧的形态 |

教训与 §九-15 同源：**关键字表里"变量名"和"指令名"混在一起，判据就会指错方向**——
`RESULT`/`LOCAL` 既是可赋值对象又常出现在条件里，不能当边界标志。

#### 做了什么（`project.ts` `planSif`）

- 块头 `如果 <条件>：`，条件走**表达式反糖**（与 IF 同一个 `reverseExprAttributes`：词级替换、
  双引号内不碰、查不到名称不动）；**正文那一行 +1 层缩进**——糖"缩进即块"的天然读法
  恰好等于 `SIF` 的语义"只管一条语句"。
- 四条判据，一条不满足**整行不动**（`unsupported-control-flow`，原样留原代码）：
  ① 结构扫描认出 `SIF` 且表达式非空；② 表达式里**没有**"冒号 + 指令关键字"形态
  （与变量索引冒号在没有完整表达式解析时**不可证**，语料 0 例也不猜）；③ 向下第一个非空非注释行
  是**单条语句**——不是开块语句、不是 `ENDIF`/`ELSE`/`CASE` 这类链的续行（`ELSE` 属于它上面那条链）、
  不是另一条 `SIF`（连写 = 作用域叠加，一行说不清）、不是 `@`/`#`/`$`/`[` 开头；
  ④ 不在停用区，也不在 `PRINTDATA` 数据表体内（**结构判据先于内容判据**，与台词行同口径）。
- 缩进补正收口在原有的一处：`color.bumpAt + sif.bumpAt − skeleton.dedentAt`（三层机制叠加，漏改不了）。

#### 真实语料读数（2,285 文件 / 3,598,297 行）

| 指标 | 批 H 前 | 批 H 后 |
|---|---|---|
| **SIF 覆盖**（新第三把尺子） | 0%（9,516 行全留原代码） | **93.3%**（8,875/9,516） |
| 行覆盖（全部行） | 56.5% | **56.8%** |
| 文件覆盖（打开能看到人话） | 97.4% | **97.5%**（+3 个文件首次出现糖段） |
| `unsupported-control-flow` 成因 | 21,657 | **12,782** |
| 台词行 / 输出行覆盖 | 99.2% / 99.2% | 不变 |
| 段数（宿主 ViewZone） | 325,302 | 326,330（最多 9,011） |
| 不变量违例 | 0 / 0 | **0 / 0** |

**余下 641 行是判据故意挡下的**（目视抽查确认：`[SKIPSTART]` 区内的作者废弃样本、
正文是开块语句、连写 `SIF`）——不是漏，是不猜。

#### 守门口径

新增**第三把尺子**「SIF 覆盖」（`SIF_LINE_RE` 按源行统计有多少 SIF 落进糖段），断言 > 0.9。
理由：这条能力只占全语料 **0.26%** 的行，混在"行覆盖"里退化**不会红**——尺子必须跟着能力长。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run` | **1105 passed / 10 skipped**（批前 1097/10；`project.test.ts` 59→68） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 真实语料守门（全量） | SIF 93.3% / 台词 99.2% / 输出 99.2% / 不变量 0 |
| 真实文件目视 | `SIF CFLAG:1:300 == 15 && CFLAG:MASTER:300 == 15` → `如果 她的既成事実:300 == 15 && 你的現在位置 == 15：`；正文 `CALL MOPIGU(RESULT)` 留原代码并 +1 缩进 ——**后半句作废，见 §5.66**：`她的既成事実:300` 是假阳性（`CFLAG:1:` 是角色号作用面），§5.66 已加守卫 |

#### 边界未做（明确记录）

- **`SIF 条件:命令` 冒号形态不支持**（语料 0 例）。要支持得有表达式级的冒号分界能力，
  属 `condition-extractor` 的表达式解析域，不是投影层该猜的。
- **正文不是输出行时块头会"悬空"**（如 `如果 A：` 下面跟着原样的 `RETURN 1`）。
  这是"只替换能替换的行"的必然形状，读者仍能看到条件与相邻语句的先后关系；
  若要连正文一起画进糖区，就得允许段内出现未投影行 → 契约级改动（`SugarProjectSegment` 语义）。
- **`@` 函数头时机反糖**（15,761 行）与**着色层字面记号误着色**仍在案（§5.62 边界），
  前者需 adapter 37 面表的反向查询（契约 / adapter 边界），后者需段文本带元信息。
- **桌面壳实机目视仍未做**。

---

### 5.64 两线合流批 · 语法糖线 rebase 进 master（2026-10-12 批：编号让位 + ADR-0005 落地 + 守卫接回存活路径）

> 依据：`docs/adr/0005-erb-write-permission-and-sugar-view.md`（两组共同依据，用户拍板）；
> 留档口径先例：本仓 **§5.55**（`feat/kernel-optimization` 两轮 rebase 的冲突处置记录）。

#### 分叉规模

- master 侧 **29 个提交**（两轮：`b1f260e..ed43474` 24 个 + `ed43474..fcd8714` 5 个；首轮 84 文件 / +8,814 行）：口上项目线 P-A…P-F 与 T2…T4、
  内核优化线（L0 埋点 / 超长文件丝滑 / 索引快照 / 计算池 / 并行运输 / 审修补丁）、UI P4、测试适配批。
- 语法糖线 **13 个提交**（`47f0655..fa9a18a`），加合流期两批适配后共 **15 条**。
- 共同祖先 `b1f260e`；重叠文件首轮 **14 个**、次轮收敛到 **3 个**（两份 docs + `plugin-api/src/index.ts`）：两份 docs、`.gitignore`、
  `plugin-api/{events,slots,index}.ts`、`plugin-api/tests/events.test.ts`、
  `EditorPane.tsx`、`styles.css`、`ProjectView.tsx`、`kojo-sugar/tests/compile.test.ts`、
  `ui-sugar-lift/{index,panel-logic,lift-action}.ts` 与其两个测试文件。

#### 编号让位（他们先落地 → 我的糖线小节顺延）

| 原（糖线） | 新 | 小节 |
|---|---|---|
| §5.49 | **§5.59** | 语法糖视图批（B 层投影落地） |
| §5.50 | **§5.60** | 批 A/C/D/E |
| §5.51 | **§5.61** | 教学样例批 |
| §5.52 | **§5.62** | 批 F/G |
| §5.53 | **§5.63** | 批 H |

**编号让位发生了两次**：第一轮 rebase（`b1f260e..ed43474`，24 提交）后我的小节落在 §5.58–§5.63；
推送前 `git fetch` 发现远端**又推进 5 个提交**（`fcd8714` 体感丝滑批等），而它把 **§5.58 用掉了**，
于是第二轮 rebase 后糖线小节整体再让一位 → 本表给的是**最终编号 §5.59–§5.64**（合流批自身 = §5.64）。
教训照抄 §5.55：**动手前 `git fetch`，推送前再 `git fetch`**——分支尖端与编号空间都会 decay。

交叉引用同批动：LOG 内**只在我自己的区域**重写（他们的 §5.49 / §5.50 / §5.51 字面串一个没碰——
那三条分别是口上项目批 P-A…P-E、T2、内核优化批）；HANDOFF §二 条目；
`LIFT-REMEASURE` 三次回执里两处"权威记录"指针。
**提交信息里的旧编号不回改**：改 13 条已推送提交的 message 要 force-push，收益小于风险——本表即映射。

#### 代码冲突处置（逐处都不是"选边"）

1. **`EditorPane.tsx` 三处并集**：
   - import 区：两侧都要（他们的 `editorOptionsForLineCount` + `perf`，我的 `SugarViewDialogs` 与 `sugar-view` 全家）；
   - 切文件路径：`clearSugarView()` 与"按体量落 Monaco 选项"**都必须在 `setModel` 之前**——
     顺序取"先还原上一个 model 的隐藏区间，再落新 model 的选项"；
   - 折叠链：他们的 `lineCount` 降级守卫原本挂在 `ui.editor.liftPreview`（宿主折叠范围供给器）上，
     而批 A 已按用户口径**删除面板并停用逐条候选预览** → 该宿主路径按批 A 删除，
     守卫**接回唯一剩下的自动触发路径**（`.kojo` 的 💡，Monaco 在光标/选区变化时反复调用），
     `large-file.ts` 判据与其纯函数单测**原样保留**（一行没改他们的算术）。
2. **`events.test.ts`**：白名单计数 15 → **16**（他们 +`workspace.importRequested`、我 +`editor.sugarView.set`，
   快照清单两侧都已在位，只有计数与标题需要随行）。
3. **`ui-sugar-lift/panel-logic.ts`**：两侧各自扩了 `PanelDegrade` 枚举（他们 `too-large` / 我 `not-erb`）——
   按"批 A 删面板"的最终态收敛；降级判据以纯函数形式活在 `large-file.ts`，不依赖面板。
4. **`eratw-adapter` 的 `react` peerDependency**（他们新增）：本机必须先 `pnpm install` 才建软链，
   否则 **18 个测试文件**以 `Cannot find package 'react'` 整片红——
   这是**环境动作不是代码问题**，后来者 rebase 到这条 master 上时会再踩一次。

#### ADR-0005 落地（提交 `ebb40bc`）

糖视图可用门做成纯函数 `sugarViewAllowed({isErbLike, inWorkspace, unlocked})`，宿主三处
（自动应用 / 首次询问 / 工具条入口）共用同一判据不分叉；**工作区 ERB 不再弹首次询问、不再投影**；
`setErbEditable` 的 `readOnly` 补上轴一（工作区文件不存在"解锁 / 回锁"这回事）。

#### 验证（每轮 rebase 后各跑一次；下表为第二轮最终态）

| 检查 | 结果 |
|---|---|
| `vitest run` | **1348 passed / 11 skipped**（首轮 rebase 后 1287/11 → 合流适配批 1296/11 → 远端再推进 5 提交后 1348/11） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| `pnpm --filter @kojo/app build` | ✓ 23.7 s（仅 Monaco 体积告警，非本次引入） |
| 语料守门（全量 2,285 文件） | 台词 99.2%｜输出 99.2%｜SIF 93.3%｜行 56.8%｜不变量 0 —— **与 rebase 前逐字相同** |
| 教学 golden + 他们的 `attribution.corpus` 语料守门 | 通过 |
| 全仓冲突标记扫描 | 0 |

**两轮读数一字不动就是这次合并的验收线**：糖投影是被他们性能线（计算池 / 并行运输 / 折叠链 /
Monaco 大文件降级）最容易被影响到的消费者——数字一字不动，才叫"并进来没伤到"。

#### 未做

- **`origin/syntax-sugar` 已删除**（用户 2026-10-12 拍板，照 §5.55 先例）：删除前用
  `git log --cherry-pick --right-only` + `git diff --diff-filter=A` 双重核验该分支**没有任何 master 里不存在的**
  文件或提交内容**（列出的 5 条"补丁不等价"提交就是 rebase 前后同源的那批）；旧 tip `fa9a18a`
  由本地 `backup/syntax-sugar-20261012` 持有。糖线此后**直接在 master 上推进**，不再留长命分支
  ——这次"落后 24 提交"的代价就是编号让位发生两次、14 文件冲突、两轮验证。
- 桌面壳实机目视（两组共同欠账，本机无 `src-tauri/target`，需 GUI 会话）。
  → **本节已补上第一段**：haruki 主机 `packages/app/src-tauri/target/debug` 是**存在**的，
  `pnpm tauri dev` 可跑，实机目视见 §5.76 验证表。


### 5.65 快照卫生批 · v3 元组编码 + 单文件收口 + 体感水位常驻（2026-10-12 批）

> **编号让位（同一根因第三次）**：本批落地时写作 §5.59，而语法糖线在自己那轮合流里已把
> §5.59–§5.64 占去（他们的 §5.64 就是让位记录）。rebase 后本小节顺延为 **§5.65**。
> 三次撞车（§5.49、§5.50、§5.59）的根因同一个：**小节号是在"写文档"那一刻凭记忆取的**，
> 而多线程期间 `origin/master` 一直在动。**固定做法：写日志小节前先 `git fetch` 并以
> `grep -c "^### "` 取当前最大号 +1**，别用记忆里的号；跨会话接力时更要这样。

> 承接 §5.58 的边界清单，三件事：快照瘦身、磁盘无上限、体感指标常驻。
> 分支 `feat/snapshot-hygiene-2026-10-12`，三个提交（v3 编码 / 单文件收口 / 水位常驻）。

#### 一、索引快照 v3：先量再削

v2 快照实测 **44.40 MB / 99,104 函数**，拆到字段级：

| 成分 | 体量 | 可否剥 |
|---|---|---|
| `function.filePath` | 13.34 MB | **可**——就是条目键（路径） |
| `function.normalizedName` | 3.02 MB | **可**——`= name.toUpperCase()`（`scanner.ts:263` 唯一定义处） |
| `file.path` | 0.30 MB | **可**——同样是条目键 |
| 函数对象的**键名本身** | 9.75 MB | **可**——改位置元组即消失 |
| `function.name` / `docComment` / `params` / 行号 / flags / dims | 9.20 MB | 不可（真信息） |

只剥派生字段预估到 27.75 MB，**键名开销比想象大**，所以 v3 同时做位置元组：
`[mtime, textLength, lineCount, hasDirective, functions[], dims[]]`，
函数 `[name, start, end, params[], flags, doc?]`，形参 `[name, 0|1]`。

**实测 44.40 MB → 11.93 MB（−73%）**；热启动 `snapshot get` 250 ms → **74 ms**，
索引可用 623 ms → **541 ms**（read+parse 仍是 0，`reused 2285/2285`）。

三条实现纪律：
1. **压缩只在存储边界**——内存里的 `SnapshotEntry` 形状不变，`diffSnapshot` /
   `mergeEntries` / `aggregateIndex` 一行没改，`plugin.ts` 只多一次 `encodeEntries`；
2. `isExpressionFunction` 必须**显式还原成布尔**——scanner 对每个函数都写（`false` 也在），
   还原成缺键就是形状漂移（round-trip 测试就是这么抓到的）；
3. 元组是**位置契约**，加"字段清单哨兵"测试钉住 `ErbFile`/`ErbFunction`/`ErbDim` 的键集合：
   将来谁加字段忘了改编解码，测试直接红，而不是快照静默丢数据。
   `SNAPSHOT_VERSION` 2 → 3，旧快照走既有 fail-closed 整体弃用（代价 = 一次冷索引）。

#### 二、索引快照收口成单文件语义

索引快照按项目根哈希留文件 ⇒ 开过 N 个项目攒 N 份、永不回收；而抽取/校验一直是
**单文件覆盖式**（判据在快照本体里，换项目即失效重算）。三段语义不一致 + 无上限磁盘口子。
`pruneSnapshotKeys`（纯函数）把索引也统一成单文件：只留当前项目的键，识别口径严格
`^index-v<版本>-<8hex>$` ⇒ 格式升级遗留的 `index-v1-*` / `index-v2-*` 孤儿顺带清掉，
**非快照形态的键一律不碰**（不越权删别人的东西）。落盘后与"全命中未变更"两条路径都收口；
清理是 fire-and-forget + try/catch，磁盘卫生失败不影响索引正确性。

代价讲明白：**交替打开两个游戏目录，每次切换付一次冷索引（约 2.3 s）**——这与抽取/校验
本来的行为一致，不是新增的痛。真要支持多项目常驻，得三段一起上登记表，而非让索引段特殊。

#### 三、体感水位常驻（含一处口径纠正）

§5.58 那三个水位是临时探针量出来的，跑完即删。现在做成常驻：
`cascade.projectOpened→index可用` / `→条件可用` / `→校验有结果`，都相对同一起点，
每轮开项目各段只记首次达成，`project.opened` 重置资格 ⇒ 一份 `__kojoPerf.summary()`
就能看到冷热差。逻辑抽到 `app/src/cascade-watermarks.ts`（bootstrap 会拉起 Tauri/worker
import，没法直接单测），5 项测试钉住"起点前不记账 / 只记首次 / 新一轮重置 / 各段独立"。

顺带纠正一处口径：原来的 `cascade.projectOpened→index` 只量第一段，而真实语料里
抽取 + 校验才是主体——**用户体感的等待 = 三个水位里最晚那个**，只报索引等于没报。
`docs/PERF-REVIEW-2026-10-11.md` §7.5 操作单同步改成"跑两次抄冷热"。

#### 四、本批合并后的水位与磁盘

| 项 | 冷（首次） | 热（快照命中） |
|---|---|---|
| 索引可用 | 2075 ms | **541 ms**（get 74 + coerce 57） |
| 抽取可用 | 6165 ms | **1232 ms** |
| 校验可用 | 9900 ms | **1178 ms** |
| 磁盘占用 | 37.5 + 45.9 + 0.42 = **84 MB**（v2，多项目无上限） | 索引 **11.93 MB** + 抽取 45.9 + 校验 0.42 ≈ **58 MB**，且**三段各自封顶一份** |

#### 五、边界未做（下批候选）

- **抽取快照 45.9 MB 没瘦身**：同一套办法可继续压（`FunctionConditions.filePath`、
  `StateDependency.name` 与 `key` 重复、`schema` 描述表可按项目字典去重）。现在它是磁盘大头。
- `extractFunctionConditions` 仍在主线程算（只是不必每次算）；上并行通道要先让
  `VariableSchema` 导出原始表（路线文档 §三 L1）。
- 多项目常驻登记表（若用户确实交替开多个游戏目录）。
- L2 转译共享缓存 / L4 增量转译未动。

### 5.66 语法糖批 I · 函数头时机中文反糖（2026-10-12 批：读者先看见"这是哪一段"）

> **编号让位（第四次，同一根因）**：本批写作 §5.65，落地前 `git fetch` 复核发现快照卫生批已占
> §5.65，rebase 时顺延为 **§5.66**。上一节刚写下"取号前先 fetch + 取最大号 +1"，本批**照做了
> 还是撞**——取号与落地之间隔着整批实施时长，多线程期间窗口必然存在。可执行的收敛只剩：
> **提交前最后一次 `git fetch` 复核号，把让位当作 rebase 的常规动作**（本次代价 = 两处文档冲突）。

**做了什么**：`@M_KOJO_MESSAGE_COM_K1_300` 这一行在糖视图里显示成 `时机 指令 300：`，
其函数体正文**缩进一级**（规范 §3.2"块头 + 正文缩进"的读法）。语料里 **100,532 个头**，
现在 **81,656 个（81.2%）** 有了人话锚点。

#### 为什么这根杠杆比再加一条糖划算

台词行覆盖已经 99.2%——再加台词类糖是**在已经满了的方向上加**。但读者打开一份口上，
眼里的第一行永远是函数头：头留原代码时他知道"这里开始一段"，却**不知道是哪一段**
（`M_KOJO_MESSAGE_COM_K1_300` 对不熟 EraBasic 的人等于噪声，而 300 号正是"接吻"）。
头是**全部正文的定位锚**，一条能力覆盖 10 万行、且决定"这份文件读起来有没有章节感"。

#### 契约口径（用户拍板"函数头时机中文反糖"，具体口径由本批定）

三条，都可证：

1. **标签 = 规范 §3.2 原文**——糖视图的第一原则是**看见的即写得出的**。
   据此定：默认类型段**整个省略**（`…_MESSAGE_COM_K1_300` → `时机 指令 300：`，
   因为 `类型: COM` 是规范明文的默认值）；非默认段写成命名参数
   （`…_MESSAGE_SCOM_K1_60` → `时机 指令 60 类型: SCOM：`）。
   **默认值取 `segments` 声明的第一个键**——与 `codegen.ts` 的缺省段规则同源，不新立规则。
2. **角色号 `{n}` 不进标签**（角色由文件头 `角色:` 声明）；抄进来会得到 `时机 事件 1 2：`
   这种"两个数读不出哪个是时机"的标签。家族段非空则收成 `（少女之梦版）`——
   "这是谁改的版本"是本项目的一等公民，必须留在读者视野里。
3. **解不出 / 有歧义 / 段名未在语法层登记命名参数 → 整头不标**，并计入成因 `other`（不静默）。
   判据排序：候选只取 `faces`（`registration` 三件套不是时机入口，标了会误导作者）；
   整串锚定匹配；多命中取**固定字面量最长**者；同分时主模板优先于"另一分野的成否子模板"
   （规范 §3.2 `时机 成功：`）；仍不平即放弃。

#### 探针与两个 bug（先 dump 真实形态，第六次应验）

新模块 `faces-reverse.ts` 第一版跑真实语料只有 **75.7%**，两处都是我的算术错：

- `{t}` 没推进 `slots` → 捕获位整体错位，标签长成 `时机 指令 _少女之梦 SCOM 1：`
  （家族名被当成分野段吐出来）。
- `${com}` 用宽松字符类兜底 → `…_MESSAGE_MESSAGECHECK_COM_K1_310` 与
  `…_MESSAGE_PALAMCNG_A_K1_3` 被吞成"指令的类型段"，于是给读者一个
  **看着像糖、其实是错的分野判定**。改为**只认 adapter 声明过的取值**（长值优先）后
  75.7% → **81.9%**，且标签全部正确。

#### 标签口径的回改（这一条值得单独记）

单元测试绿了以后我才发现产出的是 `时机 指令 COM 310：`——**把内部记号 `COM` 塞给了读者，
而且这一行作者写不出来**（糖写法是 `时机 指令 310：`，`类型:` 才是命名参数）。
根因：**"不丢信息"被我误当成了第一判据**，其实第一判据是"读得懂 + 写得回"，
默认值不写就是最精确的表达。修正 = `segmentParamName()`（原来 codegen 私有）导出共用，
反向标签与正向生成认**同一个**命名参数名；并加**闭环测试**：8 条真实标签逐个喂回
`transpile`，断言产出同一个函数名（`faces-reverse.test.ts` 末组）。这类测试红一次，
就等于"糖视图与糖语法分叉了"一次——不允许发生。

#### 真实语料读数（2,285 文件 / 3,598,297 行）

| 指标 | 批 H 后 | **批 I 后** |
|---|---|---|
| 函数头可标率（新增尺子） | 8.1%（仅被骨架吸收的包装头） | **81.2%（81,656 / 100,532）** |
| 台词行覆盖 | 99.2% | 99.2%（不变） |
| 输出行覆盖 | 99.2% | 99.2%（不变） |
| SIF 覆盖 | 93.3% | 93.3%（不变） |
| 行覆盖 | 56.8% | **58.8%** |
| 文件覆盖 | 97.5% | **97.8%** |
| 段数（宿主 ViewZone） | 326,330 | 333,895（+7,565 = 正文全为骨架的头） |
| 不变量违例 | 0 | **0** |

`+7,565` 段是**有意的代价**：那些头正文只有 `CALL`/`RETURN`，标出来就自成一段。
换到的是 8 万行有了章节锚点——用 ViewZone 数买读感，这笔账要摆在桌面上记。

#### 守门口径

`sugar-projection.corpus.test.ts` 加**第四把尺子** `HEAD_LINE_RE` + 下限 **0.7**
（退化落点 8.1% 实测过：撤掉批 I 即红）。行覆盖下限随能力上移 **0.5 → 0.55**，
并注明"撤掉批 I 不误红，那条回归由函数头尺子负责"——每把尺子只管一件事。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1398 passed / 11 skipped**（合流基线 1348 → 本批 +32 → rebase 到快照卫生批后再 +18，**读数与合并前逐字相同**） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件；新模块零游戏名词） |
| 语料投影守门（全量 2,285 文件） | 上表读数，**不变量违例 0** |
| 教学 / 归因 / 调用面 / 编码往返 语料守门 | 5 文件 11 测试全绿 |
| `vite build`（app） | ✓ 31.2 s（仅 Monaco 体积告警，非本次引入） |
| 探针文件 | 同批删除，仓库内无残留 |

#### 边界未做（明确记录）

- **18.8% 的头故意不标**：`MESSAGECHECK` 四件套、`KOJO_*_CUSTOM_BUTTON_*`、
  `M_KOJO_無个性_SUCCESS_K1_GENERAL` 这类**表里没有的调用面与工具函数**——
  分野表里没有的时机就不冒充有。未投影 token 榜首仍是 `RETURN`/`CALL`/`LOCAL`
  骨架（函数骨架合并是下一根杠杆，§5.62 已单独立项）。
- 反糖**写回**口径（`.kojo` 侧生成时机声明 + 三件套）不在本批：批 I 只动**显示层**；
  `liftSuggest` 与自证链路未接分野表。
- 着色层字面记号误着色需要契约级元数据（`SugarProjectSegment` 加"哪一段是记号"），
  不是投影能自己解决的——已记入下一批。
- `{i}` 允许带后缀的真实编号（`60_1`），因为包装三联的 `_1` 头在语料里确实存在且
  **写得回去**；若将来要做"包装头一律折叠"，应在骨架合并层做而不是在标签层做减法。

### 5.67 语法糖批 J · 角色状态赋值行反糖（2026-10-12 批：顺手挖出并堵死一个假阳性）

**做了什么**：`CFLAG:TARGET:1088 += 50` 在糖视图里显示成 `她的好感度 += 50`。
判据只有一条门槛：**左值必须是角色作用域族**（`CFLAG`/`TALENT`/`ABL`/`EXP`/`MARK`/
`BASE`/`PALAM`/`TEQUIP`/`TCVAR`），且反糖**真的改动了字**——一个字都没改就留原代码，
半中不日的行既没信息、也不是作者能写的。右值走同一个 `reverseExprAttributes`。

**为什么值**：读者看剧本要的是"这一段造成了什么"。语料实测口上域 **122,065 条赋值**里
`LOCAL` 占 **87,853（72%）**——那是引擎的临时量，读者的噪声底；真正的角色状态行约 **2.5 万**。
所以第五把尺子的**分母刻意只数角色族**：把 `LOCAL` 算进去，这把尺子会永远不达标、也永远不会红。

#### 本批最大的产出不是新功能，是抓到一个假阳性

写完探针一跑，读数 **43.8%**（8,986/20,532）。看样本时立刻不对：

```
CFLAG:1:好感度 += 50   →   她的既成事実:好感度 += 50
```

`CFLAG:1:好感度` 是**角色 1 的好感度**（`CFLAG:角色号:索引` 的二维形态），而
`EXPR_REF_RE` 的作用域组只认 `TARGET|MASTER`，遇到 `CFLAG:1:` 时把可选的作用域组**整个跳过**，
于是拿 `1` 去查属性名（`CFLAG` 的 1 号恰是「既成事実」），剩下的 `:好感度` 原样挂在后面。
产物既谎称"她的"（作用面根本不是 TARGET），又凭空造出一个毫不相关的属性名——
**这正是我自己给 `faces-reverse` 定的第一判据（错标比不标危险）在另一条链路上的失守**。

而且它不是批 J 引入的：`reverseExprAttributes` 从批 D 就在用，批 G（行内条件）、
批 H（`SIF`）都受影响——**§5.63 的"真实文件目视"记录里那条
`如果 她的既成事実:300 == 15：` 我当时看着顺眼就归档了，其实是同一个洞**。
批 H 的覆盖率统计也没暴露它，因为那一行**照样投影**，只是文本是错的：
**覆盖率量的是"有没有被处理"，永远量不出"处理得对不对"**——这是本轮最贵的一条教训。

**修法（守卫）**：无显式 `TARGET`/`MASTER` 作用域、而匹配后面**还紧跟一个 `:`** → 说明这是
三段以上的引用（中间那段是角色号），整支不动。`sugarForRef`（插值通道）本来就要求
"整支恰是一个引用"且三段时校验作用域，因此一直是对的——两条通道的判据这次对齐。

**堵死之后的诚实读数**：**26.0%**（5,344 / 20,532）。掉下来的 **3,642 行全是假阳性**。

#### 剩下 74% 是什么（口上域 20,562 条候选行全量分类）

| 成因 | 行数 | 占比 | 样本 | 性质 |
|---|---|---|---|---|
| 其它角色号作用面 | 11,803 | **57.4%** | `CFLAG:LOCAL:Ａ破瓜違和感確認 = 1`、`MARK:10:反発刻印 = 3` | **故意不标**：规范 §3.8 的 `她的X` 专指 `FAMILY:TARGET:X`，别的角色糖里没有写法 |
| 三段式名字索引 | 3,138 | 15.3% | `BASE:MASTER:勃起 = MAXBASE:MASTER:勃起` | 原文对读者**已经可读**，不需要糖 |
| 两段式名字索引 | 2,465 | 12.0% | `CFLAG:好感度 -= 100` | 同上 |
| 数字索引、字典查不到名 | 3,156 | 15.3% | `TEQUIP:4 = 1` | **L0 数据包缺口**（不是投影代码的问题） |

⇒ 这把尺子的**天花板 ≈ 41%**（当前 26.0% + 字典缺口 15.3%），要再高得先给 §3.8 加
"角色 N 的属性"写法——那是语法层决策，不在本批。

#### 守门口径

`sugar-projection.corpus.test.ts` 加**第五把尺子**「状态赋值可读率」（`STATE_ASSIGN_RE`，
下限 **0.2**：字典接线掉断或守卫收紧过头都会红）。同时**改口径说明**：分母只数角色族，
并写明为什么不计 `LOCAL`。

#### 真实语料读数（2,285 文件 / 3,598,297 行）

| 指标 | 批 I 后 | **批 J 后** |
|---|---|---|
| 状态赋值可读率（新尺子） | — | **26.0%（5,344 / 20,532）**（守卫前假读数 43.8%） |
| 行覆盖 | 58.8% | **59.0%** |
| 台词 / 输出 / SIF / 函数头 | 99.2% / 99.2% / 93.3% / 81.2% | **逐字不变** |
| 段数 | 333,895 | 332,614 |
| 成因 `other` | 461,442 | **452,456** |
| 不变量违例 | 0 | **0** |

条件族读数一字不动是**预期的**：守卫只改文本内容，不改"这一行是否投影"。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1411 passed / 11 skipped**（批 J +9 单测：三段式 / 两段式 / MASTER / 角色号假阳性 / 条件同洞 / 一字未改不动 / 比较不当赋值 / 非角色族 / 不变量） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 语料投影守门（全量 2,285 文件） | 上表读数，**不变量违例 0** |
| 探针文件 | 三个（形态分布 / 已投影与未投影样本 / 成因三分）**同批删除**，仓库无残留 |
| `vite build`（app） | ✓ 24.3 s（仅 Monaco 体积告警，非本次引入） |

#### 边界未做（明确记录）

- **`{角色N的X}` 写法**（§3.8 只覆盖 CALLNAME）没扩到属性族：扩了才能碰那 57.4%，
  属语法层决策 → 待用户拍板。
- `TEQUIP`/`PALAM` 等族的**数字索引 → 中文名**缺口是 L0 数据包的事，投影层不编名字。
- 反糖**写回**口径仍未接分野表与赋值（批 I/J 都只动显示层）。
- 桌面壳实机目视（两组共同欠账）；着色层段元数据（契约级）。

### 5.68 语法糖批 K · 演出行 `CALL HPH_PRINT` 投影成「心形 …」（2026-10-12 批：台词被锁在参数里）

**做了什么**：`CALL HPH_PRINT,@"「嗯～满足满足HPH」","W"` 显示成 `心形 「嗯～满足满足HPH」`
（规范 §3.9）。语料实测 **口上域 `CALL` 行 135,720 条里 HPH_PRINT 占 67,808 = 50%**，
而每一行的第二个参数**就是要给读者看的台词**——这一族不投影，等于把台词关在指令里。

#### 探针（第七次"先 dump 真实形态"）

按参数形态分类（口上域 2,317 文件 / 67,296 行）：

| 形态 | 行数 | 占比 | 处置 |
|---|---|---|---|
| `CALL HPH_PRINT,@"字面量","模式"`（逗号调用式） | 65,145 | **96.8%** | 投影 |
| `CALL HPH_PRINT(@"字面量","模式")`（括号式） | 956 | 1.4% | 投影 |
| 实参是变量（`CALL HPH_PRINT,LOCALS,"L"`）/裸 `"…"@"` 之外的串 | 60 + | 0.1% | **不动** |
| 缺模式字母（走引擎默认） | 59 + 8 | — | **不动**（续/等待是节奏，猜不得） |
| 字面量里嵌引号 / `%K17_RS("…/…")%` 一类嵌套参数 | 其余 | ~1.6% | **不动** |

⇒ 实测投影率 **98.0%**：形态集中，判据只需要三条。

#### 三条判据（`heartProjection`）

1. **实参必须是 `@"…"` 格式串**且字面量内不含 `"`。`@"…"` 在引擎里就是"展开 `%…%` 的字符串"
   ——语料实证参数里写的就是 `%CALLNAME:MASTER%`，所以文本走与 `PRINTFORM*` **同一把**
   `readableText`（代词/属性/行内条件都跟着反糖）。
2. **模式字母 ∈ `w`/`l`/`dw`/`dl`**（§3.9 表）。表外字母、缺第二段 → 整行不动。
   `l`/`dl` 在行尾补 ` 续`，与文本行的节奏标记同一套记号。
3. **调用式必须整齐**：逗号式不能带闭括号，括号式必须闭合。`CALLFORM HPH_PRINT` 一类派生形态
   不在表内（只认语料实证过的两种）。

**「」原样保留**（本批唯一一处"不照抄正向规则"的决定）：正向 `heartCall` 对台词会
`stripQuotesForHeart` 剥掉引号，而语料的引号**写在字面量里**、引擎就把它打印出来。
显示口径的第一职责是"读者看见的 == 游戏打印出来的"，所以**不加也不减**那对括号——
减了是篡改演出文本，加了是造一对游戏里不存在的括号。
这个不对称要记下来：**写回口径（`liftSuggest` / 自证）如果将来接 心形，必须重新定义引号规则**，
不能直接复用显示层的输出。

#### 读数（2,285 文件 / 3,598,297 行）

| 指标 | 批 J 后 | **批 K 后** |
|---|---|---|
| 演出行可投影率（新尺子） | — | **98.0%（65,903 / 67,282）** |
| 行覆盖 | 59.0% | **60.8%** |
| **段数（宿主 ViewZone）** | 332,614 | **289,542（−43,072，−13%）** |
| 台词 / 输出 / SIF / 函数头 / 状态赋值 | 99.2 / 99.2 / 93.3 / 81.2 / 26.0% | 逐字不变 |
| 不变量违例 | 0 | **0** |

段数一次性降 13% 是意外收获：演出行原先每行都切断糖段，现在并入前后台词成为连续段落——
**读感与性能同向**，这是"投影做对了"的形态学特征（做错的批通常表现为段数上涨）。

#### 真实已投影样本（履行 §5.67 定的"上线必须打印样本"纪律）

```
CALL HPH_PRINT,@"「嗯～满足满足HPH」","W"            →  心形 「嗯～满足满足HPH」
CALL HPH_PRINT,@"「呐%CALLNAME:MASTER%，我想去一个…  →  心形 「呐{你}，我想去一个安静的地方……HPH」
CALL HPH_PRINT,@" （讨厌……已经湿了……HPH　不行…      →  心形  （讨厌……已经湿了……HPH　不行，忍不住了HPH…）
CALL HPH_PRINT,@"「我现在就想在某个地方做……HPH　带   →  心形 「我现在就想在某个地方做……HPH　带我去好吗？」
```

未投影样本（判据故意挡下的）：`CALL HPH_PRINT,@"%LOCALS:LOCAL%"`（无模式）、
`CALL HPH_PRINT,"HPH"`（不是格式串）、`@"「%K17_RS("我来了/因为想见你就…")%…」","W"`（引号嵌套）。

#### 两个我自己的错（记录以免再来一次）

- 第一版 `HEART_RE` 写成 `\([ \t]*(.*)[ \t]\)`——**要求闭括号前有一个空白**，于是
  `HPH_PRINT(@"…","dl")` 全部落空。单测第一条就红了，说明"括号式也要测"不是废话。
- **探针样本截断骗了我一次**：源行只打印前 44 字符，把 `…HPH」","W"` 的模式段切掉了，
  我一度以为"无模式字母的行也投影了"。改用小段严格对齐（`区间行数 == 文本行数` 才配对）
  的第二版探针才给出可信对照。**打印样本时不要截断关键字段**，这是样本法的前提。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1420 passed / 11 skipped**（批 K +9 单测） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 语料投影守门 + 教学/归因/调用面/编码往返 | 6 文件全绿，**不变量违例 0** |
| `vite build`（app） | ✓ 24.1 s |
| 探针 | 三个（形态分布 / 参数分布 / 严格对齐样本）同批删除 |

#### 边界未做（明确记录）

- **写回口径未接 心形**：显示层与 `.kojo` 生成（`liftSuggest`）分离，且引号规则不同（见上）。
- `%K17_*%` 一类**函数调用 token** 原样显示——它们是别的作者包的引擎函数，
  糖里本没有对应写法；要可读化得先有"函数中文别名表"（L0 数据包职责）。
- 无模式字母的 59+ 行走引擎默认：要投影就得先实测 `HPH_PRINT` 的默认模式，属实机验证项。
- 下一根杠杆仍是**函数骨架合并**（`RETURN`/`CALL`/`LOCAL`），但它涉及"把代码藏起来"，
  需要先与用户定 UX 口径（绝不静默原则怎么满足）。**该口径已拍板 → ADR-0006**。

### 5.69 语法糖批 L · 规范 §3.8 扩「角色 N 的属性」写法（2026-10-12 批：v1.2 → v1.3）

**做了什么**：糖现在能写 `角色12的好感度`（→ `CFLAG:12:好感度`），反向也认它
（`CFLAG:1:好感度 += 50` 在糖视图里显示成 `角色1的好感度 += 50`）。同时兑现了 §3.8 里
**只写在规范上、实现从未落地**的那条承诺：`{角色12的名字}` → `%CALLNAME:12%`。

**为什么轮到语法层**：批 J 把剩余成因三分之后，最大一类不是代码问题而是**表层缺口**——
实测 108,968 次三段式变量引用里 **33.6%（36,601 次）是数字角色号作用面**，
而 v1.2 的语法对此无能为力（`她的X` 专指 `FAMILY:TARGET:X`）。用户 2026-10-12 拍板扩 §3.8。

#### 探针（第八次"先 dump 真实形态"：口径由读数定）

| 三段式作用域 | 引用次数 | 占比 | 处置 |
|---|---|---|---|
| `TARGET` / `MASTER` / `PLAYER` | 25,803 | 23.7% | 她的X / 你的X（`PLAYER` 是 `MASTER` 的引擎别名 → **你的X**，不新造代词） |
| **数字角色号**（`1` / `10` / `12`…） | 36,601 | **33.6%** | **本批新写法 `角色N的X`** |
| 动态角色作用域（`ARG` 878 / `LOCAL` 365 / `K69_CNUM` 650 / `X` 1,273…） | ≈2.4k + 长尾 | ~1.2%+ | **不提供写法**（作者写不出、读者也认不出是谁；要引用就用 `别名`） |

⇒ 边界由此定死：**数字必须是字面角色号**。`角色X的好感度`（X 是变量）在单测里钉住会报
`unknown-identifier`，而不是被猜成某个角色。

#### 三条实现要点

1. **正向**（`expression.ts`）：`matchRoleAttribute` 排在属性分支之前，要求 `角色` 前不粘标识符、
   后面是**纯数字**、数字后必须是 `的`；属性名仍走 L0 查表（`resolveFamily`），
   查不到 → 报 `unknown-identifier`（不静默造名）。
2. **`名字` 特例**：`CALLNAME` / `NAME` **以角色号为索引**，不存在"名字的索引"。
   顺手修掉一个既有缺陷：`{她的名字}` 此前产出 `%CALLNAME:TARGET:名字%`（1D 数组的越界写法，
   引擎不认）→ 现在产出 `%CALLNAME:TARGET%`；对应地 `{角色12的名字}` → `%CALLNAME:12%` 首次真正可用。
3. **反向**（`project.ts`）：把批 J 那个"只吃第一段"的表达式正则换成**一次吃全 1～2 段**，
   判定收拢到唯一的 `segmentsToSugar`，**插值通道与表达式通道共用同一套判据**——
   批 J 假阳性的根因就是两条通道各写一套规则（§5.67 的第二刀）。
   `sugarForRefParts` 随之下线，判据点从两个变成一个。

#### 顺带拆掉一颗地雷（不在本批范围内，但必须记）

`packages/plugin-api/tests/sugar.test.ts` 的 golden 断言原先按**行号区间**从规范里抽代码块
（`specSlice(735, 753)`）。本批给 §3.8 增补十几行，四个 golden 断言立刻整片红——
**golden 是内容契约，不是行号契约**。改为按 `### 6.1` 标题 + 其后第 N 个围栏锚定
（`specCodeBlock(/^### 6\.1 /, 0)`），逐字节断言原样保留。这与 §5.64 记的那次
"锚点匹配到更早的同名标题、删掉 2,935 行"是同一类事故，只是这次是测试先替我挡下。

#### 读数（2,285 文件 / 3,598,297 行）

| 指标 | 批 K 后 | **批 L 后** |
|---|---|---|
| 状态赋值可读率 | 26.0%（5,344 / 20,532） | **54.8%（11,255）** |
| 行覆盖 | 60.8% | **61.0%** |
| 段数 | 289,542 | **287,805** |
| 台词 / 输出 / SIF / 函数头 / 演出 | 99.2 / 99.2 / 93.3 / 81.2 / 98.0% | **逐字不变**（条件里的文本变长，投影与否不变） |
| 不变量违例 | 0 | **0** |

**批 J 当时估的"天花板 ≈ 41%"低估了**：实测 54.8%。原因是我把"数字索引但字典查不到名"和
"其它角色号作用面"混在一起估，而后者里有相当比例的角色号引用其实查得到名字。
推算落点只是**参考下限**，不是承诺——这句要留在记录里。

第五把尺子下限随之上移 **0.2 → 0.4**（撤批 L → 26.0% 红；撤批 J → 0 红；字典接线掉断 → 红）。

#### 真实已投影样本（完整不截断）

```
CFLAG:1:好感度 += 50            →  角色1的好感度 += 50
CFLAG:1:眠姦口上有 = 1          →  角色1的眠姦口上有 = 1
IF GET_MAPID(CFLAG:MASTER:300) == 0 && (CFLAG:1:300 == 3)
  → 如果 GET_MAPID(你的現在位置) == 0 && (角色1的現在位置 == 3)：
```

第三条是本批最想看见的形态：同一个条件里 `你的` / `角色1的` / 引擎函数调用三者共存，判据互不干扰。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1426 passed / 11 skipped** |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| golden（§6.1/§6.2 逐字节）+ 教学语料 + 归因/调用面/编码往返 | 全绿，**产物逐字节零回退** |
| 语料投影守门（全量 2,285 文件） | 上表读数，不变量违例 0 |
| 探针 | 三个（作用域分布 / 三段式分类 / 真实样本）同批删除 |

#### 边界未做（明确记录）

- **动态角色作用域不提供写法**（`ARG`/`LOCAL`/角色号变量，实测 ~1.2% + 长尾）。要覆盖它得先有
  "作用域变量 → 角色"的运行期知识，属状态回放域，不属语法层。
- `TEQUIP:4 = 1` 这类**数字索引但字典无名**的行仍未标（L0 数据包缺口，投影层不编名字）。
- `角色N的X` 的**补全候选**没做（靠解析而非词表）；要不要按角色号列候选属编辑器体验批。
- 写回口径（`liftSuggest`）仍不接时机/赋值/心形/角色属性——显示层与写回层的分工没变。

### 5.70 抽取按文件增量批 · 作者改一个 ERB 不再重算全库（2026-10-12 批）

> **触发**：§5.58/§5.65 把抽取整包缓存之后，真实工作流里几乎不省时间——作者天天改的就是
> 那几个文件，而快照的判据是**整项目 ERB 指纹** ⇒ 任一文件变 ⇒ 整包作废 ⇒ 每次开项目重付
> 4~7 s。本批把判据拆成两层，让"改一个文件"只重算那一个文件。
>
> 分支 `feat/extract-per-file-2026-10-12`（基点 = origin/master `10e5c27`）。
> **编号让位（本组第三次，同一根因）**：本批写作 §5.66，落地前 `git fetch` 复核发现语法糖线
> 已连占 §5.65–§5.69（批 I–L + 中文标识线）⇒ 本批让位到 **§5.70**。已公开编号不动；
> 收敛做法与 §5.65 头注一致：**提交前最后一次 fetch 复核号，把让位当作 rebase 的常规动作**。

#### 一、判据拆层：全局四项 + 逐文件 mtime

| 层 | 判据 | 不符的代价 |
|---|---|---|
| 全局 | 项目根 / `adapterId` / `inputDigest` / `EXTRACT_SNAPSHOT_FORMAT` | 整包弃用（删除 + 全量） |
| 逐文件 | 桶里的 `mtimeMs` vs `ErbIndex.fileMtimes`（任一侧 `null` ⇒ 该文件永不复用） | **只重算那一个文件** |

关键动作是**从全局判据里拿掉整项目 ERB 指纹**——它正是"改一个 → 全库作废"的放大器；
ERB 正文的变化现在完全由逐文件 mtime 负责。`inputDigest` 留在全局层（§5.58 那条 CSV 教训
不变：变量语义标签来自游戏 CSV，它变了整包必须作废）。

契约 additive 一项：`ErbIndex.fileMtimes?: ReadonlyMap<string, number|null>`。
erb-parser **顺手**产出（复用文件取快照里的 mtime、重扫文件取 `readText` 的 mtime），
零额外 stat——判据不另 IO 是这个项目派生缓存的既定口径。

#### 二、桶形态与五条口径

`FileBucket = { mtimeMs, stats(五项可加), conds[] }`，编码沿用 §5.65 的位置元组 +
包级 `schemas` 去重字典（`EXTRACT_SNAPSHOT_FORMAT` 2 → 3，存储键仍是固定槽位
`extract-snapshot-v1`，版本在 payload 里 ⇒ 换格式时旧文件读出即判死并被覆盖，不留孤儿）。

1. **整桶替换**，不是按函数合并：重算某文件的新桶含该文件当前全部函数，旧桶整体让位。
   按函数合并会让作者**删掉的函数复活**——这条语义在 `mergeBuckets` 的测试里钉住。
2. **全量与增量共用同一份合并代码**（`mergeBuckets` 按本次 walk 顺序拼复用桶与新算桶），
   与索引段 `aggregateIndex` 同源纪律；否则两条路径迟早分叉。
3. **只在真算过东西时回写**：全命中再刷一遍 12 MB 是纯浪费（序列化 + 磁盘）。
4. **读/扫失败不留桶**（坏一次不能永久缓存坏结果），但**空骨架要留空桶**
   （否则这个文件每次开项目都被判"没缓存"而白读白扫一遍）。
5. **磁盘上消失的文件天然收尸**：它不在本次 walk 顺序里 ⇒ 不进新快照，快照不会越攒越大。

`planReuse` / `mergeBuckets` 都是纯函数，全部行为单测覆盖；引擎只懂"有判据就把能复用的桶
拿来"，键、存储、fail-closed 留在插件端口——引擎依旧游戏无关。

#### 三、实测（真实语料 2,285 ERB / 99,104 函数 / 493,712 谓词 / 164,910 依赖）

四个**独立 kernel 共用同一 appData**（纪律④），水位从 `project.open` 起算：

| 阶段 | 索引可用 | 条件可用 | 抽取段（差值） | 校验可用 | 复用 / 重算 |
|---|---|---|---|---|---|
| cold 首次 | 2157 ms | 9357 ms | **7200 ms** | 9364 ms | 0 / 2285 |
| hot 未改动 | 419 ms | 1084 ms | 665 ms | 1085 ms | 2285 / 0 |
| **touch 改 1 个文件** | 416 ms | 465 ms | **49 ms** | 6508 ms | 2284 / 1 |
| after 再开一次 | 391 ms | 1115 ms | 724 ms | 1116 ms | 2285 / 0 |

- **靶心**：改一个 ERB 的抽取段 **7200 ms → 49 ms**（v2 口径下同一动作要重付整包）。
- `after` 复现全命中 ⇒ touch 那轮的新桶确实持久化了（不是每轮重算一次就算了）。
- **等价性不止统计**：四轮 `byFunction` 顺序指纹 `1c85ae8c0e1256`、**全量内容指纹**
  `0c357d324fd294`（逐条覆盖 44,339 个函数的路径/行号/谓词数/降级数/每条依赖的键、次数、
  首行与 `schema.description`）、schema 标注数 109,742 —— 三项在 cold（全量）与
  hot/touch/after（增量还原）之间逐项相同。只看 `stats` 是不够的：语义标签丢了统计看不出来。
- 磁盘：抽取快照 **12.31 MB**（v2 12.47 → v3 12.31；桶化多出的每文件 mtime + 五项统计
  基本被"去掉整项目指纹"抵消），三段合计 ≈ 24.7 MB/项目且各封顶一份。
- touch 只动目标文件的 **mtime**（`utimes +2000ms`），内容与字节零改动、跑完还原；
  **探针绝不写真实语料**。事后核对 `stat` = 原始 mtime，语料无残留。

#### 四、探针把两处口径纠正过来（已同步进 HANDOFF §八）

1. **fire-and-forget 落盘会被探针截断**：`save()` 不阻塞级联是对的，但探针进程随即退出 ⇒
   12.31 MB 只写了 3/4 MB 的 `.tmp` 孤儿、正式文件从未 rename 出来 ⇒ 下一轮"什么都没读到"，
   量出"快照没用"的假结论。判据：原子写以 rename 收尾 ⇒ **轮询"快照 mtime 比进入本轮时新"**
   才算落盘完成；全命中那轮不该有回写，则反向断言 mtime 未变。
2. **`durationMs` 不含快照读盘**：引擎的 `t0` 在 `load` 之后，还原 12 MB 那 ~0.7 s 不在自计里。
   而级联由 `project.opened` 自动催动、显式 `ensureIndex()` 只是汇合在途 Promise ⇒
   量"抽取多少毫秒"必须**从 `open` 起算差值**。差点把"抽取 15ms"当成结论报出去。

顺带：夹具里 `erbIndex` 的文件清单必须由本次 mtime 键**推导**（原来硬编码 `[A, B]`），
否则"新文件出现 / 消失文件收尸"两类用例根本走不到真路径——本批就是这么红了两次才发现的。

#### 五、测试

- `tests/snapshot.test.ts` 17 项：往返等价（路径/归一化名/mtime/逐文件统计）、schema 去重、
  `null` mtime 原样往返、体积不劣化、字段清单哨兵、全局判据四项 fail-closed、
  结构损坏五形态、`planReuse` 五类（全命中 / 改一个 / 新增 / 消失 / mtime 缺失）、
  `mergeBuckets` 整桶替换与缺桶跳过。
- `tests/engine-snapshot.test.ts` 11 项：首次全算并落盘、全命中零读盘**且不回写**、
  改一个只算一个、新文件只算新的 + 消失文件不进快照、索引不带 `fileMtimes` ⇒ 保守全算、
  判据对象原样递给 `load`/`save`、判据不全不读不写、读失败不留桶、并发只算一次、
  无快照端口时行为不变。
- 三绿：vitest 全量 1376 passed / 11 skipped；root + app typecheck 干净；解耦审计四项通过。

#### 六、边界未做（下批候选，按收益排序）

- **校验段仍是整项目判据**：改一个文件重付 **5.99 s**，现在它才是级联的大头（本批后
  抽取段已不是瓶颈）。要么按文件切规则，要么让规则声明"我看得到哪些输入"。
- 热路径地板是快照读盘 + parse ≈ 0.7 s；再往下砍要**按桶分段解码**（只解码变过的文件），
  代价是格式要能分段——收益 0.7 s，先不做。
- `extractFunctionConditions` 仍在主线程算（只是几乎不用算了）；上并行通道的前置条件不变：
  `VariableSchema` 导出原始表（路线文档 §三 L1）。
- `.tmp` 孤儿只在"进程被截断"时产生，一次一个，现有清理只认快照形态的键（不越权删别人的东西），
  暂不专门扫点文件；若实测积累再收口。

### 5.71 语法糖批 M · 骨架折叠**前提被实测否证**，不做（2026-10-12 批：一条负结果记录）

> **编号让位（第五次，同一根因）**：本批写作 §5.70，落地前 `git fetch` 复核发现抽取增量批已占 §5.70，
  rebase 时顺延为 **§5.71**（口径与 §5.65/§5.66 那两次相同：让先落地者保留号，冲突在 rebase 里解决）。

**结论先说**：ADR-0006 拍板了"怎么折"（默认收起 + 可展开原文），本批去实施前先量了一下
**值不值得折**——答案是**不值得**：按串折叠在全语料只能收起 **374 行**（占未投影行的 0.1%）。
于是**没有实施**：契约字段、宿主交互、偏好开关一律没进仓库，本批只留这条负结果与判据。
写代码的成本低于写一个没人用的开关，但**留着"已经做了折叠"的假印象成本更高**，所以记下来。

#### 测的是什么（口上域 2,317 文件 / 3,621,150 行）

ADR-0006 的动机表说未投影榜首是 `RETURN` 16.7 万 / `LOCAL` 5.4 万 / 非 HPH 的 `CALL` 6 万——
"骨架是最大剩余杠杆"。但这张表只说了**有多少行**，没说**它们是怎么排布的**。
折叠要起作用，前提是这些行**连成串**（一串换成一行占位才省视野）。实测排布：

| 判据 | 串长 1 | 串长 2 | 串长 3 | 串长 4 | 5–7 | 8+ | ≥3 可折总行 |
|---|---|---|---|---|---|---|---|
| 严格（`LOCAL`/`LOCALS` 无调用赋值 + `RETURN`） | **294,772** | 355 | 26 | 45 | 16 | 3 | **377 行** |
| 放宽（任何非角色族赋值 + `RETURN`，仍不许调用） | 271,728 | 70,156 | 2,842 | 375 | 222 | 51 | ≈12.9k 行 |

⇒ **骨架不是一个一个"块"，而是一行一行夹在台词中间**。真实口上的写法是
`LOCAL = …` / `CFLAG:TARGET:… = …` / `PRINTFORMW …` / `SIF …` 交替进行——
29 万条"串"的长度是 1。长度 1 的串折叠**没有任何收益**：藏一行、加一行占位，视野不变，
还多了一个可点的东西骗读者。放宽判据也只到 12.9k 行（0.36%），代价是把
"什么算无副作用"的判定权从封闭白名单交给一条越来越宽的启发式——正是 ADR 里禁止的那种滑坡。

顺带一条同批测到的数：全量语料跑一遍投影，折叠实现只产出 **89 个折叠段**（0.0006 段/行）。

#### 所以真正的剩余问题是什么（把杠杆重新指对）

剩余 39% 未投影行**不能靠"藏"来解决**，因为它们是**逐行交错**的。可选的真方向只有两类：

1. **继续翻译**（把夹在中间的那行变成人话）——本组已经在做的是这条路：
   批 F/G/H/I/J/K/L 每批都是一种"夹行"的翻译。剩下成规模 Yet 有糖写法可套的：
   `SETCOLOR` 未配对的 17,713 行（§3.9 的 `着色 …：` 块，**但要先实测未配对行的语义**：
   分发器收尾的 `RESETCOLOR` 覆盖性是 §9 第 5 条待实机项）、
   `DATAFORM`/`ENDDATA` 17,734 + 3,532 行（`PRINTDATA` 数据表 → 糖的 `随机`/`选项` 族读法）、
   `CASE` 3,502 行（`是 …：` 已有糖写法，只是块内正文夹着的 CASE 未接）。
2. **改变排版权重**（不藏，但让夹行的代码在视觉上退到背景）——
   现在原生行已经是"源码色"（等宽/偏灰），进一步能做的比如**行宽/透明度分级**，
   那属宿主体验，不属于投影，也不该由我在这批顺手做。

⇒ **下一批的首选改为"继续翻译"**，顺序按上面的实测行数排：先 `DATAFORM` 数据表、再 `SETCOLOR` 未配对、
再 `CASE` 内正文。三个都要**先探针后定语义**（本项目第七、八次同一条纪律）。

#### 本批产出清单（负结果也要留下可复用的东西）

| 产出 | 落点 |
|---|---|
| 折叠串长分布的实测数 | 本节 + `docs/LIFT-REMEASURE-2026-10-12.md` 十一（续七） |
| "ADR-0006 的实施前提不成立" | `docs/adr/0006-sugar-view-code-folding.md` 顶部**状态降级**为「已接受，但因实测否证而搁置」，并把"折叠要先量串长"写进决策第 0 条 |
| 一次**没有落地**的实现 | 折叠的投影/契约/宿主/测试代码全部**回退**（`git checkout`），仓库不留半成品；回退过程见下"实施到一半的东西" |
| 一条纪律 | **动机表里的"多少行"必须配一张"怎么排布"的分布表**——否则会把逐行交错的问题误当成成块可折的问题 |

#### 实施到一半的东西（为什么能安全回退）

我先按 ADR 写了投影侧（`LineRec.fold` / `planFolds` / 折叠段占位）+ 契约
（`SugarProjectSegment.folded` / `SugarProjectStats.foldedLines`）+ 宿主不动的一行过滤
（**在展开交互做出来之前不让任何东西真的被藏**）+ 9 条单测 + 守门的折叠审计。
跑全量语料时守门**没有红**、但读数就是那 374 行——**读数一坏，方案就该扔，而不是把判据放宽凑数**。
六个文件整批 `git checkout --` 回退，回退后复跑 `vitest run packages/plugins/kojo-sugar`
= **389 passed**（与批 L 收口时逐字相同），契约零改动，`git status` 干净。

守门口径**没有**新增第七把尺子：折叠不做，就不该留一把恒为 0 的尺子占位置。

### 5.72 校验按文件增量批 · 规则自己声明计算粒度（2026-10-12 批）

> **触发**：§5.70 把抽取段压到 49 ms 之后，级联里**唯一**还在"改一个文件重算全库"的就是校验段——
> 同一次 touch 实测 6043 ms。而校验的产出只有 793 条 / 0.4 MB，是全库正文扫描换的。
>
> 分支 `feat/lint-per-file-2026-10-12`，两个提交：逐规则计时（先测量）→ 三层判据 + 逐文件桶。
> **编号让位（本组第四次）**：本批写作 §5.71，提交前 `git fetch` 见语法糖线批 M 已占 ⇒ 让位到 **§5.72**。

#### 一、先测量：逐规则计时把切法直接读出来

真实语料（2,285 ERB / 793 项）单跑校验段，逐规则耗时（`engine.ts` 的 `lint breakdown` 行，常驻）：

| 规则 | 耗时 | 产出 | 判定依据 |
|---|---|---|---|
| `eratw.form-triple-symbol` | **2008 ms** | 8 项 | **只看该文件正文** |
| `eratw.kojo-call-slot-coverage` | 579 ms | 36 项 | 该文件函数签名 + **路由表**（来自 KOJO_MESSAGE.ERB） |
| `eratw.messagecheck-structure` | 395 ms | 2 项 | **只看该文件**函数表 + 正文 |
| `eratw.kx-placeholder` | 330 ms | 603 项 | 按**归一化函数名**跨文件聚合「共 N 处」 |
| `eratw.kojo-completeness` | 294 ms | 141 项 | 按**角色**跨文件聚合面集合 |
| `erb.duplicate-function` | 3 ms | 3 项 | 跨文件同名 |
| `sugar.static-conventions` | 1 ms | 0 项 | 跨文件 |

两条结论把设计定了：

1. **一条纯逐文件规则占 55% 的成本，却只产出 8 项**——"改一个文件重扫全库正文"就是白付；
2. **冷跑与热跑几乎同速**（3629 vs 3471 ms）⇒ 成本是**正则扫正文的 CPU，不是 IO**。
   所以缓存文件正文没有用，必须缓存**逐文件的判定结果**。

#### 二、契约加"计算粒度"：规则自己声明，引擎不猜

`ConventionRule` 新增 additive 两项：`scope?: 'project' | 'file'`（缺省 `'project'`，
即改造前的行为）与 `checkFile(ctx, file)`。

**为什么做成声明而不是让引擎推断**：这是语义承诺，静态检查证明不了。判错方向的代价不是变慢，
而是**悄悄吐出过期结论**——所以契约注释里写死了违约后果，并要求改判 `scope` 必须配等价性测试
（本批的等价性测试在 `engine.test.ts`「增量装配与全量重算同值同序」+ `conventions.test.ts`
的 `runFileRule` 聚合，语料级证据见下面第四节）。

| 规则 | 本批判定 | 理由 |
|---|---|---|
| `form-triple-symbol`、`messagecheck-structure` | **改判 `file`** | 只看该文件正文 + 该文件函数表，issue key 不含别处信息 |
| `kojo-call-slot-coverage` | **留在 `project`** | 结论同时取决于**路由表**（解析自 KOJO_MESSAGE.ERB）。按文件复用桶 ⇒ "只改路由表"会让其它文件吐过期结论。这是真实的判据缺口，解法见第五节 |
| `kx-placeholder`、`kojo-completeness`、内置两条 | 留在 `project` | 天然跨文件聚合（按名 / 按角色） |

顺带把并发从规则内部**上收到引擎**（`LINT_FILE_CONCURRENCY = 12`，沿用原口径）：
桶归引擎持有，规则只描述"一个文件怎么判"，adapter 侧的 `mapLimit` 随之删除。

#### 三、三层判据：两个指纹必须分开存

| 层 | 判据（盘上字段） | 不符的代价 |
|---|---|---|
| 全局 | 项目根 / `adapterId` / `expectFingerprint`（= `inputDigest` + `LINT_SNAPSHOT_FORMAT` + 规则清单摘要） | 整包弃用 |
| 整项目 | `erbFingerprint`（= `ErbIndex.fingerprint`） | **只重算 `scope:'project'` 的规则** |
| 逐文件 | 桶 `mtimeMs` vs `ErbIndex.fileMtimes`（任一侧 `null` ⇒ 该文件不复用） | **只重算那一个文件** |

- **v1 把这三层合成一个 `fingerprint`**，正是"改一个文件 → 整包作废"的根因；
  v2 里 `expectFingerprint` 与 `erbFingerprint` 是**两个字段**，各判各的层
  （§5.70 的同一课，这次落在校验段）。
- `rulesDigest` 现在把 **`scope` 也折进去**：一条规则从 `project` 改判成 `file` 改变的是
  缓存语义，摘要不变却继续复用旧桶就会把跨文件结论当逐文件结论用。
- **空桶要存**：这个文件判过了、没问题 ⇒ `[mtime]`（省略 issues 槽）；不存就等于每次开项目
  白读白扫一遍。
- **坏一次不永久缓存**：抛错的规则不写 `projectResults`，抛错的文件不留桶
  （取代 v1"整报告带 `failedRules` 就拒绝命中"——粒度到桶，不必整包连坐）。
- **读失败从"静默跳过"改成"抛错"**：v1 里 IO 失败 = 这个文件这次没结论，且会被缓存成"干净"；
  现在显式进 `failedRules` 并下次重算。
- **消失文件天然收尸**、**全命中不回写**：与 §5.70 同口径。
- `LINT_SNAPSHOT_FORMAT` 1 → 2，存储键仍是固定槽位 `lint-report-v1`（旧快照读出即判死并被覆盖）。

#### 四、实测（真实语料，四个独立 kernel 共用同一 appData）

| 阶段 | 索引可用 | 条件可用 | 校验可用 | 校验自计 | 逐文件重算 | 快照回写 |
|---|---|---|---|---|---|---|
| cold 首次 | 2271 ms | 9988 ms | 10053 ms | 5754 ms | 4570 个文件 | +0 ms / 1371 KB |
| hot 未改动 | 599 ms | 957 ms | 975 ms | **67 ms** | 0 | **不回写** |
| **touch 改 1 个文件** | 713 ms | 2505 ms | **2564 ms** | **1198 ms** | 2 个文件（1 文件 × 2 规则） | +0 ms / 1371 KB |
| after 再开一次 | 631 ms | 977 ms | 996 ms | 59 ms | 0 | **不回写** |

- **靶心**：改一个 ERB 的校验计算 **5754 ms → 1198 ms**（其中逐文件部分只剩 **8 ms**，
  其余 1.1 s 是三条跨文件规则的**必付成本**）；端到端「改一个文件后重开」的校验水位
  **6508 ms → 2564 ms**（§5.70 那批的同一读数）。
- touch 的 breakdown：`form-triple-symbol 5ms/8项 · messagecheck 3ms/2项`（复用 2,283 个文件的桶）
  对比 `kx 266ms · completeness 248ms · call-slot 508ms`（整项目重算）——**切对了就是这两行**。
- `after` 复现全命中 ⇒ touch 的新桶确实持久化了。
- **等价性**：四轮 793 项、分规则条数逐项一致（603 / 141 / 36 / 8 / 3 / 2）、`failedRules` 恒 0；
  快照还原的 issue 对象（severity / message / key）与全量计算逐字相同。
- **代价讲明白**：全命中从 v1 的"整块还原 ~1 ms"变成"读 1.37 MB + 装配 ≈ 60 ms"，
  换来的是改一个文件不再重付 4.5 s；磁盘 440 KB → 1371 KB（每个文件每条逐文件规则要留一行 mtime 记录）。

#### 五、测试（净增 8 项，全部落在引擎侧）

- `convention-linter/tests/snapshot.test.ts`（12 项，整组重写）：三层编解码往返（含空桶与 `null` mtime）、
  **空结论桶编成 `[mtime]` 单元素元组**、`erbFingerprint` **不是**全局判据（它变了 decode 仍成功——
  两层独立这条设计的直接断言）、全局判据四项 fail-closed、结构损坏六种形态、
  `rulesDigest` 含 `scope`（同 id/级别/描述但改判 scope ⇒ 摘要变）、`lintExpect` 缺 `inputDigest`/空规则集 ⇒ null。
- `convention-linter/tests/engine.test.ts` 的「分层复用」组（6 → 14 项，本批全部净增都在这里）：三层全命中 ⇒ 零读盘零调用
  **且不回写**、改一个 mtime ⇒ 只算那一个文件、**两层判据互不牵连**（ERB 指纹变了但 mtime 没变 ⇒
  桶仍命中、只重算跨文件规则）、缺 `fingerprint` ⇒ 整项目层不复用而逐文件层照用、缺 `fileMtimes` ⇒ 全重算、
  `null` mtime 不当命中、消失文件收尸、抛错文件不留桶、抛错规则不写 `projectResults`、
  `scope:'file'` 缺 `checkFile` ⇒ 显式 `failedRules`（不是静默 0 条）、
  **增量装配与全量重算同值同序**、`force` 绕开缓存但仍回存、`inFlight` 去重。
- adapter 侧 `conventions.test.ts`（14 项，数量不变）：两条改判 `file` 的规则通过 `runFileRule`
  （遍历 `index.files` 调 `checkFile` 再拼接，**与引擎装配同构**）保持原断言口径——
  这就是"改判 scope 必须配等价性测试"的落点。
- 三绿：vitest 全量 **1440 passed / 11 skipped**；root + app typecheck 干净；解耦审计 A–D 通过。

#### 六、边界未做（下批候选，按收益排序）

- **跨文件规则那 1.1 s 是本批下限**。两个方向：
  ① **按角色分组判据**（`kx` / `completeness` / `call-slot` 都可按角色号切桶，判据 = 该角色
  文件集合的 mtime 折叠）——但要引入"分组"这层新概念，先探针量清分布再动（§5.71 的教训：
  没有分布表就立项，容易把逐行交错的问题当成分块可 cut 的问题）；
  ② **`parseKojoFamily` 加 memo**：同一个函数名一次运行内被解析 3–6 次（`kx` 里就调三次），
  这是那 1.1 s 的构成主体。属"把必付成本做小"，与缓存无关，可独立立项。
- **`call-slot-coverage` 的判据缺口**：它需要一条"规则级额外判据"通道
  （形如 `inputsDigest?(ctx)`，与桶一起存、变了就整条规则弃桶）。本批的处理是**保守留在
  `project`**——宁可慢，不拿不确定的判据换命中（纪律①）。
- 逐文件规则的**读失败**现在会让 `failedRules` 非空并显示在面板上（以前静默跳过）。
  若真实环境里偶发 IO 抖动，面板会出现"某规则部分文件未判"的显式提示——这是有意的口径变化。

### 5.73 名称解析 memo 批 · 把跨文件规则的必付成本做小（2026-10-12 批）

> **触发**：§5.72 之后"改一个 ERB 后重开"里最大的单块，是三条 `scope:'project'` 规则的重算
> （实测 1022ms / 校验自计 1198ms）。那部分是**必付**的——分桶消不掉它，只能把它做小。
>
> 分支 `feat/family-memo-2026-10-12`。承 §5.71 那条负结果的纪律：**先要一张分布表**，
> 表立不住就不动手。

#### 一、分布表（量出来的，不是推出来的）

`kojoFamilyMemoStats()` 在真实语料上跑一遍 `force` 全量校验，读数：

| 读数 | 值 |
|---|---|
| 一次校验的名称解析请求 | **397,622 次** |
| 其中未命中（= 去重名数） | 99,101 |
| 其中命中（= 重复劳动） | **298,521（75%）** |
| 解析一遍 99,101 个去重名 | 265 ms |
| 同样遍历一遍但走 memo（只付 `Map.get`） | 8 ms |
| 按单次 2.2 µs 折算 397,622 次 | ≈ 880 ms ⇒ memo 理论上限省 ≈ 600 ms |

原因很直白：四条规则各自扫一遍全库——`kx-placeholder` / `kojo-completeness` 扫 `byName` 的
每个 ref，`messagecheck-structure` / `kojo-call-slot-coverage` 扫每个函数 ⇒ **平均每个名字被解析 4 次**。

**这里翻过一次车**：先前按 `kx` 的代码路径（`find` + 命中后再一次 + `filter`）推它是 3×/名字，
得出"594,621 次调用"——**推错了**：`find` 在无命中时就短路，而绝大多数名字无命中。
修正后的读数是 397,622。**结论：调用次数要量，不要从代码路径推**（已进 HANDOFF §八）。

#### 二、实现：纯函数 + 冻结 + 随项目清空

- `parseKojoFamily`（对外入口）套一层「名字 → 结果」memo；原实现改名 `parseKojoFamilyRaw`，
  **一行判定逻辑都没改**。
- **`make()` 一律 `Object.freeze`**：memo 缓存的是**共享实例**，"结果不可变"是它的**前提**而不是优化——
  被缓存的结果若能被调用方改写，就会把 A 的判定漏进 B。冻结在 ESM 严格模式下让改写直接抛错。
  审计过全部调用点（`conventions.ts` 五处、`ui-kojo-navigator/tree.ts` 两处、`createEratwFamilyIndex.match`）
  均为只读，唯一的两处赋值（`kojo-sugar/parser.ts:216`、`chara-csv.ts:42`）改的是
  `SugarFrontMatter` 与 CSV 行对象，**不是** `FamilyMatch`。
- **`null` 也进 memo**：非口生命名的函数（引擎助手、AA 工具）同样占大量调用，每次重跑 regex 链
  正是本批要消掉的成本。
- **满了整表清空，不做 LRU**：名字集是"全库一遍"的形态，逐条淘汰只会让下一遍重新解析。
- **随 `project.closed` 清空**（adapter 内挂总线）：内核 `open()` 会先 `close()` 旧项目并广播该事件，
  所以只挂 `closed` 就覆盖切项目路径；首次开项目表本来就是空的。
- 暴露 `createKojoFamilyMemo(limit)` 工厂 ⇒ 上限行为可在测试里用小 limit 验，不必造 20 万个名字。

#### 三、实测（同一台机器、同一语料、同一探针，只多这一处改动）

| 阶段 | §5.72 校验自计 | 本批校验自计 | 分规则变化（touch） |
|---|---|---|---|
| cold 全量 | 5754 ms | **5125 ms** | 完整性 292→45 · 槽覆盖 589→275 · messagecheck 356→147 · kx 330→422 |
| hot 未改动 | 67 ms | 61 ms | 全部 `(复用)`，memo 不在热路径上 |
| **touch 改 1 个文件** | **1198 ms** | **746 ms** | 完整性 248→**36** · 槽覆盖 508→**231** · kx 266→**387** · form 8→5 |
| after 再开 | 59 ms | 40 ms | 全 `(复用)` |

- 端到端"改一个文件后重开"的校验水位：**2564 ms → 2056 ms**。
- **`kx` 反而涨了**（266→387ms）——不是回归，是**成本搬移**：冷解析那一遍（265ms）现在由
  第一个扫全库的规则替全场付掉，而 `kx` 就是执行顺序里的第一个。后面三条因此才会掉到 36/275/147ms。
- 452ms 的实测降幅与"理论上限 ≈600ms"一致，差额是各规则自身的聚合工作（memo 碰不到）。
- **正确性**：793 项、分规则条数（603/141/36/8/3/2）与 §5.72 逐项一致，`failedRules` 恒 0；
  名称 memo 不改变任何判定，这一点由"金名表跑两遍逐字段一致"钉住。

#### 四、内存代价（讲明白，不藏）

99,101 个条目在 gc 后 ≈ **15.6 MB**（用与 `make()` 同形状的对象在 `Map` 里存满这个规模量得），
`Object.freeze` 的额外内存为 0、CPU +4 ms/99k（12 ms vs 8 ms）。随 `project.closed` 清空 ⇒
不跨项目累积。相对打开真实项目后的堆占用（实测 370 MB 量级），这是 ~4% 的代价换 452 ms。

#### 五、测试（+8 项）

`family-index.test.ts` 新增「名称解析 memo」组 8 项：金名表（10 个覆盖各形态的真实名）跑两遍
逐字段一致 · 同一名字二次调用返回**同一实例** · 不同名字各占一条目（不会并成一个） ·
返回值 `Object.isFrozen` 且改写尝试抛错、抛错后缓存值没被带跑 · `null` 也进 memo ·
到上限**整表清空**（用小 limit 的独立 memo 验，命中不涨条目） · `clearKojoFamilyMemo()` 后
判定不变但实例是新的 · `functionFamilyIndex.match()` 与 `parseKojoFamily` 走同一个 memo 入口。

#### 六、边界未做（下批候选，按收益排序）

- **`kojo-call-slot-coverage` 剩 231 ms**：它的热成本已从"解析名字"转移到 `maxForwardedSlotsFor(name)`
  ——那同样是**每个名字一个纯函数**，可以挂在协议实例上的 Map 里（协议重建即天然失效）。
  这是本批思路的自然延伸，且不需要新的缓存语义。
- **按角色分组判据**（`kx` / `completeness` 按角色号切桶）：能把 touch 的跨文件重算进一步压成
  "只重算那个角色"。要先量一张分布表——每个角色的函数数、一次改动波及几个角色（§5.71 的教训）。
- 名称 memo 的**上限触发**（20 万条）在真实语料上不会碰到；如果哪天用户的库里函数名超过约 13 万
  且跨两个项目交替打开，才会走到整表清空分支。

### 5.74 回放线重测批 · 真实存档复测 + 金样本两处假绿面封堵（2026-10-12 批：§5 / §6 逐字复现）

> **编号让位（同一根因第七次）**：本小节初写为 §5.72，`git push` 前发现远端已被**校验按文件增量批**占去
> §5.72、**名称解析 memo 批**占去 §5.73 ⇒ 按本仓既定口径「先落地者保留号」，本小节顺延 **§5.74**；
> 同批把 `HANDOFF` §二/§五、`BASELINES` §4/§5/§6 的交叉引用一起改到 §5.74。
> 提交信息里的旧号（`ed75c05` 写的是 §5.72）**不回改**——本行即映射。

> 触发：kojo-editor 对社区唯一的差异化能力是「sav 快照 → 状态回放」（`ARCHITECTURE` §1.3 / §5.3 / §5.5）。
> 但 2026-10-12 一天之内语法糖线与性能线合计改了 `erb-parser` / `condition-extractor` /
> `sav-parser` 缓存与求值路径，而 §5.64 合流的验收线**只守了"糖投影读数逐字相同"**——
> **回放线一次都没有重测**。更糟的是本机语料**一份存档都没有**（`sav/` 不存在），于是
> `sav-parser/tests/golden-roundtrip.test.ts`（六档字节级金样本）与
> `integration-plugins.test.ts` 的「存档解析 → 状态回放 → 注入写链路」长期处于 skipped，
> `BASELINES` §5 / §6 只是一组**没有实机证据的历史数字**。

#### 阶段一：只读勘察结论（方案对比后定案，未动任何盘）

| 勘察项 | 实测 | 影响 |
|---|---|---|
| 引擎 | `Emuera_LazyLoadingV3.0_x64/x86.exe`；FileVersion `1.824.0.0`；ProductVersion `1.824+v22+EMv18+EEv53 Lazyloadingv3.0 NAudio` → eraTW **v22 系**、**LazyLoading 分支而非 SKIA v15** | §5.5「官方 v22 与 SKIA v15 通吃」的 v22 侧得到实物确认；SKIA 侧仍未验 |
| CliDebug 可用性 | PE 字符串扫描：`clidbg` / `127.0.0.1` / `listen` / socket **命中 0**；有 `DebugCommand`(13)、`get_DebugMode`、ERB 指令 `SAVEGAME`/`LOADGAME`、`DEBUG_MODE.bat = -debug` | **ARCHITECTURE §5.3 的"CliDebug 活会话"这一快照来源在本机这份引擎上不存在** → 取档只能靠 GUI 人工点 |
| 存档 | 语料内无 `sav/`；`Downloads/Documents/Desktop/C:\DSH/C:\Game` 全盘无任何 `.sav`；**git 历史从未入库 `.sav`** | 本机零真实存档；§5/§6 无从重测（这正是本任务存在的原因） |
| 体积 | 语料 588.6 MB / 16,112 文件；仅 C 盘、余 390 GB | 复制副本完全可行（真实语料零写入） |
| 合成档（选项 c）可行性 | `raw-inject.test.ts` 已在纯内存合成 fileType=var 档并 `serialize∘parse` 回环；`container.assembleArchiveFile` 现成；`serializePayload` 只依赖语义字段（`offset` 仅用于报错）→ **技术上能造整档** | **但验证力≈0**：拿我们自己的编码器产出喂我们自己的解析器，"逐字节一致"**恒真**（循环论证），且 §5/§6 任何历史数字都不可对拍 → **否掉，只留作"无真档时的管线冒烟"** |

**结论**：唯一有验证力的路线是拿到**引擎写出的真档**。用户随即提供了六份 `.sav`（选项 d），
且逐字节验真证明它们**就是 2026-10-10 那批原始存档**——不是"另一份档"：

| 证据 | 实测 | 文档记录 |
|---|---|---|
| `save00` 载荷字节数 | **571,185 B**，且 `serialize∘parse` **逐字节差异 0** | §5.17 / §6.9「save00 载荷 571,185B 字节级完全一致」 |
| `save03` saveMes | `2026-09-21 22:05:03 **第 47日**(夏之月16日) 命莲寺 昴 Ver 4.980 …CH20260326` | 集成测试断言 `saveMes` 含「第 47日」+ `DAY === 47` |
| 档集构成 | `global + save00–03 + save1000` = **6 档** | `integration-plugins.test.ts:258` 的 `toBe(6)` 与其注释同源 |

> 这条证据链也**更正了阶段一我自己的判断**：我当时写"§6 的历史数字绑定当年那份 save03，
> 本机已不存在 → 必须重定基线"。档到手后该判断作废，§5/§6 **可以逐字对拍**，无需重定基线。

#### 放置：真实语料零写入

`robocopy` 整份复制到 `C:\tmp-kojo-sav\eratw`（623 MB，秒级），六份 `.sav` 放进**副本**的 `sav\`，
`KOJO_SMOKE_PROJECT` 指向副本根。选整份而不是只复制 `ERB`+`CSV` 的理由：集成与编码往返会断言
**全工程文件数**（§7 的 4,385），最小副本会让口径漂移；也不用 junction（reparse point 会影响
`project.savDir` / `writablePaths` 的路径比较，且删目录有误穿链接的风险）。
复制前后对拍：`ERB` 4,511 = 4,511、`CSV` 222 = 222；真实语料始终**无 `sav/`、顶层 29 项不变**。
临时副本用完删除（见末尾验收）。**全程未在 `C:\Game` 创建、修改或删除任何文件。**

#### 复测结果：§5 与 §6 逐字复现（全链路，带 `KOJO_SMOKE_PROJECT`）

- **§5 存档解析**：168 角色/档 ✓、**16,005 变量/档**（角色区 15,463 + 主区 540 + EM 2）✓、
  `save00 = 16,000` ✓、`#DIM` 恒 65 ✓、MASTERNAME 7/168 ✓（`save00` = 2，符合"第 1 日"）、
  RANDDATA saveLen 625 且 `save00 nonEmpty=0` / `save01+ =625` ✓、MONEY 51.77 亿（`0xD2` Int64 路径）✓、
  EM 区 2 张 DT 表 ✓、**残余 0 字节**（六档全部）✓；扫描 6 档 12ms（历史 30ms，非口径变化）。
- **§6 状态回放**（真实 `save03` × K49 古明地觉）：**1,356 函数 / 11,685 谓词**、
  命中 **1,549** / 未命中 **6,395** / 未知 **3,741 = 32.0%**、
  exact **836** / partial **482** / unknown **38** —— **逐项一字不差**；
  未知分类亦对齐（pseudo 1,886 / call-context 858 / call 368 / named-index 337 /
  local-no-write 196 / missing-var 80 / other 10 / dynamic-index 4 / opaque 2）。
- **注入写链路**：只写 `%APPDATA%` 副本（56,744 B，备份已建），越权拒绝 1 项、Int64 守卫 1 项 ✓
  —— 符合 §5.5「注入器只写独立测试槽」的既定语义，真实档零接触。
- **结论**：**§5.64 两线合流、§5.65 索引快照 v3、§5.70 抽取按文件增量都没有把回放求值带偏。**
  这条差异化能力重新有了实机证据，不再是文档里的历史数字。

#### 一处口径漂移已归因到具体批次（不是回归）

条件抽取的**扫描函数数**实测 **99,104**（= §1 索引全量函数数），而 `BASELINES` §4 记 **95,504**。
谓词 / 未解析 / 含依赖函数 / 依赖条目**四项逐字未变** → 是计数口径变宽，不是抽取结果变化。
归因：提交 **`16747f4`（§5.70 抽取按文件增量批）** 让"本次没有任何控制流语句的文件也留一个空桶"
（否则每次开项目都被判"没缓存"而白读白扫），这些文件的函数从此进入 `stats.functions`。
`mergeBuckets` 对复用桶与新算桶同等累加，故热/冷启动不影响该数——已排除"缓存复用少计"的猜测。

#### 本批唯一的代码改动：封堵金样本的两处**假绿面**

1. **档集清单错位 + 静默跳过**：`golden-roundtrip.test.ts` 硬编码 `save00–save05`（另一套槽位编号），
   而本机/组内基线用的是 `global + save00–03 + save1000`；对不存在的档是 `catch { continue }` →
   **标题写"六档"、实际只验 4 档，照样全绿**。改为 `GOLDEN_ARCHIVES` **身份清单**：
   缺任何一档即红并指名缺哪档。
2. **"验到什么强度"没人守**：旧文件只说"六档逐字节一致"，而真实情况是分层的。改为写死三层实测强度：
   **逐字节同构 2 档**（`global` + `save00`）／**近似档 4 档**（`save01–03` + `save1000`，
   16/34/43/43 条 Int64 近似警告，传统重编码显式拒绝——§5.19 的既有约束）／
   **方案 B `keepRaw` passthrough 六档全部逐字节一致**。
3. **无存档时报 ENOENT 而不是显式 skip**：`describe.skipIf(!SMOKE_DIR)` 只看环境变量，
   于是"有 `KOJO_SMOKE_PROJECT` 但语料没 `sav/`"会**失败**（此前全量套测里那两个红的根因）。
   改为 `HAS_SAV` + `it.skipIf(!HAS_SAV)`——报告里显示 skipped 并说明原因（**不静默**）。

**三处都是收紧，没有一处放宽断言**；数字变了的地方（§4 计数）按"如实报数 + 归因到批次"处理。

#### 验收结果

| 检查 | 结果 |
|---|---|
| `golden-roundtrip`（副本，有档） | **3 passed**；逐字节 2 / 近似 4 / passthrough 6 全部命中 |
| `golden-roundtrip`（真实语料根，无 `sav/`） | **3 skipped（显式，报告可见）**——修前是 ENOENT 失败 |
| `golden-roundtrip`（不带环境变量） | 3 skipped |
| `integration-plugins`（副本，全链路） | **3 passed**；§5/§6 读数见上方逐项 |
| `vitest run`（**不带** `KOJO_SMOKE_PROJECT`，按纪律） | **1432 passed / 11 skipped** |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 真实语料未被写入 | `sav/` 仍不存在、顶层 29 项不变、`ERB`/`CSV` 文件数与复制前一致；临时副本已删除 |

#### 复测配方（后来者照抄即可；**2026-10-13 起以档案库为准**，见下方"边界未做"第一条）

本批当时的做法（语料还没有档案库，只能整份复制）：

```bash
# 1) 复制到工作区外（真实语料只读）；robocopy 退出码 <8 即成功
cmd //c "robocopy C:\\Game\\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC) C:\\tmp-kojo-sav\\eratw /E /XJ /MT:24 /NFL /NDL /NJH /NJS /R:1 /W:1"
# 2) 六份 .sav 放进副本的 sav\（档本身不入库，见下"边界"）
# 3) 单独跑这两条时才设 KOJO_SMOKE_PROJECT；跑全量套测时**不要设**
KOJO_SMOKE_PROJECT="C:/tmp-kojo-sav/eratw" node node_modules/vitest/vitest.mjs run \
  packages/plugins/sav-parser/tests/golden-roundtrip.test.ts packages/kernel/tests/integration-plugins.test.ts
```

#### 边界未做（明确记录）

- **存档的长期位置（2026-10-13 用户定，已落地）**：`C:\Game\eratw-save\sav\`——语料的**同级目录**，
  既不在语料内部（真实语料继续零写入、也不建 `sav/`），也不入库（"真实游戏数据不入库"）。
  六份已复制并对拍：sha256 前 16 位与本节上方表格逐字相同。带来的**简化**是：
  金样本回归不再需要 589 MB 副本，`KOJO_SMOKE_PROJECT="C:/Game/eratw-save"` 直跑即可
  （`golden-roundtrip` 只拼 `sav/`，实测 **3 passed / 六档全报告**）；
  只有 `integration-plugins` 需要完整工程根，才仍走"语料副本 + 把档案库的 `sav\` 拷进去"。
  配方两条已写进 `HANDOFF` §五 与 `BASELINES` §5。
- **SKIA v15 侧未验**：本机引擎是 LazyLoading v3.0（非 SKIA），§5.5「通吃」只验到 v22 一侧；
  §5.3 的 CliDebug 快照来源在本机这份引擎上不存在（PE 无 socket 面），要用它得另找 SKIA 构建。
- **§7 编码往返基线**（4,385 文件 0 字节差异）本批未在副本上重跑——不在重测清单里，副本还在时可顺手补。
- **桌面壳实机目视仍未做**（本机无 `src-tauri/target`，需 GUI 会话）。

### 5.75 语法糖度量批 · 把四条"下一批首选"逐条量过（2026-10-12 批：三条不成立）

> **编号让位（第六次，同一根因）**：本小节初写为 §5.72，而**并发会话**的回放线重测批已占 §5.72
> （本仓第一次出现"同一时刻两条线各自取号"）⇒ 按既定口径先落地者保留号，本小节顺延 **§5.73**。
> 顺带把这条纪律的具体化写进正文：**取号要在提交前一刻做**，两轮"我写完再 fetch"之间只要有并发就必然撞。
> **第二次让位（同一根因第八次）**：rebase 时远端 master 已把 §5.73 给了**名称解析 memo 批**
> ⇒ 本小节最终落 **§5.75**。两轮"取号 → 撞号 → 让位"发生在同一条 rebase 链上，再证 §5.65 那条纪律：
> **取号必须在提交前一刻用 `grep -c "^### "` 现取**——跨会话接力时"我写完再 fetch"必撞。

**本批不写代码**：§5.71 刚立下"动机表里的多少行必须配一张怎么排布的分布表"，
那就先用它审**我自己写的**候选表。四个探针（同批删除）跑完，四条首选里三条不成立。

| 候选（§5.71 写下时的预估） | 实测 | 判定 |
|---|---|---|
| ① 数据表 `PRINTDATA` 系（预估 17,734 + 3,532 行） | **3,552 块 / 18,875 条目行**；六块型；纯条目率 100%；嵌套恒 1；条目中位 3～6 条 | **有规模且规整**，但卡在表层语法缺口 → 转成规范决策，不做投影批 |
| ③ `CASE` 块内正文（预估 3,502 行） | 未投影 CASE 族 1,392 行：**1,185 行（85%）在 `[SKIPSTART]` 停用区内**（判定正确），正常语句位置仅 **207 行**、约 18 个块 | **不是杠杆**（数量级差 17 倍） |
| ④ 菜单惯用法 → `选项` 块反向（我以为是一大族） | 口上域 `PRINTBUTTON` **267 行**｜`PRINTLC` 44｜`INPUT` 1,198｜`INPUTS` 74 | **不是杠杆**；菜单活在系统 ERB，不在口上正文 |
| ② 未配对 `SETCOLOR` 17,713 行 | 未重新测（判据阻塞点在别处） | 受规范 §9 第 5 条**待实机**约束：分发器收尾 `RESETCOLOR` 的覆盖性没实测前，**不放宽配对判据** |

#### 数据表这一族的完整读数（决策要用，所以测全）

- **开词即块型**，六个变体：`PRINTDATAL 1,077｜PRINTDATA 999｜PRINTDATAW 956｜PRINTDATADL 298｜
  PRINTDATADW 198｜PRINTDATAD 24`。
- **规整度是这批最好的消息**：3,552 块**全部纯条目**（块内没有任何其它语句），嵌套深度恒为 1，
  条目指令只有 `DATAFORM 18,141｜DATA 420` 两种；`DATALIST` 分组出现在 839 块。
  条目中位 3～6 条 ⇒ **真的连成串**（与批 M 那 29 万条"长度 1 的骨架串"正相反），成组显示省视野在这里成立。
- **坏消息在语义分叉**：`…L`/`…DL` 系 = **轮流**（每次调用换一条）共 1,375 块 = **38.7%**，
  其余是**随机**。而规范 §3.6 的 `随机：` 块编译为 `LOCAL = RAND:n` + `SELECTCASE`：
  既表达不了"轮流"，产物也不是引擎那套 data-print 机制。
  ⇒ 把数据表显示成 `随机：` 就是"看着像糖、写回去语义不同"——§5.66 否证过的那类错，不再犯第二次。
- **结论**：这一族要做得**先给规范补一条数据表写法**（含"轮流"这半壁语义），
  那是 §3.8 那次同类的**语法层决策**（用户拍板范围），不是投影层能自便的事。
  一旦补上，量（1.9 万行）与规整度都配得上一整批——所以我把形态数据全留在这里，
  拍板之后可以直接开工，不必再测。

#### 本批产出与验收

| 项 | 内容 |
|---|---|
| 代码 | **零改动**（没有可诚实做的投影，就不硬做） |
| 文档 | 本节 + `docs/LIFT-REMEASURE-2026-10-12.md` 十一（续八）+ HANDOFF 首选表更新 + 任务清单三条状态更正 |
| 探针 | 四个（数据表形态×2 / CASE 成因 / CALL 与菜单族词表）全部**同批删除**，仓库无残留 |
| 验证 | 未跑全套（无代码改动）；跑探针前后 `git status` 干净、`origin/master` 同步 |

**教训**：候选表不是承诺表。§5.71 那条纪律真正的价值不在于否证了别人的方案，
而在于**它同样否证了我自己刚写的下一步**。

### 5.76 UI 归一批 · 接管并打磨糖组并入的糖视图界面（2026-10-12 批）

> **用户指派原文**：「关于🔒 只读（尝试输入可解锁），糖组的 UI 并不是他们的长处，并且 UI
> 方面的优化也属于本组的工作，请你顺便帮他们优化 UI，确保风格统一，『专业、克制、流畅、
> 高效、耐看』。」——所以本批是**本组对糖组界面的第一次接管**，不是互评。

#### 判据先立起来：什么叫"不统一"，三条全部可判定

不拿口味当依据，每条都在仓里找到**现成对照物**：

| 判据 | 仓内依据（可数出来的） | 糖视图初版 |
|---|---|---|
| 模态 `primary` 恒 = 推荐项、且排最右 | `SaveWarningDialog` / `UnsavedConfirmDialog` / `WritableApprovalDialog` 三家一致 | **反了**：高风险的「允许编辑」是 primary，写着"推荐"的「保持只读」被压成 ghost——视觉重量与文字推荐互相打架，且危险那一侧恰好更亮 |
| 命令面板标题 = 裸动宾短语 | 其余 **13 条命令无一带括号**（「切换写作模式」「重置布局」） | 「切换糖视图（把 ERB 显示为语法糖）」——唯一带括号，长一倍 |
| 面向作者的句子不含实现术语 | 用户反馈 5 已为此删过「升糖不写原文件」 | 「已**映射** N 行」「EraBasic」仍在屏上（`sugarSummary` 的文档注释自称"**不含内部术语**"，下一行就是"映射"） |
| 术语一个词到底 | 工具条按钮写「语法糖视图」 | 摘要写「糖视图」、命令面板又写「糖视图」——同一功能三个名字 |

改后：`保持只读` 上 primary 并去掉标签里的"（推荐）"（推荐由视觉重量表达，不再重复）；
命令标题 `切换语法糖视图`；摘要 `语法糖 N 行`；`EraBasic` 从对话框里消失。

#### 徽章配色：按**风险**给，不按"有没有字"给

初版 `只读 = --amber`（警示）、`已解锁 = --fg-dim`（隐形）——**恰好与风险相反**。
作者打开游戏目录是一屏二十个 ERB，个个顶着琥珀徽章＝天天喊狼来了；而"写保护此刻已失效"
这个真正需要被看见的破例态几乎看不见。现对调：只读走中性（🔒 图标本身已表意），
`.unlocked` 走 `--warning`。

#### 本批唯一的功能性缺陷：ViewZone 行高算术（顺带纠正一次自我误判）

`heightInLines` 换算成的盒子高 = `行数 × Monaco 行高`，而 `.sugar-zone` 自己按
`font-size: 12.5px; line-height: 1.6` = **20px/行** 排版；Monaco 在宿主 `fontSize: 14`
下是 `round(14 × 1.35) = `**19px/行**（`fontInfo.js` 实证，非 Mac 分支）。每行差 1px，
`sugarZonePlan` 的 +1 行呼吸只够垫 19 行——**超过约 19 行的长台词段，尾部会被
`overflow: hidden` 裁掉**。

修法不写死 19px：新增 `editorLineHeightPx()` 读实测行高，落进 `--sugar-zone` 的自定义
属性 `--sugar-lh`，CSS 的 `line-height` / `min-height` 都吃它。字号 12.5px **保留**——
那是糖组刻意的"稿纸而不是代码块"，本批只修算术，不动它的设计意图。

**第一版写错了，值得记下来**：最初读的是 `.view-lines`（容器）。翻 Monaco 源码才确认
`viewLines.css` 里 `.monaco-editor .view-lines` **只有 `white-space: nowrap`**——
Monaco 把 `height:Npx;line-height:Npx` **内联写在每一条 `.view-line`（单数）子元素**上，
读容器只会拿到继承来的 `normal`，`parseFloat` → NaN → 静默退回兜底值，**改了等于没改**。
Monaco 自己在 `viewLines.css` 的注释里就写着
*"There are view-lines in view-zones … they don't set a line height"*——Zone 恰恰是唯一
拿不到行高的那一层。现改读 `.view-lines .view-line`，并加模块级缓存：`applySugarView`
紧跟 `setModel`，首帧可能一行都还没有，而全应用共用同一个 `fontSize`，量到一次即可长用。

#### 顺手清掉的两处

- `renderSugarBlock` 全仓**零引用**（宿主走"空壳 + 分帧填充"的 `fillSugarBlock`），删除；
  被删注释里"实测最多 9,569 段"这个数**挪到调用点**保留（那才是它该待的地方）。
- `styles.css` 里一条 `erb-mode-hint` 的**孤儿注释**（上一批对齐徽章度量时留下的旧口径说明）。

#### 无障碍：把糖组新立的约定**反向**补齐给全站

`role="dialog" aria-modal="true" aria-label` 此前**只有**糖组那两个新对话框有，
三家老模态一个都没有——不一致的方向和直觉相反。现五家齐；糖视图开关补 `aria-pressed`。

#### 新增守门：全站模态一致性测试（本仓**第一条渲染型测试**）

`packages/app/tests/sugar-dialogs.test.ts`，13 项。vitest 的 `include` 只收 `*.test.ts`，
但 `resolve.extensions` 含 `.tsx`，于是从 `.ts` 里 `renderToString(createElement(...))`——
**不新增任何依赖**，也不为此把 JSX 拆成纯函数。锁三件事：primary 排最右、dialog 语义齐、
屏上无实现术语。（`file-tree.test.ts` 已有从 `.ts` 引 TSX 的先例。）

#### 一处**没有**按"看起来像缺陷"下手的判断

糖组新写的 CSS 里有 `var(--hover, rgba(128,128,128,0.12))` / `var(--font-mono, monospace)`
这类**兜底字面量**——而本仓 P 批的设计 token 注释明写着"散落各面板的 fallback 值收编为
唯一来源"。乍看是对方把我们的收编反向破坏了。实测：全文件 `var(--font-mono,` **20 处**、
`var(--hover,` **6 处**，绝大多数在糖组进场之前就存在——是**我们那批只建了 token、
没清调用点**。所以本批不动它（40 处机械重写不在"顺便优化 UI"范围内），记为 #19/#10 的账。
同理 `font-size: 11px / 10.5px` 全文件各有 38 / 28 处，`--fs-*` 三级标尺只在新代码里被遵守，
本批不自作主张单边对齐。

#### 实机目视（补 §5.64 挂的那条共同欠账）

haruki 主机 `target/debug` 已在，走 `pnpm tauri dev` + Windows 截图，真实项目
`erawtb-sub-moddding-eratw4.980-260326-SANYOUSEI(PC)`（2,285 ERB / 99,104 函数 / 141 角色）：

- 首次引导弹窗按新文案渲染，`不用`(ghost) → `开启`(primary) 层级正确；
- 工具条 `🔒 只读` 呈**中性灰**、`语法糖视图` 呈 accent 按压态、读数 `语法糖 380 行`；
- 糖段（`如果 / 当 / 是 / 否则如果 / 否则:` + 台词 + `续`）与相邻代码行同 rhythm，
  边界处最后一行完整无裁切；作者包真实文件夹视图（T3）在同一次会话里一并复验通过。
- **诚实边界**：截图分辨率（窗口 1294px → 图 1130px）下 19px 与 20px 的差落在读数噪声里，
  所以"裁切已修"这一条**只有源码级验证**（`.view-line` 内联行高 + `round(14×1.35)`），
  没有像素级证据。要钉死它需要一个 >19 行的连续台词段，本文件里没有。

#### 一次误伤（进坑表）

`pnpm tauri dev` 在 **1420 被旧 vite 占着**时：`beforeDevCommand` 直接失败退出，
并把**已经在跑的桌面实例一起带没**——本批因此弄丢了用户先前开着的两个编辑器窗口。
而且那个跨过一次 merge 的旧 vite，`node_modules/.vite` 预打包缓存已过期
（merge 给 eratw-adapter 带了 `react` peerDependency），用它起的壳是**白屏**。
正确顺序：**先确认 1420 空闲 → 必要时 `rm -rf node_modules/.vite` → 再起**。
另：直接 `cargo run` 复用旧 vite 是**不行**的（白屏那条就是它），别把"绕过 beforeDevCommand"当捷径。

#### 验证

| 检查 | 结果 |
|---|---|
| `vitest run` | **1362 passed / 11 skipped**（基线 1348 + 本批 14：13 项模态守门 + 1 项文案术语） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| `pnpm --filter @kojo/app build` | ✓ 23.07s（仅 Monaco 体积老告警） |
| 桌面壳实机目视 | ✓ 见上（本组第一次；含 T3 真实文件夹视图回归） |

#### 未做

- `prefers-reduced-motion`：糖视图本身无动效，不需要；但**全站模态都没有 Esc 关闭**
  （`ShellLayout` 的 Esc 链只覆盖 picker > overlay > settings > zen，五家 `modal-mask` 都不在链上）。
  这是**先于本批存在**的缺口，补它要给宿主加"当前有模态"的注册机制，不属"顺便"，另立账。
- 解锁对话框的 `ErbUnlockDialog` 未实机看到（要真的在只读 ERB 里敲字才弹，本批不在游戏目录里写东西）。

### 5.77 导出批 · 工作区以 `.kojo` 为源 + 制品 ZIP + 部署自动转译（2026-10-12 批，用户反馈 1a + 2）

> **用户反馈 1a**：「新建项目后的文件默认都是 `.kojo`，这样既能写语法糖也能写原始 ERB 语言。」
> **用户反馈 2**：「导出项目自动把 kojo 转译成 erb 并打 zip；部署时也得自动把 kojo 转译成 ERB。」
> **层位**（用户 2026-10-12 拍板）：ZIP 在 **TS 层**做，不给 Rust 加 `zip` crate。

#### 为什么 1a 与 2 必须同批落（本批最重要的一个判断）

`.kojo` 一旦成为默认源，**既有的"逐字节复制"部署就变成静默失效**：引擎只读 `.ERB`，
把 `.kojo` 放进游戏目录不报错、不提示，只是不生效——比报错糟得多，因为作者以为装好了。
所以"改默认扩展名"和"改导出/部署"是同一件事，拆两批就是中间提交一个坏状态。
（原任务清单把 #14 与 #17 分列，是按反馈条目分的，不是按依赖分的。）

#### 制品规则：四条，其中两条 fail-closed

新增 `eratw-adapter/src/artifact.ts`（纯函数，导出与部署**共用同一份计划**——
否则会出现"导出的能跑、部署的不能跑"）：

1. `.kojo` → 同名 `.ERB`，命名规则复用 `resolveSugarTarget`（与"保存 `.kojo` 落哪"同源，不另立）；
2. 非 `.kojo` **字节级原样**（`.txt` / `.md` / 作者手写的 `.ERB`）——口上库既有编码经一次转码毁半库；
3. **制品里绝不残留 `.kojo`**；
4. 任一转译失败 → 整体拒绝，**不产半成品包**；同目录 `事件.kojo` + `事件.ERB` 的
   命名冲突直接拒绝（大小写不敏感，Windows 上本就是同一个文件），不静默二选一。

**转译只发生在内存**：工作区的 `.kojo` 一个字节都不改写，权威源始终只有一份。

#### 编码口径收敛成一处（防双源漂移）

契约新增 `SugarTranspileService.compileToBytes()`（纯函数、零 IO），
并把 `compileToFile` 的 1+2 步（转译 → 守卫 → 组装 BOM/换行/末尾换行）**改成调用它**，
再走原来的 3-6 步。这样"导出产物"与"保存产物"的字节组装只有一份定义——
正是本仓 `0bf2eb9` 记过的双源漂移类型，先堵在源头。

#### ZIP：TS 层容器封装（`plugin-api/src/zip.ts`）

`CompressionStream('deflate-raw')` 产出的正是 method 8 要的 raw deflate，所以**压缩不需要库**，
本模块只做容器：本地头 + 中央目录 + EOCD + CRC32。三条不能省的规矩：

- **UTF-8 标志位 bit 11 必置**——口上包文件名是中文/日文，不置就是声明 CP437，解出来乱码目录名；
- **分隔符一律 `/`**——Windows 的 `\` 会被当成文件名的一部分，解出一个叫 `ERB\口上\事件.kojo` 的文件；
- **deflate 变大就退回 store**——几十字节的短文件压缩后普遍膨胀。

刻意**不支持 ZIP64**，条目数/体积越线时 `throw` 明确拒绝，而不是静默产出坏包。

#### 落点能力：`exportFile`（对话框即授权）

导出 ZIP 是**单个文件**写到白名单外，`exportDirectory` 顶不上。新增 `FileIO.exportFile` /
`PlatformBridge.exportFile` / Rust `export_file`，与 `export_directory` **同一授权模型**：
保存对话框与写盘绑在同一个平台命令内，JS 拿不到落点决定权，所以内核刻意不调
`assertWritable`。字节走 base64，与 `write_file_bytes` 同口径（仓内既有约定，不另发明）。

**时序契约（本批新增，实机验证过）**：打包**先于**弹框完成——转译失败根本不会弹一个
注定失败的对话框。用户选完落点才吃到错误，比不弹框恶劣得多。

#### 依赖方向：`tryInject` 且延迟到点击时

糖服务用 `ctx.tryInject` 而不是 `requires` 硬依赖，且**在点击导出/部署时才解析**：

- 写成硬依赖 ⇒ 语法糖插件被停用时，**整个 eraTW adapter 一起不激活**，游戏识别/浏览全废；
- adapter 通常早于糖插件激活，activate 当场取会取到 undefined ⇒ 放到调用时取，激活顺序与功能无关。

#### 两个自查出来的实现 bug（都是"看起来对"的那种）

| bug | 后果 | 怎么被逮住的 |
|---|---|---|
| 中央目录长度在 EOCD 前缀**写完之后**才用 `off` 算 | 多算 12 字节，破坏"中央目录紧接 EOCD"不变量 | 往返自证读器（读器故意不复用写侧偏移） |
| `normalizeEntryName` 把目录条目的尾斜杠当"空路径段" | 所有目录条目被拒 | 单测「目录条目放行」 |

#### 验证：三层，最外面那层是**真解压工具**

| 层 | 做法 | 结果 |
|---|---|---|
| 单元 | `zip.test.ts` 21 项（往返自证 + CRC32 标准向量 + 名字闸 + store/deflate 选择 + 降级） | 全绿 |
| 单元 | `artifact.test.ts` 13 项（冲突/逃逸/BOM/fail-closed/字节原样） | 全绿 |
| **交叉** | 真 `.NET ZipFile`（= 用户双击 zip 的那条路径）解本机生成的包 | 中日文目录名逐字还原、内容逐字节一致、deflate/store 混合、空目录建出 |

> **`unzip` 显示乱码不是包的错**：Git-Bash 的 Info-ZIP 在 Windows 上按 OEM 码页转码文件名。
> 别为此删掉 bit 11——那会真的弄坏 Explorer 与 7-Zip 下的中文名。

#### 实机端到端（haruki 主机，真实点击）

新建口上项目 → 向导文案实时显示「8 个核心面空壳（.kojo，糖与原生 ERB 都能写）」→
创建 → 磁盘上确认 **8 个 `.kojo` + README.md** → 点「导出」→ **系统保存对话框标题
`导出「验收导出批-你 v1.0」为…`、文件名预填 `.zip`、保存类型 `ZIP 压缩包 (*.zip)`** →
存到临时目录 → 解包核对：

- 9 个条目 = `README.md` + **8 个 `.ERB`**，**残留 `.kojo` = 0**；
- `事件.ERB` 字节头 `ef bb bf` ⇒ **导出产物与保存产物同一编码口径**（UTF-8-BOM + LF）；
- 工作区源文件未被改动（导出前后时间戳与内容一致）。

顺带（误点）验到部署向导的 fail-closed：目标角色「你」在游戏目录无个人口上目录 ⇒
落点栏直接写明原因且「部署到游戏目录」按钮禁用。

#### 基线

| 检查 | 结果 |
|---|---|
| `vitest run` | **1400 passed / 11 skipped**（1362 + 本批 38） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `audit-decoupling` | A–D 全绿（16 插件） |
| `@kojo/app build` | ✓ 24.61s |
| `cargo test`（src-tauri） | 12 项全绿；`pnpm tauri dev` 实测重编译通过 |

#### 未做

- **LICENSE 多协议（#16 / 反馈 4）另立一批**，卡在一个不能糊弄的事实上：
  **MIT/BSD-2/ISC 可逐字内置；CC BY-NC 4.0 全文需从权威源取；
  而用户点名的 `LTOL`（时限开放许可，era 社区专用）两次联网检索都查不到权威全文**。
  法律文本不凭记忆编造——编错的条款让作者据此发布，是真实的合规事故（与 T2 署名
  "绝不合成判定"同一口径）。需要用户提供 LTOL 原文，或确认它只作为"待填框架"呈现。
- `exportDirectory`（整目录复制）**保留未删**：导出改走 ZIP 后它暂时没有 UI 调用方。
  （**后续**：§5.97 全仓复核仍零生产调用方 ⇒ 契约收缩，已删；那四条内核层断言移植到 `exportFile`。）
  删掉是契约收缩，且"复制一份目录树"仍是合理原语——留待用户定夺，不顺手删。
- 部署路径的 `.kojo → .ERB` 只做了单元级验证（`deploy.test.ts` 全部用例刻意用 `.ERB`
  包体，以保住"不许转码"那条断言）；**实机部署未跑**——那要往真游戏目录写东西。

### 5.78 工作区新建条目批 · 右键建文件夹 / .txt / .kojo / .ERB（2026-10-12 批，用户反馈 1b）

> **用户反馈 1b**：「我的项目区域，可以右键根节点，然后选择新建文件夹还是 txt 文件、
> kojo 文件、erb 文件等常见的实用操作。」

#### 一个类型系统层面的发现（值得单列）

本仓根 `tsconfig.json` 是 `lib: ["ES2022"]` + `types: ["node"]` —— **不含 DOM lib**，
且实测**全部 16 个插件正文零 `document` / 零 `window`**（`git grep` 可复核）。
插件面板虽然用 `createElement` 造 DOM，但从不直接碰浏览器全局。

我这次第一次需要在插件里读事件坐标与输入框的值，第一反应是 `MouseEvent` /
`HTMLInputElement` / `window.innerWidth` —— 七条编译错误。正解是仓内**既有的**范式
（`new-project-wizard.ts` 一直是这么写的）：

```ts
onChange: (e: { target: { value: string } }) => …        // 不是 ChangeEvent
onKeyDown: (e: { key: string }) => …                      // 不是 KeyboardEvent
type PointerEvent = { clientX: number; clientY: number; preventDefault(): void;
                      stopPropagation(): void; view?: { innerWidth: number } };
```

视口宽度走 **React 合成事件的 `e.view`**，不走 `window`——这样"菜单靠右边缘不溢出"
这个需求也不需要为插件开 DOM lib。`useRef<{ focus(): void } | null>` 同理。

**结论**：插件要碰浏览器能力时，先问"能不能只声明我用到的那几个字段"，
而不是给 `lib` 加 DOM。加了，插件就会开始自然地依赖 `document`，那道边界就没了。

#### 命名规则：输入端拒绝并说明，绝不静默消毒

新模块 `eratw-adapter/src/new-item.ts`（纯函数）。与脚手架那边**刻意相反**的取向：

| 场景 | 做法 | 为什么 |
|---|---|---|
| 脚手架拼出来的目录名 | `sanitizeSegment` 静默剔除非法字符 | 名字是程序自己造的，消毒无害 |
| **作者手打的文件名** | **拒绝 + 中文原因** | 把他写的 `A/B` 悄悄改成 `AB`，他会以为编辑器坏了 |

扩展名三态：没写 → 按所选类型补；写的就是所选类型 → 原样；**写的是别的扩展名 → 拒绝**
（选 `.kojo` 却打 `事件.ERB`，既不静默产出 `事件.ERB.kojo`，也不偷偷改判成 `.ERB`——
两者都不是他点的那个菜单项）。尾随点号/空格也拒（Windows 会裁掉，建出来的名字对不上）；
首尾空白则正常 `trim`，不为难人。

#### 交互形态：行内输入框，不用 `window.prompt`

`window.prompt` 在 WebView2 里可能直接返回 `null`（Tauri 默认不接原生 JS 对话框），
那样功能就是静默坏的。改成 VSCode 式**行内命名框**：长在树里、自动抢焦点、
实时显示 `→ 测试新建.kojo` 预览、Enter 创建 / Esc 取消。

预览与建成名**同源一个函数**（`newItemPreviewName` 直接调 `resolveNewItemPath`）——
"提示说 A、建出来是 B" 是最难查的一类坑，从结构上堵掉。

行内框**排在目录内容最前且不受目录状态影响**：空目录 / 正在读 / 读失败的目录同样要能建东西，
"在空包里建第一个文件"恰恰是最常见的起手式。

#### 复用而非另立

- 右键菜单直接用壳层既有的 `.context-menu` / `.context-menu-backdrop`（fixed + token +
  `pop-in` 动画）——同一个应用里两套上下文菜单是最典型的"看着像两个系统"；
- 行内框度量对齐 `.kp-file-btn`（同 padding / `--fs-1` / 圆角），否则一行输入会把树的行节奏打断；
- 失败原因**独占一行**（`flex: 1 1 100%`）：侧栏很窄，塞在输入框后面会被挤成看不见的碎片。

#### 落点与写保护

`createItem` 走 `io.writeText` / `io.ensureDir`（内核第一道闸 + Rust 第二道闸照旧）。
目标恒在工作区（常驻可写根），但仍显式判 `io.isWritable` 并拒绝——走到这里说明路径
根本不在工作区里，那是程序 bug 或用户把项目挪到了游戏目录下，两种都不能默默写下去。
**已存在同名条目 → 拒绝不覆盖**。新建文件后自动 `reveal` 打开它（作者下一步十有八九是写内容）。
刷新只重拉那一个目录（`refreshDir`），不清整棵树——避免面板闪一下。

#### 实机端到端（真实右键点击）

右键包行 → 菜单四项按"糖优先"顺序呈现 → 点「新建口上文件（.kojo）」→ 目标包自动展开、
行内框落位并抢焦点 → 输入时实时预览 `→ 测试新建.kojo` → Enter →
磁盘上出现 `测试新建.kojo`（3 字节 = BOM，与工作区 UTF-8-BOM 口径一致）、
树里按排序就位、**并自动在编辑器打开且可写**（无 🔒 只读徽章 —— 正是 ADR-0005 轴一
"工作区文件恒可编辑"在真实场景里被验到），状态栏 `utf-8-bom · LF · 1 行`。

#### 验证

| 检查 | 结果 |
|---|---|
| `vitest run` | **1414 passed / 11 skipped**（1400 + 本批 14 项命名规则） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `audit-decoupling` | A–D 全绿（16 插件） |
| 桌面壳实机 | ✓ 完整走通（见上） |

#### 未做

- 右键菜单目前只有"新建"一组动作。删除 / 重命名 / 复制包等还没做——用户没点，
  且删除是破坏性操作，得先想清楚确认形态再动。
- 新建 `.ERB` 与 `.kojo` 并存于同一包时，导出会因**命名冲突被拒绝**（这是 §5.77 定的
  fail-closed 规矩）。目前报错文案只说"产物名冲突"，没引导作者"该删哪一个"。
  真实语料里两种都手写的作者极少，暂不加智能。

### 5.79 许可协议可选批 · LICENSE 从"勾不勾"升级成"选哪一种"（2026-10-12 批，用户反馈 4）

> **用户反馈 4**：「新建项目弹窗，勾选『附带 LICENSE 文件』后，出现多个可选的常见许可协议
> （MIT，BSD-2-Clause 或 ISC，CC BY-NC，或者 era 社区专用的 LTOL（时限开放许可）），
> 以及原始的占位模板。」

#### 一条不可让渡的纪律：条款文本必须有据可查

许可证不是文案。作者据此发布，工具替他**编造**或**意译**一份条款，就是把他推进一个
他以为已经规避掉了的合规风险里。所以本批开工前先立来源规则，只有三种合法来源：

| 来源 | 用在哪几项 | 纪律 |
|---|---|---|
| OSI / SPDX 标准条款**逐字内置** | MIT、BSD-2-Clause、ISC | 关键句式被单测钉住，且断言"三者互不相同"（复制粘贴漏改会在这条暴露） |
| **用户提供的权威原文逐字内置** | **LTOL** | 日文原文在前（源头语言）、中文译文随后，一字未改，**连原文自身的小节编号差异都保留**（日文版第 3 节下编号是 1./2.，中文版是 3-a/3-b——"顺手统一"就等于重新解释条款） |
| 明示为**要点速览 + 官方链接**的指引 | CC BY-NC 4.0 | 用户决定不内置数千词的全文；文件里写死"具有法律效力的完整条款以官方链接为准" |

**LTOL 的经过值得记**：我联网检索两次（日文、中文各一轮）都查不到权威全文，
于是**没有**按"时限开放许可"这个名字自己起草一份，而是停下来问用户。
用户随后提供了日文原文与中文译文（2026-10-12）。
——与 T2 署名抽取"绝不合成判定"是同一条线：**宁可空着，不猜**。

#### 缺省是 `none`，不是任何一种协议

下拉第一项是「不生成 LICENSE 文件」。工具不替作者选定许可，也不默认替他"开放"什么。
`includeLicense: boolean` 直接改成 `license: LicenseKind`（不留兼容 shim）。

#### 一处顺手清理

勾选框换成下拉后，`.wizard-field.wizard-check` 两条规则**只剩 CSS 在引用自己**
（`git grep` 复核过），删掉。新增的只有 `.wizard-hint` 一行说明的样式——
`<select>` 复用既有 `.wizard-field select`，不另立度量。

说明放**正文里**而不是 tooltip 里：许可选择是"读完再决定"的动作，
悬停才可见的提示对这种决策不合适。

#### 验证

| 检查 | 结果 |
|---|---|
| `vitest run` | **1430 passed / 11 skipped**（1414 + 本批 16：licenses 15 + scaffold 改写 1） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `audit-decoupling` | A–D 全绿（LTOL 是 era 社区约定 ⇒ 游戏知识，只住 adapter，未进内核/plugin-api） |

#### 未做（诚实边界）

- **新建项目向导的下拉未做实机视觉复核**：改完要验时 vite 已整页重载回欢迎页，
  且宿主窗口反复被最小化（用户正在用这台机器），没有继续抢前台。
  风险面很小（`<select>` 复用既有样式 + 一行 `.wizard-hint`），但**没看过就是没看过**。
- 许可文本没有"编辑后重新生成"路径：作者选了 MIT 之后想改措辞，只能建完再手改文件。
  本轮不做（做好它需要一个 LICENSE 编辑界面，不在反馈 4 的诉求里）。

### 5.80 三线合流批 · 本组六提交 rebase 进 master（2026-10-12 深夜批：一夜编号撞两次 + 基线算术要对得上）

> 先例：§5.55（内核线两轮 rebase）、§5.64（语法糖线合流）。本批是**第三条线**（口上项目/UI 线）
> 往已经前进了 21 个提交的 master 上 rebase —— 而且**一夜做了两轮**（第二轮远端又前进 4 个提交）。

#### 分叉规模

- 共同祖先 `00fd36f`；远端 `5c64b36..06fdb1b` **21 个提交**（快照卫生批 I/J/K/L/M 语法糖各批、
  抽取按文件增量批、校验按文件增量批）。
- 本地 **6 个提交**（UI 归一批、导出批代码 + 入册、工作区新建条目批、许可协议可选批、合流记录批）。
- 第二轮：远端 `06fdb1b..2925cf7` 又 **4 个提交**（名称解析 memo / 回放线重测 / 语法糖度量 / 存档库落地），
  冲突面从 4 个文件变成 **5 个**（多出 `eratw-adapter/src/plugin.ts` —— 他们挂 `project.closed` 清 memo，
  我方在同文件加 `compileKojo` / `createItem`，**不同区域，自动合入未手工干预**）。
- 真冲突面按 merge-base 两侧各自改过的文件求**交集**算出，第一轮只有 **4 个**：两份 docs、
  `plugin-api/src/index.ts`、`kojo-sugar/src/index.ts`。
  （用 `A..B` 对称差会虚报成几十个文件——本仓已两次因此误判冲突规模。）

#### 编号让位（本组侧，照 §5.64 口径：以远端为准，后入库者顺延）

**一夜撞了两次**，第二次尤其说明问题 —— 第一次 rebase 完成后我按当时远端最大号 §5.72
取了 §5.73–§5.77 并推送，**推送被拒才发现远端又到了 §5.75**（他们在我跑验证的十几分钟里
又推了 4 个提交，正好把我刚取的号占掉）。所以本组五节的最终归属是 §5.76–§5.80：

| 初稿写作时 | 第一次 rebase 后 | **最终（第二次 rebase）** | 小节 |
|---|---|---|---|
| §5.65 | §5.73 | **§5.76** | UI 归一批（接管糖组界面） |
| §5.66 | §5.74 | **§5.77** | 导出批（`.kojo` 为源 + 制品 ZIP + 部署自动转译） |
| §5.67 | §5.75 | **§5.78** | 工作区新建条目批（右键新建） |
| §5.68 | §5.76 | **§5.79** | 许可协议可选批（含 LTOL 原文逐字内置） |
| — | §5.77 | **§5.80** | 本合流批自身 |

**这是编号撞车的第四、第五次**（前三次：§5.49、§5.50、§5.59→§5.65）。根因每次都被
写成"取号要现取"，但本批暴露了更深一层：**取号正确、推送时机错，一样撞**。
`git push` 被拒之后再改号，等于把已经写进提交历史的号又撕一遍（本批就是这么返工的）。

→ **可执行口径（升级）**：文档批**最后写、最后推**。即代码提交先 rebase → 全闸验证 →
**立刻推** → 再写日志小节（此时取号才反映真实远端态）→ 单独一个 docs 提交推上去。
把"写文档"放在推送链路的**最前面**，就是给编号空间埋雷。

提交信息里的旧编号不回改：改 6 条提交（部分已推送）的 message 需 interactive rebase，
收益小于风险，**映射以本表为准**。

**这是编号撞车的第四次**（§5.49、§5.50、§5.59→§5.65、本批）。§5.65 那批已在它自己的头注里
写下根因和固定做法：**小节号不能凭记忆取，写之前先 `git fetch` 再 `grep` 当前最大号 +1**。
本批撞车的直接原因正是我在**上一轮**取号（当时远端只到 §5.64），而 rebase 前远端已到 §5.72。
→ 补一条：**跨会话/隔了一段时间再写日志，取号动作要重做一遍**，不能沿用上次会话记下的号。

**提交信息里的旧编号不回改**：改 5 条已提交（尚未推送）的 message 需要 interactive rebase，
收益小于风险，且映射以本表为准。

#### 冲突处置（4 处，逐处都不是"选边"）

1. **两份 docs**：两侧都是往**文件尾追加**，git 合成一个巨型冲突块（远端侧 737 行 / 我方侧 115 行）。
   处置 = **两边全留**，我方节顺延编号。
   ⚠ 一个不显眼的坑：我方 §5.74 之前的提交里，有一处是**给 §5.64 末条追写的续行**
   （"→ 本节已补上第一段……"）。它跟着"我方整块"一起被搬到文件尾，就会**脱离 §5.64 的列表**、
   孤零零挂在 §5.72 后面。已搬回 §5.64 那条之下。
   → 教训：**往别人章节里追加内容**（哪怕只是一行）会让该章节卷入冲突，rebase 时要单独检查它落点。
2. **`plugin-api/src/index.ts`**：两侧各自加 re-export，自动合成为并集（`+10` 行，纯增量）。
3. **`kojo-sugar/src/index.ts`**：我方给 service 对象加 `compileToBytes`，与他们的改动并集（`+3` 行）。
4. 代码侧**零手工干预**：`zip.ts` / `artifact.ts` / `new-item.ts` / `licenses.ts` / 面板 / EditorPane
   全部自动合入 —— 说明本组这五批没有踩到他们的热点文件。

#### 基线算术（这一条是本次合并真正的验收线）

| 项 | 数 |
|---|---|
| 远端 tip（§5.72）自记基线 | **1440** passed / 11 skipped |
| 本组五提交净新增 | **+82**（1348 → 1430：UI 归一 +14、导出 +38、新建条目 +14、许可 +16） |
| 合流后实测 | **1522 passed / 11 skipped** |
| 1440 + 82 | **= 1522 ✓ 逐条闭合** |

⚠ 核对时差点被带偏：远端 **HANDOFF §二** 最后写的是 **1432**，而 §5.72 的 LOG 里写的是 **1440**
——HANDOFF 的基线行**滞后了一批没同步**。所以"对基线"要认 **IMPLEMENTATION-LOG 各批自记的数**，
别拿 HANDOFF 的汇总行当准（它本来就是"摘要"，摘要会过期）。

#### 一处工具坑（写进 §九）

在 bash 里用 `node -e "..."` 改 docs 时，**字符串中的反引号会被 shell 当命令替换吃掉**：
本次 `'…（`.kojo` 为源 + …）'` 里的 `.kojo` 直接消失，写进文档成了"（ 为源 + 制品 ZIP…）"。
docs 里满是反引号代码跨度，这个坑命中概率极高。
→ **改 docs 一律落成临时 `.cjs` 脚本文件跑，别用 `node -e` 内联**；跑完即删。

#### 工作树纪律

rebase 前工作树里有**不属于本批**的在制品（`src-tauri/icons/` 的图标生成器改 PNG 驱动 +
`app-icon.png`，是别人/别的会话的东西）。没有提交它、也没有丢弃：
用带唯一标记的 `git stash push -u -m "notinthisbatch-icons-png-driven-20261012-2330"` 暂存，
rebase 完 `apply`（不 `pop`）确认原样回来后再 `drop`。

#### 验证（rebase 后全量重跑）

| 检查 | 结果 |
|---|---|
| `vitest run` | **1522 passed / 11 skipped**（算术闭合，见上） |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| `pnpm --filter @kojo/app build` | ✓ 43.38s，`compute-worker-*.js` 在位 |
| `cargo test`（src-tauri） | 12 项全绿 |
| 全仓冲突标记扫描 | 0 |
| `pnpm install --frozen-lockfile` | Already up to date（react peerDependency 软链在位） |

### 5.81 规则成本归位批 · 去掉两处"每次重算的常量"，并记一条负结果（2026-10-13 批）

> **触发**：§5.73 之后 touch 阶段校验自计 746ms，其中 `kx-placeholder` 387ms 是最大一块，
> 看上去像"这条规则在浪费"。**结论：它没有浪费，那笔钱是别人欠的。**
>
> 分支 `feat/ko-rule-waste-2026-10-13`，一个提交。承 §5.71 / §5.75 的同类纪律：假设要量，
> 量出负结果也照登。**编号让位（本组第六次）**：本批写作 §5.76，落地前 fetch 见口上线已占 §5.76–§5.80 ⇒ 让位 §5.81。

#### 一、成立的那半：协议里每次调用都重算的常量

`call-protocol.ts` 的两个查询函数都是**按函数名调用的**（回放面板按上千个函数名各调一次、
校槽覆盖规则对全库 99,104 个函数各调一次），而它们内部：

- `slotsFor` 每次 `[...rules].sort(...)` —— 比较器只用模板的常量字段，排的是同一份表；
- `maxForwardedSlotsFor` 每次逐模板重数 `int`/`str` 槽数 —— 槽数由模板决定，也是常量。

上提成协议实例的一次性预计算（`sortedBySpecificity` / `ruleSlots`）。协议对象随 `loadProject`
重建 ⇒ 预计算**天然随项目失效**，不需要任何额外的清空通道（与 §5.73 的 memo 相比更省一层治理）。
排序稳定性：V8 的 `Array.sort` 稳定，且比较器不变 ⇒ 一次上提与每次重排**结果逐位相同**。

#### 二、不成立的那半：`kx-placeholder` 的 387ms 不是浪费

给它加了 `_KX` 子串前置过滤。依据是可证的，不是启发式的：
`isPlaceholder` 为 true 在 `family-index.ts` 里**只有一个分支**（`169:` 那处），而该分支的入口
条件就是 `/_KX(?:_(|$))/` ⇒ 名字不含 `_KX` 时必然不是占位符。真实语料 99,101 个去重名里
占位符只有 603 个，于是这条规则从"替全场跑解析链"变成"只看 603 个候选"。

读数（同一支探针、同机同语料）：

| 阶段 | 规则 | §5.73 | 本批 |
|---|---|---|---|
| touch | `kx-placeholder` | 387 ms | **58 ms** |
| touch | `kojo-completeness` | 36 ms | **364 ms** |
| touch | `kojo-call-slot-coverage` | 231 ms | 238 ms |
| touch | 三条合计 | 654 ms | **660 ms** |
| cold | 三条合计 | 742 ms | 703 ms |

**净变化在噪声里。** 那 ~265ms 的"解析全库每个名字"不是 kx 的浪费，而是
`kojo-completeness` **本来就要付**的账——它要看每个角色声明过哪些面，必须解析每一个名字。
§5.73 的 memo 让第一个扫全库的规则替全场买单，而 kx 恰好在执行顺序里排前面，
于是它的读数看起来"很贵"。加了前置过滤后，账单回到真正需要它的人身上。

保留这处改动的理由**不是提速**，而是：① 绝对少做事（kx 不再为 98.7% 无关的名字跑解析链，
也不再 `find` + `filter` 两遍）；② 诊断口径变诚实——`lint breakdown` 现在把成本归到
真正需要它的规则上，下一个人不会再像我一样把"账单位置"当成"浪费"。

协议侧曾另加一层"名字 → 结果"的 memo，**同样实测无收益**（一轮校验里每个名字只访问一次），
已退；代码里留了一行注释说明它为什么被退，免得下个人再试一遍。

#### 三、正确性与读数口径

- **语料级等价**由集成冒烟守住：793 项、分规则 `form=8 / 槽覆盖=36 / KX=603 / 完整性=141 /
  messagecheck=2 / 重名=3`，与改动前逐项一致（`kojo-call-slot-coverage` 那条断言是 `toBe(36)` 精确值）。
- 合并到 §5.80 之后复测：**1530 passed / 11 skipped（1541）**、88 文件；root + app typecheck；
  解耦审计 A–D。本批**零新增用例**
  （两处都是等价改写，现有覆盖已够：`call-protocol.test.ts` 钉着 `slotsFor` 的优先级语义，
  `conventions.test.ts` 钉着"同名多处只报一条 + 共 N 处"）。
- 顺带核对并确认了 §5.74 的一条归因：抽取"扫描函数数"从 95,504 变 99,104 确实是 `16747f4`（§5.70）
  引起的——旧代码有一句 `if (stmts.length === 0) return;` 会让**无控制流的文件整个跳过计数**，
  §5.70 为了让空桶也能复用而删掉它，谓词/依赖四项逐字未变。他们的判断是对的，这里补一条交叉验证。

#### 四、下一批的真正靶子（本批把方向问对了）

touch 阶段端到端 2085ms 里，校验自计只占 ~660ms，而**两次快照的读盘 + `JSON.parse`** 才是主体：
索引 11.93 MB + 抽取 12.31 MB ≈ **24 MB/次开项目**。抽取快照的字节构成已量（下一批的输入）：
依赖固定槽占 57.4%，其中 `key`（2.22 MB）是 `dependencyKey(name, indices)` 的**纯派生值**、
可整块删掉在还原时反推；`name` 只有 1,176 种却被写 164,910 次；比较式文本只有 1,522 种却被写
141,024 次。理论空间 ≈ **−39% 体积**。


---

### 5.82 判据①发版样例批 · 全语法面长跑 `.kojo` + 覆盖率做成机器断言（2026-10-13 批）
> **编号让位（第八次；一夜之内第四次撞）**：本小节初写 §5.76 → 第一次 rebase 让位 §5.81 →
> 推送前 `git fetch` 发现并发线又落了「规则成本归位批」占了 §5.81 ⇒ 再顺延 **§5.82**。成因每次都一样：
> **取号发生在"写文档"那一刻，而并发线在"写完"与"推送"之间还在落地**。本仓现在的固定做法（§十二 跨组须知）：
> 提交前一刻 `grep -n "^### " docs/IMPLEMENTATION-LOG.md | tail -1` 现取最大号 +1，推送前再 `git fetch` 复核；
> **每次 rebase 之后必须重新取号**，不能只解 marker。

**用户要求**（2026-10-13）：判据①「`.kojo` 保存 → 编译 → 真实游戏可跑」的测试文件必须
**足够复杂、足够长、涵盖所有情景所有关键字**，不能是几行的简单样例。

**现状为什么不合格**：`MANUAL-CHECKLIST` §二的前置是一段**四行**kojo（`角色: 49` + 一句台词），
步骤 i 只看"那句台词出不出得来"——它验的是**保存链路**，不是**编译产物的可跑面**；
教学样例 `teaching-full.kojo`（133 行）虽然每种写法各一个，但它是**给人读的字典**：
写法之间不嵌套、不混排，也不覆盖"同文件多时机互相影响"的那一类问题（下面抓到的两个正是这类）。

**交付三件**：

| 件 | 内容 |
|---|---|
| `fixtures/sugar/release-check.kojo` | **353 行**：21 个时机分野逐项、`成否:` 四取值、`类型:` 四取值、别名四形态、嵌套控制流、表达式 `如果`/`当`、范围与取反、中文运算符九个逐个、行内条件/随机/心形四模式/着色块（含块内再套如果）、选项块三键（条目内嵌套 如果+着色+心形）、原生直通行、`@` 块内含 `FOR/NEXT`/`$标签`+`GOTO`/`#DIM`/`#DIMS`，以及一整段**英文关键字**块（`timing/if/elif/elseif/else/when/is/to/random/choice/cont/heart/notin/skip-scene/skip-kojo`） |
| `fixtures/sugar/release-check.expected.erb` | 产物 **778 行 / 73 个函数**（三件套 + 每个时机的包装三联 + MESSAGECHECK + SUCCESS），`RELEASE_GOLDEN_WRITE=1` 生成后人工过目 |
| `packages/kernel/tests/sugar-releasecheck.transpile.test.ts` | 真实链路（内核 + adapter 真实 CSV 字典 + 转译服务）两条用例：**覆盖率断言** + **转译/golden/结构断言** |

### 这批真正的价值：把"覆盖全不全"从人的记性挪进断言

覆盖率不是我去数规范章节，而是**从单一真源派生**：

- 关键字 = `keywords.ts` 的 `KEYWORDS`（转译器与编辑器补全共用那张表）→ 每个词形都必须在样例里出现；
  头部英文别名（`char`/`family`/…）**例外**并在注释里写明原因：一份 `.kojo` 只能声明一次头部，
  中英两套不可能同现，它们的等价性由 `transpile.test.ts` 的头部等价用例守住；
- 中文运算符九个、`续` 的各词形、`不在`/`notin`；
- **时机分野表** = adapter 的 `KojoFaceTable.faces` 的键（21 个），逐个必须写成 `时机 <分野>`；
- 命名参数 `成否:` 四个取值 + `类型:` 四个取值。

⇒ 以后**谁新增一个关键字或分野，只要没在发版样例里用过，守门直接红**。这与"尺子跟着能力长"
（§5.62/§5.67）是同一条纪律的另一种用法：前者管读多少，这个管写多少。

### 断言当场抓到的两个真问题（这是本批的净收益）

1. **同一个时机里写中文 + 英文同义子句**（`隐藏情景:` 与 `skip-scene:`）→ 生成两个**同名**
   `MESSAGECHECK_*` 函数 = 加载期重复定义。样例改为换编号（311 中文 / 315 英文）并注明原因。
2. **`时机 指令 310 成否: …` 与同文件独立的 `时机 成功 310：`** 会各自生成
   **同一个** `@M_KOJO_…_SUCCESS_COM_K145_310`，而**转译器一个诊断都不发**（现有
   `timing-duplicate` 只管"同划分野同编号"，管不到跨划分野撞生成函数名）。
   样例已按规避方式重写（`成否:` 用 316–319 四个编号，`时机 成功 310：` 单独保留），
   **转译器补诊断**另立任务（第 20 项），不在本批夹带。

为了让这类问题以后必然被抓，断言里加了**「产物函数名不得重复定义」**一条
（连同 IF/ENDIF、SELECTCASE/ENDSELECT、FOR/NEXT、`#FUNCTION`/`#FUNCTIONEND`、
PRINTDATA/ENDDATA 的**配对平衡**——"口上全哑"那一类事故的静态半边）。

### 角色号为什么是 145（实机可用性的一件事）

语料 168 个角色里 **155 个有前人口上目录**；145、155–158、161–168 号没有。选 145 作默认，
编译出的 `@M_KOJO_K145` 一族不会和别人的口上撞函数名；清单里写明"存档里没有 145 就只改
`角色:` 那一行"（三件套与所有函数名都由它派生）。

### 手工清单同步

`MANUAL-CHECKLIST-v0.4.0-beta.1.md` §二 重写：a–h 保留（保存链路），新增 **i0–i3** 以本样例为输入，
逐项列出**实机应看到的现象**（节奏/插值/控制流/选项三键菜单/演出四模式/开关与位协议/别名/
原生直通/注释），并给出"看到重复定义说明你把 `成否:` 和 `时机 成功` 同时写了"的排查提示。

### 验收

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | rebase 前本机 **1448 passed / 13 skipped**；rebase 到 §5.81 之后 **1530 passed / 13 skipped（1543）**——本批净增 0 passed（两个新守门是无语料时整组跳过，贡献 +2 skipped / +1 文件） |
| 语料三 gate（投影 / 教学 / 发版样例） | 全绿；投影读数与 §5.75 **逐字相同** |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `node tools/audit-decoupling.mjs` | A–D 全绿（16 插件） |
| 转译诊断 | 零 error **零 warning**（发版样例应当干净到没有告警） |

### 边界未做（明确记录）

- 判据①的**实机半边**仍待真机勾验（本机无 GUI 会话 / 无 `src-tauri/target`）；本批做的是
  "实机之前所有能机器证的部分"。
- 数据表（`PRINTDATA` 系）仍无糖写法 ⇒ 样例里没有数据表面（那是 §5.75 的规范决策，不是本批能补的）。
- 转译器"跨划分野撞同名函数"无诊断 ⇒ 任务 20。
- 发版样例的**运行时**行为（游戏里的实际显示）无法在本机断言，只能靠清单 i2-A…I2-I。

### 5.83 设置页归一批 · 分组分层 + 从属项降级 + 页脚房规（2026-10-13 批，用户反馈 8）

> **用户反馈 8**：「继续打磨设置页面。」**用户指派**（本批开工时）：「糖组的 UI 并不是他们的
> 长处，并且 UI 方面的优化也属于本组的工作……确保风格统一，『专业、克制、流畅、高效、耐看』。」
> 所以本批与 §5.76 同属**本组接管 UI** 这条线，不是给糖组补作业。

#### 改之前先说清"不打磨会怎样"（每条都是可指认的缺陷，不是审美偏好）

| 症状 | 为什么是缺陷 | 处置 |
|---|---|---|
| 4 个设置项平铺，混了三种关注点（视图布局 / 编辑器显示 / 一个动作按钮） | 没有层级的列表等于让读者自己归类；"重置布局"是个动作，却和开关长一个样 | 分「视图 / 编辑器 / 布局」三组，组间一条分隔 + 小号 dim 标题 |
| 「编辑器居中限宽」与「写作模式」**同级可点**，而写作模式关闭时它**什么都控制不了** | 给一个点了没反应的控件，比给一个明确不可用的控件更糟——前者让人怀疑自己操作错了 | 缩进一级作从属项；写作模式关闭时 `disabled` + 降透明度 + 提示改成「需要先开启写作模式」 |
| 「写作模式：编辑器居中限宽**（约 1000px）**」 | 把宿主自己的像素常量漏给用户；作者脑子里没有"1000px"这个量 | 改成「按一行正文的舒适宽度收拢」，px 从文案里消失 |
| 语法糖视图的说明写「仅对 .erb 生效（.kojo 本身就是糖）」 | **不准确**：按 ADR-0005，工作区里的 .ERB 恒可编辑、也不投影；真正生效域是"游戏目录里未解锁的那一份"。设置页写错口径，用户就会在错误的文件上找这个开关 | 按 ADR-0005 重写：「把**游戏目录里的** .ERB 显示成中文表层写法……只改显示、不改动文件」 |
| 两个 `settings-actions` div，「重置布局」与「完成」视觉同权重 | 全站模态房规是 **primary 恒为推荐项、排最右**（§5.76 已为糖组那版立过这条）；这里两个动作各占一行、都像主按钮 | 合成单一页脚行只留「完成」(primary 靠右)；「重置布局」归入「布局」组，并补一句「不影响任何文件内容」降低它的心理代价 |

**孤儿规则顺手清**：改完后 `.settings-actions` 只剩 CSS 自己引用自己（`git grep` 复核），删。

#### 分层的做法：靠缩进与分隔，不靠字号抢视线

「克制」在这里有具体含义：组标题用 `--fs-1` + `--fg-dim` + 一点字距，**不加粗不放大**；
组间用 `--border` 一条细线 + `--space-3`，不画卡片。若用大字号标题，设置面板会比它承载的
内容更显眼 —— 那是面板在跟用户抢注意力。

#### 实机所见（本批有视觉证据）

haruki 主机真实会话里打开设置面板：三组分层与分隔线正确；「编辑器居中限宽」**缩进一级、
复选框置灰、提示显示"需要先开启写作模式"**；页脚只有右侧一个蓝色「完成」；
「重置布局」在「布局」组里与其说明同排。

同一窗口顺带确认了 §5.76 那批的成果在真实使用中成立：工具条
`🔒 只读`（中性灰，非警示）、`语法糖视图`（accent 按压态）、`语法糖 198 行` 三项
在用户自己打开的 `M_KOJO_K4_イベント.ERB` 上渲染正确。

> ⚠ 该窗口当时**有用户未保存的标签**（`test.kojo` 带脏点）。所以本批只做了
> "开设置 → 截图 → 点完成关掉"这一条读路径，**没有**点「重置布局」、没碰标签、没改任何文件。

#### 推送纪律：本批是 §5.80 那条新口径的**第一次执行**

§5.80 记下"文档批最后写、最后推"之后，本批照做：代码提交 → rebase → 双 typecheck +
`vitest run` → **立刻推**（`4bff7c6..da2eca5`）→ 才回来写这一节。
效果立竿见影：本轮 rebase **零冲突**（上一轮为了编号返工过六条提交）。

另两条实况：① 别线两次占过 §5.76（「规则成本归位批」「判据①发版样例批」），
但**两次都由作者自己主动让号**（让到 §5.81 / §5.82），把 §5.76–§5.80 完整留给了我 ——
§5.80 立的那条口径开始双向生效，本组这五节因此不必再返工第三次。
② 本批是"文档最后写、写完立刻推"的**第二次执行**：代码提交 → rebase → 验证 → 推
（`a07f7eb..52c9bdd`）→ 才写这一节，全程 rebase 零冲突。

#### 验证

| 检查 | 结果 |
|---|---|
| typecheck root + `@kojo/app` | 双 exit 0 |
| `vitest run` | **1536 passed / 11 skipped**（1530 + 补测 6 条 reducer 断言） |
| `audit-decoupling` | A–D 全绿（16 插件） |
| `@kojo/app build` | ✓ 25.80s |
| 桌面壳实机 | ✓ 见上 |

#### 一个差点写进文档的假声明（值得单独记）

本批验证表初稿我写的是「设置项行为由 `layout.test.ts` 的 reducer 覆盖」——
听起来很妥帖。去核对才发现**完全是假的**：`reducer` 内联在 `ShellLayout.tsx` 里，
既没导出也没任何测试；审阅补测批覆盖了编排与清洗，唯独漏了动作本体，
而设置页改的正是这几个动作。

→ 处置不是把那句话改成"没测"了事，而是把 `reducer` 搬到 `layout.ts`
（它依赖的 `SIZE_LIMITS` / `LayoutState` / `ContainerKey` **本来就在那儿**，搬迁近乎零成本），
导出后补 6 条断言。**"顺手写一句合理的覆盖说明"是最容易蒙混过关的一种债**——
它读起来像已做完，于是再没人去补。凡在文档里声称"某处已被测试覆盖"，必须当场跑一遍那条测试。

### 5.84 BUG-5 文件监视批 · Rust notify 原语 + 内核去抖 + 监视状态判级（2026-10-13 批，发版判据②）

**用户指派**（2026-10-13）：「BUG-5 `file.changed` 真实监视器 + 去抖，请你接手」——
这是 `v0.4.0-beta.1` 的发版判据②（`HANDOFF` §十一）。

**原缺陷的形状**：`PlatformBridge.watchDirs` 在 Tauri 桥里是一个 `console.warn` + 返回空取消函数的
**占位实现**，全仓**没有任何生产代码调用它**；`file.changed` 只有一个生产者
（`kojo-sugar` 的升糖写回）和一个消费者（`EditorPane` 重载 model）。
于是"别人在外部编辑器里改了 ERB，编辑器会跟着变"这件事**从来没发生过**——
而所有单元测试都是绿的，因为测试桥（`NodeBridge`）早就实现了 `fs.watch`。
**这是本批最值得记的一条：契约与测试桥都齐了，唯独生产实现是空的，而没有任何一把尺子量得到。**

#### 分层落点（ADR-0003 逐条对齐）

| 层 | 做什么 | 不做什么 |
|---|---|---|
| Rust | `start_watch` / `stop_watch`：notify 递归监视，原始事件**逐条**转发 WebView | 不去抖、不合并、不判断"是不是自己写的" |
| 桥 | `listen('kojo:fs-changed')` ↔ `WatchCallback`；`start_watch` 回执 ↔ `WatchReport` | 不做任何判级 |
| 内核 | `FileWatcherServiceImpl`：去抖 / 末态合并 / 根折叠 / 会话竞态 / 广播 | 不认识"口上""存档"是什么 |
| 宿主 | 生命周期接线（project.opened 起、closed 停）+ 降级呈现 + `add`/`unlink` 消费 | 不改内容、不自动关标签 |

**生命周期刻意由宿主驱动、不在 `createKernel` 里自动起**：内核测试会开一堆临时项目目录，
自动起监视就留下一堆活句柄（vitest 退出被拖 + 制造无关事件）。
先例是同处的 `register_write_domain`——**宿主在 openProject 里注册 Rust 侧状态**早已是既定模式。

#### 契约演进（两处，都是 additive）

1. `watchDirs(paths, onEvent, **onReport?**)`：新增可选第三参收监视器**自述**。
   为什么必须加：旧契约只承载文件事件，于是"监视器自己起不来 / 只起来一部分 /
   运行期句柄没了"**在类型上无法表达**——静默失灵不是实现偷懒，是契约没给它留出口。
2. 新内核事件 `file.watchState`，登记在 **`KERNEL_ONLY_EVENT_NAMES`**（不进可 emit 白名单，
   所以白名单仍是 16，`events.test.ts` 的计数不动是设计结果，不是漏项）：
   与 `project.writableApprovalMismatch` 同类——**安全保证类事件由内核垄断发出**，
   插件伪造 `watching` 等于伪造"外部改动会自动重载"的承诺。

判级四态：`watching` / `partial`（部分根没监视上）/ `unavailable`（一个都没有 · 平台没能力 ·
运行期失效）/ `stopped`（显式停止，不是故障）。`partial` 与 `unavailable` 由宿主弹**常驻 error toast**。

#### 三条实测退化落点（能力 ↔ 尺子成对，撤掉必须红）

| 撤掉什么 | 红在哪 | 实测 |
|---|---|---|
| 会话号（`start` 不 `++session`） | `watcher.test.ts` 两条竞态用例 | ✓ 红（改回即绿） |
| 平台层不过滤原子写临时文件 | `watcher.realfs.test.ts` 第 2 条（一次保存只报一次） | ✓ **先红后修**：NodeBridge 原样透传 `.name.pid.ms.tmp`，测试当场抓到 |
| 去抖（逐条即发） | 「窗内多条并成一次」 | ✓ 结构性必然（一条变三条） |

窗口取 **200ms**，且**从首条事件起算、不随新事件重置**：重置版在持续写入的文件上会饿死
（永远不到期 → 永远不上报），这条写进了代码注释也写进了断言（每 100ms 来一条共 5 条，仍必上报两次）。

#### 真实链路怎么证的（以及证不了的部分）

- `watcher.realfs.test.ts` 走**真 `fs.watch`**：临时目录里写文件 → 断言去抖后恰好一条
  `file.changed`、路径是被写的文件、监视范围外的目录一条都不发。
  它专治"逻辑全绿而盘上一条事件都不来"——那正是 BUG-5 的原形态。
- **Rust 侧的 WebView 投递证不了**：`EventHandler` 实现要 `AppHandle`，单测里造不出 Tauri 运行时。
  所以本批 Rust 只对**纯映射**下了测试（类别映射 4 条 + 原子写临时文件识别 1 条），
  真实投递留给人工清单（`MANUAL-CHECKLIST` §2.J）。这一条是诚实边界，不是遗漏。
  （**下一批 §5.86 把这条边界往里推了一格**：递归监视本身已能在 Rust 单测里证明会投递事件，
  留在实机的只剩 `notify → WebView` 那一段。）
- 本机 `cargo` 是**冷启动**（`src-tauri/target/` 不存在），且 `cargo add notify` / `cargo fetch`
  必须走代理（`HTTPS_PROXY=http://127.0.0.1:7890`，与 git 推送同一约定）。已写进 §十二 跨组须知。

#### 消费方边界（本批刻意不做，已列为下一批）

`file.changed` 现在**真的会到达**了，但目前只有两处消费者：
1. `EditorPane`：已打开 model 的重载（本批补全 `add` / `unlink`，即 §5.46 记录的已知缺口）；
2. 其他什么都还没有——**外部改 ERB 后函数树不会自动重建**（`erb-parser` 只订 `project.opened`）、
   文件树 `dirCache` 不失效、归档列表不自动重扫。

为什么切在这里：索引重建是**全局**动作（真实语料冷建 2.4s），把"某文件变了"接成"整库重建"
需要单独量（快照复用率、去抖后的合并粒度、是否按文件增量），属于性能线的一整批；
塞进 bug 修复批里会得到一个"能自动刷但每次刷 2 秒"的东西，那不比不刷更好。

**事件风暴核查**：监视项目根是递归的，游戏运行写存档也会投递事件；
消费方第一动作是查 `entriesRef`（未打开直接 return），所以未打开文件一条事件的开销是
一次 Map 查找 + 一个定时器，没有 IO。

#### 验收

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1560 passed / 13 skipped（1573）**，90 文件过 / 7 跳 / 97 |
| 数字闭合 | §5.83 自记 1536 + 本批 24 条新用例（假时钟 21 + 真 fs 3）= 1560；skipped 13 里含 §5.82 无语料跳过的 2 条 |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `audit-decoupling` | A–D 全绿（16 插件）；Rust 测试里的路径字面量已改中性命名（`M_KOJO` 是 A 项硬禁词） |
| `@kojo/app build` | ✓ 26.19s（`@tauri-apps/api/event` 动态 import 正常入包） |
| `cargo test --lib` | **17 项全绿**（12 → 17） |
| 依赖 | 新增 `notify 8.2.0`（+ `notify-types 2.1.0` / `windows-sys 0.60.2` 传递依赖） |
| 桌面壳实机 | **未跑**（本机无 GUI 会话）——判据②的实机半边留清单 §2.J |

#### 教训（两条，都值得单独记）

1. **"契约有方法 + 测试桥有实现"≠"功能存在"**。这条缺陷在仓库里躺了几个月，
   期间所有跑测试的人都是绿的：因为量的是测试桥，不是生产桥。
   凡是"平台原语"类能力，验收必须有一条**打到真实实现**的断言
   （本批的形式是 `watcher.realfs.test.ts` + 人工清单，二者不可互相替代）。
2. **静默失灵的根因常常在类型上**。`WatchCallback` 只有文件事件一种形状时，
   "监视器没起来"这件事无论怎么实现都只能靠 `console.warn` 表达。
   补能力时先问"失败的形状有没有出口"，比先写实现更省事。

### 5.85 撞名诊断批 · 把「产物层重复定义」从守门断言变成作者看得见的错误（2026-10-13 批，任务 20 收口）

**来历**：§5.82 的发版样例守门里有一条断言「产物内不得有重复的 `@function` 定义」。
它当时就抓到了两组撞名（同时机里中英双写 `隐藏情景:` + `skip-scene:`；
`指令 310 成否:` 与独立 `时机 成功 310：`），但**转译器自己一条诊断都不发**——
只有我写在测试里的断言会红。也就是说：**问题已被机器发现，却没有交给作者**。

**为什么这是"缺口"而不是"边角错误"**：两种写法在 `.kojo` 面上看不出任何冲突
（分野不同、子句不同、编号看起来是同一件事的两种表达），渲染出的却是同一个
`@M_KOJO_SUCCESS_COM_K12_310`。引擎侧的后果是「重复定义」——**保存能成功、
产物能落盘、游戏里才炸**，而那时距离作者写错的那一行已经隔了一次完整的游戏启动。

#### 检查放哪一层：这是本批唯一的设计决策

放在**产物层**（Emitter 记账），不是写法层。理由是"写法面上看不出冲突"这句本身：

| 撞名来源 | 写法层要判它 | 产物层判它 |
|---|---|---|
| `成否:` ↔ 独立 `时机 成功/失败` 同编号 | 要枚举"哪个子句会额外生成哪个函数"的知识——而且这知识在 adapter 的模板表里 | 一行 `@NAME` 记账 |
| 同分野同编号写两次（`timing-duplicate` 声明了三年没人发） | 要判"同一个 timing 头" | 同上 |
| 原生直通 `@` 块与生成结果撞名 | 糖不是围栏，写法层根本不该知道直通块的内容 | 同上 |

⇒ **一个产物层后置检查同时覆盖三类**，且天然跟着模板表走：adapter 以后新增任何会重名的
模板，不需要在转译器里再加一条专项规则。

实现要点：
- `Emitter` 在 `push` / `pushRaw` 里对第 1 列的 `@NAME` 记账（`FUNCTION_HEADER_RE`），
  同名第二次出现即记 `DuplicateDefinition{first, again}`；
- **函数头本身是纯生成行、没有源行** ⇒ 引入 `setOwner()`：时机 / 原生块 / 三件套各设一次，
  让诊断能点到"作者刚写的那一行"。配色函数特意 `setOwner(null)`——它派生自头部声明，
  不该挂在最后一个时机身上（那是会让作者一头雾水的错指）。

#### 严重度选 error：判据是"产物能不能被用"，不是"写法丑不丑"

`error` ⇒ `planSave` 直接 `blocked: 'transpile-error'`，**不给半成品 .ERB 落盘**
（与 `timing-face-unknown` 的 fail-closed 同口径）。取舍写清楚：
`指令 310 成否: …` + `时机 成功 310：` 这种写法确实"意图明确"（作者想要成功分支另写一份），
但它的产物在引擎里是坏的——**能编译不等于能跑**。与其出一个 warning 让作者带着坏产物去开游戏，
不如停在保存点，用一句人话告诉他"这两行渲染成了同一个函数"。
（真正的下一步改进是**自动合并**——把独立的 `时机 成功 310：` 认作 SUCCESS 函数的正文而不是
再生成一个同名头；那是转译语义变更，属规范层，不在本批。）

#### 假阳性守门（这类"全局后置检查"最怕误报）

新增 12 条用例里 **5 条是不许报**的形状，其中最关键的一条：
**每个时机都产两行函数头 `@X` 与 `@X_1`**——若把 `_1` 也当同一个名字，全库皆红。
其余：只写 `成否:`、只写独立 `时机 成功`、不同编号、`类型:` 换通信段（COM vs SCOM）。
另有一条**真实语料级**的确认：`release-check.kojo`（353 行 / 73 函数）跑新诊断**零 error 零 warning**，
教学样例与投影读数逐字不变。

#### 一个测试自己写错的现场（记下来，因为它差点变成"代码有问题"）

"一次撞两组 → 应得两条诊断"最初只报一条。查下来是**我的样例串写错了**：
`时机 指令 311 成否: 一定成功` 后面漏了块尾的 `：`，那个时机根本没成立。
补上冒号即两条。**处置是改测试不是改代码**——同批还发现 `一定成功` 才是
adapter `successFlag.values` 的真名（我按记忆写的 `必然成功` 不存在），
于是"合法取值表"这件事又多了一次"别凭直觉，回去查表"的实证。

#### 契约

新诊断码 `function-name-duplicate` 加进 **`SugarDiagnosticCode` 闭集**（`plugin-api/src/sugar.ts`），
与 `timing-duplicate` 的分工写在了契约注释里：后者管"写法层面的同分野同编号重复"，
前者管**产物**。`plugin-api/tests/sugar.test.ts` 的闭集抽样同批登记。

#### 验收

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1572 passed / 13 skipped（1585）** = 上一批 1560 + 本批 12 条 |
| 语料三 gate（投影 / 教学 / 发版样例，带 `KOJO_SMOKE_PROJECT`） | 全绿；发版样例**零 error 零 warning**；投影读数不变 |
| typecheck root + `@kojo/app` | 双 exit 0 |
| `audit-decoupling` | A–D 全绿（16 插件） |
| 反证（退化落点） | 把产物层记账去掉 ⇒ 3 条"该报"用例全红；把 `_1` 也并进主名 ⇒ "不自撞"用例红 |

#### 教训

**"守门断言抓到了"不等于"能力存在"**。§5.82 的测试断言已经在报这个错了，
但它报给的是**跑测试的人**，不是**写 `.kojo` 的人**。同一件事从断言变成诊断，
差的只有那一条 `sink.report`——而它决定了这个错误是"我们知道"还是"作者知道"。

### 5.86 判据②补证批 · 把「Rust 侧证不了」改成「Rust 侧证到哪一步」（2026-10-13 批）

**动机**：§5.84 留下的边界写的是"Rust 侧的事件流证不了，`EventHandler` 要 `AppHandle`"。
这句话**只对了一半**——证不了的是 `notify → WebView 的 emit`，
而"**递归监视在这台机器上到底收不收得到事件**"根本不需要 WebView：
`notify` 的接收端可以是任意 `EventHandler`，一条 `mpsc::channel` 就够。
边界要划在真实的位置上，否则实机一旦出问题，我们不知道该怀疑哪一段。

**做了什么**（`packages/app/src-tauri/src/lib.rs` 新增 `mod watch_runtime_tests`，2 条）：

1. `recursive_watch_delivers_nested_create_and_modify`：临时根 → 建 `a/b/c/` 三层 →
   `RecommendedWatcher` + `RecursiveMode::Recursive` 登记根 → 在**最深层**写两次文件 →
   5 秒内在 channel 里收到一条落在 `payload.txt` 上、且经 `normalize_event_kind` 映射后
   属于契约三态（`add`/`change`/`unlink`）的事件。
   测的是**这一层唯一有判断的那段**（类别映射）+ 递归登记本身；接收端换成 channel 不改变被测量。
2. `mapping_covers_the_kinds_this_backend_actually_emits`：按 `notify/src/windows.rs`
   的实际投递形态（`Create(Any)` / `Remove(Any)` / `Modify(Any)` / `Modify(Name(From|To))`）
   钉住映射，后端换了类别也不该导致事件被吞。

**反证（退化落点，按本仓纪律实测过）**：把 `RecursiveMode::Recursive` 改成 `NonRecursive`
⇒ 第 1 条立刻红（深层写入收不到任何事件），改回即绿。**这条测试会失败，不是装饰。**

**踩到的一处 API 细节**（记下来省下一次）：`rx.recv_timeout()` 返回的是
`Result<Result<Event, notify::Error>, RecvTimeoutError>`——**双层 Result**，
且错误枚举是 `RecvTimeoutError::{Timeout, Disconnected}`，不是 `TryRecvError::Empty`
（那是 `try_recv` 的）。Timeout 要 `continue`、Disconnected 才 `break`。

**边界新表述**：留在实机的只有 `app.emit(...)` → WebView `listen(...)` 那一段
（事件名两端硬编码成对：`FS_CHANGED_EVENT` / `'kojo:fs-changed'`，**这是一处真实的脆弱点**——
Tauri 不检查事件名字符串，改一边会静默失灵。已写进人工清单 j1/j2 的判据：
"打开项目后没有红色通知"就是这段的哨兵）。

#### 验收

| 检查 | 结果 |
|---|---|
| `cargo test --lib` | **19 项全绿**（17 → 19） |
| 反证 | `NonRecursive` ⇒ 第 1 条红；改回 ⇒ 绿 |
| `vitest run` / typecheck / 审计 | 未受影响（本批**零 TS 改动**，只加 Rust 测试） |
| 命名合规 | 测试路径全用中性名（`payload.txt` / `a/b/c`）——`M_KOJO`、`個人口上` 是审计 A 项硬禁词，**连测试字面量都算** |

### 5.87 监视消费方批（上）· 归档列表自动重扫 + 为什么索引重建不在这一批（2026-10-13 批，任务 21 部分）

**背景**：§5.84 把监视器接通了，但当时写下的边界是"`file.changed` 现在真的会到达，
可除了编辑器 model 重载，没有任何别的消费者"。本批收掉其中**最便宜、零性能风险**的一条。

#### 收了哪条：外部往存档目录写档 → 归档浏览器自动重扫

三条设计约束，都是仓库既有纪律，不是本批新发明的规矩：

1. **首动作必须是廉价判定、零 IO**（§5.84 消费方核查时立的口径）：
   订阅者先 `isPathUnder(project.savDir, ev.path)`，不在存档目录里**直接 return**——
   监视根是整个项目目录，游戏运行时 PNG 缓存、别的 ERB、临时文件都会投递事件。
2. **合批交给内核池，不在插件里再写一个去抖器**：`kernel.compute.runLatest(key, …)`
   已有"单飞 + 尾缘合并"语义（且 `kernel/tests/compute.test.ts` 在守它）。
   本批只保证**用同一个 key**，于是"游戏连写三个档"最多跑两次目录扫描，绝不随事件数放大。
3. **`refresh()` 改成返回扫描的 Promise**：原实现是 `void snapshots.scan()…` 内部吞掉，
   对池来说"在途"根本不可见 ⇒ 单飞等于没开。**这是接线层最常见的一种假接入**：
   调了 `runLatest`，但因为没把真实工作的 Promise 交出去，池合并的是"发起"而不是"完成"。

面板提示文案顺手改了：`目录监视未实现，用「刷新」重扫` 从本批起是**过期声明**
（§5.84 之前就写死了），留着就是让作者信一件不再真的事。

#### 没收的那条：外部改 ERB → 函数树/索引自动重建

不是忘了，是**算过之后刻意不做**：

- 真实语料的既有读数（HANDOFF §十 / §5.81 一线）：**改一个 ERB 后重开 ≈ 2.1s**，
  而索引构建是**全项目**动作（`erb-parser` 只订 `project.opened`，`ensureIndex()` 里
  `if (index) return index` 直接短路）。把"某个文件变了"接成"整库重建"，
  等于给每次外部写入挂上 2 秒的主线程工作。
- 监视根是**整个项目目录**，游戏存档、图片缓存都算"外部写入"⇒ 不先做路径分野与合并粒度，
  自动重建会变成自动卡顿。
- 所以这条属于性能线的一整批（要量：快照复用率、按文件增量可行性、是否需要交互让路），
  塞进 bug 收尾批只会得到一个"能自动刷但每次刷 2 秒"的东西——那不比不刷更好。
  **候选表不是承诺表**（§5.71 的纪律，这次是它对我自己生效）。

#### 另一条刻意留在下一批：FileTree 的 `dirCache`

事实核查结论（动手前读的，不是猜的）：`dirCache` 是 `FileTree.tsx` 的组件私有 `useState`，
**没有任何失效通道**——`ensureDir` 是唯一的写者且 `dirCache.has(dir)` 直接短路；
"折叠全部"只清展开态、不清缓存。⇒ 要做"新建文件夹自动出现"必须**新增一个 prop/机制**穿到
`ProjectView → StableFileTree`（那层是刻意稳定的，防止重挂丢展开态）。
这是宿主 UI 改动而**本机跑不了 GUI**（判据③/④的实机半边本就欠着），
按"不能亲验的 UI 改动要显式说明"的规矩，留到能与实机勾验同批做，不在此空投一版没人看过的界面改动。

#### 守门与反证

| 用例 | 钉住什么 | 反证（实测） |
|---|---|---|
| 存档目录里的改动 → 经 `runLatest` 触发一次重扫 | 接对了服务、真的扫了 | — |
| 目录**外**的改动 → 连 `runLatest` 都不问 | 首动作零 IO | 去掉 `isPathUnder` ⇒ **2 条立刻红** |
| 三个事件 → **同一个 key** | 合批靠池，不靠插件里再造去抖 | 改成每次算新 key ⇒ 红 |
| `savDir` 缺省 → 不扫 | 无存档概念的项目不瞎扫 | — |
| 退订后 → 不扫 | dispose 面干净 | 漏 `onDispose` ⇒ 红 |

计算池在测试里用**零调度直跑替身**（审计 B 项禁止插件测试 import `@kojo/kernel`，
先例与理由见 `erb-parser/tests/support.ts` 头注）——本批测的是**接线**，
合并语义由内核自己的池守，不在插件测试里重做一遍实现。

#### 验收

| 检查 | 结果 |
|---|---|
| `vitest run`（不带语料） | **1577 passed / 13 skipped（1590）**，91 文件过 / 7 跳（98） |
| typecheck root（+ app 同批已过） | exit 0 |
| `audit-decoupling` | A–D 全绿（16 插件）；测试未 import 内核 ⇒ B 项绿 |
| 反证 | 见上表，全部当场跑红再改回 |
| 实机半边 | 归档列表自动重扫需 `pnpm tauri dev` 勾验（清单 §2.J **j9**） |

### 5.88 落盘引导批 · 「新建口上文件」落点改口上项目 + 无项目岔口（2026-10-13 批，用户反馈 3）

> **用户反馈 3（原文照录）**：「优化"新建口上文件"落盘位置逻辑，a：如果还没创建口上项目，
> 就弹窗提示还没新建口上项目，提示是否新建项目，a1：如果是，跳转到新建项目弹窗，
> 新建项目后，自动新建 kojo 文件到项目位置，a2：如果选择否，就自行选择保存文件夹，
> 然后新建单个 kojo 文件。」

**一句话**：Ctrl+N 的落点从**游戏目录的角色口上目录**换成**口上项目里的作者包**；
"还没有口上项目"从死路改成一个岔口——主选「新建口上项目并创建」（建完自动把作者正在填
的那份 `.kojo` 落进新项目的包里），备选「选择文件夹另存…」（系统保存对话框，单文件）。

#### 为什么把常态落点也一起改了（反馈只点名"没有项目"那一支）

反馈的小标题写的是「落盘位置逻辑」，而旧向导的落点只有 `chara.kojoDir` 一种，
于是它自带三处与既定口径相反的别扭：

| 旧状 | 与什么相冲 |
|---|---|
| 面板顶部常驻「工作区为权威 · 游戏目录仅部署目标」，Ctrl+N 却把新文件直写游戏目录 | 同一屏两条相反的规矩（讨论纪要 §2 定调的正面对撞） |
| 落点未批准写权限时，向导里挂一条「写权限未批准：请先在状态栏点击『只读』徽章完成授权」 | 作者读作"这功能坏了"；授权动作被塞进创作动线中间 |
| 角色没有 `kojoDir` 就直接排除（「请先在游戏目录中创建」） | 又一条死路，且要求作者手工动游戏目录 |

改完三条同时消失，`.kojo` 也终于接上导出/部署线（§5.77：工作区里只有 `.kojo` 这一份源，
出游戏目录才转 `.ERB`）。**这不是删功能**：想直接改游戏目录，路径仍是文件树 + 写权限批准；
想把既有包变成可导出/可部署的形态，走导入（§5.49 P-F）。

#### 契约演进：两个语义事件（都 additive），以及一次被审计拦下的捷径

| 事件 | 载荷 | 谁发 | 谁收 |
|---|---|---|---|
| `workspace.newProjectRequested` | `{ requestToken?, source? }` | `ui-sugar-editor`（无项目岔口的主选） | `eratw-adapter` → 记号 + 开自己的向导 |
| `workspace.projectCreated` | `{ projectId, requestToken?, source? }` | `eratw-adapter`（向导创建成功 / 导入向导的"新建项目"分支） | `ui-sugar-editor`（兑现挂起意图）· 未来任意消费方 |

可 emit 白名单 **16 → 18**（`events.test.ts` 快照与计数同批改）。

**本批最实在的一次返工**：初版照 `WellKnownCommands` 的先例，在 plugin-api 加了
`WellKnownOverlays.NewKojoProject = 'eratw.newKojoProject'`，让糖侧直接 `ui.overlay.open`
对方的模态。`node tools/audit-decoupling.mjs` **当场判红**：

```
[A(内核零游戏知识)] packages/plugin-api/src/slots.ts:235
    NewKojoProject: 'eratw.newKojoProject',
```

门禁不是在碍事——**契约层写下某个适配器插件的模态名，等于让"一切皆插件"反过来依赖某个游戏**，
第二个适配器接不上、改名时另一端静默失效。换成语义事件后：发起方不知道也不必知道对方那个
向导叫什么，审计回到全绿，且同一意图天然可被别的适配器认领。
顺手把一条早已存在却没写进文字的事实钉进 `ui.overlay.open` 的注释：
**payload 不会送到组件手里**（组件无 props，读的是拥有插件的闭包——`pendingImport` /
`pendingDeploy` 就是这个模式），要跨插件递东西走语义事件，别把 payload 当参数用。

#### 关联号（requestToken）：两拍之间必须有根线

a1 天然是跨插件的两拍：糖侧把作者正在填的那份存进闭包 `pending` 并请对方开门，
对方建完项目广播，糖侧才落盘。**只看"有没有建项目"就落盘**的失败形状很具体：

> 作者按下「新建口上项目并创建」→ 在项目向导里看了两眼点了**取消** → 改天从面板
> 「＋ 新建」正常建了一个项目 → 那个新包里冒出一份 `M_KOJO_K12_破空自制.kojo`，
> 带着上一次没做完的家族名。作者从没要过它，也没在任何按钮上确认过它。

于是三条规矩：**请求带号** → **兑现只认同号那次创建** → **向导一关就把号清掉**（`plugin.ts`）。
判据是不对称的代价决定的：误判"有人在等" = 工具替作者做决定（毁信任）；
误判"没人等" = 作者多重开一次向导（一次点击）。配套两条纪律：
`readRequestToken` **只认明确形状**（非对象 / 空串 / 字段名打错 / 类型不对一律 null，4 条单测钉住）；
导入向导那条"新建项目"分支同样广播但**不带号**——事件要说事实，与入口无关。

#### 三条写路径，全部不覆盖

| 路径 | 落法 | 失败/取消的形状 |
|---|---|---|
| 工作区落点（常态） | `io.writeText`（工作区根 = 常驻可写根，无需授权动作） | 同名已存在 → 「已有同名文件，未覆盖：X.kojo」，红字常驻等作者读 |
| 另存到自选文件夹（a2） | `io.exportFile(fileName, BOM+UTF-8)` —— **对话框即授权**，落点由用户在系统对话框里定，JS 拿不到决定权（白名单外唯一合法通道） | 取消 → `{ok:false, cancelled:true}`，**不弹红字**（取消不是失败） |
| 交给项目向导后自动落盘（a1） | 同第一条，落点 = 新项目里最近创建的包 | 失败 → 一次性 notice + **把作者请回向导**（没有对话框可挂错误，静默等于没发生） |

第三条路径的"新项目里还没有作者包"单列：不猜落点、不自动造包——
包名是组织决定（脚手架在建项目时一并定），工具不在作者没开口时替他建结构。

#### 编排为什么从组件里搬出来（`new-file-flow.ts`，258 行新文件）

`ui-sugar-editor` 的 devDeps 只有 react（**没有 react-dom**），面板组件在这些包里
点不动按钮；而本批真容易坏的东西全在时序里（挂起配对 / 不覆盖 / 取消不算失败 / 失败可见）。
先例是同仓 `eratw-adapter/src/package-actions.ts`：**插件只接线，逻辑不渲染面板也能单测**。
组件侧只留形态变化：新增项目/包两级落点（**只有一项时不出下拉**——落点预览那行已经把
"写到哪儿"写明白了），删掉 `io.isWritable` 预检与两条死路提示。
`requires` 从 4 项变 5 项（+ `kernel.workspaces`，内核常驻服务，恒在）。

#### 验收（每项都本机实跑）

| 项 | 结果 |
|---|---|
| `pnpm test`（不带语料） | **1604 passed / 13 skipped（1617）**，93 文件过 / 7 跳（100） |
| 数字闭合 | §5.87 自记 1577 + 本批 27 条（`new-file-flow.test.ts` 22 + `new-project-wizard.test.ts` 4 + `integration.test.ts` 接线 1）= **1604** ✓ |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿（**中途红过一次**，红的是本批自己引入的契约层游戏词，见上） |
| `pnpm --filter @kojo/app build` | ✓ 1m05s |
| 语料 gate（动过 adapter，故真跑） | `attribution.corpus` + `call-slot-coverage.corpus` **2 passed**（155 角色抽取基线逐字、口上域覆盖规则结构稳定） |
| 反证（撤掉能力看谁红） | 撤关联号配对（`requestToken !== held.requestToken` 恒假）→ **2 条红**（「号不对」「不带号」）；撤覆盖保护（`exists` 判断恒假）→ **1 条红**（「同名已存在」）；两处均已改回并复跑全绿 |
| 桌面壳实机 | **本批未跑**（写这张表时先按"本组没有实机半边"登记，随后自查发现不成立：§5.79 起本组主机已三次起壳目视）。已登记 **QA-1** 供别机复验，**本组将在 HK-5 批用真壳目视本流程**（三键顺序 / 取消后不冒文件 / 落点显示工作区路径） |

#### 同批落地的跨主机协作（用户 2026-10-13 指派）

用户指定"另一台主机有一个具备完整实机能力的 agent，持续认领我们写进文档的测试工作"，
并要求分工方案"在文档里谈完"。本批起：

- **新增 `HANDOFF` §十三 跨主机协作看板**：能力边界表 + 认领协议（一行一任务、自带判据、
  认领即改行并推送、回执写回同一行）+ A/B 两张任务表（QA-1…QA-9 交实机线，HK-1…HK-5 本组）。
- **接了实机线留在文档里的两条活**：§5.87「没收的那条」= 函数树增量重建 → **移交性能线**
  （他们的算账成立：全项目重建 ≈ 2.1s，不先定增量粒度就是"能自动刷但每次刷 2 秒"）；
  §5.87「刻意留在下一批」= `FileTree` 的 `dirCache` 无失效通道 → **本组认领为 HK-5**
  （他们说"这是宿主 UI 改动而本机跑不了 GUI"——宿主 UI 正是本组范围，实机半边挂 QA-9）。
- **工作树纪律（§十二-6）**：本批开工时在本机共用工作树里做过一次 bare `git stash`，
  卷走了并发写者正被编辑的 `docs/ARCHITECTURE.md` / `docs/USER-GUIDE.md`（几秒后那两个文件
  又被写回另一版内容 ⇒ 同一棵树里确有第二个写者，且它不走 git）。被卷走的那版已落成
  `.git/concurrent-docs-wip-2026-10-13.patch`（551 行，只含 docs）可取回；
  本批此后**全部在独立 worktree `C:\DSH\kojo-fb3` 完成**（`pnpm install` 走本地 store 实测 8s）。
  规矩：并行 agent 各开 worktree；共用工作树里禁 bare `git stash`；提交只 `git add` 自己动过的路径。
  ⚠ 本次并发写者的身份未查明（既不是本会话也不是远端来的提交），已在 §十二-6 留证；
  若它其实是"实机线跑在本机的第二个会话"，看板的 A/B 表就是它的收件箱。

### 5.89 抽取快照 v4 · 删派生 `key` + 名字字典：体积 −26.8%，**探针通道里**热路径没动（2026-10-13 批：这条结论的同批实机复测见 §5.90）

> **触发**：§5.81 把靶子定在"两次快照的读盘 + `JSON.parse` ≈ 24 MB/次开项目"，并量出抽取快照里
> `key`（2.22 MB / 18%）是 `dependencyKey(name, indices)` 的纯派生值。本批照这个靶子做完 v4。
> **结论先说**：编码是等价的、体积真砍掉了 27%，**但水位一格没动**——那 366ms 不是字节数买的。
> 分支 `feat/extract-snapshot-v4`。
>
> **编号让位（本组第五轮：一夜之间 §5.82→§5.86→§5.89）**：初写 §5.82；第一次 fetch 见上游占 §5.82–§5.85 ⇒ 顺延 §5.86；
> 第二次 fetch 见 §5.86/§5.87 又被占 ⇒ 顺延 §5.88；**第三次 fetch（就在推送前几分钟）见 §5.88 再被占
> （落盘引导批）⇒ 最终落 §5.89**。同批的实机复测节随行走私到 **§5.90**。
> 口径固定：**取号只在写小节时看「tail -1」不够，rebase 之后、push 之前必须再 fetch 一次并重编号**。
> 教训写进 §十二-1：**取号之后、推送之前必须再 fetch 一次**，隔了十几分钟也不算新。
> 上游同时把 §5.74/§5.75 留在了文件末尾（他们那批是在乱序版本上追加的），本批的重排随 rebase 一起带过去。
> 承载本批的提交信息里写的是旧号 §5.82（且只提到 §5.82，未提本节随行的 §5.90）——本段即映射，不回改提交。
>
> **同批修回一处本组自己造成的文档缺陷**：此前 §5.74/§5.75 让位改号时，重排脚本把这两节挤到了
> 文件末尾（顺序变成 …§5.81 → §5.74 → §5.75）。本批把它们移回 §5.73 与 §5.76 之间，并核对移动
> 前后**行集逐行相同**（`sort` 后 diff 为空、行数 4898 不变）——只动位置，不丢内容。
> 另记一条工具坑：本仓文档追加**不要用 Git-Bash 的 `cat >> file <<'EOF'`**——这一发把 4,898 行的
> 日志首部覆盖掉了（靠事先的 `.local/log-backup.md` 复原，`git show HEAD:… | cmp -` 确认备份与
> HEAD 逐字节相同后才动手）。用 `fs.appendFileSync` 或 Edit 追加。

#### 一、v4 删掉的是什么，凭什么能删

`StateDependency.key` 由 `dependencyKey({ name, indices })` 生成，定义就是
`indices.length === 0 ? name : name + ':' + indices.join(':')` ⇒ **纯派生值**，落盘即冗余。
真实语料 164,910 条依赖逐条核，0 例外。

- 依赖元组 7 槽 → 6 槽：`[nameIdx, indices, count, firstLine, comparisons, schemaIdx]`；
- `name` 全库只有 **1,176 种**却被逐条写 164,910 次 ⇒ 进 `names` 字典（与既有 `schemas` 字典同构）；
- **不变式守卫写在编码里**：`encodeBuckets` 对每条依赖先断言
  `d.key === dependencyKey({ name: d.name, indices: d.indices })`，不符 ⇒ **抛错、停止缓存**，
  而不是静默还原出一个错 `key`。理由："key 可删"不是一次性的观察，而是一个**需要一直成立的前提**——
  将来谁给 `dependencyKey` 加了第三个输入，这里会立刻炸给他看，而不是让快照悄悄吐出错 key；
- 格式版本 3 → 4，存储键仍是固定槽位 ⇒ 旧 v3 文件下一轮读出即判不符、删除、覆盖，不留孤儿。

#### 二、体积：模拟 −29.5%，实测 −26.8%，以实测为准

| 抽取快照 | v3 | v4（实测） | v4（离线模拟） |
|---|---|---|---|
| 体积 | 12.31 MB | **9.01 MB** | 8.68 MB |

模拟比实测少 0.33 MB（模拟按字段串长累加，不含元组自身分隔符那部分口径）。
**结论一律以实测为准**——与 §5.75"推的数不等于量的数"同一类账。

**等价性不靠眼睛看**：真实语料跑完，`keysDigest 1c85ae8c0e1256` / `contentDigest 0c357d324fd294` /
`tagged 109742` 三项与 §5.70 时代的读数**逐字相同** ⇒ 砍掉的确实全是冗余字节，还原出的抽取内容一字未变。

#### 三、读数：热路径**没有变快**（本批的负结果）

| 口径 | v3 | v4 |
|---|---|---|
| 抽取快照体积 | 12.31 MB | 9.01 MB（**−26.8%**） |
| 抽取段（touch 复用轮） | 349 / 363 ms | **366 ms** |

体积砍掉 27%，水位读数只落在噪声之上一点 ⇒ **没有提速**。于是把这 366ms 拆开量：

| 分段 | 耗时 | 占 366ms |
|---|---|---|
| 读盘（9.01 MB） | 36 ms | 9.8% |
| `JSON.parse` | **138 ms** | 37.7% |
| 还原成 `FunctionConditions` 对象 | **126 ms** | 34.4% |
| 其余（编排 / 桶合并，按残差） | 66 ms | 18.0% |

**约 72% 花在"解析 + 造对象"，字节数只买得到读盘那 36ms。** 这既解释了为什么砍体积不动水位，
也把下一刀定了下来：要动的是"**每轮开项目把整包反序列化成对象**"这件事本身，而不是继续找字典。
§5.81 结尾"读 24 MB 才是主体"方向对、归因错——贵的是"把它变成 JS 对象"，不是"它在盘上多大"。

#### 四、顺手量到的新靶子：回写那一发同步序列化

同一次探针量到写侧：`encodeBuckets` 24.3 ms + `JSON.stringify` **91.5 ms**，两者都在**主线程同步**
（`save()` 里 `storage.set(key, encodeBuckets(...))` 的实参必须先算完，才轮到异步落盘）。
合计 ~116ms，而**每次保存文件**都会走到 ⇒ 这正压在"打字→保存→徽章/校验刷新"那条高频路径上，
转 #20 / #22 一并量。

#### 五、验证与代价

| 项 | 内容 |
|---|---|
| 代码 | `condition-extractor/src/snapshot.ts`（编解码 7→6 槽、`names` 字典、不变式守卫、头注"四版演进 + v4 读数"） |
| 测试 | `snapshot.test.ts` 版本断言改 4；新增 6 项：盘上无 `key` 槽且还原 `key` 恒等派生式（逐条核）· `name`/`indices` 含冒号安全 · `key` 非派生值 ⇒ encode 抛错 · `nameIdx` 越界判死 · v3 形态混入判死 · 缺 `names` 判死 |
| 基线 | **1533 passed / 11 skipped（1544）**；root + `packages/app` typecheck 双 0；解耦审计 A–D ✅ |
| 探针 | 真实语料"体积 / 内容指纹 / 分段成本"各一轮，跑完**同批删除**；`.local/probe-appdata` 清空；语料 mtime 核对回到 `1774621472000` |

#### 六、下一批（**本批落地后随即被 §5.90 的实机读数改写了优先级**）

1. ~~#22 少反序列化一点~~ → **先看 §5.90**：真实 app 里热开三段水位是 6.4s / 10.5s / 10.6s，
   是这里 366ms 的两到三个量级——**探针通道与用户通道不是同一个成本剖面**，本批的
   下一刀砍反序列化在真实 app 的账上排不进前三。
2. **#24 真实 IPC 读文件通道**（§5.90 定下来的头号靶子）：每读一个文件两趟 IPC + 双向 base64。
3. 仍欠的 #20（打字→保存→刷新，本批量到的 ~116ms 同步回写）与 #21（抽取上并行通道）——
   两者的量法一律换成真实 app 水位。

### 5.90 实机复测批 · 真实 app 里三段水位是内核探针的 9–45 倍 —— **本组前四批量错了通道**（2026-10-13 批：零代码改动）

> **触发**：§5.89 落地前自查一件本组一直没查的事——**这些缓存在用户真正运行的 Tauri 进程里
> 到底落没落盘、有没有被读到**（前面四批的收益全部量自 vitest + node bridge 探针）。
> 答案是"落了、也复用了"，但同一趟实测把本组的**共同前提**打掉了：真实 app 的三段水位
> 是探针读数的 **9–45 倍**，热开仍要 **10.5 秒**。
>
> **读数来自 `pnpm tauri dev`（未打包）**；打包版是否同量级待验（IPC 序列化路径相同，
> 但 dev 有 Vite 首屏转换的额外噪声——三个水位都从 `project.open` 起算，已尽量避开）。

> **编号**：本节初写 §5.84 → 让位 §5.87 → 再让位 **§5.90**（与 §5.89 同批）。

#### 一、方法（只读，语料零写入）

CDP 直连真实窗口（复用 `tools/smoke-tauri-ipc.mjs` 那条 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
通道），点"最近打开"进真实语料（2,285 个 ERB / 99,104 函数），从 `__kojoPerf` 读三个水位、
从 console 读各段自计，同时轮询 `%APPDATA%\dev.kojo.editor\store` 看快照落盘。
**不点「允许写入」、不改任何语料文件**；`recent-projects.json` 播种后还原。
同一会话里"关闭项目 → 再开"，把首轮与稳态分开。

#### 二、好消息：缓存确实落盘，也确实被复用

| 观察 | 值 |
|---|---|
| 抽取快照落盘 | `condition-extractor/extract-snapshot-v1.json` **9,443,607 B** ⇒ §5.89 预估的 9.01 MB 在真实 app 里兑现 |
| 索引快照 | `erb-parser/index-v3-03ca26bb.json` 12,506,237 B |
| 校验快照 | `convention-linter/lint-report-v1.json` 1,404,235 B |
| 抽取自计 | 冷 **93,139 ms**（重算 2,285 文件）→ 热 **29 ms**（复用 2,285 / 重算 0） |
| 校验自计 | 冷 75,677 ms → 热 4,164 ms（七条规则全部标"复用"） |

按文件分桶这套机制**成立**，收益是真的。

#### 三、坏消息：水位对不上，而且是量级上的对不上

从 `project.open` 起算：

| 水位 | 真实 app（冷：有索引快照、无抽取快照） | 真实 app（热：三段快照齐全） | vitest 内核探针同段 |
|---|---|---|---|
| `index可用` | 6,486 ms | 6,397 ms | ~2.4 s 冷 / 541 ms 热（§5.65） |
| `条件可用` | **100,135 ms** | **10,535 ms** | 11.3 s 冷 / 366 ms 热（§5.89） |
| `校验有结果` | 82,164 ms | 10,562 ms | 9.9 s 冷 / 746 ms 热（§5.73） |

**热开 10.5 秒**——用户那句"体感接近 10 秒"就是这么来的；而 §5.89 的账上只有 366 ms。
（冷开里"校验 82s < 条件 100s"是两段并发、各自先到，不是笔误。）

#### 四、钱花在哪儿：每一次读盘都要过**两趟 IPC、双向各一份 base64**

索引自计（热开）：`walk 142ms · stat 2,025ms · snapshot 4,120ms（get 4,084ms, coerce 36ms）·
read+parse 0ms · aggregate 105ms · reused 2285/2285`。三个数各自说明一件事：

- **读一个 12.5 MB 快照 = 4.1 s**，而 node bridge 读同一份文件只要 74 ms（§5.65）⇒ **约 55 倍**；
- 热开 `条件可用 − index可用 = 4,138 ms`，正好是"再读一份 9.4 MB 快照"的量级 ⇒ 热路径 10.5 s 里
  **约 8 s 是两份快照过 IPC**，解码与造对象都排不上号；
- `stat 2,025 ms` = 2,285 次**串行**逐文件 IPC stat（≈0.9 ms/次），一次都没省。

根因在桥的两行（`packages/app/src/bridge/tauri-bridge.ts:14` 与 `:87`）：

```
readText = bridge.readFileBytes(path)   // read_file_bytes：整个文件 base64 传过界（1.34×）
         + bridge.decode(bytes, enc)    // decode_bytes：把同一份字节**重新 base64 送回 Rust**只为解码
```

Rust 解完再把文本传回来。于是每读一个文件 = **2 趟 IPC + 3 份跨界拷贝**。
而编码判定本来就是纯 JS（`kernel/src/encoding.ts` 的 `probeEncoding` 内部已用 `TextDecoder`），
测试用的 node bridge 也一样（`tests/helpers/node-bridge.ts:154` 就是 `new TextDecoder(...)`）——
**只有真实 app 这一条路多跑了一趟 IPC**。

⇒ **本组前四批（§5.65 / §5.70 / §5.72 / §5.73 / §5.89）优化的都是 node bridge 那条通道，
用户跑的是另一条。** 所有"水位"数字都低报了一个量级。

#### 五、对 §5.89 的自我更正：在真实 app 里，压体积**就是**压墙钟

按 4.1 s / 12.5 MB ≈ **0.33 s/MB**，v4 的 12.31 → 9.44 MB 大约值 **0.95 s/次开项目**
（**估算，非 A/B 实测**——要坐实得回退 v3 再跑一次同机同语料）。
所以 v4 该留；错的不是"瘦身"这个动作，是**拿探针的读数去判断瘦身的收益**。
§5.89 里那句"约 72% 花在解析 + 造对象，字节数只买得到读盘那 36 ms"在 node bridge 下成立，
在真实 app 下"读盘"这一项本身就是秒级——**同一份代码，两条通道的成本剖面不是同一个形状**。

#### 六、下一批（#24，按收益排，验收口径一律换成真实 app 的三个水位）

1. **`tauriBridge.decode` 改 `TextDecoder`**：去掉每文件第二趟 IPC。
   **零 Rust 改动**，不碰"Rust 只做 IO 原语、零业务逻辑"的红线；语义与 node bridge / 现有
   编码金样本同源（`utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` / `shift_jis` 全在 WHATWG 表内）。
2. **`readFileBytes` 用 `responseType: 'arraybuffer'`**：字节以二进制过界，不再 base64 膨胀 1.34×。
3. **批量原语**（`read_many` / `stat_many`）：把 2,285 次串行 IPC 压成少数几次。
4. 快照落盘/读取的**口径复核**：`erb-parser` 的快照键仍带指纹后缀（`index-v3-03ca26bb.json`），
   与 §5.65"收口成单文件语义"的说法要对齐——本批只记录现象，不结论。

#### 七、代价与纪律

| 项 | 内容 |
|---|---|
| 代码 | **零改动**（本批只测量与更正） |
| 探针 | `.local/inapp-probe2.mjs`（CDP + store 轮询），跑完删除；语料**零写入**、`recent-projects.json` 已还原、写权限弹窗未点 |
| 文档 | 本节 + §5.89 的"下一批"改口 + HANDOFF（基线 / 派生缓存纪律 / §十 首选 / 坑表）同步 |
| 教训 | **量在用户跑的那条通道上**。vitest 探针能验机制（复用率、指纹等价），不能验体感；体感只有真实 app 的数字算数（§八 新增一行） |

### 5.91 看板 HK-5 批 · 文件树目录缓存的失效通道 + 工作区根进监视（2026-10-13 批，接实机线留在文档里的活）

**触发**（两条，都是"从文档里接下来"而不是本组自己排的）：
1. §5.87 明记 **「刻意留在下一批：`FileTree` 的 `dirCache` 没有任何失效通道……
   这是宿主 UI 改动而本机跑不了 GUI，不能亲验的 UI 改动不空投」**——宿主 UI 正是本组范围（§十二 分工表），
   于是这条从他们的"不做清单"变成本组的看板行 HK-5；
2. 用户 2026-10-13 指派：**实机线持续认领我们写进文档的测试工作，我们 likewise**，分工"在文档里谈完"
   （⇒ 本批同时开出 `HANDOFF` §十三 看板，见 §5.88 第三节）。

#### 一条链路五个环节，每个环节只有一个负责人

```
Rust notify ──▶ 内核 FileWatcherServiceImpl ──▶ kernel.bus 'file.changed'
                 （200ms 去抖 / 末态合并，§5.84）        │
                                                       ▼
                                     ProjectView：affectsKojoTree(ev.path, project.kojoPaths)
                                                       │  ← 首动作零 IO
                                                       ▼
                                     createEventCoalescer(400ms 尾缘，不重置)
                                                       │
                                                       ▼
                                     setTreeNonce(n+1) ──▶ <FileTree refreshNonce>
                                                       │
                                                       ▼
                                     dirsToRelist(展开中的子目录 ∪ 已点开的包) ──▶ fetchDir
```

三段新逻辑全部是**纯函数**（`affectsKojoTree` / `createEventCoalescer` / `dirsToRelist`），
住的地方：前两个进 `external-change.ts`（那本来就是"外部写盘后的宿主决策"模块），
第三个进 `FileTree.tsx` 并导出——组件里剩下的只有"把三者接起来"这一层胶水。

**四条口径**（每条都对应一次可能的坏法）：

| 口径 | 为什么 |
|---|---|
| 分野用 `isPathUnder`，不用字符串前缀 | 语料里真实存在 `個人口上` 与 `個人口上备份` 这类兄弟目录；前缀判据会把不相干的根一起刷，反过来也会漏 |
| 合批窗口从**首条**事件起算、**不随后续事件重置** | §5.84 在内核去抖器上实测过：重置版在持续写入流里永远不到期 ⇒ 作者看到的还是"没自动出现" |
| 只重列**正在显示**的目录 | 折叠着的等下次展开惰性取；为看不见的东西打一圈 `listDir` 是纯浪费，而"展开全部"之后可能有几十个目录 |
| 展开态**不是**缓存的一部分，失效绝不碰它 | 用户反馈 7 的整树抖动就是"把现场当缓存一起重挂"（§5.56）；这条是同一个坑的另一个入口 |

#### 本批自己引入的两个风险，就地封掉

做了失效通道，就等于给这棵树加了一条它从来没有过的执行路径——风险是新造的，不能推给"以前没这问题"：

1. **每次 Ctrl+S 整棵树闪一下空白**。保存也是一次外部改动（写盘 → 监视器看见 → 失效重列），
   而重列若把已有内容换成 `'loading'`，屏幕上就是「读取目录…」。
   改法：`fetchDir` 只在**该目录没有内容时**才写 `'loading'`；重列时旧列表原地留着，新结果到了再换。
   （没有改成"保存不触发刷新"——那要靠事件 `kind` 猜，而"新建文件后第一次保存"恰恰是 `add`；
   用脆弱的分类换一次闪烁不值。）
2. **旧响应后到，倒灌回改动前那份目录**，且没有下一次失效来纠正它——表现正是本批要修的那个 bug 的新变体。
   改法：按目录记请求序号 `dirReq`，响应只认自己那一次；被更新的请求取代就直接丢弃。

另外补了一枚 **`重新读取`** 按钮（与失效通道共用 `relistShown`，不是第二条实现）。
它不是装饰：`file.watchState` 会如实报 `partial` / `unavailable`（§5.84 的判级），
那时**自动失效一条都不会到**（某些根没监视上，或平台根本没有监视能力——浏览器开发壳就是这种），
作者手里必须还有一条不用重开项目的路。

#### 顺手补的防数据丢失：工作区根进监视根

`kernel.fileWatch.start([项目根, ...kojoPaths, savDir, **工作区根**])`。

理由不是"覆盖更全"：作者工作区是**可写的权威区**，`.kojo` 就住在这里，而编辑器那条
"外部写盘 → 重载 model / 冲突就问一下"的链路（§5.36 的 B1 修复、§5.84 的补全）此前
**只覆盖游戏目录那半边**。所以在记事本里改一个正被编辑器打开的工作区文件，回到编辑器按
Ctrl+S 就是**静默覆盖外部改动**——正是那两批要根治的形状，只是没人想到工作区也在同一张网里。

`workspaces.rootDir()` 在没有平台数据目录的环境（浏览器开发壳）会抛，这里吞成 `null` 并从根列表里
剔除：**不能因为一个可选根把整个开项目流程带崩**（同处 `register_write_domain` 的 fail-closed 是
另一回事——那是安全边界，必须报）。

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test`（rebase 后基座，不带语料） | **1622 passed / 13 skipped（1635）**，93 文件过 / 7 跳 |
| 数字闭合 | 上游 §5.90 之后自记 1607 + 本批 15（`affectsKojoTree` 6 / `createEventCoalescer` 5 / `dirsToRelist` 4）= **1622** ✓（第一次量到 1619 是 rebase **之前**的基座，按 §九-31 各批自记的数重跑） |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿 |
| `pnpm --filter @kojo/app build` | ✓ 1m18s |
| 反证 | `affectsKojoTree` 改成恒 `true` ⇒ **3 条红**（口上域外 / 前缀相似的兄弟目录 / 非口上项目）；`dirsToRelist` 改成"忽略展开态、所有包都重列" ⇒ **4 条全红**（含"折叠着的包不重列"与"按 key 认不按目录名认"）。均已改回并复跑绿 |
| 桌面壳实机（本组自验，2026-10-13 02:30–03:00） | 在独立 worktree 里冷编译并真起 `pnpm tauri dev`（cargo 9m42s，365 crates），开真实语料（2,285 ERB / 99,104 函数）逐项目视：见下「实机结果」 |

#### 实机结果（本组自验，不替别人发合格证）

驱动方式只有截图坐标（WebView2 外层窗口的 UIA 树是空的，只有"区域"节点——本机实况见 HANDOFF §二），
所以能验的是**屏上呈现 + 盘上事实**，不是像素级观感。

| 判据 | 结果 | 证据 |
|---|---|---|
| 反馈 3 岔口：无口上项目时出现引导而非死路 | ✅ | 屏上「还没有口上项目。口上文件写进口上项目里最合适——工作区恒可写，游戏目录只作部署目标。」+ 次行说明 |
| 三键房规（`取消` / `选择文件夹另存…` / **`新建口上项目并创建` primary 最右**） | ✅ | 同一屏截图，顺序与配色逐字对过 |
| 常态落点 = 工作区（不再要游戏目录写权限） | ✅ | 向导「写入位置」显示 `%APPDATA%\dev.kojo.editor\workspaces\<id>\<包>\M_KOJO_K0.kojo`；旧版此处是游戏目录路径 + 一条写权限红字 |
| 创建真的落盘且口径正确 | ✅ | 盘上字节 `EF BB BF 3B 20 …`（UTF-8 BOM + LF），内容 `; 你（0）` / `角色: 0`；编辑器随即可见两行、状态栏 `utf-8-bom · LF · 3 行` |
| a1 第一拍：点主选 → **真的换到**新建项目向导（跨插件意图事件通到） | ✅ | 屏上出现「新建口上项目」向导（作品名/作者名/版本/目标角色/剧本号/许可协议 + 包目录名实时预览） |
| **安全绳：取消那次请求之后，下一次无关创建不得冒出那份文件** | ✅ | 取消 → 从面板「＋ 新建」正常建了一个项目（盘上确实生成 README + 8 个 `.kojo` 空壳）→ `find -name M_KOJO_K0.kojo` 在新项目里 **0 命中** |
| a1 第二拍：项目建好后**自动**把挂起的 `.kojo` 落进新项目并打开 | ✅ **由 §5.96 收口** | 本批坐标驱动三次误关窗（取证见下），当时判"未验成"；§5.96 改用 CDP DOM 驱动一次跑通：新包里自动出现 `M_KOJO_K0.kojo` 且成为活动标签、建开即干净 |

**那条 ⚠ 的取证与判读**（写清，因为它是本批唯一没收口的功能面）。
**后续**：§5.96 改用 CDP DOM 驱动，一次跑通 ⇒ 该 ⚠ 撤销；下面这段留作"坐标驱动不可靠"的取证：
- 反证实验：把表单清空（此时「创建项目」是 disabled）再点同一个坐标 → **overlay 仍然被关掉**。
  点在对话框内的禁用按钮上不会关窗（`.overlay-host` 对 `onMouseDown` 做了 `stopPropagation`），
  关掉只可能是**点到了遮罩** ⇒ 该坐标在命中测试上落在对话框之外。
- 同一坐标区间在**面板入口**的同一个向导上成功创建过（上面那条 ✅ 就是它产出的），
  所以这不是"意图入口打开的向导坏了"的证据，而是**我这套坐标驱动不可靠**的证据。
- 因此本批**不**据此报产品缺陷，也**不**自证通过；判据②留给用 CDP 直查 DOM 的一方复核
  （看板 QA-1 已改成"② 待验 + 本条取证"）。逻辑侧并非裸奔：`号对上了 → 写进新项目最近的包并 reveal`
  与 `号不对 → 一个字都不写` 两条在 `new-file-flow.test.ts` 里钉着，且撤掉配对会红 2 条。
- 顺带一条给实机线的可复用坑：**这个壳里按截图坐标点对话框右下角的按钮不可靠**（本批 3 次误关窗），
  要么用 CDP 拿 DOM，要么先做"点禁用按钮应不关窗"的命中测试再动手。

**语料零写入自查**：全程只往 `%APPDATA%\dev.kojo.editor\workspaces\` 写（作者工作区，恒可写、
本就是应用自有数据），**没有向 `C:\Game\…` 写过任何一个字节**；验证期间在测试包里创建的
`M_KOJO_K0.kojo` 与两个测试项目（`看板验证批`、`自动落盘验证批`）验完已删除/还原，
`workspaces/` 恢复为验证前的唯一那个既有测试项目（逐文件比对过清单）。

#### 分工裁决：性能线的 #24 不接（写进 §十三，避免两条线同一晚改同一文件）

§5.90 把"热开 10.5 秒"的根因定位到 **`packages/app/src/bridge/tauri-bridge.ts` 每读一个文件跑两趟 IPC、
双向各一份 base64**，并列出 #24 的四条改法（`decode` 改 `TextDecoder` / `arraybuffer` 过界 / 批量原语 / 快照口径）。
那文件按 §十二 分工表属"宿主壳 = 本组"，但**本批不接**，两条理由：
1. 这条链路的验收口径已被 §5.90 定为**真实 app 的三个水位**，而那套 CDP 探针是他们刚建、刚打过一遍的；
   换一手做同样的改动，等于把"量在用户跑的那条通道上"这条纪律重新丢一次。
2. 同一晚两组改 `App.tsx` / `tauri-bridge.ts` 这一小片热点，冲突面正好是 §5.64 那种"各自重做同一件事"的雏形。

所以在看板上记成 **QA/PF 边界**：#24 归性能线，本组只在他们要动 `src/ui/*` 呈现层时接手。
（这也是"分工方案在文档里谈论完成"的第一次实际裁决——不是客气，是同一把尺子只能有一只手拿着。）

#### 未做 / 边界

- **实机待验**：外部丢一个文件进包 → 数秒内上树、**展开态不乱、不闪空白**（QA-9 已把这两条写成判据）。
  自动化测到的是三段纯逻辑与接线，测不到"体感上顺不顺"。
- **计数徽标不会跟着新文件走**：`s.files.length` 与角色组计数来自索引（erb-parser 全项目重建 ≈ 2.1s，
  且增量粒度未定），本批刻意不动 ⇒ 新 `.ERB` 会出现在真实文件夹列表里，但包行上的数字暂时不变。
  这不是 bug 而是两条通道不同步的**已知后果**，函数树/索引那条归性能线（HK-1 余量）。
- **HK-6（新开出）**：本批把工作区根纳入监视后，`eratw-adapter` 面板自己的 `wsDirCache`
  仍然只被本插件动作失效——外部改动工作区文件的期望由本批制造，应由本批随后收掉，故登记成看板行而不是留白。
- **工作区监视的噪声没有实测**：备份（`{appData}/backup/`）与 `store/` 都在 `workspaces/` **之外**，
  按目录结构推断不会被本批的根吃到；若实机上出现"每存一次盘面板重列一遍"，回来把这条改成按包目录分野。

### 5.92 IPC 读盘通道批 · 读路径两笔减项：**热开 10.5s → 3.2s，冷开 108s → 18.6s**（2026-10-13 批，§5.90 头号靶子的兑现）

> **触发**：§5.90 把靶子定在"每读一个文件要过两趟 IPC + 双向 base64"。本批就是那一节的兑现。
> 分支 `feat/ipc-read-channel`，两个提交（①②），**每一步单独量，不合成一个"总收益"数字糊人**。
>
> **编号让位（本组第六轮）**：初写 §5.91，推送前 fetch 见上游已占（看板 HK-5 批）⇒ 顺延 **§5.92**。
> §十二-1 那条"push 前必须再 fetch"的纪律本批又兑现一次——上游在我 rebase 期间又落了两个提交。

#### 一、①：解码搬回客户端（每个文件少一趟 IPC）

`bridge/tauri-bridge.ts` 的 `decode()` 原先把**整份字节 base64 编码送回 Rust**，只为调用一次
`encoding_rs` 解码。依据链不是"应该差不多"：

- 编码判定本来就是纯 JS——`kernel/src/encoding.ts` 的 `probeEncoding` 内部已经在用
  `new TextDecoder('utf-8', { fatal: true })` 做合法性校验；测试用的 node bridge 也是
  `new TextDecoder(...)`（`tests/helpers/node-bridge.ts:154`）⇒ **只有真实 app 这一条路多跑一趟 IPC**；
- `FileEncoding` 只有五个值，全在 WHATWG 编码表内（`utf-8-bom` 走 `utf-8` 标签，TextDecoder
  默认剥前导 BOM，与 `encoding_rs` 同口径）；
- Rust 侧的 `encoding_rs` 实现的正是这份标准，含"非法字节替换为 U+FFFD、不上抛"的不严格口径。

**零 Rust 行为改动**，`decode_bytes` 命令保留注册（读路径不再调它；它留着当等价性对照物，
注释里写明了原因，免得下一个人以为是漏改）。

#### 二、②：字节以二进制过界，不再 base64 膨胀 1.34×

新增 Rust 命令 `read_file_bytes_raw`，返回 `tauri::ipc::Response`——Tauri 把 body 原样送到前端，
前端直接拿 `ArrayBuffer`（`new Uint8Array(buf)` 是视图，不额外拷贝）。

⚠ 这里踩掉了一个**凭记忆写会写错的 API**：我原本打算用 `invoke(..., { responseType: 'arraybuffer' })`——
读了 `@tauri-apps/api@2.12.2/core.d.ts` 才发现 **`InvokeOptions` 只有 `headers`，没有 responseType**；
二进制响应是由**命令返回类型**决定的（`ipc::Response` ⇒ ArrayBuffer），不是前端选项。

#### 三、等价性怎么证的（这一节比读数重要）

| 层次 | 做法 | 结果 |
|---|---|---|
| 真实语料逐字节 | 60 个 ERB + 三份大快照（索引 12,506,237B / 抽取 9,443,607B / 校验 1,404,235B），两条通道各读一次 | **63/63 相同**，0 报错 |
| 真实语料逐字符 | 同一份字节按 `probeEncoding` 选出的标签，两侧各解一次比对 | **63/63 相同** |
| 随机缓冲区 | 1,200 个伪随机字节串（1–64B，0x00–0xFF 全域），同标签双解码 | **1,200/1,200 相同**（落桶 utf-8 1,095 / shift_jis 105） |
| 边界形态 | 16 例合成：半角 kana 区 / 截断双字节 / CP932 之外的 PUA / 两种 BOM / 奇数长度 / 代理对 / 孤立高代理 / 过长编码 / CRLF 混排 | **15/16 相同** |

唯一分叉是 `[0xFF,0xFE,0x41]` **按 `utf-8` 标签**解时 TextDecoder 给 ``、Rust 给 ``。
可达性查了两个调用点：`io.ts:64`（`readText`，标签来自 `probeEncoding`——非法 UTF-8 过不了
`isValidUtf8`，拿不到 `utf-8` 标签；而那串字节带 UTF-16LE BOM，直接落 `utf-16le` 桶，两侧一致）；
`storage.ts:50`（固定 `utf-8`，解的是本程序自己 `JSON.stringify` 写出的文件，必然合法）。
**并把这条"不可达"钉成断言**（`bridge-decode.test.ts` 第 5 项），而不是留在论证里——
下一个人改 `probeEncoding` 时会直接撞红。

⚠ **语料对这个风险面是零覆盖的**：全树 3,776 个 `utf-8-bom` + 42 个 `utf-8`，
一个 `shift_jis` / `utf-16` 文件都没有。只跑"真实语料抽样 114 份逐字符相同"会**全绿通过而漏掉
这一刀的全部风险**——真正守门的是合成 16 例 + 随机 1,200 例。

#### 四、读数（真实 `pnpm tauri dev`，同机同语料 2,285 个 ERB / 99,104 函数，从 `project.open` 起算）

| 水位 / 自计 | §5.90 原始 | ①之后 | ②之后 |
|---|---|---|---|
| `index可用`（热） | 6,356 / 6,818 ms | 3,744 ms | **2,449 ms** |
| `条件可用`（热） | 10,469 / 11,197 ms | 5,468 ms | **3,211 ms** |
| `校验有结果`（热） | 10,497 / 11,225 ms | 5,513 ms | **3,245 ms** |
| `条件可用`（冷，重算 2,285 文件） | 107,880 ms | 45,615 ms | **18,584 ms** |
| `校验有结果`（冷） | 89,810 ms | 36,111 ms | **14,061 ms** |
| 抽取自计（冷） | 95,853 ms | 41,077 ms | **15,483 ms** |
| 索引快照 get（12.5MB 一次） | 4,147–4,514 ms | 1,535 ms | **234–258 ms** |

**热开 10.5 秒 → 3.2 秒（3.3 倍）；冷开 108 秒 → 18.6 秒（5.8 倍）。**
两笔减项各占一半左右：① 去掉一趟 IPC 与一次全量 base64 编码，② 去掉另一次的 1.34× 膨胀与逐字节还原。

**下一个靶子已经换人**（本批读出来的，不是推的）：热开 `index可用` 2,449ms 里
`stat 1,970ms`（2,285 次**串行**逐文件 stat）占 80%，快照读已降到 258ms。
⇒ #29：批量 stat（`stat_many`）或让 `readText` 复用索引里已有的 mtime，别再单发。

#### 五、代价

| 项 | 内容 |
|---|---|
| 代码 | `app/src/bridge/tauri-bridge.ts`（`decode` 本地化 + `readFileBytes` 走 raw + 头注重写）；`src-tauri/src/lib.rs`（+1 命令 +1 注册 +1 段注释，`decode_bytes` 加注说明读路径不再用它）；`app/tests/bridge-decode.test.ts`（新增） |
| Rust | `cargo check --tests` ✅ · `cargo test --lib` **19 项全绿** |
| 测试 | 净增 **5**：§5.91 自记 1622 + 本批 5 = **1627 passed / 13 skipped（1640）**，文件 93 → 94 |
| 门禁 | root + app typecheck 双 0 · 审计 A–D ✅（bridge 在 A 项扫描范围内，新增文案零游戏名词） |
| 探针 | `.local/ipc-after.mjs` / `ipc-after2.mjs` / `decode-synth.mjs`（CDP 驱动真实 app），跑完删除。**语料零写入**；为逼出冷路径删过两份派生快照（app 随即自行重写，非用户数据）；写权限弹窗未点 |

#### 六、方法论：换了被测通道，**验证面也要跟着换**

§5.90 的教训是"量在用户跑的通道上"；本批补一条对称的：**宿主层（bridge / Rust 命令）的改动
在 vitest 里根本没有覆盖**——vitest 走 node bridge，`tauri-bridge.ts` 一行都不会被执行。
这类改动默认配一支 **in-app 对照探针**（CDP 进真实进程，同一份输入跑新旧两条路逐字节比），
否则"测试全绿"只证明了我没测到东西。

### 5.93 看板 HK-6 批 · 口上项目面板消费工作区外部改动（2026-10-13 批，收自己制造的期望）

**触发**：§5.91 把**工作区根**加进了监视根（`App.tsx` 的 `fileWatch.start`）。那一刻起，
作者用资源管理器往包里丢一个文件、或直接在磁盘上改包名，都会以 `file.changed` 到达面板——
但面板的 `wsDirCache` 只被**本插件自己的动作**失效（`createItem → refreshDir` / `invalidateWs`）。
**期望是那一批制造的，收口就该是它**：看板当场登记为 HK-6，本批做完。

#### 判据只有一条形状

> "某个目录的内容变了" ≡ **改动条目的父目录**要重列。

再往上什么都不做。新纯函数 `workspaceChangeOf(path, rootDir)` 只回答"该重列谁"，
不回答"要不要重列"——那是接线侧看缓存的事。两条接线规则都为了压住"自动刷新"最容易长出来的病：

| 规则 | 防的是 |
|---|---|
| 只重列**已在缓存里**的目录（= 作者看过的那些） | 监视器一响就扫全工作区；没缓存的目录等展开时惰性取，取到的本来就是新数据 |
| 改动落在工作区根的**直接子层**才重拉项目列表 | 每存一次盘就重扫根目录读一遍 manifest。项目自己的 `workspace.json` 变了不算（那是子层内部），只重列那个项目目录 |

#### 不复用 `refreshDir`，另写一条 `relistDir`（差别只在"别闪"）

`refreshDir` 是 `delete` 再 `ensure`，中间那一帧 `dirState === undefined` ⇒ 面板渲染成「读取目录…」。
自家动作之后闪一下无所谓（作者刚点了"新建"，知道有事在发生）；
**外部改动**让整块内容闪白，就是"我在别的程序里存了个文件，这个面板抽了一下"。
所以重列时旧内容原地留着、新结果到了再换；读失败**同样保留旧内容**、只 `log.warn`：
把一份正确的目录换成错误态是更坏的失败，而面板顶部本来就有 ⟳ 可手动重拉。
按目录记请求序号，旧请求后到不覆盖新结果——与 §5.91 宿主文件树那条同一个理由；
两包之间不许交叉 import（审计 C 项），所以各留一份，**不硬凑一个公共件**（凑一次就要动契约，
而这段逻辑还没有第三个使用者）。

#### 顺手更正一处"注释与实现相反"（契约层，本组范围）

`FileChangedEvent.path` 的注释写的是「**归一化后**的绝对路径」，
而 `kernel/src/watcher.ts` 的 `flush()` 明写「路径**原样透传**：消费方用同一个字符串做键」。

原样是对的，注释是错的：内核中途改分隔符，会让"这个文件正打开着"判空 ⇒ **事件静默失效**，
比形态不统一糟得多。所以本批改注释、不改行为，并把消费方的义务写进契约：
**判等一律走 `pathKey()`**（折叠大小写与分隔符）。本批的缓存查找正是这么做的——
事件里的形态来自平台，缓存键的形态来自 `join()`，Windows 上两者都不保证一致，
直接 `has(dirToRefresh)` 会"看着对、永远不命中"（这类 bug 全绿测不出来，只能靠想清楚）。

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test`（不带语料） | **1637 passed / 13 skipped（1650）**，95 文件过 / 7 跳（102） |
| 数字闭合 | §5.92（性能线 IPC 批）自记 1627 + 本批 10（`watch-scope.test.ts` 8 + 面板接线 2）= **1637**；文件 94 + 1 = 95 ✓ |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿 |
| `pnpm --filter @kojo/app build` | ✓ 1m02s |
| 反证 | 撤掉 `workspaceChangeOf` 里的工作区分野 ⇒ **2 条红**（游戏目录那半边 / 前缀长得像的兄弟目录）；改回复跑 8 条全绿 |
| 桌面壳实机 | **未验**（同 QA-9 的困境：要一个能随便写的项目目录，真实语料零写入是硬约束）⇒ 判据已并进 QA-9 |

#### 未做 / 边界（都写在看板上，不留白）

- **HK-7（新发现，本批登记）**：`EditorPane` 的外部改动重载用 `entriesRef.has(ev.path)` **裸字符串判等**
  （:773），而 `entriesRef` 的键来自 io 路径。按本批改正的契约，这里应当走 `pathKey()`。
  现网大概率是"恰好一致"（两边都出自同一平台），所以**不当 bug 报**；但它与本批踩的是同一个坑，
  且那条链路是防数据丢失的（B1），静默失效没人看得见 ⇒ 登记待办，改法一行、判据现成（§2.J j1）。
- **署名缓存 `wsAttrCache` 不随外部改动失效**：作者在外面改了 README 里的署名，面板那行事实会滞后。
  刻意不做——每次保存都重读一遍 README（可能是 Shift-JIS 探测 + 全文件扫）比滞后一行更贵，
  而面板顶部那枚 ⟳ 走的是 `invalidateWs`，一并清署名缓存。
- **HK-6 自己的实机半边**：并入 QA-9（造一个最小 fixture 工程放临时目录里验，别碰真实语料）。

### 5.94 看板 HK-7 批 · 外部改动重载不再拿裸字符串认「正打开的是哪个文件」（2026-10-13 批）

**触发**：§5.93 更正 `FileChangedEvent.path` 契约注释时顺手扫到的同坑位（当时登记为 HK-7）。

**形状**：`EditorPane` 的 `file.changed` 处理用 `entriesRef.has(ev.path)` 判"这个文件正打开着"。
但两边形态不同源：

| 侧 | 路径形态来自 |
|---|---|
| `ev.path` | 平台原样透传（Rust notify 给什么就是什么；§5.93 已把这件事写进契约） |
| `entriesRef` 的键 | 宿主自己的 `filePath`（一路从 io / 文件树 / 对话框来） |

Windows 上分隔符与大小写都**不保证一致**。判不上的后果不是报错而是**静默失效**：
外部改了盘、model 还是旧的、作者随后一次 Ctrl+S 就把外部改动覆盖掉——
这正是 §5.36 B1 那条链路要防的数据丢失，而它**没有任何症状**，没人会知道自己正拿着旧内容。

**改法**：`matchOpenedPath(keys, eventPath)` 按 `pathKey()` 找回宿主用的那个键，之后一律用它
（连提示里显示的也是作者标签上认识的那条路径）；找不到 = 与编辑器无关，语义不变。
O(打开的标签数)，一次几毫秒级都不到，不值得为它建索引。

**为什么这条值得单独一批**：它不是"顺手美化"，是**一条防数据丢失的链路在特定形态下根本不起作用**，
而这类 bug 的共性是"全绿 + 无感"。判据也不新（§2.J j1 外部改动跟随），只是此前没人把两处判等口径对齐过。

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test` | **1642 passed / 13 skipped（1655）**，95 文件 / 7 跳 |
| 数字闭合 | §5.93 自记 1637 + 本批 5（`matchOpenedPath`：形态一致 / 反斜杠↔正斜杠双向 / 大小写 / 没打开 / 名字像但不是同一个文件）= **1642** |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿 |
| `pnpm --filter @kojo/app build` | ✓ 1m03s |
| 实机 | 判据 = §2.J **j1**（外部改动跟随），未单独跑（本组坐标驱动不可靠，见 §5.91 实机结果与 §九-33） |

**留下的同类风险（不再新开行，记在此处供后来者对齐口径）**：全仓按路径做键的地方
（`FileTree` 的 `subOpen` / `dirCache`、面板的 `wsDirCache`、`EditorPane` 的 `openTabs`）
都建立在"同一进程内路径形态一致"这个前提上，本批只修了**跨边界**（事件 → 宿主表）那一处。
若哪天有平台开始混用分隔符，需要一次性收口成"键一律 `pathKey()`"——现在提前做属于无收益的改动面扩大。

### 5.95 看板 HK-2 批 · 全站宿主模态接上 Esc（模态栈，一次只退一层）（2026-10-13 批）

**触发**：§5.80 留的那句"全站模态都没有 Esc 关闭，做好它需要一个宿主模态注册表"。
看板 HK-2；QA-6 本来要先取证"哪些能关哪些不能"——答案没人不知道（五家全都不能），
所以不必等取证，直接做。

#### 为什么不各家自己监听键盘

五家模态各写一个 `window.addEventListener('keydown')` 就能交差，但**叠着开的时候
一次 Esc 会同时关掉所有层**（保存告警 + 未保存确认这类组合是存在的）。
作者的直觉是 Esc = 退一层，与向导 / picker / 写作模式那条既有 Esc 链同源。
所以是一个极小的栈：挂载入栈、卸载出栈、`closeTopModal()` 只打栈顶并**报告是否消费**
（空栈返回 false，按键继续交给向导 → 设置 → 写作模式）。

#### Esc 一律落在「不写盘」那一侧，且每家显式写出自己那一格

| 模态 | Esc = | 为什么不是别的 |
|---|---|---|
| 写权限批准 | 只读浏览 | 授权是给出去就收不回来的动作，键盘不该替作者按；之后状态栏那枚「只读」徽章就是重授权入口（§5.39） |
| 未保存确认 | 取消 | 另外两格都有损（丢弃 = 改没了；保存并关闭 = 覆盖盘上） |
| 保存告警 | 取消这次保存 | 两种"继续"都要作者点头 |
| 糖视图引导 | 不用 | 开启会写偏好；作者可能只是想看清这段说明 |
| ERB 解锁 | 保持只读 | 五家里唯一两向都有代价的一个；按 ADR-0005，代价小的一侧是不写盘 |

刻意**不用"关窗"这种含糊动作兜底**——每家在接入处写清自己那一格，
谁以后改按钮都会看见这行，不会漏（Esc 语义写错方向 = 键盘替作者做了他没做的决定）。

#### 次序为什么不靠层叠

模态排在 Esc 链第一位，但 `.modal-mask` 与 `.overlay-backdrop` 的 `z-index` 目前**同为
`--z-modal`**，谁在上面取决于 DOM 先后——那是偶然，不能当依据。之所以不必去修层叠：
**实践中两者互斥**（模态的遮罩吃掉点击，开着模态开不了向导；开着向导时能触发模态的
三条路径——保存 / 关项目 / 在只读文件里打字——也都被遮罩挡住）。
所以次序由"谁在问一个当下就要答案的问题"决定，不靠偶然。

#### 测试踩到并纠正了自己一处错判

`pushModal` 的 closer **不出栈**（关不关由组件卸载决定）。头两条用例写成
"连按两次 Esc 应该退到下一层"，当场红：第二次仍打到同一层。生产里第一次按下后是
`决定 → 父组件 setState → 该模态卸载 → effect 清理出栈`，用例必须显式扮演"卸载"那一步。
这个区分不是吹毛求疵：如果 closer 自己出栈，那么"Esc 被拒绝"（例如未来某家模态要求
先确认）就会把模态从栈里摘掉，此后它再也接不到 Esc。

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test` | **1648 passed / 13 skipped（1661）**，96 文件过 / 7 跳（103） |
| 数字闭合 | §5.94 自记 1642 + 本批 6（空栈不消费 / 一层消费 / LIFO / 出栈时机 / 幂等注销 / 中间层单独注销）= **1648** |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿 |
| `pnpm --filter @kojo/app build` | ✓ 1m03s |
| 既有渲染测试 | `sugar-dialogs.test.ts` 五家模态的 `primary` 最右 + `role=dialog` 断言仍全绿（新钩子在 `renderToString` 下只跑 render 路径，不跑 effect，故不污染栈） |
| 实机 | 真按键 Esc 是否真退一层 = 体感半边，**§5.96 已用 CDP 复验（叠两层各退一层 + 两家模态落不写盘格）**；余三家模态留给别机 ⇒ **QA-10 记 3/5** |

#### 未做 / 边界

- **向导（overlay）里的"Esc 该干什么"没细究**：现在 Esc 直接关掉向导，等于放弃这次填写——
  与"取消"按钮同义，五家里没有一家会因此写盘，所以够用。若将来某个向导在 Esc 时有副作用，
  它该走同一个 `useModalEscape` 显式声明，而不是继续用宿主的 `setActiveOverlay(null)`。
- **`useModalEscape` 本身没有单测**：四行（ref 取最新 handler + 挂载入栈 / 卸载出栈），
  而 `renderToString` 不跑 effect、本仓没有 DOM 测试环境。真正要钉的次序语义全在栈的 6 条用例里。
- **模态与向导的层叠偶然**（两家同 z-index）没改：改它属于"看不见收益的视觉改动"，
  且本组坐标驱动不可靠（§九-33），等真有一处两者共存的需求再动。

### 5.96 实机复验批 · **CDP DOM 驱动**收掉 QA-1② / QA-9 / QA-10 + 两条写盘安全路径（2026-10-13 批，零代码改动）

**触发**：看板上挂着三条"本组验不了、请别机跑"的实机半边（QA-1 ②、QA-9、QA-10），
它们的共同理由是"本组只有截图坐标"（§九-33）。这句自我设限是错的：
`tools/smoke-tauri-dom.mjs` 里早就有一条 CDP `Runtime.evaluate` 通道（WebView2 远程调试端口），
起壳时给 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 就能用
**DOM 选择器**驱动整个界面。既然别机的"CDP 复验"要排队等，本组自己把这条通道接上跑完。

#### 可复用配方（两边都用得上，四条都是踩过才写下的）

1. **点按钮** = `el.click()`。React 19 的合成事件照常收到（`isTrusted=false` 不影响派发链）。
2. **填受控 input / select** = 走**原型 setter** 再补事件：
   `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v)`
   → `dispatchEvent(new Event('input',{bubbles:true}))`（select 用 `change`）。
   直接 `el.value=v` React 看不见，表单会停在"字段为空 ⇒ 创建按钮 disabled"。
3. **走 app 自己的快捷键** = `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true}))`。
   `chordFromEvent()`（`ui/commands.ts`）只读 `e.key` 与四个修饰键，所以合成事件足够——
   Ctrl+N、Ctrl+K Z 和弦、Esc 全是这么打的。
4. **往 Monaco 打字**：本仓这个 Monaco 走 Chromium **EditContext**，真正的输入面是
   `div.native-edit-context`；`textarea.ime-text-area` 常年 `readOnly=true`，只是个 IME 残影。
   正确顺序 = CDP `Input.dispatchMouseEvent` 真点 `.view-lines`（拿到 edit context 焦点）
   → `rawKeyDown` + **`char`（带 `text`）** + `keyUp`。
   **别调 `textarea.focus()`**——那会把焦点从 edit context 抢走，字就进不去。
   本组第一版就栽在这条上，一度据此要报"工作区 `.kojo` 打不了字"的缺陷；
   用"干净会话里先开 `.kojo` 也打不进"做反证才认出是**自己的通道问题**（见下「误判与收回」）。

#### 实机结果（真实壳 + 真实语料；驱动方式 = CDP DOM）

| 判据 | 结果 | 证据 |
|---|---|---|
| **QA-1 ②**：项目建好后**自动**把挂起的 `.kojo` 落进新项目并打开 | ✅ | 空工作区 → Ctrl+N → 点 `新建口上项目并创建` → 向导填 `CDP试验田 / QA-1 / 角色#0` → 点 `创建项目`。盘上 `%APPDATA%\dev.kojo.editor\workspaces\<新项目>\<CDP试验田-你 v1.0>\` 出现 **`M_KOJO_K0.kojo`**（与脚手架的 README + 8 个核心面空壳**并列且不重名**），字节头 `EF BB BF 3B 20` = UTF-8 BOM + LF；DOM 侧 `.editor-tab` 恰好一条且 `active=true`，状态栏 `utf-8-bom · LF · 3 行 已保存`（**建开即干净**，不是脏标签），无 `.wizard-error`（失败重开分支没被走到） |
| QA-1 ①③④ | ✅（§5.91 已验，本批重跑 ①④ 一致） | 岔口文案逐字相同；`创建项目` 在表单清空时 `disabled=true`（本批实测到） |
| **QA-10 ②**：叠两层时一次 Esc 只退一层 | ✅ | 时间线（写作模式为底层）：`zen=true` → Ctrl+N 开向导 → **第 1 次 Esc**：`overlay=null, zen=true`；**第 2 次 Esc**：`zen=false`。模态版同理：脏标签点 `×` → 弹 `有未保存的修改` → **第 1 次 Esc**：`modal=null, zen=true, tabCount=1`（标签没被关掉 = Esc 落在那家的 `cancel` 那一格）→ **第 2 次 Esc**：`zen=false` |
| QA-10 ③：没有模态时 Esc 照旧 | ✅ | 同上一条的两段链：overlay 层、zen 层各自被消费，没出现"按了没反应" |
| **QA-10 ① 五家里的两家** | ✅ | `未保存确认`（上面那条）+ **`保存提醒`（全角空格决策）**：往工作区 `.kojo` 打进一个 U+3000 → 点保存 → 弹「保存提醒 / 检测到 1 行含全角空格 / 涉及行：1」，按钮 `取消` `仍然保存` `替换为半角空格并保存(primary 最右)`；按 Esc → 模态关、**标签仍脏**、盘上内容还是保存前的 `﻿qq`（**一个字节都没写**） |
| **QA-9 工作区半边**：外部新增/删除自己反映到面板 | ✅ | 展开「我的口上项目」里一个包 → 用**外部**进程 `fs.writeFileSync` 丢一个 `外部新增验证.kojo` 进去 → 树里 ≤0.5s 出现它（**期间零点击零刷新**）；`fs.unlinkSync` 删掉 → ≤0.5s 从树里消失。HK-5/HK-6 的失效通道 + 去抖 + 展开态保留这条链，实机成立 |
| 顺带：打开着的文件被外部**删除** | ✅ | 点开 `外部新增验证.kojo`（活动标签）→ 外部删掉它 → toast 原文：`「…\外部新增验证.kojo」已在磁盘上被删除。编辑器里的内容现在是唯一副本——保存会重新创建该文件。`（§5.46 那条"unlink 不动 model 但必须说"的口径，第一次在真壳上看到） |
| 顺带：脏 + 外部改动 = **conflict 不静默** | ✅ | 缓冲区脏（`qq`）→ 外部追加一行 → toast 原文 `…已在磁盘上被修改，但你有未保存的修改——保存会覆盖磁盘内容。`，且标签**保持脏**、屏幕上的行**仍是 `qq`**（没有把用户的内容换成磁盘内容 = `decideExternalChange` 走 conflict 而非 reload） |
| **零写入铁律复核** | ✅ | 全程 `find C:\Game\… -type f -newermt "2026-10-13 02:00:00"` = **0 命中**（只开过、只读过游戏目录里的 ERB）。写盘全发生在 `%APPDATA%\dev.kojo.editor\workspaces\` |

#### 一条口径纠正：`保存告警` 不是"磁盘冲突守卫"

QA-10 原判据把第五家写成"保存告警→没写出文件"，暗示它是外部改动冲突的确认闸。**它不是**：
`EditorSaveWarning.kind` 目前只有 `'fullwidth-space'`（`plugin-api/slots.ts:302`），
这个对话框是 §5.37 的**全角空格决策点**（`取消` / `仍然保存` / `替换为半角空格并保存`）。
外部改动的冲突在**发现时**就用 toast 说清了（上表最后一条），随后作者按保存 = 以作者的
明示意图为准（warned last-write-wins）。本批把判据文案改成它真正的语义，并顺手把
"要不要在按下保存时再确认一次"提成看板讨论项（HK-8），**不是**顺手改行为——
那是"工具替作者做决定"和"静默覆盖"之间的一条线，得先议。

#### 误判与收回（写下来，因为它是这批最容易复发的一类错）

上一步"打完字没反应、`.kojo` 看着像只读"时，**最省事的结论是报缺陷**（配方 4 的坑看不见，
现象又完全像 ADR-0005 的只读锁泄漏）。拦住它的是两条：① 同一条链在上一轮会话里真的把标签
打脏过（说明通道能通），② 干净会话里"只开 `.kojo`、不碰 ERB"同样打不进——**只读锁泄漏无法
解释后者**，而"焦点被我抢去 textarea"能同时解释两者。故按通道问题处理，改配方后一次通过，
**未上报任何产品缺陷**。口径：驱动通道自己失败 ≠ 产品失败；先在"能解释全部观测"的那一侧找。

#### 没验到的（不猜、不替别人发合格证）

- **ERB 解锁模态 / 糖视图须知模态 / 写权限批准模态**——三家都没实机触发：
  须知是**一次性**提示，本机偏好早已记录（`loadSugarViewPrompted()` 直接短路）；
  解锁需要"在只读 ERB 上产生编辑意图"，本批的注入在只读态上没有触发
  `onDidAttemptReadOnlyEdit`；写权限批准要求往**未批准的盘路径**保存，那违反零写入铁律。
  ⇒ QA-10 状态记成"3/5 家 + 层叠全过"，余下三家留给别机（人机键盘更可信）。
- **游戏目录那半边的 QA-9**（外部丢 `.ERB` 进口上目录）没跑——真实语料零写入是硬约束，
  本批用的是工作区包；建议别机按原回执造最小 fixture 工程。
- 折叠态被打乱**没有专门断言**（本批新增文件时展开态保持，但没构造"多层展开 + 外部改动"的
  压力形状）；`重新读取` 按钮那条手动通道本批没走。

#### 验收（本批零代码改动，故不重测 = 不造新合格证）

| 项 | 结果 |
|---|---|
| `pnpm test`（推送前复跑） | **1648 passed / 13 skipped（1661）**，96 文件 / 7 跳——与 §5.95 同数（本批只动 `docs/`） |
| 审计 A–D / typecheck root+app | 全绿 / exit 0（只动文档，复跑确认没误触源码） |
| 机器状态还原 | 探针目录 `.local/` 与 `%TEMP%` 备份**同批删除**；测试期挪开的既有工作区项目已挪回，本批新建的 `CDP试验田` 项目已删；`test/test.kojo` 逐字节还原（sha 前后一致 `f1945cd6…`）；dev 壳按 PID 树收干，端口 1420/9222 无残留 |

### 5.97 看板 HK-3 批 · 契约收缩：`exportDirectory` 删掉，绕闸通道收回**一条**（2026-10-13 批）

**触发**：看板 HK-3（§5.77 当时明记"保留未删：导出改走 ZIP 后它暂时没有 UI 调用方"）。
"暂时"拖到 v0.1 收尾，就该按判据收口：要么写明消费方，要么收缩。

#### 事实复核（先把"有没有人要"问成可核对的东西，而不是等人来表态）

| 查法 | 结果 |
|---|---|
| `git grep -n "\.exportDirectory(" -- "*.ts" "*.tsx"`（剔掉定义链与测试） | **零生产调用方**（master） |
| 别组在飞的分支 | `origin/feat/ipc-read-channel` 各文件命中数与 master **逐文件相同**（都是定义链本身，没有新增调用）；`origin/ui-polish` **一条都不含**（该分支早于导出功能） |
| 纪要 / backlog 里有没有"导出成文件夹"的将来需求 | `docs/` 全量 grep「整目录 / 文件夹导出 / 导出为文件」只命中历史批次记录；eraTW 生态的"整目录覆盖安装"是**部署**那条路（写进游戏目录，走写白名单），不是导出 |

⇒ 三条都指同一结论：这条能力没人用、也没人打算用。

#### 为什么删，而不是"留着以防万一"

1. **它让一句安全口径变成假的**。`HANDOFF` §六-6 写的是"绕开写允许域**只有一条**法定通道"，
   而实际挂着两条，其中一条还是死的。这种口径与事实的分叉，正是后来人误判"再加一条绕闸也没什么"的起点。
2. 内核 / plugin-api 的表面积是本仓唯一不可逆的成本（审计 A–D 与"一切皆插件"都按它算）。
3. 反悔成本近乎零：形态照 `exportFile` 抄即可，代码在 git 历史里（`7dbe58f` 起）。

#### 改动（删的是死码，**留下的是那条活通道的断言**）

- 契约层：`plugin-api/io.ts`（`FileIO.exportDirectory`）、`plugin-api/platform.ts`（`PlatformBridge.exportDirectory`）。
  `exportFile` 的注释从"唯一…（除 `exportDirectory` 外）"改成**真的唯一**，并把"新增绕闸能力必须照此形态、
  不得开放任意目标路径参数"这条纪律从 §六 搬进契约本身（写在这里才有人读得到）。
- 内核：`kernel/src/io.ts` 删除透传实现。
- 宿主桥：`app/src/bridge/tauri-bridge.ts` 删除方法。
- Rust：`export_directory` 命令 + `invoke_handler` 注册项 + **只被它使用的** `copy_dir_contents` 助手
  （留 `#[allow(dead_code)]` 等于没删）+ `export_copy_tests` 三条单测。`walkdir` 仍被目录扫描用着，无残留依赖。
- 测试替身：6 处 fake/stub 里的 `exportDirectory` 分支（接口收缩后留着会因 excess property 直接编译失败，
  这恰好是"契约真的变小了"的可执行证明）。

#### 顺手补上的一处真空洞

那四条**"对话框即授权"不变量**（平台无对话框 → 错误如实上抛 / 参数与字节原样透传 /
取消返回 null 不算失败 / **一个可写根都没批也能导出**）原本只钉在 `exportDirectory` 上；
而真正活着的 `exportFile`，grep 下来**在内核层一条行为测试都没有**（只有会抛错的 fake）。
所以本批不是"删掉 4 条测试"，而是**把它们移植到那条唯一通道上**（`kernel/tests/io.test.ts`
「导出（唯一法定绕闸通道）」），并额外加一条字节级断言：BOM 头 `[0xef,0xbb,0xbf,0x3b]` 必须
**原样**过桥——内核只搬运，转码就是"一次转码毁半库"那一类错。

#### 验收（数字按实测，不写预期）

| 项 | 结果 |
|---|---|
| `pnpm test` | **1648 passed / 13 skipped（1661）**，96 文件 / 7 跳 —— **与 §5.95/§5.96 同数**：4 条是移植不是删除，故闭合式不变 |
| `cargo test --lib` | **16 passed**（`#[test]` 计数 19 → 16，减的 3 条正是被删命令的复制助手单测，实测对过） |
| typecheck root / app | exit 0 / exit 0 |
| `cargo check --lib --tests` | **零 warning**（不留 dead_code 的自检） |
| `audit:decoupling` | A–D 全绿 |

#### 未做 / 边界

- **别组表态**留给看板：HK-3 回执写明"若哪条线需要整目录导出，照 `exportFile` 形态重新加，别恢复原码"。
  这比"先删了再说"诚实——判据里那句"别组无异议"没法同步取得，但**代码在历史里、形态在契约注释里**，
  重新加的成本低于长期挂一条死通道的成本。
- 桥能力清单里 `chooseDirectory`（打开项目用）与本批无关，未动。
- MANUAL-CHECKLIST / ARCHITECTURE / USER-GUIDE 三份文档 grep 无"导出目录"字样，无需跟着改。

### 5.98 工具批 · `git-push.mjs` 改成**直连 / 代理交替试**（2026-10-13 批）

**触发**：§5.97 那次推送，工具按它的既定口径（清空代理变量直连 + 重试）**6/6 全红**
（`Failed to connect to github.com:443 after 21s`），而我手工带本地代理
（`http://127.0.0.1:7890`，`-c http.proxy=` + `HTTPS_PROXY=`）**一次就通**。

**为什么不是"把口径改成代理优先"**：直连确实是历史上命中率最高的姿势（工具头注释记录过实测），
代理也不是总在（7890 端口要活着）。**两条路都试、交替试**才是对"线路时通时断"这个真实分布的诚实回答；
赌任何一种单一姿势，都会在另一半天里白花 6×21s 的重试。
`KOJO_GIT_PROXY=""` 可退回纯直连（别机没有本地代理时的退路）。

| 项 | 结果 |
|---|---|
| `node --check tools/git-push.mjs` | 通过 |
| 真推送验证（本批） | try 1 direct **failed** → try 2 via proxy **✅ push OK**（`Everything up-to-date`，无副作用）——两条分支当场各跑一遍 |
| `pnpm test` / `audit:decoupling` | 仍照 §十二-5 每批复跑：**1648 passed / 13 skipped（1661）**、审计 A–D 全绿——改动只碰 `tools/`（不在测试路径、不进包体），故数字与 §5.97 相同 |

### 5.99 看板 HK-4 批 · 编辑器工具条：让位的次序改成"身份不许裁"（2026-10-13 批，UI P4）

**触发**：HK-4（用户常任指派：专业 / 克制 / 流畅 / 高效 / 耐看）。这次不靠主观挑活，
直接用 §5.96 那条 CDP 通道**量**——对一批候选元素比 `scrollWidth - clientWidth`，
谁被裁、被裁多少、被挤多高，一次全出来。1280×841 窗口、真实语料里一个游戏目录 ERB。

#### 量出来的三条事实（都不是猜的）

| 位置 | 实测 | 意味着什么 |
|---|---|---|
| `.file-label`（工具条最左，显示整条绝对路径） | 宽 550px，**clipX = 419px** | CSS 的 `text-overflow: ellipsis` 从**末尾**裁，而末尾恰好是文件名 ⇒ 作者盯着编辑器顶部读到的是 `C:\game\eratw-sub-modding…`，**"我在改哪一个文件"一个字都没显示**。旁边标签页上倒是有的，但工具条才是"当前文件"的正式位置 |
| `.editor-status`（`utf-8-bom · LF · 463 行`） | 宽 68px，**clipX = 52px** | 明明 `max-width: 30vw`（384px）却只分到 68px：flex 把它挤了。编码/换行/行数是"保存会不会毁文件"的判据，被挤成半句话 |
| `.editor-toolbar` 高 | **50px**（正文行高 17px） | 截图看到原因：`保存 (Ctrl+S)` 的标签**折成两行**，整条工具条被撑高 16px，编辑器白少一行多行 |

#### 修法：定一个让位次序，而不是把每个元素各调一个像素

**身份不许裁，前缀可以让。** 新增 `ui/path-label.ts` 把路径切成三段，按"认得出这是哪份文件"的强弱排：

- `base` 文件名 —— 加粗、`flex: 0 0 auto`（永不缩）；
- `tail` 最深一层目录（作者自己的包名，如 `灵梦-少女之梦`）—— dim、永不缩；
- `head` 剩下的长前缀 —— dim、`min-width: 0` 可缩，并自己先做一次中段省略（留头留尾，因为前缀里最有信息量的仍是靠近尾部的 `001 Reimu [霊夢]`）。

完整路径恒在 `title`（悬停即得，不必为看路径拉宽窗口）。另两条：`.editor-status { flex: 0 0 auto }`、
`.editor-toolbar button { white-space: nowrap; flex: 0 0 auto }`。`baseNameOf` 顺手改为复用 `splitPath`，
拆分口径全站一处（原先自己又写了一遍 `lastIndexOf`）。

#### 一次实测量测把"看起来对了"打回"结构不对"（值得单独记）

第一版是**两段**：`middleEllipsis(dir, 44)` + 文件名，逻辑上"目录中段省略、保住最深一层"，
纯函数单测全绿。接上壳子再量：`.file-dir` 宽 264px 而内容 321px，**clipX = 57** —— CSS 又从头裁了尾，
等于把我承诺保住的 `灵梦-少女之梦` 裁掉。字符预算永远对不上像素（CJK 与半角宽度差近一倍，
可分宽度还随窗口变），**所以"保住尾段"不能靠预算，得靠结构**：尾段与文件名一样放进不可缩的块里，
让可缩的只剩 `head`。改完三段各自 clipX = 0。
⇒ 口径：**UI 的断言如果只写在纯函数里，量一次壳子才知道它是不是真的成立。**
（同一批里测试也抓到一个真 bug：`pathLabelParts` 第一版从 `splitPath` 的结果里解构 `tail`，
而那个函数根本不返回 `tail` ⇒ 五条断言当场红。纯函数测试仍然值得写，只是它管不了布局。）

#### 修后实测（同一窗口、同一文件）

| 项 | 前 | 后 |
|---|---|---|
| `.file-label` clipX | 419px（文件名全裁） | **0**（三段全可读：`C:\game\eratw…1 Reimu [霊…] · 灵梦-少女之梦 · M_KOJO_K1_2_セクハラコマンド.ERB`） |
| `.file-pkg` / `.file-base` | 不存在 | 80px / 208px，**clipX 均 0** |
| `.editor-status` | 68px 宽、裁 52px | **120px 宽、裁 0**（`utf-8-bom · LF · 463 行` 完整） |
| `.editor-toolbar` 高 | 50px | **34px**（按钮不再折行，编辑器多回 16px 正文） |
| 截图复核 | — | `Page.captureScreenshot`（**要先 `Page.enable`**，否则 CDP 直接回错误）取整窗 + 工具条两条带，肉眼确认加粗/配色/间距未破 |

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test` | **1658 passed / 13 skipped（1671）**，97 文件过 / 7 跳（104） |
| 数字闭合 | §5.97/§5.98 自记 1648 + 本批 10（`path-label.test.ts`：`splitPath` 4 条 + `pathLabelParts` 6 条）= **1658** |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿（新模块零游戏词；示例路径只出现在注释里） |
| `pnpm --filter @kojo/app build` | **✓ 1m28s**（CSS + 新模块过打包；chunk 体积警告是既有那条，与本批无关） |
| 实机 | **本组自验**（CDP 量测 + 截图），不再欠别机一条 QA 行 |

#### 未做 / 边界

- **工具条与底部状态栏都显示 `utf-8-bom · LF · 463 行`**（截图里确认的重复）。刻意**不删**：
  两处语境不同（工具条那条紧邻「语法糖 349 行」，是"糖与原文件行数对照"的一部分；状态栏那条是全窗口的），
  而删信息比加可读性风险大。要合也得先定哪一处才是权威位。
- `head` 在窄窗口下仍会被 CSS 裁掉几个字符（截图中 `[霊…`）——**这是设计**：可缩段就该被缩，
  代价不再转嫁给包名与文件名。
- 徽章族合并（`.nav-badge` / `.rp-badge` / `.ab-badge` / `.sv-verdict-badge` 四套重复样式）
  仍留在 UI P4：它波及 4 个插件，属"看不见收益的视觉改动"，需要单独一批配视觉复核。
- 字符预算（`headMaxChars = 26`）是量出来的经验值，不是不变量；真正的保证来自三段结构。

### 5.100 看板 HK-4 批 · 快速打开的副行也照同一条规矩 + 一次全站裁剪扫描（2026-10-13 批，UI P4）

**触发**：§5.99 那条"身份不许裁"是量出来的，同一把尺子接着量别的界面。
新写一个一次性扫描器（CDP）：遍历 `body *`（跳过 Monaco 内部），凡 `overflow-x/y` 为
`hidden|clip` 且 `scrollWidth-clientWidth > 2` 的都报出来，并在
**1280 / 900 / 1120 三档视口**（`Emulation.setDeviceMetricsOverride`）下各跑一遍，
状态覆盖：欢迎页 / 项目+ERB / 设置浮层 / 快速打开 / 命令面板 / 写作模式。

#### 扫出来一条真缺陷（比工具条那条更疼）

```
X +389px of 379px  div.picker-list < button.picker-item < span.picker-secondary.dim
X +377px of 418px  …  «C:\game\eratw-sub-modding-…\ERB\口上・メッセージ»
（同屏 14 行全在 +337 ~ +389px）
```

快速打开（Ctrl+P）的副行是**整条目录**，CSS 尾部省略把**最深那一层**（作者包名 /
角色目录 `灵梦-少女之梦`）整个裁掉——而在一堆同名 `M_KOJO_K1_2_*.ERB` 之间，
**那个目录就是唯一的区分点**。工具条至少还有标签页兜着，这里没有：主行只有文件名，
副行只剩游戏根。三档视口全都如此（可分宽度根本没变，是结构问题）。

#### 修法：同一条规矩，第二段复用

`path-label.ts` 抽出 **`dirLabelParts(dir) → { head 可缩, tail 恒显 }`**，
`pathLabelParts` 改为在它上面组合（三段 = head / tail / base，一处规矩）。
`Palette.tsx` 的候选项把 `secondary: string` 换成 **`secondaryDir`**，渲染成
`.ps-head` + `.ps-tail` 两个 span；CSS 里 `.picker-secondary` 变成 flex 容器。

顺带**删掉一个此刻变成死的字段**：改完之后全仓再没有任何调用方设置 `secondary`
（命令面板的候选只用 `primary` + `hint`），所以把它连同它的渲染分支一起删——
不留"以防万一"。这也顺手去掉了中途一度用的 `:has()` 选择器写法（少一个运行时支持问题）。

| 项 | 前 | 后（实测同一状态、同一档视口） |
|---|---|---|
| `.picker-secondary` 裁剪 | 14 行各 +337 ~ +389px（最深一层目录不可见） | **`secClip = 0`**，副行显示 `C:\game\eratw…1 Reimu [霊夢] · 灵梦-少女之梦` |
| 命令面板 | 无副行（只用 `hint` 显示键位） | 不变（回归确认过） |
| 三档视口 1280 / 900 / 1120 | 三档全裁 | 三档全 `clip 0` |

#### 扫描的负结果同样登记（这些地方量过了，没动）

- **欢迎页 / 设置浮层 / 写作模式**：三档视口下**零裁剪元素**（含 900px 窄窗口）。
- **口上文件树的行**（`.tree-file`）：187px 里裁掉 6 ~ 61px。**刻意不改**——
  ① 树里截断是行业常态，且行上有 `title=完整路径`；② 侧栏本就可拖宽（壳层容器拖拽）；
  ③ 真要"保住中段"就得认识 `M_KOJO_K1_2_` 这种前缀模式，那是口上命名知识，
  **不该进宿主 UI**（硬约束：宿主零游戏知识）。这条留给"树行悬停预览"一类需求，不靠截断技巧解决。

#### 一条驱动通道上的坑（写下来给两边用）

**window 级合成 `Escape` 关不掉 picker**：ShellLayout 的 Esc 链第一句就是
`if (pickerRef.current) return;`——picker 自己监听 Esc（`stopPropagation`），
而它监听的是**自己输入框里冒泡上来的事件**。我最初从 `window` 派发 Escape，
它收不到 ⇒ 面板一直挂着，扫描里"命令面板"与"快速打开"两组数字一模一样，
差点被当成"两种 picker 都渲染同一份列表"的怪现象报出去。
正确姿势：`document.querySelector('.picker input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`。
⇒ 口径与 §九-35 同源：**驱动通道自己失败 ≠ 产品失败**；先确认事件真的到了那个处理器。

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test` | **1661 passed / 13 skipped（1674）**，97 文件 / 7 跳 |
| 数字闭合 | §5.99 自记 1658 + 本批 3（`dirLabelParts` 三条）= **1661** |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿 |
| `pnpm --filter @kojo/app build` | **✓ 1m30s**（本批动 `Palette.tsx` / `styles.css` / `path-label.ts`） |
| 实机 | 本组 CDP 自验（三档视口 + 两种 picker 前后对比），探针脚本与截图同批删除 |

### 5.101 实机复验批 · QA-2 语法糖行高：**收口**（2026-10-13 批，零代码改动）

**触发**：看板 QA-2（§5.76 留的"只有源码级证据，缺像素复核"）。原判据两条：
① 糖投影每行与原文件同 `lineHeight`、无累积漂移；② `--sugar-lh` 实测 = 19px（fontSize 14 × 1.35）。
这条本来派给别机，但它是**可数的**，不是"观感"——CDP 量能读完，就不该排队等。

#### 判据要先修对，否则量到的是假信号

糖视图的正文不在 `.view-line` 里，而在 **ViewZone**（实测 24 个）。所以"相邻行 top 差恒定"
**不是**这条判据的正确形式——zone 占位本来就会让可见行的 top 跳（本例第一处跳 76px = 4×19），
拿它当漂移会报出一个不存在的缺陷。正确的两条是：

1. **行高一致**：两种模式下 `.view-line` 的 computed `lineHeight` 相同；
2. **不产生累积错位**：**每个 ViewZone 的高度都是行高的整数倍**（偏差 = 0）。

#### 实测（真实壳、真实语料 `M_KOJO_K1_2_セクハラコマンド.ERB`，463 行 → 糖 349 行）

| 量 | 原文模式 | 糖模式 |
|---|---|---|
| `.view-line` computed `lineHeight` | **19px** | **19px** |
| 可见行数 / 相邻 top 差 | 38 行 / 19.00px，最大偏离 **0px** | 4 行 + 24 个 zone |
| zone 高度集合 | —（0 个） | **{285, 57, 380, 0} = 15×19 / 3×19 / 20×19 / 0** |
| **偏离"行高整数倍"的最大值** | — | **0px** ⇒ 无累积漂移 |
| `--sugar-lh` | — | **19px**，但**读的位置要更正**：它不在 `:root`、也不在 `.editor-body`，而是宿主在创建 ViewZone 时落在**zone 元素自己**上（`EditorPane.tsx:506`）。按原判据去读 `:root` 会得到空串，**误判成"变量没生效"** |
| 可逆性 | — | Ctrl+Alt+T 关 → 再开，数字回到同一组 |

⇒ **QA-2 通过**，判据②的数值成立、位置口径按实测更正；判据①以"行高一致 + zone 高度整倍"两条成立。

#### 一条观察（记下来，不当缺陷报）

糖模式里有**一个高度为 0 的 zone**。它对行对齐无影响（0 是 19 的 0 倍），本批也没有第二条证据
说明它是不是"空块的正常产物"（投影里连续不可映射的行可能整段塌成空 zone）。
⇒ 记为观察，不改代码、不派任务；若将来出现"糖视图里少一段看得见的内容"的真人反馈，这条是第一个线索。

#### 驱动侧的坑（写进 §九-38）

**写作模式（zen）跨次保留**：本组连着两轮量测被它坑——zen 下**没有活动栏**，
`🗀` / `.tree-group-btn` / `.tree-file` 全部 MISS，看起来像"文件树坏了 / 索引没出来"。
实际是上一次扫描结束时进了 zen 没退出，而它作为偏好被存住了。
⇒ 规矩：**量测前先测 `.shell.zen`**，需要侧栏就先 `Ctrl+K Z` 退出；或者干脆走 **Ctrl+P 快速打开**
拿文件（不依赖侧栏，本批最后就是这么跑通的）。

#### 验收（零代码改动 ⇒ 不造新合格证）

| 项 | 结果 |
|---|---|
| `pnpm test`（推送前复跑） | **1661 passed / 13 skipped（1674）**，97 文件 / 7 跳——与 §5.100 同数（本批只动 `docs/`） |
| 语料零写入 | 全程只读游戏目录；探针脚本 `.local/` 同批删除，dev 壳按 PID 树收干 |
| 看板 | **QA-2 → 完成（haruki 自验）**；判据②的读取位置按实测更正 |

### 5.102 看板 HK-4 批第三轮 · 对比度 / 点击目标 / 可访问名：一次全站可访问性量测（2026-10-13 批，UI P4）

**触发**：HK-4 前两轮（§5.99 / §5.100）量的是"内容被裁"，同一套 CDP 通道还能量另外两件事：
**文字读不读得清**（WCAG 2 对比度：正文 4.5:1、大字号 3:1）与**点不点得到**（2.5.8 最小目标 24×24），
外加"这个按钮有没有可访问名"。扫描覆盖五个真实状态：欢迎页 / 快速打开 / 项目 + ERB 糖视图 /
新建口上文件向导 / 设置浮层。半透明背景按从前往后合成到最近的不透明底，不是拿 `color` 眼估。

#### 先修尺子，再修界面（这条比修了什么更重要）

第一版把每个元素的背景**从它的父元素起算**——于是"白字压在蓝色主按钮上"整类漏报：
按钮自己的 `--accent` 底被跳过，白字对上了深色面板，算出 12:1 的漂亮数字。
改成"含元素自己的背景"之后，**全站最重要的那批控件当场红了一片**：

```
1.03:1 (需 4.5) ×1  .hint          rgb(139,148,158) on rgb(83,144,245)  «Ctrl+P»
3.32:1 (需 4.5) ×2  .primary.small rgb(255,255,255) on rgb(76,139,245)  «保存 (Ctrl+S)» «打开文件…»
3.32:1 (需 4.5) ×1  .small.primary rgb(255,255,255) on rgb(76,139,245)  «创建并打开»
3.48:1 (需 4.5) ×2  .ps-head/.ps-tail  rgb(139,148,158) on rgb(45,63,91)  «灵梦-少女之梦»
4.04:1 (需 4.5) ×2  code           rgb(76,139,245) on rgb(44,47,52)     «M_KOJO_K0.kojo»
4.41:1 (需 4.5) ×1  .ghost.small   rgb(76,139,245) on rgb(36,41,47)     «语法糖视图»
点击目标 < 24×24： 10 类，全部 23px 高（.small 按钮族）+ 17×17（.tab-close）
```

⇒ 口径：**量测器自己不达标时，"没有报告"不等于"没有问题"**。（与 §九-35/37/38 同源：
先怀疑通道，再下结论。）

#### 根因是一个 token 被要求同时干两件相反的事

`--accent: #4c8bf5` 既当**填色底**（上面压白字 → 3.32:1，不够）又当**文字色**（压在深底上 →
4.04 / 4.41:1，也不够）。同一个色值在这两个方向上不可能都过，所以拆档而不是调一个数：

| 档 | 用途 | 实测 |
|---|---|---|
| `--accent` #4c8bf5 | 描边、焦点环、选中高亮、`accent-color`（非文字元素按 3:1） | 对深底 4.15:1 ✓ |
| **`--accent-strong` #2e6fd1**（新） | **填色主按钮的底**（白字压上去） | **4.87:1** ✓ |
| **`--accent-text` #6ea8ff**（新） | **accent 当文字用**（`.sugar-toggle.on`、向导里的 `code`） | **5.54:1** ✓ |

另外三条：
- **主按钮里的快捷键芯片**（`.hint` 默认是给深底用的灰，压到蓝底 = **1.03:1，等于看不见**）
  → 按钮内改白字 + 压暗底（`rgba(0,0,0,.22)`），实测 **7.07:1**。
  注意"给芯片加白色半透明底"是**反方向**的直觉：那会把蓝底提亮到 3.8:1，仍不达标——**压暗才对**。
- **选中行的副行**（快速打开那一条的 `--fg-dim` 压在 `--accent-dim` 上 = 3.48:1）→ 选中时回到正文色；
  未选中行仍保持次要层级（层级不该以"读不清"为代价）。
- **`.small` 全站 23px 高 / `.tab-close` 17×17** → 补 `min-height: 24px` 与 24×24 可点区
  （字形与密度几乎不变；关闭是会丢东西的动作，不该靠瞄准）。

#### 修后（同一把尺子、同样五个状态）

**对比度不达标 0 条 / 点击目标 < 24×24 共 0 类 / 无可访问名按钮 0 个**（五状态各自为零，不是抽样）。

#### 刻意没做

- **其余 13 处 `color: var(--accent)` 没有预先换成 `--accent-text`**：量测里它们**一条都没报红**
  （要么不是文字、要么本次五个状态里不可见）。"看见 token 就全量替换"是把尺子丢了改一遍——
  哪条被量出来改哪条，规则写在 token 注释里给后来人。
- **`×` 关闭按钮平时 `opacity: 0`（悬停才现）**：目标尺寸补齐了，但"看不见就可点"这件事本身没改。
  它是 VSCode 式的刻意设计，且有键盘等价物（Ctrl+W）；要动得先定"触屏/低精度指针怎么办"，不属本批。
- 口上文件树的中段截断（§5.100 已记）：要保中段就得把 `M_KOJO_K1_2_` 命名知识带进宿主 UI，不做。
- 只在 1280 宽下量了对比度——对比度与视口宽度无关（颜色不随宽度变），故未跑三档；
  目标尺寸同理是固定像素。

#### 验收

| 项 | 结果 |
|---|---|
| `pnpm test` | **1661 passed / 13 skipped（1674）**，97 文件 / 7 跳——与 §5.100/§5.101 同数（纯 CSS，无新可测行为） |
| typecheck root / app | exit 0 / exit 0 |
| `audit:decoupling` | A–D 全绿 |
| `pnpm --filter @kojo/app build` | **✓ 1m30s** |
| 实机 | 本组 CDP 量测（五状态前后各跑一遍），探针脚本同批删除、壳按 PID 树收干 |

### 5.103 实机复验批第三轮 · 造一个 fixture 工程，把 QA-9 游戏目录半边与 QA-10 余下三家一次收掉（2026-10-13 批，零代码改动）

**触发**：看板上还挂着两条"要真人真目录"的尾巴——
QA-9 的游戏目录半边（回执里写"需要一个可以往里写的项目目录，而真实语料零写入是硬约束；
**建议造一个最小 fixture 工程**"）与 QA-10 余下三家模态（写权限批准 / ERB 解锁 / 糖视图须知，
§5.96 明记"本机不碰未批准路径、只读态编辑意图没触发、须知是一次性提示"）。
三条卡的是同一个前提：**得有一个可以随便写的"游戏目录"**。那就自己造一个。

#### fixture 配方（两边都用得上，全程不往 `C:\Game\…` 写一个字节）

`detect()` 的特征组合只有两条（`eratw-adapter/plugin.ts:368`）：`ERB/口上・メッセージ関連` + `CSV/Chara` 同时存在。于是：

```
%TEMP%\kojo-fixture-game\
  CSV\Chara\Chara0.csv            ← 真实语料**字节级复制**（255 B）
  CSV\Chara\Chara1 霊夢.csv        ← 同上（1,642 B）
  ERB\口上・メッセージ関連\個人口上\001 Fixture [霊夢]\少女之梦-试验包\M_KOJO_K1_2_テスト.ERB   ← 自造（BOM + CRLF）
```

打开方式绕开原生文件夹对话框（CDP 驱动不了它）：**把 fixture 路径写进
`%APPDATA%\dev.kojo.editor\store\_global\recent-projects.json`**，欢迎页的「最近打开」就会出现一条可点的入口
（改前先备份，跑完原样还原）。整个 fixture 6KB，`detect → loadProject → 索引` 在 429ms 内完成，
角色表从真 CSV 解析出 `#1 博丽 灵梦`、口上树认出 1 个包 1 个文件——**结构真实，体量归零**。

#### 一次收掉四条

| 判据 | 结果 | 实测证据 |
|---|---|---|
| **QA-9 游戏目录半边**（外部新增要上树，HK-5 的原始场景） | ✅ | 包已展开的状态下，**外部进程** `writeFileSync` 一个 `外部新增验证.ERB` 进游戏目录侧的包 → `.tree-file` **825ms** 出现它；`unlinkSync` 删 → **824ms** 消失；期间**包与角色组的展开态都保住**（这是"失效缓存但不丢展开态"的原始判据） |
| **QA-10 ① 写权限批准** | ✅ | 打开 fixture 项目即弹「写权限确认」（列出 `…\個人口上` 与 `…\sav` 两条 + "游戏目录的其余部分保持只读"，按钮 `只读浏览` / `允许写入(primary)`）→ 按 **Esc** → 顶部横幅「当前为只读：写权限未批准，保存不可用…」+ 状态栏徽章 **只读** ⇒ 落在不写盘那一格 |
| **QA-10 ① ERB 解锁** | ✅ | 只读 ERB 上用**可信点击 + `char` 键**产生真实编辑意图 → 弹「ERB 只读保护」（`仍要直接编辑` / `保持只读(primary)`）→ **Esc** → 模态关、**标签不脏**、**盘上字节与打开前逐字节相同** |
| **QA-10 ① 糖视图须知** | ✅ | 该模态是一次性的（`localStorage['kojo.ui.sugarView.prompted.v1']`）⇒ 清掉标记、关标签、重开 ERB → 弹「语法糖视图」（`不用` / `开启(primary)`）→ **Esc** → 编辑器显示的是**原文**（`; テスト` / `#DIM A`，工具条无「语法糖 N 行」），且标记被写回 `'1'` ⇒ 落在"不用"那一格，不是只把窗关掉 |

⇒ **QA-10 五家全部实机过**（§5.96 的两家 + 本批三家），**QA-9 两半都收**。
顺带一眼确认：fixture 的 CRLF ERB 状态栏读作 `utf-8-bom · CRLF · 3 行`（换行识别没有被工作区口径带偏）。

#### 一条新的驱动坑（§九-39）

**活动栏的视图按钮是切换式的**：目标视图已经可见时再点它的图标，会把它**整个藏掉**。
第二趟就这么把 `.tree-group-btn` 点没了，于是一整轮选择器全部落空、外部新增"没上树"——
看起来像 HK-5 的失效通道在游戏目录侧失灵，实际是我自己把面板关了。
⇒ 规矩：**先测目标元素在不在，再决定点不点**（`if (count === 0) click(...)`），
别把"点图标"当成"切到那个视图"的幂等操作。

#### 没做的

- **QA-3 的"引擎真的读出台词"那一半**仍留别机：fixture 能验"部署落盘是 `.ERB`、无 `.kojo` 残留、不覆盖"，
  但"Emuera 加载后游戏里读出台词"需要真引擎真目录。⇒ QA-3 状态改成**部分可自验**，别机跑引擎那一半。
- 没给 fixture 造 `sav/`（模态里列了这条路径但不存在，不影响本批判据）。
- **零写入复核**：`find C:\Game\… -type f -newermt "2026-10-13 02:00"` 本批跑完仍是 **0 命中**；
  fixture 目录、临时脚本、被改过的 `recent-projects.json`（先备份）全部删除/还原。

#### 验收（零代码改动）

| 项 | 结果 |
|---|---|
| `pnpm test`（推送前复跑） | **1661 passed / 13 skipped（1674）**，97 文件 / 7 跳——与 §5.102 同数 |
| 机器状态 | 壳按 PID 树收干；`%APPDATA%` 的 recents 原样还原；fixture 与探针全删；真实语料 0 写入 |
| 看板 | **QA-9 → 完成（两半）**、**QA-10 → 完成（5/5 家 + 层叠）**、**QA-3 → 拆成两半** |

### 5.104 实机复验批第四轮 · 判据②人工清单 §2.J：勾掉四格，并**修掉一条已经过期的判据**（2026-10-13 批，零代码改动）

**触发**：QA-7（别机已认领的 §2.J j1–j9）。fixture 配方（§5.103）既然已经跑通，
判据②那九格里有几格其实**本机就能量**——而清单一直等着"真人"，等于把可数的东西挂在了不可数的队列上。

#### 勾掉的（附实测原话）

| 格 | 结果 | 证据 |
|---|---|---|
| **j1 监视起来了** | ✅ | 打开 fixture 项目后通知区为空、无红色通知；紧接着弹的是**写权限确认**（不是监视降级），点「允许写入」后徽章转「可写」 |
| **j2 外部改动跟随** | ✅（一小条留给真人） | 外部进程 `writeFileSync` 改一个**已打开且干净**的 ERB → **306ms** 编辑器自己变成新内容（轮询粒度 300ms，即下一个 tick 就跟上），状态栏原文正是清单要的那句 **「已从磁盘重新加载（文件在外部被修改）」**，标签保持「已保存」 |
| **j4 自身保存不是回声** | ✅ | 已授权写的项目里点「保存 (Ctrl+S)」→ 通知区为空、状态栏仍「已保存」，没有任何"重新加载"提示（原子写的多条平台事件被去抖成一条且内容与 model 相同 → noop） |
| **j5 删除可见** | ✅（§5.96 已验，本次并入清单） | 外部 `unlinkSync` 删掉正打开的文件 → 通知原文「…已在磁盘上被删除。编辑器里的内容现在是唯一副本——保存会重新创建该文件。」，标签数不变 |
| **j3 脏不被覆盖** | ⚠ 半格 | 通知文案与"内容保持不动"在 §5.96 已验；**动作按钮「重新加载（放弃我的修改）」没验到**——本组试图先解锁只读 ERB 再打字制造脏态，点完「仍要直接编辑」后注入的字符没落进缓冲区（标签始终不脏），于是没有可点的通知动作。留给真人键盘，**不猜它能不能用** |

#### 真正值钱的那一条：**j6 的判据本身过期了**

清单原文（§5.84 时代写的）：**"往口上目录新建一个 `.ERB` → 文件树与函数树不会自动出现"**，
并交代"这是已知边界，照实勾、不是失败"。
但 HK-5 / HK-6（§5.91 / §5.93）落地之后，**文件树会自己出现它**——§5.103 实测：
外部写一个 `.ERB` 进已展开的包 → **825ms** 上树；外部删 → **824ms** 消失；展开态全程保住。

⇒ 这条判据现在会把人带偏两次：真人看到文件树自己刷新，会以为"清单说不会，居然会"而**报一个不存在的缺陷**；
或者反过来，把"函数树确实不跟"当成"整条都还成立"而漏掉新行为的验收。
已按新口径改写：**文件树自动出现 = 通过**、**函数树 / 包计数不跟 = 已知边界（HK-1 余量，属性能线）**。

> 口径：**判据也会过期**。批次改完行为，得回头改**等着验这个行为的那张清单**——
> 否则清单就从"验收工具"变成"缺陷制造机"。这类"文档欠账"比代码欠账更难发现，因为它不会让任何测试变红。

#### 没做的

- **j7 降级必须可见**：判据要求"临时把一个不存在的目录塞进监视根"——那需要**改源码**再跑壳，
  与 §九-34（活壳 + 改源 = 验的是被临时改过的产品）冲突。要做就单独一批：停壳改 → 起壳验 → 改回，不与其他条目同跑。
- **j8 运行期失效**（拔根目录）与 **j9 归档列表自动重扫**（需要 `.sav`）：本机零存档 + 无 GUI 拔盘条件，
  照清单原话"未验"处理，仍留别机。
- **j2 的光标 / 撤销栈保留**：DOM 侧读不到 Monaco 内部栈，真人一格 Ctrl+Z 即可确认；已在清单里写明留给别机。

#### 验收（零代码改动）

| 项 | 结果 |
|---|---|
| `pnpm test` | **1661 passed / 13 skipped（1674）**，97 文件 / 7 跳——与 §5.102 / §5.103 同数 |
| 机器状态 | fixture 目录与临时脚本删除；`recent-projects.json` 先备份后还原（原样一条真实语料）；真实语料 `find -newermt` = **0 命中**；壳按 PID 树收干 |
| 看板 | QA-7 → 部分完成（j1/j2/j4/j5 + j6 判据更正；j3 动作按钮、j7/j8/j9 留别机） |









