/**
 * .kojo 转译检查面板右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：映射行（空行 / 非空行）、诊断行（文件级 vs 有行号）三种禁用原因，
 * 复制文本的格式，面板刷新在非 .kojo 文件时的禁用，动作分发与降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  PREVIEW_DIAG_MENU_ARIA,
  PREVIEW_PANEL_MENU_ARIA,
  PREVIEW_ROW_MENU_ARIA,
  buildPreviewDiagMenu,
  buildPreviewPanelMenu,
  buildPreviewRowMenu,
  diagCopyText,
  openPreviewDiagMenu,
  openPreviewPanelMenu,
  openPreviewRowMenu,
  runPreviewDiagAction,
  runPreviewPanelAction,
  runPreviewRowAction,
  type PreviewMenuHost,
  type PreviewRowMenuTarget,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function row(overrides: Partial<PreviewRowMenuTarget> = {}): PreviewRowMenuTarget {
  return { sourceLine: 12, sourceText: '口上「あいさつ」', generatedLabel: '第 30 行', blank: false, ...overrides };
}

function hostSpy(): PreviewMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reveal: (line) => void calls.push(`reveal:${line}`),
    refresh: () => void calls.push('refresh'),
    copy: (text) => void calls.push(`copy:${text}`),
  };
}

describe('逐行映射行菜单', () => {
  it('项集合：跳到源行 / 复制源行文本 / 复制产物行标签；全中文', () => {
    const items = buildPreviewRowMenu(row());
    expect(ids(items)).toEqual(['pv.row.reveal', 'pv.row.copySource', 'pv.row.copyGenerated']);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('空行：复制源行禁用并说明', () => {
    const item = buildPreviewRowMenu(row({ blank: true, sourceText: '' })).find((i) => i.id === 'pv.row.copySource');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('空行');
  });
});

describe('诊断行菜单', () => {
  it('有行号：跳到位置 + 复制诊断', () => {
    const items = buildPreviewDiagMenu({ severity: 'error', line: 5, column: 3, message: '缩进不对' });
    expect(ids(items)).toEqual(['pv.diag.reveal', 'pv.diag.copy']);
    expect(items[0]?.disabled).toBeUndefined();
  });

  it('文件级诊断（无行号）：跳转禁用并说明', () => {
    const item = buildPreviewDiagMenu({ severity: 'info', line: null, message: '整文件提示' })[0];
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('文件级诊断');
  });

  it('复制文本 = 严重度 + 位置 + 正文', () => {
    expect(diagCopyText({ severity: 'error', line: 5, column: 3, message: '缩进不对' })).toBe('[错误] L5:3 缩进不对');
    expect(diagCopyText({ severity: 'warning', line: null, message: '整文件' })).toBe('[警告] 整文件');
  });
});

describe('面板空白处菜单', () => {
  it('可预览：刷新 + 复制路径', () => {
    const items = buildPreviewPanelMenu({ filePath: 'src/a.kojo', canRefresh: true });
    expect(ids(items)).toEqual(['pv.panel.refresh', 'pv.panel.copyPath']);
    expect(items.every((i) => i.disabled === undefined)).toBe(true);
  });

  it('非 .kojo 文件：刷新禁用并说明', () => {
    const item = buildPreviewPanelMenu({ filePath: 'src/a.erb', canRefresh: false })[0];
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('.kojo');
  });

  it('没打开文件：复制路径禁用并说明', () => {
    const item = buildPreviewPanelMenu({ filePath: null, canRefresh: false })[1];
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toContain('还没打开');
  });
});

describe('动作分发', () => {
  it('映射行三条', () => {
    const host = hostSpy();
    const target = row();
    for (const id of ids(buildPreviewRowMenu(target))) {
      expect(runPreviewRowAction(id, target, host)).toBe(true);
    }
    expect(host.calls).toEqual(['reveal:12', 'copy:口上「あいさつ」', 'copy:第 30 行']);
  });

  it('空行即使被点名也不复制', () => {
    const host = hostSpy();
    expect(runPreviewRowAction('pv.row.copySource', row({ blank: true, sourceText: '' }), host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('诊断两条 + 文件级不跳', () => {
    const host = hostSpy();
    expect(runPreviewDiagAction('pv.diag.reveal', { severity: 'error', line: null, message: 'x' }, host)).toBe(false);
    expect(runPreviewDiagAction('pv.diag.reveal', { severity: 'error', line: 9, message: 'x' }, host)).toBe(true);
    expect(host.calls).toEqual(['reveal:9']);
  });

  it('面板两条（不可预览不刷新、无文件不复制）', () => {
    const host = hostSpy();
    expect(runPreviewPanelAction('pv.panel.refresh', { filePath: null, canRefresh: false }, host)).toBe(false);
    expect(runPreviewPanelAction('pv.panel.copyPath', { filePath: null, canRefresh: false }, host)).toBe(false);
    expect(runPreviewPanelAction('pv.panel.copyPath', { filePath: 'a.kojo', canRefresh: true }, host)).toBe(true);
    expect(host.calls).toEqual(['copy:a.kojo']);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runPreviewRowAction('nope', row(), hostSpy())).toBe(false);
    expect(runPreviewDiagAction('nope', { severity: 'info', line: null, message: '' }, hostSpy())).toBe(false);
    expect(runPreviewPanelAction('nope', { filePath: null, canRefresh: false }, hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('三个层级各用各的无障碍名', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openPreviewRowMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, row(), host);
    openPreviewDiagMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, { severity: 'error', line: 1, message: 'm' }, host);
    openPreviewPanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, { filePath: 'a.kojo', canRefresh: true }, host);
    expect(seen.map((r) => r.ariaLabel)).toEqual([
      PREVIEW_ROW_MENU_ARIA,
      PREVIEW_DIAG_MENU_ARIA,
      PREVIEW_PANEL_MENU_ARIA,
    ]);
  });

  it('坐标透传 + 选中回调', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openPreviewRowMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 21, clientY: 22 }, row(), host);
    expect(seen[0]?.x).toBe(21);
    seen[0]?.onSelect('pv.row.reveal');
    expect(host.calls).toEqual(['reveal:12']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openPreviewRowMenu({}, { clientX: 1, clientY: 2 }, row(), hostSpy())).toBe(false);
    expect(openPreviewPanelMenu({}, { clientX: 1, clientY: 2 }, { filePath: null, canRefresh: false }, hostSpy())).toBe(false);
  });
});
