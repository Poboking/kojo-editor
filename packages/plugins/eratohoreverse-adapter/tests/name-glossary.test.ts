/**
 * eratohoReverse 展示用中日对照词典（`nameGlossary`）——表由真盘生成，用例钉生成口径。
 *
 * 三条必钉：
 * ① 52 键 = 角色名 48（只收 `名称段 ≠ 名前` 的真对照）+ 盘根通用词 4（逐个核过在位）；
 * ② **子串安全实测 0 对** ⇒ 宿主那把「最长键优先 + `includes`」的尺子不会长短键互抢，表不必缩短；
 * ③ eraTW 的静态 9 键在本盘 **0 命中**（含 `テンプレート` 对本盘 `テンプレ` 的失配）⇒ 不许抄表。
 * 真盘那一条把渲染变化数钉死：`CSV/CHARA` 48/108 + `ERB/口上` 角色目录 11/25 + 盘根 4 = **63**。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERATOHOREVERSE_NAME_GLOSSARY, glossName } from '../src/name-glossary';
import { GAME_ROOT } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const KEYS = Object.keys(ERATOHOREVERSE_NAME_GLOSSARY);
const GENERIC = ['口上テンプレ', '作者メモ', '取扱説明', '開発情報'];

describe('表本体（生成口径）', () => {
  it('52 键（角色名 48 + 通用词 4），值与键互不相同', () => {
    expect(KEYS).toHaveLength(52);
    expect(KEYS.filter((k) => GENERIC.includes(k))).toHaveLength(4);
    for (const k of KEYS) expect(ERATOHOREVERSE_NAME_GLOSSARY[k], k).not.toBe(k);
    expect(new Set(KEYS).size).toBe(52);
  });

  it('冲突整键作废这条在本盘 0 个键被丢（108 段全唯一）——护栏照样在位', () => {
    // 与本盘相反的例子在 eraAV：`宮間かなで` 01/91 两个不同 `名前` ⇒ 那边整键丢弃。
    // 这里钉的是"本盘确实没有同名不同值"，所以 48 个角色键一个不少。
    expect(KEYS.filter((k) => !GENERIC.includes(k))).toHaveLength(48);
  });

  it('子串安全：没有任何一键是另一键的子串（单概念名如 舞 / あなた 也不与别键互含）', () => {
    const offenders: string[] = [];
    for (const a of KEYS) for (const b of KEYS) if (a !== b && b.includes(a)) offenders.push(`${a}⊂${b}`);
    expect(offenders).toEqual([]);
  });

  it('命中加备注 / 已含中文不重复 / 查不到原样返回（只改显示，路径本体不动）', () => {
    expect(glossName('0014_アリス')).toBe('0014_アリス（爱丽丝）');
    expect(glossName('Chara100_ネムノ.csv')).toBe('Chara100_ネムノ.csv（合欢）');
    expect(glossName('口上テンプレ')).toBe('口上テンプレ（口上模板）');
    // eraTW 的 `テンプレート` 匹配不到本盘的 `テンプレ`（方向相反也不行）
    expect(glossName('ACT_01_愛撫_K14.ERB')).toBe('ACT_01_愛撫_K14.ERB');
    expect(glossName('0068_ムラサ')).toBe('0068_ムラサ'); // CSV 名称段写作 水蜜 ⇒ 本盘没给 ムラサ 的中文
    expect(glossName('')).toBe('');
  });
});

describe('eraTW 静态表在本盘不适用（不许抄）', () => {
  it('本表的通用词按本盘写法立键：`テンプレ` 在、eraTW 的 `テンプレート` 不在', () => {
    // eraTW 那 9 键（追加ファイル/面ファイル/ライセンス/テンプレート/資源/画像/セーブ/設定/サンプル）
    // 在本盘 1,167 个可见名字上实测 **0 命中**（真源 `eratw-adapter/src/name-glossary.ts:7-17`）：
    // 本盘既没有那些目录/文件名，`テンプレート` 也**匹配不到**本盘写作 `テンプレ` 的目录名。
    expect(ERATOHOREVERSE_NAME_GLOSSARY['テンプレート']).toBeUndefined();
    expect(ERATOHOREVERSE_NAME_GLOSSARY['口上テンプレ']).toBe('口上模板');
    expect(glossName('口上テンプレ')).toBe('口上テンプレ（口上模板）');
    expect(glossName('追加ファイル')).toBe('追加ファイル'); // 抄 eraTW 的键不会命中本盘任何名字
  });
});

describe('真盘渲染影响面（守卫：语料在位才跑）', () => {
  it.skipIf(!hasCorpus)(
    '变化数 63 = CSV 48/108 + 口上角色目录 11/25 + 盘根通用目录 4；口上域内 638 个文件名一个都不注',
    () => {
      const csvDir = join(GAME_ROOT, 'CSV', 'CHARA');
      const kojoDir = join(GAME_ROOT, 'ERB', '口上');
      const csvNames = readdirSync(csvDir).filter((n) => /^chara\d+_/i.test(n));
      const charaDirs = readdirSync(kojoDir).filter((n) => /^\d{4}_/.test(n) && statSync(join(kojoDir, n)).isDirectory());
      const rootDirs = readdirSync(GAME_ROOT).filter((n) => statSync(join(GAME_ROOT, n)).isDirectory());

      const changedCsv = csvNames.filter((n) => glossName(n) !== n);
      const changedDirs = charaDirs.filter((n) => glossName(n) !== n);
      const changedRoot = rootDirs.filter((n) => glossName(n) !== n);
      expect(changedCsv).toHaveLength(48);
      expect(changedDirs).toHaveLength(11);
      expect(changedRoot.sort()).toEqual(GENERIC.slice().sort());

      // 域内**文件**名按面/事件命名，不含角色名 ⇒ 一个都不该注（注了就是误标）
      const fileNames = new Set<string>();
      const walk = (p: string): void => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(p, e.name));
          else fileNames.add(e.name);
        }
      };
      walk(kojoDir);
      expect(fileNames.size).toBe(638);
      expect([...fileNames].filter((n) => glossName(n) !== n)).toEqual([]);
      expect(changedCsv.length + changedDirs.length + changedRoot.length).toBe(63);

      // 逐份复核：命中的备注必须等于该份 CSV 自己的 `名前` 行（键取不到就整份跳过）
      for (const name of changedCsv) {
        const m = /^chara(\d+)_(.+)\.csv$/i.exec(name);
        if (!m) continue;
        const text = readFileSync(join(csvDir, name), 'utf8').replace(/^\uFEFF/, '');
        const row = ((/^名前,(.+)$/m.exec(text) ?? [])[1] ?? '').split(',')[0]!.trim();
        expect(glossName(name), name).toBe(`${name}（${row}）`);
      }
    },
  );
});
