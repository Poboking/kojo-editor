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
      return { ...s, [a.container]: { ...c, visible: !c.visible } };
    }
    case 'activate': {
      const c = s[a.container];
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
    case 'reconcile':
      // 封存总闸切换后面板集合增删，失效 active / 位置 override 须按新集合清洗
      return reconcileLayout(s, a.org);
    case 'reset':
      return a.state;
  }
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
  return {
    sidebar: sanitizeContainer(persisted.sidebar, dfltEff.sidebar, new Set(orgEff.views.map((v) => v.key))),
    aux: sanitizeContainer(persisted.aux, dfltEff.aux, new Set(orgEff.aux.map((p) => p.id))),
    bottom: sanitizeContainer(persisted.bottom, dfltEff.bottom, new Set(orgEff.bottom.map((p) => p.id))),
    zen: persisted.zen === true,
    // 缺省 true（定稿 §八默认限宽）；仅显式 false 关闭
    zenLimitWidth: persisted.zenLimitWidth !== false,
    panelLocations: overrides,
    floating,
  };
}
