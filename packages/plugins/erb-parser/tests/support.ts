/**
 * 测试共享夹具（erb-parser 测试专用）。
 *
 * 为什么需要"计算池替身"：解耦审计 **B 项**禁止插件（含其测试）import
 * `@kojo/kernel`——真池的实现住内核包，故插件测试只能提供一个语义一致的替身。
 *
 * 替身只实现插件真正用到的 `runSliced`，语义与真池对齐：
 * **保序**、按 `concurrency` **分窗并发**、`fn` 自身异常由 `fn` 消化
 * （真池会让异常整体 reject，本插件两处调用都在 fn 内 try/catch，故等价）。
 * 真池自身的时间片 / 优先级 / 单飞尾缘语义由 `kernel/tests/compute.test.ts` 覆盖。
 */
import type { ComputePool, ComputePoolStats } from '@kojo/plugin-api';

export function makeComputeStub(): ComputePool {
  /** 可搬运任务的本地实现表（等价于"无并行通道"的真池行为） */
  const tasks = new Map<string, (payload: never) => unknown>();
  const noChannel = (): ComputePoolStats['offload'] => ({
    parallel: false,
    dispatched: 0,
    fellBack: 0,
    inline: 0,
  });
  return {
    async yieldToMain(): Promise<void> {},
    async runSliced<T, R>(
      items: readonly T[],
      opts: { concurrency?: number },
      fn: (item: T, index: number) => R | Promise<R>,
    ): Promise<R[]> {
      const window = Math.max(1, Math.floor(opts.concurrency ?? 1));
      const out: R[] = new Array(items.length) as R[];
      for (let i = 0; i < items.length; i += window) {
        const end = Math.min(i + window, items.length);
        const done = await Promise.all(items.slice(i, end).map((item, k) => fn(item, i + k)));
        for (let k = 0; k < done.length; k++) out[i + k] = done[k]!;
      }
      return out;
    },
    runLatest: <R,>(_key: string, _opts: unknown, fn: () => R | Promise<R>): Promise<R> => Promise.resolve(fn()),
    busyInteractive: () => false,
    registerTask: (kind: string, impl: (payload: never) => unknown) => {
      tasks.set(kind, impl);
    },
    // 测试环境没有 worker：恒"无并行通道"，offload 走本地实现（真池的等价回退路径）
    parallel: () => false,
    attachTransport: () => undefined,
    async offload<R = unknown>(kind: string, payload: unknown): Promise<R> {
      const impl = tasks.get(kind);
      if (!impl) throw new Error(`No local implementation registered for compute task '${kind}'`);
      return (await impl(payload as never)) as R;
    },
    stats: () => ({ tasks: [], yields: 0, interactiveActive: false, offload: noChannel() }),
    resetStats: () => undefined,
  };
}
