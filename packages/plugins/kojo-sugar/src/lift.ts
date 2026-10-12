/**
 * 糖提升建议器（v0.3 批 S5）—— **原生 ERB → 糖候选**（与降糖方向相反）。
 *
 * 设计与判据权威：`docs/archive/LIFT-SUGGESTER-DESIGN.md`（§1 自证 / §2 四类糖 / §3 坐标 /
 * §5 边界从严 / §6 取舍）。
 *
 * ## 核心思想：**自证，而不是"看起来像"**
 *
 * 编译是有损的（同一个 ERB 片段可能有多种合理糖写法），所以任何启发式识别都可能
 * 误报。本模块的应对不是"把启发式调准"，而是**让误报在结构上不可能发生**：
 *
 * ```
 * ① 扫描原生 ERB → 找出形态上"像某一类糖"的区间
 * ② 逆向组装该区间的糖源码片段（de-transpile）
 * ③ 把片段包进最小 `.kojo` 文件 → 交给 S2 的 transpile（**复用，不重实现**）
 * ④ 取产物里对应的正文区间 → 与原文区间**逐字节比对**
 *      ├─ 一致   → 候选成立
 *      └─ 不一致 → 丢弃，记 skipped('roundtrip-mismatch')
 * ```
 *
 * 关键性质：`candidates` 里的每一项都**已经被验证过转得回去**——消费方（UI 的
 * 逐条确认流）因此不需要自己再做安全检查。
 *
 * ## 为什么"逆组装"可以很薄
 *
 * 实测（设计稿 §3）：S2 的转译器对**原生 ERB 记号原样透传**——
 * `%CALLNAME:MASTER%` 在糖里不会被改写成 `{你}`，`{CFLAG:2}` 也不会被改写。
 * 于是 de-transpile 基本上只是"去掉 `PRINTFORM` 前缀与后缀 / 把 `IF…ENDIF` 换成
 * 缩进块"，而不需要重写文本体。这既让实现薄，也让 round-trip 的成立率高。
 *
 * ## 依赖方向（单向，无环）
 *
 * - 转译：注入 `transpile`（本插件 `sugar.transpile`）——**只调用，不改动内核**；
 * - 结构：注入 `scanControlFlow`（`erb-parser` 的公开纯函数）——用于块配对与
 *   "糖未覆盖的控制流"判据；
 * - 表达式：注入 `parseCondition`（`condition-extractor` 的 `parseExpression`）——
 *   `opaque` 即跳过信号。**缺席时降级**（`degraded: true`），结构判据不受影响。
 *
 * 三条依赖都做成**注入**，单测可以用替身精确驱动各条路径，不必启动内核。
 */

import type {
  ControlFlowStatement,
  ConditionExpr,
  SugarDiagnostic,
  SugarLiftCandidate,
  SugarLiftKind,
  SugarLiftRequest,
  SugarLiftResult,
  SugarLiftSkip,
  SugarLiftSkipReason,
  SugarProjectRequest,
  SugarProjectResult,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { liftProject } from './project';

/* ============================== 依赖 ============================== */

/** 提升建议依赖（实现侧注入；`kojo-sugar` 装配时提供） */
export interface LiftDeps {
  /** 转译函数（纯逻辑；即本插件的 `transpile`）——round-trip 自证的**唯一**手段 */
  transpile: (source: string, options?: { filePath?: string }) => SugarTranspileResult;
  /**
   * 控制流骨架扫描（`erb-parser` 的 `scanControlFlow`）。**缺省 = 用本模块的
   * 内置最小实现**（仅认 IF/ENDIF、SELECTCASE/ENDSELECT 两族）——那会让
   * "糖未覆盖的控制流"判据退化，故生产装配**必须**注入。
   */
  scanControlFlow?: (text: string) => ControlFlowStatement[];
  /**
   * 条件表达式解析（`condition-extractor` 的 `parseExpression`）。
   * **缺省 = 不做可解析性判据**（`degraded: true`）；`opaque` 结果即跳过信号。
   */
  parseCondition?: (text: string) => ConditionExpr;
}

/* ============================== 主入口 ============================== */

/** 生成提升建议（同步纯函数；不读盘、不写盘、不发事件） */
export function liftSuggest(deps: LiftDeps, request: SugarLiftRequest): SugarLiftResult {
  const { source } = request;
  if (typeof source !== 'string') {
    throw new TypeError('提升建议的输入必须是字符串（原生 ERB 文本）');
  }

  const lines = splitSourceLines(source);
  const scan = deps.scanControlFlow ?? builtinScanControlFlow;
  const statements = safeScan(scan, source);
  const degraded = !deps.parseCondition;

  const candidates: SugarLiftCandidate[] = [];
  const skipped: SugarLiftSkip[] = [];
  const ctx: LiftContext = { lines, statements, deps, degraded, request };

  // 块级识别（自顶向下；块区间被消费后其内部不再单独产出候选——避免嵌套重复建议）
  const consumed = new Set<number>();
  liftBlocks(ctx, candidates, skipped, consumed);
  // 行级识别：文本消息行（跳过已被块候选覆盖的行）
  liftPrintLines(ctx, candidates, skipped, consumed);
  // 文件级识别：重复变量引用 → 别名建议
  liftAliases(ctx, candidates, skipped, consumed);

  candidates.sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);
  skipped.sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);
  return { candidates, skipped, degraded };
}

/** 装配建议服务（`kojo-sugar` 的 `index.ts` 调用） */
export function createSugarLiftService(deps: LiftDeps) {
  return {
    liftSuggest: (request: SugarLiftRequest): SugarLiftResult => liftSuggest(deps, request),
    liftProject: (request: SugarProjectRequest): SugarProjectResult => liftProject(deps, request),
  };
}

/* ============================== 上下文 ============================== */

interface LiftContext {
  lines: string[];
  statements: ControlFlowStatement[];
  deps: LiftDeps;
  degraded: boolean;
  request: SugarLiftRequest;
}

/* ============================== 行工具 ============================== */

