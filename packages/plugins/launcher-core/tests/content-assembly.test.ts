/**
 * 装配线：`launcher.service.content` 是否真的换成了 `ContentManagerImpl`（而不是 P0 的桩）。
 *
 * 只测接线：真实现能取到宿主内容命令、能借实例库拿到快照；宿主没这些命令时仍如实拒绝。
 */

import { describe, expect, it } from 'vitest';
import type { LauncherService } from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createLauncherPlugin } from '../src/index';
import { makeContext } from './helpers/fake-context';
import {
  FakeHost,
  FakeContentHost,
  makeContentFile,
  makeContentManifest,
  makeContentRoot,
  makeHostContentPlan,
  makeInstance,
  makeInstalledContent,
} from './helpers/fake-host';

async function activate(host: FakeHost): Promise<LauncherService> {
  const { ctx, provided } = makeContext({ injects: { [KernelServices.LauncherHost]: host } });
  await createLauncherPlugin().activate(ctx);
  return provided.get(WellKnownServices.Launcher) as LauncherService;
}

describe('内容包装配 · launcher.service.content', () => {
  it('装配后是真实内容管理器：list 走宿主、planInstall 借实例库拿快照', async () => {
    const host = new FakeContentHost();
    host.instances = [makeInstance({ id: 'i1', contentRoots: [makeContentRoot('script')] })];
    host.packs.set('i1', [
      makeInstalledContent({
        manifest: makeContentManifest({ id: 'a.pack' }),
        ownedFiles: [{ rootId: 'script', path: 'mod/a.txt' }],
      }),
    ]);
    host.planByArchive.set(
      'C:/tmp/pack.zip',
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'mod/a.txt', 1)] }),
      }),
    );
    const service = await activate(host);

    await expect(service.content.list('i1')).resolves.toEqual([
      expect.objectContaining({ manifest: expect.objectContaining({ id: 'a.pack' }) }),
    ]);
    const plan = await service.content.planInstall('i1', 'C:/tmp/pack.zip');
    expect(plan.additions).toEqual([{ rootId: 'script', path: 'mod/a.txt' }]);
    expect(host.calls.filter((call) => call.startsWith('content'))).toEqual([
      'contentList:i1',
      'contentPlan:i1:C:/tmp/pack.zip',
    ]);
  });

  it('宿主没有 launcher_content_list ⇒ 如实点名（不是静默空列表）', async () => {
    const service = await activate(new FakeHost());

    await expect(service.content.list('i1')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      detail: '宿主缺少 launcher_content_list（P1 命令尚未接通）',
    });
  });

  it('dispose 之后内容管理器断订阅但服务不炸（重装批次不该因它崩）', async () => {
    const host = new FakeContentHost();
    host.instances = [makeInstance({ id: 'i1', contentRoots: [makeContentRoot('script')] })];
    const service = await activate(host);
    await expect(service.dispose()).resolves.toBeUndefined();
    expect(host.listenerCount()).toBe(0);
  });
});
