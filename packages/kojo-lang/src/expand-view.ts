/**
 * Kojo 2.0 **展开视图**（K2-EXPAND-VIEW / 设计稿 §16.7 U6.5）：DSL ↔ ERB 双向定位。
 *
 * ## 这一层回答什么
 *
 * 光标停在一处（`.kojo2` 源坐标，或**产物坐标**——见 {@link Kojo2ExpandQuery.side}），
 * 回答"这里是不是一次模板 / 池 / 随机展开；是的话，调用处、定义处、这次展开产出了哪几行"。
 * 返回值是可判别联合：命中 = {@link Kojo2ExpandView}，不命中 = 显式 `{ kind: 'none' }`
 * （**不猜**：没有 source map 事实就是没有，绝不拿邻居行 / 邻居展开凑一个出来）。
 *
 * ## 事实来源（三档，全部来自 core 已登记的映射，不另解析语法）
 *
 * 1. **模板 / 池的双向锚点**：batch-4 的 source map 把展开产物行登记成
 *    `kind: 'template' | 'pool'` + `origins`，且**顺序写死** `[call-site, 定义处]`
 *    （`lower/expand/frame.ts` 的 `expansionFrame`；嵌套展开逐层追加，外层在前）。
 *    本层只按这个顺序**配对**读（`call-site` 后面紧跟它的定义锚点），不假设"定义了就有源"。
 * 2. **随机块**：core **没有** `random` 这个 source map 类别（`@随机` 的候选行统一归到块头
 *    span，`lower/state.ts` 的 `lowerIntoChildLines`），所以随机的判据是**两条事实之和**：
 *    产物行的主映射是一个**跨行 span**，且该 span 的块头行在词法上一枚 `@随机` 调度行
 *    （`KOJO_DISPATCH_WORDS` 的 `随机`）。两条缺一 ⇒ `none`（不猜"跨行 span 就是随机"）。
 * 3. **产物行区间**：模板/池 = 锚点相同的产物行取最小..最大行（中间行属于同一段展开）；
 *    随机 = 主映射恰为块 span 的产物行。
 *
 * ## 与 Monaco 的分界
 *
 * 本文件是**纯逻辑**：零 Monaco 运行时、零 IO、零注册（行列 1 基、UTF-16，与 core / Monaco 同口径）。
 * "翻译成 `Hover` / `LocationLink`" 全部留在 `kojo2-providers.ts`：那里把 {@link expandViewMarkdown}
 * 的 `{ value }`（Monaco `IMarkdownString` 结构兼容）追加进**同一个** hover provider 的 contents，
 * 并把同一个结果的 `callSite` / `definition` 翻成两条 LocationLink。**不新造第二个 HoverProvider**
 * （Monaco 多 provider 的合并顺序不可控）。
 *
 * ## 失败面
 *
 * 任何取不到事实的路径都返回 `none`，**不抛**：位置不是正整数 / 产物为空 / 该行列没有映射 /
 * 锚点配不成对 / 产物行区间落空。宿主因此永远可以安全地把它挂进 hover / definition 的应答里。
 *
 * ## 已知边界
 *
 * - **随机块的长度依赖源文**：`@随机` 的块 span 来自 source map（跨行），但"这个 span 的块头是不是
 *   `@随机`"要读词法。所以 `expandViewAt(compiled, sourceMapModel, position)`（不传
 *   `query.source`）**永远不会**命中随机块——这是刻意的：宁可 `none`，也不凭"跨行 span"猜。
 * - **名字同样来自源文**（调用行的 `!` 触发词 / 定义行的声明头）：不传源文时 `name: null`，
 *   Markdown 只说`模板` / `池`，不编名字。
 * - 源文的词法遍历**惰性且至多一次**：只有"锚点已命中"（取名字）或"有跨行主映射"（判随机块头）
 *   时才读源文；普通文本 / 声明 / 注释行一行源文都不多读。这一条与 `kojo2-hover.ts` 自己的
 *   词法遍历互不复用（那一层的入口不暴露中间产物）；真到"大文件悬停卡顿"程度再合并，
 *   方向是把 `kojo2DocumentOf` 的结果注入进来，而不是在这里加缓存。
 * - 产物行区间是**最小..最大行**的包络：嵌套展开（池的分支里再调模板）时外层包络包含内层产物行，
 *   这正是一次展开"产出了哪几行"的答案；内层自己另有更小的包络（锚点不同）。
 */
