import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { StructureClient } from '../src/monaco/tree-sitter/client';
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import type { KojoStructureIndentRules, KojoStructureToken } from '../src/monaco/tree-sitter/types';
import { STRUCTURE_DEAD_AFTER_FAILURES, STRUCTURE_PROTOCOL_VERSION } from '@kojo/kojo-core';

/**
 * 结构 client 的**装配期门控 / 跨文档隔离 / 失败账本**（真 `StructureClient`（v3），
 * 只有 worker 线程是桩）。
 *
 * 钉三件"每次必现却从未被发现"的恶性时序：
 * (a) **装配期自杀**：`start()` 只发 `open`，worker 要 await 两枚 wasm 才 ready——装配前
 *     发的 parse 注定被拒。门控 = 非 ready 时不发 parse、编辑只留本地快照，ready 一到补发
 *     带最新全文的 parse；
 * (b) **跨文档污染**：version 是每文档各自从 1 起的，切文档瞬间旧文档的在途回复会冒充
 *     新文档的结果上屏。隔离 = 每份文档一枚全局单调 `doc` 序号，对不上号整条丢；
 * (c) **失败账本**：连续 3 次失败判死——ready 前判死整档，ready 后只死当前文档（换文档重计）。
 *
 * 打桩面：`?worker` 换成可编程 FakeWorker（记录 postMessage、测试直接驱动 onmessage 回放
 * worker 行为），`assets` 的 `?url`/`?raw` 在 node 池不装配（这条测试只关心消息次序，
 * 不关心真 URL）。worker 线程本体与真 wasm 归真壳冒烟（`tools/smoke-tauri-*`）。
 */

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
    private terminated = false;
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(data: unknown): void {
      this.sent.push(data);
    }
    terminate(): void {
      this.terminated = true;
    }
    get isTerminated(): boolean {
      return this.terminated;
    }
    /** 测试驱动：以 worker 的口吻回一条消息（只回 data，MessageEvent 的其余字段 client 不看） */
    reply(data: unknown): void {
      this.onmessage?.({ data });
    }
  }
  return { FakeWorker };
});

vi.mock('../src/monaco/tree-sitter/kojo-ts.worker?worker', () => ({ default: harness.FakeWorker }));
vi.mock('../src/monaco/tree-sitter/assets', () => ({
  KOJO_STRUCTURE_ASSETS: {
    kojoWasmUrl: 'kojo.wasm（桩）',
    runtimeWasmUrl: 'runtime.wasm（桩）',
    highlightsQuery: '',
    foldsQuery: '',
    indentsQuery: '',
  },
}));

/** 每门语言交回的运行时（A4）：client 不再自己 import worker / wasm，测试从这一格注入 */
const RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: 'runtime.wasm（桩）',
  grammarWasmUrl: 'kojo.wasm（桩）',
  createWorker: () => new harness.FakeWorker() as unknown as Worker,
};

/* ================================ 脚手架 ================================ */

type Fake = InstanceType<typeof harness.FakeWorker>;

const EMPTY_INDENT = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

/**
 * 一条 `parse` 回话（v3：面合并成 `facets`）。
 *
 * 默认把三面都带上——**缺面是"这一面这次没算"的强信号**（客户端会当场判停），
 * 想考"缺面"的用例显式传 `{ semantic: undefined }`。
 */
function parseReply(
  id: number,
  doc: number,
  version: number,
  facets: Record<string, unknown> = {},
  treeId = 't1',
): Record<string, unknown> {
  return {
    ok: true,
    id,
    kind: 'parse',
    doc,
    version,
    treeId,
    incremental: true,
    facets: { semantic: captureTable(), folds: { spans: [] }, indent: EMPTY_INDENT, ...facets },
    metrics: { parseMs: 1, queryMs: 0, textLength: 1 },
  };
}

/** 捕获表：`[行, 列, 行, 列, nameIndex, nodeIndex]`；`comment` 档在默认档位表里 */
function captureTable(name = 'comment', node = 'x'): Record<string, unknown> {
  return { names: [name], nodes: [node], spans: [0, 0, 0, 1, 0, 0] };
}

