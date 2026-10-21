/**
 * Kojo 2.0 **编译预览面板**（K2-PREVIEW-PANEL / 设计稿 §16.7 U6.5）。
 *
 * 纯渲染件：进来的是"一次编译的产物 + 与它同源的 source map"，出去的是可直接上屏的
 * 预览行。**不在组件里跑编译、不碰 Monaco 实例、不读 localStorage**——宿主把
 * `compiled` / `sourceMapModel` / 光标行 / 跳转回调从 props 递进来，渲染链里只有模型查询。
 *
 * ## 三件事
 *
 * 1. **看产物**：一行产物 = 行号 + kind 标记 + 文本 + 挂在这一行上的诊断气泡。
 *    kind 的五档与 core `SourceMapLineKind` 一一对应（`源` / `生` / `模` / `池` / `原`），
 *    模板/池展开行在 title 里带上 origin 条数（"这一行能点回几处"）。
 * 2. **双向定位**：
 *    - 点一行 → `sourceLineForPreviewLine` 得源码行 → `onJumpToSource(line, column)`；
 *      纯生成行（没有 `kojoRange`）不跳——按钮在，但点了不产生假动作（título 里说明为什么）；
 *    - 外部源光标行（`sourceCursorLine`）变化 → `previewLineForSourceLine` 得预览行 →
 *      容器 `scrollTo`；"精确 → 最近前置 → 首尾 clamp"的语义全部由模型给，组件不重算，
 *      只把结果乘行高。命中的那一行同时高亮（没滚动也能一眼看出同步在哪）。
 * 3. **不静默**：落不到产物行的诊断（`unlocatedDiagnostics`）在面板底部逐条列出——
 *    不伪造气泡，也不让它们消失（铁律 4）。两份模型不同源（行数不等）时面板画一条
 *    错误说明而不是把错位的行画给作者。
 *
 * ## 大文件：只画窗口
 *
 * 渲染取"可见范围 ± overscan"（{@link previewWindowFor}），行元素只按窗口建
 * （{@link renderPreviewRows}）。滚动的每一帧只做三件常数级的事：把 `scrollTop` 量化到
 * 行边界（{@link quantizePreviewScrollTop}，同一行内不 setState ⇒ 不重渲）、算窗口
 * （O(1)）、取窗口内的行（`rowAt` O(1)，模型的行数组本来就只懒建一次）。
 * **没有 O(n) 每帧重扫**：滚动监听里不碰 `model.rows`，也不重算诊断叠加。
 *
 * ## 样式
 *
 * 全部内联 + 既有设计 token（`--surface-sunken` / `--fg-dim` / `--danger` / `--warning` /
 * `--accent` / `--font-code` / `--fs-1`…），**不改 `styles.css`**。三主题自动跟随。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type UIEvent,
} from 'react';
import type { KojoDiagnostic, SourceMapLineKind } from '@kojo/kojo-core';
import type { Kojo2SourceMapModel } from '../monaco/kojo2-sourcemap-model';
import {
  buildKojo2PreviewModel,
  type Kojo2PreviewCompileResult,
  type Kojo2PreviewDiagnostic,
  type Kojo2PreviewModel,
  type Kojo2PreviewRow,
} from './kojo2-preview-model';

/* ============================== 度量与窗口 ============================== */

/** 单行高度（px）。窗口与 `scrollTop` 的换算全用这一格。 */
export const KOJO2_PREVIEW_ROW_HEIGHT = 20;

/** 上下各多画几行（buffer）：滚一格不会先闪一下空白。 */
export const KOJO2_PREVIEW_OVERSCAN = 8;

/** 没有 DOM 可量时假定的视口高度（px，24 行）：首帧 / SSR / 单测同一个缺省。 */
export const KOJO2_PREVIEW_VIEWPORT_HEIGHT = KOJO2_PREVIEW_ROW_HEIGHT * 24;

