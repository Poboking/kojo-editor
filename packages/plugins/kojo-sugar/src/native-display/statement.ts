/**
 * 赋值 / 调用 / 输出行的中文显示形（**任务线 ZH-S**）。
 *
 * 覆盖面（认得出就翻，认不出返回 `null`，**绝不原样返回**）：
 * - 赋值：`<族头>[:作用域][:索引] = 值`（`+= -= *= /=` 同形）——族头经 `lookup.familyAlias`
 *   换成中文别名（`TFLAG:193 = 1` → `时标:193 = 1`）；查不到别名就保留族头原名，**但整行仍必须
 *   是中文形**（`RESULT` / `LOCAL` 这类语言层槽位给中文显示名）；
 * - 调用：`CALL` / `CALLL` / `CALLFORM` / `TRYCALL` / `TRYCALLFORM` / `TRYJUMP` /
 *   `TRYGOTO` / `TRYGOTOFORM`（后两枚 = `sugar-ident` 的 `TRY_SINGLE_LINE` 单行档，
 *   **不在** ZH-C 认领的那九枚开块词里）；
 * - 位原语：`SETBIT` / `CLEARBIT` / `INVERTBIT`；
 * - 输出族：`PRINT` / `PRINTL` / `PRINTW` / `PRINTV` / `PRINTVL` / `PRINTFORM*` / `PRINTDATA*` /
 *   `PRINTSINGLE*`（已有台词投影的形态**不要重复接管**，只补 `native()` 落到的那些变体）；
 * - 排版与等待：`SETCOLOR` / `RESETCOLOR` / `FONTBOLD` / `FONTITALIC` / `FONTSIZE` / `CLEARLINE` /
 *   `FORCEWAIT` / `WAIT` / `DRAWLINE` / `BAR` / `BARL` / `REDRAW`；
 * - 输入：`INPUT` / `INPUTS` / `PRINTBUTTON` / `PRINTBUTTONC`。
 *
 * 与 ZH-C 的分工：**本层只管"非块、非预处理"的行**；两条 pass 不许互相 import。
 * TRY 家族按**档位**分家（不是按前缀）：开块九枚归 ZH-C 的 `试探 原形 …`，
 * 单行档（`sugar-ident` 的 `TRY_SINGLE_LINE`）归本表的动词语——名单只有一份，互斥由测试钉。
 *
 * ## 口径备忘（写死在这里，免得读代码的人猜）
 * - 语言层槽位中文名：`LOCAL→局部` `LOCALS→局部$` `LOCALSS→局部表` `RESULT→结果`
 *   `RESULTS→结果$` `COUNT→计数` `COUNTS→计数$` `COUNTSS→计数表` `SUCCESS→成否`；
 *   `ARG→实参` / `ARGS→实参$` **复用 `keywords.ts` 的单一真源**（1 基换算：`ARG:k → 实参:(k+1)`，
 *   与 `argTokenCnLabel` 同口径），本层不另造第二套。
 * - 行尾节奏记号沿用投影既有语言：换行不等待 → ` 续`，等待 → ` 等待`，空体 → `空行`。
 * - 参数体（`%VAR%`、`@"…"`、函数名、数字索引）**原样照抄**——行内残留英文记号是允许的，
 *   红线只禁"整行逐字等于源行"。
 * - 认不出 ⇒ `null`（`passes.ts` 负责显式兜底），宁缺勿猜。
 */

import { VARIADIC_ARG_NUMERIC, VARIADIC_ARG_STRING } from '../keywords';
import { TRY_SINGLE_LINE } from '../sugar-ident';
import type { NativeDisplayInput, NativeDisplayLookup, NativeDisplayPass } from './types';

/* ==================== 词法小工具（行级，不建 token 流） ==================== */

/** 剥行尾 `;` 注释（引号内的 `;` 不算）；注释原样回填到渲染结果尾部 */
function splitTrailingComment(line: string): { code: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') return { code: line.slice(0, i).trimEnd(), comment: line.slice(i) };
  }
  return { code: line, comment: '' };
}

