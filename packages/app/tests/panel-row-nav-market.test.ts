/**
 * 口上市场面板的行键盘接线（kw8c 段② · 可触发档重接）。
 *
 * **桩风格，不起 jsdom/happy-dom**（对齐契约层判据 `plugin-api/tests/panel-row-nav.test.ts`）：
 * `MarketPanelView` 是零状态层、可当普通函数直接建树（`integration.test.ts` 同款做法），
 * 本文件按 DOM 序遍历 React 元素树，把带契约层行标记的**行代表**摘成最小结构化桩行
 * （focus/click/closest/getAttribute + 行自己的 `onClick`），再喂 `applyPanelRowNav`。
 * 键位判据的真源与全量口径在契约层钉死；这里钉的是**市场的接线**：
 * - 名单五枚 = 已装两枚「详情/收起」（**默认 open 档**：展开不改状态，F4/F8 当场敲对）
 *   + 索引「安装 / 更新」两枚主钮（**none 档**：会改状态，↑↓ 踩得住、F8 绝不开枪）
 *   + `action === 'none'` 的索引行由**行 div 自己**当代表（**none 档**：只读行进 ↑↓ 名单，
 *   kw8b 上报的"整行消失"缺口由此补上——这正是段① 加档的理由）；
 * - 一枚行只有一枚代表：动作簇（导入/卸载/确认/取消）、`.mk-detail`、工具条与来源钮都不进名单；
 * - **焦点踩住「安装」按 F8 ⇒ `onInstall` 调用次数为 0**，落点绕到下一段可触发行才 click；
 * - 整段无可触发行 ⇒ 功能键不消费、`preventDefault` 一次不调（不静默吞键）；
 * - 面板根 `.panel-market` 的接线腿（`ref/tabIndex=-1/onKeyDown/onFocus`）真的在；
 * - **确认簇的 Esc 一个字没碰**：行导航对 Esc 不消费、不抢焦点，簇自己那条取消腿照走。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  applyPanelRowNav,
  PANEL_ROW_ATTR,
  PANEL_ROW_SELECTOR,
  PANEL_ROW_TRIGGER_ATTR,
  PANEL_ROW_TRIGGER_NONE,
  syncRovingTabIndexes,
  type InstalledPack,
  type MarketIndexEntry,
  type RowNavDomEvent,
} from '@kojo/plugin-api';
import { MarketPanelView, type MarketPanelViewProps } from '../../plugins/ui-market/src/market-panel-view';
import type { MarketSnapshot } from '../../plugins/ui-market/src/actions';
import { indexRowKey, pendingKey, type PackRow } from '../../plugins/ui-market/src/market-view';

const hex = (c: string): string => c.repeat(64);

const zip = (name: string, c: string) => ({
  url: `https://example.test/${name}.zip`,
  sha256: hex(c),
  bytes: 1004,
});

const entry = (over: Partial<MarketIndexEntry> = {}): MarketIndexEntry => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version: '1.0.0',
  name: '演示口上包',
  author: '某人',
  license: 'CC-BY-NC 4.0',
  minAppVersion: '0.4.0',
  zip: zip('demo', 'a'),
  fileCount: 3,
  unpackedBytes: 2048,
  ...over,
});

const rec = (over: Partial<InstalledPack> = {}): InstalledPack => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version: '1.0.0',
  name: '演示口上包',
  author: '某人',
  license: 'CC-BY-NC 4.0',
  contentDigest: hex('b'),
  installedAt: 1_700_000_000_000,
  files: [],
  ...over,
});

const INSTALLED: InstalledPack[] = [
  rec(),
  rec({ id: 'up.pack', name: '乙包', version: '1.0.0' }),
];

/** 索引三条：`demo.pack` 与已装同版 ⇒ 动作 `none`（行 div 当代表）；甲可装、乙可更新（主钮 none 档） */
const PACKS: MarketIndexEntry[] = [
  entry(),
  entry({ id: 'fresh.pack', version: '2.0.0', name: '甲包', zip: zip('fresh', 'c') }),
  entry({ id: 'up.pack', version: '1.1.0', name: '乙包', zip: zip('up', 'd') }),
];