/** 渲染窗口的度量（全部可注入：宿主给真实 DOM 读数，测试给固定值） */
export interface Kojo2PreviewMetrics {
  readonly rowHeight: number;
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly overscan: number;
}

/** 缺省度量（组件首帧、`renderToStaticMarkup`、纯函数单测共用一套） */
export const KOJO2_PREVIEW_DEFAULT_METRICS: Kojo2PreviewMetrics = Object.freeze({
  rowHeight: KOJO2_PREVIEW_ROW_HEIGHT,
  viewportHeight: KOJO2_PREVIEW_VIEWPORT_HEIGHT,
  scrollTop: 0,
  overscan: KOJO2_PREVIEW_OVERSCAN,
});

function finitePositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** 补齐 / 夹取度量（坏值一律回缺省：面板不该因为一个 NaN 高度变大或变小） */
export function normalizePreviewMetrics(
  partial?: Partial<Kojo2PreviewMetrics>,
): Kojo2PreviewMetrics {
  const rawOverscan = partial?.overscan;
  const overscan =
    rawOverscan === undefined || !Number.isFinite(rawOverscan)
      ? KOJO2_PREVIEW_OVERSCAN
      : Math.max(0, Math.trunc(rawOverscan));
  return {
    rowHeight: finitePositive(partial?.rowHeight, KOJO2_PREVIEW_ROW_HEIGHT),
    viewportHeight: finitePositive(partial?.viewportHeight, KOJO2_PREVIEW_VIEWPORT_HEIGHT),
    scrollTop: finiteNonNegative(partial?.scrollTop, 0),
    overscan,
  };
}

/** 一次渲染要画的范围（1 基闭区间）+ 上下衬垫高度（保证滚动条长度 = 全量行数） */
export interface Kojo2PreviewWindow {
  /** 窗口首行（1 基；空预览 = 1） */
  readonly startLine: number;
  /** 窗口末行（1 基；空预览 = 1） */
  readonly endLine: number;
  /** 窗口内行数（0 = 空预览） */
  readonly count: number;
  /** 窗口上方衬垫（px） */
  readonly topPadding: number;
  /** 窗口下方衬垫（px） */
  readonly bottomPadding: number;
  /** 全量高度（px；滚动条的行程） */
  readonly totalHeight: number;
}

const EMPTY_WINDOW: Kojo2PreviewWindow = Object.freeze({
  startLine: 1,
  endLine: 1,
  count: 0,
  topPadding: 0,
  bottomPadding: 0,
  totalHeight: 0,
});

/**
 * 算这一次该画哪一段：可见首行 = `floor(scrollTop / rowHeight) + 1`，可见行数 =
 * `ceil(viewportHeight / rowHeight)`，上下各放 `overscan` 行，再夹进 `[1, lineCount]`。
 *
 * **只读 `model.lineCount`**（一个数），不碰行数组——大文件滚动时这是 O(1)。
 */
export function previewWindowFor(
  model: Kojo2PreviewModel,
  metrics?: Partial<Kojo2PreviewMetrics>,
): Kojo2PreviewWindow {
  const settings = normalizePreviewMetrics(metrics);
  const lineCount = model.lineCount;
  if (!Number.isFinite(lineCount) || lineCount <= 0) return EMPTY_WINDOW;

  const firstVisible = Math.floor(settings.scrollTop / settings.rowHeight) + 1;
  const visibleCount = Math.max(1, Math.ceil(settings.viewportHeight / settings.rowHeight));
  const lastVisible = firstVisible + visibleCount - 1;
  const startLine = Math.min(Math.max(1, firstVisible - settings.overscan), lineCount);
  const endLine = Math.min(Math.max(startLine, lastVisible + settings.overscan), lineCount);
  return {
    startLine,
    endLine,
    count: endLine - startLine + 1,
    topPadding: (startLine - 1) * settings.rowHeight,
    bottomPadding: (lineCount - endLine) * settings.rowHeight,
    totalHeight: lineCount * settings.rowHeight,
  };
}

