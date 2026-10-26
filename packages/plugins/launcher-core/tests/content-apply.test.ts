/**
 * `ContentManager.applyInstall`：单飞、任务认领、取消、失败回滚与冲突决议。
 *
 * 回滚本身是宿主的活（core 不碰盘），所以「逆序删掉已写文件」这条断言落在假宿主的
 * 调用次序上；core 这边断言的是**它该负责的三件事**：锁、任务终态、不落 ownership。
 */

import { describe, expect, it } from 'vitest';
import { makeContentHarness } from './helpers/content-harness';
import {
  makeContentFile,
  makeContentManifest,
  makeHostConflict,
  makeHostContentPlan,
  makeTask,
} from './helpers/fake-host';

const ARCHIVE = 'C:/tmp/pack.zip';

function threeFiles() {
  return makeContentManifest({
    files: [
      makeContentFile('script', 'mod/a.txt', 1),
      makeContentFile('script', 'mod/b.txt', 1),
      makeContentFile('data', 'data/c.csv', 1),
    ],
  });
}

async function planOf(harness: ReturnType<typeof makeContentHarness>, plan = makeHostContentPlan({ manifest: threeFiles() })) {
  harness.host.planByArchive.set(ARCHIVE, plan);
  return harness.manager.planInstall('i1', ARCHIVE);
}

describe('内容包安装 · 成功路径', () => {
  it('任务落 succeeded、ownership 只写一次、文件按计划写入', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness);

    const task = await harness.manager.applyInstall(plan.planId);

    expect(task.state).toBe('succeeded');
    expect(task.kind).toBe('content-install');
    expect(task.instanceId).toBe('i1');
    expect(task.result).toEqual({ packId: 'demo.pack', files: 3 });
    expect(harness.host.applyResolutions).toBeUndefined();
    expect(harness.host.ownershipWrites).toEqual([
      { packId: 'demo.pack', files: ['script/mod/a.txt', 'script/mod/b.txt', 'data/data/c.csv'] },
    ]);
    expect(harness.host.writeLog).toEqual([
      'write:script/mod/a.txt',
      'write:script/mod/b.txt',
      'write:data/data/c.csv',
    ]);
    expect(harness.host.calls.filter((call) => call.startsWith('contentApply'))).toEqual([
      'contentApply:plan-1',
    ]);
    expect(harness.tasks.get(task.id)?.state).toBe('succeeded');
  });

  it('计划一次性消费：同一条 planId 第二次 apply 直接失效（不许重复落盘）', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness);
    await harness.manager.applyInstall(plan.planId);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划不存在或已失效，请重新预检',
      detail: 'planId=plan-1',
    });
  });

  it('成功后单飞锁立即释放：同实例下一份计划可以马上执行', async () => {
    const harness = makeContentHarness();
    const first = await planOf(harness);
    await harness.manager.applyInstall(first.planId);

    const second = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ id: 'demo.pack2', files: [makeContentFile('script', 'mod/d.txt', 1)] }),
        planId: 'plan-2',
      }),
    );
    const task = await harness.manager.applyInstall(second.planId);

    expect(task.state).toBe('succeeded');
    expect(harness.host.ownershipWrites.map((write) => write.packId)).toEqual(['demo.pack', 'demo.pack2']);
  });
});

describe('内容包安装 · 每实例单飞', () => {
  it('并发的第二次 apply 被明确拒绝（任务进行中），不是静默排队', async () => {
    const harness = makeContentHarness();
    harness.host.holdApply = true;
    const first = await planOf(harness);
    const running = await harness.manager.applyInstall(first.planId);
    expect(running.state).toBe('running');

    const second = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ id: 'demo.pack2', files: [makeContentFile('script', 'mod/d.txt', 1)] }),
        planId: 'plan-2',
      }),
    );

    await expect(harness.manager.applyInstall(second.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_TASK_BUSY',
      message: '该实例已有内容变更正在进行中，请等它结束',
      detail: expect.stringContaining('plan-1'),
    });
    expect(harness.host.calls.filter((call) => call.startsWith('contentApply'))).toEqual([
      'contentApply:plan-1',
    ]);
    // 被拒的那份计划没被消费：锁一松就能用
    expect(harness.host.ownershipWrites).toEqual([]);
  });

  it('任务终态（kojo:launcher-task 快照）到达后锁释放，第二份计划可执行', async () => {
    const harness = makeContentHarness();
    harness.host.holdApply = true;
    const first = await planOf(harness);
    const running = await harness.manager.applyInstall(first.planId);

    const second = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ id: 'demo.pack2', files: [makeContentFile('script', 'mod/d.txt', 1)] }),
        planId: 'plan-2',
      }),
    );
    // 宿主的终态事件（`index.ts` 里由 `host.onTask` 认领，这里直接给任务中心同一份快照）
    harness.tasks.adopt(
      makeTask(running.id, { state: 'succeeded', startedAt: '2026-10-26T12:00:01.000Z', endedAt: '2026-10-26T12:00:02.000Z' }),
    );
    harness.host.holdApply = false;

    const task = await harness.manager.applyInstall(second.planId);

    expect(task.state).toBe('succeeded');
  });
});

