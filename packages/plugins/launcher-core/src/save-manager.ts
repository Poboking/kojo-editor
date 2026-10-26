/**
 * 存档编排（契约 §6.9 + 规格 §11）。
 *
 * ## 职责边界（评审重点）
 *
 * **本层不碰盘**：读目录、解 ZIP、算哈希、写临时 + rename、路径规范化与前缀校验
 * 全部在宿主（`launcher_save_*` 八条命令）。本层只做五件事：
 *
 * 1. **adapter 布局消费**：`saveLayout.listRule` 决定列哪些文件、显示什么名字；
 *    归类靠 `SaveEntry.rootId`（槽位 / 自动存档 / 手动 由 adapter 的根声明表达，
 *    本层不猜目录语义）；
 * 2. **写授权门禁**：shared / overlay 实例写回游戏目录前，逐根复验 approvals
 *    （§9.1：授权粒度 = 实例 × 根 id，只由原生目录对话框写入）；
 * 3. **顺序编排**：恢复 = 校验 → 自动备份当前 → 停游戏 → 写回；任一步失败按**逆序**
 *    用恢复前备份回滚（§11.3）。顺序写在这里，因为它跨两个服务（存档 + 进程）；
 * 4. **任务登记**：宿主命令返回的任务统一进 `TaskCenter`（进度随 `kojo:launcher-task`
 *    到；取消转 `launcher_task_cancel`）。本层**不自己造**第二份任务——一条操作一个任务；
 * 5. **保留策略**：`manual` / `auto` 备份超配额时只删最旧；`pre-restore` / `pre-plugin`
 *    是安全回退，不占用户配额（§11.2）。
 *
 * ## 三条不变量
 *
 * - 路径参数只认 `rootId` + **相对名**、`backupId`、`planId`：任何带分隔符 / 盘符 / `..`
 *   的 id 一律 `LAUNCHER_PATH_ESCAPE`（本层不拼绝对路径，也不给宿主递绝对写落点）；
 * - 单飞：同一实例的备份 / 恢复 / 导入应用互斥（同一类操作并发 = `LAUNCHER_TASK_BUSY`），
 *   恢复内部自己发起的备份走独立锁键，不会自锁；
 * - **先备份、后写回**：`restore` 在 `opts.backupCurrent !== false` 时**必然**先成功完成
 *   一次 `reason='pre-restore'` 的备份；自动备份失败即中止恢复（没有回退点的写回不做）。
 *
 * ## 已知契约缺口（已上报，未擅自扩 `plugin-api`）
 *
 * - `list()` 只能返回 `SaveEntry[]`，**装不下警告**（§11.1 要求「空表 + 明确 warning」）。
 *   本层把最近一次 `list` 的警告留在 `warnings(instanceId)`，并在文件头注明；
 * - `RestoreOptions` 只有 `backupCurrent`（任务书里的 `skipAutoBackup` 是它的否定形态）；
 * - 契约方法名是 `removeBackup` / `planImport`（任务书里的 `deleteBackup` / `import`）；
 * - `SaveImportPlan.overwrites` 是 `string[]`，丢了 `rootId`，因此 shared 未授权时只能
 *   按「全部 saveRoot 都得已授权」保守判定；
 * - 导入失败没有专属错误码，落 `LAUNCHER_SAVE_RESTORE_FAILED`（同为存档写回失败）。
 */

import type {
  ConflictResolution,
  LauncherError,
  LauncherInstance,
  LauncherTask,
  ProcessStatus,
  RestoreOptions,
  SaveBackup,
  SaveBackupRequest,
  SaveEntry,
  SaveExportRequest,
  SaveImportPlan,
  SaveLayoutSpec,
  SaveManager,
  SaveRootSpec,
  TaskKind,
  ZipContractLimits,
} from '@kojo/plugin-api';
import { ZIP_EXTRACT_LIMITS } from '@kojo/plugin-api';
import type { HostSaveImportPlan, SaveHostBridge } from './save-host';
import { isTerminalTaskState } from './task-center';
import { launcherError, normalizeLauncherError } from './errors';

/* ══════════════════════════════════════════════════════════════════════════════
 * 档位（契约层不留常量；这里是实现侧的唯一一份）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 用户配额：`manual` / `auto` 备份最多保留多少份（§11.2 的 20 份） */
