/**
 * 回车层级（ZH-D4）纯判定 + 派生正则族的单测。
 *
 * 核心是**自洽闸**（`正则族 ≡ 精确判定`）：`increaseIndentPattern`（宿主 `onEnterRules`
 * 的同步层）与 `sugarEnterIndentAfter`（on-type 兜底的精确层）对同一批行的判断
 * 必须逐行相等，**差集只许是文件头注里列明的三条近似**——多一处都算发散，测试直接红。
 * 这就是"判型必须复用既有真源"的可执行形态：不靠注释承诺，靠合成行表钉死。
 */

import { describe, expect, it } from 'vitest';
import { splitLogicalLines } from '../src/lexer';
import { computeFormatEdits } from '../src/formatter';
import { sugarEnterIndentAfter, sugarEnterRulePatterns } from '../src/enter';

/** 折一层后的层级读数（判据与转译同源：`splitLogicalLines` 的 `indentLevel`） */
const levelOf = (indent: string): number => splitLogicalLines(`${indent}x`)[0]!.indent;

/** 各块头类别的正例（一条=一类词形；带缩进的单列） */
const OPENERS: readonly string[] = [
  '时机 指令 310：',
  '时机 指令 310:',
  'timing 指令 310：',
  '如果 FLAG:70：',
  'if 心情 至少 50：',
  '否则如果 心情 不足 50：',
  'elif FLAG:71：',
  '否则：',
  'else：',
  '当 SELECTCOM：',
  'when 她的状态：',
  '是 甲,乙：',
  'is 3：',
  '随机：',
  '组：',
  'group：',
  '菜单：',
  '心形：',
  'heart：',
  '若 NOWEX:噴乳：',
  '若 非 NOWEX:噴乳：',
  '初回 "首次见面"：',
  '选项：',
  '询问 "要不要"：',
  '确认 "继续吗"：',
  'confirm：',
  '着色 红：',
  '函数 心情(甲)：',
  'function F(甲)：',
  '自定指令 追加：',
  '开关:',
  '她的心情 = 当 甲：',
  '她的心情 = 如果 心情 > 50：',
];

/** 缩进形态的正例：回车追加单位 = 原行书写风格（TAB→TAB；其余→4 空格基） */
const INDENTED: readonly [string, string][] = [
  ['\t如果 X：', '\t\t'],
  ['    当 X：', '        '],
  ['\u3000如果 X：', '\u3000    '],
  ['        组：', '            '],
];

/** 负例：不许跟进缩进（判型全走 classifyLine，这里只列形态） */
const NON_OPENERS: readonly string[] = [
  '「呀。」',
  '是她：',
  '当日事：',
  '; 时机 X：',
  '// 说明：',
  '如果 心情 好 则 空行：',
  '如果 FLAG:70： 「（内心）」',
  '随机 「甲」,「乙」',
  'PRINTFORMW 甲：',
  'IF FLAG:70 = 当 乙：',
  '@FUNCTION(A)',
  '$LABEL',
  '角色: 12',
  '口上: 破空',
  '别名 她 = 角色 12',
  '常量 X = 5',
  '空行',
  '调用 F(1)',
  '返回 3',
  '',
  '   ',
];

/** 已列明的三条近似（头注答"为何允许"）：正则族多缩、精确判定不动 */
const KNOWN_REGEX_OVERMATCH: ReadonlySet<string> = new Set(['函数：', '时机：', '若 ：']);

describe('sugarEnterIndentAfter · 块头判定（真源 = classifyLine）', () => {
  it.each(OPENERS)('块头「%s」回车 ⇒ 前缩进 + 一个单位', (line) => {
    const got = sugarEnterIndentAfter(line);
    expect(got, line).not.toBeNull();
    expect(got).toBe('    ');
  });

  it.each(INDENTED)('缩进 %j 跟进为 %j（单位随原行风格）', (line, want) => {
    expect(sugarEnterIndentAfter(line)).toBe(want);
  });

  it.each(NON_OPENERS)('非块头「%s」⇒ null（不动）', (line) => {
    expect(sugarEnterIndentAfter(line)).toBeNull();
  });

  it('行尾折线 `\`：层级归整条逻辑行，单行判定不作数', () => {
    expect(sugarEnterIndentAfter('如果 X： \\')).toBeNull();
  });

  it('追加单位的层级折算恒 = 原层级 + 1（TAB / 4 空格 / 2 空格 / 全角空格四种写法）', () => {
    for (const indent of ['', '\t', '  ', '    ', '　', '　　']) {
      const prev = `${indent}如果 X：`;
      const got = sugarEnterIndentAfter(prev)!;
      expect(levelOf(got), `${JSON.stringify(indent)} 起头`).toBe(levelOf(indent) + 1);
    }
  });
});

