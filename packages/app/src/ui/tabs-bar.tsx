import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { Icon } from './icons';
import { useNotify } from './NotificationCenter';
import { tabClassName, tabMenuItemsFor, type BatchCloseMode, type TabDropHint, type TabMenuItemId } from './tabs-ops';

/**
 * 标签栏（C1 右键菜单 / C2 固定标签 / C3 全部保存入口）。
 *
 * **独立成模块**（不与 ProjectView 同文件）：ProjectView 静态引入 EditorPane →
 * monaco 全图，SSR 单测在 node 里一 import 就炸（window is not defined）；
 * 标签栏自身只依赖 Icon / NotificationCenter / tabs-ops，零编辑器知识。
 * 顺序照单全收（pinned 区在前的排序不变量由 App 经 tabs-ops 维持），渲染层不二次排序。
 */

/** 标签显示名：路径末段（完整路径留 title 悬浮提示） */
function tabName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

interface TabBarProps {
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
 * - **固定标签**：左缘竖标 + 关闭钮不渲染（防误关；显式关闭走右键菜单「关闭」）。
 */
export function TabBar({
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

  const onTabDragStart = (e: ReactDragEvent, p: string): void => {
    e.dataTransfer.setData(TAB_DRAG_MIME, p);
    e.dataTransfer.setData('text/plain', p);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onTabDragOver = (e: ReactDragEvent, p: string): void => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    setTabDropAt({ path: p, before: e.clientX < r.left + r.width / 2 });
  };
  const onTabDrop = (e: ReactDragEvent, p: string): void => {
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
  };
  const onTabDragEnd = (): void => setTabDropAt(null);

  const openMenu = (e: ReactMouseEvent, path: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 260), y: e.clientY, path });
  };

  /** 复制路径（C1）：navigator.clipboard + 一句轻反馈（照 FileTree copyText 口径） */
  const copyPath = (path: string): void => {
    const clip = navigator.clipboard;
    if (!clip) {
      notify({ kind: 'error', message: '复制失败：当前环境没有可用的剪贴板' });
      return;
    }
    void clip.writeText(path).then(
      () => notify({ kind: 'info', message: '已复制完整路径' }),
      () => notify({ kind: 'error', message: '复制失败：剪贴板不可用' }),
    );
  };

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
        {openTabs.map((p) => {
          const isPinned = pinnedPaths.has(p);
          return (
            <div
              key={p}
              role="tab"
              aria-selected={p === activeFile}
              className={tabClassName(p, p === activeFile, isPinned, tabDropAt)}
              title={isPinned ? `${p}（已固定）` : p}
              draggable
              onContextMenu={(e) => openMenu(e, p)}
              onDragStart={(e) => onTabDragStart(e, p)}
              onDragOver={(e) => onTabDragOver(e, p)}
              onDrop={(e) => onTabDrop(e, p)}
              onDragEnd={onTabDragEnd}
              onClick={() => onActivateTab(p)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onRequestCloseTab(p);
                }
              }}
            >
              {isPinned ? <span className="tab-pin" title="已固定（右键可取消固定）" /> : null}
              <span className="tab-label">{tabName(p)}</span>
              {dirtyPaths.has(p) ? (
                <span className="tab-dirty" title="未保存">
                  <Icon name="circle-filled" size={9} />
                </span>
              ) : null}
              {/* 固定标签不渲染关闭钮（防误关，VSCode 同款）；显式关闭走右键菜单 */}
              {!isPinned ? (
                <button
                  className="tab-close"
                  title="关闭标签 (Ctrl+W)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestCloseTab(p);
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              ) : null}
            </div>
          );
        })}
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
        <>
          <div className="context-menu-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            {tabMenuItemsFor(menu.path !== null && pinnedPaths.has(menu.path)).map((item, i) => (
              <div key={item.id}>
                {item.dividerBefore && i > 0 ? <div className="context-menu-sep" role="separator" /> : null}
                <button role="menuitem" onClick={() => runMenuAction(item.id)}>
                  <span className="check" />
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
