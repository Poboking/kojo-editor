/**
 * 函数级求值上下文叠加 单测（v0.2 第六批）。
 *
 * 覆盖：本地量数据流（直线赋值 / last-write-wins / 分支前缀可达性 /
 * 递归 RHS / 动态索引边界）+ 调用上下文注入（ARG/ARGS 槽位、裸名 ≡ 0 号槽、
 * 未提供 / 未覆盖 → call-context unknown）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConditionExpr,
  FunctionAssignment,
  FunctionPredicates,
  ReplayCallContext,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createFunctionOverlay } from '../src/locals';

const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length ? `${name}:${indices.join(':')}` : name,
});

function lit(v: number | string): ConditionExpr {
  return { kind: 'literal', value: v, text: JSON.stringify(v) };
}

function assignment(
  name: FunctionAssignment['name'],
  index: number,
  rhs: string,
  line: number,
  context: string[],
): FunctionAssignment {
  return { name, index, expr: parseExpression(rhs), text: rhs, line, context };
}

function makeDetail(assignments: FunctionAssignment[]): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'a.erb',
    startLine: 1,
    endLine: 100,
    statements: [],
    assignments,
    predicates: [],
    returns: [],
  };
}

/** 合成视图读取器：CFLAG:2=800、TALENT:3=1、其余 missing */
const baseRead = (r: VariableRef): ReplayValue => {
  if (r.name === 'CFLAG' && r.indices[0] === '2') return { kind: 'value', value: 800 };
  if (r.name === 'TALENT' && r.indices[0] === '3') return { kind: 'value', value: 1 };
  return { kind: 'unknown', unknown: { code: 'missing-var', message: `no ${r.text}` } };
};

const TOP = { line: 100, context: [] as string[] };

describe('叠加层 · 本地量数据流', () => {
  it('直线常量赋值 → 值；无赋值 → local-no-write', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, [])]),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL'), TOP)).toEqual({ kind: 'value', value: 1 });
    expect(overlay(ref('LOCAL', ['1']), TOP)).toEqual({
      kind: 'unknown',
      unknown: { code: 'local-no-write', message: expect.stringContaining('LOCAL:1') },
    });
  });

  it('last-write-wins：取使用点之前最后一个可达赋值', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, []), assignment('LOCAL', 0, '2', 20, [])]),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL'), TOP)).toEqual({ kind: 'value', value: 2 });
    expect(overlay(ref('LOCAL'), { line: 15, context: [] })).toEqual({ kind: 'value', value: 1 });
    // 使用点之前的赋值不算（行序严格小于）
    expect(overlay(ref('LOCAL'), { line: 10, context: [] })).toEqual({
      kind: 'unknown',
      unknown: { code: 'local-no-write', message: expect.any(String) },
    });
  });

  it('前缀可达性：块内赋值对块外使用不可达；祖先赋值对块内使用可达', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, ['s1'])]),
      baseRead,
    })!;
    // 块外（顶层）使用 → 不可达
    expect(overlay(ref('LOCAL'), TOP)!.kind).toBe('unknown');
    // 同块使用 → 可达
    expect(overlay(ref('LOCAL'), { line: 20, context: ['s1'] })).toEqual({ kind: 'value', value: 1 });
    // 兄弟分支 → 不可达
    expect(overlay(ref('LOCAL'), { line: 20, context: ['s2'] })!.kind).toBe('unknown');
    // 祖先路径赋值 → 对后代使用可达
    const overlay2 = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '5', 10, [])]),
      baseRead,
    })!;
    expect(overlay2(ref('LOCAL'), { line: 20, context: ['s1', 's2'] })).toEqual({ kind: 'value', value: 5 });
  });

  it('RHS 递归：引用其他本地量 / 视图变量 / 未收录函数调用', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([
        assignment('LOCAL', 0, '1', 10, []),
        assignment('LOCAL', 1, 'LOCAL + 1', 20, []),
        assignment('LOCAL', 2, 'CFLAG:2 / 8', 30, []),
        assignment('LOCAL', 3, 'FOO()', 40, []),
      ]),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL', ['1']), TOP)).toEqual({ kind: 'value', value: 2 });
    expect(overlay(ref('LOCAL', ['2']), TOP)).toEqual({ kind: 'value', value: 100 }); // 800/8
    const foo = overlay(ref('LOCAL', ['3']), TOP)!;
    expect(foo).toEqual({
      kind: 'unknown',
      unknown: { code: 'call', message: expect.stringContaining('FOO') },
    });
  });

  it('字符串本地量（LOCALS）与失效点（复合赋值 opaque）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([
        assignment('LOCALS', 1, '"COM"', 10, []),
        assignment('LOCAL', 0, '1', 20, []),
        assignment('LOCAL', 0, '+= 1', 30, []),
      ]),
      baseRead,
    })!;
    expect(overlay(ref('LOCALS', ['1']), TOP)).toEqual({ kind: 'value', value: 'COM' });
    expect(overlay(ref('LOCAL'), TOP)!.kind).toBe('unknown'); // opaque 失效点
  });

  it('动态索引不建模 → dynamic-index', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, [])]),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL', ['(X)']), TOP)!;
    expect(v).toEqual({
      kind: 'unknown',
      unknown: { code: 'dynamic-index', message: expect.stringContaining('LOCAL') },
    });
  });

  it('RESULT/RESULTS 同等处理；非本地量返回 null（落到视图）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('RESULT', 0, '42', 10, [])]),
      baseRead,
    })!;
    expect(overlay(ref('RESULT'), TOP)).toEqual({ kind: 'value', value: 42 });
    expect(overlay(ref('CFLAG', ['2']), TOP)).toBeNull();
  });

  it('无赋值且无调用上下文 → 不创建叠加层', () => {
    expect(createFunctionOverlay({ detail: makeDetail([]), baseRead })).toBeNull();
  });
});

describe('叠加层 · 调用上下文注入', () => {
  const ctx: ReplayCallContext = { ints: [undefined, 36], strs: ['COMMAND'] };

  it('注入槽位生效；裸名 ≡ 0 号槽', () => {
    const overlay = createFunctionOverlay({ detail: makeDetail([]), callContext: ctx, baseRead })!;
    expect(overlay(ref('ARG', ['1']), TOP)).toEqual({ kind: 'value', value: 36 });
    expect(overlay(ref('ARGS'), TOP)).toEqual({ kind: 'value', value: 'COMMAND' });
  });

  it('未提供上下文 / 未覆盖槽位 → call-context unknown（不猜测 0）', () => {
    const overlay = createFunctionOverlay({ detail: makeDetail([]), callContext: ctx, baseRead })!;
    const bare = overlay(ref('ARG'), TOP)!; // 槽 0 = undefined
    expect(bare.kind).toBe('unknown');
    if (bare.kind === 'unknown') expect(bare.unknown.code).toBe('call-context');
    const none = createFunctionOverlay({ detail: makeDetail([]), baseRead })!;
    expect(none).toBeNull(); // 无赋值且无上下文 → 无叠加层
    const withAssign = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, [])]),
      baseRead,
    })!;
    const v = withAssign(ref('ARGS', ['2']), TOP)!;
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('call-context');
  });

  it('非数字槽位 → call-context unknown', () => {
    const overlay = createFunctionOverlay({ detail: makeDetail([]), callContext: ctx, baseRead })!;
    const v = overlay(ref('ARG', ['(X)']), TOP)!;
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('call-context');
  });
});
