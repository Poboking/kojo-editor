import { describe, expect, it } from 'vitest';
import type { CacheExpect, ConventionReport, ConventionRule } from '@kojo/plugin-api';
import {
  LINT_SNAPSHOT_FORMAT,
  LINT_STORE_KEY,
  decodeReport,
  encodeReport,
  lintExpect,
  rulesDigest,
} from '../src/snapshot';

const report = (over: Partial<ConventionReport> = {}): ConventionReport => ({
  adapterId: 'eratw',
  startedAt: 1,
  finishedAt: 3100,
  durationMs: 3100,
  issues: [{ ruleId: 'erb.duplicate-function', severity: 'error', message: '重复定义', key: 'k1' }],
  counts: { error: 1, warning: 0, info: 0 },
  ruleCount: 3,
  failedRules: [],
  ...over,
});

const project = (inputDigest?: string) =>
  inputDigest === undefined
    ? { rootDir: '/game', adapterId: 'eratw' }
    : { rootDir: '/game', adapterId: 'eratw', inputDigest };

const rule = (id: string, severity: 'error' | 'warning' | 'info' = 'warning', description = 'd'): ConventionRule => ({
  id,
  description,
  severity,
});

const EXPECT: CacheExpect = { projectRoot: '/game', adapterId: 'eratw', fingerprint: 'fp' };

describe('lintExpect：四路判据缺一即不缓存', () => {
  const base = { index: { fingerprint: 'erb' }, project: project('csv'), rules: [rule('a'), rule('b')] };

  it('四路齐 ⇒ 出判据', () => {
    const e = lintExpect(base);
    expect(e).not.toBeNull();
    expect(e!.projectRoot).toBe('/game');
    expect(e!.adapterId).toBe('eratw');
  });

  it('ERB 指纹 / adapter 输入摘要 / 规则清单 任一缺失 ⇒ null', () => {
    expect(lintExpect({ ...base, index: { fingerprint: null } })).toBeNull();
    expect(lintExpect({ ...base, project: project() })).toBeNull();
    expect(lintExpect({ ...base, rules: [] })).toBeNull();
  });

  it('增删规则 / 改级别 / 改描述 ⇒ 判据变', () => {
    const a = lintExpect(base)!;
    expect(lintExpect({ ...base, rules: [rule('a'), rule('b'), rule('c')] })!.fingerprint).not.toBe(a.fingerprint);
    expect(lintExpect({ ...base, rules: [rule('a', 'error'), rule('b')] })!.fingerprint).not.toBe(a.fingerprint);
    expect(lintExpect({ ...base, rules: [rule('a', 'warning', '改了说法'), rule('b')] })!.fingerprint).not.toBe(a.fingerprint);
  });

  it('规则清单顺序无关（装配顺序不该换判据）', () => {
    expect(lintExpect({ ...base, rules: [rule('b'), rule('a')] })!.fingerprint).toBe(lintExpect(base)!.fingerprint);
  });

  it('CSV 输入摘要变 ⇒ 判据变（规则会遍历 charaIndex）', () => {
    const a = lintExpect(base)!;
    expect(lintExpect({ ...base, project: project('csv2') })!.fingerprint).not.toBe(a.fingerprint);
  });

  it('rulesDigest 对空清单也有确定值', () => {
    expect(rulesDigest([])).toBe(rulesDigest([]));
    expect(rulesDigest([rule('x')])).not.toBe(rulesDigest([]));
  });
});

describe('校验报告的编解码', () => {
  it('往返等价（issues / counts / failedRules / 计时都原样）', () => {
    const src = report();
    const back = decodeReport(JSON.parse(JSON.stringify(encodeReport({ report: src, expect: EXPECT }))), EXPECT);
    expect(back).toEqual(src);
  });

  it('格式版本 / 项目根 / adapterId / 指纹 任一不符 ⇒ null', () => {
    const raw = JSON.parse(JSON.stringify(encodeReport({ report: report(), expect: EXPECT })));
    expect(decodeReport({ ...raw, format: raw.format + 1 }, EXPECT)).toBeNull();
    expect(decodeReport({ ...raw, projectRoot: '/other' }, EXPECT)).toBeNull();
    expect(decodeReport({ ...raw, adapterId: 'erak' }, EXPECT)).toBeNull();
    expect(decodeReport({ ...raw, fingerprint: 'other' }, EXPECT)).toBeNull();
  });

  it('报告结构损坏 ⇒ null（非对象 / issues 非数组 / 条目字段错 / counts 缺）', () => {
    const enc = () => JSON.parse(JSON.stringify(encodeReport({ report: report(), expect: EXPECT }))) as Record<string, unknown>;
    expect(decodeReport(undefined, EXPECT)).toBeNull();
    expect(decodeReport('nope', EXPECT)).toBeNull();
    expect(decodeReport({ ...enc(), report: undefined }, EXPECT)).toBeNull();
    expect(decodeReport({ ...enc(), report: { ...report(), issues: null } }, EXPECT)).toBeNull();
    expect(decodeReport({ ...enc(), report: { ...report(), issues: [{ ruleId: 'x' }] } }, EXPECT)).toBeNull();
    expect(
      decodeReport({ ...enc(), report: { ...report(), issues: [{ ruleId: 'x', message: 'm', severity: 'fatal' }] } }, EXPECT),
    ).toBeNull();
    expect(decodeReport({ ...enc(), report: { ...report(), counts: { error: 1 } } }, EXPECT)).toBeNull();
    expect(decodeReport({ ...enc(), report: { ...report(), failedRules: undefined } }, EXPECT)).toBeNull();
  });

  it('带 failedRules 的旧报告**拒绝命中**：规则抛过错就该让用户看到重算结果', () => {
    const withFailure = report({ failedRules: [{ ruleId: 'a', error: 'boom' }] });
    const encoded = JSON.parse(JSON.stringify(encodeReport({ report: withFailure, expect: EXPECT })));
    expect(decodeReport(encoded, EXPECT)).toBeNull();
  });

  it('零问题是合法结果（干净项目也值得缓存）', () => {
    const clean = report({ issues: [], counts: { error: 0, warning: 0, info: 0 } });
    const back = decodeReport(JSON.parse(JSON.stringify(encodeReport({ report: clean, expect: EXPECT }))), EXPECT);
    expect(back?.issues).toHaveLength(0);
  });

  it('键与格式版本都是安全段且随版本演进', () => {
    expect(LINT_STORE_KEY).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
    expect(LINT_STORE_KEY).toContain(String(LINT_SNAPSHOT_FORMAT));
  });
});
