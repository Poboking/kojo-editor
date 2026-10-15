import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_SCHEMA_VERSION,
  MarketError,
  packContainerName,
  packStagingName,
  packStagingNames,
  packUnpackedName,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketIndexEntry,
  type MarketService,
  type PackFileEntry,
  type PackKind,
  type PackManifest,
  type RemoteDownload,
  type RemoteDownloadOptions,
  type RemoteExtractEntry,
  type RemoteExtractLimits,
  type RemoteExtractResult,
  type RemoteService,
  type RemoteText,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { createMarketService, sha256Hex } from '../src/index';

/**
 * `installFromIndex` 的**编排**判据（注入假桥）。
 *
 * ⚠ 这一整份文件只证明**编排顺序与拒因**，**不证明解压**：
 * 假桥的 `marketDownload` 只是把给定字节写到平台侧要求的位置、`marketExtract` 只是把给定
 * 文件表摊平到目标目录——它按给定清单**构造**"解出来的样子"，而不是真的读 ZIP。
 * ZIP 解析与条目路径 / 符号链接 / 体积那三道闸的真相在
 * `packages/app/src-tauri/src/market_tests.rs`（cargo）与
 * `tools/smoke-tauri-market.mjs` 的 **k 项**（真壳：真下载 → 真解压 → 真装成 `packs/…` →
 * 屏上「已安装」→ 卸载 → 目录清空）。拿这里的绿去说"解压没问题"就是本仓明令禁止的
 * "拿假桥当绿"。同理，本文件的 `FileIO` 替身**不带写允许域闸**——闸的判据在
 * `packages/kernel/tests/integration-market.test.ts`（真内核 + 真 NodeBridge）。
 *
 * 钉死的六件事：
 * 1. 顺序：形态闸 → 下载 → **容器整包摘要对平** → 解压 → 读清单 → 双向对平 → 搬运；
 * 2. 容器摘要不符时**根本不解压**（不对一个来路不明的容器动盘）；
 * 3. 解压限额三个数来自契约常量、下载体积上限来自索引声明（撒谎的声明换不来无上限下载）；
 * 4. 双向对平四个方向各自的拒码；
 * 5. 清单类拒码仍由**同一条** `commitPack`/`readSourceManifest` 给出（不出现第二份校验）；
 * 6. 失败不留半成品：落点要么完整要么不存在、`.staging` 零残壳（KM-12）。
 */

const APP_VERSION = '0.4.0-beta.1';
const INSTALLED_AT = 1_700_000_000_000;
const tmps: string[] = [];

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 装卸链路只用得着这几件 ⇒ 其余成员走到即红（假桥不许顺手多提供能力） */
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

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/* ------------------------------- 容器与索引行 ------------------------------- */

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
  /** 由 files 现算（manifestOf）；要造"清单与容器不符"就自己给一份 */
  manifest: PackManifest;
  /** 容器里多出来的、清单没声明的条目（双向对平的第二向） */
  extra?: Record<string, Uint8Array>;
  /** 抽掉清单声明的某个条目（第一向） */
  drop?: string;
  /** 解出的目录里不放 pack.json */
  noManifestFile?: boolean;
  /** 条目字节谎报（解出的真实字节与返回的 entries 字节故意不一致） */
  wrongEntryBytes?: boolean;
  downloadThrows?: string;
  extractThrows?: string;
  /** 索引那一行想说什么（默认 = 与容器里的清单一致） */
  declared?: Partial<MarketIndexEntry>;
  /** 索引那行的 zip（默认 = 真容器的 sha256/bytes；要造不符就自己给） */
  zip?: { url: string; sha256: string; bytes: number };
}

class FakeBridge {
  readonly calls: Array<'download' | 'extract'> = [];
  readonly downloadOpts: Array<RemoteDownloadOptions | undefined> = [];
  readonly extractLimits: RemoteExtractLimits[] = [];
  readonly seen: Array<{ container: string; target: string }> = [];
  /** 可以被"换一次容器内容"（重装判据要在同一个服务实例上换内容 ⇒ 桥也只能是同一个实例） */
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

