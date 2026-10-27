/**
 * SPLIT-1 · 编辑器组态纯逻辑单测：拆分 / 关标签（含组空即收）/ 关组 / 焦点切换 /
 * 组内重排语义不变式。MM-9：向下拆分 / 翻排列方向 / 持久化往返（损坏容忍）。
 * 零 React、零 Monaco——App 是唯一状态所有者，这里的每条纯函数就是它写入组态的
 * **唯一**通道。
 */

import { describe, expect, it } from 'vitest';
import {
  activateTab,
  closeGroup,
  closeTabsInGroup,
  initialEditorGroups,
  moveTabBetweenGroups,
  openInActiveGroup,
  restoreGroups,
  serializeGroups,
  setActiveGroup,
  setGroupsOrientation,
  splitActiveDown,
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

describe('编辑器组态 · 排列方向（MM-9）', () => {
  it('初始 orientation = row（现状左右并排）', () => {
    expect(initialEditorGroups().orientation).toBe('row');
  });

  it('setGroupsOrientation 同值原样返回（同一引用，不制造重渲染）', () => {
    const s = initialEditorGroups();
    expect(setGroupsOrientation(s, 'row')).toBe(s);
    const col = setGroupsOrientation(s, 'column');
    expect(col).not.toBe(s);
    expect(setGroupsOrientation(col, 'column')).toBe(col);
  });

  it('翻方向只动 orientation 一个字段：组与激活原样（groups 同一引用）', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = openInActiveGroup(s, 'b.erb');
    s = splitActiveRight(s); // 焦点在第二组
    const after = setGroupsOrientation(s, 'column');
    expect(after.orientation).toBe('column');
    expect(after.groups).toBe(s.groups); // 组数组同一引用（连 map 都没走）
    expect(after.activeGroupId).toBe(s.activeGroupId);
    // 拆分组态在翻向后照旧成立（orientation 不被任何组操作冲掉）
    const split = splitActiveDown(after);
    expect(split.orientation).toBe('column');
  });

  it('组操作（拆/关/关标签）都不改 orientation：方向跨操作保值', () => {
    let s = setGroupsOrientation(initialEditorGroups(), 'column');
    s = openInActiveGroup(s, 'a.erb');
    s = splitActiveDown(s);
    s = openInActiveGroup(s, 'b.erb');
    s = closeTabsInGroup(s, s.groups[1]!.id, ['a.erb', 'b.erb']); // 关空第二组 ⇒ 回收
    expect(s.orientation).toBe('column');
    expect(s.groups).toHaveLength(1);
    s = splitActiveRight(s);
    expect(s.orientation).toBe('column');
    s = closeGroup(s, s.activeGroupId);
    expect(s.orientation).toBe('column');
    expect(s.groups).toHaveLength(1);
  });
});

describe('编辑器组态 · 向下拆分（MM-9）', () => {
  it('splitActiveDown：新组携带激活标签、插在焦点组下方（数组序即排列序）、焦点跟到新组', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = openInActiveGroup(s, 'b.erb');
    s = openInActiveGroup(s, 'c.erb');
    s = openInActiveGroup(s, 'b.erb'); // 激活 b
    s = setGroupsOrientation(s, 'column');
    const firstId = s.groups[0]!.id;
    s = splitActiveDown(s);
    expect(s.groups).toHaveLength(2);
    expect(s.groups[0]!.id).toBe(firstId);
    expect(s.groups[1]!.tabs).toEqual(['b.erb']);
    expect(s.groups[1]!.active).toBe('b.erb');
    expect(s.activeGroupId).toBe(s.groups[1]!.id);
    expect(s.orientation).toBe('column'); // 拆分不翻向
  });

  it('空组向下拆分：新组为空栈，焦点照旧跟到新组', () => {
    let s = initialEditorGroups();
    s = splitActiveDown(s);
    expect(s.groups).toHaveLength(2);
    expect(s.groups[1]!.tabs).toEqual([]);
    expect(s.activeGroupId).toBe(s.groups[1]!.id);
  });

  it('连续向下拆分：始终从焦点组往下插（三组同列堆叠）', () => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = splitActiveDown(s);
    s = splitActiveDown(s);
    expect(s.groups).toHaveLength(3);
    // 第二次拆分的焦点组是第二组，新组插在它"下方"（数组下标 +1）
    expect(s.groups[2]!.tabs).toEqual(['a.erb']);
  });

  it('row 取向下 splitActiveDown 与 splitActiveRight 数组行为一致（差别只在渲染方向）', () => {
    let base = initialEditorGroups();
    base = openInActiveGroup(base, 'a.erb');
    base = openInActiveGroup(base, 'b.erb');
    const down = splitActiveDown(base);
    const right = splitActiveRight(base);
    expect(down.groups.map((g) => g.tabs)).toEqual(right.groups.map((g) => g.tabs));
    expect(down.activeGroupId).toBe(down.groups[1]!.id);
    expect(right.activeGroupId).toBe(right.groups[1]!.id);
  });
});

