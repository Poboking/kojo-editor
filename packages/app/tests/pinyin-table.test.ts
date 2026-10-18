/**
 * P2-12 · 拼音表模块（`pinyin.ts`）的覆盖范围 / 退化语义 / 缓存单测。
 *
 * 钉三件事（不猜、不静默）：
 * 1. **覆盖范围**：表规模 = GB2312 一级字库 3755 字；常用字读音抽查（含多音字的常用读音）；
 * 2. **退化语义**：表没覆盖的字类字符 ⇒ 原字符进全拼串与首字母串（不猜读音）；
 *    非字类字符（ASCII / 数字 / 标点 / 空格）⇒ 跳过；全程无字类字符 ⇒ `undefined`；
 * 3. **缓存**：同一 label 的键走模块级缓存（同一引用），热路径不重复解析。
 */

import { describe, expect, it } from 'vitest';
import { pinyinKeysOf, pinyinOf, pinyinTableSize } from '../src/monaco/pinyin';

describe('P2-12 · 拼音表覆盖范围（GB2312 一级字库）', () => {
  it('表规模 = 3755（一级字库；缺条即覆盖范围被悄悄改小）', () => {
    expect(pinyinTableSize()).toBe(3755);
  });

  it('常用字读音抽查（无声调、全小写）', () => {
    expect(pinyinOf('好')).toBe('hao');
    expect(pinyinOf('感')).toBe('gan');
    expect(pinyinOf('度')).toBe('du');
    expect(pinyinOf('系')).toBe('xi');
    expect(pinyinOf('统')).toBe('tong');
    expect(pinyinOf('如')).toBe('ru');
    expect(pinyinOf('果')).toBe('guo');
  });

  it('多音字只收常用读音（不猜第二读音）', () => {
    expect(pinyinOf('行')).toBe('xing');
    expect(pinyinOf('长')).toBe('zhang');
    expect(pinyinOf('重')).toBe('zhong');
    expect(pinyinOf('觉')).toBe('jue');
    expect(pinyinOf('得')).toBe('de');
    expect(pinyinOf('地')).toBe('di');
  });

  it('表外单字 ⇒ undefined（调用方按退化处理，不猜）', () => {
    expect(pinyinOf('あ')).toBeUndefined(); // 日文假名：不在 GB2312 一级
    expect(pinyinOf('A')).toBeUndefined();
    expect(pinyinOf('1')).toBeUndefined();
  });
});

describe('P2-12 · pinyinKeysOf：键的构造口径', () => {
  it('「好感度系统」⇒ 全拼 haoganduxitong + 首字母 hgdxt（本批缺陷词；五字五首字母）', () => {
    expect(pinyinKeysOf('好感度系统')).toEqual({ full: 'haoganduxitong', initials: 'hgdxt' });
  });

  it('「如果」⇒ ruguo / rg；「时机」⇒ shiji / sj', () => {
    expect(pinyinKeysOf('如果')).toEqual({ full: 'ruguo', initials: 'rg' });
    expect(pinyinKeysOf('时机')).toEqual({ full: 'shiji', initials: 'sj' });
  });

  it('未覆盖的字类字符退化为原字符（不猜读音、不静默丢弃）', () => {
    expect(pinyinKeysOf('あ')).toEqual({ full: 'あ', initials: 'あ' });
    // 混合：覆盖字给拼音、未覆盖字类给原字符 ⇒ 两个串都保留可检索面
    expect(pinyinKeysOf('好あ感')).toEqual({ full: 'haoあgan', initials: 'hあg' });
  });

  it('非字类字符跳过（原文面已承载它们的匹配）', () => {
    // 处 chù → c；女 nǚ → n（ü 按本表约定写作 v，但首字母恒取声母，不是 v）
    expect(pinyinKeysOf('8 处女')).toEqual({ full: 'chunv', initials: 'cn' });
    expect(pinyinKeysOf('实参:2')).toEqual({ full: 'shican', initials: 'sc' });
  });

  it('纯 ASCII / 空串 ⇒ undefined（无可拼音键）', () => {
    expect(pinyinKeysOf('CALL_A')).toBeUndefined();
    expect(pinyinKeysOf('M_KOJO_A')).toBeUndefined();
    expect(pinyinKeysOf('')).toBeUndefined();
  });

  it('同一 label 走模块级缓存（同一引用 ⇒ 热路径不重复解析）', () => {
    const a = pinyinKeysOf('好感度');
    const b = pinyinKeysOf('好感度');
    expect(a).toEqual({ full: 'haogandu', initials: 'hgd' });
    expect(a).toBe(b);
  });
});
