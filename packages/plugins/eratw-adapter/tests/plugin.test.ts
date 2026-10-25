import { describe, expect, it } from 'vitest';
import type { FileIO, GameAdapter, GameAdapterContribution, PluginContext } from '@kojo/plugin-api';
import { normalizeAdapterDetection } from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';

/** 伪文件树：记录目录（值 'DIR'）与文本文件（值 = 内容） */
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
    /** 批量读（FileIO 契约成员；字典的两条读循环走这里）：失败位 = null，不整批抛 */
    async readTexts(ps: readonly string[]) {
      return ps.map((p) => {
        const text = tree[p];
        return typeof text === 'string'
          ? { path: p, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null }
          : null;
      });
    },
  } as unknown as FileIO;
}

function activate(io: FileIO): { adapter: GameAdapter; registrations: GameAdapterContribution[]; warns: string[] } {
  const registrations: GameAdapterContribution[] = [];
  const warns: string[] = [];
  const ctx = {
    pluginId: 'eratw-adapter',
    log: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: (m: string) => warns.push(m),
    },
    bus: { emit: () => {}, on: () => () => {} },
    onDispose: () => {},
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      // 口上项目面板依赖（P-B）：本测试只关心 adapter，给最小伪实现
      if (key === 'kernel.workspaces') {
        return {
          list: async () => [],
          projectDir: (id: string) => `/ws/${id}`,
        } as unknown as T;
      }
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: GameAdapterContribution) => {
        // P-B 起另有 ui.panel 贡献；本测试只收集 adapter 槽
        if (slot === 'game.adapter') registrations.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return { adapter: registrations[0]!.adapter, registrations, warns };
}

const ROOT = '/game';

function standardTree(): Tree {
  return {
    [`${ROOT}/ERB/口上・メッセージ関連`]: 'DIR',
    [`${ROOT}/ERB/口上・メッセージ関連/個人口上`]: 'DIR',
    [`${ROOT}/CSV/Chara`]: 'DIR',
    [`${ROOT}/CSV/Chara/Chara1 霊夢.csv`]: '番号,1,\n名前,博丽 灵梦,\n呼び名,灵梦,\n',
    [`${ROOT}/CSV/Chara/Chara11 魔理沙.csv`]: '番号,11,\n名前,雾雨 魔理沙,\n呼び名,魔理沙,\n',
    [`${ROOT}/CSV/Chara/Chara26 紫.csv`]: '名前,八云紫,\n', // 缺番号 → 文件名回退
    [`${ROOT}/ERB/口上・メッセージ関連/個人口上/001 Reimu [霊夢]`]: 'DIR',
    [`${ROOT}/ERB/口上・メッセージ関連/個人口上/011 Marisa [魔理沙]`]: 'DIR',
    [`${ROOT}/ERB/口上・メッセージ関連/個人口上/099 Ghost [幽霊]`]: 'DIR', // CSV 无此编号 → 补录
    [`${ROOT}/sav`]: 'DIR',
  };
}

describe('eraTW adapter · detect', () => {
  it('特征目录齐备 → true', async () => {
    const { adapter } = activate(fakeIO(standardTree()));
    expect(normalizeAdapterDetection(await adapter.detect(ROOT)).matched).toBe(true);
  });

  it('缺口上域目录 → false', async () => {
    const tree = standardTree();
    delete tree[`${ROOT}/ERB/口上・メッセージ関連`];
    const { adapter } = activate(fakeIO(tree));
    expect(normalizeAdapterDetection(await adapter.detect(ROOT)).matched).toBe(false);
  });

  it('缺 CHARA CSV 目录 → false', async () => {
    const tree = standardTree();
    delete tree[`${ROOT}/CSV/Chara`];
    const { adapter } = activate(fakeIO(tree));
    expect(normalizeAdapterDetection(await adapter.detect(ROOT)).matched).toBe(false);
  });
});

