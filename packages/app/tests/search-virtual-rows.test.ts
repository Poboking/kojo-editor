/**
 * 检索结果列表的**虚拟化**判据（PERF 搜索批，2026-10-25）。
 *
 * 旧实现（PS-6 起）：`flattenSearchResults(files, 120)` + 末尾一枚「继续显示」。
 * DOM 封在 120 行，但**一次全建**：真语料 2,000 条命中时出结果那一帧实测 44–82ms
 * （`bySource` 归 `(render)`），每按一次「继续显示」再付一遍，命中上万条继续长。
 * 现在：只挂视口内的行 + overscan（DOM ≤ 60），全量靠滚动可达（不再有"继续显示"）。
 *
 * 本文件钉五件事（都是**可数的量**，零墙钟断言 ⇒ 功能池）：
 *   ① 行高账本：两档行高（文件头 / 命中行）逐行累加，总高 = 全量行高之和；
 *   ② 窗口切片：`topPad + 窗口内行高 + bottomPad === total`、窗口必覆盖可见区间、
 *      窗口长度有上界（DOM 不随命中数长）；
 *   ③ 面板真产出的 DOM 行数：2,870 条命中 ⇒ 首帧只挂 `SEARCH_VROWS_FALLBACK` 行，
 *      且"继续显示"那枚哨兵按钮已经退场（全量改为滚动可达）；
 *   ④ 折叠在**投影层**就减行（行高账本不许给折叠掉的行留空白）；
 *   ⑤ 中段 / 末尾的切片首末行与挂载行的"索引 ↔ 内容"一致（错一行就红）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SearchFileResult, SearchResult } from '../src/bridge/search';
import { SEARCH_VROWS_FALLBACK, SearchPanel } from '../src/ui/SearchPanel';
import {
  SEARCH_ROW_HEIGHTS_FALLBACK,
  flattenSearchResults,
  searchRowOffsets,
  searchRowWindow,
  searchRowsOf,
  sameRowWindow,
  type SearchRow,
  type SearchRowHeights,
} from '../src/ui/search-rows';
import { resetSearch, runSearch, setQuery, setSearchRunner } from '../src/ui/search-store';

/** 真语料一次全项目检索的实际规模（STATE / 真壳读数：2,870 条命中 · 25 个文件） */
const HIT_COUNT = 2_870;
const FILE_COUNT = 25;
/** 两档行高取真机实测值（文件头 23 / 命中行 25.6 @12px），布局无关，纯算 */
const H: SearchRowHeights = SEARCH_ROW_HEIGHTS_FALLBACK;

function searchFiles(hits = HIT_COUNT, files = FILE_COUNT): SearchFileResult[] {
  const per = Math.floor(hits / files);
  const extra = hits - per * files;
  return Array.from({ length: files }, (_, f) => ({
    path: `C:/game/ERB/0${f}/M_KOJO_K${f}_场景.ERB`,
    matches: Array.from({ length: per + (f === 0 ? extra : 0) }, (_, i) => ({
      line: i + 1,
      column: 3,
      preview: `PRINTDATA TFLAG:${i}`,
      start: 10,
      end: 16,
    })),
  }));
}

const resultOf = (files: SearchFileResult[]): SearchResult => ({
  files,
  totalMatches: HIT_COUNT,
  truncated: false,
  cancelled: false,
  filesScanned: 4_519,
  skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
  elapsedMs: 420,
});

const rowsOf = (hits = HIT_COUNT, files = FILE_COUNT): SearchRow[] => searchRowsOf(searchFiles(hits, files));

/** 窗口内行的总高（按同一份行高账本算） */
const windowHeight = (rows: readonly SearchRow[], w: { start: number; end: number }): number => {
  let sum = 0;
  for (let i = w.start; i < w.end; i += 1) sum += rows[i]!.kind === 'file' ? H.file : H.match;
  return sum;
};

