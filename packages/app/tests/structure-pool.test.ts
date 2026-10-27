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

const { acquireStructureThread, closeStructurePool, resetStructurePoolForTests, structurePoolStats } = await import(
  '../src/monaco/tree-sitter/structure-pool'
);

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
