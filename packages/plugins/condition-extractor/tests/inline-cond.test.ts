/**
 * 文本内联条件（Emuera 三元两形）· 合成夹具。
 *
 * 语法事实（Era Wiki `Emuera/exop` §Ternary Operators / `Emuera/exetc`）：
 * - 文本形 `\@<条件>?<真>#<假>\@`——`#` 是 else 分隔符，可直接写在 FORM 实参里；
 * - 数值形花括号插值 `{<条件> ? <真> # <假>}`。
 *
 * 本文件钉住（审计 `2026-10-25-erb-syntax-gap-audit.md` P0-1）：
 * - 条件半边进谓词、依赖按既有拼法收录；
 * - 残句（缺 `?` / 缺收尾 `\@`）不产谓词，绝不猜；
 * - 花括号形只认**顶层三元**——纯取值插值 `{CFLAG:0}` 不产依赖（防"每句显示多一条依赖"）；
 * - 停用区 / 注释行 / 指令行不进扫描；
 * - 生产链（`extractFileBucket`）与明细链同口径。
 */
import { describe, expect, it } from 'vitest';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { collectInlinePredicates, extractFunctionConditions, extractFunctionPredicates } from '../src/extract';
import { scanBraceTernaries, scanTextTernaries } from '../src/inline';
import { parseExpression } from '../src/expr';
import { extractFileBucket } from '../src/offload';

const fn = { normalizedName: 'TEST_FUNC', filePath: 'synthetic.erb', startLine: 1 };

const linesOf = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

describe('扫描器 · 文本形 `\\@条件?真#假\\@`', () => {
  it('基本形：条件原文切到 `?` 之前', () => {
    expect(scanTextTernaries('PRINTFORML \\@CFLAG:恋慕 > 0?好#不好\\@')).toEqual([
      { text: 'CFLAG:恋慕 > 0', column: 11 },
    ]);
  });

  it('缺 `#`（只有真支）也算一条条件', () => {
    expect(scanTextTernaries('PRINTFORML \\@FLAG:1?好\\@').map((c) => c.text)).toEqual(['FLAG:1']);
  });

  it('同行多枚：按出现顺序全收', () => {
    const line = 'PRINTFORML \\@A?1#0\\@ 与 \\@B?2#3\\@';
    expect(scanTextTernaries(line).map((c) => c.text)).toEqual(['A', 'B']);
  });

  it('缺 `?` / 缺收尾 `\\@` / 空条件：一律不产谓词（残句不猜）', () => {
    expect(scanTextTernaries('PRINTFORML \\@ただの文\\@')).toEqual([]);
    expect(scanTextTernaries('PRINTFORML \\@A?1#0')).toEqual([]);
    expect(scanTextTernaries('PRINTFORML \\@?1#0\\@')).toEqual([]);
  });

  it('条件里的字符串与括号内的 `?` 不算分隔符', () => {
    expect(scanTextTernaries('PRINTFORML \\@NAME == "A?B"?是#否\\@').map((c) => c.text)).toEqual(['NAME == "A?B"']);
    expect(scanTextTernaries('PRINTFORML \\@(A ? 1 # 0) > 2?是#否\\@').map((c) => c.text)).toEqual([
      '(A ? 1 # 0) > 2',
    ]);
  });
});

describe('扫描器 · 花括号插值形 `{条件 ? 真 # 假}`', () => {
  it('顶层三元：条件切到 `?` 之前', () => {
    expect(scanBraceTernaries('PRINTFORML {CFLAG:0 ? 1 # 0}', parseExpression)).toEqual([
      { text: 'CFLAG:0', column: 11 },
    ]);
  });

  it('纯取值插值不产谓词（`{CFLAG:0}` 遍地都是，认了就是假依赖）', () => {
    expect(scanBraceTernaries('PRINTFORML {CFLAG:0} {TALENT:恋慕}', parseExpression)).toEqual([]);
  });

  it('引号内的插值照认（FORM 串里 `"` 是输出字面量，`{}` 仍插值）', () => {
    expect(scanBraceTernaries('PRINTFORML "{A ? 1 # 0}"', parseExpression).map((c) => c.text)).toEqual(['A']);
  });

  it('`%…%` 代换里的花括号同样按插值处理', () => {
    expect(scanBraceTernaries('PRINTFORML %TEXTR({A ? 1 # 0})%', parseExpression).map((c) => c.text)).toEqual(['A']);
  });
});

