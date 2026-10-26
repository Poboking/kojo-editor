/**
 * @kojo/plugin-launcher-core
 *
 * 启动器内核面（服务 `launcher.service`；契约 `plugin-api/launcher.ts` §6.2）。
 *
 * ## 本批（L4 · P0 骨架）的范围
 *
 * | 子服务 | 状态 |
 * |---|---|
 * | `instances` 实例库 | ✅ 装配（adapter 编排 + 缓存 + 广播 + inspect 语义组装） |
 * | `processes` 进程监督 | ✅ 装配（core 侧单飞锁 + 状态机记账 + 事件订阅） |
 * | `tasks` 任务中心 | ✅ 装配（快照合并 + 进度节流 + 取消语义） |
 * | `logs` 日志 | ✅ 装配（流式解码 + 环形缓冲 + 诊断包请求编排） |
 * | `runtimes` / `content` / `plugins` / `pluginProjects` / `saves` | ❌ 未装配（见下） |
 * | `updates`（P2） | ❌ 缺席（契约里本就是可选字段） |
 *
 * **未装配的五条都只缺宿主命令**（§7.2 全标 P1）：`launcher_runtime_*` / `launcher_content_*` /
 * `launcher_save_*` / `launcher_pick_archive` / `launcher_project_hash`。本层不造空实现假装能用
 * ——每条方法都抛 `LAUNCHER_PLATFORM_UNSUPPORTED` 并说清是哪一块没接（不静默、不返回空数组
 * 让 UI 以为「这里就是没有」）。它们随 P1 宿主命令与对应编排一起补，届时只换桩，不动上面四条。
 *
 * ## 两条硬边界
 *
 * 1. **不碰盘**：`/launcher/` 下的读写、`instance.json` 原子写与 `.bak`、`running.lock`、路径
 *    规范化与前缀校验全部归宿主命令；本包不 import `node:fs`，也不 `import('node:fs')`。
 * 2. **不 import 内核**：编码探测是内核单源（`decodeWithProbe`），由**应用组合根**注入
 *    （`createLauncherPlugin({ decodeBytes })`）；缺席时退化为按实例 `fallback` 的固定标签解码，
 *    并在结果里标 `probed: false`（不探测、不猜）。
 */

import type {
  ContentManager,
  LauncherService,
  Plugin,
  PluginManager,
  PluginProjectService,
  RuntimeManager,
  SaveManager,
  SlotRegistry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, activeGameAdapter } from '@kojo/plugin-api';
import type { LauncherHostBridge } from './host';
import type { DecodeBytes } from './log-service';
import { InstanceStoreImpl } from './instance-store';
import { LogServiceImpl } from './log-service';
import { ProcessSupervisorImpl } from './process-supervisor';
import { TaskCenterImpl } from './task-center';
import { notAssembled } from './errors';

export interface LauncherPluginOptions {
  /**
   * 编码探测（**签名与内核 `decodeWithProbe` 一致**）：组合根传内核那一个函数，
   * 插件因此不必（也不许）import 内核。缺席 = 固定标签解码，结果 `probed: false`。
   */
  readonly decodeBytes?: DecodeBytes;
  /** 宿主桥；缺省从 `ctx.inject(KernelServices.LauncherHost)` 取。测试用假宿主注入。 */
  readonly host?: LauncherHostBridge;
  /** 任务进度节流窗口（缺省 100 ms，与宿主侧同档） */
  readonly throttleMs?: number;
  /** 每实例实时日志环形缓冲行数（缺省 2000） */
  readonly ringSize?: number;
  readonly now?: () => number;
  readonly newTaskId?: () => string;
}

