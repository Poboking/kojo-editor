import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchScopeContribution, SearchScopeOption } from '@kojo/plugin-api';
import type { SearchRequest, SearchResult } from '../src/bridge/search';
import { SearchPanel } from '../src/ui/SearchPanel';
import {
  clearSearchResult,
  resetSearch,
  runSearch,
  setSearchRunner,
  setSearchScope,
  setQuery,
  snapshot,
  type SearchRunner,
} from '../src/ui/search-store';
import {
  collectSearchScopes,
  describeAppliedScope,
  findSearchScope,
  narrowRoots,
  scopeRootsTitle,
  scopeEmptyText,
  scopeStaleText,
  scopeStatusText,
  scopeUnreachableText,
  type SearchScopeItem,
} from '../src/ui/search-scope';

/**
 * 检索范围（C3 领域限定检索批）——宿主侧的纯逻辑 + 状态机 + 上屏判据。
 *
 * 分层纪律在这里是可测的：**宿主不判归属**。`narrowRoots` 只做"包含关系"这一种
 * 通用几何，收到什么目录就用什么目录；"某个范围对应哪些目录"由 `search.scope`
 * 的提供方给出（判据住适配器，见 `packages/plugins/eratw-adapter/tests/search-scope.test.ts`）。
 *
 * 另外三条硬约束都在这份测试里钉死：①不带范围时行为与改动前逐字一致（默认关）；
 * ②选了范围必须说清"只扫了哪里、范围外没扫"（铁律 4）；③范围里没文件不许糊成"无结果"。
 */

const item = (key: string, label: string, roots: readonly string[]): SearchScopeItem => ({
  key,
  label,
  detail: '',
  roots,
});

function contribution(
  id: string,
  options: readonly SearchScopeOption[],
  opts: { pluginId?: string; throws?: boolean } = {},
): SearchScopeContribution {
  return {
    id,
    ...(opts.pluginId ? { pluginId: opts.pluginId } : {}),
    provide: () => {
      if (opts.throws) throw new Error('提供方炸了');
      return options.map((o) => ({ ...o, roots: [...o.roots] }));
    },
  } as SearchScopeContribution;
}

const option = (id: string, label: string, roots: readonly string[]): SearchScopeOption => ({
  id,
  label,
  roots,
});

/* ------------------------------ 候选摊平 ------------------------------ */

describe('collectSearchScopes', () => {
  it('没有提供方 → 空目录（宿主据此整行不画 = 与今天一致）', () => {
    expect(collectSearchScopes([], null)).toEqual({ items: [], notices: [] });
  });

  it('key 叠 pluginId 命名空间：两个提供方各自的 a:1 不串线', () => {
    const a = contribution('ca', [option('a:1', '甲一', ['/g/1'])], { pluginId: 'pA' });
    const b = contribution('cb', [option('a:1', '乙一', ['/g/2'])], { pluginId: 'pB' });
    const catalog = collectSearchScopes([a, b], null);
    expect(catalog.notices).toEqual([]);
    expect(catalog.items.map((i) => i.key)).toEqual(['pA:a:1', 'pB:a:1']);
    expect(catalog.items.map((i) => i.label)).toEqual(['甲一', '乙一']);
  });

  it('提供方抛错 → 出声并跳过它，其余提供方的候选照旧', () => {
    const boom = contribution('bad', [], { pluginId: 'pBad', throws: true });
    const good = contribution('ok', [option('k', '可用', ['/g/1'])], { pluginId: 'pOk' });
    const catalog = collectSearchScopes([boom, good], null);
    expect(catalog.items.map((i) => i.key)).toEqual(['pOk:k']);
    expect(catalog.notices).toHaveLength(1);
    expect(catalog.notices[0]).toContain('提供方炸了');
  });

  it('非法候选（空 id / 重复 id / 零目录）逐个丢掉并说明，不静默修正', () => {
    const c = contribution(
      'c',
      [
        option('', '空编号', ['/g/1']),
        option('dup', '第一次', ['/g/2']),
        option('dup', '第二次', ['/g/3']),
        option('none', '零目录', []),
        option('good', '正常', ['/g/4']),
      ],
      { pluginId: 'p' },
    );
    const catalog = collectSearchScopes([c], null);
    // 重复 id：先到先得，后到的丢弃并出声（不静默覆盖，也不改名硬留）
    expect(catalog.items.map((i) => i.key)).toEqual(['p:dup', 'p:good']);
    expect(catalog.notices).toHaveLength(3);
  });

  it('缺省 detail 归一成空串（渲染层不必防 undefined）', () => {
    const catalog = collectSearchScopes(
      [contribution('c', [option('k', '标签', ['/g/1'])], { pluginId: 'p' })],
      null,
    );
    expect(catalog.items[0]!.detail).toBe('');
  });
});

