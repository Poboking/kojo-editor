import type * as Monaco from '../entry';
import { toMonacoColumn, toMonacoLine } from '../positions';
import { ERB_SEMANTIC_CAPTURE_TIERS, erbSemanticTiers } from './erb-tiers';
import { reportStructureDegradation } from './fallback';
import type { StructureEncodeResult, StructureGeometry } from './semantic';
import type { StructureSemanticFacet } from './structure-runtime';
import { KOJO_STRUCTURE_MAX_TOKENS, type KojoStructureToken } from './types';

/**
 * ERB 的**结构着色消费方**（`DocumentSemanticTokensProvider` + 编码）。
 *
 * ## 两层各管什么
 *
 * - **判据在查询里**（`erb-syntax-tree/queries/highlights.scm`）：哪一段是什么结构；
 * - **配色在档位表里**（`erb-tiers.ts`）：档位名就是词法 token 名 ⇒ 与 Monarch 同色，
 *   语义层只是换了判据（从"看形状"换成"看 CST"），A/B 比的是判据不是调色板。
 *
 * 本文件只做三件事：把 worker 回的 CST token 编成 Monaco 的 5 元增量数据、按 ERB 语言
 * 挂/摘 provider、把失败翻成 `fallback.ts` 的一次性可见回落。
 *
 * ## 与 Kojo 那份编码器的差异：**内层优先，不丢外层**
 *
 * Kojo 的 `semantic.ts` 遇到同行重叠是"留先到的、后者丢掉"——那适合"同一段只有一枚
 * 判据"的查询。ERB 的字符串里嵌插值（`"台词{NAME}与%CALLNAME%"`）是**天然嵌套**：
 * `(string)` 盖住整枚串，`(form_interpolation)` / `(form_substitution)` 落在里面。
 * 先到先得会把插值整条丢掉（或反过来把串整条丢掉），两种都错。
 *
 * 这里的口径是：**窄的（内层）先写，宽的（外层）按已占区间切开后补写剩下的段**。
 * 于是串的正文与插值各自拿到自己的档位，且同一行不重叠（Monaco 的硬要求）。
 * 被切掉的部分计入 `droppedOverlaps`（丢多少必须能报出去）。
 *
 * ## 失败面：一律回 `null`，不抛
 *
 * `null` = "这一份文档结构层没有可画的东西"，Monaco 会让**同一语言的其他语义供给器**
 * （ERB 上就是定义/调用的名字分色）应答；返回空数据会把它们盖掉。所以"不可用 / 超时 /
 * 取消 / 查询没捕到东西"全部走 `null`，并且超时与异常各经 `fallback.ts` 说一次。
 */

/** 单个捕获最多跨多少行还值得着色（超过 = 判定跑飞；与 Kojo 那份同一上限） */
export const ERB_SEMANTIC_MAX_TOKEN_SPAN = 200;

/** provider 等 worker 的上限（线程卡住时不许把 Monaco 的 promise 挂到天荒地老） */
export const ERB_SEMANTIC_TIMEOUT_MS = 4_000;

/** 交给 Monaco 的 legend（下标即编码里的 typeIndex；顺序由档位表算出，稳定可测） */
export const ERB_SEMANTIC_LEGEND: Monaco.languages.SemanticTokensLegend = {
  tokenTypes: erbSemanticTiers(),
  tokenModifiers: [],
};

