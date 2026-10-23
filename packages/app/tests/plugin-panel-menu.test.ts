// @vitest-environment happy-dom
/**
 * 插件面板的宿主级右键（1023 覆盖面批 · WP5）。
 *
 * 判据分四层：
 * 1. **纯函数**：能力（剪贴板可写 / 面板事实齐不齐）决定项集合——不可写就整项不显示；
 * 2. **DOM 认人**：菜单只认 `data-plugin-panel-*` 属性，不认组件闭包（多实例安全）；
 * 3. **落点**：选中真的写剪贴板，且写的是对应那一项（面板名 / 面板 ID / 插件 ID 三者不同）；
 * 4. **源码守门**：`PanelHost` 只在 `pluginId` 存在时才挂 `plugin-panel` 面——内建视图
 *    （搜索结果 / 问题 / 预览…）各有各的面，在这里统一挂父面会按 closest 的「最近祖先」
 *    规则把它们自己的面遮蔽掉。这条守门没有运行期报错可以依赖。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_PANEL_ACTION,
  PLUGIN_PANEL_ID_ATTR,
  PLUGIN_PANEL_PLUGIN_ATTR,
  PLUGIN_PANEL_TITLE_ATTR,
  buildPluginPanelMenu,
  pluginPanelFactsOf,
  runPluginPanelAction,
} from '../src/ui/plugin-panel-menu';
import { getContextSurface } from '../src/ui/context-surfaces';
import { isChineseMenuLabel } from '../src/ui/context-menu-model';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const FACTS = { panelId: 'market.panel', panelTitle: '口上市场', pluginId: 'ui-market' } as const;

describe('buildPluginPanelMenu · 能力决定项集合', () => {
  it('剪贴板可写 ⇒ 三项，全中文', () => {
    const items = buildPluginPanelMenu(FACTS, true);
    expect(items.map((i) => i.id)).toEqual([
      PLUGIN_PANEL_ACTION.copyPanelTitle,
      PLUGIN_PANEL_ACTION.copyPanelId,
      PLUGIN_PANEL_ACTION.copyPluginId,
    ]);
    for (const item of items) expect(isChineseMenuLabel(item.label), item.id).toBe(true);
  });

  it('剪贴板不可写 ⇒ 一项都不显示（不摆灰项）', () => {
    expect(buildPluginPanelMenu(FACTS, false)).toEqual([]);
  });

  it('认不出面板（facts 为 null）⇒ 不表态', () => {
    expect(buildPluginPanelMenu(null, true)).toEqual([]);
  });
});

describe('pluginPanelFactsOf · 只认 DOM 属性', () => {
  const mount = (attrs: Record<string, string>): HTMLElement => {
    const root = document.createElement('div');
    for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
    const leaf = document.createElement('span');
    root.appendChild(leaf);
    document.body.appendChild(root);
    return leaf;
  };

  it('三个属性齐全 ⇒ 逐字读出来', () => {
    const leaf = mount({
      [PLUGIN_PANEL_ID_ATTR]: 'market.panel',
      [PLUGIN_PANEL_TITLE_ATTR]: '口上市场',
      [PLUGIN_PANEL_PLUGIN_ATTR]: 'ui-market',
    });
    expect(pluginPanelFactsOf(leaf)).toEqual({
      panelId: 'market.panel',
      panelTitle: '口上市场',
      pluginId: 'ui-market',
    });
  });

  it('名/插件 id 缺省时回退面板 id（不显示空串）', () => {
    const leaf = mount({ [PLUGIN_PANEL_ID_ATTR]: 'sugar.preview' });
    expect(pluginPanelFactsOf(leaf)).toEqual({
      panelId: 'sugar.preview',
      panelTitle: 'sugar.preview',
      pluginId: 'sugar.preview',
    });
  });

  it('不在插件面板里 ⇒ null', () => {
    const leaf = mount({});
    expect(pluginPanelFactsOf(leaf)).toBeNull();
  });
});

describe('runPluginPanelAction · 真的写剪贴板', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockClear();
  });

  afterEach(() => {
    writeText.mockClear();
  });

  it('三项各写各的（面板名 / 面板 ID / 插件 ID 不是一回事）', async () => {
    expect(await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPanelTitle, FACTS)).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith('口上市场');
    expect(await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPanelId, FACTS)).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith('market.panel');
    expect(await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPluginId, FACTS)).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith('ui-market');
  });

  it('未知动作不写、返回 false（不静默假装成功）', async () => {
    expect(await runPluginPanelAction('pluginPanel.nope', FACTS)).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('剪贴板抛错 ⇒ 返回 false 并留一条 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    expect(await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPanelId, FACTS)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('面接线：plugin-panel 已登记且能出菜单', () => {
  it('注册表里有 plugin-panel，无障碍名是清单里那个', () => {
    expect(getContextSurface('plugin-panel')?.ariaLabel).toBe('插件面板菜单');
  });

  it('build 在面板内给三项、在面板外不表态', () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const root = document.createElement('div');
    root.setAttribute(PLUGIN_PANEL_ID_ATTR, 'market.panel');
    root.setAttribute(PLUGIN_PANEL_TITLE_ATTR, '口上市场');
    root.setAttribute(PLUGIN_PANEL_PLUGIN_ATTR, 'ui-market');
    const leaf = document.createElement('span');
    root.appendChild(leaf);
    document.body.appendChild(root);

    const build = getContextSurface('plugin-panel')?.build;
    expect(build).toBeDefined();
    if (build === undefined) throw new Error('plugin-panel 面必须声明 build');
    const menu = build({ id: 'plugin-panel', target: leaf, event: new MouseEvent('contextmenu') });
    expect(Array.isArray(menu)).toBe(false);
    const items = (menu as { items: readonly { id: string }[] }).items;
    expect(items).toHaveLength(3);

    const outside = document.createElement('span');
    document.body.appendChild(outside);
    expect(build({ id: 'plugin-panel', target: outside, event: new MouseEvent('contextmenu') })).toBeNull();
  });
});

describe('源码守门：内建视图不挂 plugin-panel 面', () => {
  it('PanelHost 用 pluginId 作判据，且属性是条件挂的', () => {
    const host = read('../src/ui/PanelHost.tsx');
    // 判据必须在：`pluginId === undefined` ⇒ 不挂
    expect(host).toContain('contribution.pluginId === undefined');
    expect(host).toContain("'data-context-surface': 'plugin-panel'");
    // 属性不能无条件写在 JSX 上（那会把搜索结果/问题/预览这些内建视图的面盖掉）
    expect(host).not.toMatch(/<div className=\{`panel panel-\$\{contribution\.id\}`\} data-context-surface=/);
  });
});
