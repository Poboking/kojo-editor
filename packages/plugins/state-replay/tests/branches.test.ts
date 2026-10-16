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

  // 2026-10-16 修复回归：可达性必须逐条包络链校验（旧版只取深度最小=最外层，
  // 中间链 no-match 被跳过 → 内层误判可达；最外层 unknown → 传播整体跳过）。
  const threeLevel = cf([
    ['IF', 'A', 0, 10],
    ['IF', 'B', 1, 20],
    ['IF', 'C', 2, 30],
    ['ENDIF', '', 2, 40],
    ['ENDIF', '', 1, 50],
    ['ENDIF', '', 0, 60],
  ]);

  it('三层嵌套：中间链 no-match 时内层不可达（旧版只看最外层会误判可达）', () => {
    const got = buildBranchOutcomes(threeLevel, [pred(10, T), pred(20, F), pred(30, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(10)!.outcome).toBe('taken');
    expect(byHead.get(20)!.outcome).toBe('no-match');
    expect(byHead.get(30)!.outcome).toBe('unreachable');
  });

  it('三层嵌套：全部包络链都命中 → 内层可达', () => {
    const got = buildBranchOutcomes(threeLevel, [pred(10, T), pred(20, T), pred(30, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(30)!.outcome).toBe('taken');
  });

  it('三层嵌套：内层头落在中间链未命中分支（ELSE 体）→ 不可达', () => {
    const withElse = cf([
      ['IF', 'A', 0, 10],
      ['IF', 'B', 1, 20],
      ['ELSE', '', 1, 30],
      ['IF', 'C', 2, 40],
      ['ENDIF', '', 2, 50],
      ['ENDIF', '', 1, 60],
      ['ENDIF', '', 0, 70],
    ]);
    const got = buildBranchOutcomes(withElse, [pred(10, T), pred(20, T), pred(40, T)]);
    const byHead = new Map(got.map((g) => [g.headLine, g]));
    expect(byHead.get(20)!.outcome).toBe('taken');
    expect(byHead.get(40)!.outcome).toBe('unreachable');
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

describe('CASE TO 区间 AND 组（v0.2 第十二批修复 H1）', () => {
  /** 带 conjunction 标记的谓词（TO 半边） */
  function apred(line: number, outcome: ReplayOutcome, conjunction: 'and' | undefined): PredicateReplay {
    return { kind: 'CASE', text: '240 TO 359', line, expr: { kind: 'opaque', text: 'TO' }, outcome, ...(conjunction ? { conjunction } : {}) };
  }

  it('TO 半边 OR 误判复现：单边 <= 真不能命中区间（修复后 no-match）', () => {
    const stmts = cf([
      ['SELECTCASE', 'TIME', 0, 10],
      ['CASE', '240 TO 359', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    // 旧实现：>=240 假 + <=359 真 → 任一真 = 误命中；修复后 AND 组 → 假
    const got = buildBranchOutcomes(stmts, [apred(20, F, 'and'), apred(20, T, 'and')]);
    expect(got[0]!.outcome).toBe('no-match');
    expect(got[0]!.takenLine).toBeNull();
  });

  it('区间两端都真 → 命中', () => {
    const stmts = cf([
      ['SELECTCASE', 'TIME', 0, 10],
      ['CASE', '240 TO 359', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    const got = buildBranchOutcomes(stmts, [apred(20, T, 'and'), apred(20, T, 'and')]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });

  it('AND 组内一边假一边 unknown → 组假（Kleene：false && unknown = false），走 CASEELSE', () => {
    const stmts = cf([
      ['SELECTCASE', 'TIME', 0, 10],
      ['CASE', '240 TO 359', 0, 20],
      ['CASEELSE', '', 0, 30],
      ['ENDSELECT', '', 0, 40],
    ]);
    const got = buildBranchOutcomes(stmts, [apred(20, F, 'and'), apred(20, U, 'and')]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(30);
  });

  it('AND 组内全真但缺信息 → 一真一 unknown → 组未知（阻断整链）', () => {
    const stmts = cf([
      ['SELECTCASE', 'TIME', 0, 10],
      ['CASE', '240 TO 359', 0, 20],
      ['CASEELSE', '', 0, 30],
      ['ENDSELECT', '', 0, 40],
    ]);
    const got = buildBranchOutcomes(stmts, [apred(20, T, 'and'), apred(20, U, 'and')]);
    expect(got[0]!.outcome).toBe('unknown');
  });

  it('同一 CASE 多个 TO 区间（`1 TO 3, 5 TO 7`）各成一组：落在第二个区间仍命中', () => {
    const stmts = cf([
      ['SELECTCASE', 'TIME', 0, 10],
      ['CASE', '1 TO 3, 5 TO 7', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    // 抽取层逐部分 push：>=1, <=3, >=5, <=7（全 'and'）。v=6 → [T,F,T,T]
    // 旧实现把整段 'and' 并成一组 → T&&F&&T&&T = 假 → 区间内误判未命中。
    const got = buildBranchOutcomes(stmts, [
      apred(20, T, 'and'),
      apred(20, F, 'and'),
      apred(20, T, 'and'),
      apred(20, T, 'and'),
    ]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });

  it('同一 CASE 多个 TO 区间：落在区间外仍落空（组间 OR 不误命中）', () => {
    const stmts = cf([
      ['SELECTCASE', 'TIME', 0, 10],
      ['CASE', '1 TO 3, 5 TO 7', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    // v=4 → [>=1 T, <=3 F, >=5 F, <=7 T] → 两组皆假 → 落空
    const got = buildBranchOutcomes(stmts, [
      apred(20, T, 'and'),
      apred(20, F, 'and'),
      apred(20, F, 'and'),
      apred(20, T, 'and'),
    ]);
    expect(got[0]!.outcome).toBe('no-match');
    expect(got[0]!.takenLine).toBeNull();
  });

  it('混排（`CASE 1, 240 TO 359, 5`）——OR 组真仍命中，AND 组假不拦截', () => {
    const stmts = cf([
      ['SELECTCASE', 'X', 0, 10],
      ['CASE', '1, 240 TO 359, 5', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    // ==1 假(OR) + (>=240 假, <=359 真)(AND组=假) + ==5 真(OR) → 命中
    const got = buildBranchOutcomes(stmts, [
      pred(20, F, 'CASE'),
      apred(20, F, 'and'),
      apred(20, T, 'and'),
      pred(20, T, 'CASE'),
    ]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });

  it('混排反向：AND 组真、OR 组全假 → 命中（组间 OR）', () => {
    const stmts = cf([
      ['SELECTCASE', 'X', 0, 10],
      ['CASE', '1, 240 TO 359, 5', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    const got = buildBranchOutcomes(stmts, [
      pred(20, F, 'CASE'),
      apred(20, T, 'and'),
      apred(20, T, 'and'),
      pred(20, F, 'CASE'),
    ]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });

  it('向后兼容：无标记老数据按 OR（原有行为不变）', () => {
    const stmts = cf([
      ['SELECTCASE', 'X', 0, 10],
      ['CASE', '240 TO 359', 0, 20],
      ['ENDSELECT', '', 0, 30],
    ]);
    const got = buildBranchOutcomes(stmts, [apred(20, F, undefined), apred(20, T, undefined)]);
    expect(got[0]!.outcome).toBe('taken');
    expect(got[0]!.takenLine).toBe(20);
  });
});
