import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Icon, type IconName } from './icons';
import {
  detectUpdateSeverity,
  formatUpdateDate,
  updateDialogPhase,
  updateNoticeCardTitle,
  updateReleaseOf,
  updateReleaseVersion,
  updateStatus,
  type UpdateDialogPhase,
  type UpdatePhase,
  type UpdateRelease,
} from './update-check';
import {
  UPDATE_DISMISS_HINT,
  dismissUpdateVersion,
  isUpdateDismissalActive,
  loadUpdateDismissal,
  useUpdateDismissal,
  type UpdateDismissal,
} from './update-dismiss-pref';
import { UpdateProgress } from './UpdateProgress';
import '../update-notice-card.css';

/**
 * 更新提醒卡——**右下非阻塞的常驻更新槽位**（批次十一 L05 层一 · UI 打磨批改四态）。
 *
 * 修的是实测缺陷①②：更新提醒过去只有一种形态（全遮蔽模态），且触发点焊死在
 * `ShellLayout`——不开项目的作者永远收不到更新。本卡是普通更新的第一落点：
 * 不遮编辑器、不抢焦点，作者不打断手头工作就能消化；「查看」才升级成详情模态
 * （`UpdateDialog.tsx`）。
 *
 * ## 本批改的是「四态都有形态」
 *
 * 改前这张卡只画 `found` 一种（类型就钉在 `Extract<…, { kind: 'found' }>` 上），于是留下
 * 一个真实的死角：模态里点「后台下载」（本仓刻意允许：`downloadAndInstall` 发出去就收不回，
 * 不该把人锁在全屏里等）之后，屏幕上**一处反馈都没有**——进度只在设置页那行文字里，
 * 而作者多半不在设置页。装完那句「重启生效」同样看不见。
 * 现在 `found / downloading / done / failed(install)` 四态都举卡：
 * - **found**：版本徽标 + 发布日期 +「查看 / 稍后」；
 * - **downloading**：缩略进度条（读数与条同排，卡只给得起一行高）；
 * - **done**：一句「重启后生效」，出口是「知道了」；
 * - **failed(install)**：病因 +「重试 / 稍后」。
 * 卡的出现与消失仍由 `decideUpdateNotice` 一处判，呈现层不自己决定打不打扰。
 *
 * 打扰纪律（层三闸门同在这里收口）：
 * - 「稍后」/ X = 跨会话免打扰 `UPDATE_NOTICE_QUIET_DAYS` 天（同版本才免，见 `update-dismiss-pref.ts`）；
 * - **破坏性更新不走卡**——`decideUpdateNotice` 判 forced，宿主据此打开即模态；作者在模态里
 *   推辞过同一版，之后连模态都不再自动开（免打扰期同判据）；
 * - **下载中 / 已装好不吃免打扰**：那两态不是「作者拒绝更新」，是「更新在路上」，
 *   关掉面板只是不想让它挡屏幕，卡必须还在。
 *
 * 本文件零 tauri import：状态从外面喂进来（`useUpdateNotice(phase)`），
 * 「什么时候去 check」在 `update-flow.tsx`——两层各自可测，接线点见 `ShellLayout` 与 `App`。
 */

/** 卡能画的四态 = 模态可渲染的那几态（同款收窄，`updateDialogPhase` 是唯一判据） */
export type UpdateNoticeState = UpdateDialogPhase;

export interface UpdateNoticeDecision {
  /** 该画卡的那一态；null = 不打扰（含 forced 直模态、免打扰期内、非四态） */
  readonly notice: UpdateNoticeState | null;
  /** 破坏性更新：宿主应「打开即模态」的唯一许可位 */
  readonly forced: boolean;
}

export interface UpdateNoticeOptions {
  /** 当前免打扰记录（缺省 = 读存储） */
  readonly dismissal?: UpdateDismissal | null;
  /** 判龄时刻（毫秒；注入点，测试钉「同版本 N 天内不再打扰」用） */
  readonly now?: number;
  /** 免打扰时长覆盖（测试用，生产走 `UPDATE_NOTICE_QUIET_MS`） */
  readonly quietMs?: number;
}

/**
 * 「这一次要不要打扰、以哪层打扰」的**唯一纯判据**（零 React、零存储）。
 *
 * 优先级：四态以外 ⇒ 安静；推辞语义（found / failed）落在免打扰期内 ⇒ 安静；
 * found 且破坏性 ⇒ forced（模态通道，卡不出现，避免同一版双提醒）；其余 ⇒ 右下卡。
 */
