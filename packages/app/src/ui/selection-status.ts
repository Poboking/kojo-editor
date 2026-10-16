/**
 * A9 状态栏选区读数（纯函数半边）：编辑器选区/光标 → 状态栏文案。
 *
 * 口径：有选区 → 单行 `选中 C字符`、多行 `选中 L行 × C字符`；无选区 → 光标 `行:列`。
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
  const chars = selectionCharCount(model, sel);
  const lines = sel.endLineNumber - sel.startLineNumber + 1;
  return lines === 1 ? `选中 ${chars}字符` : `选中 ${lines}行 × ${chars}字符`;
}