  /** 清单字节（= 假容器包体的主体；真容器的 ZIP 结构由 Rust 解，见文件头那条边界） */
  manifestBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.manifest(), null, 2));
  }

  containerBytes(): Uint8Array {
    return new Uint8Array([...this.manifestBytes(), ...Object.values(this.o.files).flatMap((b) => [...b])]);
  }

  manifest(): PackManifest {
    return this.o.manifest;
  }

  /** 索引那一行（默认与容器内容逐字一致；不符的用例自己覆盖 `declared` / `zip`） */
  async entry(): Promise<MarketIndexEntry> {
    const m = this.manifest();
    const cb = this.containerBytes();
    const declared = this.o.declared ?? {};
    return {
      kind: m.kind,
      id: m.id,
      version: m.version,
      name: m.name,
      author: m.author,
      license: m.license,
      minAppVersion: m.minAppVersion,
      zip: this.o.zip ?? {
        url: `https://github.com/p/p/releases/download/${m.id}-v${m.version}/${packContainerName(m.id, m.version)}`,
        sha256: await sha256Hex(cb),
        bytes: cb.length,
      },
      fileCount: Object.keys(this.o.files).length,
      unpackedBytes: Object.values(this.o.files).reduce((s, b) => s + b.length, 0),
      ...declared,
    };
  }

  private staged(name: string): string {
    return nodeJoin(this.marketRoot, '.staging', name);
  }

  private async write(p: string, data: Uint8Array): Promise<void> {
    if (this.io === undefined) throw new Error('假桥没装 io');
    await this.io.writeBytes(p, data);
  }

  private extractedEntries(): RemoteExtractEntry[] {
    const out: RemoteExtractEntry[] = [];
    if (!this.o.noManifestFile) out.push({ path: 'pack.json', bytes: this.manifestBytes().length });
    for (const [rel, b] of Object.entries(this.o.files)) {
      if (this.o.drop === `files/${rel}`) continue;
      out.push({ path: `files/${rel}`, bytes: this.o.wrongEntryBytes ? b.length + 1 : b.length });
    }
    for (const [rel, b] of Object.entries(this.o.extra ?? {})) out.push({ path: rel, bytes: b.length });
    return out;
  }

  remote(): RemoteService {
    return {
      async fetchText(): Promise<RemoteText> {
        throw new Error('本文件不刷新索引');
      },
      marketDownload: async (url: string, containerName: string, opts?: RemoteDownloadOptions) => {
        this.calls.push('download');
        this.downloadOpts.push(opts);
        if (this.o.downloadThrows !== undefined) throw new Error(this.o.downloadThrows);
        // 平台侧的落点决定权：TS 只给名字，这里按名字把字节写进同一个位置
        await this.write(this.staged(containerName), this.containerBytes());
        const res: RemoteDownload = { bytes: this.containerBytes().length, status: 200, finalUrl: url };
        return res;
      },
      marketExtract: async (containerName: string, targetName: string, limits: RemoteExtractLimits) => {
        this.calls.push('extract');
        this.extractLimits.push(limits);
        this.seen.push({ container: containerName, target: targetName });
        if (this.o.extractThrows !== undefined) throw new Error(this.o.extractThrows);
        const dir = this.staged(targetName);
        if (!this.o.noManifestFile) await this.write(nodeJoin(dir, 'pack.json'), this.manifestBytes());
        for (const [rel, b] of Object.entries(this.o.files)) {
          if (this.o.drop === `files/${rel}`) continue;
          await this.write(nodeJoin(dir, 'files', rel), b);
        }
        for (const [rel, b] of Object.entries(this.o.extra ?? {})) await this.write(nodeJoin(dir, rel), b);
        const entries = this.extractedEntries();
        const res: RemoteExtractResult = { entries, totalBytes: entries.reduce((s, e) => s + e.bytes, 0) };
        return res;
      },
    };
  }
}