/** 切源行（去行尾换行；EOL 归一为 `\n`） */
function splitSourceLines(source: string): string[] {
  const src = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 行缩进（TAB 数 + 空格按层级折算；与 lexer 的 `indentLevel` 同口径） */
function indentOf(line: string): number {
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

/** 去行首缩进 + 行尾空白 */
function contentOf(line: string): string {
  return line.replace(/^[ \t\u3000]*/, '').replace(/[ \t\u3000]+$/, '');
}

/** 是否空行 */
function isBlank(line: string): boolean {
  return contentOf(line).length === 0;
}

/** 是否注释行（`;` 起） */
function isComment(line: string): boolean {
  return contentOf(line).startsWith(';');
}

/* ============================== PRINT 家族 ============================== */

/**
 * PRINT 家族变体解析。
 *
 * 只认**四个有糖形态的变体**（规范 §5.1 的产物集）：
 * `PRINTFORMW` / `PRINTFORML` / `PRINTFORMDW` / `PRINTFORMDL`。
 *
 * 其余一律跳过（`unsupported-print-variant`）——因为糖**没有**对应写法：
 * - `PRINTFORM` / `PRINTFORMD`（无 `L/W` 后缀）= 不换行不等待（§3.3 能力边界）；
 * - `PRINTL` / `PRINT` / `PRINTD` 系 = 非 FORM（不做变量插值展开）；
 * - `PRINTS*` / `PRINTDATA*` 系 = 直通形态。
 */
interface PrintVariant {
  speechByColor: boolean; // 是否带 D（忽略 SETCOLOR = 旁白色）
  wait: boolean; // 是否等待（W = 等待）
}

const PRINT_VARIANTS: ReadonlyMap<string, PrintVariant> = new Map([
  ['PRINTFORMW', { speechByColor: false, wait: true }],
  ['PRINTFORML', { speechByColor: false, wait: false }],
  ['PRINTFORMDW', { speechByColor: true, wait: true }],
  ['PRINTFORMDL', { speechByColor: true, wait: false }],
]);

/** 匹配 `PRINTFORM*` 家族行（含被识别为"变体但无糖形态"者，用于区分跳过原因） */
const PRINT_FAMILY_RE = /^(PRINT[A-Z]*)\s([\s\S]*)$/;

/** 该行是否 PRINT 家族（任意变体） */
function isPrintFamily(text: string): boolean {
  return PRINT_FAMILY_RE.test(text);
}

/* ============================== 文本体逆向 ============================== */

/**
 * 文本体逆组装（原生 ERB 文本 → 糖文本）。
 *
 * 实测结论（设计稿 §3）：S2 的转译器对以下**原生记号原样透传**，因此逆向时
 * **不需要**改写它们，只需按糖语法处理"引号 / `续`"两处：
 * - `%…%`（字符串族插值）→ 原样保留即能 round-trip（`PRINTFORMW 「%CALLNAME:MASTER%」`
 *   ← 糖 `「%CALLNAME:MASTER%」`）；
 * - `{…}`（数值插值）→ 同上；
 * - `\@条件?真#假\@`（行内条件）→ 糖里必须写成 `{条件 ? "真" : "假"}` 才等价
 *   （糖转译会把 `{}` 条件降回 `\@…\@`）——**本批不逆向行内条件**（见 `hasInlineCondition`）。
 */
function toSugarText(erbBody: string): string {
  return erbBody;
}

/**
 * 行内条件 `\@…\@` 检测（**v1 不逆向**）。
 *
 * 理由：糖的行内条件是 `{条件 ? "A" : "B"}`，把 `\@…\@` 逆向成糖需要在
 * "分支片段 ↔ 糖片段"之间做双向映射（分支里可能又有 `%..%` / `{}`），
 * 风险高于收益，且不影响 round-trip 判据（只是少一类候选 → 漏报，可接受）。
 * 含行内条件的行**整体跳过**（`not-covered`）。
 */
function hasInlineCondition(text: string): boolean {
  return text.includes('\\@') || text.includes('@\\');
}

/* ============================== round-trip 自证 ============================== */

/**
 * 旁白口径——spec §3.1 的 `旁白色:` 头部开关取值。
 *
 * 这是**糖表层语法已有的开关**（不是为本批新增的语法）：`默认` = 旁白走 `D` 系
 * （忽略 `SETCOLOR`，默认色）；`作者色` = 旁白也用角色色（非 `D` 系）。
 * 自证时必须把两种口径都试一遍——否则壳恒为 `默认`，无引号文本永远只能还原成
 * `PRINTFORMDW/L`，而真实语料里 `PRINTFORMW/L <无引号>` 有 12.8 万行（见设计稿 §2.3）。
 */
type NarrationColorMode = '默认' | '作者色';

/** 自证时依次尝试的旁白口径（`默认` 先——社区默认口径，命中优先） */
const NARRATION_COLOR_MODES: readonly NarrationColorMode[] = ['默认', '作者色'];

/**
 * 自证壳（`sugarSource` 转译所需的最小 `.kojo`）。
 *
 * 转译器要求完整文件（`角色:` + `时机 …：` 才会产出正文），故自证时把候选
 * 片段包进这个壳。**壳只用于验证，不进入结果**——结果里的 `sugarSource`
 * 是剥掉壳的纯片段。
 *
 * `narrationColor` 决定壳的 `旁白色:` 头部声明——它**不改变 `sugarSource`**，
 * 只改变"这份糖片段是按哪种旁白口径写的"。候选成立时会把这个口径回写到
 * `SugarLiftCandidate.narrationColor`（消费方应用时需同步写头部声明）。
 */
function wrapForVerification(ctx: LiftContext, body: string, narrationColor: NarrationColorMode): string {
  const charNo = resolveCharacterNo(ctx);
  const face = ctx.request.timingFace ?? '指令';
  const index = ctx.request.timingIndex ?? '1';
  const indented = body
    .split('\n')
    .map((l) => (l.length > 0 ? `\t${l}` : l))
    .join('\n');
  // `默认` 是 head 的缺省值——为了逐字节可比性，只在非默认时才写声明行，
  // 让"默认口径的壳"与既有行为**完全一致**（避免给存量用例引入无谓差异）。
  const head = narrationColor === '默认' ? `角色: ${charNo}` : `角色: ${charNo}\n旁白色: ${narrationColor}`;
  return `${head}\n时机 ${face} ${index}：\n${indented}\n`;
}

/**
 * 角色号解析：请求显式给了就用；否则从文本内的 `_K{n}` 反推；再不行用 `0` 占位。
 *
 * 自证只关心"形态是否一致"，占位值不影响判定（`K0` 与 `K12` 的产物只在函数名上
 * 不同，而比对只看正文区间）。
 */
function resolveCharacterNo(ctx: LiftContext): string {
  if (typeof ctx.request.characterNo === 'number' && Number.isFinite(ctx.request.characterNo)) {
    return String(ctx.request.characterNo);
  }
  for (const line of ctx.lines) {
    const m = /_K(\d+)\b/.exec(line);
    if (m) return m[1]!;
  }
  return '0';
}

/**
 * 自证：糖片段 → 转译 → 取正文区间 → 与原文区间逐字节比对。
 *
 * 正文区间的取法：产物形如
 * ```
 * @M_KOJO…_1
 * ;---                                            ← 骨架注释
 * ;記入チェック（=0, 非表示、1, 表示）
 * LOCAL = 1
 * ;---
 * IF LOCAL                                        ← 信封链起点（转译器生成）
 * <正文…>                                          ← 我们要的区间
 * ENDIF
 * RETURN 1
 * ```
 * 故正文 = **`IF LOCAL` 之后、其配对的 `ENDIF` 之前**（缩进已知：基准 +1 级）。
 * 判据用**几何**（首个 `IF LOCAL` 行 → 末尾 `ENDIF` 行）而非内容匹配——
 * 与 S4 预览的"线性嵌套"假设同源。
 *
 * **两种旁白口径都试**（`默认` 优先）：糖层对"无引号 = 旁白"的 `D` 归属由
 * `旁白色:` 头部开关决定，而壳原本只写默认口径 → `PRINTFORMW/L <无引号>` 会被
 * 误判为不一致。依次尝试可让这类真实语料（12.8 万行）正常成立；命中的口径由
 * 返回值带出，供候选记录（见 `SugarLiftCandidate.narrationColor`）。
 */
function verifyRoundTrip(
  ctx: LiftContext,
  body: string,
  originalText: string,
): { ok: boolean; generatedText: string; diag: SugarDiagnostic[]; narrationColor: NarrationColorMode } {
  let firstGenerated = '';
  let firstDiag: SugarDiagnostic[] = [];
  for (const mode of NARRATION_COLOR_MODES) {
    let result: SugarTranspileResult;
    try {
      result = ctx.deps.transpile(wrapForVerification(ctx, body, mode));
    } catch {
      continue;
    }
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      // 记下首个出错诊断——**所有口径都失败时**用它区分 `transpile-error` 与
      // `roundtrip-mismatch`（生成器给了非法糖 vs 形态对不上）。
      if (firstDiag.length === 0) firstDiag = errors;
      continue;
    }

    const generated = extractBody(result.erb);
    if (generated === null) continue;
    if (firstGenerated.length === 0) firstGenerated = generated;
    // 比对前把两侧都"去基准缩进"：原文块可能嵌在任意深度（如 `IF LOCAL` 体内
    // 为 1 级），而自证壳恒把片段放在 1 级——绝对缩进不可比，**相对缩进才可比**。
    if (normalizeIndent(generated) === normalizeIndent(originalText)) {
      return { ok: true, generatedText: generated, diag: [], narrationColor: mode };
    }
  }
  return { ok: false, generatedText: firstGenerated, diag: firstDiag, narrationColor: '默认' };
}

/**
 * 去基准缩进（左侧公共缩进）：把每行去掉**最小**缩进量。
 *
 * 空行不参与最小缩进计算，也不被填充。例：
 * ```
 * \tIF X        →  IF X
 * \t\tPRINTFORMDW →  \tPRINTFORMDW
 * \tENDIF       →  ENDIF
 * ```
 * 这样"深度 1 的原文块"与"壳里深度 1 的生成块"可比。
 */
/**
 * 缩进归一（**先算层级、再按层级重排**）。
 *
 * ## 为什么不能"按字符剥"
 *
 * 原文缩进可能是 4 空格 / 8 空格 / TAB / 全角空格，而自证壳恒用 TAB。旧实现拿
 * `indentOf`（数的是**层级**：空格 ÷4、全角 ÷2、TAB =1）算出 `min`，却在剥离循环里
 * 按**字符**扣数（空格 1、全角 2、TAB 1）——两把尺子。于是 4 空格缩进的源只剥掉
 * 1 个空格，剩下 3 个空格，与壳产物（已剥干净）判成"不一致"→ 候选被误拒。
 * 实测后果：**凡空格缩进的 `.kojo` 源，💡 升糖候选全部消失**（规范 §6 示例与新建
 * 向导骨架都是 4 空格，等于对大多数糖文件失效）。
 *
 * ## 现在的口径
 *
 * 相对缩进**保留**（嵌套块仍能被区分），绝对缩进与空白字符种类被抹平——这正是
 * "绝对缩进不可比、相对缩进才可比"的本意。尾随空白**不动**（保持比对严格）。
 */
function normalizeIndent(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    min = Math.min(min, indentOf(l));
  }
  if (!Number.isFinite(min)) return text; // 全文空白：原样（无需归一）
  return lines
    .map((l) => {
      if (l.trim().length === 0) return '';
      const level = Math.max(0, indentOf(l) - min);
      return '\t'.repeat(level) + l.replace(/^[ \t\u3000]*/, '');
    })
    .join('\n');
}

