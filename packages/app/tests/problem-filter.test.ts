/**
 * 问题面板纯逻辑层单测（批次十 S14，2026-10-23）。
 *
 * 钉死四件事：**过滤**（严重级 / 来源 / 文本，中文大小写不敏感、字面匹配不走正则）、
 * **分组与计数**（组序 = 首次出现序、组内下标与全序对齐、三档计数）、**稳定排序**
 * （同键保原序）、**过滤条件持久化**（记住选择；无 window / 坏值 / 隐私模式一律回默认、绝不抛）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EditorProblem } from '../src/ui/problem-store';
import {
  ALL_SEVERITIES,
  countProblems,
  DEFAULT_PROBLEM_FILTER,
  filterOfPrefs,
  filterProblems,
  groupProblems,
  isFiltering,
  loadProblemFilterPrefs,
  saveProblemFilterPrefs,
  sortProblemList,
  sourceOptions,
  UNLABELED_SOURCE,
  type ProblemFilter,
} from '../src/ui/problem-filter';

/* ══════════════════════════ 造数 ══════════════════════════ */

const mkProblem = (over: Partial<EditorProblem> & { path: string; line: number }): EditorProblem => ({
  severity: 'error',
  message: '缺 else 分支',
  ...over,
});

const allSources = (): ProblemFilter => ({ severities: new Set(ALL_SEVERITIES), sources: null, text: '' });

/* ══════════════════════════ ① 过滤 ══════════════════════════ */

describe('filterProblems（严重级 / 来源 / 文本）', () => {
  const items: readonly EditorProblem[] = [
    mkProblem({
      path: 'C:/g/a.erb',
      line: 1,
      severity: 'error',
      message: '缺 ELSE 分支',
      code: 'erb.1001',
      source: 'erb-parser',
    }),
    mkProblem({
      path: 'C:/g/b.erb',
      line: 2,
      severity: 'warning',
      message: '表达式恒真',
      code: 'erb.2002',
      source: 'condition-extractor',
    }),
    mkProblem({ path: 'C:/g/c.erb', line: 3, severity: 'info', message: '提示一下' }),
  ];

  it('缺省判据 = 不过滤（严重级全开 / 全部来源 / 空文本）', () => {
    expect(filterProblems(items, allSources())).toHaveLength(3);
  });

  it('严重级多选：任一命中即留；空集合 = 一条都不留', () => {
    expect(
      filterProblems(items, { severities: new Set(['error', 'info']), sources: null, text: '' }).map(
        (p) => p.severity,
      ),
    ).toEqual(['error', 'info']);
    expect(
      filterProblems(items, { severities: new Set(), sources: null, text: '' }),
    ).toEqual([]);
  });

  it('多来源：按来源集合筛，`null` = 全部来源', () => {
    const out = filterProblems(items, {
      severities: new Set(ALL_SEVERITIES),
      sources: new Set(['erb-parser', 'condition-extractor']),
      text: '',
    });
    expect(out.map((p) => p.source)).toEqual(['erb-parser', 'condition-extractor']);

    const one = filterProblems(items, {
      severities: new Set(ALL_SEVERITIES),
      sources: new Set(['condition-extractor']),
      text: '',
    });
    expect(one.map((p) => p.line)).toEqual([2]);
  });

  it('未标注来源归到空键（不是"匹配不到任何来源"）', () => {
    const out = filterProblems(items, {
      severities: new Set(ALL_SEVERITIES),
      sources: new Set([UNLABELED_SOURCE]),
      text: '',
    });
    expect(out.map((p) => p.line)).toEqual([3]);
  });

  it('文本子串：中文与拉丁都不区分大小写（ELSE / else 同一条路）', () => {
    const base = { severities: new Set(ALL_SEVERITIES), sources: null };
    expect(filterProblems(items, { ...base, text: 'else' }).map((p) => p.line)).toEqual([1]);
    expect(filterProblems(items, { ...base, text: 'ELSE' }).map((p) => p.line)).toEqual([1]);
    expect(filterProblems(items, { ...base, text: '恒真' }).map((p) => p.line)).toEqual([2]);
  });

  it('文本匹配 message / code / source / path 四样可见信息', () => {
    const base = { severities: new Set(ALL_SEVERITIES), sources: null };
    expect(filterProblems(items, { ...base, text: 'erb.2' }).map((p) => p.line)).toEqual([2]);
    expect(filterProblems(items, { ...base, text: 'condition-' }).map((p) => p.line)).toEqual([2]);
    expect(filterProblems(items, { ...base, text: 'c.erb' }).map((p) => p.line)).toEqual([3]);
  });

  it('字面匹配，不走正则：`.*`、`.`、`(` 一律按字符本身找', () => {
    const base = { severities: new Set(ALL_SEVERITIES), sources: null };
    const literal = [
      mkProblem({ path: 'C:/g/a.erb', line: 1, message: '写成了 a.b' }),
      mkProblem({ path: 'C:/g/b.erb', line: 2, message: '写成了 axxb' }),
    ];
    expect(filterProblems(literal, { ...base, text: 'a.b' }).map((p) => p.line)).toEqual([1]);
    expect(filterProblems(literal, { ...base, text: 'a.*b' })).toEqual([]);
    expect(filterProblems(literal, { ...base, text: '(b' })).toEqual([]);
  });

  it('空格只当装饰（trim 后为空 = 不过滤）；0 条入参返回空', () => {
    const base = { severities: new Set(ALL_SEVERITIES), sources: null };
    expect(filterProblems(items, { ...base, text: '   ' })).toHaveLength(3);
    expect(filterProblems([], allSources())).toEqual([]);
  });

  it('isFiltering：缺省不算筛，动了任一维才算', () => {
    expect(isFiltering(allSources())).toBe(false);
    expect(isFiltering({ ...allSources(), text: '  ' })).toBe(false);
    expect(isFiltering({ ...allSources(), text: 'x' })).toBe(true);
    expect(isFiltering({ ...allSources(), severities: new Set(['error']) })).toBe(true);
    expect(isFiltering({ ...allSources(), sources: new Set() })).toBe(true);
  });
});

