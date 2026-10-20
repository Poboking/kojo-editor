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
 * - **同屏一条 + 可关闭**：App 的 error 是单值 state，`raiseProjectError` 对同一文案
 *   保持原引用（React 直接 bail out），不会因重复上报叠出第二条；
 * - 纯展示组件，不依赖 kernel 上下文。
 */

/** 项目态该显示哪条错误（welcome / opening / boot 一律返回 null——那几态有各自的错误区） */
export function visibleProjectError(phase: AppPhase, error: string | null): string | null {
  return phase === 'project' && error !== null && error !== '' ? error : null;
}

/**
 * 同类错误不刷屏：与当前文案逐字相同 ⇒ 返回原引用（React 不重渲、不重读屏）。
 * 与「不同错误覆盖旧的」是同一份 state 的两条规则；清空走 `setError(null)`。
 */
export function raiseProjectError(previous: string | null, message: string): string | null {
  return previous === message ? previous : message;
}

export interface ProjectErrorNoticeProps {
  readonly message: string;
  readonly onDismiss: () => void;
}

export function ProjectErrorNotice({ message, onDismiss }: ProjectErrorNoticeProps): ReactElement {
  return (
    <div className="notice error project-session-error" role="alert">
      <span className="project-session-error-message">{message}</span>
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