/** 从产物里抽正文区间（`IF LOCAL` 之后到其 `ENDIF` 之前），并把基准缩进降一级 */
function extractBody(erb: string): string | null {
  const lines = erb.replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (contentOf(lines[i]!) === 'IF LOCAL') {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  // 从 start 起向下找**同层级**的 ENDIF（基准缩进 = IF LOCAL 的缩进）
  const baseIndent = indentOf(lines[start - 1]!);
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const c = contentOf(lines[i]!);
    if (c === 'ENDIF' && indentOf(lines[i]!) === baseIndent) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  return lines.slice(start, end).join('\n');
}

/* ============================== 块级识别 ============================== */

/**
 * 块级识别（IF 族 / SELECTCASE 族）。
 *
 * 只在**语句的深度 0 层**找块头（`statements[].depth === 0` 即函数体顶层），
 * 因为糖的块是"时机正文里的一级块"；更深的块随外层一起被建议，
 * 不单独产出（避免嵌套重复）。
 */
function liftBlocks(
  ctx: LiftContext,
  candidates: SugarLiftCandidate[],
  skipped: SugarLiftSkip[],
  consumed: Set<number>,
): void {
  const stmts = ctx.statements;
  const byLine = new Map<number, ControlFlowStatement>();
  for (const s of stmts) byLine.set(s.line, s);

  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i]!;
    // 只处理函数体顶层块；`IF LOCAL` 信封层由 `envelopeDepth` 决定真正的"顶层"
    if (st.depth !== envelopeDepth(stmts)) continue;
    if (st.kind === 'SELECTCASE') {
      tryLiftWhen(ctx, i, candidates, skipped, consumed, byLine);
    } else if (st.kind === 'IF') {
      tryLiftIf(ctx, i, candidates, skipped, consumed, byLine);
    }
  }
}

/**
 * 信封层深度 —— `IF LOCAL` 是**转译器自己生成的包装守卫**（S4 预览已定义
 * `isEnvelopeChain`：谓词不可判定 + 产物行无糖源归属），不是作者写下的控制流。
 *
 * 作者视角里这一层不存在（糖语义是"这段文本会输出"），故升糖时必须**透传**
 * 它：从它体内取真正的一级块，而不是把它当候选。
 *
 * 判据：函数体顶层若**恰好**是一条 `IF LOCAL` 开块，返回 1（其体内为一级块）；
 * 否则返回 0。`LOCAL` 是语言局部量、字典不可解析——若当候选处理，自证必然
 * 报 `unknown-identifier`，那是把"骨架"误当"作者代码"。
 */
