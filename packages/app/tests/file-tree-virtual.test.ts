/**
 * 虚拟化窗口判据（WS-12）的单测。
 *
 * 钉三件事，件件都是"错了就会在屏上看见"的：
 * 1. 视口 → 行区间的二分（含 overscan、含"行顶不齐"的缝）；
 * 2. 裁完之后**总高度不变**（垫高 = 被裁行的真实像素，不是猜的行数 × 22）；
 * 3. 展开/收起之后锚点行的视口偏移不变（视口不跳）。
 *
 * WS-12 欠账批把第 2 条从"叶子块一层"扩到**三层裁点**（组 / 包 / 平铺 ERB）：
 * `sliceSpan` 是那条通用判据，`sliceBlock` 是它在叶子层的取样；下面那条真模型恒等式
 * 按渲染规则逐像素对账，是"组头与包头也被裁"之后 `scrollHeight` 不许动一分的唯一纯函数自证。
 */
import { describe, expect, it } from 'vitest';
import { GAP_GROUP_UL, GAP_NESTED_UL, TREE_ROW_H, buildKojoFlatTree, type FlatRow, type FlatTree, type GroupRange, type LeafBlock } from '../src/ui/file-tree-flat';
import type { Group } from '../src/ui/file-tree-types';
import {
  FALLBACK_VIEWPORT_H,
  VIRTUAL_OVERSCAN_ROWS,
  anchorScrollTop,
  cullSpacerPx,
  fullRange,
  isCulledSlice,
  scrollToShow,
  sliceBlock,
  sliceSpan,
  spacerStyle,
  visibleRange,
  type CutSpan,
  type VisibleRange,
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

describe('sliceSpan · 三层裁点（组 / 包 / 叶子）共用同一条不变量', () => {
  const rows = uniform(60);
  /** 一段"包"：包头起、ERB 末行止，外加那档 `ul.tree-files.nested` 的 2px 下边距 */
  const pkgSpan: CutSpan = { start: 10, end: 20, topPx: 10 * TREE_ROW_H, bottomPx: 10 * TREE_ROW_H + 10 * TREE_ROW_H + GAP_NESTED_UL };
  /** 块尾没有缝的一段（根散文件：直接挂在组的 ul 里） */
  const bareSpan: CutSpan = { start: 30, end: 36, topPx: 30 * TREE_ROW_H, bottomPx: 36 * TREE_ROW_H };

  /** 恒等式的左边：垫高 + **挂出来的那些行的真实高度**（含块尾缝） */
  const kept = (s: { leadPx: number; from: number; to: number; trailPx: number }, mountedRowPx: number): number =>
    s.leadPx + mountedRowPx + s.trailPx;

  it('块尾带缝的段：整块在视口之上 ⇒ 一条不挂、缝也一起垫（高度含 GAP，一行不漏不多）', () => {
    const s = sliceSpan(pkgSpan, rows, { start: 40, end: 50 });
    expect([s.from, s.to, s.trailPx]).toEqual([20, 20, 0]);
    expect(s.leadPx).toBe(10 * TREE_ROW_H + GAP_NESTED_UL);
    expect(isCulledSlice(s)).toBe(true);
    expect(cullSpacerPx(s)).toBe(pkgSpan.bottomPx - pkgSpan.topPx);
  });

  it('整块在视口之下 ⇒ 同理一行不挂，缝垫在尾部', () => {
    const s = sliceSpan(pkgSpan, rows, { start: 0, end: 5 });
    expect([s.from, s.to, s.leadPx]).toEqual([10, 10, 0]);
    expect(s.trailPx).toBe(10 * TREE_ROW_H + GAP_NESTED_UL);
    expect(isCulledSlice(s)).toBe(true);
  });

  it('窗口从段中间穿过 ⇒ 总高不变（缝归被裁侧还是挂载侧都不许丢）', () => {
    const s = sliceSpan(pkgSpan, rows, { start: 13, end: 17 });
    expect([s.from, s.to]).toEqual([13, 17]);
    expect(kept(s, (s.to - s.from) * TREE_ROW_H)).toBe(pkgSpan.bottomPx - pkgSpan.topPx);
    expect(isCulledSlice(s)).toBe(false);
  });

  it('块尾没有缝的段：恒等式照样一遍到底', () => {
    const above = sliceSpan(bareSpan, rows, { start: 40, end: 50 });
    expect(kept(above, 0)).toBe(6 * TREE_ROW_H);
    const cross = sliceSpan(bareSpan, rows, { start: 32, end: 34 });
    expect(kept(cross, (cross.to - cross.from) * TREE_ROW_H)).toBe(6 * TREE_ROW_H);
  });

  it('空段（0 行 / 0 高）⇒ 全零且**不算被裁**（没东西可画 ≠ 裁掉了，别给 0 高占位撒谎）', () => {
    const empty: CutSpan = { start: 12, end: 12, topPx: 12 * TREE_ROW_H, bottomPx: 12 * TREE_ROW_H };
    const s = sliceSpan(empty, rows, { start: 0, end: 60 });
    expect(s).toEqual({ from: 0, to: 0, leadPx: 0, trailPx: 0 });
    expect(isCulledSlice(s)).toBe(false);
  });

  it('摘一条不变量的自检：段高与"挂载 + 垫高"必须逐像素相等（缝被算两次就会露出空白）', () => {
    const ranges: Array<[number, number]> = [
      [0, 60],
      [5, 25],
      [12, 18],
      [21, 40],
      [55, 60],
    ];
    for (const [start, end] of ranges) {
      const s = sliceSpan(pkgSpan, rows, { start, end });
      const mountedPx = s.to > s.from ? rows[s.to - 1]!.top + TREE_ROW_H - rows[s.from]!.top : 0;
      expect(s.leadPx + mountedPx + s.trailPx).toBe(pkgSpan.bottomPx - pkgSpan.topPx);
    }
  });

  /**
   * **真行模型上的恒等式**（不是手搓的 span）：按"渲染侧会怎么画"把每组的高度合起来，
   * 对任何窗口位置都必须等于模型总高 ⇒ 这就是"裁行不许改变 `scrollHeight`"在三层裁点上的形状。
   *
   * 渲染侧的规则（与 `FileTree.tsx` 一一对应，DOM 侧另有 `file-tree-a11y-virtual.test.ts` 复验）：
   * - 整组在视口外 ⇒ **一条**占位 = 整组高度（连组头、子段、两级 `<ul>` 的缝一起替掉）；
   * - 组相交 ⇒ 组头与说明行各占 22px（挂按钮或挂等高占位，都是这一档）
   *   + 每个子段：整段被裁 ⇒ 一条占位 = 该段高度（含它自己那档 `<ul>` 缝，因为整个 `<li>` 没了）；
   *   子段相交 ⇒ 包头 22 + **叶子块按 `sliceBlock`（行底口径）裁** + 那档 2px 缝**仍由常驻的 `<ul>` 带**；
   * - 展开组的 `<ul>` 常驻 ⇒ 那档 4px 缝恒在。
   *
   * ⚠ 这里刻意分两种口径，而且这是本批最容易写错的一处：**整段被裁**才用含缝的 `span`，
   * **部分裁**必须用不含缝的行底（`sliceBlock`）——缝在部分裁时属于还挂在 DOM 里的那枚 `<ul>`，
   * 让占位再垫一遍就会每裁一段多两像素（表现为"滚动条越滚越长"）。
   */
  function renderedGroupPx(tree: FlatTree, groupIdx: number, range: VisibleRange): number {
    const g = tree.groups[groupIdx] as GroupRange;
    const rows = tree.rows;
    const gs = sliceSpan(g.span, rows, range);
    if (isCulledSlice(gs)) return cullSpacerPx(gs);
    const subRows = g.subs.reduce((n, s) => n + (s.span.end - s.span.start), 0);
    // 组头与说明行：每行恒占 22px（在窗口里挂按钮，不在挂等高占位）
    let px = (g.span.end - g.span.start - subRows) * TREE_ROW_H;
    if (g.open) px += GAP_GROUP_UL; // 展开组的 `<ul>` 常驻
    g.subs.forEach((sub, subIdx) => {
      const ss = sliceSpan(sub.span, rows, range);
      if (isCulledSlice(ss)) {
        px += cullSpacerPx(ss);
        return;
      }
      const leaf = tree.blockOf(groupIdx, subIdx);
      if (leaf !== undefined) {
        const sl = sliceBlock(leaf, rows, range);
        const mountedPx = sl.to > sl.from ? (rows[sl.to - 1] as FlatRow).top + TREE_ROW_H - (rows[sl.from] as FlatRow).top : 0;
        px += sl.leadPx + mountedPx + sl.trailPx;
      }
      if (sub.headerIdx >= 0) px += TREE_ROW_H + GAP_NESTED_UL; // 包头那一档 + 包 ERB 列表的缝
    });
    return px;
  }

  it('组与包的 span 拼起来恒等于模型总高：任何窗口位置都不改 scrollHeight', () => {
    const listOf = (n: number, dir: string): string[] => Array.from({ length: n }, (_, i) => `${dir}/M_KOJO_K1_${i}.ERB`);
    const mk = (label: string, prefix: string, pkg: string, n: number): Group => ({
      label,
      prefix,
      subs: [
        // 一组里同时带根散文件与作者包 ⇒ 两种子段（带缝 / 不带缝）都被这条账覆盖
        { label: null, files: listOf(2, prefix) },
        { label: pkg, files: listOf(n, `${prefix}/${pkg}`) },
      ],
      total: n + 2,
    });
    const tree = buildKojoFlatTree({
      groups: [
        { group: mk('#1 灵梦', 'C:/koa/001', '包A', 40), open: true, pkgFolderOpen: () => false },
        { group: mk('#2 妖梦', 'C:/koa/002', '包B', 3), open: true, pkgFolderOpen: () => false, note: '这一组还有一条说明行' },
        { group: mk('#3 魔理沙', 'C:/koa/003', '包C', 7), open: false, pkgFolderOpen: () => false },
      ],
      subOpen: new Set<string>(),
      dirCache: new Map(),
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    // 缝的总账（这条一红就说明"哪一层在计费"被改了）：两个展开包各 2px、两个展开组各 4px
    expect(tree.rows).toHaveLength(53);
    expect(tree.height).toBe(tree.rows.length * TREE_ROW_H + 2 * GAP_NESTED_UL + 2 * GAP_GROUP_UL);
    // ① 组与组无缝：下一组的顶 = 上一组的底，Σ 组高 = 模型总高
    for (let i = 1; i < tree.groups.length; i++) {
      expect(tree.groups[i]!.span.topPx).toBe(tree.groups[i - 1]!.span.bottomPx);
    }
    expect(tree.groups.reduce((n, g) => n + (g.span.bottomPx - g.span.topPx), 0)).toBe(tree.height);
    expect((tree.groups[tree.groups.length - 1] as GroupRange).span.bottomPx).toBe(tree.height);
    // ② 组内平铺：组头 + 说明行（各 22）+ Σ 子段高 + 组缝（展开才有）= 组 span
    for (const g of tree.groups) {
      const subRows = g.subs.reduce((n, s) => n + (s.span.end - s.span.start), 0);
      const outerPx = (g.span.end - g.span.start - subRows) * TREE_ROW_H;
      const subsPx = g.subs.reduce((n, s) => n + (s.span.bottomPx - s.span.topPx), 0);
      expect(outerPx + subsPx + (g.open ? GAP_GROUP_UL : 0)).toBe(g.span.bottomPx - g.span.topPx);
      // 子段之间也无缝（缝都长在段自己身上，不在段间另插一档）
      for (let i = 1; i < g.subs.length; i++) {
        expect(g.subs[i]!.span.topPx).toBe(g.subs[i - 1]!.span.bottomPx);
      }
    }
    // ③ 子段内平铺：包头 22 + 叶子行的真实高 + 包缝 2 = 子段 span（根散文件那段既无头也无缝）
    tree.groups.forEach((g, groupIdx) => {
      g.subs.forEach((sub, subIdx) => {
        const leaf = tree.blockOf(groupIdx, subIdx);
        const isPkg = sub.headerIdx >= 0;
        if (isPkg) expect(sub.headerIdx).toBe(sub.span.start);
        if (leaf === undefined) {
          expect(sub.span.bottomPx - sub.span.topPx).toBe((isPkg ? TREE_ROW_H + GAP_NESTED_UL : 0));
          return;
        }
        if (isPkg) expect(leaf.start).toBe(sub.headerIdx + 1); // 本夹具没点开真实文件夹 ⇒ 中间没有目录行
        const leafPx = (tree.rows[leaf.end - 1] as FlatRow).top + TREE_ROW_H - (tree.rows[leaf.start] as FlatRow).top;
        expect((isPkg ? TREE_ROW_H + GAP_NESTED_UL : 0) + leafPx).toBe(sub.span.bottomPx - sub.span.topPx);
      });
    });
    // ④ 任何窗口位置：按渲染规则合起来 = 模型总高（裁行只换 DOM，不改滚动高度）
    for (const scrollTop of [0, 26, 220, 484, 900, 1_600, 3_000, tree.height]) {
      const range = visibleRange(tree.rows, scrollTop, 220, 0);
      expect(tree.groups.reduce((n, _g, gi) => n + renderedGroupPx(tree, gi, range), 0)).toBe(tree.height);
      // fullRange（文件系统视图那一档）⇒ 一行都不裁，每组都按真实结构挂
      expect(tree.groups.reduce((n, _g, gi) => n + renderedGroupPx(tree, gi, fullRange(tree.rows.length)), 0)).toBe(tree.height);
    }
    // ⑤ 深滚时确实有整组被裁（不然上面那串恒等式是空断言）
    const deep = visibleRange(tree.rows, 900, 220, 0);
    const culledGroups = tree.groups.filter((g) => isCulledSlice(sliceSpan(g.span, tree.rows, deep))).length;
    expect(culledGroups).toBeGreaterThan(0);
    expect(culledGroups).toBeLessThan(tree.groups.length);
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
