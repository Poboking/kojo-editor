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
  FunctionAssignment,
  FunctionConditions,
  FunctionLoopCounter,
  FunctionPredicate,
  FunctionPredicates,
  FunctionReturn,
  PredicateSourceKind,
  StateDependency,
  VariableInfo,
} from '@kojo/plugin-api';
import { erbContinuationJoin, erbContinuationRoleOf } from '@kojo/plugin-api';
import { dependencyKey, erbCodeBodyOf, erbCodePrefixLength } from '@kojo/plugin-api';
// 控制流配对表真源（零运行时 import 的自包含叶子；与 erb-parser/scanner.ts 同一条例外，
// 见 `@kojo/erb-vocab` 包自陈与 `tools/audit-decoupling.mjs` C 项口径——它不是插件）。
import { classifyControlFlow } from '@kojo/erb-vocab/control-flow';
import { parseExpression, splitTopLevelCommas, walkExpr } from './expr';
import { scanBraceTernaries, scanTextTernaries } from './inline';
import { collectDisplayLines } from './display';

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

/** 展开一条 CASE 为若干谓词（conjunction = 同行 AND 标记，见 FunctionPredicate）
 *  @param rawText CASE 的逻辑行原文：缺省取语句自带表达式；`{`…`}` 行连接批（W8-C2）
 *                 传入拼接后的整条值列表（`expandCase` 对原文零游戏知识，只管切值）。 */
function expandCase(
  stmt: ControlFlowStatement,
  subject: ConditionExpr | null,
  rawText: string = stmt.expression,
): { expr: ConditionExpr; line: number; conjunction?: 'and' }[] {
  const raw = rawText.trim();
  if (raw.length === 0) return [];
  const out: { expr: ConditionExpr; line: number; conjunction?: 'and' }[] = [];

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
      // H1（审阅 2026-10-10）：TO 区间语义是 AND（a <= v && v <= b），
      // 两条半边谓词打 'and' 标记；分支折叠层按"组内 AND、组间 OR"归约。
      out.push({ expr: { kind: 'binary', op: '>=', left: subject, right: lo }, line: stmt.line, conjunction: 'and' });
      out.push({ expr: { kind: 'binary', op: '<=', left: subject, right: hi }, line: stmt.line, conjunction: 'and' });
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

// ---------------------------------------------------------------------------
// 分支上下文（v0.2 第六批）——本地量数据流的"可达性"判定资料。
//
// 语义：把控制流语句序列折叠成"段栈"。每条语句属于一个**段路径**（外→内的
// 段 id 序列）；开块语句（IF/SELECTCASE/…）入栈，分支语句（ELSEIF/ELSE/CASE…）
// 把栈顶同深度段替换为新段（兄弟分支互异），闭合语句弹栈。
// 查询 `contextOf(line)` = 处理完所有 `stmt.line < line` 的语句后的栈快照——
// 即"该行执行时所处的分支路径"。赋值 A 对使用点 U 可达 ⇔
// `A.context` 是 `U.context` 的前缀（同路径或祖先路径）。
//
// **配对表一份不抄**（D03b 收口批）：本段的"这一行开不开块 / 是不是分支 / 是不是
// 闭合"三问全部走真源 `@kojo/erb-vocab/control-flow` 的 `classifyControlFlow`——与
// 骨架扫描 `erb-parser/scanner.ts` 吃的就是同一枚函数。此前这里手抄过六张本地表
// （`CTX_TRY_CATCH_OPEN` / `CTX_TRY_LIST_OPEN` / `CTX_PRINTDATA_OPEN` /
// `CTX_OPEN_KINDS` / `CTX_BRANCH_KINDS` / `CTX_CLOSE_KINDS`），真源补一枚词这里就跟不上，
// 后果是同一行在骨架里数进嵌套、在段栈里没数＝**幻影深度**（赋值可达性判错）。
// 守卫：`packages/app/tests/tryc-pairing-single-source.test.ts`。
// ---------------------------------------------------------------------------

interface CtxStackEntry {
  depth: number;
  seg: string;
}

/**
 * 构建行 → 分支上下文路径 的查询器（基于语句序列的纯函数）。
 * 宽容：孤儿分支/闭合向栈内找最近同深度项，找不到则不动栈（与 scanner 同策略）。
 */
export function buildContextLookup(stmts: readonly ControlFlowStatement[]): (line: number) => string[] {
  const stack: CtxStackEntry[] = [];
  const snapshots: { line: number; context: string[] }[] = [];
  let segCounter = 0;

  for (const s of stmts) {
    const flow = classifyControlFlow(s.kind);
    if (flow?.role === 'open') {
      stack.push({ depth: s.depth, seg: `s${++segCounter}` });
    } else if (flow?.role === 'branch') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.depth === s.depth) {
          stack[i] = { depth: s.depth, seg: `s${++segCounter}` };
          break;
        }
      }
    } else if (flow?.role === 'close') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.depth === s.depth) {
          stack.length = i;
          break;
        }
      }
    }
    // 其余（leaf = SIF / 表外 kind）：不动栈，但仍留一个快照
    snapshots.push({ line: s.line, context: stack.map((e) => e.seg) });
  }

  // contextOf(L) = 最后一个 line < L 的快照（= 处理完 L 之前全部语句的状态）
  return (line: number): string[] => {
    // 二分：最后一个 snapshot.line < line
    let lo = 0;
    let hi = snapshots.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (snapshots[mid]!.line < line) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? snapshots[found]!.context : [];
  };
}

