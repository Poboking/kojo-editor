/**
 * 多游戏识别矩阵（**每个真实游戏盘恰好被一个适配器认出**）。
 *
 * 为什么需要这一道：内核在 `project.open()` 时轮询**全部**候选适配器，**多命中即抛
 * `AdapterConflictError`**（`packages/kernel/src/project.ts:80`）——也就是说「新接一个游戏」
 * 有两种炸法：① 新盘没人认（功能缺失，看得见）；② 新盘被两个适配器同时认（开不了工程，
 * 报错还不说是谁）。第 ② 种的引入路径通常是**新适配器的判据太宽**，或者**老适配器的判据
 * 本来就只钉了文件名没钉父目录**。2026-10-26 实测：eraAV 的主路由叫
 * `ERB/EVENT/EVENT_K.ERB`、eraAkumaMaid 的叫 `ERB/EVENT_K/EVENT_K.ERB`、eratohoReverse 的
 * 叫 `ERB/口上/EVENT_K.ERB`——**三份同名文件，只比文件名就是三个游戏互相串认**。
 *
 * 判据口径：
 * - 走**清单**（`ADAPTER_MANIFEST`）取适配器，不在测试里另写一份游戏名单——清单漏一个
 *   适配器，本闸就少测一枚，而清单本身另有 `adapter-manifest.test.ts` 双向自证；
 * - 每个盘只断言「命中的那一枚 == 期望 id」与「命中数 == 1」，不比对 detect 内部逻辑；
 * - 盘不在位 ⇒ 该盘整条 skip（跨主机 skipped 数会变，这是设计不是红）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FileIO, GameAdapter, PluginContext } from '@kojo/plugin-api';
import { ADAPTER_MANIFEST, createAdapterPlugin } from '../src/adapter-manifest';

/** 本机游戏盘根（与其它语料工具同一条默认：`C:/game`；别处用环境变量指） */
const GAME_ROOT = process.env['KOJO_GAME_ROOT'] ?? 'C:/game';

/** 盘 → 期望被哪一枚适配器认出（目录名就是本机实际盘面，缺失即 skip） */
const MATRIX: ReadonlyArray<{ dir: string; expect: string }> = [
  { dir: 'eraAV', expect: 'eraav' },
  { dir: 'eratohoReverse', expect: 'eratohoreverse' },
  { dir: 'eraFL', expect: 'erafl' },
  { dir: 'eraSQC', expect: 'erasqc' },
  { dir: 'eraAkumaMaid', expect: 'eraakumamaid' },
  { dir: 'eratw-画蛇添足版eratw4.980', expect: 'eratw' },
  { dir: 'eratw原生官方版4.842', expect: 'eratw' },
  { dir: 'eratw魔王改版', expect: 'eratw' },
];

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Node 只读真盘 FileIO（detect 只吃 exists / stat / readText，写方法不提供） */
function nodeIo(): FileIO {
  return {
    exists: async (path: string) => existsSync(path),
    stat: async (path: string) => {
      try {
        const s = statSync(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
      } catch {
        return null;
      }
    },
    listDir: async (path: string) =>
      readdirSync(path, { withFileTypes: true }).map((d) => ({
        name: d.name,
        path: join(path, d.name),
        isDirectory: d.isDirectory(),
      })),
    readText: async (path: string) => {
      const raw = readFileSync(path, 'utf8');
      const hadBom = raw.charCodeAt(0) === 0xfeff;
      const text = hadBom ? raw.slice(1) : raw;
      return {
        path,
        text,
        encoding: hadBom ? ('utf-8-bom' as const) : ('utf-8' as const),
        eol: text.includes('\r\n') ? ('crlf' as const) : ('lf' as const),
        mtimeMs: statSync(path).mtimeMs,
      };
    },
  } as unknown as FileIO;
}

/** 按清单把每一枚适配器取出来（`game.adapter` 槽位的注册者就是本闸要问的人） */
async function adaptersById(): Promise<Map<string, GameAdapter>> {
  const io = nodeIo();
  const out = new Map<string, GameAdapter>();
  for (const entry of ADAPTER_MANIFEST) {
    // eraTW 是 `scope:'boot'` 常驻项（清单注释写明它不走懒登记路），这里按同一口径静态取
    const mod = entry.load ? await entry.load() : await import('@kojo/plugin-eratw-adapter');
    let adapter: GameAdapter | undefined;
    const ctx = {
      pluginId: entry.dir,
      log: silentLog,
      onDispose: () => {},
      provide: () => {},
      bus: { emit: () => {}, on: () => () => {} },
      tryInject: () => undefined,
      inject: <T,>(key: string): T => {
        if (key === 'kernel.io') return io as unknown as T;
        // eraTW 那枚（`scope:'boot'`）在 activate 里硬取这两把服务；本闸只跑 `detect`，
        // 桩给到「能装配、不干活」即可——空工作区 + 无当前项目，与打开任何一盘都无关
        if (key === 'kernel.workspaces') {
          return { list: async () => [], projectDir: (id: string) => `/ws/${id}` } as unknown as T;
        }
        if (key === 'kernel.project') return { current: () => null } as unknown as T;
        throw new Error(`unexpected inject: ${key}`);
      },
      slots: {
        register: (slot: string, item: unknown) => {
          if (slot === 'game.adapter') adapter = (item as { adapter: GameAdapter }).adapter;
          return () => {};
        },
      },
    } as unknown as PluginContext;
    createAdapterPlugin(entry, mod as Record<string, unknown>).activate(ctx);
    if (!adapter) throw new Error(`${entry.id} 没有注册 game.adapter 槽位`);
    out.set(entry.id, adapter);
  }
  return out;
}

describe('多游戏识别矩阵 · 每个盘恰好一个适配器命中', () => {
  const present = MATRIX.map((row) => ({ ...row, root: `${GAME_ROOT}/${row.dir}` })).filter(
    (row) => existsSync(row.root),
  );

  let adapters: Map<string, GameAdapter> = new Map();
  beforeAll(async () => {
    adapters = await adaptersById();
    // 29 枚逐个动态 import + activate，满载机上会贴到默认 10s 线（实测 10.04s）
  }, 60000);

  it('清单里每一枚适配器都取得了 `game.adapter`（漏一枚＝这闸少测一枚）', () => {
    expect(adapters.size).toBe(ADAPTER_MANIFEST.length);
    for (const entry of ADAPTER_MANIFEST) expect(adapters.has(entry.id), entry.id).toBe(true);
  });

  for (const row of present) {
    it(`${row.dir} → 只被 ${row.expect} 认出`, async () => {
      const hits: string[] = [];
      for (const [id, adapter] of adapters) {
        // 契约是 `boolean | AdapterDetection`（新家是对象形态、带 evidence）——
        // 直接把返回值当真假判会把「所有人」都算成命中，这正是要防的判错方式
        const r = await adapter.detect(row.root);
        if (typeof r === 'boolean' ? r : r.matched) hits.push(id);
      }
      // 多命中＝内核开工程时抛 AdapterConflictError 的那一族；这里先一步在测试里钉死
      expect(hits, `命中者：${hits.join(', ') || '（无人认出）'}`).toEqual([row.expect]);
    });
  }

  it('盘全部缺席时不许变成空过（至少要有一盘在位）', () => {
    expect(
      present.length,
      `${GAME_ROOT} 下没有任何一盘矩阵语料；本闸需要真实盘才成立（跨机可设 KOJO_GAME_ROOT）`,
    ).toBeGreaterThan(0);
  });
});
