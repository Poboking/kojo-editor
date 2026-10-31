import type {
  ConflictResolution,
  ContentFileRef,
  CreateInstanceRequest,
  ExecutableTrust,
  HostFileDigest,
  HostLogPage,
  HostProjectExtractResult,
  HostProjectHashInput,
  InstanceCreation,
  InstanceInspection,
  InstanceOpenTarget,
  InstancePatch,
  InstalledContent,
  LauncherHostBridge,
  LauncherInstance,
  LauncherInstanceEvent,
  LauncherLogEvent,
  LauncherProcessEvent,
  LauncherTask,
  LauncherTaskEvent,
  LaunchProfile,
  LogQuery,
  LogSession,
  PlatformBridge,
  ProcessStatus,
  RemoveInstanceOptions,
  RestoreOptions,
  SaveBackup,
  SaveBackupRequest,
  SaveExportRequest,
  StopOptions,
  Unsubscribe,
  ZipContractLimits,
} from '@kojo/plugin-api';
// P1 两组的**形状真源是消费方**（`launcher-core` 在 `content-manager` / `save-host` 里已把
// `ContentHostCommands` / `SaveHostBridge` 声明为本包局部契约）：这里只 import type
// ⇒ 运行期零依赖、开机静态图零变化（`import type` 会被擦除），而类型一旦漂开就红在
// `pnpm --filter @kojo/app typecheck` 上——比在本文件抄第二份形状可靠。
import type {
  ContentHostCommands,
  HostContentDiagnosis,
  HostContentPlan,
  HostSaveImportPlan,
  HostSaveListing,
  SaveHostBridge,
} from '@kojo/plugin-launcher-core';
import { invoke } from './invoke';

