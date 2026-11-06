/**
 * MCP 外部写盘感知（Wave4 余项 ③）定向单测：`fs-freshness` 失效短账 + 只读应答标注 +
 * `kojo://project/fs-freshness` 第 9 项 resource。
 *
 * 全程假内核总线（同步分发 `file.changed` / `file.watchState`）与假 `fileWatch.state()`
 * 回执（= Rust `start_watch` 的宿主侧形态：哪些根监视上了、哪些没有以及为什么），
 * 不起 GUI / Tauri / HTTP。断言钉在真行为上：
 * - 外部改动一条 `file.changed` ⇒ 后续只读应答 `stale:true` + 路径/时刻账目；
 * - 监视没起来 / 根不在监视域 / 判定器缺席 ⇒ 一律显式 `stale:null`（或 `available:false`）
 *   + `staleReason`，绝不静默、绝不乐观 `false`（铁律 4）；
 * - 判定比较用单调序号而非墙钟：时钟回拨不改判；Windows 大小写 / `..` / 分隔符变体折同一路径；
 * - 自写归因：自己写的推不胀自己（回声并条不推序号），但推得胀别的会话；
 * - 账本有界：溢出即 `truncated:true` + `dropped:n`，且溢出反过来把判定降为 `null`；
 * - scope 透传修正：`buildReadResourceData` 不再丢会话号，两会话基线互不串味；
 * - 幂等：同一内核重复装配不重复订阅；
 * - 第 9 项 resource 走 `deps.resources` 追加通道，冻结契约表 8 条零改动，
 *   能力面自述与 Rust `server_capabilities`（subscribe:false / listChanged:false）一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpCapabilityRegistry,
  MCP_RESOURCE_SPECS,
  RESOURCE_TEXT_LIMIT,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  CHANGE_LEDGER_CAPACITY,
  READ_LEDGER_CAPACITY,
  bindFsFreshness,
  createFsFreshnessTracker,
  fsFreshnessAbsentPayload,
  getFsFreshnessTracker,
  resetFsFreshnessForTest,
  type FsFreshnessKernelLike,
} from '../src/mcp/fs-freshness';
import {
  KOJO_RESOURCE_URIS,
  createFsFreshnessResource,
  createIoResourceData,
  createKernelIo,
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import { buildRealMcpSources, type McpRealSourceHost } from '../src/mcp/real-sources';
import type { CommandEntry } from '../src/ui/commands';

/* ------------------------------- 假件 ------------------------------- */

interface WatchSnapshot {
  status: string;
  roots: string[];
  failures: { root: string; reason: string }[];
}

const WATCHING: WatchSnapshot = { status: 'watching', roots: ['D:\\proj'], failures: [] };

/** B8 用得到的固定墙钟（回声窗与 mtime 复核的判据都要「同一毫秒」的确定性）。 */
const T0 = Date.parse('2026-11-06T12:00:00Z');

interface FakeBusKernel {
  readonly kernel: FsFreshnessKernelLike & McpKernelLike;
  /** 所有 `bus.on` 的事件名（按调用顺序，可数重复订阅）。 */
  readonly subNames: string[];
  readonly handlerCount: (name: string) => number;
}

function makeKernel(
  watch: WatchSnapshot | 'absent' = WATCHING,
  opts: { readonly projectCurrent?: unknown } = {},
): FakeBusKernel {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const subNames: string[] = [];
  const kernel = {
    project: {
      current: () =>
        opts.projectCurrent ?? { rootDir: 'D:\\proj', adapterId: 'adapter-a', kojoPaths: [] },
    },
    io: {
      walkDir: async () => [
        { name: 'a.kojo', path: 'D:\\proj\\a.kojo', isDirectory: false },
      ],
    },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_key: string) => undefined as T | undefined },
    slots: { query: () => [] },
    bus: {
      on(name: string, cb: (payload: unknown) => void): () => void {
        subNames.push(name);
        const arr = handlers.get(name) ?? [];
        arr.push(cb);
        handlers.set(name, arr);
        return () => {
          const list = handlers.get(name) ?? [];
          const at = list.indexOf(cb);
          if (at >= 0) list.splice(at, 1);
        };
      },
      emit(name: string, payload: unknown): void {
        for (const cb of [...(handlers.get(name) ?? [])]) cb(payload);
      },
    },
    ...(watch === 'absent' ? {} : { fileWatch: { state: () => watch } }),
  } as unknown as FsFreshnessKernelLike & McpKernelLike;
  return {
    kernel,
    subNames,
    handlerCount: (name: string) => (handlers.get(name) ?? []).length,
  };
}

/** 走总线 `file.changed` 分发（等价内核监视器去抖后的广播）。 */
function emitChanged(kernel: McpKernelLike, path: string, kind = 'change'): void {
  kernel.bus.emit?.('file.changed', { kind, path });
}

const SCOPE_A: McpSessionScope = {
  sessionId: 'sess-A',
  clientId: 'c1',
  tier: 'read',
  approvedRoots: [],
  approvedTools: [],
};
const SCOPE_B: McpSessionScope = {
  sessionId: 'sess-B',
  clientId: 'c2',
  tier: 'read',
  approvedRoots: [],
  approvedTools: [],
};

/** 写腿会话：第四张表 approvedRoots 是项目根内相对路径（与 mcp-write-legs 同尺）。 */
const WRITE_SCOPE: McpSessionScope = {
  sessionId: 'sess-A',
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: ['docs'],
  approvedTools: [],
};

const NO_SEARCH: McpSearchResultLike = {
  files: [],
  totalMatches: 0,
  truncated: false,
  filesScanned: 0,
  elapsedMs: 0,
  skipped: {},
};

function fakeIoDeps(kernel: McpKernelLike | null, over: Partial<McpIoDeps> = {}): McpIoDeps {
  const commands: CommandEntry[] = [];
  return {
    getKernel: () => kernel,
    getCommands: () => commands,
    invoke: async () => null,
    searchInFiles: async () => NO_SEARCH,
    ...over,
  };
}

afterEach(() => {
  resetFsFreshnessForTest();
  vi.useRealTimers();
});

/* ================================================================== *
 * ① 外部改动 → 只读应答 stale:true + 账目
 * ================================================================== */

