/**
 * 条件谓词三值求值器（游戏无关；本插件私有）。
 *
 * 定位（架构文档 §5.3「近似回放」）：把 `ConditionExpr` AST 在变量读取器上求值，
 * 结果为「值 / 未知（附原因）」；条件判定为「真 / 假 / 未知」三值。
 *
 * 语义依据（引擎源码核验）：
 * - 真值：数值非零即真（IF 语义）；字符串不能作条件（引擎报错 → 本层 unknown）；
 * - 逻辑运算 `&& || ^^ !& !|` 输出 0/1；**三值扩展（Kleene）**——子式未知时
 *   仍可能确定结果（如 `false && unknown = false`），这直接决定回放置信度；
 * - 算术：整数除法（C# long 语义 = 截断）；除零 → unknown；
 * - 位运算：BigInt 64 位（JS 32 位位运算会截断，必须避免）；
 * - 字符串：`== / !=` 序比较（Ordinal）；序比较（`> < >= <=`）不支持 → unknown。
 *
 * v0.2 第七批：求值通道重构为 `EvalContext`（读取通道 + 函数内联通道）——
 * 用户函数调用可经 `resolveCall` 做**有界内联解释**（inline.ts），
 * 不可内联时维持 unknown('call')。绝不抛错：一切能力边界返回 unknown 且原因明确。
 */

