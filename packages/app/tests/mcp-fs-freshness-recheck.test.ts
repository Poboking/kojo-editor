/**
 * B8：`fsFreshness` 假阴性收口——**按需 mtime 复核**（BOARD 卡 MCP-WAVE4-RESIDUE-C 余项③ 在册不足）。
 *
 * 被修的假阴性（改前真实现状）：余项③ 把「外部改盘」感知做成只读应答附 `fsFreshness`，
 * 判定基线用**单调序号**；但 MCP 自写后 5 秒回声窗内，同路径的**真实外部写**会被并条、
 * 不推序号（`fs-freshness.ts` 的 `onChangeEvent` 并条分支）⇒ 下一次读它谎报 `stale:false`。
 *
 * 出路（本批判据）：窗内且路径命中时多走**一趟真 stat**（真源 = `@kojo/plugin-api` FileIO
 * 契约的 `stat` / `statFiles`，只读、不受写允许域约束）把「序号没推」证伪或证实：
 * - 复核发现盘态（mtime/size）晚于自写回声基线 ⇒ 那笔外部写**推进改动账**、归因
 *   `unattributed`（不能证明是谁写的），判定 `stale:true`；
 * - 复核证明没变 ⇒ `stale:false`，并由 `recheck` 字段说清这格 false 是**复核**给的
 *   （与「监视没报到」那档可区分）；
 * - 复核做不了（seam 缺席 / stat 抛错 / `mtimeMs:null`）或在途 ⇒ 一律 `stale:null` +
 *   `staleReason`，**绝不乐观 false、绝不 true 乱报、绝不抛**（铁律 4）；
 * - 成本可证：窗外 / 非同路径 / 判定已 true 或 null ⇒ **零额外 syscall**；
 *   一次读数里 N 个路径命中 ⇒ **只发一趟** `statFiles`（`plugin-api/src/io.ts:197` 口径反读）。
 *
 * 全程假桥（盘态 Map + 计数代理），不起 GUI / Tauri / HTTP；监视回执按用例需要**故意不发**，
 * 因为本批要钉的正是「事件没来、只有盘上有证据」这一档。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathKey } from '@kojo/plugin-api';
import type { McpSessionScope } from '@kojo/mcp-host';
import {
  CHANGE_LEDGER_CAPACITY,
  READ_LEDGER_CAPACITY,
  SELF_WRITE_ECHO_WINDOW_MS,
  createFsFreshnessTracker,
  fsFreshnessPayload,
  resetFsFreshnessForTest,
  type FsFreshnessKernelLike,
  type FsFreshnessProbe,
} from '../src/mcp/fs-freshness';

/* ------------------------------- 假件：可改盘态 + 计数代理 ------------------------------- */

const T0 = Date.parse('2026-11-06T12:00:00Z');
const PROJ = 'D:\\proj';
const P1 = `${PROJ}\\a.kojo`;
const P2 = `${PROJ}\\b.kojo`;
const P3 = `${PROJ}\\c.kojo`;
const P4 = `${PROJ}\\sub\\d.kojo`;

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

/** 盘态：探针读数 / `null`（= 不存在，FileIO.stat 的契约形态）/ `'throw'`（stat 本身炸）。 */
type DiskState = FsFreshnessProbe | null | 'throw';

interface RecheckFake {
  readonly kernel: FsFreshnessKernelLike;
  /** 代理计数（本批判据的核心账：谁在什么时候多付了 syscall）。 */
  readonly calls: {
    stat: string[];
    statFiles: string[][];
  };
  setDisk(abs: string, state: DiskState): void;
  diskOf(abs: string): DiskState | undefined;
}

function probe(mtimeMs: number | null, size: number | null = 10, exists = true): FsFreshnessProbe {
  return { exists, mtimeMs, size };
}

function present(mtimeMs: number, size = 10): DiskState {
  return probe(mtimeMs, size, true);
}

function absent(): DiskState {
  return probe(null, null, false);
}

/**
 * 建一台带 stat/statFiles 代理的假内核。
 * `seam`：`'both'` = stat + statFiles 都在；`'stat-only'` = 只有单路径；`'none'` = 注入面缺席。
 */
