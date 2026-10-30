/**
 * Kojo 2.0 **结构化着色的判据**（B3 语义收口，2026-10-30）：结构引擎的捕获快照 →
 * 契约语义 token 区间。纯函数、零 Monaco、零 IO。
 *
 * ## 为什么这一格必须住在包里
 *
 * "这段语法是什么角色"只有结构查询（`queries/v2/highlights.scm` 的捕获）答得出，而结构
 * 引擎是 `worker` 里的异步事实；槽 `ui.editor.languageService` 的 `provide(request)` 是
 * **同步**的。B3h 折叠先立的解法在这里照抄：宿主打开 / 改动时**预取**捕获、按 model 版本
 * 缓存，请求里带 `captures` 快照（契约的 `EditorSemanticCapture`，1 基坐标），供方同步作答。
 * 供方是插件，插件看不见宿主 ⇒ 翻译与裁剪的判据只能住本包（与 `folding` / `codelens` 同一条）。
 *
 * ## 坐标与"谁裁"
 *
 * 契约坐标是 **1 基行 / 1 基 UTF-16 码元列 / `endColumn` 半开**；结构引擎给的是 0 基。
 * 0→1 的换算由 {@link kojo2ContractCaptures} 一处完成（宿主预取时调它），本文件的其余函数
 * 只吃 1 基。**列越界由宿主最后一道夹取**（`normalizeSemanticSpans`）：本文件对单行捕获
 * 不查行长（宿主会夹），但**跨行捕获必须给 `maxColumn`**——没有行几何就不知道"行尾"在哪，
 * 整条丢（不许只画前半截）。
 *
 * ## 四条纪律（与旧宿主 tokenizer 逐条同源，行为逐字等价）
 *
 * 1. **越界一律丢**：行号不在 `[1, lineCount]`、倒置行、零宽、非有限数 ⇒ 这一条消失，绝不抛；
 * 2. **跨行逐行拆段**：首行从起始列到行尾、中间行整行、末行到结束列；单条跨过
 *    {@link KOJO2_SEMANTIC_MAX_SPAN_LINES} 行整条丢（错误恢复撑出来的"色块"不是着色）；
 * 3. **同一行不叠**：按（行，起始列，长者优先，token 名）排序后，与上一条重叠的后到者丢掉；
 *    相邻不算重叠；
 * 4. **预算**：主树与注入子树**各自**最多 {@link KOJO2_SEMANTIC_MAX_TOKENS} 条（与旧实现
 *    同口径；合并后可以略多，编码层不再截）。
 *
 * ## 注入子树（LAU-6）优先
 *
 * `@原生` 一类的注入体由子语言再解析一次，子捕获（`origin: 'injection'`）在自己的覆盖列上
 * **优先**于主树：主树那一整行 `embedded`（→ `role.raw`）让位给子树真涂到的列，子树没涂到的
 * 列仍由主树兜底。两张捕获表分开（主树 / 子树对同名捕获的说法可以不同），但并集今天恰好
 * 同义——`tag` / `function` / `raw` 只在子树表里，`embedded` 只在主树表里。
 *
 * ## legend 的名字也在这一格
 *
 * {@link KOJO2_SEMANTIC_TOKEN_TYPES} = 主树捕获表实际用到的档位（声明序 = 首次出现序）。
 * 它与三套 `kojo2-*` 主题的规则逐字对齐由测试钉住（本文件**不 import** `monaco-theme`：
 * 开机静态图里只该出现这一枚叶子）。
 */
import { KOJO2_TOKEN } from '@kojo/kojo-sdk/semantic-roles';

/* ============================== capture 名 → 档位 ============================== */

