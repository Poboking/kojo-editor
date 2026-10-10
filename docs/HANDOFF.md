# 交接文档（v0.1 ✅ / v0.2 第一批～第十七批 ✅ / v1.1 第十六批 ✅）

> 更新：2026-10-10。**新会话从这里开始读，读完即可开工。**
> v0.1 全量（含桌面壳端到端）+ v0.2 第一批（约定校验器 + 索引响应式化）；
> 第二批：函数树导航（`ui-kojo-navigator`）；
> 第三批：条件谓词抽取（`condition-extractor`）+ 导航条件徽章 + adapter 变量字典；
> 第四批：存档快照源（`sav-parser`，服务 `snapshot.source`）；
> 第五批：状态回放引擎（`state-replay`，服务 `state.replay`）；
> 第六批：回放求值器扩展——本地量数据流 + 引擎内置纯函数 + 调用上下文注入（未知率 62.9% → 48.5%）；
> 第七批：有界内联求值——口上域 `#FUNCTION` 纯助手顺序解释（未知率 48.5% → 32.0%，call 桶消解 84%）；
> 第八批：`ui-state-replay` 回放面板（第 10 个插件）——选档 × 选角色 × 选函数 × 逐条谓词三值结果，导航面板 ⟲ 联动；
> 第九批：分支走向——谓词结果按 IF 链 / SELECTCASE 链折叠，回放面板显示"该状态会走哪个分支"（含可达性传播）；
> 第十批：口上调用协议——adapter 解析 KOJO_MESSAGE.ERB 路由表 → 槽位语义表，回放面板结构化场景参数输入（协议不可用优雅降级）；
> 本会话完成 **v0.2 第十一批：存档写侧预研——ByteWriter + serializePayload + 金样本回归，save00 载荷 571,185B 逐字节完全一致（编码器同构达成）；暴露 Int64 精度硬前置（RANDDATA 等），方案 B（rawBytes 保留）写入 §5.17**。
> 本会话完成 **v0.2 第十二批：审阅修复（依据 docs/CODE-REVIEW-2026-10-10.md）——H1 CASE TO 区间 AND 语义（conjunction 契约 + 三层落地）+ M4 切文件丢内容（确认对话框）+ M5 回放联动闭包 + M2 Rust 编码 had_errors + L1/L3/L4；426 项全绿，回放基线不变**。
> 本会话完成 **v0.2 第十三批（双线）：① sav-parser Int64 精度方案 B 落地（rawBytes passthrough）——六档金样本 passthrough 全部字节级一致（含此前被拒的 save01-05）+ 标量/单元补丁注入 + Int64 守卫；纠正第十一批结论：RANDDATA 是 u32 序列逐值安全，真雷在 RESULT/CFLAG/GIFT_GOT（IMPLEMENTATION-LOG §5.19）；② TRAE 并行交付 ui-archive-browser 归档浏览器（第 11 插件，commit ca1a323）；456 项全绿**。
> 本会话完成 **v0.2 第十五批（v1.0 收口线一）：回放面板场景预设**——把手填的调用上下文槽位一等化为「场景」（命名保存 / 下拉切换 / 一键应用 / 删除）；`ReplayScene` 纯逻辑（+15 单测）+ `ctx.storage` 独立域（`ui-state-replay`）+ 协议降级（建议名 label 拼接 / 不可用则纯手填）；应用后槽位来源标 manual（作者假设，非引擎事实），与 §5.20 的 assumption 徽章并存；回放引擎与 condition-extractor 契约零改动；485 项全绿（IMPLEMENTATION-LOG §5.22）。
> 本会话完成 **v0.2 第十七批：桌面壳端到端冒烟——tauri dev 真实 IPC 下跑通 Rust 双闸 a–e 全清单（域内放行 / 域外 fail-closed 拒绝 / 关项目后回落 appDataDir），固化自动化探针 `tools/smoke-tauri-ipc.mjs` + 手工清单 `tools/smoke-tauri-manual.md`；沙箱 os error 231 未复现；零源码改动（IMPLEMENTATION-LOG §5.24）**。
> 本会话完成 **v1.1 第十六批：存档注入器用户面——写链路端到端**——新服务 `snapshot.writer`（契约 `SnapshotWriteService`，读写职责分离）+ sav-parser 0.3.0（容器组装 container.ts / 回读验证 verify.ts / engine.inject：Int64 守卫先于备份 → 先备份 → 写盘 → 回读验证，失败报错携带备份路径）；新插件 `ui-snapshot-injector`（第 12 插件：选档→定位变量→编辑→diff→两步确认注入）；修复 eratw-adapter writablePaths 缺 sav 目录的真实缺口；kernel 集成第 9 节（appData 副本端到端 + 越权拒绝 + Int64 守卫，绝不写真实游戏档）；509 项全绿（IMPLEMENTATION-LOG §5.23）。
> 本会话完成 **v0.3 批 S1：语法糖契约 + golden 固化**——新契约 `packages/plugin-api/src/sugar.ts`（SugarDoc / SugarNode 联合 15 型 / AliasValue 四右值[变量可读写、角色·数值·字符串只读] / SugarDiagnostic 23 码闭集 / 行级 SugarSourceMapEntry / SugarTranspileService；每节点带 1 基行列源位置）+ 服务键 `sugar.transpile`（实现 `kojo-sugar` 插件 S2 建）+ golden fixture（规范 §6.1/§6.2 源与期望产物，**逐字节等于规范原文**、测试按规范行号切片比对；期望产物 `.erb.todo` 暂存 + `describe.skip` 待 S2 转正式）；**不实现转译器**；555 项全绿（IMPLEMENTATION-LOG §5.26）


---

## 一、项目一句话

**kojo-editor** = eraTW 口上编辑器：结构感知（Monaco + ERB 语法）× 一切皆插件 × sav 快照回放（远期差异化核心）。
技术栈：pnpm monorepo · TS（TS7/vitest4/vite7）· Tauri2（Rust 只做 IO 原语）· React 19 · Monaco。

- 仓库：`D:\DSH\kojo-editor` = github.com/Poboking/kojo-editor
- 测试游戏目录：`D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)`（汉化整合版，CSV/ERB 均 UTF-8-BOM）

## 二、当前状态（30 秒版）

- **v0.1 全部完成**：kernel（DI/总线/存储域/文件IO/槽位/运行时）+ plugin-api + 3 插件 + Tauri 桌面壳，端到端已验证。
- **v0.2 第一批完成**（本会话）：
  1. **索引所有权收敛到 `erb-parser`**：订阅 `project.opened` 自动建索引并缓存，`currentIndex()/ensureIndex()` + `kojo.functionChanged` 广播；app 不再自建索引。
  2. **约定校验器**：`plugin-api/conventions.ts` 契约 + 新插件 `convention-linter`（引擎 + 内置通用规则）+ `eratw-adapter/conventions.ts`（4 条 eraTW 规则）+ 新插件 `ui-convention-report`（面板，点击问题跳转）。
  3. **通用导航事件 `editor.revealLocation`**（内核事件表新增）+ app 落地（打开文件并定位行）。
- **v0.2 第二批完成**（上一会话）：
  1. **新插件 `ui-kojo-navigator`**（`ui.panel`）：角色 → 家族 → 面 → 函数 三维树；角色下拉 + 全量函数名搜索（含未归属）；点击 → `editor.revealLocation`。
  2. **`tree.ts` 纯逻辑**（零 React）：面语义排序（FACE_ORDER）、slot 数值排序、`declare` 单独成面、orphan 只计数不展开（99k 函数里非口上域占大头）。
  3. **家族规则经槽位查询获取**（按 `project.adapterId` 精确匹配），**不 import adapter 包**——多游戏共存天然正确。
  4. 集成冒烟新增「导航地基」断言：可归属角色 / 多家族角色 / 多面角色 / 最重角色。
- **v0.2 第三批完成**（本会话）：
  1. **scanner 扩展 `scanControlFlow`**（erb-parser）：控制流骨架线性输出（kind / 条件原文 / 块深度 / 行号）；配对表以引擎 `FunctionIdentifier.cs funcMatch` 为准（IF→ENDIF / REPEAT→REND / TRY系 / PRINTDATA系…）；孤儿闭合向栈内查最近匹配（宽容不中断）。服务 `ErbParserService.scanControlFlow` 暴露。
  2. **新插件 `condition-extractor`**（服务 `condition.extractor`）：ERB 表达式子集解析器（Pratt，优先级以 `OperatorCode.cs` 为准）→ `ConditionExpr` AST + 函数级 `StateDependency` 聚合；**包容降级**（opaque，绝不抛）；CASE 展开（`==值`/`IS >= n`/`a TO b`/逗号列表）；订阅 `kojo.functionChanged` 串行调度全量抽取。
  3. **契约**：`plugin-api/conditions.ts`（AST/依赖/索引/服务）+ `ControlFlowStatement`（erb.ts）。
  4. **adapter `variableSchema`**（CSV 驱动）：扫描游戏 `CSV/*.csv` 名称表（33 张）建编号↔名称双向字典；引擎经槽位查询透传标注（恋慕/好感度…）。
  5. **导航条件徽章**：`ui-kojo-navigator` 函数行显示 schema 标签徽章（悬停看阈值）。
- **v0.2 第四批完成**（第四批会话）：**存档快照源（`sav-parser` 插件，服务 `snapshot.source`）**——v1.0 快照回放的读侧地基。
  1. **契约 `plugin-api/snapshot.ts`**：`SnapshotArchive`（元数据 + 角色区 + 变量区 + EM 扩展区）/ 变量模型（标量 / 稀疏数组 / Map / Xml / DataTable）/ 扫描结果 / `SnapshotSourceService`（scan / current / parse / subscribe）。**服务键命名决策 `snapshot.source`**（非 `sav.parser`）：审计 A 项禁裸 `sav` 词（契约层零游戏/格式名词），且"快照来源"语义本就是三来源（sav/CliDebug/手工）的统称——IMPLEMENTATION-LOG §5.10 有记录。
  2. **新插件 `sav-parser`**（第 8 个插件）：字节原语（7-bit **字节数**前缀字符串 / 整数编码）+ 六种数组游程解码 + 顶层 / 角色块 / 变量流 / EM 区解析 + gzip（`DecompressionStream`，跨 Node/WebView，不 import node:zlib）。**纯读先行**（写 / 注入随 v1.1）。
  3. **响应式**：订阅 `project.opened` 扫 `project.savDir`（`headerOnly` 浅解析列档，6 档 27ms）；`project.closed` 清空；代际保护；无 `savDir` → 空结果（显式）。
  4. **测试**：58 项单测（合成字节 round-trip 全类型 + 错误路径 + 编排）+ 集成冒烟六档断言 + 与逆向 CJS 解析器逐字段交叉对拍（一次性，16,000 变量/档全等）。
