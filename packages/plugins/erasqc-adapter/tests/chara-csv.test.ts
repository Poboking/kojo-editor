/**
 * Chara CSV / 口上文件名解析。
 *
 * 真盘用例钉本机实测：`Chara7.csv` 是「狼女」、`Chara57` 的呼び名是「萨菲」；
 * 合成用例钉 BOM 剥离、缺 `番号` 时的文件名回退，以及口上文件尾段不参与语义。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERASQC } from '../src/constants';
import {
  fallbackCharaName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoFileName,
} from '../src/chara-csv';
import { GAME_ROOT, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

describe('parseCharaCsv', () => {
  it('BOM 首行也能认出 `番号`', () => {
    const parsed = parseCharaCsv('\uFEFF番号,7,\n名前,狼女,\n呼び名,狼女,\n基礎,体力,2500\n');
    expect(parsed).toEqual({ no: 7, name: '狼女', callName: '狼女' });
  });

  it('缺 `番号` / `名前` / `呼び名` → null（不猜）', () => {
    expect(parseCharaCsv('基礎,体力,2500\n')).toEqual({ no: null, name: null, callName: null });
  });

  it('汉化关键字（编号 / 姓名 / 称呼）也认', () => {
    expect(parseCharaCsv('编号,12,\n姓名,蜥蜴女,\n称呼,小蜥,\n')).toEqual({
      no: 12,
      name: '蜥蜴女',
      callName: '小蜥',
    });
  });
});

describe('文件名解析', () => {
  it('Chara{no}.csv', () => {
    expect(parseCharaNoFromFileName('Chara10.csv', ERASQC.charaCsvPattern)).toBe(10);
    expect(parseCharaNoFromFileName('chara0.CSV', ERASQC.charaCsvPattern)).toBe(0);
    expect(parseCharaNoFromFileName('CharaX.csv', ERASQC.charaCsvPattern)).toBeNull();
  });

  it('口上文件名：EVENT_K / DEVENT_K / 任意尾段', () => {
    expect(parseKojoFileName('EVENT_K07.ERB', ERASQC.kojoFilePattern)).toEqual({ no: 7, tail: '' });
    expect(parseKojoFileName('DEVENT_K25_2.ERB', ERASQC.kojoFilePattern)).toEqual({ no: 25, tail: '2' });
    expect(parseKojoFileName('EVENT_K12_1_43+140.ERB', ERASQC.kojoFilePattern)).toEqual({
      no: 12,
      tail: '1_43+140',
    });
    expect(parseKojoFileName('EVENT_K.ERB', ERASQC.kojoFilePattern)).toBeNull();
    expect(parseKojoFileName('CALL_NAME.ERB', ERASQC.kojoFilePattern)).toBeNull();
  });

  it('回退名与真盘文件名同形', () => {
    expect(fallbackCharaName(31)).toBe('Chara31');
  });
});

describe('真盘读数（守卫：C:/game/eraSQC 存在才跑）', () => {
  it.skipIf(!hasCorpus)('Chara7 = 狼女；Chara57 = 黑萨菲 / 萨菲', async () => {
    const io = nodeIo();
    const seven = parseCharaCsv((await io.readText(`${GAME_ROOT}/CSV/Chara7.csv`)).text);
    expect(seven.no).toBe(7);
    expect(seven.name).toBe('狼女');
    const fiftySeven = parseCharaCsv((await io.readText(`${GAME_ROOT}/CSV/Chara57.csv`)).text);
    expect(fiftySeven.name).toBe('黑萨菲');
    expect(fiftySeven.callName).toBe('萨菲');
  });

  it.skipIf(!hasCorpus)('真盘 63 份 Chara CSV 的编号全部与文件名一致', async () => {
    const io = nodeIo();
    const entries = await io.listDir(`${GAME_ROOT}/CSV`);
    const chara = entries.filter((e) => !e.isDirectory && ERASQC.charaCsvPattern.test(e.name));
    expect(chara).toHaveLength(63);
    for (const entry of chara) {
      const parsed = parseCharaCsv((await io.readText(entry.path)).text);
      const fromName = parseCharaNoFromFileName(entry.name, ERASQC.charaCsvPattern);
      expect(parsed.no, entry.name).toBe(fromName);
    }
  });
});
