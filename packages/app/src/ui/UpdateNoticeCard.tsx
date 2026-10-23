import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Icon } from './icons';
import {
  detectUpdateSeverity,
  formatUpdateDate,
  updateDialogPhase,
  updateNoticeTitle,
  type UpdateDialogPhase,
  type UpdatePhase,
  type UpdateRelease,
} from './update-check';
import {
  dismissUpdateVersion,
  isUpdateDismissalActive,
  loadUpdateDismissal,
  useUpdateDismissal,
  type UpdateDismissal,
} from './update-dismiss-pref';
import '../update-notice-card.css';

/**
 * 更新提醒卡——**非阻塞右下卡**（批次十一 L05 · 层一）。
 *
 * 修的是实测缺陷①②：更新提醒过去只有一种形态（全遮蔽模态），且触发点焊死在
 * `ShellLayout`——不开项目的作者永远收不到更新。本卡是普通更新的第一落点：
 * `发现新版本 vX` + 版本徽标 + 「查看」/「稍后」，不遮编辑器、不抢焦点、
 * 作者不打断手头工作就能消化；「查看」才升级成详情模态（`UpdateDialog.tsx`）。
 *
 * 打扰纪律（层三闸门同在这里收口）：
 * - 「稍后」= 跨会话免打扰 N 天（`update-dismiss-pref.ts`，同版本才免）；
 * - **破坏性更新不走卡**——`decideUpdateNotice` 直接判 forced，宿主据此打开即模态；
 * - 已最新 / 检查中 / 检查失败连节点都不挂（沿用 `updateDialogPhase` 唯一判据）。
 *
 * 本文件零 tauri import：状态从外面喂进来（`useUpdateNotice(phase)`），
 * 「什么时候去 check」在 `update-flow.tsx`——两层各自可测，接线点见批次报告。
 */

/** 卡只画 found 态（下载进度归模态管，右下不留第二块进度 UI） */
export type UpdateNoticeState = Extract<UpdateDialogPhase, { kind: 'found' }>;