/* ------------------------------ 取候选 ------------------------------ */

describe('findSearchScope', () => {
  const items = [item('p:a:1', '甲一', ['/g/1'])];

  it('空 key = 不限范围（不是"第一个候选"）', () => {
    expect(findSearchScope(items, '')).toBeNull();
  });

  it('陈旧 key（换过项目）= 不限范围，绝不猜', () => {
    expect(findSearchScope(items, 'p:gone')).toBeNull();
  });
});

/* ------------------------------ 收窄检索根 ------------------------------ */

describe('narrowRoots', () => {
  it('无候选 ⇒ 检索根逐字不变（默认关：老路径零改动）', () => {
    const roots = ['C:\\game', 'D:\\作品'];
    const out = narrowRoots(roots, null);
    expect(out.roots).toEqual(roots);
    expect(out.unreachable).toEqual([]);
  });

  it('范围嵌在根内 ⇒ 换成该目录（扫得更少，不是扫完再挑）', () => {
    const out = narrowRoots(['C:\\game'], item('k', '甲', ['C:\\game\\ERB\\x']));
    expect(out.roots).toEqual(['C:\\game\\ERB\\x']);
    expect(out.unreachable).toEqual([]);
  });

  it('范围盖住整个根 ⇒ 保留根本身（不切两半，同一份文件不给两种候选写法）', () => {
    const out = narrowRoots(['C:\\game\\ERB\\x'], item('k', '甲', ['C:\\game']));
    expect(out.roots).toEqual(['C:\\game\\ERB\\x']);
  });

  it('范围与现有根都不相干 ⇒ 记为不可达，**不**塞进请求（选择器不是第二条任意路径通道）', () => {
    const out = narrowRoots(['C:\\game'], item('k', '甲', ['E:\\别处']));
    expect(out.roots).toEqual([]);
    expect(out.unreachable).toEqual(['E:\\别处']);
  });

  it('多目录范围按 pathKey 去重（Windows 大小写两种写法算同一个）', () => {
    const out = narrowRoots(['C:\\game'], item('k', '甲', ['C:\\game\\a', 'c:\\GAME\\a']));
    expect(out.roots).toEqual(['C:\\game\\a']);
  });

  it('一条都落不进现有根时不可达全量可见（不是空范围静默）', () => {
    const out = narrowRoots([], item('k', '甲', ['C:\\game\\a', 'C:\\game\\b']));
    expect(out.roots).toEqual([]);
    expect(out.unreachable).toEqual(['C:\\game\\a', 'C:\\game\\b']);
  });
});

/* ------------------------------ 文案（人话，不静默） ------------------------------ */

