import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileChangedEvent,
  FileWatchStateEvent,
  PlatformBridge,
  Unsubscribe,
  WatchCallback,
  WatchReport,
  WatchReportCallback,
} from '@kojo/plugin-api';
import { TypedEventBus } from '../src/bus';
import { FileWatcherServiceImpl, WATCH_DEBOUNCE_MS } from '../src/watcher';

/**
 * 内核文件监视器（BUG-5）：去抖 / 合并 / 判级 / 生命周期。
 *
 * 时间用假时钟驱动——去抖窗是这批行为的**本体**，用真 setTimeout 会让断言
 * 依赖调度精度（正是过去"绿得不可复现"的形状）。
 */

interface FakeBridge {
  bridge: PlatformBridge;
  /** 平台侧投递原始事件（模拟 Rust notify 回调） */
  fire: (kind: 'add' | 'change' | 'unlink', path: string) => void;
  /** 从第 n 次 watchDirs 的注入点投递（点名旧会话的迟到事件） */
  fireAt: (n: number, kind: 'add' | 'change' | 'unlink', path: string) => void;
  /** 平台侧自述（started / 运行期 error） */
  report: (r: WatchReport) => void;
  /** 每次 watchDirs 收到的根目录列表 */
  calls: string[][];
  /** 每次 watchDirs 拿到的原始事件注入点（旧会话的句柄可以单独点名投事件） */
  sinks: WatchCallback[];
  /** watchDirs 返回的取消函数被调用的次数 */
  stops: number;
  /** 下一次 watchDirs 直接抛（模拟平台没有监视能力） */
  throwNext: Error | null;
  /** 平台不发 started 报告（老桥） */
  silent: boolean;
  /** watchDirs 延迟返回（模拟 IPC 在途）；用 settleNext() 逐个放行 */
  defer: boolean;
  settleNext: Array<() => void>;
  /** 这些根"监视失败"：started 报告里逐条给原因 */
  failOn: Record<string, string>;
}

function makeBridge(): FakeBridge {
  let onReport: WatchReportCallback | null = null;
  const self: FakeBridge = {
    bridge: null as unknown as PlatformBridge,
    calls: [],
    sinks: [],
    stops: 0,
    throwNext: null,
    silent: false,
    defer: false,
    settleNext: [],
    failOn: {},
    fire: (kind, path) => self.sinks.at(-1)?.(kind, path),
    fireAt: (n, kind, path) => self.sinks[n]?.(kind, path),
    report: (r) => onReport?.(r),
  };
  self.bridge = {
    async watchDirs(paths: string[], ev: WatchCallback, rep?: WatchReportCallback) {
      if (self.throwNext) {
        const err = self.throwNext;
        self.throwNext = null;
        throw err;
      }
      self.calls.push(paths);
      self.sinks.push(ev);
      onReport = rep ?? null;
      if (rep && !self.silent) {
        const failed = paths.filter((p) => self.failOn[p]);
        rep({
          type: 'started',
          watched: paths.filter((p) => !self.failOn[p]),
          failures: failed.map((root) => ({ root, reason: self.failOn[root]! })),
        });
      }
      const un = () => {
        self.stops += 1;
      };
      if (self.defer) {
        // 取消函数"晚一点"才交回内核——模拟 IPC 在途，专门钓会话号竞态
        return new Promise<Unsubscribe>((resolve) => {
          self.settleNext.push(() => resolve(un));
        });
      }
      return un;
    },
  } as unknown as PlatformBridge;
  return self;
}

