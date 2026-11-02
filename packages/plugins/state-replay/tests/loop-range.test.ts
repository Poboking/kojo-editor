/**
 * 循环量逐值试算 单测（KW-15C 1103）。
 *
 * 判据面（三值口径的诚实边界，红线＝值域有限 ≠ 判定得出）：
 * - 区间内**每个**候选值都判成同一个 true / false ⇒ 收进来（真语料 `FOR LOCAL,0,5`
 *   紧接 `IF PALAM:LOCAL + CUP:LOCAL > 9000` 的形状）；
 * - 结论不一致 ⇒ 仍 unknown，但换更准的机器码 `local-range`（不再谎报「具名索引
 *   无法解析」）；
 * - 候选值一律同因判不出 ⇒ 原样透传（`RAND` 那类真随机继续记 `pseudo`，不被改写）；
 * - 使用点不是体内第一条真代码行 / 循环量不属本地量族 / 组合超限 ⇒ 逐字回落改动前。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionLoopCounter, FunctionPredicates, ReplayValue, VariableRef } from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { judgePredicateWithLoops } from '../src/loop-range';
import type { OverlayPosition } from '../src/locals';

/** 合成视图：`PALAM:n` = n*1000（n=0 假、n≥1 视阈值而定）；`CUP:n` = 0 */
function readTable(table: Record<string, number | string>): (r: VariableRef) => ReplayValue {
  return (r) => {
    const key = `${r.name}:${r.indices.join(':')}`;
    if (key in table) return { kind: 'value', value: table[key]! };
    if (r.name === 'LOCAL' || r.name === 'PALAM' || r.name === 'CUP') {
      return { kind: 'unknown', unknown: { code: 'named-index', message: `具名索引无法解析：${r.text}` } };
    }
    return { kind: 'unknown', unknown: { code: 'missing-var', message: `无 ${r.text}` } };
  };
}

function detail(loopCounters: FunctionLoopCounter[]): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'a.erb',
    startLine: 1,
    endLine: 50,
    statements: [],
    predicates: [],
    assignments: [],
    returns: [],
    loopCounters,
  };
}

/** `FOR LOCAL,0,5` 的循环量事实（体内第一条真代码行 = 第 3 行） */
const FOR_LOCAL_0_5: FunctionLoopCounter = {
  name: 'LOCAL',
  index: 0,
  openLine: 2,
  closeLine: 6,
  lo: 0,
  hi: 5,
  firstBodyLine: 3,
};

const AT_BODY_HEAD: OverlayPosition = { line: 3, context: ['s1'] };
const AT_LATER_LINE: OverlayPosition = { line: 4, context: ['s1'] };

const judge = (src: string, counters: FunctionLoopCounter[], at: OverlayPosition, table: Record<string, number | string> = {}) =>
  judgePredicateWithLoops(parseExpression(src), { read: readTable(table) }, detail(counters), at);

describe('循环量逐值试算 · 收得进来的形状', () => {
  it('区间内全假 → false（下标位是循环量：PALAM:LOCAL > 3000）', () => {
    // PALAM:0=0、PALAM:1..5 缺表 ⇒ 用显式数值表：全部 ≤3000
    const table: Record<string, number> = {
      'PALAM:0': 0,
      'PALAM:1': 1000,
      'PALAM:2': 2000,
      'PALAM:3': 3000,
      'PALAM:4': 3000,
      'PALAM:5': 3000,
    };
    expect(judge('PALAM:LOCAL > 3000', [FOR_LOCAL_0_5], AT_BODY_HEAD, table)).toEqual({ kind: 'false' });
  });

  it('区间内全真 → true', () => {
    const table: Record<string, number> = {
      'PALAM:0': 9,
      'PALAM:1': 9,
      'PALAM:2': 9,
      'PALAM:3': 9,
      'PALAM:4': 9,
      'PALAM:5': 9,
    };
    expect(judge('PALAM:LOCAL > 3', [FOR_LOCAL_0_5], AT_BODY_HEAD, table)).toEqual({ kind: 'true' });
  });

  it('裸槽形态（LOCAL 自己作值）同样试算：全真 → true', () => {
    expect(judge('LOCAL >= 0', [FOR_LOCAL_0_5], AT_BODY_HEAD)).toEqual({ kind: 'true' });
  });
});

describe('循环量逐值试算 · 收不进来的诚实呈现', () => {
  it('值域内结论不一致 → unknown(local-range)，且理由带区间与逐值结果', () => {
    const table: Record<string, number> = {
      'PALAM:0': 0,
      'PALAM:1': 5,
      'PALAM:2': 5,
      'PALAM:3': 5,
      'PALAM:4': 5,
      'PALAM:5': 5,
    };
    const out = judge('PALAM:LOCAL > 3', [FOR_LOCAL_0_5], AT_BODY_HEAD, table);
    expect(out.kind).toBe('unknown');
    if (out.kind !== 'unknown') return;
    expect(out.unknown.code).toBe('local-range');
    expect(out.unknown.message).toContain('LOCAL:0∈[0,5]');
    expect(out.unknown.message).toContain('FOR 第 2 行');
    expect(out.unknown.message).toContain('LOCAL:0=0→假');
    expect(out.unknown.message).toContain('LOCAL:0=1→真');
  });

  it('候选值一律同因判不出 → 原样透传那枚未知（不改写机器码、不新增一档）', () => {
    const out = judge('FOO:LOCAL > 3', [FOR_LOCAL_0_5], AT_BODY_HEAD);
    expect(out).toEqual({ kind: 'unknown', unknown: { code: 'missing-var', message: expect.any(String) } });
  });

  it('使用点不是体内第一条真代码行 → 逐字回落改动前（named-index 原样）', () => {
    expect(judge('PALAM:LOCAL > 3', [FOR_LOCAL_0_5], AT_LATER_LINE)).toEqual({
      kind: 'unknown',
      unknown: { code: 'named-index', message: expect.any(String) },
    });
  });

  it('循环量不属本地量族（用户 #DIM 变量）→ 不消费（抽取侧记的是结构事实）', () => {
    const counters: FunctionLoopCounter[] = [{ ...FOR_LOCAL_0_5, name: 'HOGE' }];
    expect(judge('PALAM:LOCAL > 3', counters, AT_BODY_HEAD)).toEqual({
      kind: 'unknown',
      unknown: { code: 'named-index', message: expect.any(String) },
    });
  });

  it('没有循环量事实 → 与改动前逐字相同（零行为漂移）', () => {
    expect(judge('PALAM:LOCAL > 3', [], AT_BODY_HEAD)).toEqual({
      kind: 'unknown',
      unknown: { code: 'named-index', message: expect.any(String) },
    });
  });

  it('两枚循环量各 6 值（36 组合）超上限 → 回落原路径，绝不硬猜', () => {
    const counters: FunctionLoopCounter[] = [
      FOR_LOCAL_0_5,
      { ...FOR_LOCAL_0_5, name: 'RESULT', index: 1, lo: 0, hi: 5 },
    ];
    const expr: ConditionExpr = {
      kind: 'binary',
      op: '>',
      left: { kind: 'ref', name: 'PALAM', indices: ['LOCAL'], text: 'PALAM:LOCAL' },
      right: { kind: 'ref', name: 'CUP', indices: ['RESULT:1'], text: 'CUP:RESULT:1' },
      text: 'PALAM:LOCAL > CUP:RESULT:1',
    };
    expect(
      judgePredicateWithLoops(expr, { read: readTable({}) }, detail(counters), AT_BODY_HEAD),
    ).toEqual({ kind: 'unknown', unknown: { code: 'named-index', message: expect.any(String) } });
  });
});
