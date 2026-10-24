/**
 * Kojo 2.0 **查找全部引用**（K2-LSP-REFS）：同文件符号 → 全部可证出现点（Shift+F12）。
 *
 * ## 回答什么
 *
 * {@link kojo2ReferencesAt} 是**纯函数**：源码 + 1 基行列进，符号事实 + 出现点列表出。
 * 符号面覆盖本批语义层的全部声明形态：
 * - `@函` / `# 表` / `# 池` / `# 模` / `# 变量` / `# 常量`（声明索引 `kojo2-declarations.ts` 同一份）；
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
 * - `# 表 … 由 <表达式>` 的 `由` 之后（表体行是字面量，不扫）；
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
 * ## 分层
 *
 * - {@link kojo2ReferencesAt}：纯逻辑，零 IO、零 Monaco、零注册；不可识别位置 → `null`；
 * - {@link installKojo2ReferenceProvider}：只挂 `kojo2` 语言 id，flag 关**零注册**，dispose 幂等，
 *   provider 内任何异常回 `[]`（Monaco 把 throw 吞成"引用面板突然空了"，空数组才是它能读出
 *   的形状）；注册半途抛错原样外抛（只有一枚注册，没有半成品要回滚，宿主那侧的"全有或全无"
 *   才有机会收口）；
 * - 索引注入位 {@link Kojo2ReferenceIndexSource}：缺省现建 `kojo2DocumentOf`；宿主可注入
 *   同一份已建索引（性能缝）；
 * - **跨文件（K2-INDEX-REFS）**：{@link kojo2ReferenceSymbolsOf} 把同一套判据摊成"整篇的
 *   每个符号"，项目索引（`kojo2-project-index.ts`）只消费它；{@link kojo2ProjectReferencesAt}
 *   把本文件结果与索引的跨文件结果合并（声明位在前），
 *   {@link installKojo2ProjectReferenceProvider} 是它的 Monaco 落点。索引本身零 IO，
 *   由宿主从项目扫描喂文本。
 *
 * ## 已知边界
 *
 * - 跨文件查找有两档归属：本文件有同名声明（或事件挂点）时走同文件判据；本文件没有时走
 *   项目索引的候选位 + `symbolAt`（要求 `options.path`，且项目里这个名字**只有一种**
 *   声明种类）——同名多家族是 core 错误，此时回 `null`，不猜；
 * - 表体行端点（`# 表` 的 `0..99`）在 core 是表达式位，本批不收集（表体行的值列是字面量，
 *   按行扫会把值误当引用；要精确得走 AST 行结构，留给后续批）；
 * - `# 视` 的视角目标、`@跳` / `@标` 的标签名不属本批符号面（没有声明索引可归属）。
 */
import type * as Monaco from './entry';
import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
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
} from '@kojo/kojo-lang';
import { isNameChar } from './kojo-completion-position';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import type { Kojo2ProjectIndex, Kojo2ProjectSymbolRef } from './kojo2-project-index';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';

/* ============================== 词形（core 单源） ============================== */

/** `# 机` 的声明词（core `KOJO_DECL_WORDS` 位序 §3.3） */
const MACHINE_WORD = KOJO_DECL_WORDS[2];

/** `# 表` / `# 变量` 的声明词（core 位序 §3.3） */
const TABLE_WORD = KOJO_DECL_WORDS[5];
const VARIABLE_WORD = KOJO_DECL_WORDS[3];

/** `@函` / `@织`（core `KOJO_DISPATCH_WORDS` 位序 §2.1） */
const FUNCTION_WORD = KOJO_DISPATCH_WORDS[8];
const WEAVE_WORD = KOJO_DISPATCH_WORDS[9];

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
 * "这一篇里的每一个"。项目索引（`kojo2-project-index.ts`）只消费它，**不另写扫描器**——
 * 跨文件引用与同文件引用因此不可能给出两套不同的事实。
 *
 * `refs` 源码序、含声明位、同位置只出现一次（与 `kojo2ReferencesAt().refs` 逐条同口径）。
 */
export interface Kojo2DocumentSymbolFacts {
  readonly symbol: Kojo2ReferenceSymbol;
  readonly refs: readonly Kojo2ReferenceSite[];
}

