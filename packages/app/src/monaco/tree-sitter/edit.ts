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
 * 按同一条编辑把旧文本缝成新文本（worker 侧用的就是这一步；
 * 主线程拿它做自检——缝出来的文本与 Monaco 现读的全文不等 ⇒ 增量口径漂了，退回整篇）。
 */
export function applyEdit(oldText: string, edit: StructureEdit): string {
  return oldText.slice(0, edit.start.offset) + edit.newText + oldText.slice(edit.oldEnd.offset);
}
