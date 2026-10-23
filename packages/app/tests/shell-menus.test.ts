// @vitest-environment happy-dom
/**
 * 壳层七面的右键菜单（1023 覆盖面批 · WP3.7 / 3.8 / 4.1 / 4.2 / 4.3）。
 *
 * 判据分三层：
 * 1. **纯函数**（`build…Menu`）：给一份能力快照，项集合必须按能力增减——这是本批
 *    「不静默、不摆假入口」的唯一可测面；
 * 2. **面接线**（`getContextSurface(id).build`）：DOM 锚点 → 面认人 → `onSelect`
 *    落到宿主那一个方法上（不靠人读 JSX 猜）；
 * 3. **源码守门**：`ShellLayout.tsx` / `NotificationCenter.tsx` 里那几处
 *    `data-context-surface` / `data-*` 锚点必须在位——**面声明对了、锚点掉了**
 *    等于整面静默失灵，而运行期没人会报错（口径同 `shell-info-design.test.ts`）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_SURFACE_MANIFEST,
  buildContextMenuRoute,
  getContextSurface,
  type ContextSurfaceBuildResult,
} from '../src/ui/context-surfaces';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import { effectiveKeybindingOf, keybindingSpecOf } from '../src/ui/keybindings';
import {
  ACTIVITY_BAR_ACTION,
  FLOATING_ACTION,
  NOTIFICATION_ACTION,
  PANEL_SECTION_ACTION,
  PANEL_TABS_ACTION,
  STATUS_BAR_ACTION,
  TOOLBAR_ACTION,
  buildActivityBarMenu,
  buildFloatingWindowMenu,
  buildNotificationMenu,
  buildPanelSectionMenu,
  buildPanelTabsMenu,
  buildStatusBarMenu,
  buildToolbarMenu,
  defaultFloatRect,
  installNoticeMenuHost,
  installShellMenuHost,
  isFloatMaximized,
  maximizedFloatRect,
  statusEolActionId,
  type ShellMenuHost,
  type ShellNoticeView,
} from '../src/ui/context-menu-shell';
import { noticeActionsOf } from '../src/ui/NotificationCenter';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 七个面的 id（与任务书 WP3.7–4.3 一一对应） */
const SHELL_SURFACE_IDS = [
  'panel-tabs',
  'panel-section-header',
  'floating-window',
  'notification',
  'activity-bar',
  'toolbar',
  'status-bar',
] as const;

const idsOf = (items: readonly ContextMenuItem[]): string[] => items.map((item) => item.id);
const byId = (items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined =>
  items.find((item) => item.id === id);

/** `build` 的产物归一：本批各面一律返回对象形态（带 onSelect），数组形态是陷阱 */
function menuOf(result: ContextSurfaceBuildResult): {
  items: readonly ContextMenuItem[];
  onSelect: (id: string) => void;
} {
  if (result === null) throw new Error('面没有表态（null）：这一级应交给兜底，而不是弹出空菜单');
  if (Array.isArray(result)) throw new Error('面返回了数组形态：宿主不会替你分发动作，点了等于没反应');
  const menu = result as { readonly items: readonly ContextMenuItem[]; readonly onSelect?: (id: string) => void };
  if (menu.onSelect === undefined) throw new Error('面给了 items 却没给 onSelect（选中不做事）');
  return { items: menu.items, onSelect: menu.onSelect };
}

const contextEvent = (): MouseEvent => new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 8 });

/** 宿主桩：把菜单动作按「方法名:参数」记下来 */
function hostStub(overrides: Partial<ShellMenuHost> = {}): { host: ShellMenuHost; calls: string[] } {
  const calls: string[] = [];
  const host: ShellMenuHost = {
    snapshot: () => ({
      floating: {},
      sidebarVisible: true,
      activeViewKey: 'group:main',
      eol: 'LF',
      canSwitchEol: true,
    }),
    containerOf: (panelId) => (panelId === 'p1' ? 'aux' : null),
    panelsOfView: (viewKey) => (viewKey === 'group:main' ? ['p1', 'p2'] : []),
    isCollapsed: () => false,
    closeContainer: (container) => calls.push(`close:${container}`),
    toggleSidebarView: (viewKey) => calls.push(`toggleView:${viewKey}`),
    float: (panelId) => calls.push(`float:${panelId}`),
    dock: (panelId) => calls.push(`dock:${panelId}`),
    move: (panelId, to) => calls.push(`move:${panelId}:${to}`),
    maximizeFloat: (panelId) => calls.push(`maximize:${panelId}`),
    resetFloat: (panelId) => calls.push(`resetFloat:${panelId}`),
    toggleCollapse: (panelId) => calls.push(`collapse:${panelId}`),
    resetLayout: () => calls.push('resetLayout'),
    switchEol: (eol) => calls.push(`eol:${eol}`),
    ...overrides,
  };
  return { host, calls };
}

