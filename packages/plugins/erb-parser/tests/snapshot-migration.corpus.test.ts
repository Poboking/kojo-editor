/**
 * 快照 **v17 → v18 代际迁移** · 真语料读数（`KOJO_CORPUS_DIR` / `KOJO_SMOKE_PROJECT` 守门）。
 *
 * 为什么单独一个文件：`references.corpus.test.ts` 走 `service.buildIndex` 的**强制重建**路径，
 * 天然不碰快照；而"旧盘复用时两条引用腿会不会被重扫"只能由 `project.opened` 那条装配验。
 * 2026-11-05 首版把「真语料 v16 盘迁移读数」写成没量（要真壳冷开），本文件把这一格补上：
 * 同一份真盘、同一个进程、**同一份内存存储域**里跑三轮（冷建 → 改写成 v17 盘 → 迁移 → 纯热），
 * 读数全部取自插件自己打的 breakdown 行，不靠人复述。
 *
 * 断言只钉方向与正确性，不钉绝对耗时（跨机器会整体漂）：
 * - 冷建规模必须够大（否则这份"真语料"没读到位）；
 * - 迁移轮**结构全复用**（salvaged / reused === 全树），**两条引用腿全重扫**
 *   （溯源补正 / refs rescan === 全树）——这是代际门的契约；
 * - 迁移后的索引与冷建逐项等价（含 `dimReferences`），说明旧流水没有留下来；
 * - 下一轮纯热：零补正、零重扫。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbIndex, ErbParserService, FileIO, GameProject, ScopedStorage } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { createErbParserPlugin } from '../src/plugin';
import { SNAPSHOT_VERSION, snapshotKeyFor } from '../src/snapshot';
import { makeComputeStub } from './support';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const ROOT = SMOKE ?? 'D:/__corpus_absent__';
const KOJO = SMOKE === undefined ? '' : join(SMOKE, 'ERB', '口上・メッセージ関連', '個人口上');
const V17_KEY = snapshotKeyFor(ROOT, 17);
const CUR_KEY = snapshotKeyFor(ROOT);

function makeStorage(): { storage: ScopedStorage; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      get: async <T = unknown>(key: string) => {
        const raw = map.get(key);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      },
      set: async (key: string, value: unknown) => void map.set(key, JSON.stringify(value)),
      delete: async (key: string) => void map.delete(key),
      keys: async () => [...map.keys()],
    } as ScopedStorage,
  };
}

function activate(io: FileIO, storage: ScopedStorage, logs: string[]) {
  const provided = new Map<string, unknown>();
  const handlers = new Map<string, Set<(p: never) => void>>();
  const bus = {
    on(type: string, h: (p: never) => void) {
      let s = handlers.get(type);
      if (s === undefined) handlers.set(type, (s = new Set()));
      s.add(h);
      return () => s!.delete(h);
    },
    emit(type: string, payload: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload as never);
    },
  };
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug() {}, info: (m: string) => logs.push(m), warn() {}, error() {} },
    bus,
    storage,
    inject: (key: string) => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.compute') return makeComputeStub();
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
    provide: (key: string, value: unknown) => void provided.set(key, value),
  };
  createErbParserPlugin().activate(ctx as never);
  const service = provided.get('erb.parser') as ErbParserService;
  const waitIndexed = (timeoutMs = 300_000): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), timeoutMs);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return { service, bus, waitIndexed };
}

const open = (bus: { emit: (t: string, p: unknown) => void }): void => {
  bus.emit('project.opened', {
    project: {
      rootDir: ROOT,
      adapterId: 'eratw',
      kojoPaths: [KOJO],
      libraryPaths: [],
      writablePaths: [],
      charaIndex: new Map(),
    } as unknown as GameProject,
  });
};

/** 插件自己打的三行读数（不靠人复述） */
function readings(logs: readonly string[]): {
  total: number;
  reused: number;
  salvaged: number;
  skipped: number;
  provenance: number;
  refsRescan: number;
  refsScanMs: number;
  wallMs: number;
} {
  const text = logs.join('\n');
  const reused = /reused (\d+)\/(\d+)/.exec(text);
  const salv = /index salvage: (\d+)\/\d+ \(丢 (\d+), 溯源补正 (\d+)/.exec(text);
  const refs = /refs scan (\d+)ms \(rescan (\d+), aggregate deferred\)/.exec(text);
  const wall = /in (\d+)ms/.exec(text);
  if (!reused || !salv || !refs || !wall) throw new Error(`读数行形状不符：${text.slice(0, 600)}`);
  return {
    total: Number(reused[2]),
    reused: Number(reused[1]),
    salvaged: Number(salv[1]),
    skipped: Number(salv[2]),
    provenance: Number(salv[3]),
    refsRescan: Number(refs[2]),
    refsScanMs: Number(refs[1]),
    wallMs: Number(wall[1]),
  };
}

async function waitFor(pick: () => boolean, rounds = 4000): Promise<void> {
  for (let i = 0; i < rounds && !pick(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pick()).toBe(true);
}

const dimShapeOf = (idx: ErbIndex): string =>
  JSON.stringify([...(idx.dimReferences?.byName.entries() ?? [])].map(([n, list]) => [n, list.length]));

describe.skipIf(!SMOKE)('快照 v17 → v18 代际迁移 · 真语料', () => {
  it(
    '冷建 → 旧盘迁移（结构全复用 / 两条引用腿全重扫）→ 纯热，三轮读数自证',
    async () => {
      const store = makeStorage();
      const ioOf = (): FileIO => new FileIOServiceImpl(new NodeBridge(SMOKE!)) as unknown as FileIO;

      // 轮 1：真冷建，落当前版本盘
      const logs1: string[] = [];
      const a1 = activate(ioOf(), store.storage, logs1);
      const t1 = performance.now();
      open(a1.bus);
      await a1.waitIndexed();
      const coldMs = performance.now() - t1;
      await waitFor(() => store.map.has(CUR_KEY));
      const cold = readings(logs1);

      // 真实的 v17 盘：条目形态与 v18 逐字相同（都是 12 位），只换信封版本与存储键
      const payload = JSON.parse(store.map.get(CUR_KEY)!) as Record<string, unknown>;
      store.map.delete(CUR_KEY);
      store.map.set(V17_KEY, JSON.stringify({ ...payload, version: 17 }));

      // 轮 2：代际迁移
      const logs2: string[] = [];
      const a2 = activate(ioOf(), store.storage, logs2);
      const t2 = performance.now();
      open(a2.bus);
      await a2.waitIndexed();
      const migrationMs = performance.now() - t2;
      const mig = readings(logs2);
      await waitFor(
        () => store.map.has(CUR_KEY) && (JSON.parse(store.map.get(CUR_KEY)!) as { version: number }).version === SNAPSHOT_VERSION,
      );

      // 轮 3：纯热
      const logs3: string[] = [];
      const a3 = activate(ioOf(), store.storage, logs3);
      const t3 = performance.now();
      open(a3.bus);
      await a3.waitIndexed();
      const hotMs = performance.now() - t3;
      const hot = readings(logs3);

      console.log(
        `[snapshot-migration] 真语料 ${cold.total} 文件：冷建 ${coldMs.toFixed(0)}ms（refs ${cold.refsScanMs}ms）` +
          ` · v17→v18 迁移 ${migrationMs.toFixed(0)}ms（salvage ${mig.salvaged}/${cold.total}, reused ${mig.reused},` +
          ` 丢 ${mig.skipped}, 溯源补正 ${mig.provenance}, refs rescan ${mig.refsRescan}/${cold.total}, refs 段 ${mig.refsScanMs}ms）` +
          ` · 纯热 ${hotMs.toFixed(0)}ms（补正 ${hot.provenance}, rescan ${hot.refsRescan}, refs 段 ${hot.refsScanMs}ms）`,
      );

      expect(cold.total).toBeGreaterThan(1000); // 这份真语料确实读到位了
      expect(mig.salvaged).toBe(cold.total); // 结构 / 定义 / 候选一条不丢
      expect(mig.skipped).toBe(0);
      expect(mig.reused).toBe(cold.total);
      expect(mig.provenance).toBe(cold.total); // 函数引用腿整树重扫
      expect(mig.refsRescan).toBe(cold.total); // 变量引用腿整树重扫
      expect(hot.provenance).toBe(0); // 代际门只咬一次
      expect(hot.refsRescan).toBe(0);

      const coldIdx = a1.service.currentIndex()!;
      const migIdx = a2.service.currentIndex()!;
      expect(migIdx.files.size).toBe(coldIdx.files.size);
      expect(migIdx.byName.size).toBe(coldIdx.byName.size);
      expect(dimShapeOf(migIdx)).toBe(dimShapeOf(coldIdx)); // 旧 dimRefs 没有留下来
    },
    600_000,
  );
});