/** 按**顶层** `sep` 拆分（括号深度与引号内的分隔符不切） */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of s) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      cur += ch;
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ==================== 目标（赋值左值 / 位原语第一参数） ==================== */

/**
 * 语言层内置槽位（Emuera 引擎级、非游戏知识）。
 * `实参` / `实参$` 不在这张表里——ARG 族走 `keywords.ts` 的单一真源单独处理。
 */
const LANG_SLOTS: Readonly<Record<string, string>> = {
  LOCAL: '局部',
  LOCALS: '局部$',
  LOCALSS: '局部表',
  RESULT: '结果',
  RESULTS: '结果$',
  COUNT: '计数',
  COUNTS: '计数$',
  COUNTSS: '计数表',
  SUCCESS: '成否',
};

/** 一个可赋值的引用：族头（可含 `$`）+ 零或多个 `:索引` / `[索引]` / `(索引)` 后缀 */
const TARGET_RE = /^([A-Za-z][A-Za-z0-9_$]*)((?::[^:,()[\]\s]+|\[[^[\]]*\]|\([^()]*\))*)$/;
/** 后缀链的第一段索引名（数字或符号名都喂 `slotCn`——批 F 口径：数字索引也能查到槽位中文名） */
const FIRST_SUFFIX_RE = /^:([^:()[\]\s]+)|^\[([^[\]]*)\]|^\(([^()]*)\)/;

interface RenderedTarget {
  readonly text: string;
  /** 至少发生了一次中文替换（别名 / 语言层槽位）——决定要不要补 `赋值` 动词 */
  readonly translated: boolean;
}

function renderTarget(raw: string, lookup: NativeDisplayLookup | undefined): RenderedTarget | null {
  const t = raw.trim();
  const m = TARGET_RE.exec(t);
  if (!m) return null;
  const family = m[1]!;
  const upper = family.toUpperCase();
  const suffixText = m[2] ?? '';

  if (upper === 'ARG' || upper === 'ARGS') {
    // 与 argTokenCnLabel 同口径：k=0 归一为裸形，k>=1 → 视图:(k+1)（表层索引是 1 基）
    const view = upper === 'ARG' ? VARIADIC_ARG_NUMERIC : VARIADIC_ARG_STRING;
    const idx = /^:(\d+)$/.exec(suffixText);
    if (idx) {
      const k = Number(idx[1]!);
      return { text: k === 0 ? view : `${view}:${k + 1}`, translated: true };
    }
    return { text: `${view}${suffixText}`, translated: true };
  }

  const lang = LANG_SLOTS[upper];
  if (lang !== undefined) return { text: `${lang}${suffixText}`, translated: true };

  const alias = lookup?.familyAlias(upper);
  if (alias === undefined) return { text: t, translated: false };

  let text = `${alias}${suffixText}`;
  const fm = FIRST_SUFFIX_RE.exec(suffixText);
  const indexName = fm?.[1] ?? fm?.[2] ?? fm?.[3];
  if (indexName !== undefined) {
    const cn = lookup?.slotCn(upper, indexName);
    if (cn !== undefined) text = `${text}（${cn}）`;
  }
  return { text, translated: true };
}

/* ==================== 赋值 ==================== */

/** `目标[, 目标…] <op> <值>`；op ∈ `= += -= *= /=`（`==`/`<=` 这类比较不进这里） */
const ASSIGN_RE = /^([^;=<>!]+?)\s*(\+=|-=|\*=|\/=|=)(.*)$/;

