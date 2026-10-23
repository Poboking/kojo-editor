// @vitest-environment happy-dom
/**
 * 三个壳层页面（欢迎页 / 设置页 / 快捷键页）的右键菜单判据（1023 覆盖面批 · WP4.4/4.5/4.6）。
 *
 * 断言打在**纯函数**上（不渲染整页），另加一小截**接线**断言（DOM 行属性 → 面的 build →
 * 选中分发）：纯函数对了但面没接上，用户按下去照样是全站兜底菜单。
 * - 每个面的菜单项集合 × 能力矩阵（能不能打开 / 有没有桌面壳 / 有没有剪贴板 / 是不是默认值 /
 *   有没有覆盖 / 有没有撞键）；
 * - label 全中文（含禁用原因——铁律 4：灰着必须说话，而说话也得是中文）；
 * - 命令项的中文名与快捷键提示必须与 `KEYBINDING_SPECS` 逐字一致（菜单不另造第二份文案）。
 */
import { describe, expect, it } from 'vitest';
import {
  KEYBINDING_ACTION,
  SETTINGS_ACTION,
  SETTINGS_RESET_TABLE,
  WELCOME_PAGE_ACTION,
  WELCOME_RECENT_ACTION,
  buildKeybindingRowMenu,
  buildSettingsRowMenu,
  buildWelcomePageMenu,
  buildWelcomeRecentMenu,
  isFailureNote,
  isPrimaryButton,
  keybindingMenuStateOf,
  registerKeybindingsMenuBridge,
  registerSettingsMenuBridge,
  registerWelcomeMenuBridge,
  settingsResetEntryOf,
  settingsRowJsonOf,
  settingsSectionLabelOf,
  type KeybindingRowMenuInput,
} from '../src/ui/context-menu-pages';
import { buildContextMenuRoute, getContextSurface } from '../src/ui/context-surfaces';
import { CONTEXT_SURFACE_MANIFEST } from '../src/ui/context-surfaces';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import { KEYBINDING_SPECS, type KeybindingRow } from '../src/ui/keybindings';

/** 每条项（含子菜单）的 label 与禁用原因都必须是中文 */
function expectAllChinese(items: readonly ContextMenuItem[], where: string): void {
  for (const item of items) {
    expect(isChineseMenuLabel(item.label), `${where} · ${item.id} 的 label`).toBe(true);
    if (item.disabled) {
      expect(item.disabledReason, `${where} · ${item.id} 灰着却没说原因`).toBeTruthy();
      expect(isChineseMenuLabel(item.disabledReason ?? ''), `${where} · ${item.id} 的禁用原因`).toBe(true);
    }
    if (item.children) expectAllChinese(item.children, where);
  }
}

const ids = (items: readonly ContextMenuItem[]): string[] => items.map((i) => i.id);

