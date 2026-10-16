/**
 * ZH-C · 控制流与预处理行的中文显示形（表驱动 + 红线自证）。
 *
 * 这个文件是**系列红线**（`types.ts` 头注：预览屏上不许出现一整行原样 ERB）在单测层的自证。
 * 每一条正例都同时钉三件事，缺一不可：
 *
 * 1. `rendered !== null` —— 认得出（命中本层的封闭表）；
 * 2. `rendered !== 输入行` 且 `isVerbatimNativeLine(rendered, 输入行) === false` —— **不是原样交回**；
 * 3. `rendered === 钉值` —— 词形逐字钉住（改一个假名都算改口径，必须显形）。
 *
 * 另加两类自证：
 * - **`lookup` 缺席仍出中文**（关键字照翻；不许因为没名表就返 `null`，也不许因为没名表就留 ERB）；
 * - **未知指令返 `null`**（宁缺勿猜；表外的东西交给装配层的显式兜底）。
 *
 * 语料自证在 `KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 缺席时整组 skip（不为绿改钉值）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderControlLine } from '../src/native-display/control';
import { localizeNativeLine } from '../src/native-display/passes';
import { isVerbatimNativeLine } from '../src/native-display/types';
import type { NativeDisplayLookup } from '../src/native-display/types';

/** 族头别名桩（**语言层测试不依赖 adapter**；真表的自证在 eratw-adapter 的 family-alias.test.ts） */
const FAMILIES: Readonly<Record<string, string>> = { TFLAG: '时标', CFLAG: '角色标记', NOWEX: '现在' };
const LOOKUP: NativeDisplayLookup = {
  familyAlias: (family) => FAMILIES[family],
  slotCn: () => undefined,
};

/** 一行 → 显示形（缺省喂别名表） */
const show = (content: string, lookup: NativeDisplayLookup = LOOKUP): string | null =>
  renderControlLine({ content, indent: 0, lookup });

/** 无工程 / 无 adapter 形态（`lookup` 整个缺席，不是传 `undefined` 触发缺省值） */
const showBare = (content: string): string | null => renderControlLine({ content, indent: 0 });

/** [输入行原文, 钉住的中文显示形] */
type Case = readonly [string, string];

const BLOCKS: readonly Case[] = [
  ['IF TFLAG:193 = 1', '如果 时标：193 等于 1：'],
  ['IF TFLAG:193 == 1', '如果 时标：193 等于 1：'],
  ['IF CFLAG:TARGET:1088 >= 500', '如果 角色标记：TARGET:1088 至少 500：'],
  ['IF !(TFLAG:193 >= 5 && TFLAG:193 <= 10)', '如果 时标：193 不在 5 到 10：'],
  ['IF A > 0 && B < 2', '如果 A 超过 0 且 B 不足 2：'],
  ['IF A <= 1 || B >= 2', '如果 A 至多 1 或 B 至少 2：'],
  ['IF !TARGET', '如果 非 TARGET：'],
  ['IF A != 1', '如果 A 不等于 1：'],
  ['IF "TFLAG:1" == A', '如果 "TFLAG:1" 等于 A：'],
  ['ELSEIF TFLAG:193 == 2', '否则如果 时标：193 等于 2：'],
  ['ELSE', '否则：'],
  ['ENDIF', '如果结束'],
  ['SIF TARGET != 12', '如果 TARGET 不等于 12：'],
  ['SIF A : PRINTFORMW "x"', '如果 A 则 PRINTFORMW "x"'],
  ['SELECTCASE TFLAG:193', '当 时标：193：'],
  ['CASE 1 TO 5', '是 1 到 5：'],
  ['CASE 0, 1, 2', '是 0, 1, 2：'],
  ['CASE RESULT', '是 RESULT：'],
  ['CASEELSE', '否则：'],
  ['ENDSELECT', '当结束'],
];

const LOOPS: readonly Case[] = [
  ['FOR i = 0 TO 9', '循环 计数 i 从 0 到 9：'],
  ['FOR i = 1 TO 10 STEP 2', '循环 计数 i 从 1 到 10 步长 2：'],
  ['FOR LOCAL:0 = 0 TO LOCAL:5', '循环 计数 LOCAL:0 从 0 到 LOCAL:5：'],
  ['FOR i = 0 TO CHARANUM - 1', '循环 计数 i 从 0 到 CHARANUM - 1：'],
  ['NEXT', '循环结束'],
  ['WHILE TFLAG:193 != 0', '循环 当 时标：193 不等于 0：'],
  ['WHILE LOCAL < 10', '循环 当 LOCAL 不足 10：'],
  ['WEND', '循环结束'],
  ['REPEAT', '循环 至少一次：'],
  ['REND', '循环结束'],
  ['DO', '循环：'],
  ['LOOP', '循环结束'],
  ['i + 1', '步进 i 加 1'],
  ['i - 1', '步进 i 减 1'],
  ['i += 1', '步进 i 加 1'],
  ['i -= 1', '步进 i 减 1'],
  ['LOCAL:2 += 3', '步进 LOCAL:2 加 3'],
  ['BEST + 1', '步进 BEST 加 1'],
];