- **v0.2 第五批完成**（本会话）：**状态回放引擎（`state-replay` 插件，服务 `state.replay`）**——v1.0 快照回放的**求值侧**地基。
  1. **契约 `plugin-api/replay.ts`**：`ReplayStateView`（状态视图）/ `ReplayValue`·`ReplayOutcome`（三值）/ `ReplayUnknown`（原因分类 16 种）/ `FunctionReplay`（置信度三档）/ `StateReplayService`。
  2. **新插件 `state-replay`**（第 9 个插件）：Emuera 变量寻址语义（TARGET 补位 `X:i`≡`X[TARGET,i]`、全局 `X`≡`X:0`、MASTER/ASSI 顶层指针、#DIM 数据驱动）+ **三值求值器**（Kleene：`false && unknown = false`）+ 编排（createView / replayFunction / replayFunctions）。
  3. **condition-extractor 扩展**：`functionPredicates()` 按需谓词明细（读文件 → `scanControlFlow` → 逐条 AST；**不入全量索引**，文件文本 + 明细双缓存，索引重建自动失效）；契约新增 `FunctionPredicate`/`FunctionPredicates`。
  4. **adapter 契约扩展**：`VariableInfo.resolvedIndex`（具名索引 → 编号：`TALENT:恋慕` → 3，引擎关键字字典语义）。
  5. **测试**：62 项 state-replay 单测（连 Kleene/寻址全类别/错误路径/编排）+ 4 项明细 API 测试 + 集成冒烟回放断言。
- **v0.2 第六批完成**（本会话）：**回放求值器扩展——本地量数据流 + 引擎内置纯函数 + 调用上下文注入**（IMPLEMENTATION-LOG §5.12 为权威记录）。
  1. **先测量再动手**：实测推翻批五"未知主因 = `ARG:*`"假设——真实构成 pseudo 4,439（**LOCAL 系为主**）/ call 2,485 / ARG 系仅 ≈1,005（14%）。口上作者大量使用"直线赋值的局部开关"（`LOCAL = 1` / `LOCAL:1 = 1`，K49 语料 97% RHS 为纯数字常量）。
  2. **本地量数据流**：`collectAssignments`（condition-extractor，仅明细路径，聚合零开销）收集 `LOCAL/LOCALS/RESULT/RESULTS` 直线赋值；`buildContextLookup` 段栈折叠出**分支上下文路径**；求值侧 `locals.ts` 叠加层按"**前缀可达 + last-write-wins**"解析（兄弟分支互不可达、闭合块外不吃块内赋值、RHS 递归 + 记忆化、`+=` 记为失效点）。引擎依据 = ConvertArg/IntoFunction（Process.CalledFunction.cs:162-239 + Process.State.cs:495-515）。
  3. **内置纯函数**（`builtins.ts`，Creator.Method.cs 逐条对齐）：GETBIT / GROUPMATCH / MAX / MIN / ABS / SIGN / LIMIT / POWER；错误路径 → unknown('builtin') 不抛错。明确不收录：数组区间族 / GETNUM（等 adapter schema 通道）/ 字符串形态族 / RAND。
  4. **调用上下文**：`ReplayCallContext{ints,strs}`（裸 ARG ≡ ARG:0，引擎 1D 裸引用语义）注入 `replayFunction(view, name, {callContext})`；未提供/未覆盖 → unknown('call-context')，**不猜测 0**（转发自路由层的值是场景输入）。adapter 口上调用协议（路由表 → 转发实参映射）留作 UI 场景选择器地基（默认流收益实测 ≈ 0）。
  5. **测试**：+29 单测（assignments 识别与上下文 / locals 叠加 / builtins 语义）；集成冒烟新增数据流与调用上下文断言 + 未知率守门（<55%）+ 未知分类打印。
- **v0.2 第七批完成**（本会话）：**有界内联求值——口上域 `#FUNCTION` 纯助手顺序解释**（IMPLEMENTATION-LOG §5.13 为权威记录）。
  1. **先测量再动手（第四次应验）**：对 call unknown 做**被调函数形态分析**（临时 dump 跑完即删），实测推翻批六预估——call 覆盖 26 名 / 2,805 谓词中，**口上索引域内有定义仅 3 名 / 1,991 条（71%）**（`陷落状态`×1830 + `关系_310`×160 + `陥落状態`×1）；23 名（FIRSTTIME 等）定义在 kojoPaths 之外（COMMON.ERB 等），本就不可内联（FIRSTTIME 写 CSTR 副作用）。可内联函数体 100% 为 IF/ELSEIF/SIF/RETURNF + **ARG 补位赋值**（`SIF !ARG / ARG = TARGET` 惯用法）——唯一拦路的是 ARG 不在批六收集名单。
  2. **契约**：`FunctionAssignment.name` 扩 `'ARG'|'ARGS'`（结构事实；静态叠加层不消费——ARG 读取仍走 call-context 注入优先）；`FunctionPredicates` +`endLine` / +`returns`（RETURNF 结构事实）。
  3. **抽取**（condition-extractor）：`ASSIGN_RE` 扩 ARG/ARGS + `collectReturns`；明细路径产出 endLine/returns（聚合路径零开销）。
  4. **求值**（state-replay）：`inline.ts` 预编译 + **PC 顺序解释器**（SIF 条件体 / IF 链 / RETURNF / 环境读 / **索引段替换** `TALENT:ARG:恋人`）；`evaluate.ts` 求值通道重构 `EvalContext{read, resolveCall}`；`InlineManager`（analyze 缓存 + `preanalyze` BFS 预热 → 执行期同步命中）；state-replay `requires` 增 `kernel.io`。
  5. **实现最微妙的坑**：ELSEIF/ELSE op 的两种到达方式（条件假跳转 vs 分支体自然掉落）——编译期把"假跳转到 ELSE"改写为直接进体（`elseIdx+1`），运行期 `pendingEval` 标记区分"跳转到达 ELSEIF（求值）"与"自然掉落（跳 endAfter）"。首版实现 ELSE 与 ELSEIF 双双踩中此坑（集成测试 ELSE 分支错误落到链尾兜底 RETURNF）。
  6. **真实回归**：未知 5,668→**3,741**（**48.5%→32.0%**）/ call 桶 2,297→**368**（消解 84%）/ exact 786→**836** / 全未知函数 70→**38**。+27 单测 + 集成冒烟守门 0.55→0.40 + 陷落状态内联专项断言。
- **v0.2 第八批完成**（本会话）：**`ui-state-replay` 回放面板（第 10 个插件）**（IMPLEMENTATION-LOG §5.14 为权威记录）。
  1. **面板**（`ui.panel`）：选档（`snapshot.source` 扫描 + saveMes 摘要）→ 选角色（`project.charaIndex`）→ 选函数（条件索引子串提示，≥2 字符）→ 逐条谓词三值结果（kind 徽章 + 原文 + 行号点击 → `editor.revealLocation`）+ 置信度徽章（确定/部分未知/无法判定）+ **未知原因分组**（code → 中文提示 + 计数）。视图按（档 × 角色）惰性重建 + 代际保护。
  2. **调用上下文输入**：`0=36, 1="约会"` 文本 → `ReplayCallContext`（panel-logic.ts 纯函数解析；带引号 → 字符串槽；解析失败红字提示不阻塞；空 → 不注入走 call-context unknown——场景输入绝不猜测）。
  3. **联动事件 `kojo.replayFunction`**（内核事件表新增，editor.revealLocation 同款模式）：导航面板函数行/搜索行加 ⟲ 徽章（stopPropagation）→ 回放面板自动填名并回放；UI 插件间零直接依赖。
  4. **登记**：四处（package.json/tsconfig paths/vitest aliases/vite aliases+deps）+ bootstrap.ts；`rp-*` 样式；`nav-badge.replay` 样式。
  5. **测试**：+11 单测（panel-logic 全路径）；400 项全绿；audit 10 插件 ✅；真实工程冒烟无回归；app build ✅。
- **v0.2 第九批完成**（本会话）：**分支走向**（IMPLEMENTATION-LOG §5.15 为权威记录）。
  1. **契约**：`BranchChainOutcome`（if-chain/select-chain × taken/no-match/unknown/unreachable）+ `FunctionReplay.branches`。
  2. **引擎**（state-replay `branches.ts`）：链栈配对折叠（与 scanner 配对表同源）+ **unknown 立即阻断**（后续真不可救——链语义与 Kleene 同构）+ **可达性传播**（链头在外层未进入分支区间 → unreachable，防"不可达却显示命中"误导作者）+ 宽容（孤儿分支跳过）。
  3. **呈现**：回放面板"分支走向"区（按 depth 缩进；✓/∅/?/· 四态标记；命中链显示条件原文+跳转行号；rp-branch* 样式）。
  4. **测试**：+14 单测（三态/阻断/短路/CASE 同行任一真/CASEELSE/嵌套可达/宽容三例）；集成冒烟分支断言（真实数据 IF LOCAL 链 taken）。
