/**
 * K2-SOURCEMAP-HOST · 宿主 source map 模型的行为闸。
 *
 * 覆盖：真 core 编译 fixture（.kojo2）→ 双向映射 / UTF-16 列 / 越界与缺失 / 区间查询 /
 * 随机采样往返；边界用 core 的 `createSourceMapBuilder` 造真实 `SourceMap`（不手搓形状）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { KojoPosition, KojoSpan } from '@kojo/kojo-core';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  createSourceMapBuilder,
  sourceSpanContains,
} from '@kojo/kojo-core';
import {
  buildKojo2SourceMapModel,
  splitKojo2GeneratedLines,
  type Kojo2SourceMapModel,
} from '../src/monaco/kojo2-sourcemap-model';

const FIXTURE = readFileSync(
  fileURLToPath(new URL('./fixtures/kojo2/sourcemap-preview.kojo2', import.meta.url)),
  'utf8',
);
const SOURCE_LINES = FIXTURE.split('\n');

const COMPILED = compileKojoSource({
  source: FIXTURE,
  filePath: 'sourcemap-preview.kojo2',
  adapter: FIXTURE_ADAPTER,
  backend: FIXTURE_BACKEND,
});
const ERB_LINES = splitKojo2GeneratedLines(COMPILED.erb);
const MODEL = buildKojo2SourceMapModel(COMPILED);

function sourceLineOf(needle: string): number {
  const index = SOURCE_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture 里找不到源行：${needle}`);
  return index + 1;
}

function generatedLineOf(needle: string): number {
  const index = ERB_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`产物里找不到行：${needle}\n${COMPILED.erb}`);
  return index + 1;
}

/** 断言位置落在半开 span 内（复用 core 的唯一判定，不在测试里另写一套） */
function expectInside(span: KojoSpan, at: KojoPosition): void {
  expect(sourceSpanContains(span, at)).toBe(true);
}

/* ============================== 真 core fixture ============================== */

