/**
 * 标签预览态 + 最近使用序（1020 编辑器体感批，用户反馈项 5）的纯逻辑单测。
 *
 * 钉住的判据全是"作者手感"级别，改错一次就变成"我的文件怎么没了 / 为什么开了十张标签"：
 * - 预览**不占新位**（就地替换），但**脏的那张绝不替换**；
 * - 第二次显式打开同一份 ⇒ 转正（此后不再被预览顶掉）；
 * - 预览态是会话态：不进组快照、关标签即销账；
 * - Ctrl+Tab 走的是"最近用过"的序，不是标签条的左右序；连按继续往后走。
 */
import { describe, expect, it } from 'vitest';
import {
  applyPin,
  pinPreview,
  planPreviewOpen,
  tabClassName,
} from '../src/ui/tabs-ops';
import { pruneMru, stepMru, touchMru } from '../src/ui/tab-mru';
import {
  activateTab,
  closeTabsInGroup,
  initialEditorGroups,
  openInActiveGroup,
  openPreviewInActiveGroup,
  pinPreviewInGroup,
  serializeGroups,
  splitActiveRight,
} from '../src/ui/editor-groups';

const A = 'D:/g/a.ERB';
const B = 'D:/g/b.ERB';
const C = 'D:/g/c.ERB';
const Z = 'D:/g/z.ERB';

const noDirty = (): boolean => false;
const dirtyB = (p: string): boolean => p === B;

describe('planPreviewOpen：四条规则逐条钉', () => {
  it('没有预览 ⇒ 追加并记为预览', () => {
    const plan = planPreviewOpen([A], null, B, noDirty);
    expect(plan.tabs).toEqual([A, B]);
    expect(plan.preview).toBe(B);
    expect(plan.pinned).toBe(false);
  });

  it('本组已有干净预览 ⇒ 就地替换（位置不变、标签数不涨）', () => {
    const plan = planPreviewOpen([A, B], B, C, noDirty);
    expect(plan.tabs).toEqual([A, C]);
    expect(plan.preview).toBe(C);
    expect(plan.pinned).toBe(false);
  });

  it('那张预览是脏的 ⇒ 不替换：作者改过的东西不能因为"又点了一下树"就没了', () => {
    const plan = planPreviewOpen([A, B], B, C, dirtyB);
    expect(plan.tabs).toEqual([A, B, C]);
    expect(plan.preview).toBeNull(); // 旧预览就地转正
    expect(plan.pinned).toBe(false);
  });

  it('目标已开着且正是预览 ⇒ 再点一次即固定（清预览态，位置不动）', () => {
    const plan = planPreviewOpen([A, B], B, B, noDirty);
    expect(plan.tabs).toEqual([A, B]);
    expect(plan.preview).toBeNull();
    expect(plan.pinned).toBe(true);
  });

  it('目标已开着但不是那张预览 ⇒ 只激活，不动预览', () => {
    const plan = planPreviewOpen([A, B, C], C, A, noDirty);
    expect(plan).toEqual({ tabs: [A, B, C], preview: C, pinned: false });
  });

  it('记着的预览已经不在栈里 ⇒ 按"没有预览"处理，新文件另开一张', () => {
    const plan = planPreviewOpen([A], Z, B, noDirty);
    expect(plan.tabs).toEqual([A, B]);
    expect(plan.preview).toBe(B);
  });
});

describe('pinPreview 与 tabClassName', () => {
  it('pinPreview 只在那一枚正是预览时清账', () => {
    expect(pinPreview(B, B)).toBeNull();
    expect(pinPreview(B, A)).toBe(B);
    expect(pinPreview(null, A)).toBeNull();
  });

  it('预览态画成第三个类名，与 active / pinned 可叠加', () => {
    expect(tabClassName(A, true, false, null, true)).toBe('editor-tab active preview');
    expect(tabClassName(A, false, false, null, false)).toBe('editor-tab');
    expect(tabClassName(A, false, true, null, true)).toBe('editor-tab pinned preview');
  });

  it('固定区排序与预览无关（applyPin 只管 pinned）', () => {
    expect(applyPin([A, B, C], C, true, new Set<string>())).toEqual([C, A, B]);
  });
});

