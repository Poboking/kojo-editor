/**
 * Kojo 2.0 **行内提示**（K2-LSP-INLAY）：`# 变量` / `# 常量` 的类型、`@巡 <集合>` 的绑定名、
 * `# 表` 的档数 / 兜底事实。
 *
 * ## 分层
 * 本文件的前半段是**纯函数**：源码文本 + 可选区间 + 可选 adapter 事实进，提示数组出；
 * 零 IO、零 Monaco 运行时、零注册。后半段 {@link installKojo2InlayHintsProvider} 是**唯一**
 * 把提示翻成 `monaco.languages.InlayHint` 的地方。注册由宿主统一收口（本文件不碰
 * `editor-global-providers.ts` / `EditorPane.tsx`）。
 *
 * ## 说什么（每条都可从 core 事实证明）
 *
 * | 提示 | 位置 | 来源 |
 * |---|---|---|
 * | `# 变量` / `# 常量` 的类型 | 声明行尾 | core AST 的 `valueType` / `arraySize`；未写类型时按初值字面量推断 |
 * | `@巡 <集合>` 的绑定名 | 块头行尾 | core 的 `FOREACH_COLLECTION_BINDINGS`（数组）或 adapter 的 `foreachCollections`（命名集合 / 作者数组规则） |
 * | `# 表` 的档数与兜底 | 声明行尾 | core AST 的表体行：非 `否` 行数 + 有没有 `否` |
 *
 * **一条声明行只放一枚提示，锚在行尾**（不是插在名字与类型之间）：行内提示是只读呈现面，
 * 锚在行尾就不会把作者正在写的任何两个记号拆开，也不会随行中编辑左右跳。`paddingLeft`
 * 负责与原文隔开。
 *
 * ## 不说什么（错标比不标危险）
 *
 * - **类型推断不出就不产**：没有显式类型、初值又不是单个字面量（`= 1 + 1` / 缺初值 /
 *   初值写坏）⇒ 这一行一枚提示都没有；
 * - **`@巡` 集合解析不了就不产**：adapter 没注入且集合又不是本文件声明的数组、
 *   adapter 里同名集合重复声明、adapter 明确不支持 `@巡`（`foreachCollections = null`）
 *   ⇒ 只给能证明的那几组绑定名，猜不出集合类别时一个字都不写；
 * - **`# 表` 解析不出 AST 就不产**（例如表头写到一半）：档数只能来自 core 已经建出的表体行；
 * - **`@原生` 围栏体 / 注释 / 台词正文 / 旁白 / 转义字面文本**一律不产——它们不是代码面，
 *   与 `kojo2-hover.ts` 的位置门同一把尺子（这里直接复用它的判定函数）。
 *
 * ## 范围与上限
 *
 * - `range`（Monaco 每次滚动给的可视区 ±30 行）给了就**只算这一段**；区间外一行都不碰。
 *   注意：解析仍要读整篇（`@原生` 围栏与声明索引都需要全篇状态），省下的是逐行判读与产条；
 * - 上限 {@link KOJO2_INLAY_HINT_LIMIT} = 200 条，按源码序截断（不排序丢弃）。
 *
 * ## 开关与 disposal
 *
 * 安装器在**装配那一刻**读 `ui/kojo2-flag.ts`（与符号 / 语义着色同一纪律）：flag 关 ⇒
 * 立即返回空操作，**零注册**。返回的 disposable 幂等；provider 内任何异常（模型已释放 /
 * 取文失败 / 桩 model 缺格）一律回空——Monaco 会把 provider 的 throw 吞成"这个功能突然
 * 没了"，空数组才是它能读出的唯一形状。
 */
