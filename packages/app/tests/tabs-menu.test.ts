// @vitest-environment happy-dom
/**
 * 标签页 / 标签栏空白区 / 编辑器组头三个右键面的判据（1023 覆盖面批 · WP2.3 / 2.4）。
 *
 * 钉四件事：
 * - **项集合随事实变**：固定态、有无已保存标签、有无资源管理器、命令通道在不在、
 *   分屏与否，各自的显示/禁用/原因都对得上；
 * - **文案全中文**：中文化守卫过一遍后一条都不掉（含子菜单）；
 * - **命令项与命令表同源**：标题与键位取 `menuItemFromCommand`，不另写一份文案/键位；
 * - **三级路由**：标签行 → `tabs`、标签栏空白 → `tab-bar-blank`、组头 → `editor-group-header`，
 *   没有菜单桥（面没话说）时回落到兜底而不是弹空壳。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import {
  filterChineseMenuItems,
  isChineseMenuLabel,
  menuItemFromCommand,
  type ContextMenuItem,
} from '../src/ui/context-menu-model';
import {
  CLOSE_SAVED_EMPTY_REASON,
  TAB_LIST_LIMIT,
  batchCloseEmptyReason,
  groupMenuItemsFor,
  planCloseSaved,
  tabListIndexOf,
  tabMenuItemsFor,
  type GroupMenuFacts,
  type TabMenuFacts,
} from '../src/ui/tabs-ops';
import { registerTabsMenuBridge, type TabsMenuBridge } from '../src/ui/tabs-bar';

/** 最保守的事实：只剩「恒在」的那些项 */
const TAB_FACTS: TabMenuFacts = {
  pinned: false,
  hasSaved: true,
  canReveal: false,
  hasReopen: false,
  canSplit: false,
  hasRoot: false,
};

