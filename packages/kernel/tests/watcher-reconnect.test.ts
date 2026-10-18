import { describe, expect, it } from 'vitest';
import {
  WATCH_RECONNECT_MAX_ATTEMPTS,
  describeReconnectProgress,
  reconnectDelayMs,
  shouldGiveUpReconnect,
} from '../src/watcher-reconnect';

/**
 * 失效自愈纯逻辑（P0-5）：退避序列 / 封顶 / 终态阈值 / 进度文案。
 * 只钉数学，不碰桥——行为面（mock 事件源、会话号竞态）在 `watcher.test.ts`。
 */
describe('watcher-reconnect · 退避序列', () => {
  it('指数序列 1s/2s/4s/8s/16s/32s，第 7 次起封顶 60s', () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
    expect(reconnectDelayMs(4)).toBe(16_000);
    expect(reconnectDelayMs(5)).toBe(32_000);
    expect(reconnectDelayMs(6)).toBe(60_000); // 64s 被封顶
    expect(reconnectDelayMs(7)).toBe(60_000);
    expect(reconnectDelayMs(8)).toBe(60_000);
  });

  it('超大失败计数不溢出（防御钳位后仍封顶 60s）', () => {
    expect(reconnectDelayMs(100)).toBe(60_000);
    expect(reconnectDelayMs(Number.MAX_SAFE_INTEGER)).toBe(60_000);
  });

  it('负数输入按 0 处理（不产生亚秒级重试）', () => {
    expect(reconnectDelayMs(-1)).toBe(1_000);
  });
});

describe('watcher-reconnect · 终态阈值', () => {
  it('连续失败 9 次仍不放弃，第 10 次彻底降级', () => {
    expect(shouldGiveUpReconnect(0)).toBe(false);
    expect(shouldGiveUpReconnect(9)).toBe(false);
    expect(shouldGiveUpReconnect(10)).toBe(true);
    expect(shouldGiveUpReconnect(11)).toBe(true);
  });

  it('上限值与序列封顶协同：10 次尝试最长等 1+2+4+8+16+32+60×3 ≈ 3.5 分钟', () => {
    let total = 0;
    for (let failed = 0; failed < WATCH_RECONNECT_MAX_ATTEMPTS; failed++) {
      total += reconnectDelayMs(failed);
    }
    // 1+2+4+8+16+32+60+60+60+60 = 303 秒：够目录换名回来，又不至于无限耗
    expect(total).toBe(303_000);
  });
});

describe('watcher-reconnect · 进度文案', () => {
  it('把「第几次、等多久」说成人话（宿主 toast 直接展示）', () => {
    expect(describeReconnectProgress(0)).toBe('已自动重连 0 次未成功，第 1 次将于 1 秒后');
    expect(describeReconnectProgress(3)).toBe('已自动重连 3 次未成功，第 4 次将于 8 秒后');
    expect(describeReconnectProgress(6)).toBe('已自动重连 6 次未成功，第 7 次将于 60 秒后');
  });

  it('文案里的等待时长与退避序列同源（不抄第二份表）', () => {
    for (const failed of [0, 1, 2, 5, 9]) {
      const s = Math.round(reconnectDelayMs(failed) / 1000);
      expect(describeReconnectProgress(failed)).toContain(`将于 ${s} 秒后`);
    }
  });
});