import type * as Monaco from './entry';
import type {
  GameAdapter,
  KojoConstDecl,
  KojoLexLine,
  KojoPhysicalLine,
  KojoTableDecl,
  KojoVarDecl,
  KojoValueType,
} from '@kojo/kojo-core';
import {
  FOREACH_COLLECTION_BINDINGS,
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_STORAGE_WORDS,
  KOJO_TABLE_DEFAULT,
  KOJO_TYPE_WORDS,
  decodeIntegerLiteral,
  decodeQuotedLiteral,
  lex,
  parse,
  splitSpaces,
} from '@kojo/kojo-core';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { KOJO2_LANGUAGE_ID } from './kojo2-constants';
import {
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TypeWordOf,
} from './kojo2-declarations';

/* ============================== 词形（core 单源） ============================== */

/** 声明词位序（core `tokens.ts` §3.3）：只取本文件认识的三枚，不写字形 */
const VARIABLE_WORD = KOJO_DECL_WORDS[3];
const CONSTANT_WORD = KOJO_DECL_WORDS[4];
const TABLE_WORD = KOJO_DECL_WORDS[5];

/** `@巡` 在调度词表里的位序（core `tokens.ts` §2.1） */
const FOREACH_WORD = KOJO_DISPATCH_WORDS[7];

/** 存储期词集合（初值之后允许跟的那几枚；不在这个集合里的尾巴 = 推断不出） */
const STORAGE_WORD_SET: ReadonlySet<string> = new Set<string>(KOJO_STORAGE_WORDS);

/** 提示条数上限（按源码序截断；`truncated` 由调用方自己按长度判） */
export const KOJO2_INLAY_HINT_LIMIT = 200;

/* ============================== 公共形状 ============================== */

/** 提示语义类别：类型 / 绑定名 / 表档事实 */
export type Kojo2InlayHintKind = 'type' | 'binding' | 'value';

/** 1 基位点（与 Monaco / core 同口径；`lineNumber` 是 Monaco 的字段名，翻译层零换算） */
export interface Kojo2InlayPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** 一条提示（纯数据；可选 padding 由翻译层原样透传） */
export interface Kojo2InlayHint {
  readonly position: Kojo2InlayPosition;
  readonly label: string;
  readonly kind: Kojo2InlayHintKind;
  readonly paddingLeft?: boolean;
  readonly paddingRight?: boolean;
}

/**
 * 请求区间（Monaco `IRange` 的结构子集）。只用到行——提示按整行给，列不参与筛选。
 */
export interface Kojo2InlayRange {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
}

/** 纯函数的可选事实注入（生产由 provider 现取 adapter；不给 = 只用本文件能证明的数组事实） */
export interface Kojo2InlayOptions {
  /** 当前项目 2.0 adapter（`@巡` 命名集合 / 作者数组规则的唯一来源；缺席 = 不猜） */
  readonly adapter?: GameAdapter | null;
}

/* ============================== 小工具 ============================== */

/**
 * 类型记号（`整数` / `字符串` / `整数[3]`）→ 规范标签。只在 AST 缺这条声明时兜底
 * （未写类型的半截声明、名字非法导致 parser 不建节点等）。
 */
function typeLabelOfToken(text: string): string | null {
  for (const typeWord of KOJO_TYPE_WORDS) {
    if (text === typeWord) return typeWord;
    const prefix = `${typeWord}[`;
    if (text.startsWith(prefix) && text.endsWith(']')) {
      const inner = text.slice(prefix.length, text.length - 1);
      return inner.length === 0 ? typeWord : `${typeWord}[${inner}]`;
    }
  }
  return null;
}

/** 字面量 → 值类型（只认 core 的两个字面量解码器，不写第二套词法） */
function valueTypeOfLiteral(text: string): KojoValueType | null {
  if (decodeQuotedLiteral(text) !== null) return 'string';
  if (decodeIntegerLiteral(text) !== null) return 'int';
  return null;
}

/** 行尾列（1 基；尾部空白不算内容，提示压在最后一个可见字符之后） */
function endColumnOf(line: KojoLexLine, physical: readonly KojoPhysicalLine[]): number {
  const text = physical[line.number - 1]?.text ?? '';
  return text.replace(/[ \t\u3000\u00a0]+$/u, '').length + 1;
}

