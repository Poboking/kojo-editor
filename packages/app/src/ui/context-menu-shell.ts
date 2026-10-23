/**
 * 壳层七面的右键菜单（1023 覆盖面批 · WP3.7 / 3.8 / 4.1 / 4.2 / 4.3）。
 *
 * 覆盖：面板选项卡 / 面板分区头 / 浮窗 / 通知 / 活动栏 / 工具栏 / 状态栏。
 *
 * ## 为什么菜单数据住在这里，而不是各组件里
 *
 * 壳层（`ShellLayout.tsx` 2269 行）是并行批里最贵的冲突面：七个面各写一段 `build`
 * 就等于在同一个文件里叠七处闭包，任何一面改文案都要碰它。所以：
 *
 * - **纯函数 `build…Menu(input)`**：输入是一份能力快照（isFloating / isMaximized /
 *   canMove / canHide / hasAction），输出 `ContextMenuItem[]`——零 React、零 DOM，
 *   测试直接打纯函数（`tests/shell-menus.test.ts`）；
 * - **面声明 `declareContextSurface`**：模块顶层一次，`build` 只做两件事——从
 *   `ctx.target` 顺着 DOM 读出「刚才点的是哪个面板 / 哪条通知 / 哪颗工具条按钮」，
 *   再从宿主快照取能力，拼出菜单并接上 `onSelect`；
 * - **动作全部落在既有状态机**：面板浮动/停靠/移动走 `layout.ts` 的 `float` / `dock` /
 *   `move`，关容器走 `toggle`，重置走 `resetLayout()`；命令类项一律
 *   `menuItemFromCommand` + `runContextMenuCommand`（标题与键位不抄第二份）。
 *
 * ## 三条口径
 *
 * 1. **能力不存在 ⇒ 整项不显示**（不留一个永远灰着的入口）；
 *    **上下文暂不可用 ⇒ `disabled` + `disabledReason`**（如「这个面板已经在底部区」）。
 * 2. 「关闭」与「隐藏」不是同义词：面板选项卡的 `tabs.close` 是**收起整个面板区**
 *    （aux/bottom 的 ✕ 按钮同一个动作），活动栏的 `activity.hide` 是**隐藏当前视图**
 *    （sidebar 容器的显隐）——id 与文案都分开，谁也不冒充谁。
 * 3. 浮窗「最大化」= 铺满视口（`moveFloating` + `resizeFloating` 两个既有动作的组合），
 *    「还原」= 回到启动时的缺省几何（与 `floatPanel` 的初值同一条纯函数），
 *    所以最大化之后一定回得去，不需要再记一份「最大化前的矩形」。
 */
import {
  canRunContextMenuCommand,
  menuItemFromCommand,
  runContextMenuCommand,
  type ContextMenuItem,
} from './context-menu-model';
import {
  declareContextSurface,
  type ContextSurfaceBuildContext,
  type ContextSurfaceBuildResult,
} from './context-surfaces';

/* ------------------------------ 公共类型 ------------------------------ */

/** 三个停靠容器（与 `layout.ts` 的 `ContainerKey` 同集，此处不 import 布局模块以保持数据面零依赖） */
export type ShellContainerTarget = 'sidebar' | 'aux' | 'bottom';

/** 浮窗几何（与 `layout.ts` 的 `FloatingState` 同形） */
export interface ShellFloatRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ShellViewportRect {
  readonly w: number;
  readonly h: number;
}

/** 换行符两档（与 `EditorStatusReadout` 的读数同口径） */
export type ShellEol = 'LF' | 'CRLF';

/* ------------------------------ 浮窗几何（纯函数） ------------------------------ */

/** 浮窗初值：宽度取视口 52%（夹在 460–960），高度取 62%（夹在 320–680），多窗层叠错位 */
export function defaultFloatRect(index: number, viewport: ShellViewportRect): ShellFloatRect {
  const w = Math.min(960, Math.max(460, Math.round(viewport.w * 0.52)));
  const h = Math.min(680, Math.max(320, Math.round(viewport.h * 0.62)));
  const x = Math.max(16, Math.round((viewport.w - w) / 2) + index * 26);
  const y = Math.max(16, 64 + index * 26);
  return { x, y, w, h };
}

