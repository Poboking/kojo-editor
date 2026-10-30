/**
 * Kojo 2.0 词法器：**单遍**扫描源文本 → 物理行事实 + 逻辑行记录 + 词法诊断。
 *
 * 边界（设计稿 §2 / §4.12 / §4.13 / §8.5 / §10.4）：
 * - 只做词法：**不解析表达式**。条件/赋值/表端点/插值里的表达式一律以原文 + 偏移交给 parser；
 * - 行尾 `续` 是等待三态之一（§2.4），不是折行：本层不做逻辑行合并，物理行号 ≡ 逻辑行号；
 * - `@原生` 是**缩进围栏**：围栏内的物理行只记原文，不再解释 2.0 语法（`;`、`//`、`{}` 全是字面）；
 * - BOM / CRLF / LF / 混合 EOL **只记录事实**，一个字都不归一化（§10.4，Unit 的属性）；
 * - 旧写法（§12.1）在词法层只判"是不是"，语义码与文案由 parser 出（一份映射）；
 * - 诊断一律 1 基行列、UTF-16 码元（§4.13）：所有 span 都走 `positions.ts` 的 `at()`，不手写 `+1`；
 * - 性能：一次线性扫描；正则只在模块加载时预编译；缩进用计数；热路径不做链式数组操作、不做 `JSON`。
 */
import type { KojoAssignOp, KojoSpan, KojoWaitMode } from './ast.js';
import { createDiagnosticSink, severityOf, type CoreDiagnosticCode } from './diagnostics.js';
import { createPositionIndex, type PositionIndex } from './positions.js';
import {
  KOJO_BLANK_LINE,
  KOJO_BLANK_WAIT,
  KOJO_DECL_WORD_SET,
  KOJO_DISPATCH_WORD_SET,
  KOJO_INDENT_WIDTH,
  KOJO_TABLE_DEFAULT,
  KOJO_WAIT_CONTINUE,
  type KojoBareQuoteRecord,
  type KojoBlankLineRecord,
  type KojoBlankRecord,
  type KojoCallArg,
  type KojoCommentRecord,
  type KojoConditionRecord,
  type KojoDeclRecord,
  type KojoDialogueRecord,
  type KojoDispatchRecord,
  type KojoEscapedRecord,
  type KojoHint,
  type KojoInterpCondition,
  type KojoInterpSegment,
  type KojoLegacyKind,
  type KojoLegacyRecord,
  type KojoLexLine,
  type KojoNarrationRecord,
  type KojoNativeRecord,
  type KojoOptionsRecord,
  type KojoPhysicalLine,
  type KojoSourceFacts,
  type KojoTextRecord,
  type KojoTextSegment,
  type KojoTriggerRecord,
  type KojoUnknownRecord,
  type LexResult,
} from './tokens.js';

/* ============================== 码元常量 ============================== */

const C_TAB = 9;
const C_LF = 10;
const C_CR = 13;
const C_SPACE = 32;
const C_BANG = 33;
const C_QUOTE_D = 34;
const C_HASH = 35;
const C_OPEN_PAREN = 40;
const C_CLOSE_PAREN = 41;
const C_STAR = 42;
const C_PLUS = 43;
const C_COMMA = 44;
const C_MINUS = 45;
const C_SLASH = 47;
const C_COLON = 58;
const C_SEMI = 59;
const C_LT = 60;
const C_EQ = 61;
const C_GT = 62;
const C_QUESTION = 63;
const C_AT = 64;
const C_OPEN_BRACKET = 91;
const C_BACKSLASH = 92;
const C_CLOSE_BRACKET = 93;
const C_OPEN_BRACE = 123;
const C_CLOSE_BRACE = 125;
const C_TILDE = 0x7e;
const C_NBSP = 0xa0;
const C_FULLWIDTH_SPACE = 0x3000;
const C_QUOTE_OPEN = 0x300c;
const C_QUOTE_CLOSE = 0x300d;
const C_QUOTE_HW_OPEN = 0xff62;
const C_QUOTE_HW_CLOSE = 0xff63;
const C_COLON_FW = 0xff1a;

/**
 * 花括号收口块头的调度词（§8.5）：`@原生{` 是**唯一**允许「调度词后紧贴 `{`」的写法。
 * 词法特判与围栏开启（{@link classifyAll}）共用这一枚，避免两处字面量各写各的。
 */
const NATIVE_DISPATCH_WORD = '原生';
const C_OPEN_PAREN_FW = 0xff08;
const C_CLOSE_PAREN_FW = 0xff09;
const C_CONTINUE = 0x7eed;
const C_RETURN_MARK = 0x23ce;

/** 模块加载时预编译（热路径只 test，不 new） */
const BLANK_LINE_RE = /^[ \t\u3000\u00a0]*$/;
const UPPER_IDENT_RE = /^[A-Z_][A-Z0-9_]*$/;
const DECIMAL_INT_RE = /^[+-]?\d+$/;
const DIGITS_ONLY_RE = /^\d+$/;
/** 整数字面量形状（十进制 / `0x` / 可选符号；只判形状不判范围，见 `isIntegerLiteralText`） */
const INTEGER_SHAPE_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/;
const IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/* ============================== 公共工具（parser 复用） ============================== */

/** 诊断上报回调：0 基偏移进，词法层负责换成 1 基 span */
export type LexReporter = (
  code: CoreDiagnosticCode,
  message: string,
  startOffset: number,
  endOffset: number,
) => void;

/** 空白字符集：半角空格 / Tab / 全角空格 / NBSP（行首缩进只认前两个） */
export function isSpaceCode(c: number): boolean {
  return c === C_SPACE || c === C_TAB || c === C_FULLWIDTH_SPACE || c === C_NBSP;
}

/** 0 基偏移 → 1 基 span（唯一换算入口，禁止调用方手写 `+1`） */
export function spanOfOffsets(positions: PositionIndex, start: number, end: number): KojoSpan {
  return { start: positions.at(start), end: positions.at(end) };
}

/** 从 `start` 起跳过空白，返回首个非空白偏移（不超过 `end`） */
export function trimStartOffset(source: string, start: number, end: number): number {
  let i = start;
  while (i < end && isSpaceCode(source.charCodeAt(i))) i++;
  return i;
}

/** 从 `end` 往前跳过空白，返回末个非空白之后一位（不小于 `start`） */
export function trimEndOffset(source: string, start: number, end: number): number {
  let i = end;
  while (i > start && isSpaceCode(source.charCodeAt(i - 1))) i--;
  return i;
}

