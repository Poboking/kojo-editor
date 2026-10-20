/**
 * 多行条件表达式（`{` … `}` 行连接）与 `@"…"` 嵌套引号的**合成夹具**。
 *
 * 背景（BOARD `COND-MULTILINE-OPAQUE`）：erb-parser 的骨架扫描是**逐行**视野，
 * 语料里把长条件书写成
 *
 *     {
 *     IF FLAG:2 >= 500 &&
 *     	FLAG:3 == 1
 *     }
 *
 * 时，`IF` 行只拿到半句（行尾 `&&`）⇒ `parseExpression` 整体降级 opaque。
 * Emuera 的行连接语义（EraStreamReader.ReadEnabledLine）：孤行 `{` 起、孤行 `}`
 * 止，块内物理行**以一个空格**拼成一条逻辑行。
 *
 * 本文件钉住：
 * - IF / ELSEIF / SIF / SELECTCASE+CASE 的多行条件都能进入既有表达式解析器；
 * - 谓词**总数不变**（拼接只补全原文，不新增假谓词）；
 * - 不在 `{`…`}` 里的残句 / 未闭合的块仍然 opaque（不放宽既有判据、不静默）；
 * - 生产链（`extractFileBucket`）与明细链（`extractFunctionPredicates`）同口径；
 * - `@"…"` 里的 `%…%` 插值可含 `"…"`（`%TEXTS("…")%`），不提前收串。
 *
 * 全部为合成夹具，不含真实语料原文。
 */
import { describe, expect, it } from 'vitest';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { extractFunctionConditions, extractFunctionPredicates } from '../src/extract';
import { extractFileBucket } from '../src/offload';

const fn = { normalizedName: 'TEST_FUNC', filePath: 'synthetic.erb', startLine: 1 };

function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** 生产链同口径：真扫描器 + 原始行 */
function extract(text: string) {
  const stmts = scanControlFlow(text);
  const lines = linesOf(text);
  return extractFunctionConditions(fn, stmts, { lines });
}

describe('多行条件 · `{`…`}` 行连接', () => {
  it('IF + 行尾 `&&`：拼接后可解析，依赖与阈值齐全', () => {
    const text = [
      '@TEST_FUNC',
      '{',
      'IF FLAG:2 >= 500 &&',
      '\tFLAG:3 == 1 && TALENT:恋慕',
      '}',
      '\tRETURN 1',
    ].join('\n');
    const r = extract(text);
    expect(r).not.toBeNull();
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['FLAG:2', 'FLAG:3', 'TALENT:恋慕']);
    expect(r!.dependencies[0]!.comparisons).toEqual([{ op: '>=', value: 500, text: '500' }]);
  });

  it('`IF` 行没有表达式（首行空、条件全在后续行）同样能拼接', () => {
    const text = ['@TEST_FUNC', '{', 'IF', '\tFLAG:2 >= 500 &&', '\tFLAG:3', '}'].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['FLAG:2', 'FLAG:3']);
  });

  it('同一函数内 ELSEIF 的多行条件各自拼接（谓词数不变）', () => {
    const text = [
      '@TEST_FUNC',
      'IF FLAG:1',
      '{',
      'ELSEIF FLAG:2 &&',
      '\tFLAG:3',
      '}',
      'ENDIF',
    ].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(2);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['FLAG:1', 'FLAG:2', 'FLAG:3']);
  });

  it('CASE 多行值列表**不**拼接（本批只收 IF 族；拼接会凭空抬高谓词总数）', () => {
    const text = [
      '@TEST_FUNC',
      'SELECTCASE FLAG:2',
      '{',
      'CASE 1, 2,',
      '\t3, 4',
      '}',
      'ENDSELECT',
    ].join('\n');
    const stmts = scanControlFlow(text);
    const withLines = extractFunctionConditions(fn, stmts, { lines: linesOf(text) });
    // 现状：`CASE 1, 2,` 只展开两个值（尾逗号留空槽跳过），续行 3, 4 不进谓词——
    // 这是既有口径，不在本批"多行 IF"判据内；拼接 CASE 会让真语料谓词总数 +311。
    expect(withLines!.predicateCount).toBe(2);
    expect(withLines!.dependencies[0]!.comparisons.map((c) => c.value)).toEqual([1, 2]);
  });

  it('SIF 的多行条件同样拼接（同属 IF 族）', () => {
    const text = ['@TEST_FUNC', '{', 'SIF FLAG:2 ||', '\tFLAG:3', '}', '\tRETURN 1'].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['FLAG:2', 'FLAG:3']);
  });

  it('谓词总数不因拼接而变（只把 opaque 变成可解析）', () => {
    const text = ['@TEST_FUNC', '{', 'IF FLAG:2 &&', '\tFLAG:3', '}', 'ENDIF'].join('\n');
    const stmts = scanControlFlow(text);
    const withoutLines = extractFunctionConditions(fn, stmts);
    const withLines = extractFunctionConditions(fn, stmts, { lines: linesOf(text) });
    expect(withoutLines!.predicateCount).toBe(withLines!.predicateCount);
    expect(withoutLines!.unparsedCount).toBe(1);
    expect(withLines!.unparsedCount).toBe(0);
  });
});

