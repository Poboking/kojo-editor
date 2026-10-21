/**
 * Kojo 2.0 结构解析 worker 的**主线程薄客户端**（请求-响应配对 + 超时丢弃 + 可判别降级）。
 *
 * ## 主线程在这里只做三件事
 *
 * 1. **建线程**（`?worker` 入口是 `kojo2-ts.worker.ts`；与 v1 `kojo-ts.worker.ts` 同一条 Vite 路）；
 * 2. 发 `{ id, type, text, version, oldTreeId? }`，按 `id` 配对回话；
 * 3. 超时（稳态 2s / 引导期 8s）后把该 `id` 从待办表删掉，**迟到回复直接丢**——
 *    一条已经判了 timeout 的请求不许再被改判（那会让早先的降级决定变成假的）。
 *
 * 主线程**一次解析都不做**：这里不 import `web-tree-sitter`、不 import `kojo2-runtime`、
 * 不碰 wasm（连类型都不需要）。`kojo2-semantic.ts` 通过 `getKojo2WorkerClient()` 取这份单例，
 * worker 不可用时拿到 `{ ok: false, reason }`，回空 tokens 即可。
 *
 * ## 失败面（全部是数据，不是异常）
 *
 * | reason | 什么时候 |
 * |---|---|
 * | `unavailable` | 本进程建不出 worker（无 Worker 支持 / 构造抛错 / 投递抛错后的终态） |
 * | `timeout` | 该 `id` 在预算内没有回话（**只丢这一条**，客户端本身继续可用） |
 * | `crashed` | worker 的 `onerror` 触发 / 投递时线程已死（在途请求全部收同一结局） |
 * | `disposed` | 客户端已 `dispose()`，调用方应降级 |
 * | `protocol-error` | 回话 `id` 对得上但 `type` 与请求不符（两侧版本错位） |
 * | `invalid-input` / `parse-failed` / `query-*` | worker 侧的业务失败，原样透传 |
 *
 * `dispose()` 幂等、**不抛**：在途请求一律 resolve 成 `disposed`（不是 reject——调用方在
 * Monaco 的 provider 里，rejection 会变成编辑器里的未处理异常）。
 *
 * ## 并发
 *
 * 客户端**不排队**：`parse` 与查询各自立刻投递，worker 侧按到达序串行处理（一条 parser，
 * 消息环本来就不该交错）。因此"并发两次 parse"的语义是**先到先解、后到后解**；第二趟若想
 * 吃第一趟的增量，必须等第一趟的 `treeId` 回来再发（调用方自己 await）。
 */
import Kojo2Worker from './kojo2-ts.worker?worker';
import {
  KOJO2_WORKER_BOOTSTRAP_TIMEOUT_MS,
  KOJO2_WORKER_TIMEOUT_MS,
  isKojo2WorkerReply,
  type Kojo2CapturesReply,
  type Kojo2FoldsReply,
  type Kojo2IndentsReply,
  type Kojo2ParseReply,
  type Kojo2WorkerFailure,
  type Kojo2WorkerFailureReason,
  type Kojo2WorkerReply,
  type Kojo2WorkerRequest,
  type Kojo2WorkerRequestType,
  type Kojo2WorkerResult,
} from './kojo2-worker-protocol';

export type Kojo2WorkerClientState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'disposed';

