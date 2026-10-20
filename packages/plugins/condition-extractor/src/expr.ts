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
 * 刻意不做（本阶段）：赋值系（`=`/`+=`，条件里不出现）、字符字面量 `'x'`、
 * 宏展开——遇到即整体 opaque（保留原文，不猜测）。
 *
 * 2026-10-19 真语料收口批（表达式波浪线 98% 误报的直面修）：
 * - `@"…"` 逐字串（`@` 起、下一枚引号止；`%…%` / `{…}` 插值里的引号不关闭外层串，
 *   例 `@"%TEXTS("…")%…"`；插值感知失败时回退旧单层口径）；
 * - 三元真形 `A ? B # C`（`#` 作 else 分隔；`:` 保留）；
 * - 实参空槽 / 尾逗号、下标接调用（`NAME:TOINT(x)`）、后缀 `++`/`--`；
 * - `0b` 二进制与十进制指数 `2e3` / `1.5e-2`（裸小数仍不认）；
 * - 行尾续写 fail-open（只作用于 `diagnoseExpression`，`parseExpression` 语义不变）。
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

/**
 * 解析 / 词法失败时内部抛出的错误（对外一律被 `parseExpression` 兜底为 opaque）。
 * 元数据供 `diagnoseExpression` 分类与定位；message 本身即面向作者的中文诊断语。
 * 构造函数向后兼容：`new ExprSyntaxError()`（无参）也能编译。
 */
class ExprSyntaxError extends Error {
  /** 词法错（tokenize 阶段）/ 语法错（解析阶段） */
  readonly kind: 'lexical' | 'syntax';
  /** 出错位置在输入中的 0 基字符偏移（定位不到精确位置时取所在语句起点） */
  readonly pos: number;
  constructor(message = '', kind: 'lexical' | 'syntax' = 'syntax', pos = 0) {
    super(message);
    this.kind = kind;
    this.pos = pos;
  }
}

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

const OP2 = ['&&', '||', '^^', '!&', '!|', '==', '!=', '<=', '>=', '<<', '>>', '++', '--'];
const OP1 = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?', '#']);

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * 十进制指数段（`2e3` / `1.5e-2`）的扫描终点；不构成指数就原样返回 `from`。
 *
 * 小数部分**只在确认后面跟着指数时**才吞（`12.5` 必须继续词法报错，既有 pin）；
 * 返回 `from` 时调用方从原位置继续，`'.'` 仍会被当作无法识别的字符。
 */
function scanDecimalExponent(s: string, from: number): number {
  let j = from;
  if (s[j] === '.' && isDigit(s[j + 1])) {
    j++;
    while (isDigit(s[j])) j++;
  }
  if (s[j] !== 'e' && s[j] !== 'E') return from;
  let k = j + 1;
  if (s[k] === '+' || s[k] === '-') k++;
  if (!isDigit(s[k])) return from;
  while (isDigit(s[k])) k++;
  return k;
}

/**
 * 普通字符串 `"…"` 的结束位置（返回闭合引号之后；找不到 -1）。`\` 转义一个字符。
 */
function scanQuotedEnd(s: string, from: number): number {
  let i = from + 1;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i++;
  }
  return -1;
}

/**
 * `%…%` 插值段的结束位置（返回闭合 `%` 之后；找不到 -1）。
 * 插值里可再出现普通字符串 / 嵌套 `@"…"`；`%` 本身即结束符
 * （引擎 `LexicalAnalyzer.Analyse` 的 `LexEndWith.Percent` 同口径）。
 */
function scanPercentEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '%') return i + 1;
    if (ch === '"') {
      i = scanQuotedEnd(s, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '@' && s[i + 1] === '"') {
      i = scanVerbatimEnd(s, i + 2);
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

/** `{…}` 插值段的结束位置（返回闭合 `}` 之后；找不到 -1） */
function scanCurlyEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '}') return i + 1;
    if (ch === '"') {
      i = scanQuotedEnd(s, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '@' && s[i + 1] === '"') {
      i = scanVerbatimEnd(s, i + 2);
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
 * `@"…"` 逐字串的结束位置（返回闭合引号之后；找不到 -1）。
 *
 * 引擎语义（`LexicalAnalyzer.AnalyseFormattedString`）：`%…%` / `{…}` 插值里的
 * 引号属于**内层表达式**，不关闭外层串（`@"%TEXTS("…")%…"` 是合法字面量）；
 * `\` 转义一个字符。找不到闭合时调用方回退到"下一枚引号即结束"的旧口径，
 * 保证 `@"50% OFF"` 这类孤立 `%` 不被误判。
 */
function scanVerbatimEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '"') return i + 1;
    if (ch === '%') {
      i = scanPercentEnd(s, i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '{') {
      i = scanCurlyEnd(s, i + 1);
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

/** 旧的单层口径（`@"` 后下一枚引号即结束）；插值感知扫描失败时兜底 */
function scanVerbatimEndSimple(s: string, from: number): number {
  const at = s.indexOf('"', from);
  return at < 0 ? -1 : at + 1;
}

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
      if (close < 0) throw new ExprSyntaxError('符号“[[”没有闭合（缺少“]]”）', 'lexical', i);
      out.push({ kind: 'name', text: input.slice(i, close + 2), value: input.slice(i + 2, close).trim(), pos: start });
      i = close + 2;
      continue;
    }
    // 数字：十进制 / 0x 十六进制 / 0b 二进制 / 十进制指数（引擎 AddIntegerLiteral 系）
    if (c >= '0' && c <= '9') {
      let base = 10;
      if (c === '0' && (input[i + 1] === 'x' || input[i + 1] === 'X')) {
        base = 16;
        i += 2;
        while (i < input.length && /[0-9a-fA-F]/.test(input[i]!)) i++;
      } else if (c === '0' && (input[i + 1] === 'b' || input[i + 1] === 'B')) {
        base = 2;
        i += 2;
        while (i < input.length && (input[i] === '0' || input[i] === '1')) i++;
      } else {
        while (isDigit(input[i])) i++;
        i = scanDecimalExponent(input, i);
      }
      const text = input.slice(start, i);
      const prefixed = base !== 10;
      const value = prefixed
        ? Number.parseInt(text.slice(2), base)
        : /[eE]/.test(text)
          ? Number(text)
          : Number.parseInt(text, 10);
      out.push({ kind: 'num', text, value, pos: start });
      continue;
    }
    // 逐字串 `@"…"`：`@"` 起；`%…%` / `{…}` 插值里的引号不关闭外层串（引擎同口径，
    // 例 `@"%TEXTS("…")%…"`）；插值感知扫描失败时回退"下一枚引号即结束"（旧行为）。
    if (c === '@' && input[i + 1] === '"') {
      let end = scanVerbatimEnd(input, i + 2);
      if (end < 0) end = scanVerbatimEndSimple(input, i + 2);
      if (end < 0) throw new ExprSyntaxError('逐字字符串的引号没有闭合', 'lexical', start);
      out.push({ kind: 'str', text: input.slice(start, end), value: input.slice(i + 2, end - 1), pos: start });
      i = end;
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
      if (!closed) throw new ExprSyntaxError('字符串的引号没有闭合', 'lexical', start);
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
    throw new ExprSyntaxError(`有无法识别的字符“${c}”`, 'lexical', i);
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
/** 可作前缀的操作数起始符（`++LOCAL:1` 在真实语料里作左值表达式出现） */
const PREFIX_OPS = new Set([...UNARY_OPS, '++', '--']);

/** 把"不该出现的 token"翻译成面向作者的中文人话（诊断 message 用） */
function describeUnexpectedToken(t: Token): string {
  switch (t.kind) {
    case 'eof':
      return '表达式不完整，缺少一个操作数';
    case 'rparen':
      return '多了一个右括号';
    case 'comma':
      return '这里多了一个逗号';
    case 'colon':
      return '这里多了一个冒号';
    case 'op':
      // 二元/后缀运算符出现在**操作数位置**：缺的是它前面的操作数，别把罪名扣在它身上
      return UNARY_OPS.has(t.text) || t.text === '++' || t.text === '--'
        ? `这里多了一个运算符“${t.text}”`
        : `运算符“${t.text}”前面缺少一个操作数`;
    default:
      return `这里多了一个不该出现的“${t.text}”`;
  }
}

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
      if (t.kind === 'eof') throw new ExprSyntaxError('圆括号没有配对', 'syntax', openTok.pos);
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

  /** 当前未消费的 token（诊断定位用） */
  current(): Token {
    return this.peek();
  }

  parseExpr(minPrec: number): ConditionExpr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      // 三元：`cond ? then : else` / `cond ? then # else`（优先级 5，右结合；
      // Emuera 真形是 `#`，`:` 保留兼容）
      if (t.kind === 'op' && t.text === '?') {
        if (5 < minPrec) break;
        this.next();
        const thenE = this.parseExpr(0);
        const sep = this.next();
        if (sep.kind !== 'colon' && !(sep.kind === 'op' && sep.text === '#')) {
          throw new ExprSyntaxError('三元表达式缺少中间的分隔符（“:”或“#”）', 'syntax', sep.pos);
        }
        const elseE = this.parseExpr(0);
        left = { kind: 'ternary', cond: left, then: thenE, else: elseE };
        continue;
      }
      if (t.kind !== 'op') break;
      const prec = BINARY_PREC[t.text];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      // 报错位置 = **刚吃掉的这个运算符**：右操作数位置上出现运算符，缺的是它的操作数，
      // 不能把罪名扣在后一个运算符上（旧版 `LOCAL:3++ == 0` 会误报“多了一个运算符‘==’”）
      const rhsStart = this.peek();
      if (rhsStart.kind === 'op' && !PREFIX_OPS.has(rhsStart.text)) {
        throw new ExprSyntaxError(`运算符“${t.text}”后面缺少一个操作数`, 'syntax', t.pos);
      }
      const right = this.parseExpr(prec + 1); // 左结合
      left = { kind: 'binary', op: t.text, left, right };
    }
    return left;
  }

  private parseUnary(): ConditionExpr {
    const t = this.peek();
    if (t.kind === 'op' && PREFIX_OPS.has(t.text)) {
      this.next();
      const operandStart = this.peek();
      if (operandStart.kind === 'op' && !PREFIX_OPS.has(operandStart.text)) {
        throw new ExprSyntaxError(`运算符“${t.text}”后面缺少一个操作数`, 'syntax', t.pos);
      }
      const operand = this.parseUnary();
      return { kind: 'unary', op: t.text, operand };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  /** 后缀 `++` / `--`（`LOCAL:3++ == 0` 不报；真正的赋值语义不在本层解释） */
  private parsePostfix(operand: ConditionExpr): ConditionExpr {
    let expr = operand;
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.text === '++' || t.text === '--')) {
        this.next();
        expr = { kind: 'unary', op: t.text, operand: expr };
        continue;
      }
      break;
    }
    return expr;
  }

  /**
   * 实参列表：`(` … `)`，**空槽与尾逗号一律跳过**（`f(a, , , 1)` / `f(x, "y",)` / `f(, x)`）。
   * 返回参数 AST 与含括号的原文切片（下标接调用 `NAME:TOINT(x)` 复用同一逻辑）。
   */
  private parseArgList(): { args: ConditionExpr[]; text: string } {
    const open = this.next(); // lparen
    const args: ConditionExpr[] = [];
    for (;;) {
      if (this.peek().kind === 'comma' || this.peek().kind === 'rparen') {
        if (this.peek().kind === 'comma') {
          this.next();
          continue;
        }
        break;
      }
      args.push(this.parseExpr(0));
      if (this.peek().kind === 'comma') {
        this.next();
        continue;
      }
      break;
    }
    const close = this.next();
    if (close.kind !== 'rparen') {
      throw new ExprSyntaxError('函数调用的圆括号没有配对（缺少右括号）', 'syntax', close.pos);
    }
    return { args, text: this.input.slice(open.pos, close.pos + 1) };
  }

  private parsePrimary(): ConditionExpr {
    const t = this.next();
    if (t.kind === 'num') return { kind: 'literal', value: t.value as number, text: t.text };
    if (t.kind === 'str') return { kind: 'literal', value: t.value as string, text: t.text };
    if (t.kind === 'lparen') {
      const inner = this.parseExpr(0);
      const close = this.next();
      if (close.kind !== 'rparen') throw new ExprSyntaxError('圆括号没有配对（缺少右括号）', 'syntax', close.pos);
      return inner;
    }
    if (t.kind === 'ident') {
      // 函数调用：`NAME(...)` —— 名字后紧跟 `(`（真实语料无带空格的调用）
      if (this.peek().kind === 'lparen') {
        const call = this.parseArgList();
        return { kind: 'call', name: t.text.toUpperCase(), args: call.args };
      }
      // 变量引用：`NAME` / `NAME:段` / `NAME:段:段`
      // 段 = 数字 / 标识符 / 字符串 / [[词]]（rename 语法）/ (括号表达式原文)
      // 标识符段后紧跟 `(` 时按**调用**续切（`CHARISMA_TENDENCY:NOW_PERIOD()`：
      // 下标段的调用实参必须与顶层调用同一套空槽 / 尾逗号口径）
      const indices: string[] = [];
      while (this.peek().kind === 'colon') {
        this.next();
        const seg = this.peek();
        if (seg.kind === 'num' || seg.kind === 'ident') {
          this.next();
          if (seg.kind === 'ident' && this.peek().kind === 'lparen') {
            indices.push(seg.text + this.parseArgList().text);
          } else {
            indices.push(seg.text);
          }
        } else if (seg.kind === 'str') {
          indices.push(String(seg.value));
          this.next();
        } else if (seg.kind === 'name') {
          indices.push(seg.text);
          this.next();
        } else if (seg.kind === 'lparen') {
          indices.push(this.consumeBracketText());
        } else {
          throw new ExprSyntaxError('变量冒号后面的索引写法不对', 'syntax', seg.pos);
        }
      }
      const text = indices.length > 0 ? `${t.text}:${indices.join(':')}` : t.text;
      return { kind: 'ref', name: t.text.toUpperCase(), indices, text };
    }
    if (t.kind === 'name') return { kind: 'nameValue', name: String(t.value ?? ''), text: t.text };
    throw new ExprSyntaxError(describeUnexpectedToken(t), 'syntax', t.pos);
  }
}

