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

  it('CASE 多行值列表在 `{`…`}` 块内：拼接后逐值展开（W8-C2 起 CASE 纳入行连接）', () => {
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
    // 块内值列表拼成一条逻辑行 `1, 2, 3, 4` ⇒ 四个值全部进谓词（真语料 +307 条值片段同源）
    expect(withLines!.predicateCount).toBe(4);
    expect(withLines!.unparsedCount).toBe(0);
    expect(withLines!.dependencies[0]!.comparisons.map((c) => c.value)).toEqual([1, 2, 3, 4]);
    // 不给原始行时行为不变（缺省 = 不拼接）
    const withoutLines = extractFunctionConditions(fn, stmts);
    expect(withoutLines!.predicateCount).toBe(2);
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

describe('CASE 值列表 · 非块尾逗号不拼（W8-C2；真语料 7 处取证形态的合成替身）', () => {
  it('`CASE [[跳蛋]],` 下一行是内层 SELECTCASE：不拼（尾逗号不携带续行意图，拼了会吃掉内层 SELECTCASE）', () => {
    const text = [
      '@TEST_FUNC',
      'SELECTCASE X',
      'CASE [[跳蛋]], ',
      '\tSELECTCASE Y',
      '\tCASE "SALES"',
      '\tENDSELECT',
      'ENDSELECT',
    ].join('\n');
    const r = extract(text);
    // CASE 只展开头一个值片段；内层 SELECTCASE 仍是独立语句、其 CASE 归内层 subject
    //（ARG/ARGS 是语言级局部量不进依赖，这里用 X/Y 便于钉住"没有吃进内层语句"）
    expect(r!.predicateCount).toBe(2);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['X', 'Y']);
  });

  it('`CASE "A", "B",` 下一行是 SIF：尾逗号后的空槽跳过，SIF 仍是独立谓词', () => {
    const text = [
      '@TEST_FUNC',
      'SELECTCASE X',
      'CASE "A", "B",',
      'SIF Y',
      '\tRETURN 1',
      'ENDSELECT',
    ].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(3); // CASE 2 值 + SIF 1 条
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['X', 'Y']);
  });

  it('`CASE 53,` 下一行是注释行：注释不进值列表，片段数不变', () => {
    const text = ['@TEST_FUNC', 'SELECTCASE X', 'CASE 53,', '\t;注释', '\tCALL F', 'ENDSELECT'].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(0);
  });
});

describe('CASE 值列表 · `{`…`}` 门边缘（引擎报错语义 ⇒ 不应拼）', () => {
  it('`{` 行夹了字（不是孤行）：不拼，残句保持原样', () => {
    const text = [
      '@TEST_FUNC',
      'SELECTCASE FLAG:2',
      '{ 注释',
      'CASE 1, 2,',
      '\t3, 4',
      '}',
      'ENDSELECT',
    ].join('\n');
    const r = extract(text);
    expect(r!.predicateCount).toBe(2); // 只展开 `1, 2,` 头两个值
    expect(r!.dependencies[0]!.comparisons.map((c) => c.value)).toEqual([1, 2]);
  });

  it('`{` 未闭合：不猜，保持既有片段（引擎会报错；这里保守回退原样）', () => {
    const text = [
      '@TEST_FUNC',
      'SELECTCASE FLAG:2',
      '{',
      'CASE 1, 2,',
      '\t3, 4',
      'ENDSELECT',
    ].join('\n');
    const stmts = scanControlFlow(text);
    const detail = extractFunctionPredicates(fn, stmts, { endLine: 6, lines: linesOf(text) });
    const casePreds = detail.predicates.filter((p) => p.kind === 'CASE');
    expect(casePreds).toHaveLength(2);
    expect(casePreds[0]!.text).toBe('1, 2,');
  });

  it('`CASE` 单独一行、值全在块内（块在 CASE 行后开）：孤行 `{` 必须在语句**前**，此形不拼', () => {
    const text = [
      '@TEST_FUNC',
      'SELECTCASE FLAG:2',
      'CASE',
      '{',
      '\t1, 2,',
      '\t3',
      '}',
      'ENDSELECT',
    ].join('\n');
    const r = extract(text);
    // joinBracedExpression 的门是"语句前的非空行是孤行 `{`"；`{` 在 CASE 行后不满足
    // ⇒ 没有任何片段进谓词 ⇒ 聚合视图返回 null（调用方不收录）
    expect(r).toBeNull();
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
