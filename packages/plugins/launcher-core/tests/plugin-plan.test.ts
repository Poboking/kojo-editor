/**
 * `PluginManager.planInstall`：五道门禁（能力 / 兼容 / 函数级冲突 / 存档影响 / 风险与依赖）。
 *
 * 预检**只读**：断言全落在返回的 `PluginInstallPlan` 字段与「宿主被叫到哪一步」上；
 * 真正的拒绝（兼容、未受信、依赖、存档确认）在 `plugin-apply.test.ts` 里逐条验。
 */

import { describe, expect, it } from 'vitest';
import type { PluginCapability } from '@kojo/plugin-api';
import { makePluginManifest, makeFunction, makePluginHarness, makePluginRoot, pluginFile } from './helpers/plugin-harness';
import { makeHostConflict, makeInstalledContent } from './helpers/fake-host';
import { PLUGIN_ARCHIVE } from './helpers/plugin-harness';

describe('插件预检 · 能力支持面', () => {
  it('游戏没有对应类别的插件根 ⇒ LAUNCHER_PLATFORM_UNSUPPORTED，并点名缺哪种能力', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ capabilities: ['replace-resources'], files: [pluginFile('mod/a.png')] }),
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '该游戏不提供此插件能力所需的安装根，已拒绝',
      detail: '插件声明：replace-resources；本游戏的插件根类别：script',
    });
  });

  it('插件专用根可以承接任何能力（根内结构由 adapter 决定，本层不猜）', async () => {
    const harness = makePluginHarness({
      rules: { roots: [makePluginRoot('plugins', 'plugin')] },
    });
    harness.registerPlan({
      manifest: makePluginManifest({
        capabilities: ['replace-resources', 'modify-data'],
        files: [pluginFile('mod/a.bin')],
      }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.risk).toBe('overrides-logic');
    expect(plan.functionConflicts).toEqual([]);
    expect(plan.targets).toEqual([{ rootId: 'plugins', relativePath: '' }]);
  });
});

