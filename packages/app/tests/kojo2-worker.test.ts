/**
 * Kojo 2.0 结构解析 worker 的闸（K2-TS-WORKER）。
 *
 * ## 打的是什么
 *
 * - **主线程客户端**（`kojo2-worker-runtime.ts`）用可编程 `FakeWorker` 驱动：请求-响应配对、
 *   超时丢弃、dispose、启动失败、线程崩溃，全部按真实消息次序回放；
 * - **worker 本体**（`kojo2-worker.ts`）用**进程内回环**（`InProcessWorker`）驱动真 wasm：
 *   `postMessage` 进 `engine.handle()`，回复再走 `onmessage`——除"跨线程结构化克隆"之外，
 *   消息环与生产逐字相同（vitest node 池没有真 `Worker`，这条边界写在报告里）；
 * - **5,000 行合成档**：真 wasm、真查询，测首解 / 增量解 / 捕获三段墙钟并打印读数。
 *
 * ## 5k 读数的口径（不是猜的）
 *
 * - 计时器：`process.hrtime.bigint()`（纳秒级，避免 `Date.now()` 的 1ms 粒度）；
 * - "首解"：**包含** worker 内运行时装载（`Parser.init` + 语法 wasm + 三份查询编译）的
 *   首条 `parse` 往返——这是作者打开文件时真正要等的那一段；回复里的 `loadMs` 单独打印，
 *   方便看到"装载 vs 解析"各占多少；
 * - "增量解"：改中间一行（块体里的一处文本）后带 `oldTreeId` 的 `parse` 往返；
 * - "捕获"：增量解之后带 `treeId` 的 `captures`（worker 侧 `reparsed: false`，只跑查询）；
 * - 预算：首解 **< 500ms**、增量 **< 100ms**（本机空载实测见 `docs/STATE.md` 同批读数；
 *   本文件运行时会把真实值 `console.log` 出来）。CI 放宽系数：`CI=1` 时 ×4，
 *   也可用 `KOJO2_PERF_SLACK=<n>` 显式覆盖（`>=1`）。
 *
 * 这条计时用例**留在功能池**（文件不叫 `*.perf.test.ts`，计时也不用 DOM 的 performance 时钟）：
 * 判据是极松的绝对上界（实测余量 5–15 倍），且必须和 worker 功能断言同进程跑（共享同一份
 * wasm 装载）。若将来它在共享 runner 上反复翻线，正确做法是把它拆成
 * `kojo2-worker.perf.test.ts` 进串行静默池，而不是放宽到没有意义。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KOJO2_WORKER_BOOTSTRAP_TIMEOUT_MS,
  KOJO2_WORKER_TIMEOUT_MS,
  type Kojo2CapturesReply,
  type Kojo2FoldsReply,
  type Kojo2ParseReply,
  type Kojo2WorkerReply,
  type Kojo2WorkerRequest,
} from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import {
  createKojo2WorkerEngine,
  foldsFromCaptures,
  type Kojo2WorkerEngine,
} from '../src/monaco/tree-sitter/kojo2-worker';
import {
  Kojo2WorkerClient,
  disposeKojo2WorkerClient,
  getKojo2WorkerClient,
  type Kojo2WorkerClientOptions,
} from '../src/monaco/tree-sitter/kojo2-worker-runtime';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
  type Kojo2RuntimeDeps,
} from '../src/monaco/tree-sitter/kojo2-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/app/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_WASM = join(SYNTAX_ROOT, 'tree-sitter-kojo2.wasm');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');

const FULL_TEXT = readFileSync(FULL_FIXTURE, 'utf8');

/* ============================ 可编程 FakeWorker ============================ */

const harness = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static reset(): void {
      FakeWorker.instances = [];
    }
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    readonly sent: unknown[] = [];
    terminated = false;
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(data: unknown): void {
      this.sent.push(data);
    }
    terminate(): void {
      this.terminated = true;
    }
    /** 测试驱动：以 worker 的口吻回一条消息 */
    reply(data: unknown): void {
      this.onmessage?.({ data });
    }
    /** 测试驱动：模拟线程级未捕获异常 */
    error(message: string): void {
      this.onerror?.({ message });
    }
  }
  return { FakeWorker };
});

