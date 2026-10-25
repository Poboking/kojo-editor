/**
 * 问题列表的**虚拟化**判据（1025 性能批 A 线，2026-10-25）。
 *
 * 上一版（条目预算 + 哨兵分页 + rIC 分片）留下的读数：滚动 / 连点仍慢
 * （哨兵连点 52.4 / 89.7 / 109.3ms，长任务 0/2/3），基数越大越慢
 * （59 行 31.5ms → 296 行 99ms → 648 行 100–160ms），perf 报 `scriptMs 0 / renderMs 159`
 * ⇒ 钱付在布局上。本批改成真窗口（DOM 与总诊断数解耦）：只挂视口内的行 + overscan，
 * 两侧用留白顶起滚动高度。模板照检索面板（`search-rows` / `SearchPanel`），几何不另发明。
 *
 * 本文件钉五件事（都是**可数的量**，零墙钟断言 ⇒ 功能池）：
 *   ① 行高账本：两档行高（组头 / 问题行）逐行累加，总高 = 全量行高之和；
 *   ② 窗口切片：`topPad + 窗口内行高 + bottomPad === total`、窗口必覆盖可见区间、
 *      窗口长度有上界（DOM 不随总诊断数长）；
 *   ③ 面板真产出的 DOM：2,633 条 ⇒ 首帧只挂 `PROBLEM_VROWS_FALLBACK` 条，且挂载行的
 *      `data-prob-index` 连续、内容 = 清单同下标那一行（串位就红）；
 *   ④ 折叠在**投影层**就减行（行高账本不许给折叠掉的行留空白）；
 *   ⑤ 行导航的序号腿：`problemOrdinalMap` 把"第几条问题"贴到扁平行上（组头 −1）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProblemPanel, PROBLEM_VROWS_FALLBACK } from '../src/ui/ProblemPanel';
import {
  PROBLEM_ROW_HEIGHTS_FALLBACK,
  problemItemRowIndex,
  problemOrdinalMap,
  problemRowOffsets,
  problemRowWindow,
  problemRowsOf,
  sameProblemRowWindow,
  type ProblemRow,
  type ProblemRowHeights,
} from '../src/ui/problem-rows';
import { groupProblems, type ProblemGroup } from '../src/ui/problem-filter';
import { clearAllProblems, setProblems, snapshot, type EditorProblem } from '../src/ui/problem-store';

/** 真语料全项目校验的实际规模（eratw 口上语料：62 个文件 / 2,633 条） */
const FILE_COUNT = 62;
const PROBLEM_COUNT = 2_633;
/** 两档行高取真机实测值（组头 25 / 问题行 22 @12px），布局无关，纯算 */
const H: ProblemRowHeights = PROBLEM_ROW_HEIGHTS_FALLBACK;

function corpusProblems(): EditorProblem[] {
  const out: EditorProblem[] = [];
  for (let f = 0; f < FILE_COUNT; f += 1) {
    const path = `C:/game/ERB/口上/001/M_KOJO_K${f + 1}.ERB`;
    const per = Math.floor(PROBLEM_COUNT / FILE_COUNT) + (f < PROBLEM_COUNT % FILE_COUNT ? 1 : 0);
    for (let i = 0; i < per; i += 1) {
      out.push({
        path,
        line: i + 1,
        severity: (['error', 'warning', 'info'] as const)[i % 3]!,
        message: `第 ${i} 条问题：结构不闭合`,
      });
    }
  }
  return out;
}

const corpusGroups = (): ProblemGroup[] => groupProblems(corpusProblems());
const corpusRows = (): ProblemRow[] => problemRowsOf(corpusGroups());

/** 窗口内行的总高（按同一份行高账本算） */
const windowHeight = (rows: readonly ProblemRow[], w: { start: number; end: number }): number => {
  let sum = 0;
  for (let i = w.start; i < w.end; i += 1) sum += rows[i]!.kind === 'group' ? H.group : H.item;
  return sum;
};

afterEach(() => clearAllProblems());

describe('problemRowOffsets：两档行高的前缀和账本', () => {
  it('逐行累加（组头与问题行高度不同 ⇒ 不能用 index × 行高）', () => {
    const rows: ProblemRow[] = [
      { kind: 'group', group: { path: 'a', label: 'a', items: [], indices: [], counts: { error: 0, warning: 0, info: 0 }, startIndex: 0 } },
      { kind: 'item', group: { path: 'a', label: 'a', items: [], indices: [], counts: { error: 0, warning: 0, info: 0 }, startIndex: 0 }, problem: { path: 'a', line: 1, severity: 'error', message: 'm' }, itemIndex: 0 },
      { kind: 'group', group: { path: 'b', label: 'b', items: [], indices: [], counts: { error: 0, warning: 0, info: 0 }, startIndex: 0 } },
    ];
    const { offsets, total } = problemRowOffsets(rows, { group: 20, item: 30 });
    expect(offsets).toEqual([0, 20, 50, 70]);
    expect(total).toBe(70);
    expect(total).toBe(20 * 2 + 30);
  });

  it('空清单 ⇒ 一条零值账本（total 0，不炸二分）', () => {
    expect(problemRowOffsets([], H)).toEqual({ offsets: [0], total: 0 });
  });
});

