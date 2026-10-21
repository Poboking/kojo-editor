/**
 * 表达式词法：把 core 的表达式源切片切成 token 流。
 *
 * 语义真源：仓内 v1 表达式管线（`condition-extractor/src/expr.ts::tokenize`）。
 * 本文件是它在 core 的**结构性复刻**——不 import 插件（core 零插件依赖），
 * 但逐条保留它的判据：标识符首字符（字母 / 下划线 / 任意非 ASCII）、
 * 数字四形态（十进制 / `0x` / `0b` / `p` 二进制指数 / `e` 十进制指数）、
 * 普通串的反斜杠转义、逐字串 `@"…"` 的插值感知扫描、`[[词]]`、OP2 优先的最大吞噬。
 *
 * 有意的三处偏离（都在 `docs/BOARD.md` 的 K2-EXPR-AST 回执里报备）：
 * - `U+FEFF` 按空白跳过（v1 会当作未识别字符；BOM 边界不该炸表达式）；
 * - 标识符不吃空白（v1 的 `\u0080-\uffff` 会把全角空格吞进名字）；
 * - 畸形数字（`0x` / `0b` / `1.5e-2` 非整数）报 `expr/lex/bad-number`，
 *   不产 `NaN` 字面量（v1 静默接受 `NaN`）。
 *
 * 失败一律 `{ ok: false, error }`，不抛。
 */
import type { ExprFailure } from './ast.js';
import { exprError } from './ast.js';

export type ExprTokenKind =
  | 'int'
  | 'string'
  | 'verbatim-string'
  | 'nameValue'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'lbrace'
  | 'rbrace'
  | 'comma'
  | 'colon'
  | 'dot'
  | 'eof';

interface ExprTokenBase {
  /** 原文（`eof` 为空串；`string` / `verbatim-string` 含引号） */
  readonly text: string;
  /** 切片内 0 基起点 */
  readonly start: number;
  /** 切片内 0 基终点（不含） */
  readonly end: number;
}

export interface ExprIntToken extends ExprTokenBase {
  readonly kind: 'int';
  readonly value: number;
}

export interface ExprStringToken extends ExprTokenBase {
  readonly kind: 'string' | 'verbatim-string';
  /** 普通串 = 反转义后内容；逐字串 = 引号之间原文 */
  readonly value: string;
}

export interface ExprNameValueToken extends ExprTokenBase {
  readonly kind: 'nameValue';
  /** `[[ ]]` 内 trim 后的词 */
  readonly value: string;
}

export interface ExprPunctToken extends ExprTokenBase {
  readonly kind: Exclude<ExprTokenKind, 'int' | 'string' | 'verbatim-string' | 'nameValue'>;
}

export type ExprToken = ExprIntToken | ExprStringToken | ExprNameValueToken | ExprPunctToken;

export interface ExprTokenizeSuccess {
  readonly ok: true;
  /** 末尾恒有一枚 `eof`（`start === end === source.length`） */
  readonly tokens: readonly ExprToken[];
}

export type ExprTokenizeResult = ExprTokenizeSuccess | ExprFailure;

/* ============================== 字符判据 ============================== */

/** 标识符首字符：字母 / 下划线 / 任意非 ASCII（日文变量名与具名索引）；空白不算 */
function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && !isSpace(c) && /[A-Za-z_\u0080-\uffff]/.test(c);
}

/** 标识符后续：首字符集合 + 数字（同样排除空白） */
function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && !isSpace(c) && /[A-Za-z0-9_\u0080-\uffff]/.test(c);
}

/** 空白：半角空格 / Tab / 全角空格 U+3000 / NBSP / BOM（BOM 是本层唯一新增） */
function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\u3000' || c === '\u00a0' || c === '\ufeff';
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isHexDigit(c: string | undefined): boolean {
  return c !== undefined && /[0-9a-fA-F]/.test(c);
}

const OP2: readonly string[] = ['&&', '||', '^^', '!&', '!|', '==', '!=', '<=', '>=', '<<', '>>', '++', '--'];
const OP1: ReadonlySet<string> = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?', '#']);

/** 64 位有符号上界（2^63；`p` 指数越界时回退成"不认 p"，与 v1 同口径） */
const INT64_LIMIT = 9223372036854775808;

/* ============================== 扫描助手 ============================== */

/** 二进制指数段（`1p3` = 1×2³）终点；不构成指数就原样返回 `from` */
function scanBinaryExponent(source: string, from: number): number {
  const c = source[from];
  if (c !== 'p' && c !== 'P') return from;
  if (!isDigit(source[from + 1])) return from;
  let k = from + 1;
  while (isDigit(source[k])) k++;
  return k;
}

