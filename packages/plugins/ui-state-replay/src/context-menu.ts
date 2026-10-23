/**
 * 状态回放面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 两个层级：
 * - **谓词行**：跳到行（本就有 `editor.revealLocation` 通道）· 复制谓词（行号 + 原文）·
 *   复制求值状态（命中 / 未命中 / 未知，未知时把原因一起带上）；
 * - **面板空白处**：重新回放（本就有 `runReplay`；回放中或还没选函数时禁用 + 原因）。
 *
 * 任务书里的「重置」**没有做**：本面板没有"重置回放结果"这一档能力（换函数 / 换档
 * 才会重算），造一个按钮出来只是把已有状态清空演成功能，不如不给。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

export const REPLAY_PREDICATE_MENU_ARIA = '谓词菜单';
export const REPLAY_PANEL_MENU_ARIA = '状态回放菜单';

/** 谓词行的求值态（与 `PredicateReplay.outcome.kind` 同集） */
export type PredicateOutcomeKind = 'true' | 'false' | 'unknown';

/** 谓词行上下文（只取菜单要用的字段） */
export interface ReplayPredicateMenuTarget {
  readonly line: number;
  readonly kind: string;
  readonly text: string;
  readonly outcome: PredicateOutcomeKind;
  /** `outcome === 'unknown'` 时的原因（人话） */
  readonly unknownMessage?: string;
  readonly filePath: string;
  /** 来源标记（与点击跳转同一口径：命中函数名） */
  readonly normalizedName: string;
}

/** 面板空白处上下文 */
export interface ReplayPanelMenuTarget {
  /** 当前是否有一份可回放的结果（没有 ⇒ 回放按钮本来就按不动） */
  readonly hasView: boolean;
  readonly busy: boolean;
}

/** 菜单动作的落点（面板注入） */
export interface ReplayMenuHost {
  reveal(filePath: string, line: number, source: string): void;
  rerun(): void;
  copy(text: string): void;
}

/** 求值状态的中文名（与谓词行上的徽章同词） */
const OUTCOME_TEXT: Record<PredicateOutcomeKind, string> = {
  true: '命中',
  false: '未命中',
  unknown: '未知',
};

/** 「复制谓词」的文本（位置 + 原文） */
export function predicateCopyText(target: ReplayPredicateMenuTarget): string {
  return `${target.filePath}:${target.line} ${target.text}`;
}

/** 「复制状态」的文本（状态 + 规则 + 未知原因） */
export function predicateStateText(target: ReplayPredicateMenuTarget): string {
  const base = `${OUTCOME_TEXT[target.outcome]}（${target.kind}）第 ${target.line} 行`;
  return target.outcome === 'unknown' && target.unknownMessage
    ? `${base}：${target.unknownMessage}`
    : base;
}

/** 谓词行菜单（判据层，纯函数） */
export function buildReplayPredicateMenu(
  target: ReplayPredicateMenuTarget,
): PluginContextMenuItem[] {
  return [
    { id: 'rp.pred.reveal', label: '跳到这一行', icon: 'target', group: '谓词' },
    { id: 'rp.pred.copyText', label: '复制谓词' },
    { id: 'rp.pred.copyState', label: '复制求值状态' },
  ];
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildReplayPanelMenu(target: ReplayPanelMenuTarget): PluginContextMenuItem[] {
  if (target.busy) {
    return [
      {
        id: 'rp.panel.rerun',
        label: '重新回放',
        icon: 'refresh',
        disabled: true,
        disabledReason: '上一轮回放还没结束，稍等它出结果',
        group: '回放',
      },
    ];
  }
  if (!target.hasView) {
    return [
      {
        id: 'rp.panel.rerun',
        label: '重新回放',
        icon: 'refresh',
        disabled: true,
        disabledReason: '还没有可回放的结果（先选档位与函数）',
        group: '回放',
      },
    ];
  }
  return [{ id: 'rp.panel.rerun', label: '重新回放', icon: 'refresh', group: '回放' }];
}

/** 分发一条谓词行 id；返回是否被本面消费 */
export function runReplayPredicateAction(
  id: string,
  target: ReplayPredicateMenuTarget,
  host: ReplayMenuHost,
): boolean {
  switch (id) {
    case 'rp.pred.reveal':
      host.reveal(target.filePath, target.line, target.normalizedName);
      return true;
    case 'rp.pred.copyText':
      host.copy(predicateCopyText(target));
      return true;
    case 'rp.pred.copyState':
      host.copy(predicateStateText(target));
      return true;
    default:
      return false;
  }
}

/** 分发一条面板 id */
export function runReplayPanelAction(
  id: string,
  target: ReplayPanelMenuTarget,
  host: ReplayMenuHost,
): boolean {
  if (id !== 'rp.panel.rerun') return false;
  if (target.busy || !target.hasView) return false;
  host.rerun();
  return true;
}

/** 接线层：谓词行 */
export function openReplayPredicateMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: ReplayPredicateMenuTarget,
  host: ReplayMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildReplayPredicateMenu(target), REPLAY_PREDICATE_MENU_ARIA, (id) => {
    runReplayPredicateAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openReplayPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: ReplayPanelMenuTarget,
  host: ReplayMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildReplayPanelMenu(target), REPLAY_PANEL_MENU_ARIA, (id) => {
    runReplayPanelAction(id, target, host);
  });
}

/** 复制动作的落点 */
export function copyReplayText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
