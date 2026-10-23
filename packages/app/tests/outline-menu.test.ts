// @vitest-environment happy-dom
/**
 * 侧栏大纲面板的右键菜单（1023 覆盖面批 · WP3.3；折叠项为 1023 缺口批补入）。
 *
 * 判据分三层（口径同 `problem-menu` / `shell-menus`）：
 * 1. **纯函数**：能力缺席的项**整项不显示**（剪贴板不可写 ⇒ 三个复制项不摆入口；
 *    没有子节点 ⇒ 折叠 / 展开两项都不摆）、空树时「复制整份大纲」禁用并给原因
 *    ——铁律 4 的菜单侧落点；
 * 2. **面接线**：DOM 的 `data-outline-row` → 面认人 → `onSelect` 落到宿主的
 *    `reveal` / `copy` / `fold` 上（不靠人读 JSX 猜）；
 * 3. **文案**：所有标签全中文，禁用项必有 `disabledReason`，id 全表唯一。
 *
 * 折叠项的口径（与面板本体同一条）：折叠是**视图状态**，菜单只按"这一行有没有子节点、
 * 此刻折没折"决定摆哪一项，折/展本身由面板的 `fold` 回调落账——菜单不存状态。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getContextSurface, type ContextSurfaceBuildResult } from '../src/ui/context-surfaces';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import {
  COPY_ALL_EMPTY_REASON,
  EXPAND_ALL_LABEL,
  EXPAND_BRANCH_LABEL,
  FOLD_ALL_LABEL,
  FOLD_BRANCH_LABEL,
  OUTLINE_MENU_IDS,
  OUTLINE_ROW_ATTR,
  OUTLINE_ROW_ID_ATTR,
  buildOutlinePanelMenu,
  buildOutlineRowMenu,
  buildOutlineSurfaceMenu,
  foldableOutlineIds,
  outlineSubtreeEnd,
  outlineText,
  setOutlineMenuContext,
  type OutlineMenuRow,
} from '../src/ui/outline-menu';

const ROWS: readonly OutlineMenuRow[] = [
  { id: 'a', name: '@ 函数甲', detail: '第 1 段', depth: 0, startLine: 3 },
  { id: 'b', name: '子符号乙', detail: null, depth: 1, startLine: 9 },
  { id: 'c', name: '子符号丙', depth: 1, detail: null, startLine: 14 } as OutlineMenuRow,
  { id: 'd', name: '@ 函数丁', detail: null, depth: 0, startLine: 40 },
];

/** 有子节点的行（`a` 下挂着 `b`/`c`；`d` 是叶子） */
const FOLDABLE = ['a'] as const;

afterEach(() => setOutlineMenuContext(null));

const idsOf = (items: readonly ContextMenuItem[]): string[] => items.map((i) => i.id);

/** 面返回的必须是"完整菜单对象"（数组形态 = 宿主不会替你分发动作，点了等于没反应） */
function menuOf(result: ContextSurfaceBuildResult): {
  items: readonly ContextMenuItem[];
  onSelect: (id: string) => void;
} {
  if (result === null) throw new Error('面没有表态（null）：这一级应交给兜底');
  if (Array.isArray(result)) throw new Error('面返回了数组形态：动作没人分发');
  const menu = result as { readonly items: readonly ContextMenuItem[]; readonly onSelect?: (id: string) => void };
  if (menu.onSelect === undefined) throw new Error('面给了 items 却没给 onSelect（选中不做事）');
  return { items: menu.items, onSelect: menu.onSelect };
}


function contextEvent(): MouseEvent {
  return new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
}

/** 造一棵最小 DOM：面根 + 若干行，返回"点在某一行"时该层的元素 */
function mountRows(): { root: HTMLElement; cells: Map<string, HTMLElement> } {
  const root = document.createElement('div');
  root.setAttribute('data-context-surface', 'outline');
  const cells = new Map<string, HTMLElement>();
  for (const row of ROWS) {
    const button = document.createElement('button');
    button.setAttribute(OUTLINE_ROW_ATTR, '');
    button.setAttribute(OUTLINE_ROW_ID_ATTR, row.id);
    button.textContent = row.name;
    root.appendChild(button);
    cells.set(row.id, button);
  }
  document.body.appendChild(root);
  return { root, cells };
}

function handlersStub(): {
  calls: string[];
  reveal: (row: OutlineMenuRow) => void;
  copy: (text: string, okText: string) => void;
  fold: (ids: readonly string[], folded: boolean) => void;
} {
  const calls: string[] = [];
  return {
    calls,
    reveal: (row) => calls.push(`reveal:${row.id}:${row.startLine}`),
    copy: (text, okText) => calls.push(`copy:${okText}:${text.replace(/\n/g, '|')}`),
    fold: (ids, folded) => calls.push(`fold:${folded ? '折' : '展'}:${ids.join(',')}`),
  };
}

