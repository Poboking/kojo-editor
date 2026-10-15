/**
 * E1 文档格式化核心（`src/formatter.ts`）单测。
 *
 * 断言口径只有一条主线：**改动只发生在"空白身份明确"的位置**。
 * 台词/正文/引号里的全角空格是作者要打印的字符，注释分隔符也是排版；
 * 缩进则必须**层级不变**（层级由转译器 `indentLevel` 定义，见 `indentOf`）。
 */

import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { applyFormatEdits, computeFormatEdits, formatText } from '../src/formatter';
import { splitLogicalLines } from '../src/lexer';

const FW = FULLWIDTH_SPACE;

/** 跑一遍格式化并断言行尾结构不变，返回格式化后的文本 */
function fmt(text: string, dialect: 'erb' | 'kojo'): string {
  const before = eolsOf(text);
  const out = formatText(text, dialect).text;
  expect(eolsOf(out), '行尾序列必须逐条不变').toEqual(before);
  return out;
}

/** 行尾序列（含混合行尾）——格式化不许动它，所以每条用例都顺带自证一次 */
function eolsOf(text: string): string[] {
  return [...text.matchAll(/\r\n|\r|\n/g)].map((m) => m[0]);
}

/** 取每行的缩进层级（转译器口径），用于"改写法不改层级"的断言 */
function indentOf(text: string): number[] {
  return splitLogicalLines(text).map((l) => l.indent);
}

