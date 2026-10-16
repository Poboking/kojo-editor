/**
 * PERF-12a · **作废后分段复用**（快照未命中那一次重建）。
 *
 * ## 判据①「受控作废复现」——四条触发面各自该看到什么
 * | 触发面 | 制造方式（可复跑，不靠 bump 常量） | 改前 | 改后 |
 * |---|---|---|---|
 * | 版本换代 | 盘上是 `index-v<旧>-*`、找的是 `index-v<新>-*` ⇒ `get` 必然空手 | 整棵重读重扫 | **逐条目 salvage**：元组相符的直接续用 |
 * | 单条目损坏 | 把当前键那份 payload 里 N 条条目的元组改坏 | 一份坏 ⇒ 整体弃用 ⇒ 全树重读 | 只丢那 N 条、只重读那 N 棵 |
 * | rootDir 写法不符 | 同一个根换成反斜杠 / 大小写 / 尾分隔符存盘 | 判成两个项目 ⇒ 全量 | 归一后认项目 ⇒ 条目键跟着归位 |
 * | 语义不可证 | 盘上是 ≤v5 形态（缺 `labels`）/ 换了盘符的根 | 全量重建 | **照旧全量重建**（判据不许为省时间放松） |
 *
 * ## 判据②「分段复用的新数」
 * `readsOf()` 是假 io 的**正文读盘计数**（`readTexts` 命中会话缓存不计），breakdown 行的
 * `reused` / `salvage …(丢 K, 溯源补正 P)` 是插件自己打的读数 ⇒
 * 「改 N 棵 ⇒ 只重读 N 棵」由这两个数直接钉住，不靠人复述。
 *
 * ## 判据③「正确性等价」
 * 每条 salvage 路径都跑一次 `dumpIndex()`，与**同一份盘的全量重建**（空存储域起）对拍：
 * `files`（逐函数深相等）/ `byName` / `references.bySymbol` / `fileMtimes` / `fileSizes` /
 * `fingerprint` 六项逐字相同才算过。反向引用那道**溯源补正**就是为了让这一条在
 * "旁处新增一个函数"时还成立——存量 refs 是在当时的名录下扫的，名录变了就得重扫；
 * 复用只许复用"判据相同"的那部分，不许靠少报省时间。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, ErbIndex, ErbParserService, FileIO, FileStat, GameProject, ScopedStorage } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { nameSetDigest, SNAPSHOT_VERSION, projectRootKey, refsAreReusable, sameProjectRoot, salvageEntries, salvageSnapshot, snapshotKeyCandidatesFor, snapshotKeyFor, encodeEntries, type SnapshotEntry } from '../src/snapshot';
import { makeComputeStub } from './support';

const ROOT = 'D:/proj/eratw';
const KOJO = `${ROOT}/ERB`;
const P1 = `${KOJO}/M_KOJO_K1.ERB`;
const P2 = `${KOJO}/M_KOJO_K2.ERB`;
const P3 = `${KOJO}/M_KOJO_K3.ERB`;

const SRC1 = '@FOO_A\n\tPRINTFORMW 甲。\nRETURN 1\n\n@FOO_B\n\tPRINTFORML 乙。\nRETURN 1\n';
const SRC2 = '@BAR_A\n\tPRINTFORMW 丙。\nRETURN 1\n';
const SRC3 = '@QUX_A\n\tRETURN 1\n\nCALL FOO_C\n';
/** 比 SRC1 多一个函数定义 ⇒ 名录变了（反向引用溯源补正的唯一触发条件） */
const SRC1_NEWFN = SRC1 + '\n@FOO_C\n\tRETURN 1\n';

interface FakeFile {
  text: string;
  mtimeMs: number;
}

/**
 * 假 io（与 `snapshot-flow.test.ts` 同款批量读 + mtime/size 会话文本缓存）。
 *
 * **本文件一律关缓存**（`noCache`）：要量的是"差集里那几棵真的重读了"，
 * 缓存命中会把读盘数抹平成 0，那份证据就不成立（内核侧真有缓存 ⇒ 真实成本只会更低，
 * 关缓存取的是**上界**）。读盘流水 `log` 一路记到底，用例按轮次切片：
 * - `seg.length` ＝ 这一轮真读盘的**次数**（一棵被解析段和引用段各读一遍 ⇒ 计 2）；
 * - `new Set(seg).size` ＝ 这一轮真读盘的**文件棵数**（判据②「改 N 棵 ⇒ 只重读 N 棵」看这个）。
 */
