/**
 * 状态注入面板右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：标量 / 数组 / 无值三种变量行的「复制变量值」可用性、扫描中与未选档位时的
 * 禁用原因、两条动作分发、宿主缺席降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  INJECT_PANEL_MENU_ARIA,
  INJECT_VAR_MENU_ARIA,
  buildInjectPanelMenu,
  buildInjectVarMenu,
  openInjectPanelMenu,
  openInjectVarMenu,
  runInjectPanelAction,
  runInjectVarAction,
  type InjectMenuHost,
  type InjectVarMenuTarget,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function hostSpy(): InjectMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, rescan: () => void calls.push('rescan'), copy: (text) => void calls.push(`copy:${text}`) };
}

describe('变量行菜单', () => {
  it('标量有值：复制变量名 + 复制变量值（都可用）', () => {
    const items = buildInjectVarMenu({ key: 'GOLD', kind: 'scalar', scalarValue: 120 });
    expect(ids(items)).toEqual(['inj.copyKey', 'inj.copyValue']);
    expect(items.every((i) => i.disabled === undefined)).toBe(true);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('标量没值：复制变量值禁用并说明（不是"没有这条能力"）', () => {
    const item = buildInjectVarMenu({ key: 'GOLD', kind: 'scalar' }).find((i) => i.id === 'inj.copyValue');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('还没有值');
  });

  it('数组：说清"没有单个值可复制"（指向单元格那条路）', () => {
    const item = buildInjectVarMenu({ key: 'CDFLAG', kind: 'array' }).find((i) => i.id === 'inj.copyValue');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('数组');
  });

  it('字符串标量的 0 / 空串也算有值（不靠真值判断）', () => {
    expect(buildInjectVarMenu({ key: 'A', kind: 'scalar', scalarValue: 0 })[1]?.disabled).toBeUndefined();
    expect(buildInjectVarMenu({ key: 'A', kind: 'scalar', scalarValue: '' })[1]?.disabled).toBeUndefined();
  });
});

describe('面板空白处菜单', () => {
  it('正常态：重新扫描 + 复制档位路径', () => {
    expect(ids(buildInjectPanelMenu({ path: 'D:/game/sav/1.ks', scanning: false }))).toEqual([
      'inj.rescan',
      'inj.copyPath',
    ]);
  });

  it('扫描中：重新扫描禁用并说明（引擎在飞时连点没有意义）', () => {
    const item = buildInjectPanelMenu({ path: null, scanning: true }).find((i) => i.id === 'inj.rescan');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('正在扫描');
  });

  it('未选档位：复制路径禁用并指出下一步', () => {
    const item = buildInjectPanelMenu({ path: null, scanning: false }).find((i) => i.id === 'inj.copyPath');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('还没有选档位');
  });
});

describe('动作分发', () => {
  it('变量两条', () => {
    const host = hostSpy();
    const target: InjectVarMenuTarget = { key: 'GOLD', kind: 'scalar', scalarValue: 120 };
    expect(runInjectVarAction('inj.copyKey', target, host)).toBe(true);
    expect(runInjectVarAction('inj.copyValue', target, host)).toBe(true);
    expect(host.calls).toEqual(['copy:GOLD', 'copy:120']);
  });

  it('没有值的变量即使被点名也不复制', () => {
    const host = hostSpy();
    expect(runInjectVarAction('inj.copyValue', { key: 'X', kind: 'array' }, host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('面板两条（扫描中不重扫、未选档不复制路径）', () => {
    const host = hostSpy();
    expect(runInjectPanelAction('inj.rescan', { path: null, scanning: true }, host)).toBe(false);
    expect(runInjectPanelAction('inj.copyPath', { path: null, scanning: false }, host)).toBe(false);
    expect(runInjectPanelAction('inj.rescan', { path: null, scanning: false }, host)).toBe(true);
    expect(runInjectPanelAction('inj.copyPath', { path: 'D:/a.ks', scanning: false }, host)).toBe(true);
    expect(host.calls).toEqual(['rescan', 'copy:D:/a.ks']);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runInjectVarAction('nope', { key: 'X', kind: 'scalar' }, hostSpy())).toBe(false);
    expect(runInjectPanelAction('nope', { path: null, scanning: false }, hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('变量行：坐标 + 无障碍名 + 回调', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openInjectVarMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 9, clientY: 8 }, { key: 'GOLD', kind: 'scalar', scalarValue: 1 }, host);
    expect(seen[0]?.x).toBe(9);
    expect(seen[0]?.ariaLabel).toBe(INJECT_VAR_MENU_ARIA);
    seen[0]?.onSelect('inj.copyKey');
    expect(host.calls).toEqual(['copy:GOLD']);
  });

  it('面板空白处：无障碍名', () => {
    const seen: PluginContextMenuRequest[] = [];
    openInjectPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, { path: null, scanning: false }, hostSpy());
    expect(seen[0]?.ariaLabel).toBe(INJECT_PANEL_MENU_ARIA);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openInjectVarMenu({}, { clientX: 1, clientY: 2 }, { key: 'X', kind: 'scalar' }, hostSpy())).toBe(false);
    expect(openInjectPanelMenu({}, { clientX: 1, clientY: 2 }, { path: null, scanning: false }, hostSpy())).toBe(false);
  });
});
