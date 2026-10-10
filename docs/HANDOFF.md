# 交接文档（v0.1 ✅ / v0.2 第一批 ✅ / 第二批 ✅ / 第三批 ✅ / 第四批 ✅ / 第五批 ✅ / 第六批 ✅）

> 更新：2026-10-10。**新会话从这里开始读，读完即可开工。**
> v0.1 全量（含桌面壳端到端）+ v0.2 第一批（约定校验器 + 索引响应式化）；
> 第二批：函数树导航（`ui-kojo-navigator`）；
> 第三批：条件谓词抽取（`condition-extractor`）+ 导航条件徽章 + adapter 变量字典；
> 第四批：存档快照源（`sav-parser`，服务 `snapshot.source`）；
> 第五批：状态回放引擎（`state-replay`，服务 `state.replay`）；
> 本会话完成 **v0.2 第六批：回放求值器扩展——本地量数据流 + 引擎内置纯函数 + 调用上下文注入（实测未知率 62.9% → 48.5%）**。

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
  1. **契约 `plugin-api/snapshot.ts`**：`SnapshotArchive`（元数据 + 角色区 + 变量区 + EM 扩展区）/ 变量模型（标量 / 稀疏数组 / Map / Xml / DataTable）/ 扫描结果 / `SnapshotSourceService`（scan / current / parse / subscribe）。**服务键命名决策 `snapshot.source`**（非 `sav.parser`）：审计 A 项禁裸 `sav` 词（契约层零游戏/格式名词），且"快照来源"语义本就是三来源（sav/CliDebug/手工）的统称——架构 §5.10 有记录。
  2. **新插件 `sav-parser`**（第 8 个插件）：字节原语（7-bit **字节数**前缀字符串 / 整数编码）+ 六种数组游程解码 + 顶层 / 角色块 / 变量流 / EM 区解析 + gzip（`DecompressionStream`，跨 Node/WebView，不 import node:zlib）。**纯读先行**（写 / 注入随 v1.1）。
  3. **响应式**：订阅 `project.opened` 扫 `project.savDir`（`headerOnly` 浅解析列档，6 档 27ms）；`project.closed` 清空；代际保护；无 `savDir` → 空结果（显式）。
  4. **测试**：58 项单测（合成字节 round-trip 全类型 + 错误路径 + 编排）+ 集成冒烟六档断言 + 与逆向 CJS 解析器逐字段交叉对拍（一次性，16,000 变量/档全等）。
- **v0.2 第五批完成**（本会话）：**状态回放引擎（`state-replay` 插件，服务 `state.replay`）**——v1.0 快照回放的**求值侧**地基。
  1. **契约 `plugin-api/replay.ts`**：`ReplayStateView`（状态视图）/ `ReplayValue`·`ReplayOutcome`（三值）/ `ReplayUnknown`（原因分类 16 种）/ `FunctionReplay`（置信度三档）/ `StateReplayService`。
  2. **新插件 `state-replay`**（第 9 个插件）：Emuera 变量寻址语义（TARGET 补位 `X:i`≡`X[TARGET,i]`、全局 `X`≡`X:0`、MASTER/ASSI 顶层指针、#DIM 数据驱动）+ **三值求值器**（Kleene：`false && unknown = false`）+ 编排（createView / replayFunction / replayFunctions）。
  3. **condition-extractor 扩展**：`functionPredicates()` 按需谓词明细（读文件 → `scanControlFlow` → 逐条 AST；**不入全量索引**，文件文本 + 明细双缓存，索引重建自动失效）；契约新增 `FunctionPredicate`/`FunctionPredicates`。
  4. **adapter 契约扩展**：`VariableInfo.resolvedIndex`（具名索引 → 编号：`TALENT:恋慕` → 3，引擎关键字字典语义）。
  5. **测试**：62 项 state-replay 单测（连 Kleene/寻址全类别/错误路径/编排）+ 4 项明细 API 测试 + 集成冒烟回放断言。
