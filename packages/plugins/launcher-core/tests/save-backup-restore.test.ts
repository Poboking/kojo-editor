/**
 * `SaveManager.backup` / `restore`：备份编排、恢复顺序、回滚与配额。
 *
 * 恢复的三条顺序不变量在这里钉死：**先自动备份 → 再停游戏 → 最后写回**；
 * 失败时必须用恢复前那份备份原样写回（不留中间态）。取消走宿主任务取消，
 * 取消后不得留下半截备份。
 */

import { describe, expect, it } from 'vitest';
import type { LauncherTask, SaveBackup } from '@kojo/plugin-api';
import { makeInstance, makeStatus } from './helpers/fake-host';
import { FakeSaveHost } from './helpers/fake-save-host';
import { flush, makeSaveHarness, saveLayout, saveRoot } from './helpers/save-harness';

const ROOTS = [saveRoot('slots', '槽位存档'), saveRoot('auto', '自动存档')];
const LAYOUT = saveLayout(ROOTS);

function backup(id: string, createdAt: string, reason: SaveBackup['reason'] = 'manual'): SaveBackup {
  return { id, instanceId: 'i1', createdAt, label: id, bytes: 9, entryCount: 1, reason };
}

function savedHost(isolation: 'shared' | 'copy' = 'copy'): FakeSaveHost {
  const host = new FakeSaveHost();
  host.instances = [makeInstance({ id: 'i1', isolation, saveRoots: [...ROOTS] })];
  host.putSave('slots', 'slot1.sav', 'current').putSave('auto', 'auto1.sav', 'current-auto');
  return host;
}

function indexOfCall(host: FakeSaveHost, prefix: string): number {
  return host.calls.findIndex((call) => call.startsWith(prefix));
}

describe('SaveManager.backup · 请求归一与任务登记', () => {
  it('缺省 reason=manual、entries 缺省 = 全部 saveRoots（请求里不出现 entries 字段）', async () => {
    const host = savedHost();
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    const task = await manager.backup('i1', {});

    expect(task.kind).toBe('save-backup');
    expect(task.state).toBe('succeeded');
    expect(host.lastBackupRequest).toEqual({ reason: 'manual' });
    const created = [...host.backupRecords.values()];
    expect(created).toHaveLength(1);
    expect(created[0]!.entryCount).toBe(2);
    expect(created[0]!.reason).toBe('manual');
  });

  it('显式 entries 只备份指定文件，label 原样带到宿主', async () => {
    const host = savedHost();
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await manager.backup('i1', { label: '只备槽位', entries: [{ rootId: 'slots', path: 'slot1.sav' }] });

    expect(host.lastBackupRequest?.label).toBe('只备槽位');
    expect(host.lastBackupRequest?.entries).toEqual([{ rootId: 'slots', path: 'slot1.sav' }]);
    const created = [...host.backupRecords.values()][0]!;
    expect(created.entryCount).toBe(1);
    expect(created.bytes).toBe('current'.length);
  });

  it('未知存档根 / 越界路径的选择集：拒在宿主之前（不猜路径）', async () => {
    const host = savedHost();
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(
      manager.backup('i1', { entries: [{ rootId: 'ghost', path: 'x.sav' }] }),
    ).rejects.toMatchObject({ code: 'LAUNCHER_INTERNAL' });
    await expect(
      manager.backup('i1', { entries: [{ rootId: 'slots', path: '../x.sav' }] }),
    ).rejects.toMatchObject({ code: 'LAUNCHER_PATH_ESCAPE' });
    expect(host.calls.some((call) => call.startsWith('saveBackup:'))).toBe(false);
  });

  it('任务登记进 TaskCenter（kind / 进度 / 可取消），取消转 host.taskCancel 且不留半截备份', async () => {
    const host = savedHost();
    host.holdBackupTasks = true;
    const { manager, tasks } = makeSaveHarness({ host, layout: LAYOUT });

    const pending = manager.backup('i1', {});
    await flush();

    const running = tasks.list().find((task) => task.kind === 'save-backup');
    expect(running).toBeDefined();
    expect(running!.state).toBe('running');
    expect(running!.progress).toEqual({ done: 0, total: 2, unit: 'files', message: '读取存档' });
    expect(running!.cancellable).toBe(true);

    await tasks.cancel(running!.id);

    await expect(pending).rejects.toMatchObject({ code: 'LAUNCHER_TASK_CANCELLED' });
    const settled = tasks.get(running!.id)!;
    expect(settled.state).toBe('failed');
    expect(settled.error?.code).toBe('LAUNCHER_TASK_CANCELLED');
    expect(host.cancelRequests).toContain(running!.id);
    // 取消发生在落盘之前：一份备份都没造出来
    expect(host.backupRecords.size).toBe(0);
    expect(host.heldTaskId()).toBeNull();
  });
});

describe('SaveManager.backup · 保留策略', () => {
  it('超过 keep 只删最旧；pre-restore 备份不占用户配额', async () => {
    const host = savedHost();
    host.seedBackup(backup('old-1', '2026-10-01T00:00:00.000Z'));
    host.seedBackup(backup('old-2', '2026-10-02T00:00:00.000Z'));
    host.seedBackup(backup('old-3', '2026-10-03T00:00:00.000Z'));
    host.seedBackup(backup('pre', '2026-09-01T00:00:00.000Z', 'pre-restore'));
    const { manager } = makeSaveHarness({ host, layout: LAYOUT, keep: 3 });

    await manager.backup('i1', {});

    expect(host.deletedBackups).toEqual(['old-1']);
    expect(host.backupRecords.has('pre')).toBe(true);
    expect(host.backupRecords.has('old-3')).toBe(true);
    expect(host.backupRecords.has('bak-1')).toBe(true);
  });
});

