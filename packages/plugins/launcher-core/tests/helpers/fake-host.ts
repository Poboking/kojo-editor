/**
 * 假宿主：`LauncherHostBridge` 的内存实现（Node 零进程、零磁盘）。
 *
 * 只做三件事：记调用、按测试给的旋钮应答、把事件推给订阅者。
 * **不模拟**宿主的校验链（那是 Rust 侧用例的活）——这里要证的是 core 的记账与编排。
 */

import type {
  CreateInstanceRequest,
  ExecutableTrust,
  InstanceInspection,
  InstanceOpenTarget,
  InstancePatch,
  LaunchProfile,
  LauncherInstance,
  LauncherTask,
  LogQuery,
  LogSession,
  ProcessStatus,
  StopOptions,
  Unsubscribe,
} from '@kojo/plugin-api';
import type {
  HostInstanceEvent,
  HostLogEvent,
  HostLogPage,
  HostProcessEvent,
  HostTaskEvent,
  LauncherHostBridge,
} from '../../src/host';

export function makeInstance(overrides: Partial<LauncherInstance> = {}): LauncherInstance {
  return {
    id: 'i1',
    name: '测试实例',
    adapterId: 'demo-adapter',
    gameId: 'demo',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    sourceRoot: 'C:/games/demo',
    isolation: 'shared',
    instanceRoot: 'C:/appData/launcher/instances/i1',
    gameRoot: 'C:/games/demo',
    state: 'ready',
    executable: {
      relativePath: 'game.exe',
      args: [],
      env: {},
      windowMode: 'auto',
      sha256: 'a'.repeat(64),
    },
    runtimeId: null,
    locale: { mode: 'system' },
    encoding: { mode: 'fixed', fallback: 'shift_jis' },
    saveRoots: [],
    contentRoots: [],
    executableTrust: {
      sha256: 'a'.repeat(64),
      size: 1024,
      approvedAt: '2026-10-26T00:00:00.000Z',
      approvedBy: 'native-dialog',
    },
    launchCount: 0,
    lastLaunchedAt: null,
    lastExit: null,
    schemaVersion: 1,
    ...overrides,
  };
}

export function makeStatus(
  instanceId: string,
  patch: Partial<ProcessStatus> = {},
): ProcessStatus {
  return {
    instanceId,
    state: 'idle',
    pid: null,
    sessionId: null,
    startedAt: null,
    elapsedMs: 0,
    exitCode: null,
    exitReason: null,
    lastError: null,
    ...patch,
  };
}

export function makeInspection(
  instance: LauncherInstance,
  patch: Partial<InstanceInspection> = {},
): InstanceInspection {
  return {
    instance,
    executable: {
      absolutePath: `${instance.gameRoot}/${instance.executable.relativePath}`,
      exists: true,
      sha256: instance.executable.sha256,
      trusted: true,
      changedSinceTrust: false,
    },
    runtime: { required: null, resolved: null },
    paths: {
      instanceRoot: instance.instanceRoot,
      gameRoot: instance.gameRoot,
      saveRoots: [],
      logDir: `${instance.instanceRoot}/logs`,
      backupDir: `${instance.instanceRoot}/backups`,
    },
    diskUsageBytes: 0,
    warnings: [],
    ...patch,
  };
}

export function makeTask(id: string, patch: Partial<LauncherTask> = {}): LauncherTask {
  return {
    id,
    kind: 'content-install',
    instanceId: 'i1',
    state: 'queued',
    progress: null,
    createdAt: '2026-10-26T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    error: null,
    result: null,
    cancellable: true,
    ...patch,
  };
}

export class FakeHost implements LauncherHostBridge {
  readonly calls: string[] = [];
  readonly cancelRequests: string[] = [];

  instances: LauncherInstance[] = [];
  inspections = new Map<string, InstanceInspection>();
  statuses = new Map<string, ProcessStatus>();
  tasks: LauncherTask[] = [];
  /** 日志页：`tail` 用实例 id 取，`read` 用会话 id 取 */
  logPages = new Map<string, HostLogPage>();
  sessionLists = new Map<string, LogSession[]>();
  exportResult: string | null = 'C:/tmp/diagnostics.zip';
  /** 来源根对话框的返回值（null = 用户取消，授权表一个字节都不动） */
  sourceRootPick: string | null = 'C:/games/fake-src';