- **v0.2 第六批完成**（本会话）：**回放求值器扩展——本地量数据流 + 引擎内置纯函数 + 调用上下文注入**（ARCHITECTURE §5.12 为权威记录）。
  1. **先测量再动手**：实测推翻批五"未知主因 = `ARG:*`"假设——真实构成 pseudo 4,439（**LOCAL 系为主**）/ call 2,485 / ARG 系仅 ≈1,005（14%）。口上作者大量使用"直线赋值的局部开关"（`LOCAL = 1` / `LOCAL:1 = 1`，K49 语料 97% RHS 为纯数字常量）。
  2. **本地量数据流**：`collectAssignments`（condition-extractor，仅明细路径，聚合零开销）收集 `LOCAL/LOCALS/RESULT/RESULTS` 直线赋值；`buildContextLookup` 段栈折叠出**分支上下文路径**；求值侧 `locals.ts` 叠加层按"**前缀可达 + last-write-wins**"解析（兄弟分支互不可达、闭合块外不吃块内赋值、RHS 递归 + 记忆化、`+=` 记为失效点）。引擎依据 = ConvertArg/IntoFunction（Process.CalledFunction.cs:162-239 + Process.State.cs:495-515）。
  3. **内置纯函数**（`builtins.ts`，Creator.Method.cs 逐条对齐）：GETBIT / GROUPMATCH / MAX / MIN / ABS / SIGN / LIMIT / POWER；错误路径 → unknown('builtin') 不抛错。明确不收录：数组区间族 / GETNUM（等 adapter schema 通道）/ 字符串形态族 / RAND。
  4. **调用上下文**：`ReplayCallContext{ints,strs}`（裸 ARG ≡ ARG:0，引擎 1D 裸引用语义）注入 `replayFunction(view, name, {callContext})`；未提供/未覆盖 → unknown('call-context')，**不猜测 0**（转发自路由层的值是场景输入）。adapter 口上调用协议（路由表 → 转发实参映射）留作 UI 场景选择器地基（默认流收益实测 ≈ 0）。
  5. **测试**：+29 单测（assignments 识别与上下文 / locals 叠加 / builtins 语义）；集成冒烟新增数据流与调用上下文断言 + 未知率守门（<55%）+ 未知分类打印。
- **存档解析基线（2026-10-10 实测）**：六档全绿——168 角色/档、16,005 变量/档（save00 16,000）、`#DIM` 恒 65、MASTERNAME 7/168、RANDDATA saveLen 625（**save00 nonEmpty=0 全零剪枝实证** / save01+ 全量）、MONEY 51 亿（Int64 路径）、EM 区 2 张 DT 表、**残余 0B**。
- **状态回放基线（2026-10-10 实测，第六批后）**：save03 × 古明地觉（K49）全量回放 **1,356 个含谓词函数 / 11,685 谓词**——命中 1,522 / 未命中 4,495 / 未知 **5,668（62.9%→48.5%）**；置信度 exact **786** / partial 500 / unknown **70**（批五：230/755/371）。第六批后未知构成：call 2,297（游戏助手函数为主）/ pseudo 1,886（RAND 等）/ call-context 858 / named-index 335 / local-no-write 196 / missing-var 80 / 其余 <100。
- **真实工程基线（2026-10-10 实测）**：168 角色 / 2,285 ERB / 99,104 函数 / 去重名 99,101；家族识别 98.91%（109 家族）；索引 ~2.9s；约定校验 757 项（~9s）。
- **条件抽取基线**：95,504 函数 / **493,712 谓词（未解析 187 = 0.04%）** / 含依赖函数 31,609 / 依赖条目 164,910 / schema 标注 109,742（恋慕 17,993 / 好感度 480）/ 全量 ~6.2s（冷启动 ~13s）。
- 测试：**362 项全绿**（无游戏目录时集成冒烟 1 项自动跳过）；typecheck（root + app）通过；解耦审计 ✅（**9 插件**）。

