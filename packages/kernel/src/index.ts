/**
 * @kojo/kernel —— 口上编辑器内核。
 *
 * 只做四件事：DI 容器 / 事件总线 / 存储域 / 文件 IO（+ 槽位注册表与插件状态面板的数据源）。
 * 零游戏知识；一切游戏内容在适配器插件。
 */

export { createKernel, consoleLogger, type CreateKernelOptions, type Kernel } from './kernel';
export { TypedEventBus, scopedBus, KERNEL_EVENT_NAMES, type KernelEventName } from './bus';
export { ServiceContainer, ServiceConflictError } from './container';
export { PluginRuntime, type PluginRuntimeDeps } from './runtime';
export { SlotRegistryImpl } from './slots';
export {
  FileStorageBackend,
  StorageServiceImpl,
  GLOBAL_SCOPE,
  assertSafeSegment,
  type StorageBackend,
  type StorageFlushReport,
} from './storage';
export { FileIOServiceImpl } from './io';
export { RemoteServiceImpl } from './remote';
export {
  BACKUP_VERSION_RE,
  backupBucketName,
  backupHashOf,
  parseBackupTakenAtMs,
} from './io';
// 回收站 + 批操作 journal（2026-10-16 undo 批）：实现类供测试/宿主注入替身
// W11 回收站可见批：条目形态/年龄尺（trashEntryTimeMs）一并对外——时间线要按同一把尺算剩余天数
export {
  TrashManager,
  TRASH_DIR_NAME,
  TRASH_KEEP_DAYS,
  TRASH_ID_RE,
  TRASH_PAYLOAD_NAME,
  trashEntryTimeMs,
  type TrashListOptions,
  type TrashManifest,
  type TrashRestoreOptions,
} from './trash';
export {
  OpsJournalImpl,
  OP_ID_RE,
  OP_SNAPSHOT_MAX_PER_OP_BYTES,
  OP_SNAPSHOT_MAX_TOTAL_BYTES,
  OP_SNAPSHOT_RETENTION_MAX,
  type OpsJournalDeps,
} from './journal';
// journal 维护态（崩溃/回滚失败残留）的契约类型：宿主与观测面板经它读数（additive 追加，勿重排上一行）
export type { OpsMaintenance } from './journal';
export {
  FileWatcherServiceImpl,
  WATCH_DEBOUNCE_MS,
  type FileWatchController,
  type FileWatcherDeps,
} from './watcher';
export { ProjectServiceImpl, type ProjectServiceDeps } from './project';
export { WorkspaceServiceImpl, type WorkspaceServiceDeps } from './workspace';
// 计算池（内核设施 `kernel.compute`）：时间片调度 + 优先级 + 单飞尾缘合并
export { createComputePool, DEFAULT_SLICE_MS } from './compute';

// 纯工具 re-export（实现位于 plugin-api——公共纯工具住公共包，插件也可直接使用）
export {
  pathStyle,
  sepOf,
  isAbsolute,
  normalize,
  join,
  dirname,
  basename,
  extname,
  isPathUnder,
  pathKey,
  type PathStyle,
} from '@kojo/plugin-api';
export {
  probeEncoding,
  isValidUtf8,
  decodeWithProbe,
  detectEol,
  normalizeEol,
  applyEol,
  type EolStyle,
  type ProbedDecode,
} from './encoding';
