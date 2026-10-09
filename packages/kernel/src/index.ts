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
export { ProjectServiceImpl, type ProjectServiceDeps } from './project';

// 无平台依赖的纯工具（宿主与插件可直接复用）
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
} from './paths';
export {
  probeEncoding,
  isValidUtf8,
  detectEol,
  normalizeEol,
  applyEol,
  type EolStyle,
} from './encoding';