- **v0.2 第十批完成**（本会话）：**口上调用协议**（IMPLEMENTATION-LOG §5.16 为权威记录）。
  1. **先测量纠正过度承诺**：dump call-context 构成（ARG 槽 ≈200 函数：ARG:0×158/ARG:1×53，形态 `LOCAL:1 && ARG == 1`）+ 路由源码核验（口上函数 (ARG,ARG:1) = 路由 ARG:3/ARG:4 透传 = **纯场景输入不可推导**）——候选清单里"858 条自动消解"是想当然；协议真实价值 = 槽位语义标注 + 默认场景（全 0 是引擎转发链未设置槽的确定事实）。
  2. **契约**：`KojoCallSlot{index,kind,label}` + `KojoCallProtocol.slotsFor(fn)` + `GameAdapter.kojoCallProtocol?`（游戏知识只住 adapter）。
  3. **adapter**（`call-protocol.ts`）：解析 KOJO_MESSAGE.ERB 路由表 → 家族模板正则（尾部 {…}=数值时机 \d+ 优先 / %…%=字符串时机 .+）+ 槽位表（ARG:n→int / ARGS:n→str 按序绑定）；loadProject 加载、缺文件降级 undefined；+5 单测。
  4. **面板**：有协议 → 结构化场景参数输入区（每槽一框 + 转发来源 tooltip + int 预填 0；空=未提供不猜测）；无协议 → 回退文本框；**回放引擎零改动**。
  5. **验证**：集成冒烟协议断言（真实路由表 SPEVENT→2 槽/家族外 null）；419 项全绿。
- **存档解析基线（2026-10-10 实测）**：六档全绿——168 角色/档、16,005 变量/档（save00 16,000）、`#DIM` 恒 65、MASTERNAME 7/168、RANDDATA saveLen 625（**save00 nonEmpty=0 全零剪枝实证** / save01+ 全量）、MONEY 51 亿（Int64 路径）、EM 区 2 张 DT 表、**残余 0B**。
- **状态回放基线（2026-10-10 实测，第七批后）**：save03 × 古明地觉（K49）全量回放 **1,356 个含谓词函数 / 11,685 谓词**——命中 1,549 / 未命中 6,395 / 未知 **3,741（32.0%）**；置信度 exact **836** / partial 482 / unknown **38**。第七批后未知构成：pseudo 1,886（RAND 等运行期值）/ call-context 858 / call 368（索引域外函数）/ named-index 337 / local-no-write 196 / missing-var 80 / 其余 <20。
- **真实工程基线（2026-10-10 实测）**：168 角色 / 2,285 ERB / 99,104 函数 / 去重名 99,101；家族识别 98.91%（109 家族）；索引 ~2.9s；约定校验 757 项（~9s）。
- **v0.2 第十一批完成**（本会话）：**存档写侧预研**（IMPLEMENTATION-LOG §5.17 为权威记录）。
  1. **实现**（sav-parser 游戏无关）：`writer.ts`（ByteWriter：m_ReadInt 逆编码 + 7-bit 前缀 UTF-16LE）+ `serialize.ts`（serializePayload 载荷层重序列化）+ 金样本回归测试（六档守门）。
  2. **关键发现——数组游程是行驱动结构**：每行末必写 0xE0、每面末必写 0xE1（含最后一行/面，cursor 证据 GMF_MAPNAME=[12,0]）；首行（dx=0）不写行标记（初版误写 F1+0 → 24 字节差异，逐 token 对比定位修正）。
  3. **金样本结果**：save00 载荷 **571,185B 字节级完全一致**（编码器同构达成：游程/整数宽度/7-bit/流控制全对）；save01+ **Int64 大数近似不可写回**（RANDDATA SFMT 625 状态 ≈2.8e16，serialize 显式抛拒绝）——**v1.1 注入器硬性前置 = Int64 精度策略**，倾向方案 B（`rawBytes?` 原样复制未修变量 + 被修变量含大数拒绝注入）。
  4. **教训（§九-10 复发）**：联合判别式 narrow 不可靠（writeVar 的 int/str case）——显式守卫。
- **条件抽取基线**：95,504 函数 / **493,712 谓词（未解析 187 = 0.04%）** / 含依赖函数 31,609 / 依赖条目 164,910 / schema 标注 109,742（恋慕 17,993 / 好感度 480）/ 全量 ~6.2s（冷启动 ~13s）。
- **v0.3 批 S1 完成**（本会话）：**语法糖契约 + golden 固化**（IMPLEMENTATION-LOG §5.26 为权威记录）。
  1. **契约** `plugin-api/sugar.ts`：`SugarDoc`（front-matter + 时机列表）/ `SugarNode` 联合（TextLine·HeartLine·IfBlock·IfExpr·WhenBlock·WhenExpr·RandomBlock·RandomInline·ChoiceBlock·ColorBlock·RawLine·RawFunctionBlock·AliasDecl·TimingBlock·Interpolation）/ **`AliasValue` 四右值**（变量引用可读写；角色引用·数值·字符串字面量只读）/ `SugarDiagnostic` + 23 码闭集 / **行级** `SugarSourceMapEntry` / `SugarTranspileService`（parse / transpile / sourceOf）。
  2. **源映射地基**：每节点携 `loc{start,end}`（1 基行列，UTF-16 码元）；行级粒度为本批明确决策（列级留 S6，规范 §9 待实测第 3 条）；纯生成行 `sourceLine: null` 不伪造。
  3. **15 个显式类型守卫**（`isVariableAlias`/`isReadonlyAlias`/…）替代判别式 narrow（TS7 教训）；**只读性单一真源** = `isReadonlyAlias`。
  4. **golden fixture**：`kojo-sugar/tests/goldens/` 收录规范 §6.1/§6.2 源 + 期望产物（`.erb.todo`），**逐字节等于规范原文**（测试按规范行号切片，fixture 误改即红）；S2 转正式断言。
  5. **边界**：只碰 plugin-api + goldens；未碰 erb-parser/condition-extractor/state-replay；规范文档只读；无新插件（S2 建 `kojo-sugar`）。
  6. **并行线**：adapter 线（TRAE）WIP 使其 `ruleCount` 断言暂红（5→6 属其维护域）；stash 归位复跑确认本批无回归（回放基线逐字不变）。
- 测试：**485 项全绿**（无游戏目录时集成冒烟 1 项自动跳过）；typecheck（root + app）通过；解耦审计 ✅（**11 插件**）。
- **v1.0 收口完成**（本会话）：**协议覆盖校验规则**（IMPLEMENTATION-LOG §5.27 为权威记录）。
  1. **校验语义**：对 `call-protocol.ts` 解析的每个家族槽位，核对家族实际函数签名槽（`ErbFunction.params`）是否被 `KOJO_MESSAGE.ERB` 路由转发覆盖；声明槽 > 转发槽 ⇒ 该槽调用时**永远**收引擎默认值（0/空串）→ 结构化 `warning`（ruleId `eratw.kojo-call-slot-coverage`）。
  2. **覆盖语义 = 存在性**（`maxForwardedSlotsFor`，max-over-all-matching 模板）：任一匹配模板转发该槽即不算「永远」——修掉 `_CHILD_%ARGS:1%` 抢占通用模板导致的 156 条误报（193→36）。
  3. **TRYC 修复**：`ROUTE_LINE_RE` 补 `TRYCCALLFORM`（原漏；引擎 `ERB_EXCOM.khp:175` 确证，整合版 214 处）——修复后 ONABARE 4 实参模板可见，误报 37→36。
  4. **落位**：`eratw-adapter/conventions.ts` 第 5 条规则 + 闭包注入 `getProtocol`（ctx 刻意不暴露 adapter）；`plugin.ts` 传 `() => currentProtocol`；契约扩展 `EratwCallProtocol extends KojoCallProtocol`（不改 plugin-api）；`ui-convention-report` 零改动自然消费。
  5. **测试**：规则单测 3 路径（覆盖/不覆盖/协议不可用降级）+ call-protocol +5（模板具体性与覆盖语义）+ 真实语料 `corpus.test.ts`（36 条，全 warning，全「数值槽 声明 1 / 转发 0」）；kernel 集成冒烟 `ruleCount` 5→6 + 新增 `=== 36` 断言。
  6. **验证**：564 passed / 7 skipped（无 smoke）；569 / 2 skipped（带 smoke）；typecheck root+app ✅；audit ✅（13 插件）；**回放基线逐字不变**（K49 1356/11685/未知 3741/exact 836）。

## 三、文档索引（按权威性排序）

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **架构权威**：铁律、内核边界、GameProject 形状（§5）；实施记录已迁出（§5.8+ 留指针） |
| `docs/IMPLEMENTATION-LOG.md` | **批次实施记录**（原 ARCH §5.8–§5.19，2026-10-10 迁入）：每批实施细节 / 金样本发现 / 踩坑 |
| `docs/REVIEW-OPTIMIZATION-2026-10-10.md` | 方案级审阅（13 项：A1/D12 已落地，C7 排 v0.3，其余分级见其 §5） |
| `docs/RESEARCH.md` | 技术调研 |
| `docs/adr/0001-0004` | 工具链 / game.adapter 服务键语义 / 壳架构 / 快照来源服务键命名（snapshot.source） |
| `docs/HANDOFF.md`（本文件） | 交接状态 + 下一批动手清单 |
| `D:\DSH\reverse-engineering\eratw4.980-口上机制深挖.md` | **口上领域知识权威**（27 CASE 路由、MESSAGECHECK 位协议、家族命名、四件套） |
| `D:\DSH\reverse-engineering\eratw4.980-存档实战解析.md` | sav 协议（v1.0 前必读） |

## 四、代码地图（v0.2 第三批增补）

