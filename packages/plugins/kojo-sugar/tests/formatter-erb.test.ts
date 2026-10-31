/**
 * S11 · ERB 块层级缩进（`src/formatter.ts` 的 ERB 腿）。
 *
 * 钉四件事：
 * ① 层级口径：开块行 d / 块体 d+1 / 分支行 d+1 / 分支体 d+2 / 闭合行 d
 *   （与 `@kojo/erb-lang/enter` 的回车档位同一份语料读数）；
 * ② 模型边界：顶层行、注释、`#`/`$`、`@` 函数头与 `@"…"` 续行、数据表体/死区一律保留原缩进；
 * ③ 台词行（含行首/行尾全角空格）与行尾空白一个字节不动；
 * ④ 幂等与"内容不变"：格式化只改行首空白，token 序列与行数逐行相等。
 */

import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { applyFormatEdits, computeFormatEdits, computeRangeFormatEdits, erbNewContentWithPrefix, formatText } from '../src/formatter';

const FW = FULLWIDTH_SPACE;

const fmt = (text: string): string => formatText(text, 'erb').text;

/** 逐行的"去行首空白"形状：用来证明只动了缩进（行尾空白与正文逐字保留） */
const withoutIndent = (text: string): string[] =>
  text.split('\n').map((line) => line.replace(/^[ \t\u3000]+/, ''));

/** 混合嵌套：`@` 函数头 / IF-ELSEIF-ELSE / 分支内再套 SELECTCASE-CASE-CASEELSE */
const NESTED_SRC = [
  '@EVENTTRAIN',
  'LOCAL = 1',
  'IF LOCAL',
  'PRINTFORMW 甲',
  'ELSEIF TCVAR:状态',
  '\tSELECTCASE RAND:3',
  'CASE 0',
  'PRINTFORMW 乙',
  'CASEELSE',
  'PRINTFORMW 丙',
  'ENDSELECT',
  'ELSE',
  'PRINTFORMW 丁',
  'ENDIF',
].join('\n');

const NESTED_TAB = [
  '@EVENTTRAIN',
  'LOCAL = 1',
  'IF LOCAL',
  '\tPRINTFORMW 甲',
  '\tELSEIF TCVAR:状态',
  '\t\tSELECTCASE RAND:3',
  '\t\t\tCASE 0',
  '\t\t\t\tPRINTFORMW 乙',
  '\t\t\tCASEELSE',
  '\t\t\t\tPRINTFORMW 丙',
  '\t\tENDSELECT',
  '\tELSE',
  '\t\tPRINTFORMW 丁',
  'ENDIF',
].join('\n');

describe('ERB 块层级：开块 / 分支 / 闭合的档位', () => {
  it('TAB 文件（已有缩进行给出单位）：混合嵌套按现有配对排层级', () => {
    expect(fmt(NESTED_SRC)).toBe(NESTED_TAB);
  });

  it('4 空格文件：同一份结构排成 4 空格单位（单位是探出来的，不是硬编码）', () => {
    const src = ['IF X', '    PRINTFORMW 甲', 'WHILE Y', 'PRINTL 乙', 'WEND', 'ENDIF'].join('\n');
    expect(fmt(src)).toBe(
      ['IF X', '    PRINTFORMW 甲', '    WHILE Y', '        PRINTL 乙', '    WEND', 'ENDIF'].join('\n'),
    );
  });

  it('循环与 TRY 两档：FOR/NEXT、REPEAT/REND、DO/LOOP、TRYCCALL/CATCH/ENDCATCH', () => {
    const src = [
      'FOR I, 0, 3',
      'PRINTL 甲',
      'NEXT',
      '\tREPEAT',
      'PRINTL 乙',
      'REND',
      '\tDO',
      'PRINTL 丙',
      'LOOP',
      '\tTRYCCALL F',
      'PRINTL 丁',
      'CATCH',
      'PRINTL 戊',
      'ENDCATCH',
    ].join('\n');
    expect(fmt(src)).toBe(
      [
        'FOR I, 0, 3',
        '\tPRINTL 甲',
        'NEXT',
        '\tREPEAT',
        '\t\tPRINTL 乙',
        '\tREND',
        '\tDO',
        '\t\tPRINTL 丙',
        '\tLOOP',
        '\tTRYCCALL F',
        '\t\tPRINTL 丁',
        '\t\tCATCH',
        '\t\t\tPRINTL 戊',
        '\tENDCATCH',
      ].join('\n'),
    );
  });

  it('`@` 函数头把层级归零：上一函数欠的闭合不许把下一函数整段缩进', () => {
    const src = ['@A', 'IF X', '\tPRINTFORMW 乙', '@B', 'PRINTFORMW 甲'].join('\n');
    expect(fmt(src)).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });
});

