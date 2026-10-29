/**
 * Kojo 2.0 **文档符号**（K2-EDITOR-SYMBOLS，设计稿 §16.7 U6.2/U6.3 的符号 / 大纲面）。
 *
 * ## 这一层回答的两个问题
 *
 * 1. **大纲**（Ctrl+Shift+O）：这篇 2.0 文件里有哪些可导航的结构？——`# 幕 / 视 / 机 / 变量 /
 *    常量 / 表 / 池 / 模`、`@函`、`@织`，各带真 span 与层级；
 * 2. **面包屑**：光标此刻住在哪条符号链里？——{@link kojo2SymbolPathAt} 交回
 *    **光标 → 根** 的名字数组。
 *
 * ## 覆盖与不覆盖（`?` 链不是声明）
 *
 * 只有**声明**产符号：`#` 声明词（core 的 `KOJO_DECL_WORDS` 全表）与两枚"声明型 `@`"
 * （`@函` / `@织`）。`? 条件` 是池 / 控制流的分支头，不是声明 ⇒ 一条符号都不产
 * （同一口径：`? 否` 也不产）。台词 / 旁白 / 注释 / `@原生` 体同样不产。
 *
 * ## 真 span（不拿整行猜块边界）
 *
 * - **名字**：`selectionRange` = 声明词之后的名字段（`# 幕` 取整段标题、`# 模` / `@函` 取
 *   `(` 之前），偏移直接取 core 词法层的 `restOffset` / `splitSpaces`（词法行已经裁过缩进与
 *   行尾空白）——与 `kojo2-declarations.ts` 的名字区间同一口径（测试逐条对拍，防两份尺子漂移）；
 * - **块**：`range` = core AST 的 `span`（`# 对照表` 到末行表体、`# 池` 到末条分支正文、
 *   `# 模` / `@函` / `@织` 到块体末行、`# 幕` 到本幕最后一个叙事节点）。**不按缩进自己收块**：
 *   `# 模` 体里的 `[插槽]`、`@函` 体里的空行、`@原生` 围栏都会让"看缩进猜尾巴"算错。
 *
 * ## 层级（大纲树）
 *
 * core 把声明**提升**到 `decls`（语义上是文件级），但大纲要回答的是"**文档里**住在哪一段"。
 * 因此 `container` 的判据是**真 span 包含**：一枚符号的父 = 它前面那些**区间完整包住它**的
 * 符号里**最内层**的那一枚。这条判据只有两种来源：
 * - `# 幕` 的 span 覆盖它后面写下的声明（多幕文件里每幕各收自己那一段）；
 * - 未来的嵌套块若含声明型符号，也同样按 span 归位（当前语法里没有）。
 * 声明区写在首个 `# 幕` 之前 ⇒ 没有容器，是顶层符号。区间相等不算包含（防自套）。
 *
 * ## 分层（B1 起本模块住在 `@kojo/kojo-lang`）
 *
 * - {@link kojo2DocumentSymbols} / {@link kojo2SymbolPathAt} 是**纯函数**：源码文本进，
 *   事实 / 名字数组出；零 IO、零 Monaco、零缓存（同输入必同输出）；
 * - **把事实翻成 `monaco.languages.DocumentSymbol` 的那一半留在宿主**
 *   （`app/src/monaco/kojo2-symbols.ts`：`kojo2SymbolKindToMonaco` /
 *   `kojo2DocumentSymbolTree` / `installKojo2DocumentSymbolProvider`）。
 *   语言面库不认识 Monaco，这条边界正是 B1 要立的：能被插件复用的那一半只吃文本。
 *   那边**不看 cutover 开关**（K2-STRUCTURE-GATE，批次十一：大纲是只读呈现面，与写回 /
 *   迁移 / 切解析器解耦）；provider 内任何异常一律回 `[]`——Monaco 把 provider 的 throw
 *   吞成"大纲突然空了"，作者看不到任何原因，空数组才是它能读出的唯一形状。
 *
 * ## 确定性
 *
 * 事实按 `selectionRange` 起点（行、列）+ 名字码元序排序（源码序）；同输入两次调用逐字相等。
 * 排序键不用 `localeCompare`：locale 随环境变，大纲顺序不该随运行环境漂。
 */
