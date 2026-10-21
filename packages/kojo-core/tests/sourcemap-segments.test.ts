/**
 * K2-SOURCEMAP-SEGMENTS · 列级分段（半开区间）的 additive 事实 + 模板/池展开的调用处/定义处双向锚点。
 *
 * 口径（与 `source-map.ts` 写死的同一套）：
 * - 列 **1 基、UTF-16 码元**；区间 **半开** `[startColumn, endColumn)`，`endColumn` 排他；
 * - 同一产物行内分段起点严格递增、区间不重叠（空档 = 该列无列级事实，查询回落行级）；
 * - 旧式点锚点（`appendSegment` 不给 `endColumn`）语义与批前完全一致；
 * - 模板/池展开产物行：整行一段，`source` = 定义处精确 span，`origins` = **[调用处, 定义处]**
 *   （顺序沿用既有 `expansionFrame` 约定：`origins[0]` = call-site、末项 = 定义处）；
 * - 行级映射逐字节不变（末尾 golden 全表钉住），分段只是 additive。
 *
 * 端到端断言全部走真实前端（`compileKojoSource` + fixture adapter/backend），
 * 只有 builder 层契约用直接构造（不手搓 `SourceMap` 形状冒充编译产物）。
 */
import { describe, expect, it } from 'vitest';
import type { KojoPosition, KojoSpan } from '../src/ast.js';
import { compileKojoSource } from '../src/compile.js';
import type { CompileKojoSourceResult } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import type { SourceMap } from '../src/source-map.js';
import { createSourceMapBuilder, sourceSpanContains } from '../src/source-map.js';

const at = (line: number, column: number): KojoPosition => ({ line, column });
const span = (sl: number, sc: number, el: number, ec: number): KojoSpan => ({
  start: at(sl, sc),
  end: at(el, ec),
});

/** 编译一段 2.0 源码（真实前端；fixture adapter/backend） */
function compile(sourceLines: readonly string[]): CompileKojoSourceResult {
  return compileKojoSource({ source: sourceLines.join('\n'), adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });
}

/** 产物行（成功口径是 `lines.join('\n') + '\n'`；末尾换行不多算一行） */
const bodyLines = (erb: string): string[] => (erb.length === 0 ? [] : erb.slice(0, -1).split('\n'));

function lineNumberOf(result: CompileKojoSourceResult, needle: string): number {
  const rows = bodyLines(result.erb);
  const index = rows.findIndex((row) => row === needle);
  if (index < 0) throw new Error(`产物里找不到整行「${needle}」：\n${result.erb}`);
  return index + 1;
}

/* ============================== builder 契约：半开区间 ============================== */

