/**
 * 计数循环的循环量求值（KW-15C 1103；游戏无关；本插件私有）。
 *
 * 解决的形状（真语料实测：`FOR LOCAL,0,5` 是官方常见写法，语料 3,182 条 `FOR` 里
 * 1,886 条把循环量绑在 `LOCAL` 上）：
 *
 * ```
 * FOR LOCAL,0,5
 *   IF PALAM:LOCAL + CUP:LOCAL > 9000   ← 体内第一条真代码行（KW-15C 档）
 *     LOCAL:1 = 2
 *     BREAK
 *   ELSEIF PALAM:LOCAL + CUP:LOCAL >= 5000  ← 窗口干净的更深行（KW-15D 档）
 * ```
 *
 * 引擎事实（只用到这一条，且不需要断言 era 的 CALL / 残留值作用域）：`FOR` 把头值写进
 * 循环量，然后**立刻**落到体内第一条语句。因此"使用点恰是体内第一条真代码行"这个点位上，
 * 中间一条语句都没执行过，循环量必然是头值 ⇒ 取值落在抽取侧给的**闭区间**里
 * （区间是端点折出来的超近似：终值到底取不取、步进怎么走都不必断言，宽一点的区间
 * 只会让"全体一致"更难成立，不会让它假成立）。
 *
 * **KW-15D 1103 放宽（窗口档）**：使用点在体内更深行也收，前提是「循环头到使用点之间
 * 的每一行都被证明写不到循环量槽位」。三条前提的判性（详见批次提交信息）：
 * - 体内改写：抽取侧 `assignments` 只认字面数字下标的 `=` 族赋值，语料实存
 *   `LOCAL:LCOUNT = ARG` 这类**动态下标写**与 SIF 内联赋值（都不进表）⇒ "查表无赋值"
 *   不成立；改用**按行白名单**：窗口内只许 注释/空行/SKIP 区、无调用形的纯结构行
 *   （IF/ELSEIF/ELSE/ENDIF/SELECTCASE/CASE/DEFAULT/ENDSELECT）、`BREAK`/`CONTINUE`、
 *   异槽字面赋值（`LOCAL:1 = 2` 写不到 LOCAL:0）。白名单外（CALL/FOR/GOTO/PRINT/SIF/
 *   同槽或动态下标写/未知动词）一律判脏——**宁少勿错**。
 * - CALL 改写调用者槽位：引擎作用域事实**无出处**（本机无引擎文档）⇒ 不硬吃：
 *   窗口含任何调用形态（行首 CALL 族、结构行里的 `名字(`）直接判脏，规则零依赖
 *   "被调用体动不动得着调用者的 LOCAL"。
 * - 迭代取值/步进/终值：窗口干净 ⇒ 第 k 次迭代使用点的值＝该次循环头写入的值，与
 *   `firstBodyLine` 同迭代同值——值集与 KW-15C 已交付口径**逐字相同**，零新增断言，
 *   闭区间超近似继续安全。
 *
 * 无行文本（`lines` 缺省，纯函数调用方/旧测试）⇒ 只走 KW-15C 的第一条行档，逐字旧行为。
 *
 * 三值口径（红线：值域有限 ≠ 判定得出）：
 * - 区间内**每个**候选值都把谓词判成同一个 true / false ⇒ 该谓词就是这个值
 *   （任意一次执行落到这里都长这样，与循环执行了几轮无关）；
 * - 候选值结论不一致 ⇒ 仍然 unknown，但换一个**更准的机器码** `local-range`
 *   （人话：循环量取值不止一个、这些取值判出的结果不一样），不再谎报成
 *   「具名索引无法解析」或「本地量无可见赋值」；
 * - 候选值一律判不出且原因相同 ⇒ 原样透传那枚未知（`RAND` 那类不可约真随机
 *   因此继续按 `pseudo` 记账，不被本层改写、也不新增计数）。
 *
 * 抽取侧的收口条件（见契约 `FunctionLoopCounter`）决定了这里能信任什么：字面端点、
 * 区间 ≤ 64 格、体内无标签行、`FOR` 与 `NEXT` 配对完好。
 */

import type {
  ConditionExpr,
  FunctionLoopCounter,
  FunctionPredicates,
  ReplayOutcome,
} from '@kojo/plugin-api';
import { erbCodeBodyOf } from '@kojo/plugin-api';
import { judgeCondition, type EvalContext } from './evaluate';
import { LOCAL_FAMILY_SLOTS, type OverlayPosition } from './locals';

