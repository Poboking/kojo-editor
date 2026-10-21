/**
 * K2-SOURCEMAP-HOST · 预览面板数据模型的行为闸。
 *
 * 覆盖：真 core 编译 fixture → 预览行 / 源 ↔ 预览滚动 / 诊断气泡叠加 / 懒构建 /
 * 空产物与不同源守卫。诊断用 core 的 `KojoDiagnostic` 形状（真实 report 产出 + 精确列用例）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GameAdapter, KojoDiagnostic, KojoEmitBackend, KojoSpan } from '@kojo/kojo-core';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  createSourceMapBuilder,
} from '@kojo/kojo-core';
import type { Kojo2SourceMapModel } from '../src/monaco/kojo2-sourcemap-model';
import {
  buildKojo2SourceMapModel,
  splitKojo2GeneratedLines,
} from '../src/monaco/kojo2-sourcemap-model';
import {
  buildKojo2PreviewModel,
  type Kojo2PreviewModel,
} from '../src/ui/kojo2-preview-model';

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
const SOURCE_MAP = buildKojo2SourceMapModel(COMPILED);
const PREVIEW = buildKojo2PreviewModel(COMPILED, SOURCE_MAP);

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

function rowOf(preview: Kojo2PreviewModel, needle: string): ReturnType<Kojo2PreviewModel['rowAt']> {
  const row = preview.rows.find((item) => item.text.includes(needle));
  if (row === undefined) throw new Error(`预览里找不到行：${needle}`);
  return row;
}

function diagnosticOf(
  code: string,
  severity: KojoDiagnostic['severity'],
  span: KojoSpan | null,
  message = code,
): KojoDiagnostic {
  return { code, severity, message, span } as KojoDiagnostic;
}

function pointSpan(line: number, column: number): KojoSpan {
  return { start: { line, column }, end: { line, column } };
}

/* ============================== 预览行 ============================== */

describe('kojo2 预览模型 · 预览行', () => {
  it('行数/文本与产物逐行一致，每行带 kojoRange / kind', () => {
    expect(PREVIEW.lineCount).toBe(ERB_LINES.length);
    expect(PREVIEW.rows).toHaveLength(ERB_LINES.length);
    PREVIEW.rows.forEach((row, index) => {
      expect(row.line).toBe(index + 1);
      expect(row.text).toBe(ERB_LINES[index]);
      expect(row.diagnostics).toEqual([]);
      expect(row.severity).toBeNull();
      if (row.text.includes('MACHINE 开场')) expect(row.kojoRange?.start.line).toBe(sourceLineOf('# 机 开场'));
      if (row.text.includes('TELL: 晨光')) {
        expect(row.kojoRange?.start.line).toBe(sourceLineOf('> 晨光 🏮'));
        expect(row.kind).toBe('source');
      }
    });
    expect(PREVIEW.rows).toBe(PREVIEW.rows); // 懒构建一次，数组身份稳定
  });

  it('rowAt 越界 clamp；空预览 = null', () => {
    expect(PREVIEW.rowAt(1)?.line).toBe(1);
    expect(PREVIEW.rowAt(0)?.line).toBe(1);
    expect(PREVIEW.rowAt(-5)?.line).toBe(1);
    expect(PREVIEW.rowAt(1.9)?.line).toBe(1);
    expect(PREVIEW.rowAt(9999)?.line).toBe(ERB_LINES.length);
    expect(PREVIEW.diagnosticsAt(0)).toEqual([]);
    expect(PREVIEW.diagnosticsAt(9999)).toEqual([]);

    const failed = compileKojoSource({
      source: ['# 机 不存在的开场', '> 甲', ''].join('\n'),
      filePath: 'empty.kojo2',
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });
    const map = buildKojo2SourceMapModel(failed);
    const preview = buildKojo2PreviewModel(failed, map);
    expect(preview.lineCount).toBe(0);
    expect(preview.rows).toEqual([]);
    expect(preview.rowAt(1)).toBeNull();
    expect(preview.diagnosticsAt(1)).toEqual([]);
  });

  it('预览与 source map 不同源 ⇒ 抛 TypeError（不画错位行）', () => {
    const other = buildKojo2SourceMapModel({
      erb: 'only one line\n',
      sourceMap: createSourceMapBuilder().build(),
    });
    expect(() => buildKojo2PreviewModel({ erb: 'a\nb\n', diagnostics: [] }, other)).toThrow(TypeError);
  });
});

