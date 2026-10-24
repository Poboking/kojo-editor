import { describe, expect, it } from 'vitest';
import { acceptReread, attachMarketInvalidation, createRevalidator } from '../src/reconcile';
import { snapshotWithoutInstalled, type MarketSnapshot } from '../src/actions';
import { type InstalledPack, type MarketService } from '@kojo/plugin-api';

/**
 * MK-1 的**失效接线**判据（假桥，全程不靠 `sleep`、不靠定时器）。
 *
 * 看板要的形状：装/卸成功 ⇒ **事件驱动的失效** + **单飞重取**。两半各自钉死：
 * 1. **触发点**：服务一出声，重取当场开始（`fire()` 之后还没让出微任务就能读到 `started() === 1`
 *    ⇒ "接上了"这件事不需要等盘、不需要猜时长）；
 * 2. **单飞**：连点若干次 ⇒ 任意时刻至多一趟在跑、趟数**可数**（合并成立）、
 *    每一次请求都由"它之后开始的那一趟"兑现（在途那趟早于本次改动开始，不许拿它回答新问题）；
 * 3. **落屏判据**：`acceptReread` 那两条（被顶掉的旧读数不落屏；读失败不清屏上那份事实）。
 *
 * 全部用**手动了结的假读**驱动 ⇒ 判据里没有任何时间猜测，测试也不会因机器慢而红。
 */

/** 通知的形状从契约的订阅面反推（契约那个具名类型没进出口清单，本测试也不复制字段表） */
type InstalledChange = Parameters<Parameters<MarketService['onInstalledChanged']>[0]>[0];

/** 假桥：只实现订阅面；通知由测试自己 `fire()`（真实出声时机在 kojo-market 的 `installed-notify.test.ts` 钉） */
function fakeMarket(): { market: Pick<MarketService, 'onInstalledChanged'>; fire: () => void; size: () => number } {
  const subs: Array<(change: InstalledChange) => void> = [];
  return {
    market: {
      onInstalledChanged(listener: (change: InstalledChange) => void) {
        subs.push(listener);
        return (): void => {
          const i = subs.indexOf(listener);
          if (i >= 0) subs.splice(i, 1);
        };
      },
    },
    fire: () => {
      for (const l of [...subs]) {
        l({ change: 'installed', kind: 'kojo-pack', id: 'demo', version: '1.0.0' } as InstalledChange);
      }
    },
    size: () => subs.length,
  };
}

/** 一趟可控的重读：`started()` 数开始了几趟，`settle()` 了结最早那趟（串行 ⇒ 就是完成顺序） */
function controllableRead(make: (pass: number) => MarketSnapshot) {
  const gates: Array<{ pass: number; resolve: (s: MarketSnapshot) => void; reject: (e: unknown) => void }> = [];
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    started: () => started,
    inFlight: () => inFlight,
    maxInFlight: () => maxInFlight,
    read: (): Promise<MarketSnapshot> => {
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const pass = started;
      return new Promise<MarketSnapshot>((resolve, reject) => {
        gates.push({
          pass,
          resolve: (s) => {
            inFlight -= 1;
            resolve(s);
          },
          reject: (e) => {
            inFlight -= 1;
            reject(e);
          },
        });
      });
    },
    settle: (): number => {
      const g = gates.shift()!;
      g.resolve(make(g.pass));
      return g.pass;
    },
    settleWithError: (err: unknown): number => {
      const g = gates.shift()!;
      g.reject(err);
      return g.pass;
    },
  };
}

const snapOf = (
  installed: InstalledPack[],
  status: MarketSnapshot['status'] = 'ready',
): MarketSnapshot => ({
  status,
  packs: [],
  installed,
  installedBytes: 0,
  dropped: [],
  coverIgnored: [],
  reason: '',
  fetchedAt: null,
  generatedAt: null,
  endpoint: '',
  pullNote: '',
});

const rec = (id: string): InstalledPack => ({
  kind: 'kojo-pack',
  id,
  version: '1.0.0',
  name: id,
  author: 'someone',
  license: 'CC-BY-NC 4.0',
  contentDigest: '0'.repeat(64),
  installedAt: 1,
  files: [],
});

