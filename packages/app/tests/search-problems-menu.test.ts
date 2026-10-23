// @vitest-environment happy-dom
/**
 * 搜索结果 + 问题面板的右键菜单判据（1023 覆盖面批 · WP3.1 / WP3.2）。
 *
 * 四组口径：
 * 1. **项集合随能力变**：`canReplace` / `canCopy` / `canReveal` / `canQuickFix` / 有无诊断码
 *    ——缺通道的项整项不显示（铁律 4：能力不存在就别摆入口）；
 * 2. **禁用必须说话**：留下的入口在条件不满足时 `disabled` + 人话原因（替换条件、复制全部
 *    无条目、没有过滤条件）；
 * 3. **文案全中文**：所有 label 含 CJK（宿主守卫的同一把尺子）；
 * 4. **接线到位**：面能按 DOM 上的身份属性认出「点的是哪一行」，选中 id 打到对应动作；
 *    输入框让给全局输入框面，空白处让给兜底菜单。
 */
import { describe, expect, it, vi } from 'vitest';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import {
  REPLACE_DISABLED_REASON,
  SEARCH_FILE_MENU_IDS,
  SEARCH_MATCH_MENU_IDS,
  buildSearchFileMenu,
  buildSearchMatchMenu,
  runSearchFileMenuAction,
  runSearchMatchMenuAction,
  setSearchMenuContext,
  type SearchMenuCapabilities,
  type SearchMenuHandlers,
} from '../src/ui/search-menu';
import {
  CLEAR_FILTER_DISABLED_REASON,
  COPY_ALL_DISABLED_REASON,
  PROBLEM_MENU_IDS,
  buildProblemRowMenu,
  buildProblemsPanelMenu,
  runProblemRowMenuAction,
  runProblemsPanelMenuAction,
  setProblemsMenuContext,
  type ProblemMenuHandlers,
} from '../src/ui/problem-menu';
import type { EditorProblem } from '../src/ui/problem-store';
import type { SearchMatch } from '../src/bridge/search';

const ALL_CAPS: SearchMenuCapabilities = { canReplace: true, canReveal: true, canCopy: true };

const idsOf = (items: readonly ContextMenuItem[]): string[] => items.map((i) => i.id);
const byId = (items: readonly ContextMenuItem[], id: string): ContextMenuItem => {
  const found = items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`菜单里没有 ${id}`);
  return found;
};

/** 所有出现过的 label 都要含 CJK（含最终派生的、带码的标签） */
function expectAllChinese(items: readonly ContextMenuItem[]): void {
  for (const item of items) {
    expect(isChineseMenuLabel(item.label), `${item.id} → ${item.label}`).toBe(true);
    if (item.children !== undefined) expectAllChinese(item.children);
  }
}

/** 禁用项必须给原因（渲染侧写进 title / aria-description） */
function expectDisabledItemsSpeak(items: readonly ContextMenuItem[]): void {
  for (const item of items) {
    if (item.disabled === true) {
      expect(item.disabledReason, `${item.id} 灰着不说话`).toBeTruthy();
    }
  }
}

const match = (line: number, column: number, preview = '口上测试行'): SearchMatch => ({
  line,
  column,
  preview,
  start: 0,
  end: 2,
});

const problem = (over: Partial<EditorProblem> = {}): EditorProblem => ({
  path: 'C:/game/erb/a.erb',
  line: 12,
  severity: 'error',
  message: '缺 else 分支',
  code: 'ERB1001',
  ...over,
});

/* ══════════════════════════ 搜索 · 文件组菜单 ══════════════════════════ */

