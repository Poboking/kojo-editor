import { describe, expect, it } from 'vitest';
import type { SearchMatch, SearchProgress } from '../src/bridge/search';
import {
  extensionSummaryText,
  groupSearchRows,
  locationGutterCh,
  searchProgressPercent,
  splitSearchPath,
} from '../src/ui/SearchPanel';
import { DEFAULT_EXTENSION_TEXT, type SearchRow } from '../src/ui/search-query';

/**
 * 搜索面板重排（用户反馈 5）的**纯逻辑**判据。
 *
 * 重排把"文件分组 / 折叠块 / 行号槽宽 / 进度条 / 折叠态摘要"从渲染里提成了纯函数：
 * 这几件决定"一屏画什么、怎么对齐、当前条件有没有被藏起来"，是面板可读性的最后
 * 一厘米，且都可以在 node 里钉住。渲染层的结构判据仍在 `search-panel-render.test.ts`
 * 与 `search-scope.test.ts`（服务端静态渲染）。
 */

const m = (line: number, column = 1, preview = 'ABC'): SearchMatch => ({
  line,
  column,
  preview,
  start: 0,
  end: 3,
});

const file = (path: string, count: number): SearchRow => ({ kind: 'file', path, count });
const match = (path: string, hit: SearchMatch): SearchRow => ({ kind: 'match', path, match: hit });

describe('groupSearchRows：扁平行 → 可折叠的文件块', () => {
  it('按文件分段、保持后端顺序、计数取文件头（不是本屏渲染行数）', () => {
    const rows: SearchRow[] = [
      file('C:\\game\\A.ERB', 3),
      match('C:\\game\\A.ERB', m(2, 5)),
      match('C:\\game\\A.ERB', m(9)),
      file('C:\\game\\B.ERB', 1),
      match('C:\\game\\B.ERB', m(4)),
    ];
    const groups = groupSearchRows(rows);
    expect(groups.map((g) => g.path)).toEqual(['C:\\game\\A.ERB', 'C:\\game\\B.ERB']);
    expect(groups.map((g) => g.count)).toEqual([3, 1]);
    expect(groups[0]!.matches.map((x) => x.line)).toEqual([2, 9]);
    expect(groups[1]!.matches.map((x) => x.line)).toEqual([4]);
  });

  it('截断只裁渲染行：文件头的计数仍是后端总数（读数不撒谎）', () => {
    const groups = groupSearchRows([file('C:\\game\\A.ERB', 50), match('C:\\game\\A.ERB', m(1))]);
    expect(groups[0]!.count).toBe(50);
    expect(groups[0]!.matches).toHaveLength(1);
  });

  it('缺文件头的命中行自成一组（不吞行），同路径连续两个文件头合并计数', () => {
    const groups = groupSearchRows([
      match('C:\\game\\A.ERB', m(1)),
      file('C:\\game\\B.ERB', 2),
      file('C:\\game\\B.ERB', 3),
      match('C:\\game\\B.ERB', m(7)),
    ]);
    expect(groups.map((g) => [g.path, g.count, g.matches.length])).toEqual([
      ['C:\\game\\A.ERB', 1, 1],
      ['C:\\game\\B.ERB', 5, 1],
    ]);
  });

  it('空输入 ⇒ 空分组（空态由调用方决定画不画列表）', () => {
    expect(groupSearchRows([])).toEqual([]);
  });
});

describe('splitSearchPath：文件头两段展示', () => {
  it('Windows 路径：basename + 紧邻目录（与 shortSearchPath 末两段同口径）', () => {
    expect(splitSearchPath('C:\\game\\ERB\\事件.ERB')).toEqual({ base: '事件.ERB', dir: 'ERB' });
  });

  it('POSIX 路径同样拆得开', () => {
    expect(splitSearchPath('/home/w/口上/日常.erb')).toEqual({ base: '日常.erb', dir: '口上' });
  });

  it('只有一段（无分隔符）⇒ 目录为空串，界面不画空段', () => {
    expect(splitSearchPath('事件.ERB')).toEqual({ base: '事件.ERB', dir: '' });
  });
});

describe('locationGutterCh：左列「行:列」槽宽', () => {
  it('空列表取下限 3（9:9 的宽度），不白占宽', () => {
    expect(locationGutterCh([])).toBe(3);
  });

  it('短行号不撑宽；出现三位行号时整列一次加宽', () => {
    const short = locationGutterCh([match('a', m(9, 9))]);
    const long = locationGutterCh([
      match('a', m(9, 9)),
      match('a', m(1200, 45)),
    ]);
    expect(short).toBe(3);
    expect(long).toBe(String('1200:45').length);
  });

  it('文件头不参与（只按命中行的读数定槽宽）', () => {
    expect(locationGutterCh([file('a', 99999)])).toBe(3);
  });
});

describe('searchProgressPercent：进度条读数', () => {
  const p = (filesScanned: number, totalFiles: number): SearchProgress => ({
    searchId: 1,
    filesScanned,
    totalFiles,
    matchCount: 0,
  });

  it('总量未知 ⇒ null（画不确定条，不假装 0%）', () => {
    expect(searchProgressPercent(null)).toBeNull();
    expect(searchProgressPercent(p(7, 0))).toBeNull();
  });

  it('按扫描比例取整，越界夹回 0–100', () => {
    expect(searchProgressPercent(p(0, 200))).toBe(0);
    expect(searchProgressPercent(p(1, 2))).toBe(50);
    expect(searchProgressPercent(p(200, 200))).toBe(100);
    expect(searchProgressPercent(p(500, 200))).toBe(100);
  });
});

describe('extensionSummaryText：「选项」折叠时的摘要', () => {
  it('默认扩展名（含换序 / 大小写 / 多余空白）⇒ null，不占位', () => {
    expect(extensionSummaryText(DEFAULT_EXTENSION_TEXT)).toBeNull();
    // 那份"手抄的默认清单"自 WS-10 起不在了：默认面由契约派生（`defaultSearchExtensions()`，
    // 漂移由 `search-query.test.ts` 那两枚闸守着）。这条判据本来只关心
    // **"顺序 / 大小写 / 空白不敏感"**，所以反推同一份默认面来喂它，而不是再抄第二份字面量
    // （抄第二份 = 每次派生变化都要回来改这条，改慢了就是一条假红）。
    const reshuffled = DEFAULT_EXTENSION_TEXT.split(',')
      .map((s) => s.trim())
      .reverse()
      .map((s, i) => (i % 2 === 0 ? s.toUpperCase() : ` ${s}`))
      .join(',  ');
    expect(reshuffled).not.toBe(DEFAULT_EXTENSION_TEXT); // 真的换了序、变了大小写、多了空白
    expect(extensionSummaryText(reshuffled)).toBeNull();
  });

  it('改过 ⇒ 原文本上屏（作者一眼看到自己设了什么）', () => {
    expect(extensionSummaryText('erb, md')).toBe('类型：erb, md');
  });

  it('清空 ⇒ 明说「不限」（这会影响结果，不许藏）', () => {
    expect(extensionSummaryText('')).toBe('类型：不限');
    expect(extensionSummaryText('   ')).toBe('类型：不限');
  });
});
