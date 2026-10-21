/**
 * `# 表` 等值分派落点判定（K2-TABLE-SELECTCASE / §6.3 / §16.2 C2.5）单测。
 *
 * 钉的判据（写死在 `lower/expand/table-plan.ts` 头注）：
 * - 正例：全精确整数键 + 臂数 ≥ 3 + 判别式纯整数 → `selectcase`；`否` 可选；
 * - 反例：2 臂 / 闭区间 / 开放区间 / 字符串或副作用判别式 → `if-chain`（不产错）；
 * - fail-closed：空判别式 / 键重复 / 键非安全整数 / 多个 `否` → `error` + 既有诊断，不产字节；
 * - 计划是**纯数据**（深冻结、JSON 往返、可离线断言），同对象命中缓存；
 * - core 只发**结构请求**（`program.tableDispatch` 可选能力），没有能力时既有 IF 链逐字节不变。
 */
import { describe, expect, it } from 'vitest';
import type { KojoExprText, KojoLiteral, KojoSpan, KojoTableDecl, KojoTableRow } from '../src/ast.js';
import { validateTable } from '../src/table.js';
import type { TableRowShape } from '../src/table.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import type { EmitResult, KojoEmitBackend } from '../src/lower/backend.js';
import {
  TABLE_DISPATCH_MIN_ARMS,
  planTableDispatch,
  tableDispatchOf,
} from '../src/lower/expand/table-plan.js';
import type {
  TableDispatchEmitRequest,
  TableDispatchFact,
  TableDispatchRowFact,
} from '../src/lower/expand/table-plan.js';

/* ============================== 夹具 ============================== */

const span = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 8 },
});

const expr = (text: string, line = 1): KojoExprText => ({
  text,
  span: { start: { line, column: 1 }, end: { line, column: 1 + text.length } },
});

const row = (from: string | null, to: string | null, value: KojoLiteral, line: number): KojoTableRow => ({
  from: from === null ? null : expr(from, line),
  to: to === null ? null : expr(to, line),
  value,
  span: span(line),
});

function table(rows: readonly KojoTableRow[], subject = '恋慕'): KojoTableDecl {
  return {
    kind: 'table',
    name: '心情',
    subject: expr(subject, 1),
    rows,
    span: { start: { line: 1, column: 1 }, end: { line: 1 + rows.length + 1, column: 1 } },
  };
}

/** 真实校验（`validateTable`）产出的 plan —— 正常管线里的唯一来源 */
function realPlan(rows: readonly KojoTableRow[], options?: { subject?: string; constants?: ReadonlyMap<string, number> }) {
  const result = validateTable(table(rows, options?.subject), { integerConstants: options?.constants });
  if (result.plan === null) throw new Error(`fixture 表应当合法：${result.diagnostics.map((d) => d.code).join(',')}`);
  return result.plan;
}

/** 手工构造的结构事实（反例/不合法计划用：绕过 validateTable 的 fail-closed 闸） */
const factRow = (shape: TableRowShape, from: number | null, to: number | null, line: number): TableDispatchRowFact => ({
  shape,
  from,
  to,
  span: span(line),
});

function fact(rows: readonly TableDispatchRowFact[], subject = '恋慕'): TableDispatchFact {
  return { subject: expr(subject), rows, span: span(1), defaultRow: null };
}

const exactRows = (...values: readonly number[]): TableDispatchRowFact[] =>
  values.map((value, index) => factRow('exact', value, value, index + 3));

const THREE_ARMS = [
  row('0', '0', '疏远', 3),
  row('5', '5', '平常', 4),
  row('10', '10', '亲近', 5),
  row(null, null, '未知', 6),
];

/* ============================== 1. 正例：可证等值 ============================== */

