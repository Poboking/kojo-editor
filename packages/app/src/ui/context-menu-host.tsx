/**
 * 右键菜单的**根宿主**（1023 批）：一个模块级小 store + 一个固定层渲染器。
 *
 * 为什么要这一层：各面自己的菜单是**就地渲染**的（跟着那个面板的层叠上下文走），但根路由
 * 在 `App` 的 `.app-frame` 上，那一层下面压着模态 / 浮动窗 / 通知，菜单若不进固定层就会被
 * 遮住。所以根菜单统一走这里：状态机在模块级（谁都能开，不用把回调穿过十几层 props），
 * 渲染在 App 根部。
 *
 * 层级依据（实测自 `styles.css` / `styles-project.css`）：
 * - `--z-overlay = 1000`（拖拽遮罩 / 覆盖层）、`--z-modal = 1100`（模态）；
 * - `styles-project.css` 另有一批裸 `z-index: 1200`（提示类浮层）；
 * - 既有 `.context-menu` 是 `calc(--z-modal + 1)` = 1101，那是给就地渲染的；
 *   根宿主必须**压过以上全部**，故取 1300（见 `context-menu.css` 的 `.context-menu-host`）。
 *
 * 关闭语义：Esc / 外点 / 选中一项都由 `<ContextMenu>` 自己收口（它调 `onDismiss`），
 * 这里再把 `request.onDismiss` 回调出去——各面据此清理「菜单开着时的临时态」。
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import { ContextMenu } from './context-menu';
import { filterChineseMenuItems, type ContextMenuItem } from './context-menu-model';

/** 一次打开请求（数据 + 动作 + 来源，宿主不认识业务） */
export interface ContextMenuRequest {
  /** 视口坐标（通常是右键事件的 clientX/clientY；键盘锚点自行折算） */
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly ariaLabel: string;
  readonly onSelect: (id: string) => void;
  /** 菜单被关掉时（Esc / 外点 / 选中 / 被下一次打开顶掉）回调，用于清临时态 */
  readonly onDismiss?: () => void;
  /** 来源面 id（调试 / 取证用；不参与行为） */
  readonly source?: string;
}

export interface ContextMenuState {
  readonly request: ContextMenuRequest | null;
}

/** 快照必须**引用稳定**（useSyncExternalStore 的判等靠它），只在真变化时换对象 */
let state: ContextMenuState = { request: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 订阅（React 侧经 useSyncExternalStore 消费；返回退订函数） */
export function subscribeContextMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前状态（纯读；测试与根路由都用它） */
export function getContextMenuState(): ContextMenuState {
  return state;
}

/** 关掉当前菜单并回调它的 `onDismiss`（没有开着的菜单时是**幂等空操作**） */
export function closeContextMenu(): void {
  const current = state.request;
  if (current === null) return;
  state = { request: null };
  emit();
  current.onDismiss?.();
}

/**
 * 打开菜单。已有菜单开着时先按「被顶掉」收口（旧请求拿到 `onDismiss`），再换新的
 * ——切换两次右键不能留下两个叠在一起的菜单，也不能让旧面以为自己还开着。
 */
export function openContextMenu(request: ContextMenuRequest): void {
  const current = state.request;
  if (current !== null) {
    state = { request: null };
    emit();
    current.onDismiss?.();
  }
  state = { request };
  emit();
}

/**
 * 根宿主（挂到 App 的 `.app-frame` 内、所有浮层之后）。
 *
 * 渲染前过一遍中文化守卫：插件 / 语言服务贡献的英文项整项丢弃（宿主是最后一站，
 * 不能指望每个面都记得过滤）。过滤后为空 ⇒ 什么都不渲染（不弹一个空壳）。
 */
export function ContextMenuHost(): ReactElement | null {
  const snapshot = useSyncExternalStore(subscribeContextMenu, getContextMenuState, getContextMenuState);
  const request = snapshot.request;
  if (request === null) return null;
  const items = filterChineseMenuItems(request.items);
  if (items.length === 0) return null;
  return (
    <div className="context-menu-host">
      <ContextMenu
        x={request.x}
        y={request.y}
        items={items}
        ariaLabel={request.ariaLabel}
        onSelect={request.onSelect}
        onDismiss={closeContextMenu}
      />
    </div>
  );
}