afterEach(() => {
  installShellMenuHost(null);
  installNoticeMenuHost(null);
  document.body.innerHTML = '';
});

/* ------------------------------ 清单与声明 ------------------------------ */

describe('七个壳层面：清单内 + 已声明 + 带 build', () => {
  it('id 全部在 CONTEXT_SURFACE_MANIFEST 里（清单是权威，未登记会在启动时告警）', () => {
    const known = new Set(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id));
    for (const id of SHELL_SURFACE_IDS) expect(known.has(id)).toBe(true);
  });

  it('七个面都已声明且都带 build（缺 build = 右键落到兜底，面上什么都不发生）', () => {
    for (const id of SHELL_SURFACE_IDS) {
      const spec = getContextSurface(id);
      expect(spec, `面 ${id} 未声明`).toBeDefined();
      expect(typeof spec?.build).toBe('function');
      expect(spec?.ariaLabel ?? '').toMatch(/菜单$/);
    }
  });

  it('宿主未注入时七个面一律「不表态」（null），让路由往兜底走而不是弹空壳', () => {
    const target = document.createElement('div');
    target.setAttribute('data-panel-id', 'p1');
    document.body.appendChild(target);
    for (const id of SHELL_SURFACE_IDS) {
      const build = getContextSurface(id)?.build;
      if (build === undefined) throw new Error(`面 ${id} 没有 build`);
      expect(build({ id, target, event: contextEvent() })).toBeNull();
    }
  });
});

/* ------------------------------ 面板选项卡（WP3.7） ------------------------------ */

describe('面板选项卡菜单 · 能力矩阵', () => {
  const base = { container: 'aux' as const, isFloating: false, canMove: true, canHide: true };

  it('停靠态：浮动 + 三档移动 + 关闭面板区 + 重置布局', () => {
    const items = buildPanelTabsMenu(base);
    expect(idsOf(items)).toEqual([
      PANEL_TABS_ACTION.FLOAT,
      PANEL_TABS_ACTION.MOVE_LEFT,
      PANEL_TABS_ACTION.MOVE_RIGHT,
      PANEL_TABS_ACTION.MOVE_BOTTOM,
      PANEL_TABS_ACTION.CLOSE,
      'layout.reset',
    ]);
  });

  it('已浮动 ⇒ 「停靠回容器」替代「浮动为浮窗」（两项互斥，不同时出现）', () => {
    const items = buildPanelTabsMenu({ ...base, isFloating: true });
    expect(byId(items, PANEL_TABS_ACTION.DOCK)?.label).toBe('停靠回容器');
    expect(byId(items, PANEL_TABS_ACTION.FLOAT)).toBeUndefined();
  });

  it('canMove=false ⇒ 三档移动整项不显示（不留灰着的假入口）', () => {
    const items = buildPanelTabsMenu({ ...base, canMove: false });
    expect(idsOf(items)).not.toContain(PANEL_TABS_ACTION.MOVE_LEFT);
    expect(idsOf(items)).not.toContain(PANEL_TABS_ACTION.MOVE_RIGHT);
    expect(idsOf(items)).not.toContain(PANEL_TABS_ACTION.MOVE_BOTTOM);
  });

  it('canHide=false ⇒ 「关闭面板区」不显示（没有容器可收）', () => {
    const items = buildPanelTabsMenu({ ...base, canHide: false });
    expect(idsOf(items)).not.toContain(PANEL_TABS_ACTION.CLOSE);
  });

  it('面板已在底部区 ⇒ 「移动到底部区」禁用并给原因（上下文暂不可用 ≠ 能力不存在）', () => {
    const bottom = buildPanelTabsMenu({ ...base, container: 'bottom' });
    const move = byId(bottom, PANEL_TABS_ACTION.MOVE_BOTTOM);
    expect(move?.disabled).toBe(true);
    expect(move?.disabledReason ?? '').toContain('已经在底部区');
    const aux = byId(buildPanelTabsMenu(base), PANEL_TABS_ACTION.MOVE_BOTTOM);
    expect(aux?.disabled).toBeUndefined();
  });

  it('「关闭」不等于「隐藏」：关的是整个面板区，菜单里没有冒充的「隐藏面板」项', () => {
    const items = buildPanelTabsMenu(base);
    expect(byId(items, PANEL_TABS_ACTION.CLOSE)?.label).toBe('关闭面板区');
    expect(items.some((item) => item.label.includes('隐藏'))).toBe(false);
    expect(idsOf(items)).not.toContain('tabs.hide');
  });
});

