// @vitest-environment happy-dom
/**
 * 界面面注册表 + 三级路由判据（1023 覆盖面批 · WP0）。
 *
 * 判据：
 * - 清单是权威（id 唯一、无障碍名全中文、分区合法）；
 * - 「已声明的面」必须是清单的子集（清单外的新面会在这条上红，逼你先登记）；
 * - 声明幂等：同 id 覆盖 + 告警，不重复占位；
 * - 三级策略按顺序生效：显式面 → 输入框面 → 兜底；前一级「没话说」就往下一级走
 *   （空菜单不能被当成"有话说"）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_SURFACE_MANIFEST,
  buildContextMenuRoute,
  declareContextSurface,
  getContextSurface,
  listContextSurfaces,
} from '../src/ui/context-surfaces';
import { FALLBACK_MENU_ARIA_LABEL, isChineseMenuLabel } from '../src/ui/context-menu-model';

const event = (): MouseEvent => new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 34 });

const surfaceRoot = (id: string): HTMLElement => {
  const el = document.createElement('div');
  el.setAttribute('data-context-surface', id);
  const child = document.createElement('span');
  el.appendChild(child);
  document.body.appendChild(el);
  return child;
};

describe('CONTEXT_SURFACE_MANIFEST · 权威清单', () => {
  it('id 唯一（同 id 两面 = 谁接管右键说不清）', () => {
    const ids = CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('无障碍名一律中文（英文 = 读屏里冒出生肉）', () => {
    for (const entry of CONTEXT_SURFACE_MANIFEST) {
      expect(isChineseMenuLabel(entry.ariaLabel), entry.id).toBe(true);
    }
  });

  it('清单覆盖六个分区，且每个面都归了区', () => {
    const areas = new Set(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.area));
    expect(areas).toEqual(new Set(['editor', 'explorer', 'panel', 'chrome', 'plugin', 'host']));
  });

  it('已声明的面都在清单里（清单外的新面请先登记）', () => {
    const manifestIds = new Set(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id));
    for (const spec of listContextSurfaces()) {
      expect(manifestIds.has(spec.id), spec.id).toBe(true);
    }
  });
});

describe('declareContextSurface · 登记语义', () => {
  it('幂等：同 id 反复声明只占一个位置，并告警一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import('../src/ui/context-surfaces');
    const spec = { id: 'problems' as const, ariaLabel: '问题面板菜单', area: 'panel' as const };
    fresh.declareContextSurface(spec);
    fresh.declareContextSurface(spec);
    expect(fresh.listContextSurfaces().filter((s) => s.id === 'problems')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('清单外的 id 照样登记但告警（不因漏登记就把界面炸掉）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import('../src/ui/context-surfaces');
    fresh.declareContextSurface({ id: 'demo-unknown', ariaLabel: '演示菜单', area: 'host' });
    expect(fresh.getContextSurface('demo-unknown')?.ariaLabel).toBe('演示菜单');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('buildContextMenuRoute · 三级策略', () => {
  it('输入类目标命中「输入框面」：菜单非空且全中文', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const route = buildContextMenuRoute(input, event());
    expect(route?.source).toBe('input');
    expect(route?.ariaLabel).toBe('输入框菜单');
    expect(route?.items.length).toBeGreaterThan(0);
    for (const item of route?.items ?? []) expect(isChineseMenuLabel(item.label), item.id).toBe(true);
  });

  it('只声明元数据的面（没有 build）走兜底：通用菜单，不出现空壳', () => {
    const child = surfaceRoot('editor');
    const route = buildContextMenuRoute(child, event());
    expect(route?.source).toBe('app-fallback');
    expect(route?.ariaLabel).toBe(FALLBACK_MENU_ARIA_LABEL);
    expect(route?.items.length).toBeGreaterThan(0);
  });

  it('有 build 的面接管右键，并用面的无障碍名', () => {
    const seen: string[] = [];
    declareContextSurface({
      id: 'outline',
      ariaLabel: '大纲菜单',
      area: 'panel',
      build: (ctx) => {
        seen.push(ctx.id);
        return [{ id: 'outline.copy', label: '复制大纲' }];
      },
    });
    const child = surfaceRoot('outline');
    const route = buildContextMenuRoute(child, event());
    expect(seen).toEqual(['outline']);
    expect(route?.source).toBe('outline');
    expect(route?.ariaLabel).toBe('大纲菜单');
    expect(route?.items.map((i) => i.label)).toEqual(['复制大纲']);
  });

  it('面返回空菜单 = 这一级不表态，继续往兜底走', () => {
    declareContextSurface({
      id: 'breadcrumb',
      ariaLabel: '面包屑菜单',
      area: 'explorer',
      build: () => [],
    });
    const child = surfaceRoot('breadcrumb');
    const route = buildContextMenuRoute(child, event());
    expect(route?.source).toBe('app-fallback');
  });

  it('面没给 onSelect 时选中不做事（展示型菜单），给了就用面自己的分发', () => {
    const picked: string[] = [];
    declareContextSurface({
      id: 'tutorial',
      ariaLabel: '教程菜单',
      area: 'chrome',
      build: () => ({
        items: [{ id: 'tutorial.restart', label: '重新开始教程' }],
        onSelect: (id) => picked.push(id),
      }),
    });
    const route = buildContextMenuRoute(surfaceRoot('tutorial'), event());
    route?.onSelect('tutorial.restart');
    expect(picked).toEqual(['tutorial.restart']);

    declareContextSurface({
      id: 'market',
      ariaLabel: '市场菜单',
      area: 'chrome',
      build: () => [{ id: 'market.reload', label: '刷新市场' }],
    });
    // 缺省分发是空操作：不抛就合格（各面自己决定要不要接动作）
    expect(() => buildContextMenuRoute(surfaceRoot('market'), event())?.onSelect('market.reload')).not.toThrow();
  });

  it('未声明的面 id（元素上有属性但没人登记）也走兜底', () => {
    const route = buildContextMenuRoute(surfaceRoot('nobody-declared-this'), event());
    expect(route?.source).toBe('app-fallback');
  });
});
