import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import type { BackupVersion, FileIO } from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';
import {
  formatVersionSize,
  formatVersionTime,
  getFileHistoryTarget,
  subscribeFileHistory,
  setFileHistoryTarget,
} from './file-history';

/**
 * 本地时间线 overlay（F2；2026-10-15 历史批）。
 *
 * 版本列表 = 内核 io 的写前自动备份（`listBackups`，零第二套约定）；
 * 「对比」复用 F1 的通用 diff 模态（`ui.diffView.open`，两侧都给路径——
 * 备份文件与磁盘当前文件宿主都读得到）；「恢复这一版」只经
 * `restoreBackup` 一条既有写链路（第一道闸 + 写前自动备份 + 原子写 + 零转码）。
 * 编辑器内存态由它自己的外部改动重载口径接管（watcher → `file.changed`），
 * 本窗不越俎代庖。
 */

export interface FileHistoryDeps {
  io: FileIO;
  /** 请求宿主打开通用 diff 模态 */
  requestDiff(payload: {
    title: string;
    original: { label: string; path: string };
    modified: { label: string; path: string };
  }): void;
  close(): void;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; versions: BackupVersion[] }
  | { kind: 'error'; reason: string };

interface Feedback {
  tone: 'ok' | 'err';
  text: string;
}

export function createFileHistoryOverlay(deps: FileHistoryDeps): () => unknown {
  return function FileHistoryOverlay(): unknown {
    const [, setTick] = useState(0);
    useEffect(() => subscribeFileHistory(() => setTick((t) => t + 1)), []);
    const target = getFileHistoryTarget();

    const [state, setState] = useState<ListState>({ kind: 'loading' });
    const [reloadNonce, setReloadNonce] = useState(0);
    /** 二次确认的待恢复版本（第一步只点亮确认态，不写盘） */
    const [confirming, setConfirming] = useState<BackupVersion | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      if (target === null) return;
      let alive = true;
      setState({ kind: 'loading' });
      setConfirming(null);
      deps.io
        .listBackups(target)
        .then((versions) => alive && setState({ kind: 'ready', versions }))
        .catch((err: unknown) => {
          if (alive)
            setState({ kind: 'error', reason: err instanceof Error ? err.message : String(err) });
        });
      return () => {
        alive = false;
      };
    }, [target, reloadNonce]);

    if (target === null) {
      return h(
        'div',
        { className: 'wizard fh-host' },
        h('p', { className: 'dim' }, '当前没有选中的文件。请在编辑器里打开一个文件再查看其历史。'),
      );
    }

    const restore = async (v: BackupVersion): Promise<void> => {
      setBusy(true);
      try {
        await deps.io.restoreBackup(target, v.id);
        setFeedback({
          tone: 'ok',
          text: `已恢复到 ${formatVersionTime(v)} 的版本；恢复前的内容已自动备份进历史。编辑器按外部改动口径重载。`,
        });
        setReloadNonce((n) => n + 1);
      } catch (err: unknown) {
        // 只读的游戏目录拒绝 = WriteNotAllowedError——原因整条呈现（不静默），失败态常驻
        setFeedback({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
        setConfirming(null);
      }
    };

    const rowOf = (v: BackupVersion): ReactNode =>
      h(
        'tr',
        { key: v.id, className: 'fh-row' },
        h('td', null, formatVersionTime(v)),
        h('td', null, formatVersionSize(v.size)),
        h(
          'td',
          { className: 'fh-actions' },
          h(
            'button',
            {
              className: 'ghost small',
              title: '在 diff 视图中对比这一版与磁盘当前内容（行级差异由 Monaco 呈现）',
              onClick: () =>
                deps.requestDiff({
                  title: `${basename(target)} · 历史 ${formatVersionTime(v)}`,
                  original: { label: `历史版本 · ${formatVersionTime(v)}`, path: v.path },
                  modified: { label: '磁盘当前内容', path: target },
                }),
            },
            '对比',
          ),
          confirming?.id === v.id
            ? h(
                'button',
                {
                  className: 'primary small',
                  disabled: busy,
                  title: '用这一版覆盖磁盘当前文件（走内核写盘双闸；当前内容先自动备份）',
                  onClick: () => void restore(v),
                },
                '确认恢复',
              )
            : h(
                'button',
                {
                  className: 'ghost small',
                  disabled: busy,
                  title: '用这一版覆盖磁盘当前文件（需再点一次确认；恢复前当前内容自动备份）',
                  onClick: () => setConfirming(v),
                },
                '恢复这一版',
              ),
        ),
      );

    let body: ReactNode;
    if (state.kind === 'loading') {
      body = h('p', { className: 'dim' }, '正在读取历史版本…');
    } else if (state.kind === 'error') {
      body = h('p', { className: 'kd-error' }, `历史读取失败：${state.reason}`);
    } else if (state.versions.length === 0) {
      body = h(
        'p',
        { className: 'dim' },
        '这个文件还没有历史版本 —— 本地时间线来自写前自动备份：只要保存过一次，就会有上一版。',
      );
    } else {
      body = h(
        'table',
        { className: 'fh-table' },
        h(
          'thead',
          null,
          h('tr', null, h('th', null, '时间'), h('th', null, '大小'), h('th', null, '')),
        ),
        h('tbody', null, ...state.versions.map(rowOf)),
      );
    }

    return h(
      'div',
      { className: 'wizard fh-host' },
      h('h3', null, `历史版本 —— ${basename(target)}`),
      h('p', { className: 'dim fh-path' }, target),
      feedback
        ? h('p', { className: feedback.tone === 'ok' ? 'kd-banner ok' : 'kd-error' }, feedback.text)
        : null,
      body,
      h(
        'div',
        { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: () => setReloadNonce((n) => n + 1) }, '刷新'),
        h(
          'button',
          {
            className: 'ghost small',
            onClick: () => {
              setFileHistoryTarget(null);
              deps.close();
            },
          },
          '关闭',
        ),
      ),
    );
  };
}
