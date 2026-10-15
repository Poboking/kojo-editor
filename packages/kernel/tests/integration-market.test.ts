import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import iconv from 'iconv-lite';
import {
  MARKET_MAX_FILE_ENTRIES,
  MARKET_SERVICE_KEY,
  WriteNotAllowedError,
  join,
  type InstalledPack,
  type Logger,
  type MarketService,
  type PackFileEntry,
  type PackManifest,
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

  it('index()：缺文件 → null 且出声（铁律 4）；坏 JSON 与坏条目各自出声', async () => {
    const h = await boot();
    expect(await h.service.index()).toBeNull();
    expect(h.warns.some((w) => /索引/.test(w))).toBe(true);

    mkdirSync(h.market, { recursive: true });
    writeFileSync(
      nodeJoin(h.market, 'index.json'),
      JSON.stringify({
        schema: 1,
        generatedAt: '2026-10-15T00:00:00Z',
        packs: [
          {
            kind: 'kojo-pack',
            id: 'ok.pack',
            version: '1.0.0',
            name: 'n',
            author: 'a',
            license: 'L',
            minAppVersion: '0.4.0',
            zip: { url: 'https://example.test/ok.zip', sha256: 'a'.repeat(64), bytes: 10 },
            fileCount: 1,
            unpackedBytes: 10,
          },
          { kind: 'kojo-pack', id: 'BAD ID', version: '1.0.0', name: 'n', author: 'a', license: 'L', minAppVersion: '0.4.0' },
        ],
      }),
      'utf8',
    );
    const got = await h.service.index();
    expect(got?.schema).toBe(1);
    expect(got?.packs.map((p) => p.id)).toEqual(['ok.pack']);
    expect(h.warns.some((w) => /丢掉了 1 条/.test(w))).toBe(true);

    writeFileSync(nodeJoin(h.market, 'index.json'), '{坏 JSON', 'utf8');
    h.warns.length = 0;
    expect(await h.service.index()).toBeNull();
    expect(h.warns.length).toBeGreaterThan(0);
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

  it('索引内同 id 异 kind ⇒ 两条一起不呈现（不许静默取一条）+ 出声', async () => {
    const h = await boot();
    mkdirSync(h.market, { recursive: true });
    const entry = (kind: string): Record<string, unknown> => ({
      kind,
      id: 'dual.pack',
      version: '1.0.0',
      name: 'n',
      author: 'a',
      license: 'L',
      minAppVersion: '0.4.0',
      zip: { url: `https://example.test/${kind}.zip`, sha256: 'a'.repeat(64), bytes: 10 },
      fileCount: 1,
      unpackedBytes: 10,
    });
    writeFileSync(
      nodeJoin(h.market, 'index.json'),
      JSON.stringify({
        schema: 1,
        generatedAt: '2026-10-15T00:00:00Z',
        packs: [entry('kojo-pack'), entry('dict-pack'), { ...entry('kojo-pack'), id: 'solo.pack' }],
      }),
      'utf8',
    );
    h.warns.length = 0;
    const got = await h.service.index();
    expect(got?.packs.map((p) => p.id)).toEqual(['solo.pack']);
    expect(h.warns.some((w) => /id-kind-conflict/.test(w) && /dual\.pack/.test(w))).toBe(true);
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