## 三、文档索引（按权威性排序）

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **架构权威**：铁律、内核边界、GameProject 形状（§5）、**§5.8 v0.2 实施记录（校验器分层 + 规则误报治理）** |
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
│   ├── conditions.ts          # 条件谓词契约（ConditionExpr AST / StateDependency / ConditionIndex / 服务 + ★FunctionPredicate(s) 明细）
│   ├── snapshot.ts            # 存档快照源契约（ArchiveMeta/SnapshotArchive/变量模型/扫描/服务）
│   ├── replay.ts              # ★ 状态回放契约（ReplayStateView / ReplayValue·ReplayOutcome / ReplayUnknown / FunctionReplay / StateReplayService）
│   ├── services.ts            # +WellKnownServices.ConditionExtractor / SnapshotSource='snapshot.source' / ★StateReplay='state.replay'
│   ├── events.ts              # +KernelEventMap['editor.revealLocation']
│   ├── erb.ts                 # ErbParserService +currentIndex()/ensureIndex()/scanControlFlow()；+ControlFlowStatement
│   └── game.ts                # VariableSchema/VariableInfo（★+resolvedIndex：具名索引→编号）
├── kernel/src/bus.ts          # +KERNEL_EVENT_NAMES: 'editor.revealLocation'
├── plugins/
│   ├── erb-parser/src/
│   │   ├── scanner.ts         # +scanControlFlow（控制流骨架：配对/深度/条件原文/宽容）
│   │   └── plugin.ts          # 服务暴露 scanControlFlow
│   ├── eratw-adapter/src/
│   │   ├── variable-schema.ts # 变量字典（CSV 驱动；33 张名称表；编号↔名称双向 + ★resolvedIndex 填充）
│   │   ├── conventions.ts     # eraTW 4 条规则（KX/四件套/FORM/MESSAGECHECK）
│   │   └── constants.ts       # +csvDir
│   ├── convention-linter/src/ # 引擎（engine.ts + rules/duplicate-function.ts）
│   ├── condition-extractor/src/ # 条件抽取（expr/extract/engine/index；★functionPredicates 明细 API + 双缓存 + ★assignments 本地量赋值收集 + 分支上下文）
│   ├── sav-parser/src/        # 存档快照源（v0.2 第四批）
│   │   ├── binary.ts          #   ByteReader：7-bit 字节数前缀 / 整数编码 / 越界即抛
│   │   ├── arrays.ts          #   六种数组游程解码（0xF0/F1/F2/E0/E1/D8；cells 省略/截断）
│   │   ├── parse.ts           #   文件级解析（魔数/版本/顶层/角色块/变量流/EM 区）
│   │   ├── gunzip.ts          #   DecompressionStream gzip（Web 标准，不 import node:zlib）
│   │   ├── engine.ts          #   扫描编排（浅解析列档 / 并发 4 / 代际保护 / 订阅）
│   │   └── index.ts           #   装配（requires: kernel.io/kernel.project）
│   ├── state-replay/src/      # ★ v0.2 第五~六批：状态回放引擎
│   │   ├── var-model.ts       #   引擎级变量清单（角色 22+4+CSTR+CDFLAG / 全局 / 伪变量 / 局部量）
│   │   ├── state-view.ts      #   归约（按 NO 定位角色块 / TARGET 补位 / 稀疏取值 / 越界与截断显式）
│   │   ├── evaluate.ts        #   三值求值器（Kleene / 整数除法截断 / BigInt 位运算 / 字符串 == / ★call→内置表）
│   │   ├── builtins.ts        #   ★ v0.2 第六批：内置纯函数（GETBIT/GROUPMATCH/MAX/MIN/ABS/SIGN/LIMIT/POWER）
│   │   ├── locals.ts          #   ★ v0.2 第六批：函数级叠加层（本地量数据流前缀可达 + 调用上下文注入）
│   │   ├── engine.ts          #   编排（createView / replayFunction(s) / replayPredicates 纯函数）
│   │   └── index.ts           #   装配（requires: kernel.project/kernel.slots/snapshot.source/condition.extractor）
│   ├── ui-convention-report/src/index.ts # ui.panel 面板（订阅 linter；点击 → revealLocation）
│   ├── ui-kojo-navigator/src/          # 函数树导航（tree.ts 纯逻辑 + index.ts 面板 + 条件徽章）
│   └── ui-plugin-status/src/           # 插件状态面板
└── app/src/
    ├── bootstrap.ts           # 注册 9 个插件
    ├── ui/App.tsx             # 订阅 kojo.functionChanged / editor.revealLocation
    ├── ui/ProjectView.tsx     # 透传 reveal
    ├── ui/EditorPane.tsx      # revealLine/revealNonce → Monaco revealLineInCenter
    └── styles.css             # 约定面板样式 +导航面板样式（nav-*）
