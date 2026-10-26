/**
 * 宿主桥类型：**真源在 `@kojo/plugin-api`**（2026-10-26 L1b 契约补齐批起）。
 *
 * 本文件只做一次**名字投影**：L4 批在 `plugin-api` 还没有桥形状时，把 `LauncherHostBridge`
 * 与事件载荷就地声明在这里（并逐条上报了缺口）；L1b 已把它们收进契约
 * （`plugin-api/launcher.ts` §7），于是这里改成纯 alias，**不再保留第二份定义**。
 *
 * 为什么留这层 alias 而不是让各文件直接改 import：`Host*Event` 这套名字在
 * `process-supervisor` / `log-service` / `index` 的公开导出处已经用了一整批，
 * 一次性改名会把 diff 摊到本批无关的文件上。名字是本地习惯，形状只有一份。
 */

export type {
  /** 宿主原语（服务键 `kernel.launcher`）；零逻辑透传，缺席即抛人话 */
  LauncherHostBridge,
  /** 一段**未解码**的日志字节（解码归 `log-service`，宿主不做第二套探测） */
  HostLogChunk,
  /** 宿主返回的一页日志：会话元数据 + 原始块 + 截断标记 */
  HostLogPage,
  /** `kojo:launcher-process`（`seq` 严格递增，消费方按它丢乱序/重复） */
  LauncherProcessEvent as HostProcessEvent,
  /** `kojo:launcher-log`（宿主节流：≥64 KiB 或 ≥100 ms 合并一次） */
  LauncherLogEvent as HostLogEvent,
  /** `kojo:launcher-task` */
  LauncherTaskEvent as HostTaskEvent,
  /** `kojo:launcher-instance` */
  LauncherInstanceEvent as HostInstanceEvent,
} from '@kojo/plugin-api';