function envelopeDepth(stmts: readonly ControlFlowStatement[]): number {
  for (const s of stmts) {
    if (s.depth !== 0) continue;
    if (s.kind === 'IF' && s.expression.trim() === 'LOCAL') return 1;
    return 0; // 顶层第一条不是 `IF LOCAL` → 无信封
  }
  return 0;
}

/** 找与 `open` 配对的结束行（深度回到 `open.depth` 的闭合语句） */
function findClose(stmts: readonly ControlFlowStatement[], openIdx: number): number {
  const open = stmts[openIdx]!;
  const closes: Record<string, string> = { IF: 'ENDIF', SELECTCASE: 'ENDSELECT' };
  const want = closes[open.kind];
  if (!want) return -1;
  for (let i = openIdx + 1; i < stmts.length; i++) {
    const s = stmts[i]!;
    if (s.kind === want && s.depth === open.depth) return i;
  }
  return -1;
}

/** `/^([A-Za-z_]+)/` 取行首指令词 */
function leadingWord(text: string): string {
  const m = /^([A-Za-z_]+)/.exec(text);
  return m ? m[1]!.toUpperCase() : '';
}

/**
 * 结构级跳过判据（在组装糖片段**之前**先筛掉"不可能升糖"的区间）。
 *
 * 顺序即优先级：先排除"含糖未覆盖的控制流"，再排除标签/宏/注释干扰，
 * 最后才是 round-trip（那是**最后一道**，不是唯一一道）。
 */
function structuralSkip(
  ctx: LiftContext,
  fromLine: number,
  toLine: number,
): { reason: SugarLiftSkipReason; message: string } | null {
  // 1) 糖未覆盖的控制流 / 标签 / 宏 / 注释
  for (const s of ctx.statements) {
    if (s.line < fromLine || s.line > toLine) continue;
    if (UNSUPPORTED_FLOW.has(s.kind)) {
      return {
        reason: 'unsupported-control-flow',
        message: `第 ${s.line} 行的 ${s.kind} 不在糖的覆盖范围内（糖 v1 不做循环与 TRY 系），整块保留为原生写法。`,
      };
    }
  }
  for (let i = fromLine; i <= toLine; i++) {
    const c = contentOf(ctx.lines[i - 1] ?? '');
    if (leadingWord(c) === 'GOTO' || c.startsWith('$')) {
      return {
        reason: 'label-or-goto',
        message: `第 ${i} 行含标签 / GOTO——糖的产物不生成标签，无法逐字节还原。`,
      };
    }
    if (c.startsWith('#') || c.startsWith('@')) {
      return {
        reason: 'macro-or-directive',
        message: `第 ${i} 行是预处理 / 函数声明，不属于可升糖的语句区。`,
      };
    }
  }
  return null;
}

/** 糖未覆盖的控制流（规范 §7：循环、TRY 系、数据表都不做糖） */
const UNSUPPORTED_FLOW: ReadonlySet<string> = new Set([
  'SIF',
  'FOR',
  'NEXT',
  'WHILE',
  'WEND',
  'REPEAT',
  'REND',
  'DO',
  'LOOP',
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCCALLFORM',
  'TRYCALLLIST',
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAD',
  'DATALIST',
  'STRDATA',
  'NOSKIP',
  'CATCH',
  'ENDCATCH',
  'ENDFUNC',
]);

/** 记录一次块级跳过，并**同时**把该区间标记为已消费 */
function skipBlock(
  skipped: SugarLiftSkip[],
  consumed: Set<number>,
  fromLine: number,
  toLine: number,
  reason: SugarLiftSkipReason,
  message: string,
): void {
  skipped.push({ fromLine, toLine, reason, message });
  markConsumed(consumed, fromLine, toLine);
}

/**
 * IF 块 → `如果 / 否则如果 / 否则`。
 *
 * 区间 = 块头行 → `ENDIF` 行（**含** `ENDIF`——替换后 `ENDIF` 由缩进语义取代）。
 * 糖片段 = 块头 + 缩进一级的分支体（递归，体里的语句仍是原生 ERB 语句的糖化形态）。
 */
function tryLiftIf(
  ctx: LiftContext,
  openIdx: number,
  candidates: SugarLiftCandidate[],
  skipped: SugarLiftSkip[],
  consumed: Set<number>,
  byLine: Map<number, ControlFlowStatement>,
): void {
  const open = ctx.statements[openIdx]!;
  const closeIdx = findClose(ctx.statements, openIdx);
  if (closeIdx < 0) {
    skipBlock(
      skipped,
      consumed,
      open.line,
      open.line,
      'unsupported-control-flow',
      `第 ${open.line} 行的 IF 没有找到配对的 ENDIF（残缺块不猜）。`,
    );
    return;
  }
  const close = ctx.statements[closeIdx]!;
  const fromLine = open.line;
  const toLine = close.line;

  const pre = structuralSkip(ctx, fromLine, toLine);
  if (pre) {
    skipBlock(skipped, consumed, fromLine, toLine, pre.reason, pre.message);
    return;
  }

  const body = buildIfSugar(ctx, openIdx, closeIdx, byLine);
  if (body === null) {
    skipBlock(
      skipped,
      consumed,
      fromLine,
      toLine,
      'mixed-domain-line',
      `第 ${fromLine}–${toLine} 行的块体无法构成一致的糖节点（文本域与逻辑域混行）。`,
    );
    return;
  }

  // 比对区间 = 整个块（含 `ENDIF`）：糖的缩进块虽然"源里不写 ENDIF"，但产物里
  // 每个块**必然**补回一行 `ENDIF`，故产物正文天然含 `ENDIF`——与原文本一致。
  const original = ctx.lines.slice(fromLine - 1, toLine).join('\n');
  const verdict = verifyRoundTrip(ctx, body, original);
  if (!verdict.ok) {
    skipBlock(
      skipped,
      consumed,
      fromLine,
      toLine,
      verdict.diag.length > 0 ? 'transpile-error' : 'roundtrip-mismatch',
      verdict.diag.length > 0
        ? `第 ${fromLine}–${toLine} 行生成的糖片段未通过转译（${verdict.diag[0]!.message}）。`
        : `第 ${fromLine}–${toLine} 行看起来像「如果」块，但转译回来的文本与原文本不一致（差一字即不算，宁可漏报）。`,
    );
    return;
  }

  candidates.push({
    kind: 'if-block',
    fromLine,
    toLine,
    sugarSource: body,
    confidence: 'verified',
    narrationColor: verdict.narrationColor,
    roundTrip: { verified: true, originalText: original, generatedText: verdict.generatedText },
    reason: `第 ${fromLine}–${toLine} 行是一个 IF 块，可改写为缩进式「如果」块（自动补 ENDIF，消灭漏配 ENDIF 的隐患）。`,
  });
  markConsumed(consumed, fromLine, toLine);
}