describe('搜索结果 · 文件组菜单', () => {
  it('通道齐全：打开 | 复制路径 | 在资源管理器中显示', () => {
    expect(idsOf(buildSearchFileMenu(ALL_CAPS))).toEqual([
      SEARCH_FILE_MENU_IDS.open,
      SEARCH_FILE_MENU_IDS.copyPath,
      SEARCH_FILE_MENU_IDS.reveal,
    ]);
  });

  it('剪贴板缺席 ⇒ 复制路径整项不显示；桌面通道缺席 ⇒ 资源管理器项整项不显示', () => {
    const noCopy = buildSearchFileMenu({ ...ALL_CAPS, canCopy: false });
    expect(idsOf(noCopy)).not.toContain(SEARCH_FILE_MENU_IDS.copyPath);
    const noReveal = buildSearchFileMenu({ ...ALL_CAPS, canReveal: false });
    expect(idsOf(noReveal)).not.toContain(SEARCH_FILE_MENU_IDS.reveal);
    const bare = buildSearchFileMenu({ canReplace: false, canReveal: false, canCopy: false });
    expect(idsOf(bare)).toEqual([SEARCH_FILE_MENU_IDS.open]);
  });

  it('文案全中文', () => {
    expectAllChinese(buildSearchFileMenu(ALL_CAPS));
  });
});

/* ══════════════════════════ 搜索 · 命中行菜单 ══════════════════════════ */

describe('搜索结果 · 命中行菜单', () => {
  it('通道齐全：打开 | 复制命中行 / 复制路径 | 显示 | 替换此匹配', () => {
    expect(idsOf(buildSearchMatchMenu(ALL_CAPS))).toEqual([
      SEARCH_MATCH_MENU_IDS.open,
      SEARCH_MATCH_MENU_IDS.copyLine,
      SEARCH_MATCH_MENU_IDS.copyPath,
      SEARCH_MATCH_MENU_IDS.reveal,
      SEARCH_MATCH_MENU_IDS.replace,
    ]);
  });

  it('替换条件不满足 ⇒ 替换项保留但禁用，并说原因（入口值得留着）', () => {
    const items = buildSearchMatchMenu({ ...ALL_CAPS, canReplace: false });
    const replace = byId(items, SEARCH_MATCH_MENU_IDS.replace);
    expect(replace.disabled).toBe(true);
    expect(replace.disabledReason).toBe(REPLACE_DISABLED_REASON);
    expect(expectDisabledItemsSpeak(items)).toBeUndefined();
  });

  it('剪贴板 / 桌面通道缺席 ⇒ 对应项整项不显示', () => {
    const items = buildSearchMatchMenu({ canReplace: true, canReveal: false, canCopy: false });
    expect(idsOf(items)).toEqual([SEARCH_MATCH_MENU_IDS.open, SEARCH_MATCH_MENU_IDS.replace]);
  });

  it('文案全中文（含替换项）', () => {
    expectAllChinese(buildSearchMatchMenu(ALL_CAPS));
    expectAllChinese(buildSearchMatchMenu({ ...ALL_CAPS, canReplace: false }));
  });
});

/* ══════════════════════════ 搜索 · 动作分发 ══════════════════════════ */

