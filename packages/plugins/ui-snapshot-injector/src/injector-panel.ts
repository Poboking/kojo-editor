/**
 * 状态注入面板的**组件层**（从 `index.ts` 的 `activate()` 原样迁出；状态机、DOM 结构、
 * className 与文案逐字不变）。
 *
 * 服务与插件上下文由 `index.ts`（内核装载入口 / 槽位注册）注入，本模块只认 plugin-api 契约：
 * 深解析（`snapshot.source`）、注入写侧（`snapshot.writer`）、项目与槽位查询（变量语义标签）。
 * 呈现的四块住在同目录模块：`panel-frame`（工具条 + 非就绪阶段）、`var-list`、
 * `editor-box`、`pending-box`；纯逻辑（目录 / diff / overrides / 窗口）在 `panel-logic.ts`。
 */

import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  GameAdapter,
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
import { activeGameAdapter, growWindow } from '@kojo/plugin-api';
import {
  CELL_WINDOW,
  VAR_WINDOW,
  buildOverrides,
  dedupePending,
  emptySlotsReason,
  filterVarRows,
  quickEditRows,
  quickEditToPending,
  runInjectFlow,
  listVars,
  parseCellIndex,
  parseCellInput,
  parseScalarInput,
  scopeLabel,
  scopeOptions,
  supersededCount,
  type PendingEdit,
  type QuickEditRow,
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
  /** 当前适配器（变量语义标签与「常用状态」策展表都认这一枚；与 condition-extractor 同通道） */
  const adapterLookup = (): GameAdapter | undefined =>
    activeGameAdapter(slots.query('game.adapter'), project.current()?.adapterId);
  const schemaLookup = (): VariableSchema | undefined => adapterLookup()?.variableSchema;

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

    /**
     * 上次改的那一档（口上调试 UI 打磨批）：副侧栏同一时刻只挂一块面板，
     * 切去「看这段会怎样」再切回来，本面板是重新挂载的——不记档位就要重选一次。
     * 存在**本插件自己的域**里（内核按 pluginId 隔离，不跨域读别人的记录）。
     * 还原等到扫描结果到位、且这一档真在清单里才落：删掉的档不会被还原成一个坏选择。
     */
    const storedPathRef = useRef<string | null>(null);
    useEffect(() => {
      void ctx.storage
        .get<string>('last-archive')
        .then((v) => {
          if (typeof v === 'string' && v !== '') storedPathRef.current = v;
        })
        .catch(() => undefined);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
      const want = storedPathRef.current;
      if (want === null || path !== null) return;
      if (rows.some((r) => r.path === want)) setPath(want);
    }, [path, rows]);
    useEffect(() => {
      if (path === null) return;
      void ctx.storage.set('last-archive', path).catch(() => undefined);
    }, [path]);

    /** 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入；缺省回退纯文本字形（绝不空白） */    const ic = (name: string, size: number, fallback: string): ReactNode =>
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
      setQuickDrafts({}); // 换档 = 常用卡的值全变了，草稿一并清
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
    /** 「常用状态」策展表（adapter 缺省 = 空表 ⇒ 不渲染快捷卡，不猜任何字段） */
    const quickFields = useMemo(() => adapterLookup()?.quickEditFields ?? [], []);
    /** 「常用」卡输入草稿（键 = 策展项 id；换作用域 / 换档即清） */
    const [quickDrafts, setQuickDrafts] = useState<Record<string, string>>({});
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
    /** 目录过滤：变量名与中文标签都参与（搜「好感」能命中 CFLAG，见 panel-logic） */
    const filtered = useMemo(
      () => filterVarRows(rowsInScope, varFilter, varSchema),
      [rowsInScope, varFilter, varSchema],
    );
    /** 「常用」卡数据：按当前作用域解析策展项 + 当前值（纯函数，换档 / 换作用域重算） */
    const quickRows = useMemo(
      () => (archive && quickFields.length > 0 ? quickEditRows(quickFields, archive, scope, varSchema) : []),
      [archive, quickFields, scope, varSchema],
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

    /** 「常用」卡提交：草稿解析 → 待注入编辑（解析失败走既有错误行，不静默） */
    const submitQuick = (row: QuickEditRow): void => {
      const raw = (quickDrafts[row.field.id] ?? '').trim();
      if (raw.length === 0) return;
      const parsed = quickEditToPending(row, scope, raw);
      if (!parsed.ok) {
        setEditError(parsed.error);
        return;
      }
      addPending(parsed.edit);
      setQuickDrafts((prev) => ({ ...prev, [row.field.id]: '' }));
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
            // 口上调试统一批：广播「这份存档刚被注入」——回放面板监听后对同档
            // 自动重算，作者不用在两个面板间手动来回（热闭环）。
            ctx.bus.emit('debug.snapshotInjected', { archivePath: r.path, source: 'ui-snapshot-injector' });
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

    /**
     * 面板头（口上调试 UI 打磨批）：与回放面板同一套 `.dbg-head`，右上一枚跳转。
     *
     * 为什么要有这枚跳转：作者的真实动作是"改一个数值 → 看这句话会不会出现"。
     * 两个面板按职责分开注册（写档是危险动作，回放是只读），但动作是一条——
     * 这里给过去的路，`debug.snapshotInjected` 再把结果送回来（写完整份存档会
     * 广播，回放面板对同档自动重算）。
     */
    const dbgHead = createElement(
      'div',
      { className: 'dbg-head' },
      createElement(
        'div',
        { className: 'dbg-head-row' },
        createElement('span', { className: 'dbg-head-title' }, '改这个状态'),
        createElement(
          'button',
          {
            className: 'dbg-jump',
            type: 'button',
            title: '拿这份存档去看这一段会说什么（回放面板）',
            onClick: () => ctx.bus.emit('ui.panel.reveal', { id: 'state-replay', source: 'snapshot-injector' }),
          },
          '看台词 →',
        ),
      ),
      createElement(
        'div',
        { className: 'dbg-head-sub' },
        '改完先进清单，确认后才写盘。',
      ),
    );

    const head = createElement(
      Fragment,
      null,
      dbgHead,
      renderToolbar({ path, rows, setPath, scanning, onRescan: rescan }),
    );

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
    const scopeSel = createElement('div', { className: 'inj-scope-wrap' },
      createElement('select', {
        className: 'inj-select',
        value: scope.kind === 'char' ? `char:${scope.blockIndex}` : scope.kind,
        onChange: (e: { target: { value: string } }) => {
          const v = e.target.value;
          setSelectedKey(null);
          setEditError(null);
          setVarWindow(undefined); // 换作用域 = 新变量目录，窗口回到初始
          setCellWindow(undefined);
          setQuickDrafts({}); // 换作用域 = 常用卡换了一批行，草稿一并清
          if (v === 'top') setScope({ kind: 'top' });
          else if (v === 'em') setScope({ kind: 'em' });
          else setScope({ kind: 'char', blockIndex: Number(v.slice(5)) });
        },
      },
        ...scopeOpts.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
      ),
      // 一句白话路标：新作者不知道「角色块 / 主变量区」是什么，但知道要改谁
      createElement('div', { className: 'dim inj-hint' },
        '要改某个角色的状态就选她的名字；金钱、日期这些全局的选「主变量区」。'));

    // 变量搜索框（键名与中文标签都参与匹配，见 filterVarRows）。
    // 2026-11-02 补挂：`varFilter` 状态从旧版一路留下、过滤逻辑一直在算，但输入框
    // 没被渲染——搜索功能整段只能算死代码。这是「找不到要改哪」的直接原因之一。
    const filterInput = createElement('input', {
      className: 'inj-input inj-var-filter',
      value: varFilter,
      placeholder: '搜变量：英文名或中文（如 好感 / CFLAG）',
      onChange: (e: { target: { value: string } }) => setVarFilter(e.target.value),
    });

    /** 常用卡的标题：角色作用域带角色名（复用作用域下拉的同一套标签，不另立口径） */
    const quickTitle = scope.kind === 'char'
      ? `常用 · ${scopeOpts.find((o) => o.value === `char:${scope.blockIndex}`)?.label ?? `角色 #${scope.blockIndex}`}`
      : '常用 · 全局';

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
      // 过滤后空 ≠ 作用域真空：给一句说明成因的文案，不让人以为角色没变量
      emptyText: filtered.length === 0 && rowsInScope.length > 0 ? `没有匹配「${varFilter.trim()}」的变量` : undefined,
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
      // 位置白话化：`chars[0]` → 「#0 阿蕾」（待写入是确认前的最后一眼，理应是白话）
      scopeLabelOf: (s) => scopeLabel(archive, s),
    });

    /**
     * 「常用」卡（quickEditFields 投影；无策展表 / 当前作用域没有可用的项 ⇒ 不渲染）。
     * 一行一个高频状态：人话标签 + 当前值 + 一个输入框——族头、下标、作用域
     * 全部由 quickEditToPending 按策展项换算，作者不需要知道 CFLAG 是什么。
     */
    const quickBox = quickRows.length > 0
      ? createElement('div', { className: 'inj-quick' },
          createElement('div', { className: 'inj-quick-head' }, quickTitle),
          ...quickRows.map((row) => {
            const draft = quickDrafts[row.field.id] ?? '';
            return createElement('div', { className: 'inj-quick-row', key: row.field.id },
              createElement('span', { className: 'inj-quick-label', title: row.field.description }, row.label),
              createElement('span', { className: 'inj-quick-current dim' }, String(row.current)),
              createElement('input', {
                className: 'inj-input inj-quick-input',
                value: draft,
                placeholder: row.intLike ? '新数值' : '新内容',
                title: row.field.description,
                onChange: (e: { target: { value: string } }) =>
                  setQuickDrafts((prev) => ({ ...prev, [row.field.id]: e.target.value })),
                onKeyDown: (e: { key: string }) => {
                  if (e.key === 'Enter') submitQuick(row);
                },
              }),
              createElement('button', {
                className: 'ghost small',
                disabled: draft.trim().length === 0,
                onClick: () => submitQuick(row),
              }, '加入清单'));
          }))
      : null;

    return createElement('div', {
      className: 'panel-snapshot-injector',
      // 空白处右键（1023 批）：重新扫描 · 复制档位路径
      onContextMenu: (event: PluginContextMenuAnchor) =>
        openInjectPanelMenu(props, event, { path, scanning }, menuHost),
    },
      head,
      /**
       * 「常用」提到两栏之上（口上调试 UI 打磨批）：副侧栏只有 ~300px，两栏一换行就变成
       * 上下堆叠——而 DOM 顺序是"变量表在前、常用在后"，窄面板里新手第一眼看到的成了
       * 一整串 CFLAG/TFLAG。常用卡是"改什么"的快捷答案，理应横跨整宽排在最前。
       */
      quickBox,
      createElement('div', { className: 'inj-body' },
        createElement('div', { className: 'inj-left' }, filterInput, scopeSel, varList),
        createElement('div', { className: 'inj-right' }, editor, pendingBox)),
      editError ? createElement('div', { className: 'inj-error' }, editError) : null,
    );
  }
}
