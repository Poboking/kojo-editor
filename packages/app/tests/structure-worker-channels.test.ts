/**
 * 一条线程承载**多门语言**（LAU-5 的 v4 路由）。
 *
 * 打的是 `startStructureWorker` 的**协议环**，引擎换成可编程替身：本文件判的是
 * "`open` 分号段 / `parse` 找引擎 / 复用 / 失败不占号"这几条路由事实，不是解语法
 * （真 wasm 的两条腿各有专文件：`tree-sitter-erb-engine.test.ts` / `kojo2-worker.test.ts`；
 * 一进程装两门文法的读数在 `tools/structure-pool-readings.mjs`——web-tree-sitter 0.27 在
 * Windows 上一个进程装第二门文法，退出时必崩 `Fatal process out of memory: Zone`，PITFALLS）。
 *
 * 替身引擎把"我是哪台"写进 `semantic` 面的 `nodes` 字典：回话里带着哪门文法，就证明这条
 * `parse` 落到了哪台引擎上（比只看 `doc` 原样带回强——回话的 `doc` 是请求里抄的）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRUCTURE_PROTOCOL_VERSION } from '@kojo/kojo-core';
import type { StructureEngineAssets } from '../src/monaco/tree-sitter/engine';

const fake = vi.hoisted(() => {
  interface FakeReply {
    readonly type: string;
    readonly [key: string]: unknown;
  }
  class FakeEngine {
    static instances: FakeEngine[] = [];
    readonly key: string;
    initialized = false;
    loadMs = 0;
    treeId: string | null = null;
    text = '';
    lastTimings = { parseMs: 0, queryMs: 0 };
    private seq = 0;
    private readonly emit: (message: FakeReply) => void;
    private readonly failInit: boolean;

    constructor(options: { assets: { grammarWasm: string | Uint8Array }; emit: (message: FakeReply) => void }) {
      this.key = String(options.assets.grammarWasm);
      this.emit = options.emit;
      this.failInit = this.key.includes('bogus');
      FakeEngine.instances.push(this);
    }

    async init(): Promise<boolean> {
      if (this.failInit) {
        this.emit({ type: 'error', capability: 'all', stage: 'wasm', message: `装不上 ${this.key}` });
        return false;
      }
      this.initialized = true;
      this.loadMs = 1;
      return true;
    }

    parse(doc: number, version: number, text: string): void {
      this.text = text;
      this.treeId = `t${++this.seq}`;
      this.emit({
        type: 'semantic',
        doc,
        version,
        tokens: [],
        table: { names: [], nodes: [this.key], spans: [] },
      });
    }

    change(change: { doc: number; version: number; newText: string }): void {
      this.text += change.newText;
      this.treeId = `t${++this.seq}`;
      this.emit({
        type: 'semantic',
        doc: change.doc,
        version: change.version,
        tokens: [],
        table: { names: [], nodes: [this.key], spans: [] },
      });
    }

    dispose(): void {
      /* 替身没有原生内存 */
    }
  }
  return { FakeEngine };
});

vi.mock('../src/monaco/tree-sitter/engine', () => ({
  StructureEngine: fake.FakeEngine,
  captureTableOf: (tokens: unknown) => ({ names: [], nodes: [], spans: [], tokens }),
}));

const { startStructureWorker } = await import('../src/monaco/tree-sitter/worker-bootstrap');

const STRIDE = 1_000_000;

const bundle = (grammarWasm: string): StructureEngineAssets => ({ runtimeWasm: 'runtime://shared', grammarWasm });
const KOJO = bundle('grammar://kojo.wasm');
const ERB = bundle('grammar://erb.wasm');
const BOGUS = bundle('grammar://bogus.wasm');

interface Scope {
  sent: Record<string, unknown>[];
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
}

const makeScope = (): Scope => {
  const scope: Scope = {
    sent: [],
    onmessage: null,
    onerror: null,
    postMessage: (message: unknown) => scope.sent.push(message as Record<string, unknown>),
  };
  return scope;
};

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

let scope: Scope;
let handle: { dispose(): void } | null = null;

beforeAll(() => {
  scope = makeScope();
  (globalThis as unknown as { self: unknown }).self = scope;
  handle = startStructureWorker([KOJO, ERB, BOGUS]);
});

afterAll(() => {
  handle?.dispose();
  handle = null;
  delete (globalThis as unknown as { self?: unknown }).self;
});

beforeEach(() => {
  scope.sent.length = 0;
});

function open(id: number, assets: StructureEngineAssets): void {
  scope.sent.length = 0;
  scope.onmessage?.({
    data: {
      id,
      kind: 'open',
      protocol: STRUCTURE_PROTOCOL_VERSION,
      languageId: 'probe',
      runtimeWasmUrl: assets.runtimeWasm,
      grammarWasmUrl: String(assets.grammarWasm),
    },
  } as MessageEvent<unknown>);
}

