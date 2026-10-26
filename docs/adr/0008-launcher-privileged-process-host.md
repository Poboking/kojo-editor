# ADR-0008: 启动器进程特权面与服务键边界 —— 宿主只认 `instanceId`，三张写授权表互不继承

- **日期**：2026-10-26
- **状态**：**已接受（设计口径定稿；实现未开工）**——本文只定边界与前置条件，不声称任何守卫已落地
- **相关**：[`LAUNCHER-ARCHITECTURE.md`](../LAUNCHER-ARCHITECTURE.md) v0.4 §2（原则 4/5/6/9）、§5.1、
  §7.2 命令表、§9.1 三档隔离、§13 安全模型、§16 风险 22、§17；ADR-0003（宿主只做 IO 原语）、
  ADR-0005（ERB 写权限口径）、ADR-0007（代码插件轨）

## 背景

启动器给编辑器带来一件此前不存在的能力：**启动一个进程**。同一批里还有第二件：
**在用户显式安装游戏插件时，往游戏目录写文件**。这两件事各自撞上铁律：

- 铁律 5：游戏目录整体只读，写入仅限用户批准的 `writablePaths` + 常驻可写根；
- 铁律 6：绕开写允许域只有一条法定通道 `exportFile`（对话框即授权，对话框与写盘同一 Rust 命令）；
- 铁律 1：内核 / 契约 / Rust 宿主零游戏名词（`audit:decoupling` A 项执法）。

现状有两条特权写路径：内核 io 的 `assertWritable` 闸（放行 `writablePaths` 与常驻可写根）、
`exportFile`（内核刻意不调 `assertWritable`，落点由系统保存对话框选定）。启动器安装插件 /
恢复存档要写游戏目录，于是出现**第三条**。若不说清它和另两条的关系，评审只能在两种错误里选一种：
把它想成「又开了一个任意写口子」，或者把它想成「复用现有写权限，没什么新东西」。

另外两个问题必须在同一处回答，因为它们共用一个信任面：

1. JS（含任何插件）能不能把一条 exe 路径交给宿主去执行？
2. 用户凭什么相信「启动的就是他信任的那个程序」？

## 决策

### 1. 特权面只有一个入口，且只认 `instanceId`

宿主命令表（§7.2）里有 `launcher_start({ instanceId })`，**没有**接受 `exePath` / 任意可执行路径
的命令，也没有 `launcher_exec` / `launcher_start_path` 这类形态。exe 的信任链分三段：

| 段 | 谁做 | 具体 |
|---|---|---|
| 提议 | adapter（`GameLaunchAdapter`） | `LaunchCandidate.executableRelativePath`，只是相对路径声明 |
| 落定 | 宿主 + core | 创建实例时写入 `instance.json`；`launcher_instance_update` **不允许** patch `sourceRoot` / `id` / `isolation`。可执行体相对路径能否经 patch 改动，实现批必须钉成「不可改」（换 exe = 重新信任 + 重新校验），本 ADR 不假设它已经如此 |
| 校验 | 宿主 | 启动前九步链（§13.2）：非空、非绝对、无 `..`、无盘符/UNC → 规范化后仍以 `gameRoot` 为前缀 → 逐段拒绝 reparse point → 常规文件 + 扩展名白名单（Windows 只 `.exe`，拒 `.bat/.cmd/.ps1/.lnk`）→ SHA-256 逐字相等 |

- **哈希由宿主算，JS 传的值一律忽略**（`LaunchExecutable.sha256` 注释即为契约）；
- **信任由原生确认框给出**（`launcher_trust_executable({ instanceId })`）：`ExecutableTrust.approvedBy`
  是固定字面量 `'native-dialog'`，不接受其他来源；
- 每次启动复算哈希，变化即 `LAUNCHER_TRUST_CHANGED`，不静默放行。

### 2. 三张写授权表：各自成表、互不继承

| 表 | 落点 | 谁能写 | 授权来源 | 执法点 | 典型拒绝 |
|---|---|---|---|---|---|
| 内核 `writablePaths` | 游戏项目内用户批准的若干子路径 | 编辑器（插件经 `kernel.io`） | 项目打开时用户显式批准（`ProjectService.approveWritablePaths`，按 `rootDir` 持久化） | `kernel/src/io.ts::assertWritable` | 写闸拒绝（不静默） |
| `exportFile` | **任意**，但由系统对话框当场选定 | 任意持 `PlatformBridge` 的插件 | 保存对话框本身（对话框与写盘在同一 Rust 命令内） | 宿主 `export_file`（内核不调 `assertWritable`，也不接受路径入参） | 平台桥缺席 / 用户取消 |
| 启动器 `launcher/approvals.json` | 实例游戏根内的**某个已授权内容根 / 存档根** | 启动器安装 / 恢复流程（宿主 + core 编排） | `launcher_pick_write_root({ instanceId, rootId })`：原生目录对话框 + **同一命令内**登记 | 每次 apply / restore 前复验「规范化后落在已授权的那一个根内」 | `LAUNCHER_SOURCE_NOT_APPROVED` |

