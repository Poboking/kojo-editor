/**
 * @kojo/plugin-ui-archive-browser
 *
 * 归档浏览器面板（`ui.panel` 槽贡献；v0.2 第十三批，实施记录 §5.19（docs/IMPLEMENTATION-LOG.md））。
 *
 * 消费归档**读取单源**（`archive.reader`，实现 = 归档解析插件）的扫描结果，列出存档档位
 * （备注摘要 / 角色数 / 文件大小 / 修改时间），点击某档展开**角色区摘要**（前 N 个角色名 +
 * 总数，不全量渲染），并可把该档**取出**到两个合法落点之一（工作区 / 另存对话框），
 * 同时广播 `kojo.snapshotSelected`（内核事件，任意插件可响应）。
 *
 * 分层（"一切皆插件"）：
 *   - 解析与落盘在读取单源（`archive.reader`），本插件只做**呈现 + 意图**；
 *   - 纯逻辑（列表规约 / 角色摘要 / 时间戳）在 `panel-logic.ts`（零 React 可单测），
 *     字节格式化与路径解析**引用契约那份**（`plugin-api/archive.ts`），本插件不写第二份；
 *   - 刷新为**显式按钮**（BUG-5 之后目录监视已接 Rust notify，外部增删归档会经
 *     `file.changed` 自动重扫；按钮保留作 `partial` / `unavailable` 降级态的兜底）。
 *
 * W13 收口（ARCHIVE-READ）：面板**只**接一个读取入口 `archive.reader`（不再直接依赖
 * `snapshot.source`），字节格式化与路径解析也都改为引用契约那一份实现——面板里不许有
 * 第二份 `formatBytes` / 第二套分隔符拼接。新增的"取出档位"能力同样**不自己写盘**：
 * 意图只带 `kind` + `entryPath` 两个字段，落点（常驻可写根内的固定子目录，或系统对话框
 * 选定的位置）由读取单源按契约决定，面板拿不到任何目标路径参数（架构铁律 6）。
 */

import { createElement, useEffect, useState, type ReactNode } from 'react';
import type {
  ArchiveExtractOutcome,
  ArchiveReaderService,
  CharaInfo,
  ComputePool,
  GameProject,
  Plugin,
  PluginContextMenuAnchor,
  ProjectService,
  UIPanelProps,
} from '@kojo/plugin-api';
import { archiveEntryLabel, ArchiveServices, KernelServices, isPathUnder } from '@kojo/plugin-api';
import {
  buildArchiveList,
  summarizeCharacters,
  extractRequest,
  extractOutcomeText,
  EXTRACT_LABELS,
  type ArchiveListResult,
  type ArchiveRow,
  type CharacterSummary,
} from './panel-logic';
import {
  copyArchiveText,
  openArchivePanelMenu,
  openArchiveRowMenu,
  type ArchiveMenuHost,
} from './context-menu';

/** 角色区摘要渲染上限（前 N 个角色名，其余只报总数——防 DOM 爆炸） */
const CHARA_SUMMARY_CAP = 12;

/** 降级提示文案（显式呈现，不静默） */
const DEGRADE_TEXT: Record<string, string> = {
  'no-project': '打开项目后浏览存档（归档浏览器）',
  'no-dir': '该项目没有归档目录（适配器未提供快照来源目录）',
  empty: '未发现归档档位',
  'scan-error': '归档扫描失败',
  scanning: '扫描归档中…',
};

/** 单档详情状态（角色区摘要；惰性加载 + 缓存） */
interface DetailState {
  summary: CharacterSummary | null;
  error: string | null;
  busy: boolean;
}

/** 单档取出状态（落盘意图的结果；缓存到路径，失败也如实留着） */
interface ExtractState {
  busy: boolean;
  outcome: ArchiveExtractOutcome | null;
  error: string | null;
}

