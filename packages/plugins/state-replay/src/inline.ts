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
 *
 * 2026-11-05 缓冲区文本批（状态回放边界；本插件私有）：内联求值也要吃**编辑器缓冲区正文**。
 * `engine.replayFunction` 每次回放先 `beginReplay({ filePath, text })` 领一个**本次回放独占**
 * 的 `InlineScope`，随后 `preanalyze` / `resolveCall`（含递归内联）全链路只传这个句柄：
 * - **文本身份比较每个回放至多一次**（`beginReplay` 里 `text !== last.text`，150 KB 正文
 *   不在每次函数查找时重比）；命中上一次的作用域就复用它的桶，文本一变就整体丢弃旧桶
 *   （常驻 ≤ 一份缓冲区文本的被调函数集合）。
 * - **两支缓存互不写入**：磁盘命名空间 `cache`/`inFlight` 语义一字未动；override 结果只进
 *   scope 自己的桶，`resolveCall` 也只按传入的 scope 查——两个并发回放各持各的句柄，
 *   不会串味（实例字段只留"上一次来源"用于复用/清空，**不存"当前 override"**）。
 * - **同文件判等走 `pathKey`**（plugin-api 口径，折叠大小写/分隔符）：override 只作用于
 *   缓冲区那份文件；跨文件被调函数照旧读盘。磁盘明细先取只为拿 `filePath` 与"在不在
 *   口上索引域"，缓冲区分支再用 `functionPredicates(key, text)` 拿**缓冲坐标**明细，
 *   行数组按 `splitEolLines`（engine 同一份实现）切。
 *
 * 2026-11-06 多文件缓冲文本批（状态回放边界批 2；本插件私有）：作者可能同时开着 ≤4 份
 * 文件，被调函数所在文件也可能未保存。`beginReplay` 入参扩成
 * `{ filePath, text } | { overrides: readonly { filePath, text }[] }`（单文件形态 =
 * 一条，旧调用方零改动）：
 * - **集合身份**＝每项 `pathKey + text` 的列表（顺序无关）；逐项 `===` 比文本（不哈希、不拼大
 *   字符串，150 KB × 4 份也不产生临时串）。集合内容不变 ⇒ 复用同一作用域（桶不重建）；
 *   任一项路径/文本变 ⇒ 新作用域、generation+1。每个 replay 只做这一次比较。
 * - **桶按文件分开**（`InlineScope.buckets`，键 = `pathKey`）：同一份缓冲正文里 N 个被调
 *   函数只切一次行（`bucket.lines`）并各 analyze 一次；**没变的文件沿用旧桶**——集合里
 *   只有一个文件改文本时，另一文件的被调函数不再重解析。
 * - `ensureAnalyzed` 仍先 `functionPredicates(key)` 拿 `filePath`（定位文件 + 在不在口上
 *   索引域），命中 `scope.overrides` 才用 `functionPredicates(key, text)` + 该文件的行；
 *   否则读盘。磁盘 `cache`/`inFlight` 一字未动，override 结果只进作用域自己的桶。
 */

import { pathKey } from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';
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
  /** 谓词明细（condition.extractor；null = 函数不在口上索引域）。
   *  第二个形参 additive：该文件的**缓冲区文本**（未保存编辑），给了解析不读盘。 */
  functionPredicates(normalizedName: string, textOverride?: string): Promise<FunctionPredicates | null>;
  /** 读文件 → 全部行（engine 注入，内部带文本缓存） */
  readFileLines(filePath: string): Promise<string[]>;
  log: { warn(msg: string): void };
}

/** override 来源：一次 replay 的缓冲区正文（文件路径 + 未保存文本） */
export interface InlineOverrideSource {
  readonly filePath: string;
  readonly text: string;
}

/**
 * `beginReplay` 的入参（**向后兼容**）：
 * - 单文件（旧调用方）：`{ filePath, text }` —— 等价于只有一条的 `overrides`；
 * - 多文件（面板同时开着的 ≤4 份缓冲）：`{ overrides: readonly InlineOverrideSource[] }`。
 */
export type InlineReplaySource =
  | { readonly filePath: string; readonly text: string }
  | { readonly overrides: readonly InlineOverrideSource[] };

/**
 * 归一化后的一条 override（路径已按 plugin-api 的 `pathKey` 折叠）。
 * 集合身份就是这些项的列表（逐项 `pathKey` + `text` 判等；换顺序不算变）。
 */
interface NormalizedOverride {
  readonly key: string;
  readonly filePath: string;
  readonly text: string;
}

