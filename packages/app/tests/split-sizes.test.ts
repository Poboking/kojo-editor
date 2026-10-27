import { describe, expect, it } from 'vitest';
import {
  EMPTY_SPLIT_SIZES,
  SPLIT_KEYBOARD_STEP,
  SPLIT_MIN_RATIO,
  alignSplitSizes,
  equalSplitSizes,
  groupShareOf,
  resizeGroupShare,
  sanitizeSplitSizes,
  splitFlexOf,
  splitSizesEqual,
  splitSizesForKeptGroups,
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

describe('splitSizesForKeptGroups（WS-06 落盘：全组份额 → 会恢复的那些组）', () => {
  // 实机复现过的形态：拆出来的第二/第三组还是空的；`restoreGroups` 会把空组剔掉，
  // 全组份额直接入库会在恢复时对不上长度 ⇒ 比例整份丢掉。这里钉"投影到存活组"。
  const A = ['a'];
  const EMPTY: readonly string[] = [];

  it('全是非空组 ⇒ 原样保留（投影是恒等）', () => {
    expect(splitSizesForKeptGroups([0.2, 0.5], [A, A, A])).toEqual([0.2, 0.5]);
  });

  it('中间一组为空 ⇒ 份额按存活两组的占比归一（空组那格不占预算）', () => {
    // 全组 [0.2, 0.6]（第三组吃剩余 0.2）；存活 = 第 1、3 组 ⇒ 各 0.2，归一 50/50
    const sizes = splitSizesForKeptGroups([0.2, 0.6], [A, EMPTY, A]);
    expect(sizes).toHaveLength(1);
    expect(sizes![0]).toBeCloseTo(0.5);
  });

  it('末组为空（最常见：刚拆出来还没开文件）⇒ 只剩一组，没有可恢复的比例', () => {
    expect(splitSizesForKeptGroups([0.3], [A, EMPTY])).toBeNull();
  });

  it('空值 / 长度不符 / 少于两组 ⇒ null（不写半份比例）', () => {
    expect(splitSizesForKeptGroups(undefined, [A, A])).toBeNull();
    expect(splitSizesForKeptGroups([0.5, 0.2], [A, A])).toBeNull(); // 长度比全组少一截
    expect(splitSizesForKeptGroups([0.5], [A])).toBeNull();
    expect(splitSizesForKeptGroups([0.5], [A, A])).toEqual([0.5]);
  });
});

/* ================= WS-14：键盘调分隔条 ================= */

describe('resizeGroupShare · 键盘调分隔条（WS-14）', () => {
  const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
  /** 末组吃剩余 ⇒ 它的份额 = 1 - Σ */
  const rest = (a: readonly number[]): number => 1 - sum(a);

  it('两组：放大左格 = 右格让出一步（剩余自动跟着变）', () => {
    const r = resizeGroupShare([0.5], 2, 0, 1);
    expect(r).not.toBeNull();
    expect(r![0]!).toBeCloseTo(0.5 + SPLIT_KEYBOARD_STEP, 6);
    expect(rest(r!)).toBeCloseTo(0.5 - SPLIT_KEYBOARD_STEP, 6);
  });

  it('两组：放大右格（末组，不在数组里）= 左格让出一步', () => {
    const r = resizeGroupShare([0.5], 2, 1, 1);
    expect(r).not.toBeNull();
    expect(r![0]!).toBeCloseTo(0.5 - SPLIT_KEYBOARD_STEP, 6);
  });

  it('缩小 = 与放大相反（同一条分隔条，来回一步回到原点）', () => {
    const grow = resizeGroupShare([0.5], 2, 0, 1)!;
    const back = resizeGroupShare(grow, 2, 0, -1)!;
    expect(back[0]!).toBeCloseTo(0.5, 6);
  });

  it('三组只动**一条**分隔条：放大中间那格不牵动第一格', () => {
    const r = resizeGroupShare([0.4, 0.4], 3, 1, 1);
    expect(r).not.toBeNull();
    expect(r![0]!).toBeCloseTo(0.4, 6);
    expect(r![1]!).toBeCloseTo(0.4 + SPLIT_KEYBOARD_STEP, 6);
    expect(rest(r!)).toBeCloseTo(0.2 - SPLIT_KEYBOARD_STEP, 6);
  });

  it('贴到一成下限 ⇒ null（没有可挪的份额；命令侧据此说人话，不白 setState）', () => {
    expect(resizeGroupShare([0.9], 2, 0, 1)).toBeNull(); // 右格已剩一成，借无可借
    expect(resizeGroupShare([SPLIT_MIN_RATIO], 2, 0, -1)).toBeNull(); // 左格已一成，再缩就破线
  });

  it('不足一步时按**实有份额**挪（不造出跌破下限的读数）', () => {
    const r = resizeGroupShare([0.88], 2, 0, 1); // 剩余 0.12，只能借 0.02
    expect(r).not.toBeNull();
    expect(r![0]!).toBeCloseTo(0.9, 6);
    expect(rest(r!)).toBeCloseTo(SPLIT_MIN_RATIO, 6);
  });

  it('单组 / 非法参数 ⇒ null（只有一格时这动作没有意义）', () => {
    expect(resizeGroupShare([], 1, 0, 1)).toBeNull();
    expect(resizeGroupShare([0.5], 2, 0, 0)).toBeNull();
    expect(resizeGroupShare([0.5], 2, 0, Number.NaN)).toBeNull();
    expect(resizeGroupShare([0.5], 2, 0, 1, 0)).toBeNull();
  });

  it('长度不符的现场先按均分对齐（与渲染层同一把尺子），再在那份底子上挪', () => {
    const r = resizeGroupShare([0.5], 3, 0, 1); // 两组的份额套三组 ⇒ 退回三等分
    expect(r).not.toBeNull();
    expect(r!.length).toBe(2);
    // 借的是**右邻**（第 1 组）那一步，末组吃剩余所以它不动
    expect(r![0]!).toBeCloseTo(1 / 3 + SPLIT_KEYBOARD_STEP, 6);
    expect(r![1]!).toBeCloseTo(1 / 3 - SPLIT_KEYBOARD_STEP, 6);
  });

  it('产物恒过 sanitize 校验（不把坏数组交给渲染层与会话落盘）', () => {
    for (const g of [2, 3, 4]) {
      for (const o of [0, 1, 2]) {
        for (const d of [1, -1]) {
          const r = resizeGroupShare(equalSplitSizes(g), g, o, d);
          if (r === null) continue;
          expect(sanitizeSplitSizes(r, g)).not.toBeNull();
        }
      }
    }
  });

  it('自定义步长被尊重（4% 是缺省，不是焊死在调用方之外的常数）', () => {
    const r = resizeGroupShare([0.5], 2, 0, 1, 0.2)!;
    expect(r[0]!).toBeCloseTo(0.7, 6);
  });
});
