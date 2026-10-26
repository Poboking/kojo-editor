/**
 * 底栏 dock（VIS-13 · D-2 · 车道 D2）判据。
 *
 * 四条尺，一条一把：
 * ① **并排 ≥2 份**：dock 的展开集是叠加的，同看"问题 + 约定校验"不必再开浮窗；
 * ② **逐格高度记忆读写**：`bottomHeights` 存得进、读得出、钳得住，拖拽仍守零重渲纪律；
 * ③ **旧数据兼容**：一份没有这三个新字段的旧 localStorage 串必须原样可读
 *    （不抬 layout 版本、不写迁移，缺省态 = 改动前的单面板形态）；
 * ④ **双击 tab 条折叠**：底栏收成只剩那一条。
 *
 * 默认 node 环境：几何与编排是纯逻辑；DOM 那半用 `renderToStaticMarkup`（静态串足够
 * 验"并排挂了几格 / 一条头长什么样"，不需要真浏览器）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { UIPanelContribution } from '@kojo/plugin-api';
import {
  DEFAULT_BOTTOM_SIZE,
  DOCK_SIZE_LIMITS,
  beginDockCellResize,
  clampDockHeight,
  defaultLayout,
  dockCellIds,
  organizePanels,
  reconcileLayout,
  reducer,
  saveLayout,
  loadLayout,
  type LayoutState,
  type LiveStyleTarget,
} from '../src/ui/layout';
import { BottomDock, DOCK_COUNT_SOURCES } from '../src/ui/bottom-dock';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

function panel(id: string, extra: Partial<UIPanelContribution> = {}): UIPanelContribution {
  return { id, title: id, component: () => null, ...extra };
}

/** 底栏在场的四颗（序 = order 升序）：问题 / 约定校验就是清单点名的那一双 */
const BOTTOM = [
  panel('kojo.problems', { location: 'bottom', order: 1 }),
  panel('kojo.convention', { location: 'bottom', order: 2 }),
  panel('kojo.preview', { location: 'bottom', order: 3 }),
  panel('kojo.sugar', { location: 'bottom', order: 4 }),
];
const IDS = BOTTOM.map((p) => p.id);

function state(patch: Partial<LayoutState> = {}): LayoutState {
  return { ...defaultLayout(organizePanels(BOTTOM, {})), ...patch };
}

/* ---------------- ① 并排 ≥2 份：展开集是叠加的 ---------------- */