describe('抽取 · 条件进谓词、依赖按既有拼法收录', () => {
  it('`\\@` 形：谓词数 +1、依赖为条件里的引用、原文可查', () => {
    const text = [
      '@TEST_FUNC',
      'PRINTFORML \\@CFLAG:恋慕 > 0?好#不好\\@',
      '\tRETURN 1',
    ].join('\n');
    const stmts = scanControlFlow(text);
    const detail = extractFunctionPredicates(fn, stmts, { endLine: 3, lines: linesOf(text) });
    const inline = detail.predicates.filter((p) => p.kind === 'INLINE');
    expect(inline).toHaveLength(1);
    expect(inline[0]!.line).toBe(2);
    expect(inline[0]!.text).toBe('CFLAG:恋慕 > 0');
    expect(inline[0]!.expr.kind).toBe('binary');

    const agg = extractFunctionConditions(fn, stmts, { lines: linesOf(text), endLine: 3 });
    expect(agg!.predicateCount).toBe(1);
    expect(agg!.unparsedCount).toBe(0);
    expect(agg!.dependencies.map((d) => d.key)).toEqual(['CFLAG:恋慕']);
  });

  it('`{…?…#…}` 形：只收条件半边，真 / 假两支的取值不算依赖', () => {
    const text = ['@TEST_FUNC', 'PRINTFORML {CFLAG:0 ? FLAG:1 # FLAG:2}'].join('\n');
    const r = extractFunctionConditions(fn, scanControlFlow(text), { lines: linesOf(text), endLine: 2 });
    expect(r!.predicateCount).toBe(1);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['CFLAG:0']);
  });

  it('控制流谓词与内联谓词按行归并（不重排骨架顺序）', () => {
    const text = [
      '@TEST_FUNC',
      'IF FLAG:1',
      'PRINTFORML \\@FLAG:2?A#B\\@',
      'ENDIF',
    ].join('\n');
    const detail = extractFunctionPredicates(fn, scanControlFlow(text), { endLine: 4, lines: linesOf(text) });
    expect(detail.predicates.map((p) => [p.kind, p.line])).toEqual([
      ['IF', 2],
      ['INLINE', 3],
    ]);
  });

  it('停用区 / 注释行 / 指令行不扫（死文本不产谓词）', () => {
    const text = [
      '@TEST_FUNC',
      ';PRINTFORML \\@FLAG:1?A#B\\@',
      '#DIM \\@FLAG:2?A#B\\@',
      '[SKIPSTART]',
      'PRINTFORML \\@FLAG:3?A#B\\@',
      '[SKIPEND]',
      'RETURN 1',
    ].join('\n');
    const got = collectInlinePredicates(linesOf(text), 2, 7);
    expect(got).toEqual([]);
  });

  it('不给 endLine 时不扫内联（区间不明 ⇒ 不猜，行为与改前逐字一致）', () => {
    const text = ['@TEST_FUNC', 'PRINTFORML \\@FLAG:1?A#B\\@'].join('\n');
    const stmts = scanControlFlow(text);
    expect(extractFunctionConditions(fn, stmts, { lines: linesOf(text) })).toBeNull();
  });
});

describe('生产链与明细链同口径', () => {
  const text = ['@TEST_FUNC', 'PRINTFORML \\@FLAG:1?A#B\\@', '\tRETURN 1'].join('\n');

  it('extractFileBucket 的桶级统计含内联谓词', () => {
    const { bucket } = extractFileBucket(
      {
        path: 'synthetic.erb',
        text,
        mtimeMs: null,
        size: null,
        functions: [{ normalizedName: 'TEST_FUNC', startLine: 1, endLine: 3 }],
      },
      scanControlFlow,
    );
    expect(bucket.stats).toEqual({
      functions: 1,
      functionsWithDeps: 1,
      predicates: 1,
      unparsed: 0,
      dependencies: 1,
    });
  });

  it('解析不了的条件仍是一条谓词（计入 unparsed，原文可查）', () => {
    const bad = ['@TEST_FUNC', 'PRINTFORML \\@A = = B?x#y\\@'].join('\n');
    const detail = extractFunctionPredicates(fn, scanControlFlow(bad), { endLine: 2, lines: linesOf(bad) });
    expect(detail.predicates).toHaveLength(1);
    expect(detail.predicates[0]!.expr.kind).toBe('opaque');
    expect(detail.predicates[0]!.text).toBe('A = = B');
  });
});