describe('eraTW adapter · loadProject', () => {
  it('解析 CHARA 映射 + 绑定口上目录 + 提议可写路径', async () => {
    const { adapter } = activate(fakeIO(standardTree()));
    const project = await adapter.loadProject(ROOT);

    expect(project.adapterId).toBe('eratw');
    expect(project.kojoPaths).toEqual(['/game/ERB/口上・メッセージ関連/個人口上']);
    expect(project.savDir).toBe('/game/sav');
    expect(project.writablePaths).toEqual([
      '/game/ERB/口上・メッセージ関連/個人口上',
      '/game/sav', // v0.2 第十五批：注入器写档需要
    ]);

    const reimu = project.charaIndex.get(1);
    expect(reimu?.name).toBe('博丽 灵梦');
    expect(reimu?.callName).toBe('灵梦');
    expect(reimu?.kojoDir).toContain('001 Reimu');

    // 缺番号 → 文件名回退
    expect(project.charaIndex.get(26)?.name).toBe('八云紫');

    // CSV 无编号 99 → 从口上目录补录（不静默丢弃）
    expect(project.charaIndex.get(99)?.kojoDir).toContain('099 Ghost');
    expect(project.charaIndex.get(99)?.name).toBe('Ghost [幽霊]');
  });

  it('inputDigest 覆盖非 ERB 输入：同树稳定，改 CSV / 改角色目录名都变', async () => {
    // 派生缓存（条件抽取 / 约定校验）的判据只看 ERB 体量指纹是不够的：
    // 变量字典与 charaIndex 都来自 CSV，改一行描述必须让缓存失效。
    const load = (tree: Tree) => activate(fakeIO(tree)).adapter.loadProject(ROOT);
    const a = await load(standardTree());
    const b = await load(standardTree());
    const csvChanged = standardTree();
    csvChanged[`${ROOT}/CSV/CFLAG.csv`] = '2,心情\n4,信頼度\n';
    const dirChanged = standardTree();
    dirChanged[`${ROOT}/ERB/口上・メッセージ関連/個人口上/001 Reimu X`] = 'DIR';

    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(await load(csvChanged).then((p) => p.inputDigest)).not.toBe(a.inputDigest);
    expect(await load(dirChanged).then((p) => p.inputDigest)).not.toBe(a.inputDigest);
  });

  it('口上目录名不合约定 → 警告且跳过', async () => {
    const tree = standardTree();
    tree[`${ROOT}/ERB/口上・メッセージ関連/個人口上/weird_name`] = 'DIR';
    const { adapter, warns } = activate(fakeIO(tree));
    const project = await adapter.loadProject(ROOT);
    expect(warns.some((w) => w.includes('weird_name'))).toBe(true);
    expect([...project.charaIndex.values()].some((c) => c.kojoDir?.includes('weird_name'))).toBe(false);
  });

  it('纯角色名目录（无编号）→ 按文件名 M_KOJO_K{no} 回退绑定', async () => {
    const tree = standardTree();
    tree[`${ROOT}/ERB/口上・メッセージ関連/個人口上/阿燐`] = 'DIR';
    tree[`${ROOT}/ERB/口上・メッセージ関連/個人口上/阿燐/M_KOJO_K36_コマンド.ERB`] =
      '@M_KOJO_K36_コマンド\nPRINTL にゃー\n';
    tree[`${ROOT}/ERB/口上・メッセージ関連/個人口上/阿燐/M_KOJO_K36.ERH`] = '';
    const { adapter } = activate(fakeIO(tree));
    const project = await adapter.loadProject(ROOT);
    const orin = project.charaIndex.get(36);
    expect(orin?.kojoDir).toContain('阿燐');
    expect(orin?.name).toBe('阿燐');
    // 编号目录行为不变
    expect(project.charaIndex.get(1)?.kojoDir).toContain('001 Reimu');
  });

  it('纯名目录内无 M_KOJO_K 文件 → 仍警告且跳过', async () => {
    const tree = standardTree();
    tree[`${ROOT}/ERB/口上・メッセージ関連/個人口上/无名角色`] = 'DIR';
    tree[`${ROOT}/ERB/口上・メッセージ関連/個人口上/无名角色/杂项.ERB`] = 'PRINTL x\n';
    const { adapter, warns } = activate(fakeIO(tree));
    const project = await adapter.loadProject(ROOT);
    expect(warns.some((w) => w.includes('无名角色'))).toBe(true);
    expect([...project.charaIndex.values()].some((c) => c.kojoDir?.includes('无名角色'))).toBe(false);
  });

  it('注册到 game.adapter 槽位（onboarding 轮询依据）', () => {
    const { registrations } = activate(fakeIO(standardTree()));
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.adapter.gameId).toBe('eratw');
  });

  it('插件声明：id / requires kernel.io / 不占用全局服务键（ADR-0002）', () => {
    const plugin = createEratwAdapterPlugin();
    expect(plugin.id).toBe('eratw-adapter');
    expect(plugin.requires).toContain('kernel.io');
    expect(plugin.provides ?? []).toHaveLength(0);
  });
});