```

## 五、验证矩阵（怎么跑）

```bash
cd D:\DSH\kojo-editor
pnpm install
pnpm test               # 333 项（无游戏目录时集成冒烟自动跳过）
pnpm typecheck          # root + app（app: pnpm --filter @kojo/app typecheck）
pnpm audit:decoupling   # 必须 ✅（plugins 数 9）
# 真实工程集成冒烟（168 角色/2285 文件/99k 函数/家族覆盖率/导航地基/校验报告/条件抽取/存档六档/状态回放断言）：
KOJO_SMOKE_PROJECT="D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)" pnpm vitest run packages/kernel/tests/integration-plugins.test.ts
# 桌面壳（会弹窗 ~100s 自动关闭）：
node tools/smoke-tauri-dom.mjs
```

**架构铁律（改动前默念）**：
1. 内核/契约/Rust 宿主**零游戏名词**（审计 A 项，只查代码行；行尾 `// audit-allow: <理由>` 可豁免；**注意裸 `sav` 词也在黑名单**——`savDir`/`SavArchive` 这类带后缀的复合词不匹配、裸 `'sav'` 会挂）；
2. 插件**只许依赖 `@kojo/plugin-api`**，禁 import kernel、禁插件间交叉 import（审计 B/C 项；**测试文件豁免 C 项**）；
3. 游戏知识只能进 eratw-adapter；跨游戏共享术语（kojo/chara）放 plugin-api；
4. 内核不静默：inactive 必须可见、冲突必须 error、**校验规则抛错必须进 `report.failedRules`**；
5. 游戏目录整体只读，写入仅限用户批准的 `writablePaths`（白名单在内核 io 强制）。

## 六、v0.2 批次记录（第三批～第六批，✅ 全部完成）

### 6.1 第三批：条件谓词抽取 `condition-extractor`

**实施结果**：三层落地全部完成——结构（`scanControlFlow`）/ 谓词（`condition-extractor` 插件）/ 语义（adapter `variableSchema` CSV 驱动）。

#### 交付清单
- **`scanControlFlow`**（erb-parser `scanner.ts` + 服务）：线性控制流骨架（kind/表达式原文/块深度/行号）；配对表以引擎 `FunctionIdentifier.cs funcMatch` 为准；孤儿闭合宽容；11 项单测。
- **`condition-extractor` 插件**（服务 `condition.extractor`）：`expr.ts`（表达式 tokenizer + Pratt 解析：全运算符 + `[[词]]` + 括号索引段 + opaque 降级）/ `extract.ts`（CASE 展开、依赖聚合、语言局部量排除、schema 标注）/ `engine.ts`（全量编排：并发 8、两指针切片、代际保护）/ `index.ts`（装配）。32 项单测。
- **契约**：`plugin-api/conditions.ts`（`ConditionExpr`/`VariableRef`/`StateDependency`/`FunctionConditions`/`ConditionIndex`/服务）；`plugin-api/erb.ts` +`ControlFlowStatement`。
- **adapter `variableSchema`**：`variable-schema.ts`（扫描 `CSV/*.csv` 名称表 33 张；编号↔名称双向 lookup）；`constants.csvDir`。7 项单测。
- **导航条件徽章**：`ui-kojo-navigator` 函数行显示 schema 标签（恋慕/好感度…）+ `+n` 折叠；悬停看阈值；`.nav-badge.cond` 样式。