/** 判定 `prefix` 是否为 `path` 的前缀（含相等） */
function isContextPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 本地量赋值收集（v0.2 第六批）
// ---------------------------------------------------------------------------

/** 可赋值目标（Emuera 语言级局部量 + 参数槽族；剔除循环量 COUNT 与 LOCALSS） */
const ASSIGNABLE_LOCALS = new Set(['LOCAL', 'LOCALS', 'RESULT', 'RESULTS', 'ARG', 'ARGS']);

/** 引号外截断行内注释（与 scanner sliceExpression 同逻辑；插件间禁 import，就地实现） */
function sliceInlineComment(s: string): string {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === ';') return s.slice(0, i);
  }
  return s;
}

/**
 * 赋值识别：`LOCAL(:n)? = RHS`（`== != <= >= <>` 不匹配）。
 * KW-33b 1103：复合（`&= |= ^= <<= >>=`）与自增（`A++`/`A--`/`++A`）也收，只有裸 `=` 产出具体值，
 * 余皆 opaque；记号表同 sugar 的 statement.ts。`LOCAL' = "…"`（字符串槽）**不收**——契约 `name`
 * 无素书维，收它＝字符串写当数值读＝假命中。枚数与不收诸族理由＝tests/assignments.test.ts 头注。
 */
const ASSIGN_RE =
  /^(?:(\+\+|--)\s*)?(LOCALS?|RESULTS?|ARGS?)(?::(\d+))?\s*(?:(\+\+|--)|((?:<<|>>|[+\-*/%&|^])?=)(?!=)\s*(.*))?$/i;

