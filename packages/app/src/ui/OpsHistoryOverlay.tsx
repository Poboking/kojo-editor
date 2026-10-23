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
  type TimelineAccount,
  type TimelineItem,
} from './file-history';
import { declareContextSurface } from './context-surfaces';
import type { ContextMenuItem } from './context-menu-model';
import { overlayFrame, overlaySkeletonRows, overlaySpinner } from './overlay-chrome';

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

/* ==================== 右键菜单（WP3.5 · 1023 覆盖面批） ==================== */

export const OPS_HISTORY_SURFACE_ID = 'ops-history';

/** 菜单项 id（面自己分发；不是命令 id，不冒充命令） */
export const OPS_HISTORY_MENU_IDS = {
  toggleDetail: 'oh.toggleDetail',
  copySummary: 'oh.copySummary',
  copyPath: 'oh.copyPath',
  undo: 'oh.undo',
  restore: 'oh.restore',
  purge: 'oh.purge',
  refresh: 'oh.refresh',
  close: 'oh.close',
} as const;

/** 行身份（从行元素的 `data-oh-*` 读） */
export interface OpsHistoryRowRef {
  readonly key: string;
  readonly account: TimelineAccount;
  readonly title: string;
  readonly timeText: string;
  /** 可读取的盘上路径（回收站里的文件条目才有） */
  readonly path: string | null;
  readonly hasAction: boolean;
  readonly actionLabel: string | null;
  readonly actionKind: 'undoOp' | 'restoreTrash' | null;
  /** 批操作那一批的状态（trash 行 = null） */
  readonly status: OpRecord['status'] | null;
  readonly fileCount: number;
  /** 这一行有可展开的文件清单（批操作才有） */
  readonly expandable: boolean;
}

/** 一次菜单构建的全部输入（"已展开 / 忙碌 / 已点亮确认"由组件补） */
export interface OpsHistoryMenuInput {
  readonly row: (OpsHistoryRowRef & {
    readonly expanded: boolean;
    readonly pendingAction: 'undo' | 'restore' | 'purge' | null;
    readonly busy: boolean;
  }) | null;
  readonly clipboardAvailable: boolean;
}

const OP_ACTION_KINDS: readonly ('undoOp' | 'restoreTrash')[] = ['undoOp', 'restoreTrash'];