/**
 * 主树捕获名 → 2.0 档位（**唯一翻译层**；键是 `queries/v2/highlights.scm` 出现过的捕获名，
 * 不带 `@`）。查询加档而这里没加时供方会丢掉那一条并报一次"未知捕获"——两侧对拍由
 * `packages/kojo-lang/tests/semantic.test.ts` 与宿主既有闸共同钉住。
 *
 * 取档理由（与查询注释、Monarch 分档逐档对齐）：
 * `comment` → 注释；`keyword*` → 保留词族（`keyword.operator` 的 `续` 走运算符档，与
 * Monarch 的 `CONTINUATION_TAIL` 同族）；`label` / `function.call` → 声明档；`type` →
 * `# 对照表` / `# 池` / `# 模` 三枚结构定义头；`punctuation.special`（旁白锚点 `>`）→ 锚点；
 * `string`（旁白正文 / 台词 / 表值三合一）→ 台词；`string.special`（插值 + 行尾提示在查询里
 * **有意合并**）→ 插值；`variable`（说话人）→ 说话人；`number` / `operator` / `embedded`
 * （`@原生` 体）→ 各自一档。
 */
export const KOJO2_CAPTURE_TOKEN_TYPES: Readonly<Record<string, string>> = Object.freeze({
  comment: KOJO2_TOKEN.comment,
  keyword: KOJO2_TOKEN.keyword,
  'keyword.control': KOJO2_TOKEN.keyword,
  'keyword.function': KOJO2_TOKEN.keyword,
  'keyword.directive': KOJO2_TOKEN.keyword,
  'keyword.operator': KOJO2_TOKEN.operator,
  type: KOJO2_TOKEN.type,
  label: KOJO2_TOKEN.declaration,
  'function.call': KOJO2_TOKEN.declaration,
  'punctuation.special': KOJO2_TOKEN.anchor,
  string: KOJO2_TOKEN.speech,
  'string.special': KOJO2_TOKEN.interp,
  variable: KOJO2_TOKEN.speaker,
  number: KOJO2_TOKEN.number,
  operator: KOJO2_TOKEN.operator,
  embedded: KOJO2_TOKEN.raw,
});

/**
 * **注入子树**捕获名 → 2.0 档位（子语言查询说的名字，如 ERB 的 `comment` / `tag`）。
 *
 * 为什么键是**捕获名**而不是子语言的档位名：档位名里有两枚历史遗留（ERB 的 `keyword.erb` /
 * `sugar.interp`），`audit-language` 的 M3 按"旧 token 名"计数（只许收敛、不许新增）；
 * 捕获名是查询的直接产物，翻译落在更靠上游的一格。表外的子捕获 = 不涂（不猜邻近档）。
 */
export const KOJO2_INJECTION_CAPTURE_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  comment: KOJO2_TOKEN.comment,
  'keyword.directive': KOJO2_TOKEN.keyword,
  tag: KOJO2_TOKEN.keyword,
  label: KOJO2_TOKEN.declaration,
  function: KOJO2_TOKEN.declaration,
  'keyword.control': KOJO2_TOKEN.keyword,
  string: KOJO2_TOKEN.speech,
  'string.special': KOJO2_TOKEN.interp,
  raw: KOJO2_TOKEN.raw,
  type: KOJO2_TOKEN.type,
});

/**
 * legend 的 tokenTypes：主树捕获表里**实际用到的档位**（声明序 = 首次出现序，稳定可断言）。
 *
 * 不做 `Object.values(KOJO2_TOKEN)` 全量：legend 是"供方可能发什么"的声明，未映射的档
 * 放进来只是噪音；"每个值都是主题规则"由测试 + 三套 `kojo2-*` 主题的规则表对拍。
 */
export const KOJO2_SEMANTIC_TOKEN_TYPES: readonly string[] = Object.freeze([
  ...new Set(Object.values(KOJO2_CAPTURE_TOKEN_TYPES)),
]);

/* ============================== 契约形状 ============================== */

/** 契约捕获（结构同形于 `EditorSemanticCapture`；本包不引 `@kojo/plugin-api`，纯库自持形状） */
export interface Kojo2SemanticCapture {
  readonly name: string;
  /** 1 基行 */
  readonly line: number;
  /** 1 基起始列 */
  readonly startColumn: number;
  /** 1 基结束列（半开） */
  readonly endColumn: number;
  /** 跨行捕获的末行（1 基，闭区间）；缺省 = `line` */
  readonly endLine?: number;
  /** 来自哪棵树（缺省 `main`）；`injection` = 注入体子树的捕获 */
  readonly origin?: 'main' | 'injection';
}

/** 契约语义 token 区间（结构同形于 `EditorSemanticTokenSpan`；本语言不发修饰位） */
export interface Kojo2SemanticSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly tokenType: string;
}

