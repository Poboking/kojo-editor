/**
 * Kojo 2.0 **同符号高亮**（K2-LSP-HILITE-SELECT 的高亮半边）。
 *
 * ## 这一层回答的问题
 *
 * 光标落在哪个**同文件符号**上？这个符号在本文件的哪些地方出现？每处是
 * **声明（write）**、**引用（read）**，还是**叙事文本里的同名文字（text）**？
 *
 * ## 分层与失败面
 *
 * - {@link kojo2DocumentHighlights} 是**纯函数**：源码 + 1 基行列进，出现处出；
 *   零 IO、零 Monaco、零注册、零缓存（同输入必同输出）；
 * - {@link kojo2HighlightKindToMonaco} 是唯一把 `'text' | 'read' | 'write'` 翻成
 *   `DocumentHighlightKind` 的地方；
 * - {@link installKojo2HighlightProvider} 只挂 `kojo2` 语言 id；**flag 关 = 零注册**；
 *   provider 内任何异常（坏文件 / 取文抛错 / 模型已释放）一律回 `[]`——Monaco 把 provider
 *   的 throw 吞成"高亮突然没了"，作者看不到任何原因。
 *
 * ## 口径（与悬停 / 转定义同一套位置门）
 *
 * - **声明**：`kojo2DocumentSymbols` 的交出的名字段（`# 幕 / 视 / 机 / 变量 / 常量 / 表 /
 *   池 / 模`、`@函` / `@织`）就是 write；光标停在声明词（名字之前）也算在这条声明上
 *   （与悬停 `kojo2DeclarationHeaderAt` 同口径）；
 * - **引用**：只认代码面（声明行 `rest` / 调度行 `rest` / `!` 触发行 / `?` 条件行 /
 *   调度区裸行）与叙事行的 `{…}` 插值；**字符串字面量里的同名文字不算引用**
 *   （`# 常量 引号 字符串 = "心情"` 不把 `心情` 标成 read）；
 * - **`@原生` 围栏体 / 整行注释 / 旧写法行 / 表体数据行** 一律不参与：那不是引用，
 *   标出来只会让作者以为"这一段被谁用到了"；
 * - **`text` 命中**：叙事行正文（旁白 / 台词 / 裸引号 / 转义行，不含插值）里的同名
 *   **词**。它不是语义引用（不参与解析），因此单独给 `text` 档——Monaco 侧按
 *   `DocumentHighlightKind.Text` 呈现，编辑器可以自行决定是否弱化。词边界按
 *   `isNameChar` 切（中文正文连续成词时不会把"心情不错"误切成 `心情`），不误伤。
 * - 光标下**没有声明符号**（空白 / 标点 / 字符串里 / 原生体里 / 未声明的外部名）
 *   ⇒ `[]`：宁可不亮，也不猜"这个词大概是哪个符号"。
 *
 * ## 确定性
 *
 * 出现处按（起点行、起点列、档位）排序；同名跨文件不存在于本层（本层只看当前文件）——
 * 跨文件引用是 `K2-LSP-REFS` 的活，本文件**不读项目索引**，也不依赖尚未落地的
 * `kojo2-references.ts`（同批若落地，那是另一条腿，不是本文件的输入）。
 */

import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  lex,
  matchParenEnd,
  type KojoLexLine,
  type LexResult,
} from '@kojo/kojo-core';
import type * as Monaco from './entry';
import { insideInterpolation, isNameChar } from './kojo-completion-position';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import {
  kojo2IsCodeSurface,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
} from '@kojo/kojo-lang';
import {
  kojo2DocumentSymbols,
  type Kojo2SymbolFact,
  type Kojo2SymbolPosition,
  type Kojo2SymbolRange,
} from '@kojo/kojo-lang';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';

/* ============================== 词形（core 单源） ============================== */

/** `# 幕` / `# 视`：这两行的 `rest` 是标题 / 角色名，不是引用（不扫） */
const [SCENE_WORD, VIEW_WORD] = KOJO_DECL_WORDS;

