/**
 * A9 状态栏选区读数（纯函数半边）：编辑器选区/光标 → 状态栏文案。
 *
 * 口径：有选区 → 单行 `选中 C字符`、多行 `选中 L行 × C字符`；无选区 → 光标 `行:列`；
 * 选区超过 {@link SELECTION_CHAR_COUNT_MAX_LINES} 行 → `选中 L行 · 未计字符`（降级写在文案里）。
 * 字符数按**码点**计数（CJK / emoji 一笔一字符，不掰字素簇）——代价 O(选区行数)：
 * 逐行切片求和，绝不 getValue 全文（这条链挂在光标监听上，大文件下每键都跑）。
 */

/** Monaco Selection 的几何投影（只取需要的四个坐标，便于打桩测） */
export interface SelRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** 只依赖逐行取文（model.getLineContent 的形似接口） */
export interface SelModelLike {
  getLineContent(lineNumber: number): string;
}

/**
 * 算字符数还要一行行的上限档（PS-4）。
 *
 * `selectionCharCount` 的单价 = 选区行数 × 一次整行取文（Monaco 的 `getLineContent`
 * 每行都物化一份字符串），而这条链挂在**每一次光标事件**上（`EditorPane` 的
 * `onDidChangeCursorPosition` / `onDidChangeModel`）。`Ctrl+A` 选中语料之最那篇
 * （52,601 行 / 2.35 MB）就是每动一次光标物化整篇文本一遍。
 *
 * 档位定在 2,000 行是按**实测单价**定的，不是凑整：`tests/ps4-provider-seams.perf.test.ts`
 * 在合成 50,000 行文档（2.35 MB 量级）上量到 2,000 行的选区计数中位 **0.09–0.10 ms**
 * （与一次光标事件本来的重排开销同量级），50,000 行则是 **2.3–3.7 ms**——已经比一次
 * 击键该付的钱贵一个数量级，而那还只是"半个全篇扫描"；语料之最那篇（52,601 行）上
 * 每一次方向键都要付这一刀。
 *
 * **对标 VSCode**：那边的选区字符数走 piece-tree 的 `getValueLengthInRange`（不物化文本，
 * 与选区行数无关），所以它不需要档位。本仓这条链上唯一的精确 API 就是逐行取文，
 * 而码点口径（代理对算一个字符）又要看完内容才判得出——两者都没有"便宜的精确"这条路，
 * 于是档外**只报行数并把话说出来**（铁律 4：降级必须可见，绝不静默改成"0 字符"那种谎话）。
 */
export const SELECTION_CHAR_COUNT_MAX_LINES = 2000;

/** 选区跨了几行（1 基闭区间；行数 ≥ 1） */
export function selectionLineSpan(sel: SelRangeLike): number {
  return sel.endLineNumber - sel.startLineNumber + 1;
}

/** 这次选区还值不值得算字符数（纯函数，档内 = 算） */
export function selectionCharCountAffordable(sel: SelRangeLike): boolean {
  return selectionLineSpan(sel) <= SELECTION_CHAR_COUNT_MAX_LINES;
}

export interface SelCursor {
  line: number;
  column: number;
}

/** 码点计数：无代理对时 length 即码点数（快路径），有则 Array.from 按码点展开 */
export function countCodePoints(text: string): number {
  let hasSurrogate = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      hasSurrogate = true;
      break;
    }
  }
  return hasSurrogate ? Array.from(text).length : text.length;
}

/** 选区字符数（码点，不含换行符本身）：首尾行切片 + 中间整行，O(选区行数) */
export function selectionCharCount(model: SelModelLike, sel: SelRangeLike): number {
  let total = 0;
  if (sel.startLineNumber === sel.endLineNumber) {
    const line = model.getLineContent(sel.startLineNumber);
    return countCodePoints(line.slice(sel.startColumn - 1, sel.endColumn - 1));
  }
  total += countCodePoints(model.getLineContent(sel.startLineNumber).slice(sel.startColumn - 1));
  for (let l = sel.startLineNumber + 1; l < sel.endLineNumber; l++) {
    total += countCodePoints(model.getLineContent(l));
  }
  total += countCodePoints(model.getLineContent(sel.endLineNumber).slice(0, sel.endColumn - 1));
  return total;
}

/**
 * 选区/光标 → 状态栏文案。
 * `sel` 为空区间（或 null）时退回 `行:列`（光标取选区的活动端 `cursor`）。
 *
 * 超过 {@link SELECTION_CHAR_COUNT_MAX_LINES} 行的选区**只报行数并把原因写在面上**
 * （`选中 50000行 · 未计字符`）：字符数要逐行物化文本，档外算它是每键一次全篇扫描，
 * 而"没算"必须由作者读得出来——报 0 或干脆不提都是谎话（铁律 4）。
 */
export function selectionStatusText(
  model: SelModelLike | null,
  sel: SelRangeLike | null,
  cursor: SelCursor,
): string {
  const isEmpty =
    sel === null ||
    (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn);
  if (isEmpty || !model) return `${cursor.line}:${cursor.column}`;
  const lines = selectionLineSpan(sel);
  if (!selectionCharCountAffordable(sel)) return `选中 ${lines}行 · 未计字符`;
  const chars = selectionCharCount(model, sel);
  return lines === 1 ? `选中 ${chars}字符` : `选中 ${lines}行 × ${chars}字符`;
}
