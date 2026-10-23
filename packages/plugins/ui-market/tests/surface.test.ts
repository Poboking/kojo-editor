/**
 * 市场面（`CONTEXT_SURFACE_MANIFEST` 的 `market`）的 build 判据（WP5.4）。
 *
 * 判据：
 * - 行身份来自 DOM（`data-market-row` / `data-market-key`），不读 React 状态；
 * - **对象形态**（items + onSelect）——卸载/安装要真落地，数组形态点了不做事；
 * - 行不在了 / 面板没挂载 ⇒ `null`（不表态，交给兜底），不弹错行的菜单；
 * - 空白处 ⇒ 面板菜单（拉取列表 / 发布口上…），文案全中文。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hasCjkLabel, resetPluginContextSurfaces, getPluginContextSurface } from '@kojo/plugin-api';
import {
  buildMarketSurfaceMenu,
  setMarketSurfaceHost,
  type MarketSurfaceHost,
} from '../src/market-panel';
import type { MarketRowTarget } from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

const indexTarget: MarketRowTarget = {
  kind: 'index',
  key: 'kojo-pack|sample|1.0.0',
  packId: 'sample',
  label: '示例包',
  action: 'install',
  sourceUrl: 'https://example.invalid/sample',
  expanded: false,
};

const installedTarget: MarketRowTarget = {
  kind: 'installed',
  key: 'kojo-pack|sample|1.0.0',
  packId: 'sample',
  label: '示例包',
  expanded: false,
};

/** DOM 替身：只实现面用到的两个方法（与插件侧结构类型同口径） */
const el = (attrs: Record<string, string> | null) => ({
  closest: () => (attrs === null ? null : { getAttribute: (n: string) => attrs[n] ?? null }),
});

function hostOf(targets: { index?: MarketRowTarget; installed?: MarketRowTarget }): MarketSurfaceHost & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    rowTarget: (kind, key) => {
      const hit = targets[kind];
      return hit !== undefined && hit.key === key ? hit : null;
    },
    runRow: (id, target) => void calls.push(`row:${id}:${target.kind}:${target.key}`),
    runPanel: (id) => void calls.push(`panel:${id}`),
  };
}

afterEach(() => {
  setMarketSurfaceHost(null);
  resetPluginContextSurfaces();
});

describe('市场面 · 登记', () => {
  it('模块加载即登记：id / 无障碍名 / 分区与清单逐字一致', () => {
    const spec = getPluginContextSurface('market');
    expect(spec?.ariaLabel).toBe('市场菜单');
    expect(spec?.area).toBe('chrome');
    expect(typeof spec?.build).toBe('function');
  });
});

describe('市场面 · 行级', () => {
  it('索引行：对象形态 + 安装项，选中后把动作交给面板（真落地，不是只展示）', () => {
    const host = hostOf({ index: indexTarget });
    setMarketSurfaceHost(host);
    const menu = buildMarketSurfaceMenu({
      id: 'market',
      target: el({ 'data-market-row': 'index', 'data-market-key': indexTarget.key }),
    });
    expect(Array.isArray(menu)).toBe(false);
    const items = (menu as { items: readonly { id: string; label: string }[] }).items;
    expect(ids(items)).toContain('market.install');
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
    (menu as { onSelect?: (id: string) => void }).onSelect?.('market.install');
    expect(host.calls).toEqual([`row:market.install:index:${indexTarget.key}`]);
  });

  it('已装行：卸载项在，且选中后交给面板处理（确认流程在面板里）', () => {
    const host = hostOf({ installed: installedTarget });
    setMarketSurfaceHost(host);
    const menu = buildMarketSurfaceMenu({
      id: 'market',
      target: el({ 'data-market-row': 'installed', 'data-market-key': installedTarget.key }),
    });
    const items = (menu as { items: readonly { id: string }[] }).items;
    expect(ids(items)).toEqual(['market.import', 'market.copyId', 'market.copyName', 'market.detail', 'market.uninstall']);
    (menu as { onSelect?: (id: string) => void }).onSelect?.('market.uninstall');
    expect(host.calls).toEqual([`row:market.uninstall:installed:${installedTarget.key}`]);
  });

  it('行已不在快照里（刚卸掉 / 列表刚变）：不表态，交给兜底', () => {
    setMarketSurfaceHost(hostOf({ index: indexTarget }));
    expect(
      buildMarketSurfaceMenu({
        id: 'market',
        target: el({ 'data-market-row': 'index', 'data-market-key': 'gone' }),
      }),
    ).toBeNull();
  });

  it('面板没挂载（host 未登记）：不表态', () => {
    expect(buildMarketSurfaceMenu({ id: 'market', target: el(null) })).toBeNull();
  });
});

describe('市场面 · 空白处', () => {
  it('非行区域：面板菜单（拉取列表 / 发布口上…），对象形态', () => {
    const host = hostOf({});
    setMarketSurfaceHost(host);
    const menu = buildMarketSurfaceMenu({ id: 'market', target: el(null) });
    const view = menu as { items: readonly { id: string; label: string }[]; onSelect?: (id: string) => void };
    expect(ids(view.items)).toEqual(['market.pull', 'market.publish']);
    expect(view.items.every((i) => hasCjkLabel(i.label))).toBe(true);
    view.onSelect?.('market.pull');
    expect(host.calls).toEqual(['panel:market.pull']);
  });
});
