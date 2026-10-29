/**
 * Kojo 2.0 **选择范围**（K2-LSP-HILITE-SELECT 的扩选半边）。
 *
 * ## 层级（从内到外，写死）
 *
 * `词 → 行 → 块（声明体 / `?` 分支体 / `@原生` 整块 / `# 机` 体）→ # 幕 → 全文`
 *
 * 每一级都是**真区间**，不按缩进猜：
 * - **词**：光标处的连续名字段（{@link isNameChar} 字符集；行末光标取左侧词）；
 * - **行**：整行（含缩进，行尾列 = 行长 + 1；表行**整行**算一级，不切单元格）；
 * - **块**（可多级，逐个嵌套）：
 *   - **声明体**：`kojo2DocumentSymbols` 的 AST 真 span（`# 对照表` 到末行表体、`# 池` 到
 *     末条分支正文、`# 模` / `@函` / `@织` 到块体末行）；单行声明 = 行级，不重复出一级；
 *   - **`?` 分支体**：`? 条件` 头行 + 它深一级的正文（到第一个不更深的行为止）——
 *     同一链的**下一条分支不并进来**（"`?` 链按分支"）；
 *   - **`@原生` 整块**：`@原生` 头行 + 围栏内全部原文行，**只给一级**（原文不再细分）；
 *   - **`# 机` 体**：没有 `# 幕` 的文件里，"整个 `# 机` 文件就是一个场景"（规范 §3.7），
 *     所以机声明行到最后一个非空行为一级；有 `# 幕` 时这一级由幕覆盖，不重复出；
 * - **`# 幕`**：`# 幕` 的 AST span（头行到本幕最后一个叙事节点）——幕之后的文件级声明
 *   （`@织` / `@函` / `# 对照表`）不属于这一幕，因此不越块；
 * - **全文**：`1:1` 到末行末列。
 *
 * 边界口径：块级区间的**起列取行首 1、终列取行尾**（整行），这样父区间恒完整包住子区间
 * （Monaco 的扩选链要求逐级包含）；表体、分支体、原生体都不做"半行"切割。
 *
 * ## 失败面
 *
 * - {@link kojo2SelectionRangeAt} 是**纯函数**：源码 + 1 基位点数组进，
 *   `{ range, parent? }` 链数组出（最内层是返回的那一枚，`parent` 逐级向外）；
 *   注意 Monaco 0.57 的 provider 接口已改成"每位点一个扁平 `SelectionRange[]`"，
 *   因此安装层会把本链**摊平**成 0.57 形状——纯函数的形状保持经典 LSP / Monaco
 *   `SelectionRange` 契约（也是 `K2-LSP-HILITE-SELECT` 约定），换 Monaco 版本时只动安装层；
 * - **空文件 / 纯空白 / 越界位点（行或列不在源文里）/ 非法坐标** ⇒ 显式空：整次调用回
 *   `[]`，或该位点不产链（**不夹取、不猜**：夹到边界会把扩选落到别的块上）；
 * - provider 内任何异常一律回 `[]`（Monaco 把 throw 吞成"扩选突然没了"）；
 * - {@link installKojo2SelectionRangeProvider} 只挂 `kojo2`；**无条件注册**（结构化扩选是
 *   只读呈现面，阶段 `v1-only` 下也照常可见）；dispose 幂等，注册失败原样外抛（宿主那侧全有或全无）。
 */

import { KOJO_DISPATCH_WORDS, lex, type KojoLexLine } from '@kojo/kojo-core';
import type * as Monaco from './entry';
import { isNameChar } from './kojo-completion-position';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import {
  kojo2DocumentSymbols,
  type Kojo2SymbolPosition,
  type Kojo2SymbolRange,
} from '@kojo/kojo-lang';

/* ============================== 词形（core 单源） ============================== */

/** `@原生` 的调度词（core 词表最后一枚；本文件不写中文字形） */
const NATIVE_WORD = KOJO_DISPATCH_WORDS[15];

/* ============================== 公共形状 ============================== */

