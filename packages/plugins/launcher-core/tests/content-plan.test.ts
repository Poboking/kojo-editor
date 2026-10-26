/**
 * `ContentManager.planInstall`：只读预检的裁决面。
 *
 * 这里每条用例都断言**具体字段或具体次序**：拒绝码 / 中文 message / detail 里的路径，
 * 以及「宿主的哪条命令被叫到、被叫到几次」。`expect(true)` 那种不算。
 */

import { describe, expect, it } from 'vitest';
import { ZIP_EXTRACT_LIMITS } from '@kojo/plugin-api';
import { ContentManagerImpl } from '../src/content-manager';
import { ProcessSupervisorImpl } from '../src/process-supervisor';
import { TaskCenterImpl } from '../src/task-center';
import { makeContentHarness } from './helpers/content-harness';
import {
  FakeHost,
  makeContentFile,
  makeContentManifest,
  makeContentRoot,
  makeHostConflict,
  makeHostContentPlan,
  makeInstance,
} from './helpers/fake-host';

const ARCHIVE = 'C:/tmp/pack.zip';

function twoFiles() {
  return makeContentManifest({
    files: [makeContentFile('script', 'mod/a.txt', 10), makeContentFile('data', 'data/b.csv', 20)],
  });
}

describe('内容包预检 · 正常路径', () => {
  it('把宿主计划映射成契约形状，并把默认限额档原样交给宿主（不抄数字）', async () => {
    const { manager, host } = makeContentHarness();
    const plan = makeHostContentPlan({
      manifest: twoFiles(),
      warnings: ['宿主提示：包内有大文件'],
    });
    host.planByArchive.set(ARCHIVE, plan);

    const mapped = await manager.planInstall('i1', ARCHIVE);

    expect(mapped.planId).toBe('plan-1');
    expect(mapped.additions).toEqual([
      { rootId: 'script', path: 'mod/a.txt' },
      { rootId: 'data', path: 'data/b.csv' },
    ]);
    expect(mapped.overwrites).toEqual([]);
    expect(mapped.conflicts).toEqual([]);
    expect(mapped.targets).toEqual([{ rootId: 'script', relativePath: '' }]);
    expect(mapped.warnings).toEqual(['宿主提示：包内有大文件']);
    expect(mapped.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    // 限额是**同一个对象**：缺省即 `ZIP_EXTRACT_LIMITS`（真源单例，不是抄出来的三个数）
    expect(host.planLimits).toBe(ZIP_EXTRACT_LIMITS);
    expect(host.calls).toEqual(['contentPlan:i1:C:/tmp/pack.zip']);
  });

  it('预检不碰实例：没有任何 apply / uninstall / set_enabled 调用', async () => {
    const { manager, host, tasks } = makeContentHarness();
    host.planByArchive.set(ARCHIVE, makeHostContentPlan({ manifest: twoFiles() }));

    await manager.planInstall('i1', ARCHIVE);

    expect(host.calls.some((call) => call.startsWith('contentApply'))).toBe(false);
    expect(host.calls.some((call) => call.startsWith('contentUninstall'))).toBe(false);
    expect(host.writeLog).toEqual([]);
    expect(tasks.list()).toEqual([]);
  });
});

describe('内容包预检 · 计划有效期（拒绝）', () => {
  it('过期计划整份作废：LAUNCHER_INTERNAL + 明确要求重新预检', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({ manifest: twoFiles(), expiresAt: '2026-10-26T11:59:59.000Z' }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划已过期，请重新预检',
      detail: expect.stringContaining('plan-1'),
    });
  });

  it('过期时间不可解析同样作废（不把 NaN 当「永不过期」）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({ manifest: twoFiles(), expiresAt: '不是时间' }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划缺少有效的过期时间，请重新预检',
      detail: expect.stringContaining('不是时间'),
    });
  });
});