const itemOf = (items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined =>
  items.find((i) => i.id === id);

/** 通用项（欢迎页整面从兜底菜单借来的那两项） */
const GENERIC: readonly ContextMenuItem[] = [
  { id: 'clipboard.copy', label: '复制', shortcut: 'Ctrl+C' },
  { id: 'selection.selectAll', label: '全选', shortcut: 'Ctrl+A' },
];

describe('欢迎页 · 最近项目行（WP4.4）', () => {
  const base = {
    openBlockedReason: null,
    missing: false,
    canReveal: true,
    canCopy: true,
  } as const;

  it('能力齐备：打开 / 从最近移除 / 复制项目路径 / 在资源管理器中显示', () => {
    const items = buildWelcomeRecentMenu(base);
    expect(ids(items)).toEqual([
      WELCOME_RECENT_ACTION.open,
      WELCOME_RECENT_ACTION.remove,
      WELCOME_RECENT_ACTION.copyPath,
      WELCOME_RECENT_ACTION.reveal,
    ]);
    expect(items.some((i) => i.disabled === true)).toBe(false);
    expectAllChinese(items, '最近项目行');
  });

  it('浏览器壳（没有 show_in_folder）⇒「在资源管理器中显示」整项不显示', () => {
    const items = buildWelcomeRecentMenu({ ...base, canReveal: false });
    expect(itemOf(items, WELCOME_RECENT_ACTION.reveal)).toBeUndefined();
    expectAllChinese(items, '最近项目行 · 无桌面壳');
  });

  it('没有剪贴板 ⇒「复制项目路径」整项不显示', () => {
    const items = buildWelcomeRecentMenu({ ...base, canCopy: false });
    expect(itemOf(items, WELCOME_RECENT_ACTION.copyPath)).toBeUndefined();
  });

  it('打开被挡住时灰着并说明原因（内核装配中 / 正在打开项目）', () => {
    const items = buildWelcomeRecentMenu({ ...base, openBlockedReason: '内核还在装配，稍等一下' });
    const open = itemOf(items, WELCOME_RECENT_ACTION.open);
    expect(open?.disabled).toBe(true);
    expect(open?.disabledReason).toBe('内核还在装配，稍等一下');
    expectAllChinese(items, '最近项目行 · 打开被挡');
  });

  it('目录已不存在 ⇒ 打开仍可重试，但在资源管理器里显示没意义（灰着说明）', () => {
    const items = buildWelcomeRecentMenu({ ...base, missing: true });
    expect(itemOf(items, WELCOME_RECENT_ACTION.open)?.disabled).toBeUndefined();
    const reveal = itemOf(items, WELCOME_RECENT_ACTION.reveal);
    expect(reveal?.disabled).toBe(true);
    expect(reveal?.disabledReason).toBe('这个目录已经不在了');
  });

  it('「在新组打开」不在菜单里：宿主没有把项目开进新编辑器组的能力（不凑项）', () => {
    const items = buildWelcomeRecentMenu(base);
    expect(items.some((i) => i.label.includes('新组') || i.label.includes('新窗口'))).toBe(false);
  });
});

describe('欢迎页 · 整面（无最近项目时的启动入口）', () => {
  const base = {
    openBlockedReason: null,
    resumeAvailable: false,
    hasRecent: false,
    commandsReady: true,
    generic: GENERIC,
  } as const;

  it('无最近项目：打开文件夹 + 命令面板 + 打开设置 + 通用项，没有「清空最近项目」', () => {
    const items = buildWelcomePageMenu(base);
    expect(ids(items)).toEqual([
      WELCOME_PAGE_ACTION.openDirectory,
      'workbench.commandPalette',
      'layout.openSettings',
      'clipboard.copy',
      'selection.selectAll',
    ]);
    expect(itemOf(items, WELCOME_PAGE_ACTION.clearRecent)).toBeUndefined();
    expectAllChinese(items, '欢迎页整面');
  });

  it('有最近项目才出现「清空最近项目」', () => {
    const items = buildWelcomePageMenu({ ...base, hasRecent: true });
    expect(itemOf(items, WELCOME_PAGE_ACTION.clearRecent)).toBeDefined();
  });

  it('有可继续的会话才出现「继续上次会话」，且与打开共用同一条禁用原因', () => {
    expect(itemOf(buildWelcomePageMenu(base), WELCOME_PAGE_ACTION.resume)).toBeUndefined();
    const items = buildWelcomePageMenu({
      ...base,
      resumeAvailable: true,
      openBlockedReason: '正在打开项目…',
    });
    const resume = itemOf(items, WELCOME_PAGE_ACTION.resume);
    expect(resume?.disabled).toBe(true);
    expect(resume?.disabledReason).toBe('正在打开项目…');
    expect(itemOf(items, WELCOME_PAGE_ACTION.openDirectory)?.disabledReason).toBe('正在打开项目…');
  });

  it('命令通道没就绪 ⇒ 命令项灰着说明，不冒充能按', () => {
    const items = buildWelcomePageMenu({ ...base, commandsReady: false });
    for (const id of ['workbench.commandPalette', 'layout.openSettings']) {
      const item = itemOf(items, id);
      expect(item?.disabled).toBe(true);
      expect(item?.disabledReason).toBe('命令还没就绪，稍后再试');
    }
    expectAllChinese(items, '欢迎页整面 · 命令未就绪');
  });

  it('命令项的中文名与键位来自键位注册表（菜单不另造文案）', () => {
    const items = buildWelcomePageMenu(base);
    for (const id of ['workbench.commandPalette', 'layout.openSettings']) {
      const spec = KEYBINDING_SPECS.find((s) => s.id === id);
      expect(spec, `${id} 未在键位表登记`).toBeDefined();
      expect(itemOf(items, id)?.label).toBe(spec?.title);
    }
    // 命令面板有缺省键位 ⇒ 菜单里必须带上同一条提示
    expect(itemOf(items, 'workbench.commandPalette')?.shortcut).toBe('Ctrl+Shift+P');
  });
});

describe('设置页（WP4.5）', () => {
  const resettable = { label: '正文字号', isDefault: false } as const;

  it('非默认值 ⇒「重置此项」可按；同时给出复制两项与搜索', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '编辑器',
      resettable,
      canCopy: true,
    });
    expect(ids(items)).toEqual([
      SETTINGS_ACTION.reset,
      SETTINGS_ACTION.copyId,
      SETTINGS_ACTION.copyJson,
      SETTINGS_ACTION.searchSection,
    ]);
    expect(itemOf(items, SETTINGS_ACTION.reset)?.disabled).toBeUndefined();
    expectAllChinese(items, '设置行');
  });

  it('已是默认值 ⇒ 灰着并说明「已是默认值」', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '编辑器',
      resettable: { label: '正文字号', isDefault: true },
      canCopy: true,
    });
    const reset = itemOf(items, SETTINGS_ACTION.reset);
    expect(reset?.disabled).toBe(true);
    expect(reset?.disabledReason).toBe('已是默认值');
    expectAllChinese(items, '设置行 · 默认值');
  });

  it('这一行没有默认值可回（没登记真源）⇒ 重置与「复制为 JSON」都不出现', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '关于',
      resettable: null,
      canCopy: true,
    });
    expect(itemOf(items, SETTINGS_ACTION.reset)).toBeUndefined();
    expect(itemOf(items, SETTINGS_ACTION.copyJson)).toBeUndefined();
    expect(itemOf(items, SETTINGS_ACTION.copyId)).toBeDefined();
    expect(itemOf(items, SETTINGS_ACTION.searchSection)).toBeDefined();
  });

  it('没有剪贴板 ⇒ 复制两项整组消失（搜索仍在）', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '编辑器',
      resettable,
      canCopy: false,
    });
    expect(ids(items)).toEqual([SETTINGS_ACTION.reset, SETTINGS_ACTION.searchSection]);
    expectAllChinese(items, '设置行 · 无剪贴板');
  });

  it('「搜索同类设置」的文案带上节名（填进搜索框的就是这个词）', () => {
    const items = buildSettingsRowMenu({
      sectionLabel: '外观',
      resettable: null,
      canCopy: true,
    });
    expect(itemOf(items, SETTINGS_ACTION.searchSection)?.label).toBe('搜索「外观」类设置');
  });

  it('节名：搜索索引登记过的走索引，没登记的退回键前缀', () => {
    expect(settingsSectionLabelOf('editor.fontSize')).toBe('编辑器');
    expect(settingsSectionLabelOf('about.update')).toBe('关于');
    expect(settingsSectionLabelOf('market.endpoint')).toBe('口上市场');
    // 这一行没进搜索索引（真源是 theme-pref），前缀兜底仍给出同一个节名
    expect(settingsSectionLabelOf('appearance.followSystem')).toBe('外观');
    // 前缀也不认识的：给一个中文兜底，绝不返回空串（空串 = 把搜索框清空）
    expect(settingsSectionLabelOf('nobody.knows')).toBe('设置');
  });

  it('可重置登记表：每项键与页面锚点同串、叫法全中文、初始即默认值', () => {
    expect(SETTINGS_RESET_TABLE.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const entry of SETTINGS_RESET_TABLE) {
      expect(entry.key).toMatch(/^[a-z]+\.[A-Za-z]+$/);
      expect(seen.has(entry.key), `${entry.key} 重复登记`).toBe(false);
      seen.add(entry.key);
      expect(isChineseMenuLabel(entry.label), entry.key).toBe(true);
      // node 环境没有 localStorage ⇒ 各偏好读到缺省值，故「是不是默认」恒真
      expect(entry.isDefault(), `${entry.key} 初始应为默认`).toBe(true);
      expect(entry.read(), `${entry.key} 读不到值`).not.toBeUndefined();
      expect(settingsResetEntryOf(entry.key)).toBe(entry);
    }
    expect(settingsResetEntryOf('about.contact')).toBeUndefined();
  });

  it('「复制为 JSON」有值来源：键与当前值成对；未登记的行没有 JSON', () => {
    expect(settingsRowJsonOf('editor.fontSize')).toBe('{"editor.fontSize":14}');
    expect(settingsRowJsonOf('about.contact')).toBeNull();
  });
});

