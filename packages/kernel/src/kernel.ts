import type {
  ComputePool,
  EventBus,
  FileIO,
  Logger,
  PlatformBridge,
  Plugin,
  PluginRegistry,
  ProjectService,
  SlotRegistry,
  StorageService,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import { TypedEventBus } from './bus';
import { createComputePool } from './compute';
import { ServiceContainer } from './container';
import { FileIOServiceImpl } from './io';
import { ProjectServiceImpl } from './project';
import { PluginRuntime } from './runtime';
import { SlotRegistryImpl } from './slots';
import { FileStorageBackend, StorageServiceImpl } from './storage';
import { WorkspaceServiceImpl } from './workspace';
import { FileWatcherServiceImpl, type FileWatchController } from './watcher';

/**
 * 内核组装（只做四件事：DI 容器 / 事件总线 / 存储域 / 文件 IO）。
 *
 * 铁律：本包（packages/kernel）源码中不允许出现任何具体游戏名。
 * 一切游戏相关知识只存在于 game.adapter 插件。
 */

export interface CreateKernelOptions {
  /** 平台桥（Node 测试用 NodeBridge；生产用 TauriBridge） */
  platform: PlatformBridge;
  /** 启动时注册的插件（含内置插件与未来从目录扫描来的插件） */
  plugins?: Plugin[];
  /** 内核日志器（默认 console；桌面壳可接管到 UI） */
  logger?: Logger;
  /** 存储后端（默认基于 platform 的文件后端；测试可注入内存后端） */
  storageBackend?: import('./storage.js').StorageBackend;
}

export interface Kernel {
  readonly bus: EventBus;
  readonly io: FileIO;
  readonly storage: StorageService;
  readonly slots: SlotRegistry;
  readonly plugins: PluginRegistry;
  readonly project: ProjectService;
  /** 作者工作区（通用 project/artifact；根目录在应用数据区，恒可写） */
  readonly workspaces: WorkspaceService;
  /**
   * 计算池（2026-10-12 内核优化批）：批量 CPU 工作切成时间片、片间让出主线程。
   * 同时也是服务键 `kernel.compute`（插件经 `inject` 取用）。
   */
  readonly compute: ComputePool;
  /**
   * 文件监视控制器（BUG-5，2026-10-13）：宿主在 project.opened 起、project.closed 停。
   *
   * 内核负责去抖 + 归一化 + `file.changed` / `file.watchState` 广播，
   * **不自动起**——内核测试会开一堆临时项目目录，自动起监视会留下活句柄并制造无关事件。
   */
  readonly fileWatch: FileWatchController;
  /**
   * 服务查询（宿主 / UI / 测试用）。
   * 插件请通过 PluginContext.inject / tryInject（依赖声明式接线），
   * 这里的查询通道面向不做依赖声明的消费场景（如 UI 面板按需取服务）。
   */
  readonly services: ServiceQuery;
  /** 运行期注册插件（随后自动尝试激活） */
  registerPlugin(plugin: Plugin): Promise<void>;
  /** 启动：环检测 + 全量接线 */
  start(): Promise<void>;
  /** 停止：逆序停用全部插件 */
  stop(): Promise<void>;
}

/** 只读服务查询器 */
export interface ServiceQuery {
  tryGet<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key: string): T;
  keys(): string[];
}

export function consoleLogger(prefix = '[kojo]'): Logger {
  return {
    debug: (m, ...a) => console.debug(prefix, m, ...a),
    info: (m, ...a) => console.info(prefix, m, ...a),
    warn: (m, ...a) => console.warn(prefix, m, ...a),
    error: (m, ...a) => console.error(prefix, m, ...a),
  };
}

export async function createKernel(opts: CreateKernelOptions): Promise<Kernel> {
  const kernelLog = opts.logger ?? consoleLogger();

  const bus = new TypedEventBus((eventType, err) => {
    kernelLog.error(`Handler for event '${eventType}' threw:`, err);
  });

  const container = new ServiceContainer();
  const slots = new SlotRegistryImpl();
  const storage = new StorageServiceImpl(opts.storageBackend ?? new FileStorageBackend(opts.platform));
  const io = new FileIOServiceImpl(opts.platform, kernelLog);
  const compute = createComputePool({ log: kernelLog });
  const fileWatch = new FileWatcherServiceImpl({ platform: opts.platform, bus, log: kernelLog });

  // 内核服务以 'kernel' 名义注册（插件通过 requires: ['kernel.bus', ...] 消费）
  container.provide(KernelServices.Bus, bus, 'kernel');
  container.provide(KernelServices.IO, io, 'kernel');
  container.provide(KernelServices.Storage, storage, 'kernel');
  container.provide(KernelServices.Slots, slots, 'kernel');
  container.provide(KernelServices.Compute, compute, 'kernel');

  const runtime = new PluginRuntime({
    container,
    bus,
    slots,
    storageScope: (pluginId) => storage.scope(pluginId),
    logFactory: (pluginId) => {
      const base = opts.logger ?? consoleLogger();
      return {
        debug: (m, ...a) => base.debug(`[${pluginId}] ${m}`, ...a),
        info: (m, ...a) => base.info(`[${pluginId}] ${m}`, ...a),
        warn: (m, ...a) => base.warn(`[${pluginId}] ${m}`, ...a),
        error: (m, ...a) => base.error(`[${pluginId}] ${m}`, ...a),
      };
    },
    kernelLog,
  });

  const project = new ProjectServiceImpl({
    slots,
    bus,
    io,
    globalStorage: storage.global(),
    log: kernelLog,
  });

  // 作者工作区：初始化失败（无平台数据目录）不连累内核启动——服务降级为
  // 「调用时抛带原因错误」，面板自解释呈现
  const workspaces = new WorkspaceServiceImpl({ bridge: opts.platform, io, log: kernelLog });
  try {
    await workspaces.init();
  } catch (err) {
    kernelLog.warn(`Workspace service init failed (degraded): ${String(err)}`);
  }
  container.provide(KernelServices.Workspaces, workspaces, 'kernel');

  const registry: PluginRegistry = {
    list: () => runtime.list(),
    get: (id) => runtime.get(id),
    retry: (id) => runtime.retry(id),
    register: async (plugin) => {
      runtime.register(plugin as Plugin);
      await runtime.tryActivateAll();
    },
    stop: (id) => runtime.stop(id),
  };
  container.provide(KernelServices.Plugins, registry, 'kernel');
  container.provide(KernelServices.Project, project, 'kernel');

  for (const plugin of opts.plugins ?? []) {
    runtime.register(plugin);
  }

  return {
    bus,
    io,
    storage,
    slots,
    plugins: registry,
    project,
    workspaces,
    compute,
    fileWatch,
    services: {
      tryGet: <T = unknown>(key: string): T | undefined => container.tryGet<T>(key),
      get: <T = unknown>(key: string): T => container.get<T>(key),
      keys: (): string[] => container.describe().map((d) => d.key),
    },
    async registerPlugin(plugin: Plugin): Promise<void> {
      runtime.register(plugin);
      await runtime.tryActivateAll();
    },
    async start(): Promise<void> {
      runtime.detectCycles();
      await runtime.tryActivateAll();
      const active = runtime.list().filter((r) => r.status === 'active').length;
      kernelLog.info(`Kernel started: ${active}/${runtime.list().length} plugins active`);
    },
    async stop(): Promise<void> {
      fileWatch.stop();
      await runtime.stopAll();
    },
  };
}
