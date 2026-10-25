/**
 * 变量字典 / 指令名表 / `.ERH` 声明 + 真盘读数守卫。
 *
 * 真盘实测：CFLAG 62 / TALENT 224 / TRAIN 196；63 份 `Chara*.csv` 被排除；
 * 指令同名取首条（`自慰` = 3，不是 282）。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loadErasqcInstructionNames,
  loadErasqcVariableSchema,
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

  it('空名称跳过并计数', () => {
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
    const { table } = parseNameTableCsv('3,外表年龄,;生きている年数とは无関係\n');
    expect(table.byIndex.get('3')).toBe('外表年龄');
  });

  it('键值表（首列非数字）天然 0 条', () => {
    const { table } = parseNameTableCsv('コード,9224517\nタイトル,erasqn汉化魔改版_返\n');
    expect(table.byIndex.size).toBe(0);
  });
});

describe('.ERH 声明解析（本作真盘 0 份，路径保留）', () => {
  it('DIM CONST 整数 / 十六进制 / 无初值 / 表达式不收值', () => {
    const m = parseErhDeclarations(
      '#DIM CONST 人物_咲夜 = 4\n#DIM CONST 颜色 = 0x39E639\n#DIM 无初值\n#DIM CONST 别名 = 既成事実&1p0\n',
    );
    expect(m.get('人物_咲夜')).toBe(4);
    expect(m.get('颜色')).toBe(0x39e639);
    expect(m.get('无初值')).toBeUndefined();
    expect(m.get('别名')).toBeUndefined();
  });
});

describe('真盘读数（守卫：C:/game/eraSQC 存在才跑）', () => {
  it.skipIf(!hasCorpus)('CFLAG 62 / TALENT 224 / TRAIN 196；双向可查', async () => {
    const schema = await loadErasqcVariableSchema({
      io: nodeIo(),
      csvDir: `${GAME_ROOT}/CSV`,
      erbDir: `${GAME_ROOT}/ERB`,
      log: silentLog,
    });
    expect(schema.names!('CFLAG')).toHaveLength(62);
    expect(schema.names!('TALENT')).toHaveLength(224);
    expect(schema.names!('TRAIN')).toHaveLength(196);
    expect(schema.lookup('CFLAG', 995)?.description).toBe('是乳牛');
    expect(schema.lookup('CFLAG', '是乳牛')?.resolvedIndex).toBe(995);
    expect(schema.lookup('TALENT', 85)?.description).toBe('恋慕');
    expect(schema.lookup('TALENT', '恋慕')?.resolvedIndex).toBe(85);
    expect(schema.lookup('TRAIN', 3)?.description).toBe('自慰');
  });

  it.skipIf(!hasCorpus)('Chara*.csv 没被当成变量名表（不会出现 CHARA1 族）', async () => {
    const schema = await loadErasqcVariableSchema({
      io: nodeIo(),
      csvDir: `${GAME_ROOT}/CSV`,
      erbDir: `${GAME_ROOT}/ERB`,
      log: silentLog,
    });
    expect(schema.lookup('CHARA1')).toBeUndefined();
    expect(schema.lookup('CHARA98')).toBeUndefined();
  });

  it.skipIf(!hasCorpus)('指令名表：同名取首条（自慰 = 3；282 仍可反查）', async () => {
    const table = await loadErasqcInstructionNames({
      io: nodeIo(),
      csvDir: `${GAME_ROOT}/CSV`,
      log: silentLog,
    });
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('自慰')).toBe(3);
    expect(table.lookupByName('爱抚')).toBe(0);
    expect(table.lookupByNo(282)).toBe('自慰');
    expect(table.names!()).toHaveLength(152);
  });
});