```
packages/
├── plugin-api/src/
│   ├── conventions.ts         # 约定校验器契约（规则/问题/上下文/报告/服务）
│   ├── conditions.ts          # 条件谓词契约（ConditionExpr AST / StateDependency / ConditionIndex / 服务 + FunctionPredicate(s) 明细 + ★第七批：FunctionAssignment.name 扩 ARG/ARGS、FunctionPredicates +endLine/+returns、FunctionReturn）
│   ├── snapshot.ts            # 存档快照源契约（ArchiveMeta/SnapshotArchive/变量模型/扫描/服务）
│   ├── replay.ts              # 状态回放契约（ReplayStateView / ReplayValue·ReplayOutcome / ReplayUnknown / FunctionReplay / StateReplayService）
│   ├── services.ts            # +WellKnownServices.ConditionExtractor / SnapshotSource='snapshot.source' / StateReplay='state.replay'
│   ├── events.ts              # +KernelEventMap['editor.revealLocation']
│   ├── erb.ts                 # ErbParserService +currentIndex()/ensureIndex()/scanControlFlow()；+ControlFlowStatement
│   └── game.ts                # VariableSchema/VariableInfo（+resolvedIndex：具名索引→编号）
├── kernel/src/bus.ts          # +KERNEL_EVENT_NAMES: 'editor.revealLocation'
├── plugins/
│   ├── erb-parser/src/
│   │   ├── scanner.ts         # +scanControlFlow（控制流骨架：配对/深度/条件原文/宽容）
│   │   └── plugin.ts          # 服务暴露 scanControlFlow
│   ├── eratw-adapter/src/
│   │   ├── variable-schema.ts # 变量字典（CSV 驱动；33 张名称表；编号↔名称双向 + resolvedIndex 填充）
│   │   ├── conventions.ts     # eraTW 4 条规则（KX/四件套/FORM/MESSAGECHECK）
│   │   └── constants.ts       # +csvDir
│   ├── convention-linter/src/ # 引擎（engine.ts + rules/duplicate-function.ts）
│   ├── condition-extractor/src/ # 条件抽取（expr/extract/engine/index；functionPredicates 明细 API + 双缓存 + assignments 本地量赋值收集 + 分支上下文 + ★第七批：ARG/ARGS 赋值 + collectReturns）
│   ├── sav-parser/src/        # 存档快照源（v0.2 第四批）
│   │   ├── binary.ts          #   ByteReader：7-bit 字节数前缀 / 整数编码 / 越界即抛
│   │   ├── arrays.ts          #   六种数组游程解码（0xF0/F1/F2/E0/E1/D8；cells 省略/截断）
│   │   ├── parse.ts           #   文件级解析（魔数/版本/顶层/角色块/变量流/EM 区）
│   │   ├── gunzip.ts          #   DecompressionStream gzip（Web 标准，不 import node:zlib）
│   │   ├── engine.ts          #   扫描编排（浅解析列档 / 并发 4 / 代际保护 / 订阅）
│   │   └── index.ts           #   装配（requires: kernel.io/kernel.project）
│   ├── state-replay/src/      # 状态回放引擎（v0.2 第五~七批）
│   │   ├── var-model.ts       #   引擎级变量清单（角色 22+4+CSTR+CDFLAG / 全局 / 伪变量 / 局部量）
│   │   ├── state-view.ts      #   归约（按 NO 定位角色块 / TARGET 补位 / 稀疏取值 / 越界与截断显式）
│   │   ├── evaluate.ts        #   三值求值器（Kleene / 整数除法截断 / BigInt 位运算 / 字符串 == / ★第七批：EvalContext{read, resolveCall}）
│   │   ├── builtins.ts        #   内置纯函数（GETBIT/GROUPMATCH/MAX/MIN/ABS/SIGN/LIMIT/POWER + ★isBuiltinName）
│   │   ├── locals.ts          #   函数级叠加层（本地量数据流前缀可达 + 调用上下文注入）
│   │   ├── inline.ts          #   ★ v0.2 第七批：有界内联解释器（analyze 预编译 + PC 顺序执行 + 环境读/索引段替换 + InlineManager 缓存/preanalyze 预热）
│   │   ├── engine.ts          #   编排（createView / replayFunction(s) / replayPredicates 纯函数 + ★InlineManager 集成 + resetCaches）
│   │   └── index.ts           #   装配（requires: kernel.project/kernel.slots/★kernel.io/snapshot.source/condition.extractor；project.closed/functionChanged → resetCaches）
│   ├── ui-convention-report/src/index.ts # ui.panel 面板（订阅 linter；点击 → revealLocation）
│   ├── ui-kojo-navigator/src/          # 函数树导航（tree.ts 纯逻辑 + index.ts 面板 + 条件徽章 + ★第八批：⟲ 回放徽章 → kojo.replayFunction）
│   ├── ui-state-replay/src/            # ★ v0.2 第八批：状态回放面板（第 10 个插件）
│   │   ├── panel-logic.ts              #   纯逻辑（调用上下文文本解析 / 未知分组 / 函数名提示；零 React 可单测）
│   │   └── index.ts                    #   ui.panel（选档×选角色×选函数 → 三值结果 + 置信度 + 未知分组；监听 kojo.replayFunction）
│   └── ui-plugin-status/src/           # 插件状态面板
└── app/src/
    ├── bootstrap.ts           # 注册 10 个插件
    ├── ui/App.tsx             # 订阅 kojo.functionChanged / editor.revealLocation
    ├── ui/ProjectView.tsx     # 透传 reveal
    ├── ui/EditorPane.tsx      # revealLine/revealNonce → Monaco revealLineInCenter
    └── styles.css             # 约定面板样式 +导航面板样式（nav-*）+ ★回放面板样式（rp-*）+ nav-badge.replay
```

## 五、验证矩阵（怎么跑）

```bash
cd D:\DSH\kojo-editor
pnpm install
pnpm test               # 485 项（无游戏目录时集成冒烟+金样本自动跳过）
pnpm typecheck          # root + app（app: pnpm --filter @kojo/app typecheck）
pnpm audit:decoupling   # 必须 ✅（plugins 数 10）
node node_modules/vitest/vitest.mjs run packages/plugin-api/tests/sugar.test.ts   # v0.3 S1：语法糖契约（类型守卫 / 别名只读性 / 源映射 / golden 逐字节）
# 真实工程集成冒烟（168 角色/2285 文件/99k 函数/家族覆盖率/导航地基/校验报告/条件抽取/存档六档/状态回放断言）：
KOJO_SMOKE_PROJECT="D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)" pnpm vitest run packages/kernel/tests/integration-plugins.test.ts
# 桌面壳（会弹窗 ~100s 自动关闭）：
node tools/smoke-tauri-dom.mjs
# 桌面壳真实 IPC 冒烟（Rust 双闸 a–e；CDP 直调 invoke；自动还原 store/文件/备份；会弹窗 ~2min）：
node tools/smoke-tauri-ipc.mjs
```

**架构铁律（改动前默念）**：
1. 内核/契约/Rust 宿主**零游戏名词**（审计 A 项，只查代码行；行尾 `// audit-allow: <理由>` 可豁免；**注意裸 `sav` 词也在黑名单**——`savDir`/`SavArchive` 这类带后缀的复合词不匹配、裸 `'sav'` 会挂）；
2. 插件**只许依赖 `@kojo/plugin-api`**，禁 import kernel、禁插件间交叉 import（审计 B/C 项；**测试文件豁免 C 项**）；
3. 游戏知识只能进 eratw-adapter；跨游戏共享术语（kojo/chara）放 plugin-api；
4. 内核不静默：inactive 必须可见、冲突必须 error、**校验规则抛错必须进 `report.failedRules`**；
5. 游戏目录整体只读，写入仅限用户批准的 `writablePaths`（白名单在内核 io 强制）。

## 六、v0.2 批次记录（第三批～第十七批，✅ 全部完成）

### 6.1 第三批：条件谓词抽取 `condition-extractor`

**实施结果**：三层落地全部完成——结构（`scanControlFlow`）/ 谓词（`condition-extractor` 插件）/ 语义（adapter `variableSchema` CSV 驱动）。

#### 交付清单
- **`scanControlFlow`**（erb-parser `scanner.ts` + 服务）：线性控制流骨架（kind/表达式原文/块深度/行号）；配对表以引擎 `FunctionIdentifier.cs funcMatch` 为准；孤儿闭合宽容；11 项单测。
- **`condition-extractor` 插件**（服务 `condition.extractor`）：`expr.ts`（表达式 tokenizer + Pratt 解析：全运算符 + `[[词]]` + 括号索引段 + opaque 降级）/ `extract.ts`（CASE 展开、依赖聚合、语言局部量排除、schema 标注）/ `engine.ts`（全量编排：并发 8、两指针切片、代际保护）/ `index.ts`（装配）。32 项单测。
- **契约**：`plugin-api/conditions.ts`（`ConditionExpr`/`VariableRef`/`StateDependency`/`FunctionConditions`/`ConditionIndex`/服务）；`plugin-api/erb.ts` +`ControlFlowStatement`。
- **adapter `variableSchema`**：`variable-schema.ts`（扫描 `CSV/*.csv` 名称表 33 张；编号↔名称双向 lookup）；`constants.csvDir`。7 项单测。
- **导航条件徽章**：`ui-kojo-navigator` 函数行显示 schema 标签（恋慕/好感度…）+ `+n` 折叠；悬停看阈值；`.nav-badge.cond` 样式。

#### 关键设计（详见 IMPLEMENTATION-LOG §5.9）
- 谓词**聚合**存储（函数级 `StateDependency`），不存全量谓词对象——49 万谓词的量级必须聚合控制内存。
- `opaque` 降级**绝不抛错**；未解析计数显式呈现（不静默）；未解析率 0.04%。
- 局部量排除名单（LOCAL/ARG/RESULT/COUNT 系）是**通用语言知识**（Emuera 内置），不违"零游戏知识"。
- schema 标注按 `project.adapterId` 精确匹配（复用 ADR-0002 槽位查询通道）。

#### 真实数据口径（排障用）
- KX 占位符 603 条出自"函数名去重计"；条件抽取 95,504 函数中 31,609 含状态依赖（66.9% 函数无状态条件 = 大量纯文本/工具函数）。
- `CFLAG:2`（好感度）条件依赖合计 480 函数——比想象少（作者更常用 `TALENT:恋慕` 门禁，17,993 函数）；矩阵设计时以 TALENT 维度为主。

### 6.2 第四批（✅ 已完成）：存档快照源（`sav-parser` 先行）

**实施结果**：契约 + 插件 + 测试 + 集成全量落地（IMPLEMENTATION-LOG §5.10 为权威记录）。

