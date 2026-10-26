/**
 * eratohoReverse 的 Chara CSV / 口上目录名解析判据。
 * 合成用例为主；真盘用例（`C:/game/eratohoReverse`，2026-10-26 实测）一律
 * `describe.skipIf` 守卫——盘不在位即整组跳过，零硬依赖。
 * 真盘关键形态：口上目录 `0001_霊夢`（四位零补齐+下划线，hok 空格形态 0/25 命中）；
 * CSV 全树纯 LF + BOM；根层 `EVENT_K.ERB` / `KOJO_PROFILE.ERB` 与模板占位
 * （`キャラ番号_キャラ名`、`KX2`）都不是角色。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from '../src/chara-csv';

const DISK_ROOT = 'C:/game/eratohoReverse';
const CHARA_CSV_DIR = join(DISK_ROOT, 'CSV', 'CHARA');
const KOJO_DIR = join(DISK_ROOT, 'ERB', '口上');
const diskReady = existsSync(join(CHARA_CSV_DIR, 'Chara1_霊夢.csv'));

describe('parseCharaCsv（合成，纯 LF 为本作真盘形态）', () => {
  it('实测头注原样：BOM+空格首行、`;` 中文注释行、落单空格行都不干扰', () => {
    const text =
      '\uFEFF \n;角色番号(NO)\n番号,1\n \n;名前(NAME), 呼び名(CALLNAME)\n名前,霊夢\n呼び名,霊夢\n \n;基本(BASE)\n基本,体力,2000\n';
    expect(parseCharaCsv(text)).toEqual({ no: 1, name: '霊夢', callName: '霊夢' });
  });

  it('BOM 开头 + 纯 LF（本作 100% 此形态）', () => {
    expect(parseCharaCsv('\uFEFF番号,12\n名前,レティ\n呼び名,レティ\n')).toEqual({
      no: 12,
      name: 'レティ',
      callName: 'レティ',
    });
  });

  it('`\r?\n` 兼容外来 CRLF 文本（不许反过来只认 CRLF）', () => {
    expect(parseCharaCsv('番号,12\r\n名前,レティ\r\n呼び名,レティ\r\n')).toEqual({
      no: 12,
      name: 'レティ',
      callName: 'レティ',
    });
  });

  it('番号 0 是合法值（`Chara0_あなた.csv` 实测 名前=您），不被当缺失', () => {
    expect(parseCharaCsv('番号,0\n名前,您\n呼び名,您\n')).toEqual({ no: 0, name: '您', callName: '您' });
  });

  it('缺 `呼び名` 行 → callName null（不猜）；空文本全 null', () => {
    expect(parseCharaCsv('番号,3\n名前,橙\n')).toEqual({ no: 3, name: '橙', callName: null });
    expect(parseCharaCsv('')).toEqual({ no: null, name: null, callName: null });
  });

  it('汉化键（编号/姓名/称呼）也认', () => {
    expect(parseCharaCsv('\uFEFF编号,7\n姓名,魔理沙\n称呼,黑白\n')).toEqual({
      no: 7,
      name: '魔理沙',
      callName: '黑白',
    });
  });
});

describe('parseCharaNoFromFileName / charaNameFromFileName', () => {
  it('`Chara100_ネムノ.csv` → 100 / ネムノ（下划线分隔，charaCsvPattern 内部取用）', () => {
    expect(parseCharaNoFromFileName('Chara100_ネムノ.csv')).toBe(100);
    expect(charaNameFromFileName('Chara100_ネムノ.csv')).toBe('ネムノ');
  });

  it('`Chara0_あなた.csv` → 0 / あなた（真盘在位，玩家 CSV 与口上目录无 00 形成对照）', () => {
    expect(parseCharaNoFromFileName('Chara0_あなた.csv')).toBe(0);
    expect(charaNameFromFileName('Chara0_あなた.csv')).toBe('あなた');
  });

  it('无名称段 `Chara7.csv` → 7 / null', () => {
    expect(parseCharaNoFromFileName('Chara7.csv')).toBe(7);
    expect(charaNameFromFileName('Chara7.csv')).toBeNull();
  });

  it('hok 的空格形态 `Chara10 美鈴.csv` 本作不放行（分隔符唯一是 `_`）', () => {
    expect(parseCharaNoFromFileName('Chara10 美鈴.csv')).toBeNull();
    expect(charaNameFromFileName('Chara10 美鈴.csv')).toBeNull();
  });

  it('非 Chara 文件名 → null（`Global.csv`/`Globals.csv` 并存也不误认）', () => {
    expect(parseCharaNoFromFileName('CFLAG.CSV')).toBeNull();
    expect(parseCharaNoFromFileName('Global.csv')).toBeNull();
    expect(parseCharaNoFromFileName('Globals.csv')).toBeNull();
  });

  it('大小写宽容（charaCsvPattern 带 i）；名称段可含下划线，全归名称', () => {
    expect(parseCharaNoFromFileName('chara12_レティ.CSV')).toBe(12);
    expect(charaNameFromFileName('Chara5_a_b.csv')).toBe('a_b');
  });
});

describe('parseKojoDirName', () => {
  it('四位零补齐 + 下划线：`0001_霊夢` → 1 / `0079_神子` → 79', () => {
    expect(parseKojoDirName('0001_霊夢')).toEqual({ no: 1, label: '霊夢' });
    expect(parseKojoDirName('0079_神子')).toEqual({ no: 79, label: '神子' });
  });

  it('空格/全角空格分隔（hok 形态）不放行', () => {
    expect(parseKojoDirName('0001 霊夢')).toBeNull();
    expect(parseKojoDirName('0001　霊夢')).toBeNull();
  });

  it('位数非四的号段不是本作形态', () => {
    expect(parseKojoDirName('123_霊夢')).toBeNull();
    expect(parseKojoDirName('00123_霊夢')).toBeNull();
  });

  it('根层公共文件不是角色目录', () => {
    expect(parseKojoDirName('EVENT_K.ERB')).toBeNull();
    expect(parseKojoDirName('KOJO_PROFILE.ERB')).toBeNull();
  });

  it('模板占位名不当角色（`口上テンプレ/modern/` 第二棵树）', () => {
    expect(parseKojoDirName('キャラ番号_キャラ名')).toBeNull();
    expect(parseKojoDirName('KX2')).toBeNull();
    expect(parseKojoDirName('U_汎用')).toBeNull();
    expect(parseKojoDirName('')).toBeNull();
    expect(parseKojoDirName('   ')).toBeNull();
  });

  it('首尾空白容忍', () => {
    expect(parseKojoDirName(' 0004_大妖精 ')).toEqual({ no: 4, label: '大妖精' });
  });
});

describe('真盘（C:/game/eratohoReverse，盘不在位整组跳过）', () => {
  const csvSample = (fileName: string): string =>
    readFileSync(join(CHARA_CSV_DIR, fileName), 'utf8').replace(/^\uFEFF/, '');

  it.skipIf(!diskReady)('Chara1_霊夢.csv 实测头注原样解析；名可为中文（合欢）不校验语言', () => {
    expect(parseCharaCsv(csvSample('Chara1_霊夢.csv'))).toEqual({ no: 1, name: '霊夢', callName: '霊夢' });
    expect(parseCharaCsv(csvSample('Chara100_ネムノ.csv'))).toEqual({ no: 100, name: '合欢', callName: '合欢' });
    expect(parseCharaCsv(csvSample('Chara0_あなた.csv'))).toEqual({ no: 0, name: '您', callName: '您' });
  });

  it.skipIf(!diskReady)('108 份 CSV 全量：行内番号与文件名编号逐份一致（实测 0 失配）', () => {
    const files = readdirSync(CHARA_CSV_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
    expect(files).toHaveLength(108);
    const numbers = new Set<number>();
    for (const f of files) {
      const fileNo = parseCharaNoFromFileName(f);
      expect(fileNo, f).not.toBeNull();
      const csv = parseCharaCsv(csvSample(f));
      expect(csv.no, f).toBe(fileNo);
      expect(csv.name, f).not.toBeNull();
      numbers.add(fileNo!);
    }
    // 实测号段 0–107 全连续（并非 0–240 稀疏）
    expect(Math.max(...numbers)).toBe(107);
    expect(numbers.size).toBe(108);
  });

  it.skipIf(!diskReady)('ERB/口上 根层实测：25 个角色目录全解析，2 份公共 ERB 归 null', () => {
    const entries = readdirSync(KOJO_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(dirs).toHaveLength(25);
    for (const d of dirs) {
      expect(parseKojoDirName(d), d).not.toBeNull();
    }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    expect(files).toContain('EVENT_K.ERB');
    expect(files).toContain('KOJO_PROFILE.ERB');
    for (const f of files) {
      expect(parseKojoDirName(f), f).toBeNull();
    }
    expect(parseKojoDirName('0001_霊夢')).toEqual({ no: 1, label: '霊夢' });
  });

  it.skipIf(!diskReady)('全树纯 LF 自证：真盘 CSV 头两份无 CRLF（解析已 \r?\n 兼容）', () => {
    for (const f of ['Chara1_霊夢.csv', 'Chara0_あなた.csv']) {
      expect(csvSample(f)).not.toContain('\r\n');
    }
  });
});
