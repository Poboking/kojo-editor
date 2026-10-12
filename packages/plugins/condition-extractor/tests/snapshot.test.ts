import { describe, expect, it } from 'vitest';
import type { CacheExpect, ConditionIndex, FunctionConditions } from '@kojo/plugin-api';
import { EXTRACT_SNAPSHOT_FORMAT, EXTRACT_STORE_KEY, decodeConditionIndex, encodeConditionIndex } from '../src/snapshot';

const cond = (name: string): FunctionConditions => ({
  normalizedName: name,
  filePath: 'D:/game/M_KOJO_K1.ERB',
  startLine: 10,
  predicateCount: 3,
  unparsedCount: 1,
  dependencies: [
    {
      key: 'CFLAG:2',
      name: 'CFLAG',
      indices: ['2'],
      count: 2,
      comparisons: [{ op: '>=', value: 500, text: '500' }],
      firstLine: 12,
      schema: { name: 'CFLAG', index: 2, description: '好感度' },
    },
  ],
});

const index = (): ConditionIndex => ({
  projectRoot: 'D:/game',
  finishedAt: 111,
  durationMs: 11300,
  byFunction: new Map([
    ['M_KOJO_K1_A', cond('M_KOJO_K1_A')],
    ['M_KOJO_K1_B', cond('M_KOJO_K1_B')],
  ]),
  stats: { functions: 95333, functionsWithDeps: 31609, predicates: 493712, unparsed: 187, dependencies: 4200 },
});

const expect_: CacheExpect = { projectRoot: 'D:/game', adapterId: 'eratw', fingerprint: 'aaaaaaaaaaaaaa' };

const stored = () => encodeConditionIndex({ index: index(), expect: expect_ });

describe('条件抽取结果快照编解码', () => {
  it('往返等价：Map 内容与键序 / stats / 时间 一致', () => {
    const src = index();
    const back = decodeConditionIndex(JSON.parse(JSON.stringify(stored())), expect_);
    expect(back).not.toBeNull();
    expect([...back!.byFunction.keys()]).toEqual([...src.byFunction.keys()]);
    expect(back!.byFunction.get('M_KOJO_K1_B')).toEqual(src.byFunction.get('M_KOJO_K1_B'));
    expect(back!.stats).toEqual(src.stats);
    expect(back!.projectRoot).toBe('D:/game');
    expect(back!.durationMs).toBe(11300);
  });

  it('格式版本不符 ⇒ null（fail-closed，全量重算）', () => {
    expect(decodeConditionIndex({ ...stored(), format: stored().format + 1 }, expect_)).toBeNull();
  });

  it('项目根 / adapterId / 指纹 任一不符 ⇒ null（三重判据缺一不可）', () => {
    const raw = JSON.parse(JSON.stringify(stored()));
    expect(decodeConditionIndex(raw, { ...expect_, projectRoot: 'D:/other' })).toBeNull();
    expect(decodeConditionIndex(raw, { ...expect_, adapterId: 'erak' })).toBeNull();
    expect(decodeConditionIndex(raw, { ...expect_, fingerprint: 'bbbbbbbbbbbbbb' })).toBeNull();
  });

  it('结构损坏（非对象 / entries 形状错 / 条目字段缺 / stats 缺）⇒ null', () => {
    const good = stored();
    expect(decodeConditionIndex(undefined, expect_)).toBeNull();
    expect(decodeConditionIndex('nope', expect_)).toBeNull();
    expect(decodeConditionIndex({ ...good, entries: null }, expect_)).toBeNull();
    expect(decodeConditionIndex({ ...good, entries: [['X', { normalizedName: 'X' }]] }, expect_)).toBeNull();
    expect(decodeConditionIndex({ ...good, entries: [['X', null]] }, expect_)).toBeNull();
    expect(decodeConditionIndex({ ...good, entries: [['X']] }, expect_)).toBeNull();
    expect(decodeConditionIndex({ ...good, stats: undefined }, expect_)).toBeNull();
  });

  it('空 byFunction 是合法结果（零谓词项目也值得缓存）', () => {
    const empty: ConditionIndex = { ...index(), byFunction: new Map() };
    const back = decodeConditionIndex(
      JSON.parse(JSON.stringify(encodeConditionIndex({ index: empty, expect: expect_ }))),
      expect_,
    );
    expect(back?.byFunction.size).toBe(0);
  });

  it('存储键是安全段，且随格式版本演进', () => {
    expect(EXTRACT_STORE_KEY).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
    expect(EXTRACT_STORE_KEY).toContain(String(EXTRACT_SNAPSHOT_FORMAT));
  });
});
