import { describe, expect, it } from 'vitest';
import {
  declaredCatalog,
  declaredDirectives,
  functionCatalog,
  lowerBound,
  probePrefix,
  uniqueNameFor,
} from '../src/catalog';
import { emptyIndex, fakeIndex } from './fixtures';

/**
 * 名录层的闸（B 线 · IC 批）：排序 + 二分的加速结构必须与"全表 startsWith"**逐位等价**。
 *
 * 为什么值得单独钉：二分写错（边界、比较口径、大小写归一）的表现不是报错，
 * 而是"某些前缀该给候选时不给、某些两条命中时却当成一条命中给了"——后者是**错报**，
 * 正是本包最不该发生的一类事。所以这里拿线性扫描当参照系，而不是手写期望值。
 */

describe('前缀探测与线性扫描等价', () => {
  const index = fakeIndex({
    functions: ['ABL', 'ABL2', 'AB', '增加', '增加羁绊', 'aegi_h', 'Z'],
  });
  const catalog = functionCatalog(index);

  const linear = (prefix: string): string[] => {
    const needle = prefix.toUpperCase();
    return catalog.keys
      .map((key, i) => (key.startsWith(needle) ? catalog.names[i]! : null))
      .filter((v): v is string => v !== null);
  };

  it('归一化（大写）前缀逐个比对，命中集合与线性一致', () => {
    // 空前缀**不在比对面里**：它由下面那条专门的闸判（"还没打字"永远不构成唯一，
    // 与"线性扫一遍等于全表"是两件事，混在同一个循环里会把判据洗掉）
    for (const prefix of ['A', 'AB', 'ABL', 'abl2', 'Z', '增加', '增', '不存在']) {
      expect(probePrefix(catalog, prefix, 99).hits.slice().sort(), `前缀 ${prefix}`).toEqual(
        linear(prefix).slice().sort(),
      );
    }
  });

  it('keys 升序（二分的前提自证）', () => {
    for (let i = 1; i < catalog.keys.length; i++) {
      expect(catalog.keys[i - 1]! <= catalog.keys[i]!).toBe(true);
    }
  });

  it('lowerBound 落在第一个不小于 needle 的下标上（越界=表尾）', () => {
    const keys = ['A', 'C', 'E'];
    expect(lowerBound(keys, 'A')).toBe(0);
    expect(lowerBound(keys, 'B')).toBe(1);
    expect(lowerBound(keys, 'E')).toBe(2);
    expect(lowerBound(keys, 'F')).toBe(3);
    expect(lowerBound(keys, '')).toBe(0);
  });
});

describe('唯一判据', () => {
  const catalog = functionCatalog(
    fakeIndex({ functions: ['M_KOJO_A', 'M_KOJO_B', 'ONLY_ONE'] }),
  );

  it('命中 1 条 ⇒ 给原形名（不是归一化名）', () => {
    expect(uniqueNameFor(catalog, 'ONLY')).toBe('ONLY_ONE');
  });

  it('命中 0 条 ⇒ undefined', () => {
    expect(uniqueNameFor(catalog, 'NOPE')).toBeUndefined();
  });

  it('命中 ≥2 条 ⇒ undefined；`truncated` 只在"还有没数完的"那一边为真', () => {
    expect(uniqueNameFor(catalog, 'M_KOJO_')).toBeUndefined();
    // limit=2 且恰好两条 ⇒ 收满了但**没有**被截断（truncated 说的是"还有第三条没看"）
    const full = probePrefix(catalog, 'M_KOJO_', 2);
    expect(full.hits).toHaveLength(2);
    expect(full.truncated).toBe(false);
    // limit=1 时同一批命中才会记成"截断"
    const capped = probePrefix(catalog, 'M_KOJO_', 1);
    expect(capped.hits).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it('空前缀一律零命中（"还没打字"永远不构成唯一）', () => {
    expect(probePrefix(catalog, '', 5)).toEqual({ hits: [], truncated: false });
    expect(uniqueNameFor(catalog, '')).toBeUndefined();
  });
});

describe('声明名录与指令派生集', () => {
  it('按归一化名去重、保留首个原形（同名跨文件声明是同一枚变量）', () => {
    const catalog = declaredCatalog(
      fakeIndex({ dims: [['GOOD', 'DIM'], ['good2', 'DIMS'], ['GOOD', 'DIMSTR']]}),
    );
    expect(catalog.keys).toEqual(['GOOD', 'GOOD2']);
    expect(catalog.names).toEqual(['GOOD', 'good2']);
  });

  it('指令集合从 dims 派生（本包不写 `#DIM` 词表）', () => {
    const index = fakeIndex({ dims: [['A', 'dim'], ['B', 'DIMS'], ['C', 'DIMSTR']] });
    expect([...declaredDirectives(index)].sort()).toEqual(['DIM', 'DIMS', 'DIMSTR']);
  });

  it('空索引 ⇒ 两份名录都是空的（不抛、不回落任何默认词表）', () => {
    expect(functionCatalog(emptyIndex()).keys).toEqual([]);
    expect(declaredCatalog(emptyIndex()).keys).toEqual([]);
    expect(declaredDirectives(emptyIndex()).size).toBe(0);
  });
});

describe('缓存随索引对象失效（不许拿上一棵树的名录回答这一轮）', () => {
  it('同一个索引对象反复取 ⇒ 同一份数组（WeakMap 命中）', () => {
    const index = fakeIndex({ functions: ['A'] });
    expect(functionCatalog(index)).toBe(functionCatalog(index));
  });

  it('换了索引对象 ⇒ 换一份（构建判据只认对象身份，与 erb-parser 的索引换代同口径）', () => {
    const a = fakeIndex({ functions: ['A'] });
    const b = fakeIndex({ functions: ['B'] });
    expect(functionCatalog(a).keys).toEqual(['A']);
    expect(functionCatalog(b).keys).toEqual(['B']);
  });
});
