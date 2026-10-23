/**
 * 文件树右键菜单（1023 覆盖面批 · WP2.1 / WP2.2）：**两个面 + 一份兜底实现**。
 *
 * ## 为什么改走根宿主
 *
 * 旧实现就地渲染共享 `<ContextMenu>`，菜单跟着 `.file-tree` 的层叠上下文走——树在左栏，
 * 菜单被面板边界裁掉、被底部面板盖住是迟早的事。本批统一走根宿主
 * （`openContextMenu` + 固定层 1300）：行元素上挂 `data-context-surface` / `data-tree-*`，
 * 根路由 `buildContextMenuRoute` 命中 `file-tree`（行）或 `file-tree-root`（空白区）后
 * 回来问本模块要菜单，动作由本模块的 `onSelect` 分发。
 *
 * ## 数据放 DOM，不放闭包
 *
 * 面是按 id 注册的**全局**入口，而树是组件实例：把行数据放进 build 的闭包，多实例
 * （将来左右两个浏览器面板）就会互相覆盖。所以行上写 `data-tree-kind` / `data-tree-path` /
 * `data-tree-label`，build 时从 `target` 读——与地基的「多实例面」口径一致。
 *
 * 组件实例侧只留一份**运行时桥**（`setFileTreeMenuRuntime`）：视图、能力位、动作分发函数
 * 每次渲染整体替换，卸载即清空。build 拿不到桥（组件没挂载 / 已卸载）就返回 `null`，
 * 让根路由继续往下走兜底——不弹空壳，也不抛错。
 *
 * ## `FileTreeContextMenu` 保留不删
 *
 * 它是**就地渲染**那一版（根宿主缺席的宿主可用它自渲染），本次 FileTree 已不再渲染它；
 * 保留的理由是它同时是 SSR 形状锁（`tests/file-tree-menu.test.ts`）与菜单文案的第二读者。
 * 两个入口共用同一份 `menuItemsFor` 与同一份映射，文案不会分叉。
 */
import type { ReactElement } from 'react';
import { ContextMenu, type ContextMenuItem } from './context-menu';
import { canRunContextMenuCommand, isTextInputTarget, menuItemFromCommand } from './context-menu-model';
import { declareContextSurface, type ContextSurfaceBuildResult } from './context-surfaces';
import { SHOW_FILE_HISTORY_COMMAND_ID } from './file-history';
import {
  COMMAND_PALETTE_COMMAND,
  menuItemsFor,
  type MenuCapability,
  type MenuItemId,
  type MenuItemSpec,
  type MenuScopeKind,
  type MenuView,
} from './file-tree-ops';
import type { MenuScope } from './file-tree-types';

/* ---------------------------- DOM 作用域（行数据） ---------------------------- */

/** 树里一行能右键出来的作用域（`blank` = 空白区，`group` = 角色组标题行） */
export type FileTreeScope =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'package'; readonly dir: string; readonly label: string }
  | { readonly kind: 'group'; readonly label: string; readonly prefix: string }
  | { readonly kind: 'blank' };

/** 行的 `data-tree-kind` 取值（与 `FileTreeScope.kind` 一一对应，`blank` 不落在行上） */
export type FileTreeRowKind = 'file' | 'dir' | 'package' | 'group';

/**
 * 从被右击的元素读出作用域（纯 DOM 读，无状态）。
 *
 * 只认**最近的**那一行：`closest` 命中的 `[data-context-surface="file-tree"]` 就是行本身
 * （行元素自己带这个属性）——嵌套的 `li` / `ul` 不挂面属性，空白处自然落到 `file-tree-root`。
 */