export const DEFAULT_SAVE_BACKUP_KEEP = 20;

/** 导入计划的默认有效期（过期即作废，避免陈旧 apply） */
export const DEFAULT_IMPORT_PLAN_TTL_MS = 10 * 60_000;

/** 备份 id 这类「单个路径分量」的长度上限（够长，且不让宿主被超长名拖住） */
const COMPONENT_MAX_LENGTH = 256;

/* ══════════════════════════════════════════════════════════════════════════════
 * 依赖面（结构最小化，便于直接单测）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 任务中心的写入面（`TaskCenterImpl` 结构上满足；不 import 具体类） */
export interface SaveTaskSink {
  adopt(
    task: LauncherTask,
    channel?: { readonly onCancel?: () => void | Promise<void> },
  ): LauncherTask;
  fail(id: string, err: unknown): LauncherTask | null;
  list(): readonly LauncherTask[];
}

/** 进程面（`ProcessSupervisorImpl` 结构上满足）：恢复前停游戏只用到这两条 */
export interface SaveProcessControl {
  status(instanceId: string): ProcessStatus;
  stop(instanceId: string, opts?: { readonly force?: boolean }): Promise<ProcessStatus>;
}

export interface SaveManagerOptions {
  readonly host: SaveHostBridge;
  /** 实例查询（装配处接 `InstanceStoreImpl.get`；缺席即 `LAUNCHER_INSTANCE_NOT_FOUND`） */
  readonly getInstance: (instanceId: string) => Promise<LauncherInstance | null>;
  /** adapter 的存档布局（`GameLaunchAdapter.saveLayout`）；缺席 = 不过滤、按文件名 */
  readonly saveLayoutOf?: (adapterId: string) => SaveLayoutSpec | undefined;
  readonly tasks: SaveTaskSink;
  readonly processes?: SaveProcessControl;
  readonly now?: () => number;
  /** 用户配额（缺省 20；`0` = 不做保留清理） */
  readonly keep?: number;
  /** 导入计划有效期（缺省 10 分钟） */
  readonly planTtlMs?: number;
  /** 导入包限额（缺省 `ZIP_EXTRACT_LIMITS`；只在本层判宿主报上来的读数） */
  readonly importLimits?: ZipContractLimits;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 实现
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 已预检、等待确认的导入计划（`backupId` = 宿主在暂存期做的可回滚快照） */
interface StoredImportPlan {
  readonly instanceId: string;
  readonly backupId: string;
  readonly overwrites: readonly string[];
  readonly expiresAtMs: number;
}

export class SaveManagerImpl implements SaveManager {
  private readonly host: SaveHostBridge;
  private readonly getInstance: (instanceId: string) => Promise<LauncherInstance | null>;
  private readonly saveLayoutOf: (adapterId: string) => SaveLayoutSpec | undefined;
  private readonly tasks: SaveTaskSink;
  private readonly processes: SaveProcessControl | undefined;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly planTtlMs: number;
  private readonly limits: ZipContractLimits;

  /** planId → 预检结果；`applyImport` 用掉即删（不重放陈旧计划） */
  private readonly plans = new Map<string, StoredImportPlan>();
  /** 单飞锁键：`<instanceId>:<op>` */
  private readonly busy = new Set<string>();
  /** 最近一次 `list` 的警告（契约的 `SaveEntry[]` 装不下，见文件头缺口） */
  private readonly lastWarnings = new Map<string, readonly string[]>();

  constructor(options: SaveManagerOptions) {
    this.host = options.host;
    this.getInstance = options.getInstance;
    this.saveLayoutOf = options.saveLayoutOf ?? (() => undefined);
    this.tasks = options.tasks;
    this.processes = options.processes;
    this.now = options.now ?? Date.now;
    this.keep = Math.max(0, options.keep ?? DEFAULT_SAVE_BACKUP_KEEP);
    this.planTtlMs = Math.max(0, options.planTtlMs ?? DEFAULT_IMPORT_PLAN_TTL_MS);
    this.limits = options.importLimits ?? ZIP_EXTRACT_LIMITS;
  }

  /* ══════════════════════════════════ 列表 ══════════════════════════════════ */

