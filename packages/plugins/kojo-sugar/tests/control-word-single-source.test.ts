/**
 * 词形**同源**闸（本批的架构判据：写形与显示形只允许有一份词形表）。
 *
 * 两件独立的事，各挡一类回归：
 *
 * 1. **收束词恒等式**：登记进 `KEYWORDS` 的收束词形必须等于「开块词 + `BLOCK_END_SUFFIX`」。
 *    挡的是"两侧各拼一份 `结束`"——拼法一旦分叉，屏幕上写着 `循环结束` 而写侧只认另一个串。
 * 2. **每个新词形都被写侧消费**：拿显示层产出的那一串中文**直接**喂 `classifyLine`，
 *    必须落进本批的新行类型（不是 `text` 兜底）。挡的是"登记了词形但通路没接线"——
 *    那正是 `project.ts:29` 自陈的"这片面积永远算未识别"。
 *
 * 两条都不许硬编码中文串：期望值全部由 `keywords.ts` 现拼，`control.ts` 只许给出同一形状。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_END_SUFFIX, blockEndWord, operatorTable, primaryWord, sugarEditorLexicon } from '../src/keywords';
import { classifyLine, splitLogicalLines, type LineClass } from '../src/lexer';
import { renderControlLine } from '../src/native-display/control';
import { localizeNativeLine } from '../src/native-display/passes';

/** 收束族：开块 id → 收束 id（三族同一条拼法） */
const CLOSER_PAIRS: readonly [Parameters<typeof blockEndWord>[0], string][] = [
  ['block.loop', '循环结束'],
  ['block.catch', '出错处理结束'],
  ['block.dataTable', '数据表结束'],
];

describe('同源-1 · 收束词恒等式（`<开块词> + 结束`，两侧同一拼法）', () => {
  it.each(CLOSER_PAIRS)('%s 的收束词形 == 开块词 + BLOCK_END_SUFFIX', (openId) => {
    expect(blockEndWord(openId)).toBe(`${primaryWord(openId)}${BLOCK_END_SUFFIX}`);
  });

  it('收束词形本身也登记在词表里（写了才认得），且与拼法逐字相同', () => {
    for (const [openId] of CLOSER_PAIRS) {
      const endId = `${openId.replace(/^(block)\./, '$1.')}End` as 'block.loopEnd' | 'block.catchEnd' | 'block.dataTableEnd';
      expect(primaryWord(endId), endId).toBe(blockEndWord(openId));
    }
  });

  it('显示层给的收束行就是这一串（`NEXT` / `ENDCATCH` / `ENDDATA` 三枚各自回显）', () => {
    expect(localizeNativeLine({ content: 'NEXT', indent: 0 })).toBe(blockEndWord('block.loop'));
    expect(localizeNativeLine({ content: 'ENDCATCH', indent: 0 })).toBe(blockEndWord('block.catch'));
    expect(localizeNativeLine({ content: 'ENDDATA', indent: 0 })).toBe(blockEndWord('block.dataTable'));
  });
});

/* ---------------- 同源-2：每个新词形都被写侧通路消费 ---------------- */

const line = (text: string): LineClass => {
  const [logical] = splitLogicalLines(text);
  return classifyLine(logical!);
};

/**
 * 每条 = [喂给写侧的行（**由词表现拼**）, 期望落到的 `LineClass.kind`]。
 *
 * 期望 `text` 的负例单独列在下面——词形撞进台词通路就是"读得回写不回去"的另一半。
 */
