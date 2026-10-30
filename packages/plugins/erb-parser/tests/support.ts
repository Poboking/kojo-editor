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
import { forEachRef, type FileRefs } from '../src/references';

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

/**
 * 把「一条引用一枚四元组」的**测试夹具写法**摊成生产侧的扁平流水（步长 `REF_STRIDE`）。
 *
 * 生产侧自 MEM-7 起只有扁平形态（一条一枚四元组要付 29.1 MB 的数组头 + 底层，见
 * `references.ts` 的 `REF_STRIDE` 注）。测试里保留四元组写法是为了**可读**，
 * 但摊平这一步不该由每个用例各写一遍 `i += 4`——那会把步长变成第二判据。
 */
export function flatRefs(
  tuples: readonly (readonly [string, number, number, number])[],
): FileRefs {
  const out: (string | number)[] = [];
  for (const [name, line, column, kind] of tuples) out.push(name, line, column, kind);
  return out;
}

/**
 * 扁平流水 → 「一条一枚四元组」的**可读形态**（与 {@link flatRefs} 互逆）。
 *
 * 用于"改前实现原样封存"的等价对拍（`refs-fastpath-equiv` / `refs-charclass-cache-equiv`）：
 * 那些文件里的旧实现产出的是四元组，断言必须比到同一形态上，否则"逐条相同"变成
 * "在格上比"——一个不报错、也不像错的假对拍。
 * 走 `forEachRef`：步长只许有一个出处。
 */
export function unflattenRefs(refs: FileRefs): [string, number, number, number][] {
  const out: [string, number, number, number][] = [];
  forEachRef(refs, (name, line, column, kind) => out.push([name, line, column, kind]));
  return out;
}
