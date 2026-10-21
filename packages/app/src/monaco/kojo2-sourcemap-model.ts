/**
 * Kojo 2.0 源码映射的宿主视图模型（K2-SOURCEMAP-HOST）。
 *
 * 输入是 core `SourceMap`（1 基行 / 1 基列、UTF-16 码元）+ 产物文本 `erb`；输出是宿主
 * （预览面板 / 跳转 / 高亮）可直接消费的**双向查询面 + 区间查询**。纯函数、零 Monaco、零 IO。
 *
 * ## 口径（写死，宿主侧唯一一份）
 * - 所有位置 **1 基行 / 1 基列，列按 UTF-16 码元**（与 core / Monaco 同坐标系，不做 0 基换算）；
 * - **生成侧（.erb）越界一律 clamp**：行夹到 `[1, lineCount]`，列夹到 `[1, 行宽+1]`
 *   （行宽 = 该行 UTF-16 码元数，代理对占两格；行宽+1 是行尾光标位）；
 * - **源侧（.kojo2）没有源文本可夹**：非正整数行/列直接 `undefined`（不猜、不借邻居行）；
 * - 没有映射（行未登记 / `source === null` / 源位置不在任何映射区间内）一律**显式
 *   `undefined`**，绝不拿上一行/下一行的映射冒充；
 * - **行级映射的列是码元偏移投影**：生成第 `c` 列 ↔ 源 span 起点后第 `(c-1)` 个码元，
 *   结果夹在 span 的**可落点列** `[start.column, max(start.column, end.column-1)]`
 *   （`end` 是半开终点，夹到终点会让正向查不回来）；跨行源 span 没有可投影的列，锚到 `start`；
 * - 正向查询优先**主映射**（`SourceMapLine.source`），主映射不覆盖时回落到模板/池的
 *   `origins`（调用处 / 模板/池定义处）；同档命中多行时**单行 span 优先于跨行 span**
 *   （块头/包装行的多行 span 不许压过块体精确行），再取**最早产物行**（行号小优先，同行取列小）；
 *   反向查询用 core `lookup`，列级分段（`segment`）优先于行级。
 * - **列级分段只细化反向**：core 的公共查询面（`lineAt` / `lookup`）不枚举 segment，正向索引
 *   只能按行级主映射 + origins 建；当前 core 产线也尚未发射 segment（`buffer.segment` 未用），
 *   因此正向列精度 = 行级投影。core 以后若暴露 segment 迭代，这里再加一层细化，不动调用方。
 * - `generatedInRange` 的源区间是**半开** `[start, end)`；反向区间（end < start）返回空数组；
 *   零宽区间（start == end）按点查询处理，返回的生成区间也允许零宽。
 *
 * ## 性能
 * - 模型构造 **O(n)**：只切一次产物行，不建表；
 * - 反向索引（源行 → 产物行）**懒建一次**：大文件只在第一次正向 / 区间查询时付一次扫描；
 * - 单次反向查询 O(log n)（core 的行 / 分段二分）；区间查询沿源行区间推进并封顶到索引里
 *   出现过的最大源行，不被离谱的 `end.line` 拖成全表扫描。
 */
import type {
  KojoPosition,
  KojoSpan,
  SourceMap,
  SourceMapLine,
  SourceMapLineKind,
} from '@kojo/kojo-core';
import { comparePositions } from '@kojo/kojo-core';

/** 编译结果里宿主真正需要的两格（core `CompileKojoResult` / kojo-sugar 服务结果都结构兼容） */
export interface Kojo2CompileResultLike {
  readonly erb: string;
  readonly sourceMap: SourceMap;
}

/**
 * 命中一段源区间的生成侧区间（单行；1 基、UTF-16）。
 *
 * `[startColumn, endColumn)` 为半开区间；点查询（源区间零宽）时 `endColumn === startColumn`，
 * 调用方若要画波浪线请自行扩成一格（与 `kojo2-diagnostics` 的零宽处理同口径）。
 */
export interface Kojo2GeneratedRange {
  /** 1 基产物行号 */
  readonly generatedLine: number;
  /** 1 基起始列（UTF-16 码元） */
  readonly startColumn: number;
  /** 半开终点列（UTF-16 码元） */
  readonly endColumn: number;
  /** 该产物行的映射类别（`source` / `generated` / `template` / `pool` / `native`） */
  readonly kind: SourceMapLineKind;
  /** 命中的映射源 span（模板/池展开经 origin 命中时是调用处或定义处 span） */
  readonly source: KojoSpan;
  /** 命中方式：主映射 = `source`；模板/池 origins = `origin` */
  readonly via: 'source' | 'origin';
}