describe('SourceMapBuilder · 分段区间与别名字段', () => {
  function singleSegmentMap() {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'template', source: span(9, 5, 9, 20), origins: [
      { kind: 'call-site', span: span(17, 1, 17, 12) },
      { kind: 'template-definition', span: span(8, 1, 11, 13) },
    ] });
    builder.appendSegment({
      generatedLine: 1,
      generatedColumn: 1,
      source: span(9, 5, 9, 20),
      endColumn: 26,
      kind: 'template',
      origins: [
        { kind: 'call-site', span: span(17, 1, 17, 12) },
        { kind: 'template-definition', span: span(8, 1, 11, 13) },
      ],
    });
    return builder.build();
  }

  it('显式终点：物化出 startColumn / endColumn / kind / origins，起点 1 基含、终点排他', () => {
    const map = singleSegmentMap();
    const line = map.lineAt(1)!;
    expect(line.segments).toHaveLength(1);
    expect(line.segments![0]).toEqual({
      generatedLine: 1,
      generatedColumn: 1,
      startColumn: 1,
      endColumn: 26,
      source: span(9, 5, 9, 20),
      kind: 'template',
      origins: [
        { kind: 'call-site', span: span(17, 1, 17, 12) },
        { kind: 'template-definition', span: span(8, 1, 11, 13) },
      ],
    });
  });

  it('`generatedColumn` 是 `startColumn` 的别名（同一构造点，两者恒等；宿主反查零改动）', () => {
    const segment = singleSegmentMap().segmentAt(1, 7)!;
    expect(segment.generatedColumn).toBe(segment.startColumn);
    expect(segment.generatedColumn).toBe(1);
  });

  it('没有列级分段的行：`segments` 字段缺席（不是空数组）——旧消费方只读行级字段即可', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 5) });
    const line = builder.build().lineAt(1)!;
    expect(line.segments).toBeUndefined();
    expect(Object.keys(line).sort()).toEqual(['generatedLine', 'kind', 'origins', 'source']);
  });

  it('旧式点锚点（不给终点）：endColumn = null（开放到行尾），查询语义与批前一致', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(5, 1, 5, 20) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 5, source: span(6, 1, 6, 3) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 10, source: null });
    const map = builder.build();

    expect(map.lineAt(1)!.segments!.map((s) => [s.startColumn, s.endColumn])).toEqual([[5, 10], [10, null]]);
    // 批前口径：取"最后一个起点 ≤ 查询列"
    expect(map.lookup(at(1, 9)).source).toEqual(span(6, 1, 6, 3));
    expect(map.lookup(at(1, 10)).source).toBeNull();
    expect(map.lookup(at(1, 99)).source).toBeNull();
    expect(map.lookup(at(1, 4)).source).toEqual(span(5, 1, 5, 20));
  });

  it('前一段没给终点时，终点解析为下一段起点（相邻不重叠）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 5) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 1, source: span(2, 1, 2, 3) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 4, source: span(3, 1, 3, 3) });
    const segments = builder.build().lineAt(1)!.segments!;
    expect(segments.map((s) => s.endColumn)).toEqual([4, null]);
  });

  it('`segmentAt` 边界：起点命中、终点不命中、空档与首段之前显式 null', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(5, 1, 5, 20) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: span(6, 1, 6, 9), endColumn: 8 });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 12, source: span(7, 1, 7, 9), endColumn: 15 });
    const map = builder.build();

    expect(map.segmentAt(1, 2)).toBeNull(); // 首段之前
    expect(map.segmentAt(1, 3)?.source).toEqual(span(6, 1, 6, 9)); // 起点含
    expect(map.segmentAt(1, 7)?.source).toEqual(span(6, 1, 6, 9)); // 段内最后一列
    expect(map.segmentAt(1, 8)).toBeNull(); // 终点排他
    expect(map.segmentAt(1, 11)).toBeNull(); // 空档（8..12）
    expect(map.segmentAt(1, 15)).toBeNull(); // 第二段终点排他
    expect(map.segmentAt(2, 1)).toBeNull(); // 未登记行
  });

  it('`segmentAt` 参数契约：列必须是 ≥1 的整数（不静默 clamp）', () => {
    const map = singleSegmentMap();
    expect(() => map.segmentAt(1, 0)).toThrow(/1 基/);
    expect(() => map.segmentAt(1, 1.5)).toThrow(/1 基/);
    expect(() => map.segmentAt(0, 1)).toThrow(/1 基/);
  });

  it('区间不许重叠：显式终点之后的下一段起点必须 ≥ 上一段终点', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 5) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 1, source: span(2, 1, 2, 3), endColumn: 10 });
    expect(() =>
      builder.appendSegment({ generatedLine: 1, generatedColumn: 9, source: span(3, 1, 3, 3), endColumn: 12 }),
    ).toThrow(/不许重叠/);
  });

  it('终点必须 > 起点且为整数（排他语义下不允许零宽/反序）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 5) });
    expect(() => builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: null, endColumn: 3 })).toThrow(/终点/);
    expect(() => builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: null, endColumn: 2 })).toThrow(/终点/);
    expect(() =>
      builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: null, endColumn: 3.5 }),
    ).toThrow(/终点/);
  });

  it('既有契约不退化：起点严格递增、未登记行不能挂分段', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 5) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: null });
    expect(() => builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: null })).toThrow(/严格递增/);
    expect(() => builder.appendSegment({ generatedLine: 2, generatedColumn: 1, source: null })).toThrow(/尚未登记/);
  });

  it('模板/池分段缺双向锚点 → 抛错（列级也守 §10.7）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({
      generatedLine: 1,
      kind: 'template',
      source: span(2, 1, 2, 5),
      origins: [
        { kind: 'call-site', span: span(9, 1, 9, 4) },
        { kind: 'template-definition', span: span(1, 1, 3, 5) },
      ],
    });
    expect(() =>
      builder.appendSegment({ generatedLine: 1, generatedColumn: 1, source: null, kind: 'template', endColumn: 6 }),
    ).not.toThrow();
    expect(() =>
      builder.appendSegment({
        generatedLine: 1,
        generatedColumn: 7,
        source: null,
        kind: 'pool',
        endColumn: 9,
        origins: [{ kind: 'call-site', span: span(9, 1, 9, 4) }],
      }),
    ).toThrow(/pool-definition/);
  });

  it('kind / origins 缺省继承行级（分段只补区间，不另立一套口径）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({
      generatedLine: 1,
      kind: 'pool',
      source: span(4, 5, 5, 20),
      origins: [
        { kind: 'call-site', span: span(8, 1, 8, 5) },
        { kind: 'pool-definition', span: span(3, 1, 7, 19) },
      ],
    });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 1, source: span(4, 5, 5, 20), endColumn: 14 });
    const segment = builder.build().segmentAt(1, 1)!;
    expect(segment.kind).toBe('pool');
    expect(segment.origins.map((o) => o.kind)).toEqual(['call-site', 'pool-definition']);
  });
});

