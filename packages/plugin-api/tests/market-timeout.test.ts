import { describe, expect, it } from 'vitest';
import {
  MARKET_DOWNLOAD_TIMEOUT_BASE_MS,
  MARKET_DOWNLOAD_TIMEOUT_MS_PER_MIB,
  MARKET_MAX_UNPACKED_BYTES,
  marketDownloadTimeoutMs,
} from '../src/market';

/**
 * 容器下载超时换算（纯函数）的判据。
 *
 * 依据（公式为什么长这样）：受众直连 GitHub release 资产的慢网量级 ~1 MB/s，原 60s 常量
 * 只够 60 MB 以下的包；公式 = 60s 基础 + 每 MiB 1s ⇒ 按 ~0.5 MB/s 预算（比慢网再慢一倍，
 * 留余量给限速与抖动），真断线由平台侧请求错误兜住，不需要超时单扛。
 */
describe('marketDownloadTimeoutMs：60s 基础 + 每 MiB 1s', () => {
  it('零体积 = 纯基础段（握手 / 重定向 / 首字节延迟的那部分）', () => {
    expect(marketDownloadTimeoutMs(0)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS);
  });

  it('体积段线性：1 MiB +1s、10 MiB +10s（向上取整，不满 1 MiB 也按 1 MiB 计）', () => {
    expect(marketDownloadTimeoutMs(1024 * 1024)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS + 1_000);
    expect(marketDownloadTimeoutMs(10 * 1024 * 1024)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS + 10_000);
    expect(marketDownloadTimeoutMs(1)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS + MARKET_DOWNLOAD_TIMEOUT_MS_PER_MIB);
  });

  it('契约上限（128 MiB）落在 188s：慢网 1 MB/s 走完只要 ~128s，留得下余量', () => {
    expect(marketDownloadTimeoutMs(MARKET_MAX_UNPACKED_BYTES)).toBe(188_000);
  });

  it('形状护栏：非有限 / 非正数都回基础段（不 NaN、不发散）', () => {
    expect(marketDownloadTimeoutMs(-5)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS);
    expect(marketDownloadTimeoutMs(Number.NaN)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS);
    expect(marketDownloadTimeoutMs(Number.POSITIVE_INFINITY)).toBe(MARKET_DOWNLOAD_TIMEOUT_BASE_MS);
  });
});
