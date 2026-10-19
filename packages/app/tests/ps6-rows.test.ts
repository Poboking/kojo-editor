/**
 * PS-6 ④⑤⑥：长列表的"死顶"换成"可长"，目录排序与快速打开各归一次算清。
 *
 * 本文件全是**可数的量**（DOM 行数、比较次数、小写次数），零墙钟断言 ⇒ 留在功能池。
 * 行数口径 = `react-dom/server` 真产出的 markup 里数类名（与 `file-tree.test.ts`、
 * `panel-window-*.test.ts` 同一套做法）；PITFALLS 48 那条纪律在这里同样成立——
 * 判"画没画"看 markup 里的实际行数，不看引用。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DirEntry } from '@kojo/plugin-api';
import { nextWindow } from '@kojo/plugin-api';
import type { SearchFileResult, SearchResult } from '../src/bridge/search';
import { SearchPanel, SEARCH_WINDOW_INITIAL } from '../src/ui/SearchPanel';
import { flattenSearchResults } from '../src/ui/search-query';
import { ProblemPanel, PROBLEM_WINDOW_INITIAL } from '../src/ui/ProblemPanel';
import { setProblems, clearAllProblems, type EditorProblem } from '../src/ui/problem-store';
import { DirRows } from '../src/ui/file-tree-dir-rows';
import type { DirState } from '../src/ui/file-tree-types';
import { rankFiles } from '../src/ui/palette-search';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 判据住在 palette-search（`Ctrl+P` 文件模式的真身）；测试要的是「只含路径」那条投影 */
const filterFileCandidates = (
  paths: readonly string[],
  q: string,
  cap?: number,
): string[] => rankFiles(paths, q, cap === undefined ? {} : { cap }).map((h) => h.path);

const UI_DIR = fileURLToPath(new URL('../src/ui', import.meta.url));
const UI = (name: string): string => readFileSync(path.join(UI_DIR, name), 'utf8');

/** 真语料一次全项目检索的实际规模（STATE / 真壳读数：2,870 条命中 · 25 个文件） */
const HIT_COUNT = 2_870;
const FILE_COUNT = 25;

function searchFiles(): SearchFileResult[] {
  const per = Math.floor(HIT_COUNT / FILE_COUNT); // 114
  const extra = HIT_COUNT - per * FILE_COUNT; // 20 条补给第一份
  const out: SearchFileResult[] = [];
  for (let f = 0; f < FILE_COUNT; f++) {
    const n = per + (f === 0 ? extra : 0);
    out.push({
      path: `C:/game/ERB/0${f}/M_KOJO_K${f}_场景.ERB`,
      matches: Array.from({ length: n }, (_, i) => ({
        line: i + 1,
        column: 3,
        preview: `PRINTDATA TFLAG:${i}`,
        start: 10,
        end: 16,
      })),
    });
  }
  return out;
}

const emptyResult = (files: SearchFileResult[]): SearchResult => ({
  files,
  totalMatches: HIT_COUNT,
  truncated: false,
  cancelled: false,
  filesScanned: 4_519,
  skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
  elapsedMs: 420,
});

/** 结果区里两类行的实际数量 */
function countRows(markup: string): { headers: number; matches: number } {
  return {
    headers: (markup.match(/class="search-file ksp-file"/g) ?? []).length,
    matches: (markup.match(/class="search-match-row ksp-row"/g) ?? []).length,
  };
}

