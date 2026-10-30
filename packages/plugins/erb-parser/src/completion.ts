/**
 * ERB 补全的**语言判据**（LAU-4 补全腿：第二批四 facet + 第三批其余七路）。
 *
 * 位置门 v2、名字槽 / 标签位 / 变量段 / 位坑 / 成员位；**十一路上候选**的生成、去重、
 * 排序与详情；以及经 `ui.editor.languageService` 的 `completion` 成员应答的装配。
 *
 * ## 为什么住在解析器插件（而不是 `@kojo/erb-lang`）
 *
 * 判据要由**槽的供方**回答，而供方是常驻插件 `@kojo/plugin-erb-parser`；插件读不到宿主
 * `packages/app/src/**`，也**不许静态引 `@kojo/erb-lang` 的补全叶子**——那会把 2.0 补全
 * 词表链（`kojo-lang/completion` + `kojo-vocab/{engine,keywords}` 等 9 枚）拽上开机图，
 * 直接撞碎 ps10 的 199 文件闸（实测 199 ⇒ 208）。故判据折进本包，宿主那几枚
 * `monaco/erb-completion-*` 只剩「收集事实」与「契约 → Monaco 形状」翻译。
 *
 * 判据从宿主整块搬入（第二批 `2d4581c0` / `d9e9d207`；第三批 2026-10-31 收官），逐条
 * **原样搬入**，唯一改动是地基：
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
 * ## 事实输入（第三批的接线口径）
 *
 * 插件读不到 adapter 槽、项目索引与设置，故这些**事实**由宿主经请求的 `facts`
 * （`EditorCompletionFacts`）递进来：变量 schema / 变量字典 / 调用协议 / 行首指令名 /
 * 系统函数中文别名 / 文档词开关 / `#DIM` 名 / 标签名 / 项目函数名。缺哪一份，依赖它的
 * 那一路就零候选（**不猜、不抛**），其余路照常出货——与「表缺席 ⇒ 该路空」的旧口径逐字相同。
 */
import type {
  EditorCompletionFacts,
  EditorCompletionItem,
  EditorCompletionItemKind,
EditorCompletionResult,
  EditorHoverRequest,
  EditorHoverResult,
  EditorLanguageRange,
  EditorLanguageServiceRequest,
  ErbDim,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableInfo,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/kojo-vocab/types';
import {
  buildCallSnippetText,
  callSignatureLine,
  callSlotsOf,
  ERB_BLANK_CLASS_STR,
  ERB_BLANK_RE,
  ERB_CONTINUATION_MARKERS,
  ERB_PREPROC_CANDIDATES,
  ERB_SKIP_MARKERS,
  MODEL_TOKEN_CLASS,
  erbContinuationRoleOf,
  erbPreprocRoleOf,
  isAllErbBlank,
  isErbBlank,
  isErbDialectPath,
  symbolTokenAt,
  unicodeTokenAt,
} from '@kojo/plugin-api';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/kojo-vocab/system-functions';
// 控制流真源与内建式中函数表**同住本包**（`scanner.ts` / `builtins.ts`），不是契约件：
// 补全的"行中关键字"与"系统函数名"两路都要它们，与解析 / 实参诊断同一张表。
import { BUILTIN_FUNCTION_NAMES, builtinSignatureLabel } from './builtins';
import { ERB_CONTROL_STATEMENTS, classifyControlFlow, parseDimDeclaration } from './scanner';
import { ERB_DECLARATION_DIRECTIVES, ERB_STATEMENT_DIRECTIVES } from './instructions';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { dimDeclarationOf, isErbDimNameChar, normalizePathKey } from './symbols';

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

/* ============================== 候选装配（LAU-4 补全腿第三批：十一路 facet 全在这） ============================== */

/**
 * 这一段是 ERB 补全**全部候选**的产地：位置门之后的"弹什么、什么次序、谁被去重掉"。
 *
 * 2026-10-31（第三批）把宿主 `monaco/erb-completion*.ts` 剩下的六路（指令词 / 变量名 /
 * 项目函数 / 系统函数 / 位号 / 成员 + 文档词）整块搬进来，于是宿主只剩「收集事实 → 组请求
 * → 调槽 → 契约项 → Monaco 条目」。搬的是**判据**（哪一位弹什么、怎么排序、怎么去重），
 * 留下的**事实**（adapter 表 / 项目名录 / 宿主词表 / 偏好开关）经请求的
 * `facts`（`EditorCompletionFacts`）递进来——插件读不到槽、也不许读盘。
 *
 * 排序 / 去重与宿主装配核（`monaco/completion-core.ts` 的 `mergeSuggestions`）**同一条
 * 口径**：按 label 去重（先注册者胜）→ 排名键（前缀精确 > 前缀命中 > 原文子序列 > 其它，
 * 同档沿用各源的 `sortText`）→ 上限截断。逐字复刻的理由只有一个：搬完之后作者看到的
 * 候选集、次序与图标必须与搬之前一模一样。
 *
 * **一处已知差异**（记在回执里）：宿主装配核的排名键还有两档拼音（首字母 / 全拚）与
 * `filterText` 的拼音补键，而拼音表住在宿主（`monaco/pinyin.ts`，22 KB）。插件不许为
 * 此把那张表拽上开机图，故这里只保留前四档；中文候选按罗马字输入时的**次序**与
 * **可搜性**因此退化（按汉字输入不受影响）。
 */

/** 装配级候选上限（与宿主装配核 `MAX_ASSEMBLED_SUGGESTIONS` 同值） */
const MAX_ASSEMBLED_CANDIDATES = 1000;
/** 单源名字命中上限（与宿主装配核 `MAX_NAME_CANDIDATES` 同值） */
const MAX_NAME_CANDIDATES = 1000;
/** 文档词源的数字（与宿主 `document-words.ts` 同一批：上限 / 词长 / 行数闸） */
const MAX_DOCUMENT_WORD_SUGGESTIONS = 200;
const WORD_SUGGESTIONS_MAX_LINES = 5000;
const MAX_WORD_INDEX = 4000;
const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 32;
const PURE_NUMBER_RE = /^\d+$/;

/** 一次补全的上下文：行文本 / 光标 / 替换区间 / 事实输入（各 facet 只吃这一枚） */
interface ErbCompletionContext {
  readonly line: string;
  readonly column: number;
  readonly lineNumber: number;
  readonly text: string;
  readonly path: string;
  readonly range: EditorLanguageRange;
  readonly prefix: string;
  readonly facts: EditorCompletionFacts;
}

/** 一条候选 + 它的来源 id（去重时说清谁先注册） */
interface SourcedItem {
  readonly item: EditorCompletionItem;
  readonly sourceId: string;
}

/* ============================== 缓冲区回退扫描（未索引时的唯一事实） ============================== */

/**
 * 全文扫描标签定义名（去重、保序）——**仅未索引时的回退路径**。
 *
 * 口径与宿主当年逐字相同（行首可含前导空白、名字止于空白 / `;`）。宿主 `monaco/` 侧
 * 已不再保留第二份：这条回退与索引事实共用同一个"什么算 `$标签` 定义"的判据。
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
 * 行判据是 `dimDeclarationOf`（解析器 `parseDimDeclaration` 的单源包装），本函数只负责
 * **遍历与屏蔽**——`#DIM` 名只有这一个产地。
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

/* ============================== 块骨架（snippet 源） ============================== */

/**
 * 块骨架候选（只在**行首**）：ERB 控制流块成对闭合，漏一个闭合引擎直接加载失败。
 * 骨架**不带缩进**（原文语料口径不缩进，插出缩进只会制造与周边行的 diff 噪声）。
 *
 * 本源注册在源表**最前**：行首与指令源的同名纯文本项按 label 去重（先注册者胜）⇒ 行首
 * 只留骨架、行中纯文本照旧。
 */
function snippetCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  if (!isLineHeadContext(ctx.line, ctx.column)) return [];
  return ERB_COMPLETION_SNIPPETS.map((s, idx) => ({
    label: s.label,
    kind: 'snippet',
    insertText: s.insertText,
    insertTextFormat: 'snippet',
    detail: s.detail,
    range: ctx.range,
    sortText: `0_${String(idx).padStart(2, '0')}_${s.label}`,
  }));
}

/* ============================== 排名键（与宿主装配核同式，减拼音两档） ============================== */

/** `needle` 是否为 `haystack` 的字符子序列（大小写归一由调用方负责） */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  const n = needle.length;
  for (const ch of haystack) {
    if (i < n && ch === needle[i]) {
      i += 1;
      if (i === n) return true;
    }
  }
  return false;
}

/**
 * 模糊档（`undefined` = 落「其它」档）：只剩**原文子序列**那一档。
 * 宿主那一份还有「拼音首字母」「全拚」两档（表住宿主，见段头「一处已知差异」）。
 */
function fuzzyTier(label: string, prefix: string): 'a' | undefined {
  return isSubsequence(prefix.toLowerCase(), label.toLowerCase()) ? 'a' : undefined;
}

