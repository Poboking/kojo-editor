/**
 * 假宿主：`LauncherHostBridge` 的内存实现（Node 零进程、零磁盘）。
 *
 * 只做三件事：记调用、按测试给的旋钮应答、把事件推给订阅者。
 * **不模拟**宿主的校验链（那是 Rust 侧用例的活）——这里要证的是 core 的记账与编排。
 */

import type {
  ConflictResolution,
  ContentFileEntry,
  ContentFileRef,
  ContentPackManifest,
  ContentRootSpec,
  CreateInstanceRequest,
  ExecutableTrust,
  InstalledContent,
  InstanceInspection,
  InstanceOpenTarget,
  InstancePatch,
  LauncherError,
  LaunchProfile,
  LauncherInstance,
  LauncherTask,
  LogQuery,
  LogSession,
  ProcessStatus,
  StopOptions,
  Unsubscribe,
  ZipContractLimits,
} from '@kojo/plugin-api';
import type {
  HostInstanceEvent,
  HostLogEvent,
  HostLogPage,
  HostProcessEvent,
  HostTaskEvent,
  LauncherHostBridge,
} from '../../src/host';
import type {
  ContentHostCommands,
  HostContentConflict,
  HostContentDiagnosis,
  HostContentPlan,
} from '../../src/content-manager';
import { isLauncherErrorCode } from '../../src/errors';

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

/* ══════════════════════════════════════════════════════════════════════════════
 * 内容包：fixture 构造器 + `launcher_content_*` 的内存宿主
 *
 * 单独一个子类（`FakeContentHost`），不塞进 `FakeHost`：P0 的用例仍要能拿一台
 * **没有内容命令**的宿主去验「如实拒绝」，两件事不能混。
 * ══════════════════════════════════════════════════════════════════════════════ */

export function makeContentRoot(id: string, patch: Partial<ContentRootSpec> = {}): ContentRootSpec {
  return {
    id,
    label: `根 ${id}`,
    relativePath: id,
    kind: 'script',
    accepts: ['script', 'resource', 'data'],
    writableInShared: true,
    ...patch,
  };
}

export function makeContentFile(rootId: string, path: string, size = 16): ContentFileEntry {
  return { rootId, path, sha256: 'c'.repeat(64), size };
}

export function makeContentManifest(patch: Partial<ContentPackManifest> = {}): ContentPackManifest {
  return {
    schemaVersion: 1,
    id: 'demo.pack',
    name: '演示内容包',
    version: '1.0.0',
    kind: 'script',
    gameId: 'demo',
    files: [],
    loadOrder: 0,
    ...patch,
  };
}

export function makeInstalledContent(input: {
  readonly manifest: ContentPackManifest;
  readonly enabled?: boolean;
  readonly order?: number;
  readonly installedAt?: string;
  readonly ownedFiles?: readonly ContentFileRef[];
  readonly status?: InstalledContent['status'];
}): InstalledContent {
  return {
    manifest: input.manifest,
    enabled: input.enabled ?? true,
    order: input.order ?? 0,
    installedAt: input.installedAt ?? '2026-10-26T00:00:00.000Z',
    ownedFiles: input.ownedFiles ?? [],
    status: input.status ?? 'ok',
  };
}

export function makeHostConflict(
  rootId: string,
  path: string,
  patch: Partial<HostContentConflict> = {},
): HostContentConflict {
  return {
    rootId,
    path,
    kind: 'base-file',
    existingPackId: null,
    resolution: 'abort',
    ...patch,
  };
}

/**
 * 造一份宿主计划：`additions` 默认 = 清单里没被 `overwrites` / `conflicts` 点名的文件
 * （core 会核「计划与清单逐条对得上」，所以默认值必须自洽）。
 */
export function makeHostContentPlan(input: {
  readonly manifest: ContentPackManifest;
  readonly planId?: string;
  readonly additions?: readonly ContentFileRef[];
  readonly overwrites?: readonly ContentFileRef[];
  readonly conflicts?: readonly HostContentConflict[];
  readonly targets?: readonly { readonly rootId: string; readonly relativePath: string }[];
  readonly missingRequirements?: readonly string[];
  readonly warnings?: readonly string[];
  readonly expiresAt?: string;
}): HostContentPlan {
  const conflicts = input.conflicts ?? [];
  const overwrites = input.overwrites ?? [];
  const claimed = new Set([...conflicts, ...overwrites].map((ref) => refKeyOf(ref)));
  const additions =
    input.additions ??
    input.manifest.files
      .filter((file) => !claimed.has(refKeyOf(file)))
      .map((file) => ({ rootId: file.rootId, path: file.path }));
  return {
    planId: input.planId ?? 'plan-1',
    manifest: input.manifest,
    targets: input.targets ?? [
      { rootId: input.manifest.files[0]?.rootId ?? 'script', relativePath: '' },
    ],
    additions,
    overwrites,
    conflicts,
    missingRequirements: input.missingRequirements ?? [],
    warnings: input.warnings ?? [],
    expiresAt: input.expiresAt ?? '2099-01-01T00:00:00.000Z',
  };
}