const JUMPS: readonly Case[] = [
  ['GOTO $招待', '跳到 招待'],
  ['GOTO *RETRY', '跳到 RETRY'],
  ['JUMP LABEL1', '跳到 LABEL1'],
  ['CALLJUMP 12', '调用跳转 12'],
  ['BREAK', '跳出循环'],
  ['CONTINUE', '跳过本轮'],
  ['RESTART', '重跑本轮'],
  ['CATCH', '出错处理：'],
  ['ENDCATCH', '出错处理结束'],
  ['$招待', '标签 招待'],
  ['$RETRY', '标签 RETRY'],
];

const PREPROCESSOR: readonly Case[] = [
  ['#DIM BEST 10', '声明数组 BEST 大小 10'],
  ['#DIM BEST', '声明数组 BEST'],
  ['#DIMS LOCALS 10', '声明字符串数组 LOCALS 大小 10'],
  ['#GLOBAL G 5', '声明全局数组 G 大小 5'],
  ['#LOCALSIZE LOCAL 10', '声明局部数组规模 LOCAL 大小 10'],
  ['#LOCALSSIZE LOCALS 10', '声明局部字符串规模 LOCALS 大小 10'],
  ['#FUNCTION', '声明值函数'],
  ['#FUNCTION GET_TARGET(LOCAL)', '声明值函数 GET_TARGET(LOCAL)'],
  ['#FUNCTIONS', '声明字符串值函数'],
  ['#SFUNCTION STATIC_A()', '预处理 SFUNCTION STATIC_A()'],
  ['#TESTMEMORY 1', '预处理 TESTMEMORY 1'],
  ['#XFUNCTION', '预处理 XFUNCTION'],
];

const WITH_TRAILING_COMMENT: readonly Case[] = [
  ['IF A = 1 ; 计数判定', '如果 A 等于 1： ; 计数判定'],
  ['ENDIF ; 到这里为止', '如果结束 ; 到这里为止'],
  ['#DIM BEST 10 ; 上限', '声明数组 BEST 大小 10 ; 上限'],
  ['CALLJUMP $GO_BACK ; 回跳', '调用跳转 GO_BACK ; 回跳'],
];

/** 全表（红线自证与条数下限都对着这一份，别只测其中一族） */
const ALL: readonly Case[] = [...BLOCKS, ...LOOPS, ...JUMPS, ...PREPROCESSOR, ...WITH_TRAILING_COMMENT];

/** 本层的成套词形（块头 = keywords.ts 主形；闭合 = `<块头词> + 结束`；循环/跳转/声明是本层新增族） */
const KEYWORD_SHAPES: readonly Case[] = [
  ['IF 1 = 1', '如果 1 等于 1：'],
  ['ELSEIF 1 = 2', '否则如果 1 等于 2：'],
  ['ELSE', '否则：'],
  ['ENDIF', '如果结束'],
  ['SELECTCASE 1', '当 1：'],
  ['CASE 2', '是 2：'],
  ['ENDSELECT', '当结束'],
  ['WHILE 1 = 1', '循环 当 1 等于 1：'],
  ['WEND', '循环结束'],
  ['CATCH', '出错处理：'],
  ['ENDCATCH', '出错处理结束'],
];

describe('ZH-C · 块（IF / ELSEIF / ELSE / ENDIF / SIF / SELECTCASE / CASE / CASEELSE / ENDSELECT）', () => {
  it.each(BLOCKS)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });
});

describe('ZH-C · 循环（糖层不做循环语法，显示层不许留 ERB）', () => {
  it.each(LOOPS)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });
});

describe('ZH-C · 跳转与出口', () => {
  it.each(JUMPS)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });
});

describe('ZH-C · 预处理行（#DIM / #DIMS / #GLOBAL / #LOCALSIZE / #LOCALSSIZE / #FUNCTION…）', () => {
  it.each(PREPROCESSOR)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });

  it('认得记号但不担保义项的指令 ⇒ 只翻「预处理」这一层，记号原样保留（翻类不翻义）', () => {
    expect(show('#SFUNCTION A()')).toBe('预处理 SFUNCTION A()');
    expect(show('#XFUNCTION')).toBe('预处理 XFUNCTION');
  });
});

describe('ZH-C · 行尾注释随行保留（不属于语句体，也不许被吞进条件）', () => {
  it.each(WITH_TRAILING_COMMENT)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).toBe(want);
  });
});

