/**
 * ERB 补全的**语言判据**（LAU-4 补全腿第二批）：位置门 v2、名字槽 / 标签位 / 变量段 /
 * 位坑 / 成员位，以及经 `ui.editor.languageService` 的 `completion` 成员应答的候选装配。
 *
 * ## 为什么住在解析器插件（而不是 `@kojo/erb-lang`）
 *
 * 判据要由**槽的供方**回答，而供方是常驻插件 `@kojo/plugin-erb-parser`；插件读不到宿主
 * `packages/app/src/**`，也**不许静态引 `@kojo/erb-lang` 的补全叶子**——那会把 2.0 补全
 * 词表链（`kojo-lang/completion` + `kojo-vocab/{engine,keywords}` 等 9 枚）拽上开机图，
 * 直接撞碎 ps10 的 199 文件闸（实测 199 ⇒ 208）。故判据折进本包，宿主那六个
 * `monaco/erb-completion-*` 文件只剩 re-export 与「契约 → Monaco 形状」翻译。
 *
 * 本文件此前散在三处（`erb-lang/src/completion-{context,bits,variables}.ts` 的判据 +
 * 宿主 `monaco/erb-completion*.ts` 的候选装配），逐条**原样搬入**，唯一改动是地基：
 *
 * - 空白类改引契约层 `ERB_BLANK_CLASS_STR` / `isErbBlank` / `isAllErbBlank`
 *   （`@kojo/plugin-api`）——与 `.kojo` 侧 `BLANK_CLASS_STR` 同一字符集，由
 *   `tests/completion-lexical.test.ts` 逐字符钉相等；
 * - 名字字符集改引契约层 `MODEL_TOKEN_CLASS`（`[\p{L}\p{N}_]`）——它本来就是"什么字符算一个
 *   记号"的单一真源（`erb-parser/references.ts` 的反向索引记号集也由它组装），ERB 名字集
 *   是它的同一张表去掉 `$`（`$` 是标签记号）；
 * - 引擎族表 `ENGINE_VARIABLE_FAMILIES` 引 `@kojo/kojo-vocab/engine`（纯数据叶子，零运行时
 *   import）——族头位与成员位都要它，抄一份就是第二判据。
 *
 * ## 这一批走槽的 facet
 *
 * `erb-snippet` / `erb-labels` / `erb-families` / `erb-declared`（相对次序与宿主源表一致：
 * 先注册者胜的去重语义原样保留）。**仍未搬**的 facet 与理由见交付回执：变量名 / 位号
 * （要 adapter 变量表）、项目函数与系统函数（详情回表是两段式 `resolveCompletionItem`，
 * 契约还没有 resolve 成员）、指令词表（宿主 Monarch 与本文件共用的大表未上提）、
 * 文档词（编辑器通用能力，与 `.kojo` 共用一份）。
 */
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorLanguageRange,
  ErbFile,
  ErbIndex,
} from '@kojo/plugin-api';
import {
  ERB_BLANK_CLASS_STR,
  ERB_BLANK_RE,
  ERB_PREPROC_CANDIDATES,
  ERB_SKIP_MARKERS,
  MODEL_TOKEN_CLASS,
  isAllErbBlank,
  isErbBlank,
} from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { dimDeclarationOf, normalizePathKey } from './symbols';

/* ============================== 词法地基 ============================== */

/**
 * 名字字符集（**ERB 侧唯一一份**）：契约层 `MODEL_TOKEN_CLASS` 就是 `[\p{L}\p{N}_]`。
 * `$` **不在**集内（`$标签` 的 `$` 由 {@link ERB_SIGIL_BEFORE} 排除兜住，否则 `CALL $FOO`
 * 会把 `$` 拼进函数名）；kojo 侧那份含 `$`（糖的 `实参$` 后缀）。
 */
export const NAME_CHAR_RE = new RegExp(MODEL_TOKEN_CLASS, 'u');

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_CHAR_RE.test(ch);
}

/* ============================== 调用语句表（门与候选源共用） ============================== */

/** 语句关键字之后那一位的**槽种类** */
export type ErbCallSlotKind = 'func' | 'form' | 'label';

/** 一条「语句关键字 + 其后那一位的种类」 */
export interface ErbCallStatement {
  readonly kw: string;
  readonly slot: ErbCallSlotKind;
}

/**
 * ERB「语句之后跟着一个名字位」的**单一真源**清单（门与函数名候选源共用，不得再留第二份）。
 *
 * - `'func'`：**直系调用**，名字位就是函数名 ⇒ 门 `'call-target'`；
 * - `'form'`：`*FORM*` 全族，名字位是**表达式**（FORM 串，可含 `%…%` / `{…}` 插值）⇒ 不设门；
 * - `'label'`：跳转家族（见 {@link ERB_JUMP_KEYWORDS}），目标是行号 / `$标签` ⇒ 门 `'label-target'`。
 */