/** `@原生` 的调度词（core 词表位序 `tokens.ts` §2.1 的最后一枚） */
const NATIVE_WORD = KOJO_DISPATCH_WORDS[15];

/* ============================== 公共形状 ============================== */

/**
 * 一个出现处的语义档位：
 * - `write` = 声明名（含光标停在声明词上的那一条）；
 * - `read` = 代码面 / 插值里的同符号引用；
 * - `text` = 叙事正文里的同名词（不参与解析，仅供编辑器弱化呈现）。
 */
export type Kojo2HighlightKind = 'text' | 'read' | 'write';

/** 一条出现处（1 基半开区间，与 `Kojo2SymbolRange` 同口径）。 */
export interface Kojo2DocumentHighlight {
  readonly range: Kojo2SymbolRange;
  readonly kind: Kojo2HighlightKind;
}

/** 光标处识别出的符号（只在本文件命名空间内）。 */
interface Kojo2HighlightSymbol {
  readonly name: string;
  /** 幕标题不是引用符号：只出 write，不参与 token 反查。 */
  readonly isScene: boolean;
}

/** 0 基半开区间（源文绝对偏移；只在本文件内部用）。 */
interface OffsetSpan {
  readonly start: number;
  readonly end: number;
}

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/** 档位排序（同一行同一起点只可能是同一处；此序只为确定性） */
const KIND_ORDER: Readonly<Record<Kojo2HighlightKind, number>> = Object.freeze({
  write: 0,
  read: 1,
  text: 2,
});

/* ============================== 小工具 ============================== */

function isUsablePosition(position: Kojo2SymbolPosition | null | undefined): boolean {
  if (position === null || position === undefined) return false;
  return (
    Number.isFinite(position.line) &&
    Number.isFinite(position.column) &&
    position.line >= 1 &&
    position.column >= 1
  );
}

/** 行原文（物理行；末尾空行越界 ⇒ 空串，不猜） */
function lineTextOf(lexed: LexResult, line: number): string {
  return lexed.physical[line - 1]?.text ?? '';
}

/** 0 基偏移 → 1 基区间（区间恒在 `line` 这一行内；不跨行） */
function rangeAt(line: KojoLexLine, startOffset: number, endOffset: number): Kojo2SymbolRange {
  const startColumn = startOffset - line.lineOffset + 1;
  return {
    startLine: line.number,
    startColumn,
    endLine: line.number,
    endColumn: startColumn + (endOffset - startOffset),
  };
}

/** 光标是否落在 `"…"` 字符串字面量里（引号配平；转义 `\"` 不计） */
function insideStringLiteral(text: string, col0: number): boolean {
  let inString = false;
  const stop = Math.min(col0, text.length);
  for (let i = 0; i < stop; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') inString = false;
  }
  return inString;
}

/** 两段偏移是否重叠（半开区间） */
function spansOverlap(span: OffsetSpan, start: number, end: number): boolean {
  return start < span.end && end > span.start;
}

/**
 * 在一段源文偏移里扫「名字词」：跳过 `"…"` 字符串字面量，按 {@link isNameChar}
 * 切出最大连续段。偏移一律是**源文绝对偏移**，调用方不再做行列换算。
 */
function scanNameTokens(
  source: string,
  from: number,
  to: number,
  visit: (start: number, end: number) => void,
): void {
  let i = from;
  while (i < to) {
    const code = source.charCodeAt(i);
    if (code === 34 /* " */) {
      i++;
      while (i < to) {
        const inner = source.charCodeAt(i);
        if (inner === 92 /* \ */) {
          i += 2;
          continue;
        }
        i++;
        if (inner === 34) break;
      }
      continue;
    }
    if (!isNameChar(source[i]!)) {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < to && isNameChar(source[i]!)) i++;
    visit(start, i);
  }
}

/* ============================== 符号识别 ============================== */