describe('kojo2 source map 模型 · 真 core 编译 fixture', () => {
  it('fixture 本身编译成功（不拿错误产物测映射）', () => {
    expect(COMPILED.ok).toBe(true);
    expect(COMPILED.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(ERB_LINES.length).toBeGreaterThan(10);
    expect(COMPILED.sourceMap.lineCount).toBe(ERB_LINES.length);
    expect(MODEL.generatedLineCount).toBe(ERB_LINES.length);
  });

  it('产物行 → 源行：文本 / 原生 / 包装头各自落对，且空行有主映射', () => {
    const text = MODEL.generatedToKojo({
      line: generatedLineOf('TELL: 晨光 🏮 透过鸟居。'),
      column: 1,
    });
    expect(text?.line).toBe(sourceLineOf('> 晨光 🏮 透过鸟居。'));

    const nativeLine = generatedLineOf('; raw 🧵 line');
    expect(MODEL.lineAt(nativeLine)?.kind).toBe('native');
    expect(MODEL.generatedToKojo({ line: nativeLine, column: 1 })).toEqual({
      line: sourceLineOf('; raw 🧵 line'),
      column: 1,
    });

    expect(MODEL.generatedToKojo({ line: 1, column: 1 })?.line).toBe(sourceLineOf('# 机 开场'));
    expect(MODEL.generatedToKojo({ line: ERB_LINES.length, column: 1 })?.line).toBe(
      sourceLineOf('@织 开场'),
    );
  });

  it('每一条有主映射的产物行都能反向回源（没有“登记了却查不到”的行）', () => {
    for (let line = 1; line <= ERB_LINES.length; line++) {
      const mapping = MODEL.lineAt(line);
      if (mapping?.source == null) continue;
      const back = MODEL.generatedToKojo({ line, column: 1 });
      expect(back, `产物第 ${line} 行（${mapping.kind}）反向查询落空`).toBeDefined();
      expectInside(mapping.source, back!);
    }
  });
});

/* ============================== 双向 + UTF-16 ============================== */

describe('kojo2 source map 模型 · 双向映射与 UTF-16 列', () => {
  it('源码 → 产物 → 源码：中文/emoji 行的码元偏移逐列对得上', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮 透过鸟居。');
    const generatedLine = generatedLineOf('TELL: 晨光 🏮 透过鸟居。');
    const text = SOURCE_LINES[sourceLine - 1]!;
    const emojiAt = text.indexOf('🏮');
    // 1 基列：emoji 占两个 UTF-16 码元 ⇒ emoji 后一列的列号 = 0 基下标 + 3
    const afterEmoji = emojiAt + 3;
    expect(text.slice(emojiAt, emojiAt + 2)).toBe('🏮');

    const generated = MODEL.kojoToGenerated({ line: sourceLine, column: afterEmoji });
    expect(generated).toEqual({ line: generatedLine, column: afterEmoji });
    const back = MODEL.generatedToKojo(generated!);
    expect(back).toEqual({ line: sourceLine, column: afterEmoji });
  });

  it('@原生 逐行透传：生成列与源列同构（含代理对，不按码点重算）', () => {
    const sourceLine = sourceLineOf('; raw 🧵 line');
    const generatedLine = generatedLineOf('; raw 🧵 line');
    // 源行有 4 空格缩进，但 @原生 映射是“去缩进后的物理行文本”，锚在第 1 列
    expect(MODEL.kojoToGenerated({ line: sourceLine, column: 3 })).toEqual({
      line: generatedLine,
      column: 3,
    });
    expect(MODEL.generatedToKojo({ line: generatedLine, column: 3 })).toEqual({
      line: sourceLine,
      column: 3,
    });
  });

  it('模板展开：定义行 ↔ 展开行往返；调用处经 origins 也能正向落到展开首行', () => {
    const templateLine = sourceLineOf('（因为{原因}，她退开了）');
    // 文本节点 span 从内容列起算（fixture 里 `>` 前有 4 个空格 ⇒ 第 5 列）
    const contentColumn = SOURCE_LINES[templateLine - 1]!.indexOf('>') + 1;
    const expansionLine = generatedLineOf('TELL: （因为被夸奖，她退开了）');
    expect(MODEL.lineAt(expansionLine)?.kind).toBe('template');
    expect(MODEL.kojoToGenerated({ line: templateLine, column: contentColumn })).toEqual({
      line: expansionLine,
      column: 1,
    });
    expect(MODEL.generatedToKojo({ line: expansionLine, column: 1 })).toEqual({
      line: templateLine,
      column: contentColumn,
    });

    const callLine = sourceLineOf('! 退场("被夸奖")');
    expect(MODEL.kojoToGenerated({ line: callLine, column: 1 })).toEqual({
      line: expansionLine,
      column: 1,
    });
  });

  it('池展开：调用处 → 展开首行（`IF` 头），且展开行 kind = pool', () => {
    const callLine = sourceLineOf('! 问候');
    const ifLine = generatedLineOf('IF {恋慕 < 100}');
    expect(MODEL.lineAt(ifLine)?.kind).toBe('pool');
    expect(MODEL.kojoToGenerated({ line: callLine, column: 1 })).toEqual({
      line: ifLine,
      column: 1,
    });
  });

  it('随机采样：源码 → 产物 → 源码仍落在同一映射区间（200 个位置）', () => {
    let state = 0x2f6e2b1;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const spans: { readonly line: number; readonly span: KojoSpan }[] = [];
    for (let line = 1; line <= ERB_LINES.length; line++) {
      const source = MODEL.lineAt(line)?.source;
      if (source == null || source.start.line !== source.end.line) continue;
      spans.push({ line, span: source });
    }
    expect(spans.length).toBeGreaterThan(5);

    for (let index = 0; index < 200; index++) {
      const pick = spans[Math.floor(random() * spans.length)]!;
      const width = Math.max(1, pick.span.end.column - pick.span.start.column);
      const column = pick.span.start.column + Math.floor(random() * width);
      const generated = MODEL.kojoToGenerated({ line: pick.span.start.line, column });
      expect(generated, `源 ${pick.span.start.line}:${column} 正向查询落空`).toBeDefined();
      const back = MODEL.generatedToKojo(generated!);
      expect(back, `源 ${pick.span.start.line}:${column} 往返落空`).toBeDefined();
      expectInside(pick.span, back!);
    }
  });
});

