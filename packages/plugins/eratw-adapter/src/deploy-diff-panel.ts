/**
 * 部署比对窗（2026-10-15 比对批；`ui.overlay` 贡献）。
 *
 * 链路：包行「比对」→ 插件把待比对请求存闭包 → `ui.overlay.open` 开本窗 →
 * 角色缺 meta 时先选角色（与部署向导同款）→ 异步 collectDeployDiff（只读）→
 * 逐文件归类表 + 汇总横幅 → 点单行发 `ui.diffView.open`，行级差异由宿主
 * Monaco diff 模态呈现。比对全程零写盘；转译/读盘失败原因常驻呈现（不静默）。
 */

import { createElement as h, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DiffViewSide, FileIO, GameProject } from '@kojo/plugin-api';
import { resolveDeployTarget } from './deploy';
import type { KojoCompiler } from './artifact';
import {
  collectDeployDiff,
  deployDiffBanner,
  rowToDiffPayload,
  summarizeDeployDiff,
  type DeployDiffRow,
  type PendingCompare,
} from './deploy-diff';

/** overlay 贡献 id */
export const DEPLOY_DIFF_OVERLAY_ID = 'eratw.deployDiff';

export interface DeployDiffDeps {
  pending(): PendingCompare | null;
  clearPending(): void;
  close(): void;
  gameProject(): GameProject | null;
  io: FileIO;
  compileKojo: KojoCompiler;
  /** 请求宿主打开通用 diff 模态（发 `ui.diffView.open`） */
  requestDiff(payload: { title: string; original: DiffViewSide; modified: DiffViewSide }): void;
}

type RowsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; rows: DeployDiffRow[]; targetMissing: boolean }
  | { kind: 'error'; reason: string };

const STATE_BADGE: Record<DeployDiffRow['state'], string> = {
  identical: '一致',
  modified: '有差异',
  'workspace-only': '仅工作区',
  'game-only': '仅游戏目录',
};

