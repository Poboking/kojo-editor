import type {
  CreateInstanceRequest,
  ExecutableTrust,
  HostLogPage,
  InstanceCreation,
  InstanceInspection,
  InstanceOpenTarget,
  InstancePatch,
  LauncherHostBridge,
  LauncherInstance,
  LauncherInstanceEvent,
  LauncherLogEvent,
  LauncherProcessEvent,
  LauncherTask,
  LauncherTaskEvent,
  LaunchProfile,
  LogQuery,
  LogSession,
  PlatformBridge,
  ProcessStatus,
  RemoveInstanceOptions,
  StopOptions,
  Unsubscribe,
} from '@kojo/plugin-api';

/**
 * `kernel.launcher` 实现：**平台桥的零逻辑透传**（启动器特权面在插件侧的唯一入口）。
 *
 * 为什么单独一个服务键，而不是塞进 `kernel.io`：
 * - 起进程与写盘是**两种能力**（铁律 5/6 的边界），混在文件面里等于「要读盘的人顺带
 *   拿到了要起进程的人」；
 * - 内核**刻意不解释**任何启动判定：实例是否就绪、程序哈希是否匹配、运行时能否解析、
 *   每实例锁、Job Object 收尸全在宿主（§8 / §13）那一条链路里。内核再核一次就是第二份
 *   判据，它一定会漂——照 `remote.ts` 的同族教训。
 *
 * 形状约束（能力面边界，不是风格问题）：**没有任何方法接受「目标程序路径」**，
 * 也没有任何方法接受「写到这里的路径」。启动只认 `instanceId`，信任只认 `instanceId`，
 * 落点只有「宿主按 appData 现算」与「原生对话框即授权」两种。
 *
 * 平台无此能力（Node 桥 / Web 调试宿）时由本层给一句人话——**不降级、不造假数据**，
 * 与 `RemoteServiceImpl.marketPublish` 的缺席口径逐字同族。
 */
export class LauncherHostImpl implements LauncherHostBridge {
  constructor(private readonly bridge: PlatformBridge) {}

  /** 平台级缺席（Node 桥 / Web 宿）给人的一句话；与"某条 P1 命令没实现"分开说 */
  private get host(): LauncherHostBridge {
    const host = this.bridge.launcher;
    if (host === undefined) {
      throw new Error('当前平台没有启动器能力（启动游戏需要桌面壳）');
    }
    return host;
  }

  /* ---- 实例 ---- */

  async instanceList(): Promise<readonly LauncherInstance[]> {
    return this.host.instanceList();
  }

  async instanceInspect(instanceId: string): Promise<InstanceInspection> {
    return this.host.instanceInspect(instanceId);
  }

  async instanceCreate(request: CreateInstanceRequest, profile: LaunchProfile): Promise<InstanceCreation> {
    return this.host.instanceCreate(request, profile);
  }

  async instanceUpdate(instanceId: string, patch: InstancePatch): Promise<LauncherInstance> {
    return this.host.instanceUpdate(instanceId, patch);
  }

  async instanceRemove(instanceId: string, opts: RemoveInstanceOptions): Promise<void> {
    return this.host.instanceRemove(instanceId, opts);
  }

  async instanceDuplicate(instanceId: string, name?: string): Promise<InstanceCreation> {
    const fn = this.host.instanceDuplicate;
    if (fn === undefined) throw new Error('当前平台的启动器不支持复制实例');
    return fn.call(this.host, instanceId, name);
  }

  /* ---- 目录（对话框即授权） ---- */

  async pickSourceRoot(title?: string): Promise<string | null> {
    return this.host.pickSourceRoot(title);
  }

  async pickWriteRoot(instanceId: string, rootId: string): Promise<string | null> {
    const fn = this.host.pickWriteRoot;
    if (fn === undefined) throw new Error('当前平台的启动器不支持逐根写授权');
    return fn.call(this.host, instanceId, rootId);
  }

  async pickArchive(title?: string): Promise<string | null> {
    const fn = this.host.pickArchive;
    if (fn === undefined) throw new Error('当前平台的启动器不支持选择压缩包');
    return fn.call(this.host, title);
  }

  async openInstanceFolder(instanceId: string, which: InstanceOpenTarget): Promise<void> {
    return this.host.openInstanceFolder(instanceId, which);
  }

  /* ---- 进程 ---- */

  async start(instanceId: string): Promise<ProcessStatus> {
    return this.host.start(instanceId);
  }

  async stop(instanceId: string, opts?: StopOptions): Promise<ProcessStatus> {
    return this.host.stop(instanceId, opts);
  }

  async processStatus(instanceId: string): Promise<ProcessStatus> {
    return this.host.processStatus(instanceId);
  }

  async processList(): Promise<readonly ProcessStatus[]> {
    return this.host.processList();
  }

  async trustExecutable(instanceId: string): Promise<ExecutableTrust> {
    return this.host.trustExecutable(instanceId);
  }

  /* ---- 日志（原始块过桥，解码归 TS 侧） ---- */

  async logTail(instanceId: string, query?: LogQuery): Promise<HostLogPage> {
    return this.host.logTail(instanceId, query);
  }

  async logSessions(instanceId: string): Promise<readonly LogSession[]> {
    return this.host.logSessions(instanceId);
  }

  async logRead(sessionId: string, query?: LogQuery): Promise<HostLogPage> {
    return this.host.logRead(sessionId, query);
  }

  async logExport(instanceId: string, sessionId?: string): Promise<string | null> {
    const fn = this.host.logExport;
    if (fn === undefined) throw new Error('当前平台的启动器不支持导出日志');
    return fn.call(this.host, instanceId, sessionId);
  }

  /* ---- 任务 ---- */

  async taskList(): Promise<readonly LauncherTask[]> {
    return this.host.taskList();
  }

  async taskCancel(taskId: string): Promise<void> {
    return this.host.taskCancel(taskId);
  }

  /* ---- 事件 ---- */

  onProcess(listener: (event: LauncherProcessEvent) => void): Unsubscribe {
    return this.host.onProcess(listener);
  }

  onLog(listener: (event: LauncherLogEvent) => void): Unsubscribe {
    return this.host.onLog(listener);
  }

  onTask(listener: (event: LauncherTaskEvent) => void): Unsubscribe {
    return this.host.onTask(listener);
  }

  onInstance(listener: (event: LauncherInstanceEvent) => void): Unsubscribe {
    return this.host.onInstance(listener);
  }
}
