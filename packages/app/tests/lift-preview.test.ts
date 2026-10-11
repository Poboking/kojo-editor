/**
 * 升糖预览（前端透镜）宿主侧纯逻辑单测。
 *
 * 这三件事各自钉死一类回归：
 * - `isErbLike`：决定"默认只读 + 💡 是否可用"的分流（`.erb`/`.erm` 命中，`.kojo` 不）；
 * - `liftZonePlan`：ViewZone 锚点必须落在原文**上方**（`fromLine-1`），否则"糖在上、
 *   原 ERB 在下"的预期就反了；
 * - `clampRange`：预览供给与执行之间用户又编辑会产生陈旧行号——夹取而非崩。
 */

import { describe, expect, it } from 'vitest';
import { clampRange, isErbLike, liftZonePlan } from '../src/ui/lift-preview';

describe('升糖预览 / isErbLike', () => {
  it('.erb / .erm 命中（大小写不敏感）', () => {
    expect(isErbLike('/proj/口上/x.erb')).toBe(true);
    expect(isErbLike('/proj/口上/x.erm')).toBe(true);
    expect(isErbLike('/proj/口上/X.ERB')).toBe(true);
  });

  it('.kojo 及无关扩展不命中（.kojo 全程可编辑，不走只读预览分流）', () => {
    expect(isErbLike('/proj/口上/x.kojo')).toBe(false);
    expect(isErbLike('/proj/口上/x.txt')).toBe(false);
    expect(isErbLike('/proj/口上/erb')).toBe(false); // 无扩展名点不算
  });
});

describe('升糖预览 / liftZonePlan', () => {
  it('锚点在原文上方：afterLineNumber = fromLine - 1', () => {
    expect(liftZonePlan({ fromLine: 10, sugarText: '甲。' }).afterLineNumber).toBe(9);
  });

  it('fromLine = 1 → 锚点 0（文件顶部，Monaco 接受）', () => {
    expect(liftZonePlan({ fromLine: 1, sugarText: '甲。' }).afterLineNumber).toBe(0);
  });

  it('高度 = 糖文本行数 + 2（标题行 + 留白）', () => {
    expect(liftZonePlan({ fromLine: 3, sugarText: '甲。' })).toMatchObject({ lineCount: 1, heightInLines: 3 });
    expect(liftZonePlan({ fromLine: 3, sugarText: '如果 x：\n\ty' })).toMatchObject({ lineCount: 2, heightInLines: 4 });
  });
});

describe('升糖预览 / clampRange', () => {
  it('区间在范围内 → 原样', () => {
    expect(clampRange(3, 7, 100)).toEqual({ fromLine: 3, toLine: 7 });
  });

  it('越界上界 → 夹到 maxLine', () => {
    expect(clampRange(90, 200, 100)).toEqual({ fromLine: 90, toLine: 100 });
  });

  it('toLine < fromLine → 收敛为单行（不产生倒置区间）', () => {
    expect(clampRange(7, 2, 100)).toEqual({ fromLine: 7, toLine: 7 });
  });

  it('负/零/NaN 起点 → 夹到 1', () => {
    expect(clampRange(0, 5, 10).fromLine).toBe(1);
    expect(clampRange(-3, 5, 10).fromLine).toBe(1);
    expect(clampRange(Number.NaN, 5, 10).fromLine).toBe(1);
  });

  it('空文件（maxLine=1）→ 收敛为 1..1', () => {
    expect(clampRange(4, 9, 1)).toEqual({ fromLine: 1, toLine: 1 });
  });
});