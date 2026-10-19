/**
 * ZH-S（赋值 / 调用 / 输出 / 排版行）显示形的**表驱动**验收。
 *
 * 三条硬尺子，逐例自证：
 * 1. **红线**——`rendered !== null && rendered !== 输入行`，并用契约导出的
 *    `isVerbatimNativeLine` 复核（"整行原样 ERB" 在这一层结构上不可能）；
 * 2. **精确形**——每例钉死期望字符串（显示口径漂移 = 立刻红）；
 * 3. **不猜**——认不出必须 `null`（负自证表），`lookup` 缺席时语言层照常工作
 *    （无工程 / 无 adapter 的预览不瘫痪）。
 *
 * 第四组（TRY 系分档）钉的是**两层的配对**：开块九枚归 ZH-C、单行档归本层，
 * 名单同源于 `sugar-ident`，谁也不许认领对方那批（`startsWith('TRY')` 那条捷径要当场显形）。
 *
 * 第五线（2026-10-20）：本表之外还有一档「**数据行**」——左值不是引擎族头、也不是语言层槽位，
 * 但形状仍是一个引用（`服装 = 裸` / `CFLAG:100(%A(B)%) = 1`）⇒ `赋值 <原文>`，载荷逐字。
 * 那一档的判据（`isDataReference`）与用例表住 `tests/native-display-data-line.test.ts`；
 * 本文件只补它改到的既有档位（`CLEARLINE` 带参数、`FONT*` / `HTML_PRINT` / `VARSET` / `CALLF` 补登）
 * 与它划出的界（`NULL_LINES` 末组）。
 */

import { describe, expect, it } from 'vitest';
import { FAMILY_ALIASES_REVERSE } from '@kojo/plugin-eratw-adapter';
import { STATEMENT_TRY_WORDS, renderStatementLine } from '../src/native-display/statement';
import { renderControlLine } from '../src/native-display/control';
import { lookupKeyword } from '../src/keywords';
import { TRY_CATCH_OPEN, TRY_LIST_OPEN, TRY_SINGLE_LINE } from '../src/sugar-ident';
import { isVerbatimNativeLine } from '../src/native-display/types';
import type { NativeDisplayInput, NativeDisplayLookup } from '../src/native-display/types';
import { localizeNativeLine } from '../src/native-display/passes';

/* ==================== 桩名表（游戏层知识只活在这里，pass 本体零硬编码） ==================== */

/**
 * ZH-N 接线批（判据 6「桩与真表口径冲突 ⇒ 以真表为准」）：
 * - 别名 = adapter **真表** `FAMILY_ALIASES_REVERSE`（零漂移；旧桩的 `标志/称谓/部位/现在经验`
 *   全是与真表分叉的假别名，已废）；
 * - `slotCn` = 真通道两段的**镜像**（具名走扁平词典；纯数字走 `族头:编号` 名称表，
 *   表名与中文值逐条取自真盘实测：CFLAG 2=好感度→好感度（词典自映射）、TFLAG 193=SELECTCOM的分岐、
 *   ABL 1=Ｖ絶頂→Ｖ感觉；`EX` 无别名 ⇒ `EX:1` 在真链路上根本不会问槽名，旧桩「部位:1（胸）」
 *   是双份口径，已改）。查不到一律 `undefined`（与真实现同 fail-closed）。
 */
const CHS: Record<string, string> = {
  噴乳: '喷乳',
  信頼度: '信赖度',
  好感度: '好感度',
  Ｖ感覚: 'Ｖ感觉',
  "SELECTCOM的分岐": "SELECTCOM的分岐",
};
const NUMERIC_NAMES: Record<string, string> = {
  'CFLAG:2': '好感度',
  'TFLAG:193': 'SELECTCOM的分岐',
  'ABL:1': 'Ｖ感覚',
};
const DICT: NativeDisplayLookup = {
  familyAlias: (f) => FAMILY_ALIASES_REVERSE[f],
  slotCn: (f, i) => {
    const direct = CHS[i];
    if (direct !== undefined) return direct;
    if (!/^\d+$/.test(i)) return undefined;
    const jp = NUMERIC_NAMES[`${f}:${i}`];
    return jp === undefined ? undefined : CHS[jp];
  },
};

const render = (content: string, lookup?: NativeDisplayLookup): string | null =>
  renderStatementLine({ content, indent: 0, lookup } satisfies NativeDisplayInput);

/* ==================== 表驱动：精确形 + 红线自证 ==================== */

type Case = readonly [line: string, lookup: NativeDisplayLookup | undefined, expected: string];