/** 双引号字符串：`text[quoteIndex] === '"'`，返回配对 `"` 之后一位（未闭合返回 `text.length`） */
export function skipQuoted(text: string, quoteIndex: number): number {
  let i = quoteIndex + 1;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === C_BACKSLASH) {
      i += 2;
      continue;
    }
    if (c === C_QUOTE_D) return i + 1;
    i++;
  }
  return len;
}

/** 在 `[from, to)` 内跳过双引号字符串，返回闭合引号之后一位（未闭合返回 `to`） */
function skipQuotedInRange(text: string, from: number, to: number): number {
  let i = from + 1;
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c === C_BACKSLASH) {
      i += 2;
      continue;
    }
    if (c === C_QUOTE_D) return i + 1;
    i++;
  }
  return to;
}

/** 按顶层逗号切实参（跳过 `"…"` 与 `()[]{}` 内部）；空片段丢弃 */
export function splitTopLevelArgs(text: string, offset: number): readonly KojoCallArg[] {
  const out: KojoCallArg[] = [];
  let depth = 0;
  let start = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c === C_QUOTE_D) {
      i = skipQuoted(text, i) - 1;
      continue;
    }
    if (c === C_OPEN_PAREN || c === C_OPEN_BRACKET || c === C_OPEN_BRACE) depth++;
    else if (c === C_CLOSE_PAREN || c === C_CLOSE_BRACKET || c === C_CLOSE_BRACE) {
      if (depth > 0) depth--;
    } else if (c === C_COMMA && depth === 0) {
      pushArg(out, text, start, i, offset);
      start = i + 1;
    }
  }
  pushArg(out, text, start, len, offset);
  return out;
}

function pushArg(
  out: KojoCallArg[],
  text: string,
  from: number,
  to: number,
  offset: number,
): void {
  const s = trimStartOffset(text, from, to);
  const e = trimEndOffset(text, s, to);
  if (e <= s) return;
  out.push({ text: text.slice(s, e), offset: offset + s });
}

/** 按空白切词（保留双引号整体，引号留在 token 里；parser 决定怎么解码） */
export function splitSpaces(text: string, offset: number): readonly KojoCallArg[] {
  const out: KojoCallArg[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    while (i < len && isSpaceCode(text.charCodeAt(i))) i++;
    if (i >= len) break;
    const start = i;
    if (text.charCodeAt(i) === C_QUOTE_D) i = skipQuoted(text, i);
    else {
      while (i < len && !isSpaceCode(text.charCodeAt(i))) i++;
    }
    out.push({ text: text.slice(start, i), offset: offset + start });
  }
  return out;
}

/** `text[openIndex] === '('` 时返回配对 `)` 的下标（跳过 `"…"`）；找不到返回 -1 */
export function matchParenEnd(text: string, openIndex: number): number {
  if (text.charCodeAt(openIndex) !== C_OPEN_PAREN) return -1;
  let depth = 0;
  const len = text.length;
  for (let i = openIndex; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c === C_QUOTE_D) {
      i = skipQuoted(text, i) - 1;
      continue;
    }
    if (c === C_OPEN_PAREN) depth++;
    else if (c === C_CLOSE_PAREN) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在顶层（跳过 `"…"` / `()[]{}`）找第一个赋值运算符；`==` / `!=` / `>=` / `<=` 不算 */
export function findTopLevelAssignOp(
  text: string,
): { readonly index: number; readonly op: KojoAssignOp } | null {
  let depth = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c === C_QUOTE_D) {
      i = skipQuoted(text, i) - 1;
      continue;
    }
    if (c === C_OPEN_PAREN || c === C_OPEN_BRACKET || c === C_OPEN_BRACE) {
      depth++;
      continue;
    }
    if (c === C_CLOSE_PAREN || c === C_CLOSE_BRACKET || c === C_CLOSE_BRACE) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth !== 0) continue;
    const next = i + 1 < len ? text.charCodeAt(i + 1) : -1;
    if (c === C_EQ) {
      if (next === C_EQ || next === C_GT) {
        i++;
        continue;
      }
      const prev = i > 0 ? text.charCodeAt(i - 1) : -1;
      if (prev === C_BANG || prev === C_GT || prev === C_LT) continue;
      return { index: i, op: '=' };
    }
    if (next === C_EQ && (c === C_PLUS || c === C_MINUS || c === C_STAR || c === C_SLASH)) {
      return {
        index: i,
        op: c === C_PLUS ? '+=' : c === C_MINUS ? '-=' : c === C_STAR ? '*=' : '/=',
      };
    }
  }
  return null;
}

/** 十进制整数字面量（表端点用；不含十六进制、不含符号表达式） */
export function isDecimalIntegerLiteral(text: string): boolean {
  return DECIMAL_INT_RE.test(text);
}

/**
 * 整数字面量解码：十进制 / `0x` 十六进制 / 可选符号；不是字面量**或超出安全整数范围**返回 null。
 *
 * 为什么卡安全整数：2.0 的 `# 设` / 表端点 / 数组长度都以 JS `number` 承载，
 * 超过 `Number.MAX_SAFE_INTEGER` 后 `parseInt` 会**静默舍入**（`12345678901234567890`
 * ⇒ `12345678901234567000`）——作者写进去的数字与产物不是同一个值。下游（`table.ts`
 * 端点与整数常量表、等值分派）本来就一律按安全整数校验，闸提前到解码口，超界才会成为
 * 可诊断的 `null`，而不是一个悄悄变形的数。
 */