describe('大纲单行菜单 · 能力决定项集', () => {
  it('没有剪贴板 ⇒ 三个复制项整项不显示（折叠项与剪贴板无关）', () => {
    const items = buildOutlineRowMenu({ canCopy: false, hasChildren: true, collapsed: false });
    expect(idsOf(items)).toEqual([OUTLINE_MENU_IDS.goto, OUTLINE_MENU_IDS.foldBranch]);
  });

  it('有剪贴板、这一行没有子符号 ⇒ 不给「复制这一支」，也不给折叠项', () => {
    const items = buildOutlineRowMenu({ canCopy: true, hasChildren: false, collapsed: false });
    expect(idsOf(items)).toEqual([OUTLINE_MENU_IDS.goto, OUTLINE_MENU_IDS.copyName, OUTLINE_MENU_IDS.copyLocation]);
  });

  it('有子符号 ⇒ 折叠 + 三项复制齐出，折叠与复制各断一次行', () => {
    const items = buildOutlineRowMenu({ canCopy: true, hasChildren: true, collapsed: false });
    expect(idsOf(items)).toEqual([
      OUTLINE_MENU_IDS.goto,
      OUTLINE_MENU_IDS.foldBranch,
      OUTLINE_MENU_IDS.copyName,
      OUTLINE_MENU_IDS.copyLocation,
      OUTLINE_MENU_IDS.copySubtree,
    ]);
    expect(items[1]?.label).toBe(FOLD_BRANCH_LABEL);
    expect(items[1]?.dividerBefore).toBe(true);
    expect(items[2]?.dividerBefore).toBe(true);
  });

  it('有子符号且已折叠 ⇒ 只剩「展开这一支」（同一位置，不并列两条）', () => {
    const items = buildOutlineRowMenu({ canCopy: true, hasChildren: true, collapsed: true });
    expect(idsOf(items)).toEqual([
      OUTLINE_MENU_IDS.goto,
      OUTLINE_MENU_IDS.expandBranch,
      OUTLINE_MENU_IDS.copyName,
      OUTLINE_MENU_IDS.copyLocation,
      OUTLINE_MENU_IDS.copySubtree,
    ]);
    expect(items[1]?.label).toBe(EXPAND_BRANCH_LABEL);
    expect(idsOf(items)).not.toContain(OUTLINE_MENU_IDS.foldBranch);
  });

  it('无子节点时「collapsed」不会凭空造出折叠项（叶子行折不了）', () => {
    expect(idsOf(buildOutlineRowMenu({ canCopy: false, hasChildren: false, collapsed: true }))).toEqual([
      OUTLINE_MENU_IDS.goto,
    ]);
  });
});

describe('大纲面板菜单 · 空树不摆假入口', () => {
  it('空树 ⇒ 「复制整份大纲」禁用并说原因（不藏项）', () => {
    const items = buildOutlinePanelMenu({ canCopy: true, rowCount: 0, foldableCount: 0, collapsedCount: 0 });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(OUTLINE_MENU_IDS.copyAll);
    expect(items[0]?.disabled).toBe(true);
    expect(items[0]?.disabledReason).toBe(COPY_ALL_EMPTY_REASON);
  });

  it('没有剪贴板且没有可折的支 ⇒ 一项都不给（返回空，让兜底菜单接管）', () => {
    expect(buildOutlinePanelMenu({ canCopy: false, rowCount: 4, foldableCount: 0, collapsedCount: 0 })).toEqual([]);
  });
});

