/**
 * 位置换算的**单源**：tree-sitter 一侧是 0 基行/列，Monaco 与契约折叠区间是
 * 1 基行/列；web-tree-sitter 的列与 Monaco 的列都以 **UTF-16 码元**计。
 *
 * 这里只做边界换算，不做 CST↔AST 节点映射，也不做 UTF-8/字节偏移换算。
 * 任何位置穿过 tree-sitter ↔ Monaco 边界都必须走本模块，避免每处各写一遍 `+ 1`。
 *
 * ## POS-UTIL 收口（本模块的定位）
 *
 * - **0 基 ↔ 1 基只有这一处**（`toMonacoLine` / `toZeroBasedRow` / `toMonacoColumn` /
 *   `toZeroBasedColumn` / 点与区间两枚）：tree-sitter 的 `startPosition`、Monaco 语义 token
 *   五元组这些**协议原生 0 基**的点，就在调用点用它们换，**不把 0 基线往上层传**；
 * - **1 基的夹取与列内下标不是本模块的实现**：`clampMonacoLine` / `clampMonacoColumn` /
 *   `columnIndexIn` 一律委托 `@kojo/kojo-core` 的 `clampLine` / `clampColumn` /
 *   `clampLogicalOffset`（core `positions.ts` / `lower/column-fold.ts` 是唯一实现）——
 *   口径漂移（NaN / 越界 / 全角空格）只可能在那一处发生；
 * - 本模块只被主线程的 Monaco 侧 import（worker 图不取 core 值，见
 *   `tree-sitter/worker-bootstrap.ts` 纪律 1）。
 */
import { clampColumn, clampLine, clampLogicalOffset } from '@kojo/kojo-core';

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

/**
 * 把 1 基行夹到 Monaco 模型现实；非有限 / 非法值退回首行（规则在 core `clampLine`：
 * `NaN` / `±Infinity` / 0 都当"没给"，不夹到边界冒充一个真实行）。
 */
export function clampMonacoLine(line: number, lineCount: number): number {
  return clampLine(line, lineCount);
}

/** 把 1 基列夹到该行合法列；非有限 / 非法值退回第一列（规则在 core `clampColumn`）。 */
export function clampMonacoColumn(column: number, maxColumn: number): number {
  return clampColumn(column, maxColumn);
}

/**
 * 1 基列 → 行内 0 基码元下标（**越界夹取的唯一入口**，规则在 core `clampLogicalOffset`）。
 *
 * 用于"光标列 ⇒ 这一行字符串的下标"这类行内判读（补全 / 悬停 / 签名 / 内联补全）；调用方
 * 不许再写 `Math.min(column - 1, line.length)`。
 */
export function columnIndexIn(line: string, column: number): number {
  return clampLogicalOffset(column, line.length);
}