export function readFileTreeScope(target: HTMLElement): FileTreeScope | null {
  const row = target.closest<HTMLElement>('[data-context-surface="file-tree"]');
  if (row === null) {
    return target.closest('[data-context-surface="file-tree-root"]') === null ? null : { kind: 'blank' };
  }
  const kind = row.getAttribute('data-tree-kind');
  const path = row.getAttribute('data-tree-path') ?? '';
  const label = row.getAttribute('data-tree-label') ?? '';
  switch (kind) {
    case 'file':
      return path === '' ? null : { kind: 'file', path };
    case 'dir':
      return path === '' ? null : { kind: 'dir', path };
    case 'package':
      return path === '' ? null : { kind: 'package', dir: path, label };
    case 'group':
      return { kind: 'group', label, prefix: path };
    default:
      return null;
  }
}

/** 作用域 → 菜单构建用的种类（`blank` 与 `group` 走树级那一套） */
export function scopeKindOf(scope: FileTreeScope): MenuScopeKind {
  return scope.kind;
}

/** 作用域自身的路径（文件历史判"是不是活动文件"用；空白区没有路径） */
export function scopePathOf(scope: FileTreeScope): string | undefined {
  switch (scope.kind) {
    case 'file':
    case 'dir':
      return scope.path;
    case 'package':
      return scope.dir;
    case 'group':
      return scope.prefix;
    case 'blank':
      return undefined;
  }
}

/* ---------------------------- 规格 → 菜单项 ---------------------------- */

/**
 * 一条规格 → 一条菜单项。
 *
 * 命令项（`command` 在场）的标题与键位一律取自键位注册表（`menuItemFromCommand`），
 * 注册表里没有这条命令时才退回规格自带的中文兜底文案——菜单里显示的键必须与真按下去
 * 的那条一致，不许编键位。
 */
export function toContextMenuItem(spec: MenuItemSpec): ContextMenuItem {
  const fromCommand = spec.command === undefined ? null : menuItemFromCommand(spec.command);
  const shortcut = fromCommand?.shortcut ?? spec.shortcut;
  return {
    id: spec.id,
    label: fromCommand?.label ?? spec.label,
    ...(spec.icon === undefined ? {} : { icon: spec.icon }),
    ...(shortcut === undefined ? {} : { shortcut }),
    ...(spec.dividerBefore === true ? { dividerBefore: true } : {}),
    ...(spec.danger === true ? { danger: true } : {}),
    ...(spec.disabled === true ? { disabled: true } : {}),
    ...(spec.disabledReason === undefined ? {} : { disabledReason: spec.disabledReason }),
    ...(spec.checked === true ? { checked: true } : {}),
  };
}

/* ---------------------------- 运行时桥 ---------------------------- */

/** 组件实例交给面的那一份现场（每次渲染整体替换；卸载即 null） */
export interface FileTreeMenuRuntime {
  readonly view: MenuView;
  readonly activeFile: string | null;
  readonly capability: MenuCapability;
  /** 分发一条动作（幂等；组件已卸载时是空操作） */
  readonly act: (id: MenuItemId, scope: FileTreeScope) => void;
}

let runtime: FileTreeMenuRuntime | null = null;

/** 登记当前树的现场（FileTree 每次渲染调用；`null` = 卸载） */
export function setFileTreeMenuRuntime(next: FileTreeMenuRuntime | null): void {
  runtime = next;
}

/** 按现场算一份菜单（纯函数：给定作用域 + 现场，返回条目）；空菜单 = 这一级不表态 */
export function fileTreeSurfaceMenu(
  scope: FileTreeScope,
  rt: FileTreeMenuRuntime,
): ContextMenuItem[] {
  const specs = menuItemsFor(scopeKindOf(scope), liveCapability(rt.capability), {
    view: rt.view,
    activeFile: rt.activeFile,
    ...(scopePathOf(scope) === undefined ? {} : { path: scopePathOf(scope) }),
  });
  return specs.map(toContextMenuItem);
}

/**
 * 命令类能力位**在右键那一刻现探**（不用组件注册运行时的那一帧）。
 *
 * 命令通道由壳层（`ShellLayout`）在挂载时注入，而树的子树 effect 先于壳层跑：只信
 * 注册时的快照，项目刚打开的头几十毫秒里「命令面板 / 文件历史」会凭空少两项。
 * 现探一次只是查表，换的是"菜单永远是此刻的真话"。
 */
