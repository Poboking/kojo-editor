/**
 * 糖**投影**（B 层，2026-10-12 语法糖批）—— 原生 ERB → 糖显示（**只用于看**）。
 *
 * 依据：`docs/LIFT-REMEASURE-2026-10-12.md` §7.1（"逐行局部映射 + 单行降级"）。
 *
 * ## 为什么与 `lift.ts` 分开
 *
 * `lift.ts` 的 `liftSuggest` 是**写盘口径**：它证明"这段 ERB 能安全改写成糖并写回
 * `.kojo`"，判据是整段 round-trip 逐字节一致——用它做纯显示会**过严到让功能失效**
 * （实测行覆盖仅 6.5%，见 §三）。
 *
 * 本模块是**显示口径**：把整份 ERB 投影成糖，判据换成**封闭规则表 + 逐行降级**：
 *
 * | 原生 ERB | 糖显示 |
 * |---|---|
 * | `PRINTFORMW 「台词」` / `PRINTFORMDL 旁白` | 文本行（`L` 后缀 → 行尾 ` 续`） |
 * | `IF X` / `ELSEIF X` / `ELSE` | `如果 X：` / `否则如果 X：` / `否则：` |
 * | `ENDIF` | 缩进收束（**不显示**） |
 * | `SELECTCASE X` / `CASE v` / `CASEELSE` | `当 X：` / `是 v：` / `否则：` |
 * | `ENDSELECT` | 缩进收束（不显示） |
 * | `;注释` / 空行 | **原样透传**（`;` 注释在糖里语法完全一样） |
 * | `%CALLNAME:TARGET%` / `%CALLNAME:MASTER%` | `{她}` / `{你}`（**可读化**，见下） |
 * | 其余（`SIF` / 循环 / TRY / PRINTDATA / 非 FORM PRINT / 行内条件 …） | **原样保留为 ERB** |
 *
 * ## 可读化（本模块与 `lift.ts` 最大的取向差异）
 *
 * 服务对象是**不熟悉 EraBasic 的读者**：他打开别人写的口上，要能像看剧本一样读懂。
 * `%CALLNAME:MASTER%` 这种记号正是"读不懂"的元凶，故在**文本体**内反糖为糖的
 * 标准代词写法 `{你}` / `{她}`（规范 §3.4）。
 *
 * 三条纪律：
 *
 * 1. **只反糖代词**。反向表由 `expression.ts` 的 `PRONOUN_MAP` **派生**
 *    （`PRONOUN_REVERSE`），正反对称是构造事实。属性反糖（`TALENT:TARGET:恋慕`
 *    → `她的恋慕`）**不做**——它需要"这个索引是真名而非编号"的反向字典，
 *    猜错会把 `TALENT:TARGET:3` 显示成 `她的3`，属于"看着像懂了其实被误导"。
 * 2. **只改文本体，不碰控制流表达式**。`%…%` 是 FORM 串形态，在条件位置本就非法，
 *    不去动它也就不可能把条件改坏。
 * 3. 反糖是**显示**，不改判据：即使文本里出现糖里不认识的写法，也照常显示
 *    （投影不承诺可编译——那是 `lift.ts` 的自证口径）。
 *
 * ## 关键性质
 *
 * 1. **天生不怕嵌套**：每行独立判定，缩进直接查 `scanControlFlow` 的 `depth`；
 *    一行失败只影响那一行（`lift.ts` 的链式 `return null` 不复存在）。
 * 2. **不需要动冻结规范**：本模块不产出 `.ERB`，只产出显示。
 * 3. **误映射风险由 depth/上下文封住**：`PRINTDATA` 数据表体、`[SKIPSTART]` 区内的行
 *    即使形如 `PRINTFORM*` 也不映射（判据来自结构，不只是行首正则）。
 *
 * ## 依赖方向（单向，无环）
 *
 * 只注入 `scanControlFlow`（`erb-parser` 的公开纯函数）；**不调用 `transpile`**
 * （投影不需要自证）。缺席时降级：无结构信息 → 只按行首规则映射台词行，控制流行
 * 一律原样保留，缩进退回原文缩进层。
 */

