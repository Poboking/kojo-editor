import { memo, useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { ContextMenu, type ContextMenuItem } from './context-menu';
import { Icon } from './icons';
import { useNotify } from './NotificationCenter';
import { TabRow } from './tab-row';
import { tabMenuItemsFor, type BatchCloseMode, type TabDropHint, type TabMenuItemId } from './tabs-ops';

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
  /** 「全部保存」按钮的落地面（脏态判断与轻反馈都在宿主 ProjectView，按钮恒在——铁律 4） */
  onSaveAllClick: () => void;
  /** 有没有脏标签（保存按钮弱化显示的依据；弱化 ≠ 消失） */
  hasDirty: boolean;
}

/**
 * 标签栏（模块级 ⇒ SSR 单测可用，照 FileRows 先例）：标签序列 + 右键菜单 + 全部保存按钮。
 *
 * - **拖拽重排**：落点指示照旧（drop-before / drop-after）；跨固定区分界的处置
 *   （自动改固定态）在宿主的 planReorder 里，这里只报落点；
 * - **右键菜单**：壳层私有轻量实现，形态照 FileTree 的 menu state（backdrop + .context-menu）；
 *   菜单本体走共享 `<ContextMenu>`（用户反馈 7：与文件树 / 编辑器同一套玻璃观感与键盘操作）
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
}: TabBarProps): ReactElement {
  const notify = useNotify();
  /** 标签拖拽的自定义 MIME（只在标签条内部流转，防外部拖入误触发） */
  const TAB_DRAG_MIME = 'application/x-kojo-tab-move';
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabDropAt, setTabDropAt] = useState<TabDropHint | null>(null);
  /** 标签右键菜单（C1；形态照 FileTree 的 menu state） */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // 活动标签保持可见（标签多到溢出时，点击树中文件也能定位到对应标签）
  useEffect(() => {
    tabsRef.current
      ?.querySelector('.editor-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFile, openTabs.length]);

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

  const openMenu = useCallback((e: ReactMouseEvent, path: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 260), y: e.clientY, path });
  }, []);

  /** 复制路径（C1）：navigator.clipboard + 一句轻反馈（照 FileTree copyText 口径） */
  const copyPath = useCallback((path: string): void => {
    const clip = navigator.clipboard;
    if (!clip) {
      notify({ kind: 'error', message: '复制失败：当前环境没有可用的剪贴板' });
      return;
    }
    void clip.writeText(path).then(
      () => notify({ kind: 'info', message: '已复制完整路径' }),
      () => notify({ kind: 'error', message: '复制失败：剪贴板不可用' }),
    );
  }, [notify]);

  const runMenuAction = (id: TabMenuItemId): void => {
    const path = menu?.path;
    setMenu(null);
    if (!path) return;
    switch (id) {
      case 'close':
        onRequestCloseTab(path);
        break;
      case 'close-others':
        onBatchCloseTab('others', path);
        break;
      case 'close-right':
        onBatchCloseTab('right', path);
        break;
      case 'close-all':
        onBatchCloseTab('all', path);
        break;
      case 'toggle-pin':
        onTogglePin(path);
        break;
      case 'copy-path':
        copyPath(path);
        break;
    }
  };

  return (
    <div className="editor-tabs-bar">
      <div
        ref={tabsRef}
        className="editor-tabs"
        role="tablist"
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
            dirty={dirtyPaths.has(p)}
            hint={tabDropAt?.path === p ? (tabDropAt.before ? 'before' : 'after') : null}
            onActivateTab={onActivateTab}
            onRequestCloseTab={onRequestCloseTab}
            onContextMenuBase={openMenu}
            onDragStartBase={onTabDragStart}
            onDragOverBase={onTabDragOver}
            onDropBase={onTabDrop}
            onDragEnd={onTabDragEnd}
          />
        ))}
      </div>
      {/* 全部保存（C3）：命令面板已有 workbench.saveAll，这里补显性入口——
          恒在（无脏时弱化不消失，按下去由宿主给一句人话，铁律 4） */}
      <button
        className={`tab-save-all${hasDirty ? '' : ' idle'}`}
        title="全部保存（Ctrl+Shift+S）"
        onClick={onSaveAllClick}
      >
        <Icon name="archive" size={14} />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={tabMenuItemsFor(pinnedPaths.has(menu.path)).map(
            (item): ContextMenuItem => ({
              id: item.id,
              label: item.label,
              shortcut: item.shortcut,
              dividerBefore: item.dividerBefore,
            }),
          )}
          ariaLabel="标签操作"
          onSelect={(id) => runMenuAction(id as TabMenuItemId)}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
});
