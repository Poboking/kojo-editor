/**
 * 状态注入面板的**组件层**（从 `index.ts` 的 `activate()` 原样迁出；状态机、DOM 结构、
 * className 与文案逐字不变）。
 *
 * 服务与插件上下文由 `index.ts`（内核装载入口 / 槽位注册）注入，本模块只认 plugin-api 契约：
 * 深解析（`snapshot.source`）、注入写侧（`snapshot.writer`）、项目与槽位查询（变量语义标签）。
 * 呈现的四块住在同目录模块：`panel-frame`（工具条 + 非就绪阶段）、`var-list`、
 * `editor-box`、`pending-box`；纯逻辑（目录 / diff / overrides / 窗口）在 `panel-logic.ts`。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  PluginContext,
  PluginContextMenuAnchor,
  ProjectService,
  SnapshotArchive,
  SnapshotInjectionResult,
  SnapshotSourceService,
  SnapshotWriteService,
  SlotRegistry,
  UIPanelProps,
  VariableSchema,
} from '@kojo/plugin-api';
import { growWindow } from '@kojo/plugin-api';
import {
  CELL_WINDOW,
  VAR_WINDOW,
  buildOverrides,
  dedupePending,
  emptySlotsReason,
  runInjectFlow,
  listVars,
  parseCellIndex,
  parseCellInput,
  parseScalarInput,
  scopeOptions,
  supersededCount,
  type PendingEdit,
  type ScopeKind,
} from './panel-logic';
import { VarList } from './var-list';
import {
  copyInjectText,
  openInjectPanelMenu,
  openInjectVarMenu,
  type InjectMenuHost,
} from './context-menu';
import { renderToolbar, renderPhaseBox } from './panel-frame';
import { renderEditor } from './editor-box';
import { renderPendingBox } from './pending-box';

/** `activate()` 注入的面板依赖（插件上下文 + 四个服务；与旧闭包逐项同构） */
export interface InjectorPanelDeps {
  readonly ctx: PluginContext;
  readonly snapshots: SnapshotSourceService;
  readonly writer: SnapshotWriteService;
  readonly project: ProjectService;
  readonly slots: SlotRegistry;
}

