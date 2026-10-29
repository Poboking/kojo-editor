/**
 * Kojo 2.0 的 **Monaco 语义着色 provider**（K2-TS-WORKER 批：主线程不再直接跑 wasm）。
 *
 * ## 数据链（每一条都只在自己的层里）
 *
 * `getKojo2WorkerClient()`（主线程薄客户端，`?worker` 懒建线程）→
 * `captures(text, version, oldTreeId?)`（worker 内 `parse` + highlights 查询，回纯数据
 * `{ captures, treeId }`）→ `capturesToTokenSpans(..., { lineCount, maxColumn })`
 * （0 基行列 → 1 基 Monaco 区间）→ 本文件的 {@link encodeKojo2SemanticTokens}
 * （5 元组 delta 编码）→ `{ data }`。
 *
 * 本文件**不碰 wasm**、不读查询、不懂 tree-sitter 节点、也不知道旧树长什么样：
 * 它只认 worker 回复里的 `treeId`。上一版把 `treeId` 交回去，worker 就能增量重解；
 * 本文件从不 `delete()` 树（树活在那条线程里，由 worker 的 LRU 收账）。
 *
 * ## legend 与主题：名字逐字对齐，不造第二套色板
 *
 * Monaco 的 standalone 主题服务用 `[tokenType, ...modifiers].join('.')` 去匹配主题规则
 * （`semanticTokensProviderStyling.js` 的 `_hashTable` 取 metadata 那一段）。所以 legend 里
 * 的 **tokenType 必须等于主题规则的 `token`**：本文件的 legend **直接用
 * `kojo2-language.ts` 转交的 `KOJO2_TOKEN.*` 值**（现居 `@kojo/kojo-sdk/semantic-roles`，
 * 即 `role.keyword` / `role.speaker` …），
 * 而不是另起一套 `keyword` / `string`（那会与 v1 的语义类别撞名，还得再补一份映射）。
 * 角色 → 三套样式的索引（`@kojo/kojo-lang/monaco-theme` 的 `KOJO2_THEME_TOKEN_MAP`）是
 * "档位 = 配色"的单一真源，本文件只引用，不重定义颜色；缺规则在该模块加载期就会抛
 * （`buildTokenMap`）。
 *
 * capture 名 → 档位那张表（{@link KOJO2_CAPTURE_TOKEN_TYPES}）是**唯一的翻译层**：
 * - 精确名优先；`@` 前缀容错去掉（`Query.captures()` 实际不带 `@`）；
 * - `none` / 空名 = "这一枚不上色"（tree-sitter 约定，tokenizer 也会再挡一次）；
 * - 未知 capture ⇒ 丢掉并 warn 一次（**不猜**：legend 之外没有颜色；将来查询加档时这里
 *   先告警，而不是静默把一条捕获染色成邻近档）。
 *
 * 取档理由（与 `queries/v2/highlights.scm` 的注释、Monarch 的分档逐档对齐）：
 * - `comment` → 注释；`keyword*` → 保留词族（`keyword.operator` 的 `续` 走运算符档，
 *   与 Monarch 的 `CONTINUATION_TAIL` 同族）；
 * - `label` / `function.call` → 声明档（`#` 后的名字 / `!` 的被调名，与 Monarch 的
 *   `declaration` 同义）；`punctuation.special`（旁白锚点 `>`）→ 锚点档；
 * - `string`（旁白正文 / 台词 / 表值三合一）→ 台词档；`string.special`（插值 + 行尾提示
 *   在查询里**有意合并**，见查询头注）→ 插值档；
 * - `variable`（说话人）→ 说话人档；`number` / `operator` / `embedded`（`@原生` 体）→
 *   各自一档。
 *
 * ## 增量与所有权（worker 侧）
 *
 * 缓存键是 **model 版本号 + worker 交回的 `treeId`**：同一版本重复问直接命中（Monaco 停笔 /
 * 滚动都会重问）；版本变了才把上一版 `treeId` 交给 worker，由它决定"文本没变就复用 /
 * 变了就增量重解 / 不认识就整篇重解"。同一个 provider 的请求仍然**串行**（`serialize` 队列）：
 * worker 只有一条 parser，而语义 provider 的并发只会让"哪一版上屏"变得不可预测。
 *
 * worker 不可用 / 超时 / 解析失败 / 查询缺席 ⇒ **返回空 tokens**（不着色），并 `warn` 一次；
 * 绝不抛进 Monaco、绝不写 markers（着色是只读呈现面，失败不该变成问题面板里的噪音）。
 * 失败那一版同样进缓存（同版本不反复重试），但 `treeId` 只在 worker 明确交回时才留
 * （查询失败但树已解出 ⇒ 下一版继续增量；解析失败 ⇒ 归零，下一版整篇重解）。
 *
 * ## 注册
 *
 * {@link installKojo2SemanticTokensProvider} 只给 `kojo2` 语言 id 注册，**无条件装配**
 * （K2-SURFACE-DEFAULT：着色是只读呈现面）。disposal 幂等：先撤 provider 注册，再丢本
 * provider 的缓存（worker 客户端是共享单例，**不**在这里 dispose）。
 */