export function decideUpdateNotice(phase: UpdatePhase, options?: UpdateNoticeOptions): UpdateNoticeDecision {
  const card = updateDialogPhase(phase);
  if (card === null) return { notice: null, forced: false };
  const version = updateReleaseVersion(card);
  // 推辞语义：只有「作者能对这一版说不」的两态吃免打扰（口径同 `closeDialog` 的落盘条件）
  const isRefusal = card.kind === 'found' || card.kind === 'failed';
  // 调用方没注入记录时兜底读一次存储（`loadUpdateDismissal` 读不到就是 null，绝不抛）
  const dismissal = options?.dismissal !== undefined ? options.dismissal : loadUpdateDismissal();
  if (isRefusal && isUpdateDismissalActive(dismissal, version, options?.now, options?.quietMs)) {
    return { notice: null, forced: false };
  }
  if (card.kind === 'found' && detectUpdateSeverity(card.notes) === 'breaking') {
    return { notice: null, forced: true };
  }
  return { notice: card, forced: false };
}

/** 卡每一态的图标与语义色（色只吃 `.update-notice-card[data-phase]` 那几条 token 规则） */
const NOTICE_ICON: Record<UpdateNoticeState['kind'], IconName> = {
  found: 'refresh',
  downloading: 'refresh',
  done: 'check',
  failed: 'warning',
};

/** 卡上那颗 X 在这一态到底承诺了什么（下载中收起 ≠ 拒绝更新） */
function dismissTitleOf(state: UpdateNoticeState): string {
  return state.kind === 'found' || state.kind === 'failed'
    ? `稍后再说（${UPDATE_DISMISS_HINT}）`
    : '收起这张卡（更新继续在后台进行）';
}

// ui-kit-candidate: 右下非阻塞提醒卡的通用槽位（更新之外别的低频提醒可复用）
export interface UpdateNoticeCardProps {
  /** 要提醒的那一态（null ⇒ 整个组件返回 null，不留占位节点） */
  state: UpdateNoticeState | null;
  /** 「查看」：升级成详情模态 */
  onOpen: () => void;
  /** 「稍后」/ X：found 与 failed 落跨会话免打扰，其余只在本会话收起 */
  onDismiss: () => void;
  /** 「重试」（failed 态）：与模态、设置页同一个 install */
  onInstall?: () => void;
}

