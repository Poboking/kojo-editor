/**
 * 台词推演单测（v0.3 口上调试统一批；纯函数 + 合成注入）。
 *
 * 覆盖：可见性三档（分支命中 / 走了别处 / 全未命中 / 判不出）/ 嵌套链逐层细化 /
 * `SIF` **同行**守卫（含"上一行是 SIF 不守本行"的回归判据）/ 插值求值成文本 /
 * 判不出的插值落 `%?%` 占位并计数 / 行内三元两支 / 裸 `NAME` 补 `MASTER`。
 */
import { describe, expect, it } from 'vitest';
import type {
  ControlFlowStatement,
  DisplayInterpolation,
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

function pred(line: number, outcome: ReplayOutcome, kind: PredicateReplay['kind'] = 'IF', text = `p${line}`): PredicateReplay {
  return { kind, text, line, expr: { kind: 'opaque', text }, outcome };
}

function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

/** 显示行夹具（偏移按载荷坐标系手写；回放侧只消费偏移） */
function disp(
  line: number,
  verb: string,
  payload: string,
  interpolations: DisplayInterpolation[] = [],
  sifGuarded = false,
): FunctionDisplayLine {
  return { line, verb, payload, interpolations, ...(sifGuarded ? { sifGuarded: true } : {}) };
}

/** `%…%` / `{…}` 切片（测试里手算偏移，顺便钉住"偏移 = 载荷坐标系"） */
function pct(
  text: string,
  payload: string,
  form: 'percent' | 'brace' = 'percent',
  from = 0,
): DisplayInterpolation {
  const open = form === 'percent' ? '%' : '{';
  const close = form === 'percent' ? '%' : '}';
  const start = payload.indexOf(open, from);
  const end = payload.indexOf(close, start + 1) + 1;
  return { form, text, expr: { kind: 'ref', name: text, indices: [], text }, start, end };
}

function detail(displays: FunctionDisplayLine[], statements: ControlFlowStatement[]): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'x.ERB',
    startLine: 1,
    endLine: 99,
    statements,
    predicates: [],
    assignments: [],
    returns: [],
    displays,
  };
}

/** 值表读取器（键 = `NAME:idx:…`；缺席 → unknown，与真实视图同口径） */
function reader(values: Record<string, number | string>, seen?: VariableRef[]): ValueReader {
  return (ref) => {
    seen?.push(ref);
    const key = [ref.name, ...ref.indices].join(':');
    if (key in values) return { kind: 'value', value: values[key]! } as ReplayValue;
    return { kind: 'unknown', unknown: { code: 'other', message: `无 ${key}` } };
  };
}