function makeRecheckKernel(
  initial: Record<string, DiskState> = {},
  opts: {
    readonly seam?: 'both' | 'stat-only' | 'none';
    readonly watch?: { status: string; roots: readonly string[]; failures: readonly { root: string; reason: string }[] };
  } = {},
): RecheckFake {
  const seam = opts.seam ?? 'both';
  const watch = opts.watch ?? { status: 'watching', roots: [PROJ], failures: [] };
  const disk = new Map<string, { readonly raw: string; readonly state: DiskState }>();
  for (const [raw, state] of Object.entries(initial)) disk.set(pathKey(raw), { raw, state });
  const calls = { stat: [] as string[], statFiles: [] as string[][] };
  const handlers = new Map<string, Array<(payload: unknown) => void>>();

  const readOne = (abs: string): FsFreshnessProbe | null => {
    const hit = disk.get(pathKey(abs));
    if (hit === undefined) return null; // 桥没这条 = 盘上没有
    if (hit.state === 'throw') throw new Error('假桥：stat 失败（权限/占用）');
    return hit.state;
  };

  const io: Record<string, unknown> = {
    walkDir: async () => [],
  };
  if (seam === 'both' || seam === 'stat-only') {
    io['stat'] = async (abs: string) => {
      calls.stat.push(abs);
      return readOne(abs);
    };
  }
  if (seam === 'both') {
    io['statFiles'] = async (paths: readonly string[]) => {
      calls.statFiles.push([...paths]);
      return paths.map((p) => {
        const hit = disk.get(pathKey(p));
        if (hit === undefined || hit.state === null) return null;
        if (hit.state === 'throw') return probe(null, null, false); // 批量语义：逐条失败不抛整批
        return hit.state;
      });
    };
  }

  const kernel = {
    project: { current: () => ({ rootDir: PROJ, adapterId: 'adapter-a', kojoPaths: [] }) },
    io,
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_key: string) => undefined as T | undefined },
    slots: { query: () => [] },
    bus: {
      on(name: string, cb: (payload: unknown) => void): () => void {
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
    fileWatch: { state: () => watch },
  } as unknown as FsFreshnessKernelLike;

  return {
    kernel,
    calls,
    setDisk: (abs, state) => disk.set(pathKey(abs), { raw: abs, state }),
    diskOf: (abs) => disk.get(pathKey(abs))?.state,
  };
}

/** 走既有总线广播改动事件（与真壳监视器去抖后的回执同形；本批用例只在需要「回声」时用）。 */
function emitChanged(fake: RecheckFake, path: string, kind = 'change'): void {
  (fake.kernel.bus as unknown as { emit: (n: string, p: unknown) => void }).emit('file.changed', { kind, path });
}

function totalStatCalls(fake: RecheckFake): number {
  return fake.calls.stat.length + fake.calls.statFiles.reduce((n, chunk) => n + chunk.length, 0);
}

afterEach(() => {
  resetFsFreshnessForTest();
  vi.useRealTimers();
});

/* ================================================================== *
 * ① 假阴性主用例（先红的那一条）：窗内真实外部写 ⇒ 复核后 stale:true
 * ================================================================== */

