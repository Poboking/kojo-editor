import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { pushNotice } from './notice-queue';
import { Icon } from './icons';
import { installNoticeMenuHost } from './notification-menu';

/** 通知动作按钮（如「去授权」）——点击后先关 toast 再执行 */
export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

export interface NoticeInput {
  readonly kind: 'info' | 'error';
  /** 面向作者的中文人话（定稿 §九-3：裸英文堆栈只进日志） */
  readonly message: string;
  readonly action?: NoticeAction;
  /**
   * 逐字保留的技术原文，**只在悬停里出现**（FMT-TOAST，additive：既有调用方零改动）。
   *
   * 口径照 `ui-kojo-navigator/src/panel-copy.ts`：第一眼必须是人话，内部错误串/机器名
   * 不许当第一眼，但一条都不许丢 ⇒ 让路点叫什么、原因原文，作者悬停就能查到。
   */
  readonly detail?: string;
  /**
   * 多个并列动作（additive；`action` 的语义与渲染一字未动，旧消费方零改动）。
   *
   * 为什么需要复数：「磁盘被外部改动」这类现场给的不是一个选择而是两个——先看差异、
   * 还是直接放弃我的修改。只留一条按钮等于替用户做了他没同意的那个决定。
   */
  readonly actions?: readonly NoticeAction[];
  /**
   * 第一眼标题（additive，视觉批十一 R5）。缺席时由 `message` 的头一句自动派生
   * （见 {@link splitNoticeMessage}），所以既有调用方零改动。
   *
   * 为什么要标题：真壳实测一条「结构着色这次没顶上…」在 400px 的 toast 里排成三行，
   * 断行断在「跨/度」中间——正文是**数据倾倒**而不是**一句话**。呈现层因此固定成
   * 「标题 + 一行摘要」，长句折进展开态与悬停，一条都不丢。
   */
  readonly title?: string;
}

export interface Notice extends NoticeInput {
  readonly id: number;
}

export type Notify = (notice: NoticeInput) => void;

export const NotifyContext = createContext<Notify>(() => {});

/** toast 同屏上限与淘汰规则住在 `notice-queue.ts`（纯函数可单测，HK-8 裁决批） */
/** info 自动消失时长；error 常驻到用户处理（与 VSCode 一致：错误不自动消失） */
const INFO_TTL_MS = 6000;

/**
 * 一条通知身上的可执行动作（`action` 与 `actions` 两代形态按序拼起来）。
 *
 * 右键菜单「执行通知里的操作」按这个顺序编号（`notice.run.<index>`）——屏上按钮的
 * 排列就是 `action` 在前、`actions` 在后，两边同序才不至于「菜单点的」和「按钮点的」
 * 不是同一件事。导出只为单测（`shell-menus.test.ts` 钉住顺序口径）。
 */
export function noticeActionsOf(notice: NoticeInput): readonly NoticeAction[] {
  return [...(notice.action ? [notice.action] : []), ...(notice.actions ?? [])];
}

/**
 * 消息正文的天然停顿点（先后次序 = 优先切的第一个；找不到就不切）。
 *
 * 只认这三个：`：`（「这次选区格式化没有生效：编辑器没能确认…」的因果连接符）、
 * `⇒`（「取数失败 ⇒ 回到词法层」的结论连接符）、`。`（整句收尾）。
 * 逗号/顿号不认——切出来的半句当标题比原句更难读。
 */
const HEAD_SEPARATORS = ['：', '⇒', '。'] as const;

/** 标题长度上限：超过它的头一句已经不是"标题"了，整条退回摘要那一行 */
const HEAD_MAX_LEN = 30;

/**
 * `message` → 第一眼标题 + 一行摘要（纯函数，视觉批十一 R5）。
 *
 * 口径：**分割是有损排版、无损信息**——`：`/`⇒` 这类连接符被丢掉（它是语气，不是内容），
 * `。` 跟在标题里；其余字符一个不删。摘要那一行在屏上只显一行（省略号收尾），
 * 但整段文本始终在 DOM 里 ⇒ 读屏逐字念得完，悬停 `title` 与展开态也都在（铁律 4 的
 * 「可见」不许变成「只给一半」）。
 */
export function splitNoticeMessage(message: string): { readonly head: string; readonly rest: string } {
  const text = message.trim();
  let cut = -1;
  let sepLen = 0;
  for (const sep of HEAD_SEPARATORS) {
    const i = text.indexOf(sep);
    if (i < 2 || i > HEAD_MAX_LEN) continue;
    if (cut < 0 || i < cut) {
      cut = i;
      sepLen = sep.length;
    }
  }
  if (cut < 0) return { head: text, rest: '' };
  // `。` 是句末（跟着标题走），`：`/`⇒` 是连接符（丢掉语气，其余字符一个不删）
  const keepSep = text[cut] === '。';
  const head = text.slice(0, keepSep ? cut + 1 : cut).trim();
  const rest = text.slice(keepSep ? cut + 1 : cut + sepLen).trim();
  return { head, rest };
}

