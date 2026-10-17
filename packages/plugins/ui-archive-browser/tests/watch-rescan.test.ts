/**
 * 归档浏览器 × 文件监视（BUG-5 消费方，2026-10-13）。
 *
 * 验的是**接线**：
 * - 存档目录被外部改动才会重扫，目录外的路径**首动作就 return**（零 IO）；
 * - 重扫一律经 `kernel.compute` 的 `runLatest` 且**用同一个 key** ⇒ "多次改动 → 一次重扫"
 *   由池的单飞 + 尾缘合并保证（**合并语义本身是内核的，已由 `kernel/tests/compute*.test.ts` 守**，
 *   本测试不重做它的实现，只验本插件有没有把活儿交给对的地方）；
 * - W13：面板**只**依赖归档读取单源 `archive.reader`（替身对其它服务键一律抛错 ⇒
 *   绿色本身就是"没有第二条读取链路"的证据）。
 *
 * 计算池用零调度直跑替身：审计 B 项禁止插件测试 import `@kojo/kernel`
 * （先例与理由见 `erb-parser/tests/support.ts` 头注）。
 */

import { describe, expect, it } from 'vitest';
import type { ArchiveReaderService, ComputePool, GameProject, PluginContext } from '@kojo/plugin-api';
import { ArchiveServices, KernelServices } from '@kojo/plugin-api';
import { createUiArchiveBrowserPlugin } from '../src/index';

const noop = (): void => {};
const log = { debug: noop, info: noop, warn: noop, error: noop };
const SAV = 'C:/Game/proj/sav';

function makeHarness(savDir?: string) {
  const listeners = new Map<string, Set<(p: never) => void>>();
  const bus = {
    on(type: string, handler: (p: never) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
    once(type: string, handler: (p: never) => void) {
      return bus.on(type, handler);
    },
    emit(type: string, payload: unknown) {
      for (const h of [...(listeners.get(type) ?? [])]) h(payload as never);
    },
  };

  const state = { scanCalls: 0, runs: [] as string[] };
  /** 归档读取单源替身（面板唯一的读取入口） */
  const reader = {
    current: () => null,
    async scan() {
      state.scanCalls++;
      return { dir: savDir ?? '', entries: [], scannedAt: 0, durationMs: 0 };
    },
    async parse(): Promise<never> {
      throw new Error('本测试不深解析');
    },
    async parseEntry(): Promise<never> {
      throw new Error('本测试不深解析');
    },
    async readEntry(): Promise<never> {
      throw new Error('本测试不取条目字节');
    },
    async extractEntry(): Promise<never> {
      throw new Error('本测试不落盘');
    },
  } as unknown as ArchiveReaderService;

  const project = { rootDir: 'C:/Game/proj', ...(savDir ? { savDir } : {}) } as GameProject;
  /** 零调度直跑替身：立即执行 fn，但把 key 记下来（本测试要看的就是"交给谁、用哪个 key"） */
  const compute = {
    async runLatest<R>(_key: string, _opts: unknown, fn: () => R | Promise<R>): Promise<R> {
      state.runs.push(_key);
      return await fn();
    },
  } as unknown as ComputePool;

  const disposers: Array<() => void> = [];
  const ctx = {
    pluginId: 'ui-archive-browser',
    log,
    bus,
    inject: (key: string) => {
      if (key === ArchiveServices.Reader) return reader;
      if (key === KernelServices.Project) return { current: () => project };
      if (key === KernelServices.Compute) return compute;
      throw new Error(`本测试的插件不该依赖服务 ${key}`);
    },
    tryInject: (key: string) => {
      try {
        return ctx.inject(key);
      } catch {
        return undefined;
      }
    },
    slots: { register: noop, query: () => [] },
    storage: {},
    onDispose: (fn: () => void) => {
      disposers.push(fn);
    },
  } as unknown as PluginContext;

  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    bus,
    state,
    disposers,
    settle,
    start: async (): Promise<void> => {
      await createUiArchiveBrowserPlugin().activate(ctx);
      await settle();
      state.scanCalls = 0;
      state.runs.length = 0; // 激活时的那次自扫不算在本批断言上
    },
  };
}

describe('归档浏览器 · 存档目录外部改动自动重扫', () => {
  it('存档目录里的改动 → 经 runLatest 触发一次重扫', async () => {
    const h = makeHarness(SAV);
    await h.start();

    h.bus.emit('file.changed', { kind: 'change', path: `${SAV}/save00.sav` });
    await h.settle();

    expect(h.state.runs).toHaveLength(1);
    expect(h.state.scanCalls).toBe(1);
  });

  it('存档目录**外**的改动 → 连 runLatest 都不问（首动作是廉价判定，零 IO）', async () => {
    const h = makeHarness(SAV);
    await h.start();

    h.bus.emit('file.changed', { kind: 'change', path: 'C:/Game/proj/ERB/other.ERB' });
    h.bus.emit('file.changed', { kind: 'add', path: 'C:/Game/proj/image/sprite.png' });
    await h.settle();

    expect(h.state.runs).toEqual([]);
    expect(h.state.scanCalls).toBe(0);
  });

  it('合批靠的是**同一个 key**（不是插件自己再写一个去抖器）', async () => {
    const h = makeHarness(SAV);
    await h.start();

    for (const name of ['save00.sav', 'save01.sav', 'save02.sav']) {
      h.bus.emit('file.changed', { kind: 'change', path: `${SAV}/${name}` });
    }
    await h.settle();

    expect(new Set(h.state.runs).size).toBe(1); // 三个事件同一个 key ⇒ 池只会留最后一次
    expect(h.state.runs[0]).toContain('ui-archive-browser');
  });

  it('项目没有存档目录（savDir 缺省）→ 任何改动都不重扫', async () => {
    const h = makeHarness();
    await h.start();

    h.bus.emit('file.changed', { kind: 'add', path: 'C:/Game/proj/sav/save00.sav' });
    await h.settle();

    expect(h.state.runs).toEqual([]);
    expect(h.state.scanCalls).toBe(0);
  });

  it('退订后不再重扫（dispose 面干净）', async () => {
    const h = makeHarness(SAV);
    await h.start();
    h.disposers.forEach((d) => d());

    h.bus.emit('file.changed', { kind: 'change', path: `${SAV}/save00.sav` });
    await h.settle();

    expect(h.state.runs).toEqual([]);
    expect(h.state.scanCalls).toBe(0);
  });
});
