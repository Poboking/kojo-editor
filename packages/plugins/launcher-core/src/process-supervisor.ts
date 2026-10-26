/**
 * 进程监督（契约 §6.4 + 状态机 §8.1）。
 *
 * ## 单飞锁：为什么 core 侧还要第二把
 *
 * 宿主的每实例锁是**第一道**（`Mutex<HashMap<InstanceId, Running>>` + `running.lock`），
 * 它保证「不会被拉出两个进程」。但宿主的锁只在命令**真正开始执行**之后才被看见：
 * 双击启动时两次 `start` 都可能先通过 UI 层的所有前置检查、都发到宿主，第二个才被拒。
 * core 侧这把锁在本层内存里，**在发命令之前**就落下——挡住的是「同一瞬间两个请求都过闸」
 * 这一类竞态，代价是一个 `Set`。
 *
 * 判据比宿主**更严一点**：`starting` / `running` / `stopping` 一律 `LAUNCHER_INSTANCE_BUSY`；
 * 只有 `idle` / `exited` / `crashed` 允许 `start`（§8.1 的最后一行）。
 *
 * ## 状态机记账
 *
 * 本地状态只由两处推进：本层命令的返回值（同步、可信）与宿主事件（带 `seq`，严格递增才收）。
 * `start` 校验失败**回 `idle`**——绝不落 `exited`：`exited` 意味着「有过一个会话、它结束了」，
 * 而失败路径上根本不存在会话，落 `exited` 会让崩溃摘要与「上次退出码」凭空多出一条假记录。
 */

import type {
  ExecutableTrust,
  ExitRecord,
  ProcessStatus,
  ProcessSupervisor,
  StopOptions,
  Unsubscribe,
} from '@kojo/plugin-api';
import type { HostProcessEvent, LauncherHostBridge } from './host';
import { launcherError, normalizeLauncherError } from './errors';

/** 允许 `start` 的状态（§8.1：`exited` / `crashed` 可再次启动，`launchCount++` 由宿主） */
const STARTABLE: ReadonlySet<ProcessStatus['state']> = new Set<ProcessStatus['state']>([
  'idle',
  'exited',
  'crashed',
]);

/** 允许 `stop` 的状态：只有真正在跑才需要停 */
const STOPPABLE: ReadonlySet<ProcessStatus['state']> = new Set<ProcessStatus['state']>([
  'running',
  'stopping',
]);

export interface ProcessSupervisorOptions {
  readonly host: LauncherHostBridge;
  readonly now?: () => number;
  /**
   * 终态回调（每个会话恰好一次）：日志服务据此冲刷该会话未闭合的半行，
   * 后续的崩溃摘要 / 退出记录也挂在这里。
   */
  readonly onTerminal?: (status: ProcessStatus) => void;
}

export class ProcessSupervisorImpl implements ProcessSupervisor {
  private readonly host: LauncherHostBridge;
  private readonly now: () => number;
  private readonly onTerminal: ((status: ProcessStatus) => void) | undefined;
  private readonly statuses = new Map<string, ProcessStatus>();
  /** 每实例单飞锁（core 侧第二道，见文件头） */
  private readonly inflight = new Set<string>();
  private readonly listeners = new Set<(status: ProcessStatus) => void>();
  private readonly exits = new Map<string, ExitRecord>();
  private readonly seqByInstance = new Map<string, number>();
  private disposed = false;

  constructor(options: ProcessSupervisorOptions) {
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.onTerminal = options.onTerminal;
  }

  /* ------------------------------ 契约面 ------------------------------ */

  async start(instanceId: string): Promise<ProcessStatus> {
    // 单飞：**在发宿主命令之前**落锁（第二道闸的全部意义）
    this.assertCanStart(instanceId);
    const before = this.current(instanceId);
    this.inflight.add(instanceId);
    this.commit({ ...before, state: 'starting', pid: null, exitCode: null, exitReason: null, lastError: null });
    try {
      const status = await this.host.start(instanceId);
      this.commit(normalizeStatus(instanceId, status, this.now()));
      return this.current(instanceId);
    } catch (err) {
      const error = normalizeLauncherError(err);
      // 校验失败 = 没有会话：回 idle，**不落 exited**
      this.commit({
        ...this.current(instanceId),
        state: 'idle',
        pid: null,
        sessionId: null,
        startedAt: null,
        elapsedMs: 0,
        exitCode: null,
        exitReason: null,
        lastError: error,
      });
      throw error;
    } finally {
      this.inflight.delete(instanceId);
    }
  }

  async stop(instanceId: string, opts?: StopOptions): Promise<ProcessStatus> {
    this.assertNoInflight(instanceId);
    const before = this.current(instanceId);
    // 没在跑：幂等返回当前读数（`idle` / `exited` / `crashed` 都算已停）
    if (!STOPPABLE.has(before.state)) return this.current(instanceId);

    this.inflight.add(instanceId);
    this.commit({ ...before, state: 'stopping' });
    try {
      const status = await this.host.stop(instanceId, opts);
      this.commit(normalizeStatus(instanceId, status, this.now()));
      return this.current(instanceId);
    } catch (err) {
      // 停止失败：状态以宿主下一次事件为准，本地只记错误（不猜「已经停了」）
      const error = normalizeLauncherError(err);
      this.commit({ ...this.current(instanceId), lastError: error });
      throw error;
    } finally {
      this.inflight.delete(instanceId);
    }
  }