interface Harness {
  svc: MarketService;
  io: FileIO;
  root: string;
  bridge: FakeBridge;
  entry: MarketIndexEntry;
  /** 换一次容器内容（重装判据必须在**同一个服务实例**上跑——服务的 remote 是创建时绑定的那一个） */
  retarget(o: FakeOpts): Promise<MarketIndexEntry>;
}

async function boot(o: FakeOpts): Promise<Harness> {
  const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-idx-'));
  tmps.push(appData);
  const root = nodeJoin(appData, 'market');
  mkdirSync(nodeJoin(root, '.staging'), { recursive: true });
  const io = fakeIo(root);
  const bridge = new FakeBridge(o);
  bridge.arm(root, io);
  const svc = createMarketService({
    io,
    remote: bridge.remote(),
    storage: memStorage(),
    log: quietLog,
    root,
    appVersion: APP_VERSION,
    now: () => INSTALLED_AT,
  });
  return {
    svc,
    io,
    root,
    bridge,
    entry: await bridge.entry(),
    retarget: async (next: FakeOpts) => {
      bridge.calls.length = 0;
      bridge.downloadOpts.length = 0;
      bridge.extractLimits.length = 0;
      bridge.seen.length = 0;
      bridge.o = next;
      return bridge.entry();
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

describe('installFromIndex 的编排顺序', () => {
  it('成功一条：下载 → 容器摘要 → 解压 → 装进 packs/<kind>/<id>/<version>/files，记账带容器摘要，暂存区零残壳', async () => {
    const tree = { 'a.erb': bytesOf('口上 A\r\n') };
    const manifest = await manifestOf(tree);
    const h = await boot({ files: tree, manifest });
    const rec: InstalledPack = await h.svc.installFromIndex(h.entry);

    expect(h.bridge.calls).toEqual(['download', 'extract']);
    expect(rec).toMatchObject({ kind: 'kojo-pack', id: 'demo.pack', version: '1.0.0', installedAt: INSTALLED_AT });
    expect(rec.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.containerSha256).toBe(h.entry.zip.sha256);
    expect(Object.keys(rec)).not.toContain('dir');

    const dir = await h.svc.installDir('kojo-pack', 'demo.pack', '1.0.0');
    expect(readFileSync(nodeJoin(dir, 'files', 'a.erb'), 'utf8')).toBe('口上 A\r\n');
    // 落点只有清单声明的内容（与目录源同一条路径 ⇒ 不额外摆一份 pack.json 进落点）
    expect(() => readFileSync(nodeJoin(dir, 'pack.json'))).toThrow();
    expect(stagedLeftovers(h.root)).toEqual([]);
    expect(await h.svc.isInstalled('kojo-pack', 'demo.pack', '1.0.0')).toBe(true);
    expect((await h.svc.installed())[0]!.containerSha256).toBe(h.entry.zip.sha256);
  });

  it('下载体积上限 = 索引声明的 zip.bytes；声明撒谎（超大）时与解压上限取小', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const manifest = await manifestOf(tree);
    const a = await boot({ files: tree, manifest, zip: undefined });
    await a.svc.installFromIndex(a.entry);
    expect(a.bridge.downloadOpts[0]?.maxBytes).toBe(a.entry.zip.bytes);

    const b = await boot({
      files: tree,
      manifest,
      zip: { url: 'https://github.com/p/p/releases/download/a/a.zip', sha256: 'a'.repeat(64), bytes: 9 * 1024 ** 3 },
    });
    await codeOf(b.svc.installFromIndex(b.entry));
    expect(b.bridge.downloadOpts[0]?.maxBytes).toBe(MARKET_MAX_UNPACKED_BYTES);
    expect(b.bridge.calls).toEqual(['download']); // 谎报的行不会换来"整包摘要对平之后继续解压"
  });

  it('解压限额三个数全部来自契约常量（Rust 不写死数值）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    await h.svc.installFromIndex(h.entry);
    expect(h.bridge.extractLimits).toEqual([
      {
        maxEntries: MARKET_MAX_FILE_ENTRIES,
        maxDepth: MARKET_MAX_PATH_DEPTH,
        maxUnpackedBytes: MARKET_MAX_UNPACKED_BYTES,
      },
    ]);
  });

  it('容器名与解压名同主体（同一个文件、两个动词），搬运用的暂存名不与它们相撞', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    await h.svc.installFromIndex(h.entry);
    expect(h.bridge.seen).toEqual([
      { container: 'demo.pack-1.0.0.zip', target: 'demo.pack-1.0.0.unpacked' },
    ]);
    expect(packStagingName('demo.pack', '1.0.0')).toBe('demo.pack-1.0.0');
    expect(packUnpackedName('demo.pack', '1.0.0')).toBe('demo.pack-1.0.0.unpacked');
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('地址形态不合格 ⇒ download-failed，且一个字节都不落', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({
      files: tree,
      manifest: await manifestOf(tree),
      zip: { url: 'http://github.com/a/a.zip', sha256: 'a'.repeat(64), bytes: 4 },
    });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('download-failed');
    expect(h.bridge.calls).toEqual([]);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('下载抛来平台那句 ⇒ download-failed 且原话进消息（不静默、不猜）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({
      files: tree,
      manifest: await manifestOf(tree),
      downloadThrows: 'market_download 拒绝（主机不在白名单内：evil.example.com）',
    });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('download-failed');
    expect(err.message).toContain('主机不在白名单内：evil.example.com');
    expect(stagedLeftovers(h.root)).toEqual([]);
  });
});

