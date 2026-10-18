import type {
  EventBus,
  FileChangeKind,
  FileWatchStateEvent,
  FileWatchStatus,
  Logger,
  PlatformBridge,
  Unsubscribe,
  WatchFailure,
  WatchReport,
} from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';
import {
  WATCH_RECONNECT_MAX_ATTEMPTS,
  describeReconnectProgress,
  reconnectDelayMs,
  shouldGiveUpReconnect,
} from './watcher-reconnect';

/**
 * 内核文件监视器（BUG-5，2026-10-13）：平台原始事件 → 去抖合并 → `file.changed`。
 *
 * 分层口径（`platform.ts` 的 `WatchCallback` 注释早已定死）：
 * Rust 只转发原始事件，**去抖 / 归一化 / 判级在这里**。
 *
 * 生命周期由宿主驱动（与 `register_write_domain` 同款：project.opened 起、
 * project.closed 停）。刻意**不**在 `createKernel` 里自动起：内核测试会开一堆
 * 临时项目目录，自动起监视会留下一堆活句柄（测试进程退出被拖、还制造无关事件）。
 *
 * 失效自愈（P0-5）：运行期失效 / 起监视失败不再直接终态 `unavailable`，而是
 * 指数退避自动重建（1s/2s/4s…封顶 60s），状态 `reconnecting` 全程可见；
 * 连续失败到 `WATCH_RECONNECT_MAX_ATTEMPTS` 才降级终态。重建链全程带会话号：
 * 过期会话的回调与定时器到点一律丢弃（快速换项目时旧重连绝不咬新会话）。
 */

/**
 * 尾缘去抖窗口。取值依据：一次原子写（临时文件 + rename）在 Windows 上会投出
 * 2–3 条事件；外部编辑器保存通常是 1 条；`fs.watch` 递归监视在大目录写入时会连发。
 * 200ms 足以把它们并成一次，又短到读者感觉不出与"直接刷新"的差别。
 * 窗口从**首条**事件起算（不是每来一条就重置）：持续写入的文件也保证 200ms 内必有一次
 * 上报，不会被去抖饿死。
 */
export const WATCH_DEBOUNCE_MS = 200;

export interface FileWatcherDeps {
  platform: PlatformBridge;
  bus: EventBus;
  log: Logger;
  debounceMs?: number;
}

export interface FileWatchController {
  /** 起（或换）监视：`roots` 为绝对路径目录。重复调用 = 用新的一组根替换旧的。 */
  start(roots: string[]): Promise<void>;
  /** 停监视并丢弃尚未 flush 的事件（project.closed / 应用退出）。 */
  stop(): void;
  state(): FileWatchStateEvent;
}

/**
 * 根目录折叠：递归监视是包含式的——`C:\Game` 与 `C:\Game\kojo` 同时登记会让后者
 * 的每个事件报两遍（两个句柄各投一次），去抖窗内也只是"同一个 key 两次"，
 * 看着无害，实际是让同一次变更有了两条独立计时链。折叠后每个路径只有一个来源。
 */
function collapseRoots(roots: string[]): string[] {
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    const key = pathKey(r);
    if (seen.has(key)) continue; // 同一目录的两种写法（尾分隔符 / Windows 大小写）算一个，保留首次拼法
    seen.add(key);
    uniq.push(r);
  }
  return uniq.filter((r) => !uniq.some((o) => pathKey(o) !== pathKey(r) && isPathUnder(o, r)));
}

export class FileWatcherServiceImpl implements FileWatchController {
  private readonly debounceMs: number;
  private readonly pendingKinds = new Map<string, FileChangeKind>();
  private readonly pendingPaths = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private unsubscribe: Unsubscribe | null = null;
  private state_: FileWatchStateEvent = { status: 'stopped', roots: [], failures: [] };
  /** 本次 start 是否收到过平台自述（老桥/测试桥可能不发 → 兜底按请求根判 watching） */
  private reportedThisSession = false;
  /**
   * 会话号：`watchDirs` 是异步的，快速连开两个项目时会有两次 start 在途。
   * 没有这个号的话，后一次的 teardown 取消不到前一次（它还没返回取消函数），
   * 而前一次随后返回的取消函数会把**新**会话停掉——监视静默失灵，正是本批要根治的形状。
   */
  private session = 0;

  /* --------------------- 失效自愈（P0-5）状态 --------------------- */
  /** 重连定时器在走 = 重建链活着（`reconnecting` 模式）。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续失败的重建尝试数（重建成功清零）。 */
  private reconnectFailures = 0;
  /** 处于重连模式（`started` 自述的判级口径随之变化，见 `onReport`）。 */
  private reconnecting = false;

