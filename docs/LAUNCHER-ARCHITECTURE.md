# 启动器模块（Launcher）架构设计与核心接口

- **版本**：v0.4（设计提案，未实现）
- **日期**：2026-10-26
- **修订**：v0.2 —— 游戏插件（可修改 / 扩展游戏逻辑）升为一等能力；删除「不做游戏逻辑修改」非目标；
  新增 `PluginManager`、插件清单 / 风险分级 / 函数级冲突 / 存档兼容门禁与信任链。
  v0.3 —— 补齐**插件项目**的作者闭环：创建 / 编辑 / 构建 / 构建并安装 / 从已装插件提取；
  新增 `PluginProjectService`、`PluginSourceManifest`、adapter 侧 `GamePluginRules.scaffold`。
  v0.4 —— **对照实树逐条核验后的修订批**（不改设计骨架，只改落点与判据）：①确定性打包改走
  既有 `zip.ts::buildZip`、函数级冲突改走既有 `ErbIndex` / `normalizedName` / `conventionPolicy`；
  ②ZIP 限额单源改指 `ZIP_EXTRACT_LIMITS` + `fixtures/zip-roundtrip/contract.json` + 宿主硬顶；
  ③补真名称（`snapshot.source`、`kernel.ops`、`bootstrap.ts` 注册点）并纠正 adapter 可达的
  解析通道（壳层 tree-sitter 不可 import）；④补两条实树闸（开机图 / artifact-audit）与真壳
  验收通道；⑤键位改为未占用项（`ctrl+n` 已被 `kojo.newKojoFile` 占用）；⑥脏缓冲保护提到 P1。
- **状态**：**设计提案 · 待评审**。本文件只回答「启动器怎么长、边界在哪、契约是什么」；
  落地后的插件数、测试数、性能读数一律以 `docs/STATE.md` 为准。
- **上位文档**：[ARCHITECTURE.md](ARCHITECTURE.md)（总体架构与铁律）、
  [PITFALLS.md](PITFALLS.md)（写盘 / 探针 / 多 agent 硬坑）。
  本文与上位文档冲突时，**以上位文档的铁律为准**；本文只做 additive 展开，不改既有语义。
- **与上位文档的有意扩展**：`ARCHITECTURE.md` §1.2 仍写「不直接修改游戏逻辑代码」。本设计对**编辑器**保持该约束，
  对**启动器**新增「用户显式安装游戏插件」能力；同时新增一条**独立于内核 `writablePaths` 的启动器写授权表**
  （逐根原生对话框批准，见 §9.1）。落地前必须以 ADR-0008/0009 把上位文档的非目标表述改成
  「编辑器不静默改；启动器只做显式、可回滚的插件安装」，并把这条新的写授权通道写进铁律，
  避免两处口径长期打架。
- **建议配套 ADR**：`docs/adr/0008-launcher-privileged-process-host.md`（进程特权面与服务键边界）、
  `docs/adr/0009-game-plugin-install-and-trust.md`（插件安装、函数覆盖与信任链）、
  `docs/adr/0010-plugin-source-project-and-build.md`（插件项目 = 工作区项目、确定性构建、源/产物分离）。

---

## 0. 摘要

启动器不是「编辑器里加一个开始按钮」，而是一个**新的顶层产品模式**：

1. **实例库**：把「一个游戏目录」升级为「可命名、可复制、可隔离、可删除的实例」；
2. **进程宿主**：Rust 宿主独占「启动 / 停止 / 杀进程树 / 收日志」特权，JS 永远拿不到任意 exe 启动权；
3. **游戏无关内核**：`launcher-core` 只认识实例、运行时、内容包、**游戏插件**、存档、日志这些通用概念；
   所有游戏知识（引擎变体、可执行文件相对路径、存档布局、日志格式、插件清单与加载规则）只由 `GameLaunchAdapter` 提供；
4. **PCL 式闭环**：实例 → 启动 → 游戏插件/内容包 → 存档备份 → 日志/崩溃 → 校验修复 → 更新，分期落地；
5. **与编辑器同源**：实例的游戏根可直接「在编辑器中打开」，编辑器里的项目也可「启动游戏」，
   两边共享同一份 adapter 识别结果；插件源码项目住在工作区，按「创建向导 → 编辑器修改 → 确定性构建 →
   构建并安装」闭环，不造第二套游戏知识。

**首版边界**：Windows 优先、单实例单进程、`shared`/`copy` 两档隔离；游戏插件与内容包支持
「安装 / 启停 / 卸载 / 回滚」，**允许修改/替换游戏逻辑文件**，但必须显式确认、先备份、可回滚；
不做 overlay、不做游戏本体下载、不做账号/联机/皮肤（era 系无此概念）、不做进程注入。

---

## 1. 背景、目标与非目标

### 1.1 为什么需要启动器

当前编辑器是**项目中心**的：欢迎页选一个游戏目录 → 打开为项目 → 编辑/校验/回放。
它能回答「这份口上写得对不对」，但回答不了玩家每天都会问的五个问题：

| 问题 | 现状 | 启动器要补的能力 |
|---|---|---|
| 我有好几个游戏/改版，分别在哪？ | 只有「最近项目」单列表 | 实例库：命名、分组、封面、最近启动 |
| 怎么启动？启动到哪一步了？ | 宿主没有进程启动命令 | 启动/停止/状态机/退出码/崩溃分类 |
| 这个包和那个包冲突吗？装了怎么卸？ | 只能手工复制文件 | 内容包/插件清单、安装计划、冲突检测、回滚、启停 |
| 存档坏了 / 想回到昨天？ | 只能手工备份 sav | 存档列表、备份、恢复、导入导出 |
| 报错了，错在哪一行？ | 只能看游戏窗口 | 日志捕获、编码解码、`file:line` 跳编辑器、诊断包 |

**产品判断**：口上作者与玩家是同一个人群。编辑器解决「写」，启动器解决「玩/验」；
两者共用 adapter 与文件层，才能形成「改 → 启 → 看日志 → 跳回代码」的闭环。

### 1.2 目标（按优先级）

1. **P0 · 能启动、能停、能看见**：实例库、进程宿主、状态机、日志尾部、首次信任确认；
2. **P1 · 日常可用**：运行时解析、内容包与游戏插件安装/启停/卸载/回滚、基础函数级冲突检测、
   **插件项目创建 / 编辑 / 构建 / 构建并安装 / 从已装插件提取**、存档备份/恢复、任务中心、诊断包；
3. **P2 · PCL 对齐**：插件 SDK 与高级项目模板、跨包函数依赖图、包签名与更新通道、下载源/校验修复、
   整合包导入导出、overlay 隔离、便携模式、文件关联；
4. **全程**：不破坏现有编辑器的任何基线；内核与宿主源码零游戏名词；启动器能力面不开放任意 exe。

### 1.3 非目标（明确不做）

- **不做游戏本体分发/下载站**：era 系游戏文件多含第三方版权素材，启动器只管理**用户自备**的目录；
  远端下载只用于「用户自己发布的内容包 / 运行时」且必须过主机白名单与校验，不内置游戏资源源。
- **不做通用游戏启动器**：不追求 Steam/Xbox/模拟器全覆盖；接口按多游戏设计，但只服务 era 系 adapter。
- **不做静默 / 隐式修改**：编辑器不在游戏目录里改口上以外的文件；任何游戏逻辑变更只能由用户在启动器里
  **显式安装游戏插件**发生，且必须展示文件清单与风险、先备份、可回滚。启动器**支持**安装可修改/替换
  ERB、CSV、资源文件的插件——这是产品能力，不是例外。
- **不做进程注入 / DLL hook / 内存修改**：游戏插件必须通过游戏自身的加载机制（ERB/CSV/资源）生效；
  启动器不注入进程、不挂钩子、不改内存。这条与「允许插件修改逻辑」不矛盾：改的是游戏加载的文件，不是运行中的进程。
- **不做账号 / 联机 / 皮肤 / 成就**：era 系无对应概念，不为了「像 PCL」而硬造。
- **不做第二套自动更新器**：应用自更新继续走现有 `tauri-plugin-updater` + `updater_proxy.rs`；
  启动器的「更新」只指实例/运行时/内容包/游戏插件的版本与修复。
- **不做游戏进程的沙箱**：游戏自身写注册表、写用户目录、联网，宿主无法约束；
  启动器只保证「我们启动的那个 exe 与参数是我们校验过的」，不承诺游戏运行时隔离（见 §16 风险）。

### 1.4 与现有架构的关系

| 现有资产 | 启动器如何复用 | 是否改动 |
|---|---|---|
| `GameAdapter` 槽位（`game.adapter`） | 增加**可选** `launch?: GameLaunchAdapter`；旧 adapter 零改动 | additive |
| `sav-parser` / `state-replay` | 存档列表的摘要、快照回放直接复用（服务键 `snapshot.source` / `state.replay`），不重写 | 零改动 |
| ERB 解析器（服务键 `erb.parser`）/ 库包 | adapter 的 `analyzeFunctions` 经**服务键注入**或依赖库包（`@kojo/kojo-core` / `packages/erb-syntax-tree`）产出函数定义；启动器不新增第二套解析 | 零改动（消费侧新增） |
| `WorkspaceService` | 插件项目 = 工作区项目（`meta.kind='game-plugin'`）+ 一个制品；产物落项目 `build/`，安装仍走插件管线 | 零改动（只新增 meta 约定） |
| `zip.ts::buildZip` | 插件包构建的**打包实现**直接复用；但它**自己不排序**、时间取 `opts.date`（缺省 `Date.now()`）⇒ 确定性由消费侧「先按 posix 路径排序 + 传固定 `date`」保证；生产消费方已是 `kojo-project-kit/package-actions.ts` | 零改动（消费侧新增） |
| `plugin-api/erb.ts::ErbIndex` | 函数级索引（`byName: Map<normalizedName, ErbFunctionRef[]>`，含 `filePath` + `startLine`）；冲突比对与重名诊断共用这一份 | 零改动 |
| `convention-linter` 的 `erb.duplicate-function` + adapter `conventionPolicy` | 「有意重复」的判据（真盘上 eraSQC 有 190 处逐角色重复、eratohoK 仅 2 处）直接复用，启动器不另立宽容名单 | 零改动 |
| `file-history` / `ops-history`（`kernel.ops`，契约 `plugin-api/journal.ts`） | 内容包/插件覆盖前的备份、撤销记录可复用同一套思路 | 只读参考 |
| `market.rs` 的 ZIP 守卫 + `fixtures/zip-roundtrip/contract.json` | 守卫抽成通用 `archive_guard.rs`，市场与启动器共用；**跨语言判据参数仍走那张共享表**（`include_str!`，两侧各有钉，表漂一字节必有一边红） | 重构 + 测试 |
| `ps10-eager-graph` / `release-gate` 的开机图与产物闸 | 启动器视图与插件必须**全程动态 import**，否则开机图（193 文件 / 2,870 KB，余量 10 KB）与 dist 件数（80 / 85）当场红 | 接入（不改阈值） |
| `updater_proxy.rs` | 应用自更新不动；启动器的下载闸另立 `launcher/download.rs` | 零改动 |
| `single-instance` 插件 | 保证同一时刻只有一个应用实例；启动器再叠每实例锁 | 零改动 |
| `ProjectService` / 工作区 | 「在编辑器中打开实例」复用现有项目打开链路 | 零改动 |
| 右键菜单统一路由 | 启动器所有右键菜单走同一注册表，不手写文案 | 接入 |

---

## 2. 设计原则（铁律映射）

| # | 原则 | 具体落地 |
|---|---|---|
| 1 | **内核 / 契约 / 宿主零游戏名词** | 代码标识符只用 `instance` / `runtime` / `content` / `plugin` / `save` / `log`；引擎名、exe 名、存档布局、插件清单名只在 adapter 与文档示例里 |
| 2 | **一切皆插件** | `launcher-core` 是一等插件，只依赖 `@kojo/plugin-api`；UI 是应用壳的一等视图，不塞进内核 |
| 3 | **能力面 = 服务键面** | 启动能力单独一个键 `launcher.service`；要启动就必须显式 `requires`，不靠 `kernel.io` 顺带获得 |
| 4 | **JS 拿不到任意启动权** | 宿主只有 `launcher_start(instanceId)`，**没有** `start(exePath)`；实例的 exe 在创建时由 adapter 提议、宿主校验、用户信任 |
| 5 | **写盘边界不破** | 实例、内容、备份、日志全部住 `{appData}/launcher/`；游戏目录只在用户显式授权（对话框）或 `copy` 实例内被写 |
| 6 | **绕闸只有一条法定通道** | 诊断包/备份导出走「系统保存对话框 + 写盘同命令」，等同 `exportFile`；不新增任意目标路径参数 |
| 7 | **失败可见，不静默** | 每个实例有 `state` 与 `lastExit`；每个任务有 `state/error`；每条安全拒绝带中文原因与错误码 |
| 8 | **additive 优先** | 新服务键、新命令、新可选字段；既有 `GameAdapter`、`Plugin`、`PlatformBridge` 旧消费方零改动 |
| 9 | **Windows-first，不为跨平台预支复杂度** | P0 只做 Windows Job Object；非 Windows 走 `#[cfg]` 的尽力实现或明确 `LAUNCHER_PLATFORM_UNSUPPORTED` |
| 10 | **不做无证据的魔法数** | 容器限额、日志环大小、备份保留数全部集中为契约常量；ZIP 限额的 TS 单源是 `zip.ts::ZIP_EXTRACT_LIMITS`，跨语言判据参数是 `fixtures/zip-roundtrip/contract.json`（宿主侧另有硬顶，作纵深防御），**不在 `launcher.ts` 另立第二份**；首版值由真实包体/日志实测后定，不散落 |
| 11 | **逻辑变更显式、可回滚** | 游戏插件可以改/替换游戏逻辑，但必须：清单可见、风险分级、先备份存档与被覆盖文件、可卸载回滚；禁止静默安装与「装完再说」 |
| 12 | **源与产物分离，构建可重复** | 作者改的是工作区里的 `plugin.json`（无哈希）；哈希与清单只在构建时产生；同源两次构建逐字节相同；**源在项目、产物在 `build/`、装到实例是第三份**，三者版本由 `inspectDrift` 一眼说清 |

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  应用壳（React）                                                     │
│  ┌──────────────┐  ┌──────────────────────────────────────────────┐  │
│  │ 编辑器视图    │  │ 启动器视图                                   │  │
│  │ Welcome/Work │  │ 实例库 · 实例详情 · 任务中心 · 下载 · 设置    │  │
│  └──────┬───────┘  └──────────────────────┬───────────────────────┘  │
└─────────┼─────────────────────────────────┼──────────────────────────┘
          │ ProjectService                   │ LauncherService
          │                                  │ （服务键 launcher.service）
┌─────────▼─────────────────────────────────▼──────────────────────────┐
│  launcher-core（一等插件，**游戏无关**）                              │
│  InstanceStore │ ProcessSupervisor │ RuntimeManager │ ContentManager   │
│  PluginManager │ PluginProjectService │ SaveManager │ LogService       │
│  TaskCenter │ Update/Repair*                                           │
└─────────┬─────────────────────────────────▲──────────────────────────┘
          │ LauncherHostBridge              │ GameLaunchAdapter
          │ （kernel.launcher，零逻辑透传）  │ （仅 adapter 插件提供）
┌─────────▼─────────────────────────────────┴──────────────────────────┐
│  Tauri Host（Rust，**特权原语，零游戏知识**）                         │
│  进程/Job Object │ 实例注册表 │ ZIP 守卫 │ 日志泵 │ 下载闸 │ 诊断包   │
└─────────┬────────────────────────────────────────────────────────────┘
          │ OS（文件系统 / 进程 / 网络）
┌─────────▼────────────────────────────────────────────────────────────┐
│  游戏进程（用户信任过的 exe；宿主只负责启动与收尸，不注入、不拦截）   │
└──────────────────────────────────────────────────────────────────────┘

* Update/Repair 为 P2；P0/P1 不接线。
```

### 3.1 分层职责

| 层 | 知道什么 | 不知道什么 | 失败时 |
|---|---|---|---|
| 启动器 UI | 实例、状态、任务、日志、包、插件风险 | 引擎名、exe 名、存档格式、函数语义 | 显示中文错误 + 重试入口 |
| `launcher-core` | 通用领域模型与流程编排 | 任何具体游戏名词 | 抛 `LauncherError`，任务落 `failed` |
| `PluginManager` | 插件清单、风险分级、函数级冲突、兼容与存档影响 | 具体函数语义、引擎加载细节 | 计划阶段拒绝或标风险 |
| `PluginProjectService` | 工作区项目/制品、源清单、根映射、确定性构建、漂移 | 具体游戏目录、函数语义、模板内容 | `LAUNCHER_PLUGIN_PROJECT_*` / `LAUNCHER_PLUGIN_BUILD_FAILED` |
| `kernel.launcher` | 宿主命令的形状 | 领域语义 | 原样透传宿主错误 |
| Rust 宿主 | 路径、进程、ZIP、字节流、Job Object | 游戏名、存档语义、内容/插件含义 | 返回 `LauncherErrorDto` |
| `GameLaunchAdapter` | 引擎变体、exe 相对路径、存档目录、日志格式、插件清单/加载规则、模板骨架与函数分析 | UI 与进程实现 | `probe` 返回空 / `buildProfile` 抛错 |

### 3.2 一次启动的时序

```
UI            LauncherService        Adapter           Host              OS
 │ 创建实例 ────▶│                      │                │                 │
 │              │─ probe/detect ──────▶│                │                 │
 │              │◀─ LaunchCandidate[] ──│                │                 │
 │              │─ buildProfile ───────▶│                │                 │
 │              │◀─ LaunchProfile ──────│                │                 │
 │              │─ launcher_instance_create ───────────▶│                 │
 │              │                      │                │─ 校验/复制 ────▶│
 │              │◀─ InstanceCreation ───────────────────│                 │
 │ 首次启动 ────▶│─ launcher_trust_executable ─────────▶│                 │
 │              │                      │                │─ 原生确认框 ──▶ 用户
 │              │◀─ ExecutableTrust ────────────────────│                 │
 │ 启动 ────────▶│─ launcher_start(instanceId) ────────▶│                 │
 │              │                      │                │─ CreateProcess ▶│
 │              │◀─ ProcessStatus ──────────────────────│                 │
 │◀─ 状态事件 ───│◀─ kojo:launcher-process ─────────────│                 │
 │◀─ 日志事件 ───│◀─ kojo:launcher-log ─────────────────│◀─ stdout/stderr ─│
 │ 停止 ────────▶│─ launcher_stop(instanceId) ─────────▶│                 │
 │              │                      │                │─ WM_CLOSE/杀树 ▶│
 │              │◀─ ProcessStatus(exited) ──────────────│                 │
