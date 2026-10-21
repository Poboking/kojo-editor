/**
 * Kojo 2.0 预览面板的数据模型（K2-SOURCEMAP-HOST / React 无关）。
 *
 * 输入是一次编译结果（产物文本 + 诊断）与 {@link Kojo2SourceMapModel}；输出是**预览行数组**
 * （每行带 `.kojo2` 源区间、映射类别、挂在该行上的诊断气泡）与三组查询：
 *
 * - `previewLineForSourceLine`：光标在源码第 X 行 → 预览应滚到第 Y 行；
 * - `sourceLineForPreviewLine`：光标在预览第 Y 行 → 源码第 X 行（点行跳回）；
 * - `diagnosticsAt`：该预览行的诊断气泡（列区间已换成产物列，1 基、UTF-16）。
 *
 * ## 口径（写死）
 * - 行/列全部 **1 基、UTF-16 码元**（预览 model 与 Monaco 同坐标系，不做 0 基换算）；
 * - 预览行文本 = 产物 `.erb` 按 `\n` 切分、末尾换行不多算一行（与 core 成功口径一致）；
 * - 预览行数必须与 source map 模型的 `generatedLineCount` 相等；不等 = **两个模型不同源**
 *   （装配 bug），构造时抛 `TypeError`，不把错位的预览画给作者；
 * - `kojoRange` = 该产物行的**主映射**源 span（模板/池展开行指向定义处；`null` = 纯生成行 /
 *   未登记行）。跳回源码用主映射，不拿 origins 冒充；
 * - 滚动目标**永不落空**（预览非空时）：源码行精确命中 → 该行首个预览行；命不中 → 最近
 *   的**前面**已映射行（声明 / 注释滚到它压住的那段产物）；早于首个映射 → 第 1 行；
 *   晚于全部映射 → 最后一个已映射行；完全没有映射（空 map）→ `null`；
 * - 反向（预览 → 源码）没有映射就是 `null`，不借邻居行；
 * - 诊断气泡只挂**真能落到产物行**的诊断：`span` 为 null、或落在不产字节的源行（声明/注释）
 *   且没有 origins 命中 → 进 `unlocatedDiagnostics`，由问题面板负责，不伪造气泡；
 *   零宽诊断照挂（列区间允许 `start === end`，画波浪线由 UI 扩格）。
 *
 * ## 性能（大文件）
 * - 构造 **O(n)**：只切一次产物行；不建行对象、不建索引；
 * - 行数组**懒构建一次**（`rows` / `rowAt` 首次访问时），诊断叠加与滚动索引同批建；
 * - 诊断叠加 = 每条诊断一次 `generatedInRange`（模型侧按源行索引，不逐预览行全表扫描）；
 * - 滚动查询 = 懒建一次「源行 → 预览行」密表（第一遍主映射、第二遍 origins），
 *   之后 O(log 源行数) 二分，不做逐行重扫。
 */
import type {
  DiagnosticCode,
  KojoDiagnostic,
  KojoSpan,
  SourceMapLineKind,
  SourceMapOrigin,
} from '@kojo/kojo-core';
import type { Kojo2SourceMapModel } from '../monaco/kojo2-sourcemap-model';
import { splitKojo2GeneratedLines } from '../monaco/kojo2-sourcemap-model';

/** 编译结果里预览真正需要的两格（core / kojo-sugar 服务结果都结构兼容） */
export interface Kojo2PreviewCompileResult {
  readonly erb: string;
  readonly diagnostics: readonly KojoDiagnostic[];
}

/** 诊断在预览行上的列区间（1 基、UTF-16；半开 `[start, end)`，零宽诊断允许相等） */
export interface Kojo2PreviewColumnRange {
  readonly start: number;
  readonly end: number;
}

/** 挂到预览行上的诊断气泡（保留输入顺序的 `index`，React key 直接可用） */
export interface Kojo2PreviewDiagnostic {
  /** 在 `compileResult.diagnostics` 里的下标（稳定 key；同一诊断可能挂多行） */
  readonly index: number;
  readonly code: DiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly span: KojoSpan | null;
  /** 落在该预览行上的列区间（1 基、UTF-16）；`null` = 只有行级落点（当前实现不会出现） */
  readonly columns: Kojo2PreviewColumnRange | null;
}

