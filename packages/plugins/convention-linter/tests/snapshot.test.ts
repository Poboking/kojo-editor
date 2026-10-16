import { describe, expect, it } from 'vitest';
import type { CacheExpect, ConventionIssue, ConventionRule, GameProject } from '@kojo/plugin-api';
import {
  LINT_SNAPSHOT_FORMAT,
  LINT_STORE_KEY,
  decodeCache,
  encodeCache,
  lintExpect,
  rulesDigest,
  type LintCache,
} from '../src/snapshot';

const EXPECT: CacheExpect = { projectRoot: '/p', adapterId: 'eratw', fingerprint: 'global-digest-1' };

const issue = (ruleId: string, path: string, message = 'msg'): ConventionIssue => ({
  ruleId,
  severity: 'warning',
  message,
  filePath: path,
  line: 3,
  key: `${ruleId}|${path}`,
});

const cache = (): LintCache => ({
  erbFingerprint: 'erbfp-1',
  projectResults: { 'g.proj': [issue('g.proj', '/p/cross.ERB', '跨文件结论')] },
  buckets: {
    'g.file': {
      '/p/a.ERB': { mtimeMs: 100, issues: [issue('g.file', '/p/a.ERB')] },
      // 判过了、这个文件没问题 —— 空桶必须能存回来自我复用
      '/p/b.ERB': { mtimeMs: 200, issues: [] },
      // 取不到 stat 的文件：null 要原样往返，不能编造成数字
      '/p/noStat.ERB': { mtimeMs: null, issues: [issue('g.file', '/p/noStat.ERB')] },
    },
  },
});

const roundTrip = (src = cache(), expect = EXPECT) => {
  const payload = encodeCache({ cache: src, expect, savedAt: 999 });
  return { payload, back: decodeCache(JSON.parse(JSON.stringify(payload)), expect) };
};

describe('v2 三层判据编解码', () => {
  it('往返等价：整项目结论 + 逐文件桶（含空桶与 null mtime）逐字段相等', () => {
    const src = cache();
    const { back } = roundTrip(src);
    expect(back).not.toBeNull();
    expect(back!.erbFingerprint).toBe(src.erbFingerprint);
    expect(back!.projectResults).toEqual(src.projectResults);
    expect(back!.buckets).toEqual(src.buckets);
  });

  it('空结论的桶编成单元素元组（省盘），还原仍是 `issues: []` 而不是缺键', () => {
    const { payload, back } = roundTrip();
    const rawBuckets = (payload.buckets as Record<string, Record<string, unknown[]>>)['g.file'];
    expect(rawBuckets!['/p/b.ERB']).toEqual([200]); // 没有 issues 槽
    expect(back!.buckets['g.file']!['/p/b.ERB']!.issues).toEqual([]);
  });

  it('mtime 为 null 原样往返（判据不可得的保守信号不能被编造成数字）', () => {
    const { back } = roundTrip();
    expect(back!.buckets['g.file']!['/p/noStat.ERB']!.mtimeMs).toBeNull();
  });

  it('整项目指纹**不是**全局判据：它变了 decode 仍成功（判不判由引擎按层决定）', () => {
    const src = { ...cache(), erbFingerprint: 'erbfp-OTHER' };
    const { back } = roundTrip(src);
    expect(back!.erbFingerprint).toBe('erbfp-OTHER');
  });
});

