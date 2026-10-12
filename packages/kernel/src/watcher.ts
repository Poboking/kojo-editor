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

/**
 * 内核文件监视器（BUG-5，2026-10-13）：平台原始事件 → 去抖合并 → `file.changed`。
 *
 * 分层口径（`platform.ts` 的 `WatchCallback` 注释早已定死）：
 * Rust 只转发原始事件，**去抖 / 归一化 / 判级在这里**。
 *
 * 生命周期由宿主驱动（与 `register_write_domain` 同款：project.opened 起、
 * project.closed 停）。刻意**不**在 `createKernel` 里自动起：内核测试会开一堆
 * 临时项目目录，自动起监视会留下一堆活句柄（测试进程退出被拖、还制造无关事件）。
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

  constructor(private readonly deps: FileWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS;
  }

  state(): FileWatchStateEvent {
    return this.state_;
  }

  async start(rawRoots: string[]): Promise<void> {
    const my = ++this.session;
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
        this.publish('unavailable', [], roots.map((root) => ({ root, reason })));
      }
    }
  }

  stop(): void {
    this.session++; // 在途 start 的返回值与事件一律作废（否则会注册进一个"已停止"的监视器）
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

  private onReport(requested: string[], report: WatchReport): void {
    if (report.type === 'started') {
      this.reportedThisSession = true;
      const status: FileWatchStatus =
        report.watched.length === 0
          ? 'unavailable'
          : report.failures.length > 0
            ? 'partial'
            : 'watching';
      this.publish(status, report.watched, report.failures);
      if (status !== 'watching') {
        this.deps.log.warn(
          `File watch ${status}: ok=[${report.watched.join(', ')}] ` +
            `failed=${report.failures.map((f) => `${f.root}: ${f.reason}`).join(' | ')}`,
        );
      }
      return;
    }
    // 运行期监视器自身失效：已 flush 的事件不追回，但"之后不会再有事件"必须可见
    this.deps.log.warn(`File watch degraded: ${report.reason}`);
    this.publish('unavailable', [], [{ root: requested.join('; '), reason: report.reason }]);
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