/**
 * 排名键：`0|` 前缀精确 > `1|` 前缀命中 > `2a|` 原文子序列 > `2|` 其它；
 * 同档沿用各源自带的 `sortText`，再以 label 兜底（与宿主 `rankKey` 逐字同式）。
 */
function rankKeyOf(label: string, sortText: string | undefined, prefix: string): string {
  const base = sortText ?? '';
  if (prefix.length === 0) return `2|${base}|${label}`;
  if (label === prefix) return `0|${base}|${label}`;
  if (label.startsWith(prefix)) return `1|${base}|${label}`;
  const tier = fuzzyTier(label, prefix);
  return tier === undefined ? `2|${base}|${label}` : `2${tier}|${base}|${label}`;
}

/**
 * 去重（按 label，先注册者胜）→ 排序（排名键）→ 上限截断 → 写回 `sortText`。
 *
 * `sortText` 必须写回：Monaco 的客户端排序先比 `sortText`，不写回就白算了一遍排名键
 * （宿主装配核当年也是这条：`{...item, sortText: key}`）。
 */
function mergeCandidates(entries: readonly SourcedItem[], prefix: string): EditorCompletionItem[] {
  const byLabel = new Map<string, SourcedItem>();
  for (const entry of entries) {
    if (!byLabel.has(entry.item.label)) byLabel.set(entry.item.label, entry);
  }
  const ranked = [...byLabel.values()]
    .map((entry) => ({ entry, key: rankKeyOf(entry.item.label, entry.item.sortText, prefix) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return ranked.slice(0, MAX_ASSEMBLED_CANDIDATES).map(({ entry, key }) => ({ ...entry.item, sortText: key }));
}

/* ============================== 大小写不敏感前缀索引（项目函数名 / 成员族共用） ============================== */

/** 折叠：`a`–`z` 折成大写，其余码元原样（与宿主装配核 `foldCode` 同口径） */
function foldCode(c: number): number {
  return c >= 97 && c <= 122 ? c - 32 : c;
}

/** 大小写不敏感比较（等价于两者 `toUpperCase()` 的字典序；非 ASCII 退回真身上比较） */
function compareFold(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca < 128 && cb < 128) {
      const fa = foldCode(ca);
      const fb = foldCode(cb);
      if (fa !== fb) return fa < fb ? -1 : 1;
      continue;
    }
    const ua = a.toUpperCase();
    const ub = b.toUpperCase();
    return ua < ub ? -1 : ua > ub ? 1 : 0;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** `text` 是否以 `prefix` 开头（大小写不敏感、零分配；口径同 {@link compareFold}） */
function startsWithFold(text: string, prefix: string): boolean {
  if (text.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const ct = text.charCodeAt(i);
    const cp = prefix.charCodeAt(i);
    if (ct === cp) continue;
    if (ct < 128 && cp < 128) {
      if (foldCode(ct) !== foldCode(cp)) return false;
      continue;
    }
    return text.toUpperCase().startsWith(prefix.toUpperCase());
  }
  return true;
}

/** 入参是否已是"全是字符串 + 折叠序严格递增"（= 可以零复制当索引） */
function isSortedUniqueNames(names: readonly string[]): boolean {
  let prev: string | null = null;
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) return false;
    if (prev !== null && compareFold(prev, name) >= 0) return false;
    prev = name;
  }
  return true;
}

/** 按数组身份记忆化的折叠序名字表（十万条量级只排一次） */
const NAME_INDEX_CACHE = new WeakMap<readonly string[], readonly string[]>();

function foldedNameIndex(names: readonly string[]): readonly string[] {
  const cached = NAME_INDEX_CACHE.get(names);
  if (cached !== undefined) return cached;
  // 快路：宿主交过来的名录本就按归一化名升序去重 ⇒ 它自己就是索引，零复制零排序。
  const sorted = isSortedUniqueNames(names) ? names : [...names].sort(compareFold);
  NAME_INDEX_CACHE.set(names, sorted);
  return sorted;
}

/** 首个小写等于或大于 `target` 的下标（升序表；`target` 已归一化为大写） */
function lowerBound(names: readonly string[], target: string): number {
  let lo = 0;
  let hi = names.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareFold(names[mid]!, target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ============================== 行首 / 行中词表（指令源） ============================== */

/**
 * **必须行首**的预处理指令（`#DIM` / `#FUNCTION` …）——名字不出现在表达式里，故只进「行首」集。
 */
const ERB_PREPROCESSOR_DIRECTIVES: readonly string[] = [
  '#DIM', '#DIM CONST', '#DIM SAVEDATA', '#DIM GLOBAL',
  '#DIMS', '#DIMSTR', '#DIMCHAR',
  '#FUNCTION', '#FUNCTIONS', '#DEFINE', '#INCLUDE', '#ONLY',
  '#LOCALSIZE', '#LOCALSSIZE',
  '#PRI', '#LATER', '#SINGLE',
];

/** **必须行首**的 `[` 标记行（区间停用标记 + 预处理器条件块骨架），全量派生自契约真源 */
const ERB_BRACKET_DIRECTIVES: readonly string[] = [
  ...ERB_PREPROC_CANDIDATES.map((c) => c.label),
  ERB_SKIP_MARKERS.start,
  ERB_SKIP_MARKERS.end,
];

/** 「行中」可出现的**控制流关键字**——由 scanner 配对表真源派生（结构认 ⇒ 行中也补） */
const ERB_MIDLINE_CONTROL_KEYWORDS: readonly string[] = ERB_CONTROL_STATEMENTS.filter(
  (word) => classifyControlFlow(word) !== null,
);

/** 「行中」的**直系调用 / FORM 形态**语句词（位置门单源清单去掉 `label` 槽） */
const ERB_MIDLINE_CALL_KEYWORDS: readonly string[] = ERB_CALL_STATEMENTS.filter((s) => s.slot !== 'label').map(
  (s) => s.kw,
);

/** **未进任何真源表**的单行流程语句（配对表与调用表都不收；删词即回退） */
const ERB_MIDLINE_EXTRA_KEYWORDS: readonly string[] = ['RETURN', 'BREAK', 'CONTINUE'];

/**
 * 「行中」可出现的关键字子集：控制流（配对表派生）+ 调用形态（调用表派生）+ 跳转族
 * （{@link ERB_JUMP_KEYWORDS} 单源展开）+ 三枚手抄保留 + `PRINT*`（宿主词表派生）。
 *
 * `PRINT*` 那一支读的是**请求里的 `directiveWords`**（宿主词表，含 adapter 指令名）——
 * 词表本身不住插件（那是宿主 Monarch 与 `.kojo` 原生区共用的单一真源）。
 */
function erbMidlineKeywords(directiveWords: readonly string[]): readonly string[] {
  return [
    ...ERB_MIDLINE_CONTROL_KEYWORDS,
    ...ERB_MIDLINE_CALL_KEYWORDS,
    ...ERB_JUMP_KEYWORDS,
    ...ERB_MIDLINE_EXTRA_KEYWORDS,
    ...directiveWords.filter((d) => d.startsWith('PRINT')),
  ];
}

/**
 * 指令 / 关键字候选：**行首**给 `directiveWords`（宿主词表 ∪ adapter 指令名）+ 预处理指令
 * + `[` 标记行（按**全记号前缀**收窄，前缀含吞并的 `#` / `[`）；**行中**只给表达式 /
 * 实参可出现的关键字子集。大小写不敏感去重（首见者胜）。
 */
function directiveCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const { line, column, range, facts } = ctx;
  const items: EditorCompletionItem[] = [];
  const seen = new Set<string>();
  const push = (label: string, detail: string): void => {
    const key = label.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      label,
      kind: 'keyword',
      insertText: label,
      detail,
      range,
      sortText: `0_${label}`,
    });
  };
  if (isLineHeadContext(line, column)) {
    const prefix = line.slice(range.startColumn - 1, range.endColumn - 1).toUpperCase();
    const hit = (label: string): boolean => prefix.length === 0 || label.toUpperCase().startsWith(prefix);
    for (const d of facts.directiveWords ?? []) if (hit(d)) push(d, '指令');
    for (const d of ERB_PREPROCESSOR_DIRECTIVES) if (hit(d)) push(d, '预处理指令');
    for (const d of ERB_BRACKET_DIRECTIVES) if (hit(d)) push(d, '指令行');
  } else {
    for (const k of erbMidlineKeywords(facts.directiveWords ?? [])) push(k, '关键字');
  }
  return items;
}

/* ============================== 变量名 / 位号（adapter 变量表） ============================== */

