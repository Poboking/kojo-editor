import type * as Monaco from './entry';
import { ERB_LANGUAGE_ID } from './erb-language';
import {
  erbStructureOf,
  erbWordAt,
  type ErbControlLine,
  type ErbPosition,
  type ErbRange,
  type ErbStructure,
} from './erb-highlight';

/**
 * ERB **选择范围（扩选）**（ERB-HIGHLIGHT-SELECT 的扩选半边，batch-9）。
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
 *   / `REPEAT…REND` 等，配对判据与高亮**同一份**（`erb-highlight.ts::erbStructureOf`
 *   的角色栈：开块入栈、收束出栈，行首词表由 `erb-enter.ts` 从引擎配对表派生）。
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
 * ## 失败面
 *
 * - {@link erbSelectionRangeAt} 是**纯函数**：源码 + 1 基位点数组进，`{ range, parent? }`
 *   链数组出（最内层是返回的那一枚，`parent` 逐级向外）。Monaco 0.57 的 provider 接口是
 *   "每位点一条扁平 `SelectionRange[]`"，因此安装层把本链**摊平**成 0.57 形状——
 *   纯函数保持经典 LSP / Monaco `SelectionRange` 契约，换 Monaco 版本时只动安装层；
 * - **空文件 / 纯空白 / 越界位点（行或列不在源文里）/ 非法坐标** ⇒ 显式空：该位点不产链
 *   （**不夹取、不猜**：夹到边界会把扩选落到别的块上）；
 * - provider 内任何异常一律回 `[]`（Monaco 把 throw 吞成"扩选突然没了"）；
 * - {@link installErbSelectionRangeProvider} 只挂 `ERB_LANGUAGE_ID`，**不看偏好开关**
 *   （编辑器语言服务，与结构层那条实验开关无关）；dispose 幂等，注册失败原样外抛。
 *
 * 结构事实与高亮**共用** `erbStructureOf` 那一份（同一批交付；两处各扫一遍必然漂移）。
 * 本模块零 `@kojo/plugin-*` import（源码卫生闸 `erb-highlight-selection.test.ts` 钉住）。
 */

/* ============================== 公共形状 ============================== */

/**
 * 扩选链的**对外形状**：`{ range, parent? }`（最内层在前，`parent` 指向更大的下一级）。
 * 经典 Monaco / LSP 的 `SelectionRange` 契约；0.57 的 provider 数组由安装层摊平。
 */
export interface ErbSelectionRange {
  readonly range: Monaco.IRange;
  readonly parent?: ErbSelectionRange;
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
function chainToNodes(chain: readonly ErbRange[]): ErbSelectionRange {
  let node: ErbSelectionRange | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const range = toMonacoRange(chain[i]!);
    node = node === undefined ? { range } : { range, parent: node };
  }
  // chain 非空由调用方保证；这里只是让类型收窄（TS 看不出循环至少跑一轮）。
  return node ?? { range: toMonacoRange(chain[0]!) };
}

/**
 * 位点数组 → 与输入**同长**的链（`undefined` = 该位点显式空）。
 * provider 出口要按位点对齐（Monaco 只在"每位点一条"时才采纳）。
 */
function alignedChains(
  source: string,
  positions: readonly ErbPosition[],
): Array<ErbSelectionRange | undefined> {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return positions.map(() => undefined);
  }
  let index: SelectionIndex;
  try {
    index = selectionIndexOf(source);
  } catch {
    return positions.map(() => undefined);
  }
  return positions.map((position) => {
    if (!isUsablePoint(index, position)) return undefined;
    const chain = chainAt(index, position);
    return chain.length === 0 ? undefined : chainToNodes(chain);
  });
}

/**
 * 扩选链（**纯函数**）：源码 + 1 基位点数组 → `{ range, parent? }` 链数组。
 *
 * 输出与 `positions` **同序**，但**越界 / 非法位点不产链**（显式空：该位点整条不出现，
 * 不夹取、不猜）；空文件 / 纯空白 / 空位点数组 ⇒ `[]`。
 */
export function erbSelectionRangeAt(
  source: string,
  positions: readonly ErbPosition[],
): ErbSelectionRange[] {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  const out: ErbSelectionRange[] = [];
  for (const chain of alignedChains(source, positions)) {
    if (chain !== undefined) out.push(chain);
  }
  return out;
}

/* ============================== Monaco 翻译层 ============================== */

/** 1 基区间 → `Monaco.IRange`（字段名换一遍，数值不动） */
function toMonacoRange(range: ErbRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

/** 对外链 → 0.57 provider 的扁平数组（内 → 外；运行时自己会按包含关系再排一遍） */
function flattenChain(chain: ErbSelectionRange): Monaco.languages.SelectionRange[] {
  const out: Monaco.languages.SelectionRange[] = [];
  let cursor: ErbSelectionRange | undefined = chain;
  while (cursor !== undefined) {
    out.push({ range: cursor.range });
    cursor = cursor.parent;
  }
  return out;
}

/* ============================== 安装 ============================== */

/**
 * 为 `ERB_LANGUAGE_ID` 注册选择范围 provider，返回**幂等**的 disposable。
 *
 * - **不看任何偏好开关**（编辑器语言服务，与结构层那条实验开关无关）；
 * - 只挂 `ERB_LANGUAGE_ID`；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚）。
 */
export function installErbSelectionRangeProvider(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.SelectionRangeProvider = {
    provideSelectionRanges(model, positions) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return [];
        const source = model.getValue();
        if (typeof source !== 'string') return [];
        const wanted = Array.isArray(positions)
          ? positions.map((position) => ({ line: position.lineNumber, column: position.column }))
          : [];
        return alignedChains(source, wanted).map((chain) =>
          chain === undefined ? [] : flattenChain(chain),
        );
      } catch {
        return [];
      }
    },
  };

  const registration = monaco.languages.registerSelectionRangeProvider(ERB_LANGUAGE_ID, provider);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛 */
      }
    },
  };
}
