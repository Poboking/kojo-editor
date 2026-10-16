/**
 * 守门测试：**装包 `commitPack` 的 IPC 形态，以及"锚来自落盘那一份字节"这条语义**
 * （2026-10-16 市场与导入 IO 批，BOARD §S PERF-10 ②）。
 *
 * ## 旧形态为什么是 ≈4N 趟
 *
 * `commitPack` 两条 await-in-loop：
 * - 第一趟逐文件 `readBytes(源)` + `ensureDir(父目录)` + `writeBytes(暂存区)` = 3N；
 * - 第二趟再从暂存区逐文件 `readBytes` **只为算 sha256** = N。
 * 条目上限 5000（契约 `MARKET_MAX_FILE_ENTRIES`）⇒ 大包就是两万次串行往返。
 *
 * 修法只用**现成**的批量原语（`bridge.readFilesRaw`，经新增的 `FileIO.readBytesMany`）：
 * 两条读 loop 各压成 `ceil(N/64)` 趟；`ensureDir` 整趟删掉（平台的写命令本来就
 * `create_dir_all` 父目录，而写允许域判定的是**落点文件本身**，目录那一趟从不参与判闸）。
 * 搬运本身仍是一文件一趟写：**没有**批量写原语，也不为压趟新造一条（那是第二份写形态）。
 *
 * ## 两条不许被"压趟"顺带改掉的东西
 *
 * 1. **哈希仍然读暂存区**，不读源：这条读回是故意的——锚必须是"盘上那一份"的锚，
 *    退化成源侧哈希就等于"写的"与"核的"是两个东西。第二条判据用**写侧篡改（同长度改一个
 *    字节）**把它钉死：篡改后必须 `entry-sha256` 红，而不是拿着源侧锚绿着装进去。
 * 2. **拒因次序不变**：整批先读回并核完字节数、写完，再整批复核算锚
 *    ——批量只改"几趟"，不改"哪一条先判"。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as nodeJoin, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKET_SCHEMA_VERSION,
  MarketError,
  packStagingName,
  type FileIO,
  type Logger,
  type PlatformBridge,
  type RemoteService,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { createMarketService, sha256Hex } from '../src/index';

const APP_VERSION = '0.4.0-beta.1';
/** 条目数：跨过 64 的批界（ceil(150/64)=3 批），才量得出"按批"而不是"逐条" */
const FILE_COUNT = 150;
/** 内核批量读的批大小（`kernel/src/io.ts` 的 `READ_BATCH_SIZE`；本判据按它数趟） */
const BATCH = 64;
const PACK_ID = 'ipc.pack';
const PACK_VERSION = '1.0.0';

const tmps: string[] = [];

/* --------------------------- 计数桥（按线形态记账） --------------------------- */

interface WireTrips {
  /** 每一次逐条 `read_file_bytes_raw` 的落点 */
  singleReads: string[];
  /** 每一次 `write_file_bytes` 的落点 */
  writes: string[];
  /** 每一次 `ensure_dir` 的落点 */
  dirs: string[];
  /** 每一次 `read_files_raw` 的批大小 */
  batchReads: number[];
}

const newTrips = (): WireTrips => ({ singleReads: [], writes: [], dirs: [], batchReads: [] });

/**
 * 只记不拦的计数壳。`tamperAt` 命中的落点在**写出去那一刻**被改掉一个字节而长度不变
 * ⇒ 字节数那道闸放行，只有"读回落盘那一份再算锚"才发现得了（第二条判据的手术刀）。
 */