/* ============================== AST 事实索引 ============================== */

interface DocumentFacts {
  readonly varByLine: ReadonlyMap<number, KojoVarDecl>;
  readonly constByLine: ReadonlyMap<number, KojoConstDecl>;
  readonly tableByLine: ReadonlyMap<number, KojoTableDecl>;
  /** 本文件声明为数组的变量名（`# 变量 名 类型[N]`；`@巡` 的作者数组事实） */
  readonly arrayNames: ReadonlySet<string>;
}

/** 一次 parse 的声明事实按行归位（同一行多声明 = core 已报错，取第一条即可） */
function factsOf(lexed: ReturnType<typeof lex>): DocumentFacts {
  const varByLine = new Map<number, KojoVarDecl>();
  const constByLine = new Map<number, KojoConstDecl>();
  const tableByLine = new Map<number, KojoTableDecl>();
  const arrayNames = new Set<string>();
  let decls: readonly { readonly kind: string; readonly span: { readonly start: { readonly line: number } } }[] = [];
  try {
    decls = parse(lexed).decls;
  } catch {
    // 解析在坏输入上意外抛错：仍保留词法行（下面按行原样判），只是没有 AST 事实。
    return { varByLine, constByLine, tableByLine, arrayNames };
  }
  for (const decl of decls) {
    const line = decl.span.start.line;
    switch (decl.kind) {
      case 'var': {
        const varDecl = decl as KojoVarDecl;
        if (!varByLine.has(line)) varByLine.set(line, varDecl);
        if (varDecl.arraySize !== undefined) arrayNames.add(varDecl.name);
        break;
      }
      case 'const':
        if (!constByLine.has(line)) constByLine.set(line, decl as KojoConstDecl);
        break;
      case 'table':
        if (!tableByLine.has(line)) tableByLine.set(line, decl as KojoTableDecl);
        break;
      default:
        break;
    }
  }
  return { varByLine, constByLine, tableByLine, arrayNames };
}

/* ============================== 类型提示 ============================== */

/** AST 的类型事实 → 标签（数组带长度原文） */
function typeLabelOfVar(decl: KojoVarDecl): string {
  const type = kojo2TypeWordOf(decl.valueType);
  return decl.arraySize === undefined ? type : `${type}[${decl.arraySize.text}]`;
}

/**
 * 一条 `# 变量` / `# 常量` 的类型标签（`null` = 推断不出，不产）。
 *
 * 顺序：AST 事实优先（parser 已经把显式类型与数组长度都解释过）→ 行内兜底
 * （显式类型记号 / `= 单个字面量` 推断）。兜底只认"`=` 之后恰一个字面量，其余尾巴只能是
 * 存储期词"：`= 1 + 1` 这类表达式不是字面量事实，宁可不产。
 */
function typeLabelOfDeclaration(
  line: KojoLexLine,
  facts: DocumentFacts,
): string | null {
  const varDecl = facts.varByLine.get(line.number);
  if (varDecl !== undefined) return typeLabelOfVar(varDecl);
  const constDecl = facts.constByLine.get(line.number);
  if (constDecl !== undefined) return kojo2TypeWordOf(constDecl.valueType);
  // 行内兜底只服务**顶层**声明：声明只能写在文件顶层（§3.1），块体里形如 `# 变量` 的行
  // 是块体原文 / 表体值，不该被当成声明来标。
  if (line.kind !== 'decl' || line.indent !== 0) return null;

  const tokens = splitSpaces(line.rest, line.restOffset);
  if (tokens.length < 2) return null;
  const rest = tokens.slice(1);
  const first = rest[0];
  if (first === undefined) return null;

  const explicit = typeLabelOfToken(first.text);
  if (explicit !== null) return explicit;

  // 未写类型：只认 `= <单个字面量>`，其余尾巴只能是存储期词。
  if (first.text.charCodeAt(0) !== 61 /* = */) return null;
  let literal: string | null = null;
  let trailingFrom: number;
  if (first.text.length > 1) {
    literal = first.text.slice(1);
    trailingFrom = 1;
  } else {
    const next = rest[1];
    if (next === undefined) return null;
    literal = next.text;
    trailingFrom = 2;
  }
  for (let i = trailingFrom; i < rest.length; i++) {
    if (!STORAGE_WORD_SET.has(rest[i]!.text)) return null;
  }
  if (literal === null || literal.length === 0) return null;
  const valueType = valueTypeOfLiteral(literal);
  return valueType === null ? null : kojo2TypeWordOf(valueType);
}