- **契约**：`plugin-api/snapshot.ts`（`SnapshotArchive` / 变量模型 / `SnapshotSourceService`）；服务键 **`snapshot.source`**（非 `sav.parser`，理由见IMPLEMENTATION-LOG §5.10）。
- **插件** `sav-parser`：`binary.ts`（7-bit 字节数前缀 / 整数编码）+ `arrays.ts`（六种数组游程解码）+ `parse.ts`（文件级全流程）+ `gunzip.ts`（`DecompressionStream`）+ `engine.ts`（扫描编排）+ `index.ts`（装配）。58 项单测（合成字节）。
- **真实回归**：与逆向 CJS 解析器逐字段对拍（六档全等，16,000 变量/档）；集成冒烟六档断言（零残余 / #DIM 65 / MASTERNAME 7 / RANDDATA 剪枝实证 / MONEY 51 亿 / EM 2 表）。
- **写侧（v1.1）未动**：金样本"原样写回逐字节对比"与注入 UI 是后续阶段。

### 6.3 第五批（✅ 已完成）：状态回放引擎（`state-replay`）

**实施结果**：契约 + 插件 + condition-extractor 明细扩展 + 测试 + 集成全量落地（IMPLEMENTATION-LOG §5.11 为权威记录）。

- **契约 `plugin-api/replay.ts`**：`ReplayStateView` / `ReplayValue`·`ReplayOutcome`（三值）/ `ReplayUnknown`（16 种原因分类）/ `FunctionReplay`（置信度三档）/ `StateReplayService`。服务键 **`state.replay`**。
- **插件 `state-replay`（第 9 个）**：`var-model.ts`（引擎级变量清单）/ `state-view.ts`（归约：按 NO 定位角色块、TARGET 补位、稀疏取值、越界与截断显式）/ `evaluate.ts`（三值求值：Kleene / 整数除法截断 / BigInt 位运算 / 字符串 `==`）/ `engine.ts`（编排）/ `index.ts`（装配）。62 项单测。
- **condition-extractor 扩展**：`functionPredicates(name)` 按需明细（读文件 → `scanControlFlow` → 逐条 AST；不入全量索引；文件文本 + 明细双缓存，索引重建失效）；`extractFunctionPredicates` / `collectPredicates` 导出；4 项新单测。
- **adapter 契约扩展**：`VariableInfo.resolvedIndex`（具名索引 → 编号：`TALENT:恋慕` → 3；variable-schema 填充）。
- **真实回归**：save03 × 古明地觉（K49）全量回放 1,356 函数 / 11,685 谓词（命中 773 / 未命中 3,561 / 未知 7,351；exact 230 / partial 755 / unknown 371）。

### 6.4 第六批（✅ 已完成）：回放求值器扩展（数据流 + 内置函数 + 调用上下文）

**实施结果**：契约 + 抽取 + 求值三层落地（IMPLEMENTATION-LOG §5.12 为权威记录）。

- **契约**：`FunctionAssignment` + `FunctionPredicates.assignments` + `FunctionPredicate.context`（conditions.ts）；`ReplayCallContext` / `ReplayFunctionOptions` + 3 个新 unknown 码（`local-no-write` / `call-context` / `builtin`）（replay.ts）。
- **抽取**（condition-extractor）：`buildContextLookup`（段栈折叠：开块入栈 / 分支换段 / 闭合弹栈，kind 分类与 scanner 配对表同源）+ `collectAssignments`（直线赋值；`==` 不误匹配；`+=` 失效点；注释/@#$ /SKIP 块跳过）；仅 `functionPredicates` 明细路径收集。
- **求值**（state-replay）：`locals.ts` 叠加层（前缀可达 + last-write-wins + RHS 递归记忆化 + ARG/ARGS 注入）；`builtins.ts` 8 个纯函数；`evaluate.ts` call 分支先查内置表。
- **真实回归**：未知 7,351→5,668（62.9%→48.5%）；exact 230→786；全未知函数 371→70。
- **设计教训（先测量）**：批五"主因 = ARG"假设被实测推翻（ARG 仅 14%，LOCAL 族 60% 才是大头）——假设必须让位于测量。

### 6.5 第七批（✅ 已完成）：有界内联求值（口上域 `#FUNCTION` 纯助手顺序解释）

**实施结果**：契约 + 抽取 + 求值三层落地（IMPLEMENTATION-LOG §5.13 为权威记录）。

- **测量先行（§5.9 教训第四次应验）**：临时 dump 实测 call 被调函数形态——26 名 / 2,805 谓词中口上域内可解释仅 3 名 / 1,991 条（71%，`陷落状态`+`关系_310`+`陥落状態`）；23 名在索引域外（FIRSTTIME 等，本就不可内联）。可内联体 100% 为 IF/SIF/RETURNF + ARG 补位赋值。
- **契约**：`FunctionAssignment.name` 扩 `'ARG'|'ARGS'`；`FunctionPredicates` +`endLine`/+`returns: FunctionReturn[]`。
- **抽取**：`ASSIGN_RE` 扩 ARG/ARGS + `collectReturns`（RETURNF 收集）；明细路径产出（聚合零开销）。
- **求值**：`inline.ts`（analyze 预编译 + PC 顺序解释器：SIF 条件体 / IF 链 nextBranch/endAfter / pendingEval 双语义标记 / 环境读 + **索引段替换** / 深度界 8）+ `evaluate.ts`（`EvalContext{read, resolveCall}` 重构）+ `InlineManager`（缓存 + `preanalyze` BFS 预热）+ state-replay `requires` 增 `kernel.io`。
- **真实回归**：未知 5,668→3,741（**48.5%→32.0%**）；call 桶 2,297→**368**（消解 84%）；exact 786→836；全未知函数 70→38。
- **教训（§九-19）**：ELSEIF/ELSE op 的"跳转到达 vs 自然掉落"双语义——PC 无法区分来源，须编译期改写（假跳转绕过 ELSE op）+ 运行期标记（pendingEval）。首版集成测试抓出（ELSE 分支错误落到链尾兜底 RETURNF）。

### 6.6 第八批（✅ 已完成）：状态回放面板（`ui-state-replay`）

**实施结果**：呈现 + 纯逻辑 + 事件联动落地（IMPLEMENTATION-LOG §5.14 为权威记录）。

- **面板**：选档 → 选角色 → 选函数 → 逐条谓词三值结果 + 置信度徽章 + 未知原因分组（中文提示）；谓词行点击跳源码；视图（档 × 角色）惰性重建 + 代际保护。
- **调用上下文**：`0=36, 1="约会"` 文本解析（panel-logic.ts，+11 单测）；场景输入不猜测。
- **联动**：内核事件 `kojo.replayFunction`（events.ts + bus.ts）；导航面板 ⟲ 徽章发起；UI 插件零交叉依赖。
- **验证**：400 项全绿 / audit 10 插件 / 真实冒烟无回归 / app build ✅。
- **环境边界**：桌面壳深度冒烟在沙箱会话不可跑（tauri CLI 的 `BeforeDevCommand` 经 `cmd /S /C` 触发宿主管道耗尽 os error 231）——非项目问题，需在正常终端执行；app vite build 已验证。

### 6.7 第九批（✅ 已完成）：分支走向

**实施结果**：契约 + 引擎折叠 + 面板呈现落地（IMPLEMENTATION-LOG §5.15 为权威记录）。

- **契约**：`BranchChainOutcome`（if-chain/select-chain × taken/no-match/unknown/unreachable）+ `FunctionReplay.branches`。
- **引擎**（`branches.ts` 纯函数）：链栈配对折叠 + unknown 立即阻断（后续真不可救）+ 可达性传播（外层未进入 → unreachable）+ 宽容。
- **呈现**：面板"分支走向"区（缩进 + 四态标记 + 点击跳命中行）。
- **教训（§九-23）**：向文档追加 §5.x 小节时，Edit 的 old_string 含 `## 6. 目录结构` 标题而 new_string 漏回——连续两批误删同一段落标题（已靠 grep 章节结构验证兜住）。**追加式编辑必须读回验证标题层级**。

### 6.8 第十批（✅ 已完成）：口上调用协议

**实施结果**：契约 + adapter 路由表解析 + 面板结构化输入落地（IMPLEMENTATION-LOG §5.16 为权威记录）。

- **测量纠正过度承诺**：call-context 值是场景输入不可推导——协议价值 = 槽位语义标注 + 默认场景（全 0 = 引擎转发链事实），不是"858 条自动消解"。
- **契约**：`KojoCallSlot` / `KojoCallProtocol` / `GameAdapter.kojoCallProtocol?`。
- **adapter**：`call-protocol.ts` 解析路由表（尾部段类型消歧：数值时机 \d+ 优先）；+5 单测。
- **面板**：结构化场景参数区（协议）↔ 文本框（无协议降级）；回放引擎零改动。
- **教训（§九-15 的再次应验）**：候选清单也要先测量——"自动消解"在写清单时未核验路由源码。

### 6.9 第十一批（✅ 已完成）：存档写侧预研

**实施结果**：写侧 PoC + 金样本回归落地（IMPLEMENTATION-LOG §5.17 为权威记录）。

- **save00 载荷 571,185B 字节级完全一致**——编码器同构达成（行驱动游程 / 整数宽度 / 7-bit 前缀 / 流控制）。
- **Int64 精度硬前置暴露**：RANDDATA（SFMT 625 状态）等大数被读侧近似，写回必坏——serialize 显式抛拒绝；v1.1 注入器倾向方案 B（rawBytes 原样复制 + 被修变量含大数拒绝注入）。

### 6.10 第十二批（✅ 已完成）：审阅修复（依据 docs/CODE-REVIEW-2026-10-10.md）

**实施结果**：H1 + M2/M4/M5 + L1/L3/L4 落地（IMPLEMENTATION-LOG §5.18 为权威记录）。

