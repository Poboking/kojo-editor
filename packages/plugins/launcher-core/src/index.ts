/**
 * @kojo/plugin-launcher-core
 *
 * 启动器内核面（服务 `launcher.service`；契约 `plugin-api/launcher.ts` §6.2）。
 *
 * ## 本批范围（L4 · P0 骨架 + L6a 内容包编排 + L7a 插件门禁）
 *
 * | 子服务 | 状态 |
 * |---|---|
 * | `instances` 实例库 | ✅ 装配（adapter 编排 + 缓存 + 广播 + inspect 语义组装） |
 * | `processes` 进程监督 | ✅ 装配（core 侧单飞锁 + 状态机记账 + 事件订阅） |
 * | `tasks` 任务中心 | ✅ 装配（快照合并 + 进度节流 + 取消语义） |
 * | `logs` 日志 | ✅ 装配（流式解码 + 环形缓冲 + 诊断包请求编排） |
 * | `saves` 存档 | ✅ 装配（宿主有 `launcher_save_*` 八条命令时；否则仍拒绝，见下） |
 * | `content` 内容包 | ✅ 装配（只读预检裁决 + 两阶段记账 + 每实例单飞 + 任务/取消，见 `content-manager.ts`） |
 * | `plugins` 游戏插件 | ✅ 装配（五道逻辑门禁 + 计划台账 + 单飞；与内容包**共用一把** `InstanceLock`，落盘/卸载/启停/排序/诊断委托内容包管线，见 `plugin-manager.ts`） |
 * | `pluginProjects` 插件源码项目 | ✅ 装配（L7b；项目住 `kernel.workspaces`，构建确定性，见 `plugin-project.ts`） |
 * | `runtimes` | ❌ 未装配（见下） |
 * | `updates`（P2） | ❌ 缺席（契约里本就是可选字段） |
 *
 * **`pluginProjects` 已装配，但两条宿主命令仍是 P1**：`launcher_project_hash`（构建的逐文件摘要）
 * 与 `launcher_project_extract`（把压缩包反解成项目）。真实宿主还没有它们时，`build` /
 * `extractArchive` 各自抛 `LAUNCHER_PLATFORM_UNSUPPORTED` 并**点名**缺哪条命令——
 * 本层不算第二份 SHA-256，也不在 JS 里解 zip（ADR-0010 决策 3）。
 *
 * **`runtimes` 仍未装配**（`launcher_runtime_*` 全标 P1）：每条方法都抛
 * `LAUNCHER_PLATFORM_UNSUPPORTED` 并说清是哪一块没接（不静默、不返回空数组让 UI 以为
 * 「这里就是没有」）。它们随 P1 宿主命令与对应编排一起补，届时只换桩，不动其余服务。
 * 存档、内容包与插件同样按能力探测：宿主还没有对应命令时保持"走到探测再拒绝"的桩，
 * 不降级成半套实现在中途断链。)
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
  FileIO,
  GameAdapter,
  LauncherService,
  Plugin,
  RuntimeManager,
  SaveManager,
  SlotRegistry,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, activeGameAdapter } from '@kojo/plugin-api';
import type { LauncherHostBridge } from './host';
import type { DecodeBytes } from './log-service';
import { ContentManagerImpl } from './content-manager';
import { InstanceLock } from './instance-lock';
import { InstanceStoreImpl } from './instance-store';
import { LogServiceImpl } from './log-service';
import { PluginManagerImpl } from './plugin-manager';
import { PluginProjectServiceImpl } from './plugin-project';
import { ProcessSupervisorImpl } from './process-supervisor';
import { SaveManagerImpl } from './save-manager';
import { saveHostFrom } from './save-host';
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

      /**
       * 插件的两条游戏侧知识：`launch.pluginRules`（清单名 / 顺序来源 / 能力支持面 /
       * 函数分析回调）与 `adapter.conventionPolicy`（「有意重复」的唯一判据）。
       * 两者都只从 adapter 取，本层不认识任何具体游戏。
       */
      const pluginSurfacesOf = (adapterId: string): GameAdapter | undefined => {
        if (!slots) return undefined;
        return activeGameAdapter(slots.query('game.adapter'), adapterId);
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

      /**
       * 存档编排：只在宿主**真有** `launcher_save_*` 八条命令时装配（`saveHostFrom` 探测）。
       * 缺任一条 ⇒ 保留「未装配」桩（P0 行为不变）：半套命令下的恢复链会在中途断掉，
       * 比每个方法各自抛一句不一样的错更糟。
       */
      const saveHost = saveHostFrom(host);
      const saves = saveHost
        ? new SaveManagerImpl({
            host: saveHost,
            getInstance: (instanceId) => instances.get(instanceId),
            saveLayoutOf: (adapterId) => adapterOf(adapterId)?.saveLayout,
            tasks,
            processes,
            ...(options.now === undefined ? {} : { now: options.now }),
          })
        : NOT_ASSEMBLED.saves;

      // 每实例写盘单飞锁（规格 §10.1）：内容包与插件**共用这一把**——两边往同一棵游戏根
      // 写盘、改同一份 ownership.json，各持一把锁时 `content.apply` 与 `plugins.apply`
      // 可以同时跑（L7a 上报的缺口第 7 条）。锁在这里建、在这里 dispose，两个服务只借票。
      const writeLock = new InstanceLock({ tasks });

      // 内容包编排（L6a）：只做只读预检的裁决、两阶段记账、每实例单飞与任务认领；
      // 解包/写盘/回滚/ownership 全在宿主 `launcher_content_*`（缺席则如实拒绝，见 content-manager 文件头）。
      const content = new ContentManagerImpl({
        host,
        tasks,
        processes,
        lock: writeLock,
        getInstance: (instanceId) => instances.get(instanceId),
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      /**
       * 游戏插件门禁（L7a）：文件级计划与落盘走同一组宿主命令，list / uninstall / setEnabled /
       * setOrder / diagnose 委托上面这台内容包管线；插件独有的五道闸住 `plugin-manager.ts`。
       *
       * 两处**故意留空**的注入位（组合根按需接上，本层不猜）：
       * - `baseFunctionIndexOf`：宿主要先能枚举基础游戏的脚本文件，本批没有这条命令，
       *   故函数级冲突只比对已装插件，并在预检 warnings 里如实说明；
       * - `gameVersionOf`：`LauncherInstance` 没有游戏版本字段、宿主也没有对应命令，
       *   缺席时声明版本只展示不拦（`PluginCompatibility.reasons` 写明「未校验」）。
       */
      const plugins = new PluginManagerImpl({
        content,
        host,
        tasks,
        processes,
        lock: writeLock,
        getInstance: (instanceId) => instances.get(instanceId),
        pluginRulesOf: (adapterId) => pluginSurfacesOf(adapterId)?.launch?.pluginRules,
        conventionPolicyOf: (adapterId) => pluginSurfacesOf(adapterId)?.conventionPolicy,
        // 存档备份通道只在宿主真有 `launcher_save_*` 时接上：桩不能当通道（桩会抛错，
        // 那等于把「没有备份能力」伪装成「备份失败」）。
        ...(saveHost ? { saves } : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      /**
       * 插件源码项目（L7b）：项目 = `kernel.workspaces` 里的工作区项目，源码 / 产物分离，
       * 打包只走 `zip.ts::buildZip`（不写第二套打包器）。
       *
       * 两个内核能力面**按需取**（`tryInject`）而不是写进 `requires`：`requires` 是激活闸，
       * 加进去会让「没有工作区的宿主」整块激活失败（实例 / 进程 / 日志随之不可用）。
       * 与契约「能力面显式声明」的差距已上报：缺少时 `create / build / extract` 等方法
       * 各自抛 `LAUNCHER_PLATFORM_UNSUPPORTED` 并点名缺哪个服务键，不降级成假项目。
       */
      const workspaces = ctx.tryInject<WorkspaceService>(KernelServices.Workspaces);
      const io = ctx.tryInject<FileIO>(KernelServices.IO);
      const pluginProjects = new PluginProjectServiceImpl({
        workspaces: workspaces ?? null,
        io: io ?? null,
        host,
        plugins,
        getInstance: (instanceId) => instances.get(instanceId),
        pluginRulesOf: (adapterId) => pluginSurfacesOf(adapterId)?.launch?.pluginRules,
        ...(options.now === undefined ? {} : { now: options.now }),
      });

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
        plugins.dispose();
        content.dispose();
        writeLock.dispose();
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
        content,
        plugins,
        pluginProjects,
        saves,
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
export type {
  ContentDiagnosisReport,
  ContentHostCommands,
  ContentManagerOptions,
  HostContentConflict,
  HostContentDiagnosis,
  HostContentIssue,
  HostContentIssueCode,
  HostContentPlan,
} from './content-manager';
export {
  LAUNCHER_ERROR_MESSAGES,
  isLauncherError,
  isLauncherErrorCode,
  launcherError,
  normalizeLauncherError,
  notAssembled,
} from './errors';
export { InstanceStoreImpl } from './instance-store';
export { ContentManagerImpl } from './content-manager';
export { InstanceLock } from './instance-lock';
export type {
  InstanceLockHandle,
  InstanceLockKind,
  InstanceLockRequest,
  InstanceLockSnapshot,
} from './instance-lock';
export { PluginManagerImpl } from './plugin-manager';
export {
  PluginProjectServiceImpl,
  parseSourceManifest,
  sourceManifestProblems,
  canonicalManifestText,
  canonicalPackText,
  globMatch,
  PLUGIN_PROJECT_KIND,
  PLUGIN_SOURCE_MANIFEST_FILE,
  PLUGIN_PROJECT_GITIGNORE,
  DEFAULT_PLUGIN_ARTIFACT_DIR,
} from './plugin-project';
export type {
  HostFileDigest,
  HostProjectHashInput,
  HostProjectExtractEntry,
  HostProjectExtractResult,
  ProjectHashHost,
  ProjectExtractHost,
  PluginProjectServiceOptions,
  SourceManifestExpect,
} from './plugin-project';
export type {
  HostPluginPlan,
  HostPluginStaging,
  PluginDecision,
  PluginDiagnosisReport,
  PluginHostCommands,
  PluginInstalledView,
  PluginManagerOptions,
  PluginSaveGuard,
  PluginTaskSink,
  PluginTrustRecord,
} from './plugin-manager';
export { ProcessSupervisorImpl, idleStatus } from './process-supervisor';
export { SaveManagerImpl, DEFAULT_SAVE_BACKUP_KEEP, DEFAULT_IMPORT_PLAN_TTL_MS } from './save-manager';
export type { SaveManagerOptions, SaveProcessControl, SaveTaskSink } from './save-manager';
export { saveHostFrom } from './save-host';
export type {
  HostSaveImportPlan,
  HostSaveListing,
  HostSaveRootState,
  SaveHostBridge,
} from './save-host';
export { TaskCenterImpl, isTerminalTaskState, DEFAULT_TASK_PROGRESS_THROTTLE_MS } from './task-center';
export {
  LogServiceImpl,
  StreamingLogDecoder,
  incompleteTailLength,
  decodeBase64,
  AUTO_PROBE_MIN_BYTES,
  DEFAULT_LOG_RING_LINES,
} from './log-service';