/** 最大化矩形：贴住视口左上角并铺满（不留边——浮窗最大化就是「占满整窗」） */
export function maximizedFloatRect(viewport: ShellViewportRect): ShellFloatRect {
  return { x: 0, y: 0, w: viewport.w, h: viewport.h };
}

/**
 * 当前几何是不是「最大化」。
 *
 * 只认铺满这一种形态：用户手动拖到同样大小的窗口算最大化（尺寸到了就是到了），
 * 但尺寸不到就一律不是——否则「还原」会在一个半大的窗口上凭空跳一下。
 */
export function isFloatMaximized(rect: ShellFloatRect, viewport: ShellViewportRect): boolean {
  return rect.x <= 0 && rect.y <= 0 && rect.w >= viewport.w - 1 && rect.h >= viewport.h - 1;
}

/* ------------------------------ 面板选项卡（WP3.7） ------------------------------ */

/** 面板选项卡菜单的动作 id（与文案一起钉在这里，测试直接引用） */
export const PANEL_TABS_ACTION = {
  FLOAT: 'tabs.float',
  DOCK: 'tabs.dock',
  MOVE_LEFT: 'tabs.move.left',
  MOVE_RIGHT: 'tabs.move.right',
  MOVE_BOTTOM: 'tabs.move.bottom',
  CLOSE: 'tabs.close',
} as const;

export interface PanelTabsMenuInput {
  /** 这个选项卡条属于哪个容器（决定「移动到底部区」是不是原地打转） */
  readonly container: 'aux' | 'bottom';
  readonly isFloating: boolean;
  /** 面板还在当前贡献集合里（幽灵 id 不许搬出一个空容器） */
  readonly canMove: boolean;
  /** 容器可以收起（aux/bottom 都有 ✕，这是同一个动作） */
  readonly canHide: boolean;
}

export function buildPanelTabsMenu(input: PanelTabsMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (input.isFloating) {
    items.push({ id: PANEL_TABS_ACTION.DOCK, label: '停靠回容器', icon: 'popout' });
  } else {
    items.push({ id: PANEL_TABS_ACTION.FLOAT, label: '浮动为浮窗', icon: 'popout' });
  }
  if (input.canMove) {
    const alreadyBottom = input.container === 'bottom';
    items.push(
      {
        id: PANEL_TABS_ACTION.MOVE_LEFT,
        label: '移动到左侧栏',
        icon: 'layout-sidebar-left',
        dividerBefore: true,
      },
      { id: PANEL_TABS_ACTION.MOVE_RIGHT, label: '移动到右侧栏', icon: 'layout-sidebar-right' },
      {
        id: PANEL_TABS_ACTION.MOVE_BOTTOM,
        label: '移动到底部区',
        icon: 'layout-panel-bottom',
        ...(alreadyBottom
          ? { disabled: true, disabledReason: '这个面板已经在底部区了' }
          : {}),
      },
    );
  }
  if (input.canHide) {
    items.push({
      id: PANEL_TABS_ACTION.CLOSE,
      label: '关闭面板区',
      icon: 'close',
      dividerBefore: true,
    });
  }
  const reset = menuItemFromCommand('layout.reset', { dividerBefore: true });
  if (reset !== null) items.push(reset);
  return items;
}

/* ------------------------------ 面板分区头 ------------------------------ */

export const PANEL_SECTION_ACTION = {
  COLLAPSE: 'section.collapse',
  EXPAND: 'section.expand',
} as const;

export interface PanelSectionMenuInput {
  readonly collapsed: boolean;
}

/**
 * 侧栏分区的头（多面板弹性分栏里那一排可折叠的标题）。
 *
 * **没有「隐藏分区」**：布局状态机只有「容器显隐」这一档（`sidebar.visible`），
 * 单个分区没有独立的显隐位；把「折叠」改叫「隐藏」等于骗人（折叠不丢内容、
 * 隐藏会）。要收起整列请用工具条/活动栏的侧栏开关——那里才是真的隐藏。
 */