describe('searchRowOffsets：两档行高的前缀和账本', () => {
  it('逐行累加（文件头与命中行高度不同 ⇒ 不能用 index × 行高）', () => {
    const rows: SearchRow[] = [
      { kind: 'file', path: 'a', count: 2 },
      { kind: 'match', path: 'a', match: { line: 1, column: 1, preview: 'x', start: 0, end: 1 } },
      { kind: 'match', path: 'a', match: { line: 2, column: 1, preview: 'y', start: 0, end: 1 } },
      { kind: 'file', path: 'b', count: 1 },
      { kind: 'match', path: 'b', match: { line: 9, column: 1, preview: 'z', start: 0, end: 1 } },
    ];
    const { offsets, total } = searchRowOffsets(rows, { file: 20, match: 30 });
    expect(offsets).toEqual([0, 20, 50, 80, 100, 130]);
    expect(offsets).toHaveLength(rows.length + 1);
    expect(total).toBe(130);
    expect(total).toBe(20 * 2 + 30 * 3);
  });

  it('空清单 ⇒ 一条零值账本（total 0，不炸二分）', () => {
    expect(searchRowOffsets([], H)).toEqual({ offsets: [0], total: 0 });
  });
});

describe('searchRowWindow：视口 → 渲染窗口', () => {
  const rows = rowsOf();
  const { offsets, total } = searchRowOffsets(rows, H);

  it('顶部：start 从 0 起，topPad 为 0（首屏不留白）', () => {
    const w = searchRowWindow(offsets, 0, 600, 240);
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
    expect(w.total).toBe(total);
  });

  it('① 留白 + 窗口内行高 === 总高（滚动高度不缩水，滚动条不说谎）', () => {
    for (const top of [0, 517, 1_000, 12_345, total - 400, total]) {
      for (const height of [0, 300, 743, 4_000]) {
        const w = searchRowWindow(offsets, top, height, 240);
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
      for (const height of [200, 743, 1_500]) {
        const w = searchRowWindow(offsets, top, height, 240);
        expect(w.topPad).toBeLessThanOrEqual(top + EPS);
        expect(w.topPad + windowHeight(rows, w)).toBeGreaterThanOrEqual(
          Math.min(total, top + height) - EPS,
        );
      }
    }
  });

  it('③ 窗口长度有上界（DOM 不随命中数长）：2,895 行里最多挂 ~60 行', () => {
    const limit = Math.ceil((743 + 2 * 240) / H.match) + 2;
    for (let top = 0; top < total; top += 613) {
      const w = searchRowWindow(offsets, top, 743, 240);
      expect(w.end - w.start).toBeLessThanOrEqual(limit);
      expect(w.end - w.start).toBeLessThanOrEqual(60);
    }
  });

  it('滚到底：末行必在窗口内，bottomPad 为 0', () => {
    const w = searchRowWindow(offsets, total, 743, 240);
    expect(w.end).toBe(rows.length);
    expect(w.bottomPad).toBeCloseTo(0, 6);
  });

  /**
   * 中段 / 末尾的**切片首末行**（批次裁决要求：滚动后首行索引与行内容一致）。
   *
   * 虚拟列表最容易错的一处不是"画几行"，而是"画第几行"：账本与窗口错一行，
   * 作者看到的就是"滚到一半行号对不上"。这里把"屏上第一行"按账本手算一遍
   * （最后一个顶边 ≤ 视口顶的行）与 `searchRowWindow` 的 `start` 对齐，
   * 并核该行的**内容**是清单里的那一行（不是邻行）。
   */
  it('④ 中段首行 = 顶边落在"视口顶 − overscan"的那一行（索引与内容不许错位）', () => {
    const midTop = total / 2;
    const OVERSCAN = 240;
    const w = searchRowWindow(offsets, midTop, 743, OVERSCAN);
    // 手算：窗口顶 = 视口顶往上让 overscan 的那条线，起点是顶边 ≤ 它的最后一行
    let expected = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (offsets[i]! <= midTop - OVERSCAN + 1e-6) expected = i;
    }
    expect(w.start).toBe(expected);
    expect(w.start).toBeGreaterThan(0); // 中段不许回落到首屏
    // 可见区间必被覆盖：首行顶边在视口顶之上，且不让出超过 overscan 一行
    expect(offsets[w.start]!).toBeLessThanOrEqual(midTop + 1e-6);
    expect(midTop - offsets[w.start]!).toBeLessThanOrEqual(OVERSCAN + H.match);
    // 内容对齐：中段第一行就是清单里那一条（不是首屏那条，也不许串到邻行）
    const first = rows[w.start]!;
    expect(first.kind).toBe('match');
    expect(first.kind === 'match' ? first.match.line : -1).toBeGreaterThan(1);
  });

  it('⑤ 末尾窗口的最后一行就是清单最后一行（全量可达，不是"看到 60 行就没了"）', () => {
    const w = searchRowWindow(offsets, total, 743, 240);
    expect(w.end).toBe(rows.length);
    const last = rows[rows.length - 1];
    expect(last?.kind).toBe('match');
    // 末行的顶边必须在视口内（账本漂移会让最后几行顶不上去）
    expect(offsets[w.end - 1]!).toBeLessThan(total);
    expect(offsets[w.end - 1]!).toBeGreaterThanOrEqual(total - 743);
  });

  it('空清单 / 视口为负或零 ⇒ 空窗口（不抛错）', () => {
    expect(searchRowWindow([0], 0, 600, 240)).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
      total: 0,
    });
    const w = searchRowWindow(offsets, 100, -50, 240);
    expect(w.start).toBeLessThanOrEqual(w.end);
    expect(w.start).toBe(0); // 视口高度为负 ⇒ 夹成"贴着 viewTop 的一行"，不反向
  });

  it('同一视口连算两次得到同一份窗口（sameRowWindow 用于跳过 setState）', () => {
    const a = searchRowWindow(offsets, 5_000, 743, 240);
    const b = searchRowWindow(offsets, 5_000, 743, 240);
    expect(sameRowWindow(a, b)).toBe(true);
    expect(sameRowWindow(a, searchRowWindow(offsets, 5_100, 743, 240))).toBe(false);
  });
});

