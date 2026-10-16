import type * as Monaco from './entry';
import { computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import {
  toTextEdits,
  type FormatHandlers,
  type FormatRequest,
} from './kojo-format';

/**
 * 选区格式化 + 打字规范化（T13）——**只做"区间裁剪/编辑裁剪"这一层**。
 *
 * 规则与 edits 的唯一真源仍是插件侧的 `computeFormatEdits`（`kojo-format.ts` 头注
 * 同一款分工：宿主不认识缩进、不认识全角空格）。本模块**不抄一份规则**，只回答两个问题：
 *
 * 1. **区间请求该产哪些编辑**：整篇算一遍，再按行裁剪。
 *    为什么不把选区切出来单独算——ERB 形的规则是**逐行纯函数**（每行的新内容只依赖
 *    该行自身，见插件 `formatter.ts` 的 `erbNewContent`），"整篇算 + 按行裁剪"与
 *    "区间单独算"逐字节等价（钉在 `kojo-format-range.test.ts` 的等价性用例）；
 *    而整篇算还保住了跨行上下文（缩进单位探测、`@` 原生块状态），哪天规则长出
 *    跨行语义也不会从这条缝里漏出去。成本是 O(行数) 纯内存，无 IO。
 * 2. **编辑绝不越界**：`FormatEdit` 本身永不跨物理行（插件规则第 3 条），所以裁剪
 *    就是行号过滤，天然精确；裁剪后每条编辑都落在 `[startLine, endLine]` 内。
 *    块级对齐超出选区的问题在 ERB 形不存在（ERB 规则本就不跨行对齐）；
 *    若未来出现，答案也是"降级为行内规范化"，不是放宽裁剪。
 *
 * on-type 触发字符只有两个，宁缺毋滥：
 * - `;`：ERB 整行注释的成形点（去缩进后以 `;` 开头才算注释，成形即折注释区全角）；
 * - `　`（U+3000）：行首缩进 / 注释区里"刚打出全角空格"的那一刻（折半角）。
 * 打字中不会乱跳的依据：行中 `;`（打印文本/代码里）不构成整行注释 ⇒ 零编辑；
 * 台词正文里的 U+3000 不在缩进/注释区 ⇒ 零编辑。拿不准的字符一律不注册。
 */

/** on-type 触发字符（注册进 Monaco 的 `autoFormatTriggerCharacters`） */
export const ON_TYPE_TRIGGER_CHARACTERS = [';', FULLWIDTH_SPACE];

/**
 * 行区间裁剪：只留落在 `[startLine, endLine]` 内的编辑。
 * 区间倒置（start > end）⇒ 空（没有任何"合法区间"，宁可不做也不猜方向）。
 */
export function clipFormatEditsToLines(
  edits: readonly FormatEdit[],
  startLine: number,
  endLine: number,
): FormatEdit[] {
  if (startLine > endLine) return [];
  return edits.filter((e) => e.line >= startLine && e.line <= endLine);
}

/** 区间版格式化：同一核心算整篇，按行裁剪（单一真源，见模块头注） */
export function formatRangeEdits(
  request: FormatRequest,
  startLine: number,
  endLine: number,
): FormatEdit[] {
  return clipFormatEditsToLines(computeFormatEdits(request.text, request.dialect), startLine, endLine);
}

/** 复用整篇格式化的宿主判断 + 规则层，出错就"这次不做"（不许掀编辑器的桌子） */
function resolveSafely(handlers: FormatHandlers, model: Monaco.editor.ITextModel): FormatRequest | null {
  try {
    return handlers.resolve(model);
  } catch (e: unknown) {
    console.warn(`[kojo-format-range] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function computeSafely(request: FormatRequest, startLine: number, endLine: number): FormatEdit[] {
  try {
    return formatRangeEdits(request, startLine, endLine);
  } catch (e: unknown) {
    console.warn(`[kojo-format-range] computeFormatEdits 抛错：${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** 行号夹进 1..lineCount（provider 与用户编辑间没有锁，陈旧区间夹取不抛错） */
function clampLine(line: number, lineCount: number): number {
  return Math.min(Math.max(1, Math.trunc(line) || 1), lineCount);
}

/**
 * 为 ERB 语言注册两个 provider：
 * - `Ctrl+K Ctrl+F`（Monaco 内建 `editor.action.formatSelection`）→ 区间格式化；
 * - 触发字符（`;` / 全角空格）打字后 → 该行的行内规范化。
 *
 * 只注册 `ERB_LANGUAGE_ID`：整篇格式化已覆盖两个语言（`installDocumentFormatter`），
 * 这两个新入口的语义保守面是按 ERB 形（逐行纯）论证的，`.kojo` 不搭这班车。
 * `.kojo` 的区间格式化走 `kojo-format.ts::installRangeFormatter`（一门语言一枚 provider，
 * 两侧不得同时注册 ERB——否则选区结果由注册表顺序决定，本模块的宿主判据会被绕过）。
 */
export function installRangeFormatter(
  monaco: typeof Monaco,
  handlers: FormatHandlers,
): Monaco.IDisposable {
  const rangeProvider: Monaco.languages.DocumentRangeFormattingEditProvider = {
    provideDocumentRangeFormattingEdits(model, range) {
      const request = resolveSafely(handlers, model);
      if (!request) return [];
      const lineCount = model.getLineCount();
      const edits = computeSafely(
        request,
        clampLine(range.startLineNumber, lineCount),
        clampLine(range.endLineNumber, lineCount),
      );
      return toTextEdits(model, edits);
    },
  };

  const onTypeProvider: Monaco.languages.OnTypeFormattingEditProvider = {
    autoFormatTriggerCharacters: [...ON_TYPE_TRIGGER_CHARACTERS],
    provideOnTypeFormattingEdits(model, position) {
      const request = resolveSafely(handlers, model);
      if (!request) return [];
      const line = clampLine(position.lineNumber, model.getLineCount());
      const edits = computeSafely(request, line, line);
      return toTextEdits(model, edits);
    },
  };

  const subs = [
    monaco.languages.registerDocumentRangeFormattingEditProvider(ERB_LANGUAGE_ID, rangeProvider),
    monaco.languages.registerOnTypeFormattingEditProvider(ERB_LANGUAGE_ID, onTypeProvider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