describe('① B8 假阴性收口：窗内真实外部写（监视回执故意不发）被 mtime 复核钉住', () => {
  it('自写 → 窗内外部真写（无 file.changed）→ 读：stale:true + 那笔外部写进改动账且归因可见', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0 - 500) });
    const tracker = createFsFreshnessTracker(fake.kernel);

    // 基线读数：此刻没有自写回声记忆 ⇒ 一次 stat 都不许多付（成本判据的起点）。
    const base = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(base.stale).toBeNull(); // 首读无基线
    expect(fake.calls.stat).toEqual([]);
    expect(fake.calls.statFiles).toEqual([]);

    // MCP 自己写它：回声窗打开（盘态 = 我们的写）。
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    fake.setDisk(P1, present(T0, 10));

    // 窗内的真实外部写：假桥改 mtime/size，**监视回执故意不发**——这正是旧实现谎报 false 的那一格。
    fake.setDisk(P1, present(T0 + 1_500, 999));

    const v = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.available).toBe(true);
    expect(v.stale).toBe(true);
    expect(v.staleReason).toBeNull();
    expect(v.changeOrigin).toBe('unattributed'); // 不能证明是谁写的 ⇒ 如实 unattributed
    expect(v.changeKind).toBe('change');
    expect(v.changedSincePreviousRead).toBe(1);
    expect(v.recheck).toMatchObject({
      performed: true,
      basis: 'mtime-recheck',
      outcome: 'changed',
      targets: 1,
      trips: 1,
      batched: false,
    });
    expect(v.recheck?.probes).toEqual([
      expect.objectContaining({ path: P1, exists: true, mtimeMs: T0 + 1_500, size: 999, outcome: 'changed' }),
    ]);
    // 只多付了一趟单路径 stat（窗内命中 1 笔 ⇒ 1 次）。
    expect(fake.calls.stat).toEqual([P1]);
    expect(fake.calls.statFiles).toEqual([]);

    // 账本不失真：那笔外部写真的进了改动账（不是只写在标注里）。
    const rep = tracker.report();
    expect(rep.ledger.changes.entries[0]).toMatchObject({ path: P1, origin: 'unattributed', kind: 'change' });
    expect(rep.counters.mtimeRecheckChangesRecorded).toBe(1);
    expect(rep.counters.mtimeRecheckStatCalls).toBe(1);
    expect(rep.ledger.rechecks.size).toBe(1);
    tracker.dispose();
  });

  it('复核不重复记同一笔外部写：判定落账后回声窗内再读 ⇒ 不再复核、也不再冒第二条 unattributed', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });

    fake.setDisk(P1, present(T0 + 800, 77));
    const first = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(first.stale).toBe(true);
    const callsAfterFirst = totalStatCalls(fake);

    // 同一会话再读（基线已推到新盘态之后）：序号已定档 ⇒ 不再付 syscall，判定 false。
    const second = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(second.stale).toBe(false);
    expect(second.recheck).toBeNull(); // 窗外语义：没复核就没复核字段
    expect(totalStatCalls(fake)).toBe(callsAfterFirst);
    const rep = tracker.report();
    expect(rep.ledger.changes.entries.filter((e) => (e as Record<string, unknown>)['origin'] === 'unattributed')).toHaveLength(1);
    expect(rep.counters.mtimeRecheckChangesRecorded).toBe(1);
    tracker.dispose();
  });

  it('目录级同样收口：窗内自写落在被列目录内 ⇒ listing 复核后 stale:true', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P4]: present(T0, 20) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.listingOfRechecked({ dirAbs: `${PROJ}\\sub`, dirRel: 'sub', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P4, kind: 'change', scope: SCOPE_A });
    fake.setDisk(P4, present(T0 + 900, 21));

    const l = await tracker.listingOfRechecked({ dirAbs: `${PROJ}\\sub`, dirRel: 'sub', scope: SCOPE_A });
    expect(l.granularity).toBe('listing');
    expect(l.stale).toBe(true);
    expect(l.recheck).toMatchObject({ outcome: 'changed', targets: 1 });
    expect(fake.calls.stat).toEqual([P4]);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ② 窗内但盘确实没变：false 且「这格 false 是复核给的」
 * ================================================================== */

describe('② 复核证明没变 ≠ 监视证明没变', () => {
  it('窗内命中 + 盘态与自写一致 ⇒ stale:false，recheck 字段自述依据；推出回声窗后 ⇒ recheck 为 null 且零 syscall', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });

    const v = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBe(false);
    expect(v.staleReason).toBeNull();
    expect(v.recheck).toMatchObject({ performed: true, basis: 'mtime-recheck', outcome: 'unchanged', targets: 1, trips: 1 });
    expect(String(v.recheck?.reason)).toContain('复核');
    expect(fake.calls.stat).toHaveLength(1);

    // 对照档：同一路径、回声窗已过 ⇒ 判定回到「监视没报到」那一档，复核字段为空，且一次 syscall 都不许多付。
    vi.advanceTimersByTime(SELF_WRITE_ECHO_WINDOW_MS + 1);
    const before = totalStatCalls(fake);
    const w = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(w.stale).toBe(false);
    expect(w.recheck).toBeNull();
    expect(totalStatCalls(fake)).toBe(before);
    expect(tracker.report().counters.mtimeRecheckStatCalls).toBe(1);
    tracker.dispose();
  });

  it('回声照旧并条（不推序号、events 累加），复核只是把「并条是否掩盖了真写」这件事判出来', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    emitChanged(fake, P1); // ~200ms 去抖后的监视器回声（同一事实，并条不推序号）

    const v = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBe(false); // 盘态没动 ⇒ 复核证伪「被掩盖的真写」
    expect(v.changeOrigin).toBe('mcp-write');
    expect(v.changedSincePreviousRead).toBe(0);
    expect(v.recheck).toMatchObject({ outcome: 'unchanged' });
    const rep = tracker.report();
    expect(rep.ledger.changes.entries[0]).toMatchObject({ origin: 'mcp-write', events: 2 });
    tracker.dispose();
  });
});