describe('搜索结果 · 动作分发', () => {
  const handlers = (): SearchMenuHandlers & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      openMatch: (path, m) => calls.push(`open:${path}:${m.line}`),
      copyText: (text) => calls.push(`copy:${text}`),
      revealPath: (path) => calls.push(`reveal:${path}`),
      replaceMatch: (path, m) => calls.push(`replace:${path}:${m.line}:${m.column}`),
    };
  };

  it('命中行：打开 / 复制命中行 / 复制路径 / 显示 / 替换各走各的落点', () => {
    const h = handlers();
    const m = match(7, 3, '  口上 缺 else');
    expect(runSearchMatchMenuAction(SEARCH_MATCH_MENU_IDS.open, 'C:/a.erb', m, h)).toBe(true);
    expect(runSearchMatchMenuAction(SEARCH_MATCH_MENU_IDS.copyLine, 'C:/a.erb', m, h)).toBe(true);
    expect(runSearchMatchMenuAction(SEARCH_MATCH_MENU_IDS.copyPath, 'C:/a.erb', m, h)).toBe(true);
    expect(runSearchMatchMenuAction(SEARCH_MATCH_MENU_IDS.reveal, 'C:/a.erb', m, h)).toBe(true);
    expect(runSearchMatchMenuAction(SEARCH_MATCH_MENU_IDS.replace, 'C:/a.erb', m, h)).toBe(true);
    expect(h.calls).toEqual([
      'open:C:/a.erb:7',
      'copy:  口上 缺 else', // 复制命中行 = 整行文本（后端 preview）
      'copy:C:/a.erb',
      'reveal:C:/a.erb',
      'replace:C:/a.erb:7:3', // 复用既有单条替换通道（路径 + 行 + 列）
    ]);
  });

  it('文件组：打开落到第一条命中；没有命中就不猜（返回 false）', () => {
    const h = handlers();
    expect(runSearchFileMenuAction(SEARCH_FILE_MENU_IDS.open, 'C:/a.erb', match(4, 1), h)).toBe(true);
    expect(runSearchFileMenuAction(SEARCH_FILE_MENU_IDS.open, 'C:/a.erb', null, h)).toBe(false);
    expect(runSearchFileMenuAction(SEARCH_FILE_MENU_IDS.copyPath, 'C:/a.erb', null, h)).toBe(true);
    expect(runSearchFileMenuAction(SEARCH_FILE_MENU_IDS.reveal, 'C:/a.erb', null, h)).toBe(true);
    expect(h.calls).toEqual(['open:C:/a.erb:4', 'copy:C:/a.erb', 'reveal:C:/a.erb']);
  });

  it('不是本菜单的 id ⇒ false（调用方不该被别的面的 id 带跑）', () => {
    const h = handlers();
    expect(runSearchMatchMenuAction('problems.copyAll', 'C:/a.erb', match(1, 1), h)).toBe(false);
    expect(runSearchFileMenuAction('problems.copyAll', 'C:/a.erb', null, h)).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

/* ══════════════════════════ 问题 · 单条菜单 ══════════════════════════ */

describe('问题面板 · 单条菜单', () => {
  it('唯一解 + 有码 + 有剪贴板：快速修复 | 在编辑器中显示 | 复制消息 | 按规则过滤', () => {
    const items = buildProblemRowMenu({ canCopy: true, canQuickFix: true, code: 'ERB1001' });
    expect(idsOf(items)).toEqual([
      PROBLEM_MENU_IDS.quickFix,
      PROBLEM_MENU_IDS.reveal,
      PROBLEM_MENU_IDS.copyMessage,
      PROBLEM_MENU_IDS.filterByCode,
    ]);
    expect(byId(items, PROBLEM_MENU_IDS.filterByCode).label).toContain('ERB1001');
  });

  it('没有唯一解 ⇒ 快速修复整项不显示（不留按了没反应的死按钮）', () => {
    const items = buildProblemRowMenu({ canCopy: true, canQuickFix: false, code: 'ERB1001' });
    expect(idsOf(items)).toEqual([
      PROBLEM_MENU_IDS.reveal,
      PROBLEM_MENU_IDS.copyMessage,
      PROBLEM_MENU_IDS.filterByCode,
    ]);
  });

  it('没有诊断码 ⇒ 按规则过滤整项不显示；没有剪贴板 ⇒ 复制消息整项不显示', () => {
    const noCode = buildProblemRowMenu({ canCopy: true, canQuickFix: false, code: null });
    expect(idsOf(noCode)).not.toContain(PROBLEM_MENU_IDS.filterByCode);
    const noCopy = buildProblemRowMenu({ canCopy: false, canQuickFix: true, code: 'ERB1001' });
    expect(idsOf(noCopy)).not.toContain(PROBLEM_MENU_IDS.copyMessage);
    // 空串码与"没有码"同义（DOM 属性缺省写成空串）
    expect(idsOf(buildProblemRowMenu({ canCopy: true, canQuickFix: false, code: '' }))).not.toContain(
      PROBLEM_MENU_IDS.filterByCode,
    );
  });

  it('文案全中文', () => {
    expectAllChinese(buildProblemRowMenu({ canCopy: true, canQuickFix: true, code: 'ERB1001' }));
  });
});

/* ══════════════════════════ 问题 · 面板级菜单 ══════════════════════════ */

describe('问题面板 · 面板级菜单', () => {
  it('有条目且有过滤：复制全部 | 清除过滤，两项都可用', () => {
    const items = buildProblemsPanelMenu({ canCopy: true, itemCount: 3, filtering: true });
    expect(idsOf(items)).toEqual([PROBLEM_MENU_IDS.copyAll, PROBLEM_MENU_IDS.clearFilter]);
    for (const item of items) expect(item.disabled).toBeUndefined();
  });

  it('没有条目 ⇒ 复制全部禁用并说原因；没有过滤 ⇒ 清除过滤禁用并说原因', () => {
    const items = buildProblemsPanelMenu({ canCopy: true, itemCount: 0, filtering: false });
    expect(byId(items, PROBLEM_MENU_IDS.copyAll).disabledReason).toBe(COPY_ALL_DISABLED_REASON);
    expect(byId(items, PROBLEM_MENU_IDS.clearFilter).disabledReason).toBe(CLEAR_FILTER_DISABLED_REASON);
    expectDisabledItemsSpeak(items);
    expectAllChinese(items);
  });

  it('没有剪贴板 ⇒ 只剩清除过滤（复制全部整项不显示）', () => {
    expect(idsOf(buildProblemsPanelMenu({ canCopy: false, itemCount: 2, filtering: true }))).toEqual([
      PROBLEM_MENU_IDS.clearFilter,
    ]);
  });
});

/* ══════════════════════════ 问题 · 动作分发 ══════════════════════════ */

describe('问题面板 · 动作分发', () => {
  const handlers = (): ProblemMenuHandlers & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      reveal: (p) => calls.push(`reveal:${p.path}:${p.line}`),
      quickFix: (p) => calls.push(`fix:${p.message}`),
      copyProblem: (p) => calls.push(`copy:${p.message}`),
      filterByCode: (code) => calls.push(`filter:${code}`),
      copyAll: () => calls.push('copyAll'),
      clearFilter: () => calls.push('clearFilter'),
    };
  };

  it('单条：快速修复 / 显示 / 复制消息 / 按规则过滤', () => {
    const h = handlers();
    const p = problem();
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.quickFix, p, h)).toBe(true);
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.reveal, p, h)).toBe(true);
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.copyMessage, p, h)).toBe(true);
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.filterByCode, p, h)).toBe(true);
    expect(h.calls).toEqual([
      'fix:缺 else 分支',
      'reveal:C:/game/erb/a.erb:12',
      'copy:缺 else 分支',
      'filter:ERB1001',
    ]);
  });

  it('没有诊断码时「按规则过滤」不发动作（不拿空串去过滤整表）', () => {
    const h = handlers();
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.filterByCode, problem({ code: undefined }), h)).toBe(
      false,
    );
    expect(h.calls).toEqual([]);
  });

  it('面板级：复制全部 / 清除过滤；别面 id ⇒ false', () => {
    const h = handlers();
    expect(runProblemsPanelMenuAction(PROBLEM_MENU_IDS.copyAll, h)).toBe(true);
    expect(runProblemsPanelMenuAction(PROBLEM_MENU_IDS.clearFilter, h)).toBe(true);
    expect(runProblemsPanelMenuAction('search.match.open', h)).toBe(false);
    expect(h.calls).toEqual(['copyAll', 'clearFilter']);
  });
});