const TOKEN_A: KojoStructureToken = { startRow: 0, startCol: 0, endRow: 0, endCol: 1, tier: 'role.comment', capture: 'comment', node: 'x' };
const RULES_A: KojoStructureIndentRules = { increasePatterns: ['^\\s*A$'], decreasePatterns: [], enterPatterns: [] };

type FakeModel = Monaco.editor.ITextModel & { edit(next: string): void };

/**
 * 把"旧文 → 新文"化成 Monaco 会给的那一条 `IModelContentChangedEvent`（单段、前后缀差集）。
 *
 * 假 model 早先只 `fn()` 不带事件，等于**绕开**了被测的增量编辑路（`client.onChanged` 见不到
 * `rangeOffset` 就退回整篇）。这里按真 Monaco 的形状给（行列为 1 基、偏移按旧文 UTF-16 码元），
 * 于是"编辑后发的是差集请求"这条才真的被钉住。
 */
function contentChanged(before: string, after: string): unknown {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const pointAt = (offset: number): { row: number; column: number } => {
    const end = Math.min(Math.max(0, offset), before.length);
    let row = 0;
    let lineStart = 0;
    for (let i = 0; i < end; i += 1) {
      if (before.charCodeAt(i) === 10) {
        row += 1;
        lineStart = i + 1;
      }
    }
    return { row, column: end - lineStart };
  };
  const start = pointAt(prefix);
  const end = pointAt(before.length - suffix);
  return {
    isFlush: false,
    versionId: 0,
    changes: [
      {
        rangeOffset: prefix,
        rangeLength: before.length - suffix - prefix,
        text: after.slice(prefix, after.length - suffix),
        range: {
          startLineNumber: start.row + 1,
          startColumn: start.column + 1,
          endLineNumber: end.row + 1,
          endColumn: end.column + 1,
        },
      },
    ],
  };
}