export function decodeIntegerLiteral(text: string): number | null {
  const t = text.trim();
  if (t.length === 0) return null;
  let sign = 1;
  let i = 0;
  const c0 = t.charCodeAt(0);
  if (c0 === C_MINUS) {
    sign = -1;
    i = 1;
  } else if (c0 === C_PLUS) i = 1;
  const body = t.slice(i);
  if (body.length > 2) {
    const b0 = body.charCodeAt(0);
    const b1 = body.charCodeAt(1);
    if (b0 === 48 && (b1 === 120 || b1 === 88)) {
      const hex = body.slice(2);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      const value = sign * parseInt(hex, 16);
      return Number.isSafeInteger(value) ? value : null;
    }
  }
  if (!DIGITS_ONLY_RE.test(body)) return null;
  const value = sign * parseInt(body, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 文本是不是**整数字面量形状**（十进制 / `0x` / 可选符号）；只判形状、不判范围。
 *
 * 与 {@link decodeIntegerLiteral} 的分工：解码返 `null` 之后用它区分两种成因——
 * "根本不是字面量"（`abc` / `1.5`）与"是字面量但超安全整数"（诊断文案与修法不同）。
 */
export function isIntegerLiteralText(text: string): boolean {
  return INTEGER_SHAPE_RE.test(text.trim());
}

/** 双引号字符串字面量解码（支持 `\"` `\\` `\{` `\}`）；不是合法字面量返回 null */
export function decodeQuotedLiteral(text: string): string | null {
  const t = text.trim();
  const len = t.length;
  if (len < 2 || t.charCodeAt(0) !== C_QUOTE_D || t.charCodeAt(len - 1) !== C_QUOTE_D) return null;
  const end = len - 1;
  let out = '';
  let i = 1;
  while (i < end) {
    const c = t.charCodeAt(i);
    if (c === C_BACKSLASH) {
      if (i + 1 >= end) return null;
      const n = t.charCodeAt(i + 1);
      if (n === C_QUOTE_D || n === C_BACKSLASH || n === C_OPEN_BRACE || n === C_CLOSE_BRACE) {
        out += t.charAt(i + 1);
        i += 2;
        continue;
      }
      return null;
    }
    out += t.charAt(i);
    i++;
  }
  return out;
}

/** 2.0 标识符：字母 / 下划线 / 汉字开头，后续可含数字（不含空白与全角标点） */
export function isIdentifier(text: string): boolean {
  return IDENTIFIER_RE.test(text);
}

/* ============================== 入口 ============================== */

/** 单遍词法入口（纯函数：同输入必同输出，无 IO、无全局可变状态） */
export function lex(source: string): LexResult {
  const sink = createDiagnosticSink();
  const positions = createPositionIndex(source);
  const report: LexReporter = (code, message, start, end) => {
    sink.report({
      code,
      severity: severityOf(code),
      message,
      span: spanOfOffsets(positions, start, end),
    });
  };
  const contentStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const physical: KojoPhysicalLine[] = [];
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  /* ---- 物理行：一次扫描切行，EOL 只计数不归一化 ---- */
  const len = source.length;
  let lineStart = contentStart;
  let lineNumber = 1;
  for (let i = contentStart; i < len; i++) {
    const c = source.charCodeAt(i);
    if (c === C_LF) {
      const hasCr = i > lineStart && source.charCodeAt(i - 1) === C_CR;
      const end = hasCr ? i - 1 : i;
      physical.push(makePhysicalLine(source, lineStart, end, hasCr ? 'crlf' : 'lf', lineNumber++));
      if (hasCr) crlf++;
      else lf++;
      lineStart = i + 1;
    } else if (c === C_CR) {
      if (i + 1 < len && source.charCodeAt(i + 1) === C_LF) continue;
      physical.push(makePhysicalLine(source, lineStart, i, 'cr', lineNumber++));
      cr++;
      lineStart = i + 1;
    }
  }
  if (lineStart < len) {
    physical.push(makePhysicalLine(source, lineStart, len, 'none', lineNumber));
  }

  /* ---- 逻辑行：`@原生` 围栏内的物理行原样标出，不解释 2.0 ---- */
  const lines = classifyAll(source, physical, report);

  const eol = eolStyleOf(crlf, lf, cr);
  const facts: KojoSourceFacts = {
    bom: contentStart === 0 ? 'none' : 'feff',
    eol,
    crlf,
    lf,
    cr,
    physicalLines: physical.length,
    logicalLines: lines.length,
    contentStart,
  };
  return { source, facts, physical, lines, diagnostics: sink.all, positions };
}

function eolStyleOf(crlf: number, lf: number, cr: number): KojoSourceFacts['eol'] {
  let kinds = 0;
  if (crlf > 0) kinds++;
  if (lf > 0) kinds++;
  if (cr > 0) kinds++;
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  return crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'cr';
}

function makePhysicalLine(
  source: string,
  start: number,
  end: number,
  eol: 'lf' | 'crlf' | 'cr' | 'none',
  number: number,
): KojoPhysicalLine {
  const text = source.slice(start, end);
  let spaces = 0;
  let tabs = 0;
  let k = 0;
  while (k < text.length) {
    const c = text.charCodeAt(k);
    if (c === C_SPACE) spaces++;
    else if (c === C_TAB) tabs++;
    else break;
    k++;
  }
  const blank = BLANK_LINE_RE.test(text);
  const comment =
    !blank && text.charCodeAt(k) === C_SLASH && text.charCodeAt(k + 1) === C_SLASH;
  return {
    number,
    offset: start,
    text,
    eol,
    indentWidth: spaces + tabs * KOJO_INDENT_WIDTH,
    indentChars: k,
    tabs,
    blank,
    comment,
  };
}

/* ============================== 逐行分类 ============================== */

function classifyAll(
  source: string,
  physical: readonly KojoPhysicalLine[],
  report: LexReporter,
): KojoLexLine[] {
  const lines: KojoLexLine[] = [];
  let fenceIndent: number | null = null;
  for (let idx = 0; idx < physical.length; idx++) {
    const p = physical[idx]!;
    if (p.blank) {
      lines.push(fenceIndent !== null ? nativeRecord(p) : blankRecord(p));
      continue;
    }
    if (fenceIndent !== null) {
      if (p.indentWidth > fenceIndent) {
        lines.push(nativeRecord(p));
        continue;
      }
      // `@原生{ … }` 的收口行：与块头同缩进的单独一行 `}`——围栏在此结束，
      // 收口行以 native(close) 记录交给 parser 消费（§8.5：收口只认同缩进单独一行 `}`）。
      const trimmed = p.text.slice(p.indentChars).trim();
      if (trimmed === '}') {
        lines.push({ ...nativeRecord(p), close: true });
        fenceIndent = null;
        continue;
      }
      fenceIndent = null;
    }
    const record = classifyLine(source, p, report);
    lines.push(record);
    if (record.kind === 'dispatch' && record.known && record.word === NATIVE_DISPATCH_WORD) {
      fenceIndent = p.indentWidth;
    }
  }
  return lines;
}

function blankRecord(p: KojoPhysicalLine): KojoBlankRecord {
  const at = p.offset + p.indentChars;
  return {
    kind: 'blank',
    number: p.number,
    lineOffset: p.offset,
    contentOffset: at,
    contentEnd: at,
    indent: p.indentWidth,
    tabs: p.tabs,
    text: '',
    invalid: false,
  };
}

function nativeRecord(p: KojoPhysicalLine): KojoNativeRecord {
  const end = p.offset + p.text.length;
  return {
    kind: 'native',
    number: p.number,
    lineOffset: p.offset,
    contentOffset: p.offset,
    contentEnd: end,
    indent: p.indentWidth,
    tabs: p.tabs,
    text: p.text,
    invalid: false,
    raw: p.text,
    blank: p.blank,
  };
}

interface LineCtx {
  readonly source: string;
  readonly p: KojoPhysicalLine;
  readonly cs: number;
  readonly ce: number;
  readonly content: string;
  readonly invalid: boolean;
  readonly report: LexReporter;
}

function baseOf(ctx: LineCtx): {
  number: number;
  lineOffset: number;
  contentOffset: number;
  contentEnd: number;
  indent: number;
  tabs: number;
  text: string;
  invalid: boolean;
} {
  return {
    number: ctx.p.number,
    lineOffset: ctx.p.offset,
    contentOffset: ctx.cs,
    contentEnd: ctx.ce,
    indent: ctx.p.indentWidth,
    tabs: ctx.p.tabs,
    text: ctx.content,
    invalid: ctx.invalid,
  };
}

function classifyLine(source: string, p: KojoPhysicalLine, report: LexReporter): KojoLexLine {
  const cs = p.offset + p.indentChars;
  const ce = trimEndOffset(source, cs, p.offset + p.text.length);
  const content = source.slice(cs, ce);

  if (p.comment) {
    return {
      kind: 'comment',
      number: p.number,
      lineOffset: p.offset,
      contentOffset: cs,
      contentEnd: ce,
      indent: p.indentWidth,
      tabs: p.tabs,
      text: content,
      invalid: false,
      comment: content.slice(2),
    };
  }

  let invalid = false;
  if (p.tabs > 0) {
    report(
      'core/lex/indent',
      '结构行只能用空格缩进：Tab 只允许出现在 `@原生` 块体里（§4.13）。',
      p.offset,
      cs,
    );
    invalid = true;
  } else if (p.indentChars % KOJO_INDENT_WIDTH !== 0) {
    report(
      'core/lex/indent',
      `缩进不是一级（4 空格）的倍数：本行前导 ${p.indentChars} 个空格（§4.13）。`,
      p.offset,
      cs,
    );
    invalid = true;
  }

  const ctx: LineCtx = { source, p, cs, ce, content, invalid, report };
  const c0 = content.charCodeAt(0);
  switch (c0) {
    case C_HASH:
      return classifyDecl(ctx);
    case C_AT:
      return classifyDispatch(ctx);
    case C_GT:
      return classifyNarration(ctx);
    case C_QUESTION:
      return classifyCondition(ctx);
    case C_BANG:
      return classifyTrigger(ctx);
    case C_BACKSLASH:
      return classifyEscaped(ctx);
    default:
      return classifyPlain(ctx);
  }
}

function classifyDecl(ctx: LineCtx): KojoLexLine {
  const { content, cs, ce, report } = ctx;
  if (content.length === 1) {
    report('core/lex/anchor', '`#` 后面缺少声明词（形如 `# 幕 神社清晨`）。', cs, ce);
    return {
      kind: 'unknown',
      ...baseOf(ctx),
      invalid: true,
      reason: 'bare-hash',
    };
  }
  const c1 = content.charCodeAt(1);
  if (c1 !== C_SPACE && c1 !== C_TAB) {
    // `#DIM` / `#FUNCTION` 等原生预处理器：ASCII 大写/下划线开头，2.0 不直通，必须进 `@原生`
    const asciiUpper = (c1 >= 65 && c1 <= 90) || c1 === 95;
    if (asciiUpper) {
      const wordEnd = scanWordEnd(content, 1);
      let r = wordEnd;
      while (r < content.length && isSpaceCode(content.charCodeAt(r))) r++;
      return {
        kind: 'legacy',
        ...baseOf(ctx),
        invalid: false,
        legacy: 'preprocessor',
        rest: content.slice(r),
        restOffset: cs + r,
      };
    }
    // `#幕` 这类：`#` 与声明词之间必须有一个空格（§2.4）
    report('core/lex/anchor', '`#` 与声明词之间必须有空格：写 `# 幕 神社清晨`，不写 `#幕`（§2.4）。', cs, cs + 1);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'hash-no-space' };
  }
  let k = 1;
  while (k < content.length && isSpaceCode(content.charCodeAt(k))) k++;
  const wordStart = k;
  const wordEnd = scanWordEnd(content, wordStart);
  const word = content.slice(wordStart, wordEnd);
  if (word.length === 0) {
    report('core/lex/anchor', '`#` 后面缺少声明词（形如 `# 池 早安问候`）。', cs, ce);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'bare-hash' };
  }
  let r = wordEnd;
  while (r < content.length && isSpaceCode(content.charCodeAt(r))) r++;
  const rest = content.slice(r);
  const restOffset = cs + r;
  if (word === '版本') {
    return { kind: 'legacy', ...baseOf(ctx), invalid: false, legacy: 'version', rest, restOffset };
  }
  if (word === '时机') {
    return { kind: 'legacy', ...baseOf(ctx), invalid: false, legacy: 'timing', rest, restOffset };
  }
  return {
    kind: 'decl',
    ...baseOf(ctx),
    word,
    rest,
    restOffset,
    known: KOJO_DECL_WORD_SET.has(word),
  };
}

