/**
 * `PluginManager.applyInstall`：计划有效期、每实例单飞、门禁重验、存档备份、冲突决议、取消。
 *
 * 落盘与回滚是宿主的活（core 不碰盘），所以「文件没写 / 写了哪些」这类断言落在假宿主的
 * 调用次序上；本层断言的是**它该负责的四件事**：锁、门禁顺序、任务终态、插件状态的登记时机。
 */

import { describe, expect, it } from 'vitest';
import type { PluginCapability } from '@kojo/plugin-api';
import {
  PLUGIN_ARCHIVE,
  makeFunction,
  makePluginHarness,
  makePluginManifest,
  pluginFile,
} from './helpers/plugin-harness';
import { makeHostConflict, makeTask } from './helpers/fake-host';

const A_PLUS_B = [pluginFile('mod/a.erb'), pluginFile('mod/b.erb')];

describe('插件安装 · 成功路径', () => {
  it('停游戏 → 落盘 → 登记；任务结果带上插件 id / 风险 / 重启要求', async () => {
    const harness = makePluginHarness();
    harness.setRunning(true);
    harness.registerPlan({
      manifest: makePluginManifest({ files: A_PLUS_B, author: 'someone' }),
    });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    const task = await harness.manager.applyInstall(plan.planId);

    expect(task.state).toBe('succeeded');
    expect(task.result).toEqual({
      packId: 'demo.plugin',
      files: 2,
      pluginId: 'demo.plugin',
      risk: 'content-only',
      requiresRestart: false,
      decisions: [],
    });
    // 先停再写（§10.1：装插件前必须停游戏）
    expect(harness.calls()).toEqual([
      'contentPlan:i1:C:/tmp/plugin.zip',
      'contentList:i1',
      'stop',
      'contentApply:plan-1',
    ]);
    expect(harness.host.writeLog).toEqual([
      'write:plugins/mod/a.erb',
      'write:plugins/mod/b.erb',
    ]);

    const plugins = await harness.manager.list('i1');
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      enabled: true,
      order: 0,
      risk: 'content-only',
      status: 'ok',
      requiresRestart: false,
      sourceProjectId: null,
      installedAt: '2026-10-26T00:00:00.000Z',
      ownedFiles: [
        { rootId: 'plugins', path: 'mod/a.erb' },
        { rootId: 'plugins', path: 'mod/b.erb' },
      ],
      trust: { state: 'unverified', publisher: 'someone', signedAt: null },
    });
  });

  it('计划一次性消费：同一条 planId 第二次 apply 直接失效', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    await harness.manager.applyInstall(plan.planId);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划不存在或已失效，请重新预检',
      detail: 'planId=plan-1',
    });
  });

  it('升级保留 enabled 与 order（只换清单内容）', async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    await harness.manager.setEnabled('i1', 'demo.plugin', false);
    const before = await harness.manager.list('i1');

    harness.registerPlan({
      manifest: makePluginManifest({ version: '2.0.0', files: [pluginFile('mod/a.erb')] }),
      planId: 'plan-2',
      additions: [{ rootId: 'plugins', path: 'mod/a.erb' }],
    });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    expect(plan.mode).toBe('upgrade');
    const task = await harness.manager.applyInstall(plan.planId);

    expect(task.state).toBe('succeeded');
    const after = await harness.manager.list('i1');
    expect(after[0]?.manifest.version).toBe('2.0.0');
    expect(after[0]?.enabled).toBe(false);
    expect(after[0]?.order).toBe(before[0]?.order);
    expect(after[0]?.installedAt).toBe(before[0]?.installedAt);
  });
});

describe('插件安装 · 计划有效期与未知计划', () => {
  it('预检后放久了（计划过期）⇒ apply 在落盘前就拒', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ files: A_PLUS_B }),
      expiresAt: '2026-10-26T12:00:01.000Z',
    });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    harness.advance(5_000);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划已过期，请重新预检',
      detail: 'planId=plan-1 过期于 2026-10-26T12:00:01.000Z',
    });
    expect(harness.host.writeLog).toEqual([]);
  });

  it('未知 planId ⇒ 失效错误，不猜实例也不落盘', async () => {
    const harness = makePluginHarness();
    await expect(harness.manager.applyInstall('plan-ghost')).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      detail: 'planId=plan-ghost',
    });
    expect(harness.calls()).toEqual([]);
  });
});

