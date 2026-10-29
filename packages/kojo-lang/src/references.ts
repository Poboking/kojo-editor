/**
 * Kojo 2.0 **查找全部引用**（K2-LSP-REFS）：同文件符号 → 全部可证出现点（Shift+F12）。
 *
 * ## 这一格为什么在包里（B3e，2026-10-29）
 *
 * 本文件原住 `app/src/monaco/kojo2-references.ts`。B3e 把**判据**整块搬到这里，
 * 作答的改为插件 `@kojo/plugin-kojo-lang` 在 `ui.editor.languageService` 槽里登记的
 * `kojo2-references` 贡献；宿主那侧只剩"model → 请求"与"契约 → Monaco Location"。
 * 搬动是**逐字**的：判据顺序、上限、扫描器一个字符没改（唯一的差异是 import 面——
 * 字符集从同包 `name-chars` 取、文档索引从同包 `declarations` 取，不再经宿主）。
 *
 * ## 回答什么
 *
 * {@link kojo2ReferencesAt} 是**纯函数**：源码 + 1 基行列进，符号事实 + 出现点列表出。
 * 符号面覆盖本批语义层的全部声明形态：
 * - `@函` / `# 对照表` / `# 池` / `# 模` / `# 变量` / `# 常量`（声明索引与 `declarations.ts` 同一份）；
 * - `# 幕` **整段标题**（标题里可以有空格，区间覆盖整段）；
 * - `# 机` / `@织` 的**事件名**——两者是同一条事件符号的两种挂点：`# 机` 是声明
 *   （`decl`），`@织` 是监听引用（`ref`）。本文件没有 `# 机` 时以**最早一条 `@织`** 作
 *   声明锚点（本文件唯一可证的位置；不假造声明，也不因此把监听点升格成声明——`refs` 里
 *   它仍是 `ref`）。
 *
 * ## 只认可证位（防误报是这一层的硬指标）
 *
 * 引用只在**语法上确实是表达式 / 调用 / 插值**的位置收集：
 * - 叙事正文的 `{…}` 插值（台词 / 旁白 / 裸引号 / 转义行 / `# 模` 体）；正文纯文本不扫；
 * - `! 名` / `! 名(实参)` 的调用名与实参表达式；
 * - `? <条件>` 的条件表达式、`@巡` / `@循` / `@复` 的头表达式、`@返` 的返回值表达式、
 *   `@着色` 的颜色表达式、`# 变量` 类型里的 `[<数组长度>]`；
 * - `# 对照表 … 依据 <表达式>` 的 `依据` 之后（表体行是字面量，不扫）；
 *   **例外（2026-10-26 批）**：表体行的**范围端点**是表达式位（core AST 的
 *   `from` / `to`，只允许十进制字面量或整数 `# 常量`）——改名会改写它们，引用就必须能看见；
 *   值列仍是字面量，不扫。
 * - `@算` / `@函` 块体内的调度语句（赋值两侧、裸调用）；
 * - **跳过**：双引号字符串（含转义）、`对象.成员` 的成员名、纯数字串、注释行、
 *   `@原生` 围栏体、旧写法行、`# 视` / `# 机` 参数 / `@织` 修饰词这类字面词位。
 *
 * 名字比对是**名字级**（与 `kojo2DefinitionAt` 的 `kojo2DeclarationNamed` 同口径）：同名重复
 * 声明本身是 core 错误，编辑器在错误态下仍按"离引用最近的**前面**那条声明"归属符号。
 *
 * ## 上限
 *
 * 单次结果最多 {@link KOJO2_REFERENCE_LIMIT} 条（源码序前 N 条）；被截掉时 `truncated = true`
 * 显式告诉宿主"这是截断后的列表"，绝不静默少给。声明通常写在文件头，因此前 N 条一般包含
 * 声明位；真被截掉时也由 `truncated` 说清。
 *
 * ## 跨文件（K2-INDEX-REFS → B3e 快照口）
 *
 * - {@link kojo2ReferenceSymbolsOf} 把同一套判据摊成"整篇的每个符号"；
 * - {@link kojo2ProjectReferencesAt} 把本文件结果与一份项目索引的跨文件结果合并（声明位在前）；
 * - {@link kojo2ReferencesInProjectFiles} 是 B3e 给插件用的**快照口**：项目文件由宿主按请求
 *   递进来（`projectFiles`），本文件用同一套 per-file 事实建一张**临时**索引再走上面同一条
 *   合并判据。临时索引的查询规则逐条照 `app/src/monaco/kojo2-project-index.ts`（那边是宿主
 *   的常驻缓存层；这里只是把"文件集"换成"一批快照"，尺子不变）。
 *
 * ## 已知边界
 *
 * - 跨文件查找有两档归属：本文件有同名声明（或事件挂点）时走同文件判据；本文件没有时走
 *   项目索引的候选位 + `symbolAt`（要求 `options.path`，且项目里这个名字**只有一种**
 *   声明种类）——同名多家族是 core 错误，此时回 `null`，不猜；
 * - 表体行端点（`# 对照表` 的 `0..99`）此前不收集，而 `rename.ts` 按 core AST 会改写
 *   `from` / `to` 里的常量（§6.1 的端点就是表达式位）⇒ 两把尺子不一致。本批让 references
 *   覆盖同一集合：端点里**名字形态**的标识符（整数常量）进 refs，数字端点与值列不进。
 * - `# 视` 的视角目标、`@跳` / `@标` 的标签名不属本批符号面（没有声明索引可归属）。
 */
import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_INDENT_WIDTH,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
  isSpaceCode,
  skipQuoted,
  splitSpaces,
  type KojoLexLine,
  type KojoTextFields,
} from '@kojo/kojo-core';
import {
  kojo2DocumentOf,
  type Kojo2DeclarationKind,
  type Kojo2Document,
} from './declarations';
import { kojo2EventSitesOf, type Kojo2EventSite } from './event-sites';
import { isNameChar } from './name-chars';

/* ============================== 词形（core 单源） ============================== */

/** `# 对照表` / `# 变量` 的声明词（core 位序 §3.3） */
const TABLE_WORD = KOJO_DECL_WORDS[5];
const VARIABLE_WORD = KOJO_DECL_WORDS[3];

/** `@函`（core `KOJO_DISPATCH_WORDS` 位序 §2.1）；`@织` 的判据已随事件挂点搬进 `event-sites` */
const FUNCTION_WORD = KOJO_DISPATCH_WORDS[8];

/**
 * 块头之后是**表达式**的调度词：`@着色`（颜色表达式）/ `@循` / `@复` / `@巡` / `@返`。
 * 其余 `@` 头的尾巴是字面词位（`@颜绘` 的对象与表情词、`@标` / `@跳` 的标签），不扫。
 */
const EXPRESSION_DISPATCH_WORDS: ReadonlySet<string> = new Set<string>([
  KOJO_DISPATCH_WORDS[1]!,
  KOJO_DISPATCH_WORDS[5]!,
  KOJO_DISPATCH_WORDS[6]!,
  KOJO_DISPATCH_WORDS[7]!,
  KOJO_DISPATCH_WORDS[12]!,
]);

/** 块体是**调度语句**（表达式 / 赋值 / 调用）的块头：只有它们的直接体行要整行扫 */
const EXPRESSION_BLOCK_WORDS: ReadonlySet<string> = new Set<string>([KOJO_DISPATCH_WORDS[0]! /* 算 */, FUNCTION_WORD]);

/* ============================== 公共形状 ============================== */

/**
 * 符号种类：声明索引的七类 + `event`（`# 机` / `@织` 的事件名）。
 * `event` 不借用任何一种声明种类：事件名不是变量 / 函数，它挂在 adapter 的事件目录上。
 */
export type Kojo2ReferenceSymbolKind = Kojo2DeclarationKind | 'event';

/** 查询位（1 基行列；与 Monaco / core / plugin-api 同口径） */
export interface Kojo2ReferencePosition {
  readonly line: number;
  readonly column: number;
}