/* ============================== 滚动目标 ============================== */

describe('kojo2 预览模型 · 源码 ↔ 预览滚动', () => {
  it('源码行精确命中 → 该行首个预览行', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮');
    expect(PREVIEW.previewLineForSourceLine(sourceLine)).toBe(
      generatedLineOf('TELL: 晨光 🏮'),
    );
    expect(PREVIEW.sourceLineForPreviewLine(generatedLineOf('TELL: 晨光 🏮'))).toBe(sourceLine);
  });

  it('模板/池调用处 → 展开首行（origins 参与滚动索引）', () => {
    expect(PREVIEW.previewLineForSourceLine(sourceLineOf('! 问候'))).toBe(
      generatedLineOf('IF {恋慕 < 100}'),
    );
    expect(PREVIEW.previewLineForSourceLine(sourceLineOf('! 退场("被夸奖")'))).toBe(
      generatedLineOf('TELL: （因为被夸奖，她退开了）'),
    );
  });

  it('没有独立产物的源行滚到前面最近的映射行；早于/晚于全部映射按 clamp 口径', () => {
    // `# 常量 无关` 不产字节，前面最近的是 @原生 第二行
    expect(PREVIEW.previewLineForSourceLine(sourceLineOf('# 常量 无关'))).toBe(
      generatedLineOf('CALL HPH_PRINT "w"'),
    );
    expect(PREVIEW.previewLineForSourceLine(1)).toBe(1); // 文件头注释在首个映射行之前
    expect(PREVIEW.previewLineForSourceLine(0)).toBe(1);
    expect(PREVIEW.previewLineForSourceLine(Number.NaN)).toBe(1);
    expect(PREVIEW.previewLineForSourceLine(9999)).toBe(ERB_LINES.length); // 最后一个已映射行
  });

  it('预览行 → 源码行：越界 clamp，未映射 = null', () => {
    const textRow = rowOf(PREVIEW, 'TELL: 晨光 🏮')!;
    expect(PREVIEW.sourceLineForPreviewLine(textRow.line)).toBe(sourceLineOf('> 晨光 🏮'));
    expect(PREVIEW.sourceLineForPreviewLine(0)).toBe(PREVIEW.sourceLineForPreviewLine(1));
    expect(PREVIEW.sourceLineForPreviewLine(9999)).toBe(
      PREVIEW.sourceLineForPreviewLine(ERB_LINES.length),
    );
  });

  it('空预览 / 完全无映射：滚动目标为 null（不伪造）', () => {
    const empty = buildKojo2PreviewModel(
      { erb: '', diagnostics: [] },
      buildKojo2SourceMapModel({ erb: '', sourceMap: createSourceMapBuilder().build() }),
    );
    expect(empty.previewLineForSourceLine(1)).toBeNull();
    expect(empty.sourceLineForPreviewLine(1)).toBeNull();

    const unmappedMap = buildKojo2SourceMapModel({
      erb: 'plain\ntext\n',
      sourceMap: createSourceMapBuilder().build(),
    });
    const unmapped = buildKojo2PreviewModel({ erb: 'plain\ntext\n', diagnostics: [] }, unmappedMap);
    expect(unmapped.lineCount).toBe(2);
    expect(unmapped.rows.every((row) => row.kojoRange === null)).toBe(true);
    expect(unmapped.previewLineForSourceLine(1)).toBeNull();
    expect(unmapped.sourceLineForPreviewLine(1)).toBeNull();
  });

  it('generated 行（source === null）没有 kojoRange，跳回源码 = null', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({
      generatedLine: 1,
      kind: 'source',
      source: { start: { line: 3, column: 1 }, end: { line: 3, column: 5 } },
    });
    builder.appendLine({ generatedLine: 2, kind: 'generated', source: null });
    const map = buildKojo2SourceMapModel({ erb: 'TELL: x\nENDIF\n', sourceMap: builder.build() });
    const preview = buildKojo2PreviewModel({ erb: 'TELL: x\nENDIF\n', diagnostics: [] }, map);
    expect(preview.rows[0]?.kojoRange?.start.line).toBe(3);
    expect(preview.rows[1]?.kojoRange).toBeNull();
    expect(preview.rows[1]?.kind).toBe('generated');
    expect(preview.sourceLineForPreviewLine(2)).toBeNull();
    expect(preview.previewLineForSourceLine(3)).toBe(1);
  });
});