export function buildPanelSectionMenu(input: PanelSectionMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    input.collapsed
      ? { id: PANEL_SECTION_ACTION.EXPAND, label: '展开分区', icon: 'chevron-down' }
      : { id: PANEL_SECTION_ACTION.COLLAPSE, label: '折叠分区', icon: 'chevron-right' },
  ];
  const reset = menuItemFromCommand('layout.reset', { dividerBefore: true });
  if (reset !== null) items.push(reset);
  return items;
}

/* ------------------------------ 浮窗 ------------------------------ */

export const FLOATING_ACTION = {
  CLOSE: 'float.close',
  DOCK_LEFT: 'float.dock.left',
  DOCK_RIGHT: 'float.dock.right',
  DOCK_BOTTOM: 'float.dock.bottom',
  MAXIMIZE: 'float.maximize',
  RESTORE: 'float.restore',
  RESET: 'float.reset',
} as const;

export interface FloatingWindowMenuInput {
  readonly isMaximized: boolean;
  /** 浮窗随时可以停靠回去（这是它自带的关闭按钮同一个动作） */
  readonly canHide: boolean;
}

export function buildFloatingWindowMenu(input: FloatingWindowMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (input.canHide) {
    items.push({ id: FLOATING_ACTION.CLOSE, label: '关闭浮窗（回到停靠区）', icon: 'close' });
  }
  items.push(
    { id: FLOATING_ACTION.DOCK_LEFT, label: '停靠到左侧栏', icon: 'layout-sidebar-left', dividerBefore: true },
    { id: FLOATING_ACTION.DOCK_RIGHT, label: '停靠到右侧栏', icon: 'layout-sidebar-right' },
    { id: FLOATING_ACTION.DOCK_BOTTOM, label: '停靠到底部区', icon: 'layout-panel-bottom' },
  );
  if (input.isMaximized) {
    items.push({ id: FLOATING_ACTION.RESTORE, label: '还原窗口尺寸', icon: 'restore', dividerBefore: true });
  } else {
    items.push({ id: FLOATING_ACTION.MAXIMIZE, label: '最大化浮窗', icon: 'maximize', dividerBefore: true });
  }
  items.push({ id: FLOATING_ACTION.RESET, label: '重置位置与尺寸', icon: 'reset' });
  return items;
}

/* ------------------------------ 通知（WP3.8） ------------------------------ */

export const NOTIFICATION_ACTION = {
  COPY: 'notice.copy',
  DISMISS: 'notice.dismiss',
  CLEAR_ALL: 'notice.clearAll',
  /** 通知自带的动作按序号分发（`notice.run.<index>`） */
  RUN_PREFIX: 'notice.run.',
} as const;

export interface NotificationMenuInput {
  /** 这条通知带动作（「去授权」「查看差异」…）——没动作就没有可执行的项 */
  readonly hasAction: boolean;
  readonly actionLabels: readonly string[];
  /** 屏上现有条数（只有一条时「清除全部」没有意义） */
  readonly total: number;
}

export function buildNotificationMenu(input: NotificationMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ id: NOTIFICATION_ACTION.COPY, label: '复制通知内容' }];
  if (input.hasAction) {
    const labels = input.actionLabels;
    if (labels.length === 1) {
      items.push({ id: `${NOTIFICATION_ACTION.RUN_PREFIX}0`, label: `执行「${labels[0] ?? ''}」` });
    } else if (labels.length > 1) {
      items.push({
        id: 'notice.run',
        label: '执行通知里的操作',
        children: labels.map((label, index) => ({
          id: `${NOTIFICATION_ACTION.RUN_PREFIX}${index}`,
          label: `执行「${label}」`,
        })),
      });
    }
  }
  items.push({ id: NOTIFICATION_ACTION.DISMISS, label: '清除这条通知', dividerBefore: true });
  items.push(
    input.total > 1
      ? { id: NOTIFICATION_ACTION.CLEAR_ALL, label: '清除全部通知' }
      : {
          id: NOTIFICATION_ACTION.CLEAR_ALL,
          label: '清除全部通知',
          disabled: true,
          disabledReason: '屏上只有这一条通知，用「清除这条通知」即可',
        },
  );
  return items;
}

/* ------------------------------ 活动栏（WP4.1） ------------------------------ */

