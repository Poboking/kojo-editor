/**
 * 族头**单一真源**闸（显示层 `ERB_VARIABLE_FAMILY_HEADS` ⇄ 共用词表 `ENGINE_VARIABLE_*`）
 *
 * ## 为什么要有这把闸（K6 立项时是"两份手抄 + 台账"）
 * `.erb` 的变量族头曾经存在**两份手抄**：宿主 `erb-language.ts` 的 Monarch 串，与
 * `ENGINE_VARIABLE_FAMILIES`（族头补全 / 成员补全 / `.kojo` 族头档的来源）。两份各改各的
 * ⇒ 漂移的用户可见形态就是「屏上有颜色但 `CF|` 补不出来」或反过来。K6 把双向差集钉成
 * 台账（30 枚显示层独收 + 1 枚 `JVEL`），并写明"单源收口留后续批"。
 *
 * ## LAU-D2（2026-10-27）：台账收口，词形外指出清
 * 那 30 枚按三组（引擎作用域标量 / 语言层槽位 / 引擎别名与展开形）登记进共用词表
 * `@kojo/kojo-vocab/engine`，显示层改为**派生**：`ERB_VARIABLE_FAMILY_HEADS` 就是
 * `ENGINE_VARIABLE_REFERENCE_HEADS` 本体（同一数组，不是抄本）；`JVEL` 从沉默变成
 * `ENGINE_VARIABLE_DISPLAY_SUPPRESSED`（显式剔除，等拼写裁决另案）。
 * 于是本闸的判据从"双向差集 == 手抄台账"变成**结构断言**：
 * - 显示层 == 共用词表本体（`toBe`，比 `toEqual` 更强：连拷贝都不许）；
 * - 显示层 − 字典侧 == 词表登记的三组专收（一枚不多、一枚不少）；
 * - 字典侧 − 显示层 == 词表登记的显式剔除（当前只 `JVEL`）。
 *
 * 口径不变：收**引擎级**词，**不许收作品专名**（`ROOMDATA` / `C_ID` / `CHILDNAME` 归 adapter）。
 * 取证链（K6 / 收尾裁决批）留在共用词表与 `erb-language.ts` 的块注释里。
 */

import { describe, expect, it } from 'vitest';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/plugin-kojo-sugar';
import {
  ENGINE_FAMILY_ALIAS_HEADS,
  ENGINE_VARIABLE_DISPLAY_SUPPRESSED,
  ENGINE_VARIABLE_REFERENCE_HEADS,
  ENGINE_VARIABLE_SCOPE_HEADS,
  ERB_SLOT_HEADS,
} from '@kojo/kojo-vocab/engine';
import { ERB_VARIABLE_FAMILY_HEADS, ERB_VARIABLE_REF_PATTERN } from '../src/monaco/erb-language';
import { ERB_COMMANDS, ERB_FAMILY_HEADS } from '../src/monaco/kojo-language';

const setOf = (words: readonly string[]): Set<string> => new Set(words);
const diff = (a: readonly string[], b: readonly string[]): string[] =>
  [...setOf(a)].filter((x) => !setOf(b).has(x)).sort();

/** 共用词表登记的三组**显示层专收**（不是台账，是词表本体的一部分） */
const DISPLAY_GROUPS: readonly (readonly string[])[] = [
  ENGINE_VARIABLE_SCOPE_HEADS,
  ERB_SLOT_HEADS,
  ENGINE_FAMILY_ALIAS_HEADS,
];

