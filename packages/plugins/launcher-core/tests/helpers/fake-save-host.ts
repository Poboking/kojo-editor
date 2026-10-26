/**
 * 假宿主 · 存档面：在 `FakeHost` 之上补 `launcher_save_*` 八条命令。
 *
 * 只模拟**本层要编排的语义**（不是宿主实现）：
 * - 存档文件摊平成一张表（`rootId` + 相对名 → 字节），恢复 = 整表覆盖，回滚可查；
 * - 备份 = 内存快照 + 清单条目（`backupId` 由本假宿主递增编号）；
 * - 失败/挂起都是旋钮：恢复中途失败、导入半截失败、备份挂起（测取消）。
 * ZIP 解析、哈希、临时文件与 rename 原子性一概不模拟——那是 Rust 侧用例的事。
 */

import type {
  ConflictResolution,
  LauncherTask,
  RestoreOptions,
  SaveBackup,
  SaveBackupRequest,
  SaveExportRequest,
  TaskKind,
} from '@kojo/plugin-api';
import type {
  HostSaveImportPlan,
  HostSaveListing,
  SaveHostBridge,
} from '../../src/save-host';
import { FakeHost, makeTask } from './fake-host';

/** 一份内存存档（`content` 用来断言「恢复/回滚后内容回到哪一版」） */
export interface FakeSaveFile {
  readonly rootId: string;
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly content: string;
}

/** `launcher_save_import` 的旋钮（缺省 = 一个覆盖 `saves/slot1.sav` 的包） */
export interface FakeImportSpec {
  readonly planId?: string;
  readonly overwrites?: readonly string[];
  readonly entryCount?: number;
  readonly totalBytes?: number;
  readonly warnings?: readonly string[];
  readonly expiresAt?: string;
}

export class FakeSaveHost extends FakeHost implements SaveHostBridge {
  /** 内存存档表：`rootId|path` → 文件 */
  readonly saveFiles = new Map<string, FakeSaveFile>();
  /** 已获写授权的 saveRoot（shared 实例读它；copy 恒可写） */
  readonly approvals = new Set<string>();
  readonly backupRecords = new Map<string, SaveBackup>();
  readonly backupContents = new Map<string, FakeSaveFile[]>();
  readonly deletedBackups: string[] = [];

  /** `saveExport` 的返回值（null = 用户在对话框里取消） */
  exportTarget: string | null = null;
  /** 最近一次备份 / 导出请求（断言 core 递下去的字段） */
  lastBackupRequest: SaveBackupRequest | null = null;
  lastExportRequest: SaveExportRequest | null = null;
  /** `saveBackup` 挂起（测取消：直到 `releaseHeld` 或被 cancel 拒绝） */
  holdBackupTasks = false;
  /** `saveApplyImport` 挂起（测单飞） */
  holdApplyImport = false;
  /** 命中的备份在写第 N 个文件后失败（测回滚） */
  restoreFailure: { readonly backupId: string; readonly afterFiles: number } | null = null;
  /** `saveApplyImport` 的失败注入 */
  applyImportMode: 'ok' | 'partial' | 'cancelled' = 'ok';
  /** 下一次 `saveImport` 的旋钮 */
  nextImport: FakeImportSpec | null = null;

  private readonly gates = new Map<
    string,
    { readonly resolve: () => void; readonly reject: (err: unknown) => void }
  >();
  private readonly pendingImports = new Map<
    string,
    { readonly instanceId: string; readonly targetPaths: readonly string[] }
  >();
  private applyWaiter: (() => void) | null = null;
  private applyPromise: Promise<void> | null = null;
  private taskSeq = 0;
  private backupSeq = 0;
  private planSeq = 0;
  private eventSeq = 0;
  private clock = 0;

  /* ------------------------------ 测试辅助 ------------------------------ */

  /** 放一份存档（返回自身，便于链式准备） */
  putSave(rootId: string, path: string, content: string, bytes = content.length): this {
    this.saveFiles.set(`${rootId}|${path}`, {
      rootId,
      path,
      bytes,
      mtimeMs: 1_700_000_000_000 + this.saveFiles.size,
      content,
    });
    return this;
  }

  /** 直接种一条备份记录（测保留策略，不经过 `saveBackup`） */
  seedBackup(backup: SaveBackup, files: readonly FakeSaveFile[] = []): this {
    this.backupRecords.set(backup.id, backup);
    this.backupContents.set(backup.id, [...files]);
    return this;
  }

  /** 当前某条存档的内容（不存在 = null） */
  contentOf(rootId: string, path: string): string | null {
    return this.saveFiles.get(`${rootId}|${path}`)?.content ?? null;
  }