#### 关键设计（详见 ARCHITECTURE §5.9）
- 谓词**聚合**存储（函数级 `StateDependency`），不存全量谓词对象——49 万谓词的量级必须聚合控制内存。
- `opaque` 降级**绝不抛错**；未解析计数显式呈现（不静默）；未解析率 0.04%。
- 局部量排除名单（LOCAL/ARG/RESULT/COUNT 系）是**通用语言知识**（Emuera 内置），不违"零游戏知识"。
- schema 标注按 `project.adapterId` 精确匹配（复用 ADR-0002 槽位查询通道）。

#### 真实数据口径（排障用）
- KX 占位符 603 条出自"函数名去重计"；条件抽取 95,504 函数中 31,609 含状态依赖（66.9% 函数无状态条件 = 大量纯文本/工具函数）。
- `CFLAG:2`（好感度）条件依赖合计 480 函数——比想象少（作者更常用 `TALENT:恋慕` 门禁，17,993 函数）；矩阵设计时以 TALENT 维度为主。

### 6.2 第四批（✅ 已完成）：存档快照源（`sav-parser` 先行）

**实施结果**：契约 + 插件 + 测试 + 集成全量落地（架构 §5.10 为权威记录）。

- **契约**：`plugin-api/snapshot.ts`（`SnapshotArchive` / 变量模型 / `SnapshotSourceService`）；服务键 **`snapshot.source`**（非 `sav.parser`，理由见架构 §5.10）。
- **插件** `sav-parser`：`binary.ts`（7-bit 字节数前缀 / 整数编码）+ `arrays.ts`（六种数组游程解码）+ `parse.ts`（文件级全流程）+ `gunzip.ts`（`DecompressionStream`）+ `engine.ts`（扫描编排）+ `index.ts`（装配）。58 项单测（合成字节）。
- **真实回归**：与逆向 CJS 解析器逐字段对拍（六档全等，16,000 变量/档）；集成冒烟六档断言（零残余 / #DIM 65 / MASTERNAME 7 / RANDDATA 剪枝实证 / MONEY 51 亿 / EM 2 表）。
- **写侧（v1.1）未动**：金样本"原样写回逐字节对比"与注入 UI 是后续阶段。

### 6.3 第五批（✅ 已完成）：状态回放引擎（`state-replay`）

**实施结果**：契约 + 插件 + condition-extractor 明细扩展 + 测试 + 集成全量落地（架构 §5.11 为权威记录）。

- **契约 `plugin-api/replay.ts`**：`ReplayStateView` / `ReplayValue`·`ReplayOutcome`（三值）/ `ReplayUnknown`（16 种原因分类）/ `FunctionReplay`（置信度三档）/ `StateReplayService`。服务键 **`state.replay`**。
- **插件 `state-replay`（第 9 个）**：`var-model.ts`（引擎级变量清单）/ `state-view.ts`（归约：按 NO 定位角色块、TARGET 补位、稀疏取值、越界与截断显式）/ `evaluate.ts`（三值求值：Kleene / 整数除法截断 / BigInt 位运算 / 字符串 `==`）/ `engine.ts`（编排）/ `index.ts`（装配）。62 项单测。
- **condition-extractor 扩展**：`functionPredicates(name)` 按需明细（读文件 → `scanControlFlow` → 逐条 AST；不入全量索引；文件文本 + 明细双缓存，索引重建失效）；`extractFunctionPredicates` / `collectPredicates` 导出；4 项新单测。
- **adapter 契约扩展**：`VariableInfo.resolvedIndex`（具名索引 → 编号：`TALENT:恋慕` → 3；variable-schema 填充）。
- **真实回归**：save03 × 古明地觉（K49）全量回放 1,356 函数 / 11,685 谓词（命中 773 / 未命中 3,561 / 未知 7,351；exact 230 / partial 755 / unknown 371）。

