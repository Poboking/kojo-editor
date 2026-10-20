/**
 * **数据行（赋值 / 表达式）的中文显示形**——`native-display/statement.ts` 的第二档
 * （2026-10-20 兜底归因收口：挂盘 `other` 桶 9,026 行的大头不是"没人认识的语句"，
 * 而是**本来就没有语句形**的行）。
 *
 * 钉四类形状（每类都对着归因读数里的一个记号格子）：
 * 1. **CJK / 作者自造左值**（`順位` 360 / `残りムシ数` 264 / `重复空格裁剪` 231 / `前回指令` 162 /
 *    `台詞` 125 / `K53_` 114 / `制限时间` 98 / `表情` 96 …）⇒ `赋值 <原文>`；
 * 2. **带 `%…%` 或函数调用索引的引用左值**（`CFLAG` 548 / `EXP` 310 / `LOCALS` 200 / `TCVAR` 126 /
 *    `ORINQI` 108 / `RELATION` 104 / `GETMILLISECOND` 148 那一格里"嵌套括号 / `%宏%` 索引"的子形）；
 * 3. **逗号式赋值 `VARSET`**（359）与**带参数的排版原语** `CLEARLINE`（395）/ `HTML_PRINT`（223）/
 *    `FONTREGULAR`（147）/ `FONTSTYLE`（93）与调用族 `CALLF`（245）；
 * 4. **反证**：这些行**不许被当成语句写回去**（词头不进 `KEYWORDS`），也不许把别的层的行抢过来
 *    （台词 `「…」`、`{`/`}` 装饰行、`PRINT*` 表外变体、`FOR` 异形、比较式一律仍 `null`）。
 *
 * 三条尺子与 `native-display-statement.test.ts` 完全同一条（不另开口径）：
 * 精确形 + 红线（`isVerbatimNativeLine` 恒 false）+ 认不出必须 `null`（宁缺勿猜）。
 * 样例行的文件名与行号照抄盘面（`M_KOJO_K1_2_functions.ERB:12/14/16`，正文一字未改），
 * 判据不许对着想象的形状写。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { FAMILY_ALIASES_REVERSE } from '@kojo/plugin-eratw-adapter';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { classifyLine, splitLogicalLines, type LineClass } from '../src/lexer';
import { lookupKeyword } from '../src/keywords';
import { isDataReference, renderStatementLine } from '../src/native-display/statement';
import { renderControlLine } from '../src/native-display/control';
import { localizeNativeLine } from '../src/native-display/passes';
import { countVerbatimNativeLines, isVerbatimNativeLine } from '../src/native-display/types';
import type { NativeDisplayInput, NativeDisplayLookup } from '../src/native-display/types';

/** 与 `tests/native-display-statement.test.ts` 同一份桩：别名取 adapter 真表，零手抄 */
const DICT: NativeDisplayLookup = {
  familyAlias: (f) => FAMILY_ALIASES_REVERSE[f],
  slotCn: () => undefined,
};

const render = (content: string, lookup?: NativeDisplayLookup): string | null =>
  renderStatementLine({ content, indent: 0, lookup } satisfies NativeDisplayInput);

/* ============================================================================
 * 一、精确形：数据行 ⇒ `赋值 <原文>`（载荷一个字符都不翻）
 * ========================================================================== */

type Case = readonly [line: string, lookup: NativeDisplayLookup | undefined, expected: string];

