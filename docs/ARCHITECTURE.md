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

- **职责分工（v1.0 收口 A3）**：回放面板负责"状态 → 分支 / 文本预览"（`state.replay` 求值结果 → 分支走向 + 谓词三值）；糖预览（若做）复用本服务产出的 `PreviewLines[]` 渲染，**不自建渲染逻辑**。

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

### 5.8+ 实施记录（v0.2 各批次）——已迁移

各批次实施记录（原 §5.8–§5.19）自 2026-10-10 起迁移至 **`docs/IMPLEMENTATION-LOG.md`**（依据审阅 `REVIEW-OPTIMIZATION-2026-10-10.md` D12：ARCHITECTURE 回归设计决策本质，实施日志独立成册）。

约定：新批次的实施细节、金样本发现、踩坑记录**直接追加到 IMPLEMENTATION-LOG**；ARCHITECTURE 只收录影响设计决策/接口契约的修订。

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
│   │   ├── state-replay/      # requires: ['kernel.project','kernel.slots','kernel.io','snapshot.source','condition-extractor']（适配器经 slots.query('game.adapter', adapterId) 获取，见 ADR-0002；实施记录 §5.11/§5.12（IMPLEMENTATION-LOG））
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