/* ============================== builder 契约：区间查询 ============================== */

describe('SourceMap · segmentsInRange', () => {
  function rangeMap() {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 30) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 1, source: span(1, 1, 1, 5), endColumn: 6 });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 6, source: span(2, 1, 2, 5), endColumn: 11 });
    builder.appendLine({ generatedLine: 2, kind: 'source', source: span(2, 1, 2, 30) });
    builder.appendSegment({ generatedLine: 2, generatedColumn: 3, source: span(3, 1, 3, 5), endColumn: 9 });
    return builder.build();
  }

  it('跨行区间：按行升序、行内列升序，元素自带 generatedLine', () => {
    const found = rangeMap().segmentsInRange(at(1, 1), at(2, 10));
    expect(found.map((s) => [s.generatedLine, s.startColumn])).toEqual([[1, 1], [1, 6], [2, 3]]);
  });

  it('半开：区间终点等于某段起点时不收该段；区间起点落在段内则命中该段', () => {
    const map = rangeMap();
    expect(map.segmentsInRange(at(1, 1), at(1, 6)).map((s) => s.startColumn)).toEqual([1]);
    expect(map.segmentsInRange(at(1, 5), at(1, 6)).map((s) => s.startColumn)).toEqual([1]);
    // 两段紧邻覆盖了 [1, 11)，段外（[11, 12)）没有列级事实
    expect(map.segmentsInRange(at(1, 11), at(1, 12))).toEqual([]);
  });

  it('零宽区间 = 点查询（含段起点，不含段终点）', () => {
    const map = rangeMap();
    expect(map.segmentsInRange(at(2, 3), at(2, 3)).map((s) => s.generatedLine)).toEqual([2]);
    expect(map.segmentsInRange(at(2, 9), at(2, 9))).toEqual([]);
  });

  it('反序区间 → 空数组（没有语义，不抛错）；未登记行 → 空数组', () => {
    const map = rangeMap();
    expect(map.segmentsInRange(at(2, 9), at(1, 1))).toEqual([]);
    expect(map.segmentsInRange(at(9, 1), at(12, 4))).toEqual([]);
  });

  it('端点必须是 1 基位置（越界列不 clamp，直接抛错）', () => {
    const map = rangeMap();
    expect(() => map.segmentsInRange(at(1, 0), at(2, 3))).toThrow(/1 基/);
    expect(() => map.segmentsInRange(at(1, 1), at(2, 2.5))).toThrow(/1 基/);
  });
});

/* ============================== UTF-16 列口径 ============================== */

