/**
 * 图标体系自检（批次十一 L10）：把 `icons.tsx` 文件头写的三条口径钉成自动化闸——
 *  ① 家族一致：每枚图标都渲染成 16 viewBox / `currentColor` / stroke 1.5 的 SVG；
 *  ② 尺寸只有四档刻度（xs/sm/md/lg = 12/14/16/22），历史遗留数字一律就近吸附（平局取大），
 *     钉死"9 档散装尺寸"不再回来；
 *  ③ filled 只许住在状态族（`FILLED_ICON_NAMES` 白名单），其余族整条路径纯描边；
 *  ④ 表体量（41 枚）与未命中注册表的字形回退（第三方贡献契约）照旧。
 * 任何一条漂了当场红；扩表是允许的，但要**有意识地**改这里的钉数。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FILLED_ICON_NAMES, ICON_SIZES, Icon, resolveIconSize } from '../src/ui/icons';
import { ICONS } from '../src/ui/icons';

const names = Object.keys(ICONS);
const render = (name: string, size?: 'xs' | 'sm' | 'md' | 'lg' | number): string =>
  renderToStaticMarkup(size === undefined ? createElement(Icon, { name }) : createElement(Icon, { name, size }));

describe('ICON_SIZES · 四档刻度是唯一口径', () => {
  it('档位恰好 xs/sm/md/lg = 12/14/16/22（加档减档都要过这里）', () => {
    expect(Object.keys(ICON_SIZES)).toEqual(['xs', 'sm', 'md', 'lg']);
    expect(Object.values(ICON_SIZES)).toEqual([12, 14, 16, 22]);
  });

  it('历史遗留的 9 档散装数字全部就近吸附进 4 档（平局取大：13→14、15→16）', () => {
    // 批前调用侧实测用过的每个数字都钉一遍
    expect(resolveIconSize(9)).toBe(12);
    expect(resolveIconSize(11)).toBe(12);
    expect(resolveIconSize(12)).toBe(12);
    expect(resolveIconSize(13)).toBe(14);
    expect(resolveIconSize(14)).toBe(14);
    expect(resolveIconSize(15)).toBe(16);
    expect(resolveIconSize(16)).toBe(16);
    expect(resolveIconSize(18)).toBe(16);
    expect(resolveIconSize(22)).toBe(22);
    // 吸附后值域只剩四档，没有第五个尺寸能溜上屏
    const legacy = [9, 11, 12, 13, 14, 15, 16, 18, 22, 0, 7, 10, 17, 19, 20, 30];
    expect(new Set(legacy.map(resolveIconSize))).toEqual(new Set([12, 14, 16, 22]));
  });

  it('档位名直取、缺省为 md=16', () => {
    expect(resolveIconSize('xs')).toBe(12);
    expect(resolveIconSize('lg')).toBe(22);
    expect(resolveIconSize(undefined)).toBe(16);
  });

  it('渲染面：旧数字尺寸经 Icon 上屏即被吸附，档位名照直给', () => {
    expect(render('close', 13)).toContain('width="14" height="14"');
    expect(render('close', 9)).toContain('width="12" height="12"');
    expect(render('close', 'lg')).toContain('width="22" height="22"');
    expect(render('close')).toContain('width="16" height="16"');
  });
});

describe('家族一致 · 每枚图标都是同一口径的 SVG', () => {
  it('表体 41 枚（扩表请有意识地抬这个数字）', () => {
    expect(names.length).toBe(41);
  });

  for (const name of names) {
    it(`\`${name}\`：svg + 16 viewBox + currentColor + stroke 1.5 + fill none`, () => {
      const out = render(name);
      expect(out.startsWith('<svg')).toBe(true);
      expect(out).toContain('viewBox="0 0 16 16"');
      expect(out).toContain('stroke="currentColor"');
      expect(out).toContain('stroke-width="1.5"');
      expect(out).toContain('fill="none"');
      expect(out).toContain('aria-hidden="true"');
    });
  }
});

describe('filled 规则 · 状态族 filled、其余全 stroke', () => {
  it('白名单之外的图标一律不许出现 fill="currentColor" 子形', () => {
    const offenders = names.filter((n) => !FILLED_ICON_NAMES.includes(n) && render(n).includes('fill="currentColor"'));
    expect(offenders, `这些非状态族图标夹了 filled 子形: ${offenders.join(', ')}`).toEqual([]);
  });

  it('状态族白名单本身就是那三枚诊断/未保存状态灯', () => {
    expect([...FILLED_ICON_NAMES].sort()).toEqual(['circle-filled', 'info', 'warning']);
    for (const n of FILLED_ICON_NAMES) {
      expect(render(n)).toContain('fill="currentColor"');
    }
  });
});

describe('字形回退 · 第三方贡献契约不动', () => {
  it('未命中注册表 ⇒ .icon-glyph 原样渲染单字符，不画空白', () => {
    const out = render('＋');
    expect(out).toContain('class="icon-glyph"');
    expect(out).toContain('＋');
    expect(out.startsWith('<svg')).toBe(false);
  });
});
