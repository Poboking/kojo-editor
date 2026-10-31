/**
 * 桌面壳桥的启动器面 · **P1 十八组**（L3d 十六 + L7B 插件源码项目两条）：
 * `launcher_pick_archive` + `launcher_content_*` 七条 + `launcher_save_*` 八条 +
 * `launcher_project_{hash,extract}`。
 *
 * 钉七件事（每条都对应 `launcher-bridge.ts` 里的一条纪律或 L3b 回执点名的一处差异）：
 * 1. **一个方法 = 一条命令**：18 条命令的命令名与**载荷键**逐字断言（表驱动，一个方法一行），
 *    参数表来自 `src-tauri/src/launcher/commands.rs`，漂一个字就红；
 * 2. **形状对齐到消费方**：`save_list` 的 `{ entries, roots, warnings }` 必须满足
 *    `launcher-core` 的 `HostSaveListing`（`roots[].approved` 是 shared 写回门禁），
 *    两组 16 个方法必须满足 `ContentHostCommands` / `SaveHostBridge`（编译期赋值断言）；
 * 3. `content_plan` 的 `opts.limits{maxEntries,maxDepth,maxUnpackedBytes}` 逐字透传，
 *    `content_uninstall` 的 `files[{rootId,path}]` 原样（空数组不塌成 null）；
 * 4. **多报字段不丢**：`content_diagnose.issues[].code` 的 `orphan-file` / `load-order`、
 *    `save_import` 的 `entryCount/totalBytes/expiresAt` 原样穿出（映射归 `launcher-core`）；
 * 5. **错误码透传**：宿主 `LauncherErrorDto` → `LauncherBridgeError` 四字段一个不少；
 * 6. **缺席语义**：旧版桌面壳没编进命令（Tauri `Command … not found`）⇒ 中文人话
 *    + `LAUNCHER_PLATFORM_UNSUPPORTED`，不静默、不返回假数据；
 * 7. **命令名与 Rust 同源**：桥里出现的 `launcher_*` 字面量与 `commands.rs::COMMAND_NAMES`
 *    **集合相等**（38 = 20 + 18）——L7B 收口后 `launcher_project_*` 两条已真接；
 *    `launcher_runtime_*`（另一张卡）仍未接，一个都不许写调用。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentHostCommands, SaveHostBridge } from '@kojo/plugin-launcher-core';
import type { PlatformBridge, ZipContractLimits } from '@kojo/plugin-api';

const { invokeMock } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  return { invokeMock };
});

vi.mock('../src/bridge/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => true,
  bytesToBase64: (): string => '',
  base64ToBytes: (): Uint8Array => new Uint8Array(0),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { LauncherBridgeError, attachLauncherBridge, launcherBridge } from '../src/bridge/launcher-bridge';
import { tauriBridge } from '../src/bridge/tauri-bridge';

const L = launcherBridge;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

/** 契约常量那一档（数值本身不重要，要紧的是**键名**与「三个数一起走」） */
const LIMITS: ZipContractLimits = { maxEntries: 1000, maxDepth: 8, maxUnpackedBytes: 1_048_576 };

const TASK = {
  id: 'task-1',
  kind: 'content-install',
  instanceId: 'inst-1',
  state: 'succeeded',
  progress: null,
  createdAt: 't0',
  startedAt: 't0',
  endedAt: 't1',
  error: null,
  result: { backupId: 'bk-9' },
  cancellable: false,
};

