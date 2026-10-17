/**
 * 视口化的**行高实测**契约（PS-7 正确性修复；零 React，判据全在 matrix-logic 的纯函数）。
 *
 * 钉的是什么：面板的窗口起点、占位块高度、CSS 变量 `--cm-row-h`、键盘跨窗跳转
 * 四处**必须共用同一个行高**，而且那个行高是量出来的，不是 `MATRIX_ROW_H` 那个 22。
 *
 * 为什么必须有这条测试：应用有字号 / 缩放偏好，行高会偏离 22px（这里用 26px 建模）。
 * 按 22 算窗口 ⇒ 滚到第 137 行、画出来的是第 153 行，`data-r` 与真实落点彻底对不上
 * （方向键、光标跟随、滚动条长度一起漂）。下面的"浏览器几何模型"就是这一记错位。
 *
 * 合成数据：3,000 行（真实语料里 K49 的状态键就是这个量级），零游戏知识。
 */

import { describe, expect, it } from 'vitest';
import {
  MATRIX_OVERSCAN,
  MATRIX_ROW_H,
  ROW_H_MAX,
  ROW_H_MIN,
  computeViewportWindow,
  firstVisibleRow,
  planMatrixWindow,
  resolveRowHeight,
  rowHeightChanged,
  rowScrollTop,
  rowTopOf,
} from '../src/matrix-logic';
import type { MatrixLayout } from '../src/matrix-logic';

/* ------------------------------ 浏览器几何模型 ------------------------------ */

/**
 * 把"面板算出来的窗口 + CSS 实际排出来的行"合到一张假 DOM 上：
 *
 * - 行的**实际**高 = max(内容固有高, `--cm-row-h`)（`.cm-virt` 里 `tr{height:var(--cm-row-h)}`
 *   是下限，内容更高时行照样被撑开——这正是字号偏好的作用方式）；
 * - 面板交给 CSS 的那个值就是 `layout.rowHeight`（实测收敛后的同一个数）；
 * - 第 `i` 行在滚动内容里的顶边 = `topPad + (i - start) * 实际行高`。
 *
 * 于是"滚到哪、画哪行"可判：视口顶边落在 `scrollTop`，那里应该是第
 * `floor(scrollTop / 实际行高)` 行。
 */
interface FakeDom {
  /** 实际排出来的行高 */
  readonly actualRowH: number;
  /** 视口顶边所在的数据行索引 */
  readonly topIndex: number;
  /** 该索引是否真的被渲染出来（在窗口内 = 有节点、有 data-r） */
  readonly rendered: boolean;
  /** 第 `index` 行的实际顶边（px） */
  offsetOf(index: number): number;
}

function fakeDom(layout: MatrixLayout, intrinsicRowH: number, scrollTop: number, viewportH: number): FakeDom {
  const actualRowH = Math.max(intrinsicRowH, layout.rowHeight);
  const topIndex = firstVisibleRow(scrollTop, actualRowH);
  const offsetOf = (index: number): number => layout.win.topPad + (index - layout.win.start) * actualRowH;
  return {
    actualRowH,
    topIndex,
    rendered: topIndex >= layout.win.start && topIndex < layout.win.end,
    offsetOf,
  };
}

/* ------------------------------ 实测行高收敛 ------------------------------ */

describe('resolveRowHeight（实测值收敛成可用的尺）', () => {
  it('量到就用：非默认字号的 26px 不会被 22 顶掉', () => {
    expect(resolveRowHeight(26)).toBe(26);
    expect(resolveRowHeight(19.5)).toBe(19.5); // 半像素照收（取整就是把漂移请回来）
  });

  it('没量到 / 量坏了 → 回退兜底常量（宁可不准，也不炸）', () => {
    expect(resolveRowHeight(null)).toBe(MATRIX_ROW_H);
    expect(resolveRowHeight(undefined)).toBe(MATRIX_ROW_H);
    expect(resolveRowHeight(Number.NaN)).toBe(MATRIX_ROW_H);
    expect(resolveRowHeight(0)).toBe(MATRIX_ROW_H); // 面板被隐藏时量到 0
    expect(resolveRowHeight(-4)).toBe(MATRIX_ROW_H);
    expect(resolveRowHeight(ROW_H_MIN - 1)).toBe(MATRIX_ROW_H);
  });

  it('量到的不是一行（整块 / tbody）→ 钳到上限', () => {
    expect(resolveRowHeight(99_999)).toBe(ROW_H_MAX);
    expect(resolveRowHeight(Infinity)).toBe(MATRIX_ROW_H);
  });

  it('允许调用方自带兜底（全量路径没有窗口数学，不参与）', () => {
    expect(resolveRowHeight(null, 30)).toBe(30);
  });
});

describe('rowHeightChanged（0.5px 阈值：亚像素抖动不惊动全表）', () => {
  it('首帧（null）一定算变化', () => {
    expect(rowHeightChanged(null, 22)).toBe(true);
  });
  it('整档变化算变化、抖动不算', () => {
    expect(rowHeightChanged(22, 26)).toBe(true);
    expect(rowHeightChanged(22, 22.3)).toBe(false);
    expect(rowHeightChanged(22, 22)).toBe(false);
  });
});

