/**
 * 状态注入面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 两个层级：
 * - **变量行**：复制变量名 / 复制变量值（非标量变量没有"单个值"可复制 ⇒ 禁用 + 原因）；
 * - **面板空白处**：重新扫描（本就有）· 复制档位路径（没选档位时禁用 + 原因）。
 *
 * 任务书里的「恢复快照」「打开存档目录」**没有做**：
 * - 恢复快照 = 把某个档写回去，本面板只有「把变量补丁注入存档」这一条写通道，
 *   没有"整档恢复"这回事；造一个入口会直接写坏作者的存档；
 * - 打开存档目录 = 契约里没有任何"在系统文件管理器里打开路径"的通道（`ui.openExternal`
 *   只收 URL），插件够不着。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

export const INJECT_VAR_MENU_ARIA = '存档变量菜单';
export const INJECT_PANEL_MENU_ARIA = '状态注入菜单';

/** 变量行上下文（只取菜单要用的三个字段） */
export interface InjectVarMenuTarget {
  readonly key: string;
  readonly kind: 'scalar' | 'array' | 'other';
  readonly scalarValue?: number | string;
}

/** 面板空白处上下文 */
export interface InjectPanelMenuTarget {
  /** 当前选中的档位路径（null = 还没选） */
  readonly path: string | null;
  /** 扫描在飞 */
  readonly scanning: boolean;
}

/** 菜单动作的落点（面板注入） */
export interface InjectMenuHost {
  rescan(): void;
  copy(text: string): void;
}

/** 变量行菜单（判据层，纯函数） */
export function buildInjectVarMenu(target: InjectVarMenuTarget): PluginContextMenuItem[] {
  const hasValue = target.scalarValue !== undefined && target.scalarValue !== null;
  return [
    { id: 'inj.copyKey', label: '复制变量名', group: '变量' },
    hasValue
      ? { id: 'inj.copyValue', label: '复制变量值' }
      : {
          id: 'inj.copyValue',
          label: '复制变量值',
          disabled: true,
          disabledReason:
            target.kind === 'scalar'
              ? '这个变量还没有值'
              : '这个变量是数组，没有单个值可复制（先在右侧选单元格）',
        },
  ];
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildInjectPanelMenu(target: InjectPanelMenuTarget): PluginContextMenuItem[] {
  return [
    target.scanning
      ? {
          id: 'inj.rescan',
          label: '重新扫描',
          icon: 'refresh',
          disabled: true,
          disabledReason: '正在扫描存档目录，稍等这一趟结束',
          group: '存档',
        }
      : { id: 'inj.rescan', label: '重新扫描', icon: 'refresh', group: '存档' },
    target.path === null
      ? {
          id: 'inj.copyPath',
          label: '复制档位路径',
          disabled: true,
          disabledReason: '还没有选档位（先从上方下拉里选一份存档）',
        }
      : { id: 'inj.copyPath', label: '复制档位路径' },
  ];
}

/** 分发一条变量行 id；返回是否被本面消费 */
export function runInjectVarAction(
  id: string,
  target: InjectVarMenuTarget,
  host: InjectMenuHost,
): boolean {
  switch (id) {
    case 'inj.copyKey':
      host.copy(target.key);
      return true;
    case 'inj.copyValue': {
      const value = target.scalarValue;
      if (value === undefined || value === null) return false;
      host.copy(String(value));
      return true;
    }
    default:
      return false;
  }
}

/** 分发一条面板 id */
export function runInjectPanelAction(
  id: string,
  target: InjectPanelMenuTarget,
  host: InjectMenuHost,
): boolean {
  switch (id) {
    case 'inj.rescan':
      if (target.scanning) return false;
      host.rescan();
      return true;
    case 'inj.copyPath':
      if (target.path === null) return false;
      host.copy(target.path);
      return true;
    default:
      return false;
  }
}

/** 接线层：变量行 */
export function openInjectVarMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: InjectVarMenuTarget,
  host: InjectMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildInjectVarMenu(target), INJECT_VAR_MENU_ARIA, (id) => {
    runInjectVarAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openInjectPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: InjectPanelMenuTarget,
  host: InjectMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildInjectPanelMenu(target), INJECT_PANEL_MENU_ARIA, (id) => {
    runInjectPanelAction(id, target, host);
  });
}

/** 复制动作的落点 */
export function copyInjectText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