/** 变量引用末段的候选（族:名 / 族:段:名）；族头不在白名单 / 无表 ⇒ 零候选 */
function variableCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const schema = ctx.facts.variableSchema;
  const names = schema?.names;
  if (names === undefined) return [];
  const context = erbVariableSlotAt(ctx.line, ctx.column);
  if (context === null) return [];

  const range: EditorLanguageRange = {
    line: ctx.lineNumber,
    startColumn: context.start + 1,
    endColumn: context.end + 1,
  };
  // 三段式的末段是"作用域记录里的一项" ⇒ field；二段式是族自身的索引 ⇒ variable。
  const kind: EditorCompletionItemKind = context.scoped ? 'field' : 'variable';
  const items: EditorCompletionItem[] = [];
  const seen = new Set<string>();
  for (const info of names(context.family) ?? []) {
    const name = info.name;
    if (name.length === 0 || seen.has(name)) continue;
    if (context.prefix.length > 0 && !name.startsWith(context.prefix)) continue;
    seen.add(name);
    const index: number | string | undefined = info.index ?? info.resolvedIndex;
    const exact = context.prefix.length > 0 && name === context.prefix;
    items.push({
      label: name,
      kind,
      insertText: name,
      detail: index === undefined ? context.family : `${context.family}:${index}`,
      range,
      sortText: `${exact ? '0' : '1'}_${name}`,
      ...(info.description !== undefined && info.description.length > 0
        ? { documentation: info.description, documentationFormat: 'markdown' as const }
        : {}),
    });
  }
  return items;
}

/** 位槽第二实参的候选：`GETBIT(变量, 位)` / `SETBIT 变量, 位` 的位号 + 中文位名 */
function bitCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const schema = ctx.facts.variableSchema;
  if (!schema) return [];
  const slot = findBitSlot(ctx.line, ctx.column);
  if (slot === null) return [];
  // 位坑已有内容（作者写了位号 / 写成变量 `LOCAL`）⇒ 不抢候选
  if (!erbBitSlotRegionBlank(ctx.line, slot)) return [];

  const first = slot.variableRef.indexOf(':');
  const last = slot.variableRef.lastIndexOf(':');
  const name = first < 0 ? slot.variableRef : slot.variableRef.slice(0, first);
  const index = last < 0 ? undefined : slot.variableRef.slice(last + 1);
  let bits: ReadonlyArray<{ bit: number; label: string }> | undefined;
  try {
    bits = schema.lookup(name, index)?.bits;
  } catch {
    return [];
  }
  if (bits === undefined || bits.length === 0) return [];

  // 替换区间 = 光标处的**零宽**插入点（位号是往里插的，不覆盖任何既有字）
  const range: EditorLanguageRange = {
    line: ctx.lineNumber,
    startColumn: ctx.column,
    endColumn: ctx.column,
  };
  const items: EditorCompletionItem[] = [];
  const seen = new Set<string>();
  for (const b of bits) {
    const label = `${b.bit} ${b.label}`;
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({
      label,
      kind: 'enumMember',
      insertText: String(b.bit),
      detail: slot.variableRef,
      documentation: b.label,
      range,
      sortText: `${String(b.bit).padStart(4, '0')}_${label}`,
    });
  }
  return items;
}

/* ============================== 项目函数名（名字槽） ============================== */

/**
 * 调用位（长词在前 + 关键字后必须有空白）；只吃 `'func'` / `'form'` 槽——`'label'` 槽
 * （跳转家族）是标签位，候选归标签源。
 */
const CALL_RE = erbCallStatementRe(['func', 'form'], true);

/**
 * 光标处的 ERB **函数名槽**（定义位 `@…` 或调用位；纯函数，可单测）。
 * `'form'`（`*FORM*` 全族）之后的槽是 FORM 串，允许 `%…%` / `{…}` 段；`'func'` 之后只收名字字符。
 */
export function erbFunctionNameSlot(line: string, column: number): ErbNameSlot | null {
  const col0 = Math.min(Math.max(column - 1, 0), line.length);
  const def = DEF_RE.exec(line);
  if (def !== null) return parseErbNameSlot(line, col0, def[0].length, false);
  const call = CALL_RE.exec(line);
  if (call !== null) {
    const allowInterp = ERB_CALL_SLOT_BY_KEYWORD.get(call[1]!.toUpperCase()) === 'form';
    return parseErbNameSlot(line, col0, call[0].length, allowInterp);
  }
  return null;
}

/** 函数名槽的候选：二分找前缀下界 + 连续前扫（`O(log n + 命中数)`，与总量无关） */
function functionCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const functionNames = ctx.facts.functionNames;
  if (functionNames === undefined || functionNames.length === 0) return [];
  const slot = erbFunctionNameSlot(ctx.line, ctx.column);
  if (slot === null) return [];

  const names = foldedNameIndex(functionNames);
  const norm = slot.prefix.toUpperCase();
  const from = lowerBound(names, norm);
  if (from >= names.length || !startsWithFold(names[from]!, norm)) return [];

  const range: EditorLanguageRange = {
    line: ctx.lineNumber,
    startColumn: slot.start + 1,
    endColumn: slot.end + 1,
  };
  const items: EditorCompletionItem[] = [];
  for (let i = from; i < names.length && items.length < MAX_NAME_CANDIDATES; i++) {
    const name = names[i]!;
    if (!startsWithFold(name, norm)) break;
    const exact = name.length === norm.length;
    items.push({
      label: name,
      kind: 'function',
      insertText: name,
      range,
      sortText: `${exact ? '0' : '1'}_${name}`,
    });
  }
  return items;
}

/* ============================== 系统函数名（引擎 exmeth 静态表） ============================== */

/** 系统函数候选的 documentation 头段：中文别名（查得到才挂）+ 引擎签名（exmeth 静态表） */
function systemFunctionDocumentation(facts: EditorCompletionFacts, name: string): string {
  const label = builtinSignatureLabel(name) ?? name;
  let cn: string | undefined;
  for (const [key, alias] of facts.systemFunctionAliases ?? []) {
    if (key === name) {
      cn = alias;
      break;
    }
  }
  const head = cn === undefined ? `**${name}**` : `**${name}** ↔ ${cn}`;
  return label === name ? head : `${head}\n\n${label}`;
}

/**
 * 系统函数名候选（英文名 `GETBIT(`）：词表 = 本包 `BUILTIN_FUNCTION_NAMES`（exmeth 静态签名表）。
 *
 * 位置防守（不满足 ⇒ 整路零候选）：行首 `;` 注释行 / 光标前 `"` 计数为奇（串内）/
 * 词前全是空白（行首指令位）/ 词紧前是 `$`（标签名位）。**不过滤前缀**（宿主当年也不过滤：
 * 整表出货，由 Monaco 的客户端过滤收窄——排序档按 精确 / 命中 / 其它 三档）。
 *
 * 括号调用形态：`insertText` = `名字(`；协议认识这个函数时改写成带 tabstop 的骨架
 * （`名字(${1:ARG:0 …})`，`insertTextFormat: 'snippet'`）；作者自己已敲了 `(` ⇒ 收回纯名字。
 */
function systemFunctionCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const { line, column } = ctx;
  const col0 = Math.min(column - 1, line.length);

  if (/^\s*;/.test(line)) return [];
  let quotes = 0;
  for (let i = 0; i < col0; i++) {
    if (line[i] === '"') quotes++;
  }
  if (quotes % 2 === 1) return [];

  // 光标处的名字段（左含右不含；与 `erbTokenRange` 的记号口径同一个字符类）
  let start = col0;
  while (start > 0 && isNameChar(line[start - 1])) start--;
  let end = col0;
  while (end < line.length && isNameChar(line[end])) end++;
  if (start === end) return [];
  if (isAllErbBlank(line.slice(0, start))) return [];
  if (start > 0 && line[start - 1] === '$') return [];

  const range: EditorLanguageRange = { line: ctx.lineNumber, startColumn: start + 1, endColumn: end + 1 };
  const prefix = line.slice(start, col0).toUpperCase();
  const charAfter = line.slice(end, end + 1);

  const items: EditorCompletionItem[] = [];
  for (const name of BUILTIN_FUNCTION_NAMES) {
    const exact = prefix.length > 0 && name === prefix;
    const hit = prefix.length > 0 && name.startsWith(prefix);
    let insertText = `${name}(`;
    let insertTextFormat: 'plainText' | 'snippet' | undefined;
    if (charAfter === '(') {
      // 作者已自己开了括号：落字只补名字，否则原样插入的 `名字(` 与那枚 `(` 叠成 `名字((`
      insertText = name;
    } else {
      const snippet = buildCallSnippetText(name, callSlotsOf(ctx.facts.callProtocol, [name]));
      if (snippet !== undefined) {
        insertText = snippet;
        insertTextFormat = 'snippet';
      }
    }
    items.push({
      label: name,
      kind: 'function',
      insertText,
      ...(insertTextFormat !== undefined ? { insertTextFormat } : {}),
      detail: '系统函数',
      documentation: systemFunctionDocumentation(ctx.facts, name),
      documentationFormat: 'markdown',
      range,
      sortText: `${exact ? '0' : hit ? '1' : '2'}_${name}`,
    });
  }
  return items;
}