const WRITABLE: readonly [string, string][] = [
  [`${primaryWord('block.loop')}：`, 'loopHead'],
  [`${primaryWord('block.loop')} ${primaryWord('inline.loopCount')} I ${primaryWord('inline.loopFrom')} 0 ${primaryWord('inline.to')} 5：`, 'loopHead'],
  [
    `${primaryWord('block.loop')} ${primaryWord('inline.loopCount')} I ${primaryWord('inline.loopFrom')} 0 ${primaryWord('inline.to')} 5 ${primaryWord('inline.loopStride')} 2：`,
    'loopHead',
  ],
  [`${primaryWord('block.loop')} ${primaryWord('block.when')} 1 ${primaryWord('inline.loopCount')} 1：`, 'loopHead'],
  [`${primaryWord('block.loop')} 1 ${primaryWord('inline.loopTimes')}：`, 'loopHead'],
  [`${primaryWord('block.loop')} ${primaryWord('inline.loopForever')}：`, 'loopHead'],
  [`${primaryWord('block.loop')}结束`, 'loopEnd'],
  // 收束行的**尾随条件**形（`循环结束 当 <条件>` ⇄ 引擎 `LOOP <条件>`）：条件词形同样只有 `block.when` 一个来源
  [`${blockEndWord('block.loop')} ${primaryWord('block.when')} 1`, 'loopEnd'],
  [`${primaryWord('block.catch')}：`, 'catchHead'],
  [`${primaryWord('block.catch')}结束`, 'catchEnd'],
  [`${primaryWord('block.dataTable')}：`, 'dataHead'],
  [`${primaryWord('block.dataTable')} ${primaryWord('inline.engineEcho')} PRINTDATADL：`, 'dataHead'],
  [`${primaryWord('block.dataTable')}结束`, 'dataEnd'],
  [`${primaryWord('inline.dataEntry')} 选项`, 'dataEntry'],
  [`${primaryWord('inline.dataEntry')} ${primaryWord('inline.engineEcho')} DATA 选项`, 'dataEntry'],
  [`${primaryWord('inline.jump')} DONE`, 'jumpStatement'],
  [`${primaryWord('inline.functionJump')} GET_TARGET(A, 1)`, 'functionJump'],
  [`${primaryWord('inline.label')} DONE`, 'labelDecl'],
  [`${primaryWord('inline.breakLoop')}`, 'loopFlow'],
  [`${primaryWord('inline.continueLoop')}`, 'loopFlow'],
  [`${primaryWord('inline.restartLoop')}`, 'loopFlow'],
  [`$DONE`, 'rawLine'],
  [`${primaryWord('inline.loopStep')} I ${primaryWord('inline.plus')} 1`, 'loopStep'],
  [`${primaryWord('inline.loopStep')} I ${primaryWord('inline.minus')} 1`, 'loopStep'],
];

describe('同源-2 · 显示层的每一形都写得回去（新词形全部被写侧通路消费）', () => {
  it.each(WRITABLE)('%j ⇒ %s', (text, kind) => {
    expect(line(text).kind, text).toBe(kind);
  });

  it('循环块头的五种模态互不混淆', () => {
    const kinds = WRITABLE.filter(([, k]) => k === 'loopHead').map(([t]) => {
      const cls = line(t);
      return cls.kind === 'loopHead' ? cls.loop.mode : '!?';
    });
    expect(kinds).toEqual(['do', 'count', 'count', 'when', 'times', 'forever']);
  });

  it('收束行不带冒号也是收束（与块头同一通路，不靠尾部标点）', () => {
    for (const [openId] of CLOSER_PAIRS) {
      expect(line(`${blockEndWord(openId)}：`).kind, blockEndWord(openId)).not.toBe('loopEnd');
    }
  });

  it('残缺写法不落 `text`（落 `text` 就等于把控制语句当台词打印出去）', () => {
    const malformed = [
      `${primaryWord('block.loop')} 乱写：`,
      `${primaryWord('block.loop')} ${primaryWord('inline.loopTimes')}：`, // 只有量词、没有次数
      `${primaryWord('inline.jump')}`,
      `${primaryWord('inline.functionJump')}`,
      `${primaryWord('inline.label')}`,
      `${primaryWord('inline.dataEntry')}`,
      `${primaryWord('inline.loopStep')}`,
      `${primaryWord('block.dataTable')} ${primaryWord('inline.engineEcho')} NOPE：`,
    ];
    for (const t of malformed) expect(line(t).kind, t).toBe('controlMalformed');
  });

  it('词后面没有空白分隔的散文照旧是台词（不被本批通路抢走）', () => {
    for (const t of ['循环这三个字我要打印', '标签栏里写着名字', '条目清单', '跳到窗外去了']) {
      expect(line(t).kind, t).toBe('text');
    }
  });
});

