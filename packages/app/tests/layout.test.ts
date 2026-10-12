import { afterEach, describe, expect, it } from 'vitest';
import type { UIPanelContribution } from '@kojo/plugin-api';
import {
  DEFAULT_AUX_SIZE,
  DEFAULT_BOTTOM_SIZE,
  DEFAULT_SIDEBAR_SIZE,
  defaultLayout,
  effectiveLocation,
  loadLayout,
  organizePanels,
  reconcileLayout,
  reducer,
  resetLayout,
  saveLayout,
  SIZE_LIMITS,
  type LayoutState,
} from '../src/ui/layout';

/**
 * 壳层布局模型单测（2026-10-12 审阅补测批）。
 *
 * 布局是**壳层私事**（localStorage，不进内核存储域），但它的编排与清洗规则是
 * 面板迁移的契约面：未迁移面板（无 location）必须仍进 sidebar，持久化的失效
 * 激活项/失效 override 必须以**当前贡献**为准清洗——任何中间态都要可运行。
 */

function panel(id: string, extra: Partial<UIPanelContribution> = {}): UIPanelContribution {
  return { id, title: id, component: () => null, ...extra };
}

/** 最小 Storage 替身（node 环境无 localStorage；只实现被测代码用到的三个方法） */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

/**
 * 安装 localStorage 替身。用 `defineProperty` 而非直接赋值/`delete`——Node 22+ 可能
 * 自带（实验性）`localStorage` 全局，直接 `delete` 在严格模式下会抛 TypeError。
 */
function installStorage(s: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
}

afterEach(() => {
  installStorage(fakeStorage());
});

describe('归属判定', () => {
  it('override 优先于贡献声明，缺省 = sidebar（旧行为）', () => {
    const p = panel('a', { location: 'aux' });
    expect(effectiveLocation(p, {})).toBe('aux');
    expect(effectiveLocation(p, { a: 'bottom' })).toBe('bottom');
    expect(effectiveLocation(panel('b'), {})).toBe('sidebar');
  });
});

describe('面板编排', () => {
  it('按 location 分入三容器，未迁移面板回落 sidebar（中间态可运行）', () => {
    const org = organizePanels(
      [
        panel('legacy'),
        panel('aux1', { location: 'aux' }),
        panel('bottom1', { location: 'bottom' }),
      ],
      {},
    );
    expect(org.views.map((v) => v.key)).toEqual(['panel:legacy']);
    expect(org.aux.map((p) => p.id)).toEqual(['aux1']);
    expect(org.bottom.map((p) => p.id)).toEqual(['bottom1']);
  });

  it('同 group 合并为单个视图：活动栏一枚图标，组内按 order 升序堆叠', () => {
    const org = organizePanels(
      [
        panel('fnTree', { group: 'explorer', order: 20, title: '函数树', icon: 'ƒ' }),
        panel('files', { group: 'explorer', order: 10, title: '口上文件', icon: '🗀' }),
        panel('other', { order: 5 }),
      ],
      {},
    );
    expect(org.views.map((v) => v.key)).toEqual(['panel:other', 'group:explorer']);
    const explorer = org.views.find((v) => v.key === 'group:explorer');
    // 组内升序（files 10 在 fnTree 20 前）；视图标题/图标取组内 order 最小者
    expect(explorer?.panels.map((p) => p.id)).toEqual(['files', 'fnTree']);
    expect(explorer?.title).toBe('口上文件');
    expect(explorer?.icon).toBe('🗀');
  });

  it('视图序 = 组内最小 order（组与独占面板混排时仍单调）', () => {
    const org = organizePanels(
      [panel('a', { order: 30 }), panel('b', { group: 'g', order: 1 }), panel('c', { group: 'g', order: 2 })],
      {},
    );
    expect(org.views.map((v) => v.key)).toEqual(['group:g', 'panel:a']);
  });

  it('override 改变归属后，编排结果随之改变（拖拽停靠的数据基础）', () => {
    const panels = [panel('a'), panel('b')];
    const before = organizePanels(panels, {});
    expect(before.views).toHaveLength(2);
    const after = organizePanels(panels, { a: 'aux' });
    expect(after.views.map((v) => v.key)).toEqual(['panel:b']);
    expect(after.aux.map((p) => p.id)).toEqual(['a']);
  });
});