/** 声明名字段 → 源文绝对偏移（facts 的区间按行/列给，这里就地折回绝对偏移） */
function nameOffsetSpan(lexed: LexResult, fact: Kojo2SymbolFact): OffsetSpan | null {
  const line = lexed.lines[fact.selectionRange.startLine - 1];
  if (line === undefined) return null;
  const start = line.lineOffset + fact.selectionRange.startColumn - 1;
  return { start, end: start + (fact.selectionRange.endColumn - fact.selectionRange.startColumn) };
}

/**
 * 光标处的符号（**只看本文件声明**）。
 *
 * 顺序与悬停一致：名字段 → 声明头（名字之前）→ 代码面 / 插值里的名字 token 反查。
 * 反查只认**非幕**声明：幕标题不是可被引用的名字。
 */
function symbolAt(
  source: string,
  lexed: LexResult,
  facts: readonly Kojo2SymbolFact[],
  position: Kojo2SymbolPosition,
): Kojo2HighlightSymbol | undefined {
  const record = lexed.lines[position.line - 1];
  if (record === undefined) return undefined;
  if (kojo2IsNativeRecord(record)) return undefined;
  if (record.kind === 'comment' || record.kind === 'legacy') return undefined;
  const text = lineTextOf(lexed, position.line);
  const col0 = Math.min(Math.max(position.column - 1, 0), text.length);

  let header: Kojo2SymbolFact | undefined;
  for (const fact of facts) {
    const range = fact.selectionRange;
    if (range.startLine !== position.line) continue;
    if (col0 >= range.startColumn - 1 && col0 <= range.endColumn - 1) {
      return { name: fact.name, isScene: fact.kind === 'scene' };
    }
    if (col0 < range.startColumn - 1 && header === undefined) header = fact;
  }
  if (header !== undefined) return { name: header.name, isScene: header.kind === 'scene' };

  const interpolated = insideInterpolation(text, col0);
  const textSurface = kojo2IsTextSurface(record);
  if (textSurface && !interpolated) return undefined;
  if (!kojo2IsCodeSurface(record) && !textSurface) return undefined;
  if (insideStringLiteral(text, col0)) return undefined;
  const token = kojo2TokenSpanAt(text, col0);
  if (token === null) return undefined;
  const declaration = facts.find((fact) => fact.kind !== 'scene' && fact.name === token.text);
  return declaration === undefined
    ? undefined
    : { name: declaration.name, isScene: false };
}

/* ============================== 引用扫描 ============================== */

/** 表体行（表头之后到表块末行）：那是数据列，不是引用 */
function isTableBodyLine(facts: readonly Kojo2SymbolFact[], line: number): boolean {
  for (const fact of facts) {
    if (fact.kind !== 'table') continue;
    if (line > fact.range.startLine && line <= fact.range.endLine) return true;
  }
  return false;
}

/** 每行需要跳过的偏移段：声明名字段 + `# 模` / `@函` 的参数表（参数是局部名，不是引用） */
function exclusionsByLine(
  lexed: LexResult,
  facts: readonly Kojo2SymbolFact[],
): Map<number, OffsetSpan[]> {
  const out = new Map<number, OffsetSpan[]>();
  const push = (line: number, span: OffsetSpan): void => {
    const list = out.get(line);
    if (list === undefined) out.set(line, [span]);
    else list.push(span);
  };
  for (const fact of facts) {
    const span = nameOffsetSpan(lexed, fact);
    if (span === null) continue;
    push(fact.selectionRange.startLine, span);
    if (fact.kind !== 'template' && fact.kind !== 'function') continue;
    const line = lexed.lines[fact.selectionRange.startLine - 1];
    if (line === undefined) continue;
    const open = line.text.indexOf('(');
    if (open < 0) continue;
    const close = matchParenEnd(line.text, open);
    push(line.number, {
      start: line.contentOffset + open,
      end: close < 0 ? line.contentEnd : line.contentOffset + close + 1,
    });
  }
  return out;
}

