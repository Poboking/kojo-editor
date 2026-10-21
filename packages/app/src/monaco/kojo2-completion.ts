/**
 * Kojo 2.0 **补全候选组装**（K2-EDITOR-SEMANTIC 第一刀）。
 *
 * ## 分工
 * 本文件是**纯函数组装**：源码 + 1 基行列进，候选数组出；零 IO、零 Monaco、零注册。
 * 宿主（CUTOVER）只做 Monaco 翻译：候选 → `monaco.languages.CompletionItem`、
 * `triggerCharacters` / `range` / `CompletionItemKind` 由宿主那一侧决定。
 *
 * ## 候选源（全部从公共入口派生，不手抄词表）
 * - **锚点**：`# @ > ? !` 五枚语法标点（core 没有"锚点"常量；它们是标点，不是词表）；
 * - **声明词**：`@kojo/kojo-core` 的 `KOJO_DECL_WORDS`；
 * - **`# 机` 事件**：当前项目 adapter 的 `eventCatalog`（宿主经 core 的 `eventNames` 注入；
 *   Monaco 语言层不 import 具体 adapter——解耦审计 A 项把这一层钉成"零游戏名词"）；
 * - **域符号**：`@kojo/kojo-core` 的 `KOJO_DOMAIN_SYMBOL_NAMES`（`我 / 你 / 她`）；
 * - **表 / 池 / 模 / 函名单**：本文件声明的名字（`kojo2-declarations.ts` 的同一份索引）。
 *
 * ## 位置门
 * - 台词 / 旁白 / 转义字面文本的**正文**：不做任何语法补全；
 * - `{…}` 插值内：例外——那是表达式位，给域符号 + 表 / 池 / 模 / 函名单；
 * - `@原生` 围栏体内（含栏头）：一律不补（原文不解释）；
 * - 注释 / 旧写法行：不补。
 *
 * ## 为什么候选不做 Monaco 过滤
 * 本函数只按**已输入前缀**裁一遍（让纯函数可单测、也减少宿主侧噪音）；Monaco 仍会按
 * `filterText` 再过滤，两层不冲突。候选的 `insertText` 一律是原文名字，**不在这里塞括号 /
 * snippet**——调用形态是宿主翻译层的决定，纯函数不替它猜。
 */

import {
  KOJO_DECL_WORDS,
  KOJO_DOMAIN_SYMBOL_NAMES,
  eventNames,
  type GameAdapter,
} from '@kojo/kojo-core';
import {
  insideInterpolation,
  insideStringOrComment,
  isAllBlank,
} from './kojo-completion-position';
import { KOJO2_NATIVE_FENCE_WORD } from './kojo2-lexicon';
import {
  KOJO2_DECL_WORD_BY_KIND,
  KOJO2_MACHINE_WORD,
  KOJO2_MEMBER_DECLARATION_KINDS,
  kojo2DocumentOf,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
  type Kojo2Declaration,
  type Kojo2DeclarationKind,
  type Kojo2Document,
  type Kojo2Query,
} from './kojo2-declarations';

/**
 * 五锚点（`#` 声明 / `@` 调度 / `>` 旁白 / `?` 条件 / `!` 触发）。
 * core 没有"锚点"常量——这是**语法标点**，不是词表；本文件只此一处写它们。
 */
export const KOJO2_ANCHOR_CHARS = ['#', '@', '>', '?', '!'] as const;

/** adapter 事件目录的**名字投影**（顺序 = `eventCatalog.events` 表序；零手抄）。 */
export function kojo2EventNamesOf(adapter: GameAdapter): readonly string[] {
  return eventNames(adapter);
}

/** 候选的语义类别（宿主据此映射 Monaco `CompletionItemKind`）。 */
export type Kojo2CompletionKind =
  | 'anchor'
  | 'declarationWord'
  | 'event'
  | 'domainSymbol'
  | 'declaration';

/** 一条候选（纯数据；不带 Monaco 的 `range` / `insertTextRules`）。 */
export interface Kojo2CompletionCandidate {
  readonly label: string;
  readonly insertText: string;
  readonly kind: Kojo2CompletionKind;
  readonly detail: string;
  readonly sortText: string;
  /** 仅 `kind === 'declaration'` 时给出，宿主可细分为变量 / 表 / 池 / 模 / 函。 */
  readonly declarationKind?: Kojo2DeclarationKind;
}

/**
 * 可选注入。事件名单**不从本模块的 import 里来**（Monaco 语言层零游戏名词）：
 * 宿主把当前项目 adapter 交进来，事件名由 core 的 `eventNames` 派生；测试可直接给
 * `events` 覆盖（两路都缺 ⇒ `# 机` 只给零候选，不猜任何内置事件）。
 */