export const ERB_CALL_STATEMENTS: readonly ErbCallStatement[] = [
  { kw: 'CALL', slot: 'func' },
  { kw: 'CALLL', slot: 'func' },
  { kw: 'CALLF', slot: 'func' },
  { kw: 'TRYCALL', slot: 'func' },
  { kw: 'CALLFORM', slot: 'form' },
  { kw: 'CALLFORML', slot: 'form' },
  { kw: 'CALLFORMF', slot: 'form' },
  { kw: 'TRYCALLFORM', slot: 'form' },
  { kw: 'TRYCALLFORMF', slot: 'form' },
  { kw: 'TRYCCALLFORM', slot: 'form' },
  { kw: 'JUMP', slot: 'label' },
  { kw: 'TRYJUMP', slot: 'label' },
  { kw: 'GOTO', slot: 'label' },
  { kw: 'TRYGOTO', slot: 'label' },
];

/** 跳转家族关键字（标签目标位；与解析器实名对齐——`symbols.ts` 的 `JUMP_FAMILY`） */
export const ERB_JUMP_KEYWORDS: readonly string[] = ['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO'];

/** 关键字（大写）→ 槽种类 */
export const ERB_CALL_SLOT_BY_KEYWORD: ReadonlyMap<string, ErbCallSlotKind> = new Map(
  ERB_CALL_STATEMENTS.map((s) => [s.kw.toUpperCase(), s.slot]),
);

/**
 * 按槽种类挑出关键字，**长词在前**（正则交替若短词在前会被前缀遮蔽：`CALL` 吃掉 `CALLFORM` 那一位）。
 */
export function erbCallKeywords(slots: readonly ErbCallSlotKind[]): string[] {
  return ERB_CALL_STATEMENTS.filter((s) => slots.includes(s.slot))
    .map((s) => s.kw)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 拼「行首空白 + 语句关键字」的**锚定**正则（空白类走 `ERB_BLANK_CLASS_STR` 单源；`i` = 大小写不敏感）。
 * 捕获组 1 = 命中的关键字。`requireBlank`：`true` ⇒ 关键字后必须有空白（候选源侧）；
 * `false` ⇒ 只要求词边界（门侧：光标可紧贴关键字尾 `CALL|`，同时仍挡住 `CALLFOO` 这类长词）。
 */
export function erbCallStatementRe(slots: readonly ErbCallSlotKind[], requireBlank: boolean): RegExp {
  const alt = erbCallKeywords(slots).join('|');
  const tail = requireBlank ? `[${ERB_BLANK_CLASS_STR}]+` : `\\b[${ERB_BLANK_CLASS_STR}]*`;
  return new RegExp(`^[${ERB_BLANK_CLASS_STR}]*(${alt})${tail}`, 'i');
}

/** 直系调用语句（门的判据；只吃 `'func'` 槽） */
const CALL_STMT_RE = erbCallStatementRe(['func'], false);

/* ============================== 名字槽 ============================== */

/** 定义位：行首可选空白 + `@` */
export const DEF_RE = new RegExp(`^[${ERB_BLANK_CLASS_STR}]*@`);

/** 名字槽（0 基区间 + 光标前已输入前缀） */
export interface ErbNameSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

/** 名字槽是否**停在**未闭合的 `%…%` / `{…}` 内（严格在插值里 ⇒ 不猜） */
function insideInterp(section: string): boolean {
  let pct = 0;
  let brace = 0;
  for (const ch of section) {
    if (ch === '%') pct++;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
  }
  return pct % 2 === 1 || brace !== 0;
}

/**
 * 解析「名字槽」里的补全位置（纯函数；`col0` = 0 基列）。定义位（`@`）与调用位判据的**单源**。
 *
 * `boundStart` = 名字槽左界；右界 = 该界之后第一个 `(` / `;` / 空白。返回 `null` = 该处不是
 * 可补全的名字位置（越过右界 / 非 `allowInterp` 槽里混入非名字字符 / 严格停在未闭合插值内）。
 */
export function parseErbNameSlot(
  lineText: string,
  col0: number,
  boundStart: number,
  allowInterp: boolean,
): ErbNameSlot | null {
  if (col0 < boundStart) return null;

  let slotEnd = boundStart;
  while (slotEnd < lineText.length) {
    const ch = lineText[slotEnd]!;
    if (ch === '(' || ch === ';' || isErbBlank(ch)) break;
    slotEnd++;
  }
  if (col0 > slotEnd) return null;

  const section = lineText.slice(boundStart, col0);
  if (allowInterp) {
    if (insideInterp(section)) return null;
  } else if (![...section].every(isNameChar)) {
    return null;
  }

  let start = col0;
  while (start > boundStart && isNameChar(lineText[start - 1])) start--;
  let end = col0;
  while (end < lineText.length && isNameChar(lineText[end])) end++;

  return { start, end, prefix: lineText.slice(start, col0) };
}

/* ============================== 标签目标位 ============================== */

/** 标签槽（0 基区间 + 光标前已输入的残片；可选 `$` 留在区间外） */
export interface ErbLabelSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

/** 标签名字符：非空白、非 `;`（与定义扫描 `^\s*\$名字` 的正向口径对齐） */
const isLabelChar = (ch: string): boolean => !/[\s;]/.test(ch);

/**
 * 跳转上下文：光标**前文**以 `<分隔>(跳转关键字)` + 空白 + 可选 `$` + 名字残片 收尾。
 * 分隔含行首 / 空白 / `;` / 半角 `:` / 全角 `：`；前缀字符非分隔 ⇒ `TRYCGOTO` 之类不误触。
 */
const LABEL_CONTEXT_RE = new RegExp(
  `(?:^|[${ERB_BLANK_CLASS_STR};:：])(${[...ERB_JUMP_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .join('|')})[${ERB_BLANK_CLASS_STR}]+(\\$?)([^\\s;]*)$`,
  'i',
);

/** 光标处的**标签目标位**（`column` = 1 基列）；`start` 已跳过可选 `$` */
export function erbLabelSlot(line: string, column: number): ErbLabelSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, line.length);
  const ctx = LABEL_CONTEXT_RE.exec(line.slice(0, col0));
  if (ctx === null) return null;
  const prefix = ctx[3] ?? '';
  const start = col0 - prefix.length;
  let end = col0;
  while (end < line.length && isLabelChar(line[end]!)) end++;
  return { start, end, prefix };
}

