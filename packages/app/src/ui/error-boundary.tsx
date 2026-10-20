import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import {
  logFrontendError,
  serializeReason,
  type FrontendErrorRecord,
} from '../frontend-log';

/**
 * 项目子树的错误边界（REF-FRONT-PERF，2026-10-20）。
 *
 * 为什么要有它：ProjectView 是懒加载块，块内又有 Suspense 与大量面板/编辑器装配。
 * 任何一处渲染期抛错，原先都会一路冒到根 —— 整个窗口白屏，连「项目」和「欢迎页」
 * 都点不到。边界把爆炸面收在项目子树里：给一张中文恢复卡，项目外的 App（标题栏、
 * 欢迎页切换路径）仍然活着。
 *
 * 口径：
 * - **包住 Suspense**：React.lazy 的模块加载失败也是渲染期错误，只有边界在 Suspense
 *   外面才接得住（Suspense 只接挂起，不接异常）；
 * - **取证进 frontend-log**：message + 原始 stack + componentStack 一起写，
 *   与 window error 通道同一落点（`append_frontend_log`）；
 * - **不依赖 kernel 上下文**：只收 children 与两个回调，测试可裸挂；
 * - **项目根变化即清错**：`resetKey` 是项目根；换项目时旧项目的崩溃卡不许残留。
 * - 「重试」由 App 重建懒加载实例（React.lazy 会把 rejected promise 缓存住，
 *   单纯清 state 重渲染仍会撞同一份拒绝）；「回到欢迎页」走 App 的 closeProject。
 */

/** React 渲染错误 → 落盘记录（componentStack 必带，取不到就不编） */
export function projectCrashRecord(error: unknown, componentStack?: string | null): FrontendErrorRecord {
  const message = `项目视图渲染失败：${serializeReason(error)}`;
  const parts: string[] = [];
  if (error instanceof Error && error.stack) parts.push(error.stack);
  if (componentStack) parts.push(`Component stack:${componentStack}`);
  return parts.length > 0
    ? { level: 'error', message, detail: parts.join('\n\n') }
    : { level: 'error', message };
}

export interface ProjectErrorBoundaryProps {
  readonly children: ReactNode;
  /** 项目根：变化即清掉错误卡（旧项目的崩溃不许盖在新项目上） */
  readonly resetKey: string;
  /** 「重试」：App 在这里重建 lazy 实例；边界随后清错重渲染 */
  readonly onRetry?: () => void;
  /** 「回到欢迎页」：App 的关项目通道（保证清理） */
  readonly onExit: () => void;
  /** 取证口（测试注入；缺省写 frontend-log） */
  readonly onError?: (record: FrontendErrorRecord) => void;
}

interface ProjectErrorBoundaryState {
  readonly error: unknown | null;
  /** 出错时所属项目根（用于判断 resetKey 是否已变化） */
  readonly atKey: string | null;
}

export class ProjectErrorBoundary extends Component<ProjectErrorBoundaryProps, ProjectErrorBoundaryState> {
  override state: ProjectErrorBoundaryState = { error: null, atKey: null };

  static getDerivedStateFromError(error: unknown): Partial<ProjectErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ProjectErrorBoundaryProps,
    state: ProjectErrorBoundaryState,
  ): Partial<ProjectErrorBoundaryState> | null {
    // atKey 在 componentDidCatch 里才补上（getDerivedStateFromError 拿不到 props）：
    // 首次出错那一拍 atKey 还是 null，**不能**当成"项目根变了"把错误卡立刻清掉。
    if (state.error !== null && state.atKey !== null && state.atKey !== props.resetKey) {
      return { error: null, atKey: null };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 记下"这次崩溃属于哪个项目根"：props.resetKey 一变，上面的派生 state 就清卡
    this.setState({ atKey: this.props.resetKey });
    const record = projectCrashRecord(error, info.componentStack);
    // 开发态保留 React 原生错误输出（第一取证面），生产态静默进日志
    console.error('[项目视图崩溃]', error, info.componentStack);
    if (this.props.onError) this.props.onError(record);
    else logFrontendError(record);
  }

  private retry = (): void => {
    this.setState({ error: null, atKey: null });
    this.props.onRetry?.();
  };

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="project-crash" role="alert">
        <div className="notice error project-crash-card">
          <h2>项目界面出了点问题</h2>
          <p>界面渲染时遇到错误。可以重试，或先回到欢迎页再打开项目。</p>
          <details className="project-crash-details">
            <summary>技术细节（可复制给开发者）</summary>
            <pre className="project-crash-detail">{serializeReason(this.state.error)}</pre>
          </details>
          <div className="project-crash-actions">
            <button type="button" className="primary" onClick={this.retry}>
              重试
            </button>
            <button type="button" className="ghost" onClick={this.props.onExit}>
              回到欢迎页
            </button>
          </div>
        </div>
      </div>
    );
  }
}