const CASES: readonly Case[] = [
  /* —— 赋值：游戏族头经别名（真表 `FAMILY_ALIASES_REVERSE`；193 编号命中真名称表换算） —— */
  ['TFLAG:193 = 1', DICT, '时标:193（SELECTCOM的分岐） = 1'],
  ['TFLAG:193 += 1', DICT, '时标:193（SELECTCOM的分岐） += 1'],
  ['TFLAG:193 -= 2', DICT, '时标:193（SELECTCOM的分岐） -= 2'],
  ['TFLAG:193 *= 2', DICT, '时标:193（SELECTCOM的分岐） *= 2'],
  ['TFLAG:193 /= 2', DICT, '时标:193（SELECTCOM的分岐） /= 2'],
  ['TFLAG:193 =1', DICT, '时标:193（SELECTCOM的分岐） = 1'],
  ['tflag:193 = 1', DICT, '时标:193（SELECTCOM的分岐） = 1'],
  ['CFLAG[2] = 1', DICT, '角色标志[2]（好感度） = 1'],
  ['CFLAG:2 = 2', DICT, '角色标志:2（好感度） = 2'],
  ['NOWEX:噴乳 = 3', DICT, '现在:噴乳（喷乳） = 3'],
  ['ABL:1 = 2', DICT, '能力:1（Ｖ感觉） = 2'],
  ['CALLNAME:13 = "灵梦"', DICT, '称呼:13 = "灵梦"'],

  /* —— 赋值：查不到别名也必须给中文形（`赋值` 动词兜底） —— */
  ['XYZFLAG:5 = 1', DICT, '赋值 XYZFLAG:5 = 1'],
  ['A(AFTER_IMAGE),B(BEFORE_IMAGE) = 2,1', DICT, '赋值 A(AFTER_IMAGE),B(BEFORE_IMAGE) = 2,1'],

  /* —— 赋值：语言层槽位成套中文名（lookup 缺席照常） —— */
  ['LOCAL = 1', undefined, '局部 = 1'],
  ['LOCAL:1 = 0', undefined, '局部:1 = 0'],
  ['LOCAL:1:2 = 3', undefined, '局部:1:2 = 3'],
  ['LOCALS:2 = "a"', undefined, '局部$:2 = "a"'],
  ['LOCALSS:1 = "b"', undefined, '局部表:1 = "b"'],
  ['RESULT = 1', undefined, '结果 = 1'],
  ['RESULTS = "x"', undefined, '结果$ = "x"'],
  ['COUNT = 0', undefined, '计数 = 0'],
  ['COUNTS:3 = "y"', undefined, '计数$:3 = "y"'],
  ['COUNTSS = "z"', undefined, '计数表 = "z"'],
  ['SUCCESS = 1', undefined, '成否 = 1'],
  ['ARG = 5', undefined, '实参 = 5'],
  ['ARG:0 = 5', undefined, '实参 = 5'],
  ['ARG:1 = 5', undefined, '实参:2 = 5'],
  ['ARGS = "s"', undefined, '实参$ = "s"'],
  ['ARGS:2 = "s"', undefined, '实参$:3 = "s"'],

  /* —— 赋值：链式 / 多目标 / 行尾注释 —— */
  ['LOCAL:1 = LOCAL:2 = 0', undefined, '局部:1 = 局部:2 = 0'],
  ['LOCAL:1,LOCAL:2 = 0,1', undefined, '局部:1，局部:2 = 0,1'],
  ['LOCAL , LOCALS:1 = 0, "a"', undefined, '局部，局部$:1 = 0, "a"'],
  ['LOCAL = 1 ;随机开关', undefined, '局部 = 1 ;随机开关'],
  ['RESULT = CALL(1)', undefined, '结果 = CALL(1)'],
  // 逗号式赋值（引擎 `VARSET <变量>, <值>`）：词头换本表既有的 `赋值`，载荷逐字（2026-10-20 补登）
  ['VARSET LOCAL:1, 0', undefined, '赋值 LOCAL:1, 0'],

  /* —— 调用（既有中文关键字 `调用`，产物口径同 keywords.ts） —— */
  ['CALL FOO', undefined, '调用 FOO'],
  ['CALL qol_Xxx()', undefined, '调用 qol_Xxx()'],
  ['CALL KOJO_K12, ARG', undefined, '调用 KOJO_K12, ARG'],
  ['CALLL FOO', undefined, '调用 FOO 续'],
  ['CALLFORM KOJO_K12', undefined, '调用形 KOJO_K12'],
  // `CALLF`（引擎调用族带 `F` 的那枚，2026-10-20 补登）：区别字母照 `按钮C` 的拼法保留，
  // 实参逐字带走——本层不替读者判定 `F` 改了哪一档语义
  ['CALLF FOO(1)', undefined, '调用F FOO(1)'],
  ['TRYCALL FOO', undefined, '尝试调用 FOO'],
  ['TRYCALLFORM KOJO_K12(RESULT)', undefined, '尝试调用形 KOJO_K12(RESULT)'],
  ['TRYJUMP 100', undefined, '尝试跳转 100'],
  // goto 家族的单行 try 变体（`sugar-ident` 的 `TRY_SINGLE_LINE`）：目标**逐字带走**，
  // `跳到` 与 ZH-C 的 `GOTO` 显示形同字、`…形` 与 `调用形` 同构
  ['TRYGOTO *甲', undefined, '尝试跳到 *甲'],
  ['TRYGOTO $GO_BACK', undefined, '尝试跳到 $GO_BACK'],
  ['TRYGOTOFORM $GO_BACK, TARGET', undefined, '尝试跳到形 $GO_BACK, TARGET'],

  /* —— 位原语 —— */
  ['SETBIT LOCAL, 3', undefined, '置位 局部 第3位'],
  ['SETBIT TFLAG:1, 3', DICT, '置位 时标:1 第3位'],
  ['CLEARBIT EX:1, 2', DICT, '清位 EX:1 第2位'], // `EX` 在排除台账（真表无别名）⇒ 族头不替换，仍给中文动词语
  ['INVERTBIT LOCAL:2, 0, 1', undefined, '翻位 局部:2 第0，1位'],
  ['SETBIT XYZ, 1', DICT, '置位 XYZ 第1位'],

  /* —— 输出族（只补投影表外落到 native() 的变体） —— */
  ['PRINT 片段', undefined, '片段打印 片段'],
  ['PRINTL 文本', undefined, '打印 文本 续'],
  ['PRINTW 文本', undefined, '打印 文本 等待'],
  ['PRINTL', undefined, '空行'],
  ['PRINTW', undefined, '空行 等待'],
  ['PRINTL 非 FORM 系', undefined, '打印 非 FORM 系 续'],
  ['PRINTV GETBIT(LOCAL,1)', undefined, '数值打印 GETBIT(LOCAL,1)'],
  ['PRINTVL 5', undefined, '数值打印 5 续'],
  ['PRINTVW 5', undefined, '数值打印 5 等待'],
  ['PRINTFORMV %CALLNAME:TARGET%', undefined, '格式数值打印 %CALLNAME:TARGET%'],
  ['PRINTFORMVL %X%', undefined, '格式数值打印 %X% 续'],
  ['PRINTDATA', undefined, '数据打印：'],
  ['PRINTDATAL', undefined, '数据打印（逐行）：'],
  ['PRINTDATAW', undefined, '数据打印（等待）：'],
  ['PRINTDATAS', undefined, '数据打印（并排）：'],
  ['PRINTDATA 1,2,3', undefined, '数据打印： 1,2,3'],
  ['PRINTSINGLE', undefined, '单项打印'],
  ['PRINTSINGLEV %X%', undefined, '单项数值打印 %X%'],
  ['PRINTSINGLEL %X%', undefined, '单项打印 %X% 续'],

  /* —— 排版与等待 —— */
  ['SETCOLOR "RED"', undefined, '着色 "RED"'],
  ['SETCOLOR %X%, %Y%', undefined, '着色 %X%, %Y%'],
  ['RESETCOLOR', undefined, '复原颜色'],
  ['FONTBOLD 1', undefined, '粗体 开'],
  ['FONTBOLD 0', undefined, '粗体 关'],
  ['FONTBOLD RESULT', undefined, '粗体 RESULT'],
  ['FONTITALIC 1', undefined, '斜体 开'],
  ['FONTSIZE 120', undefined, '字号 120'],
  // 2026-10-20 兜底归因补登：这三枚都是引擎内建单行语句，此前表里没有 ⇒ 整行落 `未识别语句 ·`
  ['FONTREGULAR', undefined, '复原字体'],
  ['FONTREGULAR 1', undefined, '复原字体 1'],
  ['FONTSTYLE 12, 100, ＭＳ Ｐゴシック', undefined, '字体样式 12, 100, ＭＳ Ｐゴシック'],
  ['HTML_PRINT <b>甲</b>', undefined, 'HTML打印 <b>甲</b>'],
  ['CLEARLINE', undefined, '清空本行'],
  // `CLEARLINE` 的档位从 `none` 改成 `optional`：带参数的是**同一条指令**，参数是载荷不是身份
  ['CLEARLINE 1', undefined, '清空本行 1'],
  ['FORCEWAIT', undefined, '强制等待'],
  ['WAIT', undefined, '等待'],
  ['DRAWLINE', undefined, '分隔线'],
  ['BAR 50, 100', undefined, '进度条 50, 100'],
  ['BARL LOCAL:2, 10', undefined, '进度条 LOCAL:2, 10 续'],
  ['REDRAW', undefined, '重绘'],
  ['REDRAW B', undefined, '重绘 B'],
  ['RETURN 1', undefined, '返回 1'],
  ['RETURN RESULT', undefined, '返回 RESULT'],

  /* —— 输入 / 按钮 —— */
  ['INPUT', undefined, '输入 → 结果'],
  ['INPUTS', undefined, '输入 → 结果$'],
  ['PRINTBUTTON "继续", 1', undefined, '按钮 "继续" → 1'],
  ['PRINTBUTTONC "取消", 0', undefined, '按钮C "取消" → 0'],
];