/* ============================== 代码视野 / 插值区 ============================== */

/** 代码视野三态：普通代码 / 串内 / `;` 注释内 */
export type ErbCodeView = 'code' | 'string' | 'comment';

/**
 * 光标之前（`[0, col0)`）处于哪种**代码视野**。一次线性扫描、按状态推进（普通 → 串内 → 注释）：
 * - 普通态：`"` ⇒ 进串；`;` ⇒ 进注释（此点之后一律不是代码）；
 * - 串内态：`""` 是引擎的字面引号转义（消费两个字符、状态不变）；单个 `"` ⇒ 出串；
 * - 引号未闭合 ⇒ 「到行尾都是串」（与 `erb-parser` 的 `codeViewOf` 同方向的保守选择）。
 */
export function erbCodeViewOf(lineText: string, col0: number): ErbCodeView {
  let inString = false;
  let i = 0;
  while (i < col0) {
    const ch = lineText[i]!;
    if (inString) {
      if (ch === '"') {
        if (lineText[i + 1] === '"') {
          i += 2;
          continue;
        }
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ';') {
      return 'comment';
    }
    i++;
  }
  return inString ? 'string' : 'code';
}

/**
 * 光标是否落在 FORM 串内一个**闭合插值区**（`%…%` / `{…}` / `\@…\@`；`column` = 1 基列）。
 * 口径见原 `@kojo/erb-lang/completion-context` 头注（字形集与 `condition-extractor/inline.ts`
 * 一致，深度口径有意分歧；光标可停区间 = [开记号之后一列, 闭记号尾之后一列]，含两端）。
 */
export function erbInterpRegionAt(lineText: string, column: number): boolean {
  if (!Number.isFinite(column) || column < 1) return false;
  const col0 = Math.min(column - 1, lineText.length);
  const regions: { lo: number; hi: number }[] = [];
  let inString = false;
  let braceDepth = 0;
  let topBraceOpen = -1;
  let pctOpen = -1;
  let atOpen = -1;
  let i = 0;
  while (i < lineText.length) {
    const ch = lineText[i]!;
    if (inString) {
      if (ch === '"') {
        if (lineText[i + 1] === '"') {
          i += 2;
          continue;
        }
        inString = false;
        pctOpen = -1;
        atOpen = -1;
        i += 1;
        continue;
      }
      if (ch === '\\' && lineText[i + 1] === '@') {
        if (braceDepth === 0 && pctOpen < 0) {
          if (atOpen < 0) atOpen = i;
          else {
            regions.push({ lo: atOpen + 2, hi: i + 2 });
            atOpen = -1;
          }
        }
        i += 2;
        continue;
      }
      if (ch === '%' && braceDepth === 0 && atOpen < 0) {
        if (pctOpen < 0) pctOpen = i;
        else {
          regions.push({ lo: pctOpen + 1, hi: i + 1 });
          pctOpen = -1;
        }
        i += 1;
        continue;
      }
    } else if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    } else if (ch === ';') {
      break;
    }
    if (ch === '{') {
      if (braceDepth === 0) topBraceOpen = i;
      braceDepth += 1;
    } else if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        if (braceDepth === 0 && topBraceOpen >= 0) {
          regions.push({ lo: topBraceOpen + 1, hi: i + 1 });
          topBraceOpen = -1;
        }
      }
    }
    i += 1;
  }
  return regions.some((r) => col0 >= r.lo && col0 <= r.hi);
}

/* ============================== 位坑扫描件 ============================== */

/** 位原语单字 → 语句形（无括号）还是表达式形（带括号） */
const BIT_PRIMITIVES = /\b(GETBIT|SETBIT|CLEARBIT|INVERTBIT)\b/gi;

/** 位槽（第二实参坑）的位置描述（0 基列区间，`slice` 起止） */
export interface ErbBitSlot {
  readonly variableRef: string;
  readonly regionStart: number;
  readonly regionEnd: number;
}

/** `text[open]` 是 `(`，返回与之配对的 `)` 下标；不配平 ⇒ `-1`（引号内的括号不计数） */
export function matchingParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i++;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** `[from, to)` 内**顶层**（括号 / 方括号深度 0）的第一个逗号；无 → -1 */
export function topLevelComma(text: string, from: number, to: number): number {
  let depth = 0;
  let i = from;
  while (i < to) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      while (i < to && text[i] !== '"') i++;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === ',' && depth === 0) return i;
    i++;
  }
  return -1;
}

