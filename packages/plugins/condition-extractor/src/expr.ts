/**
 * ERB 表达式子集解析器（游戏无关；本插件私有）。
 *
 * 输入：条件原文（如 `CFLAG:2 >= 500 && TALENT:恋慕`）；
 * 输出：`ConditionExpr` AST；无法完整解析时**整体降级为 opaque**（绝不抛错）。
 *
 * 语法依据（引擎源码核验，见逆向文档《eratw4.980-词法与表达式.md》§11）：
 * 运算符优先级（高→低）：`* / %`(90) → `+ -`(80，含单目) → `<< >>`(70) →
 * `> < >= <=`(65) → `== !=`(60) → `& | ^`(50) → `&& || ^^ !& !|`(40) → 三元 `? :`。
 *
 * 刻意不做（本阶段）：赋值系（`=`/`+=`，条件里不出现）、`#` 三元变体、
 * 字符字面量 `'x'`、宏展开——遇到即整体 opaque（保留原文，不猜测）。
 */

import type { ConditionExpr } from '@kojo/plugin-api';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'colon' | 'name' | 'eof';

interface Token {
  kind: TokenKind;
  /** 原文（num 为数字文本；str 为**含引号**的原文；op 为符号；name 为含 `[[ ]]` 的原文） */
  text: string;
  /** num → number；str → 解码后内容；name → 括号内词（trim 后） */
  value?: number | string;
  /** 在输入中的起点（括号索引段原文重建用） */
  pos: number;
}

class ExprSyntaxError extends Error {}

/** 标识符首字符：字母 / 下划线 / 任意非 ASCII（日文变量名与具名索引） */
function isIdentStart(c: string): boolean {
  return /[A-Za-z_\u0080-\uffff]/.test(c);
}
/** 标识符后续：首字符集合 + 数字 */
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_\u0080-\uffff]/.test(c);
}
/** 空白（含全角空格 U+3000） */
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\u3000' || c === '\u00a0';
}

const OP2 = ['&&', '||', '^^', '!&', '!|', '==', '!=', '<=', '>=', '<<', '>>'];
const OP1 = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?']);

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    const start = i;
    if (isSpace(c)) {
      i++;
      continue;
    }
    // rename 语法 [[词]]（引擎读取期按 _Rename.csv 替换；编辑器保留原文）
    if (c === '[' && input[i + 1] === '[') {
      const close = input.indexOf(']]', i + 2);
      if (close < 0) throw new ExprSyntaxError(`unterminated [[ at ${i}`);
      out.push({ kind: 'name', text: input.slice(i, close + 2), value: input.slice(i + 2, close).trim(), pos: start });
      i = close + 2;
      continue;
    }
    // 数字：十进制 / 0x 十六进制（引擎支持 AddIntegerLiteral；0b 未见于语料，保守不认）
    if (c >= '0' && c <= '9') {
      if (c === '0' && (input[i + 1] === 'x' || input[i + 1] === 'X')) {
        i += 2;
        while (i < input.length && /[0-9a-fA-F]/.test(input[i]!)) i++;
      } else {
        while (i < input.length && input[i]! >= '0' && input[i]! <= '9') i++;
      }
      const text = input.slice(start, i);
      const value = text.length > 2 && text[0] === '0' && (text[1] === 'x' || text[1] === 'X')
        ? Number.parseInt(text.slice(2), 16)
        : Number.parseInt(text, 10);
      out.push({ kind: 'num', text, value, pos: start });
      continue;
    }
    // 字符串（`\` 转义一个字符）
    if (c === '"') {
      i++;
      let decoded = '';
      let closed = false;
      while (i < input.length) {
        const ch = input[i]!;
        if (ch === '\\' && i + 1 < input.length) {
          decoded += input[i + 1]!;
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
      if (!closed) throw new ExprSyntaxError(`unterminated string at ${start}`);
      out.push({ kind: 'str', text: input.slice(start, i), value: decoded, pos: start });
      continue;
    }
    if (isIdentStart(c)) {
      i++;
      while (i < input.length && isIdentPart(input[i]!)) i++;
      out.push({ kind: 'ident', text: input.slice(start, i), pos: start });
      continue;
    }
    if (c === '(') {
      out.push({ kind: 'lparen', text: c, pos: start });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ kind: 'rparen', text: c, pos: start });
      i++;
      continue;
    }
    if (c === ',') {
      out.push({ kind: 'comma', text: c, pos: start });
      i++;
      continue;
    }
    if (c === ':') {
      out.push({ kind: 'colon', text: c, pos: start });
      i++;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (OP2.includes(two)) {
      out.push({ kind: 'op', text: two, pos: start });
      i += 2;
      continue;
    }
    if (OP1.has(c)) {
      out.push({ kind: 'op', text: c, pos: start });
      i++;
      continue;
    }
    throw new ExprSyntaxError(`unexpected char '${c}' at ${i}`);
  }
  out.push({ kind: 'eof', text: '', pos: input.length });
  return out;
}

// ---------------------------------------------------------------------------
// Parser（Pratt / 优先级爬升）
// ---------------------------------------------------------------------------

