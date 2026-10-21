/**
 * source map 单测：1 基 UTF-16 坐标、行级/列级 additive、不可映射显式 null、
 * 模板/池双向锚点、一源多产物、追加契约（不静默）。
 */
import { describe, expect, it } from 'vitest';
import type { KojoPosition, KojoSpan } from '../src/ast.js';
import { createSourceMapBuilder, sourceSpanContains } from '../src/source-map.js';

const at = (line: number, column: number): KojoPosition => ({ line, column });
const span = (sl: number, sc: number, el: number, ec: number): KojoSpan => ({
  start: at(sl, sc),
  end: at(el, ec),
});

describe('SourceMapBuilder · 行级映射', () => {
  it('逐行映射 + 查询回源（1 基行/列）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(3, 1, 3, 8) });
    builder.appendLine({ generatedLine: 2, kind: 'source', source: span(4, 1, 4, 6) });
    const map = builder.build();

    expect(map.lineCount).toBe(2);
    expect(map.lineAt(1)).toEqual({
      generatedLine: 1,
      kind: 'source',
      source: span(3, 1, 3, 8),
      origins: [],
    });
    expect(map.lookup(at(2, 1)).source).toEqual(span(4, 1, 4, 6));
    expect(map.lookup(at(2, 99)).source).toEqual(span(4, 1, 4, 6));
  });

  it('纯生成行必须显式 source=null；没登记的行查询显式 null（不拿邻居冒充）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'generated', source: null });
    builder.appendLine({ generatedLine: 2, kind: 'source', source: span(9, 1, 9, 2) });
    const map = builder.build();

    expect(map.lineAt(1)).toEqual({ generatedLine: 1, kind: 'generated', source: null, origins: [] });
    expect(map.lineAt(3)).toBeNull();
    expect(map.lookup(at(3, 1))).toEqual({ generated: at(3, 1), line: null, segment: null, source: null, origins: [] });
    // 显式 null 不伪造：第 1 行永远不落到第 2 行的源
    expect(map.lookup(at(1, 1)).source).toBeNull();
  });

  it('追加契约：行号必须严格递增', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 2, kind: 'source', source: span(1, 1, 1, 2) });
    expect(() => builder.appendLine({ generatedLine: 2, kind: 'source', source: span(1, 1, 1, 2) })).toThrow(/严格递增/);
    expect(() => builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 2) })).toThrow(/严格递增/);
  });

  it('generated 行带源 / 源行不带源都抛错（不静默）', () => {
    const builder = createSourceMapBuilder();
    expect(() => builder.appendLine({ generatedLine: 1, kind: 'generated', source: span(1, 1, 1, 2) })).toThrow(/generated 行不能带源/);
    expect(() => builder.appendLine({ generatedLine: 1, kind: 'source', source: null })).toThrow(/只有 generated 行允许 source=null/);
  });

  it('build 之后不能再追加（单向数据流）', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 2) });
    builder.build();
    expect(() => builder.appendLine({ generatedLine: 2, kind: 'source', source: span(2, 1, 2, 2) })).toThrow(/封口/);
  });
});

