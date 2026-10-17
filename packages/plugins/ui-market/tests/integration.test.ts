import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MARKET_CONTENT_DIR,
  MARKET_INDEX_FILE,
  MARKET_MANIFEST_FILE,
  MARKET_PACKS_DIR,
  MARKET_SCHEMA_VERSION,
  MARKET_SERVICE_KEY,
  MARKET_STAGING_DIR,
  join,
  packContainerName,
  packUnpackedName,
  type DirEntry,
  type EventBus,
  type FileIO,
  type InstalledPack,
  type Logger,
  type MarketIndexEntry,
  type MarketService,
  type PluginContext,
  type RemoteDownload,
  type RemoteExtractResult,
  type RemoteService,
  type RemoteText,
  type ScopedStorage,
  type TextFile,
  type UIPanelContribution,
} from '@kojo/plugin-api';
// 测试面（audit C 对测试豁免）：拿**真**市场服务实现跑面板的取数/装卸判据，
// 这样"卸完了列表与磁盘同时为空"、"装完落点与记账同时到位"钉的是实现，不是自造的假盘。
import { createMarketService, sha256Hex } from '@kojo/plugin-kojo-market';
import { createUiMarketPlugin } from '../src/index';
import { MarketPanelView } from '../src/market-panel-view';
import {
  loadMarketSnapshot,
  pullMarketOutcome,
  requestPublish,
  runImport,
  runInstall,
  runUninstall,
  type MarketActionDeps,
  type MarketSnapshot,
} from '../src/actions';
import { buildGroups, PUBLISH_LABEL, REJECT_TEXT } from '../src/market-view';

const APP_VERSION = '0.4.0-beta.1';
const ROOT = '/appdata/market';
const SOURCE = '/outside/src/demo.pack';

/* ----------------------------- 内存 FS（真实现的地基） ----------------------------- */

class MemFS {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['/appdata', '/outside', ROOT, SOURCE]);

  private parent(p: string): string {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  mkdir(p: string): void {
    let cur = p;
    while (cur.length > 1 && !this.dirs.has(cur)) {
      this.dirs.add(cur);
      cur = this.parent(cur);
    }
  }

  write(p: string, data: Uint8Array): void {
    this.mkdir(this.parent(p));
    this.files.set(p, data);
  }

  exists(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }

  children(p: string): DirEntry[] {
    const prefix = p.endsWith('/') ? p : `${p}/`;
    const out: DirEntry[] = [];
    const seen = new Set<string>();
    for (const key of [...this.files.keys()]) {
      if (!key.startsWith(prefix)) continue;
      out.push({ name: key.slice(prefix.length), path: key, isDirectory: false });
    }
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const name = d.slice(prefix.length);
      if (name.length === 0 || name.includes('/') || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, path: d, isDirectory: true });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  removeTree(p: string): void {
    const prefix = `${p}/`;
    this.dirs.delete(p);
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.dirs.delete(d);
  }

  move(from: string, to: string): void {
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      return;
    }
    const prefix = `${from}/`;
    const moved: Array<[string, Uint8Array]> = [];
    for (const [k, v] of this.files) if (k.startsWith(prefix)) moved.push([`${to}${k.slice(from.length)}`, v]);
    const dirs = [...this.dirs].filter((d) => d === from || d.startsWith(prefix));
    if (dirs.length === 0 && moved.length === 0) throw new Error(`rename: ${from} 不存在`);
    for (const d of dirs) this.mkdir(to + d.slice(from.length));
    for (const [k, v] of moved) this.write(k, v);
    this.removeTree(from);
  }
}

interface CountingIo {
  io: FileIO;
  fs: MemFS;
  calls: string[];
  breakExists(on: boolean): void;
}

function makeIo(): CountingIo {
  const fs = new MemFS();
  let broken = false;
  const calls: string[] = [];
  const utf8 = new TextDecoder();
  const io: FileIO = {
    appDataDir: async () => '/appdata',
    async readText(p): Promise<TextFile> {
      const b = fs.files.get(p);
      if (b === undefined) throw new Error(`not found: ${p}`);
      return { path: p, text: utf8.decode(b), encoding: 'utf-8', eol: 'lf', mtimeMs: 1 };
    },
    async readTexts(paths) {
      // 装卸链路只逐条按清单读写；批量读不走这条线，走到即红
      throw new Error(`面板/市场不该走批量读：${paths.length} 条`);
    },
    async readBytes(p) {
      const b = fs.files.get(p);
      if (b === undefined) throw new Error(`not found: ${p}`);
      return b;
    },
    async readBytesMany(paths) {
      // 装包搬运的批量读（2026-10-16 市场与导入 IO 批）：一批一条命令、逐文件失败位 null
      calls.push(`readBytesMany:${paths.length}`);
      return paths.map((p) => fs.files.get(p) ?? null);
    },
    async writeText(p, text) {
      // 装卸链路一律字节级（契约纪律）；这里只为凑齐 FileIO 的面，走到即红
      throw new Error(`面板/市场不该走文本写盘：${p}（${text.length} 字）`);
    },
    async writeBytes(p, data) {
      calls.push(`writeBytes:${p}`);
      fs.write(p, data);
    },
    async ensureDir(p) {
      calls.push(`ensureDir:${p}`);
      fs.mkdir(p);
    },
    async listDir(p) {
      return fs.children(p);
    },
    async walkDir(p) {
      // 装卸链路只逐条按清单读写，不走目录遍历
      return fs.children(p);
    },
    async exists(p) {
      if (broken && p === join(ROOT, 'index.json')) throw new Error('EIO: 目录读不动');
      return fs.exists(p);
    },
    // 批量 stat（PERF-10b：`installed()` 一趟核完全部落点）：判定与本夹具的 `exists` 同源
    async statFiles(paths) {
      calls.push(`statFiles:${paths.length}`);
      return paths.map((p) => {
        const b = fs.files.get(p);
        if (b !== undefined) return { path: p, exists: true, mtimeMs: 1, size: b.length };
        if (fs.dirs.has(p)) return { path: p, exists: true, mtimeMs: 1, size: 0 };
        return { path: p, exists: false, mtimeMs: null, size: null };
      });
    },
    async stat(p) {
      const b = fs.files.get(p);
      return b === undefined ? null : { size: b.length, mtimeMs: 1, isDirectory: false };
    },
    setWritableRoots: () => undefined,
    setAppWritableRoots: () => undefined,
    addAppWritableRoot: () => undefined,
    async chooseWorkspaceRoot() {
      throw new Error('面板不需要授权入口');
    },
    isWritable: () => true,
    async backup() {
      return null;
    },
    async listBackups() {
      throw new Error('面板/市场不该走备份列表');
    },
    async restoreBackup() {
      throw new Error('面板/市场不该走备份还原');
    },
    async exportFile() {
      return null;
    },
    async rename(from, to) {
      calls.push(`rename:${from}→${to}`);
      fs.move(from, to);
    },
    async copyFile() {
      // 契约 additive（2026-10-16 市场与导入 IO 批）：面板与市场这条线不用服务端复制 ⇒ 走到即红
      throw new Error('面板/市场不该走服务端复制');
    },
    async removeDir(p) {
      calls.push(`removeDir:${p}`);
      fs.removeTree(p);
    },
    // 契约 additive（2026-10-16 文件树编辑批）：市场这条线不用单文件删除 ⇒ 走到即红
    async removeFile() {
      throw new Error('面板/市场不该走单文件删除');
    },
    // 契约 additive（W11 回收站可见批）：卸载走 `removeDir` 一条路，回收站的面板化归文件历史线
    // ⇒ 市场这条线不读、不恢复、不清，四个口一律"走到即红"（不是静默兜空值）
    async listTrash() {
      throw new Error('面板/市场不该读回收站');
    },
    async restoreFromTrash() {
      throw new Error('面板/市场不该从回收站恢复');
    },
    async purgeTrash() {
      throw new Error('面板/市场不该彻底删除回收站条目');
    },
    holdTrash: () => undefined,
  };
  return {
    io,
    fs,
    calls,
    breakExists(on) {
      broken = on;
    },
  };
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

function captureLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  return { log: { ...quietLog, warn: (m: string) => warns.push(String(m)) }, warns };
}

/** 记录发出的事件（导入判据：总线收到的是不是**精确载荷**，以及"不该发就不发"） */
function recordingBus(): { bus: EventBus; emits: Array<{ type: string; payload: unknown }> } {
  const emits: Array<{ type: string; payload: unknown }> = [];
  return {
    emits,
    bus: {
      on: () => () => undefined,
      once: () => () => undefined,
      emit: (type: string, payload: unknown) => {
        emits.push({ type, payload });
      },
    } as unknown as EventBus,
  };
}

