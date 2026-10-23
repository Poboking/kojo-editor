/**
 * 插件面板的宿主级右键菜单（1023 覆盖面批 · WP5）。
 *
 * ## 一个面板上有两层右键，各管各的
 *
 * 1. **行级（面板自己出）**：插件在自己的行上直接调 `UIPanelProps.openContextMenu`，
 *    不经过根路由。同一面板里若还嵌着宿主面，靠注入的 `stopPropagation()` 让「最近一级获胜」
 *    （plugin-api 那一跳 `b03241db`）。
 * 2. **面板级（宿主出，本文件）**：用户右键面板的**空白处 / 容器边缘**，事件冒到根路由，
 *    命中 `plugin-panel` 面。这里给的是**宿主能力**——复制面板标识，不是面板的业务动作。
 *    业务动作归面板自己，宿主不替它猜。
 *
 * ## 为什么只有「复制」三项
 *
 * 铁律 4：宿主只承诺它**真能**做的事。插件面板的宿主持有 `id` / `title` / `pluginId` 三个
 * 事实，能做的就只有把它们交到剪贴板（用户拿去反馈、搜日志、报 bug）。
 * 没有「刷新面板」——`hostVersion` 是宿主桥接态的变化闸（见 `PanelBodyProps` 的注释），
 * 不是重挂开关；造一个点了不动的假刷新比没有更坏。
 *
 * ## 回执
 *
 * 这一面**没有回执通道**：宿主级菜单在根路由里是纯函数，拿不到 `NotificationCenter`，也
 * 没有页面那套 `note()` 桥。复制的结果用户能立刻验证（粘贴即见），所以不做假回执；
 * 写入失败只记 `console.warn`，不吞掉。
 */
import type { ContextMenuItem } from './context-menu-model';
import { declareContextSurface } from './context-surfaces';

export const PLUGIN_PANEL_ID_ATTR = 'data-plugin-panel-id';
export const PLUGIN_PANEL_TITLE_ATTR = 'data-plugin-panel-title';
/** 插件 id（内核注册时注入的 `pluginId`）——与面板 id 不是一回事，反馈时要的是它 */
export const PLUGIN_PANEL_PLUGIN_ATTR = 'data-plugin-panel-plugin';

export const PLUGIN_PANEL_ACTION = {
  copyPanelTitle: 'pluginPanel.copyTitle',
  copyPanelId: 'pluginPanel.copyId',
  copyPluginId: 'pluginPanel.copyPluginId',
} as const;

export interface PluginPanelFacts {
  /** 面板 id（贡献的 `id`） */
  readonly panelId: string;
  /** 面板名（贡献的 `title`，中文） */
  readonly panelTitle: string;
  /** 插件 id（贡献的 `pluginId`） */
  readonly pluginId: string;
}

/** 从 DOM 认人：多实例安全（菜单只认属性，不认组件闭包） */
export function pluginPanelFactsOf(target: HTMLElement | null): PluginPanelFacts | null {
  if (target === null) return null;
  const root = target.closest<HTMLElement>(`[${PLUGIN_PANEL_ID_ATTR}]`);
  if (root === null) return null;
  const panelId = root.getAttribute(PLUGIN_PANEL_ID_ATTR);
  if (panelId === null || panelId.length === 0) return null;
  const panelTitle = root.getAttribute(PLUGIN_PANEL_TITLE_ATTR);
  const pluginId = root.getAttribute(PLUGIN_PANEL_PLUGIN_ATTR);
  return {
    panelId,
    panelTitle: panelTitle !== null && panelTitle.length > 0 ? panelTitle : panelId,
    pluginId: pluginId !== null && pluginId.length > 0 ? pluginId : panelId,
  };
}

/**
 * 剪贴板是否可写（非安全上下文 / 权限被拒 / 老 WebView 都可能没有）。
 * 不可写 ⇒ 复制类**整项不显示**（铁律 4 的前半：能力不存在就不摆入口）。
 */
export function canCopyText(): boolean {
  if (typeof navigator === 'undefined') return false;
  const clipboard = navigator.clipboard as { writeText?: unknown } | undefined;
  return clipboard !== undefined && typeof clipboard.writeText === 'function';
}

export function buildPluginPanelMenu(
  facts: PluginPanelFacts | null,
  canCopy = canCopyText(),
): readonly ContextMenuItem[] {
  if (facts === null) return [];
  if (!canCopy) return [];
  return [
    { id: PLUGIN_PANEL_ACTION.copyPanelTitle, label: '复制面板名', icon: 'copy' },
    { id: PLUGIN_PANEL_ACTION.copyPanelId, label: '复制面板 ID', icon: 'copy' },
    { id: PLUGIN_PANEL_ACTION.copyPluginId, label: '复制插件 ID', icon: 'copy' },
  ];
}

/** 选中后的落地。返回是否真的写了剪贴板（测试与回执判据都用它） */
export async function runPluginPanelAction(
  id: string,
  facts: PluginPanelFacts | null,
): Promise<boolean> {
  if (facts === null) return false;
  const text =
    id === PLUGIN_PANEL_ACTION.copyPanelTitle
      ? facts.panelTitle
      : id === PLUGIN_PANEL_ACTION.copyPanelId
        ? facts.panelId
        : id === PLUGIN_PANEL_ACTION.copyPluginId
          ? facts.pluginId
          : null;
  if (text === null) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error: unknown) {
    console.warn(`[右键菜单] 复制「${text}」失败（剪贴板不可写）：`, error);
    return false;
  }
}

declareContextSurface({
  id: 'plugin-panel',
  ariaLabel: '插件面板菜单',
  area: 'plugin',
  build: (ctx) => {
    const facts = pluginPanelFactsOf(ctx.target);
    const items = buildPluginPanelMenu(facts);
    if (items.length === 0) return null;
    return {
      items,
      onSelect: (actionId) => {
        void runPluginPanelAction(actionId, facts);
      },
    };
  },
});