const ids = (items: readonly ContextMenuItem[]): string[] => items.map((i) => i.id);
const byId = (items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined =>
  items.find((i) => i.id === id);

/* ------------------------------ 标签行菜单 ------------------------------ */

describe('tabMenuItemsFor · 项集合', () => {
  it('缺省事实：关闭类五项 · 固定 · 复制两档 · 拆分两项（无新能力时的常态）', () => {
    expect(ids(tabMenuItemsFor(TAB_FACTS))).toEqual([
      'close',
      'close-others',
      'close-right',
      'close-saved',
      'close-all',
      'toggle-pin',
      'copy-path',
      'copy-name',
      'split-right',
      'split-down',
    ]);
  });

  it('固定 / 取消固定只差文案，位置不变', () => {
    const pinned = tabMenuItemsFor({ ...TAB_FACTS, pinned: true });
    expect(byId(pinned, 'toggle-pin')?.label).toBe('取消固定');
    expect(ids(pinned)).toEqual(ids(tabMenuItemsFor(TAB_FACTS)));
  });

  it('关闭已保存：有已保存标签才可点，否则灰着并说明原因', () => {
    expect(byId(tabMenuItemsFor(TAB_FACTS), 'close-saved')).toMatchObject({
      id: 'close-saved',
      label: '关闭已保存',
    });
    expect(byId(tabMenuItemsFor(TAB_FACTS), 'close-saved')?.disabled).toBeUndefined();

    const noneSaved = byId(tabMenuItemsFor({ ...TAB_FACTS, hasSaved: false }), 'close-saved');
    expect(noneSaved?.disabled).toBe(true);
    expect(noneSaved?.disabledReason).toBe(CLOSE_SAVED_EMPTY_REASON);
  });

  it('复制相对路径只在有项目根时出现（没有基准就不给半截路径）', () => {
    expect(byId(tabMenuItemsFor(TAB_FACTS), 'copy-relative')).toBeUndefined();
    const withRoot = tabMenuItemsFor({ ...TAB_FACTS, hasRoot: true });
    expect(byId(withRoot, 'copy-relative')?.label).toBe('复制相对路径');
    // 三档复制连在一起：路径 → 相对路径 → 文件名
    expect(ids(withRoot).filter((id) => id.startsWith('copy-'))).toEqual([
      'copy-path',
      'copy-relative',
      'copy-name',
    ]);
  });

  it('在资源管理器中显示：桌面壳才有（浏览器壳整项不显示）', () => {
    expect(byId(tabMenuItemsFor(TAB_FACTS), 'reveal')).toBeUndefined();
    const withReveal = byId(tabMenuItemsFor({ ...TAB_FACTS, canReveal: true }), 'reveal');
    expect(withReveal?.label).toBe('在资源管理器中显示');
    expect(withReveal?.icon).toBe('popout');
  });

  it('恢复关闭的标签：标题与键位照命令表（通道不在就没有这一项）', () => {
    expect(byId(tabMenuItemsFor(TAB_FACTS), 'reopen')).toBeUndefined();
    const item = byId(tabMenuItemsFor({ ...TAB_FACTS, hasReopen: true }), 'reopen');
    const command = menuItemFromCommand('workbench.reopenClosedTab');
    expect(item?.label).toBe(command?.label);
    expect(item?.label).toBe('恢复关闭的标签');
    expect(item?.shortcut).toBe(command?.shortcut);
  });

  it('分屏：命令通道可用时给「在新编辑器组打开」+ 右/下拆分', () => {
    const items = tabMenuItemsFor({ ...TAB_FACTS, canSplit: true });
    expect(byId(items, 'open-in-new-group')?.label).toBe('在新编辑器组打开');
    expect(byId(items, 'split-right')?.label).toBe(
      menuItemFromCommand('workbench.splitEditor')?.label,
    );
    expect(byId(items, 'split-down')?.label).toBe(
      menuItemFromCommand('workbench.splitEditorDown')?.label,
    );
    expect(byId(items, 'split-right')?.disabled).toBeUndefined();
  });

  it('命令通道不在：拆分项灰着并说明原因，合成项整项不显示', () => {
    const items = tabMenuItemsFor(TAB_FACTS);
    expect(byId(items, 'open-in-new-group')).toBeUndefined();
    for (const id of ['split-right', 'split-down']) {
      expect(byId(items, id)?.disabled).toBe(true);
      expect(byId(items, id)?.disabledReason).toBe('未打开项目或命令未就绪');
    }
  });

  it('「移动标签到其他组」不在表里（App 没有这条动作，按铁律不画幽灵入口）', () => {
    const all = tabMenuItemsFor({
      pinned: true,
      hasSaved: true,
      canReveal: true,
      hasReopen: true,
      canSplit: true,
      hasRoot: true,
    });
    expect(ids(all)).not.toContain('move-to-group');
  });
});

describe('tabMenuItemsFor · 文案与键位', () => {
  const full = tabMenuItemsFor({
    pinned: false,
    hasSaved: true,
    canReveal: true,
    hasReopen: true,
    canSplit: true,
    hasRoot: true,
  });

  it('全部 label 含中文（中文化守卫一条都不丢）', () => {
    for (const item of full) expect(isChineseMenuLabel(item.label), item.label).toBe(true);
    expect(filterChineseMenuItems(full)).toHaveLength(full.length);
  });

  it('快捷键只来自命令表（关闭 = 键位表里 workbench.closeActiveTab 的那一条）', () => {
    const command = menuItemFromCommand('workbench.closeActiveTab');
    expect(byId(full, 'close')?.shortcut).toBe(command?.shortcut);
    expect(byId(full, 'close')?.label).toBe('关闭');
  });

  it('没有命令的动作不编键位（关闭其他/复制/显示类均为空）', () => {
    for (const id of ['close-others', 'close-right', 'close-saved', 'close-all', 'copy-path', 'copy-name', 'copy-relative', 'reveal', 'open-in-new-group', 'toggle-pin']) {
      expect(byId(full, id)?.shortcut, id).toBeUndefined();
    }
  });

  it('分隔线只画在段首（首项永不带，且没有连续两条）', () => {
    expect(full[0]?.dividerBefore).toBeUndefined();
    const dividers = full.filter((i) => i.dividerBefore === true).map((i) => i.id);
    expect(dividers).toEqual(['toggle-pin', 'copy-path', 'open-in-new-group']);
  });
});

/* --------------------- 标签栏空白区 / 编辑器组头菜单 --------------------- */

const GROUP_FACTS: GroupMenuFacts = {
  groupCount: 1,
  tabs: ['C:/koa/a.ERB', 'C:/koa/b.ERB'],
  active: 'C:/koa/b.ERB',
  pinned: new Set<string>(),
  canCloseGroup: true,
  canSplit: true,
};

describe('groupMenuItemsFor · 项集合', () => {
  it('拆分 → 全部保存 → 按组关闭 → 标签列表（单组时没有「关闭编辑器组」）', () => {
    const items = groupMenuItemsFor(GROUP_FACTS);
    expect(ids(items)).toEqual(['split-right', 'split-down', 'save-all', 'close-group-tabs', 'tab-list']);
    expect(byId(items, 'save-all')?.label).toBe('全部保存');
  });

  it('分屏中才有「关闭编辑器组」', () => {
    const items = groupMenuItemsFor({ ...GROUP_FACTS, groupCount: 2 });
    expect(ids(items)).toEqual([
      'split-right',
      'split-down',
      'close-group',
      'save-all',
      'close-group-tabs',
      'tab-list',
    ]);
    expect(byId(items, 'close-group')?.label).toBe('关闭编辑器组');
    // 宿主没给回调（canCloseGroup=false）时同样整项不显示
    expect(
      byId(groupMenuItemsFor({ ...GROUP_FACTS, groupCount: 2, canCloseGroup: false }), 'close-group'),
    ).toBeUndefined();
  });

  it('按组关闭的可点性 = 既有批量关闭计划是否非空（固定标签不清扫）', () => {
    const allPinnedSoon = groupMenuItemsFor({
      ...GROUP_FACTS,
      tabs: ['C:/koa/a.ERB', 'C:/koa/b.ERB'],
      pinned: new Set(['C:/koa/a.ERB', 'C:/koa/b.ERB']),
    });
    const item = byId(allPinnedSoon, 'close-group-tabs');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toBe(
      batchCloseEmptyReason('all', ['C:/koa/a.ERB', 'C:/koa/b.ERB'], 'C:/koa/b.ERB', new Set(['C:/koa/a.ERB', 'C:/koa/b.ERB'])),
    );
  });

  it('标签列表：子项是「切换到 <文件名>」，当前激活那枚打勾', () => {
    const item = byId(groupMenuItemsFor(GROUP_FACTS), 'tab-list');
    expect(item?.label).toBe('标签列表');
    expect(item?.children?.map((c) => c.label)).toEqual(['切换到 a.ERB', '切换到 b.ERB']);
    expect(item?.children?.[1]?.checked).toBe(true);
    expect(item?.children?.[0]?.checked).toBeUndefined();
    // 子项 id 是下标形态，可反解
    expect(tabListIndexOf(item?.children?.[1]?.id ?? '')).toBe(1);
  });

  it('标签列表：超过上限时截断，并如实说明还有多少没列出', () => {
    const many = Array.from({ length: TAB_LIST_LIMIT + 3 }, (_, i) => `C:/koa/f${i}.ERB`);
    const item = byId(groupMenuItemsFor({ ...GROUP_FACTS, tabs: many, active: many[0]! }), 'tab-list');
    expect(item?.children).toHaveLength(TAB_LIST_LIMIT + 1);
    const last = item?.children?.[item.children.length - 1];
    expect(last?.label).toBe('还有 3 个标签未列出');
    expect(last?.disabled).toBe(true);
    expect(tabListIndexOf(last?.id ?? '')).toBeNull();
  });

  it('空组：标签列表灰着说明原因，也没有「关闭本组全部标签」', () => {
    const items = groupMenuItemsFor({ ...GROUP_FACTS, tabs: [], active: null });
    expect(byId(items, 'close-group-tabs')).toBeUndefined();
    const list = byId(items, 'tab-list');
    expect(list?.disabled).toBe(true);
    expect(list?.disabledReason).toBe('本组还没有打开的标签');
  });

  it('groupMenuItemsFor 的 label 全中文（含子菜单）', () => {
    const items = groupMenuItemsFor({ ...GROUP_FACTS, groupCount: 2 });
    for (const item of items) {
      expect(isChineseMenuLabel(item.label), item.label).toBe(true);
      for (const child of item.children ?? []) {
        expect(isChineseMenuLabel(child.label), child.label).toBe(true);
      }
    }
    expect(filterChineseMenuItems(items)).toHaveLength(items.length);
  });
});

/* ------------------------------ 关闭已保存的计划 ------------------------------ */

describe('planCloseSaved · 计划', () => {
  it('只关干净且非固定的标签（固定标签绝不被批量清扫）', () => {
    const tabs = ['C:/koa/a.ERB', 'C:/koa/b.ERB', 'C:/koa/c.ERB'];
    const plan = planCloseSaved(tabs, 'C:/koa/a.ERB', new Set(['C:/koa/b.ERB']), new Set(['C:/koa/c.ERB']));
    expect(plan).toEqual(['C:/koa/a.ERB']);
  });

  it('全是脏的 / 全是固定的 ⇒ 空计划（调用方按 CLOSE_SAVED_EMPTY_REASON 说话）', () => {
    const tabs = ['C:/koa/a.ERB', 'C:/koa/b.ERB'];
    expect(planCloseSaved(tabs, tabs[0]!, new Set(), new Set(tabs))).toEqual([]);
    expect(planCloseSaved(tabs, tabs[0]!, new Set(tabs), new Set())).toEqual([]);
  });
});

/* ------------------------------ 三级路由 ------------------------------ */

const event = (): MouseEvent => new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 34 });