export interface Kojo2WorkerClientOptions {
  /** 建线程（测试注入可编程 FakeWorker；缺省 = Vite 的 `?worker` 入口） */
  readonly createWorker?: () => Worker;
  /** 稳态单请求预算（毫秒），缺省 {@link KOJO2_WORKER_TIMEOUT_MS} */
  readonly timeoutMs?: number;
  /** 引导期单请求预算（worker 还没回过任何一条时），缺省 {@link KOJO2_WORKER_BOOTSTRAP_TIMEOUT_MS} */
  readonly bootstrapTimeoutMs?: number;
  /** 一次性告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
}

interface ClientFailure {
  readonly ok: false;
  readonly reason: Kojo2WorkerFailureReason;
  readonly message: string;
  readonly treeId?: string;
}

interface PendingRequest {
  readonly id: number;
  readonly type: Kojo2WorkerRequestType;
  readonly resolve: (result: Kojo2WorkerResult<Kojo2WorkerReply>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultCreateWorker(): Worker {
  return new Kojo2Worker();
}

export class Kojo2WorkerClient {
  private worker: Worker | null = null;
  private status: Kojo2WorkerClientState = 'idle';
  private nextId = 1;
  private answered = false;
  private lateReplies = 0;
  private orphanReplies = 0;
  private unavailableMessage = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly createWorker: () => Worker;
  private readonly timeoutMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly warn: (message: string) => void;
  private readonly warned = new Set<string>();

  constructor(options: Kojo2WorkerClientOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.timeoutMs = normalizeTimeout(options.timeoutMs, KOJO2_WORKER_TIMEOUT_MS);
    this.bootstrapTimeoutMs = normalizeTimeout(options.bootstrapTimeoutMs, KOJO2_WORKER_BOOTSTRAP_TIMEOUT_MS);
    this.warn = options.warn ?? ((message: string) => console.warn(message));
  }

  get state(): Kojo2WorkerClientState {
    return this.status;
  }

  /** 在途请求数（超时 / 回话 / dispose 都会减；测试用它自证没有泄漏） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 超时后迟到的回话条数（**被丢弃**，不改任何已定的答案） */
  get lateReplyCount(): number {
    return this.lateReplies;
  }

  /** `id` 对不上任何在途请求 / 形状不符的噪音条数 */
  get orphanReplyCount(): number {
    return this.orphanReplies;
  }

  /** 建线程（幂等）。返回 false = 本客户端从此不可用（`unavailable` / `disposed`） */
  start(): boolean {
    if (this.status === 'starting' || this.status === 'ready') return true;
    if (this.status === 'unavailable' || this.status === 'disposed') return false;
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (error) {
      this.markUnavailable(`worker 启动失败：${describeError(error)}`);
      return false;
    }
    try {
      worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
      worker.onerror = (event: ErrorEvent) => this.crash(`worker 线程报错：${event.message || '（无消息）'}`);
    } catch (error) {
      try {
        worker.terminate();
      } catch {
        /* 建到一半的线程：能收就收，收不了随它去 */
      }
      this.markUnavailable(`worker 装配失败：${describeError(error)}`);
      return false;
    }
    this.worker = worker;
    this.status = 'starting';
    return true;
  }

