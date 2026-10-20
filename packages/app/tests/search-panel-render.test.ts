import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SearchResult } from '../src/bridge/search';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, runSearch, setQuery, setSearchRunner, stepSearchMatch } from '../src/ui/search-store';

/**
 * 检索面板的**静态渲染**判据（2026-10-15 检索批）。
 *
 * 纯逻辑单测覆盖不到"结果到底画出来没有"：分组头、`行:列`、命中高亮、
 * 截断提示这四件是作者能不能用的最后一厘米。仓库测试环境是 node（无 jsdom），
 * 所以用 `react-dom/server` 做一次服务端渲染——足够钉住"给定结果 ⇒ 产出含
 * 命中高亮与位置标签的列表"，且不需要 DOM 事件这一层（点击走 onReveal，逻辑在宿主）。
 */

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

const ANY_REVEAL = { onReveal: () => {} };

async function prime(res: SearchResult): Promise<void> {
  setSearchRunner(async () => res);
  setQuery('ABC');
  await runSearch(['C:\\game']);
}

describe('SearchPanel 渲染', () => {
  beforeEach(() => resetSearch());
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('未检索时给出发力提示（不画空列表）', () => {
    const html = renderToStaticMarkup(createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }));
    expect(html).toContain('在文件中搜索');
    expect(html).toContain('输入检索词后回车');
    expect(html).not.toContain('search-rows');
  });

  it('结果按文件分组：文件头 + 行:列 + 命中高亮', async () => {
    await prime(
      result({
        totalMatches: 2,
        filesScanned: 10,
        elapsedMs: 1200,
        files: [
          {
            path: 'C:\\game\\ERB\\事件.ERB',
            matches: [
              { line: 2, column: 5, preview: '二行目にABC', start: 4, end: 7 },
              { line: 9, column: 1, preview: 'ABC 开头', start: 0, end: 3 },
            ],
          },
        ],
      }),
    );
    const html = renderToStaticMarkup(
      createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }),
    );
    expect(html).toContain('ERB/事件.ERB');
    expect(html).toContain('<mark class="search-hit">ABC</mark>');
    expect(html).toContain('二行目に');
    expect(html).toContain('>2:5<');
    expect(html).toContain('>9:1<');
    expect(html).toContain('2 条结果');
    expect(html).toContain('1.2s');
    // 文件头的计数（该文件 2 条）
    expect(html).toContain('search-file-count');
  });

  it('截断与跳过逐项画出来（不许看起来"搜完了"）', async () => {
    await prime(
      result({
        truncated: true,
        skipped: { binary: 2, tooLarge: 0, unreadable: 1, filtered: 30 },
      }),
    );
    const html = renderToStaticMarkup(
      createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }),
    );
    expect(html).toContain('结果已达上限');
    expect(html).toContain('2 个二进制文件');
    expect(html).toContain('1 个文件读取失败');
    expect(html).toContain('30 个文件被类型过滤挡下');
  });

  it('结果读数带「第 X 项 / 共 Y 项」，逐项导航后跟着走（回车 / F4 同一条数据面）', async () => {
    await prime(
      result({
        totalMatches: 2,
        files: [
          {
            path: 'C:\\game\\ERB\\事件.ERB',
            matches: [
              { line: 2, column: 5, preview: '二行目にABC', start: 4, end: 7 },
              { line: 9, column: 1, preview: 'ABC 开头', start: 0, end: 3 },
            ],
          },
        ],
      }),
    );
    const render = (): string =>
      renderToStaticMarkup(createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }));
    expect(render()).toContain('第 1 项 / 共 2 项');
    expect(stepSearchMatch(1)).not.toBeNull();
    expect(render()).toContain('第 1 项 / 共 2 项');
    expect(stepSearchMatch(1)).not.toBeNull();
    expect(render()).toContain('第 2 项 / 共 2 项');
  });

  it('错误态画在面板里（不抛穿渲染路径）', async () => {
    setSearchRunner(async () => {
      throw new Error('正则无效：unclosed group');
    });
    setQuery('a(');
    await runSearch(['C:\\game']);
    const html = renderToStaticMarkup(
      createElement(SearchPanel, { roots: ['C:\\game'], ...ANY_REVEAL }),
    );
    expect(html).toContain('search-error');
    expect(html).toContain('正则无效');
  });
});
