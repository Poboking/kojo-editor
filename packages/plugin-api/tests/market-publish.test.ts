import { describe, expect, it } from 'vitest';
import {
  MARKET_DEFAULT_INDEX_URL,
  MARKET_DEFAULT_PUBLISH_URL,
  MARKET_MAX_CONTAINER_UPLOAD_BYTES,
  MARKET_MAX_UNPACKED_BYTES,
  marketPublishTimeoutMs,
  type MarketPublishOutcome,
} from '../src/market';

/**
 * 发布通道的**契约面**判据（2026-10-16 发布通道批）。
 *
 * 契约层只有纯函数与常量 ⇒ 判据只有四条：默认端点的形状与"与索引端点互不耦合"；
 * 上传闸（95_000_000 字节，CF 免费档 100,000,000 字节边缘留 5 MB 余量）与解压闸
 * （128 MiB）是**两把尺**；发布超时与下载是**同一份公式**（薄委托——改公式只许改一处）；
 * `verified` 档位是已知字面量的窄联合。请求构造 / 发布闸 / 裁决解析 / 令牌解析的真相在
 * `packages/app/src-tauri/src/market_tests.rs`。
 */
describe('发布契约：端点与上限', () => {
  it('默认发布端点是 https 的市场后端 origin（无尾斜杠、无路径）', () => {
    expect(MARKET_DEFAULT_PUBLISH_URL).toBe('https://market.362573581.xyz');
  });

  it('发布端点与索引端点是两个常量（同一行写漂了不成立——CI 自查各管各的）', () => {
    expect(MARKET_DEFAULT_PUBLISH_URL).not.toBe(MARKET_DEFAULT_INDEX_URL);
  });

  it('上传闸 = 95_000_000 字节（CF 免费档 100,000,000 字节边缘留 5 MB 余量），与解压闸是两把尺', () => {
    expect(MARKET_MAX_CONTAINER_UPLOAD_BYTES).toBe(95_000_000);
    // 上传闸量容器本体、解压闸量解出的内容：不许互相替代，也不许倒挂（容器总比内容小）
    expect(MARKET_MAX_CONTAINER_UPLOAD_BYTES).not.toBe(MARKET_MAX_UNPACKED_BYTES);
    expect(MARKET_MAX_CONTAINER_UPLOAD_BYTES).toBeLessThan(MARKET_MAX_UNPACKED_BYTES);
  });
});

describe('marketPublishTimeoutMs：与下载同一份公式（薄委托）', () => {
  it('逐点对齐 marketDownloadTimeoutMs（零体积 / 1 MiB / 契约上限 / 垃圾输入）', async () => {
    const { marketDownloadTimeoutMs } = await import('../src/market');
    for (const zipBytes of [0, 1, 1024 * 1024, 10 * 1024 * 1024, MARKET_MAX_UNPACKED_BYTES, -5, Number.NaN]) {
      expect(marketPublishTimeoutMs(zipBytes)).toBe(marketDownloadTimeoutMs(zipBytes));
    }
  });

  it('解压上限（128 MiB）落在 188s：慢网直连 ~0.5 MB/s 的预算同样罩得住上行', () => {
    expect(marketPublishTimeoutMs(MARKET_MAX_UNPACKED_BYTES)).toBe(188_000);
  });
});

describe('发布契约：结果判别联的 verified 档位', () => {
  it('ok 分支可携带 structure-only（服务端结构级校验、sha256 归注册表 CI），缺省合法', () => {
    const withVerified: Extract<MarketPublishOutcome, { ok: true }> = {
      ok: true,
      prUrl: 'https://github.com/p/pull/1',
      verified: 'structure-only',
      status: 200,
      finalUrl: `${MARKET_DEFAULT_PUBLISH_URL}/publish`,
    };
    const withoutVerified: Extract<MarketPublishOutcome, { ok: true }> = {
      ok: true,
      prUrl: 'https://github.com/p/pull/1',
      status: 200,
      finalUrl: `${MARKET_DEFAULT_PUBLISH_URL}/publish`,
    };
    expect(withVerified.verified).toBe('structure-only');
    expect(withoutVerified.verified).toBeUndefined();
  });
});
