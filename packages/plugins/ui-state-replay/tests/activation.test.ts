/**
 * 激活层单测（P4 档案清单刷新 / P9 回放意图必浮窗；2026-11-05 面板可用性批）。
 *
 * 这两条都在"面板没挂载 / 清单被别处刷新"的路径上，纯靠 UI 手测很难稳定复现，
 * 所以用一份最小 `PluginContext` 假件把行为钉住：
 *   - P9：`kojo.replayFunction` **只要没人在听**就发 `ui.panel.float`（不再要求带 locate）；
 *   - P4：初值取 `snapshots.current()`、跟随 `snapshots.subscribe()`、`rescan()` 失败
 *     显式落到 `archivesError`（ready 必须为 true，不许永远转圈）、服务回调 null 清空。
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  GameProject,
  PluginContext,
  ProjectService,
  SlotRegistry,
  SnapshotScanResult,
  SnapshotSourceService,
} from '@kojo/plugin-api';
import { createReplayActivation } from '../src/activation';

/* ------------------------------- 假件 ------------------------------- */

type Handler = (payload: unknown) => void;

/** 最小项目对象（激活层不直接读项目字段，只把它当"归属凭据"用） */
function fakeProject(rootDir: string): GameProject {
  return { rootDir, adapterId: 'test-adapter', kojoPaths: [], charaIndex: new Map() } as unknown as GameProject;
}

function fakeScan(paths: string[]): SnapshotScanResult {
  return {
    dir: 'D:/proj/sav',
    scannedAt: Date.now(),
    durationMs: 1,
    entries: paths.map((p) => ({
      path: p,
      fileName: p.split('/').pop() ?? p,
      size: 1,
      mtimeMs: null,
      meta: { saveMes: `save:${p}`, charCount: 3 } as never,
    })),
  };
}

interface Harness {
  ctx: PluginContext;
  emit: (ev: string, payload: unknown) => void;
  flush: () => Promise<void>;
  dispose: () => void;
  projectCurrent: { current: GameProject | null };
  listeners: Set<(r: SnapshotScanResult | null) => void>;
  scanMock: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: {
  project?: GameProject | null;
  cached?: SnapshotScanResult | null;
  scanRejects?: string;
}): Harness {
  const handlers = new Map<string, Set<Handler>>();
  const disposers: (() => void)[] = [];
  const bus = {
    on(ev: string, cb: Handler): () => void {
      let set = handlers.get(ev);
      if (!set) {
        set = new Set();
        handlers.set(ev, set);
      }
      set.add(cb);
      return (): void => {
        set!.delete(cb);
      };
    },
    emit(ev: string, payload: unknown): void {
      for (const cb of [...(handlers.get(ev) ?? [])]) cb(payload);
    },
  };
  const projectCurrent: { current: GameProject | null } = { current: opts?.project ?? null };
  const listeners = new Set<(r: SnapshotScanResult | null) => void>();
  const scanMock = vi.fn(async () => {
    if (opts?.scanRejects) throw new Error(opts.scanRejects);
    return fakeScan(['D:/proj/sav/one.sav']);
  });
  const ctx = {
    bus,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    onDispose: (fn: () => void) => {
      disposers.push(fn);
    },
    storage: { get: async () => null, set: async () => undefined },
    slots: { register: () => undefined, query: () => undefined },
  } as unknown as PluginContext;
  return {
    ctx,
    emit: (ev, payload) => bus.emit(ev, payload),
    flush: async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    },
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
    projectCurrent,
    listeners,
    scanMock,
  };
}

/** 接全套依赖（project / snapshots 都真的接上） */
function makeActivation(opts?: {
  project?: GameProject | null;
  cached?: SnapshotScanResult | null;
  scanRejects?: string;
}): { activation: ReturnType<typeof createReplayActivation>; h: Harness } {
  const h = makeHarness(opts);
  const project = { current: () => h.projectCurrent.current } as unknown as ProjectService;
  const snapshots = {
    scan: h.scanMock,
    current: () => opts?.cached ?? null,
    parse: async () => {
      throw new Error('unused');
    },
    subscribe: (cb: (r: SnapshotScanResult | null) => void) => {
      h.listeners.add(cb);
      cb(opts?.cached ?? null);
      return () => {
        h.listeners.delete(cb);
      };
    },
  } as unknown as SnapshotSourceService;
  const activation = createReplayActivation(h.ctx, {
    project,
    snapshots,
    slots: {} as unknown as SlotRegistry,
    panelId: 'state-replay',
  });
  return { activation, h };
}