describe('默认布局', () => {
  it('sidebar 恒可见，aux/bottom 默认不可见（不抢首屏）', () => {
    const st = defaultLayout(organizePanels([panel('a')], {}));
    expect(st.sidebar).toEqual({ visible: true, size: DEFAULT_SIDEBAR_SIZE, active: 'panel:a' });
    expect(st.aux).toEqual({ visible: false, size: DEFAULT_AUX_SIZE, active: null });
    expect(st.bottom).toEqual({ visible: false, size: DEFAULT_BOTTOM_SIZE, active: null });
    expect(st.zen).toBe(false);
    expect(st.panelLocations).toEqual({});
  });

  it('激活项跳过 defaultActive:false 的低频面板（代之以首个可激活项）', () => {
    const org = organizePanels(
      [
        panel('lift', { location: 'aux', defaultActive: false, order: 1 }),
        panel('preview', { location: 'aux', order: 2 }),
        panel('conv', { location: 'bottom', defaultActive: false, order: 1 }),
      ],
      {},
    );
    const st = defaultLayout(org);
    expect(st.aux.active).toBe('preview');
    // 全为低频时退回首个（容器打开仍需有内容）
    expect(st.bottom.active).toBe('conv');
  });

  it('视图激活项跳过「组内全为低频」的视图', () => {
    const org = organizePanels(
      [panel('lo', { group: 'g', defaultActive: false }), panel('hi', { order: 9 })],
      {},
    );
    expect(defaultLayout(org).sidebar.active).toBe('panel:hi');
  });
});

describe('持久化', () => {
  const state = (): LayoutState => ({
    sidebar: { visible: false, size: 300, active: 'panel:a' },
    aux: { visible: true, size: 400, active: 'b' },
    bottom: { visible: false, size: 150, active: null },
    zen: true,
    zenLimitWidth: true,
    panelLocations: { a: 'aux' },
  });

  it('存 → 读 round-trip；localStorage 不可用时静默降级为 null', () => {
    // 空存储 → null（首启无布局）；localStorage 整体不可用时同样回落 null，不抛
    expect(loadLayout()).toBeNull();
    installStorage(fakeStorage());
    saveLayout(state());
    expect(loadLayout()).toEqual(state());
  });

  it('重置布局清除持久化（回落默认）', () => {
    installStorage(fakeStorage());
    saveLayout(state());
    resetLayout();
    expect(loadLayout()).toBeNull();
  });

  it('坏数据（非 JSON / 非对象）回落 null，不阻塞启动', () => {
    const s = fakeStorage();
    installStorage(s);
    s.setItem('kojo.ui.layout.v1', '{不是 JSON');
    expect(loadLayout()).toBeNull();
    s.setItem('kojo.ui.layout.v1', '"字符串"');
    expect(loadLayout()).toBeNull();
  });
});

describe('持久化状态与当前贡献的清洗', () => {
  const panels = [
    panel('files', { group: 'explorer', order: 10 }),
    panel('fnTree', { group: 'explorer', order: 20 }),
    panel('lift', { location: 'aux', defaultActive: false }),
    panel('conv', { location: 'bottom' }),
  ];

  it('无持久化 → 默认布局', () => {
    const st = reconcileLayout(null, organizePanels(panels, {}));
    expect(st.sidebar.active).toBe('group:explorer');
    expect(st.aux.active).toBe('lift');
  });

  it('失效激活项（插件卸载/组名变更）回落默认，不指向不存在的容器内容', () => {
    const st = reconcileLayout(
      {
        sidebar: { visible: true, size: 300, active: 'group:已卸载' },
        aux: { visible: true, size: 400, active: '不存在的面板' },
        bottom: { visible: true, size: 150, active: 'conv' },
        zen: false,
        panelLocations: {},
      },
      organizePanels(panels, {}),
    );
    expect(st.sidebar.active).toBe('group:explorer');
    expect(st.aux.active).toBe('lift');
    expect(st.bottom.active).toBe('conv'); // 有效项保留
    expect(st.bottom.visible).toBe(true);
  });

  it('panelLocations 里指向已注销面板 / 非法容器的条目被丢弃', () => {
    const st = reconcileLayout(
      {
        panelLocations: { 幽灵面板: 'aux', files: 'bottom', conv: '侧栏' as never },
      },
      organizePanels(panels, {}),
    );
    expect(st.panelLocations).toEqual({ files: 'bottom' });
  });

  it('override 生效后再编排：被移走的组员令其原视图随之变化', () => {
    const st = reconcileLayout(
      { panelLocations: { fnTree: 'aux' } },
      organizePanels(panels, {}),
    );
    expect(st.panelLocations).toEqual({ fnTree: 'aux' });
    // 组内只剩 files → 视图仍在 sidebar，但 fnTree 已不在 sidebar 集合里
    const orgEff = organizePanels(panels, st.panelLocations);
    expect(orgEff.views.find((v) => v.key === 'group:explorer')?.panels.map((p) => p.id)).toEqual(['files']);
    expect(orgEff.aux.map((p) => p.id).sort()).toEqual(['fnTree', 'lift']);
    // 清洗后的 aux 激活项必须落在清洗后的 aux 集合内
    expect(orgEff.aux.some((p) => p.id === st.aux.active)).toBe(true);
  });

  it('尺寸为非法值（0 / 非数字）时回落默认（脏持久化不致塌陷）', () => {
    const st = reconcileLayout(
      {
        sidebar: { visible: true, size: 0, active: 'group:explorer' },
        aux: { visible: true, size: Number.NaN, active: 'lift' },
      },
      organizePanels(panels, {}),
    );
    expect(st.sidebar.size).toBe(DEFAULT_SIDEBAR_SIZE);
    expect(st.aux.size).toBe(DEFAULT_AUX_SIZE);
  });

  it('zen 只在显式 true 时恢复（缺失/脏值 = 常规形态，避免启动即进禅模式）', () => {
    const org = organizePanels(panels, {});
    expect(reconcileLayout({ zen: true }, org).zen).toBe(true);
    expect(reconcileLayout({}, org).zen).toBe(false);
    expect(reconcileLayout({ zen: 'yes' as never }, org).zen).toBe(false);
  });
});
/**
 * 设置页三个开关背后的 reducer（2026-10-13 设置页归一批搬来并可测）。
 *
 * 之前 `reducer` 内联在 `ShellLayout.tsx` 里，设置页改的就是这几个动作，
 * 却**没有任何一条测试**——审阅补测批覆盖了编排/清洗，唯独漏了动作本体。
 * 现在它住在 `layout.ts`（依赖的 `SIZE_LIMITS` / `LayoutState` 本来就在这儿），
 * 于是"设置项按下去到底改变了什么"变得可断言。
 */