function classifyDispatch(ctx: LineCtx): KojoLexLine {
  const { content, cs, ce, report } = ctx;
  if (content.length === 1) {
    report('core/lex/anchor', '`@` 后面缺少调度词（形如 `@算` / `@随机`）。', cs, ce);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'bare-at' };
  }
  let k = 1;
  if (isSpaceCode(content.charCodeAt(1))) {
    report('core/lex/anchor', '`@` 与调度词之间不要空白：写 `@算`，不写 `@ 算`。', cs, cs + 2);
    while (k < content.length && isSpaceCode(content.charCodeAt(k))) k++;
  }
  const wordStart = k;
  const wordEnd = scanWordEnd(content, wordStart);
  let word = content.slice(wordStart, wordEnd);
  // `@原生{`（§8.5 新典）：花括号紧贴调度词——`{` 是块头载荷的起点，不是词的一部分；
  // 不特判会被切进词里（`原生{` 不在词集），整行误落 legacy 报「已退场」。
  // **只对 `原生` 生效**：`{` 剥出来会变成 `rest`，而 `@返` 等词的 `rest` 是可选表达式、
  // 不校验形态——对它们剥 `{` 会把 `@返{` 从「未知写法」静默放宽成合法返回（实测零诊断）。
  let restShift = 0;
  if (word.length > 1 && word.charCodeAt(word.length - 1) === C_OPEN_BRACE) {
    const head = word.slice(0, -1);
    if (head === NATIVE_DISPATCH_WORD) {
      word = head;
      restShift = 1;
    }
  }
  if (word.length === 0) {
    report('core/lex/anchor', '`@` 后面缺少调度词。', cs, ce);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'bare-at' };
  }
  let r = wordEnd - restShift;
  while (r < content.length && isSpaceCode(content.charCodeAt(r))) r++;
  const rest = content.slice(r);
  const restOffset = cs + r;
  if (!KOJO_DISPATCH_WORD_SET.has(word)) {
    const legacy: KojoLegacyKind = UPPER_IDENT_RE.test(word) ? 'native-label' : 'raw-function';
    return { kind: 'legacy', ...baseOf(ctx), invalid: false, legacy, rest, restOffset };
  }
  return {
    kind: 'dispatch',
    ...baseOf(ctx),
    invalid: ctx.invalid,
    word,
    rest,
    restOffset,
    known: true,
  };
}

