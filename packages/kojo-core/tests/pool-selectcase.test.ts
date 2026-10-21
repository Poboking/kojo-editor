/**
 * `# 池` 等值分派落点判定（K2-POOL-SELECTCASE / §7.1 / §16.2 C2.6）单测。
 *
 * 钉的判据（写死在 `lower/expand/pool-plan.ts` 头注）：
 * - 正例：所有普通分支都是**同一主语 + 整数等值**（`==` / `=`）、分支数 ≥ 3（含 `? 否`）
 *   → `selectcase`；`? 否` 必填、必须最后、必须可打印；
 * - 反例：区间比较 / 逻辑组合 / 主语不一致 / 非整数右值 / 分支数不足 → `if-chain`
 *   （现状，不产错、不产半成品）；
 * - fail-closed：缺/重复/错位的 `? 否`、空 `? 否`、等值键重复 → `error` + 既有诊断；
 * - 计划是**纯数据**（深冻结、JSON 往返、可离线断言），同对象命中缓存；
 * - core 只发**结构请求**（`presentation.poolDispatch` 可选能力），没有能力时既有 IF 链
 *   逐字节不变。
 */
import { describe, expect, it } from 'vitest';
import type { KojoPoolDecl } from '../src/ast.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import type { EmitResult, KojoEmitBackend, KojoPresentationEmitter } from '../src/lower/backend.js';
import { parseSource } from '../src/parser.js';
import {
  POOL_DISPATCH_MIN_BRANCHES,
  planPoolDispatch,
  poolDispatchOf,
  poolSubjectSlot,
} from '../src/lower/expand/pool-plan.js';
import type { PoolDispatchEmitRequest } from '../src/lower/expand/pool-plan.js';
import { isPureDispatchSubject, scanIntegerEquality } from '../src/lower/expand/dispatch-plan.js';

/* ============================== 夹具 ============================== */

const MACHINE = ['# 机 开场', '# 视 灵梦'];

/** 真实 parser 产出的池声明（不手搓 AST：判定输入必须与编译主链同形） */
function poolOf(lines: readonly string[]): KojoPoolDecl {
  const file = parseSource(lines.join('\n'));
  for (const decl of file.decls) if (decl.kind === 'pool') return decl;
  throw new Error('fixture 里没有 `# 池` 声明');
}

/** 三个等值分支 + `? 否` 的基准池 */
const THREE_CASES = [
  ...MACHINE,
  '# 池 等级问候',
  '    ? 好感 == 0',
  '        > 嗯。',
  '    ? 好感 == 1',
  '        > 早上好。',
  '    ? 好感 == 2',
  '        > 亲爱的，早安。',
  '    ? 否',
  '        > ……？',
];

const bodyLines = (erb: string): string[] => (erb.length === 0 ? [] : erb.slice(0, -1).split('\n'));

/* ============================== 1. 正例：可证等值 ============================== */