function makeIO(files: Map<string, FakeFile>, opts?: { withMetadata?: boolean; noCache?: boolean }) {
  const log: string[] = [];
  type FakeTextFile = { path: string; text: string; encoding: 'utf-8'; eol: 'lf'; mtimeMs: number };
  const textCache = new Map<string, { mtimeMs: number; size: number; tf: FakeTextFile }>();
  const readOne = (path: string): FakeTextFile => {
    const f = files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    log.push(path);
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
        const cached = opts?.noCache ? undefined : textCache.get(path);
        if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.text.length) {
          out.push(cached.tf);
          continue;
        }
        const tf = readOne(path);
        textCache.set(path, { mtimeMs: f.mtimeMs, size: tf.text.length, tf });
        out.push(tf);
      }
      return out;
    },
    walkDir: async (root: string): Promise<DirEntry[]> =>
      [...files.keys()]
        .filter((p) => p.startsWith(root))
        .map((p) => {
          const f = files.get(p)!;
          const base: DirEntry = { name: p.split('/').pop()!, path: p, isDirectory: false };
          return opts?.withMetadata ? { ...base, mtimeMs: f.mtimeMs, size: f.text.length } : base;
        }),
    stat: async (path: string): Promise<FileStat | null> => {
      const f = files.get(path);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs, isDirectory: false } : null;
    },
  };
  return { io: io as unknown as FileIO, log, readsOf: () => log.length };
}

/** 假存储域（真 JSON 往返；`map` 直接暴露给用例改盘上形态） */
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
        return undefined;
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

function activate(io: FileIO, storage: ScopedStorage, logs?: string[]) {
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
    log: { debug() {}, info: (m: string) => logs?.push(m), warn: (m: string) => logs?.push(m), error() {} },
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
  const waitIndexed = (timeoutMs = 8000): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), timeoutMs);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return { service, bus, waitIndexed };
}

const openAt = (bus: { emit: (t: string, p: unknown) => void }, root: string, kojo: string): void => {
  bus.emit('project.opened', {
    project: { rootDir: root, adapterId: 'eratw', kojoPaths: [kojo], writablePaths: [], charaIndex: new Map() } as GameProject,
  });
};
const openProject = (bus: { emit: (t: string, p: unknown) => void }): void => openAt(bus, ROOT, KOJO);

/** 索引的确定性序列化（判据③的对拍口径；六项缺一不算等价） */
function dumpIndex(idx: ErbIndex): string {
  return JSON.stringify({
    files: [...idx.files.entries()].map(([p, f]) => [p, f.lineCount, f.hasFunctionDirective, f.dims, f.labels ?? null, f.functions]),
    byName: [...idx.byName.entries()].map(([n, refs]) => [n, refs]),
    references: [...(idx.references?.bySymbol.entries() ?? [])].map(([n, list]) => [
      n,
      list.map((r) => [r.filePath, r.line, r.column, r.endColumn, r.kind]),
    ]),
    fileMtimes: [...idx.fileMtimes!.entries()].sort(),
    fileSizes: [...idx.fileSizes!.entries()].sort(),
    fingerprint: idx.fingerprint,
  });
}

