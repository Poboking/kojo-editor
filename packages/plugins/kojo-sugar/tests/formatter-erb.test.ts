/**
 * S11 · ERB 块层级缩进（`src/formatter.ts` 的 ERB 腿）。
 *
 * 钉四件事：
 * ① 层级口径：开块行 d / 块体 d+1 / 分支行 d+1 / 分支体 d+2 / 闭合行 d
 *   （与 `app/src/monaco/erb-enter.ts` 的回车档位同一份语料读数）；
 * ② 模型边界：顶层行、注释、`#`/`$`、`@` 函数头与 `@"…"` 续行、数据表体/死区一律保留原缩进；
 * ③ 台词行（含行首/行尾全角空格）与行尾空白一个字节不动；
 * ④ 幂等与"内容不变"：格式化只改行首空白，token 序列与行数逐行相等。
 */

import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { computeFormatEdits, formatText } from '../src/formatter';

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