describe('tab-mru：打开=提到最前，关掉=清账', () => {
  it('touchMru 置顶去重，其余相对顺序不动', () => {
    expect(touchMru([A, B, C], B)).toEqual([B, A, C]);
    expect(touchMru([A], Z)).toEqual([Z, A]);
    expect(touchMru([], A)).toEqual([A]);
  });

  it('pruneMru 只留还开着的（不留"按过去打不开"的幽灵项）', () => {
    expect(pruneMru([B, A, C], [A, C])).toEqual([A, C]);
    expect(pruneMru([A, B], [])).toEqual([]);
  });

  it('stepMru 在活动标签之外走，next 从最近开始、prev 反向', () => {
    const mru = [A, B, C]; // A 最近用过
    expect(stepMru(mru, A, 'next')).toBe(B);
    expect(stepMru(mru, A, 'prev')).toBe(C);
    expect(stepMru(mru, B, 'next')).toBe(A);
  });

  it('连按继续往后走（offset 给第几下），走完一圈回绕', () => {
    const mru = [A, B, C];
    expect(stepMru(mru, A, 'next', 0)).toBe(B);
    expect(stepMru(mru, A, 'next', 1)).toBe(C);
    expect(stepMru(mru, A, 'next', 2)).toBe(B); // 只剩两枚 ⇒ 取模回绕，不越界
    expect(stepMru(mru, A, 'prev', 1)).toBe(B);
  });

  it('没得可切 ⇒ null（由调用方回一句人话，不许按下去没反应）', () => {
    expect(stepMru([A], A, 'next')).toBeNull();
    expect(stepMru([], A, 'next')).toBeNull();
    expect(stepMru([A, B], null, 'next')).toBe(A);
  });
});

describe('组态落地：预览只住焦点组，且不进快照', () => {
  const twoGroups = () => {
    const one = openInActiveGroup(initialEditorGroups(), A);
    return splitActiveRight(one); // 新组携带 A，焦点跟到新组
  };

  it('openPreviewInActiveGroup 只动焦点组', () => {
    const state = twoGroups();
    const focusId = state.activeGroupId;
    const otherId = state.groups.find((g) => g.id !== focusId)!.id;
    const next = openPreviewInActiveGroup(state, B, noDirty);
    const focus = next.groups.find((g) => g.id === focusId)!;
    const other = next.groups.find((g) => g.id === otherId)!;
    expect(focus.preview).toBe(B);
    expect(other.preview ?? null).toBeNull();
    expect(other.tabs).toEqual([A]);
  });

  it('同一份再显式打开 ⇒ 转正（openInActiveGroup 顺手清预览）', () => {
    const state = openPreviewInActiveGroup(initialEditorGroups(), A, noDirty);
    expect(state.groups[0]!.preview).toBe(A);
    const pinnedAgain = openInActiveGroup(state, A);
    expect(pinnedAgain.groups[0]!.preview).toBeNull();
    expect(pinnedAgain.groups[0]!.tabs).toEqual([A]);
  });

  it('点标签本身 ⇒ 预览转正；pinPreviewInGroup 同义且只认那一枚', () => {
    const state = openPreviewInActiveGroup(initialEditorGroups(), A, noDirty);
    const gid = state.activeGroupId;
    expect(activateTab(state, gid, A).groups[0]!.preview).toBeNull();
    const again = openPreviewInActiveGroup(initialEditorGroups(), A, noDirty);
    expect(pinPreviewInGroup(again, again.activeGroupId, B)).toBe(again); // 不是那张预览 ⇒ 原样
    expect(pinPreviewInGroup(again, again.activeGroupId, A).groups[0]!.preview).toBeNull();
  });

  it('预览那张被关掉 ⇒ 预览态一起清（下一次点开才有地方替换）', () => {
    const state = openPreviewInActiveGroup(initialEditorGroups(), A, noDirty);
    const closed = closeTabsInGroup(state, state.activeGroupId, [A]);
    expect(closed.groups[0]!.tabs).toEqual([]);
    expect(closed.groups[0]!.preview ?? null).toBeNull();
  });

  it('组快照不带预览：恢复会话时所有标签按普通标签回来', () => {
    const state = openPreviewInActiveGroup(initialEditorGroups(), A, noDirty);
    const snap = serializeGroups(state);
    expect(snap.groups[0]).toEqual({ id: state.groups[0]!.id, tabs: [A], active: A });
  });
});
