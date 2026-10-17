import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileIO } from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';
import {
  TIMELINE_ACCOUNT_LABEL,
  TRASH_HOLD_FILE_OWNER,
  collectFileTimeline,
  formatVersionSize,
  formatVersionTime,
  getOpsJournal,
  isTimelineStale,
  keepText,
  registerHistoryIo,
  releaseTrashHold,
  type TimelineFetchState,
  type TimelineItem,
  getFileHistoryTarget,
  subscribeFileHistory,
  setFileHistoryTarget,
} from './file-history';
import { peekRecoveredContent } from './recovery-store';

/**
 * 本地时间线 overlay（F2；2026-10-15 历史批 → W11 回收站可见批改成「四本账一条时间线」）。
 *
 * 一屏之内并四条版本线：**写前备份 / 批操作快照 / 回收站 / 未保存快照（含崩溃恢复件）**。
 * 每一行都写清三件事：①它来自哪本账 ②恢复它意味着什么 ③跨账的坑（撤销是整批、
 * 目录级恢复不做覆盖、编辑器里还有更新的一份、写允许域已收回）。
 * **刻意不做第五个独立列表**：合并与文案全在 `file-history.ts`（纯逻辑，可单测），
 * 本组件只做渲染 + 把动作派回**各本账自己既有**的恢复通道：
 * - 写前备份 → `io.restoreBackup`（内核：第一道闸 + 写前自动备份 + 原子写）
 * - 回收站   → `io.listTrash` / `io.restoreFromTrash` / `io.purgeTrash`
 * - 批操作   → `kernel.ops` 的 `undo`（对已撤销的批再 undo = 重做）
 * - 未保存快照 → `io.writeText`（同一条编辑保存链路，写前自动备份照做）
 *
 * 「恢复前把现状落进同一条时间线」这件事不在本组件里发明：上列四条通道**各自**已经
 * 先备份/先记快照（`restoreBackup` / `restoreFromTrash` / journal undo / `writeText`），
 * 恢复动作做完后本屏会重取一次，于是那份"现状"就出现在屏幕上——这就是它可预期的原因。
 *
 * 编辑器内存态由外部改动重载口径接管（watcher → `file.changed`），本窗不越俎代庖。
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

type ListState = TimelineFetchState;

interface Feedback {
  tone: 'ok' | 'err';
  text: string;
}

/** 二次确认的那一步（恢复与彻底删除都要确认，且必须分清是哪一种——两者的后果相反） */
type Pending = { key: string; action: 'restore' | 'purge' } | null;

const timeText = (item: TimelineItem): string =>
  item.atMs === null
    ? '时刻不明' // 判据不猜：这本账给不出时刻就如实说不清（该行沉底）
    : formatVersionTime({ takenAtMs: item.atMs, mtimeMs: item.atMs });

