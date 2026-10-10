/**
 * 引擎内置纯函数求值（v0.2 第六批；游戏无关；本插件私有）。
 *
 * 只收录**语义可精确移植**的算术 / 位运算 / 比对类内置函数（无副作用、
 * 不读数组区间、不依赖引擎 UI 状态）。语义逐条对齐引擎源码
 * `Creator.Method.cs`（括号内为类名行号），含错误路径 → 一律 `unknown('builtin')`
 * 而非抛错（近似回放绝不抛）。
 *
 * 明确**不收录**（能力边界，保持 unknown('call')）：
 * - 数组区间族（SUMARRAY / MATCH / FINDELEMENT / INRANGEARRAY…）——
 *   求值原语按单点读取，无数组长度语义，无法安全移植；
 * - 关键字字典族（GETNUM / GETNUMB）——需要 CSV 常量表（未来经 adapter schema 通道）；
 * - 字符串形态族（TOSTR 带格式 / TOINT 全角判定 / STRCOUNT…）——移植面大、
 *   语料占比低；RAND 族——运行期计算值（伪变量）。
 */

import type { ConditionExpr, ReplayValue } from '@kojo/plugin-api';
import type { EvalContext } from './evaluate';

/** 表达式求值器（由 evaluate.ts 注入，避免循环 import） */
export type ExprEvaluator = (expr: ConditionExpr, ctx: EvalContext) => ReplayValue;

function unknownValue(message: string): ReplayValue {
  return { kind: 'unknown', unknown: { code: 'builtin', message } };
}

/** 内置实现：入参为已求值的整数序列；返回结果或错误说明（→ unknown('builtin')） */
type BuiltinImpl = (args: number[]) => number | string;

/** 引擎 Int64 语义的安全边界（超出即 unknown，不猜测） */
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

function inInt64(n: number): boolean {
  return BigInt(n) >= INT64_MIN && BigInt(n) <= INT64_MAX;
}

/** GETBIT(n, m)：`(n >> m) & 1`；m 必须在 0..63（引擎越界即抛 → 这里 unknown） */
function getbit(args: number[]): number | string {
  if (args.length !== 2) return 'GETBIT 需要 2 个参数';
  const m = args[1]!;
  if (m < 0 || m > 63) return `GETBIT 第 2 参数越界(0-63)：${m}`;
  return Number((BigInt(args[0]!) >> BigInt(m)) & 1n);
}

/** GROUPMATCH(v, ...rest)：rest 中与 v 相等的个数（int / string 各自全等） */
function groupmatch(base: number | string, rest: (number | string)[]): number | string {
  let count = 0;
  for (const v of rest) {
    if (typeof v !== typeof base) {
      return `GROUPMATCH 参数类型混合（引擎要求同型）：${JSON.stringify(base)} vs ${JSON.stringify(v)}`;
    }
    if (v === base) count++;
  }
  return count;
}

/** MAX / MIN：全部整数参数的折叠（≥1 个；引擎 OmitStart=1） */
function maxmin(isMax: boolean): BuiltinImpl {
  return (args) => {
    if (args.length === 0) return `${isMax ? 'MAX' : 'MIN'} 至少需要 1 个参数`;
    let ret = args[0]!;
    for (let i = 1; i < args.length; i++) {
      const v = args[i]!;
      if (isMax ? ret < v : ret > v) ret = v;
    }
    return ret;
  };
}

/** ABS(x)：|x|；x = Int64.MinValue 引擎抛错 → unknown */
function abs(args: number[]): number | string {
  if (args.length !== 1) return 'ABS 需要 1 个参数';
  if (BigInt(args[0]!) === INT64_MIN) return 'ABS 不接受 Int64.MinValue（引擎语义）';
  return Math.abs(args[0]!);
}

/** SIGN(x)：Math.Sign */
function sign(args: number[]): number | string {
  if (args.length !== 1) return 'SIGN 需要 1 个参数';
  const x = args[0]!;
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** LIMIT(v, min, max)：clamp（GetLimitMethod：先 min 后 max，顺序即语义） */
function limit(args: number[]): number | string {
  if (args.length !== 3) return 'LIMIT 需要 3 个参数';
  const v = args[0]!;
  if (v < args[1]!) return args[1]!;
  if (v > args[2]!) return args[2]!;
  return v;
}

/** POWER(x, y)：Math.Pow → 截断为 long；NaN / 无穷 / 越界 → unknown */
function power(args: number[]): number | string {
  if (args.length !== 2) return 'POWER 需要 2 个参数';
  const pow = Math.pow(args[0]!, args[1]!);
  if (Number.isNaN(pow)) return 'POWER 结果为非数值';
  if (!Number.isFinite(pow)) return 'POWER 结果为无穷';
  const trunc = Math.trunc(pow);
  if (!inInt64(trunc)) return `POWER 结果超出 Int64：${pow}`;
  return trunc;
}

/** 内置函数名表（键大写；GROUPMATCH 的字符串型分流见求值循环） */
const BUILTINS: ReadonlySet<string> = new Set([
  'GETBIT',
  'GROUPMATCH',
  'MAX',
  'MIN',
  'ABS',
  'SIGN',
  'LIMIT',
  'POWER',
]);

/** 整数族实现表（GROUPMATCH 在求值循环单独分流） */
const IMPLS: Readonly<Record<string, BuiltinImpl>> = {
  GETBIT: getbit,
  MAX: maxmin(true),
  MIN: maxmin(false),
  ABS: abs,
  SIGN: sign,
  LIMIT: limit,
  POWER: power,
};

/** 判定是否内置函数名（v0.2 第七批：evaluate.ts 的 call 分流用） */
export function isBuiltinName(nameUpper: string): boolean {
  return BUILTINS.has(nameUpper);
}

/**
 * 尝试按内置函数求值。
 * @returns 内置但无法求值 → unknown('builtin')（含参数 unknown 传播）。
 */
export function tryEvaluateBuiltin(
  nameUpper: string,
  args: readonly ConditionExpr[],
  ctx: EvalContext,
  evalExpr: ExprEvaluator,
): ReplayValue | null {
  if (!BUILTINS.has(nameUpper)) return null;

  const values: (number | string)[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = evalExpr(args[i]!, ctx);
    if (v.kind === 'unknown') return v; // 保留原始未知原因（来源可追溯）
    if (typeof v.value === 'string') {
      // GROUPMATCH 支持字符串型；其余内置均为整数族
      if (nameUpper !== 'GROUPMATCH') {
        return unknownValue(`${nameUpper} 第 ${i + 1} 参数要求整数：${JSON.stringify(v.value)}`);
      }
      values.push(v.value);
    } else if (Number.isInteger(v.value)) {
      values.push(v.value);
    } else {
      return unknownValue(`${nameUpper} 第 ${i + 1} 参数要求整数：${JSON.stringify(v.value)}`);
    }
  }

  if (nameUpper === 'GROUPMATCH') {
    if (values.length === 0) return unknownValue('GROUPMATCH 至少需要 1 个参数');
    const r = groupmatch(values[0]!, values.slice(1));
    return typeof r === 'string' ? unknownValue(r) : { kind: 'value', value: r };
  }

  const r = IMPLS[nameUpper]!(values as number[]);
  if (typeof r === 'string') return unknownValue(r);
  return { kind: 'value', value: r };
}
