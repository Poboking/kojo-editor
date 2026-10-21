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
import {
  enterRulePatternsFromRoles,
  type EnterRulePatterns,
  sugarEnterIndentAfter,
  sugarEnterRulePatterns,
} from '../src/enter';

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

/* ============================ 通用装配：角色词表 → 回车规则族 ============================ */

/**
 * `enterRulePatternsFromRoles`（ERB-ENTER-RULES，2026-10-21）：
 * `.kojo` 那份 `sugarEnterRulePatterns()` 与 `.erb` 那份共用这一套装配，差别只在喂进来的
 * 词表。本组用例**不含任何语言名**——假词表说明装配口径，真词表的口径在宿主侧
 * `packages/app/tests/erb-enter.test.ts` 钉。
 */
describe('enterRulePatternsFromRoles（角色词表的通用装配，语言中立）', () => {
  const VOCAB = {
    open: ['OPENBLOCK', 'IFX'],
    branch: ['MIDDLE'],
    close: ['ENDBLOCK'],
    indentNextLine: ['SINGLE'],
    lineComment: '~',
    caseInsensitive: true,
  } as const;

  it('分档去向：开块∪分支抬下一行，闭合∪分支收束，单行形只进 indentNextLinePattern', () => {
    const p = enterRulePatternsFromRoles(VOCAB);
    expect(p.increaseIndentPattern.test('OPENBLOCK x')).toBe(true);
    expect(p.increaseIndentPattern.test('\tMIDDLE 3')).toBe(true);
    expect(p.increaseIndentPattern.test('SINGLE 1')).toBe(false);
    expect(p.indentNextLinePattern!.test('SINGLE 1')).toBe(true);
    expect(p.decreaseIndentPattern.test('ENDBLOCK')).toBe(true);
    expect(p.decreaseIndentPattern.test('MIDDLE 3')).toBe(true);
    expect(p.decreaseIndentPattern.test('OPENBLOCK x')).toBe(false);
    // 注释档：行首 `~` 算注释，缩进后的也算；串里的 `~` 不算（判据锚在行首）
    expect(p.unIndentedLinePattern!.test('~ 说明')).toBe(true);
    expect(p.unIndentedLinePattern!.test('\t~说明')).toBe(true);
    expect(p.unIndentedLinePattern!.test('PRINT ~ 内联')).toBe(false);
    // 词表分档 ⇒ 规则族只有开块与分支两条 Indent 规则（单行形靠 indentNextLinePattern 走继承）
    expect(p.indentOnEnter.length).toBe(2);
    expect(p.indentOnEnter[0]!.test('OPENBLOCK 1')).toBe(true);
    expect(p.indentOnEnter[0]!.test('MIDDLE 3'), '分支形不该混进开块族').toBe(false);
    expect(p.indentOnEnter[1]!.test('MIDDLE 3')).toBe(true);
    expect(p.indentOnEnter[1]!.test('SINGLE 1'), '单行形不进 indentOnEnter').toBe(false);
  });

  it('大小写口径由词表说：caseInsensitive 缺席 ⇒ 正则不带 i 旗', () => {
    expect(enterRulePatternsFromRoles(VOCAB).increaseIndentPattern.flags).toContain('i');
    const sensitive = enterRulePatternsFromRoles({ ...VOCAB, caseInsensitive: false });
    expect(sensitive.increaseIndentPattern.flags).not.toContain('i');
    expect(sensitive.increaseIndentPattern.test('openblock x'), '小写形态不该命中（大小写敏感档）').toBe(false);
  });

  it('关键字后的"词已尽"判据与配对扫描器同口径：字母/下划线才算同词，长词不被前缀抢走', () => {
    const p = enterRulePatternsFromRoles(VOCAB);
    expect(p.increaseIndentPattern.test('OPENBLOCKX 1'), 'OPENBLOCKX 不该被 OPENBLOCK 抢走').toBe(false);
    expect(p.increaseIndentPattern.test('OPENBLOCK_1 1'), '下划线仍属同一词').toBe(false);
    // 数字尾巴算"词已尽"：配对扫描器取词用的是 `^([A-Za-z_]+)`（数字不进词），这里不许另立一套
    expect(p.increaseIndentPattern.test('OPENBLOCK2 1')).toBe(true);
    expect(p.increaseIndentPattern.test('OPENBLOCK(ARG)')).toBe(true);
    expect(p.increaseIndentPattern.test('OPENBLOCK ;行内说明')).toBe(true);
    // 长词优先：词表里同时有长短两形时，长形先试（`MIDDLE` / `MID` 同形冲突的负空间）
    const both = enterRulePatternsFromRoles({ ...VOCAB, open: ['MID', 'MIDDLE'] });
    expect(both.increaseIndentPattern.test('MIDDLE 1')).toBe(true);
  });

  it('行首空白集与糖侧同源：空格 / TAB / 全角空格三形都算缩进', () => {
    const p = enterRulePatternsFromRoles(VOCAB);
    for (const ind of [' ', '\t', '\u3000', ' \t\u3000']) {
      expect(p.increaseIndentPattern.test(`${ind}OPENBLOCK 1`), JSON.stringify(ind)).toBe(true);
    }
  });

  it('空词表当场抛错（铁律 4：不许静默注册一门"回车层不存在"的语言）', () => {
    expect(() => enterRulePatternsFromRoles({ open: [], branch: [], close: [] })).toThrow(
      /没有任何开块/,
    );
  });

  it('没有收束形的语言 ⇒ decreaseIndentPattern 恒不成立（不是"匹配空行"）', () => {
    const p = enterRulePatternsFromRoles({ open: ['OPENBLOCK'], branch: [], close: [] });
    expect(p.decreaseIndentPattern.test('')).toBe(false);
    expect(p.decreaseIndentPattern.test('OPENBLOCK 1')).toBe(false);
    expect(p.unIndentedLinePattern).toBeUndefined();
    expect(p.indentNextLinePattern).toBeUndefined();
  });

  it('糖侧那份仍走同一形状：三份规则齐备、逐条 beforeText 含于 increase（两格不分叉）', () => {
    // 结构相容即通用层的消费者（宿主的 `toMonacoEnterConfig`）认得糖侧那份——这里按通用型读它
    const sugar: EnterRulePatterns = sugarEnterRulePatterns();
    expect(sugar.indentOnEnter.length).toBeGreaterThanOrEqual(6);
    for (const r of sugar.indentOnEnter) expect(sugar.increaseIndentPattern.source).toContain(r.source);
    expect(sugar.unIndentedLinePattern, '糖侧本批不新增可选格（既有手感零改动）').toBeUndefined();
    expect(sugar.indentNextLinePattern).toBeUndefined();
  });
});
