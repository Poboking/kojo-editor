/**
 * 编辑器定位落点的**行列口径**（R1 列接线批 2026-10-15；W9 落点 span 批 2026-10-17 扩到区间）。
 *
 * 事件契约 `editor.revealLocation` 从来就带 `column?`，宿主一度只消费行：列被丢弃、
 * 光标一律停行首。R1 把「一次定位请求 → 编辑器里合法的落点」收成**一个纯函数**，
 * Monaco 绑定处只做取值与落地。W9 把这颗函数扩成**带列区间**，并把它确立为
 * **全仓唯一的落点判据**：定义 / 引用 / 跳到实现 / 问题面板 / 检索面板 / G1 回放跳转
 * 六条腿都从这一个夹取函数出落点，所以"同一处位置两条腿落两个地方"这类 bug
 * 结构上不可能再出现（对拍测试见 `tests/reveal-position.test.ts`）。
 *
 * **列口径不在这里二次实现**：一行的最大合法列由 Monaco model 自己给
 * （`getLineMaxColumn` = 行长度 + 1，UTF-16 码元、1 基），与糖线源映射（S6，
 * `packages/plugins/kojo-sugar/src/column-map.ts`）声明的同一条口径——所以源映射给出的列
 * 可以直接当 Monaco 列用，两端都不必换算，也不许在这里 `length` / 数码点。
 *
 * **代理对不劈开**（2026-10-20 补）：列口径**仍是 UTF-16 码元**（`getLineMaxColumn`
 * 与糖线源映射都不动，这里也绝不把列换算成码点）。但 1 基列 `c` 是**插入点**：`c`
 * 落在代理对 high(i) / low(i+1) 两个码元**之间**时，选区会把一个字符劈成两半——
 * Peek 列表拿到半截文本、高亮错位。修正取**最小位移**：起点向对边界**内收**
 * （`c` → `c+1`，丢掉那半截），终点向对边界**外扩**（`c` → `c+1`，把整个字符收进选区），
 * 零宽落点按起点规则落在对之后的同一个边界上。判定需要该行文本，因此
 * `RevealGeometry.lineText` 是**可选注入**：不给就逐字保留改动前的纯码元夹取
 * （旧调用方零改动、也无从脑补）；给了才做边界修正。全角等 BMP 字符、孤立代理
 * （不成对）都不是"对中间"，一个码元都不挪。
 *
 * **退化只有一条**（W9 判据②）：发起方给不出 `span` 时落点退化成**零宽**
 * （起点 = `column`，给不出列就是行首 1），**不猜区间终点**、不铺到行尾。
 * 这条规则不许在任何发起方里重抄一遍——要退化，就把 `span` 留空，让这里退。
 */

import type { KernelEventMap } from '@kojo/plugin-api';

/**
 * 列区间（**契约反推**，不在宿主另立一名：`editor.revealLocation.span` 是唯一真源，
 * 这里只是给它一个能写函数签名的名字）。
 */
export type RevealSpan = NonNullable<KernelEventMap['editor.revealLocation']['span']>;

/** `editor.revealLocation` 的载荷类型（发起方构造载荷时同样反推契约，不另立形状） */
export type RevealLocationPayload = KernelEventMap['editor.revealLocation'];

/** 一次定位请求（模型坐标，1 基；`column` / `span` 缺席 = 发起方没给列，落行首，**不猜列**） */
export interface RevealTarget {
  readonly line: number;
  /** 1 基、UTF-16 码元（口径见文件头）；与 `span.columnStart` 同义，`span` 在场时以 `span` 为准 */
  readonly column?: number;
  /** 1 基、UTF-16 码元、`columnEnd` 不含；缺席 = 零宽落点（退化唯一口径见文件头） */
  readonly span?: RevealSpan;
  /** 同一文件重复定位时用于触发重新滚动（nonce 变化即重新定位） */
  readonly nonce: number;
}

/**
 * 落地后的光标位置与选区（Monaco `Position` 的两个成员 + 选区终点；
 * 这里不依赖 Monaco 类型以便纯测）。`columnEnd === column` = 零宽 = 只放光标不选。
 */
export interface RevealPosition {
  readonly lineNumber: number;
  readonly column: number;
  readonly columnEnd: number;
}

