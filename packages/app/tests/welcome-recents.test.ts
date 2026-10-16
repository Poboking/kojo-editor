import { describe, expect, it } from 'vitest';
import type { FileStat, RecentProject } from '@kojo/plugin-api';
import { recentRowState, recentStatKey, removeRecentOptimistic } from '../src/ui/WelcomeView';

/**
 * 欢迎页最近列表管理（A4 UI 批）的纯函数半边：
 * 「recents + stat 结果 → 行渲染态」、探测缓存键、乐观移除。
 * React 侧（扫描 effect / 回调接线）不在本文件——这里钉的是语义，不是渲染。
 */

const entry = (rootDir: string, lastOpenedAt = 1000, adapterId = 'eratw'): RecentProject => ({
  rootDir,
  adapterId,
  lastOpenedAt,
});

describe('recentRowState：stat 结果 → 行渲染态（三态，不许吞成两态）', () => {
  it('undefined = 尚未探测 / 探测不可用 → unknown（行内不标记）', () => {
    expect(recentRowState(undefined)).toBe('unknown');
  });

  it('null = 目录不存在 → missing（灰态标记的依据）', () => {
    expect(recentRowState(null)).toBe('missing');
  });

  it('拿到 FileStat = 目录还在 → ok', () => {
    expect(recentRowState({} as FileStat)).toBe('ok');
  });
});

describe('recentStatKey：pathKey + lastOpenedAt 的探测缓存键', () => {
  it('同一路径两种写法（大小写 / 分隔符）折成同一个键——不重复探测', () => {
    expect(recentStatKey(entry('C:\\Game\\eraTW'))).toBe(recentStatKey(entry('c:/game/eratw')));
  });

  it('重开过 ⇒ lastOpenedAt 变 ⇒ 键变 ⇒ 重扫（旧探测结果不钉死新状态）', () => {
    expect(recentStatKey(entry('C:\\Game', 1))).not.toBe(recentStatKey(entry('C:\\Game', 2)));
  });
});

describe('removeRecentOptimistic：乐观移除（与内核 removeRecent 同判等口径）', () => {
  it('按 pathKey 摘条目：大小写 / 分隔符差异不漏删', () => {
    const list = [entry('C:\\Game\\eraTW', 3, 'a'), entry('D:\\其他', 2, 'b')];
    expect(removeRecentOptimistic(list, 'c:/game/eratw')).toEqual([entry('D:\\其他', 2, 'b')]);
  });

  it('其余条目顺序与内容逐字保留', () => {
    const list = [entry('C:\\A', 3), entry('C:\\B', 2), entry('C:\\C', 1)];
    expect(removeRecentOptimistic(list, 'C:\\B')).toEqual([entry('C:\\A', 3), entry('C:\\C', 1)]);
  });

  it('未命中 = 原样返回（内核幂等 no-op 的 UI 侧对齐）', () => {
    const list = [entry('C:\\A', 3)];
    expect(removeRecentOptimistic(list, 'C:\\不存在')).toEqual(list);
  });
});