/** 从函数体原始行收集本地量赋值（结构事实；RHS 无法解析 → opaque，绝不抛） */
export function collectAssignments(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  contextOf: (line: number) => string[],
): FunctionAssignment[] {
  const out: FunctionAssignment[] = [];
  let inSkipBlock = false;

  for (let i = startLine; i <= endLine && i <= lines.length; i++) {
    const raw = lines[i - 1] ?? '';
    // 代码前缀（`;!;` / `;#;`）之后是真代码：`;!;LOCAL = 1` 是一条真赋值（判据单源 code-prefix.ts）
    const trimmed = erbCodeBodyOf(raw.trim());

    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('@') || trimmed.startsWith('#') || trimmed.startsWith('$')) continue;

    // 自增没有右值 ⇒ 注释须在匹配前切
    const m = ASSIGN_RE.exec(sliceInlineComment(trimmed).trim());
    if (!m) continue;
    const name = m[2]!.toUpperCase();
    if (!ASSIGNABLE_LOCALS.has(name)) continue;
    const index = m[3] ? Number(m[3]) : 0;
    // 组 5 赋值符，组 4/1 后置/前置自增；全缺位＝裸引用，不是写值
    const op = m[5] ?? m[4] ?? m[1];
    const rhs = (m[6] ?? '').trim();
    if (!op || (m[5] !== undefined && !rhs)) continue;

    out.push({
      name: name as FunctionAssignment['name'],
      index,
      expr: op === '=' ? parseExpression(rhs) : { kind: 'opaque', text: rhs ? `${op} ${rhs}` : op },
      text: rhs,
      line: i,
      context: contextOf(i),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 计数循环的循环量收集（KW-15C 1103；结构事实，语义留给回放侧）
// ---------------------------------------------------------------------------

/**
 * `FOR` 头部：`槽位,字面初值,字面终值[,字面步进]`。
 * 端点必须都是**字面整数**——表达式端点（`FOR LOCAL,1,CHARANUM`）一律不记：
 * 区间无从枚举，硬算就是猜。步进接受但不参与区间（区间取两端点折成的闭区间，
 * 见契约 `FunctionLoopCounter`：超近似只会少判，不会误判）。
 */
const LOOP_HEADER_RE = /^([A-Z_][A-Z0-9_]*)(?::(\d+))?\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*(-?\d+))?\s*$/i;

/** 区间上限（超过就不发布：逐值试算的代价必须有界） */
const LOOP_RANGE_MAX = 64;

/** 体内出现标签行 ⇒ 体外可能跳进体内（循环量也就可能是跳入时 carry 进来的旧值）⇒ 整条循环不发布 */
const LABEL_LINE_RE = /^\$/;

/**
 * 从函数体原始行 + 控制流骨架收集计数循环的循环量。
 * 与 `collectAssignments` 同一供应条件（要 `source.lines`）；`[SKIPSTART]…[SKIPEND]`
 * 内的行不算真代码（同那份的口径）。未配对到 `NEXT` 的 `FOR` 不发布（不猜体区间）。
 */
export function collectLoopCounters(
  lines: readonly string[],
  stmts: readonly ControlFlowStatement[],
): FunctionLoopCounter[] {
  /** 一行的"真代码正文"（非代码 ⇒ 空串；判据与 collectAssignments 同一条） */
  const codeAt = (lineNo: number): string => {
    const trimmed = erbCodeBodyOf((lines[lineNo - 1] ?? '').trim());
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('@') || trimmed.startsWith('#')) return '';
    return trimmed;
  };
  const out: FunctionLoopCounter[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const open = stmts[i]!;
    if (open.kind !== 'FOR') continue;
    const m = LOOP_HEADER_RE.exec(open.expression.trim());
    if (!m) continue;
    const from = Number(m[3]);
    const to = Number(m[4]);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (hi - lo + 1 > LOOP_RANGE_MAX) continue;
    // 配对的 NEXT：引擎侧 FOR 与它的 NEXT 同深度、体内更深 ⇒ 首个同深度 NEXT 就是收口
    const close = stmts.slice(i + 1).find((t) => t.kind === 'NEXT' && t.depth === open.depth);
    if (!close || close.line <= open.line + 1) continue;
    // 体内有标签行 = 存在跳进体内的落点可能（跳进来时循环量未必是本次循环头写的）
    let hasLabel = false;
    for (let ln = open.line + 1; ln < close.line; ln++) {
      if (LABEL_LINE_RE.test((lines[ln - 1] ?? '').trim())) hasLabel = true;
    }
    if (hasLabel) continue;
    // 体内第一条真代码行（跳过区内的行不算）
    let firstBodyLine = 0;
    let inSkip = false;
    for (let ln = open.line + 1; ln < close.line; ln++) {
      const body = codeAt(ln);
      if (inSkip) {
        if (body === '[SKIPEND]') inSkip = false;
        continue;
      }
      if (body === '[SKIPSTART]') {
        inSkip = true;
        continue;
      }
      if (body.length === 0) continue;
      firstBodyLine = ln;
      break;
    }
    if (firstBodyLine === 0) continue;
    out.push({
      name: m[1]!.toUpperCase(),
      index: m[2] ? Number(m[2]) : 0,
      openLine: open.line,
      closeLine: close.line,
      lo,
      hi,
      firstBodyLine,
    });
  }
  return out;
}

export interface ExtractFunctionOptions {
  /** 语义标注（可选）：给依赖打上人类可读标签 */
  lookup?: SchemaLookup;
  /** 原始行（additive）：提供时把 `{`…`}` 多行条件拼接后再解析；缺省行为不变 */
  lines?: readonly string[];
  /**
   * 函数体末行（1 基，含；additive）。与 `lines` 同时提供才扫文本内联三元——
   * 没有区间就不猜（宁可少收，不把邻函数的 `\@` 算到本函数头上）。
   */
  endLine?: number;
}

export interface FunctionIdentity {
  normalizedName: string;
  filePath: string;
  startLine: number;
}

/**
 * 收集 RETURNF 返回点（v0.2 第七批；内联解释器的返回值资料）。
 * 结构事实：`RETURNF 表达式` 直线语句（含行内注释截断）。
 */
export function collectReturns(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): FunctionReturn[] {
  const out: FunctionReturn[] = [];
  let inSkipBlock = false;
  for (let i = startLine; i <= endLine && i <= lines.length; i++) {
    const raw = lines[i - 1] ?? '';
    const trimmed = erbCodeBodyOf(raw.trim());
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const m = /^RETURNF\b\s*(.*)$/i.exec(trimmed);
    if (!m) continue;
    const expr = sliceInlineComment(m[1] ?? '').trim();
    out.push({
      expr: expr.length > 0 ? parseExpression(expr) : { kind: 'opaque', text: 'RETURNF（无表达式）' },
      text: expr,
      line: i,
    });
  }
  return out;
}

/**
 * `{` … `}` 行连接（Emuera `EraStreamReader.ReadEnabledLine` 语义）：
 * 孤行 `{` 起、孤行 `}` 止，块内物理行按引擎的分隔串拼成一条逻辑行。
 *
 * 骨架扫描只有单行视野，`IF A &&` 折行时只拿到半句 ⇒ 解析整体降级 opaque。
 * 这里在**既有语句边界**（孤行 `{` / `}`）内补全原文，再交给同一个表达式解析器。
 *
 * 两处判据（"这是不是标记行"与"怎么拼"）自 2026-10-26 A2 批起**不在本文件里**：
 * 真源是 `@kojo/plugin-api` 的 `erbContinuationRoleOf` / `erbContinuationJoin`，与
 * `erb-parser/src/erh.ts`（头文件形态）、`erb-syntax-tree/grammar.js`（CST 块）同源。
 * 在此之前的私有实现在拼接分隔符上与引擎不一致（`join(' ')` 恰好对，但另一处
 * `join('')` 不对），这类"两处各写一遍"正是要消灭的东西（PITFALLS 211/216 同族）。
 *
 * @returns 拼接后的表达式；语句不在块内 / 块未闭合 ⇒ null（调用方保留原样：
 *          残句继续 opaque，opaque 仍可查，绝不猜）。
 */
export function joinBracedExpression(
  stmtLine: number,
  expression: string,
  lines: readonly string[],
): string | null {
  // 语句前最近的非空 / 非注释行必须是孤立的 `{`（引擎要求 `{` 行只含 `{`）
  let open = stmtLine - 2;
  while (open >= 0) {
    const probe = (lines[open] ?? '').trim();
    if (probe === '' || probe.startsWith(';')) {
      open--;
      continue;
    }
    break;
  }
  if (open < 0 || erbContinuationRoleOf(lines[open] ?? '') !== 'open') return null;

  const parts: string[] = [];
  const head = expression.trim();
  if (head.length > 0) parts.push(head);
  for (let i = stmtLine; i < lines.length; i++) {
    const role = erbContinuationRoleOf(lines[i] ?? '');
    if (role === 'close') return erbContinuationJoin(parts);
    const probe = (lines[i] ?? '').trim();
    if (probe.length > 0) parts.push(probe);
  }
  return null; // 未闭合的块：不拼接（Emuera 会报错；这里保守回退到原样 opaque）
}

/**
 * 从控制流骨架收集逐条谓词（含来源类别 / 原文 / 行号 / 深度）。
 * 聚合视图（`extractFunctionConditions`）与明细视图（`extractFunctionPredicates`）共用。
 * @param opts.contextOf 提供时为每条谓词填充分支上下文路径（明细视图用）
 * @param opts.lines 提供时把 `{`…`}` 多行条件拼接后再解析（additive；缺省行为不变）
 */
export function collectPredicates(
  stmts: readonly ControlFlowStatement[],
  opts: { contextOf?: (line: number) => string[]; lines?: readonly string[] } = {},
): FunctionPredicate[] {
  const preds: FunctionPredicate[] = [];
  /** SELECTCASE subject 栈（按 depth 配平；仅用于 CASE 展开） */
  const selectStack: { subject: ConditionExpr | null; depth: number }[] = [];
  /**
   * 多行条件的拼接原文；无行资料 / 不在 `{`…`}` 块内 ⇒ 原样（不猜）。
   *
   * 收 IF / ELSEIF / SIF / CASE（引擎 `EraStreamReader.ReadEnabledLine` 的行連結对四者
   * 一视同仁；W8-C2 起照真语料取证把 CASE 纳入）。判据与 IF 族完全同门：孤行 `{` 起、
   * 孤行 `}` 止。**没有**「行尾 `,` ⇒ 连下一行」这条规则——尾逗号不携带续行意图，
   * 非块的尾逗号 CASE（真语料 7 处，如 `CASE [[跳蛋]],` 下一行是真正的内层 SELECTCASE）
   * 按尾逗号拼会把内层 SELECTCASE 吃成值片段、凭空多出假谓词（PITFALLS 记过反噬）。
   */
  const exprTextOf = (s: ControlFlowStatement): string =>
    opts.lines ? (joinBracedExpression(s.line, s.expression, opts.lines) ?? s.expression) : s.expression;

  for (const s of stmts) {
    // 更浅的语句出现 → 弹出已越过的 SELECTCASE（深度跟踪，容忍不配平）
    while (selectStack.length > 0 && selectStack[selectStack.length - 1]!.depth > s.depth) {
      selectStack.pop();
    }
    switch (s.kind) {
      case 'IF':
      case 'ELSEIF':
      case 'SIF':
        {
          const text = exprTextOf(s);
          preds.push({
            kind: s.kind as PredicateSourceKind,
            text,
            expr: parseExpression(text),
            line: s.line,
            depth: s.depth,
            ...(opts.contextOf ? { context: opts.contextOf(s.line) } : {}),
          });
        }
        break;
      case 'SELECTCASE': {
        const subject = s.expression.length > 0 ? parseExpression(s.expression) : null;
        selectStack.push({ subject, depth: s.depth });
        break;
      }
      case 'CASE': {
        const top = selectStack[selectStack.length - 1];
        // 值列表同样过 `{`…`}` 行连接门（与 IF 族同判据；见 exprTextOf 注）：块内多行
        // CASE 列表拼接后逐值展开，谓词数随值数增长——这是补全真值，不是假谓词。
        const text = exprTextOf(s);
        for (const p of expandCase(s, top?.subject ?? null, text)) {
          preds.push({
            kind: 'CASE',
            text,
            expr: p.expr,
            line: p.line,
            depth: s.depth,
            ...(p.conjunction ? { conjunction: p.conjunction } : {}),
            ...(opts.contextOf ? { context: opts.contextOf(s.line) } : {}),
          });
        }
        break;
      }
      case 'ENDSELECT':
        if (selectStack.length > 0) selectStack.pop();
        break;
      default:
        break; // ELSE/CASEELSE/循环语句等：不产生谓词
    }
  }
  return preds;
}

/**
 * 从函数体原文收集**文本内联三元**的条件（P0-1；Emuera 三元两形）。
 *
 * 与 `collectPredicates`（控制流骨架）是两条独立来源：骨架只有"行首是哪个控制词"
 * 的视野，`\@条件?真#假\@` 与 `{条件 ? 真 # 假}` 整段落在文本里、进不了骨架。
 * 但它们的条件半边是真谓词——"这句话在这个状态下才出现"。
 *
 * 保守口径（与 `collectAssignments` / `collectReturns` 同族）：
 * - 跳过空行 / `;` 注释 / `#` 指令 / `@` 头 / `$` 标签行；
 * - 跳过 `[SKIPSTART]`…`[SKIPEND]` 停用区（引擎不编译，里面的 `\@` 是死文本）；
 * - 残句（缺 `?` 或缺收尾 `\@`）一律不产谓词；条件解析失败 → `opaque`（计入未解析，
 *   绝不猜）。
 *
 * @param startLine 函数体首行（1 基，含）；调用方传"头行 + 1"
 * @param endLine   函数体末行（1 基，含）
 * @param contextOf 提供时填分支上下文（明细视图）；`depth` 取上下文段数
 */
export function collectInlinePredicates(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  contextOf?: (line: number) => string[],
): FunctionPredicate[] {
  const out: FunctionPredicate[] = [];
  let inSkipBlock = false;

  for (let i = Math.max(1, startLine); i <= endLine && i <= lines.length; i++) {
    const raw = lines[i - 1] ?? '';
    /**
     * 代码前缀（`;!;` / `;#;`）之后是真代码；本处要算**列坐标**，所以不能只取正文——
     * 记下前缀宽度，扫描时按 `scanFrom` 平移回原文坐标。
     */
    const trimmed = raw.trim();
    const scanFrom = raw.length - raw.trimStart().length + erbCodePrefixLength(trimmed);
    const codeLine = scanFrom === 0 ? raw : raw.slice(scanFrom);
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('@') || trimmed.startsWith('$')) continue;
    // `\@` 是 FORM 串的转义，只可能出现在正文行；先按最廉价的存在性筛掉绝大多数行
    if (!codeLine.includes('\\@') && !codeLine.includes('{')) continue;

    const found = [
      ...scanTextTernaries(codeLine),
      ...scanBraceTernaries(codeLine, parseExpression),
    ].sort((a, b) => a.column - b.column);
    if (found.length === 0) continue;
    const context = contextOf ? contextOf(i) : undefined;
    for (const c of found) {
      out.push({
        kind: 'INLINE',
        text: c.text,
        expr: parseExpression(c.text),
        line: i,
        depth: context ? context.length : 0,
        ...(context ? { context } : {}),
      });
    }
  }
  return out;
}

