/**
 * 任务中心（契约 §6.11）。
 *
 * ## 职责边界
 *
 * 本层**不执行**任务：真正干活的是宿主（复制 / 解包 / 备份）或 adapter 侧编排。它只做四件事：
 * 1. **快照仓库**：把宿主命令返回值与 `kojo:launcher-task` 事件收敛成同一份 `LauncherTask`；
 * 2. **合并口径**：终态不可回退（迟到的事件不能把 `succeeded` 拉回 `running`）、
 *    进度不倒退（`done` 单调不降）；
 * 3. **进度节流**：同一任务的进度通知最多 ~100 ms 一次（§7.3），但**终态永不节流**——
 *    被节流吞掉终态 = UI 永远转圈，这是本节唯一不可让的底线；
 * 4. **取消语义**：`queued` 直接落 `cancelled`（还没开始做，本地即可定论）；
 *    `running` 只**发出取消请求**、状态不动——终态必须由真正执行方给出，否则会出现
 *    「UI 说已取消、宿主还在写盘」的假绿。
 */

import type {
  LauncherError,
  LauncherTask,
  TaskCenter,
  TaskKind,
  TaskState,
  Unsubscribe,
} from '@kojo/plugin-api';
import { launcherError, normalizeLauncherError } from './errors';

/** 任务进度（与 `LauncherTask.progress` 同形，导出便于调用方构造） */
export interface TaskProgress {
  readonly done: number;
  readonly total: number;
  readonly unit: 'bytes' | 'files' | 'steps';
  readonly message: string;
}

/** 进度节流窗口（§7.3：宿主侧 ≥100 ms；core 侧同档，避免 10k 行/秒打爆 React） */
export const DEFAULT_TASK_PROGRESS_THROTTLE_MS = 100;

/** 任务的取消通道（缺省 = 该任务没有取消通道，`cancel` 抛 `LAUNCHER_TASK_BUSY`） */
export interface TaskCancelChannel {
  /**
   * 发出取消请求。宿主任务 = 转 `launcher_task_cancel`；core 侧任务 = 交给编排方自行收尾。
   * **不得**在这里直接把任务状态改成 `cancelled`（终态只能由执行方给）。
   */
  readonly onCancel?: () => void | Promise<void>;
}

export interface TaskCreateInput extends TaskCancelChannel {
  readonly kind: TaskKind;
  readonly instanceId?: string | null;
  /** 缺省 true（绝大多数任务可撤；只读校验类显式传 false） */
  readonly cancellable?: boolean;
  readonly progress?: TaskProgress | null;
}

export interface TaskCenterOptions {
  readonly throttleMs?: number;
  readonly now?: () => number;
  /** 任务 id 生成（缺省自增；测试可注入稳定 id） */
  readonly newId?: () => string;
}

