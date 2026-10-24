import { memo, useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react';
import { isTauri } from '../bridge/invoke';
import { KitIconButton } from '../ui-kit';
import { openContextMenu } from './context-menu-host';
import { canRunContextMenuCommand, runContextMenuCommand } from './context-menu-model';
import { declareContextSurface, type ContextSurfaceMenu } from './context-surfaces';
import { relativeToRoot } from './file-tree-ops';
import { Icon } from './icons';
import { useNotify } from './NotificationCenter';
import { revealFailureText, revealInExplorer } from './reveal-explorer';
import { TabRow } from './tab-row';
import {
  CLOSE_SAVED_EMPTY_REASON,
  groupMenuItemsFor,
  planCloseSaved,
  tabListIndexOf,
  tabMenuItemsFor,
  tabName,
  type BatchCloseMode,
  type GroupMenuItemId,
  type TabDropHint,
  type TabMenuItemId,
} from './tabs-ops';
import './context-menu-tabs.css';

export type { TabRowProps } from './tab-row';

/**
 * 标签栏（C1 右键菜单 / C2 固定标签 / C3 全部保存入口）。
 *
 * **独立成模块**（不与 ProjectView 同文件）：ProjectView 静态引入 EditorPane →
 * monaco 全图，SSR 单测在 node 里一 import 就炸（window is not defined）；
 * 标签栏自身只依赖 Icon / NotificationCenter / tabs-ops，零编辑器知识。
 * 顺序照单全收（pinned 区在前的排序不变量由 App 经 tabs-ops 维持），渲染层不二次排序。
 *
 * PS-16 memo 化：`TabBar` 组件级 memo（宿主侧五条回调经 ProjectView 的 `callbacksFor`
 * 拿恒定身份后，壳层任何无关重渲停在标签栏门口）；单行 `TabRow` 行级 memo 在
 * `tab-row.tsx`（拆模块 ⇒ 行级计数可观测）。
 *
 * ## 1023 覆盖面批（WP2.3 / 2.4）：三个右键面
 *
 * - `tabs`：标签行（`tab-row.tsx` 那枚 div 自带 `data-context-surface`）；
 * - `tab-bar-blank`：标签栏空白处（本文件的 `.editor-tabs`）；
 * - `editor-group-header`：编辑器组头（ProjectView 的 `.editor-group-head`）。
 *
 * 三面都是**模块级声明 + 按组 id 桥接**：分屏后同一时刻有多条标签栏，
 * 组件内声明会互相覆盖（后挂载的组赢），所以动作与数据挂在 `TabsMenuBridge` 上，
 * 由 `data-group-id` 找回「刚才点的是哪一组」（公共规程·多实例面）。
 * 就地渲染的 `<ContextMenu>` 已退役：菜单统一走根宿主（固定层，压过模态/浮窗）。
 */

export interface TabBarProps {
  openTabs: readonly string[];
  activeFile: string | null;
  dirtyPaths: ReadonlySet<string>;
  pinnedPaths: ReadonlySet<string>;
  onActivateTab: (path: string) => void;
  onRequestCloseTab: (path: string) => void;
  onReorderTab: (path: string, toIndex: number) => void;
  onTogglePin: (path: string) => void;
  onBatchCloseTab: (mode: BatchCloseMode, anchor: string) => void;
  /** 「全部保存」按钮的落地面（宿主 ProjectView，脏态判断与轻反馈都在那里，按钮恒在——铁律 4） */
  onSaveAllClick: () => void;
  /** 有没有脏标签（保存按钮弱化显示的依据；弱化 ≠ 消失） */
  hasDirty: boolean;
  /**
   * 本组的预览标签（1020 编辑器体感批）。`null` / 不在 openTabs 里 ⇒ 没有预览态。
   * 预览 = 单击浏览，标签画斜体；再点一下（或改过它）即转正。
   */
  previewPath?: string | null;
  /** 本组 id（1023：右键动作按组找回；也是 `data-group-id` 的写入口） */
  groupId?: string;
  /** 编辑器组总数（`>1` 才有「关闭编辑器组」这类组级动作） */
  groupCount?: number;
  /** 关闭本组（组头 / 空白菜单；单组时由本组件按能力隐藏） */
  onCloseGroup?: (groupId: string) => void;
  /** 项目根（「复制相对路径」的基准；缺省 ⇒ 该项不显示，不拷半截路径） */
  rootDir?: string | null;
}

/* ------------------------- 右键面：按组桥接（多实例安全） ------------------------- */

/**
 * 一组的菜单动作与数据（模块级声明要从 DOM 找回它，所以做成可查的对象）。
 *
 * 只放**既有动作**：这里多一个方法，就等于给菜单新造一条业务路径。
 */
export interface TabsMenuBridge {
  readonly groupId: string;
  readonly groupCount: number;
  readonly openTabs: readonly string[];
  readonly active: string | null;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly pinnedPaths: ReadonlySet<string>;
  readonly rootDir: string | null;
  /** 组级动作是否有落脚点（宿主给了 `onCloseGroup` 且确实分了屏） */
  readonly canCloseGroup: boolean;
  copyText(text: string, okMessage: string): void;
  activate(path: string): void;
  requestClose(path: string): void;
  batchClose(mode: BatchCloseMode, anchor: string): void;
  togglePin(path: string): void;
  closeSaved(anchor: string): void;
  saveAll(): void;
  closeGroup(): void;
  reveal(path: string): void;
}

const menuBridges = new Map<string, TabsMenuBridge>();

/**
 * 登记一组的菜单动作（返回注销函数）。
 *
 * 组件每帧把最新字段写进同一个对象（引用稳定），这里只在挂载/换组时登记一次
 * ——菜单打开那一刻取到的永远是当前状态，不会拿着首帧的旧闭包。
 */
export function registerTabsMenuBridge(bridge: TabsMenuBridge): () => void {
  menuBridges.set(bridge.groupId, bridge);
  return () => {
    if (menuBridges.get(bridge.groupId) === bridge) menuBridges.delete(bridge.groupId);
  };
}

/** 从被右击的元素往上找组 id，再取那一组的桥（找不到 ⇒ 这一级不表态，走兜底） */
function bridgeOf(target: HTMLElement): TabsMenuBridge | null {
  const holder = target.closest<HTMLElement>('[data-group-id]');
  const groupId = holder?.getAttribute('data-group-id') ?? null;
  return groupId === null ? null : menuBridges.get(groupId) ?? null;
}

/* ------------------------------ 菜单构建（纯接线） ------------------------------ */

/** 标签行菜单：事实从桥上现算（脏态/固定/命令通道），项与文案全部来自 tabs-ops */
function tabMenuOf(bridge: TabsMenuBridge, path: string): ContextSurfaceMenu | null {
  const items = tabMenuItemsFor({
    pinned: bridge.pinnedPaths.has(path),
    // 「关闭已保存」的可用性就是它的计划是否非空（同一个判据，不写第二份）
    hasSaved: planCloseSaved(bridge.openTabs, path, bridge.pinnedPaths, bridge.dirtyPaths).length > 0,
    canReveal: isTauri(),
    hasReopen: canRunContextMenuCommand('workbench.reopenClosedTab'),
    canSplit: canRunContextMenuCommand('workbench.splitEditor'),
    hasRoot: bridge.rootDir !== null,
  });
  if (items.length === 0) return null;
  return {
    items,
    onSelect: (id) => {
      runTabMenuAction(bridge, path, id as TabMenuItemId);
    },
  };
}

/** 标签栏空白区 / 编辑器组头菜单（两处问的是同一组问题，只有触发面不同） */
function groupMenuOf(target: HTMLElement): ContextSurfaceMenu | null {
  const bridge = bridgeOf(target);
  if (bridge === null) return null;
  const items = groupMenuItemsFor({
    groupCount: bridge.groupCount,
    tabs: bridge.openTabs,
    active: bridge.active,
    pinned: bridge.pinnedPaths,
    canCloseGroup: bridge.canCloseGroup,
    canSplit: canRunContextMenuCommand('workbench.splitEditor'),
  });
  if (items.length === 0) return null;
  return {
    items,
    onSelect: (id) => {
      runGroupMenuAction(bridge, id);
    },
  };
}

/* ------------------------------ 动作分发（只接既有能力） ------------------------------ */

function runTabMenuAction(bridge: TabsMenuBridge, path: string, id: TabMenuItemId): void {
  switch (id) {
    case 'close':
      bridge.requestClose(path);
      break;
    case 'close-others':
      bridge.batchClose('others', path);
      break;
    case 'close-right':
      bridge.batchClose('right', path);
      break;
    case 'close-all':
      bridge.batchClose('all', path);
      break;
    case 'close-saved':
      bridge.closeSaved(path);
      break;
    case 'toggle-pin':
      bridge.togglePin(path);
      break;
    case 'copy-path':
      bridge.copyText(path, '已复制完整路径');
      break;
    case 'copy-relative':
      bridge.copyText(relativeToRoot(path, bridge.rootDir ?? ''), '已复制相对路径');
      break;
    case 'copy-name':
      bridge.copyText(tabName(path), '已复制文件名');
      break;
    case 'reveal':
      bridge.reveal(path);
      break;
    case 'open-in-new-group':
      // 「在新编辑器组打开」= 激活该标签 + 向右拆分：拆分本来就把焦点组的激活标签带进
      // 新组（editor-groups.splitActiveRight），两步都是既有能力，不新造开组逻辑。
      bridge.activate(path);
      runContextMenuCommand('workbench.splitEditor');
      break;
    case 'split-right':
      runContextMenuCommand('workbench.splitEditor');
      break;
    case 'split-down':
      runContextMenuCommand('workbench.splitEditorDown');
      break;
    case 'reopen':
      runContextMenuCommand('workbench.reopenClosedTab');
      break;
  }
}

function runGroupMenuAction(bridge: TabsMenuBridge, id: string): void {
  // 标签列表子项（`tab-list:<下标>`）：点选即切换到那一枚
  const index = tabListIndexOf(id);
  if (index !== null) {
    const path = bridge.openTabs[index];
    if (path !== undefined) bridge.activate(path);
    return;
  }
  switch (id as GroupMenuItemId) {
    case 'split-right':
      runContextMenuCommand('workbench.splitEditor');
      break;
    case 'split-down':
      runContextMenuCommand('workbench.splitEditorDown');
      break;
    case 'close-group':
      bridge.closeGroup();
      break;
    case 'save-all':
      bridge.saveAll();
      break;
    case 'close-group-tabs': {
      const anchor = bridge.active ?? bridge.openTabs[0];
      if (anchor !== undefined) bridge.batchClose('all', anchor);
      break;
    }
    case 'tab-list':
      // 父项只负责开子菜单，没有动作
      break;
  }
}

/* ------------------------------ 面声明（模块级） ------------------------------ */

declareContextSurface({
  id: 'tabs',
  ariaLabel: '标签页菜单',
  area: 'explorer',
  build: ({ target }) => {
    const row = target.closest<HTMLElement>('[data-tab-path]');
    if (row === null) return null;
    const path = row.getAttribute('data-tab-path');
    if (path === null) return null;
    const bridge = bridgeOf(row);
    return bridge === null ? null : tabMenuOf(bridge, path);
  },
});

declareContextSurface({
  id: 'tab-bar-blank',
  ariaLabel: '标签栏菜单',
  area: 'explorer',
  build: ({ target }) =>
    // 标签行有自己的面（更近的祖先）；走到这里只可能是空白处
    target.closest('[data-tab-path]') === null ? groupMenuOf(target) : null,
});

declareContextSurface({
  id: 'editor-group-header',
  ariaLabel: '编辑器组菜单',
  area: 'explorer',
  build: ({ target }) => groupMenuOf(target),
});

/**
 * 标签栏（模块级 ⇒ SSR 单测可用，照 FileRows 先例）：标签序列 + 右键面 + 全部保存按钮。
 *
 * - **拖拽重排**：落点指示照旧（drop-before / drop-after）；跨固定区分界的处置
 *   （自动改固定态）在宿主的 planReorder 里，这里只报落点；
 * - **右键菜单**：根宿主统一渲染（`context-surfaces` 三级路由），Esc / 外点 / 键盘
 *   行为由共享 `ContextMenu` 负责，本组件只提供「这一级说什么」与动作接线；
 * - **固定标签**：左缘竖标 + 关闭钮不渲染（防误关；显式关闭走右键菜单「关闭」）。
 */
export const TabBar = memo(function TabBar({
  openTabs,
  activeFile,
  dirtyPaths,
  pinnedPaths,
  onActivateTab,
  onRequestCloseTab,
  onReorderTab,
  onTogglePin,
  onBatchCloseTab,
  onSaveAllClick,
  hasDirty,
  previewPath = null,
  groupId = 'tabs',
  groupCount = 1,
  onCloseGroup,
  rootDir = null,
}: TabBarProps): ReactElement {
  const notify = useNotify();
  /** 标签拖拽的自定义 MIME（只在标签条内部流转，防外部拖入误触发） */
  const TAB_DRAG_MIME = 'application/x-kojo-tab-move';
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabDropAt, setTabDropAt] = useState<TabDropHint | null>(null);

  /**
   * 横向溢出判定（L16 可发现性批）：`scrollWidth > clientWidth` 是唯一口径。
   * 溢出时渲染左/右滚动箭头 + 「列出全部标签」▾；**不溢出时一枚都不渲染**
   * （不许 `visibility:hidden` 留空位——DOM 里没有就是没有）。
   */
  const [overflowing, setOverflowing] = useState(false);
  const measureOverflow = useCallback((): void => {
    const el = tabsRef.current;
    if (el === null) return;
    setOverflowing(el.scrollWidth > el.clientWidth);
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    if (el === null) return;
    measureOverflow();
    // 有 ResizeObserver 就盯滚动口；**没有也不许静默**：退化为 window resize 监听，
    // 加上面标签数量/活动标签变化时的重测（内容宽度只有这两个来源）。
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measureOverflow());
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measureOverflow);
    return () => window.removeEventListener('resize', measureOverflow);
  }, [measureOverflow]);
  // 标签增减 / 活动切换（加粗改变内容宽）都重测一次——RO 盯的是容器，不是内容。
  useEffect(() => {
    measureOverflow();
  }, [measureOverflow, openTabs.length, activeFile]);

  /** 活动标签保持可见（标签多到溢出时，点击树中文件也能定位到对应标签） */
  useEffect(() => {
    tabsRef.current
      ?.querySelector('.editor-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFile, openTabs.length]);

  /** 箭头滚动步长：约一屏（0.8 口径），平滑滚动缺失时退化为直写 scrollLeft（可测可退） */
  const scrollTabs = useCallback((dir: -1 | 1): void => {
    const el = tabsRef.current;
    if (el === null) return;
    const step = Math.max(1, Math.floor(el.clientWidth * 0.8));
    if (typeof el.scrollBy === 'function') el.scrollBy({ left: dir * step, behavior: 'smooth' });
    else el.scrollLeft += dir * step;
  }, []);

  /**
   * ▾「列出全部标签」：**零新业务路径**——菜单事实与动作全走既有 `tab-bar-blank`
   * 组的构建链（`groupMenuOf` → `groupMenuItemsFor`），只把「标签列表」子菜单提为
   * 顶层项直接开在根宿主上（固定层，不被 `.editor-group` 的 overflow 裁剪；
   * 子菜单的滚动上限样式在 `context-menu-tabs.css` 早已就位）。
   */
  const openTabsList = useCallback((anchor: HTMLElement): void => {
    const tabsEl = tabsRef.current;
    if (tabsEl === null) return;
    const menu = groupMenuOf(tabsEl);
    if (menu === null || menu.onSelect === undefined) return;
    const list = menu.items.find((item) => item.id === 'tab-list');
    const children = list?.children;
    if (children === undefined || children.length === 0) return;
    const rect = anchor.getBoundingClientRect();
    openContextMenu({
      x: rect.left,
      y: rect.bottom,
      items: children,
      ariaLabel: '标签列表',
      onSelect: menu.onSelect,
    });
  }, []);

  /** 以下基回调恒定身份（PS-16）：行的 memo 只看值 props，闭包造行参的事留在行内 */
  const onTabDragStart = useCallback((e: ReactDragEvent, p: string): void => {
    e.dataTransfer.setData(TAB_DRAG_MIME, p);
    e.dataTransfer.setData('text/plain', p);
    e.dataTransfer.effectAllowed = 'move';
  }, []);
  const onTabDragOver = useCallback((e: ReactDragEvent, p: string): void => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    // 同一个落点不重复写（PS-6 第 7 项）：旧实现每 mousemove 都 `setTabDropAt({...})`
    // 塞一个新对象 ⇒ 引用必变 ⇒ 标签条每移一个像素整条重渲一次。
    // 提示位只在 (path, before) 真变化时才有新意义，其余一律原样留着同一份 state。
    setTabDropAt((cur) => (cur !== null && cur.path === p && cur.before === before ? cur : { path: p, before }));
  }, []);
  const onTabDrop = useCallback((e: ReactDragEvent, p: string): void => {
    const dragPath = e.dataTransfer.getData(TAB_DRAG_MIME);
    setTabDropAt(null);
    if (!dragPath || dragPath === p) return;
    e.preventDefault();
    const from = openTabs.indexOf(dragPath);
    let to = openTabs.indexOf(p);
    if (from < 0 || to < 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX >= r.left + r.width / 2) to++;
    if (from < to) to--;
    if (from !== to) onReorderTab(dragPath, to);
  }, [openTabs, onReorderTab]);
  const onTabDragEnd = useCallback((): void => setTabDropAt(null), []);

  /** 复制一段文本并给一句轻反馈（照 FileTree copyText 口径：没有剪贴板就说人话） */
  const copyText = useCallback((text: string, okMessage: string): void => {
    const clip = navigator.clipboard;
    if (!clip) {
      notify({ kind: 'error', message: '复制失败：当前环境没有可用的剪贴板' });
      return;
    }
    void clip.writeText(text).then(
      () => notify({ kind: 'info', message: okMessage }),
      () => notify({ kind: 'error', message: '复制失败：剪贴板不可用' }),
    );
  }, [notify]);

  /** 在系统资源管理器中显示（失败由 reveal-explorer 整理成人话，这里只负责上屏） */
  const revealPath = useCallback((path: string): void => {
    void revealInExplorer(path).then(
      () => undefined,
      (error: unknown) => notify({ kind: 'error', message: revealFailureText(error) }),
    );
  }, [notify]);

  /**
   * 「关闭已保存」：清单由 `planCloseSaved` 给（范围与固定标签豁免沿用批量关闭判定），
   * 执行逐个走既有**单标签**关闭链——干净标签不弹确认，脏标签根本不在清单里。
   * 清单为空时给一句人话（铁律 4：按下去必须有响）。
   */
  const closeSaved = useCallback((anchor: string): void => {
    const paths = planCloseSaved(openTabs, anchor, pinnedPaths, dirtyPaths);
    if (paths.length === 0) {
      notify({ kind: 'info', message: CLOSE_SAVED_EMPTY_REASON });
      return;
    }
    for (const p of paths) onRequestCloseTab(p);
  }, [openTabs, pinnedPaths, dirtyPaths, notify, onRequestCloseTab]);

  /**
   * 本组的菜单桥（引用**恒定**，字段每帧刷新）。
   *
   * 不能每帧 `useRef({...})` 造新对象：注册表里存的是首帧那个，之后动作就全是旧闭包。
   * 故先用完整对象占位、之后 `Object.assign` 就地刷新——注册表拿到的对象永远是最新态。
   */
  const bridgeFields: TabsMenuBridge = {
    groupId,
    groupCount,
    openTabs,
    active: activeFile,
    dirtyPaths,
    pinnedPaths,
    rootDir,
    canCloseGroup: onCloseGroup !== undefined && groupCount > 1,
    copyText,
    activate: onActivateTab,
    requestClose: onRequestCloseTab,
    batchClose: onBatchCloseTab,
    togglePin: onTogglePin,
    closeSaved,
    saveAll: onSaveAllClick,
    closeGroup: () => onCloseGroup?.(groupId),
    reveal: revealPath,
  };
  const bridgeRef = useRef<TabsMenuBridge>(bridgeFields);
  Object.assign(bridgeRef.current, bridgeFields);
  useEffect(() => registerTabsMenuBridge(bridgeRef.current), [groupId]);

  return (
    <div className="editor-tabs-bar">
      <div
        ref={tabsRef}
        className="editor-tabs"
        role="tablist"
        data-context-surface="tab-bar-blank"
        data-group-id={groupId}
        onWheel={(e) => {
          // 垂直滚轮转横向滚动（现代编辑器的无感横滚；滚动条隐藏后这是主要滚动途径）
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        {openTabs.map((p) => (
          <TabRow
            key={p}
            p={p}
            isActive={p === activeFile}
            isPinned={pinnedPaths.has(p)}
            isPreview={previewPath === p}
            dirty={dirtyPaths.has(p)}
            hint={tabDropAt?.path === p ? (tabDropAt.before ? 'before' : 'after') : null}
            onActivateTab={onActivateTab}
            onRequestCloseTab={onRequestCloseTab}
            onDragStartBase={onTabDragStart}
            onDragOverBase={onTabDragOver}
            onDropBase={onTabDrop}
            onDragEnd={onTabDragEnd}
          />
        ))}
      </div>
      {/* 溢出 affordance（L16）：真溢出才挂这一族；不溢出时 DOM 里零节点。
          箭头是普通 button ⇒ Tab 可达、Enter/Space 原生触发；无障碍名说成人话。
          左右箭头用注册表里互为镜像的两枚图标，不再靠 CSS 旋转变形。 */}
      {overflowing ? (
        <div className="tab-overflow-tools" role="group" aria-label="标签栏滚动与列表">
          <KitIconButton label="向左滚动标签页" size={14} onClick={() => scrollTabs(-1)}>
            <Icon name="chevron-left" size={14} />
          </KitIconButton>
          <KitIconButton label="向右滚动标签页" size={14} onClick={() => scrollTabs(1)}>
            <Icon name="chevron-right" size={14} />
          </KitIconButton>
          <KitIconButton
            label="列出全部标签"
            size={14}
            hint="列出本组全部标签（点选即切换）"
            onClick={(e) => openTabsList(e.currentTarget)}
          >
            <Icon name="chevron-down" size={14} />
          </KitIconButton>
        </div>
      ) : null}
      {/* 全部保存（C3）：命令面板已有 workbench.saveAll，这里补显性入口——
          恒在（无脏时弱化不消失，按下去由宿主给一句人话，铁律 4） */}
      <button
        className={`tab-save-all${hasDirty ? '' : ' idle'}`}
        title="全部保存（Ctrl+Shift+S）"
        onClick={onSaveAllClick}
      >
        <Icon name="archive" size={14} />
      </button>
    </div>
  );
});
