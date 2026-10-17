/**
 * 全屏自定义顶栏（用户反馈第 2 条：全屏化时最上方无标题栏）。
 *
 * 只在 Tauri 全屏时渲染：非全屏有系统原生标题栏，再叠一条就是重复；
 * 浏览器 dev 无壳时订阅直接 no-op ⇒ 顶栏永不出现。
 *
 * 形态对齐 VS Code 标题栏：整条可拖、双击最大化、右侧三枚安静的文字钮。
 * 由 ShellLayout 作为 `.shell` 的第一个 flex 子元素插入（不让它 position:fixed），
 * 顶栏占位、不压住编辑器与状态栏，也不随工具栏滚动。
 */
import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import {
  closeWindow,
  exitFullscreen,
  minimizeWindow,
  subscribeFullscreen,
  toggleMaximize,
} from './window-fullscreen';
import '../window-chrome.css';

export interface WindowChromeProps {
  /** 左侧应用名（缺省即产品名） */
  title?: string;
}

export function WindowChrome({ title = 'kojo-editor' }: WindowChromeProps): ReactElement | null {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void subscribeFullscreen(setFullscreen).then((off) => {
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

  if (!fullscreen) return null;

  return (
    <div className="window-chrome" data-tauri-drag-region onMouseDown={onBarMouseDown}>
      <span className="window-chrome-mark" aria-hidden="true" data-tauri-drag-region />
      <span className="window-chrome-title" data-tauri-drag-region>
        {title}
      </span>
      <div className="window-chrome-drag" data-tauri-drag-region />
      <div className="window-chrome-actions">
        <button
          type="button"
          className="window-chrome-btn"
          title="退出全屏"
          aria-label="退出全屏"
          onClick={() => {
            void exitFullscreen();
          }}
        >
          ⇲
        </button>
        <button
          type="button"
          className="window-chrome-btn"
          title="最小化"
          aria-label="最小化"
          onClick={() => {
            void minimizeWindow();
          }}
        >
          —
        </button>
        <button
          type="button"
          className="window-chrome-btn window-chrome-close"
          title="关闭窗口"
          aria-label="关闭窗口"
          onClick={() => {
            void closeWindow();
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