describe('内容包安装 · 冲突决议', () => {
  const conflicted = () =>
    makeHostContentPlan({
      manifest: makeContentManifest({
        files: [makeContentFile('script', 'mod/new.txt', 1), makeContentFile('script', 'mod/shared.txt', 1)],
      }),
      conflicts: [
        makeHostConflict('script', 'mod/shared.txt', { kind: 'other-pack', existingPackId: 'other.pack' }),
      ],
    });

  it('有冲突但一条决议都没给 ⇒ 整包中止，宿主零 apply', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness, conflicted());

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '还有冲突没有决断，已中止安装',
      detail: 'script/mod/shared.txt（other-pack）',
    });
    expect(harness.host.calls).toEqual(['contentPlan:i1:C:/tmp/pack.zip']);
  });

  it('逐条 replace 后 apply 继续，并把决议原样交给宿主', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness, conflicted());

    const task = await harness.manager.applyInstall(plan.planId, [
      { rootId: 'script', path: 'mod/shared.txt', action: 'replace' },
    ]);

    expect(task.state).toBe('succeeded');
    expect(harness.host.applyResolutions).toEqual([
      { rootId: 'script', path: 'mod/shared.txt', action: 'replace' },
    ]);
    expect(harness.host.ownershipWrites[0]?.files).toEqual(['script/mod/new.txt', 'script/mod/shared.txt']);
  });

  it('基础文件覆盖选 skip ⇒ 该文件不写、不进 ownership', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({
          files: [makeContentFile('script', 'mod/a.txt', 1), makeContentFile('script', 'mod/base.txt', 1)],
        }),
        conflicts: [makeHostConflict('script', 'mod/base.txt', { kind: 'base-file' })],
      }),
    );

    await harness.manager.applyInstall(plan.planId, [
      { rootId: 'script', path: 'mod/base.txt', action: 'skip' },
    ]);

    expect(harness.host.writeLog).toEqual(['write:script/mod/a.txt']);
    expect(harness.host.ownershipWrites[0]?.files).toEqual(['script/mod/a.txt']);
  });

  it('基础文件用 replace ⇒ 拒（replace 没有「从谁手里拿归属」的对象）', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'mod/base.txt', 1)] }),
        conflicts: [makeHostConflict('script', 'mod/base.txt', { kind: 'base-file' })],
      }),
    );

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'script', path: 'mod/base.txt', action: 'replace' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '基础游戏文件只能用 overwrite 或 skip',
      detail: 'script/mod/base.txt',
    });
    expect(harness.host.writeLog).toEqual([]);
  });

  it('别的包的文件用 overwrite ⇒ 拒（要 replace 才能转移归属）', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness, conflicted());

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'script', path: 'mod/shared.txt', action: 'overwrite' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '覆盖别的包写过的文件需用 replace（转移归属）',
    });
  });

  it('同一文件给两条决议 ⇒ 拒', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness, conflicted());

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'script', path: 'mod/shared.txt', action: 'skip' },
        { rootId: 'script', path: 'mod/shared.txt', action: 'replace' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '同一个文件给了多条冲突决议，已拒绝',
    });
  });

  it('决议里有计划之外的冲突项 ⇒ 拒（拼错路径不能静默吞掉）', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(harness, conflicted());

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'script', path: 'mod/shared.txt', action: 'skip' },
        { rootId: 'script', path: 'mod/typo.txt', action: 'skip' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '决议里有计划之外的冲突项，已拒绝',
      detail: 'script/mod/typo.txt',
    });
  });
});