/** 从本轮读数行取字段（插件自己打的数，不靠人复述；breakdown 与 salvage 两行一起看） */
function readBreakdown(logs: readonly string[]): {
  reused: number;
  total: number;
  salvaged: number;
  skipped: number;
  provenance: number;
  legacy: number;
  refsRescan: number;
} {
  const text = logs.join('\n');
  const reused = /reused (\d+)\/(\d+)/.exec(text);
  const salv = /index salvage: (\d+)\/\d+ \(丢 (\d+), 溯源补正 (\d+), 旧形态 (\d+)/.exec(text);
  const refs = /refs scan \d+ms \(rescan (\d+)/.exec(text);
  if (!reused || !salv || !refs) throw new Error(`读数行形状不符：${text.slice(0, 400)}`);
  return {
    reused: Number(reused[1]),
    total: Number(reused[2]),
    salvaged: Number(salv[1]),
    skipped: Number(salv[2]),
    provenance: Number(salv[3]),
    legacy: Number(salv[4]),
    refsRescan: Number(refs[1]),
  };
}

async function waitFor(pick: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !pick(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pick()).toBe(true);
}

/** 本轮真读盘的形状（判据②的两条读数）：`passes` = 读盘趟数，`files` = 读到的**不同文件棵数** */
function segOf(log: readonly string[], mark: number): { passes: number; files: number } {
  const seg = log.slice(mark);
  return { passes: seg.length, files: new Set(seg).size };
}

type Payload = { version: number; rootDir: string; savedAt: number; entries: Record<string, unknown[]> };
const diskOf = (map: Map<string, string>, key: string): Payload => JSON.parse(map.get(key)!) as Payload;
const v7key = snapshotKeyFor(ROOT);

/** 全量构建一份**当前版本**的完好 payload（后续用例只改这份盘上形态来制造各条作废面） */
async function seed(files: Map<string, FakeFile>): Promise<{ fs: ReturnType<typeof makeIO>; storage: ScopedStorage; map: Map<string, string> }> {
  const fs = makeIO(files, { withMetadata: true, noCache: true });
  const store = makeStorage();
  const { bus, waitIndexed } = activate(fs.io, store.storage);
  openProject(bus);
  await waitIndexed();
  await waitFor(() => store.map.has(v7key));
  return { fs, storage: store.storage, map: store.map };
}

/** 空存储域从头建一遍（判据③的对照组） */
async function rebuildFromScratch(files: Map<string, FakeFile>): Promise<{ idx: ErbIndex; reads: number }> {
  const fs = makeIO(files, { withMetadata: true, noCache: true });
  const store = makeStorage();
  const { service, bus, waitIndexed } = activate(fs.io, store.storage);
  openProject(bus);
  await waitIndexed();
  return { idx: service.currentIndex()!, reads: fs.readsOf() };
}

describe('PERF-12a 作废后分段复用（受控作废复现 + 等价对拍）', () => {
  it('触发面「版本换代」：盘上是 v6 形态 ⇒ 新键必然空手，结构一棵不重解析（只有 refs 溯源补正扫一趟）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;
    expect(mark).toBe(4); // 关缓存的真·冷建：2 棵 × 两趟（解析段 + 引用段）

    // v6 形态 = 前 9 位逐字同义、只缺第 10 位（refs 名录摘要）⇒ 结构可续用、refs 溯源未知
    const v7 = diskOf(seeded.map, v7key);
    const v6entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(v7.entries)) v6entries[p] = t.slice(0, 9);
    const legacyKey = snapshotKeyFor(ROOT, SNAPSHOT_VERSION - 1);
    seeded.map.delete(v7key);
    seeded.map.set(legacyKey, JSON.stringify({ version: SNAPSHOT_VERSION - 1, rootDir: ROOT, savedAt: 1, entries: v6entries }));

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();

    const r = readBreakdown(logs);
    expect(r.total).toBe(2);
    expect(r.reused).toBe(2); // 元组相符 ⇒ 全部续用（改前这里是 0/2）
    expect(r.salvaged).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.legacy).toBe(1);
    expect(r.provenance).toBe(2); // v6 没记溯源 ⇒ 两条 refs 都要补正（开项目扫，落盘即自愈）
    // 解析段一趟读盘都没有（结构全部续用）；只有 refs 补正扫了这 2 棵
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 2, files: 2 });

    // 自愈闭环：改写回当前键 + 旧键被 prune 收走 ⇒ 下一轮是纯热开，不会再付一次读旧键
    await waitFor(() => diskOf(seeded.map, v7key).version === SNAPSHOT_VERSION && diskOf(seeded.map, v7key).entries[P1]!.length === 10);
    expect(seeded.map.has(legacyKey)).toBe(false);

    // 判据③：与同一份盘的全量重建六项逐字相同
    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));
  });

  it('换代后第二轮 = 纯热开（salvage 归零、溯源补正归零、读数与热路径同形）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const v7 = diskOf(seeded.map, v7key);
    const v6entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(v7.entries)) v6entries[p] = t.slice(0, 9);
    seeded.map.delete(v7key);
    seeded.map.set(snapshotKeyFor(ROOT, SNAPSHOT_VERSION - 1), JSON.stringify({ version: SNAPSHOT_VERSION - 1, rootDir: ROOT, savedAt: 1, entries: v6entries }));

    const firstLogs: string[] = [];
    const first = activate(seeded.fs.io, seeded.storage, firstLogs);
    openProject(first.bus);
    await first.waitIndexed();
    await waitFor(() => diskOf(seeded.map, v7key).entries[P1]!.length === 10);
    expect(readBreakdown(firstLogs).provenance).toBe(2);

    const mark = seeded.fs.log.length;
    const secondLogs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, secondLogs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(secondLogs);
    expect(r.salvaged).toBe(0); // 当前键完好命中 ⇒ 不走 salvage
    expect(r.reused).toBe(2);
    expect(r.provenance).toBe(0); // 名录没变 ⇒ 存量 refs 可信，不再补正
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 0, files: 0 }); // 热开原样零读盘
  });

  it('触发面「单条目损坏」：坏 1 条只丢 1 条，其余照旧复用（改前是整份弃用、全树重读）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
      [P3, { text: SRC3, mtimeMs: 300 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // 只把 P2 那一条改坏（元数不符 = 读不懂这一条），另外两条原样
    const payload = diskOf(seeded.map, v7key);
    payload.entries[P2] = payload.entries[P2]!.slice(0, 4);
    seeded.map.set(v7key, JSON.stringify(payload));

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();

    const r = readBreakdown(logs);
    expect(r.total).toBe(3);
    expect(r.salvaged).toBe(2); // 读得懂的只有 P1 / P3
    expect(r.skipped).toBe(1); // **只有那一条**被判过期
    expect(r.reused).toBe(2);
    expect(seeded.fs.readsOf()).toBe(mark + 2); // 只重读 P2 一棵（解析段 + 引用段各一趟；改前是三棵全读）
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 2, files: 1 });

    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));
  });

  it('触发面「rootDir 写法不符」：反斜杠存的盘 ⇒ 认项目 + 条目键归位，一棵都不重读', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // 同一次开项目，rootDir 写成反斜杠 ⇒ 键与条目路径都换了写法，盘上的 rootDir 也一样
    const backRoot = ROOT.replace(/\//g, '\\');
    const backKojo = KOJO.replace(/\//g, '\\');
    const payload = diskOf(seeded.map, v7key);
    const rekeyed: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(payload.entries)) rekeyed[p.replace(/\//g, '\\')] = t;
    seeded.map.delete(v7key);
    seeded.map.set(snapshotKeyFor(backRoot), JSON.stringify({ ...payload, rootDir: backRoot, kojo: backKojo, entries: rekeyed }));

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();

    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(2);
    expect(r.reused).toBe(2);
    expect(r.provenance).toBe(0); // v7 形态带溯源位、名录没变 ⇒ refs 直接续用
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 0, files: 0 }); // 整轮零读盘（改前：全树重读重扫）
    // 条目键归位到本轮 walkDir 的写法：下游（编辑器 / 校验）拿的路径必须与索引一致
    expect([...second.service.currentIndex()!.files.keys()]).toEqual([P1, P2]);

    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));
  });

  it('触发面「语义不可证」：≤v5 形态 / rootDir 指向别的盘 ⇒ 照旧全量重建（判据不为省时间放松）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // v5 形态：缺第 9 位 labels ⇒ 解析结果本体少字段 ⇒ 一条都不许复用
    const payload = diskOf(seeded.map, v7key);
    const v5entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(payload.entries)) v5entries[p] = t.slice(0, 8);
    seeded.map.delete(v7key);
    seeded.map.set(snapshotKeyFor(ROOT, 5), JSON.stringify({ version: 5, rootDir: ROOT, savedAt: 1, entries: v5entries }));

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(0);
    expect(r.reused).toBe(0);
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 4, files: 2 }); // 全树重读：两趟 × 2 棵（改前改后同形，这条不省）
    expect([...second.service.currentIndex()!.files.keys()]).toEqual([P1, P2]);

    // rootDir 写着别的盘：键认得、条目也完好，但"这份数据属于哪个项目"不可证 ⇒ 一条都不复用
    const seeded2 = await seed(files);
    const mark2 = seeded2.fs.log.length;
    const p2 = diskOf(seeded2.map, v7key);
    seeded2.map.set(
      v7key,
      JSON.stringify({ ...p2, version: SNAPSHOT_VERSION - 1, rootDir: 'F:/proj/eratw', entries: Object.fromEntries(Object.entries(p2.entries).map(([k, t]) => [k, t.slice(0, 9)])) }),
    );
    const logs2: string[] = [];
    const third = activate(seeded2.fs.io, seeded2.storage, logs2);
    openProject(third.bus);
    await third.waitIndexed();
    const r2 = readBreakdown(logs2);
    expect(r2.salvaged).toBe(0);
    expect(r2.reused).toBe(0);
    expect(segOf(seeded2.fs.log, mark2)).toEqual({ passes: 4, files: 2 }); // 也是全树重读
    expect(logs2.some((m) => m.includes('Index snapshot unusable'))).toBe(true); // fail-closed 的老规矩照旧开口
  });

  it('「改 N 棵 ⇒ 只重读 N 棵」：12 棵盘里坏 3 条 + 摸 2 棵 ⇒ 读盘 12+5、复用 7', async () => {
    const files = new Map<string, FakeFile>();
    for (let i = 0; i < 12; i++) files.set(`${KOJO}/M_KOJO_P${i}.ERB`, { text: `@NAME_${i}\n\tRETURN 1\n`, mtimeMs: 1000 + i });
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;
    expect(mark).toBe(24); // 关缓存：12 棵 × 两趟

    const payload = diskOf(seeded.map, v7key);
    const paths = Object.keys(payload.entries);
    // 差集 = 3 条读不懂 + 2 棵 mtime 变了
    for (const p of [paths[0]!, paths[3]!, paths[7]!]) payload.entries[p] = payload.entries[p]!.slice(0, 3);
    seeded.map.set(v7key, JSON.stringify(payload));
    for (const p of [`${KOJO}/M_KOJO_P5.ERB`, `${KOJO}/M_KOJO_P11.ERB`]) {
      const f = files.get(p)!;
      files.set(p, { text: f.text, mtimeMs: f.mtimeMs + 7 });
    }

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openAt(second.bus, ROOT, KOJO);
    await second.waitIndexed();

    const r = readBreakdown(logs);
    expect(r.total).toBe(12);
    expect(r.salvaged).toBe(9); // 条目级复用计数 > 0（判据②的直接证据）
    expect(r.skipped).toBe(3);
    expect(r.reused).toBe(7);
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 10, files: 5 }); // 只重读差集那 5 棵（改前：12 棵全读）
    expect(r.provenance).toBe(0); // 名录没变（正文一字未动）⇒ 存量 refs 可信
    expect(r.refsRescan).toBe(5); // 新读的 5 棵才扫 refs

    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));
  });

  it('溯源补正：旁处新增一个函数 ⇒ 未变文件的存量 refs 补扫，与全量重扫逐条目相同', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
      [P3, { text: SRC3, mtimeMs: 300 }], // P3 里有一行 `CALL FOO_C`，而 FOO_C 此刻还不存在
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    const payload = diskOf(seeded.map, v7key);
    payload.entries[P2] = payload.entries[P2]!.slice(0, 3); // 制造 salvage 轮（P2 整棵重读）
    seeded.map.set(v7key, JSON.stringify(payload));
    // 旁处新增定义：P1 多出 @FOO_C ⇒ 名录变了，P3 正文没变但它的 refs 缺一条边
    files.set(P1, { text: SRC1_NEWFN, mtimeMs: 900 });

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();

    const r = readBreakdown(logs);
    expect(r.skipped).toBe(1);
    expect(r.reused).toBe(1); // P3 文件本身可复用
    expect(r.provenance).toBe(1); // 但它的 refs 溯源对不上 ⇒ 就地补扫
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 5, files: 3 }); // 解析段 2 棵 + 引用段 3 棵（含补扫的那 1 棵）
    expect(second.service.currentIndex()!.references!.bySymbol.has('FOO_C')).toBe(true);
    expect(second.service.currentIndex()!.references!.bySymbol.get('FOO_C')!.map((x) => x.filePath)).toEqual([P1, P3]);

    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));
  });

  /**
   * **既有形状的钉子**（不是本批的功劳，也不许本批顺手改口径）：
   * 热路径（当前键完好命中）不做溯源补正 ⇒ "旁处新增一个函数"时未变文件的存量 refs 仍缺边。
   * 这道洞 v4 起就在，补它要拿开项目段的一次全树重扫（真语料 ~7.4 s）换，属另一批的取舍；
   * 本批只保证 **salvage 轮**与全量重扫逐条目等价，并把这条差异钉成用例，别让它假装不存在。
   */
  it('热路径不补扫（既有口径）：名录变了仍复用存量 refs ⇒ 与 salvage 轮的差在这里', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
      [P3, { text: SRC3, mtimeMs: 300 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;
    files.set(P1, { text: SRC1_NEWFN, mtimeMs: 900 }); // 只改 P1：热路径（当前键完好）⇒ 不进 salvage

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(0); // 没作废 ⇒ 走的就是改动前那条热路径
    expect(r.reused).toBe(2);
    expect(r.provenance).toBe(0); // ← 补正只在 salvage 轮发生（既有口径）
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 2, files: 1 }); // 只重读 P1 一棵
  });

  it('salvage 轮落盘的条目带上名录摘要（下一轮才认得出"名录没变"）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const payload = diskOf(seeded.map, v7key);
    payload.entries[P2] = payload.entries[P2]!.slice(0, 5); // 坏一条 ⇒ 进 salvage 轮
    seeded.map.set(v7key, JSON.stringify(payload));

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    await waitFor(() => diskOf(seeded.map, v7key).entries[P2]!.length === 10 && diskOf(seeded.map, v7key).entries[P2]![9] !== null);

    const saved = diskOf(seeded.map, v7key);
    const expectFp = nameSetDigest(second.service.currentIndex()!.byName.keys());
    expect(saved.entries[P1]![9]).toBe(expectFp); // 补正过的复用条目也带上了当前摘要
    expect(saved.entries[P2]![9]).toBe(expectFp); // 本轮新扫的条目同样记账
    expect(readBreakdown(logs).salvaged).toBe(1);
  });
});