/** 块内是否有更深的块（嵌套），供 `buildIfSugar` 递归时判定（保留供将来启发式用） */
function hasNestedBlockInside(stmts: readonly ControlFlowStatement[], openIdx: number, closeIdx: number): boolean {
  const open = stmts[openIdx]!;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    if (stmts[i]!.depth > open.depth) return true;
  }
  return false;
}

/**
 * 组装 `如果 / 否则如果 / 否则` 糖片段（缩进按糖语义，一级 = 4 空格）。
 *
 * 分支体逐行处理：块内**同级**的控制流块递归成糖块，其余行按原生语句糖化
 * （文本行 → 糖文本行；IF/ELSEIF/ELSE/ENDIF/SELECTCASE… 由递归处理）。
 * `null` = 无法一致地糖化（含空体 / 混行）。
 */
function buildIfSugar(
  ctx: LiftContext,
  openIdx: number,
  closeIdx: number,
  byLine: Map<number, ControlFlowStatement>,
): string | null {
  const stmts = ctx.statements;
  const open = stmts[openIdx]!;
  const close = stmts[closeIdx]!;

  // 收集分支头（open 自己 + 同深度的 ELSEIF / ELSE）
  const branchHeads: { stmt: ControlFlowStatement; kind: 'if' | 'elseif' | 'else' }[] = [
    { stmt: open, kind: 'if' },
  ];
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const s = stmts[i]!;
    if (s.depth !== open.depth) continue;
    if (s.kind === 'ELSEIF') branchHeads.push({ stmt: s, kind: 'elseif' });
    else if (s.kind === 'ELSE') branchHeads.push({ stmt: s, kind: 'else' });
  }

  const out: string[] = [];
  for (let b = 0; b < branchHeads.length; b++) {
    const head = branchHeads[b]!;
    const bodyStart = head.stmt.line + 1;
    const bodyEnd = b + 1 < branchHeads.length ? branchHeads[b + 1]!.stmt.line - 1 : close.line - 1;

    if (head.kind === 'else') {
      out.push('否则：');
    } else {
      const cond = head.stmt.expression;
      if (cond.trim().length === 0) return null;
      if (!isParsableCondition(ctx, cond)) return null;
      const keyword = head.kind === 'if' ? '如果' : '否则如果';
      out.push(`${keyword} ${cond}：`);
    }

    const body = renderSugarBody(ctx, bodyStart, bodyEnd, byLine);
    if (body === null) return null;
    if (body.length === 0) {
      // 空分支体：糖语法要求块体非空（§5.3 块头无体 = 编译错误）
      return null;
    }
    for (const line of body) out.push(`\t${line}`);
  }
  return out.join('\n');
}

/**
 * `SELECTCASE` 分派 → `当 / 是 / 否则`（规范 §3.6）。
 *
 * **随机组优先**：若分派主体是 `LOCAL[:N]` 且紧邻上一行是 `LOCAL[:N] = RAND:k`，
 * 且 `CASE` 恰为 `0..k-1` 全覆盖 → 建议 `随机` 块（§3.6 末的等概率形态）。
 */
function tryLiftWhen(
  ctx: LiftContext,
  openIdx: number,
  candidates: SugarLiftCandidate[],
  skipped: SugarLiftSkip[],
  consumed: Set<number>,
  byLine: Map<number, ControlFlowStatement>,
): void {
  const open = ctx.statements[openIdx]!;
  const closeIdx = findClose(ctx.statements, openIdx);
  if (closeIdx < 0) {
    skipBlock(
      skipped,
      consumed,
      open.line,
      open.line,
      'unsupported-control-flow',
      `第 ${open.line} 行的 SELECTCASE 没有找到配对的 ENDSELECT（残缺块不猜）。`,
    );
    return;
  }
  const close = ctx.statements[closeIdx]!;
  const fromLine = open.line;
  const toLine = close.line;

  const pre = structuralSkip(ctx, fromLine, toLine);
  if (pre) {
    skipBlock(skipped, consumed, fromLine, toLine, pre.reason, pre.message);
    return;
  }

  const subject = open.expression.trim();
  if (subject.length === 0) {
    skipBlock(
      skipped,
      consumed,
      fromLine,
      toLine,
      'not-covered',
      `第 ${fromLine} 行的 SELECTCASE 没有分派表达式。`,
    );
    return;
  }
  if (!isParsableCondition(ctx, subject)) {
    skipBlock(
      skipped,
      consumed,
      fromLine,
      toLine,
      'unparsable-condition',
      `第 ${fromLine} 行的分派表达式无法解析，无法回写成糖的「当」表达式。`,
    );
    return;
  }

  const randomCount = detectRandomGroup(ctx, openIdx, subject);
  const body =
    randomCount !== null
      ? buildRandomSugar(ctx, openIdx, closeIdx, randomCount, byLine)
      : buildWhenSugar(ctx, openIdx, closeIdx, subject, byLine);

  if (body === null) {
    skipBlock(
      skipped,
      consumed,
      fromLine,
      toLine,
      'mixed-domain-line',
      `第 ${fromLine}–${toLine} 行的分派块体无法构成一致的糖节点（文本域与逻辑域混行）。`,
    );
    return;
  }

  // 随机组的原文区间要**含**上一行 `LOCAL = RAND:n`（否则替换后那行会留下）
  const actualFrom = randomCount !== null ? fromLine - 1 : fromLine;
  const original = ctx.lines.slice(actualFrom - 1, toLine).join('\n');
  const verdict = verifyRoundTrip(ctx, body, original);
  if (!verdict.ok) {
    skipBlock(
      skipped,
      consumed,
      actualFrom,
      toLine,
      verdict.diag.length > 0 ? 'transpile-error' : 'roundtrip-mismatch',
      verdict.diag.length > 0
        ? `第 ${actualFrom}–${toLine} 行生成的糖片段未通过转译（${verdict.diag[0]!.message}）。`
        : `第 ${actualFrom}–${toLine} 行看起来像分派块，但转译回来的文本与原文本不一致（差一字即不算，宁可漏报）。`,
    );
    return;
  }

  candidates.push({
    kind: 'selectcase',
    fromLine: actualFrom,
    toLine,
    sugarSource: body,
    confidence: 'verified',
    narrationColor: verdict.narrationColor,
    roundTrip: { verified: true, originalText: original, generatedText: verdict.generatedText },
    reason:
      randomCount !== null
        ? `第 ${actualFrom}–${toLine} 行是等概率随机组（${randomCount} 个分支），可改写为「随机」块。`
        : `第 ${actualFrom}–${toLine} 行是 SELECTCASE 分派，可改写为「当 / 是」块。`,
  });
  markConsumed(consumed, actualFrom, toLine);
}