describe.each(CASES)('语句行显示形 · %s', (line, lookup, expected) => {
  it('中文形精确命中 + 红线自证（非 null、非原样、非逐字整行 ERB）', () => {
    const rendered = render(line, lookup);
    expect(rendered).toBe(expected);
    expect(rendered).not.toBeNull();
    expect(rendered).not.toBe(line);
    expect(rendered === null ? '' : rendered.trim()).not.toBe(line.trim());
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
  });
});

/* ==================== lookup 缺席：不许因为没名表就返 null ==================== */

const NO_LOOKUP_LINES: readonly string[] = [
  'LOCAL = 1',
  'RESULT = 1',
  'ARG:1 = 5',
  'ARGS = "s"',
  'XYZFLAG:1 = 1',
  'CALL FOO',
  'TRYCALLFORM X(RESULT)',
  'SETBIT LOCAL, 3',
  'SETBIT XYZFLAG:2, 1',
  'FORCEWAIT',
  'PRINTV A',
  'PRINTDATA',
  'INPUT',
  'PRINTBUTTON "y", 2',
];

describe.each(NO_LOOKUP_LINES)('lookup 缺席仍给中文形 · %s', (line) => {
  it('无名表 ⇒ 只做语言层替换，绝不整行退回 ERB', () => {
    const rendered = render(line, undefined);
    expect(rendered).not.toBeNull();
    expect(rendered).not.toBe(line);
    expect(isVerbatimNativeLine(rendered ?? '', line)).toBe(false);
  });
});

