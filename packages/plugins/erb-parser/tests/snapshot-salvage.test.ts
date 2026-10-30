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
import { candidateHash, decodeCandidateHashes, nameSetDigest, SNAPSHOT_VERSION, coerceSnapshot, countEntries, projectRootKey, refsAreReusable, sameProjectRoot, salvageEntries, salvageSnapshot, snapshotKeyCandidatesFor, snapshotKeyFor, encodeEntries, verifiedNamesDigest, type SnapshotEntry } from '../src/snapshot';
import { makeComputeStub } from './support';

/**
 * 版本号**显式写死**，不用 `SNAPSHOT_VERSION - n`。
 *
 * 这个文件里 `-1`/`-2` 曾被当成"上一版 / 上上版"用了 8 处，v11→v12 一 bump 全部错位：
 * 想测"表外旧版不复用"的用例落到了表内的 v10 上——条目元数不符仍然 `skipped`，
 * **测试照绿但测的是另一件事**。这类"绿得没道理"的用例比红的危险得多。
 */
/** 表外最年轻的一代（v9 及更早一律不复用：#DIM 族修复改了 `dims.name` 的口径） */
const V_LEGACY = 9;
/** 表内最老的一代（v10：同形 + 缺第 11 位 ⇒ 候选未知、refs 补扫一遍） */
const V10 = 10;
/** 表内次新的一代（v12：同形 + 候选位哈希 base64，但**引用流水仍是四元组数组**） */
const V12 = 12;
/** 上一代（v14：函数元组是"一函数一枚 7 元组"、候选哈希 32 位） */
const V14 = 14;

const ROOT = 'D:/proj/eratw';
const KOJO = `${ROOT}/ERB`;
const P1 = `${KOJO}/M_KOJO_K1.ERB`;
const P2 = `${KOJO}/M_KOJO_K2.ERB`;
const P3 = `${KOJO}/M_KOJO_K3.ERB`;

/**
 * 把 v13 的**扁平**引用流水改写成 v12 及更早的「一条一枚四元组」。
 *
 * 为什么必须有这一步：v12 及更早的盘上，第 8 位真的是 `[[name,line,col,kind], …]`。
 * 拿当前版本的 `encodeEntries` 产出一份 payload、再 `slice()` 成旧位数的做法（本文件此前的
 * 造法）在**换了存放形态之后就不成立**了——那样造出来的是"旧版本号 + 新形态"，
 * 只会验到"校验器把它丢了"，验不到迁移（PITFALLS 266 的同款假绿：测的是另一件事）。
 * 生产侧没有这个形态，所以摊回去只住在这里。
 */
function refsAsTuples(flat: unknown): [string, number, number, number][] {
  const src = flat as readonly (string | number)[];
  const out: [string, number, number, number][] = [];
  for (let i = 0; i < src.length; i += 4) {
    out.push([src[i] as string, src[i + 1] as number, src[i + 2] as number, src[i + 3] as number]);
  }
  return out;
}

/**
 * 把 v15 的**函数扁平流水**改写成 v14 及更早的「一函数一枚 7 元组」（与 `refsAsTuples` 同一条理由：
 * 拿当前产出 slice 成旧位数造出来的是"旧版本号 + 新形态"，只会验到"校验器把它丢了"）。
 *
 * `paramsAsTuples` 跟版本表走：v13 及更早的形参也是"一参一枚二元组"。
 */
function fnsAsTuples(flat: unknown, paramsAsTuples: boolean): unknown[][] {
  const src = flat as readonly unknown[];
  const out: unknown[][] = [];
  for (let i = 0; i < src.length; i += 7) {
    const run = src[i + 3] as readonly (string | number)[];
    const params = paramsAsTuples ? paramTuplesOf(run) : run;
    const doc = src[i + 5];
    const col = src[i + 6] as number;
    const base = [src[i], src[i + 1], src[i + 2], params, src[i + 4]];
    if (col !== 0) out.push([...base, doc ?? null, col]);
    else if (typeof doc === 'string') out.push([...base, doc]);
    else out.push(base);
  }
  return out;
}

