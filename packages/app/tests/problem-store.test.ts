import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllProblems,
  clearProblems,
  setProblems,
  snapshot,
  sortProblems,
  subscribe,
  type EditorProblem,
} from '../src/ui/problem-store';

/**
 * 问题汇总（看板 HK-4 · UI-6）单测。
 *
 * 钉两件事：①注册表的整份替换 / 删键 / 清空语义（标签关闭要能清干净，不留幽灵诊断）；
 * ②`sortProblems` 的展示排序口径（severity → path → line），供底部面板与状态栏复用。
 */

const mk = (
  path: string,
  line: number,
  severity: EditorProblem['severity'],
  message = 'm',
  code?: string,
): EditorProblem => ({ path, line, severity, message, ...(code ? { code } : {}) });

describe('problem-store', () => {
  beforeEach(() => {
    clearAllProblems();
  });

  it('setProblems：整份替换；空数组即删键', () => {
    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    expect(snapshot()).toHaveLength(1);

    setProblems('a.erb', [mk('a.erb', 2, 'warning'), mk('a.erb', 5, 'info')]);
    expect(snapshot().map((x) => x.line).sort((a, b) => a - b)).toEqual([2, 5]);

    setProblems('a.erb', []);
    expect(snapshot()).toHaveLength(0);
  });

  it('setProblems：保留 code 可选字段', () => {
    setProblems('a.erb', [mk('a.erb', 1, 'error', 'boom', 'sugar.expr-missing-else')]);
    expect(snapshot()[0]?.code).toBe('sugar.expr-missing-else');
    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    expect(snapshot()[0]?.code).toBeUndefined();
  });

  it('clearProblems：只清指定路径，其余不动', () => {
    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    setProblems('b.erb', [mk('b.erb', 1, 'error')]);
    clearProblems('a.erb');
    expect(snapshot().map((x) => x.path)).toEqual(['b.erb']);
  });

  it('clearAllProblems：清空全部', () => {
    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    setProblems('b.erb', [mk('b.erb', 1, 'error')]);
    clearAllProblems();
    expect(snapshot()).toHaveLength(0);
  });

  it('snapshot 排序口径：severity → path → line', () => {
    setProblems('b.erb', [mk('b.erb', 9, 'info'), mk('b.erb', 3, 'error'), mk('b.erb', 3, 'warning')]);
    setProblems('a.erb', [mk('a.erb', 7, 'warning'), mk('a.erb', 2, 'error')]);

    expect(snapshot().map((x) => `${x.severity} ${x.path} ${x.line}`)).toEqual([
      'error a.erb 2',
      'error b.erb 3',
      'warning a.erb 7',
      'warning b.erb 3',
      'info b.erb 9',
    ]);
  });

  it('sortProblems：返回新数组，不改动入参（引用不变性）', () => {
    const list = [mk('a', 1, 'warning'), mk('a', 1, 'error')];
    const sorted = sortProblems(list);
    expect(sorted.map((x) => x.severity)).toEqual(['error', 'warning']);
    expect(list.map((x) => x.severity)).toEqual(['warning', 'error']);
  });

  it('subscribe：变更即通知；退订后不再收到', () => {
    const listener = vi.fn();
    const un = subscribe(listener);

    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    expect(listener).toHaveBeenCalledTimes(1);

    clearProblems('a.erb');
    expect(listener).toHaveBeenCalledTimes(2);

    un();
    setProblems('b.erb', [mk('b.erb', 1, 'error')]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('subscribe：无实际变更（清不存在的键 / 空数组删不存在的键）不通知', () => {
    const listener = vi.fn();
    subscribe(listener);

    clearProblems('nope.erb');
    setProblems('nope.erb', []);
    clearAllProblems();

    expect(listener).not.toHaveBeenCalled();
  });
});
