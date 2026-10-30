/**
 * Kojo 2.0 **折叠区间的判据**（B3h，2026-10-30）：结构引擎交回的 `folds` 行对 → 编辑器要的
 * 可折区间。纯函数、零 Monaco、零 IO。
 *
 * ## 为什么这一格必须住在包里
 *
 * 折叠的事实来自结构 worker（`queries/v2/folds.scm` 的 `(block) @fold`，**0 基行**），
 * 而 worker 是异步的；槽 `ui.editor.languageService` 是**同步**的。B3h 的解法是"宿主预取 +
 * 供方作答"：宿主把 worker 快照塞进请求的 additive 字段（`folds`），供方在这里把行对翻成
 * 契约区间（`EditorFoldingRange`，**1 基**闭区间，与 `documentSymbol` / `foldingRange` 同一条
 * 模型坐标口径）。判据留宿主就会长出第二份——供方是插件，插件看不见宿主。
 *
 * ## 四道过滤（每道都是"陈旧的回复不许画到当下的文本上"）
 *
 * - 非有限数 / 非整数 ⇒ 丢（worker 不该发，但供方是最后一道闸）；
 * - `startRow < 0` 或 `endRow >= 行数` ⇒ 丢（**越界不夹取**：回复可能对应上一版文本，
 *   夹到边界会折错行；不折比折错好）；
 * - `endRow <= startRow` ⇒ 丢（没有可隐藏的行，留着只会让 gutter 出一个折不动的假箭头）；
 * - 重复区间 ⇒ 只留第一枚（worker 已去重；这里是防直接调用方）。
 *
 * 排序与宿主 / v1 折叠同口径：起点升序、同起点终点降序（外层块在前）。
 */

/** 结构引擎的一条折叠行对（**0 基**，`endRow > startRow` 才可折；与 worker 的 `folds` 同形） */
export interface Kojo2FoldingRow {
  readonly startRow: number;
  readonly endRow: number;
}

/** 契约区间（`EditorFoldingRange` 的结构同形；本包不引 `@kojo/plugin-api`，纯库自持形状） */
export interface Kojo2FoldingRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * 行对 → 可折区间的**唯一实现**（两种入口共用：worker 行对、已是契约形状的快照）。
 * `lineCount` 不是正整数 ⇒ 空结果（没有"行数事实"就不猜哪一条越界）。
 */
function normalize(rows: readonly Kojo2FoldingRow[] | null | undefined, lineCount: number): Kojo2FoldingRange[] {
  if (!Array.isArray(rows)) return [];
  const limit = Number.isFinite(lineCount) ? Math.trunc(lineCount) : 0;
  if (limit < 1) return [];
  const out: Kojo2FoldingRange[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const startRow = row.startRow;
    const endRow = row.endRow;
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) continue;
    if (!Number.isInteger(startRow) || !Number.isInteger(endRow)) continue;
    if (startRow < 0 || endRow >= limit) continue;
    if (endRow <= startRow) continue;
    const key = `${startRow}:${endRow}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ startLine: startRow + 1, endLine: endRow + 1 });
  }
  out.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  return out;
}

/**
 * worker 的 `folds`（**0 基行对**）→ 契约区间（**1 基**）。
 *
 * 宿主预取时调这一枚建快照（`packages/app/src/monaco/kojo2-folding.ts`）；
 * 快照到达供方之后还要再过一遍 {@link kojo2FoldingSnapshotRanges}——两道闸是同一份实现。
 */
export function kojo2FoldingRangesFromWorkerFolds(
  folds: readonly Kojo2FoldingRow[] | null | undefined,
  lineCount: number,
): Kojo2FoldingRange[] {
  return normalize(folds, lineCount);
}

/**
 * 已是契约形状的快照（1 基）→ 按**当下**行数再裁一遍（供方的最后一道闸）。
 *
 * 为什么要再裁：快照属于某一版文本（请求的 `version` 与它同版才该给），但"同版"是宿主的
 * 承诺，供方不拿承诺当事实——行数对不上的区间宁可丢，也不让 gutter 折错行。空 / 缺席 ⇒ 空。
 */
export function kojo2FoldingSnapshotRanges(
  snapshot: readonly Kojo2FoldingRange[] | null | undefined,
  lineCount: number,
): Kojo2FoldingRange[] {
  if (!Array.isArray(snapshot)) return [];
  const rows: Kojo2FoldingRow[] = [];
  for (const range of snapshot) {
    if (range === null || typeof range !== 'object') continue;
    rows.push({ startRow: range.startLine - 1, endRow: range.endLine - 1 });
  }
  return normalize(rows, lineCount);
}
