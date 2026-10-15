import type * as Monaco from 'monaco-editor';
import type { VariableSchema } from '@kojo/plugin-api';

/**
 * D7 · `.erb` 正文里的**位补全 + 位名悬停**。
 *
 * Emuera 位原语**四件套**（位号可为数字，也可为变量，实证 `GETBIT(HOLD, LOCAL)`）：
 * - 表达式形：`GETBIT(变量, 位)`（第二实参坑）；
 * - 语句形（无括号）：`SETBIT 变量, 位` / `CLEARBIT 变量, 位` / `INVERTBIT 变量, 位`
 *   （逗号之后）。
 * `CHECKBIT` 不存在——不认（**不猜**）。
 *
 * 候选 = 第一实参变量在 `VariableSchema` 里的 `VariableInfo.bits`
 * （`ReadonlyArray<{ bit: number; label: string }>`，契约槽位见 `@kojo/plugin-api`）。
 * 位表由 adapter 提供；本层**只读不解释**、**零产出即零候选**（表缺席 / 无位表 ⇒ `[]`，
 * 绝不静默生成假位号）。
 *
 * 位置判据（严格，**严禁**泛化成「任意逗号后就是位」）：命中时还须满足
 * ①光标落在**该原语的第二实参区间内**；②该区间此刻**为空**（纯空白）——作者一旦写了
 * 内容（含把位号写成变量 `LOCAL`）就**不抢候选**（作者写变量不得被打扰）。
 *
 * 与既有各 source 同纪律：纯函数 + 薄 Monaco 翻译、只读模型、不产生编辑、不发事件；
 * provider 注册不在本模块——编排层把它接进补全基座（`erb-completion.ts`）与悬停基座
 * （`kojo-hover.ts`）。
 */

/** 位原语单字 → 语句形（无括号）还是表达式形（带括号） */
const BIT_PRIMITIVES = /\b(GETBIT|SETBIT|CLEARBIT|INVERTBIT)\b/gi;

/** 位槽（第二实参坑）的位置描述（0 基列区间，`slice` 起止） */
export interface ErbBitSlot {
  /** 第一实参（变量引用）原文（已 `trim`） */
  readonly variableRef: string;
  /** 第二实参区间起点（0 基，含） */
  readonly regionStart: number;
  /** 第二实参区间终点（0 基，不含） */
  readonly regionEnd: number;
}

/** 位名悬停命中（1 基列区间，供 hover 高亮） */
export interface ErbBitHoverHit {
  /** 中文位名（`VariableInfo.bits[].label` 原文） */
  readonly name: string;
  /** 位号 */
  readonly bit: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** 从 `open` 处的 `(` 找出配对的 `)`（跳过字符串字面量；未闭合 → -1） */
function matchingParen(text: string, open: number): number {
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
function topLevelComma(text: string, from: number, to: number): number {
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
 * 解析光标所在的**位槽**（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * 返回 `null` = 该处不是任何位原语的第二实参坑（**不猜**：注释行 / 字符串内 / 无逗号 /
 * 括号未闭合 / 光标不在第二实参区间内，一律不认）。区间是"空是"由调用方各自判定
 * （补全要求空槽；悬停要求位号）。
 */
export function findBitSlot(lineText: string, column: number): ErbBitSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, lineText.length);

  // 注释行 / 光标落在字符串字面量里 → 不是可判定的实参位
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
      // 表达式形 `GETBIT(变量, 位)`
      const close = matchingParen(lineText, p);
      if (close < 0) continue;
      const comma = topLevelComma(lineText, p + 1, close);
      if (comma < 0) continue;
      regionStart = comma + 1;
      regionEnd = close;
      refStart = p + 1;
      refEnd = comma;
    } else if (kw !== 'GETBIT') {
      // 语句形 `SETBIT/CLEARBIT/INVERTBIT 变量, 位`
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

/**
 * 把第一实参变量引用解析成 `VariableInfo.bits`（**纯函数**；`族:索引` 或裸族名）。
 * 查不到 / 无位表 / 抛错 ⇒ `undefined`（**不猜**，绝不静默造位号）。
 */
function resolveBits(
  schema: VariableSchema,
  variableRef: string,
): ReadonlyArray<{ bit: number; label: string }> | undefined {
  if (variableRef.length === 0) return undefined;
  const colon = variableRef.indexOf(':');
  const name = colon < 0 ? variableRef : variableRef.slice(0, colon);
  const index = colon < 0 ? undefined : variableRef.slice(colon + 1);
  let bits: ReadonlyArray<{ bit: number; label: string }> | undefined;
  try {
    bits = schema.lookup(name, index)?.bits;
  } catch {
    return undefined;
  }
  return bits !== undefined && bits.length > 0 ? bits : undefined;
}

/**
 * 产出位槽的补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在四种位原语的第二实参坑、且该坑**为空**（纯空白）时，取第一实参
 * 变量在 `schema` 里的 `bits`，逐位产出候选——`label` = `位号 中文位名`、`insertText` = 位号、
 * `kind` = `EnumMember`、`documentation` = 中文位名、`detail` = 变量引用原文。
 * 非位槽 / 坑内有内容（含写成变量）/ 无位表 / `schema` 缺省 ⇒ `[]`（不猜、不抛）。
 */
export function erbBitCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  schema: VariableSchema | undefined,
): Monaco.languages.CompletionItem[] {
  if (!schema) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];

  const line = model.getLineContent(position.lineNumber);
  const slot = findBitSlot(line, position.column);
  if (slot === null) return [];
  // 位坑已有内容（作者写了位号 / 写成变量 `LOCAL`）⇒ 不抢候选（不打扰作者写变量）
  if (line.slice(slot.regionStart, slot.regionEnd).trim().length > 0) return [];

  const bits = resolveBits(schema, slot.variableRef);
  if (bits === undefined) return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: position.column,
    endColumn: position.column,
  };
  const items: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const b of bits) {
    const label = `${b.bit} ${b.label}`;
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({
      label,
      kind: monaco.languages.CompletionItemKind.EnumMember,
      insertText: String(b.bit),
      detail: slot.variableRef,
      documentation: b.label,
      range,
      sortText: `${String(b.bit).padStart(4, '0')}_${label}`,
    });
  }
  return items;
}

/**
 * 解析光标下**位槽里的位号** → 中文位名（**纯函数**，供悬停基座调用）。
 *
 * 返回 `undefined` = 该处没有可显示的位名（**不猜**：非位槽 / 光标不在数字上 /
 * 第一实参变量查不到位表 / 位号不在表内，一律不显示）。
 */
export function erbBitHoverName(
  lineText: string,
  column: number,
  schema: VariableSchema | undefined,
): ErbBitHoverHit | undefined {
  if (!schema) return undefined;
  const slot = findBitSlot(lineText, column);
  if (slot === null) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  // 光标所在（或紧邻）的**数字串**，须整体落在位槽区间内
  let start = col0;
  while (start > slot.regionStart && isDigit(lineText[start - 1]!)) start--;
  let end = col0;
  while (end < slot.regionEnd && isDigit(lineText[end]!)) end++;
  if (start === end) return undefined;
  const token = lineText.slice(start, end);
  if (!/^\d+$/.test(token)) return undefined;

  const bits = resolveBits(schema, slot.variableRef);
  if (bits === undefined) return undefined;
  const bit = Number(token);
  const entry = bits.find((b) => b.bit === bit);
  if (entry === undefined) return undefined;
  return { name: entry.label, bit, startColumn: start + 1, endColumn: end + 1 };
}