// 主线程侧对 `?worker` 的静态 import 在 node 池里没有 Vite 装配：换成可编程替身。
vi.mock('../src/monaco/tree-sitter/kojo2-ts.worker?worker', () => ({ default: harness.FakeWorker }));

type FakeWorkerInstance = InstanceType<typeof harness.FakeWorker>;

/* ============================ 进程内回环 worker（真 wasm 用） ============================ */

function inProcessWorker(engine: Kojo2WorkerEngine): Worker {
  const target = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(data: unknown): void {
      // 真 worker 的 postMessage 是跨线程投递：这里用 microtask 模拟"不同步返回"，
      // 保证客户端不会在 `postMessage` 里重入 receive（那会掩盖配对/超时的时序 bug）。
      queueMicrotask(() => {
        void engine.handle(data as Kojo2WorkerRequest).then((reply) => {
          target.onmessage?.({ data: reply } as MessageEvent<unknown>);
        });
      });
    },
    terminate(): void {
      /* 进程内没有线程可杀：engine.dispose() 由用例收尾 */
    },
  };
  return target as unknown as Worker;
}

function realRuntimeDeps(): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: GRAMMAR_WASM,
      highlightsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/highlights.scm'), 'utf8'),
      foldsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/folds.scm'), 'utf8'),
      indentsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/indents.scm'), 'utf8'),
    }),
  };
}

const engines: Kojo2WorkerEngine[] = [];
const clients: Kojo2WorkerClient[] = [];

function realPair(): { client: Kojo2WorkerClient; engine: Kojo2WorkerEngine } {
  const engine = createKojo2WorkerEngine({
    loadRuntime: () => getKojo2TreeSitterRuntime(realRuntimeDeps()),
  });
  const client = new Kojo2WorkerClient({
    createWorker: () => inProcessWorker(engine),
    // 真 wasm 首解要等装载：给足预算（生产默认 8s 引导期；这里再加一点给 CI）
    bootstrapTimeoutMs: 15_000,
    timeoutMs: 5_000,
    warn: () => undefined,
  });
  engines.push(engine);
  clients.push(client);
  return { client, engine };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const engine of engines.splice(0)) engine.dispose();
  disposeKojo2WorkerClient();
  await disposeKojo2TreeSitterRuntime();
  harness.FakeWorker.reset();
  vi.restoreAllMocks();
});

/* ============================ 脚手架 ============================ */

interface FakePair {
  readonly client: Kojo2WorkerClient;
  readonly worker: FakeWorkerInstance;
  readonly created: FakeWorkerInstance[];
}

function makeClient(overrides: Kojo2WorkerClientOptions = {}): FakePair {
  const created: FakeWorkerInstance[] = [];
  const client = new Kojo2WorkerClient({
    createWorker: () => {
      const worker = new harness.FakeWorker();
      created.push(worker);
      return worker as unknown as Worker;
    },
    timeoutMs: 40,
    bootstrapTimeoutMs: 40,
    warn: () => undefined,
    ...overrides,
  });
  // 建线程是懒的：发第一条请求才 `new Worker`
  const worker = (): FakeWorkerInstance => {
    if (created.length === 0) client.start();
    return created.at(-1)!;
  };
  return {
    client,
    get worker() {
      return worker();
    },
    created,
  } as FakePair;
}

/** 把微任务排干净（客户端与回环 worker 都用 promise 链） */
async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function parseReply(id: number, treeId: string, options: Partial<Kojo2ParseReply> = {}): Kojo2ParseReply {
  return {
    ok: true,
    id,
    type: 'parse',
    version: 1,
    treeId,
    incremental: false,
    changedRanges: [],
    textLength: 1,
    parseMs: 0,
    loadMs: 0,
    ...options,
  };
}

