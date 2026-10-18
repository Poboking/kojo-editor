import { describe, expect, it } from 'vitest';
import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  GameProject,
  LineDecoration,
} from '@kojo/plugin-api';
import type { EditorProblem } from '../src/ui/problem-store';
import {
  ALL_SEVERITIES,
  collectRowFix,
  filterProblems,
  groupProblems,
  planLineEdits,
  problemCopyText,
  problemLineDecoration,
  readProblemFixHost,
  rowFixKey,
  setProblemFixHost,
} from '../src/ui/problem-fix';

/* ══════════════════════════ 造数 ══════════════════════════ */

const mkProblem = (over: Partial<EditorProblem> & { path: string; line: number }): EditorProblem => ({
  severity: 'error',
  message: '缺 else 分支',
  ...over,
});

const decorationOf = (p: EditorProblem): LineDecoration => problemLineDecoration(p);

const fakeContribution = (
  id: string,
  provide: () => readonly EditorCodeAction[],
): EditorCodeActionContribution => ({
  id,
  provideActions: () => [...provide()],
});

/** 一条认领第 `diagLine` 行「缺 else 分支」诊断的快速修复（带一行改写） */
const fixAction = (title: string, diagLine: number): EditorCodeAction => ({
  title,
  kind: 'quickfix',
  diagnostics: [{ line: diagLine, severity: 'error', message: '缺 else 分支' }],
  edits: [{ fromLine: diagLine, toLine: diagLine, newText: '...;' }],
  run: () => undefined,
});

/* ══════════════════════════ ① 过滤 ══════════════════════════ */

describe('filterProblems（P2-13 过滤）', () => {
  const items: readonly EditorProblem[] = [
    mkProblem({ path: 'C:/g/a.erb', line: 1, severity: 'error', message: '缺 else 分支', code: 'erb.1001' }),
    mkProblem({ path: 'C:/g/b.erb', line: 2, severity: 'warning', message: '表达式恒真', code: 'erb.2002' }),
    mkProblem({ path: 'C:/g/c.erb', line: 3, severity: 'info', message: '提示一下' }),
  ];
  const all = new Set(ALL_SEVERITIES);

  it('全开 + 空文本 = 不过滤（旧口径逐字一致）', () => {
    expect(filterProblems(items, { severities: all, text: '' })).toHaveLength(3);
  });

  it('严重级多选：任一命中即留', () => {
    const out = filterProblems(items, { severities: new Set(['error', 'info']), text: '' });
    expect(out.map((p) => p.severity)).toEqual(['error', 'info']);
  });

  it('文本子串不区分大小写，且 message 与诊断码都参与', () => {
    expect(filterProblems(items, { severities: all, text: 'ELSE' }).map((p) => p.code)).toEqual(['erb.1001']);
    expect(filterProblems(items, { severities: all, text: 'erb.2' }).map((p) => p.line)).toEqual([2]);
  });

  it('空格只当装饰（trim 后为空 = 不过滤）', () => {
    expect(filterProblems(items, { severities: all, text: '   ' })).toHaveLength(3);
  });
});

/* ══════════════════════════ ② 分组 ══════════════════════════ */

describe('groupProblems（P2-13 分组）', () => {
  it('按路径分组、组序 = 首次出现序、组内保序、计数分色', () => {
    const items: readonly EditorProblem[] = [
      mkProblem({ path: 'C:/g/a.erb', line: 1, severity: 'error' }),
      mkProblem({ path: 'C:/g/a.erb', line: 5, severity: 'warning' }),
      mkProblem({ path: 'C:/g/b.erb', line: 2, severity: 'error' }),
      mkProblem({ path: 'C:/g/a.erb', line: 9, severity: 'error' }),
    ];
    const groups = groupProblems(items);
    expect(groups.map((g) => g.path)).toEqual(['C:/g/a.erb', 'C:/g/b.erb']);
    expect(groups[0]!.items.map((p) => p.line)).toEqual([1, 5, 9]);
    expect(groups[0]!.counts).toEqual({ error: 2, warning: 1, info: 0 });
    expect(groups[1]!.counts).toEqual({ error: 1, warning: 0, info: 0 });
  });

  it('indices 与 items 一一同序，且记的是过滤后全序下标（同一路径跨严重级段不连续也记得住）', () => {
    const items: readonly EditorProblem[] = [
      mkProblem({ path: 'C:/g/a.erb', line: 1, severity: 'error' }),
      mkProblem({ path: 'C:/g/b.erb', line: 2, severity: 'error' }),
      mkProblem({ path: 'C:/g/a.erb', line: 9, severity: 'warning' }),
    ];
    const groups = groupProblems(items);
    expect(groups[0]!.indices).toEqual([0, 2]);
    expect(groups[0]!.items.map((p) => p.line)).toEqual([1, 9]);
    expect(groups[1]!.indices).toEqual([1]);
    expect(groups[0]!.startIndex).toBe(0);
    expect(groups[1]!.startIndex).toBe(1);
  });
});

/* ══════════════════════════ ③ 复制文案 ══════════════════════════ */