/** 一条时间线条目 → 可复制摘要（账本 / 时刻 / 标题 / 含义 / 保留期 / 注意） */
export function opsSummaryText(item: TimelineItem): string {
  const time = item.atMs === null ? '时刻不明' : formatOpTime(item.atMs);
  const lines = [`${TIMELINE_ACCOUNT_LABEL[item.account]} · ${time} · ${item.title}`, item.meaning];
  const keep = keepText(item);
  if (keep !== '') lines.push(`保留期：${keep}`);
  for (const warning of item.warnings) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

/**
 * 操作历史菜单（纯函数）：批操作行给「展开 / 收起文件清单 + 撤销（或重做）」，
 * 回收站行给「放回原位 + 彻底删除」，两行共用复制类；面板级 = 刷新 / 关闭。
 *
 * 撤销 / 放回原位 / 彻底删除**只做入口**：点亮行上既有的两步确认，真正动手仍由
 * 确认按钮触发——菜单不绕过确认链，也不在这里新造任何写盘语义。
 */
export function buildOpsHistoryMenu(input: OpsHistoryMenuInput): { items: ContextMenuItem[] } | null {
  const items: ContextMenuItem[] = [];
  const copyGate =
    input.clipboardAvailable ? {} : { disabled: true, disabledReason: '当前环境没有可用的剪贴板' };
  const row = input.row;

  if (row !== null) {
    if (row.expandable) {
      items.push({
        id: OPS_HISTORY_MENU_IDS.toggleDetail,
        label: row.expanded ? '收起文件清单' : '展开文件清单',
        icon: 'structure',
        group: '这一行',
      });
    }
    items.push({ id: OPS_HISTORY_MENU_IDS.copySummary, label: '复制这一条摘要', icon: 'files', ...copyGate });
    if (row.path !== null) {
      items.push({ id: OPS_HISTORY_MENU_IDS.copyPath, label: '复制这一条的路径', icon: 'files', ...copyGate });
    }
    if (row.hasAction && row.actionKind === 'undoOp') {
      const undoable = row.status === 'committed';
      const pendingHint = row.pendingAction === 'undo' ? '（已点亮确认，回行上再点一次才动手）' : '（需再点一次确认）';
      items.push({
        id: OPS_HISTORY_MENU_IDS.undo,
        label: `${undoable ? '撤销此操作' : '重做这一批'}${pendingHint}`,
        icon: 'restore',
        group: '恢复',
        ...(row.busy ? { disabled: true, disabledReason: '正在写入，稍后再试' } : {}),
      });
    }
    if (row.hasAction && row.actionKind === 'restoreTrash') {
      const pendingHint = row.pendingAction === 'restore' ? '（已点亮确认，回行上再点一次才放回）' : '（需再点一次确认）';
      items.push({
        id: OPS_HISTORY_MENU_IDS.restore,
        label: `放回原位${pendingHint}`,
        icon: 'restore',
        group: '恢复',
        ...(row.busy ? { disabled: true, disabledReason: '正在写入，稍后再试' } : {}),
      });
      const purgeHint = row.pendingAction === 'purge' ? '（已点亮确认，回行上再点一次才真删）' : '（需再点一次确认）';
      items.push({
        id: OPS_HISTORY_MENU_IDS.purge,
        label: `彻底删除${purgeHint}`,
        icon: 'trash',
        danger: true,
        group: '删除',
        ...(row.busy ? { disabled: true, disabledReason: '正在写入，稍后再试' } : {}),
      });
    }
  }

  items.push({
    id: OPS_HISTORY_MENU_IDS.refresh,
    label: '刷新时间线',
    icon: 'refresh',
    dividerBefore: row === null,
  });
  items.push({ id: OPS_HISTORY_MENU_IDS.close, label: '关闭', icon: 'close' });
  return { items };
}

/** 行元素的 `data-oh-*` → 行身份（读不出 ⇒ null，面回落成面板级菜单） */
export function readOpsHistoryRow(target: HTMLElement): OpsHistoryRowRef | null {
  const el = target.closest<HTMLElement>('[data-oh-key]');
  if (el === null) return null;
  const key = el.getAttribute('data-oh-key');
  const account = el.getAttribute('data-oh-account');
  if (key === null || key === '' || (account !== 'ops' && account !== 'trash')) return null;
  const actionKind = el.getAttribute('data-oh-action');
  const path = el.getAttribute('data-oh-path');
  const actionLabel = el.getAttribute('data-oh-action-label');
  const status = el.getAttribute('data-oh-status');
  const fileCount = Number(el.getAttribute('data-oh-file-count') ?? '0');
  const kind = (OP_ACTION_KINDS as readonly string[]).includes(actionKind ?? '')
    ? (actionKind as 'undoOp' | 'restoreTrash')
    : null;
  return {
    key,
    account,
    title: el.getAttribute('data-oh-title') ?? '',
    timeText: el.getAttribute('data-oh-time') ?? '',
    path: path === null || path === '' ? null : path,
    hasAction: kind !== null,
    actionLabel: actionLabel === null || actionLabel === '' ? null : actionLabel,
    actionKind: kind,
    status: status === 'committed' || status === 'undone' ? status : null,
    fileCount: Number.isFinite(fileCount) ? fileCount : 0,
    expandable: el.getAttribute('data-oh-expandable') === '1',
  };
}

/** 剪贴板入口（缺席 ⇒ null：复制项禁用并说清原因） */
function clipboardApi(): Clipboard | null {
  return typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null);
}

/**
 * 面 ↔ 组件的动作桥（面在模块顶层声明，读不到 React 闭包；`run` 的真实实现在组件末尾
 * 才装配得齐，所以经 ref 转发——不能把 effect 挪到早退之后，那会改 hook 顺序）。
 */
interface OpsHistoryFaceBridge {
  readonly clipboardAvailable: boolean;
  readonly busy: boolean;
  pendingActionOf(key: string): 'undo' | 'restore' | 'purge' | null;
  expandedOf(key: string): boolean;
  run(id: string, row: OpsHistoryRowRef | null): void;
}

let faceBridge: OpsHistoryFaceBridge | null = null;