import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_TABLE_SUBJECT,
  KOJO_TEMPLATE_SLOT,
  KOJO_WEAVE_MODIFIERS,
  lex,
  parse,
  splitSpaces,
  type KojoDecl,
  type KojoDialectDecl,
  type KojoLexLine,
  type KojoLiteral,
  type KojoSpan,
  type KojoWeaveModifier,
} from '@kojo/kojo-core';
import { kojo2StorageWordOf, kojo2TypeWordOf } from './declarations';

/* ============================== 词形（core 单源） ============================== */

/**
 * 声明词的位序（core `tokens.ts` §3.3）。**不是新词表**：下面每一格都是
 * `KOJO_DECL_WORDS` 的元素；`detail` 文案只拼这些词，本文件不写任何声明字形。
 */
const [
  SCENE_WORD,
  VIEW_WORD,
  MACHINE_WORD,
  VARIABLE_WORD,
  CONSTANT_WORD,
  TABLE_WORD,
  POOL_WORD,
  TEMPLATE_WORD,
] = KOJO_DECL_WORDS;

/** `@函` / `@织` 在调度词表里的位序（core `tokens.ts` §2.1） */
const FUNCTION_WORD = KOJO_DISPATCH_WORDS[8];
const WEAVE_WORD = KOJO_DISPATCH_WORDS[9];

/* ============================== 公共形状 ============================== */

/**
 * 符号的语义种类（= 声明种类）。**不是** Monaco 的 `SymbolKind`：
 * 纯逻辑层不引 Monaco 运行时；翻译层用 {@link kojo2SymbolKindToMonaco} 统一映射。
 */
export type Kojo2SymbolKind =
  | 'scene'
  | 'view'
  | 'machine'
  | 'variable'
  | 'constant'
  | 'table'
  | 'pool'
  | 'template'
  | 'function'
  | 'weave';

/** 符号种类 → 声明词（`detail` 文案与测试共用；词形来自 core） */
export const KOJO2_SYMBOL_WORD_BY_KIND: Readonly<Record<Kojo2SymbolKind, string>> = Object.freeze({
  scene: SCENE_WORD,
  view: VIEW_WORD,
  machine: MACHINE_WORD,
  variable: VARIABLE_WORD,
  constant: CONSTANT_WORD,
  table: TABLE_WORD,
  pool: POOL_WORD,
  template: TEMPLATE_WORD,
  function: FUNCTION_WORD,
  weave: WEAVE_WORD,
});

/** 1 基行列（UTF-16 码元；与 Monaco / core / plugin-api 同口径） */
export interface Kojo2SymbolPosition {
  readonly line: number;
  readonly column: number;
}

/** 1 基半开区间（`endColumn` 是名字/块尾的**后一位**；与 Monaco `IRange` 同口径） */
export interface Kojo2SymbolRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * 一条符号事实（平铺；树由 `container` 在翻译层组）。
 *
 * `container` = 父符号在**本数组**里的下标（父恒在子之前 ⇒ 一遍扫描即可组树）；
 * 缺省 = 顶层。用下标而不是名字：同名声明（core 会报错）在错误态下也得有确定的树。
 */
export interface Kojo2SymbolFact {
  readonly name: string;
  /** 一行副标题（声明词 + 该种类能一句话说清的事实；长表达式截断） */
  readonly detail: string;
  readonly kind: Kojo2SymbolKind;
  /** 整段真 span（声明头到块体末行；单行声明就是该行） */
  readonly range: Kojo2SymbolRange;
  /** 名字段（大纲跳转 / 面包屑落点压在这里） */
  readonly selectionRange: Kojo2SymbolRange;
  readonly container?: number;
}

/* ============================== 小工具 ============================== */

