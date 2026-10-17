/**
 * BLANK-CLASS · 补全空白判据**单源**的回归钉（口径 = `kojo-sugar` lexer 的 `[ \t\u3000]`）。
 *
 * 钉四件事：①三种空白字符（全角/半角/制表）皆判真；②`BLANK_RE` 由 `BLANK_CLASS_STR` 派生
 * （不留第二份手抄字符集，也无 `g` 标志 ⇒ `.test` 无状态）；③`isAllBlank` 的边界（空串为真）；
 * ④**能编译的行必须补得出**——以真实语料形态 `\u3000时机\u3000本番：` 为样本，单源拼出的门匹配、
 * 旧的四套写法里最窄的那一套（`/^[ \t]*…/`）不匹配（钉住 bug 本身，防止"改回去了"无人察觉）。
 */

import { describe, expect, it } from 'vitest';
import { BLANK_CLASS_STR, BLANK_RE, isAllBlank, isBlank } from '../src/monaco/kojo-completion-position';

/** 真实语料形态：全角缩进 + 全角分隔（lexer 编译得过） */
const FULLWIDTH_LINE = '\u3000时机\u3000本番：';

describe('BLANK-CLASS · 单字符判定', () => {
  it('全角空格 U+3000 / 半角空格 / 制表符三者皆空白', () => {
    expect(isBlank('\u3000')).toBe(true);
    expect(isBlank(' ')).toBe(true);
    expect(isBlank('\t')).toBe(true);
  });

  it('非空白判假；NBSP 一类 lexer 不认的字符也判假（口径不是 JS 的 `\s`）', () => {
    expect(isBlank('时')).toBe(false);
    expect(isBlank('机')).toBe(false);
    expect(isBlank('\u00a0')).toBe(false);
  });

  it('BLANK_RE 由 BLANK_CLASS_STR 派生，且无 `g` 标志（`.test` 不推进 lastIndex，可反复用）', () => {
    expect(BLANK_CLASS_STR).toBe('\\t \\u3000');
    expect(BLANK_RE.source).toBe(`[${BLANK_CLASS_STR}]`);
    expect(BLANK_RE.global).toBe(false);
    expect([BLANK_RE.test('\u3000'), BLANK_RE.test('\u3000'), BLANK_RE.test('x')]).toEqual([true, true, false]);
  });
});

describe('BLANK-CLASS · 整段判定（行首位：光标之前只有空白）', () => {
  it('空串视为真；三种空白混排视为真', () => {
    expect(isAllBlank('')).toBe(true);
    expect(isAllBlank('\u3000\t ')).toBe(true);
  });

  it('含非空白字符判假（全角缩进后的正文不算空白）', () => {
    expect(isAllBlank('时机')).toBe(false);
    expect(isAllBlank('\u3000时机')).toBe(false);
  });
});

describe('BLANK-CLASS · 拼出的位置门与 lexer 同口径', () => {
  it('用单源拼 `^[…]*时机[…]+` ⇒ 全角缩进 + 全角分隔的语料形态匹配', () => {
    const gate = new RegExp(`^[${BLANK_CLASS_STR}]*时机[${BLANK_CLASS_STR}]+`);
    expect(gate.test(FULLWIDTH_LINE)).toBe(true);
    // 半角形态同样必须匹配（同一枚门吃两种分隔，不是二选一）
    expect(gate.test('  时机 本番：')).toBe(true);
    expect(gate.test('时机本番：')).toBe(false); // 词后无空白 ⇒ 不是这一位
  });

  it('旧写法（只认 `[ \t]`）在该形态下不匹配 ⇒ 钉住"能编译但零候选"的 bug 起因', () => {
    expect(/^[ \t]*时机[ \t]+/.test(FULLWIDTH_LINE)).toBe(false);
  });
});