/** 1 基半开区间（`endColumn` 是尾字符的**后一位**；与 Monaco `IRange` 同口径） */
export interface Kojo2ReferenceSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** 被查符号：名字 / 种类 / 声明锚点（`# 幕` = 整段标题；事件 = `# 机` 或最早 `@织`） */
export interface Kojo2ReferenceSymbol {
  readonly name: string;
  readonly kind: Kojo2ReferenceSymbolKind;
  readonly declSpan: Kojo2ReferenceSpan;
}

/** 出现点的语义角色：声明 / 普通引用 / 调用（`! 名` 与 `名(` 两种调用形态） */
export type Kojo2ReferenceSiteKind = 'decl' | 'ref' | 'call';

/** 一条出现点（源码序；同一位置只出现一次） */
export interface Kojo2ReferenceSite {
  readonly span: Kojo2ReferenceSpan;
  readonly kind: Kojo2ReferenceSiteKind;
}

/** 一次引用查找的结果（`null` = 这个位置没有可归属的符号） */
export interface Kojo2ReferencesResult {
  readonly symbol: Kojo2ReferenceSymbol;
  readonly refs: readonly Kojo2ReferenceSite[];
  /** 是否因 {@link KOJO2_REFERENCE_LIMIT} 截掉了尾部的出现点 */
  readonly truncated: boolean;
}

/**
 * 一份源文里的**一个符号 + 它的全部同文件出现点**。
 *
 * 这是 `kojo2ReferencesAt` 的"整篇"形态：同一套声明 / 事件事实、同一份表达式扫描、
 * 同一张 `symbolForSite` / `sitesForSymbol` 判据表，只是入口从"光标处那一个"换成
 * "这一篇里的每一个"。项目索引只消费它，**不另写扫描器**——跨文件引用与同文件引用
 * 因此不可能给出两套不同的事实。
 *
 * `refs` 源码序、含声明位、同位置只出现一次（与 `kojo2ReferencesAt().refs` 逐条同口径）。
 */
export interface Kojo2DocumentSymbolFacts {
  readonly symbol: Kojo2ReferenceSymbol;
  readonly refs: readonly Kojo2ReferenceSite[];
}

/**
 * 一处**候选引用位**：语法上确实是表达式 / 调用位的一个标识符，但**不要求**这个名字
 * 在本文件里有声明（跨文件查询要看见"只在别的文件声明"的名字）。
 *
 * 位置判据与 {@link kojo2ReferencesAt} 逐条相同（同一套 `collectLine` / `scanIdentifiers`）；
 * 唯一的放宽是去掉"本地声明名单"过滤——这一步在跨文件查询里换成了"项目里有这个符号吗"。
 * 调用名（`! 名` / `名(`）记 `call`，其余表达式位记 `ref`。
 */
export interface Kojo2ReferenceCandidate {
  readonly name: string;
  readonly span: Kojo2ReferenceSpan;
  readonly kind: 'ref' | 'call';
}

/**
 * 索引注入位：源码进，已建文档索引出（`null` = 这一份没有现成索引）。
 *
 * 缺省 = 现建 `kojo2DocumentOf`（同输入必同输出）；宿主注入时必须保证索引与这份源码
 * **同一版本**（换版本会让行列落错位）。跨文件项目索引是**另一条注入路**。
 */
export type Kojo2ReferenceIndexSource = (source: string) => Kojo2Document | null;

/** 纯逻辑的注入面 */
export interface Kojo2ReferenceOptions {
  readonly getIndex?: Kojo2ReferenceIndexSource;
}

/** 单次结果的条数上限；超出部分按源码序截掉并置 `truncated` */
export const KOJO2_REFERENCE_LIMIT = 500;

/* ============================== 内部事实 ============================== */

