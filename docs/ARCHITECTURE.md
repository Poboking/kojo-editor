# 口上编辑器（Kojo Editor）架构设计文档

- **版本**：v0.2（技术选型定案；v0.1 初始设计）
- **日期**：2026-10-09
- **状态**：待评审，作为 v0 施工图
- **代号**：暂定 `kojo-editor`

---

## 1. 目标与非目标

### 1.1 目标

1. 做一款**首先服务 eraTW** 的口上编辑器，显著降低口上的编写、导航、验证成本。
2. 架构采用**一切皆插件**的解耦设计（借鉴 DSH/cordis），使后续能以"新增适配器插件"的方式扩展到 eraK、eraSQN、eraNAS 等其他 era 游戏，**内核零改动**。
3. 覆盖口上作者的三大痛点：
   - **导航与脚手架**：99,028 个函数、2,285 个文件的体量下，快速定位函数家族、按模板生成新角色口上骨架；
   - **结构性摩擦**：把条件矩阵、CFLAG 位图、`M_KOJO_K{n}_` 约定等隐性知识显式化；
   - **验证回路**：状态快照回放，不用真的把角色玩到指定状态就能预览台词。

### 1.2 非目标（v0 明确不做）

- 不做通用 ERB 游戏开发 IDE（只聚焦口上域）。
- 不做口上文本的自动翻译/机器润色。
- 不直接修改游戏逻辑代码（口上 ERB 以外的文件只读）。
- 不追求第一版就支持多游戏——但接口从第一天起就按多游戏设计。

### 1.3 竞品与现状（2026-10-09 调研结论）

| 项目                    | 思路                | 局限                            |
| --------------------- | ----------------- | ----------------------------- |
| Pyera 口上制作工坊          | 可视化拼积木写口上         | 服务自有 Pera 框架，产出 `.py`，不兼容 ERB |
| KojoDown              | Markdown 风格口上语法规范 | 只有规范，无编辑器/转换器，已停更             |
| EraElectron `.kojo`   | YAML 口上格式         | 仅限 UmaERA 引擎，不兼容 Emuera/ERB   |
| VS Code + EraBasic 插件 | 社区事实标准            | 只有语法高亮，无导航/状态/预览              |