/* ================================================================== *
 * ③ 成本判据：命中几笔 ⇒ 几趟；窗外 / 非同路径 / 已定档 ⇒ 0
 * ================================================================== */

describe('③ 成本必须可证（这张计数表是本批判据的核心）', () => {
  it('一次读数 3 个路径命中窗内 ⇒ 只发一趟 statFiles（不 3 趟 stat），逐条各判各的', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({
      [P1]: present(T0, 10),
      [P2]: present(T0, 10),
      [P3]: present(T0, 10),
    });
    const tracker = createFsFreshnessTracker(fake.kernel);
    for (const abs of [P1, P2, P3]) {
      await tracker.verdictOfRechecked({ abs, rel: abs.slice(PROJ.length + 1), scope: SCOPE_A });
      tracker.noteSelfWrite({ abs, kind: 'change', scope: SCOPE_A });
    }
    // P1 被外部真写、P2 没动、P3 取不到 mtime（判不了）
    fake.setDisk(P1, present(T0 + 1_200, 42));
    fake.setDisk(P3, probe(null, 5, true));

    const vs = await tracker.verdictsOfRechecked([
      { abs: P1, rel: 'a.kojo', scope: SCOPE_A },
      { abs: P2, rel: 'b.kojo', scope: SCOPE_A },
      { abs: P3, rel: 'c.kojo', scope: SCOPE_A },
    ]);
    expect(fake.calls.stat).toEqual([]); // 多路径 ⇒ 批量，绝不逐条 stat
    expect(fake.calls.statFiles).toHaveLength(1);
    expect(fake.calls.statFiles[0]).toHaveLength(3);

    expect(vs.map((v) => v.stale)).toEqual([true, false, null]);
    expect(vs[2]!.staleReason).toContain('mtime');
    expect(vs[2]!.recheck).toMatchObject({ outcome: 'unknown', basis: 'mtime-recheck' });
    expect(tracker.report().counters.mtimeRecheckStatCalls).toBe(1); // 一趟
    expect(tracker.report().counters.mtimeRecheckProbedPaths).toBe(3); // 三笔
    tracker.dispose();
  });

  it('窗外 / 非同路径 / 判定已 true 或已 null ⇒ 零额外 stat', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10), [P2]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);

    // (a) 完全没有自写记忆的普通读数
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(totalStatCalls(fake)).toBe(0);

    // (b) 自写在 P1，读的是 P2（非同路径）⇒ 一趟都不许多付
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    await tracker.verdictOfRechecked({ abs: P2, rel: 'b.kojo', scope: SCOPE_A });
    expect(fake.calls.stat).toEqual([]);
    expect(fake.calls.statFiles).toEqual([]);

    // (b2) 窗内命中 P1 一次 ⇒ 恰好 1 次
    const hit = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(hit.stale).toBe(false);
    expect(totalStatCalls(fake)).toBe(1);

    // (c) 判定已经 true（外部改动推了序号）⇒ 不必再复核去证明「变了」
    emitChanged(fake, P2);
    const t = await tracker.verdictOfRechecked({ abs: P2, rel: 'b.kojo', scope: SCOPE_A });
    expect(t.stale).toBe(true);
    expect(t.recheck).toBeNull();
    expect(totalStatCalls(fake)).toBe(1);

    // (d) 判定已经 null（监视覆盖不可信那档）⇒ 复核不接管另一条欠账
    const blind = makeRecheckKernel({ [P1]: present(T0, 10) }, { watch: { status: 'unavailable', roots: [], failures: [] } });
    const tracker2 = createFsFreshnessTracker(blind.kernel);
    await tracker2.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker2.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    const n = await tracker2.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(n.stale).toBeNull();
    expect(String(n.staleReason)).toContain('不可信');
    expect(totalStatCalls(blind)).toBe(0);

    // (e) 推出回声窗后再读同一目标 ⇒ 复核候选集空 ⇒ 还是 1（不涨）
    vi.advanceTimersByTime(SELF_WRITE_ECHO_WINDOW_MS + 1);
    const w = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(w.recheck).toBeNull();
    expect(totalStatCalls(fake)).toBe(1);
    tracker.dispose();
    tracker2.dispose();
  });

  it('注入面只有 stat（没有 statFiles）时如实逐条付：趟数 = 命中笔数，读数照样不乐观', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10), [P2]: present(T0, 10) }, { seam: 'stat-only' });
    const tracker = createFsFreshnessTracker(fake.kernel);
    for (const abs of [P1, P2]) {
      await tracker.verdictOfRechecked({ abs, rel: 'x', scope: SCOPE_A });
      tracker.noteSelfWrite({ abs, kind: 'change', scope: SCOPE_A });
    }
    fake.setDisk(P1, present(T0 + 300, 11));
    const vs = await tracker.verdictsOfRechecked([
      { abs: P1, rel: 'a.kojo', scope: SCOPE_A },
      { abs: P2, rel: 'b.kojo', scope: SCOPE_A },
    ]);
    expect(fake.calls.statFiles).toEqual([]);
    expect(vs[0]!.stale).toBe(true);
    expect(vs[1]!.stale).toBe(false);
    expect(vs[1]!.recheck?.trips).toBeTypeOf('number');
    expect(tracker.report().counters.mtimeRecheckStatCalls).toBeGreaterThan(1); // 没有批量通道 ⇒ 逐条付，如实计数
    tracker.dispose();
  });
});

