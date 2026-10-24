/**
 * 条件抽取的判据面。
 *
 * 断言口径：**数条数、对来源、对取反**——"能抽出来"这种话不算判据。
 * 合成样本覆盖边界（空段 / 孤立 `!` / 缺花括号 / 畸形输入），真盘用例单列并以
 * 语料盘存在为守卫，读的是"量级"而不是"某一份文件的某一条"。
 */

import { describe, expect, it } from 'vitest';
import { extractKojoXmlConditions } from '../../src/preview/conditions';
import { hasKojoCorpus, readKojoCorpusFile, sampleKojoXmlFiles } from './corpus';

describe('extractKojoXmlConditions —— 三类条件', () => {
  it('任务样例：eval + isFall + emotion 共 3 条，非条件属性全部排除', () => {
    const conditions = extractKojoXmlConditions({
      attrs: {
        com: '300',
        name: '会話',
        kojoPlace: 'TOP',
        priority: '1',
        eval: '{TSTR:会話モード == "商談"}',
        isFall: 'LOVER',
        emotion: 'GOOD',
      },
    });
    expect(conditions).toHaveLength(3);
    expect(conditions.map((c) => c.source)).toEqual(['eval', 'isFall', 'emotion']);
    expect(conditions.map((c) => c.kind)).toEqual(['expr', 'value', 'value']);
  });

  it('eval 去掉外层花括号，解实体后的引号原样保留', () => {
    const [condition] = extractKojoXmlConditions({
      attrs: { eval: '{TSTR:会話モード == "商談" && FLAG:X}' },
    });
    expect(condition).toEqual({
      source: 'eval',
      kind: 'expr',
      expression: 'TSTR:会話モード == "商談" && FLAG:X',
      negated: false,
    });
  });

  it('eval 缺花括号（真盘 56 处）仍抽出原文，不静默丢条件', () => {
    const [condition] = extractKojoXmlConditions({ attrs: { eval: 'FLAG:ウフフフラグ' } });
    expect(condition?.kind).toBe('expr');
    expect(condition?.expression).toBe('FLAG:ウフフフラグ');
  });

  it('eval 只有空花括号 / 空白 → 0 条（不产出空表达式）', () => {
    expect(extractKojoXmlConditions({ attrs: { eval: '{}' } })).toHaveLength(0);
    expect(extractKojoXmlConditions({ attrs: { eval: '   ' } })).toHaveLength(0);
  });

  it('isFall 逗号多值切成 2 条，均不取反', () => {
    const conditions = extractKojoXmlConditions({ attrs: { isFall: 'LOVER,SLAVED_BY' } });
    expect(conditions).toHaveLength(2);
    expect(conditions.map((c) => c.expression)).toEqual(['LOVER', 'SLAVED_BY']);
    expect(conditions.every((c) => c.source === 'isFall' && !c.negated)).toBe(true);
  });

  it('isFall 的 ! 前缀变成 negated=true，expression 只剩取值', () => {
    const conditions = extractKojoXmlConditions({ attrs: { isFall: '親愛,!LOVER' } });
    expect(conditions).toHaveLength(2);
    expect(conditions[1]).toEqual({
      source: 'isFall',
      kind: 'value',
      expression: 'LOVER',
      negated: true,
    });
  });

  it('emotion 六值（怒,悲,恐,恨,鬱,狂）→ 6 条', () => {
    const conditions = extractKojoXmlConditions({ attrs: { emotion: '怒,悲,恐,恨,鬱,狂' } });
    expect(conditions).toHaveLength(6);
    expect(conditions[5]?.expression).toBe('狂');
  });

  it('逗号空段（LOVER,,SLAVE）只出 2 条，不产出空条件', () => {
    const conditions = extractKojoXmlConditions({ attrs: { isFall: 'LOVER,,SLAVE,' } });
    expect(conditions.map((c) => c.expression)).toEqual(['LOVER', 'SLAVE']);
  });

  it('孤立 ! 不算条件（只有取反符号没有取值）', () => {
    expect(extractKojoXmlConditions({ attrs: { isFall: '!' } })).toHaveLength(0);
    expect(extractKojoXmlConditions({ attrs: { isFall: 'LOVER, ! ,SLAVE' } })).toHaveLength(2);
  });
});

