import { describe, expect, it } from 'vitest';
import {
  clampMonacoColumn,
  clampMonacoLine,
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
});
