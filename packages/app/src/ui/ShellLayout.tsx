import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type { EditorCommandContext, UIPanelContribution } from '@kojo/plugin-api';
import {
  MIN_FLOAT,
  defaultLayout,
  loadLayout,
  organizePanels,
  reducer,
  reconcileLayout,
  resetLayout,
  saveLayout,
  type ContainerKey,
  type LayoutAction,
  type LayoutState,
  type OrganizedPanels,
  type ViewDef,
} from './layout';
import {
  PANEL_DRAG_MIME,
  acceptsPanelDrop,
  decodeDroppedPanelIds,
  nextDropTarget,
  planPanelMoves,
} from './panel-drop';
import { loadSugarViewPref, saveSugarViewPref } from './sugar-view';
import {
  applyMotionPref,
  loadMotionPref,
  saveMotionPref,
  type MotionPref,
} from './motion-pref';
import { SEALED_PANEL_IDS, setSealed, useSealed } from './sealed';
import { modalDepth, closeTopModal } from './modal-stack';
import { resolveEscLayer, isComposingEvent, nextRovingIndex } from './shell-keys';
import {
  buildCommandRegistry,
  chordFromEvent,
  chordEquals,
  parseKeybinding,
  type ShellCommandSpec,
} from './commands';
import { CommandPalette, QuickOpen } from './Palette';
import { PanelBody, StatusbarItem } from './PanelHost';
import { ProblemsStatusItem } from './ProblemPanel';
import { Icon } from './icons';

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

  /** 封存总闸（`sealed.ts`；默认封存）：封存态下被点名的插件面板整只不进编排 */
  const sealed = useSealed();
  const allPanels = useMemo(() => {
    const all = [...builtinViews, ...kernel.slots.query('ui.panel')];
    return sealed ? all.filter((p) => !SEALED_PANEL_IDS.has(p.id)) : all;
  }, [kernel, builtinViews, sealed]);
  const toolbarItems = useMemo(() => kernel.slots.query('ui.toolbar'), [kernel]);
  const statusbarItems = useMemo(() => kernel.slots.query('ui.statusbar'), [kernel]);
  const slotCommands = useMemo(() => kernel.slots.query('editor.command'), [kernel]);
  const overlayItems = useMemo(() => kernel.slots.query('ui.overlay'), [kernel]);

  const [layout, dispatch] = useReducer(reducer, undefined as unknown as LayoutState, () =>
    reconcileLayout(loadLayout(), organizePanels(allPanels, {})),
  );
  // 渲染用的编排排除已浮动的面板（它们不在三容器里重复显示）
  const dockedPanels = useMemo(
    () => allPanels.filter((p) => layout.floating[p.id] === undefined),
    [allPanels, layout.floating],
  );
  const org: OrganizedPanels = useMemo(
    () => organizePanels(dockedPanels, layout.panelLocations),
    [dockedPanels, layout.panelLocations],
  );

  // 清洗总闸的再清洗必须基于全体面板（含浮动的），否则浮动 id 会被误清洗掉
  const fullOrg = useMemo(
    () => organizePanels(allPanels, layout.panelLocations),
    [allPanels, layout.panelLocations],
  );
  const fullOrgRef = useRef(fullOrg);
  fullOrgRef.current = fullOrg;
  // 总闸切换后面板集合增删，active/override 可能失效——重跑一次清洗器（首跑跳过，挂载时已清洗过）
  const sealSkipFirstRef = useRef(true);
  useEffect(() => {
    if (sealSkipFirstRef.current) {
      sealSkipFirstRef.current = false;
      return;
    }
    dispatch({ type: 'reconcile', org: fullOrgRef.current });
  }, [sealed]);

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

  /**
   * 减弱动效开关（UI-5；设置页里的那一项）。
   *
   * 真源是 `motion-pref.ts` 的 localStorage 偏好 + `<html data-motion>` 属性，
   * 这里只持有会话内的镜像值供开关渲染。挂载时按存下的偏好同步一次属性——
   * 否则「上次选了减弱动效」要到用户再打开设置页才生效。
   */
  const [motionPref, setMotionPref] = useState<MotionPref>(() => loadMotionPref());
  useEffect(() => {
    applyMotionPref(loadMotionPref());
  }, []);
  const commitMotionPref = useCallback((p: MotionPref) => {
    saveMotionPref(p);
    setMotionPref(p);
    applyMotionPref(p);
  }, []);

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
      // 问题面板（HK-4 · UI-6）：打开底部区并激活「问题」视图（activate 会同时置 visible:true）
      { id: 'workbench.problems', title: '问题面板', keybinding: 'ctrl+shift+m', run: () => dispatch({ type: 'activate', container: 'bottom', key: 'kojo.problems' }) },
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

  /**
   * 输入法合成会话标志（2026-10-12 实机缺陷修复）。
   *
   * 事件自带的 `isComposing` / `keyCode 229` 已覆盖主路径，这一层兜的是第三方输入法
   * 「keydown 上不带合成态」的情形——写作模式的主场景就是大量中文输入，漏一次等于把
   * 用户的界面状态拆掉（且布局会持久化，重启仍在）。
   */
  const composingRef = useRef(false);

  // 全局快捷键（统一注册表驱动；Ctrl+K Z 和弦特例；Esc 优先级见 shell-keys 的 ESC_PRIORITY）
  useEffect(() => {
    let chordAt = 0;
    // 合成期一律不消费：撤销拼音候选的那次 Esc 属于输入法，不属于编辑器（判据在 shell-keys）
    const onCompositionStart = (): void => {
      composingRef.current = true;
    };
    const onCompositionEnd = (): void => {
      composingRef.current = false;
    };
    // 失焦时合成会话未必会补一个 compositionend（候选窗还开着就 alt-tab 走）——不清掉标志
    // 会把「合成期不消费快捷键」变成「永久不消费快捷键」，那比原缺陷更坏。
    const onWindowBlur = (): void => {
      composingRef.current = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (isComposingEvent(e, composingRef.current)) return;
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
        // 命中哪一层由 shell-keys 单源判定；picker 内部已 stopPropagation，全局侧原样让位。
        // 模态（HK-2 的宿主模态栈）排在 overlay 之前：它正在问一个当下就要答案的问题，
        // 而 Esc 恒落在不写盘那一侧（见 modal-stack 注释）。
        const hit = resolveEscLayer({
          picker: pickerRef.current,
          modal: modalDepth() > 0,
          overlay: overlayRef.current !== null,
          settings: settingsRef.current,
          zen: zenRef.current,
        });
        if (hit === 'modal') closeTopModal();
        else if (hit === 'overlay') setActiveOverlay(null);
        else if (hit === 'settings') setSettingsOpen(false);
        else if (hit === 'zen') dispatch({ type: 'exitZen' });
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
    // 捕获阶段收合成事件：组件（含 Monaco）可能自行 stopPropagation，会话标志不能因此漏记
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('compositionstart', onCompositionStart, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
      window.removeEventListener('blur', onWindowBlur);
    };
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

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /**
   * 浮窗 DOM 引用（id → 根 `<section>`）。
   * 拖拽 / 缩放期间**直接改元素样式**、不进 reducer——否则每次 mousemove 都会产生新
   * `LayoutState` ⇒ 整棵 ShellLayout（含浮窗内面板子树）重渲染 + `saveLayout` 写
   * localStorage，于是拖起来卡。松手才 commit 一次几何到 state。
   */
  const floatElsRef = useRef(new Map<string, HTMLElement>());

  const floatingPanels = useMemo(
    () => allPanels.filter((p) => layout.floating[p.id] !== undefined),
    [allPanels, layout.floating],
  );

  /** 浮动一个面板：按视口算初值，多窗层叠错位避免完全重叠 */
  const floatPanel = useCallback((id: string) => {
    const n = Object.keys(layoutRef.current.floating).length;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(960, Math.max(460, Math.round(vw * 0.52)));
    const h = Math.min(680, Math.max(320, Math.round(vh * 0.62)));
    const x = Math.max(16, Math.round((vw - w) / 2) + n * 26);
    const y = Math.max(16, 64 + n * 26);
    dispatch({ type: 'float', id, geometry: { x, y, w, h } });
  }, []);

  /** 浮窗拖拽（标题栏 mousedown → 全局 mousemove；拖拽期间直写 left/top，松手 commit） */
  const startFloatDrag = useCallback((e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    const f = layoutRef.current.floating[id];
    if (!f) return;
    const el = floatElsRef.current.get(id) ?? null;
    const startX = e.clientX;
    const startY = e.clientY;
    let x = f.x;
    let y = f.y;
    const onMove = (ev: MouseEvent): void => {
      x = Math.min(window.innerWidth - 80, Math.max(80 - f.w, f.x + (ev.clientX - startX)));
      y = Math.min(window.innerHeight - 32, Math.max(0, f.y + (ev.clientY - startY)));
      if (el) {
        // 直接写 inline left/top（**不用 transform**）：不进 reducer ⇒ 不触发重渲染 / localStorage 写。
        // 关键：inline 值与松手后 React 落地的值同坐标系、逐字相同 ⇒ 交接时视觉零 delta（无抖动）。
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      } else {
        dispatch({ type: 'moveFloating', id, x, y });
      }
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // inline left/top 已 == 最终位置；此处只 commit，React 写入相同值 ⇒ 无跳变（无归一化步骤）
      if (x !== f.x || y !== f.y) dispatch({ type: 'moveFloating', id, x, y });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  /** 浮窗右下角缩放（同样直改 DOM，松手 commit） */
  const startFloatResize = useCallback((e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const f = layoutRef.current.floating[id];
    if (!f) return;
    const el = floatElsRef.current.get(id) ?? null;
    const startX = e.clientX;
    const startY = e.clientY;
    let w = f.w;
    let h = f.h;
    const onMove = (ev: MouseEvent): void => {
      w = Math.max(MIN_FLOAT.w, f.w + (ev.clientX - startX));
      h = Math.max(MIN_FLOAT.h, f.h + (ev.clientY - startY));
      if (el) {
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
      } else {
        dispatch({ type: 'resizeFloating', id, w, h });
      }
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (w !== f.w || h !== f.h) dispatch({ type: 'resizeFloating', id, w, h });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // 浮动面板意图（内核事件落地；停靠由浮窗自带的按钮完成）
  useEffect(() => {
    const un = kernel.bus.on('ui.panel.float', (ev) => floatPanel(ev.id));
    return un;
  }, [kernel, floatPanel]);

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
      if (!acceptsPanelDrop(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget((cur) => nextDropTarget(cur, { type: 'dragover', container }));
    },
    onDragLeave: (e: ReactDragEvent) => {
      // 子元素间移动会反复触发 leave——「真正离开」的判据住在 panel-drop（relatedTarget 仍在容器内即不动）
      const stillInside = e.currentTarget.contains(e.relatedTarget as Node | null);
      setDropTarget((cur) => nextDropTarget(cur, { type: 'dragleave', container, stillInside }));
    },
    onDrop: (e: ReactDragEvent) => {
      const raw = e.dataTransfer.getData(PANEL_DRAG_MIME);
      setDropTarget((cur) => nextDropTarget(cur, { type: 'dropped' }));
      if (!raw) return;
      e.preventDefault();
      for (const intent of planPanelMoves(decodeDroppedPanelIds(raw), allPanels, container)) {
        dispatch({ type: 'move', id: intent.id, to: intent.to, viewKey: intent.viewKey });
      }
    },
  });
  const dragEnd = (): void => setDropTarget((cur) => nextDropTarget(cur, { type: 'dragend' }));

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

  const activeView = org.views.find((v) => v.key === layout.sidebar.active) ?? org.views[0] ?? null;
  const activeAux = org.aux.find((p) => p.id === layout.aux.active) ?? org.aux[0] ?? null;
  const activeBottom = org.bottom.find((p) => p.id === layout.bottom.active) ?? org.bottom[0] ?? null;

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

  /* -------------------- UI-4：活动栏 / 标签条方向键漫游（roving tabindex） -------------------- */

  /** 活动栏视图项按 DOM 顺序（常规组 + 低频组）——方向键漫游的索引基准 */
  const abHighFreq = org.views.filter((v) => !isLowFreqView(v));
  const abLowFreq = org.views.filter(isLowFreqView);
  const abViewList = [...abHighFreq, ...abLowFreq];
  /** 活动栏 roving 的 tab 落点：当前激活视图；不在列表（视图被清空/迁移）则回退首项 */
  const abTabKey = abViewList.some((v) => v.key === layout.sidebar.active)
    ? layout.sidebar.active
    : abViewList[0]?.key;

  /** 活动栏方向键：移动焦点并同步激活该视图（Enter/Space 仍由按钮原生活化） */
  const activityKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextRovingIndex(index, abViewList.length, e.key);
    if (next === null) return; // 非漫游键：原样让位（Enter/Space/Tab 不该被吞）
    e.preventDefault();
    const view = abViewList[next];
    if (!view) return;
    if (view.key !== layout.sidebar.active) {
      dispatch({ type: 'activate', container: 'sidebar', key: view.key });
    }
    // 落点在视图项之内（设置按钮排在 `.ab-item` 序列末尾，next 不会落到它）
    const btns = e.currentTarget.closest('nav')?.querySelectorAll<HTMLButtonElement>('.ab-item');
    if (btns) Array.from(btns)[next]?.focus();
  };

  /** 标签条方向键：移动焦点并同步激活该面板（role=tablist 自动激活，与鼠标点击同语义） */
  const tabStripKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    container: 'aux' | 'bottom',
    items: readonly UIPanelContribution[],
    index: number,
  ): void => {
    const next = nextRovingIndex(index, items.length, e.key);
    if (next === null) return;
    e.preventDefault();
    const tab = items[next];
    if (!tab) return;
    dispatch({ type: 'activate', container, key: tab.id });
    const tabs = e.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (tabs) Array.from(tabs)[next]?.focus();
  };

  const activityBar = (
    <nav
      className={`activitybar ${dropTarget === 'sidebar' ? 'drop-target' : ''}`}
      aria-label="活动栏"
      {...dropProps('sidebar')}
    >
      {abHighFreq.map((v, i) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={`${v.title}（可拖拽到其他容器）`}
          draggable
          tabIndex={v.key === abTabKey ? 0 : -1}
          onKeyDown={(e) => activityKeyDown(e, i)}
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
          <Icon name={v.icon ?? v.title.slice(0, 1)} size={22} />
        </button>
      ))}
      <span className="ab-spacer" />
      {abLowFreq.map((v, i) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={`${v.title}（可拖拽到其他容器）`}
          draggable
          tabIndex={v.key === abTabKey ? 0 : -1}
          onKeyDown={(e) => activityKeyDown(e, abHighFreq.length + i)}
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
          <Icon name={v.icon ?? v.title.slice(0, 1)} size={22} />
        </button>
      ))}
      <button className="ab-item" title="设置" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" size={22} />
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
                <span className="caret">
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                </span>
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
      {items.map((p, i) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={p.id === activeId}
          tabIndex={p.id === activeId ? 0 : -1}
          className={`panel-tab ${p.id === activeId ? 'active' : ''}`}
          title={`${p.title}（可拖拽到其他容器）`}
          draggable
          onKeyDown={(e) => tabStripKeyDown(e, container, items, i)}
          onDragStart={(e) => startPanelDrag(e, [p.id])}
          onDragEnd={dragEnd}
          onClick={() => dispatch({ type: 'activate', container, key: p.id })}
        >
          {p.title}
        </button>
      ))}
      <span className="spacer" />
      <button
        className="ghost small panel-float"
        title="浮动到大窗口"
        disabled={!activeId}
        onClick={() => { if (activeId) floatPanel(activeId); }}
      >
        <Icon name="popout" size={14} />
      </button>
      <button
        className="ghost small panel-close"
        title="关闭面板"
        onClick={() => dispatch({ type: 'toggle', container })}
      >
        <Icon name="close" size={14} />
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
            <Icon name="refresh" size={15} />
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
              {t.icon ? <Icon name={t.icon} size={14} /> : null}
              {t.title}
            </button>
          );
        })}
      </div>
      <div className="toolbar-right">
        {onCloseProject ? (
          <button className="ghost small toolbar-btn" title="关闭项目" onClick={onCloseProject}>
            <Icon name="close" size={14} /> 关闭项目
          </button>
        ) : null}
        <button
          className={`ghost small toolbar-btn ${layout.sidebar.visible ? 'on' : ''}`}
          title="切换主侧栏 (Ctrl+B)"
          onClick={() => dispatch({ type: 'toggle', container: 'sidebar' })}
        >
          <Icon name="layout-sidebar-left" size={15} />
        </button>
        <button
          className={`ghost small toolbar-btn ${layout.bottom.visible ? 'on' : ''}`}
          title="切换底部区 (Ctrl+J)"
          onClick={() => dispatch({ type: 'toggle', container: 'bottom' })}
        >
          <Icon name="layout-panel-bottom" size={15} />
        </button>
        <button
          className={`ghost small toolbar-btn ${layout.aux.visible ? 'on' : ''}`}
          title="切换副侧栏 (Ctrl+Alt+B)"
          onClick={() => dispatch({ type: 'toggle', container: 'aux' })}
        >
          <Icon name="layout-sidebar-right" size={15} />
        </button>
        <button className="ghost small toolbar-btn" title="重置布局" onClick={doReset}>
          <Icon name="reset" size={15} />
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
        {/* 问题计数小件（HK-4 · UI-6）：与约定校验的 `.sb-diag` 相邻；点击打开问题面板 */}
        <ProblemsStatusItem onClick={() => dispatch({ type: 'activate', container: 'bottom', key: 'kojo.problems' })} />
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
          {dirty ? (
            <>
              <Icon name="circle-filled" size={9} /> 未保存
            </>
          ) : (
            '已保存'
          )}
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
          <div
            className={`overlay-host${overlayContribution.size === 'wide' ? ' overlay-host-wide' : ''}`}
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <PanelBody contribution={overlayContribution} />
          </div>
        </div>
      ) : null}
      {settingsOpen ? (
        <div className="overlay-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <div className="overlay-host" role="dialog" aria-modal="true" aria-label="设置" onMouseDown={(e) => e.stopPropagation()}>
            <div className="wizard">
              <h3>设置</h3>

              <div className="settings-group">
                <div className="settings-group-title">视图</div>
                <label className="settings-row">
                  <input
                    type="checkbox"
                    checked={layout.zen}
                    onChange={(e) => dispatch(e.target.checked ? { type: 'toggleZen' } : { type: 'exitZen' })}
                  />
                  <span>
                    写作模式
                    <span className="settings-hint">收起所有面板，只留编辑器。快捷键 Ctrl+K Z，Esc 退出</span>
                  </span>
                </label>
                {/* 居中限宽只在写作模式下有意义——非写作模式时它**什么都控制不了**，
                    所以不是"灰着好看"，而是不给一个点了没反应的控件。 */}
                <label className={`settings-row nested${layout.zen ? '' : ' off'}`}>
                  <input
                    type="checkbox"
                    checked={layout.zenLimitWidth}
                    disabled={!layout.zen}
                    onChange={(e) => dispatch({ type: 'setZenLimitWidth', value: e.target.checked })}
                  />
                  <span>
                    编辑器居中限宽
                    <span className="settings-hint">
                      {layout.zen
                        ? '按一行正文的舒适宽度收拢；关闭则铺满整个窗口'
                        : '需要先开启写作模式'}
                    </span>
                  </span>
                </label>
              </div>

              {/* 动效（UI-5）：应用内的降噪开关，独立于系统级 prefers-reduced-motion */}
              <div className="settings-group">
                <div className="settings-group-title">外观</div>
                <label className="settings-row">
                  <input
                    type="checkbox"
                    checked={motionPref === 'reduced'}
                    onChange={(e) => commitMotionPref(e.target.checked ? 'reduced' : 'full')}
                  />
                  <span>
                    减弱动效
                    <span className="settings-hint">收起面板过渡与入场动画，界面切换更干脆。系统级「减弱动效」设置仍会照常生效</span>
                  </span>
                </label>
              </div>

              {/* 封存总闸（sealed.ts，2026-10-13 试用反馈批）：三件暂不投入的功能整体封存，
                  设置页只留这一个总开关；勾选 = 临时恢复（代码未删，随时可以再关）。 */}
              <div className="settings-group">
                <div className="settings-group-title">封存功能</div>
                <label className="settings-row">
                  <input type="checkbox" checked={!sealed} onChange={(e) => setSealed(!e.target.checked)} />
                  <span>
                    显示已封存功能
                    <span className="settings-hint">
                      语法糖视图（现效果）· 糖预览 · 归档浏览器：试用反馈后已封存，默认隐藏。勾选可临时恢复；代码未删，随时可以再关。
                    </span>
                  </span>
                </label>
              </div>

              {/* 封存态设置页只有一个总开关：「语法糖视图」这一组随总闸收起（勾选总开关即回来） */}
              {!sealed ? (
                <div className="settings-group">
                  <div className="settings-group-title">编辑器</div>
                  <label className="settings-row">
                    <input
                      type="checkbox"
                      checked={sugarViewOn}
                      onChange={(e) => applySugarViewPref(e.target.checked)}
                    />
                    <span>
                      语法糖视图
                      <span className="settings-hint">
                        把游戏目录里的 .ERB 显示成中文表层写法（台词像剧本、条件成「如果 …：」）。
                        只改显示、不改动文件。快捷键 Ctrl+Alt+T
                      </span>
                    </span>
                  </label>
                </div>
              ) : null}

              <div className="settings-group">
                <div className="settings-group-title">布局</div>
                <div className="settings-row static">
                  <button className="ghost small" onClick={doReset}>
                    重置布局
                  </button>
                  <span>
                    恢复默认的面板位置、尺寸与显隐
                    <span className="settings-hint">不影响任何文件内容</span>
                  </span>
                </div>
              </div>

              {/* 单一页脚行，且沿用全站模态房规：primary 恒等于推荐项、排在最右 */}
              <div className="settings-footer">
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
      {floatingPanels.map((p) => {
        const f = layout.floating[p.id];
        if (!f) return null;
        return (
          <section
            key={p.id}
            ref={(node) => {
              const els = floatElsRef.current;
              if (node) els.set(p.id, node);
              else els.delete(p.id);
            }}
            className="floating-panel"
            style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
            aria-label={p.title}
          >
            <header className="floating-panel-head" onMouseDown={(e) => startFloatDrag(e, p.id)}>
              <Icon name={p.icon ?? 'preview'} size={14} />
              <span className="floating-panel-title">{p.title}</span>
              <span className="spacer" />
              <button
                className="ghost small floating-panel-action"
                title="关闭浮窗（回到侧栏）"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => dispatch({ type: 'dock', id: p.id })}
              >
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="floating-panel-body">
              <PanelBody contribution={p} floating />
            </div>
            <div
              className="floating-panel-resize"
              title="拖拽调整大小"
              onMouseDown={(e) => startFloatResize(e, p.id)}
            />
          </section>
        );
      })}
      {overlays}
    </div>
  );
}