export function createDeployDiffOverlay(deps: DeployDiffDeps): () => unknown {
  return function DeployDiffPanel(): unknown {
    const pending = deps.pending();
    const gameProject = deps.gameProject();
    const [charaNo, setCharaNo] = useState<number | null>(pending?.charaNo ?? null);
    const [rowsState, setRowsState] = useState<RowsState>({ kind: 'idle' });
    const [reloadNonce, setReloadNonce] = useState(0);

    const charas = useMemo(
      () => (gameProject ? [...gameProject.charaIndex.values()].sort((a, b) => a.no - b.no) : []),
      [gameProject],
    );
    const target = useMemo(
      () => resolveDeployTarget(gameProject, charaNo, pending?.dirName ?? ''),
      [gameProject, charaNo, pending?.dirName],
    );
    const targetDir = target.ok ? target.targetDir : '';

    // 换包重新打开时回到该包自己的角色（与部署向导同口径）
    useEffect(() => {
      setCharaNo(pending?.charaNo ?? null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending?.absDir]);

    // 落点就绪（或换角色）→ 自动重扫；比对是只读动作，不需要再点一次按钮才出结果
    useEffect(() => {
      if (!pending || !target.ok) {
        setRowsState({ kind: 'idle' });
        return;
      }
      let alive = true;
      setRowsState({ kind: 'loading' });
      collectDeployDiff({ io: deps.io, srcDir: pending.absDir, targetDir: target.targetDir, compile: deps.compileKojo })
        .then((r) => {
          if (alive) setRowsState({ kind: 'ready', rows: r.rows, targetMissing: r.targetMissing });
        })
        .catch((err: unknown) => {
          if (alive) setRowsState({ kind: 'error', reason: err instanceof Error ? err.message : String(err) });
        });
      return () => {
        alive = false;
      };
    }, [pending, target, reloadNonce]);

    if (!pending) {
      return h(
        'div',
        { className: 'wizard' },
        h('h3', null, '与游戏目录比对'),
        h('p', { className: 'dim' }, '当前没有要比对的包。请在「我的口上项目」中选择一个作者包再比对。'),
        h('div', { className: 'wizard-actions' }, h('button', { className: 'ghost small', onClick: deps.close }, '关闭')),
      );
    }

    const openRowDiff = (row: DeployDiffRow): void => {
      deps.requestDiff(rowToDiffPayload(row, `${pending.displayName} · ${row.relPath}`));
    };

    const body: ReactNode[] = [];
    if (!gameProject) {
      body.push(h('p', { key: 'noproj', className: 'wizard-warn' }, '当前无打开的游戏项目。落点来自项目里的角色口上目录，请先打开项目。'));
    } else if (!target.ok) {
      body.push(h('p', { key: 'badtarget', className: 'wizard-warn' }, target.reason));
    } else if (rowsState.kind === 'loading') {
      body.push(h('p', { key: 'loading', className: 'dim' }, '正在逐文件比对（只读，不写盘）…'));
    } else if (rowsState.kind === 'error') {
      body.push(h('p', { key: 'err', className: 'wizard-warn' }, `比对失败：${rowsState.reason}`));
    } else if (rowsState.kind === 'ready') {
      const summary = summarizeDeployDiff(rowsState.rows, rowsState.targetMissing);
      body.push(
        h('p', { key: 'banner', className: `kd-banner${summary.identical === summary.total && !rowsState.targetMissing ? ' ok' : ''}` }, deployDiffBanner(summary)),
      );
      body.push(
        h(
          'table',
          { key: 'table', className: 'dd-table' },
          h(
            'thead',
            null,
            h('tr', null, h('th', null, '文件'), h('th', null, '状态'), h('th', null, '')),
          ),
          h(
            'tbody',
            null,
            ...rowsState.rows.map((row) =>
              h(
                'tr',
                { key: row.relPath, className: `dd-row dd-${row.state}` },
                h('td', { className: 'dd-path' }, row.relPath),
                h('td', null, STATE_BADGE[row.state]),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      className: 'ghost small',
                      title: row.state === 'identical' ? '并排查看两份相同的内容' : '在 diff 视图中定位差异行',
                      onClick: () => openRowDiff(row),
                    },
                    '查看差异',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return h(
      'div',
      { className: 'wizard dd-host' },
      h('h3', null, `与游戏目录比对 —— ${pending.displayName}`),
      h(
        'div',
        { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '工作区包'), h('code', null, pending.absDir)),
        h(
          'div',
          null,
          h('span', { className: 'wizard-label' }, '落点'),
          h('code', null, target.ok ? target.targetDir : '—'),
        ),
        h('div', { className: 'dim' }, '比对两侧都只读：期望侧 = 当前工作区包逐文件转译后的产物；实际侧 = 游戏目录里的真文件。'),
      ),
      gameProject
        ? h(
            'label',
            { key: 'chara', className: 'wizard-field' },
            h('span', null, '目标角色'),
            h(
              'select',
              {
                value: charaNo === null ? '' : String(charaNo),
                onChange: (e: { target: { value: string } }) =>
                  setCharaNo(e.target.value === '' ? null : Number(e.target.value)),
              },
              h('option', { value: '' }, charas.length > 0 ? '选择角色…' : '（游戏项目无角色表）'),
              charas.map((c) =>
                h('option', { key: c.no, value: String(c.no) }, c.kojoDir ? `#${c.no} ${c.name}` : `#${c.no} ${c.name}（无口上目录）`),
              ),
            ),
          )
        : null,
      ...body,
      h(
        'div',
        { className: 'wizard-actions' },
        h(
          'button',
          { className: 'ghost small', onClick: () => setReloadNonce((n) => n + 1), disabled: !target.ok || rowsState.kind === 'loading' },
          '重新扫描',
        ),
        h(
          'button',
          {
            className: 'ghost small',
            onClick: () => {
              deps.clearPending();
              deps.close();
            },
          },
          '关闭',
        ),
      ),
    );
  };
}
