import type { PanelLocation, UIPanelContribution } from '@kojo/plugin-api';

/**
 * 三容器拖拽停靠的判定逻辑（零 React，2026-10-12 P4 补测批抽出）。
 *
 * 组件里只留「事件 → 意图 → dispatch」的搬运；能不能落、落下来搬哪些面板、高亮
 * 什么时候该清，全部是这里的纯函数。拖拽的坑恰恰在这些判据上：外部拖入不能误触发、
 * 子元素间反复 dragleave 不该闪断高亮、载荷里的幽灵面板 id 不该搬出一个空容器。
 */

/** 拖拽停靠的自定义 MIME：只在壳层内部流转，防外部拖入误触发 */
export const PANEL_DRAG_MIME = 'application/x-kojo-panel-move';

/** 落点意图：一次 drop 里每个面板各一条（激活单位随目标容器而变） */
export interface PanelMoveIntent {
  readonly id: string;
  readonly to: PanelLocation;
  /** sidebar 的激活单位是视图 key（`group:<名>` / `panel:<id>`），aux/bottom 用面板 id */
  readonly viewKey: string;
}

/** 落点是否接受这次拖拽——只认自家 MIME */
export function acceptsPanelDrop(dataTransferTypes: readonly string[]): boolean {
  return dataTransferTypes.includes(PANEL_DRAG_MIME);
}

/**
 * 解出被拖面板 id 列表。
 *
 * 载荷是本壳自己写的 JSON，但它驱动的是布局改动 ⇒ 坏 JSON / 非数组 / 非字符串元素
 * 一律剔除：绝不抛错，也绝不搬「幽灵面板」。
 */
export function decodeDroppedPanelIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * 把「被拖的 id 集合」换算成落到 `to` 容器的逐面板意图。
 *
 * 活动栏图标拖拽带出的是**整组**面板，所以意图恒为逐面板（一次 drop 可产生多条）。
 * 当前贡献集合里查不到的 id 直接跳过——不认识的 id 没有归属声明，硬搬等于造空容器。
 */
export function planPanelMoves(
  ids: readonly string[],
  panels: readonly Pick<UIPanelContribution, 'id' | 'group'>[],
  to: PanelLocation,
): PanelMoveIntent[] {
  const out: PanelMoveIntent[] = [];
  for (const id of ids) {
    const panel = panels.find((p) => p.id === id);
    if (!panel) continue;
    out.push({ id, to, viewKey: panel.group ? `group:${panel.group}` : `panel:${panel.id}` });
  }
  return out;
}

/** 落点高亮的四种事件（dragover 置位，drop / dragend / 真正离开清位） */
export type DropTargetEvent =
  | { readonly type: 'dragover'; readonly container: PanelLocation }
  | { readonly type: 'dragleave'; readonly container: PanelLocation; readonly stillInside: boolean }
  | { readonly type: 'dropped' }
  | { readonly type: 'dragend' };

/**
 * 下一个高亮目标。
 *
 * `dragleave` 两条豁免：`stillInside`（容器内子元素间移动会反复触发 leave，闪断即噪声）、
 * 以及「清位只清自己这个容器的高亮」——并发拖拽时别的容器发来的 leave 不能把当前落点抹掉。
 */
export function nextDropTarget(current: PanelLocation | null, event: DropTargetEvent): PanelLocation | null {
  switch (event.type) {
    case 'dragover':
      return event.container;
    case 'dragleave':
      return event.stillInside || current !== event.container ? current : null;
    case 'dropped':
    case 'dragend':
      return null;
  }
}
