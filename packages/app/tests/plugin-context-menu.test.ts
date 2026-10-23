// @vitest-environment happy-dom
/**
 * 插件右键菜单的**宿主桥接层**（1023 覆盖面批 · WP5.1 / 5.3）。
 *
 * 判据（行为级，读根宿主状态取证，不读源码形状）：
 * - 中文项原样透传（字段一个不丢，坐标与无障碍名照搬）；
 * - 非中文项整项丢弃并告警一次；子菜单被丢光时父项一并丢；全丢 ⇒ 不开菜单（不弹空壳）；
 * - `onSelect` 回到插件自己的分发（宿主不替它猜业务）；
 * - 形状不合法（坐标非有限数 / 没有回调 / 空菜单）一律拒绝，返回 false。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  closeContextMenu,
  getContextMenuState,
} from '../src/ui/context-menu-host';
import {
  createPluginContextMenuBridge,
  filterPluginMenuItems,
  openPluginContextMenu,
  resetPluginContextMenuBridge,
} from '../src/ui/plugin-context-menu-bridge';

function request(overrides: Partial<PluginContextMenuRequest> = {}): PluginContextMenuRequest {
  return {
    x: 120,
    y: 240,
    items: [{ id: 'refresh', label: '刷新' }],
    ariaLabel: '插件面板菜单',
    onSelect: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  closeContextMenu();
  resetPluginContextMenuBridge();
});

afterEach(() => {
  closeContextMenu();
  vi.restoreAllMocks();
});

describe('桥接层 · 透传', () => {
  it('坐标 / 无障碍名 / 来源原样进根宿主', () => {
    expect(openPluginContextMenu(request(), 'ui-market')).toBe(true);
    const state = getContextMenuState();
    expect(state.request?.x).toBe(120);
    expect(state.request?.y).toBe(240);
    expect(state.request?.ariaLabel).toBe('插件面板菜单');
    expect(state.request?.source).toBe('ui-market');
  });

  it('菜单项字段一个不丢（图标 / 键位 / 禁用原因 / 勾选 / 分组 / 子菜单）', () => {
    openPluginContextMenu(
      request({
        items: [
          {
            id: 'install',
            label: '安装',
            icon: 'download',
            shortcut: 'Ctrl+I',
            danger: true,
            checked: true,
            dividerBefore: true,
            group: '安装',
            children: [{ id: 'install.latest', label: '安装最新版' }],
          },
          {
            id: 'uninstall',
            label: '卸载',
            disabled: true,
            disabledReason: '正在安装另一个包',
          },
        ],
      }),
    );
    const items = getContextMenuState().request?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'install',
      label: '安装',
      icon: 'download',
      shortcut: 'Ctrl+I',
      danger: true,
      checked: true,
      dividerBefore: true,
      group: '安装',
    });
    expect(items[0]?.children?.[0]?.label).toBe('安装最新版');
    expect(items[1]).toMatchObject({
      id: 'uninstall',
      disabled: true,
      disabledReason: '正在安装另一个包',
    });
  });

  it('onSelect 回到插件自己的分发（宿主不猜业务）', () => {
    const picked: string[] = [];
    openPluginContextMenu(
      request({ onSelect: (id) => picked.push(id) }),
    );
    const onSelect = getContextMenuState().request?.onSelect;
    expect(onSelect).toBeTypeOf('function');
    onSelect?.('refresh');
    expect(picked).toEqual(['refresh']);
  });
});

describe('桥接层 · 中文化闸', () => {
  it('非中文项整项丢弃、中文项留下', () => {
    const before = { x: 1, y: 2, items: [
      { id: 'copy', label: 'Copy Path' },
      { id: 'paste', label: '复制路径' },
    ], ariaLabel: '菜单', onSelect: () => undefined } satisfies PluginContextMenuRequest;
    expect(openPluginContextMenu(before, 'ui-archive-browser')).toBe(true);
    const items = getContextMenuState().request?.items ?? [];
    expect(items.map((i) => i.id)).toEqual(['paste']);
  });

  it('子菜单被丢光时父项一并丢（不点出空壳）', () => {
    const filtered = filterPluginMenuItems([
      { id: 'a', label: '更多', children: [{ id: 'a.1', label: 'More' }] },
    ]);
    expect(filtered.items).toHaveLength(0);
    expect(filtered.dropped).toEqual(['More', '更多']);
  });

  it('全被丢光 ⇒ 不开菜单（返回 false，宿主状态仍为空）', () => {
    expect(
      openPluginContextMenu(request({ items: [{ id: 'copy', label: 'Copy' }] }), 'ui-market'),
    ).toBe(false);
    expect(getContextMenuState().request).toBeNull();
  });

  it('丢弃只告警一次（同一来源不刷屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openPluginContextMenu(request({ items: [{ id: 'a', label: 'Alpha' }] }), 'ui-market');
    openPluginContextMenu(request({ items: [{ id: 'b', label: 'Beta' }] }), 'ui-market');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ui-market');
  });
});

describe('桥接层 · 形状校验', () => {
  it('坐标非有限数 ⇒ 拒绝', () => {
    expect(openPluginContextMenu(request({ x: Number.NaN }))).toBe(false);
    expect(openPluginContextMenu(request({ y: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(getContextMenuState().request).toBeNull();
  });

  it('没有动作回调 / 空菜单 ⇒ 拒绝', () => {
    expect(
      openPluginContextMenu({ ...request(), onSelect: undefined as unknown as () => void }),
    ).toBe(false);
    expect(openPluginContextMenu(request({ items: [] }))).toBe(false);
  });

  it('无障碍名不是中文时退回「插件菜单」（菜单永远有名字）', () => {
    openPluginContextMenu(request({ ariaLabel: 'Plugin Menu' }));
    expect(getContextMenuState().request?.ariaLabel).toBe('插件菜单');
  });
});

describe('桥接层 · 面板通道', () => {
  it('同一来源复用同一函数（引用稳定，可进 effect 依赖）', () => {
    const a = createPluginContextMenuBridge('ui-market');
    const b = createPluginContextMenuBridge('ui-market');
    expect(a).toBe(b);
    expect(createPluginContextMenuBridge('ui-plugin-status')).not.toBe(a);
  });

  it('通道把请求交给根宿主', () => {
    const bridge = createPluginContextMenuBridge('ui-plugin-status');
    bridge(request({ ariaLabel: '插件状态菜单' }));
    expect(getContextMenuState().request?.ariaLabel).toBe('插件状态菜单');
    expect(getContextMenuState().request?.source).toBe('ui-plugin-status');
  });
});
