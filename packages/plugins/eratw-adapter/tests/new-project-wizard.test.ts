import { describe, expect, it } from 'vitest';
import { readRequestToken } from '../src/new-project-wizard';

/**
 * 关联号解析单测（2026-10-13 用户反馈 3 批）。
 *
 * 这个函数是「新建口上文件 → 跳去新建项目 → 回来自动落盘」这条链的第一颗螺丝：
 * 它决定这次开门**有没有**请求方。判错方向的代价不对称——
 * 误认成"有人在等"，会在一个作者没要过的项目里凭空多出一个文件；
 * 误认成"没人等"，最坏只是作者得自己再按一次 Ctrl+N。
 * 所以口径是**只认明确形状**，其余一律 null，不做任何"尽力解析"。
 */

describe('readRequestToken（新建项目向导的开门 payload）', () => {
  it('认得 { requestToken } 这一种形态', () => {
    expect(readRequestToken({ requestToken: 'kojo-m1abc-1' })).toBe('kojo-m1abc-1');
  });

  it('面板按钮开门没有 payload → null（这次创建与任何请求无关）', () => {
    expect(readRequestToken(undefined)).toBeNull();
    expect(readRequestToken(null)).toBeNull();
  });

  it('空串不算号（空号配不上任何东西，留着只会被误配）', () => {
    expect(readRequestToken({ requestToken: '' })).toBeNull();
  });

  it('非对象 / 字段类型不对 / 字段名打错，一律 null', () => {
    expect(readRequestToken('kojo-1')).toBeNull();
    expect(readRequestToken(42)).toBeNull();
    expect(readRequestToken([])).toBeNull();
    expect(readRequestToken({ requestToken: 7 })).toBeNull();
    expect(readRequestToken({ token: 'kojo-1' })).toBeNull();
    expect(readRequestToken({ requestToken: null })).toBeNull();
  });
});