/** 构造面板组件：服务与上下文一次性闭包住（槽位注册仍归 `index.ts`） */
export function createInjectorPanel(deps: InjectorPanelDeps): (props: UIPanelProps) => unknown {
  const { ctx, snapshots, writer, project, slots } = deps;
  /** 当前适配器的变量语义查询（按 adapterId 精确匹配；与 condition-extractor 同通道） */
  const schemaLookup = (): VariableSchema | undefined => {
    const current = project.current();
    if (!current) return undefined;
    for (const c of slots.query('game.adapter')) {
      if (c.adapter.gameId !== current.adapterId) continue;
      return c.adapter.variableSchema;
    }
    return undefined;
  };

  /* ------------------------------ 面板组件 ------------------------------ */

  return function InjectorPanel(props: UIPanelProps): unknown {
    /**
     * 扫描结果必须**订阅**，不能只在 render 里读一次 `current()`。
     *
     * 真实故障（2026-10-19 实机审计）：`project.opened` 的扫描是异步的，而面板挂在
     * 记忆化容器（`PanelHost` 的 `PanelBody`）里、壳层重渲不会带着它重算 ⇒ 若面板
     * 在扫描回来之前挂载，`rows` 永远是空数组，阶段永远停在「没有存档」，
     * 且没有任何刷新入口（只有切走再切回来才重挂载）。作者的观感就是「状态注入一次都没成功过」。
     * 订阅后扫描完成会触发一次真实重渲；空态再主动补一次 scan（幂等，引擎有 inFlight 去重）。
     */
    const subscribe = useCallback(
      (onChange: () => void) => snapshots.subscribe(() => onChange()),
      [],
    );
    const scan = useSyncExternalStore(subscribe, () => snapshots.current(), () => snapshots.current());
    const rows = (scan?.entries ?? []).filter((e) => e.meta !== null && !e.error);
    const [path, setPath] = useState<string | null>(null);
    const [archive, setArchive] = useState<SnapshotArchive | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [scope, setScope] = useState<ScopeKind>({ kind: 'top' });
    const [varFilter, setVarFilter] = useState('');
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [scalarDraft, setScalarDraft] = useState('');
    const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({});
    const [newIndexDraft, setNewIndexDraft] = useState('');
    const [newValueDraft, setNewValueDraft] = useState('');
    const [editError, setEditError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingEdit[]>([]);
    const [injecting, setInjecting] = useState(false);
    const [injectError, setInjectError] = useState<string | null>(null);
    const [result, setResult] = useState<SnapshotInjectionResult | null>(null);
    const [armed, setArmed] = useState(false);
    /** 渲染窗口（行数；undefined = 初始窗口——旧实现是变量列表硬截 200 / 单元列表硬截 120） */
    const [varWindow, setVarWindow] = useState<number | undefined>(undefined);
    const [cellWindow, setCellWindow] = useState<number | undefined>(undefined);

    /** 触底 / 点击「显示更多」→ 按 STEP 追加（单调不减、步长有界；算式在契约层 `sugar-panels`） */
    const growVars = useCallback((total: number): void => {
      setVarWindow((prev) => growWindow(prev, total, VAR_WINDOW)); // 无增长原样返回 prev ⇒ 跳过重渲
    }, []);
    const growCells = useCallback((total: number): void => {
      setCellWindow((prev) => growWindow(prev, total, CELL_WINDOW)); // 同上：无增长不重渲
    }, []);

    /** 选档路径镜像（异步回包的归属守卫判据，见 runInjectFlow 注释） */
    const pathRef = useRef(path);
    useEffect(() => {
      pathRef.current = path;
    }, [path]);

    /**
     * 空态自愈：面板先于扫描挂载（或扫描被项目切换作废）时补一次 scan。
     * `scan()` 幂等（引擎 inFlight 去重 + 代际号作废），失败不在此吞掉——
     * 扫描本身的错误由引擎记日志，面板只关心有没有档位。
     *
     * `scanning` 是**界面事实**（按钮置灰 + 「正在扫描」文案），不是引擎状态：
     * 引擎没有暴露在飞标志，而面板必须能区分「扫描中」与「扫完了、一个都没有」。
     */
    const [scanning, setScanning] = useState(false);
    const rescan = useCallback((): void => {
      setScanning(true);
      void snapshots
        .scan()
        .catch((err: unknown) => ctx.log.warn(`Injector: scan failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => setScanning(false));
    }, []);

    useEffect(() => {
      if (snapshots.current() === null) rescan();
    }, []);

    /**
     * 换项目（扫描目录变化）⇒ 丢掉上一个项目的选档与待注入清单。
     * 旧实现只在选档变化时清状态；项目 A 的档位路径会带进项目 B 的界面，
     * 后续「注入」会拿 A 的路径去写（内核闸会拒，但界面已经误导）。
     */
    const scanDir = scan?.dir ?? null;
    const scanDirRef = useRef<string | null>(null);
    useEffect(() => {
      if (scanDirRef.current === scanDir) return;
      scanDirRef.current = scanDir;
      setPath(null);
      setArchive(null);
      setLoadError(null);
      setPending([]);
      setResult(null);
      setInjectError(null);
      setArmed(false);
    }, [scanDir]);

    /** 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入；缺省回退纯文本字形（绝不空白） */
    const ic = (name: string, size: number, fallback: string): ReactNode =>
      (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

    // 归档浏览器选中档 → 预填（UI 插件间零直接依赖，走内核事件）
    useEffect(() => {
      const un = ctx.bus.on('kojo.snapshotSelected', (p) => setPath(p.path));
      return un;
    }, []);

    // 选档变化 → 深解析（keepRaw + 全量 cells：写侧 passthrough / 补丁合并的前置）
    useEffect(() => {
      setArchive(null);
      setLoadError(null);
      setSelectedKey(null);
      setPending([]);
      setResult(null);
      setInjectError(null);
      setArmed(false);
      setScope({ kind: 'top' });
      setVarWindow(undefined); // 换档 = 新变量树，窗口回到初始
      setCellWindow(undefined);
      if (!path) return;
      setLoading(true);
      let cancelled = false;
      void snapshots
        .parse(path, { keepArrayCells: true, keepRaw: true })
        .then((a) => {
          if (cancelled) return;
          setArchive(a);
          // 默认定位第一个角色块（无角色块 → 顶层）
          const first = (a.chars ?? [])[0];
          setScope(first ? { kind: 'char', blockIndex: first.index } : { kind: 'top' });
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [path]);

    const varSchema = schemaLookup();
    /**
     * 回收行开关（宿主下传的容器偏好；**缺省 / false = 改动前的追加式路径** + 「显示更多」哨兵）。
     *
     * 这块面板是**数据录入面**（作者往单元格里打日文），窗口化会同时动到两件事：
     * 键盘能点到哪些行、正在输入的那一行还在不在 DOM 里。既然改了键盘语义就得让人能
     * 一键退回旧行为——与条件矩阵同一口径，也符合契约「偏好缺省 = 最保守值」。
     * 开起来后由 `list-window` 保证"可数 / 可达 / 输入中的行不被摘"三条不变量。
     */
    const virtualize = props.uiPrefs?.panelVirtualize === true;
    // ---- 三处每帧重算的账单收进记忆化（PS-7；面板里除注入外全是只读路径） ----
    // 变量目录：旧实现每次渲染都 `listVars` ——一个角色块几百个变量、数组变量的单元表
    // 逐帧重建（改前还逐格深拷贝）。档案实例与作用域对象都不变 ⇒ 复用上一次结果。
    const rowsInScope = useMemo(() => (archive ? listVars(archive, scope) : []), [archive, scope]);
    const needle = varFilter.trim().toLowerCase();
    const filtered = useMemo(
      () => (needle ? rowsInScope.filter((r) => r.key.toLowerCase().includes(needle)) : rowsInScope),
      [rowsInScope, needle],
    );
    const selected = useMemo(() => (selectedKey ? filtered.find((r) => r.key === selectedKey) ?? null : null), [
      filtered,
      selectedKey,
    ]);
    // 作用域下拉的标签（一次线性扫描；见 panel-logic 的 scopeOptions）
    const scopeOpts = useMemo(() => (archive ? scopeOptions(archive) : []), [archive]);

    const addPending = (e: PendingEdit): void => {
      setEditError(null);
      const superseded = supersededCount(pending, e);
      setPending([...dedupePending([...pending, e])]);
      if (superseded > 0) ctx.log.info(`Injector: ${superseded} earlier edit(s) superseded by the latest one`);
    };

    const submitScalar = (): void => {
      if (!selected || selected.kind !== 'scalar') return;
      const type = selected.type === 'int' ? 'int' : 'str';
      const parsed = parseScalarInput(type, scalarDraft);
      if (!parsed.ok) {
        setEditError(parsed.error);
        return;
      }
      addPending({
        scope,
        key: selected.key,
        kind: 'scalar',
        oldValue: selected.scalarValue ?? null,
        newValue: parsed.value,
      });
      setScalarDraft('');
    };

    const submitCell = (index: readonly number[], draft: string, oldValue: number | string | null): void => {
      if (!selected || selected.kind !== 'array') return;
      const isInt = selected.type.startsWith('int-array');
      const parsed = parseCellInput(isInt, draft);
      if (!parsed.ok) {
        setEditError(parsed.error);
        return;
      }
      addPending({
        scope,
        key: selected.key,
        kind: 'cell',
        // 清单是可变数据：到这里才拷贝一次（渲染路径上的单元表全程引用深解析结果，零拷贝）
        index: [...index],
        oldValue,
        newValue: parsed.value,
      });
    };

    /** 单元行「加入清单」：提交后清掉该格草稿（与旧行为一致：解析失败也清） */
    const submitCellFromRow = (index: readonly number[], draft: string, oldValue: number | string): void => {
      submitCell(index, draft, oldValue);
      const next = { ...cellDrafts };
      delete next[index.join(',')];
      setCellDrafts(next);
    };

    /** 选中变量行：选中 + 清空编辑草稿与单元窗口（换变量即开新窗口） */
    const selectVar = (key: string): void => {
      setSelectedKey(key);
      setEditError(null);
      setScalarDraft('');
      setCellDrafts({});
      setCellWindow(undefined);
    };

    const submitNewCell = (): void => {
      if (!selected || selected.kind !== 'array' || !selected.saveLen) return;
      const idx = parseCellIndex(selected.saveLen, newIndexDraft);
      if (!idx.ok) {
        setEditError(idx.error);
        return;
      }
      const existing = (selected.cells ?? []).find((c) => c.index.join(',') === idx.index.join(','));
      const isInt = selected.type.startsWith('int-array');
      const parsed = parseCellInput(isInt, newValueDraft);
      if (!parsed.ok) {
        setEditError(parsed.error);
        return;
      }
      addPending({
        scope,
        key: selected.key,
        kind: 'cell',
        index: idx.index,
        oldValue: existing ? existing.value : null,
        newValue: parsed.value,
      });
      setNewIndexDraft('');
      setNewValueDraft('');
    };

    const runInject = (): void => {
      if (!path || pending.length === 0 || injecting) return;
      if (!armed) {
        setArmed(true);
        return;
      }
      setArmed(false);
      setInjecting(true);
      setInjectError(null);
      const overrides = buildOverrides(dedupePending(pending));
      const selectedAtStart = path;
      void runInjectFlow(
        {
          inject: (p, ov) => writer.inject(p, ov),
          parse: (p, opts) => snapshots.parse(p, opts),
        },
        { path, overrides, stillSelected: () => pathRef.current === selectedAtStart },
        {
          onInjected: (r) => {
            setResult(r);
            setPending([]);
          },
          onReloaded: (a) => setArchive(a),
          onFailed: (msg) => setInjectError(msg),
          onDropped: () => {
            // 换档后旧回包整链丢弃：新档的变量树已由选档 effect 装好，这里不动任何状态
            ctx.log.info('Inject flow dropped: snapshot switched mid-inject');
          },
        },
      ).finally(() => setInjecting(false));
    };

    /* ------------------------------ 渲染 ------------------------------ */

    const head = renderToolbar({ path, rows, setPath, scanning, onRescan: rescan });

    const phaseBox = renderPhaseBox({
      head,
      hasSlots: project.current() != null && rows.length > 0,
      path,
      loading,
      loadError,
      hasArchive: archive !== null,
      // 空态按真实成因细分（无项目 / 无存档目录 / 扫描中 / 零档 / 全解析失败）
      emptyReason: emptySlotsReason({
        hasProject: project.current() != null,
        scanDir: scan?.dir ?? null,
        total: (scan?.entries ?? []).length,
        valid: rows.length,
        scanning,
      }),
      onRescan: rescan,
    });
    if (phaseBox) return phaseBox;
    // panelPhase 判为 ready 即必有解析结果（`hasArchive: archive !== null` 就是同一份
    // 状态，`!hasArchive` 已在 'error' 分支返回 ⇒ 运行时到不了这里）。这一行留着的
    // 理由是**类型收窄**：下面 `renderEditor` 的选中行与作用域下拉的渲染都要非空形，
    // 去掉它就得换 `archive!`（把可判定的守卫换成不可判定的断言，不划算）。
    if (!archive) return null;

    // 作用域下拉（选项与标签取自 `scopeOpts`：一次算好，不再逐帧重扫角色块）
    const scopeSel = createElement('select', {
      className: 'inj-select',
      value: scope.kind === 'char' ? `char:${scope.blockIndex}` : scope.kind,
      onChange: (e: { target: { value: string } }) => {
        const v = e.target.value;
        setSelectedKey(null);
        setEditError(null);
        setVarWindow(undefined); // 换作用域 = 新变量目录，窗口回到初始
        setCellWindow(undefined);
        if (v === 'top') setScope({ kind: 'top' });
        else if (v === 'em') setScope({ kind: 'em' });
        else setScope({ kind: 'char', blockIndex: Number(v.slice(5)) });
      },
    },
      ...scopeOpts.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
    );

    // 变量目录（窗口化渲染：初窗 ≤ INITIAL，触底 / 点击「显示更多」按 STEP 追加）
    /**
     * 右键菜单落点（1023 批）：两条都接回面板已有的动作（`rescan` 与剪贴板），
     * 复制失败写进已有的 `editError` 那一行，不另起浮层。
     */
    const menuHost: InjectMenuHost = {
      rescan,
      copy: (text) => {
        void copyInjectText(text).then((ok) => {
          setEditError(ok ? null : '复制失败：当前环境不允许写剪贴板');
          if (!ok) ctx.log.warn('状态注入复制失败：剪贴板不可用');
        });
      },
    };

    const varList = createElement(VarList, {
      rows: filtered,
      selectedKey,
      schema: varSchema,
      limit: varWindow,
      onGrow: growVars,
      onSelect: selectVar,
      virtualize,
      onMenu: (row, event) =>
        openInjectVarMenu(
          props,
          event,
          { key: row.key, kind: row.kind, ...(row.scalarValue === undefined ? {} : { scalarValue: row.scalarValue }) },
          menuHost,
        ),
    });

    // 编辑区
    const editor = renderEditor({
      selected,
      varSchema,
      scalarDraft,
      setScalarDraft,
      submitScalar,
      cellDrafts,
      setCellDrafts,
      cellWindow,
      growCells,
      submitCellFromRow,
      newIndexDraft,
      setNewIndexDraft,
      newValueDraft,
      setNewValueDraft,
      submitNewCell,
      virtualize,
    });

    const pendingBox = renderPendingBox({
      pending,
      varSchema,
      injecting,
      armed,
      result,
      injectError,
      ic,
      runInject,
      setPending,
      setArmed,
    });

    return createElement('div', {
      className: 'panel-snapshot-injector',
      // 空白处右键（1023 批）：重新扫描 · 复制档位路径
      onContextMenu: (event: PluginContextMenuAnchor) =>
        openInjectPanelMenu(props, event, { path, scanning }, menuHost),
    },
      head,
      createElement('div', { className: 'inj-body' },
        createElement('div', { className: 'inj-left' }, scopeSel, varList),
        createElement('div', { className: 'inj-right' }, editor, pendingBox)),
      editError ? createElement('div', { className: 'inj-error' }, editError) : null,
    );
  }
}