/**
 * 解析光标所在的**位槽**（纯函数；`column` = 1 基列）。返回 `null` = 不是任何位原语的第二实参坑
 * （注释行 / 字符串内 / 无逗号 / 括号未闭合 / 光标不在第二实参区间内，一律不认）。
 */
export function findBitSlot(lineText: string, column: number): ErbBitSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, lineText.length);

  if (/^\s*;/.test(lineText)) return null;
  let quotes = 0;
  for (let i = 0; i < col0; i++) {
    if (lineText[i] === '"') quotes++;
  }
  if (quotes % 2 === 1) return null;

  const re = new RegExp(BIT_PRIMITIVES.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const kw = m[1]!.toUpperCase();
    let p = m.index + m[0].length;
    while (p < lineText.length && (lineText[p] === ' ' || lineText[p] === '\t')) p++;
    let regionStart: number;
    let regionEnd: number;
    let refStart: number;
    let refEnd: number;
    if (lineText[p] === '(') {
      const close = matchingParen(lineText, p);
      if (close < 0) continue;
      const comma = topLevelComma(lineText, p + 1, close);
      if (comma < 0) continue;
      regionStart = comma + 1;
      regionEnd = close;
      refStart = p + 1;
      refEnd = comma;
    } else if (kw !== 'GETBIT') {
      const comma = topLevelComma(lineText, p, lineText.length);
      if (comma < 0) continue;
      regionStart = comma + 1;
      regionEnd = lineText.length;
      refStart = p;
      refEnd = comma;
    } else {
      continue;
    }
    if (col0 < regionStart || col0 > regionEnd) continue;
    return { variableRef: lineText.slice(refStart, refEnd).trim(), regionStart, regionEnd };
  }
  return null;
}

/** 位槽第二实参区间是否**为空**（纯空白）——位置门与候选门共用的**唯一**判据真源 */
export function erbBitSlotRegionBlank(lineText: string, slot: ErbBitSlot): boolean {
  return lineText.slice(slot.regionStart, slot.regionEnd).trim().length === 0;
}

/** `column` 处是否是一个**待命中的位槽**（第二实参坑内且此刻为空） */
export function erbBitSlotOpen(lineText: string, column: number): boolean {
  const slot = findBitSlot(lineText, column);
  return slot !== null && erbBitSlotRegionBlank(lineText, slot);
}

/* ============================== 变量引用的名字位 ============================== */

/**
 * 引用片段字符（负向口径，与宿主 Monarch 的变量引用词法同集：排除空白、逗号、括号、
 * 引号与运算符）。另排除 `:`（段分隔符，单独处理）与 `;`（行首注释起头）。
 */
const SEGMENT_CHAR_RE = /[^\s,()[\]{}'"+\-*/%<>=!&|^~?:;]/;

/** 一次补全的"名字段"位置（0 基区间 + 光标前已输入前缀 + 族头 + 段式） */
export interface ErbVariableSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly family: string;
  readonly scoped: boolean;
}

/** 解析光标处的"名字补全位置"（纯函数）；返回 `null` = 不是可补全的名字位置（不猜） */
export function erbVariableContextAt(lineText: string, column: number): ErbVariableSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, lineText.length);

  let tokStart = col0;
  while (tokStart > 0) {
    const ch = lineText[tokStart - 1]!;
    if (ch === ':' || SEGMENT_CHAR_RE.test(ch)) tokStart--;
    else break;
  }
  let end = col0;
  while (end < lineText.length && SEGMENT_CHAR_RE.test(lineText[end]!)) end++;

  const before = lineText.slice(tokStart, col0);
  const lastColon = before.lastIndexOf(':');
  if (lastColon < 0) return null;
  const parts = before.split(':');
  const family = parts[0]!;
  if (family.length === 0) return null;
  if (parts.length > 3 || parts.length < 2) return null;
  if (parts.length === 3 && parts[1]!.length === 0) return null;
  const prefix = parts[parts.length - 1]!;
  if (/^[0-9]/.test(prefix)) return null;

  return { start: tokStart + lastColon + 1, end, prefix, family, scoped: parts.length === 3 };
}

/** 光标处的**变量引用末段**（候选侧的面：族头还须 ∈ `ENGINE_VARIABLE_FAMILIES`） */
export function erbVariableSlotAt(lineText: string, column: number): ErbVariableSlot | null {
  const context = erbVariableContextAt(lineText, column);
  if (context === null) return null;
  return ENGINE_VARIABLE_FAMILIES.includes(context.family) ? context : null;
}

/** 结构层的**变量引用末段**（不核族头白名单） */
export function erbVariableReferenceSlotAt(lineText: string, column: number): ErbVariableSlot | null {
  return erbVariableContextAt(lineText, column);
}

/* ============================== 裸标识符名位 / 族头 ============================== */

/**
 * token 起点前一枚字符的**排除集**（防守；这些位置的归属主收口在装配层白名单）：
 * `#` / `[` = 预处理 / 区间标记记号，`@` = 函数定义位，`$` = 标签，`%` = 表单串，
 * 引号 = 字符串字面量，`:` / `：` = `族:名` 段分隔。
 */
export const ERB_SIGIL_BEFORE: ReadonlySet<string> = new Set(['#', '[', '@', '$', '%', '"', "'", '：', ':']);