describe('快捷键页（WP4.6）', () => {
  const row: KeybindingRowMenuInput = {
    id: 'layout.toggleSidebar',
    title: '切换主侧栏',
    rebindable: true,
    hasOverride: true,
    hasKeys: true,
    conflictWith: null,
    conflictCount: 0,
    canCopy: true,
  };

  it('可改键且有覆盖：复制命令 ID / 重置键位 / 移除键位', () => {
    const items = buildKeybindingRowMenu(row);
    expect(ids(items)).toEqual([
      KEYBINDING_ACTION.copyId,
      KEYBINDING_ACTION.reset,
      KEYBINDING_ACTION.remove,
    ]);
    expect(items.some((i) => i.disabled === true)).toBe(false);
    expectAllChinese(items, '快捷键行');
  });

  it('没有覆盖 ⇒「重置键位」灰着说明', () => {
    const items = buildKeybindingRowMenu({ ...row, hasOverride: false });
    const reset = itemOf(items, KEYBINDING_ACTION.reset);
    expect(reset?.disabled).toBe(true);
    expect(reset?.disabledReason).toBe('这一条还是默认键位');
    expectAllChinese(items, '快捷键行 · 无覆盖');
  });

  it('解绑后没有键位 ⇒「移除键位」灰着说明', () => {
    const items = buildKeybindingRowMenu({ ...row, hasKeys: false });
    const remove = itemOf(items, KEYBINDING_ACTION.remove);
    expect(remove?.disabled).toBe(true);
    expect(remove?.disabledReason).toBe('这一条本来就没有键位');
  });

  it('不可改键的行（和弦 / Monaco 内建）⇒ 改键两项整组不显示', () => {
    const items = buildKeybindingRowMenu({ ...row, rebindable: false });
    expect(itemOf(items, KEYBINDING_ACTION.reset)).toBeUndefined();
    expect(itemOf(items, KEYBINDING_ACTION.remove)).toBeUndefined();
    expect(itemOf(items, KEYBINDING_ACTION.copyId)).toBeDefined();
  });

  it('有撞键才出现「查看同键位冲突」，且冲突条数上屏', () => {
    expect(itemOf(buildKeybindingRowMenu(row), KEYBINDING_ACTION.showConflict)).toBeUndefined();
    const items = buildKeybindingRowMenu({ ...row, conflictWith: '切换底部区', conflictCount: 4 });
    const conflict = itemOf(items, KEYBINDING_ACTION.showConflict);
    expect(conflict).toBeDefined();
    expect(conflict?.label).toBe('查看同键位冲突（共 4 项）');
    expectAllChinese(items, '快捷键行 · 撞键');
  });

  it('没有剪贴板 ⇒「复制命令 ID」不显示', () => {
    const items = buildKeybindingRowMenu({ ...row, canCopy: false });
    expect(itemOf(items, KEYBINDING_ACTION.copyId)).toBeUndefined();
    expectAllChinese(items, '快捷键行 · 无剪贴板');
  });

  it('KeybindingRow → 菜单读数：三态与键位有无各归各位', () => {
    const base: KeybindingRow = {
      id: 'editor.action.rename',
      title: '重命名符号',
      category: '编辑器',
      keys: 'f2',
      display: 'F2',
      rebindable: true,
      note: null,
      state: 'overridden',
      conflictWith: '查找',
    };
    expect(keybindingMenuStateOf(base)).toEqual({
      id: 'editor.action.rename',
      title: '重命名符号',
      rebindable: true,
      hasOverride: true,
      hasKeys: true,
      conflictWith: '查找',
    });
    expect(keybindingMenuStateOf({ ...base, keys: undefined, state: 'unbound' })).toMatchObject({
      hasOverride: true,
      hasKeys: false,
    });
    expect(keybindingMenuStateOf({ ...base, state: 'default' }).hasOverride).toBe(false);
  });
});