/**
 * 十进制指数段（`2e3` / `1.5e-2`）终点；小数部分**只在确认后面跟着指数时**才吞。
 * 返回 `from` 表示不构成指数，调用方从原位置继续（裸 `12.5` 仍是词法错）。
 */
function scanDecimalExponent(source: string, from: number): number {
  let j = from;
  if (source[j] === '.' && isDigit(source[j + 1])) {
    j++;
    while (isDigit(source[j])) j++;
  }
  if (source[j] !== 'e' && source[j] !== 'E') return from;
  let k = j + 1;
  if (source[k] === '+' || source[k] === '-') k++;
  if (!isDigit(source[k])) return from;
  while (isDigit(source[k])) k++;
  return k;
}

/** 普通串 `"…"` 的结束位置（闭合引号之后；找不到 -1）。`\` 转义一个字符 */
function scanQuotedEnd(source: string, from: number): number {
  let i = from + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '"') return i + 1;
    i++;
  }
  return -1;
}

/** `%…%` 插值段终点（闭合 `%` 之后；找不到 -1） */
function scanPercentEnd(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '%') return i + 1;
    if (ch === '"') {
      i = scanQuotedEnd(source, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '@' && source[i + 1] === '"') {
      i = scanVerbatimEnd(source, i + 2);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/** `{…}` 插值段终点（闭合 `}` 之后；找不到 -1） */
function scanCurlyEnd(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '}') return i + 1;
    if (ch === '"') {
      i = scanQuotedEnd(source, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '@' && source[i + 1] === '"') {
      i = scanVerbatimEnd(source, i + 2);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * 逐字串 `@"…"` 终点（闭合引号之后；找不到 -1）。
 * `%…%` / `{…}` 插值里的引号属于内层表达式，不关闭外层串。
 */
function scanVerbatimEnd(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"') return i + 1;
    if (ch === '%') {
      i = scanPercentEnd(source, i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '{') {
      i = scanCurlyEnd(source, i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/** 旧单层口径（`@"` 后下一枚引号即结束）；插值感知扫描失败时兜底 */
function scanVerbatimEndSimple(source: string, from: number): number {
  const at = source.indexOf('"', from);
  return at < 0 ? -1 : at + 1;
}

/* ============================== 数字 / 串 ============================== */

type NumberScan = { readonly ok: true; readonly token: ExprIntToken; readonly next: number } | ExprFailure;

/**
 * 读一个整数字面量。
 * `p` 指数越界时**不消费 p**（退化成整数 + 标识符，上层按语法错收口），与 v1 一致；
 * 非整数结果（`1.5e-2`）报错，不产 `NaN` / 小数。
 */
function readNumber(source: string, start: number): NumberScan {
  let i = start;
  let base = 10;
  if (source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
    base = 16;
    i += 2;
    const digitsStart = i;
    while (isHexDigit(source[i])) i++;
    if (i === digitsStart) {
      return { ok: false, error: exprError('expr/lex/bad-number', '十六进制字面量缺少数字', start) };
    }
  } else if (source[i] === '0' && (source[i + 1] === 'b' || source[i + 1] === 'B')) {
    base = 2;
    i += 2;
    const digitsStart = i;
    while (source[i] === '0' || source[i] === '1') i++;
    if (i === digitsStart) {
      return { ok: false, error: exprError('expr/lex/bad-number', '二进制字面量缺少数字', start) };
    }
  } else {
    while (isDigit(source[i])) i++;
    const pEnd = scanBinaryExponent(source, i);
    if (pEnd !== i) {
      const significand = Number.parseInt(source.slice(start, i), 10);
      const exponent = Number.parseInt(source.slice(i + 1, pEnd), 10);
      const value = significand * Math.pow(2, exponent);
      // 引擎同口径：超出 64 位有符号整数范围就回退旧口径（不认 p），不在这里造超大值
      if (Number.isFinite(value) && value < INT64_LIMIT && value >= -INT64_LIMIT) {
        const text = source.slice(start, pEnd);
        return { ok: true, token: { kind: 'int', text, start, end: pEnd, value }, next: pEnd };
      }
    }
    i = scanDecimalExponent(source, i);
  }

  const text = source.slice(start, i);
  const value =
    base !== 10
      ? Number.parseInt(text.slice(2), base)
      : /[eE]/.test(text)
        ? Number(text)
        : Number.parseInt(text, 10);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      ok: false,
      error: exprError('expr/lex/bad-number', `数字字面量“${text}”不是 64 位整数可表达的值`, start),
    };
  }
  return { ok: true, token: { kind: 'int', text, start, end: i, value }, next: i };
}

type PlainStringScan = { readonly ok: true; readonly token: ExprStringToken; readonly next: number } | ExprFailure;

/** 普通串 `"…"`：`\` 吃掉一个字符后原样追加（引擎 ReadString 的 default 分支口径） */
function readPlainString(source: string, start: number): PlainStringScan {
  let i = start + 1;
  let decoded = '';
  let closed = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\' && i + 1 < source.length) {
      decoded += source[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '"') {
      closed = true;
      i++;
      break;
    }
    decoded += ch;
    i++;
  }
  if (!closed) {
    return { ok: false, error: exprError('expr/lex/unterminated-string', '字符串的引号没有闭合', start) };
  }
  return { ok: true, token: { kind: 'string', text: source.slice(start, i), start, end: i, value: decoded }, next: i };
}

/** 逐字串 `@"…"`：插值感知扫描失败时回退"下一枚引号即结束" */
function readVerbatimString(source: string, start: number): PlainStringScan {
  let end = scanVerbatimEnd(source, start + 2);
  if (end < 0) end = scanVerbatimEndSimple(source, start + 2);
  if (end < 0) {
    return { ok: false, error: exprError('expr/lex/unterminated-string', '逐字字符串的引号没有闭合', start) };
  }
  return {
    ok: true,
    token: { kind: 'verbatim-string', text: source.slice(start, end), start, end, value: source.slice(start + 2, end - 1) },
    next: end,
  };
}

/* ============================== 主循环 ============================== */

/** 单字符标点 token（`(` `)` `[` `]` `{` `}` `,` `:` `.`） */
function punctToken(kind: ExprPunctToken['kind'], c: string, start: number): ExprPunctToken {
  return { kind, text: c, start, end: start + 1 };
}

/** 词法入口：成功返回含 `eof` 的 token 流；失败返回可判别错误，不抛 */
export function tokenizeExpr(source: string): ExprTokenizeResult {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const start = i;
    if (isSpace(c)) {
      i++;
      continue;
    }
    // `[[词]]`：读取期重命名占位（编辑器保留原文）
    if (c === '[' && source[i + 1] === '[') {
      const close = source.indexOf(']]', i + 2);
      if (close < 0) {
        return { ok: false, error: exprError('expr/lex/unterminated-name', '符号“[[”没有闭合（缺少“]]”）', start) };
      }
      tokens.push({
        kind: 'nameValue',
        text: source.slice(i, close + 2),
        start,
        end: close + 2,
        value: source.slice(i + 2, close).trim(),
      });
      i = close + 2;
      continue;
    }
    if (isDigit(c)) {
      const scanned = readNumber(source, start);
      if (!scanned.ok) return scanned;
      tokens.push(scanned.token);
      i = scanned.next;
      continue;
    }
    if (c === '@' && source[i + 1] === '"') {
      const scanned = readVerbatimString(source, start);
      if (!scanned.ok) return scanned;
      tokens.push(scanned.token);
      i = scanned.next;
      continue;
    }
    if (c === '"') {
      const scanned = readPlainString(source, start);
      if (!scanned.ok) return scanned;
      tokens.push(scanned.token);
      i = scanned.next;
      continue;
    }
    if (isIdentStart(c)) {
      i++;
      while (isIdentPart(source[i])) i++;
      tokens.push({ kind: 'ident', text: source.slice(start, i), start, end: i });
      continue;
    }
    switch (c) {
      case '(':
      case ')':
      case '[':
      case ']':
      case '{':
      case '}':
      case ',':
      case ':':
      case '.':
        tokens.push(
          punctToken(
            c === '('
              ? 'lparen'
              : c === ')'
                ? 'rparen'
                : c === '['
                  ? 'lbracket'
                  : c === ']'
                    ? 'rbracket'
                    : c === '{'
                      ? 'lbrace'
                      : c === '}'
                        ? 'rbrace'
                        : c === ','
                          ? 'comma'
                          : c === ':'
                            ? 'colon'
                            : 'dot',
            c,
            start,
          ),
        );
        i++;
        continue;
      default:
        break;
    }
    const two = source.slice(i, i + 2);
    if (OP2.includes(two)) {
      tokens.push({ kind: 'op', text: two, start, end: start + 2 });
      i += 2;
      continue;
    }
    if (OP1.has(c)) {
      tokens.push({ kind: 'op', text: c, start, end: start + 1 });
      i++;
      continue;
    }
    return {
      ok: false,
      error: exprError('expr/lex/unexpected-char', `有无法识别的字符“${c}”`, i),
    };
  }
  tokens.push({ kind: 'eof', text: '', start: source.length, end: source.length });
  return { ok: true, tokens };
}

/** token 在切片内的 1 基列区间（半开），供建 AST span 用 */
export function tokenSpan(token: ExprToken): { readonly start: number; readonly end: number } {
  return { start: token.start + 1, end: token.end + 1 };
}