describe('installFromIndex 的容器整包对平', () => {
  it('容器摘要不符 ⇒ container-sha256，**不解压**、落点不出现、暂存区清零', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    // 字节数照实、只把摘要锚换一个 ⇒ 先过字节闸、再被整包摘要闸拦下（顺序也在这条用例里）
    const entry: MarketIndexEntry = {
      ...h.entry,
      zip: { url: h.entry.zip.url, sha256: 'f'.repeat(64), bytes: h.entry.zip.bytes },
    };
    const err = await codeOf(h.svc.installFromIndex(entry));
    expect(err.code).toBe('container-sha256');
    expect(h.bridge.calls).toEqual(['download']);
    expect(err.message).toContain(entry.zip.sha256);
    expect(await h.svc.isInstalled('kojo-pack', 'demo.pack', '1.0.0')).toBe(false);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('容器字节数与声明不符 ⇒ container-bytes（摘要算得出也不放行，且不往下解压）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({
      files: tree,
      manifest: await manifestOf(tree),
      // 行上写 4 字节：容器实际不是 4 字节（摘要锚给个"看着像"的值，先被字节闸拦下）
      zip: { url: 'https://github.com/p/p/releases/download/a/a.zip', sha256: 'a'.repeat(64), bytes: 4 },
    });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('container-bytes');
    expect(err.detail).toContain('4');
    expect(h.bridge.calls).toEqual(['download']);
    expect(stagedLeftovers(h.root)).toEqual([]);
  });
});

