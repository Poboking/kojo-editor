/**
 * 与 v1 表达式管线的对拍工具（K2-EXPR-AST）。
 *
 * **依赖方向**：core 不 import 插件，故 v1 管线由调用方以 `ExprParityOracle`
 * 注入（测试注入 `condition.extractor` 的 `parseExpression`，后续 sema 可注入
 * adapter 提供的同一函数）。本文件只定义**结构性的** v1 节点形状（与
 * plugin-api 的 `ConditionExpr` 同构），不做任何插件 import。
 *
 * 归一化口径：
 * - v1 的 `ref{name, indices}` ⇄ 新 AST 的 `NAME:段:段` 链（冒号下标合并回 ref）；
 *   `NAME[表达式]` / `对象.成员` / `f().x` 这类 2.0 形态保持 `index` / `member`，
 *   对拍自然落 `new-only`；
 * - v1 的 `call{name}` ⇄ 新 AST 的 `ident(args)`；成员/表达式被调保持 `callExpr`；
 * - 一元 `++`/`--` 的前后缀在 v1 里不可区分，归一化时丢弃 `position`；
 * - 显式括号、数值进制原文、字符串转义形态不参与比较（语义已由 AST 编码）；
 * - 段文本比较统一去空白（v1 存原文切片，新 AST 是结构化节点，空白是格式噪声）。
 *
 * 结果分类（可判别，不抛）：
 * - `equal`：两边都接受且归一化树相等，或两边都拒绝；
 * - `mismatch`：两边都接受但树不同（真回归）；
 * - `new-only`：新 AST 接受、v1 降级 opaque（2.0 扩展形态）；
 * - `v1-only`：v1 接受、新 AST 拒绝（回归，sema 应报）；
 * - `unavailable`：未注入 oracle（只做自检：打印幂等）。
 */
import type { ExprError, KojoExpr } from './ast.js';
import { parseExpr } from './parse.js';
import { exprEquivalent, printExpr } from './print.js';

/**
 * v1 表达式节点（结构复刻 `plugin-api` 的 `ConditionExpr`；只用于对拍，不参与生产）。
 * 字段名与 v1 完全一致，故 v1 的真实 AST 可以直接传入（TS 结构类型）。
 */
export type LegacyExprNode =
  | { readonly kind: 'literal'; readonly value: number | string; readonly text: string }
  | { readonly kind: 'ref'; readonly name: string; readonly indices: readonly string[]; readonly text: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly LegacyExprNode[] }
  | { readonly kind: 'unary'; readonly op: string; readonly operand: LegacyExprNode }
  | { readonly kind: 'binary'; readonly op: string; readonly left: LegacyExprNode; readonly right: LegacyExprNode }
  | {
      readonly kind: 'ternary';
      readonly cond: LegacyExprNode;
      readonly then: LegacyExprNode;
      readonly else: LegacyExprNode;
    }
  | { readonly kind: 'nameValue'; readonly name: string; readonly text: string }
  | { readonly kind: 'opaque'; readonly text: string };

/** 归一化后的比较形态（只含语义字段） */
export type ParityForm =
  | { readonly k: 'empty' }
  | { readonly k: 'int'; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'name'; readonly v: string }
  | { readonly k: 'ref'; readonly name: string; readonly segs: readonly string[] }
  | { readonly k: 'call'; readonly name: string; readonly args: readonly ParityForm[] }
  | { readonly k: 'callExpr'; readonly callee: ParityForm; readonly args: readonly ParityForm[] }
  | { readonly k: 'unary'; readonly op: string; readonly x: ParityForm }
  | { readonly k: 'binary'; readonly op: string; readonly l: ParityForm; readonly r: ParityForm }
  | { readonly k: 'ternary'; readonly c: ParityForm; readonly t: ParityForm; readonly e: ParityForm }
  | { readonly k: 'member'; readonly x: ParityForm; readonly name: string }
  | { readonly k: 'index'; readonly x: ParityForm; readonly i: ParityForm }
  | { readonly k: 'opaque'; readonly text: string };

/** v1 管线注入点：源切片 → v1 AST（**不得抛**；抛了按 opaque 收口） */
export interface ExprParityOracle {
  readonly parse: (source: string) => LegacyExprNode;
}