/** `detail` 一行上限（大纲一行一项；长表达式截断而不是折行） */
const DETAIL_MAX = 60;

/** 字面量的显示形态（字符串带引号；数字按十进制）——与声明索引同一口径 */
function formatLiteral(value: KojoLiteral): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * 截断到 `max` 码元（含尾省略号）。截断点落在代理对中间时再退一码元——
 * 孤立代理在 Monaco 里显示成 `�`，等于静默丢字。
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** 非空词用空格拼接（空段先滤掉；不留下双空格） */
function joinWords(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(' ');
}

/* ============================== 名字段（真偏移） ============================== */

interface NameSpan {
  readonly text: string;
  /** 名字首字符的 0 基绝对偏移 */
  readonly startOffset: number;
}

/** `rest` 里 `(` 之前的头段长度（`# 模` / `@函` 的名字到 `(` 为止；没有 `(` 就整段） */
function headLengthOf(rest: string): number {
  const open = rest.indexOf('(');
  return open < 0 ? rest.length : open;
}

/**
 * 名字段：`# 幕` 整段标题；`# 模` / `@函` 取 `(` 之前；其余取 `rest` 的第一枚空格分隔词
 * （`# 机 指令 310` 的名字是事件 `指令`，`310` 进 detail；`@织 指令 之前` 同理）。
 *
 * 区间一律从词法行取，不从 AST 名字反搜：名字里可以含空格之外的任意字符，反搜会落到
 * 声明词 / 参数上的同名词。
 */
function nameSpanOf(kind: Kojo2SymbolKind, line: KojoLexLine): NameSpan | null {
  if (kind === 'scene') {
    if (line.kind !== 'decl' || line.rest.length === 0) return null;
    return { text: line.rest, startOffset: line.restOffset };
  }
  if (kind === 'template' || kind === 'function') {
    if (line.kind !== 'decl' && line.kind !== 'dispatch') return null;
    const head = line.rest.slice(0, headLengthOf(line.rest)).trim();
    if (head.length === 0) return null;
    return { text: head, startOffset: line.restOffset + line.rest.indexOf(head) };
  }
  if (line.kind !== 'decl' && line.kind !== 'dispatch') return null;
  const first = splitSpaces(line.rest, line.restOffset)[0];
  if (first === undefined || first.text.length === 0) return null;
  return { text: first.text, startOffset: first.offset };
}

/** 名字段 → 1 基 `selectionRange`（名字不跨行：词法行已按行切好） */
function selectionRangeOf(line: KojoLexLine, span: NameSpan): Kojo2SymbolRange {
  const startColumn = span.startOffset - line.lineOffset + 1;
  return {
    startLine: line.number,
    startColumn,
    endLine: line.number,
    endColumn: startColumn + span.text.length,
  };
}

/** core AST span → 1 基半开区间（恒等搬运：AST 与 Monaco 同坐标系） */
function rangeOfSpan(span: KojoSpan): Kojo2SymbolRange {
  return {
    startLine: span.start.line,
    startColumn: span.start.column,
    endLine: span.end.line,
    endColumn: span.end.column,
  };
}

/* ============================== AST → 种类 / detail ============================== */

/** AST 声明节点 → 符号种类（9 种可导航声明；`# 幕` 由 `scenes` 单独出）
 *
 * `# 方言` **不在内**：它只断言这份文件属于哪个方言，不声明任何可被引用的名字
 * （spec §3.3 / LAU §5.3），所以大纲里没有它——入参见调用点的 `dialect` 过滤。
 */
function symbolKindOfDecl(decl: Exclude<KojoDecl, KojoDialectDecl>): Kojo2SymbolKind {
  switch (decl.kind) {
    case 'view':
      return 'view';
    case 'machine':
      return 'machine';
    case 'var':
      return 'variable';
    case 'const':
      return 'constant';
    case 'table':
      return 'table';
    case 'pool':
      return 'pool';
    case 'template':
      return 'template';
    case 'function':
      return 'function';
    case 'weave':
      return 'weave';
  }
}