/* ------------------------------ P9 ------------------------------ */

describe('kojo.replayFunction：没人在听就必须浮窗（P9）', () => {
  it('不带 locate 的意图（函数树右键那条）也浮窗——旧口径点了没反应', () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), cached: fakeScan([]) });
    const floats: unknown[] = [];
    h.ctx.bus.on('ui.panel.float', (p) => floats.push(p));
    h.emit('kojo.replayFunction', { functionName: 'K1_TALK' });
    expect(floats).toEqual([{ id: 'state-replay', source: 'ui-state-replay' }]);
    expect(activation.pending).toEqual({ functionName: 'K1_TALK' });
  });

  it('已有面板实例在听 → 不浮窗（仍记 pending，带 locate 也原样保留）', () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), cached: fakeScan([]) });
    const floats: unknown[] = [];
    h.ctx.bus.on('ui.panel.float', (p) => floats.push(p));
    activation.mounted.add({});
    h.emit('kojo.replayFunction', { functionName: 'K1_TALK', locate: { filePath: 'K1.ERB', line: 3 } });
    expect(floats).toEqual([]);
    expect(activation.pending).toEqual({ functionName: 'K1_TALK', locate: { filePath: 'K1.ERB', line: 3 } });
  });
});

/* ------------------------------ P4 ------------------------------ */

describe('档案清单：缓存初值 / 订阅跟随 / 重新扫描 / 服务清空（P4）', () => {
  it('初值取 snapshots.current()：首帧就有清单，不再先转一圈', () => {
    const { activation } = makeActivation({
      project: fakeProject('D:/proj'),
      cached: fakeScan(['D:/proj/sav/a.sav', 'D:/proj/sav/b.sav']),
    });
    expect(activation.archivesReady).toBe(true);
    expect(activation.archives.map((a) => a.fileName)).toEqual(['a.sav', 'b.sav']);
    expect(activation.archivesError).toBeNull();
  });

  it('没有缓存 → 自己发起一轮扫描（失败也把 ready 置 true 并留显式错误）', async () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), scanRejects: 'sav 目录不可读' });
    expect(activation.archivesReady).toBe(false);
    expect(activation.scanning).toBe(true);
    await h.flush();
    expect(activation.archivesReady).toBe(true); // 失败也算就绪：不许永远转圈
    expect(activation.scanning).toBe(false);
    expect(activation.archivesError).toContain('sav 目录不可读');
  });

  it('服务侧订阅（别处重扫）→ 本面板清单跟着更新', () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), cached: fakeScan([]) });
    expect(activation.archives).toEqual([]);
    for (const cb of [...h.listeners]) cb(fakeScan(['D:/proj/sav/new.sav']));
    expect(activation.archives.map((a) => a.fileName)).toEqual(['new.sav']);
  });

  it('rescan()：先报 scanning，成功后清单替换、错误清空', async () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), cached: fakeScan([]) });
    activation.rescan();
    expect(activation.scanning).toBe(true);
    await h.flush();
    expect(activation.scanning).toBe(false);
    expect(activation.archives.map((a) => a.fileName)).toEqual(['one.sav']);
    expect(activation.archivesError).toBeNull();
  });

  it('服务回调 null（项目关闭 / 服务重置）→ 清单清空，不留旧工程档案', () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), cached: fakeScan(['D:/proj/sav/a.sav']) });
    expect(activation.archives).toHaveLength(1);
    for (const cb of [...h.listeners]) cb(null);
    expect(activation.archives).toEqual([]);
    expect(activation.archivesReady).toBe(false);
  });

  it('dispose 收口：suspend 之后服务再回调不改状态、总线事件也不再浮窗', async () => {
    const { activation, h } = makeActivation({ project: fakeProject('D:/proj'), cached: fakeScan([]) });
    h.dispose();
    for (const cb of [...h.listeners]) cb(fakeScan(['D:/proj/sav/after.sav']));
    expect(activation.archives).toEqual([]);
    expect(h.listeners.size).toBe(0);
    // 总线订阅也已收口：再发回放意图不会把 pending 改掉
    activation.pending = null;
    h.emit('kojo.replayFunction', { functionName: 'AFTER_DISPOSE' });
    expect(activation.pending).toBeNull();
  });
});
