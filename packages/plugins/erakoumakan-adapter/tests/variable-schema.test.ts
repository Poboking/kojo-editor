/**
 * 变量字典解析 / 合并 / `.ERH` 常量 + 真盘读数守卫。
 *
 * 合成用例钉裁决：层内后者胜、空名称跳过、追加层只补不盖、ERH 只认整数初值。
 * 真盘用例钉本机实测：CFLAG 329 / Talent 112 / ERH 592 名（549 带值），
 * `Chara*.csv` 被排除，`人物_咲夜 = 4` 进 const 层。
 */

import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { VariableSchema } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import {
  loadKoumakanInstructionNames,
  loadKoumakanVariableSchema,
  mergeNameTable,
  parseErhDeclarations,
  parseNameTableCsv,
} from '../src/variable-schema';
import { GAME_ROOT, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('名称表合并', () => {
  it('层内同编号后者胜；旧名仍指向同一槽位', () => {
    const { table, overwritten } = parseNameTableCsv('2,好感度\n2,好感度2\n');
    expect(table.byIndex.get('2')).toBe('好感度2');
    expect(table.byName.get('好感度')).toBe('2');
    expect(table.byName.get('好感度2')).toBe('2');
    expect(overwritten).toBe(1);
  });

  it('空名称跳过并计数（`5,,;不明`）', () => {
    const { table, skippedEmptyName } = parseNameTableCsv('5,,;不明\n6,正常\n');
    expect(table.byIndex.has('5')).toBe(false);
    expect(table.byIndex.get('6')).toBe('正常');
    expect(skippedEmptyName).toBe(1);
  });

  it('追加层只补不盖主表', () => {
    const target = parseNameTableCsv('2,好感度\n').table;
    mergeNameTable(target, '2,新名\n3,追加\n', { source: 'append' });
    expect(target.byIndex.get('2')).toBe('好感度');
    expect(target.byIndex.get('3')).toBe('追加');
  });

  it('行内 `;` 注释不进入名称', () => {
    const { table } = parseNameTableCsv('1,既成事実\n2,好感度\t\t;注\n');
    expect(table.byIndex.get('2')).toBe('好感度');
  });

  it('键值表（首列非数字）天然 0 条', () => {
    const { table } = parseNameTableCsv('コード,9224517\nタイトル,era紅魔館protoNTR\n');
    expect(table.byIndex.size).toBe(0);
  });
});

describe('.ERH 声明解析', () => {
  it('DIM CONST 整数 / 十六进制 / 无初值 / 负值 / 非 DIM', () => {
    const names = parseErhDeclarations(
      [
        '#DIM CONST A = 4',
        '#DIMS B, 8',
        '#DIM CONST C = 0x39E639',
        '#DIM D = -1',
        '#DIM E = 既成事実&1p0',
        '#DEFINE F 1',
        '#DIM SAVEDATA G',
      ].join('\n'),
    );
    expect(names.get('A')).toBe(4);
    expect(names.has('B')).toBe(true);
    expect(names.get('B')).toBeUndefined();
    expect(names.get('C')).toBe(0x39e639);
    expect(names.get('D')).toBeUndefined();
    expect(names.get('E')).toBeUndefined();
    expect(names.has('F')).toBe(false);
    expect(names.has('G')).toBe(true);
  });

  it('同名首个定义优先（引擎会报重定义；本层不覆盖）', () => {
    const names = parseErhDeclarations('#DIM CONST A = 1\n#DIM CONST A = 2\n');
    expect(names.get('A')).toBe(1);
  });
});

describe('真盘变量字典（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  let schema: VariableSchema;

  beforeAll(async () => {
    if (!hasCorpus) return;
    schema = await loadKoumakanVariableSchema({
      io: nodeIo(),
      csvDir: join(GAME_ROOT, 'CSV'),
      erbDir: join(GAME_ROOT, 'ERB'),
      log: silentLog,
    });
  });

  it.skipIf(!hasCorpus)('CFLAG 329 条 / Talent 112 条；双向查表', () => {
    expect(schema.names!('CFLAG')).toHaveLength(329);
    expect(schema.names!('TALENT')).toHaveLength(112);
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema.lookup('CFLAG', '好感度')?.resolvedIndex).toBe(2);
    expect(schema.lookup('TALENT', '恋慕')?.resolvedIndex).toBe(3);
    expect(schema.lookup('TALENT', 159)?.description).toBe('浮気公認');
  });

  it.skipIf(!hasCorpus)('`Chara*.csv` 被排除：CHARA1 / CHARA148 族不存在', () => {
    expect(schema.lookup('CHARA1')).toBeUndefined();
    expect(schema.lookup('CHARA148')).toBeUndefined();
    // 同名键在角色 CSV 里是「番号」等键，不是数字名表；若误收会凭空多出表
    expect(schema.names!('CHARA1')).toEqual([]);
  });

  it.skipIf(!hasCorpus)('·ERH 常量：人物_咲夜 = 4（0x 色值也收）', () => {
    const chara = schema.lookup('CFLAG', '人物_咲夜');
    expect(chara?.source).toBe('const');
    expect(chara?.resolvedIndex).toBe(4);
    const color = schema.lookup('CFLAG', '色設定_清潔度１');
    expect(color?.source).toBe('const');
    expect(color?.resolvedIndex).toBe(0x39e639);
  });

  it.skipIf(!hasCorpus)('无整数初值的名字收进 const 层但不给编号', () => {
    const info = schema.lookup('CFLAG', '訪問者_髪の長さ');
    expect(info?.source).toBe('const');
    expect(info?.resolvedIndex).toBeUndefined();
  });

  it.skipIf(!hasCorpus)('TRAIN 同时进字典（编号 312 → 接吻）', () => {
    expect(schema.lookup('TRAIN', 312)?.description).toBe('接吻');
  });
});

describe('真盘指令名表（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  it.skipIf(!hasCorpus)('同名取首条：接吻 = 20 / 胸爱抚 = 6；编号反查不受影响', async () => {
    const table = await loadKoumakanInstructionNames({
      io: nodeIo(),
      csvDir: join(GAME_ROOT, 'CSV'),
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('接吻')).toBe(20);
    expect(table.lookupByName('胸爱抚')).toBe(6);
    expect(table.lookupByNo(312)).toBe('接吻');
    expect(table.lookupByNo(20)).toBe('接吻');
    expect(table.names!()).toHaveLength(127);
  });
});