/* ============================== @巡 绑定提示 ============================== */

/**
 * `@巡 <集合>` → 绑定名标签（`{值} {下标}`；`null` = 解析不出类别，不猜）。
 *
 * 解析顺序与 core 的 `planForEachLoop` 同一条：**命名集合**优先（adapter 冻结声明），
 * 其次**作者数组**（本文件 `# 变量 名 类型[N]` + adapter 的 `arrayRule`）。没有 adapter 时
 * 仍可证明"本文件声明的数组"是数组（语法本身就是数组声明），于是数组绑定名照给；
 * 命名集合的类别住在 adapter，缺席就不猜。
 */
function bindingsLabelOfForeach(
  line: KojoLexLine,
  facts: DocumentFacts,
  adapter: GameAdapter | null | undefined,
): string | null {
  if (line.kind !== 'dispatch') return null;
  const tokens = splitSpaces(line.rest, line.restOffset);
  const collection = tokens[0]?.text;
  if (collection === undefined || collection.length === 0) return null;

  const bindings = bindingsOfCollection(collection, facts.arrayNames, adapter);
  if (bindings === null || bindings.length === 0) return null;
  return bindings.map((name) => `{${name}}`).join(' ');
}

/** 集合名 → 绑定名清单（`null` = 证明不了该集合的类别） */
function bindingsOfCollection(
  collection: string,
  arrayNames: ReadonlySet<string>,
  adapter: GameAdapter | null | undefined,
): readonly string[] | null {
  if (adapter !== null && adapter !== undefined) {
    const declarations = adapter.foreachCollections;
    // adapter 在场但明确不支持 `@巡`（`null`）= 作者写什么集合都没有落点，不给绑定名。
    if (declarations === null || declarations === undefined) return null;
    const collections = Array.isArray(declarations.collections) ? declarations.collections : [];
    const matches = collections.filter(
      (entry) => typeof entry?.name === 'string' && entry.name.trim() === collection,
    );
    if (matches.length > 1) return null; // adapter 数据重复：解析不了该用哪一条（core 同判）
    if (matches.length === 1) {
      const declared = matches[0]!.bindings;
      return Array.isArray(declared) && declared.length > 0 ? declared : null;
    }
    const rule = declarations.arrayRule;
    if (rule !== null && rule !== undefined && arrayNames.has(collection)) {
      return Array.isArray(rule.bindings) && rule.bindings.length > 0 ? rule.bindings : null;
    }
    return null;
  }
  // 没有 adapter：命名集合的类别无从证明；本文件声明过的数组仍是数组。
  return arrayNames.has(collection) ? FOREACH_COLLECTION_BINDINGS.array : null;
}

/* ============================== # 表 档数提示 ============================== */

/** 表体事实 → `3 档 · 有否` / `2 档 · 缺否`（`否` 是 core 的兜底词，不写字形） */
function tableLabelOf(decl: KojoTableDecl): string {
  let tiers = 0;
  let hasDefault = false;
  for (const row of decl.rows) {
    if (row.from === null && row.to === null) hasDefault = true;
    else tiers++;
  }
  const fallback = hasDefault ? `有${KOJO_TABLE_DEFAULT}` : `缺${KOJO_TABLE_DEFAULT}`;
  return `${tiers} 档 · ${fallback}`;
}

/* ============================== 纯函数入口 ============================== */