/** 预览行（1 基）→ 该行顶端在滚动容器里的 `scrollTop`（已按行高量化） */
export function previewScrollTopForLine(
  previewLine: number,
  metrics?: Partial<Kojo2PreviewMetrics>,
): number {
  const settings = normalizePreviewMetrics(metrics);
  const line = Number.isFinite(previewLine) ? Math.max(1, Math.trunc(previewLine)) : 1;
  return (line - 1) * settings.rowHeight;
}

/**
 * 把物理 `scrollTop` 量化到行边界——滚动监听里用它做"这一帧窗口变没变"的判据：
 * 同一行内的像素级滚动不触发重渲（大文件里滚轮每帧都会发事件，逐帧重渲是白烧）。
 */
export function quantizePreviewScrollTop(
  scrollTop: number,
  rowHeight: number = KOJO2_PREVIEW_ROW_HEIGHT,
): number {
  const height = finitePositive(rowHeight, KOJO2_PREVIEW_ROW_HEIGHT);
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0;
  return Math.floor(scrollTop / height) * height;
}

/* ============================== 滚动同步 ============================== */

/** 一次"源码光标 → 预览滚到哪"的计划（纯数据，测试与组件共用） */
export interface Kojo2PreviewScrollPlan {
  /** 目标预览行（1 基，模型给的结果） */
  readonly previewLine: number;
  /** 目标 `scrollTop`（已与 `maxScrollTop` 夹过） */
  readonly scrollTop: number;
  /** 该容器能滚到的最大值（`lineCount*rowHeight - viewportHeight`，不小于 0） */
  readonly maxScrollTop: number;
  /** 是否被尾部夹过（目标行在最后一屏里：滚到底即可，不会再往中间推） */
  readonly clamped: boolean;
}

/**
 * 源码行 → 滚动计划；模型说"没有映射"（空预览 / 全无映射）时返回 `null`（不滚、不猜）。
 *
 * 命中哪一行**完全由 `previewLineForSourceLine` 决定**：精确 → 最近前置 → 首尾 clamp
 * 这三档语义已经写死在模型里（见 `kojo2-preview-model` 头注），组件不复制一份，
 * 也不在这里做"离得近就吸过去"的二次启发——两处判据迟早会分叉。
 */
export function previewScrollPlanFor(
  model: Kojo2PreviewModel,
  sourceLine: number,
  metrics?: Partial<Kojo2PreviewMetrics>,
): Kojo2PreviewScrollPlan | null {
  const settings = normalizePreviewMetrics(metrics);
  const previewLine = model.previewLineForSourceLine(sourceLine);
  if (previewLine === null) return null;
  const maxScrollTop = Math.max(0, model.lineCount * settings.rowHeight - settings.viewportHeight);
  const raw = previewScrollTopForLine(previewLine, settings);
  const scrollTop = Math.min(raw, maxScrollTop);
  return { previewLine, scrollTop, maxScrollTop, clamped: scrollTop !== raw };
}

/**
 * 滚动容器的**最小面**（`HTMLDivElement` 结构兼容；单测给记录参数的假体即可）。
 *
 * `scrollTo` 缺省时退化为直接赋 `scrollTop`：老 WebView / 桩对象都还有这条路。
 */
export interface Kojo2PreviewScrollHost {
  scrollTo?(options: { top: number; behavior?: 'auto' | 'smooth' }): void;
  scrollTop?: number;
}

/**
 * 把"外部源光标行"落到容器上：算计划 → `scrollTo` / 赋 `scrollTop`。
 *
 * 返回计划（`null` = 模型说滚不了），宿主据此更新自己的窗口状态；**不读 DOM 尺寸**
 * （度量由调用方给：effect 里量 `clientHeight`，测试里给固定值）。
 */
