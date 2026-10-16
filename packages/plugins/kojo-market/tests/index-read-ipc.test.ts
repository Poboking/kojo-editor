/**
 * 守门：市场**索引读面**的趟数与出声（2026-10-16 BOARD §S PERF-10b ④）。
 *
 * 四条判据，一条都不能少：
 *
 * - **G1 一次刷新只读一次索引**：`refreshIndex()` 的七个返回分支每一个都要带一份盘上状态回去，
 *   旧形态是"哪个分支都自己 `exists`+`readText`+`JSON.parse`+查重 一遍"（一次调用只走其中一条，
 *   但每个分支都是一次**独立**读盘 ⇒ 以后多一条分支就多一趟）。现在一次调用开一个读盘合并槽，
 *   同周期内的多个读点共用那一份 ⇒ 走哪条分支读盘次数都 ≤ 1。
 *   附带一条"合并别合出错"的锚：`refreshed` 分支**写完盘之后**那一次读必须读到刚写的那一份
 *   （槽在写后被立刻作废），否则"刷新成功却返回刷新前的旧列表"就是合并唯一可能引进的新错。
 * - **G2 跨周期绝不许合并**（这条是防把失效判据修坏的锚）：`readIndexState` 同时是索引
 *   **失效判据**的来源（契约 `MarketService.index()` 的三态 = "盘上这一份现在是什么样子"）。
 *   两次独立刷新**各读一次**；外部改了 `index.json` 之后，下一次刷新哪怕 TTL 命中（`cached`、
 *   不出网）也必须读到**新的那一份**。做成了跨周期缓存，"外部改了索引却读不到"那类陈旧 bug 就复活了。
 * - **G3 已装清单 = 一趟批量 stat**：`installed()` 旧形态 N 条记录 = N 趟串行 `io.exists`，
 *   现在 = 1 趟 `io.statFiles`（内核透传平台桥现成的批量 stat，512 一块）。
 *   判据量在**线面**上：已装落点的 `exists` 单发趟数必须为 **0**。
 * - **G4 出声逐字不变**：索引缺失 / JSON 不合格 / 查重不通过三条失败路径的 `log.warn` 原文、
 *   三态返回值与 `MarketError` 文案，合并与批量都做完之后必须与改前**逐字**一致
 *   （铁律 4「内核不静默」：压趟数不许顺手把拒因压没）。
 *
 * 搭法照 `commit-pack-ipc.test.ts`：**真内核 io**（`FileIOServiceImpl` + `NodeBridge`），
 * 外面只套两层只记不拦的计数器 —— `FileIO` 面（插件看到的那根线）与桥面（真 IPC 趟数）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKET_INDEX_FILE,
  MARKET_PACKS_DIR,
  MARKET_SCHEMA_VERSION,
  MarketError,
  join,
  type BatchFileStat,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketIndexEntry,
  type MarketService,
  type PackFileEntry,
  type PlatformBridge,
  type RemoteExtractResult,
  type RemoteService,
  type RemoteText,
  type ScopedStorage,
  type TextFile,
} from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { createMarketService, sha256Hex } from '../src/index';

const APP_VERSION = '0.4.0-beta.1';
/** 注入的时间源（TTL 分支要"过去某一刻刚拉过"，用固定值才不用 sleep） */
const CLOCK = 1_700_000_000_000;
const tmps: string[] = [];

/** 路径比对一律归一（契约 `join` 按首段风格选分隔符，node 用 `\`，比较面统一成 `/` + 小写） */
const norm = (p: string): string => p.replaceAll('\\', '/').toLowerCase();

/* ------------------------------ 计数器 ------------------------------ */

interface IoTrips {
  exists: string[];
  readText: string[];
  writeText: string[];
  /** 每次 `statFiles` 调用的条数（一次调用 = 插件侧一趟） */
  statFiles: number[];
  statFilesPaths: string[];
}
interface WireTrips {
  exists: number;
  /** 每一次桥侧批量 stat 的条数（分块形态在这里看） */
  statFiles: number[];
}

const newIoTrips = (): IoTrips => ({ exists: [], readText: [], writeText: [], statFiles: [], statFilesPaths: [] });
const newWireTrips = (): WireTrips => ({ exists: 0, statFiles: [] });