describe('面注册（四个面都在清单里、都有 build）', () => {
  it('welcome / welcome-recent / settings / keybindings 已登记且无障碍名与清单一致', () => {
    for (const id of ['welcome', 'welcome-recent', 'settings', 'keybindings']) {
      const spec = getContextSurface(id);
      const manifest = CONTEXT_SURFACE_MANIFEST.find((entry) => entry.id === id);
      expect(spec, `${id} 未声明`).toBeDefined();
      expect(spec?.build, `${id} 没有 build`).toBeTypeOf('function');
      expect(spec?.ariaLabel).toBe(manifest?.ariaLabel);
      expect(isChineseMenuLabel(spec?.ariaLabel ?? '')).toBe(true);
    }
  });
});

describe('回执文案的成败判据', () => {
  it('成功回执不上错误色，失败回执上', () => {
    expect(isFailureNote('已复制项目路径')).toBe(false);
    expect(isFailureNote('复制失败：剪贴板拒绝了这次写入')).toBe(true);
    expect(isFailureNote('这个动作现在没法执行')).toBe(true);
  });

  it('遮罩关窗只认左键：右键是开菜单，不是关浮层', () => {
    expect(isPrimaryButton({ button: 0 })).toBe(true);
    expect(isPrimaryButton({ button: 1 })).toBe(false); // 中键
    expect(isPrimaryButton({ button: 2 })).toBe(false); // 右键
  });
});

