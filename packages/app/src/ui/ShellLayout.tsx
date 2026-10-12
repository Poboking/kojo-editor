import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type { EditorCommandContext, PanelLocation, UIPanelContribution } from '@kojo/plugin-api';
import {
  SIZE_LIMITS,
  defaultLayout,
  loadLayout,
  organizePanels,
  reconcileLayout,
  resetLayout,
  saveLayout,
  type LayoutState,
  type OrganizedPanels,
  type ViewDef,
} from './layout';
import { loadSugarViewPref, saveSugarViewPref } from './sugar-view';
import {
  buildCommandRegistry,
  chordFromEvent,
  chordEquals,
  parseKeybinding,
  type ShellCommandSpec,
} from './commands';
import { CommandPalette, QuickOpen } from './Palette';
import { PanelBody, StatusbarItem } from './PanelHost';

/**
 * 壳层五区布局（2026-10-11 UI 重设计批 P1；定稿 §二）。
 *
 * 区域：顶部工具栏 / 活动栏 + 主侧栏 / 编辑器区 / 副侧栏 / 底部区 / 状态栏。
 * 壳层只懂容器语义（location / group / 显隐 / 尺寸）——零业务知识；面板内容
 * 全部来自 `ui.panel` 槽贡献 + 内建视图（口上文件树，与槽同构注入）。
 *
 * 布局状态持久化在 WebView localStorage（`kojo.ui.layout.v1`，全局一份，
 * 定稿 Q3）——内核存储域零负担。「重置布局」清持久化回落默认。
 */

export interface EditorStatusInfo {
  encoding: string;
  eol: string;
  lines: number;
}

/**
 * 壳层工作台 API（P3：编辑器区空态动作按钮用——壳层持有 picker/命令注册表，
 * 空态在 children 里，需反向取得触发入口）。
 */
export interface WorkbenchApi {
  openQuickOpen: () => void;
  openPalette: () => void;
  hasCommand: (id: string) => boolean;
  /** 执行命令（when 不满足 / 不存在 → false；抛错隔离记日志） */
  runCommand: (id: string) => boolean;
}

interface Props {
  kernel: Kernel;
  /** 壳层内建视图（与槽同构的贡献形态；如口上文件树 → group:'explorer'） */
  builtinViews: UIPanelContribution[];
  /** 编辑器区内容（只读横幅 + 编辑器/空态） */
  children: ReactNode;
  /** 写权限状态（状态栏徽章；壳层通用 chrome） */
  writable: boolean;
  onReauth: () => void;
  /** 编辑器状态（编码/EOL/行数；无打开文件时 null） */
  editorStatus: EditorStatusInfo | null;
  /** 当前文件脏态（状态栏保存态指示） */
  dirty: boolean;
  /** 索引状态（状态栏左区） */
  stats: { fileCount: number; fnCount: number; indexing: boolean; indexError: string | null };
  /** 命令执行上下文（ui.toolbar / 命令面板消费） */
  commandCtx: EditorCommandContext;
  /** 关闭项目入口（工具栏右区；欢迎页回退） */
  onCloseProject?: () => void;
  /** 重载项目入口（工具栏左区，项目标签旁） */
  onReloadProject?: () => void;
  /** 快速打开候选文件（P2；壳层泛型路径列表，零业务知识） */
  quickOpenFiles?: readonly string[];
  /** 快速打开选中回调 */
  onOpenFile?: (path: string) => void;
  /** 编辑器区注入的壳层命令（P3：关闭标签 / 全部保存；与内建布局命令合并进统一注册表） */
  extraCommands?: readonly ShellCommandSpec[];
  /** 工作台 API 注册（P3：编辑器区空态动作按钮反向取得 picker/命令入口；卸载时 null） */
  onRegisterWorkbench?: (api: WorkbenchApi | null) => void;
}

type ContainerKey = 'sidebar' | 'aux' | 'bottom';

/** 拖拽停靠的自定义 MIME（P4；只在壳层内部流转，防外部拖入误触发） */
const PANEL_DRAG_MIME = 'application/x-kojo-panel-move';

type LayoutAction =
  | { type: 'toggle'; container: ContainerKey }
  | { type: 'activate'; container: ContainerKey; key: string }
  | { type: 'resize'; container: ContainerKey; size: number }
  | { type: 'move'; id: string; to: PanelLocation; viewKey: string | null }
  | { type: 'toggleZen' }
  | { type: 'exitZen' }
  | { type: 'setZenLimitWidth'; value: boolean }
  | { type: 'reset'; state: LayoutState };

