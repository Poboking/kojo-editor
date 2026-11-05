/**
 * E2（2026-11-05）：`ARG / ARGS` 的**函数内赋值参与数据流**。
 *
 * 引擎语义（`ConvertArg` / `IntoFunction`）：调用上下文 = **调用时的初值**，函数体
 * 内 `ARG(:n) = …` 可以覆盖它。此前叠加层"注入永远优先"⇒ `ARG = TARGET` 这类参数
 * 补位被当成没写过。现在与 LOCAL 同一套前缀可达性 + last-write-wins：找到可达赋值
 * 就求值它，找不到才回落到注入值。
 *
 * 覆盖：audit 复现（`ARG = TARGET` + 注入 `ints:[0]` ⇒ `ARG == TARGET` 判 **true**）/
 * 别支赋值不覆盖（注入仍生效）/ RHS 引用 ARG 不递归爆炸 / last-write-wins /
 * ARGS 字符串槽同族。
 */
import { describe, expect, it } from 'vitest';
import type {
  FunctionAssignment,
  FunctionPredicates,
  ReplayCallContext,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createFunctionOverlay, type OverlayPosition } from '../src/locals';
import { judgeCondition } from '../src/evaluate';

const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length ? `${name}:${indices.join(':')}` : name,
});

function assignment(
  name: FunctionAssignment['name'],
  index: number,
  rhs: string,
  line: number,
  context: string[] = [],
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

/** 合成视图：TARGET = 49（回放角色号），其余 missing */
const baseRead = (r: VariableRef): ReplayValue => {
  if (r.name === 'TARGET') return { kind: 'value', value: 49 };
  return { kind: 'unknown', unknown: { code: 'missing-var', message: `no ${r.text}` } };
};

/** 在指定点位求值一个表达式（走叠加层 → 视图的读取链，与回放同构） */
function judgeAt(
  overlay: (r: VariableRef, at: OverlayPosition) => ReplayValue | null,
  src: string,
  at: OverlayPosition,
) {
  return judgeCondition(parseExpression(src), {
    read: (r) => overlay(r, at) ?? baseRead(r),
  });
}

const INJECT_ZERO: ReplayCallContext = { ints: [0] };

describe('E2 · ARG 函数内赋值覆盖调用时初值', () => {
  it('audit 复现：`ARG = TARGET`(49) + 注入 ints:[0] ⇒ `ARG == TARGET` 判 true（不是 false）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARG', 0, 'TARGET', 10)]),
      callContext: INJECT_ZERO,
      baseRead,
    })!;
    const at: OverlayPosition = { line: 20, context: [] };
    expect(overlay(ref('ARG'), at)).toEqual({ kind: 'value', value: 49 });
    expect(judgeAt(overlay, 'ARG == TARGET', at)).toEqual({ kind: 'true' });
    // 反方向同样要成立：注入的 0 已被覆盖，`ARG == 0` 判假（旧实现判真）
    expect(judgeAt(overlay, 'ARG == 0', at)).toEqual({ kind: 'false' });
  });

  it('没有赋值时仍走注入（E2 不吞注入路径）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10)]),
      callContext: INJECT_ZERO,
      baseRead,
    })!;
    expect(overlay(ref('ARG'), { line: 20, context: [] })).toEqual({ kind: 'value', value: 0 });
  });

  it('last-write-wins：取使用点之前最后一条可达赋值', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARG', 0, '1', 10), assignment('ARG', 0, '2', 30)]),
      callContext: INJECT_ZERO,
      baseRead,
    })!;
    expect(overlay(ref('ARG'), { line: 40, context: [] })).toEqual({ kind: 'value', value: 2 });
    expect(overlay(ref('ARG'), { line: 20, context: [] })).toEqual({ kind: 'value', value: 1 });
  });

  it('别支（不可达）赋值不覆盖：注入仍生效', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARG', 0, '5', 10, ['s1'])]),
      callContext: { ints: [7] },
      baseRead,
    })!;
    // 兄弟分支：赋值不可达 → 回落注入
    expect(overlay(ref('ARG'), { line: 20, context: ['s2'] })).toEqual({ kind: 'value', value: 7 });
    // 同分支：赋值可达 → 覆盖（证明上一条不是"永远忽略赋值"）
    expect(overlay(ref('ARG'), { line: 20, context: ['s1'] })).toEqual({ kind: 'value', value: 5 });
  });

  it('祖先路径赋值对后代使用点可达（与 LOCAL 同一条前缀规则）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARG', 0, '11', 10, [])]),
      callContext: INJECT_ZERO,
      baseRead,
    })!;
    expect(overlay(ref('ARG'), { line: 20, context: ['s1', 's2'] })).toEqual({
      kind: 'value',
      value: 11,
    });
  });
});

describe('E2 · 无递归死循环（RHS 引用 ARG 时只看更早的赋值）', () => {
  it('`ARG = ARG + 1` + 注入 5 ⇒ 6（RHS 读的是调用时初值，不是自身）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARG', 0, 'ARG + 1', 10)]),
      callContext: { ints: [5] },
      baseRead,
    })!;
    expect(overlay(ref('ARG'), { line: 20, context: [] })).toEqual({ kind: 'value', value: 6 });
  });

  it('`ARG = ARG` 且无注入 ⇒ call-context unknown（不死循环、不猜）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARG', 0, 'ARG', 10)]),
      baseRead,
    })!;
    const v = overlay(ref('ARG'), { line: 20, context: [] })!;
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('call-context');
  });

  it('两条链式赋值：`ARG = ARG + 1`(10) + `ARG = ARG * 2`(20) + 注入 3 ⇒ 8', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([
        assignment('ARG', 0, 'ARG + 1', 10),
        assignment('ARG', 0, 'ARG * 2', 20),
      ]),
      callContext: { ints: [3] },
      baseRead,
    })!;
    expect(overlay(ref('ARG'), { line: 30, context: [] })).toEqual({ kind: 'value', value: 8 });
  });
});

describe('E2 · ARGS 字符串槽与手写字面量', () => {
  it('`ARGS:1 = "A"` 覆盖注入 strs[1]，其余槽仍走注入', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('ARGS', 1, '"A"', 10)]),
      callContext: { strs: ['Y', 'Z'] },
      baseRead,
    })!;
    expect(overlay(ref('ARGS', ['1']), { line: 20, context: [] })).toEqual({
      kind: 'value',
      value: 'A',
    });
    expect(overlay(ref('ARGS'), { line: 20, context: [] })).toEqual({ kind: 'value', value: 'Y' });
  });
});