/** 动作层依赖的最小构造（装/卸用例不关心总线；导入用例自己给记录版） */
function depsOf(market: MarketService, log: Logger = quietLog): MarketActionDeps {
  return { market, bus: recordingBus().bus, log };
}

/* --------------------------------- 夹具 --------------------------------- */

async function writeSource(fs: MemFS, id = 'demo.pack', kind = 'kojo-pack'): Promise<void> {
  const body = new TextEncoder().encode('口上テスト\r\n');
  fs.write(`${SOURCE}/files/a.ERB`, body);
  const files = [{ path: 'files/a.ERB', bytes: body.length, sha256: await sha256Hex(body) }];
  fs.write(
    `${SOURCE}/pack.json`,
    new TextEncoder().encode(
      JSON.stringify({
        schema: 1,
        kind,
        id,
        version: '1.0.0',
        name: '演示口上包',
        author: '某人',
        license: 'CC-BY-NC 4.0',
        redistribute: true,
        minAppVersion: '0.4.0',
        files,
      }),
    ),
  );
}

/**
 * 面板判据**不需要真出网**（面板也不碰远程：`refreshIndex` 的失败态另由
 * `kernel/tests/integration-market.test.ts` 判），所以这里的远程面替身只会抛。
 */
function refusedRemote(): RemoteService {
  return {
    async fetchText(): Promise<RemoteText> {
      throw new Error('本用例不该出网');
    },
    async marketDownload(): Promise<RemoteDownload> {
      throw new Error('本用例不该下载容器');
    },
    async marketExtract(): Promise<RemoteExtractResult> {
      throw new Error('本用例不该解压容器');
    },
  };
}

function makeService(io: FileIO, log: Logger = quietLog, remote: RemoteService = refusedRemote()): MarketService {
  return createMarketService({
    io,
    remote,
    storage: memStorage(),
    log,
    root: ROOT,
    appVersion: APP_VERSION,
  });
}

/* ---------------- 容器源的假桥（装面判据用；**不证明解压**，见下注） ---------------- */

/**
 * 一个能装的最小容器：`pack.json` + `files/a.ERB`，容器字节 = 两者串起来
 * （照 `kojo-market/tests/install-index.test.ts` 的 `FakeBridge` 口径）。
 *
 * ⚠ 这里的 `marketDownload` 只是把给定字节写到平台侧要求的位置、`marketExtract` 只是把给定
 * 文件表摊平到目标目录：它按给定清单**构造**"解出来的样子"，不读 ZIP。真解压的判据在
 * cargo（`market_tests.rs`）与真壳 k 项。本文件用它只证一件事：**面板点下去之后走的是服务里
 * 那一条容器源路径**（落点、记账、清场都由那条路径负责）。
 */
interface Container {
  version: string;
  manifestBytes: Uint8Array;
  body: Uint8Array;
  containerBytes: Uint8Array;
}

async function makeContainer(version: string): Promise<Container> {
  const body = new TextEncoder().encode('口上テスト\r\n');
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(
      {
        schema: MARKET_SCHEMA_VERSION,
        kind: 'kojo-pack',
        id: 'demo.pack',
        version,
        name: '演示口上包',
        author: '某人',
        license: 'CC-BY-NC 4.0',
        redistribute: true,
        minAppVersion: '0.4.0',
        files: [{ path: `${MARKET_CONTENT_DIR}/a.ERB`, bytes: body.length, sha256: await sha256Hex(body) }],
      },
      null,
      2,
    ),
  );
  const containerBytes = new Uint8Array([...manifestBytes, ...body]);
  return { version, manifestBytes, body, containerBytes };
}

/** 索引那一行（默认与容器逐字一致；要造不符就自己覆盖 `zip`） */
async function entryOf(c: Container, over: Partial<MarketIndexEntry> = {}): Promise<MarketIndexEntry> {
  return {
    kind: 'kojo-pack',
    id: 'demo.pack',
    version: c.version,
    name: '演示口上包',
    author: '某人',
    license: 'CC-BY-NC 4.0',
    minAppVersion: '0.4.0',
    zip: {
      url: `https://example.test/releases/download/v${c.version}/${packContainerName('demo.pack', c.version)}`,
      sha256: await sha256Hex(c.containerBytes),
      bytes: c.containerBytes.length,
    },
    fileCount: 1,
    unpackedBytes: c.body.length,
    ...over,
  };
}

/** 假桥：写平台侧要的位置、回报条目表；`calls` 用来证明"摘要不符时根本不解压" */
function containerRemote(
  h: CountingIo,
  pick: () => Container,
  calls: Array<'download' | 'extract'>,
  opts: { failDownload?: boolean } = {},
): RemoteService {
  const staged = (name: string): string => join(ROOT, MARKET_STAGING_DIR, name);
  return {
    async fetchText(): Promise<RemoteText> {
      throw new Error('本用例不刷新索引');
    },
    async marketDownload(url: string, containerName: string): Promise<RemoteDownload> {
      calls.push('download');
      if (opts.failDownload === true) throw new Error('对面把门关了');
      const c = pick();
      await h.io.writeBytes(staged(containerName), c.containerBytes);
      return { bytes: c.containerBytes.length, status: 200, finalUrl: url };
    },
    async marketExtract(_containerName: string, targetName: string): Promise<RemoteExtractResult> {
      calls.push('extract');
      const c = pick();
      const dir = staged(targetName);
      await h.io.writeBytes(join(dir, MARKET_MANIFEST_FILE), c.manifestBytes);
      await h.io.writeBytes(join(dir, MARKET_CONTENT_DIR, 'a.ERB'), c.body);
      const entries = [
        { path: MARKET_MANIFEST_FILE, bytes: c.manifestBytes.length },
        { path: `${MARKET_CONTENT_DIR}/a.ERB`, bytes: c.body.length },
      ];
      return { entries, totalBytes: entries.reduce((s, e) => s + e.bytes, 0) };
    },
  };
}

interface FakeCtx {
  ctx: PluginContext;
  slots: Array<{ slot: string; item: unknown }>;
  /** 本插件经总线发出的事件（导入是"发意图"，判据要看载荷） */
  emits: Array<{ type: string; payload: unknown }>;
}

function panelCtx(market: MarketService, io: FileIO, log: Logger): FakeCtx {
  const slots: Array<{ slot: string; item: unknown }> = [];
  const emits: Array<{ type: string; payload: unknown }> = [];
  const ctx: PluginContext = {
    pluginId: 'ui-market',
    log,
    storage: memStorage(),
    slots: {
      register: (slot: string, item: unknown) => {
        slots.push({ slot, item });
        return () => undefined;
      },
      // 契约签名是 `query(slot)`；替身只服务本面板（不查槽），返回空数组即可
      query: () => [],
    } as never,
    bus: {
      on: () => () => undefined,
      emit: (type: string, payload: unknown) => {
        emits.push({ type, payload });
      },
      once: () => () => undefined,
      off: () => () => undefined,
    },
    inject: (key: string) => {
      if (key === MARKET_SERVICE_KEY) return market;
      if (key === 'kernel.io') return io;
      throw new Error(`未注册的服务：${key}`);
    },
    provide: () => undefined,
    tryInject: () => undefined,
    onDispose: () => undefined,
  } as unknown as PluginContext;
  return { ctx, slots, emits };
}

/* --------------------------------- 判据 --------------------------------- */