import type * as Monaco from './entry';
import { KOJO2_INJECTIONS, KOJO2_LANGUAGE_ID, KOJO2_TOKEN, type Kojo2TokenName } from './kojo2-language';
import { KOJO2_THEME_TOKEN_MAP } from '@kojo/kojo-lang/monaco-theme';
import { reportStructureDegradation } from './tree-sitter/fallback';
import {
  installKojo2IndentConfigFromWorker,
  type Kojo2IndentConfigHandle,
  type Kojo2IndentRulesSource,
} from './kojo2-indent';
import {
  capturesToTokenSpans,
  type Kojo2Capture,
  type Kojo2TokenSpan,
} from './tree-sitter/kojo2-tokenizer';
import type { Kojo2CapturesReply, Kojo2WorkerResult } from './tree-sitter/kojo2-worker-protocol';
import type { InjectionSpec } from './tree-sitter/structure-runtime';
import type {
  InjectionHost,
  InjectionOutcome,
  InjectionRunRequest,
} from './tree-sitter/injection';
import type { StructureRange } from './tree-sitter/protocol';
import type { KojoStructureToken } from './tree-sitter/types';

/* ============================== capture 名 → 档位 ============================== */

/**
 * tree-sitter capture 名 → `KOJO2_TOKEN` 档位（**唯一翻译层**）。
 *
 * 键是 `queries/v2/highlights.scm` 里出现过的捕获名（不带 `@`）。查询加档而这里没加时
 * provider 会丢掉那一条并 warn 一次——测试用查询文件的捕获集合与这张表对拍，防静默漂移。
 */