/** 宿主侧只读查询面（纯函数：同一模型同一查询永远同一答案） */
export interface Kojo2SourceMapModel {
  /** 产物行数（= `splitKojo2GeneratedLines(erb).length`） */
  readonly generatedLineCount: number;
  /**
   * 产物行的 core 映射（未登记 / 越界 = `null`）。
   * 这是给 UI 读 `kind` / `source` / `origins` 的窗口；位点换算仍走下面三个查询。
   */
  lineAt(generatedLine: number): SourceMapLine | null;
  /**
   * `.kojo2` 位置 → 产物 `.erb` 位置。
   *
   * 源侧位置必须是正整数行/列（否则 `undefined`）；没有映射（声明 / 注释 / 物理空行等不产字节的
   * 源行、或列落在所有 span 之外）→ `undefined`。命中时**单行 span 优先于跨行 span**，同档取
   * 最早产物行；列按码元偏移投影。
   */
  kojoToGenerated(position: KojoPosition): KojoPosition | undefined;
  /**
   * 产物 `.erb` 位置 → `.kojo2` 位置（预览点击跳回源码）。
   *
   * 生成侧越界先 clamp；没有映射（`source === null` / 行未登记）→ `undefined`。
   * 跨行源 span 只锚到 `start`（列不跨行投影）。
   */
  generatedToKojo(position: KojoPosition): KojoPosition | undefined;
  /**
   * 源区间 `[start, end)` → 产物区间数组（升序，每行至多一条；供预览高亮）。
   *
   * 端点必须正整数（否则空数组）；`end < start` 空数组；`end === start` 是点查询。
   * 主映射优先；只有主映射不覆盖时才用 templates / pools 的 origins。
   */
  generatedInRange(start: KojoPosition, end: KojoPosition): readonly Kojo2GeneratedRange[];
}

const EMPTY_LINES: readonly string[] = Object.freeze([]);
const EMPTY_RANGES: readonly Kojo2GeneratedRange[] = Object.freeze([]);

/**
 * 产物文本 → 行数组（末尾换行不多算一个空行；空产物 = 空数组）。
 *
 * core 的成功口径是 `lines.join('\n') + '\n'`，这里按同一口径切；预览模型复用本函数，
 * 避免两处各自 `split('\n')` 后行数漂移。
 */
export function splitKojo2GeneratedLines(erb: string): readonly string[] {
  if (erb.length === 0) return EMPTY_LINES;
  const lines = erb.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function isValidPosition(position: KojoPosition): boolean {
  return isPositiveInteger(position.line) && isPositiveInteger(position.column);
}

/** 生成侧行号 clamp（NaN/∞ 退到 1；行数 0 时调用方已提前返回） */
function clampGeneratedLine(value: number, lineCount: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.trunc(value)), lineCount);
}

/** 生成侧列 clamp 到 `[1, 行宽+1]`（行尾光标位也合法） */
function clampGeneratedColumn(value: number, lineLength: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.trunc(value)), lineLength + 1);
}

/** 点是否落在半开 span `[start, end)` 内 */
function spanCoversPoint(span: KojoSpan, at: KojoPosition): boolean {
  if (at.line < span.start.line || at.line > span.end.line) return false;
  if (span.start.line === span.end.line) {
    return at.column >= span.start.column && at.column < span.end.column;
  }
  if (at.line === span.start.line) return at.column >= span.start.column;
  if (at.line === span.end.line) return at.column < span.end.column;
  return at.column >= 1;
}

/** 两个半开 span 的交集（不重叠 / 零宽接触 = null；点查询另行处理） */
function intersectSpan(a: KojoSpan, b: KojoSpan): KojoSpan | null {
  if (comparePositions(a.start, b.start) === 0 && comparePositions(a.end, b.end) === 0) return a;
  if (comparePositions(b.start, b.end) === 0) {
    return spanCoversPoint(a, b.start) ? { start: b.start, end: b.end } : null;
  }
  if (comparePositions(a.end, b.start) <= 0 || comparePositions(b.end, a.start) <= 0) return null;
  const start = comparePositions(a.start, b.start) >= 0 ? a.start : b.start;
  const end = comparePositions(a.end, b.end) <= 0 ? a.end : b.end;
  return comparePositions(start, end) >= 0 ? null : { start, end };
}

type EntryVia = 'source' | 'origin';