/** 明细抽取的数据源（聚合路径不提供 → 不收集赋值 / 不填上下文） */
export interface PredicateSourceLines {
  /** 函数体结束行（1 基，含） */
  endLine: number;
  /** 文件全部行（按 `\n` 切分，与 scanControlFlow 的 EOL 规范化一致） */
  lines: readonly string[];
}

/**
 * 两路谓词按行号归并（同源稳定：骨架在前、内联在后）。
 * 骨架已按行升序，内联同样升序 ⇒ 一次归并即可，不重排既有顺序（回放/矩阵按序展示）。
 */
function mergeByLine(base: FunctionPredicate[], extra: FunctionPredicate[]): FunctionPredicate[] {
  if (extra.length === 0) return base;
  const out: FunctionPredicate[] = [];
  let j = 0;
  for (const p of base) {
    while (j < extra.length && extra[j]!.line <= p.line) out.push(extra[j++]!);
    out.push(p);
  }
  while (j < extra.length) out.push(extra[j++]!);
  return out;
}

/**
 * 抽取单函数谓词明细（含控制流骨架；**不聚合**——供快照回放逐条求值）。
 * 提供 `source` 时同时收集本地量赋值并填充谓词分支上下文（v0.2 第六批），
 * 以及文本内联三元的条件（P0-1）。
 */