/** 让微任务链走完（不用定时器等盘） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('单飞重取（createRevalidator）', () => {
  it('没有在途趟 ⇒ 一次请求恰好开一趟，结果兑给请求方', async () => {
    const read = controllableRead((p) => snapOf([rec(`pass-${p}`)]));
    const r = createRevalidator(read.read);
    const got = r.revalidate();
    expect(r.started()).toBe(1);
    expect(r.inflight()).toBe(1);
    expect(read.started()).toBe(1);
    read.settle();
    expect((await got).installed[0]!.id).toBe('pass-1');
    expect(r.inflight()).toBe(0);
    expect(r.completed()).toBe(1);
    expect(r.queued()).toBe(0);
  });

  it('在途期间到的请求 ⇒ 不并发第二趟，且由**下一趟**兑现（在途那趟开始得比这次改动早）', async () => {
    const read = controllableRead((p) => snapOf([rec(`pass-${p}`)]));
    const r = createRevalidator(read.read);
    const first = r.revalidate();
    expect(r.started()).toBe(1);
    const second = r.revalidate();
    expect(r.started()).toBe(1); // 并发第二趟 = 直接红
    expect(r.queued()).toBe(2);
    read.settle(); // 了结 #1
    expect((await first).installed[0]!.id).toBe('pass-1');
    await flush();
    expect(r.started()).toBe(2); // #1 一结束就自动补 #2（仍然串行）
    read.settle(); // 了结 #2
    expect((await second).installed[0]!.id).toBe('pass-2');
    expect(read.maxInFlight()).toBe(1);
  });

  it('在途那趟之后连来四张票 ⇒ 四张**合并成一趟**（不是四趟排队；五张票两趟跑完）', async () => {
    const read = controllableRead((p) => snapOf([rec(`pass-${p}`)]));
    const r = createRevalidator(read.read);
    const first = r.revalidate(); // 这张票开出趟 #1
    const rest = [r.revalidate(), r.revalidate(), r.revalidate(), r.revalidate()];
    expect(r.started()).toBe(1); // 其余四张都排在"#1 之后开始的那趟"上 ⇒ 不开第二趟
    read.settle();
    expect((await first).installed[0]!.id).toBe('pass-1');
    await flush();
    expect(r.started()).toBe(2); // 四张票合起来只补**一趟**
    read.settle();
    const snaps = await Promise.all(rest);
    expect(read.started()).toBe(2);
    expect(read.maxInFlight()).toBe(1);
    expect(new Set(snaps.map((s) => s.installed[0]!.id))).toEqual(new Set(['pass-2']));
  });

  it('读失败 ⇒ 只兑掉它自己那一趟的票（不重试、不装成功）；排在后面的票由补开的那趟兑现', async () => {
    const read = controllableRead((p) => snapOf([rec(`pass-${p}`)]));
    const r = createRevalidator(read.read);
    const a = r.revalidate();
    const b = r.revalidate(); // 这张要的是 #2
    read.settleWithError(new Error('盘读不动'));
    await expect(a).rejects.toThrow('盘读不动');
    expect(r.completed()).toBe(0);
    await flush();
    expect(r.started()).toBe(2); // 剩下的票自动补一趟（仍串行、仍不是"拿失败当成功"）
    read.settle();
    expect((await b).installed[0]!.id).toBe('pass-2');
  });
});

describe('失效接线（attachMarketInvalidation：服务通知 ⇒ 单飞重取 ⇒ 落屏）', () => {
  const wire = (): {
    handle: ReturnType<typeof attachMarketInvalidation>;
    read: ReturnType<typeof controllableRead>;
    landed: MarketSnapshot[];
    errors: unknown[];
    fire: () => void;
    size: () => number;
  } => {
    const bridge = fakeMarket();
    const read = controllableRead((p) => snapOf([rec(`pass-${p}`)]));
    const landed: MarketSnapshot[] = [];
    const errors: unknown[] = [];
    const handle = attachMarketInvalidation({
      market: bridge.market,
      read: read.read,
      onSnapshot: (snap) => landed.push(snap),
      onError: (err) => errors.push(err),
    });
    return { handle, read, landed, errors, fire: bridge.fire, size: bridge.size };
  };

  it('服务一出声就当场开一趟（**没有定时器**：还没让出微任务时 started 已经是 1）', () => {
    const w = wire();
    expect(w.handle.started()).toBe(0);
    w.fire();
    expect(w.handle.started()).toBe(1);
    expect(w.read.started()).toBe(1);
  });

  it('连出四声 ⇒ 至多一趟在跑；四声都兑现，落屏顺序 = 趟序（新读数不可能被旧的盖回去）', async () => {
    const w = wire();
    w.fire();
    w.fire();
    w.fire();
    w.fire();
    expect(w.handle.inflight()).toBe(1);
    expect(w.handle.started()).toBe(1);
    for (let i = 0; i < 12; i++) {
      if (w.read.inFlight() > 0) w.read.settle();
      await flush();
      if (w.handle.inflight() === 0 && w.read.inFlight() === 0) break;
    }
    expect(w.handle.inflight()).toBe(0);
    expect(w.read.maxInFlight()).toBe(1);
    expect(w.read.started()).toBeLessThanOrEqual(4);
    expect(w.landed.length).toBeGreaterThan(0);
    const nums = w.landed.map((s) => Number(s.installed[0]!.id.split('-')[1]));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('退订 ⇒ 通知不再驱动重取（订阅面真的摘掉了）；把手自己仍可主动重取', async () => {
    const w = wire();
    expect(w.size()).toBe(1);
    w.handle.dispose();
    expect(w.size()).toBe(0);
    w.fire();
    expect(w.handle.started()).toBe(0);
    const p = w.handle.revalidate();
    expect(w.handle.started()).toBe(1);
    w.read.settle();
    expect((await p).installed[0]!.id).toBe('pass-1');
  });

  it('落屏点只有一个 ⇒ 主动重取（装卸失败后"核一次盘上到底成了什么样子"）也落屏，且一趟只落一次', async () => {
    const w = wire();
    const p = w.handle.revalidate();
    expect(w.handle.started()).toBe(1);
    w.read.settle();
    const snap = await p;
    // 只落一次：读里落一次 + `onSnapshot` 再落一次 = 两本账（面板的乐观更新会被重复盖一遍）
    expect(w.landed).toHaveLength(1);
    expect(w.landed[0]).toBe(snap);
  });

  it('通知驱动的那一趟同样只落一次', async () => {
    const w = wire();
    w.fire();
    w.read.settle();
    await flush();
    expect(w.landed).toHaveLength(1);
  });

  it('重读炸了 ⇒ 走 `onError` 出声，不静默、不落屏', async () => {
    const w = wire();
    w.fire();
    w.read.settleWithError(new Error('ipc gone'));
    await flush();
    expect(w.errors).toHaveLength(1);
    expect(w.landed).toEqual([]);
  });
});

describe('acceptReread（重取结果落屏的唯一判据）', () => {
  it('被更新一手顶掉的旧读数不落屏', () => {
    expect(acceptReread({ stale: true, status: 'ready' })).toBe(false);
  });

  it('"读"本身失败不落屏（不拿空白换掉屏上那份事实）；其余显式态都落屏', () => {
    expect(acceptReread({ stale: false, status: 'list-unreadable' })).toBe(false);
    expect(acceptReread({ stale: false, status: 'ready' })).toBe(true);
    expect(acceptReread({ stale: false, status: 'list-missing' })).toBe(true);
  });
});

describe('乐观先行与服务真相的接缝', () => {
  it('乐观扣掉的那条，重读回来也没有 ⇒ 两本账对平（假桥自证，不靠 sleep）', async () => {
    const installed = [rec('a'), rec('b')];
    const optimistic = snapshotWithoutInstalled(snapOf(installed), installed[1]!);
    expect(optimistic.installed.map((r) => r.id)).toEqual(['a']);
    const read = controllableRead(() => snapOf([rec('a')]));
    const r = createRevalidator(read.read);
    const got = r.revalidate();
    read.settle();
    const authoritative = await got;
    expect(authoritative.installed.map((x) => x.id)).toEqual(optimistic.installed.map((x) => x.id));
  });
});