  status(instanceId: string): ProcessStatus {
    return this.current(instanceId);
  }

  list(): readonly ProcessStatus[] {
    return [...this.statuses.keys()].sort().map((id) => this.current(id));
  }

  async trust(instanceId: string): Promise<ExecutableTrust> {
    try {
      return await this.host.trustExecutable(instanceId);
    } catch (err) {
      throw normalizeLauncherError(err);
    }
  }

  subscribe(listener: (status: ProcessStatus) => void): Unsubscribe {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ------------------------------ 事件与恢复 ------------------------------ */

  /** `kojo:launcher-process`：按 `seq` 严格递增收（乱序/重复一律丢） */
  applyEvent(event: HostProcessEvent): void {
    const lastSeq = this.seqByInstance.get(event.instanceId) ?? -1;
    if (event.seq <= lastSeq) return;
    this.seqByInstance.set(event.instanceId, event.seq);
    this.commit(normalizeStatus(event.instanceId, event.status, this.now()));
  }

  /** `initialize()` 用：把宿主进程表恢复成本地读数（崩溃记录随 `lastExit` 一起回来） */
  applySnapshot(statuses: readonly ProcessStatus[]): void {
    for (const status of statuses) this.commit(normalizeStatus(status.instanceId, status, this.now()));
  }

  /** 最近一次会话的退出记录（崩溃摘要 / 实例详情用；契约 `ProcessStatus` 只带码与原因） */
  lastExit(instanceId: string): ExitRecord | null {
    return this.exits.get(instanceId) ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.inflight.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private assertNoInflight(instanceId: string): void {
    if (this.inflight.has(instanceId)) {
      throw launcherError('LAUNCHER_INSTANCE_BUSY', {
        detail: `实例 ${instanceId} 已有启动或停止操作在进行`,
      });
    }
  }

  private assertCanStart(instanceId: string): void {
    this.assertNoInflight(instanceId);
    const state = this.current(instanceId).state;
    if (!STARTABLE.has(state)) {
      throw launcherError('LAUNCHER_INSTANCE_BUSY', {
        detail: `实例 ${instanceId} 当前状态为 ${state}`,
      });
    }
  }

  /** 当前读数（`elapsedMs` 现算；返回副本，调用方改不了内部账本） */
  private current(instanceId: string): ProcessStatus {
    const stored = this.statuses.get(instanceId) ?? idleStatus(instanceId);
    return { ...stored, elapsedMs: elapsed(stored, this.now()) };
  }

  /**
   * 落账 + 按需广播：**值变了才广播**。
   * 命令返回值与紧随其后的宿主事件往往是同一份状态，靠这条去重（「每次变更恰好一次」）。
   */
  private commit(next: ProcessStatus): void {
    const instanceId = next.instanceId;
    const prev = this.statuses.get(instanceId);
    this.statuses.set(instanceId, next);
    const sameState = prev !== undefined && statusSignature(prev) === statusSignature(next);
    const wasTerminal = prev !== undefined && isTerminal(prev.state);
    if (!sameState) {
      if (!this.disposed) {
        for (const listener of [...this.listeners]) {
          try {
            listener(this.current(instanceId));
          } catch {
            // 订阅者异常不影响其它订阅者
          }
        }
      }
    }
    if (isTerminal(next.state) && !wasTerminal) this.recordExit(next);
  }

  private recordExit(status: ProcessStatus): void {
    const endedAt = new Date(this.now()).toISOString();
    const exit: ExitRecord = {
      sessionId: status.sessionId ?? '',
      startedAt: status.startedAt ?? endedAt,
      endedAt,
      exitCode: status.exitCode,
      reason: status.exitReason ?? 'unknown',
    };
    this.exits.set(status.instanceId, exit);
    this.onTerminal?.(this.current(status.instanceId));
  }
}

/* ------------------------------ 纯函数 ------------------------------ */

/** 空闲读数（未登记实例的缺省快照） */
export function idleStatus(instanceId: string): ProcessStatus {
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
  };
}

/** 状态终态判据 */
function isTerminal(state: ProcessStatus['state']): boolean {
  return state === 'exited' || state === 'crashed';
}

/** 广播判据：不含 `elapsedMs`（流逝量每毫秒都在变，纳进来就退化成定时广播） */
function statusSignature(status: ProcessStatus): string {
  return [
    status.state,
    status.pid ?? '-',
    status.sessionId ?? '-',
    status.startedAt ?? '-',
    status.exitCode ?? '-',
    status.exitReason ?? '-',
    status.lastError?.code ?? '-',
  ].join('|');
}

/** 宿主回来的读数可能缺 `instanceId`：以调用方的实例 id 为准，并补齐 `elapsedMs` */
function normalizeStatus(instanceId: string, status: ProcessStatus, now: number): ProcessStatus {
  const merged: ProcessStatus = {
    ...status,
    instanceId,
  };
  return { ...merged, elapsedMs: elapsed(merged, now) };
}

function elapsed(status: ProcessStatus, now: number): number {
  if (status.startedAt === null) return status.elapsedMs;
  if (!isActive(status.state)) return status.elapsedMs;
  const started = Date.parse(status.startedAt);
  if (Number.isNaN(started)) return status.elapsedMs;
  return Math.max(0, now - started);
}

function isActive(state: ProcessStatus['state']): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping';
}