describe('ERB 块层级：不动的那几类行', () => {
  it('台词行的行首/行尾全角空格逐字节保留（那是要打印的字）', () => {
    const src = ['IF X', `\tPRINTFORMW ${FW}「呀。」${FW}`, 'ENDIF'].join('\n');
    expect(fmt(src)).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('注释不参与层级、也不改缩进（作者常把分隔注释顶到列 0 画框）', () => {
    const src = ['IF X', '; 分隔线', '\tPRINTFORMW 甲', 'ENDIF'].join('\n');
    expect(fmt(src)).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('`@"…"` 跨行 CALL 续行保留原缩进（不按块体重排）', () => {
    const src = ['IF X', '\tCALL F, 1', '\t\t@"abc", 2', 'ENDIF'].join('\n');
    expect(fmt(src)).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('数据表体由掩码整行保护：块内的 DATA 行一个字节都不动', () => {
    const src = ['IF X', '\tPRINTDATA', '  DATA 甲', 'DATA 乙', '\tENDDATA', 'ENDIF'].join('\n');
    expect(fmt(src)).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('单位探测不出（无缩进行）⇒ 整条块缩进关掉：不猜 TAB 还是 4 空格', () => {
    const src = ['IF X', 'PRINTLW 甲', 'ENDIF'].join('\n');
    expect(fmt(src)).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });
});

describe('ERB 块层级：幂等与内容不变', () => {
  it('格式化两次 ≡ 一次（第二轮零 edit）', () => {
    const once = fmt(NESTED_SRC);
    expect(fmt(once)).toBe(once);
    expect(computeFormatEdits(once, 'erb')).toEqual([]);
  });

  it('只改行首空白：行数、正文、行尾空白逐行相等', () => {
    const once = fmt(NESTED_SRC);
    expect(once.split('\n').length).toBe(NESTED_SRC.split('\n').length);
    expect(withoutIndent(once)).toEqual(withoutIndent(NESTED_SRC));
  });

  it('CRLF 文件逐条保持 CRLF，内容与 LF 版一致', () => {
    const src = NESTED_SRC.replace(/\n/g, '\r\n');
    const out = fmt(src);
    expect(out).toBe(NESTED_TAB.replace(/\n/g, '\r\n'));
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it('关 `indent` ⇒ 行首空白一个字符都不动（块缩进也归这条规则管）', () => {
    expect(computeFormatEdits(NESTED_SRC, 'erb', { indent: false })).toEqual([]);
  });
});

/* ========================= 区间格式化（选区 + 块前缀） =========================
 *
 * 区间腿手里只有选区那几行；前缀（选区之前那几行）只用来把块层级栈补到与整篇一致，
 * 一个字节都不回写。下面每条用例都同时钉「选区外不动」这条硬判据。
 */

describe('ERB 区间格式化：块前缀', () => {
  it('IF 体内的选区不再压平（首行按外层块的块体层缩进）', () => {
    const prefix = 'IF X\n\tPRINTL 甲\n';
    const range = 'PRINTL 乙\nENDIF\n';
    expect(computeRangeFormatEdits(range, 'erb', { prefix })).toEqual([
      { line: 1, startColumn: 1, endColumn: 9, text: '\tPRINTL 乙' },
    ]);
  });

  it('顶层选区（无外层块）：行为与整篇腿逐字一致，一个 edit 都没有', () => {
    const prefix = 'PRINTL 甲\n';
    const range = 'PRINTL 乙\n';
    expect(computeRangeFormatEdits(range, 'erb', { prefix })).toEqual([]);
    // 无前缀 ⇒ 就是 `computeFormatEdits`（既有行为零改动）
    const slice = 'IF X\n\tPRINTL 甲\nENDIF\n';
    expect(computeRangeFormatEdits(slice, 'erb')).toEqual(computeFormatEdits(slice, 'erb'));
    expect(computeRangeFormatEdits(slice, 'erb', { prefix: '' })).toEqual(computeFormatEdits(slice, 'erb'));
  });

  it('嵌套两层块：前缀里的 IF + FOR 都要算进栈，首行落在两层块体', () => {
    const prefix = 'IF X\n\tFOR I, 0, 3\n\t\tPRINTL 甲\n';
    const range = 'PRINTL 乙\nNEXT\nENDIF\n';
    expect(computeRangeFormatEdits(range, 'erb', { prefix })).toEqual([
      { line: 1, startColumn: 1, endColumn: 9, text: '\t\tPRINTL 乙' },
      { line: 2, startColumn: 1, endColumn: 5, text: '\tNEXT' },
    ]);
  });

  it('跨 `@` 函数边界不继承：上一函数欠的块不许把本函数首行缩进', () => {
    const prefix = 'IF X\n\tPRINTL 甲\n@B\n';
    const range = 'PRINTL 乙\n';
    expect(computeRangeFormatEdits(range, 'erb', { prefix })).toEqual([]);
  });

  it('幂等：按第一批 edits 落回后再算一次，第二轮零 edit', () => {
    const prefix = 'IF X\n\tPRINTL 甲\n';
    const range = 'PRINTL 乙\nENDIF\n';
    const once = applyFormatEdits(range, computeRangeFormatEdits(range, 'erb', { prefix }));
    expect(once).toBe('\tPRINTL 乙\nENDIF\n');
    expect(computeRangeFormatEdits(once, 'erb', { prefix })).toEqual([]);
  });

  it('选区外字节不变：edits 全落在选区内，前缀逐字节原样', () => {
    const prefix = '@EVENTTRAIN\nIF X\n\tPRINTL 甲\n';
    const range = 'PRINTL 乙\nENDIF\n';
    const edits = computeRangeFormatEdits(range, 'erb', { prefix });
    const rangeLineCount = range.split('\n').length - 1; // 末行带行尾 ⇒ 末尾空串不是行
    expect(edits.every((e) => e.line >= 1 && e.line <= rangeLineCount)).toBe(true);
    const nextRange = applyFormatEdits(range, edits);
    const nextDoc = prefix + nextRange;
    expect(nextDoc.slice(0, prefix.length)).toBe(prefix);
    // 与整篇腿同判据：整篇算出来落在选区内的那几条，平移到选区坐标后逐字相等
    const whole = computeFormatEdits(prefix + range, 'erb').filter((e) => e.line > 3);
    expect(whole.map((e) => ({ ...e, line: e.line - 3 }))).toEqual(edits);
  });

  it('前缀里没有缩进证据 ⇒ 单位探测不出 ⇒ 不猜，选区原样（保守边界）', () => {
    const prefix = 'IF X\n';
    const range = 'PRINTL 乙\n';
    expect(computeRangeFormatEdits(range, 'erb', { prefix })).toEqual([]);
  });

  it('关 `indent` ⇒ 区间腿也不动行首空白（偏好开关同口径）', () => {
    const prefix = 'IF X\n\tPRINTL 甲\n';
    const range = 'PRINTL 乙\n';
    expect(computeRangeFormatEdits(range, 'erb', { prefix }, { indent: false })).toEqual([]);
  });
});

describe('ERB 单行窗口：前缀行数组（宿主 on-type 腿的入口）', () => {
  it('IF 体内的单行 ≡ 多行腿把同一行喂进前缀的产物（同一台状态机）', () => {
    const prefix = 'IF X\n\tPRINTL 甲\n';
    const range = 'PRINTL 乙\n';
    const viaLines = erbNewContentWithPrefix(['IF X', '\tPRINTL 甲'], 'PRINTL 乙');
    const viaPrefixText = computeRangeFormatEdits(range, 'erb', { prefix });
    expect(viaLines).toBe('\tPRINTL 乙');
    expect(viaPrefixText).toEqual([{ line: 1, startColumn: 1, endColumn: 9, text: '\tPRINTL 乙' }]);
    expect(viaLines).toBe(viaPrefixText[0]!.text);
  });

  it('顶层单行：无外层块 ⇒ 与不带前缀的切片逐字相同', () => {
    const line = `${FULLWIDTH_SPACE}PRINTL 乙`;
    expect(erbNewContentWithPrefix(['PRINTL 甲'], line)).toBe('  PRINTL 乙');
    expect(erbNewContentWithPrefix(['PRINTL 甲'], line)).toBe(computeRangeFormatEdits(line, 'erb')[0]!.text);
  });

  it('数据表块体内的单行 ⇒ `null`（保护区整行不动，与整篇腿同一条掩码）', () => {
    expect(erbNewContentWithPrefix(['PRINTDATA', `${FULLWIDTH_SPACE}甲`], `${FULLWIDTH_SPACE}乙`)).toBeNull();
  });

  it('规则开关同口径：关 `fullWidthSpace` ⇒ 全角原样；关 `indent` ⇒ 块层级不动', () => {
    expect(erbNewContentWithPrefix(['PRINTL 甲'], `${FULLWIDTH_SPACE}PRINTL 乙`, { fullWidthSpace: false })).toBeNull();
    expect(
      erbNewContentWithPrefix(['IF X', '\tPRINTL 甲'], `${FULLWIDTH_SPACE}PRINTL 乙`, { indent: false }),
    ).toBe('  PRINTL 乙');
  });
});