/** 悬停内容：人话全文 + 逐字技术原文（缺哪个就少哪格，绝不吞掉另一个） */
function noticeTooltip(notice: NoticeInput): string | undefined {
  const detail = notice.detail;
  if (detail === undefined || detail === '') return notice.message;
  return `${notice.message}\n${detail}`;
}

/**
 * 壳层通知中心（2026-10-11 写权限闭环批 P0；定稿 §九-3）。
 *
 * 壳层私有（不进内核事件表）：Provider + toast 渲染一体，任意壳层组件经
 * `useNotify()` 发通知。info 6s 自动消失；error 常驻到用户关闭或点击 action。
 */
export function NotificationCenter({ children }: { children: ReactNode }): ReactElement {
  const [notices, setNotices] = useState<Notice[]>([]);
  const seqRef = useRef(0);
  /**
   * noticeId → 该条 info 的自动消失计时器（nit：原来是一条数组，只增不减）。
   * 表与"屏上还挂着的 info"同步收敛 —— 见下面那个 effect：条目不论以哪种方式离开屏幕
   * （时间到、用户关闭、被同屏上限淘汰）都立刻清掉它那条计时，表因此有界。
   */
  const timersRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setNotices((list) => list.filter((n) => n.id !== id));
  }, []);

  /** 一键清掉屏上全部（右键菜单的「清除全部通知」；计时器由下面那个收敛 effect 一并收） */
  const clearAll = useCallback(() => setNotices([]), []);

  /**
   * 通知面的右键菜单（WP3.8）：把「屏上有哪几条 + 每条带什么动作」交给菜单数据面，
   * 动作仍回到这里落地（`dismiss` / `clearAll` / 执行通知自带的 action）。
   * 菜单不持有第二份通知列表——真源始终是本组件的 `notices`。
   */
  useEffect(() => {
    return installNoticeMenuHost({
      notices: notices.map((n) => ({
        id: n.id,
        message: n.message,
        ...(n.detail === undefined ? {} : { detail: n.detail }),
        actions: noticeActionsOf(n).map((a) => a.label),
      })),
      dismiss,
      clearAll,
      runAction: (id, index) => {
        const notice = notices.find((n) => n.id === id);
        const action = notice === undefined ? undefined : noticeActionsOf(notice)[index];
        // 先收通知再执行：与 toast 上那颗按钮同一顺序（动作可能开面板/弹窗，不该被盖在 toast 下）
        dismiss(id);
        action?.run();
      },
    });
  }, [notices, dismiss, clearAll]);

  const notify = useCallback<Notify>(
    (input) => {
      const id = ++seqRef.current;
      setNotices((list) => pushNotice(list, { ...input, id }));
      if (input.kind === 'info') {
        timersRef.current.set(id, window.setTimeout(() => dismiss(id), INFO_TTL_MS));
      }
    },
    [dismiss],
  );

  // 计时表跟着屏上的通知收敛（不在屏上的 ⇒ clearTimeout + 从表里删）
  useEffect(() => {
    const alive = new Set(notices.map((n) => n.id));
    for (const [id, timer] of [...timersRef.current]) {
      if (alive.has(id)) continue;
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, [notices]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {notices.length > 0 ? (
        <div
          className="notification-center notification-shell"
          data-context-surface="notification"
        >
          {notices.map((n) => {
            const given = n.title === undefined ? '' : n.title.trim();
            const split = splitNoticeMessage(n.message);
            const head = given === '' ? split.head : given;
            const summary = given === '' ? split.rest : n.message;
            const detail = n.detail === undefined ? '' : n.detail.trim();
            return (
              <div
                key={n.id}
                className={`toast toast-${n.kind}`}
                role="alert"
                title={noticeTooltip(n)}
                // 右键菜单认这一条是谁（容器空白处 = 整批「清除全部」）
                data-notice-id={n.id}
              >
                <span className="toast-icon" aria-hidden="true">
                  <Icon name={n.kind === 'error' ? 'error' : 'info'} size={16} />
                </span>
                <span className="toast-body">
                  <span className="toast-head">{head}</span>
                  {summary === '' || summary === head ? null : (
                    <span className="toast-summary">{summary}</span>
                  )}
                  {/* 细节折进展开态：技术原文（机器面）逐字留在这里 + 悬停，正文只有一行人话 */}
                  {detail === '' ? null : (
                    <details className="toast-fold">
                      <summary>详情</summary>
                      <div className="toast-detail">{detail}</div>
                    </details>
                  )}
                </span>
                {n.action ? (
                  <button
                    className="small toast-action"
                    onClick={() => {
                      dismiss(n.id);
                      n.action?.run();
                    }}
                  >
                    {n.action.label}
                  </button>
                ) : null}
                {(n.actions ?? []).map((a, i) => (
                  <button
                    key={`${n.id}:${i}`}
                    className="small toast-action"
                    onClick={() => {
                      dismiss(n.id);
                      a.run();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
                <button className="ghost small toast-close" title="关闭" onClick={() => dismiss(n.id)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </NotifyContext.Provider>
  );
}

export function useNotify(): Notify {
  return useContext(NotifyContext);
}