```

---

## 4. 模块与包结构

| 模块 | 位置 | 新增/改动 | 职责 | 依赖 |
|---|---|---|---|---|
| 契约 | `packages/plugin-api/src/launcher.ts` | **新增** | 所有启动器类型、服务接口、`GameLaunchAdapter`、游戏插件清单/门禁类型、错误码、任务模型 | 无（纯类型） |
| 契约导出 | `packages/plugin-api/src/index.ts` | 改一行导出 | 对外暴露启动器契约 | — |
| adapter 扩展 | `packages/plugin-api/src/game.ts` | **additive** | `GameAdapter.launch?: GameLaunchAdapter` | 旧字段零改 |
| 服务键 | `packages/plugin-api/src/services.ts` | **additive** | `KernelServices.LauncherHost = 'kernel.launcher'`；`WellKnownServices.Launcher = 'launcher.service'` | — |
| 内核透传 | `packages/kernel/src/launcher.ts` + 装配 | **新增薄层** | 把 `LauncherHostBridge` 方法原样转发到平台桥；零业务判定 | `kernel` 既有桥 |
| 启动器核心 | `packages/plugins/launcher-core/` | **新增插件** | 实例编排、进程监督、运行时、内容、游戏插件、存档、日志、任务 | 只依赖 `@kojo/plugin-api` |
| 插件管理 | `packages/plugins/launcher-core/src/plugin-manager.ts` | **新增** | 插件清单、风险分级、函数级冲突、版本兼容、存档影响门禁 | 契约 + adapter 的 `analyzeFunctions` 回调 |
| 插件项目服务 | `packages/plugins/launcher-core/src/plugin-project.ts` | **新增** | 插件项目的创建 / 打开 / 确定性构建 / 构建并安装 / 从已装插件提取 | 契约 + 服务键 `kernel.workspaces` / `kernel.io`（不 import 内核） |
| 插件项目 UI | `packages/app/src/launcher/plugin-project-wizard.tsx` | **新增** | 新建向导、项目列表、构建/安装按钮、诊断与漂移提示 | React + 启动器服务 |
| 宿主 | `packages/app/src-tauri/src/launcher/` | **新增模块** | 特权原语：注册表、进程、Job Object、ZIP、日志泵、下载闸、诊断包 | Rust 标准库 + 既有 crate |
| 宿主守卫 | `packages/app/src-tauri/src/archive_guard.rs` | **新增 + 市场复用** | ZIP 条目/深度/字节/大小写折叠四重守卫，单点真源 | `zip` crate |
| 组合根 | `packages/app/src/bootstrap.ts` | **加一行注册** | `launcher-core` 进显式有序注册序列（位置在内核服务就绪之后、需要它的视图之前）；root / app 的 `package.json` 同步加 workspace 依赖 | 既有装配 |
| UI | `packages/app/src/launcher/` | **新增视图（全动态 import）** | 实例库、详情、插件/内容/存档/日志、任务中心、下载、设置 | React + 服务 |
| 编辑器桥 | `packages/app/src/ui/` | **少量接线** | 「启动游戏」「在编辑器中打开实例/插件源码」 | 既有 session |
| adapter 示例 | `packages/plugins/eratw-adapter/src/launch.ts`、`plugins.ts` | **新增** | 提供候选 exe、存档布局、日志解析、插件根/清单/加载顺序 | 只在本包出现游戏名 |
| 测试 | `packages/plugins/launcher-core/tests/`、`packages/app/src-tauri/src/launcher/tests.rs` | **新增** | 路径守卫、状态机、ZIP 炸弹、回滚、编码 | — |

### 4.1 为什么 `launcher-core` 是插件，而不是内核服务

- 它含**领域流程**（安装计划、冲突决议、回滚顺序），不该进内核；
- 它必须能被单测用假宿主驱动（Node 环境零进程），插件形态天然可注入；
- 未来接第二个游戏时，只换 adapter，不碰 `launcher-core`；
- 内核只加一条 `kernel.launcher` 零逻辑透传，**不是**把启动器塞进内核。

### 4.2 为什么宿主不做领域判断

宿主的输入永远是「实例 ID + 已校验的相对路径 + 已声明的限额」；
它不知道「这个 exe 是哪个游戏」「这个 zip 是口上包还是资源包」。
游戏语义全部在 TS 侧（adapter + launcher-core），宿主只回答「路径是否逃逸」「进程是否还活着」「字节流是什么」。

---

## 5. 数据模型

> 所有路径在 `instance.json` 中**只存相对路径或用户选择的绝对源根**；
> `instanceRoot` / `gameRoot` 由宿主按当前 `{appData}` 现算，避免应用数据目录迁移后实例全废。

### 5.1 实例

```ts
export type IsolationMode = 'shared' | 'copy' | 'overlay';

/** 实例自身状态（磁盘/配置层面），与进程运行状态正交 */
export type InstanceState = 'preparing' | 'ready' | 'broken' | 'removing';

export interface LauncherInstance {
  readonly id: string;                 // 宿主生成的 UUID；永不重用
  name: string;                        // 用户可见名，可重名，不参与寻址
  readonly adapterId: string;          // 'eratw-adapter' 这类插件 id，仅作标识
  readonly gameId: string;             // adapter 自报的稳定 id；内核不解释
  readonly createdAt: string;          // ISO-8601
  updatedAt: string;

  /** 用户最初选择的游戏根；shared 实例启动时直接用它；copy 实例仅作修复来源 */
  readonly sourceRoot: string | null;
  readonly isolation: IsolationMode;

  /** 派生字段：宿主按 appData 现算，不持久化 */
  readonly instanceRoot: string;
  readonly gameRoot: string;

  state: InstanceState;
  executable: LaunchExecutable;
  runtimeId: string | null;
  locale: LocaleProfile;
  encoding: EncodingProfile;
  saveRoots: readonly SaveRootSpec[];      // 来自 adapter 的布局，随实例快照
  contentRoots: readonly ContentRootSpec[];

  readonly executableTrust: ExecutableTrust | null;
  launchCount: number;
  lastLaunchedAt: string | null;
  lastExit: ExitRecord | null;

  notes?: string;
  tags?: readonly string[];
  readonly schemaVersion: number;      // 实例清单结构版本，迁移用
}
```

```ts
export interface LaunchExecutable {
  /** 相对 gameRoot 的路径；绝不允许绝对路径、..、盘符、UNC */
  readonly relativePath: string;
  args: readonly string[];             // 直接 argv，不经 shell
  env: Readonly<Record<string, string>>; // 仅显式追加项；宿主另有最小环境白名单
  windowMode: 'auto' | 'visible' | 'hidden';
  /** 宿主在创建/信任时计算并写入；JS 传入的值一律忽略 */
  readonly sha256: string | null;
}

export interface ExecutableTrust {
  readonly sha256: string;
  readonly size: number;
  readonly approvedAt: string;
  /** 证明来源固定为宿主原生确认框，不接受 JS 传哈希 */
  readonly approvedBy: 'native-dialog';
}

export interface ExitRecord {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly reason: 'clean' | 'user' | 'crash' | 'app-exit' | 'killed' | 'unknown';
}
```

### 5.2 启动描述（adapter 产出，core 消费）

```ts
export interface LaunchCandidate {
  readonly id: string;                 // adapter 内稳定 id，如 'engine-x64'
  readonly label: string;              // 用户可见，如「内置引擎（64 位）」
  readonly executableRelativePath: string;
  readonly arch?: 'x64' | 'x86' | 'arm64' | 'any';
  readonly runtime?: RuntimeRequirement;
  readonly notes?: string;
}

export interface LaunchProfile {
  readonly candidateId: string;
  readonly executable: LaunchExecutable;
  readonly cwdRelative: string;        // 默认 '.'
  readonly runtime?: RuntimeRequirement;
  readonly locale?: LocaleProfile;
  readonly encoding?: EncodingProfile;
  readonly saveRoots: readonly SaveRootSpec[];
  readonly contentRoots: readonly ContentRootSpec[];
  readonly warnings?: readonly string[];
}

export interface SaveRootSpec {
  readonly id: string;
  readonly label: string;
  readonly relativePath: string;
  /** 格式标签只是给上层选解析器，宿主不解释 */
  readonly format?: string;
  /** shared 实例默认 false：读可以，写回需显式目录授权 */
  readonly writableInShared: boolean;
}

export interface ContentRootSpec {
  readonly id: string;
  readonly label: string;
  readonly relativePath: string;
  /**
   * 根的内容类别。`script` / `data` / `resource` **都可能是游戏逻辑文件**
   * （ERB 脚本、CSV 表、引擎资源），`plugin` = adapter 声明的插件专用安装根。
   * core 不解释语义，只用于 UI 分组与风险提示。
   */
  readonly kind: 'script' | 'resource' | 'data' | 'plugin';
  /** 该根接受的包类型；adapter 声明，core 校验（`plugin` 类型同样要在此显式列出） */
  readonly accepts: readonly ContentPackKind[];
  /**
   * shared 实例下是否允许写。默认 false；true 表示「授权后可写」，
   * 仍需用户在原生目录对话框里逐根批准（见 §9.1），不是无条件写。
   */
  readonly writableInShared: boolean;
}
```

### 5.3 运行时 / 语言环境

```ts
export interface RuntimeRef {
  readonly id: string;
  readonly kind: string;               // 'engine' / 'java' / 'wrapper'…；core 不解释
  readonly version: string;
  readonly arch: 'x64' | 'x86' | 'arm64' | 'any';
  readonly rootPath: string;           // 托管运行时根，或实例内运行时根
  readonly source: 'managed' | 'instance' | 'external';
  readonly verified: RuntimeVerification | null;
}

export interface RuntimeRequirement {
  readonly kind: string;
  readonly versionRange?: string;      // 首版只支持精确版本或 '*'；范围解析 P2
  readonly arch?: 'x64' | 'x86' | 'arm64' | 'any';
  readonly optional?: boolean;
}

export interface RuntimeVerification {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];
}

export interface LocaleProfile {
  /** inherit = 跟随系统；explicit = 只为子进程设置以下环境提示 */
  readonly mode: 'inherit' | 'system' | 'explicit';
  readonly language?: string;          // BCP-47，如 'ja-JP'
  readonly codepage?: number;          // 仅作记录与日志；不承诺进程内生效
}

export interface EncodingProfile {
  /** 日志/文本的默认解码；auto = 先探测 BOM/UTF-8，再退回 fallback */
  readonly mode: 'auto' | 'fixed';
  readonly fallback: string;           // 如 'shift_jis' / 'utf-8' / 'utf-16le'
}
```

> **诚实边界**：Windows 没有「按进程切系统 ANSI 代码页」的官方原生 API。
> `LocaleProfile` 首版只做环境变量提示与记录；真正的 locale emulation 需要第三方包装器，
> 属 P2 且必须单独评审（见 §16）。

### 5.4 内容包与游戏插件清单

> **一个清单，两档语义**：内容包（`kind != 'plugin'`）与游戏插件（`kind = 'plugin'`）共用
> `ContentPackManifest` 的磁盘格式与安装管线；插件只是多声明了能力、兼容性与逻辑影响。
> 不为插件另造第二套包格式——否则「装内容包」和「装插件」会变成两条各自演化的代码路径。

```ts
export type ContentPackKind = 'script' | 'resource' | 'data' | 'plugin' | 'bundle';

/** 插件对游戏逻辑的声明式能力面；core 只做校验与展示，不解释具体语义 */
export type PluginCapability =
  | 'add-content'          // 只追加文件（不改既有文件）
  | 'override-functions'   // 覆盖/替换既有脚本函数
  | 'add-commands'         // 注册新命令/新入口
  | 'modify-data'          // 修改数据表（CSV/配置）
  | 'replace-resources';   // 替换图片/音频等资源

export interface ContentPackManifest {
  readonly schemaVersion: 1;
  readonly id: string;                 // 'author.pack-name'，全局稳定
  readonly name: string;
  readonly version: string;            // 精确版本；首版不做 semver 范围
  readonly kind: ContentPackKind;
  readonly gameId: string;             // 必须与实例一致
  readonly files: readonly ContentFileEntry[];
  /** 排序权重；仅当 adapter 的 `orderSource='manifest'` 时生效，同值按安装顺序 */
  readonly loadOrder: number;
  readonly requires?: readonly { id: string; version: string }[];
  readonly conflicts?: readonly string[];
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly description?: string;

  // ── 以下仅 kind='plugin' 有意义；内容包填了也按插件处理（宁可多一道闸） ──
  /** 声明的能力面；缺省 = ['add-content']（最保守） */
  readonly capabilities?: readonly PluginCapability[];
  /** 面向的游戏版本；adapter 的 `pluginRules.isCompatible` 判定，core 只搬运 */
  readonly gameVersion?: string;
  /** 插件 API 版本（插件作者编写的 SDK 契约版本） */
  readonly apiVersion?: string;
  /** 对存档的影响声明；缺省 'unknown'（按最坏情况处理：装前备份） */
  readonly saveImpact?: 'none' | 'possible' | 'unknown';
  /** 加载入口（根 + 相对路径）；具体含义由 adapter 解释（如某脚本文件的函数表） */
  readonly entrypoints?: readonly ContentFileRef[];
}

export interface ContentFileEntry {
  /** 目标根 id（来自 `ContentRootSpec.id`）；一个包可跨多个根安装 */
  readonly rootId: string;
  /** 相对该根的 posix 路径 */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** 指向某个 contentRoot 内一个文件；计划、ownership、冲突决议共用这一形状 */
export interface ContentFileRef {
  readonly rootId: string;
  readonly path: string;
}

/**
 * **作者源清单**（项目内 `plugin.json`）。与 `ContentPackManifest` 的分工：
 * - 源清单**没有** `files[]` / 哈希——开发者不该手写哈希；
 * - 源清单多一个 `roots[]` 映射：说明制品内哪些目录要落到哪个内容根；
 * - 构建时由 `PluginProjectService` 展开为 `pack.json`（`ContentPackManifest`），
 *   逐文件计算 sha256 / size，源清单本身不随包分发。
 *
 * 校验规则与 `ContentPackManifest` 同源（`pluginId` 字符集、版本、能力、gameId），
 * 但**不要求** `files[]`：手写 `plugin.json` 里出现哈希一律视为非法（防止伪造验收）。
 */
export interface PluginSourceManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: 'plugin';
  readonly gameId: string;
  readonly capabilities: readonly PluginCapability[];
  readonly loadOrder: number;
  readonly gameVersion?: string;
  readonly apiVersion?: string;
  readonly requires?: readonly { id: string; version: string }[];
  readonly conflicts?: readonly string[];
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly description?: string;
  readonly saveImpact?: 'none' | 'possible' | 'unknown';
  /** 加载入口（**源清单内**的相对路径，构建时换算成目标根内的 `ContentFileRef`） */
  readonly entrypoints?: readonly string[];
  /**
   * 源文件到目标根的映射（逐条见 `PluginSourceRootMap`）。
   */
  readonly roots: readonly PluginSourceRootMap[];
}

/** 源清单的一条根映射：制品内目录 → 目标内容根目录 */
export interface PluginSourceRootMap {
  readonly rootId: string;
  /** 制品内相对目录（posix；必须存在） */
  readonly from: string;
  /** 目标根内相对目录；缺省 `''`（根下直接放置） */
  readonly to?: string;
  /** 相对 `from` 的 include glob；缺省 = 全部 */
  readonly include?: readonly string[];
  /** 相对 `from` 的 exclude glob；缺省 = 不排除 */
  readonly exclude?: readonly string[];
}
```

### 5.5 进程 / 任务 / 日志

```ts
export type ProcessState =
  | 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'crashed';

export interface ProcessStatus {
  readonly instanceId: string;
  state: ProcessState;
  pid: number | null;
  sessionId: string | null;
  startedAt: string | null;
  elapsedMs: number;
  exitCode: number | null;
  exitReason: ExitRecord['reason'] | null;
  lastError: LauncherError | null;
}

export type TaskKind =
  | 'instance-copy' | 'instance-duplicate'
  | 'content-install' | 'content-uninstall' | 'content-toggle'
  | 'plugin-install' | 'plugin-uninstall' | 'plugin-toggle' | 'plugin-update'
  | 'plugin-build' | 'plugin-extract'
  | 'save-backup' | 'save-restore' | 'save-import'
  | 'download' | 'verify' | 'repair'
  | 'bundle-import' | 'bundle-export';

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface LauncherTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly instanceId: string | null;
  state: TaskState;
  progress: {
    readonly done: number;
    readonly total: number;
    readonly unit: 'bytes' | 'files' | 'steps';
    readonly message: string;
  } | null;
  readonly createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: LauncherError | null;
  /** 按 kind 收窄；UI 只在对应 kind 下读 */
  result: Readonly<Record<string, unknown>> | null;
  readonly cancellable: boolean;
}

export interface LogSession {
  readonly id: string;
  readonly instanceId: string;
  readonly startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface LogLine {
  readonly ts: number;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly text: string;
  readonly location?: LogLocation;
}

export interface LogLocation {
  /** 相对 gameRoot 的路径；core 只认这个形态，避免日志泄露绝对路径到编辑器 */
  readonly relativePath: string;
  readonly line?: number;
  readonly column?: number;
}
```

### 5.6 错误

```ts
export type LauncherErrorCode =
  | 'LAUNCHER_INSTANCE_NOT_FOUND'
  | 'LAUNCHER_INSTANCE_BUSY'
  | 'LAUNCHER_INSTANCE_NOT_READY'
  | 'LAUNCHER_TRUST_REQUIRED'
  | 'LAUNCHER_TRUST_CHANGED'
  | 'LAUNCHER_EXECUTABLE_INVALID'
  | 'LAUNCHER_RUNTIME_MISSING'
  | 'LAUNCHER_SOURCE_NOT_APPROVED'
  | 'LAUNCHER_PATH_ESCAPE'
  | 'LAUNCHER_ARCHIVE_INVALID'
  | 'LAUNCHER_ARCHIVE_LIMIT'
  | 'LAUNCHER_CONTENT_CONFLICT'
  | 'LAUNCHER_CONTENT_BROKEN'
  | 'LAUNCHER_PLUGIN_CONFLICT'          // 函数级/文件级冲突未决议
  | 'LAUNCHER_PLUGIN_INCOMPATIBLE'      // gameVersion / apiVersion 不满足
  | 'LAUNCHER_PLUGIN_DEPENDENCY'        // requires / conflicts 未满足
  | 'LAUNCHER_PLUGIN_SAVE_RISK'         // 存档影响未确认或备份失败
  | 'LAUNCHER_PLUGIN_UNTRUSTED'         // 发布者未在信任链中（P2）
  | 'LAUNCHER_PLUGIN_PROJECT_INVALID'   // plugin.json / 源目录结构不合法
  | 'LAUNCHER_PLUGIN_PROJECT_EXISTS'    // 同工作区已有相同 pluginId 的项目
  | 'LAUNCHER_PLUGIN_BUILD_FAILED'      // 构建失败（映射逃逸、重复目标、读失败）
  | 'LAUNCHER_PLUGIN_EXTRACT_FAILED'    // 从已装插件提取项目失败
  | 'LAUNCHER_SAVE_RESTORE_FAILED'
  | 'LAUNCHER_DOWNLOAD_REJECTED'
  | 'LAUNCHER_TASK_CANCELLED'
  | 'LAUNCHER_TASK_BUSY'
  | 'LAUNCHER_SCHEMA_UNSUPPORTED'
  | 'LAUNCHER_PLATFORM_UNSUPPORTED'
  | 'LAUNCHER_INTERNAL';

export interface LauncherError {
  readonly code: LauncherErrorCode;
  /** 面向用户的中文人话；禁止直接透传 OS 英文错误串 */
  readonly message: string;
  /** 面向排障的细节（路径、退出码、ZIP 条目），可折叠显示 */
  readonly detail?: string;
  readonly retryable: boolean;
}
```

---

## 6. 核心接口定义

### 6.1 `GameLaunchAdapter`（adapter 唯一新增面）

```ts
/**
 * 游戏启动知识的唯一住处。由 adapter 插件实现，挂在 `GameAdapter.launch?`。
 * 内核、launcher-core、Rust 宿主都不认识这里的任何具体值。
 */
export interface GameLaunchAdapter {
  /** 扫出可启动候选；一个都没有 = 该目录不能作为实例 */
  probe(rootDir: string): Promise<readonly LaunchCandidate[]>;

  /** 把候选 + 用户选项编译成完整启动描述；此处定 exe、cwd、args、存档/内容根 */
  buildProfile(
    rootDir: string,
    candidateId: string,
    options?: LaunchBuildOptions,
  ): Promise<LaunchProfile>;

  /** 存档布局；不给 = 启动器不显示存档页 */
  readonly saveLayout?: SaveLayoutSpec;

  /** 内容包可落地的根；不给 = 该游戏禁用内容包 */
  readonly contentRoots?: readonly ContentRootSpec[];

  /**
   * 游戏插件规则；不给 = 该游戏禁用插件（内容包仍可用）。
   * 清单文件名、加载顺序、函数分析回调等**全部**在这里，core 不认识任何具体值。
   */
  readonly pluginRules?: GamePluginRules;

  /** 日志行解析：错误定位、格式识别；不给 = 只做纯文本 */
  readonly logRules?: LogParseRules;

  /** 日志默认编码；不给 = auto */
  readonly defaultEncoding?: EncodingProfile;

