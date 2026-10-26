/**
 * `SaveManager.list` / `backups` / `removeBackup`：只读面与授权面。
 *
 * 钉三件事：①分根归类与 adapter `listRule` 的过滤/命名；②shared 未授权根**空表 + 警告**
 * 而不是抛异常或猜路径；③删备份的两道闸（id 形态、清单归属）。
 */

import { describe, expect, it } from 'vitest';
import type { LauncherService, LauncherTask, SaveBackup } from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createLauncherPlugin } from '../src/index';
import { makeInstance } from './helpers/fake-host';
import { FakeSaveHost } from './helpers/fake-save-host';
import { makeSaveHarness, saveLayout, saveRoot } from './helpers/save-harness';
import { makeContext, makeLaunchAdapter } from './helpers/fake-context';

const ROOTS = [saveRoot('slots', '槽位存档'), saveRoot('auto', '自动存档')];
const LAYOUT = saveLayout(ROOTS);

function makeBackup(id: string, createdAt: string, reason: SaveBackup['reason'] = 'manual'): SaveBackup {
  return { id, instanceId: 'i1', createdAt, label: id, bytes: 10, entryCount: 1, reason };
}

function seedHost(options: { isolation?: 'shared' | 'copy' } = {}): FakeSaveHost {
  const host = new FakeSaveHost();
  host.instances = [makeInstance({ id: 'i1', isolation: options.isolation ?? 'copy', saveRoots: [...ROOTS] })];
  host.putSave('slots', 'slot1.sav', '').putSave('slots', 'note.txt', 'x');
  host.putSave('auto', 'auto1.sav', 'auto');
  return host;
}

describe('SaveManager.list · 分根与命名', () => {
  it('按根的声明顺序列出，扩展名白名单过滤，labelFromFileName 去掉扩展名', async () => {
    const host = seedHost();
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    const entries = await manager.list('i1');

    expect(entries.map((entry) => [entry.rootId, entry.path, entry.name])).toEqual([
      ['slots', 'slot1.sav', 'slot1'],
      ['auto', 'auto1.sav', 'auto1'],
    ]);
    expect(entries[0]!.bytes).toBe(0);
    expect(entries[0]!.mtimeMs).toBeGreaterThan(0);
    expect(manager.warnings('i1')).toEqual([]);
    // copy 实例不需要授权：宿主一次 list 就够
    expect(host.calls.filter((call) => call.startsWith('saveList'))).toHaveLength(1);
  });

  it('shared 实例未授权的根：空表 + 逐根警告，不抛异常', async () => {
    const host = seedHost({ isolation: 'shared' });
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    const entries = await manager.list('i1');

    expect(entries).toEqual([]);
    const warnings = manager.warnings('i1');
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('槽位存档');
    expect(warnings.join('\n')).toContain('自动存档');
    expect(warnings.join('\n')).toContain('未获得写入授权');
  });

  it('shared 实例部分授权：只列已授权根，未授权根给一条警告', async () => {
    const host = seedHost({ isolation: 'shared' });
    host.approvals.add('slots');
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    const entries = await manager.list('i1');

    expect(entries.map((entry) => entry.path)).toEqual(['slot1.sav']);
    expect(manager.warnings('i1')).toEqual([
      '存档目录「自动存档」尚未获得写入授权，已跳过（shared 实例需在实例设置里逐根授权）',
    ]);
  });

  it('宿主报来越界路径与未知根：丢弃并警告，且回显里不带绝对路径', async () => {
    const host = seedHost();
    host.saveList = async () => ({
      roots: [{ rootId: 'slots', approved: true }],
      entries: [
        { path: '../escape.sav', rootId: 'slots', name: 'x', bytes: 1, mtimeMs: 1 },
        { path: 'C:/Users/me/secret.sav', rootId: 'slots', name: 'x', bytes: 1, mtimeMs: 1 },
        { path: 'ghost.sav', rootId: 'ghost', name: 'x', bytes: 1, mtimeMs: 1 },
      ],
    });
    const { manager } = makeSaveHarness({ host, layout: LAYOUT });

    await expect(manager.list('i1')).resolves.toEqual([]);
    const text = manager.warnings('i1').join('\n');
    expect(text).toContain('2 条越界存档路径');
    expect(text).toContain('未知存档根');
    expect(text).not.toContain('C:/Users/me');
    expect(text).not.toContain('../escape.sav');
  });

  it('adapter 未声明存档根：空表 + 警告；备份类操作如实拒绝（不造空备份）', async () => {
    const host = new FakeSaveHost();
    host.instances = [makeInstance({ id: 'i1', saveRoots: [] })];
    const { manager } = makeSaveHarness({ host });

    await expect(manager.list('i1')).resolves.toEqual([]);
    expect(manager.warnings('i1')[0]).toContain('未声明存档目录');
    await expect(manager.backup('i1', {})).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
  });
});