describe('dock 展开集：并排挂 ≥2 颗，点标签不再互斥', () => {
  it('连开两颗 ⇒ 两颗都在场（旧形态这里是"后者把前者顶掉"）', () => {
    let s = state();
    s = reducer(s, { type: 'bottomOpen', id: 'kojo.problems' });
    s = reducer(s, { type: 'bottomOpen', id: 'kojo.convention' });
    expect(s.bottomDock).toEqual(['kojo.problems', 'kojo.convention']);
    expect(dockCellIds(s, IDS)).toHaveLength(2);
  });

  it('`activate`（点标签 / 命令 workbench.problems / 状态栏那颗走的都是它）在底栏即叠加，别颗不掉', () => {
    let s = state({ bottomDock: ['kojo.problems'], bottom: { visible: true, size: 200, active: 'kojo.problems' } });
    s = reducer(s, { type: 'activate', container: 'bottom', key: 'kojo.convention' });
    expect(dockCellIds(s, IDS)).toEqual(['kojo.problems', 'kojo.convention']);
    expect(s.bottom.active).toBe('kojo.convention');
    expect(s.bottom.visible).toBe(true);
  });

  it('重复开同一颗是幂等的（不产生第二格）', () => {
    const s = reducer(state({ bottomDock: ['kojo.problems'] }), { type: 'bottomOpen', id: 'kojo.problems' });
    expect(s.bottomDock).toEqual(['kojo.problems']);
  });

  it('呈现序恒按编排序，与"谁先进来"无关（展开集只记在场与否，不另存一套排序）', () => {
    let s = state(); // 缺省态：激活就是编排序第一的那颗
    s = reducer(s, { type: 'bottomOpen', id: 'kojo.sugar' });
    s = reducer(s, { type: 'bottomOpen', id: 'kojo.preview' });
    expect(s.bottomDock).toEqual(['kojo.problems', 'kojo.sugar', 'kojo.preview']);
    // order 升序 = problems(1) → preview(3) → sugar(4)，与上面的记账序截然不同
    expect(dockCellIds(s, IDS)).toEqual(['kojo.problems', 'kojo.preview', 'kojo.sugar']);
  });

  it('摘掉一格：激活落到尾巴；摘空 = 整条底栏收起（不留空壳在场）', () => {
    let s = state({ bottom: { visible: true, size: 200, active: 'kojo.problems' }, bottomDock: IDS.slice(0, 2) });
    s = reducer(s, { type: 'bottomClose', id: 'kojo.problems' });
    expect(dockCellIds(s, IDS)).toEqual(['kojo.convention']);
    expect(s.bottom.active).toBe('kojo.convention');
    expect(s.bottom.visible).toBe(true);
    s = reducer(s, { type: 'bottomClose', id: 'kojo.convention' });
    expect(dockCellIds(s, IDS)).toEqual([]);
    expect(s.bottom.visible).toBe(false);
  });

  it('浮出去的那颗自动离席；停靠回来又回到原来的位置', () => {
    const geo = { x: 10, y: 10, w: 640, h: 480 };
    let s = state({ bottomDock: IDS.slice(0, 2), bottom: { visible: true, size: 200, active: 'kojo.convention' } });
    s = reducer(s, { type: 'float', id: 'kojo.convention', geometry: geo });
    // org 排除浮动者 ⇒ 传给 dockCellIds 的在场清单里没有它
    expect(dockCellIds(s, ['kojo.problems', 'kojo.preview'])).toEqual(['kojo.problems']);
    const docked = reducer(s, { type: 'dock', id: 'kojo.convention' });
    expect(dockCellIds(docked, IDS)).toEqual(['kojo.problems', 'kojo.convention']);
  });

  it('拖进底栏（move to bottom）同样挂进展开集，不是只记一个 override', () => {
    const s = reducer(state({ bottomDock: ['kojo.problems'] }), {
      type: 'move',
      id: 'kojo.preview',
      to: 'bottom',
      viewKey: null,
    });
    expect(dockCellIds(s, IDS)).toEqual(['kojo.problems', 'kojo.preview']);
  });

  it('把每格都摘光 ⇒ 整条收起；Ctrl+J 再拉起来时激活那颗回场（不给一条只剩托盘的空底栏）', () => {
    let s = state({ bottom: { visible: true, size: 200, active: 'kojo.problems' }, bottomDock: ['kojo.problems'] });
    s = reducer(s, { type: 'bottomClose', id: 'kojo.problems' });
    expect(s.bottom.visible).toBe(false);
    s = reducer(s, { type: 'toggle', container: 'bottom' });
    expect(s.bottom.visible).toBe(true);
    expect(dockCellIds(s, IDS)).toEqual(['kojo.problems']);
    expect(s.bottomCollapsed).toBe(false);
    // 尺寸这条腿始终没被 dock 的账碰过
    expect(s.bottom.size).toBe(200);
  });

  it('dock 里还挂着东西时，toggle 只翻显隐（不擅自加格也不减格）', () => {
    const s = reducer(state({ bottom: { visible: false, size: 200, active: 'kojo.problems' }, bottomDock: IDS.slice(0, 2) }), {
      type: 'toggle',
      container: 'bottom',
    });
    expect(s.bottom.visible).toBe(true);
    expect(s.bottomDock).toEqual(['kojo.problems', 'kojo.convention']);
  });

  it('aux / sidebar 的 toggle 一个字都不受影响（dock 是底栏的私事）', () => {
    const s = reducer(state({ bottomDock: [] }), { type: 'toggle', container: 'aux' });
    expect(s.bottomDock).toEqual([]);
    expect('bottomCollapsed' in s).toBe(false);
  });
});