describe('ZH-C · 成套词形一眼成套（收束 = `<块头词> + 结束`）', () => {
  it.each(KEYWORD_SHAPES)('%s', (src, want) => {
    expect(show(src)).toBe(want);
  });

  it('闭合行与开块行共用同一块头词', () => {
    expect(show('IF A = 1')?.startsWith('如果')).toBe(true);
    expect(show('ENDIF')).toBe('如果结束');
    expect(show('SELECTCASE A')?.startsWith('当')).toBe(true);
    expect(show('ENDSELECT')).toBe('当结束');
    expect(show('WHILE A = 1')?.startsWith('循环 当')).toBe(true);
    expect(show('WEND')).toBe('循环结束');
  });
});

describe('ZH-C · 红线全表自证（整行逐字相等 = 失败）', () => {
  it('每一条命中都非空、都与输入行逐字不等、都含中文词形', () => {
    for (const [src] of ALL) {
      const got = show(src);
      expect(got, src).not.toBeNull();
      expect(got, src).not.toBe(src);
      expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
      expect(got ?? '', src).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    }
  });

  it('正例条数下限（本文件的自证面不许缩水）', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(40);
  });

  it('装配层接受本层的每一行（原样返回会被 `localizeNativeLine` 拒掉）', () => {
    for (const [src, want] of ALL) {
      expect(localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP }), src).toBe(want);
    }
  });
});

describe('ZH-C · lookup 缺席 ⇒ 只做语言层（关键字照翻，整行仍是中文形）', () => {
  const NO_TABLE: readonly Case[] = [
    ['IF TFLAG:193 == 1', '如果 TFLAG:193 等于 1：'],
    ['WHILE A < B', '循环 当 A 不足 B：'],
    ['SELECTCASE NOWEX:1', '当 NOWEX:1：'],
    ['ENDIF', '如果结束'],
    ['GOTO $X', '跳到 X'],
    ['#DIM A 10', '声明数组 A 大小 10'],
    ['CASE 1 TO 5', '是 1 到 5：'],
  ];

  it.each(NO_TABLE)('%s', (src, want) => {
    const got = showBare(src);
    expect(got, src).toBe(want);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
  });

  it('别名表只换族头字面，查不到的族名原样保留（不猜）', () => {
    expect(show('IF NOTAFAMILY:3 = 1')).toBe('如果 NOTAFAMILY:3 等于 1：');
    expect(show('IF TFLAG:193 = 1 && NOTAFAMILY:3 = 2')).toBe('如果 时标：193 等于 1 且 NOTAFAMILY:3 等于 2：');
  });
});

describe('ZH-C · 表里没有的指令 ⇒ null（宁缺勿猜）', () => {
  const UNKNOWN: readonly string[] = [
    'PRINTFORMW 你好',
    'TFLAG:193 = 1',
    'LOCAL = 5',
    'CALL K13_A',
    'DIM A 10',
    '#DEFINE MAX 5',
    '#DIMF A 10',
    '#INCLUDE "A.ERB"',
    'ENDDATA',
    'ONERROR',
    'IF',
    'ELSEIF',
    'SELECTCASE',
    'CASE',
    'WHILE',
    'SIF',
    'FOR i = 0',
    'FOR i TO 5',
    'GOTO',
    '$',
    'NEXT NEXT',
    'ENDIF 1',
    'REND REND',
    'i + 1 + 2',
    '@BEGIN_MAIN',
    '; 整行注释本来就是给人读的',
    '',
  ];

  it.each(UNKNOWN)('%s', (src) => {
    expect(show(src)).toBeNull();
    // 本层**弃权**（返 `null`）；装配层若命中也只可能是别的 pass 给的中文形，绝不许是原样
    const assembled = localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP });
    if (assembled !== null) expect(isVerbatimNativeLine(assembled, src), src).toBe(false);
  });
});

/* ------------------------------- 语料自证 ------------------------------- */

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 盘上最多取这么多份 `.ERB`（自证判据，不是覆盖率尺子；取满即止） */
function collectErb(root: string, out: string[], limit: number): void {
  if (out.length >= limit || !existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const full = join(root, entry.name);
    if (entry.isDirectory()) collectErb(full, out, limit);
    else if (/\.erb$/i.test(entry.name)) out.push(full);
  }
}

const corpusCase = SMOKE === undefined ? describe.skip : describe;

corpusCase('ZH-C · 真盘自证（凡本层命中的行，显示形必与原文逐字不同）', () => {
  it('扫语料 `.ERB`：命中数 > 0 且红线 0 命中', () => {
    const files: string[] = [];
    collectErb(join(SMOKE as string, 'ERB'), files, 40);
    let hits = 0;
    let checked = 0;
    for (const file of files) {
      // 语料是 CP932；这里只验 ASCII 控制行的**逐字不等**，故按单字节读入即可（不参与任何写回）
      const text = readFileSync(file, 'latin1');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0) continue;
        const got = renderControlLine({ content: line, indent: 0 });
        if (got === null) continue;
        hits += 1;
        checked += isVerbatimNativeLine(got, line) ? 1 : 0;
      }
    }
    expect(hits).toBeGreaterThan(0);
    expect(checked).toBe(0);
  });
});
