import type { KojoStructurePoint } from './types';
/**
 * 一次文本变更 → **一条**保守编辑（`tree.edit` 只吃一条，Monaco 一次事件可能带多段）。
 *
 * 做法是前后缀公共部分求差：`[p, oldLen - s)` 是被替换的旧区间、`[p, newLen - s)` 是
 * 替换后的新区间，中间那段就是 `newText`。多光标一次改三处时这条区间会**放大**到覆盖
 * 全部改动（保守但正确：tree-sitter 只是把这一段标记为脏并复用其余部分，判定结果不变）。
 *
 * 为什么单独成文件：这是纯字符串算术，主线程与测试打的是同一条路（worker 那边按同样的
 * 口径缝自己的文本副本 ⇒ 两侧文本永远逐字相等，不需要每击键回传整篇）。
 *
 * 复杂度 O(n)（前后缀扫描 + 行号统计）。`edit.ts` 因此带一个"脏起点提示"的入口参数：
 * 宿主可以把上一次的位置传回来，命中前缀就少扫一段；不传也照样对。
 */

/** 偏移 → 点（0 基行 / 0 基 UTF-16 列 / 偏移本身）；单次线性扫描，不反复 `split('\n')` */
export function pointAt(text: string, offset: number): KojoStructurePoint {
  const end = Math.min(Math.max(0, offset), text.length);
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, column: end - lineStart, offset: end };
}

export interface StructureEdit {
  readonly start: KojoStructurePoint;
  readonly oldEnd: KojoStructurePoint;
  readonly newEnd: KojoStructurePoint;
  readonly newText: string;
}

/** 两侧都空 ⇒ 一条零宽编辑（协议形状不变，worker 走整篇重解以外的路也不出错） */
export function commonEdit(oldText: string, newText: string, hint = 0): StructureEdit {
  const maxPrefix = Math.min(oldText.length, newText.length);
  let p = Math.min(Math.max(0, Math.trunc(hint)), maxPrefix);
  while (p < maxPrefix && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  const maxSuffix = Math.min(oldText.length, newText.length) - p;
  let s = 0;
  while (
    s < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)
  ) s++;
  const oldEndOffset = oldText.length - s;
  const newEndOffset = newText.length - s;
  return {
    start: pointAt(oldText, p),
    oldEnd: pointAt(oldText, oldEndOffset),
    newEnd: pointAt(newText, newEndOffset),
    newText: newText.slice(p, newEndOffset),
  };
}

/**
 * 按同一条编辑把旧文本缝成新文本（worker 侧用的就是这一步；主线程用它把自己手上的快照
 * 推到下一版——**不再**用它跟 `getValue()` 对全文：那道自检换成了 O(1) 的行数对账，见
 * `client.onChanged`）。
 *
 * **几乎不花钱**：两侧 `slice` 在 V8 里是 SlicedString（只记偏移，不复制），
 * 1.36 MB 文本实测 **0.01 ms**——与 {@link commonEdit} 那 10.7 ms 不是一个量级。
 */
export function applyEdit(oldText: string, edit: StructureEdit): string {
  return oldText.slice(0, edit.start.offset) + edit.newText + oldText.slice(edit.oldEnd.offset);
}

/**
 * Monaco 一次内容变更事件里**本模块要的那几格**（只取这五格，不 import monaco 类型：
 * 这个文件要能被裸 node 直接跑，见 `tools/` 的装载面）。
 */
export interface ContentChangeLike {
  /** 旧文本坐标下的替换起点（UTF-16 码元） */
  readonly rangeOffset: number;
  /** 旧文本坐标下被替换掉的长度 */
  readonly rangeLength: number;
  /** 替换进去的新文本 */
  readonly text: string;
  readonly range: {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
  };
}

