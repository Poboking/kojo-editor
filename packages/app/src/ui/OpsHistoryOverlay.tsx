import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import type { OpEntryView, OpJournal, OpRecord } from '@kojo/plugin-api';
import { formatOpTime, opKindLabel, opStatusLabel } from './ops-history';

/**
 * 操作历史 overlay（2026-10-16 undo 批）——磁盘侧批操作的撤销面。
 *
 * 数据 = 内核 `kernel.ops`（`list`/`entriesOf`/`undo`，零第二套约定）；
 * 装配形态与 FileHistoryOverlay 同族（App.tsx 注册 ui.overlay + editor.command 槽）。
 * 「撤销此操作」两步确认后走 `undo`：恢复 before 字节 / 删除该批新建的文件——
 * 回滚本身也进 journal（对已撤销操作再撤销 = 重做）。
 *
 * 编辑器内存态的边界（刻意不做的事）：已打开的 Monaco model 由外部改动口径接管
 * ——游戏目录里的文件有 watcher 广播 `file.changed` 自动重载；工作区里的文件
 * （`.kojo` 源等）不在监视域，回滚后需重新打开该标签看到新内容。劫持 Monaco
 * undo 栈（setValue 清栈 / executeEdits 伪造历史）都会把用户的编辑历史炸掉，
 * 两害相权取其轻：宁可让用户重开一次标签。此取舍已文档化进提交信息。
 */

export interface OpsHistoryDeps {
  ops: OpJournal;
  close(): void;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; records: OpRecord[] }
  | { kind: 'error'; reason: string };

interface Feedback {
  tone: 'ok' | 'err';
  text: string;
}

/** 展开行的缓存（opId → 文件清单；undo/刷新后失效） */
type EntriesCache = Map<string, OpEntryView[]>;

