/**
 * 快捷键设置页的结构守门（b/kbset/1017 批次）。
 *
 * 本仓无 DOM 测试环境 ⇒ 一律 `renderToString` 钉**结构**（照 sugar-dialogs.test.ts 的路子）。
 * 交互（捕获改键的 window 监听、roving 漫游）钉不到，归实机验证，这里不硬造假绿。
 *
 * 钉的是这一页的判据：不给死控件（无覆盖不出「全部恢复默认」、不可改键行无操作钮）、
 * 改过与解绑两态分标、撞键就地指名、芯片按步分段、表头三列、空态有退路、去黑话、零 emoji。
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeybindingsPage } from '../src/ui/KeybindingsPage';
import { KEYBINDING_SPECS, buildKeybindingRows, effectiveKeybindingOf, filterKeybindingRows, resetAllKeybindings, setKeybindingOverride } from '../src/ui/keybindings';
import { MONACO_BUILTIN_COUNT, monacoBuiltinRows } from '../src/ui/monaco-builtin-keybindings';
import { isKeybindingRowModified } from '../src/ui/settings-menu';
import type { CommandEntry } from '../src/ui/commands';

const cmd = (input: { id: string; title: string; category?: string; keybinding?: string }): CommandEntry => ({
  ...input,
  run: () => {},
});

/** 与键位表一一对应的命令清单（形状照壳层：keybinding 由 effectiveKeybindingOf 现取） */
const allCommands = (): CommandEntry[] =>
  KEYBINDING_SPECS.map((s) => cmd({ id: s.id, title: s.title, category: s.category, keybinding: effectiveKeybindingOf(s.id) }));

const render = (commands: readonly CommandEntry[] = allCommands()): string =>
  renderToString(createElement(KeybindingsPage, { commands }));

