/**
 * 内容判等核（W17 DIFF-EQ）：**字节态与行态从同一次比对派生**。
 *
 * 为什么需要一份核：两条落点都在回答"这两份东西一样吗"，但一个看字节、一个看行——
 * 各写一条 if 链就会在"字节不同但行相同"（换行风格 / 编码不同）和
 * "字节相同但行不同"（拿缓冲区的文本配盘上的字节）这两种现场给出互相矛盾的说法。
 * 本模块只做纯比较，不读盘、不认识编码，也不做 diff 渲染。
 *
 * 语义边界（判错方向的代价是**说错话**，所以拿不到就返回 null，绝不猜）：
 * - `bytesEqual`：两侧都带 `bytes` 才可判；逐字节比较。
 * - `linesEqual`：两侧都带 `text` 才可判；按 `\r\n / \r / \n` 切行后逐行比较
 *   **行内容**——换行风格差异不算行差异（那是字节态的事）。行数不同即不等，
 *   末尾换行因此是可判差异（`"a\n"` 是两行、`"a"` 是一行）。
 * - `firstByteDiff` / `firstLineDiff`：第一处差异的偏移 / 1 基行号；无法比或相同 = null。
 */

/** 一份内容的两条证据（可只带其一：内联文本没有字节；二进制档没有文本） */
export interface ContentSide {
  readonly bytes?: Uint8Array;
  readonly text?: string;
}

export interface ContentEquality {
  /** 字节态；任一侧没有字节 = null（不猜） */
  readonly bytesEqual: boolean | null;
  /** 行态；任一侧没有文本 = null（不猜） */
  readonly linesEqual: boolean | null;
  /** 首个不同字节的偏移（0 基）；相同或无法比 = null */
  readonly firstByteDiff: number | null;
  /** 首个不同行的行号（1 基）；相同或无法比 = null */
  readonly firstLineDiff: number | null;
}

/** 按三种换行风格切行；只切、不归一化行内容本身 */
export function splitContentLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 首个不同字节偏移；完全相同 = null */
function firstByteDiffOf(a: Uint8Array, b: Uint8Array): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? null : n;
}

/** 首个不同行（1 基）；完全相同 = null */
function firstLineDiffOf(a: readonly string[], b: readonly string[]): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return a.length === b.length ? null : n + 1;
}

/**
 * 一趟比较同时给出字节态与行态。
 * 调用方按自己拿得到的证据读对应字段（`null` = 这一态无法判，不是"相等"）。
 */
export function compareContent(a: ContentSide, b: ContentSide): ContentEquality {
  const byteDiff =
    a.bytes !== undefined && b.bytes !== undefined ? firstByteDiffOf(a.bytes, b.bytes) : null;
  const lineDiff =
    a.text !== undefined && b.text !== undefined
      ? firstLineDiffOf(splitContentLines(a.text), splitContentLines(b.text))
      : null;
  return {
    bytesEqual: a.bytes !== undefined && b.bytes !== undefined ? byteDiff === null : null,
    linesEqual: a.text !== undefined && b.text !== undefined ? lineDiff === null : null,
    firstByteDiff: byteDiff,
    firstLineDiff: lineDiff,
  };
}

/** 行态便捷判据（只拿得到文本的调用方用；拿不到文本 = 无法判 ⇒ null） */
export function linesEqualOf(a: string | undefined, b: string | undefined): boolean | null {
  if (a === undefined || b === undefined) return null;
  return firstLineDiffOf(splitContentLines(a), splitContentLines(b)) === null;
}