describe('planPoolDispatch · 可证等值 → selectcase', () => {
  it('三个同主语整数等值 + `? 否` → selectcase；cases 按源顺序、否不进 cases', () => {
    const plan = planPoolDispatch(poolOf(THREE_CASES));
    expect(plan.style).toBe('selectcase');
    expect(plan.cases.map((item) => item.value)).toEqual([0, 1, 2]);
    expect(plan.cases.map((item) => item.branchIndex)).toEqual([0, 1, 2]);
    expect(plan.hasDefault).toBe(true);
    expect(plan.defaultIndex).toBe(3);
    expect(plan.subject?.text).toBe('好感');
    expect(plan.diagnostics).toEqual([]);
    expect(plan.reason).toContain('整数等值');
  });

  it('`=` 也算等值（与 `==` 同口径）', () => {
    const plan = planPoolDispatch(
      poolOf([...MACHINE, '# 池 甲', '    ? 模式 = 0', '        > 甲', '    ? 模式 = 1', '        > 乙', '    ? 否', '        > 丙']),
    );
    expect(plan.style).toBe('selectcase');
    expect(plan.cases.map((item) => item.value)).toEqual([0, 1]);
    expect(plan.subject?.text).toBe('模式');
  });

  it('不排序：作者写 10 / 0 / 5，cases 保持源书写顺序', () => {
    const plan = planPoolDispatch(
      poolOf([
        ...MACHINE,
        '# 池 甲',
        '    ? 好感 == 10',
        '        > 十',
        '    ? 好感 == 0',
        '        > 零',
        '    ? 好感 == 5',
        '        > 五',
        '    ? 否',
        '        > 否',
      ]),
    );
    expect(plan.cases.map((item) => item.value)).toEqual([10, 0, 5]);
  });

  it('负数与 0 都收；主语可以是下标 / 域名冒号这类纯表达式', () => {
    const plan = planPoolDispatch(
      poolOf([
        ...MACHINE,
        '# 池 甲',
        '    ? 状态[-1] == -1',
        '        > 甲',
        '    ? 状态[-1] == 0',
        '        > 乙',
        '    ? 否',
        '        > 丙',
      ]),
    );
    expect(plan.style).toBe('selectcase');
    expect(plan.cases.map((item) => item.value)).toEqual([-1, 0]);
    expect(plan.subject?.text).toBe('状态[-1]');
  });

  it('阈值写死为 3 个分支（含 `? 否`）', () => {
    expect(POOL_DISPATCH_MIN_BRANCHES).toBe(3);
    const two = poolOf([...MACHINE, '# 池 甲', '    ? 好感 == 0', '        > 甲', '    ? 否', '        > 乙']);
    expect(planPoolDispatch(two).style).toBe('if-chain');
    expect(planPoolDispatch(two).reason).toContain('2');
  });
});

/* ============================== 2. 反例：不可证 → if-chain（现状） ============================== */

describe('planPoolDispatch · 不可证等值 → if-chain（保持现状，不产错）', () => {
  const ifChain = (branchLines: readonly string[]) => planPoolDispatch(poolOf([...MACHINE, '# 池 甲', ...branchLines]));

  it('区间比较（`<` / `<=` / `>` / `>=`）不可证', () => {
    for (const op of ['<', '<=', '>', '>=']) {
      const plan = ifChain([
        `    ? 好感 ${op} 0`,
        '        > 甲',
        `    ? 好感 ${op} 1`,
        '        > 乙',
        '    ? 否',
        '        > 丙',
      ]);
      expect(plan.style, op).toBe('if-chain');
      expect(plan.reason).toContain('不是整数等值');
      expect(plan.cases).toEqual([]);
    }
  });

  it('逻辑组合（`&&` / `||`）不可证', () => {
    for (const line of ['    ? 好感 == 0 && 天气 == 1', '    ? 好感 == 0 || 天气 == 1']) {
      const plan = ifChain([line, '        > 甲', '    ? 好感 == 2', '        > 乙', '    ? 否', '        > 丙']);
      expect(plan.style).toBe('if-chain');
      expect(plan.reason).toContain('不是整数等值');
    }
  });

  it('主语不一致 → if-chain，理由里带两个主语', () => {
    const plan = ifChain([
      '    ? 好感 == 0',
      '        > 甲',
      '    ? 心情 == 1',
      '        > 乙',
      '    ? 否',
      '        > 丙',
    ]);
    expect(plan.style).toBe('if-chain');
    expect(plan.reason).toContain('主语');
    expect(plan.reason).toContain('好感');
    expect(plan.reason).toContain('心情');
    expect(plan.subject?.text).toBe('好感');
  });

  it('非整数右值（字符串 / 小数 / 未求值常量 / 十六进制）不可证', () => {
    for (const value of ['"亲近"', '1.5', '亲近线', '0x10']) {
      const plan = ifChain([
        `    ? 好感 == ${value}`,
        '        > 甲',
        '    ? 好感 == 1',
        '        > 乙',
        '    ? 否',
        '        > 丙',
      ]);
      expect(plan.style, value).toBe('if-chain');
      expect(plan.reason).toContain('不是十进制安全整数');
    }
  });

  it('函数调用 / 三元作主语不可证（可能有副作用）', () => {
    for (const subject of ['取名()', '好感 > 3 ? 1 : 0']) {
      const plan = ifChain([
        `    ? ${subject} == 0`,
        '        > 甲',
        `    ? ${subject} == 1`,
        '        > 乙',
        '    ? 否',
        '        > 丙',
      ]);
      expect(plan.style, subject).toBe('if-chain');
      expect(plan.reason).toContain('不是整数等值');
    }
  });
});

