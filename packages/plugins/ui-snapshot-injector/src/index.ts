/**
 * @kojo/plugin-ui-snapshot-injector
 *
 * 状态注入面板（`ui.panel` 槽贡献；v0.2 第十五批，实施记录 §5.22）。
 *
 * 把「改槽注入」做成端到端可用的写链路（呈现 + 意图层）：
 *   选档 → 深解析（keepRaw，从 snapshot.source 列档出发，不重复扫描）→
 *   定位作用域（角色块 / 主变量区 / EM 扩展区）与变量 → 编辑标量 / 单元 →
 *   预览 diff（改前 / 改后）→ 确认注入。
 *
 * 写盘链路在 sav-parser（`snapshot.writer`）：serializePayload（未修变量
 * passthrough + Int64 守卫，大数拒绝显式报错）→ 容器组装 → 写前备份 →
 * kernel io 写入（writablePaths 第一道闸 + Rust 写允许域第二道闸）→
 * 回读验证。面板只消费结果 / 错误（含备份位置提示），不自建写逻辑。
 *
 * 分层（"一切皆插件"）：
 *   - 纯逻辑（目录 / diff / overrides 构建）在 `panel-logic.ts`（零 React 可单测）；
 *   - 变量语义标签（可选）来自当前 game adapter 的 variableSchema（槽位查询透传）。
 */

import { createElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type {
  Plugin,
  ProjectService,
  SnapshotArchive,
  SnapshotInjectionResult,
  SnapshotSourceService,
  SnapshotWriteService,
  SlotRegistry,
  UIPanelProps,
  VariableSchema,
} from '@kojo/plugin-api';
import {
  KernelServices,
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  WellKnownServices,
  attachGrowSentinel,
  growWindow,
  moreRowLabel,
} from '@kojo/plugin-api';
import {
  CELL_WINDOW,
  VAR_WINDOW,
  buildOverrides,
  cellLabel,
  cellWindowSize,
  dedupePending,
  runInjectFlow,
  diffRows,
  listScopes,
  listVars,
  panelPhase,
  parseCellIndex,
  parseCellInput,
  parseScalarInput,
  scopeLabel,
  supersededCount,
  varLabel,
  varWindowSize,
  type PendingEdit,
  type ScopeKind,
  type VarRow,
} from './panel-logic';

/* ------------------------------ 渲染窗口 ------------------------------ */

/**
 * 「显示更多」哨兵（变量目录 / 单元列表共用）。观察器行为核住在契约层
 * `sugar-panels` 的 `attachGrowSentinel`（进入滚动视口即自动追加下一窗；
 * 观察器不可用——SSR / 测试 / 旧环境——时返回空退订 ⇒ 退化为**纯点击按钮**，
 * 功能不丢）。外观三件套（样式 / 悬停提示 / 「显示更多（还剩 N）」）与其余面板同源
 * 同值，**className 仍是本面板自己的 `inj-more-btn`**（视觉口径不漂）。
 * ref 用稳定回调 ref 拿真实节点，避免每次渲染重挂 observer；回调只在**触发时**经
 * `onMoreRef` 取最新值（observer 只挂一次，捕获旧闭包 = 窗口行为静默改变）。
 */
function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return createElement(
    'button',
    {
      ref: setAnchor,
      className: 'ghost small dim inj-more-btn',
      style: MORE_ROW_STYLE,
      title: MORE_ROW_TITLE,
      onClick: () => onMore(),
    },
    moreRowLabel(remaining),
  );
}

/** 变量目录（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface VarListProps {
  /** 已过滤（过滤语义在面板层，组件只渲染窗口） */
  readonly rows: readonly VarRow[];
  readonly selectedKey: string | null;
  /** 变量语义标签查询（适配器 variableSchema 透传；undefined = 无标签，照常渲染） */
  readonly schema: VariableSchema | undefined;
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 growWindow(prev, total, VAR_WINDOW) 计算） */
  readonly onGrow: (total: number) => void;
  /** 选中变量（选中 / 清空编辑草稿语义留在面板层） */
  readonly onSelect: (key: string) => void;
}

