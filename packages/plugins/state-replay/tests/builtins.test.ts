/**
 * 内置纯函数求值 单测（v0.2 第六批）。
 *
 * 语义对齐引擎 Creator.Method.cs；错误路径 → unknown('builtin')；
 * 非内置函数维持 unknown('call')；参数 unknown 原样传播（保留来源）。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, ReplayValue, VariableRef } from '@kojo/plugin-api';
import { evaluateExpr } from '../src/evaluate';

const lit = (v: number | string): ConditionExpr => ({ kind: 'literal', value: v, text: JSON.stringify(v) });
const cref = (name: string, indices: string[] = []): ConditionExpr => ({
  kind: 'ref',
  name,
  indices,
  text: indices.length ? `${name}:${indices.join(':')}` : name,
});
const call = (name: string, ...args: ConditionExpr[]): ConditionExpr => ({ kind: 'call', name, args });

/** 合成读取器：SELECTCOM=310、CFLAG:2=800、MISSING → unknown('missing-var') */
const read = (r: VariableRef): ReplayValue => {
  if (r.name === 'SELECTCOM') return { kind: 'value', value: 310 };
  if (r.name === 'CFLAG' && r.indices[0] === '2') return { kind: 'value', value: 800 };
  if (r.name === 'LOCAL') return { kind: 'unknown', unknown: { code: 'local-no-write', message: 'no write' } };
  return { kind: 'unknown', unknown: { code: 'missing-var', message: `no ${r.text}` } };
};

const ev = (expr: ConditionExpr): ReplayValue => evaluateExpr(expr, read);

describe('内置函数 · GETBIT', () => {
  it('位读取（BigInt 语义，>32 位也正确）', () => {
    expect(ev(call('GETBIT', lit(0b1010), lit(1)))).toEqual({ kind: 'value', value: 1 });
    expect(ev(call('GETBIT', lit(0b1010), lit(0)))).toEqual({ kind: 'value', value: 0 });
    expect(ev(call('GETBIT', lit(1), lit(0)))).toEqual({ kind: 'value', value: 1 });
  });

  it('64 位安全：1 << 40 的位仍在', () => {
    const big = ev(call('GETBIT', lit(1_099_511_627_776), lit(40))); // 2^40
    expect(big).toEqual({ kind: 'value', value: 1 });
    expect(ev(call('GETBIT', lit(1_099_511_627_776), lit(41)))).toEqual({ kind: 'value', value: 0 });
  });

  it('越界（引擎抛错语义）→ unknown(builtin)；参数未知 → 原因透传', () => {
    const oob = ev(call('GETBIT', lit(1), lit(64)));
    expect(oob).toEqual({ kind: 'unknown', unknown: { code: 'builtin', message: expect.stringContaining('越界') } });
    const prop = ev(call('GETBIT', cref('LOCAL'), lit(0)));
    expect(prop).toEqual({
      kind: 'unknown',
      unknown: { code: 'local-no-write', message: expect.any(String) },
    });
  });
});

describe('内置函数 · GROUPMATCH / MAX / MIN', () => {
  it('GROUPMATCH 计数（int / string）', () => {
    expect(ev(call('GROUPMATCH', cref('SELECTCOM'), lit(310), lit(311), lit(313)))).toEqual({ kind: 'value', value: 1 });
    expect(ev(call('GROUPMATCH', lit('A'), lit('B'), lit('A')))).toEqual({ kind: 'value', value: 1 });
    expect(ev(call('GROUPMATCH', lit('A'), lit('B'), lit('C')))).toEqual({ kind: 'value', value: 0 });
  });

  it('GROUPMATCH 类型混合 → unknown(builtin)', () => {
    const v = ev(call('GROUPMATCH', lit('A'), lit(1)));
    expect(v).toEqual({ kind: 'unknown', unknown: { code: 'builtin', message: expect.stringContaining('类型') } });
  });

  it('MAX / MIN 折叠；参数 unknown 传播', () => {
    expect(ev(call('MAX', lit(1), lit(5), lit(3)))).toEqual({ kind: 'value', value: 5 });
    expect(ev(call('MIN', lit(-2), lit(-7)))).toEqual({ kind: 'value', value: -7 });
    const p = ev(call('MAX', lit(0), cref('LOCAL')));
    expect(p).toEqual({ kind: 'unknown', unknown: { code: 'local-no-write', message: expect.any(String) } });
    const p2 = ev(call('MAX', cref('LOCAL'), lit(0)));
    expect(p2).toEqual({ kind: 'unknown', unknown: { code: 'local-no-write', message: expect.any(String) } });
  });
});

describe('内置函数 · ABS / SIGN / LIMIT / POWER', () => {
  it('基础语义', () => {
    expect(ev(call('ABS', lit(-5)))).toEqual({ kind: 'value', value: 5 });
    expect(ev(call('SIGN', lit(-3)))).toEqual({ kind: 'value', value: -1 });
    expect(ev(call('SIGN', lit(0)))).toEqual({ kind: 'value', value: 0 });
    expect(ev(call('LIMIT', lit(5), lit(1), lit(3)))).toEqual({ kind: 'value', value: 3 });
    expect(ev(call('LIMIT', lit(-1), lit(1), lit(3)))).toEqual({ kind: 'value', value: 1 });
    expect(ev(call('LIMIT', lit(2), lit(1), lit(3)))).toEqual({ kind: 'value', value: 2 });
    expect(ev(call('POWER', lit(2), lit(10)))).toEqual({ kind: 'value', value: 1024 });
  });

  it('POWER 溢出 → unknown(builtin)；截断为 long 语义', () => {
    expect(ev(call('POWER', lit(2), lit(62)))).toEqual({ kind: 'value', value: 4_611_686_018_427_387_904 });
    const over = ev(call('POWER', lit(2), lit(64)));
    expect(over).toEqual({ kind: 'unknown', unknown: { code: 'builtin', message: expect.stringContaining('Int64') } });
  });

  it('字符串参数进整数族 → unknown(builtin)', () => {
    const v = ev(call('ABS', lit('x')));
    expect(v).toEqual({ kind: 'unknown', unknown: { code: 'builtin', message: expect.stringContaining('整数') } });
  });
});

describe('内置函数 · 边界保持', () => {
  it('非内置函数维持 unknown(call)', () => {
    const v = ev(call('FIRSTTIME', lit('SPEV2'), lit(1)));
    expect(v).toEqual({ kind: 'unknown', unknown: { code: 'call', message: expect.stringContaining('FIRSTTIME') } });
  });

  it('视图像素级组合：GETBIT(CFLAG:2,1) 在真实读取路径上工作', () => {
    expect(ev(call('GETBIT', cref('CFLAG', ['2']), lit(9)))).toEqual({ kind: 'value', value: 1 }); // 800 = 0b1100100000
  });
});
