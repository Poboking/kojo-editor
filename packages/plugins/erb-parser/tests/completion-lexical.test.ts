/**
 * 补全词法**地基**的钉子（LAU-4 补全腿第二批，2026-10-31）。
 *
 * 判据从 `@kojo/erb-lang/completion-*` 搬进本包之后，空白类不再引 `@kojo/kojo-lang/completion`
 * （插件静态引它会把 2.0 补全词表链拽上开机图），改引契约层 `ERB_BLANK_CLASS_STR`。
 * 于是同一份口径有了**两个分层落点**：
 *
 * - ERB 侧：契约层 `ERB_BLANK_CLASS_STR`（`@kojo/plugin-api`）；
 * - `.kojo` 侧：`BLANK_CLASS_STR`（`@kojo/kojo-lang/completion`，B3c 起的单源）。
 *
 * 本文件把"两枚是同一字符集"逐条钉死——谁改了其中一处（哪怕只是多收一个空格变体）都在这里红，
 * 而不是等到"`.kojo` 补得上、`.erb` 补不上"那天才被发现。
 *
 * 第三枚 `BLANK_CHAR_CLASS`（`@kojo/kojo-vocab/blank-charset`）是糖层词法的单源，同口径同字符集，
 * 一并入钉：三处漂移的表现各不相同（补全不弹 / 缩进行不认 / 格式化不清），只钉两枚会漏第三种。
 *
 * 名字字符集同理：ERB 侧 `NAME_CHAR_RE` 由契约层 `MODEL_TOKEN_CLASS` 组装（`$` 不在集内），
 * 这里钉住"它就是那张表、且不含 `$`"。
 */
import { describe, expect, it } from 'vitest';

import {
  ERB_BLANK_CLASS_STR,
  ERB_BLANK_RE,
  MODEL_TOKEN_CLASS,
  isAllErbBlank,
  isErbBlank,
} from '@kojo/plugin-api';
import { BLANK_CLASS_STR } from '@kojo/kojo-lang/completion';
import { BLANK_CHAR_CLASS } from '@kojo/kojo-vocab/blank-charset';

import { NAME_CHAR_RE } from '../src/completion';

/** 三种空白：制表 / 半角空格 / 全角空格（顺序无关，比较的是集合） */
const BLANKS = ['\t', ' ', '\u3000'] as const;

describe('补全词法地基 · 空白类三处单源同值', () => {
  it('ERB（契约层）与 `.kojo`（语言面库）逐字相等', () => {
    expect(ERB_BLANK_CLASS_STR).toBe(BLANK_CLASS_STR);
  });

  it('ERB（契约层）与糖层词法（`blank-charset`）同一字符集（字符类里次序不同，集合必须相同）', () => {
    // `blank-charset` 的 `BLANK_CHARS = [' ', '\t', '\u3000']` ⇒ 拼出来是 `' \t\u3000'`；
    // 契约层那枚按"TAB 在前"写。字符类的**次序**不影响语义，所以比集合而不是比字节。
    const sugarRe = new RegExp(`[${BLANK_CHAR_CLASS}]`);
    const probe = [...BLANKS, '\u00a0', 'a', '　', '\n', '。'];
    expect(probe.filter((ch) => ERB_BLANK_RE.test(ch))).toEqual(probe.filter((ch) => sugarRe.test(ch)));
    expect(new Set(BLANKS.filter((ch) => sugarRe.test(ch)))).toEqual(new Set(BLANKS));
  });

  it('值本身 = `\\t \\u3000`（半角空格 / TAB / 全角空格，NBSP 故意不收）', () => {
    // 写成字面量而不是拿常量自比：口径是"哪三个字符"，改字符集必须显式改这一行。
    expect(ERB_BLANK_CLASS_STR).toBe('\\t \\u3000');
  });

  it('`ERB_BLANK_RE` 由该串派生，且**无 `g`**（`.test` 不推进 lastIndex，可反复用）', () => {
    expect(ERB_BLANK_RE.source).toBe(`[${ERB_BLANK_CLASS_STR}]`);
    expect(ERB_BLANK_RE.flags).not.toContain('g');
    for (let i = 0; i < 3; i += 1) expect(ERB_BLANK_RE.test(' ')).toBe(true);
  });
});

describe('补全词法地基 · `isErbBlank` / `isAllErbBlank`', () => {
  it('三种空白皆判真', () => {
    for (const ch of BLANKS) expect(isErbBlank(ch)).toBe(true);
  });

  it('NBSP / 换行 / 字母 / 全角标点判假（NBSP 不是空白——lexer 不认，补全也不能认）', () => {
    for (const ch of ['\u00a0', '\n', '\r', 'a', '。', '　\u00a0']) {
      expect(isErbBlank(ch)).toBe(false);
    }
  });

  it('多字符 / 空串不算单字符空白（判据是"一个字符"，不是"一段前缀"）', () => {
    expect(isErbBlank('')).toBe(false);
    expect(isErbBlank('  ')).toBe(false);
    expect(isErbBlank('\t\t')).toBe(false);
  });

  it('`isAllErbBlank`：空串为真（行首无缩进），全空白为真，夹一个非空白为假', () => {
    expect(isAllErbBlank('')).toBe(true);
    expect(isAllErbBlank(' \t\u3000')).toBe(true);
    expect(isAllErbBlank('\u3000\u3000')).toBe(true);
    expect(isAllErbBlank(' \ta')).toBe(false);
    expect(isAllErbBlank('\u00a0')).toBe(false); // NBSP 独占一行 = 有内容，不是空行
  });
});

describe('补全词法地基 · 名字字符集', () => {
  it('`NAME_CHAR_RE` 就是契约层 `MODEL_TOKEN_CLASS`（不另写字符集）', () => {
    expect(NAME_CHAR_RE.source).toBe(MODEL_TOKEN_CLASS);
    expect(NAME_CHAR_RE.flags).toBe('u');
  });

  it('字母 / 数字 / 下划线为真；`$` 与 `.` / `:` 为假（`$` 是标签记号，由 `ERB_SIGIL_BEFORE` 另判）', () => {
    for (const ch of ['A', 'z', '0', '_', 'あ', '心']) expect(NAME_CHAR_RE.test(ch)).toBe(true);
    for (const ch of ['$', '.', ':', ' ', '\u3000']) expect(NAME_CHAR_RE.test(ch)).toBe(false);
  });
});