/* ============================== 成员 / 属性 / 函数族 ============================== */

/** 名录的族成员查询（按「数组身份 + 族键」记忆化；上限只防无界，丢了只是重扫一遍） */
const FAMILY_INDEX_CACHE = new WeakMap<readonly string[], Map<string, readonly string[]>>();
const FAMILY_CACHE_LIMIT = 32;

function familyMembersOf(names: readonly string[], key: string): readonly string[] {
  let cache = FAMILY_INDEX_CACHE.get(names);
  if (cache === undefined) {
    cache = new Map<string, readonly string[]>();
    FAMILY_INDEX_CACHE.set(names, cache);
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const members: string[] = [];
  const guard = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || name.length <= key.length) continue;
    if (!startsWithFold(name, key)) continue;
    const upper = name.toUpperCase();
    if (guard.has(upper)) continue;
    guard.add(upper);
    members.push(name);
  }
  while (cache.size >= FAMILY_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, members);
  return members;
}

/** 系统函数族成员（`receiver*`；接收者至少两字符——单字母会把整张系统函数表抖进候选） */
function systemFamilyMembers(receiver: string): readonly string[] {
  const needle = receiver.toUpperCase();
  if (needle.length < 2) return [];
  const out: string[] = [];
  for (const name of BUILTIN_FUNCTION_NAMES) {
    if (name === needle) continue;
    if (name.startsWith(needle)) out.push(name);
  }
  return out;
}

/** 一条族成员命中：完整名 + 族后缀（作者在点号之后继续打的那一段）+ 排名键（只算一次） */
interface MemberHit {
  readonly name: string;
  readonly suffix: string;
  readonly key: string;
}

/** 点号成员候选（`receiver.|` ⇒ 同族成员）：项目函数族 `receiver_*` + 系统函数族 `receiver*` */
function dotMemberCandidates(ctx: ErbCompletionContext, slot: ErbMemberSlot): EditorCompletionItem[] {
  const receiver = slot.receiver;
  if (receiver === undefined) return [];
  const fragment = slot.prefix;
  const hits: MemberHit[] = [];
  const seen = new Set<string>();
  const collect = (member: string, suffixStart: number): boolean => {
    if (hits.length >= MAX_NAME_CANDIDATES) return false;
    const suffix = member.slice(suffixStart);
    if (suffix.length === 0) return true;
    const normalized = member.toUpperCase();
    if (seen.has(normalized)) return true;
    const key = fragment.length === 0 ? `2|${suffix}` : rankKeyOf(suffix, undefined, fragment);
    // 已输入片段与族后缀无关的成员不入面（"其它"档 = 排名键的 `2|` 档）
    if (fragment.length > 0 && key.startsWith('2|')) return true;
    seen.add(normalized);
    hits.push({ name: member, suffix, key });
    return hits.length < MAX_NAME_CANDIDATES;
  };
  const functionNames = ctx.facts.functionNames;
  if (functionNames !== undefined && functionNames.length > 0) {
    for (const member of familyMembersOf(functionNames, `${receiver.toUpperCase()}_`)) {
      if (!collect(member, receiver.length + 1)) break;
    }
  }
  if (hits.length < MAX_NAME_CANDIDATES) {
    for (const member of systemFamilyMembers(receiver)) {
      if (!collect(member, receiver.length)) break;
    }
  }
  if (hits.length === 0) return [];

  const start = slot.receiverStart ?? slot.start;
  const range: EditorLanguageRange = { line: ctx.lineNumber, startColumn: start + 1, endColumn: slot.end + 1 };
  hits.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return hits.map(({ name, suffix, key }) => ({
    label: name,
    kind: 'function',
    // ERB 没有点号语法：点号只是族查询键，落字一律是**完整函数名**（替换范围连接收者一起覆盖）
    insertText: name,
    filterText: suffix,
    detail: `函数族成员（${receiver}）`,
    documentation: [
      `点号成员推断：\`${receiver}.\` ⇒ 项目函数族 \`${receiver}_*\` / 系统函数族 \`${receiver}*\``,
      'ERB 无点号语法：接受后落字为完整函数名（点号只是族查询键，写回正文的是 `名字`）。',
    ].join('\n\n'),
    documentationFormat: 'markdown',
    range,
    sortText: key,
  }));
}

/** 成员位候选：族头位 → 族表；点号成员位 → 同族成员；字段位 → 零候选（本包没有静态数据） */
function memberCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const slot = erbMemberSlotAt(ctx.line, ctx.column);
  if (slot === null) return [];
  if (slot.kind === 'variable-family') {
    const needle = slot.prefix.toUpperCase();
    const range: EditorLanguageRange = {
      line: ctx.lineNumber,
      startColumn: slot.start + 1,
      endColumn: slot.end + 1,
    };
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
        detail: '引擎变量族',
        range,
        sortText: `${exact ? '0' : '1'}_${family}`,
      });
    }
    return items;
  }
  return slot.kind === 'member' ? dotMemberCandidates(ctx, slot) : [];
}

/* ============================== 文档词 ============================== */

/** 一行里除字符串内容 / `;` 行注释外的代码部分（与 `erbCodeViewOf` 同向的保守切法） */
function stripStringsAndComment(line: string): string {
  let out = '';
  let inString = false;
  for (const ch of line) {
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ';') break;
    out += ch;
  }
  return out;
}

/** 一行里的全部连续名字段（字符类与 {@link NAME_CHAR_RE} 同一个真源） */
function nameWordsOf(line: string): string[] {
  const re = new RegExp(NAME_CHAR_RE.source, 'gu');
  const out: string[] = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m[0].length > 0) out.push(m[0]);
  }
  return out;
}

/** 整篇代码行的词条（去重保序、跳过纯数字；大小写不敏感去重 = ERB 名字口径） */
function documentWordsOf(text: string): readonly string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > WORD_SUGGESTIONS_MAX_LINES) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    for (const word of nameWordsOf(stripStringsAndComment(line))) {
      if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
      if (PURE_NUMBER_RE.test(word)) continue;
      const key = word.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
      if (out.length >= MAX_WORD_INDEX) return out;
    }
  }
  return out;
}

/**
 * 文档词候选（当前文件里的同前缀代码词）：开关缺席 / `false` ⇒ 零候选；光标前无词 ⇒ 零候选；
 * 与已输入词完全相同的不出（插了也是原位不动）。`sortText` 以 `9_` 打头 ⇒ 排在上下文候选之后。
 */
function wordCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  if (ctx.facts.wordBasedSuggestions !== true) return [];
  const col0 = Math.min(ctx.column - 1, ctx.line.length);
  let start = col0;
  while (start > 0 && isNameChar(ctx.line[start - 1])) start--;
  const word = ctx.line.slice(start, col0);
  if (word.length === 0) return [];

  const prefix = word.toLowerCase();
  const items: EditorCompletionItem[] = [];
  for (const candidate of documentWordsOf(ctx.text)) {
    const lower = candidate.toLowerCase();
    if (lower === prefix) continue;
    if (!lower.startsWith(prefix)) continue;
    items.push({
      label: candidate,
      kind: 'text',
      insertText: candidate,
      filterText: candidate,
      detail: '文档词',
      range: ctx.range,
      sortText: `9_${candidate}`,
    });
    if (items.length >= MAX_DOCUMENT_WORD_SUGGESTIONS) break;
  }
  return items;
}

/* ============================== 条目标签（$标签 / #DIM 名） ============================== */

/** `$标签` 候选：作用域表由宿主递进来（光标行所属函数内；`undefined` = 未索引 ⇒ 回退缓冲区） */
function labelCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const slot = erbLabelSlot(ctx.line, ctx.column);
  if (slot === null) return [];

  const labels = ctx.facts.labelNames ?? definedLabels(ctx.text);
  if (labels.length === 0) return [];

  const prefix = slot.prefix.toUpperCase();
  const matched = prefix.length === 0 ? labels : labels.filter((name) => name.toUpperCase().startsWith(prefix));
  if (matched.length === 0) return [];
  return matched.map((name) => ({
    label: name,
    kind: 'reference' as const,
    insertText: name,
    detail: '标签（本文件）',
    range: { line: ctx.range.line, startColumn: slot.start + 1, endColumn: slot.end + 1 },
    sortText: `${prefix.length > 0 && name.toUpperCase() === prefix ? '0' : '1'}_${name}`,
  }));
}

/** `#DIM` 声明名候选：索引有意见（数组，含 `[]`）就以它为准，`undefined` 才回退当前缓冲区 */
function declaredCandidates(ctx: ErbCompletionContext): EditorCompletionItem[] {
  const slot = erbDeclaredNameSlot(ctx.line, ctx.column);
  if (slot === null) return [];

  const dims = ctx.facts.dimNames ?? dimNamesOfBuffer(ctx.text);
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
      range: { line: ctx.range.line, startColumn: slot.start + 1, endColumn: slot.end + 1 },
      sortText: `${exact ? '4' : '5'}_${name}`,
    });
  }
  return items;
}