function makeWatcher(debounceMs?: number) {
  const bus = new TypedEventBus();
  const bridge = makeBridge();
  const warns: string[] = [];
  const watcher = new FileWatcherServiceImpl({
    platform: bridge.bridge,
    bus,
    log: { debug: () => {}, info: () => {}, warn: (m: string) => warns.push(m), error: () => {} },
    ...(debounceMs === undefined ? {} : { debounceMs }),
  });
  const changes: FileChangedEvent[] = [];
  bus.on('file.changed', (p) => changes.push(p));
  const states: FileWatchStateEvent[] = [];
  bus.on('file.watchState', (p) => states.push(p));
  return { bus, bridge, watcher, changes, states, warns };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * 排干若干微任务。defer 模式下 `start()` 停在 `await watchDirs(...)` 里，
 * 而它前面还有 `await teardown()`——两条 start 链都要跑进平台层才算"两个项目在途"。
 * 假时钟只管 setTimeout，不影响微任务，所以这里用纯微任务链推进。
 */
async function drainMicrotasks(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('FileWatcherServiceImpl · 去抖与合并', () => {
  it('同一去抖窗内的多条事件并成一次上报', async () => {
    const { bridge, watcher, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('change', 'a.erb');
    bridge.fire('change', 'a.erb');
    bridge.fire('change', 'a.erb');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(changes).toEqual([{ kind: 'change', path: 'a.erb' }]);
  });

  it('超出窗口后的事件另发一次（不是永久合并成一条）', async () => {
    const { bridge, watcher, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('change', 'a.erb');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    bridge.fire('change', 'a.erb');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(changes).toHaveLength(2);
  });

  it('窗口从首条事件起算且不重置：持续写入仍按时上报（防饿死）', async () => {
    const { bridge, watcher, changes } = makeWatcher(200);
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('change', 'a.erb');
    // 每 100ms 来一条，共 5 条：若实现是"每来一条重置计时器"，这条链永远不会 flush
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      bridge.fire('change', 'a.erb');
    }
    expect(changes).toHaveLength(2); // t=200 与 t=400 各一次
  });

  it('不同路径各自计时，互不吞掉', async () => {
    const { bridge, watcher, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('change', 'a.erb');
    bridge.fire('change', 'b.erb');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(changes.map((c) => c.path).sort()).toEqual(['a.erb', 'b.erb']);
  });

  it('末态类别即上报类别：外部工具「删除 + 重建 + 写入」的保存链不会停在 unlink', async () => {
    const { bridge, watcher, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('unlink', 'a.erb');
    bridge.fire('add', 'a.erb');
    bridge.fire('change', 'a.erb');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(changes).toEqual([{ kind: 'change', path: 'a.erb' }]);
  });

  it('重建后没有再写入 → 末态是 add（消费方按"新文件"处理）', async () => {
    const { bridge, watcher, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('unlink', 'a.erb');
    bridge.fire('add', 'a.erb');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(changes).toEqual([{ kind: 'add', path: 'a.erb' }]);
  });

  it('路径原样透传：消费方用同一字符串做键，改写分隔符会让"文件已打开"判空', async () => {
    const { bridge, watcher, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);

    bridge.fire('change', 'C:\\Game\\kojo\\M_KOJO_K12.ERB');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(changes[0]!.path).toBe('C:\\Game\\kojo\\M_KOJO_K12.ERB');
  });
});

describe('FileWatcherServiceImpl · 监视状态判级（绝不静默）', () => {
  it('全部根监视成功 → watching', async () => {
    const { bridge, watcher, states } = makeWatcher();
    await watcher.start(['C:/Game/kojo', 'C:/Game/sav']);
    expect(bridge.calls[0]).toEqual(['C:/Game/kojo', 'C:/Game/sav']);
    expect(states.at(-1)).toEqual({
      status: 'watching',
      roots: ['C:/Game/kojo', 'C:/Game/sav'],
      failures: [],
    });
  });

  it('部分根失败 → partial，逐条带原因（读者以为会自动重载，其实有些目录没有）', async () => {
    const { bridge, watcher, states, warns } = makeWatcher();
    bridge.failOn = { 'C:/Game/sav': 'Access is denied' };
    await watcher.start(['C:/Game/kojo', 'C:/Game/sav']);

    expect(states.at(-1)).toEqual({
      status: 'partial',
      roots: ['C:/Game/kojo'],
      failures: [{ root: 'C:/Game/sav', reason: 'Access is denied' }],
    });
    expect(warns.at(-1)).toContain('File watch partial');
  });

  it('一个根都没监视上 → unavailable', async () => {
    const { bridge, watcher, states } = makeWatcher();
    bridge.failOn = { 'C:/Game/kojo': 'not a directory' };
    await watcher.start(['C:/Game/kojo']);

    expect(states.at(-1)).toEqual({
      status: 'unavailable',
      roots: [],
      failures: [{ root: 'C:/Game/kojo', reason: 'not a directory' }],
    });
  });

  it('没有可监视的根（项目未打开）→ unavailable，且不向平台要监视', async () => {
    const { bridge, watcher, states } = makeWatcher();
    await watcher.start([]);

    expect(states.at(-1)!.status).toBe('unavailable');
    expect(bridge.calls).toHaveLength(0);
  });

  it('平台直接抛（浏览器开发壳）→ unavailable 且原因逐根给出', async () => {
    const { bridge, watcher, states, warns } = makeWatcher();
    bridge.throwNext = new Error('浏览器开发壳无文件监视能力');
    await watcher.start(['C:/Game/kojo']);

    expect(states.at(-1)).toEqual({
      status: 'unavailable',
      roots: [],
      failures: [{ root: 'C:/Game/kojo', reason: '浏览器开发壳无文件监视能力' }],
    });
    expect(warns.some((m) => m.includes('File watch failed to start'))).toBe(true);
  });

  it('运行期监视器自身失效 → unavailable + 告警（此后不会再有自动重载，必须说）', async () => {
    const { bridge, watcher, states, warns } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);
    expect(states.at(-1)!.status).toBe('watching');

    bridge.report({ type: 'error', reason: 'the notification handle was closed' });

    expect(states.at(-1)!.status).toBe('unavailable');
    expect(states.at(-1)!.failures[0]!.reason).toContain('handle');
    expect(warns.some((m) => m.includes('File watch degraded'))).toBe(true);
  });

  it('老平台桥不发 started 报告 → 按请求根兜底判 watching（不把"没报告"当成故障）', async () => {
    const { bridge, watcher, states } = makeWatcher();
    bridge.silent = true;
    await watcher.start(['C:/Game/kojo']);

    expect(states.at(-1)).toEqual({ status: 'watching', roots: ['C:/Game/kojo'], failures: [] });
  });

  it('stop() → stopped 且丢弃未 flush 的事件', async () => {
    const { bridge, watcher, states, changes } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);
    bridge.fire('change', 'a.erb'); // 还在窗口里
    watcher.stop();
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 2);

    expect(changes).toHaveLength(0);
    expect(states.at(-1)!.status).toBe('stopped');
  });

  it('换根目录 = 先取消旧监视（不留活句柄）', async () => {
    const { bridge, watcher } = makeWatcher();
    await watcher.start(['C:/Game/kojo']);
    await watcher.start(['C:/Other']);

    expect(bridge.stops).toBe(1);
    expect(bridge.calls[1]).toEqual(['C:/Other']);
  });
});

describe('FileWatcherServiceImpl · 会话竞态（快速连开两个项目）', () => {
  it('先返回的旧会话只取消自己，不会把新会话的句柄带走', async () => {
    const { bridge, watcher, states, changes } = makeWatcher();
    bridge.defer = true;

    const first = watcher.start(['C:/Game/A']);
    const second = watcher.start(['C:/Game/B']);
    await drainMicrotasks();
    expect(bridge.calls).toEqual([['C:/Game/A'], ['C:/Game/B']]);

    bridge.settleNext[0]!(); // 旧会话的 IPC 现在才回来
    await first;
    bridge.settleNext[1]!();
    await second;

    expect(bridge.stops).toBe(1); // 只取消了旧会话
    expect(states.at(-1)).toEqual({ status: 'watching', roots: ['C:/Game/B'], failures: [] });

    // 旧会话迟到的原始事件必须丢弃（它带着已作废项目的路径），新会话的正常上报
    bridge.fireAt(0, 'change', 'C:/Game/A/late.ERB');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 2);
    expect(changes).toHaveLength(0);

    bridge.fireAt(1, 'change', 'C:/Game/B/live.ERB');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(changes).toEqual([{ kind: 'change', path: 'C:/Game/B/live.ERB' }]);
  });

  it('stop() 之后迟到的 start 结果不复活监视，也不改写 stopped 状态', async () => {
    const { bridge, watcher, states } = makeWatcher();
    bridge.defer = true;

    const first = watcher.start(['C:/Game/A']);
    watcher.stop();
    await drainMicrotasks();
    bridge.settleNext[0]!();
    await first;

    expect(bridge.stops).toBe(1);
    expect(states.at(-1)!.status).toBe('stopped');
  });
});

describe('FileWatcherServiceImpl · 根目录折叠', () => {
  it('嵌套根只保留外层：同一事件不会有两个句柄各投一次', async () => {
    const { bridge, watcher } = makeWatcher();
    // 本机真实形状：项目根是游戏目录，存档库在同级的另一目录里（不被项目根包含），
    // 而 kojo / kojo/sub 都在项目根内 → 折叠后各留一个外层根
    await watcher.start([
      'C:/Game/eratw-SANYOUSEI',
      'C:/Game/eratw-SANYOUSEI/kojo',
      'C:/Game/eratw-SANYOUSEI/kojo/sub',
      'C:/Game/eratw-save/sav',
    ]);
    expect(bridge.calls[0]).toEqual(['C:/Game/eratw-SANYOUSEI', 'C:/Game/eratw-save/sav']);
  });

  it('同一目录的两种写法只保留一个', async () => {
    const { bridge, watcher } = makeWatcher();
    await watcher.start(['C:/Game/kojo', 'C:/Game/kojo/']);
    expect(bridge.calls[0]).toEqual(['C:/Game/kojo']);
  });

  it('Windows 大小写不同的同一根算一个', async () => {
    const { bridge, watcher } = makeWatcher();
    await watcher.start(['C:/Game/KOJO', 'c:/game/kojo']);
    expect(bridge.calls[0]).toEqual(['C:/Game/KOJO']);
  });
});
