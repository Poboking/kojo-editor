/**
 * 插件生命周期：卸载 / 启停 / 排序 / 诊断 / 信任 / 源码项目。
 *
 * 卸载、启停、排序、宿主诊断**整条委托内容包管线**，所以断言落在「内容管线被叫到哪一步、
 * 交给它的清单是什么」上；本层只补插件独有的三件：函数冲突复检、加载顺序语义、诊断码表。
 */

import { describe, expect, it } from 'vitest';
import {
  PLUGIN_ARCHIVE,
  makeFunction,
  makePluginHarness,
  makePluginManifest,
  pluginFile,
} from './helpers/plugin-harness';
import { makeContentManifest, makeHostConflict, makeInstalledContent } from './helpers/fake-host';

const installA = (files = [pluginFile('mod/a.erb')]) =>
  makePluginManifest({ id: 'demo.a', files });

describe('插件卸载 · 委托内容包管线', () => {
  it('只撤本插件独占的文件；与别的包共有的路径不进删除清单', async () => {
    const harness = makePluginHarness();
    await harness.install({
      manifest: makePluginManifest({
        id: 'demo.a',
        files: [pluginFile('mod/a.erb'), pluginFile('mod/shared.erb')],
      }),
    });
    // 另一个包也声明了 mod/shared.erb（共有 = 不删）
    harness.seedHostPack(
      makePluginManifest({ id: 'other.pack', files: [pluginFile('mod/shared.erb')] }),
      { ownedFiles: [{ rootId: 'plugins', path: 'mod/shared.erb' }] },
    );
    harness.host.writeLog.length = 0;

    const task = await harness.manager.uninstall('i1', 'demo.a');

    expect(task.state).toBe('succeeded');
    expect(harness.host.uninstallRequests).toEqual([
      { instanceId: 'i1', packId: 'demo.a', files: ['plugins/mod/a.erb'] },
    ]);
    expect(harness.host.writeLog).toEqual(['delete:plugins/mod/a.erb']);
    expect((await harness.manager.list('i1')).map((plugin) => plugin.manifest.id)).toEqual([
      'other.pack',
    ]);
  });

  it('声明过存档影响 ⇒ 卸载结果带上「旧存档可能读不出」的提示，且不动任何备份', async () => {
    const harness = makePluginHarness();
    await harness.install({
      manifest: makePluginManifest({
        id: 'demo.a',
        saveImpact: 'possible',
        files: [pluginFile('mod/a.erb')],
      }),
    }, {
      applyOptions: { acknowledgeSaveImpact: true },
    });
    const backupsBefore = harness.saves.backupsList.length;

    const task = await harness.manager.uninstall('i1', 'demo.a');

    expect(task.result).toMatchObject({
      pluginId: 'demo.a',
      saveImpact: 'possible',
      saveImpactHint:
        '该插件声明过存档影响：旧存档可能无法在无插件环境下读取（pre-plugin 备份已保留，未删除任何存档）',
    });
    expect(harness.saves.backupsList).toHaveLength(backupsBefore);
  });

  it('未安装的插件 ⇒ LAUNCHER_CONTENT_BROKEN（不猜、不静默成功）', async () => {
    const harness = makePluginHarness();
    await expect(harness.manager.uninstall('i1', 'demo.ghost')).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_BROKEN',
      message: '该插件未安装，或安装记录已损坏',
      detail: 'pluginId=demo.ghost',
    });
    expect(harness.host.uninstallRequests).toEqual([]);
  });

  it('装时的冲突决议留在插件账上（「我当时同意过什么」有据可查）', async () => {
    const harness = makePluginHarness();
    await harness.install(
      {
        manifest: makePluginManifest({
          id: 'demo.a',
          files: [pluginFile('mod/new.erb'), pluginFile('mod/base.erb')],
        }),
        conflicts: [makeHostConflict('plugins', 'mod/base.erb', { kind: 'base-file' })],
      },
      { resolutions: [{ rootId: 'plugins', path: 'mod/base.erb', action: 'overwrite' }] },
    );

    const plugin = (await harness.manager.list('i1'))[0];

    expect(plugin?.decisions).toEqual([
      {
        kind: 'file',
        action: 'overwrite',
        rootId: 'plugins',
        path: 'mod/base.erb',
        at: '2026-10-26T12:00:00.000Z',
      },
    ]);
  });
});