/** 一行预览（产物一行） */
export interface Kojo2PreviewRow {
  /** 1 基产物行号（= Monaco / 预览编辑器行号） */
  readonly line: number;
  /** 该行文本（不含换行） */
  readonly text: string;
  /** 该行主映射的 `.kojo2` 源 span；`null` = 纯生成行 / 未登记 */
  readonly kojoRange: KojoSpan | null;
  /** 映射类别；`null` = 未登记 */
  readonly kind: SourceMapLineKind | null;
  /** 模板/池展开的附加锚点（调用处 + 定义处）；其余行为空数组 */
  readonly origins: readonly SourceMapOrigin[];
  /** 该行的诊断气泡（按输入顺序） */
  readonly diagnostics: readonly Kojo2PreviewDiagnostic[];
  /** 该行最严重的诊断级别（`null` = 无诊断） */
  readonly severity: 'error' | 'warning' | null;
}

/** 预览面板只读查询面（纯函数：同一模型同一查询永远同一答案） */
export interface Kojo2PreviewModel {
  /** 预览行数（= 产物行数） */
  readonly lineCount: number;
  /** 预览行数组（懒构建一次；每行带 `kojoRange` 与诊断叠加） */
  readonly rows: readonly Kojo2PreviewRow[];
  /** 按 1 基预览行号取行（越界 clamp；空预览 = `null`） */
  rowAt(previewLine: number): Kojo2PreviewRow | null;
  /**
   * 源码行（1 基）→ 应滚到的预览行（1 基）。
   *
   * 预览为空 / 完全无映射 → `null`；源码行越界按 {@link Kojo2PreviewModel} 头注的 clamp 口径。
   */
  previewLineForSourceLine(sourceLine: number): number | null;
  /** 预览行（1 基）→ 源码行（1 基）；越界 clamp，未映射 = `null` */
  sourceLineForPreviewLine(previewLine: number): number | null;
  /** 该预览行的诊断气泡（越界 = 空数组） */
  diagnosticsAt(previewLine: number): readonly Kojo2PreviewDiagnostic[];
  /** 落不到任何预览行的诊断（无 span / 不产字节的源行）——交给问题面板，不伪造气泡 */
  readonly unlocatedDiagnostics: readonly KojoDiagnostic[];
}

const EMPTY_DIAGNOSTICS: readonly Kojo2PreviewDiagnostic[] = Object.freeze([]);
const EMPTY_ORIGINS: readonly SourceMapOrigin[] = Object.freeze([]);
const EMPTY_ROWS: readonly Kojo2PreviewRow[] = Object.freeze([]);

function clampPreviewLine(value: number, lineCount: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.trunc(value)), lineCount);
}

interface Overlay {
  readonly byLine: ReadonlyMap<number, readonly Kojo2PreviewDiagnostic[]>;
  readonly unlocated: readonly KojoDiagnostic[];
}

interface ScrollIndex {
  /** 源行 → 预览行（同一源行取**第一个**覆盖它的预览行） */
  readonly exact: ReadonlyMap<number, number>;
  /** `exact` 的键升序（二分用） */
  readonly keys: readonly number[];
  /** 最后一个有映射的预览行（源码行晚于全部映射时的落点） */
  readonly tail: number;
}

function buildOverlay(
  compileResult: Kojo2PreviewCompileResult,
  sourceMap: Kojo2SourceMapModel,
): Overlay {
  const byLine = new Map<number, Kojo2PreviewDiagnostic[]>();
  const unlocated: KojoDiagnostic[] = [];

  compileResult.diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.span === null) {
      unlocated.push(diagnostic);
      return;
    }
    const ranges = sourceMap.generatedInRange(diagnostic.span.start, diagnostic.span.end);
    if (ranges.length === 0) {
      unlocated.push(diagnostic);
      return;
    }
    for (const range of ranges) {
      const overlayDiagnostic: Kojo2PreviewDiagnostic = {
        index,
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        span: diagnostic.span,
        columns: { start: range.startColumn, end: range.endColumn },
      };
      let bucket = byLine.get(range.generatedLine);
      if (bucket === undefined) {
        bucket = [];
        byLine.set(range.generatedLine, bucket);
      }
      bucket.push(overlayDiagnostic);
    }
  });

  return { byLine, unlocated };
}

function buildScrollIndex(rows: readonly Kojo2PreviewRow[]): ScrollIndex {
  const exact = new Map<number, number>();
  // 第一遍：主映射优先（一个源行被多行产物覆盖时，取最先出现的那一行）
  for (const row of rows) {
    const range = row.kojoRange;
    if (range === null) continue;
    for (let line = range.start.line; line <= range.end.line; line++) {
      if (!exact.has(line)) exact.set(line, row.line);
    }
  }
  // 第二遍：模板/池 origins 只补主映射没覆盖的源行（调用处 → 展开行）
  for (const row of rows) {
    for (const origin of row.origins) {
      for (let line = origin.span.start.line; line <= origin.span.end.line; line++) {
        if (!exact.has(line)) exact.set(line, row.line);
      }
    }
  }
  const keys = [...exact.keys()].sort((a, b) => a - b);
  let tail = 0;
  for (const row of rows) {
    if (row.kojoRange !== null || row.origins.length > 0) tail = row.line;
  }
  return { exact, keys, tail: tail > 0 ? tail : rows.length };
}