describe('大纲面板菜单 · 折叠两项按"做了会不会有变化"摆', () => {
  it('一条没折 ⇒ 只给「全部折叠」', () => {
    const items = buildOutlinePanelMenu({ canCopy: true, rowCount: 4, foldableCount: 2, collapsedCount: 0 });
    expect(idsOf(items)).toEqual([OUTLINE_MENU_IDS.foldAll, OUTLINE_MENU_IDS.copyAll]);
    expect(items[0]?.label).toBe(FOLD_ALL_LABEL);
    expect(items[1]?.dividerBefore).toBe(true);
  });

  it('全折上 ⇒ 只给「全部展开」（再来一次「全部折叠」什么都不会变）', () => {
    const items = buildOutlinePanelMenu({ canCopy: true, rowCount: 4, foldableCount: 2, collapsedCount: 2 });
    expect(idsOf(items)).toEqual([OUTLINE_MENU_IDS.expandAll, OUTLINE_MENU_IDS.copyAll]);
    expect(items[0]?.label).toBe(EXPAND_ALL_LABEL);
  });

  it('半折 ⇒ 两项都在（各自都还有活干）', () => {
    expect(idsOf(buildOutlinePanelMenu({ canCopy: true, rowCount: 4, foldableCount: 2, collapsedCount: 1 }))).toEqual([
      OUTLINE_MENU_IDS.foldAll,
      OUTLINE_MENU_IDS.expandAll,
      OUTLINE_MENU_IDS.copyAll,
    ]);
  });

  it('没有可折的行 ⇒ 两项都不出（不是置灰：这块文件根本没有这个能力）', () => {
    expect(
      idsOf(buildOutlinePanelMenu({ canCopy: true, rowCount: 4, foldableCount: 0, collapsedCount: 0 })),
    ).toEqual([OUTLINE_MENU_IDS.copyAll]);
  });

  it('「全部折叠」的范围 = 有子节点的行（叶子行不进集合）', () => {
    expect(foldableOutlineIds(ROWS)).toEqual([...FOLDABLE]);
    expect(foldableOutlineIds([])).toEqual([]);
    // 单层树（ERB 平铺）：一支都折不了
    const flat: OutlineMenuRow[] = [
      { id: 'x', name: 'ALPHA', detail: null, depth: 0, startLine: 2 },
      { id: 'y', name: 'BETA', detail: null, depth: 0, startLine: 12 },
    ];
    expect(foldableOutlineIds(flat)).toEqual([]);
  });
});

describe('大纲文本 · 缩进与子树范围只有一份排版', () => {
  it('按层级两格缩进，未命名行有占位', () => {
    expect(outlineText(ROWS)).toBe('@ 函数甲\n  子符号乙\n  子符号丙\n@ 函数丁');
    const unnamed = [{ id: 'x', name: '', detail: null, depth: 0, startLine: 1 }] as const;
    expect(outlineText(unnamed)).toBe('（未命名）');
  });

  it('子树范围 = 连续的更深层级；末行给回自己', () => {
    expect(outlineSubtreeEnd(ROWS, 0)).toBe(2);
    expect(outlineSubtreeEnd(ROWS, 1)).toBe(1);
    expect(outlineSubtreeEnd(ROWS, 3)).toBe(3);
  });

  it('「复制这一支」只搬起点与它名下的行（折着也照搬全文：折叠只是不画）', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: true,
      rows: ROWS,
      collapsed: new Set(['a']),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { cells } = mountRows();
    menuOf(buildOutlineSurfaceMenu(cells.get('a') as HTMLElement)).onSelect(OUTLINE_MENU_IDS.copySubtree);
    expect(h.calls).toEqual(['copy:已复制这一支:@ 函数甲|  子符号乙|  子符号丙']);
  });
});

describe('大纲面 · DOM 认人', () => {
  it('点在某一行 ⇒ 行菜单，「转到符号」落到宿主 reveal', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: true,
      rows: ROWS,
      collapsed: new Set(),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { cells } = mountRows();
    const build = getContextSurface('outline')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'outline', target: cells.get('d') as HTMLElement, event: contextEvent() }));
    expect(idsOf(menu.items)).toContain(OUTLINE_MENU_IDS.goto);
    menu.onSelect(OUTLINE_MENU_IDS.goto);
    expect(h.calls).toEqual(['reveal:d:40']);
  });

  it('点在空白处 ⇒ 面板菜单，「复制整份大纲」搬全量', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: true,
      rows: ROWS,
      collapsed: new Set(),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { root } = mountRows();
    const build = getContextSurface('outline')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'outline', target: root, event: contextEvent() }));
    expect(idsOf(menu.items)).toEqual([OUTLINE_MENU_IDS.foldAll, OUTLINE_MENU_IDS.copyAll]);
    menu.onSelect(OUTLINE_MENU_IDS.copyAll);
    expect(h.calls).toEqual(['copy:已复制 4 个符号:@ 函数甲|  子符号乙|  子符号丙|@ 函数丁']);
  });

  it('行身份在行表里找不到（树刚换过）⇒ 退回面板菜单，不冒假项', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: true,
      rows: ROWS,
      collapsed: new Set(),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const root = document.createElement('div');
    root.setAttribute('data-context-surface', 'outline');
    const stale = document.createElement('button');
    stale.setAttribute(OUTLINE_ROW_ATTR, '');
    stale.setAttribute(OUTLINE_ROW_ID_ATTR, 'gone');
    root.appendChild(stale);
    document.body.appendChild(root);
    expect(idsOf(menuOf(buildOutlineSurfaceMenu(stale)).items)).toContain(OUTLINE_MENU_IDS.copyAll);
  });

  it('没有现场（面板还没报过）⇒ 不表态，让兜底菜单接管', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    expect(buildOutlineSurfaceMenu(target)).toBeNull();
  });
});

