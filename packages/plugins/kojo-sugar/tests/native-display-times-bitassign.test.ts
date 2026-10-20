/**
 * 兜底长尾三支的中性显示形（TAIL-2，2026-10-20）——`native-display/statement.ts` 的第三档补登：
 *
 * 1. **`TIMES <引用>, <数值>`** ⇒ `乘算 <目标> × <数值>`（小数乘算赋值）。
 *    真语料 3,143 行**全部**是"恰好一个顶层逗号 + 右值数值字面量"；语义有 Emuera 文档
 *    （ERB 構文講座「小数の乗算」：`TIMES A, 1.5` ⇔ `A = A × 1.5`）⇒ 只做这一形，
 *    其余形状（无逗号 / 多逗号 / 右值非数值）一律 `null`；
 * 2. **`LOCALS '=`** ⇒ 既有赋值形的运算符表补一枚 `'=`（ver1813 起的字符串赋值运算符，
 *    与 `=` 同义但只收字符串表达式）。**运算符记号原样保留**——写侧两者不是同一个写法；
 * 3. **`|=`** ⇒ 同一张运算符表补 `|=`（按位或赋值）。族头照旧走别名 / 语言层槽位，
 *    查不到别名就落既有 `赋值 …` 数据行档。
 *
 * 三条尺子与 `native-display-statement.test.ts` / `native-display-data-line.test.ts` 完全同一条：
 * 精确形 + 红线（`isVerbatimNativeLine` 恒 false）+ 认不出必须 `null`（宁缺勿猜）。
 * 第四组是**负例**：普通赋值（`=` / `+=` / `-=`）的输出一个字符都不许被新运算符改写。
 */

import { describe, expect, it } from 'vitest';
import { FAMILY_ALIASES_REVERSE } from '@kojo/plugin-eratw-adapter';
import { renderStatementLine } from '../src/native-display/statement';
import { lookupKeyword } from '../src/keywords';
import { isVerbatimNativeLine } from '../src/native-display/types';
import type { NativeDisplayInput, NativeDisplayLookup } from '../src/native-display/types';
import { localizeNativeLine } from '../src/native-display/passes';

/** 与其余 native-display 用例表同一份桩：别名取 adapter 真表，零手抄 */
const DICT: NativeDisplayLookup = {
  familyAlias: (f) => FAMILY_ALIASES_REVERSE[f],
  slotCn: () => undefined,
};

const render = (content: string, lookup?: NativeDisplayLookup): string | null =>
  renderStatementLine({ content, indent: 0, lookup } satisfies NativeDisplayInput);

type Case = readonly [line: string, lookup: NativeDisplayLookup | undefined, expected: string];

/* ============================================================================
 * 一、`TIMES`：只认"一个顶层逗号 + 数值右值"那一形（盘面形状逐条照抄）
 * ========================================================================== */

const TIMES_CASES: readonly Case[] = [
  // 盘上最大头（SOURCE 1,586 行 / LOCAL 857 行 / CUP 326 行）各抽一形
  ['TIMES SOURCE:CHARA:征服,0.50', DICT, '乘算 欲求:CHARA:征服 × 0.50'],
  ['TIMES LOCAL, 2.0', undefined, '乘算 局部 × 2.0'],
  ['TIMES CUP:ARG:屈服 , 1.10', DICT, '乘算 参数上升:ARG:屈服 × 1.10'],
  ['TIMES FLAG:筹码流通, 0.98', DICT, '乘算 标记:筹码流通 × 0.98'],
  ['TIMES DOWNBASE:ARG:苦痛, 1.50', DICT, '乘算 基础上降:ARG:苦痛 × 1.50'],
  // 作者自造名 / 宏风格引用 / 带函数调用索引的引用：形状判据逐字带走
  ['TIMES ダメージ補正, 1.5', DICT, '乘算 ダメージ補正 × 1.5'],
  ['TIMES CHARA_JUDGMENT, 1.', DICT, '乘算 CHARA_JUDGMENT × 1.'],
  ['TIMES Prc:(ARG/100-1):(ARG%100),1.3', DICT, '乘算 Prc:(ARG/100-1):(ARG%100) × 1.3'],
  // 空白变体与行尾注释：运算符两侧空白重铺，载荷数字一字不动
  ['TIMES  SOURCE:苦痛 , 1.50', DICT, '乘算 欲求:苦痛 × 1.50'],
  ['TIMES LOCAL, 0.5 ;尾注', undefined, '乘算 局部 × 0.5 ;尾注'],
];

describe.each(TIMES_CASES)('TIMES 显示形 · %s', (line, lookup, expected) => {
  it('精确形 + 红线自证 + 装配点同一结果', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered).not.toBe(line);
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
    expect(localizeNativeLine({ content: line, indent: 0, lookup })).toBe(expected);
  });
});

/* ============================================================================
 * 二、`LOCALS '=`：字符串赋值运算符（记号保留，目标照旧中文化）
 * ========================================================================== */

