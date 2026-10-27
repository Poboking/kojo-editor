/**
 * 虚拟化窗口判据（WS-12）的单测。
 *
 * 钉三件事，件件都是"错了就会在屏上看见"的：
 * 1. 视口 → 行区间的二分（含 overscan、含"行顶不齐"的缝）；
 * 2. 裁完之后**总高度不变**（垫高 = 被裁行的真实像素，不是猜的行数 × 22）；
 * 3. 展开/收起之后锚点行的视口偏移不变（视口不跳）。
 */
import { describe, expect, it } from 'vitest';
import { TREE_ROW_H, type FlatRow, type LeafBlock } from '../src/ui/file-tree-flat';
import {
  FALLBACK_VIEWPORT_H,
  VIRTUAL_OVERSCAN_ROWS,
  anchorScrollTop,
  fullRange,
  scrollToShow,
  sliceBlock,
  spacerStyle,
  visibleRange,
} from '../src/ui/file-tree-virtual';

/** 造一串行：`tops` 是每行的像素顶部（缝用跳变的步长模拟，不假设处处等距） */
function rowsOf(tops: number[]): FlatRow[] {
  return tops.map((top, i) => ({
    id: `r${i}`,
    kind: 'file',
    level: 2,
    top,
    path: `C:/f${i}.ERB`,
    label: `f${i}`,
    leaf: true,
    selectable: true,
    expandable: false,
    open: false,
    parentIdx: 0,
    childIdx: -1,
  })) as FlatRow[];
}

const uniform = (n: number): FlatRow[] => rowsOf(Array.from({ length: n }, (_, i) => i * TREE_ROW_H));

describe('visibleRange · 视口 → 行区间', () => {
  const rows = uniform(1000);

  it('顶部对齐时首行就是视口第一行；overscan 让区间两头各宽出若干行', () => {
    const r = visibleRange(rows, 0, 220, 2);
    expect(r.start).toBe(0);
    expect(r.end).toBe(10 + 2); // 220px = 10 行 + overscan
  });

  it('滚到中途：区间覆盖 [scrollTop, scrollTop+视口) 那几行（含压边的上半行）', () => {
    const r = visibleRange(rows, 500, 220, 0);
    expect(rows[r.start]!.top).toBeLessThanOrEqual(500);
    expect(rows[r.start]!.top).toBeGreaterThanOrEqual(478); // 499 那一行的上半截还在视口里
    expect(rows[r.end - 1]!.top + TREE_ROW_H).toBeGreaterThanOrEqual(720);
  });

  it('端点夹进数组：滚到底、overscan 再大也不会越界', () => {
    const r = visibleRange(rows, 999 * TREE_ROW_H, 10_000, 50);
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBe(1000);
  });

  it('行顶带缝时按**真实位置**二分，而不是"第 n 行 = n × 22"', () => {
    // 每 10 行插一档 4px 的组间缝 ⇒ 第 100 行的真实顶部已经比 100×22 高出 40px
    const tops: number[] = [];
    let y = 0;
    for (let i = 0; i < 200; i++) {
      tops.push(y);
      y += TREE_ROW_H + (i % 10 === 9 ? 4 : 0);
    }
    const gapped = rowsOf(tops);
    // 按"第 n 行 = n × 22"推会取到第 98 行（tops[100] = 2,240 ≠ 100 × 22）——那才是错的
    const naive = visibleRange(gapped, 100 * TREE_ROW_H, 22, 0);
    const r = visibleRange(gapped, tops[100]!, 22, 0);
    expect(r.start).toBe(100);
    expect(r.end).toBe(101); // 视口只有 22px：正好盖住第 100 行
    expect(naive.start).not.toBe(100);
  });

  it('空行集 ⇒ 空区间（不报错、也不给"第 0 行"这种假行号）', () => {
    expect(visibleRange([], 0, 600)).toEqual({ start: 0, end: 0 });
  });

  it('容器高度量不出来时走兜底档（SSR / 无头 DOM 的第一帧不能整棵挂载）', () => {
    const r = visibleRange(rows, 0, 0);
    expect(r.end).toBe(Math.ceil(FALLBACK_VIEWPORT_H / TREE_ROW_H) + VIRTUAL_OVERSCAN_ROWS);
  });

  it('fullRange = 整段都挂（文件系统视图用的那一档）', () => {
    expect(fullRange(37)).toEqual({ start: 0, end: 37 });
  });
});