function renderAssignment(code: string, lookup: NativeDisplayLookup | undefined, depth: number): string | null {
  if (depth > 3) return null;
  const m = ASSIGN_RE.exec(code);
  if (!m) return null;
  const lhsRaw = m[1]!.trim();
  const op = m[2]!;
  const rhs = m[3]!.trimStart();
  if (rhs.length === 0 || rhs.startsWith('=') || rhs.startsWith('==')) return null;

  const rendered: string[] = [];
  let translated = false;
  for (const part of splitTopLevel(lhsRaw, ',')) {
    const t = renderTarget(part, lookup);
    if (t === null) return null; // 左里有读不懂的目标 ⇒ 整行不认领（宁缺勿猜）
    rendered.push(t.text);
    translated ||= t.translated;
  }

  let rhsOut = rhs;
  if (ASSIGN_RE.test(rhs)) {
    const inner = renderAssignment(rhs, lookup, depth + 1);
    if (inner !== null) rhsOut = inner; // 链式 `A = B = 0`；翻不动就原样（行内英文允许）
  }

  if (translated) return `${rendered.join('，')} ${op} ${rhsOut}`;
  return `赋值 ${lhsRaw} ${op} ${rhsOut}`; // 查不到别名也必须给中文形
}

/* ==================== 调用 ==================== */

const CALL_RE = /^(?:([A-Z][A-Z0-9_]*)[ \t]+(\S[\s\S]*)|([A-Z][A-Z0-9_]*))$/;
/**
 * 语句动词表（**显示词形住本表、档位名单住 `sugar-ident`**，两件事别混）。
 *
 * TRY 五枚全走本表：`TRYCALL` / `TRYCALLFORM` / `TRYJUMP` 一直在；`TRYGOTO` / `TRYGOTOFORM`
 * 是 goto 家族的单行变体（引擎 funcMatch 的"其余 TRY*"档），此前表里没有 ⇒ 落 `未识别语句 ·`
 * 兜底。词形上 `跳到` 与 ZH-C 的 `GOTO` 显示形同字（标签目标），`…形` 与 `调用形` 同构
 * （FORM 变体）⇒ 读者一眼看出"跳到族 + 试探"，而不是第四种叫法。
 *
 * 载荷**逐字带走**（`*标签` / `$标签` / 实参串都不剥前缀）——本层所有调用形同一条口径，
 * 前缀剥离是 ZH-C 的 `GOTO` 才有的装置（它那里目标是纯标签名）。
 */
const CALL_VERBS: Readonly<Record<string, { readonly verb: string; readonly tail: string }>> = {
  CALL: { verb: '调用', tail: '' },
  CALLL: { verb: '调用', tail: ' 续' },
  CALLFORM: { verb: '调用形', tail: '' },
  TRYCALL: { verb: '尝试调用', tail: '' },
  TRYCALLFORM: { verb: '尝试调用形', tail: '' },
  TRYJUMP: { verb: '尝试跳转', tail: '' },
  TRYGOTO: { verb: '尝试跳到', tail: '' },
  TRYGOTOFORM: { verb: '尝试跳到形', tail: '' },
};

/**
 * 本层认领的 TRY 记号 = 语句动词表 ∩ 识别核的单行档（**派生，不是第二份名单**）。
 *
 * 为什么要导出：装配顺序（control 先、statement 后）本身就是一条判据，而"两档互斥、
 * 单行档全被认领"这两件事只有在测试里能对着名单核——`STATEMENT_TRY_WORDS` 与
 * `TRY_SINGLE_LINE` 一旦漂移（加了一枚没给动词、或把开块词抄进动词表），
 * `tests/native-display-statement.test.ts` 立刻红。
 */
export const STATEMENT_TRY_WORDS: readonly string[] = Object.keys(CALL_VERBS)
  .filter((k) => TRY_SINGLE_LINE.has(k))
  .sort();

function renderCall(code: string): string | null {
  const m = CALL_RE.exec(code);
  if (!m) return null;
  const kw = (m[1] ?? m[3] ?? '').toUpperCase();
  const shape = CALL_VERBS[kw];
  if (shape === undefined) return null;
  const target = m[2];
  if (target === undefined) return null; // 裸 `CALL` 无目标 = 畸形行
  return `${shape.verb} ${target}${shape.tail}`;
}

/* ==================== 位原语 ==================== */

const BIT_RE = /^(SETBIT|CLEARBIT|INVERTBIT)[ \t]+(\S[\s\S]*)$/;
const BIT_VERBS: Readonly<Record<string, string>> = { SETBIT: '置位', CLEARBIT: '清位', INVERTBIT: '翻位' };

