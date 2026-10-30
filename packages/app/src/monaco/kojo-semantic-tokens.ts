import type * as Monaco from './entry';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSemanticTokenModifier,
  EditorSemanticTokenSpan,
  EditorSemanticTokenType,
} from '@kojo/plugin-api';
import {errorText,  EDITOR_SEMANTIC_TOKEN_MODIFIERS, EDITOR_SEMANTIC_TOKEN_TYPES } from '@kojo/plugin-api';
import { registerForLanguageServices } from './register-dialects';
import { descriptorForLanguageId, lineWindowFor } from './language-registry';
import { HUGE_FILE_LINES } from '../ui/editor-options';

/**
 * 结构化着色的**宿主接线**（B6，2026-10-16 结构化着色批）。
 *
 * ## 分层（与 `kojo-folding` / `kojo-symbols` 逐字同款）
 *
 * 判据全在插件：`@` 是不是定义、`CALL` 后面那个名字是不是本项目有的函数、`函数 X(…)`
 * 里的 `X` 声明在几列——这些是 ERB / 糖的结构事实，宿主**一个都不认识**。
 * 宿主只干四件事：**legend 归一 → 区间整理 → delta 编码 → 注册 provider**。
 * （`pnpm audit:decoupling` 的 A 项把本目录收进射程不是装饰：这里出现一个 `CFLAG`
 * 或 `时机`，铁律 1 就破了。）
 *
 * ## 词法 vs 语义的分工（本文件的契约，不是建议）
 *
 * Monaco 的合并规则是**覆盖区间上语义 token 优先**（`standaloneThemeService` 用
 * `[type, ...modifiers].join('.')` 去匹配主题规则，命中的那条直接顶掉 Monarch 给同一
 * 区间的样式）。所以：
 *
 * - **词法归 Monarch**（`erb-language.ts` / `kojo-language.ts`）：关键字、字符串、数字、
 *   注释、变量族多段引用——凡"看形状就能判"的；
 * - **结构归这里**：定义 vs 调用、形参槽、声明出的名字——凡"只有解析器/字典知道角色"的。
 *
 * 贡献方交出的每个 span 都必须落在第二类。**重画词法已经着色的区间 = 造第二真相源**：
 * 同一个名字今天吃词法色、明天吃语义色，漂移没有任何判据能拦住。这条边界写进了两个
 * 贡献方的头注（`erb-parser/src/semantic-tokens.ts`、`kojo-sugar/src/semantic-tokens.ts`），
 * 三处同文，改一处就要改三处——这是有意的摩擦。
 *
 * ## legend 单一真源在本文件
 *
 * 词表的**名字**住在契约（`EDITOR_SEMANTIC_TOKEN_TYPES` / `..._MODIFIERS`，否则贡献方
 * 无法类型标注）；**legend 本身**（实际交给 Monaco 的那两份数组，以及哪些类别真有颜色）
 * 归宿主：主题规则在叶子 `kojo-theme-rules.ts`（本文件按同对象 re-export），合并进
 * `kojo-dark`。
 * 贡献方给出 legend 里没有的名字 ⇒ 该 span **不着色**，并且 `console.warn` 一次
 * （铁律 4：退化可见；静默丢色会被当成"插件没生效"猜半天）。
 *
 * ## 供方缺席时宿主怎么降级（B3 语义收口，2026-10-30）
 *
 * 本文件只**注册 provider 与翻译形状**，"这段是什么角色"一律由槽 `ui.editor.languageService`
 * 的 `semanticToken` 供方答（kojo2 的供方是插件 `@kojo/plugin-kojo-lang`）。由此有三条
 * **显式**结局，宿主一条都不猜：
 *
 * - **供方在、肯答** ⇒ 用它的 span；
 * - **供方在、弃权**（`undefined`，如非 kojo2 的请求被 kojo-lang 让掉）⇒ 下一家接手；
 * - **供方缺席**（插件停用 / 卸掉，槽里零贡献）⇒ `collectSemanticTokenSpans` 交空数组 ⇒
 *   这一门只剩 Monarch 词法色，编辑照旧、不抛、不补假 token。可见性由内核的插件清单
 *   （inactive 必须可见）与本文件的空结果共同给出——**宿主不替缺席的插件造颜色**。
 */