describe('接线：DOM 行属性 → 面的 build → 选中分发', () => {
  const event = (): MouseEvent =>
    new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 9 });

  /** 造一棵「面根 + 行」的 DOM，返回行里那个最深的可点元素 */
  const mountRow = (surfaceId: string, rowSurface: string | null, attrs: Record<string, string>): HTMLElement => {
    const root = document.createElement('div');
    root.setAttribute('data-context-surface', surfaceId);
    const row = document.createElement('div');
    if (rowSurface !== null) row.setAttribute('data-context-surface', rowSurface);
    for (const [key, value] of Object.entries(attrs)) row.setAttribute(key, value);
    const deep = document.createElement('span');
    row.appendChild(deep);
    root.appendChild(row);
    document.body.appendChild(root);
    return deep;
  };

  it('最近项目行：行内任意位置都拿到这一行的菜单，选中交给接线桥', () => {
    const calls: string[] = [];
    registerWelcomeMenuBridge({
      openBlockedReason: () => null,
      canReveal: () => true,
      resumeAvailable: () => false,
      hasRecent: () => true,
      openRecent: (dir) => calls.push(`open:${dir}`),
      removeRecent: (dir) => calls.push(`remove:${dir}`),
      reveal: (dir) => calls.push(`reveal:${dir}`),
      openDirectory: () => calls.push('openDirectory'),
      resumeSession: () => calls.push('resume'),
      clearRecent: () => calls.push('clear'),
      note: (line) => calls.push(`note:${line}`),
    });
    const deep = mountRow('welcome', 'welcome-recent', { 'data-recent-root': 'D:/proj' });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('welcome-recent');
    expect(route?.items.map((i) => i.id)).toContain(WELCOME_RECENT_ACTION.open);
    // 桌面壳在 ⇒ 这一项在；剪贴板在 happy-dom 里没有 ⇒ 复制项不在
    expect(route?.items.map((i) => i.id)).toContain(WELCOME_RECENT_ACTION.reveal);
    route?.onSelect(WELCOME_RECENT_ACTION.open);
    route?.onSelect(WELCOME_RECENT_ACTION.reveal);
    expect(calls).toEqual(['open:D:/proj', 'reveal:D:/proj']);
    registerWelcomeMenuBridge(null);
    expect(buildContextMenuRoute(deep, event())?.source).toBe('app-fallback');
  });

  it('设置行：按 data-settings-key 定位，重置默认值时灰着说明，「搜索同类设置」写进搜索框', () => {
    const searched: string[] = [];
    registerSettingsMenuBridge({
      searchSection: (label) => searched.push(label),
      note: () => undefined,
    });
    const deep = mountRow('settings', null, { 'data-settings-key': 'editor.lineHeight' });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('settings');
    const reset = route?.items.find((i) => i.id === SETTINGS_ACTION.reset);
    expect(reset?.disabled).toBe(true);
    expect(reset?.disabledReason).toBe('已是默认值');
    route?.onSelect(SETTINGS_ACTION.searchSection);
    expect(searched).toEqual(['编辑器']);
    registerSettingsMenuBridge(null);
  });

  it('设置页空白处（不在任何设置行上）不表态，落回兜底菜单', () => {
    registerSettingsMenuBridge({ searchSection: () => undefined, note: () => undefined });
    const deep = mountRow('settings', null, { 'data-nothing': '1' });
    expect(buildContextMenuRoute(deep, event())?.source).toBe('app-fallback');
    registerSettingsMenuBridge(null);
  });

  it('快捷键行：按 data-kb-id 定位，「查看同键位冲突」交给页面切范围档', () => {
    const calls: string[] = [];
    registerKeybindingsMenuBridge({
      rowOf: (id) =>
        id === 'layout.toggleSidebar'
          ? {
              id,
              title: '切换主侧栏',
              rebindable: true,
              hasOverride: true,
              hasKeys: true,
              conflictWith: '切换底部区',
            }
          : undefined,
      conflictCount: () => 2,
      onlyConflicts: () => calls.push('onlyConflicts'),
      note: (line) => calls.push(`note:${line}`),
    });
    const deep = mountRow('keybindings', null, { 'data-kb-id': 'layout.toggleSidebar' });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('keybindings');
    expect(route?.items.map((i) => i.id)).toContain(KEYBINDING_ACTION.showConflict);
    route?.onSelect(KEYBINDING_ACTION.showConflict);
    expect(calls).toEqual(['onlyConflicts']);
    // 不认识的 id：这一级不表态
    const stranger = mountRow('keybindings', null, { 'data-kb-id': 'nobody.knows' });
    expect(buildContextMenuRoute(stranger, event())?.source).toBe('app-fallback');
    registerKeybindingsMenuBridge(null);
  });

  it('欢迎页整面：无最近项目时给的是启动入口，而不是空壳', () => {
    registerWelcomeMenuBridge({
      openBlockedReason: () => null,
      canReveal: () => false,
      resumeAvailable: () => false,
      hasRecent: () => false,
      openRecent: () => undefined,
      removeRecent: () => undefined,
      reveal: () => undefined,
      openDirectory: () => undefined,
      resumeSession: () => undefined,
      clearRecent: () => undefined,
      note: () => undefined,
    });
    const deep = mountRow('welcome', null, {});
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('welcome');
    expect(route?.items.map((i) => i.id)).toContain(WELCOME_PAGE_ACTION.openDirectory);
    expectAllChinese(route?.items ?? [], '欢迎页整面 · 接线');
    registerWelcomeMenuBridge(null);
  });
});
