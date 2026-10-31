/**
 * `formatting` 供方（ERB-PARITY G2，2026-10-31）：契约请求 → `@kojo/kojo-vocab/formatter`
 * 的**同一把尺子** → 契约的 `EditorRangeEdit[]`。
 *
 * ## 为什么不在这里写一套判据
 *
 * ERB 的排版规则（全角空格折算 / 按现有配对排块层级 / 保护区与死区不动 / 单位探测）唯一真源
 * 就是 `@kojo/kojo-vocab/formatter`（`.kojo` 与 ERB 共用同一份核心，只是缩进来源不同）。
 * 本模块只做三件搬运：`FormatEdit`（1 基行号、列不含端点）→ `EditorRangeEdit`
 * （同口径，`endLine` 与 `startLine` 相同）；整篇 / 区间两条请求的差值只有一句"按行裁剪"；
 * 规则开关从请求的 `options` 原样递给判据（结构相容，不反向引任何偏好类型）。
 *
 * ## 为什么住 `@kojo/plugin-erb-lang` 而不是 `@kojo/plugin-erb-parser`
 *
 * `erb-parser` 是 `bootstrap.ts` 的**两个常驻插件之一**（在开机静态图里）。静态引
 * `@kojo/kojo-vocab/formatter` 会把它的四条纯函数依赖一起拽进首屏（实测 **+6 文件 /
 * +224 KB**，`ps10-eager-graph` 的 199 文件闸当场红）；动态引又会在 worker 的 iife 产物里
 * 切 chunk（`packages/app/vite.config.ts` 头注：worker 不吃 code-splitting）。本插件是
 * **懒装载**的语言面供方（`bootstrap.ts` 的 `import('@kojo/plugin-erb-lang')`），判据照样
 * 一份、开机图一分不涨——这与 ERB 的高亮 / 扩选同一条理由（判据在库包、插件只做接线）。
 *
 * ## 三态（同 hover / references 的同名供方）
 *
 * 非 `formatting` / 非 ERB ⇒ `undefined`（**弃权**，让下一家接手）；认这门语言 ⇒ 总是作答
 * （哪怕零编辑——零编辑是"这篇已经规范"，不是"我不答"）；判据抛错 ⇒ `undefined`
 * （宿主交回空表；不让异常穿回击键路径）。
 */
import type {
  EditorFormattingResult,
  EditorLanguageServiceRequest,
  EditorRangeEdit,
} from '@kojo/plugin-api';
import { computeFormatEdits, type FormatEdit } from '@kojo/kojo-vocab/formatter';
import { isErbRequest } from './request';

/** 规则行的行区间（1 基、闭区间）：与契约 `EditorFormattingLineRange` 同口径 */
function withinLines(edits: readonly FormatEdit[], startLine: number, endLine: number): FormatEdit[] {
  // 倒置 ⇒ 空：没有任何"合法区间"，宁可不做也不猜方向（与宿主 `clipFormatEditsToLines` 同规）
  if (startLine > endLine) return [];
  return edits.filter((edit) => edit.line >= startLine && edit.line <= endLine);
}

/** `FormatEdit`（列不含端点）→ `EditorRangeEdit`（`endLine` 与 `startLine` 同一行） */
function toRangeEdit(edit: FormatEdit): EditorRangeEdit {
  return {
    startLine: edit.line,
    startColumn: edit.startColumn,
    endLine: edit.line,
    endColumn: edit.endColumn,
    newText: edit.text,
  };
}

/** 交回 `{ kind: 'formatting', edits }`，或 `undefined`（弃权：不是这个 kind / 不是 ERB / 判据抛错） */
export function provideFormatting(
  request: EditorLanguageServiceRequest,
): EditorFormattingResult | undefined {
  if (request.kind !== 'formatting') return undefined;
  if (!isErbRequest(request)) return undefined;
  try {
    // 整篇腿算、区间腿裁剪：ERB 的块层级 / 保护区是**文档级**判据（缩进深度从文件头压下来、
    // 数据表块体与停用死区跨行），切片单独算会把块外行当糖行重排 ⇒ 与 v1 区间腿、
    // 宿主 `formatRangeEdits` 逐字节同口径（等价性钉在 `packages/app/tests/kojo-format-range.test.ts`）。
    const all = computeFormatEdits(request.text, 'erb', request.options);
    const lineRange = request.lineRange;
    const kept = lineRange === undefined ? all : withinLines(all, lineRange.startLine, lineRange.endLine);
    return { kind: 'formatting', edits: kept.map(toRangeEdit) };
  } catch {
    // 判据抛错：这次不格式化（交回 `undefined` 让宿主退成空表），不把异常穿回编辑器
    return undefined;
  }
}