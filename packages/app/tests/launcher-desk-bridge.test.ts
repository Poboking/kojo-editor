/**
 * 桌面壳桥的启动器面（`PlatformBridge.launcher`）—— L3c 的判据面。
 *
 * 钉六件事（每条都对应 `launcher-bridge.ts` 的一条纪律）：
 * 1. **一个方法 = 一条命令**：20 条已接命令的**命令名与载荷键**逐字断言（表驱动，
 *    一个方法一行）；参数表来自 `src-tauri/src/launcher/commands.rs`，漂一个字就红。
 * 2. **DTO 直通**：宿主 `#[serde(rename_all = "camelCase")]` ⇒ 字段名逐字相同，桥零改名；
 *    反例（喂 snake_case 进来必须原样出去）钉住"没有第二份改名表"。
 * 3. **错误码透传**：`LauncherErrorDto` → `LauncherBridgeError`（code / message / detail /
 *    retryable 一个不少）；非 DTO 的拒绝原样上抛，不冒充启动器错误码。
 * 4. **事件**：四条事件名逐字、载荷原样（含 `seq`）、**不去重**（同一 seq 到两次就转两次）。
 * 5. **`Unsubscribe` 真取消**：订阅完成后取消、以及"还没订阅上就取消"两条路径都要退订。
 * 6. **能力缺席语义**：Tauri 桥有 `launcher`，Node 桥**没有**（缺席 = 无此能力，
 *    由内核透传层给一句人话，本层不兜底造假）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchProfile, PlatformBridge } from '@kojo/plugin-api';

const { invokeMock, listenMock, unlistenMock } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  const unlistenMock = vi.fn();
  const listenMock = vi.fn();
  return { invokeMock, listenMock, unlistenMock };
});

vi.mock('../src/bridge/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => true,
  bytesToBase64: (): string => '',
  base64ToBytes: (): Uint8Array => new Uint8Array(0),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { LauncherBridgeError, launcherBridge } from '../src/bridge/launcher-bridge';
import { tauriBridge } from '../src/bridge/tauri-bridge';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';

const L = launcherBridge;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockReset();
  listenMock.mockImplementation(async () => unlistenMock);
  unlistenMock.mockReset();
});

const REQUEST = {
  name: '实例 A',
  sourceRoot: 'C:/game',
  adapterId: 'adapter.x',
  gameId: 'game.x',
  candidateId: 'c1',
  isolation: 'shared' as const,
};

const PROFILE: LaunchProfile = {
  candidateId: 'c1',
  executable: { relativePath: 'game.exe', args: [], env: {}, windowMode: 'auto', sha256: null },
  cwdRelative: '.',
  saveRoots: [],
  contentRoots: [],
};

/** 一张表 = 已接的 20 条命令（少接一条就少一行，下面的计数断言会红） */
const ROWS: ReadonlyArray<{
  readonly method: string;
  readonly cmd: string;
  readonly args: Record<string, unknown> | undefined;
  readonly run: () => Promise<unknown>;
}> = [
  { method: 'instanceList', cmd: 'launcher_instance_list', args: undefined, run: () => L.instanceList() },
  {
    method: 'instanceInspect',
    cmd: 'launcher_instance_get',
    args: { instanceId: 'inst-1' },
    run: () => L.instanceInspect('inst-1'),
  },
  {
    method: 'instanceCreate',
    cmd: 'launcher_instance_create',
    args: { request: REQUEST, profile: PROFILE },
    run: () => L.instanceCreate(REQUEST, PROFILE),
  },
  {
    method: 'instanceUpdate',
    cmd: 'launcher_instance_update',
    args: { instanceId: 'inst-1', patch: { name: '改名', tags: ['a'] } },
    run: () => L.instanceUpdate('inst-1', { name: '改名', tags: ['a'] }),
  },
  {
    method: 'instanceRemove',
    cmd: 'launcher_instance_remove',
    args: { instanceId: 'inst-1', deleteFiles: true, keepBackups: true },
    run: () => L.instanceRemove('inst-1', { deleteFiles: true, keepBackups: true }),
  },
  {
    method: 'instanceDuplicate',
    cmd: 'launcher_instance_duplicate',
    args: { instanceId: 'inst-1', name: '副本' },
    run: () => L.instanceDuplicate!('inst-1', '副本'),
  },
  {
    method: 'pickSourceRoot',
    cmd: 'launcher_pick_source_root',
    args: { title: '选择游戏目录' },
    run: () => L.pickSourceRoot('选择游戏目录'),
  },
  {
    method: 'pickWriteRoot',
    cmd: 'launcher_pick_write_root',
    args: { instanceId: 'inst-1', rootId: 'root-a' },
    run: () => L.pickWriteRoot!('inst-1', 'root-a'),
  },
  {
    method: 'openInstanceFolder',
    cmd: 'launcher_instance_open_folder',
    args: { instanceId: 'inst-1', which: 'instance' },
    run: () => L.openInstanceFolder('inst-1', 'root'),
  },
  {
    method: 'trustExecutable',
    cmd: 'launcher_trust_executable',
    args: { instanceId: 'inst-1' },
    run: () => L.trustExecutable('inst-1'),
  },
  { method: 'start', cmd: 'launcher_start', args: { instanceId: 'inst-1' }, run: () => L.start('inst-1') },
  {
    method: 'stop',
    cmd: 'launcher_stop',
    args: { instanceId: 'inst-1', force: true, timeoutMs: 2500 },
    run: () => L.stop('inst-1', { force: true, timeoutMs: 2500 }),
  },
  {
    method: 'processStatus',
    cmd: 'launcher_process_status',
    args: { instanceId: 'inst-1' },
    run: () => L.processStatus('inst-1'),
  },
  { method: 'processList', cmd: 'launcher_process_list', args: undefined, run: () => L.processList() },
  {
    method: 'logTail',
    cmd: 'launcher_log_tail',
    args: { instanceId: 'inst-1', query: { maxBytes: 4096, stream: 'stderr' } },
    run: () => L.logTail('inst-1', { maxBytes: 4096, stream: 'stderr' }),
  },
  {
    method: 'logSessions',
    cmd: 'launcher_log_sessions',
    args: { instanceId: 'inst-1' },
    run: () => L.logSessions('inst-1'),
  },
  {
    method: 'logRead',
    cmd: 'launcher_log_read',
    args: { sessionId: 'sess-1', query: { errorsOnly: true } },
    run: () => L.logRead('sess-1', { errorsOnly: true }),
  },
  {
    method: 'logExport',
    cmd: 'launcher_log_export',
    args: { instanceId: 'inst-1', sessionId: 'sess-1', includeDiagnostics: null },
    run: () => L.logExport!('inst-1', 'sess-1'),
  },
  { method: 'taskList', cmd: 'launcher_task_list', args: undefined, run: () => L.taskList() },
  {
    method: 'taskCancel',
    cmd: 'launcher_task_cancel',
    args: { taskId: 'task-1' },
    run: () => L.taskCancel('task-1'),
  },
];

