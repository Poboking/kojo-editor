/**
 * 更新弹窗（用户反馈第 1 条，2026-10-17）。
 *
 * 只出现在**真的发现新版本**之后（`updateDialogPhase` 是唯一判据）：自动检查的
 * checking / latest / failed(check) 一律没有面板，不给刚进编辑器的作者添堵。
 *
 * 与设置页的关系：**同一份 phase、同一个 installUpdate**（状态机在 `update-check.ts`）。
 * 弹窗不自己发检查 / 不自己下载——这里只画和转发动作，失败原因与进度文案都取状态机那一份。
 *
 * 关闭语义（刻意选择"busy 也允许关"）：
 * - `downloadAndInstall` 一旦发出就**不可取消**，关面板不会中断安装；
 * - 把作者锁在一个全屏模态里等下载是坏体验（VSCode 的更新通知从不阻塞编辑器）；
 * - 关掉后进度仍落在设置页的更新状态行，装完那句"重启应用后生效"也还在那里。
 * 于是 X / Esc / 遮罩点击在任何态都可用；只是同版本的自动重开被 ShellLayout 抑制，
 * 要不要看着进度条由作者自己决定。
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
import {
  UPDATE_NOTE_LINE_LIMIT,
  UPDATE_NOTES_EMPTY,
  downloadPercent,
  downloadProgressText,
  formatBytes,
  formatUpdateDate,
  updateDialogTitle,
  updateStatus,
  visibleUpdateNoteLines,
  type UpdateDialogPhase,
  type UpdateRelease,
} from './update-check';
import '../update-dialog.css';

export interface UpdateDialogProps {
  /** 只可能是 found / downloading / done / failed(install)——由 `updateDialogPhase` 收窄 */
  phase: UpdateDialogPhase;
  /** 稍后 / 关闭 X / 遮罩 / Esc 共用的出口 */
  onClose: () => void;
  /** 下载并安装 / 失败重试（与设置页同一个 installUpdate） */
  onInstall: () => void;
}

