/**
 * 更新弹窗——**详情模态**（用户反馈第 1 条 · 批次十一 L05 重做）。
 *
 * 只出现在**真的发现新版本**之后（`updateDialogPhase` 是唯一判据）：自动检查的
 * checking / latest / failed(check) 一律没有面板，不给刚进编辑器的作者添堵。
 * 非阻塞的右下提醒卡（`UpdateNoticeCard.tsx`）是普通更新的第一落点；本模态是
 * 「点了查看」或**破坏性更新**（severity='breaking'，层三唯一允许打开即模态的形态）的详情面。
 *
 * 与设置页的关系：**同一份 phase、同一个 installUpdate**（状态机在 `update-check.ts`）。
 * 弹窗不自己发检查 / 不自己下载——这里只画和转发动作，失败原因与进度文案都取状态机那一份。
 *
 * 本批重做的三处（对着实测缺陷改）：
 * - **changelog 按语义分组**（新增/修复/破坏性/其它，`groupUpdateNotes`），行内 URL 渲染成
 *   `<a target="_blank" rel="noopener noreferrer">`——外链走壳层既有原生形态（同 `SettingsPanel`
 *   关于页），不裸 `window.open`；
 * - **状态与动作分离**：downloading 的「正在下载…」不再是页脚里那颗禁用假按钮（和「下载并安装」
 *   并排易误读），改成正文里的状态胶囊；页脚只留真动作「后台下载」；
 * - **完成态给「立即重启」**：宿主提供 `onRestart` 时它是主行动（关=稍后重启）；没有就不画
 *   （当前宿主尚无重启命令，接线登记在批次报告，不在这里假按钮）。
 *
 * UPD-F（2026-11-05）增补：changelog 的**非 URL 文本段**支持两种最常用的行内标记——
 * `**加粗**` → `<strong>`、`` `代码` `` → `<code>`（`renderInlineRich`）。URL 段优先级
 * 最高：先 linkify 后富文本，所以 `**看 https://x**` 里 URL 仍是纯链接、两侧星号按普通文本处理。
 *
 * 关闭语义（刻意选择"busy 也允许关"）：
 * - `downloadAndInstall` 一旦发出就**不可取消**，关面板不会中断安装；
 * - 把作者锁在一个全屏模态里等下载是坏体验（VSCode 的更新通知从不阻塞编辑器）；
 * - 关掉后进度仍落在设置页的更新状态行，装完那句"重启应用后生效"也还在那里。
 * 于是 X / Esc / 遮罩点击在任何态都可用；「稍后」类出口由宿主落「同版本免打扰」偏好。
 */

import {
  Fragment,
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
  detectUpdateSeverity,
  UPDATE_NOTE_LINE_LIMIT,
  UPDATE_NOTES_EMPTY,
  formatUpdateDate,
  linkifyUpdateNoteLine,
  updateDialogTitle,
  updateReleaseOf,
  updateStatus,
  visibleUpdateNoteGroups,
  type UpdateDialogPhase,
  type UpdateNoteSegment,
  type UpdateRelease,
} from './update-check';
import { UPDATE_DISMISS_HINT } from './update-dismiss-pref';
import { UpdateProgress, UpdateStatus } from './UpdateProgress';
import '../update-dialog.css';

export interface UpdateDialogProps {
  /** 只可能是 found / downloading / done / failed(install)——由 `updateDialogPhase` 收窄 */
  phase: UpdateDialogPhase;
  /** 稍后 / 关闭 X / 遮罩 / Esc 共用的出口（宿主可借此落免打扰偏好） */
  onClose: () => void;
  /** 下载并安装 / 失败重试（与设置页同一个 installUpdate） */
  onInstall: () => void;
  /**
   * 安装完成后的「立即重启」（调宿主的重启/relaunch 通道）。
   * **没给就不画那颗按钮**——按钮必须真能把应用重启起来，不许演。
   */
  onRestart?: () => void;
  /**
   * 破坏性更新以「打开即模态」出现时传 true（层三）：抬头多一枚「破坏性更新」警示牌。
   * 判据本身在 `detectUpdateSeverity`——宿主用它决定开不开模态，这里只负责把已开的这次说清楚。
   */
  forced?: boolean;
}

