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
   * 多个并列动作（additive；`action` 的语义与渲染一字未动，旧消费方零改动）。
   *
   * 为什么需要复数：「磁盘被外部改动」这类现场给的不是一个选择而是两个——先看差异、
   * 还是直接放弃我的修改。只留一条按钮等于替用户做了他没同意的那个决定。
   */
  readonly actions?: readonly NoticeAction[];
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
        <div className="notification-center">
          {notices.map((n) => (
            <div key={n.id} className={`toast toast-${n.kind}`} role="alert">
              <span className="toast-icon" aria-hidden="true">
                <Icon name={n.kind === 'error' ? 'error' : 'info'} size={16} />
              </span>
              <span className="toast-message">{n.message}</span>
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
          ))}
        </div>
      ) : null}
    </NotifyContext.Provider>
  );
}

export function useNotify(): Notify {
  return useContext(NotifyContext);
}