describe('planTableDispatch · 可证等值 → selectcase', () => {
  it('三条精确整数键 + 否 → selectcase，键按源顺序、否不进 cases', () => {
    const plan = realPlan(THREE_ARMS);
    const dispatch = planTableDispatch(plan);
    expect(dispatch.style).toBe('selectcase');
    expect(dispatch.cases.map((item) => item.value)).toEqual([0, 5, 10]);
    expect(dispatch.cases.map((item) => item.rowIndex)).toEqual([0, 1, 2]);
    expect(dispatch.hasDefault).toBe(true);
    expect(dispatch.reason).toContain('3');
    expect(dispatch.diagnostics).toEqual([]);
  });

  it('不排序：作者写 10 / 0 / 5，cases 保持源书写顺序', () => {
    const plan = realPlan([row('10', '10', '甲', 3), row('0', '0', '乙', 4), row('5', '5', '丙', 5), row(null, null, '否', 6)]);
    expect(planTableDispatch(plan).cases.map((item) => item.value)).toEqual([10, 0, 5]);
  });

  it('没有 `否` 也支持：hasDefault=false（收尾形式由 adapter 数据定）', () => {
    const dispatch = planTableDispatch(fact(exactRows(1, 2, 3)));
    expect(dispatch.style).toBe('selectcase');
    expect(dispatch.hasDefault).toBe(false);
    expect(dispatch.cases.map((item) => item.value)).toEqual([1, 2, 3]);
  });

  it('`# 常量` 端点静态求值成整数键（可证等值，不是表达式端点）', () => {
    const constants = new Map([
      ['甲', 5],
      ['乙', 6],
    ]);
    const plan = realPlan(
      [row('甲', '甲', 1, 3), row('乙', '乙', 2, 4), row('7', '7', 3, 5), row(null, null, 0, 6)],
      { constants },
    );
    expect(planTableDispatch(plan).cases.map((item) => item.value)).toEqual([5, 6, 7]);
  });

  it('判别式放行纯整数形态：括号 / 下标 / 比较 / 三元', () => {
    for (const subject of ['恋慕 + 1', '(恋慕 + 1) * 2', '队伍[0]', '恋慕 >= 100 ? 1 : 0', 'TFLAG:193']) {
      expect(planTableDispatch(fact(exactRows(1, 2, 3), subject)).style, subject).toBe('selectcase');
    }
  });

  it('阈值写死为 3（等值分派 = 1 头 + n 档 + 1 尾）', () => {
    expect(TABLE_DISPATCH_MIN_ARMS).toBe(3);
    expect(planTableDispatch(fact(exactRows(1, 2))).style).toBe('if-chain');
    expect(planTableDispatch(fact(exactRows(1, 2, 3))).style).toBe('selectcase');
    expect(planTableDispatch(fact(exactRows(1, 2, 3, 4))).style).toBe('selectcase');
  });

  it('计划带源 span：cases 指回原行、计划指回表头', () => {
    const plan = realPlan(THREE_ARMS);
    const dispatch = planTableDispatch(plan);
    expect(dispatch.span).toBe(plan.span);
    expect(dispatch.cases.map((item) => item.span.start.line)).toEqual([3, 4, 5]);
  });
});

/* ============================== 2. 反例：退回 IF 链 ============================== */

describe('planTableDispatch · 不可证/不划算 → if-chain', () => {
  it('2 条等值臂 → if-chain（少于 3 条 IF 更短）', () => {
    const dispatch = planTableDispatch(fact(exactRows(1, 2)));
    expect(dispatch.style).toBe('if-chain');
    expect(dispatch.cases).toEqual([]);
    expect(dispatch.reason).toContain('IF 链更短');
  });

  it('1 条等值臂 + 否 → if-chain（否不计入臂数）', () => {
    const dispatch = planTableDispatch(fact([...exactRows(1), factRow('default', null, null, 9)]));
    expect(dispatch.style).toBe('if-chain');
    expect(dispatch.hasDefault).toBe(true);
  });

  it('含闭区间 → if-chain（单条等值档表达不了）', () => {
    const dispatch = planTableDispatch(fact([...exactRows(1, 2), factRow('closed', 10, 20, 9)]));
    expect(dispatch.style).toBe('if-chain');
    expect(dispatch.reason).toContain('闭区间');
  });

  it('含开放区间（`a..` / `..b`）→ if-chain', () => {
    const atLeast = planTableDispatch(fact([...exactRows(1, 2), factRow('at-least', 30, null, 9)]));
    expect(atLeast.style).toBe('if-chain');
    expect(atLeast.reason).toContain('开放区间');
    const atMost = planTableDispatch(fact([...exactRows(1, 2), factRow('at-most', null, 30, 9)]));
    expect(atMost.style).toBe('if-chain');
  });

  it('字符串字面量判别式 → if-chain（非整数，不是 error）', () => {
    const dispatch = planTableDispatch(fact(exactRows(1, 2, 3), '"亲近"'));
    expect(dispatch.style).toBe('if-chain');
    expect(dispatch.reason).toContain('不是纯整数表达式');
    expect(dispatch.diagnostics).toEqual([]);
  });

  it('函数调用判别式 → if-chain（可能有副作用）', () => {
    for (const subject of ['心情(1)', '甲.乙(2)', '取(1) + 2']) {
      const dispatch = planTableDispatch(fact(exactRows(1, 2, 3), subject));
      expect(dispatch.style, subject).toBe('if-chain');
      expect(dispatch.reason).toContain('不是纯整数表达式');
    }
  });

  it('赋值 / 逗号 / 花括号判别式 → if-chain', () => {
    for (const subject of ['恋慕 = 1', '恋慕, 1', '{恋慕}']) {
      expect(planTableDispatch(fact(exactRows(1, 2, 3), subject)).style, subject).toBe('if-chain');
    }
  });
});

