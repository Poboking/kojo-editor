/**
 * 每实例写盘单飞锁（`src/instance-lock.ts`）：内容包与插件门禁**共用一把**。
 *
 * 要证的四件事（对应规格 §10.1「同一实例同时只允许一个内容 / 插件变更任务」）：
 * 1. **交叉拒绝**：内容 apply 持锁 ⇒ 插件 apply 被拒，反之亦然（错误码 + detail 可读）；
 * 2. **三条释放路径都必达**：宿主返回 failed / 宿主命令直接抛异常 / 取消 ⇒ 立刻能再拿票；
 * 3. **不同实例不误拦**：票按实例编号分发，i1 忙不影响 i2；
 * 4. **锁表生命周期**：`dispose()` 清表；注入的共享锁不归单个服务所有（服务 dispose 不清它）。
 *
 * 另有一条**反例边界**：进程侧的 `start` 单飞（「能不能起进程」）不并入本锁——写盘锁
 * 持有时起进程不该被挡，否则「停-装-起」会卡在自己的锁上。
 */

import { describe, expect, it } from 'vitest';
import { InstanceLock } from '../src/instance-lock';
import {
  PLUGIN_ARCHIVE,
  makePluginHarness,
  makePluginManifest,
  pluginFile,
} from './helpers/plugin-harness';
import type { PluginHarness } from './helpers/plugin-harness';
import {
  makeContentFile,
  makeContentManifest,
  makeHostContentPlan,
  makeInstance,
  makeTask,
} from './helpers/fake-host';

const CONTENT_ARCHIVE = 'C:/tmp/content.zip';

/** 一份内容包宿主计划（落在插件的 `plugins` 根：同一台实例、同一棵盘） */
async function planContent(harness: PluginHarness, planId = 'plan-content', instanceId = 'i1') {
  harness.host.planByArchive.set(
    CONTENT_ARCHIVE,
    makeHostContentPlan({
      manifest: makeContentManifest({
        id: 'demo.pack',
        files: [makeContentFile('plugins', 'mod/content.erb')],
      }),
      planId,
    }),
  );
  return harness.content.planInstall(instanceId, CONTENT_ARCHIVE);
}

/** 起一条「正在跑」的内容安装（宿主挂起，终态由测试给） */
async function startContentApply(harness: PluginHarness, planId = 'plan-content') {
  harness.host.holdApply = true;
  const plan = await planContent(harness, planId);
  const task = await harness.content.applyInstall(plan.planId);
  expect(task.state).toBe('running');
  return task;
}

/** 登记 + 预检一份插件计划（还没 apply） */
async function planPlugin(
  harness: PluginHarness,
  input: { instanceId?: string; planId?: string; archivePath?: string; id?: string } = {},
) {
  const archivePath = input.archivePath ?? PLUGIN_ARCHIVE;
  harness.registerPlan({
    manifest: makePluginManifest({ id: input.id ?? 'demo.plugin', files: [pluginFile('mod/p.erb')] }),
    archivePath,
    ...(input.planId === undefined ? {} : { planId: input.planId }),
  });
  return harness.manager.planInstall(input.instanceId ?? 'i1', archivePath);
}

/** 取拒绝的错误体（`toMatchObject` 之外还要逐字看 detail） */
async function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('这次请求本应被单飞锁拒绝，却成功了');
    },
    (err: unknown) => err as { code?: string; message?: string; detail?: string; retryable?: boolean },
  );
}