export function scrollPreviewToSource(
  host: Kojo2PreviewScrollHost | null,
  model: Kojo2PreviewModel,
  sourceLine: number,
  metrics?: Partial<Kojo2PreviewMetrics>,
): Kojo2PreviewScrollPlan | null {
  const plan = previewScrollPlanFor(model, sourceLine, metrics);
  if (plan === null || host === null) return plan;
  if (typeof host.scrollTo === 'function') {
    host.scrollTo({ top: plan.scrollTop, behavior: 'auto' });
  } else {
    host.scrollTop = plan.scrollTop;
  }
  return plan;
}

/* ============================== kind 标记 ============================== */

/** kind 的上屏形态：一个字 + 一句人话（title / 无障碍名共用） */
export interface Kojo2PreviewKindMark {
  readonly glyph: string;
  readonly label: string;
}

/** 五档映射类别 + 未登记行的标记表（core `SourceMapLineKind` 一一对应，不另造类别） */
export const KOJO2_PREVIEW_KIND_MARKS: Readonly<Record<SourceMapLineKind, Kojo2PreviewKindMark>> =
  Object.freeze({
    source: { glyph: '源', label: '逐行映射：这一行产物直接来自源码' },
    generated: { glyph: '生', label: '生成的骨架行：没有对应的源码行' },
    template: { glyph: '模', label: '模板展开：可点回调用处 / 模板定义处' },
    pool: { glyph: '池', label: '池展开：可点回调用处 / 池定义处' },
    native: { glyph: '原', label: '@原生 透传：可点回块体内的源行' },
  });

/** 未登记映射的行的标记（`kind === null`：模型没查到这一行） */
export const KOJO2_PREVIEW_UNMAPPED_MARK: Kojo2PreviewKindMark = Object.freeze({
  glyph: '·',
  label: '未登记映射：这一行没有 source map 记录',
});

/** kind 标记的配色（全部设计 token；未登记行走 dim） */
const KIND_COLOR: Readonly<Record<SourceMapLineKind, string>> = {
  source: 'var(--fg-dim)',
  generated: 'var(--fg-dim)',
  template: 'var(--accent-text)',
  pool: 'var(--green)',
  native: 'var(--amber)',
};

/* ============================== 行渲染 ============================== */

/** 严重级 → 设计 token（error / warning；没有诊断 = null） */
function severityColor(severity: 'error' | 'warning' | null): string | null {
  if (severity === 'error') return 'var(--danger)';
  if (severity === 'warning') return 'var(--warning)';
  return null;
}

/** 气泡里的严重级字形（纯文本，读屏与静态渲染都读得出） */
const SEVERITY_GLYPH: Readonly<Record<'error' | 'warning', string>> = {
  error: '●',
  warning: '▲',
};

/** 行渲染的可选项（`renderPreviewRows(model, window)` 不传也成立） */
export interface Kojo2PreviewRowOptions {
  /** 点行跳源码（1 基行 / 1 基列）；缺省 = 只画不跳（纯渲染演练） */
  readonly onJumpToSource?: (line: number, column: number) => void;
  /** 外部源光标命中的预览行（1 基）：加一道高亮，不改变窗口 */
  readonly activeLine?: number | null;
  /** 行高（px；缺省 {@link KOJO2_PREVIEW_ROW_HEIGHT}，与窗口度量同一格） */
  readonly rowHeight?: number;
}

function diagnosticBubble(diagnostic: Kojo2PreviewDiagnostic): ReactElement {
  const color = severityColor(diagnostic.severity) ?? 'var(--fg-dim)';
  const columns = diagnostic.columns;
  return (
    <span
      className="kojo2-preview__bubble"
      key={diagnostic.index}
      data-code={diagnostic.code}
      data-severity={diagnostic.severity}
      data-column-start={columns?.start}
      data-column-end={columns?.end}
      title={`${diagnostic.severity === 'error' ? '错误' : '警告'} · ${diagnostic.code}\n${diagnostic.message}`}
      style={{
        color,
        fontFamily: 'var(--font-meta)',
        fontSize: 'var(--fs-0)',
        lineHeight: '1',
        opacity: 0.95,
      }}
    >
      {SEVERITY_GLYPH[diagnostic.severity]}
    </span>
  );
}

