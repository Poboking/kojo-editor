// @vitest-environment happy-dom
/**
 * 项目子树错误边界（REF-FRONT-PERF，2026-10-20）。
 *
 * 判据（行为级，不读源码形状）：
 * - 子组件渲染期抛错 → 不再白屏：中文恢复卡上屏，「重试」「回到欢迎页」都在；
 * - componentStack 进 frontend-log 记录（message + detail）；
 * - 「重试」清错并通知 App 重建子树；「回到欢迎页」交回调；
 * - 项目根（resetKey）变化 → 旧项目的崩溃卡立刻消失，新子树正常渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, lazy, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FrontendErrorRecord } from '../src/frontend-log';
import { ProjectErrorBoundary, projectCrashRecord } from '../src/ui/error-boundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): ReactNode {
  throw new Error('炸了');
}

function MaybeRecovered({ ok }: { ok: boolean }): ReactNode {
  if (!ok) throw new Error('旧项目炸了');
  return h('div', { className: 'ok' }, '已恢复');
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`找不到按钮「${text}」`);
  return found as HTMLButtonElement;
}

describe('ProjectErrorBoundary：恢复卡与取证', () => {
  let container: HTMLElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // React 会把捕获的渲染错误打到 console.error（开发态取证面）；测试里只关心
    // 我们自己的 onError 记录，抑制噪声但保留断言能力
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = undefined;
    vi.restoreAllMocks();
  });

  async function mount(props: {
    resetKey: string;
    children: ReactNode;
    onRetry?: () => void;
    onExit: () => void;
    onError?: (record: FrontendErrorRecord) => void;
  }): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(h(ProjectErrorBoundary, props));
    });
  }

  it('子组件抛错 → 中文恢复卡 + 两个出口按钮（不白屏）', async () => {
    const onError = vi.fn();
    await mount({ resetKey: 'D:/项目', children: h(Boom), onExit: () => {}, onError });

    expect(container.querySelector('.project-crash')).not.toBeNull();
    expect(container.textContent).toContain('项目界面出了点问题');
    expect(container.textContent).toContain('界面渲染时遇到错误');
    expect(buttonByText(container, '重试')).not.toBeNull();
    expect(buttonByText(container, '回到欢迎页')).not.toBeNull();
    // 错误原文只进「技术细节」，第一眼仍是人话
    expect(container.textContent).toContain('技术细节');
  });

  it('捕获记录进 frontend-log 形态：message + 原始 stack + componentStack', async () => {
    const onError = vi.fn();
    await mount({ resetKey: 'D:/项目', children: h(Boom), onExit: () => {}, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    const record = onError.mock.calls[0]?.[0] as FrontendErrorRecord;
    expect(record.level).toBe('error');
    expect(record.message).toContain('项目视图渲染失败');
    expect(record.message).toContain('炸了');
    expect(record.detail).toContain('Component stack:');
    expect(record.detail).toContain('Error: 炸了');
  });

  it('projectCrashRecord：没有 componentStack 时不编造该字段', () => {
    const record = projectCrashRecord(new Error('没有组件栈'));
    expect(record.detail).not.toContain('Component stack:');
    expect(record.message).toContain('没有组件栈');
  });

  it('懒块加载失败（rejected lazy）也接得住：恢复卡上屏且取证可见', async () => {
    const onError = vi.fn();
    const Rejected = lazy(() => Promise.reject(new Error('块加载失败')));
    await mount({
      resetKey: 'D:/项目',
      children: h(Suspense, { fallback: h('div', { className: 'loading' }, '加载中') }, h(Rejected)),
      onExit: () => {},
      onError,
    });
    // lazy 的拒绝在微任务里兑现；边界要等 React 重试渲染后才会拿到异常
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(container.querySelector('.loading')).toBeNull();
    expect(container.querySelector('.project-crash')).not.toBeNull();
    expect(container.textContent).toContain('项目界面出了点问题');
    expect(onError).toHaveBeenCalledTimes(1);
    const record = onError.mock.calls[0]?.[0] as FrontendErrorRecord;
    expect(record.message).toContain('项目视图渲染失败');
    expect(record.message).toContain('块加载失败');
  });

  it('「回到欢迎页」把动作交给 App 的关项目通道', async () => {
    const onExit = vi.fn();
    await mount({ resetKey: 'D:/项目', children: h(Boom), onExit });

    await act(async () => {
      buttonByText(container, '回到欢迎页').click();
    });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('「重试」清错 + 通知 App 重建子树 → 恢复后正常渲染', async () => {
    let shouldThrow = true;
    function Maybe(): ReactNode {
      if (shouldThrow) throw new Error('第一次炸了');
      return h('div', { className: 'ok' }, '已恢复');
    }
    const onRetry = vi.fn(() => {
      shouldThrow = false;
    });

    await mount({ resetKey: 'D:/项目', children: h(Maybe), onExit: () => {}, onRetry });
    expect(container.querySelector('.project-crash')).not.toBeNull();

    await act(async () => {
      buttonByText(container, '重试').click();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.project-crash')).toBeNull();
    expect(container.querySelector('.ok')?.textContent).toBe('已恢复');
  });

  it('项目根变化（resetKey）→ 旧项目的崩溃卡不残留，新子树照常渲染', async () => {
    await mount({ resetKey: 'D:/旧项目', children: h(MaybeRecovered, { ok: false }), onExit: () => {} });
    expect(container.querySelector('.project-crash')).not.toBeNull();

    await act(async () => {
      root!.render(
        h(ProjectErrorBoundary, {
          resetKey: 'D:/新项目',
          onExit: () => {},
          children: h(MaybeRecovered, { ok: true }),
        }),
      );
    });

    expect(container.querySelector('.project-crash')).toBeNull();
    expect(container.textContent).toContain('已恢复');
  });
});
