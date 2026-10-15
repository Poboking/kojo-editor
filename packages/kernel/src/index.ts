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
} from './storage';
export { FileIOServiceImpl } from './io';
export {
  BACKUP_VERSION_RE,
  backupBucketName,
  backupHashOf,
  parseBackupTakenAtMs,
} from './io';
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
