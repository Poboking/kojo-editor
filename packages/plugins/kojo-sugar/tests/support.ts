/**
 * 测试共享夹具（kojo-sugar 测试专用）。
 *
 * **游戏知识只允许出现在测试里**：生产路径的分野模板与变量字典都由
 * `game.adapter` 槽位注入（见 `src/index.ts` 的 `dictionaryOf` / `faceTableOf`）。
 * 测试直接用 eraTW adapter 导出的真实表——这既让断言贴近生产，
 * 又符合解耦审计 C 项对 `tests/` 的豁免（测试可跨包 import）。
 */

import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import type { KojoFaceTable } from '@kojo/plugin-api';
import type { DictionaryLookup } from '../src/types';

/** 测试用最小字典（覆盖 golden 用到的 胆怯 / 恋慕 / 思慕 / 好感度 / 心情 + 原生族名） */
export const stubDict: DictionaryLookup = {
  resolveFamily(name: string) {
    if (name === '胆怯' || name === '恋慕' || name === '思慕') return 'TALENT';
    if (name === '好感度' || name === '心情') return 'CFLAG';
    return undefined;
  },
  resolve(ident: string) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (
      ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR', 'FLAG', 'TFLAG'].includes(head)
    ) {
      return ident;
    }
    return undefined;
  },
};

/**
 * 测试用分野模板表 = eraTW adapter 的真实表。
 * 转译器不再内建任何模板，故**所有**构造转译服务的测试都必须注入本表。
 */
export function stubFaceTable(): KojoFaceTable {
  return createEratwFaceTable();
}

export { createEratwFaceTable };
