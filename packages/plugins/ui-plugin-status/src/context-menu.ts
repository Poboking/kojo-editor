/**
 * 插件状态面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 分两层：**判据层**（本文件上半：纯函数，输入一行插件状态 + 动作通道，输出菜单项 /
 * 是否消费了某个 id）与**接线层**（`openPluginRowMenu` / `openPluginPanelMenu`，
 * 把菜单交给宿主）。纯函数层可在 node 里直测，不必渲染面板。
 *
 * 只挂真实存在的能力（铁律 3）：
 * - 「复制插件 ID」= `copyTextToClipboard`（契约层共用，缺环境时明确失败）；
 * - 「重试激活」/「停用插件」= `PluginRegistry.retry` / `stop`（契约里确有这两个方法）；
 * - 「刷新列表」= 面板自己的 `registry.list()` 重读。
 *
 * 状态的**不可用**用「整项不显示」表达而不是灰项：对 `active` 的插件谈「重试激活」是
 * 没有意义的能力，而不是「暂时按不了」——两者口径不同，见地基注释。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type PluginStateRecord,
  type UIPanelProps,
} from '@kojo/plugin-api';

/** 行菜单的无障碍名（清单里没有独立面 id，这一层由宿主桥按面板 id 记来源） */
export const PLUGIN_ROW_MENU_ARIA = '插件条目菜单';

/** 面板空白处菜单的无障碍名 */
export const PLUGIN_PANEL_MENU_ARIA = '插件状态菜单';

/** 行菜单需要的最小上下文（只读，来自 `PluginStateRecord`） */
export interface PluginRowMenuTarget {
  readonly id: string;
  readonly status: PluginStateRecord['status'];
}

/** 菜单动作的落点（面板注入；测试用假实现即可断言分发） */
export interface PluginStatusMenuHost {
  /** 复制一段文本（失败时面板负责说一句话） */
  copy(text: string): void;
  retry(id: string): void;
  stop(id: string): void;
  refresh(): void;
}

/** 这三态才谈得上「重试激活」：内核那边也只对 inactive / error 允许 retry */
function canRetry(status: PluginStateRecord['status']): boolean {
  return status === 'inactive' || status === 'error';
}

/** 行级菜单（判据层，纯函数） */
export function buildPluginRowMenu(target: PluginRowMenuTarget): PluginContextMenuItem[] {
  const items: PluginContextMenuItem[] = [
    { id: 'plugin.copyId', label: '复制插件 ID', group: '插件' },
  ];
  if (canRetry(target.status)) {
    items.push({ id: 'plugin.retry', label: '重试激活', icon: 'refresh' });
  }
  if (target.status === 'active') {
    items.push({ id: 'plugin.stop', label: '停用插件', icon: 'close', danger: true, dividerBefore: true });
  }
  items.push({ id: 'panel.refresh', label: '刷新列表', icon: 'refresh', dividerBefore: true });
  return items;
}

/** 面板空白处菜单（判据层，纯函数）：只有一条真能力——重读插件清单 */
export function buildPluginPanelMenu(): PluginContextMenuItem[] {
  return [{ id: 'panel.refresh', label: '刷新列表', icon: 'refresh', group: '面板' }];
}

/**
 * 分发一个选中的菜单 id。返回是否被本面消费（false = 不是本面的 id，宿主/测试可据此取证）。
 */
export function runPluginRowAction(
  id: string,
  target: PluginRowMenuTarget,
  host: PluginStatusMenuHost,
): boolean {
  switch (id) {
    case 'plugin.copyId':
      host.copy(target.id);
      return true;
    case 'plugin.retry':
      if (!canRetry(target.status)) return false;
      host.retry(target.id);
      return true;
    case 'plugin.stop':
      if (target.status !== 'active') return false;
      host.stop(target.id);
      return true;
    case 'panel.refresh':
      host.refresh();
      return true;
    default:
      return false;
  }
}

/** 接线层：把行菜单交给宿主（宿主缺席 ⇒ false，不抛错、不自造浮层） */
export function openPluginRowMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: PluginRowMenuTarget,
  host: PluginStatusMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildPluginRowMenu(target), PLUGIN_ROW_MENU_ARIA, (id) => {
    runPluginRowAction(id, target, host);
  });
}

/** 接线层：面板空白处的菜单 */
export function openPluginPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  host: PluginStatusMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildPluginPanelMenu(), PLUGIN_PANEL_MENU_ARIA, (id) => {
    if (id === 'panel.refresh') host.refresh();
  });
}

/** 「复制插件 ID」的落点封装：调用方把 false 变成一句人话（这里不吞掉失败） */
export function copyPluginId(id: string): Promise<boolean> {
  return copyTextToClipboard(id);
}