describe('插件启停 · 委托内容包管线 + 启用前复检冲突', () => {
  it('停用：内容管线收到 setEnabled(false)，list 跟着变', async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: installA() });

    const task = await harness.manager.setEnabled('i1', 'demo.a', false);

    expect(task.state).toBe('succeeded');
    expect(harness.calls()).toContain('contentSetEnabled:i1:demo.a:false');
    expect((await harness.manager.list('i1'))[0]?.enabled).toBe(false);
  });

  it('启用前复检：装的时候对方是停用的，启用才冲突 ⇒ LAUNCHER_PLUGIN_CONFLICT', async () => {
    const harness = makePluginHarness({
      functions: {
        'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)],
        'mod/b.erb': [makeFunction('M_TALK', 'mod/b.erb', 11)],
      },
    });
    await harness.install({ manifest: installA() });
    await harness.manager.setEnabled('i1', 'demo.a', false);
    // A 停用时装 B：此时不同时生效，安装不该被拦
    await harness.install({
      manifest: makePluginManifest({ id: 'demo.b', files: [pluginFile('mod/b.erb')] }),
    });

    await expect(harness.manager.setEnabled('i1', 'demo.a', true)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '启用后会出现函数级冲突，已拒绝启用',
      detail: 'demo.a：M_TALK（与 demo.b 重名）',
    });
    expect((await harness.manager.list('i1')).find((plugin) => plugin.manifest.id === 'demo.a')?.enabled).toBe(
      false,
    );
  });

  it('命中约定策略的同名函数不算冲突（启用照常）', async () => {
    const harness = makePluginHarness({
      functions: {
        'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)],
        'mod/b.erb': [makeFunction('M_TALK', 'mod/b.erb', 11)],
      },
      conventionPolicy: [
        { ruleId: 'erb.duplicate-function', names: ['M_TALK'], reason: '逐角色各写一份' },
      ],
    });
    await harness.install({ manifest: installA() });
    await harness.manager.setEnabled('i1', 'demo.a', false);
    await harness.install({
      manifest: makePluginManifest({ id: 'demo.b', files: [pluginFile('mod/b.erb')] }),
    });

    const task = await harness.manager.setEnabled('i1', 'demo.a', true);

    expect(task.state).toBe('succeeded');
    expect((await harness.manager.list('i1')).find((plugin) => plugin.manifest.id === 'demo.a')?.enabled).toBe(
      true,
    );
  });
});

describe('插件排序 · 按 packIds 原样落账', () => {
  const twoPlugins = async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: installA() });
    await harness.install({
      manifest: makePluginManifest({ id: 'demo.b', files: [pluginFile('mod/b.erb')] }),
    });
    return harness;
  };

  it('插件按用户次序接在非插件包之后，注册表 order = 下标', async () => {
    const harness = await twoPlugins();
    harness.seedHostPack(makeContentManifest({ id: 'base.pack' }), { order: 0 });

    await harness.manager.setOrder('i1', ['demo.b', 'demo.a']);

    // 内容管线的口径是**全量排列**：内容包在前（相对次序不变），插件按用户给的次序接上
    expect(harness.host.orderRequests.at(-1)).toEqual({
      instanceId: 'i1',
      packIds: ['base.pack', 'demo.b', 'demo.a'],
    });
    const plugins = await harness.manager.list('i1');
    expect(plugins.map((plugin) => [plugin.manifest.id, plugin.order])).toEqual([
      ['demo.a', 1],
      ['demo.b', 0],
    ]);
  });

  it('漏项 / 未安装 / 重复 ⇒ 一律拒（不「尽量排」）', async () => {
    const harness = await twoPlugins();

    await expect(harness.manager.setOrder('i1', ['demo.a'])).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '加载顺序漏掉了已安装的插件，已拒绝',
      detail: 'demo.b',
    });
    await expect(harness.manager.setOrder('i1', ['demo.a', 'demo.ghost', 'demo.b'])).rejects.toMatchObject(
      {
        code: 'LAUNCHER_PLUGIN_CONFLICT',
        message: '加载顺序里有未安装的插件，已拒绝',
        detail: 'demo.ghost',
      },
    );
    await expect(harness.manager.setOrder('i1', ['demo.a', 'demo.a'])).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '加载顺序里同一个插件出现了两次，已拒绝',
      detail: 'demo.a',
    });
    expect(harness.host.orderRequests).toEqual([]);
  });

  it('orderSource 不是 manifest ⇒ 不接管排序（游戏自己按目录/文件名扫描）', async () => {
    const harness = makePluginHarness({ rules: { orderSource: 'filename' } });
    await harness.install({ manifest: installA() });

    await expect(harness.manager.setOrder('i1', ['demo.a'])).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '该游戏的插件顺序由游戏自己按目录 / 文件名扫描决定，启动器不接管',
      detail: 'orderSource=filename',
    });
  });
});