export const ACTIVITY_BAR_ACTION = {
  SHOW: 'activity.show',
  HIDE: 'activity.hide',
  MOVE_AUX: 'activity.move.aux',
} as const;

export interface ActivityBarMenuInput {
  /** 这个视图当前就在侧栏上开着（点击菜单项之前的状态） */
  readonly active: boolean;
  /** 视图里的面板还在贡献集合里 */
  readonly canMove: boolean;
}

/**
 * 活动栏图标（= 侧栏视图）。
 *
 * 「显示/隐藏此视图」落到 `sidebar.visible`（与点击图标本身同一个动作）；
 * 「移到右侧栏」落到 `move`（与拖到副侧栏同一条意图）。**没有「移到左侧栏」**：
 * 活动栏视图的固有归属就是左侧栏，那条目只会永远灰着。
 */
export function buildActivityBarMenu(input: ActivityBarMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    input.active
      ? { id: ACTIVITY_BAR_ACTION.HIDE, label: '隐藏此视图', icon: 'layout-sidebar-left' }
      : { id: ACTIVITY_BAR_ACTION.SHOW, label: '显示此视图', icon: 'layout-sidebar-left' },
  ];
  if (input.canMove) {
    items.push({
      id: ACTIVITY_BAR_ACTION.MOVE_AUX,
      label: '移到右侧栏',
      icon: 'layout-sidebar-right',
      dividerBefore: true,
    });
  }
  const reset = menuItemFromCommand('layout.reset', { dividerBefore: true });
  if (reset !== null) items.push(reset);
  return items;
}

/* ------------------------------ 工具栏（WP4.2） ------------------------------ */

export const TOOLBAR_ACTION = {
  COPY_TITLE: 'toolbar.copyTitle',
  COPY_ID: 'toolbar.copyId',
} as const;

export interface ToolbarMenuInput {
  /** 这颗按钮挂的命令 id（插件贡献的 `ui.toolbar` 都带） */
  readonly commandId: string;
}

/**
 * 工具条按钮（**只对挂了命令的贡献按钮表态**：空白处与壳层自带按钮交给兜底菜单，
 * 那里的「命令面板 / 设置 / 检查更新」比这里重复一份更能用）。
 *
 * **没有「隐藏此按钮」**：壳层没有工具栏自定义能力（`ui.toolbar` 贡献是插件声明、
 * 壳层只渲染），删不得也存不下；等有了自定义再补——现在放一个假开关才是欺骗。
 */
export function buildToolbarMenu(input: ToolbarMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: TOOLBAR_ACTION.COPY_TITLE, label: '复制命令标题' },
    { id: TOOLBAR_ACTION.COPY_ID, label: '复制命令 ID' },
  ];
  const settings = menuItemFromCommand('layout.openSettings', { dividerBefore: true });
  if (settings !== null) items.push(settings);
  return items;
}

/* ------------------------------ 状态栏（WP4.3） ------------------------------ */

export const STATUS_BAR_ACTION = {
  COPY: 'status.copy',
  EOL_MENU: 'status.eol',
} as const;

/** 换行符两档的菜单项 id（`status.eol.LF` / `status.eol.CRLF`） */
export function statusEolActionId(eol: ShellEol): string {
  return `${STATUS_BAR_ACTION.EOL_MENU}.${eol}`;
}

export interface StatusBarMenuInput {
  /** 右键命中的那一格文字（没有文字 ⇒ 复制项禁用并说明） */
  readonly text: string;
  readonly eol: ShellEol | null;
  /** 当前面可写且是原文面（`eolSwitchable`），菜单里的 LF/CRLF 才按得动 */
  readonly canSwitchEol: boolean;
}

/**
 * 状态栏。
 *
 * 换行符那一条是**现有入口的第二份入口**：落地仍是 `onSwitchEol`（`model.pushEOL` +
 * 停点 + 标脏），菜单不自己动 model。只读 / 预览面 `eolSwitchable` 不为 true ⇒
 * 整条子菜单不显示（能力不在，不摆一个灰的）。
 *
 * 「索引详情 / 重建索引」**不出现**：全仓没有这两条命令，也没有对应的服务入口
 * ——照铁律 3（找不到落脚点就整项不显示）留白，报告里记着原因。
 */