function classifyNarration(ctx: LineCtx): KojoLexLine {
  const { source, content, cs, ce, report } = ctx;
  let invalid = ctx.invalid;
  if (content.length > 1 && !isSpaceCode(content.charCodeAt(1))) {
    report('core/lex/anchor', '`>` 后必须跟空白：写 `> 旁白正文`。', cs, cs + 1);
    invalid = true;
  }
  let k = 1;
  while (k < content.length && isSpaceCode(content.charCodeAt(k))) k++;
  const bodyStart = cs + k;
  const tail = parseTail(ctx, bodyStart, ce);
  if (tail.invalid) invalid = true;
  const parts = scanSegments(ctx, bodyStart, tail.bodyEnd);
  const record: KojoNarrationRecord = {
    kind: 'narration',
    ...baseOf(ctx),
    invalid,
    wait: tail.wait,
    hint: tail.hint,
    hintCount: tail.hintCount,
    body: source.slice(bodyStart, tail.bodyEnd),
    bodyOffset: bodyStart,
    parts,
    legacyWait: tail.legacyWait,
  };
  return record;
}

function classifyCondition(ctx: LineCtx): KojoLexLine {
  const { content, cs, ce, report } = ctx;
  let invalid = ctx.invalid;
  if (content.length > 1 && !isSpaceCode(content.charCodeAt(1))) {
    report('core/lex/anchor', '`?` 后必须跟空白：写 `? 恋慕 >= 500`。', cs, cs + 1);
    invalid = true;
  }
  let k = 1;
  while (k < content.length && isSpaceCode(content.charCodeAt(k))) k++;
  if (k >= content.length) {
    report('core/lex/anchor', '`?` 后面缺条件；收束条件链写 `? 否`。', cs, ce);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'bare-question' };
  }
  const test = content.slice(k);
  const record: KojoConditionRecord = {
    kind: 'condition',
    ...baseOf(ctx),
    invalid,
    isDefault: test === KOJO_TABLE_DEFAULT,
    test: test === KOJO_TABLE_DEFAULT ? '' : test,
    testOffset: cs + k,
  };
  return record;
}

function classifyTrigger(ctx: LineCtx): KojoLexLine {
  const { content, cs, ce, report } = ctx;
  let invalid = ctx.invalid;
  if (content.length > 1 && !isSpaceCode(content.charCodeAt(1))) {
    report('core/lex/anchor', '`!` 后必须跟空白：写 `! 池名` / `! 模名(实参)`。', cs, cs + 1);
    invalid = true;
  }
  let k = 1;
  while (k < content.length && isSpaceCode(content.charCodeAt(k))) k++;
  if (k >= content.length) {
    report('core/lex/anchor', '`!` 后面缺被调名字（池 / 模板 / 函数）。', cs, ce);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'bare-bang' };
  }
  let nameEnd = k;
  while (nameEnd < content.length) {
    const c = content.charCodeAt(nameEnd);
    if (isSpaceCode(c) || c === C_OPEN_PAREN) break;
    nameEnd++;
  }
  const name = content.slice(k, nameEnd);
  const nameOffset = cs + k;
  let args: readonly KojoCallArg[] = [];
  let hasParens = false;
  let j = nameEnd;
  while (j < content.length && isSpaceCode(content.charCodeAt(j))) j++;
  if (j < content.length && content.charCodeAt(j) === C_OPEN_PAREN) {
    hasParens = true;
    const close = matchParenEnd(content, j);
    if (close < 0) {
      report('core/lex/anchor', '实参括号未闭合：缺 `)`。', cs + j, ce);
      invalid = true;
    } else {
      args = splitTopLevelArgs(content.slice(j + 1, close), cs + j + 1);
      if (j + 1 + (close - j - 1) < content.length) {
        const tailText = content.slice(close + 1);
        if (tailText.trim().length > 0) {
          report('core/lex/anchor', '实参括号 `)` 后不能有内容。', cs + close + 1, ce);
          invalid = true;
        }
      }
    }
  }
  const record: KojoTriggerRecord = {
    kind: 'trigger',
    ...baseOf(ctx),
    invalid,
    name,
    nameOffset,
    args,
    hasParens,
  };
  return record;
}

function classifyEscaped(ctx: LineCtx): KojoLexLine {
  const { source, content, cs, ce } = ctx;
  if (content.length === 1) {
    ctx.report('core/lex/anchor', '行首 `\\` 后面缺字符（`\\>` 才输出字面 `>`）。', cs, ce);
    return { kind: 'unknown', ...baseOf(ctx), invalid: true, reason: 'bare-backslash' };
  }
  let invalid = ctx.invalid;
  const escaped = content.charAt(1);
  const bodyStart = cs + 1; // 去掉行首 `\`，正文从被还原的字符开始
  const tail = parseTail(ctx, bodyStart, ce);
  if (tail.invalid) invalid = true;
  const parts: KojoTextSegment[] = [];
  let scanFrom = bodyStart;
  const escCode = escaped.charCodeAt(0);
  if (escCode === C_OPEN_BRACE || escCode === C_CLOSE_BRACE || escCode === C_BACKSLASH) {
    parts.push({ kind: 'text', text: escaped, offset: cs, endOffset: bodyStart + 1 });
    scanFrom = bodyStart + 1;
  }
  const restParts = scanSegments(ctx, scanFrom, tail.bodyEnd);
  for (let i = 0; i < restParts.length; i++) parts.push(restParts[i]!);
  const record: KojoEscapedRecord = {
    kind: 'escaped',
    ...baseOf(ctx),
    invalid,
    wait: tail.wait,
    hint: tail.hint,
    hintCount: tail.hintCount,
    body: source.slice(bodyStart, tail.bodyEnd),
    bodyOffset: bodyStart,
    parts,
    legacyWait: tail.legacyWait,
    escaped,
  };
  return record;
}