/** 结构引擎的裸捕获（**0 基**；宿主 `kojo2-worker-protocol` 的回复形状） */
export interface Kojo2RawPoint {
  readonly row: number;
  readonly column: number;
}

/** 结构引擎的一枚捕获（0 基行列；`nodeType` 只给宿主认注入宿主节点，契约快照不带它） */
export interface Kojo2RawCapture {
  readonly name: string;
  readonly startPosition: Kojo2RawPoint;
  readonly endPosition: Kojo2RawPoint;
  readonly nodeType?: string;
}

/** 单条捕获最多跨多少行还值得画（与旧宿主 tokenizer 同值） */
export const KOJO2_SEMANTIC_MAX_SPAN_LINES = 200;
/** 主树 / 子树各自最多产出多少条区间（与旧宿主 tokenizer 同值） */
export const KOJO2_SEMANTIC_MAX_TOKENS = 20_000;

export interface Kojo2SemanticOptions {
  /** 模型行数（Monaco `getLineCount()`）；行坐标超出它的捕获一律丢弃 */
  readonly lineCount: number;
  /**
   * 该行的最大合法列（Monaco `getLineMaxColumn(line)` = 行文本长度 + 1）。**跨行捕获必须给**；
   * 单行捕获不给也成立（列是否过界由宿主最后一道夹取兜住）。
   */
  readonly maxColumn?: (line: number) => number;
  /** 单条捕获最多跨多少行还值得画（缺省 {@link KOJO2_SEMANTIC_MAX_SPAN_LINES}） */
  readonly maxSpanLines?: number;
  /** 每组最多产出多少条区间（缺省 {@link KOJO2_SEMANTIC_MAX_TOKENS}） */
  readonly maxTokens?: number;
  /** 主树里 legend 之外的捕获名（一次性告警出口；子树表外的静默丢，与旧行为同） */
  readonly onUnknownCapture?: (name: string) => void;
}

/* ============================== 0 基 → 契约 1 基 ============================== */

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * 结构引擎的裸捕获（0 基）→ 契约快照（1 基）。**只搬坐标，不裁几何**：行数 / 行长 /
 * 跨行拆段留给 {@link kojo2SemanticSpansFromCaptures} 与宿主最后一道夹取。
 *
 * 唯一的"不搬"是 `@none` / 空名那一类：它们按契约语义就是**不上色**（`EditorSemanticCapture`
 * 原文），而查询里用它们的只有 `blank_line` 与 `native_body`（后者只借这个捕获把节点名字
 * 交给宿主的注入层认——那一趟在**建快照之前**，读的是 worker 原回复）。所以快照里留它们
 * 只会让每份文档多背一批"确定不用"的行。
 *
 * 结构坏掉 / 行列非有限 / 负数 / 倒置的条目直接丢（engine 不该发，但宿主是搬运方不是裁判）。
 */
export function kojo2ContractCaptures(
  captures: readonly Kojo2RawCapture[] | null | undefined,
  origin: 'main' | 'injection' = 'main',
): Kojo2SemanticCapture[] {
  if (!Array.isArray(captures)) return [];
  const out: Kojo2SemanticCapture[] = [];
  for (const capture of captures) {
    if (capture === null || typeof capture !== 'object') continue;
    const row = finiteInt(capture.startPosition?.row);
    const column = finiteInt(capture.startPosition?.column);
    const endRow = finiteInt(capture.endPosition?.row);
    const endColumn = finiteInt(capture.endPosition?.column);
    if (row === null || column === null || endRow === null || endColumn === null) continue;
    if (row < 0 || column < 0 || endRow < row || endColumn < 0) continue;
    const name = typeof capture.name === 'string' ? bareCaptureName(capture.name) ?? '' : '';
    // `@none` / 空名 = 不上色（契约原文）⇒ 不进快照；见本函数头注
    if (NO_STYLE.has(name)) continue;
    out.push({
      name,
      line: row + 1,
      startColumn: column + 1,
      endColumn: endColumn + 1,
      ...(endRow === row ? {} : { endLine: endRow + 1 }),
      ...(origin === 'injection' ? { origin } : {}),
    });
  }
  return out;
}

