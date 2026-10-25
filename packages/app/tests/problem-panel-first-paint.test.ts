/**
 * 1025 性能批 A 线 · 问题面板**真窗口化**的钉子（上一版"条目预算 + 分片补窗"已退场）。
 *
 * ## 为什么再改一次（上一批的记录，别再走回头路）
 *
 * 上一批把预算单位从「行」改成「条目（组头也算一条）」，首帧 60 条 + 哨兵 + rIC 分片：
 * 首帧 137 → 53ms，但**滚动 / 连点仍慢**（哨兵连点 52.4 / 89.7 / 109.3ms，长任务
 * 0/2/3），且基数越大越慢（59 行 31.5ms → 296 行 99ms → 648 行 100–160ms）。
 * perf 报告 `scriptMs 0 / renderMs 159`、行组件 memo 化后"行渲染次数"确实降了而
 * **墙钟不动** ⇒ 钱付在**布局**上。唯一达标路径是 DOM 恒定：本批改成视口窗口
 * （与检索面板 `search-rows` + `SearchPanel` 同模板），DOM 行数与总诊断数解耦。
 *
 * ## 本文件钉什么
 *
 * 1. `problemRowsOf` 的投影判据：组头占一行、折叠在**投影层**减行、不折叠时全量；
 * 2. **首帧 DOM 上界**（真实语料形状的 SSR markup 计数）：条目 = `PROBLEM_VROWS_FALLBACK`，
 *    行 ≤ 60、节点 ≤ 800——旧口径的 2,533 节点与"条目预算 60"都回不去了；
 * 3. **可达性换了承载物**：不再有「继续显示」哨兵（那是按 N 次点击分页的入口），
 *    全量由滚动可达（滚动高度 = 全量行高之和，见 `problem-virtual-rows.test.ts`）；
 *    屏幕上仍必须有**总量读数**（表头三档之和 = 全量），作者一眼看得出"远不止这一屏"。
 *
 * 口径变更的理由：旧断言钉的是"哨兵在场 + 还有 N 条"这种分页形态；虚拟列表里它已不成立
 * （不是放松判据——首帧节点更少、行数上界更硬、可达性改由几何账本钉，见新文件）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProblemPanel, PROBLEM_VROWS_FALLBACK } from '../src/ui/ProblemPanel';
import { problemRowOffsets, problemRowWindow, problemRowsOf } from '../src/ui/problem-rows';
import { PROBLEM_ROW_HEIGHTS_FALLBACK } from '../src/ui/problem-rows';
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

/** 同一文件下 n 条（小面板零扰动那条用例的形态：一个组 + n 行） */
const mkProblems = (n: number): EditorProblem[] =>
  Array.from({ length: n }, (_, i) => ({
    path: 'C:/game/ERB/001/M_KOJO_K1_0.ERB',
    line: i + 1,
    severity: 'error' as const,
    message: `第 ${i} 条问题`,
  }));

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

describe('problemRowsOf：组头占一行、折叠在投影层减行', () => {
  it('组头与行同队（一个 5 行的组 = 6 条扁平行）', () => {
    const rows = problemRowsOf([mkGroup('A', 5)]);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.kind).toBe('group');
    expect(rows.slice(1).every((r) => r.kind === 'item')).toBe(true);
    // 行带着它在过滤后全序里的下标（渲染 key 与回执键要用）
    expect(rows.slice(1).map((r) => (r.kind === 'item' ? r.itemIndex : -1))).toEqual([0, 1, 2, 3, 4]);
  });

  it('折叠组只剩组头（行不进清单 ⇒ 账本不折叠掉的行留空白）', () => {
    const groups = [mkGroup('A', 5), mkGroup('B', 5)];
    const folded = problemRowsOf(groups, new Set(['A']));
    expect(folded).toHaveLength(1 + 5 + 1); // A 组头 + B 组头 + B 的 5 行
    expect(folded.filter((r) => r.kind === 'group')).toHaveLength(2);
  });

  it('不折叠 ⇒ 全量（不是"只看前 N 条"：可达性由几何承载，见虚拟窗口测试）', () => {
    const groups = [mkGroup('A', 5), mkGroup('B', 5)];
    expect(problemRowsOf(groups)).toHaveLength(2 + 10);
  });
});

