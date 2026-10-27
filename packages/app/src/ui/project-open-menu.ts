/**
 * 项目切换入口的**菜单数据面**（WS-07：项目菜单里的「打开另一个游戏目录…」与
 * 「打开最近项目」子菜单；纯函数，node 侧直测）。
 *
 * 分工：
 * - 本模块只把「最近项目列表 + 当前项目根 ⇒ 菜单项」折成纯数据；
 * - 对话框、换根守卫、脏确认全部由宿主既有入口承担（`openProject` 一条路），
 *   菜单项**不带任何落地逻辑**，id 由 `projectDirFromMenuId` 还原成目录后交给宿主。
 *
 * 两条口径：
 * 1. **不自我指涉**：当前项目根从"最近项目"里剔掉——点自己的目录只会白重载一次；
 * 2. **label 认得出、提示给全**：label = 目录末段（重名时才补父目录一段），
 *    完整路径进 `title`（悬停可见）。路径本身绝不进 label（长路径会把菜单撑成条幅）。
 */
import { basename, dirname, pathKey } from '@kojo/plugin-api';
import type { RecentProject } from '@kojo/plugin-api';
import type { ContextMenuItem } from './context-menu-model';

/** 最近项目子菜单的条数上限（再多就不叫"最近"了） */
export const RECENT_PROJECT_MENU_LIMIT = 8;

export const PROJECT_OPEN_FOLDER_MENU_ID = 'project.openFolder';
export const PROJECT_RECENT_MENU_ID = 'project.recent';
export const PROJECT_RECENT_ITEM_PREFIX = 'project.recent:';

/** 某条最近项目对应的菜单 id（目录原样编码，含冒号也没问题——前缀剥掉即可） */
export function recentProjectItemId(rootDir: string): string {
  return `${PROJECT_RECENT_ITEM_PREFIX}${rootDir}`;
}

/** 菜单 id → 目录（不是最近项目项 ⇒ null；空目录 ⇒ null） */
export function projectDirFromMenuId(id: string): string | null {
  if (typeof id !== 'string' || !id.startsWith(PROJECT_RECENT_ITEM_PREFIX)) return null;
  const dir = id.slice(PROJECT_RECENT_ITEM_PREFIX.length);
  return dir === '' ? null : dir;
}

/** 目录末段（取不出名 ⇒ 原文，绝不显示空白项） */
function dirLabel(dir: string): string {
  return basename(dir) || dir;
}

/**
 * 最近项目 ⇒ 子菜单项。当前项目根剔除、最多 `RECENT_PROJECT_MENU_LIMIT` 条、
 * 目录末段重名时补父目录一段（`游戏A（备份）` 这种），完整路径进 `title`。
 */
export function recentProjectMenuItems(
  recent: readonly RecentProject[],
  currentRootDir?: string | null,
): ContextMenuItem[] {
  const current = currentRootDir ? pathKey(currentRootDir) : null;
  const dirs: string[] = [];
  for (const r of recent) {
    const dir = r?.rootDir;
    if (typeof dir !== 'string' || dir === '') continue;
    if (current !== null && pathKey(dir) === current) continue;
    if (dirs.some((d) => pathKey(d) === pathKey(dir))) continue;
    dirs.push(dir);
    if (dirs.length >= RECENT_PROJECT_MENU_LIMIT) break;
  }
  const bases = dirs.map(dirLabel);
  const duplicated = new Set(bases.filter((b, i) => bases.indexOf(b) !== i || bases.lastIndexOf(b) !== i));
  return dirs.map((dir, i) => {
    const base = bases[i]!;
    const parent = basename(dirname(dir));
    const label = duplicated.has(base) && parent !== '' ? `${base}（${parent}）` : base;
    return { id: recentProjectItemId(dir), label, title: dir };
  });
}

export interface ProjectMenuInput {
  readonly recent: readonly RecentProject[];
  readonly currentRootDir?: string | null;
  /** 宿主有没有"选目录开项目"的入口（缺省 = 不显示该项） */
  readonly canOpenFolder?: boolean;
  /** 宿主有没有"按目录开项目"的入口（缺省 = 不显示最近项目子菜单） */
  readonly canOpenRecent?: boolean;
  /** 宿主有没有"关闭项目"的入口（缺省 = 不显示） */
  readonly canClose?: boolean;
}

/**
 * 整个项目菜单的项表（ShellLayout 只负责挂在「更多」按钮上）。
 * 文案全中文；`disabled` 必配 `disabledReason`（铁律 4 的菜单侧同款）。
 */
export function projectMenuItemsOf(input: ProjectMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (input.canOpenFolder === true) {
    items.push({ id: PROJECT_OPEN_FOLDER_MENU_ID, label: '打开另一个游戏目录…' });
  }
  if (input.canOpenRecent === true) {
    const children = recentProjectMenuItems(input.recent, input.currentRootDir ?? null);
    items.push(
      children.length > 0
        ? { id: PROJECT_RECENT_MENU_ID, label: '打开最近项目', children }
        : {
            id: PROJECT_RECENT_MENU_ID,
            label: '打开最近项目',
            disabled: true,
            disabledReason: '最近还没有打开过别的项目',
          },
    );
  }
  if (input.canClose === true) {
    items.push({
      id: 'project.close',
      label: '关闭项目',
      danger: true,
      dividerBefore: items.length > 0,
    });
  }
  return items;
}