describe('多行条件 · 不放宽既有判据', () => {
  it('没有 `{`…`}` 包裹的残句仍然 opaque（仍是可查的谓词）', () => {
    const text = ['@TEST_FUNC', 'IF FLAG:2 &&', '\tFLAG:3'].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(1);
    expect(r!.dependencies).toEqual([]);
  });

  it('`{` 未闭合：不猜，保持 opaque 且原文可查', () => {
    const text = ['@TEST_FUNC', '{', 'IF FLAG:2 &&', '\tFLAG:3'].join('\n');
    const stmts = scanControlFlow(text);
    const detail = extractFunctionPredicates(fn, stmts, { endLine: 4, lines: linesOf(text) });
    expect(detail.predicates).toHaveLength(1);
    expect(detail.predicates[0]!.expr.kind).toBe('opaque');
    expect(detail.predicates[0]!.text).toBe('FLAG:2 &&');
  });

  it('块内真正的语法错误仍然 opaque（拼接不等于兜底）', () => {
    const text = ['@TEST_FUNC', '{', 'IF FLAG:2 = 1 &&', '\tFLAG:3', '}'].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(1);
  });
});

describe('`@"…"` 嵌套引号 · `%…%` 插值里的字符串', () => {
  it('`%TEXTS("…")%` 的内层引号不提前收串', () => {
    const text = ['@TEST_FUNC', 'IF FLAG:2 == @"Start_{N}%COND_STR("_A", 1)%"'].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['FLAG:2']);
    expect(r!.dependencies[0]!.comparisons).toEqual([
      { op: '==', value: 'Start_{N}%COND_STR("_A", 1)%', text: '@"Start_{N}%COND_STR("_A", 1)%"' },
    ]);
  });

  it('嵌套引号的函数实参（条件形）可解析，不产生假依赖', () => {
    const text = ['@TEST_FUNC', 'IF DEVENT(@"%TEXTS("EVENT")%X") == 1'].join('\n');
    const stmts = scanControlFlow(text);
    const detail = extractFunctionPredicates(fn, stmts, { endLine: 2, lines: linesOf(text) });
    expect(detail.predicates).toHaveLength(1);
    expect(detail.predicates[0]!.expr.kind).not.toBe('opaque');
  });

  it('普通 `@"…"` 里孤立的 `%` 仍按字面串收尾（不误开插值）', () => {
    const text = ['@TEST_FUNC', 'IF FLAG:2 == @"50% OFF"'].join('\n');
    const r = extract(text);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies[0]!.comparisons).toEqual([{ op: '==', value: '50% OFF', text: '@"50% OFF"' }]);
  });
});

describe('生产链与明细链同口径', () => {
  const text = [
    '@TEST_FUNC',
    '{',
    'IF FLAG:2 >= 500 &&',
    '\tFLAG:3 == 1',
    '}',
    '\tRETURN 1',
  ].join('\n');

  it('extractFileBucket（worker 任务同一函数）拿到原始行并完成拼接', () => {
    const { bucket } = extractFileBucket(
      {
        path: 'synthetic.erb',
        text,
        mtimeMs: null,
        size: null,
        functions: [{ normalizedName: 'TEST_FUNC', startLine: 1, endLine: 6 }],
      },
      scanControlFlow,
    );
    expect(bucket.stats).toEqual({
      functions: 1,
      functionsWithDeps: 1,
      predicates: 1,
      unparsed: 0,
      dependencies: 2,
    });
  });

  it('extractFunctionPredicates（明细视图）的谓词原文是拼接后的整句', () => {
    const stmts = scanControlFlow(text);
    const detail = extractFunctionPredicates(fn, stmts, { endLine: 6, lines: linesOf(text) });
    expect(detail.predicates).toHaveLength(1);
    const pred = detail.predicates[0]!;
    expect(pred.line).toBe(3); // 行号仍指向 IF 行
    expect(pred.expr.kind).not.toBe('opaque');
    expect(pred.text).toBe('FLAG:2 >= 500 && FLAG:3 == 1');
  });
});
