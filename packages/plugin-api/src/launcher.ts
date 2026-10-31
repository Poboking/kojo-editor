/**
 * 启动器契约 —— 实例 / 启动描述 / 运行时 / 内容包与游戏插件 / 进程·任务·日志 / 错误。
 *
 * 规格真源：`docs/LAUNCHER-ARCHITECTURE.md` v0.4 §5（数据模型）、§6（核心接口）、§7.1（宿主约定）、§17。
 *
 * ## 本文件的硬纪律（改之前先读）
 *
 * 1. **type-only，零值导出**。这里连一个 `const` / `function` / `enum` 都不许有：
 *    `index.ts` 被 `bootstrap.ts` 静态引入，整包住开机图里；桶里出现任何**值**导出，
 *    本文件（几十 KB）就会跟着上欢迎页。错误码、限额、模板清单一律只做 `type`，
 *    运行期表（中文话术、分档限额、模板下拉）归消费方（`launcher-core` / 宿主）。
 * 2. **限额不在这里定义第二套**：ZIP 三档限额的单源是 `zip.ts::ZIP_EXTRACT_LIMITS`
 *    （派生自 `market.ts` 的契约常量），跨语言判据住
 *    `fixtures/zip-roundtrip/contract.json`。本文件只**引用类型** `ZipContractLimits`，
 *    给「逐调用换档」留一个参数位，不复制数值（§10.7）。
 * 3. **零游戏知识**：代码行里只许出现 instance / runtime / content / plugin / save / log
 *    这类通用词。哪个 exe 可启动、清单叫什么名、函数怎么排序，全部来自 adapter 的
 *    `GameLaunchAdapter`（§6.1）；内核、本契约、宿主都不认识具体值（`audit:decoupling` A 项）。
 * 4. **路径参数纪律**：契约里凡是「落点」都只有三种形态——实例根内的**相对路径**、
 *    宿主按 appData **现算**的目录、或**原生对话框即授权**的返回值。没有任何接口接受
 *    「目标绝对路径」来做越界写（§7.1、§13.3）。
 */

import type { Unsubscribe } from './base';
import type { ZipContractLimits } from './zip';

/* ══════════════════════════════════════════════════════════════════════════════
 * §5.1 实例
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 实例与游戏目录的关系三档（§9.1） */
export type IsolationMode = 'shared' | 'copy' | 'overlay';

/** 实例自身的**磁盘/配置**状态，与进程运行状态正交（运行态见 `ProcessState`） */
export type InstanceState = 'preparing' | 'ready' | 'broken' | 'removing';

/**
 * 实例清单（`instance.json` 的形状）。
 *
 * 路径字段的两条规则：`sourceRoot` 是**用户选择的绝对源根**（只由原生目录对话框写入
 * 批准表），`executable.relativePath` 一律相对 `gameRoot`；`instanceRoot` / `gameRoot`
 * 由宿主按当前 `{appData}` **现算**、不持久化——应用数据目录搬家后实例不该整批失效。
 */
export interface LauncherInstance {
  /** 宿主生成的 UUID；**永不重用**（日志、备份、任务都按它索引） */
  readonly id: string;
  /** 用户可见名；可重名，不参与寻址 */
  name: string;
  /** adapter 插件 id（仅作标识，内核不解释） */
  readonly adapterId: string;
  /** adapter 自报的稳定游戏 id；内核不解释 */
  readonly gameId: string;
  /** ISO-8601 */
  readonly createdAt: string;
  updatedAt: string;

  /** 用户最初选择的游戏根：shared 实例启动时直接用它；copy 实例仅作修复来源 */
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
  /** 来自 adapter 的布局，随实例快照（启动器只在授权后写回） */
  saveRoots: readonly SaveRootSpec[];
  contentRoots: readonly ContentRootSpec[];

  readonly executableTrust: ExecutableTrust | null;
  launchCount: number;
  lastLaunchedAt: string | null;
  lastExit: ExitRecord | null;

  notes?: string;
  tags?: readonly string[];
  /** 实例清单结构版本（迁移用） */
  readonly schemaVersion: number;
}

/**
 * 启动目标（exe + argv + 环境追加）。
 *
 * 路径**只能是相对 `gameRoot` 的路径**：绝对路径 / `..` / 盘符 / UNC 一律非法（宿主逐条判）。
 * `sha256` 由宿主在创建/信任时算好写回，JS 传的值一律忽略。
 */
export interface LaunchExecutable {
  /** 相对 gameRoot 的路径；绝不允许绝对路径、`..`、盘符、UNC */
  readonly relativePath: string;
  /** 直接 argv，不经 shell */
  args: readonly string[];
  /** 仅显式追加项；宿主另有最小环境白名单（不是整份环境替换） */
  env: Readonly<Record<string, string>>;
  windowMode: 'auto' | 'visible' | 'hidden';
  /** 宿主在创建/信任时计算并写入；JS 传入值一律忽略 */
  readonly sha256: string | null;
}

/**
 * 可执行文件信任记录。
 *
 * 哈希与「用户批准」必须成对：`approvedBy` 固定 `'native-dialog'`——证明来源只有宿主
 * 原生确认框一条路，JS 不能传哈希、也不能跳过确认（§13.2）。
 */
export interface ExecutableTrust {
  readonly sha256: string;
  readonly size: number;
  readonly approvedAt: string;
  readonly approvedBy: 'native-dialog';
}

/** 一次会话的退出记录（`reason` 是崩溃摘要与「意外退出」提示的判据） */
export interface ExitRecord {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly reason: 'clean' | 'user' | 'crash' | 'app-exit' | 'killed' | 'unknown';
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §5.2 启动描述（adapter 产出，core 消费）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** `probe()` 的一个可启动候选；一个都没有 = 该目录不能作为实例 */
export interface LaunchCandidate {
  /** adapter 内稳定 id（如按架构档位分的两三个） */
  readonly id: string;
  /** 用户可见标签 */
  readonly label: string;
  readonly executableRelativePath: string;
  readonly arch?: 'x64' | 'x86' | 'arm64' | 'any';
  readonly runtime?: RuntimeRequirement;
  readonly notes?: string;
}

/**
 * 候选 + 用户选项编译出的完整启动描述。`cwdRelative` 相对 `gameRoot`（默认 `.`）；
 * 存档/内容根同样只给相对路径——绝对化是宿主的事，core 不拼绝对路径。
 */
export interface LaunchProfile {
  readonly candidateId: string;
  readonly executable: LaunchExecutable;
  /** 默认 `'.'`；相对 gameRoot */
  readonly cwdRelative: string;
  readonly runtime?: RuntimeRequirement;
  readonly locale?: LocaleProfile;
  readonly encoding?: EncodingProfile;
  readonly saveRoots: readonly SaveRootSpec[];
  readonly contentRoots: readonly ContentRootSpec[];
  readonly warnings?: readonly string[];
}

/** 存档根：`format` 只是给上层挑解析器的标签，宿主不解释 */
export interface SaveRootSpec {
  readonly id: string;
  readonly label: string;
  readonly relativePath: string;
  /** 格式标签只是给上层选解析器，宿主不解释 */
  readonly format?: string;
  /** shared 实例默认 false：读可以，写回需显式目录授权（§9.1） */
  readonly writableInShared: boolean;
}

/**
 * 内容根：装包的唯一落点集合。
 *
 * `kind` 是**UI 分组与风险提示**用的标签，core 不解释语义；`accepts` 是 adapter 声明的
 * 可接受包类型，core 只做校验（`plugin` 类型同样要在此显式列出，否则插件无处可落）。
 */
export interface ContentRootSpec {
  readonly id: string;
  readonly label: string;
  readonly relativePath: string;
  /**
   * 根的内容类别。`script` / `data` / `resource` **都可能是游戏逻辑文件**
   * （脚本、数据表、引擎资源），`plugin` = adapter 声明的插件专用安装根。
   */
  readonly kind: 'script' | 'resource' | 'data' | 'plugin';
  /** 该根接受的包类型；adapter 声明，core 校验 */
  readonly accepts: readonly ContentPackKind[];
  /**
   * shared 实例下是否允许写。默认 false；true 表示「授权后可写」——仍需用户在原生
   * 目录对话框里逐根批准，不是无条件写。
   */
  readonly writableInShared: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §5.3 运行时 / 语言环境
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 已登记（或已解析）的运行时。`kind` 是自由字符串（`core` 不解释） */
export interface RuntimeRef {
  readonly id: string;
  /** `'engine'` / 解释器 / 包装器…；core 不解释 */
  readonly kind: string;
  readonly version: string;
  readonly arch: 'x64' | 'x86' | 'arm64' | 'any';
  /** 托管运行时根，或实例内运行时根 */
  readonly rootPath: string;
  readonly source: 'managed' | 'instance' | 'external';
  readonly verified: RuntimeVerification | null;
}

/** adapter 对运行时的需求（首版只支持精确版本或 `'*'`；范围解析 P2） */
export interface RuntimeRequirement {
  readonly kind: string;
  /** 首版只支持精确版本或 `'*'`；范围解析 P2 */
  readonly versionRange?: string;
  readonly arch?: 'x64' | 'x86' | 'arm64' | 'any';
  /** 可选运行时缺席不拦启动，只提示 */
  readonly optional?: boolean;
}

/** 运行时校验读数（`missing` / `mismatched` 分列，便于 UI 给两种修法） */
export interface RuntimeVerification {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];
}

/**
 * 语言/区域配置。
 *
 * **诚实边界**：Windows 没有「按进程切系统 ANSI 代码页」的官方原生 API。首版只做
 * 环境变量提示与记录；真正的区域模拟需要第三方包装器，属 P2 且须单独评审。
 */
export interface LocaleProfile {
  /** inherit = 跟随系统；explicit = 只为子进程设置以下环境提示 */
  readonly mode: 'inherit' | 'system' | 'explicit';
  /** BCP-47，如 `'ja-JP'` */
  readonly language?: string;
  /** 仅作记录与日志；不承诺进程内生效 */
  readonly codepage?: number;
}

/** 日志/文本解码策略（`auto` = 先探 BOM/UTF-8，再退回 `fallback`） */
export interface EncodingProfile {
  readonly mode: 'auto' | 'fixed';
  /** 如 `'utf-8'` / `'shift_jis'` / `'utf-16le'` */
  readonly fallback: string;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §5.4 内容包与游戏插件清单
 *
 * **一个清单，两档语义**：内容包（`kind !== 'plugin'`）与游戏插件（`kind === 'plugin'`）
 * 共用同一份磁盘格式与同一条安装管线（暂存 → 计划 → 应用 → 回滚）；插件只是多声明了
 * 能力、兼容性与逻辑影响。不为插件另造第二套包格式——否则两条路径会各自演化。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 包类型：前四种是落点类别，`bundle` = 整合包（P2） */
export type ContentPackKind = 'script' | 'resource' | 'data' | 'plugin' | 'bundle';

/** 插件对游戏逻辑的**声明式**能力面；core 只校验与展示，不解释语义 */
export type PluginCapability =
  /** 只追加文件（不改既有文件） */
  | 'add-content'
  /** 覆盖/替换既有脚本函数 */
  | 'override-functions'
  /** 注册新命令/新入口 */
  | 'add-commands'
  /** 修改数据表 */
  | 'modify-data'
  /** 替换图片/音频等资源 */
  | 'replace-resources';

/**
 * 制品清单（包内 `pack.json` 的形状；由 `PluginProjectService` 构建时**算出**，作者不手写）。
 *
 * `schemaVersion` 是**字面量 1**：结构一变就是新版本号 + 迁移，不做「可选字段悄悄扩」。
 */
export interface ContentPackManifest {
  readonly schemaVersion: 1;
  /** `'author.pack-name'` 形态，全局稳定 */
  readonly id: string;
  readonly name: string;
  /** 精确版本；首版不做 semver 范围 */
  readonly version: string;
  readonly kind: ContentPackKind;
  /** 必须与实例的 `gameId` 一致，否则拒装 */
  readonly gameId: string;
  readonly files: readonly ContentFileEntry[];
  /** 排序权重；仅当 adapter 的 `orderSource = 'manifest'` 时生效，同值按安装顺序 */
  readonly loadOrder: number;
  readonly requires?: readonly { id: string; version: string }[];
  readonly conflicts?: readonly string[];
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly description?: string;

