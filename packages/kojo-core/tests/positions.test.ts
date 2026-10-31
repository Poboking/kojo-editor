/**
 * POS-UTIL：`positions.ts` 是**全仓唯一的 1 基坐标模块**（偏移 ⇄ 位置、行索引、夹取）。
 *
 * 这里钉的是"边界口径"本身，不是某个调用方的行为：
 * - 列按 **UTF-16 码元**（CJK = 1、emoji 代理对 = 2）——与 Monaco / source map 同一把尺子；
 * - 换行只认 `\n` 分行，但**行内容宽度**要扣掉紧邻 `\n`（或文末）的那个 `\r`——
 *   Monaco model 的换行已归一，`getLineMaxColumn` 看到的是扣掉 `\r` 的长度；
 * - 线性实现（`offsetToPosition`）与预建行首表（`createPositionIndex`）**必须逐字同口径**；
 * - 夹取从不抛错、也不把"给歪了"的值伪装成边界（非有限数退回首行/首列）；
 * - 幂等：`offsetOf(at(x)) === x`、`clamp(clamp(p)) === clamp(p)`。
 */

import { describe, expect, it } from 'vitest';
import {
  clampColumn,
  clampLine,
  clampPosition,
  comparePositions,
  createPositionIndex,
  offsetToPosition,
  toZeroBasedRows,
} from '../src/positions.js';

/** 混合探针：CJK + emoji（代理对）+ CRLF + 末行无换行。码元总数 = 10，行首 = [0, 6, 9] */
const MIXED = '甲😀乙\r\n丙\r\n末';

describe('positions · 偏移 ⇄ 位置（1 基行 / 1 基 UTF-16 列）', () => {
  it('CJK 占 1 码元、emoji 占 2 码元（代理对不折成码点）', () => {
    const index = createPositionIndex(MIXED);
    expect(MIXED.length).toBe(10);
    expect(index.lineStarts).toEqual([0, 6, 9]);
    expect(index.lineCount).toBe(3);
    // 行内：甲(1) 😀(2) 乙(1) ⇒ `乙` 起于第 4 列，`\r` 在第 5 列
    expect(index.at(0)).toEqual({ line: 1, column: 1 });
    expect(index.at(3)).toEqual({ line: 1, column: 4 });
    expect(index.at(4)).toEqual({ line: 1, column: 5 });
    expect(index.at(6)).toEqual({ line: 2, column: 1 });
    expect(index.at(9)).toEqual({ line: 3, column: 1 });
  });

  it('CRLF：`\\r` 不算行内容宽度（与 Monaco `getLineMaxColumn` 同口径）', () => {
    const index = createPositionIndex(MIXED);
    expect(index.lineWidth(1)).toBe(4); // 甲😀乙（`\r` 不算）
    expect(index.lineMaxColumn(1)).toBe(5);
    expect(index.lineWidth(2)).toBe(1); // 丙
    expect(index.lineMaxColumn(2)).toBe(2);
    expect(index.lineWidth(3)).toBe(1); // 末行无换行
    expect(index.lineStart(2)).toBe(6);
  });

  it('LF / CRLF / 裸 CR：只按 `\\n` 分行（裸 `\\r` 是内容，不是换行）', () => {
    const lf = createPositionIndex('a\nb');
    expect(lf.lineCount).toBe(2);
    expect(lf.lineWidth(1)).toBe(1);

    const crlf = createPositionIndex('a\r\nb');
    expect(crlf.lineCount).toBe(2);
    expect(crlf.lineWidth(1)).toBe(1);
    expect(crlf.at(3)).toEqual({ line: 2, column: 1 });

    const crOnly = createPositionIndex('a\rb');
    expect(crOnly.lineCount).toBe(1); // 内核 EOL 归一口径：裸 `\r` 也会被归一成 `\n`，本模块不做第二次
    expect(crOnly.lineWidth(1)).toBe(3);
    expect(crOnly.at(2)).toEqual({ line: 1, column: 3 });
  });

  it('空文本 / 文末换行：行数按 Monaco `getLineCount()` 口径（空串 1 行）', () => {
    const empty = createPositionIndex('');
    expect(empty.lineCount).toBe(1);
    expect(empty.lineWidth(1)).toBe(0);
    expect(empty.lineMaxColumn(1)).toBe(1);
    expect(empty.at(0)).toEqual({ line: 1, column: 1 });

    const trailing = createPositionIndex('a\n');
    expect(trailing.lineCount).toBe(2);
    expect(trailing.lineWidth(2)).toBe(0);
    expect(trailing.lineMaxColumn(2)).toBe(1);
  });

  it('越界偏移夹进 [0, length]，线性实现与行首表实现逐字同口径', () => {
    const index = createPositionIndex(MIXED);
    expect(index.at(-5)).toEqual({ line: 1, column: 1 });
    expect(index.at(999)).toEqual({ line: 3, column: 2 });
    for (let offset = 0; offset <= MIXED.length; offset += 1) {
      expect(offsetToPosition(MIXED, offset)).toEqual(index.at(offset));
    }
  });

  it('位置 ⇄ 偏移往返恒等（含 `\\r` / `\\n` 所在偏移）', () => {
    const index = createPositionIndex(MIXED);
    for (let offset = 0; offset <= MIXED.length; offset += 1) {
      expect(index.offsetOf(index.at(offset))).toBe(offset);
    }
    expect(index.offsetOf({ line: 2, column: 1 })).toBe(6);
    expect(index.offsetOf({ line: 3, column: 2 })).toBe(10);
    // 给歪了：行 / 列各自夹取，不抛错
    expect(index.offsetOf({ line: 0, column: -3 })).toBe(0);
    expect(index.offsetOf({ line: 99, column: 1 })).toBe(9);
  });

  it('区间比较与 0 基行号换算（折叠协议边界）', () => {
    const a = { line: 1, column: 5 };
    const b = { line: 2, column: 1 };
    expect(comparePositions(a, b)).toBeLessThan(0);
    expect(comparePositions(b, b)).toBe(0);
    expect(comparePositions(b, a)).toBeGreaterThan(0);
    expect(toZeroBasedRows({ start: a, end: b })).toEqual({ startRow: 0, endRow: 1 });
  });
});