function liveCapability(cap: MenuCapability): MenuCapability {
  return {
    ...cap,
    canHistory: canRunContextMenuCommand(SHOW_FILE_HISTORY_COMMAND_ID),
    canCommandPalette: canRunContextMenuCommand(COMMAND_PALETTE_COMMAND),
  };
}

/* ---------------------------- 两个面的声明 ---------------------------- */

/**
 * 行面（`file-tree`）与空白区面（`file-tree-root`）。
 *
 * 模块顶层声明（不是组件里 `useEffect` 再声明）：面的 id 是全局的，重复声明会告警；
 * 组件侧只换运行时桥，声明一次就够。`build` 里先挡输入框——树里的过滤框与重命名输入框
 * 都是**文本输入**，它们该走 `input` 面（剪切 / 复制 / 粘贴），不许被树菜单抢走。
 */
function buildFor(target: HTMLElement): ContextSurfaceBuildResult {
  if (isTextInputTarget(target)) return null;
  const rt = runtime;
  if (rt === null) return null;
  const scope = readFileTreeScope(target);
  if (scope === null) return null;
  const items = fileTreeSurfaceMenu(scope, rt);
  if (items.length === 0) return null;
  return { items, onSelect: (id) => rt.act(id as MenuItemId, scope) };
}

declareContextSurface({
  id: 'file-tree',
  ariaLabel: '文件树菜单',
  area: 'explorer',
  build: (ctx) => buildFor(ctx.target),
});

declareContextSurface({
  id: 'file-tree-root',
  ariaLabel: '文件树根菜单',
  area: 'explorer',
  build: (ctx) => buildFor(ctx.target),
});

/* ---------------------------- 兜底实现（就地渲染） ---------------------------- */

export interface FileTreeContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly scope: MenuScope;
  readonly capability: MenuCapability;
  /** 当前视图（口上 / 文件系统；决定树级菜单项与文件项的可用性） */
  readonly view?: MenuView;
  /** 当前正在编辑的文件（文件历史只认它） */
  readonly activeFile?: string | null;
  /** 关闭菜单 */
  readonly onDismiss: () => void;
  /** 分发动作（与根宿主的 `onSelect` 同一份语义） */
  readonly onAction?: (id: MenuItemId, scope: MenuScope) => void;
}

/** 旧作用域 → 新的作用域种类（root 与空白区是同一件事：树级动作） */
function scopeKindOfLegacy(scope: MenuScope): MenuScopeKind {
  return scope.kind === 'root' ? 'blank' : scope.kind;
}

/**
 * 就地渲染版（根宿主缺席时的兜底；FileTree 自 1023 批起不再渲染它，见模块头）。
 *
 * 它与根宿主走**同一份** `menuItemsFor` + `toContextMenuItem`：两个入口的文案、禁用原因、
 * 命令键位只可能一致。动作语义也一致（`onAction(id, scope)`），所以从兜底切到根宿主时
 * 宿主侧不需要第二套分发函数。
 */
export function FileTreeContextMenu(props: FileTreeContextMenuProps): ReactElement {
  const { scope } = props;
  const path =
    scope.kind === 'file' || scope.kind === 'dir'
      ? scope.path
      : scope.kind === 'package'
        ? scope.dir
        : undefined;
  const items: ContextMenuItem[] = menuItemsFor(scopeKindOfLegacy(scope), props.capability, {
    ...(props.view === undefined ? {} : { view: props.view }),
    ...(props.activeFile === undefined ? {} : { activeFile: props.activeFile }),
    ...(path === undefined ? {} : { path }),
  }).map(toContextMenuItem);

  return (
    <ContextMenu
      x={props.x}
      y={props.y}
      items={items}
      ariaLabel={
        scope.kind === 'file' || scope.kind === 'dir' || scope.kind === 'package' ? '文件操作' : '目录操作'
      }
      onSelect={(id) => props.onAction?.(id as MenuItemId, scope)}
      onDismiss={props.onDismiss}
    />
  );
}