describe('大纲面 · 折叠状态来自面板现场，动作交回面板', () => {
  it('现场里这一行折着 ⇒ 行菜单给「展开这一支」，点了把 id 交回 fold', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: false,
      rows: ROWS,
      collapsed: new Set(['a']),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { cells } = mountRows();
    const menu = menuOf(buildOutlineSurfaceMenu(cells.get('a') as HTMLElement));
    expect(idsOf(menu.items)).toEqual([OUTLINE_MENU_IDS.goto, OUTLINE_MENU_IDS.expandBranch]);
    menu.onSelect(OUTLINE_MENU_IDS.expandBranch);
    expect(h.calls).toEqual(['fold:展:a']);
  });

  it('现场里没折 ⇒ 「折叠这一支」把 id 交回 fold', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: false,
      rows: ROWS,
      collapsed: new Set(),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { cells } = mountRows();
    menuOf(buildOutlineSurfaceMenu(cells.get('a') as HTMLElement)).onSelect(OUTLINE_MENU_IDS.foldBranch);
    expect(h.calls).toEqual(['fold:折:a']);
  });

  it('「全部折叠 / 全部展开」一次把全部可折的 id 交回（与单行同一个入口）', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: false,
      rows: ROWS,
      collapsed: new Set(),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { root } = mountRows();
    menuOf(buildOutlineSurfaceMenu(root)).onSelect(OUTLINE_MENU_IDS.foldAll);
    expect(h.calls).toEqual(['fold:折:a']);

    const h2 = handlersStub();
    setOutlineMenuContext({
      canCopy: false,
      rows: ROWS,
      collapsed: new Set(['a']),
      handlers: { reveal: h2.reveal, copy: h2.copy, fold: h2.fold },
    });
    menuOf(buildOutlineSurfaceMenu(root)).onSelect(OUTLINE_MENU_IDS.expandAll);
    expect(h2.calls).toEqual(['fold:展:a']);
  });

  it('叶子行折过了（脏现场）也不会冒出折叠项', () => {
    const h = handlersStub();
    setOutlineMenuContext({
      canCopy: false,
      rows: ROWS,
      collapsed: new Set(['d']),
      handlers: { reveal: h.reveal, copy: h.copy, fold: h.fold },
    });
    const { cells } = mountRows();
    expect(idsOf(menuOf(buildOutlineSurfaceMenu(cells.get('d') as HTMLElement)).items)).toEqual([
      OUTLINE_MENU_IDS.goto,
    ]);
  });
});

describe('文案 · 全中文', () => {
  it('单行菜单与面板菜单的每一个标签都是中文', () => {
    const all = [
      ...buildOutlineRowMenu({ canCopy: true, hasChildren: true, collapsed: false }),
      ...buildOutlineRowMenu({ canCopy: true, hasChildren: true, collapsed: true }),
      ...buildOutlinePanelMenu({ canCopy: true, rowCount: 1, foldableCount: 1, collapsedCount: 0 }),
      ...buildOutlinePanelMenu({ canCopy: true, rowCount: 1, foldableCount: 1, collapsedCount: 1 }),
    ];
    for (const item of all) expect(isChineseMenuLabel(item.label), item.label).toBe(true);
    expect(isChineseMenuLabel(COPY_ALL_EMPTY_REASON)).toBe(true);
  });

  it('禁用项必带原因（灰着不说话 = 铁律 4 的反例）', () => {
    for (const item of buildOutlinePanelMenu({ canCopy: true, rowCount: 0, foldableCount: 0, collapsedCount: 0 })) {
      if (item.disabled === true) expect(item.disabledReason).toBeTruthy();
    }
  });

  it('id 全表唯一，且每份菜单里同一 id 不出现两次', () => {
    const ids = Object.values(OUTLINE_MENU_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const items of [
      buildOutlineRowMenu({ canCopy: true, hasChildren: true, collapsed: false }),
      buildOutlineRowMenu({ canCopy: true, hasChildren: true, collapsed: true }),
      buildOutlinePanelMenu({ canCopy: true, rowCount: 1, foldableCount: 1, collapsedCount: 1 }),
    ]) {
      const menuIds = items.map((item) => item.id);
      expect(new Set(menuIds).size).toBe(menuIds.length);
      for (const id of menuIds) expect(ids).toContain(id);
    }
  });
});
