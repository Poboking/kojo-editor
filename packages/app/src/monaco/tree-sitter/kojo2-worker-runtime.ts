/**
 * Kojo 2.0 结构解析 worker 的**主线程薄壳**（LAU-1：这一层只说协议 v3）。
 *
 * ## 主线程在这里只做四件事
 *
 * 1. **建线程**（`?worker` 入口是 `kojo2-ts.worker.ts`；与 v1 `kojo-ts.worker.ts` 同一条 Vite 路），
 *    `start()` 发一条 `open{protocol:3}`；
 * 2. 发 `parse{doc,version,text|edit,baseTreeId?,want}`，按 `id` 配对回话；
 * 3. 超时（稳态 4s / 引导期 8s，**与 v1 同一档**——LAU-1 之前这里是 2s，§4.1 把两套超时并成一档）后
 *    把该 `id` 从待办表删掉，**迟到回复直接丢**——一条已经判了 timeout 的请求不许再被改判；
 * 4. 把 v3 的 `facets` 翻回本族既有消费方（`kojo2-semantic.ts` / `kojo2-folding.ts` /
 *    `kojo2-indent.ts`）认识的三条回复。**翻译只在这一层**：那三个模块一行不改（additive 契约）。
 *
 * 主线程**一次解析都不做**：这里不 import `web-tree-sitter`、不 import `kojo2-runtime`、
 * 不碰 wasm（连类型都不需要）。
 *
 * ## 双跑窗口（`protocol-mismatch` 不整档哑火）
 *
 * 对面如果还是旧 worker（v2：`captures` / `folds` / `indents` / `parse` 四条消息、没有握手），
 * 本类有两种发现方式，都会**当场改说旧话**（不是把结构层关掉）：
 * - 它回了 `protocol-mismatch`（新 worker 收到旧形状时的答复）；或
 * - 引导期一条回话都没有（旧 worker 不认识 `open`，只能静默丢掉 ⇒ 超时）。
 *
 * 改说旧话之后，本类发 `{id,type,text,version,oldTreeId}`（LAU-1 之前的形状），收到的
 * `{ok,type,…}` 也按旧形状解——两条路的**公开方法签名与返回类型完全一致**，
 * 上游那三个消费模块感知不到换过轨。
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
 * 客户端**不排队**：每条请求各自立刻投递，worker 侧按到达序串行处理（一条 parser，
 * 消息环本来就不该交错）。因此"并发两次 parse"的语义是**先到先解、后到后解**。
 */
import Kojo2Worker from './kojo2-ts.worker?worker';
import {
  STRUCTURE_BOOTSTRAP_TIMEOUT_MS,
  STRUCTURE_PROTOCOL_VERSION,
  STRUCTURE_TIMEOUT_MS,
} from '@kojo/kojo-core';
import type {
  StructureCaptureTable,
  StructureEdit,
  StructureFacet,
  StructureFailureReason,
  StructureParseReply,
  StructureReply,
  StructureRequest,
} from './protocol';
import { isStructureReply } from './protocol';
import {
  isKojo2WorkerReply,
  type Kojo2CapturesReply,
  type Kojo2FoldRange,
  type Kojo2FoldsReply,
  type Kojo2IndentRules,
  type Kojo2IndentsReply,
  type Kojo2ParseReply,
  type Kojo2WorkerFailureReason,
  type Kojo2WorkerReply,
  type Kojo2WorkerRequest,
  type Kojo2WorkerRequestType,
  type Kojo2WorkerResult,
} from './kojo2-worker-protocol';
import type { Kojo2Capture } from './kojo2-tokenizer';
import { applyEdit, commonEdit } from './edit';

export type Kojo2WorkerClientState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'disposed';