/** analyze 桶（磁盘命名空间或某个 override 文件各有一份） */
interface CacheBucket {
  /** 函数名大写 → 结果（null 也在册，避免反复查空） */
  readonly cache: Map<string, AnalyzedFunction | null>;
  /** 在途解析合并（同一个函数只解析一次） */
  readonly inFlight: Map<string, Promise<AnalyzedFunction | null>>;
}

/** 按文件分开的桶：`pathKey` 相同的被调函数共用一份桶 / 一份行数组 */
export interface InlineFileBucket extends CacheBucket {
  /** `pathKey(filePath)`（plugin-api 口径：折叠大小写 / 分隔符） */
  readonly pathKey: string;
  readonly filePath: string;
  /** 该桶对应的缓冲正文（null = 本 replay 里这个文件走磁盘） */
  readonly text: string | null;
  /** 该文件的正文行（懒切；override 桶里 N 个被调函数共用，hint 命中时直接收下 engine 切好的那份） */
  lines: readonly string[] | null;
}

/**
 * 一次 replay 独占的 override 作用域（`beginReplay` 产出；调用链只传引用，不传正文）。
 *
 * 为什么不把缓存挂在实例上、按"当前文本"查找：`InlineManager` 是 engine 级单例，两个
 * 并发回放（A 看缓冲区 X、B 看缓冲区 Y）会在"谁最后改写了实例字段"上互相踩。这里的
 * 缓存随句柄走：A 只会读自己的桶，B 清不掉 A 的桶，A 也不会把结果写进 B 的桶。
 *
 * 常驻内存：管理器只留**最后一次** `beginReplay` 的作用域（集合身份不变即复用）；集合
 * 一变，新句柄取代旧句柄。**文本没变的文件**沿用旧桶（`buckets` 里直接搬引用），只有
 * 变了的文件重建 —— 旧桶里其余文件的 analyze 结果不会陪葬。
 */
export interface InlineScope {
  /** 首个 override 的文件路径（向后兼容视图；单文件形态就是它自己） */
  readonly filePath: string;
  /** `pathKey(filePath)`（plugin-api 口径：折叠大小写 / 分隔符） */
  readonly pathKey: string;
  /** 首个 override 的正文（向后兼容视图） */
  readonly text: string;
  /** 本次 replay 的 override 集合：`pathKey` → 缓冲正文（顺序 = 来源顺序） */
  readonly overrides: ReadonlyMap<string, string>;
  /** `pathKey` → 该文件的桶（含本 replay 触到的磁盘文件桶） */
  readonly buckets: Map<string, InlineFileBucket>;
  /** 函数名大写 → 所属文件的桶（执行期 `resolveCall` 的 O(1) 入口） */
  readonly nameIndex: Map<string, InlineFileBucket>;
}

/**
 * 行文本提示：engine 本次回放**已经切好**的正文（缓冲区或磁盘），只对 `pathKey` 指向的
 * 文件生效。给它是为了同文件 N 个被调函数不必各自再 `splitEolLines` 一遍 150 KB。
 */
export interface InlineLinesHint {
  readonly pathKey: string;
  readonly lines: readonly string[];
}

/** 内联缓存读数（面板 / 测试用来证明"两个命名空间确实分开、文本变化确实清空"） */
export interface InlineCacheStats {
  /** 磁盘命名空间的条目数（按函数名，跨 replay 复用） */
  readonly disk: number;
  /** override 命名空间的条目数（最后一次 `beginReplay` 作用域内**所有文件桶之和**） */
  readonly override: number;
  /** override 来源文件的**首项**（多文件时只看第一个；null = 还没见过任何缓冲区来源） */
  readonly overridePath: string | null;
  /** override 作用域代数：集合身份每变一次 +1（旧桶已丢弃/部分移交，条目数不随代数涨） */
  readonly generation: number;
}

/** 单文件桶的读数（多文件取证：哪个文件吃缓冲、哪个文件读盘、各有多少条） */
export interface InlineOverrideFileStat {
  readonly pathKey: string;
  readonly filePath: string;
  /** true = 本次 replay 有该文件的缓冲正文；false = 这个桶装的是本次 replay 的磁盘结果 */
  readonly overridden: boolean;
  /** 桶内条目数（函数名，含 null 的"查过但不在口上域"） */
  readonly entries: number;
}

/**
 * 入参归一：`pathKey → { filePath, text }`（**路径折叠用 plugin-api 的 `pathKey`**，不自己写
 * 归一）。重复 `pathKey` 后见胜出、保留首次出现的位序（位序只影响诊断读数，不进身份）。
 */
