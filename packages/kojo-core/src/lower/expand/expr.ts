/**
 * 编译期展开用的表达式/文本改写工具（**不解析表达式语法**，只做保守的标识符替换）。
 *
 * 为什么不做表达式解析：core 不重复实现表达式词法/语法（§15.2）；表引用/模板参数
 * 替换只需在"名字位置"替换标识符——字符串字面量与注释里的同名文本不能动，这个扫描器
 * 只做这一件事，且对认不出的形态保持原样（宁可不替换也不改坏）。
 */
import type { KojoExprText, KojoTextPart } from '../../ast.js';

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/** 标识符扫描结果：`text` 已替换；`used` = 实际命中的名字（去重、按出现顺序） */
export interface IdentifierRewrite {
  readonly text: string;
  readonly changed: boolean;
  readonly used: readonly string[];
}

/** 名字位置的判定上下文：前一个字符 / 后一个字符（`(` = 调用位、`.` = 属性位，表引用要排除） */
export interface NameNeighbors {
  readonly before: string;
  readonly after: string;
}

/**
 * 扫描 `text` 的"名字位置"标识符（跳过 `"…"` 字符串内部），只收集不做替换。
 * 表引用/模板参数替换共用这一个扫描器，避免两份词法判据漂移。
 */
export function scanIdentifiers(text: string, accept: (name: string, neighbors: NameNeighbors) => boolean): readonly string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      while (i < text.length) {
        const inner = text[i]!;
        if (inner === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (inner === '"') break;
      }
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      i++;
      while (i < text.length && IDENT_PART.test(text[i]!)) i++;
      const name = text.slice(start, i);
      if (accept(name, { before: start > 0 ? text[start - 1]! : '', after: i < text.length ? text[i]! : '' }) && !found.includes(name)) {
        found.push(name);
      }
      continue;
    }
    i++;
  }
  return found;
}

/**
 * 把 `text` 里"名字位置"的标识符按 `lookup` 替换。
 *
 * 只跳过 `"…"` 字符串内部（含 `\\` 转义）；`@` 前缀逐字串同口径。
 * 不认 `'…'`（ERB 单引号串不出现在 Kojo 表达式里）。
 */
export function replaceIdentifiers(
  text: string,
  lookup: (name: string, neighbors: NameNeighbors) => string | undefined,
): IdentifierRewrite {
  let out = '';
  let used: string[] | null = null;
  let changed = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // 字符串字面量原样跳过
      const start = i;
      i++;
      while (i < text.length) {
        const inner = text[i]!;
        if (inner === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (inner === '"') break;
      }
      out += text.slice(start, i);
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      i++;
      while (i < text.length && IDENT_PART.test(text[i]!)) i++;
      const name = text.slice(start, i);
      const replacement = lookup(name, { before: start > 0 ? text[start - 1]! : '', after: i < text.length ? text[i]! : '' });
      if (replacement !== undefined && replacement !== name) {
        out += replacement;
        changed = true;
        if (used === null) used = [];
        if (!used.includes(name)) used.push(name);
      } else {
        out += name;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return { text: changed ? out : text, changed, used: used ?? [] };
}

/** 改写一个表达式源切片（span 不变：它仍是同一段作者源码） */
export function rewriteExpr(
  expr: KojoExprText,
  lookup: (name: string, neighbors: NameNeighbors) => string | undefined,
): IdentifierRewrite & { expr: KojoExprText } {
  const rewrite = replaceIdentifiers(expr.text, lookup);
  return {
    ...rewrite,
    expr: rewrite.changed ? { text: rewrite.text, span: expr.span } : expr,
  };
}

/** 文本片段里只改写 `{…}` 插值的表达式（纯文本段一个字都不动） */
export function rewriteTextParts(
  parts: readonly KojoTextPart[],
  lookup: (name: string, neighbors: NameNeighbors) => string | undefined,
): { readonly parts: readonly KojoTextPart[]; readonly used: readonly string[] } {
  let changed = false;
  const used: string[] = [];
  const next = parts.map((part): KojoTextPart => {
    if (part.kind === 'text') return part;
    const expr = rewriteExpr(part.expr, lookup);
    if (part.cond !== undefined) {
      const cond = rewriteExpr(part.cond.cond, lookup);
      const then = rewriteExpr(part.cond.then, lookup);
      const els = rewriteExpr(part.cond.else, lookup);
      for (const r of [expr, cond, then, els]) for (const name of r.used) if (!used.includes(name)) used.push(name);
      if (!expr.changed && !cond.changed && !then.changed && !els.changed) return part;
      changed = true;
      return { kind: 'interp', expr: expr.expr, cond: { cond: cond.expr, then: then.expr, else: els.expr } };
    }
    for (const name of expr.used) if (!used.includes(name)) used.push(name);
    if (!expr.changed) return part;
    changed = true;
    return { kind: 'interp', expr: expr.expr };
  });
  return { parts: changed ? next : parts, used };
}

/** 整数/字符串字面量 → 表达式源切片（表值落隐藏槽用） */
export function literalToExpr(value: number | string, span: KojoExprText['span']): KojoExprText {
  const text = typeof value === 'number' ? String(value) : quoteKojoString(value);
  return { text, span };
}

/** Kojo 字符串字面量（双引号；`\` `"` `{` `}` 都要转义；表值不做插值，故花括号必须转义） */
export function quoteKojoString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '{':
        out += '\\{';
        break;
      case '}':
        out += '\\}';
        break;
      default:
        out += ch;
        break;
    }
  }
  return `${out}"`;
}

/** 表达式的文本是否恰好是一个标识符（模板参数替换的"整段值"判据） */
export function isBareIdentifier(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (!IDENT_START.test(trimmed[0]!)) return false;
  for (let i = 1; i < trimmed.length; i++) if (!IDENT_PART.test(trimmed[i]!)) return false;
  return true;
}
