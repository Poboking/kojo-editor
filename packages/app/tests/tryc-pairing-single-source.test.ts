/**
 * TRYC→CATCH 配对表**单一真源**守卫（看板 D03b）——配对这一问只许有一份表。
 *
 * 背景：真源是 `packages/erb-vocab/src/control-flow.ts` 的私有 `TRY_CATCH_OPEN`（配 `CATCH`
 * 那一档）+ `CATCH`/`ENDCATCH` 配对，出口是 `classifyControlFlow` / `openKindsForPair`。
 * 曾经有四份手抄副本各答各的（段栈 / 糖结构栈 / 格式化缩进 / 可达性跳转族），其中**答同一个
 * 问题**的三份（段栈、糖结构栈、缩进表）在真源按引擎 `FunctionIdentifier.cs` 的
 * `funcMatch[X]="CATCH"` 补词（`TRYCJUMPSTR` / `TRYCCALLSTR`）时必然落后，后果是同一行
 * 在骨架里数进嵌套、在副本里没数＝**幻影深度**：条件抽取把 `CATCH` 区里的赋值当可达、
 * 糖视图把块体当台词投影、格式化器少抬一层。
 *
 * 四道闸（照宿主 Monaco 层同一纪律，见 `kojo-lexicon-single-source.test.ts` /
 * `packages/kojo-syntax-tree/tests/word-forms-single-source.test.ts`）：
 * - (a) **真源自洽**：`openKindsForPair(pair)` 必须与逐词 `classifyControlFlow` 同判——
 *   一枚函数反查一张表，不许真源内部先出现两份口径；
 * - (b) **消费方逐词相等**：段栈（condition-extractor）、糖结构栈（kojo-vocab `pairOf` /
 *   `TRY_CATCH_OPEN`）、缩进表（kojo-vocab formatter）对**每一枚**真源 TRYC 开块词给同一个
 *   答案。断言全部从真源运行时取集合，**不钉枚数**（6 枚 → 8 枚这一批改动零改动过闸）；
 * - (c) **零抄本**：上述三个产品的源码去注释后不得再出现 TRYC 词的字面量枚举（同判据用
 *   一段合成"抄本"做正向对照，证明这条正则不是空跑）；
 * - (d) **合法的独立尺子登记**：另两把尺子问的**不是**配对，禁止为了过闸把它们并进来
 *   （可达性跳转族、引擎指令名册），断言它们与真源集合**不相等**。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { classifyControlFlow, ERB_CONTROL_STATEMENTS, openKindsForPair } from '@kojo/erb-vocab/control-flow';
import { pairOf, TRY_CATCH_OPEN, TRY_LIST_OPEN } from '@kojo/kojo-vocab/sugar-ident';
import { formatText } from '@kojo/kojo-vocab/formatter';
import { buildContextLookup } from '../../plugins/condition-extractor/src/extract';
import { isInstructionName } from '../../plugins/erb-parser/src/instructions';

/** 真源里"配 CATCH 的开块全集"（运行时取，绝不写死枚数） */
const TRYC = openKindsForPair('try');
/** 真源里"配 ENDFUNC 的 TRY…LIST 一族" */
const TRYLIST = openKindsForPair('funclist');
/** 引擎表里的 TRY 单行档（真源判"不开块"；用作负向对照，不含 `*STR` 变体） */
const TRY_SINGLE_LINES = ['TRYCALL', 'TRYCALLFORM', 'TRYGOTO', 'TRYJUMP', 'TRYGOTOFORM', 'TRYJUMPFORM'];