/**
 * 桌面壳桥的**启动器面**（`PlatformBridge.launcher`）：Rust 38 条 `launcher_*` 命令 +
 * 4 条事件（`kojo:launcher-process` / `-log` / `-task` / `-instance`）的逐条接线。
 * 命令面清单见下方「本桥覆盖的命令面」（20 P0 + 18 P1，逐条对过 Rust 实签名）。
 *
 * 三条纪律（改之前先读）：
 *
 * 1. **一个方法 = 一条命令**，方法名 = 命令名的 camelCase 投影（`launcher_instance_list`
 *    → `instanceList`）。本层不拼路径、不做持久化、不解释限额——那是宿主的活；
 *    命令名与参数表逐字来自 `src-tauri/src/launcher/commands.rs`，改名必须两侧一起改。
 * 2. **载荷键用 camelCase**：Tauri 2 在 JS → Rust 边界上把 camelCase 键映射到 snake_case
 *    形参，与既有桥同口径（`exportFile` 的 `fileName`、市场下载那条的 `stagingName`）。
 *    可选参数**显式传 `null`**（Rust 侧是 `Option<T>`）：少一个键在 serde 眼里等于走
 *    `#[serde(default)]`，与"显式没给"是两回事。
 * 3. **返回值原样透传**：宿主 DTO 全部 `#[serde(rename_all = "camelCase")]`（`InstanceDto`
 *    / `InspectionDto` / `ProcessStatusDto` / `LogPageDto` / `TaskDto` / `StoredTrust` /
 *    `LauncherErrorDto` / `ContentPlanDto` / `ConflictDto` / `InstalledContentDto` /
 *    `DiagnosisDto` / `SaveListingDto` / `SaveBackupDto` / `SaveImportPlanDto` 逐个核对过），
 *    字段名与 `plugin-api` 逐字相同 ⇒ 这里**不做第二份改名表**（第二份表迟早与 serde 属性
 *    漂开）。反例有测试钉住：喂 snake_case 进来，出去仍是 snake_case——casing 的唯一真源是
 *    Rust 的 serde 属性，不是本文件（`packages/app/tests/launcher-desk-bridge.test.ts`）。
 *
 * ## 本桥覆盖的命令面（38 条 = 20 P0 + 18 P1，与 `commands.rs::COMMAND_NAMES[&str; 38]` 逐字对齐）
 *
 * **P0（L3c 已接：实例 / 目录 / 进程 / 日志 / 任务，20 条）**
 * `launcher_instance_{list,get,create,update,remove,duplicate}` ·
 * `launcher_pick_{source_root,write_root}` · `launcher_instance_open_folder` ·
 * `launcher_trust_executable` · `launcher_{start,stop}` ·
 * `launcher_process_{status,list}` · `launcher_log_{tail,sessions,read,export}` ·
 * `launcher_task_{list,cancel}`
 *
 * **P1（L3d：内容包 / 存档 16 条 + L7B：插件源码项目 2 条）**
 * `launcher_pick_archive` ·
 * `launcher_content_{list,plan,apply,uninstall,set_enabled,set_order,diagnose}` ·
 * `launcher_save_{list,backups,backup,restore,delete_backup,import,apply_import,export}` ·
 * `launcher_project_{hash,extract}`
 *
 * 三处形状差异（L3b 回执点名的那三处，逐条对齐过）：
 * - `launcher_save_list` 返回 `{ entries, roots, warnings }`（不是裸 `SaveEntry[]`）
 *   ⇒ 直接投影成 `launcher-core::HostSaveListing`（`roots[].approved` 是 shared 实例的写回门禁判据）；
 * - `launcher_content_plan` 第三参是 `opts.limits{maxEntries,maxDepth,maxUnpackedBytes}`
 *   （Rust `PlanOptionsDto` → `StagingLimits`，三个数由调用方从契约常量传，宿主只许收紧）；
 * - `launcher_content_uninstall` 有可选 `files[{rootId,path}]`（TS 侧算出的「本包独占」快照）；
 * - `launcher_content_diagnose` 的 `issues[].code` 比契约多 `orphan-file` / `load-order`，
 *   `launcher_save_import` 比契约多 `entryCount` / `totalBytes` / `expiresAt` ⇒ 两组都
 *   **原样透传**（映射归 `launcher-core`；在本层丢字段 = 让消费方只能靠猜）。
 *
 * **未接（Rust 里根本没有这些命令，写调用只会红在运行期而不是编译期）**：
 * `launcher_runtime_*`（运行时登记 / 解析，§7.2 标 P1 但宿主尚未落地——`process.rs` 的运行时
 * 解析因此是 fail-closed）。P2 的整合包（bundle）同样没有任何宿主命令。本文件一个字都不写。
 *
 * 插件源码项目的两条（`launcher_project_hash` / `launcher_project_extract`）**已接**（L7B）：
 * 前者是 §7.1 唯一允许 `projectDir` 绝对路径的例外（只读，宿主复核它在写允许域内）；
 * 后者解到宿主暂存（`launcher/project-staging/`）并把 `pack.json` 原样读回。两者都不认识
 * 插件语义——校验 / `buildId` / drift 报告在 `launcher-core::PluginProjectService`。
 *
 * 旧版桌面壳（没编进这 18 条 P1 命令）**不会静默**：`callP1` 认出 Tauri 的「Command … not found」
 * 拒绝后改写成 `LauncherBridgeError('LAUNCHER_PLATFORM_UNSUPPORTED', 中文人话)`，
 * 消费方照既有错误码分流即可，不会看到一句英文 `not found`。
 */

/* ------------------------------- 错误 ------------------------------- */

/**
 * 宿主 `LauncherErrorDto` 的 JS 形态。
 *
 * 为什么不是 `new Error(dto.message)`：`code` 是消费方分流修法的判据（信任 → 重新确认、
 * 授权 → 重走对话框、忙 → 等它停），`detail` 是可折叠的排障细节，`retryable` 决定要不要
 * 给「重试」。把三者压成一句字符串 = 让 UI 只能正则匹配中文原文去猜，那是第二份错误表。
 * `message` 保持宿主的中文原句（宿主已经保证不透传 OS 英文串，这里也不改写）。
 */