describe('ui-market 接线', () => {
  it('插件声明：只 require 市场服务键（**面板不摸盘、也不碰远程**）；不 provides；入口住主侧栏活动栏', async () => {
    const p = createUiMarketPlugin({ appVersion: APP_VERSION });
    expect(p.id).toBe('ui-market');
    // 收口 A：三态与"拉不拉得动远程"都由服务给 ⇒ kernel.io 这条依赖已被摘掉
    expect(p.requires).toEqual([MARKET_SERVICE_KEY]);
    expect(p.requires).not.toContain('kernel.io');
    expect(p.provides ?? []).toEqual([]);
    expect(p.requires).not.toContain('kernel.storage');

    const { io } = makeIo();
    const f = panelCtx(makeService(io), io, quietLog);
    await p.activate!(f.ctx);
    const panels = f.slots.filter((s) => s.slot === 'ui.panel').map((s) => s.item as UIPanelContribution);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.id).toBe('market');
    // 主侧栏独占视图（对标 VSCode 扩展视图：入口住活动栏，点开落在左栏）；
    // 刻意**不写** defaultActive:false——那会把视图贬到活动栏底部低频组（ProjectView 同一条先例）
    expect(panels[0]!.location).toBe('sidebar');
    expect(panels[0]!.defaultActive).not.toBe(false);
    expect(panels[0]!.title).toBe('口上市场');
    expect(typeof panels[0]!.component).toBe('function');
  });

  it('非法 appVersion ⇒ 拒绝装配（版本号不许硬写进插件源码）', () => {
    expect(() => createUiMarketPlugin({ appVersion: '乱写' })).toThrow(/appVersion/);
    expect(() => createUiMarketPlugin(undefined as unknown as { appVersion: string })).toThrow(/appVersion/);
    expect(() => createUiMarketPlugin({ appVersion: APP_VERSION })).not.toThrow();
  });

  it('装配顺序：市场服务没 provide ⇒ inject 当场炸（本插件必须排在 kojo-market 之后）', () => {
    const { io } = makeIo();
    const f = panelCtx(makeService(io), io, quietLog);
    const bare = {
      ...(f.ctx as unknown as Record<string, unknown>),
      inject: (key: string) => {
        throw new Error(`未注册的服务：${key}`);
      },
    } as unknown as PluginContext;
    expect(() => createUiMarketPlugin({ appVersion: APP_VERSION }).activate!(bare)).toThrow(
      /未注册的服务：market/,
    );
  });
});