/* ==================== 负自证：认不出 ⇒ null（宁缺勿猜） ==================== */

const NULL_LINES: readonly string[] = [
  'IF A = 1', // 控制流归 ZH-C
  'SELECTCASE LOCAL',
  'CASE 1,2',
  'GOTO 100',
  'NEXT I',
  'WHILE 1',
  'TRY', // 块开词
  'TRYGOTO', // 裸记号无目标 = 畸形（与裸 `CALL` 同一判据）
  'TRYCATCH FOO', // 名单外的 TRY 记号：前缀不算认领
  'TRYNOPENAME FOO',
  'CALL', // 裸调用无目标 = 畸形
  'SETBIT LOCAL', // 缺位号 = 畸形
  'BAR', // 缺参数
  'RESETCOLOR RED', // 不该带参数的指令
  'INPUT 5', // 固定形不许挂参数
  '#DIM A[10]', // 预处理归 ZH-C
  '$LABEL100',
  '[SKIPSTART]',
  '@TIMING_K12',
  ';纯注释',
  '',
  'LOCAL == 1', // 比较不是赋值
  'LOCAL:1 <> 2',
  'PRINTFORMW 「台词」', // 投影已有台词形——本层不重复接管
  'PRINTFORML 「台词」',
  'PRINTKONST',
  'PRINTLC 文本',
  'PRINTPLAINFORM x',
  'S =',
  // 2026-10-20 数据行档（`native-display-data-line.test.ts`）划出来的界：以下形状**仍**不归本层
  '「服装 = 裸」', // 台词行：引号内的 `=` 不是运算符，CJK 左值判据也不许把它抢成赋值
  'IF 服装 = 裸', // 组外有空白 ⇒ 不是"一个引用"，条件行仍归 ZH-C
  '残りムシ数, 3', // 没有顶层 `=` 的裸引用 ⇒ 仍落兜底
  'CFLAG：100 = 1', // 全角冒号：形状判据不认（引擎写法未取证 ⇒ 不猜）
  'VARSET', // 缺载荷 = 畸形行
  'callf FOO(1)', // 记号按引擎写法全大写；小写不猜
];

