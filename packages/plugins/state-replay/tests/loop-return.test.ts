/**
 * E5（2026-11-05 状态回放边界批 · 车道 S2）：**空区间循环里的 RETURN**。
 *
 * E4 对"在循环体内"的 RETURN 一律保守（循环可能 0 次迭代 ⇒ 不宣称早退）。
 * 本批只放开**可证明**的一种：`FOR v,lo,hi` 区间字面量非空（`lo < hi`，引擎终值不取）
 * 且 RETURN 是该循环体第一条可执行行 ⇒ 第一轮就执行，必然早退。
 *
 * 其余形状（空区间 / 区间含变量 / RETURN 不在首行 / WHILE / SKIP 区 / 嵌套 / 显式步进）
 * 全部维持 E4 保守——本文件逐个钉住，防止有人"顺手放宽"。
 */
import { describe, expect, it } from 'vitest';
import type {
  ControlFlowStatement,
  FunctionDisplayLine,
  FunctionLoopCounter,
  FunctionPredicates,
  PredicateReplay,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { buildBranchOutcomes } from '../src/branches';
import { buildTranscript } from '../src/transcript';
import type { ValueReader } from '../src/evaluate';

function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

function disp(line: number, verb: string, payload: string): FunctionDisplayLine {
  return { line, verb, payload, interpolations: [] };
}

function detail(
  displays: FunctionDisplayLine[],
  statements: ControlFlowStatement[],
  loopCounters: FunctionLoopCounter[],
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
    loopCounters,
  };
}

function reader(): ValueReader {
  return (ref: VariableRef): ReplayValue => ({
    kind: 'unknown',
    unknown: { code: 'other', message: `无 ${ref.name}` },
  });
}

function build(
  lines: readonly string[],
  displays: FunctionDisplayLine[],
  statements: ControlFlowStatement[],
  loopCounters: FunctionLoopCounter[],
  predicates: PredicateReplay[] = [],
  endLine = 99,
) {
  return buildTranscript({
    detail: detail(displays, statements, loopCounters, 1, endLine),
    lines,
    predicates,
    branches: buildBranchOutcomes(statements, predicates),
    read: reader(),
  })!;
}

/** `FOR LOCAL,0,3`：头 2 / 体首行 3 / 配对 NEXT 4 */
const FOR_0_3: FunctionLoopCounter = {
  name: 'LOCAL',
  index: 0,
  openLine: 2,
  closeLine: 4,
  lo: 0,
  hi: 3,
  firstBodyLine: 3,
};

describe('E5 · 可证明非空的 FOR + 首行 RETURN → 截断', () => {
  it('`FOR LOCAL,0,3` + 首行 RETURN → 其后的 PRINT hidden，理由指到 RETURN 行', () => {
    const lines = ['@FOO', 'FOR LOCAL,0,3', 'RETURN', 'NEXT', 'PRINTL 乙'];
    const statements = cf([
      ['FOR', 'LOCAL,0,3', 0, 2],
      ['NEXT', '', 0, 4],
    ]);
    const got = build(lines, [disp(5, 'PRINTL', '乙')], statements, [FOR_0_3], [], 5);
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.guardLine).toBe(3);
    expect(got[0]!.reason?.message).toContain('第 3 行已经 RETURN');
  });

  it('RETURN 前只有注释 / SKIP 区（非执行行）⇒ 仍算体内第一条可执行行 → 截断', () => {
    const lines = [
      '@FOO',
      'FOR LOCAL,0,3',
      '; 说明',
      '[SKIPSTART]',
      'CFLAG:2 = 1',
      '[SKIPEND]',
      'RETURN',
      'NEXT',
      'PRINTL 乙',
    ];
    const statements = cf([
      ['FOR', 'LOCAL,0,3', 0, 2],
      ['NEXT', '', 0, 8],
    ]);
    // 抽取侧口径：注释 / SKIP 区内的行不算 ⇒ 体内第一条可执行行 = 第 7 行
    const counter: FunctionLoopCounter = { ...FOR_0_3, closeLine: 8, firstBodyLine: 7 };
    const got = build(lines, [disp(9, 'PRINTL', '乙')], statements, [counter], [], 9);
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.guardLine).toBe(7);
  });
});