  /** 旋钮：缺省 = 直接进 running */
  startImpl: (instanceId: string) => Promise<ProcessStatus> = async (instanceId) =>
    makeStatus(instanceId, {
      state: 'running',
      pid: 4242,
      sessionId: `s-${instanceId}`,
      startedAt: '2026-10-26T00:00:00.000Z',
    });
  stopImpl: (instanceId: string, opts?: StopOptions) => Promise<ProcessStatus> = async (
    instanceId,
    opts,
  ) =>
    makeStatus(instanceId, {
      state: 'exited',
      sessionId: `s-${instanceId}`,
      startedAt: '2026-10-26T00:00:00.000Z',
      exitCode: 0,
      exitReason: opts?.force ? 'killed' : 'user',
    });
  createImpl: (
    request: CreateInstanceRequest,
    profile: LaunchProfile,
  ) => Promise<{ instance: LauncherInstance; task: LauncherTask | null }> = async (
    request,
    profile,
  ) => ({
    instance: makeInstance({
      id: 'i-new',
      name: request.name,
      adapterId: request.adapterId,
      gameId: request.gameId,
      sourceRoot: request.sourceRoot,
      isolation: request.isolation,
      executable: { ...makeInstance().executable, relativePath: profile.executable.relativePath },
    }),
    task: null,
  });

  private readonly processListeners = new Set<(event: HostProcessEvent) => void>();
  private readonly logListeners = new Set<(event: HostLogEvent) => void>();
  private readonly taskListeners = new Set<(event: HostTaskEvent) => void>();
  private readonly instanceListeners = new Set<(event: HostInstanceEvent) => void>();

  /* ------------------------------ 实例 ------------------------------ */

  async instanceList(): Promise<readonly LauncherInstance[]> {
    this.calls.push('instanceList');
    return this.instances;
  }

  async instanceInspect(instanceId: string): Promise<InstanceInspection> {
    this.calls.push('instanceInspect');
    const preset = this.inspections.get(instanceId);
    if (preset) return preset;
    const instance = this.instances.find((item) => item.id === instanceId);
    if (!instance) throw { code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '实例不存在' };
    return makeInspection(instance);
  }

  async instanceCreate(
    request: CreateInstanceRequest,
    profile: LaunchProfile,
  ): Promise<{ instance: LauncherInstance; task: LauncherTask | null }> {
    this.calls.push('instanceCreate');
    return this.createImpl(request, profile);
  }

  async instanceUpdate(instanceId: string, patch: InstancePatch): Promise<LauncherInstance> {
    this.calls.push('instanceUpdate');
    const instance = this.instances.find((item) => item.id === instanceId);
    if (!instance) throw { code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '实例不存在' };
    const updated: LauncherInstance = { ...instance, ...patch };
    this.instances = this.instances.map((item) => (item.id === instanceId ? updated : item));
    return updated;
  }

  async instanceRemove(instanceId: string, opts: { deleteFiles: boolean; keepBackups?: boolean }): Promise<void> {
    this.calls.push(`instanceRemove:${opts.deleteFiles}`);
    this.instances = this.instances.filter((item) => item.id !== instanceId);
  }

  /* --------------------------- 目录 / 授权 --------------------------- */

  /** 来源根批准：默认返回一个可辨识的假路径；`sourceRootPick` 设 null 即演练"用户取消" */
  async pickSourceRoot(title?: string): Promise<string | null> {
    this.calls.push(`pickSourceRoot:${title ?? ''}`);
    return this.sourceRootPick;
  }

  /** 打开实例目录：只记录枚举值（本层不接受子路径，测试也不该造一份） */
  async openInstanceFolder(instanceId: string, which: InstanceOpenTarget): Promise<void> {
    this.calls.push(`openInstanceFolder:${instanceId}:${which}`);
  }

