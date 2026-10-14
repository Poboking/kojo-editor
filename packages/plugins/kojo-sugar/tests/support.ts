/**
 * 测试共享夹具（kojo-sugar 测试专用）。
 *
 * **游戏知识只允许出现在测试里**：生产路径的分野模板与变量字典都由
 * `game.adapter` 槽位注入（见 `src/index.ts` 的 `dictionaryOf` / `faceTableOf`）。
 * 测试直接用 eraTW adapter 导出的真实表——这既让断言贴近生产，
 * 又符合解耦审计 C 项对 `tests/` 的豁免（测试可跨包 import）。
 */

import { createEratwFaceTable, createEratwInstructionTable, parseTrainCsv } from '@kojo/plugin-eratw-adapter';
import type { KojoFaceTable, KojoInstructionTable } from '@kojo/plugin-api';
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

/**
 * 真语料 `CSV/Train.csv` 的**逐字快照**（前 26 行，eraTW 4.980 汉化包，含 BOM、
 * `;` 注释诱饵行与空行——正是解析铁律要防的三类坑）。P-5 判据要求"查表成功"
 * 的断言来自真表数据：编号由 adapter 的**真解析器**从这些真实行算出，不是硬编码。
 */
export const REAL_TRAIN_CSV_SNAPSHOT =
  '\uFEFF' +
  [
    ';0番台,０．愛撫系指令',
    '0,愛撫',
    '1,舐陰',
    '2,给对方口交',
    '3,手指挿入',
    '4,舐肛',
    '5,肛門愛撫',
    '6,胸愛撫',
    '7,玩弄乳頭',
    '8,張開陰唇',
    '9,自慰',
    ';10,吸乳头',
    '11,吸乳头',
    '12,揉胸',
    '13,張開肛門',
    ';14,尻愛撫',
    '15,陰蒂愛撫',
    '',
    '19,接吻（継続）',
    ';20番台,１．コミュニケーション系指令',
    '20,接吻',
    '21,什麼也不做',
    '22,誘惑',
    '23,枕邊話',
    '24,攻守交替',
    '25,二穴愛撫',
  ].join('\n') +
  '\n';

/**
 * 测试用指令名表 = **真解析器**（adapter `parseTrainCsv` + `createEratwInstructionTable`）
 * 作用于上面的真 CSV 快照。与生产装配形状同构（同一张 `KojoInstructionTable` 实例化路径），
 * 杜绝"替身与实现形状不同构 ⇒ 前后之差恒 0 的空断言"（PITFALLS 实测坑）。
 */
export function stubInstructionTable(): KojoInstructionTable {
  return createEratwInstructionTable(parseTrainCsv(REAL_TRAIN_CSV_SNAPSHOT));
}

export { createEratwFaceTable, createEratwInstructionTable, parseTrainCsv };
