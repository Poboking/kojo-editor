/**
 * 1025 性能批 · 问题面板首帧预算的钉子（P2-13 窗口口径的第二次修订）。
 *
 * 改前实测（eratw 语料 2,633 条 / 62 个文件分组，调试宿 CDP 探针）：打开面板最长帧
 * **137ms**、长任务 124 / 77ms，一次提交建 **2,533** 个 DOM 节点——拆分后是
 * 120 行 × 8 + **62 个组头 × 26**（组头比行还重：三枚计数徽标各 6 节点）。
 * 于是预算单位从「行」改成「条目（组头也算一条）」，首帧 60 条。
 *
 * 本文件钉两件事，防止"优化"在下一次重构里悄悄回退：
 * 1. `planVisibleEntries` 的纯判据（组头占预算、折叠把预算让出来、预算足够时全量出）；
 * 2. **首帧 DOM 节点上限**（真实语料形状的 SSR markup 计数）——这是本批唯一能进 CI 的
 *    体感代理：真机帧时长要起调试宿，节点数不必。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProblemPanel,
  PROBLEM_WINDOW_INITIAL,
  planVisibleEntries,
} from '../src/ui/ProblemPanel';
import { type ProblemGroup } from '../src/ui/problem-filter';
import { clearAllProblems, setProblems, type EditorProblem } from '../src/ui/problem-store';

afterEach(() => clearAllProblems());

const SEVERITIES = ['error', 'warning', 'info'] as const;

/** 真实语料的形状：62 个文件 / 2,633 条（eratw 口上语料那一轮的量级与分布） */
const CORPUS_FILES = 62;
const CORPUS_TOTAL = 2_633;

function loadCorpusShapedStore(): void {
  let made = 0;
  for (let f = 0; f < CORPUS_FILES; f++) {
    const path = `C:/game/ERB/口上/001/M_KOJO_K${f + 1}.ERB`;
    const perFile = Math.floor(CORPUS_TOTAL / CORPUS_FILES) + (f < CORPUS_TOTAL % CORPUS_FILES ? 1 : 0);
    const list: EditorProblem[] = Array.from({ length: perFile }, (_, i) => ({
      path,
      line: i + 1,
      severity: SEVERITIES[i % SEVERITIES.length] as EditorProblem['severity'],
      message: `第 ${i} 条问题：结构不闭合`,
    }));
    setProblems(path, list);
    made += perFile;
  }
  expect(made).toBe(CORPUS_TOTAL);
}

/** markup 里的元素节点数（开标签计数；`prob-count-sr` 这些文本腿不额外计） */
const nodeCount = (markup: string): number => (markup.match(/<[a-zA-Z]/g) ?? []).length;

const mkGroup = (path: string, count: number): ProblemGroup => {
  const items: EditorProblem[] = Array.from({ length: count }, (_, i) => ({
    path,
    line: i + 1,
    severity: 'error' as const,
    message: `m${i}`,
  }));
  return {
    path,
    label: path,
    items,
    indices: items.map((_, i) => i),
    counts: { error: count, warning: 0, info: 0 },
    startIndex: 0,
  };
};

describe('planVisibleEntries：组头与行同队吃预算', () => {
  it('预算 3 ⇒ 1 组头 + 2 行（组头不是"免费"的，它占一条）', () => {
    const plan = planVisibleEntries([mkGroup('A', 5)], new Set(), 3);
    expect(plan.totalEntries).toBe(6);
    expect(plan.shownEntries).toBe(3);
    expect(plan.shownRows).toBe(2);
  });

  it('预算 1 ⇒ 只有组头、零行（其余组连组头都不画：它们不占节点）', () => {
    const plan = planVisibleEntries([mkGroup('A', 5), mkGroup('B', 5)], new Set(), 1);
    expect(plan.groups).toHaveLength(1);
    expect(plan.shownRows).toBe(0);
    expect(plan.shownEntries).toBe(1);
    expect(plan.totalEntries).toBe(12);
  });

  it('折叠把行腾出来给后面的组头（折叠组的行不进条目表）', () => {
    const groups = [mkGroup('A', 5), mkGroup('B', 5)];
    const plan = planVisibleEntries(groups, new Set(['A']), 3);
    expect(plan.totalEntries).toBe(7); // 2 组头 + B 的 5 行
    expect(plan.groups.map((g) => g.group.path)).toEqual(['A', 'B']);
    expect(plan.groups[0]!.rows).toHaveLength(0);
    // 预算 3 = A 组头 + B 组头 + B 的第一行（折叠 A 让出的额度归 B）
    expect(plan.groups[1]!.rows).toHaveLength(1);
  });

  it('预算足够 ⇒ 全量出，一行不落（可达性判据：不是"只看前 N 条"）', () => {
    const groups = [mkGroup('A', 5), mkGroup('B', 5)];
    const plan = planVisibleEntries(groups, new Set(), 1_000);
    expect(plan.shownEntries).toBe(plan.totalEntries);
    expect(plan.shownRows).toBe(10);
  });
});

describe('首帧节点预算（真实语料形状 62 文件 / 2,633 条）', () => {
  it('首帧 DOM 节点 ≤800、可见行 ≤60：旧口径 2,533 节点已经回不去', () => {
    loadCorpusShapedStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const nodes = nodeCount(markup);
    const rows = (markup.match(/class="prob-item"/g) ?? []).length;
    const heads = (markup.match(/class="prob-group-head"/g) ?? []).length;
    expect(rows, '首帧可见行超 60').toBeLessThanOrEqual(60);
    expect(rows + heads, '首帧条目超上界').toBeLessThanOrEqual(PROBLEM_WINDOW_INITIAL);
    // 800 是"一次提交 ≤800 节点"的目标线；实测典型形态约 500，余量留给工具条与组头
    expect(nodes, `首帧建了 ${nodes} 个节点`).toBeLessThanOrEqual(800);
  });

  it('首帧不是死顶：哨兵在场且如实说还有多少行（可达性不降级）', () => {
    loadCorpusShapedStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const rows = (markup.match(/class="prob-item"/g) ?? []).length;
    expect(markup).toContain('prob-more');
    expect(markup).toContain(`还有 ${CORPUS_TOTAL - rows} 条，共 ${CORPUS_TOTAL} 条`);
  });
});