function normalizeReplaySource(source: InlineReplaySource): NormalizedOverride[] {
  const list: readonly InlineOverrideSource[] = 'overrides' in source ? source.overrides : [source];
  const byKey = new Map<string, { filePath: string; text: string }>();
  for (const item of list) {
    // Map.set 对已有键只换值、不动位序 ⇒ 重复项 = 后见胜出，位序按首次出现
    byKey.set(pathKey(item.filePath), { filePath: item.filePath, text: item.text });
  }
  return [...byKey.entries()].map(([key, v]) => ({ key, filePath: v.filePath, text: v.text }));
}

/**
 * 集合身份比较：**逐项** `pathKey + text`（文本用 `===` 比引用/内容同一批字符串），
 * 顺序不参与身份（面板换顺序不该重建桶）。n ≤ 4 ⇒ 最坏 16 次键比较，零分配；
 * 不哈希、不拼 key 串（那会把 150 KB 正文再读一遍 / 分配一份等长临时串）。
 */
function sameOverrideSet(prev: ReadonlyMap<string, string>, entries: readonly NormalizedOverride[]): boolean {
  if (prev.size !== entries.length) return false;
  for (const [key, text] of prev) {
    let matched = false;
    for (const entry of entries) {
      if (entry.key !== key) continue;
      matched = entry.text === text;
      break;
    }
    if (!matched) return false;
  }
  return true;
}

/** 建一个按文件的空桶（`text = null` = 本 replay 里这个文件走磁盘） */
function createFileBucket(pathKeyValue: string, filePath: string, text: string | null): InlineFileBucket {
  return { pathKey: pathKeyValue, filePath, text, cache: new Map(), inFlight: new Map(), lines: null };
}

/** 桶类型判别：磁盘命名空间的桶没有文件身份（scope 里的桶都有） */
function isFileBucket(bucket: CacheBucket): bucket is InlineFileBucket {
  return 'filePath' in bucket;
}

/**
 * 内联管理器：analyze 缓存 + 同步 resolveCall。
 *
 * 用法（engine.replayFunction）：先 `await preanalyze(detail)`（递归预热全部
 * 被调函数，含内联体内嵌套调用），再以同步 `resolveCall` 注入 EvalContext——
 * 执行期缓存必命中（miss = 竞态，log warn 并回落 unknown('call')）。
 */
export class InlineManager {
  /** **磁盘命名空间**（语义与本批之前一字不动：按函数名定格、跨 replay 复用） */
  private readonly cache = new Map<string, AnalyzedFunction | null>();
  private readonly inFlight = new Map<string, Promise<AnalyzedFunction | null>>();
  /** 上一次 override 集合的作用域（集合身份命中即复用；变了就建新作用域） */
  private lastScope: InlineScope | null = null;
  /** override 作用域代数（仅诊断：证明"集合变化 = 新桶 + generation+1"） */
  private generation = 0;
  /** 磁盘命名空间的桶视图（只包引用：`reset()` 清的是同一批 Map，不换对象） */
  private readonly diskBucket: CacheBucket = { cache: this.cache, inFlight: this.inFlight };

  constructor(private readonly deps: InlineManagerDeps) {}

  /**
   * 项目切换 / 索引重建时清空（函数体可能已变）：**两桶一起清**。
   * 旧作用域句柄（并发回放手里那个）里的桶也一并清空 —— `reset()` 之后不许再命中
   * 旧索引下算出来的结果；句柄对象本身还在，但桶是空的。
   */
  reset(): void {
    this.cache.clear();
    this.inFlight.clear();
    if (this.lastScope !== null) {
      for (const bucket of this.lastScope.buckets.values()) {
        bucket.cache.clear();
        bucket.inFlight.clear();
      }
      this.lastScope.nameIndex.clear();
    }
    this.lastScope = null;
  }