function previewRowElement(
  row: Kojo2PreviewRow,
  model: Kojo2PreviewModel,
  options: Kojo2PreviewRowOptions,
  rowHeight: number,
): ReactElement {
  // 跳转行号走模型的反向查询（口径唯一）；`kojoRange` 只提供列与 tooltip 细节。
  const sourceLine = model.sourceLineForPreviewLine(row.line);
  const column = row.kojoRange?.start.column ?? 1;
  const mark = row.kind === null ? KOJO2_PREVIEW_UNMAPPED_MARK : KOJO2_PREVIEW_KIND_MARKS[row.kind];
  const color = severityColor(row.severity);
  const active = options.activeLine === row.line;
  const kindColor = row.kind === null ? 'var(--fg-dim)' : KIND_COLOR[row.kind];
  const originCount = row.origins.length;
  const title =
    sourceLine === null
      ? `${mark.label}${originCount > 0 ? ` · ${originCount} 处锚点` : ''}（没有可跳的源码行）`
      : `跳回源码：第 ${sourceLine} 行 · 第 ${column} 列（${mark.label}${
          originCount > 0 ? ` · ${originCount} 处锚点` : ''
        }）`;

  const activate = (): void => {
    if (sourceLine === null || options.onJumpToSource === undefined) return;
    options.onJumpToSource(sourceLine, column);
  };

  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '44px 16px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '8px',
    boxSizing: 'border-box',
    width: '100%',
    height: `${rowHeight}px`,
    padding: '0 10px 0 6px',
    margin: 0,
    border: 'none',
    borderLeft: `2px solid ${color ?? (active ? 'var(--accent)' : 'transparent')}`,
    background: active
      ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
      : color !== null
        ? `color-mix(in srgb, ${color} 8%, transparent)`
        : 'transparent',
    color: 'var(--fg)',
    fontFamily: 'var(--font-meta)',
    fontSize: 'var(--fs-1)',
    lineHeight: '1',
    textAlign: 'left',
    whiteSpace: 'pre',
    cursor: sourceLine === null ? 'default' : 'pointer',
  };

  return (
    <button
      type="button"
      className="kojo2-preview__row"
      key={row.line}
      data-line={row.line}
      data-source-line={sourceLine ?? undefined}
      data-kind={row.kind ?? 'unmapped'}
      data-severity={row.severity ?? undefined}
      data-active={active ? 'true' : undefined}
      aria-label={title}
      title={title}
      onClick={activate}
      style={rowStyle}
    >
      <span
        className="kojo2-preview__ln"
        style={{
          color: 'var(--fg-dim)',
          fontFamily: 'var(--font-meta)',
          fontSize: 'var(--fs-0)',
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          opacity: active ? 1 : 0.75,
        }}
      >
        {row.line}
      </span>
      <span
        className="kojo2-preview__kind"
        data-kind={row.kind ?? 'unmapped'}
        aria-hidden="true"
        style={{
          color: kindColor,
          fontFamily: 'var(--font-meta)',
          fontSize: 'var(--fs-0)',
          textAlign: 'center',
          opacity: row.kind === null ? 0.6 : 0.9,
        }}
      >
        {mark.glyph}
      </span>
      <span
        className="kojo2-preview__text"
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: 'var(--font-code)',
          color: row.kojoRange === null ? 'var(--fg-dim)' : 'var(--fg)',
        }}
      >
        {row.text.length === 0 ? '\u00a0' : row.text}
      </span>
      <span className="kojo2-preview__bubbles" style={{ display: 'inline-flex', gap: '4px' }}>
        {row.diagnostics.map(diagnosticBubble)}
      </span>
    </button>
  );
}

