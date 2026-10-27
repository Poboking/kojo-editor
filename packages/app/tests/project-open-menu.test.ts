import { describe, expect, it } from 'vitest';
import type { RecentProject } from '@kojo/plugin-api';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import {
  PROJECT_OPEN_FOLDER_MENU_ID,
  PROJECT_RECENT_MENU_ID,
  RECENT_PROJECT_MENU_LIMIT,
  projectDirFromMenuId,
  projectMenuItemsOf,
  recentProjectItemId,
  recentProjectMenuItems,
} from '../src/ui/project-open-menu';

/**
 * 项目切换菜单（WS-07）的判据：菜单项是纯数据，构造规则与"点下去能不能还原目录"
 * 都钉在这里（ShellLayout 只负责挂到「更多」按钮上）。
 */

const rec = (rootDir: string, lastOpenedAt = 0): RecentProject => ({ rootDir, adapterId: 'era', lastOpenedAt });

/** 菜单树里的全部项（含子菜单） */
function flatten(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

describe('recentProjectItemId / projectDirFromMenuId', () => {
  it('id 往返：Windows 路径里的冒号不影响还原', () => {
    const dir = 'C:\\Games\\eraTW';
    expect(projectDirFromMenuId(recentProjectItemId(dir))).toBe(dir);
  });

  it('不是最近项目项 / 空目录 ⇒ null（分发侧不猜）', () => {
    expect(projectDirFromMenuId('project.close')).toBeNull();
    expect(projectDirFromMenuId('project.recent')).toBeNull();
    expect(projectDirFromMenuId('project.recent:')).toBeNull();
  });
});

describe('recentProjectMenuItems', () => {
  it('label = 目录末段，完整路径进 title；顺序沿用最近列表', () => {
    const items = recentProjectMenuItems([rec('D:/游戏/eraTW'), rec('E:/备份/eraTW改')]);
    expect(items.map((i) => i.label)).toEqual(['eraTW', 'eraTW改']);
    expect(items.map((i) => i.title)).toEqual(['D:/游戏/eraTW', 'E:/备份/eraTW改']);
  });

  it('末段重名时补父目录一段（两份 eraTW 认得出是谁）', () => {
    const items = recentProjectMenuItems([rec('D:/原版/eraTW'), rec('D:/改版/eraTW')]);
    expect(items.map((i) => i.label)).toEqual(['eraTW（原版）', 'eraTW（改版）']);
  });

  it('剔掉当前项目根（pathKey 判等：写法差异也算同一个）', () => {
    const items = recentProjectMenuItems(
      [rec('C:/Game/eraTW'), rec('D:/Other/eraTW2')],
      'c:\\game\\eratw',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('D:/Other/eraTW2');
  });

  it('最多 8 条，重复目录只留一条', () => {
    const many = Array.from({ length: 12 }, (_, i) => rec(`D:/p${i}`));
    expect(recentProjectMenuItems(many)).toHaveLength(RECENT_PROJECT_MENU_LIMIT);
    expect(RECENT_PROJECT_MENU_LIMIT).toBe(8);
    const dup = recentProjectMenuItems([rec('D:/p'), rec('D:/P/')]);
    expect(dup).toHaveLength(1);
  });

  it('空列表 ⇒ 空数组（父项由 projectMenuItemsOf 决定怎么呈现）', () => {
    expect(recentProjectMenuItems([])).toEqual([]);
    expect(recentProjectMenuItems([rec('C:/only')], 'C:/only')).toEqual([]);
  });
});

describe('projectMenuItemsOf（整份项目菜单）', () => {
  it('三种能力齐备：打开目录 + 最近项目子菜单 + 关闭项目（分隔线在关闭前）', () => {
    const items = projectMenuItemsOf({
      recent: [rec('D:/a'), rec('D:/b')],
      currentRootDir: 'D:/a',
      canOpenFolder: true,
      canOpenRecent: true,
      canClose: true,
    });
    expect(items.map((i) => i.id)).toEqual([
      PROJECT_OPEN_FOLDER_MENU_ID,
      PROJECT_RECENT_MENU_ID,
      'project.close',
    ]);
    const recent = items[1]!;
    expect(recent.children?.map((c) => c.label)).toEqual(['b']);
    expect(items[2]!.danger).toBe(true);
    expect(items[2]!.dividerBefore).toBe(true);
  });

  it('没有最近项目：父项保留但禁用且说明原因（铁律 4：灰着必须说话）', () => {
    const items = projectMenuItemsOf({ recent: [], canOpenRecent: true, canClose: true });
    const recent = items.find((i) => i.id === PROJECT_RECENT_MENU_ID)!;
    expect(recent.disabled).toBe(true);
    expect(recent.disabledReason).not.toBe('');
    expect(recent.children).toBeUndefined();
  });

  it('宿主没给入口的项整项不出现（没有落地面就不摆空壳）', () => {
    expect(projectMenuItemsOf({ recent: [] })).toEqual([]);
    expect(projectMenuItemsOf({ recent: [], canClose: true }).map((i) => i.id)).toEqual(['project.close']);
  });

  it('固定项文案是中文、id 唯一（子菜单里的目录名是作者数据，不属于文案管辖）', () => {
    const items = projectMenuItemsOf({
      recent: [rec('D:/a'), rec('D:/b'), rec('D:/c')],
      canOpenFolder: true,
      canOpenRecent: true,
      canClose: true,
    });
    // 固定文案（不含"最近项目"里的目录末段——那是作者自己的目录名，可能是英文）
    for (const label of [PROJECT_OPEN_FOLDER_MENU_ID, PROJECT_RECENT_MENU_ID, 'project.close']) {
      const item = flatten(items).find((i) => i.id === label)!;
      expect(isChineseMenuLabel(item.label)).toBe(true);
    }
    const ids = flatten(items).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
