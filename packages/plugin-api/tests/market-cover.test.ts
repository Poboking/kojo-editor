import { describe, expect, it } from 'vitest';
import {
  MARKET_MAX_COVER_BYTES,
  MARKET_MAX_COVER_URL_CHARS,
  marketCoverProblem,
} from '../src/market';

/**
 * 封面声明的契约闸（批次十一 R3 · additive）——纯函数、零网络、零 IO。
 *
 * 三条口径各钉一档：①协议白名单只有 `https:`（http/data/blob 都拒）；
 * ②长度与字节有上限（url ≤ 2048 字符、bytes ∈ [1, 256 KiB] 的整数）；
 * ③形态不对（不是对象 / 缺字段 / 带账号信息）一律拒，且拒因给人话。
 * "缺字段 = 按现状走占位"由调用侧保证（`cover` 是可选字段，闸只拦"带错了的"）。
 */
describe('marketCoverProblem：封面声明的收录闸', () => {
  it('合法直链放行（https + 正整数体积 + 上限内）', () => {
    expect(marketCoverProblem({ url: 'https://img.example.test/a.png', bytes: 4096 })).toBeNull();
    // 边界值：恰好到顶的字节数放行（超限是下一档的事，不连坐）
    expect(marketCoverProblem({ url: 'https://img.example.test/a.webp', bytes: MARKET_MAX_COVER_BYTES })).toBeNull();
  });

  it('协议白名单只有 https：http / data / blob / file 都拒，且那句点名协议', () => {
    for (const url of [
      'http://img.example.test/a.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'blob:https://img.example.test/uuid-0000',
      'file:///C:/a.png',
    ]) {
      const why = marketCoverProblem({ url, bytes: 10 });
      expect(why, url).not.toBeNull();
      expect(why!, url).toContain('https');
    }
  });

  it('URL 形态闸：不可解析 / 带账号信息 ⇒ 各拒一句，不静默放行', () => {
    expect(marketCoverProblem({ url: 'not a url', bytes: 10 })).toContain('URL');
    expect(marketCoverProblem({ url: 'https://user:pw@img.example.test/a.png', bytes: 10 })).toContain('账号');
    // 空主机名那一支在 https 下**探不到实输入**（WHATWG 规定 special scheme 空主机直接抛
    // `TypeError`，落进"不可解析"那句）——闸仍留着那条只是兜形状，不编一条走不到的用例。
  });

  it('长度上限：url 超 2048 字符即拒（webview / CDN 的公共下界，超了不收）', () => {
    const tooLong = `https://img.example.test/${'x'.repeat(MARKET_MAX_COVER_URL_CHARS)}`;
    expect(tooLong.length).toBeGreaterThan(MARKET_MAX_COVER_URL_CHARS);
    expect(marketCoverProblem({ url: tooLong, bytes: 10 })).toContain('超长');
  });

  it('字节上限与非数形态：0 / 负数 / 小数 / 非数 / 超 256 KiB 都拒', () => {
    const url = 'https://img.example.test/a.png';
    expect(marketCoverProblem({ url, bytes: 0 })).toContain('bytes');
    expect(marketCoverProblem({ url, bytes: -1 })).toContain('bytes');
    expect(marketCoverProblem({ url, bytes: 1.5 })).toContain('bytes');
    expect(marketCoverProblem({ url, bytes: '4096' })).toContain('bytes');
    expect(marketCoverProblem({ url, bytes: Number.NaN })).toContain('bytes');
    expect(marketCoverProblem({ url, bytes: MARKET_MAX_COVER_BYTES + 1 })).toContain('上限');
  });

  it('形状闸：cover 不是对象 / 缺 url ⇒ 拒（字符串直链那种"顺手写法"不收）', () => {
    expect(marketCoverProblem('https://img.example.test/a.png')).toContain('对象');
    expect(marketCoverProblem(null)).toContain('对象');
    expect(marketCoverProblem([{ url: 'https://img.example.test/a.png', bytes: 1 }])).toContain('对象');
    expect(marketCoverProblem({ bytes: 1 })).toContain('url');
    expect(marketCoverProblem({ url: '', bytes: 1 })).toContain('url');
  });
});