/**
 * 把窗口里的行变成 React 元素（纯函数：同一 model / window / options 永远同一结果）。
 *
 * 只对窗口内的行调 `rowAt`（每行 O(1)，模型的行数组懒建一次），**不整篇物化**；
 * 行元素的 key 用 1 基产物行号（同一模型内天然唯一，重渲不会串行）。
 */
export function renderPreviewRows(
  model: Kojo2PreviewModel,
  visibleWindow: Kojo2PreviewWindow,
  options: Kojo2PreviewRowOptions = {},
): ReactElement[] {
  if (visibleWindow.count <= 0) return [];
  const rowHeight = finitePositive(options.rowHeight, KOJO2_PREVIEW_ROW_HEIGHT);
  const rows: ReactElement[] = [];
  for (let line = visibleWindow.startLine; line <= visibleWindow.endLine; line++) {
    const row = model.rowAt(line);
    if (row === null) break;
    rows.push(previewRowElement(row, model, options, rowHeight));
  }
  return rows;
}

/* ============================== 面板 ============================== */

/** 预览面板的 props（全部由宿主注入：编译结果 / 同源 source map / 跳转回调） */
export interface Kojo2PreviewPanelProps {
  /** 这次编译的产物 + 诊断（`kojo-sugar` 服务结果结构兼容；面板不跑编译） */
  readonly compiled: Kojo2PreviewCompileResult;
  /** 与 `compiled` **同一次**编译产出的 source map 模型（不同源会被模型直接拒绝） */
  readonly sourceMapModel: Kojo2SourceMapModel;
  /** 点预览行 → 跳回源码（1 基行 / 1 基列）；纯生成行不触发 */
  readonly onJumpToSource: (line: number, column: number) => void;
  /** 外部源光标行（1 基；`null` = 没有光标 / 不在本文件）——变化即滚到对应预览行 */
  readonly sourceCursorLine?: number | null;
  /** 首帧 / 无 DOM 环境的度量（宿主量到真实高度后由滚动事件接管） */
  readonly metrics?: Partial<Kojo2PreviewMetrics>;
  /** 宿主显式关闭（入口 flag 关时已返回 null；这里是第二道闸） */
  readonly enabled?: boolean;
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  background: 'var(--surface-sunken)',
  color: 'var(--fg)',
  borderTop: '1px solid var(--border-subtle)',
  fontFamily: 'var(--font-meta)',
  fontSize: 'var(--fs-1)',
};

const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flex: '0 0 auto',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-subtle)',
  color: 'var(--fg-dim)',
  fontSize: 'var(--fs-0)',
  letterSpacing: '0.02em',
};

const BODY_STYLE: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 0,
  margin: 0,
  scrollbarGutter: 'stable',
};

const FOOTER_STYLE: CSSProperties = {
  flex: '0 0 auto',
  maxHeight: '132px',
  overflowY: 'auto',
  padding: '6px 10px 8px',
  borderTop: '1px solid var(--border-subtle)',
  background: 'var(--surface-raised)',
  color: 'var(--fg-dim)',
  fontSize: 'var(--fs-0)',
};

const UNLOCATED_ITEM_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  padding: '2px 0',
  listStyle: 'none',
  whiteSpace: 'pre-wrap',
};

/**
 * 未定位诊断的底部清单（每条一行：级别 + 码 + 消息 + 源行号）。
 *
 * 不伪造气泡是模型的判据；这里只保证"落不到产物行的那些诊断仍然看得见"（铁律 4）。
 */
