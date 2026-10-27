import { describe, expect, it } from 'vitest';
import type { SearchMatch, SearchResult } from '../src/bridge/search';
import {
  DEFAULT_EXTENSION_TEXT,
  DEFAULT_SEARCH_EXTENSIONS,
  formatExtensions,
  isValidSearchQuery,
  matchLocationLabel,
  parseExtensions,
  previewParts,
  searchMatchCounterText,
  searchNoticeText,
  searchProgressText,
  searchSummaryDetail,
  searchSummaryText,
  shortSearchPath,
} from '../src/ui/search-query';
import { flattenSearchResults } from '../src/ui/search-rows';

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
  it('被停止的结果不伪装成"搜完了"；摘要走紧凑档、完整句进悬停（视觉批十四）', () => {
    const r = result({ cancelled: true, totalMatches: 3, files: [], filesScanned: 9, elapsedMs: 1200 });
    expect(searchSummaryText(r)).toBe('已停止：3 条 · 0 文件 · 1.2s');
    // 扫描面只在详情句里出现：260px 一行放不下三段读数
    expect(searchSummaryDetail(r)).toBe('已停止：3 条结果 · 0 个文件 · 扫描 9 个文件 · 1.2s');
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

describe('search-query · 默认检索面 = 契约单源派生（WS-10 漂移闸）', () => {
  it('派生结果与 quickOpenSourceExtensions（Ctrl+P / 项目扫描同一来源）逐项一致', async () => {
    const { quickOpenSourceExtensions } = await import('../src/ui/commands');
    const { defaultSearchExtensions, SEARCH_EXTRA_EXTENSIONS } = await import('../src/ui/search-query');
    const ctrlP = quickOpenSourceExtensions().map((e) => e.toLowerCase().replace(/^\.+/, ''));
    expect(defaultSearchExtensions()).toEqual([...ctrlP, ...SEARCH_EXTRA_EXTENSIONS]);
    // 模块级快照与现算函数逐字同值（面板缺省文本、指纹判据都吃这一份）
    expect([...DEFAULT_SEARCH_EXTENSIONS]).toEqual(defaultSearchExtensions());
  });

  it('Ctrl+P 认的每一枚后缀都在搜索默认面里（"找得到却搜不到"的分叉不许回来）', async () => {
    const { quickOpenSourceExtensions } = await import('../src/ui/commands');
    const set = new Set<string>(DEFAULT_SEARCH_EXTENSIONS);
    for (const ext of quickOpenSourceExtensions()) {
      const bare = ext.toLowerCase().replace(/^\.+/, '');
      expect(set.has(bare), `Ctrl+P 认 ${ext}，搜索默认面就必须认`).toBe(true);
    }
  });

  it('老手写清单的三处漂移各自钉死：.erm / .kojo1 在场、未接线的 .erd 不在场', () => {
    const set = new Set<string>(DEFAULT_SEARCH_EXTENSIONS);
    expect(set.has('erm'), 'ERB 正文族漏了 .erm 就是"文件存在、搜索搜不到"').toBe(true);
    expect(set.has('kojo1'), 'v1 源清单（KOJO_V1_SOURCE_EXTENSIONS）必须随契约走').toBe(true);
    expect(set.has('erd'), '.erd 仍是引擎预留未接线（ERB_ENGINE_RESERVED），不许混进默认面').toBe(false);
  });

  it('契约清单里新增一枚 ⇒ 默认面自动跟上（派生而非手抄的自证）', async () => {
    const api = await import('@kojo/plugin-api');
    const { defaultSearchExtensions } = await import('../src/ui/search-query');
    const derived = new Set(defaultSearchExtensions());
    for (const ext of [...api.ERB_DIALECT_EXTENSIONS, ...api.KOJO_V1_SOURCE_EXTENSIONS]) {
      expect(derived.has(ext.toLowerCase().replace(/^\.+/, ''))).toBe(true);
    }
  });
});

describe('search-query · 排除模式解析（WS-10）', () => {
  it('分隔符与类型框同款；反斜杠归一成 /；保序（后写的规则赢 ⇒ 排序=改语义）', async () => {
    const { parseExcludePatterns } = await import('../src/ui/search-query');
    expect(parseExcludePatterns('**/backup/**, *.tmp')).toEqual(['**/backup/**', '*.tmp']);
    expect(parseExcludePatterns('backup\\**.erb；!backup\\keep.erb')).toEqual([
      'backup/**.erb',
      '!backup/keep.erb',
    ]);
    // 排序会改写 `!` 的先后 ⇒ 与 parseExtensions 刻意不同：**不排序**
    expect(parseExcludePatterns('b.erb a.erb')).toEqual(['b.erb', 'a.erb']);
  });

  it('空串 / 光杆 `!` / 重复条目一律丢（同一份输入恒产出同一个请求）', async () => {
    const { parseExcludePatterns } = await import('../src/ui/search-query');
    expect(parseExcludePatterns('  ')).toEqual([]);
    expect(parseExcludePatterns('!, ,!, **/x/**, **/x/**')).toEqual(['**/x/**']);
  });

  it('范围标签取末段目录名（尾部分隔符先剥；单段/盘符根原样）', async () => {
    const { folderScopeLabel } = await import('../src/ui/search-query');
    expect(folderScopeLabel('C:\\game\\src')).toBe('src');
    expect(folderScopeLabel('C:/game/backup/')).toBe('backup');
    expect(folderScopeLabel('single')).toBe('single');
    expect(folderScopeLabel('C:/')).toBe('C:');
  });

  it('结果说明报"被排除模式挡下"的条数；老载荷缺键按 0，不装读数', () => {
    const withExcluded = searchNoticeText(
      result({ skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0, excluded: 7 } }),
    );
    expect(withExcluded).toContain('7 个文件被排除模式挡下');
    expect(searchNoticeText(result())).toBeNull();
  });
});