/**
 * 随机组判定：`LOCAL[:N] = RAND:k` 紧跟在 SELECTCASE 前一行，主体是同一个
 * `LOCAL[:N]`，且 `CASE` 值恰为 `0..k-1`（顺序无关）。
 * 命中返回分支数 k，否则 null。
 */
function detectRandomGroup(ctx: LiftContext, openIdx: number, subject: string): number | null {
  const open = ctx.statements[openIdx]!;
  const prevLine = ctx.lines[open.line - 2];
  if (prevLine === undefined) return null;
  const prev = contentOf(prevLine);
  const m = /^(\S+)\s*=\s*RAND:(\d+)$/.exec(prev);
  if (!m) return null;
  const slot = m[1]!;
  const k = Number(m[2]!);
  if (!Number.isFinite(k) || k < 2) return null;
  if (subject !== slot) return null;

  // CASE 值必须是 0..k-1 全覆盖，且不能有 CASEELSE
  const closeIdx = findClose(ctx.statements, openIdx);
  if (closeIdx < 0) return null;
  const values: string[] = [];
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const s = ctx.statements[i]!;
    if (s.depth !== open.depth) continue;
    if (s.kind === 'CASEELSE') return null;
    if (s.kind !== 'CASE') continue;
    for (const v of s.expression.split(',')) {
      const t = v.trim();
      if (!/^\d+$/.test(t)) return null;
      values.push(t);
    }
  }
  if (values.length !== k) return null;
  const seen = new Set(values.map((v) => Number(v)));
  for (let i = 0; i < k; i++) if (!seen.has(i)) return null;
  return k;
}

/** `随机：` 块糖片段 */
function buildRandomSugar(
  ctx: LiftContext,
  openIdx: number,
  closeIdx: number,
  count: number,
  byLine: Map<number, ControlFlowStatement>,
): string | null {
  const stmts = ctx.statements;
  const open = stmts[openIdx]!;
  const close = stmts[closeIdx]!;
  // 收集每个 CASE 的行区间（按数值升序排列——糖按书写顺序编号）
  const cases: { value: number; bodyStart: number; bodyEnd: number }[] = [];
  const caseIdx: number[] = [];
  for (let i = openIdx + 1; i < closeIdx; i++) {
    if (stmts[i]!.depth === open.depth && stmts[i]!.kind === 'CASE') caseIdx.push(i);
  }
  for (let c = 0; c < caseIdx.length; c++) {
    const st = stmts[caseIdx[c]!]!;
    const bodyStart = st.line + 1;
    const bodyEnd = c + 1 < caseIdx.length ? stmts[caseIdx[c + 1]!]!.line - 1 : close.line - 1;
    cases.push({ value: Number(st.expression.trim()), bodyStart, bodyEnd });
  }
  if (cases.length !== count) return null;
  cases.sort((a, b) => a.value - b.value);

  const out: string[] = ['随机：'];
  for (const c of cases) {
    const body = renderSugarBody(ctx, c.bodyStart, c.bodyEnd, byLine);
    if (body === null || body.length === 0) return null;
    for (const line of body) out.push(`\t${line}`);
  }
  return out.join('\n');
}

/** `当 / 是 / 否则` 块糖片段 */
function buildWhenSugar(
  ctx: LiftContext,
  openIdx: number,
  closeIdx: number,
  subject: string,
  byLine: Map<number, ControlFlowStatement>,
): string | null {
  const stmts = ctx.statements;
  const open = stmts[openIdx]!;
  const close = stmts[closeIdx]!;

  const heads: { stmt: ControlFlowStatement; isElse: boolean }[] = [];
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const s = stmts[i]!;
    if (s.depth !== open.depth) continue;
    if (s.kind === 'CASE') heads.push({ stmt: s, isElse: false });
    else if (s.kind === 'CASEELSE') heads.push({ stmt: s, isElse: true });
  }
  if (heads.length === 0) return null;

  const out: string[] = [`当 ${subject}：`];
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h]!;
    const bodyStart = head.stmt.line + 1;
    const bodyEnd = h + 1 < heads.length ? heads[h + 1]!.stmt.line - 1 : close.line - 1;

    if (head.isElse) {
      out.push('\t否则：');
    } else {
      const sugarValues = renderCaseValuesSugar(head.stmt.expression);
      if (sugarValues === null) return null;
      out.push(`\t是 ${sugarValues}：`);
    }
    const body = renderSugarBody(ctx, bodyStart, bodyEnd, byLine);
    if (body === null || body.length === 0) return null;
    for (const line of body) out.push(`\t\t${line}`);
  }
  return out.join('\n');
}

/**
 * `CASE a TO b, c` → 糖 `a 到 b, c`（规范 §3.6）。
 *
 * 反向映射只做 `TO` → `到`；值本身原样（`lowerExpression` 会把 `到` 降回 `TO`，
 * 且 round-trip 会验证一致性）。含函数调用/复杂表达式的值原样保留，
 * 由 round-trip 决定是否成立。
 */
function renderCaseValuesSugar(erbCase: string): string | null {
  const parts = splitTopLevel(erbCase);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.length === 0) return null;
    const m = /^([\s\S]+?)\s+TO\s+([\s\S]+)$/.exec(t);
    if (m) out.push(`${m[1]!.trim()} 到 ${m[2]!.trim()}`);
    else out.push(t);
  }
  return out.join(', ');
}