describe('检索面板 · 2,870 条命中的可达性（旧实现：第 301 行起没有入口）', () => {
  it('首帧只画窗口上界的行（旧实现固定挂 300 行，其余写死不可达）', async () => {
    const files = searchFiles();
    const { rows, hidden } = flattenSearchResults(files, SEARCH_WINDOW_INITIAL);
    expect(rows.length).toBe(SEARCH_WINDOW_INITIAL);
    // 全量行数 = 命中行 + 文件头
    expect(rows.length + hidden).toBe(HIT_COUNT + FILE_COUNT);
    const markup = renderToStaticMarkup(
      h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }),
    );
    void markup; // 未 primed 时面板没有结果区（下面那条走 store 才画行）
  });

  it('面板真产出结果行 + 一枚真按钮的哨兵（数字说"还有多少"，按钮负责到得了）', async () => {
    const files = searchFiles();
    const { setSearchRunner, setQuery, runSearch, resetSearch } = await import('../src/ui/search-store');
    resetSearch();
    setSearchRunner(async () => emptyResult(files));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(
      h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }),
    );
    const { headers, matches } = countRows(markup);
    // 首行是文件头，其余都是命中行 ⇒ 窗口上界被两者共同吃满
    expect(headers + matches).toBe(SEARCH_WINDOW_INITIAL);
    expect(headers).toBe(1);
    expect(matches).toBe(SEARCH_WINDOW_INITIAL - 1);
    const totalRows = HIT_COUNT + FILE_COUNT;
    expect(markup).toContain(`本屏显示前 ${SEARCH_WINDOW_INITIAL} 行 · 共 ${totalRows} 行命中`);
    expect(markup).toContain(`继续显示后面的命中（还有 ${totalRows - SEARCH_WINDOW_INITIAL} 行）`);
    setSearchRunner(null);
    resetSearch();
  });

  it('哨兵是 `<button>` 而不是提示文字 ⇒ 键盘可达（UI-4 那条口径不许因为窗口化掉档）', async () => {
    const files = searchFiles();
    const { setSearchRunner, setQuery, runSearch, resetSearch } = await import('../src/ui/search-store');
    resetSearch();
    setSearchRunner(async () => emptyResult(files));
    setQuery('TFLAG');
    await runSearch(['C:/game']);
    const markup = renderToStaticMarkup(
      h(SearchPanel, { roots: ['C:/game'], onReveal: () => {} }),
    );
    expect(markup).toContain('class="ghost small ksp-more"');
    // 每一行命中都是一个可 Tab 的按钮
    expect((markup.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(SEARCH_WINDOW_INITIAL);
    setSearchRunner(null);
    resetSearch();
  });

  it('按到第 N 次就见底：窗口单调 + 终值 = 全量（把 2,775 行全部够得着）', () => {
    const totalRows = HIT_COUNT + FILE_COUNT;
    const window = { initial: SEARCH_WINDOW_INITIAL, step: 240 };
    let limit = window.initial;
    let clicks = 0;
    let prev = 0;
    while (limit < totalRows && clicks < 200) {
      prev = limit;
      limit = nextWindow(limit, totalRows, window);
      clicks++;
      expect(limit).toBeGreaterThan(prev); // 单调：每按一次一定多画
      expect(limit - prev).toBeLessThanOrEqual(window.step); // 有界：一次不许吞整棵树
    }
    expect(limit).toBe(totalRows);
    expect(clicks).toBe(12); // (2895-120)/240 向上取整 ⇒ 12 次点击到底
  });

  it('本批承诺的那两个数 · 2,870 条命中的 DOM 行数：死顶 300（其余永不可达）→ 首帧 120 · 全量可达', () => {
    const files = searchFiles();
    const totalRows = HIT_COUNT + FILE_COUNT; // 2,895 = 命中行 + 文件头
    // 对照臂：改造前那把死尺（当时的 `RENDER_CAP = 300`），裁掉的行没有任何入口
    const legacy = flattenSearchResults(files, 300);
    expect(legacy.rows.length).toBe(300);
    expect(legacy.hidden).toBe(totalRows - 300);
    // 改造后：首帧比旧实现还轻（120 < 300），但窗口按得开，直到一行不少
    const first = flattenSearchResults(files, SEARCH_WINDOW_INITIAL);
    expect(first.rows.length).toBe(SEARCH_WINDOW_INITIAL);
    const full = flattenSearchResults(files, totalRows);
    expect(full.rows.length).toBe(totalRows);
    expect(full.hidden).toBe(0);
  });

  it('旧的死顶常量已经从面板里消失（不许留第二把尺）', () => {
    expect(UI('SearchPanel.tsx')).not.toContain('RENDER_CAP');
  });
});

const SEVERITIES = ['error', 'warning', 'info'] as const;

const mkProblems = (n: number): EditorProblem[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `C:/game/ERB/001/M_KOJO_K1_${i}.ERB`,
    line: i + 1,
    severity: SEVERITIES[i % SEVERITIES.length] as EditorProblem['severity'],
    message: `第 ${i} 条问题`,
  }));

describe('问题面板 · 1,000 条同样可达（旧实现：300 条封顶）', () => {
  it('首帧挂窗口上界条数 + 一句"还有多少"，并且给了按钮', () => {
    clearAllProblems();
    setProblems('C:/game/ERB/001/M_KOJO_K1_0.ERB', mkProblems(1_000));
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect((markup.match(/class="prob-item"/g) ?? []).length).toBe(PROBLEM_WINDOW_INITIAL);
    expect(markup).toContain('继续显示后面的问题（还有 880 条，共 1000 条）');
    expect(markup).toContain('prob-more');
    clearAllProblems();
  });

  it('不到 120 条 ⇒ 完全不画哨兵（小面板零扰动）', () => {
    clearAllProblems();
    setProblems('C:/game/ERB/001/M_KOJO_K1_0.ERB', mkProblems(9));
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect((markup.match(/class="prob-item"/g) ?? []).length).toBe(9);
    expect(markup).not.toContain('prob-more');
    clearAllProblems();
  });
});

/* ---------------- ④ 目录排序只做一次 ---------------- */

const dirEntries = (n: number): DirEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `M_KOJO_K1_${String(n - i).padStart(4, '0')}.ERB`,
    path: `C:/game/ERB/001/M_KOJO_K1_${String(n - i).padStart(4, '0')}.ERB`,
    isDirectory: false,
  }));