/** 参数表（`@函` / `# 模` 共用；有默认值的写成 `名 = 值`） */
function formatParams(
  params: readonly { readonly name: string; readonly defaultValue?: KojoLiteral }[],
): string {
  if (params.length === 0) return '()';
  const parts = params.map((param) =>
    param.defaultValue === undefined
      ? param.name
      : `${param.name} = ${formatLiteral(param.defaultValue)}`,
  );
  return `(${parts.join(', ')})`;
}

/** `@织` 修饰词 → core 词形（`pri` → `之前`；位序即 `KOJO_WEAVE_MODIFIERS`） */
function modifierWordOf(modifier: KojoWeaveModifier): string {
  const index = modifier === 'pri' ? 0 : modifier === 'later' ? 1 : 2;
  return KOJO_WEAVE_MODIFIERS[index] ?? modifier;
}

/**
 * 一行副标题：**种类词 + 该种类能一句话说清的事实**（类型 / 初值 / 存储期 / 由谁驱动 /
 * 分支数 / 参数 / 修饰词）。读不到的事实不写（与悬停同一条"不编默认值"纪律：
 * `# 对照表` 的 `依据` 表达式若因语法错误为空，就不写"依据"，只写行数）。
 */
function detailOfDecl(decl: Exclude<KojoDecl, KojoDialectDecl>): string {
  switch (decl.kind) {
    case 'view':
      return VIEW_WORD;
    case 'machine':
      return clip(joinWords([MACHINE_WORD, ...decl.args]), DETAIL_MAX);
    case 'var': {
      const array = decl.arraySize === undefined ? '' : `[${decl.arraySize.text}]`;
      const type = `${kojo2TypeWordOf(decl.valueType)}${array}`;
      const init = decl.init === undefined ? '' : `= ${formatLiteral(decl.init)}`;
      return clip(
        joinWords([`${VARIABLE_WORD} ${type}`, init, kojo2StorageWordOf(decl.storage)]),
        DETAIL_MAX,
      );
    }
    case 'const':
      return clip(
        `${CONSTANT_WORD} ${kojo2TypeWordOf(decl.valueType)} = ${formatLiteral(decl.value)}`,
        DETAIL_MAX,
      );
    case 'table': {
      const subject =
        decl.subject.text.length === 0
          ? TABLE_WORD
          : `${TABLE_WORD} ${KOJO_TABLE_SUBJECT} ${decl.subject.text}`;
      return clip(`${subject} · ${decl.rows.length} 行`, DETAIL_MAX);
    }
    case 'pool':
      return `${POOL_WORD} · ${decl.branches.length} 分支`;
    case 'template': {
      const slot = decl.slotIndex === null ? '' : ` · ${KOJO_TEMPLATE_SLOT}`;
      return clip(`${TEMPLATE_WORD} ${formatParams(decl.params)}${slot}`, DETAIL_MAX);
    }
    case 'function':
      return clip(`${FUNCTION_WORD} ${formatParams(decl.params)}`, DETAIL_MAX);
    case 'weave':
      return clip(
        joinWords([WEAVE_WORD, ...decl.args, ...decl.modifiers.map(modifierWordOf)]),
        DETAIL_MAX,
      );
  }
}

/* ============================== 排序 / 包含 ============================== */

/** 码元序比较（不用 `localeCompare`：顺序不随运行环境漂） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 源码序：先起点行、再起点列、最后名字（同起点只可能出现在坏输入里） */
function compareFacts(a: Kojo2SymbolFact, b: Kojo2SymbolFact): number {
  return (
    a.selectionRange.startLine - b.selectionRange.startLine ||
    a.selectionRange.startColumn - b.selectionRange.startColumn ||
    compareText(a.name, b.name)
  );
}

function compareRangeStart(a: Kojo2SymbolRange, b: Kojo2SymbolRange): number {
  return a.startLine - b.startLine || a.startColumn - b.startColumn;
}