export class LauncherBridgeError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly retryable: boolean;

  constructor(code: string, message: string, detail: string | undefined, retryable: boolean) {
    super(message);
    this.name = 'LauncherBridgeError';
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/**
 * 拒绝值 → 要抛的错误。
 *
 * Tauri 把 `Err(LauncherErrorDto)` 的序列化结果整份交给 `invoke` 的 catch，所以这里按
 * **形状**认（`code` + `message` 都是字符串），不按命令名认。认不出的拒绝（浏览器壳的
 * 「Tauri IPC 不可用」、宿主线程池崩掉的普通 Error）原样上抛——不冒充启动器错误码。
 */
function toThrowable(err: unknown): Error {
  if (err instanceof LauncherBridgeError) return err;
  // 已经是 Error（含浏览器壳的「Tauri IPC 不可用」）：原样上抛，不改写、不包装
  if (err instanceof Error) return err;
  if (typeof err === 'object' && err !== null) {
    const dto = err as { code?: unknown; message?: unknown; detail?: unknown; retryable?: unknown };
    if (typeof dto.code === 'string' && typeof dto.message === 'string') {
      return new LauncherBridgeError(
        dto.code,
        dto.message,
        typeof dto.detail === 'string' ? dto.detail : undefined,
        dto.retryable === true,
      );
    }
    // 有 message 但没有 code 的裸对象：不是宿主的结构化错误，包成普通 Error
    // （不带 code ⇒ 消费方不会把它当成某条契约错误码去分流）
    if (typeof dto.message === 'string') return new Error(dto.message);
  }
  return new Error(String(err));
}

/** 一条命令（错误先过 `toThrowable`，成功则原样返回宿主 DTO） */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    // 无参命令**不带第二个实参**：`invoke(cmd)` 与 `invoke(cmd, undefined)` 在 IPC 层等价，
    // 但前者让"这条命令没有参数"在调用点上看得出（也让测试的载荷断言逐字成立）。
    return args === undefined ? await invoke<T>(cmd) : await invoke<T>(cmd, args);
  } catch (err) {
    throw toThrowable(err);
  }
}

/**
 * Tauri 对**未注册命令**的拒绝原文：`Command <name> not found`（`tauri::webview` 的
 * `InvokeError`）。这是"旧版桌面壳没有编进这条命令"的唯一可观测信号——没有别的探测入口
 * （JS 侧拿不到命令表），所以只能按这一句话认；认不出的错误**一律不动**。
 */
const UNKNOWN_COMMAND_RE = /^\s*command\s+[\w:.-]+\s+not found\s*\.?\s*$/i;

/**
 * P1 命令的统一入口：成功原样返回；**旧宿主缺命令**时改写成人话错误。
 *
 * 为什么不是让英文 `Command launcher_content_plan not found` 直接冒到 UI：
 * `launcher-core` 的 `normalizeLauncherError` 只认 `code`，没有 code 的拒绝会落回各自调用点的
 * fallbackCode（"内容包预检失败"之类）并把它当成业务失败——用户看到的是"装不上"，
 * 而真相是"这个桌面壳太旧"。这里用契约里已有的 `LAUNCHER_PLATFORM_UNSUPPORTED`
 * （不新增码、不降级、不返回假数据），`detail` 留英文原文供排障折叠。
 *
 * 其余拒绝（宿主结构化错误、IPC 不可用、线程池崩）原样上抛，本层不冒充。
 */
async function callP1<T>(cmd: string, args: Record<string, unknown>, what: string): Promise<T> {
  try {
    return await call<T>(cmd, args);
  } catch (err) {
    if (err instanceof LauncherBridgeError || !(err instanceof Error) || !UNKNOWN_COMMAND_RE.test(err.message)) {
      throw err;
    }
    throw new LauncherBridgeError(
      'LAUNCHER_PLATFORM_UNSUPPORTED',
      `当前桌面壳不支持${what}（宿主未注册 ${cmd}，请升级桌面壳）`,
      `宿主未注册命令 ${cmd}（旧版桌面壳）`,
      false,
    );
  }
}

/* ------------------------------- 事件 ------------------------------- */