/** 请求区间的行窗口（`null` = 这一段没有可算的行；非法区间同样回 `null`，不猜全篇） */
function lineWindowOf(
  lineCount: number,
  range: Kojo2InlayRange | undefined,
): { readonly from: number; readonly to: number } | null {
  if (range === undefined || range === null) return { from: 1, to: lineCount };
  const rawFrom = Math.trunc(range.startLineNumber);
  const rawTo = Math.trunc(range.endLineNumber);
  if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) return null;
  const from = Math.max(1, rawFrom);
  const to = Math.min(lineCount, rawTo);
  return to < from ? null : { from, to };
}

/**
 * 一篇 2.0 源文 → 行内提示（**纯函数**：同输入必同输出，不读盘、不抛）。
 *
 * `range` 给了就只算行号落在里面的行（Monaco 的 `provideInlayHints` 第二参可直接透传）；
 * 不给 = 整篇。`options.adapter` 是 `@巡` 命名集合的唯一事实源，缺席时只给本文件可证的
 * 数组绑定。结果按（行，列）源码序，超过 {@link KOJO2_INLAY_HINT_LIMIT} 条直接截断。
 */
export function kojo2InlayHints(
  source: string,
  range?: Kojo2InlayRange,
  options: Kojo2InlayOptions = {},
): Kojo2InlayHint[] {
  if (typeof source !== 'string' || source.length === 0) return [];

  let lexed: ReturnType<typeof lex>;
  try {
    lexed = lex(source);
  } catch {
    return [];
  }
  const window = lineWindowOf(lexed.lines.length, range);
  if (window === null) return [];

  const facts = factsOf(lexed);
  const adapter = options.adapter ?? null;
  const hints: Kojo2InlayHint[] = [];

  for (const line of lexed.lines) {
    if (line.number < window.from || line.number > window.to) continue;
    // 位置门与悬停 / 转定义同一把尺子：原生体、台词正文、旁白、转义字面文本不是代码面。
    if (kojo2IsNativeRecord(line) || kojo2IsTextSurface(line)) continue;
    if (line.kind === 'comment' || line.kind === 'legacy') continue;

    if (line.kind === 'decl' && line.known) {
      if (line.word === VARIABLE_WORD || line.word === CONSTANT_WORD) {
        const label = typeLabelOfDeclaration(line, facts);
        if (label !== null) {
          hints.push({
            position: { lineNumber: line.number, column: endColumnOf(line, lexed.physical) },
            label,
            kind: 'type',
            paddingLeft: true,
          });
        }
        continue;
      }
      if (line.word === TABLE_WORD) {
        const table = facts.tableByLine.get(line.number);
        if (table === undefined) continue;
        hints.push({
          position: { lineNumber: line.number, column: endColumnOf(line, lexed.physical) },
          label: tableLabelOf(table),
          kind: 'value',
          paddingLeft: true,
        });
      }
      continue;
    }

    if (line.kind === 'dispatch' && line.known && line.word === FOREACH_WORD) {
      const label = bindingsLabelOfForeach(line, facts, adapter);
      if (label !== null) {
        hints.push({
          position: { lineNumber: line.number, column: endColumnOf(line, lexed.physical) },
          label,
          kind: 'binding',
          paddingLeft: true,
        });
      }
    }
  }

  hints.sort(
    (a, b) => a.position.lineNumber - b.position.lineNumber || a.position.column - b.position.column,
  );
  return hints.length <= KOJO2_INLAY_HINT_LIMIT
    ? hints
    : hints.slice(0, KOJO2_INLAY_HINT_LIMIT);
}

/* ============================== Monaco 翻译层 ============================== */

/**
 * 纯提示 → `monaco.languages.InlayHint[]`。
 *
 * 种类映射：`type` → `InlayHintKind.Type`；`binding` → `InlayHintKind.Parameter`（绑定名与
 * 形参名同一种"这个名字代表什么值"的语义）；`value` 是表档摘要，Monaco 没有对应枚举，
 * **不硬借邻居那种颜色**——留空即默认样式。
 */