describe('内容包预检 · 限额来自 ZIP_EXTRACT_LIMITS 契约真源', () => {
  it('逐调用换档：条目数超限即拒，detail 报「实际 > 上限」', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(ARCHIVE, makeHostContentPlan({ manifest: twoFiles() }));

    await expect(
      manager.planInstall('i1', ARCHIVE, {
        limits: { maxEntries: 1, maxDepth: 12, maxUnpackedBytes: 1_000 },
      }),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      message: '内容包的条目数超出限额，已中止',
      detail: '2 > 1',
    });
  });

  it('逐调用换档：总字节超限即拒，detail 报「实际 > 上限」', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(ARCHIVE, makeHostContentPlan({ manifest: twoFiles() }));

    await expect(
      manager.planInstall('i1', ARCHIVE, {
        limits: { maxEntries: 100, maxDepth: 12, maxUnpackedBytes: 25 },
      }),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      message: '内容包解压后的总体积超出限额，已中止',
      detail: '30 > 25',
    });
  });

  it('缺省档就是契约常量：条目数按 ZIP_EXTRACT_LIMITS.maxEntries 判（不另抄一个数）', async () => {
    const { manager, host } = makeContentHarness();
    const tooMany = Array.from({ length: ZIP_EXTRACT_LIMITS.maxEntries + 1 }, (_item, index) =>
      makeContentFile('script', `mod/f${index}.txt`, 1),
    );
    host.planByArchive.set(ARCHIVE, makeHostContentPlan({ manifest: makeContentManifest({ files: tooMany }) }));

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      detail: `${ZIP_EXTRACT_LIMITS.maxEntries + 1} > ${ZIP_EXTRACT_LIMITS.maxEntries}`,
    });
  });

  it('缺省档就是契约常量：单文件字节就超过总字节上限即拒', async () => {
    const { manager, host } = makeContentHarness();
    const big = makeContentManifest({
      files: [makeContentFile('script', 'mod/huge.bin', ZIP_EXTRACT_LIMITS.maxUnpackedBytes + 1)],
    });
    host.planByArchive.set(ARCHIVE, makeHostContentPlan({ manifest: big }));

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      detail: `${ZIP_EXTRACT_LIMITS.maxUnpackedBytes + 1} > ${ZIP_EXTRACT_LIMITS.maxUnpackedBytes}`,
    });
  });

  it('路径深度按同一档位判（逐调用换档后 detail 带层级码）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'a/b/c.txt', 1)] }),
      }),
    );

    await expect(
      manager.planInstall('i1', ARCHIVE, {
        limits: { maxEntries: 10, maxDepth: 2, maxUnpackedBytes: 1_000 },
      }),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      detail: 'script/a/b/c.txt（path-depth）',
    });
  });
});

describe('内容包预检 · 路径逃逸（拒绝）', () => {
  it.each([
    ['../evil.csv', 'path-dotdot'],
    ['C:/windows/evil.csv', 'path-drive'],
    ['/etc/evil.csv', 'path-absolute'],
  ])('拒绝 %s（%s）', async (path, code) => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({ manifest: makeContentManifest({ files: [makeContentFile('script', path, 1)] }) }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PATH_ESCAPE',
      message: '包内路径越出了目标根，已拒绝',
      detail: `script/${path}（${code}）`,
    });
  });

  it('反斜杠形态归「归档不合法」而不是逃逸（与解包器同一套码）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'mod\\a.txt', 1)] }),
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_INVALID',
      message: '包内路径不合法，已拒绝',
      detail: 'script/mod\\a.txt（path-backslash）',
    });
  });

  it('计划的目标目录也过同一道闸（不只看清单）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: twoFiles(),
        targets: [{ rootId: 'script', relativePath: '../outside' }],
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PATH_ESCAPE',
      detail: expect.stringContaining('../outside'),
    });
  });
});