- **H1（高，CASE TO AND 语义）**：契约 `conjunction?: 'and'`（FunctionPredicate + PredicateReplay 透传）→ extract.ts TO 半边打标 → branches.ts 同行"组内 AND（Kleene）/ 组间 OR"；向后兼容（无标记 = OR）。+7 单测；真实语料 3,136 处 TO 区间的分支走向不再"多命中"失真。
- **M4**：App 层 `requestOpenFile` 守卫 + `UnsavedConfirmDialog`（保存并前往/丢弃/取消）；EditorPane `onDirtyChange`/`registerSave`。
- **M5**：回放面板 `runReplayRef`（监听 effect 依赖清空，闭包永新）。
- **M2**：Rust `encode_string` had_errors 拒绝写（防 HTML 实体静默损坏）；`decode_bytes` had_errors 记 stderr 不阻塞浏览。
- **L1** storage JSON 容错 / **L3** POWER 超 2^53 先拒 / **L4** resolveModel 死代码清理（null 分支不可达）。L2 核实为误报（比较两侧已过 pathKey）；M1/M3 留 v0.3。

### 6.11 第十三批候选（已完成 2 项，余项顺延）

- **v1.0 收口**：✅ 回放面板场景预设（§6.15，第十五批）；✅ 协议覆盖校验规则（§5.27，签名槽与路由转发一致性）；**余项**：桌面壳真实终端冒烟（沙箱 os error 231 欠账）。
- **index-603 索引域外函数源（消解剩余 call 368）**：FIRSTTIME 等定义在 kojoPaths 之外——"游戏函数源"通道（扩 index 扫描域 / 按需 parseFile）；多数有副作用，收益需再测量。
- **adapter 口上调用协议**：家族 → 转发实参映射（KOJO_MESSAGE.ERB 路由表）→ call-context 858 条的自动消解；回放面板的场景选择器可从协议生成"对话对象/时机"下拉（替代手填槽位）。
- **回放面板角色上下文增强**：MASTER/ASSI/PLAYER 指针的场景选择（当前取快照顶层值）。
- **归档浏览器面板**（✅ 第十三批由 TRAE 交付，commit ca1a323）：消费 `snapshot.source` 列档（saveMes / 角色数 / 大小），点击看摘要。
- **存档注入器地基**（✅ 第十三批，见 §6.12）：Int64 精度方案 B 落地。

### 6.12 第十三批（✅ 已完成）：存档注入器地基（Int64 精度方案 B）+ 归档浏览器（TRAE）

**实施结果**：方案 B 全量落地（IMPLEMENTATION-LOG §5.19 为权威记录）。

- **契约**（plugin-api/snapshot.ts）：5 个变量接口 + `raw?: Uint8Array`；`keepRaw?` 解析选项；`ArchiveCellPatch` / `ArchiveOverrideValue` / `ArchiveOverrides`（vars + chars 两级 Map）——均从 index.ts 导出。
- **读侧**：parse.ts 读毕变量后 `span()` 记 subarray 视图（零拷贝，含 token+key+值域）。
- **写侧**（serialize.ts writeVar 三路）：① 无覆盖+raw → `w.bytes(raw)` passthrough（先于 token/key，Int64 近似值永不写回）；② 覆盖 → 标量替换（类型不符即抛）/ 数组 CellPatch 按下标合并（mergedCells：同下标替换、插入、排序；**Int64 守卫**——任一单元超安全域即抛）；③ 无 raw 走 legacy 重编码。
- **金样本关键纠正**：RANDDATA（SFMT u32 ×625）逐值均在安全域，第十一批"RANDDATA ≈2.8e16"是整体规模误读；真雷 = save01+ 顶层 `RESULT` 与角色块 `CFLAG`/`GIFT_GOT`/`TCVAR`。守卫测试动态扫描不安全单元，不硬编码变量名。
- **测试**：raw-inject.test.ts（+8 合成）+ golden-roundtrip 第二用例重写（六档 passthrough 差异 0 含 save01-05 + save00 注入 `ISASSI=123456789` 读回一致 + save01 守卫拒绝）。
- **TRAE 并行**：`ui-archive-browser` 插件（snapshot.source 消费，第 11 插件，注册四处齐全，audit 11 插件全绿）。
- 下一步（第十四批候选）：v1.1 注入器用户面（改槽注入 UI → 含修改金样本回归 → 写盘走 writablePaths+备份）；或 v1.0 收口（回放面板场景预设 / 桌面壳真实终端冒烟）。
- **ui-condition-matrix（条件矩阵）**：按角色/家族聚合状态依赖；MESSAGECHECK 位可视化。
- `watchDirs` 文件监视（现为手动刷新；后续走 Rust notify）→ 增量重建索引。
- Monaco bundle 4.3MB 拆分（manualChunks，低优先级）。
- scanner 的 TRY 系配对精度（`TRYCALLFORM` 无 CATCH 时产生幻影开块）——影响上下文路径精度，方向"宁少勿错"，低优先级。

### 6.13 第十四批（v1.0 收口线一，✅ 已完成）：回放面板信任闭环（C9 + A3）

**实施结果**：假设值标注 + 预览职责分层落地（IMPLEMENTATION-LOG §5.20 为权威记录）。

- **C9**：协议槽预填 0 从"确定值"降格为**假设值**——来源三态 `manual` / `assumption` / `unset` 纯逻辑；UI「假设」徽章 + 虚线边框、「基于假设」谓词标注、分支区「本结果含 N 个假设参数」汇总；**空值 = unknown 语义不变**。
- **附带修正**：槽位输入改以 `slotKey(kind,index)` 为键（修 `ARG:0` / `ARGS:0` 同号互相覆盖）。
- **A3**：面板内分「预览层（`renderReplayPreview`）」与「壳层（选档/选角/输入）」；ARCHITECTURE §5.4 补一行职责注记（糖预览复用 `preview.renderer`，不自建渲染）。
- **不变式**：回放引擎语义与 condition-extractor 契约零改动；真实基线不变（未知 3,741 / exact 836）。
- **验证**：470 项全绿（+14）/ typecheck root+app ✅ / 真实工程冒烟通过。**audit:decoupling 报红 = 并行线 C7 未提交的 `lib.rs:484` 裸 `sav` 词（非本批文件）**。
- 边界：仅 `packages/plugins/ui-state-replay/**` + 两份文档；未碰 `packages/app/src-tauri/**` 与 kernel io（C7 线）。

### 6.14 第十四批线二（✅ 已完成）：C7 Rust 侧写路径纵深防御（M3）

**实施结果**：Rust 写允许域第二道闸落地（IMPLEMENTATION-LOG §5.21 为权威记录）。

- **允许域语义**：允许 = 项目根目录整体（含游戏目录，与 kernel writablePaths 判定域一致）+ appDataDir（备份/配置，常驻）；其余一律拒绝并明确报错（不静默、fail-closed）。双闸并存——kernel io writablePaths（用户批准子集）语义不变，以更严者为准。
- **生命周期**：`register_write_domain`（project.opened 时 App.tsx 注册项目根）/ `clear_write_domain`（project.closed 回到仅 appDataDir）；注册失败 fail-closed + 显式 setError。均在 `isTauri()` 守卫内。
- **上闸命令六处**：write_file_bytes / ensure_dir / rename_path（from+to 双端）/ copy_file（仅 to）/ remove_file；读路径不受限。判定核心纯函数化（canonicalize_deep 解析 `..` 与符号链接 + is_within 组件级大小写折叠前缀比较），可脱离 Tauri 单测。
- **测试**：cargo test 9/9（域内放行 / 域外拒绝 / 未注册拒绝 / `..` 穿越两种 / 符号链接逃逸 / 组件级前缀不误判 / 深层不存在文件）；kernel io 契约与行为零改动（仅注释补双闸说明）。
- **验证**：470 项全绿 / typecheck root+app ✅ / audit 11 插件 ✅（§6.13 提到的 `lib.rs:484` 裸 sav 词已修——单测字符串 `v1.sav`→`v1.dat`）/ cargo check ✅ / 真实工程集成冒烟 ✅。桌面壳端到端手工冒烟（真实 IPC 下域外写被拒）沙箱不可跑，需正常终端 `pnpm tauri dev` 验证。
- 边界：仅 `packages/app/src-tauri/**` + `App.tsx`（注册/清除接线）+ kernel io.ts 注释 + docs。**M3 收口，v1.1 注入器的第二道闸前置条件达成**。

### 6.15 第十五批（v1.0 收口线一，✅ 已完成）：回放面板场景预设

**实施结果**：调用上下文从"每次手填"升级为**一等化的场景**——命名保存 / 下拉切换 / 一键应用 / 删除；纯逻辑在 `panel-logic.ts`（零 React，+15 单测）。

- **数据模型**：`ReplayScene{ id, name, slots: { slotKey(kind,index): { value, kind:'manual' } } }`；存储走 `ctx.storage`（域 = 插件 id `ui-state-replay`，键 `replay-scenes`），**不复用他人域**；内置默认场景为虚拟项不入存储。
- **一键应用**：默认场景 = 回全 0（int 假设 / str 未提供）；用户场景覆盖的槽标 **manual**（作者假设，非引擎事实——文案不写死"正确值"）；与 §5.20 的 assumption 徽章语义并存不冲突。
- **合并冲突显式上报**（不静默）：场景槽不在当前函数签名 → `dropped` 忽略；已填槽未被场景覆盖 → `reset` 回默认；同名保存 → 覆盖（保留原 id）。
- **协议降级**：协议可用 → 建议名由槽位 label 拼接（「对话对象=觉/时机=SP_EVENT」）；不可用 → 空串纯手填，场景改作用于裸上下文文本框（槽位↔文本双向转换，解析失败提示不抛错）。
- **不变式**：回放引擎（`state-replay`）与 `condition-extractor` 契约**零改动**；真实基线逐字复现（未知 3,741 / exact 836）。
- **验证**：485 项全绿（+15）/ typecheck root+app ✅ / `audit:decoupling` ✅（11 插件）/ 真实工程集成冒烟 ✅。
- 边界：仅 `packages/plugins/ui-state-replay/**` + docs。

### 6.16 第十六批（v1.1，✅ 已完成）：存档注入器用户面（写链路端到端）

**实施结果**：「改槽注入」从引擎能力做成用户可用的写链路（IMPLEMENTATION-LOG §5.23 为权威记录）。批次编号顺延：第十五批编号已被 §6.15 场景预设占用。