  // ── 以下仅 kind='plugin' 有意义；内容包填了也按插件处理（宁可多一道闸） ──
  /** 声明的能力面；缺省 = 最保守的 `['add-content']` */
  readonly capabilities?: readonly PluginCapability[];
  /** 面向的游戏版本；由 adapter 的 `pluginRules.isCompatible` 判定，core 只搬运 */
  readonly gameVersion?: string;
  /** 插件 API 版本（作者编写时面向的 SDK 契约版本） */
  readonly apiVersion?: string;
  /** 对存档的影响声明；缺省 `'unknown'`（按最坏情况处理：装前备份） */
  readonly saveImpact?: 'none' | 'possible' | 'unknown';
  /** 加载入口（根 + 相对路径）；含义由 adapter 解释 */
  readonly entrypoints?: readonly ContentFileRef[];
}

/** 一个待安装文件：目标根 + 相对该根的 posix 路径 + 内容摘要 */
export interface ContentFileEntry {
  /** 目标根 id（来自 `ContentRootSpec.id`）；一个包可跨多个根安装 */
  readonly rootId: string;
  /** 相对该根的 posix 路径 */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** 指向某个 contentRoot 内的一个文件；计划、ownership、冲突决议共用这一形状 */
export interface ContentFileRef {
  readonly rootId: string;
  readonly path: string;
}

/**
 * **作者源清单**（项目内 `plugin.json`）。与 `ContentPackManifest` 的分工：
 *
 * - 源清单**没有** `files[]` / 哈希——开发者不该手写哈希，出现哈希一律视为非法
 *   （防伪造验收）；`files[]` 由构建时逐文件算出；
 * - 源清单多一个 `roots[]` 映射：说明制品内哪些目录落到哪个内容根；
 * - 构建时由 `PluginProjectService` 展开为 `pack.json`（`ContentPackManifest`），
 *   源清单本身不随包分发。
 *
 * 校验规则与 `ContentPackManifest` 同源（id 字符集、版本、能力、gameId），
 * 但**不要求** `files[]`。故两者形状刻意不互相 assignable（见契约测试的窄化断言）。
 */
export interface PluginSourceManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** 源清单**恒**为插件（内容包没有源码项目形态） */
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
  /** 加载入口（**源清单内**的相对路径；构建时换算成目标根内的 `ContentFileRef`） */
  readonly entrypoints?: readonly string[];
  /** 源文件到目标根的映射（逐条见 `PluginSourceRootMap`）；至少一条 */
  readonly roots: readonly PluginSourceRootMap[];
}

/** 源清单的一条根映射：制品内目录 → 目标内容根目录 */
export interface PluginSourceRootMap {
  readonly rootId: string;
  /** 制品内相对目录（posix；必须存在） */
  readonly from: string;
  /** 目标根内相对目录；缺省 `''`（直接放在根下） */
  readonly to?: string;
  /** 相对 `from` 的 include glob；缺省 = 全部 */
  readonly include?: readonly string[];
  /** 相对 `from` 的 exclude glob；缺省 = 不排除 */
  readonly exclude?: readonly string[];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §5.5 进程 / 任务 / 日志
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 进程状态机（迁移规则见 §8；`crashed` 与 `exited` 分开是为了崩溃摘要） */
export type ProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'crashed';

/**
 * 单个实例的进程读数。
 *
 * 这是**快照**（不可变形状、可整份序列化过 IPC）：增量更新走 `subscribe` 推同形状。
 * `lastError` 与 `exitReason` 并存，是因为「为什么停」与「停时出了什么错」是两件事。
 */
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

/** 可跟踪任务的类别（任务中心按此分组与显示；新增类别须同步 `TaskKind` 的消费方） */
export type TaskKind =
  | 'instance-copy'
  | 'instance-duplicate'
  | 'content-install'
  | 'content-uninstall'
  | 'content-toggle'
  | 'plugin-install'
  | 'plugin-uninstall'
  | 'plugin-toggle'
  | 'plugin-update'
  | 'plugin-build'
  | 'plugin-extract'
  | 'save-backup'
  | 'save-restore'
  | 'save-import'
  | 'download'
  | 'verify'
  | 'repair'
  | 'bundle-import'
  | 'bundle-export';

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * 一条后台任务。
 *
 * `result` 按 `kind` 收窄，UI **只在对应 kind 下读**（不做跨 kind 的字段猜读）；
 * `progress` 为 null = 该任务没有可报进度（如只读校验）。
 */
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

/** 一次游戏运行会话（日志按会话切分，崩溃摘要按会话取行） */
export interface LogSession {
  readonly id: string;
  readonly instanceId: string;
  readonly startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** 一行日志（已解码；原始字节不过契约，见 §7.3 的 IPC 载荷） */
export interface LogLine {
  readonly ts: number;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly text: string;
  readonly location?: LogLocation;
}

/**
 * 日志里的源位置。
 *
 * **只认相对 `gameRoot` 的路径**：绝对路径会把用户目录带进编辑器（跳转链接、诊断包、
 * 面板标题都会泄露），宿主在解析阶段就转成相对形态。
 */
export interface LogLocation {
  /** 相对 gameRoot 的路径；core 只认这个形态 */
  readonly relativePath: string;
  readonly line?: number;
  readonly column?: number;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §5.6 错误
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 启动器错误码全集（宿主 DTO 与 TS 侧共用）。
 *
 * **只做类型，不做运行期表**：中文话术、可重试默认值、折叠显示的细节格式都由消费方
 * （`launcher-core` 的错误展示层）决定。契约层多一张表 = 开机图多一份字面量，且第二份
 * 真源迟早与宿主 `LauncherErrorDto` 漂开。
 */
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
  /** 函数级 / 文件级冲突未决议 */
  | 'LAUNCHER_PLUGIN_CONFLICT'
  /** gameVersion / apiVersion 不满足 */
  | 'LAUNCHER_PLUGIN_INCOMPATIBLE'
  /** requires / conflicts 未满足 */
  | 'LAUNCHER_PLUGIN_DEPENDENCY'
  /** 存档影响未确认或备份失败 */
  | 'LAUNCHER_PLUGIN_SAVE_RISK'
  /** 发布者未在信任链中（P2） */
  | 'LAUNCHER_PLUGIN_UNTRUSTED'
  /** `plugin.json` / 源目录结构不合法 */
  | 'LAUNCHER_PLUGIN_PROJECT_INVALID'
  /** 同工作区已有相同 pluginId 的项目 */
  | 'LAUNCHER_PLUGIN_PROJECT_EXISTS'
  /** 构建失败（映射逃逸、重复目标、读失败） */
  | 'LAUNCHER_PLUGIN_BUILD_FAILED'
  /** 从已装插件提取项目失败 */
  | 'LAUNCHER_PLUGIN_EXTRACT_FAILED'
  | 'LAUNCHER_SAVE_RESTORE_FAILED'
  | 'LAUNCHER_DOWNLOAD_REJECTED'
  | 'LAUNCHER_TASK_CANCELLED'
  | 'LAUNCHER_TASK_BUSY'
  | 'LAUNCHER_SCHEMA_UNSUPPORTED'
  | 'LAUNCHER_PLATFORM_UNSUPPORTED'
  | 'LAUNCHER_INTERNAL';

/** 结构化错误（宿主 `LauncherErrorDto` 与本形状逐字相同） */
export interface LauncherError {
  readonly code: LauncherErrorCode;
  /** 面向用户的中文人话；禁止直接透传 OS 英文错误串 */
  readonly message: string;
  /** 面向排障的细节（路径、退出码、条目名），可折叠显示 */
  readonly detail?: string;
  readonly retryable: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.1 GameLaunchAdapter —— 游戏启动知识的唯一住处
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 由 adapter 插件实现，挂在 `GameAdapter.launch?`。
 * 内核、`launcher-core`、宿主都不认识这里的任何具体值。
 *
 * 缺席 = 该游戏只能编辑、不能启动（实例库不显示「新建实例」）。
 */
export interface GameLaunchAdapter {
  /** 扫出可启动候选；一个都没有 = 该目录不能作为实例 */
  probe(rootDir: string): Promise<readonly LaunchCandidate[]>;