describe('插件安装 · 每实例单飞', () => {
  it('并发第二次 apply 被明确拒绝（不排队），任务终态到达后锁才放开', async () => {
    const harness = makePluginHarness();
    harness.host.holdApply = true;
    harness.registerPlan({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    const first = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    const running = await harness.manager.applyInstall(first.planId);
    expect(running.state).toBe('running');

    harness.registerPlan({
      manifest: makePluginManifest({ id: 'demo.plugin2', files: [pluginFile('mod/c.erb')] }),
      archivePath: 'C:/tmp/plugin2.zip',
      planId: 'plan-2',
    });
    const second = await harness.manager.planInstall('i1', 'C:/tmp/plugin2.zip');

    await expect(harness.manager.applyInstall(second.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_TASK_BUSY',
      message: '该实例已有插件变更正在进行中，请等它结束',
      detail: expect.stringContaining('plan-1'),
    });
    expect(harness.calls().filter((call) => call.startsWith('contentApply'))).toEqual([
      'contentApply:plan-1',
    ]);

    // 宿主的终态事件到达：注册发生在**成功之后**，且此时锁已放开
    harness.tasks.adopt(
      makeTask(running.id, {
        state: 'succeeded',
        startedAt: '2026-10-26T12:00:01.000Z',
        endedAt: '2026-10-26T12:00:02.000Z',
        result: { packId: 'demo.plugin', files: 2 },
      }),
    );
    // 宿主把包写进了自己的清单（holdApply 时它只返回了 running，这里补上落账后的读数）
    harness.seedHostPack(makePluginManifest({ files: A_PLUS_B }), {
      ownedFiles: [{ rootId: 'plugins', path: 'mod/a.erb' }],
    });
    // 风险来自本层的登记（宿主清单里没有这一栏：没登记过的会显示 unknown）
    expect((await harness.manager.list('i1'))[0]?.risk).toBe('content-only');
    harness.host.holdApply = false;
    await expect(harness.manager.applyInstall(second.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });
});

describe('插件安装 · 取消', () => {
  it('取消 ⇒ 让宿主回滚、任务落 cancelled、插件状态不登记、计划作废', async () => {
    const harness = makePluginHarness();
    harness.host.holdApply = true;
    harness.registerPlan({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    const running = await harness.manager.applyInstall(plan.planId);

    await harness.tasks.cancel(running.id);

    expect(harness.host.cancelRequests).toEqual([running.id]);
    expect(harness.tasks.get(running.id)?.state).toBe('cancelled');
    expect(harness.tasks.get(running.id)?.endedAt).toBe('2026-10-26T12:00:00.000Z');
    // 插件状态一个字节都没落（登记只挂在 succeeded 上）
    expect(await harness.manager.list('i1')).toEqual([]);
    expect(harness.host.ownershipWrites).toEqual([]);
    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划不存在或已失效，请重新预检',
    });
  });
});

describe('插件安装 · 版本兼容门禁', () => {
  it('不兼容 ⇒ LAUNCHER_PLUGIN_INCOMPATIBLE；显式 allowIncompatible 才装，且标 incompatible', async () => {
    const harness = makePluginHarness({ rules: { isCompatible: () => false } });
    harness.registerPlan({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_INCOMPATIBLE',
      message: '插件与当前游戏版本或插件接口版本不兼容，已拒绝安装',
      detail: expect.stringContaining('适配器判定不兼容'),
    });
    expect(harness.host.writeLog).toEqual([]);

    const task = await harness.manager.applyInstall(plan.planId, undefined, {
      allowIncompatible: true,
    });
    expect(task.state).toBe('succeeded');
    expect((await harness.manager.list('i1'))[0]?.status).toBe('incompatible');
  });
});

describe('插件安装 · 信任门禁（风险无法归类）', () => {
  const unknownRisk = () =>
    makePluginManifest({
      capabilities: ['replace-functions' as PluginCapability],
      files: A_PLUS_B,
    });

  it('未受信的 unknown 风险 ⇒ LAUNCHER_PLUGIN_UNTRUSTED（不落盘）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: unknownRisk() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_UNTRUSTED',
      message: '该插件风险无法归类，尚未获得你的确认，已拒绝安装',
      detail: 'demo.plugin 1.0.0（risk=unknown）',
    });
    expect(harness.host.writeLog).toEqual([]);
  });

  it('批准某个版本只覆盖该版本：换个版本仍要重新确认', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: unknownRisk() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    const trust = await harness.manager.trust('i1', 'demo.plugin', '0.9.0');
    expect(trust).toMatchObject({ state: 'unverified', approvedBy: 'native-dialog' });
    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_UNTRUSTED',
    });

    await harness.manager.trust('i1', 'demo.plugin', '1.0.0');
    const task = await harness.manager.applyInstall(plan.planId);
    expect(task.state).toBe('succeeded');
    expect(task.result?.risk).toBe('unknown');
  });

  it('trust 记录在 list 里可见（approvedBy 恒为 native-dialog），untrust 之后又变回未批', async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    expect((await harness.manager.list('i1'))[0]?.trust).toEqual({
      state: 'unverified',
      publisher: null,
      signedAt: null,
    });

    await harness.manager.trust('i1', 'demo.plugin');
    expect((await harness.manager.list('i1'))[0]?.trust).toEqual({
      state: 'unverified',
      publisher: null,
      signedAt: null,
      approvedBy: 'native-dialog',
      approvedAt: '2026-10-26T12:00:00.000Z',
    });

    await harness.manager.untrust('i1', 'demo.plugin');
    expect((await harness.manager.list('i1'))[0]?.trust.approvedBy).toBeUndefined();
  });
});

