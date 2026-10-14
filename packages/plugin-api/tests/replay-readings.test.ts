import { describe, expect, it } from 'vitest';
import type { FunctionReplay, PredicateReplay, ReplayUnknownCode } from '../src/index';
import { readReplayDeterminability, replayUnknownReducibility } from '../src/index';

/** 谓词夹具：`true`/`false` 为确定判定，`unknown` 携带原因分类 + message */
const pred = (
  outcome: 'true' | 'false' | { code: ReplayUnknownCode; message: string },
): PredicateReplay => ({
  kind: 'IF',
  text: '',
  line: 1,
  outcome:
    typeof outcome === 'string' ? { kind: outcome } : { kind: 'unknown', unknown: outcome },
  expr: { kind: 'opaque', text: '' },
});

/** 函数夹具：由谓词序列推出 stats（与契约同形） */
const fn = (predicates: PredicateReplay[]): FunctionReplay => ({
  normalizedName: 'F',
  filePath: 'F.ERB',
  startLine: 1,
  predicates,
  branches: [],
  stats: {
    total: predicates.length,
    hit: predicates.filter((p) => p.outcome.kind === 'true').length,
    miss: predicates.filter((p) => p.outcome.kind === 'false').length,
    unknown: predicates.filter((p) => p.outcome.kind === 'unknown').length,
  },
  confidence: predicates.some((p) => p.outcome.kind === 'unknown') ? 'partial' : 'exact',
});

describe('replayUnknownReducibility —— 真随机 vs 能力缺口', () => {
  it('RAND 伪变量 message → 不可约真随机', () => {
    expect(replayUnknownReducibility({ code: 'pseudo', message: '伪变量（运行期计算值）：RAND' })).toBe(
      'irreducible',
    );
  });

  it('其它计算值伪变量（CHARANUM 等）→ 能力缺口', () => {
    expect(
      replayUnknownReducibility({ code: 'pseudo', message: '伪变量（运行期计算值）：CHARANUM' }),
    ).toBe('gap');
  });

  it('语言局部量（同一 pseudo 码）→ 能力缺口', () => {
    expect(replayUnknownReducibility({ code: 'pseudo', message: '语言局部量不在快照中：LOCAL' })).toBe(
      'gap',
    );
  });

  it('非 pseudo 码一律能力缺口（真随机只认 RAND 伪变量）', () => {
    expect(replayUnknownReducibility({ code: 'call-context', message: '未提供上下文' })).toBe('gap');
    expect(replayUnknownReducibility({ code: 'call', message: 'x' })).toBe('gap');
  });

  it('词界护栏：`RANDDATA` 等复合名不误判为真随机', () => {
    expect(replayUnknownReducibility({ code: 'pseudo', message: '伪变量（运行期计算值）：RANDDATA' })).toBe(
      'gap',
    );
  });
});

describe('readReplayDeterminability —— 两读汇总', () => {
  it('按谓词现算 irreducible/gap 并给出两读', () => {
    // 10 谓词：4 命中 / 2 未命中 / 4 未知（1 真随机 + 3 能力缺口）
    const reading = readReplayDeterminability([
      fn([
        pred('true'),
        pred('true'),
        pred('true'),
        pred('true'),
        pred('false'),
        pred('false'),
        pred({ code: 'pseudo', message: '伪变量（运行期计算值）：RAND' }),
        pred({ code: 'call-context', message: '' }),
        pred({ code: 'named-index', message: '' }),
        pred({ code: 'missing-var', message: '' }),
      ]),
    ]);
    expect(reading.predicates).toBe(10);
    expect(reading.unknown).toBe(4);
    expect(reading.irreducible).toBe(1);
    expect(reading.gap).toBe(3);
    // 可判定率 = 1 − gap/predicates = 1 − 3/10
    expect(reading.determinableRate).toBeCloseTo(0.7, 12);
    // 能力覆盖率 = (predicates − unknown)/(predicates − irreducible) = 6/9
    expect(reading.capabilityCoverage).toBeCloseTo(6 / 9, 12);
  });

  it('跨函数聚合，null 条目跳过', () => {
    const good = fn([pred('true'), pred({ code: 'pseudo', message: '：RAND' })]);
    const reading = readReplayDeterminability([null, good, null]);
    expect(reading.predicates).toBe(2);
    expect(reading.unknown).toBe(1);
    expect(reading.irreducible).toBe(1);
    expect(reading.gap).toBe(0);
    expect(reading.determinableRate).toBe(1); // 无能力缺口
    // 非真随机空间只剩 1 条（已判定）⇒ 覆盖满
    expect(reading.capabilityCoverage).toBeCloseTo(1, 12);
  });

  it('空集合两读皆 1（空洞满足，与 total=0 → exact 约定一致）', () => {
    const reading = readReplayDeterminability([]);
    expect(reading).toMatchObject({ predicates: 0, unknown: 0, irreducible: 0, gap: 0 });
    expect(reading.determinableRate).toBe(1);
    expect(reading.capabilityCoverage).toBe(1);
  });

  it('全真随机 → 能力覆盖率空洞为 1、可判定率 1（无从归咎能力缺口）', () => {
    const reading = readReplayDeterminability([
      fn([pred({ code: 'pseudo', message: '：RAND' }), pred({ code: 'pseudo', message: '：RAND' })]),
    ]);
    expect(reading).toMatchObject({ predicates: 2, unknown: 2, irreducible: 2, gap: 0 });
    expect(reading.determinableRate).toBe(1);
    expect(reading.capabilityCoverage).toBe(1); // predicates − irreducible = 0 → 空洞
  });
});
