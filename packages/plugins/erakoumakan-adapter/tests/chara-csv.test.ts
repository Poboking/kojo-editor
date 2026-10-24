import { describe, expect, it } from 'vitest';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from '../src/chara-csv';
import { ERAKOUMAKAN } from '../src/constants';

describe('Chara CSV 解析（真盘形态）', () => {
  it('Chara1.csv：番号 / 名前 / 呼び名 三行', () => {
    const parsed = parseCharaCsv('番号,1,\n名前,红美铃,\n呼び名,美铃,\n基礎,0,2500\n');
    expect(parsed).toEqual({ no: 1, name: '红美铃', callName: '美铃' });
  });

  it('Chara0.csv（主角）：BOM 被吃掉、名称是「你」', () => {
    const parsed = parseCharaCsv('\uFEFF番号,0,\n名前,你,\n呼び名,你,\n');
    expect(parsed.no).toBe(0);
    expect(parsed.name).toBe('你');
    expect(parsed.callName).toBe('你');
  });

  it('缺行 → null（绝不猜）', () => {
    expect(parseCharaCsv('基礎,0,2000\n')).toEqual({ no: null, name: null, callName: null });
  });

  it('文件名编号：Chara0.csv / Chara148.csv 都不数错', () => {
    expect(parseCharaNoFromFileName('Chara0.csv', ERAKOUMAKAN.charaCsvPattern)).toBe(0);
    expect(parseCharaNoFromFileName('Chara148.csv', ERAKOUMAKAN.charaCsvPattern)).toBe(148);
    expect(parseCharaNoFromFileName('Train.csv', ERAKOUMAKAN.charaCsvPattern)).toBeNull();
  });

  it('文件名名称段：本作真盘 `Chara1.csv` 恒为 null（给魔改版留回退）', () => {
    expect(charaNameFromFileName('Chara1.csv')).toBeNull();
    expect(charaNameFromFileName('Chara10_魔理沙.csv')).toBe('魔理沙');
  });
});

describe('口上目录名解析', () => {
  it('`4_咲夜` / `10_魔理沙` 取下划线前的编号', () => {
    expect(parseKojoDirName('4_咲夜')).toEqual({ no: 4, label: '咲夜' });
    expect(parseKojoDirName('10_魔理沙')).toEqual({ no: 10, label: '魔理沙' });
  });

  it('`U_汎用` 不是编号目录 → null（调用方显式跳过，不猜编号）', () => {
    expect(parseKojoDirName('U_汎用')).toBeNull();
  });

  it('根层散文件 / 空名不会被当成角色目录', () => {
    expect(parseKojoDirName('_KOJO_SYSTEM.ERB')).toBeNull();
    expect(parseKojoDirName('')).toBeNull();
  });
});