/** 表 = P1 的 18 条命令（少接一条就少一行，下面的计数断言会红） */
const ROWS: ReadonlyArray<{
  readonly method: string;
  readonly cmd: string;
  readonly args: Record<string, unknown>;
  readonly run: () => Promise<unknown>;
}> = [
  {
    method: 'pickArchive',
    cmd: 'launcher_pick_archive',
    args: { title: '选择内容包' },
    run: () => L.pickArchive!('选择内容包'),
  },
  {
    method: 'contentList',
    cmd: 'launcher_content_list',
    args: { instanceId: 'inst-1' },
    run: () => L.contentList('inst-1'),
  },
  {
    method: 'contentPlan',
    cmd: 'launcher_content_plan',
    args: { instanceId: 'inst-1', archivePath: 'C:/tmp/pack.zip', opts: { limits: LIMITS } },
    run: () => L.contentPlan('inst-1', 'C:/tmp/pack.zip', { limits: LIMITS }),
  },
  {
    method: 'contentApply',
    cmd: 'launcher_content_apply',
    args: { planId: 'plan-1', resolutions: [{ rootId: 'root-a', path: 'a.erb', action: 'skip' }] },
    run: () => L.contentApply('plan-1', [{ rootId: 'root-a', path: 'a.erb', action: 'skip' }]),
  },
  {
    method: 'contentUninstall',
    cmd: 'launcher_content_uninstall',
    args: { instanceId: 'inst-1', packId: 'a.pack', files: [{ rootId: 'root-a', path: 'a.erb' }] },
    run: () => L.contentUninstall('inst-1', 'a.pack', [{ rootId: 'root-a', path: 'a.erb' }]),
  },
  {
    method: 'contentSetEnabled',
    cmd: 'launcher_content_set_enabled',
    args: { instanceId: 'inst-1', packId: 'a.pack', enabled: false },
    run: () => L.contentSetEnabled('inst-1', 'a.pack', false),
  },
  {
    method: 'contentSetOrder',
    cmd: 'launcher_content_set_order',
    args: { instanceId: 'inst-1', packIds: ['a.pack', 'b.pack'] },
    run: () => L.contentSetOrder('inst-1', ['a.pack', 'b.pack']),
  },
  {
    method: 'contentDiagnose',
    cmd: 'launcher_content_diagnose',
    args: { instanceId: 'inst-1' },
    run: () => L.contentDiagnose('inst-1'),
  },
  {
    method: 'saveList',
    cmd: 'launcher_save_list',
    args: { instanceId: 'inst-1' },
    run: () => L.saveList('inst-1'),
  },
  {
    method: 'saveBackups',
    cmd: 'launcher_save_backups',
    args: { instanceId: 'inst-1' },
    run: () => L.saveBackups('inst-1'),
  },
  {
    method: 'saveBackup',
    cmd: 'launcher_save_backup',
    args: {
      instanceId: 'inst-1',
      req: { label: '手动备份', reason: 'manual', entries: [{ rootId: 'root-a', path: 'a.erb' }] },
    },
    run: () =>
      L.saveBackup('inst-1', {
        label: '手动备份',
        reason: 'manual',
        entries: [{ rootId: 'root-a', path: 'a.erb' }],
      }),
  },
  {
    method: 'saveRestore',
    cmd: 'launcher_save_restore',
    args: { instanceId: 'inst-1', backupId: 'bk-1', opts: { backupCurrent: false } },
    run: () => L.saveRestore('inst-1', 'bk-1', { backupCurrent: false }),
  },
  {
    method: 'saveDeleteBackup',
    cmd: 'launcher_save_delete_backup',
    args: { instanceId: 'inst-1', backupId: 'bk-1' },
    run: () => L.saveDeleteBackup('inst-1', 'bk-1'),
  },
  {
    method: 'saveImport',
    cmd: 'launcher_save_import',
    args: { instanceId: 'inst-1', archivePath: 'C:/tmp/saves.zip' },
    run: () => L.saveImport('inst-1', 'C:/tmp/saves.zip'),
  },
  {
    method: 'saveApplyImport',
    cmd: 'launcher_save_apply_import',
    args: { planId: 'plan-9', resolutions: [{ rootId: 'root-a', path: 'a.erb', action: 'overwrite' }] },
    run: () =>
      L.saveApplyImport('plan-9', [{ rootId: 'root-a', path: 'a.erb', action: 'overwrite' }]),
  },
  {
    method: 'saveExport',
    cmd: 'launcher_save_export',
    args: { instanceId: 'inst-1', req: { label: '导出存档', entries: [] } },
    run: () => L.saveExport('inst-1', { label: '导出存档', entries: [] }),
  },
  {
    method: 'projectHash',
    cmd: 'launcher_project_hash',
    args: { projectDir: 'C:/ws/demo', artifactDir: 'build', entries: ['script/a.txt', 'script/b.txt'] },
    run: () =>
      L.projectHash!({ projectDir: 'C:/ws/demo', artifactDir: 'build', entries: ['script/a.txt', 'script/b.txt'] }),
  },
  {
    method: 'projectExtract',
    cmd: 'launcher_project_extract',
    args: { archivePath: 'C:/tmp/project.zip', opts: { limits: LIMITS } },
    run: () => L.projectExtract!('C:/tmp/project.zip', { limits: LIMITS }),
  },
];

