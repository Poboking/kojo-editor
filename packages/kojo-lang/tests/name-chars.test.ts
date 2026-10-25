/**
 * 标识符字符类 · 两门语言一套基表（2026-10-26 批）。
 *
 * 钉住三件事：
 * 1. **基表覆盖**：全角数字 / 兼容汉字 / 半角片假名 / 拉丁补充都算名字字符（core
 *    `isIdentifier` 的 `[\p{L}\p{N}_]` 口径）；数字与下划线照旧；
 * 2. **两门语言唯一的差异是 `$`**：`.kojo` 侧的 `isNameChar` 收 `$`（字符串形参后缀
 *    `实参$`，B1 行为不变），ERB 侧不收（`$` 是标签记号）；
 * 3. **行为回归点**：`kojo2TokenSpanAt('好感度１', …)` 不再在 `１` 处截断（改前读数
 *    = `好感度`，与 ERB 侧切全名不一致）。
 */
import { describe, expect, it } from 'vitest';
import { kojo2DocumentOf, kojo2TokenSpanAt } from '../src/declarations';
import { ERB_NAME_CHAR_CLASS, NAME_CHAR_CLASS, isCjk, isNameChar } from '../src/name-chars';

const ERB_NAME_CHAR_RE = new RegExp(`[${ERB_NAME_CHAR_CLASS}]`);

describe('共用基表：字母 / 数字 / 下划线 + 全角数字 / 兼容汉字 / 半角片假名', () => {
  it.each([
    ['好', '汉字'],
    ['ア', '片假名'],
    ['ｱ', '半角片假名 (U+FF71)'],
    ['１', '全角数字 (U+FF11)'],
    ['Ａ', '全角拉丁 (U+FF21)'],
    ['豈', '兼容汉字 (U+F900)'],
    ['À', '拉丁补充 (U+00C0)'],
    ['a', 'ASCII 字母'],
    ['7', 'ASCII 数字'],
    ['_', '下划线'],
  ])('`%s`（%s）是名字字符（两门语言同判）', (ch) => {
    expect(isNameChar(ch)).toBe(true);
    expect(ERB_NAME_CHAR_RE.test(ch)).toBe(true);
  });

  it('分隔符 / 标点不是名字字符', () => {
    for (const ch of [' ', '\t', '，', '。', '：', '（', '-', '+', '/']) {
      expect(isNameChar(ch)).toBe(false);
      expect(ERB_NAME_CHAR_RE.test(ch)).toBe(false);
    }
  });

  it('兼容汉字进 CJK 判定（`isCjk` 与基表同源）', () => {
    expect(isCjk('豈')).toBe(true);
    expect(isCjk('好')).toBe(true);
    expect(isCjk('A')).toBe(false);
  });

  it('两门语言唯一差异 = `$`：kojo 侧收（`实参$`），ERB 侧不收（`$标签`）', () => {
    expect(NAME_CHAR_CLASS.includes('$')).toBe(true);
    expect(ERB_NAME_CHAR_CLASS.includes('$')).toBe(false);
    expect(isNameChar('$')).toBe(true);
    expect(ERB_NAME_CHAR_RE.test('$')).toBe(false);
    // 两份类表除 `$` 外逐字相同（同一份基表派生，不是两张手抄表）
    expect(NAME_CHAR_CLASS.replace('$', '')).toBe(ERB_NAME_CHAR_CLASS);
  });
});

describe('行为：kojo2 取词尺不再在全角数字处截断', () => {
  it('`kojo2TokenSpanAt(好感度１)` → 整个名字（改前只到「好感度」）', () => {
    const line = '好感度１';
    expect(kojo2TokenSpanAt(line, 0)).toEqual({ start: 0, end: 4, text: '好感度１' });
    expect(kojo2TokenSpanAt(line, 4)?.text).toBe('好感度１');
  });

  it('声明索引的名字段同样覆盖全角数字（`# 变量 好感度１ 整数`）', () => {
    const document = kojo2DocumentOf('# 变量 好感度１ 整数 = 0\n');
    expect(document.declarations[0]?.name).toBe('好感度１');
  });
});
