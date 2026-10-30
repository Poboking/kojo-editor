import {
  erbStructureOf,
  erbWordAt,
  type ErbControlLine,
  type ErbPosition,
  type ErbRange,
  type ErbStructure,
} from './highlight';

/**
 * ERB **选择范围（扩选）**的判据（`@kojo/erb-lang/selection-range`，LAU-4 第一步）。
 *
 * ## 层级（从内到外，写死）
 *
 * `词 → 行 → 分支段 → ERB 标签块（可多级）→ 函数块（@NAME）→ 全文`
 *
 * - **词**：光标处的连续名字段（Unicode 字母 / 数字 / 下划线；行末光标取左侧词）；
 * - **行**：整行（含缩进；行尾列 = 行长 + 1）；
 * - **分支段**：光标落在某一分支词（`ELSE` / `ELSEIF` / `CASE` / `CASEELSE` / `CATCH`）
 *   之后、收束之前时，该分支头行到**下一条分支前一行**——兄弟分支不并进来；
 * - **ERB 标签块**（可多级，逐个嵌套）：控制流关键字块 `IF…ENDIF` / `SELECTCASE…ENDSELECT`
 *   / `REPEAT…REND` 等，配对判据与高亮**同一份**（`./highlight` 的 `erbStructureOf`
 *   的角色栈：开块入栈、收束出栈，行首词表由 `@kojo/plugin-erb-parser` 的配对表现派生）。
 *   **只有配对成功的块才产出区间**：未闭合 / 孤儿收束不产（那是不可证明的边界，猜了就是把
 *   扩选落到别的块上）；块区间起列恒为 1、终列为收束行行尾（整行），父区间恒完整包住子区间；
 * - **函数块**：`@NAME` 定义行到**下一个函数头前一行**（文件末尾则到末行）；
 * - **全文**：`1:1` 到末行末列。
 *
 * ## 死区（`[SKIPSTART] … [SKIPEND]`）
 *
 * **不扩**：位点落在停用区里（含两枚标记行本身）时，只给 词 → 行 → 全文
 * ——引擎不编译那些行，块 / 函数边界在那里没有判据（与高亮"死区不误报"同一条边界）。
 *
 * ## 两个出口（LAU-4：与 `@kojo/kojo-lang/selection-range` 同形）
 *
 * - {@link erbSelectionRangeChainsAt}：**对齐版**——与 `positions` 同序同长，越界 / 空文件 /
 *   非法坐标 ⇒ 该位点 `null`（不夹取、不猜）。供方（插件）走这一版：契约要求
 *   `selections` 与请求的 `positions` 一一对应，少一格就是宿主侧错位；
 * - {@link erbSelectionRangeAt}：**过滤版**（旧语义，一条未变）——越界位点整条滤掉。
 *
 * 链的形状是经典 LSP `{ range, parent? }`（最内层是返回的那一枚，`parent` 逐级向外）。
 * Monaco 0.57 的"每位点一条扁平 `SelectionRange[]`"摊平**只在宿主安装层**做；
 * 本包零 Monaco（换 Monaco 版本只动宿主）。
 *
 * 结构事实与高亮**共用** `erbStructureOf` 那一份（同一批交付；两处各扫一遍必然漂移）。
 * 本包零 `@kojo/plugin-*` import 之外的依赖，零 IO / 零游戏知识。
 */

/* ============================== 公共形状 ============================== */

/**
 * 扩选链的**对外形状**：`{ range, parent? }`（最内层在前，`parent` 指向更大的下一级）。
 * 经典 Monaco / LSP 的 `SelectionRange` 契约；0.57 的 provider 数组由宿主安装层摊平。
 */
export interface ErbSelectionChain {
  readonly range: ErbRange;
  readonly parent?: ErbSelectionChain;
}

/* ============================== 行表与区间 ============================== */

/** 行尾列（1 基半开）：行长 + 1；越界行回 1 */
function lineEndColumn(lines: readonly string[], line: number): number {
  return (lines[line - 1]?.length ?? 0) + 1;
}

/** 整行区间（起列 1、终列行尾；`endLine < startLine` 时收敛到起行） */
function fullLineRange(lines: readonly string[], startLine: number, endLine: number): ErbRange {
  const last = Math.max(startLine, endLine);
  return { startLine, startColumn: 1, endLine: last, endColumn: lineEndColumn(lines, last) };
}

function comparePoints(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
  return aLine - bLine || aColumn - bColumn;
}

/** `outer` 是否完整包住 `inner`（相等也算包住——调用方另行去重相等区间） */
function rangeContainsRange(outer: ErbRange, inner: ErbRange): boolean {
  return (
    comparePoints(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) <= 0 &&
    comparePoints(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn) >= 0
  );
}

function equalRange(a: ErbRange, b: ErbRange): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

/* ============================== 结构索引 ============================== */

interface SelectionIndex {
  readonly structure: ErbStructure;
  readonly lines: readonly string[];
  readonly file: ErbRange;
}

/** 建立扩选索引（一次结构扫描；每次请求只建一次，位点数组共用） */
function selectionIndexOf(source: string): SelectionIndex {
  const structure = erbStructureOf(source);
  const lines = structure.lines.map((row) => row.raw);
  return { structure, lines, file: fullLineRange(lines, 1, lines.length) };
}