/** 名字 + 名字段（1 基列；声明事实与事件挂点共用的锚点形状） */
interface NameSpanFact {
  readonly name: string;
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

/** 一条声明符号（来自 `kojo2DocumentOf` 的同一份索引；列口径 1 基） */
interface DeclarationFact extends NameSpanFact {
  readonly kind: Kojo2DeclarationKind;
}

/** 一处事件名的挂点（`# 机` = 声明；`@织` = 监听） */
type EventAttestation = Kojo2EventSite;

/**
 * 出现点所属的符号家族。
 *
 * 为什么要分三家：`# 幕` 标题与事件名**不在 core 的文件命名空间**里（parser 只给
 * 变量 / 常量 / 表 / 池 / 模 / 函登记重名），所以"幕标题恰好等于变量名"是合法文件。
 * 名字级合并会把两张不相干的符号并成一张引用表，因此：
 * - `declaration`：进命名空间的六类声明 + 它们的表达式引用；
 * - `event`：`# 机` / `@织` 的事件名（只在这两种挂点之间合并）；
 * - `scene`：`# 幕` 标题（没有任何引用位，按**具体那一条**符号归属，同标题两幕不互相串）。
 */
type SiteFamily = 'declaration' | 'event' | 'scene';

interface SiteFact {
  readonly family: SiteFamily;
  readonly name: string;
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly kind: Kojo2ReferenceSiteKind;
}

/* ============================== 小工具 ============================== */

/** 位点是否有可用的数值坐标（NaN / 非有限 / 行列 < 1 一律不可查） */
function isUsablePosition(position: Kojo2ReferencePosition): boolean {
  return (
    Number.isFinite(position.line) &&
    Number.isFinite(position.column) &&
    position.line >= 1 &&
    position.column >= 1
  );
}

/** 1 基列区间 → 输出 span（全部单行：2.0 的引用位都在一行内） */
function spanOf(line: number, startColumn: number, endColumn: number): Kojo2ReferenceSpan {
  return {
    startLine: line,
    startColumn,
    endLine: line,
    endColumn,
  };
}

/** 码元序比较（不用 `localeCompare`：结果不随运行环境漂） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 源码序：行 → 起始列 → 结束列 → 名字（同起点只可能出现在坏输入里） */
function compareSites(a: SiteFact, b: SiteFact): number {
  return (
    a.line - b.line ||
    a.startColumn - b.startColumn ||
    a.endColumn - b.endColumn ||
    compareText(a.name, b.name)
  );
}

/** 注入索引的形态闸：三张数组齐备才可用（坏值退回现建，不信任陌生对象） */
function isDocumentLike(value: Kojo2Document | null | undefined): value is Kojo2Document {
  return (
    value !== null &&
    value !== undefined &&
    Array.isArray(value.lines) &&
    Array.isArray(value.physical) &&
    Array.isArray(value.declarations)
  );
}

/** 取文档索引：注入优先（抛错 / 坏值 → 退回现建） */
function documentFor(source: string, getIndex: Kojo2ReferenceIndexSource | undefined): Kojo2Document {
  if (getIndex !== undefined) {
    try {
      const injected = getIndex(source);
      if (isDocumentLike(injected)) return injected;
    } catch {
      /* 注入端抛错 = 这一份拿不到索引：现建（纯函数自己从不抛） */
    }
  }
  return kojo2DocumentOf(source);
}

/* ============================== 声明 / 事件事实 ============================== */

/** 声明索引 → 声明符号事实（原样搬运，不重新解释语法） */
function declarationFactsOf(document: Kojo2Document): DeclarationFact[] {
  return document.declarations.map((declaration) => ({
    name: declaration.name,
    kind: declaration.kind,
    line: declaration.line,
    startColumn: declaration.nameStart,
    endColumn: declaration.nameEnd,
  }));
}

/**
 * 全部事件挂点（源码序）。`# 机` 与 `@织` 的第一个词都进这张表；是不是声明由
 * {@link EventGroup} 决定（有 `# 机` 时 `# 机` 是声明，否则最早 `@织` 是锚点）。
 *
 * **判据不在这里**（LAU-D2）：`# 机` / `@织` 的名字段只有一个投影
 * （`event-sites`，B3c 起住包），引用面 / 悬停 / `dialect lint` 三处共用它。本函数只把
 * 那一份搬成引用面的内部形状，绝不另扫一遍。
 */
function eventAttestationsOf(document: Kojo2Document): EventAttestation[] {
  return kojo2EventSitesOf(document);
}

/** 同一条事件名的全部挂点；`decl` = `# 机`（没有就取最早 `@织`） */
interface EventGroup {
  readonly name: string;
  readonly decl: EventAttestation;
}

/** 按名字分组事件挂点（`# 机` 优先；没有 `# 机` 才用最早 `@织` 当锚点） */
function eventGroupsOf(attestations: readonly EventAttestation[]): EventGroup[] {
  const groups = new Map<string, { machine?: EventAttestation; first?: EventAttestation }>();
  for (const attestation of attestations) {
    const group = groups.get(attestation.name) ?? {};
    if (attestation.machine) {
      if (group.machine === undefined) group.machine = attestation;
    } else if (group.first === undefined) {
      group.first = attestation;
    }
    groups.set(attestation.name, group);
  }
  const out: EventGroup[] = [];
  for (const [name, group] of groups) {
    const decl = group.machine ?? group.first;
    if (decl === undefined) continue;
    out.push({ name, decl });
  }
  return out;
}

/* ============================== 表达式扫描 ============================== */

/** 一条表达式里的标识符（0 基、行内坐标） */
interface IdentifierHit {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly kind: 'ref' | 'call';
}

/**
 * 一段表达式文本里的标识符（**只扫不加解释**）。
 *
 * - 双引号字符串整段跳过（含转义；`skipQuoted` 是 core 的同一枚扫描器）；
 * - `.` 之后的词是**成员名**，不是文件内符号（`我.今天已触发` 只认 `我`）；
 * - 数字串（`0` / `99`）不是名字；`$` 开头同样跳过；
 * - 标识符后（跳过空白）紧邻 `(` ⇒ `call`，否则 `ref`（`! 名` 的调用名由触发行单独判）。
 */
function scanIdentifiers(
  text: string,
  from: number,
  to: number,
  emit: (hit: IdentifierHit) => void,
): void {
  const start = Math.max(0, from);
  const end = Math.min(to, text.length);
  let i = start;
  while (i < end) {
    const code = text.charCodeAt(i);
    if (code === 0x22 /* " */) {
      const next = skipQuoted(text, i);
      i = next > i ? next : i + 1;
      continue;
    }
    if (!isNameCharAt(text, i)) {
      i++;
      continue;
    }
    const tokenStart = i;
    while (i < end && isNameCharAt(text, i)) i++;
    const name = text.slice(tokenStart, i);
    const firstCode = name.charCodeAt(0);
    if ((firstCode >= 0x30 && firstCode <= 0x39) || firstCode === 0x24 /* $ */) continue;
    // 成员位：前一个非空白字符是 `.` ⇒ 这是成员名，不是文件内符号
    let before = tokenStart - 1;
    while (before >= start && isSpaceCode(text.charCodeAt(before))) before--;
    if (before >= start && text.charCodeAt(before) === 0x2e /* . */) continue;
    // 调用位：标识符之后（跳过空白）紧邻 `(`
    let after = i;
    while (after < end && isSpaceCode(text.charCodeAt(after))) after++;
    const kind: 'ref' | 'call' = after < end && text.charCodeAt(after) === 0x28 /* ( */ ? 'call' : 'ref';
    emit({ name, start: tokenStart, end: i, kind });
  }
}

/** 行内某一位是不是名字字符（不越出本行长度） */
function isNameCharAt(text: string, index: number): boolean {
  const ch = text[index];
  return ch !== undefined && isNameChar(ch);
}

/* ============================== 出现点收集 ============================== */

/** 一块要扫的行内区间（0 基、行内坐标） */
interface ScanRange {
  readonly from: number;
  readonly to: number;
}

/** 叙事文本行（含 `parts`）：只扫 `{…}` 插值里的表达式 */
function scanRangesOfTextLine(
  line: KojoTextFields & { readonly lineOffset: number },
): ScanRange[] {
  const ranges: ScanRange[] = [];
  for (const part of line.parts) {
    if (part.kind !== 'interp') continue;
    if (part.condition !== null) {
      for (const piece of [part.condition.cond, part.condition.then, part.condition.else]) {
        ranges.push({ from: piece.offset - line.lineOffset, to: piece.offset - line.lineOffset + piece.text.length });
      }
      continue;
    }
    ranges.push({
      from: part.valueOffset - line.lineOffset,
      to: part.valueOffset - line.lineOffset + part.value.length,
    });
  }
  return ranges;
}

/** 名字集合（表达式扫描只收集**有声明**的名字；事件名走 {@link SiteFamily} 另一路） */
interface Collector {
  /** `null` = 不做名字过滤（"候选引用位"要看见本文件没声明的名字） */
  readonly names: ReadonlySet<string> | null;
  readonly sites: SiteFact[];
}

/** 收集一个名字的全部标识符（行内区间 → 1 基列） */
function collectRange(
  collector: Collector,
  text: string,
  line: number,
  range: ScanRange,
): void {
  scanIdentifiers(text, range.from, range.to, (hit) => {
    if (collector.names !== null && !collector.names.has(hit.name)) return;
    collector.sites.push({
      family: 'declaration',
      name: hit.name,
      line,
      startColumn: hit.start + 1,
      endColumn: hit.end + 1,
      kind: hit.kind,
    });
  });
}

/**
 * 一行 → 出现点（只在该行**确实**是表达式 / 调用 / 插值位时收集）。
 *
 * `expressionContext` = 这一行的直接外层块头是 `@算` / `@函`（调度语句体）：只有这种裸行
 * 整行都是代码；其余叙事面的裸行只认 `{…}` 插值，正文一个字都不扫。
 */
function collectLine(
  collector: Collector,
  line: KojoLexLine,
  text: string,
  expressionContext: boolean,
): void {
  switch (line.kind) {
    case 'decl': {
      if (!line.known) return;
      if (line.word === TABLE_WORD) {
        // `# 对照表 <名> 依据 <表达式>`：只扫 `依据` 之后；表体行是字面量，不碰。
        const tokens = splitSpaces(line.rest, line.restOffset);
        for (let index = 1; index < tokens.length; index++) {
          const token = tokens[index]!;
          if (token.text !== KOJO_TABLE_SUBJECT) continue;
          collectRange(collector, text, line.number, {
            from: token.offset + token.text.length - line.lineOffset,
            to: line.contentEnd - line.lineOffset,
          });
          return;
        }
        return;
      }
      if (line.word !== VARIABLE_WORD) return;
      // `# 变量 <名> <类型>[<数组长度>]`：数组长度可以引用已声明的整数常量（§3.4.2）。
      const tokens = splitSpaces(line.rest, line.restOffset);
      const type = tokens[1];
      if (type === undefined) return;
      const open = type.text.indexOf('[');
      const close = type.text.lastIndexOf(']');
      if (open < 0 || close <= open + 1) return;
      collectRange(collector, text, line.number, {
        from: type.offset + open + 1 - line.lineOffset,
        to: type.offset + close - line.lineOffset,
      });
      return;
    }
    case 'dispatch': {
      if (!EXPRESSION_DISPATCH_WORDS.has(line.word)) return;
      collectRange(collector, text, line.number, {
        from: line.restOffset - line.lineOffset,
        to: line.contentEnd - line.lineOffset,
      });
      return;
    }
    case 'trigger': {
      if (line.name.length === 0) return;
      if (collector.names !== null && !collector.names.has(line.name)) return;
      const start = line.nameOffset - line.lineOffset;
      collector.sites.push({
        family: 'declaration',
        name: line.name,
        line: line.number,
        startColumn: start + 1,
        endColumn: start + line.name.length + 1,
        kind: 'call',
      });
      for (const arg of line.args) {
        collectRange(collector, text, line.number, {
          from: arg.offset - line.lineOffset,
          to: arg.offset - line.lineOffset + arg.text.length,
        });
      }
      return;
    }
    case 'condition': {
      if (line.isDefault || line.test.length === 0) return;
      collectRange(collector, text, line.number, {
        from: line.testOffset - line.lineOffset,
        to: line.contentEnd - line.lineOffset,
      });
      return;
    }
    case 'dialogue':
    case 'narration':
    case 'bareQuote':
    case 'escaped':
    case 'text': {
      if (line.kind === 'text' && expressionContext) {
        // `@算` / `@函` 体的裸语句：整行是代码（赋值两侧 / 裸调用 / 表达式）。
        collectRange(collector, text, line.number, {
          from: line.contentOffset - line.lineOffset,
          to: line.contentEnd - line.lineOffset,
        });
        return;
      }
      for (const range of scanRangesOfTextLine(line)) {
        collectRange(collector, text, line.number, range);
      }
      return;
    }
    default:
      // blank / comment / native / legacy / blankLine / options / unknown：一律不是引用位。
      return;
  }
}

/** 这一行的直接外层块头是不是调度语句块（`@算` / `@函`） */
function expressionContextOf(enclosing: KojoLexLine | undefined): boolean {
  return (
    enclosing !== undefined &&
    enclosing.kind === 'dispatch' &&
    EXPRESSION_BLOCK_WORDS.has(enclosing.word)
  );
}

/**
 * 这一行是不是 `# 对照表` 体的**数据行**（缩进恰好比表头深一级；§6.1）。
 *
 * 判据只看"直接外层块头是 `# 对照表` + 缩进一级"——与 parser 的 `parseTableRow` 取同一类行
 * （空行结束表、表内注释被跳过，这两条由 `sitesOf` 的跳过逻辑与缩进栈天然满足）。
 */
function isTableBodyRow(enclosing: KojoLexLine | undefined, line: KojoLexLine): boolean {
  return (
    enclosing !== undefined &&
    enclosing.kind === 'decl' &&
    enclosing.known &&
    enclosing.word === TABLE_WORD &&
    line.indent === enclosing.indent + KOJO_INDENT_WIDTH
  );
}

/**
 * 表体一行 → 范围端点的引用位（**值列不扫**）。
 *
 * 行形状与 `parser.ts::parseTableRow` 同口径（§6.1）：首个空白前是范围列，`否` 是兜底行；
 * 否则 `a..b` / `a..` / `..b` / `a` 中的**标识符形态端点**进表达式位。数字端点是字面量，
 * `scanIdentifiers` 会因首字符是数字而跳过，不必在这里再判。
 *
 * 为什么在这里自己切范围列、而不是再 `parseSource` 一遍：项目索引热路径对每份文件已经
 * 跑过 lex+parse 两趟（`kojo2ReferenceSymbolsOf` / `kojo2ReferenceCandidatesOf`），再加
 * 一趟整文解析会顶穿 8ms 的预算用例；行形状是 §6.1 的公开文法，判据只有这一处要维护。
 */
function collectTableRow(
  collector: Collector,
  line: KojoLexLine,
  text: string,
): void {
  const rowText = line.text;
  let sep = -1;
  for (let i = 0; i < rowText.length; i++) {
    if (isSpaceCode(rowText.charCodeAt(i))) {
      sep = i;
      break;
    }
  }
  if (sep <= 0) return; // 没有范围列（`否` 单词行等坏输入）：parser 另有诊断，这里不猜
  const rangeRaw = rowText.slice(0, sep);
  if (rangeRaw === KOJO_TABLE_DEFAULT) return; // `否 <值>`：没有端点
  const base = line.contentOffset;
  const dots = rangeRaw.indexOf('..');
  const endpoints: Array<{ readonly text: string; readonly at: number }> =
    dots >= 0
      ? [
          { text: rangeRaw.slice(0, dots), at: base },
          { text: rangeRaw.slice(dots + 2), at: base + dots + 2 },
        ]
      : [{ text: rangeRaw, at: base }];
  for (const endpoint of endpoints) {
    if (endpoint.text.length === 0) continue;
    const from = endpoint.at - line.lineOffset;
    collectRange(collector, text, line.number, { from, to: from + endpoint.text.length });
  }
}

/**
 * 全部出现点（源码序）。
 *
 * 缩进栈只回答一件事："这一行的直接外层块头是谁"。空行 / 注释 / `@原生` 体不参与栈
 * （它们不改变块结构，也不该把块提前关掉）。声明索引的声明位在最后统一补入并按源码序排序。
 */
function sitesOf(
  document: Kojo2Document,
  declarations: readonly DeclarationFact[],
  events: readonly EventAttestation[],
  names: ReadonlySet<string> | null | undefined = undefined,
): SiteFact[] {
  let collectedNames: ReadonlySet<string> | null;
  if (names === undefined) {
    const local = new Set<string>();
    for (const declaration of declarations) {
      // `# 幕` 标题不是可引用名字（正文里的同名 token 不归给幕），不进表达式名单。
      if (declaration.kind !== 'scene') local.add(declaration.name);
    }
    collectedNames = local;
  } else {
    collectedNames = names;
  }
  const collector: Collector = { names: collectedNames, sites: [] };

  const stack: { readonly indent: number; readonly line: KojoLexLine }[] = [];
  for (let index = 0; index < document.lines.length; index++) {
    const line = document.lines[index]!;
    const text = document.physical[index]?.text ?? '';
    if (line.kind === 'blank' || line.kind === 'comment' || line.kind === 'native') continue;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= line.indent) stack.pop();
    const enclosing = stack[stack.length - 1]?.line;
    if (isTableBodyRow(enclosing, line)) {
      // 表体数据行：只把范围端点当表达式位（改名会改写它们，见模块头注）
      collectTableRow(collector, line, text);
    } else {
      collectLine(collector, line, text, expressionContextOf(enclosing));
    }
    stack.push({ indent: line.indent, line });
  }