describe('reducer · 设置页开关', () => {
  const base = (over: Partial<LayoutState> = {}): LayoutState => ({
    ...defaultLayout(organizePanels([panel('p1')], {})),
    ...over,
  });

  it('写作模式是**翻转**，不是置真（同一快捷键连按两次要能进出）', () => {
    const on = reducer(base({ zen: false }), { type: 'toggleZen' });
    expect(on.zen).toBe(true);
    expect(reducer(on, { type: 'toggleZen' }).zen).toBe(false);
  });

  it('exitZen 幂等：不在写作模式时返回**同一个对象引用**（不制造无谓的重渲染）', () => {
    const s = base({ zen: false });
    expect(reducer(s, { type: 'exitZen' })).toBe(s);
    expect(reducer(base({ zen: true }), { type: 'exitZen' }).zen).toBe(false);
  });

  it('居中限宽独立于写作模式存储（开回来时上次偏好还在）', () => {
    let s = base();
    s = reducer(s, { type: 'setZenLimitWidth', value: false });
    expect(s.zenLimitWidth).toBe(false);
    s = reducer(s, { type: 'toggleZen' });
    expect(s.zen).toBe(true);
    expect(s.zenLimitWidth).toBe(false);
    s = reducer(s, { type: 'exitZen' });
    expect(s.zenLimitWidth).toBe(false);
  });

  it('写作模式与居中限宽是**两个字段**，所以设置页的从属关系只是呈现，不是数据耦合', () => {
    const s = reducer(base({ zen: false, zenLimitWidth: true }), { type: 'toggleZen' });
    expect(s.zen).toBe(true);
    expect(s.zenLimitWidth).toBe(true);
  });

  it('resize 越界被夹住（设置页外的拖拽路径，顺带守住 SIZE_LIMITS）', () => {
    expect(reducer(base(), { type: 'resize', container: 'sidebar', size: 99999 }).sidebar.size).toBe(
      SIZE_LIMITS.sidebar.max,
    );
    expect(reducer(base(), { type: 'resize', container: 'sidebar', size: 1 }).sidebar.size).toBe(
      SIZE_LIMITS.sidebar.min,
    );
    expect(reducer(base(), { type: 'resize', container: 'bottom', size: 1 }).bottom.size).toBe(
      SIZE_LIMITS.bottom.min,
    );
  });

  it('reset 整份替换为传入状态（重置布局按钮的语义）', () => {
    const fresh = base({ zen: true });
    const out = reducer(base({ zen: false }), { type: 'reset', state: fresh });
    expect(out).toBe(fresh);
  });
});