/** 位点是否可查（行 / 列都落在源文里；行尾列 = 行长 + 1 可停靠） */
function isUsablePoint(index: SelectionIndex, position: ErbPosition): boolean {
  if (position === null || position === undefined) return false;
  if (
    !Number.isFinite(position.line) ||
    !Number.isFinite(position.column) ||
    position.line < 1 ||
    position.column < 1 ||
    position.line > index.lines.length
  ) {
    return false;
  }
  const lineLength = index.lines[position.line - 1]?.length ?? 0;
  return position.column <= lineLength + 1;
}

/** 位点之前（含同位点）最近的一条分支词 */
function branchAtOrBefore(branches: readonly ErbControlLine[], line: number): ErbControlLine | undefined {
  let found: ErbControlLine | undefined;
  for (const branch of branches) {
    if (branch.line <= line) found = branch;
  }
  return found;
}

/** 该行所在的函数块（`@NAME` 行到下一个函数头前一行 / 文件末行） */
function functionRangeAt(index: SelectionIndex, line: number): ErbRange | null {
  const functions = index.structure.functions;
  for (let i = 0; i < functions.length; i++) {
    const start = functions[i]!.line;
    const end = i + 1 < functions.length ? functions[i + 1]!.line - 1 : index.lines.length;
    if (line >= start && line <= end) return fullLineRange(index.lines, start, end);
  }
  return null;
}

/* ============================== 扩选链 ============================== */

/**
 * 一个位点的扩选链（最内层在前）。
 *
 * 只加**完整包住上一级**的候选：任何重叠但不嵌套的区间（错配文件 / 越界解释）都进不来，
 * 扩选永不把光标之外的东西"吃掉一半"。
 */
function chainAt(index: SelectionIndex, position: ErbPosition): ErbRange[] {
  const lines = index.lines;
  const chain: ErbRange[] = [];
  const push = (range: ErbRange): void => {
    const last = chain[chain.length - 1];
    if (last !== undefined && (equalRange(last, range) || !rangeContainsRange(range, last))) return;
    chain.push(range);
  };

  const row = index.structure.lines[position.line - 1]!;
  const col0 = Math.min(position.column - 1, row.raw.length);
  const word = erbWordAt(row.raw, col0);
  if (word !== null) {
    push({
      startLine: row.line,
      startColumn: word.start + 1,
      endLine: row.line,
      endColumn: word.end + 1,
    });
  }
  push(fullLineRange(lines, row.line, row.line));

  // 死区不扩：块 / 分支 / 函数边界在这些行上没有判据（引擎不编译它们）
  if (row.kind !== 'dead' && row.kind !== 'marker') {
    const enclosing = index.structure.blocks
      .filter((block) => block.close !== null && block.open.line <= row.line && block.close.line >= row.line)
      .sort((a, b) => b.open.line - a.open.line || (a.close!.line - b.close!.line));

    const inner = enclosing[0];
    if (inner !== undefined && inner.close !== null) {
      const branch = branchAtOrBefore(inner.branches, row.line);
      if (branch !== undefined) {
        const next = inner.branches.find((candidate) => candidate.line > branch.line);
        const segmentEnd = next !== undefined ? next.line - 1 : inner.close.line - 1;
        if (segmentEnd >= row.line) push(fullLineRange(lines, branch.line, segmentEnd));
      }
    }
    for (const block of enclosing) {
      if (block.close === null) continue;
      push(fullLineRange(lines, block.open.line, block.close.line));
    }
    const functionRange = functionRangeAt(index, row.line);
    if (functionRange !== null) push(functionRange);
  }

  push(index.file);
  return chain;
}

/** 链 → 对外形状（最内层在前；`parent` 指向更大的下一级） */
function chainToNodes(chain: readonly ErbRange[]): ErbSelectionChain {
  let node: ErbSelectionChain | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const range = chain[i]!;
    node = node === undefined ? { range } : { range, parent: node };
  }
  // chain 非空由调用方保证；这里只是让类型收窄（TS 看不出循环至少跑一轮）。
  return node ?? { range: chain[0]! };
}

/**
 * 位点数组 → 与输入**同长**的链（`null` = 该位点显式空）。
 * 供方出口要按位点对齐（契约要求 `selections` 与 `positions` 同序同长）。
 */
export function erbSelectionRangeChainsAt(
  source: string,
  positions: readonly ErbPosition[],
): Array<ErbSelectionChain | null> {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  if (typeof source !== 'string' || source.trim().length === 0) {
    return positions.map(() => null);
  }
  let index: SelectionIndex;
  try {
    index = selectionIndexOf(source);
  } catch {
    return positions.map(() => null);
  }
  return positions.map((position) => {
    if (!isUsablePoint(index, position)) return null;
    const chain = chainAt(index, position);
    return chain.length === 0 ? null : chainToNodes(chain);
  });
}

/**
 * 扩选链（**纯函数**，过滤版＝旧语义）：源码 + 1 基位点数组 → `{ range, parent? }` 链数组。
 *
 * 输出与 `positions` **同序**，但**越界 / 非法位点不产链**（显式空：该位点整条不出现，
 * 不夹取、不猜）；空文件 / 纯空白 / 空位点数组 ⇒ `[]`。
 */
export function erbSelectionRangeAt(
  source: string,
  positions: readonly ErbPosition[],
): ErbSelectionChain[] {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  const out: ErbSelectionChain[] = [];
  for (const chain of erbSelectionRangeChainsAt(source, positions)) {
    if (chain !== null) out.push(chain);
  }
  return out;
}