import type { KojoLexLine, KojoPosition, KojoSpan, SourceMapLine } from '@kojo/kojo-core';
import { KOJO_DECL_WORDS, KOJO_DISPATCH_WORDS, comparePositions, lex } from '@kojo/kojo-core';
import type { Kojo2SourceMapModel } from './sourcemap';
import { splitKojo2GeneratedLines } from './sourcemap';

/* ============================== 类型 ============================== */

/** 一次编译里展开视图真正需要的两格（`Kojo2PreviewCompilation` 结构兼容） */
export interface Kojo2ExpandCompilation {
  readonly compiled: { readonly erb: string };
  readonly sourceMapModel: Kojo2SourceMapModel;
}

/** 展开的三种来源（与 core source map 的类别不是一一对应：`random` 不由 source map 类别给出） */
export type Kojo2ExpandKindTag = 'template' | 'pool' | 'random';

/**
 * 光标是怎么**命中**这次展开的（宿主据此决定"要不要在悬停里追加展开段"）：
 * - `call-site`：光标在调用行上（模板 / 池的 `! 名` 行、随机块头行）；
 * - `definition`：光标在展开体的**源行**上（模板 / 池定义体的那一行、随机块的候选行）——
 *   源坐标下"展开产物行"的落点；`kojo2-definition.ts` 只对这一档追加两条跳转；
 * - `generated`：调用方声明了产物坐标（`side: 'generated'`），光标直接在产物行上。
 */
export type Kojo2ExpandVia = 'call-site' | 'definition' | 'generated';

/** 这次展开的产物行区间（1 基、闭区间；`lines` 与 `startLine..endLine` 逐行对应） */
export interface Kojo2ExpandGenerated {
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly string[];
}

/** 命中一次展开（可判别联合的 `expand` 支） */
export interface Kojo2ExpandView {
  readonly kind: 'expand';
  readonly kindTag: Kojo2ExpandKindTag;
  /** 模板 / 池的名字（无源文 / 词法给不出 ⇒ `null`，Markdown 不编名字）；随机恒为 `null` */
  readonly name: string | null;
  /** 调用处 span（调用语句 / 随机块头行） */
  readonly callSite: KojoSpan;
  /**
   * 定义处 span：
   * - 模板 / 池 = `template-definition` / `pool-definition` 锚点（声明头到体末的整段）；
   * - 随机 = **块本身**（随机块是内联的，没有具名定义；块头行即调用处）。
   */
  readonly definition: KojoSpan;
  readonly generated: Kojo2ExpandGenerated;
  readonly via: Kojo2ExpandVia;
}

/** 显式"这里没有展开事实"（**不是**"还没算"） */
export interface Kojo2NoExpandView {
  readonly kind: 'none';
}

export type Kojo2ExpandViewResult = Kojo2ExpandView | Kojo2NoExpandView;

/** 不命中的单例（避免每轮造对象；调用方只读，不会写它） */
export const KOJO2_NO_EXPAND_VIEW: Kojo2NoExpandView = Object.freeze({ kind: 'none' });

/** 查询旁注（都可缺省：缺省 = 源坐标 + 不读源文） */
export interface Kojo2ExpandQuery {
  /**
   * `position` 在哪个坐标空间。
   *
   * 同一对行列在两个空间都合法（源 5:3 与产物 5:3 都可能是真位置），**判据必须由调用方给**：
   * 本层不猜"这行号在哪个空间更像"——猜错就会把产物行列当源码行去查锚点。
   */
  readonly side?: 'kojo' | 'generated';
  /** `.kojo2` 源文（随机块判据与名字的唯一来源；缺省 ⇒ 随机恒 `none`、`name: null`） */
  readonly source?: string;
}