/** 终态判定（`queued` / `running` 之外的都算） */
export function isTerminalTaskState(state: TaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

export class TaskCenterImpl implements TaskCenter {
  private readonly tasks = new Map<string, LauncherTask>();
  private readonly channels = new Map<string, TaskCancelChannel>();
  private readonly listeners = new Set<(task: LauncherTask) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEmitAt = new Map<string, number>();
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private counter = 0;
  private disposed = false;

  constructor(options: TaskCenterOptions = {}) {
    this.throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_TASK_PROGRESS_THROTTLE_MS);
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `task-core-${++this.counter}`);
  }

  /* ------------------------------ 查询面 ------------------------------ */

  list(): readonly LauncherTask[] {
    return [...this.tasks.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  get(id: string): LauncherTask | null {
    return this.tasks.get(id) ?? null;
  }

  subscribe(listener: (task: LauncherTask) => void): Unsubscribe {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ------------------------------ 写入面 ------------------------------ */

  /** 登记一条 core 侧任务（状态 `queued`；调用方随后 `begin` / 直接 `fail`） */
  create(input: TaskCreateInput): LauncherTask {
    const id = this.newId();
    const task: LauncherTask = {
      id,
      kind: input.kind,
      instanceId: input.instanceId ?? null,
      state: 'queued',
      progress: input.progress ?? null,
      createdAt: this.isoNow(),
      startedAt: null,
      endedAt: null,
      error: null,
      result: null,
      cancellable: input.cancellable ?? true,
    };
    this.tasks.set(id, task);
    if (input.onCancel) this.channels.set(id, { onCancel: input.onCancel });
    this.emit(task, true);
    return task;
  }

  /**
   * 采纳外部快照（宿主命令返回值 / `kojo:launcher-task` 事件）。
   *
   * 同一 id 的重复快照按「合并口径」归一；**内容没变就不广播**（宿主命令返回值与随后
   * 那条事件往往一模一样，广播两次会让 UI 多刷一遍）。
   */
  adopt(task: LauncherTask, channel?: TaskCancelChannel): LauncherTask {
    if (channel?.onCancel) this.channels.set(task.id, channel);
    const prev = this.tasks.get(task.id);
    const next = prev ? mergeTask(prev, task) : task;
    this.tasks.set(task.id, next);
    if (!prev || signature(prev) !== signature(next)) this.emit(next, isTerminalTaskState(next.state));
    return next;
  }

  /** 批量采纳（`initialize()` 从宿主任务表恢复用） */
  adoptMany(tasks: readonly LauncherTask[]): void {
    for (const task of tasks) this.adopt(task);
  }

  /** `queued` → `running` */
  begin(id: string): LauncherTask | null {
    return this.patch(id, { state: 'running', startedAt: this.isoNow() }, true);
  }

  /** 进度推进（节流广播；终态由 `succeed` / `fail` / 事件给出） */
  setProgress(id: string, progress: TaskProgress): LauncherTask | null {
    return this.patch(id, { progress }, false);
  }

  succeed(id: string, result: Readonly<Record<string, unknown>> | null = null): LauncherTask | null {
    return this.patch(id, { state: 'succeeded', result, endedAt: this.isoNow() }, true);
  }

  fail(id: string, err: unknown): LauncherTask | null {
    const error: LauncherError = normalizeLauncherError(err);
    return this.patch(id, { state: 'failed', error, endedAt: this.isoNow() }, true);
  }

  /**
   * 取消（契约 `TaskCenter.cancel`）。
   *
   * - 未知 id：`LAUNCHER_INTERNAL`（契约没有「任务不存在」码，不新造）；
   * - 已终态：幂等返回（重复点取消不该报错）；
   * - `queued`：本地落 `cancelled` 并立即广播，再向执行方发请求（若有通道）；
   * - `running`：**只发请求**，状态不动；无通道或不可取消 → `LAUNCHER_TASK_BUSY`。
   */
  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      throw launcherError('LAUNCHER_INTERNAL', { detail: `任务不存在：${id}` });
    }
    if (isTerminalTaskState(task.state)) return;
    const channel = this.channels.get(id);

    if (task.state === 'queued') {
      this.patch(id, { state: 'cancelled', endedAt: this.isoNow() }, true);
      if (channel?.onCancel) await this.requestCancel(channel.onCancel);
      return;
    }

    if (!task.cancellable || !channel?.onCancel) {
      throw launcherError('LAUNCHER_TASK_BUSY', {
        detail: task.cancellable ? '该任务没有取消通道' : '该任务被标记为不可取消',
      });
    }
    await this.requestCancel(channel.onCancel);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /** 清空监听与定时器（任务快照保留，供 UI 收尾读取；进程不在这里收尸） */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.lastEmitAt.clear();
    this.listeners.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async requestCancel(run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_TASK_BUSY', detail: '取消请求失败' });
    }
  }

  private patch(
    id: string,
    fields: Partial<Pick<LauncherTask, 'state' | 'progress' | 'startedAt' | 'endedAt' | 'error' | 'result'>>,
    force: boolean,
  ): LauncherTask | null {
    const prev = this.tasks.get(id);
    if (!prev) return null;
    // 终态冻结：先到的终态就是终态（迟到的 succeeded 不得覆盖 cancelled，反之亦然）
    if (isTerminalTaskState(prev.state)) return prev;
    const next: LauncherTask = {
      ...prev,
      ...fields,
      // 进度只增不减：宿主的块可能乱序到达，倒退的 done 会让进度条来回跳
      ...(fields.progress === undefined ? {} : { progress: mergeProgress(prev.progress, fields.progress) }),
    };
    this.tasks.set(id, next);
    if (signature(prev) !== signature(next)) this.emit(next, force);
    return next;
  }

  /**
   * 广播：`force` / 终态立即发；其余按 `throttleMs` 窗口合并（窗口内只留**最新**快照，
   * 尾沿补发一次），窗口内不会丢任何终态（终态走 force 分支并清掉挂起的定时器）。
   */
  private emit(task: LauncherTask, force: boolean): void {
    if (this.disposed) return;
    const terminal = isTerminalTaskState(task.state);
    if (!force && !terminal) {
      const now = this.now();
      const last = this.lastEmitAt.get(task.id) ?? Number.NEGATIVE_INFINITY;
      const wait = this.throttleMs - (now - last);
      if (wait > 0) {
        if (this.timers.has(task.id)) return; // 已有尾沿挂起，届时会取最新快照
        const timer = setTimeout(() => {
          this.timers.delete(task.id);
          const latest = this.tasks.get(task.id);
          if (!latest || this.disposed) return;
          this.lastEmitAt.set(task.id, this.now());
          this.notify(latest);
        }, wait);
        this.timers.set(task.id, timer);
        return;
      }
    }
    const pending = this.timers.get(task.id);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.timers.delete(task.id);
    }
    this.lastEmitAt.set(task.id, this.now());
    this.notify(task);
  }

  private notify(task: LauncherTask): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(task);
      } catch {
        // 订阅者异常不影响其它订阅者（与总线同一待遇）；本层无 logger，交由上层兜
      }
    }
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

