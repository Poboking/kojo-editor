/**
 * 「开发者的碎碎念」纸条是否已经看过（用户反馈 2，2026-10-18）。
 *
 * 口径：**这是一次性提示，不是偏好**——没有「重新打开」的 UI 入口，读过就永远不再弹；
 * 但作者清掉浏览器数据 / 换机器时会重新看到，这是可接受的（与主题、动效那种"持续生效"
 * 的偏好不同，那些有自己的键）。
 *
 * 键名沿用壳层惯例 `kojo.ui.<name>.v1`：版本后缀留在这里，将来真要换形态时
 * 直接升 v2 即可，老键自然失配（不需要迁移逻辑：读不到 = 没看过 = 再弹一次，无害）。
 *
 * 读写一律 fail-safe：隐私模式 / 存储被禁 / 根本没有 window（测试环境）时读不到
 * ⇒ 当作没看过（照常提示一次），写不进 ⇒ 静默放过（本次会话内仍只弹一次，
 * 因为它由 App 的 state 守着）。**绝不抛**——一句开发者问候不该成为启动路径上的故障源。
 */

const DEV_NOTE_SEEN_KEY = 'kojo.ui.devNoteSeen.v1';

/** 取当前环境的 localStorage（无 window 时返回 null；口径与 sealed.ts 等同） */
function storageOf(): Storage | null {
  const g = globalThis as unknown as { localStorage?: Storage };
  return g.localStorage ?? null;
}

/** 是否已经看过纸条（读不到一律返回 false —— 宁可多提示一次，也不静默吞掉提示） */
export function loadDevNoteSeen(): boolean {
  try {
    return storageOf()?.getItem(DEV_NOTE_SEEN_KEY) === '1';
  } catch {
    // 隐私模式 / 存储被禁：读不到就是没看过
    return false;
  }
}

/** 记下"看过了"（失败静默：存储不可用不该变成一条错误通知） */
export function markDevNoteSeen(): void {
  try {
    storageOf()?.setItem(DEV_NOTE_SEEN_KEY, '1');
  } catch {
    /* 存储不可用（隐私模式 / 配额满）：本次会话已由 App 的 state 保证只弹一次 */
  }
}
