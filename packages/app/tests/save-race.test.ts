import { describe, expect, it } from 'vitest';
import { classifySaveRace } from '../src/ui/save-race';

/**
 * A1 保存竞态守卫的判据（纯函数半边）：React 侧协议见 save-race.ts 头注——
 * 这里钉的是"什么情况允许立基线"这一个事实。
 */
describe('classifySaveRace · A1 保存竞态守卫', () => {
  it('版本未变：写盘窗口内没有新输入 → 允许 markSaved 立基线', () => {
    expect(classifySaveRace(7, 7)).toBe('unchanged');
  });

  it('版本变了（写盘窗口内有新输入）：必须保持脏，绝不把没落盘的字节标成已保存', () => {
    expect(classifySaveRace(7, 8)).toBe('raced');
    expect(classifySaveRace(7, 42)).toBe('raced');
  });

  it('版本号回退同样算 raced——只认相等，不假设单调（undo 跨过定稿点等形状）', () => {
    expect(classifySaveRace(9, 3)).toBe('raced');
  });
});
