import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKET_DEFAULT_PUBLISH_URL,
  MARKET_MAX_CONTAINER_UPLOAD_BYTES,
  MARKET_SCHEMA_VERSION,
  MarketError,
  marketPublishTimeoutMs,
  packContainerName,
  type FileIO,
  type Logger,
  type MarketPublishOutcome,
  type MarketPublishProgress,
  type MarketService,
  type PackFileEntry,
  type PackManifest,
  type RemoteExtractEntry,
  type RemoteExtractLimits,
  type RemoteExtractResult,
  type RemotePublishOptions,
  type RemoteService,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { createMarketService, sha256Hex } from '../src/index';

/**
 * `MarketService.publish` 的**编排**判据（注入假壳层）。
 *
 * ⚠ 与 `install-index.test.ts` 同一条边界：这一整份文件只证明**编排顺序与拒因**，
 * **不证明上传**——假壳层的 `marketPublish` 只是把调用参数与进度原样记账，
 * HTTP / 流式读 / 节流 / Bearer 携带的真相在 `packages/app/src-tauri/src/market_tests.rs`
 * （cargo：请求构造、发布闸、裁决解析、令牌解析）。拿这里的绿去说"上传没问题"
 * 就是本仓明令禁止的"拿假桥当绿"。
 *
 * 钉死的六件事：
 * 1. 顺序：能力闸 → 端点形态闸 → 设备令牌（storage 复用）→ 本地预校验 → 上传；
 * 2. **预校验零出网**：清单类拒因（源不可读 / 打不开 / 对不平）在 `marketPublish` 调用之前就抛；
 * 3. 预校验与安装**同一条** `readSourceManifest` / `packContainerProblem`（不出现第二份校验）；
 * 4. 令牌只换一次，之后 storage 复用；
 * 5. 上传调用参数：端点（覆盖生效）、manifest 概要五字段、`maxBytes` = 契约上限、
 *    超时 = `marketPublishTimeoutMs(zip 字节)`、进度原样透传；
 * 6. 后端明确拒绝（`ok:false`）不是异常、原样回传；暂存区零残壳（成功与拒绝同一条 finally）。
 */

