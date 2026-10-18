/**
 * 「开发者的碎碎念」首启动纸条（用户反馈 2，2026-10-18）。
 *
 * 为什么是一张纸条、而不是第二个模态卡：这条提示的信息量很小（绑定游戏根目录 + 一个邮箱），
 * 但它出现在**作者第一次进编辑器**的时刻——此时界面上唯一的任务是"打开文件夹"。做成与
 * 确认框同款的玻璃卡，会被读成"又一道要过的流程"；做成贴在屏幕上的便签纸（胶带 + 横格 +
 * 微倾斜），才像"开发者随手留了句话"，不跟欢迎页的克制基调打架。
 *
 * 只弹一次的口径见 `dev-note-pref.ts`：本组件只管画与转发，不碰 localStorage。
 *
 * 关闭语义：X / Esc / 遮罩 / 「先看看」都算看过（由宿主写 seen 标记）；主按钮
 * 「去绑定游戏根目录」额外把作者直接送去目录选择器（宿主传 `onOpenDirectory`）——
 * 纸条说的事，就地给一个能做完的按钮，不让人回头再找入口。
 */

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import { Icon } from './icons';
import { useModalEscape } from './modal-stack';
import { CONTACT_EMAIL, CONTACT_MAILTO } from './contact';
import '../dev-note.css';

export interface DevNoteDialogProps {
  /** 看过即关：Esc / 遮罩 / ✕ / 「先看看」共用这一个出口 */
  onClose: () => void;
  /** 「去绑定游戏根目录」：关掉纸条并直接打开目录选择器（与欢迎页主按钮同一个入口） */
  onOpenDirectory: () => void;
}

/** 对话框里可 Tab 到的元素（与 aria-modal 配套，Tab 不落到背后的欢迎页） */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function DevNoteDialog({ onClose, onOpenDirectory }: DevNoteDialogProps): ReactElement {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Esc 走宿主模态栈（HK-2）：与其它对话框共用"一次只关最上面一层"的纪律
  useModalEscape(onClose);

  // 初始焦点落在纸条本身：读屏先把标题与正文读出来，作者想点哪个动作再 Tab。
  // 不默认聚焦主按钮——回车不该替作者按下"打开目录对话框"。
  useEffect(() => {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    panelRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  /** 焦点环（Tab / Shift+Tab）不穿透模态：背后欢迎页仍在 DOM 里，不拦就会把焦点送出去 */
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return;
    const root = panelRef.current;
    if (root === null) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.getClientRects().length > 0,
    );
    if (items.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onMaskMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    // 只有按在遮罩本身才关：从纸条里按下、拖到外面松开不算
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-mask dev-note-mask" onMouseDown={onMaskMouseDown}>
      <div
        className="dev-note"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onPanelKeyDown}
      >
        {/* 胶带：纯装饰（纸条"被贴住"的那一下），不参与命中与读屏 */}
        <span className="dev-note-tape" aria-hidden="true" />
        <div className="dev-note-scroll">
          <p className="dev-note-kicker">初次见面</p>
          <h2 className="dev-note-title" id={titleId}>
            开发者的碎碎念
          </h2>
          <p className="dev-note-line">欢迎使用本编辑器！初次进入编辑器需要绑定游戏根目录。</p>
          <p className="dev-note-line">由于还在开发阶段，缺乏大量测试，如果遇到什么奇怪 Bug 的话，请不要犹豫！联系以下邮箱进行反馈，说不定明天就能解决了？<span className="dev-note-heart">❤️</span></p>
          <p className="dev-note-mail">
            联系邮箱：
            <a className="dev-note-mail-link" href={CONTACT_MAILTO}>
              <Icon name="mail" size={14} />
              {CONTACT_EMAIL}
            </a>
          </p>
          <p className="dev-note-sign">—— Poboking</p>
        </div>
        <div className="dev-note-actions">
          <button className="ghost small" onClick={onClose}>
            先看看
          </button>
          <button className="primary small" onClick={onOpenDirectory}>
            去绑定游戏根目录
          </button>
        </div>
      </div>
    </div>
  );
}
