/**
 * 常驻窗口框架（用户反馈第 9 条：任何窗口态都不要 Windows 原生标题栏）。
 *
 * 窗口在 `tauri.conf.json` 里就是 `decorations: false`，本组件从启动到退出一直挂在
 * App 根部：欢迎页 / 项目态 / 禅模式共用同一条 34px 标题栏，最大化与全屏都不再长出
 * 系统白条。浏览器 dev 没有壳（`isTauri()` 为 false）⇒ 返回 null，不画一条点不动的
 * 假按钮；此时也没有 `data-window-state`，自绘外框不出现。
 *
 * 形态对标 VS Code 标题栏：左侧 accent 竖标 + 应用名 + 整段可拖空白区，右侧
 * 最小化 / 最大化（全屏时换成退出全屏）/ 关闭。双击整条栏最大化 / 还原。
 * 纯状态映射 `chromeActionsOf` / `windowStateOf` 独立可测，三态（普通 / 最大化 /
 * 全屏）的按钮序列与图标都在那里定死。
 */
import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import { isTauri } from '../bridge/invoke';
import { Icon, type IconName } from './icons';
import {
  closeWindow,
  exitFullscreen,
  minimizeWindow,
  subscribeWindowState,
  toggleMaximize,
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
 * 浏览器 dev / node 测试：没有壳就不渲染（先判后挂 hooks，钩子次序不受影响）。
 * 真壳里恒走 `WindowChromeFrame`，从首帧起就是自定义框架。
 */
export function WindowChrome(props: WindowChromeProps): ReactElement | null {
  if (!isTauri()) return null;
  return <WindowChromeFrame {...props} />;
}

function WindowChromeFrame({ title = 'kojo-editor' }: WindowChromeProps): ReactElement {
  const [state, setState] = useState<WindowState>({ fullscreen: false, maximized: false });

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

  return (
    <div
      className="window-chrome"
      role="toolbar"
      aria-label="窗口标题栏"
      data-tauri-drag-region
      onMouseDown={onBarMouseDown}
    >
      <span className="window-chrome-mark" aria-hidden="true" data-tauri-drag-region />
      <span className="window-chrome-title" data-tauri-drag-region>
        {title}
      </span>
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
