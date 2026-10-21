/**
 * 表达式打印：AST → 规范文本（`printExpr`）。
 *
 * 规范口径：
 * - 二元运算两侧各一个半角空格，逗号后一个空格；括号 / 成员点 / 下标紧贴；
 * - 数值字面量归一成十进制；字符串按 `\` 与 `"` 反转义（普通串）/ 原样回填（逐字串）；
 * - 只加**语义必需**的括号：显式 `paren` 节点原样保留，其余按优先级表补；
 * - 前缀一元紧贴操作数（嵌套前缀插一个空格，避免 `--` / `++` 被词法合并）。
 *
 * 幂等契约：`parseExpr(printExpr(node))` 与 `node` **等价**（`exprEquivalent`：
 * 忽略 span / 数值原文 / 显式括号，保留一元前后缀与下标形态）。
 * 空表达式打印成空串，再解析仍是 `empty`。
 */
import type { KojoExpr } from './ast.js';
import { EXPR_BINARY_PRECEDENCE, EXPR_TERNARY_PRECEDENCE } from './parse.js';

/** 前缀一元 / 后缀链 / 原子的打印优先级（数字越大绑得越紧） */
const PREFIX_PRECEDENCE = 95;
const POSTFIX_PRECEDENCE = 100;
const ATOM_PRECEDENCE = 110;

function precedenceOf(node: KojoExpr): number {
  switch (node.kind) {
    case 'empty':
      return 0;
    case 'ternary':
      return EXPR_TERNARY_PRECEDENCE;
    case 'binary':
      return EXPR_BINARY_PRECEDENCE[node.op] ?? 0;
    case 'unary':
      return node.position === 'prefix' ? PREFIX_PRECEDENCE : POSTFIX_PRECEDENCE;
    case 'member':
    case 'index':
    case 'call':
      return POSTFIX_PRECEDENCE;
    default:
      return ATOM_PRECEDENCE;
  }
}

/** 只转义会破坏普通串边界的两个字符（`\` `"`；其余字符原样） */
function quotePlain(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else out += ch;
  }
  return `${out}"`;
}

/** 子节点文本 + 必要括号（`minPrecedence` 之下补 `(…)`） */
function render(node: KojoExpr, minPrecedence: number): string {
  const text = printNode(node);
  return precedenceOf(node) < minPrecedence ? `(${text})` : text;
}

function printNode(node: KojoExpr): string {
  switch (node.kind) {
    case 'empty':
      return '';
    case 'int':
      return String(node.value);
    case 'string':
      return node.form === 'verbatim' ? `@"${node.value}"` : quotePlain(node.value);
    case 'nameValue':
      return `[[${node.name}]]`;
    case 'ident':
      return node.name;
    case 'paren':
      return `(${printExpr(node.inner)})`;
    case 'member':
      return `${render(node.object, POSTFIX_PRECEDENCE)}.${node.name}`;
    case 'index':
      return node.style === 'bracket'
        ? `${render(node.object, POSTFIX_PRECEDENCE)}[${printExpr(node.index)}]`
        : `${render(node.object, POSTFIX_PRECEDENCE)}:${printColonSegment(node.index)}`;
    case 'call':
      return `${render(node.callee, POSTFIX_PRECEDENCE)}(${node.args.map(printExpr).join(', ')})`;
    case 'unary': {
      if (node.position === 'postfix') return `${render(node.operand, POSTFIX_PRECEDENCE)}${node.op}`;
      const operand = render(node.operand, PREFIX_PRECEDENCE);
      // 嵌套前缀之间留空格：否则 `-` + `-a` 会粘成词法上的 `--`
      const spaced = node.operand.kind === 'unary' && node.operand.position === 'prefix';
      return `${node.op}${spaced ? ' ' : ''}${operand}`;
    }
    case 'binary':
      return `${render(node.left, precedenceOf(node))} ${node.op} ${render(node.right, precedenceOf(node) + 1)}`;
    case 'ternary':
      return `${render(node.cond, EXPR_TERNARY_PRECEDENCE + 1)} ? ${render(
        node.then,
        EXPR_TERNARY_PRECEDENCE + 1,
      )} : ${render(node.else, EXPR_TERNARY_PRECEDENCE)}`;
  }
}

/** 冒号段只可能是原子 / 调用 / 括号组（见 `parseColonSegment`），直接打印即可 */
function printColonSegment(node: KojoExpr): string {
  return printNode(node);
}

/** AST → 规范文本（幂等；空表达式 → 空串） */
export function printExpr(node: KojoExpr): string {
  return printNode(node);
}

/** 语法形状（去掉 span / 原文 / 显式括号；保留一元前后缀与下标形态） */
function shapeOf(node: KojoExpr): unknown {
  switch (node.kind) {
    case 'empty':
      return ['empty'];
    case 'int':
      return ['int', node.value];
    case 'string':
      return ['string', node.form, node.value];
    case 'nameValue':
      return ['nameValue', node.name];
    case 'ident':
      return ['ident', node.name];
    case 'paren':
      return shapeOf(node.inner);
    case 'member':
      return ['member', shapeOf(node.object), node.name];
    case 'index':
      return ['index', node.style, shapeOf(node.object), shapeOf(node.index)];
    case 'call':
      return ['call', shapeOf(node.callee), node.args.map(shapeOf)];
    case 'unary':
      return ['unary', node.op, node.position, shapeOf(node.operand)];
    case 'binary':
      return ['binary', node.op, shapeOf(node.left), shapeOf(node.right)];
    case 'ternary':
      return ['ternary', shapeOf(node.cond), shapeOf(node.then), shapeOf(node.else)];
  }
}

/** 语法形状的稳定键（`JSON.stringify`；测试里可直接比较） */
export function exprShapeKey(node: KojoExpr): string {
  return JSON.stringify(shapeOf(node));
}

/** 语义等价：忽略 span / 数值原文 / 显式括号，其余一旦不同即不等价 */
export function exprEquivalent(left: KojoExpr, right: KojoExpr): boolean {
  return exprShapeKey(left) === exprShapeKey(right);
}