export const KOJO2_CAPTURE_TOKEN_TYPES: Readonly<Record<string, Kojo2TokenName>> = Object.freeze({
  comment: KOJO2_TOKEN.comment,
  keyword: KOJO2_TOKEN.keyword,
  'keyword.control': KOJO2_TOKEN.keyword,
  'keyword.function': KOJO2_TOKEN.keyword,
  'keyword.directive': KOJO2_TOKEN.keyword,
  'keyword.operator': KOJO2_TOKEN.operator,
  // 2026-10-27 第三色批：`# 对照表` / `# 池` / `# 模` 三枚结构定义头（查询侧同一批改判）
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
 * legend 的 tokenTypes：capture 表里**实际用到的档位**（声明序 = 首次出现序，稳定可断言）。
 *
 * 不做 `Object.values(KOJO2_TOKEN)` 全量：legend 是"provider 可能发什么"的声明，未映射的档
 * 放进来只是噪音；而"每个值都必须是主题规则"由类型（`Kojo2TokenName`）与下面的模块加载
 * 期自检双重保证。
 */
export const KOJO2_SEMANTIC_TOKEN_TYPES: readonly Kojo2TokenName[] = Object.freeze([
  ...new Set(Object.values(KOJO2_CAPTURE_TOKEN_TYPES)),
]);

/** 每个 legend 档位都必须在 `kojo2-theme.ts` 的派生表里（缺一格是接线错误，加载期就红） */
function assertLegendHasThemeRules(): void {
  for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) {
    if (KOJO2_THEME_TOKEN_MAP[token] === undefined) {
      throw new Error(`[kojo2-semantic] legend 档位「${token}」在 kojo2-theme 里没有主题规则`);
    }
  }
}
assertLegendHasThemeRules();

/** 交给 Monaco 的 legend（`tokenModifiers` 留空：本链只发表情档，不做修饰位） */
export const KOJO2_SEMANTIC_TOKEN_LEGEND: Monaco.languages.SemanticTokensLegend = Object.freeze({
  tokenTypes: [...KOJO2_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [],
});

/** tokenType → legend 下标（`-1` = 不在 legend，编码时丢掉） */
const TOKEN_TYPE_INDEX: ReadonlyMap<string, number> = new Map(
  KOJO2_SEMANTIC_TOKEN_TYPES.map((token, index) => [token, index]),
);

/* ============================== capture → tokenType ============================== */

/** 一次性告警表（同一 reason / 同一 capture 名只刷一条；与 v1 provider 同纪律） */
const warned = new Set<string>();

function warnOnce(warn: (message: string) => void, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** 去掉捕获名可能带的 `@` 前缀（`Query.captures()` 实际不带；这里容错） */
function bareCaptureName(name: string): string {
  return name.startsWith('@') ? name.slice(1) : name;
}

/**
 * capture 名 → 档位；`null` = 这一条不上色（`none` / 空名），`undefined` = legend 之外
 * （调用方负责"丢掉 + 告警一次"）。
 */
function tokenTypeOfCapture(name: string): Kojo2TokenName | null | undefined {
  const bare = bareCaptureName(name);
  if (bare === '' || bare === 'none') return null;
  return KOJO2_CAPTURE_TOKEN_TYPES[bare];
}

/**
 * 把运行时交出的捕获列表翻译成 tokenizer 认识的 `Kojo2Capture[]`（`name` = 档位）。
 *
 * 纯函数、不抛：结构坏掉的条目直接丢（tokenizer 还会再做一次越界/几何判据）。
 * `onUnknown` 只用来做"一次一条"的告警，测试可传空实现。
 */
export function mapKojo2Captures(
  captures: readonly Kojo2Capture[] | null | undefined,
  onUnknown?: (name: string) => void,
): Kojo2Capture[] {
  if (!Array.isArray(captures)) return [];
  const out: Kojo2Capture[] = [];
  for (const capture of captures) {
    if (capture === null || typeof capture !== 'object') continue;
    const name = typeof capture.name === 'string' ? capture.name : '';
    const tokenType = tokenTypeOfCapture(name);
    if (tokenType === null) continue;
    if (tokenType === undefined) {
      onUnknown?.(bareCaptureName(name));
      continue;
    }
    out.push({
      name: tokenType,
      startPosition: capture.startPosition,
      endPosition: capture.endPosition,
    });
  }
  return out;
}

/* ============================== `@原生` 注入（LAU-6） ============================== */

/**
 * 子树**捕获名**（子语言查询说的名字，如 ERB 的 `comment` / `keyword.control`）→ kojo2 的
 * token 名。表外捕获 = 不涂（不猜邻近档）。
 *
 * 为什么要在宿主语言这一侧翻译：Monaco 的语义图例是**按 provider（= 按语言）**声明的，
 * 一份 kojo2 model 只能收 kojo2 provider 的图例；子树要是搬自己那套 token 名进来，
 * 得先在图例里登记（等于把 ERB 的色板借给 kojo2）。这里改成"同义档"：
 * 注释→注释、指令/控制流→保留词、声明→声明、串→台词、插值→插值、停用区→原生围栏、
 * 类型→类型。屏上的语义分层一处不少，且**不新增色档**（图例 / 主题一格不动）。
 *
 * ## 为什么键是**捕获名**而不是子语言的**档位名**
 *
 * 档位名里有两枚历史遗留（ERB 的 `keyword.erb` / `sugar.interp`），`audit-language` 的
 * M3 把这类名字按"旧 token 名"计数（只许收敛、不许新增）。而这张表本来就是"子查询的
 * 捕获 → 本语言的档"，捕获名是查询的直接产物，翻译落在更靠上游的一格；
 * 对 ERB 逐项同像（`keyword.control` 原来走 `keyword.erb` 档、`string.special` 走
 * `sugar.interp` 档），所以行为零变化——`kojo2-injection.test.ts` 钉住了这两格。
 */
export const KOJO2_INJECTION_CAPTURE_TOKENS: Readonly<Record<string, Kojo2TokenName>> = Object.freeze({
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
 * 从主树捕获里挑出**注入宿主节点**（纯函数；descriptor 的 `injections` 是数据，这里是唯一消费者）。
 *
 * 只认精确节点名：`nodeType` 缺失 / 空串 / 不在表里 ⇒ 跳过（旧回复或测试替身不带节点类型时
 * 宁可不注入，也不按捕获名猜）。同一节点被多条捕获命中只算一次（键 = 语言 + 类型 + 四点）。
 * 宿主不出现任何具体节点名——它只住在 `kojo2-language.ts` 的声明里。
 */
export function injectionHostNodes(
  specs: readonly InjectionSpec[],
  captures: readonly Kojo2Capture[] | null | undefined,
): InjectionHost[] {
  if (specs.length === 0 || !Array.isArray(captures) || captures.length === 0) return [];
  const byNode = new Map<string, InjectionSpec>();
  for (const spec of specs) byNode.set(spec.hostNode, spec);
  const out: InjectionHost[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    const nodeType = capture.nodeType ?? '';
    const spec = byNode.get(nodeType);
    if (spec === undefined) continue;
    const start = capture.startPosition;
    const end = capture.endPosition;
    if (!isInjectionPoint(start) || !isInjectionPoint(end)) continue;
    const key = `${spec.languageId}\u0000${nodeType}\u0000${start.row}:${start.column}:${end.row}:${end.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      languageId: spec.languageId,
      hostNode: nodeType,
      startRow: start.row,
      startColumn: start.column,
      endRow: end.row,
      endColumn: end.column,
    });
  }
  return out;
}

function isInjectionPoint(point: { readonly row: number; readonly column: number }): boolean {
  return (
    Number.isInteger(point.row) &&
    Number.isInteger(point.column) &&
    point.row >= 0 &&
    point.column >= 0
  );
}

/** 子树 token（0 基行列 + 子语言捕获）→ Monaco 区间（tokenType 已翻成 kojo2 档位） */
export function injectionTokenSpans(
  tokens: readonly KojoStructureToken[],
  options: { readonly lineCount: number; readonly maxColumn: (line: number) => number },
): Kojo2TokenSpan[] {
  if (tokens.length === 0) return [];
  const captures: Kojo2Capture[] = [];
  for (const token of tokens) {
    const tokenType = KOJO2_INJECTION_CAPTURE_TOKENS[token.capture ?? ''];
    if (tokenType === undefined) continue; // 子语言多出一枚捕获而宿主没同义档：不涂（不猜）
    captures.push({
      name: tokenType,
      startPosition: { row: token.startRow, column: token.startCol },
      endPosition: { row: token.endRow, column: token.endCol },
    });
  }
  return capturesToTokenSpans(captures, options);
}

/**
 * 注入区间覆盖的 **1 基行号**（主树原文按行裁）。
 *
 * 区间的 endPosition 是"末行换行之后"（= 下一行第 0 列）⇒ 那一位不收进覆盖行；
 * 只有落在行中间的结尾才把那一行算进来。与 `planInjectionRanges` 的口径成对。
 */
export function injectionLineNumbers(ranges: readonly StructureRange[]): Set<number> {
  const lines = new Set<number>();
  for (const range of ranges) {
    const first = range.startPosition.row + 1;
    const last =
      range.endPosition.column === 0 && range.endPosition.row > range.startPosition.row
        ? range.endPosition.row
        : range.endPosition.row + 1;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

/** 区间减法：`[start,end)` 去掉已覆盖后剩下的片段（升序） */
function uncoveredColumns(
  start: number,
  end: number,
  covered: readonly Kojo2TokenSpan[],
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
 * **子树覆盖主树**（§4.6 第 3 步）：注入区内的主树区间（`@原生` 的整行 `role.raw`）让位给
 * 子树，但**只让出子树真的涂到的列**——子树没涂到的列仍由主树原文兜底（成本表的
 * "子树优先，主树 `role.raw` 兜底"）。区间外的主树区间一个字节不动。
 *
 * 纯函数：不改入参、不抛；输出仍按（行，起始列）升序（`encodeKojo2SemanticTokens` 会再排一次）。
 */
export function mergeInjectionSpans(
  main: readonly Kojo2TokenSpan[],
  injected: readonly Kojo2TokenSpan[],
  injectedLines: ReadonlySet<number>,
): Kojo2TokenSpan[] {
  if (injected.length === 0) return [...main];
  const byLine = new Map<number, Kojo2TokenSpan[]>();
  for (const span of injected) {
    const bucket = byLine.get(span.line);
    if (bucket === undefined) byLine.set(span.line, [span]);
    else bucket.push(span);
  }
  const out: Kojo2TokenSpan[] = [];
  for (const span of main) {
    if (!injectedLines.has(span.line)) {
      out.push(span);
      continue;
    }
    for (const [startColumn, endColumn] of uncoveredColumns(
      span.startColumn,
      span.endColumn,
      byLine.get(span.line) ?? [],
    )) {
      out.push({ line: span.line, startColumn, endColumn, tokenType: span.tokenType });
    }
  }
  out.push(...injected);
  return out;
}

/* ============================== 5 元组编码 ============================== */

/**
 * 区间 → Monaco `SemanticTokens.data`（每 token 五个 `uint32`：
 * `deltaLine` / `deltaStart` / `length` / `tokenType` / `tokenModifiers`）。
 *
 * 编码口径与 Monaco 的 `toMultilineTokens2` 对齐（取证
 * `semanticTokensProviderStyling.js`：`lastLineNumber = 1`、`lastStartCharacter = 0`）：
 * - **绝对分量是 0 基**：首 token 与换行后的 token 写 `line - 1` / `startColumn - 1`
 *   （解码器把 `deltaLine` 加到 `lastLineNumber = 1` 上、把 `deltaCharacter` 当 0 基字符位）；
 * - **同行增量**（`deltaLine === 0` 时）是相对上一 token 起始列的差——两点之差与基数无关，
 *   照旧用 1 基相减；
 * - 必须按 (行, 起始列) 升序（tokenizer 已保证，这里再排一次防御直接调用方）；
 * - 同行重叠保留先到的（Monaco 按到达顺序覆盖；重叠只会让颜色画错而不是消失）；
 * - 零宽区间、legend 之外的类型不进数据。
 *
 * 旧版头注把"首 token 的 `deltaLine` 是 1 基绝对行"当成 Monaco 的口径写死，真机结果是
 * 整篇结构色**下移一行**（2026-10-26 坐标错位批）；自写解码器与编码器同为 1 基，闸一直绿。
 */
export function encodeKojo2SemanticTokens(
  spans: readonly Kojo2TokenSpan[],
  tokenTypes: readonly string[] = KOJO2_SEMANTIC_TOKEN_TYPES,
): Uint32Array {
  const index = tokenTypes === KOJO2_SEMANTIC_TOKEN_TYPES
    ? TOKEN_TYPE_INDEX
    : new Map(tokenTypes.map((token, at) => [token, at]));
  const sorted = [...spans].sort(
    (a, b) =>
      a.line - b.line ||
      a.startColumn - b.startColumn ||
      b.endColumn - a.endColumn ||
      (a.tokenType < b.tokenType ? -1 : a.tokenType > b.tokenType ? 1 : 0),
  );
  const out: number[] = [];
  let previousLine = 0;
  let previousStart = 0;
  let lastEndOnLine = 0;
  for (const span of sorted) {
    if (!Number.isFinite(span.line) || !Number.isFinite(span.startColumn) || !Number.isFinite(span.endColumn)) {
      continue;
    }
    const length = Math.trunc(span.endColumn) - Math.trunc(span.startColumn);
    if (length <= 0) continue;
    const typeIndex = index.get(span.tokenType);
    if (typeIndex === undefined) continue;
    const line = Math.trunc(span.line);
    const startColumn = Math.trunc(span.startColumn);
    if (line === previousLine && startColumn < lastEndOnLine) continue;
    const first = out.length === 0;
    const sameLine = !first && line === previousLine;
    out.push(
      // 绝对分量必须 0 基（见头注）；同行增量与基无关。
      first ? line - 1 : line - previousLine,
      sameLine ? startColumn - previousStart : startColumn - 1,
      length,
      typeIndex,
      0,
    );
    previousLine = line;
    previousStart = startColumn;
    lastEndOnLine = startColumn + length;
  }
  const data = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) data[i] = out[i]!;
  return data;
}

/**
 * 子树失败的那一条可见账（LAU-6 DoD 3）：`warn` 一次 + 回落台账里带 **`core/injection/child-failed`**。
 *
 * 两处同时发不是重复：`warn` 是开发面（同一 reason 只刷一条），台账是作者面通知与机器对账的
 * 唯一通路（`fallback.ts` 的数字归一去重）。**主树的四面不经过这里**——它们照常。
 */
function reportInjectionFailure(warn: (message: string) => void, reason: string, message: string): void {
  warnInjectionOnce(warn, reason, message);
  reportStructureDegradation({
    capability: 'semantic',
    stage: 'parse',
    message: `@原生 体内的子解析这次没顶上（${reason}）：${message}`,
    code: 'core/injection/child-failed',
  });
}

function warnInjectionOnce(warn: (message: string) => void, reason: string, message: string): void {
  warnOnce(
    warn,
    `injection:${reason}`,
    `[kojo2-semantic] 注入子解析不可用（${reason}）：${message} ⇒ 这一块仍按原文显示，其余照常`,
  );
}

/* ============================== provider ============================== */

/**
 * 本 provider 对 worker 客户端的最小依赖面（结构类型：真 `Kojo2WorkerClient` 与测试替身都满足）。
 * 只要一个 `captures`：`parse` 由 worker 在查询请求内部按 `oldTreeId` 决定怎么做。
 */
export interface Kojo2SemanticWorkerClient {
  captures(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2CapturesReply>>;
}

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2SemanticProviderDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2SemanticWorkerClient | Promise<Kojo2SemanticWorkerClient>;
  /** 告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
  /**
   * **结构规则 → 语言配置**的挂点（K2-INDENT-WIRE）：每一轮**捕获成功**之后同步调一次。
   *
   * 为什么挂在这里：Monaco 没有"缩进规则 provider"接口，规则只能写进语言配置；而宿主手里
   * 唯一"每篇都过一遍、且已经证明 worker 可用"的位置就是本 provider 的成功分支（model +
   * 版本号都在手上）。省缺 = 不挂（`createKojo2SemanticTokensProvider` 的直接调用方零改动）；
   * 生产由 {@link installKojo2SemanticTokensProvider} 接到
   * `installKojo2IndentConfigFromWorker` 上。
   */
  readonly syncIndentConfig?: (model: Monaco.editor.ITextModel, treeId?: string) => void;
  /**
   * `@原生` 注入声明（LAU-6；缺省 = `kojo2-language.ts` 的 `KOJO2_INJECTIONS`）。
   * 置空数组 = **本 provider 不做注入**（回滚点，与 `injections` 置空同义）。
   */
  readonly injections?: readonly InjectionSpec[];
  /**
   * 子 parse 的执行器（测试注入缝；缺省 = **动态** import `./tree-sitter/injection`）。
   *
   * 动态的理由只有一条：开机静态图有硬上限（`ps10-eager-graph.test.ts` ≤198 文件，现值贴顶），
   * 而注入器只在真有 `@原生` 时才需要。没 `@原生` 的文件连这个模块都不装载，更不会请求
   * ERB wasm（DoD 第 2 条）。
   */
  readonly runInjection?: (model: Monaco.editor.ITextModel, request: InjectionRunRequest) => Promise<InjectionOutcome>;
}

/** 缺省客户端：懒到第一次真着色才把 worker 模块拉进来 */
async function defaultWorkerClient(): Promise<Kojo2SemanticWorkerClient> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/**
 * 缺省注入执行器：**动态**取注入模块（见 `runInjection` 那条注释）。
 *
 * 先记宿主节点账（折叠 provider 靠它决定要不要问子树），再跑（同 model 同版本只跑一次，
 * 语义面与折叠面共用同一张 promise —— 见 `injection.ts::runInjectionForModel`）。
 */
async function defaultRunInjection(
  model: Monaco.editor.ITextModel,
  request: InjectionRunRequest,
): Promise<InjectionOutcome> {
  const module = await import('./tree-sitter/injection');
  module.rememberInjectionHosts(model, request.version, request.hosts);
  return module.runInjectionForModel(model, request);
}

/** provider + 它自己的资源账（Monaco 的 provider 接口没有 dispose 位） */
export interface Kojo2SemanticProviderHandle {
  readonly provider: Monaco.languages.DocumentSemanticTokensProvider;
  /** 幂等：丢掉本 provider 的版本缓存（worker 客户端是共享单例，不归这里管） */
  dispose(): void;
}

interface ModelCacheEntry {
  readonly versionId: number;
  /** worker 交回的树号（下一版的增量基准；`null` = 上次失败且 worker 没交出可用的树） */
  readonly treeId: string | null;
  readonly tokens: Uint32Array;
}

const EMPTY_DATA = new Uint32Array(0);

/**
 * 造一个 2.0 语义 token provider（不注册；注册见
 * {@link installKojo2SemanticTokensProvider}）。
 *
 * 失败面全部收在内部：任何异常都回空 tokens，调用方（Monaco）永远看不到 throw。
 */
export function createKojo2SemanticTokensProvider(
  deps: Kojo2SemanticProviderDeps = {},
): Kojo2SemanticProviderHandle {
  const getClient = deps.getClient ?? defaultWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const syncIndentConfig = deps.syncIndentConfig ?? (() => undefined);
  const runInjection = deps.runInjection ?? defaultRunInjection;
  const injectionSpecs = deps.injections ?? KOJO2_INJECTIONS;
  /** model → 上一版的树号与结果（`WeakMap`：标签关掉、model 释放后自然可回收） */
  let cache = new WeakMap<Monaco.editor.ITextModel, ModelCacheEntry>();
  /** worker 只有一条 parser ⇒ 请求串行（并发只会让"哪一版上屏"不可预测） */
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const forget = (model: Monaco.editor.ITextModel): void => {
    cache.delete(model);
  };

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const compute = async (model: Monaco.editor.ITextModel): Promise<Uint32Array> => {
    if (disposed) return EMPTY_DATA;
    const versionId = model.getVersionId();
    const cached = cache.get(model);
    if (cached?.versionId === versionId) return cached.tokens;
    if (model.isDisposed()) {
      forget(model);
      return EMPTY_DATA;
    }

    const text = model.getValue();
    const client = await getClient();
    if (disposed) return EMPTY_DATA;
    const result = await client.captures(text, versionId, cached?.treeId ?? undefined);
    if (disposed) return EMPTY_DATA;
    if (model.isDisposed()) {
      forget(model);
      return EMPTY_DATA;
    }
    if (!result.ok) {
      warnOnce(
        warn,
        `worker:${result.reason}`,
        `[kojo2-semantic] 结构解析不可用（${result.reason}）：${result.message} ⇒ 本轮不着色`,
      );
      // worker 明确交回了树号（查询失败但树已解出）⇒ 下一版继续增量；否则归零。
      cache.set(model, { versionId, treeId: result.treeId ?? null, tokens: EMPTY_DATA });
      return EMPTY_DATA;
    }
    const geometry = {
      lineCount: model.getLineCount(),
      maxColumn: (line: number) => model.getLineMaxColumn(line),
    };
    const spans = capturesToTokenSpans(
      mapKojo2Captures(result.value.captures, (name) =>
        warnOnce(
          warn,
          `capture:${name}`,
          `[kojo2-semantic] capture「@${name}」不在 KOJO2_CAPTURE_TOKEN_TYPES 里 ⇒ 这一条不着色；` +
            '要么给它补档位，要么删掉这条捕获',
        ),
      ),
      geometry,
    );
    // LAU-6：有宿主节点才解子树（没有 `@原生` 的文件零额外请求，更不碰 ERB wasm）。
    // 失败只落一条 `core/injection/child-failed` 并保留主树的原文着色——主树四面一行不动。
    const hostNodes = injectionHostNodes(injectionSpecs, result.value.captures);
    let mergedSpans = spans;
    if (hostNodes.length > 0) {
      try {
        const outcome = await runInjection(model, {
          text,
          version: versionId,
          specs: injectionSpecs,
          hosts: hostNodes,
        });
        if (disposed) return EMPTY_DATA;
        if (model.isDisposed()) {
          forget(model);
          return EMPTY_DATA;
        }
        if (!outcome.ok) {
          reportInjectionFailure(warn, outcome.reason, outcome.message);
        } else if (outcome.tokens.length > 0) {
          mergedSpans = mergeInjectionSpans(
            spans,
            injectionTokenSpans(outcome.tokens, geometry),
            injectionLineNumbers(outcome.ranges),
          );
        }
      } catch (error: unknown) {
        // 注入器自己抛错 = 与"子树失败"同一结局：不拖垮主树，只记一条可见的码
        reportInjectionFailure(
          warn,
          'internal',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const tokens = encodeKojo2SemanticTokens(mergedSpans);
    cache.set(model, { versionId, treeId: result.value.treeId, tokens });
    // K2-INDENT-WIRE：捕获成功 = worker 可用 ⇒ 顺手问一次 `indents` 并把规则写进语言配置。
    // 失败面天然是"零改动"（worker 不可用时这条链根本走不到这里），且同步器自己再按
    // "同一 model 同一版本只问一次 / 规则指纹不变不重写"兜一层。交回 `treeId`：同一棵树
    // 上再跑一次查询，worker 不必为这条请求重解（文本逐字相同）。
    try {
      syncIndentConfig(model, result.value.treeId);
    } catch {
      /* 缩进配置是增强层：挂点自己炸了不该影响着色 */
    }
    return tokens;
  };

  const provider: Monaco.languages.DocumentSemanticTokensProvider = {
    getLegend: () => KOJO2_SEMANTIC_TOKEN_LEGEND,
    provideDocumentSemanticTokens(model) {
      if (disposed || model.isDisposed()) return { data: EMPTY_DATA };
      return serialize(() => compute(model)).then(
        (data) => ({ data }),
        (error: unknown) => {
          // 最后一道兜底：compute 内部已逐段降级，走到这里说明是编码/缓存层的意外。
          warnOnce(
            warn,
            `internal:${error instanceof Error ? error.message : String(error)}`,
            `[kojo2-semantic] 着色内部异常（本轮不着色，编辑器不受影响）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { data: EMPTY_DATA };
        },
      );
    },
    releaseDocumentSemanticTokens: () => undefined,
  };

  return {
    provider,
    dispose() {
      if (disposed) return;
      disposed = true;
      cache = new WeakMap();
    },
  };
}

/**
 * 为 `kojo2` 语言注册语义着色 provider（**无条件**：着色是只读呈现面，与切流阶段无关）。
 *
 * 本安装器同时是 **K2-INDENT-WIRE 的宿主挂点**：它持有
 * `installKojo2IndentConfigFromWorker(...)` 的句柄，并把 `syncIndentConfig` 注入 provider
 * ——于是"结构规则进语言配置"这件事与"结构着色"共用同一个 model / 版本号 / worker 客户端，
 * 不新开挂点、也不在 `editor-global-providers.ts` 里多一行。缩进规则同样是语言面
 * （K2-SURFACE-DEFAULT：改缓冲的回车缩进算语言面），两者一起无条件挂。
 *
 * 返回的 disposable 幂等：撤掉 Monaco 注册 → 丢 provider 的版本缓存 → 撤掉本层写过的语言
 * 配置（worker 客户端是共享单例，留给其它结构层消费方，不在这里 dispose）。
 */
export function installKojo2SemanticTokensProvider(
  monaco: typeof Monaco,
  deps: Kojo2SemanticProviderDeps = {},
): Monaco.IDisposable {
  // 语言配置的账：**只有这一枚**（Monaco 没有缩进 provider 接口，规则只能写进语言配置）
  const semanticGetClient = deps.getClient;
  const indentConfig: Kojo2IndentConfigHandle = installKojo2IndentConfigFromWorker(monaco, {
    // 结构面与语义面共用同一枚 worker 客户端（真客户端上两张查询都在）；`indents` 是
    // 可选面，替身没有时同步器取"零改动"（见 `Kojo2IndentRulesSource`），不是发空规则。
    ...(semanticGetClient === undefined
      ? {}
      : { getClient: async (): Promise<Kojo2IndentRulesSource> => (await semanticGetClient()) as Kojo2IndentRulesSource }),
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  });
  const handle = createKojo2SemanticTokensProvider({
    ...deps,
    syncIndentConfig: (model, treeId) => {
      void indentConfig.request(model, treeId);
      deps.syncIndentConfig?.(model, treeId);
    },
  });
  let registration: Monaco.IDisposable;
  try {
    registration = monaco.languages.registerDocumentSemanticTokensProvider(
      KOJO2_LANGUAGE_ID,
      handle.provider,
    );
  } catch (error) {
    // 注册失败 = 这一枚根本没挂上；把两枚自己的账先收了再外抛，
    // 由 `ensureGlobalProviders` 的"全有或全无"统一回滚（错误不许在这里吞掉）。
    handle.dispose();
    indentConfig.dispose();
    throw error;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } finally {
        try {
          handle.dispose();
        } finally {
          indentConfig.dispose();
        }
      }
    },
  };
}