/**
 * 订阅一条宿主事件。
 *
 * `listen` 是异步的（`@tauri-apps/api/event` 要等 IPC 通道建好），而契约里的
 * `Unsubscribe` 是同步返回 ⇒ 这里返回一个**立刻可用的取消句柄**：
 * - 已订阅：调一次 `unlisten`；
 * - 还没订阅上就取消：标记 `cancelled`，等 `listen` 落定时立刻退订（不漏挂监听）。
 *
 * **不做去重**：`seq`（宿主严格递增）由消费方使用，本层按到货顺序逐条转交——
 * 在这里丢一条"看起来重复"的事件等于替消费方决定语义。
 */
function subscribe<T>(event: string, listener: (payload: T) => void): Unsubscribe {
  let unlisten: Unsubscribe | undefined;
  let cancelled = false;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<T>(event, (e) => listener(e.payload)))
    .then((off) => {
      if (cancelled) off();
      else unlisten = off;
    })
    .catch((err: unknown) => {
      // 同步签名里没法把建监听失败抛给调用方；出声但不假装订阅成功（不会有人收到事件）
      console.warn(`[launcher-bridge] 订阅 ${event} 失败：`, err);
    });
  return () => {
    cancelled = true;
    const off = unlisten;
    unlisten = undefined;
    off?.();
  };
}

/* ------------------------------- 目录枚举 ------------------------------- */

/**
 * 契约的 `InstanceOpenTarget` → 宿主 `launcher_instance_open_folder` 的 `which`。
 *
 * 两侧**不是**同一张表（宿主只认 instance / game / logs / backups / staging）：
 * 契约的 `root` 就是宿主的 `instance`；宿主的 `staging` 契约里没有（P1 面，UI 不用）。
 * 契约的 `saves` **宿主没有对应目标**（存档根是按 saveRoot 声明的一族目录，没有单一
 * 「存档目录」）——这里明确抛出而不是拿一个相近的值顶上（顶上去用户会看到别的目录）。
 */
function openTargetOf(which: InstanceOpenTarget): string {
  switch (which) {
    case 'root':
      return 'instance';
    case 'game':
      return 'game';
    case 'logs':
      return 'logs';
    case 'backups':
      return 'backups';
    case 'saves':
      throw new Error('宿主没有「打开存档目录」这个目标（存档根是一族目录，请用逐根授权后打开）');
  }
}

/* ------------------------------- 桥本体 ------------------------------- */

