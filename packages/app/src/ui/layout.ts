import type { PanelLocation, UIPanelContribution } from '@kojo/plugin-api';

/**
 * 壳层布局模型（2026-10-11 UI 重设计批 P1；定稿 §二/§七）。
 *
 * 纯逻辑零 React：面板编排（三容器 + group 折叠）与 localStorage 持久化在此，
 * 可单测。布局是壳层私事——存 WebView localStorage（`kojo.ui.layout.v1`，全局
 * 一份，定稿 Q3），**不进内核存储域**。
 */

/** 容器私有状态：显隐 / 尺寸 / 激活项 */
export interface ContainerState {
  visible: boolean;
  /** sidebar/aux = 宽度 px；bottom = 高度 px */
  size: number;
  /** sidebar = 视图 key（group:<名> 或 panel:<id>）；aux/bottom = 面板 id */
  active: string | null;
}

/** 浮动面板几何（视口坐标 px；宿主算初值，拖拽/缩放更新） */
export interface FloatingState {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** 浮窗最小尺寸（缩放钳制下界） */
export const MIN_FLOAT = { w: 320, h: 220 } as const;

export interface LayoutState {
  sidebar: ContainerState;
  aux: ContainerState;
  bottom: ContainerState;
  /** 全禅写作模式（定稿 §八） */
  zen: boolean;
  /** 禅模式编辑器居中限宽（~1000px；设置 overlay 可关——定稿 §八设置项） */
  zenLimitWidth: boolean;
  /** 面板位置 override（拖拽停靠 P4）：panelId → 目标容器 */
  panelLocations: Record<string, PanelLocation>;
  /** 浮动面板 id → 几何；非模态可移动浮窗，独立于三容器 */
  floating: Record<string, FloatingState>;
  /**
   * 底栏 dock 的逐面板高度记忆（VIS-13 · D-2）：panelId → 该节高度 px。
   * **可选**：缺省 = 没拖过 = 均分容器高度，旧持久化数据原样可读（不必抬版本、不必迁移）。
   * 只在 dock 里并排多份面板时才有意义——同看"问题 + 约定校验"不必再开浮窗。
   */
  bottomHeights?: Record<string, number>;
  /**
   * 底栏 dock 的并排展开集（VIS-13 · D-2）：此刻挂在 dock 里的那些面板 id。
   * **可选**：缺省（旧持久化数据里根本没这个键）= 只挂当前激活的那一颗，
   * 即改动前的单面板形态 ⇒ 老库原样可读，不抬版本、不写迁移。
   * 呈现序恒按编排结果（`organizePanels` 的 order 升序），这一份只记**在场与否**。
   */
  bottomDock?: string[];
  /**
   * 底栏折叠态（VIS-13 · D-2 判据④）：`true` = 双击 tab 条收成"只剩那一条"，
   * 面板体不挂载（内容不重渲、不占高）。**可选**：缺省 = 展开，旧数据读作展开。
   */
  bottomCollapsed?: boolean;
}

/** 侧栏视图容器：group 合并（多面板折叠堆叠）或独占（单面板） */
export interface ViewDef {
  /** `group:<名>` 或 `panel:<id>` */
  key: string;
  title: string;
  icon?: string;
  /** 组内面板（order 升序）；独占视图恒为单元素 */
  panels: UIPanelContribution[];
}

export interface OrganizedPanels {
  /** 主侧栏视图（活动栏图标序 = 组内最小 order） */
  views: ViewDef[];
  aux: UIPanelContribution[];
  bottom: UIPanelContribution[];
}

export const DEFAULT_SIDEBAR_SIZE = 260;
export const DEFAULT_AUX_SIZE = 360;
export const DEFAULT_BOTTOM_SIZE = 200;

/** 尺寸拖拽的钳制区间 */
export const SIZE_LIMITS = {
  sidebar: { min: 160, max: 520 },
  aux: { min: 240, max: 720 },
  bottom: { min: 120, max: 480 },
} as const;

export type ContainerKey = 'sidebar' | 'aux' | 'bottom';

/* ---------------- 底栏 dock（VIS-13 · D-2）的尺寸尺 ---------------- */

/** dock 里一节的**最短高度**（48px ≈ 一条头 + 两行列表；比这再矮就等于把那一格拖没了） */
export const DOCK_MIN_CELL_HEIGHT = 48;

/**
 * dock 里单颗面板节的**高度**钳制区间（区别于容器整体的 `SIZE_LIMITS.bottom`）：
 * 上界借容器上限——一格不许比整条底栏还能长，否则它会把编辑器挤没。
 */
export const DOCK_SIZE_LIMITS = { min: DOCK_MIN_CELL_HEIGHT, max: SIZE_LIMITS.bottom.max } as const;

/** 逐格高度的钳制（写进 `bottomHeights` 之前先过这道尺） */
export function clampDockHeight(px: number): number {
  return Math.min(DOCK_SIZE_LIMITS.max, Math.max(DOCK_SIZE_LIMITS.min, Math.round(px)));
}


export type LayoutAction =
  | { type: 'toggle'; container: ContainerKey }
  | { type: 'activate'; container: ContainerKey; key: string }
  | { type: 'resize'; container: ContainerKey; size: number }
  | { type: 'move'; id: string; to: PanelLocation; viewKey: string | null }
  | { type: 'toggleZen' }
  | { type: 'exitZen' }
  | { type: 'setZenLimitWidth'; value: boolean }
  | { type: 'float'; id: string; geometry: FloatingState }
  | { type: 'dock'; id: string }
  | { type: 'moveFloating'; id: string; x: number; y: number }
  | { type: 'resizeFloating'; id: string; w: number; h: number }
  /**
   * 底栏 dock：把一颗面板**并排挂进**底栏（VIS-13 · D-2）。
   * 与旧的 `activate` 区别：`activate` 只挪"哪一颗是激活项"，dock 的展开集是**叠加**的——
   * 已挂着的照旧挂着，同看"问题 + 约定校验"不必再开浮窗。
   */
  | { type: 'bottomOpen'; id: string }
  /** 底栏 dock：摘掉一颗（该格的 ✕）；摘空即收起整条底栏 */
  | { type: 'bottomClose'; id: string }
  /** 底栏 dock：逐格高度的**松手 commit**（拖拽期只写内联，见 `beginDockCellResize`） */
  | { type: 'bottomHeight'; id: string; height: number }
  /** 底栏折叠 / 展开（双击 tab 条）：`bottomCollapsed` 翻转，面板体整块挂载 / 卸载 */
  | { type: 'bottomToggleCollapse' }
  /** 封存总闸切换后面板集合增删时的再清洗（org = 新集合的编排结果） */
  | { type: 'reconcile'; org: OrganizedPanels }
  | { type: 'reset'; state: LayoutState };

export function clamp(container: ContainerKey, size: number): number {
  const lim = SIZE_LIMITS[container];
  return Math.min(lim.max, Math.max(lim.min, size));
}

export function reducer(s: LayoutState, a: LayoutAction): LayoutState {
  switch (a.type) {
    case 'toggle': {
      const c = s[a.container];
      // 底栏重新拉起来时，若 dock 已被摘空（用户把每格都关了 ⇒ 整条收起），
      // 别给出一条"只剩托盘的空底栏"：把激活那颗再挂回去。折叠态也顺手展开。
      if (a.container === 'bottom' && !c.visible && materializedDock(s).length === 0 && c.active !== null) {
        return bottomOpen(s, c.active);
      }
      return { ...s, [a.container]: { ...c, visible: !c.visible } };
    }
    case 'activate': {
      const c = s[a.container];
      if (a.container === 'bottom') {
        // 底栏的"激活"在 dock 语义里 = 把它挂进来并聚焦（已经在场的照旧在场，不互斥）
        return bottomOpen(s, a.key);
      }
      return { ...s, [a.container]: { ...c, active: a.key, visible: true } };
    }
    case 'resize': {
      const c = s[a.container];
      return { ...s, [a.container]: { ...c, size: clamp(a.container, a.size) } };
    }
    case 'move': {
      const panelLocations = { ...s.panelLocations, [a.id]: a.to };
      // 移动到目标容器并激活它；sidebar 的激活单位是视图 key
      if (a.to === 'sidebar') {
        return { ...s, panelLocations, sidebar: { ...s.sidebar, visible: true, active: a.viewKey } };
      }
      if (a.to === 'bottom') {
        // 移进底栏 = 挂进 dock（否则已展开的 dock 会把新来的这颗吞在标签条后面）
        return bottomOpen({ ...s, panelLocations }, a.id);
      }
      const c = s[a.to];
      return { ...s, panelLocations, [a.to]: { ...c, visible: true, active: a.id } };
    }
    case 'toggleZen':
      return { ...s, zen: !s.zen };
    case 'exitZen':
      return s.zen ? { ...s, zen: false } : s;
    case 'setZenLimitWidth':
      return { ...s, zenLimitWidth: a.value };
    case 'float': {
      // 已浮动 → 幂等（不覆盖既有几何）
      if (s.floating[a.id]) return s;
      return { ...s, floating: { ...s.floating, [a.id]: a.geometry } };
    }
    case 'dock': {
      if (!s.floating[a.id]) return s;
      const floating = { ...s.floating };
      delete floating[a.id];
      return { ...s, floating };
    }
    case 'moveFloating': {
      const f = s.floating[a.id];
      if (!f) return s;
      return { ...s, floating: { ...s.floating, [a.id]: { ...f, x: a.x, y: a.y } } };
    }
    case 'resizeFloating': {
      const f = s.floating[a.id];
      if (!f) return s;
      return {
        ...s,
        floating: {
          ...s.floating,
          [a.id]: { ...f, w: Math.max(MIN_FLOAT.w, a.w), h: Math.max(MIN_FLOAT.h, a.h) },
        },
      };
    }
    case 'bottomOpen':
      return bottomOpen(s, a.id);
    case 'bottomClose':
      return bottomClose(s, a.id);
    case 'bottomHeight': {
      // 松手才走到这里（拖拽期只写内联样式，见 `beginDockCellResize`）——一次 commit 一格
      const same = s.bottomHeights?.[a.id];
      const height = clampDockHeight(a.height);
      if (same === height) return s;
      return { ...s, bottomHeights: { ...s.bottomHeights, [a.id]: height } };
    }
    case 'bottomToggleCollapse':
      // 双击 tab 条：展开 ⇄ 只剩一条。这是一次手势（不是一帧一次），落一次盘而已。
      return { ...s, bottomCollapsed: s.bottomCollapsed !== true };
    case 'reconcile':
      // 封存总闸切换后面板集合增删，失效 active / 位置 override 须按新集合清洗
      return reconcileLayout(s, a.org);
    case 'reset':
      return a.state;
  }
}

/* ---------------- 底栏 dock（VIS-13 · D-2）：展开集与逐格高度 ---------------- */

/**
 * dock 里此刻该挂哪几颗（**纯函数，消费方只认这一份口径**）：
 * - `bottomDock` 有值 ⇒ 取它与"当前在场的 bottom 面板 id"的交集，**呈现序恒按传入序**
 *   （= `organizePanels` 的 order 升序）——展开集只记"在场与否"，不另存一套排序；
 * - `bottomDock` 缺省（= 旧持久化数据里根本没这个键）⇒ 只挂当前激活的那一颗，
 *   与改动前的单面板形态逐字一致；激活项已失效则挂首个在场面板；一颗都没有 ⇒ 空；
 * - 已浮动的面板由调用方从 `bottomIds` 里排除（`org` 本来就不含浮动者）。
 */
export function dockCellIds(s: LayoutState, bottomIds: readonly string[]): string[] {
  if (s.bottomDock === undefined) {
    const active = s.bottom.active;
    if (active !== null && bottomIds.includes(active)) return [active];
    return bottomIds.length > 0 ? [bottomIds[0] as string] : [];
  }
  return bottomIds.filter((id) => s.bottomDock?.includes(id) === true);
}

/** 展开集的当前内容；缺省态按旧行为物化（只有激活那一颗），好让"叠加"有个起点 */
function materializedDock(s: LayoutState): string[] {
  if (s.bottomDock !== undefined) return s.bottomDock;
  const active = s.bottom.active;
  return active === null ? [] : [active];
}

/** 展开集的**叠加**语义：已挂着的不掉（这就是"不再互斥到只剩一个"的全部机制） */
function withDockPanel(s: LayoutState, id: string): string[] {
  const cur = materializedDock(s);
  return cur.includes(id) ? cur : [...cur, id];
}

function bottomOpen(s: LayoutState, id: string): LayoutState {
  const dock = withDockPanel(s, id);
  return {
    ...s,
    bottomDock: dock,
    // 点标签即把底栏带出来，且顺手展开（折叠态下点 tab 只把面板挂进去却看不见 = 更奇怪）
    bottomCollapsed: false,
    bottom: { ...s.bottom, visible: true, active: id },
  };
}

function bottomClose(s: LayoutState, id: string): LayoutState {
  const dock = materializedDock(s).filter((x) => x !== id);
  const active = s.bottom.active;
  // 摘掉的是激活项 ⇒ 激活落到"最后挂进去的那颗"；摘空时**保留刚被摘掉那颗**当激活项——
  // 它是"用户最后看的是谁"这条记忆的唯一载体，Ctrl+J 再拉起来时要靠它把格子挂回去。
  const nextActive = active !== null && dock.includes(active) ? active : (dock[dock.length - 1] ?? active);
  return {
    ...s,
    bottomDock: dock,
    bottom: {
      ...s.bottom,
      active: nextActive,
      // 摘空 = 整条底栏收起（与旧的 ✕ 同一结局：底栏不该留一条空壳在场）
      visible: dock.length > 0 ? s.bottom.visible : false,
    },
  };
}

/* ---------------- PS-6：拖拽期的实时样式会话（零 React） ---------------- */

/**
 * 拖拽期间要写内联样式的最小元素面。刻意只声明 `style.setProperty`：真实
 * `HTMLElement` 的 `CSSStyleDeclaration` 满足它，单测传一个对象字面量即可——
 * 与本仓 `float-drag.ts` 同一套"把 DOM 依赖收成最小面、机制本身可单测"的做法。
 */
export interface LiveStyleTarget {
  readonly style: {
    setProperty(name: string, value: string): void;
  };
}

/** 容器尺寸落在 CSS 上的属性：sidebar/aux 改宽、bottom 改高（与渲染处的 style 同源） */
export function sizePropOf(container: ContainerKey): 'width' | 'height' {
  return container === 'bottom' ? 'height' : 'width';
}

/**
 * 一次尺寸拖拽的会话：`onMove` 只写内联样式，`finish` 给出松手该 commit 的尺寸。
 *
 * **为什么不进 reducer**（PS-6 第 2 项）：`dispatch({type:'resize'})` 每来一次
 * mousemove 就产出一个新 `LayoutState` ⇒ 整棵 ShellLayout 重渲染，而持久化那条
 * `useEffect(..., [layout])` 会跟着 `JSON.stringify` + 写一次 localStorage——
 * 一次两秒的拖拽 ≈ 120 次全壳重渲染 + 120 次写盘。浮窗拖拽早就用"拖拽期只写
 * inline、松手才 commit"这一招（见 ShellLayout 的 `startFloatDrag`），这里照搬。
 *
 * 没拿到元素（理论上不会发生：把手与容器同一次渲染挂载）⇒ 仍只记最新值，
 * 松手一次性 commit，退化成"拖完跳到位"，不炸也不多写盘。
 */
export interface LiveResizeSession {
  /** 一次指针移动（参数为沿拖拽轴的坐标） */
  onMove(pos: number): void;
  /** 松手：需要 commit 的尺寸（钳制后）；一次都没动 ⇒ null（零 commit、零写盘） */
  finish(): number | null;
}

export function beginLiveResize(opts: {
  target: LiveStyleTarget | undefined;
  container: ContainerKey;
  startSize: number;
  startPos: number;
  sign: 1 | -1;
}): LiveResizeSession {
  const prop = sizePropOf(opts.container);
  let last: number | null = null;
  return {
    onMove: (pos: number): void => {
      const size = clamp(opts.container, opts.startSize + opts.sign * (pos - opts.startPos));
      last = size;
      if (opts.target) opts.target.style.setProperty(prop, `${size}px`);
    },
    finish: (): number | null => last,
  };
}

/**
 * 底栏 dock 里**一颗面板节**的高度拖拽会话（VIS-13 · D-2 · 判据⑤）。
 *
 * 与 `beginLiveResize` 同一招、同一纪律：**`onMove` 只往那一格写内联 `height`，
 * 一次都不进 reducer / 不 setState**；松手 `finish()` 给出该 commit 的 px。
 * 拖一格 120 次 pointermove ⇒ 120 次内联写 + **1** 次 `LayoutState` + **1** 次写盘。
 *
 * 起手高度由调用方现场量（`el.clientHeight`）：没拖过的格子内联是空的，量到的就是
 * 容器均分给它的那份实际像素——把"均分"换算成 px 的活儿留给浏览器，不在这里猜。
 */
export function beginDockCellResize(opts: {
  target: LiveStyleTarget | undefined;
  startHeight: number;
  startPos: number;
  sign?: 1 | -1;
  /** 现场量的可用高度上限（拖不过底栏自己那条身位）；缺省 = 容器上限 480 */
  maxPx?: number;
}): LiveResizeSession {
  const sign = opts.sign ?? 1;
  const max = Math.min(DOCK_SIZE_LIMITS.max, Math.max(DOCK_SIZE_LIMITS.min, opts.maxPx ?? DOCK_SIZE_LIMITS.max));
  let last: number | null = null;
  return {
    onMove: (pos: number): void => {
      const raw = opts.startHeight + sign * (pos - opts.startPos);
      const height = Math.min(max, Math.max(DOCK_SIZE_LIMITS.min, Math.round(raw)));
      last = height;
      if (opts.target) opts.target.style.setProperty('height', `${height}px`);
    },
    finish: (): number | null => last,
  };
}

/** 侧栏分栏的最小权重（与旧实现同值：再小就等于把那一栏拖没了） */
export const MIN_SPLIT_WEIGHT = 0.4;

/**
 * 侧栏分栏把手的拖拽会话：与容器尺寸同一招——拖拽期只写两节的 `flex-grow`，
 * 松手才把新权重 commit 给 React（旧实现每次 mousemove `setSplitWeights` ⇒ 整壳重渲染）。
 *
 * 守恒口径与旧实现逐字相同：`totalW` 用**起手时**的权重和、位移按容器高度换算成权重，
 * 只动被把手夹住的相邻两节，其余权重原样带着走。
 */
/** 分栏拖拽会话：与 `LiveResizeSession` 同形，只是产物是整条权重数组 */
export interface SplitResizeSession {
  onMove(pos: number): void;
  /** 松手：要 commit 的新权重；一次都没动 ⇒ null */
  finish(): number[] | null;
}

export function beginSplitResize(opts: {
  targets: readonly (LiveStyleTarget | undefined)[];
  weights: readonly number[];
  index: number;
  totalPx: number;
  startPos: number;
}): SplitResizeSession {
  const cur = [...opts.weights];
  const totalW = cur.reduce((a, b) => a + b, 0);
  const wA = cur[opts.index] ?? 1;
  const wB = cur[opts.index + 1] ?? 1;
  const sum = wA + wB;
  let next: number[] | null = null;
  return {
    onMove: (pos: number): void => {
      const d = ((pos - opts.startPos) / opts.totalPx) * totalW;
      const newA = Math.min(sum - MIN_SPLIT_WEIGHT, Math.max(MIN_SPLIT_WEIGHT, wA + d));
      next = [...cur];
      next[opts.index] = newA;
      next[opts.index + 1] = sum - newA;
      const a = opts.targets[0];
      const b = opts.targets[1];
      if (a) a.style.setProperty('flex-grow', String(newA));
      if (b) b.style.setProperty('flex-grow', String(sum - newA));
    },
    finish: (): number[] | null => next,
  };
}

const LAYOUT_KEY = 'kojo.ui.layout.v1';

function orderOf(p: UIPanelContribution): number {
  return p.order ?? 0;
}

function byOrder(a: UIPanelContribution, b: UIPanelContribution): number {
  return orderOf(a) - orderOf(b);
}

/** 面板有效归属：拖拽 override 优先，其次贡献声明，缺省 sidebar（旧行为） */
export function effectiveLocation(
  p: UIPanelContribution,
  overrides: Record<string, PanelLocation>,
): PanelLocation {
  return overrides[p.id] ?? p.location ?? 'sidebar';
}

/**
 * 游戏域面板闸的映射来源（2026-10-20 UI 修复批）：`game.adapter` 槽的贡献 → 
 * 「贡献方插件 id → 它认的游戏 id」。宿主现取槽位后原样喂给 `filterGameScopedPanels`。
 */
export function gameScopeByPlugin(
  adapters: readonly { pluginId?: string; adapter: { gameId: string } }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of adapters) {
    if (c.pluginId) map.set(c.pluginId, c.adapter.gameId);
  }
  return map;
}