const APP_VERSION = '0.4.0-beta.1';
const tmps: string[] = [];

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 发布链路只用得着这几件 ⇒ 其余成员走到即红（假 io 不许顺手多提供能力） */
function fakeIo(root: string): FileIO {
  const io: Record<string, unknown> = {
    async readText(p: string) {
      return { path: p, text: readFileSync(p, 'utf8'), encoding: 'utf-8', eol: 'lf', mtimeMs: 1 };
    },
    async readBytes(p: string): Promise<Uint8Array> {
      return new Uint8Array(readFileSync(p));
    },
    async writeBytes(p: string, data: Uint8Array): Promise<void> {
      mkdirSync(nodeJoin(p, '..'), { recursive: true });
      writeFileSync(p, data);
    },
    async copyFile(from: string, to: string): Promise<void> {
      writeFileSync(to, readFileSync(from));
    },
    async stat(p: string) {
      try {
        const st = statSync(p);
        return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
      } catch {
        return null; // 契约口径：读不到 ⇒ null，不抛
      }
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

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/* ------------------------------- 清单与假容器 ------------------------------- */

async function filesOf(tree: Record<string, Uint8Array>): Promise<PackFileEntry[]> {
  const out: PackFileEntry[] = [];
  for (const [rel, bytes] of Object.entries(tree)) {
    out.push({ path: `files/${rel}`, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  return out;
}

async function manifestOf(
  tree: Record<string, Uint8Array>,
  over: Partial<PackManifest> = {},
): Promise<PackManifest> {
  return {
    schema: MARKET_SCHEMA_VERSION,
    kind: 'kojo-pack',
    id: 'demo.pack',
    version: '1.0.0',
    name: '演示包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    redistribute: true,
    minAppVersion: '0.4.0',
    files: await filesOf(tree),
    ...over,
  };
}

interface FakeOpts {
  files: Record<string, Uint8Array>;
  manifest: PackManifest;
  /** 容器里多出来的、清单没声明的条目（对平的第二向） */
  extra?: Record<string, Uint8Array>;
  /** 抽掉清单声明的某个条目（对平的第一向） */
  drop?: string;
  /** 解出的目录里不放 pack.json */
  noManifestFile?: boolean;
  /** 假 marketExtract 抛错（容器打不开） */
  extractThrows?: string;
  /** 假 marketPublish 抛错（平台侧故障） */
  publishThrows?: string;
  /** 假 marketDeviceToken 抛错（令牌拿不到） */
  tokenThrows?: string;
  /** 上传段给服务透传回来的进度帧（测 onProgress 原样透传） */
  publishFrames?: MarketPublishProgress[];
  /** 上传段的裁决（默认成功带 prUrl；要造后端拒绝就自己给） */
  outcome?: MarketPublishOutcome;
}

/**
 * 发布版的假壳层：`marketExtract` 按给定清单**构造**"解出来的样子"（不读 ZIP），
 * `marketPublish` 只记账（调用参数 + 进度透传 + 裁决回放），
 * `marketDeviceToken` 回放一枚固定令牌。三者的缺席/抛错都由 FakeOpts 驱动。
 */
class FakeBridge {
  readonly extractCalls: Array<{ container: string; target: string; limits: RemoteExtractLimits }> = [];
  readonly publishCalls: Array<{
    zipPath: string;
    manifest: unknown;
    token: string;
    opts: RemotePublishOptions | undefined;
  }> = [];
  tokenFetches = 0;
  o: FakeOpts;
  private marketRoot = '';
  private io: FileIO | undefined;

  constructor(o: FakeOpts) {
    this.o = o;
  }

  arm(root: string, io: FileIO): void {
    this.marketRoot = root;
    this.io = io;
  }

  private staged(name: string): string {
    return nodeJoin(this.marketRoot, '.staging', name);
  }

  private async write(p: string, data: Uint8Array): Promise<void> {
    if (this.io === undefined) throw new Error('假壳层没装 io');
    await this.io.writeBytes(p, data);
  }

  /** 预校验解出的条目表（默认与清单逐位一致；不符的用例自己造） */
  private extractedEntries(): RemoteExtractEntry[] {
    const out: RemoteExtractEntry[] = [];
    if (!this.o.noManifestFile) out.push({ path: 'pack.json', bytes: 2 });
    for (const [rel, b] of Object.entries(this.o.files)) {
      if (this.o.drop === `files/${rel}`) continue;
      out.push({ path: `files/${rel}`, bytes: b.length });
    }
    for (const [rel, b] of Object.entries(this.o.extra ?? {})) out.push({ path: rel, bytes: b.length });
    return out;
  }

  remote(): RemoteService {
    return {
      async fetchText(): Promise<never> {
        throw new Error('本文件不刷新索引');
      },
      marketDownload: async (): Promise<never> => {
        throw new Error('本文件不下载');
      },
      marketExtract: async (containerName: string, targetName: string, limits: RemoteExtractLimits) => {
        this.extractCalls.push({ container: containerName, target: targetName, limits });
        if (this.o.extractThrows !== undefined) throw new Error(this.o.extractThrows);
        const dir = this.staged(targetName);
        if (!this.o.noManifestFile) {
          await this.write(nodeJoin(dir, 'pack.json'), bytesOf(JSON.stringify(this.o.manifest)));
        }
        for (const [rel, b] of Object.entries(this.o.files)) {
          if (this.o.drop === `files/${rel}`) continue;
          await this.write(nodeJoin(dir, 'files', rel), b);
        }
        for (const [rel, b] of Object.entries(this.o.extra ?? {})) await this.write(nodeJoin(dir, rel), b);
        const entries = this.extractedEntries();
        const res: RemoteExtractResult = { entries, totalBytes: entries.reduce((s, e) => s + e.bytes, 0) };
        return res;
      },
      marketDeviceToken: async (_endpoint?: string) => {
        this.tokenFetches += 1;
        if (this.o.tokenThrows !== undefined) throw new Error(this.o.tokenThrows);
        return 'dev-token-1';
      },
      marketPublish: async (
        zipPath: string,
        manifest: Parameters<NonNullable<RemoteService['marketPublish']>>[1],
        token: string,
        opts?: RemotePublishOptions,
      ) => {
        this.publishCalls.push({ zipPath, manifest, token, opts });
        for (const f of this.o.publishFrames ?? []) opts?.onProgress?.(f);
        if (this.o.publishThrows !== undefined) throw new Error(this.o.publishThrows);
        return this.o.outcome ?? { ok: true as const, prUrl: 'https://github.com/p/pull/1', status: 200, finalUrl: `${MARKET_DEFAULT_PUBLISH_URL}/publish` };
      },
    };
  }

  containerName(): string {
    return packContainerName(this.o.manifest.id, this.o.manifest.version);
  }
}

interface Harness {
  svc: MarketService;
  root: string;
  bridge: FakeBridge;
  storage: ScopedStorage;
  /** 作者选定的 zip 文件（写到工作区外的任意位置——路径来自对话框，本测试用临时目录冒充） */
  chosenZip: string;
  /** 把 io.stat 换成谎报尺寸的（测体积上限闸） */
  lieAboutSize(size: number): void;
}

async function boot(o: FakeOpts): Promise<Harness> {
  const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-pub-'));
  tmps.push(appData);
  const root = nodeJoin(appData, 'market');
  mkdirSync(nodeJoin(root, '.staging'), { recursive: true });
  const rawIo = fakeIo(root);
  // stat 谎报钩子（体积上限闸的判据要一颗"大包"——真写 128 MiB 文件太贵）
  let statOverride: number | null = null;
  const io: FileIO = new Proxy(rawIo, {
    get(target, prop, recv) {
      if (prop === 'stat') {
        return async (p: string) => {
          const real = await (target.stat as FileIO['stat'])(p);
          return statOverride !== null && real !== null && real.isDirectory === false
            ? { ...real, size: statOverride }
            : real;
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  const bridge = new FakeBridge(o);
  bridge.arm(root, io);
  const storage = memStorage();
  const svc = createMarketService({
    io,
    remote: bridge.remote(),
    storage,
    log: quietLog,
    root,
    appVersion: APP_VERSION,
  });
  // 作者经系统对话框选定的 zip：写到暂存区外的一个真实文件（内容任意——假壳层不解 ZIP）
  const chosenZip = nodeJoin(appData, 'chosen', bridge.containerName());
  mkdirSync(nodeJoin(chosenZip, '..'), { recursive: true });
  writeFileSync(chosenZip, bytesOf('zip bytes here'));
  return {
    svc,
    root,
    bridge,
    storage,
    chosenZip,
    lieAboutSize: (size) => {
      statOverride = size;
    },
  };
}

function stagedLeftovers(root: string): string[] {
  try {
    return readdirSync(nodeJoin(root, '.staging')).sort();
  } catch {
    return [];
  }
}

async function codeOf(promise: Promise<unknown>): Promise<MarketError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketError);
    return err as MarketError;
  }
  throw new Error('本该抛出，结果没有');
}

afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});

/* ------------------------------- 判据 ------------------------------- */

describe('publish 的编排顺序', () => {
  it('成功一条：令牌换一次 → 预校验 → 上传参数逐位正确 → 暂存区零残壳', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const manifest = await manifestOf(tree);
    const h = await boot({ files: tree, manifest });

    const outcome = await h.svc.publish(h.chosenZip);

    expect(outcome).toMatchObject({ ok: true, prUrl: 'https://github.com/p/pull/1' });
    expect(h.bridge.tokenFetches).toBe(1);
    expect(h.bridge.publishCalls).toHaveLength(1);
    const call = h.bridge.publishCalls[0]!;
    expect(call.zipPath).toBe(h.chosenZip);
    expect(call.manifest).toEqual({ kind: 'kojo-pack', id: 'demo.pack', version: '1.0.0', name: '演示包', author: 'someone' });
    expect(call.token).toBe('dev-token-1');
    expect(call.opts?.endpoint).toBe(MARKET_DEFAULT_PUBLISH_URL);
    expect(call.opts?.maxBytes).toBe(MARKET_MAX_CONTAINER_UPLOAD_BYTES);
    expect(call.opts?.timeoutMs).toBe(marketPublishTimeoutMs(statSync(h.chosenZip).size));
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('第二次发布不再换令牌（storage 复用），端点覆盖生效', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const manifest = await manifestOf(tree);
    const h = await boot({ files: tree, manifest });
    await h.svc.publish(h.chosenZip);
    await h.svc.publish(h.chosenZip, { endpoint: 'https://t.workers.dev' });
    expect(h.bridge.tokenFetches).toBe(1);
    expect(h.bridge.publishCalls[1]?.opts?.endpoint).toBe('https://t.workers.dev');
  });

  it('进度原样透传（节流在平台侧，本层不加工）', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const manifest = await manifestOf(tree);
    const frames: MarketPublishProgress[] = [
      { sentBytes: 65536, totalBytes: 1000 },
      { sentBytes: 1000, totalBytes: 1000 },
    ];
    const h = await boot({ files: tree, manifest, publishFrames: frames });
    const seen: MarketPublishProgress[] = [];
    await h.svc.publish(h.chosenZip, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual(frames);
  });

  it('后端明确拒绝（ok:false）不是异常：原样回传 rejected，暂存区零残壳', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const manifest = await manifestOf(tree);
    const rejection: MarketPublishOutcome = {
      ok: false,
      rejected: { code: 'container-invalid', message: '包体缺 pack.json' },
      status: 422,
      finalUrl: `${MARKET_DEFAULT_PUBLISH_URL}/publish`,
    };
    const h = await boot({ files: tree, manifest, outcome: rejection });
    const outcome = await h.svc.publish(h.chosenZip);
    expect(outcome).toEqual(rejection);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });
});

describe('publish 的预校验拒因（零出网：marketPublish 不许被调到）', () => {
  it('zip 读不到 → source-unreadable', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    const err = await codeOf(h.svc.publish(nodeJoin(h.root, 'no-such.zip')));
    expect(err.code).toBe('source-unreadable');
    expect(h.bridge.publishCalls).toHaveLength(0);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('包体超限 → bytes-limit（上限来自契约常量：CF 免费档 100,000,000 字节边缘留 1 MB 余量）', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    h.lieAboutSize(MARKET_MAX_CONTAINER_UPLOAD_BYTES + 1);
    const err = await codeOf(h.svc.publish(h.chosenZip));
    expect(err.code).toBe('bytes-limit');
    expect(h.bridge.publishCalls).toHaveLength(0);
  });

  it('容器打不开（解压失败）→ extract-failed', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), extractThrows: 'bad zip' });
    const err = await codeOf(h.svc.publish(h.chosenZip));
    expect(err.code).toBe('extract-failed');
    expect(h.bridge.publishCalls).toHaveLength(0);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('解出目录里没有 pack.json → manifest-missing（与安装同一条 readSourceManifest）', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), noManifestFile: true });
    const err = await codeOf(h.svc.publish(h.chosenZip));
    expect(err.code).toBe('manifest-missing');
    expect(h.bridge.publishCalls).toHaveLength(0);
  });

  it('对平不平：清单声明了容器里没有的条目 → entry-missing', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), drop: 'files/a.erb' });
    const err = await codeOf(h.svc.publish(h.chosenZip));
    expect(err.code).toBe('entry-missing');
    expect(h.bridge.publishCalls).toHaveLength(0);
  });

  it('对平不平：容器里多出清单没声明的条目 → entry-extra', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), extra: { 'pack.json.bak': bytesOf('x') } });
    const err = await codeOf(h.svc.publish(h.chosenZip));
    expect(err.code).toBe('entry-extra');
    expect(h.bridge.publishCalls).toHaveLength(0);
  });

  it('发布地址不合法 → endpoint-invalid（零网络）', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    const err = await codeOf(h.svc.publish(h.chosenZip, { endpoint: 'http://evil.example.com' }));
    expect(err.code).toBe('endpoint-invalid');
    expect(h.bridge.tokenFetches).toBe(0);
    expect(h.bridge.publishCalls).toHaveLength(0);
  });
});