/** 1 基列 → 0 基列（越界夹进线内；非法列 ⇒ `null`） */
function col0Of(line: string, column: number): number | null {
  if (!Number.isFinite(column) || column < 1) return null;
  return Math.min(column - 1, line.length);
}

/**
 * 光标处的**裸标识符名位**（纯函数；`column` = 1 基列）。
 * 口径：左右至少一侧是名字字符才算（行尾 / 空白空插入点 ⇒ `null`）；
 * token 起点前一枚字符 ∈ {@link ERB_SIGIL_BEFORE} ⇒ `null`。
 */
export function erbDeclaredNameSlot(line: string, column: number): ErbNameSlot | null {
  const col0 = col0Of(line, column);
  if (col0 === null) return null;
  const left = col0 > 0 ? line[col0 - 1]! : undefined;
  const right = col0 < line.length ? line[col0]! : undefined;
  const onLeft = left !== undefined && NAME_CHAR_RE.test(left);
  const onRight = right !== undefined && NAME_CHAR_RE.test(right);
  if (!onLeft && !onRight) return null;
  let start = col0;
  let end = col0;
  while (start > 0 && NAME_CHAR_RE.test(line[start - 1]!)) start--;
  while (end < line.length && NAME_CHAR_RE.test(line[end]!)) end++;
  if (start > 0 && ERB_SIGIL_BEFORE.has(line[start - 1]!)) return null;
  return { start, end, prefix: line.slice(start, col0) };
}

/**
 * 产出族头候选（纯函数）。位置不符 / 前缀无任何族命中 ⇒ `[]`（不猜、不抛）。
 * `lineNumber` 只用于把 0 基名字段换算成 1 基替换区间。
 */
export function erbFamilyCandidates(line: string, column: number, lineNumber = 1): EditorCompletionItem[] {
  const slot = erbDeclaredNameSlot(line, column);
  if (slot === null) return [];
  const needle = slot.prefix.toUpperCase();
  const range = { line: lineNumber, startColumn: slot.start + 1, endColumn: slot.end + 1 };
  const items: EditorCompletionItem[] = [];
  for (const family of ENGINE_VARIABLE_FAMILIES) {
    const upper = family.toUpperCase();
    if (needle.length > 0 && !upper.startsWith(needle)) continue;
    const exact = needle.length > 0 && upper === needle;
    items.push({
      label: family,
      kind: 'variable',
      insertText: family,
      filterText: family,
      detail: '引擎族头',
      range,
      sortText: `${exact ? '0' : '1'}_${family}`,
    });
  }
  return items;
}

/* ============================== 成员位 ============================== */

/** 成员位种类：点号成员 / 变量族头 / `族:` 名字段 */
export type ErbMemberSlotKind = 'member' | 'variable-family' | 'field';

/** 一处成员位（0 基、左含右不含的名字段区间） */
export interface ErbMemberSlot {
  readonly kind: ErbMemberSlotKind;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly receiver?: string;
  readonly receiverStart?: number;
  readonly family?: string;
}

/** 接收者是否"说不出是哪个族"：空 / 数值字面量开头（`1.5` 的小数点）/ 全数字 */
function usableReceiver(receiver: string): boolean {
  return receiver.length > 0 && !/^[0-9]/.test(receiver);
}

/** `族:` 引用的**族头形**：ASCII 标识符起头（引擎族全是 ASCII；`1:` 这类编号不是族引用） */
const FAMILY_HEAD_RE = /^[A-Za-z_]/;

/** 点号成员位：`receiver.|` / `receiver.前缀|`（光标在点号后或成员段内） */
function memberSlotWithin(lineText: string, col0: number): ErbMemberSlot | null {
  let segStart = col0;
  while (segStart > 0 && NAME_CHAR_RE.test(lineText[segStart - 1]!)) segStart--;
  if (segStart === 0 || lineText[segStart - 1] !== '.') return null;
  const dot = segStart - 1;
  if (dot > 0 && lineText[dot - 1] === '.') return null;
  let receiverStart = dot;
  while (receiverStart > 0 && NAME_CHAR_RE.test(lineText[receiverStart - 1]!)) receiverStart--;
  const receiver = lineText.slice(receiverStart, dot);
  if (!usableReceiver(receiver)) return null;
  if (receiverStart > 0 && ERB_SIGIL_BEFORE.has(lineText[receiverStart - 1]!)) return null;
  let end = col0;
  while (end < lineText.length && NAME_CHAR_RE.test(lineText[end]!)) end++;
  return {
    kind: 'member',
    start: segStart,
    end,
    prefix: lineText.slice(segStart, col0),
    receiver,
    receiverStart,
  };
}

/**
 * 光标处的**成员位**（纯函数；`column` = 1 基列）。返回 `null` = 这里不是成员位（不猜）。
 * 判定顺序：代码视野 → 点号成员 → `族:` 名字段 → 裸族头。
 */