export function VarList(props: VarListProps): ReactElement {
  const { rows } = props;
  const win = varWindowSize(rows.length, props.limit);
  return createElement(
    'div',
    { className: 'inj-vars' },
    ...rows.slice(0, win).map((r) => {
      const label = varLabel(props.schema, r.key);
      return createElement(
        'button',
        {
          key: r.key,
          className: `inj-var-row${props.selectedKey === r.key ? ' active' : ''}${r.kind === 'other' ? ' disabled' : ''}`,
          disabled: r.kind === 'other',
          title: r.cellsTruncated ? '该数组未能完整读取，无法改写' : r.preview,
          onClick: () => props.onSelect(r.key),
        },
        createElement('span', { className: 'inj-var-key' }, r.key),
        label ? createElement('span', { className: 'inj-var-label' }, label) : null,
        createElement('span', { className: 'inj-var-preview dim' }, r.preview),
        r.cellsTruncated ? createElement('span', { className: 'inj-warn' }, '未完整读取') : null,
      );
    }),
    rows.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: rows.length - win,
          onMore: () => props.onGrow(rows.length),
        })
      : null,
    rows.length === 0 ? createElement('div', { className: 'dim inj-empty' }, '该作用域没有变量') : null,
  );
}

/** 数组单元编辑行（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface CellRowsProps {
  readonly cells: ReadonlyArray<{ index: number[]; value: number | string }>;
  /** 单元语义标签查询的变量键（适配器 variableSchema 透传） */
  readonly varKey: string;
  readonly schema: VariableSchema | undefined;
  /** 草稿（键 = 下标 join(',')；状态归面板层，保证换变量即清） */
  readonly drafts: Readonly<Record<string, string>>;
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 growWindow(prev, total, CELL_WINDOW) 计算） */
  readonly onGrow: (total: number) => void;
  readonly onDraft: (cellKey: string, value: string) => void;
  /** 「加入清单」（parse 校验 / 入清单语义留在面板层） */
  readonly onSubmit: (index: number[], draft: string, oldValue: number | string) => void;
}

export function CellRows(props: CellRowsProps): ReactElement {
  const { cells } = props;
  const win = cellWindowSize(cells.length, props.limit);
  return createElement(
    'div',
    { className: 'inj-cells' },
    ...cells.slice(0, win).map((c) => {
      const ik = c.index.join(',');
      const draft = props.drafts[ik] ?? '';
      const changed = draft.trim() !== '' && draft !== String(c.value);
      const cellLbl = cellLabel(props.schema, props.varKey, c.index);
      return createElement(
        'div',
        { key: ik, className: 'inj-cell-row' },
        createElement('span', { className: 'inj-cell-index' }, `[${ik}]`),
        cellLbl ? createElement('span', { className: 'inj-var-label' }, cellLbl) : null,
        createElement('span', { className: 'inj-cell-old' }, String(c.value)),
        createElement('input', {
          className: 'inj-input inj-cell-input',
          value: draft,
          placeholder: '新值',
          onChange: (e: { target: { value: string } }) => props.onDraft(ik, e.target.value),
        }),
        createElement(
          'button',
          {
            className: 'ghost small',
            disabled: !changed,
            onClick: () => props.onSubmit(c.index, draft, c.value),
          },
          changed ? '加入清单' : '—',
        ),
      );
    }),
    cells.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: cells.length - win,
          onMore: () => props.onGrow(cells.length),
        })
      : null,
  );
}

