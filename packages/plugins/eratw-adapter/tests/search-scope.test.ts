import { describe, expect, it } from 'vitest';
import type { CharaInfo, GameProject, PluginContext, SearchScopeContribution } from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';

/**
 * 检索范围 · **接线面**（2026-10-19 AM-1 P5 批拆分）。
 *
 * 纯投影（角色清单 → 候选）的判据已上移到 `@kojo/kojo-project-kit`，其单测在那边；
 * 本文件只钉本 adapter 自己那半句——**只认本项目**（`adapterId` 不是自己的 ⇒ 空候选
 * ⇒ 宿主不画选择器 = 新功能默认关）。这一句是宿主组合根职责，不属共享层。
 *
 * 为什么拆：搬走判据不等于搬走接线。两个 adapter 各注册一个 `search.scope` 贡献，
 * 谁该在什么项目下出候选，是各游戏自己的事。
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

function activateScopeProvider(): SearchScopeContribution {
  const collected: SearchScopeContribution[] = [];
  const ctx = {
    pluginId: 'eratw-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus: { emit: () => {}, on: () => () => {} },
    onDispose: () => {},
    inject: <T,>(_key: string): T =>
      ({ list: async () => [], projectDir: () => '/ws', current: () => null }) as T,
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