/* ------------------------------ 分区头 ------------------------------ */

describe('面板分区菜单 · 折叠 / 展开', () => {
  it('展开态 ⇒ 「折叠分区」；折叠态 ⇒ 「展开分区」（文案跟着当下状态）', () => {
    expect(byId(buildPanelSectionMenu({ collapsed: false }), PANEL_SECTION_ACTION.COLLAPSE)?.label).toBe(
      '折叠分区',
    );
    expect(byId(buildPanelSectionMenu({ collapsed: true }), PANEL_SECTION_ACTION.EXPAND)?.label).toBe(
      '展开分区',
    );
  });

  it('「重置布局」在（命令项 id 即命令 id）', () => {
    expect(idsOf(buildPanelSectionMenu({ collapsed: false }))).toContain('layout.reset');
  });

  it('没有「隐藏分区」：布局状态机只有容器显隐，单个分区没有独立显隐位', () => {
    const items = buildPanelSectionMenu({ collapsed: false });
    expect(items.some((item) => item.label.includes('隐藏'))).toBe(false);
  });
});

/* ------------------------------ 浮窗 ------------------------------ */

describe('浮窗菜单 · 最大化 / 还原 / 重置', () => {
  it('未最大化 ⇒ 最大化 + 重置；已最大化 ⇒ 还原 + 重置（不会同时给两条相反的路）', () => {
    const normal = buildFloatingWindowMenu({ isMaximized: false, canHide: true });
    expect(idsOf(normal)).toContain(FLOATING_ACTION.MAXIMIZE);
    expect(idsOf(normal)).not.toContain(FLOATING_ACTION.RESTORE);
    const maxed = buildFloatingWindowMenu({ isMaximized: true, canHide: true });
    expect(idsOf(maxed)).toContain(FLOATING_ACTION.RESTORE);
    expect(idsOf(maxed)).not.toContain(FLOATING_ACTION.MAXIMIZE);
    expect(idsOf(maxed)).toContain(FLOATING_ACTION.RESET);
  });

  it('关闭 + 三档停靠恒在（停靠是既有 `dock` + `move` 的组合）', () => {
    const items = buildFloatingWindowMenu({ isMaximized: false, canHide: true });
    expect(idsOf(items)).toEqual([
      FLOATING_ACTION.CLOSE,
      FLOATING_ACTION.DOCK_LEFT,
      FLOATING_ACTION.DOCK_RIGHT,
      FLOATING_ACTION.DOCK_BOTTOM,
      FLOATING_ACTION.MAXIMIZE,
      FLOATING_ACTION.RESET,
    ]);
  });

  it('canHide=false ⇒ 「关闭浮窗」不显示', () => {
    const items = buildFloatingWindowMenu({ isMaximized: false, canHide: false });
    expect(idsOf(items)).not.toContain(FLOATING_ACTION.CLOSE);
  });

  it('「关闭浮窗」与面板选项卡的「关闭面板区」不是同一件事（id 与文案都分开）', () => {
    const floating = byId(buildFloatingWindowMenu({ isMaximized: false, canHide: true }), FLOATING_ACTION.CLOSE);
    const tabs = byId(buildPanelTabsMenu({ container: 'aux', isFloating: false, canMove: true, canHide: true }), PANEL_TABS_ACTION.CLOSE);
    expect(floating?.id).not.toBe(tabs?.id);
    expect(floating?.label).not.toBe(tabs?.label);
  });
});

describe('浮窗几何（初值 / 最大化 / 判据）', () => {
  it('初值夹在 460–960 × 320–680 之间并居中', () => {
    expect(defaultFloatRect(0, { w: 4000, h: 3000 })).toEqual({ x: 1520, y: 64, w: 960, h: 680 });
    expect(defaultFloatRect(0, { w: 800, h: 600 })).toEqual({ x: 170, y: 64, w: 460, h: 372 });
  });

  it('多窗层叠错位（同视口下第 n 个右下偏移 26px）', () => {
    const first = defaultFloatRect(0, { w: 1200, h: 800 });
    const second = defaultFloatRect(2, { w: 1200, h: 800 });
    expect(second.x - first.x).toBe(52);
    expect(second.y - first.y).toBe(52);
  });

  it('最大化 = 铺满视口（容 1px 取整差）；明显没铺满就不算，否则「还原」会凭空跳一下', () => {
    expect(maximizedFloatRect({ w: 1280, h: 720 })).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(isFloatMaximized({ x: 0, y: 0, w: 1280, h: 720 }, { w: 1280, h: 720 })).toBe(true);
    expect(isFloatMaximized({ x: 0, y: 0, w: 1279, h: 720 }, { w: 1280, h: 720 })).toBe(true);
    expect(isFloatMaximized({ x: 0, y: 0, w: 1200, h: 720 }, { w: 1280, h: 720 })).toBe(false);
    expect(isFloatMaximized({ x: 40, y: 0, w: 1280, h: 720 }, { w: 1280, h: 720 })).toBe(false);
  });
});

