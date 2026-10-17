/**
 * 文件树右键菜单（FE-REF ⑤ 自 `FileTree.tsx` 的渲染尾部逐字搬出）。
 *
 * **形态口径不许顺手"优化"**：菜单**就地内联**渲染（没有 portal），所以它跟着
 * `.file-tree` 的层叠上下文走；横向 260px 夹取在宿主的 `openMenu` 里（`Math.min(e.clientX,
 * window.innerWidth - 260)`），改成按菜单实测宽度定位属于行为改动，不在本批范围。
 * root / group 两个作用域沿用既有实现（可逆的全展开开关），file/dir/package 走
 * `file-tree-ops.menuItemsFor` 的能力表——没有能力的动作**整项不显示**（铁律 4）。
 */
import { type ReactElement } from 'react';
import { menuItemsFor, type MenuCapability, type MenuItemId } from './file-tree-ops';
import type { MenuScope } from './file-tree-types';

export interface FileTreeContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly scope: MenuScope;
  readonly capability: MenuCapability;
  /** root 作用域的菜单文案（**惰性**求值：每次渲染都扫全树算"是否已全展开"是白干的） */
  readonly revealLabel: () => string;
  /** root：展开/收起可逆开关（作用域外的组/包一并处理，见 file-tree-reveal） */
  readonly onToggleReveal: () => void;
  /** group：显示该作用域内所有文件和文件夹 */
  readonly onRevealScope: (scope: MenuScope) => void;
  /** 关闭菜单（root 分支原先就是"先关再动"，顺序照抄） */
  readonly onDismiss: () => void;
  readonly onAction: (id: MenuItemId, scope: MenuScope) => void;
}

export function FileTreeContextMenu(props: FileTreeContextMenuProps): ReactElement {
  const { scope } = props;
  return (
    <>
      <div className="context-menu-backdrop" onMouseDown={props.onDismiss} />
      <div className="context-menu" style={{ left: props.x, top: props.y }} role="menu" aria-orientation="vertical">
        {scope.kind === 'root' || scope.kind === 'group' ? (
          <button
            role="menuitem"
            onClick={() => {
              if (scope.kind === 'root') {
                props.onDismiss();
                props.onToggleReveal();
              } else {
                props.onRevealScope(scope);
              }
            }}
          >
            <span className="check" />
            {scope.kind === 'root' ? props.revealLabel() : '显示所有文件和文件夹'}
          </button>
        ) : (
          menuItemsFor(scope.kind, props.capability).map((item, i) => (
            <div key={item.id} role="none">
              {item.dividerBefore && i > 0 ? <div className="context-menu-sep" role="separator" /> : null}
              <button
                role="menuitem"
                className={item.id === 'delete' ? 'danger' : undefined}
                onClick={() => props.onAction(item.id, scope)}
              >
                <span className="check" />
                {item.label}
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