function compareRangeEnd(a: Kojo2SymbolRange, b: Kojo2SymbolRange): number {
  return a.endLine - b.endLine || a.endColumn - b.endColumn;
}

/** `outer` 是否**完整包住** `inner`（区间相等不算包含：防同一段被当成自己的父） */
function rangeContainsRange(outer: Kojo2SymbolRange, inner: Kojo2SymbolRange): boolean {
  if (compareRangeStart(outer, inner) > 0) return false;
  if (compareRangeEnd(outer, inner) < 0) return false;
  return !(
    compareRangeStart(outer, inner) === 0 &&
    compareRangeEnd(outer, inner) === 0
  );
}

/** 光标位点是否落在区间里（尾列按**可停靠**算：Monaco 的行末列恰是 `endColumn`） */
function rangeContainsPosition(range: Kojo2SymbolRange, position: Kojo2SymbolPosition): boolean {
  if (position.line < range.startLine || position.line > range.endLine) return false;
  if (position.line === range.startLine && position.column < range.startColumn) return false;
  if (position.line === range.endLine && position.column > range.endColumn) return false;
  return true;
}

/* ============================== 组树（container） ============================== */

/**
 * 给平铺事实补 `container`：父 = 前面那些**完整包住它**的符号里**最内层**的一枚。
 *
 * "最内层" = 起点最靠后（相同起点时区间更短）。因为输入已按源码序排好，父恒在子之前，
 * 翻译层一遍扫描就能组树。找不到父 ⇒ 留空（顶层），**不拿"最近的前一条"凑**：
 * 那是把上一段声明错认成父。
 */
function withContainers(facts: readonly Kojo2SymbolFact[]): Kojo2SymbolFact[] {
  const out: Kojo2SymbolFact[] = [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i]!;
    let parent: number | undefined;
    for (let j = 0; j < i; j++) {
      const candidate = facts[j]!;
      if (!rangeContainsRange(candidate.range, fact.range)) continue;
      if (parent === undefined) {
        parent = j;
        continue;
      }
      const current = facts[parent]!;
      const start = compareRangeStart(candidate.range, current.range);
      const end = compareRangeEnd(candidate.range, current.range);
      if (start > 0 || (start === 0 && end < 0)) parent = j;
    }
    out.push(parent === undefined ? fact : { ...fact, container: parent });
  }
  return out;
}

/* ============================== 纯逻辑：文档符号 ============================== */

/** 头部词法行的词是否确实对得上这个符号种类（AST 与词法错位时宁可不给符号） */
function headerLineMatches(kind: Kojo2SymbolKind, line: KojoLexLine): boolean {
  if (kind === 'function') return line.kind === 'dispatch' && line.word === FUNCTION_WORD;
  if (kind === 'weave') return line.kind === 'dispatch' && line.word === WEAVE_WORD;
  if (kind === 'scene') return line.kind === 'decl' && line.word === SCENE_WORD;
  return line.kind === 'decl' && line.word === KOJO2_SYMBOL_WORD_BY_KIND[kind];
}

/**
 * 一篇 2.0 源文 → 平铺符号事实（源码序）。
 *
 * **纯函数**：一次 `lex` + 一次 `parse`，不缓存、不写盘、不抛。
 * 空文件 / 坏文件（词法或解析抛错、或根本没有任何声明）⇒ `[]`。
 * 声明缺名字（`# 变量` 没写名、`# 幕` 没写标题）⇒ 那一条不产符号（没有可导航的名字）。
 */
