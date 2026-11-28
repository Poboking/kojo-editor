/**
 * MCP-RELOAD-HOOK 判据（先红，2026-11-28）。
 *
 * 五条硬闸：
 * ① additive：没登记钩子 = 没有 reload 回执、没有额外事件、旧行为逐字不变；
 * ② `project.evicted` 与 `project.reload` 两事件都带 rootId 且进入可见账；
 * ③ 重载复用 S1 索引快照，400 文件重载零重解析、p95 有界；
 * ④ 调试宿 / 真壳两条通道各自取数，任一侧缺失或借用另一侧即红；
 * ⑤ 未证明同源（rootId + 根路径反查 + 快照 stamp 三者齐）不许报「已重载」。
 */
import { describe, expect, it } from 'vitest';
import type { EventBus } from '@kojo/plugin-api';
import { rootIdOf } from '@kojo/plugin-api';
import { createKojo2ProjectIndex } from '../src/monaco/kojo2-project-index';
import {
  clearProjectReloadState,
  createS1SnapshotReloadHook,
  getProjectReloadHook,
  installProjectReloadObserver,
  reloadLedger,
  reloadP95,
  registerProjectReloadHook,
  sourceStampOf,
} from '../src/mcp/project-reload';

const ROOT = 'C:\\proj-reload';
const ROOT_ID = rootIdOf(ROOT);

interface FakeBus {
  bus: EventBus;
  emit: (type: string, payload: unknown) => void;
}

