import { describe, expect, it } from 'vitest';
import type { SearchMatch, SearchResult } from '../src/bridge/search';
import {
  DEFAULT_EXTENSION_TEXT,
  DEFAULT_SEARCH_EXTENSIONS,
  flattenSearchResults,
  formatExtensions,
  isValidSearchQuery,
  matchLocationLabel,
  parseExtensions,
  previewParts,
  searchMatchCounterText,
  searchNoticeText,
  searchProgressText,
  searchSummaryText,
  shortSearchPath,
} from '../src/ui/search-query';

/**
 * 检索面板纯逻辑单测（2026-10-15 检索批）。
 *
 * 钉的是四件事：①过滤框文本 ↔ 扩展名列表（脏输入必须收敛成**同一个**请求，
 * 否则"同一份条件发两次请求结果不同"这种无从复现的差异就会漏出去）；
 * ②命中行预览的三段切分（越界要夹回，坏载荷不许把界面炸掉）；
 * ③结果扁平化 + 渲染上限；④摘要文案——"被停止/被截断"必须说出来。
 */

const match = (over: Partial<SearchMatch> = {}): SearchMatch => ({
  line: 1,
  column: 1,
  preview: 'abc',
  start: 0,
  end: 0,
  ...over,
});

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

describe('search-query · 扩展名过滤框', () => {
  it('默认词表与初始文本同源', () => {
    expect(parseExtensions(DEFAULT_EXTENSION_TEXT)).toEqual([...DEFAULT_SEARCH_EXTENSIONS].sort());
  });

  it('半角/全角逗号、分号、空白都能当分隔符', () => {
    expect(parseExtensions('erb, erh；erd，kojo txt')).toEqual(['erb', 'erd', 'erh', 'kojo', 'txt']);
  });

  it('去前导点、转小写、去重、排序（脏输入收敛成同一个列表）', () => {
    expect(parseExtensions('  .ERB , erb ,.Erb,  ')).toEqual(['erb']);
    expect(parseExtensions('.CSV and .csv')).toEqual(['and', 'csv']);
  });

  it('空文本 = 不限扩展名（空数组，而不是"全都不匹配"）', () => {
    expect(parseExtensions('   ')).toEqual([]);
    expect(parseExtensions('')).toEqual([]);
  });

  it('列表回填成文本后往返一致', () => {
    const list = parseExtensions('erb, csv');
    expect(parseExtensions(formatExtensions(list))).toEqual(list);
  });
});

describe('search-query · 查询与路径', () => {
  it('空白查询不发请求', () => {
    expect(isValidSearchQuery('')).toBe(false);
    expect(isValidSearchQuery('   ')).toBe(false);
    expect(isValidSearchQuery(' a ')).toBe(true);
  });

  it('短路径取末两段（与问题面板同口径）', () => {
    expect(shortSearchPath('C:\\game\\ERB\\事件.ERB')).toBe('ERB/事件.ERB');
    expect(shortSearchPath('a.erb')).toBe('a.erb');
  });
});

describe('search-query · 命中行预览切分', () => {
  it('切出命中前后三段', () => {
    const m = match({ preview: '二行目にABC', start: 4, end: 7 });
    expect(previewParts(m)).toEqual({ head: '二行目に', hit: 'ABC', tail: '' });
  });

  it('偏移越界夹回串内（坏载荷不许炸界面）', () => {
    const m = match({ preview: 'abc', start: 10, end: 99 });
    expect(previewParts(m)).toEqual({ head: 'abc', hit: '', tail: '' });
    const neg = match({ preview: 'abc', start: -5, end: -1 });
    expect(previewParts(neg)).toEqual({ head: '', hit: '', tail: 'abc' });
  });

  it('位置标签是 行:列', () => {
    expect(matchLocationLabel(match({ line: 12, column: 5 }))).toBe('12:5');
  });
});

describe('search-query · 结果扁平化', () => {
  const files = [
    { path: 'a.erb', matches: [match({ line: 1 }), match({ line: 7 })] },
    { path: 'b.erb', matches: [match({ line: 3 })] },
  ];

  it('文件头 + 各命中，顺序即后端给的顺序', () => {
    const { rows, hidden } = flattenSearchResults(files, 100);
    expect(rows.map((r) => (r.kind === 'file' ? `f:${r.path}` : `m:${r.path}:${r.match.line}`))).toEqual([
      'f:a.erb',
      'm:a.erb:1',
      'm:a.erb:7',
      'f:b.erb',
      'm:b.erb:3',
    ]);
    expect(hidden).toBe(0);
  });

  it('文件头也占一行：被裁掉的条数要如实报出来', () => {
    const { rows, hidden } = flattenSearchResults(files, 3);
    expect(rows).toHaveLength(3);
    expect(hidden).toBe(2);
  });
});

describe('search-query · 第 X 项 / 共 Y 项', () => {
  it('没有命中就不编读数', () => {
    expect(searchMatchCounterText(-1, 0)).toBeNull();
    expect(searchMatchCounterText(0, 0)).toBeNull();
    expect(searchMatchCounterText(0, -3)).toBeNull();
  });

  it('未导航时把第 1 项当作下一站；0 基游标转 1 基文案', () => {
    expect(searchMatchCounterText(-1, 3)).toBe('第 1 项 / 共 3 项');
    expect(searchMatchCounterText(0, 3)).toBe('第 1 项 / 共 3 项');
    expect(searchMatchCounterText(2, 3)).toBe('第 3 项 / 共 3 项');
  });

  it('游标越界夹回总数（坏载荷不许把读数撑出范围）', () => {
    expect(searchMatchCounterText(99, 3)).toBe('第 3 项 / 共 3 项');
  });
});

describe('search-query · 摘要与边角说明', () => {
  it('被停止的结果不伪装成"搜完了"', () => {
    const stopped = searchSummaryText(result({ cancelled: true, totalMatches: 3, filesScanned: 9, elapsedMs: 1200 }));
    expect(stopped.startsWith('已停止：')).toBe(true);
    expect(stopped).toContain('3 条结果');
    expect(stopped).toContain('1.2s');
  });

  it('截断 / 跳过逐项入说明；没有则 null', () => {
    expect(searchNoticeText(result())).toBeNull();
    const notes = searchNoticeText(
      result({
        truncated: true,
        skipped: { binary: 2, tooLarge: 1, unreadable: 3, filtered: 4 },
      }),
    );
    expect(notes).toContain('结果已达上限');
    expect(notes).toContain('2 个二进制文件');
    expect(notes).toContain('1 个超大文件');
    expect(notes).toContain('3 个文件读取失败');
    expect(notes).toContain('4 个文件被类型过滤挡下');
  });

  it('进度文案：知道总量就报比率，不知道就只报已扫描数', () => {
    expect(searchProgressText({ searchId: 1, filesScanned: 10, totalFiles: 100, matchCount: 2 })).toContain('10/100');
    expect(searchProgressText({ searchId: 1, filesScanned: 10, totalFiles: 0, matchCount: 2 })).toContain('已扫描 10');
  });
});