interface BridgeSpies {
  readonly bridge: TabsMenuBridge;
  readonly copyText: ReturnType<typeof vi.fn>;
  readonly activate: ReturnType<typeof vi.fn>;
  readonly requestClose: ReturnType<typeof vi.fn>;
  readonly batchClose: ReturnType<typeof vi.fn>;
  readonly closeSaved: ReturnType<typeof vi.fn>;
  readonly closeGroup: ReturnType<typeof vi.fn>;
  readonly saveAll: ReturnType<typeof vi.fn>;
}

const makeBridge = (overrides: Partial<TabsMenuBridge> = {}): BridgeSpies => {
  const copyText = vi.fn();
  const activate = vi.fn();
  const requestClose = vi.fn();
  const batchClose = vi.fn();
  const closeSaved = vi.fn();
  const closeGroup = vi.fn();
  const saveAll = vi.fn();
  const bridge: TabsMenuBridge = {
    groupId: 'eg-1',
    groupCount: 2,
    openTabs: ['C:/koa/a.ERB', 'C:/koa/b.ERB'],
    active: 'C:/koa/a.ERB',
    dirtyPaths: new Set<string>(),
    pinnedPaths: new Set<string>(),
    rootDir: 'C:/koa',
    canCloseGroup: true,
    copyText,
    activate,
    requestClose,
    batchClose,
    togglePin: vi.fn(),
    closeSaved,
    saveAll,
    closeGroup,
    reveal: vi.fn(),
    ...overrides,
  };
  return { bridge, copyText, activate, requestClose, batchClose, closeSaved, closeGroup, saveAll };
};