describe('installFromIndex 的双向对平', () => {
  it('解压抛 ⇒ extract-failed，落点不出现、暂存区清零（平台那句原话进消息）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({
      files: tree,
      manifest: await manifestOf(tree),
      extractThrows: 'path-dotdot：条目路径非法 "../escape"（容器 demo.pack-1.0.0.zip）',
    });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('extract-failed');
    expect(err.message).toContain('path-dotdot');
    expect(stagedLeftovers(h.root)).toEqual([]);
    expect(await h.svc.isInstalled('kojo-pack', 'demo.pack', '1.0.0')).toBe(false);
  });

  it('清单声明了、容器没解出 ⇒ entry-missing（对平发生在写盘之前）', async () => {
    const tree = { 'a.erb': bytesOf('x'), 'b.erb': bytesOf('yy') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), drop: 'files/b.erb' });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('entry-missing');
    expect(err.detail).toBe('files/b.erb');
    expect(stagedLeftovers(h.root)).toEqual([]);
    expect(await h.svc.isInstalled('kojo-pack', 'demo.pack', '1.0.0')).toBe(false);
  });

  it('容器解出、清单没声明 ⇒ entry-extra；那个文件既不落点也不留暂存', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({
      files: tree,
      manifest: await manifestOf(tree),
      extra: { '悄悄塞进来的.erb': bytesOf('boo') },
    });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('entry-extra');
    expect(err.detail).toBe('悄悄塞进来的.erb');
    expect(stagedLeftovers(h.root)).toEqual([]);
    const dir = await h.svc.installDir('kojo-pack', 'demo.pack', '1.0.0');
    expect(() => readFileSync(nodeJoin(dir, '悄悄塞进来的.erb'))).toThrow();
  });

  it('解出的条目字节与清单不符 ⇒ entry-bytes', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), wrongEntryBytes: true });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('entry-bytes');
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('根 pack.json 算元数据、不算"清单外多出来的条目"', async () => {
    const tree = { 'a.erb': bytesOf('x'), 'sub/dir/c.bin': Uint8Array.from([0, 1, 0x80, 0xff]) };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    const rec = await h.svc.installFromIndex(h.entry);
    expect(rec.files.map((f) => f.path).sort()).toEqual(['files/a.erb', 'files/sub/dir/c.bin']);
  });

  it('解出的目录里没有 pack.json ⇒ manifest-missing（同一条路径的第一闸）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree), noManifestFile: true });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('manifest-missing');
  });

  it('容器里的身份与注册表那一行不符 ⇒ container-identity（kind / id / version 各一例）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const cases: Array<Partial<MarketIndexEntry>> = [
      { id: 'other.pack' },
      { kind: 'dict-pack' },
      { version: '1.0.1' },
    ];
    for (const declared of cases) {
      const h = await boot({ files: tree, manifest: await manifestOf(tree), declared });
      const err = await codeOf(h.svc.installFromIndex(h.entry));
      expect(err.code).toBe('container-identity');
      expect(stagedLeftovers(h.root)).toEqual([]);
    }
  });
});