describe('插件预检 · 版本兼容', () => {
  it('adapter 判定不兼容 ⇒ plan.compatibility.ok=false 且 checkedBy=adapter（不在预检抛错）', async () => {
    const harness = makePluginHarness({
      rules: { isCompatible: () => false },
      gameVersion: '4.9',
    });
    harness.registerPlan({
      manifest: makePluginManifest({ gameVersion: '5.0', apiVersion: '2', files: [pluginFile('mod/a.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.compatibility).toEqual({
      ok: false,
      gameVersion: '4.9',
      requiredGameVersion: '5.0',
      apiVersion: '2',
      checkedBy: 'adapter',
      reasons: ['适配器判定不兼容（游戏版本 4.9 / 插件要求 5.0 / 接口版本 2）'],
    });
    expect(plan.warnings.some((line) => line.startsWith('兼容性不满足：'))).toBe(true);
  });

  it('没有 adapter 回调时按清单声明比版本：不一致即 ok=false（checkedBy=declared）', async () => {
    const harness = makePluginHarness({ gameVersion: '1.0.0' });
    harness.registerPlan({
      manifest: makePluginManifest({ gameVersion: '2.0.0', files: [pluginFile('mod/a.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.compatibility.ok).toBe(false);
    expect(plan.compatibility.checkedBy).toBe('declared');
    expect(plan.compatibility.reasons).toEqual(['游戏版本 1.0.0 与插件要求的 2.0.0 不一致']);
  });

  it('实例没有游戏版本时只展示不拦（reasons 说明「未校验」）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ gameVersion: '2.0.0', files: [pluginFile('mod/a.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.compatibility.ok).toBe(true);
    expect(plan.compatibility.gameVersion).toBeNull();
    expect(plan.compatibility.reasons).toEqual(['实例未记录游戏版本，插件声明的游戏版本未校验']);
  });

  it('清单什么都没声明且没有回调 ⇒ checkedBy=none（不假装判过）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.compatibility).toEqual({
      ok: true,
      gameVersion: null,
      requiredGameVersion: null,
      apiVersion: null,
      checkedBy: 'none',
      reasons: [],
    });
  });
});

describe('插件预检 · 风险分级', () => {
  it('只追加 + 只声明 add-content ⇒ content-only', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ files: [pluginFile('mod/a.erb'), pluginFile('mod/b.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.risk).toBe('content-only');
    expect(plan.requiresRestart).toBe(false);
    expect(plan.saveImpact).toBe('none');
    expect(plan.mode).toBe('install');
  });

  it('声明 modify-data（纯追加）⇒ extends-logic', async () => {
    const harness = makePluginHarness({
      rules: { roots: [makePluginRoot('plugins'), makePluginRoot('plugins-data', 'data')] },
    });
    harness.registerPlan({
      manifest: makePluginManifest({
        capabilities: ['modify-data'],
        files: [pluginFile('mod/table.csv')],
      }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.risk).toBe('extends-logic');
  });

  it('只声明 add-content 却覆盖基础文件 ⇒ 按实际升为 overrides-logic 并记 warning', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ files: [pluginFile('mod/new.erb'), pluginFile('base.erb')] }),
      conflicts: [makeHostConflict('plugins', 'base.erb', { kind: 'base-file' })],
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.risk).toBe('overrides-logic');
    expect(plan.conflicts).toEqual([
      { rootId: 'plugins', path: 'base.erb', kind: 'base-file', existingPackId: null, resolution: 'abort' },
    ]);
    expect(
      plan.warnings.some((line) => line.includes('声明与实际落点不一致') && line.includes('overrides-logic')),
    ).toBe(true);
  });

  it('能力值无法归类 ⇒ risk=unknown（按最高档提示，安装前必须确认）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({
        capabilities: ['replace-functions' as PluginCapability],
        files: [pluginFile('mod/a.erb')],
      }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.risk).toBe('unknown');
    expect(plan.warnings).toContain(
      '风险无法归类：按最高风险处理，安装前必须在系统确认框里逐项确认',
    );
  });
});

describe('插件预检 · 存档影响', () => {
  it('清单未声明 ⇒ 取 adapter 的 pluginRules.saveImpact，并给出「装前备份」的说明', async () => {
    const harness = makePluginHarness({ rules: { saveImpact: 'possible' } });
    harness.registerPlan({
      manifest: makePluginManifest({ saveImpact: undefined, files: [pluginFile('mod/a.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.saveImpact).toBe('possible');
    expect(
      plan.warnings.some((line) => line.includes('安装前会自动备份存档（reason=pre-plugin）')),
    ).toBe(true);
    expect(harness.saves.calls).toEqual([]);
  });

  it('本装配没有备份通道 ⇒ 预检直接拒（LAUNCHER_PLUGIN_SAVE_RISK），不给「先装上再说」的路', async () => {
    const harness = makePluginHarness({ saves: false });
    harness.registerPlan({
      manifest: makePluginManifest({ saveImpact: 'unknown', files: [pluginFile('mod/a.erb')] }),
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_SAVE_RISK',
      message: '该插件可能影响存档，而当前装配没有存档备份能力，已拒绝预检',
      detail: 'demo.plugin 1.0.0：saveImpact=unknown',
    });
    expect(harness.calls()).toEqual(['contentPlan:i1:C:/tmp/plugin.zip', 'contentList:i1']);
  });
});

describe('插件预检 · 依赖与顺序', () => {
  it('requires 未满足 ⇒ 进 missingRequirements（apply 再硬拒）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({
        requires: [{ id: 'other.plugin', version: '1.0.0' }],
        files: [pluginFile('mod/a.erb')],
      }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.missingRequirements).toEqual(['other.plugin 1.0.0']);
    expect(plan.warnings.some((line) => line.startsWith('依赖未满足：other.plugin 1.0.0'))).toBe(
      true,
    );
  });

  it('requires 版本对不上也算缺（精确版本，不做 semver 范围）', async () => {
    const harness = makePluginHarness();
    harness.seedHostPack(makePluginManifest({ id: 'other.plugin', version: '1.0.0' }));
    harness.registerPlan({
      manifest: makePluginManifest({
        requires: [{ id: 'other.plugin', version: '2.0.0' }],
        files: [pluginFile('mod/a.erb')],
      }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.missingRequirements).toEqual(['other.plugin 2.0.0（已装 1.0.0）']);
  });

  it('清单 conflicts 命中已装插件 ⇒ LAUNCHER_PLUGIN_DEPENDENCY（不自动卸载别人）', async () => {
    const harness = makePluginHarness();
    harness.seedHostPack(makePluginManifest({ id: 'rival.plugin' }));
    harness.registerPlan({
      manifest: makePluginManifest({ conflicts: ['rival.plugin'], files: [pluginFile('mod/a.erb')] }),
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_DEPENDENCY',
      message: '该插件声明与已安装插件冲突，已拒绝安装',
      detail: 'demo.plugin 声明与 rival.plugin 冲突（先卸载对方再试）',
    });
  });

  it('orderSource=directory 时明说「顺序由游戏扫描决定」，不假装能排序', async () => {
    const harness = makePluginHarness({ rules: { orderSource: 'directory', requiresRestart: true } });
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.requiresRestart).toBe(true);
    expect(plan.warnings).toContain(
      '该游戏的插件顺序由游戏自己按目录名扫描决定：清单里的 loadOrder 只作展示，启动器不接管排序',
    );
    expect(plan.warnings).toContain('安装 / 启停后需重启游戏才生效');
  });

  it('同 id 已装 ⇒ mode=upgrade 并提示保留启停与顺序', async () => {
    const harness = makePluginHarness();
    harness.seedHostPack(makePluginManifest({ version: '0.9.0' }));
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.mode).toBe('upgrade');
    expect(plan.warnings).toContain(
      '同 id 插件已安装 0.9.0，本次按升级处理（保留启停状态与加载顺序）',
    );
  });
});

describe('插件预检 · 函数级冲突（比对键 = normalizedName）', () => {
  const baseDefs = [makeFunction('M_TALK', 'script/base.erb', 7)];

  it('真冲突（基础游戏）⇒ existing.pluginId=null，默认 abort', async () => {
    const harness = makePluginHarness({
      baseIndex: baseDefs,
      functions: { 'mod/a.erb': [makeFunction('m_talk', 'mod/a.erb', 3)] },
    });
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.functionConflicts).toEqual([
      {
        functionName: 'm_talk',
        existing: { pluginId: null, path: 'script/base.erb', line: 7 },
        incoming: { path: 'plugins/mod/a.erb', line: 3 },
        resolution: 'abort',
      },
    ]);
    expect(plan.warnings.some((line) => line.startsWith('检出 1 处函数级冲突'))).toBe(true);
  });

  it('真冲突（已装插件）⇒ existing.pluginId 指向对方插件', async () => {
    const harness = makePluginHarness({
      functions: {
        'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)],
        'mod/b.erb': [makeFunction('m_talk', 'mod/b.erb', 11)],
      },
    });
    // 先装 demo.a（它的函数索引是装的当时算的）
    await harness.install({
      manifest: makePluginManifest({ id: 'demo.a', files: [pluginFile('mod/a.erb')] }),
    });
    harness.registerPlan({
      manifest: makePluginManifest({ id: 'demo.b', files: [pluginFile('mod/b.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.functionConflicts).toHaveLength(1);
    expect(plan.functionConflicts[0]).toMatchObject({
      functionName: 'm_talk',
      existing: { pluginId: 'demo.a', path: 'plugins/mod/a.erb', line: 3 },
      incoming: { path: 'plugins/mod/b.erb', line: 11 },
    });
  });

  it('conventionPolicy 按名字收敛 ⇒ 预期重复不计冲突，但仍留一行汇总', async () => {
    const harness = makePluginHarness({
      baseIndex: baseDefs,
      functions: { 'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)] },
      conventionPolicy: [
        { ruleId: 'erb.duplicate-function', names: ['M_TALK'], reason: '逐角色各写一份' },
      ],
    });
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.functionConflicts).toEqual([]);
    expect(plan.warnings).toContain('已按适配器约定策略收敛 1 处预期重复：逐角色各写一份');
  });

  it('conventionPolicy 按正则收敛（跨已装插件）⇒ 不计冲突', async () => {
    const harness = makePluginHarness({
      functions: {
        'mod/a.erb': [makeFunction('M_KOJO_1', 'mod/a.erb', 3)],
        'mod/b.erb': [makeFunction('m_kojo_1', 'mod/b.erb', 9)],
      },
      conventionPolicy: [
        { ruleId: 'erb.duplicate-function', namePattern: '^M_KOJO_\\d+$', reason: '逐角色口上是引擎语义' },
      ],
    });
    await harness.install({
      manifest: makePluginManifest({ id: 'demo.a', files: [pluginFile('mod/a.erb')] }),
    });
    harness.registerPlan({
      manifest: makePluginManifest({ id: 'demo.b', files: [pluginFile('mod/b.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.functionConflicts).toEqual([]);
    expect(plan.warnings).toContain('已按适配器约定策略收敛 1 处预期重复：逐角色口上是引擎语义');
  });

  it('没有 conventionPolicy 时同样两条按真冲突算（收敛不是本层自带的宽容）', async () => {
    const harness = makePluginHarness({
      functions: {
        'mod/a.erb': [makeFunction('M_KOJO_1', 'mod/a.erb', 3)],
        'mod/b.erb': [makeFunction('m_kojo_1', 'mod/b.erb', 9)],
      },
    });
    await harness.install({
      manifest: makePluginManifest({ id: 'demo.a', files: [pluginFile('mod/a.erb')] }),
    });
    harness.registerPlan({
      manifest: makePluginManifest({ id: 'demo.b', files: [pluginFile('mod/b.erb')] }),
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.functionConflicts).toHaveLength(1);
    expect(plan.functionConflicts[0]?.existing.pluginId).toBe('demo.a');
  });

  it('整体覆盖定义该函数的基础文件 ⇒ 只报文件冲突，不重复报函数冲突', async () => {
    const harness = makePluginHarness({
      baseIndex: [makeFunction('M_TALK', 'plugins/mod/base.erb', 5)],
      functions: { 'mod/base.erb': [makeFunction('M_TALK', 'mod/base.erb', 5)] },
    });
    harness.registerPlan({
      manifest: makePluginManifest({ files: [pluginFile('mod/base.erb')] }),
      conflicts: [makeHostConflict('plugins', 'mod/base.erb', { kind: 'base-file' })],
    });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.functionConflicts).toEqual([]);
  });

  it('analyzeFunctions 抛错 ⇒ 计划阶段直接失败（空数组假装「没有函数」是最危险的假绿）', async () => {
    const harness = makePluginHarness({
      analyze: async () => {
        throw new Error('parser exploded');
      },
    });
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_CONFLICT',
      message: '插件函数索引解析失败，安装已中止（解析失败不能当作「没有函数」）',
      detail: 'parser exploded',
    });
  });

  it('宿主没回传暂存视图 ⇒ 如实拒绝（不许跳过函数分析）', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }), staging: null });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '宿主未提供插件包的暂存目录，无法做函数级冲突分析',
      detail: 'planId=plan-1（launcher_content_plan 尚未回传 staging）',
    });
  });

  it('没有基础游戏索引时如实 warning（函数冲突只比对已装插件）', async () => {
    const harness = makePluginHarness({
      functions: { 'mod/a.erb': [makeFunction('M_TALK', 'mod/a.erb', 3)] },
    });
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    const plan = await harness.manager.planInstall('i1', PLUGIN_ARCHIVE);

    expect(plan.functionConflicts).toEqual([]);
    expect(plan.warnings).toContain('未提供基础游戏函数索引：函数级冲突只比对已装插件');
  });
});

describe('插件预检 · 前置拒绝（按判定顺序）', () => {
  it('kind 不是 plugin ⇒ 指回内容包通道', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ kind: 'script', files: [pluginFile('mod/a.erb')] }),
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '该包不是游戏插件，请走内容包安装通道',
      detail: 'demo.plugin 的 kind 为 script',
    });
  });

  it('gameId 与实例不一致 ⇒ LAUNCHER_ARCHIVE_INVALID', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ gameId: 'other', files: [pluginFile('mod/a.erb')] }),
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_INVALID',
      message: '插件声明的游戏与实例不一致，已拒绝',
      detail: '包 other / 实例 demo',
    });
  });

  it('插件根不在实例的内容根里 ⇒ LAUNCHER_SOURCE_NOT_APPROVED', async () => {
    const harness = makePluginHarness({ instance: { contentRoots: [] } });
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_SOURCE_NOT_APPROVED',
      message: '插件要写入的根不在该游戏的插件安装根内，已拒绝',
      detail: 'plugins/mod/a.erb',
    });
  });

  it('计划与清单不一致（少一条）⇒ LAUNCHER_CONTENT_CONFLICT', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ files: [pluginFile('mod/a.erb'), pluginFile('mod/b.erb')] }),
      additions: [{ rootId: 'plugins', path: 'mod/a.erb' }],
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_CONTENT_CONFLICT',
      message: '安装计划与清单不一致，已拒绝',
      detail: '清单里这些文件没有出现在计划中：plugins/mod/b.erb',
    });
  });

  it('过期计划在预检就被拒', async () => {
    const harness = makePluginHarness();
    harness.registerPlan({
      manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }),
      expiresAt: '2026-10-26T11:59:59.000Z',
    });

    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: '安装计划已过期，请重新预检',
      detail: 'planId=plan-1 过期于 2026-10-26T11:59:59.000Z',
    });
  });

  it('宿主没有 contentPlan 命令 ⇒ 如实拒绝，不造计划', async () => {
    const harness = makePluginHarness();
    const failing = harness.manager;
    harness.host.planError = { code: 'LAUNCHER_ARCHIVE_INVALID', message: '压缩包不合法或已损坏' };
    harness.registerPlan({ manifest: makePluginManifest({ files: [pluginFile('mod/a.erb')] }) });

    await expect(failing.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_INVALID',
      message: '压缩包不合法或已损坏',
      detail: '插件包预检失败',
    });
  });

  it('实例不存在 ⇒ LAUNCHER_INSTANCE_NOT_FOUND（不猜实例）', async () => {
    const harness = makePluginHarness();
    await expect(harness.manager.planInstall('i-missing', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_INSTANCE_NOT_FOUND',
      detail: '实例 i-missing 不存在',
    });
  });

  it('该游戏没有 pluginRules ⇒ LAUNCHER_PLATFORM_UNSUPPORTED（插件禁用，内容包仍可用）', async () => {
    const harness = makePluginHarness({ instance: { adapterId: 'unknown-adapter' } });
    await expect(harness.manager.planInstall('i1', PLUGIN_ARCHIVE)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      message: '该游戏暂不支持安装插件',
    });
  });
});

describe('插件预检 · 两表一致', () => {
  it('宿主已装清单里的插件会出现在 list 里（未装过的按最高风险展示）', async () => {
    const harness = makePluginHarness();
    harness.seedHostPack(
      makePluginManifest({ author: 'someone' }),
      { ownedFiles: [{ rootId: 'plugins', path: 'mod/a.erb' }] },
    );

    const plugins = await harness.manager.list('i1');

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      risk: 'unknown',
      enabled: true,
      order: 0,
      status: 'ok',
      sourceProjectId: null,
      ownedFiles: [{ rootId: 'plugins', path: 'mod/a.erb' }],
      trust: { state: 'unverified', publisher: 'someone', signedAt: null },
    });
    expect(harness.host.packs.get('i1')).toEqual([
      makeInstalledContent({
        manifest: makePluginManifest({ author: 'someone' }),
        ownedFiles: [{ rootId: 'plugins', path: 'mod/a.erb' }],
      }),
    ]);
  });
});