/**
 * 一处**候选引用位**：语法上确实是表达式 / 调用位的一个标识符，但**不要求**这个名字
 * 在本文件里有声明（项目索引要看见"只在别的文件声明"的名字）。
 *
 * 位置判据与 {@link kojo2ReferencesAt} 逐条相同（同一套 `collectLine` / `scanIdentifiers`）；
 * 唯一的放宽是去掉"本地声明名单"过滤——这一步在项目索引里换成了"项目里有这个符号吗"。
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
 * **同一版本**（换版本会让行列落错位）。跨文件项目索引是**另一条注入路**（`Kojo2ProjectIndex`）。
 */
export type Kojo2ReferenceIndexSource = (source: string) => Kojo2Document | null;

/** 纯逻辑的注入面 */
export interface Kojo2ReferenceOptions {
  readonly getIndex?: Kojo2ReferenceIndexSource;
}

/** 安装器的注入面（同文件 provider 只有索引缝；跨文件接线见 `installKojo2ProjectReferenceProvider`） */
export interface Kojo2ReferenceProviderOptions extends Kojo2ReferenceOptions {}

/** 单次结果的条数上限；超出部分按源码序截掉并置 `truncated` */
export const KOJO2_REFERENCE_LIMIT = 500;

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

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
interface EventAttestation extends NameSpanFact {
  readonly machine: boolean;
}

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

/** 一行的事件名（`# 机` / `@织` 的第一个词）；不是事件行 / 没写名字 ⇒ `null` */
function eventNameOf(line: KojoLexLine): { readonly name: string; readonly offset: number } | null {
  let machine: boolean;
  if (line.kind === 'decl' && line.known && line.word === MACHINE_WORD) machine = true;
  else if (line.kind === 'dispatch' && line.known && line.word === WEAVE_WORD) machine = false;
  else return null;
  const first = splitSpaces(line.rest, line.restOffset)[0];
  if (first === undefined || first.text.length === 0) return null;
  return { name: first.text, offset: first.offset };
}

/**
 * 全部事件挂点（源码序）。`# 机` 与 `@织` 的第一个词都进这张表；是不是声明由
 * {@link EventGroup} 决定（有 `# 机` 时 `# 机` 是声明，否则最早 `@织` 是锚点）。
 */
