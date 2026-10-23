import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileIO } from '@kojo/plugin-api';
import {errorText,  basename } from '@kojo/plugin-api';
import {
  TIMELINE_ACCOUNT_LABEL,
  TRASH_HOLD_FILE_OWNER,
  collectFileTimeline,
  diffPairButtonState,
  diffableTimelineItem,
  formatVersionSize,
  formatVersionTime,
  getOpsJournal,
  isTimelineStale,
  keepText,
  orderDiffPair,
  registerHistoryIo,
  releaseTrashHold,
  type TimelineAccount,
  type TimelineActionKind,
  type TimelineFetchState,
  type TimelineItem,
  getFileHistoryTarget,
  subscribeFileHistory,
  setFileHistoryTarget,
} from './file-history';
import { peekRecoveredContent } from './recovery-store';
import { declareContextSurface } from './context-surfaces';
import type { ContextMenuItem } from './context-menu-model';

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
 *
 * P2-15 两版互比：每行行首可勾选，恰好两条时「对比两版」亮起——内容取自该条自己
 * 的读面（盘上路径走 diff 的 `path` 侧、崩溃恢复件取进程内那份走 `text` 侧，
 * 不新造读盘通道）；勾选 0/1/多余 2 条时按钮禁用并写明原因（铁律 4）。
 * 行尾原来的「对比」（与磁盘当前内容比）原样保留。
 */