/** 1 基区间 → `Monaco.IRange`（字段名换一遍，数值不动） */
function toMonacoRange(range: Kojo2SymbolRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

/** 一条扩选链（最内层在前；内部只存 1 基区间，出口才翻 Monaco 形状） */
type Chain = Kojo2SymbolRange[];

/**
 * 扩选链的**对外形状**：`{ range, parent? }`（最内层在 `parent` 链尾）。
 *
 * 这是经典 Monaco / LSP 的 `SelectionRange` 形状（`K2-LSP-HILITE-SELECT` 的约定）；
 * 0.57 的 provider 接口已改成"每位点一个扁平 `SelectionRange[]`"，因此
 * {@link installKojo2SelectionRangeProvider} 出口处把本形状**摊平**成 0.57 的数组。
 */
export interface Kojo2SelectionRange {
  readonly range: Monaco.IRange;
  readonly parent?: Kojo2SelectionRange;
}

/* ============================== 源文行表 ============================== */

/** 源文按行切（CRLF / CR / LF 都认；末尾换行留下一个空行，与 Monaco model 同口径） */
function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

/** 行尾列（1 基、半开）：行长 + 1；越界行回 1 */
function lineEndColumn(lines: readonly string[], line: number): number {
  return (lines[line - 1]?.length ?? 0) + 1;
}

/** 整行区间（起列 1、终列行尾；`endLine < startLine` 时收敛到起行） */
function fullLineRange(lines: readonly string[], startLine: number, endLine: number): Kojo2SymbolRange {
  const last = Math.max(startLine, endLine);
  return {
    startLine,
    startColumn: 1,
    endLine: last,
    endColumn: lineEndColumn(lines, last),
  };
}

/** 最后一行非空行号（全空 ⇒ 1） */
function lastNonBlankLine(lines: readonly string[]): number {
  for (let line = lines.length; line >= 1; line--) {
    if ((lines[line - 1] ?? '').trim().length > 0) return line;
  }
  return 1;
}

/* ============================== 区间关系 ============================== */

function comparePoints(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
  return aLine - bLine || aColumn - bColumn;
}

/** `outer` 是否完整包住 `inner`（相等也算包住——调用方另行去重相等区间） */
function rangeContainsRange(outer: Kojo2SymbolRange, inner: Kojo2SymbolRange): boolean {
  return (
    comparePoints(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) <= 0 &&
    comparePoints(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn) >= 0
  );
}

/** 位点是否落在区间里（尾列可停靠：Monaco 行末列恰是 `endColumn`） */
function rangeContainsPosition(
  range: Kojo2SymbolRange,
  position: Kojo2SymbolPosition,
): boolean {
  if (position.line < range.startLine || position.line > range.endLine) return false;
  if (position.line === range.startLine && position.column < range.startColumn) return false;
  if (position.line === range.endLine && position.column > range.endColumn) return false;
  return true;
}

function equalRange(a: Kojo2SymbolRange, b: Kojo2SymbolRange): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

/* ============================== 结构块 ============================== */

interface BlockIndex {
  readonly lines: readonly string[];
  readonly blocks: readonly Kojo2SymbolRange[];
  readonly scenes: readonly Kojo2SymbolRange[];
  readonly file: Kojo2SymbolRange;
}

/** 条件行（`? …`）的分支体末行：到第一个不更深（或同缩进的下一分支）为止，跳过末尾空行 */
function branchEndLine(lexed: ReturnType<typeof lex>, index: number): number {
  const header = lexed.lines[index]!;
  let end = header.number;
  for (let i = index + 1; i < lexed.lines.length; i++) {
    const line = lexed.lines[i]!;
    if (line.kind === 'blank') continue;
    if (line.indent <= header.indent) break;
    end = line.number;
  }
  return end;
}

/**
 * 原生围栏块：头行 + 围栏内的原文行（一个围栏只给一级）。
 *
 * 尾部的纯空白原生行**不计入块尾**：词法层把围栏关闭前的空行也标成 `native`，但把块尾
 * 落在空行上会让外层的 `@函` / `@织` / 幕块（AST 的 span 以最后一个非空行收尾）包不住它，
 * 扩选链就会跳过外层块。空行本身仍由外层块的行区间覆盖。
 */
function nativeFences(lexed: ReturnType<typeof lex>, lines: readonly string[]): Kojo2SymbolRange[] {
  const out: Kojo2SymbolRange[] = [];
  for (let i = 0; i < lexed.lines.length; i++) {
    const line = lexed.lines[i]!;
    if (line.kind !== 'dispatch' || !line.known || line.word !== NATIVE_WORD) continue;
    let end = line.number;
    let j = i + 1;
    while (j < lexed.lines.length && lexed.lines[j]!.kind === 'native') {
      const child = lexed.lines[j]!;
      if (child.kind === 'native' && !child.blank) end = child.number;
      j++;
    }
    out.push(fullLineRange(lines, line.number, end));
    i = j - 1;
  }
  return out;
}

/** 分支体块：每条 `?` 条件行各一块（头行到它深一级的正文末行） */
function branchBlocks(lexed: ReturnType<typeof lex>, lines: readonly string[]): Kojo2SymbolRange[] {
  const out: Kojo2SymbolRange[] = [];
  for (let i = 0; i < lexed.lines.length; i++) {
    if (lexed.lines[i]!.kind !== 'condition') continue;
    const end = branchEndLine(lexed, i);
    if (end <= lexed.lines[i]!.number) continue;
    out.push(fullLineRange(lines, lexed.lines[i]!.number, end));
  }
  return out;
}

/**
 * 建立结构块索引（一次 lex + 一次 symbols 解析；不在每次查询里重扫）。
 *
 * `# 机` 体的判据：文件里**没有任何幕**时，机声明行到最后一个非空行（规范 §3.7
 * "没有 `# 幕` 时，整个 `# 机` 文件就是一个场景"）。有幕时这一级由幕覆盖。
 */
function blockIndexOf(source: string): BlockIndex {
  const lines = splitLines(source);
  const lexed = lex(source);
  const facts = kojo2DocumentSymbols(source);
  const blocks: Kojo2SymbolRange[] = [];

  for (const range of nativeFences(lexed, lines)) blocks.push(range);
  for (const range of branchBlocks(lexed, lines)) blocks.push(range);

  let hasScene = false;
  let machineLine = 0;
  for (const fact of facts) {
    if (fact.kind === 'scene') {
      hasScene = true;
      continue;
    }
    if (fact.kind === 'machine') machineLine = fact.range.startLine;
    if (fact.range.startLine !== fact.range.endLine) {
      blocks.push(fullLineRange(lines, fact.range.startLine, fact.range.endLine));
    }
  }
  if (!hasScene && machineLine > 0) {
    const end = lastNonBlankLine(lines);
    if (end > machineLine) blocks.push(fullLineRange(lines, machineLine, end));
  }

  const scenes: Kojo2SymbolRange[] = [];
  for (const fact of facts) {
    if (fact.kind !== 'scene') continue;
    scenes.push(fullLineRange(lines, fact.range.startLine, fact.range.endLine));
  }

  return {
    lines,
    blocks,
    scenes,
    file: fullLineRange(lines, 1, lines.length),
  };
}

/* ============================== 扩选链 ============================== */

/** 光标处的连续名字段（行内；左右都非名字字符 ⇒ `null`） */
function wordRangeAt(lines: readonly string[], position: Kojo2SymbolPosition): Kojo2SymbolRange | null {
  const text = lines[position.line - 1] ?? '';
  const col0 = Math.min(position.column - 1, text.length);
  let start: number;
  let end: number;
  if (col0 < text.length && isNameChar(text[col0]!)) {
    start = col0;
    end = col0 + 1;
  } else if (col0 > 0 && isNameChar(text[col0 - 1]!)) {
    start = col0 - 1;
    end = col0;
  } else {
    return null;
  }
  while (start > 0 && isNameChar(text[start - 1]!)) start--;
  while (end < text.length && isNameChar(text[end]!)) end++;
  return {
    startLine: position.line,
    startColumn: start + 1,
    endLine: position.line,
    endColumn: end + 1,
  };
}

/** 最内层优先：起点靠后在前，同起点区间更短在前 */
function compareInnermost(a: Kojo2SymbolRange, b: Kojo2SymbolRange): number {
  return (
    b.startLine - a.startLine ||
    b.startColumn - a.startColumn ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

/**
 * 一个位点的扩选链（最内层在前）。
 *
 * 只加**完整包住上一级**的候选：树里任何一条重叠但不嵌套的区间（坏输入 / 越界解释）
 * 都进不来，扩选永不把光标之外的东西"吃掉一半"。
 */
function chainAt(index: BlockIndex, position: Kojo2SymbolPosition): Chain {
  const chain: Chain = [];
  const push = (range: Kojo2SymbolRange): void => {
    const last = chain[chain.length - 1];
    if (last !== undefined && (equalRange(last, range) || !rangeContainsRange(range, last))) return;
    chain.push(range);
  };
  const last = (): Kojo2SymbolRange | undefined => chain[chain.length - 1];

  const word = wordRangeAt(index.lines, position);
  if (word !== null) push(word);
  push({
    startLine: position.line,
    startColumn: 1,
    endLine: position.line,
    endColumn: lineEndColumn(index.lines, position.line),
  });

  const candidates = index.blocks
    .filter((block) => rangeContainsPosition(block, position))
    .sort(compareInnermost);
  for (const block of candidates) push(block);

  const scene = index.scenes
    .filter((range) => rangeContainsPosition(range, position))
    .sort(compareInnermost)[0];
  if (scene !== undefined) push(scene);

  if (last() === undefined) return chain;
  push(index.file);
  return chain;
}

/* ============================== 纯逻辑入口 ============================== */

/** 链 → 对外形状（最内层在前；`parent` 指向更大的下一级） */
function chainToSelectionRange(chain: Chain): Kojo2SelectionRange {
  let node: Kojo2SelectionRange | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const range = toMonacoRange(chain[i]!);
    node = node === undefined ? { range } : { range, parent: node };
  }
  // chain 非空由调用方保证；这里只是让类型收窄（TS 看不出循环至少跑一轮）。
  return node ?? { range: toMonacoRange(chain[0]!) };
}

/** 位点是否可查（行/列都落在源文里；行尾列 = 行长 + 1 可停靠） */
function isUsablePoint(index: BlockIndex, position: Kojo2SymbolPosition): boolean {
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

/**
 * 位点数组 → 与输入**同长**的链（`undefined` = 该位点显式空）。
 *
 * provider 出口要按位点对齐（Monaco 只在"每位点一条"时才采纳），所以对齐逻辑在这里，
 * 公共纯函数只把 `undefined` 滤掉。
 */
function alignedChains(
  source: string,
  positions: readonly Kojo2SymbolPosition[],
): Array<Kojo2SelectionRange | undefined> {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return positions.map(() => undefined);
  }
  let index: BlockIndex;
  try {
    index = blockIndexOf(source);
  } catch {
    return positions.map(() => undefined);
  }
  return positions.map((position) => {
    if (!isUsablePoint(index, position)) return undefined;
    const chain = chainAt(index, position);
    return chain.length === 0 ? undefined : chainToSelectionRange(chain);
  });
}

/**
 * 扩选链（**纯函数**）：源码 + 1 基位点数组 → `{ range, parent? }` 链数组。
 *
 * 输出与 `positions` **同序**，但**越界 / 非法位点不产链**（显式空：该位点整条不出现，
 * 不夹取、不猜）；空文件 / 纯空白 / 空位点数组 ⇒ `[]`。
 */
export function kojo2SelectionRangeAt(
  source: string,
  positions: readonly Kojo2SymbolPosition[],
): Kojo2SelectionRange[] {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  const out: Kojo2SelectionRange[] = [];
  for (const chain of alignedChains(source, positions)) {
    if (chain !== undefined) out.push(chain);
  }
  return out;
}

/** 对外链 → 0.57 provider 的扁平数组（内 → 外；运行时自己会按包含关系再排一遍） */
function flattenChain(chain: Kojo2SelectionRange): Monaco.languages.SelectionRange[] {
  const out: Monaco.languages.SelectionRange[] = [];
  let cursor: Kojo2SelectionRange | undefined = chain;
  while (cursor !== undefined) {
    out.push({ range: cursor.range });
    cursor = cursor.parent;
  }
  return out;
}

/* ============================== 安装 ============================== */

/**
 * 为 `kojo2` 语言注册选择范围 provider，返回**幂等**的 disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT：结构化扩选是只读呈现面，不读切流开关）；
 * - 只挂 `KOJO2_LANGUAGE_ID`；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚）。
 */
export function installKojo2SelectionRangeProvider(
  monaco: typeof Monaco,
): Monaco.IDisposable {

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

  const registration = monaco.languages.registerSelectionRangeProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );

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