export function createUiSnapshotInjectorPlugin(): Plugin {
  return {
    id: 'ui-snapshot-injector',
    version: '0.2.0',
    requires: [
      WellKnownServices.SnapshotSource,
      WellKnownServices.SnapshotWriter,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const snapshots = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const writer = ctx.inject<SnapshotWriteService>(WellKnownServices.SnapshotWriter);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

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

      function InjectorPanel(props: UIPanelProps): unknown {
        const scan = snapshots.current();
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
        const rowsInScope = archive ? listVars(archive, scope) : [];
        const filtered = varFilter.trim()
          ? rowsInScope.filter((r) => r.key.toLowerCase().includes(varFilter.trim().toLowerCase()))
          : rowsInScope;
        const selected: VarRow | null = selectedKey ? filtered.find((r) => r.key === selectedKey) ?? null : null;

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

        const submitCell = (index: number[], draft: string, oldValue: number | string | null): void => {
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
            index,
            oldValue,
            newValue: parsed.value,
          });
        };

        /** 单元行「加入清单」：提交后清掉该格草稿（与旧行为一致：解析失败也清） */
        const submitCellFromRow = (index: number[], draft: string, oldValue: number | string): void => {
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

        const sel = createElement('select', {
          className: 'inj-select',
          value: path ?? '',
          onChange: (e: { target: { value: string } }) => {
            setPath(e.target.value || null);
          },
        },
          createElement('option', { key: '', value: '' }, '选择档位…'),
          ...rows.map((e) =>
            createElement('option', { key: e.path, value: e.path },
              `${e.fileName} — ${e.meta?.saveMes || `${e.meta?.charCount ?? '?'} 角色`}`),
          ),
        );

        const head = createElement('div', { className: 'inj-toolbar' },
          createElement('span', { className: 'dim' }, '改写存档变量（写前自动备份 · 写后校验）'),
          sel,
        );

        switch (panelPhase({
          hasSlots: project.current() != null && rows.length > 0,
          path,
          loading,
          loadError,
          hasArchive: archive !== null,
        })) {
          case 'no-slots':
            return createElement('div', { className: 'panel-snapshot-injector' }, head,
              createElement('div', { className: 'inj-empty dim' }, '打开项目并扫描到存档后可用（存档列表来自「归档浏览器」面板）'));
          case 'no-selection':
            return createElement('div', { className: 'panel-snapshot-injector' }, head,
              createElement('div', { className: 'inj-empty dim' }, '请从上方选择要改写的存档'));
          case 'loading':
            return createElement('div', { className: 'panel-snapshot-injector' }, head,
              createElement('div', { className: 'inj-empty dim' }, '正在读取存档…'));
          case 'error':
            return createElement('div', { className: 'panel-snapshot-injector' }, head,
              createElement('div', { className: 'inj-error' }, `读取存档失败：${loadError ?? '未知原因'}`));
          case 'ready':
            break;
        }
        // panelPhase 判为 ready 即必有解析结果（`hasArchive: archive !== null` 就是同一份
        // 状态，`!hasArchive` 已在 'error' 分支返回 ⇒ 运行时到不了这里）。这一行留着的
        // 理由是**类型收窄**：下面 `listScopes(archive)` / `scopeLabel(archive, s)` 要非空
        // 形，去掉它就得换 `archive!`（把可判定的守卫换成不可判定的断言，不划算）。
        if (!archive) return null;

        // 作用域下拉
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
          ...listScopes(archive).map((s) =>
            createElement('option', { key: scopeLabel(archive, s), value: s.kind === 'char' ? `char:${s.blockIndex}` : s.kind },
              scopeLabel(archive, s))),
        );

        // 变量目录（窗口化渲染：初窗 ≤ INITIAL，触底 / 点击「显示更多」按 STEP 追加）
        const varList = createElement(VarList, {
          rows: filtered,
          selectedKey,
          schema: varSchema,
          limit: varWindow,
          onGrow: growVars,
          onSelect: selectVar,
        });

        // 编辑区
        let editor: ReturnType<typeof createElement> | null = null;
        if (selected && selected.kind === 'scalar') {
          const intLike = selected.type === 'int';
          const scalarLabel = varLabel(varSchema, selected.key);
          editor = createElement('div', { className: 'inj-editor' },
            createElement('div', { className: 'inj-editor-head' },
              createElement('span', { className: 'inj-var-key' }, selected.key),
              scalarLabel ? createElement('span', { className: 'inj-var-label' }, scalarLabel) : null,
              createElement('span', { className: 'dim' }, ` 当前：${String(selected.scalarValue ?? '')}`)),
            createElement('div', { className: 'inj-editor-row' },
              createElement('input', {
                className: 'inj-input',
                value: scalarDraft,
                placeholder: intLike ? '新整数值' : '新字符串值',
                onChange: (e: { target: { value: string } }) => setScalarDraft(e.target.value),
              }),
              createElement('button', { className: 'ghost small', onClick: () => submitScalar() }, '加入清单')),
            createElement('div', { className: 'dim inj-hint' },
              intLike ? '只能填整数；数值过大会被拒绝' : '字符串按存档原编码写回'),
          );
        } else if (selected && selected.kind === 'array' && selected.cells) {
          const isInt = selected.type.startsWith('int-array');
          const arrLabel = varLabel(varSchema, selected.key);
          editor = createElement('div', { className: 'inj-editor' },
            createElement('div', { className: 'inj-editor-head' },
              createElement('span', { className: 'inj-var-key' }, selected.key),
              arrLabel ? createElement('span', { className: 'inj-var-label' }, arrLabel) : null,
              createElement('span', { className: 'dim' }, ` ${selected.cells.length} 个非空单元`)),
            createElement(CellRows, {
              cells: selected.cells,
              varKey: selected.key,
              schema: varSchema,
              drafts: cellDrafts,
              limit: cellWindow,
              onGrow: growCells,
              onDraft: (ik: string, v: string) => setCellDrafts({ ...cellDrafts, [ik]: v }),
              onSubmit: submitCellFromRow,
            }),
            createElement('div', { className: 'inj-editor-row inj-new-cell' },
              createElement('input', {
                className: 'inj-input inj-cell-index-input',
                value: newIndexDraft,
                placeholder: `新单元下标（${selected.saveLen!.map((n) => `0..${n - 1}`).join(',')}）`,
                onChange: (e: { target: { value: string } }) => setNewIndexDraft(e.target.value),
              }),
              createElement('input', {
                className: 'inj-input',
                value: newValueDraft,
                placeholder: isInt ? '整数值' : '字符串值',
                onChange: (e: { target: { value: string } }) => setNewValueDraft(e.target.value),
              }),
              createElement('button', { className: 'ghost small', onClick: () => submitNewCell() }, '加入清单')),
            createElement('div', { className: 'dim inj-hint' },
              isInt ? '只能填整数；数值过大会被拒绝' : '字符串按存档原编码写回'),
          );
        }

        // diff 清单 + 注入按钮
        const diffs = diffRows(dedupePending(pending));
        const pendingBox = createElement('div', { className: 'inj-pending' },
          createElement('div', { className: 'inj-pending-head' },
            createElement('span', null, `待写入（${diffs.length}）`),
            diffs.length > 0
              ? createElement('button', { className: 'ghost small', onClick: () => setPending([]) }, '清空')
              : null),
          ...diffs.map((d, i) => {
            const diffLbl = d.cell
              ? cellLabel(varSchema, d.key, d.cell.split(',').map(Number))
              : varLabel(varSchema, d.key);
            return createElement('div', { key: `${d.where}|${d.key}|${d.cell ?? ''}|${i}`, className: 'inj-diff-row' },
              createElement('span', { className: 'inj-diff-where' }, `${d.where}.${d.key}${d.cell ? `[${d.cell}]` : ''}`),
              diffLbl ? createElement('span', { className: 'inj-var-label' }, diffLbl) : null,
              createElement('span', { className: 'inj-diff-before dim' }, d.isNew ? '（新增）' : d.before),
              createElement('span', { className: 'inj-diff-arrow' }, '→'),
              createElement('span', { className: 'inj-diff-after' }, d.after),
              createElement('button', {
                className: 'ghost small',
                title: '移除此条',
                onClick: () => setPending(dedupePending(pending).filter((_, j) => j !== i)),
              }, '×'));
          }),
          diffs.length === 0 ? createElement('div', { className: 'dim inj-hint' }, '在左侧选择变量并编辑；改动先进入清单，确认后才写盘') : null,
          createElement('div', { className: 'inj-inject-row' },
            createElement('button', {
              className: 'primary',
              disabled: diffs.length === 0 || injecting,
              onClick: runInject,
            }, injecting ? '写入中…' : armed ? '确认写入存档？' : `写入存档（${diffs.length} 条）`),
            armed ? createElement('button', { className: 'ghost small', onClick: () => setArmed(false) }, '取消') : null),
          result
            ? createElement('div', { className: 'inj-result' },
                ic('check', 12, '✓'),
                ` 写入完成：已校验 ${result.verifiedCount} 项（${result.byteSize}B）` +
                (result.backupPath ? ` · 原档已备份至：${result.backupPath}` : ''))
            : null,
          injectError
            ? createElement('div', { className: 'inj-error' }, `写入失败：${injectError}`)
            : null,
        );

        return createElement('div', { className: 'panel-snapshot-injector' },
          head,
          createElement('div', { className: 'inj-body' },
            createElement('div', { className: 'inj-left' }, scopeSel, varList),
            createElement('div', { className: 'inj-right' }, editor, pendingBox)),
          editError ? createElement('div', { className: 'inj-error' }, editError) : null,
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'snapshot-injector',
        title: '状态注入器',
        icon: 'snapshot',
        order: 71,
        // UI 重设计批 P1：低频+危险（写档）→ 副侧栏，默认不激活（定稿 §四）
        location: 'aux',
        defaultActive: false,
        component: InjectorPanel,
      });
    },
  };
}