/* ================================================================== *
 * ④ 复核做不了 ⇒ stale:null + 理由（逐条可见，绝不抛、绝不乐观）
 * ================================================================== */

describe('④ 判不了就 null + staleReason（stat 失败 / mtimeMs:null / seam 缺席）', () => {
  it('seam 缺席（内核没给 io.stat）⇒ stale:null +「注入面没有 stat」，不是 false 也不是 true', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({}, { seam: 'none' });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });

    const v = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(String(v.staleReason)).toContain('stat');
    expect(v.recheck).toMatchObject({ outcome: 'unknown', basis: 'recheck-unavailable', trips: 0, targets: 1 });
    expect(totalStatCalls(fake)).toBe(0);
    tracker.dispose();
  });

  it('stat 抛错 ⇒ 判定不抛，落到 stale:null + 理由带失败原因', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: 'throw' });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });

    const v = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(String(v.staleReason)).toContain('stat 失败');
    expect(v.recheck?.outcome).toBe('unknown');
    tracker.dispose();
  });

  it('mtimeMs 为 null（盘态取不到时间戳）⇒ stale:null，绝不拿 0 兜底成「没变」', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    fake.setDisk(P1, probe(null, 12, true));

    const v = await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(String(v.staleReason)).toContain('mtime');
    tracker.dispose();
  });

  it('自写是删除（unlink）而盘上确实没有 ⇒ 复核证明没变 false；自写是改写而探针报「不在位」⇒ 判不了 null（不猜外部删除）', async () => {
    vi.useFakeTimers({ now: T0 });
    // (a) 删除自写：期望态 = 不在位 ⇒ 复核可以证「没变」
    const del = makeRecheckKernel({ [P1]: absent() });
    const tDel = createFsFreshnessTracker(del.kernel);
    await tDel.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tDel.noteSelfWrite({ abs: P1, kind: 'unlink', scope: SCOPE_A });
    const vd = await tDel.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(vd.stale).toBe(false);
    expect(vd.recheck).toMatchObject({ outcome: 'unchanged', basis: 'mtime-recheck' });
    expect(String(vd.recheck?.reason)).toContain('删除');

    // (b) 改写自写后探针说「不在位」：stat 通道把「不存在」与「取不到」并成一态
    //     （Rust `metadata(path).ok()?` / `stat_files` 的 `Err(_) ⇒ exists:false`）⇒ 判不了，
    //     既不乐观 false，也不把「可能是 stat 失败」乱报成外部删除 true。
    const chg = makeRecheckKernel({ [P2]: present(T0, 10) });
    const tChg = createFsFreshnessTracker(chg.kernel);
    await tChg.verdictOfRechecked({ abs: P2, rel: 'b.kojo', scope: SCOPE_A });
    tChg.noteSelfWrite({ abs: P2, kind: 'change', scope: SCOPE_A });
    chg.setDisk(P2, absent());
    const vc = await tChg.verdictOfRechecked({ abs: P2, rel: 'b.kojo', scope: SCOPE_A });
    expect(vc.stale).toBeNull();
    expect(String(vc.staleReason)).toContain('合一');
    expect(vc.recheck?.outcome).toBe('unknown');
    expect(tChg.report().counters.mtimeRecheckChangesRecorded).toBe(0); // 判不了 ⇒ 绝不多记一笔外部写
    tDel.dispose();
    tChg.dispose();
  });

  it('改写自写后盘上真被外部删掉、但探针还能给出 mtime（例如目录级改名走了 add）⇒ 复核照样核得出来', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P2]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P2, rel: 'b.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P2, kind: 'add', scope: SCOPE_A });
    fake.setDisk(P2, present(T0 + 600, 0)); // 外部改写/重建：mtime 前移 ⇒ 定档 true
    const v = await tracker.verdictOfRechecked({ abs: P2, rel: 'b.kojo', scope: SCOPE_A });
    expect(v.stale).toBe(true);
    expect(v.changeOrigin).toBe('unattributed');
    expect(v.recheck?.probes[0]).toMatchObject({ outcome: 'changed', mtimeMs: T0 + 600 });
    tracker.dispose();
  });

  it('fsFreshnessPayload 序列化把复核读数一起带出去（字段名即契约，不另开第二条通道）', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    const payload = fsFreshnessPayload(await tracker.verdictOfRechecked({ abs: P1, rel: 'a.kojo', scope: SCOPE_A }));
    expect(payload['recheck']).toMatchObject({ performed: true, outcome: 'unchanged' });
    expect(payload['stale']).toBe(false);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ⑤ 同步判定器（今日只读腿在用的那条路）不再谎报 false
 * ================================================================== */

describe('⑤ 同步 verdictOf 的诚实下界：复核在途 ⇒ null，落账后 ⇒ true，且不多付 syscall', () => {
  it('窗内命中 ⇒ 本次读数 stale:null（复核已发起）；落账后下一次读 ⇒ stale:true + 归因 unattributed', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    fake.setDisk(P1, present(T0 + 1_000, 88));

    const pending = tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(pending.stale).toBeNull(); // 改前这里谎报 false
    expect(pending.recheck).toMatchObject({ performed: false, basis: 'recheck-pending', outcome: 'pending', targets: 1, trips: 1 });
    expect(String(pending.staleReason)).toContain('在途');
    expect(fake.calls.stat).toEqual([P1]);

    await tracker.settlePendingRechecks();

    const settled = tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(settled.stale).toBe(true);
    expect(settled.changeOrigin).toBe('unattributed');
    expect(settled.changedSincePreviousRead).toBe(1);
    const callsAfterSettle = totalStatCalls(fake);

    // 再读：序号已把这笔外部写算进基线之后 ⇒ 判 false 且不再复核。
    const third = tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(third.stale).toBe(false);
    expect(third.recheck).toBeNull();
    expect(totalStatCalls(fake)).toBe(callsAfterSettle);
    tracker.dispose();
  });

  it('同一目标的复核只发一趟：在途期间重复读不重复发起 syscall', async () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });

    for (let i = 0; i < 5; i += 1) {
      const v = tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
      expect(v.stale).toBeNull();
    }
    expect(fake.calls.stat).toHaveLength(1); // 在途去重
    await tracker.settlePendingRechecks();
    expect(fake.calls.stat).toHaveLength(1);
    tracker.dispose();
  });

  it('seam 缺席时同步读数也如实 null（本批不留下「窗内自动 false」这条路）', () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({}, { seam: 'none' });
    const tracker = createFsFreshnessTracker(fake.kernel);
    tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    const v = tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(v.stale).toBeNull();
    expect(String(v.staleReason)).toContain('stat');
    expect(totalStatCalls(fake)).toBe(0);
    tracker.dispose();
  });
});