  /**
   * 只读列出存档。
   *
   * 过滤三层：宿主报的路径闸（越界条目丢弃，但**不把绝对路径回显**）、
   * adapter 的扩展名白名单、shared 实例的逐根写授权。
   * 未授权根在 shared 下连「列出」也跳过：§9.1 的授权是根级开关，列出来却点不动
   * 只会让用户以为坏了；警告由 `warnings(instanceId)` 给出。
   */
  async list(instanceId: string): Promise<readonly SaveEntry[]> {
    try {
      const instance = await this.requireInstance(instanceId);
      const roots = instance.saveRoots;
      if (roots.length === 0) {
        this.recordWarnings(instanceId, [
          '该游戏尚未声明存档目录（adapter 未提供 saveLayout），没有可列出的存档',
        ]);
        return [];
      }

      const listing = await this.host.saveList(instanceId);
      const rule = this.saveLayoutOf(instance.adapterId)?.listRule;
      const labelOf = new Map(roots.map((root) => [root.id, root.label] as const));
      const rankOf = new Map(roots.map((root, index) => [root.id, index] as const));
      const approved = new Set(listing.roots.filter((root) => root.approved).map((root) => root.rootId));
      // copy 实例写的是实例内副本，不需要逐根授权；shared / overlay 才要看 approvals
      const needsApproval = instance.isolation !== 'copy';

      const warnings: string[] = [...(listing.warnings ?? [])];
      const unapproved = new Set<string>();
      const unknown = new Set<string>();
      let escaped = 0;
      const entries: SaveEntry[] = [];

      for (const raw of listing.entries) {
        if (relativePathProblem(raw.path) !== null) {
          escaped += 1;
          continue;
        }
        if (!labelOf.has(raw.rootId)) {
          unknown.add(raw.rootId);
          continue;
        }
        if (needsApproval && !approved.has(raw.rootId)) {
          unapproved.add(raw.rootId);
          continue;
        }
        if (!matchesExtensions(raw.path, rule)) continue;
        entries.push({
          path: normalizeRelative(raw.path),
          rootId: raw.rootId,
          name: displayName(raw.path, rule),
          bytes: nonNegative(raw.bytes),
          mtimeMs: nonNegative(raw.mtimeMs),
        });
      }

      for (const rootId of [...unapproved].sort()) {
        const label = labelOf.get(rootId) ?? rootId;
        warnings.push(
          `存档目录「${label}」尚未获得写入授权，已跳过（shared 实例需在实例设置里逐根授权）`,
        );
      }
      if (unknown.size > 0) {
        warnings.push(`宿主返回了未知存档根的条目（${[...unknown].sort().join('、')}），已忽略`);
      }
      if (escaped > 0) {
        warnings.push(`宿主返回了 ${escaped} 条越界存档路径，已忽略`);
      }

      entries.sort((a, b) => {
        const rankDiff = (rankOf.get(a.rootId) ?? Number.MAX_SAFE_INTEGER) - (rankOf.get(b.rootId) ?? Number.MAX_SAFE_INTEGER);
        return rankDiff !== 0 ? rankDiff : a.path.localeCompare(b.path);
      });

      this.recordWarnings(instanceId, warnings);
      return entries;
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '读取存档列表失败' });
    }
  }

  /**
   * 最近一次 `list` 的警告（本层扩展：契约的 `list` 只回 `SaveEntry[]`）。
   * 口径：空数组 = 没警告；未列入过 = 也没警告。
   */
  warnings(instanceId: string): readonly string[] {
    return this.lastWarnings.get(instanceId) ?? [];
  }

  /* ══════════════════════════════════ 备份 ══════════════════════════════════ */

  /** 备份清单（新→旧；UI 分组靠 `reason`，本层不重排语义） */
  async backups(instanceId: string): Promise<readonly SaveBackup[]> {
    try {
      await this.requireInstance(instanceId);
      const backups = await this.host.saveBackups(instanceId);
      return [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '读取备份列表失败' });
    }
  }

  /**
   * 备份（只写实例备份目录，不碰游戏目录 ⇒ 不需要写授权）。
   *
   * 返回宿主任务（已登记进 `TaskCenter`）：进度随事件到、取消转 `launcher_task_cancel`。
   * 备份成功后顺手做配额清理；清理失败不影响这次备份的结果（错误记进 `warnings()`）。
   */
  async backup(instanceId: string, req: SaveBackupRequest): Promise<LauncherTask> {
    const lock = lockKey(instanceId, 'backup');
    this.assertIdle(lock);
    this.busy.add(lock);
    try {
      const instance = await this.requireInstance(instanceId);
      const roots = this.requireSaveRoots(instance);
      const entries = normalizeEntrySelection(req?.entries, roots);
      const hostReq: SaveBackupRequest = {
        ...(req?.label === undefined ? {} : { label: req.label }),
        reason: req?.reason ?? 'manual',
        ...(entries === undefined ? {} : { entries }),
      };

      let task: LauncherTask;
      try {
        task = await this.host.saveBackup(instanceId, hostReq);
      } catch (err) {
        const failure = normalizeLauncherError(err, {
          fallbackCode: 'LAUNCHER_INTERNAL',
          detail: '存档备份失败',
        });
        this.failPending(instanceId, 'save-backup', failure);
        throw failure;
      }
      const adopted = this.adopt(task);

      try {
        await this.pruneQuota(instanceId);
      } catch (err) {
        const cause = normalizeLauncherError(err);
        this.recordWarnings(instanceId, [
          ...this.warnings(instanceId),
          `备份清理失败（${cause.code}）：超出配额的旧备份未删除，下次备份会再试`,
        ]);
      }
      return adopted;
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '存档备份失败' });
    } finally {
      this.busy.delete(lock);
    }
  }

  /* ══════════════════════════════════ 恢复 ══════════════════════════════════ */

  /**
   * 恢复（§11.3 的顺序：校验 → 自动备份当前 → 停游戏 → 写回）。
   *
   * `opts.backupCurrent === false` 时跳过自动备份——只由 UI 在二次确认后传；本层只认字段。
   * 写回失败时**逆序回滚**（用刚刚那份 pre-restore 备份原样写回），失败原因里注明回滚结果。
   */
  async restore(instanceId: string, backupId: string, opts?: RestoreOptions): Promise<LauncherTask> {
    const lock = lockKey(instanceId, 'restore');
    this.assertIdle(lock);
    this.busy.add(lock);
    try {
      const instance = await this.requireInstance(instanceId);
      assertComponent(backupId, '备份 id');
      const backups = await this.host.saveBackups(instanceId);
      const target = backups.find((backup) => backup.id === backupId);
      if (!target) {
        throw launcherError('LAUNCHER_INTERNAL', {
          detail: `备份 ${preview(backupId)} 不属于实例 ${instanceId}，恢复已拒绝`,
        });
      }
      await this.assertWritable(instance);

      const autoBackup =
        opts?.backupCurrent === false ? null : await this.createPreRestoreBackup(instance, target);

      await this.stopGameIfRunning(instanceId);

      let task: LauncherTask;
      try {
        task = await this.host.saveRestore(instanceId, backupId);
      } catch (err) {
        let failure = normalizeLauncherError(err, {
          fallbackCode: 'LAUNCHER_SAVE_RESTORE_FAILED',
          detail: `恢复备份 ${preview(backupId)} 失败`,
        });
        if (autoBackup !== null) {
          try {
            await this.host.saveRestore(instanceId, autoBackup.id);
          } catch (rollbackErr) {
            const cause = normalizeLauncherError(rollbackErr);
            failure = {
              ...failure,
              detail: joinDetail(
                failure.detail,
                `用恢复前备份 ${preview(autoBackup.id)} 回滚也失败（${cause.code}）：存档可能处于中间状态`,
              ),
            };
          }
        }
        this.failPending(instanceId, 'save-restore', failure);
        throw failure;
      }
      return this.adopt(task);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_SAVE_RESTORE_FAILED' });
    } finally {
      this.busy.delete(lock);
    }
  }

  /** 恢复前的自动备份：失败即中止恢复（没有回退点的写回不做） */
  private async createPreRestoreBackup(
    instance: LauncherInstance,
    target: SaveBackup,
  ): Promise<{ readonly id: string }> {
    const task = await this.host.saveBackup(instance.id, {
      reason: 'pre-restore',
      label: `恢复前自动备份（${target.label}）`,
    });
    const adopted = this.adopt(task);
    const id = adopted.result?.['backupId'];
    if (typeof id !== 'string' || id === '') {
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: '自动备份未返回备份 id，恢复已中止（缺少回退点）',
      });
    }
    assertComponent(id, '备份 id');
    return { id };
  }

  /* ══════════════════════════════════ 删除备份 ══════════════════════════════ */

  /**
   * 删除备份：只删**该实例备份目录内、清单里确实存在**的那一份。
   * 两道闸：id 必须是单个路径分量（否则 `LAUNCHER_PATH_ESCAPE`），且在 `backups()` 里命中
   * （否则同样按越界拒——不存在的 id 只可能来自越界或陈旧 UI）。
   */
  async removeBackup(instanceId: string, backupId: string): Promise<void> {
    try {
      await this.requireInstance(instanceId);
      assertComponent(backupId, '备份 id');
      const backups = await this.host.saveBackups(instanceId);
      if (!backups.some((backup) => backup.id === backupId)) {
        throw launcherError('LAUNCHER_PATH_ESCAPE', {
          detail: `备份 ${preview(backupId)} 不属于实例 ${instanceId}，删除已拒绝`,
        });
      }
      await this.host.saveDeleteBackup(instanceId, backupId);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '删除备份失败' });
    }
  }

  /* ══════════════════════════════════ 导入 ══════════════════════════════════ */

  /**
   * 导入预检：**只读**，不写实例（§11.4）。
   *
   * 宿主负责 ZIP 四重守卫与解到暂存；本层在此之上复核：授权（shared 逐根）、
   * 覆盖路径的相对性 / 层级、宿主报上来的条目数与字节数。计划带有效期，用掉即弃。
   */
  async planImport(instanceId: string, archivePath: string): Promise<SaveImportPlan> {
    try {
      const instance = await this.requireInstance(instanceId);
      this.requireSaveRoots(instance);
      if (typeof archivePath !== 'string' || archivePath.trim() === '' || hasControlChars(archivePath)) {
        throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
          detail: '导入包路径为空或含控制字符（应由原生文件对话框给出）',
        });
      }
      await this.assertWritable(instance);

      const hostPlan = await this.host.saveImport(instanceId, archivePath);
      assertComponent(hostPlan.planId, '导入计划 id');
      assertComponent(hostPlan.backupId, '导入回滚备份 id');
      for (const overwrite of hostPlan.overwrites) {
        const problem = relativePathProblem(overwrite);
        if (problem !== null) {
          throw launcherError('LAUNCHER_PATH_ESCAPE', {
            detail: `导入包内的存档路径不合法（${problem}）：${preview(overwrite)}`,
          });
        }
        if (depthOf(overwrite) > this.limits.maxDepth) {
          throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
            detail: `导入包内路径层级超过限额（${preview(overwrite)}）`,
          });
        }
      }
      if (hostPlan.entryCount !== undefined && hostPlan.entryCount > this.limits.maxEntries) {
        throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
          detail: `导入包条目数 ${hostPlan.entryCount} 超过限额 ${this.limits.maxEntries}`,
        });
      }
      if (hostPlan.totalBytes !== undefined && hostPlan.totalBytes > this.limits.maxUnpackedBytes) {
        throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
          detail: `导入包解包后 ${hostPlan.totalBytes} 字节，超过限额 ${this.limits.maxUnpackedBytes}`,
        });
      }

      const warnings: string[] = [...(hostPlan.warnings ?? [])];
      if (hostPlan.overwrites.length > 0) {
        warnings.push(`将覆盖 ${hostPlan.overwrites.length} 个同名存档`);
      }
      if (hostPlan.entryCount !== undefined) {
        const bytes =
          hostPlan.totalBytes === undefined ? '' : `、合计 ${hostPlan.totalBytes} 字节`;
        warnings.push(`导入包包含 ${hostPlan.entryCount} 个条目${bytes}`);
      }

      const expiresAtMs = this.expiryOf(hostPlan);
      this.plans.set(hostPlan.planId, {
        instanceId,
        backupId: hostPlan.backupId,
        overwrites: hostPlan.overwrites,
        expiresAtMs,
      });
      return {
        planId: hostPlan.planId,
        backupId: hostPlan.backupId,
        overwrites: [...hostPlan.overwrites],
        warnings,
      };
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '存档导入预检失败' });
    }
  }

  /**
   * 应用导入：单飞 + 计划一次性 + 失败回滚（用预检期那份 `backupId` 写回）。
   * 计划过期 / 不存在 / 已用过都直接拒绝（不重放陈旧计划）。
   */
  async applyImport(planId: string, resolutions?: readonly ConflictResolution[]): Promise<LauncherTask> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: `导入计划不存在或已使用：${preview(planId)}（请重新预检）`,
      });
    }
    if (this.now() > plan.expiresAtMs) {
      this.plans.delete(planId);
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: `导入计划 ${preview(planId)} 已过期（暂存计划作废），请重新预检`,
      });
    }

    const lock = lockKey(plan.instanceId, 'import');
    this.assertIdle(lock);
    this.busy.add(lock);
    try {
      const instance = await this.requireInstance(plan.instanceId);
      await this.assertWritable(instance);
      const checked = normalizeResolutions(resolutions, plan.overwrites);

      let task: LauncherTask;
      try {
        task = await this.host.saveApplyImport(planId, checked);
      } catch (err) {
        let failure = normalizeLauncherError(err, {
          fallbackCode: 'LAUNCHER_SAVE_RESTORE_FAILED',
          detail: '应用导入失败',
        });
        try {
          await this.host.saveRestore(plan.instanceId, plan.backupId);
        } catch (rollbackErr) {
          const cause = normalizeLauncherError(rollbackErr);
          failure = {
            ...failure,
            detail: joinDetail(
              failure.detail,
              `用导入前备份 ${preview(plan.backupId)} 回滚也失败（${cause.code}）：存档可能处于中间状态`,
            ),
          };
        }
        this.plans.delete(planId);
        this.failPending(plan.instanceId, 'save-import', failure);
        throw failure;
      }
      this.plans.delete(planId);
      return this.adopt(task);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_SAVE_RESTORE_FAILED' });
    } finally {
      this.busy.delete(lock);
    }
  }

  /* ══════════════════════════════════ 导出 ══════════════════════════════════ */

  /**
   * 导出：落点**只由宿主原生保存对话框**给定（对话框即授权，§13.1）。
   * 本层只做参数校验：条目必须是本实例已声明的根 + 相对名；返回的落点仅回给 UI 展示，
   * 不再作为任何写参数传回（这条是路径脱敏的实质）。
   */
  async exportArchive(instanceId: string, req: SaveExportRequest): Promise<string | null> {
    try {
      const instance = await this.requireInstance(instanceId);
      const roots = this.requireSaveRoots(instance);
      const entries = normalizeEntrySelection(req?.entries, roots);
      const hostReq: SaveExportRequest = {
        ...(req?.label === undefined ? {} : { label: req.label }),
        ...(entries === undefined ? {} : { entries }),
      };
      const target = await this.host.saveExport(instanceId, hostReq);
      if (target === null) return null;
      if (typeof target !== 'string' || target.trim() === '' || hasControlChars(target)) {
        throw launcherError('LAUNCHER_INTERNAL', {
          detail: '保存对话框返回了不合法的落点',
        });
      }
      return target;
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '导出存档失败' });
    }
  }

  /* ══════════════════════════════════ 内部 ══════════════════════════════════ */

  private async requireInstance(instanceId: string): Promise<LauncherInstance> {
    if (typeof instanceId !== 'string' || instanceId.trim() === '') {
      throw launcherError('LAUNCHER_INSTANCE_NOT_FOUND', { detail: '实例 id 为空' });
    }
    const instance = await this.getInstance(instanceId);
    if (!instance) {
      throw launcherError('LAUNCHER_INSTANCE_NOT_FOUND', { detail: `实例不存在：${instanceId}` });
    }
    return instance;
  }

  private requireSaveRoots(instance: LauncherInstance): readonly SaveRootSpec[] {
    if (instance.saveRoots.length === 0) {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        detail: '该游戏未声明存档目录（adapter 未提供 saveLayout），存档操作不可用',
      });
    }
    return instance.saveRoots;
  }

  /**
   * 写回门禁（§9.1）：`copy` 实例写实例内副本，不需要授权；
   * `shared` / `overlay` 必须**每个** saveRoot 都在 approvals 里。
   */
  private async assertWritable(instance: LauncherInstance): Promise<void> {
    if (instance.isolation === 'copy') return;
    const roots = this.requireSaveRoots(instance);
    const listing = await this.host.saveList(instance.id);
    const approved = new Set(listing.roots.filter((root) => root.approved).map((root) => root.rootId));
    const blocked = roots.filter((root) => !approved.has(root.id));
    if (blocked.length > 0) {
      throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
        detail: `以下存档目录尚未授权写入：${blocked.map((root) => root.label).join('、')}（需在实例设置里用目录对话框逐根批准）`,
      });
    }
  }

  /** 恢复前停游戏：未运行直接继续（`idle` / `exited` / `crashed`） */
  private async stopGameIfRunning(instanceId: string): Promise<void> {
    if (!this.processes) return;
    const state = this.processes.status(instanceId).state;
    if (state !== 'running' && state !== 'starting') return;
    await this.processes.stop(instanceId);
  }

  /** 配额清理：`manual` / `auto` 按创建时间升序，超出 `keep` 的从最旧删起 */
  private async pruneQuota(instanceId: string): Promise<void> {
    if (this.keep <= 0) return;
    const backups = await this.host.saveBackups(instanceId);
    const quota = backups
      .filter((backup) => backup.reason === 'manual' || backup.reason === 'auto')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const excess = quota.length - this.keep;
    if (excess <= 0) return;
    for (const victim of quota.slice(0, excess)) {
      assertComponent(victim.id, '备份 id');
      await this.host.saveDeleteBackup(instanceId, victim.id);
    }
  }

  /** 宿主任务入 `TaskCenter`；取消转 `launcher_task_cancel`（一条操作一个任务） */
  private adopt(task: LauncherTask): LauncherTask {
    return this.tasks.adopt(task, { onCancel: () => this.host.taskCancel(task.id) });
  }

  /**
   * 宿主拒绝后把**本次操作**的任务收成 failed。
   *
   * 宿主通常会先推一条终态事件（此时 `TaskCenter` 已冻结，这里是 no-op）；但若事件比
   * 命令返回值晚到，任务会一直挂在 `running`——UI 永远转圈。单飞锁保证同实例同类任务
   * 至多一条未终态，所以这里按 (实例 + kind) 找待收尾的那一条是确定的。
   */
  private failPending(instanceId: string, kind: TaskKind, error: LauncherError): void {
    const pending = this.tasks
      .list()
      .filter(
        (task) =>
          task.instanceId === instanceId && task.kind === kind && !isTerminalTaskState(task.state),
      );
    for (const task of pending) this.tasks.fail(task.id, error);
  }

  private expiryOf(plan: HostSaveImportPlan): number {
    if (typeof plan.expiresAt === 'string' && plan.expiresAt.trim() !== '') {
      const parsed = Date.parse(plan.expiresAt);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return this.now() + this.planTtlMs;
  }

  private assertIdle(lock: string): void {
    if (this.busy.has(lock)) {
      throw launcherError('LAUNCHER_TASK_BUSY', {
        detail: `同一实例的同类存档操作正在进行：${lock}`,
      });
    }
  }

  private recordWarnings(instanceId: string, warnings: readonly string[]): void {
    this.lastWarnings.set(instanceId, dedupe(warnings));
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数（路径闸 / 命名 / 选择集）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 单飞锁键 */
function lockKey(instanceId: string, op: 'backup' | 'restore' | 'import'): string {
  return `${instanceId}:${op}`;
}

/**
 * 相对名的合法性判据。**只判形态，不拼绝对路径**：绝对 / 盘符 / UNC / `..` 一律拒。
 * 反斜杠按分隔符处理（Windows 宿主；posix 名里出现反斜杠本身就是可疑输入）。
 */
function relativePathProblem(path: string): string | null {
  if (typeof path !== 'string' || path.trim() === '') return '空路径';
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/')) return '绝对路径';
  if (/^[a-zA-Z]:/.test(normalized)) return '带盘符的路径';
  for (const segment of normalized.split('/')) {
    if (segment === '..') return '含上级目录（..）';
  }
  return null;
}

/** 单个路径分量（备份 id / 计划 id）的判据：不许分隔符、盘符、`..`、控制字符 */
function componentProblem(value: string): string | null {
  if (typeof value !== 'string' || value.trim() === '') return '空';
  if (value.length > COMPONENT_MAX_LENGTH) return '过长';
  if (value === '.' || value === '..') return '指向上级目录';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) return '含路径分隔符或控制字符';
  return null;
}

function assertComponent(value: string, label: string): void {
  const problem = componentProblem(value);
  if (problem !== null) {
    throw launcherError('LAUNCHER_PATH_ESCAPE', {
      detail: `${label} 不合法（${problem}）：${preview(value)}`,
    });
  }
}

/** 统一成 posix 分隔（宿主契约一律 posix；这里只做字符串归一，不拼路径） */
function normalizeRelative(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function depthOf(path: string): number {
  return normalizeRelative(path).split('/').length;
}

/** 文件名（posix / 反斜杠都认） */
function baseName(path: string): string {
  const normalized = normalizeRelative(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** 扩展名（含点、小写）；没有则为空串 */
function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** adapter 的扩展名白名单（空清单 = 不过滤；缺省去点、大小写无关） */
function matchesExtensions(path: string, rule: SaveLayoutSpec['listRule']): boolean {
  if (!rule) return true;
  const extensions = rule.extensions ?? [];
  if (extensions.length === 0) return true;
  const ext = extensionOf(path);
  return extensions.some((candidate) => {
    const text = candidate.trim().toLowerCase();
    return (text.startsWith('.') ? text : `.${text}`) === ext;
  });
}

/** 显示名：缺省 = 文件名；`labelFromFileName` = 去掉扩展名 */
function displayName(path: string, rule: SaveLayoutSpec['listRule']): string {
  const name = baseName(path);
  if (!rule?.labelFromFileName) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 备份/导出条目选择集：空 = 全部；根必须已声明、路径必须是相对名 */
function normalizeEntrySelection(
  entries: readonly { readonly rootId: string; readonly path: string }[] | undefined,
  roots: readonly SaveRootSpec[],
): { readonly rootId: string; readonly path: string }[] | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const known = new Set(roots.map((root) => root.id));
  return entries.map((entry) => {
    if (!known.has(entry.rootId)) {
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: `未知存档根：${preview(entry.rootId)}（不在实例声明的 saveRoots 里）`,
      });
    }
    const problem = relativePathProblem(entry.path);
    if (problem !== null) {
      throw launcherError('LAUNCHER_PATH_ESCAPE', {
        detail: `存档路径不合法（${problem}）：${preview(entry.path)}`,
      });
    }
    return { rootId: entry.rootId, path: normalizeRelative(entry.path) };
  });
}

/**
 * 冲突决议的轻校验：只放行动作白名单与已预检过的相对路径。
 * 决议来自 UI，同一条路径可能被重复提交——按 `rootId + path` 去重，保持首次决议。
 */
function normalizeResolutions(
  resolutions: readonly ConflictResolution[] | undefined,
  overwrites: readonly string[],
): readonly ConflictResolution[] | undefined {
  if (resolutions === undefined || resolutions.length === 0) return undefined;
  const allowed = new Set<ConflictResolution['action']>(['skip', 'overwrite', 'replace']);
  const seen = new Set<string>();
  const out: ConflictResolution[] = [];
  for (const resolution of resolutions) {
    if (!allowed.has(resolution.action)) {
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: `未知冲突决议：${String(resolution.action)}`,
      });
    }
    const problem = relativePathProblem(resolution.path);
    if (problem !== null) {
      throw launcherError('LAUNCHER_PATH_ESCAPE', {
        detail: `冲突决议里的路径不合法（${problem}）：${preview(resolution.path)}`,
      });
    }
    const key = `${resolution.rootId}|${resolution.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolution);
    // overwrites 只用于校验对齐：决议必须命中预检里出现过的路径，否则就是不存在的目标
    if (!overwrites.includes(resolution.path)) {
      throw launcherError('LAUNCHER_INTERNAL', {
        detail: `冲突决议指向的计划外路径：${preview(resolution.path)}`,
      });
    }
  }
  return out;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasControlChars(text: string): boolean {
  return /[\u0000-\u001f]/.test(text);
}

/** 细节里回显输入时截断，避免把整条长路径写进 UI */
function preview(value: string): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > 64 ? `${text.slice(0, 61)}…` : text;
}

function joinDetail(base: string | undefined, extra: string): string {
  return base === undefined || base === '' ? extra : `${base} · ${extra}`;
}

function dedupe(items: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (text === '' || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}
