/**
 * 分支走向折叠单测（v0.2 第九批；纯函数 + 合成注入）。
 *
 * 覆盖：IF 链三态（命中/ELSE 兜底/落空）/ unknown 阻断（后续真不可救）/
 * CASE 链（同行多谓词任一真命中 / CASEELSE 兜底）/ 嵌套可达性传播 /
 * 宽容（孤儿分支不崩）。
 */
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, PredicateReplay, ReplayOutcome } from '@kojo/plugin-api';
import { buildBranchOutcomes } from '../src/branches';

function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

function pred(line: number, outcome: ReplayOutcome, kind: PredicateReplay['kind'] = 'IF', text = `p${line}`): PredicateReplay {
  return { kind, text, line, expr: { kind: 'opaque', text }, outcome };
}

const T: ReplayOutcome = { kind: 'true' };
const F: ReplayOutcome = { kind: 'false' };
const U: ReplayOutcome = { kind: 'unknown', unknown: { code: 'call', message: 'x' } };

describe('IF 链折叠', () => {
  it('命中首个真分支', () => {
    const stmts = cf([
      ['IF', 'A', 0, 10],
      ['ELSEIF', 'B', 0, 20],
      ['ELSE', '', 0, 30],
      ['ENDIF', '', 0, 40],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, F), pred(20, T)]);
    expect(got).toHaveLength(1);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
    expect(got[0]!.kind).toBe('if-chain');
    expect(got[0]!.members).toHaveLength(3);
  });

  it('全假走 ELSE', () => {
    const stmts = cf([
      ['IF', 'A', 0, 10],
      ['ELSE', '', 0, 20],
      ['ENDIF', '', 0, 30],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, F)]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });

  it('全假无 ELSE → no-match（落空）', () => {
    const stmts = cf([
      ['IF', 'A', 0, 10],
      ['ENDIF', '', 0, 20],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, F)]);
    expect(got[0]!.outcome).toBe('no-match');
    expect(got[0]!.takenLine).toBeNull();
  });

  it('unknown 阻断整链（后续真也不可救）', () => {
    const stmts = cf([
      ['IF', 'A', 0, 10],
      ['ELSEIF', 'B', 0, 20],
      ['ENDIF', '', 0, 30],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, U), pred(20, T)]);
    expect(got[0]!.outcome).toBe('unknown');
    expect(got[0]!.takenLine).toBeNull();
    if (got[0]!.outcome === 'unknown') {
      expect(got[0]!.unknown?.code).toBe('call');
    }
  });

  it('前真后未知 → taken（unknown 被短路，不影响判定）', () => {
    const stmts = cf([
      ['IF', 'A', 0, 10],
      ['ELSEIF', 'B', 0, 20],
      ['ENDIF', '', 0, 30],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, T), pred(20, U)]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(10);
  });
});

describe('SELECTCASE 链折叠', () => {
  it('同行多谓词任一真即命中（CASE 逗号列表展开）', () => {
    const stmts = cf([
      ['SELECTCASE', 'X', 0, 10],
      ['CASE', '1, 2', 0, 20],
      ['CASE', '3', 0, 30],
      ['ENDSELECT', '', 0, 40],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(20, F, 'CASE'), pred(20, T, 'CASE'), pred(30, F, 'CASE')]);
    expect(got[0]!.kind).toBe('select-chain');
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });

  it('全假走 CASEELSE', () => {
    const stmts = cf([
      ['SELECTCASE', 'X', 0, 10],
      ['CASE', '1', 0, 20],
      ['CASEELSE', '', 0, 30],
      ['ENDSELECT', '', 0, 40],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(20, F, 'CASE')]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(30);
  });

  it('SELECTCASE 无 CASE 成员 → no-match', () => {
    const stmts = cf([
      ['SELECTCASE', 'X', 0, 10],
      ['ENDSELECT', '', 0, 20],
    ]);
    const got = buildBranchOutcomes(stmts, []);
    expect(got[0]!.outcome).toBe('no-match');
  });
});

describe('嵌套可达性传播', () => {
  const nested = cf([
    ['IF', 'A', 0, 10],
    ['IF', 'B', 1, 20], // THEN 体里的内层链
    ['ENDIF', '', 1, 30],
    ['ELSE', '', 0, 40],
    ['IF', 'C', 1, 50], // ELSE 体里的内层链
    ['ENDIF', '', 1, 60],
    ['ENDIF', '', 0, 70],
  ]);

  it('外层走 THEN → THEN 体链可达 / ELSE 体链不可达', () => {
    const got = buildBranchOutcomes(nested, [pred(10, T), pred(20, T), pred(50, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(10)!.outcome).toBe('taken');
    expect(byHead.get(20)!.outcome).toBe('taken'); // 外层命中 THEN → 内层可达
    expect(byHead.get(50)!.outcome).toBe('unreachable'); // ELSE 体不会进入
  });

  it('外层走 ELSE → ELSE 体链可达 / THEN 体链不可达', () => {
    const got = buildBranchOutcomes(nested, [pred(10, F), pred(20, T), pred(50, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(20)!.outcome).toBe('unreachable');
    expect(byHead.get(50)!.outcome).toBe('taken');
  });

  it('外层 unknown → 内层保留自身结果（不传播）', () => {
    const got = buildBranchOutcomes(nested, [pred(10, U), pred(20, T), pred(50, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(10)!.outcome).toBe('unknown');
    expect(byHead.get(20)!.outcome).toBe('taken');
    expect(byHead.get(50)!.outcome).toBe('taken');
  });

  it('外层 no-match（无 ELSE）→ 链体内不可达', () => {
    const noElse = cf([
      ['IF', 'A', 0, 10],
      ['IF', 'B', 1, 20],
      ['ENDIF', '', 1, 30],
      ['ENDIF', '', 0, 40],
    ]);
    const got = buildBranchOutcomes(noElse, [pred(10, F), pred(20, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(10)!.outcome).toBe('no-match');
    expect(byHead.get(20)!.outcome).toBe('unreachable');
  });
});

describe('宽容性', () => {
  it('孤儿 ELSEIF / 孤儿闭合 → 跳过不崩', () => {
    const stmts = cf([
      ['ELSEIF', 'X', 0, 5],
      ['ENDIF', '', 0, 6],
      ['IF', 'A', 0, 10],
      ['ENDIF', '', 0, 20],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, T)]);
    expect(got).toHaveLength(1);
    expect(got[0]!.headLine).toBe(10);
  });

  it('未闭合链（缺 ENDIF）→ 保留已收成员', () => {
    const stmts = cf([
      ['IF', 'A', 0, 10],
      ['ELSEIF', 'B', 0, 20],
    ]);
    const got = buildBranchOutcomes(stmts, [pred(10, F), pred(20, T)]);
    expect(got).toHaveLength(1);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });
});
