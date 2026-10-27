/**
 * 协议 v3 的**协议表测试**（LAU-1 的 DoD 第一条）+ 双跑窗口的降级门 + 五类异常。
 *
 * 打三层，各层只看它自己那一层的事实：
 *
 * 1. **契约 / 闸**（`@kojo/kojo-core` 的闭集 + `./protocol.ts` 的运行期闸）：形状、`reason` 闭集、
 *    捕获表的扁平投影约束；
 * 2. **两条 worker 协议环**：v1 那条用**真 wasm**（ERB 语法）驱动 `startStructureWorker`，
 *    kojo2 那条用一枚桩引擎驱动 `createKojo2ProtocolRing`——两条都验"版本不符即拒 /
 *    `text` 与 `edit` 同给 ⇒ `invalid-input` / `want` 缺省 = 全带 / 旧形状回 `protocol-mismatch`"；
 * 3. **主线程 v3 client**：`protocol-mismatch` ⇒ 降级到 `client-v2.ts`（作者面照旧有结构着色，
 *    不是整档哑火）、迟到回复丢弃、换轨串号、五类异常各一条。
 *
 * 为什么不把第 2 层也放进 `kojo2-worker.test.ts`：那个文件打的是**引擎 + 客户端**（真 wasm、
 * 5k 档读数），本文件打的是**线上形状**——读数与判据混在一个文件里，红了分不清是谁的账。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  STRUCTURE_BOOTSTRAP_TIMEOUT_MS,
  STRUCTURE_DEAD_AFTER_FAILURES,
  STRUCTURE_FAILURE_REASONS,
  STRUCTURE_FACETS,
  STRUCTURE_MAX_CAPTURES,
  STRUCTURE_PROTOCOL_VERSION,
  STRUCTURE_TIMEOUT_MS,
} from '@kojo/kojo-core';
import { StructureClient } from '../src/monaco/tree-sitter/client';
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import {
  contentProblem,
  isStructureFacet,
  isStructureFailureReason,
  isStructureReply,
  isStructureRequest,
} from '../src/monaco/tree-sitter/protocol';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import type { KojoStructureIndentRules, KojoStructureToken } from '../src/monaco/tree-sitter/types';
import { startStructureWorker } from '../src/monaco/tree-sitter/worker-bootstrap';
import { createKojo2ProtocolRing } from '../src/monaco/tree-sitter/kojo2-worker';
import type { Kojo2WorkerEngine } from '../src/monaco/tree-sitter/kojo2-worker';
import type { Kojo2WorkerReply } from '../src/monaco/tree-sitter/kojo2-worker-protocol';
import type { Kojo2RuntimeResult, Kojo2TreeSitterRuntime } from '../src/monaco/tree-sitter/kojo2-runtime-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const ERB_PKG = join(REPO_ROOT, 'packages/erb-syntax-tree');

const ERB_TEXT = '@F\nIF X\nPRINTL hi\nENDIF\n';

/* ============================== 公共脚手架 ============================== */

async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

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