/* ---------------- ③ 缺省态 = 改动前的单面板形态 ---------------- */

describe('缺省态：没拖过的 dock 就是旧的那一颗', () => {
  it('`bottomDock` 缺省 ⇒ 只挂激活那颗（升级当天不会突然多出几格）', () => {
    const s = state({ bottom: { visible: true, size: 200, active: 'kojo.convention' } });
    expect(s.bottomDock).toBeUndefined();
    expect(dockCellIds(s, IDS)).toEqual(['kojo.convention']);
  });

  it('激活项失效（面板注销）时回落首个在场面板，一颗都没有 ⇒ 空数组', () => {
    expect(dockCellIds(state(), IDS)).toEqual(['kojo.problems']);
    expect(dockCellIds(state(), [])).toEqual([]);
  });

  it('首次 open 会把缺省态那一颗物化进展开集（叠加的起点不是"清空后重来"）', () => {
    const s = reducer(state({ bottom: { visible: false, size: 200, active: 'kojo.problems' } }), {
      type: 'bottomOpen',
      id: 'kojo.convention',
    });
    expect(s.bottomDock).toEqual(['kojo.problems', 'kojo.convention']);
  });
});

/* ---------------- ② 逐格高度记忆 ---------------- */

describe('bottomHeights：存得进、钳得住、读得出', () => {
  it('commit 一格只动那一格，别格与原状态互不牵连', () => {
    const before = state();
    const s = reducer(before, { type: 'bottomHeight', id: 'kojo.problems', height: 140 });
    expect(s.bottomHeights).toEqual({ 'kojo.problems': 140 });
    expect(s.bottom).toBe(before.bottom);
    expect(s.sidebar).toBe(before.sidebar);
  });

  it('同值重复 commit ⇒ 同一对象引用（松手落在原处不白写一次盘）', () => {
    const s = reducer(state(), { type: 'bottomHeight', id: 'kojo.problems', height: 140 });
    expect(reducer(s, { type: 'bottomHeight', id: 'kojo.problems', height: 140 })).toBe(s);
  });

  it('钳制走 dock 自己的尺（上界 = 容器上限 480，下界比容器下限还低：一格可以被压成一条）', () => {
    expect(clampDockHeight(99999)).toBe(DOCK_SIZE_LIMITS.max);
    expect(clampDockHeight(4)).toBe(DOCK_SIZE_LIMITS.min);
    expect(DOCK_SIZE_LIMITS.max).toBe(480);
    expect(DOCK_SIZE_LIMITS.min).toBeLessThan(DEFAULT_BOTTOM_SIZE);
    const s = reducer(state(), { type: 'bottomHeight', id: 'kojo.problems', height: 100000 });
    expect(s.bottomHeights?.['kojo.problems']).toBe(480);
  });

  it('存 → 读 → 清洗全链路保住逐格高度（且不带回已注销面板的读数）', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(store), configurable: true });
    const withHeights = reducer(state({ bottomDock: IDS.slice(0, 2) }), {
      type: 'bottomHeight',
      id: 'kojo.convention',
      height: 96,
    });
    saveLayout(withHeights);
    const back = reconcileLayout(loadLayout(), organizePanels(BOTTOM, {}));
    expect(back.bottomHeights).toEqual({ 'kojo.convention': 96 });
    expect(back.bottomDock).toEqual(['kojo.problems', 'kojo.convention']);

    // 约定校验面板从集合里消失 ⇒ 它那条高度记忆一并被清洗掉（不留脏读数）
    const gone = reconcileLayout(loadLayout(), organizePanels(BOTTOM.filter((p) => p.id !== 'kojo.convention'), {}));
    expect(gone.bottomHeights).toBeUndefined();
    expect(gone.bottomDock).toEqual(['kojo.problems']);
  });
});