describe('启动器桥 · 命令名与载荷（一个方法 = 一条命令）', () => {
  it('表覆盖 Rust 已存在的全部 20 条 launcher_* 命令，且命令名不重复', () => {
    expect(ROWS.length).toBe(20);
    expect(new Set(ROWS.map((r) => r.cmd)).size).toBe(20);
    // 每条命令都有对应方法（表自身就是方法的清单：漏接一个方法这里就少一行）
    for (const row of ROWS) expect(typeof (L as unknown as Record<string, unknown>)[row.method]).toBe('function');
  });

  it('二十条命令一个不重复地真打出去（表驱动逐行断言）', async () => {
    for (const row of ROWS) {
      invokeMock.mockClear();
      await row.run();
      if (row.args === undefined) expect(invokeMock, row.method).toHaveBeenCalledWith(row.cmd);
      else expect(invokeMock, row.method).toHaveBeenCalledWith(row.cmd, row.args);
    }
  });

  for (const row of ROWS) {
    it(`载荷键：${row.method} → ${row.cmd}`, async () => {
      await row.run();
      if (row.args === undefined) expect(invokeMock).toHaveBeenCalledTimes(1);
      else expect(invokeMock.mock.calls[0]).toEqual([row.cmd, row.args]);
    });
  }

  it('契约里可选、宿主侧是 Option 的参数：没给就显式传 null（不让键消失走 serde default）', async () => {
    await L.instanceRemove('inst-1', { deleteFiles: false });
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_instance_remove', {
      instanceId: 'inst-1',
      deleteFiles: false,
      keepBackups: null,
    });

    await L.instanceDuplicate!('inst-1');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_instance_duplicate', {
      instanceId: 'inst-1',
      name: null,
    });

    await L.pickSourceRoot();
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_pick_source_root', { title: null });

    await L.stop('inst-1');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_stop', {
      instanceId: 'inst-1',
      force: null,
      timeoutMs: null,
    });

    await L.logTail('inst-1');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_log_tail', { instanceId: 'inst-1', query: null });

    await L.logExport!('inst-1');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_log_export', {
      instanceId: 'inst-1',
      sessionId: null,
      includeDiagnostics: null,
    });
  });

  it('which 枚举映射：契约 root → 宿主 instance；宿主没有 saves 目标 ⇒ 本地抛错且不发 IPC', async () => {
    for (const [contractValue, hostValue] of [
      ['game', 'game'],
      ['logs', 'logs'],
      ['backups', 'backups'],
    ] as const) {
      invokeMock.mockClear();
      await L.openInstanceFolder('inst-1', contractValue);
      expect(invokeMock).toHaveBeenCalledWith('launcher_instance_open_folder', {
        instanceId: 'inst-1',
        which: hostValue,
      });
    }

    invokeMock.mockClear();
    await expect(L.openInstanceFolder('inst-1', 'saves')).rejects.toThrow(/存档目录/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('启动器桥 · DTO 直通（casing 的唯一真源是 Rust 的 serde 属性）', () => {
  it('概况的 camelCase 字段逐字落到契约（changedSinceTrust / saveRoots / diskUsageBytes / executableTrust）', async () => {
    const dto = {
      instance: {
        id: 'inst-1',
        name: '实例',
        instanceRoot: 'C:/app/instances/inst-1',
        gameRoot: 'C:/game',
        executable: { relativePath: 'game.exe', args: [], env: {}, windowMode: 'auto', sha256: 'ab' },
        executableTrust: { sha256: 'ab', size: 3, approvedAt: '2026-10-26T00:00:00Z', approvedBy: 'native-dialog' },
        launchCount: 0,
        lastLaunchedAt: null,
        lastExit: null,
        schemaVersion: 1,
      },
      executable: { absolutePath: 'C:/game/game.exe', exists: true, sha256: 'ab', trusted: true, changedSinceTrust: false },
      runtime: { required: null, resolved: null },
      paths: {
        instanceRoot: 'C:/app/instances/inst-1',
        gameRoot: 'C:/game',
        saveRoots: ['C:/game/save'],
        logDir: 'C:/app/instances/inst-1/logs',
        backupDir: 'C:/app/instances/inst-1/backups',
      },
      diskUsageBytes: 42,
      warnings: ['运行时管理属 P1，本版不会解析运行时'],
    };
    invokeMock.mockResolvedValueOnce(dto);

    const got = await L.instanceInspect('inst-1');
    expect(got).toBe(dto); // 零加工：不重建对象、不改名
    expect(got.executable.changedSinceTrust).toBe(false);
    expect(got.paths.saveRoots).toEqual(['C:/game/save']);
    expect(got.instance.executableTrust?.approvedBy).toBe('native-dialog');
    expect(got.diskUsageBytes).toBe(42);
  });

  it('日志页保留原始字节块（bytesBase64 + ts + stream），宿主多给的 per-chunk truncated 也原样带着', async () => {
    const page = {
      session: { id: 'sess-1', instanceId: 'inst-1', startedAt: 't0', endedAt: null, exitCode: null, stdoutBytes: 3, stderrBytes: 0 },
      chunks: [{ stream: 'stdout', ts: 1_700_000_000_000, bytesBase64: 'aGk=', truncated: false }],
      truncated: false,
    };
    invokeMock.mockResolvedValueOnce(page);

    const got = await L.logTail('inst-1');
    expect(got.chunks[0]).toMatchObject({ stream: 'stdout', ts: 1_700_000_000_000, bytesBase64: 'aGk=' });
    expect(got.session.id).toBe('sess-1');
    expect(got.truncated).toBe(false);
  });

  it('反例：喂 snake_case 进来必须原样穿出——桥上不存在第二份改名表', async () => {
    const snake = { id: 'inst-1', save_roots: [], executable: { relative_path: 'game.exe' }, launched_count: 0 };
    invokeMock.mockResolvedValueOnce(snake);

    const got = (await L.instanceInspect('inst-1')) as unknown as Record<string, unknown>;
    expect(got).toBe(snake);
    expect('saveRoots' in got).toBe(false);
    expect('executableRelativePath' in got).toBe(false);
    // 若有人加了"猜着改名"的表，上面两条必红（casing 只能由 Rust 的 rename_all 决定）
  });
});

describe('启动器桥 · 错误（LauncherErrorDto 的四个字段一个不少）', () => {
  it('code / message / detail / retryable 都留在字段上，message 保持宿主中文原句', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'LAUNCHER_TRUST_REQUIRED',
      message: '尚未信任可执行文件（首次启动前需确认）',
      detail: 'C:/game/game.exe',
      retryable: true,
    });

    const err = await L.start('inst-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LauncherBridgeError);
    const e = err as LauncherBridgeError;
    expect(e.name).toBe('LauncherBridgeError');
    expect(e.code).toBe('LAUNCHER_TRUST_REQUIRED');
    expect(e.message).toBe('尚未信任可执行文件（首次启动前需确认）');
    expect(e.detail).toBe('C:/game/game.exe');
    expect(e.retryable).toBe(true);
    expect(e).toBeInstanceOf(Error);
  });

  it('没有 detail 的宿主错误：detail 是 undefined（不是空串、不是 undefined 字符串）', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'LAUNCHER_INSTANCE_NOT_FOUND', message: '找不到这个实例', retryable: false });
    const err = (await L.instanceInspect('nope').catch((e: unknown) => e)) as LauncherBridgeError;
    expect(err.code).toBe('LAUNCHER_INSTANCE_NOT_FOUND');
    expect(err.detail).toBeUndefined();
    expect(err.retryable).toBe(false);
  });

  it('非启动器错误原样上抛（浏览器壳的 IPC 不可用不许被涂成宿主错误码）', async () => {
    const raw = new Error('Tauri IPC 不可用（当前为浏览器环境，命令：launcher_start）。请通过桌面壳运行。');
    invokeMock.mockRejectedValueOnce(raw);
    const err = await L.start('inst-1').catch((e: unknown) => e);
    expect(err).toBe(raw);
  });

  it('只有 message 的拒绝值包成普通 Error：不冒充启动器错误码', async () => {
    invokeMock.mockRejectedValueOnce({ message: '宿主线程池失败' });
    const err = (await L.processList().catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('宿主线程池失败');
    expect(err.code).toBeUndefined();
    expect(err).not.toBeInstanceOf(LauncherBridgeError);
  });
});