  /** 创建 copy 实例时跳过的相对路径（缓存、临时文件等） */
  readonly copyExclude?: readonly string[];
}

export interface LaunchBuildOptions {
  readonly includeSaves?: boolean;
  readonly runtimeId?: string | null;
  readonly locale?: LocaleProfile;
  readonly encoding?: EncodingProfile;
}

export interface SaveLayoutSpec {
  readonly roots: readonly SaveRootSpec[];
  /** 存档条目的显示规则；不给 = 用文件名 */
  readonly listRule?: {
    readonly extensions: readonly string[];
    readonly labelFromFileName?: boolean;
  };
}

export interface LogParseRules {
  /** 从一行日志里认出「哪个文件第几行」；认不出返回 null */
  parseLocation(line: string): LogLocation | null;
  /** 是否算错误行（用于崩溃摘要与筛选） */
  isErrorLine?(line: string): boolean;
  /** 该行是否属于噪声（进度条、重复空行） */
  isNoiseLine?(line: string): boolean;
}

/**
 * 游戏插件的**全部游戏侧知识**。只有 adapter 能提供；`launcher-core` 把它当不透明配置使用。
 * 这里没有一条规则写死「ERB」「CSV」之类的词——具体清单名、目录名都来自 adapter 实现。
 */
export interface GamePluginRules {
  /** 插件可安装的根（通常是 contentRoots 的子集，adapter 自行保证一致性） */
  readonly roots: readonly ContentRootSpec[];
  /** 插件清单文件名（可多候选，按序取第一个命中的）；如 `['mod.json']` */
  readonly manifestNames: readonly string[];
  /**
   * 同一根内多插件的加载顺序来源：
   * - `manifest`：清单里的 `loadOrder`（默认）；
   * - `directory`：目录名排序（游戏自己按目录扫描时用）；
   * - `filename`：文件名前缀排序（前缀约定由 adapter 解释）。
   */
  readonly orderSource: 'manifest' | 'directory' | 'filename';
  /** 游戏版本 / 插件 API 版本兼容判定；不给 = 不判定（只显示清单声明） */
  readonly isCompatible?(ctx: PluginCompatibilityContext): boolean;
  /** 装/卸/启停后是否必须重启游戏才生效 */
  readonly requiresRestart: boolean;
  /** 插件的存档影响默认值；清单未声明时用这个 */
  readonly saveImpact: 'none' | 'possible' | 'unknown';
  /**
   * 函数级分析回调：**由 adapter 实现**，launcher-core 只拿「归一化名 + 相对路径 + 行号」
   * 做比对，不认识任何语言或语法。
   *
   * **可用的复用通道只有两条**（adapter 是插件，受 `audit:decoupling` B/C 约束）：
   * ①经服务键注入 `erb.parser`（`ErbParserService.parseFile` / `buildIndex`），
   * ②依赖库包（`@kojo/kojo-core` / `packages/erb-syntax-tree`——`eratw-adapter` 已在用）。
   * **壳层的 `packages/app/src/monaco/tree-sitter/` 不可 import**：那是 Monaco 侧
   * wasm + worker，属应用壳，不是 adapter 可达面。
   *
   * 产物形状与 `plugin-api/erb.ts::ErbFunctionRef` 对齐（ERB 系 adapter 直接投影
   * `ErbIndex.byName` 即可）；非 ERB 游戏（如 XML 口上）自行映射到同一形状。
   * `baseDir` = 解析基准（游戏根 / 插件 payload 根），`files` 为相对路径。
   * 解析失败必须抛错（计划阶段失败可见），**不许返回空数组假装没有函数**。
   * 缺席 = 该游戏不做函数级冲突分析，只做文件级。
   */
  readonly analyzeFunctions?: (
    baseDir: string,
    files: readonly string[],
  ) => Promise<readonly ScriptFunctionDefinition[]>;
  /**
   * 新插件项目的骨架生成（模板）。
   *
   * **只返回内容，不写盘**：adapter 产出「相对制品根的路径 → 内容」，
   * 由 `PluginProjectService` 经 `kernel.workspaces` 写入工作区——写授权永远留在 core 一侧。
   * 生成结果**不得**包含 `plugin.json`：清单由 core 按向导输入生成，避免清单双真源。
   * 缺席 = 该游戏只能创建空白项目（向导仍可用，模板下拉只有「空白」）。
   *
   * **与被删除的 `GameAdapter.scaffold` 不是一回事**（`plugin-api/game.ts` 顶部有
   * 「别再往回加」的判据记录）：那个成员**直接写游戏目录**、全仓零消费方，已删；
   * 本回调不写盘、消费方是向导。各 adapter 现有的 `scaffold.ts` 纯生成器仍在，
   * 是「供数」真源（经 `deps.scaffold` 通道服务新建口上向导）——本回调若与该通道
   * 形状重合，应做薄包装**复用**它，不得复制第二份生成逻辑。
   */
  readonly scaffold?: (options: PluginScaffoldOptions) => Promise<PluginScaffoldResult>;
}

/**
 * 模板标识（游戏无关的通用枚举）。各 adapter 决定自己实现哪几个；
 * 未实现的模板不显示在向导里（`pluginRules.scaffold` 缺席 ⇒ 只剩 `blank`）。
 */
export type PluginTemplateId =
  | 'blank'               // 仅清单 + 空目录 + README
  | 'add-content'         // 追加文件（最保守）
  | 'override-functions'  // 覆盖/替换既有函数
  | 'add-commands'        // 新增命令/入口
  | 'data-patch'          // 修改数据表
  | 'resource-pack';      // 替换图片/音频资源

export interface PluginScaffoldOptions {
  readonly template: PluginTemplateId;
  readonly pluginId: string;
  readonly displayName: string;
  readonly gameId: string;
  readonly capabilities: readonly PluginCapability[];
  /** 目标实例的游戏版本（向导带入；模板据此写注释或版本约束，不做判定） */
  readonly gameVersion: string | null;
}

export interface PluginScaffoldResult {
  /** 相对制品根的 posix 路径 → 文本内容 */
  readonly files: Readonly<Record<string, string>>;
  /** 二进制资源（图片/音频）；core 用 `io.writeBytes` 补写 */
  readonly binaryFiles?: Readonly<Record<string, Uint8Array>>;
  /** 人类可读的生成说明（写进项目 README 的「模板生成」段） */
  readonly report: readonly string[];
}

export interface ScriptFunctionDefinition {
  /** 函数标识（原样；只用于展示与日志） */
  readonly name: string;
  /**
   * 归一化名（大小写无关的游戏必须给，如 Emuera 系一律大写）。
   * **冲突比对一律用这一栏**——`plugin-api/erb.ts` 的 `ErbFunction` 早已按这个口径建模。
   */
  readonly normalizedName: string;
  /** 相对 baseDir 的 posix 路径 */
  readonly path: string;
  readonly line: number;
}

export interface PluginCompatibilityContext {
  readonly gameVersion: string | null;
  readonly pluginGameVersion: string | null;
  readonly pluginApiVersion: string | null;
  /** 实例当前的 adapter / 游戏标识，供 adapter 自行判定 */
  readonly gameId: string;
}
```

`GameAdapter` 的增量只有一行：

```ts
export interface GameAdapter {
  // …既有字段一字不动…
  /** 可选：本适配器参与启动器实例管理；缺席 = 该游戏只能编辑，不能启动 */
  readonly launch?: GameLaunchAdapter;
}
```

### 6.2 `LauncherService`（插件 `launcher-core` 提供）

```ts
export interface LauncherService {
  readonly instances: InstanceStore;
  readonly processes: ProcessSupervisor;
  readonly runtimes: RuntimeManager;
  readonly content: ContentManager;
  readonly plugins: PluginManager;
  /** 插件源码项目（住工作区）；与 `plugins` 同一能力面，但读写的是源不是实例 */
  readonly pluginProjects: PluginProjectService;
  readonly saves: SaveManager;
  readonly logs: LogService;
  readonly tasks: TaskCenter;

  /** P2；首版返回 LAUNCHER_PLATFORM_UNSUPPORTED 或省略 */
  readonly updates?: LauncherUpdateService;

  /** 插件激活时调用：读注册表、做 schema 迁移、恢复上次会话的崩溃记录 */
  initialize(): Promise<void>;

  /** 插件失活时调用：停任务、断开事件；不杀游戏进程（由宿主 app-exit 统一收尸） */
  dispose(): Promise<void>;
}
```

### 6.3 `InstanceStore`

```ts
export interface InstanceStore {
  list(): Promise<readonly LauncherInstance[]>;
  get(id: string): Promise<LauncherInstance | null>;

  /** 概况：exe 是否存在/是否被篡改、运行时是否解析成功、磁盘占用、警告 */
  inspect(id: string): Promise<InstanceInspection>;

  /**
   * 创建实例。
   * - sourceRoot 必须已在宿主「来源根批准表」中（只由原生目录对话框写入）；
   * - candidateId 来自 adapter.probe；
   * - copy 实例会排队一个 instance-copy 任务；shared 实例立即就绪。
   */
  create(req: CreateInstanceRequest): Promise<InstanceCreation>;

  update(id: string, patch: InstancePatch): Promise<LauncherInstance>;

  /** deleteFiles=false 只移出库；true 删除实例目录（先停进程、先确认） */
  remove(id: string, opts?: RemoveInstanceOptions): Promise<void>;

  /** 复制实例；copy-to-copy 只复制实例目录，shared-to-copy 从源根复制 */
  duplicate(id: string, name?: string): Promise<InstanceCreation>;

  subscribe(listener: (change: InstanceChange) => void): Unsubscribe;

  /** P2：整合包 */
  importBundle?(archivePath: string, opts?: ImportBundleOptions): Promise<InstanceCreation>;
  exportBundle?(id: string, opts?: ExportBundleOptions): Promise<string | null>;
}

export interface CreateInstanceRequest {
  readonly name: string;
  readonly sourceRoot: string;
  readonly adapterId: string;
  readonly gameId: string;
  readonly candidateId: string;
  readonly isolation: IsolationMode;
  readonly includeSaves?: boolean;      // copy 实例默认 false：全新存档
  readonly runtimeId?: string | null;
  readonly locale?: LocaleProfile;
  readonly encoding?: EncodingProfile;
  readonly notes?: string;
}

export interface InstancePatch {
  name?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  locale?: LocaleProfile;
  encoding?: EncodingProfile;
  executableRelativePath?: string;     // 改动后信任作废，需重新确认
  runtimeId?: string | null;
  notes?: string;
  tags?: readonly string[];
}

export interface InstanceCreation {
  readonly instance: LauncherInstance;
  readonly task: LauncherTask | null;  // copy/duplicate 非空；shared 为 null
}

export interface InstanceInspection {
  readonly instance: LauncherInstance;
  readonly executable: {
    readonly absolutePath: string;
    readonly exists: boolean;
    readonly sha256: string | null;
    readonly trusted: boolean;
    readonly changedSinceTrust: boolean;
  };
  readonly runtime: {
    readonly required: RuntimeRequirement | null;
    readonly resolved: RuntimeRef | null;
  };
  readonly paths: {
    readonly instanceRoot: string;
    readonly gameRoot: string;
    readonly saveRoots: readonly string[];
    readonly logDir: string;
    readonly backupDir: string;
  };
  readonly diskUsageBytes: number;
  readonly warnings: readonly string[];
}

export interface RemoveInstanceOptions {
  readonly deleteFiles: boolean;
  readonly keepBackups?: boolean;
}

export interface InstanceChange {
  readonly kind: 'created' | 'updated' | 'removed' | 'state';
  readonly instanceId: string;
}
```

### 6.4 `ProcessSupervisor`

```ts
export interface ProcessSupervisor {
  /**
   * 启动已登记实例。
   * 校验链（宿主内）：实例存在 → ready → exe 在 gameRoot 内 → 常规文件 →
   * 信任哈希匹配 → 运行时已解析 → 每实例锁空闲 → 创建进程。
   * @throws LauncherError（TRUST_REQUIRED / TRUST_CHANGED / EXECUTABLE_INVALID /
   *         RUNTIME_MISSING / INSTANCE_BUSY / INSTANCE_NOT_READY）
   */
  start(id: string): Promise<ProcessStatus>;

  /** force=true 直接杀进程树；否则先尝试窗口关闭，超时再杀 */
  stop(id: string, opts?: StopOptions): Promise<ProcessStatus>;

  status(id: string): ProcessStatus;
  list(): readonly ProcessStatus[];

  /**
   * 首次信任 / exe 变更后的重新信任。
   * 宿主自己算哈希，并在同一个命令内弹**原生确认框**；JS 不能传哈希、不能跳过。
   */
  trust(id: string): Promise<ExecutableTrust>;

  subscribe(listener: (status: ProcessStatus) => void): Unsubscribe;
}

export interface StopOptions {
  readonly force?: boolean;
  readonly timeoutMs?: number;         // 默认取契约常量
}
```

### 6.5 `RuntimeManager`

```ts
export interface RuntimeManager {
  list(): Promise<readonly RuntimeRef[]>;
  scan(rootDir: string): Promise<readonly RuntimeRef[]>;

  /** 原生目录对话框 + 同命令登记，JS 不传路径（照 chooseWorkspaceRoot 的授权形态） */
  importFromDialog(): Promise<RuntimeRef | null>;

  resolve(instanceId: string): Promise<RuntimeRef | null>;
  verify(id: string): Promise<RuntimeVerification>;
  remove(id: string): Promise<void>;
}
```

### 6.6 `ContentManager`

> 只处理 `kind !== 'plugin'` 的包。`kind === 'plugin'` 一律走 §6.7 `PluginManager`；
> 两者共用落盘管线，但插件的门禁不可绕过。

```ts
export interface ContentManager {
  list(instanceId: string): Promise<readonly InstalledContent[]>;

  /** 只读预检：解到暂存、校验清单、算冲突；不碰实例。返回 planId 供确认后应用 */
  planInstall(instanceId: string, archivePath: string): Promise<ContentInstallPlan>;

  /** 用户确认后真正落盘；返回可跟踪的任务 */
  applyInstall(
    planId: string,
    resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask>;

  uninstall(instanceId: string, packId: string): Promise<LauncherTask>;
  setEnabled(instanceId: string, packId: string, enabled: boolean): Promise<LauncherTask>;
  setOrder(instanceId: string, packIds: readonly string[]): Promise<void>;
  diagnose(instanceId: string): Promise<ContentDiagnosis>;
}

export interface ContentInstallPlan {
  readonly planId: string;
  readonly manifest: ContentPackManifest;
  /** 本包实际要写入的根（一个包可以跨根） */
  readonly targets: readonly { readonly rootId: string; readonly relativePath: string }[];
  readonly additions: readonly ContentFileRef[];
  readonly overwrites: readonly ContentFileRef[];
  readonly conflicts: readonly ContentConflict[];
  readonly missingRequirements: readonly string[];
  readonly warnings: readonly string[];
  readonly expiresAt: string;           // 暂存计划过期即作废，避免陈旧 applies
}

export interface ContentConflict {
  readonly rootId: string;
  readonly path: string;
  readonly kind: 'other-pack' | 'base-file';
  readonly existingPackId: string | null;
  readonly resolution: 'abort' | 'skip' | 'overwrite' | 'replace';
}

export interface ConflictResolution {
  readonly rootId: string;
  readonly path: string;
  readonly action: 'skip' | 'overwrite' | 'replace';
}

export interface InstalledContent {
  readonly manifest: ContentPackManifest;
  enabled: boolean;
  order: number;
  readonly installedAt: string;
  readonly ownedFiles: readonly ContentFileRef[];
  readonly status: 'ok' | 'conflict' | 'broken';
}

export interface ContentDiagnosis {
  readonly instanceId: string;
  readonly issues: readonly {
    readonly packId: string;
    readonly code: 'missing-file' | 'hash-mismatch' | 'conflict' | 'missing-dependency';
    readonly path?: string;
    readonly message: string;
  }[];
}
```

### 6.7 `PluginManager`

> **与 `ContentManager` 的关系**：两者共用同一条落盘管线（暂存 → 计划 → 应用 → 回滚），
> 但 `PluginManager` 额外承担**逻辑变更门禁**：能力声明、版本兼容、函数级冲突、存档影响、
> 风险分级与信任链。`ContentManager` 只装 `kind != 'plugin'` 的包；`PluginManager` 只装
> `kind === 'plugin'`。一条管线、两个入口，避免 UI 上「这个包到底该点哪个按钮」的歧义。

```ts
export interface PluginManager {
  list(instanceId: string): Promise<readonly InstalledPlugin[]>;

  /**
   * 只读预检：解到实例暂存、读清单、算文件冲突 + 函数冲突 + 兼容性 + 存档影响。
   * **不碰游戏根**；返回 planId 供用户确认后应用。
   */
  planInstall(instanceId: string, archivePath: string): Promise<PluginInstallPlan>;

  /**
   * 用户确认后落盘；返回可跟踪任务。
   * `saveImpact != 'none'` 时先自动备份存档（reason='pre-plugin'），备份失败即中止。
   */
  applyInstall(
    planId: string,
    resolutions?: readonly PluginConflictResolution[],
    opts?: PluginApplyOptions,
  ): Promise<LauncherTask>;

  uninstall(instanceId: string, pluginId: string): Promise<LauncherTask>;
  setEnabled(instanceId: string, pluginId: string, enabled: boolean): Promise<LauncherTask>;
  setOrder(instanceId: string, pluginIds: readonly string[]): Promise<void>;

  /** 只读诊断：缺文件、哈希不符、函数覆盖、依赖缺失、兼容性、加载顺序 */
  diagnose(instanceId: string): Promise<PluginDiagnosis>;

  /** 在编辑器中打开插件源码项目（住工作区）；无源码 = 提示而不是报错 */
  openSource(instanceId: string, pluginId: string): Promise<void>;

  /** P2：把已安装插件导出为可分发 ZIP；原生保存对话框 + 写盘同命令 */
  exportPackage?(instanceId: string, pluginId: string): Promise<string | null>;
}

/**
 * 风险分级：只由清单能力 + 实际文件落点推导，core 不读脚本内容。
 * - content-only：只追加、不覆盖任何既有文件；
 * - extends-logic：新增函数/命令/数据，或覆盖但不删除既有定义；
 * - overrides-logic：覆盖/替换既有脚本函数或资源；
 * - unknown：清单缺字段或无法判定（按最高风险展示，装前必须显式确认）。
 */
export type PluginRisk = 'content-only' | 'extends-logic' | 'overrides-logic' | 'unknown';

export interface InstalledPlugin {
  readonly manifest: ContentPackManifest;
  enabled: boolean;
  order: number;
  readonly installedAt: string;
  readonly ownedFiles: readonly ContentFileRef[];
  readonly risk: PluginRisk;
  readonly requiresRestart: boolean;
  readonly status: 'ok' | 'conflict' | 'incompatible' | 'broken';
  /** 来源插件项目 id（`WorkspaceProject.id`）；null = 纯二进制 / 外部安装，无源码可开 */
  readonly sourceProjectId: string | null;
  readonly trust: PluginTrust;
}

export interface PluginTrust {
  readonly state: 'verified' | 'unverified' | 'unknown';
  readonly publisher: string | null;
  /** P2：签名时间；首版恒 null */
  readonly signedAt: string | null;
}

export interface PluginCompatibility {
  readonly ok: boolean;
  readonly gameVersion: string | null;
  readonly requiredGameVersion: string | null;
  readonly apiVersion: string | null;
  /** 判定来源：adapter.isCompatible / 仅清单声明 / 未判定 */
  readonly checkedBy: 'adapter' | 'declared' | 'none';
  readonly reasons: readonly string[];
}

/**
 * 函数级冲突：adapter 提供函数定义清单，core 只比对「归一化名 + 定义位置」。
 *
 * **两处判据必须复用实树既有真源，否则真盘会刷屏或漏报**：
 * - 比对键用 `ScriptFunctionDefinition.normalizedName`（大小写无关的引擎，
 *   拿原样名比会漏掉 `M_KOJO_K1` vs `m_kojo_k1`）；
 * - 「有意重复」由当前 adapter 的 `conventionPolicy` 决定——与
 *   `convention-linter` 的 `erb.duplicate-function` 同一判据。真盘实证：
 *   eraSQC 有 190 处逐角色重复（EVENTTRAIN 91 + EVENTEND 90 + 1），
 *   eratohoK 仅 2 处；启动器**不另立宽容名单**。
 */
export interface FunctionConflict {
  readonly functionName: string;
  readonly existing: {
    readonly pluginId: string | null;   // null = 基础游戏文件
    readonly path: string;
    readonly line: number;
  };
  readonly incoming: { readonly path: string; readonly line: number };
  /** 默认 abort；replace 必须用户显式选择，并先备份旧定义所在文件 */
  readonly resolution: 'abort' | 'skip' | 'replace';
}

export interface PluginConflictResolution {
  /** 文件冲突时填 */
  readonly rootId?: string;
  readonly path?: string;
  /** 函数冲突时填 */
  readonly functionName?: string;
  /** 不提供 abort：取消整个安装请走 UI 的「取消」而不是逐条 abort */
  readonly action: 'skip' | 'overwrite' | 'replace';
}

/** 用户显式勾选的越闸项；缺省一律 false（宁可拒绝，不可默认放行） */
export interface PluginApplyOptions {
  /** 兼容性判定失败仍安装；插件会被标 incompatible 并在启动前警告 */
  readonly allowIncompatible?: boolean;
  /** 已知存档影响并同意先备份；saveImpact != 'none' 时必需 */
  readonly acknowledgeSaveImpact?: boolean;
  /**
   * 本次安装来自某个插件项目时，记录来源项目 id（写入 `state.json`），
   * 供插件详情「打开源码」使用。缺省 = 外部 ZIP，无源码可开。
   */
  readonly sourceProjectId?: string;
}

export interface PluginInstallPlan {
  readonly planId: string;
  /** install = 新装；upgrade = 同 id 已有版本（保留 enabled / order） */
  readonly mode: 'install' | 'upgrade';
  readonly manifest: ContentPackManifest;
  /** 本包实际要写入的根（一个包可以跨根） */
  readonly targets: readonly { readonly rootId: string; readonly relativePath: string }[];
  readonly additions: readonly ContentFileRef[];
  readonly overwrites: readonly ContentFileRef[];
  readonly conflicts: readonly ContentConflict[];
  readonly functionConflicts: readonly FunctionConflict[];
  readonly missingRequirements: readonly string[];
  readonly compatibility: PluginCompatibility;
  readonly saveImpact: 'none' | 'possible' | 'unknown';
  readonly risk: PluginRisk;
  readonly requiresRestart: boolean;
  readonly warnings: readonly string[];
  /** 暂存计划过期即作废，避免陈旧 applies */
  readonly expiresAt: string;
}

export interface PluginDiagnosis {
  readonly instanceId: string;
  readonly issues: readonly {
    readonly pluginId: string;
    readonly code:
      | 'missing-file'
      | 'hash-mismatch'
      | 'conflict'
      | 'missing-dependency'
      | 'function-override'
      | 'incompatible'
      | 'load-order';
    readonly rootId?: string;
    readonly path?: string;
    readonly functionName?: string;
    readonly message: string;
  }[];
}
```

### 6.8 `PluginProjectService`

> **为什么是一个独立服务，而不是 `PluginManager` 的子方法**：两者操作的对象不同——
> `PluginManager` 读写的是**实例里的已装产物**（`content/`、`ownership.json`、游戏根），
> `PluginProjectService` 读写的是**作者工作区的源**（项目目录、`plugin.json`、`build/`）。
> 混在一起会让「装插件」的权限面顺带获得工作区写权，也说不清卸载/回滚该作用在谁身上。
>
> **它不认识游戏目录**：所有输出只落工作区根（常驻可写根）与项目 `build/`；
> 装配到实例必须回到 `PluginManager.planInstall` → `applyInstall` 的同一条管线。
> 因此「构建并安装」不是一条捷径，而是 `build` + `planInstall` + 用户确认 + `applyInstall` 四步。
>
> **能力面显式声明**：`launcher-core` 在 `requires` 里声明服务键 `kernel.workspaces` 与
> `kernel.io`；任一缺席时创建/提取/构建直接报错，不降级成「假项目」（不静默、不造空壳）。

```ts
export interface PluginProjectService {
  /** 列出工作区里 `meta.kind = 'game-plugin'` 的全部项目（跨所有授权根） */
  list(): Promise<readonly PluginProject[]>;
  get(projectId: string): Promise<PluginProject | null>;