describe('范围读数文案', () => {
  const applied = describeAppliedScope(item('k', '#1 灵梦', ['/g/1']), {
    roots: ['/g/1'],
    unreachable: ['/g/2'],
  })!;

  it('限定后要说"范围外的没扫"（否则 0 条会被读成整库没有）', () => {
    expect(scopeStatusText(applied)).toBe(
      '只看「#1 灵梦」：本次只检索 1 处，范围外的文件没有搜 · 另有 1 处不在当前项目里，也没扫',
    );
  });

  it('范围内零文件 ≠ 无结果', () => {
    expect(scopeEmptyText(applied)).toContain('没有进入检索的文件');
    expect(scopeEmptyText(applied)).toContain('不是没有匹配');
  });

  it('范围完全落不进项目时说的是范围，不是"请先打开项目"', () => {
    expect(scopeUnreachableText(applied)).toContain('#1 灵梦');
    expect(scopeUnreachableText(applied)).toContain('不在当前项目');
  });

  it('换了下拉没重新搜：说"重新搜索才生效"；退回不限时说清旧结果属于哪个范围', () => {
    expect(scopeStaleText('k', applied)).toBeNull();
    expect(scopeStaleText('other', applied)).toBe('范围已改动，重新搜索才生效');
    expect(scopeStaleText('', applied)).toContain('上面这份结果只来自「#1 灵梦」');
    expect(scopeStaleText('k', null)).toBeNull();
  });

  it('悬浮提示把实际目录原样转述（宿主不理解它们）', () => {
    expect(scopeRootsTitle(applied)).toContain('/g/1');
  });
});

/* ------------------------------ 状态机 ------------------------------ */

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

describe('search-store 的范围腿', () => {
  let last: SearchRequest | null = null;
  const runner: SearchRunner = async (req) => {
    last = req;
    return result({ filesScanned: req.roots.length, totalMatches: 1 });
  };

  beforeEach(() => {
    last = null;
    resetSearch();
    setSearchRunner(runner);
    setQuery('口上');
  });
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('不带范围：请求体与今天逐字一致，appliedScope 留空', async () => {
    await runSearch(['C:\\game']);
    expect(last!.roots).toEqual(['C:\\game']);
    expect(snapshot().appliedScope).toBeNull();
  });

  it('带范围：发出去的是收窄后的根，结果侧记下"这一轮用的是哪个范围"', async () => {
    const scope = item('p:a:1', '#1 灵梦', ['C:\\game\\001']);
    const narrowing = narrowRoots(['C:\\game', 'D:\\作品'], scope);
    await runSearch(narrowing.roots, describeAppliedScope(scope, narrowing));
    expect(last!.roots).toEqual(['C:\\game\\001']);
    expect(snapshot().appliedScope?.label).toBe('#1 灵梦');
    expect(snapshot().appliedScope?.roots).toEqual(['C:\\game\\001']);
  });

  it('收窄后一个根都不剩 ⇒ 不发请求，报错说的是范围（不是"请先打开项目"）', async () => {
    const before = last;
    const applied = describeAppliedScope(
      item('p:a:1', '#1 灵梦', ['E:\\别处']),
      narrowRoots(['C:\\game'], item('p:a:1', '#1 灵梦', ['E:\\别处'])),
    );
    await runSearch([], applied);
    expect(last).toBe(before);
    expect(snapshot().phase).toBe('error');
    expect(snapshot().error).toContain('#1 灵梦');
  });

  it('切换范围不清结果、也不改"结果所属的范围"（下次检索才生效）', async () => {
    const scope = item('p:a:1', '#1 灵梦', ['C:\\game\\001']);
    await runSearch(narrowRoots(['C:\\game'], scope).roots, describeAppliedScope(scope, narrowRoots(['C:\\game'], scope)));
    setSearchScope('p:a:2');
    expect(snapshot().result).not.toBeNull();
    expect(snapshot().appliedScope?.key).toBe('p:a:1');
    clearSearchResult();
    expect(snapshot().appliedScope).toBeNull();
  });

  it('检索抛错 ⇒ 不留一个"结果所属范围"的空壳', async () => {
    setSearchRunner(async () => {
      throw new Error('原生检索失败');
    });
    const scope = item('p:a:1', '#1 灵梦', ['C:\\game\\001']);
    await runSearch(narrowRoots(['C:\\game'], scope).roots, describeAppliedScope(scope, narrowRoots(['C:\\game'], scope)));
    expect(snapshot().phase).toBe('error');
    expect(snapshot().appliedScope).toBeNull();
  });
});

