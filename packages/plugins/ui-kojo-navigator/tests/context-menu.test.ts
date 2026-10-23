/**
 * 函数树右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：函数行 / 家族面行 / 面板空白处三类菜单的项集合与中文文案、
 * 家族与面用同一个 id 但换名词、动作分发（打开 / 回放 / 三种复制 / 刷新）、
 * 折叠动作由接线层落地、宿主缺席降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  NAV_FUNCTION_MENU_ARIA,
  NAV_GROUP_MENU_ARIA,
  NAV_PANEL_MENU_ARIA,
  buildNavigatorFunctionMenu,
  buildNavigatorGroupMenu,
  buildNavigatorPanelMenu,
  functionPathText,
  openNavigatorFunctionMenu,
  openNavigatorGroupMenu,
  openNavigatorPanelMenu,
  runNavigatorFunctionAction,
  runNavigatorGroupAction,
  type NavigatorFunctionTarget,
  type NavigatorMenuHost,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function fn(overrides: Partial<NavigatorFunctionTarget> = {}): NavigatorFunctionTarget {
  return { name: 'KOJO_MESSAGE_COM', filePath: 'src/erb/K1_霊夢.erb', startLine: 42, ...overrides };
}

function hostSpy(): NavigatorMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openFunction: (t) => void calls.push(`open:${t.filePath}:${t.startLine}`),
    replayFunction: (name) => void calls.push(`replay:${name}`),
    copy: (text) => void calls.push(`copy:${text}`),
    refresh: () => void calls.push('refresh'),
  };
}

describe('函数行菜单', () => {
  it('项集合：打开 · 回放 · 三种复制', () => {
    expect(ids(buildNavigatorFunctionMenu(fn()))).toEqual([
      'nav.func.open',
      'nav.func.replay',
      'nav.func.copyName',
      'nav.func.copyPath',
      'nav.func.copyLoc',
    ]);
  });

  it('文案全中文、id 唯一、没有"灰着不说话"的项', () => {
    const items = buildNavigatorFunctionMenu(fn());
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
    expect(new Set(ids(items)).size).toBe(items.length);
    for (const item of items.filter((i) => i.disabled === true)) {
      expect(item.disabledReason).toBeTypeOf('string');
    }
  });

  it('「复制位置」把行号带进文案（作者要的是能贴出去的坐标）', () => {
    const item = buildNavigatorFunctionMenu(fn({ startLine: 77 })).find((i) => i.id === 'nav.func.copyLoc');
    expect(item?.label).toContain('77');
    expect(functionPathText(fn({ startLine: 77 }))).toBe('src/erb/K1_霊夢.erb:77');
  });
});

describe('家族 / 面行菜单', () => {
  it('家族与面用同一个 id，名词跟着换', () => {
    const family = buildNavigatorGroupMenu({ kind: 'family', key: '1|', label: '初始家族', expanded: false, count: 5 });
    const face = buildNavigatorGroupMenu({ kind: 'face', key: '1||会話', label: '会話', expanded: false, count: 2 });
    expect(family[0]?.id).toBe('nav.group.toggle');
    expect(family[0]?.label).toBe('展开本家族');
    expect(face[0]?.label).toBe('展开本面');
  });

  it('展开态换文案', () => {
    const open = buildNavigatorGroupMenu({ kind: 'face', key: 'k', label: '会話', expanded: true, count: 2 });
    expect(open[0]?.label).toBe('收起本面');
  });

  it('项集合全中文', () => {
    const items = buildNavigatorGroupMenu({ kind: 'family', key: 'k', label: '家族', expanded: false, count: 1 });
    expect(ids(items)).toEqual(['nav.group.toggle', 'nav.group.copyLabel']);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });
});

describe('面板空白处菜单', () => {
  it('只有一条真能力——刷新函数树', () => {
    expect(ids(buildNavigatorPanelMenu())).toEqual(['nav.panel.refresh']);
    expect(buildNavigatorPanelMenu()[0]?.label).toBe('刷新函数树');
  });
});

describe('动作分发', () => {
  it('函数五条动作', () => {
    const host = hostSpy();
    const target = fn();
    for (const id of ids(buildNavigatorFunctionMenu(target))) {
      expect(runNavigatorFunctionAction(id, target, host)).toBe(true);
    }
    expect(host.calls).toEqual([
      'open:src/erb/K1_霊夢.erb:42',
      'replay:KOJO_MESSAGE_COM',
      'copy:KOJO_MESSAGE_COM',
      'copy:src/erb/K1_霊夢.erb',
      'copy:src/erb/K1_霊夢.erb:42',
    ]);
  });

  it('分组只消费「复制名称」（折叠由接线层处理）', () => {
    const host = hostSpy();
    const target = { kind: 'family' as const, key: 'k', label: '初始家族', expanded: false, count: 3 };
    expect(runNavigatorGroupAction('nav.group.copyLabel', target, host)).toBe(true);
    expect(runNavigatorGroupAction('nav.group.toggle', target, host)).toBe(false);
    expect(host.calls).toEqual(['copy:初始家族']);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runNavigatorFunctionAction('nope', fn(), hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('函数行：坐标 + 无障碍名 + 回调分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    expect(
      openNavigatorFunctionMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 3, clientY: 4 }, fn(), host),
    ).toBe(true);
    expect(seen[0]?.ariaLabel).toBe(NAV_FUNCTION_MENU_ARIA);
    seen[0]?.onSelect('nav.func.replay');
    expect(host.calls).toEqual(['replay:KOJO_MESSAGE_COM']);
  });

  it('分组行：折叠动作真的调用接线层回调', () => {
    const seen: PluginContextMenuRequest[] = [];
    let toggled = 0;
    openNavigatorGroupMenu(
      { openContextMenu: (r) => seen.push(r) },
      { clientX: 1, clientY: 2 },
      { kind: 'face', key: '1||会話', label: '会話', expanded: false, count: 1 },
      hostSpy(),
      () => (toggled += 1),
    );
    expect(seen[0]?.ariaLabel).toBe(NAV_GROUP_MENU_ARIA);
    seen[0]?.onSelect('nav.group.toggle');
    expect(toggled).toBe(1);
  });

  it('面板空白处：刷新分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openNavigatorPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, host);
    expect(seen[0]?.ariaLabel).toBe(NAV_PANEL_MENU_ARIA);
    seen[0]?.onSelect('nav.panel.refresh');
    expect(host.calls).toEqual(['refresh']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openNavigatorFunctionMenu({}, { clientX: 1, clientY: 2 }, fn(), hostSpy())).toBe(false);
    expect(openNavigatorPanelMenu({}, { clientX: 1, clientY: 2 }, hostSpy())).toBe(false);
  });
});
