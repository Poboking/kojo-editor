/**
 * 快照落盘的**字典判等口径**与**派生键守门**（2026-10-18 性能批）。
 *
 * 这两条都是"改了实现但产出必须一字不动"的钉子：
 * - 字典键从 `JSON.stringify([name, index, resolvedIndex, description])` 换成拼接键，
 *   判等**集合**必须与旧口径逐字相同（含 `0` vs `'0'`、`null` vs `undefined` 这些边界）；
 * - 派生键守门（`key === dependencyKey(name, indices)`）只对本模块还原出来的依赖豁免，
 *   新抽取依赖一条不漏——破了前提仍旧"宁可不缓存"。
 */
import { describe, expect, it } from 'vitest';
import type { ErbIndex, FunctionConditions, GameProject, StateDependency, VariableInfo } from '@kojo/plugin-api';
import { dependencyKey } from '@kojo/plugin-api';
import { decodeBuckets, encodeBuckets, extractExpect, type FileBucket } from '../src/snapshot';

const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'key-1' } as unknown as GameProject;
const EXPECT = extractExpect({ project })!;

function dep(name: string, indices: string[], schema?: VariableInfo): StateDependency {
  return {
    key: dependencyKey({ name, indices }),
    name,
    indices,
    count: 1,
    comparisons: [],
    firstLine: 2,
    ...(schema ? { schema } : {}),
  };
}

function bucketOf(deps: StateDependency[]): Map<string, FileBucket> {
  const cond: FunctionConditions = {
    normalizedName: 'FN_X',
    filePath: '/f/a.ERB',
    startLine: 1,
    predicateCount: deps.length,
    unparsedCount: 0,
    dependencies: deps,
  };
  return new Map([
    [
      '/f/a.ERB',
      {
        mtimeMs: 1,
        size: 10,
        stats: { functions: 1, functionsWithDeps: 1, predicates: deps.length, unparsed: 0, dependencies: deps.length },
        conds: [cond],
      },
    ],
  ]);
}

const schemaCount = (buckets: Map<string, FileBucket>): number =>
  (encodeBuckets({ buckets, expect: EXPECT }) as unknown as { schemas: unknown[] }).schemas.length;

describe('字典判等口径（拼接键 ≡ 旧 stringify 键）', () => {
  it('四字段相同 ⇒ 共用一个字典槽（source / bits 不参与判等，与改前一致）', () => {
    const a: VariableInfo = { name: 'CFLAG', index: 2, description: '好感度' };
    const b: VariableInfo = { name: 'CFLAG', index: 2, description: '好感度', source: 'append' };
    expect(schemaCount(bucketOf([dep('CFLAG', ['2'], a), dep('CFLAG', ['2'], b)]))).toBe(1);
  });

  it('边界逐条分开：0 / "0" / null / undefined 不互相吞（旧口径同样是这四个不同的 JSON 形）', () => {
    const cases: VariableInfo[] = [
      { name: 'CFLAG', index: 0 },
      { name: 'CFLAG', index: '0' },
      { name: 'CFLAG', index: undefined },
      { name: 'CFLAG', description: '' },
      { name: 'CFLAG', description: 'x' },
    ];
    // [index:0] / [index:'0'] / [index:null] / [index:null,description:''] / [..,'x']
    expect(schemaCount(bucketOf(cases.map((s) => dep('CFLAG', [], s))))).toBe(5);
  });

  it('无索引依赖不写 schema 键：盘上 -1，还原后对象里也没有 schema 属性', () => {
    const payload = encodeBuckets({ buckets: bucketOf([dep('LOCAL', [])]), expect: EXPECT });
    const restored = decodeBuckets(payload, EXPECT)!;
    const d = restored.buckets['/f/a.ERB']!.conds[0]!.dependencies[0]!;
    expect('schema' in d).toBe(false);
    expect(d.key).toBe('LOCAL');
  });

  it('复用桶再编码：字典与名字表条数逐字不变（还原 → 编码是幂等的）', () => {
    const buckets = bucketOf([
      dep('CFLAG', ['2'], { name: 'CFLAG', index: 2, description: '好感度' }),
      dep('CFLAG', ['2'], { name: 'CFLAG', index: 2, description: '好感度' }),
      dep('TALENT', ['恋慕'], { name: 'TALENT', index: '恋慕', description: '恋慕', resolvedIndex: 3 }),
    ]);
    const once = encodeBuckets({ buckets, expect: EXPECT });
    const twice = encodeBuckets({ buckets: new Map(Object.entries(decodeBuckets(once, EXPECT)!.buckets)), expect: EXPECT });
    expect(twice.schemas).toEqual(once.schemas);
    expect(twice.names).toEqual(once.names);
    expect(JSON.stringify(twice.buckets)).toBe(JSON.stringify(once.buckets));
  });
});

describe('派生键守门的豁免面', () => {
  it('新抽取依赖：key 与派生值不符 ⇒ 整包拒绝编码（一条没放松）', () => {
    const bad = bucketOf([{ ...dep('CFLAG', ['2']), key: 'CFLAG:9' }]);
    expect(() => encodeBuckets({ buckets: bad, expect: EXPECT })).toThrow(/dependencyKey/);
  });

  it('本模块还原出来的依赖：key 由还原现场算 ⇒ 免复验，编码照过且产出等价', () => {
    const buckets = bucketOf([dep('CFLAG', ['2']), dep('LOCAL', [])]);
    const payload = encodeBuckets({ buckets, expect: EXPECT });
    const reused = new Map(Object.entries(decodeBuckets(payload, EXPECT)!.buckets));
    // 读一次 dependencies（触发还原）后再编码——热路径（改几棵 ⇒ 回写整包）就是这一形态
    const again = encodeBuckets({ buckets: reused, expect: EXPECT });
    expect(JSON.stringify(again.buckets)).toBe(JSON.stringify(payload.buckets));
    const d0 = reused.get('/f/a.ERB')!.conds[0]!.dependencies[0]!;
    expect(d0.key).toBe(dependencyKey({ name: d0.name, indices: d0.indices }));
  });

  it('守门不是恒真：把还原集合里的依赖换成手搭对象，仍然当场抛', () => {
    const buckets = bucketOf([dep('CFLAG', ['2'])]);
    const payload = encodeBuckets({ buckets, expect: EXPECT });
    const reused = decodeBuckets(payload, EXPECT)!.buckets;
    const hand = bucketOf([{ key: 'WRONG', name: 'CFLAG', indices: ['2'], count: 1, comparisons: [], firstLine: 2 }]);
    // 混合形态（复用桶 + 新算桶）里，新算那一桶仍受全量复验
    const merged = new Map([...Object.entries(reused), ...hand]);
    expect(() => encodeBuckets({ buckets: merged, expect: EXPECT })).toThrow(/dependencyKey/);
  });
});

/** 类型占位：ErbIndex 在本文件只做形状引用（避免 unused import） */
export type _IndexRef = ErbIndex;
