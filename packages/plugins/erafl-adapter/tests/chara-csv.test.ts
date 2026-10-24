/**
 * Chara CSV / 口上目录名解析（eraFL 实测形态）。
 *
 * 真盘用例以 `D:/Game/erafl` 存在为守卫；合成用例覆盖 BOM、缺行、大小写文件名、
 * 5xxx 主角口上目录这些"换个机器 / 换个汉化包就会遇到"的形态。
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERAFL } from '../src/constants';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from '../src/chara-csv';

const GAME_ROOT = 'D:/Game/erafl';
const hasCorpus = existsSync(GAME_ROOT);

describe('parseCharaCsv（番号 / 名前 / 呼び名 三行）', () => {
  it('实测 Chara10_ティア.csv：番号 10、名前 蒂娅、呼び名 蒂娅（BOM + CRLF）', () => {
    const text = '\uFEFF番号,10,\r\n名前,蒂娅,\r\n呼び名,蒂娅,\r\nCSTR,0,读音,\r\n';
    expect(parseCharaCsv(text)).toEqual({ no: 10, name: '蒂娅', callName: '蒂娅' });
  });

  it('实测 Chara0 あなた.csv：行尾无逗号也认（番号 0 / 名前 你）', () => {
    const text = '\uFEFF番号,0\r\n名前,你\r\n呼び名,你\r\n';
    expect(parseCharaCsv(text)).toEqual({ no: 0, name: '你', callName: '你' });
  });

  it('缺呼び名 → null（不猜测，也不拿名前 顶替）', () => {
    expect(parseCharaCsv('番号,5,\n名前,美鈴,\n基礎,体力,100\n')).toEqual({
      no: 5,
      name: '美鈴',
      callName: null,
    });
  });

  it('空文本 → 三个 null', () => {
    expect(parseCharaCsv('')).toEqual({ no: null, name: null, callName: null });
  });

  it('非法番号不采纳（abc / 空值都按 null 交给文件名回退）', () => {
    expect(parseCharaCsv('番号,abc,\n').no).toBeNull();
    expect(parseCharaCsv('番号,,\n').no).toBeNull();
  });
});

describe('parseCharaNoFromFileName（Chara{no}[_ ]{名}.csv）', () => {
  it('下划线 / 空格 / 小写开头三种实测文件名都能取到编号', () => {
    expect(parseCharaNoFromFileName('Chara10_ティア.csv', ERAFL.charaCsvPattern)).toBe(10);
    expect(parseCharaNoFromFileName('Chara0 あなた.csv', ERAFL.charaCsvPattern)).toBe(0);
    expect(parseCharaNoFromFileName('chara25_リナ.csv', ERAFL.charaCsvPattern)).toBe(25);
  });

  it('非角色文件返回 null（CSV/Chara/parts_info.txt）', () => {
    expect(parseCharaNoFromFileName('parts_info.txt', ERAFL.charaCsvPattern)).toBeNull();
  });
});

describe('charaNameFromFileName（名前 缺失时的显式回退）', () => {
  it('下划线 / 空格两种分隔都取到名称段', () => {
    expect(charaNameFromFileName('Chara10_ティア.csv')).toBe('ティア');
    expect(charaNameFromFileName('Chara0 あなた.csv')).toBe('あなた');
  });
});

describe('parseKojoDirName（{编号}_{名称}，5xxx 主角口上）', () => {
  it('普通角色目录 1099_うふふお姉さん → 编号 1099', () => {
    expect(parseKojoDirName('1099_うふふお姉さん')).toEqual({ no: 1099, label: 'うふふお姉さん' });
  });

  it('主角口上目录 5192_主人公口上_汎用_流され人妻 → 编号 5192、名称段保留下划线', () => {
    expect(parseKojoDirName('5192_主人公口上_汎用_流され人妻')).toEqual({
      no: 5192,
      label: '主人公口上_汎用_流され人妻',
    });
  });

  it('不带编号的名称 / 公共文件名 → null（绝不猜编号）', () => {
    expect(parseKojoDirName('2000番台以降はモブ用口上')).toBeNull();
    expect(parseKojoDirName('_KOJO_SYSTEM.ERB')).toBeNull();
  });
});

describe('真实语料读数（守卫：D:/Game/erafl 存在才跑）', () => {
  it.skipIf(!hasCorpus)('读 CSV/Chara/Chara10_ティア.csv → 番号 10、名前 蒂娅', () => {
    const text = readFileSync(`${GAME_ROOT}/CSV/Chara/Chara10_ティア.csv`, 'utf8');
    const parsed = parseCharaCsv(text);
    expect(parsed.no).toBe(10);
    expect(parsed.name).toBe('蒂娅');
  });
});
