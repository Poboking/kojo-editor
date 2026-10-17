import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKET_CONTENT_DIR,
  MARKET_MANIFEST_FILE,
  MARKET_SCHEMA_VERSION,
  MarketError,
  type BatchFileStat,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketService,
  type PackFileEntry,
  type PackManifest,
  type RemoteService,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { createMarketService, sha256Hex } from '../src/index';

/**
 * MK-1 的**触发点**判据：装卸成功后"清单变了"这一声由服务发出，消费者据此即时重取。
 *
 * 这一份文件钉的是"什么时候出声、什么时候不出"，全部在 `await` 之后当场判：
 * **一次 `sleep` 都不许有**——延时判读正是看板上"把慢一点读成没做完"的那个成因。
 *
 * 判据面：
 * 1. 装成功（目录源与容器源同一条搬运路径 ⇒ 一处触发点覆盖两条源）⇒ 恰一声 `installed`，
 *    且**在 Promise 落回调用方之前**已经出声（`await install(…)` 回来时 listener 已收到）；
 * 2. 卸成功 ⇒ 恰一声 `uninstalled`，同一三元组；
 * 3. 任何一次**失败** ⇒ 一声不出（清单没变过，重取等于白跑）；
 * 4. 通知只带三元组，不带整条记录（记录的真源是 `installed()`，第二份真相不留）；
 * 5. 退订后不再出声；退订幂等。
 */

const APP_VERSION = '0.4.0-beta.1';
const SOURCE = 'source/demo-pack';
const tmps: string[] = [];

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => {
  while (tmps.length > 0) {
    const p = tmps.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* 已经没了 */
    }
  }
});

