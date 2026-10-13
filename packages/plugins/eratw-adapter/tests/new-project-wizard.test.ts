import { describe, expect, it } from 'vitest';
import type { CharaInfo } from '@kojo/plugin-api';
import { charaOptionLabel, noKojoDirWarning, readRequestToken } from '../src/new-project-wizard';

/**
 * 「目标角色」文案单测（看板 HK-9，2026-10-13）。
 *
 * eraTW 的 CHARA 表把 MASTER 也当成 `Chara0.csv`（名前 = 你），它没有个人口上目录。
 * 旧向导让这个选项一路畅通到"部署被拒"才说话。口径是**说清后果、不删选项**：
 * 没有口上目录在新整合包里是常态（语料 168 张 CHARA 表 / 155 个口上目录），
 * 而这类包照样能写、能导出、能手工放置——只有"部署"这一条走不通，那就该那样说。
 */

const chara = (no: number, name: string, kojoDir?: string): CharaInfo =>
  kojoDir === undefined ? { no, name } : { no, name, kojoDir };

describe('charaOptionLabel（目标角色下拉文案）', () => {
  it('有口上目录的角色：只有编号与名字，不加任何后缀（155 个常态项不该被噪音淹掉）', () => {
    expect(charaOptionLabel(chara(1, '灵梦', 'C:/game/ERB/…/001 Reimu [霊夢]'))).toBe('#1 灵梦');
  });

  it('没有口上目录的角色：标出来，但**不删选项**（K0「你」就是这一类）', () => {
    const label = charaOptionLabel(chara(0, '你'));
    expect(label).toBe('#0 你 · 游戏里无个人口上目录');
    expect(label).toContain('#0');
    expect(label).toContain('你');
  });

  it('空串 kojoDir 也算"没有"（缺省值不该被当成有目录）', () => {
    expect(charaOptionLabel(chara(7, '妖梦', ''))).toContain('无个人口上目录');
  });
});

describe('noKojoDirWarning（选了无目录角色时的后果说明）', () => {
  it('没选角色 → null（向导刚打开不该先吓作者一条警告）', () => {
    expect(noKojoDirWarning(null)).toBeNull();
  });

  it('有口上目录 → null', () => {
    expect(noKojoDirWarning(chara(23, '妖梦', 'C:/game/…/023 Youmu'))).toBeNull();
  });

  it('无口上目录 → 说清"能写能导出，只有部署不行"，不夸大成"这个包没用"', () => {
    const w = noKojoDirWarning(chara(0, '你'));
    expect(w).not.toBeNull();
    const text = w!;
    expect(text).toContain('#0 你');
    expect(text).toContain('照常书写');
    expect(text).toContain('照常导出');
    expect(text).toContain('部署');
    // 反向断言：不能把"能写"这条路一起否掉
    expect(text).not.toMatch(/无法创建|不能创建|没有意义/);
  });
});

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