export function erbMemberSlotAt(lineText: string, column: number): ErbMemberSlot | null {
  const col0 = col0Of(lineText, column);
  if (col0 === null) return null;
  if (erbCompletionGate(lineText, column) === 'in-string') return null;

  const member = memberSlotWithin(lineText, col0);
  if (member !== null) return member;

  const reference = erbVariableReferenceSlotAt(lineText, column);
  if (reference !== null && FAMILY_HEAD_RE.test(reference.family)) {
    return {
      kind: 'field',
      start: reference.start,
      end: reference.end,
      prefix: reference.prefix,
      family: reference.family,
    };
  }

  const nameSlot = erbDeclaredNameSlot(lineText, column);
  if (nameSlot === null) return null;
  const needle = nameSlot.prefix.toUpperCase();
  const hit =
    needle.length === 0 || ENGINE_VARIABLE_FAMILIES.some((family) => family.toUpperCase().startsWith(needle));
  if (!hit) return null;
  return { kind: 'variable-family', start: nameSlot.start, end: nameSlot.end, prefix: nameSlot.prefix };
}

/* ============================== 位置门（v2 九态） ============================== */

/** 补全位置门（v2 九态）。`'in-string'` = 「此处非代码视野」，注释一并复用 */
export type ErbCompletionGate =
  | 'call-target'
  | 'def-slot'
  | 'label-target'
  | 'variable-slot'
  | 'bit-slot'
  | 'directive-token'
  | 'in-string'
  | 'interp-expr'
  | 'default';

/**
 * 判定光标处的补全门类（纯函数；`column` = 1 基列）。判定顺序**严格**：
 * a) 非法列 ⇒ `default`；b) 代码视野（串内 / 注释）；c) 位坑；d) 行首 `#…` / `[…]` 记号位；
 * e) 行首 `@名字` 定义位；f) `CALL` 系名字位；g) 跳转家族标签位；h) 变量引用末段；i) `default`。
 */
export function erbCompletionGate(lineText: string, column: number): ErbCompletionGate {
  if (!Number.isFinite(column) || column < 1) return 'default';
  const col0 = Math.min(column - 1, lineText.length);

  const view = erbCodeViewOf(lineText, col0);
  if (view !== 'code') {
    if (view === 'string' && erbInterpRegionAt(lineText, column)) return 'interp-expr';
    return 'in-string';
  }

  if (erbBitSlotOpen(lineText, column)) return 'bit-slot';

  let tokStart = col0;
  while (tokStart > 0 && isNameChar(lineText[tokStart - 1])) tokStart--;
  const marker = tokStart > 0 ? lineText[tokStart - 1] : undefined;
  if ((marker === '#' || marker === '[') && isAllErbBlank(lineText.slice(0, tokStart - 1))) {
    return 'directive-token';
  }

  const def = DEF_RE.exec(lineText);
  if (def !== null && parseErbNameSlot(lineText, col0, def[0].length, false) !== null) return 'def-slot';

  const m = CALL_STMT_RE.exec(lineText);
  if (m !== null && col0 >= m[0].length) {
    const kwEnd = m[0].length;
    const openParen = lineText.indexOf('(', kwEnd);
    const comma = topLevelComma(lineText, kwEnd, lineText.length);
    if (!(openParen >= 0 && openParen < col0) && !(comma >= 0 && col0 > comma)) return 'call-target';
  }

  if (erbLabelSlot(lineText, column) !== null) return 'label-target';
  if (erbVariableSlotAt(lineText, column) !== null) return 'variable-slot';

  return 'default';
}

/**
 * 门 → **只留这些 source** 的白名单（装配层的 keep 滤器消费；缺键 = 不过滤）。
 *
 * 语义：白名单门只保留名单内 source 的候选；`default` / `in-string` / `interp-expr` **不设**
 * （`in-string` 本就整轮零候选；`interp-expr` = "走 default 的白名单"，即不过滤的表达式候选全集）。
 */
export const ERB_GATE_SOURCE_WHITELIST: Readonly<
  Partial<Record<ErbCompletionGate, ReadonlySet<string>>>
> = {
  'call-target': new Set(['erb-functions']),
  'def-slot': new Set(['erb-functions']),
  'label-target': new Set(['erb-labels']),
  'variable-slot': new Set(['erb-variables']),
  'bit-slot': new Set(['erb-bits']),
  'directive-token': new Set(['erb-directives']),
};

/* ============================== 块骨架（snippet） ============================== */

/** 一条块骨架（label / 插入模板 / 副标题）——模板里的占位符按 `insertTextFormat: 'snippet'` 落地 */
export interface ErbCompletionSnippet {
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
}

/**
 * ERB 控制流块的骨架表（成对闭合：漏一个闭合引擎直接加载失败）。
 * 骨架**不带缩进**：ERB 原文语料口径不缩进，插出缩进反而制造与周边行的 diff 噪声。
 */
export const ERB_COMPLETION_SNIPPETS: readonly ErbCompletionSnippet[] = [
  { label: 'IF', insertText: 'IF ${1:条件}\n$2\nENDIF$0', detail: '条件块骨架' },
  { label: 'IF-ELSE', insertText: 'IF ${1:条件}\n$2\nELSE\n$3\nENDIF$0', detail: '条件块骨架：含 ELSE' },
  { label: 'ELSEIF', insertText: 'ELSEIF ${1:条件}', detail: '否则如果分支' },
  { label: 'ELSE', insertText: 'ELSE', detail: '否则分支' },
  { label: 'SIF', insertText: 'SIF ${1:条件}\n$0', detail: '单行条件骨架：只守护下一行' },
  { label: 'WHILE', insertText: 'WHILE ${1:条件}\n$2\nWEND$0', detail: '循环块骨架' },
  { label: 'FOR', insertText: 'FOR ${1:变量}, ${2:起始}, ${3:结束}, ${4:步进}\n$5\nNEXT$0', detail: '计数循环骨架' },
  {
    label: 'SELECTCASE',
    insertText: 'SELECTCASE ${1:表达式}\nCASE ${2:值}\n$3\nCASEELSE\n$4\nENDSELECT$0',
    detail: '分派块骨架：CASE / CASEELSE',
  },
  { label: 'CASE', insertText: 'CASE ${1:值}', detail: '分派分支头' },
  { label: 'CASEELSE', insertText: 'CASEELSE', detail: '分派兜底分支' },
];

