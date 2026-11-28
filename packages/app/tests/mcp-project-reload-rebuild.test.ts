/**
 * WP-3a：`project.reload` 的消费方**真正增量重建**（不是只读一份快照盖章）。
 *
 * 现状（WP-3b 之后）：`createS1SnapshotReloadHook` 只读 `snapshot()` 拿 generation 算同源
 * stamp —— 它**什么都没重建**，`reusedSnapshot:true` 的实际含义是「我没干活，但我证明我
 * 看的是同一份快照」。账本因此只能证明「换代请求到了」，不能证明「消费方跟上了」。
 *
 * 本批要补的是后半句，判据先红：
 *  1. **增量**：内容没变的文件**一次都不调** `updateFile`（只读比对），计 `unchanged`。
 *  2. **三种改动都要落地**：新增 / 内容变更 / 消失，逐类计数，不许合并成一个 `changed`。
 *  3. **同源 + 自证**：`rebuilt` 三计数之和必须等于 `generation` 的增量——
 *     这是「重建真的发生了、且只做了它宣称的那些事」的机械证据，写在回执里、可被账本复核。
 *  4. **并发不许乐观**：重建期间索引被别人 +1 ⇒ `unverified` + 理由（不谎报 reloaded）。
 *  5. **不许把全量重扫说成增量**：seams 自报整表重扫 ⇒ `reusedSnapshot` 必须为 false。
 *  6. **失败出声**：读文件抛错 ⇒ `unverified` + 理由，账本里看得见。
 *  7. **空根**：目标为空 ⇒ 全删，计数仍自洽。
 *
 * 计时那条（200 文件 / 5% 变化的相对读数）在 `mcp-project-reload-rebuild.perf.test.ts`：
 * `tools/perf-suite.mjs` 按源码谓词把含 `performance.now()` 的比较归到计时串行池，
 * 混在本文件会被主池排除——分开是**遵守既有分池口径**，不是把读数挪走藏起来。
 */
import { describe, expect, it } from 'vitest';
import { createKojo2ProjectIndex } from '../src/monaco/kojo2-project-index';
import {
  createS1IncrementalReloadHook,
  type ReloadRebuildSeams,
} from '../src/mcp/project-reload-rebuild';
import { rootIdOf, verifyReloadReceipt, type ProjectReloadResult } from '../src/mcp/project-reload';
import type { ProjectReloadEvent } from '@kojo/plugin-api';

const ROOT_DIR = '/proj/a';
/** 真口径：rootId 由 rootDir 反查得出，测试不自己编一个（否则同源闸会红，见判据④）。 */
const ROOT_ID = rootIdOf(ROOT_DIR);

const reloadEvent = (rootId = ROOT_ID, rootDir = ROOT_DIR): ProjectReloadEvent => ({
  rootId,
  rootDir,
  // 契约里 `trigger` 只有两枚（`evicted` / `returned`），快切回来固定 `reason:'fast-switch'`。
  // 这里**不写 as 断言**：夹具必须是生产真能发出的那一种，否则类型闸看不到漂移
  // （WP-3a 初版写成 `trigger:'activate'` + as，`pnpm --filter @kojo/app typecheck` 一直红）。
  trigger: 'returned',
  reason: 'fast-switch',
});

/** 用真索引 + 假文件系统：接缝就是「盘上有什么」与「索引怎么喂」，重建逻辑本身不假。 */
function makeSeams(initial: Record<string, string>, options: { throwOn?: string } = {}) {
  const index = createKojo2ProjectIndex();
  const disk = new Map(Object.entries(initial));
  const calls = { update: 0, remove: 0, read: 0 };
  for (const [p, text] of disk) index.updateFile({ path: p, text });
  const seams: ReloadRebuildSeams = {
    snapshot: () => index.snapshot(),
    files: () => index.files(),
    getFile: (path) => index.getFile(path),
    readText: async (path) => {
      calls.read += 1;
      if (options.throwOn === path) throw new Error(`读盘失败：${path}`);
      return disk.get(path) ?? null;
    },
    updateFile: (input) => {
      calls.update += 1;
      return index.updateFile(input);
    },
    removeFile: (path) => {
      calls.remove += 1;
      return index.removeFile(path);
    },
    listTargets: async () => [...disk.keys()].sort(),
  };
  return { index, disk, calls, seams };
}