/** 右下提醒卡：一块跟着状态机走四态的浮层，不打断编辑器 */
export function UpdateNoticeCard({ state, onOpen, onDismiss, onInstall }: UpdateNoticeCardProps): ReactElement | null {
  if (state === null) return null;
  const release: UpdateRelease = updateReleaseOf(state);
  const dateText = formatUpdateDate(release.date);
  const hasMeta = dateText !== null || release.currentVersion !== undefined;
  // 常驻状态行那句人话（done / failed 直接复用，卡片不再另写一套说法）
  const statusLine = state.kind === 'done' || state.kind === 'failed' ? updateStatus(state) : null;
  return (
    <aside className="glass update-notice-card" role="status" data-phase={state.kind}>
      <div className="update-notice-card-head">
        <span className="update-notice-card-icon" aria-hidden="true">
          <Icon name={NOTICE_ICON[state.kind]} size="md" />
        </span>
        <p className="update-notice-card-title">{updateNoticeCardTitle(state)}</p>
        <span className="update-notice-card-badge">v{release.version}</span>
        <button
          type="button"
          className="update-notice-card-close"
          aria-label="收起更新提醒"
          title={dismissTitleOf(state)}
          onClick={onDismiss}
        >
          <Icon name="close" size="xs" />
        </button>
      </div>
      {state.kind === 'found' && hasMeta ? (
        <p className="update-notice-card-meta">
          {release.currentVersion !== undefined ? <span>当前 v{release.currentVersion}</span> : null}
          {release.currentVersion !== undefined && dateText !== null ? (
            <span className="update-notice-card-meta-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {dateText !== null ? <time dateTime={release.date}>{`发布于 ${dateText}`}</time> : null}
        </p>
      ) : null}
      {state.kind === 'downloading' ? (
        <UpdateProgress received={state.received} total={state.total} size="sm" inline />
      ) : null}
      {statusLine !== null ? (
        <p className="update-notice-card-detail" data-tone={state.kind === 'failed' ? 'err' : 'ok'}>
          {statusLine.text}
        </p>
      ) : null}
      <div className="update-notice-card-actions">
        {state.kind === 'failed' && onInstall !== undefined ? (
          <button type="button" className="primary small" onClick={onInstall}>
            重试
          </button>
        ) : (
          <button type="button" className="primary small" onClick={onOpen}>
            查看
          </button>
        )}
        {/* 「稍后」只在作者真能推辞这一版时出现（found / 没装好）。下载中不给：
            `downloadAndInstall` 发出去就收不回，那颗钮会承诺一件做不到的事；
            要收起这张卡，抬头那枚 X 就是（它只收卡，不动下载）。 */}
        {state.kind === 'found' || state.kind === 'failed' ? (
          <button type="button" className="ghost small" onClick={onDismiss} title={UPDATE_DISMISS_HINT}>
            稍后
          </button>
        ) : null}
        {state.kind === 'done' ? (
          <button type="button" className="ghost small" onClick={onDismiss}>
            知道了
          </button>
        ) : null}
      </div>
    </aside>
  );
}

export interface UseUpdateNoticeResult {
  /** 右下卡该画的那一态（模态开着 / 会话内收起 / 免打扰期内 / 非四态 ⇒ null） */
  readonly notice: UpdateNoticeState | null;
  /** 破坏性更新（宿主可用它决定「打开即模态」；hook 内部已自动这么做） */
  readonly forced: boolean;
  /** 详情模态该画的 phase（hook 管理的开合 + `updateDialogPhase` 收窄） */
  readonly dialog: UpdateDialogPhase | null;
  /** 「查看」：打开详情模态（卡随之隐藏） */
  readonly openDialog: () => void;
  /** 卡上「稍后」/ X：推辞语义落跨会话免打扰，其余只在本会话收起 */
  readonly dismissNotice: () => void;
  /** 模态出口（稍后 / X / 遮罩 / Esc）：关模态；found/failed 出口同时落免打扰 */
  readonly closeDialog: () => void;
}

/**
 * 更新提醒的**会话编排**（层一↔层二的胶水）：拿一台状态机的 phase，还给宿主
 * 「卡画什么、模态画不画、三个出口各自落什么偏好」。不碰网络、不碰 tauri——
 * check 的触发点在 `update-flow.tsx` 的 `useUpdateFlow`（欢迎页与编辑器两处落点都有它，
 * 缺陷①已解；接线面由 `update-wiring.test.ts` 钉）。
 */
export function useUpdateNotice(phase: UpdatePhase): UseUpdateNoticeResult {
  const dismissal = useUpdateDismissal();
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 本会话被模态出口关掉的那一版：破坏性自动重开对它让步（口径照旧 ShellLayout 的会话变量） */
  const sessionDismissedRef = useRef<string | null>(null);
  /** 本会话被 X 收起的那一格（`版本:态`）：同一版换了态就重新举卡 */
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);

  const decision = decideUpdateNotice(phase, { dismissal });

  // 层三闸门：破坏性 ⇒ 打开即模态（同会话已被作者关过的版本不纠缠；免打扰期内 forced 根本不成立）
  useEffect(() => {
    if (phase.kind !== 'found' || !decision.forced) return;
    if (sessionDismissedRef.current === phase.version) return;
    setDialogOpen(true);
  }, [decision.forced, phase]);

  const openDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);

  const dismissNotice = useCallback(() => {
    const card = updateDialogPhase(phase);
    if (card === null) return;
    const version = updateReleaseVersion(card);
    // X 先按「这一格」收起：下载中按 X ≠ 拒绝更新，装完那一态是新的决策点，还要看得见
    setHiddenKey(`${version}:${card.kind}`);
    if (card.kind === 'found' || card.kind === 'failed') {
      dismissUpdateVersion(version);
      // 兜底同步：写不进存储（隐私模式）时至少本会话不再举卡、也不再自动开模态
      sessionDismissedRef.current = version;
    }
  }, [phase]);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    const card = updateDialogPhase(phase);
    if (card === null) return;
    const version = updateReleaseVersion(card);
    sessionDismissedRef.current = version;
    // 缺陷③的正解：模态「稍后」不再只记会话内——found/failed 出口一并落跨会话免打扰。
    // downloading/done 不落：那两态不是「作者拒绝更新」，是「更新正在路上」。
    if (card.kind === 'found' || card.kind === 'failed') dismissUpdateVersion(version);
  }, [phase]);

  const dialog = dialogOpen ? updateDialogPhase(phase) : null;
  const noticeVersion = decision.notice === null ? null : updateReleaseVersion(decision.notice);
  const noticeHidden =
    decision.notice !== null && hiddenKey === `${noticeVersion}:${decision.notice.kind}`;
  // 存储写不进去时的会话兜底：作者刚在模态里推辞过这一版，就别立刻举卡（只对推辞语义生效）
  const noticePostponed =
    decision.notice !== null &&
    (decision.notice.kind === 'found' || decision.notice.kind === 'failed') &&
    sessionDismissedRef.current === noticeVersion;
  return {
    notice: dialog === null && !noticeHidden && !noticePostponed ? decision.notice : null,
    forced: decision.forced,
    dialog,
    openDialog,
    dismissNotice,
    closeDialog,
  };
}