const snapshot = (): MarketSnapshot => ({
  status: 'ready',
  packs: PACKS,
  installed: INSTALLED,
  installedBytes: 2048,
  dropped: [],
  coverIgnored: [],
  reason: '',
  fetchedAt: 1_700_000_000_000,
  generatedAt: null,
  endpoint: 'https://example.test/index.json',
  pullNote: '',
});

function newSpies() {
  return {
    onQuery: vi.fn<(q: string) => void>(),
    onClearQuery: vi.fn<() => void>(),
    onPull: vi.fn<() => void>(),
    onPublish: vi.fn<() => void>(),
    onInstall: vi.fn<(row: PackRow) => void>(),
    onImport: vi.fn<(rec: InstalledPack) => void>(),
    onOpenSource: vi.fn<(url: string) => void>(),
    onRequestUninstall: vi.fn<(key: string) => void>(),
    onConfirmUninstall: vi.fn<(key: string) => void>(),
    onCancelUninstall: vi.fn<() => void>(),
    onToggleDetail: vi.fn<(key: string) => void>(),
  };
}

type Spies = ReturnType<typeof newSpies>;

function makeProps(over: Partial<MarketPanelViewProps> = {}): { props: MarketPanelViewProps; spies: Spies } {
  const spies = newSpies();
  const props: MarketPanelViewProps = {
    snapshot: snapshot(),
    appVersion: '0.4.0',
    query: '',
    busy: false,
    note: '',
    progress: null,
    pending: null,
    open: null,
    installing: null,
    coverFailedKeys: new Set<string>(),
    onCoverError: () => undefined,
    onQuery: spies.onQuery,
    onClearQuery: spies.onClearQuery,
    onPull: spies.onPull,
    onPublish: spies.onPublish,
    onInstall: spies.onInstall,
    onImport: spies.onImport,
    onOpenSource: spies.onOpenSource,
    onRequestUninstall: spies.onRequestUninstall,
    onConfirmUninstall: spies.onConfirmUninstall,
    onCancelUninstall: spies.onCancelUninstall,
    onToggleDetail: spies.onToggleDetail,
    ...over,
  };
  return { props, spies };
}

/* ---------------- 元素树 → 桩行名单（按 DOM 序，一行只摘一枚代表） ---------------- */

interface RowStub {
  /** 行身份（`data-market-key`，行代表自己或最近祖先身上的） */
  key: string | null;
  /** 元素的行档：button=主钮代表，div=无动作行的行 div 代表 */
  tag: string;
  label: string;
  /** `data-panel-row-trigger` 的读数；null = 属性缺席 = 默认 `open` 档 */
  trigger: string | null;
  focused: number;
  clicked: number;
  tabIndex?: number;
  focus(): void;
  click(): void;
  closest(selector: string): unknown;
  getAttribute(name: string): string | null;
}

function walkTree(node: ReactNode, visit: (el: ReactElement<Record<string, unknown>>, rowKey: string | null) => void): void {
  const go = (n: ReactNode, rowKey: string | null): void => {
    if (Array.isArray(n)) {
      for (const c of n) go(c, rowKey);
      return;
    }
    if (n === null || typeof n !== 'object') return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (typeof el.type !== 'string') return; // 零状态层不出现自定义组件；出现了也不带行标记
    const ownKey = typeof el.props['data-market-key'] === 'string' ? (el.props['data-market-key'] as string) : rowKey;
    visit(el, ownKey);
    go(el.props.children as ReactNode, ownKey);
  };
  go(node, null);
}

/** 面板根（`className` 恰为 `panel-market` 的那枚元素；接线腿都挂在它的 props 上） */
function findPanelRoot(node: ReactNode): ReactElement<Record<string, unknown>> {
  let found: ReactElement<Record<string, unknown>> | null = null;
  walkTree(node, (el) => {
    if (found === null && el.props.className === 'panel-market') found = el;
  });
  if (found === null) throw new Error('面板根 .panel-market 没画出来');
  return found;
}

function findClass(node: ReactNode, cls: string): ReactElement<Record<string, unknown>> {
  let found: ReactElement<Record<string, unknown>> | null = null;
  walkTree(node, (el) => {
    if (found === null && typeof el.props.className === 'string' && el.props.className.includes(cls)) found = el;
  });
  if (found === null) throw new Error(`元素 ${cls} 没画出来`);
  return found;
}