function eventAttestationsOf(document: Kojo2Document): EventAttestation[] {
  const out: EventAttestation[] = [];
  for (const line of document.lines) {
    const event = eventNameOf(line);
    if (event === null) continue;
    const startColumn = event.offset - line.lineOffset + 1;
    out.push({
      name: event.name,
      line: line.number,
      startColumn,
      endColumn: startColumn + event.name.length,
      machine: line.kind === 'decl',
    });
  }
  return out;
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
  /** `null` = 不做名字过滤（项目索引的"候选引用位"要看见本文件没声明的名字） */
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
        // `# 表 <名> 由 <表达式>`：只扫 `由` 之后；表体行是字面量，不碰。
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
    collectLine(collector, line, text, expressionContextOf(enclosing));
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

/* ============================== 整篇符号事实（项目索引的取数口） ============================== */

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
 * 一篇源文的**全部可归属符号**与各自出现点（纯函数；项目索引的逐文件取数口）。
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
 * 一篇源文的**全部候选引用位**（纯函数；项目索引跨文件查询的另一半取数口）。
 *
 * 与 {@link kojo2ReferencesAt} 走同一条 `collectLine` / `scanIdentifiers` 扫描，唯一放宽：
 * 不再要求名字在本文件里有声明。去掉了这一步，才能看见"只在别的文件里声明"的真实引用
 * （例如 B 文件里 `{心情}`，而 `# 表 心情` 写在 A 文件）。
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

/* ============================== Monaco 翻译层 ============================== */

/** 取整篇源文；取不到（模型已 dispose / 桩 model）⇒ `null` */
function sourceOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** model 的 uri；没有 uri 的桩 model ⇒ `undefined`（`Location` 缺 uri 无处可落） */
function uriOf(model: Monaco.editor.ITextModel): Monaco.Uri | undefined {
  const uri = (model as unknown as { uri?: unknown }).uri;
  return uri !== null && typeof uri === 'object' ? (uri as Monaco.Uri) : undefined;
}

/** span → `Monaco.IRange`（字段名换一遍，数值不动） */
function toMonacoRange(span: Kojo2ReferenceSpan): Monaco.IRange {
  return {
    startLineNumber: span.startLine,
    startColumn: span.startColumn,
    endLineNumber: span.endLine,
    endColumn: span.endColumn,
  };
}

/**
 * **唯一**的 ReferenceProvider 注册点（同文件 / 跨文件两个 provider 共用）。
 *
 * 注册失败原样外抛（只有一枚注册，没有半成品要回滚）；dispose 幂等且不抛（一枚撤不掉
 * 不许把卸载链带崩）。ReferenceProvider 的注册**在源码里只此一处**——既有测试用
 * "只注册一次"钉的就是这条纪律。
 */
function installKojo2Provider(
  monaco: typeof Monaco,
  provider: Monaco.languages.ReferenceProvider,
): Monaco.IDisposable {
  const registration = monaco.languages.registerReferenceProvider(KOJO2_LANGUAGE_ID, provider);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}

/**
 * 为 `kojo2` 语言注册 ReferenceProvider（Shift+F12），返回**幂等**的 disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**）；
 * - 只挂 `KOJO2_LANGUAGE_ID`：v1 的 `.kojo` / `.erb` 面各由 `find-references.ts` 的
 *   `registerForLanguageServices` 挂，两边不重叠；
 * - `includeDeclaration === false`（Monaco 清点"不含声明"时）⇒ 只交 `ref` / `call`；
 * - provider 内任何异常（取文失败 / 坏位置 / 模型无 uri）回 `[]`；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚）。
 */
export function installKojo2ReferenceProvider(
  monaco: typeof Monaco,
  options: Kojo2ReferenceProviderOptions = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  return installKojo2Provider(monaco, {
    provideReferences(model, position, context) {
      try {
        const source = sourceOf(model);
        if (source === null) return [];
        const result = kojo2ReferencesAt(source, {
          line: position.lineNumber,
          column: position.column,
        }, options);
        if (result === null) return [];
        const uri = uriOf(model);
        if (uri === undefined) return [];
        const includeDeclaration = context?.includeDeclaration !== false;
        const locations: Monaco.languages.Location[] = [];
        for (const site of result.refs) {
          if (!includeDeclaration && site.kind === 'decl') continue;
          locations.push({ uri, range: toMonacoRange(site.span) });
        }
        return locations;
      } catch {
        // Monaco 把 throw 吞成"引用面板突然空了"；空数组是它能读出的唯一形状。
        return [];
      }
    },
  });
}

/* ============================== 跨文件项目引用（K2-INDEX-REFS） ============================== */

/** 跨文件的一条出现点（落点路径 + 区间 + 角色；路径是宿主给的原样路径） */
export interface Kojo2ProjectReferenceSite {
  readonly path: string;
  readonly span: Kojo2ReferenceSpan;
  readonly kind: Kojo2ReferenceSiteKind;
}

/**
 * 合并结果里的一条出现点。
 *
 * `path === null` = **本文件**（provider 用 `model.uri` 落点）；其余是项目索引里的另一份
 * 文件（provider 用注入的 `path → Uri` 转换，缺省 `monaco.Uri.file`）。
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
  /** 本文件或索引任一侧触到上限（索引侧 {@link KOJO2_PROJECT_REF_LIMIT}） */
  readonly truncated: boolean;
}

