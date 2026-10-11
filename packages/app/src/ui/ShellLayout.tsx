import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
  /** 命令执行上下文（ui.toolbar 消费） */
  commandCtx: EditorCommandContext;
  /** 关闭项目入口（工具栏右区；欢迎页回退） */
  onCloseProject?: () => void;
  /** 重载项目入口（工具栏左区，项目标签旁） */
  onReloadProject?: () => void;
}

type ContainerKey = 'sidebar' | 'aux' | 'bottom';

type LayoutAction =
  | { type: 'toggle'; container: ContainerKey }
  | { type: 'activate'; container: ContainerKey; key: string }
  | { type: 'resize'; container: ContainerKey; size: number }
  | { type: 'move'; id: string; to: PanelLocation; viewKey: string | null }
  | { type: 'toggleZen' }
  | { type: 'exitZen' }
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
  } = props;

  const allPanels = useMemo(
    () => [...builtinViews, ...kernel.slots.query('ui.panel')],
    [kernel, builtinViews],
  );
  const toolbarItems = useMemo(() => kernel.slots.query('ui.toolbar'), [kernel]);
  const statusbarItems = useMemo(() => kernel.slots.query('ui.statusbar'), [kernel]);
  const commands = useMemo(() => kernel.slots.query('editor.command'), [kernel]);

  const [layout, dispatch] = useReducer(reducer, undefined as unknown as LayoutState, () =>
    reconcileLayout(loadLayout(), organizePanels(allPanels, {})),
  );
  const org: OrganizedPanels = useMemo(
    () => organizePanels(allPanels, layout.panelLocations),
    [allPanels, layout.panelLocations],
  );

  // 持久化（壳层私事，localStorage；变更即存，体量小无需去抖）
  useEffect(() => saveLayout(layout), [layout]);

  // zen ref 供全局 Esc 读取最新值
  const zenRef = useRef(layout.zen);
  zenRef.current = layout.zen;

  // 全局快捷键（壳层布局命令，定稿 §十一；命令面板化在 P2 并入统一注册表）
  useEffect(() => {
    let chordAt = 0;
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      // Ctrl+K Z 和弦：先记 Ctrl+K，1.5s 内按 Z 触发
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
      if (e.key === 'Escape' && zenRef.current) {
        dispatch({ type: 'exitZen' });
        return;
      }
      if (!e.ctrlKey || e.metaKey) return;
      if (!e.altKey && !e.shiftKey && k === 'b') {
        e.preventDefault();
        dispatch({ type: 'toggle', container: 'sidebar' });
      } else if (!e.altKey && !e.shiftKey && k === 'j') {
        e.preventDefault();
        dispatch({ type: 'toggle', container: 'bottom' });
      } else if (e.altKey && !e.shiftKey && k === 'b') {
        e.preventDefault();
        dispatch({ type: 'toggle', container: 'aux' });
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

  const doReset = useCallback(() => {
    resetLayout();
    dispatch({ type: 'reset', state: defaultLayout(organizePanels(allPanels, {})) });
  }, [allPanels]);

  const runToolbarCommand = useCallback(
    (commandId: string) => {
      const cmd = commands.find((c) => c.id === commandId);
      if (!cmd) return;
      try {
        if (cmd.when && !cmd.when(commandCtx)) return;
        void cmd.run(commandCtx);
      } catch (e: unknown) {
        console.warn(`[ShellLayout] 工具栏命令 '${commandId}' 执行失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [commands, commandCtx],
  );

  /* ------------------------------ 渲染片段 ------------------------------ */

  const activeView = org.views.find((v) => v.key === layout.sidebar.active) ?? null;
  const activeAux = org.aux.find((p) => p.id === layout.aux.active) ?? null;
  const activeBottom = org.bottom.find((p) => p.id === layout.bottom.active) ?? null;

  /** 侧栏组内折叠状态（会话级，不持久化——定稿 §七持久化清单不含组内折叠） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = (panelId: string): void =>
    setCollapsed((prev) => ({ ...prev, [panelId]: !prev[panelId] }));

  const activityBar = (
    <nav className="activitybar" aria-label="活动栏">
      {org.views.filter((v) => !isLowFreqView(v)).map((v) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={v.title}
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
          title={v.title}
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
    </nav>
  );

  const sidebarView = (
    <div className="sidebar-views">
      {activeView
        ? activeView.panels.map((p) => {
            const isCollapsed = collapsed[p.id] === true;
            // 独占视图：容器即面板，不再多一层可折叠头
            if (activeView.panels.length === 1) {
              return <PanelBody key={p.id} contribution={p} />;
            }
            return (
              <section key={p.id} className="sidebar-section">
                <button className="sidebar-section-head" onClick={() => toggleCollapse(p.id)}>
                  <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                  <span>{p.title}</span>
                </button>
                {isCollapsed ? null : <PanelBody contribution={p} />}
              </section>
            );
          })
        : null}
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
          const cmd = commands.find((c) => c.id === t.command);
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
        <button
          className="ghost small toolbar-btn"
          title="写作模式 (Ctrl+K Z)"
          onClick={() => dispatch({ type: 'toggleZen' })}
        >
          ☾
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
        <button
          className="ghost small sb-zen"
          title={layout.zen ? '退出写作模式 (Esc)' : '写作模式 (Ctrl+K Z)'}
          onClick={() => dispatch({ type: 'toggleZen' })}
        >
          ☾
        </button>
      </div>
    </footer>
  );

  /* ------------------------------ 全禅形态 ------------------------------ */

  if (layout.zen) {
    return (
      <div className="shell zen">
        <div className="zen-editor">
          <div className="zen-editor-inner">{children}</div>
        </div>
        {statusbar}
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
            <aside className="sidebar" style={{ width: layout.sidebar.size }}>
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
            <aside className="aux" style={{ width: layout.aux.size }}>
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
          <section className="bottombar" style={{ height: layout.bottom.size }}>
            {tabStrip('bottom', org.bottom, layout.bottom.active)}
            <div className="container-body">
              <PanelBody contribution={activeBottom} />
            </div>
          </section>
        </>
      ) : null}
      {statusbar}
    </div>
  );
}
