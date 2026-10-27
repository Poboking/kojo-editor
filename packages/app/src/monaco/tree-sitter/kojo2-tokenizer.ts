/**
 * Kojo 2.0 的 **capture → Monaco 区间** 翻译层（纯函数；不认识 Monarch，也不碰 wasm）。
 *
 * 输入是 `queries/v2/highlights.scm` 的捕获（裸 `{ name, startPosition, endPosition }`），
 * 输出是 Monaco 语义 token provider 直接可吃的
 * `{ line, startColumn, endColumn, tokenType }[]`：**1 基行 / 1 基列 / endColumn 排他**。
 * 坐标系只有这一处转换（tree-sitter 是 0 基行列），provider 那边不许再改口径。
 *
 * 三条纪律（与 v1 `semantic.ts` 的编码层同源，但这里只产区间、不编码 5 元组）：
 *
 * 1. **越界一律丢，不做"夹到别的行上"**：陈旧几何下把一段色画到相邻行，比不着色危险；
 *    列越界只夹取（少画一格仍画在正确的行上）。任何非法数字（NaN / Infinity / 负行）
 *    都只是让这一条消失，绝不抛。
 * 2. **跨行捕获逐行拆段**：首行从起始列到行尾、中间行整行、末行到结束列。没有
 *    `maxColumn`（行几何）时跨行捕获无法知道"行尾"在哪，整条丢弃并留给下一层再给几何。
 * 3. **同一行不叠**：按（行，起始列，长者优先）排序后，与上一条重叠的后到者丢掉。
 *    跨行的第一段与行内下一条可能相邻（`start === lastEnd`），相邻不算重叠。
 *
 * `@none` 是 tree-sitter 约定里的"这一枚不上色"（blank_line 就是这么标的），
 * 不进输出；其余 capture 名原样当 tokenType（`keyword.control` / `string.special` …），
 * 色板由未来的 provider 用同一套档位去主题里匹配。
 */

/** tree-sitter 坐标（0 基行 / 0 基列） */
export interface Kojo2Point {
  readonly row: number;
  readonly column: number;
}

/** `Query.captures()` 一枚捕获的**纯数据投影**（runtime 交出来的就是它） */
export interface Kojo2Capture {
  readonly name: string;
  readonly startPosition: Kojo2Point;
  readonly endPosition: Kojo2Point;
  /**
   * 捕获节点的**类型名**（LAU-6 additive）：注入层按 descriptor 的 `injections.hostNode`
   * 找宿主节点时只认这一格——宿主不硬编码任何节点名。
   * 缺省（旧回复 / 测试替身没给）= 不知道，注入层跳过这一条（不猜）。
   */
  readonly nodeType?: string;
}

/** Monaco 语义 token 区间：1 基行 / 1 基列 / endColumn 排他 */
export interface Kojo2TokenSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly tokenType: string;
}

export interface Kojo2TokenizeOptions {
  /** 模型行数（Monaco `getLineCount()`）；行坐标超出它的捕获一律丢弃 */
  readonly lineCount: number;
  /**
   * 该行的最大合法列（Monaco `getLineMaxColumn(line)` = 行文本长度 + 1）。
   * 跨行捕获必须给；同行捕获不给也成立（只按起始列与结束列夹取）。
   */
  readonly maxColumn?: (line: number) => number;
  /** 单条捕获最多跨多少行还值得画（缺省 {@link KOJO2_TOKENIZER_MAX_SPAN_LINES}） */
  readonly maxSpanLines?: number;
  /** 最多产出多少条区间（缺省 {@link KOJO2_TOKENIZER_MAX_TOKENS}），防止病态文档撑爆数组 */
  readonly maxTokens?: number;
}

/** 与 v1 结构着色的上限同量级：再多就不是"着色"而是"糊屏" */
export const KOJO2_TOKENIZER_MAX_TOKENS = 20_000;
/** 一条捕获跨过 200 行基本是错误恢复把块撑到了全篇，画出来只是一片色块 */
export const KOJO2_TOKENIZER_MAX_SPAN_LINES = 200;

const NO_STYLE = new Set(['none', '']);

interface PendingSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly tokenType: string;
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** capture 名 → tokenType；`@` 前缀容错去掉，`none` / 空名返回 null（不上色） */
function tokenTypeOf(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.startsWith('@') ? name.slice(1) : name;
  if (NO_STYLE.has(trimmed)) return null;
  return trimmed;
}

/** 行最大列；几何函数抛错 / 返回非有限值都当"没有几何"，由调用点决定丢还是不算 */
function maxColumnOf(geometry: Kojo2TokenizeOptions['maxColumn'], line: number): number | null {
  if (geometry === undefined) return null;
  try {
    const value = geometry(line);
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : null;
  } catch {
    return null;
  }
}