describe('SourceMapBuilder · 列级 additive', () => {
  function twoColumnMap() {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(5, 1, 5, 20) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 5, source: span(6, 1, 6, 3) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 10, source: null });
    builder.appendLine({ generatedLine: 2, kind: 'source', source: span(7, 1, 7, 9) });
    return builder.build();
  }

  it('列级分段覆盖行级；未覆盖的列回落行级', () => {
    const map = twoColumnMap();
    expect(map.lookup(at(1, 1)).source).toEqual(span(5, 1, 5, 20));
    expect(map.lookup(at(1, 4)).source).toEqual(span(5, 1, 5, 20));
    expect(map.lookup(at(1, 5)).source).toEqual(span(6, 1, 6, 3));
    expect(map.lookup(at(1, 9)).source).toEqual(span(6, 1, 6, 3));
    expect(map.lookup(at(1, 10)).source).toBeNull(); // 显式不可映射，不回落行级
    expect(map.segmentCount).toBe(2);
  });

  it('分段列号必须严格递增；未登记的行不能挂分段', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(5, 1, 5, 20) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 5, source: null });
    expect(() => builder.appendSegment({ generatedLine: 1, generatedColumn: 5, source: null })).toThrow(/严格递增/);
    expect(() => builder.appendSegment({ generatedLine: 2, generatedColumn: 1, source: null })).toThrow(/尚未登记/);
  });

  it('CJK / 代理对列按 UTF-16 码元（调用方口径一致即可）', () => {
    const builder = createSourceMapBuilder();
    // 产物 `😀灵梦`：emoji 占 2 码元，所以「灵」从第 3 列开始
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(1, 1, 1, 7) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: span(2, 1, 2, 3) });
    const map = builder.build();
    expect(map.lookup(at(1, 2)).source).toEqual(span(1, 1, 1, 7));
    expect(map.lookup(at(1, 3)).source).toEqual(span(2, 1, 2, 3));
  });
});

describe('SourceMapBuilder · 模板/池展开与一源多产物', () => {
  it('模板展开 1 源行 → 3 产物行；每行同时指向调用处与模板定义', () => {
    const callSite = span(10, 5, 10, 20);
    const templateDefinition = span(30, 1, 32, 10);
    const builder = createSourceMapBuilder();
    for (let line = 1; line <= 3; line++) {
      builder.appendLine({
        generatedLine: line,
        kind: 'template',
        source: templateDefinition,
        origins: [
          { kind: 'call-site', span: callSite },
          { kind: 'template-definition', span: templateDefinition },
        ],
      });
    }
    const map = builder.build();
    expect(map.generatedLinesFor(templateDefinition)).toEqual([1, 2, 3]);
    const hit = map.lookup(at(2, 1));
    expect(hit.line?.origins.map((o) => o.kind)).toEqual(['call-site', 'template-definition']);
    expect(hit.origins[0]!.span).toEqual(callSite);
  });

  it('模板/池缺双向锚点 → 抛错（§10.7 要求同时指向调用处与定义处）', () => {
    const builder = createSourceMapBuilder();
    expect(() =>
      builder.appendLine({ generatedLine: 1, kind: 'template', source: span(1, 1, 1, 2) }),
    ).toThrow(/call-site/);
    expect(() =>
      builder.appendLine({
        generatedLine: 1,
        kind: 'pool',
        source: span(1, 1, 1, 2),
        origins: [{ kind: 'call-site', span: span(5, 1, 5, 2) }],
      }),
    ).toThrow(/pool-definition/);
  });

  it('同一源行映射到多个产物行（反向查询全部命中）', () => {
    const source = span(4, 1, 4, 12);
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source });
    builder.appendLine({ generatedLine: 2, kind: 'source', source });
    builder.appendLine({ generatedLine: 3, kind: 'source', source: span(8, 1, 8, 2) });
    const map = builder.build();
    expect(map.generatedLinesFor(source)).toEqual([1, 2]);
  });

  it('反向查询也覆盖列级分段指向的源', () => {
    const fine = span(6, 3, 6, 9);
    const builder = createSourceMapBuilder();
    builder.appendLine({ generatedLine: 1, kind: 'source', source: span(5, 1, 5, 20) });
    builder.appendSegment({ generatedLine: 1, generatedColumn: 3, source: fine });
    const map = builder.build();
    expect(map.generatedLinesFor(fine)).toEqual([1]);
  });
});

describe('source map 工具', () => {
  it('sourceSpanContains：半开区间 [start, end)', () => {
    const s = span(2, 3, 2, 6);
    expect(sourceSpanContains(s, at(2, 3))).toBe(true);
    expect(sourceSpanContains(s, at(2, 5))).toBe(true);
    expect(sourceSpanContains(s, at(2, 6))).toBe(false);
    expect(sourceSpanContains(s, at(2, 2))).toBe(false);
    expect(sourceSpanContains(s, at(3, 3))).toBe(false);
  });
});
