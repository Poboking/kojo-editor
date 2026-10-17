import type * as Monaco from './entry';
import { CASE_ANCHOR, col0Of, insideInterpolation, lineAt, timingHeadParts } from './kojo-completion-position';
import { kojoFunctionNameSlot } from './kojo-completion-functions';
import { kojoCodePositionAt } from './kojo-suggest-gate';
import { documentWordItems } from './document-words';

/**
 * QSUG-2 · `.kojo` 的文档词候选（受位置门约束的那一半）。
 *
 * 装配的 `locate` 已经挡掉台词 / 旁白 / 注释；这里再挡的是**别的 source 的专有名字槽**：
 * 变量插值（`{她的|}`）、`调用` / `函数` 的名字槽、时机块头的分野 / 编号 / 命名参数区、
 * 分支头 `是 <值>`——这些位置该由各自的表出货，文档词混进去就是"名槽候选混装"的回潮。
 * 其余表达式位（`如果 …`、赋值右值、语句函数的实参）放行。
 */
export function kojoWordCandidateAt(line: string, column: number): boolean {
  const col0 = col0Of(line, column);
  if (col0 === null) return false;
  if (insideInterpolation(line, col0)) return false;
  if (kojoFunctionNameSlot(line, column) !== null) return false;

  // 时机块头整行都是专有槽（分野 / 编号 / 命名参数），同一行没有正文位
  if (timingHeadParts(line) !== null) return false;

  // `是 <值>`：指令名 / 字面量的专有槽
  const isHead = CASE_ANCHOR.exec(line);
  if (isHead !== null && col0 >= isHead[0].length) return false;

  return true;
}

export function kojoWordCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  const line = lineAt(model, position.lineNumber);
  if (!kojoCodePositionAt(line, position.column)) return [];
  if (!kojoWordCandidateAt(line, position.column)) return [];
  return documentWordItems(monaco, model, position, range, 'kojo');
}
