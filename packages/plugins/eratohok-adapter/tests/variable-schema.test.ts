/**
 * 变量字典判据：CSV 名称表合并口径 / `.ERH` 声明解析 / 装载器（内存盘）。
 */

import { describe, expect, it } from 'vitest';
import {
  loadTohokInstructionNames,
  loadTohokVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from '../src/variable-schema';
import { memIo } from './harness';

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('parseNameTableCsv', () => {
  it('`编号,名称[,注释]` 三形态；`;` 起注释整行跳过', () => {
    const { table, skippedEmptyName } = parseNameTableCsv(
      ['2,好感度,', '3,依存度,;注', '; 整行注释', '154,服従,;説明', '読めない,行'].join('\r\n'),
    );
    expect([...table.byIndex.entries()]).toEqual([
      ['2', '好感度'],
      ['3', '依存度'],
      ['154', '服従'],
    ]);
    expect(table.byName.get('服従')).toBe('154');
    expect(skippedEmptyName).toBe(0);
  });

  it('名称为空的行计数跳过；键值表（`コード,9224517`）天然 0 条', () => {
    const { table, skippedEmptyName } = parseNameTableCsv('1,\nコード,9224517\n');
    expect(table.byIndex.size).toBe(0);
    expect(skippedEmptyName).toBe(1);
  });
});

describe('mergeNameTable —— 层内后者胜 / 跨层主表胜', () => {
  it('同编号后者胜并回调', () => {
    const table = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
    const seen: unknown[] = [];
    mergeNameTable(table, '2,旧名\n2,新名\n', { onOverwrite: (e) => seen.push(e) });
    expect(table.byIndex.get('2')).toBe('新名');
    expect(seen).toHaveLength(1);
  });

  it('追加层不覆盖主表同名编号', () => {
    const table = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
    mergeNameTable(table, '2,主表名\n', { source: 'primary' });
    mergeNameTable(table, '2,追加名\n9,新增\n', { source: 'append' });
    expect(table.byIndex.get('2')).toBe('主表名');
    expect(table.byIndex.get('9')).toBe('新增');
    expect(table.indexSource.get('9')).toBe('append');
  });
});

describe('parseErhDeclarations', () => {
  it('收 `#DIM` / `#DIMS` / `#DIM CONST`；只认整数与 0x 字面量', () => {
    const names = parseErhDeclarations(
      [
        '#DIM SAVEDATA 冒険回数',
        '#DIM CONST 人物_咲夜 = 4',
        '#DIM CONST 色設定_清潔度 = 0x39E639',
        '#DIMS 依頼内容, 8',
        '#DIM CONST 既成事実 = 告白&1p0',
        '; #DIM 注释里的不算',
      ].join('\r\n'),
    );
    expect(names.get('人物_咲夜')).toBe(4);
    expect(names.get('色設定_清潔度')).toBe(0x39e639);
    expect(names.get('冒険回数')).toBeUndefined();
    expect(names.has('依頼内容')).toBe(true);
    expect(names.get('既成事実')).toBeUndefined();
    expect(names.has('注釈')).toBe(false);
  });
});

describe('loadTohokVariableSchema —— 内存盘', () => {
  const ROOT = 'D:/mem/eratohoK';

  function io() {
    return memIo(
      {
        [`${ROOT}/CSV/CFLAG.CSV`]: '2,好感度,\r\n2999,其他,\r\n',
        [`${ROOT}/CSV/Talent.csv`]: '150,恋慕,\r\n154,服従,\r\n',
        [`${ROOT}/CSV/GameBase.csv`]: 'コード,9224517\r\nタイトル,eratohoK\r\n',
        [`${ROOT}/CSV/VariableSize.csv`]: 'CFLAG,3000\r\n',
        [`${ROOT}/ERB/VARIABLE.ERH`]: '#DIM CONST 人物_咲夜 = 4\r\n',
        [`${ROOT}/ERB/口上/_KOJO_K.ERH`]: '#DIM 口上フラグ\r\n',
      },
      [`${ROOT}/CSV`, `${ROOT}/ERB`, `${ROOT}/ERB/口上`],
    );
  }

  it('三族名称表 + `.ERH` 常量兜底；键值表 0 条', async () => {
    const schema = await loadTohokVariableSchema({
      io: io(),
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
    });
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('CFLAG', '好感度')?.resolvedIndex).toBe(2);
    expect(schema.lookup('TALENT', 150)?.description).toBe('恋慕');
    // `.ERH` 常量：`CFLAG:人物_咲夜` 与 `CFLAG:4` 同槽
    expect(schema.lookup('CFLAG', '人物_咲夜')?.resolvedIndex).toBe(4);
    expect(schema.lookup('CFLAG', '人物_咲夜')?.source).toBe('const');
    // 键值表没有数字行 ⇒ 该族无条目（lookup 只回裸名，不编描述）
    expect(schema.names!('GAMEBASE')).toEqual([]);
    expect(schema.lookup!('GAMEBASE', 9224517)?.description).toBeUndefined();
    expect(schema.names!('TALENT').map((i) => i.name)).toEqual(['恋慕', '服従']);
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('CSV 目录不可读 → 不抛，字典为空且 digest 为确定值', async () => {
    const schema = await loadTohokVariableSchema({
      io: memIo({}, []),
      csvDir: `${ROOT}/CSV`,
      erbDir: `${ROOT}/ERB`,
      log: silentLog,
    });
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
    expect(schema.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe('loadTohokInstructionNames', () => {
  const ROOT = 'D:/mem/eratohoK';

  it('同名多编号取**首条**（降糖期望基础指令段）', async () => {
    const io = memIo(
      { [`${ROOT}/CSV/Train.csv`]: '0,愛撫\r\n6,胸愛撫\r\n313,胸愛撫\r\n' },
      [`${ROOT}/CSV`],
    );
    const table = await loadTohokInstructionNames({ io, csvDir: `${ROOT}/CSV`, log: silentLog });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('胸愛撫')).toBe(6);
    expect(table.lookupByNo(313)).toBe('胸愛撫');
    expect(table.names!()).toEqual(['愛撫', '胸愛撫']);
  });

  it('缺表 → hasTable=false（fail-closed），不抛', async () => {
    const io = memIo({}, [`${ROOT}/CSV`]);
    const table = await loadTohokInstructionNames({ io, csvDir: `${ROOT}/CSV`, log: silentLog });
    expect(table.hasTable).toBe(false);
    expect(table.names!()).toEqual([]);
  });
});