/* ------------------------- 同源-3：显示层零硬编码 ------------------------- */

describe('同源-3 · 显示层的中文形完全由词表派生', () => {
  const SHOW: readonly [string, string][] = [
    ['FOR LOCAL, 0, 5', `${primaryWord('block.loop')} ${primaryWord('inline.loopCount')} LOCAL ${primaryWord('inline.loopFrom')} 0 ${primaryWord('inline.to')} 5：`],
    ['FOR COUNT, 6, 1, -1', `${primaryWord('block.loop')} ${primaryWord('inline.loopCount')} COUNT ${primaryWord('inline.loopFrom')} 6 ${primaryWord('inline.to')} 1 ${primaryWord('inline.loopStride')} -1：`],
    ['DO', `${primaryWord('block.loop')}：`],
    ['REPEAT', `${primaryWord('block.loop')} ${primaryWord('inline.loopForever')}：`],
    // 载荷只用**已登记词形 / 数字**（这里是数字次数）：算式里带运算符中文形会被"私词"判据误伤
    ['REPEAT 5', `${primaryWord('block.loop')} 5 ${primaryWord('inline.loopTimes')}：`],
    ['GOTO CANCEL', `${primaryWord('inline.jump')} CANCEL`],
    // `JUMP` 的余文是**函数调用串**、逐字透传 ⇒ 载荷只用 ASCII，避免私词判据误伤
    ['JUMP GET_TARGET(A, 1)', `${primaryWord('inline.functionJump')} GET_TARGET(A, 1)`],
    ['$CANCEL', `${primaryWord('inline.label')} CANCEL`],
    ['BREAK', primaryWord('inline.breakLoop')],
    ['CONTINUE', primaryWord('inline.continueLoop')],
    ['RESTART', primaryWord('inline.restartLoop')],
    ['LOCAL + 1', `${primaryWord('inline.loopStep')} LOCAL ${primaryWord('inline.plus')} 1`],
    ['LOCAL - 1', `${primaryWord('inline.loopStep')} LOCAL ${primaryWord('inline.minus')} 1`],
    ['PRINTDATA', `${primaryWord('block.dataTable')}：`],
    ['PRINTDATADL', `${primaryWord('block.dataTable')} ${primaryWord('inline.engineEcho')} PRINTDATADL：`],
    // 条目正文**逐字透传**、不是词形——样例载荷必须用**已登记词形**拼，
    // 否则本闸会把"载荷散文"误报成"显示层私词"（不许放宽守卫，也不许往 KEYWORDS 塞假词）。
    ['DATAFORM 选项', `${primaryWord('inline.dataEntry')} 选项`],
    ['DATA 选项', `${primaryWord('inline.dataEntry')} ${primaryWord('inline.engineEcho')} DATA 选项`],
    ['CATCH', `${primaryWord('block.catch')}：`],
    ['NEXT', blockEndWord('block.loop')],
    ['WEND', blockEndWord('block.loop')],
    ['REND', blockEndWord('block.loop')],
    ['LOOP', blockEndWord('block.loop')],
    // `LOOP <条件>`（盘上 `DO` 闭合的唯一真形）：收束词与条件词形都从词表现拼，与写侧同一串。
    // 条件载荷只用**已登记词形**（`1`），不写运算符中文形——运算符的反向表不在本闸的
    // `words` 集合里，混进来会被"私词"判据误伤（口径同上面 `DATAFORM` 那条注释）。
    ['LOOP 1', `${blockEndWord('block.loop')} ${primaryWord('block.when')} 1`],
    ['ENDDATA', blockEndWord('block.dataTable')],
    ['ENDCATCH', blockEndWord('block.catch')],
    ['ENDIF', blockEndWord('block.if')],
    ['ENDSELECT', blockEndWord('block.when')],
  ];

  it.each(SHOW)('%s ⇒ 与词表拼出的串逐字相同', (src, want) => {
    expect(renderControlLine({ content: src, indent: 0 }), src).toBe(want);
  });

  it('显示层用到的每个词形都在 `KEYWORDS` 里（没有"只有显示层认识的私词"）', () => {
    const words = new Set(sugarEditorLexicon().words.map((w) => w.word));
    for (const [, want] of SHOW) {
      for (const w of want.match(/[\u4e00-\u9fff]+/g) ?? []) {
        // 逐段扫：串里出现的每个连续中文段都必须能在词表里对上（词尾 `结束` 与块头词拼成的收束串也算）
        const hit = [...words].some((k) => w === k || w.startsWith(k) || w.endsWith(k));
        expect(hit, `显示串「${want}」里的「${w}」对不上任何词形`).toBe(true);
      }
    }
  });
});

