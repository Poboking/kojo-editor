/**
 * 用户函数有界内联解释器（v0.2 第七批；游戏无关；本插件私有）。
 *
 * 定位（实施记录 §5.13，docs/IMPLEMENTATION-LOG.md）：`call` 未知的最大来源是口上域内的 `#FUNCTION` 纯助手
 * （实测 K49 语料：陷落状态 ×1830 + 关系_310 ×160 ≈ call 谓词的 71%）——
 * 它们的函数体全部为可解释形态（IF / ELSEIF / SIF / RETURNF + 本地量直线赋值）。
 * 对这类函数做**顺序内联解释**：绑定调用点实参 → 逐行执行 → RETURNF 求值返回。
 *
 * 引擎语义依据（源码核验，v22）：
 * - 表达式调用用户函数 → Process.GetValue（Process.cs:407-437）：IntoFunction
 *   （参数槽绑定，ConvertArg 语义）→ 顺序执行函数体 → ReturnF 赋值 MethodReturnValue；
 * - `#FUNCTION` 头（BuiltInFunctionCode.cs:103-104）：RETURNF 返回值；落到函数尾
 *   无 RETURNF → MethodReturnValue 为残留值（不可信 → 本层 unknown）；
 * - 签名声明槽调用时必有值（实参或默认 0/''，Process.CalledFunction.cs:162-239）；
 *   `CALL FOO`（无括号）= 全部声明槽取默认值；
 * - 参数槽是 1D 数组：函数体内可再赋值（`SIF !ARG / ARG = TARGET` 参数补位惯用法）
 *   ——直线执行语义下，赋值只在该行被执行时生效（SIF 条件为真），因此本解释器
 *   是**顺序执行**而非静态数据流（v0.2 第六批的叠加层语义在此不适用）；
 * - 调用深度上限 100（Process.cs:410）；本解释器取更保守的界（防循环）。
 *
 * 拒绝语义（有界内联的能力边界，一律 reject → unknown('call')，绝不猜测）：
 * - 函数不在口上索引域 / 明细不可得；无 `#FUNCTION` 头；`#FUNCTIONS`（字符串函数）；
 * - `#DIM` 局部声明（用户局部变量未建模）；SELECTCASE / 循环 / GOTO 标签；
 * - CALL / PRINT 等副作用语句；复合赋值（`+=`）；嵌套调用超出深度界。
 */

import type {
  ConditionExpr,
  FunctionPredicates,
  ReplayUnknownCode,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { isBuiltinName } from './builtins';
import { evaluateExpr, type EvalContext } from './evaluate';

/** 内联调用深度界（引擎上限 100；语料无深递归，保守小界防循环） */
export const MAX_INLINE_DEPTH = 8;

function unknownValue(code: ReplayUnknownCode, message: string): ReplayValue {
  return { kind: 'unknown', unknown: { code, message } };
}

// ---------------------------------------------------------------------------
// 预编译：函数体行 → 指令序列
// ---------------------------------------------------------------------------

/** 头行参数声明槽 */
export interface ParamSlot {
  name: 'ARG' | 'ARGS';
  index: number;
  str: boolean;
}

type InlineOp =
  | { op: 'if'; expr: ConditionExpr; line: number; nextBranch: number; endAfter: number }
  | { op: 'elseif'; expr: ConditionExpr; line: number; nextBranch: number; endAfter: number }
  | { op: 'else'; line: number; endAfter: number }
  | { op: 'endif'; line: number }
  | { op: 'sif'; expr: ConditionExpr; line: number }
  | { op: 'returnf'; expr: ConditionExpr; line: number }
  | { op: 'assign'; name: string; index: number; expr: ConditionExpr; line: number };

export interface InlineBody {
  kind: 'ok';
  ops: InlineOp[];
  slots: ParamSlot[];
  /** 是否含参数补位（SIF + ARG 赋值；诊断展示用） */
  hasParamDefaulting: boolean;
}

export interface InlineReject {
  kind: 'reject';
  reason: string;
}

export type AnalyzedFunction = InlineBody | InlineReject;

/** 可赋值目标族（与 extractor ASSIGN_RE 同源；插件间禁 import，就地实现） */
const ASSIGN_TARGETS = 'LOCAL|LOCALS|RESULT|RESULTS|ARG|ARGS';
const ASSIGN_RE = new RegExp(`^(${ASSIGN_TARGETS})(?::(\\d+))?\\s*=(?!=)`, 'i');
/** 复合赋值（+= 等）→ reject（旧值不可知） */
const COMPOUND_ASSIGN_RE = new RegExp(`^(${ASSIGN_TARGETS})(?::(\\d+))?\\s*[+\\-*/%]=`, 'i');

/** 行首 token（大写） */
function firstToken(line: string): string {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line);
  return m ? m[0].toUpperCase() : '';
}

