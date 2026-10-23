// @vitest-environment happy-dom
/**
 * 市场面（`market`）的宿主侧接线（1023 批 · 覆盖面 WP5.4）。
 *
 * 判据：
 * - 清单里的 `market` 在宿主注册表里**有 spec**（清单 ⊆ 已声明，WP6 可硬断言）；
 * - 插件没登记 / 返回空 / 返回英文项 ⇒ 这一级不表态，落到兜底（不弹空壳、不弹英文）；
 * - 插件登记后 ⇒ `source = market`，动作原样交给插件（安装/卸载必须真落地）。
 *
 * 插件自己的 build 判据（行身份 → 行数据）由 `ui-market/tests/surface.test.ts` 钉住；
 * 这里只验宿主有没有把这条通道接对。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  declarePluginContextSurface,
  resetPluginContextSurfaces,
} from '@kojo/plugin-api';
import { buildContextMenuRoute, getContextSurface } from '../src/ui/context-surfaces';

const event = (): MouseEvent => new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 9 });

/** 造一个市场面板根（行还带行数据，验证属性原样传给插件） */
const marketRoot = (row?: { kind: string; key: string }): HTMLElement => {
  const root = document.createElement('div');
  root.setAttribute('data-context-surface', 'market');
  const leaf = document.createElement('span');
  if (row !== undefined) {
    const rowEl = document.createElement('div');
    rowEl.setAttribute('data-market-row', row.kind);
    rowEl.setAttribute('data-market-key', row.key);
    rowEl.appendChild(leaf);
    root.appendChild(rowEl);
  } else {
    root.appendChild(leaf);
  }
  document.body.appendChild(root);
  return leaf;
};

afterEach(() => {
  resetPluginContextSurfaces();
});

describe('市场面 · 宿主注册表', () => {
  it('清单里的 market 有 spec：无障碍名与分区与清单逐字一致', () => {
    const spec = getContextSurface('market');
    expect(spec?.ariaLabel).toBe('市场菜单');
    expect(spec?.area).toBe('chrome');
    expect(typeof spec?.build).toBe('function');
  });
});

describe('市场面 · build 转给插件', () => {
  it('插件没登记（插件被禁用 / 还没加载）⇒ 不表态，落兜底', () => {
    const route = buildContextMenuRoute(marketRoot(), event());
    expect(route?.source).toBe('app-fallback');
  });

  it('插件登记后：source = market，项与无障碍名来自插件，选中回插件', () => {
    const picked: string[] = [];
    declarePluginContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: () => ({
        items: [
          { id: 'market.pull', label: '拉取列表' },
          { id: 'market.publish', label: '发布口上…' },
        ],
        onSelect: (id) => picked.push(id),
      }),
    });
    const route = buildContextMenuRoute(marketRoot(), event());
    expect(route?.source).toBe('market');
    expect(route?.ariaLabel).toBe('市场菜单');
    expect(route?.items.map((i) => i.label)).toEqual(['拉取列表', '发布口上…']);
    route?.onSelect('market.publish');
    expect(picked).toEqual(['market.publish']);
  });

  it('行身份原样到插件手里（行级菜单靠它认行）', () => {
    const seen: string[] = [];
    declarePluginContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: (ctx) => {
        const row = ctx.target.closest?.('[data-market-row]');
        seen.push(`${row?.getAttribute?.('data-market-row') ?? ''}:${row?.getAttribute?.('data-market-key') ?? ''}`);
        return { items: [{ id: 'market.uninstall', label: '卸载…' }], onSelect: () => undefined };
      },
    });
    const route = buildContextMenuRoute(marketRoot({ kind: 'installed', key: 'kojo-pack/a@1.0.0' }), event());
    expect(seen).toEqual(['installed:kojo-pack/a@1.0.0']);
    expect(route?.source).toBe('market');
  });

  it('插件返回空菜单 / 抛错 ⇒ 不表态（不弹空壳，也不让全站右键失灵）', () => {
    declarePluginContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: () => [],
    });
    expect(buildContextMenuRoute(marketRoot(), event())?.source).toBe('app-fallback');

    declarePluginContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: () => {
        throw new Error('boom');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildContextMenuRoute(marketRoot(), event())?.source).toBe('app-fallback');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('插件给的英文项被丢弃；全丢光 ⇒ 兜底（宿主渲染前的最后一道闸）', () => {
    declarePluginContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: () => [
        { id: 'market.copy', label: 'Copy' },
        { id: 'market.pull', label: '拉取列表' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildContextMenuRoute(marketRoot(), event())?.items.map((i) => i.label)).toEqual(['拉取列表']);
    warn.mockRestore();

    declarePluginContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: () => [{ id: 'market.copy', label: 'Copy' }],
    });
    expect(buildContextMenuRoute(marketRoot(), event())?.source).toBe('app-fallback');
  });
});
