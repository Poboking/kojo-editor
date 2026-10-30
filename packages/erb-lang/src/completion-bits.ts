/**
 * ERB 位槽的**行内扫描件**（`@kojo/erb-lang/completion-bits`）。
 *
 * ## 这里为什么只有"在哪"而没有"给什么"
 *
 * 位原语（`GETBIT` / `SETBIT` / `CLEARBIT` / `INVERTBIT`）的第二实参坑，是补全位置门
 * 九态之一（`bit-slot`）的判定输入——**"光标是不是停在一个空着的位坑里"是语言事实**，
 * 而"坑里该弹哪些位号"要读 adapter 变量表（宿主事实）。故本叶子只留判据：
 * 区域切法 / 空槽判定 / 括号与顶层逗号扫描。
 *
 * 候选装配（`VariableInfo.bits` → Monaco 条目）仍在宿主
 * `app/src/monaco/erb-completion-bits.ts`——那是形状翻译，不含新判据。
 *
 * ## 切法口径（与搬进本包之前逐字相同）
 *
 * - 表达式形 `GETBIT(变量, 位)`：第二实参 = 顶层逗号之后到右括号之前；
 * - 语句形 `SETBIT 变量, 位`：第二实参 = 顶层逗号之后到行尾（`GETBIT` 只有表达式形，
 *   裸写 `GETBIT 变量, 位` 引擎不认 ⇒ 不认）；
 * - 第一实参原文 `trim` 后交回（族 / 索引的段切法由消费方决定）；
 * - 注释行（`^\s*;`）/ 光标所在串引号未配平 ⇒ 不是可判定的实参位（`null`）。
 *
 * `matchingParen` / `topLevelComma` 是这一族判据的共用扫描件（位置门与候选门都吃它）：
 * 抄第二份就必然在"括号里带引号"这类输入上漂移。
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

/**
 * `text[open]` 是 `(`，返回与之配对的 `)` 下标；不配平 ⇒ `-1`。
 * 引号内的括号不计数（串里是字面量）。
 */
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

/**
 * `[from, to)` 内**顶层**（括号 / 方括号深度 0）的第一个逗号；无 → -1。
 * 引号内的逗号不计数；遇到顶层右括号视为区间提前结束。
 */
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
 * 解析光标所在的**位槽**（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * 返回 `null` = 该处不是任何位原语的第二实参坑（**不猜**：注释行 / 字符串内 / 无逗号 /
 * 括号未闭合 / 光标不在第二实参区间内，一律不认）。区间"空不空"由调用方各自判定
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
 * 位槽第二实参区间是否**为空**（纯空白）——位置门（`erbBitSlotOpen`）与候选门
 * （宿主的 `erbBitCompletionItems`）共用的**唯一**判据真源（**禁止两处各写**）。
 */
export function erbBitSlotRegionBlank(lineText: string, slot: ErbBitSlot): boolean {
  return lineText.slice(slot.regionStart, slot.regionEnd).trim().length === 0;
}

/**
 * `lineText` 上 `column`（1 基列）处是否是一个**待命中的位槽**：落在四种位原语的
 * 第二实参坑内 **且** 该坑此刻为空（纯空白）。位置门 / 触发探针消费（签名定死）；
 * 判据与补全候选同源——非空槽 / 内容槽一律 false（作者写了位号或变量就不打扰）。
 */
export function erbBitSlotOpen(lineText: string, column: number): boolean {
  const slot = findBitSlot(lineText, column);
  return slot !== null && erbBitSlotRegionBlank(lineText, slot);
}