/** 按 DOM 序摘出行代表名单（选择器判据与契约层同一枚常量，不另抄字符串；key 取最近 `data-market-key` 祖先） */
function buildRows(node: ReactNode): RowStub[] {
  const rows: RowStub[] = [];
  walkTree(node, (el, rowKey) => {
    if (el.props[PANEL_ROW_ATTR] === undefined) return;
    const onClick = el.props.onClick as (() => void) | undefined;
    const trigger = typeof el.props[PANEL_ROW_TRIGGER_ATTR] === 'string'
      ? (el.props[PANEL_ROW_TRIGGER_ATTR] as string)
      : null;
    const row: RowStub = {
      key: rowKey,
      tag: el.type as string,
      label: typeof el.props.children === 'string' ? el.props.children : '(行代表)',
      trigger,
      focused: 0,
      clicked: 0,
      focus() {
        row.focused++;
      },
      click() {
        row.clicked++;
        onClick?.(); // 打开永远走这一行自己的 onClick——零第二条通路
      },
      closest(selector: string) {
        return selector === PANEL_ROW_SELECTOR ? row : null; // 市场只有单行 input，无 select/textarea
      },
      getAttribute(name: string) {
        return name === PANEL_ROW_TRIGGER_ATTR ? row.trigger : null;
      },
    };
    rows.push(row);
  });
  return rows;
}

/** 渲染 + 摘名单 + 挂好名单的宿主桩 + 面板根 */
function mount(over: Partial<MarketPanelViewProps> = {}): {
  rows: RowStub[];
  spies: Spies;
  host: { querySelectorAll(selector: string): ArrayLike<RowStub> };
  root: ReactElement<Record<string, unknown>>;
} {
  const { props, spies } = makeProps(over);
  const node = MarketPanelView(props) as ReactNode;
  const rows = buildRows(node);
  return {
    rows,
    spies,
    host: {
      querySelectorAll(selector: string) {
        expect(selector).toBe(PANEL_ROW_SELECTOR); // 名单只按行标记这一个选择器取
        return rows;
      },
    },
    root: findPanelRoot(node),
  };
}

function event(
  target: RowStub | null,
  key: string,
  init: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {},
): RowNavDomEvent & { prevented: number } {
  const e = {
    key,
    shiftKey: init.shiftKey ?? false,
    target,
    ...(init.isComposing === undefined ? {} : { isComposing: init.isComposing }),
    ...(init.keyCode === undefined ? {} : { keyCode: init.keyCode }),
    prevented: 0,
    preventDefault() {
      e.prevented++;
    },
  };
  return e;
}

/** 事件 → 面板根那条 onKeyDown 腿（真接线的入口，不绕过去直接调契约函数） */
function pressOnRoot(m: ReturnType<typeof mount>, e: RowNavDomEvent & { prevented: number }): void {
  const onKeyDown = m.root.props.onKeyDown as (ev: unknown) => void;
  onKeyDown({ ...e, currentTarget: m.host });
}