/* ================================================================== *
 * ⑥ 有界性：复核侧记忆自成第三张有界账，旧两张账口径一字不变
 * ================================================================== */

describe('⑥ 复核记忆有界（无限增长即判不合格）', () => {
  it('大量不同路径在窗内命中 ⇒ 复核账按容量淘汰且 dropped/truncated 可见，每轮只发一趟 statFiles', async () => {
    vi.useFakeTimers({ now: T0 });
    const perRound = 1_200; // 两轮共 2400 个不同路径 ⇒ 必然越过 2000 容量，看的是「有没有界」
    const seed: Record<string, DiskState> = {};
    for (let r = 0; r < 2; r += 1) {
      for (let i = 0; i < perRound; i += 1) seed[`${PROJ}\\r${r}-w${i}.kojo`] = present(T0, i);
    }
    const fake = makeRecheckKernel(seed);
    const tracker = createFsFreshnessTracker(fake.kernel);

    for (let r = 0; r < 2; r += 1) {
      const paths: string[] = [];
      for (let i = 0; i < perRound; i += 1) paths.push(`${PROJ}\\r${r}-w${i}.kojo`);
      for (const abs of paths) tracker.noteSelfWrite({ abs, kind: 'change', scope: SCOPE_A });
      const vs = await tracker.verdictsOfRechecked(
        paths.map((abs) => ({ abs, rel: abs.slice(PROJ.length + 1), scope: SCOPE_A })),
      );
      expect(vs).toHaveLength(perRound);
      // 盘态都没变（mtime = 自写时刻）⇒ 绝不报 true；溢出降档那档按既有语义给 null + 淘汰理由
      expect(vs.every((v) => v.stale === false || v.stale === null)).toBe(true);
    }

    expect(fake.calls.stat).toEqual([]);
    expect(fake.calls.statFiles).toHaveLength(2); // 一轮一趟，绝不为 1200 条发 1200 趟
    expect(fake.calls.statFiles.every((chunk) => chunk.length <= perRound)).toBe(true);

    const rep = tracker.report();
    expect(rep.ledger.rechecks.capacity).toBe(CHANGE_LEDGER_CAPACITY);
    expect(rep.ledger.rechecks.size).toBe(CHANGE_LEDGER_CAPACITY);
    expect(rep.ledger.rechecks.dropped).toBeGreaterThan(0);
    expect(rep.ledger.rechecks.truncated).toBe(true);
    expect(rep.ledger.evictedKeys.rechecks).toBeGreaterThan(0);
    // 复核只是第三张账：两张旧账的容量与溢出可见性一字不变。
    expect(rep.ledger.changes.capacity).toBe(CHANGE_LEDGER_CAPACITY);
    expect(rep.ledger.reads.capacity).toBe(READ_LEDGER_CAPACITY);
    expect(rep.ledger.changes.size).toBeLessThanOrEqual(CHANGE_LEDGER_CAPACITY);
    expect(rep.ledger.reads.size).toBeLessThanOrEqual(READ_LEDGER_CAPACITY);
    expect(rep.counters.mtimeRecheckStatCalls).toBe(2);
    expect(rep.counters.mtimeRecheckPending).toBe(0);
    tracker.dispose();
  });

  it('自写回声记忆按窗裁剪：过窗的路径不留在表里（复核候选集有界，不扫全量）', () => {
    vi.useFakeTimers({ now: T0 });
    const fake = makeRecheckKernel({ [P1]: present(T0, 10), [P2]: present(T0, 10) });
    const tracker = createFsFreshnessTracker(fake.kernel);
    tracker.noteSelfWrite({ abs: P1, kind: 'change', scope: SCOPE_A });
    vi.advanceTimersByTime(SELF_WRITE_ECHO_WINDOW_MS + 1);
    tracker.noteSelfWrite({ abs: P2, kind: 'change', scope: SCOPE_A });
    const rep = tracker.report();
    expect(rep.counters.selfWritesInWindow).toBe(1); // 只剩 P2
    // 过窗的 P1 再读 ⇒ 不复核
    const before = totalStatCalls(fake);
    tracker.verdictOf({ abs: P1, rel: 'a.kojo', scope: SCOPE_A });
    expect(totalStatCalls(fake)).toBe(before);
    tracker.dispose();
  });
});