/** 某一行的 HTML 切片（从它的 data-kb-id 到下一行之前）——把整表拆成可逐行断言的单元 */
function rowSlice(html: string, id: string): string {
  const start = html.indexOf(`data-kb-id="${id}"`);
  if (start === -1) throw new Error(`行不存在：${id}`);
  const next = html.indexOf('data-kb-id="', start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

/** 一行里的按键芯片枚数（一步一片；和弦两片） */
const chipCount = (slice: string): number => (slice.match(/class="kb-chip"/g) ?? []).length;

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

beforeEach(() => {
  resetAllKeybindings();
});
afterEach(() => {
  resetAllKeybindings();
});

describe('快捷键设置页 · 根结构与表头', () => {
  it('页面根节点是带名的 region（aria-label 挂在裸 div 上会被读屏丢弃）', () => {
    const html = render();
    expect(html).toContain('class="kb-page"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="键盘快捷键"');
  });

  it('region 与表两层的可访问名不相重（同名两个地标 = 读屏里分不清在哪个）', () => {
    const html = render();
    expect(html).toContain('class="kb-table" role="table" aria-label="快捷键列表"');
  });

  it('表头恰是三列：命令 / 按键绑定 / 操作', () => {
    const html = render();
    expect((html.match(/role="columnheader"/g) ?? []).length).toBe(3);
    expect(html).toContain('>命令<');
    expect(html).toContain('>按键绑定<');
    expect(html).toContain('>操作<');
  });

  it('渲染结果零 emoji', () => {
    expect(EMOJI.test(render())).toBe(false);
  });
});

describe('快捷键设置页 · 不给死控件', () => {
  it('无覆盖时不渲染「全部恢复默认」', () => {
    expect(render()).not.toContain('kb-resetall');
  });

  it('有覆盖时渲染且文案自带条数', () => {
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    // React 在插值处会插 `<!-- -->` 文本分隔符，先抹平再比人读串
    const html = render().replaceAll('<!-- -->', '');
    expect(html).toContain('kb-resetall');
    expect(html).toContain('恢复默认 (1)');
    expect(html).toContain('已改 (1)');
  });

  it('不可改键的行没有操作钮（负自证：无死控件）', () => {
    const html = render();
    expect(rowSlice(html, 'layout.toggleZen')).not.toContain('kb-icon-btn');
    expect(rowSlice(html, 'editor.internal.save')).not.toContain('kb-icon-btn');
  });

  it('可改键且有键位的行给出「移除键位」钮', () => {
    const slice = rowSlice(render(), 'workbench.problems');
    expect(slice).toContain('kb-icon-btn');
    expect(slice).toContain('aria-label="移除键位"');
  });
});

describe('快捷键设置页 · 改过与解绑两态分标', () => {
  it('已改行带 kb-overridden 左缘标记', () => {
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    const slice = rowSlice(render(), 'workbench.problems');
    expect(slice).toContain('kb-overridden');
    expect(slice).not.toContain('kb-unbound');
    expect(slice).toContain('aria-label="恢复缺省"');
  });

  it('解绑行带 kb-unbound（与改键行的标记 class 不同，两态不画成一件事）', () => {
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    const slice = rowSlice(render(), 'workbench.problems');
    expect(slice).toContain('kb-unbound');
    expect(slice).not.toContain('kb-overridden');
  });

  it('「已改」计数与唯一判据同源（改键与解绑都算，Monaco 内建行不计）', () => {
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    expect(setKeybindingOverride('layout.openSettings', '')).toBe(true);
    const rows = [...buildKeybindingRows(allCommands()), ...monacoBuiltinRows()];
    const changed = rows.filter(isKeybindingRowModified).length;
    expect(changed).toBe(2);
    const html = render().replaceAll('<!-- -->', '');
    expect(html).toContain(`已改 (${changed})`);
  });
});

describe('快捷键设置页 · 芯片分段', () => {
  it('单键行渲染出一片芯片', () => {
    expect(chipCount(rowSlice(render(), 'workbench.problems'))).toBe(1);
  });

  it('和弦行渲染出两片 + 一个 dim 间隔符', () => {
    const slice = rowSlice(render(), 'layout.toggleZen');
    expect(chipCount(slice)).toBe(2);
    expect(slice).toContain('kb-chip-sep');
  });

  it('无键位的可改行画 dim 破折号（不空白）', () => {
    expect(rowSlice(render(), 'layout.openSettings')).toContain('kb-dash');
  });
});

describe('快捷键设置页 · 撞键就地指名', () => {
  it('撞键行渲染出对方命令名', () => {
    expect(setKeybindingOverride('layout.reset', 'ctrl+shift+m')).toBe(true); // 与「问题面板」同键
    const slice = rowSlice(render(), 'workbench.problems');
    expect(slice).toContain('kb-conflict');
    expect(slice).toContain('重置布局');
  });
});

describe('快捷键设置页 · 空态与兜底', () => {
  /**
   * 1020 编辑器体感批改了这一格的判据：命令清单为空时页面**不再空**——
   * 「Monaco 内建」那一组恒在（它不来自命令注册表，正是这一批要补的可见性）。
   * 真·零命中（搜了个不存在的词）走的是 `filterKeybindingRows` 那条数据腿，
   * 本仓无 DOM 环境、SSR 敲不进查询框，所以在数据面钉住它，不硬造假绿。
   */
  it('命令清单为空时，内建组仍然列出（可见性不随命令表一起消失）', () => {
    const html = render([]);
    expect(html).toContain('Monaco 内建');
    expect(html).toContain('data-kb-id="monaco.editor.action.peekDefinition"');
    expect(html).toContain(`${MONACO_BUILTIN_COUNT} 条`);
  });

  it('数据腿的零命中给空表（页面上的「没有匹配的快捷键」由此驱动）', () => {
    const rows = buildKeybindingRows(allCommands());
    expect(rows.length).toBeGreaterThan(0);
    expect(filterKeybindingRows(rows, 'zzzqqq不存在的词')).toEqual([]);
    expect(filterKeybindingRows(rows, '').length).toBe(rows.length);
  });
});
