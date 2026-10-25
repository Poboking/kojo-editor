// @vitest-environment happy-dom
/**
 * B 批 · 状态栏即时开关（自动换行 / 空白符显示两格）+ 两条命令体。
 *
 * 真渲染 `EditorStatusReadout`（不引 Monaco，同 `status-eol-readout.test.ts` 的取证面），
 * 另钉三条纯口径：
 *  - 两格读的是**偏好真源**（`layout-pref` / `editor-display-prefs`）且值一变就重渲；
 *  - 切档只写偏好真源（活编辑器由既有订阅通路 `updateOptions`，不在状态栏另开写选项路径）；
 *  - 命令体（`applyToggleWordWrap` / `applyToggleRenderWhitespace`）无编辑器时给**中文**通知
 *    （铁律 4，不静默），有编辑器时写偏好；`Alt+Z` 与三档偏好的互操作在 `nextWordWrapToggle`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EditorStatusReadout,
  applyToggleRenderWhitespace,
  applyToggleWordWrap,
  setShellEditorStatus,
  type EditorStatusInfo,
  type ToggleCommandTarget,
} from '../src/ui/ShellLayout';
import { defaultKeybindingOf, keybindingSpecOf } from '../src/ui/keybindings';
import { loadLayoutPref, saveWordWrapPref } from '../src/ui/layout-pref';
import { loadEditorDisplayPrefs, saveEditorDisplayPrefs } from '../src/ui/editor-display-prefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE = 'C:\\kojo\\project\\口上\\角色.erb';

const info = (over: Partial<EditorStatusInfo> = {}): EditorStatusInfo => ({
  encoding: 'utf-8',
  eol: 'LF',
  lines: 12,
  ...over,
});

/** 命令体需要的最小编辑器替身（test 里只喂 `getModel().getLineCount()`） */
const fakeEditor = (lineCount: number): ToggleCommandTarget => ({
  getModel: () => ({ getLineCount: () => lineCount }),
});

describe('状态栏两格：渲染与当前值读数', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
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

  const render = async (activeFile: string | null): Promise<void> => {
    await act(async () => {
      root.render(h(EditorStatusReadout, { activeFile }));
    });
  };

  it('有活动文件 ⇒ 两格出现，读的是偏好真源当前值', async () => {
    saveWordWrapPref('off');
    saveEditorDisplayPrefs({ renderWhitespace: 'trailing' });
    await render(FILE);
    await act(async () => setShellEditorStatus(info()));
    expect(container.querySelector('button.sb-wordwrap')?.textContent).toBe('关');
    expect(container.querySelector('button.sb-whitespace')?.textContent).toBe('仅行尾');
  });

  it('无活动文件 ⇒ 两格整格不渲染（与相邻三格同一判据）', async () => {
    await render(null);
    await act(async () => setShellEditorStatus(info()));
    expect(container.querySelector('button.sb-wordwrap')).toBeNull();
    expect(container.querySelector('button.sb-whitespace')).toBeNull();
  });

  it('点自动换行格弹出三档（跟随档 / 开 / 关），选一档写 layout-pref 真源', async () => {
    await render(FILE);
    await act(async () => setShellEditorStatus(info()));
    expect(loadLayoutPref().wordWrap).toBe('tier');

    await act(async () => {
      (container.querySelector('button.sb-wordwrap') as HTMLButtonElement).click();
    });
    const items = [...container.querySelectorAll('.sb-eol-menu[aria-label="自动换行"] button.sb-eol-item')];
    expect(items.map((b) => b.textContent)).toEqual(['跟随档', '开', '关']);

    await act(async () => {
      (items[2] as HTMLButtonElement).click();
    });
    expect(loadLayoutPref().wordWrap).toBe('off');
    expect(container.querySelector('button.sb-wordwrap')?.textContent).toBe('关');
    expect(container.querySelector('.sb-eol-menu')).toBeNull();
  });

  it('点空白符格弹出五档（Monaco 登记序），选一档写 editor-display-prefs 真源', async () => {
    await render(FILE);
    await act(async () => setShellEditorStatus(info()));
    expect(loadEditorDisplayPrefs().renderWhitespace).toBe('none');

    await act(async () => {
      (container.querySelector('button.sb-whitespace') as HTMLButtonElement).click();
    });
    const items = [...container.querySelectorAll('.sb-eol-menu[aria-label="空白符显示"] button.sb-eol-item')];
    expect(items.map((b) => b.textContent)).toEqual(['不显示', '边界处', '仅选区', '仅行尾', '全部']);

    await act(async () => {
      (items[4] as HTMLButtonElement).click();
    });
    expect(loadEditorDisplayPrefs().renderWhitespace).toBe('all');
    expect(container.querySelector('button.sb-whitespace')?.textContent).toBe('全部');
  });

  it('选当前档只收菜单、不制造无意义写入（读数与真源都不动）', async () => {
    await render(FILE);
    await act(async () => setShellEditorStatus(info()));
    await act(async () => {
      (container.querySelector('button.sb-wordwrap') as HTMLButtonElement).click();
    });
    const first = container.querySelector('button.sb-eol-item') as HTMLButtonElement;
    await act(async () => first.click());
    expect(loadLayoutPref().wordWrap).toBe('tier');
    expect(container.querySelector('.sb-eol-menu')).toBeNull();
  });
});