describe.each(NULL_LINES)('负自证 · "%s" ⇒ null', (line) => {
  it('认不出必须 null（两条 pass 都不许硬凑）', () => {
    expect(render(line, DICT)).toBeNull();
    expect(render(line, undefined)).toBeNull();
  });
});

/* ==================== 装配点：passes 拒收原样返回的结构 ==================== */

describe('装配点 localiseNativeLine', () => {
  it('语句行进 pass 清单后命中中文形（control 桩在前不拦截）', () => {
    expect(localizeNativeLine({ content: 'LOCAL = 1', indent: 0 })).toBe('局部 = 1');
    expect(localizeNativeLine({ content: 'CALL FOO', indent: 0 })).toBe('调用 FOO');
  });
  it('未识别行返 null，由调用方给显式兜底（不静默透传）', () => {
    expect(localizeNativeLine({ content: 'PRINTKONST', indent: 0 })).toBeNull();
  });
});

/* ==================== TRY 系分档：名单同源 + 两档互不认领 ==================== */

/** 开块九枚（= ZH-C 的 `试探 原形 …` 认领面）；从识别核派生，本文件不抄第二份 */
const TRY_NINE: readonly string[] = [...new Set([...TRY_CATCH_OPEN, ...TRY_LIST_OPEN])].sort();

describe('TRY 系分档 · 九枚归 ZH-C / 单行档归本层（互不认领）', () => {
  it('本层认领的 TRY 记号 === `sugar-ident` 的单行档（动词表与名单零漂移）', () => {
    expect(STATEMENT_TRY_WORDS).toEqual([...TRY_SINGLE_LINE].sort());
    expect(STATEMENT_TRY_WORDS).toContain('TRYGOTO');
    expect(STATEMENT_TRY_WORDS).toContain('TRYGOTOFORM');
  });

  it('两档名单不相交（档位是判据、前缀不是；九枚之数也钉死，防止有人往单行档塞开块词）', () => {
    expect(TRY_NINE).toHaveLength(9);
    expect(TRY_NINE.filter((k) => TRY_SINGLE_LINE.has(k))).toEqual([]);
  });

  it('九枚：本层弃权 ⇒ ZH-C 给中性形（装配层读不到本层的动词语）', () => {
    for (const kind of TRY_NINE) {
      const src = `${kind} FOO(A, 1)`;
      expect(render(src, undefined), src).toBeNull();
      expect(renderControlLine({ content: src, indent: 0 }), src).toBe(`试探 原形 ${kind} FOO(A, 1)`);
      expect(localizeNativeLine({ content: src, indent: 0 }), src).toBe(`试探 原形 ${kind} FOO(A, 1)`);
    }
  });

  it('单行档：ZH-C 弃权 ⇒ 本层给语句形（`原形` 记号回显不越界到语句层）', () => {
    for (const kind of STATEMENT_TRY_WORDS) {
      const src = `${kind} FOO(A, 1)`;
      expect(renderControlLine({ content: src, indent: 0 }), src).toBeNull();
      const shown = render(src, undefined);
      expect(shown, src).not.toBeNull();
      expect(shown ?? '', src).toMatch(/^尝试/);
      expect(shown ?? '', src).not.toContain('原形');
      expect(shown ?? '', src).not.toContain('试探');
      expect(localizeNativeLine({ content: src, indent: 0 }), src).toBe(shown);
      expect(isVerbatimNativeLine(shown ?? '', src), src).toBe(false);
    }
  });

  it('名单外的 TRY 记号两层都不认领（这条就是 `startsWith(\'TRY\')` 捷径的显形位）', () => {
    for (const src of ['TRYCATCH FOO', 'TRYNOPENAME FOO', 'TRYFOOLIST FOO']) {
      expect(render(src, DICT), src).toBeNull();
      expect(renderControlLine({ content: src, indent: 0 }), src).toBeNull();
      expect(localizeNativeLine({ content: src, indent: 0 }), src).toBeNull();
    }
  });

  it('显示词形不靠往 KEYWORDS 加词实现（写形归另一条线，本批一个词都不塞）', () => {
    for (const w of ['尝试', '尝试跳到', '尝试跳到形', '尝试跳转']) expect(lookupKeyword(w), w).toBeUndefined();
  });
});