describe('SaveManager.backups / removeBackup', () => {
  it('备份清单按时间倒序（UI 首屏就是最新一份）', async () => {
    const host = seedHost();
    host.seedBackup(makeBackup('b-old', '2026-10-01T00:00:00.000Z'));
    host.seedBackup(makeBackup('b-new', '2026-10-20T00:00:00.000Z', 'pre-restore'));
    const { manager } = makeSaveHarness({ host });

    const backups = await manager.backups('i1');

    expect(backups.map((backup) => backup.id)).toEqual(['b-new', 'b-old']);
    expect(backups[0]!.reason).toBe('pre-restore');
  });

  it('删除清单里存在的备份：只调一次宿主删除，且只删那一份', async () => {
    const host = seedHost();
    host.seedBackup(makeBackup('b1', '2026-10-01T00:00:00.000Z'));
    host.seedBackup(makeBackup('b2', '2026-10-02T00:00:00.000Z'));
    const { manager } = makeSaveHarness({ host });

    await manager.removeBackup('i1', 'b1');

    expect(host.deletedBackups).toEqual(['b1']);
    expect([...host.backupRecords.keys()]).toEqual(['b2']);
    expect(host.calls.filter((call) => call.startsWith('saveDeleteBackup'))).toEqual([
      'saveDeleteBackup:b1',
    ]);
  });

  it('不属于该实例的备份 id：按越界拒，宿主收不到删除命令', async () => {
    const host = seedHost();
    const { manager } = makeSaveHarness({ host });

    await expect(manager.removeBackup('i1', 'foreign')).rejects.toMatchObject({
      code: 'LAUNCHER_PATH_ESCAPE',
      detail: expect.stringContaining('不属于实例'),
    });
    expect(host.deletedBackups).toEqual([]);
    expect(host.calls.some((call) => call.startsWith('saveDeleteBackup'))).toBe(false);
  });

  it('带分隔符 / .. 的备份 id：形态闸直接拒（不进宿主）', async () => {
    const host = seedHost();
    const { manager } = makeSaveHarness({ host });

    for (const bad of ['../b1', 'a/b', 'C:b1', '']) {
      await expect(manager.removeBackup('i1', bad)).rejects.toMatchObject({
        code: 'LAUNCHER_PATH_ESCAPE',
      });
    }
    expect(host.calls.some((call) => call.startsWith('saveDeleteBackup'))).toBe(false);
  });
});

describe('SaveManager · 装配', () => {
  it('宿主有存档八条命令时，launcher.service.saves 是真实现（走 adapter 的 saveLayout）', async () => {
    const host = seedHost({ isolation: 'copy' });
    const adapter = {
      gameId: 'demo',
      launch: { ...makeLaunchAdapter().launch, saveLayout: LAYOUT },
    };
    const { ctx, provided } = makeContext({
      injects: { [KernelServices.LauncherHost]: host },
      adapterContributions: [{ adapter }],
    });
    await createLauncherPlugin({ host }).activate(ctx);
    const service = provided.get(WellKnownServices.Launcher) as LauncherService;

    host.instances = [makeInstance({ id: 'i1', adapterId: 'demo', isolation: 'copy', saveRoots: [...ROOTS] })];
    const entries = await service.saves.list('i1');

    expect(entries.map((entry) => entry.name)).toEqual(['slot1', 'auto1']);
    await expect(service.saves.backups('i1')).resolves.toEqual([]);
    // 任务表没被动过（只读面不造任务）
    expect(service.tasks.list() as LauncherTask[]).toEqual([]);
  });
});
