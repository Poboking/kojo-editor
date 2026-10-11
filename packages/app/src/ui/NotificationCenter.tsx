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
}

export interface Notice extends NoticeInput {
  readonly id: number;
}

export type Notify = (notice: NoticeInput) => void;

export const NotifyContext = createContext<Notify>(() => {});

/** toast 同屏上限：超出时丢弃最旧（防刷屏堆叠） */
const MAX_NOTICES = 5;
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
  const timersRef = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setNotices((list) => list.filter((n) => n.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (input) => {
      const id = ++seqRef.current;
      setNotices((list) => [...list.slice(-(MAX_NOTICES - 1)), { ...input, id }]);
      if (input.kind === 'info') {
        timersRef.current.push(window.setTimeout(() => dismiss(id), INFO_TTL_MS));
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) window.clearTimeout(t);
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
                {n.kind === 'error' ? '✕' : 'i'}
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
              <button className="ghost small toast-close" title="关闭" onClick={() => dismiss(n.id)}>
                ×
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