- **契约**：`plugin-api` 新增 `SnapshotWriteService { inject(path, overrides) }`（服务键 `snapshot.writer`）+ `SnapshotInjectionResult { path, backupPath, byteSize, verifiedCount }`；只读消费者不感知写权限。
- **sav-parser 0.3.0**：`container.ts`（16B 头 + gzip/raw 正文，Web 标准 CompressionStream）；`verify.ts`（回读验证：标量值 / CellPatch 全维度下标）；`engine.inject` 安全顺序 = Int64 守卫（先于备份）→ serialize → 组装 → 备份 → 写盘 → 回读 parse + verify，mismatch 抛错携带备份路径。
- **缺口修复**：eratw-adapter `writablePaths` 原缺 sav 目录 → 注入会被 kernel 第一道闸拒绝；已补提议（批准弹窗流程复用，内核/Rust 零改动）。
- **第 12 插件 `ui-snapshot-injector`**：`panel-logic.ts` 纯逻辑（+16 单测）+ 面板（档位下拉复用 archive-browser 列档数据流 / `kojo.snapshotSelected` 预填 / 作用域+变量过滤 / diff 清单 armed 两步确认 / 成功后重解析显示落盘新值）；登记四处 + bootstrap（order 71）。
- **回归**：kernel 集成第 9 节（appData 副本端到端注入 + 越权拒绝 + Int64 守卫）；golden-roundtrip 容器级注入用例（save00 动态标量 → gzip 组装 → 回读 verified）。
- **验证**：509 项全绿（+39）/ typecheck root+app ✅ / audit 12 插件 ✅ / 真实冒烟 ✅（副本 56744B 注入验证 + 备份已建；回放基线不变 3741/836）/ app vite build ✅。
- 边界：kernel/Rust 源码零改动（仅测试）；未碰 `ui-state-replay/**`。

---

### 6.17 第十七批（✅ 已完成）：桌面壳端到端冒烟（Rust 双闸真实 IPC 验证）

**实施结果**：还掉 C7/M3（§6.14）端到端欠账 + 固化自动化探针（IMPLEMENTATION-LOG §5.24 为权威记录）。

- **环境结论**：本机正常终端（PowerShell）`pnpm tauri dev` **可跑**——vite 1420 ✓ / cargo 增量编译 ~21s / 宿主 `kojo-editor.exe` ✓ / CDP 9222 ✓ / DOM 渲染 ✓；**沙箱 os error 231 未复现**（§八 已录）。
- **自动化探针 `tools/smoke-tauri-ipc.mjs`**：CDP 进 WebView 直调 `__TAURI_INTERNALS__.invoke`（与 app bridge 同一条**真实 IPC** 通道，非伪造），一条命令跑 a–e 全清单；自带 store（recent + approved-writable）/文件原字节/`.bak` 清场还原 + 端口预检。
- **手工清单 `tools/smoke-tauri-manual.md`**：a–f 可勾选 + 每项预期结果 + 本批实测结论表 + 安全不变量（后续每批人工过一遍）。
- **实测（全 PASS）**：a 开真实游戏目录（168 角色 / 2285 文件 / 99104 函数）；a2 首次「写权限确认」→「允许写入」；b 域内编辑保存 → 落盘含标记 + 备份目录新增 `.bak`；c 写 `C:\Windows\Temp` → 「写允许域拒绝」；d 关项目后写游戏目录 → 同拒；e appDataDir 写正常。**双闸语义实测成立**（项目根 + appDataDir 放行 / 域外 fail-closed / 关闭后回落仅 appDataDir）。
- 边界：仅 `tools/**` + `docs/**`，**零源码改动**（未动 Rust / TS；未碰 `packages/plugins/**` 与 kernel）。

---



### 6.18 第十八批（✅ 已完成）：审阅缺陷修复（BUG-REPORT-2026-10-10：M1 级联 / L5 / L6 / L7 脏判定）

**实施结果**：BUG-1~4 修复 + BUG-5 判定延后（IMPLEMENTATION-LOG §5.25 为权威记录）。

- **BUG-1（M1）方案 A**：runtime stop(id) 级联——dependentsClosure（requires×provides BFS，slot 消费关系不在图内已注明边界）+ 逆拓扑序逐个停用（最深依赖方先停），stopAll 行为兼容；retry docstring 陈旧说法一并更正。+3 测试。
- **BUG-2（L5）**：按引擎 funcMatch 原文精确配对——TRYC 六个→CATCH / TRY*LIST 三个→ENDFUNC（新配对类 funclist）/ PRINTDATA 九个；TRYCALL/TRYCALLFORM 等是单行语句不开块（比报告"影响为零"更进一步：修掉了幻影开块根因）。extract.ts 上下文栈同源镜像修。旧测试更正（原断言固化了误开块）。真实冒烟基线逐字不变（3741/836）。
- **BUG-3（L6）**：锚点语义（取最后一个 _K{no}）注释显式化 + 4 项边界单测，行为零改动。
- **BUG-4（L7）**：EditorPane 脏判定改 getAlternativeVersionId 版本号比较（O(1)）；取舍=撤销回原文显示脏（注释写明）。
- **BUG-5 延后**：file.changed payload 契约与 v1.1 注入器写链路一并设计（避免契约先行实现滞后），记入下一批清单。

**验证**：520 passed / 4 skipped 全绿（+16）/ typecheck root+app ✅ / audit 12 插件 ✅ / 真实工程集成冒烟 ✅。

## 七、安全模型（写文件功能相关必读）

- 写入仅允许 `writablePaths`（用户批准 + 持久化于 kernel 存储域 `_global`），越权抛 `WriteNotAllowedError`；
- **双闸并存**（v0.2 第十四批 M3）：kernel io 白名单（第一道闸）+ Rust 宿主写允许域（第二道闸：项目根整体 + appDataDir，project.opened 注册 / project.closed 清除），语义以更严者为准；
- 写回**保编码保换行**（首读探测缓存：utf-8-bom / utf-8 / shift_jis / utf-16；eol 多数派）；
- 原子写（临时文件+rename）+ 自动备份 `{appData}/backup/{hash}/`（保留 20 版）；
- UI 侧「只读浏览」永远可用（未批准 = 不可写，不阻塞浏览）。

## 八、环境坑速查（本机，2026-10 实测）

