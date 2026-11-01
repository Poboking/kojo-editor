/**
 * 结构解析线程池（LAU-5）的三条主张，各一枚用例组：
 *
 * 1. **复用**：同一运行时名下借还两趟拿到**同一条**线程（`Parser.init` 与已装文法都不重付）；
 * 2. **分键**：换运行时 ⇒ 另起一条（运行时不共享，池只认这一格）；
 * 3. **收账**：坏线程不回池、空闲上限之外直接终结、整套拆毁时把空闲全收掉。
 *
 * 打桩面：`?worker` 入口在 node 池里起不来（vitest 没有 Worker 构造），换成可编程替身；
 * 池本体一行不改——`createStructureThread()` 是唯一一处碰 `?worker` 的地方。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';

const harness = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    readonly sent: unknown[] = [];
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(message: unknown): void {
      this.sent.push(message);
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { FakeWorker };
});

vi.mock('../src/monaco/tree-sitter/structure.worker?worker', () => ({ default: harness.FakeWorker }));

/** 资源装配点带 `?url` / `?raw`（node 池解析不了）：kojo2 客户端只把它当路由键，替身够用 */
vi.mock('../src/monaco/tree-sitter/kojo2-assets', () => ({
  KOJO2_TREE_SITTER_ASSETS: {
    runtimeWasmUrl: 'runtime://kojo2',
    grammarWasm: 'grammar://kojo2.wasm',
    highlightsQuery: '',
    foldsQuery: '',
    indentsQuery: '',
  },
}));

const { acquireStructureThread, closeStructurePool, resetStructurePoolForTests, structurePoolStats } = await import(
  '../src/monaco/tree-sitter/structure-pool'
);

const sourceOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/monaco/tree-sitter/${rel}`, import.meta.url)), 'utf8');

/** 一条"生产形态"的运行时：没有注入点 ⇒ 走池 */
const pooled = (runtimeWasmUrl: string): StructureLanguageRuntime => ({
  runtimeWasmUrl,
  grammarWasmUrl: `${runtimeWasmUrl}#grammar`,
  createWorker: undefined,
});

beforeEach(() => {
  resetStructurePoolForTests();
  harness.FakeWorker.instances.length = 0;
});

afterEach(() => {
  resetStructurePoolForTests();
});

describe('池 · 同一运行时名下复用', () => {
  it('借还两趟拿到同一条线程；第二趟不新建', () => {
    const first = acquireStructureThread(pooled('runtime://a'));
    expect(harness.FakeWorker.instances).toHaveLength(1);
    first.release(true);

    const second = acquireStructureThread(pooled('runtime://a'));
    expect(second.worker).toBe(first.worker);
    expect(harness.FakeWorker.instances, '第二趟没有再建线程').toHaveLength(1);
    expect(structurePoolStats()).toMatchObject({ created: 1, reused: 1, terminated: 0, acquired: 2, released: 1, idle: 0 });
  });

  it('换运行时 ⇒ 另起一条（池只认 runtimeWasmUrl）', () => {
    const a = acquireStructureThread(pooled('runtime://a'));
    const b = acquireStructureThread(pooled('runtime://b'));
    expect(b.worker).not.toBe(a.worker);
    expect(structurePoolStats()).toMatchObject({ created: 2, reused: 0, idle: 0 });
  });

  it('还回来之前不共享：同一键的两趟各借一条（独占）', () => {
    const first = acquireStructureThread(pooled('runtime://a'));
    const second = acquireStructureThread(pooled('runtime://a'));
    expect(second.worker).not.toBe(first.worker);
    expect(structurePoolStats()).toMatchObject({ created: 2, reused: 0 });
  });
});

describe('池 · 收账', () => {
  it('release(false)：坏线程当场终结、不回池；下一趟新建', () => {
    const first = acquireStructureThread(pooled('runtime://a'));
    const worker = first.worker as unknown as InstanceType<typeof harness.FakeWorker>;
    first.release(false);
    expect(worker.terminated, '坏线程被 terminate').toBe(true);

    const second = acquireStructureThread(pooled('runtime://a'));
    expect(second.worker).not.toBe(first.worker);
    expect(structurePoolStats()).toMatchObject({ created: 2, reused: 0, terminated: 1 });
  });

  it('空闲上限：第三条还回来时池里已有两条 ⇒ 当场终结', () => {
    const leases = ['a', 'b', 'c'].map((key) => acquireStructureThread(pooled(`runtime://${key}`)));
    for (const lease of leases) lease.release(true);
    const stats = structurePoolStats();
    expect(stats.idle, '池里最多两条').toBe(2);
    expect(stats.terminated).toBe(1);
    expect((leases[2]!.worker as unknown as InstanceType<typeof harness.FakeWorker>).terminated).toBe(true);
  });

  it('重复 release 幂等：只记一次账、不会把已回池的线程再杀一遍', () => {
    const lease = acquireStructureThread(pooled('runtime://a'));
    lease.release(true);
    lease.release(false);
    expect(lease.worker.onmessage, '回池后回调已摘').toBeNull();
    expect(structurePoolStats()).toMatchObject({ released: 1, terminated: 0, idle: 1 });
  });

  it('closeStructurePool：空闲的全收，借出去的不动（各自 release 收）', () => {
    const idleLease = acquireStructureThread(pooled('runtime://a'));
    idleLease.release(true);
    const inUse = acquireStructureThread(pooled('runtime://b'));

    closeStructurePool();
    expect((idleLease.worker as unknown as InstanceType<typeof harness.FakeWorker>).terminated).toBe(true);
    expect((inUse.worker as unknown as InstanceType<typeof harness.FakeWorker>).terminated, '借出去的不归池管').toBe(false);
    expect(structurePoolStats()).toMatchObject({ idle: 0, terminated: 1 });

    inUse.release(true);
    expect(structurePoolStats()).toMatchObject({ idle: 1, terminated: 1 });
  });
});

