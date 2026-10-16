/**
 * SPLIT-1 · 编辑器组态纯逻辑单测：拆分 / 关标签（含组空即收）/ 关组 / 焦点切换 /
 * 组内重排语义不变式。零 React、零 Monaco——App 是唯一状态所有者，这里的每条
 * 纯函数就是它写入组态的**唯一**通道。
 */

import { describe, expect, it } from 'vitest';
import {
  activateTab,
  closeGroup,
  closeTabsInGroup,
  initialEditorGroups,
  openInActiveGroup,
  setActiveGroup,
  splitActiveRight,
  type EditorGroupsState,
} from '../src/ui/editor-groups';

const ids = (s: EditorGroupsState): string[] => s.groups.map((g) => g.id);

describe('编辑器组态 · 初始与打开', () => {
  it('初始 = 单组空栈', () => {
    const s = initialEditorGroups();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]!.tabs).toEqual([]);
    expect(s.groups[0]!.active).toBeNull();
    expect(s.activeGroupId).toBe(s.groups[0]!.id);
  });

  it('打开 = 追加到栈尾并激活；重复打开只激活不重复', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = openInActiveGroup(s, 'b.erb');
    expect(s.groups[0]!.tabs).toEqual(['a.erb', 'b.erb']);
    expect(s.groups[0]!.active).toBe('b.erb');
    s = openInActiveGroup(s, 'a.erb');
    expect(s.groups[0]!.tabs).toEqual(['a.erb', 'b.erb']);
    expect(s.groups[0]!.active).toBe('a.erb');
  });
});

describe('编辑器组态 · 拆分', () => {
  it('向右拆分：新组携带激活标签、插在焦点组右侧、焦点跟到新组', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = openInActiveGroup(s, 'b.erb');
    s = openInActiveGroup(s, 'c.erb');
    s = openInActiveGroup(s, 'b.erb'); // 激活 b
    const firstId = s.groups[0]!.id;
    s = splitActiveRight(s);
    expect(s.groups).toHaveLength(2);
    expect(s.groups[0]!.id).toBe(firstId);
    expect(s.groups[1]!.tabs).toEqual(['b.erb']);
    expect(s.groups[1]!.active).toBe('b.erb');
    expect(s.activeGroupId).toBe(s.groups[1]!.id);
  });

  it('空组拆分：新组为空栈，焦点照旧跟到新组', () => {
    let s = initialEditorGroups();
    s = splitActiveRight(s);
    expect(s.groups).toHaveLength(2);
    expect(s.groups[1]!.tabs).toEqual([]);
    expect(s.activeGroupId).toBe(s.groups[1]!.id);
  });

  it('连续拆分：始终从焦点组往右插（三组线性排列）', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = splitActiveRight(s);
    s = splitActiveRight(s);
    expect(s.groups).toHaveLength(3);
    // 第二次拆分的焦点组是第二组，新组插在它右侧
    expect(s.groups[2]!.tabs).toEqual(['a.erb']);
  });
});

describe('编辑器组态 · 关标签与组空即收', () => {
  it('关激活标签：激活落右邻居；关末尾标签落左邻居', () => {
    let s = initialEditorGroups();
    for (const p of ['a.erb', 'b.erb', 'c.erb']) s = openInActiveGroup(s, p);
    s = activateTab(s, s.groups[0]!.id, 'b.erb');
    s = closeTabsInGroup(s, s.groups[0]!.id, ['b.erb']);
    expect(s.groups[0]!.tabs).toEqual(['a.erb', 'c.erb']);
    expect(s.groups[0]!.active).toBe('c.erb'); // 右邻居
    s = closeTabsInGroup(s, s.groups[0]!.id, ['c.erb']);
    expect(s.groups[0]!.active).toBe('a.erb'); // 末尾回落左邻居
  });

  it('关的不是激活标签：激活不动', () => {
    let s = initialEditorGroups();
    for (const p of ['a.erb', 'b.erb']) s = openInActiveGroup(s, p);
    s = closeTabsInGroup(s, s.groups[0]!.id, ['a.erb']);
    expect(s.groups[0]!.active).toBe('b.erb');
  });

  it('组空且不是唯一组 ⇒ 整组回收、焦点落邻居组', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    const firstId = s.groups[0]!.id;
    s = splitActiveRight(s); // 第二组拿到 a.erb，焦点在第二组
    s = closeTabsInGroup(s, s.groups[1]!.id, ['a.erb']);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]!.id).toBe(firstId);
    expect(s.activeGroupId).toBe(firstId);
  });

  it('唯一组关空：组保留（空态由渲染层显示），不回收', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = closeTabsInGroup(s, s.groups[0]!.id, ['a.erb']);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]!.tabs).toEqual([]);
    expect(s.groups[0]!.active).toBeNull();
  });

  it('批量关闭：一次性过滤多张，激活一次算清（与 closeManySync 口径一致）', () => {
    let s = initialEditorGroups();
    for (const p of ['a.erb', 'b.erb', 'c.erb', 'd.erb']) s = openInActiveGroup(s, p);
    s = activateTab(s, s.groups[0]!.id, 'c.erb');
    s = closeTabsInGroup(s, s.groups[0]!.id, ['b.erb', 'c.erb']);
    expect(s.groups[0]!.tabs).toEqual(['a.erb', 'd.erb']);
    // c 在下标 2，前面被关的 1 张 ⇒ 右邻 d
    expect(s.groups[0]!.active).toBe('d.erb');
  });

  it('关不存在的标签：原样返回（推进器对已被关掉的队列目标跳过）', () => {
    const s = initialEditorGroups();
    expect(closeTabsInGroup(s, s.groups[0]!.id, ['nope.erb'])).toBe(s);
  });
});

describe('编辑器组态 · 关组与焦点', () => {
  it('唯一组不关：原样返回', () => {
    const s = initialEditorGroups();
    expect(closeGroup(s, s.groups[0]!.id)).toBe(s);
  });

  it('关焦点组：焦点落右邻组；关非焦点组：焦点不动', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    const firstId = s.groups[0]!.id;
    s = splitActiveRight(s);
    const secondId = s.groups[1]!.id;
    // 当前焦点在第二组；先切回第一组再关第二组（非焦点组）
    s = setActiveGroup(s, firstId);
    s = closeGroup(s, secondId);
    expect(s.groups).toHaveLength(1);
    expect(s.activeGroupId).toBe(firstId);
    // 再拆一个并关掉焦点组本身
    s = splitActiveRight(s);
    const focusId = s.activeGroupId;
    s = closeGroup(s, focusId);
    expect(s.groups).toHaveLength(1);
    expect(s.activeGroupId).toBe(firstId);
  });

  it('activateTab 对不在栈内的路径 no-op（不凭空造标签）', () => {
    const s = initialEditorGroups();
    expect(activateTab(s, s.groups[0]!.id, 'ghost.erb')).toBe(s);
  });
});
