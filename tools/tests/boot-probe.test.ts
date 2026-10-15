/**
 * L1-0 首屏断言判定层的纯逻辑护栏（不依赖桌面壳、不依赖语料）。
 *
 * 为什么要有它：`tools/smoke-tauri-dom.mjs` / `tools/boot-marks.mjs` 的两条硬断言只能在真桌面壳上
 * 跑，而本机一次会话最多起壳一次——判据本身（深色阈值、≤500ms 三分支、时基口径识别、
 * Network 优先/时间线回退、反空匹配自证）必须能在**不起壳**的情况下被复跑钉住，
 * 否则改一次口径就要烧一次桌面预算。
 *
 * 另外锁两件最容易出事的事：
 * - 匹配面**不许**命中本仓自己的 `src/monaco/*.ts`（`reveal-position.ts` 常年挂在 boot 图上，
 *   命中就是假红，实测踩过）；
 * - 页内采样函数里的正则必须与导出的 `MONACO_HINT_RE` 逐字一致（页内那份不能用 import，
 *   两处漂了就等于两条口径）。
 */
import { describe, expect, it } from 'vitest';
import {
  MONACO_HINT_RE,
  ROOT_SAMPLE_GRACE_MS,
  assignRelTimes,
  bootMarkLines,
  collectBoot,
  detectRelMode,
  isDark,
  judgeBoot,
  judgeNetwork,
  parseRgb,
  relTimeOf,
  resolveA2,
  urlKey,
} from '../boot-probe.mjs';

/** `collectBoot()` 页内读数的最小可用形状（其余字段按用例覆盖） */
const sample = (over: Record<string, unknown> = {}) =>
  ({
    marks: { htmlParsed: 120, bgAtParse: 'rgb(30, 34, 39)', t500: { at: 502, rootChildren: 0, bg: 'rgb(30, 34, 39)', splash: true } },
    boot: { 'boot.welcomeInteractive': { last: 6900, note: '' } },
    welcome: 6900,
    bgNow: 'rgb(30, 34, 39)',
    splashGone: true,
    timeOrigin: 1_760_000_000_000,
    resourceCount: 40,
    beforeCount: 12,
    monacoBeforeCount: 0,
    monacoBefore: [],
    monacoTotalCount: 3,
    monacoTotalSample: [],
    ...over,
  }) as never;

describe('断言①：≤500ms 内非白 + 底色一致钉 + 引导层退场', () => {
  it('parse 期即深色且挂载后底色一致 → 过', () => {
    const j = judgeBoot(sample());
    expect(j.a1).toBe(true);
    expect(j.earlyDark).toBe(true);
    expect(j.pinOk).toBe(true);
    expect(j.splashGone).toBe(true);
  });

  it('内联底色与挂载后计算底色漂移 → 红（防第二真相源）', () => {
    const j = judgeBoot(sample({ bgNow: 'rgb(255, 255, 255)' }));
    expect(j.pinOk).toBe(false);
    expect(j.a1).toBe(false);
  });

  it('parse 期超过 500ms 时改由「t+500ms 内 #root 非空」兜底', () => {
    const j = judgeBoot(
      sample({
        marks: {
          htmlParsed: 900,
          bgAtParse: 'rgb(30, 34, 39)',
          t500: { at: ROOT_SAMPLE_GRACE_MS, rootChildren: 1, bg: 'rgb(30, 34, 39)', splash: false },
        },
      }),
    );
    expect(j.earlyDark).toBe(false);
    expect(j.earlyRoot).toBe(true);
    expect(j.a1).toBe(true);
  });

  it('t+500ms 采样晚于容差或 #root 仍空 → 两支皆不成立', () => {
    const late = judgeBoot(
      sample({ marks: { htmlParsed: 900, bgAtParse: 'rgb(30, 34, 39)', t500: { at: 4000, rootChildren: 3 } } }),
    );
    expect(late.earlyRoot).toBe(false);
    expect(late.a1).toBe(false);
    const empty = judgeBoot(
      sample({ marks: { htmlParsed: 900, bgAtParse: 'rgb(30, 34, 39)', t500: { at: 505, rootChildren: 0 } } }),
    );
    expect(empty.earlyRoot).toBe(false);
  });

  it('引导层没撤 → splashGone 红（与 a1 分开数，红要红在真原因上）', () => {
    const j = judgeBoot(sample({ splashGone: false }));
    expect(j.a1).toBe(true);
    expect(j.splashGone).toBe(false);
  });

  it('深色阈值：#1e2227 深、白不深、近全透明不算有底色', () => {
    expect(isDark('rgb(30, 34, 39)')).toBe(true);
    expect(isDark('rgb(255, 255, 255)')).toBe(false);
    expect(isDark('rgba(30, 34, 39, 0.2)')).toBe(false);
    expect(isDark('transparent')).toBe(false);
    expect(parseRgb('nope')).toBeNull();
  });
});

