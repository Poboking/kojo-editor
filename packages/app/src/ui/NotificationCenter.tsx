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
import { motionIsReduced } from './motion-pref';
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
 * 退场动画的实际时长（ms），**从计算样式读**而不是在 TS 里再抄一份 200。
 *
 * 抄一份常量就是两个真源：`motion-exit.css` 的 `.toast.toast-out` 改档时这里会静默不同步
 * （要么提前半帧切掉、要么让一条透明的 toast 多占 200ms 的 DOM）。读计算样式则天然同源。
 * 读到 0 / 读不到 ⇒ 当帧移除，三条路径同效：减弱动效、样式表没装载（单测的 node 环境）、
 * 以及浏览器因机器性能丢弃动画。`animationDuration` 可能是逗号列表，只取第一条。
 */
function exitDurationMs(el: HTMLElement): number {
  if (typeof getComputedStyle !== 'function') return 0;
  const raw = getComputedStyle(el).animationDuration.split(',')[0]?.trim() ?? '';
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}

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
 * 认这四个：`：`（「这次选区格式化没有生效：编辑器没能确认…」的因果连接符）、
 * `⇒`（「取数失败 ⇒ 回到词法层」的结论连接符）、`。`（整句收尾）、`（`（补充语）。
 * 逗号/顿号不认——切出来的半句当标题比原句更难读。
 *
 * 每枚切点自带三个行为参数，因为它们的语法身份不同：
 *  - `headTakesSep`：符号跟谁走（`。` 是句末，留在标题里读得通）；
 *  - `dropSep`：连接符是**语气**不是内容，可以整枚丢掉；括号是**配对符号**，
 *    丢了摘要行就从一个半括号起头 ⇒ 必须留；
 *  - `minHead`：切完之后标题至少几个字。`（` 取 4 而不是 2——「这一版（临时）没有改动」
 *    切在括号上，标题只剩「这一版」三个字，那不是标题，是半句话的开头。
 *
 * `（` 这一枚是 2026-10-24 组长真壳复验补的：实测一条 21 字标题
 * 「结构着色这次没顶上（这一面已退回原来的做法）」在 262px 宽的 toast 里被省略号吃掉 24px
 * ⇒ 第一眼标题断在半句上。补充语收进摘要行，标题才立得住（信息一条不减）。
 */
const HEAD_SEPARATORS = [
  { sep: '：', headTakesSep: false, dropSep: true, minHead: 2 },
  { sep: '⇒', headTakesSep: false, dropSep: true, minHead: 2 },
  { sep: '。', headTakesSep: true, dropSep: false, minHead: 2 },
  { sep: '（', headTakesSep: false, dropSep: false, minHead: 4 },
] as const;

/** 标题长度上限：超过它的头一句已经不是"标题"了，整条退回摘要那一行 */
const HEAD_MAX_LEN = 30;

/**
 * `message` → 第一眼标题 + 一行摘要（纯函数，视觉批十一 R5）。
 *
 * 口径：**分割是有损排版、无损信息**——`：`/`⇒` 这类连接符被丢掉（它是语气，不是内容），
 * `。` 跟在标题里，`（…）` 整段跟着摘要行；其余字符一个不删。摘要那一行在屏上只显一行
 * （省略号收尾），但整段文本始终在 DOM 里 ⇒ 读屏逐字念得完，悬停 `title` 与展开态也都在
 * （铁律 4 的「可见」不许变成「只给一半」）。
 */