const STRING_ASSIGN_CASES: readonly Case[] = [
  ['LOCALS \'= CAPITALIZE(LOCALS)', undefined, '局部$ \'= CAPITALIZE(LOCALS)'],
  ['LOCALS \'= @"□ %ARGS:0% □"', undefined, '局部$ \'= @"□ %ARGS:0% □"'],
  ['LOCALS:0 \'= "笑顔"', undefined, '局部$:0 \'= "笑顔"'],
  ['LOCALS \'= DT_CELL_GETS("bbas_dataset", 選択中キャラID, "臉型", 1)', undefined, '局部$ \'= DT_CELL_GETS("bbas_dataset", 選択中キャラID, "臉型", 1)'],
  ['RESULTS \'= TOSTR(LOCAL)', undefined, '结果$ \'= TOSTR(LOCAL)'],
  // 查不到别名的作者字符串变量 ⇒ 走既有 `赋值 …` 数据行档（词头换中文、载荷逐字）
  ['MyStr$ \'= "x"', DICT, '赋值 MyStr$ \'= "x"'],
];

describe.each(STRING_ASSIGN_CASES)('LOCALS \'= 显示形 · %s', (line, lookup, expected) => {
  it('精确形 + 红线自证 + 运算符记号未被改写成 `=`', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered).not.toBe(line);
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
    expect(rendered ?? '').toContain("'=");
  });
});

/* ============================================================================
 * 三、`|=`：按位或赋值（族头别名通路 + 数据行档两条路都钉）
 * ========================================================================== */

const BIT_OR_ASSIGN_CASES: readonly Case[] = [
  ['CFLAG:1013 |= 4', DICT, '角色标志:1013 |= 4'],
  ['STAIN:PLAYER:2 |= 4', DICT, '污渍:PLAYER:2 |= 4'],
  ['TALENT:ARG:0 |= 2', DICT, '素质:ARG:0 |= 2'],
  ['ROOMDATA:ROOM |= 場所_広場', DICT, '赋值 ROOMDATA:ROOM |= 場所_広場'],
  ['ROOMDATA:(默认初期位置 % 100) |= 場所_被窝', DICT, '赋值 ROOMDATA:(默认初期位置 % 100) |= 場所_被窝'],
  ['ADD_SEX_MODULE_COM_ORDER_TEMP |= 1', undefined, '赋值 ADD_SEX_MODULE_COM_ORDER_TEMP |= 1'],
];

describe.each(BIT_OR_ASSIGN_CASES)('|= 显示形 · %s', (line, lookup, expected) => {
  it('精确形 + 红线自证 + 运算符记号未被改写成 `=`', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered).not.toBe(line);
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
    expect(rendered ?? '').toContain('|=');
  });
});

/* ============================================================================
 * 四、负例：普通赋值不被误判（新运算符只多认两枚记号，旧形一个字符都不动）
 * ========================================================================== */

const PLAIN_ASSIGN_CASES: readonly Case[] = [
  ['LOCAL = 1', undefined, '局部 = 1'],
  ['LOCALS = "x"', undefined, '局部$ = "x"'],
  ['LOCALS += " "', undefined, '局部$ += " "'],
  ['LOCAL:1 -= 2', undefined, '局部:1 -= 2'],
  ['CFLAG:100 = 1', DICT, '角色标志:100 = 1'],
  ['服装 = 裸', DICT, '赋值 服装 = 裸'],
];

describe.each(PLAIN_ASSIGN_CASES)('普通赋值不被误判 · %s', (line, lookup, expected) => {
  it('输出与既有口径逐字相同，且不含 `\'=` / `|=`', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered ?? '').not.toContain("'=");
    expect(rendered ?? '').not.toContain('|=');
  });
});

/* ============================================================================
 * 五、负自证：不猜的形状一律 `null`
 * ========================================================================== */

const NULL_CASES: readonly string[] = [
  'TIMES LOCAL', // 缺逗号
  'TIMES LOCAL, VALUE', // 右值不是数值字面量（语料零样本）
  'TIMES LOCAL, 1.5, 2', // 多个顶层逗号
  'TIMES LOCAL,', // 空右值
  'TIMES , 1.5', // 空目标
  'TIMES 3, 1.5', // 目标不是引用
  'times LOCAL, 1.5', // 引擎记号按大写写法；小写不猜
  'LOCALS \'=', // 空右值（与 `S =` 同档）
  'LOCAL |=', // 空右值
  'LOCAL == 1', // 比较不是赋值
  'LOCAL:1 <> 2',
  'IF A |= B', // 组外空白 ⇒ 不是"一个引用"，条件行仍归 ZH-C
];

describe.each(NULL_CASES)('负自证 · "%s" ⇒ null', (line) => {
  it('认不出必须 null（有 lookup 与无 lookup 两档都核）', () => {
    expect(render(line, DICT)).toBeNull();
    expect(render(line, undefined)).toBeNull();
  });
});

/* ============================================================================
 * 六、显示形不承诺可写：新词头 `乘算` 不进 `KEYWORDS`
 * ========================================================================== */

describe('反证 · 显示词头没有写侧通路', () => {
  it('`乘算` 不在 `KEYWORDS`（登记 = 承诺写得回去，本档不承诺）', () => {
    expect(lookupKeyword('乘算')).toBeUndefined();
  });
});