export function createOpsHistoryOverlay(deps: OpsHistoryDeps): () => unknown {
  return function OpsHistoryOverlay(): unknown {
    const [state, setState] = useState<ListState>({ kind: 'loading' });
    const [reloadNonce, setReloadNonce] = useState(0);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [entries, setEntries] = useState<EntriesCache>(new Map());
    /** 两步确认的待撤销操作（第一步只点亮确认态，不动盘） */
    const [confirming, setConfirming] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    useEffect(() => {
      let alive = true;
      setState({ kind: 'loading' });
      deps.ops
        .list()
        .then((records) => {
          if (!alive) return;
          setEntries(new Map());
          setExpanded(new Set());
          setState({ kind: 'ready', records });
        })
        .catch((err: unknown) => {
          if (alive)
            setState({ kind: 'error', reason: err instanceof Error ? err.message : String(err) });
        });
      return () => {
        alive = false;
      };
    }, [reloadNonce]);

    const closeButton = (): ReactNode =>
      h('button', { className: 'ghost small', onClick: () => deps.close() }, '关闭');

    if (state.kind === 'loading' || state.kind === 'error') {
      return h(
        'div',
        { className: 'wizard oh-host' },
        h('h3', null, '操作历史'),
        state.kind === 'loading'
          ? h('p', { className: 'dim' }, '正在读取操作历史…')
          : h('p', { className: 'kd-error' }, `操作历史读取失败：${state.reason}`),
        h('div', { className: 'wizard-actions' }, closeButton()),
      );
    }

    const toggle = async (id: string): Promise<void> => {
      const next = new Set(expanded);
      if (next.has(id)) {
        next.delete(id);
        setExpanded(next);
        return;
      }
      next.add(id);
      setExpanded(next);
      if (!entries.has(id)) {
        try {
          const list = await deps.ops.entriesOf(id);
          setEntries((prev) => new Map(prev).set(id, list));
        } catch (err: unknown) {
          setEntries((prev) => new Map(prev).set(id, []));
          setFeedback({
            tone: 'err',
            text: `文件清单读取失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    };

    const undo = async (rec: OpRecord): Promise<void> => {
      setBusy(true);
      try {
        await deps.ops.undo(rec.id);
        setFeedback({
          tone: 'ok',
          text: `已撤销「${opKindLabel(rec.kind)}」。游戏目录中的文件会按外部改动口径自动重载；工作区里的文件（如 .kojo 源）请重新打开标签查看回滚后的内容。`,
        });
        setReloadNonce((n) => n + 1);
      } catch (err: unknown) {
        setFeedback({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
        setReloadNonce((n) => n + 1);
      } finally {
        setBusy(false);
        setConfirming(null);
      }
    };

    const rowOf = (rec: OpRecord): ReactNode[] => {
      const isOpen = expanded.has(rec.id);
      const list = entries.get(rec.id);
      const rows: ReactNode[] = [
        h(
          'tr',
          { key: rec.id, className: 'oh-row' },
          h('td', null, formatOpTime(rec.startedAt)),
          h('td', null, opKindLabel(rec.kind)),
          h('td', { className: 'dim' }, `${rec.fileCount} 个文件 · ${opStatusLabel(rec)}`),
          h(
            'td',
            { className: 'fh-actions' },
            h(
              'button',
              {
                className: 'ghost small',
                title: '展开查看这一批涉及的文件',
                onClick: () => void toggle(rec.id),
              },
              isOpen ? '收起' : '展开',
            ),
            rec.status === 'committed'
              ? confirming === rec.id
                ? h(
                    'button',
                    {
                      className: 'primary small',
                      disabled: busy,
                      title: '把这一批涉及的全部文件恢复到操作前的内容（新建文件将被删除）',
                      onClick: () => void undo(rec),
                    },
                    '确认撤销',
                  )
                : h(
                    'button',
                    {
                      className: 'ghost small',
                      disabled: busy,
                      title: '恢复这一批文件到操作前的状态（需再点一次确认）',
                      onClick: () => setConfirming(rec.id),
                    },
                    '撤销此操作',
                  )
              : h(
                  'button',
                  {
                    className: 'ghost small',
                    disabled: busy,
                    title: '对这次撤销再撤销一次 = 重做原操作',
                    onClick: () => setConfirming(rec.id),
                  },
                  confirming === rec.id ? '确认重做' : '重做',
                ),
          ),
        ),
      ];
      if (isOpen) {
        rows.push(
          h(
            'tr',
            { key: `${rec.id}-detail`, className: 'oh-detail' },
            h(
              'td',
              { colSpan: 4 },
              list === undefined
                ? h('span', { className: 'dim' }, '正在读取文件清单…')
                : list.length === 0
                  ? h('span', { className: 'dim' }, '（清单为空）')
                  : h(
                      'ul',
                      { className: 'oh-files' },
                      ...list.map((e) =>
                        h(
                          'li',
                          { key: e.path },
                          h('span', { className: e.hasBefore ? 'oh-kind-mod' : 'oh-kind-new' }, e.hasBefore ? '改写' : '新建'),
                          ' ',
                          e.path,
                        ),
                      ),
                    ),
            ),
          ),
        );
      }
      return rows;
    };

    const body: ReactNode =
      state.records.length === 0
        ? h(
            'p',
            { className: 'dim' },
            '还没有可撤销的批操作。脚手架创建、.kojo 保存（源+产物）、存档变量注入都会记进这里。',
          )
        : h(
            'table',
            { className: 'fh-table oh-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '时间'),
                h('th', null, '操作'),
                h('th', null, '规模'),
                h('th', null, ''),
              ),
            ),
            h('tbody', null, ...state.records.flatMap(rowOf)),
          );

    return h(
      'div',
      { className: 'wizard oh-host' },
      h('h3', null, '操作历史'),
      h(
        'p',
        { className: 'dim oh-path' },
        '磁盘侧批操作（脚手架 / .kojo 双文件保存 / 存档注入）的时间线。编辑器内的普通编辑走 Monaco 自己的 Ctrl+Z，不出现在这里。',
      ),
      feedback
        ? h('p', { className: feedback.tone === 'ok' ? 'kd-banner ok' : 'kd-error' }, feedback.text)
        : null,
      body,
      h(
        'div',
        { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: () => setReloadNonce((n) => n + 1) }, '刷新'),
        closeButton(),
      ),
    );
  };
}
