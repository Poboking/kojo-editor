/**
 * 插件面板的「界面面登记」入口（1023 批 · 右键覆盖面 WP5.4：市场面）。
 *
 * ## 为什么登记口在契约包
 *
 * 界面的面注册表住在宿主（`app/src/ui/context-surfaces.ts`），而插件按解耦铁律只能依赖
 * `@kojo/plugin-api`——插件 import 宿主模块会把「插件可独立分发」这条约束直接打穿。
 * 所以走这一层：插件在自己的**模块顶层**声明面（纯数据 + build 判据），宿主路由在本地
 * 注册表未命中时来问这一份（接线见宿主 `context-surfaces.ts` 的插件面分支）。
 *
 * ## 三条口径（与宿主注册表逐条对齐）
 *
 * 1. **声明是幂等的**：同 id 覆盖并告警（热重载友好，也把「两处声明同一面」照出来）；
 * 2. **`build` 返回对象形态** `{ items, onSelect }` 才会分发动作；数组形态只展示。
 *    插件面板里"安装 / 卸载"这类动作必须走对象形态，否则就是空壳；
 * 3. **`null` / 空数组 = 这一级不表态**：宿主继续问下一级（输入框面 → 兜底），
 *    而不是弹一个空菜单。
 *
 * 类型刻意保持结构最小：插件侧 tsconfig 无 DOM lib，`target` 只声明用到的
 * `closest` / `getAttribute`（宿主传真实的 `HTMLElement`，天然满足）。
 */
import type { PluginContextMenuItem } from './context-menu';

/** 面的归属分区（与宿主清单同一套取值） */
export type PluginContextSurfaceArea =
  | 'editor'
  | 'explorer'
  | 'panel'
  | 'chrome'
  | 'plugin'
  | 'host';

/**
 * 右键命中的元素（结构类型）。
 *
 * 行级判据的常规做法：根上写 `data-<面>-kind` / `data-<面>-key`，这里 `closest` 找到行，
 * 再 `getAttribute` 读行数据——菜单的判据因此不依赖 React 状态（宿主路由是纯 DOM 入口）。
 */
export interface PluginContextSurfaceTarget {
  closest?(selector: string): PluginContextSurfaceTarget | null;
  getAttribute?(name: string): string | null;
}

/** 面构建的输入 */
export interface PluginContextSurfaceBuildContext {
  /** 面 id（= 根元素上的 `data-context-surface`） */
  readonly id: string;
  /** 右键命中的原始元素（可能比面根深很多层；面自行 `closest`） */
  readonly target: PluginContextSurfaceTarget;
}

/** 面的菜单（`onSelect` 缺省 = 只展示、选中不做事） */
export interface PluginContextSurfaceMenu {
  readonly items: readonly PluginContextMenuItem[];
  readonly onSelect?: (id: string) => void;
  /** 覆盖声明里的无障碍名（同一面在不同情境下措辞不同时才给） */
  readonly ariaLabel?: string;
}

/** `build` 的返回：数组（最简形态）· 完整菜单对象 · `null`（不表态） */
export type PluginContextSurfaceBuildResult =
  | readonly PluginContextMenuItem[]
  | PluginContextSurfaceMenu
  | null;

/** 一条面声明 */
export interface PluginContextSurfaceSpec {
  readonly id: string;
  readonly ariaLabel: string;
  readonly area: PluginContextSurfaceArea;
  build?(ctx: PluginContextSurfaceBuildContext): PluginContextSurfaceBuildResult;
}

/** 已声明的面（id 唯一；重复声明覆盖） */
const registry = new Map<string, PluginContextSurfaceSpec>();

/**
 * 声明一个插件面（插件模块顶层调用，幂等）。
 *
 * 清单校验在宿主侧（`CONTEXT_SURFACE_MANIFEST` 是宿主的权威清单）：这里只管登记，
 * 不复制一份清单——两份清单必然漂移。
 */
export function declarePluginContextSurface(spec: PluginContextSurfaceSpec): void {
  if (registry.has(spec.id)) {
    console.warn(`[右键菜单] 插件面 '${spec.id}' 被重复声明（后者覆盖前者）`);
  }
  registry.set(spec.id, spec);
}

/** 取一个插件面（未声明 / 无 build ⇒ 宿主走兜底） */
export function getPluginContextSurface(id: string): PluginContextSurfaceSpec | undefined {
  return registry.get(id);
}

/** 已声明的插件面（测试与宿主巡检用） */
export function listPluginContextSurfaces(): readonly PluginContextSurfaceSpec[] {
  return [...registry.values()];
}

/** 测试用：清空登记（模块级缓存不该跨用例泄漏） */
export function resetPluginContextSurfaces(): void {
  registry.clear();
}
