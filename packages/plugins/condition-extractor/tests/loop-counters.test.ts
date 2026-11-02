/**
 * 计数循环的循环量收集 单测（KW-15C 1103）。
 *
 * 语句序列手工构造（与 scanControlFlow 的 kind/depth 约定一致：`FOR` 与配对的
 * `NEXT` 同深度，体内更深），行号与源码行一一对应，验证抽取侧只发布**结构上可信**的循环：
 * - 字面端点 + 配对完好 + 体内无标签 ⇒ 发布（含 `FOR LOCAL,0,5` 这条真语料主形态）；
 * - 表达式端点 / 区间过宽 / 体内有标签行 / 未配对 ⇒ 一律不发布（宁缺勿错）；
 * - `firstBodyLine` 跳过注释、`@#$` 行与 `[SKIPSTART]…[SKIPEND]` 停用区；
 * - 明细视图（给 source）才填 `loopCounters`，与 `assignments` 同口径。
 */
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { collectLoopCounters, extractFunctionPredicates } from '../src/extract';

function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

function toLines(...lines: string[]): string[] {
  return lines;
}

describe('collectLoopCounters · 发布条件', () => {
  it('字面端点的 FOR：槽位 / 区间 / 体区间 / 体内第一条真代码行', () => {
    // 真语料形态（M_KOJO_K49_カウンター.ERB:35-42 的骨架）
    const lines = toLines(
      '@TEST',
      'FOR LOCAL,0,5',
      '  IF PALAM:LOCAL + CUP:LOCAL > 9000',
      '    LOCAL:1 = 2',
      '    BREAK',
      '  ENDIF',
      'NEXT',
    );
    const stmts = cf([
      ['FOR', 'LOCAL,0,5', 0, 2],
      ['IF', 'PALAM:LOCAL + CUP:LOCAL > 9000', 1, 3],
      ['ENDIF', '', 1, 6],
      ['NEXT', '', 0, 7],
    ]);
    expect(collectLoopCounters(lines, stmts)).toEqual([
      { name: 'LOCAL', index: 0, openLine: 2, closeLine: 7, lo: 0, hi: 5, firstBodyLine: 3 },
    ]);
  });

  it('下标形态与倒序端点：折成闭区间（不看步进方向，超近似）', () => {
    const lines = toLines('@TEST', 'FOR LOCAL:2,7,10,-1', '  IF LOCAL:2 > 3', '  ENDIF', 'NEXT');
    const stmts = cf([
      ['FOR', 'LOCAL:2,7,10,-1', 0, 2],
      ['IF', 'LOCAL:2 > 3', 1, 3],
      ['ENDIF', '', 1, 4],
      ['NEXT', '', 0, 5],
    ]);
    const got = collectLoopCounters(lines, stmts);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: 'LOCAL', index: 2, lo: 7, hi: 10, firstBodyLine: 3 });
  });

  it('表达式端点不发布（区间无从枚举 ⇒ 硬算就是猜）', () => {
    const lines = toLines('@TEST', 'FOR LOCAL,1,CHARANUM', '  IF LOCAL > 2', 'NEXT');
    const stmts = cf([
      ['FOR', 'LOCAL,1,CHARANUM', 0, 2],
      ['IF', 'LOCAL > 2', 1, 3],
      ['NEXT', '', 0, 4],
    ]);
    expect(collectLoopCounters(lines, stmts)).toEqual([]);
  });

  it('区间过宽不发布（逐值试算的代价必须有界）', () => {
    const lines = toLines('@TEST', 'FOR LOCAL,0,999', '  IF LOCAL > 2', 'NEXT');
    const stmts = cf([
      ['FOR', 'LOCAL,0,999', 0, 2],
      ['IF', 'LOCAL > 2', 1, 3],
      ['NEXT', '', 0, 4],
    ]);
    expect(collectLoopCounters(lines, stmts)).toEqual([]);
  });

  it('体内有标签行 ⇒ 不发布（体外可能跳进体内，循环量就不是本次头值了）', () => {
    const lines = toLines('@TEST', 'FOR LOCAL,0,5', '  IF LOCAL > 2', '    LOCAL = 9', '  ENDIF', 'NEXT');
    lines[4] = '$MID';
    const stmts = cf([
      ['FOR', 'LOCAL,0,5', 0, 2],
      ['IF', 'LOCAL > 2', 1, 3],
      ['ENDIF', '', 1, 5],
      ['NEXT', '', 0, 6],
    ]);
    expect(collectLoopCounters(lines, stmts)).toEqual([]);
  });

  it('未配对到 NEXT ⇒ 不发布（不猜体区间）', () => {
    const lines = toLines('@TEST', 'FOR LOCAL,0,5', '  IF LOCAL > 2', 'ENDIF');
    const stmts = cf([
      ['FOR', 'LOCAL,0,5', 0, 2],
      ['IF', 'LOCAL > 2', 1, 3],
      ['ENDIF', '', 1, 4],
    ]);
    expect(collectLoopCounters(lines, stmts)).toEqual([]);
  });

  it('体内第一条真代码行：注释 / `@#$` / SKIP 区都不算', () => {
    const lines = toLines(
      '@TEST',
      'FOR LOCAL,0,5',
      '; 一句废话注释',
      '[SKIPSTART]',
      'LOCAL = 1',
      '[SKIPEND]',
      '  IF LOCAL > 2',
      'NEXT',
    );
    const stmts = cf([
      ['FOR', 'LOCAL,0,5', 0, 2],
      ['IF', 'LOCAL > 2', 1, 7],
      ['NEXT', '', 0, 8],
    ]);
    const got = collectLoopCounters(lines, stmts);
    expect(got).toHaveLength(1);
    expect(got[0]!.firstBodyLine).toBe(7);
  });

  it('嵌套 FOR：内层先收口，外层配对到自己的那条 NEXT', () => {
    const lines = toLines(
      '@TEST',
      'FOR LOCAL,0,3',
      '  FOR LOCAL:1,0,2',
      '    IF LOCAL:1 > 0',
      '    NEXT',
      '  IF LOCAL > 0',
      'NEXT',
    );
    const stmts = cf([
      ['FOR', 'LOCAL,0,3', 0, 2],
      ['FOR', 'LOCAL:1,0,2', 1, 3],
      ['IF', 'LOCAL:1 > 0', 2, 4],
      ['NEXT', '', 1, 5],
      ['IF', 'LOCAL > 0', 1, 6],
      ['NEXT', '', 0, 7],
    ]);
    const got = collectLoopCounters(lines, stmts);
    expect(got.map((c) => [c.name, c.index, c.openLine, c.closeLine, c.firstBodyLine])).toEqual([
      ['LOCAL', 0, 2, 7, 3],
      ['LOCAL', 1, 3, 5, 4],
    ]);
  });
});

describe('extractFunctionPredicates · loopCounters 供应条件', () => {
  const fn = { normalizedName: 'TEST_FUNC', filePath: 'a.erb', startLine: 1 };

  it('给了 source 才填（与 assignments 同口径）', () => {
    const lines = toLines('@TEST_FUNC', 'FOR LOCAL,0,5', '  IF PALAM:LOCAL > 9000', 'NEXT');
    const stmts = cf([
      ['FOR', 'LOCAL,0,5', 0, 2],
      ['IF', 'PALAM:LOCAL > 9000', 1, 3],
      ['NEXT', '', 0, 4],
    ]);
    const withSource = extractFunctionPredicates(fn, stmts, { lines, endLine: 4 });
    expect(withSource.loopCounters).toHaveLength(1);
    const withoutSource = extractFunctionPredicates(fn, stmts);
    expect(withoutSource.loopCounters).toBeUndefined();
  });
});
