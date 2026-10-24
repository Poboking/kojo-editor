import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '../src/bridge/search';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, runSearch, setQuery, setSearchRunner } from '../src/ui/search-store';

/**
 * 检索面板视觉批判据（批次十一 L08）。
 *
 * 钉四件事（全部走 `react-dom/server` 静态渲染 + CSS 源码闸，口径同
 * `search-hit-area.test.ts`——本池 environment 是 node，无 jsdom）：
 * ① **帮助文字 4 行 → 1 行**：空态常驻只有 1 行引导，键位速查默认收进折叠区
 *    （`ksp-collapsed`，控件仍在 DOM——判据同「选项」区）；
 * ② **键位提示统一走 ui-kit 的 `KitKbd`**：渲染里每枚 `<kbd>` 都是 `.kit-kbd`
 *    芯片、组合键拆成逐键 `.kit-kbd-key`；面板源码不许再有第二份 Kbd 实现
 *    （`ui/KitKbd.tsx` 已删，L14 的 ui-kit 版本是唯一真源）；
 * ③ **空态给出引导而不是空白**：无检索词时一行引导在位；没有历史时给一句
 *    范围建议（`.ksp-suggest`），不是整片空白；
 * ④ **检索域 CSS 零色字面量**：`search-panel.css` 里不许出现 `rgb(`/`rgba(`
 *    ——含手调 alpha 的 `rgb(var(--accent-rgb) / .x)`（描边/高亮用 `--accent` 本体）。
 * 另钉 `ksp-file-count` 已并入 ui-kit `KitCount`（含 99+ 溢出形态）。
 * 检索 / 替换 / 流式语义零改动，本文件只碰呈现。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const cssSrc = (): string => read('../src/search-panel.css');
const panelSrc = (): string => read('../src/ui/SearchPanel.tsx');

const ANY_REVEAL = { onReveal: () => {} };

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  files: [],
  totalMatches: 0,
  truncated: false,
  cancelled: false,
  filesScanned: 0,
  skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
  elapsedMs: 0,
  ...over,
});

async function prime(res: SearchResult): Promise<void> {
  setSearchRunner(async () => res);
  setQuery('ABC');
  await runSearch(['C:\\game']);
}

const render = (): string =>
  renderToStaticMarkup(createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }));

describe('检索面板 · 空态帮助文字（4 行 → 1 行）', () => {
  beforeEach(() => resetSearch());
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('空态只有一行常驻引导，键位明细收进折叠区（控件仍在 DOM）', () => {
    const html = render();
    // ① 常驻引导恰好一行
    expect(html.match(/ksp-empty-line/g)?.length ?? 0).toBe(1);
    expect(html.match(/class="search-status dim ksp-hint"/g)?.length ?? 0).toBe(1);
    expect(html).toContain('输入检索词后回车开始检索');
    // ② 键位速查默认折叠（class 折叠手法，与「选项」区同一判据）+ 可钉住的展开钮
    expect(html).toContain('ksp-help-body ksp-collapsed');
    expect(html).toContain('ksp-help-toggle');
    // ③ 空态不是空白：无历史时给一句范围建议
    expect(html).toContain('ksp-suggest');
  });
});

describe('检索面板 · 键位提示统一走 ui-kit KitKbd', () => {
  beforeEach(() => resetSearch());
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('渲染里每枚 <kbd> 都是 .kit-kbd 芯片，组合键拆成 .kit-kbd-key', () => {
    const html = render();
    const kbdTags = html.match(/<kbd[^>]*>/g) ?? [];
    expect(kbdTags.length).toBeGreaterThanOrEqual(4);
    for (const tag of kbdTags) {
      expect(tag).toContain('class="kit-kbd"');
    }
    // combo 语言落地：Enter / Shift / F4 / Ctrl 都是逐键芯片，不是文本符号
    for (const key of ['Enter', 'Shift', 'F4', 'Ctrl']) {
      expect(html).toContain(`<span class="kit-kbd-key">${key}</span>`);
    }
    // 旧口径的文本符号一个不许剩（↵ / ⇧；↑↓ 只许作为 KitKbd 的 combo 芯片出现）
    expect(html).not.toContain('↵');
    expect(html).not.toContain('⇧');
  });

  it('面板源码不引第二份 Kbd（ui/KitKbd.tsx 已删，真源只有 ui-kit）', () => {
    expect(existsSync(fileURLToPath(new URL('../src/ui/KitKbd.tsx', import.meta.url)))).toBe(false);
    const src = panelSrc();
    expect(src).not.toContain("from './KitKbd'");
    expect(src).toContain("import { KitCount, KitKbd } from '../ui-kit'");
    // 组件用法只许 combo 形态（children 裸符号那套已随本地实现一起退场）
    for (const usage of src.match(/<KitKbd[^>]*>/g) ?? []) {
      expect(usage).toContain('combo=');
    }
  });
});

describe('检索面板 · 计数徽标并入 ui-kit KitCount', () => {
  beforeEach(() => resetSearch());
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('文件头计数挂 .kit-count（含 99+ 溢出形态），面板只留右靠差异', async () => {
    await prime(
      result({
        totalMatches: 150,
        files: [
          {
            path: 'C:\\game\\a.erb',
            matches: Array.from({ length: 150 }, (_, i) => ({
              line: i + 1,
              column: 1,
              preview: 'ABC',
              start: 0,
              end: 3,
            })),
          },
        ],
      }),
    );
    const html = render();
    expect(html).toContain('kit-count search-file-count ksp-file-count');
    // 溢出形态由 KitCount 给出：99+，悬停 title 回落真实读数
    expect(html).toContain('>99+<');
    expect(html).toContain('title="150"');
    expect(html).not.toContain('kit-count-badge');
  });
});

describe('检索面板 · search-panel.css 零色字面量', () => {
  it('全文件无 rgb(/rgba( 手调色——含手调 alpha 的 rgb(var(--accent-rgb) / .x)', () => {
    const css = cssSrc();
    expect(css).not.toMatch(/rgba?\(/);
    // 面板内也不许残留第二套 kbd / 计数徽标样式（真源在 ui-kit.css）
    expect(css).not.toContain('.kit-count-badge');
    expect(css).not.toContain('.kit-kbd {');
  });
});
