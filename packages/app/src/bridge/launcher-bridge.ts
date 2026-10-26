import type {
  CreateInstanceRequest,
  ExecutableTrust,
  HostLogPage,
  InstanceCreation,
  InstanceInspection,
  InstanceOpenTarget,
  InstancePatch,
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
  ProcessStatus,
  RemoveInstanceOptions,
  StopOptions,
  Unsubscribe,
} from '@kojo/plugin-api';
import { invoke } from './invoke';

/**
 * 桌面壳桥的**启动器面**（`PlatformBridge.launcher`）：Rust 20 条 `launcher_*` 命令 +
 * 4 条事件（`kojo:launcher-process` / `-log` / `-task` / `-instance`）的逐条接线。
 *
 * 三条纪律（改之前先读）：
 *
 * 1. **一个方法 = 一条命令**，方法名 = 命令名的 camelCase 投影（`launcher_instance_list`
 *    → `instanceList`）。本层不拼路径、不做持久化、不解释限额——那是宿主的活；
 *    命令名与参数表逐字来自 `src-tauri/src/launcher/commands.rs`，改名必须两侧一起改。
 * 2. **载荷键用 camelCase**：Tauri 2 在 JS → Rust 边界上把 camelCase 键映射到 snake_case
 *    形参，与既有桥同口径（`exportFile` 的 `fileName`、`marketDownload` 的 `stagingName`）。
 *    可选参数**显式传 `null`**（Rust 侧是 `Option<T>`）：少一个键在 serde 眼里等于走
 *    `#[serde(default)]`，与"显式没给"是两回事。
 * 3. **返回值原样透传**：宿主 DTO 全部 `#[serde(rename_all = "camelCase")]`（`InstanceDto`
 *    / `InspectionDto` / `ProcessStatusDto` / `LogPageDto` / `TaskDto` / `StoredTrust` /
 *    `LauncherErrorDto` 逐个核对过），字段名与 `plugin-api` 逐字相同 ⇒ 这里**不做第二份
 *    改名表**（第二份表迟早与 serde 属性漂开）。反例有测试钉住：喂 snake_case 进来，
 *    出去仍是 snake_case——casing 的唯一真源是 Rust 的 serde 属性，不是本文件
 *    （`packages/app/tests/launcher-desk-bridge.test.ts`）。
 *
 * 待 L3b 落地后补 content/save 两组（`launcher_content_*` / `launcher_save_*`：宿主目前
 * 没有这些命令，写调用只会红在运行期而不是编译期）。
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

export const launcherBridge: LauncherHostBridge = {
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