describe('PERF-12a salvage 判据（纯函数）', () => {
  const entryOf = (path: string, names: readonly string[], refs?: unknown): SnapshotEntry =>
    ({
      mtimeMs: 1,
      size: 2,
      textLength: 3,
      file: { path, functions: [], dims: [], hasFunctionDirective: false, lineCount: 1 },
      ...(refs === undefined ? {} : { refs: refs as never }),
    }) as unknown as SnapshotEntry;

  it('nameSetDigest 顺序无关、对增删敏感、落在安全整数区', () => {
    const a = nameSetDigest(['FOO', 'BAR', 'Baz_元']);
    const b = nameSetDigest(['Baz_元', 'BAR', 'FOO']);
    expect(a).toBe(b);
    expect(nameSetDigest(['FOO', 'BAR'])).not.toBe(a);
    expect(nameSetDigest(['FOO', 'BAR', 'BAZ'])).not.toBe(a);
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(nameSetDigest([])).toBe(nameSetDigest([]));
  });

  it('sameProjectRoot 只归一写法，不归一位置', () => {
    expect(sameProjectRoot('D:\\Game\\eratw\\', 'D:/Game/eratw')).toBe(true);
    expect(sameProjectRoot('d:/game/eratw', 'D:/Game/eratw')).toBe(true);
    expect(sameProjectRoot('D:/Game/eratw', 'E:/Game/eratw')).toBe(false);
    expect(sameProjectRoot('D:/Game/eratw', 'D:/Game/eratw2')).toBe(false);
    expect(projectRootKey('D:\\a\\b\\')).toBe('d:/a/b');
  });

  it('snapshotKeyCandidatesFor：当前键在第一位，含版本 × 写法变体，且不含非快照形态', () => {
    const cands = snapshotKeyCandidatesFor('D:/proj/eratw');
    expect(cands[0]).toBe(snapshotKeyFor('D:/proj/eratw'));
    expect(cands).toContain(snapshotKeyFor('D:\\proj\\eratw', SNAPSHOT_VERSION - 1));
    expect(cands).toContain(snapshotKeyFor('d:/proj/eratw', SNAPSHOT_VERSION));
    expect(new Set(cands).size).toBe(cands.length);
    for (const k of cands) expect(k).toMatch(/^index-v\d+-[0-9a-f]{8}$/);
  });

  it('salvageEntries：坏一条只丢一条；旧形态补 null 溯源位（不猜值）', () => {
    const good = encodeEntries({ '/a.ERB': entryOf('/a.ERB', []) });
    const raw: Record<string, unknown> = JSON.parse(JSON.stringify(good));
    raw['/a.ERB'] = (raw['/a.ERB'] as unknown[]).slice(0, 5); // 元数不符
    raw['/bad.ERB'] = { not: 'a tuple' };
    const out = salvageEntries(raw, 10)!;
    expect(out.skipped).toBe(2);
    expect(Object.keys(out.entries)).toEqual([]);
    const onlyGood = salvageEntries(JSON.parse(JSON.stringify(good)), 10)!;
    expect(onlyGood.skipped).toBe(0);
    expect(onlyGood.entries['/a.ERB']).toBeDefined();

    const legacy = salvageEntries({ '/a.ERB': (JSON.parse(JSON.stringify(good))['/a.ERB'] as unknown[]).slice(0, 9) }, 9)!;
    expect(legacy.entries['/a.ERB']!.refsNamesFp).toBeUndefined(); // 第 10 位缺 = 未知，不编造
    expect(refsAreReusable(legacy.entries['/a.ERB']!, nameSetDigest([]))).toBe(false);
    // 元组对象仍是盘上那一个（落盘快路径不被 salvage 打断）
    const parsed = JSON.parse(JSON.stringify(good)) as Record<string, unknown[]>;
    expect(salvageEntries(parsed, 10)!.entries['/a.ERB']).toBeDefined();
  });

  it('salvageSnapshot：版本表外 / 项目根不符 / savedAt 坏 ⇒ null；knownPaths 负责把条目键归位', () => {
    const payload = {
      version: SNAPSHOT_VERSION - 1,
      rootDir: 'D:\\proj\\eratw',
      savedAt: 1,
      entries: { 'D:\\proj\\eratw\\ERB\\a.ERB': (JSON.parse(JSON.stringify(encodeEntries({ 'D:/proj/eratw/ERB/a.ERB': entryOf('D:/x', []) })))['D:/proj/eratw/ERB/a.ERB'] as unknown[]).slice(0, 9) },
    };
    const opts = { rootDir: ROOT, key: snapshotKeyFor(ROOT), knownPaths: ['D:/proj/eratw/ERB/a.ERB'] };
    const s = salvageSnapshot(payload, opts)!;
    expect(s.legacy).toBe(true);
    expect(s.skipped).toBe(0);
    expect(Object.keys(s.entries)).toEqual(['D:/proj/eratw/ERB/a.ERB']); // 归位到本轮 walkDir 的写法
    expect(s.entries['D:/proj/eratw/ERB/a.ERB']!.file.path).toBe('D:/proj/eratw/ERB/a.ERB');
    // 表外版本 / 不同根 / savedAt 非数 ⇒ 一律 null
    expect(salvageSnapshot({ ...payload, version: 5 }, opts)).toBeNull();
    expect(salvageSnapshot({ ...payload, rootDir: 'Z:/elsewhere' }, opts)).toBeNull();
    expect(salvageSnapshot({ ...payload, savedAt: 'x' }, opts)).toBeNull();
    expect(salvageSnapshot(null, opts)).toBeNull();
    // 不给 knownPaths ⇒ 原键留下（认不出就不归位，绝不对号入座）
    expect(Object.keys(salvageSnapshot(payload, { rootDir: ROOT, key: 'k' })!.entries)).toEqual(['D:\\proj\\eratw\\ERB\\a.ERB']);
  });

  it('refsAreReusable：摘要相同才续用；摘要未知/不同都判可疑', () => {
    const fp = nameSetDigest(['FOO']);
    const e = entryOf('/a.ERB', []);
    expect(refsAreReusable({ ...e, refs: [], refsNamesFp: fp }, fp)).toBe(true);
    expect(refsAreReusable({ ...e, refs: [], refsNamesFp: fp + 1 }, fp)).toBe(false);
    expect(refsAreReusable({ ...e, refs: [] }, fp)).toBe(false); // 溯源未知
    expect(refsAreReusable({ ...e, refsNamesFp: fp }, fp)).toBe(false); // 没有 refs 谈不上复用
  });
});
