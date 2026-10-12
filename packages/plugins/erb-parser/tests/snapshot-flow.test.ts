/**
 * 索引快照流程测试（2026-10-12「内核优化」批 · 例 1：第二次开项目不用再等）。
 *
 * 用**假 io + 真 JSON 往返的假存储域**驱动插件本体，钉死增量复扫的语义：
 * - 首次打开 = 全量构建 + 落盘快照；
 * - 二次打开（mtime 全没变）= **零读盘**，索引与全量重建逐位一致；
 * - 只重扫变过的文件；消失的文件被收尸；快照损坏 = 弃用重建（fail-closed）；
 * - `service.buildIndex`（显式调用）不走快照（强制重建语义）。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, ErbParserService, FileIO, FileStat, GameProject, ScopedStorage } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { snapshotKeyFor } from '../src/snapshot';
import { makeComputeStub } from './support';

const ROOT = 'D:/proj/eratw';
const KOJO = `${ROOT}/ERB`;
const P1 = `${KOJO}/M_KOJO_K1.ERB`;
const P2 = `${KOJO}/M_KOJO_K2.ERB`;

const SRC1 = '@FOO_A\n\tPRINTFORMW 甲。\nRETURN 1\n\n@FOO_B\n\tPRINTFORML 乙。\nRETURN 1\n';
const SRC2 = '@BAR_A\n\tPRINTFORMW 丙。\nRETURN 1\n';
const SRC1_TOUCHED = '@FOO_A\n\tPRINTFORMW 甲（改）。\nRETURN 1\n\n@FOO_B\n\tPRINTFORML 乙。\nRETURN 1\n\n@FOO_C\nRETURN 1\n';

interface FakeFile {
  text: string;
  mtimeMs: number;
}

/** 假 io：内存 FS + readText 调用计数（增量复扫的核心断言依据） */
function makeIO(files: Map<string, FakeFile>) {
  let reads = 0;
  const io = {
    readText: async (path: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`not found: ${path}`);
      reads++;
      return { path, text: f.text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: f.mtimeMs };
    },
    walkDir: async (): Promise<DirEntry[]> =>
      [...files.keys()].map((p) => ({ name: p.split('/').pop()!, path: p, isDirectory: false })),
    stat: async (path: string): Promise<FileStat | null> => {
      const f = files.get(path);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs, isDirectory: false } : null;
    },
  };
  return { io: io as unknown as FileIO, readsOf: () => reads };
}

/** 假存储域：与 FileStorageBackend 一样走 JSON 往返（能抓住"存了不可序列化的东西"） */
function makeStorage() {
  const map = new Map<string, string>();
  const deleted: string[] = [];
  const storage: ScopedStorage = {
    get: async <T = unknown>(key: string) => {
      const raw = map.get(key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined; // 与内核 ScopedStorageImpl 同语义：损坏 = 缺失
      }
    },
    set: async (key: string, value: unknown) => {
      map.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => {
      map.delete(key);
      deleted.push(key);
    },
    keys: async () => [...map.keys()],
  };
  return { storage, map, deleted };
}

function activate(io: FileIO, storage: ScopedStorage) {
  const provided = new Map<string, unknown>();
  const handlers = new Map<string, Set<(p: never) => void>>();
  const bus = {
    on(type: string, h: (p: never) => void) {
      let s = handlers.get(type);
      if (!s) {
        s = new Set();
        handlers.set(type, s);
      }
      s.add(h);
      return () => s!.delete(h);
    },
    emit(type: string, payload: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload as never);
    },
  };
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    bus,
    storage,
    inject: (key: string) => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.compute') return makeComputeStub();
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
  };
  createErbParserPlugin().activate(ctx as never);
  const service = provided.get('erb.parser') as ErbParserService;
  const waitIndexed = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), 2000);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return { service, bus, waitIndexed };
}