export function splitNoticeMessage(message: string): { readonly head: string; readonly rest: string } {
  const text = message.trim();
  let cut = -1;
  let winner: (typeof HEAD_SEPARATORS)[number] | null = null;
  for (const rule of HEAD_SEPARATORS) {
    const i = text.indexOf(rule.sep);
    if (i < rule.minHead || i > HEAD_MAX_LEN) continue;
    if (cut < 0 || i < cut) {
      cut = i;
      winner = rule;
    }
  }
  if (cut < 0 || winner === null) return { head: text, rest: '' };
  // 三档归属：句末号跟着标题走；连接符是语气，整枚丢掉；括号是配对符号，留在摘要行开头
  const headEnd = winner.headTakesSep ? cut + 1 : cut;
  const restStart = winner.headTakesSep ? cut + 1 : winner.dropSep ? cut + winner.sep.length : cut;
  return { head: text.slice(0, headEnd).trim(), rest: text.slice(restStart).trim() };
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

  /**
   * 正在退场的通知 id（1026 动效批 A2：此前消失 = DOM 直接卸载，一条提示是"啪"地没的）。
   * 与 `notices` 分开存：`notices` 是**屏上有哪几条**的真源，退场只是那一条被划掉了，
   * 它还得画完 200ms 的淡出才真正离开。
   */
  const [exiting, setExiting] = useState<readonly number[]>([]);
  /** 退场计时器（按 id）。与上面 `timersRef` 分开：那本是 info 的 TTL，这本是动画时长。 */
  const exitTimersRef = useRef(new Map<number, number>());
  /** 退场要量的是**这一条自己的**计算样式，所以得摸到容器 */
  const centerRef = useRef<HTMLDivElement | null>(null);

  /** 真正把一条从屏上摘掉（退场动画走完 / 减弱动效 / 无样式表时都是这里） */
  const drop = useCallback((id: number) => {
    setExiting((list) => list.filter((x) => x !== id));
    setNotices((list) => list.filter((n) => n.id !== id));
  }, []);

  /**
   * 关闭一条通知。语义仍是"立刻从真源里划掉"，只是**画面上**多一帧退场：
   * 先挂 `.toast-out`（见 `motion-exit.css`），等它自己跑完再 `drop`。
   * 减弱动效 / 无样式表环境 ⇒ 不进动画，当帧消失（绝不等待）。
   */
  const dismiss = useCallback(
    (id: number) => {
      if (motionIsReduced()) {
        drop(id);
        return;
      }
      setExiting((list) => (list.includes(id) ? list : [...list, id]));
    },
    [drop],
  );

  /**
   * 一键清掉屏上全部（右键菜单的「清除全部通知」；计时器由下面那个收敛 effect 一并收）。
   *
   * 与单条 `dismiss` 同一条语义：非减弱档**保留 `notices`**、只把每条标进 `exiting`，
   * 于是 DOM 还在、`.toast-out` 能真跑满 200ms，到点由 `drop` 逐个摘——批量清除也是
   * 一片淡出而不是"啪"地全没。减弱档才直接清空。
   */
  const clearAll = useCallback(() => {
    if (motionIsReduced() || notices.length === 0) {
      setExiting([]);
      setNotices([]);
      return;
    }
    setExiting((list) => [...new Set([...list, ...notices.map((n) => n.id)])]);
  }, [notices]);

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

  /**
   * 退场排程（A2）：`.toast-out` 挂上去之后，量这一条自己的动画时长，再按时长摘掉它。
   *
   * 为什么量而不是听 `animationend`：听事件在"动画根本没跑"的环境里会**永久卡住**
   * （无样式表、单测的 node/happy-dom、浏览器把动画丢了）——一条已经透明的 toast 赖在
   * DOM 里，`role="alert"` 还继续念。时长读成 0 就走当帧移除那条腿，两种环境同一条路径。
   * 多留 30ms 是给"定时器比合成器早一拍"的余量，不然最后一帧会露出 0.1 的不透明度。
   */
  useEffect(() => {
    if (exiting.length === 0) return;
    for (const id of exiting) {
      if (exitTimersRef.current.has(id)) continue;
      const el = centerRef.current?.querySelector<HTMLElement>(`[data-notice-id="${id}"]`) ?? null;
      const ms = el === null ? 0 : exitDurationMs(el);
      if (ms === 0) {
        drop(id);
        continue;
      }
      exitTimersRef.current.set(
        id,
        window.setTimeout(() => {
          exitTimersRef.current.delete(id);
          drop(id);
        }, ms + 30),
      );
    }
  }, [exiting, drop]);

  useEffect(() => {
    const timers = exitTimersRef.current;
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
          ref={centerRef}
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
                className={`toast toast-${n.kind}${exiting.includes(n.id) ? ' toast-out' : ''}`}
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