describe('SaveManager.restore · 顺序 / 授权 / 回滚', () => {
  it('先自动备份（pre-restore）→ 停游戏 → 写回；内容变为备份版本', async () => {
    const host = savedHost();
    host.seedBackup(backup('bak-target', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'old' },
    ]);
    const { manager, processes } = makeSaveHarness({ host, layout: LAYOUT });
    processes.applySnapshot([
      makeStatus('i1', { state: 'running', pid: 42, sessionId: 's1', startedAt: '2026-10-26T00:00:00.000Z' }),
    ]);

    const task = await manager.restore('i1', 'bak-target');

    expect(task.kind).toBe('save-restore');
    expect(host.contentOf('slots', 'slot1.sav')).toBe('old');
    const auto = indexOfCall(host, 'saveBackup:pre-restore');
    const stop = indexOfCall(host, 'stop');
    const write = indexOfCall(host, 'saveRestore:bak-target');
    expect(auto).toBeGreaterThanOrEqual(0);
    expect(auto).toBeLessThan(stop);
    expect(stop).toBeLessThan(write);
    const preRestore = [...host.backupRecords.values()].find((item) => item.reason === 'pre-restore');
    expect(preRestore?.label).toContain('恢复前自动备份');
    expect(preRestore?.label).toContain('bak-target');
  });

  it('backupCurrent=false 时不再自动备份，直接停游戏后写回', async () => {
    const host = savedHost();
    host.seedBackup(backup('bak-target', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'old' },
    ]);
    const { manager, processes } = makeSaveHarness({ host, layout: LAYOUT });
    processes.applySnapshot([makeStatus('i1', { state: 'running', pid: 42 })]);

    await manager.restore('i1', 'bak-target', { backupCurrent: false });

    expect(host.calls.some((call) => call.startsWith('saveBackup:'))).toBe(false);
    expect(indexOfCall(host, 'stop')).toBeLessThan(indexOfCall(host, 'saveRestore:bak-target'));
    expect(host.contentOf('slots', 'slot1.sav')).toBe('old');
  });

  it('游戏未运行：不停进程，恢复照常进行', async () => {
    const host = savedHost();
    host.seedBackup(backup('bak-target', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'old' },
    ]);
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await manager.restore('i1', 'bak-target', { backupCurrent: false });

    expect(host.calls).not.toContain('stop');
    expect(host.contentOf('slots', 'slot1.sav')).toBe('old');
  });

  it('写回中途失败：用恢复前备份逆序回滚，内容回到恢复前，错误码 SAVE_RESTORE_FAILED', async () => {
    const host = savedHost();
    host.seedBackup(backup('broken', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'broken-version' },
      { rootId: 'slots', path: 'slot2.sav', bytes: 3, mtimeMs: 1, content: 'broken-2' },
    ]);
    host.restoreFailure = { backupId: 'broken', afterFiles: 1 };
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.restore('i1', 'broken')).rejects.toMatchObject({
      code: 'LAUNCHER_SAVE_RESTORE_FAILED',
      detail: expect.stringContaining('恢复备份 broken 失败'),
    });

    expect(host.contentOf('slots', 'slot1.sav')).toBe('current');
    expect(host.saveFiles.has('slots|slot2.sav')).toBe(false);
    const writes = host.calls.filter((call) => call.startsWith('saveRestore:'));
    expect(writes).toEqual(['saveRestore:broken', 'saveRestore:bak-1']);
  });

  it('shared 实例根未授权：写回前拒（SOURCE_NOT_APPROVED），一次写调用都没发生', async () => {
    const host = savedHost('shared');
    host.seedBackup(backup('bak-target', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'old' },
    ]);
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.restore('i1', 'bak-target')).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      detail: expect.stringContaining('槽位存档'),
    });

    expect(host.calls.some((call) => call.startsWith('saveBackup:'))).toBe(false);
    expect(host.calls.some((call) => call.startsWith('saveRestore:'))).toBe(false);
    expect(host.contentOf('slots', 'slot1.sav')).toBe('current');
  });

  it('shared 实例逐根授权后可以写回（copy 之外的门禁同一套）', async () => {
    const host = savedHost('shared');
    host.approvals.add('slots');
    host.approvals.add('auto');
    host.seedBackup(backup('bak-target', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'old' },
    ]);
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await manager.restore('i1', 'bak-target');

    expect(host.contentOf('slots', 'slot1.sav')).toBe('old');
  });

  it('不属于该实例的备份 id：恢复前就拒，不写不备份', async () => {
    const host = savedHost();
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.restore('i1', 'ghost')).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      detail: expect.stringContaining('不属于实例'),
    });
    expect(host.calls.some((call) => call.startsWith('saveBackup:'))).toBe(false);
    expect(host.calls.some((call) => call.startsWith('saveRestore:'))).toBe(false);
  });

  it('恢复任务也进 TaskCenter（同一条操作只有一条任务）', async () => {
    const host = savedHost();
    host.seedBackup(backup('bak-target', '2026-10-01T00:00:00.000Z'), [
      { rootId: 'slots', path: 'slot1.sav', bytes: 3, mtimeMs: 1, content: 'old' },
    ]);
    const { manager, tasks } = makeSaveHarness({ host, layout: LAYOUT });

    const task = await manager.restore('i1', 'bak-target');
    const kinds = tasks.list().map((item: LauncherTask) => item.kind);

    expect(task.state).toBe('succeeded');
    expect(kinds).toEqual(['save-backup', 'save-restore']);
    expect(tasks.get(task.id)?.state).toBe('succeeded');
  });
});