/* ------------------------------ 通知（WP3.8） ------------------------------ */

describe('通知菜单 · 动作与清除', () => {
  it('没有动作 ⇒ 不出现执行项（hasAction=false）', () => {
    const items = buildNotificationMenu({ hasAction: false, actionLabels: [], total: 3 });
    expect(items.some((item) => item.id.startsWith('notice.run'))).toBe(false);
  });

  it('一个动作 ⇒ 一项「执行「去授权」」；两个以上 ⇒ 收进子菜单', () => {
    const one = buildNotificationMenu({ hasAction: true, actionLabels: ['去授权'], total: 1 });
    expect(byId(one, `${NOTIFICATION_ACTION.RUN_PREFIX}0`)?.label).toBe('执行「去授权」');
    const many = buildNotificationMenu({
      hasAction: true,
      actionLabels: ['先看差异', '放弃我的修改'],
      total: 2,
    });
    const parent = many.find((item) => item.children !== undefined);
    expect(parent?.children?.map((child) => child.label)).toEqual([
      '执行「先看差异」',
      '执行「放弃我的修改」',
    ]);
  });

  it('屏上只有一条 ⇒ 「清除全部通知」禁用并说明；两条以上可用', () => {
    const single = buildNotificationMenu({ hasAction: false, actionLabels: [], total: 1 });
    const only = byId(single, NOTIFICATION_ACTION.CLEAR_ALL);
    expect(only?.disabled).toBe(true);
    expect(only?.disabledReason ?? '').toContain('只有这一条');
    const many = buildNotificationMenu({ hasAction: false, actionLabels: [], total: 2 });
    expect(byId(many, NOTIFICATION_ACTION.CLEAR_ALL)?.disabled).toBeUndefined();
  });

  it('「清除这条」与「清除全部」是两条不同的项（id 不同、不共用一个处理）', () => {
    const items = buildNotificationMenu({ hasAction: false, actionLabels: [], total: 2 });
    expect(NOTIFICATION_ACTION.DISMISS).not.toBe(NOTIFICATION_ACTION.CLEAR_ALL);
    expect(idsOf(items)).toContain(NOTIFICATION_ACTION.DISMISS);
    expect(idsOf(items)).toContain(NOTIFICATION_ACTION.CLEAR_ALL);
  });

  it('复制项恒在（通知内容永远有可复制的文字）', () => {
    expect(idsOf(buildNotificationMenu({ hasAction: false, actionLabels: [], total: 1 }))).toContain(
      NOTIFICATION_ACTION.COPY,
    );
  });
});

describe('通知动作顺序（菜单序号 = 屏上按钮顺序）', () => {
  it('`action` 在前、`actions` 在后', () => {
    const labels = noticeActionsOf({
      kind: 'error',
      message: '磁盘被外部改动',
      action: { label: '去授权', run: () => undefined },
      actions: [{ label: '先看差异', run: () => undefined }],
    }).map((action) => action.label);
    expect(labels).toEqual(['去授权', '先看差异']);
  });
});

/* ------------------------------ 活动栏（WP4.1） ------------------------------ */

describe('活动栏菜单 · 显示隐藏与迁移', () => {
  it('当前激活 ⇒ 「隐藏此视图」；未激活 ⇒ 「显示此视图」', () => {
    expect(byId(buildActivityBarMenu({ active: true, canMove: true }), ACTIVITY_BAR_ACTION.HIDE)?.label).toBe(
      '隐藏此视图',
    );
    expect(byId(buildActivityBarMenu({ active: false, canMove: true }), ACTIVITY_BAR_ACTION.SHOW)?.label).toBe(
      '显示此视图',
    );
  });

  it('「隐藏此视图」不叫「关闭」（活动栏没有关掉视图这个概念）', () => {
    const items = buildActivityBarMenu({ active: true, canMove: true });
    expect(items.some((item) => item.label.includes('关闭'))).toBe(false);
  });

  it('canMove=false ⇒ 「移到右侧栏」不显示', () => {
    expect(idsOf(buildActivityBarMenu({ active: true, canMove: false }))).not.toContain(
      ACTIVITY_BAR_ACTION.MOVE_AUX,
    );
  });

  it('「重置布局」在', () => {
    expect(idsOf(buildActivityBarMenu({ active: true, canMove: true }))).toContain('layout.reset');
  });
});

