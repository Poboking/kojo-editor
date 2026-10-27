import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EditorCommandContext } from '@kojo/plugin-api';
import { CommandPalette, QuickOpen, commandRows } from '../src/ui/Palette';
import type { CommandEntry } from '../src/ui/commands';
import { commandItems } from '../src/ui/palette-search';

/**
 * 命令面板批（2026-10-20）的**显示层**判据。
 *
 * 口径照 `search-panel-render.test.ts` / `workspace-symbols.test.ts`：仓库测试环境是 node
 * （无 jsdom），故用 `react-dom/server` 做一次静态渲染——够钉住"给定命令 ⇒ 产出带分组标签
 * 与整列快捷键占位的列表"，键盘行为（↑↓/Enter/Esc、合成期让位）另由
 * `workspace-symbols.test.ts` 那条源码闸门守着。
 *
 * 分组搬运住在 `commandRows`（显示层纯函数）：**过滤与排序判据一行未动**，
 * 仍是 `commands.filterCommands`（那一条尺子的读数由 `commands.test.ts` 钉着）。
 */

const CTX: EditorCommandContext = { project: null };
const A = 'C:\\game\\ERB\\口上A.ERB';
const B = 'C:\\game\\ERB\\口上B.ERB';

const CMD: readonly CommandEntry[] = [
  { id: 'workbench.saveAll', title: '全部保存', category: '工作台', keybinding: 'ctrl+shift+s', run: () => undefined },
  { id: 'workbench.closeAll', title: '关闭全部', category: '工作台', run: () => undefined },
  { id: 'layout.toggleZen', title: '切换写作模式', category: '布局', keybinding: 'ctrl+alt+z', run: () => undefined },
];

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const paletteHtml = (): string =>
  renderToStaticMarkup(createElement(CommandPalette, { commands: CMD, commandCtx: CTX, onClose: () => undefined }));

describe('commandRows · 分类从主行搬到分组标签', () => {
  it('主行只剩标题、分组标签取注册表的 category（不再拼进标题文本）', () => {
    const rows = commandRows(commandItems(CMD, '', CTX), CMD);
    // 类内次序仍是 `filterCommands` 那条（码点序，见 commands.ts 的 byCodePoint 理由），本批一行未动
    expect(rows.map((r) => r.primary)).toEqual(['全部保存', '关闭全部', '切换写作模式']);
    expect(rows.map((r) => r.group)).toEqual(['工作台', '工作台', '布局']);
    expect(rows.map((r) => r.key)).toEqual(['workbench.saveAll', 'workbench.closeAll', 'layout.toggleZen']);
  });

  it('无分类的命令原样通过（不硬造一个分组）', () => {
    const bare: readonly CommandEntry[] = [{ id: 'x.y', title: '没有分类', run: () => undefined }];
    expect(commandRows(commandItems(bare, '', CTX), bare)).toEqual([{ key: 'x.y', primary: '没有分类', disabled: false }]);
  });

  it('命中区间跟着主行平移（整段落在分类名里就撤掉高亮，不画半个 mark）', () => {
    const titleHit = commandRows(commandItems(CMD, '部保存', CTX), CMD).find((r) => r.key === 'workbench.saveAll');
    expect(titleHit?.primary).toBe('全部保存');
    // 原串「工作台: 全部保存」里「部保存」在 [6,9)，切掉 5 枚前缀 ⇒ [1,4)
    expect(titleHit?.ranges).toEqual([[1, 4]]);
    const catOnly = commandRows(commandItems(CMD, '工作台', CTX), CMD).find((r) => r.key === 'workbench.saveAll');
    expect(catOnly?.primary).toBe('全部保存');
    expect(catOnly?.ranges).toBeUndefined();
  });

  it('最近使用那几条保留「最近使用」分组，不被分类名盖回去（WS-16：置顶只剩顺序就没人认得出）', () => {
    const rows = commandRows(commandItems(CMD, '', CTX, { recent: ['layout.toggleZen'] }), CMD);
    expect(rows.map((r) => r.key)).toEqual(['layout.toggleZen', 'workbench.saveAll', 'workbench.closeAll']);
    expect(rows.map((r) => r.group)).toEqual(['最近使用', '工作台', '工作台']);
    // 主行照旧剥掉分类前缀（置顶行也不画成「布局: 切换写作模式」那种长串）
    expect(rows[0]!.primary).toBe('切换写作模式');
  });
});