/* ============================== 详情（provide 时就算：契约没有 resolve 成员） ============================== */

/** `VariableInfo.source` → 名表面可读说法（与宿主同一张措辞表） */
const VARIABLE_SOURCE_LABEL: Readonly<Record<string, string>> = {
  primary: '主名表',
  append: '追加名表',
  const: '具名常量',
};

/** 候选 `detail`（`族` / `族:编号`）里的族头 */
function familyFromDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const head = detail.split(':')[0];
  return head !== undefined && head.length > 0 ? head : undefined;
}

/** 位表摘要（条数多时截断；条名为 adapter 原文） */
function bitsLine(bits: VariableInfo['bits']): string | undefined {
  if (bits === undefined || bits.length === 0) return undefined;
  const shown = bits
    .slice(0, 12)
    .map((b) => `${String(b.bit)} ${b.label}`)
    .join('、');
  return `位表 ${shown}${bits.length > 12 ? ' …' : ''}（共 ${String(bits.length)} 项）`;
}

/**
 * 变量候选的详情：编号 / 说明 / 名表来源 / 位表 / 原生引用（事实全来自 `variableSchema`
 * 与 `dictionary`，一条查不到就不写；一条都没有 ⇒ 不给文档，不编话术）。
 */
function variableDocumentation(facts: EditorCompletionFacts, label: string, detail: string | undefined): string | undefined {
  const family = familyFromDetail(detail) ?? facts.dictionary?.resolveFamily?.(label);
  if (family === undefined) return undefined;
  let entry: VariableInfo | undefined;
  try {
    entry = facts.variableSchema?.names?.(family)?.find((e) => e.name === label);
  } catch {
    entry = undefined;
  }
  const lines: string[] = [];
  if (entry !== undefined) {
    const index: number | string | undefined = entry.index ?? entry.resolvedIndex;
    if (index !== undefined) lines.push(`编号 \`${String(index)}\``);
    if (entry.description !== undefined && entry.description.length > 0) lines.push(entry.description);
    const tier = entry.source === undefined ? undefined : VARIABLE_SOURCE_LABEL[entry.source];
    if (tier !== undefined) lines.push(`来源 ${tier}`);
    const bits = bitsLine(entry.bits);
    if (bits !== undefined) lines.push(bits);
  }
  let native: string | undefined;
  try {
    native = facts.dictionary?.resolve?.(label);
  } catch {
    native = undefined;
  }
  if (native !== undefined && native.length > 0 && native !== label) lines.push(`原生引用 \`${native}\``);
  if (lines.length === 0) return undefined;
  return [`**${label}** · 索引名 \`${family}\``, ...lines].join('\n\n');
}

/** 项目函数候选的详情：调用签名（协议不认 ⇒ 不给文档，不编话术） */
function functionDocumentation(facts: EditorCompletionFacts, label: string): string | undefined {
  const sig = callSignatureLine(label, [label], facts.callProtocol);
  if (sig === undefined) return undefined;
  return [`**${label}** · 项目函数`, sig].join('\n\n');
}

/* ============================== 槽供方 ============================== */

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

/** 门 → 该 source 能否出货（缺键 = 不过滤；`in-string` 由调用方整轮置空） */
function gateAllows(gate: ErbCompletionGate, sourceId: string): boolean {
  const allowed = ERB_GATE_SOURCE_WHITELIST[gate];
  return allowed === undefined || allowed.has(sourceId);
}

/**
 * 应答 `ui.editor.languageService` 的 `completion` 成员——**ERB 补全的唯一产地**。
 *
 * 三态（与 definition / rename 同一条纪律）：
 * - 不是 `completion` 请求 / 不是 ERB 方言 ⇒ `undefined`（**弃权**，让下一家供方接手）；
 * - 认这个位置但一个候选都没有（串内 / 注释内 / 名位前缀不命中）⇒ `{ items: [] }`（**不猜**）；
 * - 有候选 ⇒ 已合并 / 去重 / 排序 / 截断的整表（次序 = 宿主源表的相对次序）。
 *
 * 位置门（{@link erbCompletionGate}）先于一切候选：串内非插值位整轮零候选；`keep` 白名单
 * （{@link ERB_GATE_SOURCE_WHITELIST}）按**来源 id**过滤；点号成员位整轮只留成员源，
 * 而"光标紧前是 `.` 却不是成员位"（`1.|` 的小数点）⇒ 整轮零候选（否则每敲一个小数点
 * 都会弹一次系统函数整表）。
 *
 * 事实输入全在 `request.facts`（adapter 表 / 项目名录 / 宿主词表 / 偏好开关）：
 * 缺哪一份，依赖它的那一路就零候选（不猜、不抛），其余路照常出货。
 */
export function provideErbCompletion(
  request: EditorLanguageServiceRequest,
): EditorCompletionResult | undefined {
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

  // 点号位：落在成员位 ⇒ 整轮只留成员源；紧前是 `.` 但不是成员位 ⇒ 整轮零候选
  const col0 = Math.min(column - 1, line.length);
  let memberOnly = false;
  const memberSlot = erbMemberSlotAt(line, column);
  if (memberSlot !== null && memberSlot.kind === 'member') memberOnly = true;
  else if (col0 > 0 && line[col0 - 1] === '.') return { kind: 'completion', items: [] };

  const range = erbTokenRange(line, column);
  const prefix = line.slice(range.startColumn - 1, range.endColumn - 1);
  const ctx: ErbCompletionContext = {
    line,
    column,
    lineNumber,
    text,
    path,
    range,
    prefix,
    facts: request.facts ?? {},
  };

  const entries: SourcedItem[] = [];
  const add = (sourceId: string, items: EditorCompletionItem[]): void => {
    for (const item of items) entries.push({ item, sourceId });
  };
  const allows = (sourceId: string): boolean => (memberOnly ? sourceId === 'erb-members' : gateAllows(gate, sourceId));

  try {
    if (allows('erb-snippet')) add('erb-snippet', snippetCandidates(ctx));
    if (allows('erb-directives')) add('erb-directives', directiveCandidates(ctx));
    if (allows('erb-variables')) add('erb-variables', variableCandidates(ctx));
    if (allows('erb-functions')) add('erb-functions', functionCandidates(ctx));
    if (allows('erb-labels')) add('erb-labels', labelCandidates(ctx));
    if (allows('erb-system-functions')) add('erb-system-functions', systemFunctionCandidates(ctx));
    if (allows('erb-bits')) add('erb-bits', bitCandidates(ctx));
    if (allows('erb-families')) add('erb-families', erbFamilyCandidates(line, column, lineNumber));
    if (allows('erb-declared')) add('erb-declared', declaredCandidates(ctx));
    if (allows('erb-words')) add('erb-words', wordCandidates(ctx));
    if (allows('erb-members')) add('erb-members', memberCandidates(ctx));
  } catch {
    return { kind: 'completion', items: [] };
  }
// 详情（变量 / 项目函数）在合并前补齐：契约没有 resolve 成员，二段式回表到这里收口。
  const withDocs = entries.map((entry) => {
    if (entry.item.documentation !== undefined) return entry;
    const value =
      entry.sourceId === 'erb-variables'
        ? variableDocumentation(ctx.facts, entry.item.label, entry.item.detail)
        : entry.sourceId === 'erb-functions'
          ? functionDocumentation(ctx.facts, entry.item.label)
          : undefined;
    return value === undefined
      ? entry
      : { ...entry, item: { ...entry.item, documentation: value, documentationFormat: 'markdown' as const } };
  });
  return { kind: 'completion', items: mergeCandidates(withDocs, prefix) };
}


/* ============================== 悬停（ERB-PARITY G1，2026-10-31） ============================== */

/**
 * `.erb` 悬停的**内容判据**（原来是宿主 `monaco/kojo-hover.ts` 的 1–6 路 + `kojo-hover-marks.ts`）。
 *
 * 为什么住本文件而不是新开 `hover.ts`：位槽判据 {@link findBitSlot} 在这里，而 `symbols.ts`
 * 已被本文件 import（反向 import 就是模块环）——悬停要按原优先序把位号那一路夹在指令编号
 * 与函数索引之间，只能与位槽判据同住一枚文件。开机图文件闸 199 是另一条（本批零新增文件）。
 *
 * ## 六路优先序（**一个字都没改**，搬家前在 `kojo-hover.ts` 的 `resolveHoverNameCore`）
 *
 * 1 变量索引 `CFLAG:TARGET:1088` → 中文名（adapter 字典）；
 * 2 原生函数名（系统表反向优先，再查 adapter 基础库表）；
 * 3 指令编号（**只在糖的 `时机 <分野> <编号>：` 块头里认**——上下文正则由调用方注入，
 *   `.erb` 悬停不注入 ⇒ 这一路对 `.erb` 不产结果，与搬家前逐字一致：`.erb` 里没有这种块头）；
 * 4 位号（`GETBIT` 四种原语的第二实参，adapter `VariableInfo.bits`）；
 * 5 项目函数索引（`ErbIndex.byName`：docComment + 形参签名 + 定义位置）；
 * 5.5 本文件 `#DIM` 声明（声明处 + 声明原文 + 初值；同文件重名取最近，形参遮蔽同名变量）；
 * 6 原生标记分类（`{`/`}` 行连接、`[IF …]` 预处理、`#DIM` 族、行首大写语句 / 族头）。
 *
 * 宿主那侧只保留两条**糖面**事实（`.kojo1` 独有、`.erb` 不出现）：载体注册壳前缀提示与
 * 中文 → 原生形态反查；它们住在 `monaco/kojo-hover.ts` 与 `kojo-hover-native.ts`。
 *
 * ## 纪律（与搬家前同一条）
 *
 * 查不到 ⇒ `undefined`（不猜）；纯函数（不读盘、不写盘、不发事件）；表全部可选，
 * 缺席只让那一路闭嘴。
 */