describe('面板取数：四条显式态', () => {
  it('列表文件不在位 ⇒ list-missing（一句人话，不是空白屏）', async () => {
    const { io } = makeIo();
    const snap = await loadMarketSnapshot(depsOf(makeService(io)));
    expect(snap.status).toBe('list-missing');
    expect(snap.packs).toEqual([]);
    expect(snap.installed).toEqual([]);
  });

  it('列表文件在位但 JSON 坏 ⇒ list-broken；packs 为空 ⇒ no-packs', async () => {
    const h = makeIo();
    h.fs.write(join(ROOT, 'index.json'), new TextEncoder().encode('{坏 JSON'));
    let snap = await loadMarketSnapshot(depsOf(makeService(h.io)));
    expect(snap.status).toBe('list-broken');

    h.fs.write(
      join(ROOT, 'index.json'),
      new TextEncoder().encode(JSON.stringify({ schema: 1, generatedAt: '2026-10-15T00:00:00Z', packs: [] })),
    );
    snap = await loadMarketSnapshot(depsOf(makeService(h.io)));
    expect(snap.status).toBe('no-packs');

    h.fs.write(
      join(ROOT, 'index.json'),
      new TextEncoder().encode(
        JSON.stringify({
          schema: 1,
          generatedAt: '2026-10-15T00:00:00Z',
          packs: [
            {
              kind: 'kojo-pack',
              id: 'demo.pack',
              version: '1.0.0',
              name: '演示口上包',
              author: '某人',
              license: 'CC-BY-NC 4.0',
              minAppVersion: '0.4.0',
              zip: { url: 'https://example.test/a.zip', sha256: 'a'.repeat(64), bytes: 1004 },
              fileCount: 1,
              unpackedBytes: 12,
            },
          ],
        }),
      ),
    );
    snap = await loadMarketSnapshot(depsOf(makeService(h.io)));
    expect(snap.status).toBe('ready');
    expect(snap.packs).toHaveLength(1);
  });

  it('市场目录读不动 ⇒ list-unreadable 且出声（铁律 4 不静默）', async () => {
    const h = makeIo();
    const { log, warns } = captureLog();
    h.breakExists(true);
    const snap = await loadMarketSnapshot(depsOf(makeService(h.io, log), log));
    expect(snap.status).toBe('list-unreadable');
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe('面板取数：回源三态（SWR 后台段的判定面）', () => {
  /** 会回一份合法索引的远程替身（refreshed / cached 判据；failed 由 refusedRemote 给） */
  const servingRemote = (indexJson: string): RemoteService => ({
    async fetchText(): Promise<RemoteText> {
      return { text: indexJson, bytes: indexJson.length, status: 200, finalUrl: 'https://example.test/index.json' };
    },
    async marketDownload(): Promise<RemoteDownload> {
      throw new Error('本用例不下载容器');
    },
    async marketExtract(): Promise<RemoteExtractResult> {
      throw new Error('本用例不解压容器');
    },
  });

  it('首回源 refreshed；TTL 内再问 cached；硬回源失败 failed 且带着盘上旧列表回来（不清列表）', async () => {
    const h = makeIo();
    const indexJson = JSON.stringify({
      schema: MARKET_SCHEMA_VERSION,
      generatedAt: '2026-10-16T00:00:00Z',
      packs: [await entryOf(await makeContainer('1.0.0'))],
    });
    // refreshIndex 校验通过后要把原文 writeText 落盘（夹具默认对 writeText 即红）：
    // 只对本用例放行这条通道，写的就是替身回的原文
    const io: FileIO = {
      ...h.io,
      async writeText(p: string, text: string): Promise<void> {
        h.fs.write(p, new TextEncoder().encode(text));
      },
    };
    const market = makeService(io, quietLog, servingRemote(indexJson));
    // 端点是服务判定（空端点当场 failed，轮不到远程替身），刷新前先配好
    await market.setEndpoint('https://example.test/index.json');
    const deps = depsOf(market);

    const first = await pullMarketOutcome(deps, false);
    expect(first.state).toBe('refreshed');
    expect(first.snap.status).toBe('ready');
    expect(first.snap.packs).toHaveLength(1);

    const second = await pullMarketOutcome(deps, false);
    expect(second.state).toBe('cached');
    expect(second.snap.status).toBe('ready');

    // 换一座会拒的桥硬回源：失败态带旧列表回来，屏幕不至于从"有列表"闪成"没有"
    const failed = await pullMarketOutcome(depsOf(makeService(h.io, quietLog, refusedRemote())), true);
    expect(failed.state).toBe('failed');
    expect(failed.snap.status).toBe('ready');
    expect(failed.snap.packs).toHaveLength(1);
  });
});

describe('面板卸载：一次确认 + 列表与磁盘同时为空', () => {
  let uninstallCalls = 0;
  const counting = (market: MarketService): MarketService => ({
    ...market,
    async uninstall(kind, id, version) {
      uninstallCalls += 1;
      return market.uninstall(kind, id, version);
    },
  });

  beforeEach(() => {
    uninstallCalls = 0;
  });

  it('没有确认 ⇒ 连服务都不叫、盘上一个字节都不动', async () => {
    const h = makeIo();
    await writeSource(h.fs);
    const market = counting(makeService(h.io));
    const deps = depsOf(market);
    const rec = await market.installLocalDir(SOURCE);
    const dir = await market.installDir(rec.kind, rec.id, rec.version);
    expect(h.fs.exists(dir)).toBe(true);

    const out = await runUninstall(deps, rec, false);
    expect(out.kind).toBe('needs-confirm');
    expect(uninstallCalls).toBe(0);
    expect((await market.installed()).map((r) => r.id)).toEqual([rec.id]);
    expect(h.fs.exists(dir)).toBe(true);
    expect(h.fs.exists(join(dir, 'files', 'a.ERB'))).toBe(true);
  });

  it('确认后 ⇒ 已装列表为空 **且** 派生落点在盘上消失（真服务 + 真搬运）', async () => {
    const h = makeIo();
    await writeSource(h.fs);
    const market = counting(makeService(h.io));
    const deps = depsOf(market);
    const rec = await market.installLocalDir(SOURCE);
    const dir = await market.installDir(rec.kind, rec.id, rec.version);

    const out = await runUninstall(deps, rec, true);
    expect(out.kind).toBe('done');
    expect(uninstallCalls).toBe(1);
    expect(out.note).toContain('已卸掉');
    const snap = await loadMarketSnapshot(deps);
    expect(snap.installed).toEqual([]);
    expect(h.fs.exists(dir)).toBe(false);
    expect(await market.isInstalled(rec.kind, rec.id, rec.version)).toBe(false);
    // 卸完仍是一句人话的状态行，不是空白屏
    expect(['list-missing', 'no-packs', 'ready']).toContain(snap.status);
  });

  it('卸载失败 ⇒ 一句人话的内联状态 + 出声，不弹窗也不静默', async () => {
    const h = makeIo();
    await writeSource(h.fs);
    const { log, warns } = captureLog();
    const market = makeService(h.io, log);
    const deps = depsOf(market, log);
    const rec = await market.installLocalDir(SOURCE);
    const out = await runUninstall(deps, { ...rec, id: '没装过的包' }, true);
    expect(out.kind).toBe('failed');
    expect(out.note).toContain('卸载没有成功');
    expect(warns.some((w) => /installed-missing/.test(w))).toBe(true);
  });
});

/** 把列表写到盘上（面板的 packs 只能从这里来，它自己不认识任何"列表"） */
async function writeIndex(h: CountingIo, packs: MarketIndexEntry[]): Promise<void> {
  h.fs.write(
    join(ROOT, MARKET_INDEX_FILE),
    new TextEncoder().encode(
      JSON.stringify({ schema: MARKET_SCHEMA_VERSION, generatedAt: '2026-10-16T00:00:00Z', packs }),
    ),
  );
}

describe('面板装包：注册表容器源（真服务 + 假桥；一行一次点击）', () => {
  /** 暂存区零残壳（KM-12）：容器与解压目录都不该留下来 */
  const stagingClean = async (h: CountingIo, id: string, version: string): Promise<void> => {
    const staged = join(ROOT, MARKET_STAGING_DIR);
    expect(h.fs.exists(join(staged, packContainerName(id, version))), '容器残壳').toBe(false);
    expect(h.fs.exists(join(staged, packUnpackedName(id, version))), '解压目录残壳').toBe(false);
    expect(h.fs.children(staged), '暂存区里这一次的其余痕迹').toEqual([]);
  };

  it('点「安装」⇒ 走服务里那一条容器源路径：落点有内容、记账带容器核对码、暂存区清空', async () => {
    const h = makeIo();
    const c = await makeContainer('1.0.0');
    const entry = await entryOf(c);
    const calls: Array<'download' | 'extract'> = [];
    const market = makeService(h.io, quietLog, containerRemote(h, () => c, calls));
    const deps: MarketActionDeps = depsOf(market);

    const out = await runInstall(deps, entry, 'install');
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    // 文案就是那一句人话：包名 + 版本（版本来自服务记账，不是索引那一行抄的）
    expect(out.note).toBe('已装上「演示口上包」（版本 1.0.0）');
    expect(out.rec.id).toBe('demo.pack');
    expect(calls).toEqual(['download', 'extract']);

    // 容器源的身份：`containerSha256` **只有容器源才写** ⇒ 它同时是"来源"判据
    const list = await market.installed();
    expect(list.map((r) => r.version)).toEqual(['1.0.0']);
    expect(list[0]!.containerSha256).toBe(entry.zip.sha256);
    const dir = await market.installDir('kojo-pack', 'demo.pack', '1.0.0');
    expect(h.fs.exists(join(dir, MARKET_CONTENT_DIR, 'a.ERB'))).toBe(true);
    await stagingClean(h, 'demo.pack', '1.0.0');

    // 面板读回来就是已装列表里那句"来源 压缩包"（不是自猜的）；
    // 同一行再判一次三态 ⇒ 已经是最新，按钮消失（装完不会留一个还能点的「安装」）
    const snap = await loadMarketSnapshot(deps);
    expect(snap.installed).toHaveLength(1);
    const row = buildGroups([entry], APP_VERSION, '', snap.installed).flatMap((g) => g.rows)[0]!;
    expect(row.update?.state).toBe('latest');
    expect(row.action).toBe('none');
  });

  it('点「更新」⇒ 记账里两版并存（面板不自动覆盖），行上说的版本是服务刚记账那一版', async () => {
    const h = makeIo();
    let current = await makeContainer('1.0.0');
    const calls: Array<'download' | 'extract'> = [];
    const market = makeService(h.io, quietLog, containerRemote(h, () => current, calls));
    const deps: MarketActionDeps = depsOf(market);

    expect((await runInstall(deps, await entryOf(current), 'install')).kind).toBe('done');
    current = await makeContainer('1.0.1');
    const out = await runInstall(deps, await entryOf(current), 'update');
    expect(out.kind).toBe('done');
    expect(out.note).toBe('已把「演示口上包」更新到版本 1.0.1');

    const list = await market.installed();
    expect(list.map((r) => r.version).sort()).toEqual(['1.0.0', '1.0.1']);
    // 索引那一行（1.0.1）对已装集判出来就是"已装最新" ⇒ 下一次不再给按钮
    const row = buildGroups([await entryOf(current)], APP_VERSION, '', list).flatMap((g) => g.rows)[0]!;
    expect(row.update?.state).toBe('latest');
    expect(row.action).toBe('none');
    await stagingClean(h, 'demo.pack', '1.0.1');
  });

  it('行的动作来自盘上两份事实（列表 + 记账），不是面板自己拼的键集', async () => {
    const h = makeIo();
    const upRow = await makeContainer('1.0.1');
    const calls: Array<'download' | 'extract'> = [];
    const market = makeService(h.io, quietLog, containerRemote(h, () => upRow, calls));
    const deps: MarketActionDeps = depsOf(market);
    // 先按目录源装一版 1.0.0（这条路径一直在），再把 1.0.1 那一行摆进列表
    await writeSource(h.fs);
    await market.installLocalDir(SOURCE);
    await writeIndex(h, [await entryOf(upRow)]);

    const snap = await loadMarketSnapshot(deps);
    const row = buildGroups(snap.packs, APP_VERSION, '', snap.installed).flatMap((g) => g.rows)[0]!;
    expect(row.action).toBe('update');
    expect(row.installed).toBe(false);
    // 点它：交给服务的正是列表里那一行（原样，不重造）
    expect((await runInstall(deps, row.entry, 'update')).kind).toBe('done');
    expect((await market.installed()).map((r) => r.version).sort()).toEqual(['1.0.0', '1.0.1']);
  });

  it('拒因走映射表：下载没成功 ⇒ 那一句人话、本机一个字节没动、机器面带码出声', async () => {
    const h = makeIo();
    const c = await makeContainer('1.0.0');
    const entry = await entryOf(c);
    const calls: Array<'download' | 'extract'> = [];
    const { log, warns } = captureLog();
    const market = makeService(h.io, log, containerRemote(h, () => c, calls, { failDownload: true }));

    const out = await runInstall(depsOf(market, log), entry, 'install');
    expect(out.kind).toBe('failed');
    // 作者看到的这一句**逐字等于**表里那句，不是把异常消息甩上去
    expect(out.note).toBe(`「演示口上包」没装成：${REJECT_TEXT['download-failed']}`);
    for (const w of ['kind', 'id', 'manifest', 'index.json', 'sha256', 'schema', 'minAppVersion']) {
      expect(out.note, w).not.toContain(w);
    }
    expect(warns.some((w) => /download-failed/.test(w))).toBe(true);
    expect(await market.installed()).toEqual([]);
    expect(h.fs.exists(await market.installDir('kojo-pack', 'demo.pack', '1.0.0'))).toBe(false);
    expect(calls).toEqual(['download']);
    await stagingClean(h, 'demo.pack', '1.0.0');
  });

  it('整包核对码与注册表钉的不符 ⇒ 一句"不是同一份"，而且**根本不解压**', async () => {
    const h = makeIo();
    const c = await makeContainer('1.0.0');
    const entry = await entryOf(c, {});
    const lying: MarketIndexEntry = { ...entry, zip: { ...entry.zip, sha256: 'f'.repeat(64) } };
    const calls: Array<'download' | 'extract'> = [];
    const { log, warns } = captureLog();
    const market = makeService(h.io, log, containerRemote(h, () => c, calls));

    const out = await runInstall(depsOf(market, log), lying, 'install');
    expect(out.kind).toBe('failed');
    expect(out.note).toBe(`「演示口上包」没装成：${REJECT_TEXT['container-sha256']}`);
    expect(calls, '摘要不符就不该对容器动盘').toEqual(['download']);
    expect(await market.installed()).toEqual([]);
    expect(warns.some((w) => /container-sha256/.test(w))).toBe(true);
    await stagingClean(h, 'demo.pack', '1.0.0');
  });

  it('没有码的异常不静默：原话给出，仍带那一句前缀（面板不演成"成功"）', async () => {
    const h = makeIo();
    const c = await makeContainer('1.0.0');
    const entry = await entryOf(c);
    const boom: MarketService = {
      ...makeService(h.io),
      async installFromIndex(): Promise<never> {
        throw new Error('桥自己炸了');
      },
    };
    const out = await runInstall(depsOf(boom), entry, 'install');
    expect(out.kind).toBe('failed');
    expect(out.note).toBe('「演示口上包」没装成：桥自己炸了');
  });

  it('装完的列表读回来是一句人话的已装条目，卸载按钮仍在同一条上（装与卸共用一份已装真相）', async () => {
    const h = makeIo();
    const c = await makeContainer('1.0.0');
    const entry = await entryOf(c);
    const calls: Array<'download' | 'extract'> = [];
    const market = makeService(h.io, quietLog, containerRemote(h, () => c, calls));
    const deps: MarketActionDeps = depsOf(market);
    await runInstall(deps, entry, 'install');
    const snap = await loadMarketSnapshot(deps);
    const rec = snap.installed[0]!;
    expect(rec.name).toBe('演示口上包');
    const out = await runUninstall(deps, rec, true);
    expect(out.kind).toBe('done');
    expect((await loadMarketSnapshot(deps)).installed).toEqual([]);
  });
});

describe('面板渲染（静态；node 环境无 DOM 事件）', () => {
  it('挂载初期也不空白：显式态句子 + 能力面说明都在主行，机器词不在', async () => {
    const h = makeIo();
    const f = panelCtx(makeService(h.io), h.io, quietLog);
    await createUiMarketPlugin({ appVersion: APP_VERSION }).activate!(f.ctx);
    const panel = f.slots.find((s) => s.slot === 'ui.panel')!.item as UIPanelContribution;
    const html = renderToStaticMarkup(createElement(panel.component as never, {} as never));
    expect(html).toContain('本机还没有装好的包');
    // 取数按钮 label = 「拉取列表」（busy 首帧读作「拉取中…」且禁用）；旧文案「刷新」已随面板接线改掉
    expect(html).toContain('拉取中…');
    expect(html).toContain('disabled');
    // 数据时间行常驻，不被 busy 遮掩（作者要看得见自己用的是哪一刻的列表）
    expect(html).toContain('还没有数据时间');
    expect(html).toContain('按包名或作者过滤');
    // 主行不许出现机器词（展开层是机器面，静态渲染里没有展开）
    for (const word of ['index.json', 'sha256', 'manifest', 'schema', 'kind', 'minAppVersion']) {
      expect(html, word).not.toContain(word);
    }
  });
});

/* ---------------- 渲染层判据：哪一行给按钮（`MarketPanelView` 零状态 ⇒ 能静态检） ---------------- */

const HEX_A = 'a'.repeat(64);

const viewEntry = (id: string, version: string, over: Partial<MarketIndexEntry> = {}): MarketIndexEntry => ({
  kind: 'kojo-pack',
  id,
  version,
  name: `示例 ${id}`,
  author: '某人',
  license: 'CC-BY-NC 4.0',
  minAppVersion: '0.4.0',
  zip: { url: `https://example.test/releases/download/v${version}/${packContainerName(id, version)}`, sha256: HEX_A, bytes: 10 },
  fileCount: 1,
  unpackedBytes: 20,
  ...over,
});

const viewRec = (id: string, version: string, over: Partial<InstalledPack> = {}): InstalledPack => ({
  kind: 'kojo-pack',
  id,
  version,
  name: `示例 ${id}`,
  author: '某人',
  license: 'CC-BY-NC 4.0',
  contentDigest: HEX_A,
  installedAt: 1_700_000_000_000,
  files: [],
  ...over,
});

const noop = (): void => undefined;

/** 一版面的 props（`renderView` 拿它渲染；点击判据直接拿渲染树用） */
function viewProps(
  packs: MarketIndexEntry[],
  installed: InstalledPack[],
  overrides: Partial<Parameters<typeof MarketPanelView>[0]> = {},
): Parameters<typeof MarketPanelView>[0] {
  const snapshot: MarketSnapshot = {
    status: 'ready',
    packs,
    installed,
    // 夹具自己加一遍只是给展示层一个输入；产品侧的唯一口径在服务 `installedBytes()`
    installedBytes: installed.reduce((s, r) => s + r.files.reduce((t, f) => t + f.bytes, 0), 0),
    dropped: [],
    reason: '',
    fetchedAt: 1_700_000_000_000,
    generatedAt: '2026-10-16T00:00:00Z',
    endpoint: '',
    pullNote: '',
  };
  return {
    snapshot,
    appVersion: APP_VERSION,
    query: '',
    busy: false,
    note: '',
    pending: null,
    open: null,
    installing: null,
    onQuery: noop,
    onClearQuery: noop,
    onPull: noop,
    onPublish: noop,
    onInstall: noop,
    onImport: noop,
    onOpenSource: noop,
    onRequestUninstall: noop,
    onConfirmUninstall: noop,
    onCancelUninstall: noop,
    onToggleDetail: noop,
    ...overrides,
  };
}

/** 静态渲染一版面（`overrides` 想改哪个状态就改哪个） */
function renderView(
  packs: MarketIndexEntry[],
  installed: InstalledPack[],
  overrides: Partial<Parameters<typeof MarketPanelView>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(MarketPanelView, viewProps(packs, installed, overrides)));
}

/**
 * 在渲染树里找标签为 `label` 的那枚按钮元素。node 环境没有 DOM 事件，
 * 但 React 元素就是普通对象：找到它、**真的调用它的 onClick**——
 * "这一行点下去会接到哪个回调"因此不必靠猜 JSX。
 */
function findButton(node: unknown, label: string): { props: { onClick: () => void } } | null {
  if (node === null || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown; onClick?: unknown } };
  if (el.type === 'button' && el.props?.children === label && typeof el.props.onClick === 'function') {
    return el as { props: { onClick: () => void } };
  }
  const children = el.props?.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  for (const c of list) {
    const hit = findButton(c, label);
    if (hit !== null) return hit;
  }
  return null;
}

/** 屏上的按钮（标签 + 是否禁用）：动作判据只看这个，不去猜 JSX */
function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(
    (m) => `${m[2] ?? ''}${(m[1] ?? '').includes('disabled') ? '（禁用）' : ''}`,
  );
}

describe('面板安装面的渲染判据（哪一行有按钮）', () => {
  const packs = [
    viewEntry('new.pack', '1.0.1'),
    viewEntry('up.pack', '1.0.1'),
    viewEntry('high.pack', '1.0.1'),
    viewEntry('same.pack', '1.0.1'),
    viewEntry('old.app.pack', '1.0.1', { minAppVersion: '9.9.9' }),
  ];
  const installed = [viewRec('up.pack', '1.0.0'), viewRec('high.pack', '2.0.0'), viewRec('same.pack', '1.0.1')];

  it('没装过的行有「安装」、`updatable` 的行有「更新」，各恰一个（其余行一个都不许多）', () => {
    const html = renderView(packs, installed);
    const bs = buttonsOf(html);
    expect(bs.filter((b) => b === '安装')).toEqual(['安装']);
    expect(bs.filter((b) => b === '更新')).toEqual(['更新']);
    // 行上说清要更到哪一版
    expect(html).toContain('可更新到 1.0.1');
  });

  it('`ahead` 的行**不给按钮**，只如实说本机更高；`latest` 的行同样没有按钮', () => {
    const html = renderView([packs[2]!], [viewRec('high.pack', '2.0.0')]);
    expect(html).toContain('本机已是 2.0.0（比注册表那条新）');
    expect(buttonsOf(html).filter((b) => b === '安装' || b === '更新')).toEqual([]);
    const latest = renderView([packs[3]!], [viewRec('same.pack', '1.0.1')]);
    expect(buttonsOf(latest).filter((b) => b === '安装' || b === '更新')).toEqual([]);
    expect(latest).toContain('已安装');
  });

  it('已装区给出「占用」读数（取快照里那条服务口径，本机没装就不显示）', () => {
    const sized: InstalledPack = {
      ...viewRec('sized.pack', '1.0.0'),
      files: [
        { path: 'files/a.ERB', bytes: 1024, sha256: HEX_A },
        { path: 'files/b.ERB', bytes: 512, sha256: HEX_A },
      ],
    };
    expect(renderView([], [sized])).toContain('占用 1.5 KB');
    expect(renderView([], [])).not.toContain('占用');
  });

  it('本机版本不够装 ⇒ 行上没有按钮，只有一句"要求编辑器不低于 x.y.z"', () => {
    const html = renderView([packs[4]!], []);
    expect(buttonsOf(html).filter((b) => b === '安装' || b === '更新')).toEqual([]);
    expect(html).toContain('这个包要求编辑器不低于 9.9.9');
  });

  it('正在进行那一次 ⇒ 全部动作按钮禁用（进度只写在状态行一处，按钮文字不变）', () => {
    const html = renderView(packs, installed, {
      installing: 'kojo-pack/new.pack@1.0.1',
      note: '正在安装「示例 new.pack」…',
    });
    const bs = buttonsOf(html);
    expect(bs).toContain('安装（禁用）');
    expect(bs).toContain('更新（禁用）');
    expect(bs).toContain('卸载（禁用）');
    expect(bs.filter((b) => b === '安装' || b === '更新')).toEqual([]);
    // 同一件事不在两处显示：按钮上不写"安装中"，那句只在状态行
    expect(bs.filter((b) => /中…/.test(b))).toEqual([]);
    expect(html).toContain('正在安装「示例 new.pack」…');
  });

  it('渲染层的主行也不含机器词（展开层没展开 ⇒ 核对码与 id/kind 都不该出现）', () => {
    const html = renderView(packs, installed);
    for (const word of ['index.json', 'sha256', 'manifest', 'schema', 'kind', 'minAppVersion', 'id ', 'zip']) {
      expect(html, word).not.toContain(word);
    }
  });
});

/* ------------- 已装口上包 → 「导入为我的口上项目」（KM-13 消费侧：只发意图） ------------- */

describe('已装行「导入为我的口上项目」的渲染判据', () => {
  const rowOf = (html: string, name: string): string =>
    html.split('<div class="mk-row">').slice(1).find((s) => s.includes(name))!;

  it('只有口上包那一行有导入按钮（字典包 / 模板包不给）；其余按钮照旧', () => {
    const html = renderView(
      [],
      [
        viewRec('k.pack', '1.0.0', { name: '演示口上' }),
        viewRec('d.pack', '1.0.0', { kind: 'dict-pack', name: '演示字典' }),
        viewRec('t.pack', '1.0.0', { kind: 'template-pack', name: '演示模板' }),
      ],
    );
    expect(buttonsOf(html).filter((b) => b === '导入为我的口上项目')).toEqual(['导入为我的口上项目']);
    expect(rowOf(html, '演示口上')).toContain('导入为我的口上项目');
    expect(rowOf(html, '演示字典')).not.toContain('导入为我的口上项目');
    expect(rowOf(html, '演示模板')).not.toContain('导入为我的口上项目');
    // 导入是加在既有行上的第七个动作，不是替换：卸载按钮仍在每一行上
    expect(buttonsOf(html).filter((b) => b === '卸载')).toHaveLength(3);
  });

  it('真点下去 ⇒ 回调收到的正是这一行自己的记账（同一屏两行不串）', () => {
    const kojo = viewRec('k.pack', '1.0.0', { name: '演示口上' });
    const dict = viewRec('d.pack', '1.0.0', { kind: 'dict-pack', name: '演示字典' });
    const got: InstalledPack[] = [];
    const tree = MarketPanelView(viewProps([], [kojo, dict], { onImport: (r) => got.push(r) }));
    const btn = findButton(tree, '导入为我的口上项目');
    expect(btn).not.toBeNull();
    btn!.props.onClick();
    expect(got).toEqual([kojo]);
  });

  it('装 / 更新进行中 ⇒ 与其它动作一样禁用（闲时不禁用；不新增 busy 文案）', () => {
    const fresh = renderView([], [viewRec('k.pack', '1.0.0')]);
    expect(buttonsOf(fresh)).toContain('导入为我的口上项目');
    const busy = renderView([], [viewRec('k.pack', '1.0.0')], {
      installing: 'kojo-pack/other@1.0.0',
      note: '正在安装「别的包」…',
    });
    const bs = buttonsOf(busy);
    expect(bs).toContain('导入为我的口上项目（禁用）');
    expect(bs.filter((b) => b === '导入为我的口上项目')).toEqual([]);
    // 同一件事不在两处显示：按钮文字不写"导入中…"（进度只住状态行）
    expect(bs.filter((b) => /中…/.test(b))).toEqual([]);
  });
});

describe('导入请求的行为判据（`runImport`：取目录 → 发意图）', () => {
  it('点下去：contentDir 按该行三元组调用、总线收到逐字冻结的载荷、状态行是那句人话', async () => {
    const h = makeIo();
    await writeSource(h.fs);
    const market = makeService(h.io);
    const rec = await market.installLocalDir(SOURCE);
    const seen: Array<[string, string, string]> = [];
    const counting: MarketService = {
      ...market,
      async contentDir(kind, id, version) {
        seen.push([kind, id, version]);
        return market.contentDir(kind, id, version);
      },
    };
    const { bus, emits } = recordingBus();
    const out = await runImport({ market: counting, bus, log: quietLog }, rec);

    expect(out.kind).toBe('done');
    expect(seen).toEqual([['kojo-pack', 'demo.pack', '1.0.0']]);
    expect(emits).toHaveLength(1);
    expect(emits[0]!.type).toBe('workspace.importRequested');
    // 载荷 = 两侧冻结的接缝（adapter 按 `source` 认发起方并做署名映射）：逐字相等
    expect(emits[0]!.payload).toEqual({
      sourceDir: join(ROOT, MARKET_PACKS_DIR, 'kojo-pack', 'demo.pack', '1.0.0', MARKET_CONTENT_DIR),
      suggestedName: '演示口上包',
      source: 'market',
    });
    // 字段名也不许夹带别的键（接缝改名 = adapter 那边静默接不上）
    expect(Object.keys(emits[0]!.payload as Record<string, unknown>).sort()).toEqual([
      'source',
      'sourceDir',
      'suggestedName',
    ]);
    // 发出去的是服务派生的内容目录本身（里面真有包内容），不是面板自己拼的路径
    expect(h.fs.exists((emits[0]!.payload as { sourceDir: string }).sourceDir)).toBe(true);
    // 作者面那一句：说"已请求"（不当成"已导入"），也不含机器词
    expect(out.note).toBe('已请求导入「演示口上包」，请在弹出的窗口里选择要导入到的项目');
    for (const w of ['kind', 'id', 'sha256', 'manifest', 'index.json', 'schema', 'importRequested']) {
      expect(out.note, w).not.toContain(w);
    }
  });

  it('contentDir 取不动 ⇒ 一句人话的 mk-note、**一个事件都不发**、机器面出声（不弹窗）', async () => {
    const h = makeIo();
    await writeSource(h.fs);
    const market = makeService(h.io);
    const rec = await market.installLocalDir(SOURCE);
    const { log, warns } = captureLog();
    const { bus, emits } = recordingBus();
    const boom: MarketService = {
      ...market,
      async contentDir(): Promise<string> {
        throw new Error('目录读不动');
      },
    };
    const out = await runImport({ market: boom, bus, log }, rec);

    expect(out.kind).toBe('failed');
    expect(out.note).toBe('「演示口上包」没能开始导入：目录读不动');
    expect(emits).toEqual([]);
    expect(warns.some((w) => /市场导入请求没有发出/.test(w))).toBe(true);
    // 错误只进既有那一条内联状态行（mk-note），不弹窗：静态渲染里就是这一句
    const html = renderView([], [rec], { note: out.note });
    expect(html).toContain('mk-note');
    expect(html).toContain('没能开始导入');
  });
});

/* ---------------- 索引行来源网址（KM-16 尾巴：子层可见、已接外链原语可点） ---------------- */

describe('索引行的来源网址', () => {
  it('有 sourceUrl ⇒ 子层多一行「来源 <url>」可点按钮；缺省就不占行（主行不动）', () => {
    const url = 'https://example.test/k.pack';
    const withUrl = renderView([viewEntry('k.pack', '1.0.0', { sourceUrl: url })], []);
    // button 语义 + mk-sub 灰字观感（外链原语已接，壳层消费 `ui.openExternal`）
    expect(withUrl).toContain(
      `<button class="mk-sub mk-link" type="button" title="在浏览器打开 ${url}">来源 ${url}</button>`,
    );
    // 依旧不做 `<a>`（webview 内导航不进原语；点击走壳层 → Rust 闸）
    expect(withUrl).not.toMatch(/<a[\s>]/);

    const without = renderView([viewEntry('k.pack', '1.0.0')], []);
    expect(without).not.toContain('来源');
    expect(without).not.toContain(url);
  });

  it('摘要与来源可以同屏（各占子层一行），互不顶替', () => {
    const html = renderView(
      [viewEntry('k.pack', '1.0.0', { summary: '一句包介绍', sourceUrl: 'https://example.test/k.pack' })],
      [],
    );
    expect(html).toContain('<div class="mk-sub">一句包介绍</div>');
    expect(html).toContain('<button class="mk-sub mk-link" type="button" title="在浏览器打开 https://example.test/k.pack">来源 https://example.test/k.pack</button>');
  });
});

/* ---------------- 结构判据（DOM 契约：工具条 / 状态簇 / 自滚列表 / 行内动作簇） ---------------- */

/** 渲染树里的元素（本层判据只把 React 元素当普通对象读，不跑 DOM） */
interface El {
  type: unknown;
  props: Record<string, unknown>;
}

const isEl = (node: unknown): node is El =>
  node !== null && typeof node === 'object' && 'props' in node && 'type' in node;

/** 子元素（数组与嵌套数组一律摊平；文本与 null 保留给调用方自己滤） */
function kids(el: El): unknown[] {
  const flat = (n: unknown): unknown[] => (Array.isArray(n) ? n.flatMap(flat) : [n]);
  return flat(el.props.children);
}

/** 子树里 `className` 含该 token 的元素（`mk-row open` 也算 `mk-row`） */
function byClass(node: unknown, cls: string, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) byClass(n, cls, out);
    return out;
  }
  if (!isEl(node)) return out;
  const cn = node.props.className;
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) out.push(node);
  for (const c of kids(node)) byClass(c, cls, out);
  return out;
}