**结论：Emuera/ERB 体系没有成型口上编辑器；"状态快照回放"是全社区无人覆盖的空白点，也是本项目最大的差异化价值。**

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────┐
│  插件层（一切皆插件）                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │eraTW 适配│ │ERB 解析器│ │状态快照  │ │预览渲染 │ │
│  │器        │ │          │ │回放      │ │         │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────┘ │
│  …ui.panel / editor.command / export.target 插件…    │
├─────────────────────────────────────────────────────┤
│  槽位注册表（UI 与扩展点，同槽允许多注册）              │
├─────────────────────────────────────────────────────┤
│  内核（只做四件事）                                   │
│  DI 容器 │ 事件总线 │ 存储域 │ 文件 IO                │
└─────────────────────────────────────────────────────┘
```

**铁律：内核源码中不允许出现任何具体游戏名（eraTW / eraK / …）。一切游戏相关知识只存在于 game adapter 插件。**

---

## 3. 内核设计（四件套）

### 3.1 DI 容器

借鉴 cordis 的 `inject` / `provide` 语义，但简化：

```ts
// 插件声明式依赖（启动时由容器接线）
interface Plugin {
  readonly id: string;                    // 存储域命名空间，如 'eratw-adapter'
  readonly version: string;
  readonly requires?: ServiceKey[];       // 依赖的服务 key，缺 → inactive
  readonly provides?: Record<ServiceKey, unknown>; // ctx.provide()
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

- 服务 key 用接口名（`game.adapter`），不绑定具体实现；消费方拿到的永远是"当前激活的那个实现"。
- 依赖图在启动时做拓扑排序，检测循环依赖并报告。
- 插件激活/失活是**运行时可逆**的（对应 DSH 桌面版"改插件必须完全重启"的教训——开发工具必须做到热重载插件，否则迭代效率极差）。

### 3.2 事件总线

- 类型化事件：`EventMap` 集中定义，`bus.emit('kojo.functionChanged', payload)` 编译期校验。
- 核心事件（内核预定义）：`file.changed` / `project.opened` / `kojo.functionChanged` / `plugin.statusChanged` / `state.snapshotLoaded`。
- 插件自定义事件必须带插件 id 前缀（`eratw-adapter:xxx`），与 DSH "存储域名用下划线、事件带命名空间"的约定同源。

### 3.3 存储域

- 每个插件一个命名空间目录：`{userData}/store/{plugin_id}/`，禁止跨域读写（对应 persona-mode 的 `persona_mode:personas/library/default` 设计）。
- 内核提供 `ctx.storage.get/set/watch`，格式 JSON；大对象（如解析索引）由内核管理缓存目录，不进插件域。

### 3.4 文件 IO

- 统一入口，内置：编码探测（ERB 老文件常见 Shift-JIS / UTF-8-BOM 混杂）、换行归一化、文件监视（chokidar）、原子写（写临时文件后 rename）。
- **游戏目录整体只读假设**：唯一可写路径由用户在设置中显式声明（eraTW 的 `ERB/口上・メッセージ関連/個人口上/`），写前自动备份到 `{userData}/backup/`（保留最近 N 版）。

---

## 4. 槽位系统

借鉴 DSH 客户端插件槽（`conversation.session.header.actions` 等），规则：

| 槽位                    | 用途                                        | 数据形态                                |
| --------------------- | ----------------------------------------- | ----------------------------------- |
| `ui.panel`            | 侧栏/底部面板                                   | `{ title, icon, component, order }` |
| `ui.editor.decorator` | 编辑器内嵌增强（高亮、内联提示）                          | `{ matcher, decorator }`            |
| `editor.command`      | 命令面板/右键菜单项                                | `{ id, title, when?, run(ctx) }`    |
| `game.adapter`        | 游戏适配器（同槽**单激活**；detect 阶段内核轮询全部候选，见 §5.7） | `GameAdapter` 实现                    |
| `export.target`       | 导出目标（ERB、独立文本、翻译对照表）                      | `{ id, export(project, options) }`  |

与 cordis/DSH 经验的差异（刻意反着设计的地方）：

1. **同槽默认多注册**。DSH 的 `root` 槽被 `AppFrame` 独占、后挂载被 shadow 的教训 → 本项目除 `game.adapter` 外一律允许多注册，同槽冲突用显式 `order` 字段解决，不依赖挂载顺序。
2. **插件状态面板是内核自带，不是插件**。cordis 依赖不满足时静默不 `apply()`，在游戏宿主里优雅，在开发工具里是灾难。内核强制渲染每个插件的状态：`active / inactive(缺 X) / error(原因) / disabled`。可观测性 > 优雅。

---

## 5. 核心接口定义

### 5.1 GameAdapter（多游戏扩展的唯一关口）

```ts
interface GameAdapter {
  readonly gameId: string;                 // 'eratw'
  readonly displayName: string;            // 'eraTW'

  // 工程识别与加载
  detect(rootDir: string): Promise<boolean>;
  loadProject(rootDir: string): Promise<GameProject>;

  // 口上域知识
  kojoPaths: string[];                     // 口上 ERB 目录（eraTW: ERB/口上・メッセージ関連/個人口上 等）
  functionFamilyIndex: FamilyIndexRule;    // 函数家族识别规则（M_KOJO_K{n}_XXX → 角色 n、家族 XXX）
  variableSchema: VariableSchema;          // 口上相关变量字典（CFLAG 位图、TCVAR:50 位表、好感 CFLAG:2 等）
  conventions: ConventionRule[];           // 可校验的剧本约定（门禁矩阵、KOJO_VERSION 热更新等）

  // 脚手架
  scaffold(characterId: number, options?: ScaffoldOptions): Promise<ScaffoldResult>;

  // 状态模型（供快照/预览消费）
  stateModel: StateModel;                  // 哪些变量影响口上分支、取值域、显示名
}
```

v0 中 eraTW 适配器是唯一实现。`GameProject` 的通用形状定义见 §5.7，由适配器填充、内核视为不透明载荷。**验收标准：将来接入第二个游戏时内核与解析器插件零改动。**

### 5.2 解析器服务（`erb.parser`）

```ts
interface ErbParser {
  parseFile(path: string): Promise<ErbFile>;        // 函数列表、PRINT 变体、SIF/IF 嵌套
  parseProject(project: GameProject): Promise<FunctionTree>;
  extractConditions(fn: ErbFunction): Condition[];  // 条件抽取 → 结构化谓词（好感>=N、部位=K 等）
}
```

- 解析结果缓存：`{cacheDir}/index/{gameId}/{mtimeHash}.json`，文件变更增量重建。
- eraTW 口上文件均为纯 ERB + 已知函数家族前缀，v0 不做完整 EraBasic 解释器，只做**结构感知的解析**（函数边界、PRINT 系行、CASE/IF 块、变量引用）。

### 5.3 状态快照与回放（差异化核心）

```ts
interface StateSnapshotSource {
  fromSav(savPath: string): Promise<Snapshot>;       // 存档解析（复用 parse_sav.cjs 协议成果）
  fromCliDebug(session: CliDebugSession): Promise<Snapshot>; // CliDebug 变量读取/写入监视
  fromManual(partial: Partial<Snapshot>): Promise<Snapshot>;
}

interface StateReplayer {
  apply(snapshot: Snapshot, characterId: number): Promise<ReplaySession>;
  // 回放 = 把快照注入"模拟状态机"，驱动条件求值
  evaluatePreview(characterId: number, scene: SceneRef): Promise<PreviewLines>;
}
```

关键设计：

- **快照三来源**：真实存档（二进制协议已 100% 对上，含 7-bit 字节前缀、MASTERNAME 条件保存、随机数快照等结论全部沉淀在 `snapshot.source` 服务的解析器中——契约 `plugin-api/snapshot.ts`，实现 `sav-parser` 插件，v0.2 第四批）；CliDebug 活会话（v15 SKIA 引擎，可实时读变量）；手工构造（作者自填"好感 800、深夜、浴室"这类组合）。
- **回放不是跑游戏**：不做完整 EraBasic 解释器，而是把口上函数中的条件（5.2 抽取结果）在快照状态上求值，输出"该状态下会命中哪些分支"。这是近似——`CALL` 链、`PRINTDATA` 随机等按声明式规则处理并**标注置信度**（`确定命中 / 疑似 / 无法判定`）。
- 与 Emuera CliDebug 的联动走 `_clidbg_test.cjs` 场景化驱动路线，v0 先只读，v1 再做写入注入。

### 5.4 预览渲染（`preview.renderer`）

- 输入：`PreviewLines[]`（已按快照条件筛选的行 + 变量引用）。
- 渲染 eraTW 的显示语义子集：PRINT 变体、SETCOLOR、`%NAME%`/`%CALLNAME%` 插值（用快照中的角色名替换）、FORM 串三连符号（`===`→CALLNAME:PLAYER 等已知映射，并**高亮警告** ERB 中非法使用三连符号做分隔线的坑）。
- 明确标注"近似渲染"，不声称与游戏逐像素一致。

### 5.5 状态注入器（v1.1 核心）：把"到达状态"的成本挪出游戏

先回答"有没有必要内置引擎"——**重新推演后：v1.1 不内置**。回路四段拆开看：重载 = 引擎自带"重新载入脚本文件"菜单（官方版也有，作者在场时一次菜单点击，无需任何补丁）；走到场景 = 作者顺手玩十秒；观察输出 = 游戏本身就是最完美的解释器+渲染器。真正的痛点只剩一个：**状态 grind**（好感 800/深夜/破瓜前夜要玩十几分钟）——而这正好落在已 100% 解码的 sav 二进制协议的优势区。让引擎保持黑盒，工具只做"状态传送门"。

```ts
interface SavInjector {
  loadTemplate(savPath: string): SavTemplate;              // 以作者真实存档为底版
  applyState(t: SavTemplate, patch: Partial<Snapshot>): SavTemplate; // 仅改目标变量
  write(t: SavTemplate, slot: 'test'): Promise<void>;      // 写独立测试槽
}
```

- **底版策略**：以作者当前 sav 为模板只改目标字段，SFMT 快照（RANDDATA）、全局配置、道具等原样保留——改动面最小，格式永远合法。
- **结构性安全**：只写独立测试槽位，真实 sav 从协议层不可触碰；AutoSave 与读档都在测试槽内打转。
- **回归保障**：6 个真实 sav"读取→原样写回→逐字节对比"作金样本；再用本地 SKIA 二进制实测"注入产物能否被引擎正常读档"。
- **兼容性**：不依赖引擎分支——官方 v22 与 SKIA v15 通吃，不需要任何上游 MR。

**推荐回路（零补丁、零子进程、零沙箱，约 30 秒）：**

```
改一行 → 编辑器近似回放（毫秒级，多数分支判断到此为止）
→ 需实机确认：注入器写测试 sav（<1s）
→ 作者在自己引擎里：菜单"重新载入脚本文件" → 读测试档 → 玩十秒到场景
```

对比原痛点"十几分钟验一行"，瓶颈段（状态 grind）已消灭，其余段本来就是作者的自然操作。原 P1 补丁 MR 相应降级：作者在场时菜单点击免费，不构成"单点依赖"。

### 5.6 受管引擎（v2 可选加速器，默认不立项）

将引擎作为"编辑器托管的常驻子进程 + 补丁后 CliDebug 协议"接入（managed subprocess，非进程内移植），实现全自动回路与批量回归。**立项触发条件（满足其一才启动）：**

1. 实测/作者反馈证明手动回路（5.5）仍太慢；
2. 出现"口上 CI"需求——N 个场景 × M 个状态的批量回归测试；
3. 近似回放在主流场景的实践覆盖率不达预期。

触发后可直接复用的论证（2026-10-09 源码核验，`_skia_src`）：`ReloadPartialErb` 热重载不丢游戏状态（保存/恢复 `prevState/prevReq`）但 CliDebug 协议未暴露（补丁 P1，~15 行）；`DebugCommand` SET 注入跨命令持久（`ProcessState` 不含全局/角色变量）；`BEGIN`/`CALL` 受 `IsMethodSafe()` 禁令限制，场景触达需点击宏重放；P2 `state.export/import`（~80 行）；P3 debug 窗口 `#FUNCTION` 调用能力（待核验）；沙箱运行档（junction ERB + 独立 sav）；校准环（实机输出与近似回放 diff 反哺）；Windows 下 HWND reparent 可嵌为"实机面板"。RuntimeProfile 由 game.adapter 提供，内核零游戏感知的原则不变。

### 5.7 Onboarding：选择游戏目录（解耦审计后的归属划分）

**用户体验流程不变，但编排权与知识归属严格分层。** 按"一切皆插件"审计，本流程的合规形态是——**内核只跑通用骨架，不含任何游戏概念**：

```
用户选目录（app 级通用 UI）
→ 内核对全部已注册的 game.adapter 候选轮询 detect(dir)
→ 命中的适配器执行 loadProject(dir)（黑盒，内核不感知内部步骤）
→ 内核持有不透明载荷 GameProject，发出 project.opened 事件
→ 各插件各自响应，内核编排到此为止
```

- **CHARA CSV 解析、sav/ 目录约定、可写路径提议**全部是适配器内部实现与 `GameProject` 字段——内核不知道"sav"这个词的存在。
- **sav 模板列表不是 onboarding 编排的一步**：sav-parser 插件订阅 `project.opened`，读取 `project.savDir` 自行扫描。游戏没有存档概念时该字段缺省 → sav-parser 进入 `inactive-for-project` 状态，状态面板可见。
- **erb-parser 同理**：订阅事件后消费 `project.kojoPaths` 建函数树。响应式（reactive），不是中心式流水线。
- **最近打开的项目**：内核按 `{rootDir, adapterId}` 存项目记录（通用持久化），重开时直接走 detect → loadProject。

**GameProject 的形状归 plugin-api（通用契约），内容归 adapter（游戏知识）：**

```ts
interface GameProject {          // 通用形状，内核视为不透明载荷
  rootDir: string;
  adapterId: string;
  kojoPaths: string[];           // 口上 ERB 目录
  savDir?: string;               // 存档目录（无此概念的游戏可缺省）
  writablePaths: string[];       // 适配器提议、内核批准并持久化的可写路径（§3.4）
  charaIndex: Map<number, { name: string; kojoDir?: string }>; // 角色号→显示名→口上目录
  gameVersion?: string;
}
```

**槽位语义细化**：`game.adapter` 的"单注册"指**同一项目同一时刻只有一个激活实现**；detect 阶段内核对全部已安装适配器轮询——多游戏自动识别由此免费获得，且不违反单激活原则。

**审计结论（2026-10-09）**：v0.1 初稿把"扫描 sav/ 生成模板列表"画进了 onboarding 编排序列，属于内核泄漏（内核将被迫知道 sav 概念与流程步骤）。修订后流程图不变、归属重排：内核 = 通用生命周期骨架；adapter = 全部游戏知识；消费插件 = 事件驱动的自取所需。

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


## 6. 目录结构（monorepo）

```
kojo-editor/
├── packages/
│   ├── kernel/            # 内核：DI、总线、存储域、文件IO、槽位注册表、状态面板
│   ├── plugin-api/        # 对外类型与接口（唯一公共 API 包，版本化 semver）
│   ├── plugins/
│   │   ├── erb-parser/        # 声明 requires: ['kernel.io']；v0.2 起订阅 project.opened 自建索引 + scanControlFlow
│   │   ├── eratw-adapter/     # 声明 requires: ['kernel.io']，eraTW 全部知识在此（家族识别 + conventions + variableSchema）
│   │   ├── convention-linter/ # 声明 requires: ['kernel.io','kernel.project','kernel.slots','erb.parser']
│   │   ├── condition-extractor/ # ★ 条件谓词抽取（服务 condition.extractor；表达式解析 + 状态依赖聚合 + 本地量赋值收集，语义标注来自 adapter）
│   │   ├── ui-convention-report/ # ui.panel：校验结果面板（点击 → editor.revealLocation）
│   │   ├── ui-kojo-navigator/ # ★ ui.panel：函数树导航（角色→家族→面→函数 + 条件徽章；家族规则经槽位查询，不 import adapter）
│   │   ├── sav-parser/        # ★ 存档二进制解析（服务 snapshot.source）：读（v0.2 第四批，六档实测零残余）+ 写/注入（§5.5，v1.1）
│   │   ├── state-replay/      # requires: ['game.adapter','snapshot.source']（v1.0；§5.11 求值 + §5.12 数据流/内置函数/调用上下文）
│   │   ├── runtime/           # v2 可选：受管引擎子进程 + CliDebug 协议（§5.6，默认不立项）
│   │   ├── preview-renderer/
│   │   ├── ui-condition-matrix/# v1.x 计划：条件矩阵/位图查看（消费 condition.extractor）
│   │   └── ui-plugin-status/  # ui.panel：插件状态面板（首个 ui.panel 示例）
│   └── app/               # 壳：Tauri（Rust 宿主）+ Monaco 编辑器主体；sav 二进制解析可下沉 Rust 侧
├── docs/                  # 本文档、ADR、接口变更记录
└── fixtures/              # eraTW 口上样本（脱敏子集）、 sav 样本（本地，不入库）
```

- 插件间**禁止直接 import**，只能通过 `plugin-api` 类型 + DI 拿服务（对应 DSH 插件目录无 node_modules 不能 import 第一方常量的教训——公共知识一律进 `plugin-api` 或 adapter 提供的数据服务）。
- `fixtures` 中的 eraTW 内容仅保留结构样本，完整游戏数据不进仓库。

---

## 7. 分阶段路线

| 阶段                | 交付物                                                                | 验收标准                                                           |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| **v0.1 骨架**       | Tauri 壳 + Monaco + kernel + plugin-api；选目录 onboarding（§5.7）；插件状态面板 | 选定有效 eraTW 目录后：CHARA CSV 映射解析成功，能列出 kojoPaths 下全部文件与函数清单       |
| **v0.2 导航**       | erb-parser + ui-function-tree + 条件抽取                               | 按角色/家族浏览 99k 函数；点函数跳转源码                                        |
| **v0.3 脚手架**      | eraTW 适配器 scaffold：按 K1 模板全文置换路线生成新角色骨架                            | 生成物可直接被 Emuera 加载无语法错                                          |
| **v1.0 快照回放**     | ~~sav-parser（已提前：v0.2 第四批）~~ + state-replay + 手工快照 UI              | 指定"好感/信赖/部位/时间"组合，列出将命中的口上分支                                   |
| **v1.1 状态注入器**    | sav 读写器 + 注入 UI + 测试槽管理（§5.5）                                      | 作者用自带引擎：注入任意深状态 → 读测试档 → 十秒内抵达深条件场景；真实存档零风险；官方 v22/SKIA v15 通吃 |
| **v1.2 受管引擎（可选）** | 仅当 §5.6 触发条件满足才立项                                                  | 全自动回路 ≤10 秒 或 口上 CI 批量回归可用                                     |
| **v2.0 多游戏验证**    | eraK 适配器（外部贡献或自研）                                                  | 内核/parser/replay/preview 零改动接入，架构验收                            |

每阶段均要求：新增代码全部走插件形态；内核 diff 为空或仅涉及明确的 kernel issue。

---

## 8. 测试策略

- **kernel**：DI 接线/循环依赖/缺依赖 inactive、槽位多注册与 order、存储域越权拒绝——单元测试全覆盖。
- **erb-parser**：用 fixtures 中真实的 eraTW 口上文件做金样本（golden test），重点覆盖：函数边界、CASE/IF 嵌套、PRINT 变体、`#FUNCTION` 文件识别（LazyLoading 排除规则）。
- **eratw-adapter**：约定校验规则逐条对拍实测结论（MESSAGECHECK 位协议、KOJO_VERSION 热更新、门禁矩阵）。
- **sav-parser**：以 `sav-parse/out/*.json` 现有 6 个真实存档解析结果为基准做回归。
- 不依赖 cordis 数值 `fiber.state` 断言之类的宿主实现细节（若引入 cordis 则适用；本项目自研内核，仅记取教训）。

---

## 9. 风险与对策

| 风险                     | 对策                                                  |
| ---------------------- | --------------------------------------------------- |
| ERB 方言差异（各游戏引擎版本不同）    | 解析器只承诺"结构感知"而非完整语义；方言差异由 adapter 的 `conventions` 声明 |
| 近似回放误判口上分支             | 置信度三档标注 UI 显式呈现；深链路（CALL 链）允许一键落到 CliDebug 实测       |
| eraTW 数据更新导致 schema 漂移 | variableSchema 版本化；加载时校验游戏版本号，不匹配则提示重建索引            |
| 写坏用户游戏文件               | 只写显式声明的 kojo 目录 + 自动备份 + 原子写                        |
| 注入 sav 写坏/污染真实存档       | 只写独立测试槽（§5.5）；金样本"原样写回逐字节对比"回归；写前自动备份               |
| sav 格式随引擎版本漂移          | 以作者当前 sav 为模板（格式必然合法）；版本校验不匹配即拒绝注入                  |
| 近似回放与实机输出不一致           | 作者"预期/实际"一键标记沉淀校准用例；v2 受管引擎（§5.6）触发后可自动化            |
| 范围蔓延（做成通用 era IDE）     | 1.2 非目标条款；任何"顺手支持"必须先过 game.adapter 接口评审            |



---

## 10. 技术决策记录（原待决策项，2026-10-09 定案）

| 决策项        | 结论                             | 理由 / 边界                                                             |
| ---------- | ------------------------------ | ------------------------------------------------------------------- |
| 桌面壳        | **Tauri**                      | 体积小；Rust 侧处理 sav 字节协议/编码探测顺手；PoC 风险（WinForms 互操作等）留到 v0.1 验证        |
| 编辑器主体      | **内嵌 Monaco**                  | ERB 语法/装饰由 erb-parser 经 `ui.editor.decorator` 槽注册；不做外部 VS Code 联动模式 |
| 插件分发       | **本地目录扫描，暂不做市场/签名**            | 装载接口预留来源字段，未来加签名机制不破坏现有插件                                           |
| 角色数据来源     | **随游戏 CHARA CSV 动态解析**（§5.7）   | 不内置静态表；解析失败显式报错，禁止静默猜测                                              |
| Onboarding | **启动先选游戏目录，全编辑器唯一全局上下文**（§5.7） | 与状态注入器绑定：sav 模板列表随项目实扫生成                                            |