/** 与 Monaco `IMarkdownString` 结构兼容（`Hover.contents` 直接收；不依赖 Monaco 运行时） */
export interface Kojo2ExpandMarkdown {
  readonly value: string;
}

/* ============================== 常量 ============================== */

/** core 声明词位序（`tokens.ts` §3.3）：`池` / `模` —— 只取词，不写字形 */
const POOL_WORD: string = KOJO_DECL_WORDS[6];
const TEMPLATE_WORD: string = KOJO_DECL_WORDS[7];

/** core 调度词位序（`tokens.ts` §2.1）：`随机` */
const RANDOM_WORD: string = KOJO_DISPATCH_WORDS[3];

/** 行查询的"整行"右界（源列是正整数，给一个大到不可能被越过的整数即可） */
const LINE_END_COLUMN = 1_000_000_000;

const EMPTY_PAIRS: readonly FramePair[] = Object.freeze([]);
const EMPTY_LINES: readonly string[] = Object.freeze([]);

/* ============================== 位置 / span 小工具 ============================== */

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function isValidPosition(position: KojoPosition): boolean {
  return isPositiveInteger(position.line) && isPositiveInteger(position.column);
}

function sameSpan(a: KojoSpan, b: KojoSpan): boolean {
  return comparePositions(a.start, b.start) === 0 && comparePositions(a.end, b.end) === 0;
}