/** 对话框里可 Tab 到的元素（与 aria-modal 配套，Tab 不落到背后的编辑器） */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function UpdateDialog({ phase, onClose, onInstall }: UpdateDialogProps): ReactElement {
  const titleId = useId();
  const metaId = useId();
  const notesTitleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Esc 走宿主模态栈（HK-2）：与其它对话框共用"一次只关最上面一层"的纪律
  useModalEscape(onClose);

  // 初始焦点落在面板本身：读屏先把标题与版本读出来，作者想点哪个动作再 Tab。
  // 不默认聚焦「下载并安装」——回车不该替作者按下一次会写盘/重启的安装。
  useEffect(() => {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    panelRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  /**
   * 焦点环（Tab / Shift+Tab）不穿透模态：背后编辑器仍在 DOM 里，不拦就会把焦点送出去。
   * 禁用态的按钮不参与（`button:not(:disabled)`），所以 downloading 的「正在下载…」不算落点。
   */
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
    // 右键是"要开菜单"，不是"要关浮层"（1023 覆盖面批 · WP4.10）：mousedown 对三键都会
    // 触发，不拦的话右键落在遮罩上会先关掉面板、再弹出菜单压在空页面上。只认左键。
    if (e.button !== 0) return;
    // 只有按在遮罩本身才关：从面板里按下、拖到外面松开不算
    if (e.target === e.currentTarget) onClose();
  };

  const release: UpdateRelease = phase.kind === 'failed' ? phase.release : phase;
  const title = updateDialogTitle(phase);
  const dateText = formatUpdateDate(release.date);
  const hasMeta = release.currentVersion !== undefined || dateText !== null;
  const noteView = visibleUpdateNoteLines(phase.kind === 'found' ? phase.notes : undefined);
  const pct = phase.kind === 'downloading' ? downloadPercent(phase.received, phase.total) : null;
  const progressText =
    phase.kind === 'downloading' ? downloadProgressText(phase.received, phase.total) : null;
  const busy = phase.kind === 'downloading';

  return (
    <div className="modal-mask update-dialog-mask" onMouseDown={onMaskMouseDown}>
      <div
        ref={panelRef}
        className="glass update-dialog"
        data-phase={phase.kind}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(hasMeta ? { 'aria-describedby': metaId } : {})}
        {...(busy ? { 'aria-busy': true } : {})}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="update-dialog-head">
          <div className="update-dialog-title-wrap">
            <h2 className="update-dialog-title" id={titleId}>
              {title}
            </h2>
            {hasMeta ? (
              <p className="update-dialog-meta" id={metaId}>
                {release.currentVersion !== undefined ? (
                  <span>当前版本 v{release.currentVersion}</span>
                ) : null}
                {release.currentVersion !== undefined && dateText !== null ? (
                  <span className="update-dialog-meta-sep" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                {dateText !== null ? <time dateTime={release.date}>{`发布于 ${dateText}`}</time> : null}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="update-dialog-close"
            aria-label="关闭更新面板"
            title="关闭"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="update-dialog-body">
          {phase.kind === 'found' ? (
            <section className="update-dialog-section" aria-labelledby={notesTitleId}>
              <h3 className="update-dialog-section-title" id={notesTitleId}>
                更新内容
              </h3>
              {noteView.lines.length === 0 ? (
                <p className="update-dialog-notes-empty">{UPDATE_NOTES_EMPTY}</p>
              ) : (
                // tabIndex：长说明可以只用键盘上下翻（焦点落在这块滚动区上，方向键才滚得动）
                <div
                  className="update-dialog-notes"
                  role="region"
                  aria-labelledby={notesTitleId}
                  tabIndex={0}
                >
                  {noteView.lines.map((line, i) =>
                    line === '' ? (
                      <p key={i} className="update-dialog-note-line is-blank" aria-hidden="true" />
                    ) : (
                      <p key={i} className="update-dialog-note-line">
                        {line}
                      </p>
                    ),
                  )}
                </div>
              )}
              {noteView.truncated ? (
                <p className="update-dialog-notes-more">
                  更新说明较长，仅显示前 {UPDATE_NOTE_LINE_LIMIT} 行（共 {noteView.total} 行）。
                </p>
              ) : null}
            </section>
          ) : null}

          {phase.kind === 'downloading' ? (
            <div className="update-dialog-progress">
              <div
                className="update-dialog-progress-track"
                role="progressbar"
                aria-label="更新下载进度"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(pct !== null ? { 'aria-valuenow': pct } : {})}
                {...(pct === null ? { 'aria-valuetext': '正在下载安装，总量未知' } : {})}
                data-indeterminate={pct === null ? 'true' : 'false'}
              >
                <div
                  className="update-dialog-progress-fill"
                  style={pct !== null ? { width: `${pct}%` } : undefined}
                />
              </div>
              <div className="update-dialog-progress-line">
                <span>{progressText ?? '正在下载安装…'}</span>
                {progressText === null && phase.received > 0 ? (
                  <span>已下载 {formatBytes(phase.received)}</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {phase.kind === 'done' ? (
            <div className="update-dialog-done">
              <p className="update-dialog-done-line">
                <span className="update-dialog-done-icon" aria-hidden="true">
                  <Icon name="check" size={16} />
                </span>
                {updateStatus(phase)?.text ?? '更新已安装，重启应用后生效'}
              </p>
              <p className="update-dialog-hint">请保存手头的工作后重启应用。</p>
            </div>
          ) : null}

          {phase.kind === 'failed' ? (
            <div className="update-dialog-failed">
              <p className="update-dialog-failure" role="alert">
                {updateStatus(phase)?.text ?? '编辑器更新没有下载安装成功，可重试'}
              </p>
              <p className="update-dialog-hint">
                检查网络后可以重试；也可以先关掉，稍后再从设置里检查更新。
              </p>
            </div>
          ) : null}
        </div>

        <footer className="update-dialog-actions">
          {phase.kind === 'found' ? (
            <>
              <button type="button" className="ghost" onClick={onClose}>
                稍后
              </button>
              <button type="button" className="primary" onClick={onInstall}>
                下载并安装
              </button>
            </>
          ) : null}
          {phase.kind === 'downloading' ? (
            <>
              <button
                type="button"
                className="ghost"
                onClick={onClose}
                title="关闭面板，下载与安装会在后台继续"
              >
                后台下载
              </button>
              <button type="button" className="primary" disabled>
                正在下载…
              </button>
            </>
          ) : null}
          {phase.kind === 'done' ? (
            <button type="button" className="primary" onClick={onClose}>
              关闭
            </button>
          ) : null}
          {phase.kind === 'failed' ? (
            <>
              <button type="button" className="ghost" onClick={onClose}>
                稍后
              </button>
              <button type="button" className="primary" onClick={onInstall}>
                重试
              </button>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
