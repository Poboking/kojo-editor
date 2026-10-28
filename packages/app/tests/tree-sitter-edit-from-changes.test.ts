/**
 * 结构层**事件驱动的增量编辑**（`editFromChanges`）· 等价闸。
 *
 * ## 为什么必须有这一条
 *
 * 2026-10-28 起客户端不再在每次击键后 `getValue()` 取全文做差集，而是直接吃 Monaco
 * `onDidChangeContent` 给的 `rangeOffset / rangeLength / text / 行列`。这条路把每击键的
 * 主线程成本从 10.7 ms（1.36 MB 实测）压到 ~0.01 ms——代价是**没有"缝出来的文本 ==
 * getValue()"那道自检**了（那正是要省掉的全文读）。
 *
 * 于是判据搬到运行时之外：一条编辑必须同时满足
 * ① `applyEdit(old, edit) === new`（文本对）；
 * ② `start` / `oldEnd` 逐格等于 `pointAt(old, 偏移)`，`newEnd` 等于 `pointAt(new, 偏移)`
 *    （行列对——worker 的 `tree.edit` 吃的就是行列，错一行就等于把错树留在手上）；
 * ③ 多段（多光标 / 跨行粘贴）并成一条保守区间后仍然对——且事件数组是**降序**的
 *    （Monaco 实测形状，见 `ascending`），降序与升序必须缝出同一条；
 * ④ 形状不认（重叠 / 顺序认不出 / 越界）时**返回 null**，由调用方退回整篇——判据不猜。
 *
 * 随机段用固定种子（`mulberry32`），跑 400 步、覆盖增删改 / 跨行 / 代理对。
 */

import { describe, expect, it } from 'vitest';
import { applyEdit, commonEdit, editFromChanges, pointAt, type ContentChangeLike } from '../src/monaco/tree-sitter/edit';

/** 由"旧文本 + 一段替换"造出 Monaco 会给出的那一格（行列 1 基，偏移/长度按旧文本） */
function changeAt(
  oldText: string,
  offset: number,
  length: number,
  text: string,
): ContentChangeLike {
  const start = pointAt(oldText, offset);
  const end = pointAt(oldText, offset + length);
  return {
    rangeOffset: offset,
    rangeLength: length,
    text,
    range: {
      startLineNumber: start.row + 1,
      startColumn: start.column + 1,
      endLineNumber: end.row + 1,
      endColumn: end.column + 1,
    },
  };
}

/** 把一串互不重叠的改动按 Monaco 的口径应用到旧文本上（**测试侧的真值**） */
function applyChanges(oldText: string, changes: readonly ContentChangeLike[]): string {
  let out = oldText;
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i]!;
    out = out.slice(0, change.rangeOffset) + change.text + out.slice(change.rangeOffset + change.rangeLength);
  }
  return out;
}

function check(oldText: string, changes: readonly ContentChangeLike[]): void {
  const next = applyChanges(oldText, changes);
  const edit = editFromChanges(oldText, changes);
  expect(edit, '这条形状应当认得').not.toBeNull();
  // ① 文本
  expect(applyEdit(oldText, edit!)).toBe(next);
  // ② 行列：起点与旧终点由事件给，新终点由新文本推
  const first = changes[0]!;
  const last = changes[changes.length - 1]!;
  expect(edit!.start).toEqual({
    row: first.range.startLineNumber - 1,
    column: first.range.startColumn - 1,
    offset: first.rangeOffset,
  });
  expect(edit!.oldEnd.offset).toBe(last.rangeOffset + last.rangeLength);
  // 事件给的行列必须与"由文本算出来的点"逐格一致——不一致就是 Monaco 与我们的口径分叉
  expect(edit!.oldEnd).toEqual(pointAt(oldText, last.rangeOffset + last.rangeLength));
  const newEndOffset = edit!.start.offset + next.length - (oldText.length - (edit!.oldEnd.offset - edit!.start.offset));
  expect(edit!.newEnd).toEqual(pointAt(next, newEndOffset));
}