import type {
  ConditionExpr,
  ReplayOutcome,
  ReplayUnknown,
  ReplayUnknownCode,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { isBuiltinName, tryEvaluateBuiltin } from './builtins';

/** 变量读取器（`ReplayStateView.read` 即满足；测试可注入合成实现） */
export type ValueReader = (ref: VariableRef) => ReplayValue;

/**
 * 用户函数内联解析器（v0.2 第七批；inline.ts 实现）。
 * 第三参为**调用方上下文**（实参求值通道：外层 read / overlay / 递归内联）。
 * 返回 `ReplayValue` = 内联解释成功；返回 `null` = 无法内联（回落 unknown('call')）。
 */
export type CallResolver = (
  name: string,
  args: readonly ConditionExpr[],
  callerCtx: EvalContext,
) => ReplayValue | null;

/** 求值上下文：变量读取通道 + 用户函数内联通道 */
export interface EvalContext {
  read: ValueReader;
  /** 缺省 = 不做内联（调用一律 unknown('call')） */
  resolveCall?: CallResolver;
}

function unknown(code: ReplayUnknownCode, message: string): { kind: 'unknown'; unknown: ReplayUnknown } {
  return { kind: 'unknown', unknown: { code, message } };
}

const LOGICAL_OPS = new Set(['&&', '||', '^^', '!&', '!|']);
const BIT_OPS = new Set(['&', '|', '^', '<<', '>>']);
const ARITH_OPS = new Set(['+', '-', '*', '/', '%']);
const CMP_OPS = new Set(['>', '<', '>=', '<=', '==', '!=']);

/** 数值取值（字符串 → null） */
function asNumber(v: number | string): number | null {
  return typeof v === 'number' ? v : null;
}

/** 求值表达式（值 / 未知） */
export function evaluateExpr(expr: ConditionExpr, ctx: EvalContext): ReplayValue {
  switch (expr.kind) {
    case 'literal':
      return { kind: 'value', value: expr.value };

    case 'ref':
      return ctx.read({ name: expr.name, indices: [...expr.indices], text: expr.text });

    case 'opaque':
      return unknown('opaque', `未解析表达式：${expr.text}`);

    case 'nameValue':
      return unknown('rename', `rename 词无法求值：${expr.text}`);

    case 'call': {
      // v0.2 第六批：内置纯函数子集（GETBIT / GROUPMATCH / MAX / MIN / ABS /
      // SIGN / LIMIT / POWER，语义对齐 Creator.Method.cs）；
      // v0.2 第七批：用户函数有界内联（inline.ts；口上域纯助手顺序解释）；
      // 两者皆不可 → unknown('call')。
      if (isBuiltinName(expr.name)) {
        // isBuiltinName 已确认命中 → tryEvaluateBuiltin 不会返回 null；?? 兜底满足类型
        return tryEvaluateBuiltin(expr.name, expr.args, ctx, evaluateExpr) ?? unknown('builtin', `内置函数无法求值：${expr.name}()`);
      }
      const inlined = ctx.resolveCall?.(expr.name, expr.args, ctx);
      if (inlined) return inlined;
      return unknown('call', `函数调用无法求值：${expr.name}()`);
    }

    case 'unary': {
      const v = evaluateExpr(expr.operand, ctx);
      if (v.kind === 'unknown') return v;
      const n = asNumber(v.value);
      if (n === null) return unknown('non-numeric', `单目运算要求数值：${expr.op}${JSON.stringify(v.value)}`);
      switch (expr.op) {
        case '!':
          return { kind: 'value', value: n === 0 ? 1 : 0 };
        case '-':
          return { kind: 'value', value: -n };
        case '+':
          return { kind: 'value', value: n };
        case '~': {
          if (!Number.isInteger(n)) return unknown('other', `位运算要求整数：~${n}`);
          return { kind: 'value', value: Number(~BigInt(n)) };
        }
        default:
          return unknown('other', `不支持的单目运算符：${expr.op}`);
      }
    }

    case 'binary':
      return evaluateBinary(expr.op, expr.left, expr.right, ctx);

    case 'ternary': {
      const cond = evaluateExpr(expr.cond, ctx);
      if (cond.kind === 'unknown') {
        // Kleene 扩展：两分支都确定且相等 → 该值
        const a = evaluateExpr(expr.then, ctx);
        const b = evaluateExpr(expr.else, ctx);
        if (a.kind === 'value' && b.kind === 'value' && a.value === b.value) return a;
        return cond;
      }
      const n = asNumber(cond.value);
      if (n === null) return unknown('non-numeric', `三元条件要求数值：${JSON.stringify(cond.value)}`);
      return evaluateExpr(n !== 0 ? expr.then : expr.else, ctx);
    }
  }
}

function evaluateBinary(op: string, left: ConditionExpr, right: ConditionExpr, ctx: EvalContext): ReplayValue {
  if (LOGICAL_OPS.has(op)) return evaluateLogical(op, left, right, ctx);

  const a = evaluateExpr(left, ctx);
  if (a.kind === 'unknown') return a;
  const b = evaluateExpr(right, ctx);
  if (b.kind === 'unknown') return b;

  if (ARITH_OPS.has(op)) return applyArith(op, a.value, b.value);
  if (BIT_OPS.has(op)) return applyBit(op, a.value, b.value);
  if (CMP_OPS.has(op)) return applyCompare(op, a.value, b.value);
  return unknown('other', `不支持的二元运算符：${op}`);
}

/** 逻辑运算（Kleene 三值：子式未知时尽力确定） */
function evaluateLogical(op: string, left: ConditionExpr, right: ConditionExpr, ctx: EvalContext): ReplayValue {
  const a = evaluateExpr(left, ctx);
  const aNum = a.kind === 'value' ? asNumber(a.value) : null;

  if (op === '&&' && aNum !== null && aNum === 0) return { kind: 'value', value: 0 };
  if (op === '||' && aNum !== null && aNum !== 0) return { kind: 'value', value: 1 };

  const b = evaluateExpr(right, ctx);
  const bNum = b.kind === 'value' ? asNumber(b.value) : null;

  // 非数值参与逻辑运算 → 无法判定
  if (a.kind === 'value' && aNum === null) return unknown('non-numeric', `逻辑运算要求数值：${JSON.stringify(a.value)}`);
  if (b.kind === 'value' && bNum === null) return unknown('non-numeric', `逻辑运算要求数值：${JSON.stringify(b.value)}`);

  // 全确定 → 直接算
  if (aNum !== null && bNum !== null) {
    const at = aNum !== 0;
    const bt = bNum !== 0;
    let r: boolean;
    switch (op) {
      case '&&':
        r = at && bt;
        break;
      case '||':
        r = at || bt;
        break;
      case '^^':
        r = at !== bt;
        break;
      case '!&':
        r = !(at && bt);
        break;
      default: // !|
        r = !(at || bt);
        break;
    }
    return { kind: 'value', value: r ? 1 : 0 };
  }

  // Kleene 组合（一方未知）
  if (op === '&&' && bNum !== null && bNum === 0) return { kind: 'value', value: 0 };
  if (op === '||' && bNum !== null && bNum !== 0) return { kind: 'value', value: 1 };
  if (op === '!&' && ((bNum !== null && bNum === 0) || (aNum !== null && aNum === 0))) {
    return { kind: 'value', value: 1 };
  }
  if (op === '!|' && ((bNum !== null && bNum !== 0) || (aNum !== null && aNum !== 0))) {
    return { kind: 'value', value: 0 };
  }
  return a.kind === 'unknown' ? a : b; // 传播未知（a 若确定则 b 必为 unknown）
}

function applyArith(op: string, a: number | string, b: number | string): ReplayValue {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === null || y === null) {
    return unknown('type', `算术运算要求数值：${JSON.stringify(a)} ${op} ${JSON.stringify(b)}`);
  }
  switch (op) {
    case '+':
      return { kind: 'value', value: x + y };
    case '-':
      return { kind: 'value', value: x - y };
    case '*':
      return { kind: 'value', value: x * y };
    case '/':
      if (y === 0) return unknown('divide-by-zero', `除零：${x} / 0`);
      return { kind: 'value', value: Math.trunc(x / y) }; // C# long 除法 = 截断
    default: // %
      if (y === 0) return unknown('divide-by-zero', `取模除零：${x} % 0`);
      return { kind: 'value', value: x % y };
  }
}

