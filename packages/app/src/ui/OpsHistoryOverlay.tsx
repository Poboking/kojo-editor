import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OpEntryView, OpJournal, OpRecord } from '@kojo/plugin-api';
import { formatOpTime, opKindLabel, opStatusLabel } from './ops-history';
import { errorText } from '@kojo/plugin-api';
import {
  TIMELINE_ACCOUNT_LABEL,
  TRASH_HOLD_OPS_OWNER,
  collectGlobalTimeline,
  formatVersionSize,
  getHistoryIo,
  isTimelineStale,
  keepText,
  registerOpsJournal,
  releaseTrashHold,
  type TimelineItem,
} from './file-history';

/**
 * 操作历史 overlay（2026-10-16 undo 批；W11 回收站可见批并入回收站账）。
 *
 * 这一屏是**两本全局账的一条时间线**：磁盘侧批操作（`kernel.ops`）+ 回收站（`kernel.io.listTrash`）。
 * 为什么是这两本：它们都不属于"某一个文件"——批操作天生整批，回收站条目在作者删掉**整个目录**
 * 时可能一个开着的文件都不指向它。少这一屏，回收站就又回到"看不见"。
 *
 * 装配形态照 `FileHistoryOverlay`（App.tsx 注册 ui.overlay + editor.command 槽）；
 * `kernel.io` 句柄经 `file-history` 的账本中转站取用（装配点 App.tsx 本批不动），
 * 取不到就在屏上**如实写明**少了哪本账，不静默。
 *
 * 「撤销此操作」两步确认后走 `ops.undo`：恢复 before 字节 / 删除该批新建的文件——
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
  | { kind: 'ready'; items: TimelineItem[]; notes: string[]; records: OpRecord[]; savedAtMs: number }
  | { kind: 'error'; reason: string };

interface Feedback {
  tone: 'ok' | 'err';
  text: string;
}

/** 展开行的缓存（opId → 文件清单；undo/刷新后失效） */
type EntriesCache = Map<string, OpEntryView[]>;

/** 二次确认的行（撤销 / 放回原位 / 彻底删除都要确认，三者后果不同，必须分清） */
type Pending = { key: string; action: 'undo' | 'restore' | 'purge' } | null;