describe('editFromChanges · 一次内容事件 → 一条编辑', () => {
  const text = ['#DIM A = 1', 'PRINTFORM これは台詞', '@EVENT', '\tIF A > 0', '\t\tPRINT あ', '\tENDIF', ''].join('\n');

  it('空事件 ⇒ null（没有任何改动，调用方什么都不发）', () => {
    expect(editFromChanges(text, [])).toBeNull();
  });

  it('行内插入一个字符', () => {
    check(text, [changeAt(text, 5, 0, 'X')]);
  });

  it('行内替换（长度变化）', () => {
    check(text, [changeAt(text, 6, 3, 'BBBB')]);
  });

  it('插入换行（新终点落到下一行行首）', () => {
    const at = text.indexOf('PRINTFORM');
    check(text, [changeAt(text, at, 0, 'あ\nい\n')]);
  });

  it('删除跨行整段', () => {
    const at = text.indexOf('@EVENT');
    const end = text.indexOf('\tIF');
    check(text, [changeAt(text, at, end - at, '')]);
  });

  it('末尾追加（空文本起）', () => {
    check('', [changeAt('', 0, 0, 'PRINT 1\n')]);
  });

  it('代理对（emoji）删一个字符：偏移仍按 UTF-16 码元', () => {
    const doc = 'A😀B😀C';
    const at = doc.indexOf('😀');
    check(doc, [changeAt(doc, at, 2, '')]);
    check(doc, [changeAt(doc, at + 2, 0, '😀😀')]);
  });

  it('CRLF 文档：偏移与换行都在模型 EOL 口径里（不按 LF 重算）', () => {
    // 实测（monaco 0.57 + 真 model，`'甲\r\n乙\r\n丙'` 在行 2 行首插回车）：
    // `getValue()` 长 7、`getEOL()` === '\r\n'、事件给的 `rangeOffset === 3`（CRLF 串里的偏移，
    // LF 串里是 2）、`text === '\r\n'`。缓冲按模型 EOL 存，`_reduceOperations` 会把插入文本
    // 归一成缓冲的 EOL——所以事件与 `getValue()` 同源，这里只要照旧缝即可。
    const doc = '甲\r\n乙\r\n丙';
    expect(doc.indexOf('乙'), 'CRLF 串里第 2 行的偏移').toBe(3);
    expect(doc.indexOf('乙'), 'LF 串里同一位置是 2——差一格就说明口径拿错了').not.toBe(
      doc.replace(/\r\n/g, '\n').indexOf('乙'),
    );
    check(doc, [changeAt(doc, 3, 0, '\r\n')]);
    check(doc, [changeAt(doc, 0, 0, '\r\n[IF A]\r\n')]);
    check(doc, [changeAt(doc, 3, 3, '')]);
  });

  it('多段（多光标）并成一条保守区间', () => {
    const doc = 'one\ntwo\nthree\nfour\n';
    const firstAt = doc.indexOf('two');
    const secondAt = doc.indexOf('four');
    check(doc, [changeAt(doc, firstAt, 3, 'TWO!'), changeAt(doc, secondAt, 4, 'FOUR')]);
  });

  it('多段里跨行与行内混排', () => {
    const doc = 'a\nb\nc\nd\ne\n';
    check(doc, [changeAt(doc, 2, 1, ''), changeAt(doc, 6, 0, 'x\ny\nz')]);
  });

  it('形状不认 ⇒ null：重叠 / 顺序认不出 / 越界', () => {
    const doc = '0123456789';
    expect(
      editFromChanges(doc, [changeAt(doc, 2, 4, ''), changeAt(doc, 4, 1, '')]),
      '重叠',
    ).toBeNull();
    // 既非升序也非降序（Monaco 只给升序或降序两种，见下一条）
    expect(
      editFromChanges(doc, [changeAt(doc, 6, 1, ''), changeAt(doc, 2, 1, ''), changeAt(doc, 8, 1, '')]),
      '顺序认不出',
    ).toBeNull();
    expect(editFromChanges(doc, [changeAt(doc, 8, 5, '')]), '越界').toBeNull();
  });

  it('降序（Monaco 的真实形状）与升序缝出**同一条**编辑', () => {
    // 实测 0.57：一次 `applyEdits` 两段得到 `changes[].rangeOffset === [8, 0]`——
    // 事件数组是**降序**的。若照数组顺序缝，前面的段会把后面的偏移挪掉。
    const doc = 'one\ntwo\nthree\nfour\n';
    const asc = [changeAt(doc, doc.indexOf('two'), 3, 'TWO!'), changeAt(doc, doc.indexOf('four'), 4, 'FOUR')];
    const desc = [asc[1]!, asc[0]!];
    const fromAsc = editFromChanges(doc, asc);
    const fromDesc = editFromChanges(doc, desc);
    expect(fromDesc, '降序必须认').not.toBeNull();
    expect(fromDesc).toEqual(fromAsc);
    expect(applyEdit(doc, fromDesc!)).toBe(applyChanges(doc, asc));
  });

  it('同一次改动：事件路与差集路（commonEdit）缝出同一份文本（两条腿不许分叉）', () => {
    const oldText = '#DIM A = 1\nPRINTFORM 台詞\ntwo\n';
    for (const [offset, remove, insert] of [
      [oldText.indexOf('two'), 3, 'TWO!'],
      [oldText.indexOf('台詞'), 2, 'せりふ'],
      [0, 0, '\n[IF A]\n'],
    ] as const) {
      const changes = [changeAt(oldText, offset, remove, insert)];
      const next = applyChanges(oldText, changes);
      const fromEvent = editFromChanges(oldText, changes);
      expect(fromEvent).not.toBeNull();
      expect(applyEdit(oldText, fromEvent!)).toBe(next);
      expect(applyEdit(oldText, commonEdit(oldText, next))).toBe(next);
    }
  });

  it('随机 400 步：单段与多段都对（固定种子，可复现）', () => {
    let seed = 0x5eed_1028;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = ['a', 'B', 'あ', '漢', '\n', '\t', '0', '😀'];
    let doc = 'PRINTFORM 始まり\n@EVENT\n\tIF A\n\t\tPRINT あ\n\tENDIF\n';
    for (let step = 0; step < 400; step += 1) {
      const len = doc.length;
      const picks = random() < 0.25 ? 2 : 1; // 四分之一的步是多段
      const offsets: number[] = [];
      for (let i = 0; i < picks; i += 1) offsets.push(Math.floor(random() * (len + 1)));
      offsets.sort((a, b) => a - b);
      const changes: ContentChangeLike[] = [];
      let cursor = 0;
      for (const offset of offsets) {
        if (offset < cursor) continue; // 与前一段重叠：这一步只发得下一段
        const remove = Math.min(Math.floor(random() * 4), len - offset);
        const insert = Array.from({ length: Math.floor(random() * 4) }, () => alphabet[Math.floor(random() * alphabet.length)]!).join('');
        changes.push(changeAt(doc, offset, remove, insert));
        cursor = offset + remove;
      }
      if (changes.length === 0) continue;
      const next = applyChanges(doc, changes);
      check(doc, changes);
      doc = next;
    }
    expect(doc.length).toBeGreaterThan(0);
  });
});