describe('启动器桥 · 事件订阅（名字逐字、载荷原样、不去重）', () => {
  const EVENTS = [
    ['onProcess', 'kojo:launcher-process'],
    ['onLog', 'kojo:launcher-log'],
    ['onTask', 'kojo:launcher-task'],
    ['onInstance', 'kojo:launcher-instance'],
  ] as const;

  for (const [method, event] of EVENTS) {
    it(`事件名逐字：${method} → ${event}`, async () => {
      const listener = vi.fn();
      const subscribeFn = L[method] as unknown as (fn: (e: unknown) => void) => () => void;
      subscribeFn(listener);
      await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
      expect(listenMock.mock.calls[0]?.[0]).toBe(event);
      expect(typeof listenMock.mock.calls[0]?.[1]).toBe('function');
    });
  }

  it('载荷原样转交（含 seq），同一 seq 到两次就转两次——本层不做去重', async () => {
    const seen: unknown[] = [];
    L.onProcess((e) => seen.push(e));
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));

    const handler = listenMock.mock.calls[0]![1] as (e: { payload: unknown }) => void;
    const payload = { instanceId: 'inst-1', status: { instanceId: 'inst-1', state: 'running' }, seq: 7 };
    handler({ payload });
    handler({ payload });

    expect(seen).toEqual([payload, payload]);
  });

  it('取消订阅真退订：listen 落定后调句柄 ⇒ unlisten 恰好一次，再调也不重复', async () => {
    const off = L.onTask(() => undefined);
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    off();
    off();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it('还没订阅上就取消：listen 落定时立刻退订（不漏挂监听）', async () => {
    let release: ((fn: () => void) => void) | undefined;
    listenMock.mockReset();
    listenMock.mockImplementationOnce(() => new Promise<() => void>((resolve) => (release = resolve)));

    const off = L.onInstance(() => undefined);
    // 等 listen 真被调到（此时返回的 Promise 还悬着：订阅尚未落定）
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    off();
    expect(unlistenMock).not.toHaveBeenCalled();

    expect(release).toBeDefined();
    release!(unlistenMock);
    await vi.waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));
  });
});

describe('启动器桥 · 能力缺席语义（PlatformBridge.launcher 是可选字段）', () => {
  it('Tauri 桥有 launcher：20 条命令 + 4 条事件全在', () => {
    const face = tauriBridge.launcher;
    expect(face).toBeDefined();
    for (const row of ROWS) expect(typeof (face as unknown as Record<string, unknown>)[row.method]).toBe('function');
    for (const method of ['onProcess', 'onLog', 'onTask', 'onInstance']) {
      expect(typeof (face as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('Node 桥没有 launcher（缺席 = 无此能力，由内核透传层给一句人话）', () => {
    // 按契约类型看：`PlatformBridge.launcher` 是可选项 ⇒ Node 桥照样满足契约
    const node: PlatformBridge = new NodeBridge('C:/appdata');
    expect(node.launcher).toBeUndefined();
    expect('launcher' in node).toBe(false);
  });
});