export function buildStatusBarMenu(input: StatusBarMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    input.text === ''
      ? {
          id: STATUS_BAR_ACTION.COPY,
          label: '复制状态文本',
          disabled: true,
          disabledReason: '这一格没有可复制的文字',
        }
      : { id: STATUS_BAR_ACTION.COPY, label: '复制状态文本' },
  ];
  if (input.canSwitchEol && input.eol !== null) {
    items.push({
      id: STATUS_BAR_ACTION.EOL_MENU,
      label: '切换换行符',
      icon: 'edit',
      dividerBefore: true,
      children: [
        { id: statusEolActionId('LF'), label: 'LF（Unix 换行）', checked: input.eol === 'LF' },
        { id: statusEolActionId('CRLF'), label: 'CRLF（Windows 换行）', checked: input.eol === 'CRLF' },
      ],
    });
  }
  const settings = menuItemFromCommand('layout.openSettings', { dividerBefore: true });
  if (settings !== null) items.push(settings);
  return items;
}

/* ------------------------------ 剪贴板 ------------------------------ */

/**
 * 复制纯文本（菜单里的「复制…」三项共用）。
 *
 * 优先 `navigator.clipboard`（WebView2 有）；拿不到或被拒时回落到
 * `<textarea> + execCommand('copy')`——两档都是平台能力，不是壳层自造的剪贴板。
 * 失败不抛：菜单里按一下没反应已经是既成事实，再弹一个错误框只会更吵。
 */
export function copyTextToClipboard(text: string): void {
  if (text === '') return;
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clip !== undefined && typeof clip.writeText === 'function') {
    void clip.writeText(text).catch(() => {
      fallbackCopy(text);
    });
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  if (typeof document === 'undefined') return;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // 平台不给就算了（不弹第二个错误）
  }
  area.remove();
}

/* ------------------------------ 宿主（由壳层注入） ------------------------------ */

/**
 * 壳层能力面：菜单**只**通过这些方法落地，不 import React、不碰 dispatch。
 *
 * 为什么是「快照 + 命令」而不是把 `LayoutState` 直接递进来：菜单需要的是
 * 「这个面板浮着没有 / 宽高够不够视口 / 换行符是哪档」这几格判断，给它整个
 * `LayoutState` 等于把布局内部结构变成菜单的公开契约。
 */
export interface ShellMenuSnapshot {
  readonly floating: Readonly<Record<string, ShellFloatRect>>;
  readonly sidebarVisible: boolean;
  readonly activeViewKey: string | null;
  /** 当前编辑器读数里的换行符（没有读数 = null） */
  readonly eol: ShellEol | null;
  /** 读数此刻可以切档（可写原文面） */
  readonly canSwitchEol: boolean;
}

export interface ShellMenuHost {
  snapshot(): ShellMenuSnapshot;
  /** 面板此刻停靠在哪个容器（浮动中给的是它「回家」的容器）；不认识 ⇒ null */
  containerOf(panelId: string): ShellContainerTarget | null;
  /** 视图 key 里的面板 id（活动栏「移到右侧栏」按整组搬） */
  panelsOfView(viewKey: string): readonly string[];
  isCollapsed(panelId: string): boolean;
  /** 容器收起（面板选项卡 ✕ 同一个动作） */
  closeContainer(container: 'aux' | 'bottom'): void;
  /**
   * 显示 / 隐藏某个侧栏视图（点击活动栏图标同一个动作：已激活就收起整列，否则切过去）。
   * 不接受「显示哪个」参数——视图 key 决定一切，菜单只表达「现在按一下会怎样」。
   */
  toggleSidebarView(viewKey: string): void;
  float(panelId: string): void;
  dock(panelId: string): void;
  move(panelId: string, to: ShellContainerTarget): void;
  /** 浮窗铺满视口 */
  maximizeFloat(panelId: string): void;
  /** 浮窗回到缺省几何（同时也是「还原」） */
  resetFloat(panelId: string): void;
  toggleCollapse(panelId: string): void;
  resetLayout(): void;
  /** 换行符落地（复用 `onSwitchEol`，不自己动 model） */
  switchEol(eol: ShellEol): void;
}

let shellHost: ShellMenuHost | null = null;

