/**
 * ERB **变量族头补全**：宿主侧只剩**形状翻译**（判据已搬进 `@kojo/erb-lang/completion-families`）。
 *
 * ## 搬走了什么
 *
 * 「这个位置算不算裸标识符名位」「前缀怎么比（大小写不敏感）」「哪些族以它起头」「排序档」
 * 都在包里——它们是语言事实，`#DIM` 声明名源要用同一份扫描，插件的供方也要用同一份；
 * 而插件读不到 `packages/app/src/**`。本文件只把中性候选翻成 Monaco 条目。
 *
 * ## 旧导出面一字未改
 *
 * `erbDeclaredNameSlot` / `ERB_SIGIL_BEFORE` / `ErbNameSlot` 原样 re-export（`#DIM` 声明名源与
 * 成员源的 import 点不动）；`erbFamilyCompletionItems` 的签名也不动，既有测试零改动。
 *
 * ## 翻译口径
 *
 * 走宿主既有的那份**中性候选 → Monaco** 翻译件（`kojo2-providers.ts` 的
 * `toMonacoCompletionItems`：档→图标、区间→`IRange` 都在那一张表里）。这里不另写第二份，
 * 否则同一档在不同家族里会挑出不同图标。
 */
import type * as Monaco from './entry';
import { erbFamilyCandidates } from '@kojo/erb-lang/completion-families';
import { toMonacoCompletionItems } from './kojo2-providers';

export { ERB_SIGIL_BEFORE, erbDeclaredNameSlot } from '@kojo/erb-lang/completion-families';
export type { ErbNameSlot } from '@kojo/erb-lang/completion-families';

/** 空区间：本族每一条候选都带自己的区间，缺省值只在"供方没给"时才被用到 */
const NO_RANGE: Monaco.IRange = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
};

/**
 * 取某一行原文（桩 model / 越界 ⇒ 空串）。
 *
 * 这一步是**宿主事实**（"这份 model 的第 n 行是什么"），不在包里：包里收的是"拿到一行文本
 * 之后怎么判"。旧实现走 `kojo-completion-position` 的 `lineAt`，同一条防御口径；这里就地
 * 不引它，是为了让本文件只剩"取行 + 翻译"两件事。
 */
function lineTextOf(model: Monaco.editor.ITextModel, lineNumber: number): string {
  try {
    const fn = (model as { getLineContent?: (n: number) => string }).getLineContent;
    if (typeof fn !== 'function') return '';
    return fn.call(model, lineNumber) ?? '';
  } catch {
    return '';
  }
}

/**
 * 产出 `.erb` **族头**补全候选（供补全基座调用）。
 *
 * 位置不符 / 前缀无任何族命中 ⇒ `[]`（包里就是这条口径，本层不补第二判断）。
 */
export function erbFamilyCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  if (!monaco || !model || !position) return [];
  const { lineNumber, column } = position;
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return [];
  if (!Number.isFinite(column) || column < 1) return [];
  return toMonacoCompletionItems(
    monaco,
    erbFamilyCandidates(lineTextOf(model, lineNumber), column, lineNumber),
    NO_RANGE,
  );
}