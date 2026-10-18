/**
 * 一枚编辑器标签（PS-16 自 `tabs-bar.tsx` 拆出，FE-REF ⑤ 同款纪律：模块级 ⇒
 * SSR/计数单测可用；与 `TabBar` 分居两个模块 ⇒ 行级 memo 的渲染计数可以不经
 * 组件内部绑定直接观测）。
 */
import { memo, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { Icon } from './icons';
import { tabClassName } from './tabs-ops';

/** 标签显示名：路径末段（完整路径留 title 悬浮提示） */
export function tabName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export interface TabRowProps {
  readonly p: string;
  readonly isActive: boolean;
  readonly isPinned: boolean;
  readonly dirty: boolean;
  /** 拖拽落点指示（只在命中标签上非空；PS-6 第 7 项的进一步根治——跨行移动时只换两行） */
  readonly hint: 'before' | 'after' | null;
  /** 以下全部恒定身份（宿主 useCallback 产物）：行级 memo 的生效前提 */
  readonly onActivateTab: (p: string) => void;
  readonly onRequestCloseTab: (p: string) => void;
  readonly onContextMenuBase: (e: ReactMouseEvent, p: string) => void;
  readonly onDragStartBase: (e: ReactDragEvent, p: string) => void;
  readonly onDragOverBase: (e: ReactDragEvent, p: string) => void;
  readonly onDropBase: (e: ReactDragEvent, p: string) => void;
  readonly onDragEnd: () => void;
}

/** 一枚标签（PS-16 行级 memo）：值 props + 恒定基回调 ⇒ 落点/活动/脏三态变化只重画命中的行。 */
export const TabRow = memo(function TabRow({
  p,
  isActive,
  isPinned,
  dirty,
  hint,
  onActivateTab,
  onRequestCloseTab,
  onContextMenuBase,
  onDragStartBase,
  onDragOverBase,
  onDropBase,
  onDragEnd,
}: TabRowProps): ReactElement {
  return (
    <div
      role="tab"
      aria-selected={isActive}
      className={tabClassName(p, isActive, isPinned, hint ? { path: p, before: hint === 'before' } : null)}
      title={isPinned ? `${p}（已固定）` : p}
      draggable
      onContextMenu={(e) => onContextMenuBase(e, p)}
      onDragStart={(e) => onDragStartBase(e, p)}
      onDragOver={(e) => onDragOverBase(e, p)}
      onDrop={(e) => onDropBase(e, p)}
      onDragEnd={onDragEnd}
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
      {dirty ? (
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
});