describe('插件诊断 · 码表逐条', () => {
  it('宿主读数 + 依赖 + 顺序：缺文件 / 篡改 / 冲突 / 依赖缺失 / 顺序异常各一条', async () => {
    const harness = makePluginHarness();
    harness.seedHostPack(
      makePluginManifest({
        id: 'demo.p',
        requires: [{ id: 'dep.plugin', version: '1.0.0' }],
      }),
      { order: 0, ownedFiles: [{ rootId: 'plugins', path: 'mod/a.erb' }] },
    );
    harness.seedHostPack(makePluginManifest({ id: 'demo.q' }), { order: 0 });
    harness.host.diagnoses.set('i1', {
      instanceId: 'i1',
      issues: [
        { packId: 'demo.p', code: 'missing-file', path: 'mod/a.erb', message: '文件缺失：mod/a.erb' },
        { packId: 'demo.p', code: 'hash-mismatch', path: 'mod/a.erb', message: '文件被改动：mod/a.erb' },
        { packId: 'demo.p', code: 'conflict', path: 'mod/a.erb', message: '文件归属冲突：与 demo.q 重叠' },
        // 内容包的问题不该出现在插件诊断里
        { packId: 'content.pack', code: 'missing-file', message: '内容包的问题' },
      ],
    });

    const report = await harness.manager.diagnose('i1');

    expect(report.instanceId).toBe('i1');
    expect(report.checkedAt).toBe('2026-10-26T12:00:00.000Z');
    expect(report.issues.map((issue) => `${issue.pluginId}:${issue.code}:${issue.path ?? '-'}`)).toEqual([
      'demo.p:conflict:mod/a.erb',
      'demo.p:hash-mismatch:mod/a.erb',
      'demo.p:load-order:-',
      'demo.p:missing-dependency:-',
      'demo.p:missing-file:mod/a.erb',
      'demo.q:load-order:-',
    ]);
    expect(report.issues.find((issue) => issue.code === 'missing-dependency')?.message).toBe(
      '依赖缺失：需要 dep.plugin 1.0.0',
    );
    expect(report.issues.find((issue) => issue.code === 'load-order')?.message).toContain(
      '并列在 0，加载次序不确定',
    );
    expect(report.untrusted).toEqual(['demo.p', 'demo.q']);
    expect(report.warnings[0]).toBe('共检出 6 项插件问题');
    expect(report.warnings).toContain('demo.p：风险无法归类且未获确认，下次安装 / 升级会被拒绝');
  });

  it('函数覆盖：启用集里同名的第二处起报，且带上双方位置', async () => {
    const base: ReturnType<typeof makeFunction>[] = [];
    const harness = makePluginHarness({
      baseIndex: base,
      functions: { 'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)] },
    });
    await harness.install({ manifest: installA() });
    // 基础游戏索引在插件装上之后才建立（装上时它还是空的 —— 这就是「装的时候不冲突」的情形）
    base.push(makeFunction('M_TALK', 'script/base.erb', 7));

    const report = await harness.manager.diagnose('i1');

    const issue = report.issues.find((entry) => entry.code === 'function-override');
    expect(issue).toEqual({
      pluginId: 'demo.a',
      code: 'function-override',
      path: 'plugins/mod/a.erb',
      functionName: 'M_TALK',
      message: '函数覆盖：「M_TALK」同时定义于 script/base.erb 第 7 行与本插件 plugins/mod/a.erb 第 3 行',
    });
  });

  it('不兼容在诊断里也报（不再静默：装时被强装的插件每次诊断都会提醒）', async () => {
    const harness = makePluginHarness({
      rules: { isCompatible: (ctx) => ctx.pluginGameVersion === null },
    });
    await harness.install({ manifest: makePluginManifest({ id: 'demo.a', gameVersion: '9.9', files: [pluginFile('mod/a.erb')] }) }, {
      applyOptions: { allowIncompatible: true },
    });

    const report = await harness.manager.diagnose('i1');

    expect(report.issues).toContainEqual({
      pluginId: 'demo.a',
      code: 'incompatible',
      message: '兼容性不满足：适配器判定不兼容（游戏版本 未知 / 插件要求 9.9 / 接口版本 未声明）',
    });
  });

  it('干净的实例 ⇒ 零 issue、零 warning', async () => {
    const harness = makePluginHarness({ baseIndex: [] });
    await harness.install({ manifest: installA() });

    const report = await harness.manager.diagnose('i1');

    expect(report.issues).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.untrusted).toEqual([]);
  });
});