describe('启动器桥 P1 · 命令名与载荷（一个方法 = 一条命令）', () => {
  it('表覆盖 18 条 P1 命令，命令名不重复，且每个方法都在桥面上', () => {
    expect(ROWS.length).toBe(18);
    expect(new Set(ROWS.map((r) => r.cmd)).size).toBe(18);
    for (const row of ROWS) {
      expect(typeof (L as unknown as Record<string, unknown>)[row.method], row.method).toBe('function');
    }
  });

  it('十八条命令一条不重复地真打出去（表驱动逐行断言）', async () => {
    for (const row of ROWS) {
      invokeMock.mockClear();
      await row.run();
      expect(invokeMock, row.method).toHaveBeenCalledWith(row.cmd, row.args);
    }
  });

  for (const row of ROWS) {
    it(`载荷键：${row.method} → ${row.cmd}`, async () => {
      await row.run();
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([row.cmd, row.args]);
    });
  }
});

describe('启动器桥 P1 · 与 launcher-core 的两张局部契约对齐', () => {
  it('编译期：桥同时满足 LauncherHostBridge / ContentHostCommands / SaveHostBridge（漂了就红）', () => {
    // 这三条赋值是**类型级**断言：`launcher-core` 的方法名或参数表一变，本文件 tsc 就红
    const content: ContentHostCommands = L;
    const save: SaveHostBridge = L;
    const platform: PlatformBridge = { ...tauriBridge };
    attachLauncherBridge(platform);
    expect(platform.launcher).toBeDefined();
    // 运行期：saveHostFrom 探测的九个方法一个不少（少一个它整块返回 null ⇒ 存档页消失）
    for (const method of [
      'saveList',
      'saveBackups',
      'saveBackup',
      'saveRestore',
      'saveDeleteBackup',
      'saveImport',
      'saveApplyImport',
      'saveExport',
      'taskCancel',
    ]) {
      expect(typeof (platform.launcher as unknown as Record<string, unknown>)[method], method).toBe('function');
    }
    for (const method of Object.keys(content)) expect(method.length).toBeGreaterThan(0);
    for (const method of Object.keys(save)) expect(method.length).toBeGreaterThan(0);
  });

  it('懒挂载后 P0 的 20 个方法仍在（本批只加不减）', () => {
    const platform: PlatformBridge = { ...tauriBridge };
    attachLauncherBridge(platform);
    for (const method of [
      'instanceList',
      'instanceInspect',
      'instanceCreate',
      'instanceUpdate',
      'instanceRemove',
      'instanceDuplicate',
      'pickSourceRoot',
      'pickWriteRoot',
      'openInstanceFolder',
      'trustExecutable',
      'start',
      'stop',
      'processStatus',
      'processList',
      'logTail',
      'logSessions',
      'logRead',
      'logExport',
      'taskList',
      'taskCancel',
    ]) {
      expect(typeof (platform.launcher as unknown as Record<string, unknown>)[method], method).toBe('function');
    }
  });
});