  constructor(private readonly deps: FileWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS;
  }

  state(): FileWatchStateEvent {
    return this.state_;
  }

  async start(rawRoots: string[]): Promise<void> {
    const my = ++this.session;
    this.clearReconnectState(); // 新项目新会话：旧会话的重连链必须死（定时器+计数都归零）
    await this.teardown();
    this.reportedThisSession = false;

    const roots = collapseRoots(rawRoots);
    if (roots.length === 0) {
      this.publish('unavailable', [], [
        { root: '(无)', reason: '没有可监视的目录（项目未打开或根目录列表为空）' },
      ]);
      return;
    }

    try {
      const un = await this.deps.platform.watchDirs(
        roots,
        (kind, path) => {
          if (my === this.session) this.onRawEvent(kind, path);
        },
        (report) => {
          if (my === this.session) this.onReport(roots, report);
        },
      );
      if (my !== this.session) {
        // 等待期间有人重开了项目：这次会话作废，立刻取消，绝不能把新会话的句柄带走
        await un();
        return;
      }
      // watchDirs 可能在我们收到 started 之前就返回（同步实现），也可能根本不发报告
      this.unsubscribe = un;
      if (!this.reportedThisSession) {
        this.publish('watching', roots, []);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.log.warn(`File watch failed to start: ${reason}`);
      if (my === this.session) {
        // 目录可能只是暂时不在（网络盘 / 换名中）：不直接判死，进退避重连
        this.beginReconnect(roots, reason);
      }
    }
  }

  stop(): void {
    this.session++; // 在途 start 的返回值与事件一律作废（否则会注册进一个"已停止"的监视器）
    this.clearReconnectState();
    void this.teardown();
    this.publish('stopped', [], []);
  }

  /* ----------------------------- 内部 ----------------------------- */

  private async teardown(): Promise<void> {
    this.clearTimers();
    if (this.unsubscribe) {
      const un = this.unsubscribe;
      this.unsubscribe = null;
      try {
        await un();
      } catch (err) {
        this.deps.log.warn(`File watch stop failed: ${String(err)}`);
      }
    }
  }

  /* --------------------- 失效自愈（P0-5） --------------------- */

  /**
   * 进入重连模式：失效可见（`reconnecting`，不是静默重试），然后按退避序列安排
   * 第一次重建。连发的失效事件只认第一条（notify 句柄死后可能连报多条，
   * 每条都重置退避会让计时链永远走不出去）。
   */
  private beginReconnect(roots: string[], reason: string): void {
    if (this.reconnectTimer) return; // 重建链已在走：后续 error 不重启计时
    this.reconnecting = true;
    this.reconnectFailures = 0;
    this.publish('reconnecting', roots, [
      { root: roots.join('; '), reason: `${reason}（${describeReconnectProgress(0)}）` },
    ]);
    this.scheduleReconnect(this.session, roots);
  }

  private scheduleReconnect(my: number, roots: string[]): void {
    const delay = reconnectDelayMs(this.reconnectFailures);
    this.reconnectTimer = setTimeout(() => {
      void this.attemptReconnect(my, roots);
    }, delay);
  }

  /** 一次重建尝试：teardown 旧句柄 → 重新 `watchDirs`（同根、同会话号闸门）。 */
  private async attemptReconnect(my: number, roots: string[]): Promise<void> {
    this.reconnectTimer = null;
    if (my !== this.session) return; // 会话过期（换了项目/停了）：整条重建链就地丢弃
    await this.teardown(); // 旧句柄即便还挂着也已是死的，这里统一拆干净
    if (my !== this.session) return;
    this.reportedThisSession = false;
    try {
      const un = await this.deps.platform.watchDirs(
        roots,
        (kind, path) => {
          if (my === this.session) this.onRawEvent(kind, path);
        },
        (report) => {
          if (my === this.session) this.onReport(roots, report);
        },
      );
      if (my !== this.session) {
        await un(); // 等待期间换会话：立刻取消，不带走新会话的句柄
        return;
      }
      this.unsubscribe = un;
      if (!this.reportedThisSession) {
        // 桥不发 started 自述（老桥）：按请求根兜底判成功——重建成功必须发恢复通知
        this.reconnectSucceeded();
        this.publish('watching', roots, []);
      }
    } catch (err) {
      if (my !== this.session) return;
      this.reconnectAttemptFailed(roots, err instanceof Error ? err.message : String(err));
    }
  }

  /** 一次重建尝试失败：计数、继续退避，或到上限彻底降级（终态前把账说全）。 */
  private reconnectAttemptFailed(roots: string[], reason: string): void {
    this.reconnectFailures += 1;
    this.deps.log.warn(`File watch reconnect #${this.reconnectFailures} failed: ${reason}`);
    if (shouldGiveUpReconnect(this.reconnectFailures)) {
      this.reconnecting = false;
      this.publish('unavailable', [], [
        {
          root: roots.join('; '),
          reason: `连续自动重连 ${WATCH_RECONNECT_MAX_ATTEMPTS} 次仍失败（${reason}），不再自动重试`,
        },
      ]);
      return;
    }
    this.publish('reconnecting', roots, [
      {
        root: roots.join('; '),
        reason: `${reason}（${describeReconnectProgress(this.reconnectFailures)}）`,
      },
    ]);
    this.scheduleReconnect(this.session, roots);
  }

  /** 重建成功：计数清零、退出重连模式（状态发布由调用方负责——watching/partial 各自判级）。 */
  private reconnectSucceeded(): void {
    this.reconnecting = false;
    this.reconnectFailures = 0;
  }

  /** 换会话 / 停止时掐断整条重连链（定时器 + 计数 + 模式）。 */
  private clearReconnectState(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectFailures = 0;
    this.reconnecting = false;
  }

  private onReport(requested: string[], report: WatchReport): void {
    if (report.type === 'started') {
      this.reportedThisSession = true;
      if (this.reconnecting && report.watched.length === 0) {
        // 重连尝试落空（目录还没回来）：不是终态，继续退避——别把「暂时不在」判成「永别」
        const reason =
          report.failures.map((f) => `${f.root}: ${f.reason}`).join(' | ') || '没有根监视上';
        this.reconnectAttemptFailed(requested, reason);
        return;
      }
      const status: FileWatchStatus =
        report.watched.length === 0
          ? 'unavailable'
          : report.failures.length > 0
            ? 'partial'
            : 'watching';
      this.publish(status, report.watched, report.failures);
      if (status === 'watching' || status === 'partial') {
        this.reconnectSucceeded(); // 事件流恢复（部分恢复也算）：重连计数清零，下次失效从 1s 重新起算
      }
      if (status !== 'watching') {
        this.deps.log.warn(
          `File watch ${status}: ok=[${report.watched.join(', ')}] ` +
            `failed=${report.failures.map((f) => `${f.root}: ${f.reason}`).join(' | ')}`,
        );
      }
      return;
    }
    // 运行期监视器自身失效：已 flush 的事件不追回，但"之后不会再有事件"必须可见——
    // 不再终态静死，转入退避自动重建（P0-5）
    this.deps.log.warn(`File watch degraded: ${report.reason}`);
    this.beginReconnect(requested, report.reason);
  }

  private onRawEvent(kind: FileChangeKind, path: string): void {
    const key = pathKey(path);
    // 同一去抖窗内多条事件按**最后观测到的类别**上报：平台按时间顺序投递，末态即真值。
    // 反例：外部工具用"删除 + 重建"的方式保存 ⇒ 链是 unlink → create，
    // 若取"最保守"的 unlink，消费方会以为文件没了（而它就在盘上）。
    this.pendingKinds.set(key, kind);
    this.pendingPaths.set(key, path);
    if (this.timers.has(key)) return; // 窗口已从首条事件起算，不再重置（防饿死）
    const timer = setTimeout(() => this.flush(key), this.debounceMs);
    this.timers.set(key, timer);
  }

  private flush(key: string): void {
    this.timers.delete(key);
    const kind = this.pendingKinds.get(key);
    const path = this.pendingPaths.get(key);
    this.pendingKinds.delete(key);
    this.pendingPaths.delete(key);
    if (kind === undefined || path === undefined) return;
    // 路径**原样透传**：消费方用同一个字符串做键（EditorPane 的 entriesRef、
    // 文件树的 dirCache），此处改写分隔符会让"文件已打开"判空、事件静默失效。
    this.deps.bus.emit('file.changed', { kind, path });
  }

  private clearTimers(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pendingKinds.clear();
    this.pendingPaths.clear();
  }

  private publish(
    status: FileWatchStatus,
    roots: string[],
    failures: WatchFailure[],
  ): void {
    this.state_ = { status, roots, failures };
    this.deps.bus.emit('file.watchState', this.state_);
  }
}
