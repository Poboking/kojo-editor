/**
 * PS-13 墙钟读数：闭文件替换的并发窗口化（串行 vs 并发）。
 *
 * 判据：200 个闭文件、每个 io 往返注入 1ms 延迟（模拟 IPC 排队）——
 * 串行版（`closedConcurrency: 1`）≥ 200ms 量级；并发版（缺省窗口 8）
 * 要把这段墙钟压到串行的 1/3 以下。产出等价性（逐项同值同序）由功能池
 * `search-replace-exec-concurrent.test.ts` 钉死，这里只量墙钟。
 */

import { describe, expect, it } from 'vitest';
import { createFileReplaceRunner, type FileReplaceDeps } from '../src/ui/search-replace-exec';

const P = (i: number) => `C:/p/ERB/f${String(i).padStart(3, '0')}.ERB`;
const IO_DELAY_MS = 1;
const FILES = 200;

function makeHarness(): { files: Map<string, string>; io: FileReplaceDeps['io'] } {
  const files = new Map<string, string>();
  const paths: string[] = [];
  for (let i = 0; i < FILES; i++) {
    files.set(P(i), 'CALL FOO\n');
    paths.push(P(i));
  }
  const delay = (): Promise<void> => new Promise((r) => setTimeout(r, IO_DELAY_MS));
  return {
    files,
    io: {
      isWritable: () => true,
      readText: async (p) => {
        await delay();
        return { text: files.get(p)! };
      },
      writeText: async (p, text) => {
        await delay();
        files.set(p, text);
      },
    },
  };
}

const request = (paths: readonly string[]) =>
  ({
    query: 'FOO',
    replaceText: 'BAR',
    options: { isRegex: false, wholeWord: true, caseSensitive: false },
    mode: { kind: 'all' },
    files: paths.map((path) => ({ path })),
  }) as unknown as Parameters<ReturnType<typeof createFileReplaceRunner>>[0];

describe('PS-13 墙钟读数：200 闭文件替换（io 每往返 1ms）', () => {
  it(`并发版（窗口 8）≤ 串行版的 1/3（串行 ≥ ${FILES * IO_DELAY_MS}ms 量级）`, async () => {
    const paths = Array.from({ length: FILES }, (_, i) => P(i));

    const serialH = makeHarness();
    const t0 = performance.now();
    const serial = await createFileReplaceRunner({
      io: serialH.io,
      modelFor: () => undefined,
      closedConcurrency: 1,
    })(request(paths));
    const serialMs = performance.now() - t0;

    const concurrentH = makeHarness();
    const t1 = performance.now();
    const concurrent = await createFileReplaceRunner({
      io: concurrentH.io,
      modelFor: () => undefined,
    })(request(paths));
    const concurrentMs = performance.now() - t1;

    // 产出等价（对拍兜底：读数用例不许靠"改坏了但更快"过关）
    expect(concurrent.applied).toBe(serial.applied);
    expect(concurrent.filesChanged).toBe(serial.filesChanged);
    expect(concurrent.errors).toEqual(serial.errors);
    expect(serial.applied).toBe(FILES);

    // 墙钟：串行版至少排满 200 趟 × 1ms 的队；并发版拿到 1/3 以下
    expect(serialMs).toBeGreaterThanOrEqual(FILES * IO_DELAY_MS);
    expect(concurrentMs).toBeLessThan(serialMs / 3);
    // 读数随测试输出（回执口径：两段墙钟 + 比值）
    console.log(
      `[PS-13] 200 闭文件（io 1ms/往返）：串行 ${serialMs.toFixed(0)}ms → 并发(窗口8) ${concurrentMs.toFixed(0)}ms（${(serialMs / concurrentMs).toFixed(1)}x）`,
    );
  });
});