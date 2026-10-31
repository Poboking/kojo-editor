import type * as Monaco from './entry';
import { projectFunctionCandidates, type CompletionNameSlot } from './completion-core';
import {
  insideStringOrComment,
  kojoKeywordAnchor,
  nameSlotAfterAnchor,
} from './kojo-completion-position';
import { columnIndexIn } from './positions';

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

/** 关键字 id（`block.*` / `inline.*`）：调用名槽与定义名槽共用**一条**锚（行首互斥，不会同时命中） */
const FUNCTION_SLOT_IDS = ['inline.call', 'block.function'] as const;

/**
 * 「行首 `调用` / `函数` + 空白」锚（装配口径在 `kojo-completion-position`，词形取自
 * `kojo-sugar` 词表——本文件不手抄任何词形，也不自拼正则）。
 */
const FUNCTION_ANCHOR: RegExp = kojoKeywordAnchor(FUNCTION_SLOT_IDS);

/**
 * 光标处的**项目函数名槽**（`调用` / `函数` 之后；纯函数，可单测）。
 * 位置不符 ⇒ `null`（不猜）。字符串内 / 注释内同样 `null`（与 `.kojo` 其余源同一判据）。
 */
export function kojoFunctionNameSlot(line: string, column: number): CompletionNameSlot | null {
  if (insideStringOrComment(line, columnIndexIn(line, column))) return null;
  const field = nameSlotAfterAnchor(line, column, FUNCTION_ANCHOR);
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