export interface Kojo2CompletionOptions {
  /** 当前项目 adapter（宿主从内核拿；事件名 = `eventNames(adapter)`）。 */
  readonly adapter?: GameAdapter;
  /** 直接给事件名（测试 / 多 adapter 组合；优先于 `adapter`）。 */
  readonly events?: readonly string[];
}

/** 前缀裁剪（只做 `startsWith`；大小写不敏感不适用——2.0 名字区分大小写）。 */
function withPrefix(names: readonly string[], prefix: string): string[] {
  return prefix.length === 0 ? [...names] : names.filter((name) => name.startsWith(prefix));
}

/** 锚点候选（空行 / 行首空白处）。 */
function anchorCandidates(): Kojo2CompletionCandidate[] {
  return KOJO2_ANCHOR_CHARS.map((anchor) => ({
    label: anchor,
    insertText: anchor,
    kind: 'anchor' as const,
    detail: '锚点',
    sortText: `0_${anchor}`,
  }));
}

/** 声明词候选（`#` 之后的第一枚词）。 */
function declarationWordCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_DECL_WORDS, prefix).map((word) => ({
    label: word,
    insertText: word,
    kind: 'declarationWord' as const,
    detail: '声明词',
    sortText: `1_${word}`,
  }));
}

/** `# 机` 事件候选（adapter eventCatalog；名单可注入，缺省零候选——不猜内置事件）。 */
function eventCandidates(
  prefix: string,
  options: Kojo2CompletionOptions,
): Kojo2CompletionCandidate[] {
  const events =
    options.events ?? (options.adapter === undefined ? [] : kojo2EventNamesOf(options.adapter));
  return withPrefix(events, prefix).map((event) => ({
    label: event,
    insertText: event,
    kind: 'event' as const,
    detail: '事件',
    sortText: `2_${event}`,
  }));
}

/** 域符号候选（`{…}` 插值内）。 */
function domainSymbolCandidates(prefix: string): Kojo2CompletionCandidate[] {
  return withPrefix(KOJO_DOMAIN_SYMBOL_NAMES, prefix).map((symbol) => ({
    label: symbol,
    insertText: symbol,
    kind: 'domainSymbol' as const,
    detail: '域符号',
    sortText: `3_${symbol}`,
  }));
}

/** 声明名候选（表 / 池 / 模 / 函；同文件声明索引）。 */
function declarationCandidates(
  document: Kojo2Document,
  kinds: readonly Kojo2DeclarationKind[],
  prefix: string,
): Kojo2CompletionCandidate[] {
  const allowed = new Set<Kojo2DeclarationKind>(kinds);
  const seen = new Set<string>();
  const out: Kojo2CompletionCandidate[] = [];
  for (const declaration of document.declarations) {
    if (!allowed.has(declaration.kind)) continue;
    if (seen.has(declaration.name)) continue;
    if (prefix.length > 0 && !declaration.name.startsWith(prefix)) continue;
    seen.add(declaration.name);
    out.push({
      label: declaration.name,
      insertText: declaration.name,
      kind: 'declaration',
      declarationKind: declaration.kind,
      detail: `${declarationKindLabel(declaration)}（本文件第 ${declaration.line} 行）`,
      sortText: `4_${declaration.kind}_${declaration.name}`,
    });
  }
  return out;
}

/** 声明种类文案（只用于候选 detail；词形来自 core 词表，见 `kojo2-declarations.ts`）。 */
function declarationKindLabel(declaration: Kojo2Declaration): string {
  return KOJO2_DECL_WORD_BY_KIND[declaration.kind];
}

/** 表达式位（插值内）候选 = 域符号 + 表 / 池 / 模 / 函。 */
function expressionCandidates(
  document: Kojo2Document,
  prefix: string,
): Kojo2CompletionCandidate[] {
  return [
    ...domainSymbolCandidates(prefix),
    ...declarationCandidates(document, KOJO2_MEMBER_DECLARATION_KINDS, prefix),
  ];
}

/** 光标处名字段的前缀（名字字符集与声明索引同源）。 */
function tokenPrefixAt(lineText: string, col0: number): string {
  const span = kojo2TokenSpanAt(lineText, col0);
  if (span === null) return '';
  return lineText.slice(span.start, Math.max(span.start, Math.min(col0, span.end)));
}

/** `#` 之后正在写的第一枚词（`#` / `# 变` / `# ` 都算；词后已有空白 ⇒ 不是这个词的位）。 */
function declarationWordSlotPrefix(before: string): string | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  if (!trimmed.startsWith('#')) return null;
  const rest = trimmed.slice(1).replace(/^[ \t\u3000]*/, '');
  if (rest.length === 0) return '';
  return /^[^ \t\u3000]*$/.test(rest) ? rest : null;
}

