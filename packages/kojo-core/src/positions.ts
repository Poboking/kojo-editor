/**
 * 坐标换算的 core 单源（POS-UTIL 的 2.0 侧）。
 *
 * 口径（设计稿 §10.7）：
 * - 位置 = **1 基行 / 1 基列，列按 UTF-16 码元**（Monaco 同口径，代理对占两格）；
 * - 换行：**只认 `\n` 分行**（`\r\n` / 裸 `\r` / `\n` 混排都按 `\n` 切行），但行**内容宽度**
 *   不含紧邻 `\n` 的那个 `\r`——与 Monaco model（换行已归一）的 `getLineMaxColumn` 逐字同口径；
 * - 本模块只做"源文本 ↔ 位置"、行索引与区间工具，不做 CST↔AST 节点身份映射；
 * - 任何穿过 core 边界的行列换算必须走这里，禁止各处手写 `+ 1` / `- 1` 或自建行首表。
 *
 * ## 谁在用它（POS-UTIL 收口后的唯一去向）
 * - core 内部：`lexer.ts`（整篇偏移 → 位置）、`literal.ts` / `sema/check.ts`（切片内偏移 → 位置）；
 * - 语言面库：`@kojo/kojo-lang/diagnostics`（诊断落点夹取 + 行宽）、
 *   `@kojo/kojo-lang/sourcemap`（位置比较）；
 * - 宿主：`@kojo/app` 的 `ui/kojo2-problem-wiring`（marker 夹取）、`ui/kojo2-storage-registry`
 *   （模型行索引）、`monaco/kojo-language-service-legs`（行数）、`monaco/positions`（1 基夹取）。
 *
 * **0 基只活在边界上**：tree-sitter 的点（`startPosition.row/column`）与 Monaco 语义 token 的
 * 五元组天然 0 基，转换点只有 `@kojo/app` 的 `monaco/positions.ts`（点名「边界转换点」），
 * core 这侧只提供 `toZeroBasedRows` 把 1 基 span 交给折叠协议——绝不把 0 基线反向带进来。
 */
import type { KojoPosition, KojoSpan } from './ast.js';

export function position(line: number, column: number): KojoPosition {
  return { line, column };
}

export function span(start: KojoPosition, end: KojoPosition): KojoSpan {
  return { start, end };
}

/** 点位置 → 零宽 span */
export function pointSpan(at: KojoPosition): KojoSpan {
  return { start: at, end: at };
}

/** 比较两位置：<0 / 0 / >0（先 line 后 column） */
export function comparePositions(a: KojoPosition, b: KojoPosition): number {
  return a.line === b.line ? a.column - b.column : a.line - b.line;
}

export function containsPosition(outer: KojoSpan, inner: KojoPosition): boolean {
  return comparePositions(outer.start, inner) <= 0 && comparePositions(inner, outer.end) < 0;
}

export function spansOverlap(a: KojoSpan, b: KojoSpan): boolean {
  return comparePositions(a.start, b.end) < 0 && comparePositions(b.start, a.end) < 0;
}

/** 两个 span 的并集（用于块收束位置） */
export function mergeSpans(a: KojoSpan, b: KojoSpan): KojoSpan {
  return {
    start: comparePositions(a.start, b.start) <= 0 ? a.start : b.start,
    end: comparePositions(a.end, b.end) >= 0 ? a.end : b.end,
  };
}

/**
 * 源文本偏移（UTF-16 码元，0 基）→ 1 基位置。
 *
 * 线性扫描思路：调用方通常按行推进，本函数对短切片（表达式/单行）足够快；
 * 整文件场景请用 `createPositionIndex(text).at(offset)` 预建行首表（O(log n) 二分）。
 */