describe('problemCopyText（P2-13 复制）', () => {
  it('完整路径:行号 [severity] 消息', () => {
    expect(
      problemCopyText({ path: 'C:/g/a.erb', line: 12, severity: 'error', message: '缺 else 分支' }),
    ).toBe('C:/g/a.erb:12 [error] 缺 else 分支');
  });
});

/* ══════════════════════════ ④ 行内修复 ══════════════════════════ */

describe('problemLineDecoration / rowFixKey', () => {
  it('span / code / source 逐字段带回去（认领匹配才对得上）', () => {
    const p = mkProblem({
      path: 'C:/g/a.erb',
      line: 7,
      message: '缺 else 分支',
      code: 'erb.1001',
      source: 'erb-parser',
      span: { columnStart: 3, columnEnd: 9 },
    });
    const d = decorationOf(p);
    expect(d.line).toBe(7);
    expect(d.message).toBe('缺 else 分支');
    expect(d.code).toBe('erb.1001');
    expect(d.source).toBe('erb-parser');
    expect(d.startColumn).toBe(3);
    expect(d.endColumn).toBe(9);
  });

  it('同一条诊断的 key 稳定；不同码分键', () => {
    const a = mkProblem({ path: 'C:/g/a.erb', line: 7, code: 'erb.1001' });
    const b = mkProblem({ path: 'C:/g/a.erb', line: 7, code: 'erb.1002' });
    expect(rowFixKey(a)).toBe(rowFixKey({ ...a }));
    expect(rowFixKey(a)).not.toBe(rowFixKey(b));
  });
});

describe('collectRowFix（唯一解判据，与 💡 isPreferred 同底座）', () => {
  const problem = mkProblem({ path: 'C:/g/a.erb', line: 7, message: '缺 else 分支' });
  const request = {
    path: problem.path,
    text: 'if true\n  x = 1\n',
    project: null as GameProject | null,
    lineCount: 2,
    line: problem.line,
    diagnostic: decorationOf(problem),
  };

  it('恰好一条快速修复认领 ⇒ 返回那条', () => {
    const contribs = [fakeContribution('only', () => [fixAction('补 else', 7)])];
    const action = collectRowFix(contribs, request);
    expect(action?.title).toBe('补 else');
  });

  it('零条认领 ⇒ undefined（不给死按钮，铁律 4）', () => {
    const contribs = [fakeContribution('none', () => [])];
    expect(collectRowFix(contribs, request)).toBeUndefined();
  });

  it('两条认领 ⇒ undefined（多解不替作者选）', () => {
    const contribs = [
      fakeContribution('a', () => [fixAction('解法一', 7)]),
      fakeContribution('b', () => [fixAction('解法二', 7)]),
    ];
    expect(collectRowFix(contribs, request)).toBeUndefined();
  });

  it('认领别的诊断的动作不计数；refactor 类不参与', () => {
    const contribs = [
      fakeContribution('other-line', () => [fixAction('修别行', 99)]),
      fakeContribution('refactor', () => [
        { title: '改写法', kind: 'refactor' as const, diagnostics: [{ line: 7, severity: 'error' as const, message: '缺 else 分支' }], edits: [], run: () => undefined },
      ]),
    ];
    expect(collectRowFix(contribs, request)).toBeUndefined();
  });

  it('贡献隔离抛错：单贡献炸只丢它自己，其余照答', () => {
    const contribs = [
      fakeContribution('boom', () => {
        throw new Error('插件炸了');
      }),
      fakeContribution('good', () => [fixAction('补 else', 7)]),
    ];
    const action = collectRowFix(contribs, request);
    expect(action?.title).toBe('补 else');
  });
});

describe('planLineEdits（夹取 + 降序，判据照 applyTextEdits 同源）', () => {
  it('行号夹取：越界折回、NaN 折缺省、to < from 折回 from', () => {
    const planned = planLineEdits(3, [
      { fromLine: 99, toLine: 999, newText: 'x' },
      { fromLine: Number.NaN, toLine: 0, newText: 'y' },
    ]);
    expect(planned).toEqual([
      { fromLine: 3, toLine: 3, newText: 'x' },
      { fromLine: 1, toLine: 1, newText: 'y' },
    ]);
  });

  it('降序应用 + 空计划 / 非法行数 = 空', () => {
    const planned = planLineEdits(10, [
      { fromLine: 2, toLine: 3, newText: 'a' },
      { fromLine: 8, toLine: 8, newText: 'b' },
    ]);
    expect(planned.map((e) => e.fromLine)).toEqual([8, 2]);
    expect(planLineEdits(10, [])).toEqual([]);
    expect(planLineEdits(0, [{ fromLine: 1, toLine: 1, newText: 'x' }])).toEqual([]);
  });
});

/* ══════════════════════════ ⑤ 宿主座 ══════════════════════════ */

describe('宿主座（setProblemFixHost / readProblemFixHost）', () => {
  it('缺省 null；注册后读得到；清座回到 null', () => {
    expect(readProblemFixHost()).toBeNull();
    setProblemFixHost({
      codeActionContributions: () => [],
      project: () => null,
      documentOf: () => null,
      applyRowFix: async () => false,
    });
    expect(readProblemFixHost()).not.toBeNull();
    setProblemFixHost(null);
    expect(readProblemFixHost()).toBeNull();
  });
});
