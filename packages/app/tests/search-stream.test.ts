import { describe, expect, it } from 'vitest';
import type { SearchFilesBatch, SearchFileResult, SearchMatch, SearchResult } from '../src/bridge/search';
import {
  acceptFilesBatch,
  DEFAULT_SEARCH_SORT,
  reconcileStreamFiles,
  SEARCH_SORT_OPTIONS,
  searchFileNameOf,
  sortSearchFiles,
  type SearchSortMode,
} from '../src/ui/search-stream';

/**
 * 流式检索纯逻辑判据（P2-11）。
 *
 * 钉三件事：①批次累积的**过期丢弃口径**（迟到批次不许覆盖新检索读数，与进度
 * 事件逐字一致）；②收口**以完成态为准**（对齐时两种做法逐字相同，对不齐时
 * 绝不许出现"事件说三条、最终态说两条"）；③排序对**在途流式结果**同样成立
 * （纯函数，不依赖完成态存在）。
 *
 * store / 面板层的行为（单飞、防抖、Enter 老路数）由既有
 * `search-store.test.ts` / `search-panel-render.test.ts` 钉，这里只测纯逻辑。
 */

const match = (line: number): SearchMatch => ({
  line,
  column: 1,
  preview: 'hit',
  start: 0,
  end: 3,
});

const file = (path: string, hits = 1): SearchFileResult => ({
  path,
  matches: Array.from({ length: hits }, (_, i) => match(i + 1)),
});

const batch = (
  searchId: number,
  files: SearchFileResult[],
  over: Partial<SearchFilesBatch> = {},
): SearchFilesBatch => ({
  searchId,
  files,
  done: false,
  truncated: false,
  cancelled: false,
  ...over,
});

const result = (files: SearchFileResult[], over: Partial<SearchResult> = {}): SearchResult => ({
  files,
  totalMatches: files.reduce((n, f) => n + f.matches.length, 0),
  truncated: false,
  cancelled: false,
  filesScanned: 10,
  skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
  elapsedMs: 100,
  ...over,
});

describe('acceptFilesBatch：在途累积与过期丢弃', () => {
  it('同 searchId 的批次按到达顺序追加（随到随进）', () => {
    let acc: readonly SearchFileResult[] = [];
    acc = acceptFilesBatch(acc, 1, batch(1, [file('C:\\game\\a.erb')]));
    acc = acceptFilesBatch(acc, 1, batch(1, [file('C:\\game\\b.erb', 3)]));
    expect(acc.map((f) => f.path)).toEqual(['C:\\game\\a.erb', 'C:\\game\\b.erb']);
    expect(acc[1]!.matches).toHaveLength(3);
  });

  it('迟到批次（旧 searchId）原样退回旧累积——旧检索的读数不许覆盖新检索', () => {
    const acc = [file('C:\\game\\new.erb')];
    const stale = batch(1, [file('C:\\game\\old.erb', 9)]);
    const out = acceptFilesBatch(acc, 2, stale);
    expect(out).toBe(acc); // 同一份引用：连数组都不新建
    expect(out.map((f) => f.path)).toEqual(['C:\\game\\new.erb']);
  });

  it('空批次不制造新数组（done 批只有残留文件时也没动静）', () => {
    const acc = [file('C:\\game\\a.erb')];
    expect(acceptFilesBatch(acc, 1, batch(1, []))).toBe(acc);
    expect(acceptFilesBatch(acc, 1, batch(1, [], { done: true }))).toBe(acc);
  });

  it('done 批与中途批同口径：只是"最后一批"，不特殊处理', () => {
    const acc = acceptFilesBatch([], 1, batch(1, [file('C:\\game\\a.erb')], { done: true }));
    expect(acc.map((f) => f.path)).toEqual(['C:\\game\\a.erb']);
  });
});

describe('reconcileStreamFiles：收口以完成态为准', () => {
  it('对齐时（后端契约：完成态 ⊇ 事件流）⇒ 就是完成态原样', () => {
    const accumulated = [file('C:\\game\\a.erb'), file('C:\\game\\b.erb')];
    const final = result([file('C:\\game\\a.erb'), file('C:\\game\\b.erb'), file('C:\\game\\c.erb', 2)]);
    expect(reconcileStreamFiles(final)).toBe(final.files);
    expect(reconcileStreamFiles(final).map((f) => f.path)).toEqual(
      accumulated.concat([file('C:\\game\\c.erb', 2)]).map((f) => f.path),
    );
  });

  it('对不齐时**不并入**累积里多出的文件——否则就是"事件说三条、最终态说两条"', () => {
    // 后端缺陷的形态：事件流送到 3 个文件，完成态只回报 2 个。
    // 收口必须以完成态为准：列表与摘要（由完成态出）同源，宁可少画，不可少说。
    const accumulated = [file('C:\\game\\a.erb'), file('C:\\game\\b.erb'), file('C:\\game\\ghost.erb')];
    const final = result([file('C:\\game\\a.erb'), file('C:\\game\\b.erb')]);
    const out = reconcileStreamFiles(final);
    expect(out.map((f) => f.path)).toEqual(['C:\\game\\a.erb', 'C:\\game\\b.erb']);
    expect(out.some((f) => f.path.endsWith('ghost.erb'))).toBe(false);
  });
});

