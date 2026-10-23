/**
 * 界面面注册表（1023 批 · 右键菜单覆盖面）。
 *
 * ## 约定（13 个并行面照这个来）
 *
 * 1. **根元素带 `data-context-surface="<id>"`**：右键落在它内部任意位置，根路由就把菜单
 *    交给这个面（`closest` 命中**最近的**那个，嵌套面天然由内层接管）；
 * 2. **模块顶层调用 `declareContextSurface({ id, ariaLabel, build })`**：模块被加载即登记，
 *    不需任何生命周期协作；重复声明同 id 会覆盖并告警（幂等，热重载友好）；
 * 3. **可以先只声明元数据**（不写 `build`）：此时该面走兜底菜单——13 路并行时先接线后补面，
 *    不会出现「声明了却弹不出菜单」的黑洞；
 * 4. `id` 必须在 `CONTEXT_SURFACE_MANIFEST` 里（清单是权威：id 与无障碍名的唯一真源，
 *    这样「有哪些面」不靠全仓 grep 回答）；清单外的新面请先来这里登记。
 *
 * ## 三级策略（根路由 `buildContextMenuRoute`）
 *
 * 1. **输入类面（优先）**：目标是 input / textarea / contenteditable ⇒ `input` 面（WP0 自带）。
 *    它排在最前面是刻意的：剪切/复制/粘贴/撤销重做是通用编辑语义，不是某个布局的私有面，
 *    不能被容器面（浮窗/面板/对话框）截走——右键输入框却弹出「关闭窗口」是错的行为；
 * 2. 显式面：从 `closest('[data-context-surface]')` 命中的**最近**面开始，该面有 `build`
 *    且表态 ⇒ 面的专属菜单；该面**不表态** ⇒ **继续往外层面上溯**（同一个 id 只问一次），
 *    直到没有外层声明面为止；
 * 3. 兜底：`buildFallbackMenu`（通用菜单，只放通用动作）。
 *
 * 前面一级返回**空菜单**（`null` / 空数组）时视为「这一级不表态」，继续往下一级走
 * ——「按不了」与「没话说」必须分开：面没话说就走兜底，而不是给用户一个空壳。
 *
 * **为什么第 2 级要上溯而不是直接落兜底**：面注册表本来就是按嵌套设计的（编辑器组套编辑区、
 * 浮窗套面板、对话框套页面）。内层面对某个局部「没话说」是很正常的（例如只在有选中文本时
 * 才出「复制所选」），此时用户期望的是**外层的组级菜单**，而不是被降级成通用菜单；
 * 直接落兜底等于把嵌套声明的意义废掉。
 */
import {
  FALLBACK_MENU_ARIA_LABEL,
  buildFallbackMenu,
  isTextInputTarget,
  runFallbackMenuAction,
  type ContextMenuItem,
} from './context-menu-model';

/** 面的归属分区（只用于清单可读性与分组巡检，不参与路由判定） */
export type ContextSurfaceArea = 'editor' | 'explorer' | 'panel' | 'chrome' | 'plugin' | 'host';

/** 清单条目：id / 无障碍名 / 分区（权威清单，新增面必须先在这里登记） */
export interface ContextSurfaceManifestEntry {
  readonly id: string;
  readonly ariaLabel: string;
  readonly area: ContextSurfaceArea;
}

/**
 * 全部界面面（权威清单）。
 *
 * 分区与认领：`editor` = 编辑区（WP1）、`explorer` = 文件树与标签页（WP2）、
 * `panel` = 底部/侧栏面板与浮窗（WP3）、`chrome` = 壳层与设置类页面（WP4）、
 * `plugin` = 插件面板（WP5）、`host` = 宿主地基（WP0）。
 */
