/**
 * 插件装配：服务键、依赖声明、initialize / dispose、未装配子服务的行为。
 *
 * 这里不测业务（各自有专测），只测「接线是否如声明」——一条错接线会让整片服务静默不存在。
 */

import { describe, expect, it } from 'vitest';
import type { LauncherService } from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createLauncherPlugin } from '../src/index';
import { TaskCenterImpl } from '../src/task-center';
import { FakeHost, makeInstance, makeStatus, makeTask } from './helpers/fake-host';
import { makeContext } from './helpers/fake-context';

describe('launcher-core · 插件形状', () => {
  it('id / 版本 / requires / provides 与契约一致', () => {
    const plugin = createLauncherPlugin();
    expect(plugin.id).toBe('launcher-core');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.requires).toEqual([KernelServices.LauncherHost, KernelServices.IO]);
    expect(plugin.optionalRequires).toEqual([KernelServices.Slots]);
    expect(plugin.provides).toEqual([WellKnownServices.Launcher]);
  });

  it('宿主从 ctx.inject(kernel.launcher) 取到并 provide launcher.service', async () => {
    const host = new FakeHost();
    const { ctx, provided } = makeContext({
      injects: { [KernelServices.LauncherHost]: host },
    });
    await createLauncherPlugin().activate(ctx);

    const service = provided.get(WellKnownServices.Launcher) as LauncherService | undefined;
    expect(service).toBeDefined();
    expect(service!.instances).toBeDefined();
    expect(service!.processes).toBeDefined();
    expect(service!.logs).toBeDefined();
    expect(service!.tasks).toBeDefined();
    // P2 才有的更新服务：不提供（契约里是可选字段，不造空壳）
    expect(service!.updates).toBeUndefined();
  });

  it('requires 里的内核 IO 只作激活闸：插件不读不写文件（不注入也不 import node:fs）', async () => {
    const host = new FakeHost();
    const { ctx } = makeContext({ injects: { [KernelServices.LauncherHost]: host } });
    // ctx.inject 会对未登记键抛错——activate 通过即证明它没有去取 kernel.io 做文件操作
    await expect(Promise.resolve(createLauncherPlugin().activate(ctx))).resolves.toBeUndefined();
  });
});

describe('launcher-core · initialize / dispose', () => {
  it('initialize 预热实例缓存、恢复任务表与进程表', async () => {
    const host = new FakeHost();
    host.instances = [makeInstance({ id: 'i1' })];
    host.tasks = [makeTask('t1', { state: 'running', startedAt: '2026-10-26T00:00:01.000Z' })];
    host.statuses.set(
      'i1',
      makeStatus('i1', {
        state: 'crashed',
        sessionId: 's1',
        startedAt: '2026-10-26T00:00:00.000Z',
        exitCode: 1,
        exitReason: 'crash',
      }),
    );

    const { ctx, provided } = makeContext({ injects: { [KernelServices.LauncherHost]: host } });
    await createLauncherPlugin().activate(ctx);
    const service = provided.get(WellKnownServices.Launcher) as LauncherService;

    await service.initialize();

    expect(host.calls).toEqual(expect.arrayContaining(['instanceList', 'taskList', 'processList']));
    expect(service.tasks.get('t1')?.state).toBe('running');
    expect(service.processes.status('i1').state).toBe('crashed');
  });

  it('dispose 断开四个宿主事件订阅，但不动任务快照', async () => {
    const host = new FakeHost();
    const { ctx, provided } = makeContext({ injects: { [KernelServices.LauncherHost]: host } });
    await createLauncherPlugin().activate(ctx);
    const service = provided.get(WellKnownServices.Launcher) as LauncherService;

    (service.tasks as TaskCenterImpl).adopt(
      makeTask('t1', { state: 'succeeded', endedAt: '2026-10-26T00:00:05.000Z' }),
    );
    expect(host.listenerCount()).toBe(4);

    await service.dispose();
    expect(host.listenerCount()).toBe(0);
    // 任务快照保留（UI 收尾还要读一眼），只是不再收新事件
    expect(service.tasks.get('t1')?.state).toBe('succeeded');
  });
});

describe('launcher-core · P0 未装配的子服务', () => {
  it('每条方法都抛 LAUNCHER_PLATFORM_UNSUPPORTED 并说清是哪一块没接', async () => {
    const host = new FakeHost();
    const { ctx, provided } = makeContext({ injects: { [KernelServices.LauncherHost]: host } });
    await createLauncherPlugin().activate(ctx);
    const service = provided.get(WellKnownServices.Launcher) as LauncherService;

    await expect(service.runtimes.list()).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      detail: expect.stringContaining('运行时列表'),
    });
    await expect(service.content.planInstall('i1', 'C:/tmp/x.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
    await expect(service.plugins.diagnose('i1')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
    await expect(service.pluginProjects.build('p1')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
    await expect(service.saves.backup('i1', {})).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
  });
});