/** 头行解析：`@NAME(decl, decl, ...)` → 参数槽（非 ARG/ARGS 声明 → reject） */
function parseHeadLine(head: string): { slots: ParamSlot[] } | { error: string } {
  const m = /^@[^()]*\((.*)\)\s*$/.exec(head.trim());
  if (!m) {
    // 无括号头（@FOO）或带非法括号形态 → 无参或拒绝
    if (head.includes('(')) return { error: `函数头参数列表无法解析：${head.trim().slice(0, 60)}` };
    return { slots: [] };
  }
  const slots: ParamSlot[] = [];
  for (const decl of m[1]!.split(',')) {
    const d = decl.trim().toUpperCase();
    if (d.length === 0) continue;
    const dm = /^(ARG|ARGS)(?::(\d+))?$/.exec(d);
    if (!dm) return { error: `函数头声明槽不支持内联（仅 ARG/ARGS）：${d}` };
    const index = dm[2] ? Number(dm[2]) : 0;
    slots.push({ name: dm[1] as 'ARG' | 'ARGS', index, str: dm[1] === 'ARGS' });
  }
  return { slots };
}

/**
 * 预编译单个函数（纯函数）。
 * @param detail 谓词明细（AST 来源：predicates / assignments / returns）
 * @param lines 文件全部行
 */
