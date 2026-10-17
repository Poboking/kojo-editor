/**
 * 文件树右键菜单（用户反馈 7：改用共享 `<ContextMenu>`，行为面不动）。
 *
 * **形态口径不许顺手"优化"**：菜单仍**就地渲染**（共享组件没有 portal），所以它跟着
 * `.file-tree` 的层叠上下文走；横向 260px 预夹取仍留在宿主的 `openMenu`
 * （`Math.min(e.clientX, window.innerWidth - 260)`），共享组件再用实测宽度在视口内补夹一次
 * ——只收窄、不放大，旧语义（不顶出右缘）保持不变。
 * root / group 两个作用域沿用既有实现（可逆的全展开开关），file/dir/package 走
 * `file-tree-ops.menuItemsFor` 的能力表——没有能力的动作**整项不显示**（铁律 4）。
 */
import { type ReactElement } from 'react';
import { ContextMenu, type ContextMenuItem } from './context-menu';
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
  const items: ContextMenuItem[] =
    scope.kind === 'root' || scope.kind === 'group'
      ? [
          {
            id: 'toggle-reveal',
            label: scope.kind === 'root' ? props.revealLabel() : '显示所有文件和文件夹',
          },
        ]
      : menuItemsFor(scope.kind, props.capability).map((item) => ({
          id: item.id,
          label: item.label,
          icon: item.icon,
          shortcut: item.shortcut,
          danger: item.id === 'delete',
          dividerBefore: item.dividerBefore,
        }));

  return (
    <ContextMenu
      x={props.x}
      y={props.y}
      items={items}
      ariaLabel={scope.kind === 'file' || scope.kind === 'dir' ? '文件操作' : '目录操作'}
      onSelect={(id) => {
        if (scope.kind === 'root') {
          // 先关再动：菜单收起后才改展开态（旧实现的顺序，照抄）
          props.onDismiss();
          props.onToggleReveal();
          return;
        }
        if (scope.kind === 'group') {
          props.onRevealScope(scope);
          return;
        }
        props.onAction(id as MenuItemId, scope);
      }}
      onDismiss={props.onDismiss}
    />
  );
}