/** 对话框里可 Tab 到的元素（与 aria-modal 配套，Tab 不落到背后的编辑器） */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 非 URL 文本段的行内富文本微渲染（UPD-F）：`**加粗**` → `<strong>`、`` `代码` `` → `<code>`。
 *
 * 纪律（每条都对着测试钉）：
 * - **单遍扫描、先到先得**：从左到右走，同段混排按出现顺序切——`` `a**b` `` 里星号进代码、
 *   `**a`b**` 里反引号进加粗；标记内容**整段当纯文本**，不再向里解释（不嵌套、不递归）；
 * - **未闭合 / 空内容按原文渲染**：`**只有一边` 原样出，`****` 与两个空反引号也是纯文本；
 * - **转义不支持（明说的取舍）**：`\*\*` 里没有连续两个星号，天然按原文走，不另设转义语法。
 *
 * 返回节点全部带 key（keyPrefix 区分同一行里不同的文本段，避免与 URL 段的序号键撞车）。
 */
function renderInlineRich(text: string, keyPrefix: string): ReactElement[] {
  const nodes: ReactElement[] = [];
  /** 攒着的普通文本：遇到标记或收尾时一次性落成一个 span，不逐字符开节点 */
  let plain = '';
  const flush = (): void => {
    if (plain !== '') {
      nodes.push(<span key={`${keyPrefix}t${nodes.length}`}>{plain}</span>);
      plain = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const bold = text.indexOf('**', i);
    const code = text.indexOf('`', i);
    if (bold === -1 && code === -1) {
      plain += text.slice(i);
      break;
    }
    if (bold !== -1 && (code === -1 || bold < code)) {
      const close = text.indexOf('**', bold + 2);
      if (close > bold + 2) {
        // 先把本标记之前攒到的普通文本落盘（它属于上一个节点），再落 strong
        plain += text.slice(i, bold);
        flush();
        nodes.push(<strong key={`${keyPrefix}b${nodes.length}`}>{text.slice(bold + 2, close)}</strong>);
        i = close + 2;
      } else {
        // 未闭合（或 `****` 这类空内容）：这对星号按普通文本，跳过它们继续扫
        plain += text.slice(i, bold + 2);
        i = bold + 2;
      }
      continue;
    }
    const close = text.indexOf('`', code + 1);
    if (close > code + 1) {
      plain += text.slice(i, code);
      flush();
      nodes.push(<code key={`${keyPrefix}c${nodes.length}`}>{text.slice(code + 1, close)}</code>);
      i = close + 1;
    } else {
      plain += text.slice(i, code + 1);
      i = code + 1;
    }
  }
  flush();
  return nodes;
}

/**
 * 一行说明 → 段数组 → React 节点（URL 段画成外链锚点，其余原样成文）。
 *
 * 顺序纪律：**先 linkify 后富文本**——URL 段优先级最高（`linkifyUpdateNoteLine` 先把 URL
 * 从行里切走），富文本只作用于 URL 之外的纯文本段，所以 `**看 https://x**` 里 URL 仍是
 * 纯链接、两侧星号按普通文本处理；代码标记里也不会长出链接。
 */
function renderNoteLine(line: string, key: number): ReactElement {
  const segments: readonly UpdateNoteSegment[] = linkifyUpdateNoteLine(line);
  return (
    <p key={key} className={line === '' ? 'update-dialog-note-line is-blank' : 'update-dialog-note-line'}>
      {line === '' ? (
        <span aria-hidden="true" />
      ) : (
        segments.map((seg, i) =>
          seg.url === undefined ? (
            <Fragment key={i}>{renderInlineRich(seg.text, `s${i}`)}</Fragment>
          ) : (
            // 原生 <a target="_blank">＝壳层既有外链形态（WebView2 交给系统默认浏览器），
            // rel=noopener 切断新页面对本窗口的反向引用
            <a key={i} className="update-dialog-note-link" href={seg.url} target="_blank" rel="noopener noreferrer">
              {seg.text}
            </a>
          ),
        )
      )}
    </p>
  );
}