export function extractFunctionPredicates(
  fn: FunctionIdentity,
  stmts: readonly ControlFlowStatement[],
  source?: PredicateSourceLines,
): FunctionPredicates {
  const contextOf = source ? buildContextLookup(stmts) : null;
  const base = collectPredicates(stmts, {
    ...(contextOf ? { contextOf } : {}),
    ...(source ? { lines: source.lines } : {}),
  });
  const inline = source
    ? collectInlinePredicates(source.lines, fn.startLine + 1, source.endLine, contextOf ?? undefined)
    : [];
  return {
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    endLine: source?.endLine ?? fn.startLine,
    statements: [...stmts],
    predicates: mergeByLine(base, inline),
    assignments: source
      ? collectAssignments(source.lines, fn.startLine + 1, source.endLine, contextOf!)
      : [],
    returns: source ? collectReturns(source.lines, fn.startLine + 1, source.endLine) : [],
    // 显示行（v0.3 台词推演批；additive）：与赋值 / 内联谓词同一供应条件——
    // 给了 source 才扫（没有行区间就不猜，与 assignments 同口径）。
    ...(source ? { displays: collectDisplayLines(source.lines, fn.startLine + 1, source.endLine, contextOf ?? undefined) } : {}),
    // 循环量（KW-15C 1103；additive）：与赋值同一供应条件——给了行区间才扫，
    // 且只有"体内第一条真代码行"这类结构事实；区间语义留给回放侧。
    ...(source ? { loopCounters: collectLoopCounters(source.lines, stmts) } : {}),
  };
}