describe('插件源码项目与兼容性查询', () => {
  it('无源码 ⇒ openSource 静默返回（提示而不是报错）', async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: installA() });

    await expect(harness.manager.openSource('i1', 'demo.a')).resolves.toBeUndefined();
  });

  it('有源码但组合根没接打开通道 ⇒ 如实拒绝并点名', async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: installA() }, { applyOptions: { sourceProjectId: 'p-1' } });

    await expect(harness.manager.openSource('i1', 'demo.a')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '当前宿主未提供打开插件源码项目的通道',
      detail: '插件 demo.a 的来源项目 p-1 无法在工作区里打开',
    });
  });

  it('接上打开通道后按来源项目 id 打开，且 list 里能看到 sourceProjectId', async () => {
    const opened: string[] = [];
    const harness = makePluginHarness({
      openProject: async (projectId) => {
        opened.push(projectId);
      },
    });
    await harness.install({ manifest: installA() }, { applyOptions: { sourceProjectId: 'p-1' } });

    expect((await harness.manager.list('i1'))[0]?.sourceProjectId).toBe('p-1');
    await harness.manager.openSource('i1', 'demo.a');
    expect(opened).toEqual(['p-1']);
  });

  it('compatibility() 查询：判定来源如实写进 checkedBy', async () => {
    const harness = makePluginHarness({ rules: { isCompatible: () => true }, gameVersion: '4.9' });

    const compatibility = await harness.manager.compatibility(
      'i1',
      makePluginManifest({ gameVersion: '5.0' }),
    );

    expect(compatibility).toEqual({
      ok: true,
      gameVersion: '4.9',
      requiredGameVersion: '5.0',
      apiVersion: null,
      checkedBy: 'adapter',
      reasons: [],
    });
  });
});

describe('插件装配 · 生命周期', () => {
  it('dispose 之后计划作废、异步终态也不再登记（订阅已撤）', async () => {
    const harness = makePluginHarness();
    harness.host.holdApply = true;
    harness.registerPlan({ manifest: installA() });
    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);
    const running = await harness.manager.applyInstall(plan.planId);

    harness.manager.dispose();
    harness.tasks.adopt({ ...running, state: 'succeeded', endedAt: '2026-10-26T12:00:09.000Z' });

    expect(await harness.manager.list('i1')).toEqual([]);
    await expect(harness.manager.applyInstall(plan.planId)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划不存在或已失效，请重新预检',
    });
  });

  it('list 与宿主清单一一对应（插件表不会凭空多出一条）', async () => {
    const harness = makePluginHarness();
    await harness.install({ manifest: installA() });
    harness.seedHostPack(makeContentManifest({ id: 'content.pack' }), { order: 1 });

    const plugins = await harness.manager.list('i1');

    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(['demo.a']);
    expect(harness.host.packs.get('i1')).toEqual([
      makeInstalledContent({
        manifest: installA(),
        ownedFiles: [{ rootId: 'plugins', path: 'mod/a.erb' }],
      }),
      makeInstalledContent({
        manifest: makeContentManifest({ id: 'content.pack' }),
        order: 1,
      }),
    ]);
  });
});