/** 一门语言的 legend（名字集与修饰集；kojo2 声明自己的 `role.*` 角色层，其余用契约名字层） */
export interface SemanticTokenLegendSpec {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

/** 缺省 legend = 契约词表（顺序 = 词表顺序，不许本地重排） */
const DEFAULT_LEGEND: SemanticTokenLegendSpec = Object.freeze({
  tokenTypes: EDITOR_SEMANTIC_TOKEN_TYPES,
  tokenModifiers: EDITOR_SEMANTIC_TOKEN_MODIFIERS,
});

/** 交给 Monaco 的缺省 legend（ERB / `.kojo1` 读到的就是这一枚） */
export const KOJO_SEMANTIC_TOKEN_LEGEND: Monaco.languages.SemanticTokensLegend = {
  tokenTypes: [...EDITOR_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...EDITOR_SEMANTIC_TOKEN_MODIFIERS],
};

/**
 * `kojo-dark` 里语义类别的主题规则。
 *
 * **定义处已下沉**零 import 叶子 `kojo-theme-rules.ts`（PS-10 断链：本文件经
 * `register-dialects → kojo-language` 拖着 `@kojo/plugin-kojo-sugar`，而 `theme.ts`
 * 在开机静态图里）。此处按**同一数组本体** re-export（`monaco-theme.test.ts` 等既有
 * import 点读到的对象不变，别复制第二份）。
 *
 * token 名就是 `type.modifier…` 那条点分串（standalone 主题服务原文这么匹配），
 * 所以 `function.declaration` 比 `function` 更具体 = 定义点与调用点两种色。
 * 取色一律**复用既有词法色**（蓝 = 函数、黄 = 声明、橙 = 数/参数位），不引入新配色：
 * 作者看到的应当是"同一类东西同一个色"，而不是"新机制带来第七种蓝"。
 */
export { KOJO_SEMANTIC_THEME_RULES } from '@kojo/kojo-lang/theme-rules';

/**
 * 语言 → legend（**descriptor 声明，宿主不另存语言名单**）。
 *
 * 缺省 = 契约名字层三值 + 两枚修饰；一门语言若在 descriptor 里声明了 `semanticTokenLegend`
 * （今天只有 kojo2：`role.*` 语法角色层），就用它自己的那一份。两套 legend **不合并**——
 * 名字层与语法角色层是两个正交维度（`@kojo/kojo-sdk/semantic-roles` 的模块头 D6），
 * 而 Monaco 的语义图例是**按 provider（= 按语言）**声明的。
 */
export function semanticTokenLegendFor(languageId: string): SemanticTokenLegendSpec {
  return descriptorForLanguageId(languageId)?.semanticTokenLegend ?? DEFAULT_LEGEND;
}

/** 语言 → 类型名 → legend 下标（每个 legend 只算一次） */
const TYPE_INDEX_CACHE = new Map<string, { legend: SemanticTokenLegendSpec; index: ReadonlyMap<string, number> }>();
const MODIFIER_BITS_CACHE = new Map<string, { legend: SemanticTokenLegendSpec; bits: ReadonlyMap<string, number> }>();

function typeIndexMapOf(legend: SemanticTokenLegendSpec): ReadonlyMap<string, number> {
  const key = legend.tokenTypes.join('\u0000');
  const hit = TYPE_INDEX_CACHE.get(key);
  if (hit !== undefined && hit.legend.tokenTypes === legend.tokenTypes) return hit.index;
  const index = new Map(legend.tokenTypes.map((type, at) => [type, at]));
  TYPE_INDEX_CACHE.set(key, { legend, index });
  return index;
}

function modifierBitsOf(legend: SemanticTokenLegendSpec): ReadonlyMap<string, number> {
  const key = legend.tokenModifiers.join('\u0000');
  const hit = MODIFIER_BITS_CACHE.get(key);
  if (hit !== undefined && hit.legend.tokenModifiers === legend.tokenModifiers) return hit.bits;
  const bits = new Map(legend.tokenModifiers.map((modifier, at) => [modifier, 1 << at]));
  MODIFIER_BITS_CACHE.set(key, { legend, bits });
  return bits;
}

const warnedUnknown = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  console.warn(`[kojo-semantic-tokens] ${message}`);
}

/**
 * 类别名 → 类型序号；未知名字 → `-1` 并告警（**不猜**：legend 之外就没有颜色，
 * 而不是挑个"最像的"类别凑数）。缺省按契约名字层；按语言取请传该语言的 legend。
 */
export function semanticTokenTypeIndex(
  tokenType: EditorSemanticTokenType,
  tokenTypes: readonly string[] = EDITOR_SEMANTIC_TOKEN_TYPES,
): number {
  const at = tokenTypes.indexOf(tokenType);
  if (at >= 0) return at;
  warnOnce(
    `type:${tokenType}`,
    `类别 "${tokenType}" 不在宿主 legend（${tokenTypes.join('/')}）里 ⇒ 该类 span 不着色；` +
      '要么给这门语言的 legend 补这一类并在主题里给它颜色，要么删掉这条产出',
  );
  return -1;
}

/** 修饰名 → 位掩码；未知名字同样告警并**丢掉这个修饰**（类别本身照旧着色） */
export function semanticTokenModifierBits(
  modifiers: readonly EditorSemanticTokenModifier[] | undefined,
  tokenModifiers: readonly string[] = EDITOR_SEMANTIC_TOKEN_MODIFIERS,
): number {
  let bits = 0;
  for (const modifier of modifiers ?? []) {
    const at = tokenModifiers.indexOf(modifier);
    if (at < 0) {
      warnOnce(
        `modifier:${modifier}`,
        `修饰 "${modifier}" 不在宿主 legend（${tokenModifiers.join('/')}）里 ⇒ 该修饰被丢掉`,
      );
      continue;
    }
    bits |= 1 << at;
  }
  return bits;
}

/**
 * 合并全部贡献方的着色 span（隔离与去重口径同 `collectFoldingRanges`：
 * 单枚贡献抛错不许让整篇着色消失——着色是只读呈现面，少一家只是少一层颜色）。
 *
 * 三态照旧：`undefined` = 不认这个文件；空数组 = 认但无可着色 span。
 */