/* ------------------------------ 上屏 ------------------------------ */

const ANY_REVEAL = { onReveal: () => {} };

function panel(over: Partial<Parameters<typeof SearchPanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SearchPanel, { roots: ['C:\\game'], ...over, onReveal: ANY_REVEAL.onReveal }),
  );
}

describe('SearchPanel 的范围行与读数', () => {
  beforeEach(() => {
    resetSearch();
    setQuery('口上');
  });
  afterEach(() => {
    setSearchRunner(null);
    resetSearch();
  });

  it('没有候选 ⇒ 整行不画（面板与改动前同形）', () => {
    const html = panel();
    expect(html).not.toContain('search-scope');
    expect(html).not.toContain('只看');
  });

  it('有候选 ⇒ 默认「全部目录」，选项文本原样转述提供方标签', () => {
    const html = panel({
      scopes: [item('p:a:1', '#1 灵梦', ['C:\\game\\001']), item('p:a:2', '#2 魔理沙', ['C:\\game\\011'])],
    });
    expect(html).toContain('全部目录');
    expect(html).toContain('#1 灵梦');
    expect(html).toContain('#2 魔理沙');
    // 缺省选中项 = 不限（新功能默认关，画面上也看得出来）
    expect(html).toContain('<option value="" selected');
  });

  it('选定范围后搜出来的那一份，读数要说清只扫了哪个范围', async () => {
    setSearchRunner(async () => result({ totalMatches: 3, filesScanned: 12, elapsedMs: 90 }));
    const scopes = [item('p:a:1', '#1 灵梦', ['C:\\game\\001'])];
    setSearchScope('p:a:1');
    await runSearch(narrowRoots(['C:\\game'], scopes[0]!).roots, describeAppliedScope(scopes[0]!, narrowRoots(['C:\\game'], scopes[0]!)));
    const html = panel({ scopes });
    expect(html).toContain('只看「#1 灵梦」');
    expect(html).toContain('范围外的文件没有搜');
  });

  it('范围内零文件时说的是"没文件"，不是"无结果"', async () => {
    setSearchRunner(async () => result({ filesScanned: 0, elapsedMs: 5 }));
    const scopes = [item('p:a:1', '#1 灵梦', ['C:\\game\\001'])];
    setSearchScope('p:a:1');
    await runSearch(scopes[0]!.roots, describeAppliedScope(scopes[0]!, narrowRoots(['C:\\game'], scopes[0]!)));
    const html = panel({ scopes });
    expect(html).toContain('没有进入检索的文件');
    expect(html).toContain('不是没有匹配');
  });

  it('换了下拉但没重搜：旧结果的读数不许冒充新范围', async () => {
    setSearchRunner(async () => result({ totalMatches: 1, filesScanned: 4 }));
    const scopes = [item('p:a:1', '#1 灵梦', ['C:\\game\\001']), item('p:a:2', '#2 魔理沙', ['C:\\game\\011'])];
    setSearchScope('p:a:1');
    const narrowing = narrowRoots(['C:\\game'], scopes[0]!);
    await runSearch(narrowing.roots, describeAppliedScope(scopes[0]!, narrowing));
    setSearchScope('p:a:2');
    const html = panel({ scopes });
    expect(html).toContain('重新搜索才生效');
    expect(html).toContain('只看「#1 灵梦」');
    expect(html).not.toContain('只看「#2 魔理沙」：');
  });

  it('提供方出的故障说明要看得见（不静默少画候选）', () => {
    const html = panel({ scopes: [item('p:a:1', '#1 灵梦', ['C:\\game\\001'])], scopeNotices: ['范围提供方「p」没能给出候选'] });
    expect(html).toContain('没能给出候选');
  });

  it('陈旧 key 归一成「全部目录」，不会画出一个空选项', () => {
    setSearchScope('p:gone');
    const html = panel({ scopes: [item('p:a:1', '#1 灵梦', ['C:\\game\\001'])] });
    expect(html).toContain('<option value="" selected');
    expect(html).not.toContain('value="p:gone"');
    expect(snapshot().scopeKey).toBe('p:gone');
  });
});