/* ------------------------------ 工具栏（WP4.2） ------------------------------ */

describe('工具栏菜单 · 复制与设置', () => {
  it('挂了命令 ⇒ 复制标题 + 复制 ID + 打开设置', () => {
    const items = buildToolbarMenu({ commandId: 'workbench.snapshotInjector' });
    expect(idsOf(items)).toEqual([
      TOOLBAR_ACTION.COPY_TITLE,
      TOOLBAR_ACTION.COPY_ID,
      'layout.openSettings',
    ]);
  });

  it('没有「隐藏此按钮」：壳层没有工具栏自定义能力，摆一个假开关就是骗人', () => {
    const items = buildToolbarMenu({ commandId: 'workbench.snapshotInjector' });
    expect(items.some((item) => item.label.includes('隐藏'))).toBe(false);
  });

  it('空白处 / 壳层自带按钮不接管（那些地方兜底菜单里的命令面板更值得给）', () => {
    installShellMenuHost(hostStub().host);
    const header = document.createElement('header');
    header.setAttribute('data-context-surface', 'toolbar');
    const bare = document.createElement('button');
    bare.title = '重载项目';
    header.appendChild(bare);
    const blank = document.createElement('span');
    blank.className = 'toolbar-sep';
    header.appendChild(blank);
    document.body.appendChild(header);
    const build = getContextSurface('toolbar')?.build;
    if (build === undefined) throw new Error('面未声明');
    expect(build({ id: 'toolbar', target: bare, event: contextEvent() })).toBeNull();
    expect(build({ id: 'toolbar', target: blank, event: contextEvent() })).toBeNull();
  });
});

/* ------------------------------ 状态栏（WP4.3） ------------------------------ */

describe('状态栏菜单 · 复制 / 换行符 / 设置', () => {
  it('没有文字 ⇒「复制状态文本」禁用并说明（不是删掉，用户要知道为什么）', () => {
    const items = buildStatusBarMenu({ text: '', eol: null, canSwitchEol: false });
    const copy = byId(items, STATUS_BAR_ACTION.COPY);
    expect(copy?.disabled).toBe(true);
    expect(copy?.disabledReason ?? '').toContain('没有可复制的文字');
  });

  it('有文字 ⇒ 可复制', () => {
    const items = buildStatusBarMenu({ text: 'UTF-8 · LF · 120 行', eol: 'LF', canSwitchEol: false });
    expect(byId(items, STATUS_BAR_ACTION.COPY)?.disabled).toBeUndefined();
  });

  it('不可切换换行符（只读 / 预览面）⇒ 整条子菜单不显示', () => {
    const items = buildStatusBarMenu({ text: 'x', eol: 'LF', canSwitchEol: false });
    expect(idsOf(items)).not.toContain(STATUS_BAR_ACTION.EOL_MENU);
  });

  it('可切换 ⇒ LF / CRLF 两项，当前档打勾', () => {
    const items = buildStatusBarMenu({ text: 'x', eol: 'CRLF', canSwitchEol: true });
    const eol = byId(items, STATUS_BAR_ACTION.EOL_MENU);
    expect(eol?.children?.map((child) => [child.id, child.checked])).toEqual([
      [statusEolActionId('LF'), false],
      [statusEolActionId('CRLF'), true],
    ]);
  });

  it('「打开设置」在', () => {
    expect(idsOf(buildStatusBarMenu({ text: 'x', eol: null, canSwitchEol: false }))).toContain(
      'layout.openSettings',
    );
  });

  it('索引详情 / 重建索引不出现：没有这两条命令，也没有对应服务入口（铁律 3）', () => {
    const items = buildStatusBarMenu({ text: '12 文件 · 34 函数', eol: 'LF', canSwitchEol: true });
    expect(items.some((item) => item.label.includes('索引'))).toBe(false);
  });

  it('状态栏空白处不接管（没有「这一格」就没有可复制的东西）', () => {
    installShellMenuHost(hostStub().host);
    const footer = document.createElement('footer');
    footer.setAttribute('data-context-surface', 'status-bar');
    const blank = document.createElement('span');
    blank.className = 'sb-spacer';
    footer.appendChild(blank);
    document.body.appendChild(footer);
    const build = getContextSurface('status-bar')?.build;
    if (build === undefined) throw new Error('面未声明');
    expect(build({ id: 'status-bar', target: blank, event: contextEvent() })).toBeNull();
  });
});

