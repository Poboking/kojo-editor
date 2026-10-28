/**
 * `formatting` 供方：包里的格式化规则（`@kojo/kojo-lang/format`）→ 契约的 `EditorRangeEdit[]`。
 *
 * ## B3d：这一格从"宿主原生 provider"换成了"插件供方"
 *
 * 规则全部住在 `@kojo/kojo-lang/format`（`formatKojo2Source` / `formatKojo2Range`，行为与搬进
 * 包之前的宿主逐字相同：缩进归一 / 空行呼吸 / 行尾空白 / EOL 保留 / 幂等 + 可解析两道闸），
 * 本文件只做**翻译**：中性 edits → 契约区间编辑。宿主侧两枚 provider（整篇 `Shift+Alt+F`、
 * 区间 `Ctrl+K Ctrl+F`）只把 model 与选区翻成请求。
 *
 * ## 整篇 / 区间两路（`request.lineRange`）
 *
 * - `lineRange` **缺席** ⇒ 整篇（`formatKojo2Source`）——与本格存在之前逐字相同；
 * - `lineRange` **在场** ⇒ 区间（`formatKojo2Range`）：规则仍然整篇算一遍（2.0 的缩进深度是
 *   文档级判据、围栏状态跨行），只把落点裁到这几行；**选区之外逐字节不动**。
 *
 * 为什么不自己按 `lineRange` 切串再排：切片视角会把块体内的行当顶层、把围栏里的行当普通行，
 * 排出来的东西与 `Shift+Alt+F` 不一致（包里那条注释写死了这条理由）。
 *
 * ## 三态（与 hover / signatureHelp 同一条纪律）
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：宿主侧那枚 provider 也挂在别的语言上（共享收口按
 *   descriptor 铺语言），弃权让它交回空结果、**不**去顶掉那门语言自己的格式化 provider；
 * - **认这门语言 ⇒ 总是作答**：`edits: []` = 认这篇、不需要改（**不是**弃权）——空文件 /
 *   已合规文档 / 空格子都走这一条；
 * - 规则内部"少改"的判定（可解析闸 / 幂等 / 越界）全在包里，本层不重复判。
 *
 * ## 抛错面
 *
 * 包内函数不抛（所有失败方向都是"原样返回"）；真抛了也归成 `{ edits: [] }`——宿主会把 throw
 * 吞成"格式化突然没反应"，空结果是它能读懂的形状。
 */
import type {
  EditorFormattingResult,
  EditorLanguageServiceRequest,
  EditorRangeEdit,
} from '@kojo/plugin-api';
import { formatKojo2Range, formatKojo2Source, type Kojo2FormatEdit } from '@kojo/kojo-lang/format';
import { isKojo2Request } from './request';

/** 包内 edit（`range` 四格 + `newText`）→ 契约区间编辑（列缺省口径：给了就照给） */
function rangeEditOf(edit: Kojo2FormatEdit): EditorRangeEdit {
  return {
    startLine: edit.range.startLineNumber,
    startColumn: edit.range.startColumn,
    endLine: edit.range.endLineNumber,
    endColumn: edit.range.endColumn,
    newText: edit.newText,
  };
}

/**
 * 交回 `{ kind: 'formatting', edits }`（按行号升序：包内 `buildEdits` 就是逐行升序产出），
 * 或 `undefined`（弃权：不是 formatting / 不是 kojo2）。
 */
export function provideFormatting(
  request: EditorLanguageServiceRequest,
): EditorFormattingResult | undefined {
  if (request.kind !== 'formatting') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const result =
      request.lineRange === undefined
        ? formatKojo2Source(request.text)
        : formatKojo2Range(request.text, request.lineRange.startLine, request.lineRange.endLine);
    return { kind: 'formatting', edits: (result.edits ?? []).map(rangeEditOf) };
  } catch {
    return { kind: 'formatting', edits: [] };
  }
}

// 形状与 legs 的 `formattingRequestOf` 对齐：本供方读的字段恰是 `text` 与 `lineRange`
// （+ 弃权判定用的 `languageId` / `path`），`version` / `lineCount` / `project` 零消费。