describe('sliceBlock · 裁行必须保住整块高度', () => {
  const rows = uniform(50);
  const block: LeafBlock = { start: 10, end: 20, groupIdx: 0, subIdx: 0, scatter: false, pkgKey: 'g::p' };

  const kept = (s: { leadPx: number; from: number; to: number; trailPx: number }): number =>
    s.leadPx + (s.to - s.from) * TREE_ROW_H + s.trailPx;

  it('整块在视口之上 ⇒ 一行不挂、全部垫高（挂在头部）', () => {
    const s = sliceBlock(block, rows, { start: 30, end: 40 });
    expect(s.from).toBe(s.to);
    expect(s.leadPx).toBe(10 * TREE_ROW_H);
    expect(s.trailPx).toBe(0);
    expect(kept(s)).toBe(10 * TREE_ROW_H);
  });

  it('整块在视口之下 ⇒ 同样一行不挂（垫在尾部）', () => {
    const s = sliceBlock(block, rows, { start: 0, end: 5 });
    expect(s.to).toBe(s.from);
    expect(s.trailPx).toBe(10 * TREE_ROW_H);
    expect(kept(s)).toBe(10 * TREE_ROW_H);
  });

  it('窗口从块中间穿过 ⇒ 只挂交叠的行，前后各垫一段，总高不变', () => {
    const s = sliceBlock(block, rows, { start: 13, end: 17 });
    expect([s.from, s.to]).toEqual([13, 17]);
    expect(s.leadPx).toBe(3 * TREE_ROW_H);
    expect(s.trailPx).toBe(3 * TREE_ROW_H);
    expect(kept(s)).toBe(10 * TREE_ROW_H);
  });

  it('空块（0 行）⇒ 全零，不渲染占位也不撒谎说垫了高', () => {
    const empty: LeafBlock = { ...block, start: 12, end: 12 };
    expect(sliceBlock(empty, rows, { start: 0, end: 50 })).toEqual({ from: 0, to: 0, leadPx: 0, trailPx: 0 });
  });

  it('0 高不落 style（垫高行由组件按 null 跳过）', () => {
    expect(spacerStyle(0)).toBeNull();
    expect(spacerStyle(44)).toEqual({ height: '44px' });
  });
});

describe('锚点与"滚到刚好可见"', () => {
  it('展开上一组之后，锚点行的视口偏移保持不变', () => {
    // 锚点原在第 10 行（220px）、视口 scrollTop=500 ⇒ 它在视口内 220-500 = -280 ……
    // 换成能直观读的例子：锚点从 220px 被推到 1100px（上面插了 40 行）
    expect(anchorScrollTop(220, 1100, 0, 99_999)).toBe(880);
    // 夹进内容范围：不许滚出最大可滚位
    expect(anchorScrollTop(220, 1100, 0, 300)).toBe(300);
    // 上面收起 ⇒ 负 delta 也不许把 scrollTop 压成负数
    expect(anchorScrollTop(1100, 220, 300, 99_999)).toBe(0);
  });

  it('焦点行在视口上方 ⇒ 滚到它贴住上沿；在下方 ⇒ 贴住下沿；本来可见 ⇒ 一动不动', () => {
    expect(scrollToShow(0, 500, 220, 99_999)).toBe(0);
    expect(scrollToShow(1000, 0, 220, 99_999)).toBe(1000 + TREE_ROW_H - 220);
    expect(scrollToShow(500, 400, 220, 99_999)).toBe(400);
    expect(scrollToShow(900, 0, 220, 500)).toBe(500); // 最大可滚位夹住
  });
});