describe('publish 的能力与令牌路径', () => {
  it('平台没有发布能力（Node 桥形态）→ 一句人话，零出网', async () => {
    const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-pub-nocap-'));
    tmps.push(appData);
    const root = nodeJoin(appData, 'market');
    mkdirSync(nodeJoin(root, '.staging'), { recursive: true });
    const svc = createMarketService({
      io: fakeIo(root),
      // 桩只给必选三件（发布通道批之前的形状）⇒ 发布能力缺席
      remote: {
        async fetchText(): Promise<never> {
          throw new Error('x');
        },
        async marketDownload(): Promise<never> {
          throw new Error('x');
        },
        async marketExtract(): Promise<never> {
          throw new Error('x');
        },
      },
      storage: memStorage(),
      log: quietLog,
      root,
      appVersion: APP_VERSION,
    });
    await expect(svc.publish('C:\\whatever.zip')).rejects.toThrow('当前平台没有发布能力');
  });

  it('令牌拿不到 → 一句人话（不吞平台的失败细节）', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), tokenThrows: '网络不可达' });
    await expect(h.svc.publish(h.chosenZip)).rejects.toThrow('设备令牌没拿到（无法发布）：网络不可达');
    expect(h.bridge.publishCalls).toHaveLength(0);
  });

  it('平台侧故障（上传抛错）→ 一句人话，令牌已落 storage 供下次复用', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), publishThrows: '断网' });
    await expect(h.svc.publish(h.chosenZip)).rejects.toThrow('发布没有成功：断网');
    expect(h.bridge.tokenFetches).toBe(1);
    expect(await h.storage.get<string>('deviceToken')).toBe('dev-token-1');
    expect(stagedLeftovers(h.root)).toEqual([]);
  });
});
