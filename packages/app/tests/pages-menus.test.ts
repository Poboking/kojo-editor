// @vitest-environment happy-dom
/**
 * 欢迎页（整面 / 最近项目行）的右键菜单判据（1023 覆盖面批 · WP4.4）。
 *
 * 设置页 / 快捷键页两个面的同类判据在 `settings-menu.test.ts`——2026-10 起它们连同
 * `settings-search` / `editor-display-prefs` / `keybindings` 的依赖一起搬到了懒模块
 * `ui/settings-menu.ts`（只有设置浮层打开才加载），本文件因此只剩欢迎页这一面。
 *
 * 断言打在**纯函数**上（不渲染整页），另加一小截**接线**断言（DOM 行属性 → 面的 build →
 * 选中分发）：纯函数对了但面没接上，用户按下去照样是全站兜底菜单。
 * - 每个面的菜单项集合 × 能力矩阵（能不能打开 / 有没有桌面壳 / 有没有剪贴板）；
 * - label 全中文（含禁用原因——灰着必须说话，而说话也得是中文）；
 * - 命令项的中文名与快捷键提示必须与 `KEYBINDING_SPECS` 逐字一致（菜单不另造第二份文案）。
 */
import { describe, expect, it } from 'vitest';
import {
  WELCOME_PAGE_ACTION,
  WELCOME_RECENT_ACTION,
  buildWelcomePageMenu,
  buildWelcomeRecentMenu,
  isFailureNote,
  isPrimaryButton,
  registerWelcomeMenuBridge,
} from '../src/ui/context-menu-pages';
import { buildContextMenuRoute, getContextSurface } from '../src/ui/context-surfaces';
import { CONTEXT_SURFACE_MANIFEST } from '../src/ui/context-surfaces';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import { KEYBINDING_SPECS } from '../src/ui/keybindings';

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

describe('面注册（欢迎页两面都在清单里、都有 build）', () => {
  it('welcome / welcome-recent 已登记且无障碍名与清单一致', () => {
    for (const id of ['welcome', 'welcome-recent']) {
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
