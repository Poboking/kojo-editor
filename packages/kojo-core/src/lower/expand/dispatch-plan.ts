/**
 * 分派判定的**共享纯函数**（`# 池` 等值可证性；`# 对照表` 线可复用同一份词法口径）。
 *
 * 为什么单独一个文件：`# 池`（K2-POOL-SELECTCASE）与 `# 对照表`（K2-TABLE-SELECTCASE）
 * 是两条并行线，**不共享计划文件**；但"把一段条件表达式切成 `主语 op 值`"这件事
 * 与表线 `table-plan.ts::isPureIntegerSubject` 的纯表达式判据同源，抽在这里避免
 * 两份词法判据漂移（表线本批未改，见报告"未合并原因"）。
 *
 * 本文件**不解析表达式语法**（§15.2：core 不重复实现表达式词法/语法），只做保守的
 * 顶层运算符扫描：
 * - 只认**顶层**（括号/方括号/花括号外、字符串外）的运算符；
 * - 认不出/不配平一律返回失败（宁可不优化，也不猜）；
 * - 不做类型检查，只做"静态可证是整数等值"的**语法事实**。
 *
 * 纯函数、零 IO、零缓存（计划缓存归 `pool-plan.ts`）。
 */
import type { KojoExprText } from '../../ast.js';

/* ============================== 顶层运算符扫描 ============================== */

type TopLevelOperator = 'eq' | 'ne' | 'lt' | 'gt' | 'le' | 'ge' | 'and' | 'or' | 'not' | 'ternary';

interface OperatorHit {
  readonly kind: TopLevelOperator;
  /** 在**已 trim** 的条件文本里的 0 基下标 */
  readonly index: number;
  /** 运算符长度（`==` / `<=` 为 2，单字符为 1） */
  readonly length: number;
}

/**
 * 扫出顶层运算符；返回 `null` = 引号或括号不配平（认不出的形态一律不猜）。
 *
 * 括号内的运算符不算顶层（`(a == b)` 是一个整体）；`""` 内的字符原样跳过，
 * `\` 转义按两码元跳过。
 */
function scanTopLevelOperators(text: string): readonly OperatorHit[] | null {
  const hits: OperatorHit[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const inner = text[i]!;
        if (inner === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (inner === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth < 0) return null;
      i++;
      continue;
    }
    if (depth > 0) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      const kind: TopLevelOperator =
        two === '=='
          ? 'eq'
          : two === '!='
            ? 'ne'
            : two === '<='
              ? 'le'
              : two === '>='
                ? 'ge'
                : two === '&&'
                  ? 'and'
                  : 'or';
      hits.push({ kind, index: i, length: 2 });
      i += 2;
      continue;
    }
    if (ch === '=') {
      hits.push({ kind: 'eq', index: i, length: 1 });
      i++;
      continue;
    }
    if (ch === '<') {
      hits.push({ kind: 'lt', index: i, length: 1 });
      i++;
      continue;
    }
    if (ch === '>') {
      hits.push({ kind: 'gt', index: i, length: 1 });
      i++;
      continue;
    }
    if (ch === '?') {
      hits.push({ kind: 'ternary', index: i, length: 1 });
      i++;
      continue;
    }
    if (ch === '!') {
      hits.push({ kind: 'not', index: i, length: 1 });
      i++;
      continue;
    }
    i++;
  }
  return depth === 0 ? hits : null;
}

/* ============================== 整数等值切片 ============================== */

/** 一条条件切不成等值时的事实（调用方据此给"为什么落 IF 链"的理由） */
export type DispatchEqualityProblem =
  /** 顶层没有等值运算符（区间比较 / 裸真假 / 其它） */
  | 'not-equality'
  /** 顶层有多个运算符或逻辑组合（`a == 0 && b == 1` / `a == b == c`） */
  | 'compound-condition'
  /** 等值左边为空 */
  | 'empty-subject'
  /** 等值左边不是纯表达式（含比较/逻辑/赋值/三元/函数调用/字符串） */
  | 'impure-subject'
  /** 等值右边不是十进制安全整数 */
  | 'non-integer-value';

/** 一条可落 `CASE` 的等值臂事实（纯数据） */
export interface DispatchEqualityCase {
  /** 主语（源切片；text 已 trim，span 指向整条条件） */
  readonly subject: KojoExprText;
  /** 等值键（静态解析出的安全整数） */
  readonly value: number;
}