import type {
  ControlFlowStatement,
  SugarProjectNativeReason,
  SugarProjectRequest,
  SugarProjectResult,
  SugarProjectSegment,
  SugarProjectStats,
} from '@kojo/plugin-api';
import type { LiftDeps } from './lift';
import type { DictionaryLookup } from './types';
import { PRONOUN_REVERSE } from './expression';

/* ============================== 规则表（封闭） ============================== */

/**
 * **角色作用域**的数值变量族（属性反糖只认这些）。
 *
 * 为什么必须有这张表：ERB 里 `FLAG:70` 与 `CFLAG:TARGET:70` 长得一样但语义天差地别——
 * `FLAG` 是**全局**族，写成糖的 `她的FLAG` 是错的。故只给"角色作用域"的族发糖；
 * 全局族（`FLAG`/`TFLAG`/`GLOBAL`/`DAY`/`MONEY`…）原样保留。
 *
 * 表的来源是引擎的变量族划分（`VariableParser.ReduceVariable` 的角色分支），
 * 属**语言/引擎级**知识（与 `PRINT_VARIANTS` 同类），不是某个游戏的知识。
 */
const CHAR_SCOPED_FAMILIES: ReadonlySet<string> = new Set([
  'CFLAG',
  'TALENT',
  'ABL',
  'EXP',
  'MARK',
  'BASE',
  'PALAM',
  'TEQUIP',
  'TCVAR',
]);

/** 有糖形态的 PRINT 变体（`L` = 不等待 → 糖行尾加 ` 续`；`D` = 旁白色，糖自动判定，不标注） */
const PRINT_VARIANTS: ReadonlyMap<string, { wait: boolean }> = new Map([
  ['PRINTFORMW', { wait: true }],
  ['PRINTFORML', { wait: false }],
  ['PRINTFORMDW', { wait: true }],
  ['PRINTFORMDL', { wait: false }],
]);

/** 匹配 PRINT 家族行：`(关键字) (文本体)` */
const PRINT_FAMILY_RE = /^(PRINT[A-Z]*)\s?([\s\S]*)$/;

/** 糖覆盖的控制流关键字 → 糖块头（`null` = 缩进收束，不产出可见行） */
type ControlSugarMaker = (expr: string) => string | null;
const SUGAR_CONTROL: ReadonlyMap<string, ControlSugarMaker> = new Map<string, ControlSugarMaker>([
  ['IF', (e) => `如果 ${e}：`],
  ['ELSEIF', (e) => `否则如果 ${e}：`],
  ['ELSE', () => '否则：'],
  ['ENDIF', () => null],
  ['SELECTCASE', (e) => `当 ${e}：`],
  ['CASE', (e) => `是 ${e}：`],
  ['CASEELSE', () => '否则：'],
  ['ENDSELECT', () => null],
]);

/** 开块语句 → 配对类别（与 `erb-parser/scanner.ts` 同口径；用于重建"包着这一行的块种类"） */
const OPEN_PAIR: Readonly<Record<string, string>> = {
  IF: 'if',
  SELECTCASE: 'select',
  FOR: 'for',
  WHILE: 'while',
  REPEAT: 'repeat',
  DO: 'do',
  DATALIST: 'list',
  STRDATA: 'data',
  NOSKIP: 'noskip',
};
const PRINTDATA_OPEN: ReadonlySet<string> = new Set([
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAKL',
  'PRINTDATAKW',
  'PRINTDATAD',
  'PRINTDATADL',
  'PRINTDATADW',
]);
const TRY_CATCH_OPEN: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
]);
const TRY_LIST_OPEN: ReadonlySet<string> = new Set(['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST']);

