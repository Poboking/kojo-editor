import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { StructureClient } from '../src/monaco/tree-sitter/client';
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import type { KojoStructureIndentRules, KojoStructureToken } from '../src/monaco/tree-sitter/types';

/**
 * 结构 client 的**装配期门控与跨文档隔离**（真 `StructureClient`，只有 worker 线程是桩）。
 *
 * 钉两个"每次必现却从未被发现"的恶性时序：
 * (a) **装配期自杀**：`start()` 只发 `init`，worker 要 await 两枚 wasm 才 ready——装配前
 *     发的 parse 注定被拒。门控 = status 非 ready 时 track 不发 parse、编辑只留本地快照，
 *     ready 一到补发带最新全文的 parse；真失败类（形状不符 / wasm / 线程崩 / 超时）语义不动。
 * (b) **跨文档污染**：version 是每文档各自从 1 起的，切文档瞬间旧文档的在途回复会冒充
 *     新文档的结果被缓存上屏。隔离 = 每份文档一枚全局单调 `doc` 序号，worker 回显、
 *     对不上号整条丢。
 *
 * 打桩面：`?worker` 换成可编程 FakeWorker（记录 postMessage、测试直接驱动 onmessage 回放
 * worker 行为），`assets` 的 `?url`/`?raw` 在 node 池不装配（这条测试只关心消息次序，不关心
 * 真 URL）。worker 线程本体与真 wasm 归真壳冒烟（`tools/smoke-tauri-*`）。
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

const TOKEN_A: KojoStructureToken = { startRow: 0, startCol: 0, endRow: 0, endCol: 1, tier: 'comment' };
const TOKEN_B: KojoStructureToken = { startRow: 1, startCol: 0, endRow: 1, endCol: 2, tier: 'keyword.erb' };
const RULES_A: KojoStructureIndentRules = { increasePatterns: ['^\\s*A$'], decreasePatterns: [], enterPatterns: [] };
const RULES_B: KojoStructureIndentRules = { increasePatterns: [], decreasePatterns: ['^\\s*B$'], enterPatterns: [] };

/** 测试用模型：真 ITextModel 投影里测试用得到的几格 + 驱动 `onDidChangeContent` 的 edit */
type FakeModel = Monaco.editor.ITextModel & { edit(next: string): void };