const DATA_LINE_CASES: readonly Case[] = [
  /* —— 盘面照抄的三行（`M_KOJO_K1_2_functions.ERB:12 / :14 / :16`）—— */
  ['表示形式 = %GET_BASESTYLE(TARGET, 表示形式)%', DICT, '赋值 表示形式 = %GET_BASESTYLE(TARGET, 表示形式)%'],
  ['服装 = 裸', DICT, '赋值 服装 = 裸'],
  ['服装 = 服', DICT, '赋值 服装 = 服'],

  /* —— CJK 左值四枚运算符 + 无空格 / 多空格形（空白按既有 `赋值 …` 形重铺，文字不动）—— */
  ['順位 = 3', undefined, '赋值 順位 = 3'],
  ['順位 -= 1', undefined, '赋值 順位 -= 1'],
  ['順位 *= 2', undefined, '赋值 順位 *= 2'],
  ['順位 /= 2', undefined, '赋值 順位 /= 2'],
  ['服装=裸', undefined, '赋值 服装 = 裸'],
  ['服装  =  服', undefined, '赋值 服装 = 服'],
  ['残りムシ数 = %CFLAG:TARGET:1%', undefined, '赋值 残りムシ数 = %CFLAG:TARGET:1%'],
  ['前回指令 = SELECTCOM', undefined, '赋值 前回指令 = SELECTCOM'],
  ['台詞 = "こんにちは"', undefined, '赋值 台詞 = "こんにちは"'],
  ['表情 = 1', undefined, '赋值 表情 = 1'],
  ['制限时间 = 10', undefined, '赋值 制限时间 = 10'],
  ['重复空格裁剪 = 0', undefined, '赋值 重复空格裁剪 = 0'],
  ['K53_変数 = 1', DICT, '赋值 K53_変数 = 1'],
  ['服装$ = "服"', undefined, '赋值 服装$ = "服"'],

  /* —— 多目标 / 链式 / 与行尾 `;` 注释共存 —— */
  ['服装, 順位 = 裸, 3', undefined, '赋值 服装, 順位 = 裸, 3'],
  ['服装 = 順位 = 3', undefined, '赋值 服装 = 順位 = 3'],
  ['服装 = 裸 ;初期化', undefined, '赋值 服装 = 裸 ;初期化'],
  ['K53_変数 = 1 ;盘面同款尾注', DICT, '赋值 K53_変数 = 1 ;盘面同款尾注'],

  /* —— 引用左值：嵌套括号 / `%宏%` 里嵌函数调用（这些形状过去被 `TARGET_RE` 生拒 ⇒ 整行落兜底）—— */
  ['CFLAG:100(CHARA_NO(TARGET)) = 1', DICT, '赋值 CFLAG:100(CHARA_NO(TARGET)) = 1'],
  ['CFLAG:%GET_FLAG(TARGET)% = 1', DICT, '赋值 CFLAG:%GET_FLAG(TARGET)% = 1'],
  ['TCVAR:%F(TARGET)% = 2', DICT, '赋值 TCVAR:%F(TARGET)% = 2'],
  ['GETMILLISECOND(A(B)) = 1', undefined, '赋值 GETMILLISECOND(A(B)) = 1'],
  ['ORINQI%1 = 2', DICT, '赋值 ORINQI%1 = 2'],
  ['%MACRO% = 1', undefined, '赋值 %MACRO% = 1'],

  /* —— 引擎族头 + 数字索引：**仍走原有别名通路**（本档不抢已有形，读数只补漏网形状）—— */
  ['CFLAG:1088 = 1', DICT, '角色标志:1088 = 1'],
  ['TCVAR:100 = 1', DICT, '临时角色变量:100 = 1'],
  ['LOCALS:1 = "A"', undefined, '局部$:1 = "A"'],
];

describe.each(DATA_LINE_CASES)('数据行显示形 · %s', (line, lookup, expected) => {
  it('精确形命中 + 红线自证（非 null、非原样、非逐字整行 ERB）', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered).not.toBeNull();
    expect(rendered).not.toBe(line);
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
    // `赋值 …` 档的额外尺子：去掉词头、重铺的空白抹掉后**与源行逐字相同**
    // ⇒ 本档一个字符都没翻译（左值名不翻、`%…%` 不反糖），只换了词头。
    if (expected.startsWith('赋值 ')) {
      expect(rendered!.replace(/^赋值 /, '').replace(/\s+/g, '')).toBe(line.replace(/\s+/g, ''));
    }
  });
});

/* ============================================================================
 * 二、`VARSET` / 带参数的排版原语 / `CALLF`（第②类：本来就没有语句形的原语）
 * ========================================================================== */

const PRIMITIVE_CASES: readonly Case[] = [
  ['VARSET LOCAL:1, 0', undefined, '赋值 LOCAL:1, 0'],
  ['VARSET %TFLAG:0, 1', DICT, '赋值 %TFLAG:0, 1'],
  ['CLEARLINE', undefined, '清空本行'],
  ['CLEARLINE 1', undefined, '清空本行 1'],
  ['HTML_PRINT <b>甲</b>', undefined, 'HTML打印 <b>甲</b>'],
  ['FONTREGULAR', undefined, '复原字体'],
  ['FONTREGULAR 1', undefined, '复原字体 1'],
  ['FONTSTYLE 12, 100, ＭＳ Ｐゴシック', undefined, '字体样式 12, 100, ＭＳ Ｐゴシック'],
  ['CALLF FOO(1)', undefined, '调用F FOO(1)'],
  ['CALLF 100, 5', undefined, '调用F 100, 5'],
];

describe.each(PRIMITIVE_CASES)('原语行显示形 · %s', (line, lookup, expected) => {
  it('中文词头 + 参数逐字带走 + 红线自证', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
    expect(localizeNativeLine({ content: line, indent: 0, lookup }), line).toBe(expected);
  });
});

/* ============================================================================
 * 三、`isDataReference`：唯一新增判据的用例表（正 / 负各钉一批）
 * ========================================================================== */

