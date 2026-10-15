/**
 * 光标处的**标识符整串**（极小纯函数，跨插件共享）。
 *
 * 为什么住契约层：ERB 线与语法糖线都要"光标位置 → 那个记号"，两处各写一份必然漂移
 * （命中区间或列口径不同 ⇒ 一条线能跳、另一条跳空），而插件之间**不许交叉 import**
 * （解耦审计 C 项）——共享极小件的唯一合法落点就是 `plugin-api`。
 *
 * 这不是"游戏知识"：字符集就是**引擎函数名**的形状（`[A-Za-z0-9_]`，`_` 允许开头
 * 以外的任意位置），与 `erb-parser/scanner.ts` 解析 `@NAME` 头时用的是同一集。
 * 刻意**不收** `:`/`.`/CJK：`CFLAG:FOO` 是变量引用不是函数名，CJK 是散文不是记号
 * ——命中面宁可窄，错了会跳去看不相干的行。
 */

/** 光标命中区间（1 基列，`endColumn` 为**不含**端点；与 Monaco `Range` 同口径） */
export interface SymbolToken {
  /** 记号原文（原样大小写；查表时由消费方自行归一大写） */
  readonly text: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

/** 默认字符集：引擎函数名的形状（字母 / 数字 / 下划线） */
const DEFAULT_IS_CHAR = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

/**
 * 取光标所在（或紧邻）的标识符整串。`column` 为 1 基列，可指向记号内**任意**位置，
 * 也可落在记号末尾之后一格（Monaco 光标停在词尾时的常见形态）——两种都命中，
 * 与"悬停命中区间覆盖整串"的既有口径一致（`app/monaco/kojo-hover.ts`）。
 *
 * 返回 `undefined` = 该处没有可辨认的记号（空白 / 标点 / 行外）——**不猜**。
 */
export function symbolTokenAt(
  lineText: string,
  column: number,
  isChar: (ch: string) => boolean = DEFAULT_IS_CHAR,
): SymbolToken | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  // 列越界（超过行宽 + 1）视为行外：光标不可能在那儿
  if (column > lineText.length + 1) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  let start: number;
  let end: number;
  if (col0 < lineText.length && isChar(lineText[col0]!)) {
    start = col0;
    end = col0 + 1;
  } else if (col0 > 0 && isChar(lineText[col0 - 1]!)) {
    start = col0 - 1;
    end = col0;
  } else {
    return undefined;
  }
  while (start > 0 && isChar(lineText[start - 1]!)) start--;
  while (end < lineText.length && isChar(lineText[end]!)) end++;
  return { text: lineText.slice(start, end), startColumn: start + 1, endColumn: end + 1 };
}