/* ------------------------------ 纯函数 ------------------------------ */

/**
 * 两个快照的**可观察等价**判据（不含 `elapsed` 这类流逝量）：
 * 状态 / 进度读数 / 文案 / 结束时刻 / 错误码。相等即不广播。
 */
function signature(task: LauncherTask): string {
  const p = task.progress;
  return [
    task.state,
    p ? `${p.done}/${p.total}/${p.message}` : '-',
    task.startedAt ?? '-',
    task.endedAt ?? '-',
    task.error?.code ?? '-',
  ].join('|');
}

/**
 * 合并口径（幂等、单调）：
 * - **终态冻结**：已有终态则整条保留（先到的终态即终态，迟到快照一律不回退）；
 * - 进度不倒退：`done` 更大者胜，相等时以新快照的文案为准；
 * - `startedAt` / `endedAt` 一旦有值不被空值覆盖；
 * - `result` / `error` 有值优先。
 */
function mergeTask(prev: LauncherTask, next: LauncherTask): LauncherTask {
  if (isTerminalTaskState(prev.state)) return prev;
  // 已 running 的任务不会被迟到的 queued 快照拉回队首
  const regressed = prev.state === 'running' && next.state === 'queued';
  const merged: LauncherTask = {
    ...next,
    state: regressed ? 'running' : next.state,
    startedAt: next.startedAt ?? prev.startedAt,
    endedAt: next.endedAt ?? prev.endedAt,
    error: next.error ?? prev.error,
    result: next.result ?? prev.result,
    progress: mergeProgress(prev.progress, next.progress),
  };
  return merged;
}

function mergeProgress(
  prev: LauncherTask['progress'],
  next: LauncherTask['progress'],
): LauncherTask['progress'] {
  if (!next) return prev;
  if (!prev) return next;
  if (next.done < prev.done) return prev;
  return next;
}