describe('(a) 真源自洽：反查函数与逐词分类同一张嘴', () => {
  it('openKindsForPair 与 classifyControlFlow 逐词相等（try / funclist 两档）', () => {
    for (const pair of ['try', 'funclist']) {
      const fromList = new Set(openKindsForPair(pair));
      const fromClassify = new Set(
        ERB_CONTROL_STATEMENTS.filter((w) => {
          const flow = classifyControlFlow(w);
          return flow !== null && flow.role === 'open' && flow.pair === pair;
        }),
      );
      expect([...fromList].sort(), `pair=${pair}`).toEqual([...fromClassify].sort());
    }
  });

  it('两档互斥且非空（枚数只随引擎表走，本守卫不钉死）', () => {
    expect(TRYC.length).toBeGreaterThanOrEqual(6);
    expect(TRYLIST.length).toBeGreaterThanOrEqual(3);
    expect(TRYC.filter((w) => TRYLIST.includes(w))).toEqual([]);
  });

  it('单行档 TRY 词一律不算开块（BUG-2 的幻影深度根因）', () => {
    for (const word of TRY_SINGLE_LINES) {
      expect(classifyControlFlow(word)?.role ?? null, word).not.toBe('open');
      expect(TRYC, word).not.toContain(word);
    }
  });
});

describe('(b) 消费方逐词相等：三份副本读到的就是真源', () => {
  it('kojo-vocab 糖侧集合 = 真源（TRY_CATCH_OPEN / TRY_LIST_OPEN 派生）', () => {
    expect([...TRY_CATCH_OPEN].sort()).toEqual([...TRYC].sort());
    expect([...TRY_LIST_OPEN].sort()).toEqual([...TRYLIST].sort());
  });

  /** `IF` 外壳里再套一枚待测词：开块 ⇒ 段栈多一层；分支 ⇒ 同层换段；闭合 ⇒ 弹回 */
  const contextsFor = (kind: string): { after: string[]; atCatch: string[]; afterEnd: string[] } => {
    const stmts: ControlFlowStatement[] = [
      { kind, expression: '1', depth: 0, line: 1 },
      { kind: 'CATCH', expression: '', depth: 0, line: 2 },
      { kind: 'ENDCATCH', expression: '', depth: 0, line: 3 },
      { kind: 'ENDIF', expression: '', depth: 0, line: 4 },
    ];
    const contextOf = buildContextLookup(stmts);
    return { after: contextOf(2), atCatch: contextOf(3), afterEnd: contextOf(4) };
  };

  it('condition-extractor 段栈：每枚真源 TRYC 词都开一层，CATCH 换段、ENDCATCH 弹回', () => {
    for (const word of TRYC) {
      const c = contextsFor(word);
      expect(c.after.length, `${word} 开块`).toBe(1);
      expect(c.atCatch.length, `${word} 分支换段不平`).toBe(1);
      expect(c.atCatch[0], `${word} 分支必须给新段 id`).not.toBe(c.after[0]);
      expect(c.afterEnd, `${word} 闭合弹空`).toEqual([]);
    }
    // 单行档不动栈（与真源同判，不是"副本恰好也没有"）
    for (const word of TRY_SINGLE_LINES) {
      const c = contextsFor(word);
      expect(c.after.length, `${word} 不该开块`).toBe(0);
      expect(c.atCatch, `${word} 之后的孤儿 CATCH 不动栈`).toEqual([]);
    }
  });

  it('kojo-vocab pairOf：对全部引擎控制词与真源同判（糖表只留形态，不留配对）', () => {
    for (const word of ERB_CONTROL_STATEMENTS) {
      const flow = classifyControlFlow(word);
      const expected = flow !== null && flow.role === 'open' ? flow.pair : null;
      expect(pairOf(word), word).toBe(expected);
    }
    for (const word of TRY_SINGLE_LINES) expect(pairOf(word), word).toBeNull();
  });

  /** 开块词后面那一行是否被抬一层（缩进单位由前一个 IF 块探测出来） */
  const formatterIndentsBody = (kind: string): boolean => {
    const text = `@MAIN\r\nIF 1\r\n    LOCAL = 1\r\nENDIF\r\n${kind} 1\r\nLOCAL = 2\r\nENDCATCH\r\n`;
    const { text: out } = formatText(text, 'erb');
    return out.split(/\r?\n/).some((l) => /^ +LOCAL = 2$/.test(l));
  };

  it('kojo-vocab 缩进表：每枚真源 TRYC 词都抬一层；数据表族按格式化器自己的判据不抬', () => {
    for (const word of TRYC) expect(formatterIndentsBody(word), word).toBe(true);
    for (const word of TRY_SINGLE_LINES) expect(formatterIndentsBody(word), word).toBe(false);
    // 独立判据登记：`data` / `list` 族块体＝正文，由 erbBodyLineMask 整块护住，不参与缩进
    expect(formatterIndentsBody('STRDATA')).toBe(false);
  });
});