/* ============================== 诊断叠加 ============================== */

describe('kojo2 预览模型 · 诊断气泡叠加', () => {
  it('精确列区间挂到对应预览行：列按 UTF-16 码元投影、severity 汇总', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮');
    const diagnostic = diagnosticOf('core/expr/type-mismatch', 'error', {
      start: { line: sourceLine, column: 4 },
      end: { line: sourceLine, column: 7 },
    });
    const preview = buildKojo2PreviewModel(
      { erb: COMPILED.erb, diagnostics: [diagnostic] },
      SOURCE_MAP,
    );
    const row = preview.rows.find((item) => item.text.includes('TELL: 晨光 🏮'))!;
    expect(row.diagnostics).toHaveLength(1);
    expect(row.diagnostics[0]).toMatchObject({
      index: 0,
      code: 'core/expr/type-mismatch',
      severity: 'error',
      columns: { start: 4, end: 7 },
    });
    expect(row.severity).toBe('error');
    expect(preview.diagnosticsAt(row.line)).toBe(row.diagnostics);
    expect(preview.unlocatedDiagnostics).toEqual([]);
  });

  it('零宽诊断照挂（列区间允许 start === end，UI 自行扩格）', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮');
    const diagnostic = diagnosticOf('core/expr/not-expression', 'warning', pointSpan(sourceLine, 5));
    const preview = buildKojo2PreviewModel(
      { erb: COMPILED.erb, diagnostics: [diagnostic] },
      SOURCE_MAP,
    );
    const row = preview.rows.find((item) => item.text.includes('TELL: 晨光 🏮'))!;
    expect(row.diagnostics).toHaveLength(1);
    expect(row.diagnostics[0]?.columns).toEqual({ start: 5, end: 5 });
    expect(row.severity).toBe('warning');
  });

  it('真 core warning（选项待定）叠到 OPTIONS 展开行，列不越出行宽', () => {
    // `选项` 主链是 fail-closed 的：adapter 不声明 UI 能力就只出 error、零字节。
    // 要测"待定 warning + 产物行"，adapter 必须真声明 options（fixture 的 adapter 默认是 null）。
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      presentation: {
        ...FIXTURE_ADAPTER.presentation,
        options: {
          status: 'pending',
          button: 'BUTTON',
          input: 'INPUTS',
          result: 'RESULTS',
          maxPerScene: 1,
        },
      },
    };
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      profile: {
        ...FIXTURE_BACKEND.profile,
        presentations: { ...FIXTURE_BACKEND.profile.presentations, options: true },
      },
    };
    const source = ['# 机 开场', '# 视 灵梦', '选项：', '    「标签」：', '        > 选项正文。', ''].join('\n');
    const compiled = compileKojoSource({
      source,
      filePath: 'options.kojo2',
      adapter,
      backend,
    });
    expect(compiled.ok).toBe(true);
    const warning = compiled.diagnostics.find((item) => item.code === 'core/options/pending');
    expect(warning?.severity).toBe('warning');

    const preview = buildKojo2PreviewModel(compiled, buildKojo2SourceMapModel(compiled));
    const rows = preview.rows.filter((row) =>
      row.diagnostics.some((item) => item.code === 'core/options/pending'),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.severity).toBe('warning');
      for (const item of row.diagnostics) {
        expect(item.columns).not.toBeNull();
        expect(item.columns!.start).toBeGreaterThanOrEqual(1);
        expect(item.columns!.end).toBeGreaterThanOrEqual(item.columns!.start);
        expect(item.columns!.end).toBeLessThanOrEqual(row.text.length + 1);
      }
    }
  });

  it('多条诊断同行按输入顺序；error 压过 warning 汇总', () => {
    const sourceLine = sourceLineOf('> 晨光 🏮');
    const diagnostics = [
      diagnosticOf('core/expr/type-mismatch', 'warning', {
        start: { line: sourceLine, column: 2 },
        end: { line: sourceLine, column: 4 },
      }),
      diagnosticOf('core/expr/unknown-symbol', 'error', {
        start: { line: sourceLine, column: 4 },
        end: { line: sourceLine, column: 6 },
      }),
    ];
    const preview = buildKojo2PreviewModel({ erb: COMPILED.erb, diagnostics }, SOURCE_MAP);
    const row = preview.rows.find((item) => item.text.includes('TELL: 晨光 🏮'))!;
    expect(row.diagnostics.map((item) => item.index)).toEqual([0, 1]);
    expect(row.diagnostics.map((item) => item.severity)).toEqual(['warning', 'error']);
    expect(row.severity).toBe('error');
  });

  it('落不到产物的诊断进 unlocatedDiagnostics（无 span / 注释 / 常量声明）', () => {
    const diagnostics = [
      diagnosticOf('core/wait/no-profile', 'error', null),
      diagnosticOf('core/expr/unknown-symbol', 'error', pointSpan(1, 2)),
      diagnosticOf('core/expr/bad-index', 'error', pointSpan(sourceLineOf('# 常量 无关'), 3)),
    ];
    const preview = buildKojo2PreviewModel({ erb: COMPILED.erb, diagnostics }, SOURCE_MAP);
    expect(preview.unlocatedDiagnostics).toEqual(diagnostics);
    expect(preview.rows.every((row) => row.diagnostics.length === 0)).toBe(true);
    expect(preview.rows.every((row) => row.severity === null)).toBe(true);
  });

  it('多行源 span（块级诊断）覆盖该块产出的每一行', () => {
    const poolLine = sourceLineOf('# 池 问候');
    const diagnostic = diagnosticOf('core/pool/no-default', 'error', {
      start: { line: poolLine, column: 1 },
      end: { line: poolLine + 5, column: 1 },
    });
    const preview = buildKojo2PreviewModel(
      { erb: COMPILED.erb, diagnostics: [diagnostic] },
      SOURCE_MAP,
    );
    const attached = preview.rows.filter((row) => row.diagnostics.length > 0);
    expect(attached.length).toBeGreaterThan(1);
    // 池块声明的 origins 会覆盖整个池（含定义处），命中池展开行
    expect(attached.some((row) => row.text.includes('IF {恋慕 < 100}'))).toBe(true);
    for (const row of attached) {
      expect(row.kojoRange).not.toBeNull();
    }
  });
});