describe('启动器桥 P1 · save_list 的三字段（HostSaveListing，不是裸数组）', () => {
  const LISTING = {
    entries: [
      { path: 'save01.erb', rootId: 'root-a', name: '存档一', bytes: 128, mtimeMs: 1_700_000_000_000 },
    ],
    roots: [
      { rootId: 'root-a', approved: true, exists: true },
      { rootId: 'root-b', approved: false, exists: false },
    ],
    warnings: ['root-b 未授权写回，shared 实例下不列出该根'],
  };

  it('entries / roots / warnings 三字段原样落到 HostSaveListing（approved 是写回门禁）', async () => {
    invokeMock.mockResolvedValueOnce(LISTING);
    const got = await L.saveList('inst-1');
    expect(got).toBe(LISTING);
    expect(got.entries[0]).toEqual({
      path: 'save01.erb',
      rootId: 'root-a',
      name: '存档一',
      bytes: 128,
      mtimeMs: 1_700_000_000_000,
    });
    expect(got.roots.map((r) => [r.rootId, r.approved])).toEqual([
      ['root-a', true],
      ['root-b', false],
    ]);
    expect(got.warnings).toEqual(['root-b 未授权写回，shared 实例下不列出该根']);
  });

  it('反例：喂 snake_case 进来必须原样穿出（本层没有第二份改名表）', async () => {
    const snake = { entries: [{ root_id: 'root-a', path: 'x' }], roots: [{ root_id: 'root-a', approved: true }] };
    invokeMock.mockResolvedValueOnce(snake);
    const got = (await L.saveList('inst-1')) as unknown as Record<string, unknown>;
    expect(got).toBe(snake);
    expect(JSON.stringify(got)).toContain('root_id');
    expect(JSON.stringify(got)).not.toContain('rootId');
  });
});

describe('启动器桥 P1 · content_plan 的 limits 透传', () => {
  it('第三参只有一个键 opts.limits，三个数用 camelCase 逐字送出（不给宿主补默认）', async () => {
    await L.contentPlan('inst-1', 'C:/tmp/pack.zip', { limits: LIMITS });
    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe('launcher_content_plan');
    expect(args).toEqual({
      instanceId: 'inst-1',
      archivePath: 'C:/tmp/pack.zip',
      opts: { limits: { maxEntries: 1000, maxDepth: 8, maxUnpackedBytes: 1_048_576 } },
    });
    // 键名是 Rust `StagingLimits` 的 serde 口径（camelCase）；写成 snake_case 会被反序列化拒
    expect(JSON.stringify(args)).not.toContain('max_entries');
  });

  it('计划原样返回（conflicts 多报的 case-collision / existingPath 不在这里折）', async () => {
    const plan = {
      planId: 'plan-1',
      manifest: { schemaVersion: 1, id: 'a.pack', files: [] },
      targets: [{ rootId: 'root-a', relativePath: '' }],
      additions: [{ rootId: 'root-a', path: 'a.erb' }],
      overwrites: [],
      conflicts: [
        {
          rootId: 'root-a',
          path: 'Data/A.erb',
          kind: 'case-collision',
          existingPackId: null,
          existingPath: 'data/a.erb',
          resolution: 'abort',
        },
      ],
      missingRequirements: [],
      warnings: [],
      expiresAt: '2026-10-26T00:10:00Z',
    };
    invokeMock.mockResolvedValueOnce(plan);
    const got = await L.contentPlan('inst-1', 'C:/tmp/pack.zip', { limits: LIMITS });
    expect(got).toBe(plan);
    expect(got.conflicts[0]?.kind).toBe('case-collision');
    expect(got.conflicts[0]?.existingPath).toBe('data/a.erb');
  });
});

describe('启动器桥 P1 · content_uninstall 的 files 透传', () => {
  it('files 逐条原样（rootId + path），不改序不去重', async () => {
    invokeMock.mockResolvedValueOnce(TASK);
    const files = [
      { rootId: 'root-a', path: 'a.erb' },
      { rootId: 'root-b', path: 'b/c.erb' },
    ];
    const got = await L.contentUninstall('inst-1', 'a.pack', files);
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_content_uninstall', {
      instanceId: 'inst-1',
      packId: 'a.pack',
      files,
    });
    expect(got).toBe(TASK);
  });

  it('空数组保持 []（塌成 null 等于让宿主以为「没给快照」）', async () => {
    await L.contentUninstall('inst-1', 'a.pack', []);
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_content_uninstall', {
      instanceId: 'inst-1',
      packId: 'a.pack',
      files: [],
    });
  });
});