/** 段落归 `read` 的出现处（代码面 / 插值） */
function scanReads(
  source: string,
  line: KojoLexLine,
  from: number,
  to: number,
  name: string,
  exclusions: readonly OffsetSpan[],
  visit: (start: number, end: number) => void,
): void {
  scanNameTokens(source, from, to, (start, end) => {
    if (source.slice(start, end) !== name) return;
    for (const exclusion of exclusions) {
      if (spansOverlap(exclusion, start, end)) return;
    }
    visit(start, end);
  });
}

/** 叙事行正文里的同名文字（`text` 档）：跳过 `{…}` 插值——那半边归 read */
function scanTextSurface(
  source: string,
  line: Extract<KojoLexLine, { readonly parts: readonly unknown[] }>,
  name: string,
  exclusions: readonly OffsetSpan[],
  emit: (start: number, end: number, kind: Kojo2HighlightKind) => void,
): void {
  const parts = line.parts;
  const interps: OffsetSpan[] = [];
  for (const part of parts) {
    if (part.kind === 'interp') {
      interps.push({ start: part.offset, end: part.endOffset });
    }
  }
  scanNameTokens(source, line.bodyOffset, line.bodyOffset + line.body.length, (start, end) => {
    if (source.slice(start, end) !== name) return;
    for (const interp of interps) {
      if (spansOverlap(interp, start, end)) return;
    }
    for (const exclusion of exclusions) {
      if (spansOverlap(exclusion, start, end)) return;
    }
    emit(start, end, 'text');
  });
  for (const part of parts) {
    if (part.kind !== 'interp') continue;
    scanReads(
      source,
      line,
      part.valueOffset,
      part.valueOffset + part.value.length,
      name,
      exclusions,
      (start, end) => emit(start, end, 'read'),
    );
  }
}

/** 一次扫描：该符号在本文件的全部出现处（不含 write；write 由声明事实直接给） */
function collectOccurrences(
  source: string,
  lexed: LexResult,
  facts: readonly Kojo2SymbolFact[],
  name: string,
): Kojo2DocumentHighlight[] {
  const out: Kojo2DocumentHighlight[] = [];
  const exclusions = exclusionsByLine(lexed, facts);
  for (const line of lexed.lines) {
    if (isTableBodyLine(facts, line.number)) continue;
    const excluded = exclusions.get(line.number) ?? [];
    const emit = (start: number, end: number, kind: Kojo2HighlightKind): void => {
      out.push({ range: rangeAt(line, start, end), kind });
    };
    switch (line.kind) {
      case 'comment':
      case 'native':
      case 'legacy':
      case 'blank':
      case 'blankLine':
      case 'options':
        continue;
      case 'decl':
        if (line.word === SCENE_WORD || line.word === VIEW_WORD) continue;
        scanReads(
          source,
          line,
          line.restOffset,
          line.contentEnd,
          name,
          excluded,
          (start, end) => emit(start, end, 'read'),
        );
        continue;
      case 'dispatch':
        if (line.word === NATIVE_WORD) continue;
        scanReads(
          source,
          line,
          line.restOffset,
          line.contentEnd,
          name,
          excluded,
          (start, end) => emit(start, end, 'read'),
        );
        continue;
      case 'trigger':
        scanReads(
          source,
          line,
          line.contentOffset,
          line.contentEnd,
          name,
          excluded,
          (start, end) => emit(start, end, 'read'),
        );
        continue;
      case 'condition':
        scanReads(
          source,
          line,
          line.testOffset,
          line.contentEnd,
          name,
          excluded,
          (start, end) => emit(start, end, 'read'),
        );
        continue;
      case 'text':
      case 'unknown':
        scanReads(
          source,
          line,
          line.contentOffset,
          line.contentEnd,
          name,
          excluded,
          (start, end) => emit(start, end, 'read'),
        );
        continue;
      default:
        scanTextSurface(source, line, name, excluded, emit);
    }
  }
  return out;
}