function refKeyOf(ref: ContentFileRef): string {
  return `${ref.rootId.toLowerCase()}/${ref.path.toLowerCase()}`;
}

function labelOf(ref: ContentFileRef): string {
  return `${ref.rootId}/${ref.path}`;
}

function fakeError(err: unknown): LauncherError {
  const dto = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  const detail = typeof dto.detail === 'string' && dto.detail !== '' ? dto.detail : undefined;
  return {
    code: isLauncherErrorCode(dto.code) ? dto.code : 'LAUNCHER_INTERNAL',
    message: typeof dto.message === 'string' && dto.message !== '' ? dto.message : '假宿主错误',
    ...(detail === undefined ? {} : { detail }),
    retryable: false,
  };
}

/**
 * 带 `launcher_content_*` 的假宿主。
 *
 * 它**模拟宿主的三件事**（其余照旧零磁盘）：
 * - 计划 → 应用：按计划写 `gameFiles`，中途失败就**逆序删掉已写文件**（回滚次序即断言对象）；
 * - ownership：只有成功才落账（取消 / 失败一律不写）；
 * - 卸载：只删传入的 `files`（core 交来的「本包独占」清单），不动别的包的文件。
 */
export class FakeContentHost extends FakeHost implements ContentHostCommands {
  /** `contentList` 的返回：instanceId → 已装内容 */
  readonly packs = new Map<string, InstalledContent[]>();
  /** 预检脚本：archivePath → 计划 */
  readonly planByArchive = new Map<string, HostContentPlan>();
  /** 诊断脚本 */
  readonly diagnoses = new Map<string, HostContentDiagnosis>();
  /** 盘上的文件（`rootId/path`）——apply 写、uninstall 删都只作用在这份上 */
  readonly gameFiles = new Set<string>();
  /** 写盘 / 回滚 / 删除的**调用次序**（断言「先停后写」「逆序回滚」） */
  readonly writeLog: string[] = [];
  /** ownership 落账（只有成功才写） */
  readonly ownershipWrites: Array<{ packId: string; files: string[] }> = [];
  readonly uninstallRequests: Array<{ instanceId: string; packId: string; files: string[] }> = [];
  readonly orderRequests: Array<{ instanceId: string; packIds: string[] }> = [];

  /** 最近一次预检收到的限额档（断言「不抄数字」） */
  planLimits: ZipContractLimits | null = null;
  /** 最近一次 apply 收到的冲突决议 */
  applyResolutions: readonly ConflictResolution[] | undefined = undefined;
  /** apply 在第 N 个文件（0 起）上失败；null = 不失败。失败会先逆序回滚已写的。 */
  failApplyAt: number | null = null;
  /** apply 挂起：立刻返回 `running` 任务，终态由测试经 `tasks.adopt` 给 */
  holdApply = false;
  planError: unknown = null;
  listError: unknown = null;
  applyError: unknown = null;
  setEnabledError: unknown = null;
  setOrderError: unknown = null;
  diagnoseError: unknown = null;

  private readonly plansById = new Map<string, HostContentPlan>();
  private readonly planOwner = new Map<string, string>();
  private sequence = 0;

  private nextId(): string {
    this.sequence += 1;
    return `task-host-${this.sequence}`;
  }

  async contentList(instanceId: string): Promise<readonly InstalledContent[]> {
    this.calls.push(`contentList:${instanceId}`);
    if (this.listError !== null) throw this.listError;
    return this.packs.get(instanceId) ?? [];
  }

  async contentPlan(
    instanceId: string,
    archivePath: string,
    opts: { readonly limits: ZipContractLimits },
  ): Promise<HostContentPlan> {
    this.calls.push(`contentPlan:${instanceId}:${archivePath}`);
    this.planLimits = opts.limits;
    if (this.planError !== null) throw this.planError;
    const plan = this.planByArchive.get(archivePath);
    if (!plan) {
      throw { code: 'LAUNCHER_ARCHIVE_INVALID', message: '压缩包不合法或已损坏', detail: archivePath };
    }
    this.plansById.set(plan.planId, plan);
    this.planOwner.set(plan.planId, instanceId);
    return plan;
  }