export function createUiArchiveBrowserPlugin(): Plugin {
  return {
    id: 'ui-archive-browser',
    version: '0.3.0',
    requires: [ArchiveServices.Reader, KernelServices.Project, KernelServices.Compute],
    activate(ctx) {
      const reader = ctx.inject<ArchiveReaderService>(ArchiveServices.Reader);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const compute = ctx.inject<ComputePool>(KernelServices.Compute);

      // ---- React 外部源（面板组件订阅） ----
      let list: ArchiveListResult = { rows: [], failed: [], degrade: 'no-project' };
      /** 单档角色区摘要缓存（key = 归档路径） */
      const details = new Map<string, DetailState>();
      /** 单档取出结果缓存（key = 归档路径 + 落点形态） */
      const extracts = new Map<string, ExtractState>();
      const listeners = new Set<() => void>();
      const notify = (): void => {
        for (const cb of [...listeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`Archive browser listener threw: ${String(err)}`);
          }
        }
      };

      /** 显式刷新（重扫归档目录；项目关闭时清空全部状态）。返回本次扫描，供去抖层等待 */
      const refresh = (): Promise<void> => {
        const current: GameProject | null = project.current();
        if (!current) {
          list = buildArchiveList({ project: null, scanning: false, scan: null });
          details.clear();
          extracts.clear();
          notify();
          return Promise.resolve();
        }
        list = buildArchiveList({ project: current, scanning: true, scan: reader.current() });
        notify();
        // 2026-10-16 代际守卫：扫描回包落地前校验项目归属——旧项目的扫描结果
        // 不得配新项目的表头落回（project.opened 触发的 refresh 同样受守卫保护）。
        return reader
          .scan()
          .then((scan) => {
            if (project.current() !== current) return;
            list = buildArchiveList({ project: project.current(), scanning: false, scan });
          })
          .catch((err: unknown) => {
            if (project.current() !== current) return;
            list = buildArchiveList({
              project: project.current(),
              scanning: false,
              scan: null,
              scanError: err instanceof Error ? err.message : String(err),
            });
            ctx.log.warn(`Archive browser scan failed: ${String(err)}`);
          })
          .finally(() => {
            if (project.current() !== current) return;
            details.clear();
            notify();
          });
      };

      /**
       * 惰性加载单档角色区摘要（深解析；数组单元省略控内存）。
       * 已加载 / 加载中 / 已失败 → 不重复发起。
       */
      const loadDetail = (row: ArchiveRow, charaIndex: ReadonlyMap<number, CharaInfo>): void => {
        const existing = details.get(row.path);
        if (existing && (existing.busy || existing.summary !== null || existing.error !== null)) return;
        const state: DetailState = { summary: null, error: null, busy: true };
        details.set(row.path, state);
        notify();
        void reader
          .parseEntry(row.path, { keepArrayCells: false, maxCellsPerArray: 0 })
          .then((archive) => {
            state.summary = summarizeCharacters(archive.chars, charaIndex, CHARA_SUMMARY_CAP);
            state.busy = false;
            notify();
          })
          .catch((err: unknown) => {
            state.error = err instanceof Error ? err.message : String(err);
            state.busy = false;
            notify();
          });
      };

      /**
       * 取出一个档位（唯一入口 = 读取单源的 `extractEntry`）。
       *
       * 两个按钮对应契约的**两种合法落点**，面板侧只有 `kind` 可传：
       * - `workspace`：常驻可写根（作者工作区）内的固定子目录；
       * - `dialog`：`exportFile` 法定通道（系统对话框选落点，取消不是错误）。
       * 没有"目标目录"这一栏——域外写只能由用户在对话框里显式授权（架构铁律 6）。
       */
      const extract = (row: ArchiveRow, kind: 'workspace' | 'dialog'): void => {
        const key = `${row.path}#${kind}`;
        const existing = extracts.get(key);
        if (existing?.busy) return;
        const state: ExtractState = { busy: true, outcome: null, error: null };
        extracts.set(key, state);
        notify();
        void reader
          .extractEntry(extractRequest(row.path, kind))
          .then((outcome) => {
            state.busy = false;
            state.outcome = outcome;
            notify();
          })
          .catch((err: unknown) => {
            state.busy = false;
            state.error = err instanceof Error ? err.message : String(err);
            ctx.log.warn(`Archive extract failed (${row.path} / ${kind}): ${String(err)}`);
            notify();
          });
      };

      ctx.onDispose(ctx.bus.on('project.opened', () => void refresh()));
      ctx.onDispose(ctx.bus.on('project.closed', () => void refresh()));
      if (project.current()) void refresh();

      /**
       * 存档目录被外部改动 → 自动重扫（BUG-5 监视器的消费方之一，2026-10-13）。
       *
       * 纪律：**首动作必须是廉价判定，零 IO**——不在本项目存档目录里的路径立刻 return，
       * 连一次 stat 都不发（监视根是整个项目目录，游戏运行时别的写入也会投递事件）。
       * 去抖不在这里做：内核已按路径合并过一层，这里要合的是"**多次改动 → 一次重扫**"，
       * 用 `kernel.compute` 的 `runLatest`（单飞 + 尾缘合并，背景优先级），不另造去抖器。
       */
      ctx.onDispose(
        ctx.bus.on('file.changed', (ev) => {
          const savDir = project.current()?.savDir;
          if (!savDir || !isPathUnder(savDir, ev.path)) return;
          void compute.runLatest('ui-archive-browser:rescan', { priority: 'background' }, () => refresh());
        }),
      );

      /* ------------------------------ 面板组件 ------------------------------ */

      function ArchiveBrowserPanel(props: UIPanelProps): unknown {
        const [, force] = useState(0);
        const [expanded, setExpanded] = useState<string | null>(null);
        /** 右键菜单动作的回执（复制失败这类"按了没反应"要有一句人话） */
        const [note, setNote] = useState('');

        /** 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入；缺省回退纯文本字形（绝不空白） */
        const ic = (name: string, size: number, fallback: string): ReactNode =>
          (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        }, []);

        const projectNow = project.current();

        /** 复制类菜单动作的唯一落点：失败进状态行（不静默） */
        const copyText = (text: string): void => {
          void copyArchiveText(text).then((ok) => {
            if (ok) {
              setNote(`已复制：${text}`);
              return;
            }
            setNote('复制失败：当前环境不允许写剪贴板');
            ctx.log.warn('归档浏览器复制失败：剪贴板不可用');
          });
        };

        /** 菜单动作落点（1023 批）：每条都接回面板已有的函数，不新增业务 */
        const menuHost: ArchiveMenuHost = {
          open: () => undefined,
          extract: () => undefined,
          refresh: () => void refresh(),
          copy: copyText,
        };
        const rowMenuHost = (row: ArchiveRow): ArchiveMenuHost => ({
          ...menuHost,
          open: () => toggle(row),
          extract: (_target, kind) => extract(row, kind),
        });

        const toggle = (row: ArchiveRow): void => {
          if (expanded === row.path) {
            setExpanded(null);
            return;
          }
          setExpanded(row.path);
          // 选中档位 → 广播内核事件（任意插件可响应；UI 插件间零直接依赖）
          ctx.bus.emit('kojo.snapshotSelected', {
            path: row.path,
            fileName: row.fileName,
            source: 'ui-archive-browser',
          });
          if (projectNow) loadDetail(row, projectNow.charaIndex);
        };

        /**
         * 取出条目的动作区（两种合法落点各一个按钮；**没有路径输入**）。
         * 结果与拒绝理由都留在面板上（不静默），落点文本原样显示——用户要看得见东西落在哪。
         */
        const renderExtract = (row: ArchiveRow): ReturnType<typeof createElement> => {
          const stateOf = (kind: 'workspace' | 'dialog'): ExtractState | undefined =>
            extracts.get(`${row.path}#${kind}`);
          const outcomeLine = (kind: 'workspace' | 'dialog'): ReturnType<typeof createElement> | null => {
            const st = stateOf(kind);
            if (!st) return null;
            if (st.busy) return createElement('div', { className: 'ab-status dim' }, '取出中…');
            if (st.error) return createElement('div', { className: 'ab-error' }, `取出失败：${st.error}`);
            const o = st.outcome;
            if (!o) return null;
            return createElement(
              'div',
              { className: 'ab-status dim', title: o.landing },
              extractOutcomeText(o),
            );
          };
          return createElement(
            'div',
            { className: 'ab-detail' },
            createElement(
              'div',
              { className: 'ab-chara-row' },
              createElement(
                'button',
                {
                  className: 'ghost small',
                  disabled: stateOf('workspace')?.busy === true,
                  onClick: () => extract(row, 'workspace'),
                  title: '写入作者工作区（常驻可写根）内的归档取出目录',
                },
                EXTRACT_LABELS.workspace,
              ),
              createElement(
                'button',
                {
                  className: 'ghost small',
                  disabled: stateOf('dialog')?.busy === true,
                  onClick: () => extract(row, 'dialog'),
                  title: '由系统对话框选定落点（对话框即授权）',
                },
                EXTRACT_LABELS.dialog,
              ),
            ),
            outcomeLine('workspace'),
            outcomeLine('dialog'),
          );
        };

        /** 档位行（点击展开角色区摘要 + 取出动作） */
        const renderRow = (row: ArchiveRow): ReturnType<typeof createElement> => {
          const isOpen = expanded === row.path;
          const detail = details.get(row.path);
          const head = createElement(
            'div',
            { className: 'ab-row-head' },
            createElement('span', { className: 'ab-caret' }, ic(isOpen ? 'chevron-down' : 'chevron-right', 12, isOpen ? '▾' : '▸')),
            createElement('span', { className: 'ab-file' }, row.fileName),
            createElement('span', { className: 'ab-count dim' }, `${row.charCount} 角色`),
            createElement('span', { className: 'ab-size dim' }, row.sizeText),
            createElement('span', { className: 'ab-mtime dim' }, row.mtimeText),
          );
          const mes = row.saveMesSummary
            ? createElement('div', { className: 'ab-mes dim', title: row.saveMes }, row.saveMesSummary)
            : null;

          let body: ReturnType<typeof createElement> | null = null;
          if (isOpen) {
            if (row.failed) {
              body = createElement('div', { className: 'ab-error' }, `解析失败：${row.error ?? ''}`);
            } else if (detail?.busy) {
              body = createElement('div', { className: 'ab-status dim' }, '读取角色区…');
            } else if (detail?.error) {
              body = createElement('div', { className: 'ab-error' }, `角色区读取失败：${detail.error}`);
            } else if (detail?.summary) {
              const s = detail.summary;
              body = createElement(
                'div',
                { className: 'ab-detail' },
                createElement(
                  'div',
                  { className: 'ab-chara-row' },
                  ...(s.names.length > 0
                    ? s.names.map((n) => createElement('span', { key: n, className: 'ab-badge' }, n))
                    : [createElement('span', { key: 'none', className: 'dim' }, '该档角色区为空')]),
                ),
                s.total > s.shown
                  ? createElement('div', { className: 'ab-more dim' }, `其余 ${s.total - s.shown} 个角色未显示（共 ${s.total}）`)
                  : createElement('div', { className: 'ab-more dim' }, `共 ${s.total} 个角色`),
              );
            }
          }

          return createElement(
            'div',
            {
              key: row.path,
              className: `ab-row${isOpen ? ' open' : ''}${row.failed ? ' failed' : ''}`,
              // 档位行右键（1023 批）：打开/收起 · 复制路径 · 取出 · 刷新
              onContextMenu: (e: PluginContextMenuAnchor) =>
                openArchiveRowMenu(
                  props,
                  e,
                  { path: row.path, fileName: row.fileName, failed: row.failed, expanded: isOpen },
                  rowMenuHost(row),
                ),
            },
            createElement(
              'button',
              {
                className: 'ab-row-btn',
                title: `${row.path}${row.saveMes ? ` — ${row.saveMes}` : ''}`,
                onClick: () => toggle(row),
              },
              head,
              mes,
            ),
            body,
            isOpen && !row.failed ? renderExtract(row) : null,
          );
        };

        if (!projectNow) {
          return createElement(
            'div',
            {
              className: 'panel-archive-browser',
              onContextMenu: (e: PluginContextMenuAnchor) => openArchivePanelMenu(props, e, null, menuHost),
            },
            createElement('div', { className: 'ab-empty dim' }, DEGRADE_TEXT['no-project']!),
          );
        }

        const degrade = list.degrade;
        const scanBtn = createElement(
          'button',
          { className: 'ghost small', disabled: degrade === 'scanning', onClick: () => refresh() },
          degrade === 'scanning' ? '扫描中…' : '刷新',
        );
        const statusText =
          degrade === null
            ? `已列 ${list.rows.length} 档${list.failed.length > 0 ? `（${list.failed.length} 档解析失败）` : ''}` +
              ` · ${archiveEntryLabel(projectNow.savDir ?? '')}`
            : DEGRADE_TEXT[degrade] ?? '';

        const emptyState = createElement(
          'div',
          { className: degrade === 'scan-error' ? 'ab-error' : 'ab-empty dim' },
          statusText + (list.detail ? `：${list.detail}` : ''),
        );

        return createElement(
          'div',
          {
            className: 'panel-archive-browser',
            // 空白处右键（1023 批）：刷新 · 复制存档目录
            onContextMenu: (e: PluginContextMenuAnchor) =>
              openArchivePanelMenu(props, e, projectNow.savDir ?? null, menuHost),
          },
          createElement(
            'div',
            { className: 'ab-toolbar' },
            createElement('span', { className: 'dim ab-status' }, statusText),
            scanBtn,
          ),
          note === '' ? null : createElement('div', { className: 'ab-status dim' }, note),
          degrade !== null
            ? emptyState
            : createElement(
                'div',
                { className: 'ab-list' },
                ...list.rows.map((row) => renderRow(row)),
                ...(list.failed.length > 0
                  ? [
                      createElement('div', { key: 'failed-head', className: 'dim ab-failed-head' }, '解析失败'),
                      ...list.failed.map((row) => renderRow(row)),
                    ]
                  : []),
              ),
          createElement(
            'div',
            { className: 'ab-hint dim' },
            '点击档位查看角色区摘要（只列前若干角色 + 总数）；存档目录被外部改动会自动重扫，「刷新」是手动兜底；' +
              '「取出」只落两个合法位置——作者工作区，或你在系统对话框里亲手选的地方',
          ),
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'archive-browser',
        title: '归档浏览器',
        icon: 'archive',
        order: 70,
        // UI 重设计批 P1：低频 → 副侧栏，默认不激活（定稿 §四）
        location: 'aux',
        defaultActive: false,
        component: ArchiveBrowserPanel,
      });
    },
  };
}