let dispose: (() => void) | null = null;

const mountGroup = (): { head: HTMLElement; bar: HTMLElement; tab: HTMLElement } => {
  const head = document.createElement('div');
  head.className = 'editor-group-head';
  head.setAttribute('data-context-surface', 'editor-group-header');
  head.setAttribute('data-group-id', 'eg-1');
  const bar = document.createElement('div');
  bar.className = 'editor-tabs';
  bar.setAttribute('data-context-surface', 'tab-bar-blank');
  bar.setAttribute('data-group-id', 'eg-1');
  const tab = document.createElement('div');
  tab.setAttribute('data-context-surface', 'tabs');
  tab.setAttribute('data-tab-path', 'C:/koa/b.ERB');
  tab.textContent = 'b.ERB';
  bar.appendChild(tab);
  const saveAllButton = document.createElement('button');
  saveAllButton.className = 'tab-save-all';
  head.appendChild(bar);
  head.appendChild(saveAllButton);
  document.body.appendChild(head);
  return { head, bar, tab };
};

beforeEach(() => {
  dispose = null;
});

afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('三级路由 · 三个面各接各的', () => {
  it('标签行 → tabs（就近命中，优先级高于标签栏空白区）', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { tab } = mountGroup();
    const route = buildContextMenuRoute(tab, event());
    expect(route?.source).toBe('tabs');
    expect(route?.items.map((i) => i.id)).toContain('close');
  });

  it('标签栏空白 → tab-bar-blank（组级菜单）', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { bar } = mountGroup();
    const route = buildContextMenuRoute(bar, event());
    expect(route?.source).toBe('tab-bar-blank');
    expect(route?.items.map((i) => i.id)).toEqual([
      'split-right',
      'split-down',
      'close-group',
      'save-all',
      'close-group-tabs',
      'tab-list',
    ]);
  });

  it('组头（空白控件区）→ editor-group-header', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { head } = mountGroup();
    const route = buildContextMenuRoute(head, event());
    expect(route?.source).toBe('editor-group-header');
  });

  it('没有菜单桥（面没话说）⇒ 回落到兜底，而不是弹空壳', () => {
    const { tab } = mountGroup();
    const route = buildContextMenuRoute(tab, event());
    expect(route?.source).toBe('app-fallback');
    expect(route?.items.length).toBeGreaterThan(0);
  });

  it('桌面壳里（isTauri）多出「在资源管理器中显示」', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const { tab } = mountGroup();
    const route = buildContextMenuRoute(tab, event());
    expect(route?.items.map((i) => i.id)).toContain('reveal');
  });
});