function countingBridge(
  inner: PlatformBridge,
  trips: WireTrips,
  tamperAt: (p: string) => boolean,
): PlatformBridge {
  return new Proxy(inner, {
    get(target, prop: string | symbol) {
      if (prop === 'readFileBytes') {
        return async (p: string): Promise<Uint8Array> => {
          trips.singleReads.push(p);
          return target.readFileBytes(p);
        };
      }
      if (prop === 'readFilesRaw') {
        return async (paths: readonly string[]) => {
          trips.batchReads.push(paths.length);
          return target.readFilesRaw(paths);
        };
      }
      if (prop === 'writeFileBytes') {
        return async (p: string, data: Uint8Array): Promise<void> => {
          trips.writes.push(p);
          if (!tamperAt(p)) return target.writeFileBytes(p, data);
          const mutated = Uint8Array.from(data, (b, i) => (i === 0 ? b ^ 0xff : b));
          return target.writeFileBytes(p, mutated);
        };
      }
      if (prop === 'ensureDir') {
        return async (p: string): Promise<void> => {
          trips.dirs.push(p);
          return target.ensureDir(p);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function memStorage(): ScopedStorage {
  const store = new Map<string, unknown>();
  return {
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
}

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noRemote = (): RemoteService => ({
  async fetchText() {
    throw new Error('本判据不联网');
  },
  async marketDownload() {
    throw new Error('本判据不下载');
  },
  async marketExtract() {
    throw new Error('本判据不解压');
  },
});

/* --------------------------------- 夹具 --------------------------------- */

/** 源包：`pack.json` + `files/` 下 FILE_COUNT 个条目（每 5 个走一层深目录，验父目录由写命令自己建） */
async function buildSource(): Promise<string> {
  const sourceDir = mkdtempSync(nodeJoin(tmpdir(), 'kojo-commit-ipc-src-'));
  tmps.push(sourceDir);
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const rel = i % 5 === 0 ? `files/deep/${i}/f-${i}.ERB` : `files/f-${i}.bin`;
    const bytes = new Uint8Array(64 + i);
    for (let k = 0; k < bytes.length; k++) bytes[k] = (i * 31 + k) & 0xff;
    const abs = nodeJoin(sourceDir, rel.replace(/\//g, sep));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    files.push({ path: rel, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  writeFileSync(
    nodeJoin(sourceDir, 'pack.json'),
    JSON.stringify({
      schema: MARKET_SCHEMA_VERSION,
      kind: 'kojo-pack',
      id: PACK_ID,
      version: PACK_VERSION,
      name: '计数包',
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

let appData: string;
let marketRoot: string;
let stagingRoot: string;
let packsRoot: string;
let io: FileIO;
let trips: WireTrips;

beforeEach(() => {
  appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-commit-ipc-app-'));
  tmps.push(appData);
  marketRoot = nodeJoin(appData, 'market');
  stagingRoot = nodeJoin(marketRoot, '.staging');
  packsRoot = nodeJoin(marketRoot, 'packs');
  mkdirSync(marketRoot, { recursive: true });

  trips = newTrips();
  io = new FileIOServiceImpl(countingBridge(new NodeBridge(appData), trips, () => false));
  io.setAppWritableRoots([marketRoot]);
});

afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
}, 60_000);

function service(): ReturnType<typeof createMarketService> {
  return createMarketService({
    io,
    remote: noRemote(),
    storage: memStorage(),
    log: quietLog,
    root: marketRoot,
    appVersion: APP_VERSION,
  });
}

/* -------------------------------- 判据 -------------------------------- */

describe('commitPack · 装包的往返趟数（PERF-10 ②）', () => {
  it(`${FILE_COUNT} 条目：逐条读 0 趟、ensureDir 0 趟、写 N 趟、批量读 2×ceil(N/${BATCH}) 趟`, async () => {
    const sourceDir = await buildSource();
    trips = newTrips();
    io = new FileIOServiceImpl(countingBridge(new NodeBridge(appData), trips, () => false));
    io.setAppWritableRoots([marketRoot]);

    const started = Date.now();
    await service().installLocalDir(sourceDir);
    const ms = Date.now() - started;

    const inContent = (p: string): boolean =>
      p.startsWith(nodeJoin(sourceDir, 'files')) ||
      p.startsWith(stagingRoot) ||
      p.startsWith(packsRoot);
    // 旧形态里逐条读出现两次（源侧一遍、暂存区一遍），落点都在这些地方 ⇒ 现在必须全空
    expect(trips.singleReads.filter(inContent)).toEqual([]);
    // 旧形态每文件一次 ensureDir ⇒ 现在整趟消失（写命令自己 create_dir_all）
    expect(trips.dirs.filter((p) => p.startsWith(stagingRoot))).toEqual([]);
    // 搬运仍是一文件一趟写（没有批量写原语，也不为压趟新造一条）
    expect(trips.writes.filter((p) => p.startsWith(stagingRoot))).toHaveLength(FILE_COUNT);
    // 两条读 loop 各按批：ceil(150/64)=3 ⇒ 合计 **6 趟**（旧形态是 300 趟逐条读），
    // 尾批 22 = 150-64-64 ⇒ 批界由内核的读批决定，本判据按它记账
    expect(trips.batchReads).toEqual([BATCH, BATCH, FILE_COUNT - 2 * BATCH, BATCH, BATCH, FILE_COUNT - 2 * BATCH]);

    // 结果面：落点逐字节 = 源（深路径的父目录也确实被建出来了）
    const target = nodeJoin(packsRoot, 'kojo-pack', PACK_ID, PACK_VERSION);
    for (let i = 0; i < FILE_COUNT; i++) {
      const rel = i % 5 === 0 ? nodeJoin('files', 'deep', String(i), `f-${i}.ERB`) : nodeJoin('files', `f-${i}.bin`);
      const srcBytes = readFileSync(nodeJoin(sourceDir, rel));
      expect(new Uint8Array(readFileSync(nodeJoin(target, rel)))).toEqual(new Uint8Array(srcBytes));
    }
    // 装完之后暂存区零残壳（搬运靠 rename，不靠再抄一遍）
    expect(existsSync(nodeJoin(stagingRoot, packStagingName(PACK_ID, PACK_VERSION)))).toBe(false);
    console.info(`commitPack 读数：${FILE_COUNT} 条目 / 批量读 ${trips.batchReads.length} 趟 / 写 ${FILE_COUNT} 趟 / ${ms}ms`);
    // 纯 IO 量太大（150 文件 × 真盘读写；满载并行池下实测本体逼近 60s）：
    // 预算给足 120s（收尾钩子 60_000 同族），判据与 N 均不动
  }, 120_000);

  it('锚来自**落盘那一份**字节：写侧同长度篡改一个字节 ⇒ entry-sha256 红且落点不存在', async () => {
    const sourceDir = await buildSource();
    const victim = nodeJoin(
      stagingRoot,
      packStagingName(PACK_ID, PACK_VERSION),
      'files',
      'f-1.bin',
    );
    const tamperTrips = newTrips();
    io = new FileIOServiceImpl(
      countingBridge(new NodeBridge(appData), tamperTrips, (p) => p === victim),
    );
    io.setAppWritableRoots([marketRoot]);

    const err = await service()
      .installLocalDir(sourceDir)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketError);
    expect((err as MarketError).code).toBe('entry-sha256');
    // 失败不留半成品：落点不存在、暂存区这个包被清干净
    expect(existsSync(nodeJoin(packsRoot, 'kojo-pack', PACK_ID, PACK_VERSION))).toBe(false);
    expect(existsSync(nodeJoin(stagingRoot, packStagingName(PACK_ID, PACK_VERSION)))).toBe(false);
    // 源侧那份没被动过（篡改只发生在写出去的那一刻 ⇒ 读的确实是回落盘的那一份）
    const srcFile = nodeJoin(sourceDir, 'files', 'f-1.bin');
    // 夹具里 f-1.bin 的第 0 字节 = (1*31+0) & 0xff = 31 ⇒ 源侧原样
    expect(readFileSync(srcFile)[0]).toBe(31);
    // 锚这一趟照样是批量：源侧 3 批全读完并写完 ⇒ 暂存区第 1 批就发现不符，
    // 整条链路停在第 4 批（篡改条目在清单第 2 位，落进第一批 ⇒ 不多读后面两批）
    expect(tamperTrips.batchReads).toEqual([BATCH, BATCH, FILE_COUNT - 2 * BATCH, BATCH]);
  });
});
