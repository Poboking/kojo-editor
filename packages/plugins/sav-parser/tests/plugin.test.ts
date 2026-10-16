import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EventBus,
  FileIO,
  FileStat,
  GameProject,
  PluginContext,
  ProjectService,
  SnapshotSourceService,
  Unsubscribe,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createSavParserPlugin } from '../src/index';
import { SnapshotSourceEngine } from '../src/engine';
import { makeArchiveFile, simpleCharBlock, type ArchiveSpec } from './helpers/synth';

/* ---------------- 测试替身 ---------------- */

function normalSpec(over: Partial<ArchiveSpec> = {}): ArchiveSpec {
  return {
    fileType: 0,
    saveMes: '第 1 日(春之月1日)',
    charCount: 1,
    charBlock: simpleCharBlock,
    ...over,
  };
}

/** 伪 FileIO：只需要 readBytes / listDir / stat */
function fakeIO(files: Record<string, Uint8Array>, dirs: string[] = []): FileIO {
  return {
    async readBytes(path: string) {
      const b = files[path];
      if (!b) throw new Error(`not found: ${path}`);
      return b;
    },
    async listDir(path: string) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const out: DirEntry[] = [];
      for (const d of dirs) {
        if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
          out.push({ name: d.slice(prefix.length), path: d, isDirectory: true });
        }
      }
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
          out.push({ name: p.slice(prefix.length), path: p, isDirectory: false });
        }
      }
      return out;
    },
    async stat(path: string): Promise<FileStat | null> {
      const b = files[path];
      if (!b) return null;
      return { size: b.length, mtimeMs: 1_700_000_000_000, isDirectory: false };
    },
  } as unknown as FileIO;
}

function makeBus(): { bus: EventBus; emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const on = (type: string, handler: (p: unknown) => void): Unsubscribe => {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  };
  const emit = (type: string, payload: unknown): void => {
    for (const h of [...(handlers.get(type) ?? [])]) h(payload);
  };
  return { bus: { on, once: on, emit } as unknown as EventBus, emit };
}

function fakeProject(rootDir: string, savDir?: string): GameProject {
  const p: GameProject = {
    rootDir,
    adapterId: 'test',
    kojoPaths: [],
    writablePaths: [],
    charaIndex: new Map(),
  };
  if (savDir !== undefined) p.savDir = savDir;
  return p;
}

