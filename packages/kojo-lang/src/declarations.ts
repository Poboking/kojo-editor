/**
 * Kojo 2.0 同文件**声明索引**（K2-EDITOR-SEMANTIC 的共享底座）。
 *
 * 这一层只回答三个问题，且都是纯函数（零 IO、零 Monaco）：
 * 1. 这个文件里声明了哪些名字（`# 变量 / 常量 / 表 / 池 / 模`、`@函`、`# 幕`）；
 * 2. 每个名字的**名字段**在源文里的精确区间（声明词之后的那个词，不是整行）；
 * 3. 某个位置是不是这些名字之一（声明处 / 引用处）。
 *
 * ## 词形零抄本
 * 声明词一律取自 `@kojo/kojo-core` 的 `KOJO_DECL_WORDS` / `KOJO_DISPATCH_WORDS`（同一份
 * 词表真源）；本文件**不写任何中文字形**。`KOJO_DECL_WORDS` 的位序是 core 的声明顺序
 * （幕 / 视 / 机 / 变量 / 常量 / 表 / 池 / 模），这里只按下标取词，
 * `kojo2-hover-definition.test.ts` 用 core 解析器对每一格做语义反证（词序一变就红）。
 *
 * ## 为什么同时用 lexer 与 parser
 * - **名字区间**只有 lexer 的 `restOffset` 给得出（AST 的 `span` 是整行）；
 * - **类型 / 初值 / 参数 / 表体行数**只有 parser 的 AST 给得出（不再写第二份行内正则）。
 * 两者都来自 core 的公共入口，索引只做按行对齐，不重新解释语法。
 */

import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_STORAGE_WORDS,
  KOJO_TYPE_WORDS,
  lex,
  parse,
  splitSpaces,
  type KojoDecl,
  type KojoLexLine,
  type KojoLiteral,
  type KojoPhysicalLine,
  type KojoValueType,
  type KojoVarStorage,
} from '@kojo/kojo-core';
import { isNameChar } from './name-chars';

/** 可被悬停 / 转定义 / 补全消费的声明种类（`# 视` / `# 机` 不在本批语义面内）。 */
export type Kojo2DeclarationKind =
  | 'scene'
  | 'variable'
  | 'constant'
  | 'table'
  | 'pool'
  | 'template'
  | 'function';

/**
 * core 声明词的语义位序（`tokens.ts` §3.3）。**不是新词表**：所有值都是
 * `KOJO_DECL_WORDS` 的元素；测试对每一格做"core 解析器能不能把这个词解析成对应种类"的反证。
 */
const [
  SCENE_WORD,
  , // `# 视` 本批不索引，占位保持 core 位序
  MACHINE_WORD,
  VARIABLE_WORD,
  CONSTANT_WORD,
  TABLE_WORD,
  POOL_WORD,
  TEMPLATE_WORD,
] = KOJO_DECL_WORDS;

/** `@函` 在调度词表里的位序（`tokens.ts` §2.1）。同上：只取词，不写字形。 */
const FUNCTION_WORD = KOJO_DISPATCH_WORDS[8];

/** `# 机` 的声明词（补全的事件位判据用；来自 core 词表）。 */
export const KOJO2_MACHINE_WORD = MACHINE_WORD;

/** `@函` 的调度词（补全 / 声明索引用；来自 core 词表）。 */
export const KOJO2_FUNCTION_WORD = FUNCTION_WORD;

/**
 * 声明种类 → 该种类的**词形**（`# 变量` 取 `变量`、`@函` 取 `函`、`# 幕` 取 `幕`）。
 * 悬停 / 转定义的 kind 文案直接用它拼，消费方不需要再认识任何字形。
 */
export const KOJO2_DECL_WORD_BY_KIND: Readonly<Record<Kojo2DeclarationKind, string>> = Object.freeze({
  scene: SCENE_WORD,
  variable: VARIABLE_WORD,
  constant: CONSTANT_WORD,
  table: TABLE_WORD,
  pool: POOL_WORD,
  template: TEMPLATE_WORD,
  function: FUNCTION_WORD,
});

