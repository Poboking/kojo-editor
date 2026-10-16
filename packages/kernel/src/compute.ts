/**
 * 内核计算池实现（服务键 `kernel.compute`；契约见 `plugin-api/src/compute.ts`）
 * ——「内核优化」批的芯。
 *
 * ## 目标
 *
 * 让"批量 CPU 工作"不再表现为**连续卡顿**：把工作切成**时间片**，片间把主线程
 * 让给浏览器（渲染 / 输入事件）。用户在级联扫描（索引 / 抽取 / 校验 / 建树）进行
 * 期间照常输入、滚动、切文件——即"即点即现"。
 *
 * ## 为什么分层是"调度在先、运输在后"
 *
 * 路线文档（`docs/archive/PERF-REVIEW-2026-10-11.md` §三 L1）把本设施定义为
 * **宿主通用计算池**，并明确：无 Worker 环境（vitest node 侧）**自动退化为内联执行**，
 * 与真实宿主**共用同一套调度代码**，只是"运输层"不同。故本模块只做调度语义：
 *
 * - **时间片**：`runSliced` 每片最多 `sliceMs`，超出即让路；
 * - **优先级**：`interactive`（波浪线 / 补全）> `background`（索引 / 抽取 / 建树）。
 *   背景任务在片间发现交互档在跑时**主动让路**（合作式，不抢占同步片）；
 * - **单飞 + 尾缘合并**：`runLatest` 保证同 key 同时只有一个在跑，其间到达的新请求
 *   只保留最新一个（中间版本直接跳过）——高频 provider 的标准背压；
 * - **统计**：片数 / 让路次数 / 耗时，供性能探针（`__kojoPerf`）与状态面板读取。
 *
 * 将来把运输层换成 Worker 时，**调用方零改动**（同一份 `runSliced` 语义）。
 *
 * ## 铁律合规
 *
 * 名字与实现零游戏词汇、零糖字样（解耦审计 A 项）；本设施不认识任何插件概念，
 * 只接受"项数组 + 纯函数"。
 */

import type {
  ComputePayload,
  ComputePool,
  ComputePriority,
  ComputeRunOptions,
  ComputeTaskStat,
  ComputeTransport,
  Logger,
} from '@kojo/plugin-api';

/** 默认片预算：半个 60fps 帧——保证交互最多等半帧 */
export const DEFAULT_SLICE_MS = 8;

/** 通道连续失败到这个次数就停发（避免每次任务都白等一次超时） */
const TRANSPORT_FAILURE_LIMIT = 3;

const ANON = 'anonymous';

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 造一个"让路"函数（宏任务边界）。
 *
 * 单例 MessageChannel + 等待者队列：每次 `postMessage` 触发一条 message，
 * 唤醒队首等待者。Node（≥15，`MessageChannel` 已是全局）与浏览器通吃；
 * 极老环境无 MessageChannel 时退化为 `setTimeout(0)`。
 */
function createYielder(): () => Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  const waiters: Array<() => void> = [];
  /**
   * 用**结构化类型**而不是 `MessagePort`：本仓库有 node / DOM 两套 lib
   * （`tsc` 必须 root + app 双跑，见 HANDOFF §九-7），而两套对 MessagePort 的
   * 声明不同（DOM 有 `onmessage`，@types/node 的继承 EventEmitter 没有）。
   * `addEventListener` 是两侧都有的共同面，故只用它。
   */
  const port = channel.port1 as unknown as {
    addEventListener(type: 'message', handler: () => void): void;
    start?(): void;
  };
  port.addEventListener('message', () => {
    const next = waiters.shift();
    if (next) next();
  });
  port.start?.();
  return () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(0);
    });
}

interface LatestSlot {
  running: boolean;
  /** 本次运行期间累积的等待者（尾缘合并后共用一个结果） */
  waiters: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  /** 待执行的**最新**任务（后到者覆盖先到者） */
  next: (() => Promise<unknown>) | null;
}

