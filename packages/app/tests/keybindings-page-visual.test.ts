/**
 * 快捷键页视觉批（L17）的结构守门——与 keybindings-page.test.ts 同一套路：
 * 本仓无 DOM 测试环境 ⇒ `renderToString` 钉结构，不硬造假绿。
 *
 * 钉两件新事：
 *  ① 键位单面孔：每一枚键位芯片都由 `ui-kit` 的 `KitKbd` 渲染（DOM 上有 `kit-kbd`），
 *     `kb-chip` 只剩锚位外壳，页面不再手画裸字符串；
 *  ② 撞键不靠颜色单独说话：行上有语义类名 `kb-conflicted`，且行内同时有文字说明
 *     （「撞键：…」），色觉异常/高对比下信息不丢。
 * 另钉分组标题计数与「N / M 条」读数的数据腿（SSR 敲不进搜索框，判据在组件表达式里钉形）。
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeybindingsPage } from '../src/ui/KeybindingsPage';
import {
  KEYBINDING_SPECS,
  effectiveKeybindingOf,
  resetAllKeybindings,
  setKeybindingOverride,
} from '../src/ui/keybindings';
import type { CommandEntry } from '../src/ui/commands';

const cmd = (input: { id: string; title: string; category?: string; keybinding?: string }): CommandEntry => ({
  ...input,
  run: () => {},
});

const allCommands = (): CommandEntry[] =>
  KEYBINDING_SPECS.map((s) =>
    cmd({ id: s.id, title: s.title, category: s.category, keybinding: effectiveKeybindingOf(s.id) }),
  );

const render = (commands: readonly CommandEntry[] = allCommands()): string =>
  renderToString(createElement(KeybindingsPage, { commands }));

/** 某一行的 HTML 切片（口径同 keybindings-page.test.ts，靠 data-kb-id 锚点拆行） */
function rowSlice(html: string, id: string): string {
  const start = html.indexOf(`data-kb-id="${id}"`);
  if (start === -1) throw new Error(`行不存在：${id}`);
  const next = html.indexOf('data-kb-id="', start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

const chipCount = (slice: string): number => (slice.match(/class="kb-chip"/g) ?? []).length;
/** 只数 KitKbd 外层 kbd（`kit-kbd-chord`/`kit-kbd-key`/`kit-kbd-sep` 都带尾缀，不误中） */
const kitCount = (slice: string): number => (slice.match(/class="kit-kbd"/g) ?? []).length;

beforeEach(() => {
  resetAllKeybindings();
});
afterEach(() => {
  resetAllKeybindings();
});

describe('快捷键页 · 键位单面孔（一律经 KitKbd）', () => {
  it('每一枚芯片外壳里都是 KitKbd 的 kbd，页面不再手画裸字符串', () => {
    const html = render();
    // 每个 `<span class="kb-chip">` 的第一子元素必须是 `<kbd class="kit-kbd">`
    const wrappers = html.match(/<span class="kb-chip">/g) ?? [];
    expect(wrappers.length).toBeGreaterThan(0);
    const kitWrapped = html.match(/<span class="kb-chip"><kbd class="kit-kbd"/g) ?? [];
    expect(kitWrapped.length).toBe(wrappers.length);
  });

  it('逐行芯片枚数 = kit-kbd 枚数（单键一片、和弦两片都走同一张面孔）', () => {
    const html = render();
    for (const id of ['workbench.problems', 'layout.toggleZen', 'monaco.editor.action.peekDefinition']) {
      const slice = rowSlice(html, id);
      expect(chipCount(slice), `${id} 应有芯片`).toBeGreaterThan(0);
      expect(kitCount(slice), `${id} 的 kit-kbd 数`).toBe(chipCount(slice));
    }
  });

  it('KitKbd 的 aria 读法在场（和弦步与组合键都带归一读法的 kbd 语义）', () => {
    const slice = rowSlice(render(), 'workbench.problems');
    expect(slice).toContain('<kbd class="kit-kbd" aria-label=');
  });
});

describe('快捷键页 · 撞键语义（不靠颜色单独承载信息）', () => {
  it('撞键行带 kb-conflicted 语义类名，且行内有「撞键」文字说明', () => {
    expect(setKeybindingOverride('layout.reset', 'ctrl+shift+m')).toBe(true); // 与「问题面板」同键
    const slice = rowSlice(render(), 'workbench.problems');
    expect(slice).toContain('kb-conflicted');
    expect(slice).toContain('撞键：');
    expect(slice).toContain('重置布局'); // 文字里指名对方命令（色觉异常/高对比下不丢）
  });

  it('无撞键的行不带 kb-conflicted（负自证：语义类名不是全站糊底）', () => {
    const slice = rowSlice(render(), 'editor.internal.save');
    expect(slice).not.toContain('kb-conflicted');
  });
});

describe('快捷键页 · 分组计数读数', () => {
  it('每个分组标题带本节条数（kb-group-count），且各节之和 = 全表条数', () => {
    const html = render();
    const counts = [...html.matchAll(/class="kb-group-count">(\d+) 条</g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(1);
    const total = Number((html.match(/class="kb-count" role="status">(\d+) 条/) ?? [, '0'])[1]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
  });
});
