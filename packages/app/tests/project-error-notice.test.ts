// @vitest-environment happy-dom
/**
 * 项目态错误可见性（REF-FRONT-PERF，2026-10-20）。
 *
 * 判据分两层：
 * - 纯函数：只有 phase === 'project' 才该显示；同一文案重复上报保持原引用（不刷屏）；
 * - 渲染：文案逐字上屏（含换行）、可关闭、同屏只有一条。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ProjectErrorNotice,
  raiseProjectError,
  visibleProjectError,
} from '../src/ui/project-error-notice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('visibleProjectError：只在项目态上屏', () => {
  it('project + 有错误 → 原样返回', () => {
    expect(visibleProjectError('project', '写允许域注册失败：x')).toBe('写允许域注册失败：x');
  });

  it('欢迎页 / 打开中 / 开机 → null（那几态由 WelcomeView 自己的错误区承担）', () => {
    expect(visibleProjectError('welcome', 'x')).toBeNull();
    expect(visibleProjectError('opening', 'x')).toBeNull();
    expect(visibleProjectError('boot', 'x')).toBeNull();
  });

  it('null / 空串 → null（空错误条不上屏）', () => {
    expect(visibleProjectError('project', null)).toBeNull();
    expect(visibleProjectError('project', '')).toBeNull();
  });
});

describe('raiseProjectError：同类错误不刷屏', () => {
  it('同一文案 → 原引用（React 直接 bail out，不重挂错误条）', () => {
    const current = '写允许域清除失败: IPC 不可用';
    expect(raiseProjectError(current, current)).toBe(current);
  });

  it('不同错误 → 覆盖旧文案（同屏始终只有一条）', () => {
    expect(raiseProjectError('旧错误', '新错误')).toBe('新错误');
    expect(raiseProjectError(null, '第一条')).toBe('第一条');
  });
});

describe('ProjectErrorNotice：文案原样 + 可关闭', () => {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('多行错误逐字显示，role=alert，同屏只有一条', async () => {
    const message = '写允许域注册失败（本项目将只能写入应用数据目录）：IPC 不可用\n第二行细节';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(h(ProjectErrorNotice, { message, onDismiss: () => {} }));
    });

    const boxes = container.querySelectorAll('.project-session-error');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.getAttribute('role')).toBe('alert');
    expect(boxes[0]?.classList.contains('notice')).toBe(true);
    expect(boxes[0]?.classList.contains('error')).toBe(true);
    expect(boxes[0]?.querySelector('.project-session-error-message')?.textContent).toBe(message);
  });

  it('关闭按钮把点击交给 onDismiss', async () => {
    const onDismiss = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(h(ProjectErrorNotice, { message: '关不掉的错误', onDismiss }));
    });
    const close = container.querySelector('button[aria-label="关闭错误提示"]') as HTMLButtonElement;
    expect(close).not.toBeNull();
    await act(async () => {
      close.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
