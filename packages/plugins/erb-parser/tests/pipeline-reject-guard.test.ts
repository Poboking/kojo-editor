/**
 * PS-3 双缓冲的孤儿批守卫（2026-10-18 收口批）：
 * `readBatchesPipelined` 里，第 N+1 批的 `io.readTexts` 在第 N 批**处理前**就发出；
 * 若 `process`（`runSliced` 替身）抛错、循环提前退出，在途的第 N+1 批就没有
 * 下一轮 `await` 来接它 ⇒ 拒绝无订阅者，宿主侧漂出 unhandledrejection（Chromium 实锤
 * 形态），整批读盘白付。纪律同 `kernel/src/compute.ts` 的窗口起跑注（「先 await 首项
 * 再订阅余项会把窗口里先失败的那几个漏成 unhandled rejection」）。
 *
 * 本用例钉三件事：
 * 1. `process` 抛错 ⇒ `buildIndex` 照旧上抛（失败语义不吞：错误仍到调用方）；
 * 2. 全程 **零** `unhandledRejection`（兜订阅 `pending?.catch` 定责的就是这条）；
 * 3. 反恒真：第 N+1 批的读**确实发出了、且确实以拒绝收场**——不是"没发生所以没漂"。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComputePool, ComputeRunOptions, ErbParserService, FileIO, PluginContext } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';

/** 65 个文件 > READ_BATCH(64) ⇒ 恰好触发"第一批处理时第二批已在途"的双缓冲窗口 */
const FILE_COUNT = 65;

function filesMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < FILE_COUNT; i++) out[`/root/f${i}.ERB`] = `@F${i}\nPRINTL x\n`;
  return out;
}

/**
 * 伪 FileIO：第 1 趟 `readTexts`（首批 64 个）正常返回；
 * 第 2 趟（第 65 个，孤儿批）**延迟 10ms 后拒绝**——延迟是故意的：
 * 拒绝必须发生在 `process` 抛错、循环退出**之后**，才是"无订阅者的孤儿拒绝"。
 */
function pipelinedIO(files: Record<string, string>): { io: FileIO; batchCalls: () => number; orphanRejected: () => boolean } {
  let batch = 0;
  let rejected = false;
  const io: FileIO = {
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async readTexts(paths: readonly string[]) {
      batch++;
      if (batch >= 2) {
        await new Promise((r) => setTimeout(r, 10));
        rejected = true;
        throw new Error(`orphan batch read failed (paths=${paths.length})`);
      }
      return paths.map((path) => {
        const text = files[path];
        return text === undefined ? null : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      });
    },
    async stat(path: string) {
      const text = files[path];
      return text === undefined ? null : { size: text.length, mtimeMs: null, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(files)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
  return { io, batchCalls: () => batch, orphanRejected: () => rejected };
}

/** 计算池替身：`index.parse` 段整体抛错（＝ `process` 抛），其余段照 support 替身走 */
function throwingParseCompute(): ComputePool {
  const base = makeComputeStub();
  return {
    ...base,
    async runSliced<T, R>(items: readonly T[], opts: ComputeRunOptions, fn: (t: T, i: number) => R | Promise<R>): Promise<R[]> {
      if (opts.label === 'index.parse') {
        throw new Error('process blew up (index.parse)');
      }
      return base.runSliced(items, opts, fn);
    },
  } as unknown as ComputePool;
}

function activate(io: FileIO, compute: ComputePool): Map<string, unknown> {
  const services = new Map<string, unknown>();
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: { on: () => noop, once: () => noop, emit: noop },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.compute') return compute as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: (() => {
      const map = new Map<string, string>();
      return {
        get: async (key: string) => (map.has(key) ? (JSON.parse(map.get(key)!) as unknown) : undefined),
        set: async (key: string, value: unknown) => {
          map.set(key, JSON.stringify(value));
        },
        delete: async (key: string) => {
          map.delete(key);
        },
        keys: async () => [...map.keys()],
      };
    })(),
    slots: { register: () => noop, query: () => [] },
    onDispose: noop,
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return services;
}

describe('PS-3 双缓冲孤儿批：process 抛错不漂 unhandled rejection', () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  beforeAll(() => {
    process.on('unhandledRejection', onUnhandled);
  });
  afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('buildIndex 上抛照旧（不吞错）；在途下一批被兜订阅接住（不漂错）；孤儿批确实拒绝过（反恒真）', async () => {
    rejections.length = 0;
    const files = filesMap();
    const { io, batchCalls, orphanRejected } = pipelinedIO(files);
    const services = activate(io, throwingParseCompute());
    const parser = services.get('erb.parser') as ErbParserService;

    let caught: unknown = null;
    try {
      await parser.buildIndex(['/root']);
    } catch (err) {
      caught = err;
    }
    // 判据①：错误原样到调用方（兜订阅只接早退孤儿，不改传播语义）
    expect(String(caught)).toContain('process blew up (index.parse)');
    // 等孤儿批的拒绝落地（延迟 10ms 抛出 + 一拍进程观察窗）
    await new Promise((r) => setTimeout(r, 80));
    // 判据③（反恒真）：第二批读确实发出、且确实以拒绝收场
    expect(batchCalls()).toBeGreaterThanOrEqual(2);
    expect(orphanRejected()).toBe(true);
    // 判据②：全程零 unhandledRejection——去掉 `pending?.catch` 兜订阅这条就红
    expect(rejections.map(String)).toEqual([]);
  }, 30_000);

  it('空清单（零批发出）时 buildIndex 正常走完，同样零 unhandledRejection', async () => {
    rejections.length = 0;
    const emptyIo = {
      async readText(path: string) {
        throw new Error(`not found: ${path}`);
      },
      async readTexts() {
        return [];
      },
      async stat() {
        return null;
      },
      async walkDir() {
        return [];
      },
    } as unknown as FileIO;
    const services = activate(emptyIo, makeComputeStub());
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/nonexistent']);
    expect(index.files.size).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections.map(String)).toEqual([]);
  }, 30_000);
});
