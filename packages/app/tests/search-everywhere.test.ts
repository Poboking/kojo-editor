import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EditorCommandContext } from '@kojo/plugin-api';
import type { CommandEntry } from '../src/ui/commands';
import {
  DOUBLE_SHIFT_WINDOW_MS,
  planDoubleClickShift,
  type ShiftKeyFrame,
} from '../src/ui/search-everywhere-trigger';
import {
  planSearchEverywhereKey,
  searchEverywhereView,
  SE_ACTION_GROUP,
  SE_ALL_CATEGORY_CAP,
  SE_GROUP_LABELS,
  SEARCH_EVERYWHERE_TABS,
  TEXT_SEARCH_ACTION_KEY,
  textSearchActionLabel,
  type SearchEverywhereViewInput,
} from '../src/ui/search-everywhere';
import { SearchEverywhere } from '../src/ui/Palette';
import { symbolPickerKey } from '../src/ui/workspace-symbols';

/**
 * 全局搜索（Search Everywhere，2026-10-28 体验对等批）的判据单测。
 *
 * 三条车分别钉：
 * ① `planDoubleClickShift`——窗口内两发触发 / 跨窗不触发 / 其它键断链 / `ctrl+shift` 不误触 /
 *    面板在前台不重复触发 / 触发后吃掉连击 / 按住自动重复不算双击；
 * ② `searchEverywhereView`——综合档跨类统一排序与分组、每类截断、底部动作行恒在场；
 * ③ `planSearchEverywhereKey`——Alt+1..4 直选与 Ctrl+Tab 族环向（面板内消费、全局侧由
 *    `defaultPrevented` 早退让位，那条腿由 `shell-keys-guard.test.ts` 的既有判据保底）。
 */

const T0 = 1_000_000;
const ON: { enabled: boolean; frontBusy: boolean } = { enabled: true, frontBusy: false };

const shift = (atMs: number, mods: Partial<Pick<ShiftKeyFrame, 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'>> = {}): ShiftKeyFrame => ({
  key: 'Shift',
  ctrlKey: mods.ctrlKey ?? false,
  altKey: mods.altKey ?? false,
  metaKey: mods.metaKey ?? false,
  repeat: mods.repeat,
  atMs,
});
const letter = (key: string, atMs: number): ShiftKeyFrame => ({ key, ctrlKey: false, altKey: false, metaKey: false, atMs });

describe('planDoubleClickShift：双击 Shift 的窗口与抑制', () => {
  it('窗口内两发纯 Shift ⇒ 触发，且连击被吃掉（清单清空）', () => {
    const plan = planDoubleClickShift([shift(T0), shift(T0 + 120)], T0 + 120, ON);
    expect(plan.fire).toBe(true);
    expect(plan.reason).toBe('fired');
    expect(plan.pending).toEqual([]);
  });

  it('第一发只记账不触发', () => {
    const plan = planDoubleClickShift([shift(T0)], T0, ON);
    expect(plan.fire).toBe(false);
    expect(plan.reason).toBe('first-tap');
    expect(plan.pending).toHaveLength(1);
  });

  it('跨窗口（间隔 > 400ms）不触发：过期的前一发掉账，当前这发改记为新组第一发', () => {
    const plan = planDoubleClickShift([shift(T0), shift(T0 + DOUBLE_SHIFT_WINDOW_MS + 1)], T0 + DOUBLE_SHIFT_WINDOW_MS + 1, ON);
    expect(plan.fire).toBe(false);
    expect(plan.reason).toBe('tap-expired');
    expect(plan.pending.map((f) => f.atMs)).toEqual([T0 + DOUBLE_SHIFT_WINDOW_MS + 1]);
    // 压在窗口边上（恰好 400ms）仍算双击——判据是 `<=`，不是 `<`
    expect(planDoubleClickShift([shift(T0), shift(T0 + DOUBLE_SHIFT_WINDOW_MS)], T0 + DOUBLE_SHIFT_WINDOW_MS, ON).fire).toBe(true);
  });

  it('两发之间出现其它键 ⇒ 断链不触发（字母、Esc 都一样）', () => {
    expect(planDoubleClickShift([shift(T0), letter('a', T0 + 50)], T0 + 50, ON).reason).toBe('not-shift');
    const afterLetter = planDoubleClickShift([shift(T0), letter('a', T0 + 50)], T0 + 50, ON);
    expect(afterLetter.pending).toEqual([]);
    // 断链后再补一发 Shift：只是新组的第一发，不触发
    expect(planDoubleClickShift([...afterLetter.pending, shift(T0 + 100)], T0 + 100, ON).fire).toBe(false);
  });

  it('`ctrl+shift+p` 组合里的 Shift 不误触发（带任何其它修饰键都不计数还断链）', () => {
    const combo = planDoubleClickShift([shift(T0), { ...shift(T0 + 80), ctrlKey: true }], T0 + 80, ON);
    expect(combo.fire).toBe(false);
    expect(combo.reason).toBe('shift-with-modifier');
    expect(combo.pending).toEqual([]);
    expect(planDoubleClickShift([{ key: 'p', ctrlKey: true, altKey: false, metaKey: false, atMs: T0 + 90 }], T0 + 90, ON).fire).toBe(false);
  });

  it('面板/浮层在前台 ⇒ 不重复触发，且这组连击照样吃掉', () => {
    const plan = planDoubleClickShift([shift(T0), shift(T0 + 100)], T0 + 100, { enabled: true, frontBusy: true });
    expect(plan.fire).toBe(false);
    expect(plan.reason).toBe('suppressed-front-busy');
    expect(plan.pending).toEqual([]);
  });

  it('偏好关掉 ⇒ 这条腿彻底不响应（账本也不记；命令本身仍在，由注册表侧保证）', () => {
    const plan = planDoubleClickShift([shift(T0), shift(T0 + 60)], T0 + 60, { enabled: false, frontBusy: false });
    expect(plan.fire).toBe(false);
    expect(plan.reason).toBe('suppressed-disabled');
    expect(plan.pending).toEqual([]);
  });

  it('触发后第三发只是新组的第一发（不会把还开着的面板又顶一次）', () => {
    const first = planDoubleClickShift([shift(T0), shift(T0 + 100)], T0 + 100, ON);
    expect(first.fire).toBe(true);
    const third = planDoubleClickShift([...first.pending, shift(T0 + 200)], T0 + 200, ON);
    expect(third.fire).toBe(false);
    expect(third.reason).toBe('first-tap');
  });

  it('按住 Shift 的自动重复：不算第二发、也不断链', () => {
    const plan = planDoubleClickShift([shift(T0), shift(T0 + 30, { repeat: true })], T0 + 30, ON);
    expect(plan.fire).toBe(false);
    expect(plan.reason).toBe('key-repeat');
    expect(plan.pending.map((f) => f.atMs)).toEqual([T0]);
    // 松手后补一发真按 ⇒ 与仍在窗口内的 T0 那发凑成双击
    expect(planDoubleClickShift([...plan.pending, shift(T0 + 200)], T0 + 200, ON).fire).toBe(true);
  });
});