describe('列口径 · UTF-16 码元（中文 / emoji 代理对）', () => {
  it('中文行：分段终点 = 行宽（码元数）+ 1', () => {
    const result = compile(['# 机 开场', '# 视 灵梦', '# 模 甲(值)', '    > 她看着{值}。', '! 甲("你")']);
    const rows = bodyLines(result.erb);
    const text = rows[1]!;
    expect(text).toBe('TELL: 她看着你。 /WAIT');
    const segment = result.sourceMap.segmentAt(2, 1)!;
    expect(segment.endColumn).toBe(text.length + 1);
  });

  it('emoji 代理对：列按码元算（不是码点），endColumns 与行宽一致', () => {
    const source = ['# 机 开场', '# 视 灵梦', '# 模 笑(原因)', '    > 🌅😀{原因}', '! 笑("呀")'];
    const result = compile(source);
    const rows = bodyLines(result.erb);
    const text = rows[1]!;
    expect(text).toBe('TELL: 🌅😀呀 /WAIT');
    // 码元 17、码点 15：分段终点必须是 18（UTF-16 口径）
    expect(text.length).toBe(17);
    expect([...text].length).toBe(15);
    const segment = result.sourceMap.segmentAt(2, 1)!;
    expect(segment.endColumn).toBe(18);
    // 段内最后一列（'T'）命中，行尾光标位（= endColumn）不命中
    expect(result.sourceMap.segmentAt(2, 17)?.endColumn).toBe(18);
    expect(result.sourceMap.segmentAt(2, 18)).toBeNull();
    // 代理对占两格：第 7、8 列都落在 🌅 上，仍在同一段
    expect(result.sourceMap.segmentAt(2, 7)?.startColumn).toBe(1);
    expect(result.sourceMap.segmentAt(2, 8)?.startColumn).toBe(1);
  });
});

/* ============================== 端到端：模板展开 ============================== */

const TEMPLATE_SOURCE = [
  '# 机 开场',
  '# 视 灵梦',
  '# 模 退场(原因)',
  '    > （因为{原因}，她退开了）',
  '    [插槽]',
  '    > （门合上了）',
  '! 退场("被夸奖")',
  '    灵梦：「那我先走了。」',
  '> 尾行。',
];

describe('模板展开 · 产物行分段双向锚点', () => {
  const result = compile(TEMPLATE_SOURCE);
  const map = result.sourceMap;

  it('每条展开行一段：起点 1、终点 = 行宽 + 1、kind = template、source = 模板体行', () => {
    const rows = bodyLines(result.erb);
    const expansion = rows.map((row, index) => ({ row, line: index + 1 })).filter(({ row }) => row.startsWith('TELL: （因为'));
    expect(expansion).toHaveLength(1);
    const line = expansion[0]!.line;
    const segment = map.segmentAt(line, 1)!;
    expect(segment.kind).toBe('template');
    expect(segment.startColumn).toBe(1);
    expect(segment.endColumn).toBe(rows[line - 1]!.length + 1);
    expect(segment.source).toEqual(span(4, 5, 4, 20));
    expect(map.lineAt(line)!.segments).toEqual([segment]);
  });

  it('分段同时带调用处与模板定义处（origins[0] = 调用处、末项 = 定义处，沿用既有约定）', () => {
    const line = lineNumberOf(result, 'TELL: （因为被夸奖，她退开了） /WAIT');
    const segment = map.segmentAt(line, 1)!;
    expect(segment.origins.map((o) => o.kind)).toEqual(['call-site', 'template-definition']);
    expect(segment.origins[0]!.span).toEqual(span(7, 1, 7, 12)); // `! 退场("被夸奖")`
    expect(segment.origins[1]!.span).toEqual(span(3, 1, 6, 13)); // `# 模 退场(原因)` 整块（含 [插槽]）
  });

  it('插槽行：source 落在调用处块内（定义处锚点仍指向模板块，双向都在）', () => {
    const line = lineNumberOf(result, 'SAY 灵梦: 那我先走了。 /WAIT');
    const segment = map.segmentAt(line, 1)!;
    expect(segment.source).toEqual(span(8, 5, 8, 16)); // 调用点缩进块里的那一行
    expect(segment.origins.map((o) => o.kind)).toEqual(['call-site', 'template-definition']);
    // 定义处锚点覆盖模板体（含 `[插槽]` 两侧的行），所以点了插槽行也能跳到模板
    expect(sourceSpanContains(segment.origins[1]!.span, at(4, 5))).toBe(true);
    expect(sourceSpanContains(segment.origins[1]!.span, at(6, 5))).toBe(true);
  });

  it('lookup 的 source/origins 与命中分段一致（列级只细化，不改行级结论）', () => {
    const line = lineNumberOf(result, 'TELL: （门合上了） /WAIT');
    const hit = map.lookup(at(line, 9));
    expect(hit.segment).not.toBeNull();
    expect(hit.source).toEqual(hit.segment!.source);
    expect(hit.origins).toEqual(hit.segment!.origins);
    expect(hit.source).toEqual(map.lineAt(line)!.source);
  });

  it('反向查询：分段源能被 generatedLinesFor 命中（模板定义行 → 展开行）', () => {
    const lines = map.generatedLinesFor(span(4, 5, 4, 20));
    expect(lines).toHaveLength(1);
    expect(map.lineAt(lines[0]!)?.kind).toBe('template');
  });
});