/** 悬停解析所需的表（全部可选；缺席 = 该路不产结果，**不猜**） */
export interface ErbHoverTables {
  /** 变量字典（adapter `variableSchema` → `makeLookup`） */
  readonly dictionary?: DictionaryLookup;
  /** 基础库 / 常用函数名表（adapter） */
  readonly libraryTable?: KojoLibraryTable;
  /** 指令名表（adapter）；只在注入 {@link timingPrefixRe} 时可达 */
  readonly instructionTable?: KojoInstructionTable;
  /** adapter 变量 schema 本体（位名反查用） */
  readonly variableSchema?: VariableSchema;
  /** 项目函数索引通道（**每次悬停现取**：索引随项目开闭重建，缓存会带来脏索引） */
  readonly erbIndex?: () => ErbIndex | null | undefined;
  /** 指令编号的上下文（`时机 <分野> <编号>：` 块头）；缺席 = 第 3 路不产结果 */
  readonly timingPrefixRe?: RegExp;
  /** 「这一行是原生直通行吗」（糖面才需要）；缺席 = 按原生行处理（`.erb` 恒为此） */
  readonly isRawLine?: (lineText: string) => boolean;
}

/** 悬停命中（1 基列区间，供宿主画浮层范围） */
export interface ErbHoverHit {
  readonly name: string;
  readonly kind: string;
  readonly startColumn: number;
  readonly endColumn: number;
  /** 附加正文行：docComment / 形参签名 / 定义位置 / 声明原文 …（每行一个 markdown 块） */
  readonly lines?: readonly string[];
  /** 声明 / 定义的**源坐标**（派生预览面上列属于显示面，这条永远指回源文件） */
  readonly source?: { readonly filePath: string; readonly line: number };
}

/** 悬停所在的**显示面**事实（`.kojo1` 糖投影用；`.erb` 恒源面） */
export interface ErbHoverSurface {
  readonly line?: number;
  readonly derived?: boolean;
  readonly readSourceLine?: (line: number) => string | undefined;
}

const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** 变量引用：`族名` + 至少一段 `:段` */
const REF_RE = /^([A-Za-z][A-Za-z0-9_]*):(.+)$/;

/** 命中光标（含其左右邻接同类字符）的最长一段（`col0` = 0 基字符下标；无同类字符返回 null） */
function spanAround(
  line: string,
  col0: number,
  isChar: (ch: string) => boolean,
): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (col0 < line.length && isChar(line[col0]!)) {
    start = col0;
    end = col0 + 1;
  } else if (col0 > 0 && isChar(line[col0 - 1]!)) {
    start = col0 - 1;
    end = col0;
  } else {
    return null;
  }
  while (start > 0 && isChar(line[start - 1]!)) start--;
  while (end < line.length && isChar(line[end]!)) end++;
  return { start, end };
}

/**
 * 解析光标下的悬停事实（**纯函数**）。`column` = Monaco 的 1 基列；
 * `filePath` / `surface` 只服务 `#DIM` 那一路（派生预览面上行号不是源行号）。
 */
export function resolveErbHoverAt(
  lineText: string,
  column: number,
  tables: ErbHoverTables,
  filePath: string | null = null,
  surface: ErbHoverSurface = {},
): ErbHoverHit | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  // 1) 数值变量索引（具名索引 `description == 索引` 时等于回显，无增益 → 跳过）
  const refSpan = spanAround(lineText, col0, isRefChar);
  if (refSpan) {
    const token = lineText.slice(refSpan.start, refSpan.end);
    const m = REF_RE.exec(token);
    if (m) {
      const family = m[1]!;
      const segs = m[2]!.split(':');
      const index = segs[segs.length - 1]!;
      const name = tables.dictionary?.nameAt?.(family, index);
      if (name !== undefined && name.length > 0 && name !== index) {
        return {
          name,
          kind: `变量 · ${token}`,
          startColumn: refSpan.start + 1,
          endColumn: refSpan.end + 1,
        };
      }
    }
  }

  // 2) 原生函数名（ASCII 记号；中文词在这一路必然判不出记号——那是反查表的键形状）
  const fnToken = symbolTokenAt(lineText, col0 + 1);
  if (fnToken) {
    const cn = SYSTEM_FUNCTION_REVERSE.get(fnToken.text) ?? tables.libraryTable?.lookupByFunction?.(fnToken.text);
    if (cn !== undefined && cn.length > 0 && !echoYieldsToIndex(cn, fnToken.text, tables)) {
      return { name: cn, kind: `函数 · ${fnToken.text}`, startColumn: fnToken.startColumn, endColumn: fnToken.endColumn };
    }
  }

  // 3) 指令编号：只在可证明的块头里认（上下文正则由调用方注入；不注入 = 这一路闭嘴）
  const timingRe = tables.timingPrefixRe;
  if (timingRe !== undefined && tables.instructionTable) {
    const digitSpan = spanAround(lineText, col0, isDigit);
    if (digitSpan) {
      const token = lineText.slice(digitSpan.start, digitSpan.end);
      if (timingRe.test(lineText.slice(0, digitSpan.start))) {
        const cn = tables.instructionTable.lookupByNo(Number(token));
        if (cn !== undefined && cn.length > 0) {
          return {
            name: cn,
            kind: `指令 · 编号 ${token}`,
            startColumn: digitSpan.start + 1,
            endColumn: digitSpan.end + 1,
          };
        }
      }
    }
  }

  // 4) 位号：只在可证明的位槽里认；查不到位表一律不显示
  const bit = erbBitHoverName(lineText, column, tables.variableSchema);
  if (bit !== undefined) {
    return { name: bit.name, kind: `位号 · ${bit.bit}`, startColumn: bit.startColumn, endColumn: bit.endColumn };
  }

  // 5) ERB 函数定义（docComment + 形参签名 + 定义位置；定义行与调用点同词同命中）
  const erbFn = resolveErbFunctionHover(lineText, column, tables.erbIndex);
  if (erbFn !== undefined) return erbFn;

  // 5.5) 本文件 `#DIM` 声明（声明处 + 声明原文 + 初值；同文件重名取最近的声明）
  const erbDim = resolveErbDimHover(lineText, col0, tables.erbIndex, filePath, surface);
  if (erbDim !== undefined) return erbDim;

  // 6) 原生标记分类（`[IF …]` / `#DIM` / `{` `}` / 行首大写 ERB 语句）
  return resolveErbMarkHover(lineText, column, tables);
}

/**
 * 函数索引通道的**唯一**取法：缺席 / 未建 / 求值抛错 ⇒ `null`（不猜、fail-open）。
 */
function erbIndexOf(getIndex: (() => ErbIndex | null | undefined) | undefined): ErbIndex | null {
  if (typeof getIndex !== 'function') return null;
  try {
    return getIndex() ?? null;
  } catch {
    return null;
  }
}

/** 「项目函数索引认不认这个名字」的唯一查询（第 2 路的裁决与第 5 路共用） */
function erbDefsOf(index: ErbIndex, upper: string): ErbFunctionRef[] | undefined {
  // 列式 `byName`（MEM-19）：`defsOf` = 旧写法 `byName.get(n) ?? []` 的同一枚
  const defs = index.byName.defsOf(upper);
  return defs.length === 0 ? undefined : defs;
}

/**
 * 第 2 路与第 5 路的**优先序裁决**（一条判据一枚函数）：库表那条只是**回显**
 * （中文名 === 原生名）时让位给函数索引——回显给不出 docComment / 签名 / 定义位；
 * 库表给的是**真翻译**（两个名字不同）时库表先答（实测语料 471 条里 458 条是真翻译）。
 */
function echoYieldsToIndex(cn: string, token: string, tables: ErbHoverTables): boolean {
  if (cn !== token) return false;
  const index = erbIndexOf(tables.erbIndex);
  return index !== null && erbDefsOf(index, token.toUpperCase()) !== undefined;
}

