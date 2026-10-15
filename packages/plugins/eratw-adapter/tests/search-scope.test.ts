import { describe, expect, it } from 'vitest';
import type {
  CharaInfo,
  GameProject,
  PluginContext,
  SearchScopeContribution,
  SearchScopeOption,
} from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';
import { charaSearchScopeOptions } from '../src/search-scope';

/**
 * 检索范围提供方（C3 领域限定检索批）。
 *
 * 钉两件容易写歪的事：
 * 1. **判据只有一条**：范围 = `charaIndex[].kojoDir`，不解析文件名、不重算角色名单；
 * 2. **只认本项目**：`adapterId` 不是自己的 ⇒ 空候选（宿主据此不画选择器 = 新功能默认关）。
 */

const chara = (no: number, name: string, kojoDir?: string): CharaInfo =>
  kojoDir === undefined ? { no, name } : { no, name, kojoDir };

function projectWith(chars: readonly CharaInfo[], adapterId = 'eratw'): GameProject {
  const charaIndex = new Map<number, CharaInfo>();
  for (const c of chars) charaIndex.set(c.no, c);
  return {
    rootDir: '/game',
    adapterId,
    kojoPaths: ['/game/ERB/kojo'],
    writablePaths: [],
    charaIndex,
  } as unknown as GameProject;
}

describe('检索范围 · 纯投影（角色清单 → 候选）', () => {
  it('按编号升序出候选：标签 #编号 名字，检索根 = kojoDir 本身', () => {
    const options = charaSearchScopeOptions([
      chara(11, '雾雨 魔理沙', '/game/kojo/011 Marisa [魔理沙]'),
      chara(1, '博丽 灵梦', '/game/kojo/001 Reimu [霊夢]'),
    ]);
    expect(options.map((o: SearchScopeOption) => o.id)).toEqual(['chara:1', 'chara:11']);
    expect(options[0]!.label).toBe('#1 博丽 灵梦');
    expect(options[0]!.detail).toBe('001 Reimu [霊夢]');
    expect(options[0]!.roots).toEqual(['/game/kojo/001 Reimu [霊夢]']);
  });

  it('没有口上目录的角色不产候选（没有目录可限定，不猜一个根给他）', () => {
    expect(charaSearchScopeOptions([chara(7, '无目录角色')])).toEqual([]);
  });

  it('空名单 → 空候选（宿主据此整行不画）', () => {
    expect(charaSearchScopeOptions([])).toEqual([]);
  });
});

/* ------------------- 经槽位注册的真实提供方（接线面） ------------------- */

function activateScopeProvider(): SearchScopeContribution {
  const collected: SearchScopeContribution[] = [];
  const ctx = {
    pluginId: 'eratw-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus: { emit: () => {}, on: () => () => {} },
    onDispose: () => {},
    inject: <T,>(_key: string): T => ({ list: async () => [], projectDir: () => '/ws', current: () => null }) as T,
    slots: {
      register: (slot: string, item: SearchScopeContribution) => {
        if (slot === 'search.scope') collected.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  expect(collected).toHaveLength(1);
  return collected[0]!;
}

describe('检索范围 · search.scope 注册项', () => {
  it('本项目的角色目录 → 一条一个候选', () => {
    const contribution = activateScopeProvider();
    const project = projectWith([
      chara(1, '灵梦', '/game/kojo/001 Reimu'),
      chara(2, '魔理沙', '/game/kojo/011 Marisa'),
    ]);
    expect(contribution.provide(project).map((o) => o.roots)).toEqual([
      ['/game/kojo/001 Reimu'],
      ['/game/kojo/011 Marisa'],
    ]);
  });

  it('没开项目 / 不是本适配器的项目 → 空候选（不替他方编范围）', () => {
    const contribution = activateScopeProvider();
    expect(contribution.provide(null)).toEqual([]);
    const foreign = projectWith([chara(1, '灵梦', '/game/kojo/001 Reimu')], 'other-game');
    expect(contribution.provide(foreign)).toEqual([]);
  });
});