describe('(c) 零抄本：产品源码里不许再出现 TRYC 字面量枚举', () => {
  const codeOnly = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** TRYC 系字面量枚举的形状：`'TRYC…'` 出现在代码区（注释里的历史叙述不算） */
  const FORKED_ROSTER = /['"]TRYC(?:GOTO|JUMP|CALL)[A-Z]*/;

  for (const rel of [
    '../../plugins/condition-extractor/src/extract.ts',
    '../../kojo-vocab/src/formatter.ts',
  ]) {
    it(`${rel} 无抄本`, () => {
      const src = codeOnly(readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));
      expect(src, `${rel} 又手抄了一份 TRYC 名单`).not.toMatch(FORKED_ROSTER);
    });
  }

  it('正向对照：这条判据真的拦得住一份抄本（不是空跑）', () => {
    const fakeFork = "const LOCAL_TRYC = new Set(['TRYCGOTO', 'TRYCCALLSTR']);";
    expect(fakeFork).toMatch(FORKED_ROSTER);
    // 真源派生出来的写法必须放过（否则 (c) 会把派生也当成抄本）
    expect("new Set(openKindsForPair('try'))").not.toMatch(FORKED_ROSTER);
  });

  it('糖形态名单（CONTROL_SHAPES）只服务显示，配对一律走真源兜底', () => {
    // 真源补词后糖表未必登记形态条目——那种词 `pairOf` 仍必须给对的族（结构栈不落后）
    const probe = 'TRYCJUMPSTR';
    expect(classifyControlFlow(probe) === null || classifyControlFlow(probe)!.role === 'open').toBe(true);
    if (!TRY_CATCH_OPEN.has(probe)) {
      // 真源还没收录这一枚（引擎表尚未补词）：此刻糖表少一层是**已知欠账**，登记在此处而非注释里
      expect(pairOf(probe)).toBeNull();
    } else {
      expect(pairOf(probe), probe).toBe('try');
    }
  });
});

describe('(d) 合法的独立尺子：不许为了全绿把它们并成一份', () => {
  it('erb-parser 指令名册 ⊋ 配对表（问"是不是引擎指令 / 名字槽在哪"）', () => {
    for (const word of TRY_SINGLE_LINES) {
      expect(isInstructionName(word), word).toBe(true);
      expect(classifyControlFlow(word)?.role ?? null, word).not.toBe('open');
    }
    // 名册含配对表外的动词（RETURN 系），配对表含名册外的形状——两把尺子不互相包含
    expect(isInstructionName('RETURN')).toBe(true);
  });

  it('state-replay 跳转族 ≠ 配对表（问"这行造不造两条可达边"）', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '../../plugins/state-replay/src/reachability.ts'), 'utf8');
    const block = /CONDITIONAL_JUMP_INSTRUCTIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block, 'reachability.ts 的跳转族名单形状变了，守卫需要跟着改判据').not.toBeNull();
    const roster = new Set([...block![1]!.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]!));
    // 含单行跳转（真源判不开块）⇒ 与 TRYC 档必然不相等：谁"顺手合并"谁红
    expect(roster.has('TRYGOTO')).toBe(true);
    expect(roster.has('TRYJUMP')).toBe(true);
    expect([...roster].sort()).not.toEqual([...TRYC].sort());
    // 且不认领 CALL 系（跳转族的语义边界）
    expect([...roster].filter((w) => w.startsWith('TRYCCALL'))).toEqual([]);
    // 引擎表若补出 `TRYCJUMPSTR`，跳转族的名单**不由本守卫代为扩张**——那是 state-replay
    // 车道的可达性判据（跳得成/跳不成两条边是否成立），改动需带语料实测。
  });
});
