/**
 * Peek 的未打开文件租约（`ui/peek-leases.ts`，用户反馈项 7 的内存半边）单测。
 *
 * 这里钉的是"浏览痕迹不许变成内存泄漏"的三条纪律：
 * ① 同一路径只取一次（并发与重复 peek 都不二读盘），命中即记一次"最近用过"；
 * ② 有界 LRU：超出上限只逐出**比刚这一份更旧**的，且逐出=还给池（不自己 dispose）；
 * ③ 池那边的账不能记错：已经 dispose 的 model 只销账、**绝不 release**（release 会拆掉
 *    别人重新 acquire 上来的引用）；取文失败不留租约，下一次照常重试。
 *
 * 桩 model 只提供本模块用到的两样：`isDisposed()` 与 `uri.toString()`。
 */
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { createPeekLeases, PEEK_LEASE_LIMIT, type PeekLeases } from '../src/ui/peek-leases';

interface FakeModel {
  readonly uri: { toString(): string };
  isDisposed(): boolean;
  dispose(): void;
}

function fakeModel(uriString: string): FakeModel {
  let disposed = false;
  return {
    uri: { toString: () => uriString },
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
    },
  };
}

const asModel = (m: FakeModel): Monaco.editor.ITextModel => m as unknown as Monaco.editor.ITextModel;

interface Harness {
  leases: PeekLeases;
  /** 每次 acquire 的路径（按调用序）——"取了几次盘"就看这条 */
  acquired: string[];
  released: string[];
  warns: string[];
  /** 导演下一次这条路径的取文：返回指定 model，或直接抛 */
  nextResult: (path: string, entry: { model: Monaco.editor.ITextModel } | Error) => void;
  modelOf(path: string): FakeModel;
}

function harness(limit?: number): Harness {
  const acquired: string[] = [];
  const released: string[] = [];
  const warns: string[] = [];
  const models = new Map<string, FakeModel>();
  /** 一次性剧本：下一次这条路径的 acquire 返回什么（用完即弃，模拟"池每次给的是新件"） */
  const scripted = new Map<string, { model: Monaco.editor.ITextModel } | Error>();
  const h: Harness = {
    acquired,
    released,
    warns,
    leases: createPeekLeases({
      acquire: (path) => {
        acquired.push(path);
        const script = scripted.get(path);
        if (script !== undefined) {
          scripted.delete(path);
          if (script instanceof Error) return Promise.reject(script);
          models.set(path, script.model as unknown as FakeModel);
          return Promise.resolve(script);
        }
        // 死件不复用：池那边重新 acquire 上来的是**另一份** model（同一份 dispose 过就作废了）
        const stale = models.get(path);
        const model = stale !== undefined && !stale.isDisposed() ? stale : fakeModel(`file:///${path}`);
        models.set(path, model);
        return Promise.resolve({ model: asModel(model) });
      },
      release: (path) => {
        released.push(path);
      },
      ...(limit === undefined ? {} : { limit }),
      warn: (m) => warns.push(m),
    }),
    nextResult: (path, entry) => {
      scripted.set(path, entry);
    },
    modelOf: (path) => {
      const m = models.get(path);
      if (m !== undefined) return m;
      const fresh = fakeModel(`file:///${path}`);
      models.set(path, fresh);
      return fresh;
    },
  };
  return h;
}