/** 兜住"这条测试自己有没有跑起来"（`vi` 只在需要假计时器时用得上） */
describe('范围腿的自检', () => {
  it('收窄是纯函数：同一份输入恒产出同一个结果', () => {
    const spy = vi.fn(() => narrowRoots(['C:\\game'], item('k', '甲', ['C:\\game\\a'])));
    expect(spy()).toEqual(spy());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/* ------------------- 补：边界分支（每条都是"坏在明处"的一种） ------------------- */

describe('collectSearchScopes 的缺省归属与陈旧项', () => {
  it('提供方没带 pluginId（内核未注入 / 单测直调）⇒ 用自己的 id 当命名空间，key 不塌成空串', () => {
    const catalog = collectSearchScopes([contribution('prov-x', [option('k', '标签', ['/g/1'])])], null);
    expect(catalog.items.map((i) => i.key)).toEqual(['prov-x:k']);
    expect(catalog.notices).toEqual([]);
  });

  it('两个提供方同名 id、都缺省 pluginId ⇒ 靠各自的 id 区分', () => {
    const catalog = collectSearchScopes(
      [
        contribution('prov-a', [option('same', '甲', ['/g/1'])]),
        contribution('prov-b', [option('same', '乙', ['/g/2'])]),
      ],
      null,
    );
    expect(catalog.items.map((i) => i.key)).toEqual(['prov-a:same', 'prov-b:same']);
  });

  it('提供方给出零候选 ⇒ 空目录、不出声（"这个概念这里没有"不是故障）', () => {
    const catalog = collectSearchScopes([contribution('empty', [], { pluginId: 'p' })], null);
    expect(catalog).toEqual({ items: [], notices: [] });
  });
});

describe('范围内零文件的两种成因要分得开', () => {
  const applied = describeAppliedScope(item('k', '#1 灵梦', ['/g/1']), { roots: ['/g/1'], unreachable: [] })!;

  it('目录里真没文件：说的是"这一处本来就没文件"', () => {
    expect(scopeEmptyText(applied)).toContain('这一处本来就没文件');
  });

  it('有文件但被扩展名挡掉：不许再说"没文件"，要给出条数和出口', () => {
    const text = scopeEmptyText(applied, 42);
    expect(text).toContain('42 个文件因扩展名不符被跳过');
    expect(text).not.toContain('本来就没文件');
  });

  it('零根快照的悬浮提示说的是"没有可用位置"，不是一句空串', () => {
    const none = describeAppliedScope(item('k', '#1 灵梦', ['/g/1']), { roots: [], unreachable: ['/g/1'] })!;
    expect(scopeRootsTitle(none)).toBe('本次检索没有可用位置');
    expect(scopeStatusText(none)).toContain('本次只检索 0 处');
  });

  it('不限范围时不产出任何"结果所属范围"（默认关在数据形状上也成立）', () => {
    expect(describeAppliedScope(null, { roots: ['/g/1'], unreachable: [] })).toBeNull();
  });

  it('面板上零文件 + 有跳过计数：两句话同时在屏（成因可区分）', async () => {
    resetSearch();
    setQuery('口上');
    setSearchRunner(async () =>
      result({
        filesScanned: 0,
        skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 7 },
        elapsedMs: 3,
      }),
    );
    const scopes = [item('p:a:1', '#1 灵梦', ['C:\\game\\001'])];
    setSearchScope('p:a:1');
    const narrowing = narrowRoots(['C:\\game'], scopes[0]!);
    await runSearch(narrowing.roots, describeAppliedScope(scopes[0]!, narrowing));
    const html = panel({ scopes });
    expect(html).toContain('7 个文件因扩展名不符被跳过');
  });
});