describe('全局判据 fail-closed', () => {
  const base = () => encodeCache({ cache: cache(), expect: EXPECT }) as unknown as Record<string, unknown>;

  it('格式版本 / 项目根 / 适配器 / expectFingerprint 任一不符 ⇒ null', () => {
    expect(decodeCache({ ...base(), format: (base().format as number) + 1 }, EXPECT)).toBeNull();
    expect(decodeCache(base(), { ...EXPECT, projectRoot: '/other' })).toBeNull();
    expect(decodeCache(base(), { ...EXPECT, adapterId: 'erak' })).toBeNull();
    // 改过 CSV（inputDigest 变）或改过规则清单 ⇒ 全局判据变 ⇒ 整包作废
    expect(decodeCache(base(), { ...EXPECT, fingerprint: 'global-digest-2' })).toBeNull();
  });

  it('结构损坏 ⇒ null（缺 project / 缺 buckets / 桶元数 / mtime 类型 / issue 形状）', () => {
    expect(decodeCache(undefined, EXPECT)).toBeNull();
    expect(decodeCache('nope', EXPECT)).toBeNull();
    expect(decodeCache({ ...base(), project: null }, EXPECT)).toBeNull();
    expect(decodeCache({ ...base(), buckets: null }, EXPECT)).toBeNull();
    expect(decodeCache({ ...base(), erbFingerprint: 42 }, EXPECT)).toBeNull();
    const badBucket = (tuple: unknown) => ({
      ...(base() as Record<string, unknown>),
      buckets: { 'g.file': { '/p/a.ERB': tuple } },
    });
    expect(decodeCache(badBucket([]), EXPECT)).toBeNull(); // 元数过少
    expect(decodeCache(badBucket([1, 2, 3]), EXPECT)).toBeNull(); // 元数过多
    expect(decodeCache(badBucket(['100']), EXPECT)).toBeNull(); // mtime 类型
    expect(decodeCache(badBucket([100, 'nope']), EXPECT)).toBeNull(); // issues 非数组
    expect(decodeCache(badBucket([100, [{ ruleId: 'x' }]]), EXPECT)).toBeNull(); // issue 形状
  });

  it('存储键是安全段（固定槽位名；版本在 payload 里，换格式不留孤儿）', () => {
    expect(LINT_STORE_KEY).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
    expect(LINT_SNAPSHOT_FORMAT).toBe(3);
  });
});

describe('rulesDigest：规则清单摘要必须含 scope', () => {
  const rule = (over: Partial<ConventionRule>): ConventionRule => ({
    id: 'g.a',
    description: 'd',
    severity: 'warning',
    ...over,
  });

  it('同 id/级别/描述的规则，改判 scope ⇒ 摘要变（旧桶不能接着用）', () => {
    const asProject = rulesDigest([rule({})]);
    const asFile = rulesDigest([rule({ scope: 'file', checkFile: async () => [] })]);
    expect(asProject).not.toBe(asFile);
  });

  it('顺序无关（折叠）；改级别/描述也变摘要', () => {
    const a = rule({ id: 'g.a' });
    const b = rule({ id: 'g.b' });
    expect(rulesDigest([a, b])).toBe(rulesDigest([b, a]));
    expect(rulesDigest([a])).not.toBe(rulesDigest([{ ...a, severity: 'error' }]));
    expect(rulesDigest([a])).not.toBe(rulesDigest([{ ...a, description: '改过的说明' }]));
  });

  it('规则集合为空 ⇒ digest 为 null ⇒ lintExpect 拒绝出判据（没有规则就没什么可缓存）', () => {
    const project = { rootDir: '/p', adapterId: 'eratw', inputDigest: 'csv-1' } as unknown as GameProject;
    expect(lintExpect({ project, rules: [] })).toBeNull();
  });

  it('lintExpect：inputDigest 齐 ⇒ 出判据；缺 ⇒ null（不缓存）', () => {
    const rules = [rule({})];
    expect(lintExpect({ project: { rootDir: '/p', adapterId: 'eratw', inputDigest: 'csv-1' }, rules })).toEqual({
      projectRoot: '/p',
      adapterId: 'eratw',
      fingerprint: expect.any(String) as unknown as string,
    });
    expect(lintExpect({ project: { rootDir: '/p', adapterId: 'eratw' } as unknown as GameProject, rules })).toBeNull();
    expect(lintExpect({ project: { rootDir: '/p', adapterId: 'eratw', inputDigest: '' }, rules })).toBeNull();
  });

  it('inputDigest 变 ⇒ 判据变（改 CSV 描述不能继续吐旧结论）', () => {
    const rules = [rule({})];
    const p = (digest: string) => ({ rootDir: '/p', adapterId: 'eratw', inputDigest: digest }) as unknown as GameProject;
    expect(lintExpect({ project: p('csv-1'), rules })!.fingerprint).not.toBe(
      lintExpect({ project: p('csv-2'), rules })!.fingerprint,
    );
  });
});
