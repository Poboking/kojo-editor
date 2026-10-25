/**
 * PS-6 ④⑤⑥："死顶"换成"可长"、目录排序与快速打开各归一次算清。
 *
 * 本文件全是**可数的量**（DOM 行数、比较次数、小写次数），零墙钟断言 ⇒ 留在功能池。
 * 行数口径 = `react-dom/server` 真产出的 markup 里数类名（与 `file-tree.test.ts`、
 * `panel-window-*.test.ts` 同一套做法）；PITFALLS 48 那条纪律在这里同样成立——
 * 判"画没画"看 markup 里的实际行数，不看引用。
 *
 * ⚠ 检索面板那一段（"2,870 条命中 / 120 行 + 继续显示"）已随 PERF 搜索批（2026-10-25）
 * 迁到 `search-virtual-rows.test.ts`：列表改虚拟化后"首帧正好 120 行 + 哨兵按钮"不再成立，
 * 判据换成窗口切片与 DOM 上限。
 *
 * ⚠ 问题面板那两条也随 1025 A 线（同日）变了口径：上一版的"首帧 60 条目 + 哨兵「继续显示」
 * 后面的问题"已退场——真窗口化后全量由滚动可达（几何账本钉在
 * `problem-virtual-rows.test.ts`，首帧节点预算钉在 `problem-panel-first-paint.test.ts`）。
 * 这里改成钉同一件事的两条底线：**首帧只挂窗口缺省条目数**（与总量无关）、
 * **总量写在 DOM 上且不再有分页哨兵**。"不到上界就不画哨兵"那条原样保留。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DirEntry } from '@kojo/plugin-api';
import { ProblemPanel, PROBLEM_VROWS_FALLBACK } from '../src/ui/ProblemPanel';
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

describe('检索面板 · 虚拟列表不许退回"死顶"（PERF 搜索批后的体量与常量口径）', () => {
  it('旧的死顶常量已经从面板里消失（不许留第二把尺）', () => {
    expect(UI('SearchPanel.tsx')).not.toContain('RENDER_CAP');
  });

  it('面板不再自带"继续显示"哨兵（全量改由滚动可达，窗口数学住 search-query）', () => {
    expect(UI('SearchPanel.tsx')).not.toContain('ksp-more');
    expect(UI('SearchPanel.tsx')).toContain('searchRowWindow');
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

describe('问题面板 · 1,000 条同样可达（旧实现：300 条封顶；上一版：哨兵分页）', () => {
  it('首帧只挂窗口缺省条目数（与总量无关），总量写进 DOM、分页哨兵退场', () => {
    clearAllProblems();
    setProblems('C:/game/ERB/001/M_KOJO_K1_0.ERB', mkProblems(1_000));
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    // 虚拟列表：条目 = 组头 1 + 行 1。本用例每条问题占一个独立 path ⇒ 一千个组、
    // 两千条目；首帧只画 `PROBLEM_VROWS_FALLBACK` 条（组头/行交替）。
    const heads = (markup.match(/class="prob-vrow-group/g) ?? []).length;
    const rows = (markup.match(/class="prob-item"/g) ?? []).length;
    expect(rows + heads).toBe(PROBLEM_VROWS_FALLBACK);
    expect(heads).toBe(PROBLEM_VROWS_FALLBACK / 2);
    expect(rows).toBe(PROBLEM_VROWS_FALLBACK / 2);
    // 总量（2,000 条目）写在列表上：滚动高度与读数同源，全量靠滚动可达
    expect(markup).toContain('data-prob-vrows="2000"');
    expect(markup).not.toContain('prob-more');
    clearAllProblems();
  });

  it('不到窗口上界 ⇒ 完全画满、不画哨兵（小面板零扰动）', () => {
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