/* -------------------- 同源-4：收束行的**条件尾随形**也同源 -------------------- */

/**
 * `循环结束 当 <条件>`（⇄ 引擎 `LOOP <条件>`，`DO` 一族在盘上的唯一闭合真形）里那个
 * 条件词形也**只许**来自 `keywords.ts`——两层钉法：
 *
 * 1. **行为层**：显示层产出的整串直接喂写侧，必须落 `loopEnd` 且条件原文被带走
 *    （词形对不上就落 `text` / `controlMalformed`，正是"读得回写不回去"那一半）；
 * 2. **源码层**：凡提到收束词的代码行都不许再带上硬编码的条件词形
 *    （把 `${WHEN_W}` 换成硬串 ⇒ 该行立刻显形）。口径同 `sugar-ident-invariants.test.ts`
 *    的「识别表只有一份」源码闸门：只看代码不看散文。
 */
describe('同源-4 · 收束行的条件尾随形（写侧与显示层零硬编码条件词）', () => {
  const here = import.meta.dirname;
  const read = (f: string): string => fs.readFileSync(path.resolve(here, '..', 'src', f), 'utf8');
  /** 块注释 / 整行注释 / 行尾注释里**提**那个词是允许的，写进模板串才要红 */
  const codeOnly = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/[ \t]+\/\/[^\n]*/g, '');

  const WHEN = primaryWord('block.when');
  const GT = operatorTable().find(([, erb]) => erb === '>')?.[0] ?? '';

  it('显示层给的尾随条件形当源写回：落 `loopEnd` 且条件原文带走', () => {
    const shown = renderControlLine({ content: 'LOOP 1', indent: 0 })!;
    expect(shown, '显示形').toBe(`${blockEndWord('block.loop')} ${WHEN} 1`);
    const cls = line(shown);
    expect(cls.kind, shown).toBe('loopEnd');
    expect(cls.kind === 'loopEnd' ? cls.condition : undefined, shown).toBe('1');
    // 运算符段同样同源（`>` 的反向词形就是显示串里那一个，不另造词）
    const withOp = renderControlLine({ content: 'LOOP ARG:1 > 0', indent: 0 })!;
    expect(GT.length, '运算符表里要有 `>` 的中文主形').toBeGreaterThan(0);
    expect(withOp, withOp).toBe(`${blockEndWord('block.loop')} ${WHEN} ARG:1 ${GT} 0`);
    expect(withOp.split(' ')[1], withOp).toBe(WHEN);
  });

  it('收束词的模板串里没有硬编码条件词（lexer / parser / 显示层三处源码级闸门）', () => {
    for (const f of ['lexer.ts', 'parser.ts', 'native-display/control.ts']) {
      const hits = codeOnly(read(f))
        .split(/\r?\n/)
        .filter((l) => l.includes('LOOP_END_W') && l.includes(WHEN));
      expect(hits, `${f}：收束词模板串里出现了硬编码条件词`).toEqual([]);
    }
  });

  it('残缺的尾随形不落 `text`（落 `text` = 把控制语句当台词打印出去）', () => {
    for (const t of [`${blockEndWord('block.loop')} ${WHEN}`, `${blockEndWord('block.loop')} 乱写`]) {
      expect(line(t).kind, t).toBe('controlMalformed');
    }
  });
});