describe('problemRowWindow：视口 → 渲染窗口', () => {
  const rows = corpusRows();
  const { offsets, total } = problemRowOffsets(rows, H);

  it('顶部：start 从 0 起，topPad 为 0（首屏不留白）', () => {
    const w = problemRowWindow(offsets, 0, 96, 240);
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
    expect(w.total).toBe(total);
  });

  it('① 留白 + 窗口内行高 === 总高（滚动高度不缩水，滚动条不说谎）', () => {
    for (const top of [0, 517, 1_000, 12_345, total - 400, total]) {
      for (const height of [0, 96, 400, 4_000]) {
        const w = problemRowWindow(offsets, top, height, 240);
        expect(w.topPad + windowHeight(rows, w) + w.bottomPad, `top=${top} h=${height}`).toBeCloseTo(
          total,
          6,
        );
      }
    }
  });

  it('② 窗口必定覆盖可见区间（滚到哪儿都不会看到空白）', () => {
    const EPS = 1e-6; // 浮点行高逐行累加：留一个亚像素容差，不比较最后一位
    for (let top = 0; top < total; top += 977) {
      for (const height of [96, 400, 1_500]) {
        const w = problemRowWindow(offsets, top, height, 240);
        expect(w.topPad).toBeLessThanOrEqual(top + EPS);
        expect(w.topPad + windowHeight(rows, w)).toBeGreaterThanOrEqual(
          Math.min(total, top + height) - EPS,
        );
      }
    }
  });

  it('③ 窗口长度有上界（DOM 不随总诊断数长）：2,695 行里最多挂 ~30 行', () => {
    const limit = Math.ceil((96 + 2 * 240) / H.item) + 2;
    for (let top = 0; top < total; top += 613) {
      const w = problemRowWindow(offsets, top, 96, 240);
      expect(w.end - w.start).toBeLessThanOrEqual(limit);
      expect(w.end - w.start).toBeLessThanOrEqual(60);
    }
    // 底栏被拉高时也守得住（可视 400px ⇒ 18 + 22 + 2 行）
    const tall = problemRowWindow(offsets, total / 2, 400, 240);
    expect(tall.end - tall.start).toBeLessThanOrEqual(60);
  });

  it('滚到底：末行必在窗口内，bottomPad 为 0', () => {
    const w = problemRowWindow(offsets, total, 96, 240);
    expect(w.end).toBe(rows.length);
    expect(w.bottomPad).toBeCloseTo(0, 6);
  });

  it('④ 中段首行 = 顶边落在"视口顶 − overscan"的那一行（索引与内容不许错位）', () => {
    const midTop = total / 2;
    const OVERSCAN = 240;
    const w = problemRowWindow(offsets, midTop, 96, OVERSCAN);
    // 手算：窗口顶 = 视口顶往上让 overscan 的那条线，起点是顶边 ≤ 它的最后一行
    let expected = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (offsets[i]! <= midTop - OVERSCAN + 1e-6) expected = i;
    }
    expect(w.start).toBe(expected);
    expect(w.start).toBeGreaterThan(0); // 中段不许回落到首屏
    expect(offsets[w.start]!).toBeLessThanOrEqual(midTop + 1e-6);
    expect(midTop - offsets[w.start]!).toBeLessThanOrEqual(OVERSCAN + H.item);
    // 内容对齐：中段第一行就是清单里那一条（不是首屏那条，也不许串到邻行）
    const first = rows[w.start]!;
    expect(first.kind).toBe('item');
  });

  it('⑤ 末尾窗口的最后一行就是清单最后一行（全量可达，不是"看到 40 条就没了"）', () => {
    const w = problemRowWindow(offsets, total, 96, 240);
    expect(w.end).toBe(rows.length);
    expect(rows[rows.length - 1]!.kind).toBe('item');
    expect(offsets[w.end - 1]!).toBeLessThan(total);
    expect(offsets[w.end - 1]!).toBeGreaterThanOrEqual(total - 96);
  });

  it('空清单 / 视口为负或零 ⇒ 空窗口（不抛错）', () => {
    expect(problemRowWindow([0], 0, 600, 240)).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
      total: 0,
    });
    const w = problemRowWindow(offsets, 100, -50, 240);
    expect(w.start).toBeLessThanOrEqual(w.end);
    expect(w.start).toBe(0); // 视口高度为负 ⇒ 夹成"贴着 viewTop 的一行"，不反向
  });

  it('同一视口连算两次得到同一份窗口（sameProblemRowWindow 用于跳过 setState）', () => {
    const a = problemRowWindow(offsets, 5_000, 96, 240);
    const b = problemRowWindow(offsets, 5_000, 96, 240);
    expect(sameProblemRowWindow(a, b)).toBe(true);
    expect(sameProblemRowWindow(a, problemRowWindow(offsets, 5_100, 96, 240))).toBe(false);
  });
});