/* ============================== 3. fail-closed（error + 诊断） ============================== */

describe('planPoolDispatch · 计划不自洽 → error（诊断 + 不产字节）', () => {
  it('等值键重复 → error，诊断指向后一档，不产 cases', () => {
    const plan = planPoolDispatch(
      poolOf([
        ...MACHINE,
        '# 池 甲',
        '    ? 好感 == 0',
        '        > 甲',
        '    ? 好感 == 0',
        '        > 乙',
        '    ? 否',
        '        > 丙',
      ]),
    );
    expect(plan.style).toBe('error');
    expect(plan.cases).toEqual([]);
    expect(plan.reason).toContain('重复');
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['core/expr/not-expression']);
    expect(plan.diagnostics[0]?.severity).toBe('error');
    expect(plan.diagnostics[0]?.span?.start.line).toBe(6); // 第二个 `? 好感 == 0`
  });

  it('缺 `? 否` → error（core/pool/no-default）', () => {
    const plan = planPoolDispatch(
      poolOf([...MACHINE, '# 池 甲', '    ? 好感 == 0', '        > 甲', '    ? 好感 == 1', '        > 乙']),
    );
    expect(plan.style).toBe('error');
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['core/pool/no-default']);
    expect(plan.diagnostics[0]?.severity).toBe('error');
  });

  it('`? 否` 不在最后 → error（core/pool/default-not-last）', () => {
    const plan = planPoolDispatch(
      poolOf([
        ...MACHINE,
        '# 池 甲',
        '    ? 好感 == 0',
        '        > 甲',
        '    ? 否',
        '        > 兜底',
        '    ? 好感 == 1',
        '        > 乙',
      ]),
    );
    expect(plan.style).toBe('error');
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['core/pool/default-not-last']);
  });

  it('空 `? 否`（不可打印）→ error（core/pool/empty-branch）', () => {
    const plan = planPoolDispatch(
      poolOf([...MACHINE, '# 池 甲', '    ? 好感 == 0', '        > 甲', '    ? 好感 == 1', '        > 乙', '    ? 否', '']),
    );
    expect(plan.style).toBe('error');
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['core/pool/empty-branch']);
  });

  it('同一池被引用两次：计划不自洽只报一次（不刷屏）', () => {
    const source = [
      ...MACHINE,
      '# 池 甲',
      '    ? 好感 == 0',
      '        > 甲',
      '    ? 好感 == 0',
      '        > 乙',
      '    ? 否',
      '        > 丙',
      '! 甲',
      '! 甲',
    ];
    const result = compile(source, FIXTURE_BACKEND);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter((item) => item.code === 'core/expr/not-expression')).toHaveLength(1);
  });
});

/* ============================== 4. 纯数据 / 缓存 / 细节 ============================== */