describe('installFromIndex 复用同一条校验路径 + 回滚（KM-12）', () => {
  it('容器里的 redistribute=false ⇒ 拒码仍出自同一条清单校验', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree, { redistribute: false }) });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('redistribute-denied');
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('逐文件锚不符（容器内容与清单说的不是同一份东西）⇒ entry-sha256，由搬运路径那道闸拦下', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const manifest = await manifestOf(tree);
    const bad: PackManifest = { ...manifest, files: manifest.files.map((f) => ({ ...f, sha256: '0'.repeat(64) })) };
    const h = await boot({ files: tree, manifest: bad });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('entry-sha256');
    expect(h.bridge.calls).toEqual(['download', 'extract']); // 走到了搬运路径里逐文件复核那一步
    expect(stagedLeftovers(h.root)).toEqual([]);
  });

  it('清单条目路径不合法（逃出 files/）⇒ path-prefix，同一条路径给的码', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const manifest = await manifestOf(tree);
    const escaped: PackManifest = { ...manifest, files: [{ path: 'a.erb', bytes: 1, sha256: manifest.files[0]!.sha256 }] };
    const h = await boot({ files: { 'a.erb': bytesOf('x') }, manifest: escaped });
    const err = await codeOf(h.svc.installFromIndex(h.entry));
    expect(err.code).toBe('path-prefix');
  });

  it('同版本重装 = 覆盖：旧副本先搬进暂存再删，装完暂存区零残壳', async () => {
    const v1 = { 'a.erb': bytesOf('第一版') };
    const h = await boot({ files: v1, manifest: await manifestOf(v1) });
    const first = await h.svc.installFromIndex(h.entry);

    // 同一个 id/版本换内容重装：索引那行的锚跟着换（同一个服务实例、同一张桥）
    const v2 = { 'a.erb': bytesOf('第二版'), 'b.erb': bytesOf('新') };
    const entry2 = await h.retarget({ files: v2, manifest: await manifestOf(v2) });
    const second = await h.svc.installFromIndex(entry2);

    expect(second.contentDigest).not.toBe(first.contentDigest);
    expect(second.containerSha256).not.toBe(first.containerSha256);
    const dir = await h.svc.installDir('kojo-pack', 'demo.pack', '1.0.0');
    expect(readFileSync(nodeJoin(dir, 'files', 'a.erb'), 'utf8')).toBe('第二版');
    expect(readFileSync(nodeJoin(dir, 'files', 'b.erb'), 'utf8')).toBe('新');
    // 旧副本先搬进 `.staging` 再删 ⇒ 装完不该再有 `.__previous__` 壳
    expect(stagedLeftovers(h.root)).toEqual([]);
    expect(await h.svc.installed()).toHaveLength(1);
  });

  it('重装失败 ⇒ 旧落点原样还在（对平拒在把旧副本挪开之前）', async () => {
    const v1 = { 'a.erb': bytesOf('旧内容') };
    const manifest1 = await manifestOf(v1);
    const h = await boot({ files: v1, manifest: manifest1 });
    const first = await h.svc.installFromIndex(h.entry);

    // 第二次的解出条目字节谎报 ⇒ 双向对平当场拒
    const entry2 = await h.retarget({ files: v1, manifest: manifest1, wrongEntryBytes: true });
    const err = await codeOf(h.svc.installFromIndex(entry2));
    expect(err.code).toBe('entry-bytes');
    const dir = await h.svc.installDir('kojo-pack', 'demo.pack', '1.0.0');
    expect(readFileSync(nodeJoin(dir, 'files', 'a.erb'), 'utf8')).toBe('旧内容');
    expect(stagedLeftovers(h.root)).toEqual([]);
    expect((await h.svc.installed())[0]!.containerSha256).toBe(first.containerSha256);
  });

  it('卸载清扫这个包可能留下的全部暂存名字（KM-11 零残壳）', async () => {
    const tree = { 'a.erb': bytesOf('x') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    await h.svc.installFromIndex(h.entry);
    // 手工造四样残壳（崩在暂存区的容器 / 解压目录 / 搬运目录 / 旧副本）
    for (const name of packStagingNames('demo.pack', '1.0.0')) {
      await h.io.writeBytes(nodeJoin(h.root, '.staging', name, 'leftover.txt'), bytesOf('壳'));
    }
    expect(stagedLeftovers(h.root).length).toBe(4);
    await h.svc.uninstall('kojo-pack', 'demo.pack', '1.0.0');
    expect(stagedLeftovers(h.root)).toEqual([]);
    expect(await h.svc.isInstalled('kojo-pack', 'demo.pack', '1.0.0')).toBe(false);
    expect(await h.svc.installedBytes()).toBe(0);
  });
});

describe('已装占用字节（KM-11）', () => {
  it('installedBytes = 各包 files 声明字节之和；目录源与容器源一起算', async () => {
    const tree = { 'a.erb': bytesOf('12345'), 'b.erb': bytesOf('123') };
    const h = await boot({ files: tree, manifest: await manifestOf(tree) });
    expect(await h.svc.installedBytes()).toBe(0);
    const rec = await h.svc.installFromIndex(h.entry);
    expect(await h.svc.installedBytes()).toBe(8);

    const srcRoot = mkdtempSync(nodeJoin(tmpdir(), 'kojo-market-src-'));
    tmps.push(srcRoot);
    const other = { 'z.erb': bytesOf('abcdef') };
    const manifest2 = await manifestOf(other, { id: 'local.pack', kind: 'dict-pack' as PackKind });
    mkdirSync(nodeJoin(srcRoot, 'files'), { recursive: true });
    writeFileSync(nodeJoin(srcRoot, 'files', 'z.erb'), other['z.erb']);
    writeFileSync(nodeJoin(srcRoot, 'pack.json'), JSON.stringify(manifest2, null, 2), 'utf8');
    await h.svc.installLocalDir(srcRoot);
    expect(await h.svc.installedBytes()).toBe(8 + 6);
    expect((await h.svc.installed()).map((r) => r.id).sort()).toEqual(['demo.pack', 'local.pack']);
    expect(rec.containerSha256).toBeDefined();
  });
});
