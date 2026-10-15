import { describe, expect, it } from 'vitest';
import {
  MARKET_DIR_NAME,
  MARKET_SERVICE_KEY,
  join,
  type FileIO,
  type Logger,
  type MarketService,
  type PluginContext,
  type ScopedStorage,
} from '@kojo/plugin-api';
import { createKojoMarketPlugin } from '../src/index';

/** activate 的接线判据（假 io 记录调用顺序；落盘行为在 kernel/tests/integration-market.test.ts 里真跑） */

const APP_DATA = 'C:/Users/tester/AppData/Roaming/kojo-editor';
const MARKET_ROOT = join(APP_DATA, MARKET_DIR_NAME);

function recordingIo(): { io: FileIO; order: string[]; roots: string[] } {
  const order: string[] = [];
  const roots: string[] = [];
  const io = {
    appDataDir: async () => APP_DATA,
    ensureDir: async (p: string) => {
      order.push(`ensureDir:${p}`);
    },
    addAppWritableRoot: (r: string) => {
      roots.push(r);
      order.push(`addRoot:${r}`);
    },
    rename: async () => {
      throw new Error('activate 不该搬运');
    },
    removeDir: async () => {
      throw new Error('activate 不该删目录');
    },
    readText: async () => {
      throw new Error('activate 不该读盘');
    },
    writeBytes: async () => {
      throw new Error('activate 不该写盘');
    },
  } as unknown as FileIO;
  return { io, order, roots };
}

function fakeCtx(io: FileIO, storage: ScopedStorage): { ctx: PluginContext; provided: Map<string, unknown> } {
  const provided = new Map<string, unknown>();
  const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const ctx = {
    pluginId: 'kojo-market',
    log,
    storage,
    slots: { register: () => () => {}, query: () => [] },
    bus: { on: () => () => {}, emit: () => {}, once: () => () => {}, off: () => {} },
    inject: (key: string) => {
      if (key !== 'kernel.io') throw new Error(`unexpected hard dependency: ${key}`);
      return io;
    },
    provide: (key: string, value: unknown) => provided.set(key, value),
    tryInject: () => undefined,
    onDispose: () => {},
  } as unknown as PluginContext;
  return { ctx, provided };
}

function memStorage(): ScopedStorage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
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

describe('kojo-market activate', () => {
  it('插件形状：requires 只要 kernel.io，provides 只有 market.index，契约里没有的字段一个不自造', () => {
    const p = createKojoMarketPlugin({ appVersion: '0.4.0-beta.1' });
    expect(p.id).toBe('kojo-market');
    expect(p.requires).toEqual(['kernel.io']);
    expect(p.provides).toEqual([MARKET_SERVICE_KEY]);
    expect(Object.keys(p).sort()).toEqual(['activate', 'id', 'provides', 'requires', 'version']);
  });

  it('登记根先于建目录（顺序反了就是越权写），且只登记这一个根', async () => {
    const { io, order, roots } = recordingIo();
    const storage = memStorage();
    const { ctx, provided } = fakeCtx(io, storage);
    await createKojoMarketPlugin({ appVersion: '0.4.0-beta.1' }).activate!(ctx);

    expect(roots).toEqual([MARKET_ROOT]);
    expect(order).toEqual([`addRoot:${MARKET_ROOT}`, `ensureDir:${MARKET_ROOT}`]);
    const svc = provided.get(MARKET_SERVICE_KEY) as MarketService;
    expect(await svc.rootDir()).toBe(MARKET_ROOT);
    // activate 阶段零状态写入（状态住 ctx.storage，由装卸动作自己记）
    expect(storage.store.size).toBe(0);
  });
});