describe('插件安装 · 存档影响门禁', () => {
  const risky = () => makePluginManifest({ saveImpact: 'possible', files: A_PLUS_B });

  it('未确认存档影响 ⇒ LAUNCHER_PLUGIN_SAVE_RISK（零落盘、零备份）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: risky() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_SAVE_RISK',
      message: '该插件可能影响存档，需先确认影响并完成备份',
      detail: 'demo.plugin 1.0.0：saveImpact=possible',
    });
    expect(harness.saves.calls).toEqual([]);
    expect(harness.host.writeLog).toEqual([]);
  });

  it('确认后先备份存档（reason=pre-plugin）再落盘，任务结果带 backupId', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: risky() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    const task = await harness.manager.applyInstall(plan.planId, undefined, {
      acknowledgeSaveImpact: true,
    });

    expect(harness.saves.calls).toEqual([
      { reason: 'pre-plugin', label: '安装插件前自动备份（demo.plugin 1.0.0）' },
    ]);
    expect(task.result?.backupId).toBe('b-1');
    expect(harness.host.writeLog).toHaveLength(2);
  });

  it('备份抛错 ⇒ 中止安装且零落盘', async () => {
    const harness = makePluginHarness();
    harness.saves.fail = true;
    harness.registerPlan({ manifest: risky() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, undefined, { acknowledgeSaveImpact: true }),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_SAVE_RISK',
      message: '安装前备份存档失败，已中止安装',
      detail: '备份失败',
    });
    expect(harness.host.writeLog).toEqual([]);
  });

  it('备份任务落 failed ⇒ 中止安装', async () => {
    const harness = makePluginHarness();
    harness.saves.taskFailed = true;
    harness.registerPlan({ manifest: risky() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, undefined, { acknowledgeSaveImpact: true }),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_SAVE_RISK',
      message: '安装前备份存档没有成功完成，已中止安装',
    });
    expect(harness.host.writeLog).toEqual([]);
  });

  it('备份没落账（backups 里查不到）⇒ 同样中止（没有回退点的改动不做）', async () => {
    const harness = makePluginHarness();
    harness.saves.omitFromList = true;
    harness.registerPlan({ manifest: risky() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, undefined, { acknowledgeSaveImpact: true }),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_SAVE_RISK',
      message: '安装前备份没有落账，已中止安装（没有回退点的改动不做）',
      detail: 'backupId=b-1',
    });
    expect(harness.host.writeLog).toEqual([]);
  });
});

describe('插件安装 · 依赖门禁', () => {
  it('依赖没满足 ⇒ LAUNCHER_PLUGIN_DEPENDENCY（预检里已经列出来）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({
        requires: [{ id: 'other.plugin', version: '1.0.0' }],
        files: A_PLUS_B,
      }),
    });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    expect(plan.missingRequirements).toEqual(['other.plugin 1.0.0']);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_DEPENDENCY',
      message: '插件声明的依赖未满足，已拒绝安装',
      detail: 'other.plugin 1.0.0',
    });
    expect(harness.host.writeLog).toEqual([]);
  });
});

