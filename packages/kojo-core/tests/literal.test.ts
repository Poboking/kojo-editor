/**
 * 引擎字面量编码器 + 全角标点唯一入口单测。
 *
 * 引擎语义依据：本机 Emuera `LexicalAnalyzer.cs::ReadString`（普通串）与
 * `AnalyseFormattedString`（`@"…"` 格式串）——`\` 吃掉自己后：`n/s/S/t` 有特义、
 * `\@` 是行内条件、其余原样追加；格式串里 `%`/`{`/`}` 是插值、`$*+/=` 连三枚是三元符号指令。
 * 所以 `" \ % { } #` 都能反斜杠化成字面量；只有 U+0000 / CR / 未配对代理项 fail-closed。
 */
import { describe, expect, it } from 'vitest';
import type { KojoSpan } from '../src/ast.js';
import { createDiagnosticSink } from '../src/diagnostics.js';
import {
  encodeEngineLiteral,
  encodeEngineLiteralOrReport,
  encodeEngineText,
  FULLWIDTH_EXPR_PUNCT,
  reportFullwidthExprPunct,
} from '../src/literal.js';

const span = (sl: number, sc: number, el: number, ec: number): KojoSpan => ({
  start: { line: sl, column: sc },
  end: { line: el, column: ec },
});

