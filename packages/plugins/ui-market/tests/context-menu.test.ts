/**
 * 口上市场右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：索引行的三种动作态（安装 / 更新 / 无可装）各给出什么项、没登记来源网址时的
 * 禁用原因、已装行的卸载（危险）与导入、面板空白处两条真能力、动作分发与降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  MARKET_INDEX_MENU_ARIA,
  MARKET_INSTALLED_MENU_ARIA,
  MARKET_PANEL_MENU_ARIA,
  buildMarketIndexRowMenu,
  buildMarketInstalledRowMenu,
  buildMarketPanelMenu,
  openMarketPanelMenu,
  openMarketRowMenu,
  runMarketRowAction,
  type MarketIndexRowTarget,
  type MarketInstalledRowTarget,
  type MarketMenuHost,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function indexRow(overrides: Partial<MarketIndexRowTarget> = {}): MarketIndexRowTarget {
  return {
    kind: 'index',
    key: 'kojo-pack|sample|1.0.0',
    packId: 'sample',
    label: '示例口上',
    action: 'install',
    sourceUrl: 'https://example.invalid/sample.zip',
    expanded: false,
    ...overrides,
  };
}

function installedRow(overrides: Partial<MarketInstalledRowTarget> = {}): MarketInstalledRowTarget {
  return { kind: 'installed', key: 'kojo-pack|sample|1.0.0', packId: 'sample', label: '示例口上', expanded: false, ...overrides };
}

function hostSpy(): MarketMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    install: (t) => void calls.push(`install:${t.key}`),
    requestUninstall: (key) => void calls.push(`uninstall:${key}`),
    importInstalled: (key) => void calls.push(`import:${key}`),
    toggleDetail: (key) => void calls.push(`detail:${key}`),
    openSource: (url) => void calls.push(`open:${url}`),
    pull: () => void calls.push('pull'),
    publish: () => void calls.push('publish'),
    copy: (text) => void calls.push(`copy:${text}`),
  };
}

describe('索引行菜单 · 三种动作态', () => {
  it('可安装：安装此包 + 复制 ID + 详情 + 来源两条', () => {
    expect(ids(buildMarketIndexRowMenu(indexRow()))).toEqual([
      'market.install',
      'market.copyId',
      'market.detail',
      'market.copyUrl',
      'market.openSource',
    ]);
    expect(buildMarketIndexRowMenu(indexRow())[0]?.label).toBe('安装此包');
  });

  it('可更新：同一个位置换成「更新此包」', () => {
    const items = buildMarketIndexRowMenu(indexRow({ action: 'update' }));
    expect(items[0]?.id).toBe('market.update');
    expect(items[0]?.label).toBe('更新此包');
    expect(ids(items)).not.toContain('market.install');
  });

  it('没有可装动作（本机已最新 / 版本要求不够）：整项不出现，但复制与来源仍在', () => {
    expect(ids(buildMarketIndexRowMenu(indexRow({ action: 'none' })))).toEqual([
      'market.copyId',
      'market.detail',
      'market.copyUrl',
      'market.openSource',
    ]);
  });

  it('没登记来源网址：两条来源项禁用并说明原因（不整项删除——是这一条没登记）', () => {
    for (const sourceUrl of [undefined, '']) {
      const items = buildMarketIndexRowMenu(indexRow({ sourceUrl }));
      for (const id of ['market.copyUrl', 'market.openSource']) {
        const item = items.find((i) => i.id === id);
        expect(item?.disabled).toBe(true);
        expect(item?.disabledReason).toContain('来源网址');
      }
    }
  });

  it('展开态换「收起详情」（同一个 id）', () => {
    const item = buildMarketIndexRowMenu(indexRow({ expanded: true })).find((i) => i.id === 'market.detail');
    expect(item?.label).toBe('收起详情');
  });

  it('文案全中文、id 唯一', () => {
    for (const action of ['install', 'update', 'none'] as const) {
      const items = buildMarketIndexRowMenu(indexRow({ action }));
      expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
      expect(new Set(ids(items)).size).toBe(items.length);
    }
  });
});

describe('已装行菜单', () => {
  it('导入 · 复制 ID · 详情 · 卸载（危险动作标出来）', () => {
    const items = buildMarketInstalledRowMenu(installedRow());
    expect(ids(items)).toEqual(['market.import', 'market.copyId', 'market.detail', 'market.uninstall']);
    const uninstall = items.find((i) => i.id === 'market.uninstall');
    expect(uninstall?.danger).toBe(true);
    expect(uninstall?.label).toBe('卸载…');
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });
});

describe('面板空白处菜单', () => {
  it('拉取列表 + 发布口上…（两条都真有落点）', () => {
    expect(ids(buildMarketPanelMenu())).toEqual(['market.pull', 'market.publish']);
    expect(buildMarketPanelMenu().every((i) => hasCjkLabel(i.label))).toBe(true);
  });
});

describe('动作分发', () => {
  it('索引行四条', () => {
    const host = hostSpy();
    const target = indexRow();
    for (const id of ['market.install', 'market.copyId', 'market.detail', 'market.copyUrl', 'market.openSource']) {
      expect(runMarketRowAction(id, target, host)).toBe(true);
    }
    expect(host.calls).toEqual([
      'install:kojo-pack|sample|1.0.0',
      'copy:sample',
      'detail:kojo-pack|sample|1.0.0',
      'copy:https://example.invalid/sample.zip',
      'open:https://example.invalid/sample.zip',
    ]);
  });

  it('动作与行的真实动作态不符 ⇒ 不执行（菜单外的调用不越权）', () => {
    const host = hostSpy();
    expect(runMarketRowAction('market.update', indexRow({ action: 'install' }), host)).toBe(false);
    expect(runMarketRowAction('market.install', indexRow({ action: 'none' }), host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('已装行三条（导入 / 卸载 / 详情）', () => {
    const host = hostSpy();
    const target = installedRow();
    expect(runMarketRowAction('market.import', target, host)).toBe(true);
    expect(runMarketRowAction('market.uninstall', target, host)).toBe(true);
    expect(host.calls).toEqual(['import:kojo-pack|sample|1.0.0', 'uninstall:kojo-pack|sample|1.0.0']);
  });

  it('跨种类调用一律 false（索引行没有卸载，已装行没有安装）', () => {
    const host = hostSpy();
    expect(runMarketRowAction('market.uninstall', indexRow(), host)).toBe(false);
    expect(runMarketRowAction('market.install', installedRow() as never, host)).toBe(false);
    expect(runMarketRowAction('market.copyUrl', installedRow() as never, host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('没有来源网址时即使被点名也不开外链', () => {
    const host = hostSpy();
    expect(runMarketRowAction('market.openSource', indexRow({ sourceUrl: undefined }), host)).toBe(false);
    expect(host.calls).toEqual([]);
  });
});

describe('接线与降级', () => {
  it('索引行 / 已装行各用各的无障碍名', () => {
    const seen: PluginContextMenuRequest[] = [];
    openMarketRowMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, indexRow(), hostSpy());
    openMarketRowMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, installedRow(), hostSpy());
    expect(seen[0]?.ariaLabel).toBe(MARKET_INDEX_MENU_ARIA);
    expect(seen[1]?.ariaLabel).toBe(MARKET_INSTALLED_MENU_ARIA);
  });

  it('坐标透传 + 选中回调真的分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openMarketRowMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 55, clientY: 66 }, indexRow(), host);
    expect(seen[0]?.x).toBe(55);
    seen[0]?.onSelect('market.copyId');
    expect(host.calls).toEqual(['copy:sample']);
  });

  it('面板空白处：拉取与发布', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openMarketPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, host);
    expect(seen[0]?.ariaLabel).toBe(MARKET_PANEL_MENU_ARIA);
    seen[0]?.onSelect('market.pull');
    seen[0]?.onSelect('market.publish');
    expect(host.calls).toEqual(['pull', 'publish']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openMarketRowMenu({}, { clientX: 1, clientY: 2 }, indexRow(), hostSpy())).toBe(false);
    expect(openMarketPanelMenu({}, { clientX: 1, clientY: 2 }, hostSpy())).toBe(false);
  });
});