export interface UpdateNoticeDecision {
  /** 该画卡的那一版；null = 不打扰（含 forced 直模态、免打扰期内、非 found 态） */
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
 * 优先级：非 found ⇒ 安静；breaking ⇒ forced（模态通道，卡不出现，避免同一版双提醒）；
 * 免打扰期内 ⇒ 安静；其余 ⇒ 右下卡。
 */
export function decideUpdateNotice(phase: UpdatePhase, options?: UpdateNoticeOptions): UpdateNoticeDecision {
  if (phase.kind !== 'found') return { notice: null, forced: false };
  if (detectUpdateSeverity(phase.notes) === 'breaking') return { notice: null, forced: true };
  // 调用方没注入记录时兜底读一次存储（`loadUpdateDismissal` 读不到就是 null，绝不抛）
  const dismissal = options?.dismissal !== undefined ? options.dismissal : loadUpdateDismissal();
  if (isUpdateDismissalActive(dismissal, phase.version, options?.now, options?.quietMs)) {
    return { notice: null, forced: false };
  }
  return { notice: phase, forced: false };
}

// ui-kit-candidate: 右下非阻塞提醒卡的通用槽位（更新之外别的低频提醒可复用）
export interface UpdateNoticeCardProps {
  /** 要提醒的那一版（null ⇒ 整个组件返回 null，不留占位节点） */
  state: UpdateNoticeState | null;
  /** 「查看」：升级成详情模态 */
  onOpen: () => void;
  /** 「稍后」/ X：落跨会话免打扰 */
  onDismiss: () => void;
}

/** 右下提醒卡：一块会自己消失的浮层，不打断编辑器 */
export function UpdateNoticeCard({ state, onOpen, onDismiss }: UpdateNoticeCardProps): ReactElement | null {
  if (state === null) return null;
  const release: UpdateRelease = state;
  const dateText = formatUpdateDate(release.date);
  return (
    <aside className="glass update-notice-card" role="status">
      <div className="update-notice-card-head">
        <span className="update-notice-card-icon" aria-hidden="true">
          <Icon name="refresh" size={15} />
        </span>
        <p className="update-notice-card-title">{updateNoticeTitle(release)}</p>
        <span className="update-notice-card-badge">v{release.version}</span>
        <button
          type="button"
          className="update-notice-card-close"
          aria-label="关闭更新提醒"
          title="稍后再说（同版本几天内不再提醒）"
          onClick={onDismiss}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {dateText !== null || release.currentVersion !== undefined ? (
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
      <div className="update-notice-card-actions">
        <button type="button" className="primary small" onClick={onOpen}>
          查看
        </button>
        <button type="button" className="ghost small" onClick={onDismiss}>
          稍后
        </button>
      </div>
    </aside>
  );
}

export interface UseUpdateNoticeResult {
  /** 右下卡该画的那一版（模态开着 / 免打扰期内 / 非 found ⇒ null） */
  readonly notice: UpdateNoticeState | null;
  /** 破坏性更新（宿主可用它决定「打开即模态」；hook 内部已自动这么做） */
  readonly forced: boolean;
  /** 详情模态该画的 phase（hook 管理的开合 + `updateDialogPhase` 收窄） */
  readonly dialog: UpdateDialogPhase | null;
  /** 「查看」：打开详情模态（卡随之隐藏） */
  readonly openDialog: () => void;
  /** 卡上「稍后」：落跨会话免打扰 */
  readonly dismissNotice: () => void;
  /** 模态出口（稍后 / X / 遮罩 / Esc）：关模态；found/failed 态同时落免打扰 */
  readonly closeDialog: () => void;
}

/**
 * 更新提醒的**会话编排**（层一↔层二的胶水）：拿一台状态机的 phase，还给宿主
 * 「卡画什么、模态画不画、三个出口各自落什么偏好」。不碰网络、不碰 tauri——
 * check 的触发点在 `update-flow.tsx` 的 `useUpdateFlow`（可挂到欢迎页，缺陷①的解）。
 */
export function useUpdateNotice(phase: UpdatePhase): UseUpdateNoticeResult {
  const dismissal = useUpdateDismissal();
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 本会话被模态出口关掉的那一版：破坏性自动重开对它让步（口径照旧 ShellLayout 的会话变量） */
  const sessionDismissedRef = useRef<string | null>(null);

  const decision = decideUpdateNotice(phase, { dismissal });

  // 层三闸门：破坏性 ⇒ 打开即模态（同会话已被作者关过的版本不纠缠）
  useEffect(() => {
    if (phase.kind !== 'found') return;
    if (detectUpdateSeverity(phase.notes) !== 'breaking') return;
    if (sessionDismissedRef.current === phase.version) return;
    setDialogOpen(true);
  }, [phase]);

  const openDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);

  const dismissNotice = useCallback(() => {
    if (phase.kind === 'found') {
      dismissUpdateVersion(phase.version);
      // 兜底同步：写不进存储（隐私模式）时至少本会话不再举卡
      sessionDismissedRef.current = phase.version;
    }
  }, [phase]);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    const dialog = updateDialogPhase(phase);
    if (dialog === null) return;
    const version = dialog.kind === 'failed' ? dialog.release.version : dialog.version;
    sessionDismissedRef.current = version;
    // 缺陷③的正解：模态「稍后」不再只记会话内——found/failed 出口一并落跨会话免打扰。
    // downloading/done 不落：那两态不是「作者拒绝更新」，是「更新正在路上」。
    if (dialog.kind === 'found' || dialog.kind === 'failed') dismissUpdateVersion(version);
  }, [phase]);

  const dialog = dialogOpen ? updateDialogPhase(phase) : null;
  return {
    notice: dialog === null && sessionDismissedRef.current !== phase.version ? decision.notice : null,
    forced: decision.forced,
    dialog,
    openDialog,
    dismissNotice,
    closeDialog,
  };
}