/* ============================== 捕获 → 区间 ============================== */

const NO_STYLE = new Set(['none', '']);

interface PendingSpan {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly tokenType: string;
}

/** 容错去掉 `@` 前缀（`Query.captures()` 实际不带；这里与旧宿主同一口径） */
function bareCaptureName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  return name.startsWith('@') ? name.slice(1) : name;
}

/**
 * 捕获名 → 档位；`null` = 这一条不上色（`none` / 空名 / 坏形状），`undefined` = 表外
 * （主树交给 `onUnknownCapture`，子树静默丢）。
 */
function tokenTypeOf(capture: Kojo2SemanticCapture): string | null | undefined {
  const bare = bareCaptureName(capture.name);
  if (bare === null || NO_STYLE.has(bare)) return null;
  const table =
    capture.origin === 'injection' ? KOJO2_INJECTION_CAPTURE_TOKENS : KOJO2_CAPTURE_TOKEN_TYPES;
  return table[bare];
}

/** 行最大列；几何函数抛错 / 返回非有限值都当"没有几何" */
function maxColumnOf(geometry: Kojo2SemanticOptions['maxColumn'], line: number): number | null {
  if (geometry === undefined) return null;
  try {
    const value = geometry(line);
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : null;
  } catch {
    return null;
  }
}

/**
 * 一条捕获 → 逐行区间。结构坏掉 / 行越界 / 跨行但没有行几何 ⇒ `null`（整条丢，不留半截）。
 * 单行捕获不查行长（宿主最后一道夹取会做），跨行捕获每一段"到行尾"都必须有几何。
 */
function splitCapture(
  capture: Kojo2SemanticCapture,
  tokenType: string,
  lineCount: number,
  maxSpanLines: number,
  geometry: Kojo2SemanticOptions['maxColumn'],
): PendingSpan[] | null {
  const firstLine = finiteInt(capture.line);
  const startCol = finiteInt(capture.startColumn);
  const lastLine = finiteInt(capture.endLine ?? capture.line);
  const endCol = finiteInt(capture.endColumn);
  if (firstLine === null || startCol === null || lastLine === null || endCol === null) return null;
  // 行越界整条丢（夹到别的行上 = 在错的位置画色）；倒置行同理
  if (firstLine < 1 || lastLine < firstLine || lastLine > lineCount) return null;
  if (lastLine - firstLine + 1 > maxSpanLines) return null;

  if (firstLine === lastLine) {
    const cap = maxColumnOf(geometry, firstLine) ?? Number.POSITIVE_INFINITY;
    const startColumn = Math.min(Math.max(1, startCol), cap);
    const endColumn = Math.min(Math.max(startColumn, endCol), cap);
    return endColumn <= startColumn ? null : [{ line: firstLine, startColumn, endColumn, tokenType }];
  }

  // 跨行捕获：每一段"到行尾"都要行几何；缺一行就整条丢，不许只画前半截
  if (geometry === undefined) return null;
  const spans: PendingSpan[] = [];
  for (let line = firstLine; line <= lastLine; line++) {
    const cap = maxColumnOf(geometry, line);
    if (cap === null) return null;
    const from = line === firstLine ? startCol : 1;
    const to = line === lastLine ? endCol : cap;
    const startColumn = Math.min(Math.max(1, from), cap);
    const endColumn = Math.min(Math.max(startColumn, to), cap);
    if (endColumn <= startColumn) continue;
    spans.push({ line, startColumn, endColumn, tokenType });
  }
  return spans.length === 0 ? null : spans;
}

/** 排序 + 去重叠 + 截上限；同一起点长者优先（外层节点先画，内层重叠段丢掉） */
function finish(pending: readonly PendingSpan[], maxTokens: number): PendingSpan[] {
  const sorted = [...pending].sort(
    (a, b) =>
      a.line - b.line ||
      a.startColumn - b.startColumn ||
      b.endColumn - a.endColumn ||
      (a.tokenType < b.tokenType ? -1 : a.tokenType > b.tokenType ? 1 : 0),
  );
  const out: PendingSpan[] = [];
  let lastLine = -1;
  let lastEnd = -1;
  for (const span of sorted) {
    if (out.length >= maxTokens) break;
    if (span.line === lastLine && span.startColumn < lastEnd) continue;
    out.push(span);
    lastLine = span.line;
    lastEnd = span.endColumn;
  }
  return out;
}

