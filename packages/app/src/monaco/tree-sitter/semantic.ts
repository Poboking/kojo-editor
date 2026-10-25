import type * as Monaco from '../entry';
import { KOJO_TOKEN_TIERS } from '../kojo-language';
import { toMonacoColumn, toMonacoLine } from '../positions';
import {
  KOJO_STRUCTURE_BASELINE_TOKENS,
  KOJO_STRUCTURE_MAX_TOKENS,
  structureLegendTypes,
  type KojoStructureToken,
} from './types';

/**
 * CST token → Monaco **语义 token** 数据（协议翻译 + 编码；判据一概不在这里，全在 worker 的查询里）。
 *
 * ## legend 的来历：档位名**就是**词法 token 名
 *
 * Monaco 用 `[type, ...modifiers].join('.')` 去主题里匹配语义规则，所以类型名取
 * `kojo-language.ts` 已经在用的 token 名（`keyword.erb` / `sugar.speech` / `comment`）
 * 时，**同一档在屏上是同一个色**——语义层只是换了判据（从"看形状"换成"看结构"），
 * 没有另起一套配色。这也是后来做 A/B 的前提：两份结果按 token 名逐行可比，
 * 比的确实是判据而不是调色板。
 *
 * ## 编码三条纪律（与 `kojo-semantic-tokens.ts` 同源，抄它不如共用它）
 *
 * 1. 必须按（行，起始列）升序：`deltaLine` 是相对上一条的行差，`deltaStart` 是
 *    **同行时**相对上一条起始列的差（换行则取绝对列）；
 * 2. 同行不得重叠：留先到的，后者丢掉并说一次；
 * 3. 零宽不进数据。
 *
 * ## 基数是 0，不是 1（2026-10-26 坐标错位批）
 *
 * `splitStructureTokensToSpans` 交的是模型坐标（1 基行 / 1 基列），但 `SemanticTokens.data`
 * 的协议口径是 0 基：Monaco 0.57 的 `toMultilineTokens2` 从 `lastLineNumber = 1` 起算，
 * `lineNumber = lastLineNumber + deltaLine`。所以**绝对**分量要减一（首 token 与换行后的
 * token 写 `line - 1` / `startColumn - 1`），**同行增量**（两点之差）与基数无关。
 * 闸只认真 Monaco 解码器：`tests/helpers/monaco-semantic-decode.ts`。
 *
 * ## 跨行节点先拆成逐行段
 *
 * 一份查询捕获可能盖好几行（围栏块、写长的台词行）。语义数据按"行 + 宽度"编码，
 * 跨行段先拆：首行从起始列到行尾、中间行整行、末行到结束列。跨度超过
 * {@link MAX_STRUCTURE_TOKEN_SPAN} 行的捕获**整条丢掉并说一次**——那通常是错误恢复
 * 把某个块撑到了全篇，画出来就是一片色块糊住正文，不如不着色。
 */

/** 模型几何（与 `kojo-semantic-tokens.ts` 的 `SemanticGeometry` 同一条口径） */
export interface StructureGeometry {
  readonly lineCount: number;
  /** 该行最后一个合法列（Monaco `getLineMaxColumn` = 行长度 + 1） */
  maxColumn(lineNumber: number): number;
}

/** 一次编码的产物 + 被丢掉的数量（丢多少必须能报出去，不许静默） */
export interface StructureEncodeResult {
  readonly data: Uint32Array;
  readonly droppedRows: number;
  readonly droppedEmpty: number;
  readonly droppedWide: number;
  readonly droppedOverlaps: number;
}

/** 单个捕获最多跨多少行还值得着色（超过 = 判定跑飞，丢掉并说一次） */
export const MAX_STRUCTURE_TOKEN_SPAN = 200;

/** 交给 Monaco 的 legend（下标即编码里的 typeIndex；顺序由 `types.ts` 的表算出，稳定可测） */
export const KOJO_STRUCTURE_LEGEND: Monaco.languages.SemanticTokensLegend = {
  tokenTypes: structureLegendTypes(),
  tokenModifiers: [],
};

const TYPE_INDEX = new Map<string, number>(
  KOJO_STRUCTURE_LEGEND.tokenTypes.map((t, i) => [t, i]),
);

