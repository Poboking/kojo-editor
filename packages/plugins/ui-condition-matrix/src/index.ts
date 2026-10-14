/**
 * @kojo/plugin-ui-condition-matrix
 *
 * 条件矩阵面板（`ui.panel` 槽贡献；任务 HK-14）。
 *
 * 对选定角色呈现「状态 × 时机」网格：行 = 状态变量键（经变量字典给出人读标签），
 * 列 = 该角色的时机面（系统时机 + 作者自定指令/自定事件都以 face 呈现）。
 * 填色的格子 = 该时机有函数响应了这个状态，点击跳到源；空白 = 尚未写反应。
 *
 * 数据全来自既有契约（插件不得交叉 import）：
 *   - `erb.parser`：函数索引（`kojo.functionChanged` / `project.opened` / `project.closed`
 *     驱动重建，同一索引实例去重）；
 *   - `game.adapter` 槽位查询 + `project.adapterId` 过滤 → `functionFamilyIndex`
 *     （角色/面归属）与 `variableSchema`（状态键标签）；
 *   - `condition.extractor`：单函数状态依赖（`functionConditions(...).dependencies`），
 *     其索引就绪后经 `subscribe` 刷新填色。
 *
 * 呈现层只做「浏览 + 跳转意图」：点击函数 → `editor.revealLocation`（宿主消费）。
 */

import { createElement, useEffect, useState, type ReactNode } from 'react';
import type {
  ConditionExtractorService,
  ErbIndex,
  ErbParserService,
  FamilyIndexRule,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateDependency,
  UIPanelProps,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  buildCharacterIndex,
  buildMatrix,
  faceLabel,
  type CharacterIndex,
  type MatrixCell,
  type MatrixCellFunction,
} from './matrix-logic';

/** 矩阵行渲染上限（防 DOM 爆炸；过滤后仍受此限） */
const ROW_RENDER_CAP = 400;

/** 取路径末两段（工具提示/详情里短显示） */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/** 按「行号升序、同号按路径」排序（详情展示 / 取最早贡献函数） */
function orderByLine(fns: readonly MatrixCellFunction[]): MatrixCellFunction[] {
  return [...fns].sort((a, b) => a.startLine - b.startLine || a.filePath.localeCompare(b.filePath));
}

/** 单元格工具提示：其贡献函数的比较合并去重（无比较或无响应 → '无'） */
function cellComparisons(cell: MatrixCell): string {
  const seen = new Set<string>();
  for (const f of cell.functions) for (const c of f.comparisons) seen.add(c);
  return seen.size > 0 ? [...seen].join('、') : '无';
}