function fakeModel(text: string): FakeModel {
  let value = text;
  const listeners = new Set<(event: unknown) => void>();
  return {
    getValue: () => value,
    // 行数对账（`client.onChanged` 的自检目标）：**自己数**，不借被测代码的口径
    getLineCount: () => value.split('\n').length,
    isDisposed: () => false,
    onDidChangeContent: (fn: (event: unknown) => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    edit: (next: string) => {
      const event = contentChanged(value, next);
      value = next;
      for (const fn of [...listeners]) fn(event);
    },
  } as unknown as FakeModel;
}

/** 等待票走 `window.setTimeout`，node 池给一个直通全局计时器的窄 window */
function fakeWindowTimers(): void {
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** 把微任务排干净（client 的等待者都在 promise 链上） */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** 真等一段墙钟（只用在"越过某张等待票的原始计时器"这类判据上） */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const debugLines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  (spy.mock.calls as unknown[][]).map((call) => String(call[0] ?? '')).filter((line) => line.length > 0);

/** 发出去的请求按 `kind` 归类（`open` 与 `parse` 两种） */
const sentKinds = (worker: Fake): string[] => worker.sent.map((m) => String((m as { kind?: unknown }).kind ?? (m as { type?: unknown }).type));
const lastSent = (worker: Fake): Record<string, unknown> => worker.sent.at(-1) as Record<string, unknown>;

describe('结构 client 装配期门控（open → ready → parse 的次序）', () => {
  let fatalMessages: string[];
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    fatalMessages = [];
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  function makeClient(timeoutMs = 250, bootstrapTimeoutMs = 250): { client: StructureClient; worker: Fake } {
    const client = new StructureClient({
      runtime: RUNTIME,
      languageId: 'kojo',
      timeoutMs,
      bootstrapTimeoutMs,
      onFatal: (m) => fatalMessages.push(m),
    });
    expect(client.start()).toBe(true);
    const worker = harness.FakeWorker.instances.at(-1)!;
    expect(sentKinds(worker)).toEqual(['open']); // start 只发 open
    expect(worker.sent[0]).toMatchObject({ kind: 'open', protocol: STRUCTURE_PROTOCOL_VERSION, languageId: 'kojo' });
    return { client, worker };
  }

  const ready = (worker: Fake, id = 1): void =>
    worker.reply({ ok: true, id, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 5, docBase: 0 });

  it('(a1) 装配没完成不发 parse；ready 一到补发最新全文；期间编辑只留在本地，全程零降级', async () => {
    const { client, worker } = makeClient();
    const model = fakeModel('第一版');
    const pending = client.tokens(model); // track：此刻 status 还是 starting ⇒ 不发 parse
    await flush();
    expect(sentKinds(worker)).toEqual(['open']);
    model.edit('第二版');
    await flush();
    expect(sentKinds(worker)).toEqual(['open']);
    // ready ⇒ 补发 parse，带的是**最新**版本与文本
    ready(worker);
    await flush();
    expect(sentKinds(worker)).toEqual(['open', 'parse']);
    expect(lastSent(worker)).toMatchObject({ kind: 'parse', doc: 1, version: 2, text: '第二版' });
    worker.reply(parseReply(2, 1, 2, { semantic: captureTable() }));
    expect(await pending).toEqual([TOKEN_A]);
    expect(client.state).toBe('ready');
    expect(fatalMessages).toHaveLength(0);
    expect(notices).toHaveLength(0);
    client.dispose();
  });

  it('(a2) 装配完成后 track 当场发 parse（一次、带 doc 号）；之后编辑走差集 parse{edit, baseTreeId}', async () => {
    const { client, worker } = makeClient();
    ready(worker);
    await flush();
    expect(client.state).toBe('ready');
    const model = fakeModel('已装配');
    void client.tokens(model);
    expect(sentKinds(worker)).toEqual(['open', 'parse']);
    expect(lastSent(worker)).toMatchObject({ kind: 'parse', doc: 1, version: 1, text: '已装配' });
    worker.reply(parseReply(2, 1, 1, { semantic: captureTable() }));
    await flush();
    // ready 后的编辑恢复正常增量口径：差集 + 基线树身份
    model.edit('已装配!');
    await flush();
    expect(lastSent(worker)).toMatchObject({ kind: 'parse', doc: 1, version: 2, baseTreeId: 't1' });
    expect((lastSent(worker) as { edit?: unknown }).edit, '差集请求必须带 edit').toBeDefined();
    expect((lastSent(worker) as { text?: unknown }).text, '差集请求不许再带整篇').toBeUndefined();
    client.dispose();
  });

  it('(a2b) 差集把基线树搞丢了（worker 说 parse-failed）⇒ 当场重发整篇，且不记成失败', async () => {
    const { client, worker } = makeClient();
    ready(worker);
    const model = fakeModel('已装配');
    void client.tokens(model);
    worker.reply(parseReply(2, 1, 1, { semantic: captureTable() }));
    await flush();
    model.edit('已装配!');
    await flush();
    const editId = (lastSent(worker) as { id: number }).id;
    worker.reply({ ok: false, id: editId, kind: 'parse', reason: 'parse-failed', message: 'baseTreeId 不认识' });
    await flush();
    expect(lastSent(worker), '兜底 = 重发整篇').toMatchObject({ kind: 'parse', text: '已装配!', version: 2 });
    expect(notices, '这是协议的正常兜底，不是故障').toHaveLength(0);
    client.dispose();
  });

  it('(a3) 装配期连续失败到阈值 ⇒ 整档停用（拆线程、等待者拿 null）', async () => {
    const { client, worker } = makeClient(20, 20);
    const pending = client.tokens(fakeModel('x'));
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    expect(worker.isTerminated).toBe(true);
    expect(fatalMessages).toHaveLength(1);
    client.dispose();
  });

  it('(a4) wasm 装不上（ok:false / wasm-load-failed）同样走失败账本：到阈值整档停用', async () => {
    const { client, worker } = makeClient();
    const pending = client.tokens(fakeModel('x'));
    await flush();
    const openId = (worker.sent[0] as { id: number }).id;
    for (let round = 0; round < STRUCTURE_DEAD_AFTER_FAILURES; round += 1) {
      worker.reply({ ok: false, id: openId, kind: 'open', reason: 'wasm-load-failed', message: '.kojo 语法载入失败' });
      await flush();
    }
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    expect(fatalMessages[0]).toContain('语法载入失败');
    client.dispose();
  });
});

describe('跨文档结果隔离（doc 序号对不上号就丢）', () => {
  let fatalMessages: string[];
  let notices: string[];
  let unsubscribe: (() => void) | null = null;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    fatalMessages = [];
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  function readyClient(timeoutMs = 250): { client: StructureClient; worker: Fake } {
    const client = new StructureClient({ runtime: RUNTIME, timeoutMs, onFatal: (m) => fatalMessages.push(m) });
    client.start();
    const worker = harness.FakeWorker.instances.at(-1)!;
    worker.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
    return { client, worker };
  }

  it('(b1) 切文档后旧文档迟到的结果冒充不了新文档（曾经：A 的 tokens 被存进 B 的缓存上屏）', async () => {
    const { client, worker } = readyClient();
    const tokensA = client.tokens(fakeModel('A 文本'));
    await flush();
    const aRequest = lastSent(worker) as { id: number; doc: number };
    expect(aRequest).toMatchObject({ kind: 'parse', doc: 1, version: 1 });
    const tokensB = client.tokens(fakeModel('B 文本'));
    await flush();
    const bRequest = lastSent(worker) as { id: number; doc: number };
    expect(bRequest).toMatchObject({ kind: 'parse', doc: 2, version: 1 });
    // A 的回复此刻才到（version=1 与 B 相同 ⇒ 旧代码只按版本判会放行）
    worker.reply(parseReply(aRequest.id, 1, 1, { semantic: captureTable('keyword') }));
    await flush();
    let bSettled = false;
    void tokensB.then(() => (bSettled = true));
    await flush();
    expect(bSettled).toBe(false); // A 的回复没放行 B 的等待者，更没进 B 的缓存
    // 换轨后的迟到回复是**正常丢弃**：作者面零通知（那是 error 弹窗），开发面一条 debug
    expect(notices).toHaveLength(0);
    expect(debugLines(debug).filter((line) => line.includes('正常丢弃')).length).toBeGreaterThanOrEqual(1);
    // B 自己的回复才放行，且拿到的就是 B 的 tokens
    worker.reply(parseReply(bRequest.id, 2, 1, { semantic: captureTable('comment') }));
    expect(await tokensB).toEqual([TOKEN_A]);
    expect(await tokensA).toBeNull(); // A 的调用者换轨后拿 null，绝不串到 B 的数据
    expect(fatalMessages).toHaveLength(0);
    client.dispose();
  });

  it('(b2) 折叠 / 缩进同样对号：旧文档的折叠区间与缩进规则进不了新文档', async () => {
    const { client, worker } = readyClient();
    const foldsA = client.foldingRanges(fakeModel('A 文本'));
    await flush();
    const aRequest = lastSent(worker) as { id: number };
    const foldsB = client.foldingRanges(fakeModel('B 文本'));
    await flush();
    const bRequest = lastSent(worker) as { id: number };
    worker.reply(parseReply(aRequest.id, 1, 1, { folds: { spans: [0, 9] }, indent: RULES_A })); // 旧文档
    await flush();
    expect(client.indent).toBeNull(); // 缩进规则没被旧文档污染
    expect(await foldsA).toBeNull();
    worker.reply(parseReply(bRequest.id, 2, 1, { folds: { spans: [1, 2] } }));
    expect(await foldsB).toEqual([{ startRow: 1, endRow: 2 }]);
    expect(client.state).toBe('ready');
    client.dispose();
  });

  it('(b3) 同文档的过期版本仍按既有口径丢弃（版本闸没有被 doc 闸取代），且只落开发面', async () => {
    const { client, worker } = readyClient();
    const model = fakeModel('A 文本');
    const pending = client.tokens(model);
    await flush();
    const first = lastSent(worker) as { id: number };
    // 编辑 ⇒ 版本 2（差集已发出），此时冒一条旧的 v1 结果必须被丢
    model.edit('A 文本!');
    await flush();
    worker.reply(parseReply(first.id, 1, 1, { semantic: captureTable() }));
    await flush();
    expect(notices).toHaveLength(0);
    expect(debugLines(debug).filter((line) => line.includes('收到版本 1'))).toHaveLength(1);
    expect(client.state).toBe('ready');
    // 等待者仍挂着（v2 未到）；补上 B 文档版本的回答后放行
    worker.reply(parseReply(999, 1, 2, { semantic: captureTable() }));
    await flush();
    expect(await pending, '还没拿到当前版本 ⇒ 这一面这次不顶上').toBeNull();
    client.dispose();
  });
});

describe('失败账本与面缺失（连续 3 次判死 / 缺面即停）', () => {
  let fatalMessages: string[];
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    fatalMessages = [];
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  function readyClient(timeoutMs = 60): { client: StructureClient; worker: Fake } {
    const client = new StructureClient({ runtime: RUNTIME, timeoutMs, bootstrapTimeoutMs: 60, onFatal: (m) => fatalMessages.push(m) });
    client.start();
    const worker = harness.FakeWorker.instances.at(-1)!;
    worker.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
    return { client, worker };
  }

  it('(c1) ready 之后超时到阈值：只死当前文档那一面，换文档重计（整档不哑火）', async () => {
    const { client, worker } = readyClient(30);
    const modelA = fakeModel('A 文本');
    expect(await client.tokens(modelA)).toBeNull();
    expect(await client.tokens(modelA)).toBeNull();
    expect(await client.tokens(modelA)).toBeNull();
    expect(client.state).toBe('ready'); // 没有 onFatal：整档还在
    expect(fatalMessages).toHaveLength(0);
    expect(notices.some((n) => n.includes('这一份文档的结构层不再等')), JSON.stringify(notices)).toBe(true);
    // 换文档 ⇒ 重新计（新 parse 照发）
    const modelB = fakeModel('B 文本');
    const pendingB = client.tokens(modelB);
    await flush();
    const request = lastSent(worker) as { id: number; doc: number };
    expect(request.doc).toBe(2);
    worker.reply(parseReply(request.id, 2, 1, { semantic: captureTable() }));
    expect(await pendingB).toEqual([TOKEN_A]);
    client.dispose();
  });

  it('(c2) 回话里缺一面（查询不可用）⇒ 这一面停用并说一次，另一面照常', async () => {
    const { client, worker } = readyClient();
    const model = fakeModel('A 文本');
    const pending = client.tokens(model);
    await flush();
    // 每一拍只回它要的那几面（真 worker 就是这样：`want` 之外的面不进 `facets`）
    const replyFacets = (facets: Record<string, unknown>): void => {
      const request = lastSent(worker) as { id: number };
      worker.reply({ ...parseReply(request.id, 1, 1), facets });
    };
    // 首帧分层（R8）：折叠那一拍没问语义 ⇒ 它缺语义**不算**"没来"（那一面排在后面那一拍）
    replyFacets({ folds: { spans: [0, 3] } });
    await flush();
    expect(notices.filter((n) => n.startsWith('semantic/query')), '没问过的面不判死').toHaveLength(0);
    // 轮到问语义的那一拍，它仍然没来 ⇒ 这才是"查询不可用"
    replyFacets({});
    expect(await pending).toBeNull();
    expect(notices.filter((n) => n.startsWith('semantic/query'))).toHaveLength(1);
    expect(await client.foldingRanges(model)).toEqual([{ startRow: 0, endRow: 3 }]);
    expect(await client.tokens(model), '这一面已停用 ⇒ 不再等').toBeNull();
    client.dispose();
  });

  it('(c3) 成功一条就把连续失败清零（偶发超时不该攒成判死）', async () => {
    const { client, worker } = readyClient(30);
    const model = fakeModel('A 文本');
    expect(await client.tokens(model)).toBeNull(); // 失败 1（请求到点）
    expect(await client.tokens(model)).toBeNull(); // 失败 2（等待票到点）
    // 编辑触发一条新请求，worker 当场回话 ⇒ 成功一条，计数清零
    model.edit('A 文本!');
    await flush();
    const request = lastSent(worker) as { id: number };
    worker.reply(parseReply(request.id, 1, 2, { semantic: captureTable() }));
    expect(await client.tokens(model)).toEqual([TOKEN_A]);
    // 清零验真：编辑之后那条请求卡住（不回话）⇒ 只算 1 次失败，这一面没被判死
    model.edit('A 文本!!');
    await flush();
    expect(await client.tokens(model)).toBeNull();
    model.edit('A 文本!!!');
    await flush();
    const second = lastSent(worker) as { id: number };
    worker.reply(parseReply(second.id, 1, 4, { semantic: captureTable() }));
    expect(await client.tokens(model)).toEqual([TOKEN_A]);
    expect(client.state).toBe('ready');
    expect(fatalMessages).toHaveLength(0);
    client.dispose();
  });
});

/* ================== 等待票按文档对号 · 正常丢弃 · 版本读点 ================== */

describe('等待票 / 正常丢弃 / 版本读点', () => {
  let fatalMessages: string[];
  let notices: string[];
  let unsubscribe: (() => void) | null = null;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    fatalMessages = [];
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  function readyClient(timeoutMs = 250): { client: StructureClient; worker: Fake } {
    const client = new StructureClient({ runtime: RUNTIME, timeoutMs, onFatal: (m) => fatalMessages.push(m) });
    client.start();
    const worker = harness.FakeWorker.instances.at(-1)!;
    worker.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
    return { client, worker };
  }

  it('(d1) 换轨后旧文档的计时器到点不把 dead 打给新文档', async () => {
    const { client, worker } = readyClient(120);
    const modelA = fakeModel('A 文本');
    const pendingA = client.tokens(modelA);
    await flush();
    await sleep(80); // A 的票走掉大半
    const modelB = fakeModel('B 文本');
    const pendingB = client.tokens(modelB);
    expect(await pendingA).toBeNull();
    await sleep(60);
    expect(client.state).toBe('ready');
    const requestB = lastSent(worker) as { id: number; doc: number };
    worker.reply(parseReply(requestB.id, 2, 1, { semantic: captureTable() }));
    expect(await pendingB).toEqual([TOKEN_A]);
    // B 这一面没被判死：再问一次直接吃缓存
    expect(await client.tokens(modelB)).toEqual([TOKEN_A]);
    expect(notices).toHaveLength(0);
    expect(fatalMessages).toHaveLength(0);
    client.dispose();
  });

  it('(d2) 快速打字：落后一版的回复是正常丢弃——作者面零通知', async () => {
    const { client, worker } = readyClient();
    const model = fakeModel('A 文本');
    const pending = client.tokens(model);
    await flush();
    const first = lastSent(worker) as { id: number };
    worker.reply(parseReply(first.id, 1, 1, { semantic: captureTable() }));
    expect(await pending).toEqual([TOKEN_A]);
    model.edit('A 文本!');
    model.edit('A 文本!!');
    await flush();
    worker.reply(parseReply(first.id, 1, 1, { semantic: captureTable() }));
    await flush();
    expect(notices).toHaveLength(0);
    expect(debugLines(debug).filter((line) => line.includes('正常丢弃')).length).toBeGreaterThanOrEqual(1);
    client.dispose();
  });

  it('(d3) 已有结果但版本落后：取数等当前版本，不把旧 tokens 直接交上去', async () => {
    const { client, worker } = readyClient();
    const model = fakeModel('A 文本');
    const first = client.tokens(model);
    await flush();
    const firstRequest = lastSent(worker) as { id: number };
    worker.reply(parseReply(firstRequest.id, 1, 1, { semantic: captureTable() }));
    expect(await first).toEqual([TOKEN_A]);
    model.edit('A 文本!');
    await flush();
    const editRequest = lastSent(worker) as { id: number };
    let settled = false;
    const second = client.tokens(model);
    void second.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false); // 缓存里只有 v1 的结果，必须等 v2
    worker.reply(parseReply(editRequest.id, 1, 2, { semantic: captureTable('keyword') }));
    expect(await second).toEqual([{ ...TOKEN_A, tier: 'role.keyword', capture: 'keyword' }]);
    expect(await client.tokens(model)).toEqual([{ ...TOKEN_A, tier: 'role.keyword', capture: 'keyword' }]);
    expect(notices).toHaveLength(0);
    client.dispose();
  });
});
