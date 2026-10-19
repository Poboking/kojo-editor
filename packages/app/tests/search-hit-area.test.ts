import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '../src/bridge/search';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, runSearch, setQuery, setSearchRunner } from '../src/ui/search-store';

/**
 * 搜索面板小控件的**命中区 ≥24px** 判据（P3-2；WCAG 2.5.8 最小目标）。
 *
 * 本池 environment 是 node（无 jsdom、不跑真实布局），所以判据分两条腿：
 * ① CSS 源码闸（口径照 `boot-sweep-single-source.test.ts` 的 `readFileSync` 读源码比对）：
 *    钉住 `search-panel.css` 里"热区扩边"这套规则确实在——小盒靠 `::before` 透明热区
 *    外扩（各钮本体 `position: relative` 做锚），输入类直接 `min-height: 24px`；
 * ② 渲染结构闸：面板静态渲染里这些类名确实挂在真 `<button>` / `<input>` 上——
 *    CSS 写得再对，类名漂了等于没写。
 * 观感口径：本体尺寸不许被顺手改大（20/22 的原盒是排版基准），所以同时钉原尺寸。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const cssSrc = (): string => read('../src/search-panel.css');

/** 取某选择器的声明块；同名选择器出现在"共享列表规则 + 单独规则"两处时取**最后一处**（单独规则在文件里写于共享段之后） */
const blockOf = (sel: string): string | null => {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let last: string | null = null;
  for (const m of cssSrc().matchAll(re)) last = m[1] ?? null;
  return last;
};

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

describe('搜索面板命中区：CSS 热区规则在位（search-panel.css）', () => {
  it('扩热区的五族小钮本体都有 position: relative（::before 的定位锚）', () => {
    for (const sel of [
      '.panel-search.ksp .ksp-icon-btn',
      '.panel-search.ksp .ksp-toggle',
      '.panel-search.ksp .ksp-options-toggle',
      '.panel-search.ksp .ksp-row-replace',
      '.panel-search.ksp .search-file',
    ]) {
      const block = blockOf(sel);
      expect(block, `${sel} 规则块不见了`).not.toBeNull();
      expect(block, `${sel} 缺 position: relative，热区 ::before 会锚到祖先上`).toContain(
        'position: relative',
      );
    }
  });

  it('热区 ::before 是透明绝对定位层，且各族扩边量把命中盒抬到 ≥24px', () => {
    // 公共层：只扩命中、不画东西（观感零变化的前提）
    const common = blockOf(
      [
        '.panel-search.ksp .ksp-icon-btn::before',
        '.panel-search.ksp .ksp-toggle::before',
        '.panel-search.ksp .ksp-options-toggle::before',
        '.panel-search.ksp .ksp-row-replace::before',
        '.panel-search.ksp .search-file::before',
      ].join(',\n'),
    );
    expect(common, '热区公共规则块不见了').not.toBeNull();
    expect(common).toContain("content: ''");
    expect(common).toContain('position: absolute');
    // 本体尺寸 × 扩边量：20+2×2 / 22+2×1 / 18+2×3 → 全部 ≥24
    expect(blockOf('.panel-search.ksp .ksp-icon-btn::before'), 'chevron 钮热区不足 24').toContain('inset: -1px');
    expect(blockOf('.panel-search.ksp .ksp-toggle::before'), '框内 toggle 热区不足 24').toContain('inset: -2px');
    expect(blockOf('.panel-search.ksp .ksp-options-toggle::before'), '选项折叠钮热区不足 24').toContain(
      'inset: -2px 0',
    );
    expect(blockOf('.panel-search.ksp .ksp-row-replace::before'), '单条替换钮热区不足 24').toContain('inset: -3px 0');
    expect(blockOf('.panel-search.ksp .search-file::before'), '文件头钮热区不足 24').toContain('inset: -1px 0');
  });

  it('输入类直接 min-height: 24px（井内净高 24，撑满即零行高变化）', () => {
    expect(blockOf('.panel-search.ksp .ksp-input'), '检索/替换输入框命中高度不足 24').toContain('min-height: 24px');
    // 类型/glob 输入框与排序下拉共享一条规则（选择器列表尾项是 .ksp-opt-select，取它即取到整块）
    const opts = blockOf('.panel-search.ksp .ksp-opt-select');
    expect(opts, '类型/glob 输入框规则不见了').not.toBeNull();
    expect(opts).toContain('min-height: 24px');
  });

  it('观感口径：本体原盒没被顺手改大（20/22 仍是 20/22，热区只走 ::before）', () => {
    expect(blockOf('.panel-search.ksp .ksp-toggle')).toContain('height: 20px');
    expect(blockOf('.panel-search.ksp .ksp-icon-btn')).toContain('height: 22px');
  });

  it('未越界：本闸只动 search-panel.css，小控件旧尺寸规则的覆盖靠双类特异性而非 styles-project.css', () => {
    const src = cssSrc();
    expect(src, '不许用 !important 硬压并行线的规则').not.toContain('!important');
    expect(src.match(/\.panel-search\.ksp/g), '每条规则都应带 .panel-search.ksp 前缀提特异性').not.toBeNull();
  });
});

describe('搜索面板命中区：控件类名挂在真交互元素上（静态渲染）', () => {
  beforeEach(() => resetSearch());
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('未检索时：chevron / 三枚 toggle / 输入框 / 搜索钮 / 选项折叠钮都在场', () => {
    const html = renderToStaticMarkup(createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }));
    expect(html).toContain('ksp-icon-btn ksp-twisty');
    expect(html).toContain('class="search-input ksp-input"');
    for (const label of ['区分大小写', '全词匹配', '正则表达式']) {
      expect(html, `框内 toggle「${label}」不见了`).toContain(`search-toggle ksp-toggle`);
    }
    expect(html).toContain('ksp-go');
    expect(html).toContain('ksp-options-toggle');
    // SearchFilterBar 的「保留大小写」同挂 .ksp-toggle → 吃同一条热区规则
    expect(html).toContain('search-toggle ksp-toggle sfb-case');
  });

  it('有结果时：文件头钮与单条替换钮在场（热区规则的目标元素没漂）', async () => {
    setSearchRunner(async () =>
      result({
        totalMatches: 1,
        filesScanned: 1,
        files: [
          {
            path: 'C:\\game\\事件.ERB',
            matches: [{ line: 2, column: 5, preview: '二行目にABC', start: 4, end: 7 }],
          },
        ],
      }),
    );
    setQuery('ABC');
    await runSearch(['C:\\game']);
    const html = renderToStaticMarkup(createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }));
    expect(html).toContain('search-file ksp-file');
    expect(html).toContain('search-replace-one ksp-row-replace');
  });
});
