import { describe, expect, it } from 'vitest';
import type { CacheExpect, ConditionIndex, FunctionConditions, StateDependency } from '@kojo/plugin-api';
import {
  EXTRACT_SNAPSHOT_FORMAT,
  EXTRACT_STORE_KEY,
  decodeConditionIndex,
  encodeConditionIndex,
  extractExpect,
} from '../src/snapshot';

const dep = (key: string, count: number, schemaDesc: string): StateDependency => ({
  key,
  name: key.split(':')[0]!,
  indices: key.includes(':') ? key.split(':').slice(1) : [],
  count,
  comparisons: [{ op: '>=', value: 500, text: '500' }],
  firstLine: 12,
  schema: { name: key.split(':')[0]!, index: 2, description: schemaDesc },
});

const cond = (name: string, path: string, d: StateDependency[]): FunctionConditions => ({
  normalizedName: name,
  filePath: path,
  startLine: 10,
  predicateCount: 3,
  unparsedCount: 1,
  dependencies: d,
});

const index = (): ConditionIndex => ({
  projectRoot: 'D:/game',
  finishedAt: 111,
  durationMs: 11300,
  byFunction: new Map<string, FunctionConditions>([
    ['M_KOJO_K1_A', cond('M_KOJO_K1_A', 'D:/game/k1.ERB', [dep('CFLAG:2', 2, '好感度'), dep('LOCAL', 1, '好感度')])],
    ['M_KOJO_K1_B', cond('M_KOJO_K1_B', 'D:/game/k1.ERB', [dep('TALENT:恋慕', 5, '恋慕')])],
    ['M_KOJO_K2_C', cond('M_KOJO_K2_C', 'D:/game/k2.ERB', [])],
    ['M_KOJO_K2_D', cond('M_KOJO_K2_D', 'D:/game/k2.ERB', [dep('CFLAG:2', 7, '好感度')])],
  ]),
  stats: { functions: 95333, functionsWithDeps: 31609, predicates: 493712, unparsed: 187, dependencies: 164910 },
});

const EXPECT: CacheExpect = { projectRoot: 'D:/game', adapterId: 'eratw', fingerprint: 'aaaaaaaaaaaaaa' };

const roundTrip = (idx: ConditionIndex, expect: CacheExpect = EXPECT): ConditionIndex | null =>
  decodeConditionIndex(JSON.parse(JSON.stringify(encodeConditionIndex({ index: idx, expect }))), expect);

const stored = (idx: ConditionIndex = index(), expect: CacheExpect = EXPECT) =>
  encodeConditionIndex({ index: idx, expect });

describe('v2 编解码（字典 + 元组，语义零变化）', () => {
  it('往返等价：Map 内容与键序、依赖明细、schema 标签、计时与 stats 全部一致', () => {
    const src = index();
    const back = roundTrip(src)!;
    expect([...back.byFunction.keys()]).toEqual([...src.byFunction.keys()]);
    for (const [k, v] of src.byFunction) expect(back.byFunction.get(k)).toEqual(v);
    expect(back.stats).toEqual(src.stats);
    expect(back.durationMs).toBe(11300);
    expect(back.projectRoot).toBe('D:/game');
  });

  it('派生数据被回填：normalizedName = 键、filePath 走文件字典', () => {
    const s = stored();
    expect(s.files).toEqual(['D:/game/k1.ERB', 'D:/game/k2.ERB']);
    // 值里不再写 filePath / normalizedName（由下标与键还原）
    expect(JSON.stringify(s.entries[0])).not.toContain('D:/game/k1.ERB');
    const back = roundTrip(index())!;
    expect(back.byFunction.get('M_KOJO_K2_D')!.filePath).toBe('D:/game/k2.ERB');
    expect(back.byFunction.get('M_KOJO_K2_D')!.normalizedName).toBe('M_KOJO_K2_D');
  });

  it('schema 去重表：重复标签只存一份，还原后仍指向等值对象', () => {
    const s = stored();
    // 4 条带 schema 的依赖里，CFLAG:2「好感度」出现两次 ⇒ 字典去重后只剩 3 种
    expect(s.schemas).toHaveLength(3);
    const back = roundTrip(index())!;
    expect(back.byFunction.get('M_KOJO_K1_A')!.dependencies[0]!.schema?.description).toBe('好感度');
    expect(back.byFunction.get('M_KOJO_K2_D')!.dependencies[0]!.schema?.description).toBe('好感度');
    // 还原后两处仍指向字典里同一个对象（语义等价由 toEqual 那条测试整体钉住）
    expect(back.byFunction.get('M_KOJO_K2_D')!.dependencies[0]!.schema).toEqual(
      back.byFunction.get('M_KOJO_K1_A')!.dependencies[0]!.schema,
    );
  });

  it('无 schema 的依赖用 -1 表示，还原后字段缺省（不伪造 undefined 键）', () => {
    const idx = index();
    idx.byFunction.set('NO_SCHEMA', {
      normalizedName: 'NO_SCHEMA',
      filePath: 'D:/game/k3.ERB',
      startLine: 1,
      predicateCount: 1,
      unparsedCount: 0,
      dependencies: [{ key: 'X', name: 'X', indices: [], count: 1, comparisons: [], firstLine: 1 }],
    });
    const back = roundTrip(idx)!;
    const d = back.byFunction.get('NO_SCHEMA')!.dependencies[0]!;
    expect('schema' in d).toBe(false);
  });

  it('体积确实降下来（重复字典化生效），且解码结果与输入逐字段相等', () => {
    const big = index();
    const many = new Map<string, FunctionConditions>();
    for (let i = 0; i < 400; i++) {
      many.set(`F_${i}`, cond(`F_${i}`, `D:/game/dir/file${Math.floor(i / 4)}.ERB`, [dep('CFLAG:2', i, '好感度')]));
    }
    big.byFunction = many;
    const slim = JSON.stringify(stored(big)).length;
    const fat = JSON.stringify([...many.entries()]).length;
    expect(slim).toBeLessThan(fat * 0.8);
    expect(roundTrip(big)).toEqual(big);
  });

  it('空索引是合法结果（零谓词项目也值得缓存）', () => {
    const empty: ConditionIndex = { ...index(), byFunction: new Map() };
    expect(roundTrip(empty)?.byFunction.size).toBe(0);
  });

  /** 哨兵：元组是位置契约，字段清单变了必须同步编解码并 bump 版本 */
  it('字段清单哨兵（FunctionConditions / StateDependency / VariableInfo 加字段会红）', () => {
    const c = index().byFunction.get('M_KOJO_K1_A')!;
    expect(Object.keys(c).sort()).toEqual([
      'dependencies',
      'filePath',
      'normalizedName',
      'predicateCount',
      'startLine',
      'unparsedCount',
    ]);
    expect(Object.keys(c.dependencies[0]!).sort()).toEqual([
      'comparisons',
      'count',
      'firstLine',
      'indices',
      'key',
      'name',
      'schema',
    ]);
    expect(Object.keys(c.dependencies[0]!.schema!).sort()).toEqual(['description', 'index', 'name']);
  });
});