describe('WP-3a 增量重建接缝', () => {
  it('① 增量：内容没变的文件一次都不喂索引（只读比对）', async () => {
    const { calls, seams } = makeSeams({ '/proj/a/x.kojo': 'A', '/proj/a/y.kojo': 'B' });
    const hook = createS1IncrementalReloadHook(seams);
    const receipt = (await hook(reloadEvent())) as ProjectReloadResult;

    expect(calls.update, '未变文件被重新喂索引＝假增量').toBe(0);
    expect(calls.remove).toBe(0);
    expect(receipt.rebuilt).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 2 });
  });

  it('② 三种改动逐类落地：新增 / 变更 / 消失', async () => {
    const { disk, calls, seams } = makeSeams({ '/proj/a/keep.kojo': 'K', '/proj/a/gone.kojo': 'G' });
    disk.set('/proj/a/keep.kojo', 'K2'); // 内容变更
    disk.set('/proj/a/new.kojo', 'N'); // 新增
    disk.delete('/proj/a/gone.kojo'); // 消失

    const receipt = (await createS1IncrementalReloadHook(seams)(reloadEvent())) as ProjectReloadResult;
    expect(receipt.rebuilt).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 0 });
    expect(calls.update).toBe(2); // 变更 + 新增
    expect(calls.remove).toBe(1);
  });

  it('③ 自证：rebuilt 三计数之和 === generation 增量', async () => {
    const { index, disk, seams } = makeSeams({ '/proj/a/keep.kojo': 'K', '/proj/a/gone.kojo': 'G' });
    const before = index.snapshot().generation;
    disk.set('/proj/a/keep.kojo', 'K2');
    disk.set('/proj/a/new.kojo', 'N');
    disk.delete('/proj/a/gone.kojo');

    const receipt = (await createS1IncrementalReloadHook(seams)(reloadEvent())) as ProjectReloadResult;
    const after = index.snapshot().generation;
    expect(receipt.generationBefore).toBe(before);
    expect(receipt.generation).toBe(after);
    const r = receipt.rebuilt!;
    expect(after - before).toBe(r.added + r.updated + r.removed);
  });

  it('④ 并发不许乐观：重建期间索引被别人 +1 ⇒ unverified + 理由', async () => {
    const { index, disk, seams } = makeSeams({ '/proj/a/x.kojo': 'A' });
    disk.set('/proj/a/y.kojo', 'B');
    // 在「喂索引」这一拍插一次外部改动（模拟用户在重建期间编辑了别的文件）。
    const sneaky: ReloadRebuildSeams = {
      ...seams,
      updateFile: (input) => {
        const out = seams.updateFile(input);
        index.updateFile({ path: '/proj/a/other.kojo', text: 'external' });
        return out;
      },
    };

    const receipt = (await createS1IncrementalReloadHook(sneaky)(reloadEvent())) as ProjectReloadResult;
    // 自报三计数（1 新增）与 generation 增量（2）对不上 —— 由 verify 判，不在钩子里猜。
    expect(receipt.rebuilt).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: 1 });
    expect(receipt.generation! - receipt.generationBefore!).toBe(2);

    const verdict = verifyReloadReceipt(reloadEvent(), receipt);
    expect(verdict.claim).toBe('unverified');
    expect(verdict.reason).toMatch(/并发|对不上/);
  });

  it('⑤ 不许把全量重扫说成增量：seams 自报 rescannedAll ⇒ reusedSnapshot=false', async () => {
    const { seams } = makeSeams({ '/proj/a/x.kojo': 'A' });
    const receipt = (await createS1IncrementalReloadHook({ ...seams, rescannedAll: () => true })(reloadEvent())) as ProjectReloadResult;
    expect(receipt.reusedSnapshot).toBe(false);
  });

  it('⑥ 失败出声：读盘抛错 ⇒ 回执带 unverified 理由，账本里看得见', async () => {
    const { disk, seams } = makeSeams({ '/proj/a/x.kojo': 'A' }, { throwOn: '/proj/a/bad.kojo' });
    disk.set('/proj/a/bad.kojo', 'B');
    const receipt = (await createS1IncrementalReloadHook(seams)(reloadEvent())) as ProjectReloadResult;
    expect(receipt.failure).toMatch(/读盘失败/);
    expect(receipt.rebuilt).toBeUndefined();

    const verdict = verifyReloadReceipt(reloadEvent(), receipt);
    expect(verdict.claim).toBe('unverified');
    expect(verdict.reason).toMatch(/重建失败|读盘失败/);
  });

  it('⑦ 空根：目标为空 ⇒ 全删，计数仍自洽', async () => {
    const { index, disk, seams } = makeSeams({ '/proj/a/x.kojo': 'A', '/proj/a/y.kojo': 'B' });
    disk.clear();
    const receipt = (await createS1IncrementalReloadHook(seams)(reloadEvent())) as ProjectReloadResult;
    expect(receipt.rebuilt).toMatchObject({ added: 0, updated: 0, removed: 2, unchanged: 0 });
    expect(index.files()).toEqual([]);
  });

  it('⑧ 逐出档案（trigger:evicted）只清残留、不重建：一次盘读都不做', async () => {
    const { index, calls, seams } = makeSeams({
      '/proj/a/x.kojo': 'A',
      '/proj/b/y.kojo': 'B',
    });
    const before = index.snapshot().generation;
    const receipt = (await createS1IncrementalReloadHook(seams)({
      ...reloadEvent(),
      trigger: 'evicted',
      reason: 'lru',
    })) as ProjectReloadResult;

    // 该根不在驻留集了：正确动作是清掉它的残留，**不是**给它重建（那会把离开的项目灌回索引）。
    expect(receipt.rebuilt).toMatchObject({ mode: 'prune', removed: 1, added: 0, updated: 0 });
    expect(calls.read, '逐出不该为「离开」付「进入」的代价').toBe(0);
    expect(calls.update).toBe(0);
    // 别的根的条目一根不动。
    expect(index.files()).toEqual(['/proj/b/y.kojo']);
    // 自证等式对 prune 一样成立。
    expect(index.snapshot().generation - before).toBe(1);
  });

  it('⑨ 批量读：给了 readMany 就一次性取齐，不逐份读', async () => {
    const { disk, seams } = makeSeams({ '/proj/a/x.kojo': 'A' });
    disk.set('/proj/a/y.kojo', 'B');
    let batches = 0;
    const batched: ReloadRebuildSeams = {
      ...seams,
      readMany: async (paths) => {
        batches += 1;
        return paths.map((p) => disk.get(p) ?? null);
      },
    };
    const receipt = (await createS1IncrementalReloadHook(batched)(reloadEvent())) as ProjectReloadResult;
    expect(batches, '一次批量读，不是 N 次单读').toBe(1);
    expect(receipt.rebuilt).toMatchObject({ mode: 'rebuild', added: 1, unchanged: 1 });
  });
});