/** 最小 Storage 替身（只实现被测代码用到的三个方法） */
function fakeStorage(map: Map<string, string>) {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
});

/* ---------------- ② 之二：拖一格仍然零重渲（PS-6 纪律不许回退） ---------------- */

describe('beginDockCellResize：120 次 pointermove ⇒ 120 次内联写 + 1 次 commit', () => {
  function fakeEl(): LiveStyleTarget & { writes: Array<[string, string]> } {
    const writes: Array<[string, string]> = [];
    return {
      writes,
      style: { setProperty: (name: string, value: string) => void writes.push([name, value]) },
    };
  }

  it('拖拽期只写内联：120 次 onMove ⇒ 120 次样式写、finish 前一个数都不给', () => {
    const el = fakeEl();
    const session = beginDockCellResize({ target: el, startHeight: 200, startPos: 1000 });
    for (let i = 1; i <= 120; i++) session.onMove(1000 + i);
    expect(el.writes).toHaveLength(120);
    expect(el.writes.every(([, v]) => v.endsWith('px'))).toBe(true);
    const height = session.finish();
    // 松手 commit 的唯一那个数 = 最后写进内联的那一条 ⇒ React 落地同坐标系，零跳变
    expect(height).toBe(320);
    expect(el.writes[119]?.[1]).toBe(`${height}px`);
  });

  it('一次两秒拖拽的读数（与 ps6 那把尺同一个口径）：旧路径 120 个新状态 + 120 次写盘 ⇒ 新路径 1 + 1', () => {
    let writes = 0;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        // 写盘计数就在这里：旧形态每帧一次 dispatch ⇒ 一次 JSON.stringify + 一次 setItem
        setItem: (k: string, v: string) => {
          writes++;
          store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
      },
      configurable: true,
    });
    const el = fakeEl();
    let s = reducer(state(), { type: 'bottomOpen', id: 'kojo.problems' });
    saveLayout(s); // 起手那一次落盘不计进拖拽的账（下面按增量算）
    const base = writes;
    const session = beginDockCellResize({ target: el, startHeight: 200, startPos: 0 });
    for (let i = 1; i <= 120; i++) {
      session.onMove(i);
      // 旧路径在这一行里是 `s = reducer(s, {type:'bottomHeight'…}); saveLayout(s)`——
      // 那会当场产出 120 个新 LayoutState + 120 次写盘。新路径两样都不做。
    }
    const height = session.finish();
    if (height !== null) {
      s = reducer(s, { type: 'bottomHeight', id: 'kojo.problems', height });
      saveLayout(s);
    }
    expect(writes - base).toBe(1);
    expect(s.bottomHeights).toEqual({ 'kojo.problems': height });
    expect(el.writes).toHaveLength(120);
  });

  it('一次都没拖 ⇒ finish 给 null（零 commit、零写盘），且一帧内联都没写', () => {
    const el = fakeEl();
    const session = beginDockCellResize({ target: el, startHeight: 200, startPos: 1000 });
    expect(session.finish()).toBeNull();
    expect(el.writes).toHaveLength(0);
  });

  it('拿不到元素（理论上不会发生）⇒ 仍只记最新值、松手给一个数，不炸', () => {
    const session = beginDockCellResize({ target: undefined, startHeight: 200, startPos: 0 });
    session.onMove(-5000);
    expect(session.finish()).toBe(DOCK_SIZE_LIMITS.min);
  });

  it('sign=-1 反着拖（把手在格子上沿的形态）照样钳制', () => {
    const session = beginDockCellResize({ target: undefined, startHeight: 100, startPos: 0, sign: -1 });
    session.onMove(4000);
    expect(session.finish()).toBe(DOCK_SIZE_LIMITS.min);
  });

  it('maxPx（现场量的 dock 面板体高）把上限压到容器身位以内：一格拖不出"比底栏还高"的越界记忆', () => {
    const session = beginDockCellResize({ target: undefined, startHeight: 120, startPos: 0, maxPx: 180 });
    session.onMove(4000);
    expect(session.finish()).toBe(180);
    // maxPx 自己也要过一遍尺：脏读数（0 / 负数 / 比 480 还高）不许把上限拖没
    expect(beginDockCellResize({ target: undefined, startHeight: 100, startPos: 0, maxPx: 0 }).finish()).toBeNull();
    const tiny = beginDockCellResize({ target: undefined, startHeight: 100, startPos: 0, maxPx: 5 });
    tiny.onMove(999);
    expect(tiny.finish()).toBe(DOCK_SIZE_LIMITS.min);
    const huge = beginDockCellResize({ target: undefined, startHeight: 100, startPos: 0, maxPx: 99999 });
    huge.onMove(99999);
    expect(huge.finish()).toBe(DOCK_SIZE_LIMITS.max);
  });
});