/** 区间减法：`[start,end)` 去掉已覆盖后剩下的片段（升序） */
function uncoveredColumns(
  start: number,
  end: number,
  covered: readonly PendingSpan[],
): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[start, end]];
  for (const span of covered) {
    if (span.endColumn <= start || span.startColumn >= end) continue;
    const next: Array<[number, number]> = [];
    for (const [pieceStart, pieceEnd] of pieces) {
      if (span.endColumn <= pieceStart || span.startColumn >= pieceEnd) {
        next.push([pieceStart, pieceEnd]);
        continue;
      }
      if (pieceStart < span.startColumn) next.push([pieceStart, span.startColumn]);
      if (pieceEnd > span.endColumn) next.push([span.endColumn, pieceEnd]);
    }
    pieces = next;
    if (pieces.length === 0) break;
  }
  return pieces;
}

/**
 * **子树覆盖主树**：注入体所在行上，主树区间让位给子树真涂到的列，没涂到的列仍由主树兜底；
 * 子树没出现的行一个字节不动（`injected` 为空 ⇒ 原样返回主树，与旧 `mergeInjectionSpans` 同）。
 */
function mergeInjected(main: readonly PendingSpan[], injected: readonly PendingSpan[]): PendingSpan[] {
  if (injected.length === 0) return [...main];
  const byLine = new Map<number, PendingSpan[]>();
  for (const span of injected) {
    const bucket = byLine.get(span.line);
    if (bucket === undefined) byLine.set(span.line, [span]);
    else bucket.push(span);
  }
  const out: PendingSpan[] = [];
  for (const span of main) {
    const covered = byLine.get(span.line);
    if (covered === undefined) {
      out.push(span);
      continue;
    }
    for (const [startColumn, endColumn] of uncoveredColumns(span.startColumn, span.endColumn, covered)) {
      out.push({ line: span.line, startColumn, endColumn, tokenType: span.tokenType });
    }
  }
  out.push(...injected);
  return out;
}

/**
 * 捕获快照 → 契约语义区间（**唯一实现**：宿主不另算，插件只调这一枚）。
 *
 * 纯函数：不改入参、不抛、不读全局。输入不是数组 / 行数非法 / 单条结构坏掉 ⇒ 那一条
 * （或这一批）直接为空；调用方只需要看结果长度，不需要 try/catch。
 */
export function kojo2SemanticSpansFromCaptures(
  captures: readonly Kojo2SemanticCapture[] | null | undefined,
  options: Kojo2SemanticOptions,
): Kojo2SemanticSpan[] {
  if (!Array.isArray(captures) || captures.length === 0) return [];
  const lineCount = finiteInt(options?.lineCount);
  if (lineCount === null || lineCount < 1) return [];
  const maxSpanLines = Math.max(1, finiteInt(options.maxSpanLines) ?? KOJO2_SEMANTIC_MAX_SPAN_LINES);
  const maxTokens = Math.max(1, finiteInt(options.maxTokens) ?? KOJO2_SEMANTIC_MAX_TOKENS);
  const geometry = options.maxColumn;
  const mainPending: PendingSpan[] = [];
  const injectedPending: PendingSpan[] = [];
  for (const capture of captures) {
    if (capture === null || typeof capture !== 'object') continue;
    const tokenType = tokenTypeOf(capture);
    if (tokenType === null) continue;
    if (tokenType === undefined) {
      if (capture.origin !== 'injection') {
        const bare = bareCaptureName(capture.name);
        if (bare !== null) options.onUnknownCapture?.(bare);
      }
      continue;
    }
    const spans = splitCapture(capture, tokenType, lineCount, maxSpanLines, geometry);
    if (spans === null) continue;
    if (capture.origin === 'injection') injectedPending.push(...spans);
    else mainPending.push(...spans);
  }
  const main = finish(mainPending, maxTokens);
  const injected = finish(injectedPending, maxTokens);
  return finish(mergeInjected(main, injected), Number.POSITIVE_INFINITY);
}