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
import { PRONOUN_REVERSE } from './expression';

/* ============================== 规则表（封闭） ============================== */

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
        const text = mk(expr);
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
        text: variant.wait ? readableText(body) : `${readableText(body)} 续`,
        indent: ctx.indentAt(ln, raw),
        visible: true,
        reason: null,
      });
      continue;
    }

    // 其余（赋值 / 调用 / `@` / `#` / `$` / 其他指令）→ 原样保留
    recs.push(native(ln, 'other'));
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
 * 文本体**可读化**：把原生代词记号反糖成糖的主形（`%CALLNAME:TARGET%` → `{她}`）。
 *
 * - 反向表派生自 `expression.ts` 的 `PRONOUN_MAP`（正反对称是构造事实）；
 * - `%…%` 是**有界记号**（自带首尾 `%`），故纯文本替换不会切到相邻变量引用；
 * - 只在文本体调用（控制流表达式不走这里，见模块头注纪律 2）。
 */
function readableText(text: string): string {
  let out = text;
  for (const [form, pronoun] of PRONOUN_REVERSE) {
    if (out.includes(form)) out = out.split(form).join(`{${pronoun}}`);
  }
  return out;
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