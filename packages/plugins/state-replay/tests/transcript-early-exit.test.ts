/**
 * E4（2026-11-05）：台词推演的 **RETURN / RETURNF 早退**。
 *
 * 旧行为只由分支链 + 同行 SIF 决定可见性，不建模早退 ⇒ `IF 真 / PRINT 甲 / RETURN /
 * ENDIF / PRINT 乙` 里 PRINT 乙 被误报 `shown`。现在：显示行之前若有**必然执行**的
 * 返回语句 ⇒ `hidden`。
 *
 * 覆盖：RETURN 之后的 PRINT → hidden / RETURNF 同族 / 兄弟分支里的 PRINT 不受影响 /
 * `SIF cond RETURN` 不宣称早退 / RETURN 之后有 `$` 标签不宣称（GOTO 可能跳过）/
 * 早退在 `maybe` 链里也压成 hidden / 早退不能把 `hidden` 改回 / 代码前缀 `;!;` 同族。
 */
import { describe, expect, it } from 'vitest';
import type {
  ControlFlowStatement,
  FunctionDisplayLine,
  FunctionPredicates,
  PredicateReplay,
  ReplayOutcome,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { buildBranchOutcomes } from '../src/branches';
import { buildTranscript } from '../src/transcript';
import type { ValueReader } from '../src/evaluate';

const T: ReplayOutcome = { kind: 'true' };
const F: ReplayOutcome = { kind: 'false' };
const U: ReplayOutcome = { kind: 'unknown', unknown: { code: 'call', message: '判不出' } };

function pred(
  line: number,
  outcome: ReplayOutcome,
  kind: PredicateReplay['kind'] = 'IF',
  text = `p${line}`,
): PredicateReplay {
  return { kind, text, line, expr: { kind: 'opaque', text }, outcome };
}

function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

function disp(line: number, verb: string, payload: string, sifGuarded = false): FunctionDisplayLine {
  return { line, verb, payload, interpolations: [], ...(sifGuarded ? { sifGuarded: true } : {}) };
}

function detail(
  displays: FunctionDisplayLine[],
  statements: ControlFlowStatement[],
  startLine = 1,
  endLine = 99,
): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'x.ERB',
    startLine,
    endLine,
    statements,
    predicates: [],
    assignments: [],
    returns: [],
    displays,
  };
}

function reader(values: Record<string, number | string> = {}): ValueReader {
  return (ref: VariableRef): ReplayValue => {
    const key = [ref.name, ...ref.indices].join(':');
    if (key in values) return { kind: 'value', value: values[key]! };
    return { kind: 'unknown', unknown: { code: 'other', message: `无 ${key}` } };
  };
}

function build(
  lines: readonly string[],
  displays: FunctionDisplayLine[],
  statements: ControlFlowStatement[],
  predicates: PredicateReplay[],
  endLine = 99,
) {
  return buildTranscript({
    detail: detail(displays, statements, 1, endLine),
    lines,
    predicates,
    branches: buildBranchOutcomes(statements, predicates),
    read: reader(),
  })!;
}

describe('E4 · 必然早退截断台词', () => {
  it('RETURN 之后的 PRINT → hidden（text 空 / unresolved 0 / 理由指到 RETURN 行）', () => {
    const lines = ['@FOO', 'PRINTL 甲', 'RETURN', 'PRINTL 乙'];
    const got = build(lines, [disp(2, 'PRINTL', '甲'), disp(4, 'PRINTL', '乙')], [], [], 4);
    expect(got.map((t) => t.visibility)).toEqual(['shown', 'hidden']);
    expect(got[0]!.text).toBe('甲');
    expect(got[1]!.text).toBe('');
    expect(got[1]!.unresolved).toBe(0);
    expect(got[1]!.guardLine).toBe(3);
    expect(got[1]!.reason?.message).toContain('第 3 行已经 RETURN');
    expect(got[1]!.reason?.message).toContain('这一行执行不到');
  });

  it('RETURNF 同族：`RETURNF 1` 之后的行同样 hidden', () => {
    const lines = ['@FOO', 'RETURNF 1', 'PRINTL 乙'];
    const got = build(lines, [disp(3, 'PRINTL', '乙')], [], [], 3);
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.reason?.message).toContain('第 2 行已经 RETURN');
  });

  it('代码前缀 `;!;` 之后的 RETURN 也是真代码（剥前缀口径同 loop-range）', () => {
    const lines = ['@FOO', ';!;RETURN', 'PRINTL 乙'];
    const got = build(lines, [disp(3, 'PRINTL', '乙')], [], [], 3);
    expect(got[0]!.visibility).toBe('hidden');
  });

  it('早退行之前的 PRINT 不受影响（只截断其后的输出）', () => {
    const lines = ['@FOO', 'PRINTL 甲', 'RETURN', 'PRINTL 乙'];
    const got = build(lines, [disp(2, 'PRINTL', '甲')], [], [], 4);
    expect(got[0]!.visibility).toBe('shown');
    expect(got[0]!.text).toBe('甲');
  });
});