/* ══════════════════════════ 面路由（DOM 身份 → 菜单） ══════════════════════════ */

const event = (): MouseEvent =>
  new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 });

/** 造一棵最小 DOM：面根 → 行 → 深层子元素（右键打在子元素上） */
function mountRow(surfaceId: string, rowTag: string, attrs: Record<string, string>): HTMLElement {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-context-surface', surfaceId);
  const row = document.createElement(surfaceId === 'problems' ? 'li' : 'div');
  row.setAttribute(rowTag, '');
  for (const [name, value] of Object.entries(attrs)) row.setAttribute(name, value);
  const inner = document.createElement(rowTag === 'data-problem-row' ? 'span' : 'span');
  row.appendChild(inner);
  root.appendChild(row);
  document.body.appendChild(root);
  return inner;
}

describe('search-results 面 · 路由', () => {
  it('右键命中行 ⇒ 命中菜单；选中 id 打到面板注入的动作上', () => {
    const path = 'C:/game/erb/a.erb';
    const m = match(9, 4);
    const openMatch = vi.fn();
    const replaceMatch = vi.fn();
    setSearchMenuContext({
      capabilities: ALL_CAPS,
      handlers: { openMatch, copyText: vi.fn(), revealPath: vi.fn(), replaceMatch },
      findMatch: (p, line, column) =>
        p === path && line === m.line && column === m.column ? m : null,
      firstMatchOf: () => m,
    });

    const deep = mountRow('search-results', 'data-search-match', {
      'data-search-path': path,
      'data-search-line': String(m.line),
      'data-search-column': String(m.column),
    });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('search-results');
    expect(route?.ariaLabel).toBe('搜索结果菜单');
    expect(idsOf(route?.items ?? [])).toContain(SEARCH_MATCH_MENU_IDS.replace);

    route?.onSelect(SEARCH_MATCH_MENU_IDS.open);
    route?.onSelect(SEARCH_MATCH_MENU_IDS.replace);
    expect(openMatch).toHaveBeenCalledWith(path, m);
    expect(replaceMatch).toHaveBeenCalledWith(path, m);
  });

  it('右键文件组 ⇒ 文件菜单；「打开」落到该文件第一条命中', () => {
    const path = 'C:/game/erb/a.erb';
    const first = match(3, 1);
    const openMatch = vi.fn();
    setSearchMenuContext({
      capabilities: ALL_CAPS,
      handlers: { openMatch, copyText: vi.fn(), revealPath: vi.fn(), replaceMatch: vi.fn() },
      findMatch: () => null,
      firstMatchOf: (p) => (p === path ? first : null),
    });

    const deep = mountRow('search-results', 'data-search-file', { 'data-search-path': path });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('search-results');
    expect(idsOf(route?.items ?? [])).toEqual([
      SEARCH_FILE_MENU_IDS.open,
      SEARCH_FILE_MENU_IDS.copyPath,
      SEARCH_FILE_MENU_IDS.reveal,
    ]);
    route?.onSelect(SEARCH_FILE_MENU_IDS.open);
    expect(openMatch).toHaveBeenCalledWith(path, first);
  });

  it('命中已不在投影里（结果刷新过）⇒ 本面不表态，走兜底', () => {
    setSearchMenuContext({
      capabilities: ALL_CAPS,
      handlers: { openMatch: vi.fn(), copyText: vi.fn(), revealPath: vi.fn(), replaceMatch: vi.fn() },
      findMatch: () => null,
      firstMatchOf: () => null,
    });
    const deep = mountRow('search-results', 'data-search-match', {
      'data-search-path': 'C:/gone.erb',
      'data-search-line': '1',
      'data-search-column': '1',
    });
    expect(buildContextMenuRoute(deep, event())?.source).toBe('app-fallback');
  });

  it('输入框归全局输入框面（检索框的粘贴/全选不被搜索结果面截走）', () => {
    setSearchMenuContext({
      capabilities: ALL_CAPS,
      handlers: { openMatch: vi.fn(), copyText: vi.fn(), revealPath: vi.fn(), replaceMatch: vi.fn() },
      findMatch: () => null,
      firstMatchOf: () => null,
    });
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-context-surface', 'search-results');
    const input = document.createElement('input');
    root.appendChild(input);
    document.body.appendChild(root);
    expect(buildContextMenuRoute(input, event())?.source).toBe('input');
  });

  it('上下文未注入（面板没挂载）⇒ 不表态，走兜底', () => {
    setSearchMenuContext(null);
    const deep = mountRow('search-results', 'data-search-match', {
      'data-search-path': 'C:/a.erb',
      'data-search-line': '1',
      'data-search-column': '1',
    });
    expect(buildContextMenuRoute(deep, event())?.source).toBe('app-fallback');
  });
});

