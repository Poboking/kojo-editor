import { describe, expect, it } from 'vitest';
import { deriveCharaNoFromFileNames, parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from '../src/chara-csv';
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

describe('deriveCharaNoFromFileNames（纯名目录按文件名回退）', () => {
  it('4.842 实测：纯角色名目录的 M_KOJO_K{no} 文件名', () => {
    expect(deriveCharaNoFromFileNames(['M_KOJO_K36_コマンド.ERB'])).toBe(36); // 阿燐
    expect(deriveCharaNoFromFileNames(['M_KOJO_K130_通常.ERB'])).toBe(130); // 八千慧
    expect(deriveCharaNoFromFileNames(['M_KOJO_K65_コマンド.ERB', 'M_KOJO_K65.ERH'])).toBe(65); // 椛
  });

  it('忽略大小写、忽略无关文件', () => {
    expect(deriveCharaNoFromFileNames(['m_kojo_k36_event.erb', 'README.txt'])).toBe(36);
  });

  it('多个不同编号取出现次数最多者（并列取最小）', () => {
    expect(deriveCharaNoFromFileNames(['M_KOJO_K36_a.ERB', 'M_KOJO_K36_b.ERB', 'M_KOJO_K65_c.ERB'])).toBe(36);
    expect(deriveCharaNoFromFileNames(['M_KOJO_K65_c.ERB', 'M_KOJO_K36_a.ERB'])).toBe(36); // 并列 1:1 → 取小
  });

  it('目录内无 M_KOJO_K 文件 → null', () => {
    expect(deriveCharaNoFromFileNames(['阿燐.ERB', 'README.txt'])).toBeNull();
    expect(deriveCharaNoFromFileNames([])).toBeNull();
  });

  it('占位形态 `K{n}[]` 不计入（dummy 编号，非真字符号）', () => {
    expect(deriveCharaNoFromFileNames(['M_KOJO_K1[]_コマンド.ERB'])).toBeNull();
    expect(deriveCharaNoFromFileNames(['M_KOJO_K159_コマンド.ERB', 'M_KOJO_K1[]_絶頂.ERB'])).toBe(159);
  });

  it('真形态 `.` / 空格 / 汉字后继仍取真编号', () => {
    expect(deriveCharaNoFromFileNames(['M_KOJO_K86.ERB'])).toBe(86);
    expect(deriveCharaNoFromFileNames(['M_KOJO_K37 カウンター.ERB'])).toBe(37);
    expect(deriveCharaNoFromFileNames(['M_KOJO_K75刻印取得.ERB'])).toBe(75);
  });
});
