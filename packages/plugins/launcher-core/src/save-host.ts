/**
 * 存档宿主桥（`launcher_save_*` 八条命令）的**契约投影 + 能力探测**。
 *
 * ## 形状只有一份（L1c 收口）
 *
 * 真源在 `@kojo/plugin-api` §7.4：`HostSaveRootState` / `HostSaveListing` /
 * `HostSaveImportPlan`（连同内容侧的 `HostContent*`）都住契约。本文件此前声明的那三份
 * 局部形状已删除，只做**名字投影**：
 *
 * - 把契约上**可选**的 P1 方法收成一组非可选（`SaveHostBridge`），供 `SaveManagerImpl`
 *   直接使用——它不该在每个调用点各判一次 `undefined`；
 * - `saveHostFrom()` 做能力探测：宿主没有这批命令时返回 `null`，装配处因此继续走
 *   「未装配」桩（P0 行为不变，不造空实现假装能用）。
 *
 * ## 读契约时要知道的三件事（语义，不是形状）
 *
 * 1. 方法名 = 命令名的 camelCase 投影（`launcher_save_delete_backup` → `saveDeleteBackup`）；
 * 2. 参数里**没有任何绝对路径作为写落点**：`rootId` / 相对名 / `backupId` / `planId` 是全部
 *    寻址方式，绝对路径只有两种来源——宿主按实例根现算，或原生对话框的返回值；
 * 3. 八条命令的返回 `LauncherTask` 是**终态快照**（写盘已结束；失败以 reject 表达）。
 *    运行中的进度另走 `kojo:launcher-task`（§7.3），不在命令返回值里；取消走既有
 *    `launcher_task_cancel`（本投影的 `taskCancel`），没有存档专用取消命令。
 */

import type { LauncherHostBridge } from './host';

export type {
  /** 一个 saveRoot 的宿主读数（`approved` = 该根是否在 approvals.json 里，shared 写回门禁） */
  HostSaveRootState,
  /** `launcher_save_list` 的返回：条目 + 逐根授权读数 + 宿主侧警告 */
  HostSaveListing,
  /** `launcher_save_import` 的返回：契约计划 + 宿主可选读数（条目数 / 总字节 / 过期时刻） */
  HostSaveImportPlan,
} from '@kojo/plugin-api';

/**
 * 存档八条命令的零逻辑透传（形状 = 契约 §7.4 的对应方法，**收成非可选**）。
 *
 * 写落点只有三处：实例备份目录（宿主现算）、实例内 saveRoot（copy）、已授权的
 * saveRoot（shared，approvals.json）。本投影**不提供**任何「目标路径」参数。
 */
export type SaveHostBridge = Required<
  Pick<
    LauncherHostBridge,
    | 'saveList'
    | 'saveBackups'
    | 'saveBackup'
    | 'saveRestore'
    | 'saveDeleteBackup'
    | 'saveImport'
    | 'saveApplyImport'
    | 'saveExport'
    | 'taskCancel'
  >
>;

/** 能力探测要看的方法名（顺序即契约表顺序；`taskCancel` 是 P0，但存档取消也共用它） */
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
] as const satisfies readonly (keyof LauncherHostBridge)[];

/**
 * 从启动器宿主桥里取出存档能力面。
 *
 * 契约把 `launcher_save_*` 全标 P1（可选方法）：八条**全在**才装配，缺一条就整块不可用
 * （半套命令下的恢复链会在中途断掉，比不装配更糟）。装配处据此保留「未装配」桩，
 * 而不是让每个方法各自抛一句不一样的错。
 */
export function saveHostFrom(host: LauncherHostBridge): SaveHostBridge | null {
  for (const method of SAVE_HOST_METHODS) {
    if (typeof host[method] !== 'function') return null;
  }
  return host as SaveHostBridge;
}