export const CONTEXT_SURFACE_MANIFEST: readonly ContextSurfaceManifestEntry[] = [
  // ---- 编辑区 ----
  { id: 'editor', ariaLabel: '编辑器菜单', area: 'editor' },
  { id: 'sugar-preview', ariaLabel: '预览菜单', area: 'editor' },
  // ---- 文件树与标签页 ----
  { id: 'file-tree', ariaLabel: '文件树菜单', area: 'explorer' },
  { id: 'file-tree-root', ariaLabel: '文件树根菜单', area: 'explorer' },
  { id: 'tabs', ariaLabel: '标签页菜单', area: 'explorer' },
  { id: 'tab-bar-blank', ariaLabel: '标签栏菜单', area: 'explorer' },
  { id: 'editor-group-header', ariaLabel: '编辑器组菜单', area: 'explorer' },
  { id: 'breadcrumb', ariaLabel: '面包屑菜单', area: 'explorer' },
  { id: 'quick-open', ariaLabel: '快速打开菜单', area: 'explorer' },
  // ---- 面板与浮窗 ----
  { id: 'search-results', ariaLabel: '搜索结果菜单', area: 'panel' },
  { id: 'problems', ariaLabel: '问题面板菜单', area: 'panel' },
  // 这里**没有** `outline`：本仓库不存在大纲面板。`language-capabilities.ts` 里的 `Outline`
  // 只是语言能力枚举，`document-symbols.ts` 是符号提供者，都没有对应的面板视图（口上导航是
  // `ui-kojo-navigator` 的面列表，不是大纲）。按铁律 4「能力不存在 ⇒ 整项不显示」——登记一个
  // 永远没有宿主的面等于在清单里伪造能力，契约测试也会被迫为它开豁免。将来真有大纲面板时
  // 回来加这一行并挂面属性即可。
  { id: 'call-hierarchy', ariaLabel: '调用层级菜单', area: 'panel' },
  { id: 'file-history', ariaLabel: '文件历史菜单', area: 'panel' },
  { id: 'ops-history', ariaLabel: '操作历史菜单', area: 'panel' },
  { id: 'diff-view', ariaLabel: '差异视图菜单', area: 'panel' },
  { id: 'panel-tabs', ariaLabel: '面板选项卡菜单', area: 'panel' },
  { id: 'panel-section-header', ariaLabel: '面板分区菜单', area: 'panel' },
  { id: 'floating-window', ariaLabel: '浮动窗菜单', area: 'panel' },
  { id: 'notification', ariaLabel: '通知菜单', area: 'panel' },
  // ---- 壳层与设置类页面 ----
  { id: 'activity-bar', ariaLabel: '活动栏菜单', area: 'chrome' },
  { id: 'toolbar', ariaLabel: '工具栏菜单', area: 'chrome' },
  { id: 'status-bar', ariaLabel: '状态栏菜单', area: 'chrome' },
  { id: 'welcome', ariaLabel: '欢迎页菜单', area: 'chrome' },
  { id: 'welcome-recent', ariaLabel: '最近项目菜单', area: 'chrome' },
  { id: 'settings', ariaLabel: '设置菜单', area: 'chrome' },
  { id: 'keybindings', ariaLabel: '快捷键菜单', area: 'chrome' },
  // 这里**没有** `market`：市场不是 app 的页面，是插件 `ui-market` 提供的面板。
  // 它的右键走插件通道（`UIPanelProps.openContextMenu`，见 `ui-market/src/context-menu.ts`），
  // 不经过界面面注册表；面板空白处则由 `plugin-panel` 面统一接管。登记 `market` 会得到
  // 一个永远没有宿主的空面——同 `outline` 的理由。
  { id: 'tutorial', ariaLabel: '教程菜单', area: 'chrome' },
  { id: 'palette', ariaLabel: '命令面板菜单', area: 'chrome' },
  // ---- 插件面板 ----
  { id: 'plugin-panel', ariaLabel: '插件面板菜单', area: 'plugin' },
  // ---- 宿主地基 ----
  { id: 'app-fallback', ariaLabel: '通用菜单', area: 'host' },
  { id: 'input', ariaLabel: '输入框菜单', area: 'host' },
];

const MANIFEST_IDS = new Set(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id));

/** 面的构建上下文（面据此判断「刚才点的是哪一行 / 哪个元素」） */
export interface ContextSurfaceBuildContext {
  /** 面 id（= 根元素上的 `data-context-surface`） */
  readonly id: string;
  /** 右键命中的原始元素（可能比面根元素深很多层；面自行 `closest`） */
  readonly target: HTMLElement;
  /** 原始事件（坐标、修饰键、`preventDefault` 过的都还在） */
  readonly event: MouseEvent;
}

