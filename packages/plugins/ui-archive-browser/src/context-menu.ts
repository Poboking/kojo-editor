/**
 * 归档浏览器面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 只挂**已有落点**的三类动作：
 * - 「打开 / 收起」「取出到工作区」「另存到…」= 面板自己那两个函数（`toggle` / `extract`），
 *   菜单不新增业务逻辑，只是把同一件事换个入口；
 * - 「复制路径」「复制存档目录」= 契约层共用的剪贴板通道；
 * - 「刷新列表」= 面板的显式刷新（本就存在，监视自动重扫之外的手动兜底）。
 *
 * 任务书里的「导入」**没有做**：这个面板没有任何"导入"通道（导入是市场/工作区的事），
 * 为凑菜单造一个入口就是假按钮。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

/** 档位行菜单的无障碍名 */
export const ARCHIVE_ROW_MENU_ARIA = '存档档位菜单';

/** 面板空白处菜单的无障碍名 */
export const ARCHIVE_PANEL_MENU_ARIA = '归档浏览器菜单';

/** 一条档位行在菜单里需要的最小上下文 */
export interface ArchiveRowMenuTarget {
  readonly path: string;
  readonly fileName: string;
  /** 浅解析失败（失败档不能展开、不能取出——不是"暂时按不了"，是这一档本来就没有可读内容） */
  readonly failed: boolean;
  /** 当前是否已展开（决定第一项叫「打开」还是「收起」） */
  readonly expanded: boolean;
}

/** 菜单动作的落点（面板注入；测试用假实现） */
export interface ArchiveMenuHost {
  open(target: ArchiveRowMenuTarget): void;
  extract(target: ArchiveRowMenuTarget, kind: 'workspace' | 'dialog'): void;
  refresh(): void;
  copy(text: string): void;
}

/** 失败原因的统一措辞（禁用项必须说话） */
const FAILED_REASON = '这一档解析失败，打不开也取不出';

/** 档位行菜单（判据层，纯函数） */
export function buildArchiveRowMenu(target: ArchiveRowMenuTarget): PluginContextMenuItem[] {
  const items: PluginContextMenuItem[] = [
    target.failed
      ? {
          id: 'archive.open',
          label: '打开',
          icon: 'chevron-right',
          disabled: true,
          disabledReason: FAILED_REASON,
          group: '档位',
        }
      : {
          id: 'archive.open',
          label: target.expanded ? '收起' : '打开',
          icon: target.expanded ? 'chevron-down' : 'chevron-right',
          group: '档位',
        },
    { id: 'archive.copyPath', label: '复制路径' },
    target.failed
      ? {
          id: 'archive.extractWorkspace',
          label: '取出到工作区',
          disabled: true,
          disabledReason: FAILED_REASON,
          dividerBefore: true,
          group: '取出',
        }
      : { id: 'archive.extractWorkspace', label: '取出到工作区', dividerBefore: true, group: '取出' },
    target.failed
      ? {
          id: 'archive.extractDialog',
          label: '另存到…',
          disabled: true,
          disabledReason: FAILED_REASON,
        }
      : { id: 'archive.extractDialog', label: '另存到…' },
    { id: 'panel.refresh', label: '刷新列表', icon: 'refresh', dividerBefore: true },
  ];
  return items;
}

/** 面板空白处菜单（判据层）：刷新 + 复制存档目录（没有目录时禁用并说明） */
export function buildArchivePanelMenu(savDir: string | null): PluginContextMenuItem[] {
  return [
    { id: 'panel.refresh', label: '刷新列表', icon: 'refresh', group: '面板' },
    savDir === null || savDir === ''
      ? {
          id: 'panel.copyDir',
          label: '复制存档目录',
          disabled: true,
          disabledReason: '当前项目没有归档目录（适配器未提供快照来源目录）',
        }
      : { id: 'panel.copyDir', label: '复制存档目录' },
  ];
}

/** 分发一个选中的 id；返回是否被本面消费 */
export function runArchiveRowAction(
  id: string,
  target: ArchiveRowMenuTarget,
  host: ArchiveMenuHost,
): boolean {
  switch (id) {
    case 'archive.open':
      if (target.failed) return false;
      host.open(target);
      return true;
    case 'archive.copyPath':
      host.copy(target.path);
      return true;
    case 'archive.extractWorkspace':
      if (target.failed) return false;
      host.extract(target, 'workspace');
      return true;
    case 'archive.extractDialog':
      if (target.failed) return false;
      host.extract(target, 'dialog');
      return true;
    case 'panel.refresh':
      host.refresh();
      return true;
    default:
      return false;
  }
}

/** 接线层：档位行菜单 */
export function openArchiveRowMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: ArchiveRowMenuTarget,
  host: ArchiveMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildArchiveRowMenu(target), ARCHIVE_ROW_MENU_ARIA, (id) => {
    runArchiveRowAction(id, target, host);
  });
}

/** 接线层：面板空白处菜单 */
export function openArchivePanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  savDir: string | null,
  host: ArchiveMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildArchivePanelMenu(savDir), ARCHIVE_PANEL_MENU_ARIA, (id) => {
    if (id === 'panel.refresh') host.refresh();
    else if (id === 'panel.copyDir' && savDir !== null && savDir !== '') host.copy(savDir);
  });
}

/** 复制动作的落点（面板把 false 变成一句人话） */
export function copyArchiveText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