/** 一个循环量槽位在当前点位的候选取值 */
interface LoopVar {
  name: string;
  index: number;
  values: number[];
  /** `FOR` 行（人话提示里的定位用） */
  openLine: number;
}

/** 逐值试算的组合上限（多枚循环量同时生效时的笛卡尔积；超限即回落原路径） */
const MAX_COMBOS = 32;

// ---------------------------------------------------------------------------
// 窗口白名单（KW-15D 1103）：证明「循环头 → 使用点」每行都写不到循环量槽位
// ---------------------------------------------------------------------------

/** 广义本地量写目标（含 SIF 内联形；动态下标捕获为 `dyn`） */
const SLOT_WRITE_RE =
  /^(?:SIF\s+\S.*?\s)?(LOCAL|LOCALS|RESULT|RESULTS)(?::(\d+|[A-Z_][A-Z0-9_]*(?::[A-Z_][A-Z0-9_]*)*))?\s*([+\-*/%]?=)(?!=)\s*\S/i;

/** 纯结构行（只有判据、不执行任何写；判据里的调用形另行拦） */
const PURE_STRUCT_RE = /^(IF|ELSEIF|ELSE|ENDIF|SELECTCASE|CASE|DEFAULT|ENDSELECT)\b/i;

/** 只改控制流、不碰任何变量的流程行 */
const FLOW_ONLY_RE = /^(BREAK|CONTINUE)\s*$/i;

