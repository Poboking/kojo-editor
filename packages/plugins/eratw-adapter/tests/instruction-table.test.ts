/**
 * eraTW 指令名表数据层（HK-11）——`CSV/Train.csv` 解析与查表回归。
 *
 * 断言口径：按**第一列**取编号（不是行号）、`;` 注释行**整行跳过**、同名取首条、
 * 反向查表、缺表 / 缺名 / 缺号一律 `undefined`（绝不猜）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import {
  createEratwInstructionTable,
  EMPTY_INSTRUCTION_TABLE,
  loadEratwInstructionTable,
  parseTrainCsv,
} from '../src/instruction-table';

const BOM = '\uFEFF';

/**
 * 首条真实数据在**第 5 行**（编号 310，≠ 行号）；穿插 BOM / 注释（含带编号的注释）/
 * 空行 / 同名重号 / 首列非数字。
 */
const CSV = [
  `${BOM};==== コマンド名 ====`,
  '; 说明注释',
  '',
  ';708,被打断的注释行（带编号，必须整行跳过）',
  '310,摸屁股',
  '311,摸屁股',
  '',
  '705,告白',
  'abc,坏行（首列非数字）',
  '0,会話',
].join('\n');

describe('parseTrainCsv', () => {
  it('按第一列取编号（非行号）、重名取首条、容忍 BOM', () => {
    const map = parseTrainCsv(CSV);
    expect(map.get('摸屁股')).toBe(310); // 重号 311 取首条
    expect(map.get('告白')).toBe(705);
    expect(map.get('会話')).toBe(0);
    expect(map.size).toBe(3);
  });

  it('`;` 开头的行即使带编号也整行跳过', () => {
    const map = parseTrainCsv(';708,胸愛撫\n;706 玩弄乳頭\n310,摸屁股\n');
    expect(map.has('胸愛撫')).toBe(false);
    expect(map.has('玩弄乳頭')).toBe(false);
    expect(map.get('摸屁股')).toBe(310);
    expect(map.size).toBe(1);
  });

  it('首列非数字 / 缺名称 / 空行 全部丢弃', () => {
    const map = parseTrainCsv(['abc,坏行', ',无名', '', '   ', '5,'].join('\n'));
    expect(map.size).toBe(0);
  });

  it('无 BOM 的普通文本同样解析', () => {
    expect(parseTrainCsv('310,摸屁股\n').get('摸屁股')).toBe(310);
  });
});

describe('createEratwInstructionTable', () => {
  it('双向查表：中文名 → 编号 与 编号 → 中文名', () => {
    const table = createEratwInstructionTable(parseTrainCsv(CSV));
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('摸屁股')).toBe(310);
    expect(table.lookupByName('告白')).toBe(705);
    expect(table.lookupByNo(310)).toBe('摸屁股');
    expect(table.lookupByNo(705)).toBe('告白');
  });

  it('缺失名 / 缺失号 一律 undefined（绝不猜）', () => {
    const table = createEratwInstructionTable(parseTrainCsv(CSV));
    expect(table.lookupByName('不存在')).toBeUndefined();
    expect(table.lookupByNo(999)).toBeUndefined();
  });

  it('空表：hasTable=false，查名查号均 undefined', () => {
    const table = createEratwInstructionTable(new Map());
    expect(table.hasTable).toBe(false);
    expect(table.lookupByName('摸屁股')).toBeUndefined();
    expect(table.lookupByNo(310)).toBeUndefined();
    expect(EMPTY_INSTRUCTION_TABLE.hasTable).toBe(false);
  });

  it('正向枚举 names()：按数据源声明序返回、去重（同值多号取首条不重复）', () => {
    const table = createEratwInstructionTable(parseTrainCsv(CSV));
    expect(table.names?.()).toEqual(['摸屁股', '告白', '会話']);
  });

  it('空表 / EMPTY_INSTRUCTION_TABLE 的 names() = []（不猜）', () => {
    expect(createEratwInstructionTable(new Map()).names?.()).toEqual([]);
    expect(EMPTY_INSTRUCTION_TABLE.names?.()).toEqual([]);
  });
});

describe('loadEratwInstructionTable', () => {
  const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  function fakeIo(files: Record<string, string>): FileIO {
    return {
      exists: async (p: string) => Object.keys(files).some((k) => p.endsWith(k)),
      readText: async (p: string) => {
        const key = Object.keys(files).find((k) => p.endsWith(k));
        if (key === undefined) throw new Error(`ENOENT: ${p}`);
        return { path: p, text: files[key]!, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
      },
    } as unknown as FileIO;
  }

  it('读 <csvDir>/Train.csv 并建表', async () => {
    const table = await loadEratwInstructionTable({
      io: fakeIo({ 'Train.csv': '310,摸屁股\n' }),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('摸屁股')).toBe(310);
  });

  it('文件不存在 = 空表、不抛', async () => {
    const table = await loadEratwInstructionTable({
      io: fakeIo({}),
      csvDir: '/game/CSV',
      log: silentLog,
    });
    expect(table.hasTable).toBe(false);
  });

  it('读失败 = 记 warn + 回空表、不抛', async () => {
    const warns: string[] = [];
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };
    const io = {
      exists: async () => true,
      readText: async () => {
        throw new Error('boom');
      },
    } as unknown as FileIO;
    const table = await loadEratwInstructionTable({ io, csvDir: '/game/CSV', log });
    expect(table.hasTable).toBe(false);
    expect(warns).toHaveLength(1);
  });
});
