import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import iconv from 'iconv-lite';
import {
  KernelServices,
  MARKET_DEFAULT_INDEX_URL,
  MARKET_INDEX_TIMEOUT_MS,
  MARKET_MAX_INDEX_BYTES,
  MARKET_MAX_FILE_ENTRIES,
  MARKET_SERVICE_KEY,
  WriteNotAllowedError,
  join,
  type InstalledPack,
  type Logger,
  type MarketService,
  type PackFileEntry,
  type PackManifest,
  type RemoteService,
  type RemoteText,
  type RemoteTextOptions,
} from '@kojo/plugin-api';
import { MarketError } from '@kojo/plugin-api';
import { createKojoMarketPlugin, sha256Hex } from '@kojo/plugin-kojo-market';
import { createKernel, type Kernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';

/**
 * 市场 v1（KM-2 + KM-4 落点接线）集成判据 —— **真内核 + 真 NodeBridge + 真第一道闸 + 真存储域**。
 *
 * 搭法照 `integration-plugins.test.ts`（`NodeBridge(appData)` + `MemoryStorageBackend`），
 * 但**不挂 `skipIf`**：市场只认"包"，零语料依赖，离线闭环必须常在。
 *
 * 钉死的口径：
 * - 内容一律**字节级**落盘（Shift-JIS / BOM 样本原样回来，转码即红）；
 * - 校验锚 = `pack.json` 逐文件 sha256，装前全量校验、装后逐文件重算复核；
 * - 失败不留半成品：`.staging` 无残壳、`packs/` 连目录都不出现；
 * - 写只准住 `<appData>/market`（appData 其它角落仍越权）。
 */

const APP_VERSION = '0.4.0-beta.1';
const INSTALLED_AT = 1_700_000_000_000;

interface Harness {
  kernel: Kernel;
  io: Kernel['io'];
  service: MarketService;
  appData: string;
  market: string;
  warns: string[];
  bridge: NodeBridge;
}

const tmps: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(nodeJoin(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});

async function boot(appVersion = APP_VERSION): Promise<Harness> {
  const appData = tmp('kojo-market-app-');
  const bridge = new NodeBridge(appData);
  const warns: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m) => warns.push(String(m)),
    error: (m) => warns.push(`[error] ${String(m)}`),
  };
  const kernel = await createKernel({
    platform: bridge,
    plugins: [createKojoMarketPlugin({ appVersion, now: () => INSTALLED_AT })],
    storageBackend: new MemoryStorageBackend(),
    logger,
  });
  await kernel.start();
  return {
    kernel,
    io: kernel.io,
    service: kernel.services.get<MarketService>(MARKET_SERVICE_KEY),
    appData,
    market: join(appData, 'market'),
    warns,
    bridge,
  };
}

/* ------------------------------- 夹具 ------------------------------- */