/* ============================== 行首 / 行中判定 ============================== */

/** token 起列向前吞并 `#` / `[`（Monaco 默认词法把它们当分隔符）后的替换区间（1 基、单行） */
export function erbTokenRange(line: string, column: number): EditorLanguageRange {
  const lineNumber = 1;
  let col0 = Math.min(Math.max(column - 1, 0), line.length);
  // 光标处 / 光标左侧的名字段（与 Monaco 的 `getWordUntilPosition` 同口径：词外 ⇒ 零宽）
  let start = col0;
  while (start > 0 && isNameChar(line[start - 1])) start--;
  let end = col0;
  while (end < line.length && isNameChar(line[end])) end++;
  if (start === end) {
    start = col0;
    end = col0;
  }
  while (start > 0 && (line[start - 1] === '#' || line[start - 1] === '[')) start--;
  return { line: lineNumber, startColumn: start + 1, endColumn: end + 1 };
}

/**
 * 光标是否在**行首位置**（纯函数）：当前 token 之前只有空白。
 * 空白口径走 `isAllErbBlank` 单源（全角空格算缩进，NBSP 不算）。
 */
export function isLineHeadContext(line: string, column: number): boolean {
  const range = erbTokenRange(line, column);
  return isAllErbBlank(line.slice(0, range.startColumn - 1));
}

/* ============================== 候选装配（本批走槽的四个 facet） ============================== */

/** 索引里按 `path` 归一找文件（宿主键与报文路径在 Windows 上分隔符 / 大小写不一致） */
function fileForPath(index: ErbIndex | null, path: string): ErbFile | null {
  if (!index) return null;
  const want = normalizePathKey(path);
  for (const [key, file] of index.files) {
    if (normalizePathKey(key) === want) return file;
  }
  return null;
}

/**
 * 全文扫描标签定义名（去重、保序）——**仅未索引时的回退路径**。
 *
 * 导出给宿主 `monaco/erb-completion-labels.ts` 用（2026-10-31 收口）：搬判据时这段扫描被
 * 复制过一份，两处各有一套"什么算 `$标签` 定义"的正则；宿主的回退路径改读这里，判据回到一格。
 * 口径与宿主当年逐字相同（行首可含前导空白、名字止于空白 / `;`）。
 */
export function definedLabels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\s*\$([^\s;]+)/gm)) {
    const name = m[1];
    if (name !== undefined && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 扫一份文本里的 `#DIM*` 声明名（大小写不敏感去重、展示保首个原形；跳过 `[SKIPSTART]…[SKIPEND]`）。
 *
 * 行判据是 `dimDeclarationOf`（解析器 `parseDimDeclaration` 的单源包装），本函数只负责**遍历
 * 与屏蔽**。导出给宿主 `monaco/erb-completion-declared.ts` 的回退路径（同一段扫描此前在两处
 * 各存一份，2026-10-31 收口到这一格）。
 */
export function dimNamesOfBuffer(text: string): readonly string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let inSkipBlock = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = raw.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    const dim = dimDeclarationOf(raw);
    if (dim === null) continue;
    const key = dim.name.toUpperCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(dim.name);
  }
  return out;
}

/** 门 → 该 source 能否出货（缺键 = 不过滤；`in-string` 由调用方整轮置空） */
function gateAllows(gate: ErbCompletionGate, sourceId: string): boolean {
  const allowed = ERB_GATE_SOURCE_WHITELIST[gate];
  return allowed === undefined || allowed.has(sourceId);
}

/** 块骨架候选（只在行首；与指令源同名项按 label 去重 ⇒ 本源先出、骨架胜） */
function snippetItems(
  line: string,
  column: number,
  range: EditorLanguageRange,
  kind: EditorCompletionItemKind,
): EditorCompletionItem[] {
  if (!isLineHeadContext(line, column)) return [];
  return ERB_COMPLETION_SNIPPETS.map((s, idx) => ({
    label: s.label,
    kind,
    insertText: s.insertText,
    insertTextFormat: 'snippet' as const,
    detail: s.detail,
    range,
    sortText: `0_${String(idx).padStart(2, '0')}_${s.label}`,
  }));
}