describe('problemRowsOf：折叠在投影层减行', () => {
  it('折叠的组只剩组头，别的组一行不少（也不把组头挤没）', () => {
    const groups = corpusGroups();
    const all = problemRowsOf(groups);
    const folded = problemRowsOf(groups, new Set([groups[0]!.path]));
    expect(all).toHaveLength(PROBLEM_COUNT + FILE_COUNT);
    expect(folded).toHaveLength(all.length - groups[0]!.items.length);
    expect(folded.filter((r) => r.kind === 'group')).toHaveLength(FILE_COUNT);
    // 折叠组的行不在账本里 ⇒ 不留空白（紧接着就是下一组的组头）
    expect(folded[1]!.kind).toBe('group');
  });
});

describe('行导航的序号腿：组头 −1、问题行按显示序贴号', () => {
  it('problemOrdinalMap 与 problemItemRowIndex 逐位对齐', () => {
    const rows = problemRowsOf(corpusGroups().slice(0, 3));
    const map = problemOrdinalMap(rows);
    const flat = problemItemRowIndex(rows);
    expect(map[0]).toBe(-1);
    expect(flat).toHaveLength(rows.filter((r) => r.kind === 'item').length);
    for (let ordinal = 0; ordinal < flat.length; ordinal += 1) {
      expect(map[flat[ordinal]!]).toBe(ordinal);
    }
    // 末号 = 行数 − 1（跨窗口导航的落点判据靠它）
    expect(map[flat[flat.length - 1]!]).toBe(flat.length - 1);
  });
});

describe('ProblemPanel · 2,633 条诊断的首帧 DOM', () => {
  const load = (): void => {
    const byPath = new Map<string, EditorProblem[]>();
    for (const p of corpusProblems()) {
      const list = byPath.get(p.path) ?? [];
      list.push(p);
      byPath.set(p.path, list);
    }
    for (const [path, list] of byPath) setProblems(path, list);
  };

  it(`首帧只挂 ${PROBLEM_VROWS_FALLBACK} 条（量不到视口时走首屏缺省窗口）`, () => {
    load();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const groups = (markup.match(/class="prob-vrow-group/g) ?? []).length;
    const items = (markup.match(/class="prob-item"/g) ?? []).length;
    expect(groups + items).toBe(PROBLEM_VROWS_FALLBACK);
    expect(groups).toBe(1); // 第一行是组头，其余是该组的行
    expect(items).toBe(PROBLEM_VROWS_FALLBACK - 1);
  });

  it('挂载行的 data-prob-index 连续，且每行内容 = 清单同下标那一行（串位就红）', () => {
    load();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    // 期望清单必须按 **store 的显示序**（severity → path → line）重建：面板吃的是
    // `snapshot()`，不是本文件构造时的插入序——两把尺子差一处就会把这颗钉子对错行。
    const rows = problemRowsOf(groupProblems(snapshot()));
    const segs = markup.split('data-prob-index="').slice(1);
    expect(segs).toHaveLength(PROBLEM_VROWS_FALLBACK);
    expect(segs.map((s) => Number(s.slice(0, s.indexOf('"'))))).toEqual(
      Array.from({ length: PROBLEM_VROWS_FALLBACK }, (_, i) => i),
    );
    for (const seg of segs) {
      const idx = Number(seg.slice(0, seg.indexOf('"')));
      const row = rows[idx]!;
      if (row.kind === 'group') expect(seg, `第 ${idx} 行`).toContain('prob-group-head');
      else expect(seg, `第 ${idx} 行`).toContain(`:${row.problem.line}<`);
    }
  });

  it('每一条挂载的问题行都带绝对序号（行导航跨窗口走）', () => {
    load();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain('data-prob-ordinal="0"');
    expect(markup).toContain(`data-prob-ordinal="${PROBLEM_VROWS_FALLBACK - 2}"`);
  });
});