/* ---------------- ③ 旧持久化数据原样可读 ---------------- */

describe('旧 localStorage 串（没有 dock 三个字段）：原样可读、缺省态照旧', () => {
  /** 2026-10 之前那份真实形态：三容器 + zen + panelLocations + floating，仅此而已 */
  const OLD_STRING = JSON.stringify({
    sidebar: { visible: true, size: 260, active: 'group:explorer' },
    aux: { visible: false, size: 360, active: null },
    bottom: { visible: true, size: 224, active: 'kojo.convention' },
    zen: false,
    zenLimitWidth: true,
    panelLocations: {},
    floating: {},
  });

  function withStorage(raw: string) {
    const store = new Map<string, string>([['kojo.ui.layout.v1', raw]]);
    Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(store), configurable: true });
    return loadLayout();
  }

  it('读得进来，三个 dock 字段一律 undefined（不是空值——空值会把缺省态语义改掉）', () => {
    const persisted = withStorage(OLD_STRING);
    const org = organizePanels(BOTTOM, {});
    const s = reconcileLayout(persisted, org);
    expect(s.bottom.size).toBe(224);
    expect(s.bottom.active).toBe('kojo.convention');
    expect('bottomHeights' in s).toBe(false);
    expect('bottomDock' in s).toBe(false);
    expect('bottomCollapsed' in s).toBe(false);
    // 缺省态 = 旧底栏那一颗：升级当天不会多出格子
    expect(dockCellIds(s, IDS)).toEqual(['kojo.convention']);
  });

  it('脏 dock 值（非数字 / 负数 / 未登记面板）被清洗掉，好值留下', () => {
    const org = organizePanels(BOTTOM, {});
    // 磁盘上真会出现这种东西（手改 / 旧版本 / 别的写者），清洗器吃的是 unknown 不是类型
    const dirty = {
      ...OLD_STRING_PARSE(),
      bottomDock: ['kojo.problems', 'ghost.panel'],
      bottomHeights: { 'kojo.problems': -20, 'kojo.convention': 150.4, ghost: 300, 'kojo.preview': 'x' },
      bottomCollapsed: 'yes',
    } as unknown as Partial<LayoutState>;
    const s = reconcileLayout(dirty, org);
    expect(s.bottomDock).toEqual(['kojo.problems']);
    expect(s.bottomHeights).toEqual({ 'kojo.convention': 150 });
    expect(s.bottomCollapsed).toBeUndefined();
  });

  it('显式 `bottomCollapsed: true` 才带得回来（false / 缺省都读作展开）', () => {
    const org = organizePanels(BOTTOM, {});
    expect(reconcileLayout({ bottomCollapsed: true }, org).bottomCollapsed).toBe(true);
    expect(reconcileLayout({ bottomCollapsed: false }, org).bottomCollapsed).toBeUndefined();
  });

  it('reconcile 动作（封存总闸切换）不清掉 dock 的展开集与高度记忆', () => {
    const s = state({
      bottomDock: IDS.slice(0, 2),
      bottomHeights: { 'kojo.problems': 120 },
      bottomCollapsed: true,
    });
    const next = reducer(s, { type: 'reconcile', org: organizePanels(BOTTOM, {}) });
    expect(next.bottomDock).toEqual(['kojo.problems', 'kojo.convention']);
    expect(next.bottomHeights).toEqual({ 'kojo.problems': 120 });
    expect(next.bottomCollapsed).toBe(true);
  });

  // 旧串直接摊平当 persisted 用（本用例只关心 dock 三格之外的字段不丢）
  function OLD_STRING_PARSE(): Partial<LayoutState> {
    return JSON.parse(OLD_STRING) as Partial<LayoutState>;
  }
});

