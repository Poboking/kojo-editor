/**
 * 语义着色 · **增量通道**等价对拍（R3，2026-10-28）。
 *
 * 判据只有一条，且是全仓最硬的那一类：
 *
 * > 100 步随机编辑，把每一步的 `edits` 按 **Monaco 的算法**累积套用到上一版 `data` 上，
 * > 结果必须与「每步整篇重算」**逐字节相等**；同时拼接交回的基线也必须等于整篇重算。
 *
 * 为什么必须复刻 Monaco 的套用算法（而不是自己写一条"按顺序替换"）：Monaco 是**从后往前**
 * 套的（`documentSemanticTokens.js` 的循环 `for (i = edits.length - 1; i >= 0; i--)`，
 * 并用 `srcLastStart` 往前追），它**不校验顺序**、只校验 `start > srcData.length` 与
 * 总长非负。照着"从前往后"写一遍自测，错序的 `edits` 会一路绿到真机上变成错色。
 *
 * 随机编辑覆盖三类：**改一行 / 插几行 / 删几行**（删到文末、删到只剩一行都在内），
 * 每行的 span 故意安排同一行内互相重叠的两条——顺带钉住"同行保留先到的"这条口径在
 * 拼接后没有漂移（窗口外的重叠与窗口内的重叠必须用同一把尺子）。
 */

import { describe, expect, it } from 'vitest';
import type { EditorSemanticTokenSpan } from '@kojo/plugin-api';
import { encodeTokenSpans, spliceTokenSpans, type SemanticTokensEdit } from '../src/monaco/kojo-semantic-tokens';

/** 一行文本 → 这一行的 span（同一行两条重叠：第一条保留、第二条被编码丢掉） */
function spansOfLine(line: number, text: string): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  if (text.length >= 3) out.push({ line, startColumn: 1, endColumn: 4, tokenType: 'function' });
  if (text.length >= 6) out.push({ line, startColumn: 3, endColumn: 6, tokenType: 'variable', modifiers: ['declaration'] });
  if (text.length >= 12) out.push({ line, startColumn: 8, endColumn: 10, tokenType: 'parameter' });
  return out;
}

function spansOfAll(lines: readonly string[]): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  for (let i = 0; i < lines.length; i++) out.push(...spansOfLine(i + 1, lines[i]!));
  return out;
}

/** Monaco `_setDocumentSemanticTokens` 的 edits 套用（从后往前 + `srcLastStart` 往前追） */
function applyEdits(src: Uint32Array, edits: readonly SemanticTokensEdit[]): Uint32Array {
  let deltaLength = 0;
  for (const edit of edits) deltaLength += (edit.data ? edit.data.length : 0) - edit.deleteCount;
  const dest = new Uint32Array(src.length + deltaLength);
  let srcLastStart = src.length;
  let destLastStart = dest.length;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!;
    if (edit.start > src.length) throw new Error(`edit.start ${edit.start} 越界（src ${src.length}）`);
    const copyCount = srcLastStart - (edit.start + edit.deleteCount);
    if (copyCount > 0) {
      dest.set(src.subarray(srcLastStart - copyCount, srcLastStart), destLastStart - copyCount);
      destLastStart -= copyCount;
    }
    if (edit.data) {
      dest.set(edit.data, destLastStart - edit.data.length);
      destLastStart -= edit.data.length;
    }
    srcLastStart = edit.start;
  }
  if (srcLastStart > 0) dest.set(src.subarray(0, srcLastStart), 0);
  return dest;
}

/** 定长 LCG（不引入随机源：失败必须能原样复现） */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = ['A', 'B', 'C', 'あ', 'い', ';', '#', '@', ' ', 'X'];
function randomLine(next: () => number): string {
  const length = Math.floor(next() * 16);
  let text = '';
  for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(next() * ALPHABET.length)]!;
  return text;
}

/**
 * 一次随机编辑 + 它对应的窗口（**与宿主会话层同一条夹取口径**：
 * 窗口末行 = 旧末行 + 净行位移（整行删除时会落到起点之前，夹到起点），起点再夹到末行）。
 */
function randomEdit(
  next: () => number,
  lines: readonly string[],
): { at: number; removed: number; added: string[]; window: { from: number; to: number }; lineDelta: number } {
  const at = 1 + Math.floor(next() * lines.length);
  const span = 1 + Math.floor(next() * 3);
  const removed = Math.min(span, lines.length - at + 1);
  let count = Math.floor(next() * 4);
  if (lines.length - removed + count < 1) count = removed; // 不许把文档删空
  const added: string[] = [];
  for (let i = 0; i < count; i++) added.push(randomLine(next));
  const lineDelta = added.length - removed;
  const lineCount = lines.length + lineDelta;
  const oldTo = at + removed - 1;
  const to = Math.min(Math.max(1, oldTo + lineDelta), lineCount);
  const from = Math.max(1, Math.min(at, to));
  return { at, removed, added, window: { from, to }, lineDelta };
}