function fakeModel(text: string): FakeModel {
  let value = text;
  const listeners = new Set<() => void>();
  return {
    getValue: () => value,
    isDisposed: () => false,
    onDidChangeContent: (fn: () => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    edit: (next: string) => {
      value = next;
      for (const fn of [...listeners]) fn();
    },
  } as unknown as FakeModel;
}

/** `waitFor` 走 `window.setTimeout`，node 池给一个直通全局计时器的窄 window */
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

const sentTypes = (worker: InstanceType<typeof harness.FakeWorker>): string[] =>
  worker.sent.map((m) => (m as { type: string }).type);

describe('结构 client 装配期门控（init → ready → parse 的次序）', () => {
  let fatalMessages: string[];
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

  function makeClient(timeoutMs = 250): { client: StructureClient; worker: InstanceType<typeof harness.FakeWorker> } {
    const client = new StructureClient({ runtime: RUNTIME, timeoutMs, onFatal: (m) => fatalMessages.push(m) });
    expect(client.start()).toBe(true);
    const worker = harness.FakeWorker.instances.at(-1)!;
    expect(sentTypes(worker)).toEqual(['init']); // start 只发 init
    return { client, worker };
  }

  it('(a1) 装配没完成不发 parse；ready 一到补发最新全文；期间编辑只留在本地，全程零降级', async () => {
    const { client, worker } = makeClient();
    const model = fakeModel('第一版');
    const pending = client.tokens(model); // track：此刻 status 还是 starting ⇒ 不发 parse
    await flush();
    expect(sentTypes(worker)).toEqual(['init']);
    // 装配期间的编辑：版本与快照照常推进，但一条消息都不发（发了也注定被 worker 拒）
    model.edit('第二版');
    await flush();
    expect(sentTypes(worker)).toEqual(['init']);
    // ready ⇒ 补发 parse，带的是**最新**版本与文本
    worker.reply({ type: 'ready', version: 0 });
    await flush();
    expect(sentTypes(worker)).toEqual(['init', 'parse']);
    expect(worker.sent[1]).toMatchObject({ type: 'parse', doc: 1, version: 2, text: '第二版' });
    // worker 补解回 semantic ⇒ 等待者拿到结果；全程零 fatal、零回落
    worker.reply({ type: 'semantic', doc: 1, version: 2, tokens: [TOKEN_B] });
    expect(await pending).toEqual([TOKEN_B]);
    expect(client.state).toBe('ready');
    expect(fatalMessages).toHaveLength(0);
    expect(notices).toHaveLength(0);
    client.dispose();
  });

  it('(a2) 装配完成后 track 当场发 parse（一次、带 doc 号）；之后编辑走 change', async () => {
    const { client, worker } = makeClient();
    worker.reply({ type: 'ready', version: 0 });
    await flush();
    expect(client.state).toBe('ready');
    const model = fakeModel('已装配');
    void client.tokens(model);
    expect(sentTypes(worker)).toEqual(['init', 'parse']);
    expect(worker.sent[1]).toMatchObject({ type: 'parse', doc: 1, version: 1, text: '已装配' });
    // ready 后的编辑恢复正常增量口径
    model.edit('已装配!');
    expect(worker.sent[2]).toMatchObject({ type: 'change', doc: 1, version: 2 });
    client.dispose();
  });

  it('(a3) 真失败语义一个不动：形状不符仍 fatal 整档停用、拆线程、等待者拿 null', async () => {
    const { client, worker } = makeClient();
    const pending = client.tokens(fakeModel('x'));
    await flush();
    worker.reply({ type: 'nope' }); // 形状不符 = 两侧版本对不上，照旧整档停用
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    expect(worker.isTerminated).toBe(true);
    expect(fatalMessages).toHaveLength(1);
    client.dispose();
  });

  it('(a3b) wasm 载入失败（error capability=all）照旧整档停用，不因门控而被吞', async () => {
    const { client, worker } = makeClient();
    const pending = client.tokens(fakeModel('x'));
    await flush();
    worker.reply({ type: 'error', version: 0, stage: 'wasm', capability: 'all', message: '.kojo 语法载入失败' });
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    expect(fatalMessages).toEqual(['.kojo 语法载入失败']);
    client.dispose();
  });

  it('(a4) 装配始终不完成 ⇒ 既有超时口径：整档停用（不是单面降级）', async () => {
    const { client } = makeClient(20);
    const pending = client.tokens(fakeModel('x'));
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    expect(fatalMessages[0]).toContain('装配始终没有完成');
    client.dispose();
  });
});

describe('跨文档结果隔离（doc 序号对不上号就丢）', () => {
  let fatalMessages: string[];
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    harness.FakeWorker.reset();
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

  function readyClient(): { client: StructureClient; worker: InstanceType<typeof harness.FakeWorker> } {
    const client = new StructureClient({ runtime: RUNTIME, timeoutMs: 250, onFatal: (m) => fatalMessages.push(m) });
    client.start();
    const worker = harness.FakeWorker.instances.at(-1)!;
    worker.reply({ type: 'ready', version: 0 });
    return { client, worker };
  }

  it('(b1) 切文档后旧文档迟到的 semantic 冒充不了新文档（曾经：A 的 tokens 被存进 B 的缓存上屏）', async () => {
    const { client, worker } = readyClient();
    const tokensA = client.tokens(fakeModel('A 文本'));
    await flush();
    expect(worker.sent.at(-1)).toMatchObject({ type: 'parse', doc: 1, version: 1 });
    const tokensB = client.tokens(fakeModel('B 文本'));
    await flush();
    expect(worker.sent.at(-1)).toMatchObject({ type: 'parse', doc: 2, version: 1 });
    // A 的回复此刻才到（version=1 与 B 相同 ⇒ 旧代码只按版本判会放行）
    worker.reply({ type: 'semantic', doc: 1, version: 1, tokens: [TOKEN_A] });
    await flush();
    let bSettled = false;
    void tokensB.then(() => (bSettled = true));
    await flush();
    expect(bSettled).toBe(false); // A 的回复没放行 B 的等待者，更没进 B 的缓存
    expect(notices.filter((n) => n.startsWith('semantic/parse') && n.includes('文档 1'))).toHaveLength(1);
    // B 自己的回复才放行，且拿到的就是 B 的 tokens
    worker.reply({ type: 'semantic', doc: 2, version: 1, tokens: [TOKEN_B] });
    expect(await tokensB).toEqual([TOKEN_B]);
    expect(await tokensA).toBeNull(); // A 的调用者换轨后拿 null，绝不串到 B 的数据
    expect(fatalMessages).toHaveLength(0);
    client.dispose();
  });

  it('(b2) folds / indent 同样对号：旧文档的折叠区间与缩进规则进不了新文档', async () => {
    const { client, worker } = readyClient();
    const foldsA = client.foldingRanges(fakeModel('A 文本'));
    await flush();
    const foldsB = client.foldingRanges(fakeModel('B 文本'));
    await flush();
    worker.reply({ type: 'folds', doc: 1, version: 1, folds: [{ startRow: 0, endRow: 9 }] }); // 旧文档的折叠
    worker.reply({ type: 'indent', doc: 1, version: 1, rules: RULES_A }); // 旧文档的缩进
    await flush();
    expect(client.indent).toBeNull(); // 缩进规则没被旧文档污染
    worker.reply({ type: 'folds', doc: 2, version: 1, folds: [{ startRow: 1, endRow: 2 }] });
    worker.reply({ type: 'indent', doc: 2, version: 1, rules: RULES_B });
    expect(await foldsB).toEqual([{ startRow: 1, endRow: 2 }]);
    expect(await foldsA).toBeNull();
    expect(client.indent).toEqual(RULES_B);
    expect(client.state).toBe('ready');
    client.dispose();
  });

  it('(b3) 同文档的过期版本仍按既有口径丢弃（版本闸没有被 doc 闸取代）', async () => {
    const { client, worker } = readyClient();
    const model = fakeModel('A 文本');
    const pending = client.tokens(model);
    await flush();
    worker.reply({ type: 'semantic', doc: 1, version: 1, tokens: [TOKEN_A] });
    expect(await pending).toEqual([TOKEN_A]);
    // 编辑 ⇒ 版本 2（change 已发出，fake worker 不回话）；此时冒一条旧的 v1 结果必须被丢
    model.edit('A 文本!');
    await flush();
    expect(worker.sent.at(-1)).toMatchObject({ type: 'change', doc: 1, version: 2 });
    worker.reply({ type: 'semantic', doc: 1, version: 1, tokens: [TOKEN_B] });
    await flush();
    expect(notices.filter((n) => n.includes('收到版本 1'))).toHaveLength(1);
    expect(client.state).toBe('ready');
    client.dispose();
  });
});