describe('sortSearchFiles：三选一排序（对在途流式结果同样成立）', () => {
  const files = [
    file('C:\\game\\ERB\\zeta.erb', 5),
    file('C:\\game\\alpha.erb', 5),
    file('C:\\game\\ERB\\mid.erb', 1),
    file('C:\\game\\beta.erb', 9),
  ];

  it('默认档 = 路径：整路径字典序（与 Rust 侧完成态同口径）', () => {
    expect(DEFAULT_SEARCH_SORT).toBe('path');
    expect(sortSearchFiles(files, 'path').map((f) => f.path)).toEqual([
      'C:\\game\\ERB\\mid.erb',
      'C:\\game\\ERB\\zeta.erb',
      'C:\\game\\alpha.erb',
      'C:\\game\\beta.erb',
    ]);
  });

  it('路径档对完成态幂等（完成态本来就是这个序，重排不改顺序）', () => {
    const sorted = sortSearchFiles(files, 'path');
    expect(sortSearchFiles(sorted, 'path').map((f) => f.path)).toEqual(sorted.map((f) => f.path));
  });

  it('命中数档：降序，同数按路径升序（读数确定，不随批次到达顺序漂）', () => {
    expect(sortSearchFiles(files, 'matches').map((f) => f.path)).toEqual([
      'C:\\game\\beta.erb', // 9
      'C:\\game\\ERB\\zeta.erb', // 5，同数按路径
      'C:\\game\\alpha.erb', // 5
      'C:\\game\\ERB\\mid.erb', // 1
    ]);
  });

  it('文件名校：按末段，同名按整路径', () => {
    expect(sortSearchFiles(files, 'name').map((f) => f.path)).toEqual([
      'C:\\game\\alpha.erb',
      'C:\\game\\beta.erb',
      'C:\\game\\ERB\\mid.erb',
      'C:\\game\\ERB\\zeta.erb',
    ]);
  });

  it('在途流式结果（部分清单）同样排得动——纯函数，不依赖完成态', () => {
    const inflight = [file('C:\\game\\z.erb', 2), file('C:\\game\\a.erb', 7)];
    expect(sortSearchFiles(inflight, 'matches').map((f) => f.path)).toEqual([
      'C:\\game\\a.erb',
      'C:\\game\\z.erb',
    ]);
    expect(sortSearchFiles(inflight, 'path').map((f) => f.path)).toEqual([
      'C:\\game\\a.erb',
      'C:\\game\\z.erb',
    ]);
  });

  it('纯度：输入数组不被修改（面板 memo 依赖引用稳定性）', () => {
    const input = [file('C:\\game\\b.erb'), file('C:\\game\\a.erb')];
    const snapshotPaths = input.map((f) => f.path);
    sortSearchFiles(input, 'path');
    sortSearchFiles(input, 'matches');
    sortSearchFiles(input, 'name');
    expect(input.map((f) => f.path)).toEqual(snapshotPaths);
  });

  it('空清单 ⇒ 空清单（不炸）', () => {
    for (const mode of ['path', 'matches', 'name'] as SearchSortMode[]) {
      expect(sortSearchFiles([], mode)).toEqual([]);
    }
  });
});

describe('searchFileNameOf 与档位选项', () => {
  it('两种分隔符都认；无分隔符 ⇒ 原串', () => {
    expect(searchFileNameOf('C:\\game\\ERB\\事件.ERB')).toBe('事件.ERB');
    expect(searchFileNameOf('/home/w/日常.erb')).toBe('日常.erb');
    expect(searchFileNameOf('事件.ERB')).toBe('事件.ERB');
  });

  it('三个档位、默认路径在前（下拉顺序即选项顺序）', () => {
    expect(SEARCH_SORT_OPTIONS.map((o) => o.mode)).toEqual(['path', 'matches', 'name']);
    expect(SEARCH_SORT_OPTIONS.map((o) => o.label)).toEqual(['按路径', '按命中数', '按文件名']);
  });
});