function spliceLines(lines: readonly string[], at: number, removed: number, added: readonly string[]): string[] {
  return [...lines.slice(0, at - 1), ...added, ...lines.slice(at - 1 + removed)];
}

describe('语义着色增量 · 与整篇重算逐字节相等', () => {
  for (const seed of [1, 7, 20_261_028]) {
    it(`100 步随机编辑（seed ${seed}）`, () => {
      const next = rng(seed);
      let lines: string[] = [];
      for (let i = 0; i < 12; i++) lines.push(randomLine(next));

      let baseline = encodeTokenSpans(spansOfAll(lines));
      let monacoData = baseline.data;
      let steps = 0;

      for (let step = 0; step < 100; step++) {
        const edit = randomEdit(next, lines);
        const nextLines = spliceLines(lines, edit.at, edit.removed, edit.added);
        const expected = encodeTokenSpans(spansOfAll(nextLines));

        // 窗口里那些行（新坐标）；空窗口也要能走
        const windowSpans = expected.spans.filter(
          (s) => s.line >= edit.window.from && s.line <= edit.window.to,
        );
        const spliced = spliceTokenSpans(baseline, edit.window, windowSpans, edit.lineDelta);

        monacoData = applyEdits(monacoData, spliced.edits);
        expect(Array.from(monacoData), `step ${step}：edits 累积结果`).toEqual(Array.from(expected.data));
        expect(Array.from(spliced.tokens.data), `step ${step}：拼接交回的基线`).toEqual(Array.from(expected.data));
        expect(spliced.tokens.spans, `step ${step}：基线 span 序列`).toEqual(expected.spans);

        baseline = spliced.tokens;
        lines = nextLines;
        steps++;
      }
      expect(steps).toBe(100);
    });
  }

  it('把文末整行删掉（窗口被夹到上一行）也不炸', () => {
    const before = ['AAA', 'BBBBBB', 'CCCCCCCCCCCC'];
    const after = ['AAA', 'BBBBBB'];
    const window = { from: 2, to: 2 };
    const windowSpans = spansOfAll(after).filter((s) => s.line >= 2 && s.line <= 2);
    const spliced = spliceTokenSpans(encodeTokenSpans(spansOfAll(before)), window, windowSpans, -1);
    const expected = encodeTokenSpans(spansOfAll(after));
    expect(Array.from(applyEdits(encodeTokenSpans(spansOfAll(before)).data, spliced.edits))).toEqual(
      Array.from(expected.data),
    );
    expect(Array.from(spliced.tokens.data)).toEqual(Array.from(expected.data));
  });

  it('窗口内一条都不剩（整行清空）⇒ 该删的删干净', () => {
    const before = ['AAA'];
    const after = [''];
    const spliced = spliceTokenSpans(encodeTokenSpans(spansOfAll(before)), { from: 1, to: 1 }, [], 0);
    const expected = encodeTokenSpans(spansOfAll(after));
    expect(expected.data.length).toBe(0);
    expect(Array.from(applyEdits(encodeTokenSpans(spansOfAll(before)).data, spliced.edits))).toEqual([]);
    expect(Array.from(spliced.tokens.data)).toEqual([]);
    expect(spliced.tokens.spans).toEqual([]);
  });

  it('窗口把前面删空 ⇒ 后面那条变成数据的头，`deltaLine`/`deltaStart` 都要改回绝对 0 基', () => {
    const before = ['', 'AAA', 'BBB'];
    const after = ['', '', 'BBB'];
    const window = { from: 2, to: 2 };
    const baseline = encodeTokenSpans(spansOfAll(before));
    // 旧数据里 `BBB` 那条是相对第 2 行的（deltaLine=1）；第 2 行清空后它必须是绝对的 3-1=2
    expect(Array.from(baseline.data.slice(5, 7))).toEqual([1, 0]);
    const spliced = spliceTokenSpans(baseline, window, [], 0);
    const expected = encodeTokenSpans(spansOfAll(after));
    expect(Array.from(expected.data.slice(0, 2))).toEqual([2, 0]);
    expect(Array.from(applyEdits(baseline.data, spliced.edits))).toEqual(Array.from(expected.data));
    expect(Array.from(spliced.tokens.data)).toEqual(Array.from(expected.data));
  });

  it('没有变更（窗口 span 与旧的一致、位移为 0）⇒ 一条 edits 且结果不变', () => {
    const lines = ['AAA', 'BBBBBB', 'CCCCCCCCCCCC'];
    const baseline = encodeTokenSpans(spansOfAll(lines));
    const spliced = spliceTokenSpans(baseline, { from: 2, to: 2 }, spansOfAll(lines).filter((s) => s.line === 2), 0);
    expect(Array.from(applyEdits(baseline.data, spliced.edits))).toEqual(Array.from(baseline.data));
    expect(Array.from(spliced.tokens.data)).toEqual(Array.from(baseline.data));
  });
});