/** 注入 / 撤销壳层能力面（`null` = 壳层卸载 ⇒ 各面返回 null，路由落到兜底） */
export function installShellMenuHost(host: ShellMenuHost | null): () => void {
  shellHost = host;
  return () => {
    if (shellHost === host) shellHost = null;
  };
}

/** 通知面需要的那几格（由 `NotificationCenter` 注入；通知列表的真源在那边） */
export interface ShellNoticeView {
  readonly id: number;
  readonly message: string;
  readonly detail?: string;
  readonly actions: readonly string[];
}

export interface NoticeMenuHost {
  readonly notices: readonly ShellNoticeView[];
  dismiss(id: number): void;
  clearAll(): void;
  /** 执行第 index 个动作（先收通知再执行，与 toast 上的按钮同序） */
  runAction(id: number, index: number): void;
}

let noticeHost: NoticeMenuHost | null = null;

/** 注入 / 撤销通知数据面（`null` = 通知中心卸载） */
export function installNoticeMenuHost(host: NoticeMenuHost | null): () => void {
  noticeHost = host;
  return () => {
    if (noticeHost === host) noticeHost = null;
  };
}

/* ------------------------------ 动作分发 ------------------------------ */

/** 命令项（`id` 就是命令 id）优先走命令通道；面自己的 id 由各面的 switch 接 */
function runCommandItem(id: string): boolean {
  return canRunContextMenuCommand(id) ? runContextMenuCommand(id) : false;
}

function runPanelTabsAction(id: string, panelId: string, container: 'aux' | 'bottom'): void {
  const host = shellHost;
  if (host === null) return;
  switch (id) {
    case PANEL_TABS_ACTION.FLOAT:
      host.float(panelId);
      return;
    case PANEL_TABS_ACTION.DOCK:
      host.dock(panelId);
      return;
    case PANEL_TABS_ACTION.MOVE_LEFT:
      host.move(panelId, 'sidebar');
      return;
    case PANEL_TABS_ACTION.MOVE_RIGHT:
      host.move(panelId, 'aux');
      return;
    case PANEL_TABS_ACTION.MOVE_BOTTOM:
      host.move(panelId, 'bottom');
      return;
    case PANEL_TABS_ACTION.CLOSE:
      host.closeContainer(container);
      return;
    default:
      runCommandItem(id);
  }
}

function runPanelSectionAction(id: string, panelId: string): void {
  const host = shellHost;
  if (host === null) return;
  switch (id) {
    case PANEL_SECTION_ACTION.COLLAPSE:
    case PANEL_SECTION_ACTION.EXPAND:
      host.toggleCollapse(panelId);
      return;
    default:
      runCommandItem(id);
  }
}

function runFloatingAction(id: string, panelId: string): void {
  const host = shellHost;
  if (host === null) return;
  switch (id) {
    case FLOATING_ACTION.CLOSE:
      host.dock(panelId);
      return;
    case FLOATING_ACTION.DOCK_LEFT:
      host.dock(panelId);
      host.move(panelId, 'sidebar');
      return;
    case FLOATING_ACTION.DOCK_RIGHT:
      host.dock(panelId);
      host.move(panelId, 'aux');
      return;
    case FLOATING_ACTION.DOCK_BOTTOM:
      host.dock(panelId);
      host.move(panelId, 'bottom');
      return;
    case FLOATING_ACTION.MAXIMIZE:
      host.maximizeFloat(panelId);
      return;
    case FLOATING_ACTION.RESTORE:
    case FLOATING_ACTION.RESET:
      host.resetFloat(panelId);
      return;
    default:
      runCommandItem(id);
  }
}

function runNotificationAction(id: string, noticeId: number | null): void {
  const host = noticeHost;
  if (host === null) return;
  switch (id) {
    case NOTIFICATION_ACTION.COPY: {
      const notice = noticeId === null ? undefined : host.notices.find((n) => n.id === noticeId);
      if (notice === undefined) return;
      copyTextToClipboard(notice.detail === undefined ? notice.message : `${notice.message}\n${notice.detail}`);
      return;
    }
    case NOTIFICATION_ACTION.DISMISS:
      if (noticeId !== null) host.dismiss(noticeId);
      return;
    case NOTIFICATION_ACTION.CLEAR_ALL:
      host.clearAll();
      return;
    default:
      if (noticeId !== null && id.startsWith(NOTIFICATION_ACTION.RUN_PREFIX)) {
        const index = Number.parseInt(id.slice(NOTIFICATION_ACTION.RUN_PREFIX.length), 10);
        if (Number.isInteger(index)) host.runAction(noticeId, index);
        return;
      }
      runCommandItem(id);
  }
}