export function buildKojo2PreviewModel(
  compileResult: Kojo2PreviewCompileResult,
  sourceMap: Kojo2SourceMapModel,
): Kojo2PreviewModel {
  if (typeof compileResult.erb !== 'string') {
    throw new TypeError('Kojo 2.0 预览：compileResult.erb 必须是字符串');
  }
  if (!Array.isArray(compileResult.diagnostics)) {
    throw new TypeError('Kojo 2.0 预览：compileResult.diagnostics 必须是数组');
  }
  const lines = splitKojo2GeneratedLines(compileResult.erb);
  if (sourceMap.generatedLineCount !== lines.length) {
    throw new TypeError(
      `Kojo 2.0 预览与 source map 不同源：产物 ${lines.length} 行、模型 ${sourceMap.generatedLineCount} 行。` +
        '预览必须用同一次编译产出的 source map（错位会静默跳到隔壁行）。',
    );
  }

  let overlay: Overlay | null = null;
  const ensureOverlay = (): Overlay => {
    overlay ??= buildOverlay(compileResult, sourceMap);
    return overlay;
  };

  let builtRows: readonly Kojo2PreviewRow[] | null = null;
  const ensureRows = (): readonly Kojo2PreviewRow[] => {
    if (builtRows !== null) return builtRows;
    const diagnostics = ensureOverlay();
    const rows: Kojo2PreviewRow[] = new Array(lines.length);
    for (let index = 0; index < lines.length; index++) {
      const line = index + 1;
      const mapping = sourceMap.lineAt(line);
      const attached = diagnostics.byLine.get(line) ?? EMPTY_DIAGNOSTICS;
      let severity: 'error' | 'warning' | null = null;
      for (const diagnostic of attached) {
        if (diagnostic.severity === 'error') {
          severity = 'error';
          break;
        }
        severity = 'warning';
      }
      rows[index] = {
        line,
        text: lines[index]!,
        kojoRange: mapping?.source ?? null,
        kind: mapping?.kind ?? null,
        origins: mapping?.origins ?? EMPTY_ORIGINS,
        diagnostics: attached,
        severity,
      };
    }
    builtRows = rows;
    return rows;
  };

  let scrollIndex: ScrollIndex | null = null;
  const ensureScrollIndex = (): ScrollIndex => {
    scrollIndex ??= buildScrollIndex(ensureRows());
    return scrollIndex;
  };

  const rowAt = (previewLine: number): Kojo2PreviewRow | null => {
    if (lines.length === 0) return null;
    const line = clampPreviewLine(previewLine, lines.length);
    return ensureRows()[line - 1] ?? null;
  };

  return {
    get lineCount() {
      return lines.length;
    },
    get rows() {
      return lines.length === 0 ? EMPTY_ROWS : ensureRows();
    },
    rowAt,
    previewLineForSourceLine(sourceLine: number): number | null {
      if (lines.length === 0) return null;
      const current = ensureScrollIndex();
      if (current.keys.length === 0) return null;
      if (!Number.isFinite(sourceLine)) return 1;
      const target = Math.trunc(sourceLine);
      if (target < 1) return 1;
      const exact = current.exact.get(target);
      if (exact !== undefined) return exact;
      // 二分：最后一个 <= target 的已映射源行（声明/注释滚到压住它的那段产物）
      let lo = 0;
      let hi = current.keys.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (current.keys[mid]! <= target) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (found >= 0) {
        const key = current.keys[found]!;
        if (found === current.keys.length - 1 && target > key) return current.tail;
        return current.exact.get(key) ?? null;
      }
      return 1; // 早于首个映射行：从预览头开始
    },
    sourceLineForPreviewLine(previewLine: number): number | null {
      const row = rowAt(previewLine);
      if (row === null) return null;
      return row.kojoRange?.start.line ?? null;
    },
    diagnosticsAt(previewLine: number): readonly Kojo2PreviewDiagnostic[] {
      return rowAt(previewLine)?.diagnostics ?? EMPTY_DIAGNOSTICS;
    },
    get unlocatedDiagnostics() {
      return ensureOverlay().unlocated;
    },
  };
}