describe('断言②：可点前不得有 monaco（匹配面 + 反空匹配自证）', () => {
  it('命中 monaco-editor 模块 / ProjectView 懒 chunk / editor.worker', () => {
    expect(MONACO_HINT_RE.test('/node_modules/.pnpm/monaco-editor@0.57.0/node_modules/monaco-editor/esm/vs/editor/editor.api.js')).toBe(true);
    expect(MONACO_HINT_RE.test('/assets/ProjectView-D-vNVuWv.js')).toBe(true);
    expect(MONACO_HINT_RE.test('/src/ui/EditorPane.tsx')).toBe(true);
    expect(MONACO_HINT_RE.test('/assets/editor.worker.js')).toBe(true);
  });

  it('不许命中本仓自己的 src/monaco/*.ts（boot 图上常年有它，命中即假红）', () => {
    expect(MONACO_HINT_RE.test('/src/monaco/reveal-position.ts')).toBe(false);
    expect(MONACO_HINT_RE.test('/assets/reveal-position-Cq1_aaaB.js')).toBe(false);
  });

  it('采样函数里的正则与导出正则逐字一致（页内那份不能用 import）', () => {
    expect(collectBoot.toString()).toContain(String(MONACO_HINT_RE));
  });

  it('时间线回退口径：可点前零 monaco 且整轮见得到 monaco 才算过', () => {
    expect(judgeBoot(sample()).a2Timeline).toBe(true);
    expect(judgeBoot(sample({ monacoBeforeCount: 2, monacoBefore: ['x'] })).a2Timeline).toBe(false);
    // 整轮一条 monaco 都没有 = 缓冲被截断/匹配面可疑，不许判绿
    expect(judgeBoot(sample({ monacoTotalCount: 0, monacoTotalSample: [] })).a2Timeline).toBe(false);
    expect(judgeBoot(sample({ welcome: null })).a2Timeline).toBe(false);
  });
});

describe('Network 域取证：时基口径与判定', () => {
  const timeOrigin = 1_760_000_000_000;

  it('三种时基语义各自识别，认不出返回 null', () => {
    expect(detectRelMode([12.5, 900, 6800], timeOrigin)).toBe('relativeToTimeOrigin');
    expect(detectRelMode([timeOrigin + 12, timeOrigin + 900], timeOrigin)).toBe('epochMs');
    expect(detectRelMode([timeOrigin / 1000 + 0.012, timeOrigin / 1000 + 0.9], timeOrigin)).toBe('epochSeconds');
    expect(detectRelMode([], timeOrigin)).toBeNull();
    expect(detectRelMode([1e15], timeOrigin)).toBeNull();
    expect(detectRelMode([12, 900], Number.NaN)).toBeNull();
  });

  it('换算回「自导航起点 ms」', () => {
    expect(relTimeOf(900, 'relativeToTimeOrigin', timeOrigin)).toBe(900);
    expect(relTimeOf(timeOrigin + 900, 'epochMs', timeOrigin)).toBe(900);
    expect(relTimeOf(900, 'epochMs', timeOrigin)).toBeLessThan(0);
    expect(relTimeOf(900, null, timeOrigin)).toBeNull();
  });

  const cap = (over: Record<string, unknown> = {}) =>
    ({
      ok: true,
      anchored: true,
      basis: 'timeline-fit',
      overlap: 31,
      offset: 0,
      anchor: '本轮 Document 请求时刻',
      mode: 'relativeToTimeOrigin',
      welcome: 6900,
      total: 1420,
      beforeCount: 195,
      monacoBeforeCount: 0,
      monacoTotalCount: 9,
      ...over,
    }) as never;

  it('可点前零 monaco 且整轮有 monaco → pass', () => {
    expect(judgeNetwork(cap()).verdict).toBe('pass');
  });
  it('可点前出现 monaco → fail', () => {
    expect(judgeNetwork(cap({ monacoBeforeCount: 137, monacoBefore: ['a'] })).verdict).toBe('fail');
  });
  it('整轮零 monaco（匹配面可疑）→ unproven，不算绿', () => {
    expect(judgeNetwork(cap({ monacoTotalCount: 0 })).verdict).toBe('unproven');
  });
  it('可点前一条请求都没切到 → unavailable（恒真即假绿，实测踩过）', () => {
    const r = judgeNetwork(cap({ beforeCount: 0 }));
    expect(r.verdict).toBe('unavailable');
    expect(r.reason).toContain('0 条请求');
  });
  it('本轮导航锚点没拿到 → unavailable，不猜 CDP 绝对时基', () => {
    expect(judgeNetwork(cap({ anchored: false })).verdict).toBe('unavailable');
  });
  it('采不到 → unavailable（调用方须退回时间线并标注）', () => {
    expect(judgeNetwork({ ok: false, reason: '端口没起来' } as never).verdict).toBe('unavailable');
    expect(judgeNetwork(null).verdict).toBe('unavailable');
    expect(judgeNetwork(cap({ welcome: undefined })).verdict).toBe('unavailable');
  });

  it('resolveA2：Network 优先；取不到才用时间线，且口径名写进结论', () => {
    const net = resolveA2(cap(), sample(), judgeBoot(sample()));
    expect(net.ok).toBe(true);
    expect(net.used).toContain('Network');

    const fallback = resolveA2({ ok: false, reason: 'CDP 没连上' } as never, sample(), judgeBoot(sample()));
    expect(fallback.ok).toBe(true);
    expect(fallback.used).toContain('时间线');
    expect(fallback.reason).toContain('monaco');

    // 恒真的 Network 读数（可点前 0 条）不许顶掉时间线口径：退回并如实标注
    const vacuous = resolveA2(cap({ beforeCount: 0 }), sample(), judgeBoot(sample()));
    expect(vacuous.used).toContain('时间线');
    expect(vacuous.ok).toBe(true);

    // 两条口径同时失效才红
    const bad = sample({ monacoBeforeCount: 4, monacoBefore: ['x'], monacoTotalCount: 4 });
    expect(resolveA2({ ok: false, reason: 'CDP 没连上' } as never, bad, judgeBoot(bad)).ok).toBe(false);
  });
});

