/**
 * 归档浏览器右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：档位行两种形态（可读 / 解析失败）的项集合与禁用原因、展开态换文案、
 * 面板空白处的「复制存档目录」在无目录时的禁用原因、动作分发、宿主缺席降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  ARCHIVE_PANEL_MENU_ARIA,
  ARCHIVE_ROW_MENU_ARIA,
  buildArchivePanelMenu,
  buildArchiveRowMenu,
  openArchivePanelMenu,
  openArchiveRowMenu,
  runArchiveRowAction,
  type ArchiveMenuHost,
  type ArchiveRowMenuTarget,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function rowTarget(overrides: Partial<ArchiveRowMenuTarget> = {}): ArchiveRowMenuTarget {
  return { path: 'D:/game/sav/1.ks', fileName: '1.ks', failed: false, expanded: false, ...overrides };
}

function hostSpy(): ArchiveMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    open: () => void calls.push('open'),
    extract: (_t, kind) => void calls.push(`extract:${kind}`),
    refresh: () => void calls.push('refresh'),
    copy: (text) => void calls.push(`copy:${text}`),
  };
}

describe('档位行菜单 · 项集合', () => {
  it('可读档：打开 · 复制路径 · 两种取出 · 刷新', () => {
    expect(ids(buildArchiveRowMenu(rowTarget()))).toEqual([
      'archive.open',
      'archive.copyPath',
      'archive.extractWorkspace',
      'archive.extractDialog',
      'panel.refresh',
    ]);
  });

  it('展开态第一项换文案（同一个 id，不做两个入口）', () => {
    const open = buildArchiveRowMenu(rowTarget({ expanded: false }))[0];
    const collapse = buildArchiveRowMenu(rowTarget({ expanded: true }))[0];
    expect(open?.label).toBe('打开');
    expect(collapse?.label).toBe('收起');
    expect(collapse?.id).toBe('archive.open');
  });

  it('文案全中文、id 唯一', () => {
    const items = buildArchiveRowMenu(rowTarget());
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
    expect(new Set(ids(items)).size).toBe(items.length);
  });

  it('凡是 disabled 都带中文原因（铁律 4：灰着必须说话）', () => {
    const items = buildArchiveRowMenu(rowTarget({ failed: true }));
    const disabled = items.filter((i) => i.disabled === true);
    expect(disabled.length).toBeGreaterThan(0);
    for (const item of disabled) {
      expect(item.disabledReason).toBeTypeOf('string');
      expect(hasCjkLabel(item.disabledReason ?? '')).toBe(true);
    }
  });
});

describe('档位行菜单 · 解析失败的档', () => {
  it('打开与两种取出都禁用，复制路径与刷新仍可用', () => {
    const items = buildArchiveRowMenu(rowTarget({ failed: true }));
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('archive.open')?.disabled).toBe(true);
    expect(byId.get('archive.extractWorkspace')?.disabled).toBe(true);
    expect(byId.get('archive.extractDialog')?.disabled).toBe(true);
    expect(byId.get('archive.copyPath')?.disabled).toBeUndefined();
    expect(byId.get('panel.refresh')?.disabled).toBeUndefined();
  });
});

describe('面板空白处菜单 · 存档目录', () => {
  it('有目录：刷新 + 复制存档目录（可用）', () => {
    const items = buildArchivePanelMenu('D:/game/sav');
    expect(ids(items)).toEqual(['panel.refresh', 'panel.copyDir']);
    expect(items[1]?.disabled).toBeUndefined();
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('没有目录：整项禁用并说清为什么（不整项删除——目录是"暂时没有"，不是"没有这条能力"）', () => {
    for (const dir of [null, '']) {
      const items = buildArchivePanelMenu(dir);
      const copyDir = items.find((i) => i.id === 'panel.copyDir');
      expect(copyDir?.disabled).toBe(true);
      expect(copyDir?.disabledReason).toContain('归档目录');
    }
  });
});

describe('动作分发', () => {
  it('读档四条动作各就各位', () => {
    const host = hostSpy();
    const target = rowTarget();
    for (const id of ['archive.open', 'archive.copyPath', 'archive.extractWorkspace', 'archive.extractDialog', 'panel.refresh']) {
      expect(runArchiveRowAction(id, target, host)).toBe(true);
    }
    expect(host.calls).toEqual([
      'open',
      'copy:D:/game/sav/1.ks',
      'extract:workspace',
      'extract:dialog',
      'refresh',
    ]);
  });

  it('失败档即使被点名也不执行打开/取出', () => {
    const host = hostSpy();
    const failed = rowTarget({ failed: true });
    expect(runArchiveRowAction('archive.open', failed, host)).toBe(false);
    expect(runArchiveRowAction('archive.extractWorkspace', failed, host)).toBe(false);
    expect(runArchiveRowAction('archive.extractDialog', failed, host)).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('不认识的 id ⇒ false', () => {
    expect(runArchiveRowAction('nope', rowTarget(), hostSpy())).toBe(false);
  });
});

describe('接线与降级', () => {
  it('宿主注入：坐标 + 无障碍名 + 选中回调分发', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    expect(
      openArchiveRowMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 10, clientY: 20 }, rowTarget(), host),
    ).toBe(true);
    expect(seen[0]?.x).toBe(10);
    expect(seen[0]?.ariaLabel).toBe(ARCHIVE_ROW_MENU_ARIA);
    seen[0]?.onSelect('archive.copyPath');
    expect(host.calls).toEqual(['copy:D:/game/sav/1.ks']);
  });

  it('面板空白处：复制存档目录只在有目录时真的复制', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = hostSpy();
    openArchivePanelMenu({ openContextMenu: (r) => seen.push(r) }, { clientX: 1, clientY: 2 }, 'D:/game/sav', host);
    expect(seen[0]?.ariaLabel).toBe(ARCHIVE_PANEL_MENU_ARIA);
    seen[0]?.onSelect('panel.copyDir');
    expect(host.calls).toEqual(['copy:D:/game/sav']);
  });

  it('宿主缺席 ⇒ false，不抛错', () => {
    expect(openArchiveRowMenu({}, { clientX: 1, clientY: 2 }, rowTarget(), hostSpy())).toBe(false);
    expect(openArchivePanelMenu({}, { clientX: 1, clientY: 2 }, 'D:/game/sav', hostSpy())).toBe(false);
  });
});