/* ------------------------------ 文案与命令同源 ------------------------------ */

describe('文案口径', () => {
  const allMenus = (): ContextMenuItem[][] => [
    buildPanelTabsMenu({ container: 'aux', isFloating: false, canMove: true, canHide: true }),
    buildPanelTabsMenu({ container: 'bottom', isFloating: true, canMove: true, canHide: false }),
    buildPanelSectionMenu({ collapsed: false }),
    buildPanelSectionMenu({ collapsed: true }),
    buildFloatingWindowMenu({ isMaximized: false, canHide: true }),
    buildFloatingWindowMenu({ isMaximized: true, canHide: true }),
    buildNotificationMenu({ hasAction: true, actionLabels: ['去授权'], total: 1 }),
    buildNotificationMenu({ hasAction: true, actionLabels: ['甲', '乙'], total: 3 }),
    buildActivityBarMenu({ active: true, canMove: true }),
    buildActivityBarMenu({ active: false, canMove: true }),
    buildToolbarMenu({ commandId: 'workbench.snapshotInjector' }),
    buildStatusBarMenu({ text: 'x', eol: 'LF', canSwitchEol: true }),
  ];

  it('每一条 label（含子菜单）都含中日韩文字', () => {
    const walk = (items: readonly ContextMenuItem[]): void => {
      for (const item of items) {
        expect(isChineseMenuLabel(item.label), `非中文菜单项：${item.label}`).toBe(true);
        if (item.children !== undefined) walk(item.children);
      }
    };
    for (const items of allMenus()) walk(items);
  });

  it('禁用项一律带原因（灰着不说话 = 按了没反应）', () => {
    for (const items of allMenus()) {
      for (const item of items) {
        if (item.disabled === true) expect((item.disabledReason ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('命令项的标题与键位来自键位注册表（不另造第二份文案）', () => {
    for (const items of allMenus()) {
      for (const item of items) {
        if (item.id !== 'layout.reset' && item.id !== 'layout.openSettings') continue;
        expect(item.label).toBe(keybindingSpecOf(item.id)?.title);
        // 这两条命令没有缺省键位 ⇒ 菜单也不许编一个键位提示出来
        expect(item.shortcut).toBeUndefined();
        expect(effectiveKeybindingOf(item.id)).toBeUndefined();
      }
    }
  });
});

/* ------------------------------ 面接线（DOM 锚点 → 宿主动作） ------------------------------ */

describe('面板选项卡面：从 DOM 认面板，动作落到既有布局能力', () => {
  function stripWithTab(): { strip: HTMLElement; tab: HTMLElement; blank: HTMLElement } {
    const strip = document.createElement('div');
    strip.setAttribute('data-context-surface', 'panel-tabs');
    strip.setAttribute('data-panel-tabs-container', 'aux');
    strip.setAttribute('data-active-panel', 'p2');
    const tab = document.createElement('button');
    tab.setAttribute('data-panel-id', 'p1');
    tab.textContent = '问题';
    const blank = document.createElement('span');
    blank.className = 'spacer';
    strip.append(tab, blank);
    document.body.appendChild(strip);
    return { strip, tab, blank };
  }

  it('点在选项卡上 ⇒ 菜单认的是那颗面板；点空白处 ⇒ 认当前激活的那颗', () => {
    const { host } = hostStub();
    installShellMenuHost(host);
    const { tab, blank } = stripWithTab();
    const build = getContextSurface('panel-tabs')?.build;
    if (build === undefined) throw new Error('面未声明');

    const onTab = menuOf(build({ id: 'panel-tabs', target: tab, event: contextEvent() }));
    onTab.onSelect(PANEL_TABS_ACTION.FLOAT);
    const onBlank = menuOf(build({ id: 'panel-tabs', target: blank, event: contextEvent() }));
    onBlank.onSelect(PANEL_TABS_ACTION.FLOAT);

    // p1 在贡献集合里（containerOf 有答案），p2 不在 ⇒ 空白处那份菜单没有移动项
    expect(idsOf(onTab.items)).toContain(PANEL_TABS_ACTION.MOVE_LEFT);
    expect(idsOf(onBlank.items)).not.toContain(PANEL_TABS_ACTION.MOVE_LEFT);
  });

  it('宿主动作按 id 分发：浮动 / 移动 / 关闭面板区', () => {
    const { host, calls } = hostStub();
    installShellMenuHost(host);
    const { tab } = stripWithTab();
    const build = getContextSurface('panel-tabs')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'panel-tabs', target: tab, event: contextEvent() }));
    menu.onSelect(PANEL_TABS_ACTION.FLOAT);
    menu.onSelect(PANEL_TABS_ACTION.MOVE_RIGHT);
    menu.onSelect(PANEL_TABS_ACTION.CLOSE);
    expect(calls).toEqual(['float:p1', 'move:p1:aux', 'close:aux']);
  });

  it('根路由把面板选项卡交给本面（source = panel-tabs，而不是兜底）', () => {
    installShellMenuHost(hostStub().host);
    const { tab } = stripWithTab();
    const route = buildContextMenuRoute(tab, contextEvent());
    expect(route?.source).toBe('panel-tabs');
    expect(route?.items.length).toBeGreaterThan(0);
  });
});

describe('浮窗面 / 活动栏面 / 状态栏面：DOM 认人', () => {
  it('分区头：折叠态决定文案，动作落到既有 toggleCollapse', () => {
    const { host, calls } = hostStub({ isCollapsed: () => true });
    installShellMenuHost(host);
    const section = document.createElement('section');
    section.className = 'sidebar-section';
    const head = document.createElement('button');
    head.className = 'sidebar-section-head';
    head.setAttribute('data-context-surface', 'panel-section-header');
    head.setAttribute('data-panel-id', 'p1');
    section.appendChild(head);
    document.body.appendChild(section);
    const build = getContextSurface('panel-section-header')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'panel-section-header', target: head, event: contextEvent() }));
    expect(idsOf(menu.items)).toContain(PANEL_SECTION_ACTION.EXPAND);
    menu.onSelect(PANEL_SECTION_ACTION.EXPAND);
    expect(calls).toEqual(['collapse:p1']);
  });

  it('浮窗：已铺满 ⇒ 菜单给「还原窗口尺寸」', () => {
    Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
    const { host } = hostStub({
      snapshot: () => ({
        floating: { p1: { x: 0, y: 0, w: 900, h: 700 } },
        sidebarVisible: true,
        activeViewKey: null,
        eol: null,
        canSwitchEol: false,
      }),
    });
    installShellMenuHost(host);
    const root = document.createElement('section');
    root.setAttribute('data-context-surface', 'floating-window');
    root.setAttribute('data-floating-panel-id', 'p1');
    document.body.appendChild(root);
    const build = getContextSurface('floating-window')?.build;
    if (build === undefined) throw new Error('面未声明');
    expect(idsOf(menuOf(build({ id: 'floating-window', target: root, event: contextEvent() })).items)).toContain(
      FLOATING_ACTION.RESTORE,
    );
  });

  it('活动栏：当前激活的视图给「隐藏此视图」', () => {
    installShellMenuHost(hostStub().host);
    const nav = document.createElement('nav');
    nav.setAttribute('data-context-surface', 'activity-bar');
    const button = document.createElement('button');
    button.setAttribute('data-view-key', 'group:main');
    nav.appendChild(button);
    document.body.appendChild(nav);
    const build = getContextSurface('activity-bar')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'activity-bar', target: button, event: contextEvent() }));
    expect(idsOf(menu.items)).toContain(ACTIVITY_BAR_ACTION.HIDE);
  });

  it('活动栏：移到右侧栏按整组面板搬（逐个 move 到 aux）', () => {
    const { host, calls } = hostStub();
    installShellMenuHost(host);
    const nav = document.createElement('nav');
    nav.setAttribute('data-context-surface', 'activity-bar');
    const button = document.createElement('button');
    button.setAttribute('data-view-key', 'group:main');
    nav.appendChild(button);
    document.body.appendChild(nav);
    const build = getContextSurface('activity-bar')?.build;
    if (build === undefined) throw new Error('面未声明');
    menuOf(build({ id: 'activity-bar', target: button, event: contextEvent() })).onSelect(
      ACTIVITY_BAR_ACTION.MOVE_AUX,
    );
    expect(calls).toEqual(['move:p1:aux', 'move:p2:aux']);
  });

  it('工具栏：复制命令 ID 拿的是 data 属性里那条命令', () => {
    installShellMenuHost(hostStub().host);
    const header = document.createElement('header');
    header.setAttribute('data-context-surface', 'toolbar');
    const button = document.createElement('button');
    button.setAttribute('data-toolbar-command', 'workbench.snapshotInjector');
    button.setAttribute('data-toolbar-title', '打开状态注入器');
    header.appendChild(button);
    document.body.appendChild(header);
    const build = getContextSurface('toolbar')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'toolbar', target: button, event: contextEvent() }));
    expect(idsOf(menu.items)).toEqual([
      TOOLBAR_ACTION.COPY_TITLE,
      TOOLBAR_ACTION.COPY_ID,
      'layout.openSettings',
    ]);
  });

  it('状态栏：换行符一项按读数分档落到 onSwitchEol', () => {
    const { host, calls } = hostStub();
    installShellMenuHost(host);
    const footer = document.createElement('footer');
    footer.setAttribute('data-context-surface', 'status-bar');
    const cell = document.createElement('span');
    cell.className = 'sb-editor';
    cell.textContent = 'UTF-8 · LF · 12 行';
    footer.appendChild(cell);
    document.body.appendChild(footer);
    const build = getContextSurface('status-bar')?.build;
    if (build === undefined) throw new Error('面未声明');
    const menu = menuOf(build({ id: 'status-bar', target: cell, event: contextEvent() }));
    menu.onSelect(statusEolActionId('CRLF'));
    expect(calls).toEqual(['eol:CRLF']);
  });

  it('通知：容器空白处只给「清除全部」；单条给整份菜单并认 id', () => {
    const { host, calls } = hostStub();
    installShellMenuHost(host);
    const notices: ShellNoticeView[] = [{ id: 7, message: '磁盘被外部改动', actions: ['先看差异'] }];
    installNoticeMenuHost({
      notices,
      dismiss: (id) => calls.push(`dismiss:${id}`),
      clearAll: () => calls.push('clearAll'),
      runAction: (id, index) => calls.push(`run:${id}:${index}`),
    });
    const center = document.createElement('div');
    center.setAttribute('data-context-surface', 'notification');
    const toast = document.createElement('div');
    toast.setAttribute('data-notice-id', '7');
    center.appendChild(toast);
    document.body.appendChild(center);
    const build = getContextSurface('notification')?.build;
    if (build === undefined) throw new Error('面未声明');

    const onToast = menuOf(build({ id: 'notification', target: toast, event: contextEvent() }));
    expect(idsOf(onToast.items)).toContain(`${NOTIFICATION_ACTION.RUN_PREFIX}0`);
    onToast.onSelect(`${NOTIFICATION_ACTION.RUN_PREFIX}0`);
    onToast.onSelect(NOTIFICATION_ACTION.DISMISS);

    const onContainer = menuOf(build({ id: 'notification', target: center, event: contextEvent() }));
    expect(idsOf(onContainer.items)).toEqual([NOTIFICATION_ACTION.CLEAR_ALL]);
    onContainer.onSelect(NOTIFICATION_ACTION.CLEAR_ALL);

    expect(calls).toEqual(['run:7:0', 'dismiss:7', 'clearAll']);
  });
});