describe('createPeekLeases · 取文与记账', () => {
  it('同一路径重复 peek 只取一次，第二次直接给同一份 model', async () => {
    const h = harness();
    const a = await h.leases.peek('p/a.ERB');
    const b = await h.leases.peek('p/a.ERB');
    expect(a).toBe(b);
    expect(h.acquired).toEqual(['p/a.ERB']);
    expect(h.leases.size()).toBe(1);
  });

  it('并发 peek 同一路径共担一次取文（两个目标落在同一份没打开的文件里是常态）', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.leases.peek('p/a.ERB'), h.leases.peek('p/a.ERB')]);
    expect(a).toBe(b);
    expect(h.acquired).toEqual(['p/a.ERB']);
  });

  it('取文失败 ⇒ undefined、不留租约、下一次重试（不静默也不永久放弃）', async () => {
    const h = harness();
    h.nextResult('p/bad.ERB', new Error('读不到'));
    expect(await h.leases.peek('p/bad.ERB')).toBeUndefined();
    expect(h.leases.size()).toBe(0);
    expect(h.warns.join('')).toContain('取文失败');
    // 换一个桩结果再问：这一次应该真去取（上一轮的失败没被当答案缓存）
    h.nextResult('p/bad.ERB', { model: asModel(fakeModel('file:///ok')) });
    expect(await h.leases.peek('p/bad.ERB')).toBeDefined();
    expect(h.acquired).toEqual(['p/bad.ERB', 'p/bad.ERB']);
  });

  it('取文回来时 model 已被别处 dispose ⇒ 照实说没有，且不挂租约、不 release', async () => {
    const h = harness();
    const dead = fakeModel('file:///dead');
    dead.dispose();
    h.nextResult('p/gone.ERB', { model: asModel(dead) });
    expect(await h.leases.peek('p/gone.ERB')).toBeUndefined();
    expect(h.leases.size()).toBe(0);
    expect(h.released).toEqual([]);
  });

  it('租约里的 model 事后被 dispose ⇒ modelFor 不再给，再 peek 会重取且不 release 死件', async () => {
    const h = harness();
    await h.leases.peek('p/a.ERB');
    h.modelOf('p/a.ERB').dispose();
    expect(h.leases.modelFor('p/a.ERB')).toBeUndefined();
    expect(await h.leases.peek('p/a.ERB')).toBeDefined();
    expect(h.released).toEqual([]); // 死件的账不在池里，一次都不许放
    expect(h.acquired).toEqual(['p/a.ERB', 'p/a.ERB']);
  });

  it('modelFor 绝不触发新的取文（判腿那一趟只问现有租约）', () => {
    const h = harness();
    expect(h.leases.modelFor('p/never.ERB')).toBeUndefined();
    expect(h.acquired).toEqual([]);
  });
});

describe('createPeekLeases · 有界 LRU', () => {
  it('超出上限逐出最旧的那一份，且逐出只是还给池', async () => {
    const h = harness(2);
    await h.leases.peek('p/1');
    await h.leases.peek('p/2');
    await h.leases.peek('p/3');
    expect(h.leases.size()).toBe(2);
    expect(h.released).toEqual(['p/1']);
    expect(h.leases.modelFor('p/1')).toBeUndefined();
    expect(h.warns.join('')).toContain('上限 2');
  });

  it('命中即"最近用过"：被摸过的旧件不该是下一个受害者', async () => {
    const h = harness(2);
    await h.leases.peek('p/1');
    await h.leases.peek('p/2');
    await h.leases.peek('p/1'); // touch：p/1 变最新
    await h.leases.peek('p/3');
    expect(h.released).toEqual(['p/2']);
    expect(h.leases.modelFor('p/1')).toBeDefined();
    expect(h.leases.modelFor('p/3')).toBeDefined();
  });

  it('上限脏输入（0 / 负数 / NaN / 小数）一律回落到缺省，绝不变成"一份都不留"', async () => {
    for (const bad of [0, -3, Number.NaN, 1.7]) {
      const h = harness(bad);
      await h.leases.peek('p/x');
      expect(h.leases.size()).toBe(1);
    }
    const h = harness();
    await h.leases.peek('p/x');
    expect(h.leases.size()).toBe(1);
    expect(PEEK_LEASE_LIMIT).toBeGreaterThan(0);
  });

  it('disposeAll 全数释放且清账（重复调用不重复 release）', async () => {
    const h = harness(4);
    await h.leases.peek('p/1');
    await h.leases.peek('p/2');
    h.leases.disposeAll();
    expect(h.released).toEqual(['p/1', 'p/2']);
    expect(h.leases.size()).toBe(0);
    h.leases.disposeAll();
    expect(h.released).toEqual(['p/1', 'p/2']);
  });
});

describe('createPeekLeases · URI 反查', () => {
  it('按 model 自己的 uri 找回宿主路径（Peek 里按 Enter 时 opener 拿到的就是它）', async () => {
    const h = harness();
    await h.leases.peek('p/a.ERB');
    expect(h.leases.pathOfUri('file:///p/a.ERB')).toBe('p/a.ERB');
    expect(h.leases.pathOfUri('file:///别的')).toBeUndefined();
    expect(h.leases.pathOfUri('')).toBeUndefined();
  });

  it('已 dispose 的租约不参与反查（答出来的路径点了必炸）', async () => {
    const h = harness();
    await h.leases.peek('p/a.ERB');
    h.modelOf('p/a.ERB').dispose();
    expect(h.leases.pathOfUri('file:///p/a.ERB')).toBeUndefined();
  });
});
