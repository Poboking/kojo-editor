/**
 * 函数级条件抽取（游戏无关；本插件私有）。
 *
 * 输入：一个函数 + 其行区间内的控制流语句；输出：`FunctionConditions`（或 null = 无条件）。
 *
 * 语义映射（以引擎语义为准）：
 * - IF/ELSEIF/SIF 的条件 → 谓词；
 * - SELECTCASE `subject` + CASE `值` → 虚拟谓词 `subject == 值`（逗号列表逐个展开）；
 * - CASE `IS >= n` → `subject >= n`；CASE `a TO b` → `subject >= a` 且 `subject <= b`；
 * - CASEELSE 是"其它"，非谓词。
 *
 * 依赖收录规则：
 * - **语言级局部量排除**（Emuera 内置 LOCAL/LOCALS/LOCALSS/ARG/ARGS/RESULT/RESULTS/COUNT
 *   及其索引形式）——它们不构成"状态依赖"；
 * - 其余引用一律收录（是否"有意义的游戏状态"由消费方结合 schema 标签判断）。
 */

import type {
  ConditionComparison,
  ConditionExpr,
  ControlFlowStatement,
  FunctionConditions,
  StateDependency,
  VariableInfo,
} from '@kojo/plugin-api';
import { dependencyKey } from '@kojo/plugin-api';
import { parseExpression, splitTopLevelCommas, walkExpr } from './expr';

/** ERB 语言级局部量（Emuera 内置；不作为状态依赖收录） */
const LANGUAGE_LOCAL_NAMES = new Set(['LOCAL', 'LOCALS', 'LOCALSS', 'ARG', 'ARGS', 'RESULT', 'RESULTS', 'COUNT']);

const COMPARE_OPS = new Set(['==', '!=', '>', '>=', '<', '<=']);

/** 字面量在左时的比较符翻转（`500 <= X` ⇒ `X >= 500`） */
function flipCompareOp(op: string): string {
  switch (op) {
    case '<':
      return '>';
    case '>':
      return '<';
    case '<=':
      return '>=';
    case '>=':
      return '<=';
    default:
      return op; // == / != 对称
  }
}

/** 收集表达式中的"引用 vs 字面量"直接比较（按依赖键分组） */
function collectComparisons(expr: ConditionExpr): Map<string, ConditionComparison[]> {
  const map = new Map<string, ConditionComparison[]>();
  walkExpr(expr, (node) => {
    if (node.kind !== 'binary' || !COMPARE_OPS.has(node.op)) return;
    const { left, right } = node;
    let key: string | null = null;
    let op = node.op;
    let lit: { value: number | string; text: string } | null = null;
    if (left.kind === 'ref' && right.kind === 'literal') {
      key = dependencyKey(left);
      lit = { value: right.value, text: right.text };
    } else if (left.kind === 'literal' && right.kind === 'ref') {
      key = dependencyKey(right);
      op = flipCompareOp(node.op);
      lit = { value: left.value, text: left.text };
    }
    if (key === null || lit === null) return;
    const arr = map.get(key) ?? [];
    arr.push({ op, value: lit.value, text: lit.text });
    map.set(key, arr);
  });
  return map;
}

/** 引号外查找 ` TO ` 区间分隔（`1 TO 5`；字符串内的 TO 不切） */
function splitToRange(s: string): [string, string] | null {
  let inStr = false;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if ((c === 'T' || c === 't') && (s[i + 1] === 'O' || s[i + 1] === 'o')) {
      const before = s.slice(0, i);
      const after = s.slice(i + 2);
      if ((before.length === 0 || /\s$/.test(before)) && /^\s/.test(after)) {
        return [before.trim(), after.trim()];
      }
    }
  }
  return null;
}