describe('池 · 注入点（测试 / 回滚）', () => {
  it('runtime.createWorker 给了就不进池：不建内置线程、release 即终结', () => {
    let made = 0;
    const runtime: StructureLanguageRuntime = {
      runtimeWasmUrl: 'runtime://a',
      grammarWasmUrl: 'g',
      createWorker: () => {
        made += 1;
        return new harness.FakeWorker() as unknown as Worker;
      },
    };
    const first = acquireStructureThread(runtime);
    first.release(true);
    const second = acquireStructureThread(runtime);
    expect(second.worker).not.toBe(first.worker);
    second.release(true);
    expect(made).toBe(2);
    expect(structurePoolStats()).toMatchObject({ created: 0, reused: 0, idle: 0, terminated: 2 });
  });
});

/**
 * LAU-5 收尾的判据：kojo2 客户端**必须**从池里借线程、按 `ready.docBase` 发 `parse`。
 *
 * 两条都能真红：
 * - 改回自建 worker（`new Kojo2Worker` / `?worker` 入口）⇒ 源码闸红、线程数断言也红；
 * - 忽略 `ready.docBase` 继续发 `doc: 0` ⇒ `doc ≥ docBase` 断言红（号段撞车正是这条要防的）。
 */
describe('池 · kojo2 借池（不自建 worker）', () => {
  it('open 只发一条；ready 前的 parse 排队；doc 落在池给的号段里；dispose 回池不杀线程', async () => {
    const { Kojo2WorkerClient } = await import('../src/monaco/tree-sitter/kojo2-worker-runtime');
    const warnings: string[] = [];
    const client = new Kojo2WorkerClient({ warn: (message) => warnings.push(message) });
    try {
      expect(client.start(), '池里有线程 ⇒ 起得来').toBe(true);
      expect(harness.FakeWorker.instances, '只建了池里那一条线程').toHaveLength(1);
      const worker = harness.FakeWorker.instances[0]!;
      expect(structurePoolStats(), '走池：借一笔、建一笔').toMatchObject({ acquired: 1, created: 1, reused: 0 });
      expect(worker.sent, 'open 之后只发这一条').toHaveLength(1);
      expect(worker.sent[0]).toMatchObject({
        kind: 'open',
        protocol: 4,
        languageId: 'kojo2',
        runtimeWasmUrl: 'runtime://kojo2',
        grammarWasmUrl: 'grammar://kojo2.wasm',
      });

      const pending = client.parse('甲＝一\n', 1);
      expect(worker.sent, 'ready 之前 parse 先排队（号段还没定）').toHaveLength(1);

      const openId = (worker.sent[0] as { id: number }).id;
      worker.onmessage?.({
        data: { ok: true, id: openId, kind: 'ready', protocol: 4, loadMs: 0, docBase: 1_000_000 },
      } as MessageEvent<unknown>);
      expect(worker.sent, 'ready 到了补发排队的那条').toHaveLength(2);

      const sent = worker.sent[1] as { id: number; kind: string; doc: number };
      expect(sent.kind).toBe('parse');
      expect(sent.doc, 'doc 必须落在池给的号段（恒 0 = 与同线程别的引擎撞号）').toBeGreaterThanOrEqual(1_000_000);

      worker.onmessage?.({
        data: {
          ok: true,
          id: sent.id,
          kind: 'parse',
          doc: sent.doc,
          version: 1,
          treeId: 'k1',
          incremental: false,
          facets: {},
          metrics: { parseMs: 1, queryMs: 0, textLength: 3 },
        },
      } as MessageEvent<unknown>);
      const result = await pending;
      expect(result.ok, 'parse 收账').toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      client.dispose();
    }
    const worker = harness.FakeWorker.instances[0]!;
    expect(worker.terminated, '健康线程回池、不杀').toBe(false);
    expect(structurePoolStats(), '交还记账：released + idle').toMatchObject({ released: 1, idle: 1, terminated: 0 });
  });

  it('源码闸：旧入口已删、客户端只剩借池一条出线程口', () => {
    const legacy = fileURLToPath(new URL('../src/monaco/tree-sitter/kojo2-ts.worker.ts', import.meta.url));
    expect(existsSync(legacy), 'kojo2 的自有 worker 入口必须已退役').toBe(false);

    const client = sourceOf('kojo2-worker-runtime.ts');
    expect(client, '不许 import 任何 ?worker 入口').not.toMatch(/from\s+'[^']*?\?worker'/);
    expect(client, '不许再 new 自建 worker').not.toMatch(/new\s+Kojo2Worker\s*\(/);
    expect(client, '必须从池里借线程').toMatch(/acquireStructureThread\(/);

    expect(sourceOf('kojo2-worker.ts'), 'worker 侧不再自己装消息环').not.toMatch(/startKojo2Worker/);
    expect(sourceOf('structure.worker.ts'), 'kojo2 以自定义后端挂进池的第三份 bundle').toMatch(/createKojo2PoolBackend/);
  });
});