### 6.4 第六批（✅ 已完成）：回放求值器扩展（数据流 + 内置函数 + 调用上下文）

**实施结果**：契约 + 抽取 + 求值三层落地（ARCHITECTURE §5.12 为权威记录）。

- **契约**：`FunctionAssignment` + `FunctionPredicates.assignments` + `FunctionPredicate.context`（conditions.ts）；`ReplayCallContext` / `ReplayFunctionOptions` + 3 个新 unknown 码（`local-no-write` / `call-context` / `builtin`）（replay.ts）。
- **抽取**（condition-extractor）：`buildContextLookup`（段栈折叠：开块入栈 / 分支换段 / 闭合弹栈，kind 分类与 scanner 配对表同源）+ `collectAssignments`（直线赋值；`==` 不误匹配；`+=` 失效点；注释/@#$ /SKIP 块跳过）；仅 `functionPredicates` 明细路径收集。
- **求值**（state-replay）：`locals.ts` 叠加层（前缀可达 + last-write-wins + RHS 递归记忆化 + ARG/ARGS 注入）；`builtins.ts` 8 个纯函数；`evaluate.ts` call 分支先查内置表。
- **真实回归**：未知 7,351→5,668（62.9%→48.5%）；exact 230→786；全未知函数 371→70。
- **设计教训（先测量）**：批五"主因 = ARG"假设被实测推翻（ARG 仅 14%，LOCAL 族 60% 才是大头）——假设必须让位于测量。

### 6.5 第七批候选（下一批）

- **纯函数内联求值（第一优先）**：`call` 桶的最大头是游戏侧 `#FUNCTION` 纯助手（陷落状态 1,803 + FIRSTTIME 450 + 素質計算/CHK_FOCUS/关系_310 等 ≈ 2,500 谓词）。方案 = 对"体语句全为可解释形态（IF/ELSEIF/SIF/RETURNF + 本地量赋值）"的函数做**有界内联解释**（绑定实参 → 顺序求值 → RETURNF；副作用语句出现即拒绝 → unknown('call')）。地基已备好：assignments / statements / builtins / 前缀上下文。注意 FIRSTTIME 有副作用（写 CSTR）→ 副作用守卫必须先行。
- **`ui-state-replay` 回放面板**：选档（快照扫描结果）→ 选角色 → 选函数（或从导航面板"回放此函数"）→ 逐条谓词真值 + 置信度徽章 + 未知原因分组；消费 `state.replay`；调用上下文作为场景输入（对话对象 / 时机号）。
- **分支链重建**：用 `FunctionPredicates.statements`（含 ELSE/ENDIF）重建 IF/ELSEIF/ELSE 链 → "会走哪个分支"（比逐条谓词更接近作者视角）。
- **归档浏览器面板**：消费 `snapshot.source` 列档（saveMes / 角色数 / 大小），点击看摘要。
- **ui-condition-matrix（条件矩阵）**：按角色/家族聚合状态依赖；MESSAGECHECK 位可视化。
- **导航面板增强**：收藏/最近访问；面上条件维度聚合。
- `watchDirs` 文件监视（现为手动刷新；后续走 Rust notify）→ 增量重建索引。
- Monaco bundle 4.3MB 拆分（manualChunks，低优先级）。
- scanner 的 TRY 系配对精度（`TRYCALLFORM` 无 CATCH 时产生幻影开块）——影响上下文路径精度，方向"宁少勿错"，低优先级。

## 七、安全模型（写文件功能相关必读）

- 写入仅允许 `writablePaths`（用户批准 + 持久化于 kernel 存储域 `_global`），越权抛 `WriteNotAllowedError`；
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

