import { useMemo, useSyncExternalStore } from 'react';
/**
 * 更新提醒的「同版本免打扰」偏好（批次十一 L05 · 层一）。
 *
 * 存法照 `glass-pref.ts` / `code-lens-pref.ts` 先例——localStorage 真源 + 订阅表，
 * **不新造第二套偏好机制**。修的是实测缺陷③：「稍后」过去只记在 ShellLayout 的会话变量里
 * （`dismissedUpdateVersionInSession`），下次启动照弹。本模块把「作者在哪版上点过稍后、
 * 什么时候点的」落盘，跨会话生效。
 *
 * ## 记录形态
 *
 * 一条记录 = `{ version, dismissedAt }`（JSON）。损坏值（读不出 JSON / 类型不对）
 * 一律当「没存过」——免打扰是礼遇不是数据，绝不因为脏数据把提醒链卡死。
 *
 * ## 语义口径
 *
 * - 免打扰**只对同版本**生效：别的版本发布照提醒；
 * - 只对**当前这一版**在 `UPDATE_NOTICE_QUIET_DAYS` 天内有效，过期自动失效
 *   （读取时判龄，不做事后清理——过期记录被下一次「稍后」覆盖即可）；
 * - `dismissedAt` 在未来（改表/时区）按「刚点过」算有效：判据是 `now - dismissedAt < quietMs`，
 *   负数天然通过，不必特判。
 */

/** 偏好键（localStorage） */
export const UPDATE_DISMISS_KEY = 'kojo.ui.updateDismissal.v1';

/** 同版本免打扰天数：7 天——一周内不重复打扰，但也不至于永远漏掉没装的更新 */
export const UPDATE_NOTICE_QUIET_DAYS = 7;
export const UPDATE_NOTICE_QUIET_MS = UPDATE_NOTICE_QUIET_DAYS * 24 * 60 * 60 * 1000;

/** 一条免打扰记录（哪一版、什么时候点的「稍后」） */
export interface UpdateDismissal {
  readonly version: string;
  readonly dismissedAt: number;
}

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读原始存储串（window 缺席 / 抛错 ⇒ null，即「没存过」）；React 快照也用它（串可直接 Object.is 比较） */
export function getUpdateDismissalRaw(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(UPDATE_DISMISS_KEY);
  } catch {
    return null;
  }
}

/** 写原始存储值；写不进去静默降级为「本次会话内记住」 */
function writeRaw(value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(UPDATE_DISMISS_KEY, value);
  } catch {
    /* 隐私模式 / 配额满 */
  }
}

function removeRaw(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(UPDATE_DISMISS_KEY);
  } catch {
    /* 同上：清不掉也只是「下次还按存的算」 */
  }
}

/**
 * 解析存储串：只认 `{"version":"…","dismissedAt":数字}`；其余（空串 / 半截 JSON /
 * 类型不对 / version 空串）一律 null——口径同 `code-lens-pref` 的「只有明确存过才算」。
 */
export function parseUpdateDismissal(raw: string | null): UpdateDismissal | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as { version?: unknown; dismissedAt?: unknown };
    if (typeof record.version !== 'string' || record.version.trim() === '') return null;
    if (typeof record.dismissedAt !== 'number' || !Number.isFinite(record.dismissedAt)) return null;
    return { version: record.version, dismissedAt: record.dismissedAt };
  } catch {
    return null;
  }
}

/** 读当前免打扰记录（没存过 / 损坏 ⇒ null，绝不抛） */
export function loadUpdateDismissal(): UpdateDismissal | null {
  return parseUpdateDismissal(getUpdateDismissalRaw());
}

/** 纯判龄：这条记录此刻还给不给这一版免打扰（不碰存储，可单测钉死） */
export function isUpdateDismissalActive(
  record: UpdateDismissal | null,
  version: string,
  now: number = Date.now(),
  quietMs: number = UPDATE_NOTICE_QUIET_MS,
): boolean {
  if (record === null || record.version !== version) return false;
  if (!Number.isFinite(now)) return false;
  return now - record.dismissedAt < quietMs;
}

/** 存储版判据：这一版现在是否处于免打扰期内 */
export function isUpdateNoticeQuiet(version: string, now?: number, quietMs?: number): boolean {
  return isUpdateDismissalActive(loadUpdateDismissal(), version, now, quietMs);
}

/** 点「稍后」：记为「这一版刚免打扰」（先写后通知，订阅者读到的必然是新值） */
export function dismissUpdateVersion(version: string, now: number = Date.now()): void {
  if (version.trim() === '') return;
  writeRaw(JSON.stringify({ version, dismissedAt: now }));
  notifyUpdateDismissal();
}

/** 清除免打扰记录（如手动检查时想强制恢复提醒） */
export function clearUpdateDismissal(): void {
  removeRaw();
  notifyUpdateDismissal();
}

const listeners = new Set<() => void>();

/** 订阅变化（返回取消函数） */
export function subscribeUpdateDismissal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyUpdateDismissal(): void {
  for (const listener of listeners) listener();
}

/**
 * React 读数（卡片的可见性跟着它走）。
 *
 * 快照返回**原始串**而不是解析后的对象：`useSyncExternalStore` 每轮渲染都会 `Object.is`
 * 比较快照，新对象会造成无限重渲——串才是稳定身份。解析结果用 `useMemo` 挂在串上。
 */
export function useUpdateDismissal(): UpdateDismissal | null {
  const raw = useSyncExternalStore(subscribeUpdateDismissal, getUpdateDismissalRaw, () => null);
  return useMemo(() => parseUpdateDismissal(raw), [raw]);
}
