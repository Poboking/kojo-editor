import { describe, expect, it } from 'vitest';
import { sugarSummary } from '../src/ui/sugar-view';
import {
  foldKey,
  foldLabel,
  hiddenLineCount,
  hiddenRanges,
  skeletonLabel,
  skeletonSegments,
  toggleFolded,
  type FoldableSegment,
} from '../src/ui/sugar-fold';

/**
 * 糖视图折叠/展开的算术单测（2026-10-13 UI 反馈 5）。
 *
 * 背景：用户报"展开被折叠的原文失效"，读代码的结论是**那个控件从来没实现过**——
 * 投影把原文整批 `setHiddenAreas` 藏掉，段区 `<pre>` 没有任何监听器，
 * `lineCount === 0` 的骨架段更是连一处痕迹都不留（对读者静默删码）。
 * 这里钉的是 ADR-0006 的三条硬口径：收起 ≠ 删除、折叠处要有可读占位、折叠数必须可见。
 */

function seg(fromLine: number, toLine: number, lineCount: number): FoldableSegment {
  return { key: foldKey(fromLine, toLine), fromLine, toLine, lineCount };
}

const SEGMENTS = [seg(10, 12, 3), seg(30, 41, 0), seg(50, 52, 2)];

describe('隐藏区间', () => {
  it('全部折叠 ⇒ 每段一个闭区间，行号原样交出（宿主据此构造 Range）', () => {
    expect(hiddenRanges(SEGMENTS, new Set())).toEqual([
      { fromLine: 10, toLine: 12 },
      { fromLine: 30, toLine: 41 },
      { fromLine: 50, toLine: 52 },
    ]);
  });

  it('展开一段 ⇒ 该段**整段**退出隐藏，绝不半隐藏（半隐藏等于给读者看断头代码）', () => {
    const expanded = new Set([foldKey(30, 41)]);
    expect(hiddenRanges(SEGMENTS, expanded)).toEqual([
      { fromLine: 10, toLine: 12 },
      { fromLine: 50, toLine: 52 },
    ]);
  });

  it('全部展开 ⇒ 空列表（宿主据此清空 hidden areas，原文一行不差地在那里）', () => {
    const all = new Set(SEGMENTS.map((s) => s.key));
    expect(hiddenRanges(SEGMENTS, all)).toEqual([]);
  });

  it('未知键不产生任何效果（视图状态与投影批次不同步时不崩）', () => {
    expect(hiddenRanges(SEGMENTS, new Set(['999:999']))).toHaveLength(3);
  });
});

describe('展开态切换', () => {
  it('不可变：入参集合不被就地修改（ViewZone 批次里到处引用同一份状态）', () => {
    const before = new Set<string>();
    const next = toggleFolded(before, 'a');
    expect(before.size).toBe(0);
    expect(next.has('a')).toBe(true);
  });

  it('来回切换回到空集合（展开→收起是可逆的视图状态，不落盘不进撤销栈）', () => {
    const once = toggleFolded(new Set(), 'a');
    expect(toggleFolded(once, 'a').size).toBe(0);
  });

  it('多段各自独立：展开 A 不影响 B', () => {
    const s = toggleFolded(toggleFolded(new Set(), 'a'), 'b');
    expect([...s].sort()).toEqual(['a', 'b']);
    expect(toggleFolded(s, 'a').has('b')).toBe(true);
    expect(toggleFolded(s, 'a').has('a')).toBe(false);
  });
});

describe('折叠数可见（ADR-0006 §4「不静默」）', () => {
  it('行数按原文跨度计，包含只藏不显的骨架段', () => {
    expect(hiddenLineCount(SEGMENTS, new Set())).toBe(3 + 12 + 3);
  });

  it('展开的段不再计入——读数必须随视图状态变，否则"已收起 N 行"会骗人', () => {
    expect(hiddenLineCount(SEGMENTS, new Set([foldKey(30, 41)]))).toBe(3 + 3);
  });

  it('全展开 ⇒ 0，且摘要里不再出现「已收起」半句（0 时不提，别留个假承诺）', () => {
    const all = new Set(SEGMENTS.map((s) => s.key));
    expect(hiddenLineCount(SEGMENTS, all)).toBe(0);
    expect(sugarSummary(80, 0)).toBe('语法糖 80 行');
    expect(sugarSummary(80, 12)).toBe('语法糖 80 行｜已收起 12 行（可展开）');
  });
});

describe('占位与柄文案', () => {
  it('骨架段（lineCount=0）必须被挑出来——它们没有糖文本，不给占位就是静默删码', () => {
    expect(skeletonSegments(SEGMENTS).map((s) => s.fromLine)).toEqual([30]);
  });

  it('柄文案给出行数，且展开后翻成反向动作', () => {
    const s = SEGMENTS[0]!;
    expect(foldLabel(s, false)).toBe('展开原文（3 行）');
    expect(foldLabel(s, true)).toBe('收起原文（3 行）');
  });

  it('占位行文案自解释「此处 N 行代码已收起」，不写成缩写或符号', () => {
    const sk = SEGMENTS[1]!;
    expect(skeletonLabel(sk, false)).toBe('此处 12 行代码已收起 · 点击展开');
    expect(skeletonLabel(sk, true)).toBe('收起这段代码（12 行）');
  });

  it('段键由位置构成：同位置同键、改位置即换键（视图状态不会张冠李戴）', () => {
    expect(foldKey(12, 20)).toBe('12:20');
    expect(foldKey(12, 21)).not.toBe(foldKey(12, 20));
  });
});