  /** 把候选 + 用户选项编译成完整启动描述；此处定目标程序、cwd、args、存档/内容根 */
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
   * 清单文件名、加载顺序、函数分析回调等**全部**在这里。
   */
  readonly pluginRules?: GamePluginRules;

  /** 日志行解析：错误定位、格式识别；不给 = 只做纯文本 */
  readonly logRules?: LogParseRules;

  /** 日志默认编码；不给 = auto */
  readonly defaultEncoding?: EncodingProfile;

  /** 创建 copy 实例时跳过的相对路径（缓存、临时文件等） */
  readonly copyExclude?: readonly string[];
}

/** `buildProfile` 的用户选项（全部可选；缺省由 adapter 自决） */
export interface LaunchBuildOptions {
  readonly includeSaves?: boolean;
  readonly runtimeId?: string | null;
  readonly locale?: LocaleProfile;
  readonly encoding?: EncodingProfile;
}

/** 存档布局：根清单 + 条目显示规则（不给显示规则 = 用文件名） */
export interface SaveLayoutSpec {
  readonly roots: readonly SaveRootSpec[];
  readonly listRule?: {
    readonly extensions: readonly string[];
    readonly labelFromFileName?: boolean;
  };
}

/** 日志行解析回调（纯函数；认不出就返回 null，不猜） */
export interface LogParseRules {
  /** 从一行日志里认出「哪个文件第几行」；认不出返回 null */
  parseLocation(line: string): LogLocation | null;
  /** 是否算错误行（用于崩溃摘要与筛选） */
  isErrorLine?(line: string): boolean;
  /** 该行是否属于噪声（进度条、重复空行） */
  isNoiseLine?(line: string): boolean;
}

/**
 * 游戏插件的**全部游戏侧知识**。只有 adapter 能提供；`launcher-core` 把它当不透明配置用。
 * 这里没有一条规则写死具体清单名或目录名——全部来自 adapter 实现。
 */
export interface GamePluginRules {
  /** 插件可安装的根（通常是 `contentRoots` 的子集，一致性由 adapter 保证） */
  readonly roots: readonly ContentRootSpec[];
  /** 插件清单文件名（可多候选，按序取第一个命中的） */
  readonly manifestNames: readonly string[];
  /**
   * 同一根内多插件的加载顺序来源：
   * - `manifest`：清单里的 `loadOrder`（默认）；
   * - `directory`：目录名排序（游戏自己按目录扫描时用）；
   * - `filename`：文件名前缀排序（前缀约定由 adapter 解释）。
   */
  readonly orderSource: 'manifest' | 'directory' | 'filename';
  /** 游戏版本 / 插件 API 版本兼容判定；不给 = 不判定（只显示清单声明） */
  isCompatible?(ctx: PluginCompatibilityContext): boolean;
  /** 装/卸/启停后是否必须重启游戏才生效 */
  readonly requiresRestart: boolean;
  /** 插件的存档影响默认值；清单未声明时用这个 */
  readonly saveImpact: 'none' | 'possible' | 'unknown';
  /**
   * 函数级分析回调：**由 adapter 实现**，`launcher-core` 只拿「归一化名 + 相对路径 +
   * 行号」做比对，不认识任何语言或语法。
   *
   * 产物形状与 `erb.ts::ScriptFunctionDefinition` 对齐（ERB 系 adapter 直接投影函数索引
   * 即可；非 ERB 游戏自行映射到同一形状）。`baseDir` = 解析基准（游戏根 / 插件 payload
   * 根），`files` 为相对路径。
   *
   * **解析失败必须抛错**（计划阶段失败可见），不许返回空数组假装没有函数——
   * 空数组等于「无冲突」，那是最危险的假绿。
   * 缺席 = 该游戏不做函数级冲突分析，只做文件级。
   */
  readonly analyzeFunctions?: (
    baseDir: string,
    files: readonly string[],
  ) => Promise<readonly ScriptFunctionDefinition[]>;
  /**
   * 新插件项目的骨架生成（模板）。
   *
   * **只返回内容，不写盘**：adapter 产出「相对制品根的路径 → 内容」，由
   * `PluginProjectService` 经 `kernel.workspaces` 写入工作区——写授权永远留在 core 一侧。
   * 生成结果**不得**包含源清单：清单由 core 按向导输入生成，避免清单双真源。
   * 缺席 = 该游戏只能创建空白项目（向导仍可用，模板下拉只有「空白」）。
   */
  readonly scaffold?: (options: PluginScaffoldOptions) => Promise<PluginScaffoldResult>;
}

/**
 * 模板标识（游戏无关的通用枚举）。
 *
 * **只做类型**：各 adapter 决定自己实现哪几个，未实现的模板不显示在向导里
 * （`pluginRules.scaffold` 缺席 ⇒ 只剩 `blank`）。下拉选项由 UI 侧从实现清单派生，
 * 契约层不留运行期列表（否则「哪些模板真的可用」会出现第二份答案）。
 */
export type PluginTemplateId =
  /** 仅清单 + 空目录 + README */
  | 'blank'
  /** 追加文件（最保守） */
  | 'add-content'
  /** 覆盖/替换既有函数 */
  | 'override-functions'
  /** 新增命令/入口 */
  | 'add-commands'
  /** 修改数据表 */
  | 'data-patch'
  /** 替换图片/音频资源 */
  | 'resource-pack';

/** 骨架生成的输入（向导带入；模板据此写注释或版本约束，不做判定） */
export interface PluginScaffoldOptions {
  readonly template: PluginTemplateId;
  readonly pluginId: string;
  readonly displayName: string;
  readonly gameId: string;
  readonly capabilities: readonly PluginCapability[];
  /** 目标实例的游戏版本（可空：新建时实例可能尚未就绪） */
  readonly gameVersion: string | null;
}

/** 骨架生成的结果（**只含内容**；写盘由 core 经工作区服务完成） */
export interface PluginScaffoldResult {
  /** 相对制品根的 posix 路径 → 文本内容 */
  readonly files: Readonly<Record<string, string>>;
  /** 二进制资源（图片/音频）；core 用 `io.writeBytes` 补写 */
  readonly binaryFiles?: Readonly<Record<string, Uint8Array>>;
  /** 人类可读的生成说明（写进项目 README 的「模板生成」段） */
  readonly report: readonly string[];
}

/** 函数定义的最小形状（函数级冲突比对用；`path` 相对 `baseDir`） */
export interface ScriptFunctionDefinition {
  /** 函数标识（原样；只用于展示与日志） */
  readonly name: string;
  /**
   * 归一化名（大小写无关的引擎必须给）。
   * **冲突比对一律用这一栏**——拿原样名比会漏掉同一函数的大小写变体。
   */
  readonly normalizedName: string;
  /** 相对 baseDir 的 posix 路径 */
  readonly path: string;
  readonly line: number;
}

/** 兼容判定的输入（adapter 自行判定，core 只搬运） */
export interface PluginCompatibilityContext {
  readonly gameVersion: string | null;
  readonly pluginGameVersion: string | null;
  readonly pluginApiVersion: string | null;
  /** 实例当前的 adapter / 游戏标识，供 adapter 自行判定 */
  readonly gameId: string;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.2 LauncherService —— 插件 `launcher-core` 提供（服务键 `launcher.service`）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 启动器的总门面。
 *
 * 拆分理由（不是「为了整齐」）：每个子服务各自对应一条**能力面**（磁盘 / 进程 / 运行时 /
 * 内容 / 插件 / 源码项目 / 存档 / 日志 / 任务），UI 只取真用到的那几条；宿主侧也按同一
 * 切分登记命令。塞成一个巨型接口会让「谁有写权」再次变成一团。
 */
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

  /** P2；首版返回 `LAUNCHER_PLATFORM_UNSUPPORTED` 或省略 */
  readonly updates?: LauncherUpdateService;

  /** 插件激活时调用：读注册表、做 schema 迁移、恢复上次会话的崩溃记录 */
  initialize(): Promise<void>;