describe('三级路由 · 选中项落到既有动作', () => {
  it('复制文件名 / 关闭 / 关闭已保存都接到桥上', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { tab } = mountGroup();
    const route = buildContextMenuRoute(tab, event());
    route?.onSelect('copy-name');
    expect(spies.copyText).toHaveBeenCalledWith('b.ERB', '已复制文件名');
    route?.onSelect('close');
    expect(spies.requestClose).toHaveBeenCalledWith('C:/koa/b.ERB');
    route?.onSelect('close-saved');
    expect(spies.closeSaved).toHaveBeenCalledWith('C:/koa/b.ERB');
  });

  it('复制相对路径按项目根裁（不拷整条绝对路径）', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { tab } = mountGroup();
    buildContextMenuRoute(tab, event())?.onSelect('copy-relative');
    expect(spies.copyText).toHaveBeenCalledWith('b.ERB', '已复制相对路径');
  });

  it('组级菜单：全部保存 → 桥；标签列表子项 → 切换到对应标签', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { bar } = mountGroup();
    const route = buildContextMenuRoute(bar, event());
    route?.onSelect('save-all');
    expect(spies.saveAll).toHaveBeenCalledTimes(1);
    route?.onSelect('tab-list:1');
    expect(spies.activate).toHaveBeenCalledWith('C:/koa/b.ERB');
    route?.onSelect('close-group');
    expect(spies.closeGroup).toHaveBeenCalledTimes(1);
    route?.onSelect('close-group-tabs');
    expect(spies.batchClose).toHaveBeenCalledWith('all', 'C:/koa/a.ERB');
  });

  it('标签行的批量关闭仍走既有模式（其他/右侧/全部），不自己过滤数组', () => {
    const spies = makeBridge();
    dispose = registerTabsMenuBridge(spies.bridge);
    const { tab } = mountGroup();
    const route = buildContextMenuRoute(tab, event());
    route?.onSelect('close-others');
    expect(spies.batchClose).toHaveBeenCalledWith('others', 'C:/koa/b.ERB');
    route?.onSelect('close-right');
    expect(spies.batchClose).toHaveBeenCalledWith('right', 'C:/koa/b.ERB');
    route?.onSelect('close-all');
    expect(spies.batchClose).toHaveBeenCalledWith('all', 'C:/koa/b.ERB');
  });
});
