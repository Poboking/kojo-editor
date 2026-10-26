/**
 * 订阅面：实例 / 进程 / 任务各广播一次，退订后不再收。
 *
 * 「恰好一次」是这里唯一值得钉的东西：命令返回值与宿主事件说的是同一件事，
 * 播两遍就会让面板刷新两遍（甚至把用户正在操作的列表冲掉）。
 */

import { describe, expect, it } from 'vitest';
import type { InstanceChange, LauncherService, LauncherTask } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createLauncherPlugin } from '../src/index';
import { TaskCenterImpl } from '../src/task-center';
import { FakeHost, makeInstance, makeTask } from './helpers/fake-host';
import { makeContext, makeLaunchAdapter } from './helpers/fake-context';

async function activate(options: { host?: FakeHost; adapters?: readonly unknown[] } = {}) {
  const host = options.host ?? new FakeHost();
  const { ctx, provided } = makeContext({
    adapterContributions: options.adapters ?? [{ adapter: makeLaunchAdapter() }],
  });
  await createLauncherPlugin({ host }).activate(ctx);
  const service = provided.get(WellKnownServices.Launcher) as LauncherService | undefined;
  if (!service) throw new Error('插件没有 provide launcher.service');
  return { host, service };
}

describe('InstanceStore.subscribe', () => {
  it('创建/更新/移除各广播一次；宿主回执的同一条被吞掉（回声抑制）', async () => {
    const host = new FakeHost();
    host.instances = [makeInstance({ id: 'i1' })];
    const { service } = await activate({ host });

    const changes: InstanceChange[] = [];
    const unsubscribe = service.instances.subscribe((change) => changes.push(change));

    await service.instances.create({
      name: '新实例',
      sourceRoot: 'C:/games/demo',
      adapterId: 'demo',
      gameId: 'demo',
      candidateId: 'default',
      isolation: 'shared',
    });
    expect(changes).toEqual([{ kind: 'created', instanceId: 'i-new' }]);

    // 宿主随后推来同一条（§7.3 一定会推）：不得再播
    host.emitInstance({ kind: 'created', instanceId: 'i-new', seq: 1 });
    expect(changes).toHaveLength(1);

    // 别的变更照常播（缓存随之失效，下次 get 走宿主现取）
    host.emitInstance({ kind: 'updated', instanceId: 'i-new', seq: 2 });
    expect(changes).toHaveLength(2);

    await service.instances.update('i1', { name: '改名' });
    expect(changes.at(-1)).toEqual({ kind: 'updated', instanceId: 'i1' });
    const afterUpdate = changes.length;

    host.emitInstance({ kind: 'updated', instanceId: 'i1', seq: 3 });
    expect(changes).toHaveLength(afterUpdate);

    unsubscribe();
    host.emitInstance({ kind: 'removed', instanceId: 'i-new', seq: 4 });
    expect(changes).toHaveLength(afterUpdate);
  });

  it('adapter 缺席（该游戏只能编辑不能启动）⇒ 建实例如实拒绝', async () => {
    const { service } = await activate({ adapters: [] });
    await expect(
      service.instances.create({
        name: 'x',
        sourceRoot: 'C:/games/demo',
        adapterId: 'demo',
        gameId: 'demo',
        candidateId: 'default',
        isolation: 'shared',
      }),
    ).rejects.toMatchObject({ code: 'LAUNCHER_PLATFORM_UNSUPPORTED' });
  });

  it('候选 id 不在 probe 结果里 ⇒ LAUNCHER_EXECUTABLE_INVALID，且不落盘', async () => {
    const host = new FakeHost();
    const { service } = await activate({ host });
    await expect(
      service.instances.create({
        name: 'x',
        sourceRoot: 'C:/games/demo',
        adapterId: 'demo',
        gameId: 'demo',
        candidateId: 'no-such-candidate',
        isolation: 'shared',
      }),
    ).rejects.toMatchObject({ code: 'LAUNCHER_EXECUTABLE_INVALID' });
    expect(host.calls).not.toContain('instanceCreate');
  });

  it('移除运行中的实例：先停进程，再删实例目录', async () => {
    const host = new FakeHost();
    host.instances = [makeInstance({ id: 'i1' })];
    const { service } = await activate({ host });

    await service.processes.start('i1');
    await service.instances.remove('i1', { deleteFiles: true });

    const order = host.calls.filter(
      (call) => call === 'start' || call === 'stop' || call.startsWith('instanceRemove'),
    );
    expect(order).toEqual(['start', 'stop', 'instanceRemove:true']);
    expect(service.processes.status('i1').state).toBe('exited');
  });
});

describe('ProcessSupervisor.subscribe', () => {
  it('每次状态迁移恰好一条；退订后不再收', async () => {
    const host = new FakeHost();
    const { service } = await activate({ host });

    const states: string[] = [];
    const unsubscribe = service.processes.subscribe((status) => states.push(status.state));

    await service.processes.start('i1');
    expect(states).toEqual(['starting', 'running']);

    // 宿主推同一条 running（cmd 返回值与事件说的是同一件事）⇒ 不重复播
    host.emitProcess({
      instanceId: 'i1',
      seq: 1,
      status: { ...service.processes.status('i1') },
    });
    expect(states).toEqual(['starting', 'running']);

    await service.processes.stop('i1');
    expect(states).toEqual(['starting', 'running', 'stopping', 'exited']);

    unsubscribe();
    host.emitProcess({
      instanceId: 'i1',
      seq: 2,
      status: { ...service.processes.status('i1'), state: 'crashed', exitCode: 3 },
    });
    expect(states).toHaveLength(4);
  });
});

describe('TaskCenter.subscribe', () => {
  it('任务快照变更各广播一次，重复快照不重复播', async () => {
    const host = new FakeHost();
    const { service } = await activate({ host });

    const tasks = service.tasks as TaskCenterImpl;
    const seen: LauncherTask[] = [];
    const unsubscribe = service.tasks.subscribe((task) => seen.push(task));

    tasks.adopt(makeTask('t1', { state: 'running' }));
    expect(seen.map((task) => task.state)).toEqual(['running']);

    tasks.adopt(makeTask('t1', { state: 'running' })); // 同一份快照
    expect(seen).toHaveLength(1);

    tasks.adopt(makeTask('t1', { state: 'succeeded', endedAt: '2026-10-26T00:00:05.000Z' }));
    expect(seen.map((task) => task.state)).toEqual(['running', 'succeeded']);

    unsubscribe();
    tasks.adopt(makeTask('t1', { state: 'failed', endedAt: '2026-10-26T00:00:06.000Z' }));
    expect(seen).toHaveLength(2);
  });

  it('宿主任务事件被收养，取消转成宿主命令', async () => {
    const host = new FakeHost();
    const { service } = await activate({ host });

    host.emitTask({ task: makeTask('t9', { state: 'running', startedAt: '2026-10-26T00:00:01.000Z' }), seq: 1 });
    expect(service.tasks.get('t9')?.state).toBe('running');

    await service.tasks.cancel('t9');
    // 请求语义：状态仍是 running，宿主收到取消命令
    expect(service.tasks.get('t9')?.state).toBe('running');
    expect(host.cancelRequests).toEqual(['t9']);
  });
});