describe('正则族 ≡ 精确判定（自洽闸：差集只许是头注列明的三条近似）', () => {
  const patterns = sugarEnterRulePatterns();
  it('块头类别覆盖读数：indentOnEnter 一族一条正则', () => {
    expect(patterns.indentOnEnter).toHaveLength(6);
  });

  const all = [...OPENERS, ...INDENTED.map(([l]) => l), ...NON_OPENERS, ...KNOWN_REGEX_OVERMATCH];
  for (const line of all) {
    it(`逐行对齐「${line || '（空行）'}」`, () => {
      const precise = sugarEnterIndentAfter(line) !== null;
      const regex = patterns.increaseIndentPattern.test(line);
      if (precise !== regex) {
        expect(KNOWN_REGEX_OVERMATCH.has(line), `未登记的发散：${JSON.stringify(line)}`).toBe(true);
        expect(regex, `近似只许"正则多缩"方向：${JSON.stringify(line)}`).toBe(true);
      }
    });
  }

  it('段头（否则/是/组…）的 decrease 形状与 increase 词形同源（非空即成立）', () => {
    expect(patterns.decreaseIndentPattern.test('        否则：')).toBe(true);
    expect(patterns.decreaseIndentPattern.test('    是 甲：')).toBe(true);
    expect(patterns.decreaseIndentPattern.test('「呀。」')).toBe(false);
    expect(patterns.decreaseIndentPattern.test('否则没有结尾冒号')).toBe(false);
  });
});

describe('连续回车幂等（判据①）与格式化往返（判据②）', () => {
  /** 在行尾回车：块头 ⇒ 用精确判定；否则新行继承前行的行首空白（Monaco keep 行为） */
  const pressEnter = (lines: string[]): string[] => {
    const prev = lines[lines.length - 1]!;
    const decided = sugarEnterIndentAfter(prev);
    const indent = decided ?? prev.match(/^[ \t\u3000]*/)?.[0] ?? '';
    return [...lines, indent];
  };

  it('空「时机 …：」连回车 3 次：层级停在 1 级不漂移', () => {
    let doc = ['时机 指令 310：'];
    for (let i = 0; i < 3; i++) doc = pressEnter(doc);
    expect(doc.slice(1)).toEqual(['    ', '    ', '    ']);
  });

  it('嵌套两层的回车链：1 级 → 2 级，再回车停在 2 级', () => {
    let doc = ['时机 指令 310：', '    如果 心情 > 50：'];
    doc = pressEnter(doc);
    expect(doc[2]).toBe('        ');
    doc = pressEnter(doc);
    expect(doc[3]).toBe('        ');
  });

  it('回车产物（TAB 与 4 空格两档）再走整篇格式化 ⇒ 零 edits（逐字节往返一致）', () => {
    const spaces = ['时机 指令 310：', '    如果 心情 > 50：', '        「呀。」', '    否则：', '        「哈。」'].join('\n');
    expect(computeFormatEdits(spaces, 'kojo'), '4 空格档').toEqual([]);
    const tabs = ['\t时机 指令 310：', '\t\t如果 X：', '\t\t\t「呀。」'].join('\n');
    expect(computeFormatEdits(tabs, 'kojo'), 'TAB 档').toEqual([]);
  });

  it('全角空格书写档：回车跟随原形、格式化按自己的口径折回半角——**层级**两侧一致', () => {
    const fw = ['\u3000时机 指令 310：', '\u3000    「呀。」'].join('\n');
    const out = computeFormatEdits(fw, 'kojo').reduce(
      (text, e) => text.split('\n').map((l, i) => (i + 1 === e.line ? e.text : l)).join('\n'),
      fw,
    );
    const formatted = out.split('\n');
    expect(levelOf(formatted[0]!.match(/^[ \t\u3000]*/)?.[0] ?? '')).toBe(
      levelOf('\u3000') /* 1 级 */,
    );
    // 负责口径：formatter 的「缩进归一」规则（`U+3000`→2 半角空格再按单位重排）；
    // 回车层只保证层级 +1（上面 `追加单位的层级折算` 一条已钉死），不管半角化。
    expect(levelOf(formatted[1]!.match(/^[ \t\u3000]*/)?.[0] ?? '')).toBe(2);
  });
});
