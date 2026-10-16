import { describe, expect, it } from 'vitest';
import type { FileIO, GameAdapter, GameAdapterContribution, InstalledPack, MarketService, PluginContext } from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';

/**
 * 市场 → 适配器装配接线（KM-15），测试**加载那一刻的惰性取服务**：
 * - 字典包（`kind === 'dict-pack'`）的 contentDir 作为变量字典第三轮输入并入；
 * - 非字典包不看；
 * - 市场缺席 / `installed()` 抛错 ⇒ 优雅降级（项目照常加载，warn 出声），
 *   字典与历史（无市场）逐字一致。
 *
 * fake io 照 `plugin.test.ts` 的既有伪文件树（值 = 内容 / 'DIR'）。
 */

type Tree = Record<string, 'DIR' | string>;

function fakeIO(tree: Tree): FileIO {
  return {
    async exists(p: string) {
      return p in tree;
    },
    async listDir(dir: string) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        if (out.some((x) => x.name === name)) continue;
        out.push({
          name,
          path: `${prefix}${name}`,
          isDirectory: tree[`${prefix}${name}`] === 'DIR' || rest.includes('/'),
        });
      }
      return out;
    },
    async readText(p: string) {
      const text = tree[p];
      if (typeof text !== 'string') throw new Error(`not a file: ${p}`);
      return { path: p, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
  } as unknown as FileIO;
}

const ROOT = '/game';
const DICT_DIR = '/appdata/market/packs/dict-pack/demo.lang/1.0.0/files';

function gameTree(): Tree {
  return {
    [`${ROOT}/ERB/口上・メッセージ関連`]: 'DIR',
    [`${ROOT}/ERB/口上・メッセージ関連/個人口上`]: 'DIR',
    [`${ROOT}/ERB/口上・メッセージ関連/個人口上/001 Reimu [霊夢]`]: 'DIR',
    [`${ROOT}/CSV/Chara`]: 'DIR',
    [`${ROOT}/CSV/Chara/Chara1 霊夢.csv`]: '番号,1,\n名前,博丽 灵梦,\n',
    [`${ROOT}/CSV/ABILITY.csv`]: '1,力量\n2,敏捷\n',
    [`${ROOT}/sav`]: 'DIR',
  };
}

const installed = (kind: InstalledPack['kind'], id: string, version: string): InstalledPack => ({
  kind,
  id,
  version,
  name: id,
  author: '某作者',
  license: 'MIT',
  contentDigest: 'x'.repeat(8),
  installedAt: 1,
  files: [],
});

function fakeMarket(opts: { records?: InstalledPack[]; installedThrows?: boolean } = {}): MarketService {
  return {
    installed: async () => {
      if (opts.installedThrows) throw new Error('模拟市场读取失败');
      return opts.records ?? [];
    },
    contentDir: async (kind: string, id: string, version: string) =>
      `/appdata/market/packs/${kind}/${id}/${version}/files`,
  } as unknown as MarketService;
}

function activate(io: FileIO, market: MarketService | null): { adapter: GameAdapter; warns: string[]; infos: string[] } {
  const registrations: GameAdapterContribution[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const ctx = {
    pluginId: 'eratw-adapter',
    log: {
      debug: () => {},
      info: (m: string) => infos.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => warns.push(m),
    },
    bus: { emit: () => {}, on: () => () => {} },
    onDispose: () => {},
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') {
        return { list: async () => [], projectDir: (id: string) => `/ws/${id}` } as unknown as T;
      }
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    tryInject: <T,>(key: string): T | undefined => (key === 'market' ? (market as unknown as T) : undefined),
    slots: {
      register: (slot: string, item: GameAdapterContribution) => {
        if (slot === 'game.adapter') registrations.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return { adapter: registrations[0]!.adapter, warns, infos };
}

describe('eraTW adapter · 市场字典包接线（KM-15）', () => {
  it('已装字典包：contentDir 里的名表以 append 源并入变量字典；非字典包不看', async () => {
    const tree = gameTree();
    tree[`${DICT_DIR}/ABILITY.csv`] = '3,幸运\n';
    // 口上包的 contentDir 即使被列了也不该被读（kind 过滤）——放一个会污染字典的表作反例
    tree['/appdata/market/packs/kojo-pack/demo.kojo/1.0.0/files/ABILITY.csv'] = '99,不该进来\n';

    const { adapter } = activate(fakeIO(tree), fakeMarket({
      records: [installed('kojo-pack', 'demo.kojo', '1.0.0'), installed('dict-pack', 'demo.lang', '1.0.0')],
    }));
    await adapter.loadProject(ROOT);

    expect(adapter.variableSchema?.lookup('ABILITY', '幸运')).toEqual({
      name: 'ABILITY',
      index: '幸运',
      description: '幸运',
      resolvedIndex: 3,
      source: 'append',
    });
    // 主表逐字不变；口上包目录一个字都没读
    expect(adapter.variableSchema?.lookup('ABILITY', 2)?.description).toBe('敏捷');
    expect(adapter.variableSchema?.lookup('ABILITY', 99)).toEqual({ name: 'ABILITY', index: 99 });
  });

  it('市场缺席（tryInject 无值）：字典与历史一致，日志零新增', async () => {
    const tree = gameTree();
    tree[`${DICT_DIR}/ABILITY.csv`] = '3,幸运\n'; // 盘上有，但没人把服务交出来

    const { adapter, infos } = activate(fakeIO(tree), null);
    await adapter.loadProject(ROOT);

    expect(adapter.variableSchema?.lookup('ABILITY', 2)?.description).toBe('敏捷');
    expect(adapter.variableSchema?.lookup('ABILITY', '幸运')).toEqual({ name: 'ABILITY', index: '幸运' });
    expect(infos.some((m) => m.includes('市场'))).toBe(false);
  });

  it('已装记录为空数组：与"无字典包"同义（零新增日志）', async () => {
    const { adapter, infos } = activate(fakeIO(gameTree()), fakeMarket({ records: [] }));
    await adapter.loadProject(ROOT);
    expect(adapter.variableSchema?.lookup('ABILITY', 2)?.description).toBe('敏捷');
    expect(infos.some((m) => m.includes('市场'))).toBe(false);
  });

  it('市场读取抛错：warn 出声并按"无市场"降级，项目加载不挂', async () => {
    const { adapter, warns } = activate(fakeIO(gameTree()), fakeMarket({ installedThrows: true }));
    const project = await adapter.loadProject(ROOT);

    expect(project.charaIndex.get(1)?.name).toBe('博丽 灵梦'); // 项目照常加载
    expect(adapter.variableSchema?.lookup('ABILITY', 2)?.description).toBe('敏捷'); // 游戏主表照常
    expect(warns.some((w) => w.includes('市场字典包目录收集失败'))).toBe(true);
  });
});