describe('E4 · 路径判据：别支 / 链外的早退不算', () => {
  const stmts = cf([
    ['IF', 'A', 0, 2],
    ['ELSE', '', 0, 4],
    ['ENDIF', '', 0, 6],
  ]);

  it('兄弟分支里的 PRINT 不受影响 → shown（早退在另一成员的体内）', () => {
    const lines = ['@FOO', 'IF A', 'RETURN', 'ELSE', 'PRINTL 乙', 'ENDIF'];
    // IF 为假 ⇒ 走 ELSE 支；早退在第 3 行（IF 支体内），不在 ELSE 支的路径上
    const got = build(lines, [disp(5, 'PRINTL', '乙')], stmts, [pred(2, F)], 6);
    expect(got[0]!.visibility).toBe('shown');
    expect(got[0]!.text).toBe('乙');
  });

  it('早退在分支体内、显示行在链外（ENDIF 之后）→ 不宣称早退（保守：别支可能没走它）', () => {
    const s = cf([
      ['IF', 'A', 0, 2],
      ['ENDIF', '', 0, 4],
    ]);
    const lines = ['@FOO', 'IF A', 'RETURN', 'ENDIF', 'PRINTL 链外'];
    const got = build(lines, [disp(5, 'PRINTL', '链外')], s, [pred(2, T)], 5);
    expect(got[0]!.visibility).toBe('shown');
  });
});

describe('E4 · 保守闸', () => {
  it('`SIF cond RETURN` 是条件早退，不构成必然 → 不宣称', () => {
    const lines = ['@FOO', 'SIF FLAG:1 RETURN', 'PRINTL 乙'];
    const got = build(lines, [disp(3, 'PRINTL', '乙')], [], [], 3);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('RETURN 之后存在 `$` 标签行 → 不宣称（GOTO 可跳到标签之后）', () => {
    const lines = ['@FOO', 'RETURN', '$LOOP', 'PRINTL 乙'];
    const got = build(lines, [disp(4, 'PRINTL', '乙')], [], [], 4);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('`$` 标签在函数结束之后（越出 endLine）⇒ 不影响判定', () => {
    const lines = ['@FOO', 'RETURN', 'PRINTL 乙', '$OTHER_FUNC'];
    const got = build(lines, [disp(3, 'PRINTL', '乙')], [], [], 3);
    expect(got[0]!.visibility).toBe('hidden');
  });

  it('循环体内的 RETURN 不宣称早退（空区间时循环体一次都不执行）', () => {
    const s = cf([
      ['FOR', 'LOCAL,0,5', 0, 2],
      ['NEXT', '', 0, 4],
    ]);
    const lines = ['@FOO', 'FOR LOCAL,0,5', 'RETURN', 'NEXT', 'PRINTL 乙'];
    const got = build(lines, [disp(5, 'PRINTL', '乙')], s, [], 5);
    expect(got[0]!.visibility).toBe('shown');
  });
});

describe('E4 · 与分支链的组合', () => {
  const stmts = cf([
    ['IF', 'A', 0, 2],
    ['ELSE', '', 0, 5],
    ['ENDIF', '', 0, 7],
  ]);

  it('早退在 `maybe` 链里也压成 hidden（同一成员体内：两种走向都执行不到本行）', () => {
    const lines = ['@FOO', 'IF A', 'RETURN', 'PRINTL 甲', 'ELSE', 'PRINTL 乙', 'ENDIF'];
    const got = build(lines, [disp(4, 'PRINTL', '甲'), disp(6, 'PRINTL', '乙')], stmts, [pred(2, U)], 7);
    // 第 4 行在 IF 支体内、早退（第 3 行）也在同一成员体内 ⇒ hidden
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.reason?.message).toContain('第 3 行已经 RETURN');
    // 第 6 行在 ELSE 支：早退不在本行路径上，链判不出 ⇒ 仍是 maybe（不许误压）
    expect(got[1]!.visibility).toBe('maybe');
  });

  it('早退不能把 `hidden` 改回：分支链的"走了别处"原因保留更具体的那条', () => {
    const s = cf([
      ['IF', 'A', 0, 3],
      ['ENDIF', '', 0, 5],
    ]);
    // 早退在链外（第 2 行），显示行在"全部未命中"的链体内（第 4 行）
    const lines = ['@FOO', 'RETURN', 'IF A', 'PRINTL 甲', 'ENDIF'];
    const got = build(lines, [disp(4, 'PRINTL', '甲')], s, [pred(3, F)], 5);
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.reason?.message).toContain('全部未命中');
    expect(got[0]!.reason?.message).not.toContain('RETURN');
  });
});