export const launcherBridge: LauncherHostBridge & ContentHostCommands & SaveHostBridge = {
  /* ---- 实例 ---- */

  instanceList: () => call<readonly LauncherInstance[]>('launcher_instance_list'),

  instanceInspect: (instanceId: string) =>
    call<InstanceInspection>('launcher_instance_get', { instanceId }),

  /** 宿主不认识 adapter：`profile` 由 TS 侧（adapter 的 `buildProfile`）编译好整份送过去 */
  instanceCreate: (request: CreateInstanceRequest, profile: LaunchProfile) =>
    call<InstanceCreation>('launcher_instance_create', { request, profile }),

  instanceUpdate: (instanceId: string, patch: InstancePatch) =>
    call<LauncherInstance>('launcher_instance_update', { instanceId, patch }),

  /**
   * `keepBackups` 是宿主的 `Option<bool>`，契约里也是可选 ⇒ 没给就传 `null`
   * （宿主 `unwrap_or(false)`：不保留备份）。
   */
  instanceRemove: (instanceId: string, opts: RemoveInstanceOptions) =>
    call<void>('launcher_instance_remove', {
      instanceId,
      deleteFiles: opts.deleteFiles,
      keepBackups: opts.keepBackups ?? null,
    }),

  instanceDuplicate: (instanceId: string, name?: string) =>
    call<InstanceCreation>('launcher_instance_duplicate', { instanceId, name: name ?? null }),

  /* ---- 目录（原生对话框即授权，JS 拿不到可编程的授权入口） ---- */

  pickSourceRoot: (title?: string) =>
    call<string | null>('launcher_pick_source_root', { title: title ?? null }),

  pickWriteRoot: (instanceId: string, rootId: string) =>
    call<string | null>('launcher_pick_write_root', { instanceId, rootId }),

  /**
   * `launcher_pick_archive`（P1）：只选不读不写——返回的绝对路径随后作为 `archivePath`
   * 传给 `contentPlan` / `saveImport`，那是**输入件**而不是写落点（铁律 6）。
   */
  pickArchive: (title?: string) =>
    callP1<string | null>('launcher_pick_archive', { title: title ?? null }, '选择压缩包'),

  openInstanceFolder: async (instanceId: string, which: InstanceOpenTarget) =>
    call<void>('launcher_instance_open_folder', { instanceId, which: openTargetOf(which) }),

  /* ---- 信任 ---- */

  /** 哈希与原生确认框都在宿主命令内；本层不传哈希、也没有跳过确认的开关 */
  trustExecutable: (instanceId: string) =>
    call<ExecutableTrust>('launcher_trust_executable', { instanceId }),

  /* ---- 进程 ---- */

  start: (instanceId: string) => call<ProcessStatus>('launcher_start', { instanceId }),

  stop: (instanceId: string, opts?: StopOptions) =>
    call<ProcessStatus>('launcher_stop', {
      instanceId,
      force: opts?.force ?? null,
      timeoutMs: opts?.timeoutMs ?? null,
    }),

  processStatus: (instanceId: string) =>
    call<ProcessStatus>('launcher_process_status', { instanceId }),

  processList: () => call<readonly ProcessStatus[]>('launcher_process_list'),

  /* ---- 日志（原始字节块过桥，解码归 core：宿主不解码） ---- */

  logTail: (instanceId: string, query?: LogQuery) =>
    call<HostLogPage>('launcher_log_tail', { instanceId, query: query ?? null }),

  logSessions: (instanceId: string) =>
    call<readonly LogSession[]>('launcher_log_sessions', { instanceId }),

  logRead: (sessionId: string, query?: LogQuery) =>
    call<HostLogPage>('launcher_log_read', { sessionId, query: query ?? null }),

  /**
   * 原生保存对话框 + 写盘同在宿主一个命令内（落点由对话框当场选定）。
   * `includeDiagnostics` 宿主接受但契约没有格位（诊断段开关）⇒ 恒传 `null`，
   * 即宿主默认的「不带诊断段」；要开放得先补契约。
   */
  logExport: (instanceId: string, sessionId?: string) =>
    call<string | null>('launcher_log_export', {
      instanceId,
      sessionId: sessionId ?? null,
      includeDiagnostics: null,
    }),

  /* ---- 任务 ---- */

  taskList: () => call<readonly LauncherTask[]>('launcher_task_list'),

  taskCancel: (taskId: string) => call<void>('launcher_task_cancel', { taskId }),

  /* ---- 内容包（P1：`launcher_content_*` 七条；解包 / 写盘 / 回滚 / ownership 全在宿主） ---- */

  /**
   * `launcher_content_list`：宿主读自己落盘的 `state.json` / `ownership.json`。
   * `manifest` 里的未知字段宿主原样保留（`PackManifestDto.extra` 是 flatten），这里也原样透传。
   */
  contentList: (instanceId: string) =>
    callP1<readonly InstalledContent[]>('launcher_content_list', { instanceId }, '内容包列表'),

  /**
   * `launcher_content_plan`：解到**实例暂存** + 出计划，不碰游戏根。
   *
   * 第三参是 `{ limits }`（Rust `Option<PlanOptionsDto>` → `Option<StagingLimits>`）：
   * 三个数由 `launcher-core` 从契约常量（`ZIP_EXTRACT_LIMITS`）逐调用传入，本层不换档、
   * 不补默认值——宿主自己 `unwrap_or(default)`，第二份默认值就是第二份真相。
   * 返回的 `conflicts[].kind` 多一档 `case-collision`（落盘语义只有看见磁盘的宿主判得了），
   * 这里照样原样给 `launcher-core`，由它折回契约二分。
   */
  contentPlan: (instanceId: string, archivePath: string, opts: { readonly limits: ZipContractLimits }) =>
    callP1<HostContentPlan>(
      'launcher_content_plan',
      { instanceId, archivePath, opts: { limits: opts.limits } },
      '内容包预检',
    ),

  /** `launcher_content_apply`：两阶段的第二半；`planId` 一次性消费，`resolutions` 没给就显式 null */
  contentApply: (planId: string, resolutions?: readonly ConflictResolution[]) =>
    callP1<LauncherTask>(
      'launcher_content_apply',
      { planId, resolutions: resolutions ?? null },
      '内容包安装',
    ),

  /**
   * `launcher_content_uninstall`：`files` = TS 侧算出的「本包独占」ownership 快照
   * （`launcher-core` 永远传数组，空数组 = 没有可删的独占文件）。宿主仍以
   * `ownership.json` 复核——快照只是纵深防御的一层，不是删文件的唯一凭据。
   */
  contentUninstall: (instanceId: string, packId: string, files: readonly ContentFileRef[]) =>
    callP1<LauncherTask>('launcher_content_uninstall', { instanceId, packId, files }, '内容包卸载'),

  contentSetEnabled: (instanceId: string, packId: string, enabled: boolean) =>
    callP1<LauncherTask>(
      'launcher_content_set_enabled',
      { instanceId, packId, enabled },
      '内容包启停',
    ),

  contentSetOrder: (instanceId: string, packIds: readonly string[]) =>
    callP1<void>('launcher_content_set_order', { instanceId, packIds }, '内容包排序'),

  /**
   * `launcher_content_diagnose`：只读。`issues[].code` 宿主会多报 `orphan-file` /
   * `load-order`（契约码表没有这两档）⇒ **原样透传**，映射进 `conflict` 是 `launcher-core`
   * 的事；在本层过滤就等于让孤儿文件永远看不见。
   */
  contentDiagnose: (instanceId: string) =>
    callP1<HostContentDiagnosis>('launcher_content_diagnose', { instanceId }, '内容包诊断'),

  /* ---- 存档（P1：`launcher_save_*` 八条；写落点只有备份目录与原生对话框两种） ---- */

  /**
   * `launcher_save_list`：返回 `{ entries, roots, warnings }`（**不是裸 `SaveEntry[]`**）。
   * `roots[].approved` 是 shared 实例的写回门禁（§9.1），`roots[].exists` 是盘上读数；
   * 三者一起原样交给 `launcher-core` 的 `HostSaveListing`，本层不筛不折。
   */
  saveList: (instanceId: string) =>
    callP1<HostSaveListing>('launcher_save_list', { instanceId }, '存档列表'),

  saveBackups: (instanceId: string) =>
    callP1<readonly SaveBackup[]>('launcher_save_backups', { instanceId }, '存档备份列表'),

  /** `launcher_save_backup`：只写实例备份目录；返回终态任务（`result.backupId` 是消费方读的口） */
  saveBackup: (instanceId: string, req: SaveBackupRequest) =>
    callP1<LauncherTask>('launcher_save_backup', { instanceId, req }, '存档备份'),

  /**
   * `launcher_save_restore`：宿主内**必然**先自动备份当前（`backupCurrent` 缺省 true）。
   * `opts` 是 `Option<RestoreOptionsDto>` ⇒ 没给就传 `null`；给了就把唯一的键显式写出来
   * （`backupCurrent: undefined` 在 serde 眼里等于没给，那正是 `unwrap_or(true)` 的默认）。
   */
  saveRestore: (instanceId: string, backupId: string, opts?: RestoreOptions) =>
    callP1<LauncherTask>(
      'launcher_save_restore',
      {
        instanceId,
        backupId,
        opts: opts === undefined ? null : { backupCurrent: opts.backupCurrent ?? null },
      },
      '存档恢复',
    ),

  saveDeleteBackup: (instanceId: string, backupId: string) =>
    callP1<void>('launcher_save_delete_backup', { instanceId, backupId }, '删除存档备份'),

  /**
   * `launcher_save_import`：解到暂存并预检，**不写实例**。
   * 返回比契约多三个宿主读数（`entryCount` / `totalBytes` / `expiresAt`）⇒ 原样透传：
   * `launcher-core` 用它们做条目数 / 字节闸与「计划过期即作废」，本层丢掉就等于
   * 让它只能靠 TTL 猜。
   */
  saveImport: (instanceId: string, archivePath: string) =>
    callP1<HostSaveImportPlan>('launcher_save_import', { instanceId, archivePath }, '存档导入预检'),

  saveApplyImport: (planId: string, resolutions?: readonly ConflictResolution[]) =>
    callP1<LauncherTask>(
      'launcher_save_apply_import',
      { planId, resolutions: resolutions ?? null },
      '存档导入',
    ),

  /** `launcher_save_export`：原生保存对话框 + 写盘同命令；返回用户选的落点或 null */
  saveExport: (instanceId: string, req: SaveExportRequest) =>
    callP1<string | null>('launcher_save_export', { instanceId, req }, '存档导出'),

  /* ---- 插件源码项目（P1：`launcher_project_*` 两条；校验 / 打包全在 launcher-core） ---- */

  /**
   * `launcher_project_hash`：逐文件流式摘要。
   *
   * `projectDir` 是**输入根**（只读）：宿主先复核它在写允许域内，再按 `artifactDir` +
   * `entries` 解析；本层不拼路径、不规范化条目（第二份路径判据迟早与 `paths.rs` 漂开）。
   * 三个参数逐字来自 `HostProjectHashInput`，`entries` 原样过桥（顺序即配对依据）。
   */
  projectHash: (input: HostProjectHashInput) =>
    callP1<readonly HostFileDigest[]>(
      'launcher_project_hash',
      { projectDir: input.projectDir, artifactDir: input.artifactDir, entries: input.entries },
      '插件项目构建摘要',
    ),

  /**
   * `launcher_project_extract`：解到**宿主暂存**并读回包内清单 + 逐条目读数。
   *
   * 限额是 `{ limits }`（Rust `ProjectExtractOptionsDto`）：三个数由 `launcher-core` 从契约
   * 常量（`ZIP_EXTRACT_LIMITS`）传入，本层不换档、不补默认值；宿主只许收紧。
   * 暂存落点由宿主拼（`launcher/project-staging/`），返回值里的 `stagingDir` 是**读侧**路径。
   */
  projectExtract: (archivePath: string, opts: { readonly limits: ZipContractLimits }) =>
    callP1<HostProjectExtractResult>(
      'launcher_project_extract',
      { archivePath, opts: { limits: opts.limits } },
      '插件项目解包',
    ),

  /* ---- 事件（§7.3；载荷字段名与宿主 json! 逐字相同，含 seq） ---- */

  onProcess: (listener: (event: LauncherProcessEvent) => void) =>
    subscribe<LauncherProcessEvent>('kojo:launcher-process', listener),

  onLog: (listener: (event: LauncherLogEvent) => void) =>
    subscribe<LauncherLogEvent>('kojo:launcher-log', listener),

  onTask: (listener: (event: LauncherTaskEvent) => void) =>
    subscribe<LauncherTaskEvent>('kojo:launcher-task', listener),

  onInstance: (listener: (event: LauncherInstanceEvent) => void) =>
    subscribe<LauncherInstanceEvent>('kojo:launcher-instance', listener),
};

/**
 * 把启动器桥挂到平台对象上（**唯一**挂载点，由 `bootstrap.ts::ensureLauncherPlugin` 调用）。
 *
 * 为什么是"后挂"而不是在 `tauri-bridge.ts` 里静态写上 `launcher: launcherBridge`：
 * 那会把整份桥（38 条命令 + 4 条事件 + 错误映射，二十余 KB 源码）算进开机静态图，
 * 而启动器视图是懒装载的——**桥也应该只在启动器真被打开时才解析**。PS-10 的开机图
 * 闸量得出来这一枚文件（L3c 接线时实测 +1 文件 / +12 KB）。
 *
 * 幂等：重复调用不覆盖已挂的（同一进程内只有一份桥；将来若按能力分平台实现，
 * 先挂者胜，调用方自己负责判定）。
 */
export function attachLauncherBridge(platform: PlatformBridge): void {
  platform.launcher ??= launcherBridge;
}