describe('启动器桥 P1 · content_diagnose 的 issues 原样（含 orphan-file / load-order）', () => {
  it('契约四项之外的两档码不被过滤、不被改写', async () => {
    const diagnosis = {
      instanceId: 'inst-1',
      issues: [
        { packId: 'a.pack', code: 'orphan-file', path: 'Data/orphan.erb', message: '孤儿文件：不属于任何已装内容包' },
        { packId: 'a.pack', code: 'load-order', message: '启用顺序异常：依赖包排在后面' },
        { packId: 'a.pack', code: 'missing-file', path: 'a.erb', message: '文件缺失' },
      ],
    };
    invokeMock.mockResolvedValueOnce(diagnosis);
    const got = await L.contentDiagnose('inst-1');
    expect(got).toBe(diagnosis);
    expect(got.issues.map((i) => i.code)).toEqual(['orphan-file', 'load-order', 'missing-file']);
    expect(got.issues[0]).toEqual({
      packId: 'a.pack',
      code: 'orphan-file',
      path: 'Data/orphan.erb',
      message: '孤儿文件：不属于任何已装内容包',
    });
  });

  it('将来宿主再加诊断码也不拦（本层不认识码，只搬运）', async () => {
    const diagnosis = { instanceId: 'inst-1', issues: [{ packId: 'a.pack', code: 'future-code', message: '新码' }] };
    invokeMock.mockResolvedValueOnce(diagnosis);
    const got = await L.contentDiagnose('inst-1');
    expect(got.issues[0]?.code).toBe('future-code');
  });
});

describe('启动器桥 P1 · save_import 的多字段（entryCount / totalBytes / expiresAt）', () => {
  const PLAN = {
    planId: 'plan-9',
    backupId: 'bk-9',
    overwrites: ['root-a/save01.erb'],
    warnings: ['同名存档将被覆盖'],
    entryCount: 3,
    totalBytes: 4096,
    expiresAt: '2026-10-26T00:10:00Z',
  };

  it('契约四字段 + 宿主多报三字段一并原样（缺一个消费方就只能猜）', async () => {
    invokeMock.mockResolvedValueOnce(PLAN);
    const got = await L.saveImport('inst-1', 'C:/tmp/saves.zip');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_import', {
      instanceId: 'inst-1',
      archivePath: 'C:/tmp/saves.zip',
    });
    expect(got).toBe(PLAN);
    expect(got.entryCount).toBe(3);
    expect(got.totalBytes).toBe(4096);
    expect(got.expiresAt).toBe('2026-10-26T00:10:00Z');
  });

  it('overwrites / warnings 逐字（不重排、不拼接）', async () => {
    invokeMock.mockResolvedValueOnce(PLAN);
    const got = await L.saveImport('inst-1', 'C:/tmp/saves.zip');
    expect(got.overwrites).toEqual(['root-a/save01.erb']);
    expect(got.warnings).toEqual(['同名存档将被覆盖']);
    expect(got.planId).toBe('plan-9');
    expect(got.backupId).toBe('bk-9');
  });
});