export type ExprParityStatus = 'equal' | 'mismatch' | 'new-only' | 'v1-only' | 'unavailable';

/** 打印幂等自检（与 oracle 无关，永远执行） */
export interface ExprParitySelfCheck {
  /** `printExpr(ast)`；解析失败为 null */
  readonly printed: string | null;
  /** `parseExpr(printed)` 与 `ast` 等价 */
  readonly idempotent: boolean;
}

export interface ExprParityReport {
  readonly source: string;
  readonly status: ExprParityStatus;
  /** 新 AST；解析失败为 null */
  readonly ast: KojoExpr | null;
  /** 新管线错误；成功为 null */
  readonly error: ExprError | null;
  /** v1 原始 AST；未注入 oracle 时为 null（oracle 抛错按 opaque 节点收口，不抛给调用方） */
  readonly legacy: LegacyExprNode | null;
  /** 新 AST 的归一化形态（解析失败为 null） */
  readonly newForm: ParityForm | null;
  /** v1 AST 的归一化形态（opaque 时为 null） */
  readonly v1Form: ParityForm | null;
  readonly selfCheck: ExprParitySelfCheck;
  /** 归一化树差异（`equal` 时为空；最多 8 条） */
  readonly differences: readonly string[];
}

/** 去掉空白（含全角空格 / BOM）；段文本比较的唯一归一化 */
function compact(text: string): string {
  return text.replace(/[\s\u3000\ufeff]/g, '');
}

/** 冒号段 → v1 `indices` 里的原文口径（v1 对数字存原文、对字符串存解码值） */
function colonSegmentText(node: KojoExpr): string | null {
  switch (node.kind) {
    case 'int':
      return node.raw;
    case 'string':
      return node.value;
    case 'ident':
      return node.name;
    case 'nameValue':
      return `[[${node.name}]]`;
    case 'call':
    case 'paren':
      return printExpr(node);
    default:
      return null;
  }
}

/** v1 AST → 归一化形态 */
export function legacyToParity(node: LegacyExprNode): ParityForm {
  switch (node.kind) {
    case 'literal':
      return typeof node.value === 'number' ? { k: 'int', v: node.value } : { k: 'str', v: node.value };
    case 'ref':
      return { k: 'ref', name: node.name.toUpperCase(), segs: node.indices.map(compact) };
    case 'call':
      return { k: 'call', name: node.name.toUpperCase(), args: node.args.map(legacyToParity) };
    case 'unary':
      return { k: 'unary', op: node.op, x: legacyToParity(node.operand) };
    case 'binary':
      return { k: 'binary', op: node.op, l: legacyToParity(node.left), r: legacyToParity(node.right) };
    case 'ternary':
      return {
        k: 'ternary',
        c: legacyToParity(node.cond),
        t: legacyToParity(node.then),
        e: legacyToParity(node.else),
      };
    case 'nameValue':
      return { k: 'name', v: node.name.trim() };
    case 'opaque':
      return { k: 'opaque', text: node.text };
  }
}

/** 新 AST → 归一化形态（冒号下标合并回 ref；括号抹平；一元前后缀丢弃） */
export function newToParity(node: KojoExpr): ParityForm {
  switch (node.kind) {
    case 'empty':
      return { k: 'empty' };
    case 'int':
      return { k: 'int', v: node.value };
    case 'string':
      return { k: 'str', v: node.value };
    case 'nameValue':
      return { k: 'name', v: node.name };
    case 'ident':
      return { k: 'ref', name: node.name.toUpperCase(), segs: [] };
    case 'paren':
      return newToParity(node.inner);
    case 'member':
      return { k: 'member', x: newToParity(node.object), name: node.name };
    case 'index': {
      const object = newToParity(node.object);
      if (node.style === 'colon') {
        const segment = colonSegmentText(node.index);
        if (segment !== null && object.k === 'ref') {
          return { k: 'ref', name: object.name, segs: [...object.segs, compact(segment)] };
        }
        return { k: 'index', x: object, i: newToParity(node.index) };
      }
      return { k: 'index', x: object, i: newToParity(node.index) };
    }
    case 'call': {
      const callee = newToParity(node.callee);
      const args = node.args.map(newToParity);
      if (callee.k === 'ref' && callee.segs.length === 0) return { k: 'call', name: callee.name, args };
      return { k: 'callExpr', callee, args };
    }
    case 'unary':
      return { k: 'unary', op: node.op, x: newToParity(node.operand) };
    case 'binary':
      return { k: 'binary', op: node.op, l: newToParity(node.left), r: newToParity(node.right) };
    case 'ternary':
      return {
        k: 'ternary',
        c: newToParity(node.cond),
        t: newToParity(node.then),
        e: newToParity(node.else),
      };
  }
}