/* ============================== 越界 / 缺失 / 空 map ============================== */

describe('kojo2 source map 模型 · 越界与缺失映射', () => {
  it('不产字节且没有 origins 的源行（注释 / 常量声明）显式 undefined，不借邻居行', () => {
    expect(MODEL.kojoToGenerated({ line: 1, column: 1 })).toBeUndefined(); // 文件头注释
    expect(MODEL.kojoToGenerated({ line: sourceLineOf('# 常量 无关'), column: 1 })).toBeUndefined();
    // `# 表`/`# 池`/`# 模` 的声明行不是“无映射”：表展开的 ENDIF 与展开 origins 会覆盖它们
    expect(MODEL.kojoToGenerated({ line: sourceLineOf('# 表 心情 由 恋慕'), column: 1 })).toBeDefined();
  });

  it('源侧非法/越界位置 → undefined；生成侧越界 → clamp', () => {
    expect(MODEL.kojoToGenerated({ line: 0, column: 1 })).toBeUndefined();
    expect(MODEL.kojoToGenerated({ line: 1, column: 0 })).toBeUndefined();
    expect(MODEL.kojoToGenerated({ line: 1.5, column: 1 })).toBeUndefined();
    expect(MODEL.kojoToGenerated({ line: sourceLineOf('> 晨光 🏮'), column: 999 })).toBeUndefined();

    const last = MODEL.generatedToKojo({ line: 9999, column: 9999 });
    expect(last).toBeDefined();
    expect(last!.line).toBe(sourceLineOf('@织 开场'));
    expect(MODEL.generatedToKojo({ line: 0, column: 0 })).toEqual({
      line: sourceLineOf('# 机 开场'),
      column: 1,
    });
    expect(MODEL.lineAt(0)).toBeNull();
    expect(MODEL.lineAt(ERB_LINES.length + 1)).toBeNull();
  });

  it('空 map：所有查询显式落空（不抛错、不伪造）', () => {
    const empty: Kojo2SourceMapModel = buildKojo2SourceMapModel({
      erb: '',
      sourceMap: createSourceMapBuilder().build(),
    });
    expect(empty.generatedLineCount).toBe(0);
    expect(empty.lineAt(1)).toBeNull();
    expect(empty.kojoToGenerated({ line: 1, column: 1 })).toBeUndefined();
    expect(empty.generatedToKojo({ line: 1, column: 1 })).toBeUndefined();
    expect(empty.generatedInRange({ line: 1, column: 1 }, { line: 2, column: 2 })).toEqual([]);
  });

  it('generated 行与越界列：反查 undefined，列 clamp 不越出行宽', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({
      generatedLine: 1,
      kind: 'source',
      source: { start: { line: 10, column: 1 }, end: { line: 10, column: 4 } },
    });
    builder.appendLine({ generatedLine: 2, kind: 'generated', source: null });
    builder.appendLine({
      generatedLine: 3,
      kind: 'source',
      source: { start: { line: 12, column: 2 }, end: { line: 12, column: 6 } },
    });
    const model = buildKojo2SourceMapModel({
      erb: 'abc\ndef\nxyzw\n',
      sourceMap: builder.build(),
    });

    expect(model.generatedToKojo({ line: 2, column: 1 })).toBeUndefined();
    expect(model.generatedToKojo({ line: 1, column: 4 })).toEqual({ line: 10, column: 3 });
    expect(model.generatedToKojo({ line: 1, column: 99 })).toEqual({ line: 10, column: 3 });
    expect(model.kojoToGenerated({ line: 10, column: 4 })).toBeUndefined(); // span 半开
    expect(model.kojoToGenerated({ line: 12, column: 2 })).toEqual({ line: 3, column: 1 });
    expect(model.kojoToGenerated({ line: 12, column: 5 })).toEqual({ line: 3, column: 4 });
  });
});