describe('searchRowsOf：折叠在投影层减行', () => {
  it('折叠的文件只剩文件头（计数仍是后端总数，不裁读数）', () => {
    const files = searchFiles(10, 2);
    const all = searchRowsOf(files);
    const folded = searchRowsOf(files, new Set([files[0]!.path]));
    expect(all).toHaveLength(10 + 2);
    expect(folded).toHaveLength(all.length - files[0]!.matches.length);
    expect(folded[0]).toMatchObject({ kind: 'file', count: files[0]!.matches.length });
    // 折叠不许把后面的文件挤没
    expect(folded.filter((r) => r.kind === 'file')).toHaveLength(2);
  });

  it('不传 folded ⇒ 与旧的口径一致（`flattenSearchResults` 就是它的前 cap 行）', () => {
    const files = searchFiles();
    expect(flattenSearchResults(files, 120).rows).toEqual(searchRowsOf(files).slice(0, 120));
    expect(flattenSearchResults(files, 120).hidden).toBe(HIT_COUNT + FILE_COUNT - 120);
  });
});

describe('SearchPanel · 2,870 条命中的 DOM 行数', () => {
  it('首帧只挂 SEARCH_VROWS_FALLBACK 行（旧实现挂满 120 + 一枚「继续显示」）', async () => {
    resetSearch();
    setSearchRunner(async () => resultOf(searchFiles()));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }));
    const headers = (markup.match(/ksp-vrow-file/g) ?? []).length;
    const matches = (markup.match(/ksp-vrow-match/g) ?? []).length;
    // 服务端渲染量不到视口 ⇒ 走首屏缺省窗口（这一步在浏览器里由 layout effect 收口）
    expect(headers + matches).toBe(SEARCH_VROWS_FALLBACK);
    expect(headers).toBe(1); // 第一行是文件头，其余是命中行
    expect(matches).toBe(SEARCH_VROWS_FALLBACK - 1);
    setSearchRunner(null);
    resetSearch();
  });

  it('总行数写进 DOM（滚动高度/读数同源）且「继续显示」哨兵已退场', async () => {
    resetSearch();
    setSearchRunner(async () => resultOf(searchFiles()));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }));
    expect(markup).toContain(`data-ksp-vrows="${HIT_COUNT + FILE_COUNT}"`);
    expect(markup).not.toContain('ksp-more');
    expect(markup).not.toContain('继续显示后面的命中');
    // 摘要读数仍是后端真值（虚拟化不许改开口径）
    expect(markup).toContain('2870 条');
    setSearchRunner(null);
    resetSearch();
  });

  it('每一条挂载的命中行都带绝对序号（行导航据此跨窗口走）', async () => {
    resetSearch();
    setSearchRunner(async () => resultOf(searchFiles(3, 1)));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }));
    expect(markup).toContain('data-ksp-row="0"');
    expect(markup).toContain('data-ksp-row="2"');
    setSearchRunner(null);
    resetSearch();
  });

  /**
   * 挂载行的**索引 ↔ 内容**对齐（切片正确性的 DOM 侧钉子）。
   *
   * 账本错一行时"行数"仍是对的，只有内容会串位（第 7 行显示第 6 条的行号），
   * 任何"数行数"的断言都红不了。所以这里逐行核：第 `data-ksp-index` 行渲染出来的
   * 必须是清单里同下标那一行（命中行给行号、文件头给文件名）。
   */
  it('挂载行的 data-ksp-index 连续，且每行内容 = 清单同下标的一行（串位就红）', async () => {
    resetSearch();
    setSearchRunner(async () => resultOf(searchFiles()));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }));
    const rows = searchRowsOf(searchFiles());
    const segs = markup.split('data-ksp-index="').slice(1);
    expect(segs).toHaveLength(SEARCH_VROWS_FALLBACK);
    expect(segs.map((s) => Number(s.slice(0, s.indexOf('"'))))).toEqual(
      Array.from({ length: SEARCH_VROWS_FALLBACK }, (_, i) => i),
    );
    for (const seg of segs) {
      const idx = Number(seg.slice(0, seg.indexOf('"')));
      const row = rows[idx]!;
      if (row.kind === 'match') expect(seg, `第 ${idx} 行`).toContain(`${row.match.line}:`);
      else expect(seg, `第 ${idx} 行`).toContain(row.path.split('/').pop()!.replace(/\.ERB$/, ''));
    }
    setSearchRunner(null);
    resetSearch();
  });

  /**
   * 「还有更多」的可见指示（哨兵按钮退场后的替代物）。
   *
   * 旧实现靠末尾那枚「继续显示后面的命中」告诉作者"没画完"；虚拟化之后全量靠滚动
   * 可达，但**不许变成"没提示"**：结果摘要（2,870 条）与「第 X 项 / 共 Y 项」必须
   * 仍在屏上，作者一眼能看出总量远大于眼前这几十行。
   */
  it('「继续显示」退场后仍有可见的总量指示（摘要条数 + 第 X / 共 Y 项）', async () => {
    resetSearch();
    setSearchRunner(async () => resultOf(searchFiles()));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }));
    expect(markup).toContain('ksp-summary');
    expect(markup).toContain(`${HIT_COUNT} 条`);
    expect(markup).toContain('ksp-match-counter');
    expect(markup).toContain(`共 ${HIT_COUNT} 项`);
    setSearchRunner(null);
    resetSearch();
  });
});