describe('fail-closed 判据与结构', () => {
  it('格式版本 / 项目根 / adapterId / 指纹 任一不符 ⇒ null', () => {
    const s = stored() as unknown as Record<string, unknown>;
    expect(decodeConditionIndex({ ...s, format: (s.format as number) + 1 }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...s, projectRoot: 'D:/other' }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...s, adapterId: 'erak' }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...s, fingerprint: 'bbbbbbbbbbbbbb' }, EXPECT)).toBeNull();
    expect(decodeConditionIndex(s, { ...EXPECT, fingerprint: 'bbbbbbbbbbbbbb' })).toBeNull();
  });

  it('结构损坏 ⇒ null（非对象 / 字典缺失 / 元数与类型错 / 下标越界）', () => {
    const base = () => stored() as unknown as Record<string, unknown>;
    expect(decodeConditionIndex(undefined, EXPECT)).toBeNull();
    expect(decodeConditionIndex('nope', EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...base(), files: undefined }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...base(), schemas: undefined }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...base(), entries: null }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...base(), stats: undefined }, EXPECT)).toBeNull();
    expect(decodeConditionIndex({ ...base(), entries: [['X']] }, EXPECT)).toBeNull();
    // fileIdx 越界
    expect(decodeConditionIndex({ ...base(), entries: [['X', [99, 1, 1, 1, []]]] }, EXPECT)).toBeNull();
    // 依赖项元数不足
    expect(decodeConditionIndex({ ...base(), entries: [['X', [0, 1, 1, 1, [['a', 'a', [], 1, 1, []]]]]] }, EXPECT)).toBeNull();
    // schemaIdx 越界
    expect(
      decodeConditionIndex({ ...base(), entries: [['X', [0, 1, 1, 1, [['a', 'a', [], 1, 1, [], 99]]]]] }, EXPECT),
    ).toBeNull();
  });

  it('版本不符时调用方删除坏快照的语义：还原为 null 即可驱动该路径', () => {
    const old = { ...stored(), format: 1 } as unknown as Record<string, unknown>;
    expect(decodeConditionIndex(old, EXPECT)).toBeNull(); // 升级后旧 payload 一次读判死，随即被覆盖
  });
});

describe('extractExpect：判据必须同时覆盖 ERB 正文与非 ERB 输入', () => {
  const projOf = (inputDigest?: string) =>
    inputDigest === undefined
      ? { rootDir: 'D:/game', adapterId: 'eratw' }
      : { rootDir: 'D:/game', adapterId: 'eratw', inputDigest };

  it('两路齐 ⇒ 出判据', () => {
    const e = extractExpect({ index: { fingerprint: 'erb-fp' }, project: projOf('csv-fp') });
    expect(e).not.toBeNull();
    expect(e!.projectRoot).toBe('D:/game');
    expect(e!.adapterId).toBe('eratw');
  });

  it('ERB 指纹缺失 ⇒ null', () => {
    for (const fp of [null, undefined, ''] as const) {
      expect(extractExpect({ index: { fingerprint: fp }, project: projOf('csv-fp') })).toBeNull();
    }
  });

  /** 回归钉：变量字典由 CSV 驱动，改一行描述不能还吐旧标签 */
  it('adapter 未声明 inputDigest ⇒ null（判据不全就不缓存）', () => {
    expect(extractExpect({ index: { fingerprint: 'erb-fp' }, project: projOf() })).toBeNull();
  });

  it('ERB 变与 CSV 变是两个独立失效源，任一变化都换判据', () => {
    const base = extractExpect({ index: { fingerprint: 'erb-1' }, project: projOf('csv-1') })!;
    const erbChanged = extractExpect({ index: { fingerprint: 'erb-2' }, project: projOf('csv-1') })!;
    const csvChanged = extractExpect({ index: { fingerprint: 'erb-1' }, project: projOf('csv-2') })!;
    expect(erbChanged.fingerprint).not.toBe(base.fingerprint);
    expect(csvChanged.fingerprint).not.toBe(base.fingerprint);
    expect(erbChanged.fingerprint).not.toBe(csvChanged.fingerprint);
  });

  it('存储键是安全段；格式版本随语义演进', () => {
    expect(EXTRACT_STORE_KEY).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
    expect(EXTRACT_SNAPSHOT_FORMAT).toBe(2); // v1 → v2 是"字典 + 元组"瘦身，语义未变
  });
});