describe('启动器桥 P1 · 可选参数（Rust 是 Option ⇒ 没给就显式 null）', () => {
  it('contentApply / saveApplyImport：resolutions 省略 ⇒ null，给了就原样', async () => {
    await L.contentApply('plan-1');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_content_apply', {
      planId: 'plan-1',
      resolutions: null,
    });

    await L.saveApplyImport('plan-9');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_apply_import', {
      planId: 'plan-9',
      resolutions: null,
    });

    const resolutions = [{ rootId: 'root-a', path: 'a.erb', action: 'replace' as const }];
    await L.contentApply('plan-1', resolutions);
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_content_apply', {
      planId: 'plan-1',
      resolutions,
    });
  });

  it('pickArchive：title 省略 ⇒ null；返回 null（用户取消）原样', async () => {
    invokeMock.mockResolvedValueOnce(null);
    const got = await L.pickArchive!();
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_pick_archive', { title: null });
    expect(got).toBeNull();
  });

  it('saveRestore：opts 省略 ⇒ null；给了就把 backupCurrent 显式写出（缺省 null = 宿主默认 true）', async () => {
    await L.saveRestore('inst-1', 'bk-1');
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_restore', {
      instanceId: 'inst-1',
      backupId: 'bk-1',
      opts: null,
    });

    await L.saveRestore('inst-1', 'bk-1', {});
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_restore', {
      instanceId: 'inst-1',
      backupId: 'bk-1',
      opts: { backupCurrent: null },
    });

    await L.saveRestore('inst-1', 'bk-1', { backupCurrent: true });
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_restore', {
      instanceId: 'inst-1',
      backupId: 'bk-1',
      opts: { backupCurrent: true },
    });
  });

  it('saveBackup / saveExport：请求体原样（Rust 侧是必填 DTO，键名 camelCase 直通）', async () => {
    const req = { label: '导出', entries: [{ rootId: 'root-a', path: 'a.erb' }] };
    invokeMock.mockResolvedValueOnce('C:/out/saves.zip');
    const gotPath = await L.saveExport('inst-1', req);
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_export', { instanceId: 'inst-1', req });
    expect(gotPath).toBe('C:/out/saves.zip');

    const backupReq = { label: '手动', reason: 'manual' as const };
    await L.saveBackup('inst-1', backupReq);
    expect(invokeMock).toHaveBeenLastCalledWith('launcher_save_backup', {
      instanceId: 'inst-1',
      req: backupReq,
    });
  });
});

describe('启动器桥 P1 · 错误码透传（LauncherErrorDto 四字段一个不少）', () => {
  it('内容包错误：code / message / detail / retryable 全留在 LauncherBridgeError 上', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      message: '压缩包超过解压限额，已拒绝',
      detail: 'entries=10001 > 10000',
      retryable: true,
    });
    const err = (await L.contentPlan('inst-1', 'C:/tmp/pack.zip', { limits: LIMITS }).catch(
      (e: unknown) => e,
    )) as LauncherBridgeError;
    expect(err).toBeInstanceOf(LauncherBridgeError);
    expect(err.code).toBe('LAUNCHER_ARCHIVE_LIMIT');
    expect(err.message).toBe('压缩包超过解压限额，已拒绝');
    expect(err.detail).toBe('entries=10001 > 10000');
    expect(err.retryable).toBe(true);
  });

  it('存档错误：没有 detail 时是 undefined（不是空串），且不冒充未支持', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'LAUNCHER_SAVE_RESTORE_FAILED',
      message: '恢复存档失败，已按恢复前的状态回滚',
      retryable: false,
    });
    const err = (await L.saveRestore('inst-1', 'bk-1').catch((e: unknown) => e)) as LauncherBridgeError;
    expect(err).toBeInstanceOf(LauncherBridgeError);
    expect(err.code).toBe('LAUNCHER_SAVE_RESTORE_FAILED');
    expect(err.detail).toBeUndefined();
    expect(err.retryable).toBe(false);
  });

  it('非启动器错误（IPC 不可用）原样上抛，不被涂成宿主错误码', async () => {
    const raw = new Error('Tauri IPC 不可用（当前为浏览器环境，命令：launcher_save_list）。请通过桌面壳运行。');
    invokeMock.mockRejectedValueOnce(raw);
    const err = await L.saveList('inst-1').catch((e: unknown) => e);
    expect(err).toBe(raw);
  });
});