/** 展开一条 CASE 为若干谓词 */
function expandCase(stmt: ControlFlowStatement, subject: ConditionExpr | null): { expr: ConditionExpr; line: number }[] {
  const raw = stmt.expression.trim();
  if (raw.length === 0) return [];
  const out: { expr: ConditionExpr; line: number }[] = [];

  // CASE IS >= 3 （比较形式）
  const isM = /^IS\b\s*(.*)$/is.exec(raw);
  if (isM) {
    const rest = isM[1]!.trim();
    const cmp = /^(>=|<=|==|!=|>|<)\s*(.*)$/s.exec(rest);
    if (cmp && subject) {
      const value = parseExpression(cmp[2]!);
      out.push({ expr: { kind: 'binary', op: cmp[1]!, left: subject, right: value }, line: stmt.line });
    } else {
      out.push({ expr: { kind: 'opaque', text: raw }, line: stmt.line });
    }
    return out;
  }

  // 逗号列表逐个展开（`CASE 1, 2` / `CASE "A", "B"`）
  for (const part of splitTopLevelCommas(raw)) {
    const piece = part.trim();
    if (piece.length === 0) continue;
    const range = splitToRange(piece);
    if (range && subject) {
      const lo = parseExpression(range[0]);
      const hi = parseExpression(range[1]);
      out.push({ expr: { kind: 'binary', op: '>=', left: subject, right: lo }, line: stmt.line });
      out.push({ expr: { kind: 'binary', op: '<=', left: subject, right: hi }, line: stmt.line });
      continue;
    }
    const value = parseExpression(piece);
    if (subject) {
      out.push({ expr: { kind: 'binary', op: '==', left: subject, right: value }, line: stmt.line });
    } else {
      out.push({ expr: { kind: 'opaque', text: piece }, line: stmt.line });
    }
  }
  return out;
}

/** adapter `variableSchema` 查询函数（由引擎注入；通用层不解释结果） */
export type SchemaLookup = (name: string, index?: number | string) => VariableInfo | undefined;

export interface ExtractFunctionOptions {
  /** 语义标注（可选）：给依赖打上人类可读标签 */
  lookup?: SchemaLookup;
}

export interface FunctionIdentity {
  normalizedName: string;
  filePath: string;
  startLine: number;
}

/**
 * 抽取单函数条件（纯函数）。
 * @returns 无条件谓词时返回 null（调用方不收录）。
 */
export function extractFunctionConditions(
  fn: FunctionIdentity,
  stmts: readonly ControlFlowStatement[],
  opts: ExtractFunctionOptions = {},
): FunctionConditions | null {
  const preds: { expr: ConditionExpr; line: number }[] = [];
  /** SELECTCASE subject 栈（按 depth 配平；仅用于 CASE 展开） */
  const selectStack: { subject: ConditionExpr | null; depth: number }[] = [];

  for (const s of stmts) {
    // 更浅的语句出现 → 弹出已越过的 SELECTCASE（深度跟踪，容忍不配平）
    while (selectStack.length > 0 && selectStack[selectStack.length - 1]!.depth > s.depth) {
      selectStack.pop();
    }
    switch (s.kind) {
      case 'IF':
      case 'ELSEIF':
      case 'SIF':
        preds.push({ expr: parseExpression(s.expression), line: s.line });
        break;
      case 'SELECTCASE': {
        const subject = s.expression.length > 0 ? parseExpression(s.expression) : null;
        selectStack.push({ subject, depth: s.depth });
        break;
      }
      case 'CASE': {
        const top = selectStack[selectStack.length - 1];
        for (const p of expandCase(s, top?.subject ?? null)) preds.push(p);
        break;
      }
      case 'ENDSELECT':
        if (selectStack.length > 0) selectStack.pop();
        break;
      default:
        break; // ELSE/CASEELSE/循环语句等：不产生谓词
    }
  }

  if (preds.length === 0) return null;

  let unparsed = 0;
  const depMap = new Map<string, StateDependency>();

  for (const pred of preds) {
    if (pred.expr.kind === 'opaque') unparsed++;
    const compsForPred = collectComparisons(pred.expr);
    walkExpr(pred.expr, (node) => {
      if (node.kind !== 'ref') return;
      if (LANGUAGE_LOCAL_NAMES.has(node.name)) return;
      const key = dependencyKey(node);
      let dep = depMap.get(key);
      if (!dep) {
        dep = {
          key,
          name: node.name,
          indices: [...node.indices],
          count: 0,
          comparisons: [],
          firstLine: pred.line,
        };
        depMap.set(key, dep);
      }
      dep.count++;
      const cs = compsForPred.get(key);
      if (cs) {
        for (const c of cs) {
          if (!dep.comparisons.some((x) => x.op === c.op && x.value === c.value)) dep.comparisons.push(c);
        }
      }
    });
  }

  const dependencies = [...depMap.values()].sort(
    (a, b) => a.firstLine - b.firstLine || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // 语义标注：用依赖的**最后一个下标**查询（角色变量 `CFLAG:{角色}:{项}` 的"项"才是变量号）
  if (opts.lookup) {
    for (const dep of dependencies) {
      const raw = dep.indices.length > 0 ? dep.indices[dep.indices.length - 1]! : undefined;
      const idx = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : raw;
      const info = opts.lookup(dep.name, idx);
      if (info) dep.schema = info;
    }
  }

  return {
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    predicateCount: preds.length,
    unparsedCount: unparsed,
    dependencies,
  };
}
