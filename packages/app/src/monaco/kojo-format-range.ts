import type * as Monaco from './entry';
import { computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import {errorText,  FULLWIDTH_SPACE } from '@kojo/plugin-api';
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
 * 1. **区间请求该产哪些编辑**：整篇算一遍，再按行裁剪；宿主给了 {@link RangeFormatHandlers.resolveRange}
 *    时**只取要算的那几行**（PS-4，on-type 一次击键不再 copy 整篇）。
 *    为什么不把选区切出来单独算——ERB 形的规则是**逐行纯函数**（每行的新内容只依赖
 *    该行自身，见插件 `formatter.ts` 的 `erbNewContent`），"整篇算 + 按行裁剪"与
 *    "区间单独算"逐字节等价（钉在 `kojo-format-range.test.ts` 的等价性用例）；
 *    而整篇算还保住了跨行上下文（缩进单位探测、`@` 原生块状态），哪天规则长出
 *    跨行语义也不会从这条缝里漏出去——**ERB 形没有这份跨行状态**（`.kojo` 才有，
 *    那条腿留在 `kojo-format.ts`，不走窗口），所以窗口这条腿对方言判据逐字等价。
 *    成本口径：老路 O(行数)×(一次整篇文本拷贝)，新路 O(请求行数)、零整篇拷贝。
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

/**
 * edits 的行号平移（窗口坐标 → 全文坐标）。
 *
 * `request.text` 只装 `[startLine, endLine]` 那几行时，规则层数出来的第 1 行就是全文的
 * 第 `startLine` 行 ⇒ 交回前必须平移，否则编辑会落到隔壁行上去（`toTextEdits` 只会夹取
 * 到模型现实，夹不出"正确的行"）。零偏移原样交回，不多拷一次数组。
 */
export function offsetFormatEdits(edits: readonly FormatEdit[], lineOffset: number): FormatEdit[] {
  if (lineOffset === 0) return [...edits];
  return edits.map((edit) => ({ ...edit, line: edit.line + lineOffset }));
}

/**
 * **窗口通道**（PS-4，additive）：宿主可选提供的"只给要算的那几行"取文腿。
 *
 * 为什么可以只给几行（ERB 形专属）：`kojo-sugar/formatter.ts` 的 `newContents` 在
 * `dialect === 'erb'` 分支里是一行一句 `out[i] = erbNewContent(lines[i].content)`——
 * **逐行纯函数、零跨行状态**，所以"整篇算 + 按行裁剪"与"只把这几行喂进去算 + 平移行号"
 * 逐字节等价。这条等价性仓库早就钉在 `tests/kojo-format-range.test.ts`（区间切片 ≡ 整篇裁剪），
 * 本批只是把同一个判据用到"取文也只取那几行"上，并在 `tests/ps4-provider-seams.test.ts`
 * 里对**窗口路径**再钉一遍（全区间扫描逐字节对照，含 CRLF 与最后一行两个易错点），
 * 单价差在 `tests/ps4-provider-seams.perf.test.ts`（52,601 行一次击键 72–86 ms → 0.007 ms）。
 *
 * 为什么 `.kojo` 不走这条（宿主侧交回 `null` = 请走整篇那条腿）：那边的缩进单位探测与
 * `@` 原生块状态是**文档级**判据（判据本体见 `kojo-format.ts` 的区间格式化头注），
 * 片段视角会数错多数派、会把块内行当糖行重排。
 *
 * **不提供本腿的宿主 = 行为与本批前逐字一致**（`resolve` + 整篇裁剪），既有调用方零改动。
 */
export interface RangeFormatHandlers extends FormatHandlers {
  resolveRange?(model: Monaco.editor.ITextModel, startLine: number, endLine: number): FormatRequest | null;
}

/** 复用整篇格式化的宿主判断 + 规则层，出错就"这次不做"（不许掀编辑器的桌子） */
function resolveSafely(handlers: FormatHandlers, model: Monaco.editor.ITextModel): FormatRequest | null {
  try {
    return handlers.resolve(model);
  } catch (e: unknown) {
    console.warn(`[kojo-format-range] resolve 抛错：${errorText(e)}`);
    return null;
  }
}

function computeSafely(request: FormatRequest, startLine: number, endLine: number): FormatEdit[] {
  try {
    return formatRangeEdits(request, startLine, endLine);
  } catch (e: unknown) {
    console.warn(`[kojo-format-range] computeFormatEdits 抛错：${errorText(e)}`);
    return [];
  }
}

/**
 * 窗口那条腿（PS-4）：宿主给了 `resolveRange` 就只算要算的那几行。
 *
 * 返回 `null` = **这条腿这次不适用**（宿主没给窗口通道 / 窗口不应答 / 取文抛错），
 * 调用方据此退回整篇那条腿——"不适用"与"算过了、没有编辑"（返回 `[]`）是两件事，
 * 混成一件会让"该零编辑"看起来像"没算"。
 */
function computeWindowSafely(
  handlers: RangeFormatHandlers,
  model: Monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): FormatEdit[] | null {
  const resolveRange = handlers.resolveRange;
  if (!resolveRange) return null;
  let request: FormatRequest | null;
  try {
    request = resolveRange(model, startLine, endLine);
  } catch (e: unknown) {
    console.warn(`[kojo-format-range] resolveRange 抛错（退回整篇那条腿）：${errorText(e)}`);
    return null;
  }
  if (!request) return null;
  try {
    // 平移回全文坐标后再裁一次：窗口文本本来就只盖这几行，这道裁剪是"绝不越界"那条
    // 不变式的显式钉子（规则哪天长出跨行状态时，它先红在这里而不是改到隔壁行）
    return clipFormatEditsToLines(offsetFormatEdits(
      computeFormatEdits(request.text, request.dialect),
      startLine - 1,
    ), startLine, endLine);
  } catch (e: unknown) {
    console.warn(`[kojo-format-range] 窗口 computeFormatEdits 抛错：${errorText(e)}`);
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
  handlers: RangeFormatHandlers,
): Monaco.IDisposable {
  const rangeProvider: Monaco.languages.DocumentRangeFormattingEditProvider = {
    provideDocumentRangeFormattingEdits(model, range) {
      const lineCount = model.getLineCount();
      const startLine = clampLine(range.startLineNumber, lineCount);
      const endLine = clampLine(range.endLineNumber, lineCount);
      const windowed = computeWindowSafely(handlers, model, startLine, endLine);
      if (windowed !== null) return toTextEdits(model, windowed);
      const request = resolveSafely(handlers, model);
      if (!request) return [];
      return toTextEdits(model, computeSafely(request, startLine, endLine));
    },
  };

  const onTypeProvider: Monaco.languages.OnTypeFormattingEditProvider = {
    autoFormatTriggerCharacters: [...ON_TYPE_TRIGGER_CHARACTERS],
    provideOnTypeFormattingEdits(model, position) {
      // 一次打字只该算**触发行那一行**（PS-4）：走 `resolveRange` 时整篇文本一次都不 copy；
      // 老路（整篇算 + 裁一行）留着兜底，判据与结果与改前逐字相同。
      const line = clampLine(position.lineNumber, model.getLineCount());
      const windowed = computeWindowSafely(handlers, model, line, line);
      if (windowed !== null) return toTextEdits(model, windowed);
      const request = resolveSafely(handlers, model);
      if (!request) return [];
      return toTextEdits(model, computeSafely(request, line, line));
    },
  };

  const subs = [
    monaco.languages.registerDocumentRangeFormattingEditProvider(ERB_LANGUAGE_ID, rangeProvider),
    monaco.languages.registerOnTypeFormattingEditProvider(ERB_LANGUAGE_ID, onTypeProvider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