/* ---- 无锚点行：选项 / 台词 / 裸引号 / 空行语句 / 旧写法 / 裸行 ---- */

const HEAD_DECL_WORDS: ReadonlySet<string> = new Set<string>([
  '角色',
  '口上',
  '显示名',
  '简介',
  '开关',
]);

const LEGACY_WORD_MAP: ReadonlyMap<string, KojoLegacyKind> = new Map<string, KojoLegacyKind>([
  ['如果', 'if'],
  ['否则如果', 'elif'],
  ['否则', 'else'],
  ['当', 'when'],
  ['是', 'is'],
  ['分支', 'branch'],
  ['循环', 'loop'],
  ['循环结束', 'loop-end'],
  ['调用', 'call'],
  ['返回', 'return'],
  ['标签', 'goto-label'],
  ['跳到', 'goto-jump'],
  ['初回', 'ask'],
  ['询问', 'ask'],
  ['确认', 'ask'],
  ['隐藏情景', 'hidden-timing'],
  ['隐藏口上', 'hidden-timing'],
  ['别名', 'alias'],
  ['旁白色', 'color-option'],
  ['口上色', 'color-option'],
  ['心形', 'heart'],
  ['着色', 'color-block'],
  ['随机', 'random-block'],
  ['组', 'group-block'],
  ['数据表', 'data-table'],
  ['数据表结束', 'data-table'],
]);

function classifyPlain(ctx: LineCtx): KojoLexLine {
  const { source, content, cs, ce, report } = ctx;
  const c0 = content.charCodeAt(0);

  // 行首 `;` 注释（2.0 只认整行 `//`）
  if (c0 === C_SEMI) {
    return {
      kind: 'legacy',
      ...baseOf(ctx),
      invalid: false,
      legacy: 'semicolon',
      rest: content.slice(1),
      restOffset: cs + 1,
    };
  }
  // 行首 `=`（1.0：`= 返 n` / `= 变量 x`；2.0 不回归）
  if (c0 === C_EQ) {
    return {
      kind: 'legacy',
      ...baseOf(ctx),
      invalid: false,
      legacy: 'equal-prefix',
      rest: content.slice(1),
      restOffset: cs + 1,
    };
  }
  // 行首 `~` / `⏎`（1.0 等待标记）
  if (c0 === C_TILDE || c0 === C_RETURN_MARK) {
    return {
      kind: 'legacy',
      ...baseOf(ctx),
      invalid: false,
      legacy: 'wait-mark',
      rest: content.slice(1),
      restOffset: cs + 1,
    };
  }

  // 引号与台词：找第一个左引号（`「` 或半角旧引号 `｢`）
  const quoteIdx = findFirstQuote(content);
  if (quoteIdx === 0) return classifyBareQuote(ctx, content.charCodeAt(0) === C_QUOTE_HW_OPEN ? '｢' : '「');
  if (quoteIdx > 0) {
    const prev = content.charCodeAt(quoteIdx - 1);
    if (prev === C_COLON_FW || prev === C_COLON) {
      if (prev === C_COLON) {
        report('core/lex/anchor', '对话冒号必须是全角 `：`（§4.13）。', cs + quoteIdx - 1, cs + quoteIdx);
        return classifyDialogue(ctx, quoteIdx, true);
      }
      return classifyDialogue(ctx, quoteIdx, false);
    }
  }

  const wordEnd = scanWordEnd(content, 0);
  const word = content.slice(0, wordEnd);
  let after = wordEnd;
  while (after < content.length && isSpaceCode(content.charCodeAt(after))) after++;
  const rest = content.slice(after);
  const restOffset = cs + after;

  // `选项：`（2.0 待定 UI：建树 + warning，不是旧语法例外）
  const colonAfterWord = content.charCodeAt(wordEnd);
  if (word === '选项' && colonAfterWord === C_COLON_FW) {
    const afterColon = content.slice(wordEnd + 1).trim();
    if (afterColon.length > 0) {
      report('core/lex/anchor', '`选项：` 块头后面不接行内内容（§7.5）。', cs, ce);
      return { kind: 'options', ...baseOf(ctx), invalid: true };
    }
    const opts: KojoOptionsRecord = { kind: 'options', ...baseOf(ctx) };
    return opts;
  }
  if (word === '选项' && colonAfterWord === C_COLON) {
    report('core/lex/anchor', '`选项` 后用全角冒号：写 `选项：`（§4.13）。', cs + wordEnd, cs + wordEnd + 1);
    return { kind: 'options', ...baseOf(ctx), invalid: true };
  }

  // `空行` 三态（§4.7）
  if (word === KOJO_BLANK_LINE) {
    let wait: KojoWaitMode = 'default';
    if (rest.length > 0) {
      if (rest === KOJO_BLANK_WAIT) wait = 'wait';
      else if (rest === KOJO_WAIT_CONTINUE) wait = 'continue';
      else if (rest === 'cont' || rest === 'continue' || rest === '~' || rest === '⏎') {
        return {
          kind: 'legacy',
          ...baseOf(ctx),
          invalid: false,
          legacy: 'wait-mark',
          rest,
          restOffset,
        };
      } else {
        report(
          'core/lex/anchor',
          '`空行` 只接受三种写法：`空行` / `空行 等待` / `空行 续`（§4.7）。',
          cs,
          ce,
        );
        return { kind: 'blankLine', ...baseOf(ctx), invalid: true, wait };
      }
    }
    const blank: KojoBlankLineRecord = {
      kind: 'blankLine',
      ...baseOf(ctx),
      invalid: ctx.invalid,
      wait,
    };
    return blank;
  }

  // 旧文件头声明 `角色:` / `口上:` / `显示名:` / `简介:` / `开关:`
  if (HEAD_DECL_WORDS.has(word) && (colonAfterWord === C_COLON_FW || colonAfterWord === C_COLON)) {
    return {
      kind: 'legacy',
      ...baseOf(ctx),
      invalid: false,
      legacy: 'head-decl',
      rest,
      restOffset,
    };
  }

  // 其余旧写法词（`如果` / `当` / `循环` / `心形` / `着色` / `随机` / …）
  const legacy = LEGACY_WORD_MAP.get(word);
  if (legacy !== undefined) {
    return { kind: 'legacy', ...baseOf(ctx), invalid: false, legacy, rest, restOffset };
  }

  // 兜底裸行：整行原样（裸行不剥行尾提示：`记录("hi")` 的括号是实参，不是表演提示）
  const parts = scanSegments(ctx, cs, ce);
  const record: KojoTextRecord = {
    kind: 'text',
    ...baseOf(ctx),
    invalid: ctx.invalid,
    wait: 'default',
    hint: null,
    hintCount: 0,
    body: content,
    bodyOffset: cs,
    parts,
    legacyWait: null,
  };
  return record;
}