/** 顶层逗号切分（括号 / 引号感知） */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) {
        cur += s[i + 1]!;
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/* ============================== 块体渲染 ============================== */

/**
 * 把 ERB 行区间渲染成糖语句行（不含缩进；缩进由调用方加）。
 *
 * **一致性前提**：区间内的行必须能"一致地"糖化，否则返回 `null`：
 * - 已糖化的块（IF / SELECTCASE）→ 递归进入（当且仅当它是区间内的**顶层**块）；
 * - PRINT 家族有糖形态者 → 去前缀得糖文本；
 * - 其它逻辑语句（赋值 / 调用 / 未知指令）→ **原样**（糖的原生直通行允许全大写指令
 *   与非 `字母数字` 行；赋值行 `X = Y` 亦被糖识别为赋值并原样降回 → 能 round-trip）；
 * - 注释行 / 空行 → `null`（糖的块体里保留注释会破坏逐字节一致性）。
 *
 * `[]`（空数组）表示区间内没有可糖化内容（调用方按各糖的约束判定是否合法）。
 */
function renderSugarBody(
  ctx: LiftContext,
  fromLine: number,
  toLine: number,
  byLine: Map<number, ControlFlowStatement>,
): string[] | null {
  const out: string[] = [];
  let i = fromLine;
  while (i <= toLine) {
    const raw = ctx.lines[i - 1] ?? '';
    const content = contentOf(raw);

    if (content.length === 0) return null; // 空行打断连段（保守）
    if (content.startsWith(';')) return null; // 注释行（保守：糖片段里保留会破坏比对）

    const st = byLine.get(i);
    if (st && (st.kind === 'IF' || st.kind === 'SELECTCASE')) {
      // 递归：整块交给对应组装器（要求该块完全落在本区间内）
      const all = ctx.statements;
      const idx = all.indexOf(st);
      const closeIdx = findClose(all, idx);
      if (closeIdx < 0 || all[closeIdx]!.line > toLine) return null;
      const sub =
        st.kind === 'IF'
          ? buildIfSugar(ctx, idx, closeIdx, byLine)
          : buildWhenSugarFromIdx(ctx, idx, closeIdx, byLine);
      if (sub === null) return null;
      for (const l of sub.split('\n')) out.push(l);
      i = all[closeIdx]!.line + 1;
      continue;
    }

    // PRINT 家族行
    const pm = PRINT_FAMILY_RE.exec(content);
    if (pm) {
      const sugar = printLineToSugar(pm[1]!, pm[2]!);
      if (sugar === null) return null;
      out.push(sugar);
      i++;
      continue;
    }

    // 其它逻辑语句：原样（糖原生直通 / 赋值降糖皆能还原）
    if (hasInlineCondition(content)) return null;
    out.push(content);
    i++;
  }
  return out;
}

/** `buildWhenSugar` 的索引版（供递归调用） */
function buildWhenSugarFromIdx(
  ctx: LiftContext,
  openIdx: number,
  closeIdx: number,
  byLine: Map<number, ControlFlowStatement>,
): string | null {
  const subject = ctx.statements[openIdx]!.expression.trim();
  if (subject.length === 0) return null;
  const randomCount = detectRandomGroup(ctx, openIdx, subject);
  if (randomCount !== null) return buildRandomSugar(ctx, openIdx, closeIdx, randomCount, byLine);
  return buildWhenSugar(ctx, openIdx, closeIdx, subject, byLine);
}

/**
 * PRINT 家族行 → 糖文本行（§5.1 的**逆**算法）。
 *
 * 逆向逻辑（与 `codegen.printLine` 严格互逆）：
 * - `wait=false`（`L` 后缀）→ 行尾加 ` 续`；
 * - `sortByColor`（`D` 后缀）→ 糖里**不额外标注**：糖按"无引号 = 旁白 = 默认色"
 *   自动选 `D`，故旁白文本天然还原为 `D` 系；台词文本（`「` 起）还原为非 `D` 系。
 *
 * 于是"不该有 D 却有 D"（`PRINTFORMDW 「台词」`）或"该有 D 却没有"
 * （`PRINTFORMW 旁白`）这类**原生手写不一致**会**自动被 round-trip 拦下**
 * ——这正是自证的价值：逆向逻辑本身不必穷举所有边界。
 */
function printLineToSugar(word: string, body: string): string | null {
  const variant = PRINT_VARIANTS.get(word);
  if (!variant) return null;
  const text = body.replace(/[ \t\u3000]+$/, '');
  if (hasInlineCondition(text)) return null;
  const sugarBody = toSugarText(text);
  return variant.wait ? sugarBody : `${sugarBody} 续`;
}

/* ============================== 行级识别 ============================== */

/** 文本消息行 → 糖文本行（候选区间 = 单行） */
function liftPrintLines(
  ctx: LiftContext,
  candidates: SugarLiftCandidate[],
  skipped: SugarLiftSkip[],
  consumed: Set<number>,
): void {
  for (let i = 0; i < ctx.lines.length; i++) {
    const lineNo = i + 1;
    if (consumed.has(lineNo)) continue;
    const content = contentOf(ctx.lines[i]!);
    if (content.length === 0 || content.startsWith(';')) continue;

    const pm = PRINT_FAMILY_RE.exec(content);
    if (!pm) {
      // 全大写 PRINT 家族之外的指令（PRINTBUTTON 等）→ 记 not-covered（不静默）
      if (/^PRINT[A-Z]*\b/.test(content)) {
        skipped.push({
          fromLine: lineNo,
          toLine: lineNo,
          reason: 'unsupported-print-variant',
          message: `第 ${lineNo} 行的 ${leadingWord(content)} 没有糖形态（糖恒产出 PRINTFORM{W/L/DW/DL}）。`,
        });
      }
      continue;
    }

    const word = pm[1]!;
    const body = pm[2]!;
    if (!PRINT_VARIANTS.has(word)) {
      skipped.push({
        fromLine: lineNo,
        toLine: lineNo,
        reason: 'unsupported-print-variant',
        message: `第 ${lineNo} 行的 ${word} 没有糖形态（不换行 / 非 FORM 系不在糖的覆盖范围内）。`,
      });
      continue;
    }

    const sugar = printLineToSugar(word, body);
    if (sugar === null) {
      skipped.push({
        fromLine: lineNo,
        toLine: lineNo,
        reason: 'not-covered',
        message: `第 ${lineNo} 行含行内条件 \\@…\\@，本版不做这类升糖。`,
      });
      continue;
    }

    const original = ctx.lines[i]!;
    const verdict = verifyRoundTrip(ctx, sugar, original);
    if (!verdict.ok) {
      skipped.push({
        fromLine: lineNo,
        toLine: lineNo,
        reason: verdict.diag.length > 0 ? 'transpile-error' : 'roundtrip-mismatch',
        message:
          verdict.diag.length > 0
            ? `第 ${lineNo} 行生成的糖片段未通过转译（${verdict.diag[0]!.message}）。`
            : `第 ${lineNo} 行看起来像文本行，但转译回来的文本与原文本不一致（差一字即不算，宁可漏报）。`,
      });
      continue;
    }

    candidates.push({
      kind: 'print-message',
      fromLine: lineNo,
      toLine: lineNo,
      sugarSource: sugar,
      confidence: 'verified',
      narrationColor: verdict.narrationColor,
      roundTrip: { verified: true, originalText: original, generatedText: verdict.generatedText },
      reason: `第 ${lineNo} 行可改写为糖文本行（引号 / 「续」自动决定颜色与等待，不必再挑 PRINTFORM 变体）。`,
    });
    consumed.add(lineNo);
  }
}

/* ============================== 别名提示 ============================== */

/** 触发"值得起别名"提示的最小重复次数（引入一行声明至少要省出 3 处才划算） */
const ALIAS_MIN_OCCURRENCES = 3;

/**
 * 变量引用形态：`FAMILY:SEG` / `FAMILY:SEG:SEG`（如 `CFLAG:TARGET:1088`）。
 *
 * 规则：`FAMILY` 后跟**至少一段** `:…`；段内容不含空白 / `%` / `{}` / 引号。
 * 因段内可能含中文（`TALENT:TARGET:胆怯`），故按"非分隔符"字符集而非 `\w`。
 */
const VAR_REF_RE = /\b([A-Z][A-Z0-9_]*)((?::[^\s:%「」(){}]+)+)/g;

/**
 * 重复变量引用 → `别名` **只作为提示（不做候选）**（规范 §3.1 / §5.0）。
 *
 * ## 为什么这一类默认不出候选（S5 实测定案）
 *
 * `别名` 与其它三类糖在机制上根本不同：它是**糖源码层的预处理**（§5.0 第 0 步
 * ——先把裸标识符换成目标，再降糖）。而原生 ERB 里出现的引用**没有一种是糖层
 * 会介入的形态**：
 *
 * | 原生形态 | 糖层行为 | 能否靠别名还原 |
 * | --- | --- | --- |
 * | `%CFLAG:TARGET:1088%` | 原样透传 | ✗ 别名改不到 `%…%` 内部 |
 * | `CFLAG:TARGET:1088`（行首大写指令行） | 原样透传（§3.10 直通） | ✗ 直通行不做别名替换 |
 * | 赋值左值 `CFLAG:TARGET:1088 = 1` | 透传 | ✗ 同上 |
 *
 * 也就是说：**在原生 ERB 这一侧，"别名"没有任何可验证的落点**——把引用改成
 * 别名之后，糖转译产出的 ERB 与原来必然不同（因为糖层原本就没碰过那个引用）。
 * 规范 §5.0 描述的是**作者手写糖源码**时的体验（作者写 `今天已触发`，工具帮
 * 他展开），不是"从原生 ERB 反推别名"。
 *
 * 故 S5 对本类的处理是：**照常扫描并报告**（"这里重复了 N 次，写糖时值得起
 * 个别名"），但一律记 `not-covered`、**不产出候选**——宁可漏报，不可错报。
 * 这条边界登记在 `docs/IMPLEMENTATION-LOG.md` §5.31 与设计稿 §6。
 */
function liftAliases(
  ctx: LiftContext,
  candidates: SugarLiftCandidate[],
  skipped: SugarLiftSkip[],
  consumed: Set<number>,
): void {
  void candidates; // 本类恒不出候选——保留参数以统一调用形态
  const counts = new Map<string, number[]>();
  for (let i = 0; i < ctx.lines.length; i++) {
    const lineNo = i + 1;
    const raw = ctx.lines[i]!;
    const content = contentOf(raw);
    if (content.length === 0 || content.startsWith(';')) continue;
    if (content.startsWith('@') || content.startsWith('#')) continue;
    for (const m of content.matchAll(VAR_REF_RE)) {
      const ref = `${m[1]}${m[2]}`;
      const list = counts.get(ref);
      if (list) list.push(lineNo);
      else counts.set(ref, [lineNo]);
    }
  }

  // 取出现最多者（同分按首次出现行升序，保证确定性）
  const ranked = [...counts.entries()]
    .filter(([, ls]) => ls.length >= ALIAS_MIN_OCCURRENCES)
    .sort((a, b) => b[1].length - a[1].length || a[1][0]! - b[1][0]!);

  for (const [ref, occurrences] of ranked) {
    skipped.push({
      fromLine: occurrences[0]!,
      toLine: occurrences[occurrences.length - 1]!,
      reason: 'not-covered',
      message:
        `变量 ${ref} 在本文件中出现 ${occurrences.length} 次，写糖时值得起个别名；` +
        `但它在本文件里全是**原生 ERB 形态**（\`%…%\` 插值 / 全大写直通行），` +
        `糖层的别名替换不介入这些位置，无法自证「改了别名产物一字不变」——` +
        `按「宁可漏报」不做候选。`,
    });
  }
  void consumed;
}

/* ============================== 片段工具 ============================== */

/** 条件可解析性（`opaque` = 跳过信号；服务缺席时一律"可解析"并全局标 degraded） */
function isParsableCondition(ctx: LiftContext, cond: string): boolean {
  if (!ctx.deps.parseCondition) return true;
  try {
    return ctx.deps.parseCondition(cond).kind !== 'opaque';
  } catch {
    return false;
  }
}

/** 标记区间已被候选消费（避免嵌套重复建议） */
function markConsumed(consumed: Set<number>, fromLine: number, toLine: number): void {
  for (let i = fromLine; i <= toLine; i++) consumed.add(i);
}

/** 扫描失败的宽容包装（结构判据丢失 → 只影响跳过精度，不影响正确性） */
function safeScan(scan: (text: string) => ControlFlowStatement[], text: string): ControlFlowStatement[] {
  try {
    return scan(text);
  } catch {
    return [];
  }
}

/** 内置最小扫描（仅 IF / SELECTCASE 两族；生产装配须注入 erb-parser 的完整实现） */
function builtinScanControlFlow(text: string): ControlFlowStatement[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: ControlFlowStatement[] = [];
  const stack: string[] = [];
  const opens: Record<string, string> = { IF: 'if', SELECTCASE: 'select' };
  const branches: Record<string, string> = { ELSEIF: 'if', ELSE: 'if', CASE: 'select', CASEELSE: 'select' };
  const closes: Record<string, string> = { ENDIF: 'if', ENDSELECT: 'select' };
  for (let i = 0; i < lines.length; i++) {
    const c = contentOf(lines[i]!);
    if (c.length === 0 || c.startsWith(';') || c.startsWith('@') || c.startsWith('#')) continue;
    const w = leadingWord(c);
    const rest = c.slice(w.length).trim();
    if (opens[w] !== undefined) {
      out.push({ kind: w, expression: rest, depth: stack.length, line: i + 1 });
      stack.push(opens[w]!);
    } else if (branches[w] !== undefined) {
      out.push({ kind: w, expression: rest, depth: Math.max(0, stack.length - 1), line: i + 1 });
    } else if (closes[w] !== undefined) {
      const at = stack.lastIndexOf(closes[w]!);
      const depth = at >= 0 ? at : stack.length;
      out.push({ kind: w, expression: '', depth, line: i + 1 });
      if (at >= 0) stack.length = at;
    }
  }
  return out;
}