function capturesReply(id: number, treeId: string, captures: Kojo2CapturesReply['captures'] = []): Kojo2CapturesReply {
  return {
    ok: true,
    id,
    type: 'captures',
    version: 1,
    treeId,
    captures,
    incremental: false,
    reparsed: false,
    queryMs: 0,
    loadMs: 0,
  };
}

function foldsReply(id: number, treeId: string, folds: Kojo2FoldsReply['folds'] = []): Kojo2FoldsReply {
  return {
    ok: true,
    id,
    type: 'folds',
    version: 1,
    treeId,
    folds,
    incremental: false,
    reparsed: false,
    queryMs: 0,
    loadMs: 0,
  };
}

function sentOf(worker: FakeWorkerInstance): Kojo2WorkerRequest[] {
  return worker.sent as Kojo2WorkerRequest[];
}

/* ============================ 请求-响应配对 ============================ */

describe('客户端 · 请求-响应配对（按 id，不按到达顺序）', () => {
  it('两条在途请求乱序回话：各自拿到自己 id 的结果', async () => {
    const { client, worker } = makeClient();
    const parse = client.parse('> 一。\n', 1);
    const captures = client.captures('> 一。\n', 1);
    expect(sentOf(worker).map((request) => request.type)).toEqual(['parse', 'captures']);
    const [parseRequest, capturesRequest] = sentOf(worker);

    // 后发的先回：配对只认 id，不许拿"最近一条"凑
    worker.reply(capturesReply(capturesRequest!.id, 'tree-caps'));
    worker.reply(parseReply(parseRequest!.id, 'tree-parse'));

    const [parsed, captured] = await Promise.all([parse, captures]);
    expect(parsed.ok).toBe(true);
    expect(captured.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.treeId).toBe('tree-parse');
    if (captured.ok) expect(captured.value.treeId).toBe('tree-caps');
    expect(client.pendingCount).toBe(0);
    expect(client.state).toBe('ready');
  });

  it('回话 type 与请求不符 ⇒ protocol-error（两侧版本错位的可判别信号）', async () => {
    const { client, worker } = makeClient();
    const request = client.parse('> 一。\n', 1);
    const sent = sentOf(worker)[0]!;
    worker.reply({ ...foldsReply(sent.id, 'tree-x'), type: 'folds' });
    const result = await request;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('protocol-error');
  });

  it('id 对不上任何在途请求 ⇒ 计入迟到数，且不误 settle 别的请求', async () => {
    const { client, worker } = makeClient();
    const request = client.parse('> 一。\n', 1);
    worker.reply(parseReply(999, 'tree-ghost'));
    await flush();
    expect(client.lateReplyCount).toBe(1);
    expect(client.pendingCount).toBe(1);
    const sent = sentOf(worker)[0]!;
    worker.reply(parseReply(sent.id, 'tree-real'));
    const result = await request;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.treeId).toBe('tree-real');
  });

  it('形状不符的回话（null / 空对象 / id 不是数）只计入孤儿，不抛', () => {
    const { client, worker } = makeClient();
    client.start();
    expect(() => {
      worker.reply(null);
      worker.reply({});
      worker.reply({ id: 'nope' });
    }).not.toThrow();
    expect(client.orphanReplyCount).toBe(3);
    expect(client.pendingCount).toBe(0);
  });
});

/* ============================ 超时与丢弃 ============================ */