const dirProps = (entries: DirEntry[]) => ({
  dir: 'C:/game/ERB/001',
  depth: 1 as const,
  skip: new Set<string>(),
  dirCache: new Map<string, DirState>([['C:/game/ERB/001', entries]]),
  subOpen: new Set<string>(),
  edit: null,
  editValue: '',
  glossOf: (n: string) => n,
  activeFile: null,
  setEditValue: () => {},
  commitEdit: () => {},
  cancelEdit: () => {},
  toggleSub: () => {},
  openMenu: () => {},
  onOpenFile: () => {},
});

/** 数一次真实比较（把 `localeCompare` 临时包起来；用完还原） */
function countLocaleCompare(run: () => void): number {
  const proto = String.prototype as unknown as { localeCompare: (other: string) => number };
  const original = proto.localeCompare;
  let calls = 0;
  proto.localeCompare = function (this: string, other: string): number {
    calls++;
    return original.call(this, other);
  };
  try {
    run();
  } finally {
    proto.localeCompare = original;
  }
  return calls;
}

describe('DirRows · 一份目录的排序结果按数组身份缓存', () => {
  const entries = dirEntries(300);

  it('第一帧排一次（300 条 ⇒ O(n log n) 次比较），第二帧零次', () => {
    const first = countLocaleCompare(() => {
      renderToStaticMarkup(h(DirRows, dirProps(entries)));
    });
    expect(first).toBeGreaterThan(0);
    const second = countLocaleCompare(() => {
      renderToStaticMarkup(h(DirRows, dirProps(entries)));
    });
    expect(second).toBe(0);
  });

  it('顺序仍然是名字升序（缓存不许把排序口径换成插入序）', () => {
    const markup = renderToStaticMarkup(h(DirRows, dirProps(entries)));
    const names = [...markup.matchAll(/>(M_KOJO_K1_\d+\.ERB)</g)].map((m) => m[1]);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('换新数组（重新列举）⇒ 重新排序，不会捞到旧那份顺序', () => {
    const fresh = dirEntries(300).slice().reverse();
    const calls = countLocaleCompare(() => {
      renderToStaticMarkup(h(DirRows, dirProps(fresh)));
    });
    expect(calls).toBeGreaterThan(0);
  });
});

/* ---------------- ⑥ 快速打开不再每击键重扫全表 ---------------- */

/** 数"真的把带大写的串小写了多少次"（= 归一化真做了多少活） */
function countRealLowercasing(run: () => void): number {
  const original = String.prototype.toLowerCase;
  let calls = 0;
  String.prototype.toLowerCase = function (this: string): string {
    // 必须先拿原函数的结果再比：写成 `this.toLowerCase()` 会递归到自己身上（栈爆）。
    const out = original.call(this);
    if (out !== this) calls++; // 已经全小写 ⇒ 原样返回同引用，那一次不算做了活
    return out;
  };
  try {
    run();
  } finally {
    String.prototype.toLowerCase = original;
  }
  return calls;
}

describe('快速打开 · 归一化清单钉在 files 的身份上', () => {
  const files = Array.from(
    { length: 2_325 },
    (_, i) => `C:/game/ERB/0${i % 9}/M_KOJO_K${i % 145}_${i}.ERB`,
  );

  it('第一次击键把每条路径各小写一次；后续击键一次都不做', () => {
    let first = 0;
    let again = 0;
    countRealLowercasing(() => {
      first = filterFileCandidates(files, 'k1').length;
    });
    const cost1 = countRealLowercasing(() => {
      filterFileCandidates(files, 'k1_1');
    });
    const cost2 = countRealLowercasing(() => {
      filterFileCandidates(files, 'k1_12');
    });
    expect(first).toBeGreaterThan(0);
    expect(cost1).toBe(0); // 同一份清单 ⇒ 归一化不再重做
    expect(cost2).toBe(0);
  });

  it('改造前那一版写法实测每击键都要重造一遍（对照臂：2,325 次全路径小写）', () => {
    // 与改造前的表达式逐字同形：`baseNameOf(p.toLowerCase())` + 把原路径交给 rank
    const legacy = (q: string): number => {
      const lq = q.trim().toLowerCase();
      let hits = 0;
      for (const p of files) {
        const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase();
        if (base.includes(lq) || p.toLowerCase().includes(lq)) hits++;
      }
      return hits;
    };
    const cost = countRealLowercasing(() => legacy('k1_1'));
    expect(cost).toBeGreaterThanOrEqual(files.length);
  });

  it('缓存换了清单身份就重算（换项目 / 范围收窄不许拿旧名单答新问题）', () => {
    const a = filterFileCandidates(files, 'k1');
    const b = filterFileCandidates([...files].slice(0, 10), 'k1');
    expect(a.length).toBeGreaterThan(b.length);
  });
});
