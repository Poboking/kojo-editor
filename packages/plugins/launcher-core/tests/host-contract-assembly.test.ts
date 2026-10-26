/**
 * 端到端形状闭环（L1c 判定线）：宿主把 P1 两族（内容包 / 存档）都给齐时，
 * `launcher.service` 的 `saves` 与 `content` 必须是**真实现**——不再抛
 * `LAUNCHER_PLATFORM_UNSUPPORTED`。
 *
 * 这条钉的是 L3D 报告第 7 条那个断点：桌面壳桥已挂上 36 条命令，但内核只转发 P0 的 20 条
 * ⇒ `launcher-core` 经 `kernel.launcher` 取到的宿主没有内容/存档命令：
 * `saveHostFrom()` 返回 `null`（存档整块「未装配」）、内容侧落 `PLATFORM_UNSUPPORTED`。
 * 本批把两族收进契约（§7.4）+ 内核逐条转发，于是这条装配链才真的通到。
 *
 * 假桥是**刻意的手写填空题**：P0 与内容七条走既有假宿主（`FakeContentHost`），存档九条在
 * 这个文件里逐条实现——只要契约上少一条可选方法，或者内核漏转一条，这里就整块不通。
 */

import { describe, expect, it } from 'vitest';
import type {
  ConflictResolution,
  HostSaveImportPlan,
  HostSaveListing,
  LauncherHostBridge,
  LauncherService,
  LauncherTask,
  RestoreOptions,
  SaveBackup,
  SaveBackupRequest,
  SaveExportRequest,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createLauncherPlugin } from '../src/index';
import { makeContext } from './helpers/fake-context';
import {
  FakeContentHost,
  makeContentRoot,
  makeInstance,
  makeInstalledContent,
  makeContentManifest,
  makeTask,
} from './helpers/fake-host';
import { saveRoot } from './helpers/save-harness';

/**
 * 「P0 + 16 条 P1 全给」的假桥。
 *
 * 内容七条由 `FakeContentHost` 提供；这里补齐存档九条（`taskCancel` 是 P0，继承来的）。
 * 每条都只回一个最小的合法值——本文件证的是**装配**，不是存档编排（那是 save-*.test 的活）。
 */
class FullP1Host extends FakeContentHost {
  /** 存档命令被调到的次序（断言"真的走了宿主"而不是桩） */
  readonly saveCalls: string[] = [];

  async saveList(instanceId: string): Promise<HostSaveListing> {
    this.saveCalls.push(`saveList:${instanceId}`);
    const instance = this.instances.find((item) => item.id === instanceId);
    return {
      entries: [],
      roots: (instance?.saveRoots ?? []).map((root) => ({ rootId: root.id, approved: true })),
      warnings: ['宿主侧：自动存档目录不存在，已跳过'],
    };
  }

  async saveBackups(instanceId: string): Promise<readonly SaveBackup[]> {
    this.saveCalls.push(`saveBackups:${instanceId}`);
    return [];
  }

  async saveBackup(instanceId: string, _req: SaveBackupRequest): Promise<LauncherTask> {
    this.saveCalls.push(`saveBackup:${instanceId}`);
    return makeTask('host-save-backup', { kind: 'save-backup', instanceId });
  }

  async saveRestore(
    instanceId: string,
    backupId: string,
    _opts?: RestoreOptions,
  ): Promise<LauncherTask> {
    this.saveCalls.push(`saveRestore:${instanceId}:${backupId}`);
    return makeTask('host-save-restore', { kind: 'save-restore', instanceId });
  }

  async saveDeleteBackup(instanceId: string, backupId: string): Promise<void> {
    this.saveCalls.push(`saveDeleteBackup:${instanceId}:${backupId}`);
  }

  async saveImport(instanceId: string, archivePath: string): Promise<HostSaveImportPlan> {
    this.saveCalls.push(`saveImport:${instanceId}:${archivePath}`);
    return {
      planId: 'host-import-plan',
      backupId: 'host-import-backup',
      overwrites: [],
      warnings: [],
      entryCount: 0,
      totalBytes: 0,
    };
  }

  async saveApplyImport(
    planId: string,
    _resolutions?: readonly ConflictResolution[],
  ): Promise<LauncherTask> {
    this.saveCalls.push(`saveApplyImport:${planId}`);
    return makeTask('host-save-import', { kind: 'save-import' });
  }

  async saveExport(instanceId: string, _req: SaveExportRequest): Promise<string | null> {
    this.saveCalls.push(`saveExport:${instanceId}`);
    return null;
  }
}

async function activate(host: LauncherHostBridge): Promise<LauncherService> {
  const { ctx, provided } = makeContext({ injects: { [KernelServices.LauncherHost]: host } });
  await createLauncherPlugin().activate(ctx);
  return provided.get(WellKnownServices.Launcher) as LauncherService;
}

describe('P1 两族装配 · 宿主给齐 ⇒ saves 与 content 都是真实现', () => {
  it('`saves` 不再是「未装配」桩：list / backups 走真宿主命令', async () => {
    const host = new FullP1Host();
    host.instances = [
      makeInstance({ id: 'i1', isolation: 'copy', saveRoots: [saveRoot('slots', '槽位存档')] }),
    ];
    const service = await activate(host);

    // 桩的实现是 `Promise.reject(PLATFORM_UNSUPPORTED)`：这里不抛就说明换成了真实现
    await expect(service.saves.list('i1')).resolves.toEqual([]);
    await expect(service.saves.backups('i1')).resolves.toEqual([]);
    expect(host.saveCalls).toEqual(['saveList:i1', 'saveBackups:i1']);
  });

  it('`content` 走真内容命令（list 从宿主拿，不落 PLATFORM_UNSUPPORTED）', async () => {
    const host = new FullP1Host();
    host.instances = [makeInstance({ id: 'i1', contentRoots: [makeContentRoot('script')] })];
    host.packs.set('i1', [
      makeInstalledContent({ manifest: makeContentManifest({ id: 'demo.pack' }) }),
    ]);
    const service = await activate(host);

    await expect(service.content.list('i1')).resolves.toEqual([
      expect.objectContaining({ manifest: expect.objectContaining({ id: 'demo.pack' }) }),
    ]);
    expect(host.calls).toContain('contentList:i1');
  });

  it('寄存档链路的备份通道也接上了（`saveBackup` 落到宿主，而不是桩里那句「未装配」）', async () => {
    const host = new FullP1Host();
    host.instances = [
      makeInstance({ id: 'i1', isolation: 'copy', saveRoots: [saveRoot('slots', '槽位存档')] }),
    ];
    const service = await activate(host);

    const task = await service.saves.backup('i1', { label: '手动' });
    expect(task.kind).toBe('save-backup');
    expect(host.saveCalls[0]).toBe('saveBackup:i1');
  });

  it('对照：只给 P0 的宿主仍是桩（如实拒绝，不静默成功）', async () => {
    // 同一份装配代码、同一份插件选项：差别只在宿主有没有那八条命令
    const bare = new FakeContentHost();
    bare.instances = [makeInstance({ id: 'i1' })];
    const service = await activate(bare);

    await expect(service.saves.list('i1')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
  });
});