/** 只记不拦：`FileIO` 面（服务能看到的那根线） */
function countingIo(inner: FileIO, trips: IoTrips, failWrite: { on: boolean }): FileIO {
  return new Proxy(inner, {
    get(target, prop: string | symbol) {
      if (prop === 'exists') {
        return async (p: string): Promise<boolean> => {
          trips.exists.push(p);
          return target.exists(p);
        };
      }
      if (prop === 'readText') {
        return async (p: string): Promise<TextFile> => {
          trips.readText.push(p);
          return target.readText(p);
        };
      }
      if (prop === 'writeText') {
        return async (p: string, text: string, opts?: Parameters<FileIO['writeText']>[2]): Promise<void> => {
          trips.writeText.push(p);
          if (failWrite.on) throw new Error('EIO: 假故障，磁盘拒绝写');
          return target.writeText(p, text, opts);
        };
      }
      if (prop === 'statFiles') {
        const fn = (target as unknown as Record<string, unknown>)[prop];
        if (typeof fn !== 'function') {
          throw new Error('FileIO 面上没有 statFiles —— 批量 stat 原语未交付');
        }
        return async (paths: readonly string[]): Promise<BatchFileStat[]> => {
          trips.statFiles.push(paths.length);
          trips.statFilesPaths.push(...paths.map(norm));
          return (fn as (p: readonly string[]) => Promise<BatchFileStat[]>).call(target, paths);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** 只记不拦：桥面（真 IPC 的那一趟） */
function countingBridge(inner: PlatformBridge, wire: WireTrips): PlatformBridge {
  return new Proxy(inner, {
    get(target, prop: string | symbol) {
      if (prop === 'exists') {
        return async (p: string): Promise<boolean> => {
          wire.exists++;
          return target.exists(p);
        };
      }
      if (prop === 'statFiles') {
        return async (paths: readonly string[]): Promise<BatchFileStat[]> => {
          wire.statFiles.push(paths.length);
          return target.statFiles(paths);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/* ------------------------------ 夹具 ------------------------------ */

interface RemoteCfg {
  /** 注册表回来的正文（null = 不给） */
  body: string | null;
  /** 出网直接抛（= Node 桥没有远程能力那条口径） */
  throws: string | null;
}

function harness(opts: { remote?: Partial<RemoteCfg>; indexBody?: string | null } = {}) {
  const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-index-read-app-'));
  tmps.push(appData);
  const root = nodeJoin(appData, 'market');
  mkdirSync(root, { recursive: true });
  const indexPath = join(root, MARKET_INDEX_FILE);
  const packsRoot = join(root, MARKET_PACKS_DIR);

  const remote: RemoteCfg = { body: null, throws: '本判据不联网（Node 桥没有远程能力）', ...opts.remote };
  const failWrite = { on: false };
  const ioTrips = newIoTrips();
  const wire = newWireTrips();
  const warns: string[] = [];
  const infos: string[] = [];
  const store = new Map<string, unknown>();

  const io = countingIo(
    new FileIOServiceImpl(countingBridge(new NodeBridge(appData), wire)),
    ioTrips,
    failWrite,
  );
  io.setAppWritableRoots([root]);

  const storage: ScopedStorage = {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
  const log: Logger = {
    debug: () => {},
    info: (m) => infos.push(String(m)),
    warn: (m) => warns.push(String(m)),
    error: (m) => warns.push(`[error] ${String(m)}`),
  };
  const writeIndex = (text: string): void => {
    mkdirSync(root, { recursive: true });
    writeFileSync(indexPath, text, 'utf8');
  };
  /** 默认盘上就有一份好索引：每条分支都真读得到东西，趟数量得出来（`indexBody:null` = 不给） */
  if (opts.indexBody !== null) writeIndex(opts.indexBody ?? indexJson([indexEntry('a.pack')]));

  const svc: MarketService = createMarketService({
    io,
    remote: {
      async fetchText(url): Promise<RemoteText> {
        if (remote.throws !== null) throw new Error(remote.throws);
        const text = remote.body ?? '';
        return { text, bytes: new TextEncoder().encode(text).length, status: 200, finalUrl: url };
      },
      async marketDownload() {
        throw new Error('本判据不下载');
      },
      async marketExtract(): Promise<RemoteExtractResult> {
        throw new Error('本判据不解压');
      },
    },
    storage,
    log,
    root,
    appVersion: APP_VERSION,
    now: () => CLOCK,
  });

  /** 本文件里"读了一次索引"的判据 = 索引文件上的一次 `exists`（每次读盘都以它开头） */
  const indexExists = (): number => ioTrips.exists.filter((p) => norm(p) === norm(indexPath)).length;
  const indexReadText = (): number => ioTrips.readText.filter((p) => norm(p) === norm(indexPath)).length;
  const reset = (): void => {
    ioTrips.exists.length = 0;
    ioTrips.readText.length = 0;
    ioTrips.writeText.length = 0;
    ioTrips.statFiles.length = 0;
    ioTrips.statFilesPaths.length = 0;
    wire.exists = 0;
    wire.statFiles.length = 0;
    warns.length = 0;
    infos.length = 0;
  };

  return {
    appData,
    root,
    indexPath,
    packsRoot,
    svc,
    io,
    ioTrips,
    wire,
    warns,
    infos,
    remote,
    failWrite,
    store,
    writeIndex,
    indexExists,
    indexReadText,
    reset,
    seed(key: string, value: unknown): void {
      store.set(key, value);
    },
    /** 造一个已装落点目录（`installed()` 核的就是这一串派生路径） */
    mkPackDir(kind: string, id: string, version: string): string {
      const dir = join(packsRoot, kind, id, version);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

type Box = ReturnType<typeof harness>;

function indexEntry(id: string, over: Partial<MarketIndexEntry> = {}): MarketIndexEntry {
  return {
    kind: 'kojo-pack',
    id,
    version: '1.0.0',
    name: '演示包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    minAppVersion: '0.4.0',
    zip: { url: 'https://example.invalid/p.zip', sha256: 'a'.repeat(64), bytes: 10 },
    fileCount: 1,
    unpackedBytes: 10,
    ...over,
  };
}

function indexJson(packs: readonly unknown[]): string {
  return JSON.stringify({
    schema: MARKET_SCHEMA_VERSION,
    generatedAt: '2026-10-16T00:00:00Z',
    packs,
  });
}

function record(id: string, over: Partial<InstalledPack> = {}): InstalledPack {
  return {
    kind: 'kojo-pack',
    id,
    version: '1.0.0',
    name: `已装 ${id}`,
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    contentDigest: 'b'.repeat(64),
    installedAt: CLOCK,
    files: [],
    ...over,
  };
}

/* -------------------------------- G1 -------------------------------- */

/** 七条分支各自的索引读盘次数（跑完在 G1 末尾打一行读数，判据不看它） */
const g1Reads: Array<[string, number]> = [];

describe('G1 · 一次 refreshIndex 只读一次索引（PERF-10b 的合并）', () => {
  /** 七条分支：每条都带一份盘上状态回去 ⇒ 每条的索引读盘次数都必须 ≤ 1 */
  const branches: Array<{ name: string; prep?(b: Box): void; run(b: Box): Promise<unknown> }> = [
    {
      name: 'refreshed（回源 + 落盘 + 读回）',
      prep: (b) => {
        b.remote.throws = null;
        b.remote.body = indexJson([indexEntry('new.pack')]);
      },
      run: (b) => b.svc.refreshIndex({ force: true }),
    },
    {
      name: 'cached（TTL 窗口内不回源）',
      prep: (b) => b.seed('indexFetchedAt', CLOCK - 60_000),
      run: (b) => b.svc.refreshIndex(),
    },
    {
      name: 'failed · 端点形态不合格',
      prep: (b) => b.seed('indexEndpoint', 'http://明文.example/i.json'),
      run: (b) => b.svc.refreshIndex({ force: true }),
    },
    {
      name: 'failed · 出网没有成功',
      run: (b) => b.svc.refreshIndex({ force: true }),
    },
    {
      name: 'failed · 回来的不是 JSON',
      prep: (b) => {
        b.remote.throws = null;
        b.remote.body = '{坏 JSON';
      },
      run: (b) => b.svc.refreshIndex({ force: true }),
    },
    {
      name: 'failed · 回来的形状不受支持',
      prep: (b) => {
        b.remote.throws = null;
        b.remote.body = JSON.stringify({
          schema: MARKET_SCHEMA_VERSION,
          generatedAt: '2026-10-16T00:00:00Z',
          packs: '不是数组',
        });
      },
      run: (b) => b.svc.refreshIndex({ force: true }),
    },
    {
      name: 'failed · 列表落盘失败',
      prep: (b) => {
        b.remote.throws = null;
        b.remote.body = indexJson([indexEntry('new.pack')]);
        b.failWrite.on = true;
      },
      run: (b) => b.svc.refreshIndex({ force: true }),
    },
  ];

  for (const branch of branches) {
    it(`${branch.name} ⇒ 索引读盘次数 ≤ 1`, async () => {
      const b = harness();
      branch.prep?.(b);
      b.reset();
      const r = (await branch.run(b)) as { state: string };
      const reads = b.indexExists();
      const texts = b.indexReadText();
      expect(
        reads,
        `分支「${branch.name}」读索引 ${reads} 次（旧形态每个分支各读一遍，合并后必须 ≤ 1）`,
      ).toBeLessThanOrEqual(1);
      expect(texts, `分支「${branch.name}」readText 索引 ${texts} 次`).toBeLessThanOrEqual(1);
      // 合并槽不许把"读盘"变成"不读"：这一条分支确实要带一份盘上状态回去 ⇒ 恰好 1 次
      expect(reads, `分支「${branch.name}」一次都没读盘 ⇒ 状态是从哪儿来的`).toBe(1);
      g1Reads.push([branch.name, reads]);
      expect(r.state).toBeTruthy();
    });
  }

  it('refreshed：**写完盘之后**那一次读到的是刚写的那一份（合并槽在写后立刻作废）', async () => {
    // 盘上先放一份"旧列表"，注册表回一份"新列表" ⇒ 若刷新开头读过一次并留着复用，
    // 这里就会返回旧列表（刷新成功却给你旧的），这条判据当场红。
    const b = harness({ indexBody: indexJson([indexEntry('old.pack')]) });
    b.remote.throws = null;
    b.remote.body = indexJson([indexEntry('new.pack')]);
    b.reset();
    const r = await b.svc.refreshIndex({ force: true });
    expect(r.state).toBe('refreshed');
    if (r.state !== 'refreshed') throw new Error('不该判成失败');
    expect(r.index.state, '刷新成功却返回了刷新前的旧列表 = 合并槽读到了写盘前那一份').toBe('ok');
    if (r.index.state !== 'ok') throw new Error('索引态不对');
    expect(r.index.index.packs.map((p) => p.id)).toEqual(['new.pack']);
    expect(readFileSync(b.indexPath, 'utf8'), '落盘的应是注册表原文镜像').toBe(b.remote.body);
    expect(b.indexExists(), '刷新内只该有"写后读回"那一次读盘').toBe(1);
    expect(b.indexReadText()).toBe(1);
    console.info(
      `refreshIndex 读数：${g1Reads.length} 条分支各读盘 ${g1Reads.map(([, n]) => n).join('/')} 次 ` +
        `（静态读点 7 个 ⇒ 合并成一次刷新内共用一份；两次独立刷新仍各读 1 次，见 G2）`,
    );
  });
});

/* -------------------------------- G2 -------------------------------- */

describe('G2 · 跨刷新周期绝不许合并（失效判据还在这儿）', () => {
  it('两次独立刷新**各读一次**（合计 2 次，不是第二次吃第一次的结果）', async () => {
    const b = harness({ indexBody: indexJson([indexEntry('a.pack')]) });
    b.reset();
    await b.svc.index();
    expect(b.indexExists()).toBe(1);
    b.reset();
    await b.svc.index();
    expect(b.indexExists(), '第二次 index() 读了 0 次 = 跨周期缓存，失效判据已被修坏').toBe(1);
    b.reset();
    await b.svc.refreshIndex();
    await b.svc.refreshIndex();
    expect(b.indexExists(), '两次刷新必须各读一次').toBe(2);
  });

  it('外部改了 index.json ⇒ 下一次刷新（TTL 命中、不出网）读到的是**改过的**那一份', async () => {
    const b = harness();
    b.remote.throws = null;
    b.remote.body = indexJson([indexEntry('mine.pack')]);
    const first = await b.svc.refreshIndex({ force: true });
    expect(first.state).toBe('refreshed');
    // 本机之外有人动了这份文件（手工编辑 / 别的进程覆盖）
    b.writeIndex(indexJson([indexEntry('external.pack'), indexEntry('mine.pack')]));
    b.reset();
    const second = await b.svc.refreshIndex();
    // TTL 窗口内 ⇒ 不回源，但盘上那一份必须照实读回来（`cached` 不是"用内存里那份"）
    expect(second.state).toBe('cached');
    if (second.state !== 'cached') throw new Error('TTL 判据走歪了');
    if (second.index.state !== 'ok') throw new Error(`应读到外部改后的 ok，实际 ${JSON.stringify(second.index)}`);
    expect(second.index.index.packs.map((p) => p.id)).toEqual(['external.pack', 'mine.pack']);
    expect(b.indexExists(), 'cached 分支也该真读一次盘').toBe(1);
  });

  it('外部把索引改成坏文件 ⇒ 下一次读立刻报 invalid（不许拿上一次的好列表演 ok）', async () => {
    const b = harness();
    b.writeIndex('{坏 JSON');
    b.reset();
    const got = await b.svc.index();
    expect(got.state).toBe('invalid');
    b.writeIndex(indexJson([]));
    b.reset();
    expect((await b.svc.index()).state).toBe('ok');
  });

  it('装前查重（`findIdKindClash`）也每次真读盘：它用的是**不带槽**的那条读面', async () => {
    const b = harness({ indexBody: indexJson([indexEntry('clash.pack')]) });
    const source = await makeSourceDir('clash.pack', 'kojo-pack');
    b.reset();
    await b.svc.installLocalDir(source).catch(() => undefined);
    expect(b.indexExists(), '查重那一路也该读到盘上现值').toBeGreaterThanOrEqual(1);
  });
});

/* -------------------------------- G3 -------------------------------- */

describe('G3 · installed() 用一趟批量 stat，不再逐条 exists', () => {
  it('4 条已装记录 ⇒ exists 单发趟数 0 / statFiles 1 趟 4 条（线面同步 1 趟）', async () => {
    const b = harness();
    b.mkPackDir('kojo-pack', 'p1', '1.0.0');
    b.mkPackDir('kojo-pack', 'p2', '1.0.0');
    b.mkPackDir('dict-pack', 'p3', '1.0.0');
    // p4 故意不建目录：旧形态里它也是"一次 exists 拿 false"，现在同批拿 exists:false
    b.seed('installed', [record('p1'), record('p2'), record('p3', { kind: 'dict-pack' }), record('p4', { kind: 'dict-pack' })]);
    b.reset();

    const list = await b.svc.installed();
    expect(list.map((r) => r.id).sort()).toEqual(['p1', 'p2', 'p3']);
    const packExists = b.ioTrips.exists.filter((p) => norm(p).startsWith(norm(b.packsRoot)));
    expect(packExists, `已装落点上仍有单发 exists：${packExists.join('、')}`).toEqual([]);
    expect(b.wire.exists, '桥面 exists 趟数').toBe(0);
    expect(b.ioTrips.statFiles, 'statFiles 调用次数').toEqual([4]);
    expect(b.wire.statFiles, '桥面批量 stat 趟数').toEqual([4]);
    expect(b.ioTrips.statFilesPaths.sort()).toEqual(
      [
        join(b.packsRoot, 'kojo-pack', 'p1', '1.0.0'),
        join(b.packsRoot, 'kojo-pack', 'p2', '1.0.0'),
        join(b.packsRoot, 'dict-pack', 'p3', '1.0.0'),
        join(b.packsRoot, 'dict-pack', 'p4', '1.0.0'),
      ].map(norm).sort(),
    );
    // 剔除了不在位的那条，并且**出声**（铁律 4）
    expect(b.warns).toEqual([
      '已装清单里有 1 条目录已不在位，一并剔除：dict-pack/p4 v1.0.0',
    ]);
    const kept = b.store.get('installed') as InstalledPack[] | undefined;
    expect(kept?.map((r) => r.id).sort()).toEqual(['p1', 'p2', 'p3']);
    console.info(
      `installed 读数：4 条已装记录 / 落点 exists 单发 ${b.wire.exists} 趟（改前 = 4）/ ` +
        `批量 stat ${b.wire.statFiles.length} 趟（${b.wire.statFiles.join('+')} 条）`,
    );
  });

  it('批量分块形态：>512 条时按 512 一块（不是一口气一条命令塞给平台）', async () => {
    const b = harness();
    const many: InstalledPack[] = [];
    for (let i = 0; i < 600; i++) many.push(record(`bulk${i}.pack`));
    b.seed('installed', many);
    b.reset();
    const got = await b.svc.installed();
    expect(got).toEqual([]);
    expect(b.wire.exists).toBe(0);
    expect(b.ioTrips.statFiles).toEqual([600]);
    expect(b.wire.statFiles, '内核侧按 STAT_CHUNK_SIZE=512 分块 ⇒ 512 + 88').toEqual([512, 88]);
    console.info(
      `installed 读数：600 条已装记录 / 落点 exists 单发 ${b.wire.exists} 趟（改前 = 600）/ ` +
        `桥面批量 stat ${b.wire.statFiles.length} 趟（${b.wire.statFiles.join('+')}）`,
    );
  });

  it('一条已装记录都没有 ⇒ 连批量 stat 都不发（0 条不值得跑一趟）', async () => {
    const b = harness();
    b.reset();
    expect(await b.svc.installed()).toEqual([]);
    expect(b.ioTrips.statFiles).toEqual([]);
    expect(b.wire.exists).toBe(0);
    expect(b.warns).toEqual([]);
  });
});

/* -------------------------------- G4 -------------------------------- */

describe('G4 · 三条失败路径的可见出声逐字不变（铁律 4）', () => {
  it('① 索引缺失：absent + 那一句 warn 逐字一致（且**只 warn 一次**）', async () => {
    const b = harness({ indexBody: null });
    b.reset();
    const got = await b.svc.index();
    expect(got).toEqual({ state: 'absent' });
    expect(b.warns).toEqual([`注册表索引不在位（本机还没拉过）：${b.indexPath}`]);
    // 刷新路径里同一条也要只出声一次（合并槽若让多个分支各读各的，这里就会重复 warn）
    b.reset();
    const r = await b.svc.refreshIndex({ force: true });
    expect(r.state).toBe('failed');
    expect(r.index).toEqual({ state: 'absent' });
    expect(b.warns.filter((w) => w.includes('不在位'))).toHaveLength(1);
    expect(b.indexExists()).toBe(1);
  });

  it('② JSON 不合格：invalid 的 reason/detail 与 warn 原文逐字一致', async () => {
    const b = harness({ indexBody: '{坏 JSON' });
    b.reset();
    const got = await b.svc.index();
    // detail 自己算一遍（不硬写 node 版本相关的原文串，串本身仍是被逐字比较的那一个）
    let detail = '';
    try {
      JSON.parse('{坏 JSON');
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    const reason = '列表文件读不出内容（JSON 坏了，或本机磁盘/权限读不动）';
    expect(got).toEqual({ state: 'invalid', reason, detail });
    expect(b.warns).toEqual([`注册表索引不可用：${b.indexPath} —— ${reason}（${detail}）`]);
  });

  it('②b 形状不受支持：invalid 的第二句 reason 与 detail=路径，逐字一致', async () => {
    const b = harness({ indexBody: JSON.stringify({ schema: 99, generatedAt: 'x', packs: [] }) });
    b.reset();
    const got = await b.svc.index();
    const reason = '列表文件的形状不受支持（schema / generatedAt / packs 三项里有一项不合格）';
    expect(got).toEqual({ state: 'invalid', reason, detail: b.indexPath });
    expect(b.warns).toEqual([`注册表索引不可用：${b.indexPath} —— ${reason}（${b.indexPath}）`]);
  });

  it('③ 查重不通过（呈现面）：两句 warn 原文 + dropped 文案逐字一致，条目不呈现', async () => {
    const b = harness({
      indexBody: indexJson([indexEntry('dup.pack'), indexEntry('dup.pack', { kind: 'dict-pack' })]),
    });
    b.reset();
    const got = await b.svc.index();
    if (got.state !== 'ok') throw new Error(`应判 ok（冲突条目被剔掉），实际 ${JSON.stringify(got)}`);
    expect(got.index.packs).toEqual([]);
    expect(got.dropped).toEqual([
      'dup.pack: id-kind-conflict（同名挂在多个种类下）',
      'dup.pack: id-kind-conflict（同名挂在多个种类下）',
    ]);
    expect(b.warns).toEqual([
      'id-kind-conflict：1 个包 id 同时挂在多个种类下（索引内部，或索引与已装集相冲），' +
        '这些条目全部不呈现、也不许被装 —— dup.pack',
      '注册表索引丢掉了 2 条（不呈现、不许装）：dup.pack: id-kind-conflict（同名挂在多个种类下）；' +
        'dup.pack: id-kind-conflict（同名挂在多个种类下）',
    ]);
  });

  it('③b 查重不通过（拒装面）：MarketError 的码/文案/detail 与那句 warn 逐字一致', async () => {
    const b = harness({ indexBody: indexJson([indexEntry('dup.pack', { kind: 'kojo-pack' })]) });
    const source = await makeSourceDir('dup.pack', 'dict-pack');
    b.reset();
    const err = await b.svc.installLocalDir(source).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketError);
    const me = err as MarketError;
    expect(me.code).toBe('id-kind-conflict');
    expect(me.message).toBe(
      '包 id dup.pack 已经以「kojo-pack」这个种类在用，不能再装成「dict-pack」——同名不同类会让注册表 tag 相撞',
    );
    expect(me.detail).toBe('dup.pack: kojo-pack vs dict-pack');
    expect(b.warns).toEqual(['id-kind-conflict：拒绝安装 —— dup.pack: kojo-pack vs dict-pack']);
  });

  it('坏条目留在盘上、每次读都重新报（刷新只写原文，不悄悄洗成干净的）', async () => {
    const b = harness({ indexBody: indexJson([]) });
    b.remote.throws = null;
    b.remote.body = JSON.stringify({
      schema: MARKET_SCHEMA_VERSION,
      generatedAt: '2026-10-16T00:00:00Z',
      packs: [indexEntry('good.pack'), { id: 'BAD ID', version: '1.0.0' }],
    });
    const r = await b.svc.refreshIndex({ force: true });
    expect(r.state).toBe('refreshed');
    b.reset();
    const again = await b.svc.index();
    if (again.state !== 'ok') throw new Error('应读到 ok');
    expect(again.index.packs.map((p) => p.id)).toEqual(['good.pack']);
    expect(again.dropped).toEqual(['BAD ID: kind 不认识']);
    expect(b.warns.filter((w) => w.includes('BAD ID'))).toHaveLength(1);
  });
});

/* ---------------------------- 源目录夹具 ---------------------------- */

/** 一个合法的本机目录源（pack.json + 一个文件）；`kind` 用来造 id/kind 查重冲突 */
async function makeSourceDir(id: string, kind: string): Promise<string> {
  const sourceDir = mkdtempSync(nodeJoin(tmpdir(), 'kojo-index-read-src-'));
  tmps.push(sourceDir);
  const bytes = new TextEncoder().encode('台词正文');
  const files: PackFileEntry[] = [{ path: 'files/a.ERB', bytes: bytes.length, sha256: await sha256Hex(bytes) }];
  mkdirSync(nodeJoin(sourceDir, 'files'), { recursive: true });
  writeFileSync(nodeJoin(sourceDir, 'files', 'a.ERB'), bytes);
  writeFileSync(
    nodeJoin(sourceDir, 'pack.json'),
    JSON.stringify({
      schema: MARKET_SCHEMA_VERSION,
      kind,
      id,
      version: '1.0.0',
      name: '查重夹具',
      author: 'someone',
      license: 'CC-BY-NC 4.0',
      redistribute: true,
      minAppVersion: '0.4.0',
      files,
    }),
    'utf8',
  );
  return sourceDir;
}

afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});