  /**
   * 领取本次 replay 的 override 作用域（**每次回放只调一次**，也是全链路唯一做集合身份
   * 比较的地方）：
   * - 入参归一成 `pathKey → 正文`（单文件形态 = 一条）；
   * - 与上一次集合**逐项**比（`pathKey` + 文本 `===`，换顺序不算变）⇒ 内容不变就复用同一作用域，
   *   桶不重建；
   * - 任一项变化 ⇒ 新作用域、generation+1；**文本没变的文件沿用旧桶**（只重建变了的那份）；
   * - 无 override / 空集合 ⇒ null（走磁盘命名空间）。
   *
   * 为什么逐项比 `===` 而不是哈希 / 拼串：集合至多 4 项、文本是同一批字符串引用
   * （150 KB 正文不在每次回放里被再读一遍），逐项比较最坏 4×4 次键比较 + 4 次指针比较，
   * 比"算哈希（要把 600 KB 读一遍）"或"拼 key（要分配 600 KB 临时串）"都快且零分配。
   */
  beginReplay(source?: InlineReplaySource | null): InlineScope | null {
    if (!source) return null;
    const entries = normalizeReplaySource(source);
    if (entries.length === 0) return null;
    const last = this.lastScope;
    if (last !== null && sameOverrideSet(last.overrides, entries)) return last;

    // 新作用域：每个 override 文件一个桶；**文本没变的文件搬旧桶**（不重解析）
    const buckets = new Map<string, InlineFileBucket>();
    const nameIndex = new Map<string, InlineFileBucket>();
    for (const entry of entries) {
      const reusable =
        last !== null && last.overrides.get(entry.key) === entry.text ? last.buckets.get(entry.key) : undefined;
      const bucket = reusable ?? createFileBucket(entry.key, entry.filePath, entry.text);
      buckets.set(entry.key, bucket);
      for (const name of bucket.cache.keys()) nameIndex.set(name, bucket);
    }
    const first = entries[0]!;
    const scope: InlineScope = {
      filePath: first.filePath,
      pathKey: first.key,
      text: first.text,
      overrides: new Map(entries.map((e) => [e.key, e.text] as const)),
      buckets,
      nameIndex,
    };
    this.lastScope = scope;
    this.generation++;
    return scope;
  }

  /** 缓存读数（测试 / 面板自证用；不是回放语义的一部分） */
  cacheStats(): InlineCacheStats {
    let override = 0;
    if (this.lastScope !== null) {
      for (const bucket of this.lastScope.buckets.values()) override += bucket.cache.size;
    }
    return {
      disk: this.cache.size,
      override,
      overridePath: this.lastScope?.filePath ?? null,
      generation: this.generation,
    };
  }

  /** 作用域内按文件分桶的读数（多文件取证：谁吃缓冲、谁读盘、各多少条） */
  overrideFileStats(): InlineOverrideFileStat[] {
    if (this.lastScope === null) return [];
    const out: InlineOverrideFileStat[] = [];
    for (const bucket of this.lastScope.buckets.values()) {
      out.push({
        pathKey: bucket.pathKey,
        filePath: bucket.filePath,
        overridden: bucket.text !== null,
        entries: bucket.cache.size,
      });
    }
    return out;
  }

  /** 函数名已在本作用域里解析过 → 找出它在哪个文件的桶（同时补 nameIndex） */
  private findBucket(scope: InlineScope, name: string): InlineFileBucket | undefined {
    for (const bucket of scope.buckets.values()) {
      if (bucket.cache.has(name)) {
        scope.nameIndex.set(name, bucket);
        return bucket;
      }
    }
    return undefined;
  }

  /**
   * 取（或懒建）某个文件的桶：override 集合里列了的文件在 `beginReplay` 就已建好
   * （可能复用了旧桶）；本 replay 里第一次触到的磁盘文件按需建一个空桶。
   * 桶只属于**本次 replay 的命名空间**（不写磁盘 `cache`/`inFlight`）。
   */
  private bucketForFile(scope: InlineScope, filePath: string): InlineFileBucket {
    const key = pathKey(filePath);
    const existing = scope.buckets.get(key);
    if (existing !== undefined) return existing;
    const bucket = createFileBucket(key, filePath, scope.overrides.get(key) ?? null);
    scope.buckets.set(key, bucket);
    return bucket;
  }

  /** 文件行数组：hint 命中复用 engine 切好的那份；否则整份正文只切一次（桶里记住） */
  private overrideLinesOf(bucket: InlineFileBucket, hint?: InlineLinesHint): readonly string[] {
    if (bucket.lines === null) {
      bucket.lines =
        hint !== undefined && hint.pathKey === bucket.pathKey ? hint.lines : splitEolLines(bucket.text ?? '');
    }
    return bucket.lines;
  }

  /** 记一条 reject 日志（两桶共用口径） */
  private logReject(key: string, analyzed: AnalyzedFunction): void {
    if (analyzed.kind === 'reject') {
      this.deps.log.warn(`Inline reject: ${key} — ${analyzed.reason}`);
    }
  }