describe('E5 · 不可证明的形状一律维持 E4 保守', () => {
  it('空区间 `FOR LOCAL,3,3`（lo === hi）⇒ 一轮都不跑，不截断', () => {
    const lines = ['@FOO', 'FOR LOCAL,3,3', 'RETURN', 'NEXT', 'PRINTL 乙'];
    const statements = cf([
      ['FOR', 'LOCAL,3,3', 0, 2],
      ['NEXT', '', 0, 4],
    ]);
    const counter: FunctionLoopCounter = { ...FOR_0_3, lo: 3, hi: 3 };
    const got = build(lines, [disp(5, 'PRINTL', '乙')], statements, [counter], [], 5);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('RETURN 不是体内第一条可执行行（`IF X` 在前）⇒ 不截断', () => {
    const lines = ['@FOO', 'FOR LOCAL,0,3', 'IF X', 'RETURN', 'ENDIF', 'NEXT', 'PRINTL 乙'];
    const statements = cf([
      ['FOR', 'LOCAL,0,3', 0, 2],
      ['IF', 'X', 1, 3],
      ['ENDIF', '', 1, 5],
      ['NEXT', '', 0, 6],
    ]);
    const counter: FunctionLoopCounter = { ...FOR_0_3, closeLine: 6, firstBodyLine: 3 };
    const got = build(lines, [disp(7, 'PRINTL', '乙')], statements, [counter], [], 7);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('区间含变量（抽取侧不发布循环量）⇒ 不截断', () => {
    const lines = ['@FOO', 'FOR LOCAL,0,LOCAL', 'RETURN', 'NEXT', 'PRINTL 乙'];
    const statements = cf([
      ['FOR', 'LOCAL,0,LOCAL', 0, 2],
      ['NEXT', '', 0, 4],
    ]);
    const got = build(lines, [disp(5, 'PRINTL', '乙')], statements, [], [], 5);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('`WHILE` + 首行 RETURN ⇒ 不截断（循环可能 0 次迭代）', () => {
    const lines = ['@FOO', 'WHILE X', 'RETURN', 'WEND', 'PRINTL 乙'];
    const statements = cf([
      ['WHILE', 'X', 0, 2],
      ['WEND', '', 0, 4],
    ]);
    const got = build(lines, [disp(5, 'PRINTL', '乙')], statements, [], [], 5);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('SKIP 区里的 RETURN ⇒ 不截断（引擎不执行区内的行）', () => {
    const lines = [
      '@FOO',
      'FOR LOCAL,0,3',
      '[SKIPSTART]',
      'RETURN',
      '[SKIPEND]',
      'PRINTL 甲',
      'NEXT',
      'PRINTL 乙',
    ];
    const statements = cf([
      ['FOR', 'LOCAL,0,3', 0, 2],
      ['NEXT', '', 0, 7],
    ]);
    const counter: FunctionLoopCounter = { ...FOR_0_3, closeLine: 7, firstBodyLine: 6 };
    const got = build(lines, [disp(8, 'PRINTL', '乙')], statements, [counter], [], 8);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('非空 FOR 嵌在外层循环里（WHILE）⇒ 不截断（内层头可能到不了）', () => {
    const lines = ['@FOO', 'WHILE X', 'FOR LOCAL,0,3', 'RETURN', 'NEXT', 'WEND', 'PRINTL 乙'];
    const statements = cf([
      ['WHILE', 'X', 0, 2],
      ['FOR', 'LOCAL,0,3', 1, 3],
      ['NEXT', '', 1, 5],
      ['WEND', '', 0, 6],
    ]);
    const counter: FunctionLoopCounter = { ...FOR_0_3, openLine: 3, closeLine: 5, firstBodyLine: 4 };
    const got = build(lines, [disp(7, 'PRINTL', '乙')], statements, [counter], [], 7);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('显式写了步进的 FOR（`FOR LOCAL,0,3,-1`）⇒ 步进方向判不准，不截断', () => {
    const lines = ['@FOO', 'FOR LOCAL,0,3,-1', 'RETURN', 'NEXT', 'PRINTL 乙'];
    const statements = cf([
      ['FOR', 'LOCAL,0,3,-1', 0, 2],
      ['NEXT', '', 0, 4],
    ]);
    const got = build(lines, [disp(5, 'PRINTL', '乙')], statements, [FOR_0_3], [], 5);
    expect(got[0]!.visibility).toBe('shown');
  });

  it('RETURN 之后有 `$` 标签 ⇒ 旧闸优先，仍不截断（GOTO 可跳过）', () => {
    const lines = ['@FOO', 'FOR LOCAL,0,3', 'RETURN', '$L', 'NEXT', 'PRINTL 乙'];
    const statements = cf([
      ['FOR', 'LOCAL,0,3', 0, 2],
      ['NEXT', '', 0, 5],
    ]);
    const counter: FunctionLoopCounter = { ...FOR_0_3, closeLine: 5 };
    const got = build(lines, [disp(6, 'PRINTL', '乙')], statements, [counter], [], 6);
    expect(got[0]!.visibility).toBe('shown');
  });
});