function clamp(container: ContainerKey, size: number): number {
  const lim = SIZE_LIMITS[container];
  return Math.min(lim.max, Math.max(lim.min, size));
}

function reducer(s: LayoutState, a: LayoutAction): LayoutState {
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
    case 'reset':
      return a.state;
  }
}

/** 视图在活动栏的位置：组成员全为低频（defaultActive:false）→ 底部区（定稿 §四插件状态齿轮位） */
function isLowFreqView(v: ViewDef): boolean {
  return v.panels.every((p) => p.defaultActive === false);
}

export function ShellLayout(props: Props): ReactElement {
  const {
    kernel,
    builtinViews,
    children,
    writable,
    onReauth,
    editorStatus,
    dirty,
    stats,
    commandCtx,
    onCloseProject,
    onReloadProject,
    quickOpenFiles,
    onOpenFile,
    extraCommands,
    onRegisterWorkbench,
  } = props;

  const allPanels = useMemo(
    () => [...builtinViews, ...kernel.slots.query('ui.panel')],
    [kernel, builtinViews],
  );
  const toolbarItems = useMemo(() => kernel.slots.query('ui.toolbar'), [kernel]);
  const statusbarItems = useMemo(() => kernel.slots.query('ui.statusbar'), [kernel]);
  const slotCommands = useMemo(() => kernel.slots.query('editor.command'), [kernel]);
  const overlayItems = useMemo(() => kernel.slots.query('ui.overlay'), [kernel]);

  const [layout, dispatch] = useReducer(reducer, undefined as unknown as LayoutState, () =>
    reconcileLayout(loadLayout(), organizePanels(allPanels, {})),
  );
  const org: OrganizedPanels = useMemo(
    () => organizePanels(allPanels, layout.panelLocations),
    [allPanels, layout.panelLocations],
  );

  // 持久化（壳层私事，localStorage；变更即存，体量小无需去抖）
  useEffect(() => saveLayout(layout), [layout]);

  // zen / overlay / picker 的 ref 供全局键盘读取最新值（Esc 优先级链）
  const zenRef = useRef(layout.zen);
  zenRef.current = layout.zen;

  /* -------------------- P2：命令注册表 + picker/overlay 状态 -------------------- */

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<{ id: string; payload?: unknown } | null>(null);
  const overlayRef = useRef(activeOverlay);
  overlayRef.current = activeOverlay;
  const pickerRef = useRef(false);
  pickerRef.current = paletteOpen || quickOpen;
  // 设置 overlay（P4；壳层私有——设置项全是容器语义，不经 ui.overlay 槽）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(settingsOpen);
  settingsRef.current = settingsOpen;
  /**
   * 语法糖视图开关（设置页里的那一项）。
   *
   * 状态所有者是**编辑器**（`EditorPane` 持有 + 落 localStorage）；这里只做
   * "开面板时读一次当前值 + 改动时写偏好并发意图事件"——避免同一个开关有两个真源。
   */
  const [sugarViewOn, setSugarViewOn] = useState(() => loadSugarViewPref());
  useEffect(() => {
    if (settingsOpen) setSugarViewOn(loadSugarViewPref());
  }, [settingsOpen]);
  const applySugarViewPref = useCallback(
    (on: boolean) => {
      saveSugarViewPref(on);
      setSugarViewOn(on);
      kernel.bus.emit('editor.sugarView.set', { on });
    },
    [kernel],
  );

  // overlay 打开/关闭意图（内核事件落地；Esc 关闭在全局键盘处理器）
  useEffect(() => {
    const unOpen = kernel.bus.on('ui.overlay.open', (ev) => {
      setActiveOverlay({ id: ev.id, ...(ev.payload !== undefined ? { payload: ev.payload } : {}) });
    });
    const unClose = kernel.bus.on('ui.overlay.close', (ev) => {
      setActiveOverlay((cur) => (cur && cur.id === ev.id ? null : cur));
    });
    return () => {
      unOpen();
      unClose();
    };
  }, [kernel]);

  // 壳层布局命令（定稿 §五-3：合法容器语义）与槽命令合并为统一注册表
  const shellCommands = useMemo<readonly ShellCommandSpec[]>(
    () => [
      { id: 'layout.toggleSidebar', title: '切换主侧栏', keybinding: 'ctrl+b', run: () => dispatch({ type: 'toggle', container: 'sidebar' }) },
      { id: 'layout.toggleBottom', title: '切换底部区', keybinding: 'ctrl+j', run: () => dispatch({ type: 'toggle', container: 'bottom' }) },
      { id: 'layout.toggleAux', title: '切换副侧栏', keybinding: 'ctrl+alt+b', run: () => dispatch({ type: 'toggle', container: 'aux' }) },
      { id: 'layout.toggleZen', title: '切换写作模式', keybinding: 'ctrl+k z', run: () => dispatch({ type: 'toggleZen' }) },
      { id: 'layout.reset', title: '重置布局', run: () => doResetRef.current() },
      { id: 'layout.openSettings', title: '打开设置', run: () => setSettingsOpen(true) },
      { id: 'workbench.commandPalette', title: '命令面板', keybinding: 'ctrl+shift+p', run: () => setPaletteOpen(true) },
      { id: 'workbench.quickOpen', title: '快速打开文件', keybinding: 'ctrl+p', run: () => setQuickOpen(true) },
      // P3：编辑器区注入的命令（关闭标签 / 全部保存）并入统一注册表
      ...(extraCommands ?? []),
    ],
    [extraCommands],
  );
  const registry = useMemo(
    () => buildCommandRegistry(shellCommands, slotCommands),
    [shellCommands, slotCommands],
  );
  // 最新注册表 / 上下文 ref（全局键盘处理器闭包外读取）
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const commandCtxRef = useRef(commandCtx);
  commandCtxRef.current = commandCtx;

  // 工作台 API 注册（编辑器区空态动作按钮反向取 picker/命令入口）
  useEffect(() => {
    onRegisterWorkbench?.({
      openQuickOpen: () => setQuickOpen(true),
      openPalette: () => setPaletteOpen(true),
      hasCommand: (id) => registryRef.current.some((c) => c.id === id),
      runCommand: (id) => {
        const cmd = registryRef.current.find((c) => c.id === id);
        if (!cmd) return false;
        try {
          if (cmd.when && !cmd.when(commandCtxRef.current)) return false;
          void cmd.run(commandCtxRef.current);
          return true;
        } catch (e: unknown) {
          console.warn(`[ShellLayout] 命令 '${id}' 执行失败：${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      },
    });
    return () => onRegisterWorkbench?.(null);
  }, [onRegisterWorkbench]);

  // 全局快捷键（统一注册表驱动；Ctrl+K Z 和弦特例；Esc 优先级 picker > overlay > zen）
  useEffect(() => {
    let chordAt = 0;
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      // Ctrl+K Z 和弦：先记 Ctrl+K，1.5s 内按 Z 触发（两键序列，注册表单键表达不了）
      if (chordAt > 0) {
        const fresh = Date.now() - chordAt < 1500;
        chordAt = 0;
        if (fresh && k === 'z' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          dispatch({ type: 'toggleZen' });
          return;
        }
      }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && k === 'k') {
        chordAt = Date.now();
        return;
      }
      if (e.key === 'Escape') {
        // picker 内部已 stopPropagation；这里只需 overlay > settings > zen
        if (pickerRef.current) return;
        if (overlayRef.current) {
          setActiveOverlay(null);
          return;
        }
        if (settingsRef.current) {
          setSettingsOpen(false);
          return;
        }
        if (zenRef.current) dispatch({ type: 'exitZen' });
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // 注册表 keybinding 匹配
      const chord = chordFromEvent(e);
      if (!chord) return;
      for (const cmd of registryRef.current) {
        if (!cmd.keybinding || cmd.keybinding.includes(' ')) continue; // 和弦走上方特例
        const parsed = parseKeybinding(cmd.keybinding);
        if (parsed && chordEquals(parsed, chord)) {
          e.preventDefault();
          void cmd.run(commandCtxRef.current);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 尺寸拖拽：mousedown 记录起点与初值，mousemove 换算，mouseup 解绑 */
  const startDrag = useCallback(
    (e: ReactMouseEvent, container: ContainerKey, horizontal: boolean, sign: 1 | -1) => {
      e.preventDefault();
      const startPos = horizontal ? e.clientX : e.clientY;
      const startSize = layout[container].size;
      const onMove = (ev: MouseEvent): void => {
        const pos = horizontal ? ev.clientX : ev.clientY;
        dispatch({ type: 'resize', container, size: startSize + sign * (pos - startPos) });
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [layout],
  );

  /* -------------------- P4：三容器拖拽停靠（定稿 §七；override 持久化在 layout.panelLocations） -------------------- */

  /** 落点高亮目标（dragover 置位，drop/dragend/真正离开容器时清除） */
  const [dropTarget, setDropTarget] = useState<ContainerKey | null>(null);

  /** 拖拽载荷：面板 id 数组（活动栏图标拖拽 = 整组视图迁移） */
  const startPanelDrag = (e: ReactDragEvent, ids: readonly string[]): void => {
    e.dataTransfer.setData(PANEL_DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
  };

  /** 容器落点 props：dragover 接受 + 高亮；drop 派发 move（逐面板；sidebar 需 viewKey 激活） */
  const dropProps = (container: ContainerKey) => ({
    onDragOver: (e: ReactDragEvent) => {
      if (!e.dataTransfer.types.includes(PANEL_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(container);
    },
    onDragLeave: (e: ReactDragEvent) => {
      // 子元素间移动会反复触发 leave——只在真正离开容器时清除
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropTarget((cur) => (cur === container ? null : cur));
    },
    onDrop: (e: ReactDragEvent) => {
      const raw = e.dataTransfer.getData(PANEL_DRAG_MIME);
      setDropTarget(null);
      if (!raw) return;
      e.preventDefault();
      let ids: string[] = [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        return;
      }
      for (const id of ids) {
        const panel = allPanels.find((p) => p.id === id);
        if (!panel) continue;
        const viewKey = panel.group ? `group:${panel.group}` : `panel:${panel.id}`;
        dispatch({ type: 'move', id, to: container, viewKey });
      }
    },
  });
  const dragEnd = (): void => setDropTarget(null);

  const doReset = useCallback(() => {
    resetLayout();
    dispatch({ type: 'reset', state: defaultLayout(organizePanels(allPanels, {})) });
  }, [allPanels]);
  const doResetRef = useRef(doReset);
  doResetRef.current = doReset;

  const runToolbarCommand = useCallback(
    (commandId: string) => {
      const cmd = registry.find((c) => c.id === commandId);
      if (!cmd) return;
      try {
        if (cmd.when && !cmd.when(commandCtx)) return;
        void cmd.run(commandCtx);
      } catch (e: unknown) {
        console.warn(`[ShellLayout] 工具栏命令 '${commandId}' 执行失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [registry, commandCtx],
  );

  /* ------------------------------ 渲染片段 ------------------------------ */

  const activeView = org.views.find((v) => v.key === layout.sidebar.active) ?? null;
  const activeAux = org.aux.find((p) => p.id === layout.aux.active) ?? null;
  const activeBottom = org.bottom.find((p) => p.id === layout.bottom.active) ?? null;

  /** 侧栏组内折叠状态（会话级，不持久化——定稿 §七持久化清单不含组内折叠） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = (panelId: string): void =>
    setCollapsed((prev) => ({ ...prev, [panelId]: !prev[panelId] }));

  /* -------- 侧栏多面板弹性分栏（用户反馈：口上文件/函数树默认 50/50，可上下拉伸） -------- */

  /** 各视图的分栏权重（会话级，与组内折叠同级不持久化；缺省 = 全 1 等分） */
  const [splitWeights, setSplitWeights] = useState<Record<string, number[]>>({});
  const splitRef = useRef<HTMLDivElement | null>(null);

  /** 分栏把手拖拽：调整第 i / i+1 两个展开面板的权重（总和守恒，带最小权重钳制） */
  const startSectionDrag = (e: ReactMouseEvent, view: ViewDef, i: number): void => {
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const totalPx = container.clientHeight;
    if (totalPx <= 0) return;
    const n = view.panels.length;
    const cur = splitWeights[view.key] ?? Array.from({ length: n }, () => 1);
    const totalW = cur.reduce((a, b) => a + b, 0);
    const startY = e.clientY;
    const wA = cur[i] ?? 1;
    const wB = cur[i + 1] ?? 1;
    const sum = wA + wB;
    const MIN_W = 0.4;
    const onMove = (ev: MouseEvent): void => {
      const d = ((ev.clientY - startY) / totalPx) * totalW;
      const newA = Math.min(sum - MIN_W, Math.max(MIN_W, wA + d));
      const next = [...cur];
      next[i] = newA;
      next[i + 1] = sum - newA;
      setSplitWeights((prev) => ({ ...prev, [view.key]: next }));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const activityBar = (
    <nav
      className={`activitybar ${dropTarget === 'sidebar' ? 'drop-target' : ''}`}
      aria-label="活动栏"
      {...dropProps('sidebar')}
    >
      {org.views.filter((v) => !isLowFreqView(v)).map((v) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={`${v.title}（可拖拽到其他容器）`}
          draggable
          onDragStart={(e) => startPanelDrag(e, v.panels.map((p) => p.id))}
          onDragEnd={dragEnd}
          onClick={() =>
            dispatch(
              v.key === layout.sidebar.active
                ? { type: 'toggle', container: 'sidebar' }
                : { type: 'activate', container: 'sidebar', key: v.key },
            )
          }
        >
          {v.icon ?? v.title.slice(0, 1)}
        </button>
      ))}
      <span className="ab-spacer" />
      {org.views.filter(isLowFreqView).map((v) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={`${v.title}（可拖拽到其他容器）`}
          draggable
          onDragStart={(e) => startPanelDrag(e, v.panels.map((p) => p.id))}
          onDragEnd={dragEnd}
          onClick={() =>
            dispatch(
              v.key === layout.sidebar.active
                ? { type: 'toggle', container: 'sidebar' }
                : { type: 'activate', container: 'sidebar', key: v.key },
            )
          }
        >
          {v.icon ?? v.title.slice(0, 1)}
        </button>
      ))}
      <button className="ab-item" title="设置" onClick={() => setSettingsOpen(true)}>
        ⚙
      </button>
    </nav>
  );

  const sidebarView = activeView && activeView.panels.length > 1 ? (
    /* 多面板视图：弹性分栏（默认等分；把手上下拉伸；折叠的头只占标题行） */
    <div ref={splitRef} className="sidebar-views split">
      {activeView.panels.map((p, i) => {
        const isCollapsed = collapsed[p.id] === true;
        const weights = splitWeights[activeView.key] ?? activeView.panels.map(() => 1);
        const nextPanel = activeView.panels[i + 1];
        const showSplitter =
          !isCollapsed && nextPanel !== undefined && collapsed[nextPanel.id] !== true;
        return (
          <Fragment key={p.id}>
            <section
              className="sidebar-section"
              style={isCollapsed ? undefined : { flexGrow: weights[i] ?? 1, flexBasis: 0 }}
            >
              <button
                className="sidebar-section-head"
                title={`${p.title}（可拖拽到其他容器）`}
                draggable
                onDragStart={(e) => startPanelDrag(e, [p.id])}
                onDragEnd={dragEnd}
                onClick={() => toggleCollapse(p.id)}
              >
                <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                <span>{p.title}</span>
              </button>
              {isCollapsed ? null : <PanelBody contribution={p} />}
            </section>
            {showSplitter ? (
              <div
                className="resizer resizer-y section-splitter"
                role="separator"
                aria-label={`调整 ${p.title} 高度`}
                onMouseDown={(e) => startSectionDrag(e, activeView, i)}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  ) : (
    <div className="sidebar-views">
      {activeView && activeView.panels[0] ? <PanelBody contribution={activeView.panels[0]} /> : null}
    </div>
  );

  const tabStrip = (container: 'aux' | 'bottom', items: readonly UIPanelContribution[], activeId: string | null): ReactElement => (
    <div className="panel-tabs" role="tablist">
      {items.map((p) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={p.id === activeId}
          className={`panel-tab ${p.id === activeId ? 'active' : ''}`}
          title={`${p.title}（可拖拽到其他容器）`}
          draggable
          onDragStart={(e) => startPanelDrag(e, [p.id])}
          onDragEnd={dragEnd}
          onClick={() => dispatch({ type: 'activate', container, key: p.id })}
        >
          {p.title}
        </button>
      ))}
      <span className="spacer" />
      <button
        className="ghost small panel-close"
        title="关闭面板"
        onClick={() => dispatch({ type: 'toggle', container })}
      >
        ×
      </button>
    </div>
  );

  const toolbar = (
    <header className="toolbar">
      <div className="toolbar-left">
        {commandCtx.project ? (
          <span className="tb-project" title={commandCtx.project.rootDir}>
            {commandCtx.project.adapterId}
          </span>
        ) : null}
        {onReloadProject ? (
          <button className="ghost small toolbar-btn" title="重载项目" onClick={onReloadProject}>
            ⟳
          </button>
        ) : null}
        {toolbarItems.map((t) => {
          const cmd = registry.find((c) => c.id === t.command);
          let enabled = false;
          if (cmd) {
            enabled = true;
            if (cmd.when) {
              try {
                enabled = cmd.when(commandCtx);
              } catch {
                enabled = false;
              }
            }
          }
          return (
            <button
              key={t.id}
              className="ghost small toolbar-btn"
              title={t.title}
              disabled={!enabled}
              onClick={() => runToolbarCommand(t.command)}
            >
              {t.icon ? <span className="tb-icon">{t.icon}</span> : null}
              {t.title}
            </button>
          );
        })}
      </div>
      <div className="toolbar-right">
        {onCloseProject ? (
          <button className="ghost small toolbar-btn" title="关闭项目" onClick={onCloseProject}>
            ✕ 关闭项目
          </button>
        ) : null}
        <button
          className={`ghost small toolbar-btn ${layout.sidebar.visible ? 'on' : ''}`}
          title="切换主侧栏 (Ctrl+B)"
          onClick={() => dispatch({ type: 'toggle', container: 'sidebar' })}
        >
          ◧
        </button>
        <button
          className={`ghost small toolbar-btn ${layout.bottom.visible ? 'on' : ''}`}
          title="切换底部区 (Ctrl+J)"
          onClick={() => dispatch({ type: 'toggle', container: 'bottom' })}
        >
          ⬓
        </button>
        <button
          className={`ghost small toolbar-btn ${layout.aux.visible ? 'on' : ''}`}
          title="切换副侧栏 (Ctrl+Alt+B)"
          onClick={() => dispatch({ type: 'toggle', container: 'aux' })}
        >
          ◨
        </button>
        <button className="ghost small toolbar-btn" title="重置布局" onClick={doReset}>
          ⟲
        </button>
      </div>
    </header>
  );

  const statusbar = (
    <footer className={`statusbar ${layout.zen ? 'zen' : ''}`}>
      <div className="sb-left">
        {writable ? (
          <span className="sb-writable ok" title="写权限已批准">
            可写
          </span>
        ) : (
          <button className="sb-writable ro" title="只读：写权限未批准，点击重新授权" onClick={onReauth}>
            只读
          </button>
        )}
        {statusbarItems
          .filter((s) => (s.align ?? 'right') === 'left')
          .map((s) => (
            <StatusbarItem key={s.id} contribution={s} />
          ))}
        {!layout.zen &&
          (stats.indexError ? (
            <span className="sb-idx err" title={stats.indexError}>
              索引失败：{stats.indexError}
            </span>
          ) : stats.indexing ? (
            <span className="sb-idx">索引构建中…</span>
          ) : (
            <span className="sb-idx">
              {stats.fileCount} 文件 · {stats.fnCount} 函数
            </span>
          ))}
      </div>
      <div className="sb-right">
        {statusbarItems
          .filter((s) => (s.align ?? 'right') === 'right')
          .map((s) => (
            <StatusbarItem key={s.id} contribution={s} />
          ))}
        {editorStatus ? (
          <span className="sb-editor">
            {editorStatus.encoding} · {editorStatus.eol} · {editorStatus.lines} 行
          </span>
        ) : null}
        <span className={`sb-dirty ${dirty ? 'on' : ''}`} title={dirty ? '有未保存修改' : '已保存'}>
          {dirty ? '● 未保存' : '已保存'}
        </span>
      </div>
    </footer>
  );

  /* ------------------------------ 浮层（picker + overlay） ------------------------------ */

  const overlayContribution = activeOverlay
    ? (overlayItems.find((o) => o.id === activeOverlay.id) ?? null)
    : null;
  const overlays = (
    <>
      {paletteOpen ? (
        <CommandPalette commands={registry} commandCtx={commandCtx} onClose={() => setPaletteOpen(false)} />
      ) : null}
      {quickOpen && quickOpenFiles && onOpenFile ? (
        <QuickOpen files={quickOpenFiles} onOpenFile={onOpenFile} onClose={() => setQuickOpen(false)} />
      ) : null}
      {overlayContribution ? (
        <div className="overlay-backdrop" onMouseDown={() => setActiveOverlay(null)}>
          <div className="overlay-host" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <PanelBody contribution={overlayContribution} />
          </div>
        </div>
      ) : null}
      {settingsOpen ? (
        <div className="overlay-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <div className="overlay-host" role="dialog" aria-modal="true" aria-label="设置" onMouseDown={(e) => e.stopPropagation()}>
            <div className="wizard">
              <h3>设置</h3>
              <label className="settings-row">
                <input
                  type="checkbox"
                  checked={layout.zen}
                  onChange={(e) => dispatch(e.target.checked ? { type: 'toggleZen' } : { type: 'exitZen' })}
                />
                <span>
                  写作模式（全禅）
                  <span className="settings-hint">快捷键 Ctrl+K Z；Esc 退出</span>
                </span>
              </label>
              <label className="settings-row">
                <input
                  type="checkbox"
                  checked={layout.zenLimitWidth}
                  onChange={(e) => dispatch({ type: 'setZenLimitWidth', value: e.target.checked })}
                />
                <span>
                  写作模式：编辑器居中限宽（约 1000px）
                  <span className="settings-hint">关闭后编辑器铺满全宽</span>
                </span>
              </label>
              <label className="settings-row">
                <input
                  type="checkbox"
                  checked={sugarViewOn}
                  onChange={(e) => applySugarViewPref(e.target.checked)}
                />
                <span>
                  语法糖视图（把 ERB 显示成中文表层写法）
                  <span className="settings-hint">
                    只读显示、不改动原文件；快捷键 Ctrl+Alt+T。仅对 .erb 生效（.kojo 本身就是糖）
                  </span>
                </span>
              </label>
              <div className="settings-actions">
                <button className="ghost small" onClick={doReset}>
                  重置布局
                </button>
                <span className="settings-hint">恢复默认面板位置 / 尺寸 / 显隐</span>
              </div>
              <div className="settings-actions">
                <button className="primary small" onClick={() => setSettingsOpen(false)}>
                  完成
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  /* ------------------------------ 全禅形态 ------------------------------ */

  if (layout.zen) {
    return (
      <div className="shell zen">
        <div className="zen-editor">
          <div className={`zen-editor-inner ${layout.zenLimitWidth ? '' : 'no-limit'}`}>{children}</div>
        </div>
        {statusbar}
        {overlays}
      </div>
    );
  }

  /* ------------------------------ 常规形态 ------------------------------ */

  return (
    <div className="shell">
      {toolbar}
      <div className="shell-main">
        {activityBar}
        {layout.sidebar.visible && activeView ? (
          <>
            <aside
              className={`sidebar ${dropTarget === 'sidebar' ? 'drop-target' : ''}`}
              style={{ width: layout.sidebar.size }}
              {...dropProps('sidebar')}
            >
              {sidebarView}
            </aside>
            <div
              className="resizer resizer-x"
              role="separator"
              aria-label="调整主侧栏宽度"
              onMouseDown={(e) => startDrag(e, 'sidebar', true, 1)}
            />
          </>
        ) : null}
        <main className="editor-area">{children}</main>
        {layout.aux.visible && activeAux ? (
          <>
            <div
              className="resizer resizer-x"
              role="separator"
              aria-label="调整副侧栏宽度"
              onMouseDown={(e) => startDrag(e, 'aux', true, -1)}
            />
            <aside
              className={`aux ${dropTarget === 'aux' ? 'drop-target' : ''}`}
              style={{ width: layout.aux.size }}
              {...dropProps('aux')}
            >
              {tabStrip('aux', org.aux, layout.aux.active)}
              <div className="container-body">
                <PanelBody contribution={activeAux} />
              </div>
            </aside>
          </>
        ) : null}
      </div>
      {layout.bottom.visible && activeBottom ? (
        <>
          <div
            className="resizer resizer-y"
            role="separator"
            aria-label="调整底部区高度"
            onMouseDown={(e) => startDrag(e, 'bottom', false, -1)}
          />
          <section
            className={`bottombar ${dropTarget === 'bottom' ? 'drop-target' : ''}`}
            style={{ height: layout.bottom.size }}
            {...dropProps('bottom')}
          >
            {tabStrip('bottom', org.bottom, layout.bottom.active)}
            <div className="container-body">
              <PanelBody contribution={activeBottom} />
            </div>
          </section>
        </>
      ) : null}
      {statusbar}
      {overlays}
    </div>
  );
}