/** 位运算（BigInt 64 位语义；JS 位运算符是 32 位，必须绕开） */
function applyBit(op: string, a: number | string, b: number | string): ReplayValue {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === null || y === null) {
    return unknown('type', `位运算要求数值：${JSON.stringify(a)} ${op} ${JSON.stringify(b)}`);
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return unknown('other', `位运算要求整数：${x} ${op} ${y}`);
  }
  const bx = BigInt(x);
  const by = BigInt(y);
  let r: bigint;
  switch (op) {
    case '&':
      r = bx & by;
      break;
    case '|':
      r = bx | by;
      break;
    case '^':
      r = bx ^ by;
      break;
    case '<<':
      r = bx << by;
      break;
    default: // >>（BigInt 为算术右移）
      r = bx >> by;
      break;
  }
  return { kind: 'value', value: Number(r) };
}

function applyCompare(op: string, a: number | string, b: number | string): ReplayValue {
  const x = asNumber(a);
  const y = asNumber(b);

  if (x !== null && y !== null) {
    switch (op) {
      case '>':
        return { kind: 'value', value: x > y ? 1 : 0 };
      case '<':
        return { kind: 'value', value: x < y ? 1 : 0 };
      case '>=':
        return { kind: 'value', value: x >= y ? 1 : 0 };
      case '<=':
        return { kind: 'value', value: x <= y ? 1 : 0 };
      case '==':
        return { kind: 'value', value: x === y ? 1 : 0 };
      default: // !=
        return { kind: 'value', value: x !== y ? 1 : 0 };
    }
  }

  if (typeof a === 'string' && typeof b === 'string') {
    if (op === '==') return { kind: 'value', value: a === b ? 1 : 0 };
    if (op === '!=') return { kind: 'value', value: a !== b ? 1 : 0 };
    return unknown('string-compare', `字符串序比较不支持：${JSON.stringify(a)} ${op} ${JSON.stringify(b)}`);
  }

  return unknown('type', `类型不匹配的比较：${JSON.stringify(a)} ${op} ${JSON.stringify(b)}`);
}

/**
 * 谓词判定（IF/ELSEIF/SIF/CASE 谓词的最终三值）。
 * 引擎语义：数值非零为真；字符串不能作条件。
 */
export function judgeCondition(expr: ConditionExpr, ctx: EvalContext): ReplayOutcome {
  const v = evaluateExpr(expr, ctx);
  if (v.kind === 'unknown') return { kind: 'unknown', unknown: v.unknown };
  const n = asNumber(v.value);
  if (n === null) {
    return { kind: 'unknown', unknown: { code: 'non-numeric', message: `条件为字符串值：${JSON.stringify(v.value)}` } };
  }
  return n !== 0 ? { kind: 'true' } : { kind: 'false' };
}
