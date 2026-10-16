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
import { createUiMarketPlugin, MarketPanelView } from '../src/index';
import {
  loadMarketSnapshot,
  runImport,
  runInstall,
  runUninstall,
  type MarketActionDeps,
  type MarketSnapshot,
} from '../src/actions';
import { buildGroups, REJECT_TEXT } from '../src/market-view';

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
    async removeDir(p) {
      calls.push(`removeDir:${p}`);
      fs.removeTree(p);
    },
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
  it('插件声明：只 require 市场服务键（**面板不摸盘、也不碰远程**）；不 provides；面板默认不激活', async () => {
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
    expect(panels[0]!.defaultActive).toBe(false);
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

/** 静态渲染一版面（`overrides` 想改哪个状态就改哪个） */
function renderView(
  packs: MarketIndexEntry[],
  installed: InstalledPack[],
  overrides: Partial<Parameters<typeof MarketPanelView>[0]> = {},
): string {
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
  return renderToStaticMarkup(
    createElement(MarketPanelView, {
      snapshot,
      appVersion: APP_VERSION,
      query: '',
      busy: false,
      note: '',
      pending: null,
      open: null,
      installing: null,
      onQuery: noop,
      onPull: noop,
      onInstall: noop,
      onImport: noop,
      onRequestUninstall: noop,
      onConfirmUninstall: noop,
      onCancelUninstall: noop,
      onToggleDetail: noop,
      ...overrides,
    }),
  );
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