const CLOSE_KINDS: ReadonlySet<string> = new Set([
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

/* ============================== 入口 ============================== */

/** 生成整文件糖投影（同步纯函数；不读盘、不写盘、不发事件） */
export function liftProject(deps: LiftDeps, request: SugarProjectRequest): SugarProjectResult {
  const { source } = request;
  if (typeof source !== 'string') {
    throw new TypeError('糖投影的输入必须是字符串（原生 ERB 文本）');
  }

  const lines = splitSourceLines(source);
  const total = lines.length;
  const statements = deps.scanControlFlow ? safeScan(deps.scanControlFlow, source) : [];
  const ctx = buildContext(lines, statements);
  // 演出：`SETCOLOR …` / `RESETCOLOR` **配对**成「着色 …：」块（规范 §3.9）。
  // 配不上的一律原样保留（真实语料 SETCOLOR 22,487 对 RESETCOLOR 6,312——多数没有配对的
  // 收尾，猜边界会把别人的代码藏起来）。
  const color = planColorBlocks(lines, ctx);

  const recs: LineRec[] = [];
  const nativeByReason = new Map<SugarProjectNativeReason, number>();
  let inSkip = false;

  for (let i = 0; i < total; i++) {
    const ln = i + 1;
    const raw = lines[i]!;
    const content = contentOf(raw);

    if (content === '[SKIPSTART]') {
      inSkip = true;
      recs.push(native(ln, 'data-or-skip'));
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      recs.push(native(ln, 'data-or-skip'));
      continue;
    }
    if (inSkip) {
      recs.push(native(ln, 'data-or-skip'));
      continue;
    }
    if (content.length === 0 || content.startsWith(';')) {
      // 注释 / 空行 → 透传（糖表层语法与 ERB 完全一致）
      recs.push({
        line: ln,
        kind: 'passthrough',
        text: content,
        indent: ctx.indentAt(ln, raw),
        visible: true,
        reason: null,
      });
      continue;
    }

    // 着色块：配对成功的那行 SETCOLOR → 块头；配对的 RESETCOLOR → 被吸收（不产出可见行）
    const colorOpen = color.openAt.get(ln);
    if (colorOpen !== undefined) {
      recs.push({
        line: ln,
        kind: 'control',
        text: `着色 ${colorOpen}：`,
        indent: ctx.indentAt(ln, raw),
        visible: true,
        reason: null,
      });
      continue;
    }
    if (color.absorbed.has(ln)) {
      recs.push({
        line: ln,
        kind: 'control',
        text: '',
        indent: ctx.indentAt(ln, raw),
        visible: false,
        reason: null,
      });
      continue;
    }

    const st = ctx.stmtAt(ln);
    if (st) {
      const mk = SUGAR_CONTROL.get(st.kind);
      if (mk !== undefined) {
        const expr = st.expression.trim();
        // 需要表达式的块头若表达式为空 → 不猜，原样保留
        if (needsExpression(st.kind) && expr.length === 0) {
          recs.push(native(ln, 'other'));
          continue;
        }
        const text = mk(reverseExprAttributes(expr, deps));
        recs.push({
          line: ln,
          kind: 'control',
          text: text ?? '',
          indent: st.depth,
          visible: text !== null,
          reason: null,
        });
        continue;
      }
      // 其余控制流（SIF / 循环 / TRY / PRINTDATA / 标签等）→ 原样保留
      recs.push(native(ln, 'unsupported-control-flow'));
      continue;
    }

    const pm = PRINT_FAMILY_RE.exec(content);
    if (pm) {
      const word = pm[1]!;
      const variant = PRINT_VARIANTS.get(word);
      if (!variant) {
        recs.push(native(ln, 'unsupported-print-variant'));
        continue;
      }
      // 结构判据**先于**内容判据：落在 PRINTDATA 数据表体内的行是"数据"而非"显示
      // 语句"，无论它长什么样（哪怕文本体为空）都不该被当成台词投影。
      if (ctx.enclosingAt(ln).includes('data')) {
        recs.push(native(ln, 'data-or-skip'));
        continue;
      }
      const body = pm[2]!.replace(/[ \t\u3000]+$/, '');
      if (body.length === 0) {
        // ---- 「输出一行空行」----
        //
        // 作者用**裸指令**打空行（`PRINTFORMW` / `PRINTFORMDL␠` / `PRINTFORML\t`）。
        // 真实语料里这不是零星写法：400 个口上文件实测 **35,425 行**（占全部行 5.3%），
        // 且**形态 100% 是"指令后为空"**（`tools/` 的一次性调查已核实，非实现缺陷）。
        //
        // 糖表面没有"输出空行"的写法（§3.10 的空行是分隔符、不产出），所以这是一处
        // **刻意的显示口径**而非等价改写：投影按"读者在游戏里看到的节奏"处理——
        // 一行空行。收益有两层：
        //   ① 读者看到的是剧本节奏，而不是一片 `PRINTFORMDL␠` 噪声；
        //   ② 它不再**切断**糖段——实测中它是段数暴涨的头号原因（187 段/文件）。
        //
        // 代价（记录在案）：`W`（等待）与 `L`（不等待）的空行在投影里不再可分辨。
        // 若将来要保留，可在行尾加 `续` 区分（届时仍需改这条口径）。
        recs.push({
          line: ln,
          kind: 'speech',
          text: '',
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }
      if (hasInlineCondition(body)) {
        recs.push(native(ln, 'inline-condition'));
        continue;
      }
      recs.push({
        line: ln,
        kind: 'speech',
        text: variant.wait ? readableText(body, deps) : `${readableText(body, deps)} 续`,
        indent: ctx.indentAt(ln, raw),
        visible: true,
        reason: null,
      });
      continue;
    }

    // 其余（赋值 / 调用 / `@` / `#` / `$` / 其他指令）→ 原样保留
    recs.push(native(ln, 'other'));
  }

  // ---- 缩进补正：着色块**体内**的行整体 +1 层 ----
  //
  // 放在最后统一做（而不是在每个 push 点手动加）：一处口径，漏改不了。
  // 块头自身不吃 +1（`starts` 从 open+1 起算），被吸收的 RESETCOLOR 不可见故无影响。
  for (const r of recs) {
    const bump = color.bumpAt(r.line);
    if (bump > 0) r.indent += bump;
  }

  // ---- 统计 ----
  //
  // 口径完整性（不静默）：三类计数之和**恒等于** `totalLines`——每一行都必须落在
  // "被糖覆盖 / 原样透传（注释空行）/ 保留原生"三者之一。故 `control` 行**不区分是否
  // 产出可见行**：`ENDIF` / `ENDSELECT` 这类收束行虽不显示，但它们被缩进语义吸收，
  // 仍属于"被糖覆盖"（否则它们会从三类里凭空消失，读者算不平账）。
  let projectedLines = 0;
  let passthroughLines = 0;
  let nativeLines = 0;
  for (const r of recs) {
    if (r.kind === 'native') {
      nativeLines++;
      nativeByReason.set(r.reason!, (nativeByReason.get(r.reason!) ?? 0) + 1);
    } else if (r.kind === 'passthrough') {
      passthroughLines++;
    } else {
      projectedLines++;
    }
  }
  const stats: SugarProjectStats = {
    totalLines: total,
    projectedLines,
    passthroughLines,
    nativeLines,
    nativeByReason: [...nativeByReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };

  return { segments: buildSegments(recs), stats };
}

/* ============================== 分段 ============================== */

interface LineRec {
  line: number;
  kind: 'speech' | 'control' | 'passthrough' | 'native';
  /** 糖显示文本（不含缩进基准）；`control` 收束行为空串 */
  text: string;
  /** 缩进层级（糖显示用） */
  indent: number;
  /** 是否产出可见行 */
  visible: boolean;
  reason: SugarProjectNativeReason | null;
}

function native(line: number, reason: SugarProjectNativeReason): LineRec {
  return { line, kind: 'native', text: '', indent: 0, visible: false, reason };
}

/**
 * 把逐行记录切成**连续可映射段**：只有 `native` 行会切断段。
 *
 * 纯注释/空行的段（不含任何 `speech` / `control`）**不成段**——它们保持可见即可，
 * 折叠成 ViewZone 反而徒增噪声。
 */
function buildSegments(recs: LineRec[]): SugarProjectSegment[] {
  const out: SugarProjectSegment[] = [];
  let run: LineRec[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const hasMapped = run.some((r) => r.kind === 'speech' || r.kind === 'control');
    if (hasMapped) {
      out.push(toSegment(run));
    }
    run = [];
  };

  for (const r of recs) {
    if (r.kind === 'native') flush();
    else run.push(r);
  }
  flush();
  return out;
}

/** 一段记录 → 段（缩进以段内最小层为基准，故至少首行无前导空白） */
function toSegment(run: LineRec[]): SugarProjectSegment {
  const visible = run.filter((r) => r.visible);
  const base = visible.reduce((m, r) => Math.min(m, r.indent), Number.POSITIVE_INFINITY);
  const baseIndent = Number.isFinite(base) ? base : 0;
  const text = visible
    .map((r) => '\t'.repeat(Math.max(0, r.indent - baseIndent)) + r.text)
    .join('\n');
  return {
    fromLine: run[0]!.line,
    toLine: run[run.length - 1]!.line,
    sugarText: text,
    lineCount: visible.length,
  };
}

/* ============================== 着色块配对 ============================== */

/** 着色块配对结果（形状见 `planColorBlocks`） */
interface ColorPlan {
  /** `SETCOLOR` 行号 → 颜色表达式（呈现为「着色 X：」块头） */
  openAt: Map<number, string>;
  /** 被吸收的 `RESETCOLOR` 行号（不产出可见行，但占区间） */
  absorbed: Set<number>;
  /** 该行处于几个着色块**体内**（缩进补正用） */
  bumpAt: (line: number) => number;
}

/**
 * 把 `SETCOLOR …` 与**同嵌套深度**的 `RESETCOLOR` 配成「着色 …：」块。
 *
 * ## 为什么要"配对"而不是"见到 SETCOLOR 就发糖"
 *
 * 糖的 `着色` 是**块**（§3.9：`SETCOLOR` + 块体 + 自动 `RESETCOLOR`），而 `SETCOLOR`
 * 本身没有结尾语义——真实语料里 `SETCOLOR` 22,487 处、`RESETCOLOR` 只有 6,312 处，
 * **绝大多数 SETCOLOR 没有配对的收尾**（颜色靠分发器在函数返回路径上统一复位，见规范
 * §1.5）。若"见到就发糖"，等于替作者猜一个块边界——猜错就是**把别人的代码藏进糖块里**。
 * 故只认**能配对的**：配不上的一律原样保留（fail-visible）。
 *
 * ## 配对判据
 *
 * 同深度 + 最近未配对（栈），且**不跨函数边界 / 不跨停用区**：
 *
 * - **跨函数不配对**：`@` 行起是一个新的函数体。真实语料里"本函数只 SETCOLOR 不收尾"
 *   很常见（颜色交给分发器统一复位），若让它与**下一个函数**里的 `RESETCOLOR` 配上，
 *   整个下一个函数会被缩进进 `着色` 块——那是纯粹的视觉事故。
 * - **跨停用区不配对**：`[SKIPSTART]` 里的内容不是活代码，不该参与块边界推断。
 * - 同深度才配：跨块的收尾往往来自另一层作者的写法，强行配对会把块边界画错。嵌套着色
 *   （块内再来一组）天然支持（栈）。
 */
function planColorBlocks(lines: string[], ctx: ProjContext): ColorPlan {
  const stack: Array<{ line: number; expr: string; depth: number }> = [];
  const openAt = new Map<number, string>();
  const absorbed = new Set<number>();
  /** 块体起点（open+1）→ 计数；块终点（close）→ 出栈计数 */
  const enterAt = new Map<number, number>();
  const leaveAt = new Map<number, number>();
  const total = lines.length;
  let inSkip = false;

  for (let ln = 1; ln <= total; ln++) {
    const content = contentOf(lines[ln - 1] ?? '');
    if (content === '[SKIPSTART]') {
      inSkip = true;
      stack.length = 0; // 停用区打断推断：区前未收尾的 SETCOLOR 不再参与配对
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      continue;
    }
    if (inSkip) continue;
    if (content.startsWith('@')) {
      // 新函数体：上一函数未收尾的 SETCOLOR 就此作废（否则会把下个函数整段缩进进去）
      stack.length = 0;
      continue;
    }
    const open = /^SETCOLOR\s+(.+)$/.exec(content);
    if (open) {
      stack.push({ line: ln, expr: open[1]!.trim(), depth: ctx.enclosingAt(ln).length });
      continue;
    }
    if (content !== 'RESETCOLOR') continue;
    const depth = ctx.enclosingAt(ln).length;
    // 找最近的**同深度**未配对 SETCOLOR
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k]!.depth !== depth) continue;
      const head = stack.splice(k, 1)[0]!;
      openAt.set(head.line, head.expr);
      absorbed.add(ln);
      enterAt.set(head.line + 1, (enterAt.get(head.line + 1) ?? 0) + 1);
      leaveAt.set(ln, (leaveAt.get(ln) ?? 0) + 1);
      break;
    }
  }

  // 逐行累积"处于几个块体内"（O(n)；嵌套着色会正确叠加）
  const bump = new Array<number>(total + 1).fill(0);
  let active = 0;
  for (let ln = 1; ln <= total; ln++) {
    active += enterAt.get(ln) ?? 0;
    bump[ln] = active;
    active -= leaveAt.get(ln) ?? 0;
  }

  return {
    openAt,
    absorbed,
    bumpAt: (line) => (line >= 1 && line <= total ? (bump[line] ?? 0) : 0),
  };
}

/* ============================== 结构上下文 ============================== */

interface ProjContext {
  /** 该行的控制流语句（无 → undefined） */
  stmtAt: (line: number) => ControlFlowStatement | undefined;
  /** 该行所处块深度（最外层 = 0；取 `scanControlFlow` 的 enclosing 栈长） */
  indentAt: (line: number, raw: string) => number;
  /** 包着该行的块种类栈（如 `['if','data']`）——用于数据表体判据 */
  enclosingAt: (line: number) => string[];
}

function buildContext(lines: string[], statements: ControlFlowStatement[]): ProjContext {
  const stmtByLine = new Map<number, ControlFlowStatement>();
  for (const st of statements) if (!stmtByLine.has(st.line)) stmtByLine.set(st.line, st);

  const total = lines.length;
  const enclosing: string[][] = new Array(total + 1);
  const stack: string[] = [];
  let si = 0;
  for (let ln = 1; ln <= total; ln++) {
    while (si < statements.length && statements[si]!.line === ln) {
      const st = statements[si]!;
      enclosing[ln] = [...stack]; // 开块行自身不算在自己体内
      const pair = pairOf(st.kind);
      if (pair) stack.push(pair);
      else if (CLOSE_KINDS.has(st.kind)) stack.pop();
      si++;
    }
    if (enclosing[ln] === undefined) enclosing[ln] = [...stack];
  }

  return {
    stmtAt: (line) => stmtByLine.get(line),
    enclosingAt: (line) => enclosing[line] ?? [],
    indentAt: (line, raw) => {
      const st = stmtByLine.get(line);
      // 控制流行用语句自身深度（开块行记"开启前"深度，与糖缩进口径一致）
      if (st) return st.depth;
      const env = enclosing[line];
      if (env) return env.length;
      // 无结构信息（scanControlFlow 缺席）→ 退回原文缩进层
      return indentLevelOf(raw);
    },
  };
}

function pairOf(kind: string): string | null {
  if (OPEN_PAIR[kind] !== undefined) return OPEN_PAIR[kind]!;
  if (PRINTDATA_OPEN.has(kind)) return 'data';
  if (TRY_CATCH_OPEN.has(kind)) return 'try';
  if (TRY_LIST_OPEN.has(kind)) return 'funclist';
  return null;
}

/** 需要表达式的块头（表达式缺失时宁可不映射） */
function needsExpression(kind: string): boolean {
  return (
    kind === 'IF' ||
    kind === 'ELSEIF' ||
    kind === 'SELECTCASE' ||
    kind === 'CASE'
  );
}

/* ============================== 行工具 ============================== */

function splitSourceLines(source: string): string[] {
  const src = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 去行首缩进 + 行尾空白 */
function contentOf(line: string): string {
  return line.replace(/^[ \t\u3000]*/, '').replace(/[ \t\u3000]+$/, '');
}

/** 原文缩进层（TAB 数 + 空格按 4 折算；与 lexer 的 indentLevel 同口径） */
function indentLevelOf(line: string): number {
  const m = /^[ \t\u3000]*/.exec(line);
  const prefix = m ? m[0] : '';
  let tabs = 0;
  let spaces = 0;
  for (const ch of prefix) {
    if (ch === '\t') tabs++;
    else if (ch === '\u3000') spaces += 2;
    else if (ch === ' ') spaces += 1;
  }
  return tabs + (spaces > 0 ? Math.ceil(spaces / 4) : 0);
}

/** 行内条件 `\@…\@` 检测（本版不投影） */
function hasInlineCondition(text: string): boolean {
  return text.includes('\\@') || text.includes('@\\');
}

/**
 * 文本体**可读化**：把原生记号反糖成糖的主形。
 *
 * 两步（都是**显示**口径，判据封闭、失败即原样保留）：
 *
 * 1. **代词**：`%CALLNAME:TARGET%` → `{她}`、`%CALLNAME:MASTER%` → `{你}`
 *    （反向表派生自 `expression.ts` 的 `PRONOUN_MAP`，正反对称是构造事实）；
 * 2. **属性**（2026-10-12 用户第 7 条）：`{CFLAG:TARGET:1088}` → `{她的好感度}`、
 *    `%TALENT:TARGET:恋慕%` → `{她的恋慕}`——需要变量字典的**反向**查询
 *    （`DictionaryLookup.nameAt`）；查不到名称**一律不动**（宁可留数字，不编名字）。
 *
 * `%…%` 是**有界记号**（自带首尾 `%`），故纯文本替换不会切到相邻变量引用。
 */
function readableText(text: string, deps: LiftDeps): string {
  let out = text;
  for (const [form, pronoun] of PRONOUN_REVERSE) {
    if (out.includes(form)) out = out.split(form).join(`{${pronoun}}`);
  }
  return reverseAttributes(out, deps);
}

/**
 * 属性反糖：把变量引用换成糖的"代词 + 属性"写法。**两种作用面，判据不同**：
 *
 * - **插值**（`{…}` / `%…%`）：只在"整支恰是一个变量引用"时替换——`{CFLAG:TARGET:1088}`
 *   → `{她的好感度}`，而 `{CFLAG:TARGET:1088 + 1}` **不碰**（硬拆表达式只会给出读不出来的糖）。
 *   替换时**定界符原样保留**（把 `{…}` 变成裸文本会直接改坏台词）。
 * - **表达式**（控制流条件 / 赋值右值）：引用夹在运算符之间（`CFLAG:TARGET:1088 >= 500`），
 *   故做**词级**替换；双引号字符串字面量内不碰（那里可能恰好写着同样的字样）。
 */
function reverseAttributes(text: string, deps: LiftDeps): string {
  const dict = deps.dictionary?.();
  if (!dict?.nameAt) return text;
  return text
    .replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
      const sugar = sugarForRef(inner, dict);
      return sugar === undefined ? whole : `{${sugar}}`;
    })
    .replace(/%([^%]+)%/g, (whole, inner: string) => {
      const sugar = sugarForRef(inner, dict);
      return sugar === undefined ? whole : `{${sugar}}`;
    });
}

/** 表达式里的变量引用（`FAMILY[:SCOPE]:INDEX`；索引允许中日文名与编号） */
const EXPR_REF_RE =
  /\b(CFLAG|TALENT|ABL|EXP|MARK|BASE|PALAM|TEQUIP|TCVAR):(?:(TARGET|MASTER):)?([^:\s()[\]{},%]+)/g;

/**
 * 表达式侧反糖（**词级**）：把条件里的角色属性引用逐个换成 `她的X`。
 * 双引号字面量整段跳过（不识别的写法一律保留，不猜）。
 */
function reverseExprAttributes(text: string, deps: LiftDeps): string {
  const dict = deps.dictionary?.();
  if (!dict?.nameAt) return text;
  return text
    .split(/("(?:[^"]*)")/g)
    .map((seg) =>
      seg.startsWith('"')
        ? seg
        : seg.replace(EXPR_REF_RE, (whole, family: string, scope: string | undefined, index: string) =>
            sugarForRefParts(family, scope, index, dict) ?? whole,
          ),
    )
    .join('');
}

/**
 * "整支恰是一个变量引用"时的糖写法（不含定界符）；`undefined` = 不该动。
 *
 * 认两种形态：
 * - `FAMILY:TARGET:IDX` / `FAMILY:MASTER:IDX` → `她的IDX名` / `你的IDX名`
 * - `FAMILY:IDX`（省略角色 = 引擎语义的角色 1D，即 TARGET 作用域）→ `她的IDX名`
 */
function sugarForRef(inner: string, dict: DictionaryLookup): string | undefined {
  const m = /^\s*([A-Z]+)(?::([A-Za-z0-9_]+))?(?::(.+?))?\s*$/.exec(inner);
  if (!m) return undefined;
  const family = m[1]!;
  if (m[3] !== undefined) return sugarForRefParts(family, m[2]!, m[3], dict);
  if (m[2] === undefined) return undefined; // 裸族名（`CFLAG`）：语义是"角色 1D 首格"，不发糖
  return sugarForRefParts(family, undefined, m[2], dict);
}

/**
 * 三段逻辑的唯一点：族必须是**角色作用域**、角色必须是 TARGET/MASTER、名称必须查得到。
 *
 * 为什么这三条一条都不能放宽：
 * - 全局族（`FLAG`/`TFLAG`）写成 `她的FLAG` 是**错的**——"不写"好过"写错"；
 * - 其它角色的属性糖里没有对应写法（`{角色12的X}` 只覆盖 CALLNAME）；
 * - 名称查不到就保留原样的数字——**绝不编名字**（那是"看着像懂了其实被误导"）。
 */
function sugarForRefParts(
  family: string,
  scope: string | undefined,
  index: string,
  dict: DictionaryLookup,
): string | undefined {
  if (!CHAR_SCOPED_FAMILIES.has(family)) return undefined;
  const effective = scope ?? 'TARGET';
  const possessive =
    effective === 'TARGET' ? '她的' : effective === 'MASTER' ? '你的' : undefined;
  if (possessive === undefined) return undefined;
  const name = dict.nameAt?.(family, index);
  if (name === undefined) return undefined;
  return `${possessive}${name}`;
}

/** 结构扫描的防御性包装：扫描器抛错 → 退化为"无结构信息"（不中断投影） */
function safeScan(
  scan: (text: string) => ControlFlowStatement[],
  text: string,
): ControlFlowStatement[] {
  try {
    const out = scan(text);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}