/* ------------------------------ 面板契约：滚到哪行就画哪行 ------------------------------ */

describe('planMatrixWindow · 视口化行内容与 data-r 对齐（非默认字号）', () => {
  const ROWS = 3000;
  /** 字号 / 缩放偏好把行从 22 撑到 26（实测值的建模） */
  const MEASURED = 26;
  const VIEWPORT_H = 400;

  it('滚到第 137 行顶上：那一行必须在渲染窗口里，且占位与真实行同尺', () => {
    const scrollTop = MEASURED * 137; // 视口顶边正好压在第 137 行的上沿
    const layout = planMatrixWindow(scrollTop, VIEWPORT_H, ROWS, MEASURED);
    const dom = fakeDom(layout, MEASURED, scrollTop, VIEWPORT_H);

    expect(dom.actualRowH).toBe(MEASURED);
    expect(dom.topIndex).toBe(137);
    // 这一条就是"改前会红"的断言：按 22 算窗口时 137 落在窗口之外
    expect(dom.rendered).toBe(true);
    // 该行在 DOM 里的实际顶边必须等于它的数据位置（否则 data-r 与内容错位）
    expect(dom.offsetOf(dom.topIndex)).toBe(137 * MEASURED);
  });

  it('每一行的落点 = 索引 × 实测行高（不是索引 × 22）', () => {
    for (const scrollTop of [0, 26 * 7, 26 * 137, 26 * 1000, 26 * (ROWS - 3)]) {
      const layout = planMatrixWindow(scrollTop, VIEWPORT_H, ROWS, MEASURED);
      expect(layout.rowHeight).toBe(MEASURED);
      expect(layout.win.topPad).toBe(layout.win.start * MEASURED);
      for (let i = layout.win.start; i < layout.win.end; i++) {
        expect(rowTopOf(layout, i)).toBe(i * MEASURED);
      }
    }
  });

  it('逐行滚动一整趟：顶行始终可被渲染（无"滚到了却没画"的空洞）', () => {
    const layout = planMatrixWindow(0, VIEWPORT_H, ROWS, MEASURED);
    for (let index = 0; index < ROWS; index += 17) {
      const win = planMatrixWindow(index * MEASURED, VIEWPORT_H, ROWS, MEASURED).win;
      expect(index >= win.start && index < win.end).toBe(true);
    }
    // 末行：底部占位归零，不会滚出一个空窗口
    const tail = planMatrixWindow((ROWS - 1) * MEASURED, VIEWPORT_H, ROWS, MEASURED).win;
    expect(tail.end).toBe(ROWS);
    expect(tail.bottomPad).toBe(0);
    expect(layout.rowHeight).toBe(MEASURED);
  });

  it('量不到才回退：兜底路径逐字等于改动前的算式', () => {
    const scrollTop = MATRIX_ROW_H * 200;
    const fallback = planMatrixWindow(scrollTop, VIEWPORT_H, ROWS, null);
    const legacy = computeViewportWindow(scrollTop, VIEWPORT_H, MATRIX_ROW_H, ROWS, MATRIX_OVERSCAN);
    expect(fallback.rowHeight).toBe(MATRIX_ROW_H);
    expect(fallback.win).toEqual(legacy);
  });

  it('旧口径（常量 22 + 真实行 26）确实会错位——把这条漂移钉成反面证据', () => {
    const scrollTop = MEASURED * 137;
    // 改前面板就是这么调的：行高传常量，CSS 也写常量，浏览器按 26 排行
    const stale = computeViewportWindow(scrollTop, VIEWPORT_H, MATRIX_ROW_H, ROWS, MATRIX_OVERSCAN);
    const staleDom = fakeDom({ win: stale, rowHeight: MATRIX_ROW_H }, MEASURED, scrollTop, VIEWPORT_H);
    expect(staleDom.topIndex).toBe(137);
    expect(staleDom.rendered).toBe(false); // 滚到 137，画的是 153 起
    expect(staleDom.offsetOf(stale.start)).not.toBe(stale.start * MEASURED);
  });

  it('键盘跨窗跳转按同一把尺落点（行高实测后不许再乘 22）', () => {
    const layout = planMatrixWindow(0, VIEWPORT_H, ROWS, MEASURED);
    expect(rowScrollTop(layout, 0)).toBe(0);
    expect(rowScrollTop(layout, 137)).toBe(3562);
    expect(rowScrollTop(layout, 137)).not.toBe(137 * MATRIX_ROW_H);
  });

  it('DOM 行数上界：3,000 行的表只挂视口 + 上下缓冲（旧全量路径 3,000 行、上限路径 400 行）', () => {
    const layout = planMatrixWindow(MEASURED * 137, VIEWPORT_H, ROWS, MEASURED);
    const renderedRows = layout.win.end - layout.win.start;
    const bound = Math.ceil(VIEWPORT_H / MEASURED) + 2 * MATRIX_OVERSCAN;
    expect(renderedRows).toBeLessThanOrEqual(bound);
    expect(renderedRows).toBeLessThan(50);
  });
});