export function UpdateDialog({ phase, onClose, onInstall, onRestart, forced = false }: UpdateDialogProps): ReactElement {
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
   * 禁用态的按钮不参与（`button:not(:disabled)`），所以 downloading 页脚没有假落点。
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

  const release: UpdateRelease = updateReleaseOf(phase);
  const title = updateDialogTitle(phase);
  const dateText = formatUpdateDate(release.date);
  const hasMeta = release.currentVersion !== undefined || dateText !== null;
  // 破坏性判定只看说明（found 带 notes；后续态 notes 随 release 一路带到）
  const breaking = detectUpdateSeverity(release.notes) === 'breaking';
  // 说明只在 found 态详列：一旦开始下载，正文让位给进度（作者盯着条比盯着字有用）
  const noteView =
    phase.kind === 'found'
      ? visibleUpdateNoteGroups(release.notes)
      : { groups: [], total: 0, truncated: false };
  const busy = phase.kind === 'downloading';

  return (
    <div className="modal-mask update-dialog-mask" onMouseDown={onMaskMouseDown}>
      <div
        ref={panelRef}
        className="glass update-dialog"
        data-phase={phase.kind}
        {...(breaking ? { 'data-severity': 'breaking' } : {})}
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
              {phase.kind === 'found' && breaking ? (
                <span className="update-dialog-severity-tag" data-tone="breaking">
                  {forced ? '破坏性更新 · 需确认' : '破坏性更新'}
                </span>
              ) : null}
            </h2>
            {hasMeta ? (
              <p className="update-dialog-meta" id={metaId}>
                {release.currentVersion !== undefined ? (
                  <span>当前 v{release.currentVersion}</span>
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
          {phase.kind === 'found' && breaking ? (
            // 破坏性更新的"停下读一眼"：警示牌只在标题旁挂一枚小胶囊，容易被当成装饰；
            // 这一条把它翻译成动作指令（先读标红那一组，再决定装不装）。
            <p className="update-dialog-alert" role="note">
              这一版含<b>破坏性变更</b>，请先读完下面「破坏性变更」那一组，再决定装不装。
            </p>
          ) : null}

          {phase.kind === 'found' && noteView.groups.length > 0 ? (
            <section className="update-dialog-section" aria-labelledby={notesTitleId}>
              <h3 className="update-dialog-section-title" id={notesTitleId}>
                更新内容
              </h3>
              {/* tabIndex：长说明可以只用键盘上下翻（焦点落在这块滚动区上，方向键才滚得动） */}
              <div
                className="update-dialog-notes"
                role="region"
                aria-labelledby={notesTitleId}
                tabIndex={0}
              >
                {noteView.groups.map((group) => (
                  <div key={group.id} className="update-dialog-group" data-group={group.id}>
                    <h4 className="update-dialog-group-title">{group.label}</h4>
                    {group.lines.map((line, i) => renderNoteLine(line, i))}
                  </div>
                ))}
              </div>
              {noteView.truncated ? (
                <p className="update-dialog-notes-more">
                  更新说明较长，仅显示前 {UPDATE_NOTE_LINE_LIMIT} 行（共 {noteView.total} 行）。
                </p>
              ) : null}
            </section>
          ) : null}

          {phase.kind === 'found' && noteView.groups.length === 0 ? (
            <section className="update-dialog-section" aria-labelledby={notesTitleId}>
              <h3 className="update-dialog-section-title" id={notesTitleId}>
                更新内容
              </h3>
              <p className="update-dialog-notes-empty">{UPDATE_NOTES_EMPTY}</p>
            </section>
          ) : null}

          {phase.kind === 'downloading' ? (
            <div className="update-dialog-progress">
              {/* 状态胶囊：这是「状态」，不是动作按钮——页脚只留真动作，误读源头掐掉。
                  版本号不在这里重复一遍：抬头标题已经写着「正在下载 vX」，
                  同一屏写三遍同一个号是噪音（右下卡同理，版本只归徽标那一格）。 */}
              <UpdateStatus tone="active">正在下载…</UpdateStatus>
              <UpdateProgress received={phase.received} total={phase.total} />
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
              <p className="update-dialog-hint">
                {onRestart === undefined
                  ? '请保存手头的工作，关闭编辑器后重新打开即生效。'
                  : '更新已就位；重启会关闭编辑器，请先保存手头的工作。'}
              </p>
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
              <button type="button" className="ghost" onClick={onClose} title={UPDATE_DISMISS_HINT}>
                稍后
              </button>
              <button type="button" className="primary" onClick={onInstall}>
                下载并安装
              </button>
            </>
          ) : null}
          {phase.kind === 'downloading' ? (
            // 页脚只有真动作：关面板后台继续下载。「正在下载」是状态，已经搬进正文胶囊。
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              title="关闭面板，下载与安装会在后台继续"
            >
              后台下载
            </button>
          ) : null}
          {phase.kind === 'done' ? (
            onRestart === undefined ? (
              <button type="button" className="primary" onClick={onClose}>
                关闭
              </button>
            ) : (
              <>
                <button type="button" className="ghost" onClick={onClose}>
                  稍后重启
                </button>
                <button type="button" className="primary" onClick={onRestart}>
                  立即重启
                </button>
              </>
            )
          ) : null}
          {phase.kind === 'failed' ? (
            <>
              <button type="button" className="ghost" onClick={onClose} title={UPDATE_DISMISS_HINT}>
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