/** `# 机 <事件前缀>` 的事件位（事件后已有实参 ⇒ 不在事件名位）。 */
function machineEventSlotPrefix(before: string): string | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  if (!trimmed.startsWith('#')) return null;
  const rest = trimmed.slice(1).replace(/^[ \t\u3000]*/, '');
  if (!rest.startsWith(KOJO2_MACHINE_WORD)) return null;
  const afterWord = rest.slice(KOJO2_MACHINE_WORD.length);
  if (afterWord.length === 0) return null; // `# 机` 还没空格：仍归声明词位
  if (!/^[ \t\u3000]/.test(afterWord)) return null; // `# 机X` 不是事件位
  const tail = afterWord.replace(/^[ \t\u3000]+/, '');
  if (/[ \t\u3000]/.test(tail)) return null; // 已进入实参区
  return tail;
}

/** `! <被调名前缀>` 的名字位（池 / 模 / 函；实参括号之后不补）。 */
function triggerSlotPrefix(before: string): string | null {
  const trimmed = before.replace(/^[ \t\u3000]*/, '');
  if (!trimmed.startsWith('!')) return null;
  const rest = trimmed.slice(1);
  if (!/^[ \t\u3000]/.test(rest)) return null;
  const tail = rest.replace(/^[ \t\u3000]+/, '');
  return /[ \t\u3000(（,，:：]/.test(tail) ? null : tail;
}

/** `@原生` 栏头（`@原生` 整行）；栏头本身也不给补全。 */
function isNativeHeader(record: Kojo2Document['lines'][number] | undefined): boolean {
  return (
    record !== undefined &&
    record.kind === 'dispatch' &&
    record.known &&
    record.word === KOJO2_NATIVE_FENCE_WORD
  );
}

/**
 * 光标处的补全候选（**纯函数**）。
 *
 * 位置门顺序：原生围栏 → 注释 / 旧写法 → 字符串 / 行内注释 → 插值 → 台词正文 → 专有位 →
 * 兜底表达式位。任何一步判定"不是补全位"都返回空数组（静默，不弹噪声）。
 */
export function kojo2CompletionAt(
  query: Kojo2Query,
  options: Kojo2CompletionOptions = {},
): Kojo2CompletionCandidate[] {
  const document = kojo2DocumentOf(query.source);
  const record = document.lines[query.line - 1];
  const lineText = document.physical[query.line - 1]?.text ?? '';
  const col0 = Math.min(Math.max(query.column - 1, 0), lineText.length);

  if (record !== undefined) {
    if (kojo2IsNativeRecord(record) || isNativeHeader(record)) return [];
    if (record.kind === 'comment' || record.kind === 'legacy') return [];
  }
  if (insideStringOrComment(lineText, col0)) return [];

  const before = lineText.slice(0, col0);

  // 插值优先于"台词正文"门：`{…}` 里是表达式，不是台词。
  if (insideInterpolation(lineText, col0)) {
    return expressionCandidates(document, tokenPrefixAt(lineText, col0));
  }
  if (record !== undefined && kojo2IsTextSurface(record)) return [];

  // 行首空白 / 空行：五锚点
  if (isAllBlank(before)) return anchorCandidates();

  // `# 机 <事件>`：事件名（必须先于通用声明词位）
  const eventPrefix = machineEventSlotPrefix(before);
  if (eventPrefix !== null) return eventCandidates(eventPrefix, options);

  // `# <声明词>`
  const declarationPrefix = declarationWordSlotPrefix(before);
  if (declarationPrefix !== null) return declarationWordCandidates(declarationPrefix);

  // `! <池 / 模 / 函>`
  const triggerPrefix = triggerSlotPrefix(before);
  if (triggerPrefix !== null) {
    return declarationCandidates(
      document,
      ['pool', 'template', 'function'],
      triggerPrefix,
    );
  }

  // 兜底表达式位：条件行 / 调度区裸行。台词与原生已在上方退让。
  // `? `（条件还没写）在 core 词法里是 `unknown`，但语法位置就是条件位 ⇒ 用行首锚点补判。
  if (
    record !== undefined &&
    (record.kind === 'condition' || record.kind === 'text' || isConditionSlot(before))
  ) {
    return declarationCandidates(
      document,
      KOJO2_MEMBER_DECLARATION_KINDS,
      tokenPrefixAt(lineText, col0),
    );
  }

  return [];
}

/** 行首 `?`（裸条件行 / 刚敲完锚点）：core 把它归 `unknown`，语义上仍是条件位。 */
function isConditionSlot(before: string): boolean {
  return /^[ \t\u3000]*\?/.test(before);
}
