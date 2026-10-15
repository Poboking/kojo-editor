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

/**
 * 假 io：内存 FS + 读调用计数（增量复扫的核心断言依据）。
 * `withMetadata` ⇒ walkDir 顺带带回 mtimeMs/size（`walkDir({withMetadata})` 契约），
 * 用于钉死"walk 带回的值"与"逐文件 stat 的值"**结果完全一致**、且此时**一次 stat 都不发**。
 *
 * `readTexts`（2026-10-16 批量 IO 批）镜像内核 FileIOService 的批量语义：
 * 批调 + mtime/size 全等才命中**会话文本缓存**（缓存命中不计入 reads）——
 * 于是下方读数钉的正是"每次冷开每文件正文只读一遍"这条 KPI。
 * 单文件 `readText` 与内核一致：不接缓存（永远新鲜读盘）。
 */
function makeIO(files: Map<string, FakeFile>, opts?: { withMetadata?: boolean }) {
  let reads = 0;
  let stats = 0;
  type FakeTextFile = { path: string; text: string; encoding: 'utf-8'; eol: 'lf'; mtimeMs: number };
  const textCache = new Map<string, { mtimeMs: number; size: number; tf: FakeTextFile }>();
  const readOne = (path: string): FakeTextFile => {
    const f = files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    reads++;
    return { path, text: f.text, encoding: 'utf-8', eol: 'lf', mtimeMs: f.mtimeMs };
  };
  const io = {
    readText: async (path: string) => readOne(path),
    readTexts: async (paths: readonly string[]) => {
      const out: Array<FakeTextFile | null> = [];
      for (const path of paths) {
        const f = files.get(path);
        if (!f) {
          out.push(null);
          continue;
        }
        const cached = textCache.get(path);
        if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.text.length) {
          out.push(cached.tf);
          continue;
        }
        const tf = readOne(path);
        textCache.set(path, { mtimeMs: f.mtimeMs, size: f.text.length, tf });
        out.push(tf);
      }
      return out;
    },
    walkDir: async (): Promise<DirEntry[]> =>
      [...files.keys()].map((p) => {
        const f = files.get(p)!;
        const base: DirEntry = { name: p.split('/').pop()!, path: p, isDirectory: false };
        return opts?.withMetadata ? { ...base, mtimeMs: f.mtimeMs, size: f.text.length } : base;
      }),
    stat: async (path: string): Promise<FileStat | null> => {
      stats++;
      const f = files.get(path);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs, isDirectory: false } : null;
    },
  };
  return { io: io as unknown as FileIO, readsOf: () => reads, statsOf: () => stats };
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
    expect(readsOf()).toBe(2); // 全量：每文件正文**只读一遍**（解析段批量读；H2 引用重扫命中会话缓存）
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
    expect(readsOf()).toBe(2); // 仍是首次那 2 次读：二次打开零读盘（refs 也走快照，增量批不放宽这条）
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
    expect(readsOf()).toBe(3); // 首次 2 + 本次只重读 P1（解析段）；P1 引用重扫走会话缓存、P2 复用快照——零额外读

    const idx = service.currentIndex()!;
    expect(idx.files.get(P1)!.functions.map((f) => f.normalizedName)).toEqual(['FOO_A', 'FOO_B', 'FOO_C']);
    expect(idx.files.get(P2)!.functions.map((f) => f.normalizedName)).toEqual(['BAR_A']);
    // 两条分支都必须填 mtime：P1 取本次 readText、P2 取快照元组还原值。
    // 下游条件抽取按文件粒度复用全靠 `fileMtimes`，这里漏填不会报错——
    // 只会表现为「抽取段悄悄退回全库重算」，覆盖率类尺子量不到（同 §5.67 那条教训）。
    expect(idx.fileMtimes!.get(P1)).toBe(300);
    expect(idx.fileMtimes!.get(P2)).toBe(200);
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
    expect(readsOf()).toBe(2); // 首次 2；弃用后全量重建只重**解析**——文本 mtime/size 未变、会话缓存命中，零重读
    expect(service.currentIndex()!.files.size).toBe(2);
  });

  it('磁盘卫生：落盘后收口成单文件，旧版本孤儿被清、别人的键不碰', async () => {
    const files = new Map<string, FakeFile>([[P1, { text: SRC1, mtimeMs: 100 }]]);
    const { io } = makeIO(files);
    const { storage, map, deleted } = makeStorage();
    const { bus, waitIndexed } = activate(io, storage);

    // 磁盘上躺着：别的项目的快照 + 格式升级遗留的 v2 孤儿 + 一个与快照无关的键
    map.set(snapshotKeyFor('D:/other/game'), JSON.stringify({ version: 3, rootDir: 'D:/other/game', savedAt: 1, entries: {} }));
    map.set('index-v2-aabbccdd', JSON.stringify({ version: 2, rootDir: ROOT, savedAt: 1, entries: {} }));
    map.set('user-notes', 'not-a-snapshot');

    openProject(bus);
    await waitIndexed();
    for (let i = 0; i < 50 && deleted.length === 0; i++) await new Promise((r) => setTimeout(r, 5));

    expect(deleted.sort()).toEqual(['index-v2-aabbccdd', snapshotKeyFor('D:/other/game')].sort());
    expect(map.has('user-notes')).toBe(true); // 非快照形态的键不越权删
    expect(map.has(snapshotKeyFor(ROOT))).toBe(true); // 当前项目这份留着
  });

  it('未变更（全命中快照）时也照样收口', async () => {
    const files = new Map<string, FakeFile>([[P1, { text: SRC1, mtimeMs: 100 }]]);
    const { io } = makeIO(files);
    const { storage, map, deleted } = makeStorage();
    const { bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    await waitIndexed();
    map.set('index-v1-deadbeef', JSON.stringify({ version: 1, rootDir: ROOT, savedAt: 1, entries: {} }));

    openProject(bus); // mtime 没变 ⇒ snapshotDirty = false
    await waitIndexed();
    for (let i = 0; i < 50 && !deleted.includes('index-v1-deadbeef'); i++) await new Promise((r) => setTimeout(r, 5));

    expect(deleted).toContain('index-v1-deadbeef');
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
    // 显式调用无视**快照**（全量重解析）；正文仍命中会话缓存（mtime/size 未变）——
    // "强制重建"是对缓存语义说的，不是对读盘：读次数与首开持平
    expect(readsOf()).toBe(2);
  });

  /**
   * §5.117：热开 `index可用` 2,657ms 里 `stat` 独占 2,038ms，全是 2,285 次逐文件 IPC 往返。
   * 改成 `walkDir({withMetadata})` 顺带带回 mtime 后，**判据的取值来源换了**，
   * 所以两件事必须同时成立：① 结果逐位不变（索引 + fileMtimes + 落盘快照同值，
   * 否则老项目的缓存会被这次改动无谓地全量作废）；② 一次 `stat` 都不发——
   * 不然"省掉那一整段"就是空话。
   */
  it('walk 带回元数据 ⇒ 与逐文件 stat 版逐位一致，且一次 stat 都不发', async () => {
    const seed = () =>
      new Map<string, FakeFile>([
        [P1, { text: SRC1, mtimeMs: 100 }],
        [P2, { text: SRC2, mtimeMs: 200 }],
      ]);
    const dump = (idx: NonNullable<ReturnType<ErbParserService['currentIndex']>>) =>
      JSON.stringify({ fp: indexFingerprint(idx), mtimes: [...idx.fileMtimes!.entries()].sort() });

    // 对照组：桥不带元数据 ⇒ 走逐文件 stat 兜底
    const plain = makeIO(seed());
    const ps = makeStorage();
    const pw = activate(plain.io, ps.storage);
    openProject(pw.bus);
    await pw.waitIndexed();
    const viaStat = dump(pw.service.currentIndex()!);
    expect(plain.statsOf()).toBe(2); // 兜底路径确实逐文件 stat 过

    // 实验组：桥顺带带回 mtime/size
    const meta = makeIO(seed(), { withMetadata: true });
    const ms = makeStorage();
    const mw = activate(meta.io, ms.storage);
    openProject(mw.bus);
    await mw.waitIndexed();
    const viaWalk = dump(mw.service.currentIndex()!);

    expect(viaWalk).toBe(viaStat); // 索引与 mtime 判据逐位一致
    expect(meta.statsOf()).toBe(0); // 且一次 stat 都没发
    // 落盘快照也要同值：判据来源变了不该把老项目的缓存整体作废。
    // 只比内容——`savedAt` 是落盘墙钟，两次跑必然差 1ms（第一版断言把它一起比了，当场红）。
    const stripSavedAt = (v: string) => v.replace(/"savedAt":\d+/, '"savedAt":0');
    const keyOf = (m: Map<string, string>) => [...m.keys()].sort().join(',');
    expect(keyOf(ms.map)).toBe(keyOf(ps.map));
    expect([...ms.map.values()].sort().map(stripSavedAt)).toEqual([...ps.map.values()].sort().map(stripSavedAt));
  });
});