  /**
   * 创建项目：
   * 1. 从 `instanceId` 反查 adapter / gameId / gameVersion（**只读**，不碰游戏目录）；
   * 2. `WorkspaceService.create` + `createArtifact` 落项目与 `plugin/` 制品；
   * 3. 按向导输入生成 `plugin.json`（唯一真源）；
   * 4. 调 `GamePluginRules.scaffold` 拿文件映射，由本服务写入工作区；
   * 5. 在项目根写 `.gitignore`（排除 `build/`）并建空 `build/`；
   * 任一步失败：按**本次写入的路径清单逐条**删（回滚不留半成品项目）。
   * **不要调 `workspaces.remove(projectId)` 当回滚**：那是「连同目录全部内容删除」，
   * 会把用户在向导失败后已手动放进项目的东西一起删掉（工作区契约没有事务）。
   */
  create(input: PluginProjectCreateInput): Promise<PluginProject>;

  /** 改名（元数据）；清单字段一律在编辑器里改 `plugin.json`，不在这里双写 */
  update(projectId: string, patch: { readonly name?: string }): Promise<PluginProject>;
  /** 删除项目（连同项目目录；工作区模型本就不保留孤儿目录） */
  remove(projectId: string): Promise<void>;

  /**
   * 项目目录绝对路径（供壳层用现有项目打开链路打开；服务本身不 import 编辑器）。
   *
   * **必须先 `list()`**：内核 `WorkspaceService.projectDir()` 是同步方法，落在
   * **自选授权根**里的项目要靠 `id → 目录` 缓存解析，而缓存只由 `list()` 填充；
   * 未命中时它**回落默认根**——直接调会静默指向默认根下的同名 id（= 打开一个
   * 不存在的目录）。本服务保证内部先扫一遍再解析。
   */
  projectDir(projectId: string): Promise<string>;

  /**
   * 构建：校验 `plugin.json` → 按 `roots` 收集文件 → 算 sha256/size →
   * 生成 `pack.json` → 写确定性 ZIP 到 `build/` + `build/{buildId}.json`，
   * 并把 `PluginBuildSummary` 写回 `meta.lastBuild`（只存指针）。
   * **不写游戏目录、不执行项目内任何脚本**。
   */
  build(projectId: string, opts?: PluginBuildOptions): Promise<PluginBuildResult>;

  /**
   * 「构建并安装」的前半段：一次调用完成 build + `PluginManager.planInstall`，
   * 返回计划供 UI 展示。用户确认后再调 `plugins.applyInstall(plan.planId, …)`。
   * 一次调用内完成两步的理由：避免 UI 在 build 与 plan 之间文件被改动导致计划对不上。
   */
  planInstall(
    projectId: string,
    instanceId: string,
    opts?: PluginBuildOptions,
  ): Promise<PluginProjectInstallPlan>;

  /**
   * 把**已安装插件**提取为源码项目（字节级复制 `ownedFiles`，生成 `plugin.json`）。
   * 仅限当前实例 show 该插件声明的文件；无 `content/{pluginId}/payload` 时按目录重建。
   * 提取项目标记 `source='extracted'`，用于 UI 提示「这不是原作者项目」。
   */
  extract(instanceId: string, pluginId: string, opts?: PluginExtractOptions): Promise<PluginProject>;

  /**
   * 漂移检查：比较项目当前 `plugin.json` 版本 / 上次构建哈希 / 实例里已装版本。
   * 纯只读，UI 在打开项目、点「构建并安装」前调用。
   */
  inspectDrift(projectId: string, instanceId: string): Promise<PluginProjectDrift>;
}

export type PluginProjectSource = 'created' | 'extracted';

export interface PluginProjectMeta {
  readonly kind: 'game-plugin';
  readonly adapterId: string;
  readonly gameId: string;
  readonly gameVersion: string | null;
  /** 创建时的目标实例；项目本身可安装到同类实例，不绑定唯一实例 */
  readonly targetInstanceId: string | null;
  /** 上次构建摘要（指针；权威副本在 `build/{buildId}.json`） */
  readonly lastBuild: PluginBuildSummary | null;
  /** 上次「构建并安装」的目标；null = 尚未安装 */
  readonly installedTarget: PluginInstalledRef | null;
  /** 从已装插件提取时的来源；`source='created'` 时缺省 */
  readonly extractedFrom?: {
    readonly instanceId: string;
    readonly pluginId: string;
    readonly version: string;
    readonly at: string;
  };
}

export interface PluginProject {
  /** = `WorkspaceProject.id` */
  readonly projectId: string;
  readonly name: string;
  /** 工作区根绝对路径（仅展示，不作为写参数） */
  readonly rootDir: string;
  readonly projectDir: string;
  /** 持久化形态（`workspace.json` 里的 `meta`） */
  readonly meta: PluginProjectMeta;
  readonly source: PluginProjectSource;
  /** 首版恒一条；保留数组形态以支持日后「一个项目多个 addon 制品」 */
  readonly artifacts: readonly PluginProjectArtifact[];
  /** 投影自 `meta.lastBuild`（便利字段；两者不一致以构建报告为准） */
  readonly lastBuild: PluginBuildSummary | null;
  /** 投影自 `meta.installedTarget`；null = 尚未安装 */
  readonly installedTarget: PluginInstalledRef | null;
}

export interface PluginProjectArtifact {
  readonly artifactId: string;
  /** 制品目录名（单层；首版恒 `plugin`） */
  readonly dirName: string;
  /** 从 `plugin.json` 投影（打开项目时现读，不作为第二真源） */
  readonly pluginId: string;
  readonly version: string;
  readonly capabilities: readonly PluginCapability[];
  /** 恒为 `<dirName>/plugin.json` */
  readonly manifestPath: string;
}

export interface PluginInstalledRef {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly installedAt: string;
  /** 安装时使用的构建产物 sha256；用于漂移判定 */
  readonly buildSha256: string | null;
}

export interface PluginProjectCreateInput {
  /** 工作区项目名（显示用，可与 `displayName` 不同） */
  readonly name: string;
  /** 目标实例：用于带出 adapter / gameId / gameVersion；不写游戏目录 */
  readonly instanceId: string;
  /** 制品目录名；缺省 `plugin`（单层、不得含分隔符） */
  readonly artifactDirName?: string;
  readonly pluginId: string;
  readonly displayName: string;
  readonly version: string;
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly description?: string;
  readonly capabilities: readonly PluginCapability[];
  readonly saveImpact: 'none' | 'possible' | 'unknown';
  readonly loadOrder: number;
  readonly template: PluginTemplateId;
  /** 向导预置的根映射（至少一条）；创建后以 `plugin.json` 为准 */
  readonly roots: readonly PluginSourceRootMap[];
  /** 必须命中 `WorkspaceService.roots()`；缺省 = 默认根 */
  readonly workspaceRoot?: string;
}

export interface PluginBuildOptions {
  /** 覆盖本次产物版本（不改 `plugin.json`；缺省 = 清单版本） */
  readonly version?: string;
  /** 是否把 README / LICENSE 打进包；缺省 true */
  readonly includeDocs?: boolean;
  /** 额外排除的相对制品根 glob（如 `docs/**`、`*.bak`） */
  readonly exclude?: readonly string[];
}

export interface PluginBuildResult {
  readonly buildId: string;
  /** `build/{pluginId}-{version}.zip` 的绝对路径 */
  readonly zipPath: string;
  /** `build/{buildId}.json`（manifest / 哈希 / 警告 / 源文件清单摘要） */
  readonly reportPath: string;
  /** 产物清单（`pack.json` 的类型形态；UI 直接用它渲染安装预览） */
  readonly manifest: ContentPackManifest;
  readonly bytes: number;
  readonly sha256: string;
  /** 源指纹：`plugin.json` 规范化文本 + 全部映射文件 `(路径, size, mtimeMs)` 的摘要 */
  readonly sourceFingerprint: string;
  readonly warnings: readonly string[];
  readonly builtAt: string;
}

export interface PluginBuildSummary {
  readonly buildId: string;
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceFingerprint: string;
  readonly builtAt: string;
}

export interface PluginProjectInstallPlan {
  readonly build: PluginBuildResult;
  /** 直接交给 `PluginManager.applyInstall(plan.planId, …)` */
  readonly plan: PluginInstallPlan;
}

export interface PluginExtractOptions {
  readonly projectName?: string;
  /** 必须命中 `WorkspaceService.roots()`；缺省 = 默认根 */
  readonly workspaceRoot?: string;
}

/** 项目 / 构建 / 已装版本三者的一致性（只读，UI 据此提示「需重建」） */
export interface PluginProjectDrift {
  readonly state: 'in-sync' | 'source-changed' | 'installed-differs' | 'not-installed';
  readonly sourceVersion: string;
  readonly lastBuildVersion: string | null;
  readonly installedVersion: string | null;
  readonly reasons: readonly string[];
}
```

### 6.9 `SaveManager`

```ts
export interface SaveManager {
  list(instanceId: string): Promise<readonly SaveEntry[]>;
  backups(instanceId: string): Promise<readonly SaveBackup[]>;

  backup(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask>;
  restore(instanceId: string, backupId: string, opts?: RestoreOptions): Promise<LauncherTask>;
  removeBackup(instanceId: string, backupId: string): Promise<void>;

  /** 导入前先预检冲突（同名存档）；返回 planId */
  planImport(instanceId: string, archivePath: string): Promise<SaveImportPlan>;
  applyImport(planId: string, resolutions?: readonly ConflictResolution[]): Promise<LauncherTask>;

  /** 原生保存对话框；返回落点或 null。写盘与对话框同命令 */
  exportArchive(instanceId: string, req: SaveExportRequest): Promise<string | null>;
}

export interface SaveEntry {
  readonly path: string;               // 相对对应 saveRoot
  readonly rootId: string;
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface SaveBackup {
  readonly id: string;
  readonly instanceId: string;
  readonly createdAt: string;
  readonly label: string;
  readonly bytes: number;
  readonly entryCount: number;
  readonly reason: 'manual' | 'pre-restore' | 'pre-plugin' | 'auto';
}

export interface SaveBackupRequest {
  readonly label?: string;
  /** 备份来源；默认 'manual'。'pre-restore' / 'pre-plugin' 由启动器内部调用时写入 */
  readonly reason?: SaveBackup['reason'];
  /** 空 = 备份全部 saveRoots */
  readonly entries?: readonly { rootId: string; path: string }[];
}

export interface RestoreOptions {
  /** 恢复前自动再备份当前存档，默认 true */
  readonly backupCurrent?: boolean;
}

export interface SaveImportPlan {
  readonly planId: string;
  readonly backupId: string;           // 导入包解析后的内部备份
  readonly overwrites: readonly string[];
  readonly warnings: readonly string[];
}
```

### 6.10 `LogService`

```ts
export interface LogService {
  /** 当前/指定会话的尾部；默认最近 500 行、最多 1 MiB 文本 */
  tail(instanceId: string, opts?: LogQuery): Promise<LogPage>;
  sessions(instanceId: string): Promise<readonly LogSession[]>;
  read(sessionId: string, opts?: LogQuery): Promise<LogPage>;

  /** 实时行流；内部已做解码、节流、环形丢弃，不让 UI 收原始字节 */
  subscribe(instanceId: string, listener: (line: LogLine) => void): Unsubscribe;

  /** 诊断包：原生保存对话框；内容含日志、退出记录、实例概况、内容清单，默认脱敏用户名路径 */
  exportBundle(instanceId: string, sessionId?: string): Promise<string | null>;
}

export interface LogQuery {
  readonly sessionId?: string;
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly stream?: 'stdout' | 'stderr' | 'all';
  readonly errorsOnly?: boolean;
}

export interface LogPage {
  readonly session: LogSession;
  readonly lines: readonly LogLine[];
  readonly truncated: boolean;
}
```

### 6.11 `TaskCenter`

```ts
export interface TaskCenter {
  list(): readonly LauncherTask[];
  get(id: string): LauncherTask | null;
  cancel(id: string): Promise<void>;
  subscribe(listener: (task: LauncherTask) => void): Unsubscribe;
}
```

### 6.12 `LauncherUpdateService`（P2）

```ts
export interface LauncherUpdateService {
  check(instanceId: string): Promise<UpdateCheckResult>;
  apply(planId: string): Promise<LauncherTask>;