  /** 插件失活时调用：停任务、断开事件；**不杀游戏进程**（由宿主 app-exit 统一收尸） */
  dispose(): Promise<void>;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.3 InstanceStore
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 实例库。
 *
 * **来源根批准表只有一处写入口**：原生目录对话框（`launcher_pick_source_root`）。
 * 因此 `create` 拿到的 `sourceRoot` 是**已被批准**的绝对路径，而不是 JS 随便给的路径；
 * 本接口没有任何「改 sourceRoot / 改 id / 改 isolation」的方法（patch 也不许改）。
 */
export interface InstanceStore {
  list(): Promise<readonly LauncherInstance[]>;
  get(id: string): Promise<LauncherInstance | null>;

  /** 概况：目标程序是否存在/是否被篡改、运行时是否解析成功、磁盘占用、警告 */
  inspect(id: string): Promise<InstanceInspection>;

  /**
   * 创建实例。
   * - `sourceRoot` 必须已在宿主「来源根批准表」中（只由原生目录对话框写入）；
   * - `candidateId` 来自 `adapter.probe`（JS 不直接给目标程序路径）；
   * - copy 实例排队一个复制任务；shared 实例立即就绪。
   */
  create(req: CreateInstanceRequest): Promise<InstanceCreation>;

  update(id: string, patch: InstancePatch): Promise<LauncherInstance>;

  /** `deleteFiles = false` 只移出库；true 删除实例目录（先停进程、先确认） */
  remove(id: string, opts?: RemoveInstanceOptions): Promise<void>;

  /** 复制实例；copy-to-copy 只复制实例目录，shared-to-copy 从源根复制 */
  duplicate(id: string, name?: string): Promise<InstanceCreation>;

  subscribe(listener: (change: InstanceChange) => void): Unsubscribe;