describe('positions · 夹取规则（全仓唯一一份）', () => {
  it('行：0 / 负数 / NaN / ±Infinity 一律退回首行；越界夹到末行；小数截断', () => {
    expect(clampLine(0, 10)).toBe(1);
    expect(clampLine(-5, 10)).toBe(1);
    expect(clampLine(Number.NaN, 10)).toBe(1);
    expect(clampLine(Number.POSITIVE_INFINITY, 10)).toBe(1);
    expect(clampLine(Number.NEGATIVE_INFINITY, 10)).toBe(1);
    expect(clampLine(11, 10)).toBe(10);
    expect(clampLine(3.7, 10)).toBe(3);
    expect(clampLine(5, 0)).toBe(1); // 空文档仍有第 1 行
  });

  it('列：同一条退化规则；上限 = 该行最后一个合法列', () => {
    expect(clampColumn(0, 5)).toBe(1);
    expect(clampColumn(-2, 5)).toBe(1);
    expect(clampColumn(Number.NaN, 5)).toBe(1);
    expect(clampColumn(Number.POSITIVE_INFINITY, 5)).toBe(1);
    expect(clampColumn(6, 5)).toBe(5);
    expect(clampColumn(2.9, 5)).toBe(2);
    expect(clampColumn(3, 0)).toBe(1);
  });

  it('`clampPosition`：先夹行再按该行问最大列（行越界时不会问出一行不存在的行长）', () => {
    const asked: number[] = [];
    const maxColumnOf = (line: number): number => {
      asked.push(line);
      return line * 10;
    };
    expect(clampPosition({ line: 99, column: 99 }, 3, maxColumnOf)).toEqual({ line: 3, column: 30 });
    expect(asked).toEqual([3]);
    expect(clampPosition({ line: Number.NaN, column: 4 }, 3, maxColumnOf)).toEqual({ line: 1, column: 4 });
  });

  it('幂等：同一位置夹两次结果不变', () => {
    const once = clampPosition({ line: 9, column: 99 }, 2, () => 4);
    expect(clampPosition(once, 2, () => 4)).toEqual(once);
  });
});
