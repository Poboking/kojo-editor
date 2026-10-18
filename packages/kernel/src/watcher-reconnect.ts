/**
 * watcher 失效自愈的纯逻辑（P0-5）：指数退避序列 + 放弃判据。
 *
 * 从 `watcher.ts` 拆出来单独成模块的原因：这两个判定是重连行为的**本体**
 * （对应批次的判据就钉在「序列 / 封顶 / 终态阈值」上），放实现类里会被
 * 生命周期代码淹没，单测也不得不先搭一座假桥才能碰到它们。
 */

/** 退避基数：第 1 次重建尝试前等 1 秒。 */
export const WATCH_RECONNECT_BASE_DELAY_MS = 1_000;
/** 退避封顶：再惨也 60 秒一试——编辑器不是网络服务，没理由更久。 */
export const WATCH_RECONNECT_MAX_DELAY_MS = 60_000;
/**
 * 连续失败到这个次数就彻底放弃（终态 `unavailable`，只剩手动刷新兜底）。
 * 10 次 × 封顶 60s ⇒ 最坏坚持 ~8 分钟；正常场景（git checkout 换目录）
 * 秒级就能重建上，根本走不到上限。
 */
export const WATCH_RECONNECT_MAX_ATTEMPTS = 10;

/**
 * 已经连续失败 `failedAttempts` 次后，下一次重建尝试前要等多久。
 *
 * 序列：1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, …（第 7 次起封顶）。
 * 移位上限 16 是防御：调用方传超大数时不让 `2 ** n` 溢出成 Infinity
 * 再被 `Math.min` 收编——先钳再算，数值永远落在表内。
 */
export function reconnectDelayMs(failedAttempts: number): number {
  const shift = Math.max(0, Math.min(failedAttempts, 16));
  return Math.min(WATCH_RECONNECT_BASE_DELAY_MS * 2 ** shift, WATCH_RECONNECT_MAX_DELAY_MS);
}

/** 连续失败 `failedAttempts` 次后是否该放弃自动重连（终态降级）。 */
export function shouldGiveUpReconnect(failedAttempts: number): boolean {
  return failedAttempts >= WATCH_RECONNECT_MAX_ATTEMPTS;
}

/**
 * 把当前进度说成人话（进 `failures[].reason`，宿主 toast 直接展示）：
 * 「已自动重连 3 次，第 4 次将于 8 秒后」。
 */
export function describeReconnectProgress(failedAttempts: number): string {
  const delayS = Math.round(reconnectDelayMs(failedAttempts) / 1000);
  return `已自动重连 ${failedAttempts} 次未成功，第 ${failedAttempts + 1} 次将于 ${delayS} 秒后`;
}