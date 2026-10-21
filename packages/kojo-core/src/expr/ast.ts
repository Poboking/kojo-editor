/**
 * 表达式 AST —— `KojoExprText`（源切片）的 core 侧结构化形态。
 *
 * 设计口径（K2-EXPR-AST）：
 * - 节点全部 `readonly` + `kind` 判别联合：解析器一次性建树，下游零拷贝遍历；
 * - 每个节点带 `span`：**切片内 1 基 UTF-16 列、半开区间 [start, end)**，与
 *   `KojoSpan` 的 `end` 口径一致（`start === end` = 零宽）；切片按契约是单行，
 *   故不重复携带 1 基行号（要落回文件位置时由调用方叠加切片起点列）；
 * - 语义事实与原文事实分开：`int.raw` / `string.form` / `index.style` 供打印与
 *   对拍保留原文形态，归一化比较不依赖它们；
 * - 失败一律可判别：`ExprParseResult` / `ExprTokenizeResult` 都是
 *   `{ ok: true, … } | { ok: false, error }`，**绝不抛**、不产半成品；
 * - 空切片 = 合法的 `empty` 节点，不是错误（`? ` 后的空条件由上层判空）。
 *
 * 本文件只放类型、错误码闭集与错误构造器：零 IO、零 Monaco、不认识任何游戏。
 */

/** 表达式切片内的列区间：1 基 UTF-16 列，半开 [start, end) */
export interface ExprSpan {
  readonly start: number;
  readonly end: number;
}

/** 空切片的零宽 span（在第 1 列；`printExpr` 得空串） */
export const EMPTY_EXPR_SPAN: ExprSpan = Object.freeze({ start: 1, end: 1 });

/* ============================== 节点 ============================== */

/** 空表达式：空串 / 纯空白 / `{}` 解壳后为空 */
export interface ExprEmpty {
  readonly kind: 'empty';
  readonly span: ExprSpan;
}

/** 整数字面量：十进制 / `0x` / `0b` / `p` 二进制指数 / `e` 十进制指数 */
export interface ExprInt {
  readonly kind: 'int';
  readonly value: number;
  /** 源切片原文（`0x10` / `1p3` / `2e3`）；打印会归一化成十进制 */
  readonly raw: string;
  readonly span: ExprSpan;
}

/** 字符串字面量：普通 `"…"` 或逐字 `@"…"` */
export interface ExprString {
  readonly kind: 'string';
  /** 普通串 = 反转义后内容；逐字串 = 引号之间的原文（与 v1 管线同口径） */
  readonly value: string;
  readonly form: 'plain' | 'verbatim';
  /** 源切片原文（含引号） */
  readonly raw: string;
  readonly span: ExprSpan;
}

/** `[[词]]`：读取期重命名占位（core 只保留词，不做替换） */
export interface ExprNameValue {
  readonly kind: 'nameValue';
  /** `[[ ]]` 内 trim 后的词 */
  readonly name: string;
  readonly span: ExprSpan;
}

/** 标识符（变量 / 符号 / 常量名；大小写原样保留，语义层再归一） */
export interface ExprIdent {
  readonly kind: 'ident';
  readonly name: string;
  readonly span: ExprSpan;
}

/** 括号分组（显式括号保留，打印按原文形态还原） */
export interface ExprParen {
  readonly kind: 'paren';
  readonly inner: KojoExpr;
  readonly span: ExprSpan;
}

/** 成员访问 `对象.名字`（2.0 形态；v1 管线不认，对拍归 new-only） */
export interface ExprMember {
  readonly kind: 'member';
  readonly object: KojoExpr;
  readonly name: string;
  readonly span: ExprSpan;
}

/** 下标：`对象[表达式]`（`bracket`）或 `名字:段`（`colon`，v1/ERB 形态） */
export interface ExprIndex {
  readonly kind: 'index';
  readonly object: KojoExpr;
  readonly index: KojoExpr;
  readonly style: 'bracket' | 'colon';
  readonly span: ExprSpan;
}

/** 调用 `被调(实参…)`；空槽 / 尾逗号在词法层就被跳过，不进 AST */
export interface ExprCall {
  readonly kind: 'call';
  readonly callee: KojoExpr;
  readonly args: readonly KojoExpr[];
  readonly span: ExprSpan;
}

/** 一元 / 自增自减；`position` 区分前后缀（打印与等价比较都保留这一事实） */
export interface ExprUnary {
  readonly kind: 'unary';
  /** `!` `-` `+` `~` `++` `--` */
  readonly op: string;
  readonly operand: KojoExpr;
  readonly position: 'prefix' | 'postfix';
  readonly span: ExprSpan;
}

/** 二元运算；优先级/结合性取仓内 v1 表达式管线口径（见 `parse.ts`） */
export interface ExprBinary {
  readonly kind: 'binary';
  readonly op: string;
  readonly left: KojoExpr;
  readonly right: KojoExpr;
  readonly span: ExprSpan;
}

/** 条件 `cond ? then : else`（v1 的 `#` 分隔同义，打印归一成 `:`） */
export interface ExprTernary {
  readonly kind: 'ternary';
  readonly cond: KojoExpr;
  readonly then: KojoExpr;
  readonly else: KojoExpr;
  readonly span: ExprSpan;
}

export type KojoExpr =
  | ExprEmpty
  | ExprInt
  | ExprString
  | ExprNameValue
  | ExprIdent
  | ExprParen
  | ExprMember
  | ExprIndex
  | ExprCall
  | ExprUnary
  | ExprBinary
  | ExprTernary;

/* ============================== 失败 ============================== */

/** 错误码闭集（只增不改；词法 / 语法两级，`internal` 是契约兜底） */
export const EXPR_ERROR_CODES = [
  'expr/lex/unexpected-char',
  'expr/lex/unterminated-string',
  'expr/lex/unterminated-name',
  'expr/lex/bad-number',
  'expr/syntax/unexpected-token',
  'expr/syntax/missing-operand',
  'expr/syntax/unclosed-paren',
  'expr/syntax/unclosed-bracket',
  'expr/syntax/unclosed-brace',
  'expr/syntax/missing-ternary-separator',
  'expr/syntax/bad-index',
  'expr/syntax/member-name',
  'expr/syntax/trailing',
  'expr/internal',
] as const;

export type ExprErrorCode = (typeof EXPR_ERROR_CODES)[number];

/** 可判别失败：`offset` = 切片内 0 基 UTF-16 偏移（定位不到时夹到合法范围） */
export interface ExprError {
  readonly code: ExprErrorCode;
  readonly message: string;
  readonly offset: number;
}

/** 失败结果的统一形状（tokenize / parse 共用） */
export interface ExprFailure {
  readonly ok: false;
  readonly error: ExprError;
}

/** 构造错误（offset 由调用方保证在 [0, source.length]；这里不做正则/IO） */
export function exprError(code: ExprErrorCode, message: string, offset: number): ExprError {
  return { code, message, offset: offset < 0 ? 0 : offset };
}
