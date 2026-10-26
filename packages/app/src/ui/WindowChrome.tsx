/**
 * 常驻窗口框架（用户反馈第 9 条：任何窗口态都不要 Windows 原生标题栏）。
 *
 * 窗口在 `tauri.conf.json` 里就是 `decorations: false`，本组件从启动到退出一直挂在
 * App 根部：欢迎页 / 项目态 / 禅模式共用同一条 34px 标题栏，最大化与全屏都不再长出
 * 系统白条。浏览器 dev 没有壳（`isTauri()` 为 false）⇒ 返回 null，不画一条点不动的
 * 假按钮；此时也没有 `data-window-state`，自绘外框不出现。
 *
 * 形态对标 VS Code 标题栏：左侧品牌气泡记号（`ChromeBrandMark`，P3-4）+ 应用名 + 整段可拖
 * 空白区，右侧
 * 最小化 / 最大化（全屏时换成退出全屏）/ 关闭。双击整条栏最大化 / 还原。
 * 纯状态映射 `chromeActionsOf` / `windowStateOf` 独立可测，三态（普通 / 最大化 /
 * 全屏）的按钮序列与图标都在那里定死。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import { isTauri } from '../bridge/invoke';
import { Icon, type IconName } from './icons';
import { registerIdentityBandSlot, useIdentityBandFilled } from './identity-band';
import {
  canStartWindowDragFrom,
  closeWindow,
  exitFullscreen,
  minimizeWindow,
  prepareWindowDrag,
  subscribeWindowState,
  toggleMaximize,
  type WindowDragStarter,
  type WindowState,
} from './window-fullscreen';
import '../window-chrome.css';

export interface WindowChromeProps {
  /** 左侧应用名（缺省即产品名） */
  title?: string;
}

/** 右侧按钮的动作身份（点击分发与图标 / 标签映射共用一份词表） */
export type ChromeActionId = 'minimize' | 'maximize' | 'restore' | 'exit-fullscreen' | 'close';

export interface ChromeAction {
  id: ChromeActionId;
  /** 内置单色图标名（16×16，跟随 currentColor） */
  icon: IconName;
  /** aria-label 与 title 共用的中文动作名 */
  label: string;
}

/** 窗口状态 → 自绘边框选择器用的根属性值（CSS 只认这三个字面量） */
export type ChromeWindowState = 'normal' | 'maximized' | 'fullscreen';

/** 三态映射：全屏压过最大化（全屏时 Windows 报的 maximized 不可作为 UI 依据） */
export function windowStateOf(state: WindowState): ChromeWindowState {
  if (state.fullscreen) return 'fullscreen';
  return state.maximized ? 'maximized' : 'normal';
}

/**
 * 标题栏按钮序列（右起顺序：最小化 → 最大化/还原/退出全屏 → 关闭）。
 * 全屏时把最大化换成「退出全屏」，最小化与关闭保留；关闭恒在最后、恒为红底 hover。
 */
export function chromeActionsOf(state: WindowState): readonly ChromeAction[] {
  const middle: ChromeAction = state.fullscreen
    ? { id: 'exit-fullscreen', icon: 'exit-fullscreen', label: '退出全屏' }
    : state.maximized
      ? { id: 'restore', icon: 'restore', label: '还原' }
      : { id: 'maximize', icon: 'maximize', label: '最大化' };
  return [
    { id: 'minimize', icon: 'minimize', label: '最小化' },
    middle,
    { id: 'close', icon: 'close', label: '关闭窗口' },
  ];
}

/** 动作分发（按钮点击；双击标题栏走 toggleMaximize 特例） */
function runChromeAction(id: ChromeActionId): void {
  switch (id) {
    case 'minimize':
      void minimizeWindow();
      return;
    case 'maximize':
    case 'restore':
      void toggleMaximize();
      return;
    case 'exit-fullscreen':
      void exitFullscreen();
      return;
    case 'close':
      void closeWindow();
      return;
  }
}

/**
 * 标题栏那串可读名（VIS-11 · D-8）：`windowTitleFor` 给的是 `<项目目录名> — kojo-editor`。
 * 工具条并进身份带后，带里 `.tb-project` 已经把项目名报过一遍 ⇒ 这里只留**破折号后面**
 * 那段产品名，同一行同一个名字不许出现两次；没有破折号（无项目）时原样返回。
 * 纯函数、独立可测；`title` 悬停属性仍给完整那串（窗口标题三处同源的口径不动）。
 */
export function bandTitleOf(title: string): string {
  const at = title.lastIndexOf(' — ');
  return at < 0 ? title : title.slice(at + 3);
}

/**
 * 品牌记号（P3-4）：一枚极简「对话框 / 口上」气泡——纯内联 SVG（单 path，evenodd 挖三枚
 * 点），零图片资源、零依赖。形状走 `fill="currentColor"`，颜色档位由 CSS token 给
 * （`.window-chrome-mark` 上 `color: var(--accent)`），三主题自动跟随；欢迎页用同一形状的
 * mask 版（welcome.css），两处品牌同源一个图形。通用「口上」意象，不含任何具体游戏/角色名。
 */