const last = (): Record<string, unknown> => scope.sent.at(-1)!;

/** 回话里 `semantic` 面的 `nodes` 字典就是答话那台引擎的键（替身引擎写入） */
const answerOf = (reply: Record<string, unknown>): string => {
  const facets = reply.facets as { semantic?: { nodes?: string[] } } | undefined;
  return facets?.semantic?.nodes?.[0] ?? '';
};

describe('v4 多通道 · 一条线程多台引擎', () => {
  it('每门语言一条通道：第一门 0，第二门 1,000,000', async () => {
    open(1, KOJO);
    await flush();
    expect(last()).toMatchObject({ ok: true, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, docBase: 0 });

    open(2, ERB);
    await flush();
    expect(last()).toMatchObject({ ok: true, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, docBase: STRIDE });
  });

  it('`parse` 只撞自己那台：两段 doc 号各答各的文法', async () => {
    scope.sent.length = 0;
    scope.onmessage?.({ data: { id: 3, kind: 'parse', doc: 0, version: 1, text: '甲' } } as MessageEvent<unknown>);
    await flush();
    const kojoReply = last();
    expect(kojoReply).toMatchObject({ ok: true, kind: 'parse', doc: 0 });
    expect(answerOf(kojoReply)).toBe('grammar://kojo.wasm');

    scope.sent.length = 0;
    scope.onmessage?.({
      data: { id: 4, kind: 'parse', doc: STRIDE, version: 1, text: '乙' },
    } as MessageEvent<unknown>);
    await flush();
    const erbReply = last();
    expect(erbReply).toMatchObject({ ok: true, kind: 'parse', doc: STRIDE });
    expect(answerOf(erbReply)).toBe('grammar://erb.wasm');
  });

  it('`baseTreeId` 也按通道对：拿别家的树当基线 ⇒ parse-failed', async () => {
    // 再各解一趟，让两台引擎的树身份都前进（它们各自的序号互不相干）
    scope.sent.length = 0;
    scope.onmessage?.({ data: { id: 5, kind: 'parse', doc: STRIDE, version: 2, text: '乙二' } } as MessageEvent<unknown>);
    await flush();
    const erbTree = last().treeId;

    const end = { row: 0, column: 1, offset: 1 };
    scope.sent.length = 0;
    scope.onmessage?.({
      data: {
        id: 6,
        kind: 'parse',
        doc: 0,
        version: 2,
        baseTreeId: erbTree,
        edit: { start: end, oldEnd: end, newEnd: end, newText: '丙' },
      },
    } as MessageEvent<unknown>);
    await flush();
    expect(last()).toMatchObject({ ok: false, kind: 'parse', reason: 'parse-failed' });
  });

  it('同一门语言第二次 open ⇒ 原地复用（docBase 不变、loadMs=0）', async () => {
    open(10, KOJO);
    await flush();
    const first = last();
    open(11, KOJO);
    await flush();
    const again = last();
    expect(again).toMatchObject({ ok: true, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 0 });
    expect(again.docBase).toBe(first.docBase);
  });

  it('未登记的文法 ⇒ wasm-load-failed（不猜"那就用第一份"）', async () => {
    scope.sent.length = 0;
    scope.onmessage?.({
      data: {
        id: 20,
        kind: 'open',
        protocol: STRUCTURE_PROTOCOL_VERSION,
        languageId: 'probe',
        runtimeWasmUrl: 'runtime://shared',
        grammarWasmUrl: 'grammar://never-registered.wasm',
      },
    } as MessageEvent<unknown>);
    await flush();
    expect(last()).toMatchObject({ ok: false, kind: 'open', reason: 'wasm-load-failed' });
  });

  it('装不起来的通道不占号：失败删槽后，下一门拿到新号段而不是捡回失败那枚', async () => {
    const local = makeScope();
    const outer = (globalThis as unknown as { self?: unknown }).self;
    (globalThis as unknown as { self: unknown }).self = local;
    const dedicated = startStructureWorker([BOGUS, KOJO]);
    try {
      const ask = (id: number, assets: StructureEngineAssets): void => {
        local.sent.length = 0;
        local.onmessage?.({
          data: {
            id,
            kind: 'open',
            protocol: STRUCTURE_PROTOCOL_VERSION,
            languageId: 'probe',
            runtimeWasmUrl: assets.runtimeWasm,
            grammarWasmUrl: String(assets.grammarWasm),
          },
        } as MessageEvent<unknown>);
      };
      ask(30, BOGUS);
      await flush();
      expect(local.sent.at(-1)).toMatchObject({ ok: false, kind: 'open', reason: 'wasm-load-failed' });

      ask(31, KOJO);
      await flush();
      expect(local.sent.at(-1)).toMatchObject({ ok: true, kind: 'ready', docBase: STRIDE });
    } finally {
      dedicated.dispose();
      (globalThis as unknown as { self?: unknown }).self = outer;
    }
  });
});