/** `$标签` 候选（本文件、光标行所属函数内；索引缺席才回退全文扫描） */
function labelItems(
  line: string,
  column: number,
  range: EditorLanguageRange,
  text: string,
  path: string,
  lineNumber: number,
  index: ErbIndex | null,
): EditorCompletionItem[] {
  const slot = erbLabelSlot(line, column);
  if (slot === null) return [];

  let labels: readonly string[] | undefined;
  const file = fileForPath(index, path);
  if (file !== null) {
    const fn = file.functions.find((f) => f.startLine <= lineNumber && lineNumber <= f.endLine);
    labels = fn === undefined
      ? []
      : [...new Set((file.labels ?? []).filter((l) => l.functionStartLine === fn.startLine).map((l) => l.name))];
  }
  if (labels === undefined) labels = definedLabels(text);
  if (labels.length === 0) return [];

  const prefix = slot.prefix.toUpperCase();
  const matched = prefix.length === 0 ? labels : labels.filter((name) => name.toUpperCase().startsWith(prefix));
  if (matched.length === 0) return [];

  return matched.map((name) => ({
    label: name,
    kind: 'reference' as const,
    insertText: name,
    detail: '标签（本文件）',
    range: { line: range.line, startColumn: slot.start + 1, endColumn: slot.end + 1 },
    sortText: `${prefix.length > 0 && name.toUpperCase() === prefix ? '0' : '1'}_${name}`,
  }));
}

/** `#DIM` 声明名候选（索引有意见就以它为准，未索引才回退当前缓冲区） */
function declaredItems(
  line: string,
  column: number,
  range: EditorLanguageRange,
  text: string,
  path: string,
  index: ErbIndex | null,
): EditorCompletionItem[] {
  const slot = erbDeclaredNameSlot(line, column);
  if (slot === null) return [];

  const file = fileForPath(index, path);
  const dims = file !== null ? [...new Set(file.dims.map((d) => d.name))] : dimNamesOfBuffer(text);
  if (dims.length === 0) return [];

  const needle = slot.prefix.toUpperCase();
  const items: EditorCompletionItem[] = [];
  const seen = new Set<string>();
  for (const name of dims) {
    if (name.length === 0) continue;
    const upper = name.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    if (needle.length > 0 && !upper.startsWith(needle)) continue;
    const exact = needle.length > 0 && upper === needle;
    items.push({
      label: name,
      kind: 'variable',
      insertText: name,
      filterText: name,
      detail: '#DIM 声明（本文件）',
      range: { line: range.line, startColumn: slot.start + 1, endColumn: slot.end + 1 },
      sortText: `${exact ? '4' : '5'}_${name}`,
    });
  }
  return items;
}

/* ============================== 槽供方 ============================== */

/** 供方的注入面：索引**现取**（未开项目 / 索引在途 ⇒ `null`，各 facet 按"未索引"降级） */
export interface ErbCompletionDeps {
  readonly index: ErbIndex | null;
}

/** 从全文取第 `line` 行（1 基；越界 ⇒ 空串）。逐行切只在需要时做一次，不缓存跨请求状态。 */
function lineOf(text: string, line: number): string {
  if (!Number.isFinite(line) || line < 1) return '';
  let start = 0;
  let n = 1;
  while (n < line) {
    const idx = text.indexOf('\n', start);
    if (idx < 0) return '';
    start = idx + 1;
    n += 1;
  }
  const end = text.indexOf('\n', start);
  const raw = end < 0 ? text.slice(start) : text.slice(start, end);
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

/** 方言闸：只有 ERB 三种扩展名归本包（与 `definition` / `rename` 腿同一份判据来源） */
function isErbPath(path: string): boolean {
  return /\.(erb|erh|erd)$/i.test(path);
}

/**
 * 应答 `ui.editor.languageService` 的 `completion` 成员。
 *
 * 三态（与 definition / rename 同一条纪律）：
 * - 不是 `completion` 请求 / 不是 ERB 方言 ⇒ `undefined`（**弃权**，让下一家供方接手）；
 * - 认这个位置但一个候选都没有（串内 / 注释内 / 名位前缀不命中）⇒ `{ items: [] }`（**不猜**）；
 * - 有候选 ⇒ 全部条目（次序 = 宿主源表里这四个 facet 的相对次序，先注册者胜的去重语义不变）。
 */
export function provideErbCompletion(
  request: { readonly kind: string; readonly path?: string; readonly text?: string; readonly line?: number; readonly column?: number },
  deps: ErbCompletionDeps,
): { kind: 'completion'; items: EditorCompletionItem[] } | undefined {
  if (request.kind !== 'completion') return undefined;
  const path = request.path ?? '';
  if (!isErbPath(path)) return undefined;
  const text = request.text ?? '';
  const lineNumber = request.line ?? 1;
  const column = request.column ?? 1;
  const line = lineOf(text, lineNumber);

  let gate: ErbCompletionGate;
  try {
    gate = erbCompletionGate(line, column);
  } catch {
    return { kind: 'completion', items: [] };
  }
  if (gate === 'in-string') return { kind: 'completion', items: [] };

  const range = erbTokenRange(line, column);
  const items: EditorCompletionItem[] = [];
  try {
    if (gateAllows(gate, 'erb-snippet')) items.push(...snippetItems(line, column, range, 'snippet'));
    if (gateAllows(gate, 'erb-labels')) items.push(...labelItems(line, column, range, text, path, lineNumber, deps.index));
    if (gateAllows(gate, 'erb-families')) items.push(...erbFamilyCandidates(line, column, range.line));
    if (gateAllows(gate, 'erb-declared')) items.push(...declaredItems(line, column, range, text, path, deps.index));
  } catch {
    return { kind: 'completion', items: [] };
  }
  return { kind: 'completion', items };
}