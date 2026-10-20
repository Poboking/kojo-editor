import type { ReactElement } from 'react';
import type { AppPhase } from './App';
import { Icon } from './icons';

/**
 * 项目态错误条（REF-FRONT-PERF，2026-10-20）。
 *
 * 背景：App 的 `error` state 原先只在欢迎页渲染。写允许域注册失败（打开项目成功之后）
 * 与授权失败都发生在项目态，用户完全看不见——点完对话框只看到徽章还是「只读」。
 *
 * 口径：
 * - **只在项目态渲染**：欢迎页/开机态仍用 WelcomeView 自己那块错误区，两边不重复；
 * - **文案原样显示**：不截断、不改写、不加前缀；`.notice.error` 的 pre-wrap 保留换行；
 * - **同屏一条 + 可关闭**：App 的 error 是单值 state，`raiseProjectErrorBar` 对同一文案
 *   保持原引用（React 直接 bail out），不会因重复上报叠出第二条；
 * - **错误自带出路**（WRITE-ADMIT-SPLIT 出路①，additive）：这条错误能走哪条路回去，
 *   与文案住在**同一份 state**里 ⇒ 不会出现"话说了、按钮没有"或"按钮还在、话已经不是那条"；
 *   没有出路的错误照旧只显示文案与关闭叉（`action` 缺省即旧行为）。
 * - 纯展示组件，不依赖 kernel 上下文。
 */

/** 项目态该显示哪条错误（welcome / opening / boot 一律返回 null——那几态有各自的错误区） */
export function visibleProjectError(phase: AppPhase, error: string | null): string | null {
  return phase === 'project' && error !== null && error !== '' ? error : null;
}

/**
 * 错误条上的出路动作。形状照 `NotificationCenter` 的 `NoticeAction`（`label` + `run`），
 * 多一枚 `title`：作者面去黑话，按钮那几个字说不清的"点下去会发生什么"放悬停里。
 */
export interface ProjectErrorAction {
  readonly label: string;
  readonly title: string;
  readonly run: () => void;
}

/** 项目态错误条的完整状态：一句话 **和它那条出路** 是同一个对象，永不各说各话 */
export interface ProjectErrorBar {
  readonly message: string;
  readonly action: ProjectErrorAction | null;
}

/**
 * 错误条状态替换（同屏只一条、同类不刷屏的唯一入口）。
 * 文案没变且两边都没有出路 ⇒ 保持原引用（同屏不重挂）；只要带出路就一律换新——
 * 动作的执行体抓着这一次的项目目录，屏上不许留旧的那份。
 */
export function raiseProjectErrorBar(previous: ProjectErrorBar | null, next: ProjectErrorBar): ProjectErrorBar | null {
  if (previous === null || previous.message !== next.message) return next;
  if (previous.action === null && next.action === null) return previous;
  return next;
}

export interface ProjectErrorNoticeProps {
  readonly message: string;
  readonly onDismiss: () => void;
  /** 这条错误自带的出路（缺省 = 没有出路，只有文案与关闭叉） */
  readonly action?: ProjectErrorAction | null;
}

export function ProjectErrorNotice({ message, onDismiss, action = null }: ProjectErrorNoticeProps): ReactElement {
  return (
    <div className="notice error project-session-error" role="alert">
      <span className="project-session-error-message">{message}</span>
      {action ? (
        <button type="button" className="small toast-action" title={action.title} onClick={action.run}>
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="ghost small toast-close"
        title="关闭错误提示"
        aria-label="关闭错误提示"
        onClick={onDismiss}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