describe('编辑器组态 · 持久化往返（MM-9）', () => {
  /** 两份组 + column 的多组态（序列化往返的基准样态） */
  const build = (): EditorGroupsState => {
    let s = initialEditorGroups();
    s = openInActiveGroup(s, 'a.erb');
    s = openInActiveGroup(s, 'b.erb');
    s = setGroupsOrientation(s, 'column');
    s = splitActiveDown(s); // 两组：['a','b'](激活 b) / ['b'](激活 b)，焦点在第二组
    return s;
  };

  it('serialize 产物是纯数据：JSON 往返逐字相等', () => {
    const snap = serializeGroups(build());
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('serialize → restore 往返等价（多组 + column：方向/组序/激活/焦点全保）', () => {
    const s = build();
    const back = restoreGroups(serializeGroups(s));
    expect(back).not.toBeNull();
    expect(back!.orientation).toBe('column');
    expect(back!.groups).toHaveLength(2);
    expect(back!.groups.map((g) => g.tabs)).toEqual([['a.erb', 'b.erb'], ['b.erb']]);
    expect(back!.groups.map((g) => g.active)).toEqual(['b.erb', 'b.erb']);
    expect(back!.activeGroupId).toBe(back!.groups[1]!.id); // 焦点仍是拆出来的新组
  });

  it('restore 重新分配 id：不与旧 state 撞号，且恢复态继续 split 也不撞', () => {
    const s = build();
    const oldIds = new Set(s.groups.map((g) => g.id));
    const back = restoreGroups(serializeGroups(s))!;
    for (const g of back.groups) expect(oldIds.has(g.id)).toBe(false);
    const next = splitActiveRight(back);
    expect(oldIds.has(next.groups[2]!.id)).toBe(false);
    expect(new Set(next.groups.map((g) => g.id)).size).toBe(3); // 三枚 id 两两不同
  });

  it('restore 后 splitActiveRight 正常（携带恢复出的焦点组的激活标签）', () => {
    const back = restoreGroups(serializeGroups(build()))!;
    const s2 = splitActiveRight(back);
    expect(s2.groups).toHaveLength(3);
    expect(s2.groups[2]!.tabs).toEqual(['b.erb']);
    expect(s2.activeGroupId).toBe(s2.groups[2]!.id);
  });

  it('坏形态全回 null 不炸：null/undefined/非对象/数组/空对象/缺字段/方向非法', () => {
    for (const raw of [
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { orientation: 'row' },
      { groups: [] },
      { orientation: 'diag', groups: [] },
      { orientation: 'row', activeGroupId: 'eg-1', groups: 'no' },
    ]) {
      expect(restoreGroups(raw)).toBeNull();
    }
  });

  it('全空组 ⇒ 回 null（调用方维持现状），不炸', () => {
    expect(
      restoreGroups({ orientation: 'row', activeGroupId: 'eg-1', groups: [{ id: 'eg-1', tabs: [], active: null }] }),
    ).toBeNull();
    expect(
      restoreGroups({
        orientation: 'row',
        activeGroupId: 'eg-1',
        groups: [{ id: 'eg-1', tabs: [], active: null }, 'not-an-object', null],
      }),
    ).toBeNull();
  });

  it('过滤空组但保底至少一组；activeGroupId 无效落第一组；active 越界落 tabs[0]', () => {
    const back = restoreGroups({
      orientation: 'column',
      activeGroupId: 'eg-ghost', // 对不上任何旧 id
      groups: [
        { id: 'eg-1', tabs: ['a.erb', 'b.erb'], active: 'nope.erb' }, // active 越界
        { id: 'eg-2', tabs: [], active: null }, // 空组被滤掉
        { id: 'eg-3', tabs: ['c.erb'], active: 'c.erb' },
      ],
    })!;
    expect(back.groups).toHaveLength(2);
    expect(back.groups[0]!.tabs).toEqual(['a.erb', 'b.erb']);
    expect(back.groups[0]!.active).toBe('a.erb'); // 越界回落 tabs[0]
    expect(back.groups[1]!.active).toBe('c.erb');
    expect(back.activeGroupId).toBe(back.groups[0]!.id); // 无效 activeGroupId 落第一组
    expect(back.orientation).toBe('column');
  });

  it('合法 activeGroupId（旧 id）指向的组成为恢复后的焦点组', () => {
    const back = restoreGroups({
      orientation: 'row',
      activeGroupId: 'eg-2',
      groups: [
        { id: 'eg-1', tabs: ['a.erb'], active: 'a.erb' },
        { id: 'eg-2', tabs: ['b.erb'], active: 'b.erb' },
      ],
    })!;
    expect(back.activeGroupId).toBe(back.groups[1]!.id);
  });

  it('tabs 去重保序；非字符串/空串条目滤掉', () => {
    const back = restoreGroups({
      orientation: 'row',
      activeGroupId: 'eg-1',
      groups: [{ id: 'eg-1', tabs: ['a.erb', 'a.erb', 42, '', 'b.erb'], active: 'b.erb' }],
    })!;
    expect(back.groups[0]!.tabs).toEqual(['a.erb', 'b.erb']);
    expect(back.groups[0]!.active).toBe('b.erb');
  });
});

/* --------------------- 1027 跨组批：标签搬组（拖拽 / 右键「移动到组」） --------------------- */

/** 两组夹具：g1 = a b c（激活 b），g2 = x y（激活 x）；焦点在 g1 */
const twoGroups = (): EditorGroupsState => ({
  groups: [
    { id: 'g1', tabs: ['a', 'b', 'c'], active: 'b' },
    { id: 'g2', tabs: ['x', 'y'], active: 'x' },
  ],
  activeGroupId: 'g1',
  orientation: 'row',
});

const groupById = (s: EditorGroupsState, id: string) => s.groups.find((g) => g.id === id)!;

describe('moveTabBetweenGroups · 跨组移动基础', () => {
  it('搬到目标组指定下标；焦点跟到目标组，目标组激活被移动标签', () => {
    const s = twoGroups();
    const next = moveTabBetweenGroups(s, 'b', 'g1', 'g2', 1, new Set());
    expect(groupById(next, 'g1').tabs).toEqual(['a', 'c']);
    expect(groupById(next, 'g2').tabs).toEqual(['x', 'b', 'y']);
    expect(groupById(next, 'g2').active).toBe('b');
    expect(next.activeGroupId).toBe('g2');
    // 源组激活是 b（被搬走）⇒ 落右邻居 c
    expect(groupById(next, 'g1').active).toBe('c');
    // 入参不变
    expect(groupById(s, 'g1').tabs).toEqual(['a', 'b', 'c']);
  });

  it('下标越界钳到目标组末尾', () => {
    const next = moveTabBetweenGroups(twoGroups(), 'b', 'g1', 'g2', 99, new Set());
    expect(groupById(next, 'g2').tabs).toEqual(['x', 'y', 'b']);
  });

  it('源组激活落右邻；搬走的是末尾 ⇒ 落左邻', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['a', 'b'], active: 'b' },
        { id: 'g2', tabs: [], active: null },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'b', 'g1', 'g2', 0, new Set());
    expect(groupById(next, 'g1').active).toBe('a');
  });

  it('源组变空**不回收**（移动不是关闭，作者还能拖回来）', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['a'], active: 'a' },
        { id: 'g2', tabs: ['x'], active: 'x' },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'a', 'g1', 'g2', 1, new Set());
    expect(next.groups).toHaveLength(2);
    expect(groupById(next, 'g1').tabs).toEqual([]);
    expect(groupById(next, 'g1').active).toBeNull();
  });

  it('目标组已有同路径：不重复造标签，源组移除并在目标组激活', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['a', 'b'], active: 'a' },
        { id: 'g2', tabs: ['x', 'b'], active: 'x' },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'b', 'g1', 'g2', 0, new Set());
    expect(groupById(next, 'g1').tabs).toEqual(['a']);
    expect(groupById(next, 'g2').tabs).toEqual(['x', 'b']);
    expect(groupById(next, 'g2').active).toBe('b');
    expect(next.activeGroupId).toBe('g2');
  });
});

