/**
 * K2-PREVIEW-PANEL · 预览面板的渲染 / 跳转 / 滚动同步 / 窗口化 / 诊断闸。
 *
 * 手法与既有面板渲染闸同一条：仓库测试环境是 node（无 jsdom），用 `react-dom/server`
 * 做静态渲染——足够钉住"给定编译结果 ⇒ 面板产出什么"，事件层（点击 / 滚动）走
 * `renderPreviewRows` 的纯元素与 `scrollPreviewToSource` 的桩容器，不需要 DOM。
 *
 * 数据全部来自**真 core 编译**（`fixtures/kojo2/sourcemap-preview.kojo2`）+ 真 source map
 * 模型；诊断按 core 的 `KojoDiagnostic` 形状叠在真实列上（与 `kojo2-preview-model.test.ts`
 * 同一份 fixture，两层的行号口径因此逐字一致）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { KojoDiagnostic, KojoSpan } from '@kojo/kojo-core';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  createSourceMapBuilder,
} from '@kojo/kojo-core';
import {
  buildKojo2SourceMapModel,
  splitKojo2GeneratedLines,
  type Kojo2SourceMapModel,
} from '@kojo/kojo-lang';
import {
  buildKojo2PreviewModel,
  type Kojo2PreviewCompileResult,
  type Kojo2PreviewModel,
} from '../src/ui/kojo2-preview-model';
import {
  KOJO2_PREVIEW_KIND_MARKS,
  KOJO2_PREVIEW_ROW_HEIGHT,
  Kojo2PreviewPanel,
  normalizePreviewMetrics,
  previewScrollPlanFor,
  previewScrollTopForLine,
  previewWindowFor,
  quantizePreviewScrollTop,
  renderPreviewRows,
  scrollPreviewToSource,
  type Kojo2PreviewMetrics,
  type Kojo2PreviewPanelProps,
} from '../src/ui/kojo2-preview-panel';
import {
  createKojo2PreviewEntry,
  kojo2PreviewEnabled,
  type Kojo2PreviewCompilation,
  type Kojo2PreviewCursorSource,
} from '../src/ui/kojo2-preview-entry';

/* ============================== fixture ============================== */

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
const EMPTY_COMPILED: Kojo2PreviewCompileResult = { erb: '', diagnostics: [] };