const openProject = (bus: { emit: (t: string, p: unknown) => void }): void => {
  bus.emit('project.opened', {
    project: { rootDir: ROOT, adapterId: 'eratw', kojoPaths: [KOJO], writablePaths: [], charaIndex: new Map() } as GameProject,
  });
};

/** 索引的确定性序列化（Map 会被 JSON.stringify 吞掉，故手工展开） */
const indexFingerprint = (idx: NonNullable<ReturnType<ErbParserService['currentIndex']>>): string =>
  JSON.stringify({
    files: [...idx.files.entries()].map(([p, f]) => [p, f.functions.map((fn) => fn.normalizedName), f.lineCount]),
    byName: [...idx.byName.entries()].map(([n, refs]) => [n, refs.map((r) => [r.filePath, r.startLine, r.endLine])]),
  });

describe('索引快照流程（假 io + 真 JSON 往返）', () => {
  it('首次打开：全量构建 + 落盘快照', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io, readsOf } = makeIO(files);
    const { storage, map } = makeStorage();
    const { service, bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();
    expect(readsOf()).toBe(2); // 全量
    expect(service.currentIndex()!.files.size).toBe(2);

    expect(map.size).toBe(1);
    const raw = JSON.parse([...map.values()][0]!) as { version: number; rootDir: string; entries: Record<string, unknown> };
    expect(raw.rootDir).toBe(ROOT);
    expect(Object.keys(raw.entries).sort()).toEqual([P1, P2]);
  });

  it('二次打开（mtime 全没变）：零读盘，索引与全量重建逐位一致', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io, readsOf } = makeIO(files);
    const { storage } = makeStorage();
    const { service, bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();
    const first = indexFingerprint(service.currentIndex()!);

    openProject(bus); // 同一项目重开
    await waitIndexed();
    expect(readsOf()).toBe(2); // 仍是首次那 2 次读：二次打开零读盘
    expect(indexFingerprint(service.currentIndex()!)).toBe(first);
  });

  it('只重扫变过的文件；未变文件直接复用', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io, readsOf } = makeIO(files);
    const { storage } = makeStorage();
    const { service, bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();

    files.set(P1, { text: SRC1_TOUCHED, mtimeMs: 300 }); // 只改 P1
    openProject(bus);
    await waitIndexed();
    expect(readsOf()).toBe(3); // 首次 2 次 + 本次只重扫 P1

    const idx = service.currentIndex()!;
    expect(idx.files.get(P1)!.functions.map((f) => f.normalizedName)).toEqual(['FOO_A', 'FOO_B', 'FOO_C']);
    expect(idx.files.get(P2)!.functions.map((f) => f.normalizedName)).toEqual(['BAR_A']);
  });

  it('消失的文件被收尸（快照不越攒越大）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io } = makeIO(files);
    const { storage, map } = makeStorage();
    const { bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();

    files.delete(P2);
    openProject(bus);
    await waitIndexed();

    const raw = JSON.parse([...map.values()][0]!) as { entries: Record<string, unknown> };
    expect(Object.keys(raw.entries)).toEqual([P1]);
  });

  it('快照结构损坏 → 弃用 + 删除 + 全量重建（fail-closed，绝不"修"）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io, readsOf } = makeIO(files);
    const { storage, map, deleted } = makeStorage();
    const { service, bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();

    map.set(snapshotKeyFor(ROOT), JSON.stringify({ version: 999, rootDir: ROOT, entries: {} })); // 伪造旧版本
    openProject(bus);
    await waitIndexed();

    expect(deleted).toEqual([snapshotKeyFor(ROOT)]);
    expect(readsOf()).toBe(4); // 2（首次）+ 2（弃用后全量重建）
    expect(service.currentIndex()!.files.size).toBe(2);
  });

  it('service.buildIndex（显式调用）不走快照：语义 = 强制重建', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io, readsOf } = makeIO(files);
    const { storage } = makeStorage();
    const { service, bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();

    await service.buildIndex([KOJO]);
    expect(readsOf()).toBe(4); // 显式调用无视快照，全量重读
  });
});