describe('① 外部写盘感知：改动事件后只读判定的账目', () => {
  it('首次读取无基线 ⇒ stale:null + 理由（不是乐观 false）；外部改动后再读 ⇒ stale:true + 路径/时刻/序号账', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const abs = 'D:\\proj\\a.kojo';

    const first = tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_A });
    expect(first.available).toBe(true);
    expect(first.stale).toBeNull();
    expect(first.staleReason).toContain('没有读过');
    expect(first.previousReadAtMs).toBeNull();
    expect(first.tracked).toBe(true);
    expect(first.watched).toBe(true);
    expect(first.watchStateSource).toBe('kernel.fileWatch.state');

    emitChanged(kernel, abs, 'change');

    const second = tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_A });
    expect(second.stale).toBe(true);
    expect(second.staleReason).toBeNull();
    expect(second.target).toBe('a.kojo');
    expect(second.previousReadAtMs).toBeTypeOf('number');
    expect(second.changedAtMs).toBeTypeOf('number');
    expect(second.changeKind).toBe('change');
    expect(second.changeOrigin).toBe('unattributed');
    expect(second.changedSincePreviousRead).toBe(1);
    expect(second.ledger.changes.size).toBe(1);
    tracker.dispose();
  });

  it('时钟回拨不改判：基线比较用单调序号，不用墙钟差', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-06T10:00:00Z') });
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const abs = 'D:\\proj\\a.kojo';
    tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_A });
    // 系统时钟往回拨两小时，随后到达的改动事件仍必须判 stale:true。
    vi.setSystemTime(Date.parse('2026-11-06T08:00:00Z'));
    emitChanged(kernel, abs);
    const v = tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBe(true);
    expect(v.changedSincePreviousRead).toBe(1);
    // 反向（时刻读数倒退）如实可见：读数只是标注，不参与判定。
    expect(Number(v.changedAtMs) < Number(v.previousReadAtMs)).toBe(true);
    tracker.dispose();
  });

  it('Windows 坑：大小写 / `..` / 分隔符变体折叠为同一判定路径（同一路径不双记账）', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    // 基线用带 `..` 与反斜杠的形态登记。
    tracker.verdictOf({ abs: 'D:\\proj\\sub\\..\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    // 改动事件用大写盘符 + 正斜杠 + 折叠后同一路径的形态到达。
    emitChanged(kernel, 'd:/PROJ/A.KOJO');
    const v = tracker.verdictOf({ abs: 'D:\\proj\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBe(true);
    expect(v.ledger.changes.size).toBe(1);
    tracker.dispose();
  });

  it('目录级标注：根下任何路径被动过即 stale:true；未覆盖分支互不影响', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const l1 = tracker.listingOf({ dirAbs: 'D:\\proj', dirRel: '.', scope: SCOPE_A });
    expect(l1.granularity).toBe('listing');
    expect(l1.stale).toBeNull();
    emitChanged(kernel, 'D:\\proj\\deep\\dir\\x.kojo');
    const l2 = tracker.listingOf({ dirAbs: 'D:\\proj', dirRel: '.', scope: SCOPE_A });
    expect(l2.stale).toBe(true);
    expect(l2.changedSincePreviousRead).toBe(1);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ② 缺席/未监视：显式标注，绝不静默
 * ================================================================== */

describe('② 监视缺席一律可见（铁律 4）', () => {
  it('监视不可用（unavailable）⇒ stale:null + watched:false + 理由，不是 false 也不是缺字段', () => {
    const { kernel } = makeKernel({ status: 'unavailable', roots: [], failures: [] });
    const tracker = createFsFreshnessTracker(kernel);
    const v = tracker.verdictOf({ abs: 'D:\\proj\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(v.watched).toBe(false);
    expect(v.watchStatus).toBe('unavailable');
    expect(v.staleReason).toContain('不可信');
    tracker.dispose();
  });

  it('根不在监视域 ⇒ stale:null +「不在任何已监视的根内」', () => {
    const { kernel } = makeKernel({ status: 'watching', roots: ['D:\\other'], failures: [] });
    const tracker = createFsFreshnessTracker(kernel);
    const v = tracker.verdictOf({ abs: 'D:\\proj\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(v.tracked).toBe(false);
    expect(v.watched).toBe(true);
    expect(v.staleReason).toContain('不在任何已监视的根内');
    tracker.dispose();
  });

  it('partial 且该根在 failures 回执里 ⇒ staleReason 引用回执原话（start_watch 的 failed[]）', () => {
    const { kernel } = makeKernel({
      status: 'partial',
      roots: ['D:\\k'],
      failures: [{ root: 'D:\\proj', reason: '权限不足' }],
    });
    const tracker = createFsFreshnessTracker(kernel);
    const v = tracker.verdictOf({ abs: 'D:\\proj\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(v.watchStatus).toBe('partial');
    expect(v.unwatchedRootMatch).toEqual({ root: 'D:\\proj', reason: '权限不足' });
    expect(v.staleReason).toContain('没监视上的根');
    expect(v.staleReason).toContain('权限不足');
    tracker.dispose();
  });

  it('fileWatch.state() 缺席且无总线自述 ⇒ source:absent +「既没有…也没收到…」（不当成已监视）', () => {
    const { kernel } = makeKernel('absent');
    const tracker = createFsFreshnessTracker(kernel);
    const v = tracker.verdictOf({ abs: 'D:\\proj\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(v.watchStateSource).toBe('absent');
    expect(v.sources.fileWatchStateApi).toBe(false);
    expect(v.staleReason).toContain('既没有');
    // 总线 file.watchState 是次级真源：收到自述后即覆盖 absent 档。
    kernel.bus.emit?.('file.watchState', { status: 'watching', roots: ['D:\\proj'], failures: [] });
    const cov = tracker.coverage();
    expect(cov.source).toBe('bus.file.watchState');
    expect(cov.usable).toBe(true);
    tracker.dispose();
  });

  it('io 层：判定器缺席 ⇒ 只读应答仍附 fsFreshness，值 available:false + staleReason（字段不消失）', async () => {
    const { kernel } = makeKernel();
    const deps = fakeIoDeps(kernel, {
      invoke: async (cmd) => (cmd === 'read_file_bytes' ? 'alpha\n' : null),
      // 不给 fsFreshness —— 模拟未装配判定器的宿主。
    });
    const sup = createRunSupplemental(deps);
    const out = (await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(out['path']).toBe('a.kojo');
    expect(ff['available']).toBe(false);
    expect(ff['stale']).toBeNull();
    expect(String(ff['staleReason'])).not.toBe('');
    expect(String(ff['staleReason'])).toContain('未装配');
  });

  it('fsFreshnessAbsentPayload 形状即契约：available:false / stale:null / 非空理由', () => {
    const p = fsFreshnessAbsentPayload('a.kojo', 'file');
    expect(p['available']).toBe(false);
    expect(p['stale']).toBeNull();
    expect(typeof p['staleReason']).toBe('string');
    expect(String(p['staleReason']).length > 0).toBe(true);
  });

  it('项目未开（根基准为空）⇒ snapshot 资源仍带字段：available:false +「没有可判定的绝对路径基准」，不静默', async () => {
    const { kernel } = makeKernel(WATCHING, { projectCurrent: { rootDir: '', adapterId: 'a', kojoPaths: [] } });
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      invoke: async () => null,
      fsFreshness: () => tracker,
    });
    // snapshot 腿不在上游拒绝空根（fileTree/listDir 会），正好钉住 noBase 分支。
    const ioResources = createIoResourceData(deps, () => [], () => 0);
    const snap = (await ioResources(KOJO_RESOURCE_URIS.snapshot, SCOPE_A)) as Record<string, unknown>;
    const ff = snap['fsFreshness'] as Record<string, unknown>;
    expect(ff['available']).toBe(false);
    expect(ff['stale']).toBeNull();
    expect(String(ff['staleReason'])).toContain('没有可判定的绝对路径基准');
    expect(ff['granularity']).toBe('listing');
    tracker.dispose();
  });
});

/* ================================================================== *
 * ③ 自写归因：不推胀自己、推胀别的会话；写腿同栈记账
 * ================================================================== */

describe('③ 自写归因（noteSelfWrite 与写腿同一调用栈）', () => {
  it('本会话自写 + 监视器回声：并条不推序号 ⇒ stale:false，回声不冒充第二次外部改动', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    // B8：窗内的 false 必须由 mtime 复核给（假桥把盘态钉在「就是我们刚写的那一份」：mtime = 自写时刻）
    (kernel.io as unknown as Record<string, unknown>)['stat'] = async () => ({
      exists: true,
      mtimeMs: T0,
      size: 10,
    });
    const tracker = createFsFreshnessTracker(kernel);
    const abs = 'D:\\proj\\a.kojo';
    tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs, kind: 'change', scope: SCOPE_A });
    emitChanged(kernel, abs); // ~200ms 去抖后的监视器回声（同一测试内即时送达，在窗口内）
    // 同步档：窗内命中 ⇒ 复核在途，本档不乐观判 false（B8 之前这里直接谎报 false）
    const pending = tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_A });
    expect(pending.stale).toBeNull();
    // 定档走复核版（同一次读数里等结论）：并条不推序号这条语义一字未变
    const v = await tracker.verdictOfRechecked({ abs, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBe(false);
    expect(v.recheck).toMatchObject({ performed: true, basis: 'mtime-recheck', outcome: 'unchanged' });
    expect(v.changeOrigin).toBe('mcp-write');
    expect(v.changedSincePreviousRead).toBe(0);
    const rep = tracker.report();
    expect(rep.ledger.changes.entries[0]).toMatchObject({ origin: 'mcp-write', events: 2 });
    tracker.dispose();
  });

  it('别的会话经 MCP 写的，对本会话就是外部改动 ⇒ stale:true + origin:mcp-write', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const abs = 'D:\\proj\\a.kojo';
    tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_B }); // B 建基线
    tracker.noteSelfWrite({ abs, kind: 'change', scope: SCOPE_A }); // A 写
    const v = tracker.verdictOf({ abs, rel: 'a.kojo', scope: SCOPE_B });
    expect(v.stale).toBe(true);
    expect(v.changeOrigin).toBe('mcp-write');
    tracker.dispose();
  });

  it('写腿 fileTree.update 同栈记账：落盘成功后写会话再读不判过期，且无新增写命令', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    const written: string[] = [];
    const invokes: string[] = [];
    const tracker = createFsFreshnessTracker(kernel);
    const io = kernel.io as unknown as Record<string, unknown>;
    const statPaths: string[] = [];
    // B8：窗内的 false 必须由 mtime 复核给。假桥把盘态钉成「就是我们刚写那一份」（mtime = 自写时刻），
    // 并记下复核走过哪些路径 —— 只读探针，绝不与 deps.invoke / 任何 Rust 写命令混线。
    io['stat'] = async (abs: string) => {
      statPaths.push(abs);
      return { exists: true, mtimeMs: T0, size: 5 };
    };
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => {
        invokes.push(cmd);
        return cmd === 'stat_file' ? { size: 1, mtimeMs: 1, isDirectory: false } : null;
      },
    });
    // fileTree.update 需要 io.exists / io.writeText 原语（既有写通道，本批零改动）。
    io['exists'] = async () => true;
    io['writeText'] = async (abs: string) => {
      written.push(abs);
      kernel.bus.emit?.('file.changed', { kind: 'change', path: abs }); // 真壳：写后监视器也会回声
    };
    const sup = createRunSupplemental(deps);
    const out = (await sup('fileTree.update', { relPath: 'docs/a.txt', content: 'hello' }, WRITE_SCOPE)) as Record<string, unknown>;
    expect(out['updated']).toBe(true);
    expect(out['refreshed']).toBe(true);
    expect(written).toEqual(['D:/proj/docs/a.txt']); // resolveWriteTarget 归一形态（与 mcp-write-legs 同尺）
    // 不新建写通道：写腿只经既有内核 io 原语落盘，deps.invoke 零触达（更没有任何 Rust 写命令）。
    expect(invokes).toEqual([]);
    // 窗内第一读（同步档）：复核在途 ⇒ null（B8 之前这里直接 false）；定档走复核版
    const pending = tracker.verdictOf({ abs: 'D:\\proj\\docs\\a.txt', rel: 'docs/a.txt', scope: WRITE_SCOPE });
    expect(pending.stale).toBeNull();
    const v = await tracker.verdictOfRechecked({ abs: 'D:\\proj\\docs\\a.txt', rel: 'docs/a.txt', scope: WRITE_SCOPE });
    expect(v.stale).toBe(false);
    // 复核只经内核 io.stat 探针走：deps.invoke 零触达这条一字未动（没有新增任何 Rust 命令）
    expect(statPaths.every((p) => p === 'D:\\proj\\docs\\a.txt')).toBe(true);
    expect(statPaths.length).toBeGreaterThanOrEqual(1);
    expect(invokes).toEqual([]);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ④ scope 透传：两会话基线不串味（钉 buildReadResourceData 的 null→scope 修正）
 * ================================================================== */

describe('④ scope 透传（buildReadResourceData 不再丢会话号）', () => {
  it('同一 resource 两个会话各自基线：B 的首读仍是「没读过」，不继承 A 的基线', async () => {
    const { kernel } = makeKernel();
    const host: McpRealSourceHost = {
      getCommands: () => [],
      getCommandContext: () => ({ project: null }) as never,
      getKernel: () => kernel,
    };
    const sources = await buildRealMcpSources(host, {
      invoke: async () => null,
      searchInFiles: async () => NO_SEARCH,
    });
    const read = sources.readResourceData!;

    const rA1 = (await read(KOJO_RESOURCE_URIS.fileTree, SCOPE_A)) as Record<string, unknown>;
    const ffA1 = rA1['fsFreshness'] as Record<string, unknown>;
    expect(ffA1['available']).toBe(true);
    expect(ffA1['previousReadAtMs']).toBeNull(); // A 的首读：无基线
    expect(String(ffA1['staleReason'])).toContain('没有读过');

    const rB1 = (await read(KOJO_RESOURCE_URIS.fileTree, SCOPE_B)) as Record<string, unknown>;
    const ffB1 = rB1['fsFreshness'] as Record<string, unknown>;
    // 旧实现（`ioResources(uri, null)`）会落到 'unattributed' 共享账：B 的首读将看到 A 的基线时刻。
    expect(ffB1['previousReadAtMs']).toBeNull(); // B 也是首读——会话维度没被抹平
    expect(ffB1['staleReason']).not.toBeNull();

    const rA2 = (await read(KOJO_RESOURCE_URIS.fileTree, SCOPE_A)) as Record<string, unknown>;
    const ffA2 = rA2['fsFreshness'] as Record<string, unknown>;
    expect(ffA2['previousReadAtMs']).toBeTypeOf('number'); // A 的第二次读：见到 A 自己的基线
    expect(Number(ffA2['previousReadAtMs'])).toBeLessThanOrEqual(Number(ffA2['atMs']));
  });

  it('fs.readFile 工具腿同样按会话分账：外部改动只推胀读过的那会话', async () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'read_file_bytes' ? 'text\n' : null),
    });
    const sup = createRunSupplemental(deps);
    await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A);
    emitChanged(kernel, 'D:\\proj\\a.kojo');
    const outA = (await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    expect((outA['fsFreshness'] as Record<string, unknown>)['stale']).toBe(true);
    const outB = (await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_B)) as Record<string, unknown>;
    expect((outB['fsFreshness'] as Record<string, unknown>)['stale']).toBeNull(); // B 没读过
    tracker.dispose();
  });
});

/* ================================================================== *
 * ⑤ 幂等绑定（与事件环同一策略）
 * ================================================================== */

describe('⑤ 幂等绑定：同一内核重复装配不重复订阅', () => {
  it('bindFsFreshness 同内核重复调用返回同一判定器，file.changed 只订阅一次', () => {
    const { kernel, subNames } = makeKernel();
    const t1 = bindFsFreshness(kernel);
    expect(subNames.filter((n) => n === 'file.changed')).toHaveLength(1);
    expect(subNames.filter((n) => n === 'file.watchState')).toHaveLength(1);
    expect(bindFsFreshness(kernel)).toBe(t1);
    expect(subNames.filter((n) => n === 'file.changed')).toHaveLength(1);
    expect(getFsFreshnessTracker()).toBe(t1);
  });

  it('换内核：先退订旧内核的处理器，再订阅新的', () => {
    const k1 = makeKernel();
    const k2 = makeKernel();
    bindFsFreshness(k1.kernel);
    expect(k1.handlerCount('file.changed')).toBe(1);
    bindFsFreshness(k2.kernel);
    expect(k1.handlerCount('file.changed')).toBe(0); // 旧订阅已退掉
    expect(k2.handlerCount('file.changed')).toBe(1);
  });

  it('buildRealMcpSources 重复装配同一内核：总线订阅计数不再增长（事件环 + 失效账都不翻倍）', async () => {
    const { kernel, subNames } = makeKernel();
    const host: McpRealSourceHost = {
      getCommands: () => [],
      getCommandContext: () => ({ project: null }) as never,
      getKernel: () => kernel,
    };
    await buildRealMcpSources(host, { invoke: async () => null, searchInFiles: async () => NO_SEARCH });
    const afterFirst = subNames.length;
    const firstRing = subNames.filter((n) => n === 'file.changed').length;
    await buildRealMcpSources(host, { invoke: async () => null, searchInFiles: async () => NO_SEARCH });
    await buildRealMcpSources(host, { invoke: async () => null, searchInFiles: async () => NO_SEARCH });
    expect(subNames.length).toBe(afterFirst); // 任何一条总线都没多订阅
    expect(subNames.filter((n) => n === 'file.changed').length).toBe(firstRing);
  });
});

/* ================================================================== *
 * ⑥ 账本有界：溢出可见 + 溢出降档
 * ================================================================== */

describe('⑥ 账本有界（无限增长即判不合格）', () => {
  it('改动账溢出：整条淘汰队首 + dropped 计数 + truncated:true；基线早于淘汰序号时判定降为 null', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const watched = 'D:\\proj\\a.kojo';
    tracker.verdictOf({ abs: watched, rel: 'a.kojo', scope: SCOPE_A }); // 基线 seq 很小
    // 灌入超过容量的独立路径事件，把基线之后与之前的条目都挤出去。
    for (let i = 0; i < CHANGE_LEDGER_CAPACITY + 500; i += 1) {
      emitChanged(kernel, `D:\\proj\\f${i}.csv`);
    }
    const rep = tracker.report({ maxEntries: 100 });
    expect(rep.ledger.changes.size).toBe(CHANGE_LEDGER_CAPACITY);
    expect(rep.ledger.changes.dropped).toBe(500);
    expect(rep.ledger.changes.truncated).toBe(true);
    expect(rep.ledger.changes.listed).toBeLessThanOrEqual(100);
    // 溢出反过来降低判定强度：无法证明「之后没改过」⇒ null，不是 false。
    const v = tracker.verdictOf({ abs: watched, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(String(v.staleReason)).toContain('淘汰');
    tracker.dispose();
  });

  it('读取账溢出：被挤掉的条目报「不是没读过」；evictedKeys 记忆也有界', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const first = 'D:\\proj\\first.kojo';
    tracker.verdictOf({ abs: first, rel: 'first.kojo', scope: SCOPE_A });
    for (let i = 0; i < READ_LEDGER_CAPACITY + 1; i += 1) {
      tracker.verdictOf({ abs: `D:\\proj\\r${i}.kojo`, rel: `r${i}.kojo`, scope: SCOPE_A });
    }
    const rep = tracker.report();
    expect(rep.ledger.reads.size).toBe(READ_LEDGER_CAPACITY);
    expect(rep.ledger.reads.truncated).toBe(true);
    const v = tracker.verdictOf({ abs: first, rel: 'first.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(String(v.staleReason)).toContain('不是「没读过」');
    expect(rep.ledger.evictedKeys.reads).toBeGreaterThan(0);
    expect(rep.ledger.evictedKeys.truncated).toBe(false); // 远小于 512 上限
    tracker.dispose();
  });

  it('自写归因账同样有界（容量 = CHANGE_LEDGER_CAPACITY，不留无限 Map）', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    for (let i = 0; i < CHANGE_LEDGER_CAPACITY + 10; i += 1) {
      tracker.noteSelfWrite({ abs: `D:\\proj\\w${i}.kojo`, kind: 'change', scope: SCOPE_A });
    }
    const rep = tracker.report();
    expect(rep.counters.selfWritesSeen).toBe(CHANGE_LEDGER_CAPACITY + 10);
    expect(rep.ledger.changes.size).toBeLessThanOrEqual(CHANGE_LEDGER_CAPACITY);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ⑦ 第 9 项 resource：kojo://project/fs-freshness
 * ================================================================== */

describe('⑦ kojo://project/fs-freshness：宿主侧追加的第 9 项 resource', () => {
  it('uri/mimeType 自述 + 冻结契约表 8 条零改动 + registry 追加到 9 项', async () => {
    const { kernel } = makeKernel();
    const tracker = bindFsFreshness(kernel);
    const deps = fakeIoDeps(kernel, { fsFreshness: () => tracker });
    const resource = createFsFreshnessResource(deps);
    expect(resource.uri).toBe('kojo://project/fs-freshness');
    expect(resource.mimeType).toBe('application/json');
    expect(KOJO_RESOURCE_URIS.fsFreshness).toBe(resource.uri);

    const reg = createMcpCapabilityRegistry({ resources: [resource] });
    const uris = reg.listResources().map((r) => r.uri);
    expect(uris).toHaveLength(MCP_RESOURCE_SPECS.length + 1);
    for (const spec of MCP_RESOURCE_SPECS) expect(uris).toContain(spec.uri);
    expect(uris).toContain(resource.uri);
  });

  it('读回报：能力面自述与 Rust server_capabilities 一致（subscribe/listChanged 都是 false），账目与 truncated 一致', async () => {
    const { kernel } = makeKernel();
    const tracker = bindFsFreshness(kernel);
    const deps = fakeIoDeps(kernel, { fsFreshness: () => tracker });
    const resource = createFsFreshnessResource(deps);

    tracker.verdictOf({ abs: 'D:\\proj\\a.kojo', rel: 'a.kojo', scope: SCOPE_A });
    emitChanged(kernel, 'D:\\proj\\a.kojo');

    const res = await resource.read(SCOPE_A);
    expect(res.contents).toHaveLength(1);
    expect(res.contents[0]!.uri).toBe(resource.uri);
    const text = res.contents[0]!.text;
    expect(text.length).toBeLessThanOrEqual(RESOURCE_TEXT_LIMIT);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const push = parsed['push'] as Record<string, unknown>;
    expect(push['subscribe']).toBe(false);
    expect(push['listChanged']).toBe(false);
    expect(push['notificationsResourcesUpdated']).toBe(false);
    expect(push['mode']).toBe('on-request');
    expect(String(push['reason'])).toContain('推不出去');
    const watch = parsed['watch'] as Record<string, unknown>;
    expect(watch['status']).toBe('watching');
    expect(watch['roots']).toEqual(['D:\\proj']);
    const sources = parsed['sources'] as Record<string, unknown>;
    expect(sources['fileChangedSubscribed']).toBe(true);
    expect(sources['watchStateSubscribed']).toBe(true);
    const ledger = parsed['ledger'] as Record<string, unknown>;
    const changes = ledger['changes'] as Record<string, unknown>;
    expect(changes['capacity']).toBe(CHANGE_LEDGER_CAPACITY);
    expect(changes['dropped']).toBe(0);
    // truncated 账一致：truncated 当且仅当 dropped>0。
    expect(changes['truncated']).toBe(Number(changes['dropped']) > 0);
    expect((parsed['annotatedTools'] as string[]).length).toBeGreaterThanOrEqual(1);
    expect((parsed['annotatedTools'] as string[])).toContain('fs.readFile');
    const notAnnotated = parsed['notAnnotated'] as { target: string; reason: string }[];
    expect(notAnnotated.length).toBeGreaterThan(0);
    for (const n of notAnnotated) {
      expect(typeof n.target).toBe('string');
      expect(n.target.length).toBeGreaterThan(0);
      expect(n.reason.length).toBeGreaterThan(0);
    }
    const session = parsed['session'] as Record<string, unknown>;
    expect(session['sessionKey']).toBe('sess-A');
    expect((session['entries'] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('账溢出时资源读数照样带 truncated:true + dropped 计数（可见不静默）', async () => {
    const { kernel } = makeKernel();
    const tracker = bindFsFreshness(kernel);
    for (let i = 0; i < CHANGE_LEDGER_CAPACITY + 300; i += 1) {
      emitChanged(kernel, `D:\\proj\\p${i}.csv`);
    }
    const deps = fakeIoDeps(kernel, { fsFreshness: () => tracker });
    const resource = createFsFreshnessResource(deps);
    const text = (await resource.read(SCOPE_A)).contents[0]!.text;
    const parsed = JSON.parse(text) as { ledger: { changes: { truncated: boolean; dropped: number; size: number; listed: number } } };
    expect(parsed.ledger.changes.truncated).toBe(true);
    expect(parsed.ledger.changes.dropped).toBe(300);
    expect(parsed.ledger.changes.size).toBe(CHANGE_LEDGER_CAPACITY);
    expect(parsed.ledger.changes.listed).toBeLessThanOrEqual(50);
  });

  it('判定器未装配 ⇒ 资源读显式 RESOURCE_UNAVAILABLE（不返回空账冒充一切正常）', async () => {
    const deps = fakeIoDeps(null, { fsFreshness: () => null });
    const resource = createFsFreshnessResource(deps);
    await expect(resource.read(SCOPE_A)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });
});

/* ================================================================== *
 * ⑧ 只读腿覆盖面：fs.stat / statFiles / listDir / snapshot / searchAll 都带标注
 * ================================================================== */

describe('⑧ 覆盖面：所有盘上真源只读腿都附 fsFreshness', () => {
  async function readLegs(name: 'fs.stat' | 'io.listDir' | 'workspace.searchAll') {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => {
        if (cmd === 'stat_file') return { size: 2, mtimeMs: 5, isDirectory: false };
        if (cmd === 'list_dir') return [{ name: 'a.kojo', path: 'D:\\proj\\a.kojo', isDirectory: false }];
        return null;
      },
    });
    const sup = createRunSupplemental(deps);
    if (name === 'fs.stat') {
      const out = (await sup(name, { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
      expect(out['exists']).toBe(true);
      expect((out['fsFreshness'] as Record<string, unknown>)['granularity']).toBe('file');
    } else if (name === 'io.listDir') {
      const out = (await sup(name, { relPath: 'docs' }, SCOPE_A)) as Record<string, unknown>;
      expect((out['fsFreshness'] as Record<string, unknown>)['granularity']).toBe('listing');
    } else {
      const out = (await sup(name, { query: 'abc' }, SCOPE_A)) as Record<string, unknown>;
      expect((out['fsFreshness'] as Record<string, unknown>)['granularity']).toBe('listing');
    }
    tracker.dispose();
  }

  it('fs.stat / io.listDir / workspace.searchAll 三腿各自带粒度正确的标注', async () => {
    await readLegs('fs.stat');
    await readLegs('io.listDir');
    await readLegs('workspace.searchAll');
  });

  it('fs.statFiles 逐项标注用请求侧路径为基准（Rust 不回显 path 也不猜）', async () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) =>
        cmd === 'stat_files'
          ? [{ exists: true, size: 1, mtimeMs: 2 }, { exists: false }] // 两条都不回显 path
          : null,
    });
    const sup = createRunSupplemental(deps);
    const out = (await sup('fs.statFiles', { relPaths: ['a.kojo', 'b.kojo'] }, SCOPE_A)) as Record<string, unknown>;
    const items = out['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    const ff0 = items[0]!['fsFreshness'] as Record<string, unknown>;
    expect(ff0['available']).toBe(true);
    expect(ff0['target']).toBe('a.kojo');
    const ff1 = items[1]!['fsFreshness'] as Record<string, unknown>;
    expect(ff1['target']).toBe('b.kojo');
    tracker.dispose();
  });

  it('kojo://project/snapshot 资源带根级 listing 标注', async () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, { fsFreshness: () => tracker });
    const ioResources = createIoResourceData(deps, () => [], () => 0);
    const snap = (await ioResources(KOJO_RESOURCE_URIS.snapshot, SCOPE_A)) as Record<string, unknown>;
    const ff = snap['fsFreshness'] as Record<string, unknown>;
    expect(ff['granularity']).toBe('listing');
    expect(ff['available']).toBe(true);
    tracker.dispose();
  });

  it('kernelIo.fileTree 腿（工具 projectFileTree 与 resource 同源）带 listing 标注', async () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, { fsFreshness: () => tracker });
    const io = createKernelIo(deps);
    const tree = (await io.fileTree({ maxDepth: 1 }, SCOPE_A)) as Record<string, unknown>;
    expect(Array.isArray(tree['entries'])).toBe(true);
    const ff = tree['fsFreshness'] as Record<string, unknown>;
    expect(ff['granularity']).toBe('listing');
    expect(ff['tracked']).toBe(true);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ⑨ B13：只读腿改走**读时复核**——窗内命中本次读数即定档，不再回「复核在途」的 null；
 *   窗外与判不了继续如实（null + 理由，绝不乐观 false、绝不白付 syscall）
 * ================================================================== */

describe('⑨ B13 只读腿定档（fs.readFile / fs.stat / io.listDir 走 verdictOfRechecked / listingOfRechecked）', () => {
  it('fs.readFile：窗内自写回声 + 复核证明没变 ⇒ 本次读数 stale:false + recheck.basis mtime-recheck（B13 之前这格是 null「在途」）；窗外首读零探针', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    const stat = vi.fn(async () => ({ exists: true, mtimeMs: T0, size: 10 }));
    (kernel.io as unknown as Record<string, unknown>)['stat'] = stat;
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'read_file_bytes' ? 'alpha\n' : null),
    });
    const sup = createRunSupplemental(deps);
    // 第一读：建基线档，没有窗内回声记忆 ⇒ 一个探针 syscall 都不许多付。
    const first = (await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    expect((first['fsFreshness'] as Record<string, unknown>)['stale']).toBeNull(); // 首读无基线，如实 null
    expect(stat).toHaveBeenCalledTimes(0);
    // 自写 + 监视器回声（并条不推序号——正是 B8 收口的那格假阴性）
    tracker.noteSelfWrite({ abs: 'D:\\proj\\a.kojo', kind: 'change', scope: SCOPE_A });
    emitChanged(kernel, 'D:\\proj\\a.kojo');
    stat.mockClear();
    // B13：同一次读数里就定档——复核证明没变 ⇒ false（B13 之前这里是 stale:null「复核在途」）
    const second = (await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    const ff = second['fsFreshness'] as Record<string, unknown>;
    expect(ff['stale']).toBe(false);
    expect(ff['recheck']).toMatchObject({ performed: true, basis: 'mtime-recheck', outcome: 'unchanged' });
    // 单目标按契约走单路径 stat（N=1 不凑批量）
    expect(stat).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('fs.stat：窗内确有后续真实外部写（监视回执故意不发）⇒ 本次读数 stale:true，复核把它推进改动账', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    let diskMtime = T0;
    (kernel.io as unknown as Record<string, unknown>)['stat'] = async () => ({
      exists: true,
      mtimeMs: diskMtime,
      size: 10,
    });
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'stat_file' ? { size: 10, mtimeMs: diskMtime, isDirectory: false } : null),
    });
    const sup = createRunSupplemental(deps);
    await sup('fs.stat', { relPath: 'a.kojo' }, SCOPE_A); // 基线
    tracker.noteSelfWrite({ abs: 'D:\\proj\\a.kojo', kind: 'change', scope: SCOPE_A });
    diskMtime = T0 + 3_000; // 窗内真外部写：没有 file.changed 事件，只有盘态证据
    const out = (await sup('fs.stat', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(ff['stale']).toBe(true);
    expect(ff['recheck']).toMatchObject({ performed: true, basis: 'mtime-recheck', outcome: 'changed' });
    expect(ff['changeOrigin']).toBe('unattributed');
    tracker.dispose();
  });

  it('fs.readFile：注入面没有 stat 通道 ⇒ 窗内命中仍如实 stale:null +「无从复核」，绝不乐观 false', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel(); // makeKernel 的 io 只有 walkDir：探针通道缺席
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'read_file_bytes' ? 'alpha\n' : null),
    });
    const sup = createRunSupplemental(deps);
    await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A);
    tracker.noteSelfWrite({ abs: 'D:\\proj\\a.kojo', kind: 'change', scope: SCOPE_A });
    const out = (await sup('fs.readFile', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(ff['stale']).toBeNull();
    expect(String(ff['staleReason'])).toContain('复核');
    expect(ff['recheck']).toMatchObject({ basis: 'recheck-unavailable', outcome: 'unknown' });
    tracker.dispose();
  });

  it('io.listDir（listing 腿）：窗内目录下有真实外部写 ⇒ 本次读数 stale:true（复核核的是窗内自写回声候选）', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    (kernel.io as unknown as Record<string, unknown>)['stat'] = async () => ({
      exists: true,
      mtimeMs: T0 + 999,
      size: 10,
    });
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) =>
        cmd === 'list_dir' ? [{ name: 'a.kojo', path: 'D:\\proj\\a.kojo', isDirectory: false }] : null,
    });
    const sup = createRunSupplemental(deps);
    await sup('io.listDir', {}, SCOPE_A); // 根级基线
    tracker.noteSelfWrite({ abs: 'D:\\proj\\a.kojo', kind: 'change', scope: SCOPE_A });
    const out = (await sup('io.listDir', {}, SCOPE_A)) as Record<string, unknown>;
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(ff['granularity']).toBe('listing');
    expect(ff['stale']).toBe(true);
    expect(ff['recheck']).toMatchObject({ performed: true, outcome: 'changed' });
    tracker.dispose();
  });

  it('fs.statFiles 200 条全命中窗内 ⇒ 逐条标注只付一趟批量复核（statFiles 恰 1 次、stat 0 次），无标注器时零探针', async () => {
    vi.useFakeTimers({ now: T0 }); // 回声窗与 mtime 判据都要确定性墙钟
    const { kernel } = makeKernel();
    const rels = Array.from({ length: 200 }, (_, i) => `f${i}.kojo`);
    const absOf = (rel: string) => `D:\\proj\\${rel}`;
    const stat = vi.fn(async () => ({ exists: true, mtimeMs: T0 - 5_000, size: 4 }));
    const statFiles = vi.fn(async (paths: readonly string[]) =>
      paths.map(() => ({ exists: true, mtimeMs: T0 - 5_000, size: 4 })),
    );
    (kernel.io as unknown as Record<string, unknown>)['stat'] = stat;
    (kernel.io as unknown as Record<string, unknown>)['statFiles'] = statFiles;
    const tracker = createFsFreshnessTracker(kernel);
    const deps = fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd, args) =>
        cmd === 'stat_files'
          ? ((args?.['paths'] as string[]) ?? []).map((p) => ({ path: p, exists: true, size: 4, mtimeMs: T0 - 5_000 }))
          : null,
    });
    const sup = createRunSupplemental(deps);
    // 第一趟：没有窗内回声记忆 ⇒ 批量复核一枚探针都不发。
    await sup('fs.statFiles', { relPaths: rels }, SCOPE_A);
    expect(stat).toHaveBeenCalledTimes(0);
    expect(statFiles).toHaveBeenCalledTimes(0);
    for (const rel of rels) tracker.noteSelfWrite({ abs: absOf(rel), kind: 'change', scope: SCOPE_A });
    stat.mockClear();
    statFiles.mockClear();
    const out = (await sup('fs.statFiles', { relPaths: rels }, SCOPE_A)) as Record<string, unknown>;
    const items = out['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(200);
    // **一趟证明**：200 条命中窗内只并成一趟批量 statFiles；单路径 stat 一枚不发。
    expect(statFiles).toHaveBeenCalledTimes(1);
    expect(statFiles.mock.calls[0]![0]).toHaveLength(200);
    expect(stat).toHaveBeenCalledTimes(0);
    for (const item of items) {
      const ff = item['fsFreshness'] as Record<string, unknown>;
      expect(ff['stale']).toBe(false); // 复核证明没变 ⇒ 逐条定档（不是「在途」null）
      expect((ff['recheck'] as Record<string, unknown>)['basis']).toBe('mtime-recheck');
    }
    tracker.dispose();
  });
});

