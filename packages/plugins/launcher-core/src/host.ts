/**
 * 宿主桥（服务键 `kernel.launcher`）的**本包局部**结构契约。
 *
 * ## 为什么这些类型住这里，而不是 `@kojo/plugin-api`
 *
 * `plugin-api/launcher.ts` v0.4 定义了领域面（`LauncherService` 及其子服务）与宿主命令的
 * **命名/参数约定**（§7.1 命令表），但**没有**导出宿主桥的 TS 接口（`LauncherHostBridge`）。
 * 那一层原本规划为 `kernel/src/launcher.ts` 的零逻辑透传；本批（L4）落在插件层，而插件
 * 只许依赖 `@kojo/plugin-api`，所以桥的形状在这里按 §7.1 的表**逐条映射**声明一次。
 *
 * 纪律：
 * - 方法名 = 命令名的 camelCase 投影（`launcher_instance_list` → `instanceList`），一个方法
 *   只对应一条命令，**不在本层拼任何路径、不做任何持久化**（§4.2：宿主零领域判断、
 *   core 零磁盘操作）；
 * - 本文件只放**类型**，不放默认实现；测试用的假宿主在 `tests/helpers/fake-host.ts`。
 *
 * ## 已知契约缺口（已在交付回复里逐条上报，不在此处擅自扩 `plugin-api`）
 *
 * 1. `launcher_instance_create` 的参数表只写了 `{ request }`，但宿主不认识 adapter、
 *    无法自己编译 `LaunchProfile`；而 `CreateInstanceRequest` 里也没有放 profile 的字段。
 *    本桥把它声明成 `instanceCreate(request, profile)`（两个参数），宿主命令需扩一个
 *    `profile` 字段——否则「创建实例」这条链在真实宿主上无解。
 * 2. `launcher_instance_get` 返回的是 `InstanceInspection`（不是 `LauncherInstance`），
 *    而契约的 `InstanceStore.get` 要的是后者 ⇒ 本层从 inspection 里取 `instance`。
 * 3. `launcher_log_tail` / `launcher_log_read` 的表里写返回 `LogPage`，但 `LogPage` 装的是
 *    **已解码**文本，与 §12.1「解码在 TS 侧」冲突。本桥改声明为 `HostLogPage`（编码后的
 *    原始块），解码在 `log-service.ts` 完成。
 * 4. 事件（§7.3）没有 TS 形状：本文件按载荷表声明四个订阅方法，宿主侧只需桥接成
 *    `app.listen('kojo:launcher-*')`。
 */

import type {
  CreateInstanceRequest,
  ExecutableTrust,
  InstanceChange,
  InstanceCreation,
  InstanceInspection,
  InstancePatch,
  LaunchProfile,
  LauncherInstance,
  LauncherTask,
  LogLine,
  LogQuery,
  LogSession,
  ProcessStatus,
  StopOptions,
  Unsubscribe,
} from '@kojo/plugin-api';

/* ══════════════════════════════════════════════════════════════════════════════
 * 日志（原始字节过桥，解码归 core）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 一段原始日志字节。
 *
 * `stream` / `ts` 由宿主给（它知道读到的是什么流、什么时候读到的）；`bytesBase64`
 * 是**未经解码**的字节——宿主不做第二套编码探测（§12.1 单源纪律）。
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
  /** 是否因 `maxLines` / `maxBytes` 被截断（UI 不能把截断当「只有这些」） */
  readonly truncated: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 事件载荷（§7.3）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** `kojo:launcher-process` */
export interface HostProcessEvent {
  readonly instanceId: string;
  readonly status: ProcessStatus;
  /** 宿主递增序号：乱序/重复事件靠它丢弃（本层只认严格递增） */
  readonly seq: number;
}

/** `kojo:launcher-log`（宿主节流：≥64 KiB 或 ≥100 ms 合并一次） */
export interface HostLogEvent {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly stream: LogLine['stream'];
  readonly seq: number;
  readonly bytesBase64: string;
}

/** `kojo:launcher-task` */
export interface HostTaskEvent {
  readonly task: LauncherTask;
  readonly seq: number;
}

/** `kojo:launcher-instance` */
export interface HostInstanceEvent {
  readonly kind: InstanceChange['kind'];
  readonly instanceId: string;
  readonly seq: number;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 宿主桥
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 特权原语的零逻辑透传（`kernel.launcher`）。
 *
 * 形状约束（与 §13.3 同源）：**没有任何方法接受「目标程序路径」**——启动只认实例 id，
 * 信任只认实例 id，落点只有「宿主按 appData 现算」与「原生对话框即授权」两种形态。
 * 这一条是能力面边界，不是风格问题。
 *
 * 可选方法（`?`）= §7.2 里标 P1 的命令：缺席时本层抛
 * `LAUNCHER_PLATFORM_UNSUPPORTED`（不静默降级、不造假数据）。
 */
export interface LauncherHostBridge {
  /* ---- 实例（launcher_instance_*） ---- */

  /** `launcher_instance_list` */
  instanceList(): Promise<readonly LauncherInstance[]>;
  /** `launcher_instance_get`（返回概况；`InstanceStore.get` 从里面取 `instance`） */
  instanceInspect(instanceId: string): Promise<InstanceInspection>;
  /** `launcher_instance_create`（缺口 1：`profile` 需要宿主命令补一个字段） */
  instanceCreate(request: CreateInstanceRequest, profile: LaunchProfile): Promise<InstanceCreation>;
  /** `launcher_instance_update`（白名单由宿主复核） */
  instanceUpdate(instanceId: string, patch: InstancePatch): Promise<LauncherInstance>;
  /** `launcher_instance_remove`（宿主先停进程、再删实例根） */
  instanceRemove(instanceId: string, opts: { deleteFiles: boolean; keepBackups?: boolean }): Promise<void>;
  /** `launcher_instance_duplicate`（P1） */
  instanceDuplicate?(instanceId: string, name?: string): Promise<InstanceCreation>;

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

  /** `launcher_log_tail`（返回原始块，见缺口 3） */
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

  /* ---- 事件（§7.3） ---- */

  onProcess(listener: (event: HostProcessEvent) => void): Unsubscribe;
  onLog(listener: (event: HostLogEvent) => void): Unsubscribe;
  onTask(listener: (event: HostTaskEvent) => void): Unsubscribe;
  onInstance(listener: (event: HostInstanceEvent) => void): Unsubscribe;
}