  /** P2：整合包 */
  importBundle?(archivePath: string, opts?: ImportBundleOptions): Promise<InstanceCreation>;
  exportBundle?(id: string, opts?: ExportBundleOptions): Promise<string | null>;
}

/** 创建实例的请求（`sourceRoot` 是**已被批准的源根**，非目标程序路径） */
export interface CreateInstanceRequest {
  readonly name: string;
  readonly sourceRoot: string;
  readonly adapterId: string;
  readonly gameId: string;
  readonly candidateId: string;
  readonly isolation: IsolationMode;
  /** copy 实例默认 false：全新存档 */
  readonly includeSaves?: boolean;
  readonly runtimeId?: string | null;
  readonly locale?: LocaleProfile;
  readonly encoding?: EncodingProfile;
  readonly notes?: string;
}

/**
 * 实例的可改字段白名单（**结构性不可改**：`id` / `sourceRoot` / `isolation` / `gameId`）。
 *
 * `executableRelativePath` 是「换个游戏内程序」的唯一入口，改后信任作废、须重新确认；
 * 它仍是**相对 gameRoot** 的路径，不是任意绝对路径。
 */
export interface InstancePatch {
  name?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  locale?: LocaleProfile;
  encoding?: EncodingProfile;
  executableRelativePath?: string;
  runtimeId?: string | null;
  notes?: string;
  tags?: readonly string[];
}

/** 创建结果：`task` 非空 = 后台还在复制（copy / duplicate） */
export interface InstanceCreation {
  readonly instance: LauncherInstance;
  readonly task: LauncherTask | null;
}

/** 实例概况（详情页一次取全；`warnings` 是人话行，不是错误码） */
export interface InstanceInspection {
  readonly instance: LauncherInstance;
  readonly executable: {
    /** 宿主现算的绝对路径（**只读展示**，不作为任何写参数回传） */
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

/** 实例变更通知（UI 局部刷新，不整表重拉） */
export interface InstanceChange {
  readonly kind: 'created' | 'updated' | 'removed' | 'state';
  readonly instanceId: string;
}

/** P2 整合包导入选项（首版无消费方，形状先定） */
export interface ImportBundleOptions {
  /** 导入后的显示名；缺省 = 包内清单的名字 */
  readonly name?: string;
  /** 是否随包带入存档；缺省 false */
  readonly includeSaves?: boolean;
}

/** P2 整合包导出选项 */
export interface ExportBundleOptions {
  /** 是否打包存档（含隐私）；缺省 false */
  readonly includeSaves?: boolean;
  /** 是否附带实例配置（locale / args 等）；缺省 true */
  readonly includeConfig?: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.4 ProcessSupervisor
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 进程监督。
 *
 * `start` **只接受实例 id**：目标程序、参数、工作目录全部来自已登记实例 + adapter 的
 * 启动描述，调用方给不了任何路径。这是「进程特权关进宿主」在契约层的第一道形状约束。
 */
export interface ProcessSupervisor {
  /**
   * 启动已登记实例。
   * 校验链（宿主内）：实例存在 → ready → 目标程序在 gameRoot 内 → 常规文件 →
   * 信任哈希匹配 → 运行时已解析 → 每实例锁空闲 → 创建进程。
   * @throws LauncherError（TRUST_REQUIRED / TRUST_CHANGED / EXECUTABLE_INVALID /
   *         RUNTIME_MISSING / INSTANCE_BUSY / INSTANCE_NOT_READY）
   */
  start(id: string): Promise<ProcessStatus>;

  /** force = 直接杀进程树；否则先尝试窗口关闭，超时再杀 */
  stop(id: string, opts?: StopOptions): Promise<ProcessStatus>;

  status(id: string): ProcessStatus;
  list(): readonly ProcessStatus[];

  /**
   * 首次信任 / 目标程序变更后的重新信任。
   * 宿主自己算哈希，并在**同一个命令内**弹原生确认框；JS 不能传哈希、不能跳过。
   */
  trust(id: string): Promise<ExecutableTrust>;

  subscribe(listener: (status: ProcessStatus) => void): Unsubscribe;
}

export interface StopOptions {
  readonly force?: boolean;
  /** 超时上限；缺省取适配器/宿主的内部档位（契约层不留常量） */
  readonly timeoutMs?: number;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.5 RuntimeManager
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 运行时管理（登记的运行时根只许是托管根；导入走对话框即授权） */
export interface RuntimeManager {
  list(): Promise<readonly RuntimeRef[]>;
  /** 只读扫描（不登记） */
  scan(rootDir: string): Promise<readonly RuntimeRef[]>;

  /** 原生目录对话框 + 同命令登记，JS 不传路径（照工作区根授权的形态） */
  importFromDialog(): Promise<RuntimeRef | null>;

  resolve(instanceId: string): Promise<RuntimeRef | null>;
  verify(id: string): Promise<RuntimeVerification>;
  /** 只删托管运行时根 */
  remove(id: string): Promise<void>;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.6 ContentManager
 *
 * 只处理 `kind !== 'plugin'` 的包；`kind === 'plugin'` 一律走 `PluginManager`。
 * 两者共用落盘管线，但插件的门禁不可绕过（见 §6.7 的说明）。
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ContentManager {
  list(instanceId: string): Promise<readonly InstalledContent[]>;

  /**
   * 只读预检：解到暂存、校验清单、算冲突；**不碰实例**。返回 planId 供确认后应用。
   *
   * `opts.limits` 是**逐调用换档**位：缺省即 `zip.ts::ZIP_EXTRACT_LIMITS` 那一档，
   * 本契约不复制任何数值（§10.7 的单源纪律）。
   */
  planInstall(
    instanceId: string,
    archivePath: string,
    opts?: InstallPlanOptions,
  ): Promise<ContentInstallPlan>;

  /** 用户确认后真正落盘；返回可跟踪的任务 */
  applyInstall(
    planId: string,
    resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask>;

  uninstall(instanceId: string, packId: string): Promise<LauncherTask>;
  setEnabled(instanceId: string, packId: string, enabled: boolean): Promise<LauncherTask>;
  /** 只接受已安装 id 的排列 */
  setOrder(instanceId: string, packIds: readonly string[]): Promise<void>;
  diagnose(instanceId: string): Promise<ContentDiagnosis>;
}

/**
 * 安装预检的选项。
 *
 * `limits` 直接复用 `zip.ts::ZipContractLimits`：需要不同档位时**只覆盖这一次调用**，
 * 不改全局、也不在这里另立一套限额常量。
 */
export interface InstallPlanOptions {
  /** 本次解包的限额档位；缺省 = `ZIP_EXTRACT_LIMITS` */
  readonly limits?: ZipContractLimits;
}

/** 内容包安装计划（**只读产物**；`expiresAt` 过期即作废，避免陈旧 applies） */
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
  /** 暂存计划过期即作废，避免陈旧 applies */
  readonly expiresAt: string;
}

/** 文件级冲突（`kind` 区分「撞别的包」与「撞基础游戏文件」） */
export interface ContentConflict {
  readonly rootId: string;
  readonly path: string;
  readonly kind: 'other-pack' | 'base-file';
  readonly existingPackId: string | null;
  readonly resolution: 'abort' | 'skip' | 'overwrite' | 'replace';
}

/**
 * 用户对**单个文件**冲突的决议。
 * 不提供 `abort`：取消整个安装走 UI 的「取消」，而不是逐条 abort（否则一半决议一半没决议）。
 */
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

/** 只读诊断（`code` 是机器判据，`message` 是人话） */
export interface ContentDiagnosis {
  readonly instanceId: string;
  readonly issues: readonly {
    readonly packId: string;
    readonly code: 'missing-file' | 'hash-mismatch' | 'conflict' | 'missing-dependency';
    readonly path?: string;
    readonly message: string;
  }[];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.7 PluginManager
 *
 * 与 `ContentManager`：一条落盘管线（暂存 → 计划 → 应用 → 回滚）、两个入口。
 * `PluginManager` 额外承担**逻辑变更门禁**：能力声明、版本兼容、函数级冲突、
 * 存档影响、风险分级与信任链。UI 因此不再有「这个包到底该点哪个按钮」的歧义。
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface PluginManager {
  list(instanceId: string): Promise<readonly InstalledPlugin[]>;

  /**
   * 只读预检：解到实例暂存、读清单、算文件冲突 + 函数冲突 + 兼容性 + 存档影响。
   * **不碰游戏根**；返回 planId 供用户确认后应用。
   */
  planInstall(
    instanceId: string,
    archivePath: string,
    opts?: InstallPlanOptions,
  ): Promise<PluginInstallPlan>;

  /**
   * 用户确认后落盘；返回可跟踪任务。
   * `saveImpact != 'none'` 时先自动备份存档（`reason = 'pre-plugin'`），备份失败即中止。
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
 *
 * - `content-only`：只追加、不覆盖任何既有文件；
 * - `extends-logic`：新增函数/命令/数据，或覆盖但不删除既有定义；
 * - `overrides-logic`：覆盖/替换既有脚本函数或资源；
 * - `unknown`：清单缺字段或无法判定（按最高风险展示，装前必须显式确认）。
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
  /** 来源插件项目 id（`WorkspaceProject.id`）；null = 纯二进制/外部安装，无源码可开 */
  readonly sourceProjectId: string | null;
  readonly trust: PluginTrust;
}

/** 信任状态（P2 才可能 `verified`；首版恒 `unknown` / `unverified`） */
export interface PluginTrust {
  readonly state: 'verified' | 'unverified' | 'unknown';
  readonly publisher: string | null;
  /** P2：签名时间；首版恒 null */
  readonly signedAt: string | null;
}

/** 兼容性判定读数（`checkedBy` 说清是谁判的，避免「看清单以为兼容」） */
export interface PluginCompatibility {
  readonly ok: boolean;
  readonly gameVersion: string | null;
  readonly requiredGameVersion: string | null;
  readonly apiVersion: string | null;
  /** 判定来源：adapter 回调 / 仅清单声明 / 未判定 */
  readonly checkedBy: 'adapter' | 'declared' | 'none';
  readonly reasons: readonly string[];
}

/**
 * 函数级冲突：adapter 提供函数定义清单，core 只比对「归一化名 + 定义位置」。
 *
 * **比对键必须用 `ScriptFunctionDefinition.normalizedName`**：大小写无关的引擎拿原样名
 * 比会漏掉同一函数的大小写变体。「有意重复」的宽容口径来自 adapter 的约定策略（与约定
 * 校验器同一判据），启动器**不另立宽容名单**。
 */
export interface FunctionConflict {
  readonly functionName: string;
  readonly existing: {
    /** null = 基础游戏文件 */
    readonly pluginId: string | null;
    readonly path: string;
    readonly line: number;
  };
  readonly incoming: { readonly path: string; readonly line: number };
  /** 默认 abort；replace 必须用户显式选择，并先备份旧定义所在文件 */
  readonly resolution: 'abort' | 'skip' | 'replace';
}

/**
 * 插件冲突决议：文件冲突填 `rootId` + `path`，函数冲突填 `functionName`。
 * 不提供 `abort`（取消整装走 UI 的「取消」）。
 */
export interface PluginConflictResolution {
  /** 文件冲突时填 */
  readonly rootId?: string;
  readonly path?: string;
  /** 函数冲突时填 */
  readonly functionName?: string;
  readonly action: 'skip' | 'overwrite' | 'replace';
}

/** 用户显式勾选的越闸项；缺省一律 false（宁可拒绝，不可默认放行） */
export interface PluginApplyOptions {
  /** 兼容性判定失败仍安装；插件会被标 incompatible 并在启动前警告 */
  readonly allowIncompatible?: boolean;
  /** 已知存档影响并同意先备份；`saveImpact != 'none'` 时必需 */
  readonly acknowledgeSaveImpact?: boolean;
  /**
   * 本次安装来自某个插件项目时记录来源项目 id（写入 `state.json`），
   * 供插件详情「打开源码」使用。缺省 = 外部 ZIP，无源码可开。
   */
  readonly sourceProjectId?: string;
}

/** 插件安装计划：文件级计划 + 逻辑门禁读数（UI 一次拿全，无需二次查询） */
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

/** 插件诊断（比内容包多三类码：函数覆盖 / 不兼容 / 加载顺序） */
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

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.8 PluginProjectService
 *
 * **为什么是独立服务而不是 `PluginManager` 的子方法**：操作对象不同——
 * `PluginManager` 读写实例里的**已装产物**，本服务读写作者工作区的**源**。
 * 混在一起会让「装插件」的权限面顺带获得工作区写权。
 *
 * **它不认识游戏目录**：输出只落工作区根（常驻可写根）与项目 `build/`；装配到实例必须
 * 回到 `PluginManager.planInstall` → `applyInstall` 的同一条管线。所以「构建并安装」不是
 * 捷径，而是 build + plan + 用户确认 + apply 四步。
 *
 * **能力面显式声明**：实现方在 `requires` 里声明 `kernel.workspaces` 与 `kernel.io`；
 * 任一缺席时创建/提取/构建直接报错，**不降级成假项目**（不静默、不造空壳）。
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface PluginProjectService {
  /** 列出工作区里 `meta.kind = 'game-plugin'` 的全部项目（跨所有授权根） */
  list(): Promise<readonly PluginProject[]>;
  get(projectId: string): Promise<PluginProject | null>;

  /**
   * 创建项目：
   * 1. 从 `instanceId` 反查 adapter / gameId / gameVersion（**只读**，不碰游戏目录）；
   * 2. 工作区建项目 + 制品目录；
   * 3. 按向导输入生成源清单（唯一真源）；
   * 4. 调 `GamePluginRules.scaffold` 拿文件映射，由本服务写入工作区；
   * 5. 写 `.gitignore`（排除 `build/`）并建空 `build/`。
   *
   * 任一步失败：按**本次写入的路径清单逐条**删（回滚不留半成品项目）。
   * **不要用「删项目」当回滚**：那会连同用户在失败后已手动放进项目的东西一起删掉
   * （工作区契约没有事务）。
   */
  create(input: PluginProjectCreateInput): Promise<PluginProject>;

  /** 改名（元数据）；清单字段一律在编辑器里改 `plugin.json`，不在这里双写 */
  update(projectId: string, patch: { readonly name?: string }): Promise<PluginProject>;
  /** 删除项目（连同项目目录；工作区模型本就不保留孤儿目录） */
  remove(projectId: string): Promise<void>;

  /**
   * 项目目录绝对路径（供壳层用既有项目打开链路打开；服务本身不 import 编辑器）。
   *
   * **必须先扫一遍**：工作区服务的 `projectDir()` 是同步方法，落在自选授权根里的项目
   * 要靠 `id → 目录` 缓存解析，而缓存只由 `list()` 填充；未命中时它会**回落默认根**
   * （= 打开一个不存在的目录）。本服务保证内部先扫再解析。
   */
  projectDir(projectId: string): Promise<string>;

  /**
   * 构建：校验源清单 → 按根映射收集文件 → 算哈希/大小 → 生成制品清单 →
   * 写确定性 ZIP 到 `build/` + 构建报告，并把摘要写回项目元数据（只存指针）。
   * **不写游戏目录、不执行项目内任何脚本**；打包复用 `zip.ts::buildZip`（不写第二套打包器）。
   */
  build(projectId: string, opts?: PluginBuildOptions): Promise<PluginBuildResult>;

  /**
   * 「构建并安装」的前半段：一次调用完成 build + `PluginManager.planInstall`，
   * 返回计划供 UI 展示；用户确认后再调 `plugins.applyInstall(plan.planId, …)`。
   * 合成一次的理由：避免 UI 在 build 与 plan 之间文件被改动导致计划对不上。
   */
  planInstall(
    projectId: string,
    instanceId: string,
    opts?: PluginBuildOptions,
  ): Promise<PluginProjectInstallPlan>;

  /**
   * 把**已安装插件**提取为源码项目（字节级复制归属文件，生成源清单）。
   * 仅限该实例里该插件声明的文件；无 payload 目录时按目录重建。
   * 提取项目标记 `source = 'extracted'`，供 UI 提示「这不是原作者项目」。
   */
  extract(instanceId: string, pluginId: string, opts?: PluginExtractOptions): Promise<PluginProject>;

  /**
   * 漂移检查：比较项目当前清单版本 / 上次构建 / 实例里已装版本。
   * 纯只读；UI 在打开项目、点「构建并安装」前调用。
   */
  inspectDrift(projectId: string, instanceId: string): Promise<PluginProjectDrift>;
}

/** 项目来源（`extracted` 只影响 UI 提示，不影响任何门禁） */
export type PluginProjectSource = 'created' | 'extracted';

/**
 * 项目元数据（住工作区 manifest 的 `meta`；`kind` 是识别「这是插件项目」的唯一判据）。
 *
 * `lastBuild` / `installedTarget` 都是**指针**：权威副本分别在不变量报告与实例的
 * `state.json` 里，这里只存够 UI 直接展示的摘要。
 */
export interface PluginProjectMeta {
  readonly kind: 'game-plugin';
  readonly adapterId: string;
  readonly gameId: string;
  readonly gameVersion: string | null;
  /** 创建时的目标实例；项目本身可安装到同类实例，不绑定唯一实例 */
  readonly targetInstanceId: string | null;
  /** 上次构建摘要（指针；权威副本在构建报告里） */
  readonly lastBuild: PluginBuildSummary | null;
  /** 上次「构建并安装」的目标；null = 尚未安装 */
  readonly installedTarget: PluginInstalledRef | null;
  /** 从已装插件提取时的来源；`source = 'created'` 时缺省 */
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
  /** 持久化形态（工作区 manifest 里的 `meta`） */
  readonly meta: PluginProjectMeta;
  readonly source: PluginProjectSource;
  /** 首版恒一条；保留数组形态以支持日后「一个项目多个制品」 */
  readonly artifacts: readonly PluginProjectArtifact[];
  /** 投影自 `meta.lastBuild`（便利字段；两者不一致以构建报告为准） */
  readonly lastBuild: PluginBuildSummary | null;
  /** 投影自 `meta.installedTarget`；null = 尚未安装 */
  readonly installedTarget: PluginInstalledRef | null;
}

/** 制品（一个制品 = 一份可安装产物）；清单字段打开时现读，不作第二真源 */
export interface PluginProjectArtifact {
  readonly artifactId: string;
  /** 制品目录名（单层；首版恒 `plugin`） */
  readonly dirName: string;
  /** 从源清单投影（打开项目时现读） */
  readonly pluginId: string;
  readonly version: string;
  readonly capabilities: readonly PluginCapability[];
  /** 恒为 `<dirName>/plugin.json` */
  readonly manifestPath: string;
}

/** 已安装引用（漂移判定用：`buildSha256` 是安装时那份产物的哈希） */
export interface PluginInstalledRef {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly installedAt: string;
  readonly buildSha256: string | null;
}

/** 新建项目的向导输入（`workspaceRoot` 必须命中工作区已授权根） */
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
  /** 向导预置的根映射（至少一条）；创建后以源清单为准 */
  readonly roots: readonly PluginSourceRootMap[];
  /** 必须命中工作区服务的 `roots()`；缺省 = 默认根 */
  readonly workspaceRoot?: string;
}

/** 构建选项（都不改源清单：版本覆盖只作用于本次产物） */
export interface PluginBuildOptions {
  /** 覆盖本次产物版本（不改源清单；缺省 = 清单版本） */
  readonly version?: string;
  /** 是否把 README / LICENSE 打进包；缺省 true */
  readonly includeDocs?: boolean;
  /** 额外排除的相对制品根 glob */
  readonly exclude?: readonly string[];
}

/** 构建结果（确定性：同内容两次构建逐字节相同 + 源指纹相同） */
export interface PluginBuildResult {
  readonly buildId: string;
  /** `build/<id>-<version>.zip` 的绝对路径（**只读展示**，不作为写参数） */
  readonly zipPath: string;
  /** 构建报告的绝对路径（清单 / 哈希 / 警告 / 源文件清单摘要） */
  readonly reportPath: string;
  /** 产物清单（UI 直接用它渲染安装预览） */
  readonly manifest: ContentPackManifest;
  readonly bytes: number;
  readonly sha256: string;
  /** 源指纹：源清单规范化文本 + 全部映射文件 （路径, size, mtimeMs） 的摘要 */
  readonly sourceFingerprint: string;
  readonly warnings: readonly string[];
  readonly builtAt: string;
}

/** 构建摘要（项目元数据里只存这一份指针） */
export interface PluginBuildSummary {
  readonly buildId: string;
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceFingerprint: string;
  readonly builtAt: string;
}

/** 「构建并安装」的计划：构建产物 + 可直接交给 `applyInstall` 的安装计划 */
export interface PluginProjectInstallPlan {
  readonly build: PluginBuildResult;
  /** 直接交给 `plugins.applyInstall(plan.planId, …)` */
  readonly plan: PluginInstallPlan;
}

export interface PluginExtractOptions {
  readonly projectName?: string;
  /** 必须命中工作区服务的 `roots()`；缺省 = 默认根 */
  readonly workspaceRoot?: string;
}

/** 项目 / 构建 / 已装版本三者的一致性（只读；UI 据此提示「需重建」） */
export interface PluginProjectDrift {
  readonly state: 'in-sync' | 'source-changed' | 'installed-differs' | 'not-installed';
  readonly sourceVersion: string;
  readonly lastBuildVersion: string | null;
  readonly installedVersion: string | null;
  readonly reasons: readonly string[];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.9 SaveManager
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 存档管理。所有写动作都落在**实例备份目录**或用户经保存对话框指定的落点；
 * shared 实例写回游戏目录另需逐根目录授权（§9.1）。
 */
export interface SaveManager {
  list(instanceId: string): Promise<readonly SaveEntry[]>;
  backups(instanceId: string): Promise<readonly SaveBackup[]>;

  backup(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask>;
  restore(instanceId: string, backupId: string, opts?: RestoreOptions): Promise<LauncherTask>;
  removeBackup(instanceId: string, backupId: string): Promise<void>;

  /** 导入前先预检冲突（同名存档）；返回 planId */
  planImport(instanceId: string, archivePath: string): Promise<SaveImportPlan>;
  applyImport(planId: string, resolutions?: readonly ConflictResolution[]): Promise<LauncherTask>;

  /** 原生保存对话框；返回落点或 null。**对话框与写盘同命令**（§13.1） */
  exportArchive(instanceId: string, req: SaveExportRequest): Promise<string | null>;
}

/** 一条存档（`path` 相对对应 saveRoot） */
export interface SaveEntry {
  /** 相对对应 saveRoot */
  readonly path: string;
  readonly rootId: string;
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** 一份备份（`reason` 决定 UI 分组与清理策略） */
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
  /** 缺省 `'manual'`；`'pre-restore'` / `'pre-plugin'` 由启动器内部调用时写入 */
  readonly reason?: SaveBackup['reason'];
  /** 空 = 备份全部 saveRoots */
  readonly entries?: readonly { rootId: string; path: string }[];
}

export interface RestoreOptions {
  /** 恢复前自动再备份当前存档；默认 true */
  readonly backupCurrent?: boolean;
}

/** 存档导入计划（`backupId` = 导入包解析后的内部备份，可回滚） */
export interface SaveImportPlan {
  readonly planId: string;
  readonly backupId: string;
  readonly overwrites: readonly string[];
  readonly warnings: readonly string[];
}

/** 导出请求（落点由原生保存对话框给定，本形状不含路径） */
export interface SaveExportRequest {
  readonly label?: string;
  /** 空 = 导出全部 saveRoots */
  readonly entries?: readonly { rootId: string; path: string }[];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.10 LogService
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 日志读取与实时流（解码、节流、环形丢弃都在宿主/本侧完成，UI 不收原始字节） */
export interface LogService {
  /** 当前/指定会话的尾部；默认最近若干行、上限若干字节（档位在实现侧，契约不留常量） */
  tail(instanceId: string, opts?: LogQuery): Promise<LogPage>;
  sessions(instanceId: string): Promise<readonly LogSession[]>;
  read(sessionId: string, opts?: LogQuery): Promise<LogPage>;

  /** 实时行流；内部已做解码、节流、环形丢弃 */
  subscribe(instanceId: string, listener: (line: LogLine) => void): Unsubscribe;

  /** 诊断包：原生保存对话框；内容含日志、退出记录、实例概况、内容清单，默认脱敏用户路径 */
  exportBundle(instanceId: string, sessionId?: string): Promise<string | null>;
}

/** 日志查询（全部可选；实现侧夹到自己的上限档位） */
export interface LogQuery {
  readonly sessionId?: string;
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly stream?: 'stdout' | 'stderr' | 'all';
  readonly errorsOnly?: boolean;
}

/** 一页日志（`truncated` 说清是否被截断，避免 UI 把截断当"只有这些"） */
export interface LogPage {
  readonly session: LogSession;
  readonly lines: readonly LogLine[];
  readonly truncated: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.11 TaskCenter
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 任务中心（进度/终态经 `subscribe` 推送；列表是同步快照，UI 首帧不必等 Promise） */
export interface TaskCenter {
  list(): readonly LauncherTask[];
  get(id: string): LauncherTask | null;
  cancel(id: string): Promise<void>;
  subscribe(listener: (task: LauncherTask) => void): Unsubscribe;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.12 LauncherUpdateService（P2）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** P2：运行时/内容更新与校验修复（首版只留形状，实现可返回 `PLATFORM_UNSUPPORTED`） */
export interface LauncherUpdateService {
  check(instanceId: string): Promise<UpdateCheckResult>;
  apply(planId: string): Promise<LauncherTask>;

  /** 校验：对比基线清单 / 来源根 / 内容包归属文件 */
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

/* ══════════════════════════════════════════════════════════════════════════════
 * §7 宿主桥与事件载荷（L1b 补齐：2026-10-26）
 *
 * 这一节回答的是「TS 侧怎么调宿主」，不是「插件的领域面长什么样」——
 * `LauncherService` / `InstanceStore` 那些是**消费方**看的形状，这里是**实现方**
 * （内核零逻辑透传 + 桌面壳桥）必须对齐的形状。两者刻意分开：
 *
 * - 领域面可以说「返回 `LogPage`（已解码的行）」；宿主面只能说「返回原始字节块」，
 *   因为 §12.1 把解码钉死在 TS 侧（内核单源 `decodeWithProbe`），宿主再解一遍就是第二套口径；
 * - 领域面没有任何方法接受「目标程序路径」；宿主面同样没有——启动只认 `instanceId`，
 *   信任只认 `instanceId`，落点只有「宿主按 appData 现算」与「原生对话框即授权」两种形态。
 *
 * 事件载荷（§7.3）此前只有文字描述，没有 TS 形状；四条都在下面，`seq` 是**宿主严格递增**
 * 的序号，消费方按它丢弃乱序与重复（断线重连后宿主从当前值继续，不从 0 重来）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** `launcher_instance_open_folder` 的 `which`（枚举，**不接受任意子路径**） */
export type InstanceOpenTarget = 'root' | 'game' | 'saves' | 'logs' | 'backups';

/**
 * 一段**未解码**的日志字节。
 *
 * `ts` / `stream` 由宿主给（它知道读到的是什么流、什么时候读到的）；`bytesBase64` 是原始
 * 字节——宿主不做任何编码探测，解码由 `logs.tail/read` 在 TS 侧完成（§12.1）。
 */
export interface HostLogChunk {
  /** 宿主读到该块的时刻（epoch ms） */
  readonly ts: number;
  readonly stream: LogLine['stream'];
  readonly bytesBase64: string;
}

/** 宿主返回的一页日志：会话元数据 + 编码后的原始块 + 截断标记 */
export interface HostLogPage {
  readonly session: LogSession;
  readonly chunks: readonly HostLogChunk[];
  /** 因 `maxLines` / `maxBytes` 被截断（UI 不能把截断当「只有这些」） */
  readonly truncated: boolean;
}

/** `kojo:launcher-process` */
export interface LauncherProcessEvent {
  readonly instanceId: string;
  readonly status: ProcessStatus;
  readonly seq: number;
}

/** `kojo:launcher-log`（宿主节流：≥64 KiB 或 ≥100 ms 合并一次） */
export interface LauncherLogEvent {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly stream: LogLine['stream'];
  readonly seq: number;
  readonly bytesBase64: string;
}

/** `kojo:launcher-task` */
export interface LauncherTaskEvent {
  readonly task: LauncherTask;
  readonly seq: number;
}

/** `kojo:launcher-instance` */
export interface LauncherInstanceEvent {
  readonly kind: InstanceChange['kind'];
  readonly instanceId: string;
  readonly seq: number;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §7.4 内容包 / 存档的宿主读数（P1：`launcher_content_*` / `launcher_save_*`）
 *
 * 这一组是**宿主命令的返回形状**，不是领域面：领域面（§6.6 / §6.9）说「返回已裁决的计划 /
 * 已归并的诊断」，宿主面能给的比那多几处只读读数——多出来的部分在下面逐条注释里点名，
 * 由消费方（`launcher-core`）映射或原样透传，宿主不再自造第二套语义。
 *
 * 为什么这些读数**必须**进契约（L1c 收口，此前 `launcher-core` 各自声明了一份局部形状）：
 * - 一份形状两处声明 = 两处漂移，且漂在类型层看不出来（`as unknown as` 一挡就过去了）；
 * - 每条读数的语义只有宿主知道（`roots[].approved` 是写回门禁、`case-collision` 是落盘语义、
 *   `orphan-file` / `load-order` 是只有看见磁盘才判得出的两档），契约不写这里就等于让
 *   每个消费方各自猜一遍。
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 一个存档根（`saveRoot`）的宿主读数。
 *
 * `approved` 是 shared / overlay 实例的**写回门禁**（§9.1）：copy 实例宿主恒报 `true`
 * （写的是实例内副本），shared 实例看 `approvals.json`。
 */
export interface HostSaveRootState {
  readonly rootId: string;
  /** 该根是否已获写授权（`launcher_pick_write_root` 的对话框即授权） */
  readonly approved: boolean;
  /** 该根在盘上是否存在（可选读数；缺席 = 宿主不报） */
  readonly exists?: boolean;
}

/**
 * `launcher_save_list` 的返回：存档条目 + **逐根授权读数** + 宿主侧人话警告。
 *
 * 不是裸 `SaveEntry[]`：`roots[]` 装的是「这个根能不能写回」，`SaveEntry` 表达不了
 * （条目一个字节都没变），而 shared 实例的列表恰好按它过滤。
 */
export interface HostSaveListing {
  readonly entries: readonly SaveEntry[];
  readonly roots: readonly HostSaveRootState[];
  /** 宿主侧人话警告（可选；消费方与自己的警告合并，不覆盖） */
  readonly warnings?: readonly string[];
}

/**
 * `launcher_save_import` 的返回：契约计划 + 宿主**可选**读数。
 *
 * 三个数都只有宿主给得出（它才解过包）：条目数 / 总字节是 §11.4 的预检闸，
 * `expiresAt` 是「计划过期即作废」的时间界。缺席 = 宿主没报，消费方**不猜**
 * （条数 / 字节落回「不设这道闸」，过期时刻落回本层 TTL）。
 */
export interface HostSaveImportPlan extends SaveImportPlan {
  /** 包内条目数（宿主解包读数） */
  readonly entryCount?: number;
  /** 解包后的总字节 */
  readonly totalBytes?: number;
  /** 暂存计划过期时刻（ISO-8601） */
  readonly expiresAt?: string;
}

/**
 * 宿主内容计划里的一条文件冲突。
 *
 * 比领域面的 `ContentConflict` 多一档 `'case-collision'`：大小写折叠是**落盘语义**
 * （`Data/A` 与 `data/a` 在 Windows 上是同一个文件），只有看见磁盘的宿主判得了；
 * 折回领域二分（`other-pack` / `base-file`）是消费方的事。
 */
export interface HostContentConflict {
  readonly rootId: string;
  readonly path: string;
  readonly kind: 'other-pack' | 'base-file' | 'case-collision';
  /** 撞上的既有文件的属主包 id；`null` = 基础游戏文件 */
  readonly existingPackId: string | null;
  /** `kind = 'case-collision'` 时磁盘上既有条目的**实际大小写** */
  readonly existingPath?: string;
  readonly resolution: ContentConflict['resolution'];
}

/** `launcher_content_plan` 的返回：与领域计划同形，冲突项多一档（见 `HostContentConflict`） */
export interface HostContentPlan {
  readonly planId: string;
  readonly manifest: ContentPackManifest;
  readonly targets: readonly { readonly rootId: string; readonly relativePath: string }[];
  readonly additions: readonly ContentFileRef[];
  readonly overwrites: readonly ContentFileRef[];
  readonly conflicts: readonly HostContentConflict[];
  readonly missingRequirements: readonly string[];
  readonly warnings: readonly string[];
  /** 暂存计划过期即作废（两次预检之间不持有实例锁，只能靠时间界） */
  readonly expiresAt: string;
}

/**
 * 宿主诊断码：领域面四项 + 宿主多报的两档。
 *
 * `orphan-file`（本包 ownership 里记着、盘上却没有 / 盘上有却不属于任何包）与
 * `load-order`（启用顺序与权重的实际排列异常）都是**只有看见磁盘才判得出**的，
 * 领域面 `ContentDiagnosis` 的码表没有位置 ⇒ 消费方把它们映射进 `conflict`
 * 并用人话 `message` 的固定前缀区分；宿主不许把它们悄悄折成别的码再报。
 */
export type HostContentIssueCode =
  | 'missing-file'
  | 'hash-mismatch'
  | 'conflict'
  | 'missing-dependency'
  | 'orphan-file'
  | 'load-order';

/** 一条宿主诊断项（`message` 是人话；`path` 只有文件级问题才有） */
export interface HostContentIssue {
  readonly packId: string;
  readonly code: HostContentIssueCode;
  readonly path?: string;
  readonly message: string;
}

/** `launcher_content_diagnose` 的返回（只读；按包逐条给，归并归消费方） */
export interface HostContentDiagnosis {
  readonly instanceId: string;
  readonly issues: readonly HostContentIssue[];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §7.4 插件源码项目的宿主读数（P1：`launcher_project_hash` / `launcher_project_extract`）
 *
 * 两条命令都**不认识插件语义**（§7.2 尾注）：hash 只回答「这批字节的哈希是多少」，
 * extract 只把包解到宿主暂存并把 `pack.json` 原样读回。清单校验、`roots` 映射、`buildId`
 * 与 drift 报告全在 `PluginProjectService`（ADR-0010 决策 3：宿主不写第二套打包器）。
 *
 * 这是 §7.1 唯一允许接受绝对路径的例外：`projectDir` 是**只读输入根**，宿主复核它落在
 * 已登记的写允许域内（appData / 已授权工作区根），且条目解析后不得逃逸 `artifactDir`。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** `launcher_project_hash` 的入参（§7.2） */
export interface HostProjectHashInput {
  /** 项目根绝对路径（宿主复核它在写允许域内） */
  readonly projectDir: string;
  /** 制品目录名（单层；条目解析后不得逃逸它） */
  readonly artifactDir: string;
  /** 相对 `artifactDir` 的文件路径（POSIX） */
  readonly entries: readonly string[];
}

/** `launcher_project_hash` 的逐文件读数（`FileDigest[]` 的一条） */
export interface HostFileDigest {
  /** 入参里那条**相对 `artifactDir`** 的路径（原样回显，消费方按它配对） */
  readonly path: string;
  /** 小写十六进制 SHA-256 */
  readonly sha256: string;
  readonly size: number;
}

/** `launcher_project_extract` 的一条暂存读数 */
export interface HostProjectExtractEntry {
  /** 包内路径（`{rootId}/{path}`；宿主已解到 `stagingDir` 下同名相对路径） */
  readonly path: string;
  /** 条目类型：符号链接与目录**一律拒绝**（首版只搬普通文件） */
  readonly kind: 'file' | 'symlink' | 'directory';
  readonly size: number;
}

/** `launcher_project_extract` 的返回（宿主暂存目录 + 包内清单 + 逐条目读数） */
export interface HostProjectExtractResult {
  /** 宿主解包落点（读侧；消费方只读不写，也不删——暂存由宿主 TTL 清理） */
  readonly stagingDir: string;
  readonly manifest: ContentPackManifest;
  readonly entries: readonly HostProjectExtractEntry[];
}

/**
 * 宿主原语的零逻辑透传（服务键 `kernel.launcher` / 平台桥 `PlatformBridge.launcher`）。
 *
 * 方法名 = 命令名的 camelCase 投影（`launcher_instance_list` → `instanceList`），一个方法只对应
 * 一条命令：本层**不拼路径、不做持久化、不解释限额**（§4.2：宿主零领域判断、core 零磁盘操作）。
 *
 * 可选方法（`?`）= 规格里标 P1 的命令：缺席时透传层给一句人话（照 `exportFile` /
 * `chooseWorkspaceRoot` 的既有口径），**不降级、不造假数据**。
 */
export interface LauncherHostBridge {
  /* ---- 实例（launcher_instance_*） ---- */

  /** `launcher_instance_list` */
  instanceList(): Promise<readonly LauncherInstance[]>;
  /** `launcher_instance_get`（返回概况；`InstanceStore.get` 从里面取 `instance`） */
  instanceInspect(instanceId: string): Promise<InstanceInspection>;
  /**
   * `launcher_instance_create`：**两个参数**。
   *
   * 宿主不认识 adapter，编译不出 `LaunchProfile`；`probe` → `buildProfile` 全在 TS 侧
   * （adapter 的游戏知识），宿主只负责落盘与守卫。所以命令载荷是 `{ request, profile }`，
   * 而不是让宿主去猜 exe 在哪。
   */
  instanceCreate(request: CreateInstanceRequest, profile: LaunchProfile): Promise<InstanceCreation>;
  /** `launcher_instance_update`（可改字段白名单由宿主复核） */
  instanceUpdate(instanceId: string, patch: InstancePatch): Promise<LauncherInstance>;
  /** `launcher_instance_remove`（宿主先停进程、再删实例根） */
  instanceRemove(instanceId: string, opts: RemoveInstanceOptions): Promise<void>;
  /** `launcher_instance_duplicate`（P1） */
  instanceDuplicate?(instanceId: string, name?: string): Promise<InstanceCreation>;

  /* ---- 目录（原生对话框即授权） ---- */

  /** `launcher_pick_source_root`：确认后在**同一命令内**写入「来源根批准表」 */
  pickSourceRoot(title?: string): Promise<string | null>;
  /** `launcher_pick_write_root`（P1）：确认后在同一命令内登记 实例 × rootId 的写授权 */
  pickWriteRoot?(instanceId: string, rootId: string): Promise<string | null>;
  /** `launcher_pick_archive`（P1）：只选不读不写 */
  pickArchive?(title?: string): Promise<string | null>;
  /** `launcher_instance_open_folder`：`which` 是枚举，不接受子路径 */
  openInstanceFolder(instanceId: string, which: InstanceOpenTarget): Promise<void>;

  /* ---- 进程（launcher_start / launcher_stop / launcher_process_*） ---- */

  /** `launcher_start`：校验链在宿主内（实例就绪 → 程序合法 → 信任哈希 → 运行时 → 每实例锁） */
  start(instanceId: string): Promise<ProcessStatus>;
  /** `launcher_stop` */
  stop(instanceId: string, opts?: StopOptions): Promise<ProcessStatus>;
  /** `launcher_process_status` */
  processStatus(instanceId: string): Promise<ProcessStatus>;
  /** `launcher_process_list` */
  processList(): Promise<readonly ProcessStatus[]>;
  /** `launcher_trust_executable`：宿主算哈希并在**同一命令内**弹原生确认框 */
  trustExecutable(instanceId: string): Promise<ExecutableTrust>;

  /* ---- 日志（launcher_log_*） ---- */

  /** `launcher_log_tail`（返回**原始块**，解码归 core） */
  logTail(instanceId: string, query?: LogQuery): Promise<HostLogPage>;
  /** `launcher_log_sessions` */
  logSessions(instanceId: string): Promise<readonly LogSession[]>;
  /** `launcher_log_read`（sessionId 归属校验在宿主） */
  logRead(sessionId: string, query?: LogQuery): Promise<HostLogPage>;
  /** `launcher_log_export`（P1：原生保存对话框 + 写盘同命令，路径脱敏在宿主） */
  logExport?(instanceId: string, sessionId?: string): Promise<string | null>;

  /* ---- 任务（launcher_task_*） ---- */

  /** `launcher_task_list` */
  taskList(): Promise<readonly LauncherTask[]>;
  /** `launcher_task_cancel`（只取消可取消任务；回滚由任务自身完成） */
  taskCancel(taskId: string): Promise<void>;

  /* ---- 内容包（`launcher_content_*` 七条，全 P1：缺席 = 该宿主没有这组） ----
   *
   * 解包、暂存、写盘、备份、回滚、ownership 落盘**全在宿主**；消费方只裁决与记账。
   * 方法缺席时透传层给一句人话（照 `logExport` 的同族口径），**不降级、不造假数据**。
   */

  /** `launcher_content_list`：宿主读自己落盘的 `state.json` / `ownership.json` */
  contentList?(instanceId: string): Promise<readonly InstalledContent[]>;
  /**
   * `launcher_content_plan`：解到**实例暂存**并出计划，**不碰游戏根**。
   *
   * 第三参只承载逐调用的限额档（`limits` 缺省 = 宿主那一档）；消费方也从契约常量取值，
   * 宿主只许收紧、不许另立一套默认值。
   */
  contentPlan?(
    instanceId: string,
    archivePath: string,
    opts?: InstallPlanOptions,
  ): Promise<HostContentPlan>;
  /** `launcher_content_apply`：两阶段的第二半；`planId` 一次性消费 */
  contentApply?(planId: string, resolutions?: readonly ConflictResolution[]): Promise<LauncherTask>;
  /**
   * `launcher_content_uninstall`：`files` = 消费方算出的「本包独占」ownership 快照
   * （可缺省；宿主仍以 `ownership.json` 复核——快照是纵深防御，不是唯一凭据）。
   */
  contentUninstall?(
    instanceId: string,
    packId: string,
    files?: readonly ContentFileRef[],
  ): Promise<LauncherTask>;
  /** `launcher_content_set_enabled`（停游戏由消费方先做，§10.3） */
  contentSetEnabled?(instanceId: string, packId: string, enabled: boolean): Promise<LauncherTask>;
  /** `launcher_content_set_order`（只接受已安装 id 的排列） */
  contentSetOrder?(instanceId: string, packIds: readonly string[]): Promise<void>;
  /** `launcher_content_diagnose`（只读；码表见 `HostContentIssueCode`） */
  contentDiagnose?(instanceId: string): Promise<HostContentDiagnosis>;

  /* ---- 存档（`launcher_save_*` 八条，全 P1：缺席 = 该宿主没有这组） ----
   *
   * 写落点只有三处：实例备份目录（宿主现算）、实例内 saveRoot（copy）、
   * 已授权的 saveRoot（shared，approvals.json）。**没有任何「目标路径」参数**。
   */

  /** `launcher_save_list`：只读 saveRoots（含逐根授权读数，不是裸 `SaveEntry[]`） */
  saveList?(instanceId: string): Promise<HostSaveListing>;
  /** `launcher_save_backups`：实例备份目录清单 */
  saveBackups?(instanceId: string): Promise<readonly SaveBackup[]>;
  /** `launcher_save_backup`：只写实例备份目录；返回终态任务（`result.backupId`） */
  saveBackup?(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask>;
  /** `launcher_save_restore`：解包 → 校验 → 逐文件写临时 + rename；返回终态任务 */
  saveRestore?(instanceId: string, backupId: string, opts?: RestoreOptions): Promise<LauncherTask>;
  /** `launcher_save_delete_backup`：只删实例备份目录内的那一份 */
  saveDeleteBackup?(instanceId: string, backupId: string): Promise<void>;
  /** `launcher_save_import`：解到暂存并预检；**不写实例** */
  saveImport?(instanceId: string, archivePath: string): Promise<HostSaveImportPlan>;
  /** `launcher_save_apply_import`：确认后落盘；返回终态任务 */
  saveApplyImport?(
    planId: string,
    resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask>;
  /** `launcher_save_export`：原生保存对话框 + 写盘同命令；返回用户选的落点或 `null` */
  saveExport?(instanceId: string, req: SaveExportRequest): Promise<string | null>;

  /* ---- 插件源码项目（`launcher_project_*` 两条，全 P1：缺席 = 该宿主没有这组） ----
   *
   * `projectDir` 是**只读输入根**（§7.1 的唯一例外），宿主复核它在写允许域内；
   * 打包不在宿主（ADR-0010 决策 3），extract 的解包守卫与内容包共用同一份。
   */

  /** `launcher_project_hash`：逐文件流式摘要（大二进制不整包读进 JS） */
  projectHash?(input: HostProjectHashInput): Promise<readonly HostFileDigest[]>;
  /** `launcher_project_extract`：解到宿主暂存 + 读回包内清单与逐条目读数 */
  projectExtract?(
    archivePath: string,
    opts: { readonly limits: ZipContractLimits },
  ): Promise<HostProjectExtractResult>;

  /* ---- 事件（§7.3） ---- */

  onProcess(listener: (event: LauncherProcessEvent) => void): Unsubscribe;
  onLog(listener: (event: LauncherLogEvent) => void): Unsubscribe;
  onTask(listener: (event: LauncherTaskEvent) => void): Unsubscribe;
  onInstance(listener: (event: LauncherInstanceEvent) => void): Unsubscribe;
}