/** 声明名出现处（write）：幕标题只与幕比，其余声明互比（幕不属于引用命名空间） */
function collectWrites(
  facts: readonly Kojo2SymbolFact[],
  symbol: Kojo2HighlightSymbol,
): Kojo2DocumentHighlight[] {
  const writes: Kojo2DocumentHighlight[] = [];
  for (const fact of facts) {
    if (fact.name !== symbol.name) continue;
    if (symbol.isScene ? fact.kind !== 'scene' : fact.kind === 'scene') continue;
    writes.push({ range: fact.selectionRange, kind: 'write' });
  }
  return writes;
}

/* ============================== 纯逻辑入口 ============================== */

/**
 * 同符号高亮（**纯函数**）：源码 + 1 基行列 → 本文件的出现处。
 *
 * 空文件 / 坏输入 / 光标下没有声明符号 ⇒ `[]`（不抛）。
 * 出现处的 `range` 是 1 基半开区间（与 `Kojo2SymbolRange` / Monaco `IRange` 同数值口径）。
 */
export function kojo2DocumentHighlights(
  source: string,
  position: Kojo2SymbolPosition,
): Kojo2DocumentHighlight[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  if (!isUsablePosition(position)) return [];
  let lexed: LexResult;
  try {
    lexed = lex(source);
  } catch {
    return [];
  }
  const facts = kojo2DocumentSymbols(source);
  const symbol = symbolAt(source, lexed, facts, position);
  if (symbol === undefined) return [];
  const writes = collectWrites(facts, symbol);
  const occurrences = collectOccurrences(source, lexed, facts, symbol.name);
  const seen = new Set<string>();
  const merged: Kojo2DocumentHighlight[] = [];
  for (const occurrence of [...writes, ...occurrences]) {
    const key = `${occurrence.range.startLine}:${occurrence.range.startColumn}:${occurrence.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(occurrence);
  }
  merged.sort(
    (a, b) =>
      a.range.startLine - b.range.startLine ||
      a.range.startColumn - b.range.startColumn ||
      a.range.endColumn - b.range.endColumn ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
  return merged;
}

/* ============================== Monaco 翻译层 ============================== */

/** 1 基区间 → `Monaco.IRange`（字段名换一遍，数值不动） */
function toMonacoRange(range: Kojo2SymbolRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

/**
 * 档位 → Monaco `DocumentHighlightKind`（**唯一映射表**）。
 *
 * `text` = `Text`：Monaco 只画一层弱框（"同名文字"）；`read` / `write` = 引用 / 声明。
 */
export function kojo2HighlightKindToMonaco(
  monaco: typeof Monaco,
  kind: Kojo2HighlightKind,
): Monaco.languages.DocumentHighlightKind {
  const K = monaco.languages.DocumentHighlightKind;
  switch (kind) {
    case 'text':
      return K.Text;
    case 'read':
      return K.Read;
    case 'write':
      return K.Write;
  }
}

/* ============================== 安装 ============================== */

/**
 * 为 `kojo2` 语言注册文档高亮 provider，返回**幂等**的 disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**；调用点在 `ui/editor-global-providers.ts` 的 2.0 段，
 *   本函数是导出的，所以自身也再挡一次）；
 * - 只挂 `KOJO2_LANGUAGE_ID`：v1 ERB / `.kojo` 面各由自己的 provider 挂，两边不重叠；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚；宿主那侧的全有或全无才有东西可撤）。
 */
export function installKojo2HighlightProvider(monaco: typeof Monaco): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const provider: Monaco.languages.DocumentHighlightProvider = {
    provideDocumentHighlights(model, position) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return [];
        const source = model.getValue();
        if (typeof source !== 'string') return [];
        const highlights = kojo2DocumentHighlights(source, {
          line: position.lineNumber,
          column: position.column,
        });
        return highlights.map((highlight) => ({
          range: toMonacoRange(highlight.range),
          kind: kojo2HighlightKindToMonaco(monaco, highlight.kind),
        }));
      } catch {
        return [];
      }
    },
  };

  const registration = monaco.languages.registerDocumentHighlightProvider(
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
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
