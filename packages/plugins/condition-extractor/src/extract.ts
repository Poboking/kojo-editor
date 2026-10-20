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
  FunctionPredicate,
  FunctionPredicates,
  FunctionReturn,
  PredicateSourceKind,
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

/** 展开一条 CASE 为若干谓词（conjunction = 同行 AND 标记，见 FunctionPredicate） */
function expandCase(
  stmt: ControlFlowStatement,
  subject: ConditionExpr | null,
): { expr: ConditionExpr; line: number; conjunction?: 'and' }[] {
  const raw = stmt.expression.trim();
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
// kind 分类与 erb-parser `scanControlFlow` 的配对表逐条一致（同源事实）。
// ---------------------------------------------------------------------------

/** TRY/PRINTDATA 系精确集合（与 erb-parser scanner 同源；引擎 funcMatch :460-487，BUG-2 修复）：
 *  配 CATCH 的 TRYC 六个 + 配 ENDFUNC 的 TRY*LIST 三个 + PRINTDATA 系九个。
 *  TRYCALL/TRYCALLFORM/TRYGOTO/TRYJUMP 等是单行语句，不开块。 */
const CTX_TRY_CATCH_OPEN = new Set(['TRYCGOTO', 'TRYCJUMP', 'TRYCCALL', 'TRYCGOTOFORM', 'TRYCJUMPFORM', 'TRYCCALLFORM']);
const CTX_TRY_LIST_OPEN = new Set(['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST']);
const CTX_PRINTDATA_OPEN = new Set([
  'PRINTDATA', 'PRINTDATAL', 'PRINTDATAW', 'PRINTDATAK', 'PRINTDATAKL', 'PRINTDATAKW', 'PRINTDATAD', 'PRINTDATADL', 'PRINTDATADW',
]);

/** 开块语句（与 scanner OPEN_KINDS 及 TRY 系、PRINTDATA 系精确集合一致） */
const CTX_OPEN_KINDS = new Set(['IF', 'SELECTCASE', 'FOR', 'WHILE', 'REPEAT', 'DO', 'DATALIST', 'STRDATA', 'NOSKIP']);
/** 分支语句（与 scanner BRANCH_KINDS 一致） */
const CTX_BRANCH_KINDS = new Set(['ELSEIF', 'ELSE', 'CASE', 'CASEELSE', 'CATCH']);
/** 闭合语句（与 scanner CLOSE_KINDS 一致） */
const CTX_CLOSE_KINDS = new Set([
  'ENDIF',
  'ENDSELECT',
  'NEXT',
  'WEND',
  'REND',
  'LOOP',
  'ENDDATA',
  'ENDLIST',
  'ENDNOSKIP',
  'ENDCATCH',
  'ENDFUNC',
]);

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
    if (CTX_OPEN_KINDS.has(s.kind) || CTX_TRY_CATCH_OPEN.has(s.kind) || CTX_TRY_LIST_OPEN.has(s.kind) || CTX_PRINTDATA_OPEN.has(s.kind)) {
      stack.push({ depth: s.depth, seg: `s${++segCounter}` });
    } else if (CTX_BRANCH_KINDS.has(s.kind)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.depth === s.depth) {
          stack[i] = { depth: s.depth, seg: `s${++segCounter}` };
          break;
        }
      }
    } else if (CTX_CLOSE_KINDS.has(s.kind)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.depth === s.depth) {
          stack.length = i;
          break;
        }
      }
    }
    // 其余（SIF / 未知 kind）：不动栈
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
 * 赋值语句识别：`LOCAL(:n)? = RHS` 与 `ARG(:n)? = RHS` 等
 * （`== / != / <= / >=` 不匹配）。
 * v0.2 第七批：目标扩展到 ARG/ARGS（参数槽直线赋值——口上惯用法
 * `SIF !ARG / ARG = TARGET` 参数补位；静态叠加层不消费，
 * 内联解释器按顺序执行语义消费）。
 * 复合赋值（`+=` 等）→ 记为 opaque 载体的"失效点"（旧值不可知 → 之后读取降级 unknown）。
 */
