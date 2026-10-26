/**
 * 存档宿主桥（`launcher_save_*` 八条命令）的**本包局部**结构契约。
 *
 * ## 为什么单开一份，而不是塞进 `host.ts`
 *
 * `LauncherHostBridge`（`host.ts`）投影的是 §7.2 里 P0 已落地的命令；存档八条全标 P1，
 * 且 §7.2 的返回形状有三处装不下本层需要的信息（见下「已知契约缺口」）。本文件只做
 * **形状声明 + 能力探测**，不实现任何命令：
 *
 * - 方法名 = 命令名的 camelCase 投影（`launcher_save_delete_backup` → `saveDeleteBackup`）；
 * - 参数里**没有任何绝对路径作为写落点**：`rootId` / 相对名 / `backupId` / `planId` 是全部
 *   寻址方式，绝对路径只有两种来源——宿主按实例根现算，或原生对话框的返回值；
 * - `saveHostFrom()` 做能力探测：真实宿主还没有这批命令时返回 `null`，装配处因此继续
 *   走「未装配」桩（P0 行为不变，不造空实现假装能用）。
 *
 * ## 已知契约缺口（已在交付回执里逐条上报，不擅自扩 `plugin-api`）
 *
 * 1. `launcher_save_list` 的返回表里只有 `SaveEntry[]`，没有「哪些 saveRoot 已获写授权」
 *    ——而 shared 实例的写回门禁（§9.1）判的正是这个。本桥补 `HostSaveListing.roots[]`
 *    （每根一条 `approved`）；`SaveEntry[]` 本身不变。
 * 2. `SaveImportPlan` 没有条目数 / 总字节 / 过期时刻，而 §11.4 的预检与「计划过期即作废」
 *    需要它们。本桥让宿主**可选**多报 `entryCount` / `totalBytes` / `expiresAt`；
 *    缺席时本层不猜（条数/字节只能靠宿主读数，过期时刻落回本层 TTL）。
 * 3. 八条命令的返回 `LauncherTask` 在本桥里被要求**是终态快照**（写盘已结束；失败以
 *    reject 表达）。运行中的进度另走 `kojo:launcher-task`（§7.3），不在命令返回值里。
 * 4. 取消走既有 `launcher_task_cancel`（本桥 `taskCancel`），不新增存档专用取消命令。
 */

import type {
  ConflictResolution,
  LauncherTask,
  RestoreOptions,
  SaveBackup,
  SaveBackupRequest,
  SaveEntry,
  SaveExportRequest,
  SaveImportPlan,
} from '@kojo/plugin-api';
import type { LauncherHostBridge } from './host';

/* ══════════════════════════════════════════════════════════════════════════════
 * 读数（比契约多出的部分，见缺口 1 / 2）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 一个 saveRoot 的宿主读数（`approved` = 该根是否在 approvals.json 里） */
export interface HostSaveRootState {
  readonly rootId: string;
  /** copy 实例宿主恒报 true；shared 实例看 approvals.json（§9.1） */
  readonly approved: boolean;
  /** 该根在盘上是否存在（可选读数；缺席 = 不报） */
  readonly exists?: boolean;
}

/** `launcher_save_list` 的返回：条目 + 逐根授权读数（缺口 1） */
export interface HostSaveListing {
  readonly entries: readonly SaveEntry[];
  readonly roots: readonly HostSaveRootState[];
  /** 宿主侧人话警告（可选；本层会与自己的警告合并） */
  readonly warnings?: readonly string[];
}

/** `launcher_save_import` 的返回：契约计划 + 宿主可选读数（缺口 2） */
export interface HostSaveImportPlan extends SaveImportPlan {
  /** 包内条目数（宿主解包读数；缺席 = 未报，本层不猜） */
  readonly entryCount?: number;
  /** 解包后的总字节（同上） */
  readonly totalBytes?: number;
  /** 暂存计划过期时刻（ISO-8601）；缺席 = 用本层 TTL */
  readonly expiresAt?: string;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 宿主桥
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 存档八条命令的零逻辑透传。
 *
 * 写落点只有三处：实例备份目录（宿主现算）、实例内 saveRoot（copy）、已授权的
 * saveRoot（shared，approvals.json）。本桥**不提供**任何「目标路径」参数。
 */
export interface SaveHostBridge {
  /** `launcher_save_list`：只读 saveRoots（含逐根授权读数） */
  saveList(instanceId: string): Promise<HostSaveListing>;
  /** `launcher_save_backups`：实例备份目录清单 */
  saveBackups(instanceId: string): Promise<readonly SaveBackup[]>;
  /** `launcher_save_backup`：只写实例备份目录；返回终态任务（`result.backupId`） */
  saveBackup(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask>;
  /** `launcher_save_restore`：解包 → 校验 → 逐文件 写临时 + rename；返回终态任务 */
  saveRestore(instanceId: string, backupId: string, opts?: RestoreOptions): Promise<LauncherTask>;
  /** `launcher_save_delete_backup`：只删实例备份目录内的那一份 */
  saveDeleteBackup(instanceId: string, backupId: string): Promise<void>;
  /** `launcher_save_import`：解到暂存并预检；**不写实例** */
  saveImport(instanceId: string, archivePath: string): Promise<HostSaveImportPlan>;
  /** `launcher_save_apply_import`：确认后落盘；返回终态任务 */
  saveApplyImport(planId: string, resolutions?: readonly ConflictResolution[]): Promise<LauncherTask>;
  /** `launcher_save_export`：原生保存对话框 + 写盘同命令；返回用户选的落点或 null */
  saveExport(instanceId: string, req: SaveExportRequest): Promise<string | null>;
  /** `launcher_task_cancel`：取消某条宿主任务（存档任务共用这一条） */
  taskCancel(taskId: string): Promise<void>;
}

/** 能力探测需要看的八个方法名（顺序即契约表顺序） */
const SAVE_HOST_METHODS = [
  'saveList',
  'saveBackups',
  'saveBackup',
  'saveRestore',
  'saveDeleteBackup',
  'saveImport',
  'saveApplyImport',
  'saveExport',
  'taskCancel',
] as const;

/**
 * 从启动器宿主桥里取出存档能力面。
 *
 * 真实宿主尚未提供 `launcher_save_*`（§7.2 标 P1）时返回 `null`——装配处据此保留
 * 「未装配」桩，而不是让每个方法各自抛一句不一样的错。判据是**方法全在**：
 * 缺一条就整块不可用（半套命令下的恢复链会在中途断掉，比不装配更糟）。
 */
export function saveHostFrom(host: LauncherHostBridge): SaveHostBridge | null {
  const candidate = host as unknown as Record<string, unknown>;
  for (const method of SAVE_HOST_METHODS) {
    if (typeof candidate[method] !== 'function') return null;
  }
  return host as unknown as SaveHostBridge;
}
