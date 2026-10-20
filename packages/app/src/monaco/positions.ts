/**
 * 位置换算的**单源**：tree-sitter 一侧是 0 基行/列，Monaco 与契约折叠区间是
 * 1 基行/列；web-tree-sitter 的列与 Monaco 的列都以 **UTF-16 码元**计。
 *
 * 这里只做边界换算，不做 CST↔AST 节点映射，也不做 UTF-8/字节偏移换算。
 * 任何位置穿过 tree-sitter ↔ Monaco 边界都必须走本模块，避免每处各写一遍 `+ 1`。
 */

/** tree-sitter（或其它内部协议）的 0 基点 */
export interface ZeroBasedPoint {
  readonly row: number;
  readonly column: number;
}

/** Monaco 的 1 基点（`column` 为 UTF-16 码元，1 基） */
export interface MonacoPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** 0 基行区间（含首尾）→ Monaco 折叠区间的 1 基行（含首尾） */
export interface ZeroBasedLineRange {
  readonly startRow: number;
  readonly endRow: number;
}

export interface MonacoLineRange {
  readonly start: number;
  readonly end: number;
}

/** 0 基行 → 1 基行 */
export function toMonacoLine(row: number): number {
  return row + 1;
}

/** 1 基行 → 0 基行 */
export function toZeroBasedRow(line: number): number {
  return line - 1;
}

/** 0 基列（UTF-16 码元）→ 1 基列 */
export function toMonacoColumn(column: number): number {
  return column + 1;
}

/** 1 基列（UTF-16 码元）→ 0 基列 */
export function toZeroBasedColumn(column: number): number {
  return column - 1;
}

/** 0 基点 → Monaco 点 */
export function toMonacoPosition(point: ZeroBasedPoint): MonacoPosition {
  return {
    lineNumber: toMonacoLine(point.row),
    column: toMonacoColumn(point.column),
  };
}

/** Monaco 点 → 0 基点 */
export function toZeroBasedPoint(position: MonacoPosition): ZeroBasedPoint {
  return {
    row: toZeroBasedRow(position.lineNumber),
    column: toZeroBasedColumn(position.column),
  };
}

/** 0 基行区间 → Monaco 折叠行区间 */
export function toMonacoLineRange(range: ZeroBasedLineRange): MonacoLineRange {
  return {
    start: toMonacoLine(range.startRow),
    end: toMonacoLine(range.endRow),
  };
}

/** 把 1 基行夹到 Monaco 模型现实；非法值退回首行（与既有折叠/诊断口径一致） */
export function clampMonacoLine(line: number, lineCount: number): number {
  return Math.min(Math.max(1, Math.trunc(line) || 1), lineCount);
}

/** 把 1 基列夹到该行合法列；非法值退回第一列 */
export function clampMonacoColumn(column: number, maxColumn: number): number {
  return Math.min(Math.max(1, Math.trunc(column) || 1), maxColumn);
}
