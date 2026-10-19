/**
 * 光标处的**标识符整串**（极小纯函数，跨插件共享）。
 *
 * 为什么住契约层：ERB 线与语法糖线都要"光标位置 → 那个记号"，两处各写一份必然漂移
 * （命中区间或列口径不同 ⇒ 一条线能跳、另一条跳空），而插件之间**不许交叉 import**
 * （解耦审计 C 项）——共享极小件的唯一合法落点就是 `plugin-api`。
 *
 * 这不是"游戏知识"：字符集就是**引擎原生标识符**的形状（`[A-Za-z0-9_]`，`_` 允许开头
 * 以外的任意位置），与 `erb-parser/scanner.ts` 解析 `@NAME` 头时用的是同一集。
 *
 * 不收 `:`/`.`/CJK 是**这张表自己**的口径，不是"全局取词口径"：
 * - 不收 `:` ⇒ `CFLAG:FOO` 是变量引用；消费方若要"成员访问整槽都不算名字"，那条判据住在
 *   消费方（`erb-parser/references.ts::colonAdjacent`），不在本尺上加成第三个字符集；
 * - 不收 CJK ⇒ 本表现在**只服务"键就是 ASCII 原生名"的查表路**（宿主悬停 / 补全的系统
 *   函数表与 eraTW 基础库表反查）。实测库表 471 条里原生名含非 ASCII 的只有 13 条，
 *   且 13/13 是恒等条目（`充填率` → `充填率`）⇒ 放宽这把尺那条路买不到任何新信息，
 *   却会抢掉函数索引路的 docComment 与定义位（优先序裁决见宿主 `kojo-hover.ts`）。
 *
 * **作者自己起的名字**不在本表的服务面内：转到定义 / 查找引用 / 改名 / 引用面板 /
 * 结构化着色一律用契约 `semantic-locate` 的 `MODEL_TOKEN_CLASS`（`unicodeTokenAt`）。
 * F12-TOKEN（2026-10-19）之前那两条腿错用了本表的缺省集，症状与读数：真实语料 25,003 条
 * 含 CJK 的 `@` 定义名，在 50,006 个名字点位上本尺给出 45,035 次**残缺**记号（混排名被
 * 切成 ASCII 半截），其中查得到定义的只有 61 次（0.12%）——中文函数名的 F12 事实上是瞎的。
 * 换尺的代价量在中文散文那一面：1,269,664 个散文光标点位里 3,287 个（0.26%）答得出定义，
 * 其中本批新增 1,384 个（0.11%），而每一次落点都是"光标下那一整串恰好是某个函数的名字"。
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