describe('口上市场面板 · 行键盘接线（kw8c 可触发档）', () => {
  it('名单五枚、一行一枚代表：「详情」= 默认 open 档，「安装/更新」与无动作行 = none 档', () => {
    const m = mount();
    expect(m.rows).toHaveLength(5);
    // 已装段在前，且都是「详情」主钮、没贴触发档属性（缺席 = 默认可打开）
    expect(m.rows.slice(0, 2).map((r) => r.label)).toEqual(['详情', '详情']);
    expect(m.rows.slice(0, 2).every((r) => r.trigger === null && r.tag === 'button')).toBe(true);
    // 索引段的动作档：会改状态的两枚主钮 = `none`；无动作那行 = 行 div 自己 + `none`
    const install = m.rows.find((r) => r.label === '安装')!;
    const update = m.rows.find((r) => r.label === '更新')!;
    expect(install.key).toBe(indexRowKey(PACKS[1]!));
    expect(update.key).toBe(indexRowKey(PACKS[2]!));
    expect(install.trigger).toBe(PANEL_ROW_TRIGGER_NONE);
    expect(update.trigger).toBe(PANEL_ROW_TRIGGER_NONE);
    // `action === 'none'` 的索引行：行 div 当代表进名单（kw8b 那份"整行消失"不再成立）
    const readonly = m.rows.find((r) => r.key === indexRowKey(PACKS[0]!) && r.tag === 'div')!;
    expect(readonly.label).toBe('(行代表)');
    expect(readonly.trigger).toBe(PANEL_ROW_TRIGGER_NONE);
    // 动作簇与工具条一枚都不在名单里：名单标签恰是这四型
    expect(new Set(m.rows.map((r) => r.label))).toEqual(new Set(['详情', '安装', '更新', '(行代表)']));
  });

  it('↑↓ 把五格挨个踩住（含 none 档行）、边界回绕、什么都不知道开；漫游 tabindex 跟着走', () => {
    const m = mount();
    const e0 = event(null, 'ArrowDown');
    expect(applyPanelRowNav(m.host, e0)).toBe(true);
    expect(m.rows[0]!.focused).toBe(1);
    for (let i = 0; i < 5; i++) {
      const e = event(m.rows[i]!, 'ArrowDown');
      expect(applyPanelRowNav(m.host, e)).toBe(true);
      const next = m.rows[(i + 1) % 5]!;
      expect(next.focused).toBe(i === 4 ? 2 : 1); // 末格再往下 = 回绕第一格（第二次于它）
      expect(next.tabIndex).toBe(0);
      expect(m.rows.filter((r) => r.tabIndex === 0)).toHaveLength(1); // 整段只留一枚 0
    }
    expect(m.rows.every((r) => r.clicked === 0)).toBe(true);
    expect(m.spies.onInstall).not.toHaveBeenCalled();
    expect(m.spies.onToggleDetail).not.toHaveBeenCalled();
  });

  it('核心钉：焦点踩住「安装」按 F8 ⇒ onInstall 调用次数为 0，落点绕到下一段可触发行才 click', () => {
    const m = mount();
    const install = m.rows.find((r) => r.label === '安装')!;
    const startIdx = m.rows.indexOf(install);
    const e = event(install, 'F8');
    expect(applyPanelRowNav(m.host, e)).toBe(true);
    expect(m.spies.onInstall).toHaveBeenCalledTimes(0); // 会改状态的钮：F8 绝不开枪
    expect(install.clicked).toBe(0);
    // 落点 = 环形扫描到的第一枚 open 档行（名单里「详情」），并当场敲它的 onClick
    let landing = m.rows[(startIdx + 1) % 5]!;
    let guard = 0;
    while (landing.trigger === PANEL_ROW_TRIGGER_NONE && guard++ < 5) landing = m.rows[(m.rows.indexOf(landing) + 1) % 5]!;
    expect(landing.trigger).toBeNull();
    expect(landing.focused).toBe(1);
    expect(landing.clicked).toBe(1);
    expect(m.spies.onToggleDetail).toHaveBeenCalledTimes(1);
    expect(m.spies.onToggleDetail).toHaveBeenCalledWith(landing.key);
    expect(e.prevented).toBe(1);
    // Shift+F8 反向：从落点回头仍只落 open 档——环形倒退扫到的第一枚「详情」，不碰任何动作钮
    const e2 = event(landing, 'F8', { shiftKey: true });
    expect(applyPanelRowNav(m.host, e2)).toBe(true);
    let back = m.rows[(m.rows.indexOf(landing) - 1 + 5) % 5]!;
    let guard2 = 0;
    while (back.trigger === PANEL_ROW_TRIGGER_NONE && guard2++ < 5) {
      back = m.rows[(m.rows.indexOf(back) - 1 + 5) % 5]!;
    }
    expect(back.trigger).toBeNull();
    expect(back.focused).toBe(1);
    expect(back.clicked).toBe(1);
    expect(m.spies.onInstall).toHaveBeenCalledTimes(0);
    expect(m.spies.onToggleDetail).toHaveBeenCalledTimes(2);
  });

  it('整段名单无可触发行（真 none 档子集）：功能键不消费、preventDefault 一次不调、焦点不动', () => {
    const m = mount();
    const noneOnly = m.rows.filter((r) => r.trigger === PANEL_ROW_TRIGGER_NONE);
    expect(noneOnly).toHaveLength(3); // 两枚主钮 + 一枚无动作行 div
    const host = { querySelectorAll: () => noneOnly as ArrayLike<RowStub> };
    const e = event(noneOnly[0]!, 'F8');
    expect(applyPanelRowNav(host, e)).toBe(false);
    expect(e.prevented).toBe(0);
    const e2 = event(null, 'F4');
    expect(applyPanelRowNav(host, e2)).toBe(false);
    expect(e2.prevented).toBe(0);
    expect(noneOnly.every((r) => r.focused === 0 && r.clicked === 0)).toBe(true);
    // 但这截名单对 ↑↓ 照常开放（档只裁功能键，不裁名单）
    expect(applyPanelRowNav(host, event(noneOnly[0]!, 'ArrowDown'))).toBe(true);
    expect(noneOnly[1]!.focused).toBe(1);
  });

  it('面板根接线在：.panel-market 挂 ref/tabIndex=-1/onKeyDown/onFocus，键盘腿走契约层单源', () => {
    const m = mount();
    expect(m.root.props['data-context-surface']).toBe('market'); // 右键面属性零改动
    expect(m.root.props.tabIndex).toBe(-1);
    for (const leg of ['ref', 'onKeyDown', 'onFocus']) {
      expect(typeof m.root.props[leg], leg).toBe('function');
    }
    // onKeyDown 真腿：焦点不在行上按 ↓ ⇒ 进第一枚「详情」（经面板根那条函数，不是直调契约）
    pressOnRoot(m, event(null, 'ArrowDown'));
    expect(m.rows[0]!.focused).toBe(1);
    expect(m.rows[0]!.clicked).toBe(0);
    // onFocus 腿：容器焦点回来对齐漫游位（无 activeElement ⇒ 兜底第一行）
    (m.root.props.onFocus as (ev: unknown) => void)({ currentTarget: m.host });
    syncRovingTabIndexes(m.host as unknown as Parameters<typeof syncRovingTabIndexes>[0]); // 回调 ref 那一趟同样只做这件事——两条腿都幂等
    expect(m.rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('确认簇的 Esc 一个字没碰：行导航不消费不抢焦点，簇自己那条取消腿照走；簇钮不进名单', () => {
    const key = pendingKey(INSTALLED[0]!);
    const m = mount({ open: key, pending: key }); // 展开机器面 + 进入待确认卸载
    expect(m.rows).toHaveLength(5); // 展开层（.mk-detail）不是行，名单没变长
    expect(m.rows[0]!.label).toBe('收起'); // 展开态文字换了，行代表还是那一枚
    expect(m.rows.some((r) => r.label === '确认' || r.label === '取消' || r.label === '卸载' || r.label === '导入')).toBe(false);
    const e = event(m.rows[1]!, 'Escape');
    pressOnRoot(m, e);
    expect(e.prevented).toBe(0);
    expect(m.rows[1]!.focused).toBe(0); // 焦点没被行导航抢走
    // 簇自己的 Esc 腿照旧：`.mk-confirm` 上按 Esc ⇒ 只走 `onCancelUninstall`
    const cluster = findClass(m.root.props.children as ReactNode, 'mk-confirm');
    (cluster.props.onKeyDown as (ev: { key: string }) => void)({ key: 'Escape' });
    expect(m.spies.onCancelUninstall).toHaveBeenCalledTimes(1);
    expect(m.spies.onConfirmUninstall).not.toHaveBeenCalled();
  });

  it('IME 合成期一律放行；Enter/Tab/Escape/←/→ 不吞；被筛掉的行不在名单', () => {
    const m = mount();
    const e1 = event(m.rows[0]!, 'ArrowDown', { isComposing: true });
    pressOnRoot(m, e1);
    expect(e1.prevented).toBe(0);
    const e2 = event(m.rows[0]!, 'ArrowDown', { keyCode: 229 });
    pressOnRoot(m, e2);
    expect(e2.prevented).toBe(0);
    expect(m.rows[1]!.focused).toBe(0);
    for (const key of ['Enter', 'Tab', 'ArrowLeft', 'ArrowRight']) {
      const e = event(m.rows[0]!, key);
      pressOnRoot(m, e);
      expect(e.prevented, key).toBe(0); // 激活/跳出各归各家，行导航一个不吞
    }
    expect(m.spies.onInstall).not.toHaveBeenCalled();
    // 过滤态：没画出来的索引行不在名单（名单随这一屏收缩）
    const f = mount({ query: '甲包' });
    expect(f.rows.map((r) => r.label)).toEqual(['详情', '详情', '安装']);
  });
});