  // 声明位（`# 幕` / `# 变量` / … / `@函`）：索引已给精确名字区间，原样补一枚 `decl`。
  for (const declaration of declarations) {
    collector.sites.push({
      family: declaration.kind === 'scene' ? 'scene' : 'declaration',
      name: declaration.name,
      line: declaration.line,
      startColumn: declaration.startColumn,
      endColumn: declaration.endColumn,
      kind: 'decl',
    });
  }

  // 事件挂点：`# 机` = `decl`，`@织` = `ref`。
  for (const event of events) {
    collector.sites.push({
      family: 'event',
      name: event.name,
      line: event.line,
      startColumn: event.startColumn,
      endColumn: event.endColumn,
      kind: event.machine ? 'decl' : 'ref',
    });
  }

  return dedupeAndSort(collector.sites);
}

/** 同一位置只留一条（表达式与实参扫描在坏输入上可能重叠），并按源码序排 */
function dedupeAndSort(sites: readonly SiteFact[]): SiteFact[] {
  const seen = new Set<string>();
  const out: SiteFact[] = [];
  for (const site of sites) {
    const key = `${site.family}\u0000${site.line}\u0000${site.startColumn}\u0000${site.endColumn}\u0000${site.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  out.sort(compareSites);
  return out;
}

/* ============================== 位置 → 符号 ============================== */

/** 位点是否落在这一枚出现点上（尾列按**可停靠**算：光标可在名字后一位） */
function siteContains(site: SiteFact, position: Kojo2ReferencePosition): boolean {
  if (site.line !== position.line) return false;
  const col0 = position.column - 1;
  return col0 >= site.startColumn - 1 && col0 <= site.endColumn - 1;
}

/** 光标处的出现点（源码序第一枚；重叠只可能来自坏输入，先到先得） */
function siteAt(sites: readonly SiteFact[], position: Kojo2ReferencePosition): SiteFact | undefined {
  for (const site of sites) {
    if (siteContains(site, position)) return site;
  }
  return undefined;
}

/**
 * 同名声明里挑"离引用行最近的**前面**那条"（前面没有才取第一条）——与
 * `kojo2DeclarationNamed` 同口径：重名是 core 错误，编辑器在错误态下也得给一个确定落点。
 */
function nearestDeclaration(
  declarations: readonly DeclarationFact[],
  line: number,
): DeclarationFact | undefined {
  let best: DeclarationFact | undefined;
  for (const declaration of declarations) {
    if (declaration.line > line) continue;
    if (
      best === undefined ||
      declaration.line > best.line ||
      (declaration.line === best.line && declaration.startColumn > best.startColumn)
    ) {
      best = declaration;
    }
  }
  return best ?? declarations[0];
}

/** 出现点 → 符号事实（三个家族分开归属；找不到符号 ⇒ `null`） */
function symbolForSite(
  site: SiteFact,
  declarations: readonly DeclarationFact[],
  eventGroups: readonly EventGroup[],
): { readonly name: string; readonly kind: Kojo2ReferenceSymbolKind; readonly decl: NameSpanFact } | null {
  if (site.family === 'event') {
    const group = eventGroups.find((candidate) => candidate.name === site.name);
    if (group === undefined) return null;
    return { name: group.name, kind: 'event', decl: group.decl };
  }
  if (site.family === 'scene') {
    // 幕标题没有引用位：按**具体那一条**符号归属（同标题两幕是两段戏，不是互相引用）。
    const scene = declarations.find(
      (declaration) =>
        declaration.kind === 'scene' &&
        declaration.line === site.line &&
        declaration.startColumn === site.startColumn &&
        declaration.endColumn === site.endColumn,
    );
    return scene === undefined ? null : { name: scene.name, kind: 'scene', decl: scene };
  }
  const named = declarations.filter(
    (declaration) => declaration.kind !== 'scene' && declaration.name === site.name,
  );
  if (named.length === 0) return null;
  const decl = nearestDeclaration(named, site.line);
  if (decl === undefined) return null;
  return { name: decl.name, kind: decl.kind, decl };
}

/** 选中符号 → 它的全部出现点（幕按具体一条；事件 / 其余声明按名字与家族） */
function sitesForSymbol(
  sites: readonly SiteFact[],
  symbol: { readonly name: string; readonly kind: Kojo2ReferenceSymbolKind; readonly decl: NameSpanFact },
): SiteFact[] {
  if (symbol.kind === 'scene') {
    return sites.filter(
      (candidate) =>
        candidate.family === 'scene' &&
        candidate.line === symbol.decl.line &&
        candidate.startColumn === symbol.decl.startColumn &&
        candidate.endColumn === symbol.decl.endColumn,
    );
  }
  const family: SiteFamily = symbol.kind === 'event' ? 'event' : 'declaration';
  return sites.filter((candidate) => candidate.family === family && candidate.name === symbol.name);
}

/** 一篇源文的全部符号事实（`kojo2ReferencesAt` 与 `kojo2ReferenceSymbolsOf` 共用的唯一入口） */
interface SourceAnalysis {
  readonly declarations: readonly DeclarationFact[];
  readonly sites: readonly SiteFact[];
  readonly eventGroups: readonly EventGroup[];
}

/**
 * 建一篇源文的符号事实；没有声明也没有事件 ⇒ `null`（两种入口各自折成自己的空形态）。
 *
 * 解析入口仍走 {@link documentFor}：注入的文档索引优先，坏值 / 抛错退回现建——
 * 与单点查询逐条同口径，不因为"要整篇"就换一条路。
 */
function analyzeSource(
  source: string,
  getIndex: Kojo2ReferenceIndexSource | undefined,
): SourceAnalysis | null {
  const document = documentFor(source, getIndex);
  const declarations = declarationFactsOf(document);
  const events = eventAttestationsOf(document);
  if (declarations.length === 0 && events.length === 0) return null;
  return {
    declarations,
    sites: sitesOf(document, declarations, events),
    eventGroups: eventGroupsOf(events),
  };
}

/* ============================== 纯逻辑入口 ============================== */

/**
 * 光标处的**全部同文件引用**（**纯函数**：同输入必同输出，零 IO、零 Monaco、零缓存）。
 *
 * 返回 `null` = 这个位置没有可归属的同文件符号（正文 / 注释 / `@原生` / `# 视` 名字 /
 * 空行 / 越界……）。返回结果里的 `refs` 按源码序，含声明位；超过上限时截断并置
 * `truncated`。
 */
export function kojo2ReferencesAt(
  source: string,
  position: Kojo2ReferencePosition,
  options: Kojo2ReferenceOptions = {},
): Kojo2ReferencesResult | null {
  if (typeof source !== 'string' || source.length === 0) return null;
  if (!isUsablePosition(position)) return null;

  try {
    const analysis = analyzeSource(source, options.getIndex);
    if (analysis === null) return null;

    const site = siteAt(analysis.sites, position);
    if (site === undefined) return null;

    const symbol = symbolForSite(site, analysis.declarations, analysis.eventGroups);
    if (symbol === null) return null;

    const familySites = sitesForSymbol(analysis.sites, symbol);
    const refs = familySites.map((candidate) => ({
      span: spanOf(candidate.line, candidate.startColumn, candidate.endColumn),
      kind: candidate.kind,
    }));
    const truncated = refs.length > KOJO2_REFERENCE_LIMIT;
    return {
      symbol: {
        name: symbol.name,
        kind: symbol.kind,
        declSpan: spanOf(symbol.decl.line, symbol.decl.startColumn, symbol.decl.endColumn),
      },
      refs: truncated ? refs.slice(0, KOJO2_REFERENCE_LIMIT) : refs,
      truncated,
    };
  } catch {
    // 纯函数不把异常交给调用方：坏输入 / 意外索引一律"这里查不到"（与 provider 的空结果同向）。
    return null;
  }
}

/* ============================== 整篇符号事实（跨文件取数口） ============================== */

/** 符号事实的规范序：声明行 → 起始列 → 结束列 → 名字 → 种类（与源码序同向） */
function compareSymbolFacts(a: Kojo2DocumentSymbolFacts, b: Kojo2DocumentSymbolFacts): number {
  return (
    a.symbol.declSpan.startLine - b.symbol.declSpan.startLine ||
    a.symbol.declSpan.startColumn - b.symbol.declSpan.startColumn ||
    a.symbol.declSpan.endColumn - b.symbol.declSpan.endColumn ||
    compareText(a.symbol.name, b.symbol.name) ||
    compareText(a.symbol.kind, b.symbol.kind)
  );
}

/** 符号身份键（名字 + 种类 + 声明落点；`# 幕` 同标题两幕因此各算一条） */
function symbolFactKey(symbol: Kojo2ReferenceSymbol): string {
  const span = symbol.declSpan;
  return `${symbol.name}\u0000${symbol.kind}\u0000${span.startLine}\u0000${span.startColumn}\u0000${span.endColumn}`;
}

/** 符号 → 它的整篇出现点（走 `sitesForSymbol`，与单点查询同一条判据） */
function factsOfSymbol(
  symbol: Kojo2ReferenceSymbol,
  analysis: SourceAnalysis,
): Kojo2DocumentSymbolFacts {
  const decl: NameSpanFact = {
    name: symbol.name,
    line: symbol.declSpan.startLine,
    startColumn: symbol.declSpan.startColumn,
    endColumn: symbol.declSpan.endColumn,
  };
  const sites = sitesForSymbol(analysis.sites, { name: symbol.name, kind: symbol.kind, decl });
  return {
    symbol,
    refs: sites.map((site) => ({
      span: spanOf(site.line, site.startColumn, site.endColumn),
      kind: site.kind,
    })),
  };
}

/**
 * 一篇源文的**全部可归属符号**与各自出现点（纯函数；跨文件逐文件取数口）。
 *
 * 与 {@link kojo2ReferencesAt} 共用同一条分析链（`analyzeSource` / `symbolForSite` /
 * `sitesForSymbol`）：位置查询是"这一篇里的一个符号"，这里是"这一篇里的每一个符号"。
 * 事件名按 {@link EventGroup} 归属（`# 机` 优先，没有才取最早 `@织` 作锚点），`# 幕`
 * 按具体那一条标题归属；同名但不同家族（变量 / 事件 / 幕）各成一条，不互相串。
 *
 * 空源 / 没有符号 / 解析抛错 ⇒ `[]`（纯函数不抛；与 `kojo2ReferencesAt` 返回 `null` 同向）。
 */
export function kojo2ReferenceSymbolsOf(
  source: string,
  options: Kojo2ReferenceOptions = {},
): readonly Kojo2DocumentSymbolFacts[] {
  if (typeof source !== 'string' || source.length === 0) return [];

  try {
    const analysis = analyzeSource(source, options.getIndex);
    if (analysis === null) return [];

    const out: Kojo2DocumentSymbolFacts[] = [];
    const seen = new Set<string>();
    const push = (symbol: Kojo2ReferenceSymbol): void => {
      const key = symbolFactKey(symbol);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(factsOfSymbol(symbol, analysis));
    };

    // 声明位：逐条声明成符号（重名在错误态下也各自可归属；同一条声明只进一次）。
    for (const declaration of analysis.declarations) {
      push({
        name: declaration.name,
        kind: declaration.kind,
        declSpan: spanOf(declaration.line, declaration.startColumn, declaration.endColumn),
      });
    }
    // 事件位：`# 机` 与 `@织` 合成的一条事件符号（声明锚点由 eventGroups 定）。
    for (const group of analysis.eventGroups) {
      push({
        name: group.name,
        kind: 'event',
        declSpan: spanOf(group.decl.line, group.decl.startColumn, group.decl.endColumn),
      });
    }

    out.sort(compareSymbolFacts);
    return out;
  } catch {
    return [];
  }
}

/**
 * 一篇源文的**全部候选引用位**（纯函数；跨文件查询的另一半取数口）。
 *
 * 与 {@link kojo2ReferencesAt} 走同一条 `collectLine` / `scanIdentifiers` 扫描，唯一放宽：
 * 不再要求名字在本文件里有声明。去掉了这一步，才能看见"只在别的文件里声明"的真实引用
 * （例如 B 文件里 `{心情}`，而 `# 对照表 心情` 写在 A 文件）。
 *
 * 返回里**不含声明位**（`kind === 'decl'` 由符号事实单独给）与 `# 机` / `@织` 的事件名
 * （事件挂点不是表达式引用，事件查询走符号事实）。空源 / 解析抛错 ⇒ `[]`。
 */
export function kojo2ReferenceCandidatesOf(
  source: string,
  options: Kojo2ReferenceOptions = {},
): readonly Kojo2ReferenceCandidate[] {
  if (typeof source !== 'string' || source.length === 0) return [];

  try {
    const document = documentFor(source, options.getIndex);
    const declarations = declarationFactsOf(document);
    const events = eventAttestationsOf(document);
    // names = null：不按本地声明名单过滤（这是与单点查询唯一的差异）。
    const sites = sitesOf(document, declarations, events, null);

    const out: Kojo2ReferenceCandidate[] = [];
    for (const site of sites) {
      if (site.family !== 'declaration') continue; // 事件名不是表达式引用
      if (site.kind === 'decl') continue; // 声明位另行给出
      out.push({
        name: site.name,
        span: spanOf(site.line, site.startColumn, site.endColumn),
        kind: site.kind,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/* ============================== 跨文件：索引形状与合并 ============================== */

/** 跨文件的一条出现点（落点路径 + 区间 + 角色；路径是宿主给的原样路径） */
export interface Kojo2ProjectReferenceSite {
  readonly path: string;
  readonly span: Kojo2ReferenceSpan;
  readonly kind: Kojo2ReferenceSiteKind;
}

/**
 * 合并结果里的一条出现点。
 *
 * `path === null` = **本文件**（宿主用 `model.uri` 落点）；其余是项目里的另一份文件
 * （宿主用注入的 `path → Uri` 转换，缺省 `monaco.Uri.file`）。
 */
export interface Kojo2ProjectMergedSite {
  readonly path: string | null;
  readonly span: Kojo2ReferenceSpan;
  readonly kind: Kojo2ReferenceSiteKind;
}

/** 一次跨文件引用查找的结果（`null` = 这个位置没有可归属的符号） */
export interface Kojo2ProjectReferencesResult {
  readonly symbol: Kojo2ReferenceSymbol;
  /** 本文件出现点（源码序、含声明位；与 `kojo2ReferencesAt().refs` 逐条相同） */
  readonly local: readonly Kojo2ReferenceSite[];
  /** 跨文件出现点（不含本文件；按路径 → 源码序） */
  readonly external: readonly Kojo2ProjectReferenceSite[];
  /** 合并视图：**声明位在前**（稳定分区），其余按"本文件 → 跨文件"原序 */
  readonly refs: readonly Kojo2ProjectMergedSite[];
  /** 本文件或跨文件任一侧触到上限（跨文件侧见 {@link KOJO2_PROJECT_REF_LIMIT}） */
  readonly truncated: boolean;
}

/** 跨文件查找的注入面 */
export interface Kojo2ProjectLookupOptions {
  /** 本文件路径：给出后跨文件侧会排除它（避免同一份文件在 `local` / `external` 里各出一遍） */
  readonly path?: string;
  /** 本文件文档索引的注入位（透传给 `kojo2ReferencesAt`，与同文件查询同一口径） */
  readonly getIndex?: Kojo2ReferenceIndexSource;
}

/** 跨文件单次 `refsOf` 的结果上限（与宿主索引 `KOJO2_PROJECT_REF_LIMIT` 同值同口径） */
export const KOJO2_PROJECT_REF_LIMIT = 2000;

/** `refsOf` 的查询面（与宿主项目索引同形；这里只收结构，不收实例） */
export interface Kojo2ProjectRefQuery {
  readonly name: string;
  readonly kind: Kojo2ReferenceSymbolKind;
  readonly excludePath?: string;
  readonly onlyPath?: string;
}

/** 某个名字的一条声明（`declsOf` 用；`span` 是声明名字段） */
export interface Kojo2ProjectDeclaration {
  readonly path: string;
  readonly name: string;
  readonly kind: Kojo2ReferenceSymbolKind;
  readonly span: Kojo2ReferenceSpan;
}

/** "这个位置引用的是哪个项目符号"的查询（1 基行列；与 Monaco / core 同口径） */
export interface Kojo2ProjectSymbolQuery {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/** 位置处的项目符号（**声明种类**）：`name` + `kind` */
export interface Kojo2ProjectSymbolRef {
  readonly name: string;
  readonly kind: Kojo2DeclarationKind;
}

/** `refsOf` 的结果（`truncated` 显式告诉调用方"这是截断后的列表"） */
export interface Kojo2ProjectRefsResult {
  readonly refs: readonly Kojo2ProjectReferenceSite[];
  readonly truncated: boolean;
}

/**
 * 跨文件查询要的那三个方法（**结构接口**，宿主 `Kojo2ProjectIndex` 天然满足）。
 *
 * 为什么不在包里持有宿主的索引类型：插件看不见宿主；这一层只要这三个方法，
 * 宿主那侧传真索引、插件那侧传快照索引（{@link kojo2ReferencesInProjectFiles} 现建），
 * 判据仍是同一条 `kojo2ProjectReferencesAt`。
 */
export interface Kojo2ReferenceProjectIndex {
  refsOf(query: Kojo2ProjectRefQuery): Kojo2ProjectRefsResult;
  declsOf(name: string): readonly Kojo2ProjectDeclaration[];
  symbolAt(query: Kojo2ProjectSymbolQuery): Kojo2ProjectSymbolRef | null;
}

/** 光标处的候选引用名字（本文件没有同名声明时，用它把位置对到项目符号上） */
function candidateNameAt(
  source: string,
  position: Kojo2ReferencePosition,
  getIndex: Kojo2ReferenceIndexSource | undefined,
): string | null {
  if (!isUsablePosition(position)) return null;
  const col0 = position.column - 1;
  const candidates = kojo2ReferenceCandidatesOf(
    source,
    getIndex === undefined ? {} : { getIndex },
  );
  for (const candidate of candidates) {
    if (candidate.span.startLine !== position.line) continue;
    if (col0 < candidate.span.startColumn - 1 || col0 > candidate.span.endColumn - 1) continue;
    return candidate.name;
  }
  return null;
}

/**
 * 光标处的**同文件 + 跨文件**引用（纯函数：零 IO、零 Monaco）。
 *
 * 分工仍是两条腿、一张尺子：
 * - 本文件这一半**原样**调 {@link kojo2ReferencesAt}（符号归属 / 出现点判据不复制）；
 * - 跨文件这一半只向索引问 `refsOf({ name, kind })`——索引的每个文件事实又是用
 *   {@link kojo2ReferenceSymbolsOf} / {@link kojo2ReferenceCandidatesOf} 建的，所以两边
 *   不可能各说一套。
 *
 * **本文件没有改名声明时**（典型形态：B 文件里 `{心情}`，而 `# 对照表 心情` 在 A 文件）：
 * {@link kojo2ReferencesAt} 回 `null`，这里改问索引 `symbolAt(options.path, position)`
 * 拿到位置上的符号名字与声明种类，再把整项目的出现点按"本文件 / 别的文件"拆开返回。
 * 项目里同名多家族（core 错误）或这个名字没有声明 ⇒ 仍回 `null`（不猜）。
 *
 * `index` 缺席（`null` / `undefined`）= 退化成同文件查询（`external` 为空），宿主没装索引时
 * 行为与旧 provider 一致。`options.path` 缺省时索引若含本文件，本文件的落点会在 `external`
 * 里再出现一遍（宿主不知道路径就无从排除；provider 总会带上路径）。
 */
export function kojo2ProjectReferencesAt(
  source: string,
  position: Kojo2ReferencePosition,
  index: Kojo2ReferenceProjectIndex | null | undefined,
  options: Kojo2ProjectLookupOptions = {},
): Kojo2ProjectReferencesResult | null {
  const local = kojo2ReferencesAt(
    source,
    position,
    options.getIndex === undefined ? {} : { getIndex: options.getIndex },
  );

  if (local !== null) {
    let external: Kojo2ProjectReferenceSite[] = [];
    let externalTruncated = false;
    if (index !== null && index !== undefined) {
      try {
        const found = index.refsOf({
          name: local.symbol.name,
          kind: local.symbol.kind,
          ...(options.path === undefined ? {} : { excludePath: options.path }),
        });
        external = [...found.refs];
        externalTruncated = found.truncated;
      } catch {
        // 注入的索引端抛错 = 这一侧拿不到跨文件事实：本文件结果照旧交出。
        external = [];
        externalTruncated = false;
      }
    }
    return assembleProjectResult(
      local.symbol,
      local.refs,
      external,
      local.truncated || externalTruncated,
    );
  }

  // 本文件没有可归属符号：可能是"只在别的文件声明、这里是一处可证引用位"。
  if (index === null || index === undefined || options.path === undefined) return null;

  let resolved: Kojo2ProjectSymbolRef | null = null;
  try {
    if (typeof index.symbolAt === 'function') {
      resolved = index.symbolAt({
        path: options.path,
        line: position.line,
        column: position.column,
      });
    }
  } catch {
    resolved = null;
  }
  // 当前文件可能还没喂进索引（正在编辑的脏 model）：用**这份源码**的候选位拿名字，
  // 声明种类仍只看项目索引（本文件没有声明，不存在"本地优先"的问题）。
  if (resolved === null) {
    const name = candidateNameAt(source, position, options.getIndex);
    if (name === null) return null;
    const kinds = new Set<Kojo2DeclarationKind>();
    for (const declaration of index.declsOf(name)) {
      if (declaration.kind === 'scene' || declaration.kind === 'event') continue;
      kinds.add(declaration.kind);
    }
    // 同名多家族（core 错误）⇒ 不猜。
    if (kinds.size !== 1) return null;
    for (const kind of kinds) resolved = { name, kind };
  }
  if (resolved === null) return null;

  const symbol = resolved;
  try {
    const declaration = index
      .declsOf(symbol.name)
      .filter((candidate) => candidate.kind === symbol.kind)[0];
    if (declaration === undefined) return null;

    const localFound = index.refsOf({
      name: symbol.name,
      kind: symbol.kind,
      onlyPath: options.path,
    });
    const externalFound = index.refsOf({
      name: symbol.name,
      kind: symbol.kind,
      excludePath: options.path,
    });
    const localRefs: Kojo2ReferenceSite[] = localFound.refs.map((ref) => ({
      span: ref.span,
      kind: ref.kind,
    }));
    return assembleProjectResult(
      // 跨文件符号的声明落点取**路径序第一条**（本文件没有"最近的声明"可谈）。
      { name: symbol.name, kind: symbol.kind, declSpan: declaration.span },
      localRefs,
      [...externalFound.refs],
      localFound.truncated || externalFound.truncated,
    );
  } catch {
    return null;
  }
}

/** 合并结果（声明位在前：稳定分区，不重排其余出现点） */
function assembleProjectResult(
  symbol: Kojo2ReferenceSymbol,
  localRefs: readonly Kojo2ReferenceSite[],
  external: readonly Kojo2ProjectReferenceSite[],
  truncated: boolean,
): Kojo2ProjectReferencesResult {
  const merged: Kojo2ProjectMergedSite[] = [];
  for (const site of localRefs) merged.push({ path: null, span: site.span, kind: site.kind });
  for (const site of external) merged.push({ path: site.path, span: site.span, kind: site.kind });
  const refs: Kojo2ProjectMergedSite[] = [];
  for (const site of merged) if (site.kind === 'decl') refs.push(site);
  for (const site of merged) if (site.kind !== 'decl') refs.push(site);
  return { symbol, local: localRefs, external, refs, truncated };
}

/* ============================== 跨文件：项目文件快照口（B3e） ============================== */

/**
 * 项目里一份文档的快照（宿主按请求从项目索引现取；**不含**请求文件自己）。
 *
 * 这是宿主事实，不是判据：插件只拿它当"项目里还有哪些文本"。
 */
export interface Kojo2ReferenceProjectFile {
  readonly path: string;
  readonly text: string;
}

/**
 * 路径归一键（分隔符折叠 + 小写）。
 *
 * 与宿主 `ui/file-tree-ops.ts` 的 `pkey` **同一条口径**——但包不能 import 宿主，
 * 这一行是它在语言层的投影，不要在这里加第二种折叠规则。
 */
function snapshotPathKey(path: string): string {
  return path.replace(/[\\/]+/g, '/').toLowerCase();
}

/** 路径序：归一键优先（大小写 / 分隔符不敏感），再按原文路径 */
function comparePaths(a: string, b: string): number {
  return compareText(snapshotPathKey(a), snapshotPathKey(b)) || compareText(a, b);
}

/** 出现点角色序（同起点并列时给一个确定次序） */
const SNAPSHOT_ROLE_RANK: Readonly<Record<Kojo2ReferenceSiteKind, number>> = {
  decl: 0,
  ref: 1,
  call: 2,
};

/** 跨文件出现点的规范序：路径 → 行 → 起始列 → 结束列 → 角色 */
function compareProjectRefs(a: Kojo2ProjectReferenceSite, b: Kojo2ProjectReferenceSite): number {
  return (
    comparePaths(a.path, b.path) ||
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    a.span.endColumn - b.span.endColumn ||
    SNAPSHOT_ROLE_RANK[a.kind] - SNAPSHOT_ROLE_RANK[b.kind]
  );
}

/** 声明规范序：路径 → 行 → 起始列 → 结束列 → 名字 → 种类 */
function compareProjectDecls(a: Kojo2ProjectDeclaration, b: Kojo2ProjectDeclaration): number {
  return (
    comparePaths(a.path, b.path) ||
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    a.span.endColumn - b.span.endColumn ||
    compareText(a.name, b.name) ||
    compareText(a.kind, b.kind)
  );
}

/** 出现点去重键（路径归一键 + 区间 + 角色；同位置同角色只留一条） */
function projectSiteKey(
  path: string,
  span: Kojo2ReferenceSpan,
  kind: Kojo2ReferenceSiteKind,
): string {
  return `${snapshotPathKey(path)}\u0000${span.startLine}\u0000${span.startColumn}\u0000${span.endLine}\u0000${span.endColumn}\u0000${kind}`;
}

/** 一份快照文件的已建事实（与宿主索引逐文件缓存的那三格同形） */
interface SnapshotFileFacts {
  readonly path: string;
  readonly symbols: readonly Kojo2DocumentSymbolFacts[];
  readonly candidates: readonly Kojo2ReferenceCandidate[];
}

/** 快照文件 → 已建事实（坏条目跳过；同一路径归一键只收第一份） */
function snapshotFactsOf(files: readonly Kojo2ReferenceProjectFile[]): SnapshotFileFacts[] {
  const seen = new Set<string>();
  const out: SnapshotFileFacts[] = [];
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue;
    if (typeof file.path !== 'string' || file.path.length === 0) continue;
    if (typeof file.text !== 'string') continue;
    const key = snapshotPathKey(file.path);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const document = kojo2DocumentOf(file.text);
      out.push({
        path: file.path,
        symbols: kojo2ReferenceSymbolsOf(file.text, { getIndex: () => document }),
        candidates: kojo2ReferenceCandidatesOf(file.text, { getIndex: () => document }),
      });
    } catch {
      // 解析失败 = 这一份没有可证事实：跳过（与宿主索引"坏一次不污染好数据"同向）。
      continue;
    }
  }
  out.sort((a, b) => comparePaths(a.path, b.path));
  return out;
}

/**
 * 一批项目文件 → 满足 {@link Kojo2ReferenceProjectIndex} 的**临时**索引。
 *
 * 查询规则逐条照宿主 `app/src/monaco/kojo2-project-index.ts` 的 `refsOf` / `declsOf` /
 * `symbolAt`：同一份 per-file 事实（`kojo2ReferenceSymbolsOf` / `kojo2ReferenceCandidatesOf`）、
 * 同一套路径序 / 去重 / 上限。宿主那侧是常驻缓存层，这里只是"把快照当项目"——
 * 两边的**尺子**是同一条，缓存与读取方式不同。
 *
 * 空文件集 ⇒ 空索引（`refsOf` 回空、`declsOf` 回空、`symbolAt` 回 `null`），
 * 于是 {@link kojo2ProjectReferencesAt} 自然退化成同文件查询。
 */
export function createKojo2ReferenceSnapshotIndex(
  files: readonly Kojo2ReferenceProjectFile[],
): Kojo2ReferenceProjectIndex {
  const entries = snapshotFactsOf(files);
  const validatePath = (path: unknown): path is string =>
    typeof path === 'string' && path.length > 0;

  const refsOf = (query: Kojo2ProjectRefQuery): Kojo2ProjectRefsResult => {
    if (query === null || typeof query !== 'object') return { refs: [], truncated: false };
    const name: unknown = (query as { name?: unknown }).name;
    const kind: unknown = (query as { kind?: unknown }).kind;
    if (typeof name !== 'string' || name.length === 0) return { refs: [], truncated: false };
    if (typeof kind !== 'string') return { refs: [], truncated: false };

    const only = validatePath((query as { onlyPath?: unknown }).onlyPath)
      ? snapshotPathKey((query as { onlyPath: string }).onlyPath)
      : null;
    const exclude = validatePath((query as { excludePath?: unknown }).excludePath)
      ? snapshotPathKey((query as { excludePath: string }).excludePath)
      : null;

    // 没有声明就没有符号：候选位只在"这个名字 + 种类确实被声明过"时才归属得上。
    const declared = entries.some((entry) =>
      entry.symbols.some((facts) => facts.symbol.name === name && facts.symbol.kind === kind),
    );
    if (!declared) return { refs: [], truncated: false };

    const seen = new Set<string>();
    const refs: Kojo2ProjectReferenceSite[] = [];
    const add = (path: string, span: Kojo2ReferenceSpan, role: Kojo2ReferenceSiteKind): void => {
      const key = projectSiteKey(path, span, role);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ path, span, kind: role });
    };

    for (const entry of entries) {
      if (only !== null && snapshotPathKey(entry.path) !== only) continue;
      if (only === null && exclude !== null && snapshotPathKey(entry.path) === exclude) continue;

      // 本文件里这个名字的所有**声明种类**：候选表达式位按"最近的本地声明"归属——
      // 与 `kojo2ReferencesAt` 的家族隔离同一条判据（变量位不会被算成同名表的引用）。
      const localDeclKinds = new Set<Kojo2ReferenceSymbolKind>();
      for (const facts of entry.symbols) {
        if (facts.symbol.name !== name) continue;
        if (facts.symbol.kind === kind) {
          for (const site of facts.refs) add(entry.path, site.span, site.kind);
        }
        if (facts.symbol.kind === 'scene' || facts.symbol.kind === 'event') continue;
        localDeclKinds.add(facts.symbol.kind);
      }

      // 表达式位：事件不靠表达式引用；幕没有引用位。
      if (kind === 'event' || kind === 'scene') continue;
      if (localDeclKinds.size > 0 && !localDeclKinds.has(kind as Kojo2ReferenceSymbolKind)) continue;
      for (const candidate of entry.candidates) {
        if (candidate.name !== name) continue;
        add(entry.path, candidate.span, candidate.kind);
      }
    }

    refs.sort(compareProjectRefs);
    if (refs.length <= KOJO2_PROJECT_REF_LIMIT) return { refs, truncated: false };
    return { refs: refs.slice(0, KOJO2_PROJECT_REF_LIMIT), truncated: true };
  };

  const declsOf = (name: string): readonly Kojo2ProjectDeclaration[] => {
    if (typeof name !== 'string' || name.length === 0) return [];
    const seen = new Set<string>();
    const out: Kojo2ProjectDeclaration[] = [];
    for (const entry of entries) {
      for (const facts of entry.symbols) {
        if (facts.symbol.name !== name) continue;
        const span = facts.symbol.declSpan;
        const key = projectSiteKey(entry.path, span, 'decl');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: entry.path, name, kind: facts.symbol.kind, span });
      }
    }
    out.sort(compareProjectDecls);
    return out;
  };

  const symbolAt = (query: Kojo2ProjectSymbolQuery): Kojo2ProjectSymbolRef | null => {
    if (query === null || typeof query !== 'object') return null;
    const path: unknown = (query as { path?: unknown }).path;
    const line: unknown = (query as { line?: unknown }).line;
    const column: unknown = (query as { column?: unknown }).column;
    if (!validatePath(path)) return null;
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return null;
    if (typeof column !== 'number' || !Number.isFinite(column) || column < 1) return null;

    const entry = entries.find((candidate) => snapshotPathKey(candidate.path) === snapshotPathKey(path));
    if (entry === undefined) return null;
    const col0 = column - 1;
    const candidate = entry.candidates.find(
      (item) =>
        item.span.startLine === line &&
        col0 >= item.span.startColumn - 1 &&
        col0 <= item.span.endColumn - 1,
    );
    if (candidate === undefined) return null;

    // 项目里这个名字的声明种类：只认进命名空间的声明（幕 / 事件不是表达式引用的目标）。
    const kinds = new Set<Kojo2DeclarationKind>();
    for (const other of entries) {
      for (const facts of other.symbols) {
        if (facts.symbol.name !== candidate.name) continue;
        if (facts.symbol.kind === 'scene' || facts.symbol.kind === 'event') continue;
        kinds.add(facts.symbol.kind);
        // 同名多家族是 core 错误：这里没有可靠判据，交 `null`（不猜）。
        if (kinds.size > 1) return null;
      }
    }
    for (const kind of kinds) return { name: candidate.name, kind };
    return null;
  };

  return { refsOf, declsOf, symbolAt };
}

/**
 * 光标处的引用（**项目文件快照口**，B3e）：同文件判据 + 一批项目快照的跨文件结果。
 *
 * 与 {@link kojo2ProjectReferencesAt} **同一条**合并判据：差别只在索引是现由快照建的
 * （{@link createKojo2ReferenceSnapshotIndex}）。`files` 为空 ⇒ 退化成同文件查询。
 */
export function kojo2ReferencesInProjectFiles(
  source: string,
  position: Kojo2ReferencePosition,
  files: readonly Kojo2ReferenceProjectFile[] | undefined,
  options: Kojo2ProjectLookupOptions = {},
): Kojo2ProjectReferencesResult | null {
  const index =
    files === undefined || files.length === 0
      ? null
      : createKojo2ReferenceSnapshotIndex(files);
  return kojo2ProjectReferencesAt(source, position, index, options);
}