/**
 * 游戏域面板闸（2026-10-20 UI 修复批：活动栏出现两枚「工作区」图标）。
 *
 * 现象：`ui.panel` 面板按**贡献方插件**带游戏归属——两个 adapter 各注册一枚
 * 「我的口上项目」（共享层只给窗口实现，落点/向导归各游戏），并装后它们无 `group`
 * ⇒ 各自独占一枚活动栏图标，而两者 icon / title 逐字相同 ⇒ 用户看到两枚同样的图标。
 * 另一游戏的面板在本项目上不只是多余：落点不同（eraTW 铺角色个人口上目录、
 * 另一个游戏铺游戏根子树）⇒ 拿错那枚去部署会把文件铺错层。
 *
 * 判据是 **pluginId → gameId 的映射**（宿主现取 `game.adapter` 槽），不是游戏名：
 * 本函数零游戏知识。`activeGameId` 为 null（未知/无项目）时不过闸，行为与改动前逐字一致。
 */
export function filterGameScopedPanels<T extends { pluginId?: string }>(
  panels: readonly T[],
  gameByPlugin: ReadonlyMap<string, string>,
  activeGameId: string | null,
): T[] {
  if (activeGameId === null) return [...panels];
  return panels.filter((p) => {
    const owner = p.pluginId;
    if (!owner) return true;
    const gameId = gameByPlugin.get(owner);
    // 没有 gameId ⇒ 贡献方不是 adapter（游戏无关插件 / 壳层内建视图）：照旧可见
    return gameId === undefined || gameId === activeGameId;
  });
}

