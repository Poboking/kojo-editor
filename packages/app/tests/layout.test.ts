import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { UIPanelContribution } from '@kojo/plugin-api';
import {
  DEFAULT_AUX_SIZE,
  DEFAULT_BOTTOM_SIZE,
  DEFAULT_SIDEBAR_SIZE,
  defaultLayout,
  effectiveLocation,
  filterGameScopedPanels,
  gameScopeByPlugin,
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

describe('游戏域面板闸（活动栏两枚「工作区」图标修复）', () => {
  /**
   * 实测形态：两个 adapter 各注册一枚「我的口上项目」（icon / title 逐字相同、无 group）。
   * `gameByPlugin` 由宿主从 `game.adapter` 槽现取（pluginId → gameId）。
   */
  const twins = (): UIPanelContribution[] => [
    panel('kojo-projects', { title: '我的口上项目', icon: 'home', order: 35, pluginId: 'eratw-adapter' }),
    panel('eraakumamaid-kojo-projects', {
      title: '我的口上项目',
      icon: 'home',
      order: 35,
      pluginId: 'eraakumamaid-adapter',
    }),
    // 游戏无关插件面板（无 game.adapter 贡献）
    panel('state-replay', { title: '状态回放', order: 45, pluginId: 'ui-state-replay' }),
    // 壳层内建视图（内核不知道贡献方是谁）
    panel('kojo.files', { title: '口上文件', icon: 'files', order: 30 }),
  ];
  const games = new Map([
    ['eratw-adapter', 'eratw'],
    ['eraakumamaid-adapter', 'eraakumamaid'],
  ]);

  it('eraTW 项目（adapterId=eratw）下只剩本游戏 adapter 那枚：活动栏「工作区」图标从两枚降到一枚', () => {
    const scoped = filterGameScopedPanels(twins(), games, 'eratw');
    expect(scoped.map((p) => p.id)).toEqual(['kojo-projects', 'state-replay', 'kojo.files']);
    // 编排后 sidebar 视图数 = 活动栏图标数：同图标那一枚不再出现
    expect(organizePanels(scoped, {}).views.map((v) => v.key)).toEqual([
      'panel:kojo.files',
      'panel:kojo-projects',
      'panel:state-replay',
    ]);
    // 对照：不过闸时确实有两枚同图标（这就是用户看到的现象）
    expect(organizePanels(twins(), {}).views).toHaveLength(4);
  });

  it('换成另一个游戏的项目 ⇒ 换成另一枚，仍然只有一枚', () => {
    const scoped = filterGameScopedPanels(twins(), games, 'eraakumamaid');
    expect(scoped.map((p) => p.id)).toEqual([
      'eraakumamaid-kojo-projects',
      'state-replay',
      'kojo.files',
    ]);
  });

  it('游戏无关面板与内建视图不受闸影响（无映射 / 无 pluginId 一律放行）', () => {
    const scoped = filterGameScopedPanels(twins(), games, 'eratw');
    expect(scoped.some((p) => p.id === 'state-replay')).toBe(true);
    expect(scoped.some((p) => p.id === 'kojo.files')).toBe(true);
  });

  it('activeGameId 为 null（无项目 / 旧消费方）⇒ 不过闸，行为与改动前逐字一致', () => {
    expect(filterGameScopedPanels(twins(), games, null).map((p) => p.id)).toEqual([
      'kojo-projects',
      'eraakumamaid-kojo-projects',
      'state-replay',
      'kojo.files',
    ]);
  });

  it('adapter 插件贡献但其 gameId 未登记（映射缺失）⇒ 不误杀', () => {
    const scoped = filterGameScopedPanels(twins(), new Map(), 'eratw');
    expect(scoped.map((p) => p.id)).toEqual([
      'kojo-projects',
      'eraakumamaid-kojo-projects',
      'state-replay',
      'kojo.files',
    ]);
  });

  it('映射来自 `game.adapter` 槽：贡献方插件 id → 它认的游戏 id（无 pluginId 的贡献不入表）', () => {
    const m = gameScopeByPlugin([
      { pluginId: 'eratw-adapter', adapter: { gameId: 'eratw' } },
      { pluginId: 'eraakumamaid-adapter', adapter: { gameId: 'eraakumamaid' } },
      { adapter: { gameId: 'orphan' } },
    ]);
    expect([...m.entries()]).toEqual([
      ['eratw-adapter', 'eratw'],
      ['eraakumamaid-adapter', 'eraakumamaid'],
    ]);
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
    floating: {},
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


/**
 * 写作模式限宽（P4 §八设置项）。
 *
 * 口径是**缺省即限宽**：`zenLimitWidth !== false` ⇒ 只有显式 false 才关掉。
 * 这条判据两头都会咬人——脏值当 false 处理会让多数用户的限宽无故消失，
 * 而把显式 false 洗成 true 会让设置项「关不掉」。两头都要有尺子。
 *
 * 本 describe 自带夹具，不去动上方既有 describe 的作用域。
 */
const zenPanels = [
  panel('files', { group: 'explorer', order: 10 }),
  panel('fnTree', { group: 'explorer', order: 20 }),
  panel('lift', { location: 'aux', defaultActive: false }),
  panel('conv', { location: 'bottom' }),
];

describe('写作模式限宽 zenLimitWidth', () => {
  const org = () => organizePanels(zenPanels, {});

  it('默认布局带限宽（首启不需要用户在设置页做任何事就是可读宽度）', () => {
    expect(defaultLayout(org()).zenLimitWidth).toBe(true);
  });

  it('无持久化 → 限宽为 true（缺省口径）', () => {
    expect(reconcileLayout(null, org()).zenLimitWidth).toBe(true);
    expect(reconcileLayout({}, org()).zenLimitWidth).toBe(true);
  });

  it('显式 false 必须生效（设置项「关掉」是用户意图，不能被缺省吞掉）', () => {
    expect(reconcileLayout({ zenLimitWidth: false }, org()).zenLimitWidth).toBe(false);
  });

  it('脏值（字符串 / null / undefined）回落 true，与 zen 的严格口径刻意不同', () => {
    expect(reconcileLayout({ zenLimitWidth: 'no' as never }, org()).zenLimitWidth).toBe(true);
    expect(reconcileLayout({ zenLimitWidth: null as never }, org()).zenLimitWidth).toBe(true);
    expect(reconcileLayout({ zenLimitWidth: undefined }, org()).zenLimitWidth).toBe(true);
  });

  it('存 → 读 → 清洗全链路保住 false；重置布局后回到 true', () => {
    installStorage(fakeStorage());
    saveLayout({ ...defaultLayout(org()), zenLimitWidth: false });
    expect(loadLayout()?.zenLimitWidth).toBe(false);
    expect(reconcileLayout(loadLayout(), org()).zenLimitWidth).toBe(false);
    resetLayout();
    expect(reconcileLayout(loadLayout(), org()).zenLimitWidth).toBe(true);
  });
});

/**
 * 「布局是壳层私事」这条红线的静态守门（UI 重设计定稿 §七：持久化走 WebView localStorage，
 * **不进内核存储域**）。
 *
 * 规则本身没有运行期可观测面——插件一旦哪天改成 `ctx.storage`，功能照样正常，只有源码里看得见。
 * 所以这里直接读自身源码做字面判据：少一把尺子，这条纪律就会在下一批悄悄漂走。
 */
describe('持久化归属红线（不得进内核存储域）', () => {
  const layoutSource = readFileSync(fileURLToPath(new URL('../src/ui/layout.ts', import.meta.url)), 'utf8');

  it('layout.ts 不 import 内核（只依赖 plugin-api 的类型）', () => {
    expect(layoutSource).not.toContain('@kojo/kernel');
  });

  it('layout.ts 不碰内核存储域 API', () => {
    expect(layoutSource).not.toMatch(/ctx\.storage|StorageService/);
  });

  it('持久化键就是壳层那一份 localStorage（改名等于换偏好，须显式改这里）', () => {
    expect(layoutSource).toContain("'kojo.ui.layout.v1'");
    expect(layoutSource).toContain('globalThis.localStorage');
  });
});

/** 清洗分支里此前没被任何断言走到的形状（坏数据必须回落，绝不阻塞启动） */
describe('持久化清洗的漏网分支', () => {
  it('panelLocations 不是对象（数组 / 字符串 / null）→ 全部丢弃，回落默认归属', () => {
    const org = organizePanels(zenPanels, {});
    expect(reconcileLayout({ panelLocations: ['a', 'b'] as never }, org).panelLocations).toEqual({});
    expect(reconcileLayout({ panelLocations: 'aux' as never }, org).panelLocations).toEqual({});
    expect(reconcileLayout({ panelLocations: null as never }, org).panelLocations).toEqual({});
  });

  it('整份持久化是数组 → 各字段皆缺，逐容器回落默认而不抛', () => {
    const org = organizePanels(zenPanels, {});
    expect(reconcileLayout([] as never, org)).toEqual(defaultLayout(org));
  });

  it('visible 脏值（字符串 / 数字）回落默认显隐，不让容器变成三态', () => {
    const st = reconcileLayout(
      {
        sidebar: { visible: 'yes' as never, size: 300, active: 'group:explorer' },
        aux: { visible: 1 as never, size: 300, active: 'lift' },
      },
      organizePanels(zenPanels, {}),
    );
    expect(st.sidebar.visible).toBe(true); // 默认侧栏可见
    expect(st.aux.visible).toBe(false); // 默认副侧栏隐藏
  });

  it('尺寸为负 → 回落默认（0 / NaN 已由上方用例覆盖，负值走同一判据的另一侧）', () => {
    const st = reconcileLayout(
      {
        sidebar: { visible: true, size: -240, active: 'group:explorer' },
        bottom: { visible: true, size: -1, active: 'conv' },
      },
      organizePanels(zenPanels, {}),
    );
    expect(st.sidebar.size).toBe(DEFAULT_SIDEBAR_SIZE);
    expect(st.bottom.size).toBe(DEFAULT_BOTTOM_SIZE);
  });

  it('override 指向已注销面板时整条丢弃，同批有效条目仍保留（排骨架只认当前贡献）', () => {
    const st = reconcileLayout({ panelLocations: { 幽灵: 'aux', conv: 'sidebar' } }, organizePanels(zenPanels, {}));
    expect(st.panelLocations).toEqual({ conv: 'sidebar' });
    const orgEff = organizePanels(zenPanels, st.panelLocations);
    expect(orgEff.bottom).toHaveLength(0);
    expect(orgEff.views.map((v) => v.key)).toContain('panel:conv');
  });
});