/* ============================== 3. fail-closed：计划不自洽 ============================== */

describe('planTableDispatch · 计划不自洽 → error（既有诊断、不产字节）', () => {
  it('缺判别式 → core/expr/not-expression，零档', () => {
    const dispatch = planTableDispatch(fact(exactRows(1, 2, 3), '   '));
    expect(dispatch.style).toBe('error');
    expect(dispatch.cases).toEqual([]);
    expect(dispatch.diagnostics.map((item) => item.code)).toEqual(['core/expr/not-expression']);
    expect(dispatch.diagnostics[0]?.severity).toBe('error');
  });

  it('等值键重复 → core/table/overlap，诊断指向后一档', () => {
    const dispatch = planTableDispatch(fact([factRow('exact', 5, 5, 3), factRow('exact', 5, 5, 4), factRow('exact', 7, 7, 5)]));
    expect(dispatch.style).toBe('error');
    expect(dispatch.diagnostics.map((item) => item.code)).toEqual(['core/table/overlap']);
    expect(dispatch.diagnostics[0]?.span?.start.line).toBe(4);
    expect(dispatch.reason).toContain('5');
  });

  it('等值键不是安全整数 → core/table/dynamic-endpoint', () => {
    const huge = Number.MAX_SAFE_INTEGER + 2;
    const dispatch = planTableDispatch(fact([factRow('exact', huge, huge, 3), factRow('exact', 1, 1, 4), factRow('exact', 2, 2, 5)]));
    expect(dispatch.style).toBe('error');
    expect(dispatch.diagnostics.map((item) => item.code)).toEqual(['core/table/dynamic-endpoint']);
  });

  it('`from === to` 之外的 exact 形状（端点不等）→ error（不当作等值）', () => {
    const dispatch = planTableDispatch(fact([factRow('exact', 1, 2, 3), factRow('exact', 3, 3, 4), factRow('exact', 4, 4, 5)]));
    expect(dispatch.style).toBe('error');
    expect(dispatch.diagnostics.map((item) => item.code)).toEqual(['core/table/dynamic-endpoint']);
  });

  it('出现第二个 `否` → core/table/default-not-last', () => {
    const dispatch = planTableDispatch(
      fact([factRow('exact', 1, 1, 3), factRow('default', null, null, 4), factRow('default', null, null, 5)]),
    );
    expect(dispatch.style).toBe('error');
    expect(dispatch.diagnostics.map((item) => item.code)).toEqual(['core/table/default-not-last']);
  });
});

/* ============================== 4. 纯数据 / 缓存 ============================== */

describe('planTableDispatch · 计划是纯数据', () => {
  it('JSON 往返逐字相等（没有函数/对象引用泄漏进计划）', () => {
    const dispatch = planTableDispatch(realPlan(THREE_ARMS));
    expect(JSON.parse(JSON.stringify(dispatch))).toEqual(dispatch);
  });

  it('深冻结：计划、cases、diagnostics 都不可改（缓存对象不被下游污染）', () => {
    const dispatch = planTableDispatch(realPlan(THREE_ARMS));
    expect(Object.isFrozen(dispatch)).toBe(true);
    expect(Object.isFrozen(dispatch.cases)).toBe(true);
    expect(Object.isFrozen(dispatch.diagnostics)).toBe(true);
    expect(Object.isFrozen(dispatch.cases[0])).toBe(true);
  });

  it('同一 plan 对象命中缓存（返回同一对象）；内容相同的不同对象结果相等', () => {
    const plan = realPlan(THREE_ARMS);
    expect(planTableDispatch(plan)).toBe(planTableDispatch(plan));
    expect(planTableDispatch(realPlan(THREE_ARMS))).toEqual(planTableDispatch(plan));
  });
});

/* ============================== 5. core 侧结构请求（可选能力） ============================== */

const MACHINE = ['# 机 开场', '# 视 灵梦'];
const EXACT_SOURCE = [
  ...MACHINE,
  '# 表 心情 由 恋慕',
  '    0 疏远',
  '    5 平常',
  '    10 亲近',
  '    否 未知',
  '> 她看着{心情}。',
];

interface DispatchProbe {
  readonly requests: TableDispatchEmitRequest[];
}

/** fixture backend + 可选能力（结构化探测面；契约 formalize 前测试就按这个形状接） */
function backendWithDispatch(
  probe: DispatchProbe,
  answer?: (request: TableDispatchEmitRequest) => EmitResult,
): KojoEmitBackend {
  const program = {
    ...FIXTURE_BACKEND.program,
    tableDispatch(request: TableDispatchEmitRequest): EmitResult {
      probe.requests.push(request);
      return answer === undefined ? [`DISPATCH|${request.plan.cases.map((item) => item.value).join(',')}`] : answer(request);
    },
  };
  return { ...FIXTURE_BACKEND, program } satisfies KojoEmitBackend;
}