/**
 * 面板编排：把 `ui.panel` 贡献按 location 分到三容器；sidebar 内按 group 合并
 * 为视图（同组共享一枚活动栏图标，图标/标题取组内 order 最小者——定稿 §三）。
 * 未迁移面板（无 location）按缺省进 sidebar 独占视图——任何中间态都可运行。
 */
export function organizePanels(
  panels: readonly UIPanelContribution[],
  overrides: Record<string, PanelLocation>,
): OrganizedPanels {
  const sidebar: UIPanelContribution[] = [];
  const aux: UIPanelContribution[] = [];
  const bottom: UIPanelContribution[] = [];
  for (const p of panels) {
    const loc = effectiveLocation(p, overrides);
    if (loc === 'aux') aux.push(p);
    else if (loc === 'bottom') bottom.push(p);
    else sidebar.push(p);
  }
  sidebar.sort(byOrder);
  aux.sort(byOrder);
  bottom.sort(byOrder);

  const groups = new Map<string, UIPanelContribution[]>();
  const standalone: UIPanelContribution[] = [];
  for (const p of sidebar) {
    if (p.group) {
      const arr = groups.get(p.group);
      if (arr) arr.push(p);
      else groups.set(p.group, [p]);
    } else {
      standalone.push(p);
    }
  }
  const views: ViewDef[] = [];
  for (const [group, members] of groups) {
    const head = members[0];
    if (!head) continue;
    views.push({ key: `group:${group}`, title: head.title, ...(head.icon ? { icon: head.icon } : {}), panels: members });
  }
  for (const p of standalone) {
    views.push({ key: `panel:${p.id}`, title: p.title, ...(p.icon ? { icon: p.icon } : {}), panels: [p] });
  }
  views.sort((a, b) => {
    const pa = a.panels[0];
    const pb = b.panels[0];
    return (pa ? orderOf(pa) : 0) - (pb ? orderOf(pb) : 0);
  });
  return { views, aux, bottom };
}