describe('时基校准：把 Network 事件折到页内时间轴（断言②的刀口）', () => {
  const TIME_ORIGIN = 1_760_000_000_000;

  const rels = (r: { items: { rel: number | null }[] }) => r.items.map((i) => i.rel);

  it('交集够（≥5 条）时用页内时间线拟合偏移，切点落在页内钟上', () => {
    // 故意让 CDP 锚点比页内钟晚 300ms：ts = 锚点 + 页内 startTime + 300
    const page = [
      ['http://tauri.localhost/assets/core-x.js', 4],
      ['http://tauri.localhost/assets/app-x.js', 20],
      ['http://tauri.localhost/assets/ui-x.js', 55],
      ['http://tauri.localhost/assets/plugin-x.js', 90],
      ['http://tauri.localhost/assets/ProjectView-D.js?v=abc', 7_400],
    ];
    const events = page.map(([u, start]) => ({ url: u, ts: 1000 + start + 300 }));
    const r = assignRelTimes(events, page, 1000, TIME_ORIGIN);
    expect(r.basis).toBe('timeline-fit');
    expect(r.overlap).toBe(5);
    expect(r.offset).toBe(-300);
    expect(r.spread).toBe(0);
    expect(rels(r)).toEqual([4, 20, 55, 90, 7400]);
    // 关键读数：ProjectView 在页内钟 7400ms，可点 6900ms 之后 → 不该被判进「可点前」
    expect(r.items[4].rel as number).toBeGreaterThan(6900);
  });

  it('时间线里有的那条一律用页内原值，不被拟合偏移带偏（断言②的刀口就靠这条）', () => {
    // 拟合出来的相对时刻比页内原值早 200ms：若用拟合值，ProjectView 会被错判进「可点前」
    const tl = [
      ['http://h/a.js', 10],
      ['http://h/b.js', 20],
      ['http://h/c.js', 30],
      ['http://h/d.js', 40],
      ['http://h/e.js', 50],
      ['http://h/ProjectView-x.js', 260], // 可点 250 之后
    ];
    const events = [
      { url: 'http://h/a.js', ts: 2010 },
      { url: 'http://h/b.js', ts: 2020 },
      { url: 'http://h/c.js', ts: 2030 },
      { url: 'http://h/d.js', ts: 2040 },
      { url: 'http://h/e.js', ts: 2050 },
      { url: 'http://h/ProjectView-x.js', ts: 2060 }, // 拟合值 = 60（错），页内原值 = 260（对）
    ];
    const r = assignRelTimes(events, tl, 1000, TIME_ORIGIN);
    expect(r.basis).toBe('timeline-fit');
    expect(r.offset).toBe(-1000); // 五条一致差 -1000，ProjectView 那条差 -800（中位数不受它勾引）
    expect(r.items[5].rel).toBe(260);
    expect(r.items[5].via).toBe('页内时间线原值');
    expect(r.items[5].rel as number).toBeGreaterThan(250);
    // 时间线里没有的那条（dev 缓冲截断的模块）才走拟合，并且 via 自证来源
    const fitted = assignRelTimes([...events, { url: 'http://h/dropped.js', ts: 2070 }], tl, 1000, TIME_ORIGIN);
    const last = fitted.items[6];
    expect(last.rel).toBe(70);
    expect(String(last.via)).toContain('拟合');
  });

  it('同一 URL 多条时间线取最早那次；查询串写法不同也能对上', () => {
    // 页内钟 = 锚点相对时刻 + 50（常数偏移）；a.js 有两条时间线（150 与 999），必须取 150，
    // 否则偏差离散度就不为 0；b.js 事件带 ?worker、时间线不带，也要能按 pathname 对上。
    const r = assignRelTimes(
      [
        { url: 'http://h/a.js', ts: 2000 },
        { url: 'http://h/b.js?worker', ts: 2100 },
        { url: 'http://h/c.js', ts: 2200 },
        { url: 'http://h/d.js', ts: 2300 },
        { url: 'http://h/e.js', ts: 2400 },
      ],
      [
        ['http://h/a.js', 150],
        ['http://h/a.js', 999], // 重复条目：取最早的 150
        ['http://h/b.js', 250],
        ['http://h/c.js', 350],
        ['http://h/d.js', 450],
        ['http://h/e.js', 550],
      ],
      1900,
      TIME_ORIGIN,
    );
    expect(r.overlap).toBe(5);
    expect(r.offset).toBe(50);
    expect(r.spread).toBe(0); // 取 999 的话这里就是 849
    expect(rels(r)).toEqual([150, 250, 350, 450, 550]);
  });

  it('交集太少但 wallTime 齐 → 退 wallTime − timeOrigin', () => {
    const events = [
      { url: 'http://h/a.js', ts: 5000, wallTime: (TIME_ORIGIN + 120) / 1000 },
      { url: 'http://h/b.js', ts: 5100, wallTime: (TIME_ORIGIN + 200) / 1000 },
    ];
    const r = assignRelTimes(events, [['http://h/a.js', 120]], 5000, TIME_ORIGIN);
    expect(r.basis).toBe('wall-clock');
    expect(rels(r)).toEqual([120, 200]);
    expect(r.items[1].via).toContain('wall-clock');
  });

  it('两者都不可用 → 只按 Document 锚点，并如实标 basis', () => {
    const r = assignRelTimes([{ url: 'http://h/a.js', ts: 5000 }], [], 4800, TIME_ORIGIN);
    expect(r.basis).toBe('document-anchor');
    expect(rels(r)).toEqual([200]);
  });

  it('没锚点 / 没事件 → no-anchor，时间线外的那条 rel=null（判定层据此拒绝判绿）', () => {
    const noAnchor = assignRelTimes([{ url: 'a', ts: 1 }], [], null, TIME_ORIGIN);
    expect(noAnchor.basis).toBe('no-anchor');
    expect(noAnchor.items[0].rel).toBeNull();
    expect(assignRelTimes([], [], 100, TIME_ORIGIN).items).toEqual([]);
    expect(assignRelTimes([{ url: 'a', ts: 1 }], [], Number.NaN, TIME_ORIGIN).basis).toBe('no-anchor');
    // 没锚点但时间线里有 → 仍给页内原值
    expect(assignRelTimes([{ url: 'http://h/a.js', ts: 1 }], [['http://h/a.js', 77]], null, TIME_ORIGIN).items[0].rel).toBe(77);
  });

  it('urlKey：剥查询与哈希，非法 URL 原样去尾', () => {
    expect(urlKey('http://h/a.js?v=1#x')).toBe('/a.js');
    expect(urlKey('/rel/a.js?worker')).toBe('/rel/a.js');
    expect(urlKey('not a url?ts=9')).toBe('not a url');
    expect(urlKey(undefined)).toBe('');
  });
});

describe('四标记读数打印', () => {
  it('四枚都在 → 四行 + 白屏段 Δ', () => {
    const b = sample({
      boot: {
        'boot.htmlParsed': { last: 120, note: 'n1' },
        'boot.firstPaint': { last: 300, note: 'n2' },
        'boot.welcomeInteractive': { last: 6900, note: '' },
        'boot.editorInteractive': { last: 8400, note: '' },
      },
    });
    const lines = bootMarkLines(b as never);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('boot.htmlParsed = 120.0');
    expect(lines[4]).toContain('白屏段 firstPaint − htmlParsed = 180.0ms');
  });

  it('未打开项目 → editorInteractive 记「未记录」而不是 0', () => {
    const lines = bootMarkLines(sample() as never);
    expect(lines.some((l) => l.includes('boot.editorInteractive = 未记录'))).toBe(true);
  });
});