/** 反向索引的一条：哪个产物行映射了哪个源 span、以什么身份命中 */
interface ReverseEntry {
  readonly generatedLine: number;
  /** 该产物行的 UTF-16 行宽（列投影的夹取上界） */
  readonly generatedLength: number;
  readonly span: KojoSpan;
  readonly kind: SourceMapLineKind;
  readonly via: EntryVia;
}

interface ReverseIndex {
  readonly bySourceLine: ReadonlyMap<number, readonly ReverseEntry[]>;
  /** 索引里出现过的最大源行（区间查询用它封顶，避免被离谱的 end 行拖成全表扫描） */
  readonly maxSourceLine: number;
}

/** 正向查询的一个候选：产物行 + 投影列 + 用来判具体度的 entry */
interface Candidate {
  readonly entry: ReverseEntry;
  readonly position: KojoPosition;
}

/** 候选位置择优：单行 span 比跨行 span 更具体（块头/包装行也覆盖块体，不能压过精确行）；再比行号、列号 */
function betterCandidate(current: Candidate | null, candidate: Candidate): Candidate {
  if (current === null) return candidate;
  const currentSpecific = current.entry.span.start.line === current.entry.span.end.line ? 0 : 1;
  const candidateSpecific = candidate.entry.span.start.line === candidate.entry.span.end.line ? 0 : 1;
  if (candidateSpecific !== currentSpecific) return candidateSpecific < currentSpecific ? candidate : current;
  if (candidate.position.line !== current.position.line) {
    return candidate.position.line < current.position.line ? candidate : current;
  }
  return candidate.position.column < current.position.column ? candidate : current;
}

/** 单条 entry 的源位置 → 产物列（行级映射的码元偏移投影；跨行锚到第 1 列） */
function projectEntryPoint(entry: ReverseEntry, at: KojoPosition): KojoPosition {
  if (entry.span.start.line !== entry.span.end.line) {
    return { line: entry.generatedLine, column: 1 };
  }
  const projected = 1 + (at.column - entry.span.start.column);
  return {
    line: entry.generatedLine,
    column: Math.min(Math.max(1, projected), entry.generatedLength + 1),
  };
}

/** 源区间交集 → 产物列区间（行级映射；跨行 span 对应整行） */
function projectEntryRange(
  entry: ReverseEntry,
  overlap: KojoSpan,
): { readonly startColumn: number; readonly endColumn: number } {
  if (entry.span.start.line !== entry.span.end.line) {
    return { startColumn: 1, endColumn: entry.generatedLength + 1 };
  }
  const start = 1 + (overlap.start.column - entry.span.start.column);
  const end = 1 + (overlap.end.column - entry.span.start.column);
  const startColumn = Math.min(Math.max(1, start), entry.generatedLength + 1);
  const endColumn = Math.min(Math.max(startColumn, end), entry.generatedLength + 1);
  return { startColumn, endColumn };
}

