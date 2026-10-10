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

import { createElement, useEffect, useState } from 'react';
import type {
  Plugin,
  ProjectService,
  SnapshotArchive,
  SnapshotInjectionResult,
  SnapshotSourceService,
  SnapshotWriteService,
  SlotRegistry,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  buildOverrides,
  dedupePending,
  diffRows,
  listScopes,
  listVars,
  parseCellIndex,
  parseCellInput,
  parseScalarInput,
  scopeLabel,
  supersededCount,
  type PendingEdit,
  type ScopeKind,
  type VarRow,
} from './panel-logic';

/** 数组单元编辑列表的渲染上限（超大数组防 DOM 爆炸；过滤后仍受此限） */
const CELL_ROWS_CAP = 120;

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

      function InjectorPanel(): unknown {
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

        const labelFor = (key: string): string | null =>
          varSchema?.lookup(key)?.description ?? null;

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
          void writer
            .inject(path, overrides)
            .then((r) => {
              setResult(r);
              setPending([]);
              // 注入成功 → 重新深解析（展示落盘后的新值）
              return snapshots.parse(path, { keepArrayCells: true, keepRaw: true }).then((a) => {
                setArchive(a);
              });
            })
            .catch((err: unknown) => {
              setInjectError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setInjecting(false));
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
          createElement('span', { className: 'dim' }, '注入器（写盘：双闸 + 备份 + 回读验证）'),
          sel,
        );

        if (!project.current() || rows.length === 0) {
          return createElement('div', { className: 'panel-snapshot-injector' }, head,
            createElement('div', { className: 'inj-empty dim' }, '打开项目并扫描到档位后可用（档位来自归档浏览器的扫描结果）'));
        }
        if (loading) {
          return createElement('div', { className: 'panel-snapshot-injector' }, head,
            createElement('div', { className: 'inj-empty dim' }, '深解析中…（全量单元 + 原始字节视图）'));
        }
        if (loadError || !archive) {
          return createElement('div', { className: 'panel-snapshot-injector' }, head,
            createElement('div', { className: 'inj-error' }, `解析失败：${loadError ?? '未选择档位'}`));
        }

        // 作用域下拉
        const scopeSel = createElement('select', {
          className: 'inj-select',
          value: scope.kind === 'char' ? `char:${scope.blockIndex}` : scope.kind,
          onChange: (e: { target: { value: string } }) => {
            const v = e.target.value;
            setSelectedKey(null);
            setEditError(null);
            if (v === 'top') setScope({ kind: 'top' });
            else if (v === 'em') setScope({ kind: 'em' });
            else setScope({ kind: 'char', blockIndex: Number(v.slice(5)) });
          },
        },
          ...listScopes(archive).map((s) =>
            createElement('option', { key: scopeLabel(archive, s), value: s.kind === 'char' ? `char:${s.blockIndex}` : s.kind },
              scopeLabel(archive, s))),
        );

        // 变量目录
        const varList = createElement('div', { className: 'inj-vars' },
          ...filtered.slice(0, 200).map((r) => {
            const label = labelFor(r.key);
            return createElement('button', {
              key: r.key,
              className: `inj-var-row${selectedKey === r.key ? ' active' : ''}${r.kind === 'other' ? ' disabled' : ''}`,
              disabled: r.kind === 'other',
              title: r.cellsTruncated ? '该数组 cells 不完整（解析策略截断），不可注入' : r.preview,
              onClick: () => {
                setSelectedKey(r.key);
                setEditError(null);
                setScalarDraft('');
                setCellDrafts({});
              },
            },
              createElement('span', { className: 'inj-var-key' }, r.key),
              label ? createElement('span', { className: 'inj-var-label' }, label) : null,
              createElement('span', { className: 'inj-var-preview dim' }, r.preview),
              r.cellsTruncated ? createElement('span', { className: 'inj-warn' }, 'cells 截断') : null,
            );
          }),
          filtered.length > 200 ? createElement('div', { className: 'dim inj-more' }, `其余 ${filtered.length - 200} 个变量未显示（可用过滤）`) : null,
          filtered.length === 0 ? createElement('div', { className: 'dim inj-empty' }, '该作用域没有变量') : null,
        );

        // 编辑区
        let editor: ReturnType<typeof createElement> | null = null;
        if (selected && selected.kind === 'scalar') {
          const intLike = selected.type === 'int';
          editor = createElement('div', { className: 'inj-editor' },
            createElement('div', { className: 'inj-editor-head' },
              createElement('span', { className: 'inj-var-key' }, selected.key),
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
              intLike ? '整数须在安全整数域内（Int64 守卫）' : '字符串按存档编码写回'),
          );
        } else if (selected && selected.kind === 'array' && selected.cells) {
          const isInt = selected.type.startsWith('int-array');
          const cellRows = selected.cells.slice(0, CELL_ROWS_CAP).map((c) => {
            const ik = c.index.join(',');
            const draft = cellDrafts[ik] ?? '';
            const changed = draft.trim() !== '' && draft !== String(c.value);
            return createElement('div', { key: ik, className: 'inj-cell-row' },
              createElement('span', { className: 'inj-cell-index' }, `[${ik}]`),
              createElement('span', { className: 'inj-cell-old' }, String(c.value)),
              createElement('input', {
                className: 'inj-input inj-cell-input',
                value: draft,
                placeholder: '新值',
                onChange: (e: { target: { value: string } }) => setCellDrafts({ ...cellDrafts, [ik]: e.target.value }),
              }),
              createElement('button', {
                className: 'ghost small',
                disabled: !changed,
                onClick: () => {
                  submitCell(c.index, draft, c.value);
                  const next = { ...cellDrafts };
                  delete next[ik];
                  setCellDrafts(next);
                },
              }, changed ? '加入清单' : '—'),
            );
          });
          editor = createElement('div', { className: 'inj-editor' },
            createElement('div', { className: 'inj-editor-head' },
              createElement('span', { className: 'inj-var-key' }, selected.key),
              createElement('span', { className: 'dim' },
                ` ${selected.cells.length} 个非空单元${selected.cells.length > CELL_ROWS_CAP ? `（显示前 ${CELL_ROWS_CAP}）` : ''}`)),
            createElement('div', { className: 'inj-cells' }, ...cellRows),
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
              isInt ? '整数须在安全整数域内（Int64 守卫）' : '字符串单元按 0xD8 形态写回'),
          );
        }

        // diff 清单 + 注入按钮
        const diffs = diffRows(dedupePending(pending));
        const pendingBox = createElement('div', { className: 'inj-pending' },
          createElement('div', { className: 'inj-pending-head' },
            createElement('span', null, `待注入（${diffs.length}）`),
            diffs.length > 0
              ? createElement('button', { className: 'ghost small', onClick: () => setPending([]) }, '清空')
              : null),
          ...diffs.map((d, i) =>
            createElement('div', { key: `${d.where}|${d.key}|${d.cell ?? ''}|${i}`, className: 'inj-diff-row' },
              createElement('span', { className: 'inj-diff-where' }, `${d.where}.${d.key}${d.cell ? `[${d.cell}]` : ''}`),
              createElement('span', { className: 'inj-diff-before dim' }, d.isNew ? '（新增）' : d.before),
              createElement('span', { className: 'inj-diff-arrow' }, '→'),
              createElement('span', { className: 'inj-diff-after' }, d.after),
              createElement('button', {
                className: 'ghost small',
                title: '移除此条',
                onClick: () => setPending(dedupePending(pending).filter((_, j) => j !== i)),
              }, '×'))),
          diffs.length === 0 ? createElement('div', { className: 'dim inj-hint' }, '从上方选择变量并编辑，改动先进入本清单（不立即写盘）') : null,
          createElement('div', { className: 'inj-inject-row' },
            createElement('button', {
              className: 'primary',
              disabled: diffs.length === 0 || injecting,
              onClick: runInject,
            }, injecting ? '注入中…' : armed ? '确认注入并写盘？' : `注入并写盘（${diffs.length} 条）`),
            armed ? createElement('button', { className: 'ghost small', onClick: () => setArmed(false) }, '取消') : null),
          result
            ? createElement('div', { className: 'inj-result' },
                `✓ 注入完成：${result.verifiedCount} 项覆盖已验证落盘（${result.byteSize}B）` +
                (result.backupPath ? ` · 原档备份：${result.backupPath}` : ''))
            : null,
          injectError
            ? createElement('div', { className: 'inj-error' }, `注入失败：${injectError}`)
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
        icon: '✎',
        order: 71,
        component: InjectorPanel,
      });
    },
  };
}
