/**
 * 通知面的右键菜单（1023 覆盖面批 · WP3.8）。
 *
 * ## 为什么从 `context-menu-shell.ts` 拆出来
 *
 * `main.tsx` 静态装着 `NotificationCenter`（它要给整棵 App 发通知），而通知中心只需要
 * 这里的 `installNoticeMenuHost` 一个函数。原来这条链是
 * `main.tsx → NotificationCenter → context-menu-shell`，于是**七个面**的菜单数据面
 * （面板选项卡 / 分区头 / 浮窗 / 活动栏 / 工具栏 / 状态栏）连同 `context-menu-model`
 * 与整张键位表全被拖进开机图——只为了一条 toast 的右键菜单。
 *
 * 拆开后：通知中心只依赖本模块（+ 模型层的类型与命令通道），壳层菜单模块不再在开机图里
 * （`ShellLayout` 走动态装载，见 `ps10-eager-graph.test.ts`）。
 *
 * ## 依赖方向（别接反）
 *
 * - 本模块 **不 import** `context-menu-shell`，也不被它 re-export：通知面属于壳层的
 *   *同级* 面，不是壳层菜单的子集，反向依赖会把拆开的边又接回去；
 * - 共用的地基（菜单项类型、命令通道、剪贴板落点）在 `context-menu-model.ts`，
 *   两边都往下依赖，谁也不依赖谁。
 *
 * ## 口径（与壳层各面同一条）
 *
 * - **能力不存在 ⇒ 整项不显示**：没有动作就没有「执行…」项；
 * - **上下文暂不可用 ⇒ `disabled` + `disabledReason`**：屏上只剩一条时「清除全部」是灰的；
 * - 动作全部落在 `NotificationCenter` 注入的宿主上（`dismiss` / `clearAll` / `runAction`），
 *   菜单不持有第二份通知列表——真源始终在通知中心。
 */
import {
  copyTextToClipboard,
  runMenuItemCommand,
  type ContextMenuItem,
} from './context-menu-model';
import {
  declareContextSurface,
  type ContextSurfaceBuildContext,
  type ContextSurfaceBuildResult,
} from './context-surfaces';

/* ------------------------------ 通知（WP3.8） ------------------------------ */

export const NOTIFICATION_ACTION = {
  COPY: 'notice.copy',
  DISMISS: 'notice.dismiss',
  CLEAR_ALL: 'notice.clearAll',
  /** 通知自带的动作按序号分发（`notice.run.<index>`） */
  RUN_PREFIX: 'notice.run.',
} as const;

export interface NotificationMenuInput {
  /** 这条通知带动作（「去授权」「查看差异」…）——没动作就没有可执行的项 */
  readonly hasAction: boolean;
  readonly actionLabels: readonly string[];
  /** 屏上现有条数（只有一条时「清除全部」没有意义） */
  readonly total: number;
}

export function buildNotificationMenu(input: NotificationMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ id: NOTIFICATION_ACTION.COPY, label: '复制通知内容' }];
  if (input.hasAction) {
    const labels = input.actionLabels;
    if (labels.length === 1) {
      items.push({ id: `${NOTIFICATION_ACTION.RUN_PREFIX}0`, label: `执行「${labels[0] ?? ''}」` });
    } else if (labels.length > 1) {
      items.push({
        id: 'notice.run',
        label: '执行通知里的操作',
        children: labels.map((label, index) => ({
          id: `${NOTIFICATION_ACTION.RUN_PREFIX}${index}`,
          label: `执行「${label}」`,
        })),
      });
    }
  }
  items.push({ id: NOTIFICATION_ACTION.DISMISS, label: '清除这条通知', dividerBefore: true });
  items.push(
    input.total > 1
      ? { id: NOTIFICATION_ACTION.CLEAR_ALL, label: '清除全部通知' }
      : {
          id: NOTIFICATION_ACTION.CLEAR_ALL,
          label: '清除全部通知',
          disabled: true,
          disabledReason: '屏上只有这一条通知，用「清除这条通知」即可',
        },
  );
  return items;
}

/* ------------------------------ 宿主（由通知中心注入） ------------------------------ */

/** 通知面需要的那几格（由 `NotificationCenter` 注入；通知列表的真源在那边） */
export interface ShellNoticeView {
  readonly id: number;
  readonly message: string;
  readonly detail?: string;
  readonly actions: readonly string[];
}

export interface NoticeMenuHost {
  readonly notices: readonly ShellNoticeView[];
  dismiss(id: number): void;
  clearAll(): void;
  /** 执行第 index 个动作（先收通知再执行，与 toast 上的按钮同序） */
  runAction(id: number, index: number): void;
}

let noticeHost: NoticeMenuHost | null = null;

/** 注入 / 撤销通知数据面（`null` = 通知中心卸载） */
export function installNoticeMenuHost(host: NoticeMenuHost | null): () => void {
  noticeHost = host;
  return () => {
    if (noticeHost === host) noticeHost = null;
  };
}

/* ------------------------------ 动作分发 ------------------------------ */

function runNotificationAction(id: string, noticeId: number | null): void {
  const host = noticeHost;
  if (host === null) return;
  switch (id) {
    case NOTIFICATION_ACTION.COPY: {
      const notice = noticeId === null ? undefined : host.notices.find((n) => n.id === noticeId);
      if (notice === undefined) return;
      copyTextToClipboard(notice.detail === undefined ? notice.message : `${notice.message}\n${notice.detail}`);
      return;
    }
    case NOTIFICATION_ACTION.DISMISS:
      if (noticeId !== null) host.dismiss(noticeId);
      return;
    case NOTIFICATION_ACTION.CLEAR_ALL:
      host.clearAll();
      return;
    default:
      if (noticeId !== null && id.startsWith(NOTIFICATION_ACTION.RUN_PREFIX)) {
        const index = Number.parseInt(id.slice(NOTIFICATION_ACTION.RUN_PREFIX.length), 10);
        if (Number.isInteger(index)) host.runAction(noticeId, index);
        return;
      }
      // 目前通知面不产出命令项；留这条通道，日后加「打开设置」之类不至于静默按不动
      runMenuItemCommand(id);
  }
}

/* ------------------------------ 面声明 ------------------------------ */

/** 通知（一条 toast；容器空白处 = 整批） */
declareContextSurface({
  id: 'notification',
  ariaLabel: '通知菜单',
  area: 'panel',
  build: (ctx: ContextSurfaceBuildContext): ContextSurfaceBuildResult => {
    const host = noticeHost;
    if (host === null) return null;
    const toast = ctx.target.closest<HTMLElement>('[data-notice-id]');
    if (toast === null) {
      // 容器空白处：只给整批动作（这里没有「这一条」可复制/可清除）
      if (host.notices.length === 0) return null;
      return {
        items: [{ id: NOTIFICATION_ACTION.CLEAR_ALL, label: '清除全部通知' }],
        onSelect: (id) => runNotificationAction(id, null),
      };
    }
    const rawId = toast.getAttribute('data-notice-id');
    const noticeId = rawId === null ? Number.NaN : Number.parseInt(rawId, 10);
    const notice = Number.isInteger(noticeId)
      ? host.notices.find((n) => n.id === noticeId)
      : undefined;
    // 通知刚被别处清掉（自动消失 / 同屏淘汰）⇒ 这一级不表态，回落下一级
    if (notice === undefined) return null;
    const items = buildNotificationMenu({
      hasAction: notice.actions.length > 0,
      actionLabels: notice.actions,
      total: host.notices.length,
    });
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runNotificationAction(id, notice.id) };
  },
});