export function collectSemanticTokenSpans(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-semantic-tokens] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    if (!result || result.kind !== 'semanticToken') continue;
    for (const span of result.spans) {
      const key = `${span.line}\u0000${span.startColumn}\u0000${span.endColumn}\u0000${span.tokenType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(span);
    }
  }
  return out;
}

/** 一次整理的产物：可编码的区间 + 被丢掉的条数（丢多少要能报出去，不许静默） */
export interface NormalizedSemanticSpans {
  readonly spans: readonly EditorSemanticTokenSpan[];
  /** 行号不在模型里（陈旧/越界）而被丢掉的条数 */
  readonly droppedLines: number;
  /** 列区间塌成空（夹完 `end <= start`）而被丢掉的条数 */
  readonly droppedEmpty: number;
}

/** 模型几何（与 `reveal-position.ts` 的 `RevealGeometry` 同一条口径，由调用方从 model 现取） */
export interface SemanticGeometry {
  readonly lineCount: number;
  /** 该行最后一个合法列（Monaco `getLineMaxColumn` = 行长度 + 1） */
  maxColumn(lineNumber: number): number;
}

/**
 * 越界处理：**列夹取、行丢弃**——这里与 `clampRevealPosition` 有意不对称，理由是
 * 两种"夹"的代价不同。
 *
 * - 列：贡献方给的列可能超过行长（同一串文本，插件按 `length` 算、Monaco 按 UTF-16
 *   码元算，代理对一进来就差一格）。夹到 `[1, maxColumn]` 仍画在**正确的那一行**上，
 *   只是少画一格 ⇒ 安全。
 * - 行：行号越界只可能是**陈旧数据**（贡献方看的是另一份文本）。把 3000 行夹到 12 行
 *   等于在第 12 行画一根不相干的下划线——错位置比没位置危险得多，所以直接丢，
 *   并把丢掉了几条**报出去**（`encodeSemanticTokens` 的告警；铁律 4 不静默）。
 */
export function normalizeSemanticSpans(spans: readonly EditorSemanticTokenSpan[], geometry: SemanticGeometry): NormalizedSemanticSpans {
  const out: EditorSemanticTokenSpan[] = [];
  let droppedLines = 0;
  let droppedEmpty = 0;
  for (const span of spans) {
    if (!Number.isFinite(span.line) || span.line < 1 || span.line > geometry.lineCount) {
      droppedLines++;
      continue;
    }
    const line = Math.trunc(span.line);
    const cap = geometry.maxColumn(line);
    const startColumn = Math.min(Math.max(1, Math.trunc(span.startColumn) || 1), cap);
    const endColumn = Math.min(Math.max(startColumn, Math.trunc(span.endColumn) || startColumn), cap);
    if (endColumn <= startColumn) {
      droppedEmpty++;
      continue;
    }
    out.push({ line, startColumn, endColumn, tokenType: span.tokenType, ...(span.modifiers ? { modifiers: span.modifiers } : {}) });
  }
  return { spans: out, droppedLines, droppedEmpty };
}

/* ------------------------------ 增量编码（R3，2026-10-28） ------------------------------ */

/** 一条已编码的序列 + 它的 `data`：两者**逐 token 对应**（`spans.length * 5 === data.length`） */
export interface EncodedTokens {
  readonly data: Uint32Array;
  readonly spans: readonly EditorSemanticTokenSpan[];
}

/** 编码进位：`data` 里已经写了 `written` 条，最后一条落在 `line:start`、到 `endOnLine` 为止 */
interface EncodeCarry {
  readonly written: number;
  readonly line: number;
  readonly start: number;
  readonly endOnLine: number;
}

const FRESH_CARRY: EncodeCarry = { written: 0, line: 0, start: 0, endOnLine: 0 };

/** 编码序（{@link encodeRun} 的唯一排序判据；同行时长的在前——与旧实现的 sort 逐字相同） */
const byPosition = (a: EditorSemanticTokenSpan, b: EditorSemanticTokenSpan): number =>
  a.line - b.line || a.startColumn - b.startColumn || b.endColumn - a.endColumn;

/** 类型名不在该语言 legend 里：告警一次并丢弃（不猜相近类别） */
function warnUnknownType(tokenType: string, tokenTypes: readonly string[]): void {
  warnOnce(
    `type:${tokenTypes.join('/')}:${tokenType}`,
    `类别 "${tokenType}" 不在宿主 legend（${tokenTypes.join('/')}）里 ⇒ 该类 span 不着色；` +
      '要么给这门语言的 legend 补这一类并在主题里给它颜色，要么删掉这条产出',
  );
}

/**
 * 编码一段**已按 {@link byPosition} 排好序**的 span。`carry` 让它能接着别人往后写：
 * 增量那一路只重编码「变更窗口」那几条，前面那几万条的 `deltaLine` / `deltaStart` 直接搬字节。
 *
 * 三条编码纪律照旧（见本文件 `encodeSemanticTokens` 的旧头注）：升序、同行不重叠（保留先到的）、
 * 零宽不进数据。`carry.written === 0` 表示**这条是整份数据的头**（绝对分量按 0 基写）。
 */
function encodeRun(
  sorted: readonly EditorSemanticTokenSpan[],
  carry: EncodeCarry,
  legend: SemanticTokenLegendSpec = DEFAULT_LEGEND,
): EncodedTokens {
  const typeIndexMap = typeIndexMapOf(legend);
  const modifierBits = modifierBitsOf(legend);
  const buffer = new Uint32Array(sorted.length * 5);
  const kept: EditorSemanticTokenSpan[] = [];
  let written = carry.written;
  let previousLine = carry.line;
  let previousStart = carry.start;
  let lastEndOnLine = carry.endOnLine;
  let skippedOverlaps = 0;
  for (const span of sorted) {
    const length = span.endColumn - span.startColumn;
    if (length <= 0) continue;
    const typeIndex = typeIndexMap.get(span.tokenType);
    if (typeIndex === undefined) {
      warnUnknownType(span.tokenType, legend.tokenTypes);
      continue; // legend 之外 ⇒ 不着色
    }
    const isHead = written === 0;
    if (!isHead && span.line === previousLine && span.startColumn < lastEndOnLine) {
      skippedOverlaps++;
      continue; // 与已写入的同行区间重叠：保留先到的，丢后者
    }
    const at = kept.length * 5;
    // 绝对分量必须 0 基（见旧头注）；同行增量与基无关，用 1 基相减即可。
    buffer[at] = isHead ? span.line - 1 : span.line - previousLine;
    buffer[at + 1] = isHead || span.line !== previousLine ? span.startColumn - 1 : span.startColumn - previousStart;
    buffer[at + 2] = length;
    buffer[at + 3] = typeIndex;
    buffer[at + 4] = modifierBitsOfBits(modifierBits, span.modifiers, legend);
    kept.push(span);
    written++;
    previousLine = span.line;
    previousStart = span.startColumn;
    lastEndOnLine = span.endColumn;
  }
  if (skippedOverlaps > 0) {
    warnOnce(
      `overlap:${skippedOverlaps}`,
      `${skippedOverlaps} 条着色区间与先到的重叠 ⇒ 保留先到的（词法与结构的分工被越界了，检查贡献方是否在重画同一 span）`,
    );
  }
  return { data: kept.length === sorted.length ? buffer : buffer.slice(0, kept.length * 5), spans: kept };
}

/** 修饰位：已按该 legend 建好的位表；表外修饰告警一次后丢掉那一位 */
function modifierBitsOfBits(
  bits: ReadonlyMap<string, number>,
  modifiers: readonly string[] | undefined,
  legend: SemanticTokenLegendSpec,
): number {
  let value = 0;
  for (const modifier of modifiers ?? []) {
    const bit = bits.get(modifier);
    if (bit === undefined) {
      warnOnce(
        `modifier:${legend.tokenModifiers.join('/')}:${modifier}`,
        `修饰 "${modifier}" 不在宿主 legend（${legend.tokenModifiers.join('/')}）里 ⇒ 该修饰被丢掉`,
      );
      continue;
    }
    value |= bit;
  }
  return value;
}

/** 整篇编码（顺序无关：内部排序），并交回**真正写进 data 的那些 span**（增量拼接的基线） */
export function encodeTokenSpans(
  spans: readonly EditorSemanticTokenSpan[],
  legend: SemanticTokenLegendSpec = DEFAULT_LEGEND,
): EncodedTokens {
  return encodeRun([...spans].sort(byPosition), FRESH_CARRY, legend);
}

/**
 * 区间 → Monaco `SemanticTokens.data`（每 token 五个 `uint32`：
 * `deltaLine`、`deltaStart`、`length`、`tokenType`、`tokenModifiers`）。
 *
 * 三条编码纪律（错一条 Monaco 就把整篇颜色画歪，而且歪得看不出原因）：
 * 1. **必须按 (行, 起始列) 升序**——`deltaLine` 是相对上一个 token 的行差，`deltaStart`
 *    是**同行时**相对上一个 token 起始列的差（换行则取绝对列），倒序 = 负增量；
 * 2. **同行不得重叠**：Monaco 按到达顺序覆盖，重叠区画给后到的那条。这里判定为冲突并
 *    **保留先到的**（`collectSemanticTokenSpans` 的去重键已含类别，同名同区间的重复
 *    直接合掉；同类别不同区间的重叠说明两枚贡献方口径打架，丢后者并告警）；
 * 3. 长度为 0 的区间不进数据（编码上 `length` 是 token 宽度，0 宽 = 无意义）。
 *
 * ## 基数是 0，不是 1（2026-10-26 坐标错位批）
 *
 * 本函数吃的是**模型坐标**（1 基行、1 基 UTF-16 码元列，契约 `slots.ts` 原文），但
 * `SemanticTokens.data` 的协议口径是 **0 基**：Monaco 0.57 的解码器
 * （`esm/vs/editor/common/services/semanticTokensProviderStyling.js` 的
 * `toMultilineTokens2`）从 `lastLineNumber = 1` / `lastStartCharacter = 0` 起算，
 * `lineNumber = lastLineNumber + deltaLine`、`startCharacter = deltaLine === 0 ?
 * lastStartCharacter + deltaCharacter : deltaCharacter`。所以：
 *
 * - **绝对**分量必须减一：首 token 与每个换行后的 token 写 `line - 1`、`startColumn - 1`；
 * - **同行增量**是两点之差，与基数无关，照旧 `startColumn - previousStart`（两者同基）。
 *
 * 旧版把 1 基值原样写进去，真机症状（调试宿、同一 ERB、只翻结构解析器）：第 11 行
 * `IF LOCAL` 的结构色整体落到第 10 行、并从第 2 列起——下游 `tests/` 里自写的解码器
 * 也从 `line = 0` 起算，两边一起错，闸一直是绿的。**闸只认真 Monaco 解码器**，
 * 见 `tests/helpers/monaco-semantic-decode.ts`。
 *
 * 空输入返回**长度 0 的数组**（= "认这个文件，但整篇没有要着色的名字"）。
 */
export function encodeSemanticTokens(
  spans: readonly EditorSemanticTokenSpan[],
  legend: SemanticTokenLegendSpec = DEFAULT_LEGEND,
): Uint32Array {
  return encodeTokenSpans(spans, legend).data;
}

/** Monaco `SemanticTokensEdit`：`start` / `deleteCount` 是 **`data` 的元素下标**（每 token 5 个） */
export interface SemanticTokensEdit {
  readonly start: number;
  readonly deleteCount: number;
  readonly data?: Uint32Array;
}

/** 第一个 `line >= 目标` 的下标（span 已按行升序） */
function lowerBound(spans: readonly EditorSemanticTokenSpan[], line: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.line < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 第一个 `line > 目标` 的下标 */
function upperBound(spans: readonly EditorSemanticTokenSpan[], line: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.line <= line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 懒物化的基线：**拼过补丁之后不再维护整份 `data` 副本**。
 *
 * 为什么：`data` 是每 token 5 个 `uint32`，169,379 行那份实测 **182,819 段 = 3.66 MB**。
 * 第一版每敲一键把它整份拷进新数组（`O(整篇)`），实测拼补丁那一腿 **5.03 ms** —— 占整轮的
 * 96%，比它省下来的编码还贵。现在基线只留 `spans`（窗口拼装本来就只动它），整份 `data`
 * 变成 getter：**真有人要时才现编一次**——只有"退回整篇"那一档会要。
 */
class LazyEncodedTokens implements EncodedTokens {
  readonly spans: readonly EditorSemanticTokenSpan[];
  private readonly legend: SemanticTokenLegendSpec;
  private encoded: Uint32Array | null;

  constructor(spans: readonly EditorSemanticTokenSpan[], legend: SemanticTokenLegendSpec) {
    this.spans = spans;
    this.legend = legend;
    this.encoded = null;
  }

  get data(): Uint32Array {
    if (this.encoded === null) this.encoded = encodeRun(this.spans, FRESH_CARRY, this.legend).data;
    return this.encoded;
  }
}

/**
 * 把「变更窗口内重算的那一小段」拼回上一版，产出 Monaco 的 `edits`。
 *
 * ## 为什么只改一条 `deltaLine`
 *
 * `deltaLine` 是**相对上一条**的增量 ⇒ 在窗口里插入 N 行，只有「窗口之后的第一条」的
 * `deltaLine` 要改（`+行位移`），它后面每一条的相对关系全部自洽。所以 `edits` 最多两条：
 * 一条换掉窗口那一段，一条修交界处那 5 个 uint32。这正是 Monaco 增量通道的收益来源
 * （169,247 行的 16.8 万 span：整篇编码 435 ms → 只编码窗口那几条）。
 *
 * ## 一趟只动窗口（2026-10-28 的第二刀）
 *
 * 第一版每次都把整份 `data` 拷进新数组（`O(整篇)`），169k 行实测那一腿 **5.03 ms**——比它
 * 省下来的编码还贵。三刀之后基线里只剩指针拷贝：
 *
 * 1. 整份 `data` 懒物化（{@link LazyEncodedTokens}）——只有"退回整篇"那一档会要；
 * 2. 交界处那 5 个 `uint32` **从 span 现算**，不再读旧 `data`（读它会把懒物化提前引爆）；
 * 3. 新 `spans` **预分配 + 下标写**，不用 `[...before, ...run, ...tail]`（展开在 18 万枚上是
 *    push 语义逐枚追加，实测那一条就值 3.5 ms）。
 *
 * 实测（真语料，宿主一轮 = 窗口取数 + 编码 + 拼补丁，中位/p95；量具是一次性脚本、收尾已删，
 * 复跑办法：造同尺寸假 model，按 1/40/400 行窗口连问 `provideDocumentSemanticTokens`）：
 *
 * | 规模 | 1 行窗口 | 40 行 | 400 行 | 整篇（对照） |
 * |---|---|---|---|---|
 * | 24,197 行 / 85 万字符 / 26,117 段 | **0.46 / 1.25 ms** | 0.48 / 0.78 | 1.13 / 1.51 | 84.3 ms |
 * | 169,379 行 / 597 万字符 / 18.2 万段 | **1.98 / 3.93 ms** | 1.89 / 3.41 | 2.60 / 4.15 | 355.0 ms |
 *
 * 判据是"24k 单次 p95 < 3 ms、169k < 5 ms"，两档都在线上（169k 那档还留着 `O(整篇)` 的
 * 指针拷贝与 `[SKIP` 前缀搜索，见 `references.ts::skipStateBefore` 的头注）。
 *
 * ## 边界（每一条都由 `semantic-token-delta.test.ts` 的随机对拍顶着）
 *
 * - `window` 是**新坐标**的闭区间，`lineDelta` 是窗口之后的行位移 ⇒ 旧坐标的窗口末行
 *   是 `window.to - lineDelta`；
 * - 窗口把前面和后面的 span **都删空**时，后面那条会变成整份数据的**头**——它的
 *   `deltaLine` / `deltaStart` 都要改回绝对 0 基（这是唯一会动 `deltaStart` 的一档）；
 * - `edits` 必须按 `start` 升序（Monaco 从后往前套用，且不校验顺序）。
 */
export function spliceTokenSpans(
  previous: EncodedTokens,
  window: { readonly from: number; readonly to: number },
  windowSpans: readonly EditorSemanticTokenSpan[],
  lineDelta: number,
  legend: SemanticTokenLegendSpec = DEFAULT_LEGEND,
): { readonly edits: SemanticTokensEdit[]; readonly tokens: EncodedTokens } {
  const beforeEnd = lowerBound(previous.spans, window.from);
  const afterStart = upperBound(previous.spans, window.to - lineDelta);
  const cut = beforeEnd * 5;
  const tailAt = afterStart * 5;
  const last = beforeEnd > 0 ? previous.spans[beforeEnd - 1]! : null;
  const run = encodeRun([...windowSpans].sort(byPosition), {
    written: beforeEnd,
    line: last?.line ?? 0,
    start: last?.startColumn ?? 0,
    endOnLine: last?.endColumn ?? 0,
  }, legend);
  const edits: SemanticTokensEdit[] = [
    { start: cut, deleteCount: tailAt - cut, ...(run.data.length > 0 ? { data: run.data } : {}) },
  ];
  // 基线的新 span 序列：**预分配 + 三次下标写**，不用 slice/展开拼接。
  // 展开 `[...before, ...run, ...tail]` 在 18 万枚上是 push 语义逐枚追加，实测整条腿 4.7 ms
  // （预分配后 0.6 ms 量级）——这是本函数唯一还带 `O(整篇)` 的地方，常数已经压到指针拷贝。
  const tailCount = previous.spans.length - afterStart;
  const spans = new Array<EditorSemanticTokenSpan>(beforeEnd + run.spans.length + tailCount);
  for (let i = 0; i < beforeEnd; i++) spans[i] = previous.spans[i]!;
  for (let i = 0; i < run.spans.length; i++) spans[beforeEnd + i] = run.spans[i]!;
  const shifted = beforeEnd + run.spans.length;
  const head = tailCount > 0 ? previous.spans[afterStart]! : null;
  const headSpan = head === null || lineDelta === 0 ? head : { ...head, line: head.line + lineDelta };
  for (let i = 0; i < tailCount; i++) {
    const span = previous.spans[afterStart + i]!;
    spans[shifted + i] = lineDelta === 0 ? span : { ...span, line: span.line + lineDelta };
  }
  if (headSpan !== null) {
    // 交界处第一条的 5 个 uint32：从 span 现算（与 `encodeRun` 的写法逐字同一条规则）
    const previousSpan = run.spans.length > 0 ? run.spans[run.spans.length - 1]! : last;
    const headless = previousSpan === null; // 前面全删空了 ⇒ 它是整份数据的头，写绝对 0 基
    const patch = new Uint32Array(5);
    patch[0] = headless ? headSpan.line - 1 : headSpan.line - previousSpan.line;
    patch[1] =
      headless || headSpan.line !== previousSpan.line
        ? headSpan.startColumn - 1
        : headSpan.startColumn - previousSpan.startColumn;
    patch[2] = headSpan.endColumn - headSpan.startColumn;
    patch[3] = typeIndexMapOf(legend).get(headSpan.tokenType) ?? -1;
    patch[4] = modifierBitsOfBits(modifierBitsOf(legend), headSpan.modifiers, legend);
    edits.push({ start: tailAt, deleteCount: 5, data: patch });
  }
  return { edits, tokens: new LazyEncodedTokens(spans, legend) };
}

/** 一次整篇着色 = 三条贡献方各一遍单遍扫描 + 排序 + 编码，全压在**主线程**上。
 *  阈值 2026-10-28 从 5,000（照 Monaco 全文特性抄）抬到 50,000：本供方只是一趟线性扫描，
 *  24,197 行实测 43.9 ms；169,247 行那份 435 ms + 16.8 万 span 仍留在闸外。 */
export const SEMANTIC_TOKEN_MAX_LINES = HUGE_FILE_LINES;

/** 该不该为这份文档算着色（**纯函数**，与 Monaco 无关） */
export function shouldComputeSemanticTokens(lineCount: number): boolean {
  return Number.isFinite(lineCount) && lineCount > 0 && lineCount <= SEMANTIC_TOKEN_MAX_LINES;
}

/** 宿主注入：怎么问（含糖视图 / 活动标签判据 + 三态合并）——与 `FoldingRangeHandlers` 同款 */
export interface SemanticTokenHandlers {
  /**
   * `window`（R3）给了就**只有这一段**会被当作新鲜数据用（宿主按窗口过滤后拼进上一版）——
   * 供方按窗口取数就省下窗口外那两遍扫描，忽略它也只会白算，不会错。
   */
  resolve(model: Monaco.editor.ITextModel, window?: Monaco.IRange): EditorSemanticTokenSpan[];
}

/**
 * 这一门语言能不能按**变更行窗口**问供方（R3，2026-10-28）。
 *
 * 判据不是"谁快谁慢"，而是**逐行自洽**：窗口给出去之后，宿主会把窗口外的行原样留在
 * 上一版里，所以供方必须保证"一行产出什么 span 只由这一行的可见性与名录决定"。
 * ERB 满足（唯一的跨行状态 `[SKIPSTART]` 由 `skipBlockAt` 带进窗口，且窗口里一出现标记
 * 宿主就退回整篇）；`.kojo` 糖面与 `kojo2` 结构着色都是整棵语法树派生的，改一行可能
 * 影响别的行 ⇒ 不传窗口。
 *
 * **这条事实住在 descriptor 表**（`languages.ts` 的 ERB 行 `lineWindow: true`），这里只查表：
 * 宿主不认识任何具体语言名（`audit-language` M2）。表没装 / id 认不出 ⇒ 整篇（安全方向）。
 */
export function semanticTokensWindowed(languageId: string): boolean {
  return lineWindowFor(languageId);
}

/**
 * 一次变更在**新旧两套坐标**里的窗口。
 *
 * `from/to` 是新坐标（只用于"这次变更落在已累积窗口的哪一边"这种位置判断）；
 * **真正喂给拼接的是 `oldTo`**：`spliceTokenSpans` 拿它与「净行位移」一起推出窗口边界。
 * 为什么不直接存新坐标的末行：**整行删除**时新旧末行的差**不等于**行位移——删两整行
 * 是把中间那枚换行一起吃掉，行数少 2，而 `range.endLineNumber - startLineNumber` 只差 1。
 * 净行位移因此只从 `model.getLineCount()` 的前后差里取（O(1)，且天然含"空文本删整行"这一档）。
 */
interface PendingChange {
  from: number;
  to: number;
  oldTo: number;
}

/** 一份文档的着色基线：上一版数据 + 自那以后的变更窗口 */
interface TokenSession {
  resultId: string;
  /** `tokens` 对应的 `model.getVersionId()` */
  version: number;
  /** `tokens` 对应的行数（净行位移 = 现在的行数 − 它） */
  lineCount: number;
  tokens: EncodedTokens;
  /** 全文里有 `[SKIP` 标记 ⇒ 它改的是**跨行**可见性，一律整篇 */
  hasSkipMarker: boolean;
  pending: PendingChange | null;
  /** 多段变更 / flush / 事件形状不认 ⇒ 下一次只能整篇 */
  whole: boolean;
}

/** 窗口大到这个份上就不如整篇（拼接与过滤的常数开销开始显形） */
const DELTA_MAX_LINES = 5_000;
/** 跨行可见性标记的快筛子串（与 `erb-parser` 的 `SKIP_MARKER_PROBE` 同一枚） */
const SKIP_PROBE = '[SKIP';

const sessions = new WeakMap<Monaco.editor.ITextModel, TokenSession>();
let resultSeq = 0;

/** 新文本里有几行（`\n` 计一次；Monaco 已把它归一成模型 EOL） */
function newlineCount(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/**
 * 把一次内容变更并进会话的待办窗口。
 *
 * 只有**单段**变更能并（多光标 / 一次粘贴的多段：`changes` 各段的行号都相对同一份旧文本，
 * 合成一条窗口要把它们按位移串起来，错一位就是错色 ⇒ 直接整篇，代价是一次 70 ms 而不是
 * 一次错色）。`isFlush`（`setValue` / 撤销越界）同样整篇——那时 `changes` 的语义不保证。
 *
 * 合并的三种位置关系（`p` = 已累积窗口，`from/oldTo` = 这次变更在**事件前**坐标里的起止）：
 * - **落在窗口之后**：上一版坐标要减掉已累积的行位移 `p.to - p.oldTo`；
 * - **落在窗口之前**：已累积窗口整体后移这次的行增量，两侧取并；
 * - **相交**：这一段里位移恒为 0（相交意味着起点不在窗口之后），直接取并。
 */
function noteChange(session: TokenSession, event: Monaco.editor.IModelContentChangedEvent): void {
  if (session.whole) return;
  if (event.isFlush || event.changes.length !== 1) {
    session.whole = true;
    session.pending = null;
    return;
  }
  const change = event.changes[0]!;
  const from = change.range.startLineNumber;
  const oldTo = change.range.endLineNumber;
  const to = from + newlineCount(change.text);
  const p = session.pending;
  if (p === null) {
    session.pending = { from, to, oldTo };
    return;
  }
  const shift = from >= p.to ? p.to - p.oldTo : 0;
  if (from >= p.to) {
    p.to = Math.max(p.to, to);
  } else if (oldTo <= p.from) {
    const delta = to - oldTo;
    p.from += delta;
    p.to += delta;
    p.from = Math.min(p.from, from);
    p.to = Math.max(p.to, to);
  } else {
    p.from = Math.min(p.from, from);
    p.to = Math.max(p.to, to);
  }
  p.oldTo = Math.max(p.oldTo, oldTo - shift);
}

function sessionFor(model: Monaco.editor.ITextModel): TokenSession {
  const existing = sessions.get(model);
  if (existing !== undefined) return existing;
  const session: TokenSession = {
    resultId: '',
    version: -1,
    lineCount: 0,
    tokens: { data: new Uint32Array(0), spans: [] },
    hasSkipMarker: false,
    pending: null,
    // 第一份必然是整篇：还没有基线可拼
    whole: true,
  };
  sessions.set(model, session);
  if (typeof model.onDidChangeContent === 'function') {
    model.onDidChangeContent((event) => noteChange(session, event));
  }
  return session;
}

/**
 * 版本号；拿不到就 `-1`（等于「没版本概念」）。
 *
 * Monaco 的 model 一定有这个方法，但**着色面不许因为几何缺一格就掀桌子**——测试桩、
 * 跟 Monaco 对过口径的替身、将来换宿主都可能只实现了行数。拿不到版本 ⇒ 证明不了
 * 「这一版确实比上一版新」⇒ 下面的增量闸自然关上，退回整篇（结果仍然对，只是慢）。
 */
function versionOf(model: Monaco.editor.ITextModel): number {
  return typeof model.getVersionId === 'function' ? model.getVersionId() : -1;
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册语义 token provider。
 *
 * **注册与开关分离**：provider 常驻（注册两次很便宜），开关走 Monaco 自己的
 * `editor.semanticHighlighting.enabled`——standalone 的 `DocumentSemanticTokensFeature`
 * 监听那条配置项并在开/关时逐 model 挂卸着色器，所以设置页一翻就立即生效，
 * 不需要重开文件（见 `semantic-color-pref.ts` 的 `applySemanticColorPref`）。
 *
 * **增量（R3，2026-10-28）**：Monaco 0.57 把上一次的 `resultId` 传回来，并且**真的消费**
 * `{ edits }`（`documentSemanticTokens.js` 的 `isSemanticTokensEdits` 分支）。于是每次只问
 * 供方「变更窗口内那几行」，把结果拼进上一版、发一条 `edits`。判据（`semantic-token-delta.test.ts`
 * 的随机对拍）：拼出来的 `data` 必须与「每步整篇重算」逐字节相等。
 *
 * 什么情况退回整篇（一条都不猜）：没有基线 / `resultId` 对不上 / 版本没变（说明是重问，
 * 而不是编辑，索引可能已经变了）或拿不到版本号 / 多段或 flush / 窗口超过 5,000 行 /
 * 全文或窗口里出现 `[SKIP` 标记（它改的是跨行可见性）。
 *
 * 抛错不许冒到 Monaco：着色是只读呈现面，出错就"没颜色"（并 warn 出去）。
 */
export function installSemanticTokensProvider(
  monaco: typeof Monaco,
  handlers: SemanticTokenHandlers,
): Monaco.IDisposable {
  /**
   * **每门语言一枚 provider**（legend 按语言声明；Monaco 的 `getLegend()` 不带 model 参数）。
   *
   * 为什么不能只挂一枚共享 provider：legend 是 **provider 级**的，而 kojo2 的语法角色层
   * （`role.*`）与 ERB 的名字层（`function` / `variable` / `parameter`）是两套名字——把两套
   * 塞进同一份图例就是合并两个正交维度（D6 明令不许）。descriptor 声明哪套，这里就发哪套。
   */
  const providerFor = (languageId: string): Monaco.languages.DocumentSemanticTokensProvider => {
    const legend = semanticTokenLegendFor(languageId);
    return {
      getLegend: () =>
        legend === DEFAULT_LEGEND
          ? KOJO_SEMANTIC_TOKEN_LEGEND
          : { tokenTypes: [...legend.tokenTypes], tokenModifiers: [...legend.tokenModifiers] },
      provideDocumentSemanticTokens(model, lastResultId) {
        return provideForLanguage(model, lastResultId, handlers, legend);
      },
      releaseDocumentSemanticTokens: () => undefined,
    };
  };
  return registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerDocumentSemanticTokensProvider(id, providerFor(id)),
    // B3 语义收口：kojo2 由 descriptor 的 `slotServices: ['semanticToken']` 点名挂上；
    // ERB / `.kojo1` 本来就走 `languageServices: true`，这一格对它们零变化。
    'semanticToken',
  );
}

/** 一枚 provider 的请求主循环（按该语言的 legend 记账） */
function provideForLanguage(
  model: Monaco.editor.ITextModel,
  lastResultId: string | null | undefined,
  handlers: SemanticTokenHandlers,
  legend: SemanticTokenLegendSpec,
): Monaco.languages.SemanticTokens | Monaco.languages.SemanticTokensEdits {
    const session = sessionFor(model);
    const version = versionOf(model);
    const lineCount = model.getLineCount();
    const geometry = { lineCount, maxColumn: (n: number) => model.getLineMaxColumn(n) };
    const pending = session.pending;
    // 能不能只问那一小段
    let from = 0;
    let to = 0;
    /** 净行位移（窗口之后每一行平移多少）——只从行数差里取，见 `PendingChange` 头注 */
    const shift = lineCount - session.lineCount;
    if (
      pending !== null &&
      !session.whole &&
      !session.hasSkipMarker &&
      semanticTokensWindowed(model.getLanguageId()) &&
      lastResultId !== null &&
      lastResultId === session.resultId &&
      version >= 0 &&
      version > session.version &&
      typeof model.getValueInRange === 'function'
    ) {
      // 窗口末行 = 上一版坐标的末行 + 净位移；整行删除时它会落在起点之前 ⇒ 夹到起点
      to = Math.min(Math.max(1, pending.oldTo + shift), lineCount);
      from = Math.max(1, Math.min(pending.from, to));
      // 窗口里出现 `[SKIPSTART]`/`[SKIPEND]` ⇒ 后面所有行的可见性都可能变 ⇒ 整篇
      const windowText = model.getValueInRange({
        startLineNumber: from,
        startColumn: 1,
        endLineNumber: to,
        endColumn: model.getLineMaxColumn(to),
      });
      if (to - from > DELTA_MAX_LINES || windowText.includes(SKIP_PROBE)) from = 0;
    }
    if (from > 0) {
      return deltaReply(model, session, handlers, version, { from, to }, shift, geometry, legend);
    }
    return fullReply(model, session, handlers, version, geometry, legend);
}

/** 整篇：问全量 → 归一 → 编码 → 换基线 */
function fullReply(
  model: Monaco.editor.ITextModel,
  session: TokenSession,
  handlers: SemanticTokenHandlers,
  version: number,
  geometry: SemanticGeometry,
  legend: SemanticTokenLegendSpec,
): Monaco.languages.SemanticTokens {
  let spans: EditorSemanticTokenSpan[];
  try {
    spans = handlers.resolve(model);
  } catch (e: unknown) {
    console.warn(`[kojo-semantic-tokens] resolve 抛错：${errorText(e)}`);
    return { data: new Uint32Array(0) };
  }
  const normalized = normalizeSemanticSpans(spans, geometry);
  if (normalized.droppedLines + normalized.droppedEmpty > 0) {
    console.warn(
      `[kojo-semantic-tokens] ${model.uri.toString()} 丢掉 ${normalized.droppedLines} 条越界行 / ` +
        `${normalized.droppedEmpty} 条空区间（陈旧或列口径不符）`,
      spans,
    );
  }
  const tokens = encodeTokenSpans(normalized.spans, legend);
  session.tokens = tokens;
  session.version = version;
  session.lineCount = geometry.lineCount;
  session.resultId = `st${++resultSeq}`;
  session.hasSkipMarker = model.getValue().includes(SKIP_PROBE);
  session.pending = null;
  session.whole = false;
  return { data: tokens.data, resultId: session.resultId };
}

/** 增量：只问窗口那几行 → 拼进上一版 → 发一条（最多两条）`edits` */
function deltaReply(
  model: Monaco.editor.ITextModel,
  session: TokenSession,
  handlers: SemanticTokenHandlers,
  version: number,
  window: { from: number; to: number },
  shift: number,
  geometry: SemanticGeometry,
  legend: SemanticTokenLegendSpec,
): Monaco.languages.SemanticTokensEdits {
  const range = {
    startLineNumber: window.from,
    startColumn: 1,
    endLineNumber: window.to,
    endColumn: model.getLineMaxColumn(window.to),
  };
  let spans: EditorSemanticTokenSpan[];
  try {
    // 供方忽略窗口也不会错：下面这一刀把窗外的一律丢掉，窗外本来就没变
    spans = handlers.resolve(model, range).filter((s) => s.line >= window.from && s.line <= window.to);
  } catch (e: unknown) {
    console.warn(`[kojo-semantic-tokens] resolve 抛错（窗口）：${errorText(e)}`);
    return { edits: [], resultId: session.resultId };
  }
  const normalized = normalizeSemanticSpans(spans, geometry);
  const spliced = spliceTokenSpans(session.tokens, window, normalized.spans, shift, legend);
  session.tokens = spliced.tokens;
  session.version = version;
  session.lineCount = geometry.lineCount;
  session.resultId = `st${++resultSeq}`;
  session.pending = null;
  session.whole = false;
  return { resultId: session.resultId, edits: spliceEdits(spliced.edits) };
}

/** 宿主形状 → Monaco 的 `SemanticTokensEdit[]`（同形；这一层只做类型搬运，不加工） */
function spliceEdits(edits: readonly SemanticTokensEdit[]): Monaco.languages.SemanticTokensEdit[] {
  return edits.map((edit) =>
    edit.data === undefined ? { start: edit.start, deleteCount: edit.deleteCount } : { start: edit.start, deleteCount: edit.deleteCount, data: edit.data },
  );
}
