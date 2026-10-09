import { describe, expect, it } from 'vitest';
import { parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from '../src/chara-csv';
import { ERATW } from '../src/constants';

describe('parseCharaCsv（eraTW 4.980 实测格式）', () => {
  it('标准样本：番号/名前/呼び名 三行', () => {
    const text = '\uFEFF番号,1,\n名前,博丽 灵梦,\n呼び名,灵梦,\n基礎,体力,2000\n素質,処女,1\n';
    expect(parseCharaCsv(text)).toEqual({ no: 1, name: '博丽 灵梦', callName: '灵梦' });
  });

  it('CRLF 换行与行尾空格容错', () => {
    const text = '番号,26, \r\n名前,八云紫, \r\n呼び名,紫,\r\n';
    expect(parseCharaCsv(text)).toEqual({ no: 26, name: '八云紫', callName: '紫' });
  });

  it('缺行 → null（不猜测）', () => {
    expect(parseCharaCsv('番号,5,\n基礎,体力,100\n')).toEqual({ no: 5, name: null, callName: null });
    expect(parseCharaCsv('')).toEqual({ no: null, name: null, callName: null });
  });

  it('非法番号值不采纳', () => {
    expect(parseCharaCsv('番号,abc,\n').no).toBeNull();
  });
});

describe('parseCharaNoFromFileName', () => {
  it('Chara{n} 前缀提取', () => {
    expect(parseCharaNoFromFileName('Chara1 霊夢.csv', ERATW.charaCsvPattern)).toBe(1);
    expect(parseCharaNoFromFileName('Chara51 にとり.CSV', ERATW.charaCsvPattern)).toBe(51);
    expect(parseCharaNoFromFileName('Chara0.csv', ERATW.charaCsvPattern)).toBe(0);
  });

  it('不匹配返回 null', () => {
    expect(parseCharaNoFromFileName('Abl.csv', ERATW.charaCsvPattern)).toBeNull();
    expect(parseCharaNoFromFileName('Chara.csv', ERATW.charaCsvPattern)).toBeNull();
  });
});

describe('parseKojoDirName（個人口上目录约定）', () => {
  it('三位编号 + 名称', () => {
    expect(parseKojoDirName('001 Reimu [霊夢]')).toEqual({ no: 1, label: 'Reimu [霊夢]' });
    expect(parseKojoDirName('155 ちやり')).toEqual({ no: 155, label: 'ちやり' });
  });

  it('不符合约定 → null（不猜测）', () => {
    expect(parseKojoDirName('of_new_kojo_api_TEST.ERB')).toBeNull();
    expect(parseKojoDirName('Reimu')).toBeNull();
    expect(parseKojoDirName('')).toBeNull();
  });
});
