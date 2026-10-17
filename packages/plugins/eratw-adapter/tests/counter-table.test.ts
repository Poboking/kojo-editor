/**
 * eraTW 计数器值域表（`KojoCounterTable`）——`时机 计数器 <中文名>：` 的名 → 编号
 * 从糖层搬进 adapter 后的权威回归（1016 批）。
 *
 * 断言口径：表是**游戏知识，只住 adapter**；糖层只查不解释。此文件是"表内容漂移 /
 * 取首条口径漂移"的可执行凭证——表若被改坏，此处先红。
 *
 * 收录面判定（编制口径见 `src/counter-table.ts` 头注）：只收经 `TCVAR:20`（`{i}` 槽）
 * 能到达口上函数的编号；5001 一族（引擎内记账）与 `[SKIPSTART]` 段编号不收。
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_COUNTER_TABLE, ERATW_COUNTER_ENTRIES, createEratwCounterTable } from '../src/counter-table';

describe('ERATW_COUNTER_ENTRIES · 计数器名表（COUNTER_MESSAGE + REACTION 实测）', () => {
  it('条目数钉住（主表 75 + 反应表 9 = 84；漂移须显式改这条）', () => {
    expect(ERATW_COUNTER_ENTRIES.length).toBe(84);
    const main = ERATW_COUNTER_ENTRIES.filter((e) => e.source.startsWith('COUNTER_MESSAGE'));
    const reaction = ERATW_COUNTER_ENTRIES.filter((e) => e.source.startsWith('REACTION/'));
    expect(main.length).toBe(75);
    expect(reaction.length).toBe(9);
  });

  it('按编号升序（`lookupByName` 取首条 = 编号小者的实现前提）', () => {
    const numbers = ERATW_COUNTER_ENTRIES.map((e) => e.counter);
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(numbers).toEqual(sorted);
  });

  it('编号唯一、名非空、出处含文件名与行号（可回语料逐字核对）', () => {
    const numbers = ERATW_COUNTER_ENTRIES.map((e) => e.counter);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const e of ERATW_COUNTER_ENTRIES) {
      expect(e.label.length, `编号 ${e.counter} 的名`).toBeGreaterThan(0);
      expect(e.source, `编号 ${e.counter} 的出处`).toMatch(/^[^:]+\.ERB:\d+$/);
    }
  });

  it('只收可到达口上的编号：5001 一族（引擎内记账）与 SKIPSTART 段编号不在表内', () => {
    const numbers = new Set(ERATW_COUNTER_ENTRIES.map((e) => e.counter));
    for (const excluded of [5001, 5011, 5021, 5031, 5041]) {
      expect(numbers.has(excluded), `编号 ${excluded} 不应在表内`).toBe(false);
    }
    for (const excluded of [41, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 141, 142, 143, 144, 145]) {
      expect(numbers.has(excluded), `编号 ${excluded} 不应在表内`).toBe(false);
    }
  });

  it('抽查：名与编号逐字对上语料（含带维护注记 / 中英混排的名，原文照录）', () => {
    const byNo = new Map(ERATW_COUNTER_ENTRIES.map((e) => [e.counter, e.label]));
    expect(byNo.get(2)).toBe('偷看');
    expect(byNo.get(15)).toBe('凝视着');
    expect(byNo.get(20)).toBe('色っぽい仕草');
    expect(byNo.get(21)).toBe('见つめる 盯着看');
    expect(byNo.get(30)).toBe('接吻');
    expect(byNo.get(92)).toBe('肛门开发许可を求める（ 现在没有这个C指令 确认时点：2026年1月24日');
    expect(byNo.get(500)).toBe('膣性交');
    expect(byNo.get(510)).toBe('被玩弄乳头');
  });
});

describe('createEratwCounterTable · 查询（纯数据，无 IO）', () => {
  const table = createEratwCounterTable(ERATW_COUNTER_ENTRIES);

  it('`hasTable` 非空即 true；正查 / 反查均可命中', () => {
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('偷看')).toBe(2);
    expect(table.lookupByName('膣性交')).toBe(500);
    expect(table.lookupByNumber(2)).toBe('偷看');
    expect(table.lookupByNumber(500)).toBe('膣性交');
  });

  it('查不到的编号 / 名一律 undefined（绝不猜）', () => {
    expect(table.lookupByName('查无此名')).toBeUndefined();
    expect(table.lookupByName('')).toBeUndefined();
    expect(table.lookupByNumber(114)).toBeUndefined();
    expect(table.lookupByNumber(99999)).toBeUndefined();
  });

  it('逐条回环：每条 `lookupByNumber(counter)` 逐字等于原名', () => {
    for (const e of ERATW_COUNTER_ENTRIES) {
      expect(table.lookupByNumber(e.counter), `编号 ${e.counter}`).toBe(e.label);
    }
  });

  it('同名多编号取编号小者（3/128 搭话、28/78 尻ズリ、50/502 手淫、52/505 素股、53/504 乳交、55/601 肛门爱抚）', () => {
    expect(table.lookupByName('搭话')).toBe(3);
    expect(table.lookupByName('尻ズリ')).toBe(28);
    expect(table.lookupByName('手淫')).toBe(50);
    expect(table.lookupByName('素股')).toBe(52);
    expect(table.lookupByName('乳交')).toBe(53);
    expect(table.lookupByName('肛门爱抚')).toBe(55);
    // 反查仍拿得到大编号那侧（编号→名不受同名首条影响）
    expect(table.lookupByNumber(128)).toBe('搭话');
    expect(table.lookupByNumber(502)).toBe('手淫');
    expect(table.lookupByNumber(601)).toBe('肛门爱抚');
  });

  it('builder 对任意条目表同口径（含乱序输入：首条按**输入先后**先到先得）', () => {
    const t = createEratwCounterTable([
      { counter: 9, label: '乙', source: 'X.ERB:1' },
      { counter: 3, label: '甲', source: 'X.ERB:2' },
    ]);
    expect(t.hasTable).toBe(true);
    expect(t.lookupByName('甲')).toBe(3);
    expect(t.lookupByName('乙')).toBe(9);
    // 同名重号：先到者不覆盖（表内以升序条目为单一真源，此处钉实现口径）
    const dup = createEratwCounterTable([
      { counter: 128, label: '搭话', source: 'X.ERB:1' },
      { counter: 3, label: '搭话', source: 'X.ERB:2' },
    ]);
    expect(dup.lookupByName('搭话')).toBe(128);
  });

  it('空表 → `hasTable=false`，查啥都 undefined（名路径 fail-closed 的判据）', () => {
    expect(EMPTY_COUNTER_TABLE.hasTable).toBe(false);
    expect(EMPTY_COUNTER_TABLE.lookupByName('偷看')).toBeUndefined();
    expect(EMPTY_COUNTER_TABLE.lookupByNumber(2)).toBeUndefined();
  });

  it('`names()` 正向枚举（IX-1）：条目原序去重，与 `lookupByName` 取首条同口径', () => {
    const names = table.names?.();
    expect(names).toBeDefined();
    const expected: string[] = [];
    const seen = new Set<string>();
    for (const e of ERATW_COUNTER_ENTRIES) {
      if (seen.has(e.label)) continue;
      seen.add(e.label);
      expected.push(e.label);
    }
    expect(names).toEqual(expected);
    // 展示序首条 = 编号最小者 ⇒ 正查回到同一编号（补全候选序与取首条不打架）
    expect(table.lookupByName(names![0]!)).toBe(ERATW_COUNTER_ENTRIES[0]!.counter);
    expect(EMPTY_COUNTER_TABLE.names?.()).toEqual([]);
  });
});