export interface Kojo2WorkerClientOptions {
  /** 建线程（测试注入可编程 FakeWorker；缺省 = Vite 的 `?worker` 入口） */
  readonly createWorker?: () => Worker;
  /** 稳态单请求预算（毫秒），缺省 {@link STRUCTURE_TIMEOUT_MS} */
  readonly timeoutMs?: number;
  /** 引导期单请求预算（worker 还没回过任何一条时），缺省 {@link STRUCTURE_BOOTSTRAP_TIMEOUT_MS} */
  readonly bootstrapTimeoutMs?: number;
  /**
   * 协议档位（双跑窗口的手动回滚开关）：
   * - `'auto'`（缺省）= 先说 v3，握手被拒 / 对面形状不符 / 引导期无回话就改说 v2；
   * - `'legacy'` = 一个字节的 v3 都不发（等价于 LAU-1 之前的行为）。
   */
  readonly protocolMode?: 'auto' | 'legacy';
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
  /** 上游要的那一种回答（`captures` / `folds` / `indents` / `parse`） */
  readonly type: Kojo2WorkerRequestType;
  /** 这条请求带的增量基准（v3 只回 `incremental`；"有没有重新解树"由树身份是否变化推出来） */
  readonly baseTreeId?: string;
  /** 这条请求交出去的整篇文本（答复回来后它就是下一条 `parse{edit}` 的基线） */
  readonly text: string;
  /** 主线程的版本号（差集基线丢了时按原版本重发整篇） */
  readonly version: number;
  /** 这一条是带着 `edit` 发的（`parse-failed` = 基线树不认识 ⇒ 重发整篇，不记失败） */
  fromEdit: boolean;
  readonly resolve: (result: Kojo2WorkerResult<Kojo2WorkerReply>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 一条请求的原始内容（v3 与 v2 两条路都要它；换轨时原样重发） */
interface RequestPayload {
  readonly text: string;
  readonly version: number;
  readonly oldTreeId?: string;
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

/** 面 ← 上游的请求种类（v3 的 `want` 就是这一格） */
function facetsOf(type: Kojo2WorkerRequestType): readonly StructureFacet[] {
  if (type === 'captures') return ['semantic'];
  if (type === 'folds') return ['folds'];
  if (type === 'indents') return ['indent'];
  return []; // 上游只要树身份与耗时（`parse`）
}

export class Kojo2WorkerClient {
  private worker: Worker | null = null;
  private status: Kojo2WorkerClientState = 'idle';
  private nextId = 1;
  private answered = false;
  private lateReplies = 0;
  private orphanReplies = 0;
  private unavailableMessage = '';
  /** 说 v3 还是 v2（双跑窗口的开关；`protocol-mismatch` / 引导期无回话 ⇒ 翻到 `'v2'`） */
  private mode: 'v3' | 'v2';
  private readonly pending = new Map<number, PendingRequest>();
  /** 上一条**成功答复**对应的文本与树身份（`parse{edit}` 的基线；两者永远成对更新） */
  private lastText: string | null = null;
  private lastTreeId: string | null = null;
  private readonly createWorker: () => Worker;
  private readonly timeoutMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly warn: (message: string) => void;
  private readonly warned = new Set<string>();

  constructor(options: Kojo2WorkerClientOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.timeoutMs = normalizeTimeout(options.timeoutMs, STRUCTURE_TIMEOUT_MS);
    this.bootstrapTimeoutMs = normalizeTimeout(options.bootstrapTimeoutMs, STRUCTURE_BOOTSTRAP_TIMEOUT_MS);
    this.warn = options.warn ?? ((message: string) => console.warn(message));
    this.mode = options.protocolMode === 'legacy' ? 'v2' : 'v3';
  }

  get state(): Kojo2WorkerClientState {
    return this.status;
  }

  /** 当前说的是哪一版协议（诊断 / 测试用；`protocol-mismatch` 之后会变 'v2'） */
  get protocolMode(): 'v3' | 'v2' {
    return this.mode;
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
    if (this.mode === 'v3') {
      // 握手：v3 的第一步。旧 worker 不认识它（静默丢掉）⇒ 由引导期超时翻到 v2。
      this.post({
        id: this.nextId++,
        kind: 'open',
        protocol: STRUCTURE_PROTOCOL_VERSION,
        languageId: 'kojo2',
        // 2.0 的 wasm 由入口静态装配，这两格只作自证（worker 不按 URL 装载）
        runtimeWasmUrl: 'static:kojo2-runtime',
        grammarWasmUrl: 'static:kojo2-grammar',
      });
    }
    return true;
  }

  parse(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2ParseReply>> {
    return this.request<Kojo2ParseReply>('parse', { text, version, oldTreeId });
  }

  captures(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2CapturesReply>> {
    return this.request<Kojo2CapturesReply>('captures', { text, version, oldTreeId });
  }

  folds(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2FoldsReply>> {
    return this.request<Kojo2FoldsReply>('folds', { text, version, oldTreeId });
  }

  indents(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2IndentsReply>> {
    return this.request<Kojo2IndentsReply>('indents', { text, version, oldTreeId });
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
    this.lastText = null;
    this.lastTreeId = null;
    try {
      worker?.terminate();
    } catch {
      /* 已经死掉的线程 terminate 会抛：这里只做收账 */
    }
  }

  /* -------------------------------- 内部 -------------------------------- */

  private request<T extends Kojo2WorkerReply>(
    type: Kojo2WorkerRequestType,
    payload: RequestPayload,
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
    return new Promise<Kojo2WorkerResult<Kojo2WorkerReply>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const bootstrapStall = !this.answered;
        resolve({
          ok: false,
          reason: 'timeout',
          message: `worker 在 ${budget}ms 内没有回话（请求 #${id} ${type}）⇒ 这一条丢弃，客户端继续可用`,
        });
        if (bootstrapStall) this.fallBackToV2('引导期一条回话都没有（对面多半是旧 worker，它不认识 open）');
      }, budget);
      const entry: PendingRequest = {
        id,
        type,
        baseTreeId: payload.oldTreeId,
        text: payload.text,
        version: payload.version,
        fromEdit: false,
        timer,
        resolve,
      };
      this.pending.set(id, entry);
      try {
        this.dispatch(worker, id, type, payload, entry);
      } catch (error) {
        // 投递都失败 = 线程已经死了：这一条与其余在途请求收同一结局，客户端进入终态
        this.pending.delete(id);
        clearTimeout(timer);
        this.markUnavailable(`worker 投递失败：${describeError(error)}`);
        resolve({ ok: false, reason: 'crashed', message: this.unavailableMessage });
      }
    }).then((result) => (result.ok ? { ok: true as const, value: result.value as T } : result));
  }

  /**
   * 投递一条请求：v3（`parse` + `want`）或 v2（LAU-1 之前那套按 type 分的消息）。
   *
   * ## v3 走差集（§4.1 迁移表最后一条：kojo2 原本每键带全文，接上 `edit` 才与 v1 齐平）
   *
   * 基线是**上一条成功答复**交出的那棵树 + 那条请求的文本（两者成对记，见 {@link rememberBaseline}）。
   * 这条线程自己求一条保守编辑，缝回去自检一次——缝不回来（或还没有基线）就老实发整篇：
   * 差集口径漂了宁可贵一次，绝不让两侧文本分叉。上游若显式给了 `oldTreeId`，只有它正好是
   * 我们手上的基线时才改走差集（否则基线文本对不上，worker 会按整篇重解，白贵一趟）。
   */
  private dispatch(
    worker: Worker,
    id: number,
    type: Kojo2WorkerRequestType,
    payload: RequestPayload,
    entry: PendingRequest,
  ): boolean {
    if (this.mode === 'v3') {
      const base = this.baselineFor(payload);
      const edit = base === null ? null : this.editOf(base.text, payload.text);
      entry.fromEdit = edit !== null && base !== null;
      const request: StructureRequest = {
        id,
        kind: 'parse',
        doc: 0,
        version: payload.version,
        ...(entry.fromEdit && base !== null
          ? { edit: edit!, baseTreeId: base.treeId }
          : { text: payload.text, ...(payload.oldTreeId === undefined ? {} : { baseTreeId: payload.oldTreeId }) }),
        want: facetsOf(type),
      };
      worker.postMessage(request);
      return entry.fromEdit;
    }
    const legacy: Kojo2WorkerRequest = {
      id,
      type,
      text: payload.text,
      version: payload.version,
      ...(payload.oldTreeId === undefined ? {} : { oldTreeId: payload.oldTreeId }),
    } as Kojo2WorkerRequest;
    worker.postMessage(legacy);
    entry.fromEdit = false;
    return false;
  }

  /** 这条请求能不能走差集：有基线、且上游没给一个和它对不上的基准 */
  private baselineFor(payload: RequestPayload): { readonly text: string; readonly treeId: string } | null {
    const text = this.lastText;
    const treeId = this.lastTreeId;
    if (text === null || treeId === null) return null;
    if (payload.oldTreeId !== undefined && payload.oldTreeId !== treeId) return null;
    return { text, treeId };
  }

  /** 一条保守编辑（缝不回去 / 文本没变 ⇒ `null`：整篇是永远正确的兜底） */
  private editOf(base: string, next: string): StructureEdit | null {
    if (base === next) return null;
    const edit = commonEdit(base, next);
    return applyEdit(base, edit) === next ? edit : null;
  }

  /** 成功答复回来：把"树身份 + 那条请求的文本"成对记成下一条的基线 */
  private rememberBaseline(treeId: string, text: string): void {
    if (treeId.length === 0) return;
    this.lastTreeId = treeId;
    this.lastText = text;
  }

  /** 双跑窗口：翻到 v2（不重发在飞请求——它们已经各自超时收账；后续请求走旧话） */
  private fallBackToV2(why: string): void {
    if (this.mode === 'v2') return;
    this.mode = 'v2';
    // 旧路没有差集通道 ⇒ 基线作废（留着只会让下一次 v3 尝试拿一份隔代的文本）
    this.lastText = null;
    this.lastTreeId = null;
    this.warnOnce(`legacy:${why}`, `[kojo2-worker] v3 通道交给旧路（v2）：${why}`);
  }

  private receive(data: unknown): void {
    if (this.mode === 'v3') {
      if (isStructureReply(data)) {
        this.receiveV3(data);
        return;
      }
      if (isKojo2WorkerReply(data)) {
        // 对面回了 v2 形状（它没看懂 v3 请求，或者压根还是旧 worker）
        this.fallBackToV2('worker 回传的形状是 v2 协议 ⇒ 改说旧话');
        this.receiveV2(data);
        return;
      }
      this.orphanReplies += 1;
      return;
    }
    if (!isKojo2WorkerReply(data)) {
      this.orphanReplies += 1;
      return;
    }
    this.receiveV2(data);
  }

  private pendingFor(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      if (id === 0) return undefined; // worker 级异常 / 垃圾回话：不是任何请求的答案
      this.lateReplies += 1; // 超时之后才到（或凭空出现）：丢掉，不改已定的答案
      return undefined;
    }
    this.settlePending(pending);
    return pending;
  }

  /** 从待办表摘掉一条并记"worker 说过话了"（成功 / 失败 / 重发都走这一步，账只有一处） */
  private settlePending(pending: PendingRequest): void {
    this.pending.delete(pending.id);
    clearTimeout(pending.timer);
    this.answered = true;
    if (this.status === 'starting') this.status = 'ready';
  }

  /**
   * 差集请求被 worker 判"基线树不认识"（线程换过 / 树被缓存挤掉）⇒ **当场重发整篇**：
   * 同一条 `id`、同一张计时票，不记失败。这是协议的正常兜底——不接住的话，一次基线丢失会让
   * 这条语言此后每次击键都 `parse-failed`（v1 那条路早就是这么做的）。
   */
  private retryAsFullText(pending: PendingRequest): boolean {
    if (!pending.fromEdit) return false;
    const worker = this.worker;
    if (worker === null) return false;
    this.lastText = null;
    this.lastTreeId = null;
    pending.fromEdit = false;
    try {
      const request: StructureRequest = {
        id: pending.id,
        kind: 'parse',
        doc: 0,
        version: pending.version,
        text: pending.text,
        want: facetsOf(pending.type),
      };
      worker.postMessage(request);
      return true;
    } catch {
      return false; // 投递失败 ⇒ 由调用方照常收账（线程已经不在了）
    }
  }

  /** v3 回话 → 上游要的那一种回复（`facets` → 三条旧形状） */
  private receiveV3(reply: StructureReply): void {
    if (reply.ok === false) {
      if (reply.reason === 'protocol-mismatch') {
        this.fallBackToV2(`open 握手被拒：${reply.message}`);
        return;
      }
      const pending = this.pending.get(reply.id);
      if (pending === undefined) {
        if (reply.id !== 0) this.lateReplies += 1; // 与 `pendingFor` 同口径：对不上号就丢
        return;
      }
      if (reply.reason === 'parse-failed' && this.retryAsFullText(pending)) return;
      this.settlePending(pending);
      pending.resolve(
        reply.treeId === undefined
          ? { ok: false, reason: reasonOf(reply.reason), message: reply.message }
          : { ok: false, reason: reasonOf(reply.reason), message: reply.message, treeId: reply.treeId },
      );
      return;
    }
    if (reply.kind === 'ready') {
      if (reply.protocol !== STRUCTURE_PROTOCOL_VERSION) {
        this.fallBackToV2(`worker 认的协议是 ${reply.protocol}（本宿主说 ${STRUCTURE_PROTOCOL_VERSION}）`);
        return;
      }
      this.answered = true;
      if (this.status === 'starting') this.status = 'ready';
      return;
    }
    const pending = this.pendingFor(reply.id);
    if (pending === undefined) return;
    // 基线只在**成功**答复之后推进（失败那一条的树身份是"没解成"，拿它当基线只会白贵一趟）
    this.rememberBaseline(reply.treeId, pending.text);
    pending.resolve(this.translate(reply, pending.type, pending.baseTreeId));
  }

  /** 把一条 v3 `parse` 回话翻成上游那三条回复之一（翻译只在这一层） */
  private translate(
    reply: StructureParseReply,
    type: Kojo2WorkerRequestType,
    baseTreeId: string | undefined,
  ): Kojo2WorkerResult<Kojo2WorkerReply> {
    const common = {
      ok: true as const,
      id: reply.id,
      version: reply.version,
      treeId: reply.treeId,
      incremental: reply.incremental,
      // v3 只报"这次是不是增量"；"有没有重新解过树"由树身份变化推出来（旧口径的 `reparsed`）：
      // 树身份没变 = 缓存命中只查不了解；变了（或本来没有基准）= 这一条重新解过。
      reparsed: reply.treeId !== baseTreeId,
      queryMs: reply.metrics.queryMs,
      loadMs: 0,
    };
    if (type === 'parse') {
      const parsed: Kojo2ParseReply = {
        ok: true,
        id: reply.id,
        type: 'parse',
        version: reply.version,
        treeId: reply.treeId,
        incremental: reply.incremental,
        // kojo2 这一族不消费改动段（v1 那两个消费方也不看）；v3 里没有这一格
        changedRanges: [],
        textLength: reply.metrics.textLength,
        parseMs: reply.metrics.parseMs,
        loadMs: 0,
      };
      return { ok: true, value: parsed };
    }
    if (type === 'captures') {
      const captures = capturesOf(reply.facets.semantic);
      if (captures === null) {
        return { ok: false, reason: 'query-unavailable', message: 'worker 没回 semantic 面（查询不可用 / 编译失败）', treeId: reply.treeId };
      }
      const value: Kojo2CapturesReply = { ...common, type: 'captures', captures };
      return { ok: true, value };
    }
    if (type === 'folds') {
      const spans = reply.facets.folds?.spans;
      if (spans === undefined) {
        return { ok: false, reason: 'query-unavailable', message: 'worker 没回 folds 面（查询不可用 / 编译失败）', treeId: reply.treeId };
      }
      const folds: Kojo2FoldRange[] = [];
      for (let i = 0; i + 1 < spans.length; i += 2) folds.push({ startRow: spans[i]!, endRow: spans[i + 1]!, kind: 'block' });
      const value: Kojo2FoldsReply = { ...common, type: 'folds', folds };
      return { ok: true, value };
    }
    const rules: Kojo2IndentRules | undefined = reply.facets.indent;
    if (rules === undefined) {
      return { ok: false, reason: 'query-unavailable', message: 'worker 没回 indent 面（查询不可用 / 编译失败）', treeId: reply.treeId };
    }
    const value: Kojo2IndentsReply = { ...common, type: 'indents', rules };
    return { ok: true, value };
  }

  /** v2 回话（双跑窗口的旧路）：与 LAU-1 之前逐字同口径 */
  private receiveV2(data: Kojo2WorkerReply): void {
    const id = (data as { id?: unknown }).id;
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      this.orphanReplies += 1;
      return;
    }
    const pending = this.pendingFor(id);
    if (pending === undefined) return;
    if (!data.ok) {
      pending.resolve(
        data.treeId === undefined
          ? { ok: false, reason: data.reason, message: data.message }
          : { ok: false, reason: data.reason, message: data.message, treeId: data.treeId },
      );
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

  private post(request: StructureRequest): void {
    try {
      this.worker?.postMessage(request);
    } catch (error: unknown) {
      this.markUnavailable(`worker 投递失败：${describeError(error)}`);
    }
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

/** v3 失败原因 → 本族既有的失败词表（上游 `kojo2-semantic.ts` 等只认这一套） */
function reasonOf(reason: StructureFailureReason): Kojo2WorkerFailureReason {
  if (reason === 'unavailable') return 'unavailable';
  if (reason === 'disposed') return 'disposed';
  if (reason === 'invalid-input') return 'invalid-input';
  if (reason === 'parse-failed') return 'parse-failed';
  if (reason === 'query-failed') return 'query-failed';
  if (reason === 'crashed') return 'crashed';
  if (reason === 'protocol-mismatch') return 'protocol-error';
  return 'timeout';
}

/** 扁平捕获表 → `Kojo2Capture[]`（位置从行列还原；LAU-6 起节点类型也从 `nodes` 字典还原） */
function capturesOf(table: StructureCaptureTable | undefined): Kojo2Capture[] | null {
  if (table === undefined) return null;
  const out: Kojo2Capture[] = [];
  const spans = table.spans;
  for (let i = 0; i + 5 < spans.length; i += 6) {
    out.push({
      name: table.names[spans[i + 4]!] ?? '',
      startPosition: { row: spans[i]!, column: spans[i + 1]! },
      endPosition: { row: spans[i + 2]!, column: spans[i + 3]! },
      nodeType: table.nodes[spans[i + 5]!] ?? '',
    });
  }
  return out;
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
