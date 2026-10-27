/**
 * 全站共享右键菜单（用户反馈 7：三面统一 / 磨砂玻璃 / 键盘可达；1023 批：分组 / 子菜单 / 禁用原因）。
 *
 * 设计口径：
 * - **就地渲染**（backdrop + fixed 菜单，无 portal）：菜单跟着触发它的层叠上下文走，
 *   与改造前的 file-tree-menu / tabs-bar 完全同构——套 portal 会把层叠上下文整体搬家，
 *   浮窗 / 面板 / 模态的遮挡关系要重新验一遍。根宿主的**固定层**另见 `context-menu-host.tsx`
 *   （那一层显式抬 z-index，因为它必须盖过模态；就地渲染的这层不抬，行为面与本批之前一字不差）。
 * - **宿主只提供数据**：一条 `ContextMenuItem` 只描述「长什么样」，动作统一走 `onSelect(id)`；
 *   作用域判定与异步通道（重命名输入 / 关闭确认链）仍留在各宿主，组件不知道业务；
 * - **键盘口径照 WAI-ARIA menu**：`role=menu` + `role=menuitem`，打开即聚焦首个可用项，
 *   ↑/↓ 在可用项之间移动（不循环，到边界即停——与 VSCode 菜单一致），Home/End 到首/尾，
 *   可打印字符在 500ms 内累积成查询串、跳到下一个 label 以它开头的可用项（循环），
 *   Enter/Space 由原生 button 触发，Esc 关闭并把焦点还给打开前的元素，Tab 关闭（不困在菜单里，
 *   也不抢浏览器默认的焦点移动）。**子菜单**：→ 打开并聚焦首项、← 收起并回到父项、
 *   Esc 逐级关闭、悬停即开。
 *
 * 视口夹取（clampMenuPosition）是本批的判据点：右键点必然贴着光标，菜单若按固定
 * `min(clientX, innerWidth - 260)` 定位，宽菜单（中文标签 + 快捷键）仍会顶出右缘；
 * 这里在挂载后用**实测尺寸**再夹一次（layout effect，首帧绘制前完成，不闪）。
 * 子菜单同理：先从父项右侧展开，放不下就翻到左侧，再按实测尺寸夹回视口。
 *
 * 模型（`ContextMenuItem` / 夹取 / 键盘落点 / 中文化守卫）在 `context-menu-model.ts`，
 * 本文件只负责把它渲染出来；对外导出面与拆分前完全一致（re-export），既有 import 零改动。
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
import {
  MENU_VIEWPORT_MARGIN,
  clampMenuPosition,
  isPrimaryButton,
  nextMenuIndex,
  type ContextMenuItem,
  type MenuPoint,
} from './context-menu-model';
import '../context-menu.css';

export {
  MENU_VIEWPORT_MARGIN,
  clampMenuPosition,
  nextMenuIndex,
} from './context-menu-model';
export type {
  ContextMenuItem,
  MenuExtent,
  MenuNavigationKey,
  MenuPoint,
  ViewportExtent,
} from './context-menu-model';

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

/** 聚焦面板里第一个可用项（禁用项跳过） */
function focusFirstItem(panel: HTMLElement | null): void {
  const buttons = panel?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]');
  const first = buttons === undefined ? undefined : Array.from(buttons).find((b) => !b.disabled);
  first?.focus({ preventScroll: true });
}

/** 子菜单的初始落点（还没测到自身尺寸前先贴着父项右侧；layout effect 会在一帧内夹正） */
function anchorOrigin(anchor: HTMLElement | null): MenuPoint {
  if (anchor === null) return { left: MENU_VIEWPORT_MARGIN, top: MENU_VIEWPORT_MARGIN };
  const rect = anchor.getBoundingClientRect();
  return { left: rect.right - 2, top: rect.top - 5 };
}

/* --------------------------- 首字母跳转（type-ahead） --------------------------- */
/* 纯函数、零 DOM：本区三个助手与 `nextMenuIndex` 同性质，但只服务键盘渲染这一处，
   故不收进 `context-menu-model.ts`（那是各面共用的数据面，写域在别的批次）。 */

/**
 * type-ahead 的累积窗口（毫秒）。500ms 是 WAI-ARIA menu 与桌面菜单的通行档：
 * 更短会把「新」「建」两下拆成两次首字母跳；更长会让用户停手后敲的字母被拼进上一条查询。
 */
export const TYPE_AHEAD_RESET_MS = 500;

/** 一次按键里与 type-ahead 判据相关的部分（React 合成事件拆出这几个字段即可） */
export interface TypeAheadKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  /** 输入法组合期间（拼音候选未提交）不拦截——否则中文用户一按字母就被抢走 */
  readonly isComposing?: boolean;
}