describe('内容包预检 · 大小写碰撞', () => {
  it('包内两条仅大小写不同 ⇒ 无法安全落盘，整包拒绝（并列出两条原文）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({
          files: [makeContentFile('data', 'Data/A.csv', 1), makeContentFile('data', 'data/a.csv', 1)],
        }),
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '包内存在仅大小写不同的路径，无法安全落盘',
      detail: 'Data/A.csv / data/a.csv（大小写不敏感的文件系统上等价）',
    });
  });

  it('宿主报的大小写碰撞折成 base-file，并把既有大小写写进 warning', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('data', 'data/Readme.txt', 1)] }),
        conflicts: [
          makeHostConflict('data', 'data/Readme.txt', {
            kind: 'case-collision',
            existingPath: 'data/README.TXT',
          }),
        ],
      }),
    );

    const plan = await manager.planInstall('i1', ARCHIVE);

    expect(plan.conflicts).toEqual([
      { rootId: 'data', path: 'data/Readme.txt', kind: 'base-file', existingPackId: null, resolution: 'abort' },
    ]);
    expect(plan.warnings).toEqual([
      '大小写碰撞：data/data/Readme.txt 与既有 data/README.TXT 在大小写不敏感的文件系统上等价',
    ]);
  });

  it('大小写碰撞命中别的包 ⇒ 折成 other-pack（归属要转移，不能只覆盖）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('data', 'data/README.txt', 1)] }),
        conflicts: [
          makeHostConflict('data', 'data/README.txt', {
            kind: 'case-collision',
            existingPath: 'data/readme.txt',
            existingPackId: 'other.pack',
            resolution: 'abort',
          }),
        ],
      }),
    );

    const plan = await manager.planInstall('i1', ARCHIVE);

    expect(plan.conflicts[0]).toMatchObject({ kind: 'other-pack', existingPackId: 'other.pack' });
    expect(plan.warnings[0]).toContain('（属于 other.pack）');
  });
});

describe('内容包预检 · 冲突分类', () => {
  it('跨包归属冲突原样带出 packId 与默认 abort 决议', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'mod/shared.erb', 1)] }),
        conflicts: [
          makeHostConflict('script', 'mod/shared.erb', {
            kind: 'other-pack',
            existingPackId: 'other.pack',
          }),
        ],
      }),
    );

    const plan = await manager.planInstall('i1', ARCHIVE);

    expect(plan.conflicts).toEqual([
      { rootId: 'script', path: 'mod/shared.erb', kind: 'other-pack', existingPackId: 'other.pack', resolution: 'abort' },
    ]);
    expect(plan.additions).toEqual([]);
  });

  it('基础文件覆盖走 overwrites（已在计划里点名，不再重复算冲突）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'mod/base.erb', 1)] }),
        overwrites: [{ rootId: 'script', path: 'mod/base.erb' }],
      }),
    );

    const plan = await manager.planInstall('i1', ARCHIVE);

    expect(plan.overwrites).toEqual([{ rootId: 'script', path: 'mod/base.erb' }]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.additions).toEqual([]);
  });
});

describe('内容包预检 · 目标根授权（§9.1）', () => {
  it('未知目标根 ⇒ LAUNCHER_SOURCE_NOT_APPROVED（detail 带根 id 与路径）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({ manifest: makeContentManifest({ files: [makeContentFile('ghost', 'x.txt', 1)] }) }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      detail: 'ghost/x.txt',
    });
  });

  it('shared 实例里未声明可写的根 ⇒ 拒绝（授权按「实例 × 根」）', async () => {
    const { manager, host } = makeContentHarness({
      instance: {
        isolation: 'shared',
        contentRoots: [makeContentRoot('script', { writableInShared: false })],
      },
    });
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({ manifest: makeContentManifest({ files: [makeContentFile('script', 'x.txt', 1)] }) }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      message: '该内容根在共享实例下未声明可写，需先逐根授权',
      detail: expect.stringContaining('script'),
    });
  });

  it('copy 实例写自己根内：同一根 writableInShared=false 也放行', async () => {
    const { manager, host } = makeContentHarness({
      instance: {
        isolation: 'copy',
        contentRoots: [makeContentRoot('script', { writableInShared: false })],
      },
    });
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({ manifest: makeContentManifest({ files: [makeContentFile('script', 'x.txt', 1)] }) }),
    );

    const plan = await manager.planInstall('i1', ARCHIVE);

    expect(plan.additions).toEqual([{ rootId: 'script', path: 'x.txt' }]);
  });

  it('目标根不接受该包类型 ⇒ 拒绝并列出 accepts', async () => {
    const { manager, host } = makeContentHarness({
      instance: { contentRoots: [makeContentRoot('script', { accepts: ['script'] })] },
    });
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ kind: 'data', files: [makeContentFile('script', 'x.txt', 1)] }),
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '目标内容根不接受该类型的包，已拒绝',
      detail: 'script 接受 [script]，包类型为 data',
    });
  });

  it('计划里的目标根不在实例内容根内 ⇒ 拒绝（不只看文件清单）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: twoFiles(),
        targets: [{ rootId: 'ghost', relativePath: '' }],
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      detail: expect.stringContaining('ghost'),
    });
  });
});