/** 引号外出现 `名字(` ＝ 表达式里可能有用户函数调用（作用域事实无出处 ⇒ 判脏） */
const CALL_SHAPE_RE = /[A-Z_][A-Z0-9_]*\s*\(/i;

function stripQuoted(s: string): string {
  return s.replace(/"[^"]*"/g, '""');
}

/**
 * 单行窗口判据：这一行是否被证明写不到 `counter` 的槽位（true = 干净可越过）。
 * 白名单外的任何行形态（CALL/FOR/NEXT/GOTO/PRINT/SIF 裸行/同槽写/动态下标写/
 * 未知动词…）一律 false——判不准就脏，这是本档唯一允许的近似方向。
 */
function windowLineIsClean(raw: string, counter: FunctionLoopCounterLike, inSkip: { v: boolean }): boolean {
  const body = erbCodeBodyOf(raw.trim());
  // SKIP 区（引擎不执行）：区内整段算干净；判据与抽取侧 codeAt 同源
  if (inSkip.v) {
    if (body === '[SKIPEND]') inSkip.v = false;
    return true;
  }
  if (body === '[SKIPSTART]') {
    inSkip.v = true;
    return true;
  }
  // 注释 / 空行 / `@` `#` 非体行（`$` 标签行抽取侧已整条不发布，进不了这里）
  if (body.length === 0 || body.startsWith(';') || body.startsWith('@') || body.startsWith('#')) return true;
  const m = SLOT_WRITE_RE.exec(body);
  if (m) {
    const name = m[1]!.toUpperCase();
    const idxRaw = m[2];
    if (idxRaw === undefined) return counter.name === name && counter.index === 0 ? false : true; // 裸槽写：命中本槽位即脏
    if (/^\d+$/.test(idxRaw)) {
      const idx = Number(idxRaw);
      return counter.name === name && counter.index === idx ? false : true; // 异槽字面写：碰不到本槽位
    }
    return false; // 动态下标写（`LOCAL:LCOUNT = ARG`）：落点未知，任何槽位都可能中招
  }
  if (FLOW_ONLY_RE.test(body)) return true;
  if (PURE_STRUCT_RE.test(body)) return !CALL_SHAPE_RE.test(stripQuoted(body)); // 判据带调用形 ⇒ 脏（前提②不硬吃）
  return false;
}

/** `windowLineIsClean` 只消费循环量的槽位身份（放宽签名，方便单测直接喂表） */
interface FunctionLoopCounterLike {
  name: string;
  index: number;
}

/** 窗口 (openLine, useLine) 全干净？（行数组 0 基、行号 1 基） */
export function loopWindowIsClean(
  lines: readonly string[],
  openLine: number,
  useLine: number,
  counter: FunctionLoopCounterLike,
): boolean {
  const inSkip = { v: false };
  for (let ln = openLine + 1; ln < useLine; ln++) {
    if (!windowLineIsClean(lines[ln - 1] ?? '', counter, inSkip)) return false;
  }
  return true;
}

/** 放宽筛选的循环量档位：`'head'` = KW-15C 第一条行档；`'window'` = KW-15D 窗口档 */
type CounterTier = { counter: FunctionLoopCounter; tier: 'head' | 'window' };

/**
 * 使用点处命中的循环量（两档）：第一条行档不需要行文本；窗口档仅在 `lines` 提供时启用。
 */
function pickCounters(
  detail: FunctionPredicates,
  at: OverlayPosition,
  lines: readonly string[] | undefined,
): CounterTier[] {
  const counters = detail.loopCounters;
  if (!counters || counters.length === 0) return [];
  const out: CounterTier[] = [];
  for (const c of counters) {
    if (at.line <= c.openLine || at.line >= c.closeLine) continue;
    if (!LOCAL_FAMILY_SLOTS.has(c.name)) continue;
    if (c.firstBodyLine === at.line) {
      out.push({ counter: c, tier: 'head' }); // 刚写完，中间零条语句——旧档原样
      continue;
    }
    // 窗口档（KW-15D）：放宽到体内任意行，代价=每行都被证明写不到该槽位（文件头判性）
    if (!lines) continue;
    if (loopWindowIsClean(lines, c.openLine, at.line, c)) out.push({ counter: c, tier: 'window' });
  }
  return out;
}

/**
 * 使用点处的循环量候选。
 */
function loopVarsAt(
  detail: FunctionPredicates,
  at: OverlayPosition,
  expr: ConditionExpr,
  lines: readonly string[] | undefined,
): LoopVar[] {
  const candidates = pickCounters(detail, at, lines);
  if (candidates.length === 0) return [];
  // 引用筛一次算好（体内逐条谓词都会问一遍，别把 AST 走两趟）
  const used = referencedSlots(expr);
  if (used.size === 0) return [];
  const picked = new Map<string, LoopVar>();
  for (const { counter: c } of candidates) {
    const key = slotKey(c.name, c.index);
    if (!used.has(key)) continue;
    const values: number[] = [];
    for (let v = c.lo; v <= c.hi; v++) values.push(v);
    // 空值域必须筛掉：它会让组合表塌成零行，归并侧取 traced[0] 直接崩
    if (values.length === 0) continue;
    const prev = picked.get(key);
    if (prev) {
      // 同槽位被多层循环同时绑定（嵌套 FOR 用同一个循环量）：并集才是 sound 的超近似
      // （窗口档下外层必被内层 `FOR` 行判脏，进不了并集；这里只可能并上真干净的多档）
      for (const v of values) if (!prev.values.includes(v)) prev.values.push(v);
      prev.values.sort((a, b) => a - b);
    } else {
      picked.set(key, { name: c.name, index: c.index, values, openLine: c.openLine });
    }
  }
  return [...picked.values()];
}

function slotKey(name: string, index: number): string {
  return `${name}:${index}`;
}

/** 引用位形态：裸槽（`LOCAL` / `LOCAL:2`）与索引段里的槽名（`PALAM:LOCAL`）都算 */
const SEG_SLOT_RE = /^([A-Z_][A-Z0-9_]*)(?::(\d+))?$/i;

/** 表达式引用到的本地量槽位集合（大写归一的 `NAME:index`） */
function referencedSlots(expr: ConditionExpr): Set<string> {
  const out = new Set<string>();
  const visit = (e: ConditionExpr): void => {
    switch (e.kind) {
      case 'ref': {
        const name = e.name.toUpperCase();
        if (LOCAL_FAMILY_SLOTS.has(name)) {
          if (e.indices.length === 0) out.add(slotKey(name, 0));
          else if (e.indices.length === 1 && /^-?\d+$/.test(e.indices[0]!)) out.add(slotKey(name, Number(e.indices[0])));
        }
        for (const seg of e.indices) {
          const m = SEG_SLOT_RE.exec(seg);
          if (!m) continue;
          const segName = m[1]!.toUpperCase();
          if (!LOCAL_FAMILY_SLOTS.has(segName)) continue;
          out.add(slotKey(segName, m[2] ? Number(m[2]) : 0));
        }
        break;
      }
      case 'binary':
        visit(e.left);
        visit(e.right);
        break;
      case 'unary':
        visit(e.operand);
        break;
      case 'ternary':
        visit(e.cond);
        visit(e.then);
        visit(e.else);
        break;
      case 'call':
        for (const a of e.args) visit(a);
        break;
      default:
        break;
    }
  };
  visit(expr);
  return out;
}

/** 把一组"槽位 → 具体值"代进表达式：裸槽引用换成字面量，索引段换成数字段 */
function substitute(expr: ConditionExpr, bindings: ReadonlyMap<string, number>): ConditionExpr {
  switch (expr.kind) {
    case 'ref': {
      const name = expr.name.toUpperCase();
      const bareKey = LOCAL_FAMILY_SLOTS.has(name)
        ? slotKey(
            name,
            expr.indices.length === 1 && /^-?\d+$/.test(expr.indices[0]!) ? Number(expr.indices[0]) : 0,
          )
        : null;
      if (bareKey !== null && expr.indices.length <= 1 && bindings.has(bareKey)) {
        const v = bindings.get(bareKey)!;
        return { kind: 'literal', value: v, text: String(v) };
      }
      let changed = false;
      const indices = expr.indices.map((seg) => {
        const m = SEG_SLOT_RE.exec(seg);
        if (!m) return seg;
        const segName = m[1]!.toUpperCase();
        if (!LOCAL_FAMILY_SLOTS.has(segName)) return seg;
        const key = slotKey(segName, m[2] ? Number(m[2]) : 0);
        const v = bindings.get(key);
        if (v === undefined) return seg;
        changed = true;
        return String(v);
      });
      if (!changed) return expr;
      return { ...expr, indices, text: `${expr.name}:${indices.join(':')}` };
    }
    case 'binary': {
      const left = substitute(expr.left, bindings);
      const right = substitute(expr.right, bindings);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }
    case 'unary': {
      const operand = substitute(expr.operand, bindings);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    case 'ternary': {
      const cond = substitute(expr.cond, bindings);
      const then = substitute(expr.then, bindings);
      const elseBranch = substitute(expr.else, bindings);
      return cond === expr.cond && then === expr.then && elseBranch === expr.else
        ? expr
        : { ...expr, cond, then, else: elseBranch };
    }
    case 'call': {
      const args = expr.args.map((a) => substitute(a, bindings));
      return args.every((a, i) => a === expr.args[i]) ? expr : { ...expr, args };
    }
    default:
      return expr;
  }
}

/** 谓词三值 + 循环量逐值试算（无循环量可试算时逐字等价于 judgeCondition） */
export function judgePredicateWithLoops(
  expr: ConditionExpr,
  ctx: EvalContext,
  detail: FunctionPredicates,
  at: OverlayPosition,
  /** 函数体行文本（1 基行号入参、0 基取用；缺省 = 只走第一条行档，旧行为逐字保留） */
  lines?: readonly string[],
): ReplayOutcome {
  const vars = loopVarsAt(detail, at, expr, lines);
  if (vars.length === 0) return judgeCondition(expr, ctx);
  let combos: Array<ReadonlyMap<string, number>> = [new Map()];
  for (const v of vars) {
    const next: Array<ReadonlyMap<string, number>> = [];
    for (const combo of combos) {
      for (const value of v.values) {
        next.push(new Map([...combo, [slotKey(v.name, v.index), value]]));
        if (next.length > MAX_COMBOS) return judgeCondition(expr, ctx); // 组合爆炸 ⇒ 回落原路径（不猜）
      }
    }
    combos = next;
  }
  const traced = combos.map((bindings) => ({
    label: [...bindings.entries()].map(([k, v]) => `${k}=${v}`).join(','),
    outcome: judgeCondition(substitute(expr, bindings), ctx),
  }));
  return mergeOutcomes(traced, vars);
}

/** 逐值结论归并（三值口径见文件头） */
function mergeOutcomes(
  traced: ReadonlyArray<{ label: string; outcome: ReplayOutcome }>,
  vars: readonly LoopVar[],
): ReplayOutcome {
  const first = traced[0]!.outcome;
  const allSameShape = traced.every((t) => t.outcome.kind === first.kind);
  if (allSameShape && first.kind !== 'unknown') return first;
  if (allSameShape && first.kind === 'unknown') {
    const code = first.unknown.code;
    if (traced.every((t) => t.outcome.kind === 'unknown' && t.outcome.unknown.code === code)) {
      return first; // 一律判不出且同因 ⇒ 原样透传（真随机仍记在 pseudo，不改写）
    }
  }
  const ranges = vars.map((v) => `${slotKey(v.name, v.index)}∈[${v.values[0]},${v.values[v.values.length - 1]}]（FOR 第 ${v.openLine} 行）`).join(' ');
  const per = traced.map((t) => `${t.label}→${outcomeWord(t.outcome)}`).join(' ');
  return {
    kind: 'unknown',
    unknown: {
      code: 'local-range',
      message: `循环量值域内结论不一致：${ranges}；逐值试算 ${per}`,
    },
  };
}

function outcomeWord(outcome: ReplayOutcome): string {
  if (outcome.kind !== 'unknown') return outcome.kind === 'true' ? '真' : '假';
  return `未知(${outcome.unknown.code})`;
}
