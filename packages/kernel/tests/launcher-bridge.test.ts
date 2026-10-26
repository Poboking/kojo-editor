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
  HostLogPage,
  LauncherHostBridge,
  LauncherInstance,
  PlatformBridge,
  ProcessStatus,
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