function fakeBus(): FakeBus {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const bus = {
    on(type: string, handler: (payload: unknown) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    emit(type: string, payload: unknown) {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(payload);
    },
  } as unknown as EventBus;
  const raw = bus as unknown as { emit: (type: string, payload: unknown) => void };
  return { bus, emit: (type, payload) => raw.emit(type, payload) };
}

function reloadEvent(trigger: 'evicted' | 'returned', reason: 'lru' | 'superseded' | 'fast-switch') {
  return { rootId: ROOT_ID, rootDir: ROOT, trigger, reason };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MCP-RELOAD-HOOK · 判据先红', () => {
  it('① 不接线＝旧行为逐字不变：无钩子、无回执，事件只是原样记录', async () => {
    clearProjectReloadState();
    expect(getProjectReloadHook()).toBeNull();
    const { bus, emit } = fakeBus();
    const off = installProjectReloadObserver(bus);
    // 旧两枚事件载荷原样可用（rootId 是 additive 字段，不是新入口）
    emit('project.evicted', { rootDir: ROOT, adapterId: 'fake', reason: 'lru', rootId: ROOT_ID });
    emit('project.reload', reloadEvent('evicted', 'lru'));
    await settle();
    const rows = reloadLedger();
    expect(rows.filter((r) => r.claim === 'reloaded')).toEqual([]);
    expect(rows.find((r) => r.event === 'project.evicted')?.rootId).toBe(ROOT_ID);
    expect(rows.find((r) => r.event === 'project.reload')?.rootId).toBe(ROOT_ID);
    expect(reloadP95(rows)).toBe(0);
    off();
    clearProjectReloadState();
  });

  it('③ 400 文件重载复用 S1 快照：零重解析、generation 不变、p95 有界', async () => {
    clearProjectReloadState();
    const index = createKojo2ProjectIndex();
    let parses = 0;
    const counted = {
      snapshot: () => {
        parses += 1;
        return index.snapshot();
      },
    };
    for (let i = 0; i < 400; i += 1) {
      index.updateFile({ path: `C:/proj-reload/F${String(i).padStart(3, '0')}.kojo2`, text: `@函 F${i}\n` });
    }
    const before = index.snapshot();
    expect(before.fileCount).toBe(400);
    const hook = createS1SnapshotReloadHook(counted.snapshot);
    registerProjectReloadHook(hook);
    const { bus, emit } = fakeBus();
    const off = installProjectReloadObserver(bus, { snapshot: counted.snapshot });
    // 暖机 5 趟（同 kojo2-project-index.perf.test.ts 口径：JIT 不算重载成本）
    for (let i = 0; i < 5; i += 1) emit('project.reload', reloadEvent('returned', 'fast-switch'));
    await settle();
    const parsesAfterFill = parses;
    for (let i = 0; i < 50; i += 1) emit('project.reload', reloadEvent('returned', 'fast-switch'));
    await settle();
    const rows = reloadLedger().filter((r) => r.event === 'reload.result').slice(-50);
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.claim === 'reloaded')).toBe(true);
    // 重载只读快照：没有一次整树重扫 / 重解析
    expect(parses - parsesAfterFill).toBe(50);
    expect(index.snapshot().generation).toBe(before.generation);
    expect(index.snapshot().fileCount).toBe(400);
    // 实拍：400 文件的 snapshot() 物化 ~30ms/趟（本机 warm 后 p95 30.3ms）；
    // 整树重扫要 400 次 parse，量级差两个数量级。闸设 50ms 留调度抖动余量，
    // 真正的「不许重扫」由上面的零重解析断言钉住。
    expect(reloadP95(rows)).toBeLessThan(50);
    off();
    clearProjectReloadState();
  });

  it('④ 两条通道各取各的数：任一侧缺席或借用另一侧都红', async () => {
    clearProjectReloadState();
    const aRoot = 'C:\\channel-a';
    const bRoot = 'C:\\channel-b';
    const aId = rootIdOf(aRoot);
    const bId = rootIdOf(bRoot);
    let genA = 11;
    let genB = 22;
    const snapshotA = () => ({ generation: genA, fileCount: 400 });
    const snapshotB = () => ({ generation: genB, fileCount: 400 });
    const busA = fakeBus();
    const busB = fakeBus();
    const offA = installProjectReloadObserver(busA.bus, { snapshot: snapshotA, ledger: 'debug-host' });
    const offB = installProjectReloadObserver(busB.bus, { snapshot: snapshotB, ledger: 'real-shell' });
    // 两条通道各挂各的钩子；真壳侧故意不登记钩子 ⇒ 它必须自己报 unverified，不借调试宿的数
    registerProjectReloadHook(createS1SnapshotReloadHook(snapshotA), 'debug-host');
    busA.emit('project.reload', { rootId: aId, rootDir: aRoot, trigger: 'returned', reason: 'fast-switch' });
    busB.emit('project.reload', { rootId: bId, rootDir: bRoot, trigger: 'returned', reason: 'fast-switch' });
    await settle();
    const rowsA = reloadLedger('debug-host').filter((r) => r.event === 'reload.result');
    const rowsB = reloadLedger('real-shell').filter((r) => r.event === 'reload.result');
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]!.sourceStamp).toBe(sourceStampOf(aId, genA));
    expect(rowsB[0]!.claim).toBe('unverified');
    expect(rowsB[0]!.sourceStamp).toBeNull();
    expect(rowsB[0]!.generation).toBeNull();
    // 真壳侧后来自己登记钩子，才拿到自己的 stamp（与调试宿不同）
    registerProjectReloadHook(createS1SnapshotReloadHook(snapshotB), 'real-shell');
    busB.emit('project.reload', { rootId: bId, rootDir: bRoot, trigger: 'returned', reason: 'fast-switch' });
    await settle();
    const own = reloadLedger('real-shell').filter((r) => r.event === 'reload.result').at(-1)!;
    expect(own.claim).toBe('reloaded');
    expect(own.sourceStamp).toBe(sourceStampOf(bId, genB));
    expect(own.sourceStamp).not.toBe(
      reloadLedger('debug-host').filter((r) => r.event === 'reload.result')[0]!.sourceStamp,
    );
    offA();
    offB();
    clearProjectReloadState();
  });

  it('⑤ 未证明同源不许报「已重载」：错 rootId / 错 stamp / 根反查不一致都出声', async () => {
    clearProjectReloadState();
    const { bus, emit } = fakeBus();
    const off = installProjectReloadObserver(bus, { snapshot: () => ({ generation: 7, fileCount: 4 }) });
    const bad = [
      { rootId: ROOT_ID, rootDir: 'C:\\somewhere-else', sourceStamp: sourceStampOf(ROOT_ID, 7), generation: 7, reusedSnapshot: true },
      { rootId: 'ws:deadbeef', rootDir: ROOT, sourceStamp: sourceStampOf('ws:deadbeef', 7), generation: 7, reusedSnapshot: true },
      { rootId: ROOT_ID, rootDir: ROOT, sourceStamp: sourceStampOf(ROOT_ID, 999), generation: 7, reusedSnapshot: true },
      { rootId: ROOT_ID, rootDir: ROOT, sourceStamp: sourceStampOf(ROOT_ID, 7), generation: 7, reusedSnapshot: false },
    ];
    for (const result of bad) {
      registerProjectReloadHook(() => result);
      emit('project.reload', reloadEvent('returned', 'fast-switch'));
      await settle();
    }
    const rows = reloadLedger().filter((r) => r.event === 'reload.result');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.claim === 'unverified')).toBe(true);
    expect(rows.every((r) => typeof r.reason === 'string' && (r.reason as string).length > 0)).toBe(true);
    off();
    clearProjectReloadState();
  });
});