describe('可见性：分支几何', () => {
  const stmts = cf([
    ['IF', 'A', 0, 2],
    ['ELSE', '', 0, 4],
    ['ENDIF', '', 0, 6],
  ]);
  const displays = [disp(3, 'PRINTL', '高'), disp(5, 'PRINTL', '低')];

  it('IF 命中 → 分支内的行会显示，另一支不显示', () => {
    const branches = buildBranchOutcomes(stmts, [pred(2, T)]);
    const got = buildTranscript({
      detail: detail(displays, stmts),
      lines: [],
      predicates: [pred(2, T)],
      branches,
      read: reader({}),
    })!;
    expect(got.map((t) => t.visibility)).toEqual(['shown', 'hidden']);
    expect(got[0]!.text).toBe('高');
    expect(got[1]!.text).toBe('');
    expect(got[1]!.guardLine).toBe(2);
    expect(got[1]!.reason?.message).toContain('走了别处');
  });

  it('IF 全假走 ELSE → 反过来', () => {
    const branches = buildBranchOutcomes(stmts, [pred(2, F)]);
    const got = buildTranscript({
      detail: detail(displays, stmts),
      lines: [],
      predicates: [pred(2, F)],
      branches,
      read: reader({}),
    })!;
    expect(got.map((t) => t.visibility)).toEqual(['hidden', 'shown']);
    expect(got[1]!.text).toBe('低');
  });

  it('全假无 ELSE → 分支体全不显示（no-match）', () => {
    const s2 = cf([
      ['IF', 'A', 0, 2],
      ['ENDIF', '', 0, 4],
    ]);
    const branches = buildBranchOutcomes(s2, [pred(2, F)]);
    const got = buildTranscript({
      detail: detail([disp(3, 'PRINTL', 'x')], s2),
      lines: [],
      predicates: [pred(2, F)],
      branches,
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.reason?.message).toContain('全部未命中');
  });

  it('条件判不出 → maybe（不猜成会显示，也不猜成不显示）', () => {
    const branches = buildBranchOutcomes(stmts, [pred(2, U)]);
    const got = buildTranscript({
      detail: detail(displays, stmts),
      lines: [],
      predicates: [pred(2, U)],
      branches,
      read: reader({}),
    })!;
    expect(got.map((t) => t.visibility)).toEqual(['maybe', 'maybe']);
  });

  it('整链判不出、但本支条件明确为假 → 本支行确定不显示（不是 maybe）', () => {
    // IF A(判不出) / ELSEIF B(假) / ELSE —— 链 outcome = unknown，但 B 支一定不走
    const s = cf([
      ['IF', 'A', 0, 2],
      ['ELSEIF', 'B', 0, 4],
      ['ELSE', '', 0, 6],
      ['ENDIF', '', 0, 8],
    ]);
    const branches = buildBranchOutcomes(s, [pred(2, U), pred(4, F)]);
    const got = buildTranscript({
      detail: detail([disp(5, 'PRINTL', 'B 支的话')], s),
      lines: [],
      predicates: [pred(2, U), pred(4, F)],
      branches,
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('hidden');
    expect(got[0]!.guardLine).toBe(4);
    expect(got[0]!.reason?.message).toContain('条件不成立');
  });

  it('整链判不出、本支条件也判不出 → 仍是 maybe', () => {
    const s = cf([
      ['IF', 'A', 0, 2],
      ['ELSEIF', 'B', 0, 4],
      ['ENDIF', '', 0, 6],
    ]);
    const branches = buildBranchOutcomes(s, [pred(2, U), pred(4, U)]);
    const got = buildTranscript({
      detail: detail([disp(5, 'PRINTL', 'x')], s),
      lines: [],
      predicates: [pred(2, U), pred(4, U)],
      branches,
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('maybe');
  });

  it('链外的行不受影响', () => {
    const got = buildTranscript({
      detail: detail([disp(7, 'PRINTL', '链外')], stmts),
      lines: [],
      predicates: [pred(2, T)],
      branches: buildBranchOutcomes(stmts, [pred(2, T)]),
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('shown');
  });

  it('嵌套链：外层走了别处 → 内层行不可见（外层主导）', () => {
    const s = cf([
      ['IF', 'A', 0, 2],
      ['ELSE', '', 0, 4],
      ['IF', 'B', 1, 8],
      ['ENDIF', '', 1, 10],
      ['ENDIF', '', 0, 12],
    ]);
    const branches = buildBranchOutcomes(s, [pred(2, T), pred(8, T)]);
    const got = buildTranscript({
      detail: detail([disp(9, 'PRINTL', '内层')], s),
      lines: [],
      predicates: [pred(2, T), pred(8, T)],
      branches,
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('hidden');
  });
});

describe('SIF 同行守卫', () => {
  it('SIF 为真 → 会显示；为假 → 不显示', () => {
    const displays = [disp(5, 'PRINTFORM', '守卫', [], true)];
    const on = buildTranscript({
      detail: detail(displays, []),
      lines: [],
      predicates: [pred(5, T, 'SIF')],
      branches: [],
      read: reader({}),
    })!;
    expect(on[0]!.visibility).toBe('shown');
    const off = buildTranscript({
      detail: detail(displays, []),
      lines: [],
      predicates: [pred(5, F, 'SIF')],
      branches: [],
      read: reader({}),
    })!;
    expect(off[0]!.visibility).toBe('hidden');
    expect(off[0]!.guardLine).toBe(5);
  });

  it('SIF 判不出 → maybe', () => {
    const got = buildTranscript({
      detail: detail([disp(5, 'PRINTFORM', '守卫', [], true)], []),
      lines: [],
      predicates: [pred(5, U, 'SIF')],
      branches: [],
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('maybe');
  });

  it('回归：上一行是 SIF **不**守本行（引擎语义：SIF 只管同行）', () => {
    const displays = [disp(6, 'PRINTL', '下一行')];
    const got = buildTranscript({
      detail: detail(displays, []),
      lines: [],
      // 第 5 行有 SIF 且为假，但第 6 行不是 SIF 行
      predicates: [pred(5, F, 'SIF')],
      branches: [],
      read: reader({}),
    })!;
    expect(got[0]!.visibility).toBe('shown');
  });
});

describe('文本求值', () => {
  it('`%…%` 用快照值替换（引号剥离后偏移仍对齐）', () => {
    const payload = '"好感=%CFLAG:1%"';
    const got = buildTranscript({
      detail: detail([disp(3, 'PRINTFORM', payload, [pct('CFLAG:1', payload)])], []),
      lines: [],
      predicates: [],
      branches: [],
      read: reader({ 'CFLAG:1': 500 }),
    })!;
    expect(got[0]!.text).toBe('好感=500');
    expect(got[0]!.unresolved).toBe(0);
  });

  it('判不出的插值落 `%?%` 占位并计数（绝不猜）', () => {
    const payload = '"%FOO%和%BAR%"';
    const i1 = pct('FOO', payload);
    const i2 = pct('BAR', payload, 'percent', i1.end);
    const got = buildTranscript({
      detail: detail([disp(3, 'PRINTFORM', payload, [i1, i2])], []),
      lines: [],
      predicates: [],
      branches: [],
      read: reader({ FOO: '甲' }),
    })!;
    expect(got[0]!.text).toBe('甲和%?%');
    expect(got[0]!.unresolved).toBe(1);
  });

  it('行内三元按条件选一支；判不出时两支并排', () => {
    const payload = '\\@FLAG:1?高#低\\@';
    const ternary: DisplayInterpolation = {
      form: 'inlineTernary',
      text: 'FLAG:1',
      expr: { kind: 'ref', name: 'FLAG:1', indices: [], text: 'FLAG:1' },
      start: 0,
      end: payload.length,
      thenText: '高',
      elseText: '低',
    };
    const pick = (v: number | undefined) =>
      buildTranscript({
        detail: detail([disp(3, 'PRINTFORM', payload, [ternary])], []),
        lines: [],
        predicates: [],
        branches: [],
        read: reader(v === undefined ? {} : { 'FLAG:1': v }),
      })![0]!;
    expect(pick(1).text).toBe('高');
    expect(pick(0).text).toBe('低');
    expect(pick(undefined).text).toBe('高／低');
    expect(pick(undefined).unresolved).toBe(1);
  });

  it('裸 `NAME` / `CALLNAME` 补 MASTER（不是回放角色）', () => {
    const seen: VariableRef[] = [];
    const payload = '%NAME%';
    buildTranscript({
      detail: detail([disp(3, 'PRINTFORM', payload, [pct('NAME', payload)])], []),
      lines: [],
      predicates: [],
      branches: [],
      read: reader({ 'NAME:MASTER': '灵梦' }, seen),
    });
    expect(seen.map((r) => [r.name, r.indices])).toContainEqual(['NAME', ['MASTER']]);
  });
});

describe('缺省与韧性', () => {
  it('无显示行 → null（消费方按缺省隐藏该区）', () => {
    expect(
      buildTranscript({ detail: detail([], []), lines: [], predicates: [], branches: [], read: reader({}) }),
    ).toBeNull();
  });

  it('求值通道抛错 → 该行降级为判不出，不中断整棵推演', () => {
    const payload = '%X%';
    const got = buildTranscript({
      detail: detail([disp(3, 'PRINTFORM', payload, [pct('X', payload)]), disp(4, 'PRINTL', '后一行')], []),
      lines: [],
      predicates: [],
      branches: [],
      read: () => {
        throw new Error('boom');
      },
    })!;
    expect(got).toHaveLength(2);
    expect(got[0]!.text).toBe('%?%');
    expect(got[1]!.text).toBe('后一行');
  });
});