describe('内容包安装 · 前置拒绝', () => {
  it('过期计划在 apply 时再核一遍（预检后放久了就作废）', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(
      harness,
      makeHostContentPlan({ manifest: threeFiles(), expiresAt: '2026-10-26T12:00:01.000Z' }),
    );
    expect(plan.expiresAt).toBe('2026-10-26T12:00:01.000Z');

    harness.advance(5_000);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划已过期，请重新预检',
      detail: 'planId=plan-1 过期于 2026-10-26T12:00:01.000Z',
    });
    expect(harness.host.calls).toEqual(['contentPlan:i1:C:/tmp/pack.zip']);
    expect(harness.host.ownershipWrites).toEqual([]);
  });

  it('依赖未满足 ⇒ LAUNCHER_PLUGIN_DEPENDENCY（不装一半）', async () => {
    const harness = makeContentHarness();
    const plan = await planOf(
      harness,
      makeHostContentPlan({
        manifest: threeFiles(),
        missingRequirements: ['other.pack 1.0.0'],
      }),
    );

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_DEPENDENCY',
      message: '内容包声明的依赖未满足，已拒绝安装',
      detail: 'other.pack 1.0.0',
    });
    expect(harness.host.calls.some((call) => call.startsWith('contentApply'))).toBe(false);
  });

  it('未知 planId ⇒ 失效错误（不落盘、不猜实例）', async () => {
    const harness = makeContentHarness();

    await expect(harness.manager.applyInstall('plan-ghost')).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划不存在或已失效，请重新预检',
      detail: 'planId=plan-ghost',
    });
    expect(harness.host.calls).toEqual([]);
  });
});

describe('内容包安装 · 失败回滚与透传', () => {
  it('apply 中途失败 ⇒ 宿主逆序删掉已写文件、ownership 不落账、任务 failed、锁释放', async () => {
    const harness = makeContentHarness();
    harness.host.failApplyAt = 2;
    const plan = await planOf(harness);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      message: '写入时超出体积限额，已中止',
      detail: expect.stringContaining('data/data/c.csv'),
    });

    expect(harness.host.writeLog).toEqual([
      'write:script/mod/a.txt',
      'write:script/mod/b.txt',
      'delete:script/mod/b.txt',
      'delete:script/mod/a.txt',
      'rollback-done',
    ]);
    expect(harness.host.ownershipWrites).toEqual([]);
    const failed = harness.tasks.list().find((task) => task.kind === 'content-install');
    expect(failed?.state).toBe('failed');
    expect(failed?.error?.code).toBe('LAUNCHER_ARCHIVE_LIMIT');
    // 锁已释放：同一实例还能再开一份计划
    const retry = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ id: 'demo.pack2', files: [makeContentFile('script', 'mod/d.txt', 1)] }),
        planId: 'plan-2',
      }),
    );
    harness.host.failApplyAt = null;
    await expect(harness.manager.applyInstall(retry.planId)).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('宿主 apply 命令直接抛错 ⇒ 码原样透传，锁不残留', async () => {
    const harness = makeContentHarness();
    harness.host.applyError = { code: 'LAUNCHER_SOURCE_NOT_APPROVED', message: '该目录尚未被批准写入' };
    const plan = await planOf(harness);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      message: '该目录尚未被批准写入',
      detail: '内容包安装失败',
    });
    expect(harness.host.ownershipWrites).toEqual([]);

    harness.host.applyError = null;
    const retry = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ id: 'demo.pack2', files: [makeContentFile('script', 'mod/d.txt', 1)] }),
        planId: 'plan-2',
      }),
    );
    await expect(harness.manager.applyInstall(retry.planId)).resolves.toMatchObject({ state: 'succeeded' });
  });
});

describe('内容包安装 · 取消', () => {
  it('取消 ⇒ 让宿主回滚、任务落 cancelled、ownership 不落盘、锁释放', async () => {
    const harness = makeContentHarness();
    harness.host.holdApply = true;
    const plan = await planOf(harness);
    const running = await harness.manager.applyInstall(plan.planId);

    await harness.tasks.cancel(running.id);

    expect(harness.host.cancelRequests).toEqual([running.id]);
    expect(harness.tasks.get(running.id)?.state).toBe('cancelled');
    expect(harness.tasks.get(running.id)?.endedAt).toBe('2026-10-26T12:00:00.000Z');
    expect(harness.host.ownershipWrites).toEqual([]);
    // 取消后计划不可再被「重放」
    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划不存在或已失效，请重新预检',
    });
    // 锁已释放：下一份计划能干活
    harness.host.holdApply = false;
    const next = await planOf(
      harness,
      makeHostContentPlan({
        manifest: makeContentManifest({ id: 'demo.pack2', files: [makeContentFile('script', 'mod/d.txt', 1)] }),
        planId: 'plan-2',
      }),
    );
    await expect(harness.manager.applyInstall(next.planId)).resolves.toMatchObject({ state: 'succeeded' });
  });
});