export interface FileHistoryDeps {
  io: FileIO;
  /**
   * 请求宿主打开通用 diff 模态。两侧各「内联文本或磁盘路径」二选一（与
   * `ui.diffView.open` 载荷同形）：`path` = 盘上真文件由宿主现读；`text` = 本屏
   * 已在内存里取到的内容（崩溃恢复件没有盘上路径，只有这一形态）。
   */
  requestDiff(payload: {
    title: string;
    original: { label: string; path?: string; text?: string };
    modified: { label: string; path?: string; text?: string };
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

/* ==================== 右键菜单（WP3.5 · 1023 覆盖面批） ==================== */

export const FILE_HISTORY_SURFACE_ID = 'file-history';

/** 菜单项 id（面自己分发；不是命令 id，不冒充命令） */
export const FILE_HISTORY_MENU_IDS = {
  copySummary: 'fh.copySummary',
  copyPath: 'fh.copyPath',
  diffNow: 'fh.diffNow',
  restore: 'fh.restore',
  purge: 'fh.purge',
  refresh: 'fh.refresh',
  copyTargetPath: 'fh.copyTargetPath',
  close: 'fh.close',
} as const;

/** 行身份（从行元素的 `data-fh-*` 读；模块顶层的面不靠 React 闭包） */
export interface FileHistoryRowRef {
  readonly key: string;
  readonly account: TimelineAccount;
  readonly title: string;
  readonly timeText: string;
  readonly keepText: string;
  /** 可读取的盘上路径（对比 / 复制路径）；null = 这一条没有单个可比对文件 */
  readonly path: string | null;
  /** 这一条有可执行的恢复动作（写允许域放行且这条账本来就能动） */
  readonly hasAction: boolean;
  readonly actionLabel: string | null;
  readonly actionKind: TimelineActionKind | null;
}

/** 一次菜单构建的全部输入（行上的"确认态 / 忙碌"由组件补进来） */
export interface FileHistoryMenuInput {
  readonly row: (FileHistoryRowRef & {
    /** 这一行已经点亮了哪一步确认（菜单不当第二道确认，只如实说明） */
    readonly pendingAction: 'restore' | 'purge' | null;
    readonly busy: boolean;
  }) | null;
  /** 这一屏的目标文件（面板级「复制路径」用） */
  readonly targetPath: string | null;
  readonly clipboardAvailable: boolean;
}

/** 一条时间线条目 → 可复制摘要（账本 / 时刻 / 标题 / 含义 / 保留期 / 注意） */
export function timelineSummaryText(item: TimelineItem): string {
  const lines = [`${TIMELINE_ACCOUNT_LABEL[item.account]} · ${timeText(item)} · ${item.title}`, item.meaning];
  const keep = keepText(item);
  if (keep !== '') lines.push(`保留期：${keep}`);
  for (const warning of item.warnings) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

function copyDisabledReason(clipboardAvailable: boolean): string | undefined {
  return clipboardAvailable ? undefined : '当前环境没有可用的剪贴板';
}

/**
 * 文件历史菜单（纯函数）：行级 = 复制摘要 / 复制路径 / 与磁盘对比 | 恢复（点亮确认）| 彻底删除；
 * 面板级 = 刷新 / 复制目标路径 / 关闭。
 *
 * 恢复与彻底删除**只做入口**：菜单项点亮行上既有的二次确认，真正的写盘仍由确认按钮触发
 * ——菜单不许成为绕开确认链的第二条路。
 */
export function buildFileHistoryMenu(input: FileHistoryMenuInput): { items: ContextMenuItem[] } | null {
  const items: ContextMenuItem[] = [];
  // 没有目标文件、也没点在行上：这一屏确实没有可做的事，只留关闭（不摆无效的刷新 / 复制）
  if (input.row === null && input.targetPath === null) {
    return { items: [{ id: FILE_HISTORY_MENU_IDS.close, label: '关闭', icon: 'close' }] };
  }
  const copyReason = copyDisabledReason(input.clipboardAvailable);
  const copyGate = copyReason === undefined ? {} : { disabled: true, disabledReason: copyReason };
  const row = input.row;

  if (row !== null) {
    items.push({
      id: FILE_HISTORY_MENU_IDS.copySummary,
      label: '复制这一条摘要',
      icon: 'files',
      group: '这一行',
      ...copyGate,
    });
    if (row.path !== null) {
      items.push({ id: FILE_HISTORY_MENU_IDS.diffNow, label: '与磁盘当前内容对比', icon: 'preview' });
      items.push({ id: FILE_HISTORY_MENU_IDS.copyPath, label: '复制这一条的路径', icon: 'files', ...copyGate });
    }
    if (row.hasAction) {
      const pendingHint = row.pendingAction === 'restore' ? '（已点亮确认，回行上再点一次才写盘）' : '（需再点一次确认）';
      items.push({
        id: FILE_HISTORY_MENU_IDS.restore,
        label: `${row.actionLabel ?? '恢复这一版'}${pendingHint}`,
        icon: 'restore',
        group: '恢复',
        ...(row.busy ? { disabled: true, disabledReason: '正在写入，稍后再试' } : {}),
      });
    }
    if (row.actionKind === 'restoreTrash') {
      const pendingHint = row.pendingAction === 'purge' ? '（已点亮确认，回行上再点一次才真删）' : '（需再点一次确认）';
      items.push({
        id: FILE_HISTORY_MENU_IDS.purge,
        label: `彻底删除${pendingHint}`,
        icon: 'trash',
        danger: true,
        group: '删除',
        ...(row.busy ? { disabled: true, disabledReason: '正在写入，稍后再试' } : {}),
      });
    }
  }

  items.push({
    id: FILE_HISTORY_MENU_IDS.refresh,
    label: '刷新时间线',
    icon: 'refresh',
    dividerBefore: row === null,
  });
  if (input.targetPath !== null) {
    items.push({
      id: FILE_HISTORY_MENU_IDS.copyTargetPath,
      label: '复制目标文件路径',
      icon: 'files',
      ...copyGate,
    });
  }
  items.push({ id: FILE_HISTORY_MENU_IDS.close, label: '关闭', icon: 'close' });
  return { items };
}

const TIMELINE_ACTION_KINDS: readonly TimelineActionKind[] = [
  'restoreBackup',
  'undoOp',
  'restoreTrash',
  'writeBackSnapshot',
];

const TIMELINE_ACCOUNTS: readonly TimelineAccount[] = ['backup', 'ops', 'trash', 'autosave', 'recovery'];

/** 行元素的 `data-fh-*` → 行身份（读不出 ⇒ null，面回落成面板级菜单） */
export function readFileHistoryRow(target: HTMLElement): FileHistoryRowRef | null {
  const el = target.closest<HTMLElement>('[data-fh-key]');
  if (el === null) return null;
  const key = el.getAttribute('data-fh-key');
  const account = el.getAttribute('data-fh-account');
  if (key === null || key === '' || account === null) return null;
  if (!(TIMELINE_ACCOUNTS as readonly string[]).includes(account)) return null;
  const actionKind = el.getAttribute('data-fh-action');
  const path = el.getAttribute('data-fh-path');
  const actionLabel = el.getAttribute('data-fh-action-label');
  return {
    key,
    account: account as TimelineAccount,
    title: el.getAttribute('data-fh-title') ?? '',
    timeText: el.getAttribute('data-fh-time') ?? '',
    keepText: el.getAttribute('data-fh-keep') ?? '',
    path: path === null || path === '' ? null : path,
    hasAction: (TIMELINE_ACTION_KINDS as readonly string[]).includes(actionKind ?? ''),
    actionLabel: actionLabel === null || actionLabel === '' ? null : actionLabel,
    actionKind: (TIMELINE_ACTION_KINDS as readonly string[]).includes(actionKind ?? '')
      ? (actionKind as TimelineActionKind)
      : null,
  };
}

/** 剪贴板入口（缺席 ⇒ null：复制项禁用并说清原因） */
function clipboardApi(): Clipboard | null {
  return typeof navigator === 'undefined' ? null : (navigator.clipboard ?? null);
}

/**
 * 面 ↔ 组件的动作桥（面在模块顶层声明，读不到 React 闭包）。
 *
 * `run` 的真实实现在组件末尾才装配得齐（要用到早退之后的各本账通道），
 * 所以这里经一层 ref 转发——**不能**把 `useEffect` 挪到早退之后：那会改 hook 顺序。
 */
interface FileHistoryFaceBridge {
  readonly clipboardAvailable: boolean;
  readonly busy: boolean;
  pendingActionOf(key: string): 'restore' | 'purge' | null;
  run(id: string, row: FileHistoryRowRef | null): void;
}

let faceBridge: FileHistoryFaceBridge | null = null;

declareContextSurface({
  id: FILE_HISTORY_SURFACE_ID,
  ariaLabel: '文件历史菜单',
  area: 'panel',
  build: ({ target }) => {
    const bridge = faceBridge;
    if (bridge === null) return null;
    const ref = readFileHistoryRow(target);
    const input: FileHistoryMenuInput = {
      row:
        ref === null
          ? null
          : { ...ref, pendingAction: bridge.pendingActionOf(ref.key), busy: bridge.busy },
      targetPath: getFileHistoryTarget(),
      clipboardAvailable: bridge.clipboardAvailable,
    };
    const menu = buildFileHistoryMenu(input);
    if (menu === null) return null;
    return { items: menu.items, onSelect: (id) => bridge.run(id, ref) };
  },
});

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
    /** 两版互比的勾选（`TimelineItem.key` 集合；换文件 / 重取一律清空——旧 key 会指向不存在的行） */
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [busy, setBusy] = useState(false);
    /** 本屏的取数锚（剩余天数的"此刻"；过一天就整屏重取，见 `isTimelineStale`） */
    const anchorRef = useRef(0);

    useEffect(() => {
      if (target === null) return;
      let alive = true;
      setState({ kind: 'loading' });
      setPending(null);
      setPicked(new Set()); // 换文件 / 重取：勾选清空（旧 key 指向的行可能已经不在）
      collectFileTimeline(deps.io, getOpsJournal(), target)
        .then((bundle) => {
          if (!alive) return;
          anchorRef.current = bundle.savedAtMs;
          setState({ kind: 'ready', bundle });
        })
        .catch((err: unknown) => {
          if (alive)
            setState({ kind: 'error', reason: errorText(err) });
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

    /** 菜单动作的真实实现（要用到早退之后定义的各本账通道，经 ref 转发给模块顶层的面） */
    const runFaceActionRef = useRef<(id: string, row: FileHistoryRowRef | null) => void>(() => undefined);

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
     * 右键菜单的动作桥（每次渲染后刷新）。恢复 / 彻底删除**只点亮行上既有的二次确认**
     * （`setPending`），真正的写盘仍由确认按钮触发——菜单不绕过确认链。
     */
    useEffect(() => {
      const entry: FileHistoryFaceBridge = {
        clipboardAvailable: clipboardApi() !== null,
        busy,
        pendingActionOf: (key) => (pending !== null && pending.key === key ? pending.action : null),
        run: (id, row) => runFaceActionRef.current(id, row),
      };
      faceBridge = entry;
      return () => {
        if (faceBridge === entry) faceBridge = null;
      };
    });

    if (target === null) {
      // 这一屏只剩"关闭"一条：菜单也得真的关得掉（不然右键给的是一个死菜单）
      runFaceActionRef.current = (id) => {
        if (id === FILE_HISTORY_MENU_IDS.close) deps.close();
      };
      return h(
        'div',
        { className: 'wizard fh-host', 'data-context-surface': FILE_HISTORY_SURFACE_ID },
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

    /**
     * 一条时间线 → diff 一侧的内容（P2-15 两版互比）：
     * 盘上有文件 ⇒ `path` 侧（宿主经内核 io 现读，读侧无写闸）；崩溃恢复件没有
     * 盘上路径 ⇒ 取进程内那份走 `text` 侧。两者都给不出内容 ⇒ 抛错（由调用方
     * 落成屏上反馈，不静默打开一个空 diff）。
     */
    const diffSideOf = async (item: TimelineItem): Promise<{ label: string; path?: string; text?: string }> => {
      const label = `${TIMELINE_ACCOUNT_LABEL[item.account]} · ${timeText(item)}`;
      if (item.diffPath !== null) return { label, path: item.diffPath };
      if (item.account === 'recovery') return { label, text: await snapshotText(item, item.id) };
      throw new Error(`「${label}」没有可读取的内容：这一条既没有盘上文件，也没有进程内快照。`);
    };

    /**
     * 「与磁盘当前内容对比」的唯一入口（行上按钮与右键菜单共用一份，标题/两侧标签不许两样）。
     * `diffPath` 为 null 的条目没有单个可比对文件，调用方不提供入口。
     */
    const openDiffNow = (item: TimelineItem): void => {
      const diffPath = item.diffPath;
      if (diffPath === null) return;
      deps.requestDiff({
        title: `${basename(target)} · ${TIMELINE_ACCOUNT_LABEL[item.account]} ${timeText(item)}`,
        original: {
          label: `${TIMELINE_ACCOUNT_LABEL[item.account]} · ${timeText(item)}`,
          path: diffPath,
        },
        modified: { label: '磁盘当前内容', path: target },
      });
    };

    /** 时间线条目按 `key` 索引（菜单只拿到行上的 key，条目本体从这里取） */
    const itemsByKey = new Map<string, TimelineItem>(
      state.kind === 'ready' ? state.bundle.items.map((item) => [item.key, item]) : [],
    );

    /** 两版互比：恰好勾选两条才动（按钮禁用态由 `diffPairButtonState` 说清，这里双保险） */
    const comparePicked = async (): Promise<void> => {
      if (state.kind !== 'ready') return;
      const pickedItems = state.bundle.items.filter((i) => picked.has(i.key));
      if (pickedItems.length !== 2) return;
      // 旧版在左、新版在右（判据在 file-history.orderDiffPair；时刻缺失按列表序）
      const { original, modified } = orderDiffPair(pickedItems[0]!, pickedItems[1]!);
      setBusy(true);
      try {
        const [o, m] = await Promise.all([diffSideOf(original), diffSideOf(modified)]);
        deps.requestDiff({ title: `${basename(target)} · 两版互比`, original: o, modified: m });
      } catch (err: unknown) {
        // 取不到内容：原样落反馈（不重取时间线——勾选留着，作者换两条还能再比）
        setFeedback({ tone: 'err', text: errorText(err) });
      } finally {
        setBusy(false);
      }
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
            if (ops === null) throw new Error('批操作账暂时不可用（内核没有交出批操作记录），这一条恢复不了。');
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
        report('err', errorText(err));
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
        report('err', errorText(err));
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
              title: '在对比视图里看这一条与磁盘当前内容的逐行差异',
              onClick: () => openDiffNow(item),
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

    /** 行首勾选格：可互比的给复选框；不可互比的给一个占位格并说清为什么（不静默） */
    const diffCell = (item: TimelineItem): ReactNode => {
      if (!diffableTimelineItem(item)) {
        return h(
          'td',
          {
            className: 'fh-pick',
            title: '这一条没有可读取的内容（没有盘上文件、也没有进程内快照），不能参与两版互比。',
          },
          h('span', { className: 'dim' }, '—'),
        );
      }
      const on = picked.has(item.key);
      return h(
        'td',
        { className: 'fh-pick' },
        h('input', {
          type: 'checkbox',
          checked: on,
          disabled: busy,
          'aria-label': `选择「${item.title}」参与两版互比`,
          title: on ? '取消勾选这一版' : '勾选这一版（两版互比需要恰好两条）',
          onChange: () =>
            setPicked((prev) => {
              const next = new Set(prev);
              if (next.has(item.key)) next.delete(item.key);
              else next.add(item.key);
              return next;
            }),
        }),
      );
    };

    const rowOf = (item: TimelineItem): ReactNode =>
      h(
        'tr',
        {
          key: item.key,
          className: 'fh-row',
          // 右键菜单靠这些属性认出这一行（模块顶层的面读 DOM，不靠 React 闭包）
          'data-fh-key': item.key,
          'data-fh-account': item.account,
          'data-fh-title': item.title,
          'data-fh-time': timeText(item),
          'data-fh-keep': keepText(item),
          'data-fh-path': item.diffPath ?? '',
          'data-fh-action': item.action?.kind ?? '',
          'data-fh-action-label': item.action?.label ?? '',
        },
        diffCell(item),
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
      // 两版互比工具条：恰好勾选两条才亮，其余条数禁用并把理由写在 title 里（不静默）
      const pickState = diffPairButtonState(picked.size);
      const pickBar = h(
        'div',
        { className: 'pv-summary fh-pickbar' },
        h('span', { className: 'dim' }, `已选 ${picked.size} / 2 版`),
        h(
          'button',
          {
            className: pickState.enabled ? 'primary small' : 'ghost small',
            disabled: !pickState.enabled || busy,
            title: pickState.reason,
            onClick: () => void comparePicked(),
          },
          '对比两版',
        ),
        picked.size > 0
          ? h(
              'button',
              { className: 'ghost small', disabled: busy, title: '清空勾选', onClick: () => setPicked(new Set()) },
              '清除选择',
            )
          : null,
      );
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
              'div',
              null,
              pickBar,
              h(
                'table',
                { className: 'fh-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'fh-pick', title: '勾选两行即可两版互比', 'aria-label': '选择两版互比' }, ''),
                    h('th', null, '时间'),
                    h('th', null, '哪本账'),
                    h('th', null, '这是什么 · 恢复它意味着什么'),
                    h('th', null, '大小'),
                    h('th', null, ''),
                  ),
                ),
                h('tbody', null, ...items.map(rowOf)),
              ),
            );
    }

    /**
     * 菜单动作装配（每次渲染重写一次：行数据、勾选、确认态都可能刚变过）。
     * 只调既有通道：复制走剪贴板（成败上屏）、对比走 `requestDiff`、恢复 / 彻底删除
     * 只**点亮**行上的二次确认、刷新走本屏重取、关闭同时撤目标文件。
     */
    runFaceActionRef.current = (id, row) => {
      const item = row === null ? null : itemsByKey.get(row.key) ?? null;
      switch (id) {
        case FILE_HISTORY_MENU_IDS.copySummary:
          if (item !== null) copyToClipboard(timelineSummaryText(item), '已复制这一条摘要');
          return;
        case FILE_HISTORY_MENU_IDS.copyPath:
          copyToClipboard(item?.diffPath ?? target, '已复制路径');
          return;
        case FILE_HISTORY_MENU_IDS.copyTargetPath:
          copyToClipboard(target, '已复制目标文件路径');
          return;
        case FILE_HISTORY_MENU_IDS.diffNow:
          if (item !== null) openDiffNow(item);
          return;
        case FILE_HISTORY_MENU_IDS.restore:
          if (item !== null) setPending({ key: item.key, action: 'restore' });
          return;
        case FILE_HISTORY_MENU_IDS.purge:
          if (item !== null) setPending({ key: item.key, action: 'purge' });
          return;
        case FILE_HISTORY_MENU_IDS.refresh:
          setReloadNonce((n) => n + 1);
          return;
        case FILE_HISTORY_MENU_IDS.close:
          setFileHistoryTarget(null);
          deps.close();
          return;
        default:
          return;
      }
    };

    return h(
      'div',
      { className: 'wizard fh-host', 'data-context-surface': FILE_HISTORY_SURFACE_ID },
      h('h3', null, `时间线 —— ${basename(target)}`),
      h('p', { className: 'dim fh-path' }, target),
      h(
        'p',
        { className: 'dim' },
        '一条时间线，四本账：写前备份 / 批操作快照 / 回收站 / 未保存快照。每行都写明它来自哪本账、恢复它会发生什么；恢复前的磁盘现状一律先落进同一本账，不会被吃掉。勾选任意两行可两版互比（旧版在左）；每行后面的「对比」仍与磁盘当前内容比。',
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