function runActivityBarAction(id: string, viewKey: string): void {
  const host = shellHost;
  if (host === null) return;
  switch (id) {
    case ACTIVITY_BAR_ACTION.SHOW:
    case ACTIVITY_BAR_ACTION.HIDE:
      host.toggleSidebarView(viewKey);
      return;
    case ACTIVITY_BAR_ACTION.MOVE_AUX:
      for (const panelId of host.panelsOfView(viewKey)) host.move(panelId, 'aux');
      return;
    default:
      runCommandItem(id);
  }
}

function runToolbarAction(id: string, commandId: string, title: string): void {
  switch (id) {
    case TOOLBAR_ACTION.COPY_TITLE:
      if (title !== '') copyTextToClipboard(title);
      return;
    case TOOLBAR_ACTION.COPY_ID:
      copyTextToClipboard(commandId);
      return;
    default:
      runCommandItem(id);
  }
}

function runStatusBarAction(id: string, text: string): void {
  const host = shellHost;
  if (host === null) return;
  switch (id) {
    case STATUS_BAR_ACTION.COPY:
      copyTextToClipboard(text);
      return;
    case statusEolActionId('LF'):
      host.switchEol('LF');
      return;
    case statusEolActionId('CRLF'):
      host.switchEol('CRLF');
      return;
    default:
      runCommandItem(id);
  }
}

/* ------------------------------ DOM 读点 ------------------------------ */

/** 状态栏里「一格」的锚点（点在哪一格就复制哪一格的文字） */
const STATUS_CELL_SELECTOR = '.sb-editor, .sb-sel, .sb-idx, .sb-dirty, .sb-writable, .sb-slot';

function textOf(element: HTMLElement | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function viewportOf(): ShellViewportRect {
  if (typeof window === 'undefined') return { w: 0, h: 0 };
  return { w: window.innerWidth, h: window.innerHeight };
}

/* ------------------------------ 七个面的声明 ------------------------------ */

/** 面板选项卡（aux / bottom 的 `.panel-tabs`） */
declareContextSurface({
  id: 'panel-tabs',
  ariaLabel: '面板选项卡菜单',
  area: 'panel',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = shellHost;
    if (host === null) return null;
    const strip = ctx.target.closest<HTMLElement>('[data-panel-tabs-container]');
    if (strip === null) return null;
    const raw = strip.getAttribute('data-panel-tabs-container');
    if (raw !== 'aux' && raw !== 'bottom') return null;
    // 点在选项卡上是那颗面板；点在空白处是当前激活的那颗（与 ✕ / 浮动按钮的受作用者一致）
    const tab = ctx.target.closest<HTMLElement>('[data-panel-id]');
    const panelId = tab?.getAttribute('data-panel-id') ?? strip.getAttribute('data-active-panel') ?? '';
    if (panelId === '') return null;
    const items = buildPanelTabsMenu({
      container: raw,
      isFloating: host.snapshot().floating[panelId] !== undefined,
      canMove: host.containerOf(panelId) !== null,
      canHide: true,
    });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runPanelTabsAction(id, panelId, raw) };
  },
});

/** 面板分区头（侧栏多面板分栏里的标题按钮） */
declareContextSurface({
  id: 'panel-section-header',
  ariaLabel: '面板分区菜单',
  area: 'panel',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = shellHost;
    if (host === null) return null;
    const head = ctx.target.closest<HTMLElement>('[data-panel-id]');
    const panelId = head?.getAttribute('data-panel-id') ?? '';
    if (head === null || panelId === '') return null;
    const items = buildPanelSectionMenu({ collapsed: host.isCollapsed(panelId) });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runPanelSectionAction(id, panelId) };
  },
});

