/**
 * Chara CSV / 口上目录名解析判据（形态取自 `D:/game/eratohoK` 真盘）。
 */

import { describe, expect, it } from 'vitest';
import {
  charaNameFromFileName,
  characterNoOfFunction,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from '../src/chara-csv';
import { ERATOHOK } from '../src/constants';

describe('parseCharaCsv', () => {
  it('真盘形态：番号 / 名前 / 呼び名', () => {
    expect(parseCharaCsv('番号,1\r\n名前,霊夢\r\n呼び名,霊夢\r\nCSTR,0,博麗\r\n')).toEqual({
      no: 1,
      name: '霊夢',
      callName: '霊夢',
    });
  });

  it('BOM 与空行不影响；中文关键字也认', () => {
    expect(parseCharaCsv('\uFEFF编号,7\r\n\r\n姓名,魔理沙\r\n称呼,黑白\r\n')).toEqual({
      no: 7,
      name: '魔理沙',
      callName: '黑白',
    });
  });

  it('缺行给 null（不猜）', () => {
    expect(parseCharaCsv('番号,3\r\n')).toEqual({ no: 3, name: null, callName: null });
    expect(parseCharaCsv('')).toEqual({ no: null, name: null, callName: null });
  });
});

describe('文件名与目录名', () => {
  it('`Chara10 美鈴.csv` → 编号 10 / 名称 美鈴', () => {
    expect(parseCharaNoFromFileName('Chara10 美鈴.csv', ERATOHOK.charaCsvPattern)).toBe(10);
    expect(charaNameFromFileName('Chara10 美鈴.csv')).toBe('美鈴');
  });

  it('无名称段的 `Chara7.csv` → 编号 7 / 名称 null', () => {
    expect(parseCharaNoFromFileName('Chara7.csv', ERATOHOK.charaCsvPattern)).toBe(7);
    expect(charaNameFromFileName('Chara7.csv')).toBeNull();
  });

  it('非 Chara 文件名 → null', () => {
    expect(parseCharaNoFromFileName('CFLAG.CSV', ERATOHOK.charaCsvPattern)).toBeNull();
  });

  it('口上目录 `01 霊夢口上` → 编号 1 / 名称 霊夢（剥掉尾部口上）', () => {
    expect(parseKojoDirName('01 霊夢口上')).toEqual({ no: 1, label: '霊夢' });
  });

  it('口上目录 `1204 ランダムキャラ武官` → 编号 1204 / 名称原样', () => {
    expect(parseKojoDirName('1204 ランダムキャラ武官')).toEqual({
      no: 1204,
      label: 'ランダムキャラ武官',
    });
  });

  it('没有前导数字的目录 → null（不猜归属）', () => {
    expect(parseKojoDirName('U_汎用')).toBeNull();
    expect(parseKojoDirName('DAILY')).toBeNull();
  });

  it('函数名角色号：`KOJO_TRAIN_START_A1_K1205` → 1205；无号 → null', () => {
    expect(characterNoOfFunction('KOJO_TRAIN_START_A1_K1205')).toBe(1205);
    expect(characterNoOfFunction('KOJO_HAIR_NAME')).toBeNull();
  });
});