/** 子树里的 button 元素（要数按钮、要读 `aria-*`、要真的调用 `onClick`） */
function buttonEls(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) buttonEls(n, out);
    return out;
  }
  if (!isEl(node)) return out;
  if (node.type === 'button') out.push(node);
  for (const c of kids(node)) buttonEls(c, out);
  return out;
}

/** 标签为 `label` 的那枚 button 元素本身（`findButton` 只给 onClick，这里要看的更多） */
const buttonEl = (node: unknown, label: string): El | null =>
  buttonEls(node).find((b) => b.props.children === label) ?? null;

/** 状态簇那一段（`mk-flash` 起、`mk-body` 止）与列表那一段（`mk-body` 起、到结尾） */
const flashOf = (html: string): string =>
  html.slice(html.indexOf('class="mk-flash"'), html.indexOf('class="mk-body"'));
const bodyOf = (html: string): string => html.slice(html.indexOf('class="mk-body"'));

describe('面板结构分层（工具条 / 状态簇 / 自滚列表）', () => {
  const packs2 = [viewEntry('a.pack', '1.0.0'), viewEntry('b.pack', '1.0.0', { summary: '一句包介绍' })];
  const installed1 = [viewRec('a.pack', '1.0.0', { name: '示例 a.pack' })];

  it('三段的家：工具条在最前，状态与数据时间住 .mk-flash，列表住 .mk-body', () => {
    const html = renderView(packs2, installed1, { note: '已装上「示例 a.pack」（版本 1.0.0）' });
    expect(html.indexOf('class="mk-toolbar"')).toBeLessThan(html.indexOf('class="mk-flash"'));
    expect(html.indexOf('class="mk-flash"')).toBeLessThan(html.indexOf('class="mk-body"'));
    const flash = flashOf(html);
    // 状态簇：数据时间、那一句结果、能力面说明（无过滤时）都在滚动区之外
    expect(flash).toContain('数据时间');
    expect(flash).toContain('已装上「示例 a.pack」');
    expect(flash).toContain('mk-hint');
    // 列表的家在滚动区里，绝不该出现在状态簇（否则一滚就丢了"这是哪一刻的数据"）
    expect(flash).not.toContain('mk-grouptitle');
    expect(flash).not.toContain('class="mk-row"');
    expect(bodyOf(html)).toContain('mk-grouptitle');
    expect(bodyOf(html)).toContain('class="mk-row"');
  });

  it('可达性：状态簇 role=status、结果那一句 aria-live=polite、过滤输入有 aria-label', () => {
    const html = renderView(packs2, installed1, { note: '正在安装「示例 a.pack」…' });
    expect(html).toMatch(/<div class="mk-flash"[^>]*role="status"/);
    expect(html).toMatch(/<div class="mk-note"[^>]*aria-live="polite"/);
    expect(html).toMatch(/<input class="mk-search"[^>]*aria-label="按包名或作者过滤"/);
    // 拉取按钮的 className 一个字节没动（外层样式契约）
    expect(html).toContain('<button class="ghost small">拉取列表</button>');
  });

  it('工具条分两组：搜索组（输入 + 清除）与动作组（拉取列表 + 发布口上…），窄侧栏可整组折行', () => {
    const tree = MarketPanelView(viewProps(packs2, installed1, { query: 'a.pack' }));
    const toolbar = byClass(tree, 'mk-toolbar')[0]!;
    const groups = kids(toolbar).filter(isEl);
    expect(groups.map((g) => g.props.className)).toEqual(['mk-search-wrap', 'mk-toolbar-actions']);
    // 搜索组：输入框 + 过滤态才出现的清除（两件是一组，不让清除被动作组挤走）
    expect(byClass(groups[0]!, 'mk-search')).toHaveLength(1);
    expect(byClass(groups[0]!, 'mk-clear')).toHaveLength(1);
    // 动作组：拉取在前、发布口上在后；发布那枚带自己的类（accent 描边，样式在 app 侧）
    const acts = buttonEls(groups[1]!);
    expect(acts.map((b) => b.props.children)).toEqual(['拉取列表', PUBLISH_LABEL]);
    expect((buttonEl(groups[1]!, PUBLISH_LABEL)!.props.className as string).split(/\s+/)).toContain(
      'mk-publish',
    );
  });

  it('索引行的第二排事实顺序固定：版本 → 体积/文件数 → 作者 → 许可（分隔由样式层给）', () => {
    const tree = MarketPanelView(viewProps([viewEntry('k.pack', '1.0.0')], []));
    const facts = byClass(tree, 'mk-facts')[0]!;
    expect(kids(facts).map((f) => (f as El).props.children)).toEqual([
      '版本 1.0.0',
      '20 B · 1 个文件',
      '作者 某人',
      '许可 CC-BY-NC 4.0',
    ]);
  });

  it('过滤态的「清除」住在搜索组里：动作组始终只有拉取 + 发布两枚（四个控件不抢一条排）', () => {
    const idle = byClass(MarketPanelView(viewProps(packs2, installed1)), 'mk-toolbar-actions')[0]!;
    const filtered = byClass(
      MarketPanelView(viewProps(packs2, installed1, { query: 'a.pack' })),
      'mk-toolbar-actions',
    )[0]!;
    expect(buttonEls(idle).map((b) => b.props.children)).toEqual(['拉取列表', PUBLISH_LABEL]);
    expect(buttonEls(filtered).map((b) => b.props.children)).toEqual(['拉取列表', PUBLISH_LABEL]);
    const searchWrap = byClass(
      MarketPanelView(viewProps(packs2, installed1, { query: 'a.pack' })),
      'mk-search-wrap',
    )[0]!;
    expect(byClass(searchWrap, 'mk-clear')).toHaveLength(1);
  });

  it('行的层级：一张卡两排——第一排名字 + 动作（.mk-head），第二排事实（.mk-facts），行本身不是 button', () => {
    const tree = MarketPanelView(viewProps(packs2, installed1));
    const rows = byClass(tree, 'mk-row');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.type, '行不许是 button 语义').toBe('div');
    const mains = byClass(tree, 'mk-main');
    expect(mains).toHaveLength(3);
    for (const main of mains) {
      const lines = kids(main).filter(isEl);
      expect(
        lines.map((e) => (e.props.className as string).split(/\s+/)[0]),
        '一张卡恰好两排',
      ).toEqual(['mk-head', 'mk-facts']);
      const head = lines[0]!;
      const headEls = kids(head).filter(isEl);
      expect((headEls[0]!.props.className as string).split(/\s+/)).toContain('mk-name');
      expect(headEls[headEls.length - 1]!.props.className, '动作簇是第一排的最后一项').toBe('mk-actions');
      // 事实一律在第二排，且只有事实
      for (const f of kids(lines[1]!).filter(isEl)) {
        expect((f.props.className as string).split(/\s+/)).toContain('mk-meta');
      }
      const acts = byClass(main, 'mk-actions');
      expect(acts, '一个 .mk-main 只有一个动作簇').toHaveLength(1);
      // 这一行的按钮一枚都不许落在动作簇之外
      expect(buttonEls(main).length).toBe(buttonEls(acts[0]!).length);
    }
  });

  it('组标题给计数：已装组 = 条数 + 服务口径的占用，索引组 = 屏上剩几条（过滤后跟着变，已装组不跟着变）', () => {
    const sized: InstalledPack = {
      ...viewRec('a.pack', '1.0.0'),
      files: [{ path: 'files/a.ERB', bytes: 1024, sha256: HEX_A }],
    };
    const html = renderView(packs2, [sized]);
    expect(html).toContain('<h4 class="mk-grouptitle">已安装<span class="mk-count">1 个 · 占用 1.0 KB</span></h4>');
    expect(html).toContain('<h4 class="mk-grouptitle">口上包<span class="mk-count">2 个</span></h4>');
    const filtered = renderView(packs2, [sized], { query: 'b.pack' });
    expect(filtered).toContain('<h4 class="mk-grouptitle">口上包<span class="mk-count">1 个</span></h4>');
    expect(filtered).toContain('<h4 class="mk-grouptitle">已安装<span class="mk-count">1 个 · 占用 1.0 KB</span></h4>');
    // 占用读数只有一个口径：过滤不重新加总、也不换算法
    expect(filtered).not.toContain('占用 2.0 KB');
  });

  it('过滤态：「清除」出现（点下去真的清空查询）、能力说明让位、空态那句照给；不写查询时都没有', () => {
    const idle = renderView(packs2, []);
    expect(idle).not.toContain('mk-clear');
    expect(idle).toContain('mk-hint');

    const cleared: number[] = [];
    const tree = MarketPanelView(viewProps(packs2, [], { query: '查无此包', onClearQuery: () => cleared.push(1) }));
    const html = renderView(packs2, [], { query: '查无此包' });
    expect(html).toContain('class="ghost small mk-clear"');
    expect(html).not.toContain('mk-hint');
    expect(html).toContain('没有名字或作者里含「查无此包」的包');
    const btn = buttonEl(tree, '清除');
    expect(btn).not.toBeNull();
    (btn!.props.onClick as () => void)();
    expect(cleared).toEqual([1]);
  });

  it('卸载确认簇：簇内 Esc 取消（不抢全局键），确认/取消仍是纯文字按钮且住在这一行的动作簇里', () => {
    const key = 'kojo-pack/a.pack@1.0.0';
    const cancelled: string[] = [];
    const tree = MarketPanelView(
      viewProps([], installed1, { pending: key, onCancelUninstall: () => cancelled.push('esc') }),
    );
    const cluster = byClass(tree, 'mk-confirm');
    expect(cluster).toHaveLength(1);
    const onKeyDown = cluster[0]!.props.onKeyDown as (event: { key: string }) => void;
    expect(typeof onKeyDown).toBe('function');
    onKeyDown({ key: 'Enter' });
    expect(cancelled, 'Esc 之外的键不该被这一簇吃掉').toEqual([]);
    onKeyDown({ key: 'Escape' });
    expect(cancelled).toEqual(['esc']);
    expect(buttonEls(byClass(tree, 'mk-actions')[0]!).map((b) => b.props.children)).toEqual([
      '详情',
      '导入为我的口上项目',
      '确认',
      '取消',
    ]);
  });

  it('进行中：确认簇的「取消」与展开切换仍可点（不把作者锁在确认态里），装/卸动作一律禁用', () => {
    const key = 'kojo-pack/a.pack@1.0.0';
    const bs = buttonsOf(
      renderView([], installed1, {
        pending: key,
        installing: 'kojo-pack/other@9.9.9',
        note: '正在安装「别的包」…',
      }),
    );
    expect(bs).toContain('确认（禁用）');
    expect(bs).toContain('导入为我的口上项目（禁用）');
    expect(bs).toContain('取消');
    expect(bs).toContain('详情');
    expect(bs.filter((b) => b === '取消（禁用）' || b === '详情（禁用）')).toEqual([]);
    expect(bs.filter((b) => /中…/.test(b))).toEqual([]);
  });

  it('展开切换给 aria-expanded；机器词只在展开层出现', () => {
    const key = 'kojo-pack/a.pack@1.0.0';
    const closed = MarketPanelView(viewProps([], installed1));
    expect(buttonEl(closed, '详情')!.props['aria-expanded']).toBe(false);
    const opened = MarketPanelView(viewProps([], installed1, { open: key }));
    expect(buttonEl(opened, '收起')!.props['aria-expanded']).toBe(true);
    const openedHtml = renderToStaticMarkup(createElement(MarketPanelView, viewProps([], installed1, { open: key })));
    expect(openedHtml).toContain('<div class="mk-row open">');
    expect(openedHtml).toContain('kind kojo-pack');
    expect(renderToStaticMarkup(createElement(MarketPanelView, viewProps([], installed1)))).not.toContain('kind');
  });
});