describe('ERB 形 · 全角空格只在该换的地方换', () => {
  it('行首缩进：一个 U+3000 折成两个半角空格（宽度不变、层级不变）', () => {
    expect(fmt(`${FW}PRINTL A`, 'erb')).toBe('  PRINTL A');
  });

  it('整行注释里的 U+3000 → 一个半角空格', () => {
    expect(fmt(`;【TARGET】${FW}欲情の珠`, 'erb')).toBe(';【TARGET】 欲情の珠');
  });

  it('PRINTFORMW 的台词正文：U+3000 原样保留（那是打印给玩家看的排版）', () => {
    const src = `PRINTFORMW ${FW}「呀。」`;
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
    expect(fmt(src, 'erb')).toBe(src);
  });

  it('行中 `;` 之后不换（ERB 里分不开"注释"与"要打印的分号"⇒ 判不准就不动）', () => {
    const src = `PRINTFORMW 甲${FW}乙;${FW}丙`;
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('纯空白行（只有 U+3000）→ 真空行', () => {
    expect(fmt(`${FW}${FW}\n甲\n`, 'erb')).toBe('\n甲\n');
  });

  it('台词行尾的空白不剥（行尾空白是要打印的字，不是排版噪声）', () => {
    const src = `PRINTFORMW 「呀。」${FW}`;
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('零散 TAB 与空格保持原样：ERB 缩进只做全角折算，不归一', () => {
    const src = `  \tIF 1 = 1\n`;
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('同一行里缩进与注释同时改：只产一条 edit', () => {
    const edits = computeFormatEdits(`${FW};注${FW}释\n`, 'erb');
    expect(edits).toEqual([{ line: 1, startColumn: 1, endColumn: 6, text: '  ;注 释' }]);
  });
});

describe('`.kojo` 形 · 缩进归一只在判得准时才做', () => {
  const doc = ['角色: 12', '时机 指令 310：', '    「呀。」', '    如果 1 = 1：', '        「嗯。」'].join('\n');

  it('已按 4 空格归一的文档：零改动（幂等的下界）', () => {
    expect(computeFormatEdits(doc, 'kojo')).toEqual([]);
  });

  it('主体用 TAB 的文件：4 空格行折成 TAB（单位是探出来的，不是硬编码的）', () => {
    const src = ['角色: 12', '时机 指令 310：', '\t「呀。」', '    如果 1 = 1：', '\t\t「嗯。」'].join('\n');
    const out = fmt(src, 'kojo');
    expect(out).toBe(['角色: 12', '时机 指令 310：', '\t「呀。」', '\t如果 1 = 1：', '\t\t「嗯。」'].join('\n'));
    expect(indentOf(out)).toEqual(indentOf(src));
  });

  it(`混写（\`\\t  \` = 1 TAB + 2 空格，层级 2）→ 折成两个单位，层级仍是 2`, () => {
    const src = ['角色: 12', '时机 指令 310：', '    「呀。」', '    如果 1 = 1：', '\t  「嗯。」'].join('\n');
    const out = fmt(src, 'kojo');
    expect(out.split('\n')[4]).toBe('        「嗯。」');
    expect(indentOf(out)).toEqual(indentOf(src));
  });

  it('缩进里的 U+3000 参与归一：`如果` 体用两个 U+3000（层级 1）→ 一个 4 空格单位', () => {
    const src = ['角色: 12', '时机 指令 310：', `${FW}${FW}「呀。」`].join('\n');
    const out = fmt(src, 'kojo');
    expect(out.split('\n')[2]).toBe('    「呀。」');
    expect(indentOf(out)).toEqual(indentOf(src));
  });

  it('整份文件都用 2 空格：层级本就判不准（4 空格也算 level 1）⇒ 缩进规则整体关掉', () => {
    const src = ['角色: 12', '时机 指令 310：', '  「呀。」', '  如果 1 = 1：', '      「嗯。」'].join('\n');
    expect(computeFormatEdits(src, 'kojo')).toEqual([]);
  });

  it('TAB 与 4 空格各半（平局）⇒ 判不准，不动缩进', () => {
    const src = ['时机 指令 310：', '\t「甲。」', '    「乙。」'].join('\n');
    expect(computeFormatEdits(src, 'kojo')).toEqual([]);
  });

  it('没有任何缩进行 ⇒ 探测不出单位（也不该有缩进改动）', () => {
    const src = ['角色: 12', '「呀。」'].join('\n');
    expect(computeFormatEdits(src, 'kojo')).toEqual([]);
  });
});

describe('`.kojo` 形 · 正文与注释分界', () => {
  it('台词行（text）里的 U+3000 不动，行首缩进照折', () => {
    const out = fmt(`${FW}「呀。」${FW}嗯`, 'kojo');
    expect(out).toBe('  「呀。」' + FW + '嗯');
  });

  it('整行注释：注释体里的 U+3000 折半角', () => {
    expect(fmt(`;${FW}注`, 'kojo')).toBe('; 注');
  });

  it('结构化行只动行内注释段：代码区的 U+3000 一律不碰', () => {
    const out = fmt(`时机 指令${FW}310：${FW};` + FW + '说明', 'kojo');
    expect(out).toBe(`时机 指令${FW}310：${FW}; 说明`);
  });

  it('引号内的 `;` 不算注释起点（字符串别名的值不能被当成注释切掉）', () => {
    const src = `别名 甲 = "a;b${FW}c";${FW}说明`;
    const out = fmt(src, 'kojo');
    expect(out).toBe(`别名 甲 = "a;b${FW}c"; 说明`);
  });

  it('原生直通行（rawLine）：正文不动、缩进不归一，只做全角折算', () => {
    const src = ['角色: 12', '时机 指令 310：', '    「呀。」', '  PRINTFORMW 甲'].join('\n');
    expect(computeFormatEdits(src, 'kojo')).toEqual([]);
  });

  it('空行带缩进（只有空白）→ 真空行', () => {
    expect(fmt('角色: 12\n    \n', 'kojo')).toBe('角色: 12\n\n');
  });

  it('折行（`\\` 续接）涉及的物理行整条不动', () => {
    const src = ['时机 指令 310：', `${FW}「呀。\\`, `${FW}嗯」`].join('\n');
    expect(computeFormatEdits(src, 'kojo')).toEqual([]);
  });
});

describe('`@` 原生块 · 逐字节透传进产物 ⇒ 整块一个字符都不动', () => {
  const src = [
    '角色: 12',
    '时机 指令 310：',
    '    「呀。」',
    '@CALL_FOO',
    `  PRINTFORMW 甲${FW}乙`,
    `;${FW}块内注释也不折`,
    '        PRINTL 内层缩进不动',
  ].join('\n');

  it('块内的 U+3000（缩进 / 注释 / 空行）一律原样：那些字节逐行进产物', () => {
    expect(computeFormatEdits(src, 'kojo')).toEqual([]);
    expect(formatText(src, 'kojo').text).toBe(src);
  });

  it('同一份文本按 ERB 形格式化才会动（证明上一条是"块"的功劳，不是规则没跑）', () => {
    expect(formatText(src, 'erb').text).not.toBe(src);
  });

  it('块内缩进不参与单位探测（探测只看糖行）', () => {
    const tabInRaw = ['角色: 12', '时机 指令 310：', `${FW}「呀。」`, '@CALL_FOO', '\t\tPRINTL 甲'].join('\n');
    const out = fmt(tabInRaw, 'kojo');
    expect(out.split('\n')[2]).toBe('  「呀。」');
    expect(out.split('\n')[4]).toBe('\t\tPRINTL 甲');
  });

  it('`@` 块延续到下一个 `@` 行或文件尾（判据同 `readRawFunctionBlock`）⇒ 块后的"看起来像糖"的行也不动', () => {
    const src2 = ['角色: 12', '@CALL_FOO', 'PRINTL 甲', '  时机 指令 310：'].join('\n');
    expect(computeFormatEdits(src2, 'kojo')).toEqual([]);
  });
});

describe('行尾与编码：格式化不碰', () => {
  it('CRLF 文件保持 CRLF', () => {
    const src = `角色: 12\r\n${FW}「呀。」\r\n`;
    expect(fmt(src, 'kojo')).toBe(`角色: 12\r\n  「呀。」\r\n`);
  });

  it('LF 文件保持 LF（绝不被改成 CRLF）', () => {
    const src = `角色: 12\n${FW}「呀。」\n`;
    expect(fmt(src, 'kojo')).toBe(`角色: 12\n  「呀。」\n`);
  });

  it('混合行尾原样保留（逐条对齐）', () => {
    const src = `甲\r\n${FW}乙\n丙\r\n`;
    expect(fmt(src, 'erb')).toBe(`甲\r\n  乙\n丙\r\n`);
  });

  it('BOM 字符不被吞掉也不新增（编码由内核 io 管，格式化只碰行内空白）', () => {
    const BOM = String.fromCharCode(0xfeff);
    const src = `${BOM}角色: 12\n${FW}「呀。」\n`;
    const out = fmt(src, 'kojo');
    expect(out.startsWith(BOM)).toBe(true);
    expect(out.split('\n')[0]).toBe(`${BOM}角色: 12`);
    expect(out.split('\n')[1]).toBe('  「呀。」');
  });

  it('末行无换行符：不补换行', () => {
    expect(fmt(`${FW}PRINTL A`, 'erb')).toBe('  PRINTL A');
  });
});

describe('edit 形状与退化输入', () => {
  it('无变化 ⇒ 空 edits（格式化产出 0 条是正常结果）', () => {
    expect(computeFormatEdits('', 'kojo')).toEqual([]);
    expect(computeFormatEdits('', 'erb')).toEqual([]);
    expect(computeFormatEdits('角色: 12\n「呀。」\n', 'kojo')).toEqual([]);
  });

  it('每条 edit 都落在单行内（列不越界、不跨行）', () => {
    const src = `${FW}甲\n乙\n${FW};丙\n`;
    for (const e of computeFormatEdits(src, 'erb')) {
      const line = src.split('\n')[e.line - 1]!;
      expect(e.startColumn).toBe(1);
      expect(e.endColumn).toBe(line.length + 1);
      expect(e.text).not.toContain('\n');
      expect(e.text).not.toContain('\r');
    }
  });

  it('陈旧坐标按夹取处理，不抛也不跨行', () => {
    const text = '甲\n乙\n';
    const out = applyFormatEdits(text, [
      { line: 2, startColumn: 1, endColumn: 999, text: 'X' },
      { line: 99, startColumn: 1, endColumn: 2, text: '忽略' },
      { line: 1, startColumn: 40, endColumn: 2, text: 'Y' },
    ]);
    // 行 2 整行替换；不存在的行 99 丢弃；行 1 起点越界被夹到行尾（追加），换行符一条没少
    expect(out).toBe('甲Y\nX\n');
    expect(eolsOf(out)).toEqual(['\n', '\n']);
  });

  it('幂等：格式化一次后的文本再格式化 ⇒ 零 edits（ERB 与 `.kojo` 都成立）', () => {
    const cases = [
      `${FW}${FW}甲${FW}乙\n;${FW}注释\n`,
      ['角色: 12', '时机 指令 310：', `${FW}${FW}「呀。」`, `${FW}${FW}如果 1 = 1：`, `${FW}${FW}${FW}${FW}「嗯。」`].join('\n'),
    ];
    for (const src of cases) {
      for (const dialect of ['erb', 'kojo'] as const) {
        const once = formatText(src, dialect).text;
        expect(computeFormatEdits(once, dialect), `${dialect} 第二轮应当无改动`).toEqual([]);
      }
    }
  });
});