/* -------------------------- 综合档视图 -------------------------- */

const CTX: EditorCommandContext = { project: null };
const CMD: readonly CommandEntry[] = [
  { id: 'workbench.saveAll', title: '全部保存', category: '工作台', run: () => undefined },
  { id: 'layout.toggleZen', title: '切换写作模式', category: '布局', run: () => undefined },
];
const FILE_A = 'C:\\game\\ERB\\口上\\M_KOJO_K1_日常.kojo';
const FILE_B = 'C:\\game\\ERB\\口上\\道中.kojo';

function viewInput(over: Partial<SearchEverywhereViewInput> = {}): SearchEverywhereViewInput {
  return {
    tab: 'all',
    term: '',
    commands: CMD,
    commandCtx: CTX,
    files: [FILE_A, FILE_B],
    symbols: { symbols: [], totalMatched: 0, scope: null },
    symbolSource: null,
    activeFile: null,
    ...over,
  };
}

describe('searchEverywhereView · 综合档分组', () => {
  it('空查询：固定组序 命令→文件→符号，三类行都挂各自分组标题，动作行恒在最后', () => {
    const view = searchEverywhereView(viewInput());
    const groups = view.items.map((i) => i.group);
    expect(groups[groups.length - 1]).toBe(SE_ACTION_GROUP);
    expect(view.items[view.items.length - 1]!.key).toBe(TEXT_SEARCH_ACTION_KEY);
    const commandIdx = view.items.findIndex((i) => i.key === 'workbench.saveAll');
    const fileIdx = view.items.findIndex((i) => i.key === FILE_A);
    expect(commandIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThan(commandIdx);
    expect(view.items[commandIdx]!.group).toBe(SE_GROUP_LABELS.commands);
    expect(view.items[fileIdx]!.group).toBe(SE_GROUP_LABELS.files);
  });

  it('跨类统一排序：分数最高的那一类排前面（文件强命中压过命令弱命中）', () => {
    const view = searchEverywhereView(viewInput({ term: '道中' }));
    const rows = view.items.filter((i) => i.key !== TEXT_SEARCH_ACTION_KEY);
    expect(rows[0]!.group).toBe(SE_GROUP_LABELS.files);
    expect(rows.map((r) => r.key)).toEqual([FILE_B]); // 命令类一枚都不匹配 ⇒ 不出现
  });

  it('同类内按分数降序、组内截到每类上限（超出如实进 footnote，预算 ≠ 丢弃）', () => {
    const many: readonly string[] = Array.from({ length: SE_ALL_CATEGORY_CAP + 5 }, (_, i) => `C:\\e\\ad${i}.ERB`);
    const view = searchEverywhereView(viewInput({ term: 'ad', files: many }));
    const fileRows = view.items.filter((i) => i.group === SE_GROUP_LABELS.files);
    expect(fileRows).toHaveLength(SE_ALL_CATEGORY_CAP);
    expect(view.footnote).toContain('另有 5 条未列出');
  });

  it('符号候选只吃槽应答的合并结果（视图零自拼词表）；无项目空集时符号组自然缺席', () => {
    const view = searchEverywhereView(viewInput());
    expect(view.items.some((i) => i.group === SE_GROUP_LABELS.symbols)).toBe(false);
    const withSymbol = searchEverywhereView(
      viewInput({
        term: 'M_KOJO',
        symbols: {
          symbols: [{ name: 'M_KOJO_K1_日常', kind: 'function', filePath: FILE_A, line: 12 }],
          totalMatched: 1,
          scope: null,
        },
      }),
    );
    const sym = withSymbol.items.find((i) => i.group === SE_GROUP_LABELS.symbols)!;
    expect(sym.key).toBe(symbolPickerKey({ name: 'M_KOJO_K1_日常', kind: 'function', filePath: FILE_A, line: 12 }));
    expect(sym.hint).toBe(':12');
  });

  it('底部动作行把当前词原样带进文案（空词说"…"，不骗人已填词）', () => {
    expect(textSearchActionLabel('')).toBe('在项目内全文搜索…');
    expect(textSearchActionLabel('  补丁  ')).toBe('在项目内全文搜索「补丁」');
    const view = searchEverywhereView(viewInput({ term: '补丁' }));
    expect(view.items[view.items.length - 1]!.primary).toBe('在项目内全文搜索「补丁」');
  });

  it('单档模式只给那一类，但仍带动作行与切档提示', () => {
    const filesOnly = searchEverywhereView(viewInput({ tab: 'files', term: 'kojo' }));
    // 文件单档沿用 `quickOpenView` 的分组原样（无 recent ⇒ 不带组名），判据是"键全属文件类"
    expect(
      filesOnly.items.every(
        (i) => i.key === TEXT_SEARCH_ACTION_KEY || i.key === FILE_A || i.key === FILE_B,
      ),
    ).toBe(true);
    const commandsOnly = searchEverywhereView(viewInput({ tab: 'commands', term: '' }));
    expect(commandsOnly.items.some((i) => i.key === FILE_A)).toBe(false);
    // 命令单档与 F1 同一份显示层整形：分类名搬分组标签、主行只剩标题
    expect(commandsOnly.items.some((i) => i.key === 'workbench.saveAll' && i.primary === '全部保存')).toBe(true);
  });
});

/* -------------------------- 档位切换键 -------------------------- */

describe('planSearchEverywhereKey：Alt+1..4 与 Ctrl+Tab 族', () => {
  const key = (over: Partial<{ key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) => ({
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...over,
  });

  it('Alt+1..4 直选四档（顺序就是 SEARCH_EVERYWHERE_TABS）', () => {
    SEARCH_EVERYWHERE_TABS.forEach((tab, i) => {
      expect(planSearchEverywhereKey(key({ key: String(i + 1), altKey: true }), 'files')).toBe(tab);
    });
    expect(planSearchEverywhereKey(key({ key: '5', altKey: true }), 'all')).toBeNull();
  });

  it('Ctrl+Tab 往后切、Ctrl+Shift+Tab 往前切，到界回绕', () => {
    expect(planSearchEverywhereKey(key({ key: 'Tab', ctrlKey: true }), 'all')).toBe('commands');
    expect(planSearchEverywhereKey(key({ key: 'Tab', ctrlKey: true }), 'symbols')).toBe('all');
    expect(planSearchEverywhereKey(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'all')).toBe('symbols');
  });

  it('其余键一律不消费（↑↓/Enter/Esc 归列表导航，Alt+字母归系统）', () => {
    expect(planSearchEverywhereKey(key({ key: 'ArrowDown' }), 'all')).toBeNull();
    expect(planSearchEverywhereKey(key({ key: 'Enter' }), 'all')).toBeNull();
    expect(planSearchEverywhereKey(key({ key: 'f', altKey: true }), 'all')).toBeNull();
  });
});

/* -------------------------- 渲染层（SSR，口径照 palette-groups.test.ts） -------------------------- */

describe('SearchEverywhere · 渲染', () => {
  it('综合档 SSR：分组标题齐全、动作行在列（列表导航/键盘腿由上面纯函数钉死）', () => {
    const html = renderToStaticMarkup(
      createElement(SearchEverywhere, {
        commands: CMD,
        commandCtx: CTX,
        files: [FILE_A, FILE_B],
        fetchSymbols: () => ({ symbols: [], totalMatched: 0, scope: null }),
        onOpenFile: () => undefined,
        onPickSymbol: () => undefined,
        onFullTextSearch: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('命令');
    expect(html).toContain('全文搜索');
    expect(html).toContain('在项目内全文搜索…');
    expect(html).toContain('全部保存');
    expect(html).toContain('M_KOJO_K1_日常.kojo');
  });
});
