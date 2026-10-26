/**
 * `kernel.launcher` 的**零逻辑透传**钉（2026-10-26 L1b）。
 *
 * 这一层最容易腐化的方式不是写错，而是"顺手加一点判断"：核一次路径、补一个默认值、
 * 平台缺席时给个假数据。三条用例分别钉住：
 * 1. 平台缺席 ⇒ 每个方法都抛人话（不降级、不返回空表）；
 * 2. 平台在场 ⇒ 调用逐字转发、返回值原样回传（本层不许改写任何字段）；
 * 3. P1 可选命令缺席 ⇒ 说清"这条不支持"，而不是静默成功。
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ContentFileRef,
  HostContentPlan,
  HostLogPage,
  HostSaveListing,
  LauncherHostBridge,
  LauncherInstance,
  LauncherTask,
  PlatformBridge,
  ProcessStatus,
  ZipContractLimits,
} from '@kojo/plugin-api';
import { LauncherHostImpl } from '../src/launcher';

function makeInstance(id = 'i1'): LauncherInstance {
  return {
    id,
    name: '实例',
    adapterId: 'demo-adapter',
    gameId: 'demo',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    sourceRoot: 'C:/games/demo',
    isolation: 'shared',
    instanceRoot: 'C:/appdata/launcher/instances/i1',
    gameRoot: 'C:/appdata/launcher/instances/i1/game',
    state: 'ready',
    executable: { relativePath: 'game.exe', args: [], env: {}, windowMode: 'auto', sha256: null },
    runtimeId: null,
    locale: { mode: 'inherit' },
    encoding: { mode: 'auto', fallback: 'shift_jis' },
    saveRoots: [],
    contentRoots: [],
    executableTrust: null,
    launchCount: 0,
    lastLaunchedAt: null,
    lastExit: null,
    schemaVersion: 1,
  };
}

function makeStatus(instanceId = 'i1'): ProcessStatus {
  return {
    instanceId,
    state: 'running',
    pid: 1234,
    sessionId: 's-1',
    startedAt: '2026-10-26T00:00:00.000Z',
    elapsedMs: 0,
    exitCode: null,
    exitReason: null,
    lastError: null,
  };
}

/** 只实现被测到的那几条方法；其余留给"缺席"用例证明本层不假装有 */
function makeHost(partial: Partial<LauncherHostBridge>): LauncherHostBridge {
  return partial as LauncherHostBridge;
}