/** 面的菜单（`onSelect` 省略时 = 面没有动作，只展示） */
export interface ContextSurfaceMenu {
  readonly items: readonly ContextMenuItem[];
  /** 该面的动作分发（缺省 = 选中不做事；兜底面不适用） */
  readonly onSelect?: (id: string) => void;
  /** 覆盖清单里的无障碍名（同一面在不同情境下措辞不同时才给） */
  readonly ariaLabel?: string;
}

/**
 * `build` 的返回：数组（最简形态，动作走公共分发）或完整的菜单对象；
 * `null` / 空数组 = 这一级不表态（继续往兜底走）。
 */
export type ContextSurfaceBuildResult =
  | readonly ContextMenuItem[]
  | ContextSurfaceMenu
  | null;

export interface ContextSurfaceSpec extends ContextSurfaceManifestEntry {
  readonly build?: (ctx: ContextSurfaceBuildContext) => ContextSurfaceBuildResult;
}

/** 已声明的面（id 唯一；重复声明覆盖） */
const registry = new Map<string, ContextSurfaceSpec>();

/**
 * 声明一个界面面（各 UI 模块**模块顶层**调用，幂等）。
 *
 * - 重复 id：覆盖并 `console.warn`（热重载与「同 id 两处声明」都要看得见）；
 * - 清单外 id：照样登记（不因登记就炸掉界面）但告警——`context-surfaces.test.ts` 钉住
 *   「已声明 ⊆ 清单」，漏登记会在门槛上红。
 */
export function declareContextSurface(spec: ContextSurfaceSpec): void {
  if (!MANIFEST_IDS.has(spec.id)) {
    console.warn(
      `[右键菜单] 面 '${spec.id}' 不在 CONTEXT_SURFACE_MANIFEST 清单里——请先在清单登记（ariaLabel=${spec.ariaLabel}）`,
    );
  }
  if (registry.has(spec.id)) {
    console.warn(`[右键菜单] 面 '${spec.id}' 被重复声明（后者覆盖前者）`);
  }
  registry.set(spec.id, spec);
}

/** 取一个面（未声明 / 无 build ⇒ 调用方走兜底） */
export function getContextSurface(id: string): ContextSurfaceSpec | undefined {
  return registry.get(id);
}

/** 已声明的面（测试遍历用；顺序 = 声明顺序） */
export function listContextSurfaces(): readonly ContextSurfaceSpec[] {
  return [...registry.values()];
}

/** 根路由的产物（App 只负责把它交给 `openContextMenu`） */
export interface ContextMenuRoute {
  readonly items: readonly ContextMenuItem[];
  readonly ariaLabel: string;
  readonly onSelect: (id: string) => void;
  /** 命中哪一级（`app-fallback` = 兜底；调试与测试用） */
  readonly source: string;
}

/** 数组形态（最简形态）与对象形态的判别（`isMenuObject` 的类型守卫本体） */
function isMenuObject(result: ContextSurfaceBuildResult): result is ContextSurfaceMenu {
  return result !== null && !Array.isArray(result);
}

function normalizeSurfaceMenu(
  result: ContextSurfaceBuildResult,
  spec: ContextSurfaceSpec,
): ContextSurfaceMenu | null {
  if (result === null) return null;
  const menu: ContextSurfaceMenu = isMenuObject(result) ? result : { items: result };
  if (menu.items.length === 0) return null;
  return {
    items: menu.items,
    ...(menu.onSelect === undefined ? {} : { onSelect: menu.onSelect }),
    ariaLabel: menu.ariaLabel ?? spec.ariaLabel,
  };
}

function trySurface(
  spec: ContextSurfaceSpec | undefined,
  target: HTMLElement,
  event: MouseEvent,
): ContextMenuRoute | null {
  if (spec?.build === undefined) return null;
  let result: ContextSurfaceBuildResult;
  try {
    result = spec.build({ id: spec.id, target, event });
  } catch (error: unknown) {
    // 13 个面并行补菜单：某一个面构建抛错不该让全站右键失灵——记一笔，回落到下一级
    console.warn(`[右键菜单] 面 '${spec.id}' 的菜单构建抛错（已回落到下一级）：`, error);
    return null;
  }
  const menu = normalizeSurfaceMenu(result, spec);
  if (menu === null) return null;
  return {
    items: menu.items,
    ariaLabel: menu.ariaLabel ?? spec.ariaLabel,
    onSelect: menu.onSelect ?? (() => undefined),
    source: spec.id,
  };
}