  async start(instanceId: string): Promise<ProcessStatus> {
    this.calls.push('start');
    const status = await this.startImpl(instanceId);
    this.statuses.set(instanceId, status);
    return status;
  }

  async stop(instanceId: string, opts?: StopOptions): Promise<ProcessStatus> {
    this.calls.push('stop');
    const status = await this.stopImpl(instanceId, opts);
    this.statuses.set(instanceId, status);
    return status;
  }

  async processStatus(instanceId: string): Promise<ProcessStatus> {
    this.calls.push('processStatus');
    return this.statuses.get(instanceId) ?? makeStatus(instanceId);
  }

  async processList(): Promise<readonly ProcessStatus[]> {
    this.calls.push('processList');
    return [...this.statuses.values()];
  }

  async trustExecutable(instanceId: string): Promise<ExecutableTrust> {
    this.calls.push(`trustExecutable:${instanceId}`);
    return {
      sha256: 'b'.repeat(64),
      size: 1024,
      approvedAt: '2026-10-26T00:00:00.000Z',
      approvedBy: 'native-dialog',
    };
  }

  /* ------------------------------ 日志 ------------------------------ */

  async logTail(instanceId: string, _query?: LogQuery): Promise<HostLogPage> {
    this.calls.push('logTail');
    const page = this.logPages.get(instanceId);
    if (!page) throw { code: 'LAUNCHER_INTERNAL', message: '没有日志' };
    return page;
  }

  async logSessions(instanceId: string): Promise<readonly LogSession[]> {
    this.calls.push('logSessions');
    return this.sessionLists.get(instanceId) ?? [];
  }

  async logRead(sessionId: string, _query?: LogQuery): Promise<HostLogPage> {
    this.calls.push('logRead');
    const page = this.logPages.get(sessionId);
    if (!page) throw { code: 'LAUNCHER_INTERNAL', message: '没有该会话' };
    return page;
  }

  async logExport(instanceId: string, sessionId?: string): Promise<string | null> {
    this.calls.push(`logExport:${instanceId}:${sessionId ?? '-'}`);
    return this.exportResult;
  }

  /* ------------------------------ 任务 ------------------------------ */

  async taskList(): Promise<readonly LauncherTask[]> {
    this.calls.push('taskList');
    return this.tasks;
  }

  async taskCancel(taskId: string): Promise<void> {
    this.calls.push('taskCancel');
    this.cancelRequests.push(taskId);
  }

  /* ------------------------------ 事件 ------------------------------ */

  onProcess(listener: (event: HostProcessEvent) => void): Unsubscribe {
    this.processListeners.add(listener);
    return () => this.processListeners.delete(listener);
  }

  onLog(listener: (event: HostLogEvent) => void): Unsubscribe {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onTask(listener: (event: HostTaskEvent) => void): Unsubscribe {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }

  onInstance(listener: (event: HostInstanceEvent) => void): Unsubscribe {
    this.instanceListeners.add(listener);
    return () => this.instanceListeners.delete(listener);
  }

  emitProcess(event: HostProcessEvent): void {
    for (const listener of [...this.processListeners]) listener(event);
  }

  emitLog(event: HostLogEvent): void {
    for (const listener of [...this.logListeners]) listener(event);
  }

  emitTask(event: HostTaskEvent): void {
    for (const listener of [...this.taskListeners]) listener(event);
  }

  emitInstance(event: HostInstanceEvent): void {
    for (const listener of [...this.instanceListeners]) listener(event);
  }

  /** 已注册的事件订阅数（`dispose` 断言用） */
  listenerCount(): number {
    return (
      this.processListeners.size + this.logListeners.size + this.taskListeners.size + this.instanceListeners.size
    );
  }
}

/** base64（测试侧用 Node 的 Buffer 就够，插件侧走自带的纯 JS 解码） */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** 一段日志块的便捷构造 */
export function logChunk(ts: number, bytes: Uint8Array, stream: 'stdout' | 'stderr' | 'system' = 'stdout') {
  return { ts, stream, bytesBase64: toBase64(bytes) };
}
