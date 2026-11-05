/**
 * E3（2026-11-05）：**未发布循环量的循环头使旧赋值失效**。
 *
 * 复现（audit）：`LOCAL = 0`（第 10 行）+ `FOR LOCAL,1,CHARANUM`（区间端点非字面量
 * ⇒ 抽取侧不发布）+ 体内 `IF LOCAL == 0`。旧实现只取"行号更小的最后一条可达赋值"
 * ⇒ 返回 0 ⇒ 谓词被误判 true。引擎语义：循环头**每一轮都写循环量**，循环前的
 * 旧赋值不可能决定体内该槽位的取值 ⇒ 正确结论是 unknown('local-no-write')。
 *
 * 已发布的循环不动：逐值试算在谓词层（`judgePredicateWithLoops`），本叠加层保持
 * 原行为（`loop-range.test.ts` 那套口径）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ControlFlowStatement,
  FunctionAssignment,
  FunctionLoopCounter,
  FunctionPredicates,
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

function stmt(kind: string, line: number, depth: number, expression = ''): ControlFlowStatement {
  return { kind, line, depth, expression };
}

function makeDetail(
  assignments: FunctionAssignment[],
  statements: ControlFlowStatement[] = [],
  loopCounters: FunctionLoopCounter[] = [],
): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'a.erb',
    startLine: 1,
    endLine: 200,
    statements,
    assignments,
    predicates: [],
    returns: [],
    loopCounters,
  };
}

const baseRead = (_r: VariableRef): ReplayValue => ({
  kind: 'unknown',
  unknown: { code: 'missing-var', message: 'no' },
});

/** 区间端点非字面量（`FOR LOCAL,1,CHARANUM`）的 FOR/NEXT 骨架 */
const FOR_CHARANUM = [stmt('FOR', 20, 0, 'LOCAL,1,CHARANUM'), stmt('NEXT', 40, 0)];

const AT_BODY: OverlayPosition = { line: 30, context: ['s1'] };

function judgeAt(
  overlay: (r: VariableRef, at: OverlayPosition) => ReplayValue | null,
  src: string,
  at: OverlayPosition,
) {
  return judgeCondition(parseExpression(src), {
    read: (r) => overlay(r, at) ?? baseRead(r),
  });
}

describe('E3 · 未发布 FOR 头使循环前的旧赋值失效', () => {
  it('audit 复现：`LOCAL = 0` + 未发布 `FOR LOCAL,1,CHARANUM` + 体内读 LOCAL ⇒ unknown(local-no-write)', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '0', 10)], FOR_CHARANUM),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL'), AT_BODY)!;
    expect(v.kind).toBe('unknown');
    if (v.kind !== 'unknown') return;
    expect(v.unknown.code).toBe('local-no-write');
    // 理由复用循环量那套说法：指到循环头行 + 每一轮取值不同 + 区间未发布
    expect(v.unknown.message).toContain('FOR 循环量');
    expect(v.unknown.message).toContain('第 20 行');
    expect(v.unknown.message).toContain('每一轮的取值都不同');
    expect(v.unknown.message).toContain('取值区间没能发布');
    // 还要说清是哪条旧赋值被判失效（作者能回源改）
    expect(v.unknown.message).toContain('第 10 行');
  });

  it('谓词层同样的点：`LOCAL == 0` 不再判 true，而是判不出', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '0', 10)], FOR_CHARANUM),
      baseRead,
    })!;
    expect(judgeAt(overlay, 'LOCAL == 0', AT_BODY)).toEqual({
      kind: 'unknown',
      unknown: { code: 'local-no-write', message: expect.any(String) },
    });
  });

  it('已发布的循环保持现有行为（不抢谓词层的逐值试算）', () => {
    const published: FunctionLoopCounter[] = [
      { name: 'LOCAL', index: 0, openLine: 20, closeLine: 40, lo: 1, hi: 3, firstBodyLine: 21 },
    ];
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '0', 10)], FOR_CHARANUM, published),
      baseRead,
    })!;
    // 旧行为逐字保留：叠加层仍返回循环前那条赋值（是否可用由谓词层试算决定）
    expect(overlay(ref('LOCAL'), AT_BODY)).toEqual({ kind: 'value', value: 0 });
  });

  it('赋值在循环体**内**（循环头之后）⇒ 仍取该赋值（不被 E3 误杀）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '7', 25)], FOR_CHARANUM),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL'), AT_BODY)).toEqual({ kind: 'value', value: 7 });
  });

  it('循环头在使用点之后 ⇒ 与本次读取无关，旧行为照旧', () => {
    const statements = [stmt('FOR', 40, 0, 'LOCAL,1,CHARANUM'), stmt('NEXT', 60, 0)];
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '9', 10)], statements),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL'), { line: 30, context: ['s1'] })).toEqual({
      kind: 'value',
      value: 9,
    });
  });

  it('FOR 配对不上 NEXT ⇒ 不宣称循环量绑定（退回旧行为，不误判失效）', () => {
    const unpaired = [stmt('FOR', 20, 0, 'LOCAL,1,CHARANUM')];
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '4', 10)], unpaired),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL'), AT_BODY)).toEqual({ kind: 'value', value: 4 });
  });

  it('别槽循环量不影响本槽（FOR LOCAL:1 不使 LOCAL:0 的旧赋值失效）', () => {
    const otherSlot = [stmt('FOR', 20, 0, 'LOCAL:1,1,CHARANUM'), stmt('NEXT', 40, 0)];
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '3', 10)], otherSlot),
      baseRead,
    })!;
    expect(overlay(ref('LOCAL'), AT_BODY)).toEqual({ kind: 'value', value: 3 });
  });
});