describe('moveTabBetweenGroups · 固定区钳位（固定区在前的不变量）', () => {
  it('非固定标签只能落在固定区之后（toIndex 0 被钳到分界）', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['u'], active: 'u' },
        { id: 'g2', tabs: ['p1', 'p2', 'x'], active: 'x' },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'u', 'g1', 'g2', 0, new Set(['p1', 'p2']));
    expect(groupById(next, 'g2').tabs).toEqual(['p1', 'p2', 'u', 'x']);
  });

  it('固定标签只能落在固定区内（toIndex 末尾被钳到固定区末尾）', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['q', 'a'], active: 'a' },
        { id: 'g2', tabs: ['p1', 'x'], active: 'x' },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'q', 'g1', 'g2', 5, new Set(['q', 'p1']));
    expect(groupById(next, 'g2').tabs).toEqual(['p1', 'q', 'x']);
  });

  it('显式移动不改固定态（pinned 集合只读，落点被钳而不是改态）', () => {
    const pinned = new Set(['p1']);
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['u'], active: 'u' },
        { id: 'g2', tabs: ['p1', 'x'], active: 'x' },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    moveTabBetweenGroups(s, 'u', 'g1', 'g2', 1, pinned);
    expect([...pinned]).toEqual(['p1']);
  });
});