describe('kernel.launcher · 零逻辑透传', () => {
  it('平台没有启动器能力：每个方法都抛人话，不返回假数据', async () => {
    const impl = new LauncherHostImpl({} as PlatformBridge);
    await expect(impl.instanceList()).rejects.toThrow(/桌面壳/);
    await expect(impl.start('i1')).rejects.toThrow(/桌面壳/);
    await expect(impl.trustExecutable('i1')).rejects.toThrow(/桌面壳/);
    await expect(impl.logTail('i1')).rejects.toThrow(/桌面壳/);
    // 事件也走同一道门：不会返回一个"永远不触发"的假取消函数
    expect(() => impl.onProcess(() => {})).toThrow(/桌面壳/);
  });

  it('平台在场：调用逐字转发、返回值原样回传（本层不改写任何字段）', async () => {
    const instance = makeInstance();
    const status = makeStatus();
    const page: HostLogPage = {
      session: {
        id: 's-1',
        instanceId: 'i1',
        startedAt: '2026-10-26T00:00:00.000Z',
        endedAt: null,
        exitCode: null,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
      chunks: [],
      truncated: false,
    };
    const instanceList = vi.fn(async () => [instance]);
    const start = vi.fn(async (_id: string) => status);
    const logTail = vi.fn(async (_id: string, _q?: unknown) => page);
    const impl = new LauncherHostImpl({
      launcher: makeHost({ instanceList, start, logTail }),
    } as PlatformBridge);

    await expect(impl.instanceList()).resolves.toEqual([instance]);
    await expect(impl.start('i1')).resolves.toBe(status);
    await expect(impl.logTail('i1', { maxLines: 50 })).resolves.toBe(page);
    expect(start).toHaveBeenCalledWith('i1');
    expect(logTail).toHaveBeenCalledWith('i1', { maxLines: 50 });
  });

  it('P1 可选命令缺席：说清"不支持这条"，不静默成功', async () => {
    const impl = new LauncherHostImpl({ launcher: makeHost({}) } as PlatformBridge);
    await expect(impl.instanceDuplicate('i1')).rejects.toThrow(/不支持/);
    await expect(impl.pickWriteRoot('i1', 'saves')).rejects.toThrow(/不支持/);
    await expect(impl.logExport('i1')).rejects.toThrow(/不支持/);
  });

  it('事件订阅原样挂到平台，取消函数逐字回传（本层不另建一份订阅表）', () => {
    const unsubscribe = vi.fn();
    const onProcess = vi.fn(() => unsubscribe);
    const impl = new LauncherHostImpl({ launcher: makeHost({ onProcess }) } as PlatformBridge);

    const listener = () => {};
    const off = impl.onProcess(listener);
    expect(onProcess).toHaveBeenCalledWith(listener);
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * P1 两族（内容包 / 存档）：L1c 起内核真的把它们转出去了
 *
 * 此前 `kernel.launcher` 只转 P0 的 20 条 ⇒ launcher-core 经内核取到的宿主没有内容/存档
 * 命令（`saveHostFrom()` 返回 null、内容侧落 `PLATFORM_UNSUPPORTED`）。三条用例分别钉：
 * 有方法就逐字转发、返回值原样（含 `warnings`）、缺席给人话而不是静默成功。
 * ══════════════════════════════════════════════════════════════════════════════ */

const LIMITS: ZipContractLimits = { maxEntries: 1000, maxDepth: 8, maxUnpackedBytes: 8 * 1024 * 1024 };

function makeTask(id = 't1'): LauncherTask {
  return {
    id,
    kind: 'content-install',
    instanceId: 'i1',
    state: 'succeeded',
    progress: null,
    createdAt: '2026-10-26T00:00:00.000Z',
    startedAt: '2026-10-26T00:00:01.000Z',
    endedAt: '2026-10-26T00:00:02.000Z',
    error: null,
    result: null,
    cancellable: false,
  };
}

function makePlan(): HostContentPlan {
  return {
    planId: 'plan-1',
    manifest: {
      schemaVersion: 1,
      id: 'demo.pack',
      name: '示例包',
      version: '1.0.0',
      kind: 'script',
      gameId: 'demo',
      files: [],
      loadOrder: 0,
    },
    targets: [{ rootId: 'script', relativePath: '' }],
    additions: [],
    overwrites: [],
    conflicts: [],
    missingRequirements: [],
    warnings: ['宿主侧：包内没有可落盘的文件'],
    expiresAt: '2026-10-26T00:10:00.000Z',
  };
}

describe('kernel.launcher · P1 内容包 / 存档（L1c：零逻辑转发，缺席即人话）', () => {
  it('平台有方法：参数逐字转发、返回值原样回传（`saveList` 的 warnings 不许被吃掉）', async () => {
    const listing: HostSaveListing = {
      entries: [{ path: 'slot1.sav', rootId: 'slots', name: 'slot1', bytes: 12, mtimeMs: 1 }],
      roots: [{ rootId: 'slots', approved: true, exists: true }],
      warnings: ['宿主侧：自动存档目录不存在，已跳过'],
    };
    const plan = makePlan();
    const task = makeTask();
    const files: readonly ContentFileRef[] = [{ rootId: 'script', path: 'mod/a.txt' }];

    const saveList = vi.fn(async (_id: string) => listing);
    const saveBackups = vi.fn(async (_id: string) => []);
    const contentList = vi.fn(async (_id: string) => []);
    const contentPlan = vi.fn(async (_id: string, _archive: string, _opts?: unknown) => plan);
    const contentUninstall = vi.fn(async (_id: string, _pack: string, _files?: unknown) => task);
    const contentSetOrder = vi.fn(async (_id: string, _ids: readonly string[]) => {});
    const saveRestore = vi.fn(async (_id: string, _backupId: string, _opts?: unknown) => task);
    const saveImport = vi.fn(async (_id: string, _archive: string) => ({
      planId: 'p1',
      backupId: 'b1',
      overwrites: ['slot1.sav'],
      warnings: [],
      entryCount: 3,
      totalBytes: 99,
      expiresAt: '2026-10-26T00:10:00.000Z',
    }));
    const saveExport = vi.fn(async (_id: string, _req: unknown) => 'C:/tmp/out.zip');

    const impl = new LauncherHostImpl({
      launcher: makeHost({
        saveList,
        saveBackups,
        contentList,
        contentPlan,
        contentUninstall,
        contentSetOrder,
        saveRestore,
        saveImport,
        saveExport,
      }),
    } as PlatformBridge);

    await expect(impl.saveList('i1')).resolves.toBe(listing);
    await expect(impl.saveList('i1')).resolves.toMatchObject({ warnings: listing.warnings });
    await expect(impl.saveBackups('i1')).resolves.toEqual([]);
    await expect(impl.contentList('i1')).resolves.toEqual([]);
    await expect(impl.contentPlan('i1', 'C:/tmp/pack.zip', { limits: LIMITS })).resolves.toBe(plan);
    await expect(impl.contentUninstall('i1', 'demo.pack', files)).resolves.toBe(task);
    await expect(impl.contentSetOrder('i1', ['b.pack', 'a.pack'])).resolves.toBeUndefined();
    await expect(impl.saveRestore('i1', 'b1', { backupCurrent: false })).resolves.toBe(task);
    await expect(impl.saveImport('i1', 'C:/tmp/saves.zip')).resolves.toMatchObject({ entryCount: 3 });
    await expect(impl.saveExport('i1', { label: '导出' })).resolves.toBe('C:/tmp/out.zip');

    // 逐字转发：参数顺序、可选参位（没给就是 undefined）都不许重排或补默认值
    expect(saveList).toHaveBeenCalledWith('i1');
    expect(saveBackups).toHaveBeenCalledWith('i1');
    expect(contentPlan).toHaveBeenCalledWith('i1', 'C:/tmp/pack.zip', { limits: LIMITS });
    expect(contentUninstall).toHaveBeenCalledWith('i1', 'demo.pack', files);
    expect(contentSetOrder).toHaveBeenCalledWith('i1', ['b.pack', 'a.pack']);
    expect(saveRestore).toHaveBeenCalledWith('i1', 'b1', { backupCurrent: false });
    expect(saveImport).toHaveBeenCalledWith('i1', 'C:/tmp/saves.zip');
    expect(saveExport).toHaveBeenCalledWith('i1', { label: '导出' });
  });

  it('可选参缺席时不补默认值：第三参原样是 undefined（本层不替宿主做判断）', async () => {
    const contentPlan = vi.fn(async (_id: string, _archive: string, _opts?: unknown) => makePlan());
    const contentUninstall = vi.fn(async (_id: string, _pack: string, _files?: unknown) => makeTask());
    const saveRestore = vi.fn(async (_id: string, _backupId: string, _opts?: unknown) => makeTask());
    const impl = new LauncherHostImpl({
      launcher: makeHost({ contentPlan, contentUninstall, saveRestore }),
    } as PlatformBridge);

    await impl.contentPlan('i1', 'C:/tmp/pack.zip');
    await impl.contentUninstall('i1', 'demo.pack');
    await impl.saveRestore('i1', 'b1');

    expect(contentPlan.mock.calls[0]![2]).toBeUndefined();
    expect(contentUninstall.mock.calls[0]![2]).toBeUndefined();
    expect(saveRestore.mock.calls[0]![2]).toBeUndefined();
  });

  it('方法缺席：每一条都抛出人话（点名是哪一族），绝不静默成功', async () => {
    const impl = new LauncherHostImpl({ launcher: makeHost({}) } as PlatformBridge);

    await expect(impl.contentList('i1')).rejects.toThrow(/不支持内容包列表/);
    await expect(impl.contentPlan('i1', 'C:/tmp/pack.zip')).rejects.toThrow(/不支持内容包预检/);
    await expect(impl.contentApply('p1')).rejects.toThrow(/不支持内容包安装/);
    await expect(impl.contentUninstall('i1', 'demo.pack')).rejects.toThrow(/不支持内容包卸载/);
    await expect(impl.contentSetEnabled('i1', 'demo.pack', false)).rejects.toThrow(/不支持内容包启停/);
    await expect(impl.contentSetOrder('i1', [])).rejects.toThrow(/不支持内容包排序/);
    await expect(impl.contentDiagnose('i1')).rejects.toThrow(/不支持内容包诊断/);

    await expect(impl.saveList('i1')).rejects.toThrow(/不支持存档列表/);
    await expect(impl.saveBackups('i1')).rejects.toThrow(/不支持存档备份列表/);
    await expect(impl.saveBackup('i1', {})).rejects.toThrow(/不支持存档备份/);
    await expect(impl.saveRestore('i1', 'b1')).rejects.toThrow(/不支持存档恢复/);
    await expect(impl.saveDeleteBackup('i1', 'b1')).rejects.toThrow(/不支持删除存档备份/);
    await expect(impl.saveImport('i1', 'C:/tmp/saves.zip')).rejects.toThrow(/不支持存档导入预检/);
    await expect(impl.saveApplyImport('p1')).rejects.toThrow(/不支持存档导入/);
    await expect(impl.saveExport('i1', {})).rejects.toThrow(/不支持存档导出/);
  });

  it('平台整块缺席时仍是「没有启动器能力」那一句（不把平台缺席说成某条命令缺席）', async () => {
    const impl = new LauncherHostImpl({} as PlatformBridge);
    await expect(impl.saveList('i1')).rejects.toThrow(/桌面壳/);
    await expect(impl.contentDiagnose('i1')).rejects.toThrow(/桌面壳/);
  });
});