  /** 当前存档表的稳定快照（断言「一个字节都没动」用） */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, file] of [...this.saveFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out[key] = file.content;
    }
    return out;
  }

  /** 放行被 `holdBackupTasks` 挂起的任务 */
  releaseHeld(taskId: string): void {
    const gate = this.gates.get(taskId);
    if (!gate) return;
    this.gates.delete(taskId);
    gate.resolve();
  }

  /** 挂起中的任务 id（没有则 null） */
  heldTaskId(): string | null {
    const first = [...this.gates.keys()][0];
    return first ?? null;
  }

  /** 放行被 `holdApplyImport` 挂起的导入应用 */
  releaseApply(): void {
    const waiter = this.applyWaiter;
    this.applyWaiter = null;
    this.applyPromise = null;
    waiter?.();
  }

  /* ------------------------------ launcher_save_list ------------------------------ */

  async saveList(instanceId: string): Promise<HostSaveListing> {
    this.calls.push(`saveList:${instanceId}`);
    const instance = this.instances.find((item) => item.id === instanceId);
    const roots = instance?.saveRoots ?? [];
    return {
      roots: roots.map((root) => ({
        rootId: root.id,
        approved: this.isApproved(instanceId, root.id),
      })),
      entries: [...this.saveFiles.values()]
        .filter((file) => roots.some((root) => root.id === file.rootId))
        .map((file) => ({
          path: file.path,
          rootId: file.rootId,
          name: file.path,
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
        })),
    };
  }

  /* ------------------------------ launcher_save_backups ------------------------------ */

  async saveBackups(instanceId: string): Promise<readonly SaveBackup[]> {
    this.calls.push(`saveBackups:${instanceId}`);
    return [...this.backupRecords.values()].filter((backup) => backup.instanceId === instanceId);
  }

  /* ------------------------------ launcher_save_backup ------------------------------ */

  async saveBackup(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask> {
    const reason = req.reason ?? 'manual';
    this.calls.push(`saveBackup:${reason}`);
    this.lastBackupRequest = req;
    const task = this.hostTask('save-backup', instanceId, {
      progress: { done: 0, total: 2, unit: 'files', message: '读取存档' },
    });
    this.emitTask({ task, seq: ++this.eventSeq });

    if (this.holdBackupTasks) {
      await this.waitGate(task.id);
    }

    const wanted =
      req.entries && req.entries.length > 0
        ? new Set(req.entries.map((entry) => `${entry.rootId}|${entry.path}`))
        : null;
    const files = [...this.saveFiles.values()].filter(
      (file) => wanted === null || wanted.has(`${file.rootId}|${file.path}`),
    );
    const id = `bak-${++this.backupSeq}`;
    const backup: SaveBackup = {
      id,
      instanceId,
      createdAt: this.iso(),
      label: req.label ?? `备份 ${id}`,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      entryCount: files.length,
      reason,
    };
    this.backupRecords.set(id, backup);
    this.backupContents.set(id, files.map((file) => ({ ...file })));

    const done: LauncherTask = {
      ...task,
      state: 'succeeded',
      progress: { done: files.length, total: Math.max(files.length, 1), unit: 'files', message: '备份完成' },
      endedAt: this.iso(),
      result: { backupId: id },
    };
    this.emitTask({ task: done, seq: ++this.eventSeq });
    return done;
  }

  /* ------------------------------ launcher_save_restore ------------------------------ */

  async saveRestore(
    instanceId: string,
    backupId: string,
    _opts?: RestoreOptions,
  ): Promise<LauncherTask> {
    this.calls.push(`saveRestore:${backupId}`);
    const contents = this.backupContents.get(backupId);
    if (!contents) {
      throw { code: 'LAUNCHER_SAVE_RESTORE_FAILED', message: '备份不存在或已损坏', retryable: false };
    }
    const failure = this.restoreFailure?.backupId === backupId ? this.restoreFailure : null;
    contents.forEach((file, index) => {
      if (failure && index >= failure.afterFiles) {
        // 写一半然后失败：由 core 用恢复前备份回滚
        throw { code: 'LAUNCHER_SAVE_RESTORE_FAILED', message: '写入存档时失败', retryable: false };
      }
      this.saveFiles.set(`${file.rootId}|${file.path}`, { ...file });
    });
    return this.hostTask('save-restore', instanceId, {
      state: 'succeeded',
      endedAt: this.iso(),
      progress: { done: contents.length, total: Math.max(contents.length, 1), unit: 'files', message: '恢复完成' },
      result: { backupId },
    });
  }

  /* ------------------------------ launcher_save_delete_backup ------------------------------ */

  async saveDeleteBackup(instanceId: string, backupId: string): Promise<void> {
    this.calls.push(`saveDeleteBackup:${backupId}`);
    if (!this.backupRecords.has(backupId)) {
      throw { code: 'LAUNCHER_INTERNAL', message: '备份不存在', retryable: false };
    }
    this.deletedBackups.push(backupId);
    this.backupRecords.delete(backupId);
    this.backupContents.delete(backupId);
  }

  /* ------------------------------ launcher_save_import ------------------------------ */

  async saveImport(instanceId: string, archivePath: string): Promise<HostSaveImportPlan> {
    this.calls.push(`saveImport:${archivePath}`);
    const spec = this.nextImport;
    const planId = spec?.planId ?? `plan-${++this.planSeq}`;
    const backupId = `import-bak-${++this.backupSeq}`;

    // 预检期快照当前存档（回滚用）；不占用户配额口径由 reason='auto' 承担
    const current = [...this.saveFiles.values()];
    this.backupRecords.set(backupId, {
      id: backupId,
      instanceId,
      createdAt: this.iso(),
      label: '导入前快照',
      bytes: current.reduce((sum, file) => sum + file.bytes, 0),
      entryCount: current.length,
      reason: 'auto',
    });
    this.backupContents.set(backupId, current.map((file) => ({ ...file })));

    const overwrites = spec?.overwrites ?? ['saves/slot1.sav'];
    this.pendingImports.set(planId, { instanceId, targetPaths: overwrites });

    return {
      planId,
      backupId,
      overwrites: [...overwrites],
      warnings: [...(spec?.warnings ?? [])],
      ...(spec?.entryCount === undefined ? {} : { entryCount: spec.entryCount }),
      ...(spec?.totalBytes === undefined ? {} : { totalBytes: spec.totalBytes }),
      ...(spec?.expiresAt === undefined ? {} : { expiresAt: spec.expiresAt }),
    };
  }

  /* ------------------------------ launcher_save_apply_import ------------------------------ */

  async saveApplyImport(
    planId: string,
    resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask> {
    this.calls.push(`saveApplyImport:${planId}`);
    if (this.holdApplyImport) {
      if (!this.applyPromise) {
        this.applyPromise = new Promise<void>((resolve) => {
          this.applyWaiter = resolve;
        });
      }
      await this.applyPromise;
    }
    const plan = this.pendingImports.get(planId);
    if (!plan) {
      throw { code: 'LAUNCHER_INTERNAL', message: '导入计划不存在或已过期', retryable: false };
    }
    this.pendingImports.delete(planId);

    if (this.applyImportMode === 'cancelled') {
      throw { code: 'LAUNCHER_TASK_CANCELLED', message: '任务已取消', retryable: false };
    }
    if (this.applyImportMode === 'partial') {
      const first = plan.targetPaths[0];
      if (first !== undefined) this.writeIncoming(plan.instanceId, first);
      throw { code: 'LAUNCHER_SAVE_RESTORE_FAILED', message: '写入导入存档时失败', retryable: false };
    }
    for (const path of plan.targetPaths) this.writeIncoming(plan.instanceId, path);
    return this.hostTask('save-import', plan.instanceId, {
      state: 'succeeded',
      endedAt: this.iso(),
      result: { planId, applied: plan.targetPaths.length, resolutions: resolutions?.length ?? 0 },
    });
  }

  /* ------------------------------ launcher_save_export ------------------------------ */

  async saveExport(instanceId: string, req: SaveExportRequest): Promise<string | null> {
    this.calls.push(`saveExport:${instanceId}:${req.entries?.length ?? 'all'}`);
    this.lastExportRequest = req;
    return this.exportTarget;
  }

  /* ------------------------------ launcher_task_cancel ------------------------------ */

  override async taskCancel(taskId: string): Promise<void> {
    this.calls.push('taskCancel');
    this.cancelRequests.push(taskId);
    const gate = this.gates.get(taskId);
    if (!gate) return;
    this.gates.delete(taskId);
    gate.reject({ code: 'LAUNCHER_TASK_CANCELLED', message: '任务已取消', retryable: false });
  }

  /* ------------------------------ 内部 ------------------------------ */

  private isApproved(instanceId: string, rootId: string): boolean {
    const instance = this.instances.find((item) => item.id === instanceId);
    if (instance?.isolation === 'copy') return true;
    return this.approvals.has(rootId);
  }

  private writeIncoming(instanceId: string, path: string): void {
    const instance = this.instances.find((item) => item.id === instanceId);
    const root = instance?.saveRoots[0];
    if (!root) return;
    this.saveFiles.set(`${root.id}|${path}`, {
      rootId: root.id,
      path,
      bytes: 7,
      mtimeMs: 1_800_000_000_000,
      content: `imported:${path}`,
    });
  }

  private hostTask(kind: TaskKind, instanceId: string, patch: Partial<LauncherTask> = {}): LauncherTask {
    return makeTask(`host-save-${++this.taskSeq}`, {
      kind,
      instanceId,
      state: 'running',
      cancellable: true,
      createdAt: this.iso(),
      startedAt: this.iso(),
      progress: { done: 0, total: 1, unit: 'steps', message: '准备中' },
      ...patch,
    });
  }

  private waitGate(taskId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.gates.set(taskId, { resolve, reject });
    });
  }

  private iso(): string {
    this.clock += 1_000;
    return new Date(Date.UTC(2026, 9, 26, 0, 0, 0) + this.clock).toISOString();
  }
}
