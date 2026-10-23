/**
 * 插件状态面板的右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：状态三态决定「哪些项存在」（能力不存在 ⇒ 整项不显示）、中文文案、id 唯一、
 * 选中 id 精确分发到 `PluginRegistry` 那条通道，以及宿主缺席时的降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest, type PluginStateRecord } from '@kojo/plugin-api';
import {
  PLUGIN_PANEL_MENU_ARIA,
  buildPluginPanelMenu,
  buildPluginRowMenu,
  openPluginPanelMenu,
  openPluginRowMenu,
  runPluginRowAction,
  type PluginStatusMenuHost,
} from '../src/context-menu';

function hostSpy(): PluginStatusMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    copy: (text) => void calls.push(`copy:${text}`),
    retry: (id) => void calls.push(`retry:${id}`),
    stop: (id) => void calls.push(`stop:${id}`),
    refresh: () => void calls.push('refresh'),
  };
}

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

describe('行菜单 · 按状态决定哪些项存在', () => {
  it('运行中：复制 ID + 停用 + 刷新（不谈「重试激活」）', () => {
    expect(ids(buildPluginRowMenu({ id: 'ui-market', status: 'active' }))).toEqual([
      'plugin.copyId',
      'plugin.stop',
      'panel.refresh',
    ]);
  });

  it('未激活 / 错误：复制 ID + 重试激活 + 刷新（不谈「停用」）', () => {
    for (const status of ['inactive', 'error'] as PluginStateRecord['status'][]) {
      expect(ids(buildPluginRowMenu({ id: 'x', status }))).toEqual([
        'plugin.copyId',
        'plugin.retry',
        'panel.refresh',
      ]);
    }
  });

  it('待接线 / 已停止：只有复制与刷新（既无可重试也无可停用）', () => {
    for (const status of ['pending', 'stopped'] as PluginStateRecord['status'][]) {
      expect(ids(buildPluginRowMenu({ id: 'x', status }))).toEqual(['plugin.copyId', 'panel.refresh']);
    }
  });

  it('文案全中文、id 唯一（含面板空白处菜单）', () => {
    for (const status of ['active', 'inactive', 'error', 'pending', 'stopped'] as PluginStateRecord['status'][]) {
      const items = buildPluginRowMenu({ id: 'x', status });
      expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
      expect(new Set(ids(items)).size).toBe(items.length);
    }
    const panel = buildPluginPanelMenu();
    expect(panel.every((i) => hasCjkLabel(i.label))).toBe(true);
    expect(ids(panel)).toEqual(['panel.refresh']);
  });

  it('停用是危险动作（danger 标出来，不只靠颜色）', () => {
    const stop = buildPluginRowMenu({ id: 'x', status: 'active' }).find((i) => i.id === 'plugin.stop');
    expect(stop?.danger).toBe(true);
    expect(stop?.label).toBe('停用插件');
  });
});

describe('行菜单 · 动作分发', () => {
  it('四条 id 各自落到对应通道', () => {
    const host = hostSpy();
    const active = { id: 'ui-market', status: 'active' as const };
    expect(runPluginRowAction('plugin.copyId', active, host)).toBe(true);
    expect(runPluginRowAction('plugin.stop', active, host)).toBe(true);
    expect(runPluginRowAction('panel.refresh', active, host)).toBe(true);
    expect(runPluginRowAction('plugin.retry', { id: 'x', status: 'error' }, host)).toBe(true);
    expect(host.calls).toEqual(['copy:ui-market', 'stop:ui-market', 'refresh', 'retry:x']);
  });

  it('状态不允许的动作即使被点名也不执行（不让菜单外的调用越权）', () => {
    const host = hostSpy();
    expect(runPluginRowAction('plugin.stop', { id: 'x', status: 'inactive' }, host)).toBe(false);
    expect(runPluginRowAction('plugin.retry', { id: 'x', status: 'active' }, host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('不认识的 id ⇒ false（宿主可据此取证「谁没接」）', () => {
    expect(runPluginRowAction('nope', { id: 'x', status: 'active' }, hostSpy())).toBe(false);
  });
});

describe('行菜单 · 接线与降级', () => {
  it('宿主注入时：坐标透传 + 选中回调真的分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    const ok = openPluginRowMenu(
      { openContextMenu: (r) => seen.push(r) },
      { clientX: 88, clientY: 99, preventDefault: () => undefined },
      { id: 'ui-market', status: 'active' },
      host,
    );
    expect(ok).toBe(true);
    expect(seen[0]?.x).toBe(88);
    expect(seen[0]?.ariaLabel).toBe('插件条目菜单');
    seen[0]?.onSelect('plugin.copyId');
    expect(host.calls).toEqual(['copy:ui-market']);
  });

  it('宿主缺席（旧宿主）⇒ false、不抛错', () => {
    expect(
      openPluginRowMenu({}, { clientX: 1, clientY: 2 }, { id: 'x', status: 'active' }, hostSpy()),
    ).toBe(false);
    expect(openPluginPanelMenu({}, { clientX: 1, clientY: 2 }, hostSpy())).toBe(false);
  });

  it('面板空白处：无障碍名与刷新分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    expect(openPluginPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 3, clientY: 4 }, host)).toBe(true);
    expect(seen[0]?.ariaLabel).toBe(PLUGIN_PANEL_MENU_ARIA);
    seen[0]?.onSelect('panel.refresh');
    expect(host.calls).toEqual(['refresh']);
  });
});

describe('复制通道 · 失败要能被看见', () => {
  it('环境没有剪贴板时 copy 仍被调用（面板负责把 false 说成人话）', async () => {
    const { copyPluginId } = await import('../src/context-menu');
    const saved = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    try {
      await expect(copyPluginId('ui-market')).resolves.toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
    }
  });
});