export function buildKojo2SourceMapModel(compileResult: Kojo2CompileResultLike): Kojo2SourceMapModel {
  if (typeof compileResult.erb !== 'string') {
    throw new TypeError('Kojo 2.0 源码映射：compileResult.erb 必须是字符串');
  }
  const lines = splitKojo2GeneratedLines(compileResult.erb);
  const sourceMap = compileResult.sourceMap;
  let index: ReverseIndex | null = null;

  /** 懒建反向索引：源行 → 该行覆盖到的产物行（主映射 + origins 都登记） */
  const ensureIndex = (): ReverseIndex => {
    if (index !== null) return index;
    const bySourceLine = new Map<number, ReverseEntry[]>();
    let maxSourceLine = 0;

    const register = (entry: ReverseEntry): void => {
      const from = entry.span.start.line;
      const to = entry.span.end.line;
      for (let line = from; line <= to; line++) {
        let bucket = bySourceLine.get(line);
        if (bucket === undefined) {
          bucket = [];
          bySourceLine.set(line, bucket);
        }
        bucket.push(entry);
      }
      if (to > maxSourceLine) maxSourceLine = to;
    };

    for (let generatedLine = 1; generatedLine <= lines.length; generatedLine++) {
      const mapping = sourceMap.lineAt(generatedLine);
      if (mapping === null) continue;
      const generatedLength = lines[generatedLine - 1]!.length;
      if (mapping.source !== null) {
        register({
          generatedLine,
          generatedLength,
          span: mapping.source,
          kind: mapping.kind,
          via: 'source',
        });
      }
      for (const origin of mapping.origins) {
        register({
          generatedLine,
          generatedLength,
          span: origin.span,
          kind: mapping.kind,
          via: 'origin',
        });
      }
    }

    index = { bySourceLine, maxSourceLine };
    return index;
  };

  const lineAt = (generatedLine: number): SourceMapLine | null => {
    if (!Number.isInteger(generatedLine) || generatedLine < 1 || generatedLine > lines.length) {
      return null;
    }
    return sourceMap.lineAt(generatedLine);
  };

  const kojoToGenerated = (position: KojoPosition): KojoPosition | undefined => {
    if (!isValidPosition(position)) return undefined;
    const current = ensureIndex();
    const candidates = current.bySourceLine.get(position.line);
    if (candidates === undefined) return undefined;

    let bestSource: Candidate | null = null;
    let bestOrigin: Candidate | null = null;
    for (const entry of candidates) {
      if (!spanCoversPoint(entry.span, position)) continue;
      const candidate: Candidate = { entry, position: projectEntryPoint(entry, position) };
      if (entry.via === 'source') bestSource = betterCandidate(bestSource, candidate);
      else bestOrigin = betterCandidate(bestOrigin, candidate);
    }
    return (bestSource ?? bestOrigin)?.position;
  };

  const generatedToKojo = (position: KojoPosition): KojoPosition | undefined => {
    if (lines.length === 0) return undefined;
    const line = clampGeneratedLine(position.line, lines.length);
    const column = clampGeneratedColumn(position.column, lines[line - 1]!.length);
    const hit = sourceMap.lookup({ line, column });
    if (hit.source === null) return undefined;
    const span = hit.source;
    if (span.start.line !== span.end.line) return span.start;
    // 列级分段从自己的起点起算；行级映射从产物行第 1 列起算（core 的行级口径）。
    const anchor = hit.segment === null ? 1 : hit.segment.generatedColumn;
    const projected = span.start.column + (column - anchor);
    // end 是半开终点：夹到 "end - 1" 才是能正向查回来的（`spanCoversPoint` 不含 end）。
    const lastColumn = Math.max(span.start.column, span.end.column - 1);
    const clamped = Math.min(Math.max(projected, span.start.column), lastColumn);
    return { line: span.start.line, column: clamped };
  };

  const generatedInRange = (
    start: KojoPosition,
    end: KojoPosition,
  ): readonly Kojo2GeneratedRange[] => {
    if (!isValidPosition(start) || !isValidPosition(end)) return EMPTY_RANGES;
    if (comparePositions(end, start) < 0) return EMPTY_RANGES;
    const query: KojoSpan = { start, end };
    const current = ensureIndex();
    if (current.maxSourceLine === 0) return EMPTY_RANGES;
    const lastLine = Math.min(query.end.line, current.maxSourceLine);
    if (query.start.line > lastLine) return EMPTY_RANGES;

    const seen = new Set<ReverseEntry>();
    const byGeneratedLine = new Map<number, {
      generatedLine: number;
      startColumn: number;
      endColumn: number;
      kind: SourceMapLineKind;
      source: KojoSpan;
      via: EntryVia;
    }>();

    for (let sourceLine = query.start.line; sourceLine <= lastLine; sourceLine++) {
      const bucket = current.bySourceLine.get(sourceLine);
      if (bucket === undefined) continue;
      for (const entry of bucket) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        const overlap = intersectSpan(entry.span, query);
        if (overlap === null) continue;
        const projected = projectEntryRange(entry, overlap);
        const existing = byGeneratedLine.get(entry.generatedLine);
        if (existing === undefined) {
          byGeneratedLine.set(entry.generatedLine, {
            generatedLine: entry.generatedLine,
            startColumn: projected.startColumn,
            endColumn: projected.endColumn,
            kind: entry.kind,
            source: entry.span,
            via: entry.via,
          });
          continue;
        }
        // 同一产物行：主映射压过 origin；同档则取列并集（多段源落一行）
        if (existing.via === 'source' && entry.via === 'origin') continue;
        if (existing.via === 'origin' && entry.via === 'source') {
          existing.startColumn = projected.startColumn;
          existing.endColumn = projected.endColumn;
          existing.kind = entry.kind;
          existing.source = entry.span;
          existing.via = 'source';
          continue;
        }
        existing.startColumn = Math.min(existing.startColumn, projected.startColumn);
        existing.endColumn = Math.max(existing.endColumn, projected.endColumn);
      }
    }

    if (byGeneratedLine.size === 0) return EMPTY_RANGES;
    return [...byGeneratedLine.values()].sort(
      (a, b) => a.generatedLine - b.generatedLine || a.startColumn - b.startColumn,
    );
  };

  return {
    generatedLineCount: lines.length,
    lineAt,
    kojoToGenerated,
    generatedToKojo,
    generatedInRange,
  };
}