/**
 * 一次内容事件 → **一条**保守编辑，**不读全文**（`getValue()` + {@link commonEdit} 的替代）。
 *
 * ## 为什么要有这条路
 *
 * 旧口径在每次击键后 `model.getValue()` 取全文、再与上一版做前后缀差集：1.36 MB / 24,197 行
 * 实测 **10.7 ms**，全部落在主线程的输入路径上。而 Monaco 的 `onDidChangeContent` 本身
 * 已经把 `rangeOffset` / `rangeLength` / `text` / 行列都给了（它就是"哪一段被换成了什么"），
 * 拿它直接拼一条编辑是 O(改动数)，与文档长度无关。
 *
 * ## 多段怎么办
 *
 * `changes` 可能是多光标 / 一次粘贴的多段。按旧口径的做法把它们**并成一条**覆盖全部改动的
 * 保守区间（tree-sitter 只会把这一段标脏，判定结果不变）：起点取最小、终点取最大，
 * 中间的"新文本"由**旧文本的这段切片**逐段缝出来——切片是 SlicedString，不复制整篇。
 *
 * ⚠ **Monaco 给的 `changes` 是按 `rangeOffset` 降序的**（0.57 实测：一次 `applyEdits` 两段
 * 得到 `[8, 0]`；`pushEditOperations` 同样 `[5, 0]`）。按数组顺序缝会当场错位，所以先归一到
 * 升序再算——单段（绝大多数击键）零分配，多段才拷一份。
 *
 * ## 边界
 *
 * - `changes` 为空 ⇒ 返回 `null`（没有任何改动，调用方什么都不发）；
 * - 归一后各段必须互不重叠；既非升序也非降序、或区间重叠 ⇒ 就地返回 `null`，
 *   由调用方退回整篇——判据不猜；
 * - 偏移与 `text` 都在**模型 EOL 口径**里：CRLF 文档的 `rangeOffset` 按 CRLF 数（比 LF 口径大），
 *   `text` 也被 `_reduceOperations` 归一成 `\r\n`。与 `getValue()` 同源，不要按 LF 重算。
 */
export function editFromChanges(oldText: string, changes: readonly ContentChangeLike[]): StructureEdit | null {
  if (changes.length === 0) return null;
  const ordered = ascending(changes);
  if (ordered === null) return null;
  let first = ordered[0]!;
  let last = ordered[0]!;
  let previousOldEnd = -1;
  for (const change of ordered) {
    if (!Number.isFinite(change.rangeOffset) || !Number.isFinite(change.rangeLength)) return null;
    if (change.rangeOffset < previousOldEnd) return null; // 重叠 / 乱序：不猜
    previousOldEnd = change.rangeOffset + change.rangeLength;
    if (change.rangeOffset < first.rangeOffset) first = change;
    if (change.rangeOffset + change.rangeLength > last.rangeOffset + last.rangeLength) last = change;
  }
  const startOffset = first.rangeOffset;
  const oldEndOffset = last.rangeOffset + last.rangeLength;
  if (startOffset < 0 || oldEndOffset > oldText.length) return null; // 与手上的快照对不上：不猜

  // 旧文本的这一段（SlicedString，O(1)）就地缝上各段的新文本。倒序拼：前面的偏移不被挪动。
  let newText = oldText.slice(startOffset, oldEndOffset);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const change = ordered[i]!;
    const relative = change.rangeOffset - startOffset;
    newText = newText.slice(0, relative) + change.text + newText.slice(relative + change.rangeLength);
  }

  const startRow = first.range.startLineNumber - 1;
  const startColumn = first.range.startColumn - 1;
  // 新终点只由起点与新文本决定（新文本里换了几行），不必读模型
  const newlineCount = countNewlines(newText);
  const newEndRow = startRow + newlineCount;
  const newEndColumn = newlineCount === 0 ? startColumn + newText.length : lastLineLength(newText);
  return {
    start: { row: startRow, column: startColumn, offset: startOffset },
    oldEnd: {
      row: last.range.endLineNumber - 1,
      column: last.range.endColumn - 1,
      offset: oldEndOffset,
    },
    newEnd: { row: newEndRow, column: newEndColumn, offset: startOffset + newText.length },
    newText,
  };
}

/**
 * 归一到**升序**（Monaco 给的是降序，见 `editFromChanges` 头注）。
 *
 * - 单段（绝大多数击键）：原样返回，零分配；
 * - 已是升序：原样返回；
 * - 降序：拷一份反转（多光标 / 一次粘贴才走到这里）；
 * - 既非升序也非降序：`null` —— 顺序都认不出，谈不上"保守区间"，交给整篇。
 */
function ascending(changes: readonly ContentChangeLike[]): readonly ContentChangeLike[] | null {
  if (changes.length === 1) return changes;
  let nonDecreasing = true;
  let nonIncreasing = true;
  for (let i = 1; i < changes.length; i += 1) {
    const previous = changes[i - 1]!.rangeOffset;
    const current = changes[i]!.rangeOffset;
    if (current < previous) nonDecreasing = false;
    if (current > previous) nonIncreasing = false;
  }
  if (nonDecreasing) return changes;
  if (nonIncreasing) return [...changes].reverse();
  return null;
}

/** 新文本里换了几行（`\n` 计一次；与 `pointAt` 同口径）。导出：客户端的行数对账也用它 */
export function countNewlines(text: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf('\n', from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

/** 末行长度（列号 = 该长度；`\n` 之后的字符数） */
function lastLineLength(text: string): number {
  return text.length - text.lastIndexOf('\n') - 1;
}
