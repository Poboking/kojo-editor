/**
 * 表达式语法：token 流 → `KojoExpr` AST（Pratt / 优先级爬升）。
 *
 * 优先级与结合性**逐值照抄仓内 v1 表达式管线**（`condition-extractor/src/expr.ts`
 * 的 `BINARY_PREC`，注释注明取自引擎 `OperatorCode.cs`）：`* / %`(90) → `+ -`(80)
 * → `<< >>`(70) → `> < >= <=`(65) → `== !=`(60) → `& | ^`(50)
 * → `&& || ^^ !& !|`(40) → 三元 `? :`（最松、右结合）；二元一律左结合。
 * 不在 core 发明第二套优先级。
 *
 * 语法面（v1 超集）：
 * - 字面量：整数 / 普通串 / 逐字串 / `[[词]]`；标识符；
 * - 后缀链：`(实参…)` 调用、`[表达式]` 下标、`.名字` 成员、`:段`（ERB 形态下标）、
 *   `++` / `--`；前缀：`! - + ~ ++ --`；
 * - 三元 `c ? a : b`（v1 的 `c ? a # b` 同义）；
 * - 整条表达式被 `{…}` 包住时解壳（插值切片 `{恋慕 >= 500 ? "A" : "B"}`）；
 * - 顶层行尾逗号容忍（`FLAG:1,`，引擎 `ReduceArguments(EoL)` 口径）；
 * - 空切片 / 纯空白 / `{}` = 合法 `empty` 节点。
 *
 * 唯一新增的歧义裁决（v1 没有三元 + 冒号下标的冲突处理）：
 * **then 分支里的 `:` 一律先按三元分隔符解**，故 `A ? B : C` 是三元；要表达
 * then 分支里的冒号下标必须加括号（`A ? (FLAG:1) : C`）。else 分支不受影响
 * （`A ? B : FLAG:1` 仍是 ref）。括号 / 实参 / 方括号内部重新允许冒号下标。
 *
 * 失败一律 `{ ok: false, error: { code, message, offset } }`；内部用私有异常控制流，
 * 出口统一捕获，**绝不向调用方抛**，也不返回半成品 AST。
 */
import type { ExprCall, ExprError, ExprFailure, ExprIndex, KojoExpr } from './ast.js';
import { EMPTY_EXPR_SPAN, exprError } from './ast.js';
import type { ExprToken } from './tokenize.js';
import { tokenizeExpr, tokenSpan } from './tokenize.js';

/** 三元优先级（引擎最低档；只用于"是否进三元分支"的判据） */
export const EXPR_TERNARY_PRECEDENCE = 5;

/** 二元运算符优先级（**唯一真源**；打印器的加括号判据也从这里取） */
export const EXPR_BINARY_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
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
});

/** 可作前缀的一元运算符（含自增自减；`++LOCAL:1` 真实语料里作左值表达） */
export const EXPR_PREFIX_OPERATORS: ReadonlySet<string> = new Set(['!', '-', '+', '~', '++', '--']);

/** 可作后缀的一元运算符 */
export const EXPR_POSTFIX_OPERATORS: ReadonlySet<string> = new Set(['++', '--']);

export interface ExprParseSuccess {
  readonly ok: true;
  readonly node: KojoExpr;
}

export type ExprParseResult = ExprParseSuccess | ExprFailure;

/** 内部语法错（携带可判别错误；出口统一转成 `{ ok: false }`） */
class ParseAbort extends Error {
  readonly error: ExprError;

  constructor(error: ExprError) {
    super(error.message);
    this.name = 'ParseAbort';
    this.error = error;
  }
}

function abort(code: ExprError['code'], message: string, offset: number): ParseAbort {
  return new ParseAbort(exprError(code, message, offset));
}

