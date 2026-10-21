/**
 * 坐标换算的 core 单源（POS-UTIL 的 2.0 侧）。
 *
 * 口径（设计稿 §10.7）：
 * - 位置 = **1 基行 / 1 基列，列按 UTF-16 码元**（Monaco 同口径，代理对占两格）；
 * - 本模块只做"源文本 ↔ 位置"与区间工具，不做 CST↔AST 节点身份映射；
 * - 任何穿过 core 边界的行列换算必须走这里，禁止各处手写 `+ 1`。
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

/** 预建行首表：整文件偏移 ⇄ 位置的高频路径只付一次线性扫描 */
export interface PositionIndex {
  readonly text: string;
  readonly lineStarts: readonly number[];
  at(offset: number): KojoPosition;
  offsetOf(at: KojoPosition): number;
  /** 1 基行号 → 该行起点偏移 */
  lineStart(line: number): number;
}

export function createPositionIndex(text: string): PositionIndex {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const clampOffset = (offset: number): number => Math.max(0, Math.min(offset, text.length));
  return {
    text,
    lineStarts,
    at(offset: number): KojoPosition {
      const target = clampOffset(offset);
      // 二分：最后一个 start <= target 的行
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= target) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: target - lineStarts[lo]! + 1 };
    },
    offsetOf(at: KojoPosition): number {
      const line = Math.max(1, Math.min(at.line, lineStarts.length));
      return clampOffset(lineStarts[line - 1]! + Math.max(1, at.column) - 1);
    },
    lineStart(line: number): number {
      return lineStarts[Math.max(1, Math.min(line, lineStarts.length)) - 1]!;
    },
  };
}

/** 把位置夹到合法范围（陈旧坐标不许让诊断/折叠崩） */
export function clampPosition(at: KojoPosition, lineCount: number, maxColumnOf: (line: number) => number): KojoPosition {
  const line = Math.max(1, Math.min(Math.trunc(at.line) || 1, Math.max(1, lineCount)));
  const column = Math.max(1, Math.min(Math.trunc(at.column) || 1, Math.max(1, maxColumnOf(line))));
  return { line, column };
}

/** span 转 0 基行号区间（tree-sitter / 折叠协议用） */
export function toZeroBasedRows(s: KojoSpan): { startRow: number; endRow: number } {
  return { startRow: s.start.line - 1, endRow: s.end.line - 1 };
}
