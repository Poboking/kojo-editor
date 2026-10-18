import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllProblems,
  clearProblems,
  currentVersion,
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

  it('W9：保留波浪线的列区间（面板跳源靠它，丢了就落回行首）', () => {
    const withSpan: EditorProblem = {
      path: 'a.erb',
      line: 4,
      severity: 'error',
      message: '结构不闭合',
      span: { columnStart: 3, columnEnd: 11 },
    };
    setProblems('a.erb', [withSpan]);
    expect(snapshot()[0]?.span).toEqual({ columnStart: 3, columnEnd: 11 });
    // 整份替换语义不变：新的没有区间就是真的没有区间（不留旧区间当幽灵）
    setProblems('a.erb', [mk('a.erb', 4, 'error')]);
    expect(snapshot()[0]?.span).toBeUndefined();
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

  /* ---------------- PS-15：版本号 + 脏标记（notify 只置脏，snapshot 脏时才算） ---------------- */

  it('同一版本内 snapshot 幂等（同引用）；实际变更 +1 版本且重算出新引用', () => {
    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    const v1 = currentVersion();
    const s1 = snapshot();
    expect(snapshot()).toBe(s1); // 干净时同引用（useSyncExternalStore 形态的前提）
    expect(currentVersion()).toBe(v1);

    setProblems('b.erb', [mk('b.erb', 1, 'error')]);
    expect(currentVersion()).toBe(v1 + 1); // 实际变更 +1
    const s2 = snapshot();
    expect(s2).not.toBe(s1); // 脏 ⇒ 重算出新引用
    expect(snapshot()).toBe(s2);
    expect(s2.map((x) => x.path)).toEqual(['a.erb', 'b.erb']); // 内容照旧按口径排序

    // 无实际变更（清不存在的键）不加版本、不动缓存
    clearProblems('nope.erb');
    expect(currentVersion()).toBe(v1 + 1);
    expect(snapshot()).toBe(s2);
  });

  it('notify N 次的重算读数：一批订阅方（渲染方们）醒来后各读一次，也只算一次', () => {
    // 一次外部写入常炸出多条 setProblems（逐文件整份重发）；合批后渲染方们
    // 各自 snapshot —— 第一个算，其余命中同一引用 ⇒ N 方读数零重复计算
    setProblems('a.erb', [mk('a.erb', 1, 'error')]);
    const seen: Array<readonly EditorProblem[]> = [];
    const readers = Array.from({ length: 5 }, () => {
      const un = subscribe(() => {
        seen.push(snapshot());
      });
      return un;
    });
    setProblems('b.erb', [mk('b.erb', 1, 'error')]);
    setProblems('c.erb', [mk('c.erb', 1, 'error')]);
    for (const un of readers) un();
    expect(seen).toHaveLength(10); // 5 方 × 2 次通知
    // 每版本只算一次：同一版本内 5 方醒来读的都是同一引用（10 次读 → 2 次计算）
    const firstBatch = seen.slice(0, 5);
    const secondBatch = seen.slice(5);
    for (const s of firstBatch) expect(s).toBe(firstBatch[0]);
    for (const s of secondBatch) expect(s).toBe(secondBatch[0]);
    expect(firstBatch[0]).not.toBe(secondBatch[0]); // 版本翻了（内容不同 ⇒ 新引用）
    expect(secondBatch[0]!.map((x) => x.path)).toEqual(['a.erb', 'b.erb', 'c.erb']);
  });
});
