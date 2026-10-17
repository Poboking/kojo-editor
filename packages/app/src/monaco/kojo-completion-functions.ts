import type * as Monaco from './entry';
import { SUGAR_LEXICON_WORDS } from '@kojo/plugin-kojo-sugar';
import { projectFunctionCandidates, type CompletionNameSlot } from './completion-core';
import { insideStringOrComment, nameFieldAfter } from './kojo-completion-position';

/**
 * COMPL-SHARED · `.kojo` 的**项目函数名**候选（跨语言候选打通的那一半）。
 *
 * `.kojo` 里 `调用 剧本函数` 与 `函数 自己起的名字` 写的都是**项目索引里的函数名**——名字与
 * `.erb` 完全同源（宿主注入的 `erbFunctionNames`，按 `ErbIndex.fingerprint` 记忆化）。此前只有
 * `.erb` 那册消费它，`.kojo` 里写 `调用` **零补全**。本模块补上这一路：不出第二份名字表、
 * 不扫盘，候选引擎也**不出第二份实现**（`completion-core` 的 `projectFunctionCandidates`：
 * 同一枚按数组身份记忆化的前缀二分索引、同一套大小写不敏感口径、同一条千条上限）。
 *
 * ## 语言侧只做"位置判定"
 *
 * 触发词不手抄：`调用` / `函数` 的词形一律从 `kojo-sugar` 的 `SUGAR_LEXICON_WORDS` 按关键字 id
 * 派生（`inline.call` / `block.function`）——单一真源，改名即跟改。英文隐藏别名**参与位置判定**
 * （写 `call X` 一样出货）但不算越界：规范 §4.1 的"不展示英文别名"约束的是词表候选，不是槽位。
 *
 * 只在**这两类位置**出货（其余位置一问即走，不猜）：
 * - 行首（可含缩进）`调用 <前缀>` 的调用名槽；
 * - 行首（可含缩进）`函数 <前缀>` 的定义名槽。
 * 槽右界止于 `(` / `)` / `,` / `，` / `;` / 空白 ⇒ 替换范围只覆盖名字那一段；
 * 字符串内 / 注释内不给（`kojo-completion-position` 同一判据）。
 *
 * `insertText` = 名字原文（**不额外插括号**）：糖的调用形 `调用 名字(实参)` 里括号由作者按需要写，
 * 插 `名字(` 会造出 `调用 名字()…` 这类半成品形态；形态之争留给 `.erb` 侧的同一条纪律
 * （`erb-completion.ts` 的 `ERB_CALL_FORM` 也刻意不含函数名一路）。
 */

/** 关键字 id（契约侧 `KeywordId` 的字面量；本模块只用它筛词形，不认识任何词） */
const CALL_WORD_IDS: readonly string[] = ['inline.call'];
const DEFINE_WORD_IDS: readonly string[] = ['block.function'];

/** 词形转正则片段（转义正则元字符——词形是作者字节，不受我们管） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 由关键字 id 派生"行首关键字 + 至少一个空白"的前缀式（长词在前，避免短词先截） */
function leadingKeywordPattern(ids: readonly string[]): RegExp {
  const words = SUGAR_LEXICON_WORDS.filter((w) => ids.includes(w.id))
    .map((w) => w.word)
    .sort((a, b) => b.length - a.length);
  // 无匹配词形 = 词表被改空 ⇒ 该路永不出货（不猜任何默认词）
  if (words.length === 0) return /(?!)/;
  return new RegExp(`^[ \\t　]*(?:${words.map(escapeRegExp).join('|')})[ \\t　]+`, 'i');
}

const CALL_PREFIX = leadingKeywordPattern(CALL_WORD_IDS);
const DEFINE_PREFIX = leadingKeywordPattern(DEFINE_WORD_IDS);

/**
 * 光标处的**项目函数名槽**（`调用` / `函数` 之后；纯函数，可单测）。
 * 位置不符 ⇒ `null`（不猜）。
 */
export function kojoFunctionNameSlot(line: string, column: number): CompletionNameSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, line.length);
  if (insideStringOrComment(line, col0)) return null;
  const call = CALL_PREFIX.exec(line);
  const define = DEFINE_PREFIX.exec(line);
  // 两条槽位互斥：`函数` 与 `调用` 不会同行首同时命中；取先命中的那条的界
  const bound = call !== null ? call[0].length : define !== null ? define[0].length : -1;
  if (bound < 0) return null;
  const field = nameFieldAfter(line, col0, bound);
  return field === null ? null : { start: field.start, end: field.end, prefix: field.prefix };
}

/**
 * 产出 `.kojo` 的项目函数名候选（**纯函数**，供补全基座调用）。
 * 名字缺席 / 位置不符 ⇒ `[]`，不抛。
 */
export function kojoFunctionCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  functionNames: readonly string[] | undefined,
): Monaco.languages.CompletionItem[] {
  if (!model || !position) return [];
  const line = model.getLineContent(position.lineNumber) ?? '';
  return projectFunctionCandidates(
    monaco,
    functionNames,
    kojoFunctionNameSlot(line, position.column),
    position.lineNumber,
  );
}