/** 本批参与补全名单的"成员声明"种类（表 / 池 / 模 / 函）。 */
export const KOJO2_MEMBER_DECLARATION_KINDS: readonly Kojo2DeclarationKind[] = Object.freeze([
  'table',
  'pool',
  'template',
  'function',
]);

/** 一次"位置 → 声明事实"的查询（Monaco 列 = 1 基；与 core / plugin-api 同口径）。 */
export interface Kojo2Query {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

/** 名字段的 0 基半开区间（源文绝对偏移，供内部换算）。 */
interface OffsetSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * 一条声明事实。字段全部 readonly；可选字段只在 AST 给出事实时出现（**不猜默认值**）。
 */
export interface Kojo2Declaration {
  readonly name: string;
  readonly kind: Kojo2DeclarationKind;
  /** 声明行号（1 基） */
  readonly line: number;
  /** 名字段首列（1 基） */
  readonly nameStart: number;
  /** 名字段尾列（1 基、半开） */
  readonly nameEnd: number;
  /** 声明行原文（含缩进；悬停"来源行"用） */
  readonly lineText: string;
  readonly valueType?: KojoValueType;
  readonly storage?: KojoVarStorage;
  readonly arraySize?: string;
  readonly initializer?: string;
  readonly constantValue?: string;
  readonly subject?: string;
  readonly rowCount?: number;
  readonly branchCount?: number;
  readonly params?: readonly string[];
  readonly hasSlot?: boolean;
  readonly sceneTitle?: string;
}

/** 一份文档的索引结果（一次 lex + parse，三个语言服务共用）。 */
export interface Kojo2Document {
  readonly source: string;
  readonly lines: readonly KojoLexLine[];
  readonly physical: readonly KojoPhysicalLine[];
  readonly declarations: readonly Kojo2Declaration[];
}

/** 字面量的显示形态（字符串带引号；数字按十进制）。 */
function formatLiteral(value: KojoLiteral): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** AST 声明 → 事实字段（只搬事实，不重新解释语法）。 */
function declarationFactsOf(decl: KojoDecl): Partial<Kojo2Declaration> {
  switch (decl.kind) {
    case 'var':
      return {
        valueType: decl.valueType,
        storage: decl.storage,
        ...(decl.arraySize !== undefined ? { arraySize: decl.arraySize.text } : {}),
        ...(decl.init !== undefined ? { initializer: formatLiteral(decl.init) } : {}),
      };
    case 'const':
      return { valueType: decl.valueType, constantValue: formatLiteral(decl.value) };
    case 'table':
      return { subject: decl.subject.text, rowCount: decl.rows.length };
    case 'pool':
      return { branchCount: decl.branches.length };
    case 'template':
      return {
        params: decl.params.map((param) => param.name),
        hasSlot: decl.slotIndex !== null,
      };
    case 'function':
      return {
        params: decl.params.map((param) =>
          param.defaultValue === undefined
            ? param.name
            : `${param.name} = ${formatLiteral(param.defaultValue)}`,
        ),
      };
    default:
      return {};
  }
}

/** 声明词（`#` 行）→ 本批可索引的种类；非目标词（视 / 机）回 `undefined`。 */
function declarationKindOfWord(word: string): Kojo2DeclarationKind | undefined {
  if (word === SCENE_WORD) return 'scene';
  if (word === VARIABLE_WORD) return 'variable';
  if (word === CONSTANT_WORD) return 'constant';
  if (word === TABLE_WORD) return 'table';
  if (word === POOL_WORD) return 'pool';
  if (word === TEMPLATE_WORD) return 'template';
  return undefined;
}

/** 名字段：`# 幕` 整段标题；`# 模` / `@函` 取 `(` 之前；其余取空格分隔的第一枚词。 */
function declarationNameSpan(kind: Kojo2DeclarationKind, line: KojoLexLine): OffsetSpan | null {
  if (kind === 'scene') {
    if (line.kind !== 'decl' || line.rest.length === 0) return null;
    return { start: line.restOffset, end: line.restOffset + line.rest.length, text: line.rest };
  }
  if (kind === 'template' || kind === 'function') {
    if (line.kind !== 'decl' && line.kind !== 'dispatch') return null;
    const rest = line.rest;
    const open = rest.indexOf('(');
    const rawHead = open >= 0 ? rest.slice(0, open) : rest;
    const head = rawHead.trim();
    if (head.length === 0) return null;
    const start = line.restOffset + rawHead.indexOf(head);
    return { start, end: start + head.length, text: head };
  }
  if (line.kind !== 'decl') return null;
  const first = splitSpaces(line.rest, line.restOffset)[0];
  if (first === undefined || first.text.length === 0) return null;
  return { start: first.offset, end: first.offset + first.text.length, text: first.text };
}

/** 声明行原文：从词法层的物理行取（含缩进；词法行与物理行一一对应）。 */
function physicalLineText(physical: readonly KojoPhysicalLine[], lineNumber: number): string {
  return physical[lineNumber - 1]?.text ?? '';
}

/**
 * 建立文档索引（**纯函数**：同输入必同输出，无缓存、无 IO）。
 *
 * 对齐规则只有一条：parser 的声明 `span.start.line` 就是声明头行；lexer 的同一行给名字区间。
 * 两边对不上（语法错误导致 AST 缺节点）时仍保留名字事实，只是没有类型 / 初值等语义字段——
 * 这正符合"能显示多少事实就显示多少，不猜"。
 */
export function kojo2DocumentOf(source: string): Kojo2Document {
  const lexed = lex(source);
  const file = parse(lexed);

  const factsByLine = new Map<number, Partial<Kojo2Declaration>>();
  for (const decl of file.decls) {
    const line = decl.span.start.line;
    if (!factsByLine.has(line)) factsByLine.set(line, declarationFactsOf(decl));
  }
  for (const scene of file.scenes) {
    if (scene.title !== null) factsByLine.set(scene.span.start.line, { sceneTitle: scene.title });
  }

  const declarations: Kojo2Declaration[] = [];
  for (const line of lexed.lines) {
    let kind: Kojo2DeclarationKind | undefined;
    if (line.kind === 'decl' && line.known) {
      kind = declarationKindOfWord(line.word);
    } else if (line.kind === 'dispatch' && line.known && line.word === FUNCTION_WORD) {
      kind = 'function';
    }
    if (kind === undefined) continue;
    const span = declarationNameSpan(kind, line);
    if (span === null) continue;
    const lineText = physicalLineText(lexed.physical, line.number);
    const facts = factsByLine.get(line.number);
    // `span` 是源文**绝对偏移**；对外列口径是 1 基行列（Monaco / core 同口径）。
    const nameStart = span.start - line.lineOffset + 1;
    const nameEnd = span.end - line.lineOffset + 1;
    declarations.push({
      name: span.text,
      kind,
      line: line.number,
      nameStart,
      nameEnd,
      lineText,
      ...(facts ?? {}),
    });
  }

  declarations.sort((a, b) => (a.line === b.line ? a.nameStart - b.nameStart : a.line - b.line));
  return { source, lines: lexed.lines, physical: lexed.physical, declarations };
}

/** 光标是否落在这条声明的**名字段**上（列口径：1 基；尾列半开，落在尾列也算"在名字上"）。 */
export function kojo2DeclarationAt(
  document: Kojo2Document,
  line: number,
  col0: number,
): Kojo2Declaration | undefined {
  for (const declaration of document.declarations) {
    if (declaration.line !== line) continue;
    if (col0 >= declaration.nameStart - 1 && col0 <= declaration.nameEnd - 1) return declaration;
  }
  return undefined;
}

/**
 * 光标是否落在声明**头**上（名字之前：`#` / 声明词 / 空白 / `@函`）。
 * 悬停与转定义用它补"作者把鼠标停在 `# 变量` 上"的那一半；名字段本身走
 * {@link kojo2DeclarationAt}。
 */
export function kojo2DeclarationHeaderAt(
  document: Kojo2Document,
  line: number,
  col0: number,
): Kojo2Declaration | undefined {
  for (const declaration of document.declarations) {
    if (declaration.line !== line) continue;
    if (col0 < declaration.nameStart - 1) return declaration;
  }
  return undefined;
}

/**
 * 按名字反查声明（同文件重名时取**离引用行最近的前一条**；前面没有才取第一条）。
 * 重名本身由 core 报错，但编辑器在错误状态下也得给出一个确定的落点。
 */
export function kojo2DeclarationNamed(
  document: Kojo2Document,
  name: string,
  line: number,
): Kojo2Declaration | undefined {
  let before: Kojo2Declaration | undefined;
  let first: Kojo2Declaration | undefined;
  for (const declaration of document.declarations) {
    if (declaration.name !== name) continue;
    if (first === undefined) first = declaration;
    if (declaration.line <= line && (before === undefined || declaration.line > before.line)) {
      before = declaration;
    }
  }
  return before ?? first;
}

/** 光标处的连续名字段（0 基半开；左右都非名字字符 ⇒ `null`）。 */
export function kojo2TokenSpanAt(
  lineText: string,
  col0: number,
): { readonly start: number; readonly end: number; readonly text: string } | null {
  const at = Math.min(Math.max(col0, 0), lineText.length);
  let start: number;
  let end: number;
  if (at < lineText.length && isNameChar(lineText[at]!)) {
    start = at;
    end = at + 1;
  } else if (at > 0 && isNameChar(lineText[at - 1]!)) {
    start = at - 1;
    end = at;
  } else {
    return null;
  }
  while (start > 0 && isNameChar(lineText[start - 1]!)) start--;
  while (end < lineText.length && isNameChar(lineText[end]!)) end++;
  return { start, end, text: lineText.slice(start, end) };
}

/** 叙事面文本行（台词 / 裸引号 / 旁白 / 转义字面文本）：台词语法补全的位置门。 */
export function kojo2IsTextSurface(line: KojoLexLine): boolean {
  return (
    line.kind === 'dialogue' ||
    line.kind === 'bareQuote' ||
    line.kind === 'narration' ||
    line.kind === 'escaped'
  );
}

/** `@原生` 围栏体内的原始行：整条语言服务都退让。 */
export function kojo2IsNativeRecord(line: KojoLexLine): boolean {
  return line.kind === 'native';
}

/**
 * 引用侧允许的代码面（声明 / 调度 / 触发 / 条件 / 调度区裸行 / 兜底行）。
 * 悬停与转定义共用这一枚判据——两条腿不各写一份。
 */
export function kojo2IsCodeSurface(line: KojoLexLine): boolean {
  return (
    line.kind === 'decl' ||
    line.kind === 'dispatch' ||
    line.kind === 'trigger' ||
    line.kind === 'condition' ||
    line.kind === 'text' ||
    line.kind === 'unknown'
  );
}

/** 存储期词（`场景` / `存档` / `会话`；core 词表转发，索引顺序即 `KojoVarStorage` 顺序）。 */
export function kojo2StorageWordOf(storage: KojoVarStorage): string {
  const index = storage === 'scene' ? 0 : storage === 'save' ? 1 : 2;
  return KOJO_STORAGE_WORDS[index] ?? storage;
}

/** 类型词（`整数` / `字符串`；core 词表转发）。 */
export function kojo2TypeWordOf(valueType: KojoValueType): string {
  return valueType === 'int' ? KOJO_TYPE_WORDS[0] : KOJO_TYPE_WORDS[1];
}