export function analyzeInlineBody(detail: FunctionPredicates, lines: readonly string[]): AnalyzedFunction {
  // ---- AST 索引：按行号取（同一条语句的 AST 由 extractor 解析，本层不重复解析） ----
  const predByLine = new Map<number, ConditionExpr>();
  for (const p of detail.predicates) {
    if (!predByLine.has(p.line)) predByLine.set(p.line, p.expr);
  }
  const assignByLine = new Map<number, { name: string; index: number; expr: ConditionExpr }>();
  for (const a of detail.assignments) {
    if (!assignByLine.has(a.line)) {
      assignByLine.set(a.line, { name: a.name, index: a.index, expr: a.expr });
    }
  }
  const returnByLine = new Map<number, ConditionExpr>();
  for (const r of detail.returns) {
    if (!returnByLine.has(r.line)) returnByLine.set(r.line, r.expr);
  }

  // ---- 头行 + 头部指令区 ----
  const head = (lines[detail.startLine - 1] ?? '').trim();
  const headSlots = parseHeadLine(head);
  if ('error' in headSlots) return { kind: 'reject', reason: headSlots.error };

  let isFunctionHead = false;
  let hasFunctionsHead = false;
  {
    let inSkip = false;
    for (let i = detail.startLine + 1; i <= Math.min(detail.endLine, detail.startLine + 12); i++) {
      const t = (lines[i - 1] ?? '').trim();
      if (inSkip) {
        if (t === '[SKIPEND]') inSkip = false;
        continue;
      }
      if (t === '[SKIPSTART]') {
        inSkip = true;
        continue;
      }
      if (t.length === 0 || t.startsWith(';')) continue;
      if (t.startsWith('#')) {
        const up = t.toUpperCase();
        if (up.startsWith('#FUNCTIONS')) hasFunctionsHead = true;
        else if (up.startsWith('#FUNCTION')) isFunctionHead = true;
        else if (up.startsWith('#DIM')) {
          return { kind: 'reject', reason: `含 #DIM 局部声明（用户局部变量未建模）：${t.slice(0, 40)}` };
        }
        continue; // #LOCALSIZE 等声明对执行无影响
      }
      break; // 第一条有效语句 → 指令区结束
    }
  }
  if (hasFunctionsHead || (!isFunctionHead && /^#FUNCTIONS\b/.test(head.toUpperCase()))) {
    return { kind: 'reject', reason: '字符串函数（#FUNCTIONS）不支持内联' };
  }
  if (!isFunctionHead) {
    return { kind: 'reject', reason: '无 #FUNCTION 头（非表达式函数）' };
  }

  // ---- 体行分类 → op 序列 ----
  interface RawOp {
    op: InlineOp['op'];
    line: number;
    expr?: ConditionExpr;
    name?: string;
    index?: number;
  }
  const raws: RawOp[] = [];
  let inSkipBlock = false;

  for (let i = detail.startLine + 1; i <= detail.endLine && i <= lines.length; i++) {
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
    if (trimmed.startsWith('@') || trimmed.startsWith('$')) {
      return { kind: 'reject', reason: `函数体内出现标签/新函数头（GOTO 语义不支持）：${trimmed.slice(0, 40)}` };
    }
    if (trimmed === '[SKIPSTART]' || trimmed === '[SKIPEND]') continue;

    const token = firstToken(trimmed);
    switch (token) {
      case 'IF':
      case 'ELSEIF':
      case 'SIF': {
        const expr = predByLine.get(i);
        if (!expr) return { kind: 'reject', reason: `第 ${i} 行 ${token} 条件无解析记录` };
        raws.push({ op: token.toLowerCase() as 'if' | 'elseif' | 'sif', line: i, expr });
        break;
      }
      case 'ELSE':
        raws.push({ op: 'else', line: i });
        break;
      case 'ENDIF':
        raws.push({ op: 'endif', line: i });
        break;
      case 'RETURNF': {
        const expr = returnByLine.get(i);
        if (!expr) return { kind: 'reject', reason: `第 ${i} 行 RETURNF 无解析记录` };
        raws.push({ op: 'returnf', line: i, expr });
        break;
      }
      default: {
        const am = assignByLine.get(i);
        if (am && ASSIGN_RE.test(trimmed)) {
          if (COMPOUND_ASSIGN_RE.test(trimmed)) {
            return { kind: 'reject', reason: `第 ${i} 行复合赋值不支持内联：${trimmed.slice(0, 40)}` };
          }
          raws.push({ op: 'assign', line: i, name: am.name, index: am.index, expr: am.expr });
          break;
        }
        return { kind: 'reject', reason: `第 ${i} 行语句不支持内联：${trimmed.slice(0, 40)}` };
      }
    }
  }

  // ---- SIF 体校验：下一 op 必须是 assign / returnf ----
  for (let k = 0; k < raws.length; k++) {
    if (raws[k]!.op !== 'sif') continue;
    const next = raws[k + 1];
    if (!next || (next.op !== 'assign' && next.op !== 'returnf')) {
      return { kind: 'reject', reason: `第 ${raws[k]!.line} 行 SIF 体不是单条赋值/RETURNF` };
    }
  }

  // ---- IF 链配对（栈式；孤儿分支/闭合 → reject，执行语义要求规整） ----
  const ops: InlineOp[] = [];
  interface Chain {
    branchIdxs: number[]; // if / elseif 的 ops 下标
    elseIdx: number | null;
  }
  const chainStack: Chain[] = [];
  for (const r of raws) {
    if (r.op === 'if') {
      chainStack.push({ branchIdxs: [ops.length], elseIdx: null });
      ops.push({ op: 'if', expr: r.expr!, line: r.line, nextBranch: -1, endAfter: -1 });
    } else if (r.op === 'elseif') {
      const top = chainStack[chainStack.length - 1];
      if (!top) return { kind: 'reject', reason: `第 ${r.line} 行孤儿 ELSEIF（IF 链不规整）` };
      top.branchIdxs.push(ops.length);
      ops.push({ op: 'elseif', expr: r.expr!, line: r.line, nextBranch: -1, endAfter: -1 });
    } else if (r.op === 'else') {
      const top = chainStack[chainStack.length - 1];
      if (!top || top.elseIdx !== null) {
        return { kind: 'reject', reason: `第 ${r.line} 行孤儿 ELSE（IF 链不规整）` };
      }
      top.elseIdx = ops.length;
      ops.push({ op: 'else', line: r.line, endAfter: -1 });
    } else if (r.op === 'endif') {
      const top = chainStack.pop();
      if (!top) return { kind: 'reject', reason: `第 ${r.line} 行孤儿 ENDIF（IF 链不规整）` };
      const endAfter = ops.length + 1;
      for (let k = 0; k < top.branchIdxs.length; k++) {
        const b = top.branchIdxs[k]!;
        const branchOp = ops[b] as Extract<InlineOp, { op: 'if' | 'elseif' }>;
        // 求值假 → 跳到下一分支：ELSEIF = 其 op 位（需求值）；ELSE = 直接进体
        // （else op 本身只在"分支体自然掉落"时执行 = 跳 endAfter；从条件假跳来的
        //   必须绕过 else op，否则会被当作"前分支已完成"而跳过 ELSE 体）
        branchOp.nextBranch =
          k + 1 < top.branchIdxs.length
            ? top.branchIdxs[k + 1]!
            : top.elseIdx !== null
              ? top.elseIdx + 1
              : ops.length;
        branchOp.endAfter = endAfter;
      }
      if (top.elseIdx !== null) (ops[top.elseIdx] as Extract<InlineOp, { op: 'else' }>).endAfter = endAfter;
      ops.push({ op: 'endif', line: r.line });
    } else {
      ops.push(r as InlineOp);
    }
  }
  if (chainStack.length > 0) {
    return { kind: 'reject', reason: 'IF 链未闭合（缺 ENDIF）' };
  }

  const hasParamDefaulting = raws.some((r) => r.op === 'sif') && raws.some((r) => r.op === 'assign' && (r.name === 'ARG' || r.name === 'ARGS'));
  return { kind: 'ok', ops, slots: headSlots.slots, hasParamDefaulting };
}

// ---------------------------------------------------------------------------
// 执行：绑定实参 → PC 顺序解释 → RETURNF
// ---------------------------------------------------------------------------

/** 内联环境（本地量槽位 → 值；key = NAME:idx 大写） */
type InlineEnv = Map<string, ReplayValue>;

const LOCAL_FAMILY = new Set(['LOCAL', 'LOCALS', 'RESULT', 'RESULTS', 'ARG', 'ARGS']);

/** 槽位键（裸名 ≡ 0 号槽） */
function slotKey(name: string, index: number): string {
  return `${name}:${index}`;
}

export interface InlineManagerDeps {
  /** 谓词明细（condition.extractor；null = 函数不在口上索引域） */
  functionPredicates(normalizedName: string): Promise<FunctionPredicates | null>;
  /** 读文件 → 全部行（engine 注入，内部带文本缓存） */
  readFileLines(filePath: string): Promise<string[]>;
  log: { warn(msg: string): void };
}

/**
 * 内联管理器：analyze 缓存 + 同步 resolveCall。
 *
 * 用法（engine.replayFunction）：先 `await preanalyze(detail)`（递归预热全部
 * 被调函数，含内联体内嵌套调用），再以同步 `resolveCall` 注入 EvalContext——
 * 执行期缓存必命中（miss = 竞态，log warn 并回落 unknown('call')）。
 */
export class InlineManager {
  private readonly cache = new Map<string, AnalyzedFunction | null>();
  private readonly inFlight = new Map<string, Promise<AnalyzedFunction | null>>();

  constructor(private readonly deps: InlineManagerDeps) {}

  /** 项目切换 / 索引重建时清空（函数体可能已变） */
  reset(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /** analyze 单函数（缓存共享；与在途解析合并） */
  private async ensureAnalyzed(name: string): Promise<AnalyzedFunction | null> {
    const key = name.toUpperCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const task = (async (): Promise<AnalyzedFunction | null> => {
      const detail = await this.deps.functionPredicates(key);
      if (!detail) return null; // 不在口上索引域（引擎内置 / 游戏侧函数）
      let lines: string[];
      try {
        lines = await this.deps.readFileLines(detail.filePath);
      } catch (err) {
        this.deps.log.warn(`Inline analyze read failed: ${detail.filePath} — ${String(err)}`);
        return null;
      }
      const analyzed = analyzeInlineBody(detail, lines);
      if (analyzed.kind === 'reject') {
        this.deps.log.warn(`Inline reject: ${key} — ${analyzed.reason}`);
      }
      return analyzed;
    })();

    this.inFlight.set(key, task);
    const result = await task;
    this.inFlight.delete(key);
    this.cache.set(key, result);
    return result;
  }

  /**
   * 递归预热：先 analyze **函数自身**（resolveCall 需要它命中缓存；自递归/被
   * 嵌套引用均依赖），再从 detail 的全部 AST（谓词 / 赋值 / 返回）出发，BFS
   * 收集用户函数调用并逐个 analyze；内联体内的嵌套调用随 analyze 结果继续
   * 展开（visited 防环；执行期深度界另有兜底）。完成后 resolveCall 同步缓存必命中。
   */
  async preanalyze(detail: FunctionPredicates): Promise<void> {
    const visited = new Set<string>();
    const queue: string[] = [];

    const collectFromExpr = (expr: ConditionExpr): void => {
      switch (expr.kind) {
        case 'call':
          if (!isBuiltinName(expr.name)) {
            const key = expr.name.toUpperCase();
            if (!visited.has(key)) queue.push(key);
          }
          for (const a of expr.args) collectFromExpr(a);
          break;
        case 'unary':
          collectFromExpr(expr.operand);
          break;
        case 'binary':
          collectFromExpr(expr.left);
          collectFromExpr(expr.right);
          break;
        case 'ternary':
          collectFromExpr(expr.cond);
          collectFromExpr(expr.then);
          collectFromExpr(expr.else);
          break;
        default:
          break;
      }
    };
    const collectFromBody = (body: InlineBody): void => {
      for (const op of body.ops) {
        if (op.op === 'if' || op.op === 'elseif' || op.op === 'sif' || op.op === 'returnf' || op.op === 'assign') {
          collectFromExpr(op.expr);
        }
      }
    };

    // 自身先入缓存（自递归 / 被嵌套调用引用时命中）
    const selfKey = detail.normalizedName.toUpperCase();
    visited.add(selfKey);
    const self = await this.ensureAnalyzed(selfKey);
    if (self && self.kind === 'ok') collectFromBody(self);

    for (const p of detail.predicates) collectFromExpr(p.expr);
    for (const a of detail.assignments) collectFromExpr(a.expr);
    for (const r of detail.returns) collectFromExpr(r.expr);

    while (queue.length > 0) {
      const key = queue.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const analyzed = await this.ensureAnalyzed(key);
      if (analyzed && analyzed.kind === 'ok') collectFromBody(analyzed);
    }
  }

  /**
   * 同步内联调用（preanalyze 后缓存必命中；miss → null → unknown('call')）。
   * @param callerCtx 调用方上下文（实参求值通道：外层 read / overlay / 递归内联）
   * @param depth 当前内联深度
   */
  resolveCall(
    name: string,
    args: readonly ConditionExpr[],
    callerCtx: EvalContext,
    depth: number,
  ): ReplayValue | null {
    if (depth > MAX_INLINE_DEPTH) return null;
    const key = name.toUpperCase();
    const analyzed = this.cache.get(key);
    if (analyzed === undefined || analyzed === null || analyzed.kind === 'reject') return null;
    if (analyzed.ops.length === 0) {
      return unknownValue('call', `函数体为空，无法内联：${name}()`);
    }
    return this.runBody(name, analyzed, args, callerCtx, depth);
  }

  /** 执行一个内联函数体（绑定 → PC 解释） */
  private runBody(
    name: string,
    body: InlineBody,
    args: readonly ConditionExpr[],
    callerCtx: EvalContext,
    depth: number,
  ): ReplayValue | null {
    const env: InlineEnv = new Map();

    // ---- 实参绑定：调用点实参按序求值 → 声明槽（多余实参 → ARG:后续槽，引擎语义）；缺省槽 = 0/'' ----
    const bind = (slot: ParamSlot, v: ReplayValue): ReplayValue | null => {
      if (v.kind === 'unknown') return v;
      if (slot.str) {
        if (typeof v.value !== 'string') {
          return unknownValue('type', `${name} 第 ${slot.index} 槽（${slot.name}）要求字符串：${JSON.stringify(v.value)}`);
        }
      } else if (typeof v.value !== 'number') {
        return unknownValue('type', `${name} 第 ${slot.index} 槽（${slot.name}）要求数值：${JSON.stringify(v.value)}`);
      }
      env.set(slotKey(slot.name, slot.index), v);
      return null;
    };
    for (let i = 0; i < args.length; i++) {
      const argExpr = args[i]!;
      const v = evaluateExpr(argExpr, callerCtx);
      // 槽类型：优先声明槽；多余实参按数值 ARG 槽
      const slot: ParamSlot =
        i < body.slots.length
          ? body.slots[i]!
          : { name: 'ARG', index: i, str: false };
      const err = bind(slot, v);
      if (err) return err;
    }
    for (const slot of body.slots) {
      if (!env.has(slotKey(slot.name, slot.index))) {
        env.set(slotKey(slot.name, slot.index), {
          kind: 'value',
          value: slot.str ? '' : 0, // 引擎默认槽值（ConvertArg 语义）
        });
      }
    }

    // ---- 求值通道：环境读（含索引段替换）→ 视图回落；递归内联 ----
    const readInline = (ref: VariableRef): ReplayValue => readWithEnv(ref, env, callerCtx.read, name);
    const ctx: EvalContext = {
      read: readInline,
      resolveCall: (n, a) => this.resolveCall(n, a, ctx, depth + 1), // 自引用闭包 = 递归内联
    };
    // ---- PC 解释 ----
    // pendingEval：标记"pc 到达 elseif 时是条件假跳转到达（需求值）还是分支体
    // 自然掉落（跳 endAfter）"。if 假 / elseif 假 → 设 true；求值后即清。
    let pc = 0;
    let pendingEval = false;
    while (pc >= 0 && pc < body.ops.length) {
      const op = body.ops[pc]!;
      switch (op.op) {
        case 'if': {
          // if 是链顶：顺序到达即求值（嵌套内层 IF = 外层体的正常组成部分）
          const v = evaluateExpr(op.expr, ctx);
          if (v.kind === 'unknown') return v; // 控制流未知 → 传播（保留内层原因）
          const n = v.value;
          if (typeof n !== 'number') {
            return unknownValue('non-numeric', `${name} 第 ${op.line} 行条件为字符串：${JSON.stringify(n)}`);
          }
          if (n !== 0) {
            pc++; // 进入本分支体
          } else {
            pc = op.nextBranch; // 下一分支（elseif op / else 体首 op / endif op）
            pendingEval = body.ops[pc]!.op === 'elseif';
          }
          break;
        }
        case 'elseif': {
          if (!pendingEval) {
            pc = op.endAfter; // 自然掉落 = 前面分支已执行完
            break;
          }
          pendingEval = false;
          const v = evaluateExpr(op.expr, ctx);
          if (v.kind === 'unknown') return v;
          const n = v.value;
          if (typeof n !== 'number') {
            return unknownValue('non-numeric', `${name} 第 ${op.line} 行条件为字符串：${JSON.stringify(n)}`);
          }
          if (n !== 0) {
            pc++;
          } else {
            pc = op.nextBranch;
            pendingEval = body.ops[pc]!.op === 'elseif';
          }
          break;
        }
        case 'else':
          pc = op.endAfter; // 只被自然到达（条件假跳转已绕过 else op 进体）
          break;
        case 'endif':
          pc++;
          break;
        case 'sif': {
          const v = evaluateExpr(op.expr, ctx);
          if (v.kind === 'unknown') return v;
          const n = v.value;
          if (typeof n !== 'number') {
            return unknownValue('non-numeric', `${name} 第 ${op.line} 行 SIF 条件为字符串：${JSON.stringify(n)}`);
          }
          pc += n !== 0 ? 1 : 2; // 真 → 执行体（下一 op）；假 → 跳过体
          break;
        }
        case 'returnf': {
          const v = evaluateExpr(op.expr, ctx);
          if (v.kind === 'unknown') return v;
          if (typeof v.value !== 'number') {
            return unknownValue('type', `${name} 为 #FUNCTION 数值函数，RETURNF 结果非数值：${JSON.stringify(v.value)}`);
          }
          return v;
        }
        case 'assign': {
          const v = evaluateExpr(op.expr, ctx);
          if (v.kind === 'unknown') return v; // RHS 未知 → 不写环境，传播
          env.set(slotKey(op.name, op.index), v);
          pc++;
          break;
        }
      }
    }
    return unknownValue('call', `${name} 函数体执行到末尾无 RETURNF（引擎语义：返回值不可信）`);
  }
}

// ---------------------------------------------------------------------------
// 环境读（本地量族 + 索引段替换 + 视图回落）
// ---------------------------------------------------------------------------

/**
 * 内联环境的变量读取：
 * 1. 本地量族引用 → 环境查（ARG/ARGS 未命中 = 引擎默认槽值 0/''；LOCAL 族未命中 = unknown）；
 * 2. 索引段为本地量名（`TALENT:ARG:恋人`）→ 段值替换（环境数值）；
 * 3. 其余 → 视图回落（外层 ctx.read）。
 */
function readWithEnv(ref: VariableRef, env: InlineEnv, baseRead: EvalContext['read'], fnName: string): ReplayValue {
  const name = ref.name.toUpperCase();

  if (LOCAL_FAMILY.has(name)) {
    if (ref.indices.length > 1) {
      return unknownValue('too-many-args', `${fnName} 内本地量引用参数过多：${ref.text}`);
    }
    let index = 0;
    if (ref.indices.length === 1) {
      const seg = ref.indices[0]!;
      if (/^-?\d+$/.test(seg)) index = Number(seg);
      else {
        return unknownValue('dynamic-index', `${fnName} 内本地量索引段无法静态解析：${ref.text}`);
      }
    }
    const hit = env.get(slotKey(name, index));
    if (hit) return hit;
    if (name === 'ARG') return { kind: 'value', value: 0 }; // 引擎默认槽值语义
    if (name === 'ARGS') return { kind: 'value', value: '' };
    return unknownValue('local-no-write', `${fnName} 内本地量无可见赋值：${ref.text}`);
  }

  // 索引段替换：本地量名段 → 环境值（数值段替换；字符串值段不合法 → unknown）
  if (ref.indices.length > 0) {
    let replaced = false;
    const indices: string[] = [];
    for (const seg of ref.indices) {
      const segUpper = seg.toUpperCase();
      if (LOCAL_FAMILY.has(segUpper)) {
        const v = env.get(slotKey(segUpper, 0));
        let value: number | string | undefined = v?.kind === 'value' ? v.value : undefined;
        if (value === undefined) {
          if (segUpper === 'ARG') value = 0;
          else if (segUpper === 'ARGS') value = '';
        }
        if (typeof value !== 'number') {
          return unknownValue(
            'dynamic-index',
            `${fnName} 内索引段 ${seg} 的本地量值不可用作下标：${JSON.stringify(value)}`,
          );
        }
        indices.push(String(value));
        replaced = true;
      } else {
        indices.push(seg);
      }
    }
    if (replaced) {
      return baseRead({ name: ref.name, indices, text: ref.text });
    }
  }

  return baseRead(ref);
}