describe('客户端 · 超时丢弃与 dispose', () => {
  it('默认预算：稳态 2s、引导期 8s（常量即契约）', () => {
    expect(KOJO2_WORKER_TIMEOUT_MS).toBe(2_000);
    expect(KOJO2_WORKER_BOOTSTRAP_TIMEOUT_MS).toBe(8_000);
  });

  it('无回话 ⇒ timeout、待办表清空、客户端继续可用', async () => {
    const { client, worker } = makeClient({ timeoutMs: 15, bootstrapTimeoutMs: 15 });
    const first = await client.parse('> 一。\n', 1);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toBe('timeout');
    expect(client.pendingCount).toBe(0);

    const second = client.parse('> 二。\n', 2);
    const sent = sentOf(worker)[1]!;
    worker.reply(parseReply(sent.id, 'tree-2'));
    const result = await second;
    expect(result.ok).toBe(true);
  });

  it('超时之后迟到的回话被丢弃：不改已定的 timeout，只记一笔', async () => {
    const { client, worker } = makeClient({ timeoutMs: 15, bootstrapTimeoutMs: 15 });
    const request = client.parse('> 一。\n', 1);
    const result = await request;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
    const sent = sentOf(worker)[0]!;
    worker.reply(parseReply(sent.id, 'tree-late'));
    await flush();
    expect(client.lateReplyCount).toBe(1);
    expect(result.ok).toBe(false); // 同一枚 result 不会被迟到回话改写
  });

  it('dispose 幂等：在途请求 resolve 成 disposed、线程只 terminate 一次、之后不再投递', async () => {
    const { client, worker } = makeClient({ timeoutMs: 1_000 });
    const pending = client.parse('> 一。\n', 1);
    const sentCount = sentOf(worker).length;
    client.dispose();
    client.dispose();
    expect(worker.terminated).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('disposed');
    expect(client.pendingCount).toBe(0);

    const after = await client.parse('> 二。\n', 2);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('disposed');
    expect(sentOf(worker)).toHaveLength(sentCount);
  });
});

/* ============================ 失败面 ============================ */