  async contentApply(
    planId: string,
    resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask> {
    this.calls.push(`contentApply:${planId}`);
    if (this.applyError !== null) throw this.applyError;
    const plan = this.plansById.get(planId);
    if (!plan) throw { code: 'LAUNCHER_INTERNAL', message: '计划不存在或已过期' };
    const instanceId = this.planOwner.get(planId) ?? 'i1';
    this.applyResolutions = resolutions;

    const skipped = new Set(
      (resolutions ?? []).filter((r) => r.action === 'skip').map((r) => refKeyOf(r)),
    );
    // 决议为 overwrite / replace 的冲突条目同样会落盘（skip 的跳过）
    const resolved = plan.conflicts
      .filter((conflict) => !skipped.has(refKeyOf(conflict)))
      .map((conflict) => ({ rootId: conflict.rootId, path: conflict.path }));
    const files = [...plan.additions, ...plan.overwrites, ...resolved].filter(
      (ref) => !skipped.has(refKeyOf(ref)),
    );
    const taskId = this.nextId();
    const running = makeTask(taskId, {
      kind: 'content-install',
      instanceId,
      state: 'running',
      startedAt: '2026-10-26T00:00:01.000Z',
      cancellable: true,
      progress: { done: 0, total: files.length, unit: 'files', message: '写入中' },
    });
    if (this.holdApply) return running;

    const written: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (this.failApplyAt === index) {
          throw {
            code: 'LAUNCHER_ARCHIVE_LIMIT',
            message: '写入时超出体积限额，已中止',
            detail: labelOf(file),
          };
        }
        this.writeLog.push(`write:${labelOf(file)}`);
        this.gameFiles.add(refKeyOf(file));
        written.push(labelOf(file));
      }
      this.ownershipWrites.push({ packId: plan.manifest.id, files: files.map(labelOf) });
      this.recordInstalled(instanceId, plan, files);
      return {
        ...running,
        state: 'succeeded',
        endedAt: '2026-10-26T00:00:02.000Z',
        progress: { done: files.length, total: files.length, unit: 'files', message: '已完成' },
        result: { packId: plan.manifest.id, files: files.length },
      };
    } catch (err) {
      for (const label of [...written].reverse()) {
        this.writeLog.push(`delete:${label}`);
        this.gameFiles.delete(label.toLowerCase());
      }
      this.writeLog.push('rollback-done');
      return {
        ...running,
        state: 'failed',
        endedAt: '2026-10-26T00:00:02.000Z',
        error: fakeError(err),
      };
    }
  }

  async contentUninstall(
    instanceId: string,
    packId: string,
    files: readonly ContentFileRef[],
  ): Promise<LauncherTask> {
    this.calls.push(`contentUninstall:${instanceId}:${packId}`);
    this.uninstallRequests.push({ instanceId, packId, files: files.map(labelOf) });
    for (const file of files) {
      this.writeLog.push(`delete:${labelOf(file)}`);
      this.gameFiles.delete(refKeyOf(file));
    }
    const packs = this.packs.get(instanceId) ?? [];
    this.packs.set(
      instanceId,
      packs.filter((pack) => pack.manifest.id !== packId),
    );
    return makeTask(this.nextId(), {
      kind: 'content-uninstall',
      instanceId,
      state: 'succeeded',
      startedAt: '2026-10-26T00:00:01.000Z',
      endedAt: '2026-10-26T00:00:02.000Z',
      result: { packId, removed: files.length },
    });
  }

  async contentSetEnabled(
    instanceId: string,
    packId: string,
    enabled: boolean,
  ): Promise<LauncherTask> {
    this.calls.push(`contentSetEnabled:${instanceId}:${packId}:${enabled}`);
    if (this.setEnabledError !== null) throw this.setEnabledError;
    const packs = this.packs.get(instanceId) ?? [];
    const target = packs.find((pack) => pack.manifest.id === packId);
    if (!target) throw { code: 'LAUNCHER_CONTENT_BROKEN', message: '该内容包未安装' };
    target.enabled = enabled;
    return makeTask(this.nextId(), {
      kind: 'content-toggle',
      instanceId,
      state: 'succeeded',
      startedAt: '2026-10-26T00:00:01.000Z',
      endedAt: '2026-10-26T00:00:02.000Z',
      result: { packId, enabled },
    });
  }

  async contentSetOrder(instanceId: string, packIds: readonly string[]): Promise<void> {
    this.calls.push(`contentSetOrder:${instanceId}:${packIds.join(',')}`);
    if (this.setOrderError !== null) throw this.setOrderError;
    this.orderRequests.push({ instanceId, packIds: [...packIds] });
    const packs = this.packs.get(instanceId) ?? [];
    packIds.forEach((packId, index) => {
      const target = packs.find((pack) => pack.manifest.id === packId);
      if (target) target.order = index;
    });
  }

  async contentDiagnose(instanceId: string): Promise<HostContentDiagnosis> {
    this.calls.push(`contentDiagnose:${instanceId}`);
    if (this.diagnoseError !== null) throw this.diagnoseError;
    return this.diagnoses.get(instanceId) ?? { instanceId, issues: [] };
  }

  /** 装进 `contentList`（成功 apply 后调用；order 取现有数量） */
  private recordInstalled(
    instanceId: string,
    plan: HostContentPlan,
    files: readonly ContentFileRef[],
  ): void {
    const packs = this.packs.get(instanceId) ?? [];
    const installed = makeInstalledContent({
      manifest: plan.manifest,
      order: packs.length,
      ownedFiles: files,
    });
    this.packs.set(instanceId, [
      ...packs.filter((pack) => pack.manifest.id !== plan.manifest.id),
      installed,
    ]);
  }
}
