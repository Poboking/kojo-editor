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
  raiseProjectErrorBar,
  visibleProjectError,
  type ProjectErrorAction,
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

describe('raiseProjectErrorBar：出路动作与文案同生同灭（WRITE-ADMIT-SPLIT 出路①）', () => {
  const action = (label: string): ProjectErrorAction => ({ label, title: '悬停说明', run: () => undefined });

  it('文案相同且两边都没有出路 → 保持原引用（同屏不重挂）', () => {
    const current = { message: '关闭项目时可写范围没能清空：IPC 不可用', action: null };
    expect(raiseProjectErrorBar(current, { message: current.message, action: null })).toBe(current);
  });

  it('文案相同但带出路 → 一律换新：执行体抓着这一次的项目目录，屏上不许留旧那份', () => {
    const stale = { message: '同一个原因', action: action('重新选择这个文件夹') };
    const next = raiseProjectErrorBar(stale, { message: '同一个原因', action: action('重新选择这个文件夹') });
    expect(next).not.toBe(stale);
    expect(next?.action?.label).toBe('重新选择这个文件夹');
  });

  it('不同错误 → 覆盖（旧的出路不许留在新的文案上）', () => {
    const prev = { message: '旧错误', action: action('旧出路') };
    expect(raiseProjectErrorBar(prev, { message: '新错误', action: null })).toEqual({ message: '新错误', action: null });
  });

  it('前一条为空 → 直接上新那条', () => {
    expect(raiseProjectErrorBar(null, { message: '第一条', action: null })).toEqual({ message: '第一条', action: null });
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

  it('带出路的错误：按钮上屏（中文 label + 悬停说明），点了就交出去', async () => {
    const run = vi.fn();
    const message = '这个项目文件夹眼下不能写入，只有编辑器自己的文件夹能写：宿主给的原因';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        h(ProjectErrorNotice, {
          message,
          onDismiss: () => undefined,
          action: { label: '重新选择这个文件夹', title: '在弹出的系统选目录框里选回这个项目文件夹，编辑器才会允许写入', run },
        }),
      );
    });

    const box = container.querySelector('.project-session-error');
    expect(box?.querySelector('.project-session-error-message')?.textContent).toBe(message);
    const fix = box?.querySelector('.toast-action') as HTMLButtonElement | null;
    expect(fix).not.toBeNull();
    expect(fix?.textContent).toBe('重新选择这个文件夹');
    expect(fix?.title).toBe('在弹出的系统选目录框里选回这个项目文件夹，编辑器才会允许写入');
    await act(async () => {
      fix!.click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    // 出路按钮不顶掉关闭叉：同屏仍只有一条错误条
    expect(container.querySelectorAll('.project-session-error')).toHaveLength(1);
    expect(box?.querySelector('button[aria-label="关闭错误提示"]')).not.toBeNull();
  });

  it('没有出路的错误：只有文案与关闭叉（旧渲染零改动）', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(h(ProjectErrorNotice, { message: '关闭项目时可写范围没能清空：IPC 不可用', onDismiss: () => undefined }));
    });
    expect(container.querySelector('.toast-action')).toBeNull();
  });
});