describe('客户端 · 启动失败 / 线程崩溃 / 业务失败都是可判别数据', () => {
  it('建 worker 抛错 ⇒ start false、请求 unavailable、warn 只一次、不抛', async () => {
    const warn = vi.fn();
    const client = new Kojo2WorkerClient({
      createWorker: () => {
        throw new Error('没有 Worker');
      },
      warn,
      timeoutMs: 20,
      bootstrapTimeoutMs: 20,
    });
    expect(client.start()).toBe(false);
    const first = await client.parse('> 一。\n', 1);
    const second = await client.captures('> 一。\n', 1);
    for (const result of [first, second]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unavailable');
    }
    expect(client.state).toBe('unavailable');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('没有 Worker');
  });

  it('worker onerror ⇒ 在途请求收 crashed、状态 unavailable、线程 terminate', async () => {
    const { client, worker } = makeClient({ timeoutMs: 1_000 });
    const request = client.parse('> 一。\n', 1);
    worker.error('线程炸了');
    const result = await request;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('crashed');
    expect(client.state).toBe('unavailable');
    expect(worker.terminated).toBe(true);
    expect(client.pendingCount).toBe(0);
  });

  it('postMessage 抛错 ⇒ 该请求收 crashed、状态 unavailable（不留下未 settle 的 promise）', async () => {
    let terminated = false;
    const client = new Kojo2WorkerClient({
      createWorker: () =>
        ({
          onmessage: null,
          onerror: null,
          postMessage: () => {
            throw new Error('管道已断');
          },
          terminate: () => {
            terminated = true;
          },
        }) as unknown as Worker,
      timeoutMs: 20,
      bootstrapTimeoutMs: 20,
      warn: () => undefined,
    });
    const result = await client.parse('> 一。\n', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('crashed');
    expect(client.state).toBe('unavailable');
    expect(terminated).toBe(true);
    expect(client.pendingCount).toBe(0);
  });

  it('worker 的业务失败原样透传（parse-failed / query-unavailable / treeId）', async () => {
    const { client, worker } = makeClient();
    const parse = client.parse('> 一。\n', 3);
    const parseSent = sentOf(worker)[0]!;
    worker.reply({ ok: false, id: parseSent.id, type: 'parse', reason: 'parse-failed', message: '树没了' });
    const parseResult = await parse;
    expect(parseResult.ok).toBe(false);
    if (!parseResult.ok) {
      expect(parseResult.reason).toBe('parse-failed');
      expect(parseResult.message).toBe('树没了');
    }

    const captures = client.captures('> 一。\n', 4);
    const capturesSent = sentOf(worker)[1]!;
    worker.reply({
      ok: false,
      id: capturesSent.id,
      type: 'captures',
      reason: 'query-unavailable',
      message: '查询缺席',
      treeId: 'tree-survives',
    });
    const capturesResult = await captures;
    expect(capturesResult.ok).toBe(false);
    if (!capturesResult.ok) {
      expect(capturesResult.reason).toBe('query-unavailable');
      expect(capturesResult.treeId).toBe('tree-survives');
    }
  });
});

/* ============================ 单例 ============================ */

describe('单例', () => {
  it('并发取到同一实例；dispose 后下一次重新建', () => {
    const first = getKojo2WorkerClient({ createWorker: () => new harness.FakeWorker() as unknown as Worker });
    const second = getKojo2WorkerClient();
    expect(second).toBe(first);
    disposeKojo2WorkerClient();
    const third = getKojo2WorkerClient({ createWorker: () => new harness.FakeWorker() as unknown as Worker });
    expect(third).not.toBe(first);
  });
});

/* ============================ 请求字段形状 ============================ */

describe('请求字段形状（协议真源 = kojo2-worker-protocol.ts）', () => {
  it('四种 type 都带 id / version / text，oldTreeId 只在给了时才出现', () => {
    const { client, worker } = makeClient();
    void client.parse('parse-text', 1, 'tree-old');
    void client.captures('caps-text', 2);
    void client.folds('folds-text', 3, 'tree-2');
    void client.indents('indents-text', 4);
    expect(worker.sent).toEqual([
      { id: 1, type: 'parse', text: 'parse-text', version: 1, oldTreeId: 'tree-old' },
      { id: 2, type: 'captures', text: 'caps-text', version: 2 },
      { id: 3, type: 'folds', text: 'folds-text', version: 3, oldTreeId: 'tree-2' },
      { id: 4, type: 'indents', text: 'indents-text', version: 4 },
    ]);
  });
});

/* ============================ 真 wasm（进程内回环） ============================ */

describe('真 wasm · parse / captures / folds / indents（worker 本体）', () => {
  it('首解整篇；captures 带 treeId 时不重解；增量 parse 真正用上旧树', async () => {
    const { client } = realPair();
    const parsed = await client.parse(FULL_TEXT, 1);
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.type).toBe('parse');
    expect(parsed.value.incremental).toBe(false);
    expect(parsed.value.textLength).toBe(FULL_TEXT.length);
    expect(parsed.value.treeId.length).toBeGreaterThan(0);

    const captured = await client.captures(FULL_TEXT, 1, parsed.value.treeId);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.reparsed).toBe(false); // 文本没变 ⇒ 只查不解
    expect(captured.value.captures.length).toBeGreaterThan(100);
    const names = new Set(captured.value.captures.map((capture) => capture.name));
    expect(names.has('keyword')).toBe(true);
    expect(names.has('string')).toBe(true);

    const edited = FULL_TEXT.replace('斑驳地', '柔和地');
    expect(edited).not.toBe(FULL_TEXT);
    const incremental = await client.parse(edited, 2, parsed.value.treeId);
    expect(incremental.ok).toBe(true);
    if (!incremental.ok) return;
    expect(incremental.value.incremental).toBe(true);
    expect(incremental.value.changedRanges).toHaveLength(1);
    expect(incremental.value.treeId).not.toBe(parsed.value.treeId);
  });

  it('同一棵旧树不许二次当增量基准：旧 treeId 再用 ⇒ 整篇重解，结果仍正确', async () => {
    const { client } = realPair();
    const first = await client.parse('> 第一版。\n', 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await client.parse('> 第二版。\n', 2, first.value.treeId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.incremental).toBe(true);
    // 旧树在 worker 里已被 `tree.edit` 改写过并释放：再用同一 id 只能整篇重解
    const third = await client.parse('> 第三版，长一点。\n', 3, first.value.treeId);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.incremental).toBe(false);
  });

  it('folds 真跑：`(block) @fold` 产生 endRow > startRow 的升序区间', async () => {
    const { client } = realPair();
    const parsed = await client.parse(FULL_TEXT, 1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const folds = await client.folds(FULL_TEXT, 1, parsed.value.treeId);
    expect(folds.ok, folds.ok ? '' : folds.message).toBe(true);
    if (!folds.ok) return;
    expect(folds.value.folds.length).toBeGreaterThan(0);
    for (const fold of folds.value.folds) {
      expect(fold.endRow).toBeGreaterThan(fold.startRow);
      expect(fold.startRow).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < folds.value.folds.length; i++) {
      const previous = folds.value.folds[i - 1]!;
      const current = folds.value.folds[i]!;
      expect(current.startRow > previous.startRow || current.startRow === previous.startRow).toBe(true);
    }
  });

  it('folds 查询缺席 ⇒ 可判别 query-unavailable（不冒充"没有折叠"）', async () => {
    const engine = createKojo2WorkerEngine({
      loadRuntime: () =>
        getKojo2TreeSitterRuntime({
          loadAssets: async () => ({
            runtimeWasmUrl: RUNTIME_WASM,
            grammarWasm: GRAMMAR_WASM,
            highlightsQuery: readFileSync(join(SYNTAX_ROOT, 'queries/v2/highlights.scm'), 'utf8'),
            // 故意不给 foldsQuery：这一面必须报不可用，而不是回空数组
          }),
        }),
    });
    engines.push(engine);
    const client = new Kojo2WorkerClient({
      createWorker: () => inProcessWorker(engine),
      bootstrapTimeoutMs: 15_000,
      timeoutMs: 5_000,
      warn: () => undefined,
    });
    clients.push(client);
    const result = await client.folds('> 一行。\n', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('query-unavailable');
    expect(result.message).toContain('folds');
  });

  it('indents 真跑：indents.scm 的捕获翻成 increase/enter 规则（2.0 没有收束记号 ⇒ decrease 空）', async () => {
    const { client } = realPair();
    const result = await client.indents('# 表 心情 由 恋慕\n    0..99 疏远\n', 1);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('indents');
    expect(result.value.rules.increasePatterns.length).toBeGreaterThan(0);
    // 回车与 increase 同一批源码（v1 糖侧的 indentOnEnter / increaseIndentPattern 也是同批）
    expect(result.value.rules.enterPatterns).toEqual(result.value.rules.increasePatterns);
    expect(result.value.rules.decreasePatterns).toEqual([]);
    // 规则按"行首锚 + 词形"派生 ⇒ 换表名仍然命中（不是逐字匹配整行）
    const table = result.value.rules.increasePatterns.find((pattern) =>
      new RegExp(pattern).test('# 表 别的名字 由 心情'),
    );
    expect(table, `没有命中「# 表」词形的规则：${result.value.rules.increasePatterns.join(' | ')}`).toBeTruthy();
  });

  it('并发两次 parse：worker 按到达序串行处理，两棵新树互不冒充', async () => {
    const { client } = realPair();
    const [first, second] = await Promise.all([
      client.parse('> 第一份。\n', 1),
      client.parse('> 第二份。\n', 2),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.version).toBe(1);
    expect(second.value.version).toBe(2);
    expect(first.value.treeId).not.toBe(second.value.treeId);
    expect(first.value.incremental).toBe(false);
    expect(second.value.incremental).toBe(false); // 没给 oldTreeId ⇒ 不拿第一条当基准
  });

  it('foldsFromCaptures：只认 @fold、只留跨行、去重并排序', () => {
    const folds = foldsFromCaptures([
      { name: 'fold', startPosition: { row: 3, column: 0 }, endPosition: { row: 5, column: 0 } },
      { name: 'fold', startPosition: { row: 1, column: 0 }, endPosition: { row: 2, column: 0 } },
      { name: 'fold', startPosition: { row: 3, column: 0 }, endPosition: { row: 5, column: 0 } }, // 重复
      { name: 'string', startPosition: { row: 7, column: 0 }, endPosition: { row: 9, column: 0 } }, // 不是 fold
      { name: 'fold', startPosition: { row: 9, column: 0 }, endPosition: { row: 9, column: 0 } }, // 单行不算
    ]);
    expect(folds).toEqual([
      { startRow: 1, endRow: 2, kind: 'block' },
      { startRow: 3, endRow: 5, kind: 'block' },
    ]);
  });
});

/* ============================ 5,000 行档 ============================ */

/** 5,000 行合成档：10 行一个完整块（场景 / 台词 / 旁白 / @算 / 赋值 / 条件链 / 收束） */
function syntheticFiveThousand(): string {
  const lines: string[] = [];
  const units = 500;
  for (let n = 0; n < units; n++) {
    lines.push(`# 幕 场景${n}`);
    lines.push(`灵梦：「今天也一起加油吧，第${n}次。」(心形)`);
    lines.push(`> 她把脸别了过去，因为{原因}而不知所措。`);
    lines.push('@算');
    lines.push(`    人数 = 队伍状态.长度 + ${n}`);
    lines.push('    今天已触发 = 人数');
    lines.push('? 恋慕 >= 500');
    lines.push('    > 她停下扫帚，眼神柔和下来。');
    lines.push('? 否');
    lines.push('    灵梦：「……早。」');
  }
  return lines.join('\n');
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const PERF_SLACK = (() => {
  const raw = Number(process.env.KOJO2_PERF_SLACK ?? '');
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return process.env.CI ? 4 : 1;
})();

describe('5,000 行档 · 真 wasm 读数', () => {
  it('首解 < 500ms、增量 < 100ms（CI 放宽 ×4），并打印真实读数', async () => {
    const { client } = realPair();
    const text = syntheticFiveThousand();
    expect(text.split('\n')).toHaveLength(5_000);

    const firstStarted = process.hrtime.bigint();
    const first = await client.parse(text, 1);
    const firstParseMs = elapsedMs(firstStarted);
    expect(first.ok, first.ok ? '' : first.message).toBe(true);
    if (!first.ok) return;
    expect(first.value.incremental).toBe(false);
    expect(first.value.textLength).toBe(text.length);

    // 改中间一行块体里的数字（保持语法合法）
    const edited = text.replace('第250次', '第两百五十次');
    expect(edited).not.toBe(text);
    const incrementalStarted = process.hrtime.bigint();
    const incremental = await client.parse(edited, 2, first.value.treeId);
    const incrementalParseMs = elapsedMs(incrementalStarted);
    expect(incremental.ok, incremental.ok ? '' : incremental.message).toBe(true);
    if (!incremental.ok) return;
    expect(incremental.value.incremental).toBe(true);

    const capturesStarted = process.hrtime.bigint();
    const captured = await client.captures(edited, 2, incremental.value.treeId);
    const capturesMs = elapsedMs(capturesStarted);
    expect(captured.ok, captured.ok ? '' : captured.message).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.reparsed).toBe(false); // 只查不解
    expect(captured.value.captures.length).toBeGreaterThan(500);

    // 读数照实打印（口径见文件头：hrtime、首解含运行时装载、增量 = 改一行）
    console.log(
      `[kojo2-worker] 5k lines=5000 loadMs=${first.value.loadMs.toFixed(1)} ` +
        `firstParseMs=${firstParseMs.toFixed(1)} incrementalParseMs=${incrementalParseMs.toFixed(1)} ` +
        `capturesMs=${capturesMs.toFixed(1)} captures=${captured.value.captures.length} slack=${PERF_SLACK}`,
    );

    expect(firstParseMs, `首解 ${firstParseMs.toFixed(1)}ms（含装载）超预算`).toBeLessThan(500 * PERF_SLACK);
    expect(incrementalParseMs, `增量 ${incrementalParseMs.toFixed(1)}ms 超预算`).toBeLessThan(100 * PERF_SLACK);
  });
});
