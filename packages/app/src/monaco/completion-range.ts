import type * as Monaco from './entry';

/**
 * COMPL-SHARED · 补全候选的**行内替换区间**构造（单份）。
 *
 * `.kojo` 各补全 source 出货时都要把「0 基下标区间」翻成 Monaco 的 1 基 `IRange`，
 * 且区间恒在该 `position` 自己那一行。此前每个 source 自持一份同样实现的私有助手——
 * 本模块收成一份：**只有一处 0→1 基换算**，各 source 不再各自 +1（换算错位过一次口径漂移）。
 *
 * 纯构造函数，零语言知识、零字表。
 */

/** 行内替换区间（1 基列；覆盖光标处那段令牌 / 空插入点；`start`/`end` 为 0 基、`end` 不含） */
export function lineRange(position: Monaco.Position, start: number, end: number): Monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: start + 1,
    endColumn: end + 1,
  };
}