/** 扁平形参流水 → 「一参一枚二元组」（v13 及更早的盘上形态） */
function paramTuplesOf(run: readonly (string | number)[]): [string, 0 | 1][] {
  const out: [string, 0 | 1][] = [];
  for (let i = 0; i < run.length; i += 2) out.push([run[i] as string, run[i + 1] as 0 | 1]);
  return out;
}

/**
 * 32 位哈希集的 base64（v12~v14 的盘上形态）。生产侧已经不再产出它（v15 起 16 位），
 * 所以"写回旧形态"这件事只住在测试里——用 `Buffer` 免得再抄一份手写 base64。
 */
function encodeHashes32(words: readonly number[]): string {
  const bytes = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    const v = words[i]! >>> 0;
    bytes[i * 4] = (v >>> 24) & 0xff;
    bytes[i * 4 + 1] = (v >>> 16) & 0xff;
    bytes[i * 4 + 2] = (v >>> 8) & 0xff;
    bytes[i * 4 + 3] = v & 0xff;
  }
  return Buffer.from(bytes).toString('base64');
}

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
  candidatesClean: number;
  legacy: number;
  refsRescan: number;
} {
  const text = logs.join('\n');
  const reused = /reused (\d+)\/(\d+)/.exec(text);
  const salv = /index salvage: (\d+)\/\d+ \(丢 (\d+), 溯源补正 (\d+)(?:, 候选免扫 (\d+))?, 旧形态 (\d+)/.exec(text);
  const refs = /refs scan \d+ms \(rescan (\d+)/.exec(text);
  if (!reused || !salv || !refs) throw new Error(`读数行形状不符：${text.slice(0, 400)}`);
  return {
    reused: Number(reused[1]),
    total: Number(reused[2]),
    salvaged: Number(salv[1]),
    skipped: Number(salv[2]),
    provenance: Number(salv[3]),
    candidatesClean: salv[4] === undefined ? 0 : Number(salv[4]),
    legacy: Number(salv[5]),
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
  it('触发面「版本换代」：盘上 v7（口径外代）⇒ 一条不续用、全量重建（逗号形修复改了解析口径，fail-closed）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;
    expect(mark).toBe(4); // 关缓存的真·冷建：2 棵 × 两趟（解析段 + 引用段）

    // 表外版本形态 = 缺尾部位。但 v9 的上一代不在 SALVAGEABLE_VERSIONS
    // （v10 的 #DIM 族修复改了 dims.name 的值语义）⇒ 结构也不许续用（复用 = 索引脏数据）
    const vPrev = diskOf(seeded.map, v7key);
    const v9entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(vPrev.entries)) v9entries[p] = t.slice(0, 9);
    const legacyKey = snapshotKeyFor(ROOT, V_LEGACY);
    seeded.map.delete(v7key);
    seeded.map.set(legacyKey, JSON.stringify({ version: V_LEGACY, rootDir: ROOT, savedAt: 1, entries: v9entries }));

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();

    const r = readBreakdown(logs);
    expect(r.total).toBe(2);
    expect(r.reused).toBe(0); // 版本表外 ⇒ 结构一并作废（改前 v6 同义时代这里是 2）
    expect(r.salvaged).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.legacy).toBe(0); // 表外版本连 salvage 都不启动（salvaged=null ⇒ 无「旧形态」记账）
    expect(r.provenance).toBe(0); // 没有续用条目 ⇒ 无补正可言
    // 全树重读：两趟 × 2 棵（口径换代的钱必须付，判据不为省时间放松）
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 4, files: 2 });

    // 自愈闭环：重读写回当前键 + 旧键被 prune 收走 ⇒ 下一轮是纯热开，不会再付一次读旧键
    await waitFor(() => diskOf(seeded.map, v7key).version === SNAPSHOT_VERSION && diskOf(seeded.map, v7key).entries[P1]!.length === 11);
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
    const vPrev = diskOf(seeded.map, v7key);
    const v9entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(vPrev.entries)) v9entries[p] = t.slice(0, 9);
    seeded.map.delete(v7key);
    seeded.map.set(snapshotKeyFor(ROOT, V_LEGACY), JSON.stringify({ version: V_LEGACY, rootDir: ROOT, savedAt: 1, entries: v9entries }));

    const firstLogs: string[] = [];
    const first = activate(seeded.fs.io, seeded.storage, firstLogs);
    openProject(first.bus);
    await first.waitIndexed();
    await waitFor(() => diskOf(seeded.map, v7key).entries[P1]!.length === 11);
    // 第一轮对上一代盘是全量重建（口径外代 fail-closed）：新扫的 refs 恒带溯源 ⇒ 补正计数为 0
    expect(readBreakdown(firstLogs).provenance).toBe(0);

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

  it('v10 迁移（REFS-PROVENANCE）：条目结构续用、refs 补扫一遍收候选；下一轮起纯热', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // v10 盘：条目只有前 10 位（候选集还没这回事），版本号 -1（v10 在准入表：同形 + 缺第 11 位）
    const v10 = diskOf(seeded.map, v7key) as Payload & { namesFp?: number | null };
    const v10entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(v10.entries)) {
      const copy = t.slice(0, 10);
      copy[7] = refsAsTuples(t[7]); // v10 的盘上形态：引用流水是四元组数组
      copy[5] = fnsAsTuples(t[5], true); // 且函数是 7 元组、形参是二元组
      v10entries[p] = copy;
    }
    seeded.map.delete(v7key);
    seeded.map.set(
      snapshotKeyFor(ROOT, V10),
      JSON.stringify({ version: V10, rootDir: ROOT, savedAt: 1, namesFp: v10.namesFp, entries: v10entries }),
    );

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(2); // 条目结构逐字认识 ⇒ 全部续用（不复读重解析）
    expect(r.skipped).toBe(0);
    expect(r.reused).toBe(2);
    // 候选未知（准入纪律 3 的保守侧）⇒ refs 补扫一遍**顺带收候选**：这就是可见的迁移路径，
    // 一次性付清（解析段零读盘：结构没作废），此后逐轮热
    expect(r.provenance).toBe(2);
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 2, files: 2 });

    // 落盘的条目已是 11 位且候选集记账（'' 也是事实），溯源摘要随新扫记账
    await waitFor(() => diskOf(seeded.map, v7key).entries[P1]!.length === 11);
    const savedP2 = diskOf(seeded.map, v7key).entries[P2]!;
    expect(typeof savedP2[10]).toBe('string');

    // 正确性等价：迁移轮的索引与全量重建六项逐字相同
    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));

    // 下一轮：纯热开（名录没变 + 候选已收 ⇒ 免扫判据有据可查），一次读盘都不付
    const mark2 = seeded.fs.log.length;
    const logs2: string[] = [];
    const third = activate(seeded.fs.io, seeded.storage, logs2);
    openProject(third.bus);
    await third.waitIndexed();
    const r2 = readBreakdown(logs2);
    expect(r2.reused).toBe(2);
    expect(r2.provenance).toBe(0);
    expect(r2.refsRescan).toBe(0);
    expect(segOf(seeded.fs.log, mark2)).toEqual({ passes: 0, files: 0 });
  });

  it('v11 → v12 迁移（MEM-6）：候选位只换编码 ⇒ **一个文件都不重扫**（与 v10 的保守侧重扫正相反）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // 把盘上这份 v12 改写成 v11 形态：第 11 位写回 `'\n'` 连接的**记号串**。
    // v11 的候选集就是"构建 refs 时问过 hasName 的一切记号"，这里用两份源码里真实出现的名字。
    const cur = diskOf(seeded.map, v7key) as Payload & { namesFp?: number | null };
    const tokensOf: Record<string, readonly string[]> = {
      [P1]: ['FOO_A', 'FOO_B', 'PRINTFORMW', 'RETURN'],
      [P2]: ['BAR_A', 'PRINTFORMW', 'RETURN'],
    };
    const v11entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(cur.entries)) {
      const copy = t.slice();
      copy[7] = refsAsTuples(t[7]); // v11 的盘上形态：引用流水是四元组数组
      copy[5] = fnsAsTuples(t[5], true); // 函数是 7 元组、形参是二元组
      copy[10] = (tokensOf[p] ?? []).join('\n');
      v11entries[p] = copy;
    }
    seeded.map.delete(v7key);
    seeded.map.set(
      snapshotKeyFor(ROOT, 11),
      JSON.stringify({ version: 11, rootDir: ROOT, savedAt: 1, namesFp: cur.namesFp, entries: v11entries }),
    );

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(2); // 结构逐字认识 ⇒ 全部续用
    expect(r.skipped).toBe(0);
    expect(r.reused).toBe(2);
    // ★ 与上面 v10 用例的**唯一差别**：v10 缺位 ⇒ 候选未知 ⇒ 保守侧重扫（provenance=2）；
    // v11 只换了编码 ⇒ 就地哈希即可 ⇒ 零重扫。这条差异是"免费迁移"这个说法的判据。
    expect(r.provenance).toBe(0);
    expect(r.refsRescan).toBe(0);
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 0, files: 0 }); // 一次读盘都不付

    // 迁移把记号串**就地哈希**，成员语义逐条不变（不是"随便造了个非空数组"）
    const snap = second.service.snapshotForDebug?.() as { entries: Record<string, { candidateHashes?: Uint16Array }> } | null;
    expect(snap).not.toBeNull();
    expect(Array.from(snap!.entries[P1]!.candidateHashes!)).toEqual(tokensOf[P1]!.map(candidateHash));
    expect(Array.from(snap!.entries[P2]!.candidateHashes!)).toEqual(tokensOf[P2]!.map(candidateHash));

    // 正确性等价：迁移轮的索引与全量重建逐字相同
    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));

    // 落盘已是 v12（新键），第 11 位是 base64（**不是**记号串）
    await waitFor(() => diskOf(seeded.map, v7key).entries[P1]!.length === 11);
    const savedP1 = diskOf(seeded.map, v7key).entries[P1]!;
    expect(typeof savedP1[10]).toBe('string');
    expect(savedP1[10]).not.toContain('\n'); // 记号串是 `\n` 连接的，base64 不可能含它
  });

  it('v12 → v13 迁移（MEM-7）：引用流水只换存放形态 ⇒ **一个文件都不重扫**，且逐条同值', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // 把盘上这份 v13 改写成 v12 形态：第 8 位写回「一条一枚四元组」。
    // v12 与 v13 的**唯一**差异就是这一位的存放形态（字段顺序、语义、排序一字未改）。
    const cur = diskOf(seeded.map, v7key) as Payload & { namesFp?: number | null };
    const v12entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(cur.entries)) {
      const copy = t.slice();
      copy[7] = refsAsTuples(t[7]);
      copy[5] = fnsAsTuples(t[5], true); // v12 的函数是 7 元组、形参是二元组
      // v12 的候选位是 32 位哈希的 base64（v15 起是 16 位）——旧字宽是**版本的一部分**，
      // 不写回的话版本表会按 32 位去解 16 位的串 ⇒ 字节数不是 4 的倍数 ⇒ 整条判损坏。
      copy[10] = encodeHashes32(Array.from(decodeCandidateHashes(t[10] as string)!).map((v) => v << 16));
      v12entries[p] = copy;
    }
    seeded.map.delete(v7key);
    seeded.map.set(
      snapshotKeyFor(ROOT, V12),
      JSON.stringify({ version: V12, rootDir: ROOT, savedAt: 1, namesFp: cur.namesFp, entries: v12entries }),
    );

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(2); // 结构逐字认识 ⇒ 全部续用
    expect(r.skipped).toBe(0);
    expect(r.reused).toBe(2);
    // ★ 与 v10 用例正相反：v12 只是换了存放形态 ⇒ 就地摊平即可 ⇒ 零重扫、零读盘
    expect(r.provenance).toBe(0);
    expect(r.refsRescan).toBe(0);
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 0, files: 0 });

    // 迁移把四元组**就地摊平**，逐条逐字段不变（不是"随便造了个非空数组"）
    const snap = second.service.snapshotForDebug?.() as
      | { entries: Record<string, { refs?: readonly (string | number)[] }> }
      | null;
    expect(snap).not.toBeNull();
    const flat1 = snap!.entries[P1]!.refs!;
    expect(flat1.length % 4).toBe(0);
    expect(flat1.length).toBeGreaterThan(0); // 反恒真：真的搬过来了一串引用
    expect(refsAsTuples(flat1)).toEqual(v12entries[P1]![7]); // v12 的盘上形态就是四元组数组

    // 正确性等价：迁移轮的索引与全量重建逐字相同（含 bySymbol 的每条边）
    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(second.service.currentIndex()!)).toBe(dumpIndex(cold.idx));

    // 落盘已是 v13（新键），第 8 位是扁平流水（**不再**是四元组数组）
    await waitFor(() => diskOf(seeded.map, v7key).entries[P1]!.length === 11);
    const savedP1 = diskOf(seeded.map, v7key).entries[P1]!;
    expect(Array.isArray(savedP1[7])).toBe(true);
    expect((savedP1[7] as unknown[]).every((x) => Array.isArray(x))).toBe(false);
  });

  it('v14 → v15 迁移（MEM-15）：函数元组摊平 + 候选哈希截 16 位 ⇒ **一个文件都不重扫**，且逐条同值', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const seeded = await seed(files);
    const mark = seeded.fs.log.length;

    // 把盘上这份 v15 改写成 v14 形态：函数位写回「一函数一枚 7 元组」（形参已是扁平流水），
    // 候选位写回 32 位哈希的 base64（= 16 位值左移 16 位，截断后逐枚相同）。
    const cur = diskOf(seeded.map, v7key) as Payload & { namesFp?: number | null };
    const v14entries: Record<string, unknown[]> = {};
    for (const [p, t] of Object.entries(cur.entries)) {
      const copy = t.slice();
      copy[5] = fnsAsTuples(t[5], false);
      const words16 = Array.from(decodeCandidateHashes(t[10] as string)!);
      copy[10] = encodeHashes32(words16.map((v) => v << 16));
      v14entries[p] = copy;
    }
    seeded.map.delete(v7key);
    seeded.map.set(
      snapshotKeyFor(ROOT, V14),
      JSON.stringify({ version: V14, rootDir: ROOT, savedAt: 1, namesFp: cur.namesFp, entries: v14entries }),
    );

    const logs: string[] = [];
    const second = activate(seeded.fs.io, seeded.storage, logs);
    openProject(second.bus);
    await second.waitIndexed();
    const r = readBreakdown(logs);
    expect(r.salvaged).toBe(2); // 结构逐字认识 ⇒ 全部续用
    expect(r.skipped).toBe(0);
    expect(r.reused).toBe(2);
    // 两处都只换存放形态 ⇒ 零重扫、零读盘（与 v10 的保守侧重扫正相反）
    expect(r.provenance).toBe(0);
    expect(r.refsRescan).toBe(0);
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 0, files: 0 });

    // 迁移逐条同值：函数流水的 7 格还原成 `ErbFunction` 后与全量重建逐字段相同
    // （docComment / nameColumn / params 都在这条里；`dumpIndex` 只比名字与行）
    const hot = second.service.currentIndex()!;
    const cold = await rebuildFromScratch(files);
    expect(hot.files.get(P1)!.functions).toEqual(cold.idx.files.get(P1)!.functions);
    expect(dumpIndex(hot)).toBe(dumpIndex(cold.idx));

    // 落盘已是 v15（新键）：函数位是扁平流水（**不再**是元组数组）、候选位是 16 位哈希的 base64
    await waitFor(() => diskOf(seeded.map, v7key).entries[P1]!.length === 11);
    const savedP1 = diskOf(seeded.map, v7key).entries[P1]!;
    expect(Array.isArray(savedP1[5])).toBe(true);
    expect((savedP1[5] as unknown[]).every((x) => Array.isArray(x))).toBe(false);
    expect(decodeCandidateHashes(savedP1[10] as string)!.constructor).toBe(Uint16Array);
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
      JSON.stringify({ ...p2, version: V_LEGACY, rootDir: 'F:/proj/eratw', entries: Object.fromEntries(Object.entries(p2.entries).map(([k, t]) => [k, t.slice(0, 9)])) }),
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
   * PS-3 → REFS-PROVENANCE：热路径的溯源巡检从"名录一变全树补扫"细化到"逐文件可证免扫"。
   * 改前（PS-3 口径）：名录摘要一变，P2/P3 的溯源位全部跟不上 ⇒ 未变文件也整棵补扫
   * （这条用例的前身正是"改前会红"的证物：热轮不补扫 ⇒ find-references 静默缺边）。
   * 本批：条目第 11 位记了**候选记号集**，名录对称差 = {FOO_C}——P2 的正文里根本没有
   * FOO_C 这个记号 ⇒ 可证明 refs 逐字节不变 ⇒ **免扫、只盖章**（候选免扫 1）；
   * P3 有一行 `CALL FOO_C` ⇒ 嫌疑坐实 ⇒ 就地补扫并与新摘要一起记账。
   * 正确性不放松：该补的边（P3 → FOO_C）一条不少，与全量重建六项逐字相同。
   */
  it('热路径溯源巡检（REFS-PROVENANCE）：名录变了 ⇒ 候选命中的补扫、候选可证未知的免扫盖章；下一轮信封命中零补扫', async () => {
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
    expect(r.salvaged).toBe(0); // 没作废 ⇒ 走的就是热路径
    expect(r.reused).toBe(2);
    expect(r.candidatesClean).toBe(1); // P2 候选集与 {FOO_C} 不相交 ⇒ 免扫、只补记新摘要
    expect(r.provenance).toBe(1); // P3 的候选里有 FOO_C（CALL FOO_C）⇒ 就地补扫
    expect(r.refsRescan).toBe(2); // 补扫的 1 棵 + 新解析的 P1
    expect(segOf(seeded.fs.log, mark)).toEqual({ passes: 3, files: 2 }); // 解析段 P1 + 引用段 P1/P3

    // 正确性主判据：P3 正文没变、名录变了——`CALL FOO_C` 这条边必须在（改前这里缺边）
    const idx2 = second.service.currentIndex()!;
    expect(idx2.references!.bySymbol.get('FOO_C')!.map((x) => x.filePath)).toEqual([P1, P3]);
    const cold = await rebuildFromScratch(files);
    expect(dumpIndex(idx2)).toBe(dumpIndex(cold.idx)); // 六项逐字：热轮增量 = 全量重建

    // 闭环：信封摘要已随这轮落盘 ⇒ 第三轮纯热、一次读盘都不付、补正归零
    await waitFor(() => {
      const p = diskOf(seeded.map, v7key) as Payload & { namesFp?: number | null };
      return p.namesFp === nameSetDigest(idx2.byName.keys());
    });
    const mark3 = seeded.fs.log.length;
    const logs3: string[] = [];
    const third = activate(seeded.fs.io, seeded.storage, logs3);
    openProject(third.bus);
    await third.waitIndexed();
    const r3 = readBreakdown(logs3);
    expect(r3.provenance).toBe(0); // 信封命中 ⇒ 连逐条目巡检都不走
    expect(r3.refsRescan).toBe(0);
    expect(segOf(seeded.fs.log, mark3)).toEqual({ passes: 0, files: 0 });
    expect(dumpIndex(third.service.currentIndex()!)).toBe(dumpIndex(cold.idx));
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
    await waitFor(() => diskOf(seeded.map, v7key).entries[P2]!.length === 11 && diskOf(seeded.map, v7key).entries[P2]![9] !== null);

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
    expect(sameProjectRoot('D:\\games\\eratw\\', 'D:/games/eratw')).toBe(true);
    expect(sameProjectRoot('d:/games/eratw', 'D:/games/eratw')).toBe(true);
    expect(sameProjectRoot('D:/games/eratw', 'E:/games/eratw')).toBe(false);
    expect(sameProjectRoot('D:/games/eratw', 'D:/games/eratw2')).toBe(false);
    expect(projectRootKey('D:\\a\\b\\')).toBe('d:/a/b');
  });

  it('snapshotKeyCandidatesFor：当前键在第一位，含版本 × 写法变体，且不含非快照形态', () => {
    const cands = snapshotKeyCandidatesFor('D:/proj/eratw');
    expect(cands[0]).toBe(snapshotKeyFor('D:/proj/eratw'));
    // 候选只认表内版本（表里现在有 10/11/12 ⇒ "上一代"不再是单个数字，写死）：
    // v11/v10 已入表（同形迁移），v9 不在表 ⇒ 表外那一代不进候选
    expect(cands).toContain(snapshotKeyFor('D:\\proj\\eratw', 11));
    expect(cands).toContain(snapshotKeyFor('D:\\proj\\eratw', V10));
    expect(cands).not.toContain(snapshotKeyFor('D:\\proj\\eratw', V_LEGACY));
    expect(cands).toContain(snapshotKeyFor('d:/proj/eratw', SNAPSHOT_VERSION));
    expect(new Set(cands).size).toBe(cands.length);
    for (const k of cands) expect(k).toMatch(/^index-v\d+-[0-9a-f]{8}$/);
  });

  it('salvageEntries：坏一条只丢一条；旧形态补 null 缺位（不猜值）', () => {
    const good = encodeEntries({ '/a.ERB': entryOf('/a.ERB', []) });
    const raw: Record<string, unknown> = JSON.parse(JSON.stringify(good));
    raw['/a.ERB'] = (raw['/a.ERB'] as unknown[]).slice(0, 5); // 元数不符
    raw['/bad.ERB'] = { not: 'a tuple' };
    const out = salvageEntries(raw, 11)!;
    expect(out.skipped).toBe(2);
    expect(Object.keys(out.entries)).toEqual([]);
    const onlyGood = salvageEntries(JSON.parse(JSON.stringify(good)), 11)!;
    expect(onlyGood.skipped).toBe(0);
    expect(onlyGood.entries['/a.ERB']).toBeDefined();

    const legacy = salvageEntries({ '/a.ERB': (JSON.parse(JSON.stringify(good))['/a.ERB'] as unknown[]).slice(0, 10) }, 10)!;
    expect(legacy.entries['/a.ERB']!.candidateHashes).toBeUndefined(); // 第 11 位缺 = 候选未知，不编造
    expect(legacy.entries['/a.ERB']!.refsNamesFp).toBeUndefined(); // 第 10 位本来就 null = 溯源未知
    expect(refsAreReusable(legacy.entries['/a.ERB']!, nameSetDigest([]))).toBe(false);
    // 元组对象仍是盘上那一个（落盘快路径不被 salvage 打断）
    const parsed = JSON.parse(JSON.stringify(good)) as Record<string, unknown[]>;
    expect(salvageEntries(parsed, 11)!.entries['/a.ERB']).toBeDefined();
  });

  it('salvageSnapshot：版本表外 / 项目根不符 / savedAt 坏 ⇒ null；knownPaths 负责把条目键归位', () => {
    // 同版本完整条目（机制场景：现实里同版本恒 10 位；缺位补 null 的语义在 salvageEntries 用例钉）
    const payload = {
      version: SNAPSHOT_VERSION,
      rootDir: 'D:\\proj\\eratw',
      savedAt: 1,
      entries: { 'D:\\proj\\eratw\\ERB\\a.ERB': JSON.parse(JSON.stringify(encodeEntries({ 'D:/proj/eratw/ERB/a.ERB': entryOf('D:/x', []) })))['D:/proj/eratw/ERB/a.ERB'] as unknown[] },
    };
    const opts = { rootDir: ROOT, key: snapshotKeyFor(ROOT), knownPaths: ['D:/proj/eratw/ERB/a.ERB'] };
    const s = salvageSnapshot(payload, opts)!;
    expect(s.legacy).toBe(false); // 当前版本 hasRefsFp=true ⇒ 非 legacy（v6 时代才有 legacy=true 形态）
    expect(s.skipped).toBe(0);
    expect(Object.keys(s.entries)).toEqual(['D:/proj/eratw/ERB/a.ERB']); // 归位到本轮 walkDir 的写法
    expect(s.entries['D:/proj/eratw/ERB/a.ERB']!.file.path).toBe('D:/proj/eratw/ERB/a.ERB');
    // 表外版本 / 不同根 / savedAt 非数 ⇒ 一律 null（v9 在表外：#DIM 族修复改了口径，本批的负向判据）
    expect(salvageSnapshot({ ...payload, version: V_LEGACY }, opts)).toBeNull();
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

  it('verifiedNamesDigest / countEntries（PS-3 信封判据，纯函数）', () => {
    const fp = nameSetDigest(['FOO']);
    const stamped = { '/a.ERB': { ...entryOf('/a.ERB', []), refs: [], refsNamesFp: fp } as unknown as SnapshotEntry };
    expect(verifiedNamesDigest(stamped, fp)).toBe(fp); // 全体条目记账相符 ⇒ 信封可写摘要
    expect(verifiedNamesDigest(stamped, fp + 1)).toBeNull(); // 摘要换了 ⇒ 谁都不许信
    const mixed = {
      ...stamped,
      '/b.ERB': { ...entryOf('/b.ERB', []), refs: [] } as unknown as SnapshotEntry, // 溯源未知
    };
    expect(verifiedNamesDigest(mixed, fp)).toBeNull(); // 一条没记账 ⇒ 整封作废（不部分当真）
    expect(verifiedNamesDigest({}, fp)).toBe(fp); // 空快照"全体相符"平凡真（下一轮无巡检可做）
    expect(countEntries(mixed)).toBe(2);
    expect(countEntries({})).toBe(0);
  });

  it('coerce / salvage 搬运信封摘要：只认数，缺位/坏值 ⇒ 不留键（逐条目巡检兜底，不猜）', () => {
    const entries = encodeEntries({ [P1]: entryOf(P1, []) });
    const base = { version: SNAPSHOT_VERSION, rootDir: ROOT, savedAt: 1, entries };
    const fp = nameSetDigest(['FOO']);
    expect(coerceSnapshot({ ...base, namesFp: fp }, ROOT)!.namesFp).toBe(fp);
    expect(coerceSnapshot(base, ROOT)!.namesFp).toBeUndefined(); // 旧盘没这一位 = 未知
    expect('namesFp' in coerceSnapshot(base, ROOT)!).toBe(false);
    expect(coerceSnapshot({ ...base, namesFp: 'x' }, ROOT)!.namesFp).toBeUndefined(); // 坏值不当真
    const s = salvageSnapshot({ ...base, namesFp: fp }, { rootDir: ROOT, key: v7key })!;
    expect(s.namesFp).toBe(fp);
    expect(salvageSnapshot(base, { rootDir: ROOT, key: v7key })!.namesFp).toBeUndefined();
  });
});