describe('moveTabBetweenGroups · 预览态与无操作', () => {
  it('源组预览清空；目标组不把搬来的标签设成预览（显式移动 = 转正）', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['a', 'b'], active: 'b', preview: 'b' },
        { id: 'g2', tabs: [], active: null },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'b', 'g1', 'g2', 0, new Set());
    expect(groupById(next, 'g1').preview).toBeNull();
    expect(groupById(next, 'g2').preview ?? null).toBeNull();
  });

  it('目标组原有的预览态不受影响（搬来的不是它）', () => {
    const s: EditorGroupsState = {
      groups: [
        { id: 'g1', tabs: ['a', 'b'], active: 'b' },
        { id: 'g2', tabs: ['x'], active: 'x', preview: 'x' },
      ],
      activeGroupId: 'g1',
      orientation: 'row',
    };
    const next = moveTabBetweenGroups(s, 'a', 'g1', 'g2', 1, new Set());
    expect(groupById(next, 'g2').preview).toBe('x');
  });

  it('无操作时返回同一引用：同组 / 源组不存在 / 目标组不存在 / path 不在源组', () => {
    const s = twoGroups();
    expect(moveTabBetweenGroups(s, 'b', 'g1', 'g1', 0, new Set())).toBe(s);
    expect(moveTabBetweenGroups(s, 'b', 'ghost', 'g2', 0, new Set())).toBe(s);
    expect(moveTabBetweenGroups(s, 'b', 'g1', 'ghost', 0, new Set())).toBe(s);
    expect(moveTabBetweenGroups(s, 'nope', 'g1', 'g2', 0, new Set())).toBe(s);
  });

  it('排列方向原样保留', () => {
    const s: EditorGroupsState = { ...twoGroups(), orientation: 'column' };
    expect(moveTabBetweenGroups(s, 'b', 'g1', 'g2', 0, new Set()).orientation).toBe('column');
  });
});