const TYPE_INDEX = new Map<string, number>(ERB_SEMANTIC_LEGEND.tokenTypes.map((tier, i) => [tier, i]));
const KNOWN_TIERS = new Set<string>(Object.values(ERB_SEMANTIC_CAPTURE_TIERS));

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[kojo-structure-semantic] ${message}`);
}

/** 测试用：清掉"只说一次"的台账 */
export function resetErbSemanticWarnings(): void {
  warned.clear();
}

/** 一枚待编码区间（1 基行 / 1 基列，`endColumn` 排他，夹在模型现实内） */
interface ErbSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly typeIndex: number;
}

/** 区间减法：`[start,end)` 去掉已覆盖段后剩下的片段（升序） */
function uncovered(start: number, end: number, covered: readonly (readonly [number, number])[]): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[start, end]];
  for (const [coveredStart, coveredEnd] of covered) {
    if (coveredEnd <= start || coveredStart >= end) continue;
    const next: Array<[number, number]> = [];
    for (const [pieceStart, pieceEnd] of pieces) {
      if (coveredEnd <= pieceStart || coveredStart >= pieceEnd) {
        next.push([pieceStart, pieceEnd]);
        continue;
      }
      if (pieceStart < coveredStart) next.push([pieceStart, coveredStart]);
      if (pieceEnd > coveredEnd) next.push([coveredEnd, pieceEnd]);
    }
    pieces = next;
    if (pieces.length === 0) break;
  }
  return pieces;
}

/**
 * CST token → 逐行、无重叠的 Monaco 区间。
 *
 * 行越界**丢弃**（陈旧数据夹到别的行 = 在错的位置涂色，比不涂危险）；列越界**夹取**。
 * 处理顺序按"同一行里先窄后宽"（结束列升序、起始列降序），内层先占位，外层被切开。
 */
export function splitErbStructureTokens(
  tokens: readonly KojoStructureToken[],
  geometry: StructureGeometry,
): { spans: ErbSpan[]; droppedRows: number; droppedEmpty: number; droppedWide: number; droppedOverlaps: number } {
  const raw: ErbSpan[] = [];
  let droppedRows = 0;
  let droppedEmpty = 0;
  let droppedWide = 0;
  for (const token of tokens) {
    if (typeof token.tier !== 'string' || !KNOWN_TIERS.has(token.tier)) {
      warnOnce(`tier:${String(token.tier)}`, `档位 "${String(token.tier)}" 不在 ERB 档位表里 ⇒ 该段不着色（改 erb-tiers.ts 或查询）`);
      continue;
    }
    const typeIndex = TYPE_INDEX.get(token.tier);
    if (typeIndex === undefined) continue; // legend 与档位表同源，理论到不了这里
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
    if (endLine - startLine + 1 > ERB_SEMANTIC_MAX_TOKEN_SPAN) {
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
      raw.push({ line, startColumn, endColumn, typeIndex });
    }
  }

  // 同一行里先窄后宽：内层（插值）先占位，外层（整枚串）随后被切开补写。
  const ordered = [...raw].sort(
    (a, b) => a.line - b.line || a.endColumn - b.endColumn || b.startColumn - a.startColumn,
  );
  const coveredByLine = new Map<number, Array<[number, number]>>();
  const spans: ErbSpan[] = [];
  let droppedOverlaps = 0;
  for (const span of ordered) {
    const covered = coveredByLine.get(span.line) ?? [];
    const pieces = uncovered(span.startColumn, span.endColumn, covered);
    if (pieces.length === 0) {
      droppedOverlaps++;
      continue;
    }
    if (pieces.length > 1 || pieces[0]![0] !== span.startColumn || pieces[0]![1] !== span.endColumn) {
      droppedOverlaps++;
    }
    for (const [startColumn, endColumn] of pieces) {
      spans.push({ line: span.line, startColumn, endColumn, typeIndex: span.typeIndex });
      covered.push([startColumn, endColumn]);
    }
    covered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    coveredByLine.set(span.line, covered);
  }
  spans.sort((a, b) => a.line - b.line || a.startColumn - b.startColumn || a.endColumn - b.endColumn);
  return { spans, droppedRows, droppedEmpty, droppedWide, droppedOverlaps };
}

/**
 * 逐行区间 → Monaco `SemanticTokens.data`（每条 5 个 uint32）。
 * 纪律与 `semantic.ts` 同源：按（行，起始列）升序、零宽不进数据、有上限。
 */
export function encodeErbStructureTokens(
  tokens: readonly KojoStructureToken[],
  geometry: StructureGeometry,
): StructureEncodeResult {
  const split = splitErbStructureTokens(tokens, geometry);
  const data = new Uint32Array(split.spans.length * 5);
  let written = 0;
  let previousLine = 0;
  let previousStart = 0;
  for (const span of split.spans) {
    const length = span.endColumn - span.startColumn;
    if (length <= 0) continue;
    if (written >= KOJO_STRUCTURE_MAX_TOKENS) {
      warnOnce('overflow:data', `结构着色区间超过 ${KOJO_STRUCTURE_MAX_TOKENS} 条 ⇒ 后面的丢掉（文档太大或结构判定跑飞）`);
      break;
    }
    const sameLine = span.line === previousLine && written > 0;
    data[written * 5] = written === 0 ? span.line : span.line - previousLine;
    data[written * 5 + 1] = sameLine ? span.startColumn - previousStart : span.startColumn;
    data[written * 5 + 2] = length;
    data[written * 5 + 3] = span.typeIndex;
    data[written * 5 + 4] = 0; // 本层不用修饰（图例的 tokenModifiers 为空）
    written++;
    previousLine = span.line;
    previousStart = span.startColumn;
  }
  return {
    data: data.slice(0, written * 5),
    droppedRows: split.droppedRows,
    droppedEmpty: split.droppedEmpty,
    droppedWide: split.droppedWide,
    droppedOverlaps: split.droppedOverlaps,
  };
}

/** 运行时声明面：`StructureLanguageRuntime.semantic`（providers.ts 据此注册 provider） */
export const ERB_SEMANTIC_FACET: StructureSemanticFacet = {
  legend: ERB_SEMANTIC_LEGEND,
  encode: encodeErbStructureTokens,
};

/* ------------------------------- provider ------------------------------- */

/** provider 的取数面（真实接线是 `client.tokens(model)`；测试注入替身） */
export interface ErbSemanticTokenSource {
  /** 只挂这门语言（`ERB_LANGUAGE_ID`；由装配点传，避免本文件 import 重型语言模块） */
  readonly languageId: string;
  readonly tokens: (model: Monaco.editor.ITextModel) => Promise<readonly KojoStructureToken[] | null>;
  /** 叠层开着吗（关掉/拆毁之后一律不动，连问都不问） */
  readonly isActive?: () => boolean;
  /** 缺省 {@link ERB_SEMANTIC_TIMEOUT_MS} */
  readonly timeoutMs?: number;
}

/** 等取数结果的三态闸；超时 / 抛错都只回"这一面这次不顶上"（不抛、不挂住 Monaco） */
type TokenOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TokenOutcome<T>> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<TokenOutcome<T>>((resolve) => {
    handle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const settled = promise.then(
    (value): TokenOutcome<T> => ({ kind: 'value', value }),
    (error): TokenOutcome<T> => ({ kind: 'error', error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (handle !== null) clearTimeout(handle);
  }
}

/**
 * 建一枚**只挂 ERB** 的 `DocumentSemanticTokensProvider`。
 *
 * 不可用（取数 null / 空数组）/ 取消 / 超时 / 抛错 ⇒ 回 `null`：让同一语言的其他语义
 * 供给器（名字分色）应答。超时与抛错各经 `fallback.ts` **说一次**。
 */
export function createErbSemanticTokensProvider(
  source: ErbSemanticTokenSource,
): Monaco.languages.DocumentSemanticTokensProvider {
  const timeoutMs =
    typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs) && source.timeoutMs >= 1
      ? Math.trunc(source.timeoutMs)
      : ERB_SEMANTIC_TIMEOUT_MS;
  return {
    getLegend: () => ERB_SEMANTIC_LEGEND,
    async provideDocumentSemanticTokens(model, _resultId, token) {
      if (model.getLanguageId() !== source.languageId) return null;
      if (source.isActive !== undefined && !source.isActive()) return null;
      if (token?.isCancellationRequested) return null;
      const race = await withTimeout(
        (async () => source.tokens(model))(),
        timeoutMs,
      );
      if (race.kind === 'timeout') {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          message: `结构着色 ${timeoutMs}ms 内没有回话 ⇒ 这一面这次不顶上（回到词法层）`,
        });
        return null;
      }
      if (race.kind === 'error') {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          message: `结构着色取数失败 ⇒ 回到词法层：${race.error instanceof Error ? race.error.message : String(race.error)}`,
        });
        return null;
      }
      if (token?.isCancellationRequested) return null;
      const tokens = race.value;
      if (tokens === null || tokens.length === 0) return null;
      const encoded = encodeErbStructureTokens(tokens, {
        lineCount: model.getLineCount(),
        maxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber),
      });
      if (encoded.droppedRows + encoded.droppedEmpty + encoded.droppedWide + encoded.droppedOverlaps > 0) {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          message: `ERB 结构着色丢掉 ${encoded.droppedRows} 条越界行 / ${encoded.droppedEmpty} 条空区间 / ${encoded.droppedWide} 条超宽跨度 / ${encoded.droppedOverlaps} 条重叠`,
        });
      }
      return encoded.data.length === 0 ? null : { data: encoded.data };
    },
    releaseDocumentSemanticTokens: () => undefined,
  };
}

/** 把 provider 挂到 ERB 语言 id 上（装配层的注册点；返回可回收句柄） */
export function registerErbSemanticTokensProvider(
  monaco: typeof Monaco,
  source: ErbSemanticTokenSource,
): Monaco.IDisposable {
  return monaco.languages.registerDocumentSemanticTokensProvider(
    source.languageId,
    createErbSemanticTokensProvider(source),
  );
}