export function createLauncherPlugin(options: LauncherPluginOptions = {}): Plugin {
  return {
    id: 'launcher-core',
    version: '0.1.0',
    // 能力面 = 服务键面：建进程/弹原生框/写实例目录比 kernel.io 更特权，必须显式 require 这一键。
    // `kernel.io` 一并声明：宿主桥缺席时 P0 的每一条链都无意义（声明即「本插件离开宿主不工作」）；
    // 但本层**不读不写文件**——读盘、路径、持久化全在宿主命令里（文件头硬边界 1）。
    requires: [KernelServices.LauncherHost, KernelServices.IO],
    // 软依赖：槽位缺席 = 取不到 adapter = 该游戏只能编辑不能启动（如实拒绝，不降级）
    optionalRequires: [KernelServices.Slots],
    provides: [WellKnownServices.Launcher],
    activate(ctx) {
      const host = options.host ?? ctx.inject<LauncherHostBridge>(KernelServices.LauncherHost);
      const slots = ctx.tryInject<SlotRegistry>(KernelServices.Slots);

      /** 按 adapterId 取该游戏的启动面（游戏知识只住 adapter，本层只认字段名） */
      const adapterOf = (adapterId: string) => {
        if (!slots) return undefined;
        return activeGameAdapter(slots.query('game.adapter'), adapterId)?.launch;
      };

      const tasks = new TaskCenterImpl({
        ...(options.throttleMs === undefined ? {} : { throttleMs: options.throttleMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.newTaskId === undefined ? {} : { newId: options.newTaskId }),
      });

      /**
       * 删实例前先把在跑的游戏停掉（`remove` 的顺序语义在 core 侧显式写出来）。
       * 进程监督稍后才构造 ⇒ 用一次性占位持有，避免 instances ↔ processes ↔ logs 的构造环。
       */
      let stopIfRunning: (instanceId: string) => Promise<void> = async () => {};

      const instances = new InstanceStoreImpl({
        host,
        adapterOf,
        adoptTask: (task) => {
          tasks.adopt(task, { onCancel: () => host.taskCancel(task.id) });
        },
        stopIfRunning: (instanceId) => stopIfRunning(instanceId),
      });

      const logs = new LogServiceImpl({
        host,
        ...(options.decodeBytes === undefined ? {} : { decodeBytes: options.decodeBytes }),
        // 同步取实例快照：编码策略随实例走，不走一轮 IPC（`initialize()` 会预热缓存）
        getEncoding: (instanceId) => instances.peek(instanceId)?.encoding ?? null,
        ...(options.ringSize === undefined ? {} : { ringSize: options.ringSize }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      const processes = new ProcessSupervisorImpl({
        host,
        ...(options.now === undefined ? {} : { now: options.now }),
        // 会话结束：把该会话未闭合的半行冲出来（日志服务的实时面收尾）
        onTerminal: (status) => logs.finishSession(status.instanceId, status.sessionId),
      });

      // 删实例只在「真的在跑」时先停（`starting` / `stopping` 由宿主的单实例锁收尾，这里不抢）
      stopIfRunning = async (instanceId) => {
        if (processes.status(instanceId).state === 'running') {
          await processes.stop(instanceId, { force: true });
        }
      };

      /** 宿主事件 → 各自的服务（事件是宿主推来的真相，命令返回值只是"我这一步的结果"） */
      const disposers = [
        host.onProcess((event) => processes.applyEvent(event)),
        host.onLog((event) => logs.handleHostEvent(event)),
        host.onTask((event) => {
          tasks.adopt(event.task, { onCancel: () => host.taskCancel(event.task.id) });
        }),
        host.onInstance((event) => {
          instances.applyChange({ kind: event.kind, instanceId: event.instanceId });
        }),
      ];
      for (const dispose of disposers) ctx.onDispose(dispose);

      /**
       * `initialize()`：契约要求「读注册表、做 schema 迁移、恢复上次会话的崩溃记录」。
       * 迁移与崩溃恢复的**权威副本在宿主**（`instance.json` 的 schemaVersion、`running.lock`
       * 的陈旧判定），本层能做且该做的是：预热实例缓存（日志编码策略要用）+ 恢复任务表与
       * 进程表，让 UI 首帧就是真相而不是空表。
       */
      const initialize = async (): Promise<void> => {
        await instances.list();
        tasks.adoptMany(await host.taskList());
        processes.applySnapshot(await host.processList());
      };

      /** `dispose()`：停任务、断事件；**不杀游戏进程**（宿主 app-exit 统一收尸） */
      const shutdown = async (): Promise<void> => {
        for (const dispose of disposers) dispose();
        tasks.dispose();
        logs.dispose();
        processes.dispose();
        instances.dispose();
      };

      const service: LauncherService = {
        instances,
        processes,
        logs,
        tasks,
        runtimes: NOT_ASSEMBLED.runtimes,
        content: NOT_ASSEMBLED.content,
        plugins: NOT_ASSEMBLED.plugins,
        pluginProjects: NOT_ASSEMBLED.pluginProjects,
        saves: NOT_ASSEMBLED.saves,
        initialize,
        dispose: shutdown,
      };

      ctx.provide(WellKnownServices.Launcher, service);
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 未装配子服务的桩（P0 范围外；每条都抛 LAUNCHER_PLATFORM_UNSUPPORTED 并说清是哪一块）
 * ══════════════════════════════════════════════════════════════════════════════ */

const refuse = (label: string) => (): Promise<never> => Promise.reject(notAssembled(label));

const NOT_ASSEMBLED: {
  readonly runtimes: RuntimeManager;
  readonly content: ContentManager;
  readonly plugins: PluginManager;
  readonly pluginProjects: PluginProjectService;
  readonly saves: SaveManager;
} = {
  runtimes: {
    list: refuse('运行时列表'),
    scan: refuse('运行时扫描'),
    importFromDialog: refuse('运行时导入'),
    resolve: refuse('运行时解析'),
    verify: refuse('运行时校验'),
    remove: refuse('运行时删除'),
  },
  content: {
    list: refuse('内容包列表'),
    planInstall: refuse('内容包安装预检'),
    applyInstall: refuse('内容包安装'),
    uninstall: refuse('内容包卸载'),
    setEnabled: refuse('内容包启停'),
    setOrder: refuse('内容包排序'),
    diagnose: refuse('内容包诊断'),
  },
  plugins: {
    list: refuse('游戏插件列表'),
    planInstall: refuse('游戏插件安装预检'),
    applyInstall: refuse('游戏插件安装'),
    uninstall: refuse('游戏插件卸载'),
    setEnabled: refuse('游戏插件启停'),
    setOrder: refuse('游戏插件排序'),
    diagnose: refuse('游戏插件诊断'),
    openSource: refuse('插件源码项目'),
  },
  pluginProjects: {
    list: refuse('插件项目列表'),
    get: refuse('插件项目详情'),
    create: refuse('插件项目创建'),
    update: refuse('插件项目改名'),
    remove: refuse('插件项目删除'),
    projectDir: refuse('插件项目目录'),
    build: refuse('插件构建'),
    planInstall: refuse('插件构建并安装'),
    extract: refuse('插件项目提取'),
    inspectDrift: refuse('插件项目漂移检查'),
  },
  saves: {
    list: refuse('存档列表'),
    backups: refuse('存档备份列表'),
    backup: refuse('存档备份'),
    restore: refuse('存档恢复'),
    removeBackup: refuse('存档备份删除'),
    planImport: refuse('存档导入预检'),
    applyImport: refuse('存档导入'),
    exportArchive: refuse('存档导出'),
  },
};

/** 契约里 P2 才有的更新服务：直接不提供（`LauncherService.updates` 是可选字段） */

export type { LauncherHostBridge, HostLogPage, HostLogChunk } from './host';
export type { DecodeBytes, LauncherLogPage } from './log-service';
export {
  LAUNCHER_ERROR_MESSAGES,
  isLauncherError,
  isLauncherErrorCode,
  launcherError,
  normalizeLauncherError,
  notAssembled,
} from './errors';
export { InstanceStoreImpl } from './instance-store';
export { ProcessSupervisorImpl, idleStatus } from './process-supervisor';
export { TaskCenterImpl, isTerminalTaskState, DEFAULT_TASK_PROGRESS_THROTTLE_MS } from './task-center';
export {
  LogServiceImpl,
  StreamingLogDecoder,
  incompleteTailLength,
  decodeBase64,
  AUTO_PROBE_MIN_BYTES,
  DEFAULT_LOG_RING_LINES,
} from './log-service';
