/**
 * 口上函数树的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 三种菜单，动作全部接在**已有**两条意图上（本插件向来只发意图、不自己开门）：
 * - 函数行：打开（`editor.revealLocation`）· 在回放面板解释（`kojo.replayFunction`）·
 *   复制函数名 · 复制路径；
 * - 家族 / 面：展开或收起（本就有）· 复制名称；
 * - 面板空白处：刷新（本就有）。
 *
 * 任务书里的「在侧栏定位」**没有做**：本插件没有任何"把某个东西定位到侧栏"的通道
 * （它就是侧栏本身），造一个入口等于自欺。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

export const NAV_FUNCTION_MENU_ARIA = '函数菜单';
export const NAV_GROUP_MENU_ARIA = '函数树分组菜单';
export const NAV_PANEL_MENU_ARIA = '函数树菜单';

/** 一条函数行在菜单里需要的上下文 */
export interface NavigatorFunctionTarget {
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
}

/** 家族 / 面行（同一套动作，只是拷的名字不同） */
export interface NavigatorGroupTarget {
  readonly kind: 'family' | 'face';
  /** 折叠态的键（家族 = `角色号|家族`，面 = `角色号|家族|面`）——菜单不解析它，原样交回面板 */
  readonly key: string;
  readonly label: string;
  readonly expanded: boolean;
  readonly count: number;
}

/** 菜单动作的落点（面板注入） */
export interface NavigatorMenuHost {
  openFunction(target: NavigatorFunctionTarget): void;
  replayFunction(name: string): void;
  copy(text: string): void;
  refresh(): void;
}

/** 函数行菜单（判据层，纯函数） */
export function buildNavigatorFunctionMenu(target: NavigatorFunctionTarget): PluginContextMenuItem[] {
  return [
    { id: 'nav.func.open', label: '打开', icon: 'target', group: '函数' },
    { id: 'nav.func.replay', label: '在回放面板解释', icon: 'history' },
    { id: 'nav.func.copyName', label: '复制函数名', dividerBefore: true, group: '复制' },
    { id: 'nav.func.copyPath', label: '复制路径' },
    { id: 'nav.func.copyLoc', label: `复制位置（${target.startLine} 行）` },
  ];
}

/** 家族 / 面行菜单（判据层，纯函数） */
export function buildNavigatorGroupMenu(target: NavigatorGroupTarget): PluginContextMenuItem[] {
  const noun = target.kind === 'family' ? '家族' : '面';
  return [
    {
      id: 'nav.group.toggle',
      label: target.expanded ? `收起本${noun}` : `展开本${noun}`,
      icon: target.expanded ? 'chevron-down' : 'chevron-right',
      group: '分组',
    },
    { id: 'nav.group.copyLabel', label: '复制名称' },
  ];
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildNavigatorPanelMenu(): PluginContextMenuItem[] {
  return [{ id: 'nav.panel.refresh', label: '刷新函数树', icon: 'refresh', group: '面板' }];
}

/** 函数行的「复制路径」文本（`路径:行`，与函数树 title 同一口径） */
export function functionPathText(target: NavigatorFunctionTarget): string {
  return `${target.filePath}:${target.startLine}`;
}

/** 分发一条函数行 id；返回是否被本面消费 */
export function runNavigatorFunctionAction(
  id: string,
  target: NavigatorFunctionTarget,
  host: NavigatorMenuHost,
): boolean {
  switch (id) {
    case 'nav.func.open':
      host.openFunction(target);
      return true;
    case 'nav.func.replay':
      host.replayFunction(target.name);
      return true;
    case 'nav.func.copyName':
      host.copy(target.name);
      return true;
    case 'nav.func.copyPath':
      host.copy(target.filePath);
      return true;
    case 'nav.func.copyLoc':
      host.copy(functionPathText(target));
      return true;
    default:
      return false;
  }
}

/** 分发一条分组 id（`nav.group.toggle` 由接线层处理折叠加状态） */
export function runNavigatorGroupAction(
  id: string,
  target: NavigatorGroupTarget,
  host: NavigatorMenuHost,
): boolean {
  if (id === 'nav.group.copyLabel') {
    host.copy(target.label);
    return true;
  }
  return false;
}

/** 接线层：函数行 */
export function openNavigatorFunctionMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: NavigatorFunctionTarget,
  host: NavigatorMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildNavigatorFunctionMenu(target), NAV_FUNCTION_MENU_ARIA, (id) => {
    runNavigatorFunctionAction(id, target, host);
  });
}

/** 接线层：家族 / 面行 */
export function openNavigatorGroupMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: NavigatorGroupTarget,
  host: NavigatorMenuHost,
  onToggle: () => void,
): boolean {
  return requestPluginMenu(props, anchor, buildNavigatorGroupMenu(target), NAV_GROUP_MENU_ARIA, (id) => {
    if (id === 'nav.group.toggle') {
      onToggle();
      return;
    }
    runNavigatorGroupAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openNavigatorPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  host: NavigatorMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildNavigatorPanelMenu(), NAV_PANEL_MENU_ARIA, (id) => {
    if (id === 'nav.panel.refresh') host.refresh();
  });
}

/** 复制动作的落点 */
export function copyNavigatorText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