/* ============================== 端到端：池展开 ============================== */

const POOL_SOURCE = [
  '# 机 开场',
  '# 视 灵梦',
  '# 池 问候',
  '    ? 恋慕 < 100',
  '        > 她抬了下眼 🌅。',
  '    ? 否',
  '        > 「早安，旅人。」',
  '! 问候',
  '> 尾行。',
];

describe('池展开 · 链头/分支/链尾的分段', () => {
  const result = compile(POOL_SOURCE);
  const map = result.sourceMap;

  it('IF 头行：整行一段，source = 分支条件 span，origins = [调用处, 池定义处]', () => {
    const line = lineNumberOf(result, 'IF {恋慕 < 100}');
    const segment = map.segmentAt(line, 1)!;
    expect(segment.kind).toBe('pool');
    expect(segment.source).toEqual(span(4, 5, 5, 20));
    expect(segment.endColumn).toBe('IF {恋慕 < 100}'.length + 1);
    expect(segment.origins.map((o) => o.kind)).toEqual(['call-site', 'pool-definition']);
    expect(segment.origins[0]!.span).toEqual(span(8, 1, 8, 5));
  });

  it('ELSE / ENDIF：控制行也有分段（宿主点控制行同样能跳回池）', () => {
    const elseLine = lineNumberOf(result, 'ELSE');
    const endIfLine = lineNumberOf(result, 'ENDIF');
    expect(map.segmentAt(elseLine, 1)!.source).toEqual(span(6, 5, 7, 19));
    expect(map.segmentAt(endIfLine, 1)!.source).toEqual(span(3, 1, 7, 19));
    expect(map.segmentAt(elseLine, 1)!.endColumn).toBe('ELSE'.length + 1);
    expect(map.segmentAt(endIfLine, 1)!.endColumn).toBe('ENDIF'.length + 1);
  });

  it('分支体行：分段 source = 该分支体行 span（不是块头）', () => {
    const line = lineNumberOf(result, 'TELL: 她抬了下眼 🌅。 /WAIT');
    expect(map.segmentAt(line, 1)!.source).toEqual(span(5, 9, 5, 20));
    expect(map.segmentAt(line + 2, 1)!.source).toEqual(span(7, 9, 7, 19)); // ELSE 之后那行
  });

  it('多行 span：ENDIF 分段源跨行（3:1..7:19），中间源行也在区间内', () => {
    const segment = map.segmentAt(lineNumberOf(result, 'ENDIF'), 1)!;
    expect(segment.source!.start.line).toBe(3);
    expect(segment.source!.end.line).toBe(7);
    expect(sourceSpanContains(segment.source!, at(5, 1))).toBe(true);
    expect(sourceSpanContains(segment.source!, at(8, 1))).toBe(false);
  });

  it('整张图：有分段的行恰是池展开行（其余行 `segments` 缺席）', () => {
    const rows = bodyLines(result.erb);
    const withSegments: number[] = [];
    for (let line = 1; line <= rows.length; line++) {
      if (map.lineAt(line)!.segments !== undefined) withSegments.push(line);
    }
    expect(withSegments).toEqual([2, 3, 4, 5, 6]);
  });
});

/* ============================== 嵌套展开 / 伴生函数装配 ============================== */

