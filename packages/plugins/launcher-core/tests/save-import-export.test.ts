/**
 * `SaveManager.planImport` / `applyImport` / `exportArchive`：预检、单飞、过期、回滚、导出授权形态。
 *
 * 预检**不写实例**（只让宿主解到暂存并给读数）；应用导入 = 单飞 + 计划一次性 + 失败回滚；
 * 导出落点只由宿主原生保存对话框给定，本层只校验参数与「落点不回传」。
 */

import { describe, expect, it } from 'vitest';
import type { ZipContractLimits } from '@kojo/plugin-api';
import { makeInstance } from './helpers/fake-host';
import { FakeSaveHost } from './helpers/fake-save-host';
import { flush, makeSaveHarness, saveLayout, saveRoot } from './helpers/save-harness';

const ROOTS = [saveRoot('slots', '槽位存档'), saveRoot('auto', '自动存档')];
const LAYOUT = saveLayout(ROOTS);

function savedHost(isolation: 'shared' | 'copy' = 'copy'): FakeSaveHost {
  const host = new FakeSaveHost();
  host.instances = [makeInstance({ id: 'i1', isolation, saveRoots: [...ROOTS] })];
  host.putSave('slots', 'slot1.sav', 'current').putSave('auto', 'auto1.sav', 'current-auto');
  return host;
}

const LIMITS: ZipContractLimits = { maxEntries: 2, maxDepth: 2, maxUnpackedBytes: 1024 };

describe('SaveManager.planImport · 只预检，不写实例', () => {
  it('返回计划与读数警告，存档一个字节都没动，宿主只收到 saveImport', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav'], entryCount: 2, totalBytes: 2048 };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    const before = host.snapshot();
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    expect(plan.overwrites).toEqual(['saves/slot1.sav']);
    expect(plan.backupId).toBe('import-bak-1');
    expect(plan.warnings).toEqual([
      '将覆盖 1 个同名存档',
      '导入包包含 2 个条目、合计 2048 字节',
    ]);
    expect(host.snapshot()).toEqual(before);
    expect(host.calls.filter((call) => call.startsWith('saveImport:'))).toEqual([
      'saveImport:C:/tmp/saves.zip',
    ]);
  });

  it('包内覆盖路径越界（../、盘符、绝对路径）：预检就拒，计划不入库', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['../escape.sav'] };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.planImport('i1', 'C:/tmp/bad.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_PATH_ESCAPE',
      detail: expect.stringContaining('导入包内的存档路径不合法'),
    });
    expect(host.calls.some((call) => call.startsWith('saveApplyImport:'))).toBe(false);
  });

  it('条目数超限：LAUNCHER_ARCHIVE_LIMIT（读数由宿主给，本层不猜）', async () => {
    const host = savedHost();
    host.nextImport = { entryCount: 3 };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT, importLimits: LIMITS });

    await expect(manager.planImport('i1', 'C:/tmp/big.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      detail: expect.stringContaining('条目数 3'),
    });
  });

  it('解包字节超限 / 路径层级超限：同样 ARCHIVE_LIMIT', async () => {
    const host = savedHost();
    host.nextImport = { totalBytes: 4096 };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT, importLimits: LIMITS });
    await expect(manager.planImport('i1', 'C:/tmp/big.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
    });

    const deepHost = savedHost();
    deepHost.nextImport = { overwrites: ['a/b/c.sav'] };
    const deep = makeSaveHarness({ host: deepHost, layout: LAYOUT, importLimits: LIMITS });
    await expect(deep.manager.planImport('i1', 'C:/tmp/deep.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
    });
  });

  it('shared 实例目标根未授权：预检直接拒，宿主连解包都不会收到', async () => {
    const host = savedHost('shared');
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.planImport('i1', 'C:/tmp/saves.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
    });
    expect(host.calls.some((call) => call.startsWith('saveImport:'))).toBe(false);
  });
});