export function createComputePool(opts: { log?: Logger } = {}): ComputePool {
  const log = opts.log;
  const yieldToMain = createYielder();
  const statsByLabel = new Map<string, ComputeTaskStat>();
  let totalYields = 0;
  let interactiveDepth = 0;
  const latestSlots = new Map<string, LatestSlot>();

  /* ------------------------- 运输层（可搬运任务） ------------------------- */
  const taskImpls = new Map<string, (payload: never) => unknown>();
  let transport: ComputeTransport | null = null;
  let transportFailures = 0;
  const offloadStat = { dispatched: 0, fellBack: 0, inline: 0 };

  function statFor(label: string, priority: ComputePriority): ComputeTaskStat {
    let s = statsByLabel.get(label);
    if (!s) {
      s = { label, priority, items: 0, slices: 0, yields: 0, durationMs: 0, runs: 0 };
      statsByLabel.set(label, s);
    }
    // 优先级以最近一次调用为准（同一 label 混用是调用方的 bug，这里不隐藏）
    s.priority = priority;
    return s;
  }

  async function runSliced<T, R>(
    items: readonly T[],
    opts: ComputeRunOptions,
    fn: (item: T, index: number) => R | Promise<R>,
  ): Promise<R[]> {
    const priority: ComputePriority = opts.priority ?? 'background';
    const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS;
    const label = opts.label ?? ANON;
    // 非有限的 concurrency 会让 Math.max(1, Math.floor(NaN)) 得 NaN → 步长 0 →
    // 静默产出全 undefined 数组且 stat 被污染。内核不静默：显式抛错；
    // 校验放在 statFor 之前——被拒的运行不留 stat 条目（2026-10-16 修复批）。
    if (opts.concurrency !== undefined && !Number.isFinite(opts.concurrency)) {
      throw new Error(`Invalid concurrency: ${String(opts.concurrency)} (must be a finite number)`);
    }
    const stat = statFor(label, priority);
    const startedAt = now();
    const window = Math.max(1, Math.floor(opts.concurrency ?? 1));

    stat.runs++;
    if (priority === 'interactive') interactiveDepth++;
    try {
      const out: R[] = new Array(items.length) as R[];
      let sliceStart = now();
      for (let i = 0; i < items.length; i += window) {
        const end = Math.min(i + window, items.length);
        if (window === 1) {
          out[i] = await fn(items[i]!, i);
        } else {
          // 窗口内并发（保住 IPC 并行度），窗口间统一让路
          const done = await Promise.all(items.slice(i, end).map((item, k) => fn(item, i + k)));
          for (let k = 0; k < done.length; k++) out[i + k] = done[k]!;
        }
        stat.items += end - i;
        if (end >= items.length) break;

        const overBudget = now() - sliceStart >= sliceMs;
        // 背景档在片间主动给交互档让路（合作式：不抢占正在执行的同步片）
        const mustYield = priority === 'background' ? overBudget || interactiveDepth > 0 : overBudget;
        if (!mustYield) continue;

        stat.slices++;
        stat.yields++;
        totalYields++;
        await yieldToMain();
        sliceStart = now();
      }
      return out;
    } finally {
      if (priority === 'interactive') interactiveDepth--;
      stat.durationMs += now() - startedAt;
    }
  }

  function runOne<R>(key: string, opts: ComputeRunOptions, fn: () => R | Promise<R>): Promise<R> {
    // 单飞任务本身按"一项"过调度，从而继承时间片与优先级语义
    return runSliced([0], { ...opts, label: opts.label ?? key }, () => fn()).then((r) => r[0]!);
  }

  async function drain(slot: LatestSlot, key: string): Promise<void> {
    slot.running = true;
    try {
      while (slot.next) {
        const run = slot.next;
        slot.next = null;
        const waiters = slot.waiters;
        slot.waiters = [];
        try {
          const value = await run();
          for (const w of waiters) w.resolve(value);
        } catch (err) {
          for (const w of waiters) w.reject(err);
        }
      }
    } finally {
      slot.running = false;
      // 窗口期内若又来了请求（同步入队），下一个调用者会重新启动 drain
      if (!slot.next && slot.waiters.length === 0) latestSlots.delete(key);
    }
  }

  function runLatest<R>(key: string, opts: ComputeRunOptions, fn: () => R | Promise<R>): Promise<R> {
    let slot = latestSlots.get(key);
    if (!slot) {
      slot = { running: false, waiters: [], next: null };
      latestSlots.set(key, slot);
    }
    const current = slot;
    return new Promise<R>((resolve, reject) => {
      current.waiters.push({ resolve: resolve as (v: unknown) => void, reject });
      current.next = () => runOne(key, opts, fn) as Promise<unknown>;
      if (!current.running) void drain(current, key);
    });
  }

  /** 通道当前是否可用（连续失败到上限后停用） */
  const transportUsable = (): boolean =>
    transport !== null && transport.available && transportFailures < TRANSPORT_FAILURE_LIMIT;

  async function offload<R>(kind: string, payload: ComputePayload): Promise<R> {
    if (transportUsable()) {
      try {
        const value = await transport!.invoke(kind, payload);
        transportFailures = 0;
        offloadStat.dispatched++;
        return value as R;
      } catch (err) {
        transportFailures++;
        if (transportFailures >= TRANSPORT_FAILURE_LIMIT) {
          log?.warn(
            `Compute transport disabled after ${transportFailures} consecutive failures; ` +
              `all offload tasks now run inline (last error: ${String(err)})`,
          );
        }
        offloadStat.fellBack++;
      }
    }
    const local = taskImpls.get(kind);
    if (!local) {
      throw new Error(`No local implementation registered for compute task '${kind}'`);
    }
    offloadStat.inline++;
    return (await local(payload as never)) as R;
  }

  return {
    yieldToMain,
    runSliced,
    runLatest,
    busyInteractive: () => interactiveDepth > 0,
    registerTask: (kind, impl) => {
      taskImpls.set(kind, impl as (payload: never) => unknown);
    },
    parallel: transportUsable,
    attachTransport: (t) => {
      transport?.dispose?.();
      transport = t;
      transportFailures = 0;
      log?.info(`Compute transport attached (parallel=${t.available})`);
    },
    offload,
    stats: () => ({
      tasks: [...statsByLabel.values()].map((s) => ({ ...s })),
      yields: totalYields,
      interactiveActive: interactiveDepth > 0,
      offload: { parallel: transportUsable(), ...offloadStat },
    }),
    resetStats: () => {
      statsByLabel.clear();
      totalYields = 0;
      offloadStat.dispatched = 0;
      offloadStat.fellBack = 0;
      offloadStat.inline = 0;
    },
  };
}