  /**
   * 直接种入函数自身（engine 已经把**同一份正文**的明细与行切好了）：省掉
   * `functionPredicates(key)` + `functionPredicates(key, text)` 两次重取与一次重复 analyze。
   * 桶里已有（上一次同文本 replay 分析过 / 同一份正文里别的函数先种过）就直接用，不覆盖。
   * 落桶按 `detail.filePath` 选文件：override 文件进它的桶（行数组顺手记住），其余进
   * 本 replay 的磁盘文件桶。
   */
  private seed(
    key: string,
    detail: FunctionPredicates,
    lines: readonly string[],
    scope: InlineScope | null,
  ): AnalyzedFunction | null {
    const bucket: CacheBucket =
      scope === null ? this.diskBucket : this.bucketForFile(scope, detail.filePath);
    const hit = bucket.cache.get(key);
    if (hit !== undefined) return hit;
    const analyzed = analyzeInlineBody(detail, lines);
    this.logReject(key, analyzed);
    bucket.cache.set(key, analyzed);
    if (scope !== null && isFileBucket(bucket)) {
      scope.nameIndex.set(key, bucket);
      // engine 切好的行 = 该 override 文件的正文行：同文件其余被调函数直接复用，不再重切
      if (bucket.text !== null && bucket.lines === null) bucket.lines = lines;
    }
    return analyzed;
  }

  /**
   * analyze 单函数（按文件分桶；与在途解析合并）。
   *
   * 取文本逻辑（2026-11-06 多文件批）：
   * 1. 先 `functionPredicates(key)` 拿磁盘明细——只为 `filePath` 与"在不在口上索引域"；
   * 2. 该 `filePath` 在**本次 replay 的 override 集合**里 ⇒ `functionPredicates(key, text)`
   *    拿**缓冲坐标**明细，行数组用该文件桶里的那份（hint 命中 = engine 已切好，直接收下；
   *    否则整份正文只 `splitEolLines` 一次）；
   * 3. 否则照旧走磁盘：`readFileLines(detail.filePath)`。
   *
   * 结果只写进**本次 replay 所属的文件桶**（scope 非空），磁盘 `cache`/`inFlight` 绝不被
   * override 结果写入，反之亦然。同一份正文里 N 个被调函数各 analyze 一次、行切一次；
   * 不同文件各自独立（一个文件改文本不牵动另一个文件已解析的桶）。
   */
  private async ensureAnalyzed(
    name: string,
    scope: InlineScope | null,
    hint?: InlineLinesHint,
  ): Promise<AnalyzedFunction | null> {
    const key = name.toUpperCase();
    if (scope === null) return this.analyzeIn(this.diskBucket, key, hint);
    // 本 replay 见过这个函数（含复用旧桶搬进来的名字）→ 桶已知，直接查
    const known = scope.nameIndex.get(key) ?? this.findBucket(scope, key);
    if (known !== undefined) return this.analyzeIn(known, key, hint);
    // 首次见到：磁盘明细只为定位文件（在不在口上域 + 命中哪份 override）
    const diskDetail = await this.deps.functionPredicates(key);
    if (!diskDetail) return null; // 不在口上索引域（引擎内置 / 游戏侧函数）
    const bucket = this.bucketForFile(scope, diskDetail.filePath);
    scope.nameIndex.set(key, bucket);
    return this.analyzeIn(bucket, key, hint, diskDetail);
  }

  /** analyze 一个函数并写进指定桶（cache 命中 → 在途合并 → 实算；三层口径一致） */
  private async analyzeIn(
    bucket: CacheBucket,
    key: string,
    hint?: InlineLinesHint,
    prefetchedDiskDetail?: FunctionPredicates,
  ): Promise<AnalyzedFunction | null> {
    const hit = bucket.cache.get(key);
    if (hit !== undefined) return hit;
    const pending = bucket.inFlight.get(key);
    if (pending) return pending;

    const task = (async (): Promise<AnalyzedFunction | null> => {
      const fileBucket = isFileBucket(bucket) && bucket.text !== null ? bucket : null;
      // ---- 缓冲区分支：本文件有 override 正文 ⇒ 明细与行都取这一份 ----
      if (fileBucket !== null) {
        const bufferDetail = await this.deps.functionPredicates(key, fileBucket.text!);
        if (!bufferDetail) return null; // 缓冲区里找不到同名函数（改名 / 删掉 / 不在口上域）
        const analyzed = analyzeInlineBody(bufferDetail, this.overrideLinesOf(fileBucket, hint));
        this.logReject(key, analyzed);
        return analyzed;
      }
      // ---- 磁盘分支（原语义） ----
      const detail = prefetchedDiskDetail ?? (await this.deps.functionPredicates(key));
      if (!detail) return null;
      let lines: readonly string[];
      try {
        lines =
          hint !== undefined && hint.pathKey === pathKey(detail.filePath)
            ? hint.lines
            : await this.deps.readFileLines(detail.filePath);
      } catch (err) {
        this.deps.log.warn(`Inline analyze read failed: ${detail.filePath} — ${String(err)}`);
        return null;
      }
      const analyzed = analyzeInlineBody(detail, lines);
      this.logReject(key, analyzed);
      return analyzed;
    })();

    bucket.inFlight.set(key, task);
    const result = await task;
    bucket.inFlight.delete(key);
    bucket.cache.set(key, result);
    return result;
  }