const ASSIGN_RE = /^(LOCAL|LOCALS|RESULT|RESULTS|ARG|ARGS)(?::(\d+))?\s*([+\-*/%]?=)(?!=)\s*(.*)$/i;

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
    const trimmed = raw.trim();

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

    const m = ASSIGN_RE.exec(trimmed);
    if (!m) continue;
    const name = m[1]!.toUpperCase();
    if (!ASSIGNABLE_LOCALS.has(name)) continue;
    const index = m[2] ? Number(m[2]) : 0;
    const op = m[3]!;
    const rhs = sliceInlineComment(m[4] ?? '').trim();
    if (rhs.length === 0) continue;

    out.push({
      name: name as FunctionAssignment['name'],
      index,
      expr: op === '=' ? parseExpression(rhs) : { kind: 'opaque', text: `${op} ${rhs}` },
      text: rhs,
      line: i,
      context: contextOf(i),
    });
  }
  return out;
}

export interface ExtractFunctionOptions {
  /** 语义标注（可选）：给依赖打上人类可读标签 */
  lookup?: SchemaLookup;
  /** 原始行（additive）：提供时把 `{`…`}` 多行条件拼接后再解析；缺省行为不变 */
  lines?: readonly string[];
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
    const trimmed = raw.trim();
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
 * 孤行 `{` 起、孤行 `}` 止，块内物理行**按一个空格**拼成一条逻辑行。
 *
 * 骨架扫描只有单行视野，`IF A &&` 折行时只拿到半句 ⇒ 解析整体降级 opaque。
 * 这里在**既有语句边界**（孤行 `{` / `}`）内补全原文，再交给同一个表达式解析器。
 *
 * @returns 拼接后的表达式；语句不在块内 / 块未闭合 ⇒ null（调用方保留原样：
 *          残句继续 opaque，opaque 仍可查，绝不猜）。
 */
export function joinBracedExpression(
  stmtLine: number,
  expression: string,
  lines: readonly string[],
): string | null {
  // 语句前最近的非空 / 非注释行必须是孤立的 `{`（Emuera 要求 `{` 行只含 `{`）
  let open = stmtLine - 2;
  while (open >= 0) {
    const probe = (lines[open] ?? '').trim();
    if (probe === '' || probe.startsWith(';')) {
      open--;
      continue;
    }
    break;
  }
  if (open < 0 || (lines[open] ?? '').trim() !== '{') return null;

  const parts: string[] = [];
  const head = expression.trim();
  if (head.length > 0) parts.push(head);
  for (let i = stmtLine; i < lines.length; i++) {
    const probe = (lines[i] ?? '').trim();
    if (probe === '}') return parts.join(' ');
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
   * 只收 IF / ELSEIF / SIF（本批判据就是"多行 IF 条件不进谓词"）：
   * CASE 的多行值列表在现状下**不是 opaque**（`CASE 1, 2,` 的尾逗号只是少展开后续行），
   * 拼它会凭空抬高谓词总数（真语料 +311，全是补全的 CASE 值）⇒ 收窄，留作后续单。
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
        for (const p of expandCase(s, top?.subject ?? null)) {
          preds.push({
            kind: 'CASE',
            text: s.expression,
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

/** 明细抽取的数据源（聚合路径不提供 → 不收集赋值 / 不填上下文） */
export interface PredicateSourceLines {
  /** 函数体结束行（1 基，含） */
  endLine: number;
  /** 文件全部行（按 `\n` 切分，与 scanControlFlow 的 EOL 规范化一致） */
  lines: readonly string[];
}

/**
 * 抽取单函数谓词明细（含控制流骨架；**不聚合**——供快照回放逐条求值）。
 * 提供 `source` 时同时收集本地量赋值并填充谓词分支上下文（v0.2 第六批）。
 */
export function extractFunctionPredicates(
  fn: FunctionIdentity,
  stmts: readonly ControlFlowStatement[],
  source?: PredicateSourceLines,
): FunctionPredicates {
  const contextOf = source ? buildContextLookup(stmts) : null;
  return {
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    endLine: source?.endLine ?? fn.startLine,
    statements: [...stmts],
    predicates: collectPredicates(stmts, {
      ...(contextOf ? { contextOf } : {}),
      ...(source ? { lines: source.lines } : {}),
    }),
    assignments: source
      ? collectAssignments(source.lines, fn.startLine + 1, source.endLine, contextOf!)
      : [],
    returns: source ? collectReturns(source.lines, fn.startLine + 1, source.endLine) : [],
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
  const preds = collectPredicates(stmts, opts.lines ? { lines: opts.lines } : {});

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
