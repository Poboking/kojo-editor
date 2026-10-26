/**
 * eraAV 的角色级检索范围（`search.scope`）——**本作唯一的"按角色收窄"通道**。
 *
 * 钉死三件事（都是真盘量出来的）：
 * ① 候选 = **17 条**（一份口上文件一条），103 个没有口上文件的角色**一条都不产**；
 * ② 每条的 `roots` 是**存在的单个文件**（不是目录）——契约「文件根只产出它自己」
 *    （`plugin-api/src/slots.ts:1438-1444`），收窄侧与 Rust 侧的逐环节复验见 `src/search-scope.ts` 头注；
 * ③ `CharaInfo.kojoDir` 对全部 120 个角色**仍然一律不设**（设了就等于把整棵 `ERB/Lines`
 *    冒充成某个角色的目录，`ownerNoOfPath` 的最长根裁决会塌成"整树归一个人"，
 *    判据出处 `docs/PITFALLS.md` 229）——这条不许被"顺手补上"。
 */

import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CharaInfo, SearchScopeContribution, SearchScopeOption } from '@kojo/plugin-api';
import { isPathUnder, join } from '@kojo/plugin-api';
import { eraavSearchScopeOptions } from '../src/search-scope';
import { GAME_ROOT, activateAdapter, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const KOJO = join(GAME_ROOT, 'ERB', 'Lines');

function chara(no: number, name: string, kojoDir?: string): CharaInfo {
  return kojoDir === undefined ? { no, name } : { no, name, kojoDir };
}

describe('eraavSearchScopeOptions（纯函数）', () => {
  it('只给"有口上文件的角色"产候选；按号升序；id/label/roots 三项口径固定', () => {
    const options = eraavSearchScopeOptions(
      [chara(5, '渡来桔梗'), chara(1, '宫间奏美'), chara(7, '无口上的角色')],
      [
        { no: 5, path: `${KOJO}/EVENT_K05_渡会桔梗.ERB`, label: '渡会桔梗' },
        { no: 1, path: `${KOJO}/EVENT_K01_宮間かなで.ERB`, label: '宮間かなで' },
      ],
    );
    expect(options.map((o) => o.id)).toEqual(['chara:1', 'chara:5']);
    expect(options.map((o) => o.label)).toEqual(['#1 宫间奏美', '#5 渡来桔梗']);
    expect(options.map((o) => o.roots.length)).toEqual([1, 1]);
    expect(options[0]!.detail).toBe('EVENT_K01_宮間かなで.ERB');
  });

  it('CSV 里查不到的号也不丢候选（标签兜底用文件名段），且绝不读盘', () => {
    const options = eraavSearchScopeOptions([], [{ no: 45, path: `${KOJO}/EVENT_K45_三好ゆか子.ERB`, label: '三好ゆか子' }]);
    expect(options).toEqual([
      {
        id: 'chara:45',
        label: '#45 三好ゆか子',
        detail: 'EVENT_K45_三好ゆか子.ERB',
        roots: [`${KOJO}/EVENT_K45_三好ゆか子.ERB`],
      } satisfies SearchScopeOption,
    ]);
  });

  it('空清单（未加载 / 域不可读）→ 空数组，宿主据此不画选择器', () => {
    expect(eraavSearchScopeOptions([chara(1, '甲')], [])).toEqual([]);
  });
});

describe('插件接线（与组合根同一条路径）', () => {
  it('注册的槽位是 search.scope，且只认 eraAV 项目', () => {
    const { slots } = activateAdapter(nodeIo());
    const scope = slots.find((s) => s.slot === 'search.scope');
    expect(scope, 'eraAV 没注册 search.scope').toBeDefined();
    expect(scope!.item).toMatchObject({ id: 'eraav-chara-scope', order: 10 });
    const contribution = scope!.item as SearchScopeContribution;
    // 非本适配器的项目 / 没有项目 ⇒ 一律空数组（零 IO，不猜）
    expect(contribution.provide(null)).toEqual([]);
    expect(
      contribution.provide({
        rootDir: GAME_ROOT,
        adapterId: 'eratw',
        kojoPaths: [],
        writablePaths: [],
        charaIndex: new Map(),
      }),
    ).toEqual([]);
  });

  it.skipIf(!hasCorpus)(
    '真盘：17 条候选（每根都是存在的**文件**、都在口上域内）、id 唯一、103 个无口上的角色不出现，120 个角色一律无 kojoDir',
    async () => {
      // 同一次激活里先 loadProject 再 provide：`kojoScan` 是这台适配器实例的状态（闭包），
      // 另起一个实例取到的会是"还没加载过"的那份 ⇒ 恒空。
      const { adapter, slots } = activateAdapter(nodeIo());
      const project = await adapter.loadProject(GAME_ROOT);
      const contribution = slots.find((s) => s.slot === 'search.scope')!
        .item as SearchScopeContribution;
      const options = contribution.provide(project);

      // ① 候选数 = 口上文件数 = 17（本盘 120 个角色里 103 个没有口上文件 ⇒ 不产候选）
      expect(options).toHaveLength(17);
      expect(project.charaIndex.size).toBe(120);
      expect(new Set(options.map((o) => o.id)).size).toBe(17);
      expect(options.map((o) => o.id)).toEqual([...options.map((o) => o.id)].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))));

      // ② 每个根：存在、是文件（不是目录）、且落在口上域内
      for (const o of options) {
        expect(o.roots, o.id).toHaveLength(1);
        const root = o.roots[0]!;
        expect(existsSync(root), root).toBe(true);
        expect(statSync(root).isFile(), root).toBe(true);
        expect(isPathUnder(KOJO, root), root).toBe(true);
        expect(o.label.startsWith(`#${o.id.slice('chara:'.length)} `)).toBe(true);
      }

      // ③ 没口上文件的角色不出现；有口上的 17 个号都在，且全部角色一律不带 kojoDir
      const nos = new Set(options.map((o) => Number(o.id.slice('chara:'.length))));
      expect([...nos].sort((a, b) => a - b)).toEqual([1, 5, 10, 12, 17, 22, 29, 30, 33, 38, 39, 45, 80, 87, 88, 89, 97]);
      for (const [no, info] of project.charaIndex) {
        expect(info.kojoDir, `kojoDir 不许出现在 ${no} 号身上`).toBeUndefined();
      }
    },
  );
});