describe('命令体：无编辑器给中文通知，不静默', () => {
  beforeEach(() => window.localStorage.clear());

  it('applyToggleWordWrap(null) 发中文，且不改偏好', () => {
    const notify = vi.fn();
    applyToggleWordWrap(null, notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain('没有可用的编辑器');
    expect(loadLayoutPref().wordWrap).toBe('tier');
  });

  it('applyToggleWordWrap(编辑器)：tier 按当前文档档位生效值翻转（tier 视为跟随档）', () => {
    const notify = vi.fn();
    // 小文件（10 行）档位表生效 'on' ⇒ 按下写 'off'
    applyToggleWordWrap(fakeEditor(10), notify);
    expect(loadLayoutPref().wordWrap).toBe('off');
    expect(notify).not.toHaveBeenCalled();
    // 再按一次：显式 off ⇒ on
    applyToggleWordWrap(fakeEditor(10), notify);
    expect(loadLayoutPref().wordWrap).toBe('on');
  });

  it('applyToggleRenderWhitespace：none ↔ all，其余档按非 none 处理', () => {
    const notify = vi.fn();
    applyToggleRenderWhitespace(null, notify);
    expect(notify.mock.calls[0]![0]).toContain('没有可用的编辑器');

    applyToggleRenderWhitespace(fakeEditor(10), notify);
    expect(loadEditorDisplayPrefs().renderWhitespace).toBe('all');
    applyToggleRenderWhitespace(fakeEditor(10), notify);
    expect(loadEditorDisplayPrefs().renderWhitespace).toBe('none');
    saveEditorDisplayPrefs({ renderWhitespace: 'selection' });
    applyToggleRenderWhitespace(fakeEditor(10), notify);
    expect(loadEditorDisplayPrefs().renderWhitespace).toBe('none');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('快捷键登记（Alt+Z）', () => {
  it('workbench.toggleWordWrap 缺省键 alt+z、可改键；空白符命令进表但无缺省键', () => {
    expect(defaultKeybindingOf('workbench.toggleWordWrap')).toBe('alt+z');
    expect(keybindingSpecOf('workbench.toggleWordWrap')?.rebindable).toBe(true);
    expect(keybindingSpecOf('workbench.toggleRenderWhitespace')?.rebindable).toBe(true);
    expect(defaultKeybindingOf('workbench.toggleRenderWhitespace')).toBeUndefined();
  });
});