function findFirstQuote(content: string): number {
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === C_QUOTE_OPEN || c === C_QUOTE_HW_OPEN) return i;
  }
  return -1;
}

function classifyDialogue(ctx: LineCtx, quoteIdx: number, invalidIn: boolean): KojoDialogueRecord {
  const { source, content, cs, ce, report } = ctx;
  let invalid = ctx.invalid || invalidIn;
  const quoteCode = content.charCodeAt(quoteIdx);
  const closeChar = quoteCode === C_QUOTE_HW_OPEN ? '｣' : '」';
  const closeIdx = content.lastIndexOf(closeChar);
  let bodyEnd: number;
  let tail: Tail;
  if (closeIdx <= quoteIdx) {
    report('core/lex/anchor', '台词缺右引号 `」`。', cs + quoteIdx, ce);
    invalid = true;
    bodyEnd = ce;
    tail = parseTail(ctx, ce, ce);
  } else {
    bodyEnd = cs + closeIdx;
    tail = parseTail(ctx, bodyEnd + 1, ce);
    if (tail.invalid) invalid = true;
  }
  const speakerEnd = quoteIdx - 1; // `：` 的位置
  const speakerStart = trimStartOffset(content, 0, speakerEnd);
  const speaker = content.slice(speakerStart, speakerEnd).trimEnd();
  const speakerOffset = cs + speakerStart;
  if (speaker.length === 0) {
    report('core/lex/anchor', '台词缺说话人：写 `角色：「…」`。', cs, cs + quoteIdx);
    invalid = true;
  }
  const bodyStart = cs + quoteIdx + 1;
  const parts = scanSegments(ctx, bodyStart, bodyEnd);
  const record: KojoDialogueRecord = {
    kind: 'dialogue',
    ...baseOf(ctx),
    invalid,
    wait: tail.wait,
    hint: tail.hint,
    hintCount: tail.hintCount,
    body: source.slice(bodyStart, bodyEnd),
    bodyOffset: bodyStart,
    parts,
    legacyWait: tail.legacyWait,
    speaker,
    speakerOffset,
  };
  return record;
}

function classifyBareQuote(ctx: LineCtx, quote: '「' | '｢'): KojoBareQuoteRecord {
  const { source, content, cs, ce, report } = ctx;
  let invalid = ctx.invalid;
  const closeChar = quote === '｢' ? '｣' : '」';
  const closeIdx = content.lastIndexOf(closeChar);
  let bodyEnd: number;
  let tail: Tail;
  if (closeIdx <= 0) {
    report('core/lex/anchor', `裸引号缺右引号 \`${closeChar}\`。`, cs, ce);
    invalid = true;
    bodyEnd = ce;
    tail = parseTail(ctx, ce, ce);
  } else {
    bodyEnd = cs + closeIdx;
    tail = parseTail(ctx, bodyEnd + 1, ce);
    if (tail.invalid) invalid = true;
  }
  const bodyStart = cs + 1;
  const parts = scanSegments(ctx, bodyStart, bodyEnd);
  const record: KojoBareQuoteRecord = {
    kind: 'bareQuote',
    ...baseOf(ctx),
    invalid,
    wait: tail.wait,
    hint: tail.hint,
    hintCount: tail.hintCount,
    body: source.slice(bodyStart, bodyEnd),
    bodyOffset: bodyStart,
    parts,
    legacyWait: tail.legacyWait,
    quote,
  };
  return record;
}

/* ============================== 行尾尾巴：等待 + 提示 ============================== */

interface Tail {
  readonly wait: KojoWaitMode;
  readonly hint: KojoHint | null;
  readonly hintCount: number;
  readonly legacyWait: string | null;
  readonly invalid: boolean;
  readonly bodyEnd: number;
}

function parseTail(ctx: LineCtx, start: number, end: number): Tail {
  const { source, report } = ctx;
  let invalid = false;
  let e = trimEndOffset(source, start, end);
  let wait: KojoWaitMode = 'default';
  let legacyWait: string | null = null;

  // 行尾 `续`：必须前接空白或整行只有它（否则是正文的一部分）
  if (e > start && source.charCodeAt(e - 1) === C_CONTINUE) {
    if (e - 1 === start || isSpaceCode(source.charCodeAt(e - 2))) {
      wait = 'continue';
      e = trimEndOffset(source, start, e - 1);
    }
  }

  // 旧等待别名：`~` / `⏎` / `cont` / `continue`
  if (e > start) {
    const c = source.charCodeAt(e - 1);
    if (c === C_TILDE || c === C_RETURN_MARK) {
      legacyWait = source.charAt(e - 1);
      e = trimEndOffset(source, start, e - 1);
      invalid = true;
    } else {
      const suffix = asciiSuffix(source, start, e);
      if (suffix !== null) {
        legacyWait = suffix;
        e = trimEndOffset(source, start, e - suffix.length);
        invalid = true;
      }
    }
  }

  // 行尾表演提示组 `(心形)` / `(别过头)`；多个组留给 parser 报 bad-hint
  let hint: KojoHint | null = null;
  let hintCount = 0;
  for (;;) {
    if (e <= start || source.charCodeAt(e - 1) !== C_CLOSE_PAREN) break;
    const open = source.lastIndexOf('(', e - 2);
    if (open < start) break;
    const innerStart = trimStartOffset(source, open + 1, e - 1);
    const innerEnd = trimEndOffset(source, innerStart, e - 1);
    if (innerEnd <= innerStart) break;
    hintCount++;
    if (hint === null) hint = { text: source.slice(innerStart, innerEnd), offset: open };
    e = trimEndOffset(source, start, open);
  }

  if (legacyWait !== null) {
    report(
      'core/migration/wait',
      `行尾等待别名 \`${legacyWait}\` 已退场：2.0 只写 \`续\`（§12.1）。`,
      e,
      Math.min(e + legacyWait.length, ctx.ce),
    );
  }

  return { wait, hint, hintCount, legacyWait, invalid, bodyEnd: e };
}