/**
 * 给依赖逐个打语义标注（**就地**，`StateDependency.schema`）。
 *
 * 口径（用依赖的**最后一个下标**查询——角色变量 `CFLAG:{角色}:{项}` 的"项"才是变量号）
 * 与改动前的内联循环逐字一致。2026-10-18 PS-11 抽成独立函数：全量抽取的谓词 CPU 搬进
 * worker 后 `lookup` 是函数、跨不过结构化克隆，只能回主线程补标注——两处必须共用这一份，
 * 否则"worker 抽取"与"内联回退抽取"会给出两种 schema。
 */
export function applySchemaLookup(dependencies: readonly StateDependency[], lookup: SchemaLookup): void {
  for (const dep of dependencies) {
    const raw = dep.indices.length > 0 ? dep.indices[dep.indices.length - 1]! : undefined;
    const idx = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : raw;
    const info = lookup(dep.name, idx);
    if (info) dep.schema = info;
  }
}

/**
 * 抽取单函数条件（纯函数，聚合视图）。
 * @returns 无条件谓词时返回 null（调用方不收录）。
 */
export function extractFunctionConditions(
  fn: FunctionIdentity,
  stmts: readonly ControlFlowStatement[],
  opts: ExtractFunctionOptions = {},
): FunctionConditions | null {
  const base = collectPredicates(stmts, opts.lines ? { lines: opts.lines } : {});
  // 文本内联三元（P0-1）：只在给了函数体区间时才扫（见 ExtractFunctionOptions.endLine）
  const inline =
    opts.lines && opts.endLine !== undefined
      ? collectInlinePredicates(opts.lines, fn.startLine + 1, opts.endLine)
      : [];
  const preds = mergeByLine(base, inline);

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
  if (opts.lookup) applySchemaLookup(dependencies, opts.lookup);

  return {
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    predicateCount: preds.length,
    unparsedCount: unparsed,
    dependencies,
  };
}