describe('SaveManager.applyImport · 单飞 / 过期 / 回滚', () => {
  it('应用成功：写盘 + 决议带给宿主，计划用一次即弃', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav'] };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    const task = await manager.applyImport(plan.planId, [
      { rootId: 'slots', path: 'saves/slot1.sav', action: 'overwrite' },
    ]);

    expect(task.kind).toBe('save-import');
    expect(task.state).toBe('succeeded');
    expect(host.contentOf('slots', 'saves/slot1.sav')).toBe('imported:saves/slot1.sav');
    await expect(
      manager.applyImport(plan.planId, [{ rootId: 'slots', path: 'saves/slot1.sav', action: 'overwrite' }]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      detail: expect.stringContaining('已使用'),
    });
  });

  it('计划过期：拒并清掉计划（不重放陈旧 apply）', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav'] };
    const { manager, clock } = makeSaveHarness({ host, layout: LAYOUT, planTtlMs: 1_000 });
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    clock.now += 2_000;
    await expect(manager.applyImport(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      detail: expect.stringContaining('已过期'),
    });
    expect(host.calls.some((call) => call.startsWith('saveApplyImport:'))).toBe(false);
  });

  it('单飞：同一实例并发应用导入，第二个直接 TASK_BUSY', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav'] };
    host.holdApplyImport = true;
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    const first = manager.applyImport(plan.planId);
    await flush();
    await expect(manager.applyImport(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_TASK_BUSY',
    });

    host.releaseApply();
    await expect(first).resolves.toMatchObject({ state: 'succeeded' });
    expect(host.calls.filter((call) => call.startsWith('saveApplyImport:'))).toHaveLength(1);
  });

  it('应用中途失败：用预检期备份回滚，内容回到导入前；错误码 SAVE_RESTORE_FAILED', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav', 'saves/slot2.sav'] };
    host.applyImportMode = 'partial';
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    await expect(manager.applyImport(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_SAVE_RESTORE_FAILED',
    });

    expect(host.contentOf('slots', 'slot1.sav')).toBe('current');
    expect(host.saveFiles.has('slots|saves/slot2.sav')).toBe(false);
    expect(host.calls).toContain(`saveRestore:${plan.backupId}`);
  });

  it('取消（宿主回 TASK_CANCELLED）：同样回滚，不留半截文件', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav'] };
    host.applyImportMode = 'cancelled';
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    await expect(manager.applyImport(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_TASK_CANCELLED',
    });

    expect(host.contentOf('slots', 'saves/slot1.sav')).toBeNull();
    expect(host.calls).toContain(`saveRestore:${plan.backupId}`);
    expect(host.saveFiles.size).toBe(2);
  });

  it('决议指向计划外路径：拒在宿主之前（避免写不存在目标的决议）', async () => {
    const host = savedHost();
    host.nextImport = { overwrites: ['saves/slot1.sav'] };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });
    const plan = await manager.planImport('i1', 'C:/tmp/saves.zip');

    await expect(
      manager.applyImport(plan.planId, [{ rootId: 'slots', path: 'saves/other.sav', action: 'skip' }]),
    ).rejects.toMatchObject({ code: 'LAUNCHER_INTERNAL' });
    expect(host.calls.some((call) => call.startsWith('saveApplyImport:'))).toBe(false);
  });
});

describe('SaveManager.exportArchive · 对话框即授权', () => {
  it('返回对话框落点；条目按声明根 + 相对名转发', async () => {
    const host = savedHost();
    host.exportTarget = 'C:/Users/me/Desktop/saves.zip';
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    const target = await manager.exportArchive('i1', {
      label: '导出一份',
      entries: [{ rootId: 'slots', path: 'slot1.sav' }],
    });

    expect(target).toBe('C:/Users/me/Desktop/saves.zip');
    expect(host.lastExportRequest).toEqual({
      label: '导出一份',
      entries: [{ rootId: 'slots', path: 'slot1.sav' }],
    });
    expect(host.calls).toContain('saveExport:i1:1');
  });

  it('不带 entries = 全部根（请求里不出现 entries）；用户取消返回 null', async () => {
    const host = savedHost();
    host.exportTarget = null;
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.exportArchive('i1', {})).resolves.toBeNull();
    expect(host.lastExportRequest).toEqual({});
    expect(host.calls).toContain('saveExport:i1:all');
  });

  it('越界条目 / 未知根：拒在宿主之前，不会把绝对路径递下去', async () => {
    const host = savedHost();
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(
      manager.exportArchive('i1', { entries: [{ rootId: 'slots', path: '../../outside.sav' }] }),
    ).rejects.toMatchObject({ code: 'LAUNCHER_PATH_ESCAPE' });
    await expect(
      manager.exportArchive('i1', { entries: [{ rootId: 'ghost', path: 'x.sav' }] }),
    ).rejects.toMatchObject({ code: 'LAUNCHER_INTERNAL' });
    expect(host.calls.some((call) => call.startsWith('saveExport'))).toBe(false);
  });
});