/* ============================== 懒构建 ============================== */

describe('kojo2 预览模型 · 大文件懒构建', () => {
  it('构造不读行；rows 首次访问才走 lineAt（每行一次）', () => {
    let lineAtCalls = 0;
    let rangeCalls = 0;
    const stub: Kojo2SourceMapModel = {
      generatedLineCount: 3,
      lineAt() {
        lineAtCalls += 1;
        return null;
      },
      kojoToGenerated: () => undefined,
      generatedToKojo: () => undefined,
      generatedInRange() {
        rangeCalls += 1;
        return [];
      },
    };
    const preview = buildKojo2PreviewModel(
      {
        erb: 'a\nb\nc\n',
        diagnostics: [diagnosticOf('core/expr/type-mismatch', 'error', pointSpan(1, 1))],
      },
      stub,
    );
    expect(lineAtCalls).toBe(0);
    expect(rangeCalls).toBe(0);

    expect(preview.lineCount).toBe(3);
    expect(lineAtCalls).toBe(0);
    expect(preview.unlocatedDiagnostics).toHaveLength(1);
    expect(rangeCalls).toBe(1);
    expect(lineAtCalls).toBe(0);

    expect(preview.rows).toHaveLength(3);
    expect(lineAtCalls).toBe(3); // 一次构建，每行查一次；再次访问不重查
    expect(preview.rows).toHaveLength(3);
    expect(lineAtCalls).toBe(3);
    expect(rangeCalls).toBe(1); // 诊断叠加只建一次
  });
});
