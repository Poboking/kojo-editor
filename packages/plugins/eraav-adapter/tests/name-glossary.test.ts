/**
 * eraAV 展示用中日对照词典（`nameGlossary`）——**表由真盘生成，用例钉的是生成口径没跑偏**。
 *
 * 三条必钉的护栏（每条都是本盘真存在的陷阱，见 `src/name-glossary.ts` 头注）：
 * ① **同名不同人整键作废**：`宮間かなで` 既是 01「宫间奏美」也是 91「宫间香奈」⇒ 键必须缺席，
 *    否则任一份文件的备注都会冤枉另一个角色；同段的 `春風南`(70/76) 与 `神園すみれ`(71/77)
 *    两值相同 ⇒ 必须保留（只丢真冲突的那一个，不连坐）；
 * ② **子串安全**：任何一键都不是另一键的子串（实测 0 对），故宿主那把「最长键优先 + `includes`」
 *    的尺子不存在长短键争同一个名字的情形；
 * ③ **只加显示备注**：`glossName` 的输入输出都是名字本身，不改路径、不猜没量到的名字。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERAAV_NAME_GLOSSARY, glossName } from '../src/name-glossary';
import { GAME_ROOT } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const KEYS = Object.keys(ERAAV_NAME_GLOSSARY);

describe('表本体（生成口径）', () => {
  it('92 个键、值与键互不相同（只收真对照，identical 的 23 段不进表）', () => {
    expect(KEYS).toHaveLength(92);
    for (const k of KEYS) expect(ERAAV_NAME_GLOSSARY[k], k).not.toBe(k);
    expect(new Set(KEYS).size).toBe(92);
  });

  it('冲突键已整键丢弃；同值重复段保留', () => {
    expect(ERAAV_NAME_GLOSSARY['宮間かなで']).toBeUndefined(); // 01 宫间奏美 / 91 宫间香奈 —— 同名不同人
    expect(ERAAV_NAME_GLOSSARY['春風南']).toBe('春风南'); // 70 / 76 两值相同
    expect(ERAAV_NAME_GLOSSARY['神園すみれ']).toBe('神园澄铃'); // 71 / 77 两值相同
  });

  it('子串安全：没有任何一键是另一键的子串（宿主按 includes 命中，长短键不会互相抢名字）', () => {
    const offenders: string[] = [];
    for (const a of KEYS) for (const b of KEYS) if (a !== b && b.includes(a)) offenders.push(`${a}⊂${b}`);
    expect(offenders).toEqual([]);
  });

  it('命中即加备注；名字已含对应中文不重复；查不到的名字原样返回（fail-visible，绝不猜）', () => {
    expect(glossName('EVENT_K33_相田アリサ.ERB')).toBe('EVENT_K33_相田アリサ.ERB（相田艾丽莎）');
    expect(glossName('Chara33_相田アリサ.csv')).toBe('Chara33_相田アリサ.csv（相田艾丽莎）');
    expect(glossName('相田艾丽莎')).toBe('相田艾丽莎');
    expect(glossName('EVENT_K01_宮間かなで.ERB')).toBe('EVENT_K01_宮間かなで.ERB'); // 冲突键已丢 ⇒ 不备注
    expect(glossName('EVENT_K05_渡会桔梗.ERB')).toBe('EVENT_K05_渡会桔梗.ERB（渡来桔梗）');
    expect(glossName('')).toBe('');
  });
});

describe('真盘渲染影响面（守卫：语料在位才跑）', () => {
  it.skipIf(!hasCorpus)(
    'CSV 名称段与 名前 行逐份对得上；可见名字的变化数＝106（CSV 94 + 口上文件 12）',
    () => {
      const csvDir = join(GAME_ROOT, 'CSV', 'Chara');
      const linesDir = join(GAME_ROOT, 'ERB', 'Lines');
      const csvNames = readdirSync(csvDir).filter((n) => /^chara\d+_/i.test(n));
      const kojoNames = readdirSync(linesDir);

      const changed = csvNames.filter((n) => glossName(n) !== n);
      const changedKojo = kojoNames.filter((n) => glossName(n) !== n);
      expect(changed).toHaveLength(94);
      expect(changedKojo).toHaveLength(12);
      expect(changed.length + changedKojo.length).toBe(106);

      // 逐份复核：命中的键必须就是这份文件自己的名称段，且值必须等于该份 CSV 的 `名前` 行
      for (const name of csvNames) {
        const m = /^chara(\d+)_(.+)\.csv$/i.exec(name);
        if (!m) continue;
        const seg = m[2]!.trim().replace(/\.+$/, '');
        const zh = ERAAV_NAME_GLOSSARY[seg];
        if (zh === undefined) continue; // 冲突键（宮間かなで）与 identical 段（桐生歌音…）都不进表
        const text = readFileSync(join(csvDir, name), 'utf8').replace(/^\uFEFF/, '');
        const row = ((/^名前,(.+)$/m.exec(text) ?? [])[1] ?? '').split(',')[0]!.trim();
        expect(zh, name).toBe(row);
      }
    },
  );
});
