/**
 * K6 · 族头名单双向对拍闸（显示层 `ERB_VARIABLE_FAMILY_HEADS` ⇄ 字典层 `ENGINE_VARIABLE_FAMILIES`）
 *
 * ## 为什么要这把闸
 * `.erb` 的变量族头今天存在**两份手抄**：
 * ① `packages/app/src/monaco/erb-language.ts` 的 `ERB_VARIABLE_FAMILY_HEADS`（Monarch `variable` 着色，
 *    规则由它现建，见 `ERB_VARIABLE_REF_PATTERN`）；
 * ② `@kojo/plugin-kojo-sugar` 的 `ENGINE_VARIABLE_FAMILIES`（`.erb` 族头补全候选源
 *    `erb-completion-families.ts` / 成员补全 `erb-completion-members.ts` / `.kojo` 的
 *    `ERB_FAMILY_HEADS` 都从它派生）。
 * 两份各改各的 ⇒ 漂移的用户可见形态就是「屏上有颜色但 `CF|` 补不出来」或反过来。本闸把两边的
 * **双向差集钉成台账**：任何一侧新增/删收族头，只要没同时动另一侧或没在台账里留理由，当场红。
 * 台账是**只许收窄**的债务表——单源收口（两边合成一张表）留后续批，收一枚就该把那条删掉。
 *
 * ## 口径（为什么现在还不是同一张表）
 * ②按"具名索引族"建表（名字写在冒号后面、要换算成编号的那批）；①还要收**引擎作用域/上下文标量**
 * （`MASTER` / `TARGET` / `PLAYER` / `ARG` / `RESULTS` / `DAY` …，语料里多是 `TALENT:PLAYER:2` 的中段与裸读），
 * 否则这些高频引擎词整行白字。两类都不许收**作品专名**（`ROOMDATA` / `C_ID` / `CHILDNAME` 归 adapter）。
 *
 * ## 本批（K6）落的两枚 + 收尾裁决批补的一枚
 * - `MASTERNAME` → **两处都进**（引擎内建字符串族，与 `CALLNAME` 同形；语料 12,272 处族头形 / 149 份，
 *   全树 0 处 `#DIM` 系声明，引擎二进制名字堆有 `_MASTERNAME`）。
 * - `PLAYER` → **只进显示层**（语料 0 处 `PLAYER:` 族头形；`eratw-adapter` 的 `ENGINE_FAMILIES`
 *   把它明确划在"执行上下文量"表外）⇒ 落在 `DISPLAY_ONLY` 台账里，理由随条目登记。
 * - `CHILDNAME` → **两处都不进**（`ERB/DIM.ERH:465` `#DIMS CHARADATA SAVEDATA CHILDNAME, 101` 是作品声明，
 *   引擎二进制 0 命中 ⇒ 具体游戏约定，铁律 3）；本文件末组把它钉成"不许顺手加回来"。
 * - **`ITEM` → 两处都进（K6 收尾裁决 2026-10-25）**：零回退口径——`ITEM:` 语料 1,713 行 / 507 份在用、
 *   引擎串面点名有、具名索引 1,200 处且 `CSV/Item.csv` 主表在盘 ⇒ 走"进 `ENGINE_VARIABLE_FAMILIES`
 *   让补全同认"的方案①（放清单末尾 = `resolveFamily` 首中胜次序零反转）。同批把
 *   `MONSTER_ACTION` / `MONSTER_EXPLV` / `DUMMY_EXT`（引擎串面查无 + 语料 0 行 = 唯一拿到反证的三项）
 *   与 `CHILDNAME` 一起钉成拒收。
 */

import { describe, expect, it } from 'vitest';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/plugin-kojo-sugar';
import { ERB_VARIABLE_FAMILY_HEADS, ERB_VARIABLE_REF_PATTERN } from '../src/monaco/erb-language';
import { ERB_COMMANDS, ERB_FAMILY_HEADS } from '../src/monaco/kojo-language';

const setOf = (words: readonly string[]): Set<string> => new Set(words);
const diff = (a: readonly string[], b: readonly string[]): string[] =>
  [...setOf(a)].filter((x) => !setOf(b).has(x)).sort();

/**
 * 台账 A：**着色有、补全无**（显示层独收的引擎作用域词与引擎别名）。
 * 每条都必须有理由——收进这张表等于承认"它今天还漂着"，单源收口批应逐条删掉它。
 */