describe('每实例单飞锁 · 内容包与插件共用一把', () => {
  it('内容 apply 持锁 ⇒ 插件 apply 被拒（LAUNCHER_TASK_BUSY，detail 说清谁挡的、挡的是谁）', async () => {
    const harness = makePluginHarness();
    const running = await startContentApply(harness);
    const plan = await planPlugin(harness);

    const error = await rejectionOf(harness.manager.applyInstall(plan.planId));

    expect(error.code).toBe('LAUNCHER_TASK_BUSY');
    expect(error.message).toBe('该实例已有内容变更正在进行中，请等它结束');
    expect(error.detail).toContain('plan-content');
    expect(error.detail).toContain(`任务 ${running.id}`);
    expect(error.detail).toContain('本次请求（插件安装）被拒');
    // 被拒的请求没有碰宿主：全程只有第一条 apply
    expect(harness.calls().filter((call) => call.startsWith('contentApply'))).toEqual([
      'contentApply:plan-content',
    ]);
  });

  it('插件 apply 持锁 ⇒ 内容 apply 被拒（反方向同样是同一把锁）', async () => {
    const harness = makePluginHarness();
    harness.host.holdApply = true;
    const pluginPlan = await planPlugin(harness, { planId: 'plan-plugin' });
    const running = await harness.manager.applyInstall(pluginPlan.planId);
    expect(running.state).toBe('running');

    const plan = await planContent(harness);
    const error = await rejectionOf(harness.content.applyInstall(plan.planId));

    expect(error.code).toBe('LAUNCHER_TASK_BUSY');
    expect(error.message).toBe('该实例已有插件变更正在进行中，请等它结束');
    expect(error.detail).toContain('plan-plugin');
    expect(error.detail).toContain('本次请求（内容包安装）被拒');
    expect(harness.calls().filter((call) => call.startsWith('contentApply'))).toEqual([
      'contentApply:plan-plugin',
    ]);
  });

  it('交叉拒绝不动原票：原任务仍 running，被拒的计划没被消费，解锁后能装', async () => {
    const harness = makePluginHarness();
    const running = await startContentApply(harness);
    const plan = await planPlugin(harness);

    await rejectionOf(harness.manager.applyInstall(plan.planId));

    expect(harness.lock.get('i1')).toMatchObject({
      kind: 'content',
      planId: 'plan-content',
      taskId: running.id,
    });
    expect(harness.tasks.get(running.id)?.state).toBe('running');
    expect(harness.host.ownershipWrites).toEqual([]);

    // 内容任务落终态 ⇒ 票立即回到锁表外，被拒的那份插件计划可以原样重放
    harness.tasks.adopt(
      makeTask(running.id, {
        state: 'succeeded',
        startedAt: '2026-10-26T12:00:01.000Z',
        endedAt: '2026-10-26T12:00:02.000Z',
      }),
    );
    harness.host.holdApply = false;
    await expect(harness.manager.applyInstall(plan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });
});

describe('每实例单飞锁 · 三条释放路径都必达', () => {
  it('宿主把任务落 failed ⇒ 票随终态释放，同实例可立刻再发别的门禁', async () => {
    const harness = makePluginHarness();
    harness.host.failApplyAt = 0;
    harness.host.holdApply = false;
    const plan = await planContent(harness);

    await expect(harness.content.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
    });
    expect(harness.lock.isBusy('i1')).toBe(false);

    harness.host.failApplyAt = null;
    const pluginPlan = await planPlugin(harness);
    await expect(harness.manager.applyInstall(pluginPlan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('宿主命令直接抛异常（没有任务快照）⇒ catch 里还票，锁不残留', async () => {
    const harness = makePluginHarness();
    harness.host.applyError = { code: 'LAUNCHER_SOURCE_NOT_APPROVED', message: '该目录尚未被批准写入' };
    const plan = await planContent(harness);

    await expect(harness.content.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      detail: '内容包安装失败',
    });
    expect(harness.lock.get('i1')).toBeNull();

    harness.host.applyError = null;
    const pluginPlan = await planPlugin(harness);
    await expect(harness.manager.applyInstall(pluginPlan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('取消 ⇒ 任务落 cancelled 的同一次广播里释放票，另一门禁可立刻接管', async () => {
    const harness = makePluginHarness();
    const running = await startContentApply(harness);

    await harness.tasks.cancel(running.id);

    expect(harness.tasks.get(running.id)?.state).toBe('cancelled');
    expect(harness.lock.isBusy('i1')).toBe(false);

    harness.host.holdApply = false;
    const plan = await planPlugin(harness);
    await expect(harness.manager.applyInstall(plan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('插件侧的异步失败终态同样释放（不是只有内容包那条链会还票）', async () => {
    const harness = makePluginHarness();
    harness.host.holdApply = true;
    const plan = await planPlugin(harness, { planId: 'plan-plugin' });
    const running = await harness.manager.applyInstall(plan.planId);

    harness.tasks.adopt(
      makeTask(running.id, {
        kind: 'content-install',
        state: 'failed',
        startedAt: '2026-10-26T12:00:01.000Z',
        endedAt: '2026-10-26T12:00:02.000Z',
        error: { code: 'LAUNCHER_ARCHIVE_LIMIT', message: '写入失败', retryable: false },
      }),
    );

    expect(harness.lock.isBusy('i1')).toBe(false);
    harness.host.holdApply = false;
    const contentPlan = await planContent(harness);
    await expect(harness.content.applyInstall(contentPlan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });
});

describe('每实例单飞锁 · 串行与并行', () => {
  it('同一实例解锁后可反复 apply（内容 → 插件 → 内容）；票不吸血、不复用', async () => {
    const harness = makePluginHarness();

    const first = await planContent(harness, 'plan-content-1');
    await expect(harness.content.applyInstall(first.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(harness.lock.isBusy('i1')).toBe(false);

    const pluginPlan = await planPlugin(harness, { planId: 'plan-plugin' });
    await expect(harness.manager.applyInstall(pluginPlan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(harness.lock.isBusy('i1')).toBe(false);

    const second = await planContent(harness, 'plan-content-2');
    await expect(harness.content.applyInstall(second.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(harness.host.ownershipWrites.map((write) => write.packId)).toEqual([
      'demo.pack',
      'demo.plugin',
      'demo.pack',
    ]);
  });

  it('不同实例并行走：i1 持锁不影响 i2 的插件安装', async () => {
    const harness = makePluginHarness();
    harness.host.instances.push(
      makeInstance({
        id: 'i2',
        gameId: 'demo',
        adapterId: 'demo-adapter',
        isolation: 'copy',
        contentRoots: harness.rules.roots,
      }),
    );
    await startContentApply(harness);
    harness.host.holdApply = false;

    const plan = await planPlugin(harness, {
      instanceId: 'i2',
      planId: 'plan-plugin-i2',
      archivePath: 'C:/tmp/plugin-i2.zip',
    });
    await expect(harness.manager.applyInstall(plan.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });

    expect(harness.lock.isBusy('i1')).toBe(true);
    expect(harness.lock.isBusy('i2')).toBe(false);
    expect(harness.lock.get('i1')).toMatchObject({ kind: 'content', planId: 'plan-content' });
  });

  it('内容包排序（setOrder）也走同一把锁：安装进行中时排序被拒', async () => {
    const harness = makePluginHarness();
    harness.host.packs.set('i1', [
      {
        manifest: makeContentManifest({ id: 'base.pack' }),
        enabled: true,
        order: 0,
        installedAt: '2026-10-26T00:00:00.000Z',
        ownedFiles: [],
        status: 'ok',
      },
    ]);
    await startContentApply(harness);

    await expect(harness.content.setOrder('i1', ['base.pack'])).rejects.toMatchObject({
      code: 'LAUNCHER_TASK_BUSY',
      message: '该实例已有内容变更正在进行中，请等它结束',
      detail: expect.stringContaining('本次请求（调整加载顺序）被拒'),
    });
    expect(harness.host.orderRequests).toEqual([]);
  });
});

describe('每实例单飞锁 · 锁表本身', () => {
  it('同实例第二个 acquire 抛 LAUNCHER_TASK_BUSY（可重试），release 后可再拿', () => {
    const harness = makePluginHarness();
    const lock = new InstanceLock({ tasks: harness.tasks });

    const first = lock.acquire('i1', 'content', { planId: 'p1', action: '内容包安装' });
    const error = (() => {
      try {
        lock.acquire('i1', 'plugin', { action: '插件安装' });
        return null;
      } catch (err) {
        return err as { code?: string; retryable?: boolean };
      }
    })();
    expect(error).toMatchObject({ code: 'LAUNCHER_TASK_BUSY', retryable: true });

    lock.release(first);
    expect(lock.isBusy('i1')).toBe(false);
    const second = lock.acquire('i1', 'plugin', { action: '插件安装' });
    expect(lock.get('i1')).toMatchObject({ kind: 'plugin', planId: null });
    lock.release(second);
    expect(lock.size).toBe(0);
  });

  it('旧票不能删新票（release 凭 token）：释放后又被别人拿到时，迟到的 release 是 no-op', () => {
    const harness = makePluginHarness();
    const lock = new InstanceLock({ tasks: harness.tasks });

    const stale = lock.acquire('i1', 'content');
    lock.release(stale);
    const fresh = lock.acquire('i1', 'plugin', { planId: 'p2' });
    lock.release(stale);

    expect(lock.get('i1')).toMatchObject({ kind: 'plugin', planId: 'p2' });
    lock.release(fresh);
    expect(lock.isBusy('i1')).toBe(false);
  });

  it('attachTask 之后，该任务一落终态就按 taskId 释放（取消 / 异步成功 / 异步失败共用这一条）', () => {
    const harness = makePluginHarness();
    const lock = new InstanceLock({ tasks: harness.tasks });
    const hold = lock.acquire('i1', 'content', { planId: 'p1' });
    lock.attachTask(hold, 't-async');

    harness.tasks.adopt(
      makeTask('t-async', {
        state: 'cancelled',
        startedAt: '2026-10-26T12:00:01.000Z',
        endedAt: '2026-10-26T12:00:02.000Z',
      }),
    );

    expect(lock.isBusy('i1')).toBe(false);
    expect(lock.size).toBe(0);
  });

  it('dispose() 清空锁表并断订阅：之后终态到达不再有任何动作', () => {
    const harness = makePluginHarness();
    const lock = new InstanceLock({ tasks: harness.tasks });
    const hold = lock.acquire('i1', 'content', { planId: 'p1' });
    lock.attachTask(hold, 't-1');
    expect(lock.size).toBe(1);

    lock.dispose();

    expect(lock.size).toBe(0);
    expect(lock.isBusy('i1')).toBe(false);
    expect(lock.get('i1')).toBeNull();
    expect(() =>
      harness.tasks.adopt(
        makeTask('t-1', {
          state: 'succeeded',
          startedAt: '2026-10-26T12:00:01.000Z',
          endedAt: '2026-10-26T12:00:02.000Z',
        }),
      ),
    ).not.toThrow();
  });

  it('注入的共享锁不归单个服务所有：content.dispose() 不清表（否则插件会拿到一把空锁）', async () => {
    const harness = makePluginHarness();
    await startContentApply(harness);

    harness.content.dispose();

    expect(harness.lock.isBusy('i1')).toBe(true);
    harness.lock.dispose();
    expect(harness.lock.size).toBe(0);
  });

  it('进程侧 start 单飞不并入：写盘锁持有时起进程不被挡（两把锁各管一段）', async () => {
    const harness = makePluginHarness();
    await startContentApply(harness);

    await expect(harness.processes.start('i1')).resolves.toMatchObject({ state: 'running' });
    // 写盘锁仍归内容包：进程起来不等于「能再装一个包」
    expect(harness.lock.get('i1')).toMatchObject({ kind: 'content', planId: 'plan-content' });
    const plan = await planPlugin(harness);
    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_TASK_BUSY',
    });
  });
});