/** 浮窗（`.floating-panel` 整个窗口，含标题栏与内容区） */
declareContextSurface({
  id: 'floating-window',
  ariaLabel: '浮动窗菜单',
  area: 'panel',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = shellHost;
    if (host === null) return null;
    const root = ctx.target.closest<HTMLElement>('[data-floating-panel-id]');
    const panelId = root?.getAttribute('data-floating-panel-id') ?? '';
    if (root === null || panelId === '') return null;
    const rect = host.snapshot().floating[panelId];
    const items = buildFloatingWindowMenu({
      isMaximized: rect !== undefined && isFloatMaximized(rect, viewportOf()),
      canHide: true,
    });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runFloatingAction(id, panelId) };
  },
});

/** 通知（一条 toast；容器空白处 = 整批） */
declareContextSurface({
  id: 'notification',
  ariaLabel: '通知菜单',
  area: 'panel',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = noticeHost;
    if (host === null) return null;
    const toast = ctx.target.closest<HTMLElement>('[data-notice-id]');
    if (toast === null) {
      // 容器空白处：只给整批动作（这里没有「这一条」可复制/可清除）
      if (host.notices.length === 0) return null;
      return {
        items: [{ id: NOTIFICATION_ACTION.CLEAR_ALL, label: '清除全部通知' }],
        onSelect: (id) => runNotificationAction(id, null),
      };
    }
    const rawId = toast.getAttribute('data-notice-id');
    const noticeId = rawId === null ? Number.NaN : Number.parseInt(rawId, 10);
    const notice = Number.isInteger(noticeId)
      ? host.notices.find((n) => n.id === noticeId)
      : undefined;
    // 通知刚被别处清掉（自动消失 / 同屏淘汰）⇒ 这一级不表态，回落下一级
    if (notice === undefined) return null;
    const items = buildNotificationMenu({
      hasAction: notice.actions.length > 0,
      actionLabels: notice.actions,
      total: host.notices.length,
    });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runNotificationAction(id, notice.id) };
  },
});

/** 活动栏（一个图标 = 一个侧栏视图） */
declareContextSurface({
  id: 'activity-bar',
  ariaLabel: '活动栏菜单',
  area: 'chrome',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = shellHost;
    if (host === null) return null;
    const item = ctx.target.closest<HTMLElement>('[data-view-key]');
    const viewKey = item?.getAttribute('data-view-key') ?? '';
    if (item === null || viewKey === '') return null;
    const snapshot = host.snapshot();
    const items = buildActivityBarMenu({
      active: snapshot.sidebarVisible && snapshot.activeViewKey === viewKey,
      canMove: host.panelsOfView(viewKey).length > 0,
    });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runActivityBarAction(id, viewKey) };
  },
});

/** 工具栏（带命令的贡献按钮；空白处与壳层自带按钮交给兜底菜单） */
declareContextSurface({
  id: 'toolbar',
  ariaLabel: '工具栏菜单',
  area: 'chrome',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    if (shellHost === null) return null;
    const button = ctx.target.closest<HTMLElement>('[data-toolbar-command]');
    const commandId = button?.getAttribute('data-toolbar-command') ?? '';
    // 没有命令可复制的地方不接管：兜底菜单里的「命令面板 / 设置 / 检查更新」更值得给
    if (button === null || commandId === '') return null;
    const title = button.getAttribute('data-toolbar-title') ?? textOf(button);
    const items = buildToolbarMenu({ commandId });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runToolbarAction(id, commandId, title) };
  },
});

/** 状态栏（复制命中的那一格；换行符复用现有切换入口） */
declareContextSurface({
  id: 'status-bar',
  ariaLabel: '状态栏菜单',
  area: 'chrome',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = shellHost;
    if (host === null) return null;
    const cell = ctx.target.closest<HTMLElement>(STATUS_CELL_SELECTOR);
    // 空白处（没有落在任何一格读数上）不接管：没有「这一格」就没有可复制的东西
    if (cell === null) return null;
    const text = textOf(cell);
    const snapshot = host.snapshot();
    const items = buildStatusBarMenu({
      text,
      eol: snapshot.eol,
      canSwitchEol: snapshot.canSwitchEol,
    });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runStatusBarAction(id, text) };
  },
});