export function createOpsHistoryOverlay(deps: OpsHistoryDeps): () => unknown {
  // 把批操作句柄登记进账本中转站：「某个文件的四本账」那一屏要用它（App.tsx 本批不动）
  registerOpsJournal(deps.ops);
  return function OpsHistoryOverlay(): unknown {
    const [state, setState] = useState<ListState>({ kind: 'loading' });
    const [reloadNonce, setReloadNonce] = useState(0);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [entries, setEntries] = useState<EntriesCache>(new Map());
    /** 两步确认的待处理行（第一步只点亮确认态，不动盘） */
    const [pending, setPending] = useState<Pending>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const anchorRef = useRef<number>(0);

    const load = (): void => {
      let alive = true;
      setState({ kind: 'loading' });
      setPending(null);
      collectGlobalTimeline(getHistoryIo(), deps.ops)
        .then((bundle) => {
          if (!alive) return;
          anchorRef.current = bundle.savedAtMs;
          setEntries(new Map());
          setExpanded(new Set());
          setState({
            kind: 'ready',
            items: bundle.items,
            notes: bundle.notes,
            records: bundle.records,
            savedAtMs: bundle.savedAtMs,
          });
        })
        .catch((err: unknown) => {
          if (alive) setState({ kind: 'error', reason: errorText(err) });
        });
    };

    useEffect(() => {
      load();
      // 退场只撤回**本屏**的引用登记（另一屏正展示的条目仍受保护，见 `declareTrashHold`）
      return () => releaseTrashHold(getHistoryIo(), TRASH_HOLD_OPS_OWNER);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadNonce]);

    // 剩余保留天数的锚过期 → 整屏重取（**不许**在渲染里拿墙钟就地倒推，见 isTimelineStale）
    useEffect(() => {
      const t = setInterval(() => {
        if (anchorRef.current > 0 && isTimelineStale(anchorRef.current, Date.now())) setReloadNonce((n) => n + 1);
      }, 60_000);
      return () => clearInterval(t);
    }, []);

    const closeButton = (): ReactNode =>
      h('button', { className: 'ghost small', onClick: () => deps.close() }, '关闭');

    if (state.kind === 'loading' || state.kind === 'error') {
      return h(
        'div',
        { className: 'wizard oh-host' },
        h('h3', null, '操作与回收站时间线'),
        state.kind === 'loading'
          ? h('p', { className: 'dim' }, '正在并两本全局账…')
          : h('p', { className: 'kd-error' }, `读取失败：${state.reason}`),
        h('div', { className: 'wizard-actions' }, closeButton()),
      );
    }

    const report = (tone: Feedback['tone'], text: string): void => {
      setFeedback({ tone, text });
      setReloadNonce((n) => n + 1);
    };

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
            text: `文件清单读取失败：${errorText(err)}`,
          });
        }
      }
    };

    const runUndo = async (item: TimelineItem): Promise<void> => {
      const rec = state.records.find((r) => r.id === item.id);
      // 说的是哪一批：账本 label（人话）优先，类别名兜底；op id（`op-<时间戳>-<随机>`）是机器标识，不上屏
      const label = rec === undefined ? '这一批操作' : rec.label || opKindLabel(rec.kind);
      setBusy(true);
      try {
        await deps.ops.undo(item.id);
        report(
          'ok',
          `已撤销「${label}」。游戏目录中的文件会按外部改动口径自动重载；工作区里的文件（如 .kojo 源）请重新打开该标签查看回滚后的内容。`,
        );
      } catch (err: unknown) {
        report('err', errorText(err));
      } finally {
        setBusy(false);
        setPending(null);
      }
    };

    const runPurge = async (item: TimelineItem): Promise<void> => {
      const io = getHistoryIo();
      if (io === null) {
        report('err', '回收站暂时不可用（没有接上文件读写通道），无法彻底删除。');
        return;
      }
      setBusy(true);
      try {
        await io.purgeTrash([item.id]);
        report('ok', `已彻底删除 ${item.title}——这一次是真删，没有回头路。`);
      } catch (err: unknown) {
        report('err', errorText(err));
      } finally {
        setBusy(false);
        setPending(null);
      }
    };

    const runRestoreTrash = async (item: TimelineItem): Promise<void> => {
      const io = getHistoryIo();
      if (io === null) {
        report('err', '回收站暂时不可用（没有接上文件读写通道），无法放回原位。');
        return;
      }
      setBusy(true);
      try {
        const back = await io.restoreFromTrash(item.id);
        report('ok', `已放回原位：${back}。原位若站着东西，它已先被让进写前备份账（同一条时间线看得见）。`);
      } catch (err: unknown) {
        report('err', errorText(err));
      } finally {
        setBusy(false);
        setPending(null);
      }
    };

    /* ---------------- 行渲染（一条时间线，两种账） ---------------- */

    const trashCell = (item: TimelineItem): ReactNode => {
      const cells: ReactNode[] = [];
      if (pending?.key === item.key && pending.action === 'undo') {
        cells.push(
          h(
            'button',
            { key: 'c', className: 'primary small', disabled: busy, onClick: () => void runUndo(item) },
            '确认撤销',
          ),
        );
      } else if (pending?.key === item.key && pending.action === 'purge') {
        cells.push(
          h(
            'button',
            { key: 'c', className: 'primary small', disabled: busy, onClick: () => void runPurge(item) },
            '确认彻底删除',
          ),
        );
      } else if (item.action !== null) {
        cells.push(
          h(
            'button',
            {
              key: 'r',
              className: 'ghost small',
              disabled: busy,
              title: `${item.action.label}（需再点一次确认；原位若站着东西会先被让进写前备份账）`,
              onClick: () => setPending({ key: item.key, action: 'restore' }),
            },
            item.action.label,
          ),
        );
        cells.push(
          h(
            'button',
            {
              key: 'p',
              className: 'ghost small',
              disabled: busy,
              title: '不恢复、直接真删这一条（不可恢复；需再点一次确认）',
              onClick: () => setPending({ key: item.key, action: 'purge' }),
            },
            '彻底删除',
          ),
        );
      }
      return h('div', { className: 'fh-actions' }, ...cells);
    };

    const opsCell = (item: TimelineItem): ReactNode => {
      const rec = state.records.find((r) => r.id === item.id);
      if (rec === undefined) return null;
      const isOpen = expanded.has(rec.id);
      const cells: ReactNode[] = [
        h(
          'button',
          {
            key: 'x',
            className: 'ghost small',
            title: '展开查看这一批涉及的文件',
            onClick: () => void toggle(rec.id),
          },
          isOpen ? '收起' : '展开',
        ),
      ];
      if (pending?.key === item.key && pending.action === 'undo') {
        cells.push(
          h(
            'button',
            {
              key: 'c',
              className: 'primary small',
              disabled: busy,
              title: '把这一批涉及的全部文件恢复到操作前的内容（新建文件将被删除，删除落点是回收站）',
              onClick: () => void runUndo(item),
            },
            '确认撤销',
          ),
        );
      } else {
        cells.push(
          h(
            'button',
            {
              key: 'u',
              className: 'ghost small',
              disabled: busy,
              title:
                rec.status === 'committed'
                  ? '恢复这一批文件到操作前的状态（需再点一次确认）'
                  : '对这次撤销再撤销一次 = 重做原操作',
              onClick: () => setPending({ key: item.key, action: 'undo' }),
            },
            rec.status === 'committed' ? '撤销此操作' : '重做',
          ),
        );
      }
      return h('div', { className: 'fh-actions' }, ...cells);
    };

    const rowsOf = (item: TimelineItem): ReactNode[] => {
      const rows: ReactNode[] = [];
      const rec = item.account === 'ops' ? state.records.find((r) => r.id === item.id) : undefined;
      const account =
        item.account === 'trash' && keepText(item) !== ''
          ? h(
              'span',
              { className: item.keepDaysLeft !== null && item.keepDaysLeft <= 0 ? 'pv-chip bad' : 'pv-chip' },
              h('span', { className: 'pv-chip-label' }, TIMELINE_ACCOUNT_LABEL[item.account]),
              h('span', { className: 'pv-chip-value' }, keepText(item)),
            )
          : h(
              'span',
              { className: 'pv-chip' },
              h('span', { className: 'pv-chip-label' }, TIMELINE_ACCOUNT_LABEL[item.account]),
            );
      rows.push(
        h(
          'tr',
          { key: item.key, className: 'oh-row' },
          h('td', null, item.atMs === null ? '时刻不明' : formatOpTime(item.atMs)),
          h('td', null, account),
          h(
            'td',
            null,
            rec !== undefined
              ? h(
                  'span',
                  null,
                  `${rec.fileCount} 个文件 · ${opStatusLabel(rec)}`,
                  rec.label.length > 0 ? h('span', { className: 'dim' }, ` · ${rec.label}`) : null,
                )
              : h(
                  'span',
                  null,
                  h('div', null, item.title),
                  h('div', { className: 'dim' }, item.meaning),
                  item.size === null ? null : h('div', { className: 'dim' }, formatVersionSize(item.size)),
                ),
          ),
          h(
            'td',
            { className: 'fh-actions' },
            ...(item.account === 'trash' ? [trashCell(item)] : [opsCell(item)]),
          ),
        ),
      );
      if (rec !== undefined && expanded.has(rec.id)) {
        const list = entries.get(rec.id);
        rows.push(
          h(
            'tr',
            { key: `${rec.id}-detail`, className: 'oh-detail' },
            h(
              'td',
              { colSpan: 4 },
              item.warnings.length > 0
                ? h(
                    'ul',
                    { className: 'oh-files' },
                    ...item.warnings.map((w, i) => h('li', { key: `w${i}` }, w)),
                  )
                : null,
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
                          h(
                            'span',
                            { className: e.hasBefore ? 'oh-kind-mod' : 'oh-kind-new' },
                            e.hasBefore ? '改写' : '新建',
                          ),
                          ' ',
                          e.path,
                        ),
                      ),
                    ),
            ),
          ),
        );
      }
      if (item.account === 'trash' && item.warnings.length > 0) {
        rows.push(
          h(
            'tr',
            { key: `${item.key}-warn`, className: 'oh-detail' },
            h(
              'td',
              { colSpan: 4 },
              h(
                'ul',
                { className: 'oh-files' },
                ...item.warnings.map((w, i) => h('li', { key: `w${i}` }, w)),
              ),
            ),
          ),
        );
      }
      return rows;
    };

    const body: ReactNode =
      state.items.length === 0
        ? h(
            'p',
            { className: 'dim' },
            '还没有可撤销的批操作，回收站也是空的。脚手架创建、.kojo 保存（源+产物）、存档变量注入、跨文件全部替换、部署与市场装卸会记进这里；删除（整目录或单文件）会进回收站。',
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
                h('th', null, '哪本账'),
                h('th', null, '内容'),
                h('th', null, ''),
              ),
            ),
            h('tbody', null, ...state.items.flatMap(rowsOf)),
          );

    return h(
      'div',
      { className: 'wizard oh-host' },
      h('h3', null, '操作与回收站时间线'),
      h(
        'p',
        { className: 'dim oh-path' },
        '磁盘侧批操作（脚手架 / .kojo 双文件保存 / 存档注入 / 跨文件全部替换 / 部署 / 市场装卸）与回收站条目按时刻并成一条线。编辑器内的普通编辑走编辑器自己的 Ctrl+Z，不出现在这里；跨文件替换撤销后，已打开标签里的那部分请用编辑器内 Ctrl+Z；某个文件的完整四本账请看「显示当前文件的历史版本」。',
      ),
      state.notes.length > 0
        ? h(
            'div',
            { className: 'pv-summary' },
            ...state.notes.map((n, i) => h('p', { key: `note-${i}`, className: 'pv-chip warn' }, n)),
          )
        : null,
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