declareContextSurface({
  id: OPS_HISTORY_SURFACE_ID,
  ariaLabel: '操作历史菜单',
  area: 'panel',
  build: ({ target }) => {
    const bridge = faceBridge;
    if (bridge === null) return null;
    const ref = readOpsHistoryRow(target);
    const input: OpsHistoryMenuInput = {
      row:
        ref === null
          ? null
          : {
              ...ref,
              expanded: bridge.expandedOf(ref.key),
              pendingAction: bridge.pendingActionOf(ref.key),
              busy: bridge.busy,
            },
      clipboardAvailable: bridge.clipboardAvailable,
    };
    const menu = buildOpsHistoryMenu(input);
    if (menu === null) return null;
    return { items: menu.items, onSelect: (id) => bridge.run(id, ref) };
  },
});

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

    /** 菜单动作的真实实现（要用到早退之后定义的各条通道，经 ref 转发给模块顶层的面） */
    const runFaceActionRef = useRef<(id: string, row: OpsHistoryRowRef | null) => void>(() => undefined);

    /** 复制反馈：成败都上屏（剪贴板拒绝时静默 = "点了没反应"，铁律 4） */
    const copyToClipboard = (text: string, doneNote: string): void => {
      const clip = clipboardApi();
      if (clip === null) {
        setFeedback({ tone: 'err', text: '复制失败：当前环境没有可用的剪贴板' });
        return;
      }
      void clip.writeText(text).then(
        () => setFeedback({ tone: 'ok', text: doneNote }),
        () => setFeedback({ tone: 'err', text: '复制失败：剪贴板拒绝了这次写入' }),
      );
    };

    /**
     * 右键菜单的动作桥（每次渲染后刷新）。撤销 / 放回原位 / 彻底删除**只点亮行上既有的
     * 两步确认**（`setPending`），真正动手仍由确认按钮触发——菜单不绕过确认链。
     */
    useEffect(() => {
      const entry: OpsHistoryFaceBridge = {
        clipboardAvailable: clipboardApi() !== null,
        busy,
        pendingActionOf: (key) => (pending !== null && pending.key === key ? pending.action : null),
        expandedOf: (key) => {
          if (state.kind !== 'ready') return false;
          const item = state.items.find((i) => i.key === key);
          return item !== undefined && expanded.has(item.id);
        },
        run: (id, row) => runFaceActionRef.current(id, row),
      };
      faceBridge = entry;
      return () => {
        if (faceBridge === entry) faceBridge = null;
      };
    });

    const closeButton = (): ReactNode =>
      h('button', { className: 'ghost small', onClick: () => deps.close() }, '关闭');

    if (state.kind === 'loading' || state.kind === 'error') {
      // 读不动时菜单只剩刷新 / 关闭：两条都必须真的做得成（刷新 = 重取一次，可当重试用）
      runFaceActionRef.current = (id) => {
        if (id === OPS_HISTORY_MENU_IDS.refresh) setReloadNonce((n) => n + 1);
        else if (id === OPS_HISTORY_MENU_IDS.close) deps.close();
      };
      return overlayFrame({
        hostClass: 'oh-host',
        title: '操作与回收站时间线',
        tier: 'wide',
        // 这一家有「撤销此批 / 清空回收站」，是破坏性面 ⇒ 遮罩保持 modal 那一档
        onClose: () => deps.close(),
        contextSurface: OPS_HISTORY_SURFACE_ID,
        children:
          state.kind === 'loading'
            ? h('div', null, overlaySpinner('正在并两本全局账…'), overlaySkeletonRows(5))
            : h('p', { className: 'kd-error' }, `读取失败：${state.reason}`),
        footer: closeButton(),
      });
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
      const isPending = pending?.key === item.key;
      if (isPending && pending.action === 'undo') {
        cells.push(
          h(
            'button',
            { key: 'c', className: 'primary small', disabled: busy, onClick: () => void runUndo(item) },
            '确认撤销',
          ),
        );
      } else if (isPending && pending.action === 'restore') {
        // 放回原位这一步此前只点亮 `pending`、没有确认分支（`runRestoreTrash` 因此从未被调用）：
        // 第一次点击给"看清楚了再点一次"的确认态，第二次才真放回（与撤销 / 彻底删除同一条规矩）
        cells.push(
          h(
            'button',
            {
              key: 'c',
              className: 'primary small',
              disabled: busy,
              title: '再点一次即放回原位（原位若站着东西会先被让进写前备份账）',
              onClick: () => void runRestoreTrash(item),
            },
            '确认放回原位',
          ),
        );
      } else if (isPending && pending.action === 'purge') {
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
          {
            key: item.key,
            className: 'oh-row',
            // 右键菜单靠这些属性认出这一行（模块顶层的面读 DOM，不靠 React 闭包）
            'data-oh-key': item.key,
            'data-oh-account': item.account,
            'data-oh-title': item.title,
            'data-oh-time': item.atMs === null ? '时刻不明' : formatOpTime(item.atMs),
            'data-oh-path': item.diffPath ?? '',
            'data-oh-action': item.action?.kind ?? '',
            'data-oh-action-label': item.action?.label ?? '',
            'data-oh-status': rec?.status ?? '',
            'data-oh-file-count': String(rec?.fileCount ?? 0),
            'data-oh-expandable': rec === undefined ? '0' : '1',
          },
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

    /**
     * 菜单动作装配（每次渲染重写）：复制走剪贴板（成败上屏）、展开清单走 `toggle`、
     * 撤销 / 放回原位 / 彻底删除只**点亮**行上既有的两步确认、刷新走本屏重取。
     */
    runFaceActionRef.current = (id, row) => {
      const item = row === null ? null : state.items.find((i) => i.key === row.key) ?? null;
      switch (id) {
        case OPS_HISTORY_MENU_IDS.toggleDetail:
          if (item !== null) void toggle(item.id);
          return;
        case OPS_HISTORY_MENU_IDS.copySummary:
          if (item !== null) copyToClipboard(opsSummaryText(item), '已复制这一条摘要');
          return;
        case OPS_HISTORY_MENU_IDS.copyPath:
          if (item !== null && item.diffPath !== null) copyToClipboard(item.diffPath, '已复制路径');
          return;
        case OPS_HISTORY_MENU_IDS.undo:
          if (item !== null) setPending({ key: item.key, action: 'undo' });
          return;
        case OPS_HISTORY_MENU_IDS.restore:
          if (item !== null) setPending({ key: item.key, action: 'restore' });
          return;
        case OPS_HISTORY_MENU_IDS.purge:
          if (item !== null) setPending({ key: item.key, action: 'purge' });
          return;
        case OPS_HISTORY_MENU_IDS.refresh:
          setReloadNonce((n) => n + 1);
          return;
        case OPS_HISTORY_MENU_IDS.close:
          deps.close();
          return;
        default:
          return;
      }
    };

    return overlayFrame({
      hostClass: 'oh-host',
      title: '操作与回收站时间线',
      tier: 'wide',
      // 破坏性面（批回滚 / 清空回收站）⇒ 遮罩保持 modal 那一档
      onClose: () => deps.close(),
      contextSurface: OPS_HISTORY_SURFACE_ID,
      children: [
        h(
          'p',
          { key: 'scope', className: 'dim oh-path' },
          '磁盘侧批操作（脚手架 / .kojo 双文件保存 / 存档注入 / 跨文件全部替换 / 部署 / 市场装卸）与回收站条目按时刻并成一条线。编辑器内的普通编辑走编辑器自己的 Ctrl+Z，不出现在这里；跨文件替换撤销后，已打开标签里的那部分请用编辑器内 Ctrl+Z；某个文件的完整四本账请看「显示当前文件的历史版本」。',
        ),
        state.notes.length > 0
          ? h(
              'div',
              { key: 'notes', className: 'pv-summary' },
              ...state.notes.map((n, i) => h('p', { key: `note-${i}`, className: 'pv-chip warn' }, n)),
            )
          : null,
        feedback
          ? h('p', { key: 'fb', className: feedback.tone === 'ok' ? 'kd-banner ok' : 'kd-error' }, feedback.text)
          : null,
        body,
      ],
      footer: [
        h('button', { key: 'reload', className: 'ghost small', onClick: () => setReloadNonce((n) => n + 1) }, '刷新'),
        closeButton(),
      ],
    });
  };
}