/**
 * 一条捕获 → 逐行区间。结构坏掉 / 行越界 / 跨行但没有行几何 ⇒ null（整条丢，不留半截）。
 */
function splitCapture(
  capture: Kojo2Capture,
  lineCount: number,
  maxSpanLines: number,
  geometry: Kojo2TokenizeOptions['maxColumn'],
): PendingSpan[] | null {
  if (capture === null || typeof capture !== 'object') return null;
  const tokenType = tokenTypeOf(capture.name);
  if (tokenType === null) return null;
  const startRow = finiteInt(capture.startPosition?.row);
  const startCol = finiteInt(capture.startPosition?.column);
  const endRow = finiteInt(capture.endPosition?.row);
  const endCol = finiteInt(capture.endPosition?.column);
  if (startRow === null || startCol === null || endRow === null || endCol === null) return null;
  // 行越界整条丢（夹到别的行上 = 在错的位置画色）；倒置行同理
  if (startRow < 0 || endRow < startRow || endRow >= lineCount) return null;
  if (endRow - startRow + 1 > maxSpanLines) return null;

  const firstLine = startRow + 1;
  const lastLine = endRow + 1;
  if (firstLine === lastLine) {
    const cap = maxColumnOf(geometry, firstLine) ?? Number.POSITIVE_INFINITY;
    const startColumn = Math.min(Math.max(1, startCol + 1), cap);
    const endColumn = Math.min(Math.max(startColumn, endCol + 1), cap);
    return endColumn <= startColumn ? null : [{ line: firstLine, startColumn, endColumn, tokenType }];
  }

  // 跨行捕获：每一段"到行尾"都要行几何；缺一行就整条丢，不许只画前半截
  if (geometry === undefined) return null;
  const spans: PendingSpan[] = [];
  for (let line = firstLine; line <= lastLine; line++) {
    const cap = maxColumnOf(geometry, line);
    if (cap === null) return null;
    const from = line === firstLine ? startCol + 1 : 1;
    const to = line === lastLine ? endCol + 1 : cap;
    const startColumn = Math.min(Math.max(1, from), cap);
    const endColumn = Math.min(Math.max(startColumn, to), cap);
    if (endColumn <= startColumn) continue;
    spans.push({ line, startColumn, endColumn, tokenType });
  }
  return spans.length === 0 ? null : spans;
}

/**
 * 捕获列表 → 区间数组。纯函数：不改入参、不抛、不读全局。
 *
 * 输入不是数组、行数非法、单条捕获结构坏掉 ⇒ 那一条/这一批直接为空；
 * 调用方（provider）只需要看结果长度，不需要 try/catch。
 */
export function capturesToTokenSpans(
  captures: readonly Kojo2Capture[] | null | undefined,
  options: Kojo2TokenizeOptions,
): Kojo2TokenSpan[] {
  if (!Array.isArray(captures) || captures.length === 0) return [];
  const lineCount = finiteInt(options?.lineCount);
  if (lineCount === null || lineCount < 1) return [];
  const maxSpanLines = Math.max(1, finiteInt(options.maxSpanLines) ?? KOJO2_TOKENIZER_MAX_SPAN_LINES);
  const maxTokens = Math.max(1, finiteInt(options.maxTokens) ?? KOJO2_TOKENIZER_MAX_TOKENS);
  const geometry = options.maxColumn;
  const pending: PendingSpan[] = [];
  for (const capture of captures) {
    const spans = splitCapture(capture, lineCount, maxSpanLines, geometry);
    if (spans !== null) pending.push(...spans);
  }
  return finish(pending, maxTokens);
}

/** 排序 + 去重叠 + 截上限；同一起点长者优先（外层节点先画，内层重叠段丢掉） */
function finish(pending: readonly PendingSpan[], maxTokens: number): Kojo2TokenSpan[] {
  const sorted = [...pending].sort(
    (a, b) =>
      a.line - b.line ||
      a.startColumn - b.startColumn ||
      b.endColumn - a.endColumn ||
      (a.tokenType < b.tokenType ? -1 : a.tokenType > b.tokenType ? 1 : 0),
  );
  const out: Kojo2TokenSpan[] = [];
  let lastLine = -1;
  let lastEnd = -1;
  for (const span of sorted) {
    if (out.length >= maxTokens) break;
    if (span.line === lastLine && span.startColumn < lastEnd) continue;
    out.push({
      line: span.line,
      startColumn: span.startColumn,
      endColumn: span.endColumn,
      tokenType: span.tokenType,
    });
    lastLine = span.line;
    lastEnd = span.endColumn;
  }
  return out;
}