const bodyLines = (erb: string): string[] => (erb.length === 0 ? [] : erb.slice(0, -1).split('\n'));
const compile = (source: readonly string[], backend: KojoEmitBackend) =>
  compileKojoSource({ source: source.join('\n'), adapter: FIXTURE_ADAPTER, backend });

describe('core 侧只发结构请求（零引擎关键字）', () => {
  it('可证等值 + adapter 有能力 → 发一次请求：槽名 / 每臂已降糖行 / 兜底行', () => {
    const probe: DispatchProbe = { requests: [] };
    const result = compile(EXACT_SOURCE, backendWithDispatch(probe));

    expect(result.ok).toBe(true);
    expect(probe.requests).toHaveLength(1);
    const request = probe.requests[0]!;
    expect(request.plan.style).toBe('selectcase');
    expect(request.subjectSlot).toBe('__kojo_table_心情');
    expect(request.valueSlot).toBe('__kojo_table_心情__value');
    expect(request.armLines).toEqual([
      ['SET __kojo_table_心情__value = {"疏远"}'],
      ['SET __kojo_table_心情__value = {"平常"}'],
      ['SET __kojo_table_心情__value = {"亲近"}'],
    ]);
    expect(request.elseLines).toEqual(['SET __kojo_table_心情__value = {"未知"}']);
    // 判别式仍由 core 先算一次（在请求之前），请求里不重复求值
    const lines = bodyLines(result.erb);
    expect(lines).toContain('SET __kojo_table_心情 = {恋慕}');
    expect(lines).toContain('DISPATCH|0,5,10');
    // adapter 的落点行只出现一次（没有同时再发 IF 链）
    expect(lines.some((line) => line.startsWith('IF {') || line.startsWith('ELSEIF {'))).toBe(false);
  });

  it('没有该能力 → 既有 IF 链逐字节不变（golden 零变化）', () => {
    const result = compile(EXACT_SOURCE, FIXTURE_BACKEND);
    expect(result.ok).toBe(true);
    expect(bodyLines(result.erb)).toEqual([
      'MACHINE 开场',
      ';SLOT __kojo_table_心情 table int',
      ';SLOT __kojo_table_心情__value table string',
      'SET __kojo_table_心情 = {恋慕}',
      'IF {__kojo_table_心情 == 0}',
      'SET __kojo_table_心情__value = {"疏远"}',
      'ELSEIF {__kojo_table_心情 == 5}',
      'SET __kojo_table_心情__value = {"平常"}',
      'ELSEIF {__kojo_table_心情 == 10}',
      'SET __kojo_table_心情__value = {"亲近"}',
      'ELSE',
      'SET __kojo_table_心情__value = {"未知"}',
      'ENDIF',
      'TELL: 她看着{__kojo_table_心情__value}。 /WAIT',
      'MACHINE.END',
    ]);
  });

  it('2 臂 / 含区间 → 不请求（直接走 IF 链）', () => {
    for (const source of [
      [...MACHINE, '# 表 心情 由 恋慕', '    0 疏远', '    5 平常', '    否 未知', '> {心情}'],
      [...MACHINE, '# 表 心情 由 恋慕', '    0..9 疏远', '    10 平常', '    20 亲近', '    否 未知', '> {心情}'],
    ]) {
      const probe: DispatchProbe = { requests: [] };
      const result = compile(source, backendWithDispatch(probe));
      expect(result.ok).toBe(true);
      expect(probe.requests).toHaveLength(0);
      expect(bodyLines(result.erb).some((line) => line.startsWith('IF {'))).toBe(true);
    }
  });

  it('能力返回 EmitFailure → 诊断上报、零字节（fail-closed）', () => {
    const probe: DispatchProbe = { requests: [] };
    const result = compile(
      EXACT_SOURCE,
      backendWithDispatch(probe, (request) => ({
        diagnostics: [
          { code: 'unit/probe', severity: 'error', message: 'adapter 不落等值分派', span: request.plan.span },
        ],
      })),
    );
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(result.diagnostics.map((item) => item.code)).toContain('unit/probe');
  });

  it('tableDispatchOf：缺省 null；有则保留 this（能力是 backend.program 的方法）', () => {
    expect(tableDispatchOf(FIXTURE_BACKEND)).toBeNull();
    const probe: DispatchProbe = { requests: [] };
    const backend = backendWithDispatch(probe);
    const emitter = tableDispatchOf(backend);
    expect(emitter).not.toBeNull();
    expect(typeof emitter).toBe('function');
  });
});