describe('内容包预检 · 清单与计划的一致性', () => {
  it('包声明的游戏与实例不一致 ⇒ 拒绝', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ gameId: 'other-game', files: [makeContentFile('script', 'x.txt', 1)] }),
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_INVALID',
      message: '内容包声明的游戏与实例不一致，已拒绝',
      detail: '包 other-game / 实例 demo',
    });
  });

  it('kind=plugin 的包不走内容包通道', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ kind: 'plugin', files: [makeContentFile('script', 'x.txt', 1)] }),
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '该包是游戏插件，需走插件安装通道',
    });
  });

  it('清单里同一路径声明两次 ⇒ 拒绝', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({
          files: [makeContentFile('script', 'x.txt', 1), makeContentFile('script', 'x.txt', 2)],
        }),
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_INVALID',
      message: '清单里同一路径声明了两次，已拒绝',
      detail: 'script/x.txt',
    });
  });

  it('计划漏了清单里的文件 ⇒ 计划失效（少装比报错更危险）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: twoFiles(),
        additions: [{ rootId: 'script', path: 'mod/a.txt' }],
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '安装计划与清单不一致，已拒绝',
      detail: '清单里这些文件没有出现在计划中：data/data/b.csv',
    });
  });

  it('计划要写清单之外的文件 ⇒ 拒绝（清单是唯一授权面）', async () => {
    const { manager, host } = makeContentHarness();
    host.planByArchive.set(
      ARCHIVE,
      makeHostContentPlan({
        manifest: makeContentManifest({ files: [makeContentFile('script', 'a.txt', 1)] }),
        additions: [
          { rootId: 'script', path: 'a.txt' },
          { rootId: 'script', path: 'evil.txt' },
        ],
      }),
    );

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '安装计划要写入清单之外的文件，已拒绝',
      detail: 'script/evil.txt',
    });
  });
});

describe('内容包预检 · 宿主边界', () => {
  it('宿主错误的码原样透传（不改写、不吞）', async () => {
    const { manager, host } = makeContentHarness();
    host.planError = { code: 'LAUNCHER_SOURCE_NOT_APPROVED', message: '该目录尚未被批准写入' };

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      message: '该目录尚未被批准写入',
      detail: '内容包预检失败',
    });
  });

  it('实例不存在 ⇒ LAUNCHER_INSTANCE_NOT_FOUND（不先问宿主）', async () => {
    const { manager, host } = makeContentHarness();

    await expect(manager.planInstall('missing', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_INSTANCE_NOT_FOUND',
    });
    expect(host.calls).toEqual([]);
  });

  it('宿主没有 launcher_content_plan ⇒ 如实点名缺哪条命令', async () => {
    const bare = new FakeHost();
    bare.instances = [makeInstance({ id: 'i1' })];
    const manager = new ContentManagerImpl({
      host: bare,
      tasks: new TaskCenterImpl({ throttleMs: 0 }),
      processes: new ProcessSupervisorImpl({ host: bare }),
      getInstance: async (instanceId) =>
        bare.instances.find((item) => item.id === instanceId) ?? null,
    });

    await expect(manager.planInstall('i1', ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '当前宿主未提供内容包能力',
      detail: '宿主缺少 launcher_content_plan（P1 命令尚未接通）',
    });
  });
});