describe('嵌套与装配：重建 source map 不许丢分段', () => {
  it('池分支里的模板调用：分段带四段 origins（外层调用/定义 + 内层调用/定义）', () => {
    const result = compile([
      '# 机 开场',
      '# 视 灵梦',
      '# 模 内(值)',
      '    > 内{值}',
      '# 池 外',
      '    ? 恋慕 < 100',
      '        > 前',
      '        ! 内("甲")',
      '    ? 否',
      '        > 兜底。',
      '! 外',
    ]);
    const map = result.sourceMap;
    const line = lineNumberOf(result, 'TELL: 内甲 /WAIT');
    expect(map.lineAt(line)!.kind).toBe('pool');
    const segment = map.segmentAt(line, 1)!;
    expect(segment.origins.map((o) => `${o.kind}@${o.span.start.line}`)).toEqual([
      'call-site@11',
      'pool-definition@5',
      'call-site@8',
      'template-definition@3',
    ]);
    expect(segment.source).toEqual(span(4, 5, 4, 11));
  });

  it('`@织` 监听体里的池展开：装配进伴生函数后分段仍在（子缓冲 → 父缓冲不丢事实）', () => {
    const result = compile([
      '# 机 开场',
      '# 视 灵梦',
      '# 池 问候',
      '    ? 恋慕 < 100',
      '        > 她抬了下眼。',
      '    ? 否',
      '        > 「早。」',
      '> 正文。',
      '@织 开场',
      '    ! 问候',
    ]);
    const map = result.sourceMap;
    const ifLine = lineNumberOf(result, 'IF {恋慕 < 100}');
    const endIfLine = lineNumberOf(result, 'ENDIF');
    expect(map.lineAt(ifLine)!.kind).toBe('pool');
    expect(map.segmentAt(ifLine, 1)!.origins.map((o) => `${o.kind}@${o.span.start.line}`)).toEqual([
      'call-site@10',
      'pool-definition@3',
    ]);
    expect(map.segmentAt(endIfLine, 1)!.source).toEqual(span(3, 1, 7, 15));
  });

  it('`# 机` 包装重建行级映射后，主事件体里的分段仍在（事件头 origin 行除外）', () => {
    const result = compile(TEMPLATE_SOURCE);
    const headerLine = lineNumberOf(result, 'MACHINE 开场');
    expect(result.sourceMap.lineAt(headerLine)!.segments).toBeUndefined();
    const expansionLine = lineNumberOf(result, 'TELL: （因为被夸奖，她退开了） /WAIT');
    expect(result.sourceMap.segmentAt(expansionLine, 1)).not.toBeNull();
  });
});

/* ============================== 随机块（已登记的缺口） ============================== */

describe('随机块 · 列级事实仍是缺口（W1，宿主/状态层需扩契约）', () => {
  const result = compile(['# 机 开场', '# 视 灵梦', '@随机', '    > 甲', '    > 乙', '> 尾行。']);
  const map = result.sourceMap;

  it('候选行仍只有块头行级映射（字节与批前一致），没有列级分段', () => {
    const head = lineNumberOf(result, 'RANDOM single-line-text 2');
    const first = lineNumberOf(result, 'TELL: 甲 /WAIT');
    expect(map.lineAt(first)!.source).toEqual(span(3, 1, 5, 8));
    expect(map.lineAt(head)!.kind).toBe('source');
    expect(map.lineAt(head)!.segments).toBeUndefined();
    expect(map.lineAt(first)!.segments).toBeUndefined();
  });

  it('缺口是显式的：segmentAt / segmentsInRange 对随机块行落空（不伪造候选源）', () => {
    const head = lineNumberOf(result, 'RANDOM single-line-text 2');
    const end = lineNumberOf(result, 'RANDOM.END');
    expect(map.segmentAt(head, 1)).toBeNull();
    expect(map.segmentsInRange(at(head, 1), at(end, 9))).toEqual([]);
  });
});

/* ============================== 行级零回归：整张指纹 ============================== */