/* ══════════════════════════ ② 来源清单 ══════════════════════════ */

describe('sourceOptions（下拉选项 + 计数）', () => {
  it('序 = 首次出现序；计数 = 条数；缺 source 的给中文占位', () => {
    const opts = sourceOptions([
      mkProblem({ path: 'a', line: 1, source: 'erb-parser' }),
      mkProblem({ path: 'b', line: 1, source: 'condition-extractor' }),
      mkProblem({ path: 'c', line: 1 }),
      mkProblem({ path: 'd', line: 1, source: 'erb-parser' }),
    ]);
    expect(opts).toEqual([
      { key: 'erb-parser', label: 'erb-parser', count: 2 },
      { key: 'condition-extractor', label: 'condition-extractor', count: 1 },
      { key: UNLABELED_SOURCE, label: '未标注来源', count: 1 },
    ]);
  });

  it('0 条 ⇒ 空清单（面板据此不给下拉）', () => {
    expect(sourceOptions([])).toEqual([]);
  });
});

/* ══════════════════════════ ③ 计数 ══════════════════════════ */

describe('countProblems（全局与每组同一把尺）', () => {
  it('三档计数 + 总数；0 条全为 0', () => {
    expect(
      countProblems([
        mkProblem({ path: 'a', line: 1, severity: 'error' }),
        mkProblem({ path: 'a', line: 2, severity: 'warning' }),
        mkProblem({ path: 'b', line: 1, severity: 'info' }),
        mkProblem({ path: 'b', line: 2, severity: 'info' }),
      ]),
    ).toEqual({ error: 1, warning: 1, info: 2, total: 4 });
    expect(countProblems([])).toEqual({ error: 0, warning: 0, info: 0, total: 0 });
  });
});

/* ══════════════════════════ ④ 稳定排序 ══════════════════════════ */

describe('sortProblemList（severity → path → line，同键保原序）', () => {
  it('按严重级、路径、行号排；不改入参', () => {
    const input = [
      mkProblem({ path: 'C:/g/b.erb', line: 1, severity: 'info' }),
      mkProblem({ path: 'C:/g/b.erb', line: 2, severity: 'error' }),
      mkProblem({ path: 'C:/g/a.erb', line: 9, severity: 'error' }),
      mkProblem({ path: 'C:/g/a.erb', line: 3, severity: 'error' }),
    ];
    const out = sortProblemList(input);
    expect(out.map((p) => `${p.severity}:${p.path}:${p.line}`)).toEqual([
      'error:C:/g/a.erb:3',
      'error:C:/g/a.erb:9',
      'error:C:/g/b.erb:2',
      'info:C:/g/b.erb:1',
    ]);
    expect(input[0]!.severity).toBe('info'); // 入参零改动
  });

  it('键全相等时保持入参原序（稳定：第二条永远排在第一条后面）', () => {
    const first = mkProblem({ path: 'C:/g/a.erb', line: 1, message: '第一条' });
    const second = mkProblem({ path: 'C:/g/a.erb', line: 1, message: '第二条' });
    const out = sortProblemList([first, second]);
    expect(out.map((p) => p.message)).toEqual(['第一条', '第二条']);
  });

  it('0 条 ⇒ 空数组', () => {
    expect(sortProblemList([])).toEqual([]);
  });
});

/* ══════════════════════════ ⑤ 分组 ══════════════════════════ */