function sourceLineOf(needle: string): number {
  const index = SOURCE_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture 里找不到源行：${needle}`);
  return index + 1;
}

function generatedLineOf(needle: string): number {
  const index = ERB_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`产物里找不到行：${needle}`);
  return index + 1;
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

/** 静态渲染整块面板（props 可覆盖；缺省 = 真编译 + 真 source map） */
function renderPanel(overrides: Partial<Kojo2PreviewPanelProps> = {}): string {
  return renderToStaticMarkup(
    createElement(Kojo2PreviewPanel, {
      compiled: COMPILED,
      sourceMapModel: SOURCE_MAP,
      onJumpToSource: () => undefined,
      ...overrides,
    }),
  );
}

/** 只把窗口里的行画成静态 HTML（与组件同一份 `renderPreviewRows`） */
function renderRows(
  model: Kojo2PreviewModel,
  window: ReturnType<typeof previewWindowFor>,
  options: Parameters<typeof renderPreviewRows>[2] = {},
): string {
  return renderToStaticMarkup(createElement(Fragment, null, ...renderPreviewRows(model, window, options)));
}

/** 面板里画了几行（行元素的 class 是稳定标记） */
function countRows(html: string): number {
  return (html.match(/class="kojo2-preview__row"/g) ?? []).length;
}

/** 窄视口：3 行可见 + 1 行缓冲 ⇒ 首帧窗口 = 第 1–4 行 */
const NARROW: Partial<Kojo2PreviewMetrics> = {
  rowHeight: KOJO2_PREVIEW_ROW_HEIGHT,
  viewportHeight: KOJO2_PREVIEW_ROW_HEIGHT * 3,
  overscan: 1,
  scrollTop: 0,
};

function rowElementAt(
  model: Kojo2PreviewModel,
  line: number,
  options: Parameters<typeof renderPreviewRows>[2] = {},
): ReturnType<typeof renderPreviewRows>[number] {
  // 把窗口滚到这一行附近（窗口 = 可见 ± buffer 的语义不变，只是换了个起点）
  const rows = renderPreviewRows(model, previewWindowFor(model, { ...NARROW, scrollTop: (line - 1) * KOJO2_PREVIEW_ROW_HEIGHT }), options);
  const found = rows.find(
    (element) => (element.props as { 'data-line'?: number })['data-line'] === line,
  );
  if (found === undefined) throw new Error(`窗口里没有第 ${line} 行`);
  return found;
}

/* ============================== 预览行渲染 ============================== */

describe('预览面板 · 行渲染', () => {
  it('首帧画行号 + 文本 + kind 标记（真编译产物逐行上屏）', () => {
    const html = renderPanel({ metrics: NARROW });
    expect(html).toContain('编译预览');
    expect(html).toContain(`${ERB_LINES.length} 行产物`);
    expect(countRows(html)).toBe(4);
    expect(html).toContain('data-line="1"');
    expect(html).toContain('MACHINE 开场');
    expect(html).toContain('data-kind="source"');
    expect(html).toContain('>源<');
  });

  it('kind 标记表与 core 的五档一一对应（不另造类别）', () => {
    expect(Object.keys(KOJO2_PREVIEW_KIND_MARKS).sort()).toEqual([
      'generated',
      'native',
      'pool',
      'source',
      'template',
    ]);
    const marks = Object.values(KOJO2_PREVIEW_KIND_MARKS);
    expect(new Set(marks.map((mark) => mark.glyph)).size).toBe(5); // 一字一档，不撞形
    for (const mark of marks) expect(mark.label.length).toBeGreaterThan(0);
  });

  it('模板 / 池 / 原生行各带自己的标记与锚点说明', () => {
    const html = renderPanel(); // 缺省视口 24 行 + 8 行缓冲 ⇒ 31 行全画
    expect(countRows(html)).toBe(ERB_LINES.length);
    expect(html).toContain('data-kind="pool"');
    expect(html).toContain('data-kind="template"');
    expect(html).toContain('data-kind="native"');
    expect(html).toContain('>池<');
    expect(html).toContain('>模<');
    expect(html).toContain('>原<');
    expect(html).toContain('处锚点');
  });

  it('空产物行用不换行空格占位（行高不塌）', () => {
    const erb = 'first\n\nthird\n';
    const map = buildKojo2SourceMapModel({ erb, sourceMap: createSourceMapBuilder().build() });
    const preview = buildKojo2PreviewModel({ erb, diagnostics: [] }, map);
    const html = renderRows(preview, previewWindowFor(preview, NARROW));
    expect(countRows(html)).toBe(3);
    expect(html).toContain('\u00a0');
  });

  it('空产物：给空态文案，不画行也不空转', () => {
    const map = buildKojo2SourceMapModel({
      erb: '',
      sourceMap: createSourceMapBuilder().build(),
    });
    const html = renderPanel({ compiled: EMPTY_COMPILED, sourceMapModel: map });
    expect(html).toContain('没有可预览的产物行');
    expect(countRows(html)).toBe(0);
  });

  it('两份模型不同源：画一条可见错误，绝不画错位的行', () => {
    const other = buildKojo2SourceMapModel({
      erb: 'only one line\n',
      sourceMap: createSourceMapBuilder().build(),
    });
    const html = renderPanel({ compiled: COMPILED, sourceMapModel: other });
    expect(html).toContain('kojo2-preview__error');
    expect(html).toContain('不同源');
    expect(countRows(html)).toBe(0);
  });
});

/* ============================== 窗口化 ============================== */

describe('预览面板 · 窗口化', () => {
  it('窗口 = 可见范围 ± overscan，首帧夹到文件头', () => {
    const window = previewWindowFor(PREVIEW, NARROW);
    expect(window.startLine).toBe(1);
    expect(window.endLine).toBe(4);
    expect(window.count).toBe(4);
    expect(window.topPadding).toBe(0);
    expect(window.bottomPadding).toBe((ERB_LINES.length - 4) * KOJO2_PREVIEW_ROW_HEIGHT);
    expect(window.totalHeight).toBe(ERB_LINES.length * KOJO2_PREVIEW_ROW_HEIGHT);
  });

  it('滚动后窗口平移：衬垫补齐，滚动条长度仍 = 全量', () => {
    const window = previewWindowFor(PREVIEW, { ...NARROW, scrollTop: 200 });
    expect(window.startLine).toBe(10);
    expect(window.endLine).toBe(14);
    expect(window.count).toBe(5);
    expect(window.topPadding).toBe(9 * KOJO2_PREVIEW_ROW_HEIGHT);
    expect(window.bottomPadding).toBe((ERB_LINES.length - 14) * KOJO2_PREVIEW_ROW_HEIGHT);
    expect(window.topPadding + window.count * KOJO2_PREVIEW_ROW_HEIGHT + window.bottomPadding).toBe(
      window.totalHeight,
    );
  });

  it('窗口计算只读 lineCount——不碰行数组、也不逐行查询', () => {
    const stub = {
      lineCount: 1_000_000,
      get rows(): never {
        throw new Error('窗口计算不许碰行数组');
      },
      rowAt(): never {
        throw new Error('窗口计算不许碰行');
      },
      previewLineForSourceLine: () => null,
      sourceLineForPreviewLine: () => null,
      diagnosticsAt: () => [],
      unlocatedDiagnostics: [],
    } as unknown as Kojo2PreviewModel;
    const window = previewWindowFor(stub, { ...NARROW, scrollTop: 500_000 * KOJO2_PREVIEW_ROW_HEIGHT });
    expect(window.count).toBe(5);
    expect(window.startLine).toBe(500_000);
  });

  it('组件只画窗口内的行（第 5 行不在首帧）', () => {
    const html = renderPanel({ metrics: NARROW });
    expect(html).toContain('data-line="4"');
    expect(html).not.toContain('data-line="5"');
    expect(html).toContain('data-window-start="1"');
    expect(html).toContain('data-window-end="4"');
  });

  it('5000 行产物滚到中段：只建窗口内的行元素（每行恰好查一次）', () => {
    const lineCount = 5000;
    const erb = Array.from({ length: lineCount }, (_, index) => `LINE ${index + 1}`).join('\n') + '\n';
    const map = buildKojo2SourceMapModel({ erb, sourceMap: createSourceMapBuilder().build() });
    const preview = buildKojo2PreviewModel({ erb, diagnostics: [] }, map);
    let rowAtCalls = 0;
    const spied = {
      ...preview,
      rowAt(line: number) {
        rowAtCalls += 1;
        return preview.rowAt(line);
      },
    } as Kojo2PreviewModel;

    const window = previewWindowFor(spied, {
      rowHeight: KOJO2_PREVIEW_ROW_HEIGHT,
      viewportHeight: KOJO2_PREVIEW_ROW_HEIGHT * 20,
      overscan: 4,
      scrollTop: 2500 * KOJO2_PREVIEW_ROW_HEIGHT,
    });
    expect(window.count).toBe(28);
    expect(rowAtCalls).toBe(0); // 算窗口不查行

    const rows = renderPreviewRows(spied, window);
    expect(rows).toHaveLength(window.count);
    expect(rowAtCalls).toBe(window.count); // 一次渲染 = 窗口行数，不是 5000
  });

  it('滚动量化到行边界：同一行内不换窗口（滚动不逐帧重渲）', () => {
    expect(quantizePreviewScrollTop(0)).toBe(0);
    expect(quantizePreviewScrollTop(19)).toBe(0);
    expect(quantizePreviewScrollTop(39)).toBe(20);
    expect(quantizePreviewScrollTop(40)).toBe(40);
    expect(quantizePreviewScrollTop(-12)).toBe(0);
    expect(quantizePreviewScrollTop(Number.NaN)).toBe(0);
    expect(quantizePreviewScrollTop(50, 0)).toBe(40); // 坏行高回缺省 20
  });

  it('度量坏值一律回缺省（NaN / 负数不把面板画歪）', () => {
    const metrics = normalizePreviewMetrics({
      rowHeight: Number.NaN,
      viewportHeight: -8,
      overscan: -3,
      scrollTop: -120,
    });
    expect(metrics.rowHeight).toBe(KOJO2_PREVIEW_ROW_HEIGHT);
    expect(metrics.viewportHeight).toBeGreaterThan(0);
    expect(metrics.overscan).toBe(0);
    expect(metrics.scrollTop).toBe(0);
  });
});

/* ============================== 跳转 ============================== */

describe('预览面板 · 点行跳源码', () => {
  it('普通映射行：回调收到模型给的源码行与起点列', () => {
    const onJump = vi.fn();
    const row = rowElementAt(PREVIEW, generatedLineOf('TELL: 晨光'), { onJumpToSource: onJump });
    (row.props as { onClick: () => void }).onClick();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(sourceLineOf('> 晨光'), 1);
  });

  it('模板展开行：跳到定义处首行（模型口径，不是展开行号）', () => {
    const onJump = vi.fn();
    const line = generatedLineOf('因为被夸奖');
    const row = rowElementAt(PREVIEW, line, { onJumpToSource: onJump });
    (row.props as { onClick: () => void }).onClick();
    expect(onJump).toHaveBeenCalledWith(sourceLineOf('> （因为{原因}'), 5);
  });

  it('纯生成行：按钮在但点了不跳，title 说明为什么', () => {
    const builder = createSourceMapBuilder();
    builder.appendLine({
      generatedLine: 1,
      kind: 'source',
      source: { start: { line: 7, column: 1 }, end: { line: 7, column: 5 } },
    });
    builder.appendLine({ generatedLine: 2, kind: 'generated', source: null });
    const erb = 'TELL: x\nENDIF\n';
    const map = buildKojo2SourceMapModel({ erb, sourceMap: builder.build() });
    const preview = buildKojo2PreviewModel({ erb, diagnostics: [] }, map);
    const onJump = vi.fn();
    const row = rowElementAt(preview, 2, { onJumpToSource: onJump });
    (row.props as { onClick: () => void }).onClick();
    expect(onJump).not.toHaveBeenCalled();
    expect((row.props as { title: string }).title).toContain('没有可跳的源码行');
    expect((row.props as { 'data-source-line'?: number })['data-source-line']).toBeUndefined();
  });

  it('没传跳转回调时只画不跳（纯渲染演练不抛）', () => {
    const row = rowElementAt(PREVIEW, generatedLineOf('TELL: 晨光'));
    expect(() => (row.props as { onClick: () => void }).onClick()).not.toThrow();
  });

  it('行是真按钮：type=button、带 1 基行号与跳转提示（键盘可触发）', () => {
    const line = generatedLineOf('TELL: 晨光');
    const row = rowElementAt(PREVIEW, line, { onJumpToSource: () => undefined });
    expect(row.type).toBe('button');
    expect((row.props as { type: string }).type).toBe('button');
    expect((row.props as { 'data-line': number })['data-line']).toBe(line);
    expect((row.props as { title: string }).title).toContain(`第 ${sourceLineOf('> 晨光')} 行`);
    expect((row.props as { 'aria-label': string })['aria-label']).toContain('跳回源码');
  });

  it('行元素的 key 是产物行号（同模型内唯一，重渲不串行）', () => {
    const rows = renderPreviewRows(PREVIEW, previewWindowFor(PREVIEW, NARROW));
    expect(rows.map((row) => row.key)).toEqual(['1', '2', '3', '4']);
  });
});

/* ============================== 滚动同步 ============================== */

describe('预览面板 · 源码光标 → 预览滚动', () => {
  it('精确命中：目标预览行 × 行高 = scrollTop', () => {
    const plan = previewScrollPlanFor(PREVIEW, sourceLineOf('> 晨光'), NARROW);
    expect(plan).not.toBeNull();
    expect(plan!.previewLine).toBe(generatedLineOf('TELL: 晨光'));
    expect(plan!.scrollTop).toBe(
      previewScrollTopForLine(generatedLineOf('TELL: 晨光'), NARROW),
    );
    expect(plan!.clamped).toBe(false);
  });

  it('不产字节的源行：沿用模型的"最近前置"落点', () => {
    const sourceLine = sourceLineOf('# 设 无关');
    const plan = previewScrollPlanFor(PREVIEW, sourceLine, NARROW);
    expect(plan!.previewLine).toBe(PREVIEW.previewLineForSourceLine(sourceLine));
    expect(plan!.previewLine).toBe(generatedLineOf('CALL HPH_PRINT'));
  });

  it('早于全部映射 ⇒ 第 1 行；晚于全部映射 ⇒ 末行并夹到可滚范围', () => {
    const head = previewScrollPlanFor(PREVIEW, 1, NARROW);
    expect(head!.previewLine).toBe(1);
    expect(head!.scrollTop).toBe(0);
    expect(head!.clamped).toBe(false);

    const tail = previewScrollPlanFor(PREVIEW, 9999, NARROW);
    expect(tail!.previewLine).toBe(ERB_LINES.length);
    expect(tail!.scrollTop).toBe(tail!.maxScrollTop); // 最后一屏：滚到底
    expect(tail!.clamped).toBe(true);
  });

  it('视口比内容高：可滚范围为 0，目标行不再把面板推走', () => {
    const plan = previewScrollPlanFor(PREVIEW, sourceLineOf('> 晨光'), {
      viewportHeight: ERB_LINES.length * KOJO2_PREVIEW_ROW_HEIGHT * 2,
    });
    expect(plan!.maxScrollTop).toBe(0);
    expect(plan!.scrollTop).toBe(0);
    expect(plan!.clamped).toBe(true);
  });

  it('scrollPreviewToSource 优先 scrollTo；没有就退化赋 scrollTop', () => {
    const scrollTo = vi.fn();
    const plan = scrollPreviewToSource(
      { scrollTo },
      PREVIEW,
      sourceLineOf('> 晨光'),
      NARROW,
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: plan!.scrollTop, behavior: 'auto' });

    const fallback: { scrollTop?: number } = { scrollTop: 0 };
    scrollPreviewToSource(fallback, PREVIEW, sourceLineOf('> 晨光'), NARROW);
    expect(fallback.scrollTop).toBe(plan!.scrollTop);
  });

  it('空预览 / 全无映射：计划为 null，不滚也不猜', () => {
    const emptyMap = buildKojo2SourceMapModel({
      erb: '',
      sourceMap: createSourceMapBuilder().build(),
    });
    const empty = buildKojo2PreviewModel(EMPTY_COMPILED, emptyMap);
    const scrollTo = vi.fn();
    expect(previewScrollPlanFor(empty, 1, NARROW)).toBeNull();
    expect(scrollPreviewToSource({ scrollTo }, empty, 1, NARROW)).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();

    const unmappedErb = 'plain\ntext\n';
    const unmapped = buildKojo2PreviewModel(
      { erb: unmappedErb, diagnostics: [] },
      buildKojo2SourceMapModel({
        erb: unmappedErb,
        sourceMap: createSourceMapBuilder().build(),
      }),
    );
    expect(previewScrollPlanFor(unmapped, 1, NARROW)).toBeNull();
  });

  it('外部光标行：高亮对应预览行并给出同步读数，窗口不变', () => {
    const cursorLine = sourceLineOf('> 晨光');
    const html = renderPanel({ metrics: NARROW, sourceCursorLine: cursorLine });
    const previewLine = generatedLineOf('TELL: 晨光');
    expect(html).toContain(`data-line="${previewLine}" data-source-line="${cursorLine}"`);
    expect(html).toContain('data-active="true"');
    expect(html).toContain(`源 ${cursorLine} → 预览 ${previewLine}`);
    // effect 不在静态渲染里跑：窗口仍是首帧那一段（高亮不改变窗口）
    expect(html).toContain('data-window-start="1"');
    expect(html).toContain('data-window-end="4"');
  });
});

/* ============================== 诊断 ============================== */

describe('预览面板 · 诊断气泡与未定位诊断', () => {
  const diagnostic = diagnosticOf('core/expr/type-mismatch', 'error', {
    start: { line: sourceLineOf('> 晨光'), column: 4 },
    end: { line: sourceLineOf('> 晨光'), column: 7 },
  });

  it('气泡带码 / 级别 / 列区间 / 消息（title 可直接读）', () => {
    const compiled: Kojo2PreviewCompileResult = {
      erb: COMPILED.erb,
      diagnostics: [diagnostic],
    };
    const html = renderPanel({ compiled, metrics: NARROW });
    expect(html).toContain('data-code="core/expr/type-mismatch"');
    expect(html).toContain('data-severity="error"');
    expect(html).toContain('data-column-start="4"');
    expect(html).toContain('data-column-end="7"');
    expect(html).toContain('core/expr/type-mismatch');
  });

  it('多诊断同行：气泡按输入顺序，error 压过 warning 决定行色', () => {
    const diagnostics = [
      diagnosticOf('core/expr/type-mismatch', 'warning', {
        start: { line: sourceLineOf('> 晨光'), column: 2 },
        end: { line: sourceLineOf('> 晨光'), column: 4 },
      }),
      diagnosticOf('core/expr/unknown-symbol', 'error', {
        start: { line: sourceLineOf('> 晨光'), column: 4 },
        end: { line: sourceLineOf('> 晨光'), column: 6 },
      }),
    ];
    const model = buildKojo2PreviewModel({ erb: COMPILED.erb, diagnostics }, SOURCE_MAP);
    const line = generatedLineOf('TELL: 晨光');
    const row = rowElementAt(model, line);
    expect((row.props as { 'data-severity': string })['data-severity']).toBe('error');
    const bubbles = (row.props as { children: unknown[] }).children;
    expect(Array.isArray(bubbles)).toBe(true);
    const html = renderRows(model, previewWindowFor(model, NARROW));
    expect((html.match(/class="kojo2-preview__bubble"/g) ?? []).length).toBe(2);
  });

  it('只有 warning 的行：行级色走 warning 档', () => {
    const warning = diagnosticOf('core/expr/not-expression', 'warning', {
      start: { line: sourceLineOf('> 晨光'), column: 3 },
      end: { line: sourceLineOf('> 晨光'), column: 9 },
    });
    const html = renderPanel({
      compiled: { erb: COMPILED.erb, diagnostics: [warning] },
      metrics: NARROW,
    });
    expect(html).toContain('data-severity="warning"');
  });

  it('未定位诊断：底部逐条列出（码 + 消息 + 源行号），不伪造气泡', () => {
    const diagnostics = [
      diagnosticOf('core/wait/no-profile', 'error', null),
      diagnosticOf('core/expr/unknown-symbol', 'error', pointSpan(1, 2)),
      diagnosticOf('core/expr/bad-index', 'warning', pointSpan(sourceLineOf('# 设 无关'), 3)),
    ];
    const html = renderPanel({
      compiled: { erb: COMPILED.erb, diagnostics },
      metrics: NARROW,
    });
    expect(html).toContain('kojo2-preview__unlocated');
    expect(html).toContain('data-count="3"');
    expect(html).toContain('data-code="core/wait/no-profile"');
    expect(html).toContain('data-code="core/expr/unknown-symbol"');
    expect(html).toContain('data-code="core/expr/bad-index"');
    expect(html).toContain(`第 ${sourceLineOf('# 设 无关')} 行`);
    expect(html).not.toContain('class="kojo2-preview__bubble"'); // 落不到产物行 ≠ 气泡
  });

  it('定位诊断与未定位诊断并存：气泡在行上，清单在底部', () => {
    const diagnostics = [
      diagnostic,
      diagnosticOf('core/wait/no-profile', 'error', null, '缺少等待时长'),
    ];
    const html = renderPanel({
      compiled: { erb: COMPILED.erb, diagnostics },
      metrics: NARROW,
    });
    expect(html).toContain('kojo2-preview__bubble');
    expect(html).toContain('data-count="1"');
    expect(html).toContain('缺少等待时长');
  });

  it('空产物但仍有诊断：空态 + 底部清单照出（诊断不静默）', () => {
    const failed = diagnosticOf('core/machine/missing', 'error', pointSpan(1, 1), '缺 `# 机`');
    const map = buildKojo2SourceMapModel({
      erb: '',
      sourceMap: createSourceMapBuilder().build(),
    });
    const html = renderPanel({
      compiled: { erb: '', diagnostics: [failed] },
      sourceMapModel: map,
    });
    expect(html).toContain('没有可预览的产物行');
    expect(html).toContain('data-count="1"');
    expect(html).toContain('core/machine/missing');
  });
});

