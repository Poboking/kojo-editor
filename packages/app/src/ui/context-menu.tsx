/**
 * 全站共享右键菜单（用户反馈 7：三面统一 / 磨砂玻璃 / 键盘可达）。
 *
 * 设计口径：
 * - **就地渲染**（backdrop + fixed 菜单，无 portal）：菜单跟着触发它的层叠上下文走，
 *   与改造前的 file-tree-menu / tabs-bar 完全同构——套 portal 会把层叠上下文整体搬家，
 *   浮窗 / 面板 / 模态的遮挡关系要重新验一遍，不在本条范围；
 * - **宿主只提供数据**：一条 `ContextMenuItem` 只描述「长什么样」，动作统一走 `onSelect(id)`；
 *   作用域判定与异步通道（重命名输入 / 关闭确认链）仍留在各宿主，组件不知道业务；
 * - **键盘口径照 WAI-ARIA menu**：`role=menu` + `role=menuitem`，打开即聚焦首个可用项，
 *   ↑/↓ 在可用项之间移动（不循环，到边界即停——与 VSCode 菜单一致），Home/End 到首/尾，
 *   Enter/Space 由原生 button 触发，Esc 关闭并把焦点还给打开前的元素，Tab 关闭（不困在菜单里）。
 *
 * 视口夹取（clampMenuPosition）是本批的判据点：右键点必然贴着光标，菜单若按固定
 * `min(clientX, innerWidth - 260)` 定位，宽菜单（中文标签 + 快捷键）仍会顶出右缘；
 * 这里在挂载后用**实测尺寸**再夹一次（layout effect，首帧绘制前完成，不闪）。
 * 单纯函数单独导出，node 侧可测（packages/app/tests/context-menu.test.ts）。
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { Icon } from './icons';
import '../context-menu.css';

/** 一条菜单项（数据面：动作由 onSelect 统一接线，组件不认识业务 id） */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  /** icons.tsx 的内置图标名；不命中注册表时按字形渲染（与 Icon 组件同口径） */
  readonly icon?: string;
  /** 右侧快捷键提示（纯展示；真正的键位由各命令的注册处负责） */
  readonly shortcut?: string;
  /** 破坏性动作：危险色 + 勾选列的 `!` 提示（不只靠颜色） */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** 在这一项**之前**画一条分隔线（首项的分隔线由渲染侧吞掉） */
  readonly dividerBefore?: boolean;
  /** 选中态（勾选列打勾）；按钮同时带 aria-checked 上屏 */
  readonly checked?: boolean;
}

export interface MenuPoint {
  readonly left: number;
  readonly top: number;
}

export interface MenuExtent {
  readonly width: number;
  readonly height: number;
}

export interface ViewportExtent {
  readonly width: number;
  readonly height: number;
}

/** 菜单与视口边缘的最小呼吸（= styles.css 的 `--space-1`） */
export const MENU_VIEWPORT_MARGIN = 4;

/** 视口夹取（纯函数）：两个方向都夹；菜单比视口还大时贴住左上边距，绝不出现负坐标 */
export function clampMenuPosition(
  x: number,
  y: number,
  size: MenuExtent,
  viewport: ViewportExtent,
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuPoint {
  const maxLeft = viewport.width - size.width - margin;
  const maxTop = viewport.height - size.height - margin;
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  };
}

export type MenuNavigationKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * 键盘落点（纯函数）：返回下一个**可用**项下标；没有可用项 → -1。
 *
 * - ↑/↓ 跳过 disabled，到边界即停（不循环）；
 * - current 不在任何项上（-1，刚打开）时：↓ 落首个可用项，↑ 落末个可用项；
 * - Home/End 直接到首/尾可用项。
 */