describe('CommandPalette 静态渲染 · 分组与快捷键列', () => {
  it('按 category 插分组标签（换组那一行一条），标题里不再带分类前缀', () => {
    const html = paletteHtml();
    expect(count(html, 'picker-group-label')).toBe(2);
    expect(html).toContain('布局');
    expect(html).toContain('工作台');
    expect(html).not.toContain('工作台: 全部保存');
    expect(html).toContain('全部保存');
  });

  it('快捷键列每行都有格子：有绑定的画芯片，没绑定的留空格子（右缘不锯齿）', () => {
    const html = paletteHtml();
    expect(count(html, 'class="pk-kbd"')).toBe(CMD.length);
    expect(html).toContain('pk-kbd"><span class="picker-hint dim">Ctrl+Shift+S</span>');
    expect(html).toContain('pk-kbd"><span class="picker-hint dim">Ctrl+Alt+Z</span>');
    expect(count(html, 'class="pk-kbd"></span>')).toBe(1); // 只有 workbench.closeAll 没键位
  });

  it('分组标签不占键盘导航的下标（data-idx 仍是连续的 0..n-1）', () => {
    const html = paletteHtml();
    expect([...html.matchAll(/data-idx="(\d)"/g)].map((m) => m[1])).toEqual(['0', '1', '2']);
  });

  it('命令面板档：列表挂 pk-list（粘顶标签）、遮罩挂 pk-mask；两者都只在 F1 生效', () => {
    const html = paletteHtml();
    expect(html).toContain('picker-list pk-list');
    expect(html).toContain('picker-backdrop pk pk-mask');
  });

  it('禁态仍按 when 求值（搬运不改 commandItems 的 disabled 判定）', () => {
    const withWhen: readonly CommandEntry[] = [
      { id: 'editor.rename', title: '重命名符号', category: '编辑器', run: () => undefined, when: (c) => c.activeFile !== undefined },
    ];
    const disabled = renderToStaticMarkup(
      createElement(CommandPalette, { commands: withWhen, commandCtx: CTX, onClose: () => undefined }),
    );
    const enabled = renderToStaticMarkup(
      createElement(CommandPalette, {
        commands: withWhen,
        commandCtx: { project: null, activeFile: A },
        onClose: () => undefined,
      }),
    );
    expect(disabled).toContain('disabled=""');
    expect(enabled).not.toContain('disabled=""');
  });
});

describe('QuickOpen 不被本批波及（复用同一个 Picker）', () => {
  const openHtml = (): string =>
    renderToStaticMarkup(
      createElement(QuickOpen, {
        files: [A, B],
        recent: [B],
        commands: CMD,
        commandCtx: CTX,
        activeFileSymbols: () => null,
        activeFile: A,
        onOpenFile: () => undefined,
        onReveal: () => undefined,
        onClose: () => undefined,
      }),
    );

  it('文件模式：不挂 pk-list / pk-kbd / pk-mask，「最近打开」仍走旧类名', () => {
    const html = openHtml();
    expect(html).not.toContain('pk-list');
    expect(html).not.toContain('pk-kbd');
    expect(html).not.toContain('pk-mask');
    expect(html).toContain('picker-group-label dim">最近打开');
    expect(html).toContain('输入 &gt; 找命令');
  });

  it('行号模式那一条候选仍用旧的行内 hint（快捷键列不越界到它）', () => {
    // `:` 档 variant = default：hint 直接是 .picker-hint，不套 pk-kbd 格子
    const html = renderToStaticMarkup(
      createElement(QuickOpen, {
        files: [A],
        commands: CMD,
        commandCtx: CTX,
        activeFileSymbols: () => null,
        activeFile: A,
        onOpenFile: () => undefined,
        onReveal: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).not.toContain('pk-kbd');
  });
});