/** 归一化形态的稳定键（差异定位用） */
export function parityKey(form: ParityForm): string {
  return JSON.stringify(form);
}

/** 比较两个归一化形态（差异最多 8 条；不做模糊等价） */
export function compareParity(left: ParityForm, right: ParityForm): { readonly equal: boolean; readonly differences: readonly string[] } {
  if (left.k === 'opaque' && right.k === 'opaque') {
    return { equal: left.text === right.text, differences: [] };
  }
  if (left.k === 'opaque' || right.k === 'opaque') {
    return { equal: false, differences: [`$: 一侧降级为 opaque（${left.k} ≠ ${right.k}）`] };
  }
  const leftKey = parityKey(left);
  const rightKey = parityKey(right);
  if (leftKey === rightKey) return { equal: true, differences: [] };
  if (left.k !== right.k) {
    return { equal: false, differences: [`$: 节点种类不同（${left.k} ≠ ${right.k}）`] };
  }
  return { equal: false, differences: [`$: ${left.k} 归一化树不等价`] };
}

/**
 * 对拍主入口：解析 `source`（新管线）+ 可选注入 v1 oracle，归一化后比较。
 *
 * 不抛：oracle 抛错按 opaque 收口（视为 v1 拒绝）；新管线错误照常放报告里。
 * 未注入 oracle 时 `status: 'unavailable'`，但仍给出打印幂等自检。
 */
export function exprAstParity(source: string, oracle?: ExprParityOracle): ExprParityReport {
  const parsed = parseExpr(source);
  const ast = parsed.ok ? parsed.node : null;
  const error = parsed.ok ? null : parsed.error;

  let printed: string | null = null;
  let idempotent = false;
  if (parsed.ok) {
    printed = printExpr(parsed.node);
    const reparsed = parseExpr(printed);
    idempotent = reparsed.ok && exprEquivalent(parsed.node, reparsed.node);
  }
  const selfCheck: ExprParitySelfCheck = { printed, idempotent };

  if (oracle === undefined) {
    return {
      source,
      status: 'unavailable',
      ast,
      error,
      legacy: null,
      newForm: ast === null ? null : newToParity(ast),
      v1Form: null,
      selfCheck,
      differences: [],
    };
  }

  let legacy: LegacyExprNode;
  try {
    legacy = oracle.parse(source);
  } catch {
    legacy = { kind: 'opaque', text: source };
  }

  if (!parsed.ok && legacy.kind === 'opaque') {
    return { source, status: 'equal', ast: null, error, legacy, newForm: null, v1Form: null, selfCheck, differences: [] };
  }
  if (parsed.ok && legacy.kind === 'opaque') {
    return {
      source,
      status: 'new-only',
      ast,
      error: null,
      legacy,
      newForm: newToParity(parsed.node),
      v1Form: null,
      selfCheck,
      differences: [],
    };
  }
  if (!parsed.ok) {
    return {
      source,
      status: 'v1-only',
      ast: null,
      error,
      legacy,
      newForm: null,
      v1Form: legacyToParity(legacy),
      selfCheck,
      differences: [`$: v1 接受但新管线拒绝（${parsed.error.code}@${parsed.error.offset}）`],
    };
  }

  const newForm = newToParity(parsed.node);
  const v1Form = legacyToParity(legacy);
  const comparison = compareParity(newForm, v1Form);
  return {
    source,
    status: comparison.equal ? 'equal' : 'mismatch',
    ast,
    error: null,
    legacy,
    newForm,
    v1Form,
    selfCheck,
    differences: comparison.differences,
  };
}

/** 便捷判据：对拍是否等价（`new-only` 视为等价扩展，`mismatch` / `v1-only` 不是） */
export function parityEqual(report: ExprParityReport): boolean {
  return report.status === 'equal' || report.status === 'new-only';
}