function activatePlugin(
  io: FileIO,
  project0: GameProject | null,
): {
  services: Map<string, unknown>;
  logs: string[];
  emit: (type: string, payload: unknown) => void;
  dispose: () => void;
} {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const { bus, emit } = makeBus();
  const disposers: Array<() => void> = [];
  let current = project0;
  const projService = { current: () => current } as unknown as ProjectService;
  const ctx = {
    pluginId: 'sav-parser',
    log: {
      debug: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    bus,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.project') return projService as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    // 可选依赖通道（kernel.ops journal，2026-10-16 undo 批）：替身缺席它 → 注入行为退回原样
    tryInject: (): undefined => undefined,
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  createSavParserPlugin().activate(ctx);
  return {
    services,
    logs,
    emit: (type, payload) => {
      if (type === 'project.opened') current = (payload as { project: GameProject }).project;
      if (type === 'project.closed') current = null;
      emit(type, payload);
    },
    dispose: () => {
      for (const d of disposers.reverse()) d();
    },
  };
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ---------------- 用例 ---------------- */

describe('sav-parser 插件装配', () => {
  it('provides snapshot.source；requires kernel.io / kernel.project', () => {
    const plugin = createSavParserPlugin();
    expect(plugin.provides).toContain(WellKnownServices.SnapshotSource);
    expect(plugin.requires).toContain('kernel.io');
    expect(plugin.requires).toContain('kernel.project');
  });

  it('project.opened → 自动扫描（非阻塞事件），结果可订阅', async () => {
    const sav = makeArchiveFile(normalSpec({ saveMes: '第 14 日(春之月14日)' }));
    const io = fakeIO({ '/g/sav/save01.sav': sav });
    const { services, emit } = activatePlugin(io, null);
    const engine = services.get(WellKnownServices.SnapshotSource) as SnapshotSourceService;

    const seen: Array<unknown> = [];
    const un = engine.subscribe((r) => seen.push(r));
    expect(seen).toEqual([null]); // 订阅即回放当前值

    emit('project.opened', { project: fakeProject('/g', '/g/sav') });
    await until(() => engine.current() !== null);

    const result = engine.current()!;
    expect(result.dir).toBe('/g/sav');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.meta?.saveMes).toContain('第 14 日');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    un();
  });

  it('project.closed → 清空（订阅者收到 null）', async () => {
    const io = fakeIO({ '/g/sav/save00.sav': makeArchiveFile(normalSpec()) });
    const { services, emit } = activatePlugin(io, null);
    const engine = services.get(WellKnownServices.SnapshotSource) as SnapshotSourceService;

    emit('project.opened', { project: fakeProject('/g', '/g/sav') });
    await until(() => engine.current() !== null);
    emit('project.closed', { rootDir: '/g' });
    expect(engine.current()).toBeNull();
  });

  it('插件激活时项目已打开 → 补扫一次', async () => {
    const io = fakeIO({ '/g/sav/save00.sav': makeArchiveFile(normalSpec()) });
    const { services } = activatePlugin(io, fakeProject('/g', '/g/sav'));
    const engine = services.get(WellKnownServices.SnapshotSource) as SnapshotSourceService;
    await until(() => engine.current() !== null);
    expect(engine.current()!.entries).toHaveLength(1);
  });

  it('dispose 后事件订阅解除（无残留 handler）', async () => {
    const io = fakeIO({ '/g/sav/save00.sav': makeArchiveFile(normalSpec()) });
    const h = activatePlugin(io, null);
    h.dispose();
    // 再次 emit 不应崩溃，也不应更新（订阅已解除）
    h.emit('project.opened', { project: fakeProject('/g', '/g/sav') });
    await new Promise((r) => setTimeout(r, 30));
    const engine = h.services.get(WellKnownServices.SnapshotSource) as SnapshotSourceService;
    expect(engine.current()).toBeNull();
  });
});

describe('SnapshotSourceEngine 扫描行为', () => {
  function makeEngine(files: Record<string, Uint8Array>, dirs: string[], project: GameProject | null): SnapshotSourceEngine {
    return new SnapshotSourceEngine({
      log: { debug() {}, info() {}, warn() {}, error() {} },
      getProject: () => project,
      readBytes: async (p) => {
        const b = files[p];
        if (!b) throw new Error(`not found: ${p}`);
        return b;
      },
      listDir: async (path) => {
        const prefix = `${path}/`;
        const out: DirEntry[] = [];
        for (const d of dirs) {
          if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
            out.push({ name: d.slice(prefix.length), path: d, isDirectory: true });
          }
        }
        for (const p of Object.keys(files)) {
          if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
            out.push({ name: p.slice(prefix.length), path: p, isDirectory: false });
          }
        }
        return out;
      },
      stat: async () => null,
      writeBytes: async () => {
        throw new Error('writeBytes not wired in this test');
      },
      backup: async () => null,
    });
  }

  it('无存档目录（项目未声明）→ 空结果 + 不报错', async () => {
    const engine = makeEngine({}, [], fakeProject('/g'));
    const r = await engine.scan();
    expect(r.dir).toBe('');
    expect(r.entries).toEqual([]);
    expect(engine.current()).toBe(r);
  });

  it('无项目 → 空结果', async () => {
    const engine = makeEngine({}, [], null);
    const r = await engine.scan();
    expect(r.dir).toBe('');
    expect(r.entries).toEqual([]);
  });

  it('过滤非存档文件与子目录；坏档进 error 不中断其他档', async () => {
    const good = makeArchiveFile(normalSpec());
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const engine = makeEngine(
      {
        '/g/sav/save00.sav': good,
        '/g/sav/broken.sav': bad,
        '/g/sav/readme.txt': new Uint8Array([0x41]),
      },
      ['/g/sav/sub'],
      fakeProject('/g', '/g/sav'),
    );
    const r = await engine.scan();
    expect(r.entries).toHaveLength(2); // readme.txt 与 sub/ 被过滤
    const byName = new Map(r.entries.map((e) => [e.fileName, e]));
    expect(byName.get('save00.sav')?.meta?.fileType).toBe('normal');
    expect(byName.get('save00.sav')?.error).toBeUndefined();
    expect(byName.get('broken.sav')?.meta).toBeNull();
    expect(byName.get('broken.sav')?.error).toBeTruthy();
  });

  it('深解析 parse(path) 返回完整变量视图', async () => {
    const engine = makeEngine({ '/g/sav/save00.sav': makeArchiveFile(normalSpec()) }, [], fakeProject('/g', '/g/sav'));
    const arch = await engine.parse('/g/sav/save00.sav');
    expect(arch.chars).toHaveLength(1);
    expect(arch.fileType).toBe('normal');
    expect(arch.remaining).toBe(0);
  });

  it('并发 scan() 共享在途任务', async () => {
    const engine = makeEngine({ '/g/sav/save00.sav': makeArchiveFile(normalSpec()) }, [], fakeProject('/g', '/g/sav'));
    const [a, b] = await Promise.all([engine.scan(), engine.scan()]);
    expect(a).toBe(b);
  });

  it('项目切换：在途扫描结果被代际保护丢弃', async () => {
    let project: GameProject | null = fakeProject('/g1', '/g1/sav');
    const gate: { release?: () => void } = {};
    const engine = new SnapshotSourceEngine({
      log: { debug() {}, info() {}, warn() {}, error() {} },
      getProject: () => project,
      readBytes: async (p) => {
        // 挂起直到测试释放（模拟慢扫描），然后正常返回
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        const b = p.includes('save00') ? makeArchiveFile(normalSpec()) : undefined;
        if (!b) throw new Error('not found');
        return b;
      },
      listDir: async () => [{ name: 'save00.sav', path: '/g1/sav/save00.sav', isDirectory: false }],
      stat: async () => null,
      writeBytes: async () => {
        throw new Error('writeBytes not wired in this test');
      },
      backup: async () => null,
    });

    const scanPromise = engine.scan(); // 在途，卡在 readBytes
    await until(() => gate.release !== undefined); // 等挂起点到达
    // 项目切换
    project = fakeProject('/g2', '/g2/sav');
    engine.clear();
    gate.release!(); // 释放旧扫描
    const result = await scanPromise;

    // 旧扫描完成但结果被丢弃（current 保持 clear 后的 null）
    expect(result.entries).toEqual([]);
    expect(engine.current()).toBeNull();
  });
});