const DISPLAY_ONLY: Readonly<Record<string, readonly string[]>> = {
  // 引擎作用域 / 上下文标量：`族:PLAYER:` 式中段与裸读，具名索引不存在 ⇒ 字典层不收（K6 取证）
  '执行上下文量': ['MASTER', 'TARGET', 'ASSI', 'NO', 'SELECTCOM', 'RAND', 'DAY', 'TIME', 'MONEY', 'PLAYER'],
  // 语言层槽位词（`.erb` 里是局部/实参/返回槽，不是游戏字典族）
  '语言层槽位': ['ARG', 'ARGS', 'LOCAL', 'LOCALS', 'RESULTS'],
  // 引擎给同一名表另开的头 / 二维展开形（字典侧只认主名，收两枚会让 resolveFamily 抢归属）
  '引擎别名与展开形': ['CDFLAG', 'CSTR', 'TSTR', 'EX', 'JUEL', 'MAXBASE', 'RELATION', 'EQUIP', 'CDOWN', 'UP', 'DOWN', 'LOSEBASE', 'PALAMLV', 'STAIN_1', 'STAIN_2'],
};

/**
 * 台账 B：**补全有、着色无**（只余 `JVEL` 一枚）。
 * 疑点：语料（eraTW 4.980 的 `ERB/`）里 `JVEL` **0 份**、`JUEL` 114 份，盘上名称表是 `CSV/Juel.csv`+`Juel.als`，
 * 引擎二进制名字堆 `JUEL` 8 命中 / `JVEL` 0 命中 ⇒ `JVEL` 疑为 `ENGINE_VARIABLE_FAMILIES` 的历史拼误
 * （`eratw-adapter` 的教学表与 scaffold 夹具把它当"认账族头"原样抄了）。
 * 本批不擅自改拼写（会动转译器的族归属与用户面文案），已交 lead 决；台账钉死 ⇒ 谁修谁删这一行。
 */
const COMPLETION_ONLY: readonly string[] = ['JVEL'];

describe('K6 族头双向对拍 · 名单形态', () => {
  it('显示层名单无重复、全大写 ASCII 词形（引擎标识符大小写不敏感 ⇒ 只存一种写法）', () => {
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

describe('K6 族头双向对拍 · 双向差集必须等于台账', () => {
  it('方向 A（补全 ⇒ 着色）：`ENGINE_VARIABLE_FAMILIES` 每枚都在 Monarch 名单里，余差集逐字等于台账 B', () => {
    const gap = diff(ENGINE_VARIABLE_FAMILIES, ERB_VARIABLE_FAMILY_HEADS);
    expect(gap, `补得出却没颜色（新漂移或台账该改）：${gap.join(' / ')}`).toEqual([...COMPLETION_ONLY].sort());
  });

  it('方向 B（着色 ⇒ 补全）：Monarch 独收的每枚都在台账 A 里有条目，差集逐字相等', () => {
    const declared = Object.values(DISPLAY_ONLY).flat();
    expect(new Set(declared).size).toBe(declared.length); // 台账内部不许重登
    for (const w of declared) expect(ERB_VARIABLE_FAMILY_HEADS, `台账里的 ${w} 已不在名单（台账该删）`).toContain(w);
    for (const w of declared) expect(ENGINE_VARIABLE_FAMILIES, `台账里的 ${w} 其实已被字典层收（台账该删）`).not.toContain(w);
    const gap = diff(ERB_VARIABLE_FAMILY_HEADS, ENGINE_VARIABLE_FAMILIES);
    expect(gap, `有颜色但补不出来（新漂移或台账该改）：${gap.join(' / ')}`).toEqual([...declared].sort());
  });

  it('台账规模钉死（只许收窄）：两边差集合计 = 31 枚，收口一枚就删一行', () => {
    const total =
      diff(ENGINE_VARIABLE_FAMILIES, ERB_VARIABLE_FAMILY_HEADS).length +
      diff(ERB_VARIABLE_FAMILY_HEADS, ENGINE_VARIABLE_FAMILIES).length;
    expect(total).toBe(COMPLETION_ONLY.length + Object.values(DISPLAY_ONLY).flat().length);
    expect(total).toBeLessThanOrEqual(31);
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