describe('planPoolDispatch · 计划是纯数据', () => {
  it('JSON 往返逐字相等（没有函数/对象引用泄漏进计划）', () => {
    const plan = planPoolDispatch(poolOf(THREE_CASES));
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('深冻结：计划、cases、cases 元素、diagnostics 都不可改', () => {
    const plan = planPoolDispatch(poolOf(THREE_CASES));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.cases)).toBe(true);
    expect(Object.isFrozen(plan.cases[0])).toBe(true);
    expect(Object.isFrozen(plan.diagnostics)).toBe(true);
  });

  it('同一池声明命中缓存（返回同一对象）；结构相同的新池结果相等', () => {
    const pool = poolOf(THREE_CASES);
    expect(planPoolDispatch(pool)).toBe(planPoolDispatch(pool));
    expect(planPoolDispatch(poolOf(THREE_CASES))).toEqual(planPoolDispatch(pool));
  });

  it('主语槽名带保留前缀 `__kojo_pool_`', () => {
    expect(poolSubjectSlot('等级问候')).toBe('__kojo_pool_等级问候');
  });
});

/* ============================== 5. 共享等值扫描（dispatch-plan） ============================== */

describe('dispatch-plan · 整数等值切片与纯主语判据', () => {
  const expression = (text: string) => ({
    text,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 + text.length } },
  });

  it('切出主语与整数（`==` / `=` / 负数）', () => {
    for (const [text, subject, value] of [
      ['好感 == 0', '好感', 0],
      ['好感 = -3', '好感', -3],
      ['  状态[0] == 12  ', '状态[0]', 12],
    ] as const) {
      const scan = scanIntegerEquality(expression(text));
      expect(scan.ok).toBe(true);
      if (!scan.ok) continue;
      expect(scan.fact.subject.text).toBe(subject);
      expect(scan.fact.value).toBe(value);
    }
  });

  it('不配平 / 复合条件 / 非整数 / 空左值都有可判别失败', () => {
    const problems = ['好感 == (0', '好感 == 0 && 心情 == 1', '好感 == 1.5', '== 0', '好感 != 0'].map((text) => {
      const scan = scanIntegerEquality(expression(text));
      return scan.ok ? 'ok' : scan.problem;
    });
    expect(problems).toEqual(['impure-subject', 'compound-condition', 'non-integer-value', 'empty-subject', 'not-equality']);
  });

  it('纯主语判据：算术/下标/域名冒号放行；比较/调用/字符串/逗号拒绝', () => {
    for (const text of ['好感', '好感 + 1', '状态[索引 + 1]', 'TFLAG:193', '(好感 + 1) * 2']) {
      expect(isPureDispatchSubject(text), text).toBe(true);
    }
    for (const text of ['好感 > 1', '取名()', '"好感"', '状态[0, 1]', '好感 == 0', '好感 ? 1 : 2']) {
      expect(isPureDispatchSubject(text), text).toBe(false);
    }
  });
});

/* ============================== 6. core 侧结构请求（可选能力） ============================== */

const POOL_CALL_SOURCE = [...THREE_CASES, '! 等级问候'];

interface PoolProbe {
  readonly requests: PoolDispatchEmitRequest[];
}

/** fixture backend + 契约可选能力 `presentation.poolDispatch`（K2-DISPATCH-WIRING 后的正字段） */
function backendWithPoolDispatch(
  probe: PoolProbe,
  answer?: (request: PoolDispatchEmitRequest) => EmitResult,
): KojoEmitBackend {
  const presentation: KojoPresentationEmitter = {
    ...FIXTURE_BACKEND.presentation,
    poolDispatch(request: PoolDispatchEmitRequest): EmitResult {
      probe.requests.push(request);
      return answer === undefined
        ? [`POOLDISPATCH|${request.plan.cases.map((item) => item.value).join(',')}`]
        : answer(request);
    },
  };
  return { ...FIXTURE_BACKEND, presentation } satisfies KojoEmitBackend;
}

const compile = (source: readonly string[], backend: KojoEmitBackend) =>
  compileKojoSource({ source: source.join('\n'), adapter: FIXTURE_ADAPTER, backend });

