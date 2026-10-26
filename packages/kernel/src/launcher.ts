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
 * `kernel.launcher` 实现：平台桥的**零逻辑透传**（启动器特权面在插件侧的唯一入口）。
 *
 * 内核不解释任何启动判定（就绪 / 哈希 / 运行时 / 每实例锁 / 进程收尸全在宿主），再核一次就是
 * 第二份判据、一定会漂（同 `remote.ts`）；起进程与写盘是两种能力，故不塞进 `kernel.io`。
 * 能力面边界：**没有任何方法接受「目标程序路径」或「写到这里的路径」**；可选能力缺席即人话
 * （不降级、不造假数据）。方法名不在此复述：`kojo-market` 的真源闸按方法名扫生产面。
 */
export class LauncherHostImpl implements LauncherHostBridge {
  constructor(private readonly bridge: PlatformBridge) {}

  private get host(): LauncherHostBridge {
    const host = this.bridge.launcher;
    if (host === undefined) {
      throw new Error('当前平台没有启动器能力（启动游戏需要桌面壳）');
    }
    return host;
  }

  /** 可选命令（规格标 P1）的统一转发器：调用时才取宿主；缺席即人话并点名哪块能力 */
  private p1<K extends keyof LauncherHostBridge>(name: K, what: string): NonNullable<LauncherHostBridge[K]> {
    return (async (...args: never[]) => {
      const fn = this.host[name] as unknown as ((...a: never[]) => unknown) | undefined;
      if (fn === undefined) throw new Error(`当前平台的启动器不支持${what}`);
      return fn.call(this.host, ...args);
    }) as unknown as NonNullable<LauncherHostBridge[K]>;
  }

  instanceDuplicate = this.p1('instanceDuplicate', '复制实例');
  pickWriteRoot = this.p1('pickWriteRoot', '逐根写授权');
  pickArchive = this.p1('pickArchive', '选择压缩包');
  logExport = this.p1('logExport', '导出日志');
  contentList = this.p1('contentList', '内容包列表');
  contentPlan = this.p1('contentPlan', '内容包预检');
  contentApply = this.p1('contentApply', '内容包安装');
  contentUninstall = this.p1('contentUninstall', '内容包卸载');
  contentSetEnabled = this.p1('contentSetEnabled', '内容包启停');
  contentSetOrder = this.p1('contentSetOrder', '内容包排序');
  contentDiagnose = this.p1('contentDiagnose', '内容包诊断');
  saveList = this.p1('saveList', '存档列表');
  saveBackups = this.p1('saveBackups', '存档备份列表');
  saveBackup = this.p1('saveBackup', '存档备份');
  saveRestore = this.p1('saveRestore', '存档恢复');
  saveDeleteBackup = this.p1('saveDeleteBackup', '删除存档备份');
  saveImport = this.p1('saveImport', '存档导入预检');
  saveApplyImport = this.p1('saveApplyImport', '存档导入');
  saveExport = this.p1('saveExport', '存档导出');

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

  /* ---- 目录（对话框即授权） ---- */

  async pickSourceRoot(title?: string): Promise<string | null> {
    return this.host.pickSourceRoot(title);
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