/** `outer` 是否整段罩住 `inner`（含相等） */
function spanContainsSpan(outer: KojoSpan, inner: KojoSpan): boolean {
  return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

/** 行号是否落在 span 的行区间内（闭区间；随机块判据用行级，因为块 span 的列只在首尾行有意义） */
function spanCoversLine(span: KojoSpan, line: number): boolean {
  return span.start.line <= line && line <= span.end.line;
}

/* ============================== 词法（随机判据 / 名字） ============================== */

/**
 * 源文 → 逻辑行表（**只在传了源文时**发生；纯函数，失败 = `null` 不抛）。
 *
 * 消费方只有两处：随机块头是不是 `@随机`、模板 / 池的名字（调用行的 `!` 触发词优先，
 * 定义行的声明头兜底）。这**不是**第二份语法判读：判据词取自 core 的
 * `KOJO_DECL_WORDS` / `KOJO_DISPATCH_WORDS`，块 span 与产物行仍只来自 source map。
 */
function lexLinesOf(source: string | undefined): readonly KojoLexLine[] | null {
  if (typeof source !== 'string' || source.length === 0) return null;
  try {
    return lex(source).lines;
  } catch {
    return null;
  }
}

/** 词法表的**惰性**取用（同一次查询只读一次源文） */
type LexLines = () => readonly KojoLexLine[] | null;

/**
 * 惰性词法：绝大多数悬停落点与展开无关（普通文本、声明、注释），那些轮次一行源文都不该多读。
 * 真正的消费者只有两处——随机块头判定（候选行有跨行 span 时才问）与名字（锚点命中后才问）。
 */
function lazyLexLines(source: string | undefined): LexLines {
  let cached: readonly KojoLexLine[] | null | undefined;
  return () => {
    if (cached === undefined) cached = lexLinesOf(source);
    return cached;
  };
}

/* ============================== 锚点配对 ============================== */

/** 一次展开的一对锚点（`origins` 里 `call-site` 与其后紧跟的定义锚点） */
interface FramePair {
  readonly kindTag: 'template' | 'pool';
  readonly callSite: KojoSpan;
  readonly definition: KojoSpan;
}

/**
 * 产物行的 origins → 锚点对（顺序 = 帧的嵌套顺序：外层在前）。
 *
 * 只按 `[call-site, 定义锚点]` 的**相邻**关系配对：这是 core `frame.ts` 写死的发射顺序，
 * 也是嵌套合并（`mergeOrigins`）后唯一能还原"哪一对属于哪一层"的形状。配不成对 = 这一行
 * 不给展开事实（`source map` 的 `template` / `pool` 行必须两个锚点都在，core 的 builder 已强制）。
 */
function framePairsOf(mapping: SourceMapLine | null): readonly FramePair[] {
  if (mapping === null) return EMPTY_PAIRS;
  const origins = mapping.origins;
  if (origins.length < 2) return EMPTY_PAIRS;
  let pairs: FramePair[] | null = null;
  for (let index = 0; index + 1 < origins.length; index++) {
    const call = origins[index]!;
    if (call.kind !== 'call-site') continue;
    const definition = origins[index + 1]!;
    if (definition.kind === 'template-definition') {
      (pairs ??= []).push({ kindTag: 'template', callSite: call.span, definition: definition.span });
    } else if (definition.kind === 'pool-definition') {
      (pairs ??= []).push({ kindTag: 'pool', callSite: call.span, definition: definition.span });
    }
  }
  return pairs ?? EMPTY_PAIRS;
}

/** 命中的锚点（外加它是怎么被找到的） */
interface ExpandAnchor {
  readonly kindTag: Kojo2ExpandKindTag;
  readonly callSite: KojoSpan;
  readonly definition: KojoSpan;
  readonly via: Kojo2ExpandVia;
}

/** 这一对锚点是不是同一次展开：调用处 + 定义处行列全等（不含 kindTag——锚点对已决定种类） */
function pairMatchesAnchor(pair: FramePair, callSite: KojoSpan, definition: KojoSpan): boolean {
  return sameSpan(pair.callSite, callSite) && sameSpan(pair.definition, definition);
}

/**
 * 多档命中里取**最内层**（定义 span 被别人的定义 span 罩住者胜）。
 *
 * 嵌套展开（池的分支里调模板）会让同一行涉及两层：光标要的是**最贴近它**的那一层——
 * 内层模板的产物行，而不是外层池的整段包络。兄弟关系（互不包含）保持先到者，不另编序。
 */
function innermost(anchors: readonly ExpandAnchor[]): ExpandAnchor | null {
  if (anchors.length === 0) return null;
  let best = anchors[0]!;
  for (let index = 1; index < anchors.length; index++) {
    const candidate = anchors[index]!;
    if (sameSpan(candidate.definition, best.definition)) continue;
    if (spanContainsSpan(best.definition, candidate.definition)) best = candidate;
  }
  return best;
}

/* ============================== 随机块锚点 ============================== */

/**
 * 跨行主映射 → 随机块锚点（两条事实都成立才算：块头行是 `@随机` 调度行）。
 *
 * `callSite` = **块头行**（列区间取自词法记录，含缩进之后的第一个字符到行内容末）；
 * `definition` = 块 span 本身。随机块没有具名定义——它是内联的，所以两格都指向同一块，
 * 只是一格是"行"（跳过去落在块头），一格是"块"（整段高亮）。
 */
function randomAnchorOf(
  blockSpan: KojoSpan,
  cursorLine: number,
  lexLines: LexLines,
  via: Kojo2ExpandVia,
): ExpandAnchor | null {
  const lines = lexLines();
  if (lines === null) return null;
  const header = lines[blockSpan.start.line - 1];
  if (header === undefined || header.kind !== 'dispatch') return null;
  if (header.word !== RANDOM_WORD) return null;
  const startColumn = header.contentOffset - header.lineOffset + 1;
  const endColumn = header.contentEnd - header.lineOffset + 1;
  const callSite: KojoSpan = {
    start: { line: blockSpan.start.line, column: startColumn },
    end: { line: blockSpan.start.line, column: endColumn > startColumn ? endColumn : startColumn + 1 },
  };
  return {
    kindTag: 'random',
    callSite,
    definition: blockSpan,
    via: cursorLine === blockSpan.start.line ? 'call-site' : via,
  };
}

/* ============================== 源坐标：发现 ============================== */

/**
 * 源坐标 → 命中的展开锚点。
 *
 * 三条判据（按优先级；全部要求 source map 有事实，任何一条都不成立 ⇒ `null`）：
 * 1. **调用行**：某条产物行的锚点对里，`call-site` span 的行区间罩住光标行；
 * 2. **随机块**：某条产物行的主映射是跨行 span，且该 span 的块头行词法上是 `@随机`；
 * 3. **展开体源行**：某条产物行的主映射是**单行** span 且就在光标行上，锚点对的 `definition`
 *    罩住光标行（块头 / `ENDIF` 那类"包装行"的主映射是跨行的，故意不认——它们不是某一行
 *    的展开体，认了会让声明行 / 块头行凭空多出展开段）。
 */
function anchorOnSourceLine(
  sourceMapModel: Kojo2SourceMapModel,
  position: KojoPosition,
  lexLines: LexLines,
): ExpandAnchor | null {
  let ranges: readonly { readonly generatedLine: number; readonly via: 'source' | 'origin'; readonly source: KojoSpan }[];
  try {
    ranges = sourceMapModel.generatedInRange(
      { line: position.line, column: 1 },
      { line: position.line, column: LINE_END_COLUMN },
    );
  } catch {
    return null;
  }
  const onCallSites: ExpandAnchor[] = [];
  const onDefinitions: ExpandAnchor[] = [];
  const randomSpans: KojoSpan[] = [];

  for (const range of ranges) {
    const mapping = sourceMapModel.lineAt(range.generatedLine);
    if (mapping === null) continue;
    for (const pair of framePairsOf(mapping)) {
      if (spanCoversLine(pair.callSite, position.line)) {
        onCallSites.push({ ...pair, via: 'call-site' });
      }
      if (
        mapping.source !== null &&
        mapping.source.start.line === position.line &&
        mapping.source.end.line === position.line &&
        spanCoversLine(pair.definition, position.line)
      ) {
        onDefinitions.push({ ...pair, via: 'definition' });
      }
    }
    const main = mapping.source;
    if (
      range.via === 'source' &&
      main !== null &&
      main.start.line < main.end.line &&
      spanCoversLine(main, position.line)
    ) {
      randomSpans.push(main);
    }
  }

  const callSiteHit = innermost(onCallSites);
  if (callSiteHit !== null) return callSiteHit;

  for (const span of randomSpans) {
    const random = randomAnchorOf(span, position.line, lexLines, 'definition');
    if (random !== null) return random;
  }
  return innermost(onDefinitions);
}

/**
 * 产物坐标 → 命中的展开锚点（`side: 'generated'`）。
 *
 * - 该产物行有锚点对 ⇒ 取**最内层**那一对（嵌套时产物行的主映射落在内层定义体上，
 *   所以内层才是"这一行是谁展开出来的"）；
 * - 该产物行的主映射是跨行 span 且块头是 `@随机` ⇒ 随机块。
 */
function anchorOnGeneratedLine(
  sourceMapModel: Kojo2SourceMapModel,
  position: KojoPosition,
  lexLines: LexLines,
): ExpandAnchor | null {
  const mapping = sourceMapModel.lineAt(position.line);
  if (mapping === null) return null;
  const pairs = framePairsOf(mapping);
  if (pairs.length > 0) {
    const innermostPair = pairs[pairs.length - 1]!;
    return { ...innermostPair, via: 'generated' };
  }
  const main = mapping.source;
  if (main !== null && main.start.line < main.end.line) {
    return randomAnchorOf(main, position.line, lexLines, 'generated');
  }
  return null;
}

/* ============================== 产物行区间 ============================== */

/** 按产物行号升序取包络（`lines` 与区间逐行对应；越界行被丢掉，不会造出空行） */
function envelopeOf(
  generatedLines: readonly string[],
  hitLines: readonly number[],
): Kojo2ExpandGenerated | null {
  let startLine = Number.POSITIVE_INFINITY;
  let endLine = 0;
  for (const line of hitLines) {
    if (!Number.isInteger(line) || line < 1 || line > generatedLines.length) continue;
    if (line < startLine) startLine = line;
    if (line > endLine) endLine = line;
  }
  if (endLine === 0 || startLine === Number.POSITIVE_INFINITY) return null;
  const lines = generatedLines.slice(startLine - 1, endLine);
  return { startLine, endLine, lines: lines.length === 0 ? EMPTY_LINES : lines };
}

/**
 * 模板 / 池：锚点相同的产物行包络。
 *
 * 查询用**调用处 span**（精确区间，不整行）：产物行的 origins 里那一对锚点逐字相等，
 * 所以这个查询既能命中本层产物行，也不会把同一行上的别的展开（兄弟调用）算进来。
 * 嵌套展开时内层产物行同样带着外层锚点，因此会落进外层包络——那正是一次展开的完整产物。
 */
function expansionProducts(
  sourceMapModel: Kojo2SourceMapModel,
  anchor: ExpandAnchor,
  generatedLines: readonly string[],
): Kojo2ExpandGenerated | null {
  let ranges: readonly { readonly generatedLine: number }[];
  try {
    ranges = sourceMapModel.generatedInRange(anchor.callSite.start, anchor.callSite.end);
  } catch {
    return null;
  }
  const hitLines: number[] = [];
  for (const range of ranges) {
    const mapping = sourceMapModel.lineAt(range.generatedLine);
    const pairs = framePairsOf(mapping);
    if (pairs.some((pair) => pairMatchesAnchor(pair, anchor.callSite, anchor.definition))) {
      hitLines.push(range.generatedLine);
    }
  }
  return envelopeOf(generatedLines, hitLines);
}

/** 随机块：主映射恰为块 span 的产物行包络 */
function randomProducts(
  sourceMapModel: Kojo2SourceMapModel,
  anchor: ExpandAnchor,
  generatedLines: readonly string[],
): Kojo2ExpandGenerated | null {
  let ranges: readonly { readonly generatedLine: number; readonly via: 'source' | 'origin' }[];
  try {
    ranges = sourceMapModel.generatedInRange(anchor.definition.start, anchor.definition.end);
  } catch {
    return null;
  }
  const hitLines: number[] = [];
  for (const range of ranges) {
    if (range.via !== 'source') continue;
    const mapping = sourceMapModel.lineAt(range.generatedLine);
    if (mapping === null || mapping.source === null) continue;
    if (sameSpan(mapping.source, anchor.definition)) hitLines.push(range.generatedLine);
  }
  return envelopeOf(generatedLines, hitLines);
}

/* ============================== 名字 ============================== */

/** 模板 / 池的名字：调用行的 `!` 触发词优先，定义行的声明头兜底；都给不出 = `null`（不编） */
function nameOf(anchor: ExpandAnchor, lexLines: LexLines): string | null {
  const lines = lexLines();
  if (lines === null) return null;
  const call = lines[anchor.callSite.start.line - 1];
  if (call !== undefined && call.kind === 'trigger' && call.name.length > 0) return call.name;
  const definition = lines[anchor.definition.start.line - 1];
  if (definition === undefined || definition.kind !== 'decl') return null;
  if (definition.word !== TEMPLATE_WORD && definition.word !== POOL_WORD) return null;
  const open = definition.rest.indexOf('(');
  const head = (open >= 0 ? definition.rest.slice(0, open) : definition.rest).trim();
  const first = head.split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : null;
}

/* ============================== 入口 ============================== */

/**
 * 光标处的展开视图（**纯函数**）。
 *
 * 参数口径：
 * - `compiled` 只读 `erb`（产物行文本；与 `sourceMapModel` 必须来自**同一次**编译，
 *   否则行号会错位——本层不做行数校验，那是预览模型在装配处的守卫）；
 * - `sourceMapModel` 是 batch-4 的宿主查询面（唯一的位置换算口径）；
 * - `position` 1 基行列；`query.side` 缺省 `'kojo'`（源坐标），`query.source` 缺省不读源文
 *   （⇒ 随机恒 `none`、`name: null`，见文件头「已知边界」）。
 *
 * 不命中一律 {@link KOJO2_NO_EXPAND_VIEW}，**不抛**。
 */
export function expandViewAt(
  compiled: { readonly erb: string },
  sourceMapModel: Kojo2SourceMapModel,
  position: KojoPosition,
  query: Kojo2ExpandQuery = {},
): Kojo2ExpandViewResult {
  if (!isValidPosition(position)) return KOJO2_NO_EXPAND_VIEW;
  if (typeof compiled.erb !== 'string') return KOJO2_NO_EXPAND_VIEW;

  let generatedLines: readonly string[];
  try {
    generatedLines = splitKojo2GeneratedLines(compiled.erb);
  } catch {
    return KOJO2_NO_EXPAND_VIEW;
  }
  if (generatedLines.length === 0) return KOJO2_NO_EXPAND_VIEW;

  const lexLines = lazyLexLines(query.source);
  const side = query.side ?? 'kojo';
  const anchor =
    side === 'generated'
      ? anchorOnGeneratedLine(sourceMapModel, position, lexLines)
      : anchorOnSourceLine(sourceMapModel, position, lexLines);
  if (anchor === null) return KOJO2_NO_EXPAND_VIEW;

  const generated =
    anchor.kindTag === 'random'
      ? randomProducts(sourceMapModel, anchor, generatedLines)
      : expansionProducts(sourceMapModel, anchor, generatedLines);
  if (generated === null) return KOJO2_NO_EXPAND_VIEW;

  return {
    kind: 'expand',
    kindTag: anchor.kindTag,
    name: anchor.kindTag === 'random' ? null : nameOf(anchor, lexLines),
    callSite: anchor.callSite,
    definition: anchor.definition,
    generated,
    via: anchor.via,
  };
}

/* ============================== Markdown ============================== */

/** 种类文案（Markdown 里唯一一份；`模板` / `池` / `随机块`） */
const KIND_LABEL: Readonly<Record<Kojo2ExpandKindTag, string>> = Object.freeze({
  template: '模板',
  pool: '池',
  random: '随机块',
});

/** `第 8 行` / `第 8–9 行`（产物行区间的可读形状；区间闭合） */
function lineRangeText(startLine: number, endLine: number): string {
  return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}–${endLine} 行`;
}

/**
 * 展开视图 → Markdown（Monaco `IMarkdownString` 结构兼容）。
 *
 * 形状（写死，测试钉字段）：
 * ```
 * **模板 退场**
 * 定义处：第 8 行 · 调用处：第 13 行
 * 展开产物：第 8–9 行（2 行）
 * ```erb
 * …
 * ```
 * ```
 * - 随机块的第二行是 `块头：第 24 行`（内联块没有具名定义）；
 * - **不放跳转指令**：`跳回调用处 / 定义处` 由宿主承担（`kojo2-providers.ts` 的
 *   `kojo2DefinitionLinksOf` 那两条 LocationLink + 编辑器既有导航）；悬停里塞命令只会让
 *   作者在只读气泡上找按钮。
 */
export function expandViewMarkdown(view: Kojo2ExpandView): Kojo2ExpandMarkdown {
  const title = view.name === null ? KIND_LABEL[view.kindTag] : `${KIND_LABEL[view.kindTag]} ${view.name}`;
  const count = view.generated.endLine - view.generated.startLine + 1;
  const where =
    view.kindTag === 'random'
      ? `块头：第 ${view.callSite.start.line} 行`
      : `定义处：第 ${view.definition.start.line} 行 · 调用处：第 ${view.callSite.start.line} 行`;
  return {
    value: [
      `**${title}**`,
      where,
      `展开产物：${lineRangeText(view.generated.startLine, view.generated.endLine)}（${count} 行）`,
      '```erb',
      view.generated.lines.join('\n'),
      '```',
    ].join('\n'),
  };
}
