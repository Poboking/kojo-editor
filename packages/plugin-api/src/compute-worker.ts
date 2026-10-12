/**
 * 并行运输层的**协议与两侧实现**（宿主侧 `createWorkerTransport` / worker 侧
 * `handleComputeRequest`）。
 *
 * ## 为什么住公共包
 *
 * - 两侧（宿主与 worker 入口）必须共用**同一份协议**，否则必然漂移；
 * - 本模块零平台依赖（只用结构化类型描述 Worker 的最小面），故：
 *   · 住在公共包不违反分层；
 *   · 测试可以用 `node:worker_threads` 的**真线程**验证协议（见 kernel 测试）；
 *   · 生产侧由 app 用 DOM Worker 构造，行为面完全一致。
 *
 * ## 协议（单条消息一个任务）
 *
 * ```
 * 宿主 → worker:  { id: number, kind: string, payload: unknown }
 * worker → 宿主:  { id: number, result: unknown } | { id: number, error: string }
 * ```
 *
 * **传数据不传函数**：`kind` 是字符串标识，两侧各自映射到同一份实现
 * （宿主侧 `pool.registerTask`、worker 侧 `handleComputeRequest(tasks, ...)`；
 * 装配层把各插件导出的映射表合并后交给两者）。载荷必须可结构化克隆。
 */

/** Worker 的最小面（DOM `Worker` 与测试替身都满足） */
export interface ComputeWorkerLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', handler: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', handler: (ev: unknown) => void): void;
  terminate?(): void;
}

/** 一次请求/响应 */
export interface ComputeRequest {
  id: number;
  kind: string;
  payload: unknown;
}

export type ComputeResponse = { id: number; result: unknown } | { id: number; error: string };

/** 可搬运任务的实现表（两侧共用同一份形状） */
export type ComputeTaskTable = Record<string, (payload: never) => unknown>;

/** worker 侧：执行一条请求并产出响应（纯函数、可单测；worker 入口只负责收发） */
export async function handleComputeRequest(tasks: ComputeTaskTable, data: unknown): Promise<ComputeResponse> {
  const req = data as Partial<ComputeRequest> | null | undefined;
  if (!req || typeof req.id !== 'number' || typeof req.kind !== 'string') {
    // 协议不符：回一条 error（id 未知时用 -1，宿主侧会因 pending 未命中而丢弃）
    return { id: typeof req?.id === 'number' ? req.id : -1, error: 'malformed compute request' };
  }
  const impl = tasks[req.kind];
  if (!impl) return { id: req.id, error: `unknown compute task kind: ${req.kind}` };
  try {
    const result = await impl(req.payload as never);
    return { id: req.id, result };
  } catch (err) {
    return { id: req.id, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 宿主侧：把 `ComputeWorkerLike` 工厂包成计算池的运输层。
 *
 * - **多槽轮转**（`size`）：单 worker 只是"换个线程跑"，**不减少总 CPU**
 *   （索引解析实测 ~2.6 s 的纯 CPU，单 worker 的墙钟时间不变）；要真提速必须
 *   多线程并行。装配层按机器核数传 `size`（如 `hardwareConcurrency - 1`，封顶 4）。
 * - `id` 单调递增且全局唯一 → 多槽并发下响应不会错配；
 * - 单个 worker 报错（`error` 事件）→ **在途请求 reject 且该槽标记死亡**，
 *   其余槽继续服务；全部死亡 → 运输层不可用（池据此回退本地实现）；
 * - `dispose()` 终止全部 worker 并清空在途表。
 */
export function createWorkerTransport(
  factory: () => ComputeWorkerLike,
  opts: { size?: number } = {},
): {
  available: boolean;
  invoke(kind: string, payload: unknown): Promise<unknown>;
  dispose(): void;
} {
  const size = Math.max(1, Math.floor(opts.size ?? 1));
  /** 每个槽一个 worker；`dead` = 该槽报错出局 */
  const slots: Array<{ worker: ComputeWorkerLike | null; dead: boolean }> = Array.from({ length: size }, () => ({
    worker: null,
    dead: false,
  }));
  let seq = 0;
  let cursor = 0;
  /** 在途请求 → 槽号（错误时按槽清理） */
  const pending = new Map<number, { slot: number; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const anyAlive = (): boolean => slots.some((s) => !s.dead);

  const killSlot = (slotIndex: number, err: Error): void => {
    const slot = slots[slotIndex]!;
    slot.dead = true;
    for (const [id, p] of [...pending]) {
      if (p.slot !== slotIndex) continue;
      pending.delete(id);
      p.reject(err);
    }
  };

  const ensure = (slotIndex: number): ComputeWorkerLike => {
    const slot = slots[slotIndex]!;
    if (slot.worker) return slot.worker;
    const w = factory();
    w.addEventListener('message', (ev) => {
      const data = ev?.data as Partial<ComputeResponse> | undefined;
      if (!data || typeof data.id !== 'number') return;
      const waiter = pending.get(data.id);
      if (!waiter) return; // 过期 / 未知 id：丢弃（不误伤在途请求）
      pending.delete(data.id);
      if ('error' in data && typeof data.error === 'string') waiter.reject(new Error(data.error));
      else waiter.resolve((data as { result: unknown }).result);
    });
    w.addEventListener('error', (ev) => {
      const msg = (ev as { message?: string } | null)?.message ?? String(ev);
      killSlot(slotIndex, new Error(`compute worker error: ${msg}`));
    });
    slot.worker = w;
    return w;
  };

  return {
    get available(): boolean {
      return anyAlive();
    },
    invoke(kind: string, payload: unknown): Promise<unknown> {
      if (!anyAlive()) return Promise.reject(new Error('compute worker transport is unavailable'));
      // 轮转到一个活着的槽
      let slotIndex = -1;
      for (let i = 0; i < size; i++) {
        const candidate = (cursor + i) % size;
        if (!slots[candidate]!.dead) {
          slotIndex = candidate;
          break;
        }
      }
      cursor = (slotIndex + 1) % size;
      const id = ++seq;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { slot: slotIndex, resolve, reject });
        try {
          ensure(slotIndex).postMessage({ id, kind, payload } satisfies ComputeRequest);
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    dispose(): void {
      // 在途请求必须**显式 reject**（而不是只清空）：否则调用方的 await 会永久挂起。
      // 池侧会把这次失败记为 fellBack 并回退本地实现，语义安全。
      const err = new Error('compute worker transport disposed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      for (const s of slots) {
        s.worker?.terminate?.();
        s.worker = null;
      }
    },
  };
}