describe('行级映射逐字节不变（分段只是 additive 事实）', () => {
  /** 行级指纹：行号 | 产物文本 | kind | 源 span | 锚点（顺序敏感） */
  const positionText = (position: KojoPosition): string => `${position.line}:${position.column}`;
  const spanText = (value: KojoSpan | null): string =>
    value === null ? '-' : `${positionText(value.start)}..${positionText(value.end)}`;

  function fingerprint(map: SourceMap, rows: readonly string[]): string[] {
    const out: string[] = [];
    for (let line = 1; line <= rows.length; line++) {
      const mapped = map.lineAt(line);
      const origins = mapped === null ? '' : mapped.origins.map((o) => `${o.kind}@${spanText(o.span)}`).join(' ');
      out.push([line, rows[line - 1], mapped?.kind ?? '-', spanText(mapped?.source ?? null), origins].join('|'));
    }
    return out;
  }

  /**
   * 批前（batch-3 产线）行级映射的快照：本批只改分段，这 24 行必须逐字相等。
   * 覆盖 `# 机` 包装（1/17 行）、随机块（3..6）、池（8..12）、模板+插槽（13..15）、
   * `@原生`（16）、`@织` 伴生函数（18..24）。
   */
  const GOLDEN = [
    '1|MACHINE 开场|source|1:1..1:7|',
    '2|;SLOT __kojo_rand_12 random int|source|1:1..1:7|',
    '3|RANDOM single-line-text 2|source|12:1..14:8|',
    '4|TELL: 甲 /WAIT|source|12:1..14:8|',
    '5|TELL: 乙 /WAIT|source|12:1..14:8|',
    '6|RANDOM.END|source|12:1..14:8|',
    '7|TELL: 晨光 🏮 透过鸟居。 /WAIT|source|15:1..15:14|',
    '8|IF {恋慕 < 100}|pool|4:5..5:20|call-site@16:1..16:5 pool-definition@3:1..7:19',
    '9|TELL: 她抬了下眼 🌅。 /WAIT|pool|5:9..5:20|call-site@16:1..16:5 pool-definition@3:1..7:19',
    '10|ELSE|pool|6:5..7:19|call-site@16:1..16:5 pool-definition@3:1..7:19',
    '11|TELL: 「早安，旅人。」 /WAIT|pool|7:9..7:19|call-site@16:1..16:5 pool-definition@3:1..7:19',
    '12|ENDIF|pool|3:1..7:19|call-site@16:1..16:5 pool-definition@3:1..7:19',
    '13|TELL: （因为被夸奖，她退开了） /WAIT|template|9:5..9:20|call-site@17:1..17:12 template-definition@8:1..11:13',
    '14|SAY 灵梦: 那我先走了。 /WAIT|template|18:5..18:16|call-site@17:1..17:12 template-definition@8:1..11:13',
    '15|TELL: （门合上了） /WAIT|template|11:5..11:13|call-site@17:1..17:12 template-definition@8:1..11:13',
    '16|; raw 🧵 line|native|20:1..20:14|',
    '17|MACHINE.END|source|1:1..1:7|',
    '18|WEAVE 开场|source|21:1..22:9|',
    '19|IF {恋慕 < 100}|pool|4:5..5:20|call-site@22:5..22:9 pool-definition@3:1..7:19',
    '20|TELL: 她抬了下眼 🌅。 /WAIT|pool|5:9..5:20|call-site@22:5..22:9 pool-definition@3:1..7:19',
    '21|ELSE|pool|6:5..7:19|call-site@22:5..22:9 pool-definition@3:1..7:19',
    '22|TELL: 「早安，旅人。」 /WAIT|pool|7:9..7:19|call-site@22:5..22:9 pool-definition@3:1..7:19',
    '23|ENDIF|pool|3:1..7:19|call-site@22:5..22:9 pool-definition@3:1..7:19',
    '24|WEAVE.END|source|21:1..22:9|',
  ];

  const COMBINED = [
    '# 机 开场',
    '# 视 灵梦',
    '# 池 问候',
    '    ? 恋慕 < 100',
    '        > 她抬了下眼 🌅。',
    '    ? 否',
    '        > 「早安，旅人。」',
    '# 模 退场(原因)',
    '    > （因为{原因}，她退开了）',
    '    [插槽]',
    '    > （门合上了）',
    '@随机',
    '    > 甲',
    '    > 乙',
    '> 晨光 🏮 透过鸟居。',
    '! 问候',
    '! 退场("被夸奖")',
    '    灵梦：「那我先走了。」',
    '@原生',
    '    ; raw 🧵 line',
    '@织 开场',
    '    ! 问候',
  ];

  it('行级指纹与批前快照逐字节相等（含产物文本）', () => {
    const result = compile(COMBINED);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const rows = bodyLines(result.erb);
    expect(fingerprint(result.sourceMap, rows)).toEqual(GOLDEN);
  });

  it('同一份 map：`lookup` 的行级回落结论不变（分段不越权改写行级答案）', () => {
    const result = compile(COMBINED);
    const map = result.sourceMap;
    const rows = bodyLines(result.erb);
    for (let line = 1; line <= rows.length; line++) {
      const mapped = map.lineAt(line)!;
      // 列 1 永远落在分段起点或行首：没有分段的行必须回落到行级
      if (mapped.segments === undefined) {
        expect(map.lookup(at(line, 1)).segment).toBeNull();
        expect(map.lookup(at(line, 1)).source).toEqual(mapped.source);
      }
    }
  });

  it('分段总数 = 展开产物行数（13 条：池 5 + 模板 3 + 伴生池 5），不多登记一行', () => {
    const result = compile(COMBINED);
    expect(result.sourceMap.segmentCount).toBe(13);
  });
});
