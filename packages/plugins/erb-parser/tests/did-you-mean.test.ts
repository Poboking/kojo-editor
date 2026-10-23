import { describe, expect, it } from 'vitest';
import { editDistance, suggestNames } from '../src/did-you-mean';

/**
 * did-you-mean 纯函数单测：
 * - 距离本体（码点级、阈值剪枝）；
 * - 候选挑选与**确定性排序**（距离 → 码元序）；
 * - 大小写不敏感与"同名不推荐"。
 */
describe('editDistance · 码点级 Levenshtein', () => {
  it('相同 / 单字替换 / 增删：基础读数', () => {
    expect(editDistance('ABC', 'ABC')).toBe(0);
    expect(editDistance('ABC', 'ABD')).toBe(1);
    expect(editDistance('ABC', 'AXCD')).toBe(2);
    expect(editDistance('ABC', 'AB')).toBe(1);
    expect(editDistance('', 'AB')).toBe(2);
    expect(editDistance('AB', '')).toBe(2);
  });

  it('CJK 按一个字算（不被代理对 / 码元切分虚增）', () => {
    expect(editDistance('猫猫', '猫')).toBe(1);
    expect(editDistance('未定義', '未定义')).toBe(1);
  });

  it('超过阈值提前收工：返回值只保证 > limit', () => {
    expect(editDistance('ABCDEF', '123456', 2)).toBeGreaterThan(2);
    expect(editDistance('A', 'ABCDEF', 2)).toBeGreaterThan(2);
  });
});

describe('suggestNames · 候选与确定性排序', () => {
  it('距离 ≤ 2 的近名保留；超过阈值不出现', () => {
    expect(suggestNames('DECLARD', ['DECLARED', 'OTHER_NAME'])).toEqual(['DECLARED']);
    expect(suggestNames('ABC', ['XYZ'])).toEqual([]);
  });

  it('大小写不敏感；返回候选池里的原形', () => {
    expect(suggestNames('declard', ['DECLARED'])).toEqual(['DECLARED']);
    expect(suggestNames('Declared', ['declared'])).toEqual([]); // 同名（仅大小写差）不是建议
  });

  it('同距离按码元序升序；打乱输入顺序结果不变（确定性）', () => {
    const candidates = ['ABCF', 'ABCE', 'ABCG'];
    const expected = ['ABCE', 'ABCF', 'ABCG'];
    expect(suggestNames('ABCD', candidates)).toEqual(expected);
    expect(suggestNames('ABCD', [...candidates].reverse())).toEqual(expected);
  });

  it('距离优先于码元序：更近的候选排前面', () => {
    expect(suggestNames('ABCD', ['ABXY', 'ABCDE'])).toEqual(['ABCDE', 'ABXY']);
  });

  it('limit 截断；limit=0 不给候选', () => {
    expect(suggestNames('ABCD', ['ABCE', 'ABCF'], { limit: 1 })).toEqual(['ABCE']);
    expect(suggestNames('ABCD', ['ABCE'], { limit: 0 })).toEqual([]);
  });

  it('大小写重复候选只留首个原形', () => {
    expect(suggestNames('ABCD', ['ABCE', 'abce'])).toEqual(['ABCE']);
  });

  it('两字以内短名只认单字之差（`P1` 不推荐 `OR`）', () => {
    expect(suggestNames('P1', ['OR'])).toEqual([]);
    expect(suggestNames('P1', ['P2'])).toEqual(['P2']);
  });

  it('空名 / 空池 ⇒ 空数组', () => {
    expect(suggestNames('', ['ABC'])).toEqual([]);
    expect(suggestNames('ABC', [])).toEqual([]);
  });
});