function renderBitOp(code: string, lookup: NativeDisplayLookup | undefined): string | null {
  const m = BIT_RE.exec(code);
  if (!m) return null;
  const parts = splitTopLevel(m[2]!, ',').map((x) => x.trim());
  const targetRaw = parts[0];
  const bits = parts.slice(1);
  if (targetRaw === undefined || bits.length === 0) return null; // 缺位号 = 畸形行
  const target = renderTarget(targetRaw, lookup);
  const targetText = target === null ? targetRaw : target.text;
  return `${BIT_VERBS[m[1]!.toUpperCase()]!} ${targetText} 第${bits.join('，')}位`;
}

/* ==================== 输出族 ==================== */

const PRINT_RE = /^(PRINT[A-Z]*)(?:[ \t]+(\S[\s\S]*))?$/;

interface PrintShape {
  readonly verb: string;
  /** 行尾节奏记号：` 续` / ` 等待`（沿用投影既有口径） */
  readonly tail?: string;
  /** 块开词：渲染成 `数据打印（逐行）：` 一类的块头，`''` = 无括注 */
  readonly data?: string;
}

/**
 * 只登记**投影表外**的变体（`PRINT_VARIANTS` 已认领的台词形不重复接管）；
 * 表外的 `PRINTKONST` / `PRINTLC` 等一律 `null`——没把握的记号不配拥有中文名。
 */
const PRINT_SHAPES: Readonly<Record<string, PrintShape>> = {
  PRINT: { verb: '片段打印' },
  PRINTL: { verb: '打印', tail: ' 续' },
  PRINTW: { verb: '打印', tail: ' 等待' },
  PRINTV: { verb: '数值打印' },
  PRINTVL: { verb: '数值打印', tail: ' 续' },
  PRINTVW: { verb: '数值打印', tail: ' 等待' },
  PRINTFORMV: { verb: '格式数值打印' },
  PRINTFORMVL: { verb: '格式数值打印', tail: ' 续' },
  PRINTSINGLE: { verb: '单项打印' },
  PRINTSINGLEL: { verb: '单项打印', tail: ' 续' },
  PRINTSINGLEW: { verb: '单项打印', tail: ' 等待' },
  PRINTSINGLEV: { verb: '单项数值打印' },
  PRINTSINGLEVL: { verb: '单项数值打印', tail: ' 续' },
  PRINTSINGLEVW: { verb: '单项数值打印', tail: ' 等待' },
  PRINTDATA: { verb: '数据打印', data: '' },
  PRINTDATAL: { verb: '数据打印', data: '逐行' },
  PRINTDATAW: { verb: '数据打印', data: '等待' },
  PRINTDATAS: { verb: '数据打印', data: '并排' },
};

function renderPrint(code: string): string | null {
  const m = PRINT_RE.exec(code);
  if (!m) return null;
  const shape = PRINT_SHAPES[m[1]!.toUpperCase()];
  if (shape === undefined) return null;
  const body = m[2];
  if (shape.data !== undefined) {
    const head = shape.data.length > 0 ? `${shape.verb}（${shape.data}）：` : `${shape.verb}：`;
    return body === undefined ? head : `${head} ${body}`;
  }
  if (body === undefined) {
    if (shape.tail === ' 等待') return '空行 等待';
    if (shape.tail === ' 续') return '空行';
    return shape.verb;
  }
  return `${shape.verb} ${body}${shape.tail ?? ''}`;
}

/* ==================== 按钮 / 输入 ==================== */

const BUTTON_RE = /^(PRINTBUTTON|PRINTBUTTONC)[ \t]+(\S[\s\S]*)$/;