/**
 * 按键 → 可参与 type-ahead 的字符；不该参与时返回 null。
 *
 * 判据（三条都要过）：单字符、不是空格、不带 Ctrl/Meta/Alt（组合键是命令，不是找项）、
 * 不处于输入法组合期。大小写归一化成小写——菜单项 `label` 多为中文，但快捷键混排的
 * 英文项仍要能用小写敲到大写开头。
 */
export function typeAheadCharOf(event: TypeAheadKeyEvent): string | null {
  if (event.isComposing === true) return null;
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  const key = event.key;
  if (key.length !== 1 || key === ' ') return null;
  return key.toLowerCase();
}

/**
 * 把新字符并进当前查询串（纯函数，窗口由调用侧判）：
 * - 距上次按键超过 `TYPE_AHEAD_RESET_MS` ⇒ 从头开始；
 * - 连续敲**同一个**字符（「打」「打」）⇒ 查询串回到单字符，用来在同类项之间循环
 *   （Windows / VSCode 菜单同口径；否则「打打」永远不命中，第二次按键等于没反应）。
 */
export function nextTypeAheadQuery(previous: string, char: string, elapsedMs: number): string {
  if (previous === '' || elapsedMs > TYPE_AHEAD_RESET_MS) return char;
  if (previous === char.repeat(previous.length)) return char;
  return previous + char;
}

/**
 * 首字母落点（纯函数）：从 `current` 的**下一项**开始找 label 以 `query` 开头的可用项，
 * 绕一圈回到 `current` 为止（循环）；没有命中 ⇒ -1（调用侧据此不 preventDefault）。
 *
 * 匹配口径：`query` 与 label 都转小写后比前缀；disabled 项跳过（与方向键同一档）。
 * `current` 为 -1（刚打开 / 焦点不在项上）时从第 0 项找起。
 */
