/**
 * 插件右键菜单的**宿主桥接层**（1023 批 · 右键覆盖面 WP5.1）。
 *
 * 职责只有三件，且都必须是纯的（可 node 侧直测）：
 * 1. 把插件的 `PluginContextMenuRequest`（`@kojo/plugin-api`，与宿主模型同形）**透传**成
 *    根宿主的 `openContextMenu` 请求——坐标、动作回调都原样走，不做业务翻译；
 * 2. 中文化闸：label 不含 CJK 的项**整项丢弃**（子菜单全被丢光时父项一并丢），
 *    并按来源告警一次——插件不是宿主，用户可见文案的最后一道闸必须在这里也过一遍，
 *    而不能指望 11 个插件都记得（本批它们记得，下一批未必）；
 * 3. 过滤后为空 ⇒ **不开菜单**（不弹空壳）：插件的这一级「没话说」就等于没按到。
 *
 * 为什么桥接层住在 app 而不是 plugin-api：根宿主 `openContextMenu` 是 app 的模块级
 * store，plugin-api 不许依赖任何运行时。插件只认识 `UIPanelProps.openContextMenu` 这一个
 * 函数形状，谁实现它由宿主决定——注入点见 `PanelHost.tsx`。
 */
import type { PluginContextMenuItem, PluginContextMenuRequest } from '@kojo/plugin-api';
import { isChineseMenuLabel, type ContextMenuItem } from './context-menu-model';
import { openContextMenu } from './context-menu-host';

/** 已告警过的来源（同一来源只说一次：丢弃是设计行为，刷屏反而没人看） */
const warnedSources = new Set<string>();

/** 桥接层在取不到来源时的兜底名（诊断用，不上屏） */
const FALLBACK_SOURCE = 'plugin';

/** 菜单项转换的递归步：只搬字段，不做业务判定 */
function toItem(item: PluginContextMenuItem): ContextMenuItem {
  const converted: ContextMenuItem = {
    id: item.id,
    label: item.label,
    ...(item.icon === undefined ? {} : { icon: item.icon }),
    ...(item.shortcut === undefined ? {} : { shortcut: item.shortcut }),
    ...(item.danger === undefined ? {} : { danger: item.danger }),
    ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
    ...(item.disabledReason === undefined ? {} : { disabledReason: item.disabledReason }),
    ...(item.checked === undefined ? {} : { checked: item.checked }),
    ...(item.dividerBefore === undefined ? {} : { dividerBefore: item.dividerBefore }),
    ...(item.group === undefined ? {} : { group: item.group }),
    ...(item.children === undefined ? {} : { children: item.children.map(toItem) }),
  };
  return converted;
}

/**
 * 中文化过滤（纯函数）：返回留下的项与被丢的 label。
 *
 * 与宿主 `filterChineseMenuItems` 同一判据（`isChineseMenuLabel`），但**不共享**告警态：
 * 这里有「来源」，告警能指名道姓；宿主那一层是最后一站，措辞只能是泛指的。
 */
export function filterPluginMenuItems(items: readonly PluginContextMenuItem[]): {
  readonly items: ContextMenuItem[];
  readonly dropped: readonly string[];
} {
  const dropped: string[] = [];
  const kept = filterInto(items, dropped);
  return { items: kept, dropped };
}

function filterInto(items: readonly PluginContextMenuItem[], dropped: string[]): ContextMenuItem[] {
  const kept: ContextMenuItem[] = [];
  for (const item of items) {
    if (!isChineseMenuLabel(item.label)) {
      dropped.push(item.label);
      continue;
    }
    if (item.children === undefined) {
      kept.push(toItem(item));
      continue;
    }
    const children = filterInto(item.children, dropped);
    if (children.length === 0) {
      // 子菜单整段被丢 ⇒ 父项留下只会点出一个空菜单
      dropped.push(item.label);
      continue;
    }
    kept.push({ ...toItem(item), children });
  }
  return kept;
}

/** 坐标必须是有限数（`NaN` / 无穷 ⇒ 宿主会把菜单画到不可预期的地方） */
function validPoint(request: PluginContextMenuRequest): boolean {
  return Number.isFinite(request.x) && Number.isFinite(request.y);
}

/**
 * 插件请求 → 根宿主（唯一入口）。
 *
 * 返回是否真的开了菜单（false = 形状不合法 / 全被中文化闸丢弃 / 没有动作回调）——
 * 测试与插件调试都用这一个返回值取证，不靠读宿主状态。
 */
export function openPluginContextMenu(
  request: PluginContextMenuRequest,
  source: string = FALLBACK_SOURCE,
): boolean {
  if (request === null || typeof request !== 'object') return false;
  if (typeof request.onSelect !== 'function') return false;
  if (!validPoint(request)) return false;
  if (!Array.isArray(request.items) || request.items.length === 0) return false;
  const { items, dropped } = filterPluginMenuItems(request.items);
  if (dropped.length > 0 && !warnedSources.has(source)) {
    warnedSources.add(source);
    console.warn(
      `[右键菜单] 插件「${source}」提交了 ${dropped.length} 个非中文菜单项，已丢弃（首个：${dropped[0] ?? ''}）——用户可见文案必须全中文`,
    );
  }
  if (items.length === 0) return false;
  openContextMenu({
    x: request.x,
    y: request.y,
    items,
    ariaLabel: isChineseMenuLabel(request.ariaLabel) ? request.ariaLabel : '插件菜单',
    onSelect: (id) => {
      request.onSelect(id);
    },
    source,
  });
  return true;
}

/**
 * 造一个绑定来源的菜单通道（`UIPanelProps.openContextMenu` 的实现）。
 *
 * 引用**恒稳定**（同一来源复用同一函数）：面板若把它塞进 `useEffect` / `useMemo` 的
 * 依赖数组，不会因为宿主每帧重渲而反复重订阅。
 */
const bridges = new Map<string, (request: PluginContextMenuRequest) => void>();

export function createPluginContextMenuBridge(
  source: string,
): (request: PluginContextMenuRequest) => void {
  const existing = bridges.get(source);
  if (existing !== undefined) return existing;
  const bridge = (request: PluginContextMenuRequest): void => {
    openPluginContextMenu(request, source);
  };
  bridges.set(source, bridge);
  return bridge;
}

/** 测试用：清掉告警态与已造桥（模块级缓存不该跨用例泄漏） */
export function resetPluginContextMenuBridge(): void {
  warnedSources.clear();
  bridges.clear();
}