/** ERB 函数路：光标词 ∈ `byName`（归一大写）⇒ docComment + 形参签名 + 定义位置 */
function resolveErbFunctionHover(
  lineText: string,
  column: number,
  getIndex: (() => ErbIndex | null | undefined) | undefined,
): ErbHoverHit | undefined {
  const index = erbIndexOf(getIndex);
  if (index === null) return undefined;
  const span = unicodeTokenAt(lineText, column);
  if (!span) return undefined;
  const defs = erbDefsOf(index, span.text.toUpperCase());
  if (defs === undefined) return undefined;

  const def = defs[0]!;
  const lines: string[] = [];
  if (def.docComment !== undefined && def.docComment.length > 0) {
    lines.push(...def.docComment.split('\n').filter((l) => l.trim().length > 0));
  }
  const file = index.files.get(def.filePath);
  const fn = file?.functions.find((f) => f.normalizedName === def.normalizedName && f.startLine === def.startLine);
  if (fn && fn.params.length > 0) {
    lines.push(`\`${def.name}(${fn.params.map((p) => p.name).join(', ')})\``);
  }
  lines.push(`定义于 \`${def.filePath}:${def.startLine}\``);
  if (defs.length > 1) lines.push(`另有 ${defs.length - 1} 处同名定义`);

  return {
    name: def.name,
    kind: 'ERB 函数',
    startColumn: span.startColumn,
    endColumn: span.endColumn,
    lines,
    source: { filePath: def.filePath, line: def.startLine },
  };
}

/** 索引里的声明名可能带数组后缀；悬停按**裸名**匹配与显示（`[10]` 是规模，不是名字） */
function bareDimNameOf(name: string): string {
  return name.replace(/\[[^\]]*\]$/, '');
}

/** 索引里的一份文件（只取悬停用得到的字段） */
type IndexedErbFile = {
  readonly path: string;
  readonly dims?: readonly ErbDim[];
  readonly functions?: readonly ErbFunction[];
};

/** 源行号（1 基、有限、≥1）；派生面 / 缺省 / 坏值 ⇒ `null`（不猜） */
function sourceLineOf(line: number | undefined): number | null {
  return typeof line === 'number' && Number.isFinite(line) && line >= 1 ? Math.trunc(line) : null;
}

/** 光标行落在哪个函数里（多个命中取最内层 = 起点最大的那个）；不在任何函数里 ⇒ `undefined` */
function enclosingFunctionOf(functions: readonly ErbFunction[], line: number): ErbFunction | undefined {
  let best: ErbFunction | undefined;
  for (const fn of functions) {
    if (line < fn.startLine || line > fn.endLine) continue;
    if (best === undefined || fn.startLine > best.startLine) best = fn;
  }
  return best;
}

/** 同名声明的**最近一条**：当前函数内优先 → 函数外文件级 → 全文件行距（`null` = 索引首条） */
function nearestDimOf(dims: readonly ErbDim[], functions: readonly ErbFunction[], useLine: number | null): ErbDim {
  if (dims.length === 1 || useLine === null) return dims[0]!;
  const scope = enclosingFunctionOf(functions, useLine);
  if (scope !== undefined) {
    const inside = dims.filter((d) => d.line >= scope.startLine && d.line <= scope.endLine);
    if (inside.length > 0) return nearestByLine(inside, useLine);
    const outside = dims.filter((d) => enclosingFunctionOf(functions, d.line) === undefined);
    if (outside.length > 0) return nearestByLine(outside, useLine);
  }
  return nearestByLine(dims, useLine);
}

/** 行距最近（同距时取**声明在前**的那条；之前没有才取之后最早的一条） */
function nearestByLine(dims: readonly ErbDim[], useLine: number): ErbDim {
  let best = dims[0]!;
  for (const d of dims) {
    const beforeD = d.line <= useLine;
    const beforeBest = best.line <= useLine;
    if (beforeD !== beforeBest) {
      if (beforeD) best = d;
      continue;
    }
    if (beforeD ? d.line > best.line : d.line < best.line) best = d;
  }
  return best;
}