export function typeAheadIndex(
  items: readonly ContextMenuItem[],
  current: number,
  query: string,
): number {
  const needle = query.toLowerCase();
  if (needle === '' || items.length === 0) return -1;
  const start = current < 0 ? 0 : current + 1;
  for (let step = 0; step < items.length; step++) {
    const index = (start + step) % items.length;
    const item = items[index]!;
    if (item.disabled) continue;
    if (item.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

interface MenuPanelProps {
  readonly items: readonly ContextMenuItem[];
  readonly ariaLabel: string;
  readonly onSelect: (id: string) => void;
  /** 关闭整棵菜单树（Esc 在最外层 / 选中一项） */
  readonly onDismiss: () => void;
  /** 层级：0 = 根面板，>0 = 子菜单（只有根面板归还焦点） */
  readonly depth: number;
  /** 根层：右键点坐标；子层为 null（位置由 anchor 决定） */
  readonly point: MenuPoint | null;
  /** 子层：父项按钮（决定从哪一侧展开） */
  readonly anchor: HTMLElement | null;
  /** 打开时是否自动聚焦首项（鼠标悬停打开 = 不抢焦点） */
  readonly autoFocus: boolean;
  /** 子层：只关自己（父层收到后把焦点还给父项）；根层为 null */
  readonly onCloseSelf: (() => void) | null;
  /**
   * 「关掉时把焦点还给谁」这一个槽：整棵菜单树**共用同一个对象**（由根层创建、逐层传下来）。
   * Tab 关菜单时要把它清成 null —— 焦点已经交给浏览器的默认顺序，卸载清理不能再抓回来。
   */
  readonly focusReturn: { current: HTMLElement | null };
}

function MenuPanel(props: MenuPanelProps): ReactElement {
  const { items, depth, onDismiss, onSelect } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** item.id → 按钮（子菜单定位与「←」回焦都要它） */
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  /** 首字母跳转的累积查询串（每层各自独立：子菜单里敲字母不跳父菜单） */
  const typeAheadRef = useRef({ query: '', at: 0 });
  const [placed, setPlaced] = useState<MenuPoint>(() => props.point ?? anchorOrigin(props.anchor));
  const [openChildId, setOpenChildId] = useState<string | null>(null);
  const [childAutoFocus, setChildAutoFocus] = useState(false);

  // 实测尺寸后再夹一次：layout effect 在首帧绘制前跑完，位置不会闪一下再回弹。
  // setPoint 走「值相等就返回旧对象」——否则每次渲染一个新对象会自激重渲染。
  useIsomorphicLayoutEffect(() => {
    const el = panelRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let next: MenuPoint;
    if (props.point !== null) {
      next = clampMenuPosition(props.point.left, props.point.top, size, viewport);
    } else if (props.anchor !== null) {
      const anchorRect = props.anchor.getBoundingClientRect();
      const fromRight = anchorRect.right - 2;
      // 右侧放不下就翻到左侧（换算成左上角坐标），再由 clamp 兜住上下与左缘
      const left =
        fromRight + size.width > viewport.width - MENU_VIEWPORT_MARGIN
          ? anchorRect.left - size.width + 2
          : fromRight;
      next = clampMenuPosition(left, anchorRect.top - 5, size, viewport);
    } else {
      return;
    }
    setPlaced((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
    // 依赖只用坐标标量：父层每次渲染都新建 `{left, top}` 对象时不该反复重测
  }, [props.point?.left, props.point?.top, props.anchor, items]);

  // 打开后焦点第一项（禁用项跳过）；根层卸载时只在「焦点还在菜单里 / 已落回 body」时归还，
  // 避免把宿主动作后续的自动聚焦（重命名输入框等）抢回来。
  // 「还焦点」这件事也走 `focusReturn` 槽：Tab 关菜单会先把它清空（见 onKeyDown），
  // 那样无论卸载时浏览器把焦点停在哪，清理都不会再把焦点抢回触发处。
  useEffect(() => {
    if (depth > 0) {
      if (props.autoFocus) focusFirstItem(panelRef.current);
      return;
    }
    const previous = document.activeElement;
    props.focusReturn.current = previous instanceof HTMLElement ? previous : null;
    // 面板节点在挂载时抓一次：卸载清理跑的时点，ref 可能已经被摘掉，而 DOM 还在文档里
    // ——那时若拿 ref 判「焦点是否还在菜单内」会误判成「不在」，焦点就还不回去了。
    const panel = panelRef.current;
    focusFirstItem(panelRef.current);
    return () => {
      const target = props.focusReturn.current;
      if (target === null || !target.isConnected) return;
      const active = document.activeElement;
      const stillOurs = panel !== null && active !== null && panel.contains(active);
      if (active !== null && active !== document.body && !stillOurs) return;
      target.focus({ preventScroll: true });
    };
    // 根层只在挂载/卸载时跑（内容变化不该重置「焦点从哪来」）；子层随 autoFocus 变真补一次
    // ——先悬停开后按 → 的路径，靠的就是这一跳。
  }, [props.autoFocus, depth, props.focusReturn]);

  const openChildOf = (id: string | null): ContextMenuItem | undefined =>
    id === null ? undefined : items.find((item) => item.id === id);

  const closeChild = (focusParent: boolean): void => {
    const id = openChildId;
    setOpenChildId(null);
    if (!focusParent || id === null) return;
    itemRefs.current.get(id)?.focus({ preventScroll: true });
  };

  const openChildAt = (index: number, viaKeyboard: boolean): void => {
    const item = items[index];
    if (item?.children === undefined || item.children.length === 0) return;
    setChildAutoFocus(viaKeyboard);
    setOpenChildId(item.id);
  };

  const activeIndex = (): number => {
    const active = document.activeElement;
    if (active === null) return -1;
    for (let i = 0; i < items.length; i++) {
      const el = itemRefs.current.get(items[i]!.id);
      if (el !== undefined && el === active) return i;
    }
    return -1;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        if (openChildId !== null) {
          closeChild(true); // 逐级：先收子菜单，再按一次才关整棵
          return;
        }
        if (props.onCloseSelf !== null) {
          props.onCloseSelf();
          return;
        }
        onDismiss();
        return;
      }
      case 'Tab': {
        // 菜单不困住 Tab：关掉整棵菜单，但**不** preventDefault——焦点按浏览器默认顺序
        // 落到下一个可聚焦元素（菜单是 fixed 层，不关就会「人去楼空，楼还杵在那儿」）。
        // 同时把「还焦点」的槽清空：卸载清理若把焦点抓回触发处，会把 Tab 的落点改写一次。
        props.focusReturn.current = null;
        onDismiss();
        return;
      }
      case 'ArrowRight': {
        const index = activeIndex();
        const item = items[index];
        if (item?.children !== undefined && item.children.length > 0) {
          e.preventDefault();
          openChildAt(index, true);
        }
        return;
      }
      case 'ArrowLeft': {
        if (props.onCloseSelf !== null) {
          e.preventDefault();
          e.stopPropagation();
          props.onCloseSelf();
        }
        return;
      }
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        e.preventDefault();
        const next = nextMenuIndex(items, activeIndex(), e.key);
        if (next >= 0) itemRefs.current.get(items[next]!.id)?.focus();
        return;
      }
      default: {
        // 首字母跳转：可打印字符在 500ms 内累积成查询串，从当前项之后找第一个 label
        // 以它开头的可用项（绕回即循环）。输入法组合期不拦截——那时 key 是拼音字母，
        // 抢走会让中文用户连候选框都敲不出来。没命中就不 preventDefault（按键照常生效）。
        const char = typeAheadCharOf({
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          isComposing: e.nativeEvent.isComposing,
        });
        if (char === null) return;
        const now = Date.now();
        const query = nextTypeAheadQuery(
          typeAheadRef.current.query,
          char,
          now - typeAheadRef.current.at,
        );
        const index = typeAheadIndex(items, activeIndex(), query);
        if (index < 0) {
          // 没命中：查询串丢掉。留着「打」再去敲「开」会一路带着无效前缀，越敲越不中。
          typeAheadRef.current = { query: '', at: now };
          return;
        }
        typeAheadRef.current = { query, at: now };
        e.preventDefault();
        itemRefs.current.get(items[index]!.id)?.focus();
        return;
      }
    }
  };

  // 有图标时整列都留出来（无图标的行也不能让文字左边缘跳一档）
  const hasIcons = items.some((item) => item.icon !== undefined);
  const openChild = openChildOf(openChildId);

  return (
    <>
      <div
        ref={panelRef}
        className={`context-menu context-menu--shared${depth > 0 ? ' context-menu--submenu' : ''}`}
        style={{ left: placed.left, top: placed.top }}
        role="menu"
        aria-orientation="vertical"
        aria-label={props.ariaLabel}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          const hasChildren = item.children !== undefined && item.children.length > 0;
          // 连续同 group 项归一段：只有「本段第一项」画小节头
          const startsGroup =
            item.group !== undefined && (index === 0 || items[index - 1]?.group !== item.group);
          return (
            <Fragment key={item.id}>
              {startsGroup ? (
                <div className="context-menu-group" role="presentation">
                  {item.group}
                </div>
              ) : null}
              {item.dividerBefore && index > 0 ? (
                <div className="context-menu-sep" role="separator" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className={`context-menu-item${item.danger ? ' danger' : ''}`}
                tabIndex={-1}
                disabled={item.disabled}
                aria-checked={item.checked ? true : undefined}
                aria-haspopup={hasChildren ? 'menu' : undefined}
                aria-expanded={hasChildren ? openChildId === item.id : undefined}
                ref={(el) => {
                  if (el === null) itemRefs.current.delete(item.id);
                  else itemRefs.current.set(item.id, el);
                }}
                {...(item.disabledReason === undefined
                  ? {}
                  : { title: item.disabledReason, 'aria-description': item.disabledReason })}
                onMouseEnter={() => {
                  if (hasChildren) {
                    if (openChildId !== item.id) {
                      setChildAutoFocus(false);
                      setOpenChildId(item.id);
                    }
                    return;
                  }
                  if (openChildId !== null) setOpenChildId(null);
                }}
                onClick={() => {
                  if (hasChildren) {
                    // 父项不执行动作：点一下开/收子菜单（键盘 Enter/Space 同一条路）
                    setChildAutoFocus(false);
                    setOpenChildId((prev) => (prev === item.id ? null : item.id));
                    return;
                  }
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
                {hasChildren ? (
                  <span className="context-menu-arrow" aria-hidden="true">
                    <Icon name="chevron-right" size="xs" />
                  </span>
                ) : null}
              </button>
            </Fragment>
          );
        })}
      </div>
      {openChild === undefined ? null : (
        <MenuPanel
          key={openChild.id}
          items={openChild.children ?? []}
          ariaLabel={openChild.label}
          onSelect={onSelect}
          onDismiss={onDismiss}
          depth={depth + 1}
          point={null}
          anchor={itemRefs.current.get(openChild.id) ?? null}
          autoFocus={childAutoFocus}
          onCloseSelf={() => closeChild(true)}
          focusReturn={props.focusReturn}
        />
      )}
    </>
  );
}

/** 根菜单：遮罩挡住外点，面板自己夹取位置。组件自本批起复用同一套 MenuPanel。 */
export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onDismiss,
  ariaLabel,
}: ContextMenuProps): ReactElement {
  /** 整棵树的「关掉还焦点给谁」（Tab 关菜单时清空它，见 MenuPanel 的 onKeyDown） */
  const focusReturn = useRef<HTMLElement | null>(null);
  return (
    <>
      <div
        className="context-menu-backdrop"
        onMouseDown={(e) => {
          // 遮罩只认左键（`isPrimaryButton`，全仓唯一判据）：右键是**开菜单**的手势，
          // 拿它在遮罩上按一下就把菜单关掉，接着 `onContextMenu` 又把 contextmenu 吃掉
          // ⇒ 用户读到的是「右键点外面，菜单没了、新的也不出来」。这条与 Palette /
          // ShellLayout / SettingsPanel 三处遮罩同一口径（此前本处是漏掉的第四份）。
          if (!isPrimaryButton(e)) return;
          onDismiss();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <MenuPanel
        items={items}
        ariaLabel={ariaLabel ?? '菜单'}
        onSelect={onSelect}
        onDismiss={onDismiss}
        depth={0}
        point={{ left: x, top: y }}
        anchor={null}
        autoFocus
        onCloseSelf={null}
        focusReturn={focusReturn}
      />
    </>
  );
}