/* ------------------------------ 源码守门 ------------------------------ */

describe('源码守门：面根与数据锚点必须在位', () => {
  const shell = read('../src/ui/ShellLayout.tsx');
  const notifications = read('../src/ui/NotificationCenter.tsx');

  it('ShellLayout 里六处面根 + 六处数据锚点', () => {
    for (const id of [
      'panel-tabs',
      'panel-section-header',
      'floating-window',
      'activity-bar',
      'toolbar',
      'status-bar',
    ]) {
      expect(shell).toContain(`data-context-surface="${id}"`);
    }
    // 锚点掉了 = 菜单认不出「点的是哪个」，而运行期不会有任何报错
    expect(shell).toContain('data-panel-id={p.id}');
    expect(shell).toContain('data-panel-tabs-container={container}');
    expect(shell).toContain('data-active-panel={activeId');
    expect(shell).toContain('data-floating-panel-id={p.id}');
    expect(shell).toContain('data-view-key={v.key}');
    expect(shell).toContain('data-toolbar-command={t.command}');
  });

  it('通知中心的容器面根与逐条 id 锚点', () => {
    expect(notifications).toContain('data-context-surface="notification"');
    expect(notifications).toContain('data-notice-id={n.id}');
  });

  it('浮层初值公式只有一份（floatPanel 与「重置位置与尺寸」共用 defaultFloatRect）', () => {
    expect(shell).toContain('defaultFloatRect(n, { w: vw, h: vh })');
    expect(shell).not.toContain('Math.round(vw * 0.52)');
  });

  it('浮层遮罩只认左键（右键要留给浮层自己的菜单）', () => {
    // 遮罩的 onMouseDown 若对三键生效：右键按下先把浮层关掉，根路由随后收到 contextmenu 时
    // 面已经不在场——菜单永远弹不出来，而这条链路在任何纯函数测试里都不会红。
    const at = shell.indexOf('overlay-backdrop');
    expect(at).toBeGreaterThan(-1);
    const closeAt = shell.indexOf('setActiveOverlay(null)', at);
    expect(closeAt).toBeGreaterThan(at);
    expect(shell.slice(at, closeAt)).toMatch(/button\s*!==\s*0/);
  });
});