- 启动器授权粒度 = **实例 × `rootId`**（`rootId` 来自 adapter 的 `ContentRootSpec` / `SaveRootSpec`），
  **不是**单文件、**也不是**「整个游戏目录可写」的总开关；新增一个 contentRoot 就要再批一次。
- 授权只增删于 `approvals.json`，用户在实例设置里逐条撤销；撤销后下一次 apply 立刻失效。
- 三张表唯一的共同点是同一条哲学：**对话框即授权、授权绑命令、JS 不拿落点决定权**。
  实现不共用（落点语义、粒度、撤销链都不同），共同点只在口径，不在代码。

### 3. 为什么不复用内核 `writablePaths`

复用看起来省事：安装插件时把目标根加进项目的 `writablePaths`，写盘照走 `kernel.io`。
但这样做的实际效果是——**编辑器（以及任何持 `PluginContext` 的插件）获得整棵游戏根的写权**，
而且是长期生效的：`approveWritablePaths` 按 `rootDir` 持久化，下次打开同一目录自动恢复。
这直接违反铁律 5，并且把「一次显式安装」偷换成「此后随便写」。

反向同样不成立：编辑器批准过某个口上目录，**不等于**启动器可写整个游戏根；两张表的粒度
（路径前缀 vs 实例 × rootId）与生命周期（项目会话 / 常驻批准 vs 实例存续）都不同，不能互相推导。

### 4. 宿主特权面不认识「插件」

游戏插件复用内容包的宿主命令：`launcher_content_plan / apply / uninstall / set_enabled /
set_order / diagnose` 的载荷里没有插件语义，宿主只认 `archivePath`、`planId`、`packId` 与文件清单；
**不新增任何插件命令，也不认识 ERB / CSV**。插件门禁（能力、兼容、函数冲突、存档影响、风险分级）
全部在 `launcher-core`（TS）里叠加。这样「装内容包」与「装插件」在特权面上是同一个动作：
把已知清单里的文件写进已授权的根。

### 5. 已知事实与边界（写进 ADR，不当已解决）

- **内核 io 的会话文本缓存是自校验的**：`kernel/src/io.ts` 每次读都比 `mtime + size`，任一项缺失或
  不等即判未命中。启动器绕过内核 io 直写游戏目录后，编辑器下一次读到的是盘上真相，不存在
  「编辑器拿着旧文本覆盖新文件」的缓存路径。**但**该判据本身分辨不了「同 size 同 mtime tick 的
  原地改写」——这是既有判据的已知上限，不是本 ADR 新引入的洞。
- **`fileWatch` 的根集合含 `project.rootDir` 整棵**（`packages/app/src/ui/use-project-session.ts`
  的 `fileWatch.start([project.rootDir, ...])`），不是只监视口上目录。所以安装写入的每个文件都会
  自然产生 `file.changed`；§10.1 第 [9] 步只发一条聚合的「计划已应用」，**不**逐文件重发
  （几百条会把 UI 打满）。
- **watcher 挡不住脏缓冲回写**：它只能说「盘上变了」，拦不住用户对旧缓冲按 Ctrl+S 把插件改动
  写回去。这条是 **P1 硬闸**（§16 风险 17：安装前查脏缓冲），不是本文能声称解决的问题。
- **Windows-first**：P0 只做 Job Object（`CREATE_SUSPENDED` → 挂 Job → `ResumeThread`，
  `KILL_ON_JOB_CLOSE`、禁 breakaway）。非 Windows **明确** `LAUNCHER_PLATFORM_UNSUPPORTED`，
  不做「看起来能跑」的 shell 兜底。
- **审计口径**：
  - 宿主 `packages/app/src-tauri/src/launcher/` 与契约 `packages/plugin-api/src/launcher.ts`
    零游戏名词——`audit:decoupling` A 项的 `NEUTRAL_DIRS` 已含 `packages/app/src-tauri/src`
    与 `packages/plugin-api/src`，新目录天然在闸内；
  - `audit:language` 的 M1 / M2 扫 `packages/app/src` **整树**（monaco + ui + 其余），不是只扫
    monaco 层；启动器视图落地后同样受这两条约束；
  - **一处尚未收编**：`audit:decoupling` A 项的中性目录只列到 `packages/app/src/ui`、
    `packages/app/src/monaco`、`packages/app/src/bridge`，而启动器视图落点
    `packages/app/src/launcher/` **不在**名单里。落地该视图的批次必须把它一并加进
    `NEUTRAL_DIRS`，否则启动器视图是 A 项的空白区（`audit:language` 的 M1/M2 已覆盖它，
    但 A 项的语言面约束不会自动生效）。