/** 默认激活项：视图取首个含 defaultActive!==false 面板者；aux/bottom 同理取面板 */
export function defaultActiveOf(org: OrganizedPanels): Pick<LayoutState, 'sidebar' | 'aux' | 'bottom'> {
  const activeView =
    org.views.find((v) => v.panels.some((p) => p.defaultActive !== false))?.key ?? org.views[0]?.key ?? null;
  const activeAux = org.aux.find((p) => p.defaultActive !== false)?.id ?? org.aux[0]?.id ?? null;
  const activeBottom = org.bottom.find((p) => p.defaultActive !== false)?.id ?? org.bottom[0]?.id ?? null;
  return {
    sidebar: { visible: true, size: DEFAULT_SIDEBAR_SIZE, active: activeView },
    aux: { visible: false, size: DEFAULT_AUX_SIZE, active: activeAux },
    bottom: { visible: false, size: DEFAULT_BOTTOM_SIZE, active: activeBottom },
  };
}

export function defaultLayout(org: OrganizedPanels): LayoutState {
  return { ...defaultActiveOf(org), zen: false, zenLimitWidth: true, panelLocations: {}, floating: {} };
}

/**
 * 读取持久化布局。防御性解析：损坏/缺字段一律回落默认（布局状态是易失偏好，
 * 绝不因坏数据阻塞启动）。激活项可能指向已注销的面板/视图——消费方需校验
 * 存在性（`ensureActiveValid`）。
 */