const REF_TRUE: readonly string[] = [
  '服装',
  '順位',
  '残りムシ数',
  'K53_変数',
  '表示形式',
  '服装$',
  'LOCALS:1',
  'CFLAG:%CALLNAME:TARGET%',
  'CFLAG:100(CHARA_NO(TARGET))',
  'A(B, C)',
  'A[1, 2]',
  'ORINQI%1',
  '%MACRO%',
];

const REF_FALSE: readonly string[] = [
  '',
  'IF A',
  'PRINTFORMW a',
  '「服装',
  '"服装"',
  '$LABEL',
  '100',
  'A B',
  'A,B',
  'A)',
  'A{B}',
  'A=B',
  'A;B',
  '%MACRO',
  'CFLAG：100',
];

describe('isDataReference · 形状判据（只看形状，不看名字）', () => {
  it.each(REF_TRUE)('认得出是引用：%s', (token) => {
    expect(isDataReference(token), token).toBe(true);
  });
  it.each(REF_FALSE)('认不出 ⇒ false：%s', (token) => {
    expect(isDataReference(token), token).toBe(false);
  });

  it('组外空白 / 引号 / 花括号一律不是引用（这条就是"不抢 `IF A = 1`、不抢台词"的那道闸）', () => {
    expect(isDataReference('IF A')).toBe(false);
    expect(isDataReference('WHILE FLAG')).toBe(false);
    expect(render('IF A = 1', DICT)).toBeNull();
    expect(render('PRINTFORMW a = b', DICT)).toBeNull();
    expect(render('「服装 = 裸」', DICT)).toBeNull();
  });
});

/* ============================================================================
 * 四、负自证：这些行**仍**归别的层或仍是真未知 ⇒ 本层一律 `null`
 * ========================================================================== */

const STILL_NULL: readonly string[] = [
  '「服装 = 裸」', // 台词行：引号内的 `=` 不是运算符
  '"服装 = 裸"',
  // `{` / `}` **整行**已由 TAIL-1 交付给 control.ts（`多行语句开始` / `多行语句结束`，见
  // `native-display-increment-brace.test.ts`）；这里只剩"括号不是整行"的形状仍是真未知：
  '{ 1 }',
  '{LOCAL = 1}',
  'CFLAG:100', // 裸引用：没有顶层 `=` ⇒ 不是赋值
  '残りムシ数, 3',
  '服装 裸',
  'LOCAL == 1', // 比较不是赋值
  'LOCAL:1 <> 2',
  'S =', // 空右值
  '= 1', // 空左值
  'TIMES 3, CALL FOO', // 表外记号：没把握的不配拥有中文名
  'GETMILLISECOND',
  'SETCOLORBYNAME "红"',
  'VARSET', // 缺载荷 = 畸形行
  'callf FOO(1)', // 调用族的记号按引擎写法全大写；小写不猜
  'PRINTKONST', // `PRINT*` 表外变体归投影的台词形，本层不抢
  'PRINTFORMW "a = b"',
  'PRINT%s=1', // 表外变体里"恰好带个 `=`"的漏网形状：`PRINT` 打头一律留给 `printFamilyDisplay`
  'PRINTKONST 服装 = 裸',
  'SOME_UNKNOWN_ENGINE_THING 1',
  'FOR 種類,0,MAXPANTS', // `FOR` 异形归 controlFlow 那一格（20 行），本批一个字节不碰
  'FOR LOCAL, 4',
];

describe.each(STILL_NULL)('负自证 · "%s" ⇒ null', (line) => {
  it('认不出必须 null（有 lookup 与无 lookup 两档都核）', () => {
    expect(render(line, DICT)).toBeNull();
    expect(render(line, undefined)).toBeNull();
    expect(localizeNativeLine({ content: line, indent: 0, lookup: DICT }), line).toBeNull();
  });
});

describe('不抢别的层的行：control 先命中 ⇒ 本层拿不到（pass 顺序 = 优先级）', () => {
  it('`IF` / `FOR i = 0 TO 9` / `DATA` 三形各归 ZH-C，显示形逐字不变', () => {
    for (const src of ['IF 服装 = 裸', 'FOR i = 0 TO 9', 'DATA 服装 = 裸']) {
      expect(render(src, DICT), src).toBeNull();
      expect(renderControlLine({ content: src, indent: 0 }), src).not.toBeNull();
    }
  });
});

/* ============================================================================
 * 五、投影接线：真实形状整段上屏，兜底前缀归零、红线仍归零
 * ========================================================================== */

/** 投影只依赖结构扫描；`transpile` 用抛错替身——显示面**结构上**不可能改产物 */
const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影是只读显示面，不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
});

const split = (source: string): string[] => source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