describe('启动器桥 P1 · 缺席语义（旧桌面壳没编进这 18 条命令）', () => {
  it('Tauri「Command … not found」⇒ LAUNCHER_PLATFORM_UNSUPPORTED + 中文人话 + 点名命令', async () => {
    invokeMock.mockRejectedValueOnce(new Error('Command launcher_content_diagnose not found'));
    const err = (await L.contentDiagnose('inst-1').catch((e: unknown) => e)) as LauncherBridgeError;
    expect(err).toBeInstanceOf(LauncherBridgeError);
    expect(err.code).toBe('LAUNCHER_PLATFORM_UNSUPPORTED');
    expect(err.message).toContain('当前桌面壳不支持内容包诊断');
    expect(err.message).toContain('launcher_content_diagnose');
    expect(err.detail).toContain('launcher_content_diagnose');
    expect(err.retryable).toBe(false);
    // 不是静默：既不是 null、也不是原样英文串
    expect(err.message).not.toContain('not found');
  });

  it('别的英文错误不被误判成「缺命令」（只认那一句话）', async () => {
    const raw = new Error('Command launcher_save_list failed: io error');
    invokeMock.mockRejectedValueOnce(raw);
    const err = await L.saveList('inst-1').catch((e: unknown) => e);
    expect(err).toBe(raw);
    expect((err as LauncherBridgeError).code).toBeUndefined();
  });

  it('宿主结构化错误里带 code 的，永远不会被改写成「未支持」', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'LAUNCHER_TASK_BUSY',
      message: '该实例已有内容变更正在进行中，请等它结束',
      retryable: true,
    });
    const err = (await L.contentUninstall('inst-1', 'a.pack', []).catch((e: unknown) => e)) as LauncherBridgeError;
    expect(err.code).toBe('LAUNCHER_TASK_BUSY');
    expect(err.message).not.toContain('请升级桌面壳');
  });
});

describe('启动器桥 P1 · 命令名与 Rust 注册表同源', () => {
  const bridgeSrc = readFileSync(new URL('../src/bridge/launcher-bridge.ts', import.meta.url), 'utf8');
  const rustSrc = readFileSync(
    new URL('../src-tauri/src/launcher/commands.rs', import.meta.url),
    'utf8',
  );

  /** 桥里**真打出去**的命令名（只认引号里的字面量；注释里的花括号写法不算） */
  const bridgeCommands = new Set([...bridgeSrc.matchAll(/['"](launcher_[a-z0-9_]+)['"]/g)].map((m) => m[1]!));

  /** Rust 的 `COMMAND_NAMES` 数组（注册表的唯一清单，`lib.rs` 的注册表由它钉） */
  const block = rustSrc.match(/COMMAND_NAMES: \[&str; (\d+)\] = \[([\s\S]*?)\n\];/);
  const declared = Number(block?.[1] ?? -1);
  const rustCommands = new Set([...(block?.[2] ?? '').matchAll(/"(launcher_[a-z0-9_]+)"/g)].map((m) => m[1]!));

  it('Rust 注册表读到 38 条（读不到就红，避免下面变成空匹配假绿）', () => {
    expect(declared).toBe(38);
    expect(rustCommands.size).toBe(38);
  });

  it('桥的命令名集合 == Rust 命令名集合（38 = 20 P0 + 18 P1，不多不少）', () => {
    expect([...bridgeCommands].sort()).toEqual([...rustCommands].sort());
    expect(bridgeCommands.size).toBe(38);
  });

  it('L7B 两条插件项目命令真注册真调用；runtime_* 仍未接', () => {
    for (const name of ['launcher_project_hash', 'launcher_project_extract']) {
      expect(rustCommands.has(name), name).toBe(true);
      expect(bridgeCommands.has(name), name).toBe(true);
      expect(bridgeSrc).toContain(name);
    }
    expect([...rustCommands].some((name) => name.startsWith('launcher_runtime_'))).toBe(false);
    expect([...bridgeCommands].some((name) => name.startsWith('launcher_runtime_'))).toBe(false);
    // 未接这件事在文件头写明（不是悄悄不接）
    expect(bridgeSrc).toContain('launcher_runtime_');
    expect(bridgeSrc).toContain('未接');
  });
});
