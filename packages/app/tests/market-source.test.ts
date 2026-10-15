import { describe, expect, it } from 'vitest';
import {
  MARKET_DEFAULT_INDEX_URL,
  MarketError,
  type MarketService,
} from '@kojo/plugin-api';
import {
  applyEndpointEdit,
  isOverridden,
  NO_SERVICE_VIEW,
  planEndpointEdit,
} from '../src/ui/market-source';

/**
 * 设置页那一行的全部判定（零 React）。钉死的口径：
 * - **端点真源只住 `market` 服务**（`endpoint()` / `setEndpoint()`），壳不抄第二份；
 * - 「留空」= 撤销覆盖（回到契约默认值），**不是**"存一个空地址"；
 * - 与生效值一致 ⇒ 一次写都不发（不发"改好了"的假回执）；
 * - 形态闸只管"一看就打不开"的输入：主机白名单在平台侧，这里再写一份就是第二份真相。
 */

function fakeMarket(initial = MARKET_DEFAULT_INDEX_URL): { market: MarketService; writes: string[] } {
  let effective = initial;
  const writes: string[] = [];
  const market = {
    async endpoint() {
      return effective;
    },
    async setEndpoint(url: string) {
      writes.push(url);
      if (url.trim() === '') {
        effective = MARKET_DEFAULT_INDEX_URL;
        return;
      }
      const problem: string | null = /^https:\/\//.test(url) ? null : '协议必须是 https';
      if (problem !== null) throw new MarketError('endpoint-invalid', `注册表地址不合法：${problem}`, url);
      effective = url;
    },
  } as unknown as MarketService;
  return { market, writes };
}

describe('注册表来源（设置页那一行）', () => {
  it('planEndpointEdit 四分支互斥：同值 keep、空串 reset、非法 invalid、其余 set', () => {
    expect(planEndpointEdit(MARKET_DEFAULT_INDEX_URL, MARKET_DEFAULT_INDEX_URL)).toEqual({ kind: 'keep' });
    expect(planEndpointEdit('   ', MARKET_DEFAULT_INDEX_URL)).toEqual({ kind: 'reset' });
    expect(planEndpointEdit('http://mirror/i.json', MARKET_DEFAULT_INDEX_URL).kind).toBe('invalid');
    expect(planEndpointEdit('not a url', MARKET_DEFAULT_INDEX_URL).kind).toBe('invalid');
    expect(planEndpointEdit('https://user@mirror/i.json', MARKET_DEFAULT_INDEX_URL).kind).toBe('invalid');
    expect(planEndpointEdit(' https://mirror.example/i.json ', MARKET_DEFAULT_INDEX_URL)).toEqual({
      kind: 'set',
      url: 'https://mirror.example/i.json',
    });
  });

  it('保存同值 ⇒ 一个写都不发；非法 ⇒ 原值不动 + 一句人话（不静默吞掉）', async () => {
    const { market, writes } = fakeMarket();
    let v = await applyEndpointEdit(market, MARKET_DEFAULT_INDEX_URL);
    expect(v.note).toBe('没有改动');
    expect(writes).toEqual([]);
    expect(v.effective).toBe(MARKET_DEFAULT_INDEX_URL);

    v = await applyEndpointEdit(market, 'http://mirror/i.json');
    expect(v.note).toContain('没有保存');
    expect(v.note).toContain('协议');
    expect(writes).toEqual([]);
    expect(v.effective).toBe(MARKET_DEFAULT_INDEX_URL);
  });

  it('覆盖 → 自建地址；留空 → 回默认；两者都只经由服务的 endpoint()（壳里没有第二份存储）', async () => {
    const { market, writes } = fakeMarket();
    const mirror = 'https://mirror.example.test/kojo/index.json';
    let v = await applyEndpointEdit(market, mirror);
    expect(writes).toEqual([mirror]);
    expect(v.effective).toBe(mirror);
    expect(v.overridden).toBe(true);
    expect(v.note).toContain('自建地址');

    v = await applyEndpointEdit(market, '');
    expect(writes).toEqual([mirror, '']);
    expect(v.effective).toBe(MARKET_DEFAULT_INDEX_URL);
    expect(v.overridden).toBe(false);
    expect(v.note).toContain('默认注册表地址');
  });

  it('服务拒的写（MarketError 之外的崩）也只给一句人话，不把异常抛给壳', async () => {
    const broken = {
      endpoint: async () => MARKET_DEFAULT_INDEX_URL,
      setEndpoint: async () => {
        throw new Error('存储域写不动');
      },
    } as unknown as MarketService;
    const v = await applyEndpointEdit(broken, 'https://mirror.example.test/i.json');
    expect(v.note).toContain('没有保存');
    expect(v.note).toContain('存储域写不动');
  });

  it('服务缺席 ⇒ NO_SERVICE_VIEW（一句实话，不是能编辑的输入框）', () => {
    expect(NO_SERVICE_VIEW.effective).toBe('');
    expect(NO_SERVICE_VIEW.overridden).toBe(false);
    expect(NO_SERVICE_VIEW.note).toContain('市场服务没装配');
    expect(isOverridden(MARKET_DEFAULT_INDEX_URL)).toBe(false);
    expect(isOverridden('https://mirror.example.test/i.json')).toBe(true);
  });

  it('这一行只有一个可编辑项：模块里没有任何 proxy 标识符（代理只走进程环境）', async () => {
    const src = await import('node:fs/promises').then((m) =>
      m.readFile(new URL('../src/ui/market-source.ts', import.meta.url), 'utf8'),
    );
    // JS 递得进去的代理 = 白名单作废（能对白名单 URL 回任意字节、还能转去内网）⇒ 命令面与设置面都不许出现它
    expect(src.toLowerCase()).not.toContain('proxy');
  });
});