async function entriesOf(tree: Record<string, Uint8Array>): Promise<PackFileEntry[]> {
  const out: PackFileEntry[] = [];
  for (const [relPath, bytes] of Object.entries(tree)) {
    out.push({ path: `files/${relPath}`, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  return out;
}

function manifestOf(files: PackFileEntry[], over: Partial<PackManifest> = {}): PackManifest {
  return {
    schema: 1,
    kind: 'kojo-pack',
    id: 'demo.pack',
    version: '1.0.0',
    name: '演示包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    redistribute: true,
    minAppVersion: '0.4.0',
    files,
    ...over,
  };
}

/** 源目录住在 appData **之外**（读侧不受闸 ⇒ 正好证明写侧全落在 market 根内） */
function sourceDir(tree: Record<string, Uint8Array>, manifest: PackManifest): string {
  const dir = tmp('kojo-market-src-');
  for (const [relPath, bytes] of Object.entries(tree)) {
    const p = nodeJoin(dir, 'files', ...relPath.split('/'));
    mkdirSync(nodeJoin(p, '..'), { recursive: true });
    writeFileSync(p, bytes);
  }
  writeFileSync(nodeJoin(dir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

async function samplePack(id = 'demo.pack'): Promise<{ manifest: PackManifest; tree: Record<string, Uint8Array> }> {
  const tree = { 'a.erb': new Uint8Array([1, 2, 3]) };
  return { manifest: manifestOf(await entriesOf(tree), { id }), tree };
}

/** 索引里的一条（形状合规；`over` 用来造坏条目） */
function indexEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'kojo-pack',
    id,
    version: '1.0.0',
    name: `包 ${id}`,
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    minAppVersion: '0.4.0',
    zip: { url: `https://example.test/${id}.zip`, sha256: 'a'.repeat(64), bytes: 10 },
    fileCount: 1,
    unpackedBytes: 10,
    ...over,
  };
}

function indexJson(packs: unknown[]): string {
  return JSON.stringify({ schema: 1, generatedAt: '2026-10-15T00:00:00Z', packs });
}

/** 在实例上覆盖桥的远程方法（桥是内核持有引用的同一个对象 ⇒ 覆盖即生效） */
function stubRemote(
  h: Harness,
  impl: (url: string, opts?: RemoteTextOptions) => Promise<RemoteText>,
): { urls: string[]; opts: Array<RemoteTextOptions | undefined> } {
  const urls: string[] = [];
  const opts: Array<RemoteTextOptions | undefined> = [];
  h.bridge.fetchText = async (url: string, o?: RemoteTextOptions): Promise<RemoteText> => {
    urls.push(url);
    opts.push(o);
    return impl(url, o);
  };
  return { urls, opts };
}

const text = (s: string): RemoteText => ({ text: s, bytes: Buffer.byteLength(s), status: 200, finalUrl: 'https://mirror.example/index.json' });

/* ------------------------------- 判据 ------------------------------- */

describe('市场装卸（真内核）', () => {
  it('装配：插件 active、服务在位、落点 = <appData>/market 且它被登记为常驻可写根', async () => {
    const h = await boot();
    expect(h.kernel.plugins.list().find((p) => p.id === 'kojo-market')?.status).toBe('active');
    expect(await h.service.rootDir()).toBe(h.market);
    expect(await h.io.exists(h.market)).toBe(true);
    expect(h.io.isWritable(h.market)).toBe(true);
    expect(h.io.isWritable(join(h.market, 'packs', 'kojo-pack', 'x', '1.0.0', 'files', 'a.erb'))).toBe(true);
    // 市场没把写允许域开大：appData 本身与它的其它子目录照样越权
    expect(h.io.isWritable(join(h.appData, 'elsewhere'))).toBe(false);
    expect(h.io.isWritable(h.appData)).toBe(false);
    await expect(h.io.writeBytes(join(h.appData, 'elsewhere', 'x.bin'), new Uint8Array(1))).rejects.toBeInstanceOf(
      WriteNotAllowedError,
    );
    // 路径原语也在同一张面上，且 rename **两端都断言**
    await expect(h.io.rename(join(h.appData, 'elsewhere', 'a'), join(h.market, 'b'))).rejects.toBeInstanceOf(
      WriteNotAllowedError,
    );
    await expect(h.io.rename(join(h.market, 'a'), join(h.appData, 'elsewhere', 'b'))).rejects.toBeInstanceOf(
      WriteNotAllowedError,
    );
    await expect(h.io.removeDir(join(h.appData, 'elsewhere'))).rejects.toBeInstanceOf(WriteNotAllowedError);
  });

  it('装成功：落点逐字节 = 原包（Shift-JIS + BOM + 二进制样本，证明没转码）', async () => {
    const h = await boot();
    const sjis = new Uint8Array(iconv.encode('口上テスト\r\n', 'shift_jis'));
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x31, 0x0d, 0x0a]);
    const bin = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x41]);
    const tree = { 'a.txt': sjis, 'b.txt': bom, 'sub/dir/c.bin': bin };
    const src = sourceDir(tree, manifestOf(await entriesOf(tree), { id: 'sjis.pack' }));

    const rec = await h.service.installLocalDir(src);
    expect(rec).toMatchObject({
      kind: 'kojo-pack',
      id: 'sjis.pack',
      version: '1.0.0',
      name: '演示包',
      installedAt: INSTALLED_AT,
    });
    // 逐文件锚折叠摘要恒有；**本地目录源没有容器** ⇒ containerSha256 缺省（一词不再两义）
    expect(rec.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.containerSha256).toBeUndefined();
    // 落点是派生值（契约 A3）：记录里不许存 dir
    expect(Object.keys(rec)).not.toContain('dir');
    expect(await h.io.exists(await h.service.installDir('kojo-pack', 'sjis.pack', '1.0.0'))).toBe(true);
    const content = await h.service.contentDir('kojo-pack', 'sjis.pack', '1.0.0');
    expect(content).toBe(join(h.market, 'packs', 'kojo-pack', 'sjis.pack', '1.0.0', 'files'));

    for (const [relPath, bytes] of Object.entries(tree)) {
      const at = nodeJoin(content, ...relPath.split('/'));
      expect(readFileSync(at).equals(Buffer.from(bytes)), relPath).toBe(true);
    }
    // 首三字节仍是 BOM、CR 仍在——走 readText/writeText 链路就会被抹平
    expect([...readFileSync(nodeJoin(content, 'b.txt')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(readFileSync(nodeJoin(content, 'a.txt')).includes(0x0d)).toBe(true);
    expect([...readFileSync(nodeJoin(content, 'sub', 'dir', 'c.bin'))]).toEqual([0x00, 0xff, 0x7f, 0x80, 0x41]);

    const list = await h.service.installed();
    expect(list).toHaveLength(1);
    expect(list[0]!.files).toHaveLength(3);
    expect(await h.service.isInstalled('kojo-pack', 'sjis.pack', '1.0.0')).toBe(true);
    expect(await h.service.isInstalled('kojo-pack', 'sjis.pack', '9.9.9')).toBe(false);
    // 状态住 ctx.storage（插件域），不在 market 根里自造 state.json
    expect(await h.kernel.storage.scope('kojo-market').keys()).toEqual(['installed']);
    // 记账里只有身份与摘要，**没有路径**（路径 = installDir 派生；两份真相会指空）
    const stored = await h.kernel.storage.scope('kojo-market').get<Record<string, unknown>[]>('installed');
    expect(Object.keys(stored![0]!).sort()).toEqual(
      ['author', 'contentDigest', 'files', 'id', 'installedAt', 'kind', 'license', 'name', 'version'].sort(),
    );
    expect((await h.bridge.listDir(h.market)).map((e) => e.name).sort()).toEqual(['.staging', 'packs']);
    // 暂存壳随 rename 搬空
    expect(await h.bridge.listDir(nodeJoin(h.market, '.staging'))).toEqual([]);
  });

  it('每一次写盘都只落在 market 根内（源目录在根外 ⇒ 读不受限、写必受限）', async () => {
    const h = await boot();
    const writes = vi.spyOn(h.io, 'writeBytes');
    const dirs = vi.spyOn(h.io, 'ensureDir');
    const { manifest, tree } = await samplePack('trace.pack');
    await h.service.installLocalDir(sourceDir(tree, manifest));
    expect(writes.mock.calls.length).toBeGreaterThan(0);
    for (const [p] of writes.mock.calls) expect(p.startsWith(h.market)).toBe(true);
    for (const [p] of dirs.mock.calls) expect(p.startsWith(h.market)).toBe(true);
  });

  it('负自证五条 + 形状闸：全拒、且 packs/ 与 .staging/ 一个字节都不留', async () => {
    const h = await boot();
    const good = new Uint8Array([1, 2, 3]);
    const oneEntry = await entriesOf({ 'ok.erb': good });
    type Case = { title: string; id: string; code: string; tree: Record<string, Uint8Array>; manifest: PackManifest };
    const cases: Case[] = [
      {
        title: '../ 穿越',
        id: 'dot.pack',
        code: 'path-dotdot',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'files/../../escape.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'dot.pack' }),
      },
      {
        title: '绝对路径',
        id: 'abs.pack',
        code: 'path-absolute',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: '/etc/escape.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'abs.pack' }),
      },
      {
        title: 'sha256 不符',
        id: 'hash.pack',
        code: 'entry-sha256',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'files/ok.erb', bytes: 3, sha256: 'f'.repeat(64) }], { id: 'hash.pack' }),
      },
      {
        title: 'redistribute:false',
        id: 'nc.pack',
        code: 'redistribute-denied',
        tree: { 'ok.erb': good },
        manifest: manifestOf(oneEntry, { id: 'nc.pack', redistribute: false }),
      },
      {
        title: '超条目数',
        id: 'many.pack',
        code: 'entries-limit',
        tree: {},
        manifest: manifestOf(
          Array.from({ length: MARKET_MAX_FILE_ENTRIES + 1 }, (_, i) => ({
            path: `files/f${i}.erb`,
            bytes: 1,
            sha256: '0'.repeat(64),
          })),
          { id: 'many.pack' },
        ),
      },
      {
        title: '反斜杠路径',
        id: 'bs.pack',
        code: 'path-backslash',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'files\\sub\\escape.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'bs.pack' }),
      },
      {
        title: '盘符路径',
        id: 'drv.pack',
        code: 'path-drive',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'C:/files/escape.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'drv.pack' }),
      },
      {
        title: '空段路径',
        id: 'emp.pack',
        code: 'path-empty-segment',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'files//escape.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'emp.pack' }),
      },
      {
        title: '缺 files/ 前缀',
        id: 'pre.pack',
        code: 'path-prefix',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'escape.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'pre.pack' }),
      },
      {
        title: '路径深度超限',
        id: 'deep.pack',
        code: 'path-depth',
        tree: { 'ok.erb': good },
        manifest: manifestOf(
          [{ path: `files/${Array.from({ length: 12 }, (_, i) => `d${i}`).join('/')}/x.erb`, bytes: 3, sha256: await sha256Hex(good) }],
          { id: 'deep.pack' },
        ),
      },
      {
        title: '重名条目',
        id: 'dup2.pack',
        code: 'entry-duplicate',
        tree: { 'ok.erb': good },
        manifest: manifestOf([...oneEntry, ...oneEntry], { id: 'dup2.pack' }),
      },
      {
        title: '声明字节数与实读不符',
        id: 'bytes.pack',
        code: 'entry-bytes',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'files/ok.erb', bytes: 4, sha256: await sha256Hex(good) }], { id: 'bytes.pack' }),
      },
      {
        title: '超总字节（128 MiB）',
        id: 'big.pack',
        code: 'bytes-limit',
        tree: { 'ok.erb': good },
        manifest: manifestOf(
          [{ path: 'files/ok.erb', bytes: MARKET_MAX_FILE_ENTRIES * 30000, sha256: await sha256Hex(good) }],
          { id: 'big.pack' },
        ),
      },
      {
        title: '清单声明的文件在源里不存在',
        id: 'ghost.pack',
        code: 'source-unreadable',
        tree: { 'ok.erb': good },
        manifest: manifestOf([{ path: 'files/ghost.erb', bytes: 3, sha256: await sha256Hex(good) }], { id: 'ghost.pack' }),
      },
      {
        title: 'minAppVersion 高于当前',
        id: 'new.pack',
        code: 'app-version-too-low',
        tree: { 'ok.erb': good },
        manifest: manifestOf(oneEntry, { id: 'new.pack', minAppVersion: '9.9.9' }),
      },
      {
        title: 'schema ≠ 1',
        id: 'sch.pack',
        code: 'schema-version',
        tree: { 'ok.erb': good },
        manifest: { ...manifestOf(oneEntry, { id: 'sch.pack' }), schema: 2 as unknown as 1 },
      },
      {
        title: 'kind 不在三值内',
        id: 'kin.pack',
        code: 'kind-unknown',
        tree: { 'ok.erb': good },
        manifest: manifestOf(oneEntry, { id: 'kin.pack', kind: 'mystery-pack' as never }),
      },
      {
        title: 'id 不合尺',
        id: 'Bad ID',
        code: 'id-invalid',
        tree: { 'ok.erb': good },
        manifest: manifestOf(oneEntry, { id: 'Bad ID' }),
      },
      {
        title: 'version 不合尺',
        id: 'ver.pack',
        code: 'version-invalid',
        tree: { 'ok.erb': good },
        manifest: manifestOf(oneEntry, { id: 'ver.pack', version: '1.0' }),
      },
      {
        title: '缺 pack.json',
        id: 'nomani.pack',
        code: 'manifest-missing',
        tree: {},
        manifest: manifestOf(oneEntry, { id: 'nomani.pack' }),
      },
      {
        title: '缺 files/ 目录',
        id: 'nodoc.pack',
        code: 'content-missing',
        tree: {},
        manifest: manifestOf(oneEntry, { id: 'nodoc.pack' }),
      },
    ];

    for (const c of cases) {
      const src = sourceDir(c.tree, c.manifest);
      if (c.code === 'manifest-missing') rmSync(nodeJoin(src, 'pack.json'));
      const err = await h.service.installLocalDir(src).then(() => null).catch((e: unknown) => e);
      expect(err, c.title).toBeInstanceOf(MarketError);
      expect((err as MarketError).code, c.title).toBe(c.code);
      expect((err as Error).message.length, `${c.title}：原因要说人话`).toBeGreaterThan(12);
      expect(existsSync(nodeJoin(h.market, 'packs', 'kojo-pack', c.id)), c.title).toBe(false);
    }
    expect(await h.service.installed()).toEqual([]);
    // 全批没有一个字节写进 packs（拒在校验层，不是写完再回滚）
    expect(await h.io.exists(join(h.market, 'packs'))).toBe(false);
    expect(await h.bridge.listDir(nodeJoin(h.market, '.staging'))).toEqual([]);
  });

  it('同版本重装 = 覆盖（口径：后装赢，旧的整份替换；清单只一条、暂存不留回滚壳）', async () => {
    const h = await boot();
    const v1 = { 'a.erb': new Uint8Array([1, 1, 1]) };
    const v2 = { 'a.erb': new Uint8Array([2, 2, 2, 2]), 'added.erb': new Uint8Array([7]) };
    const first = await h.service.installLocalDir(sourceDir(v1, manifestOf(await entriesOf(v1), { id: 'dup.pack' })));
    const second = await h.service.installLocalDir(sourceDir(v2, manifestOf(await entriesOf(v2), { id: 'dup.pack' })));

    const dir = await h.service.installDir('kojo-pack', 'dup.pack', '1.0.0');
    expect([...readFileSync(nodeJoin(dir, 'files', 'a.erb'))]).toEqual([2, 2, 2, 2]);
    expect([...readFileSync(nodeJoin(dir, 'files', 'added.erb'))]).toEqual([7]);
    expect(second.files).toHaveLength(2);
    expect(second.contentDigest).not.toBe(first.contentDigest);
    const list = await h.service.installed();
    expect(list.filter((r) => r.id === 'dup.pack')).toHaveLength(1);
    expect(list[0]!.files).toHaveLength(2);
    // 落点里只剩当前这份，暂存区里没有 .__previous__ 壳
    expect((await h.bridge.listDir(nodeJoin(dir, 'files'))).map((e) => e.name).sort()).toEqual(['a.erb', 'added.erb']);
    expect(await h.bridge.listDir(nodeJoin(h.market, '.staging'))).toEqual([]);
  });

  it('卸载：目录清空、installed() 为空、重复卸载报 installed-missing', async () => {
    const h = await boot();
    const { manifest, tree } = await samplePack('off.pack');
    await h.service.installLocalDir(sourceDir(tree, manifest));
    const dir = await h.service.installDir('kojo-pack', 'off.pack', '1.0.0');
    expect(existsSync(dir)).toBe(true);

    await h.service.uninstall('kojo-pack', 'off.pack', '1.0.0');
    expect(existsSync(dir)).toBe(false);
    expect(await h.service.installed()).toEqual([]);
    expect(await h.service.isInstalled('kojo-pack', 'off.pack', '1.0.0')).toBe(false);
    // 空壳父目录逐级收掉，packs 根保留
    expect(existsSync(nodeJoin(h.market, 'packs', 'kojo-pack', 'off.pack'))).toBe(false);

    const err = await h.service.uninstall('kojo-pack', 'off.pack', '1.0.0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketError);
    expect((err as MarketError).code).toBe('installed-missing');
  });

  it('index() 判别联 · absent：本机没拉过 ⇒ 一句人话，不是 null（null 会把"没有"与"读不出"混成一态）', async () => {
    const h = await boot();
    expect(await h.service.index()).toEqual({ state: 'absent' });
    expect(h.warns.some((w) => /不在位/.test(w))).toBe(true);
  });

  it('index() 判别联 · invalid：坏 JSON ⇒ reason + detail，且**不猜**出一份空列表', async () => {
    const h = await boot();
    mkdirSync(h.market, { recursive: true });
    writeFileSync(nodeJoin(h.market, 'index.json'), '{坏 JSON', 'utf8');
    h.warns.length = 0;
    const got = await h.service.index();
    expect(got.state).toBe('invalid');
    if (got.state !== 'invalid') throw new Error('判别联走错分支');
    expect(got.reason.length).toBeGreaterThan(8);
    expect(got.detail, 'detail 要给机器能用的原文错').toContain('JSON');
    expect(h.warns.length).toBeGreaterThan(0);
  });

  it('index() 判别联 · invalid：schema / generatedAt / packs 三项任一不合格都算读不出', async () => {
    const h = await boot();
    mkdirSync(h.market, { recursive: true });
    for (const bad of [
      { schema: 2, generatedAt: '2026-10-15T00:00:00Z', packs: [] },
      { schema: 1, generatedAt: 42, packs: [] },
      { schema: 1, generatedAt: '2026-10-15T00:00:00Z', packs: {} },
      [{ schema: 1, generatedAt: '2026-10-15T00:00:00Z', packs: [] }],
    ]) {
      writeFileSync(nodeJoin(h.market, 'index.json'), JSON.stringify(bad), 'utf8');
      const got = await h.service.index();
      expect(got.state, JSON.stringify(bad).slice(0, 40)).toBe('invalid');
    }
  });

  it('index() 判别联 · ok：坏条目进 dropped 并出声（铁律 4），好条目照常呈现', async () => {
    const h = await boot();
    mkdirSync(h.market, { recursive: true });
    writeFileSync(
      nodeJoin(h.market, 'index.json'),
      JSON.stringify({
        schema: 1,
        generatedAt: '2026-10-15T00:00:00Z',
        packs: [indexEntry('ok.pack'), { kind: 'kojo-pack', id: 'BAD ID', version: '1.0.0', name: 'n', author: 'a', license: 'L', minAppVersion: '0.4.0' }],
      }),
      'utf8',
    );
    h.warns.length = 0;
    const got = await h.service.index();
    if (got.state !== 'ok') throw new Error(`应判 ok，实际 ${JSON.stringify(got)}`);
    expect(got.index.schema).toBe(1);
    expect(got.index.packs.map((p) => p.id)).toEqual(['ok.pack']);
    expect(got.dropped).toHaveLength(1);
    expect(got.dropped[0]).toContain('BAD ID');
    expect(got.dropped[0]).toContain('id 不合规');
    expect(got.fetchedAt, '手工放的列表没有拉取时刻').toBeNull();
    // dropped 非空 ⇒ 必须出声（不能只在返回值里带个数就完事）
    expect(h.warns.some((w) => /丢掉了 1 条/.test(w) && w.includes('BAD ID')), 'dropped 没出声').toBe(true);
  });

  it('index() · ok 且一条没丢 ⇒ dropped 是空数组、不发"丢掉"那句', async () => {
    const h = await boot();
    mkdirSync(h.market, { recursive: true });
    writeFileSync(
      nodeJoin(h.market, 'index.json'),
      JSON.stringify({ schema: 1, generatedAt: '2026-10-15T00:00:00Z', packs: [indexEntry('clean.pack')] }),
      'utf8',
    );
    h.warns.length = 0;
    const got = await h.service.index();
    if (got.state !== 'ok') throw new Error(`应判 ok，实际 ${JSON.stringify(got)}`);
    expect(got.dropped).toEqual([]);
    expect(h.warns.filter((w) => /丢掉了/.test(w))).toEqual([]);
  });


  it('同 id 异 kind（契约 A4）：装第二个种类 ⇒ 拒 + 出声，一个字节都不落', async () => {
    const h = await boot();
    const { manifest, tree } = await samplePack('clash.pack');
    await h.service.installLocalDir(sourceDir(tree, manifest));
    h.warns.length = 0;

    const err = await h.service
      .installLocalDir(sourceDir(tree, manifestOf(await entriesOf(tree), { id: 'clash.pack', kind: 'dict-pack' })))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketError);
    expect((err as MarketError).code).toBe('id-kind-conflict');
    expect(h.warns.some((w) => /id-kind-conflict/.test(w)), '拒并出声').toBe(true);
    // 拒在校验层：dict-pack 那一支连目录都不该出现
    expect(await h.service.isInstalled('dict-pack', 'clash.pack', '1.0.0')).toBe(false);
    expect(await h.io.exists(join(h.market, 'packs', 'dict-pack'))).toBe(false);
    // 同 id 同 kind 重装仍然合法（覆盖，不是冲突）
    await expect(h.service.installLocalDir(sourceDir(tree, manifest))).resolves.toBeTruthy();
  });

  it('索引内同 id 异 kind ⇒ 两条一起进 dropped（不许静默取一条）+ 出声', async () => {
    const h = await boot();
    mkdirSync(h.market, { recursive: true });
    writeFileSync(
      nodeJoin(h.market, 'index.json'),
      indexJson([
        indexEntry('dual.pack'),
        indexEntry('dual.pack', { kind: 'dict-pack', zip: { url: 'https://example.test/d.zip', sha256: 'b'.repeat(64), bytes: 10 } }),
        indexEntry('solo.pack'),
      ]),
      'utf8',
    );
    h.warns.length = 0;
    const got = await h.service.index();
    if (got.state !== 'ok') throw new Error(`应判 ok，实际 ${JSON.stringify(got)}`);
    expect(got.index.packs.map((p) => p.id)).toEqual(['solo.pack']);
    expect(got.dropped).toHaveLength(2);
    expect(got.dropped.every((d) => d.startsWith('dual.pack'))).toBe(true);
    expect(h.warns.some((w) => /id-kind-conflict/.test(w) && /dual\.pack/.test(w))).toBe(true);
    expect(h.warns.some((w) => /丢掉了 2 条/.test(w))).toBe(true);
    // 冲突条目连"装"这条路也堵着：装同 id 的第三种 kind ⇒ 拒（查重面 = 索引原样 + 已装集）
    const { manifest, tree } = await samplePack('dual.pack');
    const err = await h.service
      .installLocalDir(sourceDir(tree, manifestOf(await entriesOf(tree), { id: 'dual.pack', kind: 'template-pack' })))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketError);
    expect((err as MarketError).code).toBe('id-kind-conflict');
  });

  it('已装目录被外部删掉 ⇒ installed() 剔除并出声；清单条目被改坏 ⇒ 忽略不崩', async () => {
    const h = await boot();
    const { manifest, tree } = await samplePack('lost.pack');
    await h.service.installLocalDir(sourceDir(tree, manifest));
    const dir = await h.service.installDir('kojo-pack', 'lost.pack', '1.0.0');
    rmSync(dir, { recursive: true, force: true });
    h.warns.length = 0;
    const list: InstalledPack[] = await h.service.installed();
    expect(list).toEqual([]);
    expect(h.warns.some((w) => /不在位/.test(w))).toBe(true);
    expect(await h.service.isInstalled('kojo-pack', 'lost.pack', '1.0.0')).toBe(false);

    // 存储域被外部改坏（条形状不成）⇒ 忽略 + 出声，不崩、不假装已装
    await h.kernel.storage.scope('kojo-market').set('installed', [{ 乱写: true }, null]);
    h.warns.length = 0;
    expect(await h.service.installed()).toEqual([]);
    expect(h.warns.some((w) => /形如破坏/.test(w))).toBe(true);
  });

  it('非法 appVersion 注入 ⇒ 拒绝装配（版本号不许硬写进插件源码）', () => {
    expect(() => createKojoMarketPlugin({ appVersion: '乱写' })).toThrow(/appVersion/);
    expect(() => createKojoMarketPlugin(undefined as unknown as { appVersion: string })).toThrow(/appVersion/);
    expect(() => createKojoMarketPlugin({ appVersion: APP_VERSION })).not.toThrow();
  });
});