/* ------------- 进度条（装/更新仪表区的无文字进度） ------------- */

describe('mk-progress', () => {
  it('progress 非空 ⇒ mk-progress 出现且 aria-valuenow / fill 宽度如实；null ⇒ 不占行', () => {
    const withBar = renderView([], [], { progress: 42, note: '正在安装「示例 a.pack」…' });
    expect(withBar).toMatch(/class="mk-progress"[^>]*aria-valuenow="42"/);
    expect(withBar).toContain('<div class="mk-progress-fill" style="width:42%"></div>');
    // 进度条本身无文字：带字的进度句仍只住 .mk-note 一处
    expect(withBar).not.toMatch(/mk-progress-fill"><[^/]/);
    expect(renderView([], [])).not.toContain('mk-progress');
  });
});

/* ------------- 发布入口（用户反馈 4：工具条按钮只发意图，不再选 zip / 上传） ------------- */

describe('「发布口上…」入口', () => {
  it('工具条上有「发布口上…」；点下去真的调到 onPublish（不做选文件那一步）', () => {
    const clicks: string[] = [];
    const tree = MarketPanelView(viewProps([], [], { onPublish: () => clicks.push('publish') }));
    const btn = buttonEl(tree, PUBLISH_LABEL);
    expect(btn).not.toBeNull();
    (btn!.props.onClick as () => void)();
    expect(clicks).toEqual(['publish']);
    // 旧通道的"选 zip / 上传"元素一个都不在：发布引导住适配器的发布向导
    expect(renderView([], [])).not.toContain('选择要发布的包容器');
  });

  it('点发布按钮 ⇒ 总线收到 market.publishRequested（载荷逐字冻结，不碰市场服务）', () => {
    const emits: Array<{ type: string; payload: unknown }> = [];
    const deps: MarketActionDeps = {
      market: {} as never, // 发布意图不调服务：项目选择 / 打包 / 许可 / 上传都在适配器
      bus: {
        on: () => () => undefined,
        once: () => () => undefined,
        emit: (type: string, payload: unknown) => {
          emits.push({ type, payload });
        },
      } as unknown as EventBus,
      log: quietLog,
    };
    // 视图的发布入口 = 带状态面板里那一条同一接线（MarketPanel 的 onPublish ⇒ requestPublish）
    const tree = MarketPanelView(viewProps([], [], { onPublish: () => requestPublish(deps) }));
    (buttonEl(tree, PUBLISH_LABEL)!.props.onClick as () => void)();
    expect(emits).toEqual([{ type: 'market.publishRequested', payload: { source: 'ui-market' } }]);
  });

  it('装/更新进行中或列表读取中 ⇒ 发布按钮禁用（发布本身不占"忙"位）', () => {
    expect(buttonsOf(renderView([], []))).toContain(PUBLISH_LABEL);
    expect(buttonsOf(renderView([], [], { busy: true }))).toContain(`${PUBLISH_LABEL}（禁用）`);
    expect(
      buttonsOf(renderView([], [], { installing: 'kojo-pack/other@1.0.0', note: '正在安装「别的包」…' })),
    ).toContain(`${PUBLISH_LABEL}（禁用）`);
  });

  it('列表缺失 / 读失败也不拦发布：发布只依赖"此刻有没有在装包"', () => {
    const props = viewProps([], []);
    const html = renderToStaticMarkup(
      createElement(MarketPanelView, {
        ...props,
        snapshot: { ...props.snapshot, status: 'list-missing' as const },
      }),
    );
    expect(buttonsOf(html)).toContain(PUBLISH_LABEL);
  });

  it('入口不持状态：连点两次就发两条意图（不吞第二次，也不留自己的发布中态）', () => {
    const emits: string[] = [];
    const deps: MarketActionDeps = {
      market: {} as never,
      bus: {
        on: () => () => undefined,
        once: () => () => undefined,
        emit: (type: string) => {
          emits.push(type);
        },
      } as unknown as EventBus,
      log: quietLog,
    };
    const tree = MarketPanelView(viewProps([], [], { onPublish: () => requestPublish(deps) }));
    const click = buttonEl(tree, PUBLISH_LABEL)!.props.onClick as () => void;
    click();
    click();
    expect(emits).toEqual(['market.publishRequested', 'market.publishRequested']);
  });
});