/**
 * 三级策略落地（根路由的唯一判据）：给定被右击的元素与原始事件，算出该开哪个菜单。
 *
 * 返回 `null` = 什么都不开（如兜底也为空——极端情况，正常不会发生）。
 * 调用方仍需自行 `preventDefault`：**阻断 WebView2 默认菜单与「开不开我们的菜单」是两件事**。
 */
export function buildContextMenuRoute(
  target: HTMLElement,
  event: MouseEvent,
): ContextMenuRoute | null {
  // 一级：输入类面**优先于一切容器面**——输入框里的剪切/复制/粘贴/撤销重做是通用编辑语义，
  // 不能被容器面（浮窗/面板/对话框/设置页）截走：右键输入框却弹出「关闭窗口」是错的行为。
  // 各面若想在输入框上给专属动作，靠 `input` 面自己的 build 分支去做，别在外层抢。
  if (isTextInputTarget(target)) {
    const input = trySurface(registry.get('input'), target, event);
    if (input !== null) return input;
  }
  // 二级：显式声明的面——从最近祖先往外逐级上溯（内层不表态时才问外层）
  const asked = new Set<string>();
  let surfaceRoot = target.closest<HTMLElement>('[data-context-surface]');
  while (surfaceRoot !== null) {
    const surfaceId = surfaceRoot.getAttribute('data-context-surface');
    if (surfaceId !== null && !asked.has(surfaceId)) {
      asked.add(surfaceId);
      const explicit = trySurface(registry.get(surfaceId), target, event);
      if (explicit !== null) return explicit;
    }
    const parent = surfaceRoot.parentElement;
    surfaceRoot = parent === null ? null : parent.closest<HTMLElement>('[data-context-surface]');
  }
  // 三级：兜底（只放通用动作，业务动作归各面）
  const items = buildFallbackMenu(target);
  if (items.length === 0) return null;
  return {
    items,
    ariaLabel: FALLBACK_MENU_ARIA_LABEL,
    onSelect: (id) => {
      runFallbackMenuAction(id, target);
    },
    source: 'app-fallback',
  };
}

/**
 * 输入类面（WP0 自带）：输入框的剪切/复制/粘贴与撤销重做不归各布局自管，
 * 全局一套即可；它就是兜底菜单的输入分支，单独声明是为了让 `input` 面可被后面的面覆盖。
 */
declareContextSurface({
  id: 'input',
  ariaLabel: '输入框菜单',
  area: 'host',
  build: (ctx) =>
    isTextInputTarget(ctx.target)
      ? {
          items: buildFallbackMenu(ctx.target),
          // 动作必须接到兜底分发上：剪切/复制/粘贴不是命令，没有这条接线就是空壳
          onSelect: (id) => {
            runFallbackMenuAction(id, ctx.target);
          },
        }
      : null,
});

/**
 * 兜底面（WP0 自带）：`App.tsx` 根元素挂 `data-context-surface="app-fallback"`，让"没有任何面
 * 认领"的右键落在一个**显式登记的**面上，而不是依赖"这个 id 查不到 spec"这种偶然状态。
 *
 * 它给出的项与三级兜底完全同源（同一个 `buildFallbackMenu`）、分发也接同一个
 * `runFallbackMenuAction`——**声明它不改变任何动作**，只是把既有行为写明，好让
 * 「清单里的每个面都有 spec」成立（WP6 契约测试可以硬断言，不必为它开豁免）。
 */
declareContextSurface({
  id: 'app-fallback',
  ariaLabel: FALLBACK_MENU_ARIA_LABEL,
  area: 'host',
  build: (ctx) => ({
    items: buildFallbackMenu(ctx.target),
    onSelect: (id) => {
      runFallbackMenuAction(id, ctx.target);
    },
  }),
});