function unlocatedList(diagnostics: readonly KojoDiagnostic[]): ReactElement {
  return (
    <footer
      className="kojo2-preview__unlocated"
      data-count={diagnostics.length}
      style={FOOTER_STYLE}
      aria-label={`未定位诊断 ${diagnostics.length} 条`}
    >
      <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', marginBottom: '2px' }}>
        <span style={{ color: 'var(--fg)' }}>未定位诊断</span>
        <span data-role="count">{diagnostics.length}</span>
        <span style={{ opacity: 0.7 }}>落不到产物行 · 详见问题面板</span>
      </div>
      <ul style={{ margin: 0, padding: 0 }}>
        {diagnostics.map((diagnostic, index) => {
          const color = severityColor(diagnostic.severity) ?? 'var(--fg-dim)';
          return (
            <li
              key={`${diagnostic.code}-${index}`}
              className="kojo2-preview__unlocated-item"
              data-code={diagnostic.code}
              data-severity={diagnostic.severity}
              style={UNLOCATED_ITEM_STYLE}
            >
              <span style={{ color, flex: '0 0 auto' }}>
                {diagnostic.severity === 'error' ? '错误' : '警告'}
              </span>
              <code
                style={{
                  color: 'var(--accent-text)',
                  fontFamily: 'var(--font-mono)',
                  flex: '0 0 auto',
                }}
              >
                {diagnostic.code}
              </code>
              <span style={{ minWidth: 0 }}>{diagnostic.message}</span>
              {diagnostic.span !== null ? (
                <span style={{ flex: '0 0 auto' }}>第 {diagnostic.span.start.line} 行</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </footer>
  );
}

/**
 * 预览面板。
 *
 * hooks 顺序与 `enabled` 无关（关闭时也把 hook 走完再返回 `null`）：宿主翻开关不会让
 * React 的 hook 表错位。`enabled === false` ⇒ 渲染 0 字节，等价"没挂载"。
 */
export function Kojo2PreviewPanel(props: Kojo2PreviewPanelProps): ReactElement | null {
  const {
    compiled,
    sourceMapModel,
    onJumpToSource,
    sourceCursorLine = null,
    enabled = true,
  } = props;

  const base = useMemo(() => normalizePreviewMetrics(props.metrics), [props.metrics]);

  // 模型只建一次（同一份编译 / 同一张 map）：不同源时模型会抛 TypeError——
  // 面板把它变成一条可见的错误说明，绝不把错位的行画给作者。
  // 依赖键按**内容字段**取（产物文本 + 诊断数组 + map 身份）：宿主偶尔每次 render 都造
  // 一个新的 `{ erb, diagnostics }` 字面量时也不会白重建一次 O(n) 的行数组。
  const built = useMemo((): { model: Kojo2PreviewModel | null; failure: string | null } => {
    try {
      return { model: buildKojo2PreviewModel(compiled, sourceMapModel), failure: null };
    } catch (error) {
      return {
        model: null,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  }, [compiled.erb, compiled.diagnostics, sourceMapModel]);

  const model = built.model;
  const [viewport, setViewport] = useState<{ scrollTop: number; viewportHeight: number }>(() => ({
    scrollTop: base.scrollTop,
    viewportHeight: base.viewportHeight,
  }));
  const viewportRef = useRef(viewport);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 首帧量一次真实高度（没有 DOM / 高度为 0 时保持注入值）
  useEffect(() => {
    if (!enabled) return;
    const host = bodyRef.current;
    if (host === null) return;
    const height = host.clientHeight;
    if (height > 0 && height !== viewportRef.current.viewportHeight) {
      viewportRef.current = { ...viewportRef.current, viewportHeight: height };
      setViewport(viewportRef.current);
    }
  }, [enabled]);

  // 外部源光标行 → 滚到对应预览行（模型给目标行，这里只乘行高并夹到可滚范围）
  useEffect(() => {
    if (!enabled || model === null || sourceCursorLine === null) return;
    const host = bodyRef.current;
    const current = viewportRef.current;
    const hostHeight = host !== null && host.clientHeight > 0 ? host.clientHeight : current.viewportHeight;
    const plan = scrollPreviewToSource(host, model, sourceCursorLine, {
      ...base,
      scrollTop: current.scrollTop,
      viewportHeight: hostHeight,
    });
    if (plan === null) return;
    if (plan.scrollTop === current.scrollTop && hostHeight === current.viewportHeight) return;
    viewportRef.current = { scrollTop: plan.scrollTop, viewportHeight: hostHeight };
    setViewport(viewportRef.current);
    // 只依赖原始量（宿主每次 render 都可能递一个新 metrics 对象字面量）：
    // 依赖 `base` 对象身份会让这个 effect 每帧重跑一次。
  }, [enabled, model, sourceCursorLine, base.rowHeight, base.overscan, base.scrollTop, base.viewportHeight]);

  // 滚动：量化到行边界，窗口没变就不 setState（大文件滚动不逐帧重渲）
  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const host = event.currentTarget;
      const nextTop = quantizePreviewScrollTop(host.scrollTop, base.rowHeight);
      const nextHeight = host.clientHeight > 0 ? host.clientHeight : viewportRef.current.viewportHeight;
      const current = viewportRef.current;
      if (nextTop === current.scrollTop && nextHeight === current.viewportHeight) return;
      viewportRef.current = { scrollTop: nextTop, viewportHeight: nextHeight };
      setViewport(viewportRef.current);
    },
    [base.rowHeight],
  );

  if (!enabled) return null;

  const activeLine =
    model !== null && sourceCursorLine !== null
      ? model.previewLineForSourceLine(sourceCursorLine)
      : null;
  const visibleWindow =
    model === null
      ? EMPTY_WINDOW
      : previewWindowFor(model, {
          ...base,
          scrollTop: viewport.scrollTop,
          viewportHeight: viewport.viewportHeight,
        });
  const rows =
    model === null
      ? []
      : renderPreviewRows(model, visibleWindow, {
          onJumpToSource,
          rowHeight: base.rowHeight,
          ...(activeLine === null ? {} : { activeLine }),
        });

  return (
    <section
      className="kojo2-preview"
      data-lines={model?.lineCount ?? 0}
      style={PANEL_STYLE}
      aria-label="Kojo 2.0 编译预览"
    >
      <header className="kojo2-preview__head" style={HEAD_STYLE}>
        <span
          aria-hidden="true"
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 0 3px var(--accent-dim)',
            flex: '0 0 auto',
          }}
        />
        <span className="kojo2-preview__title" style={{ color: 'var(--fg)' }}>
          编译预览
        </span>
        <span className="kojo2-preview__count" data-role="lines">
          {model === null ? 0 : model.lineCount} 行产物
        </span>
        {sourceCursorLine !== null && activeLine !== null ? (
          <span className="kojo2-preview__sync" data-role="sync">
            源 {sourceCursorLine} → 预览 {activeLine}
          </span>
        ) : null}
      </header>

      {built.failure !== null ? (
        <div
          className="kojo2-preview__error"
          role="alert"
          style={{
            padding: '10px',
            color: 'var(--danger)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            borderLeft: '2px solid var(--danger)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {built.failure}
        </div>
      ) : model === null ? null : model.lineCount === 0 ? (
        <div
          className="kojo2-preview__empty"
          style={{ padding: '10px', color: 'var(--fg-dim)' }}
        >
          这份文件没有可预览的产物行（编译没有产出字节）。
        </div>
      ) : (
        <div
          ref={bodyRef}
          className="kojo2-preview__body"
          data-window-start={visibleWindow.startLine}
          data-window-end={visibleWindow.endLine}
          data-window-count={visibleWindow.count}
          onScroll={handleScroll}
          style={BODY_STYLE}
        >
          <div
            className="kojo2-preview__pad kojo2-preview__pad--top"
            aria-hidden="true"
            style={{ height: `${visibleWindow.topPadding}px` }}
          />
          {rows}
          <div
            className="kojo2-preview__pad kojo2-preview__pad--bottom"
            aria-hidden="true"
            style={{ height: `${visibleWindow.bottomPadding}px` }}
          />
        </div>
      )}

      {model !== null && model.unlocatedDiagnostics.length > 0
        ? unlocatedList(model.unlocatedDiagnostics)
        : null}
    </section>
  );
}