export function loadLayout(): Partial<LayoutState> | null {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Partial<LayoutState>;
  } catch {
    return null;
  }
}

export function saveLayout(state: LayoutState): void {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(state));
  } catch {
    // localStorage 不可用（隐私模式等）→ 布局不持久化，不阻塞
  }
}

/** 「重置布局」命令：清持久化，回落默认 */
export function resetLayout(): void {
  try {
    globalThis.localStorage?.removeItem(LAYOUT_KEY);
  } catch {
    // 同上
  }
}

function sanitizeContainer(
  c: Partial<ContainerState> | undefined,
  dflt: ContainerState,
  validActives: ReadonlySet<string>,
): ContainerState {
  if (!c || typeof c !== 'object') return dflt;
  const active = typeof c.active === 'string' && validActives.has(c.active) ? c.active : dflt.active;
  return {
    visible: typeof c.visible === 'boolean' ? c.visible : dflt.visible,
    size: typeof c.size === 'number' && c.size > 0 ? c.size : dflt.size,
    active,
  };
}

/** 浮动几何规范化：数值非法回落缺省；w/h 各自不小于 MIN_FLOAT */
function sanitizeFloating(f: Partial<FloatingState>): FloatingState {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    x: num(f.x, 0),
    y: num(f.y, 0),
    w: Math.max(MIN_FLOAT.w, num(f.w, 640)),
    h: Math.max(MIN_FLOAT.h, num(f.h, 480)),
  };
}

