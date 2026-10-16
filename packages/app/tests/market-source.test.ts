import { describe, expect, it } from 'vitest';
import {
  MARKET_DEFAULT_INDEX_URL,
  MarketError,
  type MarketService,
} from '@kojo/plugin-api';
import {
  applyEndpointEdit,
  classifyNote,
  hintClassFor,
  isDraftNoop,
  isOverridden,
  NO_SERVICE_VIEW,
  planEndpointEdit,
  resetEndpoint,
  sourceRowUi,
  type MarketSourceView,
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

const MIRROR = 'https://mirror.example.test/kojo/index.json';

describe('设置页那一行的显示口径（生效地址显式化 / 保存可点性 / 回执三态）', () => {
  it('isDraftNoop：与生效值逐字相同或"空草稿 + 本来就用默认" ⇒ 不给保存机会', () => {
    expect(isDraftNoop('', MARKET_DEFAULT_INDEX_URL)).toBe(true);
    expect(isDraftNoop('  ', MARKET_DEFAULT_INDEX_URL)).toBe(true);
    expect(isDraftNoop(MARKET_DEFAULT_INDEX_URL, MARKET_DEFAULT_INDEX_URL)).toBe(true);
    expect(isDraftNoop(MIRROR, MIRROR)).toBe(true);
    expect(isDraftNoop(`  ${MIRROR}  `, MIRROR)).toBe(true);
    // 覆盖态下的空草稿 = 撤销覆盖（一次真改动），不是"没动"
    expect(isDraftNoop('', MIRROR)).toBe(false);
    expect(isDraftNoop('https://other.example.test/i.json', MARKET_DEFAULT_INDEX_URL)).toBe(false);
  });

  it('classifyNote 三态互斥：成功=ok、失败=err、无改动与读取中=dim（判据只住这一处）', () => {
    expect(classifyNote('')).toBe('dim');
    expect(classifyNote('没有改动')).toBe('dim');
    expect(classifyNote('已改用自建地址（仅放行 GitHub 系主机；下次打开市场面板生效）')).toBe('ok');
    expect(classifyNote('已恢复默认注册表地址（下次打开市场面板生效）')).toBe('ok');
    expect(classifyNote('没有保存：协议必须是 https')).toBe('err');
    expect(classifyNote(NO_SERVICE_VIEW.note)).toBe('err');
    expect(classifyNote('注册表地址读不出来')).toBe('err');
    expect(classifyNote('存储域写不动')).toBe('dim');
  });

  it('hintClassFor：三态只映射到设置页既有类名（不造新样式）', () => {
    expect(hintClassFor('ok')).toBe('settings-hint is-ok');
    expect(hintClassFor('err')).toBe('settings-hint is-err');
    expect(hintClassFor('dim')).toBe('settings-hint');
  });

  it('sourceRowUi 读取中 ⇒ 不给"能改"的错觉，也不显示地址', () => {
    const row = sourceRowUi(null);
    expect(row).toEqual({
      loading: true,
      canEdit: false,
      showReset: false,
      statusText: '正在读取当前用的地址…',
      statusTone: 'dim',
      address: '',
      note: '',
      noteTone: 'dim',
    });
  });

  it('sourceRowUi 服务缺席 ⇒ 一句实话 + err 着色；输入框与按钮都不可操作', () => {
    const row = sourceRowUi(NO_SERVICE_VIEW);
    expect(row.canEdit).toBe(false);
    expect(row.showReset).toBe(false);
    expect(row.address).toBe('');
    expect(row.statusText).toContain('市场服务没装配');
    expect(row.statusTone).toBe('err');
    expect(hintClassFor(row.statusTone)).toBe('settings-hint is-err');
  });

  it('sourceRowUi 默认态 ⇒ 显式显示契约常量本身（不是将就在占位符里），且不出现恢复默认', () => {
    const row = sourceRowUi({ effective: MARKET_DEFAULT_INDEX_URL, overridden: false, note: '' });
    expect(row.canEdit).toBe(true);
    expect(row.showReset).toBe(false);
    expect(row.address).toBe(MARKET_DEFAULT_INDEX_URL);
    expect(row.statusText).toBe('当前用的是默认地址');
  });

  it('sourceRowUi 覆盖态 ⇒ 摊开自建地址本身 + 给出恢复默认入口', () => {
    const row = sourceRowUi({ effective: MIRROR, overridden: true, note: '已改用自建地址（仅放行 GitHub 系主机；下次打开市场面板生效）' });
    expect(row.canEdit).toBe(true);
    expect(row.showReset).toBe(true);
    expect(row.address).toBe(MIRROR);
    expect(row.statusText).toBe('当前用的是自建地址');
    expect(row.noteTone).toBe('ok');
  });

  it('sourceRowUi 读不出来（有视图但地址为空）⇒ 与缺席同档：不可编辑、err、无假读数', () => {
    const view: MarketSourceView = { effective: '', overridden: false, note: '注册表地址读不出来' };
    const row = sourceRowUi(view);
    expect(row.canEdit).toBe(false);
    expect(row.address).toBe('');
    expect(row.statusText).toBe('注册表地址读不出来');
    expect(row.statusTone).toBe('err');
  });

  it('恢复默认 = 既有 reset 通路（applyEndpointEdit 传空串）：只发一次写、回到契约常量；服务缺席时不假装成功', async () => {
    const { market, writes } = fakeMarket(MIRROR);
    const v = await resetEndpoint(market);
    expect(writes).toEqual(['']);
    expect(v.effective).toBe(MARKET_DEFAULT_INDEX_URL);
    expect(v.overridden).toBe(false);
    expect(classifyNote(v.note)).toBe('ok');

    expect(await resetEndpoint(undefined)).toBe(NO_SERVICE_VIEW);
  });
});