/** 读源文件某一行（读腿抛错 / 非字符串一律当读不到） */
function readSourceRow(
  read: ((line: number) => string | undefined) | undefined,
  line: number,
): string | undefined {
  if (read === undefined) return undefined;
  try {
    const text = read(line);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 声明行原文（**校验它确实声明了同名变量**）：行号对不上 / 不是 `#DIM*` 行 / 名字不同
 * ⇒ `undefined`（不拿别的声明冒充）。超长行截断（悬停块不是正文阅读器）。
 */
function declarationTextOf(line: string | undefined, name: string): string | undefined {
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: { directive: string; name: string } | null;
  try {
    parsed = parseDimDeclaration(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null) return undefined;
  const bare = parsed.name.replace(/\[[^\]]*\]$/, '');
  if (bare.toUpperCase() !== name.toUpperCase()) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

/**
 * 声明行里 `=` 之后的初值（去掉引号外的 `;` 注释尾巴）；数组规模不算初值。
 * 读不出 / 为空 ⇒ `undefined`（不写「初值：空」这种假事实）。
 */
function initializerOfDimLine(line: string, name: string): string | undefined {
  const head = /^#[A-Za-z]+/.exec(line);
  const from = head === null ? 0 : head[0].length;
  const at = line.toLowerCase().indexOf(name.toLowerCase(), from);
  if (at < 0) return undefined;
  let rest = line.slice(at + name.length);
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return undefined;
    rest = rest.slice(close + 1);
  }
  const eq = rest.indexOf('=');
  if (eq < 0) return undefined;
  const value = stripUnquotedComment(rest.slice(eq + 1)).trim();
  return value.length === 0 ? undefined : value;
}

/** 去掉第一个**引号外**的 `;` 及其后内容（ERB 注释；字符串里的 `;` 不算） */
function stripUnquotedComment(text: string): string {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inStr = !inStr;
    else if (ch === ';' && !inStr) return text.slice(0, i);
  }
  return text;
}

/**
 * `#DIM` 声明名悬停：先按路径归一（分隔符 / 大小写）找到当前文件，再在 `dims` 里按
 * 大小写不敏感整词匹配。文件不在索引 / 索引缺席 / 词不是声明名 ⇒ `undefined`（不猜）。
 * 名字字符集用 `symbols.ts` 的 `isErbDimNameChar`（声明名可带冒号 / 括号等，比函数记号集宽）。
 */
function resolveErbDimHover(
  lineText: string,
  col0: number,
  getIndex: (() => ErbIndex | null | undefined) | undefined,
  filePath: string | null,
  surface: ErbHoverSurface = {},
): ErbHoverHit | undefined {
  if (!filePath) return undefined;
  const index = erbIndexOf(getIndex);
  if (index === null) return undefined;
  const span = spanAround(lineText, col0, isErbDimNameChar);
  if (!span) return undefined;
  const token = lineText.slice(span.start, span.end);
  if (token.length === 0) return undefined;
  const key = normalizePathKey(filePath);
  let file: IndexedErbFile | undefined;
  for (const [p, f] of index.files) {
    if (normalizePathKey(p) === key) {
      file = f as IndexedErbFile;
      break;
    }
  }
  if (!file) return undefined;
  const want = token.toUpperCase();
  // 派生面的行号是**显示面**坐标，不是源行号 ⇒ 不参与作用域与「最近」判定
  const useLine = surface.derived === true ? null : sourceLineOf(surface.line);

  // 函数形参遮蔽同名变量（只在源面可判）
  if (useLine !== null) {
    const fn = enclosingFunctionOf(file.functions ?? [], useLine);
    const param = fn?.params.find((p) => p.name.toUpperCase() === want);
    if (fn !== undefined && param !== undefined) {
      return {
        name: param.name,
        kind: '函数形参',
        startColumn: span.start + 1,
        endColumn: span.end + 1,
        lines: [`所在函数：\`@${fn.name}\``, `形参声明于 \`${file.path}:${fn.startLine}\``],
        source: { filePath: file.path, line: fn.startLine },
      };
    }
  }

  const dims = (file.dims ?? []).filter((d) => bareDimNameOf(d.name).toUpperCase() === want);
  if (dims.length === 0) return undefined;
  const dim = nearestDimOf(dims, file.functions ?? [], useLine);
  const dimName = bareDimNameOf(dim.name);
  const lines: string[] = [`声明于 \`${file.path}:${dim.line}\``];
  // 值 / 类型「若可判」：只在**源文件**那一行读（读不到 / 不同名 ⇒ 只给落点，不编值）
  const raw = declarationTextOf(readSourceRow(surface.readSourceLine, dim.line), dimName);
  if (raw !== undefined) {
    lines.push(`声明：\`${raw}\``);
    const init = initializerOfDimLine(raw, dimName);
    if (init !== undefined) lines.push(`初值：\`${init}\``);
  }
  if (dims.length > 1) {
    const others = dims
      .filter((d) => d !== dim)
      .map((d) => d.line)
      .sort((a, b) => a - b);
    lines.push(`另有 ${others.length} 处同名声明（第 ${others.join('、')} 行）`);
  }
  return {
    name: dimName,
    kind: `#${dim.directive} 声明`,
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    lines,
    source: { filePath: file.path, line: dim.line },
  };
}

/**
 * 位号悬停（D7）：光标下**位槽里的位号** → 中文位名（adapter `VariableInfo.bits`）。
 * 返回 `undefined` = 非位槽 / 光标不在数字上 / 查不到位表 / 位号不在表内（不猜）。
 */
export function erbBitHoverName(
  lineText: string,
  column: number,
  schema: VariableSchema | undefined,
): { readonly name: string; readonly bit: number; readonly startColumn: number; readonly endColumn: number } | undefined {
  if (!schema) return undefined;
  const slot = findBitSlot(lineText, column);
  if (slot === null) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  let start = col0;
  while (start > slot.regionStart && isDigit(lineText[start - 1]!)) start--;
  let end = col0;
  while (end < slot.regionEnd && isDigit(lineText[end]!)) end++;
  if (start === end) return undefined;
  const token = lineText.slice(start, end);
  if (!/^\d+$/.test(token)) return undefined;

  const bits = resolveErbBitLabels(schema, slot.variableRef);
  if (bits === undefined) return undefined;
  const bit = Number(token);
  const entry = bits.find((b) => b.bit === bit);
  if (entry === undefined) return undefined;
  return { name: entry.label, bit, startColumn: start + 1, endColumn: end + 1 };
}

/**
 * 把第一实参变量引用解析成 `VariableInfo.bits`：族 = 第一个冒号前段，索引 = **最后一个**
 * 冒号后段（三段式 `族:角色:名` 的中段是角色表达式，名字在末段；adapter 只按单段名查表）。
 */
export function resolveErbBitLabels(
  schema: VariableSchema,
  variableRef: string,
): ReadonlyArray<{ bit: number; label: string }> | undefined {
  if (variableRef.length === 0) return undefined;
  const first = variableRef.indexOf(':');
  const last = variableRef.lastIndexOf(':');
  const name = first < 0 ? variableRef : variableRef.slice(0, first);
  const index = last < 0 ? undefined : variableRef.slice(last + 1);
  let bits: ReadonlyArray<{ bit: number; label: string }> | undefined;
  try {
    bits = schema.lookup(name, index)?.bits;
  } catch {
    return undefined;
  }
  return bits !== undefined && bits.length > 0 ? bits : undefined;
}

const DECLARATION_SET: ReadonlySet<string> = new Set(ERB_DECLARATION_DIRECTIVES.map((w) => w.toUpperCase()));
const DIRECTIVE_SET: ReadonlySet<string> = new Set(ERB_STATEMENT_DIRECTIVES.map((w) => w.toUpperCase()));
const FAMILY_SET: ReadonlySet<string> = new Set(ENGINE_VARIABLE_FAMILIES);

/** 行首（缩进之后）第一个字符的 0 基下标 */
function firstNonBlank(line: string): number {
  const m = /^[ \t\u3000]*/.exec(line);
  return m === null ? 0 : m[0].length;
}

/**
 * 原生标记分类（v1.9 P2「悬停」面）：只回答"这是什么"，不给逐词文档，也不抢前五路的事实。
 * 判据全部来自单源：预处理 / 行连接角色 = 契约 `erb.ts`；声明族与语句词表 = `./instructions.ts`。
 */
export function resolveErbMarkHover(
  lineText: string,
  column: number,
  tables: ErbHoverTables = {},
): ErbHoverHit | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  const col0 = Math.min(column - 1, lineText.length);
  const trimmed = lineText.trim();
  if (trimmed.length === 0) return undefined;

  // 1) `{` / `}` 行连接标记（整行严格等值）
  if (erbContinuationRoleOf(trimmed) !== null) {
    const start = firstNonBlank(lineText);
    if (col0 !== start) return undefined; // 只认标记字符本身
    const mark = lineText.slice(start, start + 1);
    return {
      name: `行连接标记 ${mark}`,
      kind: '引擎记号 · 行连接',
      startColumn: start + 1,
      endColumn: start + 2,
      lines: [
        `引擎把 \`${ERB_CONTINUATION_MARKERS.open}\` … \`${ERB_CONTINUATION_MARKERS.close}\` 之间的物理行拼成一条逻辑行。`,
      ],
    };
  }

  // 2) 预处理标记 `[IF …]` 族（整行严格等值）
  if (erbPreprocRoleOf(trimmed) !== null) {
    const start = firstNonBlank(lineText);
    if (col0 < start) return undefined;
    return {
      name: trimmed,
      kind: '预处理标记',
      startColumn: start + 1,
      endColumn: Math.min(lineText.length, start + trimmed.length) + 1,
      lines: [
        '整行严格等值（大小写不敏感），引擎按文件级裁剪。',
        '糖形写法：`预处理 如果 <宏>：` … `预处理结束`（回读为同一批标记）。',
      ],
    };
  }

  const token = unicodeTokenAt(lineText, column);
  if (token === null) return undefined;
  const upper = token.text.toUpperCase();

  // 3) `#` 声明族（`#DIM` / `#FUNCTION` …）
  const prefix = lineText.slice(0, token.startColumn - 1);
  if (prefix.trimEnd().endsWith('#')) {
    if (!DECLARATION_SET.has(upper)) return undefined;
    return {
      name: `#${upper}`,
      kind: 'ERB 声明',
      startColumn: token.startColumn - 1,
      endColumn: token.endColumn,
      lines: ['文件级 / 返回类型声明：逐字节直通，不拆中文写形。'],
    };
  }

  // 4) 行首大写词：ERB 语句 / 引擎族头（糖区行必须让位给台词里的普通大写词）
  if (token.startColumn - 1 !== firstNonBlank(lineText)) return undefined;
  const rawLine = tables.isRawLine === undefined ? true : tables.isRawLine(lineText);
  if (!rawLine) {
    if (!FAMILY_SET.has(upper)) return undefined;
    return {
      name: upper,
      kind: '引擎族头',
      startColumn: token.startColumn,
      endColumn: token.endColumn,
      lines: ['引擎变量族头（`族:段:…` 引用形态）。'],
    };
  }
  if (!DIRECTIVE_SET.has(upper)) return undefined;
  return {
    name: upper,
    kind: 'ERB 语句',
    startColumn: token.startColumn,
    endColumn: token.endColumn,
    lines: ['原生 ERB 语句（整行直通，不拆糖形）。'],
  };
}

/**
 * 悬停正文的 markdown 拼装（**唯一一份**）：首块是 `**名字**（档位）`，其余每条附加行
 * 各成一段（`\n\n` 分隔）。宿主只把它塞进 `contents`，不另拼一份。
 */
export function erbHoverMarkdown(hit: ErbHoverHit): string {
  return [`**${hit.name}**（${hit.kind}）`, ...(hit.lines ?? [])].join('\n\n');
}

/** 悬停供方从 adapter 现取的**静态面**（与宿主 `editorTables` 同一判据：按项目 adapterId 精确匹配） */
export interface ErbHoverAdapterFacts {
  readonly dictionary?: DictionaryLookup;
  readonly variableSchema?: VariableSchema;
  readonly libraryTable?: KojoLibraryTable;
}

/**
 * 槽 `ui.editor.languageService` 的 `hover` 供方（ERB）。
 *
 * 三态：非 ERB 方言 ⇒ `undefined`（弃权，下一家接手）；ERB 但六路都没事实 ⇒ `undefined`
 * （**不是**空串——空串＝作答，会把 `.kojo1` 那套 v1 糖面悬停顶掉）；有事实 ⇒ 一条
 * `format: 'markdown'` 的作答。
 *
 * 数据源全部由调用方注入（`index` = 本包索引；`adapterTables` = 宿主侧那几张 adapter 表，
 * 经 `game.adapter` 槽现取）——本函数不读盘、不碰项目生命周期，纯到可单测。
 */
export function provideErbHover(
  request: EditorHoverRequest,
  deps: {
    readonly index: () => ErbIndex | null;
    readonly adapterTables?: () => ErbHoverAdapterFacts;
  },
): EditorHoverResult | undefined {
  try {
    if (!isErbDialectPath(request.path)) return undefined;
    const lines = request.text.replace(/\r\n?/g, '\n').split('\n');
    const lineText = lines[request.line - 1] ?? '';
    const facts = deps.adapterTables === undefined ? {} : deps.adapterTables();
    const hit = resolveErbHoverAt(
      lineText,
      request.column,
      { ...facts, erbIndex: deps.index },
      request.path,
      { line: request.line, derived: false, readSourceLine: (n) => lines[n - 1] },
    );
    if (hit === undefined) return undefined;
    return {
      kind: 'hover',
      contents: erbHoverMarkdown(hit),
      format: 'markdown',
      range: { line: request.line, startColumn: hit.startColumn, endColumn: hit.endColumn },
    };
  } catch {
    return undefined;
  }
}