export function createFileHistoryOverlay(deps: FileHistoryDeps): () => unknown {
  // 把 io 句柄登记进账本中转站：「操作历史」那一屏要用回收站账，而装配点 App.tsx 本批不动
  registerHistoryIo(deps.io);
  return function FileHistoryOverlay(): unknown {
    const [, setTick] = useState(0);
    useEffect(() => subscribeFileHistory(() => setTick((t) => t + 1)), []);
    const target = getFileHistoryTarget();

    const [state, setState] = useState<ListState>({ kind: 'loading' });
    const [reloadNonce, setReloadNonce] = useState(0);
    /** 二次确认的行（第一步只点亮确认态，不写盘） */
    const [pending, setPending] = useState<Pending>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [busy, setBusy] = useState(false);
    /** 本屏的取数锚（剩余天数的"此刻"；过一天就整屏重取，见 `isTimelineStale`） */
    const anchorRef = useRef(0);

    useEffect(() => {
      if (target === null) return;
      let alive = true;
      setState({ kind: 'loading' });
      setPending(null);
      collectFileTimeline(deps.io, getOpsJournal(), target)
        .then((bundle) => {
          if (!alive) return;
          anchorRef.current = bundle.savedAtMs;
          setState({ kind: 'ready', bundle });
        })
        .catch((err: unknown) => {
          if (alive)
            setState({ kind: 'error', reason: err instanceof Error ? err.message : String(err) });
        });
      // 退场只撤回**本屏**的引用登记：另一屏（操作历史）正展示的条目不该被这一屏的卸载放行去清扫
      return () => {
        alive = false;
        releaseTrashHold(deps.io, TRASH_HOLD_FILE_OWNER);
      };
    }, [target, reloadNonce]);

    // 锚过期 → 整屏重取。绝不在渲染里拿墙钟倒推剩余天数：那会让同一屏两次说出两种话
    useEffect(() => {
      const t = setInterval(() => {
        if (anchorRef.current > 0 && isTimelineStale(anchorRef.current, Date.now())) setReloadNonce((n) => n + 1);
      }, 60_000);
      return () => clearInterval(t);
    }, []);

    if (target === null) {
      return h(
        'div',
        { className: 'wizard fh-host' },
        h('p', { className: 'dim' }, '当前没有选中的文件。请在编辑器里打开一个文件再查看其时间线。'),
      );
    }

    /* ---------------- 动作：全部派回各本账既有的通道 ---------------- */

    const report = (tone: Feedback['tone'], text: string): void => {
      setFeedback({ tone, text });
      setReloadNonce((n) => n + 1); // 现状已落账：重取一次，让它出现在同一条时间线上
    };

    const snapshotText = async (item: TimelineItem, handle: string): Promise<string> => {
      if (item.account === 'recovery') {
        // 进程内那份（还没被编辑器领走）：只看不取——领走是编辑器建 model 那一次的语义
        const v = peekRecoveredContent(target);
        if (v === null) throw new Error('恢复通道里那一份已经被编辑器取走了——请直接看编辑器标签。');
        return v.text;
      }
      return (await deps.io.readText(handle)).text;
    };

    const restore = async (item: TimelineItem): Promise<void> => {
      const action = item.action;
      if (action === null) return;
      setBusy(true);
      try {
        switch (action.kind) {
          case 'restoreBackup': {
            await deps.io.restoreBackup(target, action.id);
            report('ok', `已把磁盘内容换成 ${timeText(item)} 那一版；换掉之前的内容已自动备份进本时间线。`);
            break;
          }
          case 'restoreTrash': {
            const back = await deps.io.restoreFromTrash(action.id);
            report('ok', `已放回原位：${back}。这一条已经用掉，刷新后它会从本时间线里消失（备份账里那一份现状会留下）。`);
            break;
          }
          case 'undoOp': {
            const ops = getOpsJournal();
            if (ops === null) throw new Error('批操作账不在位（kernel.ops 未注册），这一条恢复不了。');
            await ops.undo(action.id);
            report(
              'ok',
              `已对「${item.title}」再撤销一次（撤销本身也进账，回滚前的内容因此留了底）。游戏目录里的文件按外部改动口径重载；工作区里的文件请重新打开该标签。`,
            );
            break;
          }
          case 'writeBackSnapshot': {
            const text = await snapshotText(item, action.id);
            await deps.io.writeText(target, text); // 同一条编辑保存链路：写前自动备份照做
            report(
              'ok',
              '已把这份未保存快照写回磁盘；磁盘原内容已自动备份进本时间线。注意：编辑器此刻的内存内容没有被替换——若它更新，保存会盖掉这次恢复。',
            );
            break;
          }
        }
      } catch (err: unknown) {
        // 只读的游戏目录拒绝 = WriteNotAllowedError——原因整条呈现（不静默），失败态常驻
        report('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setPending(null);
      }
    };

    const purge = async (item: TimelineItem): Promise<void> => {
      const action = item.action;
      if (action === null || action.kind !== 'restoreTrash') return;
      setBusy(true);
      try {
        await deps.io.purgeTrash([action.id]);
        report('ok', `已彻底删除「${item.title}」——这一次是真删，回收站里没有回头路。`);
      } catch (err: unknown) {
        report('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setPending(null);
      }
    };

    /* ---------------- 渲染 ---------------- */

    const actionCell = (item: TimelineItem): ReactNode => {
      const buttons: ReactNode[] = [];
      const diffPath = item.diffPath;
      if (diffPath !== null) {
        buttons.push(
          h(
            'button',
            {
              key: 'diff',
              className: 'ghost small',
              title: '在 diff 视图里对比这一条与磁盘当前内容（行级差异由 Monaco 呈现）',
              onClick: () =>
                deps.requestDiff({
                  title: `${basename(target)} · ${TIMELINE_ACCOUNT_LABEL[item.account]} ${timeText(item)}`,
                  original: {
                    label: `${TIMELINE_ACCOUNT_LABEL[item.account]} · ${timeText(item)}`,
                    path: diffPath,
                  },
                  modified: { label: '磁盘当前内容', path: target },
                }),
            },
            '对比',
          ),
        );
      }
      if (item.action !== null) {
        const isRestorePending = pending?.key === item.key && pending.action === 'restore';
        buttons.push(
          h(
            'button',
            {
              key: 'restore',
              className: isRestorePending ? 'primary small' : 'ghost small',
              disabled: busy,
              title: isRestorePending
                ? '再点一次即写盘（各本账都会先把磁盘现状落进本时间线）'
                : `${item.action.label}（需再点一次确认；恢复前磁盘现状自动落账）`,
              onClick: () => (isRestorePending ? void restore(item) : setPending({ key: item.key, action: 'restore' })),
            },
            isRestorePending ? `确认${item.action.label}` : item.action.label,
          ),
        );
        if (item.action.kind === 'restoreTrash') {
          const isPurgePending = pending?.key === item.key && pending.action === 'purge';
          buttons.push(
            h(
              'button',
              {
                key: 'purge',
                className: isPurgePending ? 'primary small' : 'ghost small',
                disabled: busy,
                title: isPurgePending ? '再点一次即真删（不可恢复）' : '不恢复、直接真删这一条（不可恢复）',
                onClick: () => (isPurgePending ? void purge(item) : setPending({ key: item.key, action: 'purge' })),
              },
              isPurgePending ? '确认彻底删除' : '彻底删除',
            ),
          );
        }
      }
      return h('div', { className: 'fh-actions' }, ...buttons);
    };

    const rowOf = (item: TimelineItem): ReactNode =>
      h(
        'tr',
        { key: item.key, className: 'fh-row' },
        h('td', null, timeText(item)),
        h(
          'td',
          null,
          h(
            'span',
            { className: item.account === 'trash' && (item.keepDaysLeft === null || item.keepDaysLeft <= 0) ? 'pv-chip bad' : 'pv-chip' },
            h('span', { className: 'pv-chip-label' }, TIMELINE_ACCOUNT_LABEL[item.account]),
            item.account === 'trash' ? h('span', { className: 'pv-chip-value' }, keepText(item)) : null,
          ),
        ),
        h(
          'td',
          null,
          h('div', null, item.title),
          h('div', { className: 'dim' }, item.meaning),
          item.warnings.length > 0
            ? h(
                'ul',
                { className: 'oh-files' },
                ...item.warnings.map((w, i) => h('li', { key: `${item.key}-w${i}`, className: 'pv-chip warn' }, w)),
              )
            : null,
        ),
        h('td', null, item.size === null ? '—' : formatVersionSize(item.size)),
        h('td', { className: 'fh-actions' }, actionCell(item)),
      );

    let body: ReactNode;
    if (state.kind === 'loading') {
      body = h('p', { className: 'dim' }, '正在并四本账…');
    } else if (state.kind === 'error') {
      body = h('p', { className: 'kd-error' }, `时间线读取失败：${state.reason}`);
    } else {
      const { items, notes } = state.bundle;
      const noteBlock =
        notes.length > 0
          ? h(
              'div',
              { className: 'pv-summary' },
              ...notes.map((n, i) => h('p', { key: `note-${i}`, className: 'pv-chip warn' }, n)),
            )
          : null;
      body =
        items.length === 0
          ? h(
              'div',
              null,
              noteBlock,
              h(
                'p',
                { className: 'dim' },
                '这个文件在四本账里一条都没有：只要保存过一次就会有写前备份；批操作、删除、崩溃快照各记各的。',
              ),
            )
          : h(
              'table',
              { className: 'fh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '时间'),
                  h('th', null, '哪本账'),
                  h('th', null, '这是什么 · 恢复它意味着什么'),
                  h('th', null, '大小'),
                  h('th', null, ''),
                ),
              ),
              h('tbody', null, ...items.map(rowOf)),
            );
    }

    return h(
      'div',
      { className: 'wizard fh-host' },
      h('h3', null, `时间线 —— ${basename(target)}`),
      h('p', { className: 'dim fh-path' }, target),
      h(
        'p',
        { className: 'dim' },
        '一条时间线，四本账：写前备份 / 批操作快照 / 回收站 / 未保存快照。每行都写明它来自哪本账、恢复它会发生什么；恢复前的磁盘现状一律先落进同一本账，不会被吃掉。',
      ),
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
