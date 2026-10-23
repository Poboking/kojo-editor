// @vitest-environment happy-dom
/**
 * 根宿主状态机 + 中文化守卫（1023 覆盖面批 · WP0）。
 *
 * 判据（行为级）：
 * - 开 → 关一次性收口：`onDismiss` 只在**真的从开到关**时回调一次，重复关不重复回调；
 * - 开着再开：旧请求先按「被顶掉」收口（各面据此清临时态），新请求接管；
 * - 渲染前过中文化守卫：非中文项整项丢弃，丢光就什么都不渲染（不弹空壳）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextMenuHost,
  closeContextMenu,
  getContextMenuState,
  openContextMenu,
} from '../src/ui/context-menu-host';

const render = (): string => renderToStaticMarkup(h(ContextMenuHost));

beforeEach(() => {
  closeContextMenu();
});

describe('ContextMenuHost · 开合状态机', () => {
  it('打开后状态里能读到这次请求（含来源面，供取证）', () => {
    openContextMenu({
      x: 10,
      y: 20,
      items: [{ id: 'a', label: '打开文件' }],
      ariaLabel: '通用菜单',
      onSelect: () => undefined,
      source: 'app-fallback',
    });
    expect(getContextMenuState().request?.source).toBe('app-fallback');
    expect(getContextMenuState().request?.items).toHaveLength(1);
  });

  it('关闭回调 onDismiss 只发生一次（重复关是幂等空操作）', () => {
    const onDismiss = vi.fn();
    openContextMenu({
      x: 0,
      y: 0,
      items: [{ id: 'a', label: '复制' }],
      ariaLabel: '通用菜单',
      onSelect: () => undefined,
      onDismiss,
    });
    closeContextMenu();
    closeContextMenu();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(getContextMenuState().request).toBeNull();
  });

  it('开着再开：旧请求先收口，新请求接管（不会叠两个菜单）', () => {
    const first = vi.fn();
    const second = vi.fn();
    openContextMenu({
      x: 0,
      y: 0,
      items: [{ id: 'a', label: '旧菜单项' }],
      ariaLabel: '旧菜单',
      onSelect: () => undefined,
      onDismiss: first,
    });
    openContextMenu({
      x: 4,
      y: 4,
      items: [{ id: 'b', label: '新菜单项' }],
      ariaLabel: '新菜单',
      onSelect: () => undefined,
      onDismiss: second,
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(getContextMenuState().request?.ariaLabel).toBe('新菜单');
  });
});

describe('ContextMenuHost · 渲染', () => {
  it('没开菜单时什么都不渲染', () => {
    expect(render()).toBe('');
  });

  it('开着时渲染共享菜单：role=menu + 全中文项 + 面的无障碍名', () => {
    openContextMenu({
      x: 40,
      y: 60,
      items: [
        { id: 'copy', label: '复制', shortcut: 'Ctrl+C' },
        { id: 'select-all', label: '全选', dividerBefore: true },
      ],
      ariaLabel: '通用菜单',
      onSelect: () => undefined,
    });
    const html = render();
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="通用菜单"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain('复制');
    expect(html).toContain('全选');
  });

  it('非中文项在宿主这一层就被丢掉；丢光了不渲染空壳', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openContextMenu({
      x: 0,
      y: 0,
      items: [{ id: 'open', label: 'Open File' }],
      ariaLabel: '通用菜单',
      onSelect: () => undefined,
    });
    expect(render()).toBe('');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('中英混排只丢英文项，中文项照常上屏', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openContextMenu({
      x: 0,
      y: 0,
      items: [
        { id: 'open', label: 'Open' },
        { id: 'save', label: '保存' },
      ],
      ariaLabel: '通用菜单',
      onSelect: () => undefined,
    });
    const html = render();
    expect(html.match(/role="menuitem"/g)).toHaveLength(1);
    expect(html).toContain('保存');
    warn.mockRestore();
  });
});