/** 屏面上还在喊"没读懂"的行（兜底前缀与 `project.ts` 的 `UNRECOGNIZED_PREFIX` 同串） */
const fallbackLines = (source: string): string[] =>
  liftProject(deps(), { source })
    .segments.flatMap((s) => s.sugarText.split('\n'))
    .filter((l) => l.includes('未识别语句 · '));

const REAL_SHAPES = [
  '@M_KOJO_K1_2_functions',
  '\t表示形式 = %GET_BASESTYLE(TARGET, 表示形式)%',
  '\t服装 = 裸',
  '\t服装 = 服',
  '\t順位 = 3',
  '\t残りムシ数 = 0',
  '\tK53_変数 = 1',
  '\tCFLAG:100(CHARA_NO(TARGET)) = 1',
  '\tVARSET LOCAL:1, 0',
  '\tCLEARLINE 1',
  '\tHTML_PRINT <b>甲</b>',
  '\tCALLF FOO(1)',
  '\tPRINTKONST 服装 = 裸',
  '\tIF LOCAL',
  '\t\tPRINTFORMW 「服装 = 裸」',
  '\tENDIF',
].join('\n');

describe('投影接线 · 真实形状自证', () => {
  it('13 行赋值 / 原语行全部上中文形：兜底前缀 0 行', () => {
    expect(fallbackLines(REAL_SHAPES)).toEqual([]);
  });

  it('红线不破：屏面没有一整行逐字 ERB（`未识别语句 · ` 归零不等于原样透传）', () => {
    const projected: string[] = [];
    const src = split(REAL_SHAPES);
    let cur = 0;
    for (const s of liftProject(deps(), { source: REAL_SHAPES }).segments) {
      for (; cur < s.fromLine - 1; cur++) projected.push(src[cur] ?? '');
      projected.push(...s.sugarText.split('\n'));
      cur = s.toLine;
    }
    for (; cur < src.length; cur++) projected.push(src[cur] ?? '');
    expect(countVerbatimNativeLines(projected, src).count).toBe(0);
  });

  it('逐行对位：CJK 左值各行显示为 `赋值 …`，`PRINT` 行与 `「…」` 台词行都不被抢成赋值', () => {
    const lines = liftProject(deps(), { source: REAL_SHAPES })
      .segments.flatMap((s) => s.sugarText.split('\n'))
      .map((l) => l.trim());
    expect(lines).toContain('赋值 表示形式 = %GET_BASESTYLE(TARGET, 表示形式)%');
    expect(lines).toContain('赋值 服装 = 裸');
    expect(lines).toContain('赋值 残りムシ数 = 0');
    expect(lines).toContain('赋值 CFLAG:100(CHARA_NO(TARGET)) = 1');
    expect(lines).toContain('赋值 LOCAL:1, 0');
    expect(lines).toContain('清空本行 1');
    expect(lines).toContain('HTML打印 <b>甲</b>');
    expect(lines).toContain('调用F FOO(1)');
    // `PRINT` 打头那两行仍走投影的台词口径（`printVariant` 结构性 0 的判据不破）
    expect(lines).toContain('台词 · 服装 = 裸');
    expect(lines.some((l) => l.startsWith('赋值 PRINT'))).toBe(false);
    expect(lines.some((l) => l.includes('「服装 = 裸」'))).toBe(true);
    expect(lines.some((l) => l.startsWith('赋值 「服装'))).toBe(false);
  });
});

/* ============================================================================
 * 六、反证：显示形喂写侧**发不出语句**（显示形不承诺可写，与 `分组` / `试探` 同档）
 * ========================================================================== */

const displayLine = (text: string): LineClass => classifyLine(splitLogicalLines(text)[0]!);

describe('反证 · 显示形没有写侧通路', () => {
  it('本批用到的每一枚词头都不在 `KEYWORDS`（登记 = 承诺写得回去，本档不承诺）', () => {
    for (const w of ['赋值', '清空本行', 'HTML打印', '复原字体', '字体样式', '调用F']) {
      expect(lookupKeyword(w), w).toBeUndefined();
    }
  });

  it('显示形喂 `classifyLine`：要么落台词兜底、要么把词头当变量名的一部分 ⇒ 两种都发不出原语句', () => {
    for (const shown of ['清空本行 1', '调用F FOO(1)', 'HTML打印 <b>甲</b>', '复原字体 1', '字体样式 12']) {
      expect(displayLine(shown).kind, shown).toBe('text');
    }
    const assign = displayLine('赋值 服装 = 裸');
    expect(assign.kind).toBe('assign');
    // 词头被吸进左值（`赋值 服装`）——字典里根本没有这个名字，写侧只会报 unknown-identifier，
    // 而不是悄悄产出 `服装 = 裸`
    if (assign.kind === 'assign') expect(assign.target).toBe('赋值 服装');
  });
});