/**
 * 合并持久化状态与当前面板集合：持久化的激活项可能已失效（插件卸载），
 * 位置 override 可能指向已注销面板——以当前贡献为准清洗。
 */
export function reconcileLayout(persisted: Partial<LayoutState> | null, org: OrganizedPanels): LayoutState {
  const dflt = defaultLayout(org);
  if (!persisted) return dflt;
  const viewKeys = new Set(org.views.map((v) => v.key));
  const auxIds = new Set(org.aux.map((p) => p.id));
  const bottomIds = new Set(org.bottom.map((p) => p.id));
  const allIds = new Set([...auxIds, ...bottomIds, ...org.views.flatMap((v) => v.panels.map((p) => p.id))]);

  const floating: Record<string, FloatingState> = {};
  if (persisted.floating && typeof persisted.floating === 'object') {
    for (const [id, f] of Object.entries(persisted.floating)) {
      if (allIds.has(id) && f && typeof f === 'object') floating[id] = sanitizeFloating(f);
    }
  }

  const overrides: Record<string, PanelLocation> = {};
  if (persisted.panelLocations && typeof persisted.panelLocations === 'object') {
    for (const [id, loc] of Object.entries(persisted.panelLocations)) {
      if (allIds.has(id) && (loc === 'sidebar' || loc === 'aux' || loc === 'bottom')) overrides[id] = loc;
    }
  }
  // override 清洗后再编排骨架（持久化数据可能与当前贡献冲突）
  const orgEff = organizePanels(
    [...org.views.flatMap((v) => v.panels), ...org.aux, ...org.bottom],
    overrides,
  );
  const dfltEff = defaultLayout(orgEff);
  const effBottomIds = orgEff.bottom.map((p) => p.id);

  /* 底栏 dock 的三格新字段（VIS-13 · D-2）——**全部可选**：旧持久化串里本来就没有它们，
     这里刻意保持 `undefined`（而不是写回一个"看起来一样"的空值），于是 `dockCellIds`
     照旧走缺省态"只挂激活那颗"，与改动前的底栏逐字一致。不抬版本、不写迁移。 */
  const dock =
    persisted.bottomDock === undefined
      ? undefined
      : effBottomIds.filter((id) => persisted.bottomDock?.includes(id) === true);
  const heights: Record<string, number> = {};
  if (persisted.bottomHeights && typeof persisted.bottomHeights === 'object') {
    for (const [id, px] of Object.entries(persisted.bottomHeights)) {
      // 只留"当前确实在底栏在场、且值像个正像素"的格；脏值（非有限 / ≤0 / 非数）与注销面板一并丢
      if (effBottomIds.includes(id) && typeof px === 'number' && Number.isFinite(px) && px > 0) {
        heights[id] = clampDockHeight(px);
      }
    }
  }
  const hasHeights = Object.keys(heights).length > 0;
  return {
    sidebar: sanitizeContainer(persisted.sidebar, dfltEff.sidebar, new Set(orgEff.views.map((v) => v.key))),
    aux: sanitizeContainer(persisted.aux, dfltEff.aux, new Set(orgEff.aux.map((p) => p.id))),
    bottom: sanitizeContainer(persisted.bottom, dfltEff.bottom, new Set(orgEff.bottom.map((p) => p.id))),
    zen: persisted.zen === true,
    // 缺省 true（定稿 §八默认限宽）；仅显式 false 关闭
    zenLimitWidth: persisted.zenLimitWidth !== false,
    panelLocations: overrides,
    floating,
    ...(dock === undefined ? {} : { bottomDock: dock }),
    ...(hasHeights ? { bottomHeights: heights } : {}),
    // 折叠态同口径：只有显式 `true` 才带上（缺省 = 展开，旧数据一律读作展开）
    ...(persisted.bottomCollapsed === true ? { bottomCollapsed: true } : {}),
  };
}
