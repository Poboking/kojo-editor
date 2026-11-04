import { useSyncExternalStore } from 'react';
/**
 * 「上次检查更新」的会话级读数（UPD-D）。
 *
 * 给设置页更新区补一条 hint：作者点完「检查更新」后能看见「上次检查 14:32」这样的落点，
 * 而不是盯着一句没有任何时间感的「已是最新版本」猜"这是刚才查的还是昨天的"。
 *
 * ## 为什么刻意**不落盘**
 *
 * 每次启动 3 秒后必有一次自动检查（`update-flow.tsx` 的静默检查，非 Tauri 才不跑），
 * 所以"上一次检查"**永远发生在本会话内**——把昨天的时刻写进 localStorage，下次启动
 * 读出来的只会是一句谎话（"上次检查 昨天 22:10"，而实际上 3 秒前刚查过）。
 * 会话级内存真源 + 启动清零，才和"3 秒后必查"的事实对得上。
 *
 * ## 形态（照 `update-dismiss-pref.ts` 的先例，但少一层存储）
 *
 * 模块真源 + 订阅表 + `useSyncExternalStore`，唯一差别是真源是**内存对象**而不是
 * localStorage 串：记录只在 `recordUpdateCheck` 时被整体替换，旧引用永不改写，
 * 所以 `getSnapshot` 直接返回当前引用就是稳定身份（`Object.is` 恒真），
 * 不需要 dismiss-pref 那套「原始串快照 + useMemo 解析」手法。
 *
 * `outcome` 记的是**检查**的结果（found / latest / failed），不记下载安装段
 * （downloading / done 不是检查，安装进度另有三张面在报）。
 */

/** 一次检查的结果（与 `UpdatePhase` 的三种收尾态一一对应；`failed` 只含检查段） */
export type UpdateCheckOutcome = 'found' | 'latest' | 'failed';

/** 一条「上次检查」记录：什么时候查的、查出了什么 */
export interface UpdateLastCheck {
  readonly at: number;
  readonly outcome: UpdateCheckOutcome;
}

/** 模块真源（会话级；启动即 null，见文件头「为什么不落盘」） */
let lastCheck: UpdateLastCheck | null = null;

const listeners = new Set<() => void>();

/**
 * 记一次检查的收尾（先换真源后通知，订阅者读到的必然是新值）。
 *
 * `at` 可注入（纯测试用）：生产调用一律吃默认 `Date.now()`，与判龄那把墙钟同源。
 */
export function recordUpdateCheck(outcome: UpdateCheckOutcome, at: number = Date.now()): void {
  lastCheck = { at, outcome };
  for (const listener of listeners) listener();
}

/** 读当前记录（本会话还没查过 ⇒ null） */
export function getLastUpdateCheck(): UpdateLastCheck | null {
  return lastCheck;
}

/** 订阅变化（返回取消函数） */
export function subscribeUpdateLastCheck(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 读数。快照 = 真源引用本身：只在 `recordUpdateCheck` 时换新对象，
 * 其余时刻 `Object.is` 恒真，不会造成无限重渲。
 */
export function useLastUpdateCheck(): UpdateLastCheck | null {
  return useSyncExternalStore(subscribeUpdateLastCheck, getLastUpdateCheck, () => null);
}

/**
 * 「上次检查 HH:mm」的格式化（纯函数，`at` / `now` 都由调用方给，可单测钉死）。
 *
 * 三档粒度（越旧越粗，人只对"刚才"有分钟级记忆）：
 * - **今天**：`上次检查 14:32`；
 * - **今年内**：`上次检查 11月3日 09:15`；
 * - **更早**：`上次检查 2024年12月1日`。
 *
 * 任何一刻不是有限数（脏数据 / 时钟异常）⇒ 返回 null，呈现层整条不画——
 * 免打扰偏好同款口径：时间读数是礼遇不是数据，绝不因为脏值把设置页卡出错误框。
 */
export function formatUpdateLastCheck(at: number, now: number): string | null {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  const d = new Date(at);
  const ref = new Date(now);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
  if (sameDay) return `上次检查 ${hhmm}`;
  const sameYear = d.getFullYear() === ref.getFullYear();
  if (sameYear) return `上次检查 ${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  return `上次检查 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