/* ============================ 索引刷新（KM-8） ============================
 * 判别联的**第三条腿**在这里长出来：`index()` 只读盘，`refreshIndex()` 才出网。
 * 出网一律走 `kernel.remote`（= 桥的透传），本桥没有远程能力 ⇒ 必须落在 `failed`，
 * 且**盘上一个字节都不许多**（失败的刷新不许把好用的旧列表换成坏文件）。
 */

describe('索引刷新与远程面单一入口（真内核 + 真桥）', () => {
  it('远程面只有一条路：kernel.remote 在位且透传到桥；kernel.io 面上没有远程方法', async () => {
    const h = await boot();
    const remote = h.kernel.services.get<RemoteService>(KernelServices.Remote);
    const seen: string[] = [];
    h.bridge.fetchText = async (url: string): Promise<RemoteText> => {
      seen.push(url);
      return { text: 'ok', bytes: 2, status: 200, finalUrl: url };
    };
    const got = await remote.fetchText('https://demo.github.io/index.json');
    expect(got.text).toBe('ok');
    expect(seen, '服务没把调用透传给桥').toEqual(['https://demo.github.io/index.json']);
    // **FileIO 上没有第二个远程入口**（有的话就是两份真相：两处各自演化白名单与限额）
    const ioAsRecord = h.kernel.io as unknown as Record<string, unknown>;
    for (const name of ['fetchText', 'fetchRemote', 'download', 'fetchDirectory']) {
      expect(ioAsRecord[name], `kernel.io 混进了远程方法 ${name}`).toBeUndefined();
    }
  });

  it('桥没有远程能力（Node 桥口径）⇒ failed + 一句人话，且不产生 index.json', async () => {
    const h = await boot();
    h.warns.length = 0;
    const r = await h.service.refreshIndex();
    expect(r.state).toBe('failed');
    if (r.state !== 'failed') throw new Error('不该判成成功');
    expect(r.reason).toContain('从注册表拉列表没有成功');
    expect(r.reason.length).toBeGreaterThan(20);
    expect(r.detail).toBe(MARKET_DEFAULT_INDEX_URL);
    expect(await h.io.exists(join(h.market, 'index.json'))).toBe(false);
    expect(h.warns.some((w) => /拉列表没有成功|拉取/.test(w))).toBe(true);
    // 失败后读盘仍是 absent（不是"读不出"，更不是空列表）
    expect(await h.service.index()).toEqual({ state: 'absent' });
  });

  it('刷新成功 ⇒ 原文镜像落盘 + 记数据时间 + 限额取契约常量', async () => {
    const h = await boot();
    const body = indexJson([indexEntry('a.pack'), indexEntry('b.pack', { kind: 'dict-pack' })]);
    const calls = stubRemote(h, async () => text(body));
    const r = await h.service.refreshIndex();
    expect(r.state).toBe('refreshed');
    if (r.state !== 'refreshed') throw new Error('不该判成失败');
    expect(r.fetchedAt).toBe(INSTALLED_AT);
    expect(calls.urls).toEqual([MARKET_DEFAULT_INDEX_URL]);
    expect(calls.opts[0]).toEqual({ timeoutMs: MARKET_INDEX_TIMEOUT_MS, maxBytes: MARKET_MAX_INDEX_BYTES });
    // **原文镜像**：一字不改（洗掉坏条目 = 把注册表的问题藏起来）
    expect(readFileSync(nodeJoin(h.market, 'index.json'), 'utf8')).toBe(body);
    expect(r.index.state).toBe('ok');
    if (r.index.state !== 'ok') throw new Error('落盘后应可读');
    expect(r.index.index.packs).toHaveLength(2);
    expect(r.index.fetchedAt).toBe(INSTALLED_AT);
    expect(await h.kernel.storage.scope('kojo-market').keys()).toEqual(['indexFetchedAt']);
  });

  it('坏条目留在盘上、每次读都重新报进 dropped（刷新时不悄悄洗掉）', async () => {
    const h = await boot();
    const body = indexJson([indexEntry('good.pack'), { kind: 'kojo-pack', id: 'BAD', version: '1.0' }]);
    stubRemote(h, async () => text(body));
    expect((await h.service.refreshIndex()).state).toBe('refreshed');
    expect(readFileSync(nodeJoin(h.market, 'index.json'), 'utf8')).toBe(body);
    const got = await h.service.index();
    if (got.state !== 'ok') throw new Error(`应判 ok，实际 ${JSON.stringify(got)}`);
    expect(got.dropped).toHaveLength(1);
    expect(got.dropped[0]).toContain('BAD');
    expect(got.index.packs.map((p) => p.id)).toEqual(['good.pack']);
  });

  it('TTL 窗口内不回源 ⇒ cached；force=true 硬回源（拉取次数是唯一的差别）', async () => {
    const h = await boot();
    const body = indexJson([indexEntry('a.pack')]);
    const calls = stubRemote(h, async () => text(body));
    const first = await h.service.refreshIndex();
    expect(first.state).toBe('refreshed');
    const second = await h.service.refreshIndex();
    expect(second.state).toBe('cached');
    if (second.state !== 'cached') throw new Error('TTL 内不该回源');
    expect(second.fetchedAt).toBe(INSTALLED_AT);
    expect(calls.urls).toHaveLength(1);
    expect(second.index.state).toBe('ok');
    const forced = await h.service.refreshIndex({ force: true });
    expect(forced.state).toBe('refreshed');
    expect(calls.urls).toHaveLength(2);
  });

  it('远程回来的不是 JSON ⇒ failed，盘上旧列表原样不动（好列表不被坏文件换掉）', async () => {
    const h = await boot();
    stubRemote(h, async () => text(indexJson([indexEntry('keep.pack')])));
    await h.service.refreshIndex({ force: true });
    const before = readFileSync(nodeJoin(h.market, 'index.json'), 'utf8');
    stubRemote(h, async () => text('{坏 JSON'));
    h.warns.length = 0;
    const r = await h.service.refreshIndex({ force: true });
    expect(r.state).toBe('failed');
    if (r.state !== 'failed') throw new Error('坏 JSON 不该算刷新成功');
    expect(r.reason).toContain('不是合法 JSON');
    expect(readFileSync(nodeJoin(h.market, 'index.json'), 'utf8')).toBe(before);
    // 失败结果**自带**盘上那份可用状态（面板因此不必自己摸盘）
    expect(r.index.state).toBe('ok');
    expect(h.warns.length).toBeGreaterThan(0);
  });

  it('远程回来的形状不受支持 ⇒ failed，旧列表与数据时间都不动', async () => {
    const h = await boot();
    stubRemote(h, async () => text(indexJson([indexEntry('keep.pack')])));
    await h.service.refreshIndex({ force: true });
    stubRemote(h, async () => text(JSON.stringify({ schema: 2, generatedAt: 'x', packs: [] })));
    const r = await h.service.refreshIndex({ force: true });
    expect(r.state).toBe('failed');
    if (r.state !== 'failed') throw new Error('schema 不符不该算成功');
    expect(r.reason).toContain('形状不受支持');
    expect(readFileSync(nodeJoin(h.market, 'index.json'), 'utf8')).toBe(indexJson([indexEntry('keep.pack')]));
    expect(await h.kernel.storage.scope('kojo-market').get<number>('indexFetchedAt')).toBe(INSTALLED_AT);
  });

  it('端点覆盖：出网用覆盖值；非法形态当场拒（不联网）；空串 = 回默认', async () => {
    const h = await boot();
    const mirror = 'https://mirror.example.test/kojo/index.json';
    const calls = stubRemote(h, async () => text(indexJson([])));
    await h.service.setEndpoint(mirror);
    expect(await h.service.endpoint()).toBe(mirror);
    const r = await h.service.refreshIndex({ force: true });
    expect(r.state).toBe('refreshed');
    expect(calls.urls).toEqual([mirror]);

    for (const bad of ['不是 URL', 'http://mirror.example/i.json', 'https://user:pw@mirror.example/i.json']) {
      const err = await h.service.setEndpoint(bad).then(() => null).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(MarketError);
      expect((err as MarketError).code, bad).toBe('endpoint-invalid');
    }
    // 覆盖值被人手改成非法 ⇒ 刷新拒在出网之前（桥一次都不该被叫）
    await h.kernel.storage.scope('kojo-market').set('indexEndpoint', 'http://明文.example/i.json');
    h.warns.length = 0;
    const failed = await h.service.refreshIndex({ force: true });
    expect(failed.state).toBe('failed');
    if (failed.state !== 'failed') throw new Error('非法端点不该出网');
    expect(failed.reason).toContain('注册表地址不合法');
    expect(calls.urls, '非法端点仍然出了网').toEqual([mirror]);

    await h.service.setEndpoint('   ');
    expect(await h.service.endpoint()).toBe(MARKET_DEFAULT_INDEX_URL);
  });
});