export function kojo2DocumentSymbols(source: string): Kojo2SymbolFact[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  let facts: Kojo2SymbolFact[];
  try {
    const lexed = lex(source);
    const file = parse(lexed);
    facts = [];
    for (const scene of file.scenes) {
      if (scene.title === null || scene.title.trim().length === 0) continue;
      const line = lexed.lines[scene.span.start.line - 1];
      if (line === undefined || !headerLineMatches('scene', line)) continue;
      const nameSpan = nameSpanOf('scene', line);
      if (nameSpan === null) continue;
      facts.push({
        name: nameSpan.text,
        detail: SCENE_WORD,
        kind: 'scene',
        range: rangeOfSpan(scene.span),
        selectionRange: selectionRangeOf(line, nameSpan),
      });
    }
    for (const decl of file.decls) {
      // `# 方言` 是断言、不声明可导航的名字 ⇒ 大纲里没有它（spec §3.3 / LAU §5.3）。
      if (decl.kind === 'dialect') continue;
      const kind = symbolKindOfDecl(decl);
      const line = lexed.lines[decl.span.start.line - 1];
      if (line === undefined || !headerLineMatches(kind, line)) continue;
      const nameSpan = nameSpanOf(kind, line);
      if (nameSpan === null) continue;
      facts.push({
        name: nameSpan.text,
        detail: detailOfDecl(decl),
        kind,
        range: rangeOfSpan(decl.span),
        selectionRange: selectionRangeOf(line, nameSpan),
      });
    }
  } catch {
    // 词法 / 解析在坏输入上的意外：大纲是只读呈现面，回空比把异常送进 Monaco 好。
    return [];
  }
  if (facts.length === 0) return [];
  facts.sort(compareFacts);
  return withContainers(facts);
}

/* ============================== 纯逻辑：面包屑路径 ============================== */

/** 父链深度（防御性上限：坏输入里的循环容器索引不许把调用方挂死） */
function depthOf(facts: readonly Kojo2SymbolFact[], index: number): number {
  let depth = 0;
  let cursor: number | undefined = facts[index]?.container;
  while (cursor !== undefined && cursor >= 0 && cursor < facts.length && depth <= facts.length) {
    depth++;
    cursor = facts[cursor]?.container;
  }
  return depth;
}

/** 位点是否有可用的数值坐标（NaN / 非有限 / 行列 < 1 一律不可查） */
function isUsablePosition(
  position: Kojo2SymbolPosition | null | undefined,
): position is Kojo2SymbolPosition {
  if (position === null || position === undefined) return false;
  return (
    Number.isFinite(position.line) &&
    Number.isFinite(position.column) &&
    position.line >= 1 &&
    position.column >= 1
  );
}

/**
 * 光标位点 → 符号名字数组（**光标 → 根**，最内层在前）。
 *
 * 判据 = 区间包含（真 span），与大纲树同源：光标在某行表体里 ⇒ `[表名, 幕名]`；
 * 在声明区（首个 `# 幕` 之前）⇒ 只有那一条声明名；不在任何符号区间里（空行 / 两幕之间 /
 * 越界行）⇒ `[]`（**不猜**：面包屑宁可不显示，也不把作者导到别的块）。
 *
 * 顺序说明：既有面包屑组件（`ui/breadcrumb-path.ts` 的 `crumbLevelsAt`）要的是**外 → 内**，
 * 接线处把本数组 `slice().reverse()` 一次即可；本函数按设计稿的"光标 → 根"给，
 * 因为"我此刻在哪、往上都有谁"才是它的第一语义。
 */
export function kojo2SymbolPathAt(
  source: string,
  position: Kojo2SymbolPosition,
): string[] {
  if (typeof source !== 'string' || !isUsablePosition(position)) return [];
  const facts = kojo2DocumentSymbols(source);
  if (facts.length === 0) return [];
  let best: number | undefined;
  let bestDepth = -1;
  for (let i = 0; i < facts.length; i++) {
    if (!rangeContainsPosition(facts[i]!.range, position)) continue;
    const depth = depthOf(facts, i);
    if (depth > bestDepth) {
      best = i;
      bestDepth = depth;
    }
  }
  if (best === undefined) return [];
  const names: string[] = [];
  const seen = new Set<number>();
  let cursor: number | undefined = best;
  while (cursor !== undefined && cursor >= 0 && cursor < facts.length && !seen.has(cursor)) {
    seen.add(cursor);
    names.push(facts[cursor]!.name);
    cursor = facts[cursor]!.container;
  }
  return names;
}