export function ChromeBrandMark(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      focusable="false"
      data-tauri-drag-region
    >
      <path d="M3 1.6h10a2.4 2.4 0 0 1 2.4 2.4v5a2.4 2.4 0 0 1-2.4 2.4H7.3L4 14.1v-2.7H3A2.4 2.4 0 0 1 .6 9V4A2.4 2.4 0 0 1 3 1.6Zm1.45 4.9a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0Zm2.5 0a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0Zm2.5 0a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0Z" />
    </svg>
  );
}

/**
 * 浏览器 dev / node 测试：没有壳就不渲染（先判后挂 hooks，钩子次序不受影响）。
 * 真壳里恒走 `WindowChromeFrame`，从首帧起就是自定义框架。
 */
export function WindowChrome(props: WindowChromeProps): ReactElement | null {
  if (!isTauri()) return null;
  return <WindowChromeFrame {...props} />;
}

export function WindowChromeFrame({ title = 'kojo-editor' }: WindowChromeProps): ReactElement {
  const [state, setState] = useState<WindowState>({ fullscreen: false, maximized: false });
  /** 工具条有没有并进本带（决定标题只报产品名还是报全串） */
  const bandFilled = useIdentityBandFilled();

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void subscribeWindowState(setState).then((off) => {
      // 订阅返回前组件已卸载：立刻退订，别把监听留给下一个实例
      if (disposed) off();
      else unsubscribe = off;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  /**
   * 自绘外框的状态源：CSS 用 `:root[data-window-state=…]` 决定是否画 1px 外圈。
   * 卸载时清掉属性（别把「普通窗口」的边框留给下一个挂载者 / 浏览器 dev 快照）。
   */
  const windowState = windowStateOf(state);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.windowState = windowState;
    return () => {
      delete root.dataset.windowState;
    };
  }, [windowState]);

  /**
   * 同步拖动发起器（照弹窗那条同一个口径）：`startDragging` 必须在 mousedown 调用栈里
   * 同步发出，等一拍 await 就丢手势 ⇒ 挂载时预载，卸载后落到 no-op。
   */
  const dragStarterRef = useRef<WindowDragStarter>(() => {});
  useEffect(() => {
    let alive = true;
    void prepareWindowDrag().then((starter) => {
      if (alive) dragStarterRef.current = starter;
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 双击整条栏 = 最大化 / 还原（与 VS Code 一致；全屏下由系统决定是否生效，
   * 失败只在 window-fullscreen 里 warn）。
   *
   * 判据取 mousedown 的 `detail === 2` 而不是 `dblclick`：第一次 mousedown 会触发
   * Tauri 的 start_dragging，WebView 可能收不到随后的 mouseup，dblclick 不保证送达
   * （Tauri 自己的 drag.js 也在第二次 mousedown 上做最大化）。这里同时截下那次
   * mousedown，避免 Tauri 的 internal_toggle_maximize 与我们的 toggleMaximize 各切一次。
   */
  const onBarMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button') !== null) return;
    if (e.detail !== 2) return;
    // 与 drag.js 同款：压掉默认动作，双击标题栏不该改变编辑器焦点 / 选中文本
    e.preventDefault();
    e.stopPropagation();
    void toggleMaximize();
  }, []);

  const actions = chromeActionsOf(state);

  /**
   * 插槽里的工具条也是"标题栏的一部分"：空白处按下要能拖窗（VIS-10 · D-1）。
   * 拖动判定不自己写——复用弹窗那条 `canStartWindowDragFrom`，控件 / 滚动条 / 打开的
   * 遮罩一律排除，两处的"什么算能拖"从此同一个口径。`detail === 2` 让给根上的
   * 双击最大化，避免同一次按下既 startDragging 又 toggleMaximize。
   */
  const onBandMouseDown = useCallback((e: ReactMouseEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || e.detail === 2) return;
    if (!canStartWindowDragFrom(e.target as HTMLElement, e.clientX, e.clientY)) return;
    e.preventDefault();
    dragStarterRef.current();
  }, []);

  return (
    <div
      className="window-chrome"
      role="toolbar"
      aria-label="窗口标题栏"
      data-tauri-drag-region
      onMouseDown={onBarMouseDown}
    >
      <span className="window-chrome-mark" aria-hidden="true" data-tauri-drag-region>
        <ChromeBrandMark />
      </span>
      <span className="window-chrome-title" data-tauri-drag-region title={title}>
        {bandFilled ? bandTitleOf(title) : title}
      </span>
      {/* 身份带插槽（VIS-10）：真壳里 ShellLayout 把工具条 portal 进这里，
          于是 36+36 两条横带并成一条 40px；浏览器 dev 没有本组件 ⇒ 工具条留在原位。 */}
      <span
        className="window-chrome-band"
        data-identity-band=""
        ref={registerIdentityBandSlot}
        onMouseDown={onBandMouseDown}
      />
      <div className="window-chrome-drag" data-tauri-drag-region />
      <div className="window-chrome-actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`window-chrome-btn${action.id === 'close' ? ' window-chrome-close' : ''}`}
            title={action.label}
            aria-label={action.label}
            onClick={() => runChromeAction(action.id)}
          >
            <Icon name={action.icon} size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}