/** 装卸链路用得着的几件 io（真 tmp 盘，落点/暂存/清理都是真的；闸不在本文件判据内） */
function fakeIo(root: string): FileIO {
  const io: Record<string, unknown> = {
    async readText(p: string) {
      return { path: p, text: readFileSync(p, 'utf8'), encoding: 'utf-8', eol: 'lf', mtimeMs: 1 };
    },
    async readBytes(p: string): Promise<Uint8Array> {
      return new Uint8Array(readFileSync(p));
    },
    async readBytesMany(paths: readonly string[]): Promise<Array<Uint8Array | null>> {
      return paths.map((p) => {
        try {
          return new Uint8Array(readFileSync(p));
        } catch {
          return null;
        }
      });
    },
    async writeBytes(p: string, data: Uint8Array): Promise<void> {
      mkdirSync(nodeJoin(p, '..'), { recursive: true });
      writeFileSync(p, data);
    },
    async ensureDir(p: string): Promise<void> {
      mkdirSync(p, { recursive: true });
    },
    async exists(p: string): Promise<boolean> {
      try {
        readdirSync(p);
        return true;
      } catch {
        try {
          readFileSync(p);
          return true;
        } catch {
          return false;
        }
      }
    },
    async statFiles(paths: readonly string[]): Promise<BatchFileStat[]> {
      return paths.map((p) => {
        try {
          const st = statSync(p);
          return { path: p, exists: true, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          return { path: p, exists: false, mtimeMs: null, size: null };
        }
      });
    },
    async listDir(p: string) {
      return readdirSync(p, { withFileTypes: true }).map((d) => ({
        name: d.name,
        path: nodeJoin(p, d.name),
        isDirectory: d.isDirectory(),
      }));
    },
    async rename(from: string, to: string): Promise<void> {
      const { renameSync } = await import('node:fs');
      renameSync(from, to);
    },
    async removeDir(p: string): Promise<void> {
      rmSync(p, { recursive: true, force: true });
    },
    async appDataDir(): Promise<string> {
      return root;
    },
    addAppWritableRoot: () => undefined,
    setAppWritableRoots: () => undefined,
    setWritableRoots: () => undefined,
    isWritable: () => true,
  };
  return io as unknown as FileIO;
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

/** 没有远程面也要能装目录源：容器那条路走到即红（本文件不测它） */
function noRemote(): RemoteService {
  return {
    async fetchText() {
      throw new Error('本文件不出网');
    },
    async marketDownload() {
      throw new Error('本文件不下载');
    },
    async marketExtract() {
      throw new Error('本文件不解压');
    },
  } as unknown as RemoteService;
}

async function writeSource(root: string, over: Partial<PackManifest> = {}): Promise<PackManifest> {
  const files: PackFileEntry[] = [
    { path: `${MARKET_CONTENT_DIR}/a.erb`, bytes: 3, sha256: await sha256Hex(bytesOf('abc')) },
  ];
  const manifest: PackManifest = {
    schema: MARKET_SCHEMA_VERSION,
    kind: 'kojo-pack',
    id: 'demo.notify',
    version: '1.0.0',
    name: '出声包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    redistribute: true,
    minAppVersion: '0.4.0',
    files,
    ...over,
  };
  const dir = nodeJoin(root, SOURCE);
  mkdirSync(nodeJoin(dir, MARKET_CONTENT_DIR), { recursive: true });
  writeFileSync(nodeJoin(dir, MARKET_MANIFEST_FILE), JSON.stringify(manifest));
  writeFileSync(nodeJoin(dir, MARKET_CONTENT_DIR, 'a.erb'), bytesOf('abc'));
  return manifest;
}

interface Harness {
  service: MarketService;
  root: string;
  /** 出声器（消费者抛错必须在这里留痕，不许静默） */
  warns: string[];
  /** 收到过的通知（形状 = 契约那条订阅面推出来的） */
  seen: Array<{ change: 'installed' | 'uninstalled'; kind: string; id: string; version: string }>;
  /** 第二个订阅者（证明出声面向所有订阅者，不是只给"当前这一次点击"） */
  seen2: unknown[];
  unsubs: Array<() => void>;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(nodeJoin(tmpdir(), 'kojo-notify-'));
  tmps.push(root);
  const io = fakeIo(root);
  const warns: string[] = [];
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: (m: string) => warns.push(m),
  };
  const service = createMarketService({
    io,
    remote: noRemote(),
    storage: memStorage(),
    log,
    root,
    appVersion: APP_VERSION,
    now: () => 1_700_000_000_000,
  });
  const seen: Harness['seen'] = [];
  const seen2: unknown[] = [];
  const unsubs = [
    service.onInstalledChanged((change) => {
      seen.push(change as unknown as Harness['seen'][number]);
    }),
    service.onInstalledChanged((change) => {
      seen2.push(change);
    }),
  ];
  return { service, root, seen, seen2, unsubs, warns };
}

describe('已装清单变更的通知（MK-1 触发点，全程不靠 sleep）', () => {
  it('装成功后恰一声 `installed`，且**在 install 的 Promise 落回之前**已出声', async () => {
    const h = await harness();
    const manifest = await writeSource(h.root);
    await h.service.installLocalDir(nodeJoin(h.root, SOURCE));

    // `await` 已经返回 ⇒ 这里若还没出声，就永远不会有了（通知必须在落回之前发）
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toEqual({ change: 'installed', kind: manifest.kind, id: manifest.id, version: manifest.version });
    // 只带三元组：整条记录一律由 `installed()` 现读（通知里搬记录 = 第二份真相）
    expect(Object.keys(h.seen[0]!).sort()).toEqual(['change', 'id', 'kind', 'version']);
    expect(h.seen2).toHaveLength(1);
    // 通知发过之后，重读拿到的就是那一条（消费者重取一定拿得到真相，不会读到"还没装"）
    const list: InstalledPack[] = await h.service.installed();
    expect(list.map((r) => r.id)).toEqual([manifest.id]);
  });

  it('卸载成功后恰一声 `uninstalled`，同一三元组；重取即空', async () => {
    const h = await harness();
    const manifest = await writeSource(h.root);
    await h.service.installLocalDir(nodeJoin(h.root, SOURCE));
    h.seen.length = 0;

    const rec = await h.service.installed().then((l) => l[0]!);
    await h.service.uninstall(rec.kind, rec.id, rec.version);
    expect(h.seen).toEqual([
      { change: 'uninstalled', kind: manifest.kind, id: manifest.id, version: manifest.version },
    ]);
    expect(await h.service.installed()).toEqual([]);
  });

  it('装被拒 ⇒ **一声不出**（清单没变过，重取等于白跑；失败的原话照旧进错误对象）', async () => {
    const h = await harness();
    const manifest = await writeSource(h.root, { version: '1.0' as string });
    // 上面那份清单版本号不合格 ⇒ `installLocalDir` 当场拒（一个字节都不落地）
    await expect(h.service.installLocalDir(nodeJoin(h.root, SOURCE))).rejects.toBeInstanceOf(MarketError);
    expect(h.seen).toEqual([]);
    expect(h.seen2).toEqual([]);
  });

  it('卸一个没装过的 ⇒ `installed-missing`，一声不出', async () => {
    const h = await harness();
    await expect(h.service.uninstall('kojo-pack', '没装过的', '1.0.0')).rejects.toMatchObject({
      code: 'installed-missing',
    });
    expect(h.seen).toEqual([]);
  });

  it('同版本重装 ⇒ 仍恰一声 `installed`（搬运只有一条路径 ⇒ 触发点也只有一处）', async () => {
    const h = await harness();
    const manifest = await writeSource(h.root);
    await h.service.installLocalDir(nodeJoin(h.root, SOURCE));
    h.seen.length = 0;
    await h.service.installLocalDir(nodeJoin(h.root, SOURCE));
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.change).toBe('installed');
    expect(await h.service.installed()).toHaveLength(1);
    expect(manifest.id).toBe('demo.notify');
  });

  it('退订后不再出声；重复退订幂等', async () => {
    const h = await harness();
    await writeSource(h.root);
    h.unsubs[0]!();
    h.unsubs[0]!();
    await h.service.installLocalDir(nodeJoin(h.root, SOURCE));
    expect(h.seen).toEqual([]);
    expect(h.seen2).toHaveLength(1);
  });

  it('通知里抛出的消费者不吞消息、也不倒打装卸：一个炸了其余照收，本次结果仍是成功', async () => {
    const h = await harness();
    await writeSource(h.root);
    const service = h.service;
    const boom = service.onInstalledChanged(() => {
      throw new Error('消费者炸了');
    });
    const tail: unknown[] = [];
    const tailUnsub = service.onInstalledChanged((change) => {
      tail.push(change);
    });
    // 消费者 bug 不许把一次**已经成功**的装卸倒过来变成失败（作者会看见"没装上"而盘上明明有）
    await expect(service.installLocalDir(nodeJoin(h.root, SOURCE))).resolves.toBeDefined();
    expect(h.seen2).toHaveLength(1);
    expect(tail).toHaveLength(1);
    expect(h.warns.some((w) => /消费者炸了/.test(w))).toBe(true);
    boom();
    tailUnsub();
  });
});