export function offsetToPosition(text: string, offset: number): KojoPosition {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

/**
 * 预建行首表：整文件偏移 ⇄ 位置的高频路径只付一次线性扫描。
 *
 * 行**内容宽度**口径见文件头（`\r\n` 的 `\r` 不计入行宽）；`at` / `offsetOf` 仍按**原始文本**
 * 的码元偏移计算（偏移是"文本里第几个码元"，与行宽是两件事）。
 */
export interface PositionIndex {
  readonly text: string;
  readonly lineStarts: readonly number[];
  /** 行数（空文本 = 1 行；与 Monaco `getLineCount()` 同口径） */
  readonly lineCount: number;
  at(offset: number): KojoPosition;
  offsetOf(at: KojoPosition): number;
  /** 1 基行号 → 该行起点偏移 */
  lineStart(line: number): number;
  /**
   * 1 基行号 → 该行**内容长度**（UTF-16 码元；`\r\n` / 文末 `\r` 不计。
   * 行号越界按 {@link clampLine} 夹取——查询，不抛错）。
   */
  lineWidth(line: number): number;
  /** 1 基行号 → 该行最后一个合法列（Monaco `getLineMaxColumn` 口径：行长 + 1，至少 1） */
  lineMaxColumn(line: number): number;
}

export function createPositionIndex(text: string): PositionIndex {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineCount = lineStarts.length;
  const clampOffset = (offset: number): number => Math.max(0, Math.min(offset, text.length));
  /** 行内容终点（不含换行；紧邻 `\n` 的 `\r` 与文末 `\r` 都不算内容） */
  const contentEnd = (line: number): number => {
    const at = clampLine(line, lineCount);
    const nextStart = lineStarts[at];
    const rawEnd = nextStart === undefined ? text.length : nextStart - 1;
    const start = lineStarts[at - 1]!;
    return rawEnd > start && text.charCodeAt(rawEnd - 1) === 13 /* \r */ ? rawEnd - 1 : rawEnd;
  };
  const widthOf = (line: number): number => {
    const at = clampLine(line, lineCount);
    return contentEnd(at) - lineStarts[at - 1]!;
  };
  return {
    text,
    lineStarts,
    lineCount,
    at(offset: number): KojoPosition {
      const target = clampOffset(offset);
      // 二分：最后一个 start <= target 的行
      let lo = 0;
      let hi = lineCount - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= target) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: target - lineStarts[lo]! + 1 };
    },
    offsetOf(at: KojoPosition): number {
      const line = clampLine(at.line, lineCount);
      return clampOffset(lineStarts[line - 1]! + Math.max(1, at.column) - 1);
    },
    lineStart(line: number): number {
      return lineStarts[clampLine(line, lineCount) - 1]!;
    },
    lineWidth(line: number): number {
      return widthOf(line);
    },
    lineMaxColumn(line: number): number {
      return Math.max(1, widthOf(line) + 1);
    },
  };
}

/**
 * 1 基行号 → 合法行号（**全仓唯一的行夹取规则**）。
 *
 * 非有限数（`NaN` / `±Infinity`）与 0 一律退回首行——"给歪了就按没给处理"，不夹到边界冒充
 * 一个作者没写的位置；`lineCount` 非正时按 1 行（空文档仍有第 1 行）。
 */
export function clampLine(line: number, lineCount: number): number {
  const count = Math.max(1, Number.isFinite(lineCount) ? Math.trunc(lineCount) : 1);
  const value = Number.isFinite(line) ? Math.trunc(line) : 1;
  return Math.min(Math.max(1, value), count);
}

/**
 * 1 基列 → 合法列（**全仓唯一的列夹取规则**，与 {@link clampLine} 同一条退化规则）。
 *
 * `maxColumn` 该取"该行最后一个合法列"（Monaco `getLineMaxColumn` = 行长 + 1）；越界列夹到
 * 那一格，不抛错、不静默回落到行首。
 */
export function clampColumn(column: number, maxColumn: number): number {
  const limit = Math.max(1, Number.isFinite(maxColumn) ? Math.trunc(maxColumn) : 1);
  const value = Number.isFinite(column) ? Math.trunc(column) : 1;
  return Math.min(Math.max(1, value), limit);
}

/** 把位置夹到合法范围（陈旧坐标不许让诊断/折叠崩；行先夹、再按该行取最大列） */
export function clampPosition(at: KojoPosition, lineCount: number, maxColumnOf: (line: number) => number): KojoPosition {
  const line = clampLine(at.line, lineCount);
  return { line, column: clampColumn(at.column, maxColumnOf(line)) };
}

/** span 转 0 基行号区间（tree-sitter / 折叠协议用） */
export function toZeroBasedRows(s: KojoSpan): { startRow: number; endRow: number } {
  return { startRow: s.start.line - 1, endRow: s.end.line - 1 };
}