describe('groupProblems（按文件分组）', () => {
  it('组序 = 首次出现序、组内保序、计数分档、indices 记全局下标', () => {
    const items: readonly EditorProblem[] = [
      mkProblem({ path: 'C:/g/a.erb', line: 1, severity: 'error' }),
      mkProblem({ path: 'C:/g/b.erb', line: 2, severity: 'error' }),
      mkProblem({ path: 'C:/g/a.erb', line: 5, severity: 'warning' }),
      mkProblem({ path: 'C:/g/a.erb', line: 9, severity: 'error' }),
    ];
    const groups = groupProblems(items);
    expect(groups.map((g) => g.path)).toEqual(['C:/g/a.erb', 'C:/g/b.erb']);
    expect(groups[0]!.items.map((p) => p.line)).toEqual([1, 5, 9]);
    expect(groups[0]!.indices).toEqual([0, 2, 3]);
    expect(groups[0]!.counts).toEqual({ error: 2, warning: 1, info: 0 });
    expect(groups[0]!.startIndex).toBe(0);
    expect(groups[1]!.startIndex).toBe(1);
  });

  it('0 条 ⇒ 空分组、无组头可画', () => {
    expect(groupProblems([])).toEqual([]);
  });
});

/* ══════════════════════════ ⑥ 持久化 ══════════════════════════ */

/** 假 localStorage（与 panel-prefs.test.ts 同款：只做键值袋） */
function fakeWindow(seed: Record<string, string> = {}) {
  const bag = new Map(Object.entries(seed));
  return {
    localStorage: {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
      clear: () => bag.clear(),
      key: () => null,
      length: 0,
    },
    bag,
  };
}

const w = globalThis as unknown as { window?: unknown };
afterEach(() => {
  delete w.window;
});

const KEY = 'kojo.ui.problemFilter.v1';

describe('过滤条件持久化', () => {
  it('无 window ⇒ 回默认（全开 / 全部来源 / 空文本），写也不抛', () => {
    expect(loadProblemFilterPrefs()).toEqual(DEFAULT_PROBLEM_FILTER);
    expect(() => saveProblemFilterPrefs({ severities: ['error'], source: 'x', text: 'y' })).not.toThrow();
  });

  it('写过之后按记录走；缺省读回同一份默认', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadProblemFilterPrefs()).toEqual(DEFAULT_PROBLEM_FILTER);

    saveProblemFilterPrefs({ severities: ['error', 'info'], source: 'erb-parser', text: 'else' });
    expect(f.bag.get(KEY)).toBe(
      JSON.stringify({ severities: ['error', 'info'], source: 'erb-parser', text: 'else' }),
    );
    expect(loadProblemFilterPrefs()).toEqual({
      severities: ['error', 'info'],
      source: 'erb-parser',
      text: 'else',
    });
  });

  it('坏值 / 形状不对 ⇒ 逐字段保守回落（不阻塞启动）', () => {
    w.window = fakeWindow({ [KEY]: '{not json' });
    expect(loadProblemFilterPrefs()).toEqual(DEFAULT_PROBLEM_FILTER);

    w.window = fakeWindow({
      [KEY]: JSON.stringify({ severities: 'error', source: 42, text: null }),
    });
    expect(loadProblemFilterPrefs()).toEqual(DEFAULT_PROBLEM_FILTER);

    w.window = fakeWindow({
      [KEY]: JSON.stringify({ severities: ['info', 'bogus', 'error', 'info'], source: '', text: 7 }),
    });
    // 未知档去掉、去重、按契约固定序；空字符串是"未标注来源"这个合法键，照留
    expect(loadProblemFilterPrefs()).toEqual({
      severities: ['error', 'info'],
      source: '',
      text: '',
    });
  });

  it('空严重级数组是作者"一档都不看"的真实选择，照存不补默认', () => {
    w.window = fakeWindow({ [KEY]: JSON.stringify({ severities: [], source: null, text: '' }) });
    expect(loadProblemFilterPrefs().severities).toEqual([]);
  });

  it('localStorage 抛错（隐私模式 / 配额满）⇒ 读回默认、写不抛', () => {
    w.window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    expect(loadProblemFilterPrefs()).toEqual(DEFAULT_PROBLEM_FILTER);
    expect(() => saveProblemFilterPrefs(DEFAULT_PROBLEM_FILTER)).not.toThrow();
  });

  it('filterOfPrefs：来源 null = 全部来源；单值折成单元素集合', () => {
    expect(filterOfPrefs({ severities: ['error'], source: null, text: 'x' }).sources).toBeNull();
    const filter = filterOfPrefs({ severities: ['error'], source: 'erb-parser', text: '' });
    expect(filter.sources).toEqual(new Set(['erb-parser']));
    expect(filter.severities).toEqual(new Set(['error']));
  });
});