/** 夹取需要知道的**行数与行长**：由调用方从 model 现取（本模块不持有 model） */
export interface RevealGeometry {
  readonly lineCount: number;
  /** 该行最后一个合法列（Monaco `getLineMaxColumn`） */
  maxColumn(lineNumber: number): number;
  /**
   * 该行文本（可选；与 Monaco `getLineContent` 同口径，行尾不含换行）。
   * 提供时用于**代理对边界修正**（见文件头）；缺席 = 只做纯码元夹取（改动前行为）。
   * 与 `maxColumn` 一样按**已夹取的行号**问——行越界时那一行根本不存在。
   */
  lineText?(lineNumber: number): string;
}

/** 高代理区码元（UTF-16） */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 低代理区码元（UTF-16） */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 列 `column`（1 基插入点）是否切在**代理对中间**：
 * 插入点后一个码元是低代理、前一个是对应的高代理。
 * 孤立代理（不成对）与 BMP 字符（含全角）都不算。
 */
function splitsSurrogatePair(text: string, column: number): boolean {
  const low = column - 1;
  return (
    low >= 1 &&
    low < text.length &&
    isLowSurrogate(text.charCodeAt(low)) &&
    isHighSurrogate(text.charCodeAt(low - 1))
  );
}

/**
 * 越过代理对的**最小修正**：起点内收 / 终点外扩都朝对之后挪一格（见文件头）。
 * 挪后仍是合法边界：对中间意味着 `column <= 行长度`，`column + 1 <= 行长 + 1 = maxColumn`。
 */
function leaveSurrogatePair(text: string, column: number): number {
  return splitsSurrogatePair(text, column) ? column + 1 : column;
}

/** 可用的列：有限数；其余（缺省 / NaN / Infinity）一律当"没给列" */
function usableColumn(column: number | undefined): number | undefined {
  return typeof column === 'number' && Number.isFinite(column) ? Math.trunc(column) : undefined;
}

/**
 * 一个位置事实（`column` 与 / 或 `span`）→ **权威 span**。
 *
 * 判据（全仓唯一，发起方不许各自再算一遍）：
 * 1. `span` 两端口都可用且 `columnEnd >= columnStart` ⇒ 原样用（截断到整数码元）；
 * 2. 否则 `column` 可用 ⇒ 退化成**零宽** `{ columnStart: column, columnEnd: column }`；
 * 3. 都不给 ⇒ `undefined`（连起点都不知道，由落点侧按行首处理）。
 *
 * 坏 `span`（NaN / Infinity / 终点在起点之前 / 只有端点）不当"半个区间"用：
 * 整个丢掉，退回第 2 档，也不报错——发起方给歪了就按没给处理，落点仍然合法。
 */
export function revealSpanOf(fact: { readonly column?: number; readonly span?: RevealSpan }): RevealSpan | undefined {
  const start = usableColumn(fact.span?.columnStart);
  const end = usableColumn(fact.span?.columnEnd);
  if (start !== undefined && end !== undefined && end >= start) return { columnStart: start, columnEnd: end };
  const column = usableColumn(fact.column);
  return column === undefined ? undefined : { columnStart: column, columnEnd: column };
}

/**
 * `editor.revealLocation` 载荷 → 编辑器定位目标。
 *
 * `line` 缺省按第 1 行（接线前逐字一致）；区间只在给得出手时才带上，
 * 非法值（NaN / Infinity）当没给，而不是夹到某端假装作者要那儿。
 * `column` 与 `span` 同时在场时**两者都留**（值必然一致：span 由 `revealSpanOf` 折过），
 * 老消费方读 `column`、新消费方读 `span`，两条读法同一个落点。
 */
export function revealTargetOf(
  event: { readonly line?: number; readonly column?: number; readonly span?: RevealSpan },
  nonce: number,
): RevealTarget {
  const line = usableColumn(event.line) ?? 1;
  const span = revealSpanOf(event);
  const column = usableColumn(event.column) ?? span?.columnStart;
  return {
    line,
    ...(column !== undefined ? { column } : {}),
    ...(span !== undefined ? { span } : {}),
    nonce,
  };
}