/* ---------------- ④ 双击 tab 条折叠 ---------------- */

describe('折叠态：双击那一把与它收掉的东西', () => {
  it('`bottomToggleCollapse` 是翻转不是置位（连按两次回到原样）', () => {
    const s = state();
    expect(reducer(s, { type: 'bottomToggleCollapse' }).bottomCollapsed).toBe(true);
    expect(reducer(reducer(s, { type: 'bottomToggleCollapse' }), { type: 'bottomToggleCollapse' }).bottomCollapsed).toBe(
      false,
    );
  });

  it('折叠态下点标签把面板挂进来的同时把底栏展开回来（挂进去却看不见 = 更奇怪）', () => {
    const s = reducer(state({ bottomCollapsed: true }), { type: 'bottomOpen', id: 'kojo.problems' });
    expect(s.bottomCollapsed).toBe(false);
    expect(s.bottom.visible).toBe(true);
  });

  it('折叠只收面板体：展开集与高度记忆一条不动（双击回来还是那两格、还是那个高）', () => {
    const before = state({ bottomDock: IDS.slice(0, 2), bottomHeights: { 'kojo.problems': 150 } });
    const s = reducer(before, { type: 'bottomToggleCollapse' });
    expect(s.bottomDock).toEqual(before.bottomDock);
    expect(s.bottomHeights).toEqual(before.bottomHeights);
    expect(s.bottom.size).toBe(before.bottom.size);
  });

  it('接线：双击落在标签条的空白处才折叠，落在按钮上算按钮的', () => {
    const shell = read('ui/ShellLayout.tsx');
    expect(shell).toContain("dispatch({ type: 'bottomToggleCollapse' })");
    expect(shell).toMatch(/onDoubleClick: \(e: ReactMouseEvent<HTMLElement>\) => \{\s*\n\s*if \(\(e\.target as HTMLElement\)\.closest\('button'\)\) return;/);
    expect(shell).toContain("title: '双击折叠 / 展开底栏'");
    // 折叠时面板体整块不挂载（不是靠 CSS 藏起来）
    expect(shell).toMatch(/layout\.bottomCollapsed === true \? null : \(\s*<BottomDock/);
  });
});

/* ---------------- 并排的 DOM 形状（容器级一条头，不越界进面板内部） ---------------- */

function dockProps(cells: readonly UIPanelContribution[], extra: Partial<React.ComponentProps<typeof BottomDock>> = {}) {
  return {
    cells,
    activeId: cells[0]?.id ?? null,
    registerEl: () => {},
    onResizeStart: () => {},
    onFloat: () => {},
    onClose: () => {},
    ...extra,
  };
}

describe('并排 ≥2 格的渲染形状：一格一条头', () => {
  it('两格并排 ⇒ 两个 data-dock-cell、两条头、两对浮出/关闭钮', () => {
    const html = renderToStaticMarkup(createElement(BottomDock, dockProps(BOTTOM.slice(0, 2))));
    expect(html.match(/data-dock-cell="/g)).toHaveLength(2);
    expect(html.match(/class="dock-cell-head"/g)).toHaveLength(2);
    expect(html.match(/dock-cell-float/g)).toHaveLength(2);
    expect(html.match(/dock-cell-close/g)).toHaveLength(2);
    expect(html).toContain('data-dock-cell-count="2"');
    // 容器级头部只有一条：头里没有第二排（筛选槽是**空槽**，面板内部归车道 C）
    expect(html.match(/data-dock-slot="filter"/g)).toHaveLength(2);
  });

  it('激活格带 data-dock-active，非激活格不带', () => {
    const html = renderToStaticMarkup(createElement(BottomDock, dockProps(BOTTOM.slice(0, 2))));
    expect(html).toContain('data-dock-active=""');
    expect(html.match(/data-dock-active/g)).toHaveLength(1);
  });

  it('高度记忆落成内联 px + data-dock-pinned；没记忆的格子不写内联（均分由 CSS 负责）', () => {
    const html = renderToStaticMarkup(
      createElement(BottomDock, dockProps(BOTTOM.slice(0, 2), { heights: { 'kojo.convention': 140 } })),
    );
    expect(html).toContain('style="height:140px"');
    expect(html).toContain('data-dock-pinned');
    expect(html.match(/data-dock-pinned/g)).toHaveLength(1);
  });

  it('头部一行里左边是面板名（+ 登记过的计数），右边是浮出与关闭', () => {
    const html = renderToStaticMarkup(createElement(BottomDock, dockProps(BOTTOM.slice(0, 1))));
    expect(html).toContain('class="dock-cell-title"');
    // 计数只给登记过的面板：没登记的格一条读数都不占
    expect(DOCK_COUNT_SOURCES['kojo.preview']).toBeUndefined();
    expect(DOCK_COUNT_SOURCES['kojo.problems']).toBeDefined();
    expect(html).not.toContain('class="dock-cell-count"');
  });

  it('每格自带一条底沿高度把手（aria 说清调的是哪一格）', () => {
    const html = renderToStaticMarkup(createElement(BottomDock, dockProps(BOTTOM.slice(0, 2))));
    expect(html.match(/dock-cell-resizer/g)).toHaveLength(2);
    expect(html).toContain('aria-label="调整 kojo.convention 高度"');
  });
});

/* ---------------- 接线与边界（别伸进别人的面） ---------------- */

describe('静态守门', () => {
  const shell = read('ui/ShellLayout.tsx');

  it('dock 切片真被 import（不是注释里提一嘴）', () => {
    expect(shell).toContain("from './bottom-dock'");
    expect(read('ui/bottom-dock.tsx')).toContain("import './bottom-dock.css'");
  });

  it('底栏不再走"单实例互斥"那一格：container-body 已从底栏摘掉，aux 照旧用', () => {
    expect(shell).not.toMatch(/bottombar[\s\S]{0,400}className="container-body"/);
    expect(shell).toContain('{tabStrip(\'aux\', org.aux, layout.aux.active)}');
  });

  it('拖拽纪律：dock 会话与容器尺寸同一招，pointermove 里不出现 dispatch/setState', () => {
    const start = shell.indexOf('const startDockCellDrag');
    const body = shell.slice(start, start + 2200);
    expect(body).toContain('beginDockCellResize');
    expect(body).toContain("session.onMove(ev.clientY)");
    // 每帧一次 dispatch 是 PS-6 明令禁止的回退
    expect(body.slice(0, body.indexOf('const onUp'))).not.toContain('dispatch(');
  });

  it('容器不碰别人的面板内部：dock 切片里没有 ProblemPanel / SearchPanel / OutlinePanel 的 import', () => {
    const dock = read('ui/bottom-dock.tsx');
    for (const banned of ["from './ProblemPanel'", "from './SearchPanel'", "from './OutlinePanel'"]) {
      expect(dock, banned).not.toContain(banned);
    }
    // 计数只经 problem-store 的只读订阅面（不是面板组件）
    expect(dock).toContain("from './problem-store'");
  });

  it('样式切片不写字面量颜色，只吃 var()', () => {
    const css = read('ui/bottom-dock.css');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgb\(\s*\d/);
    expect(css).toContain('var(--bg-2)');
    // 靠特异性赢，不靠 import 顺序
    expect(css).toMatch(/\.bottombar \.dock-cell\s*\{/);
  });
});