### 6. 发布前置条件（未解缺口，不是已实现）

在把 `launcher.service` **开放给第三方插件调用**之前，必须先补齐：

1. **调用方白名单 / 权限声明**：`launcher.service` 目前只是「一个服务键」，任何 `requires` 它的
   插件都能调用，没有按插件声明的能力面；
2. **调用方审计**：创建实例、信任 exe、安装/卸载内容包与游戏插件、申请写授权这四类动作，
   必须记录「哪个插件、什么时候、对哪个实例」发起，并能被用户查看；
3. **否则**：一个恶意编辑器插件可以「创建实例 → 调用 trust（仍会弹原生框）→ 启动」。
   用户仍是最后一道闸，但**不该把安全全部押在用户点「允许」上**——
   原生框只证明「用户看到了一条路径」，不证明「用户知道是谁在要」。

在 1 / 2 未落地之前，`launcher.service` 的消费方只有 `launcher-core` 与宿主自身；
任何第三方插件要调用它，先改本 ADR。

### 7. 需要并入铁律的一句话（**待并入 `AGENTS.md`，由组长落地**；本 ADR 不改 `AGENTS.md`）

> **启动器写授权是第三张表，且与内核 `writablePaths`、`exportFile` 互不继承**：实例 × `rootId`
> 逐根授权只由原生目录对话框写入 `launcher/approvals.json`（对话框与登记同一 Rust 命令），
> 启动器安装 / 恢复前必须复验目标落在已授权根内；JS 不拿落点决定权，也不得把游戏根写进内核 `writablePaths`。

## 备选方案（为何不选）

| 方案 | 为何不选 |
|---|---|
| 复用内核 `writablePaths`（安装时把目标根加进去） | 编辑器与全部插件获得整棵游戏根写权且按 `rootDir` 长期持久化，违反铁律 5；粒度与撤销语义也不同；否 |
| 给启动器一张「整个游戏目录可写」的实例级总开关 | 一次点击把整根交给之后所有调用方，逐根授权的意义归零；否 |
| 宿主提供 `launcher_start_path(exePath)`，由 TS 侧校验路径与哈希 | 校验与哈希都在 JS 侧，插件持有全权 context，等于让前端自证；否 |
| 信任不弹原生框，由 JS 传哈希 | `ExecutableTrust.approvedBy` 将失去证据意义，前端可伪造「用户已同意」；否 |
| 非 Windows 用 `sh -c` / `cmd /c` 兜底启动 | 无 Job Object 等价的杀树保证，且会造成「支持但不可靠」的假象；明确不支持更诚实；否 |
| 把三张表合并成一个「统一写授权服务」 | 三张表的落点语义与授权来源本质不同，强行合并要么降级为最大公倍数（任意路径参数），要么把对话框授权抽象成可编程接口；方向对，但属于另一次边界重划，须再立 ADR（§16 风险 22） |

## 后果与前置

**后果**：

- 三张表各有唯一执法点：`assertWritable`、`export_file` 命令、启动器 apply/restore 的根前缀复验。
  新增第三张以外的任何写通道，必须再立 ADR——不许以「反正也是对话框」为由顺手加。
- 服务键面即能力面：要启动必须显式 `requires` `launcher.service`，不靠 `kernel.io` 顺带获得。
- 启动器让「游戏目录在用户显式安装时会变」成为公开事实，因此 `ARCHITECTURE.md` §1.2 的非目标
  需要一行例外口径（见 ADR-0009 末尾的同一处引用）。

**前置**（未满足前不得宣称本 ADR 已落地）：

1. 宿主守卫与契约测试先于 UI（「先能启动、守卫后补」禁止）；
2. §13.2 九步链 + 原生信任框 + Job Object 的真壳验收（`smoke-tauri-ipc` / `debug-cli shell`，
   Web 调试宿的绿不作数）；
3. 发布给第三方插件调用前的调用方白名单与审计（决策 6）；
4. 安装前脏缓冲检查（P1 硬闸）；
5. `packages/app/src/launcher/` 收编进 `audit:decoupling` A 项中性目录；
6. 非 Windows 的 `LAUNCHER_PLATFORM_UNSUPPORTED` 有测试钉住，不做静默降级。

**明确不承诺**：游戏进程本身的沙箱（§1.3 非目标）；应用被强杀时 Job 句柄一定收尸（风险 11，
靠 `KILL_ON_JOB_CLOSE` + 下次启动清陈旧锁，不首版做外部守护进程）。