describe('族头单一真源 · 名单形态', () => {
  it('显示层就是共用词表本体（同一数组对象，连拷贝都不许）；无重复、全大写 ASCII 词形', () => {
    expect(ERB_VARIABLE_FAMILY_HEADS).toBe(ENGINE_VARIABLE_REFERENCE_HEADS);
    expect(ERB_VARIABLE_FAMILY_HEADS.length).toBeGreaterThan(0);
    expect(new Set(ERB_VARIABLE_FAMILY_HEADS).size).toBe(ERB_VARIABLE_FAMILY_HEADS.length);
    for (const w of ERB_VARIABLE_FAMILY_HEADS) {
      expect(w, `族头 ${w} 不是合法引擎标识符形`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(new Set(ENGINE_VARIABLE_FAMILIES).size).toBe(ENGINE_VARIABLE_FAMILIES.length);
  });

  it('名单 == 规则里真正出现的集合（erb-language.ts 内不许再抄第二份词形）', () => {
    // 族头只含 `[A-Z0-9_]` ⇒ alternation 体内不含 `)`，`[^)]*` 抽取无歧义
    const body = /\(\?:([^)]*)\)/.exec(ERB_VARIABLE_REF_PATTERN.source)?.[1];
    expect(body, `抽不到 alternation 主体，正则形态变了：${ERB_VARIABLE_REF_PATTERN.source}`).toBeTruthy();
    const inRegex = (body ?? '').split('|').map((s) => s.replace(/\\(.)/g, '$1')).sort();
    expect(inRegex).toEqual([...ERB_VARIABLE_FAMILY_HEADS].sort());
  });

  it('K6 落点正面钉：`MASTERNAME` 两处在册；收尾裁决钉：`ITEM` 两处在册（补全随之同认）', () => {
    expect(ERB_VARIABLE_FAMILY_HEADS).toContain('MASTERNAME');
    expect(ENGINE_VARIABLE_FAMILIES).toContain('MASTERNAME');
    expect(ERB_VARIABLE_FAMILY_HEADS).toContain('ITEM');
    expect(ENGINE_VARIABLE_FAMILIES).toContain('ITEM');
    // 裁决规则"零回退优先"的名单面快照：被点名保留的重度在用族头一枚不许缺
    for (const w of ['MARK', 'NOWEX', 'SOURCE', 'TEQUIP', 'EXP', 'BASE', 'RESULTS', 'MAXBASE', 'EQUIP', 'ITEM', 'STAIN', 'CUP', 'ASSI', 'CDOWN', 'LOSEBASE', 'PALAMLV', 'GOTJUEL']) {
      expect(ERB_VARIABLE_FAMILY_HEADS, `${w} 语料在用，着色不许缺席`).toContain(w);
    }
    // `ITEM` 进字典侧必须放清单**末尾**（resolveFamily 族表顺序即优先级 ⇒ 不许抢既有族的归属）
    expect(ENGINE_VARIABLE_FAMILIES[ENGINE_VARIABLE_FAMILIES.length - 1]).toBe('ITEM');
  });

  it('K6 取舍钉：`PLAYER` 只进显示层；`CHILDNAME` + 反证三枚（引擎串面查无 ∧ 语料 0 行）两处都不进', () => {
    expect(ERB_VARIABLE_FAMILY_HEADS).toContain('PLAYER');
    expect(ENGINE_VARIABLE_FAMILIES).not.toContain('PLAYER');
    const refused: readonly [string, string][] = [
      ['CHILDNAME', '作品自造变量（DIM.ERH 的 #DIMS 声明），不许进语言层名单'],
      ['MONSTER_ACTION', '引擎串面查无 + 语料 0 行（K6 收尾裁决的反证三枚之一），不许顺手加回来'],
      ['MONSTER_EXPLV', '引擎串面查无 + 语料 0 行（K6 收尾裁决的反证三枚之一），不许顺手加回来'],
      ['DUMMY_EXT', '引擎串面查无 + 语料 0 行（K6 收尾裁决的反证三枚之一），不许顺手加回来'],
    ];
    for (const list of [ERB_VARIABLE_FAMILY_HEADS, ENGINE_VARIABLE_FAMILIES]) {
      for (const [word, reason] of refused) {
        expect(list, `${word}：${reason}`).not.toContain(word);
      }
    }
    for (const word of ['ROOMDATA', 'C_ID', 'K69_CNUM', 'GENSOKYO_WEATHER_SYSTEM', 'MAPROW_COLORS']) {
      expect(ERB_VARIABLE_FAMILY_HEADS, `${word} 是具体游戏约定`).not.toContain(word);
    }
  });
});

describe('族头单一真源 · 差集 = 词表登记的三组专收 + 显式剔除（结构，不是台账）', () => {
  it('方向 A（字典 ⇒ 显示）：字典侧每枚都在显示层，唯一例外是**显式剔除**的 `JVEL`', () => {
    const gap = diff(ENGINE_VARIABLE_FAMILIES, ERB_VARIABLE_FAMILY_HEADS);
    expect(gap, `补得出却没颜色：${gap.join(' / ')}`).toEqual([...ENGINE_VARIABLE_DISPLAY_SUPPRESSED].sort());
    expect(ENGINE_VARIABLE_DISPLAY_SUPPRESSED).toEqual(['JVEL']);
  });

  it('方向 B（显示 ⇒ 字典）：显示层独收的每枚都在词表的三组里（不是散落在宿主的例外）', () => {
    const declared = DISPLAY_GROUPS.flat();
    expect(new Set(declared).size, '三组之间不许重登').toBe(declared.length);
    for (const w of declared) expect(ERB_VARIABLE_FAMILY_HEADS, `词表登记的 ${w} 没进显示层`).toContain(w);
    for (const w of declared) expect(ENGINE_VARIABLE_FAMILIES, `词表登记的 ${w} 同时出现在字典侧（它该只在一边）`).not.toContain(w);
    const gap = diff(ERB_VARIABLE_FAMILY_HEADS, ENGINE_VARIABLE_FAMILIES);
    expect(gap, `有颜色但不在词表三组里：${gap.join(' / ')}`).toEqual([...declared].sort());
  });

  it('差集规模钉死：显示层独收 30 枚 + 剔除 1 枚（K6 台账 31 枚原样收口，不许借机扩面）', () => {
    expect(DISPLAY_GROUPS.flat()).toHaveLength(30);
    expect(ERB_VARIABLE_FAMILY_HEADS).toHaveLength(51);
    expect(ENGINE_VARIABLE_FAMILIES).toHaveLength(22);
  });

  it('`JVEL` 不吃的着色面不许偷偷回来：裸形 / 索引形都不归 variable', () => {
    expect(ERB_VARIABLE_REF_PATTERN.exec('JVEL')?.[0] ?? '').toBe('');
    expect(ERB_VARIABLE_REF_PATTERN.exec('IF JVEL == 1')?.[0] ?? '').toBe('');
  });
});

describe('K6 · `.kojo` 派生面跟变（零回退，宿主不许另抄）', () => {
  it('`ERB_FAMILY_HEADS` 就是 `ENGINE_VARIABLE_FAMILIES` 本体；`MASTERNAME` 随之进 `.kojo` 族头档', () => {
    // kojo-language.ts 的派生式：`export const ERB_FAMILY_HEADS = ENGINE_VARIABLE_FAMILIES`
    expect(ERB_FAMILY_HEADS).toBe(ENGINE_VARIABLE_FAMILIES);
    expect(ERB_FAMILY_HEADS).toContain('MASTERNAME');
    // 族头不许混进 `.kojo` 的原生指令档（两档着色口径打架）
    expect(ERB_COMMANDS, 'MASTERNAME 混进指令档').not.toContain('MASTERNAME');
    expect(ERB_COMMANDS).not.toContain('PLAYER');
  });
});

describe('K6 名单真的喂给了规则（正则行为，不只看清单）', () => {
  const headMatch = (line: string): string => ERB_VARIABLE_REF_PATTERN.exec(line)?.[0] ?? '';

  it('`MASTERNAME:1 = 亲爱的` 整段吃掉到空格前（与 CFLAG 同形态）', () => {
    expect(headMatch('MASTERNAME:1 = 亲爱的')).toBe('MASTERNAME:1');
    expect(headMatch('MASTERNAME:ARG')).toBe('MASTERNAME:ARG');
  });

  it('`PLAYER` 裸读与中段作用域形都归 variable；中段不被当族头起界（`TALENT:PLAYER:2` 仍一整枚）', () => {
    expect(headMatch('PLAYER == 1')).toBe('PLAYER');
    // 行内多个引擎词各自成枚（`LOCAL` 与 `PLAYER` 都是名单词），互不吞并
    // （规则本体不带 `g`，这里现造一份全局副本只为本行多次取枚）
    const globalCopy = new RegExp(ERB_VARIABLE_REF_PATTERN.source, 'g');
    const all = [...'IF LOCAL == PLAYER'.matchAll(globalCopy)].map((m) => m[0]);
    expect(all).toEqual(['LOCAL', 'PLAYER']);
    expect(headMatch('TALENT:PLAYER:2 & 2')).toBe('TALENT:PLAYER:2');
  });

  it('既有口径零回退：`;` 截尾（注释不被吞）、`STAIN` 与 `STAIN_1` 各归其形', () => {
    expect(headMatch('CFLAG:ARG;说明')).toBe('CFLAG:ARG');
    expect(headMatch('STAIN_1:2')).toBe('STAIN_1:2');
    expect(headMatch('STAIN:2')).toBe('STAIN:2');
  });

  it('收尾裁决：`ITEM` 数字形与具名形（真语料 `CASINO.ERB` 原样词形）都归 variable', () => {
    expect(headMatch('ITEM:100 = 1')).toBe('ITEM:100');
    expect(headMatch('IF !ITEM:紅魔賭場VIP会員証')).toBe('ITEM:紅魔賭場VIP会員証');
    expect(headMatch('SIF ITEM:ARG >= 999')).toBe('ITEM:ARG');
  });
});