/** 行尾 ASCII 旧等待词（`cont` / `continue`，要求前面是空白） */
function asciiSuffix(source: string, start: number, end: number): string | null {
  const len = end - start;
  if (len >= 8 && source.startsWith('continue', end - 8)) {
    if (end - 8 === start || isSpaceCode(source.charCodeAt(end - 9))) return 'continue';
  }
  if (len >= 4 && source.startsWith('cont', end - 4)) {
    if (end - 4 === start || isSpaceCode(source.charCodeAt(end - 5))) return 'cont';
  }
  return null;
}

/* ============================== 插值扫描（只扫不解析） ============================== */

function scanSegments(ctx: LineCtx, start: number, end: number): readonly KojoTextSegment[] {
  const { source, report } = ctx;
  const out: KojoTextSegment[] = [];
  let i = start;
  let litStart = -1;
  let lit = '';
  while (i < end) {
    const c = source.charCodeAt(i);
    if (c === C_BACKSLASH) {
      const n = i + 1 < end ? source.charCodeAt(i + 1) : -1;
      if (n === C_OPEN_BRACE || n === C_CLOSE_BRACE || n === C_BACKSLASH) {
        if (litStart < 0) litStart = i;
        lit += source.charAt(i + 1);
        i += 2;
        continue;
      }
      if (litStart < 0) litStart = i;
      lit += '\\';
      i++;
      continue;
    }
    if (c === C_OPEN_BRACE) {
      if (litStart >= 0) {
        out.push({ kind: 'text', text: lit, offset: litStart, endOffset: i });
        litStart = -1;
        lit = '';
      }
      const seg = scanInterpolation(ctx, i, end);
      if (seg === null) {
        // 未闭合：报错后把剩余当字面文本（错误恢复，不产半成品节点）
        report('core/lex/interpolation', '插值花括号 `{` 未闭合。', i, Math.min(i + 1, end));
        out.push({ kind: 'text', text: source.slice(i, end), offset: i, endOffset: end });
        i = end;
        break;
      }
      out.push(seg.segment);
      i = seg.next;
      continue;
    }
    if (c === C_CLOSE_BRACE) {
      if (litStart < 0) litStart = i;
      lit += '}';
      i++;
      continue;
    }
    if (litStart < 0) litStart = i;
    lit += source.charAt(i);
    i++;
  }
  if (litStart >= 0) out.push({ kind: 'text', text: lit, offset: litStart, endOffset: end });
  return out;
}

function scanInterpolation(
  ctx: LineCtx,
  braceStart: number,
  rangeEnd: number,
): { readonly segment: KojoInterpSegment; readonly next: number } | null {
  const { source, report } = ctx;
  let i = braceStart + 1;
  let inString = false;
  let close = -1;
  while (i < rangeEnd) {
    const c = source.charCodeAt(i);
    if (inString) {
      if (c === C_BACKSLASH) {
        i += 2;
        continue;
      }
      if (c === C_QUOTE_D) inString = false;
      i++;
      continue;
    }
    if (c === C_QUOTE_D) {
      inString = true;
      i++;
      continue;
    }
    if (c === C_OPEN_BRACE) {
      report('core/lex/interpolation', '插值里不允许嵌套花括号（§4.12）。', i, i + 1);
    }
    if (c === C_CLOSE_BRACE) {
      close = i;
      break;
    }
    i++;
  }
  if (close < 0) return null;

  const value = source.slice(braceStart + 1, close);
  const innerStart = trimStartOffset(source, braceStart + 1, close);
  const innerEnd = trimEndOffset(source, innerStart, close);
  if (innerEnd <= innerStart) {
    report('core/lex/interpolation', '插值 `{}` 不能为空。', braceStart, close + 1);
  }

  let condition: KojoInterpCondition | null = null;
  const q = findConditional(source, innerStart, innerEnd);
  if (q !== null) {
    if (q.colon < 0) {
      report('core/lex/interpolation', '行内条件插值缺 `:`：写 `{条件 ? A : B}`（§4.12）。', innerStart, innerEnd);
    } else {
      const condStart = trimStartOffset(source, innerStart, q.q);
      const condEnd = trimEndOffset(source, condStart, q.q);
      const thenStart = trimStartOffset(source, q.q + 1, q.colon);
      const thenEnd = trimEndOffset(source, thenStart, q.colon);
      const elseStart = trimStartOffset(source, q.colon + 1, innerEnd);
      const elseEnd = trimEndOffset(source, elseStart, innerEnd);
      if (condEnd <= condStart || thenEnd <= thenStart || elseEnd <= elseStart) {
        report(
          'core/lex/interpolation',
          '行内条件插值三段（条件 / 真 / 假）都不能为空（§4.12）。',
          innerStart,
          innerEnd,
        );
      }
      condition = {
        cond: { text: source.slice(condStart, condEnd), offset: condStart },
        then: { text: source.slice(thenStart, thenEnd), offset: thenStart },
        else: { text: source.slice(elseStart, elseEnd), offset: elseStart },
      };
    }
  }

  const segment: KojoInterpSegment = {
    kind: 'interp',
    raw: source.slice(braceStart, close + 1),
    value,
    valueOffset: braceStart + 1,
    condition,
    offset: braceStart,
    endOffset: close + 1,
  };
  return { segment, next: close + 1 };
}

/** 找插值里的顶层 `?` 与其后的 `:`（跳过 `"…"`、`()`、`[]`） */
function findConditional(
  source: string,
  from: number,
  to: number,
): { readonly q: number; readonly colon: number } | null {
  let depth = 0;
  let q = -1;
  for (let i = from; i < to; i++) {
    const c = source.charCodeAt(i);
    if (c === C_QUOTE_D) {
      i = skipQuotedInRange(source, i, to) - 1;
      continue;
    }
    if (c === C_OPEN_PAREN || c === C_OPEN_BRACKET) depth++;
    else if (c === C_CLOSE_PAREN || c === C_CLOSE_BRACKET) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      if (c === C_QUESTION) {
        if (q < 0) q = i;
      } else if (c === C_COLON && q >= 0) {
        return { q, colon: i };
      }
    }
  }
  return q >= 0 ? { q, colon: -1 } : null;
}

/* ============================== 词切分 ============================== */

/** 词结束位置：空白 / `(` / `)` / `,` / `:` / `：` / 全角括号 */
function scanWordEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (
      isSpaceCode(c) ||
      c === C_OPEN_PAREN ||
      c === C_CLOSE_PAREN ||
      c === C_COMMA ||
      c === C_COLON ||
      c === C_COLON_FW ||
      c === C_OPEN_PAREN_FW ||
      c === C_CLOSE_PAREN_FW
    ) {
      break;
    }
    i++;
  }
  return i;
}