## 九、本会话踩坑记录（给未来的自己）

1. **规则必须先核验引擎源码再定语义**：FORM 三连符号初版按"字面出现即报"实现 → 239 条里大量是 `+++`（MASTER 名）的有意用法（43 个文件）。收窄为排除 `+++` + 每文件每符号聚合 → 8 条真实事故。见 ARCHITECTURE §5.8"规则误报治理原则"。
2. **`ctx.onDispose` 是插件订阅/清理的必经之路**：事件订阅不 `onDispose` 会导致插件停用后残留 handler（内核 deactivate 逆序执行 disposer）。erb-parser / convention-linter 均照此。
3. 新增插件包需四处登记：`packages/plugins/*/package.json`、root `tsconfig.json` paths、`vitest.config.ts` aliases、`app/vite.config.ts` aliases + `app/package.json` deps（kernel devDeps 亦然）。漏一处就 resolve 失败。
4. **真实语料是解析器的验收标准（第三批）**：初版表达式解析器 dump 真实 opaque 样本（528k 条件行中 2.17%）→ 发现两大系统性缺口：`[[词]]`（引擎 rename 语法，读取期按 `_Rename.csv` 替换）与**括号索引段**（`YOGORE:(GET_CHARAHOME(TARGET))`、`TALENT:(NO:30):恋慕`）。补齐后引擎侧未解析 3,383 → **187**（0.04%）。教训：**先 dump 真实失败样本，再定语法扩展**——不要凭直觉猜"什么写法常见"。
5. **具名索引的 schema 反向查询语义**（variable-schema 单测抓出）：`lookup('TALENT','恋慕')` 时 description 应取**名称本身**；初版直接把名称→编号反向表的**编号**当描述返回（`description:'3'`）。数字索引查名、具名索引自描述——两个方向别混。
6. **CASE 文本不能整体 parse**：`CASE 1, 2, 3` / `CASE 10 TO 20` 是 SELECTCASE 语法而非表达式——必须在抽取层展开为 `subject == 值` 再逐条 parse（dump 统计时若对 CASE 原文整体 parse 会误报 opaque）。
7. **双 lib 类型环境（node vs DOM）对 Web API 的严格度不同**（第四批）：`new Blob([bytes])` 在 root tsconfig（@types/node）通过、在 app tsconfig（DOM lib）报 `Uint8Array<ArrayBufferLike>` 不满足 `BlobPart`（SharedArrayBuffer 不兼容性）。修法：`new Uint8Array(bytes)` 复制到独立 ArrayBuffer 支撑数组，两套定义下均兼容。**tsc 必须 root + app 双跑**。
8. **vite build 的 `prepare-out-dir` 偶发 EPERM**（第四批）：清空 `packages/app/dist/assets` 时报 Permission denied（文件瞬时占用），手动 `fs.rmSync(dist, {recursive, force})` 后重试即过——不是代码问题。
9. **批次编号勘误**（第四批会话）：`conditions.ts` 头注释与 ARCHITECTURE §5.9 曾写"条件抽取=第四批"，与 HANDOFF 口径（第三批）不一致；已统一为——**第三批=条件抽取、第四批=sav-parser**（判据：函数树=第二批在工作日志与 HANDOFF 双证）。
10. **TS7 对"联合字面量属性"的判别式 narrow 不可靠**（第五批）：`ArchiveScalarVariable.type` 是 `'int' | 'str'`（联合属性），`if (v.type === 'int' || v.type === 'str') return ...` 之后 TS 仍不把该变体从后续代码排除（报"Property 'saveLen' does not exist on ArchiveScalarVariable"）。修法：**显式类型守卫**（`isArrayVar(v): v is ArchiveArrayVariable`）替代判别式 narrow。
11. **变量寻址语义必须回引擎源码逐行核验**（第五批，§九-1 的再次应验）：`CFLAG:2` ≡ `CFLAG[TARGET,2]`、裸 `CFLAG` ≡ `CFLAG[TARGET,0]`（角色 1D）、裸 `DAY` ≡ `DAY:0`（全局 1D）——全部来自 `VariableParser.ReduceVariable`（:102-133 角色分支 / :153-170 全局分支），不是直觉推断。求值器的每个寻址分支都注了源码行号。
12. **JS 数字语义与 C# 的两处硬差异**（第五批）：①整数除法是**截断**（`-7/2 = -3`，Math.trunc，非 floor）；②位运算符（`& | ^ << >>`）在 JS 是 **32 位**——`1 << 40` 会得到 256 而非 2^40，必须经 BigInt 中转（`Number(BigInt(a) << BigInt(b))`，并先 `Number.isInteger` 检查）。
13. **同文件并行 Edit 必 EBUSY；且 Edit 偶发"声称成功未落盘"**（第五批复现，§八同款）：一次消息里对同一文件发多个 Edit 工具调用 → 第二个报 `EBUSY: resource busy or locked`；另有一次 Edit 报告成功但 `isArrayVar` 定义实际未写入（grep 复核时发现）。**同文件多次 Edit 必须逐条串行 + 关键修改后读回验证**。
14. **vitest 4 没有 `--reporter=basic`**（第五批）：传了会直接 Startup Error（"Failed to load custom Reporter from basic"）；用默认 reporter 即可（console.log 默认可见）。
15. **先测量再定语义（§九-1 / §5.9 教训第三次应验）**（第六批）：批五断言"未知主因 = `ARG:*`"，第六批实测构成：pseudo 4,439（LOCAL 系为主）/ call 2,485 / ARG 系仅 ≈14%。方法 = **临时 dump 测试（跑完即删）拿真实构成**再排优先级——本批因此把"本地量数据流"提为最大杠杆、调用上下文降为注入基建。
16. **块注释里写 `TRY*/PRINTDATA*` 会提前终止注释**（第六批，TS1127）：`*/` 序列在 `/** ... */` 内就是注释结束符；措辞改成"TRY 系、PRINTDATA 系"。
17. **引擎参数槽语义（第六批核验，勿凭直觉）**：签名第 i 个**声明槽**按顺序赋值——`(ARG, ARG:1)` 即声明 ARG:0 与 ARG:1 两槽（`getEl1forArg` = 下标，ErbLoader.cs:694-741）；声明槽被调用时**必有值**（实参或默认 0/''，ConvertArg Process.CalledFunction.cs:162-239）；未声明却引用 `ARG:n` → 引擎警告 + 默认尺寸 token（fresh-load 读 0，调用间持久）；`CALL FOO`（无括号）= 全部声明槽取默认值。LOCAL/ARG 调用间持久、读档重置（SetDefaultLocalValue 仅在 load/reset 时清）——回放取"直线执行"近似。
18. **模块循环依赖规避**：evaluate.ts 的 call 分支要调 builtins.ts、builtins 又要递归求值 → builtins 接收 `evalExpr: ExprEvaluator` 作为参数（依赖单向：evaluate → builtins），不搞双向 import。

## 十、新会话动手清单

1. `cd D:\DSH\kojo-editor && pnpm install`（bash 残缺时用 §八 的直调 node 方式）
2. `pnpm test && pnpm typecheck && pnpm audit:decoupling` —— **确认三项全绿**（基线：362 项 / ✅ / 9 插件）
3. 读 `docs/ARCHITECTURE.md` §5.8–§5.12 + 本文件 §六
4. **开始第七批 / v1.0 收口**（见 §6.5）：首选**纯函数内联求值**（消解 `call` 桶 ≈ 2,500 谓词，地基已备）或 **ui-state-replay 回放面板**（把回放成果第一次带上 UI）
5. 每完成一批：`pnpm test` 全绿 → Conventional Commits 提交 → `node tools/git-push.mjs`