  /** 校验：对比基线清单 / 来源根 / 内容包 payload */
  verify(instanceId: string): Promise<VerifyReport>;
  repair(planId: string): Promise<LauncherTask>;
}

export interface UpdateCheckResult {
  readonly instanceId: string;
  readonly available: readonly {
    readonly kind: 'runtime' | 'content';
    readonly id: string;
    readonly current: string;
    readonly latest: string;
    readonly notes?: string;
  }[];
}

export interface VerifyReport {
  readonly instanceId: string;
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];
  readonly repairable: boolean;
}
```

---

## 7. Rust 宿主命令契约

### 7.1 命名与返回约定

- 命令名：`launcher_<domain>_<verb>`，snake_case；参数与返回 DTO 一律 camelCase（与现有宿主一致）。
- 返回：`Result<T, LauncherErrorDto>`；`LauncherErrorDto` 形状与 §5.6 相同。
- **没有任何命令接受「目标路径」来做越界写**；所有写落点由宿主按实例根/暂存根/对话框自己拼。
  **唯一例外**是插件项目构建的摘要命令（§7.2 尾部）：它接受 `projectDir`，但该目录必须在宿主
  已登记的写允许域（appData / 已授权工作区根）内，且只读不算写。ZIP 由 TS 侧
  `zip.ts::buildZip` 在 `{projectDir}/build/` 内生成（走内核 io 写闸），**不新增宿主打包命令**。
- 事件名以 `kojo:` 前缀（与现有搜索/拖放事件同族），载荷带 `seq` 供 UI 去重。

### 7.2 命令表

| 命令 | 入参 | 返回 | 阶段 | 关键守卫 |
|---|---|---|---|---|
| `launcher_pick_source_root` | `{ title? }` | `string \| null` | P0 | 原生目录对话框；确认后把该根写入「来源根批准表」 |
| `launcher_instance_list` | — | `LauncherInstance[]` | P0 | 只读注册表 |
| `launcher_instance_get` | `{ instanceId }` | `InstanceInspection` | P0 | 路径现算 |
| `launcher_instance_create` | `{ request, profile }` | `InstanceCreation` | P0 | 来源根已批准；exe 相对路径在根内；copy 入任务队列（`profile` 由 TS 侧 `buildProfile` 产出，宿主不认识 adapter） |
| `launcher_instance_update` | `{ instanceId, patch }` | `LauncherInstance` | P0 | 不允许 patch 改 `sourceRoot`/`id`/`isolation` |
| `launcher_instance_remove` | `{ instanceId, deleteFiles, keepBackups? }` | `void` | P0 | 先停进程；删除只在实例根内 |
| `launcher_instance_duplicate` | `{ instanceId, name? }` | `InstanceCreation` | P1 | 目标名只影响显示，不参与路径 |
| `launcher_instance_open_folder` | `{ instanceId, which }` | `void` | P0 | `which` 枚举，不允许任意子路径 |
| `launcher_trust_executable` | `{ instanceId }` | `ExecutableTrust` | P0 | 宿主算哈希 + **原生确认框**；JS 不传哈希 |
| `launcher_start` | `{ instanceId }` | `ProcessStatus` | P0 | 实例 ready、信任匹配、运行时解析、每实例锁 |
| `launcher_stop` | `{ instanceId, force?, timeoutMs? }` | `ProcessStatus` | P0 | 只停已登记进程 |
| `launcher_process_status` | `{ instanceId }` | `ProcessStatus` | P0 | — |
| `launcher_process_list` | — | `ProcessStatus[]` | P0 | — |
| `launcher_runtime_list` | — | `RuntimeRef[]` | P1 | — |
| `launcher_runtime_scan` | `{ rootDir }` | `RuntimeRef[]` | P1 | 只读扫描；不登记 |
| `launcher_runtime_import` | — | `RuntimeRef \| null` | P1 | 原生目录对话框 + 同命令登记 |
| `launcher_runtime_verify` | `{ runtimeId }` | `RuntimeVerification` | P1 | 只读哈希 |
| `launcher_runtime_remove` | `{ runtimeId }` | `void` | P1 | 只删托管运行时根 |
| `launcher_content_list` | `{ instanceId }` | `InstalledContent[]` | P1 | — |
| `launcher_content_plan` | `{ instanceId, archivePath, opts? }`（`opts.limits?` = 三枚限额，宿主按共享表夹顶） | `ContentInstallPlan` | P1 | ZIP 四重守卫；解到实例暂存；不写实例 |
| `launcher_content_apply` | `{ planId, resolutions? }` | `LauncherTask` | P1 | 计划未过期；每实例单飞；全程可回滚 |
| `launcher_content_uninstall` | `{ instanceId, packId, files? }`（`files` 只作**筛选**，ownership 仍是权威） | `LauncherTask` | P1 | 只删本包 ownership 记录的文件 |
| `launcher_content_set_enabled` | `{ instanceId, packId, enabled }` | `LauncherTask` | P1 | 先停游戏；应用/撤下同一事务 |
| `launcher_content_set_order` | `{ instanceId, packIds }` | `void` | P1 | 只接受已安装 id 的排列 |
| `launcher_content_diagnose` | `{ instanceId }` | `ContentDiagnosis` | P1 | 只读 |
| `launcher_pick_write_root` | `{ instanceId, rootId }` | `string \| null` | P1 | 原生目录对话框 + **同命令登记** shared 写授权（存档 / 内容 / 插件共用） |
| `launcher_pick_archive` | `{ title? }` | `string \| null` | P1 | 原生文件对话框；只选不读不写 |
| `launcher_project_hash` | `{ projectDir, artifactDir, entries }` | `FileDigest[]` | P1 | `projectDir` 在宿主写允许域内；条目解析后不得逃逸 `artifactDir`；流式哈希（大二进制不整包读进 JS） |
| `launcher_save_list` | `{ instanceId }` | `HostSaveListing`（`entries + roots{approved} + warnings?`） | P1 | 只读 saveRoots；逐根授权读数供 shared 写回门禁 |
| `launcher_save_backups` | `{ instanceId }` | `SaveBackup[]` | P1 | — |
| `launcher_save_backup` | `{ instanceId, req }` | `LauncherTask` | P1 | 写只落在实例备份目录 |
| `launcher_save_restore` | `{ instanceId, backupId, opts? }` | `LauncherTask` | P1 | 先自动备份当前；shared 需目录授权 |
| `launcher_save_delete_backup` | `{ instanceId, backupId }` | `void` | P1 | 只删实例备份目录内文件 |
| `launcher_save_import` | `{ instanceId, archivePath }` | `HostSaveImportPlan`（增补 `entryCount/totalBytes/expiresAt`） | P1 | ZIP 守卫；先解到暂存并预检 |
| `launcher_save_apply_import` | `{ planId, resolutions? }` | `LauncherTask` | P1 | 同 restore 守卫 |
| `launcher_save_export` | `{ instanceId, req }` | `string \| null` | P1 | 原生保存对话框 + 写盘同命令 |
| `launcher_log_tail` | `{ instanceId, query? }` | `HostLogPage`（原始块，见 §7.4） | P0 | 读实例日志目录；上限截断 |
| `launcher_log_sessions` | `{ instanceId }` | `LogSession[]` | P0 | — |
| `launcher_log_read` | `{ sessionId, query? }` | `HostLogPage`（原始块，见 §7.4） | P0 | sessionId 必须属于某实例 |
| `launcher_log_export` | `{ instanceId, sessionId?, includeDiagnostics? }` | `string \| null` | P1 | 原生保存对话框；路径脱敏 |
| `launcher_task_list` | — | `LauncherTask[]` | P0 | — |
| `launcher_task_cancel` | `{ taskId }` | `void` | P0 | 只取消可取消任务；回滚由任务自己完成 |
| `launcher_verify` | `{ instanceId }` | `VerifyReport` | P2 | 只读 |
| `launcher_update_check` | `{ instanceId }` | `UpdateCheckResult` | P2 | 只读 |
| `launcher_update_apply` | `{ planId }` | `LauncherTask` | P2 | 下载闸 + 哈希 |
| `launcher_repair` | `{ planId }` | `LauncherTask` | P2 | 只写实例根 |
| `launcher_bundle_import` | `{ archivePath }` | `InstanceCreation` | P2 | ZIP 守卫 + 清单校验 |
| `launcher_bundle_export` | `{ instanceId, opts? }` | `string \| null` | P2 | 保存对话框 + 流式 ZIP |

**游戏插件复用同一组宿主命令**：`launcher_content_plan / apply / uninstall / set_enabled /
set_order / diagnose` 的载荷里没有「插件」这个语义——宿主只认 `archivePath`、`planId`、
`packId` 与文件清单。`launcher_content_plan` 只产出**文件级**计划；`PluginManager` 在其上叠加
能力解析、版本兼容、函数级冲突、风险分级与存档备份门禁，得到 `PluginInstallPlan`。
函数级结构由 adapter 的 `analyzeFunctions` 回调提供（adapter 经 `erb.parser` 服务键或库包取
`ErbIndex`，见 §6.1；**壳层 tree-sitter 不可 import**），
**宿主不新增任何插件命令，也不认识 ERB/CSV**。
这样「内容包」与「插件」在特权面上是同一个动作：把已知清单的文件写进已授权的根。

**项目构建的宿主命令同样不认识插件语义**：`launcher_project_hash` 只按给定相对路径流式算摘要；
`plugin.json` / `pack.json` 的校验、`roots` 映射、`buildId` 与报告全部在
`PluginProjectService`（TS），ZIP 由 `zip.ts::buildZip` 输出。宿主只回答「这批字节的哈希是多少」，
**不做任何插件判断**。

> **为什么不再要 `launcher_project_pack`**：确定性打包在 TS 侧早已存在且在被生产消费
> （`zip.ts::buildZip`，`mtimeMs` 恒固定、DOS 时间 1980 起算、同内容两次逐字节相同；
> 消费方 `kojo-project-kit/src/package-actions.ts`，并由 `zip-roundtrip.test.ts` 对拍
> golden 容器）。同样的字节在两种语言里各写一份打包器 = 迟早漂，`market.rs` 那段
> 「表漂一字节必有一边红」的注释讲的正是这件事。只有**流式摘要**必须留在宿主
> （大二进制资源不整包读进 JS）。若将来实测证明确需宿主打包（大包内存峰值），
> 那也必须吃 `fixtures/zip-roundtrip/contract.json` 同一张表，并单独立 ADR 记下理由。

### 7.3 事件表

| 事件 | 载荷 | 频率 | 说明 |
|---|---|---|---|
| `kojo:launcher-process` | `{ instanceId, status, seq }` | 状态变化时 | 启动/运行/停止/退出/崩溃 |
| `kojo:launcher-log` | `{ instanceId, sessionId, stream, seq, bytesBase64 }` | 宿主节流（≥64 KiB 或 ≥100 ms） | **原始字节**过 IPC，解码在 TS 侧（复用现有编码探测单源） |
| `kojo:launcher-task` | `{ task, seq }` | 进度节流（≥100 ms） | 任务创建/进度/终态 |
| `kojo:launcher-instance` | `{ kind, instanceId, seq }` | 变更时 | 实例增删改（UI 局部刷新，不整表重拉） |
| `kojo:launcher-activate` | `{ instanceId }` | 用户点击通知/托盘时 | 可选：P2 托盘/文件关联唤起 |

载荷的 TS 形状**只住一处**：`packages/plugin-api/src/launcher.ts` 的 `LauncherProcessEvent` /
`LauncherLogEvent` / `LauncherTaskEvent` / `LauncherInstanceEvent`（上表是同一形状的文字版，
字段漂移由契约测试 `launcher-contract.test.ts` 钉住）。`seq` 由宿主**严格递增**，消费方按它
丢弃乱序与重复；断线重连后宿主从当前值继续，**不从 0 重来**。

### 7.4 宿主桥（TS 侧形状）

`plugin-api` 同时导出 `LauncherHostBridge` —— 内核 `kernel.launcher`（零逻辑透传）与
桌面壳平台桥（`PlatformBridge.launcher?`）实现的就是这一个接口。两条硬约束写进类型而不是注释：

- `launcher_instance_create` 是 **`{ request, profile }` 两格**：宿主不认识 adapter、编译不出
  `LaunchProfile`，所以 exe 相对路径 / argv / 存档根由 TS 侧的 `buildProfile` 产出后随请求传下去；
- 日志命令返回 `HostLogPage`（`chunks[].bytesBase64` **原始字节**），不是解码后的 `LogPage`——
  §12.1 的解码单源在 TS 侧，宿主再解一遍就是第二套探测。


---

## 8. 进程状态机

### 8.1 状态与迁移

```
                 ┌──────────────────────────────┐
                 │            idle              │
                 └──────────────┬───────────────┘
        start（校验通过）        │
                 ┌──────────────▼───────────────┐
                 │          starting            │
                 └──────┬───────────────┬───────┘
        进程创建成功      │               │ 创建失败/信任失效
                 ┌──────▼───────────────┐ │
                 │        running       │ │
                 └───┬──────────┬───────┘ │
        用户 stop    │          │ 非预期退出 │
                 ┌───▼──────┐  ┌▼─────────┐│
                 │ stopping │  │ crashed  ││
                 └───┬──────┘  └────┬─────┘│
        优雅/强杀   │              │       │
                 ┌───▼──────────────▼───────▼─┐
                 │          exited            │
                 └──────────────┬─────────────┘
                                │ start（再次）
                                └────────────▶ starting
```

| 当前 | 事件 | 下一状态 | 宿主动作 |
|---|---|---|---|
| `idle` | `start` 校验通过 | `starting` | 加每实例锁；`CreateProcessW(CREATE_SUSPENDED)` |
| `starting` | 已分配 Job Object + `ResumeThread` | `running` | 发状态事件；开始日志泵 |
| `starting` | exe 不存在 / 信任不匹配 / 运行时缺失 | `idle` | 释放锁；返回 `LauncherError`（不产生假 `exited`） |
| `running` | 用户 `stop` | `stopping` | 先 `WM_CLOSE`（超时后 `TerminateJobObject`） |
| `running` | 进程退出码 0 | `exited` | 释放锁；写 `ExitRecord(reason='clean')` |
| `running` | 进程退出码非 0 | `crashed` | 释放锁；写 `ExitRecord(reason='crash')`；发崩溃摘要 |
| `running` | 应用退出 | `exited` | Job 句柄关闭 → 整棵树被杀；`reason='app-exit'` |
| `stopping` | 进程退出 | `exited` | `reason='user'`（force=true 则 `'killed'`） |
| `exited` / `crashed` | `start` | `starting` | 允许；`launchCount++` |

### 8.2 铁律

1. **每实例单进程**：内存 `Mutex<HashMap<InstanceId, Running>>` + 实例目录内 `running.lock`（PID + 启动时间）双保险；
   应用启动时发现陈旧锁（PID 不存在 / 启动时间不符）→ 标记上次 `unknown` 并清理。
2. **杀进程树**：Windows 用 Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
   **必须** `CREATE_SUSPENDED` → `AssignProcessToJobObject` → `ResumeThread`，否则子进程可能在被加入 Job 前就派生孙进程。
3. **不做 shell**：`Command` 语义 = argv 数组；不拼命令行字符串，不经过 `cmd.exe` / PowerShell。
4. **退出码分类**：`0` = clean；非 0 且非用户停止 = crash；Windows NTSTATUS（如 `0xC0000005`）额外解码为中文提示。
5. **崩溃可见**：`crashed` 必须带 `sessionId`、退出码、最后 N 行 stderr（N 由契约常量定）；
   UI 首屏显示「查看日志 / 导出诊断包 / 重新启动」，不静默吞掉。
6. **停止有上限**：优雅期默认 5 s（契约常量），超时无条件杀树；停止命令本身不能让 UI 永久转圈。
7. **应用退出即收尸**：`RunEvent::Exit` 关闭所有 Job 句柄；不依赖游戏自己退出。

---

## 9. 实例隔离与磁盘布局

### 9.1 三档隔离

| 模式 | 磁盘成本 | 游戏根 | 宿主写 | 游戏写 | 内容包 / 游戏插件 | 存档恢复 | 首版 |
|---|---|---|---|---|---|---|---|
| `shared` | ~0 | 用户原始目录 | ✅ 仅授权根内 | 原目录 | ✅ **需显式目录授权** | ✅ 需授权 | ✅ |
| `copy` | ≈ 游戏目录大小 | `instances/{id}/game/` | ✅ 实例根内 | 实例根内 | ✅ | ✅ | ✅ |
| `overlay` | 小（仅可写层） | 合并视图 | 有限 | 可写层 | ✅ | ✅ | ❌ P2 |

**默认策略**：
- 首次「添加游戏」默认 `shared`（零复制，先能玩）；
- 用户点「创建隔离实例」才走 `copy`；
- 任何写回游戏目录的操作都在 UI 上明确标注「会改到原目录」，并要求用户确认。

**shared 写授权（内容包 / 游戏插件 / 存档恢复共用同一条链）**：
- 授权粒度 = **实例 × 根 id**（`rootId` 来自 adapter 的 `ContentRootSpec` / `SaveRootSpec`），
  不按单个文件、也不给「整个游戏目录可写」的总开关；
- 授权只由原生目录对话框写入 `approvals.json`（`launcher_pick_write_root` 在同一命令内登记），
  用户可在实例设置里逐条撤销；
- 每次安装/恢复前仍复验：目标路径规范化后必须落在**已授权的那个根**内，否则
  `LAUNCHER_SOURCE_NOT_APPROVED`；
- 授权不因一次成功而扩大范围：新增一个 contentRoot 就要再批一次。

**与编辑器 `writablePaths` 的关系**：两张授权表**相互独立、互不继承**。启动器安装插件/恢复存档
只把授权记进 `launcher/approvals.json`，**不会**把游戏根加进内核的 `writablePaths`；编辑器仍然
只能写用户显式设为可写的路径。反过来，编辑器可写某个口上目录，也不等于启动器可写整个游戏根。
两条链唯一的共同点是同一个哲学：**对话框即授权，授权绑命令，JS 不拿落点决定权**。

**这是宿主里的第三条特权写路径，评审要按第三枚举对待**（现状两条：内核 io 的 `assertWritable`
闸、`exportFile` 的对话框即授权）。v0.4 补两条实测事实，避免把它想得比实际更危险或更安全：

- **不会读到旧文本**：内核 io 的会话文本缓存是**自校验**的（`kernel/src/io.ts` 每次读都比
  `mtime + size`），启动器绕过内核 io 直写游戏目录，编辑器下一次读到的仍是盘上真相。
- **编辑器的重载会被自然触发**：`fileWatch.start()` 的根集合含 **`project.rootDir` 整棵**
  （`use-project-session.ts`），不是只监视口上目录——安装写的每个文件都会产生 `file.changed`。
  因此 §10.1 第 [9] 步**不要**自己逐文件再发一遍（几百条会把 UI 打满），只发一条聚合的
  「计划已应用」；单文件事实交给 watcher。
- **挡不住的只剩脏缓冲**：watcher 只能说「盘上变了」，拦不住用户对旧缓冲按 Ctrl+S 把插件改动
  写回去——这条从风险 #17 提到 P1（见 §16）。

### 9.2 磁盘布局

```
{appData}/launcher/
├── registry.json                  # 实例索引（派生缓存，可由实例目录重建；L3a 落地名）
├── registry.json.bak              # 原子写备份
├── approvals.json                 # 来源根批准表 + shared 写授权（只由原生对话框写入）
├── trash/{timestamp}/             # 删实例时 keepBackups 的落点（§9.3）
├── runtime/
│   └── {runtimeId}/
│       ├── runtime.json
│       └── payload/...
└── instances/
    └── {instanceId}/
        ├── instance.json          # 权威清单（含 schemaVersion）
        ├── instance.json.bak
        ├── running.lock           # 运行中：PID + 启动时间；异常退出后清理
        ├── game/                  # 仅 copy；shared 无此目录
        ├── content/               # 内容包 + 游戏插件安装区（同一命名空间，kind 见 pack.json）
        │   └── {packId}/
        │       ├── pack.json      # 安装时的 manifest 快照
        │       ├── payload/...    # 解压后的原始内容
        │       ├── ownership.json # 本包写入 game/ 的文件清单 + 哈希
        │       ├── functions.json # 函数级索引（仅插件且 adapter 提供 analyzeFunctions；可重算）
        │       └── state.json     # enabled / order / installedAt / risk
        ├── backups/
        │   ├── saves/{backupId}.zip
        │   └── packs/{packId}/
        │       ├── original/...              # 首次安装前的基础文件快照（升级不得覆盖）
        │       └── {timestamp}/...           # 本次安装/升级的当次快照（失败回滚用）
        ├── logs/
        │   ├── {sessionId}.stdout.log
        │   ├── {sessionId}.stderr.log
        │   └── {sessionId}.json   # 退出码、时长、exe 哈希、实例快照
        └── staging/               # 解压/导入暂存；启动时清理过期项
```

> **插件源码项目不在 `{appData}/launcher/` 下**：它是工作区项目
> （`{workspaceRoot}/{projectId}/`，默认根在 appData 工作区，或用户经目录对话框授权的位置根）。
> `launcher/` 只保存**实例侧已装产物**与备份。这条分离保证「删实例 / 清缓存 / 卸载插件」
> 永远不会碰作者源码。

### 9.3 路径规则

- 实例目录名 = 宿主 UUID，**绝不用用户输入拼路径**（重名、中文、表情、`..` 全部无效化）。
- `instance.json` 里的所有内部路径都是 posix 相对路径；宿主拼绝对路径后必须做「规范化 + 前缀包含」校验。
- `sourceRoot` 只由原生目录对话框登记；**UNC / 网络盘默认拒绝**（远程 exe 启动是另一类风险），
  用户显式勾选后才进批准表。
- 删除实例：先停进程 → 删实例目录 → 从索引移除；`keepBackups=true` 时把备份移到
  `{appData}/launcher/trash/{timestamp}/` 再删，避免误删后悔。

### 9.4 复制算法

- 按目录流式复制，显示 `bytes` 进度；
- 默认跳过 adapter `copyExclude` + 通用 `logs/`、`staging/`、`*.log`；
- `includeSaves=false`（默认）时跳过 `saveRoots`，新实例从干净存档开始；
- 复制完成后计算**基线清单**（文件数/总字节/关键文件哈希），写入 `instance.json`；
- 复制失败/取消：删掉整个 `instances/{id}/`，不留半成品实例。

### 9.5 迁移

- `schemaVersion` 不匹配：
  - 低版本 → 先备份 `instance.json`，按迁移函数逐版升级；
  - 高版本（用户降级应用）→ 实例标 `broken`，**只读**，提示「请升级应用」；
- 迁移失败：保留备份与实例目录，标 `broken`，不静默删数据。

---

## 10. 内容包与游戏插件生命周期

> 两者共用一条流水线；差异集中在「插件多出的门禁」。下面的流程用 `PluginManager` 口径写，
> 内容包路径只是跳过 `[4]` 的插件项与 `[6]` 的存档备份。
>
> 安装的上游还有**作者侧闭环**（§10.5）：项目创建 → 编辑器修改 → 确定性构建 → 构建并安装。
> 构建只产出 ZIP；它**不绕过**这里的任何一道门禁。

### 10.1 安装流程（两阶段，先计划后应用）

```
选包（原生对话框 / 拖放 / **插件项目构建产物**）
        │
        ▼
[0] 读 pack.json 判定 kind：
    kind='plugin' → PluginManager；其余 → ContentManager
        │
        ▼
[1] 解到 instances/{id}/staging/{planId}/ ← ZIP 四重守卫
    （构建产物同样从这里进，**没有**从 build/ 直写实例的旁路）
        │
        ▼
[2] 校验 schema / gameId / 路径 / 文件哈希 / 目标根 accepts / shared 写授权
        │
        ▼
[3] 与 ownership.json + 现有文件对比 → additions / overwrites / conflicts
        │
        ▼
[4] 插件额外门禁：
      能力声明 → 风险分级
      adapter.isCompatible → 版本兼容
      adapter.analyzeFunctions → 函数级冲突
      清单 / adapter → 存档影响
        │
        ▼
[5] 返回 PluginInstallPlan / ContentInstallPlan（只读，不碰 game/）
        │
   用户确认（文件清单、风险等级、函数冲突、存档影响、重启要求）
        │
        ▼
[6] 插件且 saveImpact != 'none'：先备份存档（reason='pre-plugin'）
        │
        ▼
[7] 备份将被覆盖的文件：
      首次安装写 backups/packs/{packId}/original/（已存在则不动，保证卸载能回到最初）
      本次操作写 backups/packs/{packId}/{timestamp}/（失败回滚用）
        │
        ▼
[8] 按 loadOrder 应用文件（写临时 + rename）
        │
        ▼
[9] 写 ownership.json / functions.json / state.json → 更新索引 → 发事件
        │
   任一步失败
        ▼
[10] 逆序回滚已应用文件 + 恢复备份 + 删暂存 → 任务 failed
```

**关键不变量**：
- `planInstall` 与 `applyInstall` 之间不持有实例锁；`applyInstall` 开始时重新校验 plan 未过期、实例未变、文件哈希未变、同 id 已装版本未变。
- `applyInstall` 每实例**单飞**；同一实例同时只允许一个内容/插件变更任务。
- 回滚必须逐文件核对哈希后再删/恢复，不能「整目录删掉」——那会连带删掉用户后来放进去的文件。
- 安装插件前**必须停游戏**；`requiresRestart=true` 的插件装/卸/启停后，UI 必须显著提示
  「需重启游戏生效」，并在实例卡片上保留该状态直到下次启动。
- 计划里展示的「将覆盖 N 个基础文件 / 将覆盖 M 个函数」与实际应用时必须逐条对得上；
  数量变了即视为计划失效，重新走预检。

### 10.2 冲突策略

| 情况 | 默认 | 可选 |
|---|---|---|
| 目标文件是基础游戏文件，未被任何包拥有 | 内容包：**abort**；插件：**提示 + 确认 + 先备份 + 覆盖** | 内容包可显式 `overwrite`；插件必须逐条确认，不能「全部同意」一把梭 |
| 目标文件属于另一个已安装包 | **abort** | `replace`（转移该文件的拥有权）或 `skip` |
| 两个包声明同一 id | **abort** | 升级安装（版本更高时替换） |
| 依赖缺失（`requires`） | **abort**（`LAUNCHER_PLUGIN_DEPENDENCY`） | 无（首版不自动下载依赖） |
| 包声明 `conflicts` 命中 | **abort**（`LAUNCHER_PLUGIN_DEPENDENCY`） | 用户卸载冲突包后重试 |
| **函数级冲突**：插件新增/叠加文件里定义了基础文件或别的插件已有的同名函数（按归一化名判，大小写不敏感） | **abort**；但命中 adapter `conventionPolicy` 承认的有意重复时不计入 | `skip`（保留既有定义）/ `replace`（先备份旧定义所在文件，再覆盖） |
| **版本不兼容**：`gameVersion` / `apiVersion` 判定失败 | **abort** | 「强制安装」需显式勾选，插件标 `incompatible`，每次启动前警告 |
| **存档影响未确认**：`saveImpact != 'none'` 且用户未确认 | **abort** | 确认并成功备份存档后继续 |
| **shared 目标根未授权** | **abort**（`LAUNCHER_SOURCE_NOT_APPROVED`） | 走原生目录对话框授权后重试 |

> 为什么插件的基础文件覆盖默认不再是 `abort`：插件的主要用途就是**改逻辑**。
> 一律 abort 等于把核心场景堵死，用户只会去手工复制文件——那比走安装计划更危险
> （没有清单、没有备份、没有回滚）。所以默认改为「充分展示 + 显式确认 + 先备份 + 可回滚」，
> 风险用信息与可逆性管理，而不是用禁止管理。

### 10.3 启停与卸载

- `setEnabled(false)`：按 `ownership.json` 把本包写入的文件撤下，**恢复 `original/` 里的基础文件快照**
  （不是最近一次操作的快照——升级过的插件卸载后也要回到最初状态），
  `state.enabled=false`；`setEnabled(true)` 反向重放 apply。
- **启用 / 调整顺序前必须重跑冲突检查**：装的时候不冲突，不代表启用后还不冲突
  （两个插件可能各自新增同名函数，只有同时启用才撞）。命中未决议冲突 ⇒
  `LAUNCHER_PLUGIN_CONFLICT`，不静默启用。
- 卸载：撤下文件（恢复 `original/`）→ 删 `content/{packId}/` → 清 `backups/packs/{packId}/original/`
  （下次安装重新取快照，避免旧快照盖掉用户后来对基础文件的修改）→ 更新索引；
  若用户改过包内文件（哈希不匹配），先提示「保留改动 / 恢复原样 / 取消」，不静默覆盖用户改动。
- 任何启停/卸载前**必须停游戏**；运行中调用返回 `LAUNCHER_INSTANCE_BUSY`。
- 插件卸载后，存档可能仍引用插件写入的数据（角色、物品、事件标记）。启动器**不删存档**，
  只在卸载结果里给出「该插件声明过存档影响，旧存档可能无法在无插件环境读取」的提示，
  并保留一份 `pre-plugin` 备份供回退。

### 10.4 游戏插件专有门禁

插件不是「另一种内容包」，它多了五道必须显式通过的闸：

| 门禁 | 判定 | 不通过时 |
|---|---|---|
| **能力 / 风险** | 清单 `capabilities` + 实际落点 → `PluginRisk` | `unknown` 按最高风险展示，必须逐项确认；声明与实际落点不一致（如只声明 `add-content` 却覆盖基础文件）⇒ **按实际升风险** 并记 warning，不信任声明 |
| **版本兼容** | `adapter.pluginRules.isCompatible` 优先；否则比对清单声明 | `LAUNCHER_PLUGIN_INCOMPATIBLE`；强制安装需显式勾选 |
| **函数级冲突** | `adapter.analyzeFunctions` 产出的**归一化名** + 定义位置，与基础文件/已装插件比对；「有意重复」按 adapter 的 `conventionPolicy` 收敛（与 `erb.duplicate-function` 同一判据） | `LAUNCHER_PLUGIN_CONFLICT`；`skip` / `replace` 逐条决议 |
| **存档影响** | 清单 `saveImpact`，缺省取 `pluginRules.saveImpact` | `LAUNCHER_PLUGIN_SAVE_RISK`；确认后自动备份存档 |
| **重启要求** | `pluginRules.requiresRestart` 或清单声明 | 装/卸/启停后置「待重启」状态，启动前提示 |

**函数冲突与文件冲突不重复计**：若插件整体覆盖了定义该函数的基础文件，按**文件冲突**处理
（用户已经决定替换整份文件），不再重复报函数冲突；函数级冲突只针对「新增/叠加文件里
重新定义了一个已有函数」的情况。

**游戏如何发现插件（首版的诚实边界）**：只支持「游戏自己按目录/文件名扫描」的加载方式，
由 adapter 的 `orderSource` + `entrypoints` 表达。若某游戏必须改注册表文件 / 配置行才能启用插件，
adapter 应不提供 `pluginRules`（或显式声明不支持），启动器显示「该游戏暂不支持插件安装」。
**不支持就说不支持，不假装装完能用**——这比装完进游戏发现没生效要好。

**信任链（分级）**：
- 首版：安装只接受**本地 ZIP**（原生对话框选择），不做静默下载安装；展示发布者、来源、
  文件清单与风险等级，`trust.state='unverified'` 如实显示；
- P2：包签名 + 发布者公钥信任库；验签通过才允许「自动更新」，否则每次更新都重新确认；
- **永不**因为「来源看起来像官方」而跳过确认；来源域名与签名是证据，不是授权。

**明确不做**：进程注入、DLL hook、内存修改、运行中热替换。插件只能通过游戏自身的
加载机制（脚本/数据/资源）生效；这既是安全边界，也是可回滚性的前提——改的是磁盘文件，
不是运行中的进程。

### 10.5 插件项目：创建、编辑、构建、安装

> 这一节补的是**作者侧闭环**：没有它，插件功能只能消费别人做好的 ZIP，作者想改一行逻辑
> 就得离开编辑器手工拼目录、手算哈希。闭环为：
> **创建向导 → 在编辑器里改源码 → 确定性构建 → 构建并安装（仍走两道确认）→ 从已装插件提取反哺**。
>
> **两条不变量**（先立在这里，下面所有步骤都受它约束）：
> 1. 项目只写**工作区根**（内核常驻可写根）与项目自己的 `build/`；**永远不直接写游戏目录**——
>    装配到实例只有 `PluginManager.planInstall → applyInstall` 一条路；
> 2. 源（`plugin.json`，无哈希）与产物（`pack.json` + ZIP，有哈希）**分离**；哈希只在构建时算，
>    作者手写的清单里出现哈希即非法。

#### 10.5.1 模型与目录

插件项目 = **工作区项目**（`WorkspaceProject`，`meta.kind = 'game-plugin'`）；
插件本体 = 项目内的**一个制品**（`WorkspaceArtifact`，首版 `dirName = 'plugin'`）。
不另造项目存储：工作区的「项目 → 制品 → 文件」模型、常驻写授权、`workspace.json` 持久化全部复用。

```text
{workspaceRoot}/{projectId}/
├── workspace.json              # 内核工作区清单（meta 里存插件项目索引：adapterId / gameId /
│                               #   lastBuild / installedTarget / extractedFrom）
├── .gitignore                  # 排除 build/
├── plugin/                     # 制品：作者可编辑的源
│   ├── plugin.json             # 作者源清单（唯一真源；无 files[] / 无哈希）
│   ├── src/…                   # 脚本源码（扩展名由 adapter 的游戏规则决定）
│   ├── assets/…                # 资源（二进制）
│   └── README.md
└── build/                      # 构建产物：不进版本控制、不参与下次构建
    ├── {pluginId}-{version}.zip
    └── {buildId}.json          # 构建报告（pack.json 内容 + 哈希 + 警告 + 逐文件摘要）
```

- **`build/` 放在项目根、不放制品里**：放制品里会被下一次构建自己打包进去（自吞），
  且会污染 `roots` 映射的枚举。`.gitignore` 恒排除 `build/`。
- `workspace.json` 的 `meta` 里，构建/安装信息只存**指针**（`lastBuild` 摘要、`installedTarget`）；
  构建报告的权威副本在 `build/{buildId}.json`，两者不一致时以报告文件为准并提示重建。
- 一个项目首版只有一个插件制品，但 `artifacts` 按数组建模——日后「一个项目产出多个 addon」
  不需要改存储模型，只是多一个制品目录。

#### 10.5.2 创建向导

入口：启动器「插件 → 新建插件项目」；编辑器命令面板同名命令。采用 overlay 向导，
交互口径与现有新建项目向导一致（全中文、单页、落点预览、错误原样呈现、创建中禁用按钮）。

| 步骤 | 内容 | 数据来源 / 约束 |
|---|---|---|
| 1. 目标实例 | 选一个已有实例；显示 gameId / 游戏版本 / 隔离模式 | `instances.list()`；**只读**，不写游戏目录 |
| 2. 基本信息 | 项目名、`pluginId`、显示名、版本、作者、许可、主页、描述 | `pluginId` 见下方字符集；项目名仅显示用 |
| 3. 能力与存档影响 | `capabilities` 多选、`saveImpact` 三档 | 与安装门禁同一套枚举，避免向导说一套、门禁判一套 |
| 4. 模板 | `GamePluginRules.scaffold` 支持的模板列表 | adapter 缺席 `scaffold` ⇒ 只显示「空白」 |
| 5. 根映射 | 每条：`rootId`（下拉只能选 `pluginRules.roots` 的 id）、源目录 `from`、目标目录 `to` | 至少一条；不提供手输 rootId |
| 6. 落点 | 工作区根下拉（`WorkspaceService.roots()`，首位为默认根） | 不接受手输路径；新增根走目录对话框 |
| 7. 创建 | 见下方执行序列 | 失败整体回滚，不留半成品项目 |

**执行序列**（`pluginProjects.create`）：

```
读实例 → adapter / gameId / gameVersion（只读）
  → workspaces.create({ name, meta: PluginProjectMeta, rootDir? })
  → workspaces.createArtifact(projectId, { name: 'plugin', dirName:'plugin', files:{ 'plugin.json': … }, meta })
      ← `WorkspaceArtifactInput` 的 `files` 只有**文本**；二进制走 `io.writeBytes` 逐文件补写
  → pluginRules.scaffold({ template, pluginId, displayName, gameId, capabilities, gameVersion })
      → 返回文件映射 → workspaces.writeText / io.writeBytes 逐文件写入
  → 在项目根写 `.gitignore`（排除 `build/`）并建空 `build/` → workspaces.update(meta 补 lastBuild:null)
  → 广播 workspace.projectCreated（**现有载荷** `{ projectId, requestToken?, source? }`；
     要区分插件项目就填 `source`，不给它加新字段）
```

**校验（创建时即拦，不留到构建）**：
- `pluginId` 字符集 `[a-z0-9]([a-z0-9._-]*[a-z0-9])?`，长度 3–80；不得以 `-` / `.` 开头结尾；
  与同工作区任一插件项目的 `pluginId` 相同 ⇒ `LAUNCHER_PLUGIN_PROJECT_EXISTS`；
  与目标实例已装插件同 id **不拦**（那是升级场景），但向导必须显式提示「安装时将作为升级」。
- `version` 非空、不含空白与路径分隔符；`plugin.json` 里的 `gameId` 必须等于项目 meta 的 gameId。
- `roots` 至少一条；`rootId` 必须命中该 adapter 的 `pluginRules.roots`；`from` 非空且为相对目录；
  `to` 缺省 `''`。
- 模板生成的文件**不得**覆盖 `plugin.json`；adapter 返回的路径不得逃逸制品根（core 逐条守卫）。

**不复制游戏文件**：模板只生成示例骨架与注释，不读取、不搬运游戏目录里的任何文件——
既避免把游戏版权素材带进作者项目，也避免「新建项目」变成一次隐式导出。

#### 10.5.3 编辑（在编辑器里）

- 项目创建后，其所在工作区根已在编辑器可写根名单（`workspaceRootsOf` / `kernel.workspaces`），
  文件直接可编辑；打开方式走现有「项目 → 文件」树与 `editor.revealLocation`，**不新造编辑器模式**。
- **项目树的身份**：`kojo-project-kit` 的「我的口上项目」面板与启动器项目列表都从
  `kernel.workspaces` 读同一份数据。面板对 `meta.kind === 'game-plugin'` 的项目必须显示
  「插件项目」徽标、且**不提供**「部署到游戏目录」这类口上包动作（插件只能经安装管线进实例）。
  两处共享数据与命令注册表，不共享代码（避免跨插件 import）。
- **清单编辑**：`plugin.json` 是普通 JSON 文本，作者直接改；保存走内核 io（备份/脏缓冲提示照旧）。
  构建期做权威校验；编辑器内若已有 JSON 语言服务则复用其诊断，**没有也不假装有**——
  问题统一在构建结果的 Problems/详情面板里逐条列出（行号 + 原因 + 修复建议）。
- **哪些文件会被打包**：完全由 `plugin.json` 的 `roots[]` 映射决定。不在任何映射里的文件
  不报错（作者可能放草稿、素材原图），但构建结果必须列出「未打包文件」清单，避免
  「我明明放了却没生效」的静默失败。`build/`、项目根 `.gitignore`、制品内的 `plugin.json`
  自身恒不打包（`pack.json` 单独生成到 ZIP 根）。
- **二进制资源**：现有新建/导入文件入口直接落盘，构建按字节读取；不要求手工填哈希。

#### 10.5.4 构建（确定性）

`pluginProjects.build` 的步骤固定为：

```
[1] 读 plugin.json → 校验 schema / pluginId / version / gameId / roots / entrypoints
[2] 路径守卫：每条 from 必须存在；拒绝 .. / 绝对路径 / 盘符 / UNC / ADS / 保留名 / 尾点尾空格
[3] 枚举：walkDir(制品内 from, includeFiles) → include/exclude 过滤 → 目标路径 = to + 相对路径
[4] 冲突：同一 rootId 下同一目标路径被两条映射命中 ⇒ 失败（不做隐式覆盖）
[5] 逐文件算 sha256 / size（宿主流式哈希；不整包读进 JS 内存）
[6] 生成 pack.json（ContentPackManifest：kind='plugin'、files[]、entrypoints 换算为 ContentFileRef）
[7] 写 pack.json 到 build/staging/（报告最后写，避免失败时留下指向不存在 ZIP 的报告）
[8] 确定性打包：**先按 posix 路径排序**，再 `zip.ts::buildZip(entries, { contract: 'extractable', date: 固定值 })`
    （时间统一取固定 `date`，缺省会被夹到 DOS 1980；压缩级别固定）
    → build/{pluginId}-{version}.zip，写盘走内核 io 写闸
[9] 写 build/{buildId}.json（pack.json + zip 哈希 + 源指纹 + 未打包文件 + 警告）
[10] 返回 PluginBuildResult（zip 绝对路径 / 字节 / zip 自身 sha256 / 警告）
```

- **确定性**：`buildZip` **只按给定顺序落盘**、时间取 `opts.date`（缺省 `Date.now()`，更早会被夹到
  DOS 1980）⇒ 确定性由**消费侧**保证：先按 posix 路径排序、传固定 `date`、压缩参数固定。
  `zip-roundtrip.test.ts` 钉的是往返与共享表，**不替你排序**。
  `buildId = sha256(pack.json 规范化文本 + 逐文件摘要)`，与构建时间无关；时间只进报告的 `builtAt`。
- **原子落盘**：ZIP 字节在内存里一次成型，经内核 `io.writeBytes` 原子写（先临时再 rename，
  与 `writeText` 同款时序）；失败不留半截包。`build/staging/`（`pack.json` 暂存）只在构建期
  存在，成功或失败都清理。
- **哈希与打包同一批字节**：打包前对每个文件复算一次摘要并与第 [5] 步比对；任一文件在两步之间
  被改动 ⇒ 构建失败（`LAUNCHER_PLUGIN_BUILD_FAILED`），不产出「包装的和清单说的不是一回事」的包。
- **不执行项目内任何代码**：没有 `npm install`、没有构建脚本、没有模板渲染器。
  `plugin.json` 是**数据**，不是可执行配置。
- 构建产物只落 `{projectDir}/build/`；路径由 core 拼死（**没有** `outRelPath` 这类参数），
  写走内核 io 写闸（工作区根是常驻可写根）。
- 构建**不做**安装门禁（不读游戏目录）：能力与实际落点的风险升级、版本兼容、函数级冲突、
  存档影响全部留到 `planInstall`——构建是「产出确定的东西」，安装是「判断能不能进这个实例」。
- `entrypoints` 必须命中某个 `roots` 映射实际产出的文件；否则构建失败
  （`LAUNCHER_PLUGIN_PROJECT_INVALID`），不产出「入口指向不存在文件」的包。

#### 10.5.5 构建并安装

```
UI「构建并安装」
  │
  ▼
pluginProjects.planInstall(projectId, instanceId)
  ├─ build(projectId)                                  ← 10.5.4
  └─ plugins.planInstall(instanceId, build.zipPath)    ← 既有插件门禁（§10.1 / §10.4）
  │
  ▼
确认页：风险等级 / 文件清单（新增·覆盖）/ 函数冲突 / 版本兼容 / 存档影响 / 是否需重启
  │  （用户可逐条决议；取消 = 整次取消）
  ▼
plugins.applyInstall(plan.planId, resolutions, { …, sourceProjectId: projectId })
  ├─ 先备份存档（saveImpact != 'none'）
  ├─ 备份将被覆盖的基础文件（original/ + {timestamp}/）
  └─ 落盘 / 回滚
  │
  ▼
成功：workspaces.update(meta.installedTarget = {installedAt, buildSha256} )
失败：实例回滚；**项目源一律不动**，重试从 planInstall 重新开始（计划会过期）
```

- 目标实例必须与项目 `gameId` 一致；`shared` / `copy` 都允许，`shared` 需对应根的写授权。
- 构建产物是宿主自己写出的 ZIP：来源可信、**不需要**外部来源根批准，但仍**同样过**
  ZIP 四重守卫、`pack.json` 哈希核对与全部插件门禁——「自己构建的」不是免检理由。
  `planInstall` 仍要求 `archivePath` 位于工作区根 / appData / 已批准来源内，不接受任意路径。
- 安装前必须停游戏（`LAUNCHER_INSTANCE_BUSY`）；`requiresRestart=true` 时置「待重启」。
- **编辑器不直写游戏目录**：即使当前打开的游戏项目与目标实例是同一个根，也不走编辑器写盘，
  而是走启动器的计划/应用管线——否则备份、ownership、回滚全部失效。

#### 10.5.6 从已装插件提取为项目

入口：插件详情页「提取为项目」（无源码项目时才显示；已有 `sourceProjectId` 则改为「打开源码」）。

```
PluginManager.list → 取该插件 manifest 与 ownedFiles
  → workspaces.create({ name: '<name>（提取）', meta: {kind:'game-plugin', extractedFrom:{…}} })
  → workspaces.createArtifact(projectId, { dirName:'plugin', files:{} })   ← 先建空制品
  → 按 rootId 分组，逐文件 io.readBytes(源) → io.writeBytes(plugin/content/{rootId}/<相对路径>)
      （字节级，不转码；目标在工作区根内，仍过内核 io 双闸）
  → core 生成 plugin.json：
       roots[] = 每个 rootId 一条 { rootId, from: 'content/{rootId}' }
       version / capabilities / saveImpact / author 等从原 manifest 抄录
       entrypoints 从 ContentFileRef 反算回相对路径（跨根无法唯一反算时留空并记 warning）
  → source = 'extracted'，lastBuild = null
```

- 只复制 `ownership.json` 里属于该插件的文件，**不复制整个游戏目录**。
- 文件缺失 / 哈希不符 ⇒ `LAUNCHER_PLUGIN_EXTRACT_FAILED`，列出缺哪些，不静默补空文件。
- 提取项目与安装时的构建产物**不是逐字节等价**：目录布局按根重组、哈希注释丢失、
  清单字段可能缺少原作者的额外字段。UI 必须明说「这是从已装文件还原的副本，不是原作者项目」。
- 首次重建若与原包哈希不同，属正常；后续升级以新构建产物为准。

#### 10.5.7 漂移与版本

`inspectDrift(projectId, instanceId)` 只读比较三处版本：

| 状态 | 条件 | UI |
|---|---|---|
| `not-installed` | 实例没装该 id | 「构建并安装」为主按钮 |
| `in-sync` | 源版本 = 上次构建版本 = 已装版本，且源指纹 = `lastBuild.sourceFingerprint`，已装 `buildSha256` = 上次构建 | 正常，可仍允许重装 |
| `source-changed` | `plugin.json` 版本或源指纹与 `lastBuild` 不一致 | 黄条「源已改动，请重新构建」 |
| `installed-differs` | 已装版本 ≠ 上次构建版本（或哈希不同；**不区分谁更新**） | 黄条「实例里不是这个构建」，提示重新安装 / 以实例为准 |

- 状态判定按优先级取**第一条命中**：`not-installed` → `source-changed` → `installed-differs` → `in-sync`。
  同时满足多条时，UI 只显示最靠前的一条，不并列刷屏。
- 版本号由作者在 `plugin.json` 里改；构建可用 `PluginBuildOptions.version` 临时覆盖产物版本，
  **不回写源文件**（避免构建偷偷改源）。
- `source-changed` 的判据是**源指纹**（`plugin.json` 规范化文本 + 映射文件 `(路径, size, mtimeMs)`
  的摘要），不重算内容哈希——打开项目不该全量读盘；构建时反正全量重算，mtime 回拨造成的漏报
  会在构建结果里暴露（产物哈希与上次不同）。
- 不要自动递增版本：版本是作者的语义声明，工具替他编版本会让「升级」变成噪音。

#### 10.5.8 安全边界

| 风险 | 守卫 |
|---|---|
| 项目路径逃逸（`..` / 绝对路径 / 盘符 / UNC / ADS / 保留名） | 创建、编辑写盘、构建收集三处同一套规范化守卫；宿主打包时再复核 |
| 构建写出工作区 | 输出恒为 `{projectDir}/build/…`；`projectDir` 必须在宿主写允许域（appData / 已授权工作区根）内 |
| 项目内藏可执行内容 | 构建只读字节、不执行；安装后也只经游戏自身加载机制生效，不做进程注入 |
| 恶意 `plugin.json` 伪造验收 | 源清单出现 `files[]` / `sha256` 即非法；安装门禁只信构建产物里的 `pack.json` |
| 提取项目冒充原作者 | `source='extracted'` 持久化并在 UI 常驻徽标；不写入 `trust.verified` |
| 项目与实例并发改动 | 构建前后复核摘要；计划过期即重来；安装单飞锁 |
| 二进制资源体积失控 | 复用 §10.7 的 ZIP 限额；构建阶段先按总字节预检，超限在打包前失败 |

### 10.6 整合包（P2）

- 格式：`.zip` + 根 `bundle.json`（实例模板 + 内容包/插件列表 + 可选游戏文件）；
- 导入：解到暂存 → 校验 → 创建 `copy` 实例 → 按 `loadOrder` 安装内容 → 写配置 → 完成；
- 导出：流式 ZIP（`game/` 可选、`content/`、`instance.json`，默认排除 `logs/`、`backups/`、`staging/`）；
- **不内置游戏本体下载源**；bundle 里带游戏文件时，UI 明确提示「这是发布者附带的内容，请自行确认版权」。

### 10.7 容器守卫

市场（`market.rs`）已有的四道闸**必须复用同一份实现**，不复制第二份：

1. 条目数上限；
2. 相对深度上限；
3. 解压总字节 / 单条目字节上限；
4. 路径规范化 + 大小写折叠冲突检测。

**已有、直接复用（别当新功能重写一遍）**——这些在实树里都已经实现，并且各有钉：

- 非普通文件条目（符号链接 / FIFO / socket / 设备文件）：`entry_type_problem` 按 unix mode
  （`S_IFMT` / `S_IFREG`）拒；DOS 来源的条目没有权限位，靠路径闸兜目录条目；
- 硬链接：**无需新增**——zip 容器里没有独立表示（`zip` 4.6.1 全文无 hardlink 概念，
  链接关系只能落成重复路径的普通条目），由 `entry-duplicate` 与类型闸共同覆盖；
- 加密条目与带数据描述符的条目：`FLAG_ENCRYPTED` / `FLAG_STRONG_ENCRYPTION` /
  `FLAG_DATA_DESCRIPTOR` 一律按 `container-structure` 拒；
- 绝对路径、`..`、盘符、反斜杠、空路径段、深度、条目数、解压总量：`entry_path_problem` +
  `declared_entries_problem` + `cap_staging_limits` 的硬顶；
- 解压流式写盘、超限立刻中止：`stream_capped` / `advance_byte_cap` 已有，照抄调用形态。

**三处口径差异（v0.4 复核更正；L0 批已补齐，见下表「已补」）**：

| 判据 | 宿主解包器（`archive_guard.rs`） | 清单侧 `market.ts::packEntryPathProblem` | 容器闸 `zip.ts::zipEntryContractProblem` |
|---|---|---|---|
| 尾点 / 尾空格 | 早有（`path-windows-unsafe`） | 早有 | **原缺 → 已补（复用同码）** |
| ADS（段内 `:`） | 早有（`path-drive`，注释即写明 ADS） | 早有（`path-drive`） | **原缺 → 已补（复用同码）** |
| Windows 保留设备名段 | **原缺 → 已补（`entry-name-encoding`）** | **仍缺**（输入是清单声明，另记后续对齐） | 早有 |

- **没有新造任何拒绝码**：`path-windows-unsafe` 与 `path-drive` 原本就在 `MarketRejectCode` 里，
  只是没进 `ZipContractCode` 与容器闸实现；保留名归既有 `entry-name-encoding`。
- 两侧判定顺序已统一为：空 → NUL → 盘符 → 段内 `:` → 反斜杠 → 绝对 → 空段 → `..` →
  尾点尾空格 → 保留名 → depth；共享表 `entryNames` / `tampers` 各加行钉住。
- 启动器**复用** `archive_guard.rs` 与这张共享表，不另写第二份；清单侧保留名的缺口
  （「清单放行、容器拒」的不对称）记为后续对齐项——容器是执法点，不对称不会放行危险条目。

**限额的单源（v0.4 更正）**：

- TS 侧：`plugin-api/src/zip.ts::ZIP_EXTRACT_LIMITS`（派生自 `MARKET_MAX_FILE_ENTRIES` /
  `MARKET_MAX_PATH_DEPTH` / `MARKET_MAX_UNPACKED_BYTES`）；需要不同档位时用
  `ZipContractLimits` **逐调用覆盖**，不要改全局；
- 跨语言：判据参数（字符集字面、后缀、长度上限等）住
  `plugin-api/fixtures/zip-roundtrip/contract.json`，Rust 侧 `include_str!` 同一份文件；
  两侧各有钉（`plugin-api/tests/zip-roundtrip.test.ts` +
  `market_tests.rs::zip_roundtrip_name_gates_read_the_shared_table`），**表漂一字节必有一边红**；
- 宿主侧：保留硬顶（`cap_staging_limits` 那套），那是**有意的纵深防御**，不是第二份真源——
  TS 传什么就收什么才是真风险。

> 首版具体数值不在这里拍脑袋：先以真实内容包 P95 体积与条目数实测，再定契约常量；
> 在定值前不实现下载通道，避免「先写死再改」。

---

## 11. 存档与备份

### 11.1 列表

- `saveLayout.roots` 由 adapter 给出；`SaveManager.list` 遍历每个 root，按 `listRule` 过滤/命名；
- 文件元数据（大小、mtime）由宿主给；存档内角色/进度摘要由编辑器侧解析——**服务键
  `snapshot.source`**（实现插件 `sav-parser`，契约 `plugin-api/snapshot.ts`；ADR-0004 定的名，
  不是 `state-snapshot`、也不是早期的 `sav.parser`），**启动器 core 不解析存档格式**（避免游戏知识回流）；
- `shared` 实例默认只读；授权某个 saveRoot 后可写（授权链见 §9.1）；`copy` 实例可写。

### 11.2 备份

- 备份 = ZIP + `backup.json`（实例 id、时间、根、条目清单、每个文件哈希、来源标签）；
- 默认保留策略：最近 20 份或 30 天（契约常量，先实测再定）；`pre-restore` 与 `pre-plugin`
  备份不计入用户手动配额（它们是安全回退，不该挤掉用户主动备份）；
- **插件安装前备份**：`saveImpact != 'none'`（含缺省 `unknown`）时，`PluginManager.applyInstall`
  先调用 `SaveManager.backup(reason='pre-plugin')`；备份失败 ⇒ 安装中止，返回
  `LAUNCHER_PLUGIN_SAVE_RISK`；
- 备份写入 `instances/{id}/backups/saves/`，**只在实例根内**，不碰游戏目录。

### 11.3 恢复

```
校验 backupId → 解到 tmp → 逐文件哈希校验
  → 自动备份当前存档（backupCurrent=true）
  → 停游戏（若在跑）
  → 逐文件写临时 + rename
  → 失败则逆序恢复 pre-restore 备份
  → 发任务终态
```

- `shared` 实例要写回原游戏目录：必须先在「写授权」里用原生目录对话框批准该 saveRoot，
  批准记录进 `approvals.json`；未批准则拒绝，错误码 `LAUNCHER_SOURCE_NOT_APPROVED`。
- 恢复前若游戏在跑，返回 `LAUNCHER_INSTANCE_BUSY`，不自动杀进程。

### 11.4 导入 / 导出

- 导入：外部 ZIP → 预检同名冲突 → `planImport` → 用户确认 → `applyImport`；
- 导出：原生保存对话框 + 宿主同命令写 ZIP（照 `exportFile` 的授权形态）；
- 导出内容不含日志、不含实例配置中的绝对路径。

---

## 12. 日志与诊断

### 12.1 采集链路

```
子进程 stdout/stderr
   │ 宿主：逐块读字节（不解码）
   ▼
host 日志泵 ── 写 {sessionId}.stdout.log / .stderr.log
   │        └─ 发 kojo:launcher-log（base64，节流）
   ▼
launcher-core LogService
   │ 流式解码（BOM → UTF-8 有效性 → fallback；跨块多字节不截断）
   │ adapter.logRules.parseLocation / isErrorLine / isNoiseLine
   ▼
UI 日志页（环形缓冲，最多 N 行）+ 编辑器跳转
```

- **解码在 TS 侧**：复用现有编码探测单源（`decodeWithProbe` / `DECODE_LABEL`），宿主不做第二套探测。
- **环形缓冲**：UI 只保留最近 N 行（契约常量）；完整日志在文件里，按 `LogPage` 分页读。
- **节流**：宿主 ≥64 KiB 或 ≥100 ms 合并一次；UI 侧再按帧合并，避免 10k 行/秒打爆 React。
- **轮转**：每个会话独立文件；超过大小上限时按会话切分，不覆盖历史。

### 12.2 崩溃摘要

`crashed` 时生成：

- 退出码 + 中文解释（Windows NTSTATUS 查表）；
- 最后 N 行 stderr（含 `isErrorLine` 命中行）；
- 实例概况（adapterId、隔离模式、运行时、内容包/插件列表、exe 哈希）；
- 会话时长、启动参数（`env` 脱敏后）。

UI 首屏给三个动作：**看日志 / 导出诊断包 / 重新启动**。

### 12.3 诊断包

- 原生保存对话框 + 同命令写 ZIP；
- 内容：`session.json`、stdout/stderr 尾部、实例快照、内容/插件清单（含风险等级与函数冲突摘要）、
  运行时校验、环境摘要；
- 默认**路径脱敏**：把 `C:\Users\<名>` 替换为 `%USERPROFILE%`，把 `{appData}` 替换为 `%APPDATA%`；
- 不自动上传、不包含游戏本体、不包含存档内容（除非用户勾选）。

### 12.4 跳编辑器

- `LogLine.location` 是相对 `gameRoot` 的路径；
- 只有当前编辑器打开的项目根与实例 `gameRoot` 相同（或在其下）时才允许跳转；
- 跳转走既有 `editor.revealLocation` 事件，不新造一套定位协议；
- `shared` 实例与编辑器项目常常就是同一个根，这是启动器最大的闭环价值之一。

---

## 13. 安全模型

### 13.1 威胁与守卫

| 威胁 | 守卫 | 测试 |
|---|---|---|
| 插件/前端传任意 exe 路径 | 宿主只有 `launcher_start(instanceId)`；exe 路径在创建时固定为实例内相对路径 | 契约测试：不存在接受 exePath 的命令 |
| exe 被替换成恶意程序 | 信任记录 SHA-256；每次启动复算；变化即 `TRUST_CHANGED` | 篡改 fixture → 启动被拒 |
| 路径逃逸（`..`/符号链接/junction） | 规范化 + 逐段拒绝 reparse point + 前缀包含校验 | Windows junction fixture |
| ZIP slip / 炸弹 | 四重守卫 + 条目路径闸 + 大小写折叠；尾点尾空格 / ADS / 保留名**两侧同判**（共享表钉住，archive_guard 批补齐） | zip bomb / slip / casefold / reserved-name fixture（两侧各一份） |
| 命令行注入 | argv 数组，不经过 shell；拒绝 NUL 与超长参数 | 参数含 `&`、竖线、引号 → 原样作为参数 |
| 环境变量泄露令牌 | 宿主 `env_clear` + 最小白名单；只允许实例显式追加 | 快照测试：不出现 `HTTP_PROXY`/`TOKEN` |
| 子进程逃出杀树 | Job Object + `CREATE_SUSPENDED` + 禁止 breakaway | 孙进程测试：stop 后两者都消失 |
| 远程下载到恶意主机 | 协议 + 编译期主机白名单 + 逐跳重定向复核 + 体积双闸 + SHA-256 | 重定向到非白名单 → 拒 |
| 插件绕过信任确认 | 信任命令在宿主内弹原生确认框，JS 不传哈希 | 直接调用 trust 仍弹框 |
| 内容包覆盖基础文件 | 内容包默认 abort；覆盖必须显式确认 + 先备份 | 安装计划默认无 overwrite |
| **恶意游戏插件**（改 ERB/CSV/资源以执行任意逻辑） | 能力声明 + 风险分级 + 完整文件清单 + 显式确认 + 先备份 + 可卸载回滚；不做静默下载安装 | 计划展示与落盘文件逐条对账；卸载后哈希回到装前 |
| **插件函数冲突**（同名函数互相覆盖，加载顺序决定谁生效） | `adapter.analyzeFunctions` 函数级冲突分析 + 逐条决议 + 顺序可控 | 同名函数 fixture → 默认 abort；replace 后备份旧定义 |
| **插件与存档不兼容**（卸载插件后旧存档读不出） | `saveImpact` 声明 + 安装前 `pre-plugin` 备份 + 卸载残留提示 | 备份存在性、失败即中止安装 |
| **shared 误写原目录** | 逐根原生授权（实例 × rootId）；写入前复验前缀；不提供全局可写开关 | 未授权安装/恢复 → `LAUNCHER_SOURCE_NOT_APPROVED` |
| 日志泄露用户名 | 诊断包路径脱敏；UI 只显示相对路径 | 快照测试 |
| 实例删除误伤 | 删除只在实例根内；备份可移入 `trash/` | 路径守卫测试 |

### 13.2 启动校验链（宿主内，顺序固定）

1. `instanceId` 存在且 `state=ready`；
2. `executable.relativePath` 非空、非绝对、无 `..`、无盘符/UNC；
3. 拼 `gameRoot` 后规范化，必须仍以 `gameRoot` 为前缀；
4. 逐段检查父目录无 reparse point（symlink/junction）；
5. 目标是常规文件，扩展名在平台允许表（Windows: `.exe`；拒绝 `.bat/.cmd/.ps1/.lnk`）；
6. 计算 SHA-256，与 `executableTrust.sha256` 逐字相等；
7. 运行时需求已解析（或显式标记 optional 且用户接受）；
8. 每实例锁空闲；
9. `CreateProcessW(CREATE_SUSPENDED)` → Job Object → `ResumeThread`。

任一步失败：**不创建进程**，返回带步骤名的 `LauncherError`；UI 显示「哪一步没过」。

### 13.3 能力面边界

- `launcher.service` 的能力是「启动**已登记且用户信任过**的实例」，不是「spawn 任意程序」；
- 宿主没有 `launcher_start_path` / `launcher_exec` 这类命令；
- **游戏插件不是代码插件**：它以磁盘上的游戏脚本/数据/资源生效，不加载进编辑器进程、不注入游戏进程。
  ADR-0007 约束的是「编辑器内运行的第三方代码插件」，不适用于本节的游戏插件——两者能力面完全不同，
  不要因为同名就套同一套禁令；
- 在放开 `launcher.service` 给第三方插件调用之前，必须补：
  - `launcher.service` 的调用方白名单 / 权限声明；
  - 创建实例、信任 exe、**安装/卸载内容包与游戏插件**、申请写授权的调用方审计；
  - 否则一个恶意编辑器插件可以「创建实例 → 调 trust（仍会弹原生框）→ 启动」，
    用户仍是最后一道闸，但不该把安全全部押在用户点「允许」上。
- 这条缺口写进 ADR-0008 的发布前置条件，不假装已经解决。

### 13.4 哪些事刻意不做

- 不做游戏进程注入 / DLL hook / 内存修改 / 运行中热替换；
- 不做「静默安装内容包或游戏插件」；
- 不做「自动下载并运行任意 URL 的 exe」；
- 不做「把游戏目录整体设为可写」的全局开关；
- 不做「装完再提示」——所有逻辑变更必须先有安装计划、先有确认、先有备份。

---

## 14. UI IA 与编辑器桥接

### 14.1 顶层信息架构

```
启动器（新顶层视图，与编辑器并列）
├── 实例库（首页）
│   ├── 实例卡片：封面/名称/gameId 徽标/隔离模式/最近启动/状态点
│   ├── 主按钮：启动 / 停止；次操作：在编辑器打开、打开文件夹、复制、删除
│   └── 空态：添加游戏（原生目录选择）/ 导入整合包（P2）
├── 实例详情
│   ├── 概览：运行时、路径、隔离、上次退出、快捷动作
│   ├── 内容：已安装内容包列表、启停、顺序、冲突、安装（对话框/拖放）
│   ├── 插件：已装插件列表、风险等级、启停、顺序、函数冲突、安装/更新/卸载、
│   │        ├── 在编辑器中打开源码、构建并安装、待重启标记
│   │        └── **插件项目**：新建向导、项目列表（源版本 / 上次构建 / 已装版本）、
│   │            打开编辑、构建、构建并安装、导出 ZIP、从已装插件提取、漂移提示
│   ├── 存档：列表、备份、恢复、导入、导出、在编辑器中回放（复用快照）
│   ├── 日志：实时尾部、筛选、错误行、跳代码、导出诊断包
│   └── 设置：名称、参数、环境变量、locale、编码、日志保留、写授权、危险区
├── 任务中心（抽屉/角标）
│   ├── 进行中：进度、取消
│   └── 历史：成功/失败、错误详情、重试
├── 下载/更新（P2）
└── 设置（启动器全局）
```

### 14.2 与编辑器的双向桥

| 方向 | 入口 | 行为 |
|---|---|---|
| 启动器 → 编辑器 | 实例卡片「在编辑器中打开」 | 用实例 `gameRoot` 走现有项目打开链路；不复制游戏知识 |
| 启动器 → 编辑器 | 插件页「在编辑器中打开源码」 | 用 `sourceProjectId` 解析项目目录并打开；无源码则提示「先提取为项目」 |
| 启动器 → 编辑器 | 插件项目列表「打开编辑」 | 项目目录作为会话附加根加入文件区，并打开 `plugin.json`；不新开编辑器模式 |
| 编辑器 → 启动器 | 插件项目「构建」 | 只构建到项目 `build/`，展示产物哈希、体积、未打包文件与警告；不碰实例 |
| 编辑器 → 启动器 | 插件项目「构建并安装」 | 构建产物 ZIP → `PluginManager.planInstall` → 用户确认 → `applyInstall`；编辑器不直接写游戏目录 |
| 编辑器 → 启动器 | 插件项目「提取自当前实例」 | `pluginProjects.extract` → 新建工作区项目并打开；标记为 extracted |
| 编辑器 → 启动器 | 状态栏/工具栏「启动游戏」 | 若当前项目根匹配某实例，调 `launcher.service.start`；不匹配则提示「先添加为实例」 |
| 日志 → 编辑器 | 错误行点击 | `editor.revealLocation`，仅当项目根匹配 |
| 编辑器 → 启动器 | 运行中指示 | 状态栏显示实例运行状态；停止入口不藏在别处 |

### 14.3 交互与文案

- 全中文；不允许 WebView2 默认英文右键菜单（右键统一走现有全局路由与命令注册表）。
- 危险动作二次确认：删除实例、覆盖基础文件、覆盖既有函数、恢复存档、强制停止、卸载有存档影响的插件。
- 插件安装确认页必须同屏展示：风险等级、文件清单（新增/覆盖）、函数冲突、版本兼容、
  存档影响、是否需要重启、发布者/来源；**不允许**折叠成一句「确定要安装吗？」。
- 所有长任务必须有：进度、可取消（可取消时）、失败原因、重试入口。
- 所有空态必须解释「下一步做什么」，不是一张空白页。
- 实例状态用颜色 + 文字双编码（不能只靠颜色），照顾色觉差异。

### 14.4 键盘与命令

- 启动器视图内：**`Ctrl+Alt+O` 添加游戏、`Ctrl+Alt+J` 打开任务中心、`Ctrl+Alt+R` 启动/停止
  当前实例**（三枚在 2026-10-26 均为空位）。
- **不提 `Ctrl+N`**：它已被 `kojo.newKojoFile`（新建口上文件）占用——贡献点在
  `packages/plugins/ui-sugar-editor/src/index.ts` 的 `keybinding: 'ctrl+n'`，
  按钮提示、内置教程与 `shell-keys-guard.test.ts` 都在教用户这条键。
- **不提 `F5`**：WebView2 自带重载语义，要拿得先证明能可靠 `preventDefault`，首版不赌。
- **键位真源有两处，查重必须两处都扫**：宿主键在 `packages/app/src/ui/keybinding-specs.ts`
  的 `KEYBINDING_SPECS`（40 条登记、26 条带缺省键位），插件键在各 `editor.command` 贡献的
  `keybinding` 字段（当前仅 `ctrl+n` 一条）。
  `keybindings.ts` 是注册 / 覆盖层，**不是清单**——只查它会漏掉插件贡献的键。
- 命令注册进现有命令面板（`editor.command` 槽），文案单源，不在按钮上另写一份。

---

## 15. 分期与验收

### 15.1 P0 · 能启动、能停、能看见

**范围**：实例库（shared/copy）、宿主进程、信任确认、状态机、日志尾部、基础详情页、任务中心骨架。

**退出判据（全部可数）**：

1. 用真实游戏根创建 `shared` 实例 → 启动 → 看到 stdout/stderr → 停止 → 退出码写入 `lastExit`；
2. 用 ~10 MB fixture 创建 `copy` 实例 → 复制进度可见 → 启动路径指向实例内 exe；
3. 同一实例第二次 `start` 被 `LAUNCHER_INSTANCE_BUSY` 拒绝；
4. 测试 fixture：父进程派生孙进程 → `stop` 后两者都消失；
5. 首次启动前无信任 → `TRUST_REQUIRED`；原生确认后启动成功；篡改 exe 后 `TRUST_CHANGED`；
6. 应用退出时运行中的游戏树被杀，下次启动显示 `app-exit`；
7. `pnpm test` / 双 `typecheck` / `pnpm audit:decoupling` / `pnpm audit:language` 基线不回退；
8. 新增内核/契约/宿主源码零游戏名词（审计 A / D 项通过；文档与 adapter 例外）；
9. **验收通道是真壳**：1–6 必须在 `tools/debug-cli.mjs shell`（真桌面壳带 CDP）或
   `tools/smoke-tauri-ipc.mjs` 上过。`debug-cli.mjs serve` 的 Web 调试宿**没有 Rust 特权面**
   ——进程、Job Object、原生对话框在那里一律验不了，跑绿不算数；
10. **开机图不回退**：`ps10-eager-graph` 仍 ≤193 文件 / ≤2,870 KB（现值余量 0 文件 / 10 KB）
    ⇒ 启动器 UI 与 `launcher-core` 全部走动态 import，P0 **零新增常驻模块**；
11. **产物闸**：`node tools/release-gate.mjs` 的 artifact-audit PASS（≤85 件 / ≤10.5 MiB /
    入口 ≤1,100 kB；现值 80 件）；
12. `cargo test --lib` 0 failed（必须经 node 起，Git-Bash TMP 坑见 PITFALLS）。

### 15.2 P1 · 日常可用

**范围**：运行时扫描/解析、内容包计划/安装/启停/卸载/回滚、**游戏插件安装/启停/卸载/回滚、
基础函数级冲突检测、存档影响门禁、shared 写授权**、**插件项目创建 / 编辑 / 确定性构建 /
构建并安装 / 从已装插件提取**、存档备份/恢复/导入导出、日志跳转/诊断包、
实例复制、schema 迁移。

**退出判据**：

1. 真实内容包安装 → 冲突列表正确 → 确认后应用 → 卸载后游戏根逐文件哈希回到安装前；
2. **真实游戏插件安装** → 计划页显示风险等级 / 新增与覆盖文件 / 函数冲突 / 兼容性 / 存档影响 →
   确认后应用 → 卸载后游戏根逐文件哈希回到安装前；
3. **插件覆盖基础文件**：默认需逐条确认；确认后 `backups/packs/` 存在旧文件快照；
   中途失败回滚后旧文件哈希复原；
4. **函数级冲突**：同名函数 fixture 默认 abort；选择 `replace` 后旧定义所在文件有备份；
   选择 `skip` 时既有定义不变；
5. **存档影响门禁**：`saveImpact != 'none'` 时安装前存在 `pre-plugin` 备份；
   强制让备份失败 → 安装中止并返回 `LAUNCHER_PLUGIN_SAVE_RISK`；
6. **版本不兼容**：`gameVersion` 不满足 → `LAUNCHER_PLUGIN_INCOMPATIBLE`；
   显式强制安装后插件标 `incompatible`，启动前有警告；
7. 安装中途取消/断电模拟 → 重启后实例无半成品、无 ownership 悬空；
8. ZIP slip / 炸弹 / 大小写折叠 / **保留名 / 尾点尾空格 / ADS** fixture 全部拒绝，且暂存被清空
   （后三项已由 archive_guard 批两侧同判并进共享表；启动器复用同一实现）；
9. 存档备份 → 改动 → 恢复 → 逐文件哈希等于备份；
10. `shared` 实例未授权时装插件/恢复存档被拒；逐根授权后成功，且授权范围不扩散；
11. Shift-JIS 日志跨块解码正确（不出现半字符）；10k 行/秒压测 UI 不冻结；
12. 日志错误行点击 → 编辑器跳到正确文件/行；
13. 诊断包可导出、路径已脱敏、不含存档内容；
14. schema 1→2 迁移有备份、失败可见。
15. **插件项目创建**：向导选实例 → 生成 `plugin.json` + 模板文件 → 项目出现在工作区列表；
    重复 `pluginId` / 非法字符集被拒且无半成品目录；
16. **构建确定性**：同一份源连续两次构建的 ZIP **逐字节相同**；改一个源文件 → 哈希变；
    `roots.from` 逃逸 / 两个映射命中同一目标 → `LAUNCHER_PLUGIN_BUILD_FAILED`；
17. **构建并安装**：确认页字段齐全（风险/文件/函数冲突/兼容/存档/重启）→ 安装成功 →
    卸载后游戏根逐文件哈希复原；项目 `installedTarget` 与实例版本一致；
18. **提取反哺**：已装插件 → 提取为项目（`source='extracted'`）→ 改一行 → 重建 →
    作为升级安装成功；缺文件时提取失败并列出缺失项；
19. **边界读数**：手写 `plugin.json` 带 `files[]` / 哈希被拒；构建与安装计划阶段游戏根
    哈希 / mtime 一律不变（写只落工作区与项目 `build/`）。

### 15.3 P2 · PCL 对齐

**范围**：插件 SDK 与高级模板（一个项目多 addon、跨包函数依赖图）、包签名与发布者信任、插件更新通道、
下载/更新/校验修复、整合包导入导出、overlay、便携模式、文件关联、locale 包装器（单独评审）。

**退出判据**：

1. 下载重定向到白名单外 → 拒；哈希不匹配 → 拒；体积超声明 → 拒；
2. 校验发现缺失/损坏 → 修复后 `VerifyReport.ok=true`；
3. 整合包导入导出往返（含插件），实例可启动；
4. 插件签名验证：未签名/签名失效 → `LAUNCHER_PLUGIN_UNTRUSTED`；验签通过才允许自动更新；
5. overlay 实例：基础文件只读、可写层独立、卸载 overlay 后基础目录逐字节不变；
6. 便携模式：所有数据在 exe 同级目录，换机可带走；
7. 文件关联/托盘唤起不绕过信任与单实例锁。

### 15.4 测试矩阵（新增）

| 层 | 测试 | 环境 |
|---|---|---|
| 契约 | 命令/事件/错误码快照；无 exePath 启动命令；插件类型形状 | Node |
| `launcher-core` | 状态机、任务取消、计划过期、冲突决议、回滚顺序 | Node + 假宿主 |
| `PluginManager` | 风险分级、函数冲突（归一化名 + `conventionPolicy`）、版本兼容、存档门禁、卸载残留 | Node + 假宿主 + 函数分析桩 |
| `PluginProjectService` | 创建/逐条回滚、清单校验、跨根映射、确定性构建（对拍 `zip-roundtrip` golden）、摘要复验、提取、漂移 | Node + 假宿主（IO 与哈希桩） |
| Rust 宿主 | 路径守卫、归档守卫（与 `contract.json` 同表）、argv/env、Job Object、日志泵 | `cargo test --lib`（经 node 起） |
| 集成（真壳） | 子进程/孙进程、退出码、编码、复制进度、插件装/卸哈希复原 | `tools/smoke-tauri-ipc.mjs` / `tools/debug-cli.mjs shell` |
| UI | 实例库空态、启动/停止、任务进度、错误展示、插件确认页字段齐全 | `debug-cli.mjs serve`（纯 UI 面）+ 真壳截图 |
| 真实冒烟 | 用户提供游戏根与真实插件包 | 不进门禁，发布前手动（`smoke-tauri-ipc` 自动还原现场） |

---

## 16. 风险与开放问题

| # | 风险 / 问题 | 影响 | 首版取舍 | 后续 |
|---|---|---|---|---|
| 1 | 游戏进程自身写注册表/用户目录/联网，宿主无法约束 | 「隔离」不等于沙箱 | 明确文档与 UI 提示；只保证启动链可信 | 便携模式 / 用户目录重定向（P2） |
| 2 | `copy` 实例磁盘膨胀 | 大游戏复制慢、占空间 | 默认 shared；copy 显式创建；显示预估大小 | overlay / 硬链接只读层（P2） |
| 3 | Windows locale emulation 无官方按进程 API | 非日区系统可能显示乱码 | 只做编码/环境提示，不承诺解决 | 第三方包装器单独 ADR + 信任链 |
| 4 | 游戏引擎变体多（不同 exe/分支） | probe 可能漏 | adapter 返回多候选，用户选 | 社区贡献 adapter |
| 5 | 游戏插件与游戏逻辑同权（脚本可调引擎能力），这是**固有特性**而非缺陷 | 恶意/劣质插件可改逻辑、破坏存档 | 能力声明 + 风险分级 + 完整文件清单 + 逐条确认 + 先备份 + 可卸载回滚；不做静默下载安装 | 包签名 / 发布者信任（P2） |
| 6 | ZIP 限额缺真实 P95 | 定太小拒正常包，定太大增风险 | 先实测再定常量；未定值前不做下载 | 按包体统计校准 |
| 7 | 日志编码自动探测可能误判 | 乱码 | 实例级 fallback 可手动改；显示「编码」提示 | 更多探测样本 |
| 8 | 存档格式随引擎/版本变化 | 摘要/回放失败 | 启动器不解析，交给现有 snapshot 层 | adapter 提供格式标签 |
| 9 | 编辑器内第三方**代码插件**开放后能力面失控（与游戏插件不是一回事） | 安全边界 | 当前禁止；ADR-0008 列前置条件 | 权限系统 |
| 10 | 游戏本体版权 | 不能内置下载源 | 只管理用户自备目录 | 无 |
| 11 | 应用被杀时 Job 句柄是否一定收尸 | 极端断电仍可能残留 | Job `KILL_ON_JOB_CLOSE` + 下次启动陈旧锁清理 | 外部守护进程（不首版） |
| 12 | `shared` 模式下编辑器与游戏同时写文件 | 冲突/丢失 | UI 提示「运行中修改需重载」；写前备份 | 文件锁 / 变更检测（P2） |
| 13 | 插件版本与游戏版本漂移 | 装完不生效 / 启动报错 | adapter 判定 + 清单声明；不兼容默认拒，强制安装每次警告 | 插件 SDK 版本矩阵 |
| 14 | 卸载插件后存档仍引用插件数据 | 旧存档读不出 | 不删存档；`pre-plugin` 备份；卸载时明确提示 | 存档兼容检查（P2） |
| 15 | 多插件同名函数覆盖链难排查 | 「谁生效」说不清 | 函数级冲突 + 加载顺序可见 + 诊断页 | 跨包函数依赖图（P2） |
| 16 | shared 授权被误解成「整个游戏目录可写」 | 误改基础文件 | 逐根授权（实例 × rootId）+ 前缀复验 + 可撤销 | 更细粒度授权 |
| 17 | 编辑器正打开 shared 根时安装插件覆盖基础文件 | 编辑器缓冲与磁盘不一致 / 保存把插件改动覆盖回去 | **P1 硬闸**：安装前查脏缓冲，命中即阻止并提示保存/放弃；这是唯一会**静默吃掉插件改动**的路径，不推到 P2 | watcher 事件 + 更细的缓冲代际检测 |
| 18 | 项目源与已装版本漂移（改了源没重装 / 实例里是别的构建） | 玩家以为生效的是源码 | `inspectDrift` 三态提示；UI 同时显示「源 / 上次构建 / 已装」三版本；不自动递增版本 | 文件监听增量构建（P2） |
| 19 | 提取项目丢失原构建信息，被误当原作者项目 | 二次分发与原包验收对不上 | `source='extracted'` 常驻徽标 + 不写入 `trust.verified`；首次构建哈希差异属正常并明示 | 提取时保留原 `pack.json` 快照（P2） |
| 20 | 二进制资源走文本写入管线 | 编码损坏 / 内存峰值 | 二进制一律 `io.writeBytes` 字节级；构建流式哈希与打包，不把整包读进 JS | 大资源分块校验（P2） |
| 21 | 启动器把新视图 / 新插件静态装进首屏 | 开机图闸（193 文件 / 2,870 KB，余量 10 KB）与 dist 件数闸（80 / 85）当场红，P0 无法落地 | 全动态 import、零新增常驻模块；重基线须**单独一批**，不顺手抬阈值 | 按需预取 + 分块预算 |
| 22 | 三张写授权表（内核 `writablePaths` / `exportFile` / 启动器 `approvals.json`）口径各自演化 | 审计与铁律说不清「谁能写哪里」 | 本稿只立**一张**启动器表且不复用内核表；守卫实现单点、照 `exportFile` 形态；ADR-0008 落铁律 | 统一写授权服务（须再立 ADR） |

**需要用户/评审拍板的事项**：

1. 默认隔离模式：`shared` 优先（易用）还是 `copy` 优先（安全）？本文建议 `shared` 首次、`copy` 日常。
2. 是否接受「P0 仅 Windows」？本文建议接受，Linux/macOS 不进首版。
3. 启动器是否与编辑器同窗口切换，还是独立窗口？本文建议同窗口顶层视图，复用现有壳层与主题。
4. 插件签名是否进 P1？本文建议**不进**：首版先用「完整清单 + 显式确认 + 备份 + 回滚」立住可逆性，
   签名（P2）解决的是「发布者身份」，不能替代「装之前看清楚」。若评审要求 P1 必须验签，
   需要先定发布者公钥分发与吊销机制，否则会造一个假安全。
5. **安装前脏缓冲检查进 P1 还是 P2？**本文 v0.4 建议**进 P1**（风险 #17）：watcher 只能告知
   「盘上变了」，拦不住用户拿旧缓冲 Ctrl+S 把插件改动写回去；代价是首版要接一条「当前缓冲
   是否脏」的查询。若评审认为可接受「提示后由用户自负」，则保持 P2 并把它写进确认页文案。

---

## 17. Additive 契约变更清单

| 文件 | 变更 | 兼容性 |
|---|---|---|
| `packages/plugin-api/src/launcher.ts` | 新增全部启动器类型与服务接口（含 `PluginProjectService`、`PluginSourceManifest`、`PluginTemplateId`、`GamePluginRules.scaffold`） | 新增文件 |
| `packages/plugin-api/src/index.ts` | 导出 launcher 契约 | additive |
| `packages/plugin-api/src/game.ts` | `GameAdapter.launch?: GameLaunchAdapter` | 可选字段，旧 adapter 零改 |
| `packages/plugin-api/src/services.ts` | 新增 `KernelServices.LauncherHost`、`WellKnownServices.Launcher` | 新键，旧键零改 |
| `packages/kernel/src/launcher.ts` | 新增零逻辑透传 + 装配 | 不改既有服务 |
| `packages/plugins/launcher-core/` | 新增一等插件 | 新包 |
| `packages/plugins/launcher-core/src/plugin-manager.ts` | 插件门禁与安装编排（风险 / 兼容 / 函数冲突 / 存档） | 新文件 |
| `packages/plugins/launcher-core/src/plugin-project.ts` | 项目服务：创建 / 校验 / 提取 / 漂移（消费 `kernel.workspaces` 服务键）；**打包复用 `zip.ts::buildZip`，不写第二套打包器** | 新文件，内核零改 |
| `packages/app/src/bootstrap.ts` | `launcher-core` 进显式有序注册序列 | 加一行，旧插件零改 |
| `packages/app/package.json` / root `package.json` | 加 `@kojo/plugin-launcher-core` 的 workspace 依赖 | 新依赖 |
| `packages/app/src-tauri/src/launcher/` | 新增宿主模块与命令注册（P0/P1 清单见 §7.2；构建只用 `launcher_project_hash`，**没有**打包命令） | 新命令，旧命令零改 |
| `packages/app/src-tauri/src/archive_guard.rs` | 从 `market.rs` 抽出通用 ZIP 守卫，市场改为调用；**`fixtures/zip-roundtrip/contract.json` 与 golden 容器两枚钉照旧** | 行为不变，市场测试为金样本 |
| `packages/plugin-api/fixtures/zip-roundtrip/contract.json` | 若启动器要新增判据参数，扩这张共享表（两侧各自补钉） | additive；表漂一字节必有一边红 |
| `packages/app/src/launcher/` | 新增启动器视图 | 新视图 |
| `packages/app/src/launcher/plugin-project-wizard.tsx` | 插件项目新建向导、项目列表、构建/安装/提取入口 | 新文件 |
| `packages/app/src/ui/` | 「启动游戏」「在编辑器中打开实例/插件源码/插件项目」「构建并安装插件」接线 | additive |
| `packages/plugins/eratw-adapter/src/launch.ts` | 首个 `GameLaunchAdapter` 实现 | 只在本包出现游戏名 |
| `packages/plugins/eratw-adapter/src/plugins.ts` | 首个 `GamePluginRules` 实现（插件根 / 清单名 / 加载顺序 / 函数分析 / 模板 scaffold） | 只在本包出现游戏名 |
| `packages/kojo-project-kit/src/projects-panel.ts` | 识别 `meta.kind='game-plugin'`：徽标、隐藏口上包动作、挂构建入口 | additive；旧项目零改 |
| `packages/plugins/erb-parser`（服务键 `erb.parser`）/ `packages/erb-syntax-tree` | 函数级索引复用（`ErbIndex` / `ErbFunction.normalizedName`），不新增第二套解析；**壳层 `monaco/tree-sitter` 不在可达面** | 零改动（消费侧新增） |
| `docs/adr/0008-launcher-privileged-process-host.md` | 建议新增 ADR | 记录进程特权面与服务键边界 |
| `docs/adr/0009-game-plugin-install-and-trust.md` | 建议新增 ADR | 记录插件安装、函数覆盖与信任链 |
| `docs/adr/0010-plugin-source-project-and-build.md` | 建议新增 ADR | 记录「插件项目 = 工作区项目」、源/产物分离、确定性构建与三条写边界 |

**落地纪律**：
- 先做 P0 的宿主守卫与测试，再写 UI；不允许「先能启动，守卫后补」；
- `archive_guard.rs` 抽取必须单独一批，先让市场全套测试绿（含 `contract.json` 与 golden 容器两枚钉），
  再让启动器复用；
- 插件项目批**不新建第二套项目存储**：复用 `kernel.workspaces`；缺二进制写入就补 `kernel.io` 调用，
  不给工作区契约加「任意路径」入口；打包只走 `zip.ts::buildZip`；
- 启动器 UI 与 `launcher-core` **全程动态 import**：开机图现处零余量，任何静态入口都会当场红；
  阈值需要动就单独一批，不顺手抬；
- 新键位必须在 `KEYBINDING_SPECS` 与全部命令贡献的 `keybinding` **两处**同时查重；
- 新命令必须进契约测试快照，禁止只写 Rust 不写 TS 类型；
- 涉及进程 / 对话框 / Job Object 的判据挂真壳通道（`smoke-tauri-ipc` / `debug-cli shell`），
  Web 调试宿的绿不作数；
- 文档只认领与交付：开工在 `docs/BOARD.md` 写一行认领，交付把读数与取舍写进提交信息；
  本文不替代 `STATE.md` / `BOARD.md`。

---

## 18. 一句话结论

**启动器的核心不是「多一个启动按钮」，而是四道边界：把进程特权关进宿主、把游戏知识关进 adapter、
把实例数据关进 appData、把游戏逻辑变更关进「显式安装 + 先备份 + 可回滚」。**
前三条让启动器安全地「跑起来」，第四条让它正当地「改逻辑」——插件是产品能力，不是例外；
边界立住了，P0 那 **17 条命令**（§7.2）就能长成 PCL 式闭环；边界没立住，功能越多越危险。
v0.4 的另一半是同一条纪律的延伸：**能用既有实现的地方不再造第二份**——打包用 `buildZip`、
函数索引用 `ErbIndex`、限额用 `ZIP_EXTRACT_LIMITS` + 共享 contract 表、重名宽容用 `conventionPolicy`。
少一份实现，就少一处会漂的口径。