/** 把"不该出现的 token"翻译成面向作者的诊断语 */
function describeUnexpected(token: ExprToken): string {
  switch (token.kind) {
    case 'eof':
      return '表达式不完整，缺少一个操作数';
    case 'rparen':
      return '多了一个右括号';
    case 'rbracket':
      return '多了一个右方括号';
    case 'rbrace':
      return '多了一个右花括号';
    case 'lbrace':
      return '左花括号只能包住整条表达式';
    case 'comma':
      return '这里多了一个逗号';
    case 'colon':
      return '这里多了一个冒号';
    case 'dot':
      return '成员访问的点前面缺少一个对象';
    case 'op':
      return `运算符“${token.text}”前面缺少一个操作数`;
    default:
      return `这里多了一个不该出现的“${token.text}”`;
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly ExprToken[]) {}

  private peek(): ExprToken {
    return this.tokens[Math.min(this.index, this.tokens.length - 1)]!;
  }

  private next(): ExprToken {
    const token = this.peek();
    if (token.kind !== 'eof') this.index++;
    return token;
  }

  /** 顶层：解 `{…}` 壳、容忍行尾逗号、空输入 */
  parseTop(): KojoExpr {
    const first = this.peek();
    if (first.kind === 'lbrace') {
      this.next();
      if (this.peek().kind === 'rbrace') {
        this.next();
        this.finish();
        return { kind: 'empty', span: { start: first.end + 1, end: first.end + 1 } };
      }
      const inner = this.parseExpression(0);
      const close = this.next();
      if (close.kind !== 'rbrace') {
        throw abort('expr/syntax/unclosed-brace', '花括号没有配对（缺少右花括号）', close.start);
      }
      this.finish();
      return inner;
    }
    const node = this.parseExpression(0);
    this.finish();
    return node;
  }

  /** 收尾：行尾逗号静默吞掉（`FLAG:1,`），其余多余 token 一律语法错 */
  private finish(): void {
    while (this.peek().kind === 'comma') this.next();
    const rest = this.peek();
    if (rest.kind !== 'eof') {
      throw abort('expr/syntax/trailing', `表达式结尾多出“${rest.text}”`, rest.start);
    }
  }

  private parseExpression(minPrecedence: number, breakBeforeColon = false): KojoExpr {
    let left = this.parseUnary(breakBeforeColon);
    for (;;) {
      const token = this.peek();
      // 三元：`cond ? then : else` / `cond ? then # else`（优先级 5，右结合）
      if (token.kind === 'op' && token.text === '?') {
        if (EXPR_TERNARY_PRECEDENCE < minPrecedence) break;
        this.next();
        // then 分支里 `:` 是分隔符，不是 v1 ref 的冒号下标（`A ? B : C` 的歧义按三元解）
        const thenExpr = this.parseExpression(0, true);
        const separator = this.next();
        if (!(separator.kind === 'colon' || (separator.kind === 'op' && separator.text === '#'))) {
          throw abort(
            'expr/syntax/missing-ternary-separator',
            '三元表达式缺少中间的分隔符（“:”或“#”）',
            separator.start,
          );
        }
        const elseExpr = this.parseExpression(0);
        left = {
          kind: 'ternary',
          cond: left,
          then: thenExpr,
          else: elseExpr,
          span: { start: left.span.start, end: elseExpr.span.end },
        };
        continue;
      }
      if (token.kind !== 'op') break;
      const precedence = EXPR_BINARY_PRECEDENCE[token.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const rhsStart = this.peek();
      if (rhsStart.kind === 'op' && !EXPR_PREFIX_OPERATORS.has(rhsStart.text)) {
        throw abort('expr/syntax/missing-operand', `运算符“${token.text}”后面缺少一个操作数`, token.start);
      }
      const right = this.parseExpression(precedence + 1, breakBeforeColon); // 全部左结合
      left = {
        kind: 'binary',
        op: token.text,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
    }
    return left;
  }

  private parseUnary(breakBeforeColon: boolean): KojoExpr {
    const token = this.peek();
    if (token.kind === 'op' && EXPR_PREFIX_OPERATORS.has(token.text)) {
      this.next();
      const operandStart = this.peek();
      if (operandStart.kind === 'op' && !EXPR_PREFIX_OPERATORS.has(operandStart.text)) {
        throw abort('expr/syntax/missing-operand', `运算符“${token.text}”后面缺少一个操作数`, token.start);
      }
      const operand = this.parseUnary(breakBeforeColon);
      return {
        kind: 'unary',
        op: token.text,
        operand,
        position: 'prefix',
        span: { start: token.start + 1, end: operand.span.end },
      };
    }
    return this.parsePostfix(this.parsePrimary(), breakBeforeColon);
  }

  private parsePostfix(primary: KojoExpr, breakBeforeColon: boolean): KojoExpr {
    let expr = primary;
    for (;;) {
      const token = this.peek();
      if (token.kind === 'lparen') {
        const args = this.parseArgList();
        const call: ExprCall = {
          kind: 'call',
          callee: expr,
          args: args.args,
          span: { start: expr.span.start, end: args.close.end + 1 },
        };
        expr = call;
        continue;
      }
      if (token.kind === 'lbracket') {
        this.next();
        const inner = this.parseExpression(0);
        const close = this.next();
        if (close.kind !== 'rbracket') {
          throw abort('expr/syntax/unclosed-bracket', '方括号没有配对（缺少右方括号）', close.start);
        }
        const index: ExprIndex = {
          kind: 'index',
          object: expr,
          index: inner,
          style: 'bracket',
          span: { start: expr.span.start, end: close.end + 1 },
        };
        expr = index;
        continue;
      }
      if (token.kind === 'dot') {
        this.next();
        const name = this.next();
        if (name.kind !== 'ident') {
          throw abort('expr/syntax/member-name', '“.”后面必须是成员名字', name.start);
        }
        expr = {
          kind: 'member',
          object: expr,
          name: name.text,
          span: { start: expr.span.start, end: name.end + 1 },
        };
        continue;
      }
      // 冒号下标是 v1 ref 的形态：只接在标识符 / 已成型 ref 链后面（`NAME:段:段`）
      if (
        token.kind === 'colon' &&
        !breakBeforeColon &&
        (expr.kind === 'ident' || (expr.kind === 'index' && expr.style === 'colon'))
      ) {
        this.next();
        const segment = this.parseColonSegment();
        const index: ExprIndex = {
          kind: 'index',
          object: expr,
          index: segment,
          style: 'colon',
          span: { start: expr.span.start, end: segment.span.end },
        };
        expr = index;
        continue;
      }
      if (token.kind === 'op' && EXPR_POSTFIX_OPERATORS.has(token.text)) {
        this.next();
        expr = {
          kind: 'unary',
          op: token.text,
          operand: expr,
          position: 'postfix',
          span: { start: expr.span.start, end: token.end + 1 },
        };
        continue;
      }
      return expr;
    }
  }

  /** 实参列表：空槽与尾逗号一律跳过（`f(a, , , 1)` / `f(x,)`） */
  private parseArgList(): { readonly args: readonly KojoExpr[]; readonly close: ExprToken } {
    this.next(); // lparen
    const args: KojoExpr[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'comma') {
        this.next();
        continue;
      }
      if (token.kind === 'rparen') break;
      args.push(this.parseExpression(0));
      if (this.peek().kind === 'comma') {
        this.next();
        continue;
      }
      break;
    }
    const close = this.next();
    if (close.kind !== 'rparen') {
      throw abort('expr/syntax/unclosed-paren', '函数调用的圆括号没有配对（缺少右括号）', close.start);
    }
    return { args, close };
  }

  private parsePrimary(): KojoExpr {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: token.value, raw: token.text, span: tokenSpan(token) };
      case 'string':
      case 'verbatim-string':
        return {
          kind: 'string',
          value: token.value,
          form: token.kind === 'string' ? 'plain' : 'verbatim',
          raw: token.text,
          span: tokenSpan(token),
        };
      case 'nameValue':
        return { kind: 'nameValue', name: token.value, span: tokenSpan(token) };
      case 'ident':
        return { kind: 'ident', name: token.text, span: tokenSpan(token) };
      case 'lparen': {
        const inner = this.parseExpression(0);
        const close = this.next();
        if (close.kind !== 'rparen') {
          throw abort('expr/syntax/unclosed-paren', '圆括号没有配对（缺少右括号）', close.start);
        }
        return { kind: 'paren', inner, span: { start: token.start + 1, end: close.end + 1 } };
      }
      case 'eof':
        throw abort('expr/syntax/missing-operand', '表达式不完整，缺少一个操作数', token.start);
      case 'op':
        throw abort('expr/syntax/unexpected-token', describeUnexpected(token), token.start);
      default:
        throw abort('expr/syntax/unexpected-token', describeUnexpected(token), token.start);
    }
  }

  /**
   * 冒号后的段：数字 / 标识符（可接调用）/ 字符串 / `[[词]]` / `(括号表达式)`。
   * 与 v1 的 `parsePrimary` 冒号分支同口径；段本身是独立表达式节点，不是原文。
   */
  private parseColonSegment(): KojoExpr {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: token.value, raw: token.text, span: tokenSpan(token) };
      case 'string':
      case 'verbatim-string':
        return {
          kind: 'string',
          value: token.value,
          form: token.kind === 'string' ? 'plain' : 'verbatim',
          raw: token.text,
          span: tokenSpan(token),
        };
      case 'nameValue':
        return { kind: 'nameValue', name: token.value, span: tokenSpan(token) };
      case 'ident': {
        const ident: KojoExpr = { kind: 'ident', name: token.text, span: tokenSpan(token) };
        if (this.peek().kind === 'lparen') {
          const args = this.parseArgList();
          return {
            kind: 'call',
            callee: ident,
            args: args.args,
            span: { start: token.start + 1, end: args.close.end + 1 },
          };
        }
        return ident;
      }
      case 'lparen': {
        const inner = this.parseExpression(0);
        const close = this.next();
        if (close.kind !== 'rparen') {
          throw abort('expr/syntax/unclosed-paren', '圆括号没有配对（缺少右括号）', close.start);
        }
        return { kind: 'paren', inner, span: { start: token.start + 1, end: close.end + 1 } };
      }
      default:
        throw abort('expr/syntax/bad-index', '变量冒号后面的索引写法不对', token.start);
    }
  }
}

/**
 * 解析表达式源切片。
 *
 * 空串 / 纯空白 → `{ ok: true, node: empty }`（合法空表达式，不是错误）；
 * 其余失败 → `{ ok: false, error }`，`offset` 是切片内 0 基偏移。
 */
export function parseExpr(source: string): ExprParseResult {
  const lexed = tokenizeExpr(source);
  if (!lexed.ok) return lexed;
  if (lexed.tokens.length === 1) return { ok: true, node: { kind: 'empty', span: EMPTY_EXPR_SPAN } };
  try {
    return { ok: true, node: new Parser(lexed.tokens).parseTop() };
  } catch (error) {
    if (error instanceof ParseAbort) return { ok: false, error: error.error };
    // 契约兜底：任何非预期异常都收口成可判别失败，绝不外抛
    return { ok: false, error: exprError('expr/internal', '表达式解析遇到未预期错误', 0) };
  }
}