/** 等待票走 `window.setTimeout`（node 池给一个直通全局计时器的窄 window） */
function fakeWindowTimers(): void {
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/* ========================= 1. 契约形状与运行期闭集 ========================= */

describe('协议表 · 契约形状与闭集', () => {
  it('版本号与两档预算就是 §4.1 的四个数（改形状必须先抬号，这条钉在字面量上）', () => {
    // v4（LAU-5）：`ready` 多了 `docBase`（池里多条通道各占一段 doc 号）——抬号理由见 core 文件头。
    expect(STRUCTURE_PROTOCOL_VERSION).toBe(4);
    expect(STRUCTURE_TIMEOUT_MS).toBe(4_000);
    expect(STRUCTURE_BOOTSTRAP_TIMEOUT_MS).toBe(8_000);
    expect(STRUCTURE_MAX_CAPTURES).toBe(50_000);
  });

  it('`reason` 是闭集：表内每一枚都认，表外一律不认', () => {
    expect(STRUCTURE_FAILURE_REASONS).toHaveLength(9);
    for (const reason of STRUCTURE_FAILURE_REASONS) expect(isStructureFailureReason(reason), reason).toBe(true);
    for (const bogus of ['', 'unknown', 'parse-error', 'PROTOCOL-MISMATCH', 3, null, undefined]) {
      expect(isStructureFailureReason(bogus), String(bogus)).toBe(false);
    }
  });

  it('面同样是闭集：四枚都认，表外不认', () => {
    expect(STRUCTURE_FACETS).toEqual(['semantic', 'folds', 'indent', 'syntax']);
    for (const facet of STRUCTURE_FACETS) expect(isStructureFacet(facet), facet).toBe(true);
    for (const bogus of ['tokens', 'fold', 'indents', '', 0, null]) expect(isStructureFacet(bogus), String(bogus)).toBe(false);
  });

  it('收件闸：没有合法 id 的请求连错都回不了（形状不合 ⇒ false）', () => {
    expect(
      isStructureRequest({
        id: 1,
        kind: 'open',
        protocol: STRUCTURE_PROTOCOL_VERSION,
        runtimeWasmUrl: 'r',
        grammarWasmUrl: 'g',
      }),
    ).toBe(true);
    expect(isStructureRequest({ id: 1, kind: 'parse', doc: 0, version: 1, text: 'x' })).toBe(true);
    for (const bogus of [null, {}, { kind: 'parse', doc: 0, version: 1, text: 'x' }, { id: 1, kind: 'nope' }]) {
      expect(isStructureRequest(bogus), JSON.stringify(bogus)).toBe(false);
    }
    // `want` 里点了一枚表外的面 ⇒ 整条请求形状不合（不猜"是不是新面"）
    expect(isStructureRequest({ id: 1, kind: 'parse', doc: 0, version: 1, text: 'x', want: ['bogus'] })).toBe(false);
  });

  it('内容二选一：同给 / 都没给都判非法，各给一句说得清的话', () => {
    const edit = { start: { row: 0, column: 0, offset: 0 }, oldEnd: { row: 0, column: 1, offset: 1 }, newEnd: { row: 0, column: 1, offset: 1 }, newText: 'x' };
    expect(contentProblem({ text: '甲' })).toBeNull();
    expect(contentProblem({ edit })).toBeNull();
    expect(contentProblem({ text: '甲', edit })).toContain('同时带了 text 与 edit');
    expect(contentProblem({})).toContain('既没有 text 也没有 edit');
    expect(contentProblem({ text: 42 })).toContain('text 不是字符串');
    expect(contentProblem({ edit: { start: { row: 0 } } })).toContain('不是一条合法编辑');
  });

  it('回话闸：成功只认 `ready` / `parse`，捕获表的 `spans` 必须是 6 的整数倍且下标在字典内', () => {
    const ready = { ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 };
    expect(isStructureReply(ready)).toBe(true);
    // v4 的 `docBase` 是必填（缺了就不是本版 ready 的形状）
    expect(isStructureReply({ ...ready, docBase: undefined })).toBe(false);
    const parse = (spans: number[]) => ({
      ok: true,
      id: 2,
      kind: 'parse',
      doc: 0,
      version: 1,
      treeId: 't1',
      incremental: false,
      facets: { semantic: { names: ['a'], nodes: ['b'], spans } },
      metrics: { parseMs: 0, queryMs: 0, textLength: 1 },
    });
    expect(isStructureReply(parse([0, 0, 0, 1, 0, 0]))).toBe(true);
    expect(isStructureReply(parse([0, 0, 0, 1, 0]))).toBe(false); // 长度不是 6 的倍数
    expect(isStructureReply(parse([0, 0, 0, 1, 5, 0]))).toBe(false); // nameIndex 越界
    expect(isStructureReply({ ...parse([]), facets: {} })).toBe(true);
    expect(isStructureReply({ ...parse([]), facets: null })).toBe(false);
    expect(isStructureReply({ ...parse([]), metrics: undefined })).toBe(false);
    expect(isStructureReply({ ...ready, kind: 'warm', })).toBe(false);
    expect(isStructureReply({ ok: false, id: 1, reason: 'bogus', message: 'x' })).toBe(false);
    expect(isStructureReply({ ok: false, id: 1, reason: 'crashed', message: 'x' })).toBe(true);
  });
});

/* ===================== 2a. v1 worker 协议环（真 wasm） ===================== */

describe('v1 worker 协议环 · open 握手 / 版本闸 / 内容二选一 / want 缺省', () => {
  interface Scope {
    sent: Record<string, unknown>[];
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: unknown): void;
  }

  let scope: Scope;
  let engine: { dispose(): void } | null = null;

  beforeAll(() => {
    const sent: Scope['sent'] = [];
    scope = {
      sent,
      onmessage: null,
      onerror: null,
      postMessage: (message: unknown) => sent.push(message as Record<string, unknown>),
    };
    (globalThis as unknown as { self: unknown }).self = scope;
    // **不装 wasm**：本文件打的是"请求进、回话出"的形状闸，装配期的两条门（版本不符 / 内容二选一 /
    // 旧形状）都在装载之前就判了。真 wasm 的四面读数归 `tree-sitter-erb-engine.test.ts` 与
    // 首帧探针 `tools/structure-first-frame.mjs`（web-tree-sitter 0.27 在 Windows 上收尾必崩
    // `Fatal process out of memory: Zone` ⇒ 解过档的进程只能放进子进程跑，见 PITFALLS）。
    engine = startStructureWorker({
      runtimeWasm: RUNTIME_WASM,
      grammarWasm: join(ERB_PKG, 'tree-sitter-erb.wasm'),
      highlightsQuery: '',
      foldsQuery: '',
      indentsQuery: '',
    });
  });

  afterAll(() => {
    engine?.dispose();
    engine = null;
    delete (globalThis as unknown as { self?: unknown }).self;
  });

  beforeEach(() => {
    scope.sent.length = 0; // 每个用例只看自己这一轮的账（引擎是同一具，省掉重复装 wasm）
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function send(data: unknown): void {
    scope.onmessage?.({ data } as MessageEvent<unknown>);
  }

  const last = (): Record<string, unknown> => scope.sent.at(-1)!;

  it('版本不符即拒：`open{protocol:2}` ⇒ protocol-mismatch（且不回 ready）', async () => {
    send({ id: 7, kind: 'open', protocol: 2, languageId: 'erb', runtimeWasmUrl: 'r', grammarWasmUrl: 'g' });
    await flush();
    expect(last()).toMatchObject({ ok: false, id: 7, kind: 'open', reason: 'protocol-mismatch' });
    expect(scope.sent.some((m) => m.kind === 'ready')).toBe(false);
  });

  it('旧形状（v2 的 init / kojo2 的 captures）⇒ protocol-mismatch；形状都不对 ⇒ invalid-input', async () => {
    send({ type: 'init', protocol: 2, wasmUrl: 'g', runtimeWasmUrl: 'r' });
    await flush();
    expect(last()).toMatchObject({ reason: 'protocol-mismatch' });
    send({ id: 5, type: 'captures', text: '甲', version: 1 });
    await flush();
    expect(last()).toMatchObject({ ok: false, id: 5, reason: 'protocol-mismatch' });
    send({ hello: true });
    await flush();
    expect(last()).toMatchObject({ ok: false, id: 0, reason: 'invalid-input' });
  });

  it('text 与 edit 同给 ⇒ invalid-input（装配期也判，不悄悄按 text 存下）', async () => {
    send({
      id: 9,
      kind: 'parse',
      doc: 0,
      version: 1,
      text: '甲',
      edit: { start: { row: 0, column: 0, offset: 0 }, oldEnd: { row: 0, column: 1, offset: 1 }, newEnd: { row: 0, column: 0, offset: 0 }, newText: '' },
    });
    await flush();
    expect(last()).toMatchObject({ ok: false, id: 9, kind: 'parse', reason: 'invalid-input' });
    expect(String(last().message)).toContain('同时带了 text 与 edit');
  });

  it('装配没完成时的增量请求：没有基线 ⇒ invalid-input（不是崩）', async () => {
    send({
      id: 2,
      kind: 'parse',
      doc: 1,
      version: 1,
      edit: { start: { row: 0, column: 0, offset: 0 }, oldEnd: { row: 0, column: 0, offset: 0 }, newEnd: { row: 0, column: 0, offset: 0 }, newText: 'x' },
    });
    await flush();
    expect(last()).toMatchObject({ ok: false, id: 2, kind: 'parse', reason: 'invalid-input' });
  });
});

/* ================= 2b. kojo2 worker 协议环（桩引擎） ================= */

describe('kojo2 worker 协议环 · 同一份 v3 契约的第二条腿', () => {
  function stubEngine(): { engine: Kojo2WorkerEngine; seen: Array<Record<string, unknown>> } {
    const seen: Array<Record<string, unknown>> = [];
    let seq = 0;
    const engine: Kojo2WorkerEngine = {
      async handle(request): Promise<Kojo2WorkerReply> {
        seen.push(request as unknown as Record<string, unknown>);
        const base = { ok: true as const, id: request.id, version: request.version, loadMs: 7 };
        if (request.type === 'parse') {
          return {
            ...base,
            type: 'parse',
            treeId: `t${++seq}`,
            incremental: request.oldTreeId !== undefined,
            changedRanges: [],
            textLength: request.text.length,
            parseMs: 0,
          };
        }
        if (request.type === 'captures') {
          return {
            ...base,
            type: 'captures',
            treeId: request.oldTreeId ?? `t${++seq}`,
            incremental: false,
            reparsed: false,
            queryMs: 0,
            captures: [{ name: 'keyword', startPosition: { row: 0, column: 0 }, endPosition: { row: 0, column: 2 } }],
          };
        }
        if (request.type === 'folds') {
          return {
            ...base,
            type: 'folds',
            treeId: request.oldTreeId ?? `t${++seq}`,
            incremental: false,
            reparsed: false,
            queryMs: 0,
            folds: [{ startRow: 0, endRow: 2, kind: 'block' }],
          };
        }
        return {
          ...base,
          type: 'indents',
          treeId: request.oldTreeId ?? `t${++seq}`,
          incremental: false,
          reparsed: false,
          queryMs: 0,
          rules: { increasePatterns: ['^#'], decreasePatterns: [], enterPatterns: ['^#'] },
        };
      },
      async warmup(): Promise<Kojo2RuntimeResult> {
        return { ok: true, runtime: { initMs: 7 } as unknown as Kojo2TreeSitterRuntime };
      },
      treeText(treeId: string): string | null {
        return treeId === 't1' ? '> 一。\n' : null;
      },
      dispose() {
        /* 桩：没有可释放的 */
      },
      get treeCount() {
        return 1;
      },
    };
    return { engine, seen };
  }

  const open = {
    id: 1,
    kind: 'open',
    protocol: STRUCTURE_PROTOCOL_VERSION,
    languageId: 'kojo2',
    runtimeWasmUrl: 'r',
    grammarWasmUrl: 'g',
  };
  const parse = (extra: Record<string, unknown> = {}) => ({ id: 2, kind: 'parse', doc: 0, version: 1, ...extra });

  it('open 版本不符 ⇒ protocol-mismatch；版本对上 ⇒ ready{protocol,docBase:0}', async () => {
    const ring = createKojo2ProtocolRing(stubEngine().engine);
    expect(await ring.handle({ ...open, protocol: 2 })).toMatchObject({ ok: false, kind: 'open', reason: 'protocol-mismatch' });
    expect(await ring.handle(open)).toMatchObject({
      ok: true,
      kind: 'ready',
      protocol: STRUCTURE_PROTOCOL_VERSION,
      docBase: 0,
      loadMs: 7,
    });
  });

  it('text 与 edit 同给 / 都没给 ⇒ invalid-input（不猜哪个算数）', async () => {
    const ring = createKojo2ProtocolRing(stubEngine().engine);
    expect(await ring.handle(parse({ text: '甲', edit: { start: {}, oldEnd: {}, newEnd: {}, newText: '' } }))).toMatchObject({
      ok: false,
      kind: 'parse',
      reason: 'invalid-input',
    });
    expect(await ring.handle(parse({}))).toMatchObject({ ok: false, reason: 'invalid-input' });
  });

  it('want 缺省 = 全带（semantic / folds / indent；syntax 这一族不产 ⇒ 安静缺省）', async () => {
    const ring = createKojo2ProtocolRing(stubEngine().engine);
    const reply = await ring.handle(parse({ text: '> 一。\n' }));
    expect(reply.ok).toBe(true);
    if (!reply.ok || reply.kind !== 'parse') throw new Error('没有 parse 回话');
    expect(Object.keys(reply.facets).sort()).toEqual(['folds', 'indent', 'semantic']);
    expect(reply.facets.semantic?.names).toEqual(['keyword']);
  });

  it('want 点名一面 ⇒ 只发那一条内部查询，回话只有那一面', async () => {
    const { engine, seen } = stubEngine();
    const ring = createKojo2ProtocolRing(engine);
    const reply = await ring.handle(parse({ text: '甲', want: ['folds'] }));
    expect(reply.ok).toBe(true);
    if (!reply.ok || reply.kind !== 'parse') throw new Error('没有 parse 回话');
    expect(Object.keys(reply.facets)).toEqual(['folds']);
    expect(seen.map((r) => r.type)).toEqual(['folds']); // 一个来回，不多解一遍
  });

  it('`edit`：基线由 worker 自己缝（不认识 ⇒ parse-failed，宿主改发整篇）', async () => {
    const ring = createKojo2ProtocolRing(stubEngine().engine);
    const edit = { start: { row: 0, column: 2, offset: 2 }, oldEnd: { row: 0, column: 4, offset: 4 }, newEnd: { row: 0, column: 4, offset: 4 }, newText: '两' };
    const bad = await ring.handle(parse({ edit, baseTreeId: 'nope' }));
    expect(bad).toMatchObject({ ok: false, reason: 'parse-failed' });
    const good = await ring.handle(parse({ edit, baseTreeId: 't1' }));
    expect(good.ok).toBe(true);
    if (!good.ok || good.kind !== 'parse') throw new Error('没有 parse 回话');
    expect(good.incremental, '带基线 ⇒ 增量').toBe(true);
  });

  it('旧形状（v2 的 captures）⇒ protocol-mismatch；垃圾形状 ⇒ invalid-input', async () => {
    const ring = createKojo2ProtocolRing(stubEngine().engine);
    expect(await ring.handle({ id: 4, type: 'captures', text: '甲', version: 1 })).toMatchObject({
      ok: false,
      id: 4,
      reason: 'protocol-mismatch',
    });
    expect(await ring.handle({ nope: true })).toMatchObject({ ok: false, id: 0, reason: 'invalid-input' });
  });
});

/* ================== 3. 主线程 v3 client：双跑降级 / 迟到 / 换轨 / 异常 ================== */

interface FakeWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  readonly sent: unknown[];
  reply(data: unknown): void;
  error(message: string): void;
  terminate(): void;
  terminated: boolean;
}

/** 一条 v2（旧协议）worker 的替身：认得 `init` / `parse` / `change`，不认得 v3 的 `open` */
function legacyWorker(): FakeWorkerLike {
  const worker: FakeWorkerLike = {
    onmessage: null,
    onerror: null,
    sent: [],
    terminated: false,
    reply(data: unknown) {
      worker.onmessage?.({ data });
    },
    error(message: string) {
      worker.onerror?.({ message });
    },
    terminate() {
      worker.terminated = true;
    },
  };
  /** 收到什么就回什么（旧协议的四条推送） */
  (worker as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
    worker.sent.push(data);
    const message = data as Record<string, unknown>;
    if (message.type === 'init') {
      worker.reply({ type: 'ready', version: 0 });
      return;
    }
    if (message.type === 'parse') {
      const doc = message.doc as number;
      const version = message.version as number;
      worker.reply({ type: 'semantic', doc, version, tokens: [LEGACY_TOKEN] });
      worker.reply({ type: 'folds', doc, version, folds: [] });
      worker.reply({ type: 'indent', doc, version, rules: EMPTY_RULES });
    }
  };
  return worker;
}

const LEGACY_TOKEN: KojoStructureToken = {
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 1,
  tier: 'role.comment',
  capture: 'comment',
  node: 'x',
};
const EMPTY_RULES: KojoStructureIndentRules = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

const parseReply = (id: number, doc: number, version: number, treeId = 't1') => ({
  ok: true,
  id,
  kind: 'parse',
  doc,
  version,
  treeId,
  incremental: true,
  facets: {
    semantic: { names: ['comment'], nodes: ['x'], spans: [0, 0, 0, 1, 0, 0] },
    folds: { spans: [] },
    indent: EMPTY_RULES,
  },
  metrics: { parseMs: 0, queryMs: 0, textLength: 1 },
});

describe('双跑窗口 · protocol-mismatch ⇒ 降级到旧路（结构层不哑火）', () => {
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('v3 握手被拒 ⇒ 同一个 client 改说 v2，tokens 照旧拿得到（不是整档哑火）', async () => {
    const workers: FakeWorkerLike[] = [];
    const runtime: StructureLanguageRuntime = {
      runtimeWasmUrl: 'r',
      grammarWasmUrl: 'g',
      createWorker: () => {
        const worker = legacyWorker();
        // 旧 worker 不认识 `open`：回一条 protocol-mismatch（v3 worker 也会这么回旧宿主）
        const original = (worker as unknown as { postMessage: (data: unknown) => void }).postMessage;
        (worker as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
          const message = data as Record<string, unknown>;
          if (message.kind === 'open') {
            worker.sent.push(data);
            worker.reply({ ok: false, id: message.id as number, kind: 'open', reason: 'protocol-mismatch', message: '协议版本不符' });
            return;
          }
          original(data);
        };
        workers.push(worker);
        return worker as unknown as Worker;
      },
    };
    const fatal: string[] = [];
    const client = new StructureClient({ runtime, languageId: 'erb', timeoutMs: 500, onFatal: (m) => fatal.push(m) });
    client.start();
    // 握手被拒是**同步**发生的（替身当场回话）⇒ 旧 client 的线程此刻已经起来了
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const tokens = await client.tokens(fakeModel('甲'));
    expect(tokens, '降级之后必须照旧有结构着色').toEqual([LEGACY_TOKEN]);
    expect(workers).toHaveLength(2); // 旧 client 自己起了一条线程
    expect(workers[1]!.sent.some((m) => (m as { type?: string }).type === 'parse'), '旧路真的在解').toBe(true);
    expect(fatal, '降级不是整档停用').toHaveLength(0);
    expect(client.state).toBe('ready');
    expect(notices, '降级只落开发面（console.debug），不惊动作者面').toHaveLength(0);
    client.dispose();
  });
});

describe('迟到回复丢弃 / 换轨串号（丢弃 ≠ 回落）', () => {
  let workers: FakeWorkerLike[];
  let client: StructureClient;
  let notices: string[];
  let debug: ReturnType<typeof vi.spyOn>;
  let unsubscribe: (() => void) | null = null;

  const runtime = (): StructureLanguageRuntime => ({
    runtimeWasmUrl: 'r',
    grammarWasmUrl: 'g',
    createWorker: () => {
      const worker = legacyWorker(); // 只借它的 postMessage 记账能力（onmessage 由测试直接驱动）
      (worker as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
        worker.sent.push(data);
      };
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });

  beforeEach(() => {
    workers = [];
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
    client = new StructureClient({ runtime: runtime(), timeoutMs: 40, bootstrapTimeoutMs: 40 });
    client.start();
    workers[0]!.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
  });

  afterEach(() => {
    client.dispose();
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('超时之后迟到的同号回复直接丢：不改已定的答案，只记一笔', async () => {
    const pending = client.tokens(fakeModel('甲'));
    expect(await pending).toBeNull();
    notices.length = 0; // 上面那条是**超时**的回落（该说）；下面要看的是"迟到回复不再说第二遍"
    const request = workers[0]!.sent.at(-1) as { id: number; doc: number; version: number };
    workers[0]!.reply(parseReply(request.id, request.doc, request.version));
    await flush();
    expect(await pending, '同一枚 result 不会被迟到回话改写').toBeNull();
    expect(client.discardedReplies).toBe(1);
    expect(notices, '丢弃是常态，不进回落台账').toHaveLength(0);
    expect(debug.mock.calls.some((call: unknown[]) => String(call[0]).includes('正常丢弃'))).toBe(true);
  });

  it('换轨后旧文档的回复冒充不了新文档（doc 串号整条丢）', async () => {
    const tokensA = client.tokens(fakeModel('A'));
    await flush();
    const a = workers[0]!.sent.at(-1) as { id: number; doc: number };
    const tokensB = client.tokens(fakeModel('B'));
    await flush();
    const b = workers[0]!.sent.at(-1) as { id: number; doc: number };
    expect(b.doc).toBe(a.doc + 1);
    workers[0]!.reply(parseReply(a.id, a.doc, 1)); // 旧文档的结果此刻才到
    await flush();
    let settled = false;
    void tokensB.then(() => (settled = true));
    await flush();
    expect(settled, 'A 的回复不许放行 B 的等待者').toBe(false);
    expect(client.discardedReplies).toBe(1);
    workers[0]!.reply(parseReply(b.id, b.doc, 1));
    expect(await tokensB).toEqual([LEGACY_TOKEN]);
    expect(await tokensA).toBeNull();
  });
});

describe('五类异常各一条（都是可判别数据，绝不 reject）', () => {
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    fakeWindowTimers();
    resetStructureDegradationLedger();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage} ${d.message}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('① unavailable：本进程建不出 worker ⇒ 整档停用一次、tokens 回 null', async () => {
    const fatal: string[] = [];
    const client = new StructureClient({
      runtime: {
        runtimeWasmUrl: 'r',
        grammarWasmUrl: 'g',
        createWorker: () => {
          throw new Error('没有 Worker');
        },
      },
      onFatal: (m) => fatal.push(m),
    });
    expect(client.start()).toBe(false);
    expect(await client.tokens(fakeModel('甲'))).toBeNull();
    expect(client.state).toBe('dead');
    expect(fatal[0]).toContain('没有 Worker');
    expect(notices.filter((n) => n.startsWith('all/'))).toHaveLength(1);
    client.dispose();
  });

  it('② wasm-load-failed：open 回 ok:false ⇒ 记账到阈值整档停用', async () => {
    const client = new StructureClient({
      runtime: { runtimeWasmUrl: 'r', grammarWasmUrl: 'g', createWorker: () => legacyWorker() as unknown as Worker },
      timeoutMs: 200,
      onFatal: () => undefined,
    });
    client.start();
    const worker = (client as unknown as { worker: FakeWorkerLike }).worker;
    const openId = (worker.sent[0] as { id: number }).id;
    const pending = client.tokens(fakeModel('甲'));
    for (let round = 0; round < STRUCTURE_DEAD_AFTER_FAILURES; round += 1) {
      worker.reply({ ok: false, id: openId, kind: 'open', reason: 'wasm-load-failed', message: '语法载入失败' });
      await flush();
    }
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    client.dispose();
  });

  it('③ crashed：worker onerror ⇒ 整档停用、在飞请求收 null', async () => {
    const fatal: string[] = [];
    const client = new StructureClient({
      runtime: { runtimeWasmUrl: 'r', grammarWasmUrl: 'g', createWorker: () => legacyWorker() as unknown as Worker },
      timeoutMs: 200,
      onFatal: (m) => fatal.push(m),
    });
    client.start();
    const worker = (client as unknown as { worker: FakeWorkerLike }).worker;
    const pending = client.tokens(fakeModel('甲'));
    worker.error('线程炸了');
    expect(await pending).toBeNull();
    expect(client.state).toBe('dead');
    expect(fatal[0]).toContain('线程炸了');
    client.dispose();
  });

  it('④ timeout：到点 ⇒ 这一面这次不顶上（失败记账走台账），通道仍在', async () => {
    const client = new StructureClient({
      runtime: { runtimeWasmUrl: 'r', grammarWasmUrl: 'g', createWorker: () => legacyWorker() as unknown as Worker },
      timeoutMs: 20,
      bootstrapTimeoutMs: 20,
      onFatal: () => undefined,
    });
    client.start();
    const worker = (client as unknown as { worker: FakeWorkerLike }).worker;
    worker.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
    const model = fakeModel('甲');
    expect(await client.tokens(model)).toBeNull();
    expect(client.state, '一次超时不判死（阈值是 3）').toBe('ready');
    expect(notices.some((n) => n.includes('4000ms') || n.includes('20ms') || n.includes('没有回话')), JSON.stringify(notices)).toBe(
      true,
    );
    client.dispose();
  });

  it('⑤ disposed：在飞请求收 null、之后不再投递，不抛', async () => {
    const client = new StructureClient({
      runtime: { runtimeWasmUrl: 'r', grammarWasmUrl: 'g', createWorker: () => legacyWorker() as unknown as Worker },
      timeoutMs: 1_000,
    });
    client.start();
    const worker = (client as unknown as { worker: FakeWorkerLike }).worker;
    worker.reply({ ok: true, id: 1, kind: 'ready', protocol: STRUCTURE_PROTOCOL_VERSION, loadMs: 1, docBase: 0 });
    const pending = client.tokens(fakeModel('甲')); // 在飞：等 worker 回话
    client.dispose();
    expect(await pending, '在飞请求收 null（不 reject）').toBeNull();
    expect(worker.terminated, '线程被 terminate').toBe(true);
    expect(client.state).toBe('idle');
  });
});