/* ================================================================== *
 * ⑩ S11 覆盖收口（BOARD 卡 MCP-PERF-S11）：全 82 面（read 40 / edit 13 / privileged 29）
 *   的 fsFreshness 覆盖矩阵盘点结论——
 *
 *   【已带 B13 异步复核入口（10 工具面 + 3 资源；既有面本批零行为变化，只补测试钉）】
 *     fs.readFile(file) / fs.stat(file) / fs.statFiles(逐项·一趟 verdictsOfRechecked) /
 *     fs.readMany(逐项·一趟) / fs.readRange(file·S4 已接线，本批只补 annotatedTools 名单+钉) /
 *     io.listDir(listing) / fs.tree＝projectFileTree+kojo://project/file-tree(listing) /
 *     search.all(listing·根) / workspace.searchAll(listing·根) /
 *     kojo://project/snapshot(listing·根) / kojo://project/fs-freshness(本体)
 *   【缺覆盖 → 本批补腿（2 面）】
 *     fs.pathExists —— 盘读面（path_exists），应答原本零 fsFreshness ⇒ 补 file 档（单路径 ≤1 趟 stat）
 *     semantic.projectSymbols —— 全项目盘扫描产物（erb.parser byName 索引）的清单面 ⇒
 *       补根级 listing 档；窗内多候选恰 1 趟 statFiles、0 次单 stat
 *   【盘点裁定不补（点名，非「盘上真源」读腿）】
 *     semantic.batchAt 与单枚面 definitionAt/referencesAt 同一条 model+判据腿（编辑器模型 +
 *     内存索引，零盘读）；把模型读记成盘基线会污染 fs.readFile / fs.stat 的判定 ⇒ 依
 *     NOT_ANNOTATED 纪律点名进 report.notAnnotated，盘-缓冲差由编辑器自己说。其余：
 *     semantic 7 单枚面 / lang.* 六枚 / problems.diagnostics / document.active / editor.info·
 *     cursor·selfCheck（编辑器态）、commands.list / io.workspaceRoots / project.info（载荷摘要）、
 *     app.dataDir / codec.encodeString / tasks.status（内核态）、diff.compare / state.replay /
 *     preview.document（未接线 NOT_WIRED）、launcher 只读 13 枚（privileged·启动器态）。
 * ================================================================== */