/** 解析表达式（失败 → `opaque` 整体降级） */
export function parseExpression(text: string): ConditionExpr {
  try {
    const toks = tokenize(text);
    const p = new Parser(text, toks);
    const expr = p.parseExpr(0);
    if (!p.atEnd()) {
      const t = p.current();
      throw new ExprSyntaxError(describeUnexpectedToken(t), 'syntax', t.pos);
    }
    return expr;
  } catch {
    return { kind: 'opaque', text };
  }
}

export interface ExprDiagnostic {
  kind: 'lexical' | 'syntax';
  /** 中文人话：说清在哪类位置出什么问题；面向作者，不含内部术语 / 实现细节 */
  message: string;
  /**
   * 出错位置（在传入表达式文本内的 0 基 UTF-16 偏移；additive，缺省 = 定位不到）。
   * 装饰层据此换算 1 基列号，波浪线不再整行标红。
   */
  pos?: number;
}

/** 去掉首尾空白（含全角空格 U+3000 / NBSP；与 tokenizer 的 `isSpace` 同口径） */
function trimSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s[a]!)) a++;
  while (b > a && isSpace(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/**
 * 行尾续写判据（fail-open）：扫描器只有**单行视野**，下一行才是这句话的继续。
 * 表达式以二元运算符或 `{` 收尾 → 不产诊断；单独成行的 `{` / `}` 同理。
 */
function isLineContinuation(text: string): boolean {
  const t = trimSpace(text);
  if (t === '{' || t === '}') return true;
  if (t.endsWith('{')) return true;
  return false;
}

/** 试解析：成功 → null；失败 → 人话诊断。**绝不抛错**。空串 / 纯空白 → null。 */
export function diagnoseExpression(text: string): ExprDiagnostic | null {
  // 空串 / 纯空白（含全角空格）没有可诊断的表达式
  if (text.length === 0) return null;
  let blank = true;
  for (let i = 0; i < text.length; i++) {
    if (!isSpace(text[i]!)) {
      blank = false;
      break;
    }
  }
  if (blank) return null;
  if (isLineContinuation(text)) return null;

  try {
    const toks = tokenize(text);
    // 行尾续写：最后一个实义 token 是二元运算符 / 逗号 ⇒ 残句是 scanner 的视野问题
    //（真实语料大量 `IF ... &&` / `SIF ...,` 折行，下一行才是续篇）
    const last = toks.length >= 2 ? toks[toks.length - 2]! : undefined;
    if (
      last !== undefined &&
      (last.kind === 'comma' || (last.kind === 'op' && BINARY_PREC[last.text] !== undefined))
    ) {
      return null;
    }
    const p = new Parser(text, toks);
    p.parseExpr(0);
    if (!p.atEnd()) {
      const t = p.current();
      throw new ExprSyntaxError(describeUnexpectedToken(t), 'syntax', t.pos);
    }
    return null;
  } catch (err) {
    if (err instanceof ExprSyntaxError) return { kind: err.kind, message: err.message, pos: err.pos };
    // 兜底：任何非预期错误都以语法错收口，契约保证本函数绝不抛错
    return { kind: 'syntax', message: '表达式无法解析' };
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