/** 二元运算符优先级（引擎 OperatorCode.cs 权威值） */
const BINARY_PREC: Readonly<Record<string, number>> = {
  '*': 90,
  '/': 90,
  '%': 90,
  '+': 80,
  '-': 80,
  '<<': 70,
  '>>': 70,
  '>': 65,
  '<': 65,
  '>=': 65,
  '<=': 65,
  '==': 60,
  '!=': 60,
  '&': 50,
  '|': 50,
  '^': 50,
  '&&': 40,
  '||': 40,
  '^^': 40,
  '!&': 40,
  '!|': 40,
};

const UNARY_OPS = new Set(['!', '-', '+', '~']);

class Parser {
  private i = 0;
  constructor(private readonly input: string, private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.i]!;
  }

  private next(): Token {
    const t = this.toks[this.i]!;
    if (t.kind !== 'eof') this.i++;
    return t;
  }

  /** 消费一个平衡括号组并返回**原文切片**（如索引段 `(GET_CHARAHOME(TARGET))`） */
  private consumeBracketText(): string {
    const openTok = this.next(); // lparen
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.kind === 'eof') throw new ExprSyntaxError('unbalanced (');
      if (t.kind === 'lparen') depth++;
      else if (t.kind === 'rparen') {
        depth--;
        if (depth === 0) return this.input.slice(openTok.pos, t.pos + 1);
      }
    }
  }

  atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  parseExpr(minPrec: number): ConditionExpr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      // 三元：`cond ? then : else`（优先级 5，右结合）
      if (t.kind === 'op' && t.text === '?') {
        if (5 < minPrec) break;
        this.next();
        const thenE = this.parseExpr(0);
        const colon = this.next();
        if (colon.kind !== 'colon') throw new ExprSyntaxError('expected : in ternary');
        const elseE = this.parseExpr(0);
        left = { kind: 'ternary', cond: left, then: thenE, else: elseE };
        continue;
      }
      if (t.kind !== 'op') break;
      const prec = BINARY_PREC[t.text];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1); // 左结合
      left = { kind: 'binary', op: t.text, left, right };
    }
    return left;
  }

  private parseUnary(): ConditionExpr {
    const t = this.peek();
    if (t.kind === 'op' && UNARY_OPS.has(t.text)) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', op: t.text, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ConditionExpr {
    const t = this.next();
    if (t.kind === 'num') return { kind: 'literal', value: t.value as number, text: t.text };
    if (t.kind === 'str') return { kind: 'literal', value: t.value as string, text: t.text };
    if (t.kind === 'lparen') {
      const inner = this.parseExpr(0);
      const close = this.next();
      if (close.kind !== 'rparen') throw new ExprSyntaxError('expected )');
      return inner;
    }
    if (t.kind === 'ident') {
      // 函数调用：`NAME(...)` —— 名字后紧跟 `(`（真实语料无带空格的调用）
      if (this.peek().kind === 'lparen') {
        this.next();
        const args: ConditionExpr[] = [];
        if (this.peek().kind !== 'rparen') {
          for (;;) {
            args.push(this.parseExpr(0));
            if (this.peek().kind === 'comma') {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.next();
        if (close.kind !== 'rparen') throw new ExprSyntaxError('expected ) in call');
        return { kind: 'call', name: t.text.toUpperCase(), args };
      }
      // 变量引用：`NAME` / `NAME:段` / `NAME:段:段`
      // 段 = 数字 / 标识符 / 字符串 / [[词]]（rename 语法）/ (括号表达式原文)
      const indices: string[] = [];
      while (this.peek().kind === 'colon') {
        this.next();
        const seg = this.peek();
        if (seg.kind === 'num' || seg.kind === 'ident') {
          indices.push(seg.text);
          this.next();
        } else if (seg.kind === 'str') {
          indices.push(String(seg.value));
          this.next();
        } else if (seg.kind === 'name') {
          indices.push(seg.text);
          this.next();
        } else if (seg.kind === 'lparen') {
          indices.push(this.consumeBracketText());
        } else {
          throw new ExprSyntaxError('bad index segment');
        }
      }
      const text = indices.length > 0 ? `${t.text}:${indices.join(':')}` : t.text;
      return { kind: 'ref', name: t.text.toUpperCase(), indices, text };
    }
    if (t.kind === 'name') return { kind: 'nameValue', name: String(t.value ?? ''), text: t.text };
    throw new ExprSyntaxError(`unexpected token '${t.text}'`);
  }
}

/** 解析表达式（失败 → `opaque` 整体降级） */
export function parseExpression(text: string): ConditionExpr {
  try {
    const toks = tokenize(text);
    const p = new Parser(text, toks);
    const expr = p.parseExpr(0);
    if (!p.atEnd()) throw new ExprSyntaxError('trailing tokens');
    return expr;
  } catch {
    return { kind: 'opaque', text };
  }
}

/** 括号内是否有顶层逗号切分（CASE 值列表用；引号/括号感知） */
export function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) {
        cur += s[i + 1]!;
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 深度优先遍历表达式节点 */
export function walkExpr(expr: ConditionExpr, visit: (node: ConditionExpr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case 'unary':
      walkExpr(expr.operand, visit);
      break;
    case 'binary':
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      break;
    case 'ternary':
      walkExpr(expr.cond, visit);
      walkExpr(expr.then, visit);
      walkExpr(expr.else, visit);
      break;
    case 'call':
      for (const a of expr.args) walkExpr(a, visit);
      break;
    default:
      break;
  }
}