  parse(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2ParseReply>> {
    return this.request<Kojo2ParseReply>({ type: 'parse', text, version, oldTreeId });
  }

  captures(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2CapturesReply>> {
    return this.request<Kojo2CapturesReply>({ type: 'captures', text, version, oldTreeId });
  }

  folds(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2FoldsReply>> {
    return this.request<Kojo2FoldsReply>({ type: 'folds', text, version, oldTreeId });
  }

  indents(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2IndentsReply>> {
    return this.request<Kojo2IndentsReply>({ type: 'indents', text, version, oldTreeId });
  }

  /** 幂等、不抛：在途请求一律 resolve 成 `disposed`，线程立即 terminate */
  dispose(): void {
    if (this.status === 'disposed') return;
    this.status = 'disposed';
    this.flush({
      ok: false,
      reason: 'disposed',
      message: '结构解析 worker 客户端已释放 ⇒ 调用方降级到词法层',
    });
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.terminate();
    } catch {
      /* 已经死掉的线程 terminate 会抛：这里只做收账 */
    }
  }

  /* -------------------------------- 内部 -------------------------------- */

  private request<T extends Kojo2WorkerReply>(
    payload: Omit<Kojo2WorkerRequest, 'id'>,
  ): Promise<Kojo2WorkerResult<T>> {
    if (this.status === 'disposed') {
      return Promise.resolve({
        ok: false,
        reason: 'disposed',
        message: '结构解析 worker 客户端已释放 ⇒ 调用方降级到词法层',
      });
    }
    if (this.status === 'unavailable') {
      return Promise.resolve({ ok: false, reason: 'unavailable', message: this.unavailableMessage });
    }
    if (!this.start()) {
      return Promise.resolve({ ok: false, reason: 'unavailable', message: this.unavailableMessage });
    }
    const worker = this.worker;
    if (worker === null) {
      return Promise.resolve({ ok: false, reason: 'unavailable', message: this.unavailableMessage });
    }
    const id = this.nextId++;
    // 引导期（worker 还没回过任何一条）要给 wasm 装载留余量；回了一条之后立即回到稳态预算
    const budget = this.answered ? this.timeoutMs : this.bootstrapTimeoutMs;
    const request = { ...payload, id } as Kojo2WorkerRequest;
    return new Promise<Kojo2WorkerResult<Kojo2WorkerReply>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          reason: 'timeout',
          message: `worker 在 ${budget}ms 内没有回话（请求 #${id} ${payload.type}）⇒ 这一条丢弃，客户端继续可用`,
        });
      }, budget);
      this.pending.set(id, { id, type: payload.type, timer, resolve });
      try {
        worker.postMessage(request);
      } catch (error) {
        // 投递都失败 = 线程已经死了：这一条与其余在途请求收同一结局，客户端进入终态
        this.pending.delete(id);
        clearTimeout(timer);
        this.markUnavailable(`worker 投递失败：${describeError(error)}`);
        resolve({ ok: false, reason: 'crashed', message: this.unavailableMessage });
      }
    }).then((result) => (result.ok ? { ok: true as const, value: result.value as T } : result));
  }

  private receive(data: unknown): void {
    if (!isKojo2WorkerReply(data)) {
      this.orphanReplies += 1;
      return;
    }
    const pending = this.pending.get(data.id);
    if (pending === undefined) {
      if (data.id === 0) return; // worker 级异常 / 垃圾回话：不是任何请求的答案，不制造伪 id
      this.lateReplies += 1; // 超时之后才到（或凭空出现）：丢掉，不改已定的答案
      return;
    }
    this.pending.delete(data.id);
    clearTimeout(pending.timer);
    this.answered = true;
    if (this.status === 'starting') this.status = 'ready';
    if (!data.ok) {
      pending.resolve(failureOf(data));
      return;
    }
    if (data.type !== pending.type) {
      pending.resolve({
        ok: false,
        reason: 'protocol-error',
        message: `请求 #${data.id} 是 ${pending.type}，回复却是 ${String(data.type)}（两侧版本对不上）`,
      });
      return;
    }
    pending.resolve({ ok: true, value: data });
  }

  /** 整档不可用：记一次告警、终止线程、在途请求全部按 reason 收账（绝不 reject） */
  private markUnavailable(message: string): void {
    if (this.status === 'unavailable' || this.status === 'disposed') return;
    this.status = 'unavailable';
    this.unavailableMessage = message;
    this.warnOnce(`unavailable:${message}`, `[kojo2-worker] ${message} ⇒ 结构层降级到词法层`);
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.terminate();
    } catch {
      /* 收账失败不改变结论 */
    }
    this.flush({ ok: false, reason: 'unavailable', message });
  }

  private crash(message: string): void {
    if (this.status === 'unavailable' || this.status === 'disposed') return;
    this.status = 'unavailable';
    this.unavailableMessage = message;
    this.warnOnce(`crash:${message}`, `[kojo2-worker] ${message} ⇒ 结构层降级到词法层`);
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.terminate();
    } catch {
      /* 同上 */
    }
    this.flush({ ok: false, reason: 'crashed', message });
  }

  private flush(failure: ClientFailure): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.resolve(failure);
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try {
      this.warn(message);
    } catch {
      /* 告警出口自己炸了不该把客户端带下水 */
    }
  }
}

function failureOf(reply: Kojo2WorkerFailure): Kojo2WorkerResult<Kojo2WorkerReply> {
  return reply.treeId === undefined
    ? { ok: false, reason: reply.reason, message: reply.message }
    : { ok: false, reason: reply.reason, message: reply.message, treeId: reply.treeId };
}

let singleton: Kojo2WorkerClient | null = null;

/**
 * 取**唯一**的 worker 客户端（懒建线程：第一次真正请求时才 `new Worker`）。
 *
 * 并发调用共享同一个实例；`options` 只在第一次生效（避免单例被半路改写）。
 */
export function getKojo2WorkerClient(options: Kojo2WorkerClientOptions = {}): Kojo2WorkerClient {
  if (singleton === null) singleton = new Kojo2WorkerClient(options);
  return singleton;
}

/** 丢掉当前单例（幂等；下一次 `get` 重新建） */
export function disposeKojo2WorkerClient(): void {
  const current = singleton;
  singleton = null;
  current?.dispose();
}

export type { Kojo2WorkerFailureReason };
