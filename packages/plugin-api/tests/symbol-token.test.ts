/**
 * 光标处标识符整串（`symbolTokenAt`）单测。
 *
 * 这是 ERB 与语法糖两条线共用的极小件（插件间禁交叉 import，故住契约层），
 * 口径必须一次钉死：命中区间覆盖整串、列可指串内任意位置、也可指串尾后一格
 * （Monaco 光标常见形态）；标点/空白/CJK 一律**不认**（宁窄不错）。
 */

import { describe, expect, it } from 'vitest';
import { symbolTokenAt } from '../src/symbol-token';

/** 用 `|` 标光标（1 基列 = 标记在原文里的 0 基下标 + 1） */
const at = (marked: string) => symbolTokenAt(marked.replace('|', ''), marked.indexOf('|') + 1);

describe('symbolTokenAt · 命中', () => {
  it('光标在记号中间 → 返回整串与 1 基半开区间', () => {
    expect(at('CALL M_KOJO|_K1(ARG)')).toEqual({ text: 'M_KOJO_K1', startColumn: 6, endColumn: 15 });
  });

  it('光标在记号首字符 / 尾字符 → 同整串', () => {
    expect(at('CALL |M_KOJO_K1')?.text).toBe('M_KOJO_K1');
    expect(at('CALL M_KOJO_K|1')?.text).toBe('M_KOJO_K1');
  });

  it('光标停在记号**尾后一格**（Monaco 光标在词尾）→ 仍命中整串', () => {
    const tok = at('CALL M_KOJO_K1|(ARG)');
    expect(tok?.text).toBe('M_KOJO_K1');
    expect(tok?.endColumn).toBe(15);
  });

  it('记号以行首开始 / 到行尾结束 → 区间正确', () => {
    expect(at('|PRINTFORMW')).toEqual({ text: 'PRINTFORMW', startColumn: 1, endColumn: 11 });
    expect(at('X = PRIN|TFORMW')).toEqual({ text: 'PRINTFORMW', startColumn: 5, endColumn: 15 });
  });

  it('数字与下划线也在字符集内（引擎函数名形状）', () => {
    expect(at('CALL K1|_2_3')?.text).toBe('K1_2_3');
  });
});

describe('symbolTokenAt · 不认（不猜）', () => {
  it('空白 / 标点 → undefined', () => {
    expect(at('CALL | (ARG)')).toBeUndefined();
    expect(at('A =| 1')).toBeUndefined();
    expect(at('CALL NAME,| OTHER')).toBeUndefined();
    expect(at('|')).toBeUndefined();
    expect(at('   |   ')).toBeUndefined();
  });

  it('`:` 不在字符集内 → `CFLAG:FOO` 只取光标所在那一段（变量引用不当函数名用）', () => {
    expect(at('CFLAG:|FOO')?.text).toBe('FOO');
    expect(at('CFLAG|:FOO')?.text).toBe('CFLAG');
    expect(at('CFLAG:|:FOO')).toBeUndefined(); // 光标正落在 `:` 上，两侧都不是记号
  });

  it('CJK 不在字符集内（散文不是记号）', () => {
    expect(at('时机 |指令 310：')).toBeUndefined();
  });

  it('列越界（0 / 负 / NaN / 超过行宽 + 1）→ undefined', () => {
    expect(symbolTokenAt('ABC', 0)).toBeUndefined();
    expect(symbolTokenAt('ABC', -1)).toBeUndefined();
    expect(symbolTokenAt('ABC', Number.NaN)).toBeUndefined();
    expect(symbolTokenAt('ABC', 4)).toBeDefined(); // 行宽 3 → 列 4 仍是"尾后一格"，命中
    expect(symbolTokenAt('ABC', 5)).toBeUndefined();
    expect(symbolTokenAt('ABC', 999)).toBeUndefined();
  });

  it('空行 → undefined', () => {
    expect(symbolTokenAt('', 1)).toBeUndefined();
  });

  it('自定义字符集可覆盖（含 `.` 的路径式记号）', () => {
    const tok = symbolTokenAt('ab.c', 2, (ch) => ch !== '/');
    expect(tok?.text).toBe('ab.c');
    expect(tok).toEqual({ text: 'ab.c', startColumn: 1, endColumn: 5 });
  });
});