export type DispatchEqualityScan =
  | { readonly ok: true; readonly fact: DispatchEqualityCase }
  | { readonly ok: false; readonly problem: DispatchEqualityProblem; readonly detail: string };

const INTEGER_LITERAL_RE = /^-?\d+$/;

/** 十进制整数字面量 → 安全整数；其它（小数/十六进制/标识符/空串）→ null */
export function parseIntegerLiteral(text: string): number | null {
  const trimmed = text.trim();
  if (!INTEGER_LITERAL_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 主语是不是**纯表达式**（静态语法判据，不做类型检查）。
 *
 * 一票否决：
 * - 字符串字面量 / 花括号插值 / 反斜杠转义（不是整数表达式）；
 * - 比较、逻辑、赋值、三元、非（`< > = ! & | ?`）——有它们就不是"可当分派键的纯值"；
 * - 函数调用（`名字(`，可能有副作用；`(a + b) * c` 这类括号不算）；
 * - 逗号 / 换行 / 引号（调用实参、列表、多行）。
 *
 * 放行：标识符 / 整数 / 算术 / 括号 / 下标 / 域名冒号 / 属性点。
 * 保守优先：认不出就不优化（落 `IF` 链），不生成"看起来等价"的产物。
 */
export function isPureDispatchSubject(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/["'`{}\\\r\n,]/.test(trimmed)) return false;
  if (/[<>=!&|?]/.test(trimmed)) return false;
  // 函数调用：标识符 / 数字 / 右括号 / 右方括号 后面紧跟 `(`；`(a + b) * c` 不匹配
  if (/[\p{L}\p{N}_$)\]]\s*\(/u.test(trimmed)) return false;
  return true;
}

/** 两个主语是否**同一来源表达式**（只按 trim 后的原文比；不改写、不归一空格） */
export function sameDispatchSubject(a: KojoExprText, b: KojoExprText): boolean {
  return a.text.trim() === b.text.trim();
}

/**
 * 把一条 `?` 分支条件切成「同一主语 + 整数等值」事实。
 *
 * 只接受**唯一一个**顶层 `==` / `=`（`!=` / 区间 / 逻辑组合全部拒绝）；右侧必须是
 * 十进制安全整数字面量；左侧必须是 {@link isPureDispatchSubject} 的纯表达式。
 * 不做常量求值（`亲和线` 一类 `# 常量` 不可证，按非整数拒绝——池计划不带声明上下文）。
 */
export function scanIntegerEquality(test: KojoExprText): DispatchEqualityScan {
  const text = test.text.trim();
  if (text.length === 0) {
    return { ok: false, problem: 'not-equality', detail: '条件为空' };
  }
  const hits = scanTopLevelOperators(text);
  if (hits === null) {
    return { ok: false, problem: 'impure-subject', detail: '条件里的引号/括号不配平' };
  }
  const equality = hits.find((hit) => hit.kind === 'eq');
  if (equality === undefined) {
    const comparison = hits.some(
      (hit) => hit.kind === 'ne' || hit.kind === 'lt' || hit.kind === 'gt' || hit.kind === 'le' || hit.kind === 'ge',
    );
    const logical = hits.some((hit) => hit.kind === 'and' || hit.kind === 'or' || hit.kind === 'not' || hit.kind === 'ternary');
    if (logical) return { ok: false, problem: 'compound-condition', detail: '条件里有逻辑/三元组合' };
    if (comparison) return { ok: false, problem: 'not-equality', detail: '条件不是等值比较' };
    return { ok: false, problem: 'not-equality', detail: '条件没有比较运算符' };
  }
  if (hits.length !== 1) {
    return {
      ok: false,
      problem: 'compound-condition',
      detail: `条件里有 ${hits.length} 个顶层运算符（只允许一个等值比较）`,
    };
  }

  const subjectText = text.slice(0, equality.index).trim();
  const valueText = text.slice(equality.index + equality.length).trim();
  if (subjectText.length === 0) return { ok: false, problem: 'empty-subject', detail: '等值左边为空' };
  if (!isPureDispatchSubject(subjectText)) {
    return { ok: false, problem: 'impure-subject', detail: `主语「${subjectText}」不是纯表达式` };
  }
  const value = parseIntegerLiteral(valueText);
  if (value === null) {
    return { ok: false, problem: 'non-integer-value', detail: `等值右边「${valueText}」不是十进制安全整数` };
  }
  return {
    ok: true,
    fact: { subject: { text: subjectText, span: test.span }, value },
  };
}
