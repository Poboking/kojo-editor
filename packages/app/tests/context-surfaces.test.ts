// @vitest-environment happy-dom
/**
 * 界面面注册表 + 三级路由判据（1023 覆盖面批 · WP0）。
 *
 * 判据：
 * - 清单是权威（id 唯一、无障碍名全中文、分区合法）；
 * - 「已声明的面」必须是清单的子集（清单外的新面会在这条上红，逼你先登记）；
 * - 声明幂等：同 id 覆盖 + 告警，不重复占位；
 * - 三级策略按顺序生效：输入框面（优先）→ 显式面（逐级上溯）→ 兜底；前一级「没话说」
 *   就往下一级走（空菜单不能被当成"有话说"），内层不表态要问外层而不是直接落兜底。
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
      id: 'call-hierarchy',
      ariaLabel: '调用层级菜单',
      area: 'panel',
      build: (ctx) => {
        seen.push(ctx.id);
        return [{ id: 'callHierarchy.copy', label: '复制调用层级' }];
      },
    });
    const child = surfaceRoot('call-hierarchy');
    const route = buildContextMenuRoute(child, event());
    expect(seen).toEqual(['call-hierarchy']);
    expect(route?.source).toBe('call-hierarchy');
    expect(route?.ariaLabel).toBe('调用层级菜单');
    expect(route?.items.map((i) => i.label)).toEqual(['复制调用层级']);
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
      id: 'welcome',
      ariaLabel: '欢迎页菜单',
      area: 'chrome',
      build: () => [{ id: 'welcome.reload', label: '刷新欢迎页' }],
    });
    // 缺省分发是空操作：不抛就合格（各面自己决定要不要接动作）
    expect(() => buildContextMenuRoute(surfaceRoot('welcome'), event())?.onSelect('welcome.reload')).not.toThrow();
  });

  it('未声明的面 id（元素上有属性但没人登记）也走兜底', () => {
    const route = buildContextMenuRoute(surfaceRoot('nobody-declared-this'), event());
    expect(route?.source).toBe('app-fallback');
  });
});

describe('buildContextMenuRoute · 嵌套面上溯', () => {
  const nested = (outerId: string, innerId: string): HTMLElement => {
    const outer = document.createElement('div');
    outer.setAttribute('data-context-surface', outerId);
    const inner = document.createElement('div');
    inner.setAttribute('data-context-surface', innerId);
    const leaf = document.createElement('span');
    inner.appendChild(leaf);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    return leaf;
  };

  it('内层不表态 ⇒ 问外层（不降级成通用菜单）', () => {
    declareContextSurface({
      id: 'editor',
      ariaLabel: '编辑区菜单',
      area: 'editor',
      build: () => [{ id: 'editor.closeGroup', label: '关闭编辑器组' }],
    });
    declareContextSurface({
      id: 'diff-view',
      ariaLabel: '差异视图菜单',
      area: 'panel',
      // 局部没话说（例如这里不是可对比的行）——它不该把用户的右键一路打到兜底
      build: () => null,
    });
    const route = buildContextMenuRoute(nested('editor', 'diff-view'), event());
    expect(route?.source).toBe('editor');
    expect(route?.items.map((i) => i.label)).toEqual(['关闭编辑器组']);
  });

  it('同一 id 在嵌套里重复出现时只问一次（不重复构建）', () => {
    let calls = 0;
    declareContextSurface({
      id: 'panel-tabs',
      ariaLabel: '面板选项卡菜单',
      area: 'panel',
      build: () => {
        calls += 1;
        return [];
      },
    });
    const route = buildContextMenuRoute(nested('panel-tabs', 'panel-tabs'), event());
    expect(calls).toBe(1);
    expect(route?.source).toBe('app-fallback');
  });

  it('输入框在容器面内部时，输入框面优先（不被容器面截走）', () => {
    // 浮窗里放一个输入框：右键它必须是剪切/复制/粘贴，不是「关闭浮窗」
    declareContextSurface({
      id: 'floating-window',
      ariaLabel: '浮动窗菜单',
      area: 'panel',
      build: () => [{ id: 'floatingWindow.close', label: '关闭浮窗' }],
    });
    const host = document.createElement('div');
    host.setAttribute('data-context-surface', 'floating-window');
    const input = document.createElement('input');
    host.appendChild(input);
    document.body.appendChild(host);

    const route = buildContextMenuRoute(input, event());
    expect(route?.source).toBe('input');
    expect(route?.items.some((i) => i.label === '关闭浮窗')).toBe(false);
  });
});