/** 档位名 ↔ 词法档位表的一致性表（`comment` 这类基线 token 另走基线集合） */
const KNOWN_TIERS = new Set<string>([
  ...KOJO_TOKEN_TIERS.flatMap((tier) => [...tier.tokens]),
  ...KOJO_STRUCTURE_BASELINE_TOKENS,
]);

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[kojo-structure-semantic] ${message}`);
}

/** 档位名在不在词法档位表里（不在 = 语义色无处可取 ⇒ 不着色并且说一次） */
export function isKnownStructureTier(tier: string): boolean {
  const known = KNOWN_TIERS.has(tier);
  if (!known) {
    warnOnce(
      `tier:${tier}`,
      `档位 "${tier}" 既不在 KOJO_TOKEN_TIERS 也不在基线 token 里 ⇒ 该类结构段不着色；` +
        '要么在 kojo-language.ts 的档位表里给它一档并配色，要么把 types.ts 的映射改成已有档位',
    );
  }
  return known;
}

/** 测试用：清掉"只说一次"的台账 */
export function resetStructureSemanticWarnings(): void {
  warned.clear();
}

interface PendingSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly typeIndex: number;
}

/**
 * CST token（0 基行 / 0 基列，`endCol` 排他）→ 逐行 Monaco 区间（1 基行 / 1 基列，
 * `endColumn` 排他且夹到行内）。行越界**丢弃**（陈旧数据夹到别的行 = 在错的位置画色，
 * 比没色危险）；列越界**夹取**（少画一格仍画在正确行上）。
 */
export function splitStructureTokensToSpans(
  tokens: readonly KojoStructureToken[],
  geometry: StructureGeometry,
): { spans: PendingSpan[]; droppedRows: number; droppedEmpty: number; droppedWide: number } {
  const spans: PendingSpan[] = [];
  let droppedRows = 0;
  let droppedEmpty = 0;
  let droppedWide = 0;
  for (const token of tokens) {
    if (!isKnownStructureTier(token.tier)) continue;
    const typeIndex = TYPE_INDEX.get(token.tier);
    if (typeIndex === undefined) continue; // legend 里没有（`structureLegendTypes` 与映射同源，理论到不了这里）
    const startLine = toMonacoLine(token.startRow);
    const endLine = toMonacoLine(token.endRow);
    if (
      !Number.isFinite(startLine) ||
      !Number.isFinite(endLine) ||
      startLine < 1 ||
      endLine > geometry.lineCount ||
      endLine < startLine
    ) {
      droppedRows++;
      continue;
    }
    if (endLine - startLine + 1 > MAX_STRUCTURE_TOKEN_SPAN) {
      droppedWide++;
      continue;
    }
    for (let line = startLine; line <= endLine; line++) {
      const cap = geometry.maxColumn(line);
      const from = line === startLine ? toMonacoColumn(token.startCol) : 1;
      const to = line === endLine ? toMonacoColumn(token.endCol) : cap;
      const startColumn = Math.min(Math.max(1, Math.trunc(from) || 1), cap);
      const endColumn = Math.min(Math.max(startColumn, Math.trunc(to) || startColumn), cap);
      if (endColumn <= startColumn) {
        droppedEmpty++;
        continue;
      }
      spans.push({ line, startColumn, endColumn, typeIndex });
    }
  }
  return { spans, droppedRows, droppedEmpty, droppedWide };
}

/**
 * 逐行区间 → Monaco `SemanticTokens.data`（每条 5 个 uint32）。
 * 与 `encodeSemanticTokens` 同一套纪律，但类型面是档位名而不是契约的
 * `EditorSemanticTokenType`（两套 legend 各自独立，谁也不顶掉谁的：同开时以结构层为准，
 * 结构层对该文档没有结果时**返回 null**，让「定义与调用的名字分色」那条 provider 应答）。
 */
export function encodeStructureTokens(tokens: readonly KojoStructureToken[], geometry: StructureGeometry): StructureEncodeResult {
  const split = splitStructureTokensToSpans(tokens, geometry);
  const sorted = [...split.spans].sort(
    (a, b) => a.line - b.line || a.startColumn - b.startColumn || b.endColumn - a.endColumn,
  );
  const data = new Uint32Array(sorted.length * 5);
  let written = 0;
  let previousLine = 0;
  let previousStart = 0;
  let lastEndOnLine = 0;
  let droppedOverlaps = 0;
  for (const span of sorted) {
    const length = span.endColumn - span.startColumn;
    if (length <= 0) continue;
    if (written >= KOJO_STRUCTURE_MAX_TOKENS) {
      warnOnce('overflow:data', `结构着色区间超过 ${KOJO_STRUCTURE_MAX_TOKENS} 条 ⇒ 后面的丢掉（文档太大或结构判定跑飞）`);
      break;
    }
    if (span.line === previousLine && written > 0 && span.startColumn < lastEndOnLine) {
      droppedOverlaps++;
      continue;
    }
    const sameLine = span.line === previousLine && written > 0;
    // 绝对分量必须 0 基（见头注）；同行增量与基无关，用 1 基相减即可。
    data[written * 5] = written === 0 ? span.line - 1 : span.line - previousLine;
    data[written * 5 + 1] = sameLine ? span.startColumn - previousStart : span.startColumn - 1;
    data[written * 5 + 2] = length;
    data[written * 5 + 3] = span.typeIndex;
    data[written * 5 + 4] = 0; // 本层不用修饰（图例的 tokenModifiers 为空）
    written++;
    previousLine = span.line;
    previousStart = span.startColumn;
    lastEndOnLine = span.endColumn;
  }
  return {
    data: data.slice(0, written * 5),
    droppedRows: split.droppedRows,
    droppedEmpty: split.droppedEmpty,
    droppedWide: split.droppedWide,
    droppedOverlaps,
  };
}