  /**
   * 递归预热：先 analyze **函数自身**（resolveCall 需要它命中缓存；自递归/被
   * 嵌套引用均依赖），再从 detail 的全部 AST（谓词 / 赋值 / 返回）出发，BFS
   * 收集用户函数调用并逐个 analyze；内联体内的嵌套调用随 analyze 结果继续
   * 展开（visited 防环；执行期深度界另有兜底）。完成后 resolveCall 同步缓存必命中。
   *
   * `scope`：本次 replay 的 override 句柄（null = 磁盘回放）；`hint`：engine 已切好的
   * 正文（同文件被调函数共用，省掉 N 次全文切行）。两者都沿递归全链路透传。
   */
  async preanalyze(
    detail: FunctionPredicates,
    scope: InlineScope | null = null,
    hint?: InlineLinesHint,
  ): Promise<void> {
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

    // 自身先入缓存（自递归 / 被嵌套调用引用时命中）：engine 已经把同一份正文的明细 +
    // 行切好了 ⇒ 直接种入，不再让抽取器重算一遍（N 个函数逐个回放时的两份重复解析）。
    const selfKey = detail.normalizedName.toUpperCase();
    visited.add(selfKey);
    const self =
      hint !== undefined && hint.pathKey === pathKey(detail.filePath)
        ? this.seed(selfKey, detail, hint.lines, scope)
        : await this.ensureAnalyzed(selfKey, scope, hint);
    if (self && self.kind === 'ok') collectFromBody(self);

    for (const p of detail.predicates) collectFromExpr(p.expr);
    for (const a of detail.assignments) collectFromExpr(a.expr);
    for (const r of detail.returns) collectFromExpr(r.expr);

    while (queue.length > 0) {
      const key = queue.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const analyzed = await this.ensureAnalyzed(key, scope, hint);
      if (analyzed && analyzed.kind === 'ok') collectFromBody(analyzed);
    }
  }

  /**
   * 同步内联调用（preanalyze 后缓存必命中；miss → null → unknown('call')）。
   * @param callerCtx 调用方上下文（实参求值通道：外层 read / overlay / 递归内联）
   * @param depth 当前内联深度
   * @param scope 本次 replay 的 override 句柄（null / 缺省 = 磁盘命名空间）
   */
  resolveCall(
    name: string,
    args: readonly ConditionExpr[],
    callerCtx: EvalContext,
    depth: number,
    scope: InlineScope | null = null,
  ): ReplayValue | null {
    if (depth > MAX_INLINE_DEPTH) return null;
    const key = name.toUpperCase();
    // 按文件的桶：preanalyze 已把函数名 → 桶登记在 nameIndex；并发窗口里漏登记的
    // 名字扫一遍 ≤4 个桶补上（不重解析，只是指针查找）。
    const bucket = scope === null ? this.diskBucket : (scope.nameIndex.get(key) ?? this.findBucket(scope, key));
    const analyzed = bucket?.cache.get(key);
    if (analyzed === undefined || analyzed === null || analyzed.kind === 'reject') return null;
    if (analyzed.ops.length === 0) {
      return unknownValue('call', `函数体为空，无法内联：${name}()`);
    }
    return this.runBody(name, analyzed, args, callerCtx, depth, scope);
  }

  /** 执行一个内联函数体（绑定 → PC 解释） */
  private runBody(
    name: string,
    body: InlineBody,
    args: readonly ConditionExpr[],
    callerCtx: EvalContext,
    depth: number,
    scope: InlineScope | null,
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
      resolveCall: (n, a) => this.resolveCall(n, a, ctx, depth + 1, scope), // 自引用闭包 = 递归内联
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