/** 跨文件查找的注入面 */
export interface Kojo2ProjectLookupOptions {
  /** 本文件路径：给出后索引侧会排除它（避免同一份文件在 `local` / `external` 里各出一遍） */
  readonly path?: string;
  /** 本文件文档索引的注入位（透传给 `kojo2ReferencesAt`，与同文件查询同一口径） */
  readonly getIndex?: Kojo2ReferenceIndexSource;
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
 * - 跨文件这一半只向项目索引问 `refsOf({ name, kind })`——索引的每个文件事实又是用
 *   {@link kojo2ReferenceSymbolsOf} / {@link kojo2ReferenceCandidatesOf} 建的，所以两边
 *   不可能各说一套。
 *
 * **本文件没有改名声明时**（典型形态：B 文件里 `{心情}`，而 `# 表 心情` 在 A 文件）：
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
  index: Kojo2ProjectIndex | null | undefined,
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

/** 跨文件 provider 的注入面 */
export interface Kojo2ProjectReferenceProviderOptions {
  /** 项目索引 getter（宿主接自己那份 `createKojo2ProjectIndex()`；缺席 = 退化为同文件） */
  readonly getIndex?: () => Kojo2ProjectIndex | null | undefined;
  /** model → 本文件路径（缺省取 `model.uri.fsPath` / `uri.path`；取不到 = 索引不排除自身） */
  readonly pathOf?: (model: Monaco.editor.ITextModel) => string | undefined;
  /**
   * 跨文件 `path` → `Monaco.Uri`（缺省 `monaco.Uri.file`）。
   * 转换抛错 / 转换不出 ⇒ 这一条落 `model.uri`（"缺省 model.uri 兜底"）。
   */
  readonly uriForPath?: (path: string) => Monaco.Uri | undefined;
}

/** 取本文件路径：注入转换优先；缺省读 uri 的 fsPath / path（两者都取不到 ⇒ undefined） */
function pathOfModel(
  model: Monaco.editor.ITextModel,
  pathOf: ((model: Monaco.editor.ITextModel) => string | undefined) | undefined,
): string | undefined {
  if (pathOf !== undefined) {
    try {
      const path = pathOf(model);
      return typeof path === 'string' && path.length > 0 ? path : undefined;
    } catch {
      return undefined;
    }
  }
  const uri = uriOf(model) as unknown as { fsPath?: unknown; path?: unknown } | undefined;
  if (uri === undefined) return undefined;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  return undefined;
}

/** path → Uri（注入优先；缺省 monaco.Uri.file；失败 / 不可用 ⇒ undefined，由调用方兜底） */
function uriForProjectPath(
  monaco: typeof Monaco,
  path: string,
  uriForPath: ((path: string) => Monaco.Uri | undefined) | undefined,
): Monaco.Uri | undefined {
  if (uriForPath !== undefined) {
    try {
      return uriForPath(path);
    } catch {
      return undefined;
    }
  }
  const uriApi = (monaco as unknown as { Uri?: { file?: (path: string) => Monaco.Uri } }).Uri;
  try {
    return typeof uriApi?.file === 'function' ? uriApi.file(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 为 `kojo2` 语言注册**跨文件** ReferenceProvider（Shift+F12），返回**幂等** disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**）；
 * - 只挂 `KOJO2_LANGUAGE_ID`，与 {@link installKojo2ReferenceProvider} 二选一（同时装会得到
 *   两份结果，宿主按批次切换，不在这里替宿主去重）；
 * - 索引 getter 抛错 / 回 `null` ⇒ 只是没有跨文件这一半，本文件结果照旧交出；
 * - `includeDeclaration === false` ⇒ 去掉**所有** `decl` 位（含跨文件那份声明）；
 * - 取文失败 / model 无 uri / 任何异常 ⇒ `[]`；注册失败原样外抛（一枚注册，无半成品）。
 */
export function installKojo2ProjectReferenceProvider(
  monaco: typeof Monaco,
  options: Kojo2ProjectReferenceProviderOptions = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  return installKojo2Provider(monaco, {
    provideReferences(model, position, context) {
      try {
        const source = sourceOf(model);
        if (source === null) return [];
        const modelUri = uriOf(model);
        if (modelUri === undefined) return [];
        const path = pathOfModel(model, options.pathOf);

        let index: Kojo2ProjectIndex | null = null;
        if (options.getIndex !== undefined) {
          try {
            index = options.getIndex() ?? null;
          } catch {
            index = null;
          }
        }

        const result = kojo2ProjectReferencesAt(
          source,
          { line: position.lineNumber, column: position.column },
          index,
          path === undefined ? {} : { path },
        );
        if (result === null) return [];

        const includeDeclaration = context?.includeDeclaration !== false;
        const locations: Monaco.languages.Location[] = [];
        for (const site of result.refs) {
          if (!includeDeclaration && site.kind === 'decl') continue;
          const uri =
            site.path === null
              ? modelUri
              : (uriForProjectPath(monaco, site.path, options.uriForPath) ?? modelUri);
          locations.push({ uri, range: toMonacoRange(site.span) });
        }
        return locations;
      } catch {
        return [];
      }
    },
  });
}
