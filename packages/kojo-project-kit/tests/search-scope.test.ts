import { describe, expect, it } from 'vitest';
import type { CharaInfo, SearchScopeOption } from '@kojo/plugin-api';
import { charaSearchScopeOptions } from '../src/search-scope';

/**
 * 检索范围提供方（C3 领域限定检索批；2026-10-19 AM-1 P5 批搬到共享包）。
 *
 * 钉两件容易写歪的事：
 * 1. **判据只有一条**：范围 = `charaIndex[].kojoDir`，不解析文件名、不重算角色名单；
 * 2. **空输入不猜**：没有目录的角色 / 空名单一律不产候选（宿主据此整行不画）。
 *
 * 「只认本项目」那一条（`adapterId` 过滤）**不在这里**——它是各 adapter 的接线面，
 * 判据属宿主组合根而非共享层。两边各有一份（`eratw-adapter` / `eraakumamaid-adapter`
 * 的 `tests/search-scope.test.ts`）。
 */

const chara = (no: number, name: string, kojoDir?: string): CharaInfo =>
  kojoDir === undefined ? { no, name } : { no, name, kojoDir };

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