| 坑 | 对策 |
|---|---|
| 沙箱注入的 `HTTP(S)_PROXY=127.0.0.1:8587` 是**坏的**，git/curl 默认走它必失败 | **推送一律用 `node tools/git-push.mjs`**（内部清空全部代理环境变量直连+重试） |
| github 直连时通时断 | git-push.mjs 已内置 6 轮×5s 重试，失败就隔几分钟再试 |
| npm/pnpm registry=npmmirror **直连可用** | 别给镜像配代理（ECONNREFUSED）；项目 `.npmrc` 已固定 |
| pnpm 11 供应链策略拦构建脚本 | pnpm-workspace.yaml `allowBuilds` 显式批准（esbuild 已批） |
| bash coreutils 时常 127；`node -e` 多层引号/Markdown 反引号必翻车 | 一切用 node 临时 `.mjs` 文件或 Read/Write/Edit 工具；PowerShell 工具 stdout 不回显 |
| **bash 严重残缺时 pnpm/vitest/tsc shim 全挂**（`sed`/`dirname`/`uname` 缺失） | 直调 node：`node "D:/Code/Nodejs/node_global/node_modules/pnpm/bin/pnpm.mjs" install`；vitest → `node "node_modules/.pnpm/vitest@4.1.11_@types+node@2_1db5548ac037c87131628c83c4241b81/node_modules/vitest/vitest.mjs" run`；tsc → `node "node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/lib/tsc.js" --noEmit -p tsconfig.json` |
| **Edit 工具偶发"声称成功未落盘"，且同文件并行 Edit 会 EBUSY** | 关键修改后读回验证；**同一文件的多次 Edit 必须串行** |
| 模板字符串里写 Markdown 反引号（如 \`====\`）会截断 TS 模板串 | 用「」代替反引号 |
| cargo 输出带 ANSI 色码 | 正则匹配前先 stripAnsi（tools/smoke-*.mjs 有现成函数） |
| crates.io 直连慢 | cargo 首次 build 已完成，之后增量秒级 |
| **沙箱 `os error 231` 未复现**：本会话 Trae 终端（PowerShell）直接 `node tools/smoke-tauri-dom.mjs` / `pnpm tauri dev` → vite 1420 ✓ / cargo 增量 ~21s / 宿主 ✓ / CDP 9222 ✓ / DOM ✓ | 桌面壳可在正常终端跑；真实 IPC 冒烟走 `node tools/smoke-tauri-ipc.mjs`（Rust 双闸 a–e，自动还原 store/文件/备份） |
| tauri dev 首轮冷启动 vite `Re-optimizing dependencies` 会 HMR 重载页面（项目打开后回欢迎页） | 首次 dev 的已知抖动，二次稳定；`smoke-tauri-ipc.mjs` 已加端口预检 + 180s 等待缓解 |
| **同工作区并行线 WIP 会让集成冒烟断言误红**（如 adapter 新增规则使 `ruleCount` 5→6） | 先 `node tools/audit-decoupling.mjs` 粗判；再 `git stash push -- <并行线文件>` 复跑确认本批无回归，`git stash pop` 还原；**只提交自己边界内的文件**，并在 IMPLEMENTATION-LOG 记待办 |

## 九、本会话踩坑记录（给未来的自己）

1. **规则必须先核验引擎源码再定语义**：FORM 三连符号初版按"字面出现即报"实现 → 239 条里大量是 `+++`（MASTER 名）的有意用法（43 个文件）。收窄为排除 `+++` + 每文件每符号聚合 → 8 条真实事故。见 IMPLEMENTATION-LOG §5.8"规则误报治理原则"。
2. **`ctx.onDispose` 是插件订阅/清理的必经之路**：事件订阅不 `onDispose` 会导致插件停用后残留 handler（内核 deactivate 逆序执行 disposer）。erb-parser / convention-linter 均照此。
3. 新增插件包需四处登记：`packages/plugins/*/package.json`、root `tsconfig.json` paths、`vitest.config.ts` aliases、`app/vite.config.ts` aliases + `app/package.json` deps（kernel devDeps 亦然）。漏一处就 resolve 失败。
4. **真实语料是解析器的验收标准（第三批）**：初版表达式解析器 dump 真实 opaque 样本（528k 条件行中 2.17%）→ 发现两大系统性缺口：`[[词]]`（引擎 rename 语法，读取期按 `_Rename.csv` 替换）与**括号索引段**（`YOGORE:(GET_CHARAHOME(TARGET))`、`TALENT:(NO:30):恋慕`）。补齐后引擎侧未解析 3,383 → **187**（0.04%）。教训：**先 dump 真实失败样本，再定语法扩展**——不要凭直觉猜"什么写法常见"。
5. **具名索引的 schema 反向查询语义**（variable-schema 单测抓出）：`lookup('TALENT','恋慕')` 时 description 应取**名称本身**；初版直接把名称→编号反向表的**编号**当描述返回（`description:'3'`）。数字索引查名、具名索引自描述——两个方向别混。
6. **CASE 文本不能整体 parse**：`CASE 1, 2, 3` / `CASE 10 TO 20` 是 SELECTCASE 语法而非表达式——必须在抽取层展开为 `subject == 值` 再逐条 parse（dump 统计时若对 CASE 原文整体 parse 会误报 opaque）。
7. **双 lib 类型环境（node vs DOM）对 Web API 的严格度不同**（第四批）：`new Blob([bytes])` 在 root tsconfig（@types/node）通过、在 app tsconfig（DOM lib）报 `Uint8Array<ArrayBufferLike>` 不满足 `BlobPart`（SharedArrayBuffer 不兼容性）。修法：`new Uint8Array(bytes)` 复制到独立 ArrayBuffer 支撑数组，两套定义下均兼容。**tsc 必须 root + app 双跑**。
8. **vite build 的 `prepare-out-dir` 偶发 EPERM**（第四批）：清空 `packages/app/dist/assets` 时报 Permission denied（文件瞬时占用），手动 `fs.rmSync(dist, {recursive, force})` 后重试即过——不是代码问题。
9. **批次编号勘误**（第四批会话）：`conditions.ts` 头注释与 IMPLEMENTATION-LOG §5.9 曾写"条件抽取=第四批"，与 HANDOFF 口径（第三批）不一致；已统一为——**第三批=条件抽取、第四批=sav-parser**（判据：函数树=第二批在工作日志与 HANDOFF 双证）。
10. **TS7 对"联合字面量属性"的判别式 narrow 不可靠**（第五批）：`ArchiveScalarVariable.type` 是 `'int' | 'str'`（联合属性），`if (v.type === 'int' || v.type === 'str') return ...` 之后 TS 仍不把该变体从后续代码排除（报"Property 'saveLen' does not exist on ArchiveScalarVariable"）。修法：**显式类型守卫**（`isArrayVar(v): v is ArchiveArrayVariable`）替代判别式 narrow。
11. **变量寻址语义必须回引擎源码逐行核验**（第五批，§九-1 的再次应验）：`CFLAG:2` ≡ `CFLAG[TARGET,2]`、裸 `CFLAG` ≡ `CFLAG[TARGET,0]`（角色 1D）、裸 `DAY` ≡ `DAY:0`（全局 1D）——全部来自 `VariableParser.ReduceVariable`（:102-133 角色分支 / :153-170 全局分支），不是直觉推断。求值器的每个寻址分支都注了源码行号。
12. **JS 数字语义与 C# 的两处硬差异**（第五批）：①整数除法是**截断**（`-7/2 = -3`，Math.trunc，非 floor）；②位运算符（`& | ^ << >>`）在 JS 是 **32 位**——`1 << 40` 会得到 256 而非 2^40，必须经 BigInt 中转（`Number(BigInt(a) << BigInt(b))`，并先 `Number.isInteger` 检查）。
13. **同文件并行 Edit 必 EBUSY；且 Edit 偶发"声称成功未落盘"**（第五批复现，§八同款）：一次消息里对同一文件发多个 Edit 工具调用 → 第二个报 `EBUSY: resource busy or locked`；另有一次 Edit 报告成功但 `isArrayVar` 定义实际未写入（grep 复核时发现）。**同文件多次 Edit 必须逐条串行 + 关键修改后读回验证**。
14. **vitest 4 没有 `--reporter=basic`**（第五批）：传了会直接 Startup Error（"Failed to load custom Reporter from basic"）；用默认 reporter 即可（console.log 默认可见）。
15. **先测量再定语义（§九-1 / §5.9 教训第三次应验）**（第六批）：批五断言"未知主因 = `ARG:*`"，第六批实测构成：pseudo 4,439（LOCAL 系为主）/ call 2,485 / ARG 系仅 ≈14%。方法 = **临时 dump 测试（跑完即删）拿真实构成**再排优先级——本批因此把"本地量数据流"提为最大杠杆、调用上下文降为注入基建。
16. **块注释里写 `TRY*/PRINTDATA*` 会提前终止注释**（第六批，TS1127）：`*/` 序列在 `/** ... */` 内就是注释结束符；措辞改成"TRY 系、PRINTDATA 系"。
17. **引擎参数槽语义（第六批核验，勿凭直觉）**：签名第 i 个**声明槽**按顺序赋值——`(ARG, ARG:1)` 即声明 ARG:0 与 ARG:1 两槽（`getEl1forArg` = 下标，ErbLoader.cs:694-741）；声明槽被调用时**必有值**（实参或默认 0/''，ConvertArg Process.CalledFunction.cs:162-239）；未声明却引用 `ARG:n` → 引擎警告 + 默认尺寸 token（fresh-load 读 0，调用间持久）；`CALL FOO`（无括号）= 全部声明槽取默认值。LOCAL/ARG 调用间持久、读档重置（SetDefaultLocalValue 仅在 load/reset 时清）——回放取"直线执行"近似。
18. **模块循环依赖规避**：evaluate.ts 的 call 分支要调 builtins.ts、builtins 又要递归求值 → builtins 接收 `evalExpr: ExprEvaluator` 作为参数（依赖单向：evaluate → builtins），不搞双向 import。
19. **解释器的"到达方式"双语义是隐坑**（第七批）：IF 链的 ELSEIF/ELSE op 有两种到达路径——**条件假跳转**（需进入：ELSEIF 求值 / ELSE 进体）与**分支体自然掉落**（需跳过：跳 endAfter）。PC 落点相同、无法区分来源 → 首版集成测试抓出 ELSE 分支错误落到链尾兜底 RETURNF（THEN 体掉到 ELSE op 被当"前分支完成"跳过；IF 假跳到 ELSE op 也被同样跳过）。修法两层：①编译期——假跳转目标为 ELSE 时**绕过 else op 直接进体**（`elseIdx+1`）；②运行期——`pendingEval` 标记"跳转到达 ELSEIF（求值，用后即清）"，自然掉落（false）→ 跳 endAfter。IF op 无歧义（链顶只可能顺序到达）。
20. **preanalyze 别忘了函数自身**（第七批）：内联缓存的预热若只收集"谓词 AST 里的被调名"，顶层函数自身（体里不调用别人的）永远不会入缓存 → resolveCall 全 miss。`preanalyze` 第一步必须 `ensureAnalyzed(自身名)`。
21. **resolveCall 同步契约 vs analyze 异步现实的矛盾**：求值热路径是同步的（Kleene 求值器纯函数），但函数体文本读取是异步 → **两阶段设计**：`replayFunction` 先 await `preanalyze(detail)`（BFS 递归 analyze 全部可达被调），执行期 resolveCall 同步查缓存必命中（miss = 竞态 → log warn 回落 unknown，不挂起）。
22. **Bash 工具的 cwd 不如想象中可靠**（本会话实测）：`cd X && cmd` 的 cd 前缀偶发被吞、后台任务起始目录回到会话根 → **一律用 `pnpm -C <绝对路径>` / node 绝对路径脚本**，不依赖工作目录持久化。
23. **文档追加式编辑的"标题吞噬"**（第七、九、十批连续三次）：向 ARCHITECTURE 追加 §5.x 小节时，Edit 的 old_string 以 `## 6. 目录结构` 标题为锚、new_string 漏回该标题 → §6 标题被静默删除（前两次靠 grep 兜住，第三次依旧发生——**人工 Edit 不可靠，已改用 node 行号插入**）。根治措施：①追加小节用 node 脚本按行号 splice；②每次文档编辑后必须 `grep -n "^## \|^### "` 读回验证标题层级。

## 十、新会话动手清单

1. `cd D:\DSH\kojo-editor && pnpm install`（bash 残缺时用 §八 的直调 node 方式）
2. `pnpm test && pnpm typecheck && pnpm audit:decoupling` —— **确认三项全绿**（基线：520 项 / ✅ / 12 插件）
3. 读 `docs/IMPLEMENTATION-LOG.md`（§5.8–§5.25 全量批次记录）+ `docs/ARCHITECTURE.md` §1–§7 + 本文件 §六
4. **下一批候选**：v1.0 收口余项（桌面壳真实终端冒烟：沙箱 os error 231 欠账；**协议覆盖校验规则 ✅ 已完成**，见 IMPLEMENTATION-LOG §5.27）；v1.1 余项（注入器桌面壳真实终端深度冒烟：确认弹窗 → writablePaths 批准 → 注入真实体验）；**BUG-5 file.changed 事件链**（payload 契约与注入器写链路一并设计，见 §6.18）；**v0.3 语法糖**（表层语法权威 = `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` v1.2 冻结版；路线 S1–S6 见 `docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §8.2，**S1 的测量项已由规范 §1.1 完成**，**S1 契约 + golden 固化 ✅ 已完成**（IMPLEMENTATION-LOG §5.26），下一批 = **S2 转译内核**（`kojo-sugar` 插件：行式词法→AST→codegen，golden §6.1/§6.2 逐字节转正））
5. 每完成一批：`pnpm test` 全绿 → Conventional Commits 提交 → `node tools/git-push.mjs`