describe('problems 面 · 路由', () => {
  it('右键单条 ⇒ 单条菜单（有唯一解时才出现快速修复）', () => {
    const p = problem();
    const quickFix = vi.fn();
    const copyProblem = vi.fn();
    setProblemsMenuContext({
      capabilities: { canCopy: true },
      handlers: {
        reveal: vi.fn(),
        quickFix,
        copyProblem,
        filterByCode: vi.fn(),
        copyAll: vi.fn(),
        clearFilter: vi.fn(),
      },
      problemAt: (path, line, code) =>
        path === p.path && line === p.line && code === (p.code ?? '') ? p : null,
      quickFixAvailable: () => true,
      itemCount: () => 1,
      filtering: () => false,
    });

    const deep = mountRow('problems', 'data-problem-row', {
      'data-problem-path': p.path,
      'data-problem-line': String(p.line),
      'data-problem-code': p.code ?? '',
    });
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('problems');
    expect(route?.ariaLabel).toBe('问题面板菜单');
    expect(idsOf(route?.items ?? [])).toEqual([
      PROBLEM_MENU_IDS.quickFix,
      PROBLEM_MENU_IDS.reveal,
      PROBLEM_MENU_IDS.copyMessage,
      PROBLEM_MENU_IDS.filterByCode,
    ]);
    route?.onSelect(PROBLEM_MENU_IDS.quickFix);
    route?.onSelect(PROBLEM_MENU_IDS.copyMessage);
    expect(quickFix).toHaveBeenCalledWith(p);
    expect(copyProblem).toHaveBeenCalledWith(p);
  });

  it('右键面板空白 / 汇总行 ⇒ 面板级菜单（复制全部 + 清除过滤）', () => {
    setProblemsMenuContext({
      capabilities: { canCopy: true },
      handlers: {
        reveal: vi.fn(),
        quickFix: vi.fn(),
        copyProblem: vi.fn(),
        filterByCode: vi.fn(),
        copyAll: vi.fn(),
        clearFilter: vi.fn(),
      },
      problemAt: () => null,
      quickFixAvailable: () => false,
      itemCount: () => 2,
      filtering: () => true,
    });
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-context-surface', 'problems');
    const blank = document.createElement('span');
    root.appendChild(blank);
    document.body.appendChild(root);

    const route = buildContextMenuRoute(blank, event());
    expect(route?.source).toBe('problems');
    expect(idsOf(route?.items ?? [])).toEqual([PROBLEM_MENU_IDS.copyAll, PROBLEM_MENU_IDS.clearFilter]);
  });

  it('过滤框归全局输入框面（面板级菜单不抢粘贴）', () => {
    setProblemsMenuContext({
      capabilities: { canCopy: true },
      handlers: {
        reveal: vi.fn(),
        quickFix: vi.fn(),
        copyProblem: vi.fn(),
        filterByCode: vi.fn(),
        copyAll: vi.fn(),
        clearFilter: vi.fn(),
      },
      problemAt: () => null,
      quickFixAvailable: () => false,
      itemCount: () => 1,
      filtering: () => false,
    });
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-context-surface', 'problems');
    const input = document.createElement('input');
    root.appendChild(input);
    document.body.appendChild(root);
    expect(buildContextMenuRoute(input, event())?.source).toBe('input');
  });

  it('行身份属性与模块常量同一口径（组件写的 data-* 与面读的必须是一组）', async () => {
    const mod = await import('../src/ui/problem-menu');
    expect(mod.PROBLEM_ROW_ATTR).toBe('data-problem-row');
    expect(mod.PROBLEM_PATH_ATTR).toBe('data-problem-path');
    expect(mod.PROBLEM_LINE_ATTR).toBe('data-problem-line');
    expect(mod.PROBLEM_CODE_ATTR).toBe('data-problem-code');
    const search = await import('../src/ui/search-menu');
    expect(search.SEARCH_MATCH_ATTR).toBe('data-search-match');
    expect(search.SEARCH_FILE_ATTR).toBe('data-search-file');
    expect(search.SEARCH_PATH_ATTR).toBe('data-search-path');
    expect(search.SEARCH_LINE_ATTR).toBe('data-search-line');
    expect(search.SEARCH_COLUMN_ATTR).toBe('data-search-column');
  });
});
