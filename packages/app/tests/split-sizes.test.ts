import { describe, expect, it } from 'vitest';
import {
  EMPTY_SPLIT_SIZES,
  SPLIT_MIN_RATIO,
  alignSplitSizes,
  equalSplitSizes,
  groupShareOf,
  sanitizeSplitSizes,
  splitFlexOf,
  splitSizesEqual,
  splitSizesFromWidths,
} from '../src/ui/editor-groups';

/**
 * 分屏比例（WS-06）的判据。
 *
 * 编码口径：长度 = 组数 - 1，`sizes[i]` = 第 i 组的份额，**末组吃剩余**。
 * 三个消费方（session-store / App / ProjectView）共用这一个模块，所以这里把
 * 「往返 / 损坏 / 夹取 / 长度不符 / 像素换算 / 均分兜底」逐条钉死。
 */

describe('equalSplitSizes / 边界', () => {
  it('单组没有分隔条 → 恒等空数组（引用恒定）', () => {
    expect(equalSplitSizes(1)).toBe(EMPTY_SPLIT_SIZES);
    expect(equalSplitSizes(0)).toBe(EMPTY_SPLIT_SIZES);
    expect(alignSplitSizes([0.5], 1)).toBe(EMPTY_SPLIT_SIZES);
    expect(alignSplitSizes(null, 1)).toBe(EMPTY_SPLIT_SIZES);
  });

  it('n 组 → n-1 条均分份额', () => {
    expect(equalSplitSizes(2)).toEqual([0.5]);
    expect(equalSplitSizes(3)).toEqual([1 / 3, 1 / 3]);
    expect(equalSplitSizes(4)).toEqual([0.25, 0.25, 0.25]);
  });
});

describe('sanitizeSplitSizes（损坏容忍 + 夹取）', () => {
  it('合法份额原样（归一）返回', () => {
    expect(sanitizeSplitSizes([0.3], 2)).toEqual([0.3]);
    const three = sanitizeSplitSizes([0.4, 0.3], 3)!;
    expect(three).toHaveLength(2);
    expect(three[0]).toBeCloseTo(0.4);
    expect(three[1]).toBeCloseTo(0.3);
  });

  it('长度不符 / 非数组 / 含非法条目 → null（一处不合法整份丢弃）', () => {
    expect(sanitizeSplitSizes([0.5, 0.5], 2)).toBeNull(); // 长度不符
    expect(sanitizeSplitSizes([], 2)).toBeNull(); // 长度不符（两组至少要一条）
    expect(sanitizeSplitSizes('x', 2)).toBeNull();
    expect(sanitizeSplitSizes(null, 2)).toBeNull();
    expect(sanitizeSplitSizes([0], 2)).toBeNull(); // 非正数
    expect(sanitizeSplitSizes([-0.2], 2)).toBeNull();
    expect(sanitizeSplitSizes([Number.NaN], 2)).toBeNull();
    expect(sanitizeSplitSizes([Number.POSITIVE_INFINITY], 2)).toBeNull();
    expect(sanitizeSplitSizes([0.5], 1)).toBeNull(); // 单组没有分隔条
  });

  it('夹取：过小的份额抬到下限、过大的压到上限，且末组仍留得住', () => {
    expect(sanitizeSplitSizes([0.001], 2)).toEqual([SPLIT_MIN_RATIO]);
    expect(sanitizeSplitSizes([0.999], 2)).toEqual([1 - SPLIT_MIN_RATIO]);
    // 三条份额都违规 → 每条先夹，再按"末组至少留一成"的预算等比缩回
    const fixed = sanitizeSplitSizes([0.9, 0.9], 3)!;
    const sum = fixed.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1 - SPLIT_MIN_RATIO);
    expect(1 - sum).toBeGreaterThanOrEqual(SPLIT_MIN_RATIO - 1e-9);
  });
});

describe('alignSplitSizes（组数变化时对齐）', () => {
  it('长度对得上 → 沿用（引用也沿用，不制造无谓 setState）', () => {
    const prev = [0.7];
    expect(alignSplitSizes(prev, 2)).toBe(prev);
    const three = [0.2, 0.3];
    expect(alignSplitSizes(three, 3)).toBe(three);
  });

  it('长度对不上（拆分 / 关组）→ 整份退回均分，不把旧比例套到新组', () => {
    expect(alignSplitSizes([0.7], 3)).toEqual(equalSplitSizes(3));
    expect(alignSplitSizes([0.2, 0.3], 2)).toEqual(equalSplitSizes(2));
    expect(alignSplitSizes(undefined, 4)).toEqual(equalSplitSizes(4));
    expect(alignSplitSizes(null, 2)).toEqual(equalSplitSizes(2));
    // 长度对上但值违规（如盘上损坏）→ 先归一，仍在同长度上
    const dirty = alignSplitSizes([5], 2);
    expect(dirty).toEqual([1 - SPLIT_MIN_RATIO]);
  });
});

describe('splitSizesFromWidths（拖拽落定：像素 → 份额）', () => {
  it('按实际宽占比归一，最后一组吃剩余', () => {
    expect(splitSizesFromWidths([700, 300])).toEqual([0.7]);
    const three = splitSizesFromWidths([400, 300, 300]);
    expect(three).toHaveLength(2);
    expect(three[0]).toBeCloseTo(0.4);
    expect(three[1]).toBeCloseTo(0.3);
    expect(1 - (three[0]! + three[1]!)).toBeCloseTo(0.3);
  });

  it('组数不足 / 全量不出来 → 空数组（调用方保持现状）', () => {
    expect(splitSizesFromWidths([])).toBe(EMPTY_SPLIT_SIZES);
    expect(splitSizesFromWidths([800])).toBe(EMPTY_SPLIT_SIZES);
    expect(splitSizesFromWidths([0, 0])).toBe(EMPTY_SPLIT_SIZES);
  });

  it('极端占比被夹到区间内（拖到快没了也不写出非法份额）', () => {
    const next = splitSizesFromWidths([1, 1000]);
    expect(next[0]).toBe(SPLIT_MIN_RATIO);
  });
});

describe('groupShareOf / splitFlexOf / splitSizesEqual', () => {
  it('组份额：前 n-1 组取份额，末组取剩余；越界给均分兜底', () => {
    expect(groupShareOf([0.6], 2, 0)).toBeCloseTo(0.6);
    expect(groupShareOf([0.6], 2, 1)).toBeCloseTo(0.4);
    const three = groupShareOf([0.4, 0.3], 3, 2);
    expect(three).toBeCloseTo(0.3);
    // 缺省（未给比例）= 均分
    expect(groupShareOf(undefined, 3, 0)).toBeCloseTo(1 / 3);
  });

  it('flex 简写是百分比（渲染侧直接当 flex-basis 用）', () => {
    expect(splitFlexOf(0.5)).toBe('1 1 50.0000%');
    expect(splitFlexOf(0)).toBe('1 1 0.0000%');
    expect(splitFlexOf(Number.NaN)).toBe('1 1 0.0000%');
  });

  it('值等价判据：长度 + 容差（拖回原位不触发 setState）', () => {
    expect(splitSizesEqual([0.5], [0.5])).toBe(true);
    expect(splitSizesEqual([0.5], [0.5000001])).toBe(true);
    expect(splitSizesEqual([0.5], [0.51])).toBe(false);
    expect(splitSizesEqual([], undefined)).toBe(true);
    expect(splitSizesEqual([0.5], [0.2, 0.3])).toBe(false);
  });
});
