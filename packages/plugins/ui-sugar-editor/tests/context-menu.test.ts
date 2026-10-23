/**
 * 糖判定面板右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：诊断行（有无行号）的禁用原因与复制文本格式、面板在无文件 / 非 .kojo 时的
 * 禁用原因、糖视图切换的两条通道、分发与降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  VERDICT_DIAG_MENU_ARIA,
  VERDICT_PANEL_MENU_ARIA,
  buildVerdictDiagMenu,
  buildVerdictPanelMenu,
  openVerdictDiagMenu,
  openVerdictPanelMenu,
  runVerdictDiagAction,
  runVerdictPanelAction,
  verdictDiagCopyText,
  type VerdictDiagMenuTarget,
  type VerdictMenuHost,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function diag(overrides: Partial<VerdictDiagMenuTarget> = {}): VerdictDiagMenuTarget {
  return {
    severity: 'error',
    code: 'sugar.indent',
    codeName: '缩进',
    line: 7,
    column: 2,
    message: '缩进必须用全角空格',
    ...overrides,
  };
}

function hostSpy(): VerdictMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reveal: (line) => void calls.push(`reveal:${line}`),
    refresh: () => void calls.push('refresh'),
    setSugarView: (on) => void calls.push(`view:${on}`),
    copy: (text) => void calls.push(`copy:${text}`),
  };
}

describe('诊断行菜单', () => {
  it('两处菜单的 id 都唯一（宿主按 id 分发，重号会点错动作）', () => {
    const diagIds = ids(buildVerdictDiagMenu(diag()));
    const panelIds = ids(buildVerdictPanelMenu({ filePath: 'a.kojo', canRefresh: true }));
    const panelNoFile = ids(buildVerdictPanelMenu({ filePath: null, canRefresh: false }));
    for (const list of [diagIds, panelIds, panelNoFile]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('项集合：跳到源行 + 复制诊断；全中文', () => {
    const items = buildVerdictDiagMenu(diag());
    expect(ids(items)).toEqual(['sv.diag.reveal', 'sv.diag.copy']);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('文件级诊断（无行号）：跳转禁用并说明', () => {
    const item = buildVerdictDiagMenu(diag({ line: null, column: null }))[0];
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('文件级诊断');
  });

  it('复制文本 = 严重度 + 位置 + 中文短名（原码）+ 正文', () => {
    expect(verdictDiagCopyText(diag())).toBe('[错误] L7:2 缩进（sugar.indent） 缩进必须用全角空格');
    expect(verdictDiagCopyText(diag({ line: null, column: null }))).toBe(
      '[错误] 缩进（sugar.indent） 缩进必须用全角空格',
    );
  });
});

describe('面板空白处菜单', () => {
  it('有 .kojo 文件：刷新 + 两种视图 + 复制路径', () => {
    const items = buildVerdictPanelMenu({ filePath: 'a.kojo', canRefresh: true });
    expect(ids(items)).toEqual([
      'sv.panel.refresh',
      'sv.panel.showSource',
      'sv.panel.showSugar',
      'sv.panel.copyPath',
    ]);
    expect(items.every((i) => i.disabled === undefined)).toBe(true);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('非 .kojo：刷新禁用并说明（视图切换与复制仍可用——那两条不依赖转译）', () => {
    const items = buildVerdictPanelMenu({ filePath: 'a.erb', canRefresh: false });
    expect(items.find((i) => i.id === 'sv.panel.refresh')?.disabled).toBe(true);
    expect(items.find((i) => i.id === 'sv.panel.refresh')?.disabledReason).toContain('.kojo');
    expect(items.find((i) => i.id === 'sv.panel.showSource')?.disabled).toBeUndefined();
  });

  it('没打开文件：四条全禁用且都带原因', () => {
    const items = buildVerdictPanelMenu({ filePath: null, canRefresh: false });
    for (const item of items) {
      expect(item.disabled).toBe(true);
      expect(hasCjkLabel(item.disabledReason ?? '')).toBe(true);
    }
  });
});

describe('动作分发', () => {
  it('诊断两条', () => {
    const host = hostSpy();
    expect(runVerdictDiagAction('sv.diag.reveal', diag(), host)).toBe(true);
    expect(runVerdictDiagAction('sv.diag.copy', diag(), host)).toBe(true);
    expect(host.calls[0]).toBe('reveal:7');
    expect(host.calls[1]?.startsWith('copy:[错误] L7:2')).toBe(true);
  });

  it('文件级诊断即使被点名也不跳', () => {
    const host = hostSpy();
    expect(runVerdictDiagAction('sv.diag.reveal', diag({ line: null }), host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('面板四条（视图切换走 on=false / on=true 两条通道）', () => {
    const host = hostSpy();
    const target = { filePath: 'a.kojo', canRefresh: true };
    expect(runVerdictPanelAction('sv.panel.refresh', target, host)).toBe(true);
    expect(runVerdictPanelAction('sv.panel.showSource', target, host)).toBe(true);
    expect(runVerdictPanelAction('sv.panel.showSugar', target, host)).toBe(true);
    expect(runVerdictPanelAction('sv.panel.copyPath', target, host)).toBe(true);
    expect(host.calls).toEqual(['refresh', 'view:false', 'view:true', 'copy:a.kojo']);
  });

  it('没有文件时不刷新、不切视图、不复制', () => {
    const host = hostSpy();
    const target = { filePath: null, canRefresh: false };
    for (const id of ['sv.panel.refresh', 'sv.panel.showSource', 'sv.panel.showSugar', 'sv.panel.copyPath']) {
      expect(runVerdictPanelAction(id, target, host)).toBe(false);
    }
    expect(host.calls).toEqual([]);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runVerdictDiagAction('nope', diag(), hostSpy())).toBe(false);
    expect(runVerdictPanelAction('nope', { filePath: null, canRefresh: false }, hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('诊断行：坐标 + 无障碍名 + 回调', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openVerdictDiagMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 5, clientY: 6 }, diag(), host);
    expect(seen[0]?.x).toBe(5);
    expect(seen[0]?.ariaLabel).toBe(VERDICT_DIAG_MENU_ARIA);
    seen[0]?.onSelect('sv.diag.copy');
    expect(host.calls).toHaveLength(1);
  });

  it('面板空白处：无障碍名 + 视图切换分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openVerdictPanelMenu(
      { openContextMenu: (r) => seen.push(r) },
      { clientX: 1, clientY: 2 },
      { filePath: 'a.kojo', canRefresh: true },
      host,
    );
    expect(seen[0]?.ariaLabel).toBe(VERDICT_PANEL_MENU_ARIA);
    seen[0]?.onSelect('sv.panel.showSource');
    expect(host.calls).toEqual(['view:false']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openVerdictDiagMenu({}, { clientX: 1, clientY: 2 }, diag(), hostSpy())).toBe(false);
    expect(openVerdictPanelMenu({}, { clientX: 1, clientY: 2 }, { filePath: null, canRefresh: false }, hostSpy())).toBe(false);
  });
});
