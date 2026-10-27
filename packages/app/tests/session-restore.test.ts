import { describe, expect, it } from 'vitest';
import {
  initialEditorGroups,
  openInActiveGroup,
  setGroupsOrientation,
  splitActiveRight,
  type EditorGroupsState,
} from '../src/ui/editor-groups';
import {
  droppedTabsNote,
  planSessionRestore,
  probeExistingPaths,
} from '../src/ui/session-store';

/**
 * 会话恢复判据（WS-06）：记录 × 盘上事实 ⇒ 一份可恢复的标签 / 组态计划。
 *
 * 所有用例都用**假 exists**（不存在任何 IO），把「存在 / 缺失 / 全缺 / 组态过滤 /
 * 探针有界并发与失败语义」逐条钉死；真壳里同一份函数只换成 `kernel.io.exists`。
 */

/** 双组组态（第一组 a+b，第二组 b；焦点在第一组） */
function twoGroups(): EditorGroupsState {
  let s = initialEditorGroups();
  s = openInActiveGroup(s, 'C:/a.ERB');
  s = openInActiveGroup(s, 'C:/b.ERB');
  s = splitActiveRight(s); // 新组携带 b，焦点跟到新组
  return s;
}

const existsOf = (...alive: string[]) => (p: string) => alive.includes(p);

describe('planSessionRestore · 存在 / 缺失', () => {
  it('全部存在：标签原样保留，active 沿用记录', () => {
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB', 'C:/b.ERB'],
      active: 'C:/b.ERB',
      pinned: ['C:/a.ERB'],
      groups: null,
      recovered: [],
      exists: existsOf('C:/a.ERB', 'C:/b.ERB'),
    });
    expect(plan.focusTabs).toEqual(['C:/a.ERB', 'C:/b.ERB']);
    expect(plan.active).toBe('C:/b.ERB');
    expect(plan.pinned).toEqual(['C:/a.ERB']);
    expect(plan.missing).toEqual([]);
    expect(plan.note).toBeNull();
    expect(plan.groups).toBeNull();
  });

  it('部分缺失：缺失项剔除、pinned 同步收窄，剔除数量有话', () => {
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB', 'C:/gone.ERB', 'C:/b.ERB'],
      active: 'C:/gone.ERB',
      pinned: ['C:/gone.ERB', 'C:/b.ERB'],
      groups: null,
      recovered: [],
      exists: existsOf('C:/a.ERB', 'C:/b.ERB'),
    });
    expect(plan.focusTabs).toEqual(['C:/a.ERB', 'C:/b.ERB']);
    expect(plan.missing).toEqual(['C:/gone.ERB']);
    // active 缺失 ⇒ 落第一个
    expect(plan.active).toBe('C:/a.ERB');
    expect(plan.pinned).toEqual(['C:/b.ERB']);
    expect(plan.note).toContain('1 个');
  });

  it('全缺：标签与激活都是空，note 说清数量（调用方据此不恢复空壳）', () => {
    const plan = planSessionRestore({
      tabs: ['C:/x.ERB', 'C:/y.ERB'],
      active: 'C:/y.ERB',
      pinned: ['C:/x.ERB'],
      groups: null,
      recovered: [],
      exists: () => false,
    });
    expect(plan.focusTabs).toEqual([]);
    expect(plan.active).toBeNull();
    expect(plan.pinned).toEqual([]);
    expect(plan.missing).toEqual(['C:/x.ERB', 'C:/y.ERB']);
    expect(plan.note).toContain('2 个');
  });

  it('探针抛错等于"读不到"而不是"没有"：标签保住（宁可多留也不误删）', () => {
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB', 'C:/b.ERB'],
      active: null,
      pinned: [],
      groups: null,
      recovered: [],
      exists: (p) => {
        if (p === 'C:/b.ERB') throw new Error('EIO');
        return true;
      },
    });
    expect(plan.focusTabs).toEqual(['C:/a.ERB', 'C:/b.ERB']);
    expect(plan.missing).toEqual([]);
  });
});