describe('虚拟窗口：两档行高的账本与切片', () => {
  const rows = problemRowsOf([mkGroup('A', 3), mkGroup('B', 3)]);
  const H = PROBLEM_ROW_HEIGHTS_FALLBACK;

  it('组头与行高不同 ⇒ 偏移逐行累加，总高 = 两档行高之和', () => {
    const { offsets, total } = problemRowOffsets(rows, H);
    expect(offsets).toHaveLength(rows.length + 1);
    expect(total).toBe(2 * H.group + 6 * H.item);
    // 第 2 条（B 组头）的顶边 = A 组头 + A 的 3 行
    expect(offsets[4]).toBe(H.group + 3 * H.item);
  });

  it('留白 + 窗口内行高 === 总高（滚动条不说谎）', () => {
    const { offsets, total } = problemRowOffsets(rows, H);
    for (const top of [0, 20, 90, total - 30, total]) {
      const w = problemRowWindow(offsets, top, 60, 40);
      let sum = 0;
      for (let i = w.start; i < w.end; i += 1) sum += rows[i]!.kind === 'group' ? H.group : H.item;
      expect(w.topPad + sum + w.bottomPad).toBeCloseTo(total, 6);
    }
  });

  it('窗口长度有上界：可见 1 行也一样（不随总数长）', () => {
    const { offsets } = problemRowOffsets(rows, H);
    const w = problemRowWindow(offsets, 0, 60, 40);
    expect(w.end - w.start).toBeLessThanOrEqual(Math.ceil((60 + 80) / H.item) + 2);
  });
});

describe('首帧节点预算（真实语料形状 62 文件 / 2,633 条）', () => {
  it('首帧只挂 PROBLEM_VROWS_FALLBACK 条：行 ≤60、节点 ≤800，旧口径 2,533 节点回不去', () => {
    loadCorpusShapedStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const nodes = nodeCount(markup);
    const rows = (markup.match(/class="prob-item"/g) ?? []).length;
    const heads = (markup.match(/class="prob-vrow-group/g) ?? []).length;
    expect(rows, '首帧可见行超 60').toBeLessThanOrEqual(60);
    expect(rows + heads, '首帧条目超窗口缺省上界').toBe(PROBLEM_VROWS_FALLBACK);
    expect(rows + heads).toBeLessThanOrEqual(60);
    // 800 是"一次提交 ≤800 节点"的目标线；实测约 350，余量留给工具条与组头
    expect(nodes, `首帧建了 ${nodes} 个节点`).toBeLessThanOrEqual(800);
  });

  it('总条目数写进 DOM（几何/读数同源），且「继续显示」哨兵已退场', () => {
    loadCorpusShapedStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain(`data-prob-vrows="${CORPUS_TOTAL + CORPUS_FILES}"`);
    expect(markup).not.toContain('prob-more');
    expect(markup).not.toContain('继续显示后面的问题');
    expect(markup).not.toContain('正在补齐');
  });

  it('总量读数仍在屏上（哨兵退场后的替代物）：三档之和 = 全量 2,633', () => {
    loadCorpusShapedStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const g = (word: string): number => Number(markup.match(new RegExp(`>${word} (\\d+)<`))?.[1] ?? 0);
    // 表头三档（面板自己的读数腿；与状态栏 / 组头同一份 summarizeProblems）
    expect(g('错误') + g('警告') + g('提示')).toBe(CORPUS_TOTAL);
    expect(g('错误')).toBeGreaterThan(0);
  });

  it('小面板零扰动：9 条 ⇒ 9 行全画、零留白、无哨兵', () => {
    setProblems('C:/game/ERB/001/M_KOJO_K1_0.ERB', mkProblems(9));
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect((markup.match(/class="prob-item"/g) ?? []).length).toBe(9);
    expect(markup).not.toContain('prob-more');
    // 首屏缺省窗口已经装得下 ⇒ 总条目数写在 DOM 上（1 个组头 + 9 行），没有"没画出来"的
    expect(markup).toContain('data-prob-vrows="10"');
  });
});