export function toMonacoInlayHints(
  monaco: typeof Monaco,
  hints: readonly Kojo2InlayHint[],
): Monaco.languages.InlayHint[] {
  const K = monaco.languages.InlayHintKind;
  return hints.map((hint) => {
    const kind =
      hint.kind === 'type' ? K.Type : hint.kind === 'binding' ? K.Parameter : undefined;
    return {
      position: { lineNumber: hint.position.lineNumber, column: hint.position.column },
      label: hint.label,
      ...(kind === undefined ? {} : { kind }),
      ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
      ...(hint.paddingRight === true ? { paddingRight: true } : {}),
    };
  });
}

/* ============================== 安装 ============================== */

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/** 空结果（每次新建：Monaco 会消费/持有这个数组，不共享一份可变的空表） */
function emptyInlayResult(): { hints: Monaco.languages.InlayHint[]; dispose: () => void } {
  return { hints: [], dispose: () => undefined };
}

/**
 * adapter 注入面：直接给一枚（测试 / 单项目），或给 getter 让宿主**请求时现取**
 * （项目可开可关；缓存会把上一个项目的集合声明带过来）。
 */
export type Kojo2InlayAdapterSource =
  | GameAdapter
  | null
  | undefined
  | (() => GameAdapter | null | undefined);

export interface Kojo2InlayProviderOptions {
  /** 当前项目 2.0 adapter（`@巡` 命名集合的绑定名来源；缺省 = 只认本文件数组声明） */
  readonly adapter?: Kojo2InlayAdapterSource;
}

/** adapter 现取；getter 抛错 = 这一轮没有 adapter（不抛进 Monaco） */
function adapterAt(source: Kojo2InlayAdapterSource): GameAdapter | undefined {
  if (source === null || source === undefined) return undefined;
  if (typeof source === 'function') {
    try {
      return source() ?? undefined;
    } catch {
      return undefined;
    }
  }
  return source;
}

/** 这份 model 是否超过行内提示的体量档（与 v1 `inlayHintsAffordable` 同一条线） */
function overBudget(model: Monaco.editor.ITextModel): boolean {
  try {
    if (typeof model.getLineCount !== 'function') return false;
    const lineCount = model.getLineCount();
    return Number.isFinite(lineCount) && lineCount >= LARGE_FILE_LINES;
  } catch {
    return false;
  }
}

/**
 * 为 `kojo2` 语言注册 inlay hints provider，返回**幂等**的 disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**；调用点在宿主 2.0 段，本函数再挡一道）；
 * - 只挂 {@link KOJO2_LANGUAGE_ID}：v1 的 ERB / `.kojo` 面由 `kojo-inlay-hints.ts` 的
 *   `registerForLanguageServices` 各挂各的，两边不重叠；
 * - 体量档判在请求之前（`LARGE_FILE_LINES` 同一条线）：超长文件里行内提示整体让路，
 *   与 stickyScroll / 面包屑 / codeLens 的规则一致；
 * - provider 内任何异常 ⇒ `{ hints: [] }`（不把编辑器的输入链带崩）；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚，宿主那侧的全有或全无才有机会收口）。
 */
export function installKojo2InlayHintsProvider(
  monaco: typeof Monaco,
  options: Kojo2InlayProviderOptions = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const adapterSource = options.adapter;

  const provider: Monaco.languages.InlayHintsProvider = {
    provideInlayHints(model, range) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return emptyInlayResult();
        if (overBudget(model)) return emptyInlayResult();
        const source = model.getValue();
        if (typeof source !== 'string') return emptyInlayResult();
        const adapter = adapterAt(adapterSource);
        const hints = kojo2InlayHints(source, range, { adapter: adapter ?? null });
        return { hints: toMonacoInlayHints(monaco, hints), dispose: () => undefined };
      } catch {
        return emptyInlayResult();
      }
    },
  };

  const registration = monaco.languages.registerInlayHintsProvider(KOJO2_LANGUAGE_ID, provider);

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