describe('planSessionRestore · 崩溃恢复件与激活落点', () => {
  it('恢复件追加在尾部、并激活第一条（原行为）', () => {
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB'],
      active: 'C:/a.ERB',
      pinned: [],
      groups: null,
      recovered: ['C:/r1.ERB', 'C:/r2.ERB'],
      exists: existsOf('C:/a.ERB', 'C:/r1.ERB', 'C:/r2.ERB'),
    });
    expect(plan.focusTabs).toEqual(['C:/a.ERB', 'C:/r1.ERB', 'C:/r2.ERB']);
    expect(plan.active).toBe('C:/r1.ERB');
  });

  it('恢复件首条缺失 ⇒ 激活落到下一条存活的恢复件（不是记录 active）', () => {
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB'],
      active: 'C:/a.ERB',
      pinned: [],
      groups: null,
      recovered: ['C:/r1.ERB', 'C:/r2.ERB'],
      exists: existsOf('C:/a.ERB', 'C:/r2.ERB'),
    });
    expect(plan.focusTabs).toEqual(['C:/a.ERB', 'C:/r2.ERB']);
    expect(plan.active).toBe('C:/r2.ERB');
  });
});

describe('planSessionRestore · 组态（布局/orientation 仍恢复）', () => {
  it('组态快照逐组过滤：空组剔除、组内激活回落到存活标签，方向原样', () => {
    const groups = { ...twoGroups(), orientation: 'column' as const };
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB'],
      active: 'C:/a.ERB',
      pinned: [],
      groups,
      recovered: [],
      // 第二组只有 b；b 没了 ⇒ 整组剔除
      exists: existsOf('C:/a.ERB'),
    });
    expect(plan.groups).not.toBeNull();
    expect(plan.groups!.orientation).toBe('column');
    expect(plan.groups!.groups).toHaveLength(1);
    expect(plan.groups!.groups[0]!.tabs).toEqual(['C:/a.ERB']);
    expect(plan.groups!.activeGroupId).toBe(plan.groups!.groups[0]!.id);
    expect(plan.missing).toEqual(['C:/b.ERB']);
  });

  it('组态里的标签全部存活 ⇒ 两组都在、焦点组沿用原焦点', () => {
    const groups = twoGroups();
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB', 'C:/b.ERB'],
      active: 'C:/b.ERB',
      pinned: [],
      groups,
      recovered: [],
      exists: existsOf('C:/a.ERB', 'C:/b.ERB'),
    });
    expect(plan.groups!.groups).toHaveLength(2);
    expect(plan.groups!.activeGroupId).toBe(groups.activeGroupId);
  });

  it('组态全部落空 ⇒ groups = null（不恢复空壳布局）', () => {
    const plan = planSessionRestore({
      tabs: ['C:/a.ERB'],
      active: null,
      pinned: [],
      groups: setGroupsOrientation(twoGroups(), 'row'),
      recovered: [],
      exists: () => false,
    });
    expect(plan.groups).toBeNull();
    expect(plan.focusTabs).toEqual([]);
  });
});

describe('probeExistingPaths（有界并发探针）', () => {
  it('并发不超过上限，结果只收存在的', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `C:/f${i}.ERB`);
    let inflight = 0;
    let peak = 0;
    const exists = async (p: string): Promise<boolean> => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 0));
      inflight--;
      return !p.endsWith('f3.ERB');
    };
    const alive = await probeExistingPaths(paths, exists, 4);
    expect(peak).toBeLessThanOrEqual(4);
    expect(alive.has('C:/f3.ERB')).toBe(false);
    expect(alive.size).toBe(19);
  });

  it('某条探针 reject ⇒ 该条按"存在"保留（读不到 ≠ 没有）', async () => {
    const alive = await probeExistingPaths(
      ['C:/a.ERB', 'C:/b.ERB'],
      async (p) => {
        if (p === 'C:/b.ERB') throw new Error('EIO');
        return false;
      },
      2,
    );
    expect([...alive]).toEqual(['C:/b.ERB']);
  });

  it('空清单 / 去重：不空转', async () => {
    let calls = 0;
    const exists = async (): Promise<boolean> => {
      calls++;
      return true;
    };
    expect((await probeExistingPaths([], exists)).size).toBe(0);
    expect(calls).toBe(0);
    expect((await probeExistingPaths(['C:/a.ERB', 'C:/a.ERB'], exists)).size).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('droppedTabsNote', () => {
  it('0 条不出声；正数说清数量；非法值不出声', () => {
    expect(droppedTabsNote(0)).toBeNull();
    expect(droppedTabsNote(-1)).toBeNull();
    expect(droppedTabsNote(Number.NaN)).toBeNull();
    expect(droppedTabsNote(3)).toContain('3 个');
  });
});
