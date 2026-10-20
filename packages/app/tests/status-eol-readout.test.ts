// @vitest-environment happy-dom
/**
 * W7-H · 状态栏 EOL 读数的入口与菜单（真渲染）。
 *
 * 与 `status-eol-switch.test.ts` 分工：那份引真 Monaco 钉 model 行为（不点按钮，
 * 避开 happy-dom 下 Monaco 剪贴板 workaround 的取消 promise 噪声）；本文件只引壳层
 * （不引 Monaco），专门量"入口什么时候出现 / 点开弹出什么 / 选完回调谁"。
 *
 * 判据都是 `EditorStatusInfo.eolSwitchable`（EditorPane 每次上报现算）：
 * - 没打开文件（读数为 null）⇒ 整格不画；
 * - 只读 / 预览面 ⇒ 纯文字，没有按钮；
 * - 可写原文面 ⇒ 按钮 + LF / CRLF 两档菜单，选另一档回调一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EditorStatusReadout,
  isSameEditorStatus,
  setShellEditorStatus,
  type EditorStatusInfo,
} from '../src/ui/ShellLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (over: Partial<EditorStatusInfo> = {}): EditorStatusInfo => ({
  encoding: 'utf-8',
  eol: 'LF',
  lines: 12,
  ...over,
});

describe('状态栏 EOL 读数：只在可写原文面提供切换', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setShellEditorStatus(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    setShellEditorStatus(null);
  });

  const render = async (onSwitchEol?: (eol: 'LF' | 'CRLF') => void): Promise<void> => {
    await act(async () => {
      root.render(h(EditorStatusReadout, onSwitchEol ? { onSwitchEol } : {}));
    });
  };

  it('没打开文件（读数为 null）⇒ 整格不画，没有任何入口', async () => {
    await render(vi.fn());
    expect(container.querySelector('.sb-editor')).toBeNull();
    expect(container.querySelector('.sb-eol')).toBeNull();
  });

  it('只读 / 预览面（eolSwitchable 缺省或 false）⇒ EOL 是纯文字，按钮不出现', async () => {
    await render(vi.fn());
    await act(async () => setShellEditorStatus(info()));
    expect(container.querySelector('.sb-eol')).toBeNull();
    expect(container.textContent).toContain('LF');

    await act(async () => setShellEditorStatus(info({ eolSwitchable: false })));
    expect(container.querySelector('.sb-eol')).toBeNull();
    expect(container.textContent).toContain('LF');
  });

  it('可写原文面 ⇒ 点 EOL 弹出 LF / CRLF；选另一档回调一次并收菜单', async () => {
    const onSwitchEol = vi.fn();
    await render(onSwitchEol);
    await act(async () => setShellEditorStatus(info({ eolSwitchable: true })));

    const button = container.querySelector('button.sb-eol') as HTMLButtonElement | null;
    expect(button, '可写原文面必须有 EOL 切换入口').toBeTruthy();
    expect(button!.textContent).toBe('LF');
    expect(button!.getAttribute('aria-haspopup')).toBe('menu');

    await act(async () => {
      button!.click();
    });
    const items = [...container.querySelectorAll('button.sb-eol-item')];
    expect(items.map((b) => b.textContent)).toEqual(['LF', 'CRLF']);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(items[1]!.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      (items[1] as HTMLButtonElement).click();
    });
    expect(onSwitchEol).toHaveBeenCalledTimes(1);
    expect(onSwitchEol).toHaveBeenCalledWith('CRLF');
    expect(container.querySelector('.sb-eol-menu')).toBeNull();
  });

  it('选当前档只收菜单、不回调（状态栏不制造无意义脏）', async () => {
    const onSwitchEol = vi.fn();
    await render(onSwitchEol);
    await act(async () => setShellEditorStatus(info({ eolSwitchable: true })));

    await act(async () => {
      (container.querySelector('button.sb-eol') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelectorAll('button.sb-eol-item')[0] as HTMLButtonElement).click();
    });
    expect(onSwitchEol).not.toHaveBeenCalled();
    expect(container.querySelector('.sb-eol-menu')).toBeNull();
  });

  it('菜单开着时读数转成不可切换（进预览 / 只读）⇒ 菜单自动收起、入口消失', async () => {
    await render(vi.fn());
    await act(async () => setShellEditorStatus(info({ eolSwitchable: true })));
    await act(async () => {
      (container.querySelector('button.sb-eol') as HTMLButtonElement).click();
    });
    expect(container.querySelector('.sb-eol-menu')).toBeTruthy();

    await act(async () => setShellEditorStatus(info({ eolSwitchable: false })));
    expect(container.querySelector('.sb-eol-menu')).toBeNull();
    expect(container.querySelector('.sb-eol')).toBeNull();
  });

  it('isSameEditorStatus 把 eolSwitchable 纳入比较（漏比会让状态栏白重渲或漏更新）', () => {
    expect(isSameEditorStatus(info(), info({ eolSwitchable: false }))).toBe(true);
    expect(isSameEditorStatus(info(), info({ eolSwitchable: true }))).toBe(false);
    expect(
      isSameEditorStatus(info({ eol: 'CRLF' }), info({ eol: 'CRLF', eolSwitchable: true })),
    ).toBe(false);
  });
});