describe('core 侧只发结构请求（零引擎关键字）', () => {
  it('可证等值 + adapter 有能力 → 发一次请求：主语槽 / 每档已降糖行 / 兜底行', () => {
    const probe: PoolProbe = { requests: [] };
    const result = compile(POOL_CALL_SOURCE, backendWithPoolDispatch(probe));

    expect(result.ok).toBe(true);
    expect(probe.requests).toHaveLength(1);
    const request = probe.requests[0]!;
    expect(request.plan.style).toBe('selectcase');
    expect(request.subjectSlot).toBe('__kojo_pool_等级问候');
    expect(request.caseLines).toEqual([
      ['TELL: 嗯。 /WAIT'],
      ['TELL: 早上好。 /WAIT'],
      ['TELL: 亲爱的，早安。 /WAIT'],
    ]);
    expect(request.elseLines).toEqual(['TELL: ……？ /WAIT']);
    // 主语仍由 core 先算一次（在请求之前），请求里不重复求值
    const lines = bodyLines(result.erb);
    expect(lines).toContain('SET __kojo_pool_等级问候 = {好感}');
    expect(lines).toContain('POOLDISPATCH|0,1,2');
    // adapter 的落点行只出现一次（没有同时再发 IF 链）
    expect(lines.some((line) => line.startsWith('IF {') || line.startsWith('ELSEIF {'))).toBe(false);
    // 隐藏槽声明走既有 slots 面（kind/role 是池自己的事实，不再借用 template 预留位）
    expect(lines).toContain(';SLOT __kojo_pool_等级问候 pool int');
  });

  it('没有该能力 → 既有 IF 链逐字节不变（golden 零变化）', () => {
    const result = compile(POOL_CALL_SOURCE, FIXTURE_BACKEND);
    expect(result.ok).toBe(true);
    expect(bodyLines(result.erb)).toEqual([
      'MACHINE 开场',
      'IF {好感 == 0}',
      'TELL: 嗯。 /WAIT',
      'ELSEIF {好感 == 1}',
      'TELL: 早上好。 /WAIT',
      'ELSEIF {好感 == 2}',
      'TELL: 亲爱的，早安。 /WAIT',
      'ELSE',
      'TELL: ……？ /WAIT',
      'ENDIF',
      'MACHINE.END',
    ]);
  });

  it('不可证（区间比较）→ 不请求（直接走 IF 链）', () => {
    const source = [
      ...MACHINE,
      '# 池 甲',
      '    ? 好感 < 0',
      '        > 甲',
      '    ? 好感 < 1',
      '        > 乙',
      '    ? 否',
      '        > 丙',
      '! 甲',
    ];
    const probe: PoolProbe = { requests: [] };
    const result = compile(source, backendWithPoolDispatch(probe));
    expect(result.ok).toBe(true);
    expect(probe.requests).toHaveLength(0);
    expect(bodyLines(result.erb).some((line) => line.startsWith('IF {'))).toBe(true);
  });

  it('计划不自洽（等值键重复）→ 零字节、诊断上报、不请求', () => {
    const source = [
      ...MACHINE,
      '# 池 甲',
      '    ? 好感 == 0',
      '        > 甲',
      '    ? 好感 == 0',
      '        > 乙',
      '    ? 否',
      '        > 丙',
      '! 甲',
    ];
    const probe: PoolProbe = { requests: [] };
    const result = compile(source, backendWithPoolDispatch(probe));
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(result.diagnostics.map((item) => item.code)).toContain('core/expr/not-expression');
    expect(probe.requests).toHaveLength(0);
  });

  it('能力返回 EmitFailure → 诊断上报、零字节（fail-closed）', () => {
    const probe: PoolProbe = { requests: [] };
    const result = compile(
      POOL_CALL_SOURCE,
      backendWithPoolDispatch(probe, (request) => ({
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

  it('poolDispatchOf：缺省 null；有则保留 this（能力是 backend.presentation 的方法）', () => {
    expect(poolDispatchOf(FIXTURE_BACKEND)).toBeNull();
    const probe: PoolProbe = { requests: [] };
    const emitter = poolDispatchOf(backendWithPoolDispatch(probe));
    expect(emitter).not.toBeNull();
    expect(typeof emitter).toBe('function');
  });
});