describe('extractKojoXmlConditions —— 判定边界', () => {
  it('身份 / 位置 / 归属 / 调用点 / 行为开关都不算条件（22 个属性 → 0 条）', () => {
    const conditions = extractKojoXmlConditions({
      attrs: {
        com: '300',
        name: '会話',
        kojoPlace: 'TOP',
        place: 'TOP',
        priority: '1',
        forMaster: 'TRUE',
        PLYorTGT: 'PLAYER',
        ACTorTGT: 'ACTOR',
        isPlayer: '実行',
        datePLYorTGT: 'PLAYER',
        eventId: '12',
        questId: '20',
        questRoomId: '3',
        questEventId: '4',
        option: 'ANY',
        sequence: '0',
        skillDefName: 'X',
        actionName: 'Y',
        token: 'Z',
        isExclusive: 'TRUE',
        isUfufu: 'TRUE',
        cutDescription: 'TRUE',
      },
    });
    expect(conditions).toHaveLength(0);
  });

  it('状态 / 阈值族算条件（isMob / isDateMode / lust / atRaped → 4 条）', () => {
    const conditions = extractKojoXmlConditions({
      attrs: { isMob: 'TRUE', isDateMode: 'TRUE', lust: '5', atRaped: '!ONLYRAPED' },
    });
    expect(conditions).toHaveLength(4);
    expect(conditions.map((c) => c.source)).toEqual(['isMob', 'isDateMode', 'lust', 'atRaped']);
    expect(conditions[3]?.negated).toBe(true);
    expect(conditions[3]?.expression).toBe('ONLYRAPED');
  });

  it('拼错的属性（ikojoPlace / sExclusive / ust）安静忽略，不造出假条件', () => {
    expect(
      extractKojoXmlConditions({ attrs: { ikojoPlace: 'TOP', sExclusive: 'TRUE', ust: '9' } }),
    ).toHaveLength(0);
  });

  it('条件顺序 = 属性书写顺序（emotion 在前就排在 isFall 前）', () => {
    const conditions = extractKojoXmlConditions({
      attrs: { emotion: 'GOOD', isFall: 'LOVER', eval: '{X}' },
    });
    expect(conditions.map((c) => c.source)).toEqual(['emotion', 'isFall', 'eval']);
  });
});

describe('extractKojoXmlConditions —— 畸形输入不抛', () => {
  it('null / 缺 attrs / attrs 为 null / attrs 是数组 → 空数组', () => {
    expect(extractKojoXmlConditions(null)).toEqual([]);
    expect(extractKojoXmlConditions(undefined)).toEqual([]);
    expect(extractKojoXmlConditions({})).toEqual([]);
    expect(extractKojoXmlConditions({ attrs: null })).toEqual([]);
    expect(extractKojoXmlConditions({ attrs: [] as unknown as Record<string, string> })).toEqual([]);
  });

  it('属性值不是字符串（数字 / undefined）→ 跳过该条，其余照抽', () => {
    const conditions = extractKojoXmlConditions({
      attrs: { eval: 123 as unknown as string, isFall: 'LOVER' },
    });
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.source).toBe('isFall');
  });
});

describe('真盘读数（守卫：D:/Game/erafl/ERB/口上 存在才跑）', () => {
  it.skipIf(!hasKojoCorpus)('20 份抽样：口上 3,570 条 / 表达式条件 1,473 条 / 取值条件 1,370 条', () => {
    const files = sampleKojoXmlFiles(20);
    expect(files).toHaveLength(20);

    let commands = 0;
    let expr = 0;
    let value = 0;

    for (const path of files) {
      const file = readKojoCorpusFile(path);
      for (const command of file.commands) {
        commands++;
        for (const condition of extractKojoXmlConditions(command)) {
          if (condition.kind === 'expr') expr++;
          else value++;
        }
      }
    }

    expect(commands).toBeGreaterThanOrEqual(3_500);
    expect(expr).toBeGreaterThanOrEqual(200);
    expect(value).toBeGreaterThanOrEqual(1_000);
  });

  it.skipIf(!hasKojoCorpus)('真盘 K1005：6 处 eval 没写全花括号，仍抽出 6 条表达式条件', () => {
    // 这是"容错不是可选项"的实证：丢了这 6 条，作者在预览里会看不到真实命中条件
    const file = readKojoCorpusFile('D:/Game/erafl/ERB/口上/1005_汎用_陰気/KOJO_K1005_COM.xml');
    const partial = file.commands.filter(
      (command) => command.attrs['eval'] !== undefined && !command.attrs['eval'].trim().startsWith('{'),
    );
    expect(partial.length).toBeGreaterThanOrEqual(4);
    for (const command of partial) {
      const expr = extractKojoXmlConditions(command).filter((c) => c.kind === 'expr');
      expect(expr).toHaveLength(1);
      expect(expr[0]?.expression.length).toBeGreaterThan(0);
    }
  });
});
