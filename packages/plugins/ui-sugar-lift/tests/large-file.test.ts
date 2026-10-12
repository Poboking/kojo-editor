import { describe, expect, it } from 'vitest';
import { LIFT_MAX_LINES, countLines, liftScanBudget } from '../src/large-file';

describe('liftScanBudget（超长文件降级决策）', () => {
  it('体量未知 → 不降级（保守：绝不因拿不到信息而悄悄少给结果）', () => {
    expect(liftScanBudget(undefined)).toEqual({ skip: false, reason: null });
  });

  it('阈值内不降级；**恰好等于阈值也不降级**（边界含等号）', () => {
    expect(liftScanBudget(1).skip).toBe(false);
    expect(liftScanBudget(LIFT_MAX_LINES).skip).toBe(false);
  });

  it('超过阈值 → 降级，且给出面向作者的中文说明（含行数与上限）', () => {
    const r = liftScanBudget(LIFT_MAX_LINES + 1);
    expect(r.skip).toBe(true);
    expect(r.reason).toContain(String(LIFT_MAX_LINES + 1));
    expect(r.reason).toContain(String(LIFT_MAX_LINES));
    expect(r.reason).toContain('重新扫描'); // 显式路径的出口必须写进文案
  });

  it('阈值可注入（便于将来按实测调参）', () => {
    expect(liftScanBudget(100, 50).skip).toBe(true);
    expect(liftScanBudget(50, 50).skip).toBe(false);
  });
});

describe('countLines（数行数，不 split）', () => {
  it('空串 1 行；末行无换行也算一行', () => {
    expect(countLines('')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(3);
  });
});
