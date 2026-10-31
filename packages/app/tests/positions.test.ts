import { describe, expect, it } from 'vitest';
import { clampColumn, clampLine, clampLogicalOffset } from '@kojo/kojo-core';
import {
  clampMonacoColumn,
  clampMonacoLine,
  columnIndexIn,
  toMonacoColumn,
  toMonacoLine,
  toMonacoLineRange,
  toMonacoPosition,
  toZeroBasedColumn,
  toZeroBasedPoint,
  toZeroBasedRow,
} from '../src/monaco/positions';

describe('positions：tree-sitter 0 基 ↔ Monaco 1 基', () => {
  it('行号只差 1，最大真实文件行号也不丢精度', () => {
    expect(toMonacoLine(0)).toBe(1);
    expect(toMonacoLine(52_600)).toBe(52_601);
    expect(toZeroBasedRow(1)).toBe(0);
    expect(toZeroBasedRow(52_601)).toBe(52_600);
  });

  it('列号按 UTF-16 码元计：CJK 占 1、emoji 占 2', () => {
    expect(toMonacoColumn('恋'.length)).toBe(2);
    expect(toMonacoColumn('😀'.length)).toBe(3);
    expect(toZeroBasedColumn(2)).toBe(1);
    expect(toZeroBasedColumn(3)).toBe(2);
  });

  it('点与折叠区间走同一套换算', () => {
    expect(toMonacoPosition({ row: 2, column: 0 })).toEqual({ lineNumber: 3, column: 1 });
    expect(toZeroBasedPoint({ lineNumber: 3, column: 1 })).toEqual({ row: 2, column: 0 });
    expect(toMonacoLineRange({ startRow: 0, endRow: 2 })).toEqual({ start: 1, end: 3 });
  });

  it('CRLF 只增加逻辑行数，不改变列基数', () => {
    const lines = 'a\r\nb\r\n'.split('\n');
    expect(lines.length - 1).toBe(2);
    expect(toMonacoLine(1)).toBe(2);
    expect(toMonacoColumn(0)).toBe(1);
  });

  it('夹取保留既有边界语义', () => {
    expect(clampMonacoLine(0, 10)).toBe(1);
    expect(clampMonacoLine(11, 10)).toBe(10);
    expect(clampMonacoLine(Number.NaN, 10)).toBe(1);
    expect(clampMonacoColumn(0, 5)).toBe(1);
    expect(clampMonacoColumn(6, 5)).toBe(5);
    expect(clampMonacoColumn(Number.NaN, 5)).toBe(1);
  });

  it('夹取实现单源（POS-UTIL）：与 core `clampLine` / `clampColumn` 逐字同口径', () => {
    const lines = [0, 1, 3.7, 11, Number.NaN, Number.POSITIVE_INFINITY, -1];
    for (const line of lines) expect(clampMonacoLine(line, 10)).toBe(clampLine(line, 10));
    const columns = [0, 1, 2.9, 6, Number.NaN, Number.POSITIVE_INFINITY, -1];
    for (const column of columns) expect(clampMonacoColumn(column, 5)).toBe(clampColumn(column, 5));
    // 非有限值退回首行/首列（不夹到边界冒充一个真实位置）
    expect(clampMonacoLine(Number.POSITIVE_INFINITY, 10)).toBe(1);
    expect(clampMonacoColumn(Number.POSITIVE_INFINITY, 5)).toBe(1);
  });

  it('行内列 → 0 基下标：实现在 core `clampLogicalOffset`（CJK / emoji / 越界同一把尺子）', () => {
    for (const line of ['', '恋', '😀哈', '    心形 「甲」']) {
      for (const column of [-2, 0, 1, 2, 3, 99]) {
        expect(columnIndexIn(line, column)).toBe(clampLogicalOffset(column, line.length));
      }
    }
    // 1 基列 1 = 行首下标 0；emoji 占 2 码元，列 3 = `哈` 之前的插入点（下标 2）
    expect(columnIndexIn('😀哈', 1)).toBe(0);
    expect(columnIndexIn('😀哈', 2)).toBe(1); // 代理对中间：码元口径，仍是一个合法下标
    expect(columnIndexIn('😀哈', 3)).toBe(2);
    expect(columnIndexIn('😀哈', 99)).toBe(3); // 行尾之后
    expect(columnIndexIn('恋', 0)).toBe(0);
    expect(columnIndexIn('恋', Number.NaN)).toBe(0);
  });
});
