import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MARKET_SERVICE_KEY,
  join,
  type DirEntry,
  type FileIO,
  type Logger,
  type MarketService,
  type PluginContext,
  type ScopedStorage,
  type TextFile,
  type UIPanelContribution,
} from '@kojo/plugin-api';
// 测试面（audit C 对测试豁免）：拿**真**市场服务实现跑面板的取数/卸载判据，
// 这样"卸完了列表与磁盘同时为空"钉的是实现，不是自造的假盘。
import { createMarketService, sha256Hex } from '@kojo/plugin-kojo-market';
import { createUiMarketPlugin } from '../src/index';
import { loadMarketSnapshot, runUninstall } from '../src/actions';

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

function makeService(io: FileIO, log: Logger = quietLog): MarketService {
  return createMarketService({ io, storage: memStorage(), log, root: ROOT, appVersion: APP_VERSION });
}

interface FakeCtx {
  ctx: PluginContext;
  slots: Array<{ slot: string; item: unknown }>;
}

function panelCtx(market: MarketService, io: FileIO, log: Logger): FakeCtx {
  const slots: Array<{ slot: string; item: unknown }> = [];
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
    bus: { on: () => () => undefined, emit: () => undefined, once: () => () => undefined, off: () => undefined },
    inject: (key: string) => {
      if (key === MARKET_SERVICE_KEY) return market;
      if (key === 'kernel.io') return io;
      throw new Error(`未注册的服务：${key}`);
    },
    provide: () => undefined,
    tryInject: () => undefined,
    onDispose: () => undefined,
  } as unknown as PluginContext;
  return { ctx, slots };
}

/* --------------------------------- 判据 --------------------------------- */

describe('ui-market 接线', () => {
  it('插件声明：require 市场服务键 + kernel.io；不 provides；面板默认不激活', async () => {
    const p = createUiMarketPlugin({ appVersion: APP_VERSION });
    expect(p.id).toBe('ui-market');
    expect(p.requires).toEqual([MARKET_SERVICE_KEY, 'kernel.io']);
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
    const snap = await loadMarketSnapshot({ market: makeService(io), io, log: quietLog });
    expect(snap.status).toBe('list-missing');
    expect(snap.packs).toEqual([]);
    expect(snap.installed).toEqual([]);
  });

  it('列表文件在位但 JSON 坏 ⇒ list-broken；packs 为空 ⇒ no-packs', async () => {
    const h = makeIo();
    h.fs.write(join(ROOT, 'index.json'), new TextEncoder().encode('{坏 JSON'));
    let snap = await loadMarketSnapshot({ market: makeService(h.io), io: h.io, log: quietLog });
    expect(snap.status).toBe('list-broken');

    h.fs.write(
      join(ROOT, 'index.json'),
      new TextEncoder().encode(JSON.stringify({ schema: 1, generatedAt: '2026-10-15T00:00:00Z', packs: [] })),
    );
    snap = await loadMarketSnapshot({ market: makeService(h.io), io: h.io, log: quietLog });
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
    snap = await loadMarketSnapshot({ market: makeService(h.io), io: h.io, log: quietLog });
    expect(snap.status).toBe('ready');
    expect(snap.packs).toHaveLength(1);
  });

  it('市场目录读不动 ⇒ list-unreadable 且出声（铁律 4 不静默）', async () => {
    const h = makeIo();
    const { log, warns } = captureLog();
    h.breakExists(true);
    const snap = await loadMarketSnapshot({ market: makeService(h.io, log), io: h.io, log });
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
    const deps = { market, io: h.io, log: quietLog };
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
    const deps = { market, io: h.io, log: quietLog };
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
    const deps = { market, io: h.io, log };
    const rec = await market.installLocalDir(SOURCE);
    const out = await runUninstall(deps, { ...rec, id: '没装过的包' }, true);
    expect(out.kind).toBe('failed');
    expect(out.note).toContain('卸载没有成功');
    expect(warns.some((w) => /installed-missing/.test(w))).toBe(true);
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
    expect(html).toContain('刷新');
    expect(html).toContain('按包名或作者过滤');
    // 主行不许出现机器词（展开层是机器面，静态渲染里没有展开）
    for (const word of ['index.json', 'sha256', 'manifest', 'schema', 'kind', 'minAppVersion']) {
      expect(html, word).not.toContain(word);
    }
  });
});