export function nextMenuIndex(
  items: readonly ContextMenuItem[],
  current: number,
  key: MenuNavigationKey,
): number {
  const enabled: number[] = [];
  for (let i = 0; i < items.length; i++) if (!items[i]!.disabled) enabled.push(i);
  if (enabled.length === 0) return -1;
  switch (key) {
    case 'Home':
      return enabled[0]!;
    case 'End':
      return enabled[enabled.length - 1]!;
    case 'ArrowDown': {
      for (const i of enabled) if (i > current) return i;
      return enabled[enabled.length - 1]!;
    }
    case 'ArrowUp': {
      if (current < 0) return enabled[enabled.length - 1]!;
      for (let k = enabled.length - 1; k >= 0; k--) if (enabled[k]! < current) return enabled[k]!;
      return enabled[0]!;
    }
  }
}

export interface ContextMenuProps {
  /** 打开位置（视口坐标，通常是右键事件的 clientX/clientY） */
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onSelect: (id: string) => void;
  readonly onDismiss: () => void;
  /** 无障碍名称（默认「菜单」；三面各给一个更具体的） */
  readonly ariaLabel?: string;
}

/** SSR（node 单测）没有 layout 阶段：退回 useEffect，避免 React 的 useLayoutEffect 警告 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onDismiss,
  ariaLabel,
}: ContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 打开前的焦点（键盘 Esc / 选中后归还；鼠标打开时多半是 body，focus 无副作用） */
  const restoreRef = useRef<HTMLElement | null>(null);
  const [point, setPoint] = useState<MenuPoint>({ left: x, top: y });

  // 实测尺寸后再夹一次：layout effect 在首帧绘制前跑完，位置不会闪一下再回弹。
  // setPoint 走「值相等就返回旧对象」——否则每次渲染一个新对象会自激重渲染。
  useIsomorphicLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuPosition(
      x,
      y,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPoint((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [x, y, items]);

  // 打开后焦点第一项（禁用项跳过）；卸载时只在「焦点还在菜单里 / 已落回 body」时归还，
  // 避免把宿主动作后续的自动聚焦（重命名输入框等）抢回来。
  useEffect(() => {
    const previous = document.activeElement;
    restoreRef.current = previous instanceof HTMLElement ? previous : null;
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]');
    const first = buttons === undefined ? undefined : Array.from(buttons).find((b) => !b.disabled);
    first?.focus({ preventScroll: true });
    return () => {
      const target = restoreRef.current;
      if (target === null || !target.isConnected) return;
      const active = document.activeElement;
      const menu = menuRef.current;
      const stillOurs = menu !== null && active !== null && menu.contains(active);
      if (active !== null && active !== document.body && !stillOurs) return;
      target.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }
    if (e.key === 'Tab') {
      // 菜单不困住 Tab：关掉并把焦点交还，后续 Tab 从触发处继续
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [],
    );
    const current = buttons.findIndex((b) => b === document.activeElement);
    const next = nextMenuIndex(items, current, e.key);
    if (next >= 0) buttons[next]?.focus();
  };

  // 有图标时整列都留出来（无图标的行也不能让文字左边缘跳一档）
  const hasIcons = items.some((item) => item.icon !== undefined);

  return (
    <>
      <div
        className="context-menu-backdrop"
        onMouseDown={onDismiss}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={menuRef}
        className="context-menu context-menu--shared"
        style={{ left: point.left, top: point.top }}
        role="menu"
        aria-orientation="vertical"
        aria-label={ariaLabel ?? '菜单'}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {item.dividerBefore && index > 0 ? <div className="context-menu-sep" role="separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`context-menu-item${item.danger ? ' danger' : ''}`}
              tabIndex={-1}
              disabled={item.disabled}
              aria-checked={item.checked ? true : undefined}
              onClick={() => {
                onSelect(item.id);
                onDismiss();
              }}
            >
              <span className="check" aria-hidden="true" />
              {hasIcons ? (
                <span className="context-menu-icon" aria-hidden="true">
                  {item.icon === undefined ? null : <Icon name={item.icon} size={14} />}
                </span>
              ) : null}
              <span className="context-menu-label">{item.label}</span>
              {item.shortcut === undefined ? null : (
                <kbd className="context-menu-shortcut">{item.shortcut}</kbd>
              )}
            </button>
          </Fragment>
        ))}
      </div>
    </>
  );
}
