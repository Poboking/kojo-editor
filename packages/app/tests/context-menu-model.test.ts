// @vitest-environment happy-dom
/**
 * 右键菜单**数据面**判据（1023 覆盖面批 · WP0）。
 *
 * 钉四件事：
 * - 菜单项模型只增不改（子菜单 / 分组 / 禁用原因都是可选字段，旧消费方零改动）；
 * - 命令 → 菜单项的适配（标题与键位从键位注册表取，未登记 ⇒ null）；
 * - 中文化守卫（非中文整项丢弃，且**丢一次说一次话**）；
 * - 三级兜底的最后一级（输入类 / 通用两类都不为空、全中文、不可用给原因）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// 源码原文（`?raw` 直读，不执行）：Monaco 装配序是纯文本顺序，读文比跑壳可靠
import entrySource from '../src/monaco/entry.ts?raw';
import * as model from '../src/ui/context-menu-model';
import {
  FALLBACK_MENU_ARIA_LABEL,
  buildFallbackMenu,
  clampMenuPosition,
  filterChineseMenuItems,
  isChineseMenuLabel,
  menuItemFromCommand,
  nextMenuIndex,
  type ContextMenuItem,
} from '../src/ui/context-menu-model';
import { ContextMenu, clampMenuPosition as clampFromComponent } from '../src/ui/context-menu';

const item = (id: string, extra: Partial<ContextMenuItem> = {}): ContextMenuItem => ({
  id,
  label: id,
  ...extra,
});

describe('isChineseMenuLabel · 中文化判定', () => {
  it('含中日韩表意文字即算中文（纯中文 / 中英混排 / 中文括注都算）', () => {
    expect(isChineseMenuLabel('打开文件')).toBe(true);
    expect(isChineseMenuLabel('打开 File')).toBe(true);
    expect(isChineseMenuLabel('全部保存（Ctrl+Shift+S）')).toBe(true);
  });

  it('英文 / 空串 / 纯符号数字一律不算', () => {
    expect(isChineseMenuLabel('Open File')).toBe(false);
    expect(isChineseMenuLabel('')).toBe(false);
    expect(isChineseMenuLabel('Ctrl+Shift+P')).toBe(false);
    expect(isChineseMenuLabel('…')).toBe(false);
  });
});

describe('menuItemFromCommand · 命令项适配器', () => {
  it('已登记且有缺省键位：中文标题 + 格式化键位（Ctrl+Shift+P）', () => {
    const item = menuItemFromCommand('workbench.commandPalette');
    expect(item).toEqual({ id: 'workbench.commandPalette', label: '命令面板', shortcut: 'Ctrl+Shift+P' });
  });

  it('已登记但无缺省键位：有标题、没有 shortcut（不画一个空右列）', () => {
    const item = menuItemFromCommand('layout.openSettings');
    expect(item?.label).toBe('打开设置');
    expect(item?.shortcut).toBeUndefined();
  });

  it('未登记的命令 → null（调用方整项不显示，铁律 4）', () => {
    expect(menuItemFromCommand('nope.notACommand')).toBeNull();
  });

  it('overrides 覆盖文案但沿用同一份 id（各面只在措辞不同时才覆盖）', () => {
    const item = menuItemFromCommand('layout.openSettings', { label: '打开设置页', danger: true });
    expect(item).toMatchObject({ id: 'layout.openSettings', label: '打开设置页', danger: true });
  });

  it('兜底菜单要用的三条命令都在键位注册表里（否则会被静默丢弃）', () => {
    expect(menuItemFromCommand('workbench.commandPalette')).not.toBeNull();
    expect(menuItemFromCommand('layout.openSettings')).not.toBeNull();
    expect(menuItemFromCommand('workbench.checkUpdates')).not.toBeNull();
  });
});

describe('菜单项模型 · 新增字段只增不改', () => {
  it('子菜单 / 分组 / 禁用原因都能原样带过守卫', () => {
    // 这一条会触发「Markdown 被丢」的告警：告警本身由下面的用例单独钉，这里只静音
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const items = filterChineseMenuItems([
      item('copy-as', {
        label: '复制为',
        group: '编辑',
        children: [item('copy-plain', { label: '纯文本' }), item('copy-md', { label: 'Markdown' })],
      }),
      item('save', { label: '保存', disabled: true, disabledReason: '文件未修改' }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]?.group).toBe('编辑');
    expect(items[0]?.children).toHaveLength(1); // Markdown 那项被中文化守卫丢了
    expect(items[1]?.disabledReason).toBe('文件未修改');
    warn.mockRestore();
  });

  it('非中文项整项丢弃；子项全丢光的父项一起丢（不留空壳入口）', () => {
    const items = filterChineseMenuItems([
      item('open', { label: 'Open' }),
      item('more', { label: '更多', children: [item('x', { label: 'Export' })] }),
      item('save', { label: '保存' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['save']);
  });

  it('丢弃只告警一次（同批刷屏没人看）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import('../src/ui/context-menu-model');
    const dirty = [item('a', { label: 'Open File' }), item('b', { label: '打开文件' })];
    expect(fresh.filterChineseMenuItems(dirty).map((i) => i.id)).toEqual(['b']);
    fresh.filterChineseMenuItems([item('c', { label: 'Save' })]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('旧口径兼容 · 夹取与键盘落点仍从同一处导出', () => {
  it('context-menu.tsx 的 re-export 与模型是同一批函数（不是各抄一份）', () => {
    expect(clampFromComponent).toBe(clampMenuPosition);
    expect(model.nextMenuIndex).toBe(nextMenuIndex);
    expect(model.MENU_VIEWPORT_MARGIN).toBe(4);
  });

  it('夹取与键盘落点的语义未被本批改动', () => {
    expect(clampMenuPosition(120, 90, { width: 260, height: 300 }, { width: 1280, height: 720 })).toEqual({
      left: 120,
      top: 90,
    });
    const items = [item('a'), item('b', { disabled: true }), item('c')];
    expect(nextMenuIndex(items, 0, 'ArrowDown')).toBe(2);
    expect(nextMenuIndex(items, -1, 'ArrowUp')).toBe(2);
  });
});

describe('buildFallbackMenu · 三级兜底的最后一级', () => {
  it('输入类目标：撤销/重做、剪切/复制/粘贴、全选，且文案全中文', () => {
    const input = document.createElement('input');
    input.value = '口上正文';
    document.body.appendChild(input);
    input.setSelectionRange(0, 2);

    const items = buildFallbackMenu(input);
    const labels = items.map((i) => i.label);
    expect(labels.slice(0, 2)).toEqual(['撤销', '重做']);
    expect(labels).toContain('剪切');
    expect(labels).toContain('复制');
    expect(labels).toContain('粘贴');
    expect(labels[labels.length - 1]).toBe('全选');
    for (const entry of items) expect(isChineseMenuLabel(entry.label), entry.id).toBe(true);
  });

  it('输入类目标无选区：复制/剪切禁用且给出原因（不灰着不说话）', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    const items = buildFallbackMenu(textarea);
    const copy = items.find((i) => i.id === 'clipboard.copy');
    expect(copy?.disabled).toBe(true);
    expect(copy?.disabledReason).toBe('没有选中内容');
  });

  it('通用目标：复制/全选 + 命令项，且文案全中文', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const items = buildFallbackMenu(host);
    expect(items.map((i) => i.label).slice(0, 2)).toEqual(['复制', '全选']);
    expect(items.map((i) => i.id)).toContain('workbench.commandPalette');
    expect(items.map((i) => i.id)).toContain('layout.openSettings');
    expect(items.map((i) => i.id)).toContain('workbench.checkUpdates');
    expect(items.find((i) => i.id === 'clipboard.copy')?.disabledReason).toBe('没有选中内容');
    // 命令通道没接（node / 欢迎页）：命令项禁用并说明原因，而不是假装能按
    expect(items.find((i) => i.id === 'workbench.commandPalette')?.disabled).toBe(true);
    for (const entry of items) expect(isChineseMenuLabel(entry.label), entry.id).toBe(true);
  });

  it('通用目标有选区：复制可用（有选区才可用是这一项的唯一判据）', () => {
    const host = document.createElement('div');
    host.textContent = '一段可以选中的正文';
    document.body.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const copy = buildFallbackMenu(host).find((i) => i.id === 'clipboard.copy');
    expect(copy?.disabled).toBeUndefined();
    selection?.removeAllRanges();
  });

  it('兜底的无障碍名固定为「通用菜单」（各面不会各自造一个）', () => {
    expect(FALLBACK_MENU_ARIA_LABEL).toBe('通用菜单');
  });
});

describe('ContextMenu · 新形态上屏（分组 / 子菜单 / 禁用原因）', () => {
  const htmlOf = (items: readonly ContextMenuItem[]): string =>
    renderToStaticMarkup(h(ContextMenu, { x: 4, y: 6, items, onSelect: () => {}, onDismiss: () => {} }));

  it('连续同 group 的项归一段：只在段首画小节头', () => {
    const html = htmlOf([
      item('open', { label: '打开', group: '编辑' }),
      item('copy', { label: '复制', group: '编辑' }),
      item('rename', { label: '重命名', group: '文件' }),
    ]);
    expect(html.match(/context-menu-group/g)).toHaveLength(2);
    expect(html).toContain('>编辑<');
    expect(html).toContain('>文件<');
  });

  it('子菜单父项带 aria-haspopup / aria-expanded，本身不是可执行动作', () => {
    const html = htmlOf([
      item('copy-as', {
        label: '复制为',
        children: [item('copy-plain', { label: '纯文本' }), item('copy-md', { label: 'Markdown' })],
      }),
    ]);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('context-menu-arrow');
    // 子菜单未展开时不上屏（点开才渲染第二层）
    expect(html).not.toContain('纯文本');
  });

  it('禁用原因同时进 title 与 aria-description（不灰着不说话）', () => {
    const html = htmlOf([]);
    expect(html).toContain('role="menu"');
    const disabled = htmlOf([
      item('copy', { label: '复制', disabled: true, disabledReason: '没有选中内容' }),
    ]);
    expect(disabled).toContain('title="没有选中内容"');
    expect(disabled).toContain('aria-description="没有选中内容"');
  });
});

describe('中文化守卫 · Monaco NLS 装配序（断言源码顺序，防回退）', () => {
  it('zh-cn 的 import 必须排在所有 monaco 模块 import 之前（否则原生菜单中英混杂）', () => {
    const source = entrySource;
    const nlsImport = "import 'monaco-editor/nls/lang/zh-cn.js'";
    const nlsAt = source.indexOf(nlsImport);
    expect(nlsAt).toBeGreaterThanOrEqual(0);

    const monacoImports = [...source.matchAll(/import\s+'monaco-editor\/[^']+'/g)]
      .map((match) => match.index)
      .filter((at): at is number => at !== undefined && source.slice(at, at + nlsImport.length) !== nlsImport);
    expect(monacoImports.length).toBeGreaterThan(0);
    for (const at of monacoImports) expect(nlsAt).toBeLessThan(at);
  });
});