describe('⑩ S11 覆盖收口：fs.pathExists / semantic.projectSymbols 补腿 + fs.readRange 名单收口', () => {
  const SYM_DEFS = [{ name: 'DRAW_FACE', filePath: 'D:\\proj\\a.erb', startLine: 10, endLine: 20 }];
  /** 给假内核挂 erb.parser 索引假件（byName.forEachDef 逐定义回调，照 mcp-range-outline 同尺）。 */
  function symKernel(kernel: McpKernelLike): void {
    (kernel.services as unknown as { tryGet: (k: string) => unknown }).tryGet = (key: string) =>
      key === 'erb.parser'
        ? {
            currentIndex: () => ({
              byName: {
                forEachDef: (cb: (ref: Record<string, unknown>, normalized: string) => void) => {
                  for (const d of SYM_DEFS) cb(d, String(d['name']).toUpperCase());
                },
              },
            }),
            indexState: () => ({ phase: 'ready' }),
          }
        : undefined;
  }

  it('fs.pathExists：应答附 fsFreshness（file 档）；判定器缺席字段照样在场（available:false，铁律 4）', async () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'path_exists' ? true : null),
    }));
    const out = (await sup('fs.pathExists', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    expect(out['exists']).toBe(true);
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(ff['available']).toBe(true);
    expect(ff['granularity']).toBe('file');
    expect(ff['target']).toBe('a.kojo');
    tracker.dispose();
    const bare = (await createRunSupplemental(fakeIoDeps(kernel, {
      invoke: async (cmd) => (cmd === 'path_exists' ? false : null),
    }))('fs.pathExists', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    const ff2 = bare['fsFreshness'] as Record<string, unknown>;
    expect(ff2['available']).toBe(false);
    expect(ff2['stale']).toBeNull();
    expect(String(ff2['staleReason'])).not.toBe('');
  });

  it('fs.pathExists（file 档）：窗内自写回声命中 ⇒ 恰 1 趟单路径 stat 定档；窗外首读零探针', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    const stat = vi.fn(async () => ({ exists: true, mtimeMs: T0, size: 10 }));
    (kernel.io as unknown as Record<string, unknown>)['stat'] = stat;
    const tracker = createFsFreshnessTracker(kernel);
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'path_exists' ? true : null),
    }));
    const first = (await sup('fs.pathExists', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    expect(((first['fsFreshness'] as Record<string, unknown>)['recheck'] ?? null)).toBeNull();
    expect(stat).toHaveBeenCalledTimes(0);
    tracker.noteSelfWrite({ abs: 'D:\\proj\\a.kojo', kind: 'change', scope: SCOPE_A });
    stat.mockClear();
    const second = (await sup('fs.pathExists', { relPath: 'a.kojo' }, SCOPE_A)) as Record<string, unknown>;
    const ff = second['fsFreshness'] as Record<string, unknown>;
    expect(ff['stale']).toBe(false);
    expect(ff['recheck']).toMatchObject({ performed: true, basis: 'mtime-recheck', outcome: 'unchanged' });
    expect(stat).toHaveBeenCalledTimes(1); // 单文件面 ≤1 趟 stat
    tracker.dispose();
  });

  it('semantic.projectSymbols：应答附 fsFreshness（根级 listing，tracked）；判定器缺席字段照样在场', async () => {
    const { kernel } = makeKernel();
    symKernel(kernel);
    const tracker = createFsFreshnessTracker(kernel);
    const sup = createRunSupplemental(fakeIoDeps(kernel, { fsFreshness: () => tracker }));
    const out = (await sup('semantic.projectSymbols', {}, SCOPE_A)) as Record<string, unknown>;
    expect(out['total']).toBe(1);
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(ff['available']).toBe(true);
    expect(ff['granularity']).toBe('listing');
    expect(ff['target']).toBe('.');
    expect(ff['tracked']).toBe(true);
    tracker.dispose();
    const bare = (await createRunSupplemental(fakeIoDeps(kernel))('semantic.projectSymbols', {}, SCOPE_A)) as Record<string, unknown>;
    const ff2 = bare['fsFreshness'] as Record<string, unknown>;
    expect(ff2['available']).toBe(false);
    expect(ff2['stale']).toBeNull();
  });

  it('semantic.projectSymbols（listing 档）：窗内 3 条自写全落根下 ⇒ 恰 1 趟 statFiles、0 次单 stat，本次读数 stale:true', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    symKernel(kernel);
    const stat = vi.fn(async () => ({ exists: true, mtimeMs: T0, size: 10 }));
    const statFiles = vi.fn(async (paths: readonly string[]) =>
      paths.map(() => ({ exists: true, mtimeMs: T0 + 2_000, size: 11 })),
    );
    (kernel.io as unknown as Record<string, unknown>)['stat'] = stat;
    (kernel.io as unknown as Record<string, unknown>)['statFiles'] = statFiles;
    const tracker = createFsFreshnessTracker(kernel);
    const sup = createRunSupplemental(fakeIoDeps(kernel, { fsFreshness: () => tracker }));
    await sup('semantic.projectSymbols', {}, SCOPE_A); // 基线：无窗内记忆 ⇒ 零探针
    expect(stat).toHaveBeenCalledTimes(0);
    expect(statFiles).toHaveBeenCalledTimes(0);
    for (const rel of ['a.erb', 'b.erb', 'c.erb']) {
      tracker.noteSelfWrite({ abs: `D:\\proj\\${rel}`, kind: 'change', scope: SCOPE_A });
    }
    stat.mockClear();
    statFiles.mockClear();
    const out = (await sup('semantic.projectSymbols', {}, SCOPE_A)) as Record<string, unknown>;
    const ff = out['fsFreshness'] as Record<string, unknown>;
    expect(ff['granularity']).toBe('listing');
    expect(ff['stale']).toBe(true); // 复核核出的真实外部写已推进改动账
    expect(ff['recheck']).toMatchObject({ performed: true, outcome: 'changed', trips: 1, batched: true });
    expect(statFiles).toHaveBeenCalledTimes(1);
    expect((statFiles.mock.calls[0]![0] as readonly string[]).length).toBe(3);
    expect(stat).toHaveBeenCalledTimes(0);
    tracker.dispose();
  });

  it('fs.readRange（S4 既有接线，本批补钉）：file 档；窗内命中恰 1 趟单路径 stat，窗外首读零探针', async () => {
    vi.useFakeTimers({ now: T0 });
    const { kernel } = makeKernel();
    const stat = vi.fn(async () => ({ exists: true, mtimeMs: T0, size: 10 }));
    (kernel.io as unknown as Record<string, unknown>)['stat'] = stat;
    const tracker = createFsFreshnessTracker(kernel);
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      fsFreshness: () => tracker,
      invoke: async (cmd) => (cmd === 'read_file_bytes' ? 'alpha\nbeta\n' : null),
    }));
    const first = (await sup('fs.readRange', { relPath: 'a.kojo', startLine: 1, endLine: 2 }, SCOPE_A)) as Record<string, unknown>;
    const ff1 = first['fsFreshness'] as Record<string, unknown>;
    expect(ff1['granularity']).toBe('file');
    expect(ff1['recheck'] ?? null).toBeNull();
    expect(stat).toHaveBeenCalledTimes(0);
    tracker.noteSelfWrite({ abs: 'D:\\proj\\a.kojo', kind: 'change', scope: SCOPE_A });
    stat.mockClear();
    const second = (await sup('fs.readRange', { relPath: 'a.kojo', startLine: 1, endLine: 2 }, SCOPE_A)) as Record<string, unknown>;
    const ff = second['fsFreshness'] as Record<string, unknown>;
    expect(ff['stale']).toBe(false);
    expect(ff['recheck']).toMatchObject({ performed: true, basis: 'mtime-recheck', outcome: 'unchanged' });
    expect(stat).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('账本自述收口：annotatedTools 补 S11 三条；notAnnotated 点名 semantic 模型读面（盘点裁定 batchAt 同类，不冒充盘态判定）', () => {
    const { kernel } = makeKernel();
    const tracker = createFsFreshnessTracker(kernel);
    const rep = tracker.report();
    expect(rep.annotatedTools).toContain('fs.readRange');
    expect(rep.annotatedTools).toContain('fs.pathExists');
    expect(rep.annotatedTools).toContain('semantic.projectSymbols（根级 listing）');
    const targets = rep.notAnnotated.map((n) => n.target).join('\n');
    expect(targets).toContain('semantic.batchAt');
    for (const n of rep.notAnnotated) expect(n.reason).not.toBe('');
    tracker.dispose();
  });
});
