/**
 * @kojo/plugin-ui-archive-browser
 *
 * 归档浏览器面板（`ui.panel` 槽贡献；v0.2 第十三批，实施记录 §5.19（docs/IMPLEMENTATION-LOG.md））。
 *
 * 消费 `snapshot.source` 的扫描结果，列出存档档位（备注摘要 / 角色数 / 文件大小 /
 * 修改时间），点击某档展开**角色区摘要**（前 N 个角色名 + 总数，不全量渲染），
 * 并广播 `kojo.snapshotSelected`（内核事件，任意插件可响应）。
 *
 * 分层（"一切皆插件"）：
 *   - 解析在 sav-parser（`snapshot.source`），本插件只做**呈现 + 意图**；
 *   - 纯逻辑（格式化 / 列表规约 / 角色摘要）在 `panel-logic.ts`（零 React 可单测）；
 *   - 刷新为**显式按钮**（BUG-5 之后目录监视已接 Rust notify，外部增删归档会经
 *     `file.changed` 自动重扫；按钮保留作 `partial` / `unavailable` 降级态的兜底）。
 */

import { createElement, useEffect, useState } from 'react';
import type {
  CharaInfo,
  ComputePool,
  GameProject,
  Plugin,
  ProjectService,
  SnapshotSourceService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, isPathUnder } from '@kojo/plugin-api';
import {
  buildArchiveList,
  summarizeCharacters,
  type ArchiveListResult,
  type ArchiveRow,
  type CharacterSummary,
} from './panel-logic';

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

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

export function createUiArchiveBrowserPlugin(): Plugin {
  return {
    id: 'ui-archive-browser',
    version: '0.2.0',
    requires: [WellKnownServices.SnapshotSource, KernelServices.Project, KernelServices.Compute],
    activate(ctx) {
      const snapshots = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const compute = ctx.inject<ComputePool>(KernelServices.Compute);

      // ---- React 外部源（面板组件订阅） ----
      let list: ArchiveListResult = { rows: [], failed: [], degrade: 'no-project' };
      /** 单档角色区摘要缓存（key = 归档路径） */
      const details = new Map<string, DetailState>();
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
          notify();
          return Promise.resolve();
        }
        list = buildArchiveList({ project: current, scanning: true, scan: snapshots.current() });
        notify();
        return snapshots
          .scan()
          .then((scan) => {
            list = buildArchiveList({ project: project.current(), scanning: false, scan });
          })
          .catch((err: unknown) => {
            list = buildArchiveList({
              project: project.current(),
              scanning: false,
              scan: null,
              scanError: err instanceof Error ? err.message : String(err),
            });
            ctx.log.warn(`Archive browser scan failed: ${String(err)}`);
          })
          .finally(() => {
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
        void snapshots
          .parse(row.path, { keepArrayCells: false, maxCellsPerArray: 0 })
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

      function ArchiveBrowserPanel(): unknown {
        const [, force] = useState(0);
        const [expanded, setExpanded] = useState<string | null>(null);

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        }, []);

        const projectNow = project.current();

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

        /** 档位行（点击展开角色区摘要） */
        const renderRow = (row: ArchiveRow): ReturnType<typeof createElement> => {
          const isOpen = expanded === row.path;
          const detail = details.get(row.path);
          const head = createElement(
            'div',
            { className: 'ab-row-head' },
            createElement('span', { className: 'ab-caret' }, isOpen ? '▾' : '▸'),
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
            { key: row.path, className: `ab-row${isOpen ? ' open' : ''}${row.failed ? ' failed' : ''}` },
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
          );
        };

        if (!projectNow) {
          return createElement(
            'div',
            { className: 'panel-archive-browser' },
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
              ` · ${shortPath(projectNow.savDir ?? '')}`
            : DEGRADE_TEXT[degrade] ?? '';

        const emptyState = createElement(
          'div',
          { className: degrade === 'scan-error' ? 'ab-error' : 'ab-empty dim' },
          statusText + (list.detail ? `：${list.detail}` : ''),
        );

        return createElement(
          'div',
          { className: 'panel-archive-browser' },
          createElement(
            'div',
            { className: 'ab-toolbar' },
            createElement('span', { className: 'dim ab-status' }, statusText),
            scanBtn,
          ),
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
            '点击档位查看角色区摘要（只列前若干角色 + 总数）；存档目录被外部改动会自动重扫，「刷新」是手动兜底',
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