/* ============================== 入口 / flag ============================== */

function fakeCursor(initialLine: number): {
  source: Kojo2PreviewCursorSource;
  move: (line: number) => void;
  listeners: () => number;
} {
  let line = initialLine;
  const listeners = new Set<(event: { position: { lineNumber: number } }) => void>();
  return {
    source: {
      getPosition: () => ({ lineNumber: line }),
      onDidChangeCursorPosition(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    move(next) {
      line = next;
      for (const listener of [...listeners]) listener({ position: { lineNumber: next } });
    },
    listeners: () => listeners.size,
  };
}

function compilationFor(compiled: Kojo2PreviewCompileResult = COMPILED): Kojo2PreviewCompilation {
  return { compiled, sourceMapModel: SOURCE_MAP };
}

describe('预览入口 · flag 与接线', () => {
  it('flag 关 ⇒ 入口直接是 null（不挂载、零监听）', () => {
    const compile = vi.fn(() => compilationFor());
    expect(
      createKojo2PreviewEntry({
        compile,
        onJumpToSource: () => undefined,
        filePath: 'a.kojo2',
        flag: () => false,
      }),
    ).toBeNull();
    expect(compile).not.toHaveBeenCalled();
  });

  it('开关读不出来按关（失败方向：少露）', () => {
    expect(
      kojo2PreviewEnabled(() => {
        throw new Error('storage blocked');
      }),
    ).toBe(false);
    expect(kojo2PreviewEnabled(() => true)).toBe(true);
  });

  it('flag 开 ⇒ 入口拿到编译结果，panelProps 把路径绑进跳转回调', () => {
    const jumped: Array<[string, number, number]> = [];
    const entry = createKojo2PreviewEntry({
      compile: () => compilationFor(),
      onJumpToSource: (filePath, line, column) => jumped.push([filePath, line, column]),
      filePath: 'C:\\proj\\a.kojo2',
      flag: () => true,
    });
    expect(entry).not.toBeNull();
    const snapshot = entry!.snapshot();
    expect(snapshot.mounted).toBe(true);
    expect(snapshot.compilation?.compiled).toBe(COMPILED);

    const props = entry!.panelProps();
    expect(props).not.toBeNull();
    expect(props!.compiled).toBe(COMPILED);
    expect(props!.sourceMapModel).toBe(SOURCE_MAP);
    props!.onJumpToSource(sourceLineOf('> 晨光'), 1);
    expect(jumped).toEqual([['C:\\proj\\a.kojo2', sourceLineOf('> 晨光'), 1]]);
  });

  it('没有编译结果 ⇒ 不挂载（panelProps = null）', () => {
    const entry = createKojo2PreviewEntry({
      compile: () => null,
      onJumpToSource: () => undefined,
      filePath: 'a.kojo2',
      flag: () => true,
    });
    expect(entry!.snapshot().mounted).toBe(false);
    expect(entry!.panelProps()).toBeNull();
  });

  it('编译提供方抛错 ⇒ 当作没编译好，不抛进渲染链', () => {
    const entry = createKojo2PreviewEntry({
      compile: () => {
        throw new Error('core crashed');
      },
      onJumpToSource: () => undefined,
      filePath: 'a.kojo2',
      flag: () => true,
    });
    expect(entry!.snapshot().compilation).toBeNull();
    expect(entry!.panelProps()).toBeNull();
  });

  it('光标事件：换行才通知一次，同行移动不重复发', () => {
    const entry = createKojo2PreviewEntry({
      compile: () => compilationFor(),
      onJumpToSource: () => undefined,
      filePath: 'a.kojo2',
      flag: () => true,
    });
    const cursor = fakeCursor(sourceLineOf('> 晨光'));
    entry!.attachCursor(cursor.source);
    expect(entry!.snapshot().sourceCursorLine).toBe(sourceLineOf('> 晨光'));

    const seen: number[] = [];
    entry!.subscribe((snapshot) => {
      if (snapshot.sourceCursorLine !== null) seen.push(snapshot.sourceCursorLine);
    });
    cursor.move(sourceLineOf('> 晨光')); // 同一行：列变化不算
    expect(seen).toEqual([]);
    cursor.move(sourceLineOf('! 问候'));
    expect(seen).toEqual([sourceLineOf('! 问候')]);
    expect(entry!.panelProps()!.sourceCursorLine).toBe(sourceLineOf('! 问候'));
  });

  it('换光标源后，旧的卸载函数不会误摘新源', () => {
    const entry = createKojo2PreviewEntry({
      compile: () => compilationFor(),
      onJumpToSource: () => undefined,
      filePath: 'a.kojo2',
      flag: () => true,
    });
    const first = fakeCursor(1);
    const second = fakeCursor(2);
    const detachFirst = entry!.attachCursor(first.source);
    entry!.attachCursor(second.source);
    detachFirst();
    expect(second.listeners()).toBe(1); // 新源仍然挂着
    second.move(sourceLineOf('> 晨光'));
    expect(entry!.snapshot().sourceCursorLine).toBe(sourceLineOf('> 晨光'));
    expect(first.listeners()).toBe(0);
  });

  it('setFile / refresh：切文件换结果，撤掉文件即不挂载', () => {
    let current: Kojo2PreviewCompilation | null = compilationFor();
    const compile = vi.fn((filePath: string) => (filePath.endsWith('.kojo2') ? current : null));
    const entry = createKojo2PreviewEntry({
      compile,
      onJumpToSource: () => undefined,
      flag: () => true,
    });
    expect(entry!.snapshot().filePath).toBeNull();
    expect(entry!.panelProps()).toBeNull();

    entry!.setFile('a.kojo2');
    expect(compile).toHaveBeenCalledWith('a.kojo2');
    expect(entry!.snapshot().mounted).toBe(true);

    current = null;
    entry!.refresh();
    expect(entry!.snapshot().mounted).toBe(false);

    entry!.setFile(null);
    expect(entry!.snapshot().filePath).toBeNull();
    expect(entry!.panelProps()).toBeNull();
  });

  it('dispose 之后全部空操作（快照不变、不再通知）', () => {
    const entry = createKojo2PreviewEntry({
      compile: () => compilationFor(),
      onJumpToSource: () => undefined,
      filePath: 'a.kojo2',
      flag: () => true,
    });
    const listener = vi.fn();
    const cursor = fakeCursor(1);
    entry!.attachCursor(cursor.source);
    entry!.subscribe(listener);
    entry!.dispose();
    const frozen = entry!.snapshot();

    entry!.setFile('b.kojo2');
    entry!.refresh();
    cursor.move(9);
    expect(entry!.snapshot()).toEqual(frozen);
    expect(listener).not.toHaveBeenCalled();
    expect(entry!.panelProps()).toBeNull();
    expect(cursor.listeners()).toBe(0);
  });

  it('组件 enabled=false ⇒ 渲染 0 字节（第二道闸）', () => {
    expect(renderPanel({ enabled: false })).toBe('');
  });
});

/* ============================== 与既有模型的口径一致 ============================== */

describe('预览面板 · 模型消费口径', () => {
  it('窗口里的每一行都来自同一个预览模型（行文本逐字一致）', () => {
    const html = renderPanel({ metrics: NARROW });
    for (const row of PREVIEW.rows.slice(0, 4)) {
      expect(html).toContain(row.text.length === 0 ? '\u00a0' : row.text);
    }
    expect(PREVIEW.lineCount).toBe(ERB_LINES.length);
  });

  it('观感住 kojo2.css 类族（L11 收编后：内联只剩数据驱动的行高/衬垫，不再带外观属性）', () => {
    const html = renderPanel({ metrics: NARROW });
    // 行与面全部走 className；留在 style 里的只有虚拟化算出来的 `height`
    expect(html).toContain('class="kojo2-preview"');
    expect(html).toContain('class="kojo2-preview__row"');
    for (const m of html.matchAll(/style="([^"]*)"/g)) {
      expect(m[1]).toMatch(/^height:[\d.]+(?:px)?$/);
    }
    // 原口径的两枚 token 现由 `../src/kojo2.css` 的类族承载（styles.css 依旧零改动）
    const css = readFileSync(fileURLToPath(new URL('../src/kojo2.css', import.meta.url)), 'utf8');
    expect(css).toContain('--surface-sunken');
    expect(css).toContain('--font-code');
  });

  it('诊断叠用的位置与模型一致：列区间落在该行宽度内', () => {
    const compiled: Kojo2PreviewCompileResult = {
      erb: COMPILED.erb,
      diagnostics: [
        diagnosticOf('core/expr/type-mismatch', 'error', {
          start: { line: sourceLineOf('> 晨光'), column: 4 },
          end: { line: sourceLineOf('> 晨光'), column: 7 },
        }),
      ],
    };
    const model = buildKojo2PreviewModel(compiled, SOURCE_MAP);
    const row = model.rows[generatedLineOf('TELL: 晨光') - 1]!;
    const bubble = row.diagnostics[0]!;
    expect(bubble.columns).toEqual({ start: 4, end: 7 });
    expect(bubble.columns!.end).toBeLessThanOrEqual(row.text.length + 1);
    expect(bubble.severity).toBe('error');
  });

  it('真 core 编译的 fixture 本身是干净的（气泡测试的对照基线）', () => {
    // 这一份 fixture 不产诊断：上面所有气泡用例都是叠出来的，不是编译产物自带的。
    expect(COMPILED.ok).toBe(true);
    expect(COMPILED.diagnostics).toHaveLength(0);
    expect(SOURCE_MAP.generatedLineCount).toBe(ERB_LINES.length);
  });

  it('每个映射行的跳转源码行都与其 kojoRange 起点一致（也不越出源文件）', () => {
    const mappedRows = PREVIEW.rows.filter((row) => row.kojoRange !== null);
    expect(mappedRows.length).toBeGreaterThan(0);
    for (const row of mappedRows) {
      const sourceLine = PREVIEW.sourceLineForPreviewLine(row.line);
      expect(sourceLine).toBe(row.kojoRange!.start.line);
      expect(sourceLine!).toBeGreaterThanOrEqual(1);
      expect(sourceLine!).toBeLessThanOrEqual(SOURCE_LINES.length);
    }
    expect(SOURCE_MAP.generatedLineCount).toBeGreaterThan(0);
  });
});