describe('插件安装 · 冲突决议逐条落账', () => {
  const conflicted = () =>
    makePluginManifest({ files: [pluginFile('mod/new.erb'), pluginFile('mod/shared.erb')] });
  const fileConflict = () =>
    makeHostConflict('plugins', 'mod/shared.erb', { kind: 'other-pack', existingPackId: 'other.pack' });

  it('一条决议都没给 ⇒ 整包中止，宿主零 apply', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: conflicted(), conflicts: [fileConflict()] });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '还有文件冲突没有决断，已中止安装',
      detail: 'plugins/mod/shared.erb（other-pack）',
    });
    expect(harness.host.writeLog).toEqual([]);
  });

  it('计划之外的决议项 ⇒ 拒（拼错路径不能静默吞掉）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: conflicted(), conflicts: [fileConflict()] });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'plugins', path: 'mod/shared.erb', action: 'replace' },
        { rootId: 'plugins', path: 'mod/typo.erb', action: 'skip' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '决议里有计划之外的冲突项，已拒绝',
      detail: 'plugins/mod/typo.erb',
    });
  });

  it('别的插件的文件用 overwrite ⇒ 拒（要 replace 才能转移归属）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: conflicted(), conflicts: [fileConflict()] });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'plugins', path: 'mod/shared.erb', action: 'overwrite' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '覆盖别的插件写过的文件需用 replace（转移归属）',
    });
  });

  it('基础文件用 replace ⇒ 拒；skip ⇒ 该文件不写也不进 ownership，决议原样落账', async () => {
    const harness = makePluginHarness();
    const manifest = makePluginManifest({
      files: [pluginFile('mod/new.erb'), pluginFile('mod/base.erb')],
    });
    harness.registerPlan({
      manifest,
      conflicts: [makeHostConflict('plugins', 'mod/base.erb', { kind: 'base-file' })],
    });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, [
        { rootId: 'plugins', path: 'mod/base.erb', action: 'replace' },
      ]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '基础游戏文件只能用 overwrite 或 skip',
    });

    const task = await harness.manager.applyInstall(plan.planId, [
      { rootId: 'plugins', path: 'mod/base.erb', action: 'skip' },
    ]);

    expect(task.state).toBe('succeeded');
    expect(harness.host.applyResolutions).toEqual([
      { rootId: 'plugins', path: 'mod/base.erb', action: 'skip' },
    ]);
    expect(harness.host.writeLog).toEqual(['write:plugins/mod/new.erb']);
    expect(harness.host.ownershipWrites[0]?.files).toEqual(['plugins/mod/new.erb']);
    expect(task.result?.decisions).toEqual([
      {
        kind: 'file',
        action: 'skip',
        rootId: 'plugins',
        path: 'mod/base.erb',
        at: '2026-10-26T12:00:00.000Z',
      },
    ]);
  });

  const functionConflictHarness = () =>
    makePluginHarness({
      baseIndex: [makeFunction('M_TALK', 'script/base.erb', 7)],
      functions: { 'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)] },
    });

  it('函数冲突 skip ⇒ 该文件整份跳过（宿主没有「只切一个函数」的写盘能力），登记里写明', async () => {
    const harness = functionConflictHarness();
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    expect(plan.functionConflicts).toHaveLength(1);

    const task = await harness.manager.applyInstall(plan.planId, [
      { functionName: 'M_TALK', action: 'skip' },
    ]);

    expect(task.state).toBe('succeeded');
    expect(harness.host.applyResolutions).toEqual([
      { rootId: 'plugins', path: 'mod/a.erb', action: 'skip' },
    ]);
    expect(harness.host.writeLog).toEqual([]);
    expect(task.result?.decisions).toEqual([
      {
        kind: 'function',
        action: 'skip',
        functionName: 'M_TALK',
        rootId: 'plugins',
        path: 'mod/a.erb',
        at: '2026-10-26T12:00:00.000Z',
      },
    ]);
  });

  it('函数冲突 replace ⇒ 文件照写，决议按函数级落账', async () => {
    const harness = functionConflictHarness();
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    const task = await harness.manager.applyInstall(plan.planId, [
      { functionName: 'm_talk', action: 'replace' },
    ]);

    expect(task.state).toBe('succeeded');
    expect(harness.host.applyResolutions).toBeUndefined();
    expect(harness.host.writeLog).toEqual(['write:plugins/mod/a.erb']);
    expect(task.result?.decisions).toEqual([
      {
        kind: 'function',
        action: 'replace',
        functionName: 'M_TALK',
        path: 'plugins/mod/a.erb',
        at: '2026-10-26T12:00:00.000Z',
      },
    ]);
  });

  it('函数冲突用 overwrite ⇒ 拒（函数级只认 skip / replace）', async () => {
    const harness = functionConflictHarness();
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(
      harness.manager.applyInstall(plan.planId, [{ functionName: 'M_TALK', action: 'overwrite' }]),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '函数冲突只能用 skip（保留既有定义）或 replace（覆盖）',
      detail: 'M_TALK',
    });
  });
});

describe('插件安装 · 落盘失败', () => {
  it('宿主中途失败 ⇒ 逆序回滚、插件状态不登记、锁释放', async () => {
    const harness = makePluginHarness();
    harness.host.failApplyAt = 1;
    harness.registerPlan({ manifest: makePluginManifest({ files: A_PLUS_B }) });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
      detail: expect.stringContaining('插件安装失败'),
    });

    expect(harness.host.writeLog).toEqual([
      'write:plugins/mod/a.erb',
      'delete:plugins/mod/a.erb',
      'rollback-done',
    ]);
    expect(await harness.manager.list('i1')).toEqual([]);
    expect(harness.host.ownershipWrites).toEqual([]);

    // 锁已释放：下一份计划能干活
    harness.host.failApplyAt = null;
    harness.registerPlan({
      manifest: makePluginManifest({ id: 'demo.plugin2', files: [pluginFile('mod/c.erb')] }),
      planId: 'plan-2',
    });
    const retry = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    await expect(harness.manager.applyInstall(retry.planId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(harness.tasks.list().some((task) => task.state === 'failed')).toBe(true);
  });
});