export function createUiConditionMatrixPlugin(): Plugin {
  return {
    id: 'ui-condition-matrix',
    version: '0.1.0',
    requires: [
      WellKnownServices.ErbParser,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const conditionExtractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配） */
      const currentFamilyIndex = (): FamilyIndexRule | null => {
        const current: GameProject | null = project.current();
        if (!current) return null;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId === current.adapterId && contribution.adapter.functionFamilyIndex) {
            return contribution.adapter.functionFamilyIndex;
          }
        }
        return null;
      };

      /** 当前适配器的变量语义字典（按 adapterId 精确匹配；与注入器同通道） */
      const schemaLookup = (): VariableSchema | undefined => {
        const current = project.current();
        if (!current) return undefined;
        for (const c of slots.query('game.adapter')) {
          if (c.adapter.gameId !== current.adapterId) continue;
          return c.adapter.variableSchema;
        }
        return undefined;
      };

      /** 当前适配器的面 → 中文标签（与家族规则同源；缺省 → 消费方原样显示 token） */
      const faceLabels = (): Readonly<Record<string, string>> | undefined => currentFamilyIndex()?.faceLabels;

      /** 状态键标签：按首个 ':' 切出变量名与首下标，查变量字典 */
      const labelOf = (key: string): string | null => {
        const schema = schemaLookup();
        if (!schema) return null;
        const i = key.indexOf(':');
        const name = i < 0 ? key : key.slice(0, i);
        const firstIndex = i < 0 ? undefined : key.slice(i + 1).split(':')[0];
        return schema.lookup(name, firstIndex)?.description ?? null;
      };

      /** 单函数状态依赖（抽取索引未含该函数时为空数组） */
      const depsOf = (normalizedName: string): StateDependency[] =>
        conditionExtractor.functionConditions(normalizedName)?.dependencies ?? [];

      // ---- 状态（React 外部源；面板组件读取并订阅） ----
      let characterIndex: CharacterIndex | null = null;
      let indexReady = false;
      /** 上一次建索引所用的索引实例（去重判据：同一实例不重复全量遍历） */
      let lastBuiltIndex: ErbIndex | null = null;
      /** 索引/建表失败原因（必须可见 + 可重试，不静默停在占位） */
      let loadError: string | null = null;
      const listeners = new Set<() => void>();

      const notify = (): void => {
        for (const cb of [...listeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`Condition matrix listener threw: ${String(err)}`);
          }
        }
      };

      const rebuild = (index: ErbIndex | null): void => {
        // 去重：`project.opened` 与 `kojo.functionChanged` 会双双触发 refresh，
        // 两者拿到同一索引实例——同一实例不重复全量遍历（一次扫描即全量重算）。
        if (lastBuiltIndex === index) return;
        lastBuiltIndex = index;
        if (!index || !project.current()) {
          characterIndex = null;
          indexReady = index !== null;
        } else {
          characterIndex = buildCharacterIndex(index, currentFamilyIndex());
          indexReady = true;
        }
        loadError = null;
        notify();
      };

      /** 等待索引就绪并重建（项目刚打开时索引可能在途） */
      const refresh = (): void => {
        if (!project.current()) {
          rebuild(null);
          return;
        }
        loadError = null;
        notify();
        void parser
          .ensureIndex()
          .then((index) => rebuild(index))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            loadError = msg;
            indexReady = false;
            ctx.log.error(`Condition matrix load failed: ${msg}`);
            notify();
          });
      };

      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.opened', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.closed', () => rebuild(null)));
      // 条件抽取索引就绪后重绘（填色依赖 functionConditions；立即回调一次，无副作用）
      ctx.onDispose(conditionExtractor.subscribe(() => notify()));

      // 激活时已有现成索引（插件晚于项目打开加载）→ 立即构建
      if (project.current()) refresh();

      /* ------------------------------ 面板组件 ------------------------------ */

      function ConditionMatrixPanel(props: UIPanelProps): unknown {
        const [, force] = useState(0);
        const [selectedNo, setSelectedNo] = useState<number | null>(null);
        const [filter, setFilter] = useState('');
        const [selected, setSelected] = useState<{ rowKey: string; face: string } | null>(null);

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        }, []);

        // 失败态优先：显示原因 + 重试（不静默停在占位）
        if (loadError) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-error', title: loadError }, `条件矩阵加载失败：${loadError}`),
            createElement('button', { className: 'small', onClick: () => refresh() }, '重试'),
          );
        }

        const current = project.current();
        if (!current) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '打开项目后可用（条件矩阵需要口上函数索引）'),
          );
        }

        const idx = characterIndex;
        if (idx && !idx.hasFamilyIndex) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '适配器未提供家族规则，无法按角色聚合条件矩阵'),
          );
        }

        if (!indexReady || !idx) {
          return createElement(
            'div',
            { className: 'panel-condition-matrix' },
            createElement('div', { className: 'cm-empty dim' }, '正在构建函数索引…（首次打开项目需要数秒）'),
          );
        }

        const charas = [...idx.entries.values()].sort((a, b) => a.no - b.no);
        const entry = selectedNo === null ? null : idx.entries.get(selectedNo) ?? null;

        /** 角色下拉标签：`K{no} {name}` / `K{no}` 再缀函数数 */
        const charaLabel = (no: number, count: number): string => {
          const info = current.charaIndex.get(no);
          return `${info ? `K${no} ${info.name}` : `K${no}`}（${count}）`;
        };

        const charaSelect = createElement(
          'select',
          {
            className: 'cm-chara-select',
            value: selectedNo === null ? '' : String(selectedNo),
            onChange: (e: { target: { value: string } }) => {
              const v = e.target.value;
              setSelectedNo(v === '' ? null : Number(v));
              setSelected(null);
            },
          },
          createElement('option', { key: '', value: '' }, `选择角色（${charas.length}）`),
          ...charas.map((c) =>
            createElement('option', { key: c.no, value: String(c.no) }, charaLabel(c.no, c.functions.length)),
          ),
        );

        const filterInput = createElement('input', {
          className: 'cm-filter',
          type: 'search',
          placeholder: '过滤状态键 / 标签',
          value: filter,
          onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
        });

        const floatBtn = createElement(
          'button',
          {
            className: 'cm-float',
            title: '浮动到大窗口查看',
            onClick: () => ctx.bus.emit('ui.panel.float', { id: 'condition-matrix' }),
          },
          (props.renderIcon?.('popout', 14) as ReactNode) ?? '浮动',
        );
        // 已在浮窗里时不再渲染「浮动」入口（浮窗框自带拖动 / 缩放 / 停靠）
        const toolbar = createElement(
          'div',
          { className: 'cm-toolbar' },
          charaSelect,
          filterInput,
          props.floating ? null : floatBtn,
        );

        const status = createElement(
          'div',
          { className: 'cm-status dim' },
          `${idx.totalFunctions} 函数 · ${charas.length} 角色` +
            (idx.hasFamilyIndex ? ` · 未归属 ${idx.orphanCount}` : ' · 适配器未提供家族规则'),
        );

        const matrix = entry ? buildMatrix(entry, depsOf, labelOf, faceLabels()) : null;

        // ---- 定位（网格）----
        let grid: ReactNode;
        if (!entry || !matrix) {
          grid = createElement('div', { className: 'cm-empty dim' }, '从上方选择角色以浏览其状态 × 时机矩阵');
        } else if (matrix.rows.length === 0) {
          grid = createElement('div', { className: 'cm-empty dim' }, '该角色尚未抽取到状态条件（无状态依赖）');
        } else {
          const needle = filter.trim().toLowerCase();
          const rows = needle
            ? matrix.rows.filter(
                (r) => r.key.toLowerCase().includes(needle) || (r.label ?? '').toLowerCase().includes(needle),
              )
            : matrix.rows;
          const shown = rows.slice(0, ROW_RENDER_CAP);

          const head = createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              createElement('th', { className: 'cm-corner' }, '状态 \\ 时机'),
              ...matrix.columns.map((col) =>
                createElement('th', { key: col.face, className: 'cm-th', title: col.face }, col.label),
              ),
            ),
          );

          const body = createElement(
            'tbody',
            null,
            ...shown.map((row) =>
              createElement(
                'tr',
                { key: row.key },
                createElement(
                  'th',
                  { className: 'cm-rowhead', title: row.key },
                  createElement('span', { className: 'cm-row-name' }, row.label ?? row.key),
                  row.label ? createElement('span', { className: 'cm-row-key dim' }, row.key) : null,
                ),
                ...matrix.columns.map((col) => {
                  const cell = row.cells[col.face];
                  if (!cell || !cell.present) {
                    // 空白格：这个时机还没有针对该状态写过的反应（点击不导航）
                    return createElement(
                      'td',
                      { key: col.face },
                      createElement('button', { className: 'cm-cell off', title: '无' }, '·'),
                    );
                  }
                  const isSel = selected !== null && selected.rowKey === row.key && selected.face === col.face;
                  return createElement(
                    'td',
                    { key: col.face },
                    createElement(
                      'button',
                      {
                        className: 'cm-cell on' + (isSel ? ' sel' : ''),
                        title: cellComparisons(cell),
                        onClick: () => {
                          const earliest = orderByLine(cell.functions)[0];
                          if (earliest) {
                            ctx.bus.emit('editor.revealLocation', {
                              filePath: earliest.filePath,
                              line: earliest.startLine,
                              source: earliest.name,
                            });
                          }
                          setSelected({ rowKey: row.key, face: col.face });
                        },
                      },
                      String(cell.count),
                    ),
                  );
                }),
              ),
            ),
          );

          grid = createElement(
            'div',
            { className: 'cm-scroll' },
            createElement('table', { className: 'cm-table' }, head, body),
            rows.length > ROW_RENDER_CAP
              ? createElement(
                  'div',
                  { className: 'cm-more dim' },
                  `其余 ${rows.length - ROW_RENDER_CAP} 行未显示（可用过滤缩小范围）`,
                )
              : null,
          );
        }

        // ---- 详情 ----
        let detail: ReactNode;
        const selRow = selected && matrix ? matrix.rows.find((r) => r.key === selected.rowKey) ?? null : null;
        const selCell = selRow && selected ? selRow.cells[selected.face] : undefined;
        if (selRow && selCell && selCell.present) {
          const fns = orderByLine(selCell.functions);
          detail = createElement(
            'div',
            { className: 'cm-detail' },
            createElement(
              'div',
              { className: 'cm-detail-head' },
              createElement('span', { className: 'cm-detail-key' }, selRow.label ?? selRow.key),
              createElement(
                'span',
                { className: 'dim' },
                ` · ${faceLabel(selected!.face, faceLabels())} · ${selCell.count} 处响应`,
              ),
            ),
            createElement(
              'ul',
              { className: 'cm-detail-list' },
              ...fns.map((f, i) =>
                createElement(
                  'li',
                  { key: `${f.filePath}:${f.startLine}:${i}` },
                  createElement(
                    'button',
                    {
                      className: 'cm-detail-btn',
                      title: `${f.filePath}:${f.startLine}`,
                      onClick: () =>
                        ctx.bus.emit('editor.revealLocation', {
                          filePath: f.filePath,
                          line: f.startLine,
                          source: f.name,
                        }),
                    },
                    createElement('span', { className: 'cm-detail-name' }, f.name),
                    f.comparisons.length > 0
                      ? createElement('span', { className: 'cm-detail-comps dim' }, f.comparisons.join('、'))
                      : null,
                    createElement('span', { className: 'cm-detail-loc dim' }, `${shortPath(f.filePath)}:${f.startLine}`),
                  ),
                ),
              ),
            ),
          );
        } else {
          detail = createElement(
            'div',
            { className: 'cm-detail' },
            createElement('div', { className: 'cm-empty dim' }, '点击一个已填色的格子，查看其对应的口上函数'),
          );
        }

        return createElement('div', { className: 'panel-condition-matrix' }, toolbar, status, grid, detail);
      }

      ctx.slots.register('ui.panel', {
        id: 'condition-matrix',
        title: '条件矩阵',
        icon: 'matrix',
        order: 45,
        location: 'sidebar',
        defaultActive: true,
        component: ConditionMatrixPanel,
      });
    },
  };
}