/**
 * 越界值夹到模型里真实存在的落点（**全仓唯一的落点判据**）。
 *
 * 行夹取沿用改动前的表达式（不许顺手改判据）；列两头夹：下限 1，上限取
 * `geometry.maxColumn(已夹取的行)`——**先夹行再取行长**，否则行越界时行长根本不存在。
 * 区间终点同样两头夹：下限 = 已夹取的起点（终点绝不越过起点，反向了就收成一个点），
 * 上限 = 该行最后一个合法列；没给区间就退化成零宽（口径见文件头）。
 * 最后一步是**代理对边界修正**（口径见文件头）：只在 `geometry.lineText` 给了行文本时做，
 * 起点 / 终点各自离开"对中间"（向对之后挪一格）；行文本缺席则原样返回上面的纯码元夹取。
 */
export function clampRevealPosition(
  target: { readonly line: number; readonly column?: number; readonly span?: RevealSpan },
  geometry: RevealGeometry,
): RevealPosition {
  const lineNumber = Math.min(Math.max(1, target.line), geometry.lineCount);
  const maxColumn = geometry.maxColumn(lineNumber);
  const span = revealSpanOf(target);
  const column = Math.min(Math.max(1, span?.columnStart ?? 1), maxColumn);
  const columnEnd = Math.min(Math.max(column, span?.columnEnd ?? column), maxColumn);
  const lineText = geometry.lineText?.(lineNumber);
  if (typeof lineText !== 'string') return { lineNumber, column, columnEnd };
  const safeColumn = leaveSurrogatePair(lineText, column);
  const safeColumnEnd = Math.max(safeColumn, leaveSurrogatePair(lineText, columnEnd));
  return { lineNumber, column: safeColumn, columnEnd: safeColumnEnd };
}

/**
 * 发起方 → `editor.revealLocation` 载荷的**唯一构造点**（W9 判据①的另一半：
 * 与其约定"六条腿各自记得带列"，不如只留一个出口）。
 *
 * 面板 / 宿主拿到的是"位置事实"（路径 + 行 + 能给就得给的区间），
 * 载荷形状、缺省键的取舍（不给就别留 `column: undefined` 让下游误判"有列但未知"）
 * 全在这里；消费方（App → 编辑器）读到的是同一对 `column` / `span`，
 * 再由 `clampRevealPosition` 折成屏幕上的落点——**一条链上只有这两处判据**。
 */
export function revealLocationOf(
  fact: { readonly path: string; readonly line: number; readonly column?: number; readonly span?: RevealSpan },
  source?: string,
): RevealLocationPayload {
  const span = revealSpanOf(fact);
  const column = usableColumn(fact.column) ?? span?.columnStart;
  return {
    filePath: fact.path,
    line: fact.line,
    ...(column !== undefined ? { column } : {}),
    ...(span !== undefined ? { span } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

/* ============================== 接线现状（六条腿的落点，判据都指回本文件） ==============================
 * 发起方 → `revealLocationOf` → `editor.revealLocation` → `revealTargetOf` → `clampRevealPosition`
 * 一条链，全仓只有这两个判据点：
 *  - `ui/App.tsx` `bus.on` / `commitOpenFile` / `requestOpenFile` 带 `span` 转交编辑器；
 *  - `ui/EditorPane.tsx` `applyReveal` 用 `clampRevealPosition` 的 `columnEnd` 铺选区（零宽天然等价旧 setPosition），
 *    `setProblems` 把波浪线的列区间带进 `problem-store`，定义 / 实现 / 引用三条腿的 `navigate` 都走 `revealLocationOf`；
 *  - `ui/ProjectView.tsx` 问题面板与检索面板的 `onReveal` 同样只经 `revealLocationOf`；
 *  - `monaco/find-references.ts` 的 Peek 腿与 `ui/jump-to-state.ts` 的 G1 腿交同一个夹取函数。
 * 守卫在 `tests/reveal-span.test.ts`（六条腿同三元组对拍）与 `tests/jump-to-state.test.ts`
 * （判据不复制：会算列的只有本文件）。新增发起方**不许**在这里之外拼载荷。
 * 代理对边界修正的**行文本**由各腿的 `RevealGeometry.lineText` 可选喂入；没喂的腿保持
 * 改动前的纯码元夹取（逐字一致）。边界判据只许住在本文件，调用方不许另写一份。
 * ================================================================= */