/* ============================== 区间查询 ============================== */

describe('kojo2 source map 模型 · generatedInRange', () => {
  it('整行源区间 → 该产物行；列按码元偏移投影（终点是半开）', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮 透过鸟居。');
    const generatedLine = generatedLineOf('TELL: 晨光 🏮 透过鸟居。');
    const sourceLength = SOURCE_LINES[sourceLine - 1]!.length;
    const ranges = MODEL.generatedInRange(
      { line: sourceLine, column: 1 },
      { line: sourceLine, column: sourceLength + 1 },
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      generatedLine,
      startColumn: 1,
      endColumn: sourceLength + 1,
      kind: 'source',
      via: 'source',
    });
    expect(ranges[0]!.source.start.line).toBe(sourceLine);
  });

  it('部分区间 / 点查询：零宽源区间给零宽产物区间', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮 透过鸟居。');
    const generatedLine = generatedLineOf('TELL: 晨光 🏮 透过鸟居。');
    const partial = MODEL.generatedInRange(
      { line: sourceLine, column: 4 },
      { line: sourceLine, column: 7 },
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ generatedLine, startColumn: 4, endColumn: 7 });

    const point = MODEL.generatedInRange(
      { line: sourceLine, column: 5 },
      { line: sourceLine, column: 5 },
    );
    expect(point).toHaveLength(1);
    expect(point[0]).toMatchObject({ generatedLine, startColumn: 5, endColumn: 5 });
  });

  it('反向区间 / 空 map / 非法端点 → 空数组（不抛错）', () => {
    expect(
      MODEL.generatedInRange({ line: 10, column: 5 }, { line: 9, column: 1 }),
    ).toEqual([]);
    expect(MODEL.generatedInRange({ line: 0, column: 1 }, { line: 1, column: 1 })).toEqual([]);
    expect(MODEL.generatedInRange({ line: 1, column: 1 }, { line: 1, column: 1.5 })).toEqual([]);
  });

  it('调用处 / 池定义处经 origins 命中展开行（via = origin）', () => {
    const callLine = sourceLineOf('! 问候');
    const ranges = MODEL.generatedInRange(
      { line: callLine, column: 1 },
      { line: callLine, column: SOURCE_LINES[callLine - 1]!.length + 1 },
    );
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges.every((range) => range.via === 'origin')).toBe(true);
    expect(ranges.map((range) => range.generatedLine)).toContain(generatedLineOf('IF {恋慕 < 100}'));
    expect(ranges.map((range) => range.generatedLine)).toContain(
      generatedLineOf('TELL: 她抬了下眼 🌅。'),
    );
  });

  it('结果升序、每行至多一条（供 UI 直接画高亮）', () => {
    const ranges = MODEL.generatedInRange({ line: 1, column: 1 }, { line: 9999, column: 1 });
    expect(ranges.length).toBeGreaterThan(0);
    const lines = ranges.map((range) => range.generatedLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(new Set(lines).size).toBe(lines.length);
    for (const range of ranges) {
      expect(range.startColumn).toBeGreaterThanOrEqual(1);
      expect(range.endColumn).toBeGreaterThanOrEqual(range.startColumn);
      expect(range.endColumn).toBeLessThanOrEqual(ERB_LINES[range.generatedLine - 1]!.length + 1);
    }
  });
});