function renderButton(code: string): string | null {
  const m = BUTTON_RE.exec(code);
  if (!m) return null;
  const verb = m[1] === 'PRINTBUTTON' ? '按钮' : '按钮C';
  const parts = splitTopLevel(m[2]!, ',').map((x) => x.trim());
  const label = parts[0];
  if (label === undefined || label.length === 0) return null;
  const rest = parts.slice(1);
  return rest.length > 0 ? `${verb} ${label} → ${rest.join('，')}` : `${verb} ${label}`;
}

/* ==================== 排版 / 等待（单词指令表） ==================== */

const LINE_WORD_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:[ \t]+(\S[\s\S]*))?$/;

interface LayoutShape {
  readonly verb?: string;
  /** `none` = 不许带参数；`keep` = 参数原样照抄（必需）；`optional` = 参数原样（可缺）；`onoff` = `0/1 → 关/开` 其余照抄 */
  readonly arg?: 'none' | 'keep' | 'optional' | 'onoff';
  readonly tail?: string;
  /** 整行固定形（`INPUT` 这类"输出槽位是语言层约定"的行） */
  readonly fixed?: string;
}

const LAYOUT_SHAPES: Readonly<Record<string, LayoutShape>> = {
  SETCOLOR: { verb: '着色', arg: 'keep' },
  RESETCOLOR: { verb: '复原颜色', arg: 'none' },
  FONTBOLD: { verb: '粗体', arg: 'onoff' },
  FONTITALIC: { verb: '斜体', arg: 'onoff' },
  FONTSIZE: { verb: '字号', arg: 'optional' },
  CLEARLINE: { verb: '清空本行', arg: 'none' },
  FORCEWAIT: { verb: '强制等待', arg: 'none' },
  WAIT: { verb: '等待', arg: 'none' },
  DRAWLINE: { verb: '分隔线', arg: 'optional' },
  BAR: { verb: '进度条', arg: 'keep' },
  BARL: { verb: '进度条', arg: 'keep', tail: ' 续' },
  REDRAW: { verb: '重绘', arg: 'optional' },
  RETURN: { verb: '返回', arg: 'optional' },
  INPUT: { fixed: '输入 → 结果' },
  INPUTS: { fixed: '输入 → 结果$' },
};

function renderLayout(code: string): string | null {
  const m = LINE_WORD_RE.exec(code);
  if (!m) return null;
  const shape = LAYOUT_SHAPES[m[1]!.toUpperCase()];
  if (shape === undefined) return null;
  const body = m[2];
  if (shape.fixed !== undefined) return body === undefined ? shape.fixed : null; // 固定形不许挂参数
  if (shape.arg === 'none' && body !== undefined) return null; // 带参的"裸指令"不是我认的那条指令
  if (shape.arg === 'keep' && body === undefined) return null;
  let argOut = body;
  if (shape.arg === 'onoff' && body !== undefined) {
    argOut = body === '1' ? '开' : body === '0' ? '关' : body;
  }
  const head = argOut === undefined ? shape.verb! : `${shape.verb!} ${argOut}`;
  return `${head}${shape.tail ?? ''}`;
}

/* ==================== 入口 ==================== */

/** 前缀即"不归本层"的整行形态：`;` 注释、`#` 预处理、`$` 标签、`[` 停用区、`@` 函数头（全在 ZH-C / 结构层） */
const NOT_MY_LINE_RE = /^[;#$[@]/;

/** ZH-S 的入口（签名由 lead 钉死，禁止改名或加参） */
export const renderStatementLine: NativeDisplayPass = (input: NativeDisplayInput): string | null => {
  const trimmed = input.content.trim();
  if (trimmed.length === 0 || NOT_MY_LINE_RE.test(trimmed)) return null;
  const { code, comment } = splitTrailingComment(trimmed);
  if (code.length === 0) return null;
  const rendered =
    renderCall(code) ??
    renderBitOp(code, input.lookup) ??
    renderPrint(code) ??
    renderButton(code) ??
    renderLayout(code) ??
    renderAssignment(code, input.lookup, 0);
  if (rendered === null) return null;
  const line = comment.length > 0 ? `${rendered} ${comment}` : rendered;
  return line === input.content ? null : line; // 红线自证：原样返回一律视为失败
};
