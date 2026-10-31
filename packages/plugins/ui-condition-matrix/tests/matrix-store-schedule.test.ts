/**
 * `matrix-store` 的**建表调度**（STATE §四 那条欠账的钉子）。
 *
 * 为什么单独成文件：这条判据不是"矩阵算得对不对"（那在 `matrix-logic.test.ts`），
 * 而是"这次全量聚合落在哪一帧"。`buildCharacterIndex` 实测 **292ms**（117k 函数），
 * 而触发它的 `kojo.functionChanged` 是索引任务里同步发出来的——同一拍建表，等于让
 * 「索引已可用」那一帧再背一次账（`navigator-store` 2026-10-16 已按同形收口）。
 *
 * 四条：
 * 1. `ensureIndex` 回包后**同步不建**，宏任务才建（`depsEpoch` 与 `indexReady` 双观测）；
 * 2. 同一轮里多次触发只建一次（后到的索引赢，不是每次触发都全量扫一遍）；
 * 3. 归属守卫：回包时项目已换 ⇒ 不建（否则建成「A 索引 + B 角色字典」）；
 * 4. `project.closed` 清掉挂起的建表 ⇒ 宏任务不把已关项目的矩阵建回来。
 */

import { describe, expect, it } from 'vitest';
import type {
  ConditionExtractorService,
  ErbIndex,
  ErbParserService,
  FileIO,
  PluginContext,
  ProjectService,
} from '@kojo/plugin-api';
import type { AdapterServices } from '../src/adapter-services';
import { createMatrixStore } from '../src/matrix-store';

/* ------------------------------ 假件 ------------------------------ */

/** 最小假索引：`buildCharacterIndex` 见 `files` 缺失即返回空索引，不碰文件内容 */
const fakeIndex = (): ErbIndex => ({ files: new Map() }) as unknown as ErbIndex;

function fakeCtx() {
  const handlers = new Map<string, Array<() => void>>();
  const ctx = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus: {
      on: (name: string, fn: () => void) => {
        const arr = handlers.get(name) ?? [];
        arr.push(fn);
        handlers.set(name, arr);
        return () => {};
      },
    },
    onDispose: () => {},
  };
  return {
    ctx: ctx as unknown as PluginContext,
    emit: (name: string): void => {
      for (const fn of handlers.get(name) ?? []) fn();
    },
  };
}

/** 手动挡的 `ensureIndex`：每次调用挂一个待决 promise，由用例决定何时回包 */
function harness() {
  const pending: Array<(value: ErbIndex) => void> = [];
  const parser = {
    ensureIndex: () =>
      new Promise<ErbIndex>((resolve) => {
        pending.push(resolve);
      }),
  } as unknown as ErbParserService;

  let current: unknown = null;
  const project = { current: () => current } as unknown as ProjectService;
  const conditionExtractor = { subscribe: () => () => {} } as unknown as ConditionExtractorService;
  const services = {
    currentFamilyIndex: () => null,
    depsOf: () => [],
  } as unknown as AdapterServices;
  const io = {} as unknown as Pick<FileIO, 'walkDir' | 'readTexts'>;

  const { ctx, emit } = fakeCtx();
  const store = createMatrixStore(ctx, { parser, project, conditionExtractor, services, io });

  return {
    store,
    pending,
    emit,
    /** 打开（或切到）一个项目 */
    open: (root: string): void => {
      current = { rootDir: root };
    },
    /** 关项目（真壳里就是 `project.close()` 的同一拍） */
    close: (): void => {
      current = null;
      emit('project.closed');
    },
  };
}

/** 排空一层微任务：`.then` 跑完、`scheduleRebuild` 已把建表排进宏任务，但还没落地 */
const flushMicrotasks = (): Promise<void> => Promise.resolve();
/** 跑一轮宏任务：`setTimeout(...,0)` 的建表真正执行 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 等"一整趟建表调度"落定：先排空微任务（`scheduleRebuild` 把建表排进宏任务），
 * 再走一轮宏任务让它执行。
 *
 * ⚠ 顺序不能倒：若先 `await tick()` 再让微任务跑，tick 自己的 timer 会排在建表之前，
 * 断言就会读到"还没建"（本文件第一版就这么红过——与 PITFALLS 里"量具与真实时序不同形"同族）。
 */
async function settleSchedule(): Promise<void> {
  await flushMicrotasks();
  await tick();
}

/* ------------------------------ 用例 ------------------------------ */

describe('matrix-store · 建表调度', () => {
  it('索引回包不跟建表同一拍：同步不建，宏任务才建', async () => {
    const h = harness();
    h.open('A');
    const epoch = h.store.depsEpoch;

    h.store.refresh();
    expect(h.pending).toHaveLength(1);
    h.pending[0]!(fakeIndex());

    await flushMicrotasks(); // `.then` 跑完（排上了宏任务）
    expect(h.store.depsEpoch).toBe(epoch); // 这一拍没建
    expect(h.store.indexReady).toBe(false);

    await tick();
    expect(h.store.depsEpoch).toBe(epoch + 1);
    expect(h.store.indexReady).toBe(true);
  });

  it('同一轮多次触发只建一次（后到的索引赢）', async () => {
    const h = harness();
    h.open('A');
    const epoch = h.store.depsEpoch;

    h.store.refresh();
    h.store.refresh();
    expect(h.pending).toHaveLength(2);
    h.pending[0]!(fakeIndex());
    h.pending[1]!(fakeIndex());

    await settleSchedule();
    expect(h.store.depsEpoch).toBe(epoch + 1); // 不是 +2：调度把同轮的两拍并成一拍
  });

  it('回包时项目已换 ⇒ 不建（归属守卫）', async () => {
    const h = harness();
    h.open('A');
    const epoch = h.store.depsEpoch;

    h.store.refresh();
    h.open('B'); // ensureIndex 在途时切项目
    h.pending[0]!(fakeIndex());

    await settleSchedule();
    expect(h.store.depsEpoch).toBe(epoch); // 旧索引没被建成 B 的矩阵
    expect(h.store.indexReady).toBe(false);
  });

  it('project.closed 清掉挂起的建表 ⇒ 宏任务不复活', async () => {
    const h = harness();
    h.open('A');

    // 先建成一次，让 indexReady 真的为 true（否则"没复活"与"从没建过"分不开）
    h.store.refresh();
    h.pending[0]!(fakeIndex());
    await settleSchedule();
    expect(h.store.indexReady).toBe(true);

    // 第二次回包已排上宏任务，此刻关项目
    h.store.refresh();
    h.pending[1]!(fakeIndex());
    await flushMicrotasks();
    h.close();

    await settleSchedule();
    expect(h.store.indexReady).toBe(false); // 没被复活
    expect(h.store.characterIndex).toBeNull();
  });
});