describe('encodeEngineLiteral · 普通串 `"…"`（ReadString）', () => {
  it('引号与反斜杠：`\\"` 不闭合串、`\\\\` 输出字面反斜杠', () => {
    const result = encodeEngineLiteral('他说："好"\\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form).toBe('plain');
    expect(result.body).toBe('他说：\\"好\\"\\\\n');
    expect(result.literal).toBe('"他说：\\"好\\"\\\\n"');
  });

  it('换行编码成 `\\n`（ReadString 的 case n）', () => {
    const result = encodeEngineText('上\n下');
    expect(result).toMatchObject({ ok: true, body: '上\\n下' });
  });

  it('反斜杠+n 的原文（两个字符）不能被引擎吃成换行', () => {
    const result = encodeEngineText('\\n');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('\\\\n');
  });

  it('普通串不转义 `%` / `{` / `}`（ReadString 不做格式化）', () => {
    const result = encodeEngineText('50% {x}', { form: 'plain' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('50% {x}');
  });

  it('空串 → 空字面量', () => {
    const result = encodeEngineLiteral('');
    expect(result).toMatchObject({ ok: true, literal: '""', body: '' });
  });
});

describe('encodeEngineLiteral · 格式串 `@"…"`（AnalyseFormattedString）', () => {
  it('插值元字符全部反斜杠化成字面量', () => {
    const result = encodeEngineLiteral('50% {x}', { form: 'formatted' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('50\\% \\{x\\}');
    expect(result.literal).toBe('@"50\\% \\{x\\}"');
  });

  it('`#` 也转义（`\\@…?…#…\\@` 分支里 `#` 会截断）', () => {
    const result = encodeEngineText('a#b', { form: 'formatted' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('a\\#b');
  });

  it('三元符号指令（`$ * + / =` 连三枚）被拆开', () => {
    const result = encodeEngineText('+++ === $$$ *** ///', { form: 'formatted' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('\\+\\+\\+ \\=\\=\\= \\$\\$\\$ \\*\\*\\* \\/\\/\\/');
  });

  it('反斜杠 + `@`：编码成 `\\\\@`，仍是一个字面反斜杠加 `@`', () => {
    const result = encodeEngineText('\\@', { form: 'formatted' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('\\\\@');
  });

  it('合法代理对原样保留（按 UTF-16 码元）', () => {
    const result = encodeEngineLiteral('😀灵梦');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.literal).toBe('"😀灵梦"');
  });

  it('格式串里的引号与反斜杠同样要转义（不提前闭合、不吞字符）', () => {
    const result = encodeEngineLiteral('她"咦"了一声\\', { form: 'formatted' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.literal).toBe('@"她\\"咦\\"了一声\\\\"');
  });
});

describe('encodeEngineLiteral · fail-closed（不静默）', () => {
  it('U+0000 → core/expr/bad-literal，带精确 span（1 基 UTF-16）', () => {
    const result = encodeEngineLiteral('ab\u0000cd', { span: span(3, 5, 3, 12) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.reason)).toEqual(['nul']);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'core/expr/bad-literal',
      severity: 'error',
      span: { start: { line: 3, column: 7 }, end: { line: 3, column: 8 } },
    });
  });

  it('CR（U+000D）不可安全表达', () => {
    const result = encodeEngineLiteral('a\rb');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.reason).toBe('carriage-return');
  });

  it('未配对代理项（高/低各一）都 fail-closed', () => {
    for (const text of ['a\uD800b', 'a\uDC00b']) {
      const result = encodeEngineLiteral(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures[0]?.reason).toBe('unpaired-surrogate');
    }
  });

  it('失败时没有任何产物片段可用（literal/body 不存在）', () => {
    const result = encodeEngineLiteral('x\u0000');
    expect(result).not.toHaveProperty('literal');
    expect(result).not.toHaveProperty('body');
  });

  it('多行切片的失败位置折回物理行列', () => {
    const result = encodeEngineLiteral('a\nb\u0000', { span: span(10, 1, 12, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.span).toEqual({
      start: { line: 11, column: 2 },
      end: { line: 11, column: 3 },
    });
  });

  it('OrReport 便捷通道：失败写 sink 并返回 null，不产字节', () => {
    const sink = createDiagnosticSink();
    const literal = encodeEngineLiteralOrReport('ok\u0000', { span: span(1, 1, 1, 5) }, sink);
    expect(literal).toBeNull();
    expect(sink.hasError()).toBe(true);
    expect(sink.all[0]?.code).toBe('core/expr/bad-literal');
    // 成功路径
    expect(encodeEngineLiteralOrReport('ok', undefined, sink)).toBe('"ok"');
    expect(sink.all).toHaveLength(1);
  });
});

describe('reportFullwidthExprPunct · 全角标点唯一入口', () => {
  it('检测表达式/条件/声明位置的全角标点并给半角建议', () => {
    const diagnostics = reportFullwidthExprPunct('恋慕 ＝ 500 且 心情，1', span(7, 3, 7, 20));
    expect(diagnostics.map((d) => d.code)).toEqual([
      'core/migration/fullwidth-punct',
      'core/migration/fullwidth-punct',
    ]);
    expect(diagnostics[0]?.message).toContain('「＝」');
    expect(diagnostics[0]?.message).toContain('「=」');
    expect(diagnostics[0]?.span).toEqual({
      start: { line: 7, column: 6 },
      end: { line: 7, column: 7 },
    });
    expect(diagnostics[1]?.span?.start.column).toBe(16);
  });

  it('跳过字符串字面量内部（引号里的全角标点是正文）', () => {
    const diagnostics = reportFullwidthExprPunct('A == "她说：好，吗？" 且 B，C', span(1, 1, 1, 30));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('「，」');
    expect(diagnostics[0]?.span?.start.column).toBe(19);
  });

  it('字符串里的转义引号不提前结束跳过', () => {
    const text = '"a\\"：b"：';
    const diagnostics = reportFullwidthExprPunct(text, span(1, 1, 1, text.length + 1));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.span?.start.column).toBe(text.length); // 末尾那个全角冒号
  });

  it('多行切片按物理行列折回', () => {
    const diagnostics = reportFullwidthExprPunct('a：\nb，', span(3, 1, 4, 3));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.span?.start).toEqual({ line: 3, column: 2 });
    expect(diagnostics[1]?.span?.start).toEqual({ line: 4, column: 2 });
  });

  it('没有全角标点 → 空数组；映射表覆盖常用符号', () => {
    expect(reportFullwidthExprPunct('a >= 1 && b', span(1, 1, 1, 12))).toEqual([]);
    expect(FULLWIDTH_EXPR_PUNCT.get('：')).toBe(':');
    expect(FULLWIDTH_EXPR_PUNCT.get('？')).toBe('?');
    expect(FULLWIDTH_EXPR_PUNCT.get('％')).toBe('%');
  });
});
